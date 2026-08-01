import assert from "node:assert/strict"
import { createServer, request, type IncomingHttpHeaders, type RequestListener } from "node:http"
import { connect as netConnect } from "node:net"
import { once } from "node:events"
import { test } from "node:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  RestartSupervisorProxy,
  SUPERVISOR_RESTART_PATH,
  SUPERVISOR_UPDATE_RESTART_PATH,
  SUPERVISOR_STATUS_PATH,
  type RestartResult,
} from "./restart-supervisor.ts"

async function listen(handler: RequestListener) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    server,
    port: address.port,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, "close")
    },
  }
}

async function get(port: number, path: string, method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: { origin: `http://127.0.0.1:${port}` },
    }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => { body += chunk })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.once("error", reject)
    req.end()
  })
}

async function getBytes(port: number, path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers, method }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => { chunks.push(chunk) })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.once("error", reject)
    req.end()
  })
}

async function child(label: string) {
  return listen((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`${label}:${req.url}`)
  })
}

test("public restart supervisor preserves routes, does not restart initial/subresource requests, and recovers a dead child", async () => {
  let current = await child("one")
  let restarts = 0
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: async (): Promise<RestartResult> => {
      restarts++
      await current.close().catch(() => undefined)
      current = await child(`generation-${restarts + 1}`)
      return { state: "ready" }
    },
  })
  try {
    await proxy.listen()
    assert.equal((await get(port, "/thread/demo?tab=terminal")).body, "one:/thread/demo?tab=terminal")
    assert.equal((await get(port, "/assets/app.css")).body, "one:/assets/app.css")
    assert.equal(restarts, 0, "ordinary initial and subresource requests never restart Fray")

    assert.equal((await get(port, SUPERVISOR_RESTART_PATH, "POST")).status, 202)
    assert.equal((await get(port, "/thread/demo?tab=terminal")).body, "generation-2:/thread/demo?tab=terminal")

    // Simulate a crash that leaves the durable proxy still bound. Restart remains available without
    // talking to the dead child first.
    await current.close()
    assert.equal((await get(port, SUPERVISOR_RESTART_PATH, "POST")).status, 202)
    assert.equal((await get(port, "/thread/demo?tab=terminal")).body, "generation-3:/thread/demo?tab=terminal")
    assert.equal(restarts, 2)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("public supervisor serves local images without entering or requiring the disposable child", async () => {
  const image = Buffer.from("89504e470d0a1a0a", "hex")
  const imageDir = mkdtempSync(join(tmpdir(), "fray-supervisor-image-"))
  const imagePath = join(imageDir, "handoff.png")
  writeFileSync(imagePath, image)

  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => undefined,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    const path = `/local-image?path=${encodeURIComponent(imagePath)}`
    const served = await getBytes(port, path, { "sec-fetch-site": "same-origin" })
    assert.equal(served.status, 200)
    assert.equal(served.headers["content-type"], "image/png")
    assert.equal(served.headers["cache-control"], "private, max-age=60")
    assert.deepEqual(served.body, image)

    const head = await getBytes(port, path, { "sec-fetch-site": "same-origin" }, "HEAD")
    assert.equal(head.status, 200)
    assert.equal(head.headers["content-length"], String(image.length))
    assert.equal(head.body.length, 0)

    const cors = await getBytes(port, path, { origin: `http://127.0.0.1:${port}` })
    assert.equal(cors.status, 200)
    assert.equal(cors.headers["access-control-allow-origin"], `http://127.0.0.1:${port}`)

    assert.equal((await getBytes(port, path)).status, 403, "missing browser authority stays forbidden")
    assert.equal((await getBytes(port, path, { origin: "http://attacker.invalid" })).status, 403)
    assert.equal((await get(port, "/ordinary-route")).status, 503, "only local images bypass an unavailable child")
  } finally {
    await proxy.close().catch(() => undefined)
  }
})

