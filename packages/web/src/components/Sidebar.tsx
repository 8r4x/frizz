import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useSnapshot } from "valtio"
import { Check, ChevronRight, CircleDashed, Clock, Ellipsis, FileText, Github, Hourglass, House, Loader2, RotateCcw, Timer } from "lucide-react"
import type { BoardSnapshot, PlanView, ThreadView } from "@frizz/shared"
import { store, openThread, scrollToQueueCard, queueCardTargetY, pushSubAgentDrawer, pushPlanDrawer, QUEUE_CARD_VIEWPORT_TOP, type ConnectionState } from "../store.ts"
import { useBoard, asThreads } from "../hooks.ts"
import { prefs } from "../lib/prefs.ts"
import { sectionThreads, partitionActive, needsAction, displayTitle, titleIsProvisional, isHeld, parkedAwaitingHint, sessionIndicatorKind, offersRetry, futureSnoozedUntil, lastActiveLabelAt } from "../groups.ts"
import { ageSpan, relativeAge } from "../lib/activityTime.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { BoxSpinner, STATUS_BOX } from "./BoxSpinner.tsx"
import { ChildOpRow } from "./ChildOpRow.tsx"
import { visibleChildOps } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { MarkAsButton } from "./MarkAsButton.tsx"
import { DispatchForm } from "./NewThreadModal.tsx"
import { StatusRow } from "./StatusRow.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { ProviderMark } from "./ProviderMark.tsx"
import { STATUS_CHIP } from "../lib/status.ts"
import { retrySession } from "../lib/retrySession.ts"
import { formatSnoozedUntil, formatAutoSnoozedUntil, formatUserSnooze } from "../lib/snooze.ts"
import { awaitingWaitClause, prWatchRefs } from "../lib/awaitingPresentation.ts"
import { useOptimisticallySteered } from "../lib/steering.ts"
import { useOptimisticallyArchived } from "../lib/optimisticArchive.ts"
import { activeSidebarSection, queueNavigationSettled, railRevealDelta, type SidebarSectionGeometry } from "../lib/sidebarScrollspy.ts"
import type { ReactElement, ReactNode } from "react"
import { ICON_LABEL_NUDGE } from "../lib/iconAlign.ts"

// THE LEFT SIDEBAR — the thread list as a FLOATING column (no border, no fill: it floats in the
// page's whitespace the way the old ToC nav did). App centers the sidebar + workpane as a PAIR with
// a scaling gutter between them; this column is VERTICALLY CENTERED in the viewport and holds still
// while the workpane scrolls. Width SCALES with the viewport — clamp(272px, 34vw, 680px) — so titles
// get real room on large screens (titles WRAP, never truncate; captions stay one line; NEVER a
// horizontal scrollbar — overflow-x is clipped and unbreakable tokens break).
//
// ENTIRELY MOUSE-DRIVEN: no arrow-walk, no selection chevron. A session row CLICK opens the thread's
// drawer (chat / doc via store.openThread); a plan row opens the plan drawer; a legacy row opens its
// frizz doc.
//
// Sections: FOUR bands top→bottom, in the names ARCHITECTURE.md § Board nomenclature fixes — RESTED
// (everything at rest = the queue's own rows, a.k.a. the cue), ACTIVE (the rows currently spinning),
// then a labeled DIMMED HELD band (every declared clock/hourglass/timed wait), then DONE — each split
// by a bare <hr>, and Held and Done both collapsible. Rested and Active are ONE uncollapsible <section>
// (you can't hide your queue or your live work); the <hr> between them is the whole distinction, so
// never describe a rested row as active. A thread merely awaiting its OWN sub-agents is INTERNAL work
// and stays spinning in Active undimmed; only external waiters drop into the dimmed band (groups.ts
// isHeld).
// Needs-you renders as the row INDICATOR + the queue; awaiting as the hint gloss.
// Plans from board.plans; Done = explicitly completed. Legacy .frizz rows and foreign terminal
// sessions do not render at all.


