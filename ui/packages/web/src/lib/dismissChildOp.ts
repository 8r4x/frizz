import { isDirectSubAgent } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"

// THE × ON A CHILD-OPERATION ROW — one action, for all three surfaces that list children.
//
// It asks the server to STOP the child before retiring it from tracking. Broker-backed Claude
// sub-agents have a real provider stop control; runtimes without one still retain the original
// phantom-row escape hatch, but the toast says plainly that the work may still be running.
//
// No optimism: the server refreshes the board after it has applied that policy. If a real stop throws,
// it deliberately does not retire the row; the error toast is the only client-side bookkeeping.
// (This lives beside `lib/childOps.ts` rather than inside it because that module is the row's pure
// vocabulary, importable by an SSR test with no store or transport behind it.)
export function dismissChildOp(slug: string, id: string): void {
  rpc.stopBackgroundOp({ slug, id })
    .then(({ stopped, note }) => {
      if (stopped) showToast("Sub-agent stopped")
      else if (note) showToast(`${note} The row was cleared, but the work may still be running.`, { duration: 7000 })
    })
    .catch((error: unknown) => {
      showToast(`Couldn’t stop: ${(error instanceof Error ? error.message : String(error)).slice(0, 100)}`, { duration: 7000 })
    })
}

// WHICH rows may carry the ×, on every surface. Stop retires a tracked op BY ITS DISPATCH ID, and a
// descendant's dispatch lives in an ANCESTOR's transcript — this thread never tracked it, so the call
// would be a silent no-op. A control that does nothing is worse than no control, so a descendant row
// (and an id-less one, which has no handle at all) simply has no ×.
export function childOpDismisser(slug: string, op: { id?: string; depth?: number }): (() => void) | undefined {
  if (!op.id || !isDirectSubAgent(op)) return undefined
  const id = op.id
  return () => dismissChildOp(slug, id)
}
