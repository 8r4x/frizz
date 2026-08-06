import { useEffect, useRef } from "react"
import { useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import { useQuery } from "@tanstack/react-query"
import { closeGithubPicker, store, seedBoard, pushDrawer, resolveRoutedThread, topDrawer, topThreadSlug, showToast } from "./store.ts"
import { useBoard } from "./hooks.ts"
import { closeDrawerAnimated } from "./lib/overlays.ts"
import { startRouter } from "./lib/router.ts"
import { nextSidebarPresence, type SidebarPresence } from "./lib/sidebarPresence.ts"
import { rpc } from "./api/rpc.ts"
import { Sidebar, projectIdentity } from "./components/Sidebar.tsx"
import { StatusBar } from "./components/StatusBar.tsx"
import { DrawerStack } from "./components/DrawerStack.tsx"
import { TodosView } from "./components/TodosView.tsx"
import { NewThreadDialog } from "./components/NewThreadModal.tsx"
import { GithubPickerModal } from "./components/GithubPickerModal.tsx"
import { useGithubStatus } from "./components/GithubTrigger.tsx"
import { SettingsDrawer } from "./components/SettingsDrawer.tsx"
import { CommandPalette } from "./components/CommandPalette.tsx"
import { StatusListView } from "./components/StatusListView.tsx"
import { ErrorBoundary } from "./components/ErrorBoundary.tsx"
import { RestartOverlay } from "./components/RestartOverlay.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { FRIZZ_SUPERVISOR_STATUS_WAKE_EVENT, getFrizzSupervisorStatus } from "./api/restart.ts"

const RELOAD_AFTER_UPDATE_RESTART = "frizz:reload-after-update-restart"

// The not-signed-in hint fires at most once per page load. A module-scoped flag (not React state)
// keeps it from re-firing across re-renders, effect re-runs, or a StrictMode double-invoke.
let signInHintShown = false
function maybeShowSignInHint() {
  if (signInHintShown) return
  signInHintShown = true
  showToast("Sign in to the GitHub CLI (`gh auth login`) to dispatch from issues/PRs.", { duration: 6000 })
}

export function App() {
  const snap = useSnapshot(store)
  const sidebarPresence = useRef<SidebarPresence>({ projectDir: null, hasBeenVisible: false })

  // Seed the board once at startup so the first paint doesn't wait on the SSE connect; SSE keeps it
  // fresh afterward. seedBoard (not setBoard) so a late-resolving seed can't clobber a board the SSE
  // stream has already established + advanced with deltas.
  useEffect(() => {
    rpc.board().then(seedBoard).catch(() => {})
  }, [])

  // STORE → URL (opening a drawer writes the address bar). The other direction is the route tree's —
  // see routes.tsx useRouteToStore. Navigation goes through the router so its history stack and its
  // rendered match stay the same thing.
  const navigate = useNavigate()
  useEffect(() => startRouter((path, options) => navigate(path, options)), [navigate])

  // The public supervisor survives replacement of the app child. It is consequently the only
  // trustworthy transition signal: an old child can still say ready while the next artifact builds.
  // Poll gently at rest and promptly during a handoff; writes are gated in rpc.ts but drafts remain
  // session-backed and editable throughout.
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let announcedFailure: string | null = null
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      const status = await getFrizzSupervisorStatus()
      if (!active) { polling = false; return }
      if (status) {
        // An optimistic, user-initiated restart raised the overlay before the supervisor confirmed the
        // transition. HOLD it until a poll actually OBSERVES a server-confirmed non-"ready" status: a
        // "ready" read while pending is either the pre-flip state or a stale in-flight response, and
        // applying it would drop the overlay and (with a destination armed) reload onto the old child.
        // The moment a poll sees "restarting"/"failed", the optimism is server-backed — clear the hold.
        if (store.controlPlaneRestartPending) {
          if (status.state !== "ready") {
            store.controlPlaneRestartPending = false
            store.controlPlaneState = status.state
            store.controlPlaneMessage = status.message ?? null
          }
        } else {
          store.controlPlaneState = status.state
          store.controlPlaneMessage = status.message ?? null
        }
        const destination = sessionStorage.getItem(RELOAD_AFTER_UPDATE_RESTART)
        if (status.state === "ready" && destination && !store.controlPlaneRestartPending) {
          sessionStorage.removeItem(RELOAD_AFTER_UPDATE_RESTART)
          window.location.replace(destination)
          polling = false
          return
        }
        if (status.state === "failed" && destination) {
          sessionStorage.removeItem(RELOAD_AFTER_UPDATE_RESTART)
          if (announcedFailure !== status.message) {
            // Announce the failure, never its REASON: the supervisor's message is raw build output —
            // a `nub run typecheck` failure arrives as several hundred characters of absolute
            // snapshot paths — and pasting that into a toast stretched a strip across the entire
            // viewport, four lines deep, saying the same thing the failure panel beside the reload
            // button was already showing properly. The panel owns the detail; this owns the attention.
            announcedFailure = status.message ?? "Update & Restart failed"
            showToast("Update & Restart failed — Frizz kept running the previous version", { duration: 7000 })
          }
        }
      }
      polling = false
      timer = setTimeout(poll, store.controlPlaneState === "restarting" ? 500 : 8_000)
    }
    const wake = () => {
      if (timer) clearTimeout(timer)
      void poll()
    }
    window.addEventListener(FRIZZ_SUPERVISOR_STATUS_WAKE_EVENT, wake)
    void poll()
    return () => {
      active = false
      window.removeEventListener(FRIZZ_SUPERVISOR_STATUS_WAKE_EVENT, wake)
      if (timer) clearTimeout(timer)
    }
  }, [])

  // While ANY overlay is open (thread sheet, doc drawer, settings, new-thread modal, palette), the
  // PAGE must not scroll — only the overlay's own pane does.
  const overlayOpen = snap.drawers.length > 0 || snap.showSettings || snap.showNewThread || snap.showGithubPicker || snap.showPalette
  useEffect(() => {
    // Scroll lock via the body-fixed dance, NOT overflow:hidden on the root — hiding root overflow
    // dropped the scrollbar (and with it the layout width) every time a drawer opened. With the
    // track permanently reserved (html overflow-y: scroll) and the body pinned at its scroll
    // offset, locking is pixel-invisible; unlocking restores the exact scroll position.
    if (!overlayOpen) return
    const y = window.scrollY
    const body = document.body
    body.style.position = "fixed"
    body.style.top = `-${y}px`
    body.style.left = "0"
    body.style.right = "0"
    body.style.width = "100%"
    return () => {
      body.style.position = ""
      body.style.top = ""
      body.style.left = ""
      body.style.right = ""
      body.style.width = ""
      window.scrollTo(0, y)
    }
  }, [overlayOpen])

  // Mirror settings.notifications onto the store so the (React-free) SSE handler can gate desktop
  // notifications. Refetched whenever the settings query is invalidated (e.g. after a save).
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  useEffect(() => {
    store.notificationsEnabled = settings.data?.notifications ?? false
  }, [settings.data?.notifications])

  // GitHub availability drives two things: the picker TRIGGER (in the sidebar / brand-new view, gated
  // in GithubTrigger off this same cached query) and — when the repo IS a GitHub repo but gh is NOT
  // signed in — ONE subtle, self-fading hint on app open nudging the user to `gh auth login`. The hint
  // fires at most once per page load (a module flag survives re-renders / StrictMode double-invoke),
  // stays a beat longer than a normal toast so it's readable, and never nags again.
  const github = useGithubStatus()
  useEffect(() => {
    if (github.data?.inRepo && !github.data.authed) maybeShowSignInHint()
  }, [github.data?.inRepo, github.data?.authed])

  // THE KEYBOARD MODEL (post-machine): the sidebar is mouse-driven and text surfaces own their own
  // keys, so the app-level keyboard reduces to global chords + Esc unwinding:
  //   ⌘K palette (its "New thread" item opens the modal) · ⌘I frizz-doc drawer for the topmost thread
  //   NOTE: no ⌘N binding. ⌘N is the BROWSER's new-window shortcut — reserved, and ours to leave
  //   alone. Hijacking it either loses to the browser outright (a plain tab never delivers the event)
  //   or, in a standalone/PWA window, steals a system shortcut the user expects. New-thread keeps
  //   three doors that cost us nothing: ⌘K → "New thread", the sidebar pill, and the visible composer.
  //   Esc — overlays first (palette/modal/settings), then the drawer stack topmost-first. That chain
  //   belongs to <DrawerStack> (the standalone /full page needs the identical unwinding), so only the
  //   chords are handled here.
  //   Enter submits in a composer; Shift/Option-Enter newline (Composer's own handler)
  // (The xstate focus machine — nav selection, arrow-walk, chevron, step-in/out, focus registry — was
  // DELETED when the sidebar went mouse-only: the queue is always visible, clicking a row opens its
  // drawer, and a composer's Esc simply blurs it. No virtual focus, no zombie states.)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // The terminal is a native TUI surface. Its Escape/arrows/control keys and slash-menu input
      // belong to xterm, never to Frizz's drawer/global shortcut layer.
      if (e.target instanceof Element && e.target.closest(".xterm")) return
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key === "k") {
        e.preventDefault()
        store.showPalette = !store.showPalette
      } else if (key === "i") {
        // ⌘I: frizz document for the topmost open thread (stacks another layer / pops its own).
        const top = topDrawer()
        const target = topThreadSlug()
        if (top?.kind === "doc") {
          e.preventDefault()
          if (!closeDrawerAnimated(top.id)) store.drawers.pop()
        } else if (target) {
          e.preventDefault()
          pushDrawer("doc", target)
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const board = useBoard()

  // Settle a parked `/thread/<slug>` URL. It waits for the board because the destination depends on
  // whether the thread is QUEUED — a needsYou thread's whole panel is already in the main column, so
  // the URL scrolls to that card instead of stacking an identical drawer over it. Deliberately an
  // EFFECT and not a store subscription: scrollToQueueCard measures a mounted `[data-queue-card]`, so
  // it has to run after the queue commits, which for a cold deep link is the same render the board
  // first arrives. (resolveRoutedThread no-ops unless there is a parked slug AND a board.)
  useEffect(() => { resolveRoutedThread() }, [board, snap.routeThreadSlug])

  sidebarPresence.current = nextSidebarPresence(sidebarPresence.current, board)
  const showSidebar = board !== null && sidebarPresence.current.hasBeenVisible
  // A missing board is not evidence that this project is named "frizz". Keep the header neutral until
  // a board keyframe supplies an actual owner/repo identity; reconnects retain their adopted board.
  const identity = projectIdentity(board)

  // Window title carries the project identity. In the INSTALLED APP window (display-mode:
  // standalone) Chrome prefixes the title bar with the app name itself ("Frizz - <title>"), so the
  // page title must NOT repeat the wordmark — just the repo label ("Frizz - nubjs/nub"). In an
  // ordinary browser tab there's no prefix, so the title carries it as a trailing mark
  // ("nubjs/nub — Frizz") — the repo LEADS because a tab truncates from the end, and it is the repo
  // that tells two open boards apart. StandaloneThreadPage uses the same trailing mark.
  const projectLabel = board?.projectLabel ?? board?.projectName
  useEffect(() => {
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    document.title = standalone ? (projectLabel ?? "Frizz") : projectLabel ? `${projectLabel} — Frizz` : "Frizz"
  }, [projectLabel])

  // NOTE: there is deliberately NO "this repo has no .frizz/" branch here. Threads are session-first
  // (the registry in ui.db IS the board); `.frizz/` only holds thread scratch dirs and plans, and dispatch
  // creates it on the way (writeScratchDir → ensureSafeDirectDirectory). Gating the shell on it
  // inverted the fresh-repo experience: a repo with an EMPTY `.frizz/` got the real first-run view,
  // while a repo without one got a dead end that said "dispatch a first thread" with no composer to
  // do it in. A `.frizz`-less repo is simply a board with zero threads — TodosView's `nothingAtAll`
  // branch already renders exactly the right thing for it (centered prompt box, sidebar hidden).
  return (
    <>
    <RestartOverlay open={snap.controlPlaneState === "restarting"} message={snap.controlPlaneMessage} />
    {/* While restarting, the whole app subtree goes inert so nothing behind the scrim is focusable or
        clickable; the overlay above is a sibling OUTSIDE it so it stays interactive. */}
    <div inert={snap.controlPlaneState === "restarting"} className="relative min-h-screen bg-bg text-fg text-sm">
      {/* Fixed chrome: ONE status bar in the upper-left carrying identity, connection, settings,
          reload and both quota chips (see StatusBar.tsx). The top-right corner is deliberately empty
          now — the settings/reload pair used to live there, a screen's width away from the identity
          they describe. Everything else flows; the PAGE is the one and only scroll container — a tall
          card simply runs off both edges. */}
      <StatusBar identity={identity} connection={snap.connection} boardFallback={snap.socketBoardFallback} />
      {/* (The old fixed "New thread" pill moved INTO the sidebar's top — one entry point, same modal
          flow; the ⌘K palette's "New thread" item and the always-visible dispatch box are the
          other doors — deliberately NOT ⌘N, which belongs to the browser.) */}

      {/* CENTERED PAIR with a SCALING GUTTER: the floating sidebar column and the workpane sit side by
          side ("space-around looked weird" — a deliberate gutter reads calmer), and the PAIR as a unit
          centers horizontally — leftover space distributes on the far sides. The sidebar is VERTICALLY
          CENTERED in the viewport (sticky, set in Sidebar.tsx) and scales clamp(272px → 34vw → 680px)
          so titles get real room on large screens; the workpane keeps its readable 720px measure
          (shrinking first when space runs out) and scrolls as normal top-anchored page flow.
          TABLET BAND (801px–~1170px) — the pair used to be WIDER than the viewport there, so both
          outer edges sat FLUSH against it while a 52px gutter ate the middle (maintainer 2026-08-01:
          "we should never have it so the left and right edges are flush against the viewport", and
          "reduce the gap between the sidebar and the Queue on smaller screens"). Two things keep that
          from recurring, both CONTINUOUS so nothing jumps at a breakpoint:
            · px-5 on the container at EVERY width — the pair centers inside the padded box and the
              workpane (min-w-0) shrinks into it, so a side margin can never reach 0. Above ~1170px
              there is leftover space anyway and the padding stops binding.
            · the gutter scales clamp(28px → 3.4vw → 52px): ~28px where space is scarce, back to the
              tuned 52px by ~1530px, where the pair has margins to spare. Wide layouts are unchanged. */}
      <div className="flex min-h-screen justify-center gap-[clamp(28px,3.4vw,52px)] px-5 max-[800px]:flex-col max-[800px]:justify-start max-[800px]:gap-0 max-[800px]:px-3">
        {/* A genuinely fresh project keeps its centered first-task view. Once this project has had a
            Frizz-owned thread or plan, the sidebar remains mounted through transient empty keyframes;
            navigation must not vanish while the live board stream reconnects or catches up. */}
        {/* Each of the three standing surfaces catches its OWN render errors (see ErrorBoundary.tsx):
            a bad row in the sidebar must not take the workpane with it, and vice versa. */}
        {showSidebar && (
          <ErrorBoundary label="the sidebar">
            <Sidebar />
          </ErrorBoundary>
        )}
        <main
          id="workpane"
          // min-h-screen where content is vertically CENTERED: the boot loader and the empty queue's
          // prompt box (TodosView's flex-1 centering needs a full-height parent); populated queues just
          // top-align and grow past. Threads render in DRAWERS, never here.
          className={`w-[720px] max-w-[62vw] min-w-0 flex flex-col py-5 max-[800px]:w-full max-[800px]:max-w-none ${
            snap.view === "todos" || !board ? "min-h-screen" : ""
          } ${
            // Queue recedes: the CARD carries its own chrome (a sticky header), so the bordered panel
            // frame drops away. Status lists (URL-only views) keep the panel on main.
            snap.view === "todos" ? "" : "rounded-lg border border-border bg-panel"
          }`}
        >
          {/* Until the first board snapshot lands, show a quiet loader — NEVER a view's empty state
              (which would flash "Nothing pending" on every hard reload). Only board !== null renders
              real views. */}
          {!board ? (
            <div className="flex-1 flex items-center justify-center">
              <span className="block h-5 w-5 rounded-full border-2 border-muted/50 border-t-transparent animate-spin" />
            </div>
          ) : (
            <ErrorBoundary label="the queue" resetKeys={[snap.view]}>
              {snap.view.startsWith("status:") && <StatusListView status={snap.view.slice(7)} />}
              {snap.view === "todos" && <TodosView />}
            </ErrorBoundary>
          )}
        </main>
      </div>

      {/* The side-drawer STACK — and the Escape chain that unwinds it — lives in <DrawerStack> so the
          standalone `/thread/<slug>/full` page can mount the identical thing. See DrawerStack.tsx. */}
      <DrawerStack />
      {snap.showSettings && <SettingsDrawer />}
      {snap.showNewThread && <NewThreadDialog onClose={() => { store.showNewThread = false; store.newThreadPlanPath = null }} />}
      {snap.showGithubPicker && <GithubPickerModal onClose={closeGithubPicker} />}
      <CommandPalette />
      <Toaster />
    </div>
    </>
  )
}
