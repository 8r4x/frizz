import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { decodeBody, encodeBody, RELAY_MAX_FRAME_BODY, type RelayUpFrame } from "@frizz/shared";
import { serveRelayRequest, serveRelayWebSocket } from "./relay-agent.ts";

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

/**
 * A stand-in terminal: a REAL WebSocket server, because the whole point of this half is that it speaks
 * to one. A fake socket here would prove the frame bookkeeping and nothing about the upgrade itself.
 */
async function terminal(onMessage?: (socket: import("ws").WebSocket, data: string) => void, accept = true) {
  const { WebSocketServer } = await import("ws");
  const server: Server = createServer((_, res) => { res.writeHead(426); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const seen: string[] = [];
  server.on("upgrade", (req, socket, head) => {
    if (!accept) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => {
        const data = String(raw);
        seen.push(data);
        onMessage?.(ws, data);
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    async close() { wss.close(); server.close(); await once(server, "close"); },
  };
}

/** Wait for a frame the predicate accepts, so a test never races the socket's own timing. */
async function until(frames: RelayUpFrame[], match: (f: RelayUpFrame) => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = frames.find(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("a terminal opens locally and is acknowledged, so the visitor's pane goes live", async () => {
  const t = await terminal();
  const out = collect();
  const session = serveRelayWebSocket(
    { t: "ws-open", id: "w1", url: "https://ada.frizz.sh/terminal?id=abc", headers: [["x-keep", "1"]] },
    { origin: t.origin, publicOrigin: "https://ada.frizz.sh", send: out.send },
  );
  try {
    const ack = (await until(out.frames, (f) => f.t === "ws-ack", "the ack")) as Extract<RelayUpFrame, { t: "ws-ack" }>;
    assert.equal(ack.ok, true);
    assert.equal(ack.id, "w1");
  } finally { session.close(); await t.close(); }
});

test("what the visitor types reaches the local terminal, and its output comes back", async () => {
  // The round trip IS the feature. A terminal that only carries one direction is not a terminal.
  const t = await terminal((ws, data) => ws.send(`echo:${data}`));
  const out = collect();
  const session = serveRelayWebSocket(
    { t: "ws-open", id: "w1", url: "https://ada.frizz.sh/terminal", headers: [] },
    { origin: t.origin, publicOrigin: "https://ada.frizz.sh", send: out.send },
  );
  try {
    await until(out.frames, (f) => f.t === "ws-ack", "the ack");
    session.message("ls -la");
    const back = (await until(out.frames, (f) => f.t === "ws-msg", "the reply")) as Extract<RelayUpFrame, { t: "ws-msg" }>;
    assert.equal(back.data, "echo:ls -la");
    assert.deepEqual(t.seen, ["ls -la"]);
  } finally { session.close(); await t.close(); }
});

test("a URL for the public host is dialled on LOOPBACK — the visitor's hostname is not a route to anywhere", async () => {
  // The frame carries the visitor's own URL. Connecting to it verbatim would leave the board trying to
  // reach frizz.sh, which either fails or, far worse, loops back through the relay.
  const t = await terminal();
  const out = collect();
  const dialled: string[] = [];
  const session = serveRelayWebSocket(
    { t: "ws-open", id: "w1", url: "https://ada.frizz.sh/terminal?id=abc", headers: [] },
    {
      origin: t.origin,
      publicOrigin: "https://ada.frizz.sh",
      send: out.send,
      connect: (url) => { dialled.push(url); return new WebSocket(url) as never; },
    },
  );
  try {
    await until(out.frames, (f) => f.t === "ws-ack", "the ack");
    const url = new URL(dialled[0]!);
    assert.equal(url.protocol, "ws:");
    assert.equal(url.host, new URL(t.origin).host);
    assert.equal(url.pathname, "/terminal");
    assert.equal(url.search, "?id=abc");
  } finally { session.close(); await t.close(); }
});

test("a terminal the board CANNOT open is refused, not left silently open", async () => {
  // ok:false is what lets the relay answer the upgrade with an error. Acknowledging and then dying
  // leaves a pane that looks live until someone types into it — far harder to diagnose.
  const t = await terminal(undefined, false);
  const out = collect();
  const session = serveRelayWebSocket(
    { t: "ws-open", id: "w1", url: "https://ada.frizz.sh/terminal", headers: [] },
    { origin: t.origin, publicOrigin: "https://ada.frizz.sh", send: out.send },
  );
  try {
    const ack = (await until(out.frames, (f) => f.t === "ws-ack", "the refusal")) as Extract<RelayUpFrame, { t: "ws-ack" }>;
    assert.equal(ack.ok, false);
  } finally { session.close(); await t.close(); }
});

test("a local terminal that ends tells the relay, so the visitor's pane closes with it", async () => {
  const t = await terminal((ws) => ws.close());
  const out = collect();
  const session = serveRelayWebSocket(
    { t: "ws-open", id: "w1", url: "https://ada.frizz.sh/terminal", headers: [] },
    { origin: t.origin, publicOrigin: "https://ada.frizz.sh", send: out.send },
  );
  try {
    await until(out.frames, (f) => f.t === "ws-ack", "the ack");
    session.message("exit");
    const close = await until(out.frames, (f) => f.t === "ws-close", "the close");
    assert.equal(close.id, "w1");
  } finally { session.close(); await t.close(); }
});
