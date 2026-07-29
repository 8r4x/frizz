import { useMemo, useState, type ComponentType } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Check, CircleCheck, CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Github, Inbox, Loader2, MessageSquare } from "lucide-react"
import type { DispatchInput, DispatchProfileSnapshot, GithubBatchInput, GithubItem } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { Overlay } from "./NewThreadModal.tsx"
import { ProfileGridSelector } from "./ProfileGridSelector.tsx"
import { useDispatchProfile } from "../hooks/useDispatchProfile.ts"
import { dispatchProfileGroups } from "../lib/dispatchPreferences.ts"
import { OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z } from "../lib/overlaySurface.ts"
import { buildGithubBatchInput, dispatchProfileError } from "../lib/githubDispatch.ts"
import { applyRowSelection } from "../lib/rowRangeSelection.ts"

type Kind = "issues" | "prs"
type Sort = "recent" | "reactions"

// Mirrors GithubBatchInput.items `.max(20)` in shared/src/index.ts — the picker never lets the
// selection exceed the server's per-batch cap, so a dispatch can't fail the schema with a cryptic
// (client-sliced) Zod error and drop the whole batch.
const MAX_BATCH = 20

// THE GitHub picker: a wider anywhere-modal (reusing NewThreadModal's Overlay) that lists the repo's
// Issues or PRs (tabs), sortable by recency or reactions, with multi-select checkboxes and the
// ordinary model/effort selector in its bottom-left corner. "Dispatch N thread(s)" spins up one fray
// thread per checked item
// (each ISSUE an investigate/reproduce/recommend thread, each PR a review thread) via
// rpc.githubDispatchBatch — the server hydrates + templates each fresh, reusing the normal dispatch
// flow; the new sidebar rows paint via the board SSE. The trigger that opens this is auth-gated, so
// the RPCs are guaranteed serviceable when it's mounted.
export function GithubPickerModal({ onClose }: { onClose: () => void }) {
  const status = useQuery({ queryKey: ["githubStatus"], queryFn: () => rpc.githubStatus() })
  // The batch dispatches with the SAME durable new-thread profile the prompt box uses — the selector
  // below writes it, so choosing here also becomes the composer's next default (one profile, not a
  // picker-local copy that silently diverges). A Codex cache refresh can invalidate the saved pair
  // while the picker is open; the final revalidation below then fails closed rather than downgrading.
  const { resolved, codexList, loadError, saveProfile } = useDispatchProfile()

  const [kind, setKind] = useState<Kind>("issues")
  const [sort, setSort] = useState<Sort>("recent")
  // Selection is a Set<number> scoped to the CURRENT tab — switching tabs CLEARS it (simplest, and it
  // dodges the issue#N-vs-pr#N number collision a shared set would hit). Documented choice per plan §6.
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  // The shift-click anchor: the last PLAINLY clicked row's number (see lib/rowRangeSelection.ts).
  const [anchor, setAnchor] = useState<number | null>(null)

  // Server order is AUTHORITATIVE (the gh --search sort) — render items exactly as returned, never
  // re-sort client-side. The query re-keys on {kind, sort}, so a tab/sort flip refetches.
  const list = useQuery({ queryKey: ["githubList", kind, sort], queryFn: () => rpc.githubList({ kind, sort }) })
  const items = list.data?.items ?? []

  const dispatch = useMutation({
    mutationFn: (input: GithubBatchInput) => rpc.githubDispatchBatch(input),
    onMutate: (input) => showToast(`Starting ${input.items.length} thread${input.items.length === 1 ? "" : "s"}…`, { spinner: true, sticky: true }),
    onSuccess: (res) => {
      const ok = res.dispatched.length
      const failed = res.failed.length
      showToast(`Started ${ok} thread${ok === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}`)
      onClose()
    },
    onError: (e) => showToast(`Dispatch failed: ${(e as Error).message.slice(0, 80)}`),
  })

  function switchKind(k: Kind) {
    if (k === kind) return
    setKind(k)
    setSelected(new Set())
    setAnchor(null)
  }
  function switchSort(s: Sort) {
    if (s === sort) return
    setSort(s)
    // Clear on sort-switch, same as tab-switch: a selection made under one order can scroll out of the
    // other's (limit-truncated) window and then dispatch INVISIBLY, with the count exceeding the
    // visible checks. Clearing keeps "what's checked is what dispatches" honest.
    setSelected(new Set())
    setAnchor(null)
  }
  // One entry point for every row activation (click, Enter, Space). Shift paints the whole
  // anchor→row range with the anchor's state; a plain click toggles and re-anchors. The cap is the
  // server's per-batch max (MAX_BATCH), so a range that overruns it truncates VISIBLY with a toast
  // rather than silently dropping rows the human watched themselves select.
  function activate(n: number, shiftKey: boolean) {
    const result = applyRowSelection({
      keys: items.map((it) => it.number),
      key: n,
      shiftKey,
      anchor,
      selected,
      max: MAX_BATCH,
    })
    setSelected(result.selected)
    setAnchor(result.anchor)
    if (result.capped) showToast(`${MAX_BATCH} max per batch — selection capped`)
  }

  const nameWithOwner = status.data?.nameWithOwner ?? "this repo"
  const n = selected.size
  // Stable identity: ProfileGridSelector memoizes off `groups`, and this modal re-renders on every
  // row toggle.
  const profileGroups = useMemo(() => dispatchProfileGroups(codexList), [codexList])
  const profile: DispatchProfileSnapshot | undefined = resolved
    ? { backend: resolved.backend, model: resolved.model, effort: resolved.effort as DispatchProfileSnapshot["effort"] }
    : undefined
  // Two levels, deliberately: `profileError` is a real fault worth a red line under the selector (a
  // saved model/effort the catalogue no longer offers, or a catalogue that failed to load), while
  // `dispatchBlocked` also covers the merely-not-loaded-yet case — the selector's own "Profile
  // loading…" placeholder already says that, so it must not paint red.
  const profileError = profile
    ? dispatchProfileError(profile, codexList)
    : loadError
      ? "Could not load the model catalogue — reopen once it loads"
      : undefined
  const dispatchBlocked = profileError ?? (profile ? undefined : "Loading the model catalogue…")

  function startDispatch() {
    if (!profile || dispatchBlocked) {
      showToast(dispatchBlocked ?? "Choose a model and reasoning level")
      return
    }
    dispatch.mutate(buildGithubBatchInput(
      profile,
      [...selected].map((number) => ({ kind: kind === "issues" ? "issue" : "pr", number })),
    ))
  }

  return (
    <Overlay onClose={onClose}>
      <div
        className="flex max-h-[85vh] w-[720px] max-w-[90vw] flex-col rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-black/50"
        onKeyDownCapture={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        {/* Header */}
        <h2 className="mb-4 flex items-center gap-2 text-[14px] font-medium">
          <Github size={15} className="text-muted" />
          <span>Investigate this issue and make recommendations</span>
          <span className="text-muted/40">—</span>
          <span className="font-mono-keep text-[12.5px] text-muted">{nameWithOwner}</span>
        </h2>

        {/* Controls: tabs (Issues | PRs) left, sort (Recent | Reactions) right */}
        <div className="mb-3 flex items-center justify-between gap-3">
          <Segmented
            value={kind}
            onChange={(v) => switchKind(v)}
            options={[
              { value: "issues", label: "Issues" },
              { value: "prs", label: "PRs" },
            ]}
          />
          <div className="flex items-center gap-2">
            <span className="petite-caps text-[11px] text-muted/70">Sort</span>
            <Segmented
              value={sort}
              onChange={switchSort}
              options={[
                { value: "recent", label: "Recent" },
                { value: "reactions", label: "Reactions" },
              ]}
            />
          </div>
        </div>

        {/* List */}
        <div className="min-h-[240px] flex-1 overflow-y-auto rounded-lg border border-border/70 bg-bg/40">
          {list.isLoading ? (
            <ListSkeleton />
          ) : list.isError ? (
            <Centered>
              <span className="text-[12.5px] text-muted/80">Couldn't load {kind === "issues" ? "issues" : "pull requests"}.</span>
              <span className="max-w-[80%] text-center text-[11px] text-muted/45">{(list.error as Error).message.slice(0, 140)}</span>
            </Centered>
          ) : items.length === 0 ? (
            <Centered>
              <Inbox size={28} strokeWidth={1.25} className="text-muted/30" />
              <span className="text-[12.5px] text-muted/60">No open {kind === "issues" ? "issues" : "pull requests"}</span>
            </Centered>
          ) : (
            items.map((it) => (
              <Row key={it.number} item={it} checked={selected.has(it.number)} onActivate={(shiftKey) => activate(it.number, shiftKey)} />
            ))
          )}
        </div>

        {/* Footer: the ordinary model/effort selector (bottom-left) + the batch-dispatch button. The
            selector is the SAME control the prompt box carries and writes the same durable
            preference, so the profile every dispatched thread gets is editable right here. Opens
            UPWARD (side="top") — the footer sits on the modal's bottom edge. */}
        <div className="mt-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <ProfileGridSelector
              groups={profileGroups}
              value={resolved ? { provider: resolved.backend, model: resolved.model, effort: resolved.effort } : undefined}
              onValueChange={(selection) => saveProfile({
                field: "profile",
                backend: selection.provider as DispatchProfileSnapshot["backend"],
                model: selection.model,
                effort: selection.effort as DispatchInput["effort"] & string,
              })}
              placeholder={loadError ? "Profile unavailable" : "Profile loading…"}
              ariaLabel="Model and effort"
              title={dispatchBlocked ?? "Model and reasoning effort for every thread this batch starts"}
              disabled={!resolved}
              side="top"
              // The picker's Overlay is z-[200]; the default z-[110] portal would paint the menu
              // beneath its frosted backdrop.
              menuZClass={OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z}
              className="max-w-[min(21rem,60vw)]"
            />
            {profileError && <p className="mt-1 max-w-[430px] text-[10.5px] text-red-400">{profileError}</p>}
          </div>
          <div className="flex items-center gap-3">
            {n >= MAX_BATCH && <span className="petite-caps text-[11px] text-muted/60">{MAX_BATCH} max per batch</span>}
            <button
              disabled={n === 0 || dispatch.isPending || !!dispatchBlocked}
              onClick={startDispatch}
              onMouseDown={(e) => e.preventDefault()}
              className="flex items-center gap-2 rounded-md bg-fg px-3.5 py-1.5 text-[12.5px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
            >
              {dispatch.isPending && <Loader2 size={13} className="animate-spin" />}
              {n === 1 ? "Start investigation" : "Start investigations"}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}

// A binary/ternary segmented control in the app's rounded-rect / panel-2 idiom — the selected pill
// lifts to `elevated` with the fg text; the rest read muted until hover. Used for the tabs and sort.
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-panel-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          onMouseDown={(e) => e.preventDefault()}
          className={`rounded-md px-3 py-1 text-[12px] font-medium outline-none transition-colors ${
            value === o.value ? "bg-elevated text-fg shadow-sm shadow-black/20" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// GitHub's own issue/PR state glyph — green open-dot for an open issue, purple merge for a merged PR,
// etc. Mirrors github.com so the row reads the same at a glance. Defaults to the open glyph if state
// is absent (the picker lists OPEN items, so that's the common case).
function StateIcon({ item }: { item: GithubItem }) {
  const st = (item.state ?? "OPEN").toUpperCase()
  if (item.kind === "pr") {
    if (st === "MERGED") return <GitMerge size={15} className="shrink-0 text-purple-400" />
    if (st === "CLOSED") return <GitPullRequestClosed size={15} className="shrink-0 text-red-400" />
    if (item.isDraft) return <GitPullRequestDraft size={15} className="shrink-0 text-muted/70" />
    return <GitPullRequest size={15} className="shrink-0 text-emerald-500" />
  }
  if (st === "CLOSED") return <CircleCheck size={15} className="shrink-0 text-purple-400" />
  return <CircleDot size={15} className="shrink-0 text-emerald-500" />
}

// Compact "opened <ago>" relative time (github-ish: 8h ago, 3d ago). Empty when the timestamp is absent.
function relTime(iso?: string): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, (Date.now() - t) / 1000)
  const mn = s / 60
  const h = mn / 60
  const d = h / 24
  if (s < 45) return "just now"
  if (mn < 60) return `${Math.round(mn)}m ago`
  if (h < 24) return `${Math.round(h)}h ago`
  if (d < 30) return `${Math.round(d)}d ago`
  if (d < 365) return `${Math.round(d / 30)}mo ago`
  return `${Math.round(d / 365)}y ago`
}

// A github-style label chip: the label's own color as outline + text on a faint tint. Truncates long names.
function LabelChip({ name, color }: { name: string; color: string }) {
  const hex = /^[0-9a-fA-F]{6}$/.test(color) ? `#${color}` : undefined
  return (
    <span
      className="max-w-[130px] shrink-0 truncate rounded-full border px-1.5 py-px text-[9.5px] leading-[13px]"
      style={hex ? { borderColor: `${hex}59`, color: hex, backgroundColor: `${hex}14` } : undefined}
      title={name}
    >
      {name}
    </span>
  )
}

// One issue/PR row, mirroring github.com: the select checkbox, the state glyph, the title (a LINK OUT)
// with its label chips, a metadata line "#N · author opened <ago>", and the linked-PR / comment /
// reaction badges on the right. Clicking the row toggles selection, SHIFT-clicking extends from the last clicked row
// through every row in between; clicking the title or the #number opens GitHub.
function Row({ item, checked, onActivate }: { item: GithubItem; checked: boolean; onActivate: (shiftKey: boolean) => void }) {
  const opened = relTime(item.createdAt)
  const meta = [item.author, opened ? `opened ${opened}` : ""].filter(Boolean).join(" ")
  return (
    <div
      role="button"
      tabIndex={0}
      data-row-number={item.number}
      aria-pressed={checked}
      onClick={(e) => onActivate(e.shiftKey)}
      // Shift+click natively drags a text selection across the rows it spans; the range select is the
      // only meaning shift has here, so suppress the browser's before it paints over the list.
      onMouseDown={(e) => { if (e.shiftKey) e.preventDefault() }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onActivate(e.shiftKey)
        }
      }}
      className="group flex w-full cursor-pointer items-start gap-2.5 border-b border-border/40 px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-white/[0.03]"
    >
      <span className="mt-px shrink-0">
        <Checkbox checked={checked} />
      </span>
      <span className="mt-px">
        <StateIcon item={item} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            title={item.title}
            className="min-w-0 truncate text-[13px] font-medium text-fg/90 hover:underline"
          >
            {item.title}
          </a>
          {item.labels.slice(0, 4).map((l) => (
            <LabelChip key={l.name} name={l.name} color={l.color} />
          ))}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-muted/55">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 tabular-nums hover:text-muted hover:underline"
          >
            #{item.number}
          </a>
          {meta ? <span className="truncate">· {meta}</span> : null}
        </span>
      </span>
      <span className="mt-px flex shrink-0 items-center gap-2.5 text-[11.5px] text-muted/70">
        {item.linkedPr ? <LinkedPrBadge pr={item.linkedPr} /> : null}
        {item.comments ? <Badge icon={MessageSquare} n={item.comments} label="comments" /> : null}
        {item.reactions ? <Badge emoji="👍" n={item.reactions} label="reactions" /> : null}
      </span>
    </div>
  )
}

