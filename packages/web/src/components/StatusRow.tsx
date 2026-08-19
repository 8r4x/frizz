import { useSnapshot } from "valtio"
import { House, Settings as SettingsIcon } from "lucide-react"
import { store, type ConnectionState } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"
import { projectIdentity } from "./Sidebar.tsx"
import { QuotaChips, useQuotaChipsVisible } from "./QuotaBar.tsx"
import { RestartFrizzButton } from "./RestartFrizzButton.tsx"

// THE STATUS ROW — one loose line along the TOP OF THE PROMPT BOX, controls at the left edge and the
// project at the right:
//
//   home │ settings · reload │ Claude 83% · Codex 59%                              ● repo-name
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
// border, no shadow, no z-index. Its two ends land on the composer's own border, which is what makes a
// borderless strip read as belonging to the box below it.
//
// CONTROLS LEFT, IDENTITY RIGHT (maintainer 2026-08-19). The row briefly ran the other way — identity
// leading, controls and quota trailing — which reads as a heading with its buttons pushed away. This
// way the left edge is one uninterrupted run of things you can press, and the project name anchors the
// right edge as the row's one piece of prose.
//
// TWO DIVIDERS, NOT ONE, and the first one is the point: home LEAVES this project, while settings and
// reload act on the app you are already in. One divider would group all three as "buttons"; two say
// the first one is a door out. The second divider separates the buttons from the readouts.
//
// THE CONNECTION IS A DOT AND NOTHING ELSE. A green dot and the word "connected" led this row for as
// long as it existed, saying the same thing every second of every session (maintainer: "drop the
// connected indicator, certainly. It's pretty useless"). The WORD is what went; the dot stays, pinned
// to the name it qualifies, and it keeps every state's colour — a dot that is only ever green would be
// exactly the decoration that was removed.
//
// THE 272px SIDEBAR IS THE BINDING WIDTH, not the viewport. The old bar was capped to the VIEWPORT, so
// it never ran out of room; this row lives in a column that floors at 272px in the tablet band. With
// the connection word still in it the repo name truncated to "f…" at an 820px viewport — the one
// reading that must survive was the first one dropped. Any NEW mark added here has to be re-checked at
// 820px.
//
// THE GAP IS 12px OF INK, not 12px of box — the same law lib/iconRhythm.ts states for the thread
// footer, solved for a strip that mixes 24px icon squares, hairlines, quota pills and a name. Each of
// those wears a different amount of dead space inside its own layout box, so a uniform `gap-2` drew six
// different distances (measured 2026-08-14, `scripts/ink-gaps.mjs --pad=0`, every CSS gap 8px) ranging
// 8.00px to 20.00px — a 2.5× spread on one provably uniform gap. The fix is per-mark, not per-gap:
// STATUS_ROW_ACTION collapses each icon square onto its glyph's ink, and then this one `gap-3` is the
// whole rhythm. Readings for the current row are in StatusRow.test.ts.

function Divider() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
}