export function Sidebar() {
  const snap = useSnapshot(store)
  const board = useBoard()
  // A just-sent steer is folded into the board BEFORE anything is derived from it, so the row's
  // spinner and its POSITION land together. Consulting the hint further down (in the indicator alone,
  // as this once did) left the two disagreeing for the whole injection + tailer round-trip: the row
  // spun while still sitting in the queue-ordered rested band, below the rule, and hopped up to the
  // running band seconds later — measured at 2.0s here with an instantaneous fixture worker, longer in
  // production. See lib/steering.ts.
  // Both optimistic overlays, composed: a just-sent steer pulls a row into Active, a just-clicked
  // Mark-as-done drops it into Done — each folded in BEFORE any band is derived, so the row's
  // appearance and its POSITION always land together instead of one waiting on a round-trip the other
  // already skipped (lib/steering.ts, lib/optimisticArchive.ts).
  const all = useOptimisticallyArchived(useOptimisticallySteered(asThreads(board?.threads ?? [])))
  const sections = sectionThreads(all, useSnapshot(prefs).queueOrder)
  const plans = (board?.plans ?? []) as PlanView[]
  const collapsed = snap.sidebarCollapsed
  const activeThreads = sections.active
  const heldThreads = sections.held
  const inactiveThreads = sections.inactive
  const railRef = useRef<HTMLDivElement>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  // A click-to-card navigation in flight: the row that was clicked, plus where its scroll landed. Both
  // halves matter — see the release conditions in syncActiveSection.
  const pendingNavigation = useRef<{ id: string; landedY: number } | null>(null)

  const syncActiveSection = useCallback(() => {
    const items = [...document.querySelectorAll<HTMLElement>("[data-queue-card][data-queue-leaving=\"false\"]")]
      .map((element) => {
        const id = element.dataset.queueCard
        if (!id) return null
        // The BORDERED ROOT, not the slot: the slot also spans the ~80px inter-card gutter and its
        // hairline rule, and the reading rule below is decided by how much of a CARD is on screen.
        const card = element.querySelector<HTMLElement>("[data-queue-card-root]") ?? element
        const { top, bottom } = card.getBoundingClientRect()
        return { id, top, bottom } satisfies SidebarSectionGeometry
      })
      .filter((item): item is SidebarSectionGeometry => item !== null)
    const pending = pendingNavigation.current
    if (pending) {
      const target = items.find((item) => item.id === pending.id)
      if (queueNavigationSettled(target, window.scrollY, pending.landedY, QUEUE_CARD_VIEWPORT_TOP)) pendingNavigation.current = null
      else {
        setActiveId(pending.id)
        return
      }
    }
    const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    const atDocumentBottom = maxScrollY > 0 && window.scrollY >= maxScrollY - 1
    const nextActiveId = activeSidebarSection(items, window.innerHeight, atDocumentBottom)
    // Scroll/resize observations can fire several times per frame. Preserve the same primitive
    // state value to avoid a needless row-tree update when the selected card has not changed.
    setActiveId((current) => current === nextActiveId ? current : nextActiveId)
  }, [])

  useEffect(() => {
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(syncActiveSection)
    }
    schedule()
    // Capture scroll so this also follows an app-level scrolling element if the page's scroll root
    // changes. The rail's own scroll is harmless here (card geometry has not changed), while a
    // programmatic/smooth queue-card scroll is always observed.
    document.addEventListener("scroll", schedule, { capture: true, passive: true })
    window.addEventListener("resize", schedule)
    const workpane = document.getElementById("workpane")
    const observer = workpane ? new ResizeObserver(schedule) : null
    // Transcript expansion, card exits, and keyframe reorders can change which card crosses the
    // reading line without a window scroll. Observe those DOM changes as well as the workpane box.
    const mutations = workpane ? new MutationObserver(schedule) : null
    if (workpane) observer?.observe(workpane)
    if (workpane) mutations?.observe(workpane, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-queue-card", "data-queue-leaving", "style", "class"] })
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      observer?.disconnect()
      mutations?.disconnect()
    }
  }, [syncActiveSection, snap.view, snap.drawers.length])

  // Reveal a newly active row inside the rail itself. Direct scrollTop adjustment is intentionally
  // local: Element.scrollIntoView could scroll the main document and steal the reader's position.
  useLayoutEffect(() => {
    const rail = railRef.current
    if (!rail || !activeId || window.matchMedia("(max-width: 800px)").matches) return
    const item = rail.querySelector<HTMLElement>(`[data-sidebar-item="${CSS.escape(activeId)}"]`)
    if (!item) return
    const railBox = rail.getBoundingClientRect()
    const itemBox = item.getBoundingClientRect()
    const delta = railRevealDelta(railBox.top, railBox.bottom, itemBox.top, itemBox.bottom)
    if (Math.abs(delta) > 0.5) rail.scrollTop += delta
  }, [activeId])

  // Called AFTER scrollToQueueCard, which has either scrolled or (with a drawer dismissing over the
  // still-locked page) parked the landing for the unlock ~210ms out. So the landing is read off the
  // CARD, not off window.scrollY: the two agree once the page has settled, and only the card knows the
  // answer while the lock is still holding scrollY at 0.
  const navigateToQueueCard = useCallback((id: string) => {
    pendingNavigation.current = { id, landedY: queueCardTargetY(id) ?? window.scrollY }
    setActiveId(id)
  }, [])

  return (
    // HEIGHT MODEL: a sticky, exactly viewport-height wrapper that CENTERS the inner column, which
    // grows fit-content to a near-flush cap and scrolls internally only past it. overflow-x is CLIPPED
    // (titles wrap; min-w-0 at every level). No bg/clip on the column itself.
    // NO z-index. The rail and the workpane are side-by-side flex columns that never overlap, so the
    // old desktop `z-[100]` bought nothing — but it outranked every ordinary overlay (the ⌘K palette
    // at z-[60], the new-thread modal and settings drawer at z-50, toasts at z-[70]), so each of them
    // painted BEHIND the prompt box and had to escalate past 100 to be seen. That escalation is the
    // recurring "hidden underneath the prompt box" bug. Default stacking is the fix: overlays win by
    // simply being overlays. Do not re-add a z here — raise the specific overlay instead.
    // The 272px FLOOR (was 320px) only binds in the TABLET BAND just above the 800px stack point, where
    // 34vw is smallest and the workpane is squeezed hardest — 320px claimed ~39% of an 820px viewport
    // for nav and left the queue with the remainder. 272px still holds the dispatch composer's profile
    // chip and its icon buttons on one line, and hands the difference back to the queue.
    <aside className="sticky top-0 self-start h-screen w-[clamp(272px,34vw,680px)] shrink-0 flex flex-col justify-center max-[800px]:static max-[800px]:h-auto max-[800px]:w-full max-[800px]:justify-start max-[800px]:pt-16">
      {/* The content column FILLS the aside track (no narrow inner cap). Its cap reserves 16px top AND
          bottom (symmetric, so the column stays centred), and below it the column grows and then
          scrolls INTERNALLY. The reserve used to be 44px a side, holding open the band the FIXED
          status bar occupied in the page's top-left corner so a long thread list could not push the
          composer up underneath it. That bar is gone — its contents are the StatusRow at the top of
          this very column now — so the lane it needed goes with it and the rail gets the 56px back.
          Short boards are unaffected: they never reach the cap. */}
      <div className="flex max-h-[calc(100vh-32px)] min-h-0 min-w-0 w-full flex-col max-[800px]:max-h-none">
        {/* THE PROMPT BOX lives at the sidebar top (it replaced the New-thread pill — maintainer
            2026-07-09): always present, type + Enter dispatches a new thread. A brand-new repo shows
            this same box CENTERED as the whole screen (App hides the sidebar); the first dispatch
            shunts it here to the left. */}
        <div className="mb-5 shrink-0 px-0.5">
          {/* THE STATUS ROW rides the top of the prompt box: project identity at the left edge, the
              settings/reload pair and both quota chips at the right. The quota chips did once float
              here on their own, then moved out to a fixed corner bar because quota is ACCOUNT-global
              rather than a property of this composer — which is still true, and is why they come back
              as part of a GLOBAL status row instead of as a composer decoration. */}
          {/* The GitHub picker's door now lives INSIDE the dispatch composer (a small icon left of the
              send button — see DispatchForm/Composer leftAction); no separate pill here. */}
          <StatusRow />
          <DispatchForm />
        </div>
        <div ref={railRef} data-sidebar-rail className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden max-[800px]:overflow-y-visible">
          {/* RESTED + ACTIVE — always shown, NEVER collapsible (you can't hide your queue or your live
              work), no label. Two rule-separated bands (see groups.ts orderActive/partitionActive):
              RESTED — the cue — sits FIRST, right under the prompt box (maintainer 2026-08-08), in the
              EXACT queue order, so the rail's top row is opposite the queue's top card and scrolling
              the queue walks the scroll marker straight down this rail. ACTIVE — live work that isn't
              waiting on you — runs BELOW the rule (an Active row has no queue card — the maintainer's
              ask: they don't render in the queue), so it stays glanceable without pushing the cue down.
              Only the cue's rows carry the rest-time column: it dates a HANDOFF, and a row that is
              still spinning has not made one. */}
          {activeThreads.length > 0 ? (
            (() => {
              const { running, rested } = partitionActive(activeThreads)
              const renderRow = (restedAge: boolean) => (t: ThreadView) => (
                <div key={t.id}>
                  <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={navigateToQueueCard} restedAge={restedAge} />
                  <SubAgentRows t={t} />
                </div>
              )
              return (
                <>
                  {rested.map(renderRow(true))}
                  {running.length > 0 && rested.length > 0 && <hr className="my-3 border-border/50" />}
                  {running.map(renderRow(false))}
                </>
              )
            })()
          ) : (
            // pl-5 matches ThreadRow's own content inset (its status-indicator column), so the
            // placeholder starts exactly where the rows it stands in for would — and lands within a
            // pixel of the Held/Done/Plans labels, which clear the same width for their chevron. A
            // bare px-1.5 left it hanging 14px out at the rail's raw edge, alone against everything.
            // "open", not "active": this stands in for the Active AND Rested bands together, and it
            // renders only when BOTH are empty. Saying "no active threads" over a hidden queue would be
            // the same conflation the vocabulary above exists to stop.
            <div className="py-1 pl-5 pr-1.5 text-[11.5px] text-muted/50">No open threads</div>
          )}
          {/* HELD — every deliberate clock/hourglass/timed wait, visibly de-emphasized and labeled so
              it cannot read as active work. COLLAPSIBLE, and collapsed by default (maintainer
              2026-08-04): nothing here is waiting on the rail's reader right now, so it opens as a
              labeled count and expands on demand — the count is the glance. */}
          {heldThreads.length > 0 && (
            <section aria-label="Held">
              <hr className="my-3 border-border/50" />
              {/* Same header component as Done/Plans so the three bands can never visually drift. */}
              <SectionHeader
                label="Held"
                count={heldThreads.length}
                collapsed={collapsed.held}
                onToggle={() => (store.sidebarCollapsed.held = !store.sidebarCollapsed.held)}
              />
              {!collapsed.held &&
                heldThreads.map((t) => (
                  <div key={t.id}>
                    <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={navigateToQueueCard} />
                    <SubAgentRows t={t} />
                  </div>
                ))}
            </section>
          )}
          {/* DONE — collapsible, OMITTED entirely (with its rule) when empty. */}
          {inactiveThreads.length > 0 && (
            <div>
              <hr className="my-3 border-border/50" />
              <SectionHeader
                label="Done"
                count={inactiveThreads.length}
                collapsed={collapsed.inactive}
                onToggle={() => (store.sidebarCollapsed.inactive = !store.sidebarCollapsed.inactive)}
              />
              {!collapsed.inactive &&
                inactiveThreads.map((t) => (
                  <div key={t.id}>
                    <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={navigateToQueueCard} />
                    <SubAgentRows t={t} />
                  </div>
                ))}
            </div>
          )}
          {/* PLANS — collapsible, OMITTED (with its rule) when empty. Artifacts, not threads. */}
          {plans.length > 0 && (
            <div>
              <hr className="my-3 border-border/50" />
              <SectionHeader
                label="Plans"
                count={plans.length}
                collapsed={collapsed.plans}
                onToggle={() => (store.sidebarCollapsed.plans = !store.sidebarCollapsed.plans)}
              />
              {!collapsed.plans && plans.map((p) => <PlanRow key={p.path} plan={p} />)}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

// A section header: an optional collapse caret, the label, and the count. ONE source of truth for
// every band header (Held, Done, Plans) so they can never visually drift apart again. Every band in
// the real rail is collapsible; omitting onToggle renders a static div with a caret-width spacer, so
// a header without a toggle (the QA fixtures' Active/Held bands) still aligns with the rest.
export function SectionHeader({ label, count, collapsed, onToggle }: { label: string; count: number; collapsed?: boolean; onToggle?: () => void }) {
  const inner = (
    <>
      {onToggle ? (
        <ChevronRight size={11} className={`transition-transform ${collapsed ? "" : "rotate-90"}`} />
      ) : (
        // Reserve the caret's width so a non-collapsible label lines up with the collapsible ones.
        <span className="w-[11px] shrink-0" aria-hidden />
      )}
      <span>{label}</span>
      {/* Count rides right next to its label (not floated to the far edge) — it's meaningful data,
          not a margin ornament; raised contrast so it actually reads. */}
      <span className="ml-1.5 tabular-nums text-muted/60">{count}</span>
    </>
  )
  const cls = "flex w-full items-center gap-1 px-1.5 py-1 text-[11px] uppercase tracking-wide text-muted/70"
  return onToggle ? (
    <button onClick={onToggle} className={`${cls} transition-colors hover:text-fg`}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  )
}

// The title's trailing adornments — the provider mark, the `terminal` tag, the legacy status chip —
// are ATOMIC inline boxes, and the line breaker is free to break right BEFORE one even though no
// whitespace separates it from the title. On a wrapping title that regularly stranded the provider
// mark ALONE on a second line, with the whole title above it (maintainer 2026-07-31: "often the only
// thing that breaks onto the new line is the agent icon"). Glue them to the title's LAST WORD in a
// nowrap group so the pair wraps together instead.
//
// The group takes the whole last word when it is short enough to fit the narrowest rail beside the
// adornments, and otherwise just its TAIL — gluing a rail-wide token whole would overflow instead of
// wrapping. Cutting a long token is safe: an element boundary mid-word adds no break opportunity of
// its own, so the head still breaks exactly where `break-words` would have broken it, and the mark
// keeps a dozen characters of company either way.
const MAX_GLUED_TITLE_WORD = 16
const GLUED_TITLE_TAIL = 12
function TitleWithTrailers({ title, children }: { title: string; children: ReactNode }) {
  const text = title.trimEnd()
  const wordStart = text.lastIndexOf(" ") + 1
  const cut = text.length - wordStart <= MAX_GLUED_TITLE_WORD ? wordStart : text.length - GLUED_TITLE_TAIL
  if (cut >= text.length) return <>{title}{children}</>
  return (
    <>
      {text.slice(0, cut)}
      <span className="whitespace-nowrap">{text.slice(cut)}{children}</span>
    </>
  )
}

// One THREAD row. Session rows (the default): the derived session indicator, the title, a foreign
// read-only tag, an awaiting hint gloss, and the activity + live-sub-agent suffix. NO Mark-as verb —
// session threads use Archive in the persistent thread footer. A LEGACY row
// keeps the vestigial rendering: a status chip + the hover-revealed Mark-as split button (the ONLY
// place it survives). A click opens the thread's drawer (openThread routes chat/doc).
//
// MEMOIZED: board deltas REPLACE a changed thread's whole object, so `t` keeps snapshot identity iff
// unchanged — memo skips exactly the untouched rows.
export const ThreadRow = memo(function ThreadRow({
  t,
  legacy,
  active = false,
  onQueueNavigate,
  restedAge = false,
}: {
  t: ThreadView
  legacy?: boolean
  active?: boolean
  onQueueNavigate?: (id: string) => void
  /** Show the right-justified rest-time column. The CUE's rows only — see RestedAge. */
  restedAge?: boolean
}) {
  const foreign = !legacy && t.foreign === true
  // Held rows are uniformly grayed as a whole; provisional titles retain their local dim treatment.
  // A thread awaiting its OWN live sub-agent/Monitor is not Held and stays fully active.
  const held = !legacy && isHeld(t)
  const dimLabel = !legacy && titleIsProvisional(t)
  // The rows with an obvious single next action carry that verb INLINE, instead of making you open the
  // thread to find it. offersRetry (groups.ts) picks them: a STALLED row (the [!] mark — process
  // exited) AND a row HELD on a usage limit frizz will auto-resume (the hourglass — a faster door to the
  // in-drawer "Continue now" than waiting for the window). The queue card and drawer header read the
  // SAME helper, so no surface can disagree with the rail about which threads offer Retry.
  const canRestart = !legacy && offersRetry(t)
  // A ROW IS ITS TITLE, AND NOTHING ELSE (maintainer 2026-08-19: "there should never ever be any fucking
  // thing in the sidebar except for the fucking title"). There is no subtitle line on any row, in any
  // state: not the fence's PR ref, not a snooze, not the legacy `.frizz` activity gloss, not a sub-agent
  // count. Every one of them was a second, competing status beside the row's own — the rail is a column
  // of NAMES you scan, and each caption added there made the next one harder to find.
  //
  // What frizz knows about the row still exists, one hover away: the indicator's popover composes it
  // from the AWAITING BLOCK deterministically (awaitingWaitClause) plus the worker's own `reason:`, so
  // the detail is available on demand and never spends a line of the rail. That is the same call that
  // hid the SNOOZED label (2026-08-03) and the worker's reason (2026-08-16), applied to the last of them.
  return (
    <div
      data-sidebar-item={t.id}
      className={`group relative flex min-w-0 items-start rounded-md transition-[color,background-color,opacity] hover:bg-white/[0.04] ${legacy ? "opacity-80" : held ? "opacity-65 hover:opacity-90 focus-within:opacity-90" : ""}`}
    >
      {/* The reading position owns a real, in-row rail rather than borrowing the status-icon column.
          The marker spans the row's complete visual height, including wrapped titles and subtitles,
          while the fixed rail keeps it from shifting content or relying on clipped overflow. */}
      <span aria-hidden="true" data-sidebar-marker-rail className="pointer-events-none absolute inset-y-0 left-0 w-5">
        {active && <span data-sidebar-scroll-marker className="absolute inset-y-0 left-1 w-[2px] rounded-full bg-accent" />}
      </span>
      <button
        onClick={() => {
          // A queued (needsYou) thread already has its full card in the main column. A sidebar click
          // just SCROLLS to that card — it does NOT open a redundant drawer over it (maintainer
          // 2026-07-15: "it should not open the thread drawer, just auto-scroll to the item in the
          // queue"). Only fall through to the drawer when no card is mounted (not queued/not rendered).
          if (t.needsYou && scrollToQueueCard(t.id)) {
            onQueueNavigate?.(t.id)
            return
          }
          openThread(t.id)
        }}
        aria-current={active ? "location" : undefined}
        className="min-w-0 flex-1 flex items-start gap-2 pb-1 pl-5 pr-1.5 pt-1 text-left"
      >
        {/* h-[19px] so the indicator centers on the title's FIRST line, not the middle of a wrapped row. */}
        <span className="w-4 h-[19px] shrink-0 flex items-center justify-center">
          <ThreadIndicator t={t} legacy={legacy} />
        </span>
        <span className="min-w-0 flex-1 flex flex-col">
          {/* items-BASELINE, not items-center: the rest time is a smaller type size sitting beside the
              title, and the eye reads the two as one line only when their baselines agree. On a WRAPPED
              title flex aligns the FIRST baseline, so the label stays on the title's first line where
              the row's other right-edge affordance (RowRetryButton) also lives. */}
          {/* gap-3, not gap-2. The measured gap is usually 20–40px of ink (ragged-right titles rarely
              reach their box edge), but the case that decides the number is the line that DOES fill:
              8px is ~2 word spaces at 13px, which reads as the title running into its own timestamp.
              12px is a gutter, and it costs the title 4px it does not miss. */}
          <span className="flex min-w-0 items-baseline gap-3">
            <span className={`min-w-0 flex-1 break-words text-[13px] leading-[19px] ${dimLabel ? "text-fg/50" : held ? "text-fg/75" : "text-fg/90"}`}>
              <TitleWithTrailers title={displayTitle(t)}>
                {!legacy && <ProviderMark backend={t.backend} className="ml-1" />}
                {foreign && (
                  <span
                    className="petite-caps ml-1.5 inline-block rounded border border-border/60 px-1 align-[2px] text-[9.5px] leading-[14px] text-muted/55"
                    title="Read-only — running in an external terminal"
                  >
                    terminal
                  </span>
                )}
                {legacy && <StatusChip status={t.archived ? "archived" : t.status} />}
              </TitleWithTrailers>
            </span>
            {/* The Retry verb is an OVERLAY pinned to this same right edge, so on the rows that offer
                it the two would collide — a 19px opaque button landing halfway across "20 seconds",
                which reads as a rendering fault rather than an affordance. The label gives way to it
                on hover instead: the button is why you pointed at the row. */}
            {restedAge && <RestedAge t={t} yieldsToRetry={canRestart} />}
          </span>
        </span>
      </button>
      {/* The Mark-as verb survives ONLY on legacy rows (a .frizz verb). Session lifecycle controls
          live in the thread footer. */}
      {legacy && (
        <div className="absolute right-1 top-1 hidden group-hover:flex items-stretch rounded-md bg-panel shadow-sm shadow-black/30">
          <MarkAsButton slug={t.id} size="sm" />
        </div>
      )}
      {/* ONE-CLICK RECOVERY on a stalled OR usage-limit-held row (offersRetry). Hover-revealed and
          pinned to the row's right edge, over the title's first line (it OVERLAYS rather than taking
          layout, so pointing at a row never reflows its wrapped title). `group-focus-within` keeps it
          reachable from the keyboard: focus the row button and the next Tab lands here. */}
      {canRestart && <RowRetryButton slug={t.id} />}
      {/* Live children render as SIBLING rows under this one, not inside it — see SubAgentRows, which
          the rail's three sections mount directly after each ThreadRow (maintainer 2026-07-09: render
          running sub-agents in the sidebar). They replaced an old one-line summary suffix that used to
          live in this row's subtitle. */}
    </div>
  )
})

// THE CUE'S RIGHT-HAND COLUMN — how long ago this thread came to REST (maintainer 2026-08-08: "a
// right-justified label on each item in the cue indicating when the thread came to rest").
//
// The instant is `lastActiveLabelAt`, the SAME one the queue card's "Last active" line renders and the
// same one the band is ORDERED by — so the column reads monotonically down the cue instead of
// disagreeing with the order it is printed in. That helper is what keeps a completed background
// sub-agent from bumping a rested row's reading to "just now": at rest it reads the agent's own last
// output (`lastAssistantAt`), never the tailer's last record of any kind.
//
// It carries the SPAN without "ago" (lib/activityTime ageSpan) because the column position is the
// "ago", and it is right-justified rather than trailing the title so the whole cue reads as one column
// of times — a title's length must not decide where its timestamp sits. `useNowMs` is the app's single
// 30s wall clock, so a screenful of these ticks on one timer.
function RestedAge({ t, yieldsToRetry }: { t: ThreadView; yieldsToRetry?: boolean }) {
  const now = useNowMs()
  const at = lastActiveLabelAt(t)
  const span = ageSpan(at, now)
  if (!at || !span) return null
  return (
    <time
      dateTime={at}
      data-rail-rested-age
      title={relativeAge(at, now) ?? undefined}
      // The row's accessible name concatenates its parts, and a bare "2 days" arriving after the title
      // says nothing about WHAT took two days. The label names the reading for that reader; the visible
      // text stays bare, because sighted readers have the column to tell them.
      aria-label={`Rested ${relativeAge(at, now) ?? span}`}
      // shrink-0 + tabular-nums: the column must not compress under a long title, and the digits must
      // not jitter horizontally when the clock ticks. The title takes the remaining width and wraps.
      className={`shrink-0 tabular-nums text-[10.5px] leading-[19px] text-muted/55 ${
        yieldsToRetry ? "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0" : ""
      }`}
    >
      {span}
    </time>
  )
}

// The stalled row's recovery verb: a SMALL GREY icon button that restarts the exited session in ONE
// click, without opening the thread. Deliberately the SAME verb, icon, message and RPC path as the
// thread header's Retry (lib/retrySession) — the row is just a faster door to it. Named "Retry", not
// "Restart", because "restart" already means the frizz control plane restarting itself
// (RestartFrizzButton) and the two must not blur.
function RowRetryButton({ slug }: { slug: string }) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  return (
    <Tooltip label="Retry — resume this session where it left off">
      <button
        data-sidebar-retry={slug}
        aria-label="Retry exited session"
        disabled={busy}
        // Keep DOM focus off the button on click so the reveal doesn't outlive the pointer, and stop
        // the press from reaching the row (which would navigate to the thread as well as retry it).
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          setBusy(true)
          retrySession(queryClient, slug).finally(() => setBusy(false))
        }}
        // Sized to the title's FIRST line (h-[19px], top-1 matches the row's pt-1) so it never exceeds
        // the row height. Quiet grey, no border/accent — the muted-icon idiom of the header actions. An
        // opaque `bg-panel` backing keeps the title's last words from bleeding through the overlay.
        className="absolute right-1.5 top-1 hidden h-[19px] w-[19px] items-center justify-center rounded bg-panel text-muted/70 outline-none transition-colors group-hover:flex group-focus-within:flex hover:bg-panel-2 hover:text-fg disabled:opacity-50"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
      </button>
    </Tooltip>
  )
}

