#!/usr/bin/env nub
/**
 * A REAL terminal — real `terminal.ts`, real pty — driven over the relay.
 *
 * The other two relay harnesses put a TOY WebSocket server where the board should be. It accepts any
 * upgrade and echoes six bytes, which proves the transport and nothing about the conversation the
 * board actually holds. Three things are therefore believed rather than observed: that `terminal.ts`'s
 * own loopback-only gate accepts what the supervisor rewrites, that a real `/term/<slug>` URL survives
 * the hop, and that a pty's output comes back at all.
 *
 * A fourth is the reason this exists. The HTTP path chunks a body at 512 KiB because a Cloudflare
 * WebSocket message caps at 1 MiB; the TERMINAL path does neither, in either direction. A toy that
 * echoes what it is sent can never produce a burst large enough to find that. A real pty can.
 *
 * `/term` serves exactly one thing: a provider sign-in attempt, whose pty the login utility owns. So
 * the login source is injected — the sanctioned seam — and a real pty is put behind it. Everything
 * else in the path is the real thing, and no real credential is touched.
 */
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { spawn as spawnPty } from "node-pty";
// Not on the package's exports map, and adding one for a harness would be a change nobody asked for.
import { createTerminalServer } from "../packages/server/src/terminal.ts";
import { RestartSupervisorProxy } from "@frizz/server/restart-supervisor";
import { serveRelayWebSocket } from "../src/relay-agent.ts";

const PUBLIC_ORIGIN = "https://ada.frizz.sh";
const SLUG = "demo-thread";
const PORT = Number(process.env.RELAY_TERMINAL_PORT ?? 47612);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** A REAL pty, dressed as the login attachment `/term` is the transport for. */
function realPtyLogin() {
  const pty = spawnPty("/bin/sh", ["-i"], { name: "xterm-color", cols: 80, rows: 24, env: { ...process.env, PS1: "$ " } });
  let replay = "";
  const listeners = new Set();
  const exits = new Set();
  pty.onData((chunk) => {
    replay += chunk;
    for (const l of listeners) l(chunk);
  });
  pty.onExit(() => { for (const l of exits) l(); });
  return {
    pty,
    attachment: {
      replay: () => replay,
      onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      onExit(listener) { exits.add(listener); return () => exits.delete(listener); },
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      close: () => { /* the utility owns the lifecycle; the harness kills it in finally */ },
    },
  };
}

/** Open a relayed terminal and collect what comes back up the frames. */
function open(headers, boardOrigin) {
  const output = [];
  let onChunk = null;
  let settle;
  const opened = new Promise((resolve) => { settle = resolve; });
  const session = serveRelayWebSocket(
    { t: "ws-open", id: "w1", url: `${PUBLIC_ORIGIN}/_frizz/term/${SLUG}`, headers },
    {
      origin: boardOrigin,
      publicOrigin: PUBLIC_ORIGIN,
      send: (frame) => {
        if (frame.t === "ws-ack") settle(frame.ok);
        if (frame.t === "ws-msg") { output.push(frame.data); onChunk?.(frame.data); }
        if (frame.t === "ws-close") settle(false);
      },
    },
  );
  const timer = setTimeout(() => settle(null), 15_000);
  return {
    session,
    output,
    opened: opened.then((v) => { clearTimeout(timer); return v; }),
    /** Wait until the frames seen so far satisfy the predicate. */
    async waitFor(predicate, label, ms = 20_000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (predicate(output)) return true;
        await new Promise((r) => { onChunk = () => { onChunk = null; r(); }; setTimeout(() => { onChunk = null; r(); }, 100); });
      }
      console.log(`       (timed out waiting for ${label})`);
      return false;
    },
  };
}

