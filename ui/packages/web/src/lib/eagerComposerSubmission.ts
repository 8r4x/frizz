import { useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"
import { appendQueuedMessage, removeQueuedMessage } from "../hooks.ts"
import { showToast } from "../store.ts"
import { markSteered, clearSteered } from "./steering.ts"

let fallbackDeliverySequence = 0

function newDeliveryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  fallbackDeliverySequence += 1
  return `browser-${Date.now()}-${fallbackDeliverySequence}`
}

// The message surfaces all obey the same ordering: make the local UI truthful before beginning
// network work.  In particular, `onOptimistic` clears the controlled draft before the mutation
// starts, so an Enter cannot feel gated on an RPC round-trip.  Failure reverses that local work and
// lets the caller restore its exact draft (without overwriting any newer text).
export type EagerFollowUpCallbacks = {
  onOptimistic?: () => void
  onSuccess?: () => void
  onRollback?: () => void
  scrollToBottom?: boolean
}

export function beginEagerSubmission({
  optimistic,
  request,
  success,
  failure,
}: {
  optimistic: () => void
  request: () => Promise<unknown>
  success?: () => void
  failure: (error: Error) => void
}): void {
  // Do not make this function async: callers need `optimistic` to finish before the first awaitable
  // operation is even started. That ordering is the entire perceived-latency contract.
  optimistic()
  void request().then(
    () => success?.(),
    (error: unknown) => failure(error instanceof Error ? error : new Error(String(error))),
  )
}

// ── per-thread send serialization ────────────────────────────────────────────────────────────────
// The composer no longer locks while a send is in flight (a steer must feel instant, and half a
// second of dead textarea is the single biggest reason it did not — see Composer's `busy`). That
// removes the accidental serialization the lock used to provide, and TWO things depended on it:
//
//   · ORDER. Two follow-ups fired 200ms apart are two independent HTTP requests; nothing but arrival
//     order decides which reaches the worker's stdin first. The operator typed them in an order and
//     means it.
//   · The server's runtime-control CAS. `resumeThread` claims the row (beginRuntimeControl) for the
//     duration of the tmux injection; a second follow-up arriving inside that window loses the CAS
//     and comes back "another runtime control is in progress" — a hard failure for a message the
//     human already watched appear in the transcript.
//
// So the QUEUE moves from the UI to the network: every surface bound to a slug shares one FIFO chain,
// keyed at module scope because the same thread is steerable from several mounted composers at once
// (queue card + drawer + a second tab's board). Each link runs regardless of its predecessor's
// outcome — a failed send rolls back only its own bubble and must not strand the sends behind it.
const sendChains = new Map<string, Promise<void>>()

export function enqueueThreadSend(slug: string, run: () => Promise<void>): Promise<void> {
  const tail = sendChains.get(slug) ?? Promise.resolve()
  const next = tail.then(run, run)
  // The stored tail must never reject, or every later `.then(run, run)` would still run but leave an
  // unhandled rejection behind it. The RETURNED promise keeps its rejection for the caller's failure path.
  sendChains.set(slug, next.then(() => {}, () => {}))
  return next
}

export function useEagerFollowUp(slug: string): {
  submit: (text: string, callbacks?: EagerFollowUpCallbacks) => boolean
  pending: boolean
} {
  const queryClient = useQueryClient()
  // Retained for surfaces that want a spinner on their own send BUTTON. It is deliberately NOT wired
  // into any composer's `busy` anymore: an optimistic send has already committed locally, so gating
  // the textarea on the round-trip only made the box go dead (and lose the caret) for the exact half
  // second the operator wanted to keep typing.
  const [pending, setPending] = useState(0)

  const submit = useCallback((text: string, callbacks: EagerFollowUpCallbacks = {}) => {
    const message = text.trim()
    if (!message) return false
    const deliveryId = newDeliveryId()
    setPending((n) => n + 1)
    beginEagerSubmission({
      optimistic: () => {
        callbacks.onOptimistic?.()
        appendQueuedMessage(queryClient, slug, message, { scrollToBottom: callbacks.scrollToBottom, deliveryId })
        // The row is working again the instant the operator commits, not when the tmux injection
        // returns ~half a second later — see lib/steering.ts.
        markSteered(slug)
        rpc.markRead({ slug }).catch(() => {})
      },
      request: () => enqueueThreadSend(slug, () => rpc.followUp({ slug, message, deliveryId })),
      success: () => {
        setPending((n) => Math.max(0, n - 1))
        callbacks.onSuccess?.()
      },
      failure: (error) => {
        setPending((n) => Math.max(0, n - 1))
        removeQueuedMessage(queryClient, slug, message, deliveryId)
        clearSteered(slug)
        callbacks.onRollback?.()
        // A transport rejection is not enough evidence to expose terminal-recovery machinery.
        // Restore the draft and leave the provider untouched.
        showToast(`Steer failed — ${error.message.slice(0, 90)}`)
      },
    })
    return true
  }, [queryClient, slug])

  return { submit, pending: pending > 0 }
}