// The rail's INDENTED child rows — the same shared ChildOpRow the queue cards and the drawer's ops
// strip render, at "rail" density (the [ ]/[/] checkbox motif the rest of the rail speaks, indented to
// clear the parent row's indicator column). The liveness policy is the rail's own and is deliberately
// unchanged: running OR stale, and only children carrying an id (the drill-in drawer's RPC handle —
// see lib/childOps.ts, which lists all three surfaces' divergent policies in one place).
function SubAgentRows({ t }: { t: ThreadView }) {
  const subs = visibleChildOps(t.subAgents ?? [], "rail")
  if (subs.length === 0) return null
  return (
    <div className="flex flex-col">
      {subs.map((s) => (
        <ChildOpRow
          key={s.id}
          kind="AGENT"
          label={s.label}
          state={s.state}
          density="rail"
          // A sub-agent's own sub-agents indent one step further under it, so a branch reads as a tree.
          depth={s.depth}
          startedAt={s.startedAt}
          parentSlug={t.id}
          onOpen={() => pushSubAgentDrawer(t.id, s.id, { label: s.label, subagentType: s.subagentType, startedAt: s.startedAt })}
          // The same dismiss × the queue card and the ops strip carry (maintainer 2026-07-30): the rail
          // is where a phantom child is most often SEEN, so it is where retiring one has to be possible.
          onDismiss={childOpDismisser(t.id, s)}
          // The rail has no room for the worker-profile tag the ops strip can show, so it rides the tooltip.
          title={s.subagentType ? `[${s.subagentType}] ${s.label}` : s.label}
        />
      ))}
    </div>
  )
}

