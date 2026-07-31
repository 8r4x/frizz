import { noteServerBootId } from "./boot.ts"
import { store } from "../store.ts"
import { PROCEDURES, type Api, type ProcType, type RpcCallOpts } from "./contract.ts"

export type { Api, ProcType, RpcCallOpts } from "./contract.ts"
export { PROCEDURES } from "./contract.ts"

export const CONTROL_PLANE_RESTARTING_MESSAGE = "Fray is updating and restarting. Your draft is preserved; wait until it is ready before sending or changing settings."

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
      throw new Error("Fray server restart required — this control is newer than the running server")
    }
    throw new Error(`RPC ${name} returned an invalid response`)
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
    const url = new URL(`/rpc/${name}`, location.origin)
    if (input !== undefined) url.searchParams.set("input", JSON.stringify(input))
    const res = await fetch(url.toString(), { signal: opts?.signal })
    noteServerBootId(res.headers.get("x-fray-boot")) // notice a server restart on any RPC roundtrip
    return parseRpcResponse(res, name)
  }
  const res = await fetch(`/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
    signal: opts?.signal,
  })
  noteServerBootId(res.headers.get("x-fray-boot"))
  return parseRpcResponse(res, name)
}

export const rpc = new Proxy({} as Api, {
  get(_target, name: string) {
    const type = (PROCEDURES as Record<string, ProcType | undefined>)[name]
    if (!type) return undefined
    return (input?: unknown, opts?: RpcCallOpts) => call(name, type, input, opts)
  },
})
