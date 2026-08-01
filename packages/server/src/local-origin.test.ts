import assert from "node:assert/strict"
import type { IncomingMessage } from "node:http"
import test from "node:test"
import {
  allowedLocalCorsOrigin,
  bindHostIsExposed,
  isTrustedLocalHttpRequest,
  isTrustedLocalWebSocketRequest,
  normalizeAllowedHosts,
  normalizeBindHost,
  parseLocalHost,
  parseLocalHttpOrigin,
} from "./local-origin.ts"

const PORT = 49_177

function upgradeRequest(host: string | undefined, origin: string | undefined, extra: Record<string, string> = {}) {
  return {
    headers: { ...(host ? { host } : {}), ...(origin ? { origin } : {}), ...extra },
    socket: { localPort: PORT },
  } as unknown as IncomingMessage
}

test("local origin parser accepts only canonical loopback URL serializations on the expected port", () => {
  for (const [origin, hostname] of [
    [`http://127.0.0.1:${PORT}`, "127.0.0.1"],
    [`http://localhost:${PORT}`, "localhost"],
    [`http://[::1]:${PORT}`, "::1"],
  ] as const) {
    assert.equal(parseLocalHttpOrigin(origin, PORT)?.hostname, hostname)
    assert.equal(allowedLocalCorsOrigin(origin, PORT), origin)
  }

  for (const origin of [
    undefined,
    "null",
    `https://localhost:${PORT}`,
    `http://localhost.evil:${PORT}`,
    `http://127.0.0.1.evil:${PORT}`,
    `http://127.0.0.1:${PORT + 1}`,
    `http://127.1:${PORT}`,
    `http://2130706433:${PORT}`,
    `http://0177.0.0.1:${PORT}`,
    `HTTP://LOCALHOST:${PORT}`,
    `http://localhost:${PORT}/`,
    `http://user@localhost:${PORT}`,
    `http://localhost.:${PORT}`,
    `http://localhоst:${PORT}`,
    `http://%6cocalhost:${PORT}`,
    `http://[0:0:0:0:0:0:0:1]:${PORT}`,
    `http://[::ffff:127.0.0.1]:${PORT}`,
    `http://localhost:0${PORT}`,
    `http://localhost:${PORT}, http://evil.example`,
  ]) {
    assert.equal(parseLocalHttpOrigin(origin, PORT), null, String(origin))
  }
})

test("local Host parser rejects DNS suffixes, port aliases, userinfo, and canonicalization tricks", () => {
  for (const [host, hostname] of [
    [`127.0.0.1:${PORT}`, "127.0.0.1"],
    [`localhost:${PORT}`, "localhost"],
    [`[::1]:${PORT}`, "::1"],
  ] as const) {
    assert.equal(parseLocalHost(host, PORT)?.hostname, hostname)
  }
  for (const host of [
    `localhost.evil:${PORT}`,
    `127.0.0.1.evil:${PORT}`,
    `127.0.0.1:${PORT + 1}`,
    `127.1:${PORT}`,
    `2130706433:${PORT}`,
    `0177.0.0.1:${PORT}`,
    `user@localhost:${PORT}`,
    `localhost:${PORT}/path`,
    `localhost.:${PORT}`,
    `localhоst:${PORT}`,
    `%6cocalhost:${PORT}`,
    `[0:0:0:0:0:0:0:1]:${PORT}`,
    `[::ffff:127.0.0.1]:${PORT}`,
    `localhost:0${PORT}`,
    `localhost:${PORT}, evil.example`,
  ]) {
    assert.equal(parseLocalHost(host, PORT), null, host)
  }
})

test("HTTP requires the present Origin to match Host and narrowly opts missing Origin into compatibility", () => {
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}` }, PORT), false)
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}` }, PORT, true), true)
  for (const [host, origin] of [
    [`127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}`],
    [`localhost:${PORT}`, `http://localhost:${PORT}`],
    [`LOCALHOST:${PORT}`, `http://localhost:${PORT}`],
    [`[::1]:${PORT}`, `http://[::1]:${PORT}`],
  ]) {
    assert.equal(isTrustedLocalHttpRequest({ host, origin }, PORT), true, `${host} / ${origin}`)
  }
  for (const [host, origin] of [
    [`127.0.0.1:${PORT}`, `http://localhost:${PORT}`],
    [`127.0.0.1:${PORT}`, `http://[::1]:${PORT}`],
    [`localhost:${PORT}`, `http://127.0.0.1:${PORT}`],
    [`localhost:${PORT}`, `http://[::1]:${PORT}`],
    [`[::1]:${PORT}`, `http://127.0.0.1:${PORT}`],
    [`[::1]:${PORT}`, `http://localhost:${PORT}`],
  ]) {
    assert.equal(isTrustedLocalHttpRequest({ host, origin }, PORT), false, `${host} / ${origin}`)
  }
  assert.equal(isTrustedLocalHttpRequest({ host: `localhost.evil:${PORT}` }, PORT, true), false)
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}`, origin: "http://evil.example" }, PORT), false)
  assert.equal(isTrustedLocalHttpRequest({ host: [`127.0.0.1:${PORT}`], origin: `http://127.0.0.1:${PORT}` }, PORT), false)
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}`, origin: [`http://127.0.0.1:${PORT}`] }, PORT), false)
  for (const name of [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
  ] as const) {
    assert.equal(isTrustedLocalHttpRequest({
      host: `127.0.0.1:${PORT}`,
      origin: `http://127.0.0.1:${PORT}`,
      [name]: name === "forwarded" ? "" : "attacker-controlled",
    }, PORT), false, name)
  }
})