test("repeat restart clicks coalesce and status is served by the public owner", async () => {
  const current = await child("one")
  let calls = 0
  let release!: (result: RestartResult) => void
  const waiting = new Promise<RestartResult>((resolve) => { release = resolve })
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: () => { calls++; return waiting },
  })
  try {
    await proxy.listen()
    const first = get(port, SUPERVISOR_RESTART_PATH, "POST")
    const second = get(port, SUPERVISOR_RESTART_PATH, "POST")
    await eventually(() => calls === 1 ? calls : undefined, "the one coalesced restart action")
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /restarting/)
    release({ state: "ready" })
    assert.deepEqual((await Promise.all([first, second])).map((response) => response.status), [202, 202])
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("public supervisor fails closed on a forbidden restart or occupied public port", async () => {
  const current = await child("one")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({ port, childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await proxy.listen()
    const denied = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: SUPERVISOR_RESTART_PATH, method: "POST" }, (res) => resolve(res.statusCode ?? 0))
      req.once("error", reject)
      req.end()
    })
    assert.equal(denied, 403)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }

  const blocker = await listen((_req, res) => res.end())
  const occupied = new RestartSupervisorProxy({ port: blocker.port, childPort: () => undefined, restart: async () => ({ state: "ready" }) })
  await assert.rejects(occupied.listen())
  await blocker.close()
})

test("update-and-restart is explicit and never falls through to an ordinary restart", async () => {
  const current = await child("one")
  const port = await freePort()
  let ordinary = 0
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: async () => { ordinary++; return { state: "ready" } },
  })
  try {
    await proxy.listen()
    const response = await get(port, SUPERVISOR_UPDATE_RESTART_PATH, "POST")
    assert.equal(response.status, 409)
    assert.match(response.body, /immutable Fray artifact/)
    assert.equal(ordinary, 0)
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /"updateRestart":false/)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("status advertises Update & Restart only when the durable supervisor owns that capability", async () => {
  const current = await child("one")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
    updateRestart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /"updateRestart":true/)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("update acknowledgement and status stay truthful while the old child remains ready", async () => {
  const current = await child("old-but-still-serving")
  const port = await freePort()
  let release!: (result: RestartResult) => void
  const building = new Promise<RestartResult>((resolve) => { release = resolve })
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    // This recreates the real failure mode: the disposable child can serve requests while the
    // durable owner builds its successor artifact.
    status: () => ({ state: "ready", artifactDigest: "old-artifact" }),
    restart: async () => ({ state: "ready" }),
    updateRestart: () => building,
  })
  try {
    await proxy.listen()
    const update = await get(port, SUPERVISOR_UPDATE_RESTART_PATH, "POST")
    assert.equal(update.status, 202)
    assert.match(update.body, /"state":"restarting"/)
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /"state":"restarting"/)
    assert.equal((await get(port, "/still-live")).body, "old-but-still-serving:/still-live")
    release({ state: "ready" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /"state":"ready"/)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

/** Reach the proxy with an arbitrary Host/Origin pair, the way a foreign browser would. */
async function proxied(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => { body += chunk })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.once("error", reject)
    req.end()
  })
}