// One PLAN row (from board.plans): a doc glyph + the plan title. A click opens the plan drawer (its
// markdown + an "Implement this" affordance). Threads dispatched from the plan are its history —
// the count rides the title tooltip.
function PlanRow({ plan }: { plan: PlanView }) {
  const n = plan.threadIds?.length ?? 0
  return (
    <div className="group relative flex min-w-0 items-start rounded-md transition-colors hover:bg-white/[0.04]">
      <button
        onClick={() => pushPlanDrawer(plan.path, plan.title)}
        // pl-5, the SAME content inset as ThreadRow: a plan row is a sibling of the thread rows in
        // this one rail, so its glyph column has to share their left edge. It has no scroll-marker
        // rail of its own to reserve that width, which is how it drifted 14px out on px-1.5.
        className="min-w-0 flex-1 flex items-start gap-2 py-1 pl-5 pr-1.5 text-left"
        title={n ? `${n} thread${n === 1 ? "" : "s"} from this plan` : undefined}
      >
        <span className="w-4 h-[19px] shrink-0 flex items-center justify-center">
          <FileText size={12} className="text-muted/60" />
        </span>
        <span className="min-w-0 flex-1 break-words text-[13px] leading-[19px] text-fg/90">
          {plan.title}
          {n > 0 && <span className="ml-1.5 tabular-nums text-[10.5px] text-muted/45">{n}</span>}
        </span>
      </button>
    </div>
  )
}

