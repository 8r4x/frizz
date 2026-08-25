import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { decodeBody, encodeBody, RELAY_MAX_FRAME_BODY, type RelayUpFrame } from "@frizz/shared";
import { serveRelayRequest } from "./relay-agent.ts";

/** A stand-in board, so the agent is driven against a REAL local server rather than a mock. */
async function board(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
  const server: Server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() { server.close(); await once(server, "close"); },
  };
}

const collect = () => {
  const frames: RelayUpFrame[] = [];
  return { frames, send: (f: RelayUpFrame) => void frames.push(f) };
};

const text = (frames: RelayUpFrame[]) =>
  frames
    .filter((f) => f.t === "res-chunk" || (f.t === "res" && f.body))
    .map((f) => new TextDecoder().decode(decodeBody((f as { body?: string; data?: string }).body ?? (f as { data: string }).data)))
    .join("");

test("a response of known length comes back in ONE frame", async () => {
  // Content-Length is what makes it unary. Without one Node sends it chunked, which has no length we
  // could know up front and so correctly takes the streaming path instead — see the next test.
  const b = await board((_, res) => {
    res.writeHead(200, { "content-type": "text/plain", "content-length": "5" });
    res.end("hello");
  });
  const out = collect();
  try {
    await serveRelayRequest(
      { t: "req", id: "1", method: "GET", url: `${b.origin}/x`, headers: [] },
      { origin: b.origin, send: out.send, publicOrigin: "https://ada.frizz.sh" },
    );
    assert.equal(out.frames.length, 1);
    const head = out.frames[0] as Extract<RelayUpFrame, { t: "res" }>;
    assert.equal(head.status, 200);
    assert.equal(head.end, true);
    assert.equal(text(out.frames), "hello");
  } finally { await b.close(); }
});

test("the board sees the PUBLIC host, not loopback — without this it refuses every relayed request", async () => {
  // Frizz's origin gate keys on the request having arrived AS the declared public origin. Forwarding
  // with a loopback Host would be judged local and skip the access gate entirely.
  let seen = "";
  const b = await board((req, res) => { seen = req.headers.host ?? ""; res.writeHead(200); res.end("ok"); });
  const out = collect();
  try {
    await serveRelayRequest(
      { t: "req", id: "1", method: "GET", url: `${b.origin}/`, headers: [["host", "127.0.0.1:1"]] },
      { origin: b.origin, send: out.send, publicOrigin: "https://ada.frizz.sh" },
    );
    assert.equal(seen, "ada.frizz.sh");
  } finally { await b.close(); }
});

test("a CHUNKED response streams, because its length is unknowable up front", async () => {
  const b = await board((_, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("hi"); });
  const out = collect();
  try {
    await serveRelayRequest(
      { t: "req", id: "1", method: "GET", url: `${b.origin}/`, headers: [] },
      { origin: b.origin, send: out.send, publicOrigin: "https://ada.frizz.sh" },
    );
    assert.equal((out.frames[0] as Extract<RelayUpFrame, { t: "res" }>).end, false);
    assert.equal(text(out.frames), "hi");
    assert.equal(out.frames[out.frames.length - 1]!.t, "res-end");
  } finally { await b.close(); }
});

test("an SSE body streams instead of being buffered until it ends — which it never does", async () => {
  const b = await board((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    setTimeout(() => res.write("data: two\n\n"), 10);
    setTimeout(() => res.end(), 30);
  });
  const out = collect();
  try {
    await serveRelayRequest(
      { t: "req", id: "1", method: "GET", url: `${b.origin}/events`, headers: [] },
      { origin: b.origin, send: out.send, publicOrigin: "https://ada.frizz.sh" },
    );
    const head = out.frames[0] as Extract<RelayUpFrame, { t: "res" }>;
    assert.equal(head.t, "res");
    assert.equal(head.end, false, "the head must not claim the response is finished");
    assert.ok(out.frames.some((f) => f.t === "res-chunk"), "no chunks were sent");
    assert.equal(out.frames[out.frames.length - 1]!.t, "res-end");
    assert.match(text(out.frames), /data: one[\s\S]*data: two/);
  } finally { await b.close(); }
});

test("a body too large for one frame is chunked, not dropped", async () => {
  const big = "x".repeat(RELAY_MAX_FRAME_BODY + 5000);
  const b = await board((_, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(big); });
  const out = collect();
  try {
    await serveRelayRequest(
      { t: "req", id: "1", method: "GET", url: `${b.origin}/big`, headers: [] },
      { origin: b.origin, send: out.send, publicOrigin: "https://ada.frizz.sh" },
    );
    const head = out.frames[0] as Extract<RelayUpFrame, { t: "res" }>;
    assert.equal(head.end, false, "an oversized body must take the streaming path");
    assert.ok(out.frames.filter((f) => f.t === "res-chunk").length >= 2);
    assert.equal(text(out.frames).length, big.length, "the body was truncated");
  } finally { await b.close(); }
});

test("a request body reaches the board", async () => {
  let got = "";
  const b = await board((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { got = Buffer.concat(chunks).toString(); res.writeHead(204); res.end(); });
  });
  const out = collect();
  try {
    await serveRelayRequest(
      {
        t: "req", id: "1", method: "POST", url: `${b.origin}/rpc`,
        headers: [["content-type", "application/json"]],
        body: encodeBody(new TextEncoder().encode('{"a":1}')),
      },
      { origin: b.origin, send: out.send, publicOrigin: "https://ada.frizz.sh" },
    );
    assert.equal(got, '{"a":1}');
  } finally { await b.close(); }
});

test("a board that is down answers 502 rather than leaving the visitor to time out", async () => {
  const out = collect();
  await serveRelayRequest(
    { t: "req", id: "1", method: "GET", url: "http://127.0.0.1:1/", headers: [] },
    { origin: "http://127.0.0.1:1", send: out.send, publicOrigin: "https://ada.frizz.sh" },
  );
  const head = out.frames[0] as Extract<RelayUpFrame, { t: "res" }>;
  assert.equal(head.status, 502);
  assert.match(text(out.frames), /Frizz is not answering on this machine/);
});

test("hop-by-hop headers are not replayed onto the local connection", async () => {
  let seen: string[] = [];
  const b = await board((req, res) => { seen = Object.keys(req.headers); res.writeHead(200); res.end(); });
  const out = collect();
  try {
    await serveRelayRequest(
      {
        t: "req", id: "1", method: "GET", url: `${b.origin}/`,
        headers: [["connection", "keep-alive"], ["transfer-encoding", "chunked"], ["x-keep", "1"]],
      },
      { origin: b.origin, send: out.send, publicOrigin: "https://ada.frizz.sh" },
    );
    assert.ok(seen.includes("x-keep"));
    assert.ok(!seen.includes("transfer-encoding"), "a hop-by-hop header was replayed");
  } finally { await b.close(); }
});
