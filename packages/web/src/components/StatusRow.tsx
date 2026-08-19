import { useSnapshot } from "valtio"
import { Settings as SettingsIcon } from "lucide-react"
import { store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"
import { IdentityMark, projectIdentity } from "./Sidebar.tsx"
import { QuotaChips } from "./QuotaBar.tsx"
import { RestartFrizzButton } from "./RestartFrizzButton.tsx"
import { useProjectRailVisible } from "../lib/projectRail.ts"

// THE STATUS ROW — one loose line along the TOP OF THE PROMPT BOX, split to its two ends:
//
//   home / repo                                    settings · reload │ Claude quota · Codex quota
//
// It rides the dispatch composer wherever that composer is: the sidebar's own top on a normal board,
// and the centered first-task box on a brand-new project (TodosView's `nothingAtAll` branch), which
// hides the sidebar entirely. Anywhere you can start a thread, this is above it.
//
// IT IS LOOSE, NOT A CHIP. Until 2026-08-19 this was a FIXED bar pinned to the page's upper-left
// corner with its own fill, hairline and shadow — a screen's width away from the column it described,
// and opaque because a full sidebar or a scrolling narrow rail would otherwise paint through it
// (maintainer: "move the top left status bar contents s.t. they are loose along the top of the sidebar
// prompt box"). In the column there is nothing to pass behind it, so the surface is gone: no fill, no
// border, no shadow, no z-index. Its two ends land EXACTLY on the composer's own border — measured 0.00px
// misalignment both sides — which is what makes a borderless strip read as belonging to the box below it.
//
// THE SPLIT is the layout: identity at the left edge, controls and quota pushed to the right. A
// left-PACKED row (every mark hugging the left, as the corner chip had them) leaves the right half of
// a 490px column empty and reads as a pile rather than a header.
//
// NO CONNECTION INDICATOR WHILE HEALTHY. A permanent green dot and the word "connected" led this row
// for as long as it existed; it said the same thing every second of every session (maintainer
// 2026-08-19: "drop the connected indicator, certainly. It's pretty useless"). IdentityMark now paints
// the connection ONLY when it is degraded — connecting, disconnected, or riding the SSE fallback —
// which is the only time the reading carries information. Dropping it also fixed the narrow case
// below, for free.
//
// THE 272px SIDEBAR IS THE BINDING WIDTH, not the viewport. The old bar was capped to the VIEWPORT, so
// it never ran out of room; this row lives in a column that floors at 272px in the tablet band. With
// the connection word still in it, the repo name truncated to "f…" at an 820px viewport — the one
// reading that must survive was the first one dropped. Without it every mark fits at the floor with
// room to spare (measured 2026-08-19). Any NEW mark added here has to be re-checked at 820px.
//
// THE GAP IS 12px OF INK, not 12px of box — the same law lib/iconRhythm.ts states for the thread
// footer, solved for a strip that mixes text, a hairline, 24px icon squares and quota pills. Each of
// those wears a different amount of dead space inside its own layout box, so a uniform `gap-2` drew
// six different distances (measured 2026-08-14, `scripts/ink-gaps.mjs --pad=0`, every CSS gap 8px):
//
//     "connected" → divider      8.86px ink
//     divider → gear            14.00px
//     gear → reload             20.00px   ← widest, and what the maintainer saw
//     reload → divider          14.00px
//     divider → Claude chip      8.00px   ← narrowest
//     Claude chip → Codex chip  10.25px
//
// A 2.5× spread on one provably uniform gap. The fix is per-mark, not per-gap: STATUS_ROW_ACTION
// collapses each icon square onto its glyph's ink, and then this one `gap-3` is the whole rhythm.
// Re-measured on the loose surface after the move: 12.00 / 11.75 / 13.00 / 13.00 against the 12px
// target, against 12.00–12.86 in the old chip.

function Divider() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
}

// TAKES NO PROPS, and reads its three live values itself. Both call sites are leaves of very
// different trees — the sidebar column and the fresh-project centered box — and the second one
// (TodosView) subscribes to no store state of its own. Threading identity/connection down from there
// would have newly subscribed the whole queue column to the store to feed a 24px strip. valtio's
// useSnapshot tracks the properties actually READ, so this component re-renders on a connection change
// and on nothing else.
export function StatusRow() {
  const snap = useSnapshot(store)
  const board = useBoard()
  // A missing board is not evidence that this project is named "frizz". Keep the row neutral until a
  // board keyframe supplies an actual owner/repo identity; reconnects retain their adopted board.
  const identity = projectIdentity(board)
  const railVisible = useProjectRailVisible()
  return (
    <div
      data-status-row
      // `mb-2.5` is the only thing holding the row off the prompt box, and the row carries no padding
      // of its own: it is flush with the composer's border on both sides, so the column reads as one
      // block rather than a strip parked above a box.
      className="mb-2.5 flex min-w-0 items-center gap-3 text-[12px]"
    >
      {/* min-w-0 + truncate live inside IdentityMark, so a long owner/repo gives way before anything
          to its right does; every mark in the trailing group is shrink-0 and therefore always reachable. */}
      <IdentityMark identity={identity} state={snap.connection} boardFallback={snap.socketBoardFallback} railVisible={railVisible} />
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          className={STATUS_ROW_ACTION}
          onClick={() => (store.showSettings = true)}
        >
          <SettingsIcon size={STATUS_ROW_ICON} aria-hidden="true" />
        </button>
        {/* Renders null on a supervisor that can't restart — the gap collapses and the row stays even. */}
        <RestartFrizzButton />
        <Divider />
        <QuotaChips />
      </span>
    </div>
  )
}
