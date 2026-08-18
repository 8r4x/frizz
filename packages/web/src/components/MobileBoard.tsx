import { useEffect, useMemo, useState } from "react"
import { useSnapshot } from "valtio"
import { Check, ChevronLeft, ChevronRight, Ellipsis, FileText, Hourglass, Plus, Settings as SettingsIcon } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { openThread, pushPlanDrawer, pushSubAgentDrawer, store, type ConnectionState } from "../store.ts"
import { asThreads, useBoard } from "../hooks.ts"
import { prefs } from "../lib/prefs.ts"
import {
  displayTitle,
  isActivelyRunning,
  lastActiveLabelAt,
  needsAction,
  sectionThreads,
  sessionIndicatorKind,
  type SessionIndicatorKind,
} from "../groups.ts"
import { ageSpan } from "../lib/activityTime.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { visibleChildOps } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"
import { ProviderMark } from "./ProviderMark.tsx"
import { hintGloss } from "./Sidebar.tsx"
import { useOptimisticallySteered } from "../lib/steering.ts"
import { useOptimisticallyArchived } from "../lib/optimisticArchive.ts"
import { projectIdentity } from "./Sidebar.tsx"
import { QuotaChips } from "./QuotaBar.tsx"
import type { PlanView } from "@frizz/shared"

// THE PHONE'S BOARD — a nav bar, ONE list, a tab bar and a floating +.
//
// It is not a narrower desktop board. The desktop's three standing surfaces (project rail, thread rail,
// workpane) and its stack of right-hand drawers assume a viewport that can hold more than one thing at
// once; 390pt cannot, so the phone gets a two-level drill-down instead: a list of threads, and a thread.
//
// WHAT IS THE SAME, deliberately: the data. Every reading on a row comes from the same helpers the rail
// uses — `sectionThreads` for the bands, `sessionIndicatorKind` for the mark, `lastActiveLabelAt` for
// the rest time, `visibleChildOps` for the ⤷ lines. A phone that derived its own answers would drift
// from the desktop the first time one of those rules changed.
//
// WHAT IS DIFFERENT, and each of these is the maintainer's call from the mockup review (2026-08-17):
//
//   · RESTED AND ACTIVE ARE ONE BAND, called QUEUE. "Something is active until it's marked done." On a
//     screen showing eight rows, splitting them costs a tab switch to see work you already own — and
//     `sectionThreads` already returns the two together, so the merge is the absence of a split rather
//     than a new rule.
//   · A RUNNING ROW WEARS A STATIC PLAY MARK, not the rail's travelling spinner. With running and rested
//     rows as neighbours the difference has to survive a glance at arm's length, and a 1px arc crawling
//     round an 18px box does not. The row still moves — its activity line and its live children do.
//   · NOTHING IN THE CHROME ANIMATES. A tab bar is permanent, and permanent motion in the corner of the
//     eye is noise.
//   · NO COMPOSER ON THIS SCREEN. Starting a thread is the +; the reply box belongs to a thread.
//   · AN ASK IS MARKED BY THE ACCENT "?" AND NOTHING ELSE — no card, no border, no tint.

type Tab = "queue" | "held" | "done"

const TAB_ICON = 21
/** The rail's checkbox geometry (BoxSpinner's STATUS_BOX) as a ratio, so a mark keeps its SHAPE at any size. */
const BOX_RADIUS_RATIO = 4 / 15

