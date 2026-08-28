import { useMemo, type ReactNode } from "react"
import { FileDiff, GitPullRequest, Radar, Timer } from "lucide-react"
import type { ThreadView, ThreadWatchView } from "@frizz/shared"
import { useTranscript } from "../hooks.ts"
import { pushBackgroundShellDrawer, pushSubAgentDrawer } from "../store.ts"
import { visibleChildOps } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { editedFiles } from "../lib/editedFiles.ts"
import { openLocalPath } from "../lib/local-file-links.ts"
import { ageSpan } from "../lib/activityTime.ts"
import { compactElapsedSince } from "../lib/durationLabels.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { useLocalPathBase } from "../lib/useMarkdown.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"

// THE FULLSCREEN PAGE'S OPERATIONAL RAIL — what is going on in this thread, listed beside the transcript
// (maintainer 2026-08-28): its live sub-agents, its background shells, the files its worker has edited,
// and what it is watching. Every section is data the board already carries (child ops, watches) or
// derives from the transcript this page has open anyway (edited files — see lib/editedFiles.ts), so the
// rail costs no extra request.
//
// It floats on the page background and is VERTICALLY CENTERED like the sidebar (the same
// `justify-center` column the rail's own SIDEBAR_COLUMN_CLASS uses), rather than pinned to the top — the
// maintainer's call on the mockup's top-anchored version. The liveness readouts that mockup led with
// (activity line, profile chips, context meter) were dropped on the same review: the thread header
// already says what the worker is doing, and the composer's own footer carries the profile.
//
// The sub-agent and shell rows are the SAME ChildOpRow the sidebar and the ops strip render, at rail
// density, so a child reads identically here and there — and drills into the same drawers.

function Section({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  if (count === 0) return null
  return (
    <section className="flex flex-col">
      <div className="flex items-baseline gap-1.5 px-2 pb-1">
        <span className="petite-caps text-[10px] tracking-wide text-muted/60">{label}</span>
        <span className="text-[10px] tabular-nums text-muted/40">{count}</span>
      </div>
      {children}
    </section>
  )
}

function basenameOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path
}
function dirnameOf(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts.slice(0, -1).join("/")
}

function WatchRow({ watch, now }: { watch: ThreadWatchView; now: number }) {
  const icon = watch.kind === "github" ? GitPullRequest : watch.kind === "timer" ? Timer : Radar
  const Icon = icon
  const label = watch.kind === "timer" ? watch.timer?.prompt ?? watch.target : watch.target
  // A timer's stamp is a COUNTDOWN — ageSpan reads the gap between its two instants, so handing it
  // "now" as the moment and the fire time as the clock gives the span AHEAD; the other way round it
  // clamps to "just now" for every future instant (caught on the first seeded timer, 2026-08-28).
  const fireAtMs = watch.kind === "timer" && watch.timer ? Date.parse(watch.timer.fireAt) : NaN
  const status = watch.kind === "timer" && watch.timer
    ? fireAtMs <= now ? "due now" : `fires in ${ageSpan(new Date(now).toISOString(), fireAtMs) ?? "a moment"}`
    : watch.kind === "github" && watch.github
      ? describeGithub(watch.github)
      : watch.state
  return (
    <div className="flex items-start gap-2 py-1 pl-2 pr-1.5">
      <span className="mt-[2px] flex h-[15px] w-4 shrink-0 items-center justify-center"><Icon size={12} className="text-muted" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] leading-[17px] text-fg/85" title={label}>{label}</span>
        <span className="block truncate text-[10.5px] leading-[15px] text-muted/60">{status}</span>
      </span>
    </div>
  )
}

// A watched PR's one-line reading. Field names are whatever GithubWatchStatus carries; unknown shapes
// fall back to the watch state so a schema change can never blank the row.
function describeGithub(github: NonNullable<ThreadWatchView["github"]>): string {
  const g = github as Record<string, unknown>
  const parts: string[] = []
  if (typeof g.state === "string") parts.push(g.state)
  if (typeof g.checks === "string") parts.push(`checks ${g.checks}`)
  return parts.join(" · ") || "watching"
}