test("the proxy refuses a foreign Origin instead of laundering it into the child's same-origin", async () => {
  // proxyHeaders REWRITES Host and Origin to the child's private loopback authority, so the child's
  // own gate sees a perfect same-origin request no matter who sent it. Without this check, any page
  // in any browser on this machine could drive the whole control plane.
  const current = await child("only")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({ port, childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await proxy.listen()
    const host = `127.0.0.1:${port}`
    assert.equal((await proxied(port, "/rpc/x", { host, origin: `http://127.0.0.1:${port}` }, "POST")).status, 200)
    // A same-origin GET may legitimately omit Origin; the child still applies its own per-route rule.
    assert.equal((await proxied(port, "/assets/app.css", { host })).status, 200)
    for (const origin of ["http://evil.example", `http://localhost.evil:${port}`, `http://127.0.0.1:${port + 1}`]) {
      assert.equal((await proxied(port, "/rpc/x", { host, origin }, "POST")).status, 403, origin)
    }
    // A Host naming somebody else is refused too, which is what stops DNS rebinding.
    assert.equal((await proxied(port, "/rpc/x", { host: `fray.evil:${port}` }, "POST")).status, 403)
    assert.equal((await proxied(port, "/rpc/x", { host, "x-forwarded-host": "evil.example" }, "POST")).status, 403)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("--host: a non-loopback bind accepts IP-literal authorities, and loopback still does not", async () => {
  const current = await child("only")
  const port = await freePort()
  // Bound to the wildcard so the test can still reach it over 127.0.0.1 while the POLICY is exposed.
  const proxy = new RestartSupervisorProxy({
    port,
    host: "0.0.0.0",
    allowedHosts: ["fray.local"],
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    for (const authority of [`192.168.1.5:${port}`, `10.0.0.4:${port}`, `fray.local:${port}`, `127.0.0.1:${port}`]) {
      const status = (await proxied(port, "/rpc/x", { host: authority, origin: `http://${authority}` }, "POST")).status
      assert.equal(status, 200, authority)
    }
    // Exposure widens WHICH authority is legitimate, never the Origin-must-match-Host rule itself.
    assert.equal((await proxied(port, "/rpc/x", { host: `192.168.1.5:${port}`, origin: "http://evil.example" }, "POST")).status, 403)
    assert.equal((await proxied(port, "/rpc/x", { host: `evil.example:${port}` }, "POST")).status, 403)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("an exposed board supplies the Sec-Fetch stamp a LAN browser cannot send", async () => {
  // Chrome sends Sec-Fetch-* only to a potentially-trustworthy origin, which http://192.168.1.5 is
  // not. Fray's missing-Origin rules ask for `sec-fetch-site: same-origin`, so without the proxy
  // vouching, --host served the shell and then 403'd every /rpc read the app made. Measured in
  // Chrome 151: the LAN request carried neither an origin nor a sec-fetch-site header.
  const seen: Array<Record<string, string | string[] | undefined>> = []
  const current = await listen((req, res) => {
    seen.push(req.headers)
    res.writeHead(200)
    res.end("ok")
  })
  const port = await freePort()
  const exposed = new RestartSupervisorProxy({ port, host: "0.0.0.0", childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await exposed.listen()
    assert.equal((await proxied(port, "/rpc/board", { host: `192.168.1.5:${port}` })).status, 200)
    assert.equal(seen.at(-1)?.["sec-fetch-site"], "same-origin", "a LAN read is vouched for")

    // Loopback is untouched even on an exposed board: the browser really can stamp that one, so the
    // real signal is forwarded and its absence stays meaningful.
    await proxied(port, "/rpc/board", { host: `127.0.0.1:${port}` })
    assert.equal(seen.at(-1)?.["sec-fetch-site"], undefined, "loopback keeps the browser's own signal")

    // A stamp the caller supplied is never overwritten, in either direction.
    await proxied(port, "/rpc/board", { host: `192.168.1.5:${port}`, "sec-fetch-site": "cross-site" })
    assert.equal(seen.at(-1)?.["sec-fetch-site"], "cross-site", "a declared cross-site request stays cross-site")

    // Vouching is for the Origin-LESS case only; a present Origin still has to match, and did.
    await proxied(port, "/rpc/board", { host: `192.168.1.5:${port}`, origin: `http://192.168.1.5:${port}` })
    assert.equal(seen.at(-1)?.["sec-fetch-site"], undefined)
  } finally {
    await exposed.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("a loopback-bound proxy never vouches, so its missing-Origin posture is exactly as before", async () => {
  const seen: Array<Record<string, string | string[] | undefined>> = []
  const current = await listen((req, res) => {
    seen.push(req.headers)
    res.writeHead(200)
    res.end("ok")
  })
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({ port, childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await proxy.listen()
    await proxied(port, "/rpc/board", { host: `127.0.0.1:${port}` })
    assert.equal(seen.at(-1)?.["sec-fetch-site"], undefined, "the default posture invents no signal")
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("a loopback-bound proxy rejects the LAN authority an exposed one would accept", async () => {
  const current = await child("only")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({ port, childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await proxy.listen()
    assert.equal((await proxied(port, "/rpc/x", { host: `192.168.1.5:${port}` }, "POST")).status, 403)
    assert.equal((await proxied(port, "/rpc/x", { host: `fray.local:${port}` }, "POST")).status, 403)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

/** Send a raw WebSocket handshake and report whether the proxy forwarded it or hung up. */
async function upgrade(port: number, headers: Record<string, string>): Promise<"forwarded" | "refused"> {
  const socket = netConnect(port, "127.0.0.1")
  await once(socket, "connect")
  const lines = [
    "GET /ws HTTP/1.1",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "upgrade: websocket",
    "connection: Upgrade",
    "sec-websocket-version: 13",
    "sec-websocket-key: AQIDBAUGBwgJCgsMDQ4PEC==",
  ]
  socket.write(`${lines.join("\r\n")}\r\n\r\n`)
  try {
    let received = ""
    socket.setEncoding("utf8")
    const done = new Promise<"forwarded" | "refused">((resolve) => {
      socket.on("data", (chunk: string) => {
        received += chunk
        if (received.includes("\r\n\r\n")) resolve("forwarded")
      })
      socket.on("close", () => resolve(received.includes("\r\n\r\n") ? "forwarded" : "refused"))
      socket.on("error", () => resolve("refused"))
      // A gate that neither answers nor hangs up is its own failure. Bound it so a regression here
      // reports as a failed assertion instead of wedging the whole suite.
      setTimeout(() => resolve("refused"), 2_000).unref()
    })
    return await done
  } finally {
    socket.destroy()
  }
}

test("a WebSocket upgrade is gated at the proxy, where a browser Origin is mandatory", async () => {
  // The child requires an Origin on every upgrade, but proxyHeaders manufactures one, so the child
  // can never enforce that itself. The terminal socket is the most privileged surface Fray has.
  const upstream = await listen((_req, res) => res.end())
  // An upgraded socket is DETACHED from the http server, so closeAllConnections() cannot reach it and
  // the server never emits 'close'. Hold them here and destroy them explicitly, or teardown hangs.
  const upgraded: import("node:stream").Duplex[] = []
  upstream.server.on("upgrade", (_req, socket) => {
    upgraded.push(socket)
    socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n")
  })
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    host: "0.0.0.0",
    childPort: () => upstream.port,
    restart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    assert.equal(await upgrade(port, { host: `192.168.1.5:${port}`, origin: `http://192.168.1.5:${port}` }), "forwarded")
    assert.equal(await upgrade(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }), "forwarded")
    assert.equal(await upgrade(port, { host: `192.168.1.5:${port}` }), "refused", "no Origin")
    assert.equal(await upgrade(port, { host: `192.168.1.5:${port}`, origin: "http://evil.example" }), "refused")
    assert.equal(await upgrade(port, { host: `evil.example:${port}`, origin: `http://evil.example:${port}` }), "refused")

    // Regression: an upgraded socket is detached from the http server, so closeAllConnections() never
    // reaches it and close() waited on it forever. Fray always has live WebSockets once a browser is
    // open, so this hung every shutdown that followed a real page load.
    await assert.doesNotReject(
      Promise.race([
        proxy.close(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("proxy.close() hung on a live upgrade")), 3_000).unref()),
      ]),
    )
  } finally {
    await proxy.close().catch(() => undefined)
    for (const socket of upgraded) socket.destroy()
    await upstream.close().catch(() => undefined)
  }
})

async function freePort(): Promise<number> {
  const listener = await listen((_req, res) => res.end())
  const port = listener.port
  await listener.close()
  return port
}

async function eventually<T>(probe: () => T | undefined, description: string, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${description}`)
}
