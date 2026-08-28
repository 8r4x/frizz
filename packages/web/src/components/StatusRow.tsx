import { House, Settings as SettingsIcon } from "lucide-react"
import { store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"
import { projectIdentity } from "./Sidebar.tsx"
import { QuotaChips, useQuotaChipsVisible } from "./QuotaBar.tsx"
import { RestartFrizzButton } from "./RestartFrizzButton.tsx"

// THE STATUS ROW — one loose line along the TOP OF THE PROMPT BOX, controls at the left edge and the
// project at the right:
//
//   home │ settings · reload │ Claude 83% · Codex 59%                       ⌂ owner/repo
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
// THE PROJECT IS A LINK TO ITS REPO, AND THE CONNECTION INDICATOR IS GONE (maintainer 2026-08-28:
// "There should be a way to open up the GitHub repo for a given project if one is detected … Perhaps
// it should actually be showing owner/repo if a repo is detected. And to get [the GitHub] icon, then
// maybe we should just drop the status indicator"). The connection had already been reduced from a
// green dot plus the word "connected" to the dot alone on 2026-08-19 ("drop the connected indicator,
// certainly. It's pretty useless"); the dot then said "green" every second of every session, and its
// one informative state — disconnected — is something the page ALSO tells you by going stale. The
// GitHub mark takes its slot, and the mark is the whole affordance: it renders only when the board
// carries `githubRepo` (origin is github.com), so a GitLab origin or a remote-less directory shows its
// name as plain text with no mark and no link. Name and mark are ONE anchor — a real `<a target=_blank>`
// rather than a scripted window.open, so ⌘-click, middle-click and copy-link all work.
//
// THE 272px SIDEBAR IS THE BINDING WIDTH, not the viewport. The old bar was capped to the VIEWPORT, so
// it never ran out of room; this row lives in a column that floors at 272px in the tablet band. With
// the connection word still in it the repo name truncated to "f…" at an 820px viewport — the one
// reading that must survive was the first one dropped. Showing owner/repo makes that binding again:
// "colinhacks/frizz" does not fit beside two quota chips at 272px, so the name truncates from the
// START (`direction: rtl` on the clipping span, the text isolated LTR inside it) and it is the OWNER
// that gives way — "…hacks/frizz", never "colinhacks/f…". Any NEW mark added here has to be re-checked
// at 820px.
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

// GitHub's mark, from Simple Icons (CC0-1.0), copied into a code-native SVG so no runtime image is
// fetched — the same treatment as the two provider marks in ProviderMark.tsx, which are its neighbours
// in this row: https://github.com/simple-icons/simple-icons/blob/develop/icons/github.svg
//
// `currentColor` so it takes the anchor's tone, and `aria-hidden` because the anchor's own label
// already says "on GitHub" — a second "GitHub" from the image would read the word twice.
function GithubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

// The name, clipped from the START. A plain `truncate` keeps the head of the string and drops the
// tail, which for "owner/repo" throws away the repo — the one half worth keeping. `direction: rtl` on
// the clipping box moves the overflow (and the ellipsis) to the left edge; the text itself is
// re-isolated LTR (`unicode-bidi: isolate` + `direction: ltr`) so its letters and the slash keep their
// order. NOTE the string must end in a strong LTR character for this to hold — a trailing neutral
// (punctuation) would jump to the other end under rtl, and a repo name cannot end in one.
function StartTruncated({ text, title, className }: { text: string; title?: string; className?: string }) {
  return (
    <span dir="rtl" className={`block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${className ?? ""}`} title={title}>
      <span dir="ltr" className="[unicode-bidi:isolate]">{text}</span>
    </span>
  )
}

/**
 * Takes no props, and reads its live values itself. Both call sites are leaves of very different trees
 * — the sidebar column and the fresh-project centered box — and the second one (TodosView) subscribes
 * to no store state of its own. Threading identity down from there would have newly subscribed the
 * whole queue column to the store to feed a 24px strip. valtio's useSnapshot tracks the properties
 * actually READ, so this re-renders on a board change and on nothing else.
 */
export function StatusRow() {
  const board = useBoard()
  // A missing board is not evidence that this project is named "frizz". Keep the row neutral until a
  // board keyframe supplies an actual name; reconnects retain their adopted board.
  const identity = projectIdentity(board)
  // Whether there is a quota group behind the second divider at all. Every chip hides itself when it
  // has no reading, so without this a board with neither provider reporting draws a trailing hairline
  // with nothing after it.
  const quotaVisible = useQuotaChipsVisible()
  // Host-STRICT: the board carries `githubRepo` only when the origin remote is github.com (see
  // BoardSnapshot), which is exactly the case where a link to github.com is a right destination. The
  // display label alone cannot decide this — a GitLab origin yields an owner/repo there too.
  const githubRepo = board?.githubRepo ?? null

  const name = identity.state === "verified" ? identity.label : identity.state === "local" ? identity.name : null
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
      {/* THE PROJECT, pinned to the right edge. min-w-0 so a long name gives way before anything to its
          left does; every mark before it is shrink-0 and therefore always reachable. */}
      <span
        className="ml-auto flex min-w-0 items-center"
        data-project-identity-state={identity.state}
        aria-label={accessibleName}
        aria-busy={identity.state === "loading" || undefined}
      >
        {name && githubRepo ? (
          // `gap-1.5`, NOT the row's `gap-3`: the mark is a mark QUALIFYING this name, the same
          // relationship a quota chip has between its provider mark and its number — and that one is
          // deliberately half the row's distance, which is what keeps each pair reading as one thing
          // rather than as two loose marks.
          //
          // `text-fg/75` is STATUS_ROW_ACTION's tone, so the mark sits at the same brightness as the
          // home, settings and reload glyphs; the NAME keeps the fg/90 it always had, and the whole
          // anchor lifts to full fg on hover — the same hover STATUS_ROW_ACTION uses, which is what
          // tells a reader the name is now a control. `size-3` (12px) because this mark fills its
          // 24-unit viewBox edge to edge, so 12px nominal IS the ~12px of ink every other glyph in the
          // row paints (the provider marks need 14px/12.75px for the same ink; measured 2026-08-28
          // with scripts/ink-gaps.mjs --dsf=4 --pad=0 — re-measure rather than re-guess).
          //
          // VERTICALLY THE MARK SITS ON THE CAP BAND, AND THE BROWSER DOES THE ARITHMETIC. This app
          // renders in two fonts (html[data-font]) with different cap heights, and `items-center`
          // measured the mark 0.23px low in sans but 0.83px low in mono — no single hand-fitted nudge
          // is right in both. So the pair is `items-baseline`: the mark's bottom lands on the text's
          // baseline, and `0.5em - 0.5cap` then drops its centre onto the middle of the resolved
          // font's cap band, whatever that font is. Re-measured 2026-08-28 (visual-review routine,
          // /tmp/sr-vertical.js in the handoff): residual vs cap-band centre within the glyph's own
          // 0.15px box asymmetry in BOTH fonts.
          <a
            href={`https://github.com/${githubRepo}`}
            target="_blank"
            rel="noopener"
            title={`Open ${name} on GitHub`}
            aria-label={`Open ${name} on GitHub`}
            className="group flex min-w-0 items-baseline gap-1.5 rounded-sm text-fg/75 outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong"
          >
            <GithubMark className="size-3 shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]" />
            <StartTruncated text={name} className="font-semibold text-fg/90 transition-colors group-hover:text-fg" />
          </a>
        ) : name ? (
          // A verified NON-GitHub origin (owner/repo from GitLab, say) or a remote-less directory: the
          // name is prose, not a control, so no mark and nothing to hover.
          <StartTruncated text={name} title={name} className="font-semibold text-fg/90" />
        ) : (
          // Only before the first board keyframe, or on a keyframe with nothing nameable in it. A repo
          // with no git remote is NOT this case — it has a name (its directory) and shows it.
          <span className="identity-placeholder w-24" aria-hidden="true" />
        )}
      </span>
    </div>
  )
}
