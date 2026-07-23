import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"

// THE recovery follow-up, shared by every surface that offers to restart an exited session — the
// thread header's Retry pill and the sidebar row's hover-revealed Retry — so the two can never send
// different messages down different paths.
//
// Recovery is an ORDINARY follow-up: the server reattaches the dead provider session (for a detached
// Codex app-server session it rebinds the rollout and retires the phantom current turn first), then
// starts this continuation.
export const STALLED_RETRY_MESSAGE = "Continue exactly where you left off."

export function retrySession(slug: string): Promise<void> {
  return rpc
    .followUp({ slug, message: STALLED_RETRY_MESSAGE })
    .then(() => showToast("Retrying…"))
    .catch((e) => showToast(`Retry failed: ${(e as Error).message.slice(0, 80)}`))
}