test("WebSocket policy requires a present exact same-origin Host across IPv4, localhost, and IPv6", () => {
  for (const [host, origin] of [
    [`127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}`],
    [`localhost:${PORT}`, `http://localhost:${PORT}`],
    [`[::1]:${PORT}`, `http://[::1]:${PORT}`],
  ]) {
    assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(host, origin)), true, origin)
  }
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(`127.0.0.1:${PORT}`, undefined)), false)
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(`127.0.0.1:${PORT}`, `http://localhost:${PORT}`)), false)
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(`localhost.evil:${PORT}`, `http://localhost.evil:${PORT}`)), false)
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(
    `127.0.0.1:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    { "x-forwarded-proto": "https" },
  )), false)
})

// ── --host: what an EXPOSED bind may accept as its browser authority ────────────────────────────────

const EXPOSED = { exposed: true, allowedHosts: [] as string[] }

test("an exposed policy admits IP literals and nothing else by default", () => {
  // The default posture is untouched: without the policy these are all still foreign authorities.
  for (const hostname of ["192.168.1.5", "10.0.0.4", "[2001:db8::5]"]) {
    assert.equal(parseLocalHost(`${hostname}:${PORT}`, PORT), null, hostname)
    assert.equal(parseLocalHost(`${hostname}:${PORT}`, PORT, EXPOSED)?.port, PORT, hostname)
  }
  assert.equal(parseLocalHttpOrigin(`http://192.168.1.5:${PORT}`, PORT), null)
  assert.equal(parseLocalHttpOrigin(`http://192.168.1.5:${PORT}`, PORT, EXPOSED)?.hostname, "192.168.1.5")
  // Loopback keeps working while exposed — the local browser tab is still the common case.
  assert.equal(parseLocalHost(`localhost:${PORT}`, PORT, EXPOSED)?.hostname, "localhost")
  // A DNS NAME is the whole DNS-rebinding vector, so it stays rejected until named explicitly.
  assert.equal(parseLocalHost(`fray.local:${PORT}`, PORT, EXPOSED), null)
  assert.equal(parseLocalHost(`fray.local:${PORT}`, PORT, { exposed: true, allowedHosts: ["fray.local"] })?.hostname, "fray.local")
  assert.equal(parseLocalHost(`FRAY.local:${PORT}`, PORT, { exposed: true, allowedHosts: ["fray.local"] })?.hostname, "fray.local")
  assert.equal(parseLocalHost(`other.local:${PORT}`, PORT, { exposed: true, allowedHosts: ["fray.local"] }), null)
  assert.equal(parseLocalHost(`other.local:${PORT}`, PORT, { exposed: true, allowedHosts: ["*"] })?.hostname, "other.local")
  // An allow-list without exposure changes nothing: the port is still unreachable from off-machine.
  assert.equal(parseLocalHost(`fray.local:${PORT}`, PORT, { exposed: false, allowedHosts: ["fray.local"] }), null)
  // Every canonicalization trick the loopback parser rejects is still rejected while exposed.
  for (const host of [`192.168.1.5:${PORT + 1}`, `user@192.168.1.5:${PORT}`, `192.168.1.5:${PORT}/x`, `3232235781:${PORT}`]) {
    assert.equal(parseLocalHost(host, PORT, EXPOSED), null, host)
  }
})

test("an exposed request still needs Origin to match Host, and forwarded authority is never trusted", () => {
  const host = `192.168.1.5:${PORT}`
  assert.equal(isTrustedLocalHttpRequest({ host, origin: `http://192.168.1.5:${PORT}` }, PORT, false, EXPOSED), true)
  // The cross-site CSRF case the whole gate exists for, now from a LAN browser.
  assert.equal(isTrustedLocalHttpRequest({ host, origin: "http://evil.example" }, PORT, false, EXPOSED), false)
  // Same machine, different authority: still not interchangeable.
  assert.equal(isTrustedLocalHttpRequest({ host, origin: `http://127.0.0.1:${PORT}` }, PORT, false, EXPOSED), false)
  assert.equal(isTrustedLocalHttpRequest({ host, origin: `http://192.168.1.5:${PORT}`, "x-forwarded-host": "x" }, PORT, false, EXPOSED), false)
  assert.equal(allowedLocalCorsOrigin(`http://192.168.1.5:${PORT}`, PORT, EXPOSED), `http://192.168.1.5:${PORT}`)
  assert.equal(allowedLocalCorsOrigin(`http://192.168.1.5:${PORT}`, PORT), undefined)
  assert.equal(
    isTrustedLocalWebSocketRequest(upgradeRequest(host, `http://192.168.1.5:${PORT}`), PORT, EXPOSED),
    true,
  )
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(host, undefined), PORT, EXPOSED), false)
})

test("bind hosts: loopback spellings are private, wildcards are not, and names are refused", () => {
  for (const host of ["127.0.0.1", "::1", "localhost", "[::1]"]) assert.equal(bindHostIsExposed(host), false, host)
  for (const host of ["0.0.0.0", "::", "192.168.1.5"]) assert.equal(bindHostIsExposed(host), true, host)
  assert.equal(normalizeBindHost("localhost"), "127.0.0.1")
  assert.equal(normalizeBindHost(" [::1] "), "::1")
  assert.equal(normalizeBindHost("0.0.0.0"), "0.0.0.0")
  assert.throws(() => normalizeBindHost(""), /requires an address/)
  assert.throws(() => normalizeBindHost("example.com"), /invalid --host address/)
  assert.throws(() => normalizeBindHost("0.0.0.0:5173"), /invalid --host address/)
  assert.deepEqual(normalizeAllowedHosts([" A ", "b,, B ", ""]), ["a", "b"])
})
