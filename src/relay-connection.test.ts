import assert from "node:assert/strict";
import test from "node:test";
import { generateClaimIdentity, parseFrame, serializeFrame } from "@frizz/shared";
import { connectRelay, defaultBackoff, signRelayHandshake, type RelaySocket } from "./relay-connection.ts";

/** A socket a test drives by hand: it records what was sent and fires events on demand. */
function fakeSocket() {
  const listeners: Record<string, Array<(e?: unknown) => void>> = {};
  const sent: string[] = [];
  let closed = false;
  const socket: RelaySocket = {
    send: (d) => void sent.push(d),
    close: () => { closed = true; },
    addEventListener: (type: string, listener: (e?: unknown) => void) => {
      (listeners[type] ??= []).push(listener);
    },
  } as RelaySocket;
  return {
    socket, sent,
    get closed() { return closed; },
    fire(type: string, event?: unknown) { for (const l of listeners[type] ?? []) l(event); },
  };
}

function harness(overrides: Partial<Parameters<typeof connectRelay>[0]> = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const urls: string[] = [];
  const timers: Array<() => void> = [];
  const status: string[] = [];
  return {
    sockets, urls, timers, status,
    async start(identity: CryptoKeyPair) {
      const conn = connectRelay({
        name: "ada",
        identity,
        relayOrigin: "https://frizz.sh",
        boardOrigin: "http://127.0.0.1:1",
        publicOrigin: "https://ada.frizz.sh",
        socketFactory: (url) => { urls.push(url); const s = fakeSocket(); sockets.push(s); return s.socket; },
        onStatus: (s, d) => void status.push(d ? `${s}:${d}` : s),
        setTimer: (fn) => { timers.push(fn); return timers.length; },
        clearTimer: () => {},
        backoff: () => 1,
        ...overrides,
      });
      // connectRelay signs asynchronously before the socket exists.
      for (let i = 0; i < 50 && sockets.length === 0; i++) await new Promise((r) => setImmediate(r));
      return conn;
    },
  };
}

test("the board dials out carrying a signed handshake in the URL", async () => {
  // In the URL rather than a first message, so the relay can judge it BEFORE upgrading — an unproven
  // socket then never occupies the name's Durable Object.
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  try {
    assert.equal(h.urls.length, 1);
    const url = new URL(h.urls[0]!);
    assert.equal(url.protocol, "wss:");
    assert.equal(url.pathname, "/_relay/connect");
    const raw = url.searchParams.get("h")!;
    const decoded = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) as { name: string; sig: string };
    assert.equal(decoded.name, "ada");
    assert.ok(decoded.sig.length > 0);
  } finally { conn.stop(); }
});

test("a ping is answered, so a dead board is noticed rather than assumed live", async () => {
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  try {
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("message", { data: serializeFrame({ t: "ping", id: "p1" }) });
    const reply = parseFrame(h.sockets[0]!.sent[0]!);
    assert.deepEqual(reply, { t: "pong", id: "p1" });
  } finally { conn.stop(); }
});

test("a dropped connection comes back by itself", async () => {
  // A laptop sleeps, changes network and loses Wi-Fi constantly. A relay connection that did not
  // return on its own would mean a board permanently unreachable after the first suspend.
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  try {
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("close");
    assert.ok(h.status.some((s) => s.startsWith("disconnected")));
    assert.ok(h.status.some((s) => s.startsWith("retrying")));
    assert.equal(h.timers.length, 1, "no retry was scheduled");

    h.timers[0]!();
    for (let i = 0; i < 50 && h.sockets.length < 2; i++) await new Promise((r) => setImmediate(r));
    assert.equal(h.sockets.length, 2, "it did not dial again");
  } finally { conn.stop(); }
});

test("stop() ends it for good — no reconnect after a deliberate shutdown", async () => {
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  conn.stop();
  h.sockets[0]!.fire("close");
  assert.equal(h.timers.length, 0, "a stopped connection scheduled a retry");
  assert.equal(h.sockets[0]!.closed, true);
});

test("a socket that was already replaced cannot tear down the live one", async () => {
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  try {
    h.sockets[0]!.fire("close");
    h.timers[0]!();
    for (let i = 0; i < 50 && h.sockets.length < 2; i++) await new Promise((r) => setImmediate(r));
    const retriesBefore = h.timers.length;
    h.sockets[0]!.fire("close"); // the stale socket, closing late
    assert.equal(h.timers.length, retriesBefore, "a stale close scheduled another retry");
  } finally { conn.stop(); }
});

test("backoff climbs, stops climbing, and is jittered", () => {
  // Jitter matters more than the curve: a relay restart disconnects every board in the same instant,
  // and without it they would all come back in the same instant too.
  assert.ok(defaultBackoff(0, () => 0) < defaultBackoff(3, () => 0));
  assert.equal(defaultBackoff(6, () => 0), defaultBackoff(20, () => 0), "it must stop climbing");
  assert.ok(defaultBackoff(20, () => 0) <= 30_000);
  assert.notEqual(defaultBackoff(4, () => 0), defaultBackoff(4, () => 0.99), "no jitter applied");
});

test("the handshake is signed over name, key and time together", async () => {
  const identity = await generateClaimIdentity();
  const a = await signRelayHandshake("ada", identity, 1000);
  const b = await signRelayHandshake("ada", identity, 1001);
  const c = await signRelayHandshake("eve", identity, 1000);
  assert.notEqual(a.sig, b.sig, "the timestamp is not covered");
  assert.notEqual(a.sig, c.sig, "the name is not covered");
});
