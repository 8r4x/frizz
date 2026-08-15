import { noteServerBootId } from "./boot.ts"
import { store } from "../store.ts"
import { PROCEDURES, type Api, type ProcType, type RpcCallOpts } from "./contract.ts"
import { FRIZZ_ROUTE_PREFIX } from "@frizz/shared"
import { apiBase } from "../lib/base-path.ts"

export type { Api, ProcType, RpcCallOpts } from "./contract.ts"
export { PROCEDURES } from "./contract.ts"

export const CONTROL_PLANE_RESTARTING_MESSAGE = "Frizz is updating and restarting. Your draft is preserved; wait until it is ready before sending or changing settings."

// A failure the caller may safely REPLAY, because the request provably took no effect: either the
// server refused it at a contention gate upstream of any side effect (`retryable` in the error
// envelope — see RetryableDeliveryError), or it was refused here before it ever reached the wire.
// The absence of this marker means AMBIGUOUS — the request may well have landed — so an unmarked
// failure must be surfaced, never re-sent.
export function isRetryableRpcError(error: unknown): boolean {
  return (error as { retryableRpc?: unknown } | null)?.retryableRpc === true
}

function markRetryable(error: Error): Error {
  Object.defineProperty(error, "retryableRpc", { value: true, enumerable: false })
  return error
}

export function assertMutationAllowedDuringControlPlaneTransition(type: ProcType): void {
  if (type === "mutation" && store.controlPlaneState === "restarting") {
    // Nothing was sent, so this is the safest replay there is: a send caught by a build promotion
    // should wait the promotion out, not be handed back to the operator as a failure.
    throw markRetryable(new Error(CONTROL_PLANE_RESTARTING_MESSAGE))
  }
}

// Parse one RPC envelope without leaking a browser JSON SyntaxError into the UI. During local HMR the
// web bundle can update before the long-running server process; a brand-new route then returns Hono's
// plain-text 404 ("404 Not Found"), which `res.json()` misleadingly reported as "Unexpected
// non-whitespace character after JSON". Name that operational fix directly.
export async function parseRpcResponse(res: Response, name: string): Promise<unknown> {
  const body = await res.text()
  let json: { result?: unknown; error?: unknown; retryable?: unknown }
  try {
    json = JSON.parse(body) as { result?: unknown; error?: unknown; retryable?: unknown }
  } catch {
    if (res.status === 404 || res.status === 405) {
      throw new Error("Frizz server restart required — this control is newer than the running server")
    }
    // SAY THE STATUS. A non-JSON body is always something OTHER than the RPC answering, and which
    // something is the entire diagnosis — 403 is the local-origin gate refusing (a stale tab, a
    // host/origin mismatch), 5xx is the server failing, 200-with-HTML is a dev restart window serving
    // the SPA shell. Reporting all of them as "invalid response" sent one debugging session down the
    // wrong path entirely (2026-08-15: a 403 read as a schema problem and cost half an hour).
    if (res.status === 403) {
      throw new Error(`RPC ${name} was refused (403) — the page's origin does not match the server it is talking to. Reload from the URL frizz is actually serving.`)
    }
    throw new Error(`RPC ${name} returned a non-JSON response (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const error = new Error(typeof json.error === "string" ? json.error : `RPC ${name} failed`)
    throw json.retryable === true ? markRetryable(error) : error
  }
  return json.result
}

async function call(name: string, type: ProcType, input?: unknown, opts?: RpcCallOpts): Promise<unknown> {
  // The old child may remain healthy while its durable owner is building a replacement. Do not let
  // a mutation race that handoff; local draft state remains editable and every query stays available.
  assertMutationAllowedDuringControlPlaneTransition(type)
  if (type === "query") {
    const url = new URL(`${apiBase()}/rpc/${name}`, location.origin)
    if (input !== undefined) url.searchParams.set("input", JSON.stringify(input))
    const res = await fetch(url.toString(), { signal: opts?.signal })
    noteServerBootId(res.headers.get("x-frizz-boot")) // notice a server restart on any RPC roundtrip
    return parseRpcResponse(res, name)
  }
  const res = await fetch(`${apiBase()}/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
    signal: opts?.signal,
  })
  noteServerBootId(res.headers.get("x-frizz-boot"))
  return parseRpcResponse(res, name)
}

export const rpc = new Proxy({} as Api, {
  get(_target, name: string) {
    const type = (PROCEDURES as Record<string, ProcType | undefined>)[name]
    if (!type) return undefined
    return (input?: unknown, opts?: RpcCallOpts) => call(name, type, input, opts)
  },
})