function StatusBox({ children, tone = "border-muted/45", size = 18 }: { children?: React.ReactNode; tone?: string; size?: number }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center border ${tone}`}
      style={{ width: size, height: size, borderRadius: size * BOX_RADIUS_RATIO }}
    >
      {children}
    </span>
  )
}

/** ▶ — in flight. Static, and optically centred: a triangle centred on its BOX always reads left-heavy. */
function PlayMark({ size = 18 }: { size?: number }) {
  return (
    <StatusBox size={size}>
      <svg width={Math.round(size * 0.52)} height={Math.round(size * 0.52)} viewBox="0 0 10 10" aria-hidden className="translate-x-[8%] text-muted/85">
        <path d="M2.5 1.4 8.2 5 2.5 8.6Z" fill="currentColor" />
      </svg>
    </StatusBox>
  )
}

/** ? — awaiting you, and the only mark on the board that spends the accent. */
function AskMark({ size = 18 }: { size?: number }) {
  return (
    <StatusBox size={size} tone="border-accent/90">
      <span className="font-sans font-bold leading-none text-accent" style={{ fontSize: (size * 10) / 15 }}>?</span>
    </StatusBox>
  )
}

function DoneMark({ size = 18 }: { size?: number }) {
  return (
    <StatusBox size={size} tone="border-muted/40">
      <Check size={Math.round((size * 10) / 15)} strokeWidth={3} className="text-muted/85" />
    </StatusBox>
  )
}

function HeldMark({ size = 18 }: { size?: number }) {
  return (
    <StatusBox size={size}>
      <Hourglass size={Math.round((size * 10) / 15)} className="text-muted/75" />
    </StatusBox>
  )
}

/** One kind → one mark. The kinds are the rail's; only the drawing is the phone's. */
function ThreadMark({ kind }: { kind: SessionIndicatorKind }) {
  if (kind === "needs-input") return <AskMark />
  if (kind === "stalled") {
    return (
      <StatusBox tone="border-accent/90">
        <span className="font-sans text-[12px] font-bold leading-none text-accent">!</span>
      </StatusBox>
    )
  }
  if (kind === "working" || kind === "background") return <PlayMark />
  if (kind === "held") return <HeldMark />
  if (kind === "done" || kind === "archived") return <DoneMark />
  return <StatusBox />
}

/**
 * One thread, full width.
 *
 * No card: a card spends side margins and then its own padding on every row, which on a 390pt screen is
 * 64pt of a 358pt measure. The hairline is INSET to the text column (16 + 18 + 12 = 46) so the glyph
 * column reads as a gutter rather than as the first cell of a table.
 */
function MobileThreadRow({ t, last }: { t: ThreadView; last?: boolean }) {
  const now = useNowMs()
  const kind = sessionIndicatorKind(t)
  const running = isActivelyRunning(t)
  const at = lastActiveLabelAt(t)
  // A rest time dates a HANDOFF, so a row that is still going has nothing to date — the rail's own rule.
  const age = running ? null : ageSpan(at, now)
  const gloss = t.lastFence?.kind === "awaiting" ? hintGloss(t.lastFence.hints) : null
  const subs = visibleChildOps(t.subAgents ?? [], "rail")
  return (
    <div className={kind === "held" ? "opacity-60" : undefined}>
      <button
        data-mobile-thread-row={t.id}
        onClick={() => openThread(t.id)}
        className="flex w-full items-start gap-3 px-4 pb-2.5 pt-2.5 text-left active:bg-white/[0.04]"
      >
        <span className="flex h-[21px] shrink-0 items-center justify-center">
          <ThreadMark kind={kind} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="flex min-w-0 items-baseline gap-3">
            <span className="min-w-0 flex-1 text-[15px] font-medium leading-[21px] tracking-[-0.01em] text-fg">
              {displayTitle(t)}
              <ProviderMark backend={t.backend} className="ml-1.5" />
            </span>
            {age ? (
              <span className="shrink-0 text-[11.5px] leading-[21px] tabular-nums text-muted/60">{age}</span>
            ) : null}
          </span>
          {gloss ? <span className="min-w-0 truncate text-[13px] leading-[18px] text-muted">{gloss}</span> : null}
          {t.activity ? (
            <span className="min-w-0 truncate text-[13px] leading-[18px] text-muted/85">{t.activity}</span>
          ) : null}
        </span>
      </button>
      {subs.length > 0 ? (
        <div className="flex flex-col pb-1">
          {subs.map((s) => (
            <ChildOpRow
              key={s.id}
              kind="AGENT"
              label={s.label}
              state={s.state}
              density="rail"
              depth={s.depth}
              startedAt={s.startedAt}
              parentSlug={t.id}
              onOpen={() => pushSubAgentDrawer(t.id, s.id, { label: s.label, subagentType: s.subagentType, startedAt: s.startedAt })}
              onDismiss={childOpDismisser(t.id, s)}
              title={s.subagentType ? `[${s.subagentType}] ${s.label}` : s.label}
            />
          ))}
        </div>
      ) : null}
      {last ? null : <div className="ml-[46px] h-px bg-border/70" />}
    </div>
  )
}

function EmptyBand({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-10 pb-24 text-center">
      <p className="m-0 text-[15px] text-muted">{label}</p>
    </div>
  )
}

function TabButton({
  active,
  label,
  count,
  asks,
  icon,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  asks?: boolean
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      data-mobile-tab={label.toLowerCase()}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className="flex flex-1 flex-col items-center justify-center gap-[3px] pt-[3px]"
    >
      <span className={`relative ${active ? "opacity-100" : "opacity-55"}`}>
        {icon}
        {count > 0 ? (
          // The badge is the ASK count in accent when there is one, and the band count in muted
          // otherwise. Yellow means "this many want you" here exactly as it does everywhere else.
          <span
            className={`absolute -right-[11px] -top-[7px] flex h-[16px] min-w-[16px] items-center justify-center rounded-full border-[1.5px] border-bg px-[3.5px] text-[10px] font-semibold tabular-nums ${
              asks ? "bg-accent text-bg" : "bg-elevated text-muted"
            }`}
          >
            {count}
          </span>
        ) : null}
      </span>
      <span className={`text-[10px] leading-[12px] tracking-[-0.005em] ${active ? "text-fg" : "text-muted/70"}`}>
        {label}
      </span>
    </button>
  )
}


/**
 * WHAT THE ⋯ CARRIES, and why it is a sheet rather than a link straight to Settings.
 *
 * Two things fell off the phone when the desktop status bar did: the PLANS band (a plan is only
 * reachable from the rail, so on a phone it was reachable from nowhere at all) and the account-global
 * readings — connection, and the two quota chips. Neither belongs in a 390pt nav bar and both have to
 * live somewhere, so the ⋯ is that somewhere.
 */
const CONNECTION_WORD = {
  open: { cls: "bg-live", word: "connected" },
  connecting: { cls: "bg-accent", word: "connecting…" },
  closed: { cls: "bg-red-500", word: "disconnected" },
} as const

function MoreSheet({ plans, connection, onClose }: { plans: readonly PlanView[]; connection: ConnectionState; onClose: () => void }) {
  const conn = CONNECTION_WORD[connection]
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div data-mobile-more-sheet className="fixed inset-0 z-[70] flex flex-col justify-end">
      <button aria-label="Close" onClick={onClose} className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`} />
      <div
        className={`relative flex max-h-[80%] flex-col overflow-hidden rounded-t-[14px] border-t border-border-strong bg-panel pb-[calc(24px+env(safe-area-inset-bottom))] shadow-[0_-20px_60px_-10px_rgba(0,0,0,0.8)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
          shown ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="mx-auto mt-[6px] h-[5px] w-[36px] shrink-0 rounded-full bg-muted/35" />
        <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-3">
          <span className="flex items-baseline gap-2 text-[13px] text-muted">
            <span className={`inline-block size-[7px] translate-y-[-1px] rounded-full ${conn.cls}`} />
            {conn.word}
          </span>
          <QuotaChips />
        </div>
        <div className="min-h-0 overflow-y-auto">
          <div className="border-y border-border/70 bg-panel/60">
            <button
              data-mobile-settings-row
              onClick={() => {
                store.showSettings = true
                onClose()
              }}
              className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left active:bg-white/[0.04]"
            >
              <SettingsIcon size={16} className="shrink-0 text-muted/70" />
              <span className="min-w-0 flex-1 text-[16px] leading-[21px] text-fg">Settings</span>
              <ChevronRight size={17} className="shrink-0 text-muted/45" />
            </button>
          </div>
          {plans.length > 0 ? (
            <>
              <div className="px-4 pb-1.5 pt-4 text-[13px] font-medium text-muted">Plans</div>
              <div className="border-y border-border/70 bg-panel/60">
                {plans.map((plan, i) => (
                  <div key={plan.path}>
                    <button
                      data-mobile-plan-row
                      onClick={() => {
                        pushPlanDrawer(plan.path, plan.title)
                        onClose()
                      }}
                      className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left active:bg-white/[0.04]"
                    >
                      <FileText size={16} className="shrink-0 text-muted/70" />
                      <span className="min-w-0 flex-1 truncate text-[16px] leading-[21px] text-fg">{plan.title}</span>
                      {plan.threadIds?.length ? (
                        <span className="shrink-0 tabular-nums text-[12.5px] text-muted/55">{plan.threadIds.length}</span>
                      ) : null}
                      <ChevronRight size={17} className="shrink-0 text-muted/45" />
                    </button>
                    {i === plans.length - 1 ? null : <div className="ml-[52px] h-px bg-border/70" />}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// The restart overlay, the drawer stack and the modals stay the App's: they are identical on both
// shells and mounting them twice would stack two of everything.
export function MobileBoard() {
  const snap = useSnapshot(store)
  const board = useBoard()
  const [tab, setTab] = useState<Tab>("queue")
  const [moreOpen, setMoreOpen] = useState(false)
  // Both optimistic overlays, exactly as the rail composes them: a just-sent steer pulls a row into the
  // running reading and a just-clicked Mark-as-done drops it into Done, each folded in BEFORE any band
  // is derived — so a row's appearance and its band always land together.
  const all = useOptimisticallyArchived(useOptimisticallySteered(asThreads(board?.threads ?? [])))
  const queueOrder = useSnapshot(prefs).queueOrder
  const sections = useMemo(() => sectionThreads(all, queueOrder), [all, queueOrder])

  // THE QUEUE IS `sections.active` UNSPLIT — the desktop calls `partitionActive` on it to draw its
  // Rested/Active rule; the phone does not, which is the whole of the merge.
  //
  // Ordered asks first. The rail orders the cue by rest time, which is right for a column you scan
  // beside a workpane; on the one screen a phone has, "what needs me" earns the top. Both groups keep
  // their queue order within themselves, so nothing else about the ordering changes.
  const queue = useMemo(() => {
    const asks = sections.active.filter(needsAction)
    const rest = sections.active.filter((t) => !needsAction(t))
    return [...asks, ...rest]
  }, [sections.active])
  const askCount = queue.filter(needsAction).length

  const rows = tab === "queue" ? queue : tab === "held" ? sections.held : sections.inactive
  const identity = projectIdentity(board)

  return (
    <div data-mobile-board className="relative min-h-dvh bg-bg">
      {/* The nav bar: back to every project, this project's identity, and the board's own actions. No
          switcher — the way to another project is the way you came in. */}
      {/* `env(safe-area-inset-*)` on BOTH bars: on a notched phone the status bar sits over the top of
          the viewport and the home indicator over the bottom, and neither inset exists in a headless
          shot — so this is a defect no screenshot here can show and every real device would. */}
      <div className="fixed inset-x-0 top-0 z-30 border-b border-border/70 bg-bg/85 pt-[env(safe-area-inset-top)] backdrop-blur-xl backdrop-saturate-150">
        <div className="flex h-[48px] items-center gap-1 px-2">
          {/* A real navigation to the grid, not a router link: `/` is a different project binding (its
              own socket, board store and API base), which is exactly why the desktop grid is reached by
              a document load too. */}
          <a href="/" className="-ml-1 flex h-[44px] items-center gap-0.5 pl-1 pr-2 text-[16px] text-fg/85">
            <ChevronLeft size={20} strokeWidth={2.2} />
            <span className="truncate">Projects</span>
          </a>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-[48px] items-center justify-center px-[86px]">
            <span className="truncate font-mono-keep text-[15px] font-semibold tracking-[-0.01em] text-fg">
              {identity.state === "verified" ? identity.label : "Frizz"}
            </span>
          </div>
          <button
            aria-label="Board actions"
            data-mobile-more
            onClick={() => setMoreOpen(true)}
            className="ml-auto flex size-[44px] items-center justify-center rounded-full text-fg/85 active:bg-white/[0.06]"
          >
            <Ellipsis size={20} />
          </button>
        </div>
      </div>

      {/* The list. 48pt of nav bar above, 83pt of tab bar + home indicator below. */}
      <div className="flex min-h-dvh flex-col pb-[calc(83px+env(safe-area-inset-bottom))] pt-[calc(48px+env(safe-area-inset-top))]">
        {rows.length === 0 ? (
          <EmptyBand
            label={
              !board
                ? "Loading…"
                : tab === "queue"
                  ? "Nothing in the queue. Tap + to start a thread."
                  : tab === "held"
                    ? "Nothing held."
                    : "Nothing finished yet."
            }
          />
        ) : (
          <div className="border-b border-border/70 bg-panel/60">
            {rows.map((t, i) => (
              <MobileThreadRow key={t.id} t={t} last={i === rows.length - 1} />
            ))}
          </div>
        )}
      </div>

      <button
        aria-label="New thread"
        onClick={() => (store.showNewThread = true)}
        // NOT the accent: a permanent yellow circle would out-shout every ask in the list under it, and
        // the accent means exactly one thing in this product. This is the app's own primary-button fill.
        className="fixed bottom-[calc(65px+env(safe-area-inset-bottom))] right-4 z-30 flex size-[56px] items-center justify-center rounded-full bg-fg text-bg shadow-lg shadow-black/50 active:opacity-85"
      >
        <Plus size={24} strokeWidth={2.2} />
      </button>

      {moreOpen ? (
        <MoreSheet plans={(board?.plans ?? []) as PlanView[]} connection={snap.connection} onClose={() => setMoreOpen(false)} />
      ) : null}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border/70 bg-bg/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl backdrop-saturate-150">
        <div className="flex h-[49px] items-stretch">
          <TabButton
            active={tab === "queue"}
            label="Queue"
            count={askCount > 0 ? askCount : queue.length}
            asks={askCount > 0}
            onClick={() => setTab("queue")}
            icon={<PlayMark size={TAB_ICON} />}
          />
          <TabButton
            active={tab === "held"}
            label="Held"
            count={sections.held.length}
            onClick={() => setTab("held")}
            icon={<HeldMark size={TAB_ICON} />}
          />
          <TabButton
            active={tab === "done"}
            label="Done"
            count={sections.inactive.length}
            onClick={() => setTab("done")}
            icon={<DoneMark size={TAB_ICON} />}
          />
        </div>
      </div>
    </div>
  )
}
