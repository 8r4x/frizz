import { Settings as SettingsIcon } from "lucide-react"
import { store, type ConnectionState } from "../store.ts"
import { STATUS_BAR_ACTION, STATUS_BAR_ICON } from "../lib/statusBar.ts"
import { IdentityMark, type ProjectIdentity } from "./Sidebar.tsx"
import { QuotaChips } from "./QuotaBar.tsx"
import { RestartFrizzButton } from "./RestartFrizzButton.tsx"
import { useProjectRailVisible } from "../lib/projectRail.ts"

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
//
// THE GAP IS 12px OF INK, not 12px of box — the same law lib/iconRhythm.ts states for the thread
// footer, solved here for a strip that mixes text, hairlines, 24px icon squares and quota pills. Each
// of those wears a different amount of dead space inside its own layout box, so a uniform `gap-2` drew
// six different distances (measured 2026-08-14, `scripts/ink-gaps.mjs --pad=0`, every CSS gap 8px):
//
//     "connected" → divider      8.86px ink
//     divider → gear            14.00px
//     gear → reload             20.00px   ← widest, and what the maintainer saw
//     reload → divider          14.00px
//     divider → Claude chip      8.00px   ← narrowest
//     Claude chip → Codex chip  10.25px
//
// A 2.5× spread on one provably uniform gap. The fix is per-mark, not per-gap: STATUS_BAR_ACTION
// collapses each icon square onto its glyph's ink, and then this one `gap-3` is the whole rhythm.
// Nothing else needs a trim — the identity label ends 0.86px inside its box, the hairlines ARE their
// own ink, and the quota chips' provider marks reach their box edge. Re-measured after: 12.86 / 12.00
// / 12.00 / 12.00 / 12.00 / 12.25 against the 12px target.
//
// 12px, and not the 8px the bar used to keep at its two loosest-looking joints, because 8px of ink
// between two 24px hover targets overlaps them by 4px, and because it is the distance the footer strip
// already settled on for a row of small marks — one optical distance for both strips beats two.
//
// THE BAR IS AN OPAQUE SURFACE OF ITS OWN, not bare glyphs floating on the page. It used to have no
// background at all, so anything that reached this corner painted THROUGH it: a full sidebar pushes the
// dispatch composer up to the viewport top, and on a narrow viewport the whole rail scrolls past — both
// smeared the list text and the composer's border straight across the identity, the gear and the quota
// chips. A fill + hairline + shadow at z-20 (above the sidebar, which deliberately carries no z-index)
// makes the bar a chip the page passes BEHIND. Sidebar.tsx reserves this band's height at the top of
// the desktop column so the composer stops short of it instead of hiding underneath it.

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
  const railVisible = useProjectRailVisible()
  return (
    <div
      data-status-bar
      // The bar is capped to the viewport so a long owner/repo truncates (IdentityMark carries
      // min-w-0) instead of pushing the actions and quota chips off-screen; every item to the right of
      // the identity is shrink-0 and therefore always reachable.
      //
      // Geometry: h-7 at top-2.5 keeps the strip's optical centre exactly where the old h-6/top-3 line
      // sat (y = 24px) while giving the fill 2px of breathing room around the 24px icon targets. Now
      // that the bar is a BOX, its inset is the corner gutter (left-3 = the 12px the narrow layout
      // already uses for the sidebar), so the chip's edge lines up with the composer below it.
      // The left inset clears the project rail ONLY WHEN THERE IS ONE: 57px + the same 12px gutter.
      // A hidden rail must leave no trace, so this goes back to the plain corner inset rather than
      // holding a lane open for a column that is not there. (With the rail showing at left-3 the
      // bar's own project mark rendered ON TOP of the rail's home mark — measured, which is why the
      // offset exists at all.) Below 800px the rail never shows, so the gutter always wins there.
      className={`fixed top-2.5 ${railVisible ? "left-[69px] max-[800px]:left-3" : "left-3"} z-20 flex h-7 max-w-[calc(100vw-1.5rem)] items-center gap-3 rounded-lg border border-border bg-panel px-2 text-[12px] shadow-sm shadow-black/30`}
    >
      <IdentityMark identity={identity} state={connection} boardFallback={boardFallback} railVisible={railVisible} />
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
      <RestartFrizzButton />
      <Divider />
      <QuotaChips />
    </div>
  )
}
