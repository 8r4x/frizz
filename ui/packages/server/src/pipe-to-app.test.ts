import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Hono } from "hono"
import { pipeToApp } from "./index.ts"

// ── Regression guard: the node→Hono→node bridge must return a POST response body ────────────────────
//
// pipeToApp keyed the request AbortController on `req.on("close")` as a client-disconnect signal. On
// node v26.5.0 the IncomingMessage fires "close" the instant a handler finishes consuming the request
// body, so EVERY POST aborted its own controller the moment `c.req.json()` drained the body — before
// the response was written — and every mutation came back as a 0-byte application/json chunked reply
// (dispatch/followUp/completeThread/settings all dead; GET queries fine because there is no body to
// consume). This drives the REAL bridge against a REAL node http server + REAL fetch: a POST whose
// handler reads the body must still see its full response, and a GET must too.

// A tiny Hono app standing in for createApp's return; pipeToApp only calls `.fetch`.
function makeApp() {
  const app = new Hono()
  app.get("/g", (c) => c.json({ ok: "GET" }))
  // Reads the request body (the exact operation that trips the node "close" timing) then responds.
  app.post("/p", async (c) => {
    const body = await c.req.json().catch(() => null)
    return c.json({ ok: "POST", echo: body })
  })
  app.post("/empty", (c) => c.body(null, 204))
  return app as unknown as Parameters<typeof pipeToApp>[0]
}

async function withServer(run: (base: string) => Promise<void>) {
  const app = makeApp()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController()
    void pipeToApp(app, req, res, 0, controller).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test("pipeToApp returns the full body of a POST whose handler consumed the request body", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/p`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hi: 1 }),
    })
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.ok(text.length > 0, `POST body must not be empty (got ${text.length} bytes)`)
    assert.deepEqual(JSON.parse(text), { ok: "POST", echo: { hi: 1 } })
  })
})

test("pipeToApp still returns a GET body", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/g`)
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(text), { ok: "GET" })
  })
})

test("pipeToApp handles a bodyless POST response without hanging", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/empty`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    assert.equal(res.status, 204)
    assert.equal(await res.text(), "")
  })
})