// Small-caps bordered status label on legacy rows. Inline so it flows after a wrapped title's last
// word. Colors come from the shared status palette so chips + picker dots speak one language.
function StatusChip({ status }: { status: string }) {
  const label = status === "archived" ? "Done" : status
  return (
    <span className={`petite-caps ml-1.5 inline-block rounded border px-1 align-[2px] leading-[14px] text-[9.5px] ${STATUS_CHIP[status] ?? "text-muted border-border"}`}>
      {label}
    </span>
  )
}


/** THE ROW'S POPOVER — ONE SENTENCE about the wait, then the worker's own sentence under it.
 *
 *  The rail's rows are TITLE-ONLY (see ThreadRow), so this is the only place the wait is legible, which
 *  means it has to READ rather than merely be complete. The first cut stacked one fragment per hint
 *  kind and the reason under that — four lines of record, no sentence anywhere in it (maintainer
 *  2026-08-19: "that popover text looks fucking terrible"). Now the state and what it is waiting on are
 *  joined into one clause, exactly the shape every other tooltip on this rail already has ("Stalled —
 *  the agent's process exited"):
 *
 *      Snoozed until tomorrow at 11:11 AM — waiting on acme/app#391 and a background shell
 *
 *      the tap submission is queued behind their CI backlog
 *
 *  The STATE leads because it is what the glyph you pointed at is claiming; the fence's clause follows
 *  because it says what that glyph means on THIS row; the worker's `reason:` takes a PARAGRAPH of its
 *  own, because it is the one line frizz did not write. The blank line is load-bearing: the sentence
 *  above it wraps, and a reason set directly under a wrapped line reads as its third line — which is
 *  exactly how it looked when they were merely stacked. Nulls and blanks drop out, so a row with no
 *  fence is just its state. */
function popover(t: Pick<ThreadView, "lastFence">, state: string | null): string {
  const hints = t.lastFence?.kind === "awaiting" ? t.lastFence.hints : []
  const wait = awaitingWaitClause(hints)
  const head = [state, wait].filter((part) => Boolean(part)).join(" — ")
  return [head, awaitingReason(t)].filter((line) => Boolean(line)).join("\n\n")
}

/** The worker's own one-line `reason:`, for a POPOVER. Null when the fence carries none — a tooltip that
 *  invents a sentence is worse than one that just names the state. */
export function awaitingReason(t: Pick<ThreadView, "lastFence">): string | null {
  if (t.lastFence?.kind !== "awaiting") return null
  const reason = t.lastFence.hints.find((h) => h.kind === "reason")?.value.trim()
  return reason ? reason : null
}

// ── the indicator (one per row) ──────────────────────────────────────────────────────────────────

// One indicator, one diameter: the spinner ring and the machine-wait glyphs occupy the same optical
// size so rows read evenly. ATTENTION marks (needs-you / question) run a touch LARGER and full-accent
// on purpose — "what needs you" must be the most salient pixel on the rail, never the least.
const INDICATOR = 7
const ATTENTION = 9

// Each indicator carries a terse hover tooltip naming the state it signals. The faint "at rest" dot
// gets none. A plain wrapper <span> is the tooltip trigger (a real DOM node Radix can ref).
export function ThreadIndicator({ t, legacy }: { t: ThreadView; legacy?: boolean }) {
  // No steer special-case here anymore: Sidebar overlays a just-sent steer onto the thread itself
  // (useOptimisticallySteered), so `t` already reads as running and the ordinary derivation returns
  // the spinner — the same one decision that put the row in the running band. When this hook consulted
  // the hint on its own, the glyph and the placement were two rules and drifted apart on every steer.
  const { node, tip } = legacy ? legacyIndicatorFor(t) : sessionIndicatorFor(t)
  // The resolved kind, on the shipped markup. Cheap, and it is what lets the rail's own glyphs be
  // measured where they actually render (scripts/verify-rail-status-glyphs.mjs holds the family to one
  // weight band) instead of against a reconstruction that can drift from the real thing.
  const mark = legacy ? undefined : sessionIndicatorKind(t)
  if (!tip) return mark ? <span data-rail-glyph={mark} className="flex items-center justify-center">{node}</span> : node
  return (
    // A live row that is ALSO snoozed stacks its park under its state ("Working" / "Snoozed until …"),
    // so the tooltip has to keep that newline rather than reflowing the two into one sentence.
    <Tooltip label={tip} side="left" multiline={tip.includes("\n")}>
      <span data-rail-glyph={mark} className="flex items-center justify-center">{node}</span>
    </Tooltip>
  )
}

