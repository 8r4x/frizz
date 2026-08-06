import { useEffect, useRef } from "react"
import { Outlet, createBrowserRouter, useLocation, useParams } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { App } from "./App.tsx"
import { ProjectGrid } from "./components/ProjectGrid.tsx"
import { ProjectRail, RAIL_INSET_CLASS } from "./components/ProjectRail.tsx"
import { StandaloneThreadPage } from "./components/StandaloneThreadPage.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { applyPath } from "./lib/router.ts"
import { innerPath } from "./lib/base-path.ts"
import { rebindProject } from "./api/socket.ts"
import { resetProjectState } from "./store.ts"
import { useProjectRailVisible } from "./lib/projectRail.ts"

// THE ROUTE TREE — and, more to the point, the LAYOUT that outlives a navigation.
//
// The rail is chrome: it draws every project on the machine and is identical on every page, so it
// must not be torn down and rebuilt when you use it. Before this it was mounted twice — once inside
// <App/> and once inside <ProjectGrid/> — because `main.tsx` chose ONE of three root shells from
// `location.pathname` at module load, which made every project switch a full document load. A layout
// route is the direct expression of "this part does not change": <RootLayout/> holds the rail and the
// tooltip provider, and the <Outlet/> below it swaps between the grid and a board.
//
// WHAT A PROJECT SWITCH ACTUALLY COSTS, and why the router alone was never the whole job. Four things
// are bound to one project, and a client-side switch has to re-bind every one of them:
//   · the live feed — one socket per project (api/socket.ts rebindProject)
//   · the board store, the drawer stack and the current view (store.resetProjectState)
//   · the react-query cache, EXCEPT the project list itself — clearing that would blank the rail on
//     every switch, which is precisely the flicker this whole change exists to remove
//   · the API base, which needs nothing: base-path.ts derives it from the page's path on every call,
//     and the router keeps `location` synchronous with navigation.
//
// The board is KEYED by slug so it genuinely remounts per project — its state is per-project and
// reusing the instance across a switch would carry the previous board's mounted surfaces into the new
// one. The rail above it is not keyed, so it persists. That contrast is the whole design.

/** The one place that knows the URL shapes, so a route and a link cannot disagree. */
export const PROJECT_PATH = "/project/:slug"

function RootLayout() {
  return (
    <TooltipProvider>
      {/* Outside the <Outlet/> on purpose: this is the element that must survive the navigation.
          OPT-IN: a permanent column of every project is a standing invitation to leave the thread
          you are in, so it is off unless asked for. Hidden, the way back is the status bar's home
          crumb (Sidebar's IdentityMark), which costs a click exactly when you meant to switch. */}
      {useProjectRailVisible() ? <ProjectRail /> : null}
      <Outlet />
    </TooltipProvider>
  )
}

/**
 * Re-bind everything that belongs to one project, whenever the project changes.
 *
 * A ref rather than a mount-effect guard: the FIRST binding is what `main.tsx` already did at module
 * load (connect the socket, seed the board), so tearing it down and rebuilding it on mount would make
 * every cold load do the work twice and flash an empty board doing it.
 */
function useProjectBinding(slug: string | undefined) {
  // The hook, not an import of main.tsx's instance: routes.tsx is imported BY main.tsx, and reaching
  // back for its export closes a module cycle whose initialisation order then depends on where the
  // reference happens to be read.
  const queryClient = useQueryClient()
  const bound = useRef<string | undefined>(slug)
  useEffect(() => {
    if (bound.current === slug) return
    bound.current = slug
    resetProjectState()
    // Everything EXCEPT the machine-wide project list, which the rail is drawing right now.
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== "projectsList",
    })
    rebindProject()
  }, [slug, queryClient])
}

/**
 * A board, for the project the URL names.
 *
 * `slug` is undefined on the unprefixed routes, which remain a supported state: the launching project
 * is still served at `/thread/<slug>` and `/status/<name>` with no `/project/<slug>` in front of it,
 * and `apiBase()` answers `/_frizz` for exactly that case.
 */
function BoardRoute() {
  const { slug } = useParams()
  useProjectBinding(slug)
  useRouteToStore()
  return (
    <div className={RAIL_INSET_CLASS}>
      <App key={slug ?? "__launching__"} />
    </div>
  )
}

function GridRoute() {
  useProjectBinding(undefined)
  return (
    <div className={RAIL_INSET_CLASS}>
      <ProjectGrid />
    </div>
  )
}

/**
 * URL → store, for the routes INSIDE a board.
 *
 * The drawer stack is valtio state, not route state, because a drawer is a stack with its own
 * animated unwind and several ways to open — so the URL is one input to it rather than its owner.
 * This is the direction react-router does not do for us: it resolves the path, and `applyPath` turns
 * that into "which thread is open, and is it a drawer or a queue card". The other direction (store →
 * URL) lives in lib/router.ts, which now navigates rather than calling history directly.
 */
function useRouteToStore() {
  const location = useLocation()
  useEffect(() => {
    applyPath(innerPath(location.pathname))
  }, [location.pathname])
}

/** The focused single-thread page. Deliberately OUTSIDE the layout: it has no rail, and should not. */
function StandaloneRoute() {
  const { thread, slug } = useParams()
  useProjectBinding(slug)
  return <StandaloneThreadPage slug={thread!} />
}

const boardChildren = [
  { index: true, element: <BoardRoute /> },
  { path: "thread/:thread", element: <BoardRoute /> },
  { path: "status/:status", element: <BoardRoute /> },
]

export const router = createBrowserRouter([
  // The focused single-thread pages sit OUTSIDE the layout — they have no rail, and should not. They
  // are listed first for readability only; react-router ranks by specificity, so `/thread/x/full`
  // beats `/thread/:thread` regardless of order.
  { path: "/thread/:thread/full", element: <StandaloneRoute /> },
  { path: `${PROJECT_PATH}/thread/:thread/full`, element: <StandaloneRoute /> },
  {
    element: <RootLayout />,
    children: [
      { path: "/", element: <GridRoute /> },
      // The launching project, unprefixed. `/` itself belongs to the grid, so this project reaches its
      // board through a thread or status path — see base-path.ts on why an empty base is supported.
      { path: "/thread/:thread", element: <BoardRoute /> },
      { path: "/status/:status", element: <BoardRoute /> },
      { path: PROJECT_PATH, children: boardChildren },
      // Anything else is a board for the launching project, which is what the old shell did with an
      // unknown path: applyPath falls through to the queue.
      { path: "*", element: <BoardRoute /> },
    ],
  },
])