let login = null;
let terminals = null;
let child = null;
let proxy = null;
try {
  login = realPtyLogin();
  // THE REAL TERMINAL SERVER. Only the login source is injected; its gate, slug parsing, framing,
  // rate limits and output buffering are all the shipped code.
  terminals = createTerminalServer({ resolveLogin: (slug) => (slug === SLUG ? login.attachment : null) });
  child = createServer((_, res) => { res.writeHead(200); res.end("board"); });
  child.on("upgrade", (req, socket, head) => {
    if (!terminals.handleUpgrade(req, socket, head)) socket.destroy();
  });
  child.listen(0, "127.0.0.1");
  await once(child, "listening");
  const childPort = child.address().port;

  proxy = new RestartSupervisorProxy({
    port: PORT,
    publicOrigin: PUBLIC_ORIGIN,
    childPort: () => childPort,
    restart: async () => ({ state: "ready" }),
  });
  await proxy.listen();
  const boardOrigin = `http://127.0.0.1:${PORT}`;
  check("a real terminal server sits behind the real supervisor", true, `${PUBLIC_ORIGIN} → 127.0.0.1:${childPort}`);

  // A visitor with no redeemed access code must not reach a pty.
  const uninvited = open([["host", "ada.frizz.sh"], ["origin", PUBLIC_ORIGIN]], boardOrigin);
  check("an unauthenticated visitor gets no terminal", (await uninvited.opened) === false);
  uninvited.session.close();

  // Redeem a code the way a browser does. Raw node:http — `fetch` drops a Host header.
  const code = proxy.issueAccessCode();
  const redeem = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: PORT, path: `/?frizz_code=${encodeURIComponent(code.code)}`, headers: { host: "ada.frizz.sh", origin: PUBLIC_ORIGIN }, setHost: false },
      (res) => { res.resume(); resolve(res.headers["set-cookie"] ?? []); },
    );
    req.on("error", reject);
    req.end();
  });
  const cookie = redeem.map((c) => c.split(";")[0]).join("; ");
  const visitor = [["host", "ada.frizz.sh"], ["origin", PUBLIC_ORIGIN], ["cookie", cookie]];

  // THE REAL THING: a real /term/<slug> URL, through the real gate, onto a real pty.
  const term = open(visitor, boardOrigin);
  check("a redeemed visitor opens a REAL terminal over the relay", (await term.opened) === true);

  // The board's own protocol, not an echo: resize first, then a command.
  //
  // THE MARKER IS ASSEMBLED BY THE SHELL, and it has to be. A pty echoes every keystroke back, so a
  // literal marker in the command matches its own echo and the check passes without the command ever
  // running. Splitting it across two variables means the typed line never contains the marker and only
  // the OUTPUT can.
  term.session.message(JSON.stringify({ t: "resize", cols: 100, rows: 30 }));
  term.session.message(JSON.stringify({ t: "input", d: "A=RELAY; B=PTY-OK; echo \"$A-$B\"\n" }));
  const sawOutput = await term.waitFor((o) => o.join("").includes("RELAY-PTY-OK"), "the command's output");
  check("a command typed through the relay runs and its output comes back", sawOutput, JSON.stringify(term.output.join("").slice(-40)));

  // THE BURST. A Cloudflare WebSocket message caps at 1 MiB and ws-msg is neither chunked nor checked,
  // so this is the one failure a toy board can never produce. 4 MiB of output, well past the cap.
  // Measured in BYTES DELIVERED, not by a marker. A marker only says the shell reached the end of the
  // line; it says nothing about how much of the output survived, which is the entire question here.
  const BURST = 4 * 1024 * 1024;
  const before = term.output.length;
  term.session.message(JSON.stringify({ t: "input", d: `C=BURST; D=DONE; head -c ${BURST} /dev/zero | tr '\\0' 'x'; echo "$C-$D"\n` }));
  const delivered = () => term.output.slice(before).reduce((n, f) => n + Buffer.byteLength(f, "utf8"), 0);
  const sawBurst = await term.waitFor(
    (o) => o.join("").includes("BURST-DONE") && delivered() >= BURST,
    "the burst to arrive in full",
    120_000,
  );
  const frames = term.output.slice(before);
  const largest = frames.reduce((max, f) => Math.max(max, Buffer.byteLength(f, "utf8")), 0);
  check("a 4 MiB pty burst arrives in full", sawBurst, `${delivered()} of ${BURST} bytes in ${frames.length} frames`);
  check(
    "and no single frame exceeds Cloudflare's 1 MiB WebSocket message cap",
    largest > 0 && largest < 1_048_576,
    `largest frame ${largest} bytes across ${frames.length}`,
  );
  term.session.close();
} catch (error) {
  check("harness completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  try { login?.pty.kill(); } catch { /* already gone */ }
  await terminals?.close().catch(() => undefined);
  await proxy?.close().catch(() => undefined);
  child?.closeAllConnections?.();
  child?.close();
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
