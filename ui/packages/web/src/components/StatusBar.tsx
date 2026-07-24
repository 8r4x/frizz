import { Settings as SettingsIcon } from "lucide-react"
import { store, type ConnectionState } from "../store.ts"
import { STATUS_BAR_ACTION, STATUS_BAR_ICON } from "../lib/statusBar.ts"
import { IdentityMark, type ProjectIdentity } from "./Sidebar.tsx"
import { QuotaChips } from "./QuotaBar.tsx"
import { RestartFrayButton } from "./RestartFrayButton.tsx"

// THE STATUS BAR — one horizontal strip pinned to the page's upper-left, reading left to right:
//
//   owner/repo · connection · settings · reload · Claude quota · Codex quota
//
// It replaces three separate pieces of chrome that used to sit in three different places: the identity
// mark alone in the top-left, a settings/reload cluster alone in the top-right, and the quota chips
// floating above the sidebar's dispatch box. The quota reading is ACCOUNT-global — it was never a
// property of the prompt box it happened to be parked on — so it belongs with the rest of the global
// status, not stuck to a composer's corner.
//
// Everything in here is deliberately sized to ONE 24px line so it reads as a single strip: 12px
// identity text, 11px quota chips, 24px icon buttons (STATUS_BAR_ACTION). Hairline dividers segment the
// three groups; without them the run of unrelated glyphs reads as a pile rather than a bar.

function Divider() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
}

export function StatusBar({
  identity,
  connection,
  boardFallback,
}: {
  identity: ProjectIdentity
  connection: ConnectionState
  boardFallback?: { actualBytes: number; maxBytes: number } | null
}) {
  return (
    <div
      data-status-bar
      // The bar is capped to the viewport so a long owner/repo truncates (IdentityMark carries
      // min-w-0) instead of pushing the actions and quota chips off-screen; every item to the right of
      // the identity is shrink-0 and therefore always reachable.
      className="fixed top-3 left-4 z-20 flex h-6 max-w-[calc(100vw-2rem)] items-center gap-2 text-[12px]"
    >
      <IdentityMark identity={identity} state={connection} boardFallback={boardFallback} />
      <Divider />
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        className={STATUS_BAR_ACTION}
        onClick={() => (store.showSettings = true)}
      >
        <SettingsIcon size={STATUS_BAR_ICON} aria-hidden="true" />
      </button>
      {/* Renders null on a supervisor that can't restart — the gap collapses and the bar stays even. */}
      <RestartFrayButton />
      <Divider />
      <QuotaChips />
    </div>
  )
}
