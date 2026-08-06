// FIRST import on purpose: react-scan patches React's reconciler hook and must load before react-dom.
// No-ops unless DEV and `?scan=1`.
import { installRenderScan } from "./perf-scan.ts"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@xterm/xterm/css/xterm.css"
import "./styles.css"
import { RootErrorBoundary } from "./components/ErrorBoundary.tsx"
import { RouterProvider } from "react-router"
import { router } from "./routes.tsx"
import { connectSync } from "./api/socket.ts"
import { initTranscriptLive } from "./api/transcript-live.ts"
import { initFont } from "./lib/font.ts"
import { installExternalLinkInterceptor } from "./lib/external-links.ts"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"
import { installThreadLinkInterceptor } from "./lib/thread-links.ts"
import { primeRoute } from "./lib/router.ts"
import { innerPath } from "./lib/base-path.ts"
import { parseStandaloneThreadPath } from "./lib/standaloneThreadRoute.ts"

installRenderScan()

const settingsFixture = typeof window !== "undefined" && window.location.pathname.endsWith("/settings-formatting-fixture.html")
// innerPath, not location.pathname: under a project prefix the deep link is `/project/nub/thread/x/full`.
const standaloneThreadSlug = typeof window !== "undefined" ? parseStandaloneThreadPath(innerPath()) : null

if (!settingsFixture && !standaloneThreadSlug) {
  // Adopt a cold/deep URL before React takes its first store snapshot — still SYNCHRONOUS, and still
  // before the first render, which is the whole point: it is what makes a deep-linked drawer painted
  // open on the first frame instead of animating in afterwards. The router resolves the same path a
  // beat later and `useRouteToStore` re-applies it, which is idempotent.
  primeRoute()
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

// One multiplexed /ws (board + transcript push + notify); falls back to SSE + polling if /ws is
// unavailable (a pre-restart server). The socket writes transcript pushes into this queryClient's cache.
if (!settingsFixture) {
  connectSync(queryClient)
  // Observer-driven transcript liveness: any mounted surface observing ["transcript", slug] is kept
  // fresh centrally (socket subscription within budget, activity-edge refetch beyond) — components
  // never manage subscriptions themselves.
  initTranscriptLive(queryClient)
  initFont(queryClient)
  installExternalLinkInterceptor()
  installLocalFileLinkInterceptor()
  installThreadLinkInterceptor()
}

// No StrictMode: it double-mounts effects, which would open the terminal
// WebSocket (and xterm instance) twice per selection in dev.
if (!settingsFixture) {
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      {/* The last-resort catch. App wraps its own surfaces far more finely (sidebar / queue / each
          drawer), so anything reaching this one broke above all of them — a throw in App's own body,
          or in the standalone thread page. It still renders a page with the error ON it, which is
          the whole difference between a bad render and the blank window this replaced. */}
      <RootErrorBoundary>
        <RouterProvider router={router} />
      </RootErrorBoundary>
    </QueryClientProvider>,
  )
}
