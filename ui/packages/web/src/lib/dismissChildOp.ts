import { isDirectSubAgent } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"

// THE × ON A CHILD-OPERATION ROW — one action, for all three surfaces that list children.
//
// It retires the op from TRACKING (server-side `dismissOp`), which is not a process kill: fray does not
// own the child processes. What it clears is the row and the Done-warning count it feeds, so a finished
// op whose terminal notification never landed stops holding a thread hostage.
//
// No optimism: `dismissOp` calls the board's onChange, so the row disappears on the next board frame.
// On failure the row simply stays and the next frame reconciles — the toast is the only thing to say.
// (This lives beside `lib/childOps.ts` rather than inside it because that module is the row's pure
// vocabulary, importable by an SSR test with no store or transport behind it.)
export function dismissChildOp(slug: string, id: string): void {
  rpc.dismissBackgroundOp({ slug, id }).catch((error: unknown) => {
    showToast(`Dismiss failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`)
  })
}

// WHICH rows may carry the ×, on every surface. Dismiss retires a tracked op BY ITS DISPATCH ID, and a
// descendant's dispatch lives in an ANCESTOR's transcript — this thread never tracked it, so the call
// would be a silent no-op. A control that does nothing is worse than no control, so a descendant row
// (and an id-less one, which has no handle at all) simply has no ×.
export function childOpDismisser(slug: string, op: { id?: string; depth?: number }): (() => void) | undefined {
  if (!op.id || !isDirectSubAgent(op)) return undefined
  const id = op.id
  return () => dismissChildOp(slug, id)
}