// The connection, reduced to its dot. `role="img"` with the state as its label because the dot is now
// the ENTIRE reading — with the word gone there is nothing else for a screen reader to find.
function ConnectionDot({ state, fallback }: { state: ConnectionState; fallback: boolean }) {
  const map = {
    open: { cls: "bg-live", word: "connected" },
    connecting: { cls: "bg-accent", word: "connecting…" },
    closed: { cls: "bg-red-500", word: "disconnected" },
  } as const
  const m = map[state]
  // An open socket that had to fall back to SSE is NOT simply "connected" — that is the degraded mode
  // the fallback exists to name, and the only place left to name it is this dot's label and title.
  const word = fallback ? "connected · SSE fallback" : m.word
  return (
    <span
      role="img"
      aria-label={word}
      title={word}
      data-board-sync-fallback={fallback || undefined}
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${fallback ? "bg-accent" : m.cls}`}
    />
  )
}

/**
 * Takes no props, and reads its live values itself. Both call sites are leaves of very different trees
 * — the sidebar column and the fresh-project centered box — and the second one (TodosView) subscribes
 * to no store state of its own. Threading identity/connection down from there would have newly
 * subscribed the whole queue column to the store to feed a 24px strip. valtio's useSnapshot tracks the
 * properties actually READ, so this re-renders on a connection change and on nothing else.
 */
export function StatusRow() {
  const snap = useSnapshot(store)
  const board = useBoard()
  // A missing board is not evidence that this project is named "frizz". Keep the row neutral until a
  // board keyframe supplies an actual name; reconnects retain their adopted board.
  const identity = projectIdentity(board)
  // Whether there is a quota group behind the second divider at all. Every chip hides itself when it
  // has no reading, so without this a board with neither provider reporting draws a trailing hairline
  // with nothing after it.
  const quotaVisible = useQuotaChipsVisible()
  const usingFallback = snap.connection === "open" && !!snap.socketBoardFallback

  const name = identity.state === "verified" ? identity.repo : identity.state === "local" ? identity.name : null
  const title = identity.state === "verified" ? identity.label : (name ?? undefined)
  const accessibleName =
    identity.state === "verified"
      ? `Project: ${identity.label}`
      : identity.state === "local"
        ? `Project: ${identity.name}; local repository with no git remote`
        : identity.state === "loading"
          ? "Project identity loading"
          : "Project identity unavailable"

  return (
    <div
      data-status-row
      // `mb-2.5` is the only thing holding the row off the prompt box, and the row carries no padding
      // of its own: it is flush with the composer's border on both sides, so the column reads as one
      // block rather than a strip parked above a box.
      className="mb-2.5 flex min-w-0 items-center gap-3 text-[12px]"
    >
      {/* THE DOOR OUT. A 24px target like its neighbours rather than the bare 12px glyph it was inside
          the old identity cluster: at the head of a run of buttons it reads as one of them, and a 12px
          hit area beside two 24px ones is a target you miss. `-ml-px` is the ink trim — the square's
          own `-mx-1.5` leaves the house glyph's ink 1px OUTSIDE the composer's border (measured), and
          the left edge is the one place in this row where a pixel of overhang is visible. */}
      <a href="/" title="All projects" aria-label="All projects" className={`${STATUS_ROW_ACTION} -ml-px`}>
        <House size={STATUS_ROW_ICON} aria-hidden="true" />
      </a>
      <Divider />
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
      {quotaVisible && (
        <>
          <Divider />
          <QuotaChips />
        </>
      )}
      {/* THE PROJECT, pinned to the right edge. min-w-0 + truncate so a long name gives way before
          anything to its left does; every mark before it is shrink-0 and therefore always reachable. */}
      <span
        // `gap-1.5`, NOT the row's `gap-3`: the dot is a mark QUALIFYING this name, the same
        // relationship a quota chip has between its provider mark and its number — and that one is
        // deliberately half the row's distance, which is what keeps each pair reading as one thing
        // rather than as two loose marks. Both ends reach their own box edge here (the dot's ink fills
        // its 6px exactly; the name's starts at 0), so 6px of box IS 6px of ink. At `gap-2` it measured
        // 8px and the dot read as detached from the name it belongs to.
        className="ml-auto flex min-w-0 items-center gap-1.5"
        data-project-identity-state={identity.state}
        aria-label={accessibleName}
        aria-busy={identity.state === "loading" || undefined}
      >
        <ConnectionDot state={snap.connection} fallback={usingFallback} />
        {name ? (
          <span className="block min-w-0 truncate font-semibold text-fg/90" title={title}>{name}</span>
        ) : (
          // Only before the first board keyframe, or on a keyframe with nothing nameable in it. A repo
          // with no git remote is NOT this case — it has a name (its directory) and shows it.
          <span className="identity-placeholder w-24" aria-hidden="true" />
        )}
      </span>
    </div>
  )
}