// The shared rounded-rect checkbox — same 15px rounded-[4px] box family as Sidebar's StatusBox. Checked
// fills with `fg` (the app's primary-action color, e.g. "Send answers") + a dark check; unchecked is a
// quiet muted outline that brightens on row hover. Deliberately NOT the accent — yellow is reserved for
// the "needs you" rail signal, not selection.
function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={`inline-flex h-[15px] w-[15px] items-center justify-center rounded-[4px] border transition-colors ${
        checked ? "border-fg bg-fg" : "border-muted/45 group-hover:border-muted/80"
      }`}
    >
      {checked && <Check size={11} strokeWidth={3} className="text-bg" />}
    </span>
  )
}

// The "someone already opened a PR for this" badge — GitHub's own linked-pull-request signal, painted
// with the same glyph + color family as StateIcon (emerald open, purple merged, muted draft). It sits
// FIRST in the right-hand cluster because it is the one thing on the row that changes the decision to
// dispatch: an issue with a PR in flight rarely needs a second investigation. The number keeps its `#`
// — every other badge in this cluster is a COUNT, and a bare "413" beside them reads as one.
// Links straight to the PR (stopPropagation, so opening it doesn't also toggle the row).
function LinkedPrBadge({ pr }: { pr: NonNullable<GithubItem["linkedPr"]> }) {
  const merged = pr.state.toUpperCase() === "MERGED"
  const Icon = merged ? GitMerge : pr.isDraft ? GitPullRequestDraft : GitPullRequest
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      title={merged ? `Closed by PR #${pr.number}` : pr.isDraft ? `Draft PR #${pr.number} open` : `PR #${pr.number} open`}
      className={`inline-flex items-center gap-1 tabular-nums hover:underline ${merged ? "text-purple-400" : pr.isDraft ? "text-muted/70" : "text-emerald-500"}`}
    >
      <Icon size={12} strokeWidth={2} />
      #{pr.number}
    </a>
  )
}

// A count badge (comments / reactions). Comments use a monochrome message glyph (mirrors github.com);
// reactions use the literal 👍 emoji (maintainer 2026-07-10 — not the old triangle). `title` names it.
function Badge({
  icon: Icon,
  emoji,
  n,
  label,
}: {
  icon?: ComponentType<{ size?: number; className?: string; strokeWidth?: number }>
  emoji?: string
  n: number
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" title={`${n} ${label}`}>
      {emoji ? <span aria-hidden className="text-[11px] leading-none">{emoji}</span> : Icon ? <Icon size={12} strokeWidth={2} /> : null}
      {n}
    </span>
  )
}

function ListSkeleton() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-border/40 px-3 py-2.5 last:border-b-0">
          <span className="h-[15px] w-[15px] shrink-0 rounded-[4px] bg-muted/20" />
          <span className="h-3 w-8 shrink-0 rounded bg-muted/20" />
          <span className="h-3 flex-1 rounded bg-muted/15" style={{ maxWidth: `${55 + ((i * 7) % 35)}%` }} />
        </div>
      ))}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1.5">{children}</div>
}
