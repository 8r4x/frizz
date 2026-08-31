import { FileDiff } from "lucide-react"
import type { EditedFile, ThreadView } from "@frizz/shared"
import { useTranscript } from "../hooks.ts"
import { openLocalPath } from "../lib/local-file-links.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { AgentRow, BgShellRow, GithubWatchRow, ON_CAP, TimerRow, WaitGrid, WaitRow, liveAgents } from "./AwaitingBackgroundCard.tsx"

// THE FULLSCREEN PAGE'S OPERATIONAL RAIL — what is going on in this thread, listed beside the transcript
// (maintainer 2026-08-28): its live sub-agents, its running background shells, the pull requests and
// timers it is watching, and the files its worker has edited.
//
// IT IS THE AWAITING CARD'S TABLE, one surface over. Every row here is the card's own row component —
// AgentRow, BgShellRow, GithubWatchRow, TimerRow, the same WaitRow for a file — in the card's own
// WaitGrid, so a watched PR reads here exactly as it reads on the card: the same checks glyph (a
// spinner while CI runs, green/red when it settles), the same count line, the same link to GitHub.
// The first cut of this rail drew its own rows with its own icons and threw the CI state away, and
// the maintainer met a PR he could not click beside a timer wearing a different clock (2026-08-28:
// "Please just spend a bare minimum amount of time trying to understand visual consistency").
//
// The one row the card does not have is a FILE: the same shape (mark · name · status · chevron),
// opening the file in the page's viewer. The list arrives on the transcript page, derived by the
// server over the whole projection — the latest window the page renders rarely holds an Edit at all,
// because a worker edits mid-effort and verifies at the end (server/edited-files.ts).
//
// It floats on the page background and is VERTICALLY CENTERED like the sidebar, rather than pinned to
// the top — the maintainer's call on the mockup's top-anchored version. The liveness readouts that
// mockup led with (activity line, profile chips, context meter) were dropped on the same review: the
// thread header already says what the worker is doing, and the composer's own footer carries the
// profile.

// The rail's width, in px — the side pane on /full is exactly this wide while nothing covers it. 340
// rather than the mockup's 300: the card's rows were fitted at a 368px card, and at 300 a PR row
// truncated to "colinhacks/zod#…" — the one part of the ref that names the PR (2026-08-28).
export const RAIL_WIDTH = 340

function basenameOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path
}

function FileRow({ file }: { file: EditedFile }) {
  // The status is the file's DIFFSTAT, GitHub-green and GitHub-red — the edit count and the
  // last-edited clock both came off on review (maintainer 2026-08-31: "hide the 2×…", the age
  // "seems useless to me"). A zero side stays quiet; a file with no counted lines (an
  // unreconstructed apply_patch) carries no status at all rather than a fabricated 0.
  return (
    <WaitRow
      testKind="file"
      testId={file.path}
      mark={<FileDiff size={12} className={`${ON_CAP} text-muted/60`} />}
      // The basename is the name; the full path is the tooltip. A 340px rail truncates from the end,
      // and a repo path truncated from the end lost exactly the part that names the file.
      name={basenameOf(file.path)}
      onOpen={() => openLocalPath(file.path)}
      title={file.path}
      status={
        <>
          {(file.added ?? 0) > 0 && <span className="text-emerald-500">+{file.added}</span>}
          {(file.added ?? 0) > 0 && (file.removed ?? 0) > 0 && " "}
          {(file.removed ?? 0) > 0 && <span className="text-red-400">−{file.removed}</span>}
        </>
      }
    />
  )
}

export function FocusRail({ thread }: { thread: ThreadView }) {
  const now = useNowMs()
  // Shared with ChatView's own subscription (same key), so this adds no request and no poll.
  const transcript = useTranscript(thread.id, { poll: false })
  const files = transcript.data?.editedFiles ?? []
  const agents = liveAgents(thread)
  const shells = (thread.bgShells ?? []).filter((s) => s.state === "running")
  const prs = (thread.watches ?? []).filter((w) => w.kind === "github" && w.state === "armed")
  const timers = (thread.watches ?? []).filter((w) => w.kind === "timer" && w.state === "armed")
  // The card's order — most-alive first — then the files, which are not a wait at all.
  const groups = [
    { head: "Sub-agents", rows: agents.map((a) => <AgentRow key={a.id ?? a.label} agent={a} slug={thread.id} now={now} />) },
    { head: "Background shells", rows: shells.map((s) => <BgShellRow key={s.id ?? s.label} shell={s} slug={thread.id} now={now} />) },
    { head: "Pull requests", rows: prs.map((w) => <GithubWatchRow key={w.id} watch={w} />) },
    { head: "Timers", rows: timers.map((w) => <TimerRow key={w.id} watch={w} now={now} />) },
    { head: "Edited files", rows: files.map((f) => <FileRow key={f.path} file={f} />) },
  ].filter((g) => g.rows.length > 0)
  return (
    <aside data-focus-rail aria-label="Thread activity" className="flex h-full shrink-0 flex-col justify-center overflow-y-auto px-4 py-6" style={{ width: RAIL_WIDTH }}>
      {groups.length === 0
        ? <div className="text-[11.5px] text-muted/50">Nothing running, watched or edited yet.</div>
        : <WaitGrid groups={groups} divider={false} />}
    </aside>
  )
}