// The SESSION-first row indicator (kind === "session"). A "?" is reserved for a concrete unresolved
// input state: question/ask, typed interaction, native selector, permission prompt, or explicit human
// block. Queue membership by itself is only a handoff: a bare rested thread keeps the ordinary
// ellipsis. Everything the human is not on the hook for remains quieter: a spinner (in motion), a
// muted hourglass (intentional hold), a quiet check (done/archived), or the at-rest ellipsis.
// STATUS = a markdown-task CHECKBOX family (maintainer 2026-07-10, Obsidian-flavored): every state is
// the SAME rounded-rect outer box with a glyph inside, so the rail reads like a to-do list.
//   [ ] idle        — at rest, nothing pending (empty box)
//   [/] in progress — the rounded-RECT spinner (a segment travels the box perimeter): this thread's own
//                     turn, or a live SUB-AGENT whose return will re-invoke it. Both are real motion.
//   [•] background  — at rest with only a detached background SHELL still running (never a sub-agent —
//                     maintainer 2026-08-01). Nothing is coming back, so nothing spins; the pulsing blue
//                     dot says "alive, not moving". The row holds its place in the running band.
//   [?] needs input — a question / native ask / permission prompt (accent box + "?")
//   [!] stalled     — the agent's PROCESS EXITED with the work unfinished (accent box + "!"), whether
//                     it died mid-turn or exited after resting without a done fence. Same mark either
//                     way, because the next action is the same: Retry. Exactly the rows that carry the
//                     inline Retry verb (offersRetry === this kind — one decision, two surfaces).
//   clock waiting   — machine-waiting behind an ```awaiting fence
//   [✓] done        — a ```done fence at rest, OR an archived thread (muted check — NOTHING else)
//   […] at rest     — an ordinary rest with no concrete ask, INCLUDING a queued thread whose own
//                     dispatched sub-agents are still running (they spin on their own child rows)
// Attention (needs-input / stalled) wears the accent; everything else is muted.
/** Exported for TESTS ONLY. The tip is a Radix tooltip, so it renders nothing until it opens — static
 *  markup cannot see it, and asserting on the icon alone would pass a popover that said the wrong thing.
 *  This is the seam that lets the popover's TEXT be pinned directly. */
export function sessionIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  const base = sessionStateIndicatorFor(t)
  // The tooltip is now the ONLY place a snooze is legible on the rail (the subtitle no longer names it),
  // so it has to say so on every parked row — not just the ones the park actually quiets. The hourglass
  // arm below already tells that story for a Held row. These are the rows a snooze does NOT silence:
  // one whose own turn is running, one still waiting on a sub-agent it dispatched, and one holding a
  // concrete ask (which outranks the park in sessionIndicatorKind). Each keeps its live glyph — the park
  // has not taken effect yet and the rail must not claim otherwise — and gains a second line saying when
  // it will.
  if (sessionIndicatorKind(t) === "held") return base
  const snoozedUntil = futureSnoozedUntil(t)
  const parked = snoozedUntil ? formatUserSnooze(snoozedUntil, t.snoozePrompt) : null
  if (!parked) return base
  return { node: base.node, tip: stackParked(base.tip, parked) }
}

/** A snooze stacks under the row's STATE, never under the worker's `reason:`.
 *
 *  The reason is a PARAGRAPH — see `popover`, which sets it off with a blank line precisely so a wrapped
 *  state sentence and a human one cannot be read as one run of lines. Appending the park to the end
 *  would land it inside that paragraph and undo exactly that. */
function stackParked(tip: string | null, parked: string): string {
  if (!tip) return parked
  const [state, ...reason] = tip.split("\n\n")
  return [`${state}\n${parked}`, ...reason].join("\n\n")
}

function sessionStateIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  const kind = sessionIndicatorKind(t)
  if (kind === "archived") return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted/75" /></StatusBox>, tip: "Done" }
  if (kind === "needs-input") {
    // Muted "?", same gray as every other glyph — a needs-you thread already carries maximum emphasis
    // by sitting in the ⚖ queue, so the rail indicator adds NO extra color (maintainer 2026-07-10).
    return { node: <StatusBox><Glyph ch="?" muted /></StatusBox>, tip: "Needs your input" }
  }
  if (kind === "working") return { node: <BoxSpinner />, tip: "Working" }
  // The thread has stopped and nothing is going to wake it — only a detached shell it launched is still
  // running — so the box stops tracing and the row simply stays alive in the running band. Same blue and
  // same pulse as the transcript's live-shell dot, sized to this box (styles.css .frizz-rail-dot), so
  // both surfaces say "a shell is alive behind this" in one language.
  if (kind === "background") {
    // The fence, when there is one, names the shell itself (and any PR riding beside it), so the lead
    // drops to a bare "At rest" rather than saying "a background shell" twice in one sentence.
    const fenced = t.lastFence?.kind === "awaiting" && awaitingWaitClause(t.lastFence.hints) !== null
    return {
      node: <StatusBox><span aria-hidden className="frizz-rail-dot" data-running-indicator="thread-background" /></StatusBox>,
      tip: popover(t, fenced ? "At rest" : "At rest — a background shell is still running"),
    }
  }
  if (kind === "done") return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted/75" /></StatusBox>, tip: "Done" }
  if (kind === "stalled") {
    // ONE mark for "the process is gone". The server's `crashed` bit (exited AND turn-in-flight/live
    // background work) no longer gates the mark — it only picks the wording, so the tooltip still tells
    // you HOW it stopped while the glyph and the Retry verb treat both stops identically.
    const tip = t.crashed === true ? "Stalled — the agent exited mid-turn" : "Stalled — the agent's process exited"
    return { node: <StatusBox accent><Glyph ch="!" /></StatusBox>, tip }
  }
  if (kind === "held") {
    const hourglass = <StatusBox><Hourglass size={9} className="text-muted/70" /></StatusBox>
    const github = <StatusBox><Github size={9} className="text-muted/70" /></StatusBox>
    // A held row whose fence carries `pr-watch:` is held FOR A PR, and the rail says so with GitHub's
    // mark instead of the hourglass. The hourglass means "parked on the clock", and for a watch the
    // clock is only the backstop: the scheduler polls the PR and CLEARS the park the moment new
    // activity lands (scheduler.ts, the clear-snooze-on-pr-watch-wake), so what actually wakes this row
    // is GitHub. pr-watch never parks itself — parkedAwaitingHint excludes it so a watch stays a
    // visible queue handoff — so the rows that reach here are the ones parked ANYWAY: one whose worker
    // co-declared a `human:` gate beside the watch, and one the human snoozed on a wall clock. (Until
    // 2026-08-13 the commonest source was the awaiting card's own "PR watcher armed" Snooze; that
    // control is gone, and the resting card's event-snooze that replaced it drops the queue card
    // without parking the thread in Held.) All were previously indistinguishable from a plain timer park.
    const watched = t.lastFence?.kind === "awaiting" ? prWatchRefs(t.lastFence.hints) : []
    const heldMark = watched.length > 0 ? github : hourglass
    // A held row carries its whole "what it's held for" story HERE, in the popover — the rail row itself
    // is a title and nothing else. The two time-based holds are ONE concept — a snooze (park until a wall-clock instant) — sharing the same
    // heldMark + single-line layout. They differ only in WHO resolves the park at the deadline, which
    // the tooltip wording marks as an `auto` variant of the same word rather than a separate idea:
    //   • a user snooze re-surfaces the CARD for you  → "Snoozed until <wake>"       (you act next)
    //   • an ```awaiting timer:` park / blocked+timer status auto-resumes the agent → "Auto-snoozed until <wake>"
    // A user snooze that carries a PROMPT crosses that line by design — frizz resumes the agent with it —
    // so formatUserSnooze reads it as the auto variant and names the follow-up it will send.
    const snoozedUntil = futureSnoozedUntil(t)
    if (snoozedUntil) {
      return { node: heldMark, tip: popover(t, formatUserSnooze(snoozedUntil, t.snoozePrompt) ?? "Snoozed until a scheduled check") }
    }
    // A usage-limit park is the third member of that same "held on the clock" family — frizz resolves
    // this one too, so it reads as an auto-snooze, named by what actually stopped the work.
    if (t.limitPause?.autoResume) {
      const which = t.limitPause.window === "weekly" ? "weekly limit" : "session limit"
      const at = t.limitPause.resumesAt ? formatAutoSnoozedUntil(new Date(t.limitPause.resumesAt * 1000).toISOString()) : null
      return { node: hourglass, tip: at ? `${at} — ${which} reached` : `Auto-snoozed until the ${which} resets` }
    }
    // Canonical blocked+timer status can arrive from an older/pre-session snapshot without a fence.
    if (t.lastFence?.kind !== "awaiting") {
      const timed = typeof t.revalidate === "string" ? formatAutoSnoozedUntil(t.revalidate) : null
      return { node: hourglass, tip: timed ?? "Auto-snoozed until a scheduled check" }
    }
    // Reserve the park mark (hourglass, or GitHub when a watch is riding along) for intentional park
    // states: a durable GitHub review cursor, the thread's own live work, or a VALID scheduled instant.
    // NO HINT KIND PARKS ON ITS OWN. `human:` and `timer: <instant>` each drew the Held mark from the
    // worker's assertion alone; both are deleted (2026-08-15) and the server now decides Held from a
    // checked declaration. What is left to draw is the SHAPE of the wait.
    const hk = t.lastFence.hints.find((h) => h.kind === "pr" || h.kind === "shell" || h.kind === "agent" || h.kind === "timer")?.kind
    // The tooltip's WORDS come from the fence itself (popover → awaitingWaitClause), which names the
    // things it parked on; the arms below only pick the GLYPH that matches the leading kind. They used
    // to say the shape in prose too — "Waiting on its own background work" — which restated vaguely
    // what the clause says exactly ("waiting on 2 background shells and a timer"), and was the only
    // place the popover's text was hand-written per arm instead of derived.
    const mark = hk === "pr"
      ? github
      : hk === "shell" || hk === "agent"
        ? <StatusBox><CircleDashed size={10} className="text-muted/70" /></StatusBox>
        : <StatusBox><Clock size={9} className="text-muted/70" /></StatusBox>
    return { node: mark, tip: popover(t, "Held") }
  }
  // At rest (no fence, nothing pending) with the process still ALIVE — a worker that came to rest
  // WITHOUT declaring done or a machine-wait, and with NOTHING it launched still running (that is the
  // pulsing dot above). (An exited one is `stalled` above; this ellipsis is now honestly reserved for a
  // session you can still just type at.) Read it as WAITING
  // (maintainer 2026-07-10: a rested-not-done thread "should be blocked or waiting", never a stark
  // empty box and never a false check). We don't know the reason — the worker didn't fence — so: no
  // hint gloss (vs an ```awaiting fence, which carries pr/ci hints AND dims + sinks the row). The
  // honest fix is the worker emitting ` ```awaiting ` when it's blocked on a machine.
  // RESTED AND AWAITING lands here whenever the park is not Held — the fence declared a wait but frizz
  // could not honour it (an item that is not running, no `for:`), so the row stays in the queue wearing
  // the ordinary at-rest mark. That row is exactly where the worker's `reason:` earns its place: the
  // glyph says "at rest" and the popover says what it thinks it is waiting for, which is the one thing
  // the rail cannot show and the operator most wants on hover (maintainer 2026-08-16).
  return {
    node: <StatusBox><Ellipsis size={11} className="text-muted/70" /></StatusBox>,
    tip: popover(t, "At rest"),
  }
}

