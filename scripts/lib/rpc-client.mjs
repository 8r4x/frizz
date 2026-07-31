// The ONE node-side client for fray's RPC surface. Every harness and verify script must use this
// instead of hand-rolling `fetch`.
//
// Two pieces of knowledge live here and nowhere else, because getting either wrong produces a
// PLAUSIBLE-LOOKING WRONG ANSWER rather than an error — which is exactly how a harness ends up
// "proving" something it never tested:
//
//   1. TRANSPORT SPLIT. A `query` is GET with the input JSON-encoded into `?input=`; a `mutation` is
//      POST with a JSON body. POSTing a query does not throw — it 404s, and a harness that only
//      checks `status === 200` on the happy path reads the miss as "no data".
//   2. ENVELOPE. Every response is `{ result }` or `{ error }` — never the payload bare. Reading
//      `body.slug` off the envelope yields `undefined` for a call that actually SUCCEEDED.
//
// Both were gotten wrong at once while verifying the codex daemon fix (2026-07-23): the harness
// reported FAIL on a dispatch that had in fact worked. The app's browser client has always known
// this (packages/web/src/api) — the node side just had no shared copy to import.
//
// Loopback `Origin` is required or the server 403s a cross-origin write.

export class RpcError extends Error {
  constructor(method, status, message) {
    super(`rpc ${method} failed (${status}): ${message}`)
    this.name = "RpcError"
    this.method = method
    this.status = status
  }
}

/** A client bound to one running fray server. `query`/`mutate` return the UNWRAPPED result. */
export function createRpcClient(baseUrl) {
  const origin = new URL(baseUrl).origin

  const send = async (method, init, url) => {
    const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), origin } })
    const text = await res.text()
    let envelope
    try {
      envelope = JSON.parse(text)
    } catch {
      throw new RpcError(method, res.status, text.slice(0, 200) || "non-JSON response")
    }
    if (!res.ok || envelope?.error !== undefined) {
      throw new RpcError(method, res.status, typeof envelope?.error === "string" ? envelope.error : text.slice(0, 200))
    }
    return envelope?.result
  }

  return {
    origin,
    /** GET /rpc/<method>?input=… — for router `query` procedures. */
    query(method, input) {
      const url = new URL(`/rpc/${method}`, baseUrl)
      if (input !== undefined) url.searchParams.set("input", JSON.stringify(input))
      return send(method, {}, url)
    },
    /** POST /rpc/<method> — for router `mutation` procedures. */
    mutate(method, input) {
      return send(
        method,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input ?? {}) },
        new URL(`/rpc/${method}`, baseUrl),
      )
    },
    /** Resolves once /health answers, or throws after `timeoutMs`. */
    async waitForHealth(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        try { if ((await fetch(new URL("/health", baseUrl))).ok) return true } catch {}
        if (Date.now() > deadline) return false
        await new Promise((r) => setTimeout(r, 150))
      }
    },
  }
}
