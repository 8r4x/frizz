import { isDirectSubAgent } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"

// THE × ON A CHILD-OPERATION ROW — one action, for all three surfaces that list children.
//
// It means one of two honest things, decided by the row's own state (see `childOpDismisser`, which is
// where the control is withheld entirely when neither is true):
//   RUNNING  → STOP. The server ends the child through the provider's real control, then retires the row.
//   STALE/RESTED → CLEAR. Nothing is running to stop; this retires a finished op from tracking, which
//                  is the escape hatch the × was originally built for (a completion that never landed
//                  keeps a thread hostage through the Done-warning count).
//
// No optimism: the server refreshes the board after it has applied that policy. If a real stop throws,
// it deliberately does not retire the row; the error toast is the only client-side bookkeeping.
// (This lives beside `lib/childOps.ts` rather than inside it because that module is the row's pure
// vocabulary, importable by an SSR test with no store or transport behind it.)
export function dismissChildOp(slug: string, id: string): void {
  rpc.stopBackgroundOp({ slug, id })
    .then(({ stopped, note, descendantsStopped }) => {
      // Only the KILL is worth announcing. A clear needs no toast — the row leaving IS the feedback.
      if (!stopped) return
      // The count belongs in the toast because the SUBTREE is the part the operator cannot see: the
      // row they clicked leaves the board either way, and until this stop covered the fan-out its
      // grandchildren kept running and reported back under an agent that was already gone. A
      // descendant fray failed to stop rides in `note` and outranks the count — that is live work
      // still burning, and it gets the longer toast the error path uses.
      if (note) return showToast(`Sub-agent stopped. ${note}`, { duration: 7000 })
      showToast(descendantsStopped > 0 ? `Sub-agent and ${descendantsStopped} descendant${descendantsStopped === 1 ? "" : "s"} stopped` : "Sub-agent stopped")
    })
    .catch((error: unknown) => {
      showToast(`Couldn’t stop: ${(error instanceof Error ? error.message : String(error)).slice(0, 100)}`, { duration: 7000 })
    })
}

// WHICH rows may carry the ×, on every surface. Three independent reasons to withhold it, and the
// governing rule is the maintainer's (2026-07-30): "We shouldn't show the X if it doesn't fucking
// work." They hit it on a background SHELL, whose × cleared the row and then admitted in a toast that
// the work was probably still going — a control that lies about what it did.
//
//  1. NO ID / A DESCENDANT. Retiring acts on a tracked op BY ITS DISPATCH ID, and a descendant's
//     dispatch lives in an ANCESTOR's transcript — this thread never tracked it, so the call would be
//     a silent no-op. (`stopTask` alone could reach a descendant, but the row would then not clear,
//     which is the same lie in the other direction. The drawer's "Stop sub-agent" covers those.)
//  2. RUNNING, BUT NOT STOPPABLE. The row is live work fray has no channel to end: a background shell
//     (fray learns it exists by reading the worker's transcript and holds no handle on the process),
//     or a sub-agent on a tmux/codex thread. `stoppable` is the SERVER's answer and is never
//     re-derived here — a BgShellView carries no such field at all, so a running shell falls out here
//     by construction rather than by a kind check that could drift.
//  3. Everything else keeps the ×, including every stale/rested row: there the click CLEARS a finished
//     op, which is exactly what it claims and works on every runtime.
export function childOpDismisser(
  slug: string,
  op: { id?: string; depth?: number; state?: string; stoppable?: boolean },
): (() => void) | undefined {
  if (!op.id || !isDirectSubAgent(op)) return undefined
  if (op.state === "running" && !op.stoppable) return undefined
  const id = op.id
  return () => dismissChildOp(slug, id)
}