// THE shared rounded-rect checkbox — the ONE outer shape every status glyph sits in. Its size and the
// spinner that traces it live in ./BoxSpinner.tsx, because the indented child rows (ChildOpRow, "rail"
// density) draw the same spinner and must not import their own parent module to get it.
function StatusBox({ accent, children }: { accent?: boolean; children?: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-[4px] border ${accent ? "border-accent/90" : "border-muted/45"}`}
      style={{ width: STATUS_BOX, height: STATUS_BOX }}
    >
      {children}
    </span>
  )
}
// A bold single-char glyph (?, !) centered in the box. Accent by default; `muted` renders it the same
// gray as every other rail glyph (the "?" needs-you mark — the ⚖ queue already carries the emphasis).
function Glyph({ ch, muted }: { ch: string; muted?: boolean }) {
  return (
    <span aria-hidden className={`font-bold leading-none ${muted ? "text-muted/70" : "text-accent"}`} style={{ fontSize: 10 }}>
      {ch}
    </span>
  )
}
// The LEGACY (.frizz status) row indicator — the vestigial status-keyed logic, kept only for the
// read-only Legacy shelf.
function legacyIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  if (t.runtime === "running" || t.runtime === "spawning" || t.runtime === "perm-prompt") return { node: <Spinner />, tip: "Working" }
  const liveSub = (t.subAgents ?? []).some((s) => s.state === "running")
  if (t.runtime === "turn-idle" && liveSub && !t.humanBlocked) return { node: <Spinner />, tip: "Working" }
  if (needsAction(t)) return { node: <BlueDot />, tip: "Needs your input" }
  if (t.status === "needs-human") return { node: <YellowDot />, tip: "Awaiting you — open to read & reply" }
  if (t.status === "blocked" && t.mechanism === "timer") return { node: <Timer size={INDICATOR + 1} className="text-muted/70" />, tip: "Waiting on a timer" }
  if (t.status === "blocked" && t.mechanism === "threads") return { node: <CircleDashed size={INDICATOR + 1} className="text-muted/70" />, tip: "Waiting on other work" }
  return { node: <FaintDot />, tip: null }
}

function Spinner() {
  return (
    <span
      // Matches the sub-agent child-row spinner EXACTLY (8px, 1px border) — the maintainer converged
      // the two after the top-level spinner (was 7px/1.5px) read visibly smaller than the sub-agent's.
      className="block rounded-full border border-muted/70 border-t-transparent animate-spin"
      style={{ width: 8, height: 8 }}
    />
  )
}

// THE attention mark — needs-you at rest. The signature accent (#e8b923) at full strength with a
// soft halo: the app spends its yellow in exactly one place, and this is it. Larger than the machine
// glyphs so it wins the row at a glance.
function AccentDot() {
  return (
    <span
      className="block rounded-full bg-accent shadow-[0_0_5px_rgba(232,185,35,0.45)]"
      style={{ width: ATTENTION, height: ATTENTION }}
    />
  )
}

function BlueDot() {
  return <span className="block rounded-full bg-sky-400" style={{ width: INDICATOR, height: INDICATOR }} />
}

// Awaiting-you without a queue card (legacy session-less needs-human): the status palette's yellow.
function YellowDot() {
  return <span className="block rounded-full bg-yellow-400" style={{ width: INDICATOR, height: INDICATOR }} />
}

function FaintDot() {
  return <span className="block rounded-full bg-muted/30" style={{ width: INDICATOR, height: INDICATOR }} />
}

// The top-left identity is intentionally derived only from the currently adopted board keyframe.
// There is no session/local-storage cache: keeping a stale owner/repo while another project or boot
// is becoming authoritative is worse than showing this small neutral reservation. A transport reset
// leaves the adopted board in the store, so a normal reconnect keeps its known identity in place.
export type ProjectIdentity =
  | { state: "loading" }
  | { state: "unavailable" }
  /**
   * A repo with NO ORIGIN REMOTE (or one whose URL yields no owner/repo). There is no owner half to
   * show and there never will be, so this is a settled answer, not a pending one — `local` exists to
   * keep it from wearing the loading skeleton forever. The name is the directory basename, which is
   * what the server already falls back to for `projectLabel`.
   */
  | { state: "local"; name: string }
  | { state: "verified"; label: string; owner: string; repo: string }

export function projectIdentity(
  board: (Pick<BoardSnapshot, "projectLabel"> & Partial<Pick<BoardSnapshot, "projectName">>) | null | undefined,
): ProjectIdentity {
  if (!board) return { state: "loading" }
  // A board WITHOUT a projectLabel is not a crash. The field is required on the wire, so this only
  // guards a board keyframe that arrived partial — but the identity renders inside the SIDEBAR COLUMN
  // rather than as detached corner chrome, so a throw here takes the whole rail (and the prompt box
  // with it) rather than one line of chrome. Caught the moment StatusRow moved: every fixture that
  // seeds a board without a label crashed on `.trim()` of undefined.
  const label = board.projectLabel?.trim() ?? ""
  const cut = label.lastIndexOf("/")
  const owner = cut === -1 ? "" : label.slice(0, cut).trim()
  const repo = cut === -1 ? "" : label.slice(cut + 1).trim()
  if (owner && repo) return { state: "verified", label, owner, repo }
  // NO OWNER/REPO — a local-only git repo with no origin remote, which is an ANSWER and must read as
  // one. `projectLabel` deliberately falls back to the directory basename in that case, and this used
  // to fold that fallback into "unavailable": the row then rendered the cold loading skeleton, and
  // kept rendering it, because no keyframe was ever going to resolve into an owner/repo (maintainer
  // 2026-08-19: "it just shows a skeleton forever"). It still must not GUESS an owner — there is
  // simply nothing to guess, and the directory name is a fact the server already computed.
  const name = label || board.projectName?.trim() || ""
  if (name) return { state: "local", name }
  // Nothing nameable at all. Only reachable from a keyframe carrying neither field, which is a broken
  // server rather than a project shape — the placeholder is honest there because something IS missing.
  return { state: "unavailable" }
}

// The workspace identity mark, pinned by App to the page's TOP-LEFT corner: verified labels use the
// owner/repo styling — a muted owner, a muted slash, the repo name bright — plus the live SSE dot
// and its state word. Before that identity exists, a static neutral reservation prevents a false
// name and keeps the connection indicator optically anchored without a distracting shimmer.
export function IdentityMark({
  identity,
  state,
  boardFallback,
  railVisible = false,
}: {
  identity: ProjectIdentity
  state: ConnectionState
  boardFallback?: { actualBytes: number; maxBytes: number } | null
  /**
   * Whether the project rail is showing. A PROP, not a hook: this component is presentational and its
   * tests render it standalone with renderToStaticMarkup, outside any QueryClientProvider — reading
   * the setting in here made six of them throw. Defaults to hidden, which is also the shipped default,
   * so the crumb is present unless something says otherwise.
   */
  railVisible?: boolean
}) {
  const map = {
    open: { cls: "bg-live", word: "connected" },
    connecting: { cls: "bg-accent", word: "connecting…" },
    closed: { cls: "bg-red-500", word: "disconnected" },
  } as const
  const m = map[state]
  const usingFallback = state === "open" && !!boardFallback
  // "Healthy" is an open socket carrying the board itself. An open socket that had to fall back to SSE
  // is NOT healthy — it is the degraded mode the fallback exists to name — so it keeps its readout.
  const degraded = state !== "open" || usingFallback
  const connectionLabel = usingFallback ? "connected through SSE fallback" : m.word
  const accessibleLabel = identity.state === "verified"
    ? `Project: ${identity.label}; ${connectionLabel}`
    : identity.state === "local"
      // Named, and named accurately: this project HAS no owner/repo, so saying so is the whole point.
      ? `Project: ${identity.name}; local repository with no git remote; ${connectionLabel}`
      : identity.state === "loading"
        ? `Project identity loading; ${connectionLabel}`
        : `Project identity unavailable; ${connectionLabel}`
  // Whether there is a NAME to draw. Both branches that have one behave identically from here down —
  // the crumb separator, the resolved slot measure, the truncation — and only the tooltip differs.
  const named = identity.state === "verified" || identity.state === "local"
  return (
    <div
      className="flex items-center gap-2 min-w-0 max-w-full text-[12px]"
      data-project-identity-state={identity.state}
      aria-label={accessibleLabel}
      aria-busy={identity.state === "loading" || undefined}
    >
      {/* THE WAY BACK, when the rail is not there to be it.
          `home / repo` says where you are as well as where you can go, and it costs a click exactly
          when you meant to switch projects and nothing when you did not. Rendered only while the rail
          is hidden, so the two never both vanish and never both offer the same thing twice. 12px
          lucide beside a 12px label is the pairing ICON_LABEL_NUDGE was measured for. */}
      {!railVisible && (
        <>
          <a
            href="/"
            title="All projects"
            aria-label="All projects"
            className="shrink-0 rounded-sm text-muted/70 outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
          >
            <House size={12} className={`shrink-0 ${ICON_LABEL_NUDGE}`} />
          </a>
          {/* The separator belongs to the NAME, not to the crumb: a project with no name at all
              renders nothing after it, and `home /` with a dangling slash reads as a broken
              breadcrumb rather than a quiet one. A LOCAL repo has a name, so it keeps the slash. */}
          {named && <span className="-ml-1 shrink-0 text-muted/60">/</span>}
        </>
      )}
      <span className={`identity-slot ${named ? "identity-slot--resolved" : "identity-slot--placeholder"}`}>
        {/* The FULL owner/repo. A home crumb briefly stood here and pushed the owner out — the header
            read `home / owner / repo`, where only two of the three were somewhere you could go. The
            project RAIL is the way back to the grid now, so the crumb is gone from this line and the
            owner has its place back: it is the left half of a verified identity, and on a machine
            serving many projects it is what tells two same-named repos apart. */}
        {/* THE REPO ALONE when verified: the owner is not somewhere you can go, and it is not what
            tells you which board you are on — the repo name is. It stays in the tooltip and the
            accessible label. A LOCAL repo draws its directory name at the same weight, because that
            IS this project's name; the only thing it lacks is an owner, and a dimmed or decorated
            name would imply the identity is provisional when it is settled. Its tooltip is the plain
            name, which earns its place the moment a 272px column truncates it. */}
        {named ? (
          <span
            className="block min-w-0 truncate"
            title={identity.state === "verified" ? identity.label : identity.name}
          >
            <span className="font-semibold text-fg/90">
              {identity.state === "verified" ? identity.repo : identity.name}
            </span>
          </span>
        ) : (
          <span className="identity-placeholder" aria-hidden="true" />
        )}
      </span>
      {/* THE CONNECTION, PAINTED ONLY WHEN IT IS DEGRADED. A green dot and the word "connected" used
          to lead this cluster in every state, which meant it said the same thing every second of
          every session and nothing at all in the one state worth knowing about (maintainer
          2026-08-19: "drop the connected indicator, certainly. It's pretty useless"). A healthy
          socket now renders NOTHING here — the board moving is the indicator — while connecting,
          disconnected and the SSE fallback all still show, because a silently frozen board is the
          failure this reading exists to catch. The accessible label above carries the state in every
          case, healthy included.
          Its content chooses the measure: reserving a fixed status column left a conspicuous blank
          track after owner/repo resolved. */}
      {degraded && (
        <span
          className="flex items-center gap-1 shrink-0"
          data-board-sync-fallback={usingFallback || undefined}
          title={usingFallback ? `Board payload exceeded the live socket limit; connected through SSE` : undefined}
        >
          <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${m.cls}`} />
          <span className="text-[10.5px] text-muted/70">{usingFallback ? "connected · SSE fallback" : m.word}</span>
        </span>
      )}
    </div>
  )
}
