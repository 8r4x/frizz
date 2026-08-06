import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { ThreadView } from "@frizz/shared"
import "./styles.css"

// The measuring surface for the OPTICAL rhythm of frizz's two icon strips — the thread lifecycle
// footer and the composer's right rail. Both are clusters of small marks whose CSS spacing is
// uniform and whose PERCEIVED spacing was not, because every glyph wears a different amount of dead
// padding inside its box (maintainer 2026-08-04: "I'm sure the spacing is consistent in terms of the
// CSS, but what matters here is the visual spacing").
//
// It renders the REAL components, never a mock-up of them, so `scripts/ink-gaps.mjs` measures the
// shipping geometry. Both strips are here together deliberately: they are the same problem, and a
// fix that squares one while leaving the other is the failure this fixture exists to catch.
//
// The gate mocks below are the price of that: three of the controls hide themselves unless the
// server answers, and a fixture missing half the strip measures a rhythm the app never draws.

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  // RestartWorkerButton is dev-build-only and asks the launcher at runtime (lib/devBuild.ts).
  if (url.pathname === "/_frizz/control/status") {
    return new Response(JSON.stringify({ protocol: 1, state: "ready", dev: true }), {
      headers: { "content-type": "application/json" },
    })
  }
  // GithubTrigger renders only for an authed gh in a GitHub repo.
  if (url.pathname === "/_frizz/rpc/githubStatus") {
    return new Response(JSON.stringify({ result: { inRepo: true, authed: true } }), {
      headers: { "content-type": "application/json" },
    })
  }
  return nativeFetch(input, init)
}

const { ThreadLifecycleFooter } = await import("./components/ThreadLifecycleFooter.tsx")
const { Composer } = await import("./components/Composer.tsx")
const { GithubTrigger } = await import("./components/GithubTrigger.tsx")
const { TooltipProvider } = await import("./components/Tooltip.tsx")

// Every field the footer's availability check and its children read. A BROKER-backed, live, snoozed
// Claude session is the one state that renders all seven marks at once — which is the state the
// maintainer screenshotted.
const thread = {
  id: "icon-rhythm-demo",
  title: "Icon rhythm",
  status: "active",
  state: "active",
  mechanism: null,
  humanBlocked: false,
  needsYou: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "claude",
  claudeRuntime: "broker",
  permissionMode: "default",
  sessionId: "icon-rhythm-session",
  subAgents: [],
  bgShells: [],
  // Drives the ContextMeter's arc. 62% is a mid-fill dial — a nearly-empty or nearly-full ring paints
  // a different amount of ink, and the point of this fixture is to compare ink.
  context: { tokens: 124_000, window: 200_000 },
  // Drives PendingSnooze's hourglass. Far enough out that it stays in the future for any run.
  snoozedUntil: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
} as unknown as ThreadView

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function Fixture() {
  // Non-empty so the send button paints its ACTIVE fill — the brightest mark in the rail, and the one
  // the GitHub icon is read against.
  const [value, setValue] = useState("Measure the rail.")
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <main className="min-h-screen bg-bg p-8">
          <div className="flex w-[720px] flex-col gap-8">
            <section className="flex flex-col gap-2">
              <h2 className="text-[11px] uppercase tracking-wide text-muted">Thread lifecycle footer</h2>
              {/* The queue-card shape (non-sticky), inside a shell so the strip's border and fill land
                  the way they do on a real card. */}
              <div data-footer-shell className="overflow-hidden rounded-lg border border-border bg-panel">
                <div className="h-16" />
                <ThreadLifecycleFooter thread={thread} />
              </div>
            </section>
            <section className="flex flex-col gap-2">
              <h2 className="text-[11px] uppercase tracking-wide text-muted">Composer rail · with a rail action</h2>
              <Composer
                value={value}
                onChange={setValue}
                onSubmit={() => {}}
                surface="iconRhythmFixture"
                placeholder="Ask anything"
                leftAction={<GithubTrigger />}
              />
            </section>
            {/* The commoner shape: every reply and queue composer renders WITHOUT a rail action, and the
                paperclip then takes the rail-action slot so its ink keeps the same distance off the send
                button. Measured here rather than assumed — it is a different offset on a different code
                path, and it is the one most users look at all day. */}
            <section data-plain-rail className="flex flex-col gap-2">
              <h2 className="text-[11px] uppercase tracking-wide text-muted">Composer rail · no rail action</h2>
              <Composer
                value={value}
                onChange={setValue}
                onSubmit={() => {}}
                surface="iconRhythmFixturePlain"
                placeholder="Ask anything"
              />
            </section>
          </div>
        </main>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