// The rail's width, in px — the side pane on /full is at least this wide while nothing covers it.
export const RAIL_WIDTH = 300

export function FocusRail({ thread }: { thread: ThreadView }) {
  const now = useNowMs()
  const base = useLocalPathBase()
  // Shared with ChatView's own subscription (same key), so this adds no request and no poll.
  const transcript = useTranscript(thread.id, { poll: false })
  const files = useMemo(() => editedFiles(transcript.data?.messages ?? []), [transcript.data])
  const subs = visibleChildOps(thread.subAgents ?? [], "rail")
  const shells = visibleChildOps(thread.bgShells ?? [], "rail")
  const watches = (thread.watches ?? []).filter((w) => w.state === "armed")
  const relative = (path: string) => (base.dir && path.startsWith(`${base.dir}/`) ? path.slice(base.dir.length + 1) : path)
  const empty = subs.length + shells.length + files.length + watches.length === 0
  return (
    <aside data-focus-rail aria-label="Thread activity" className="flex h-full shrink-0 flex-col justify-center gap-5 overflow-y-auto px-3 py-6" style={{ width: RAIL_WIDTH }}>
      {empty && <div className="px-2 text-[11.5px] text-muted/50">Nothing running, edited or watched yet.</div>}
      <Section label="Sub-agents" count={subs.length}>
        {subs.map((s) => (
          <ChildOpRow
            key={s.id}
            kind="AGENT"
            label={s.label}
            state={s.state}
            density="rail"
            indent={8}
            depth={s.depth}
            startedAt={s.startedAt}
            parentSlug={thread.id}
            onOpen={() => pushSubAgentDrawer(thread.id, s.id, { label: s.label, subagentType: s.subagentType, startedAt: s.startedAt })}
            onDismiss={childOpDismisser(thread.id, s)}
            title={s.subagentType ? `[${s.subagentType}] ${s.label}` : s.label}
          />
        ))}
      </Section>
      <Section label="Background shells" count={shells.length}>
        {shells.map((sh) => (
          <ChildOpRow
            key={sh.id}
            kind="SHELL"
            label={sh.label}
            state={sh.state}
            density="rail"
            indent={8}
            startedAt={sh.startedAt}
            parentSlug={thread.id}
            onOpen={() => pushBackgroundShellDrawer(thread.id, sh.id, { label: sh.label, startedAt: sh.startedAt })}
            onDismiss={childOpDismisser(thread.id, sh)}
            title={sh.label}
          />
        ))}
      </Section>
      <Section label="Edited files" count={files.length}>
        {files.map((f) => (
          <button
            key={f.path}
            type="button"
            onClick={() => openLocalPath(f.path)}
            title={f.path}
            className="flex w-full items-start gap-2 rounded-md py-1 pl-2 pr-1.5 text-left transition-colors hover:bg-white/[0.04]"
          >
            <span className="mt-[2px] flex h-[15px] w-4 shrink-0 items-center justify-center"><FileDiff size={12} className="text-muted" /></span>
            {/* Basename FIRST, then its directory: the rail is 300px and a repo path truncated from
                the end lost exactly the part that names the file ("packages/web/src/comp…", live
                2026-08-28). The stamp is the child rows' compact clock, so the column reads as one. */}
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 font-mono-keep text-[11.5px] leading-[17px]">
              <span className="shrink-0 text-fg/85">{basenameOf(f.path)}</span>
              <span className="min-w-0 truncate text-muted/50">{dirnameOf(relative(f.path))}</span>
            </span>
            <span className="shrink-0 text-[10.5px] tabular-nums leading-[17px] text-muted/55">
              {f.edits > 1 ? `${f.edits}× · ` : ""}{f.lastEditedAt ? compactElapsedSince(f.lastEditedAt, now) ?? "" : ""}
            </span>
          </button>
        ))}
      </Section>
      <Section label="Watching" count={watches.length}>
        {watches.map((w) => <WatchRow key={w.id} watch={w} now={now} />)}
      </Section>
    </aside>
  )
}
