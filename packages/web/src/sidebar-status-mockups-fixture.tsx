import { useEffect, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Settings as SettingsIcon } from "lucide-react"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { Sidebar, IdentityMark, projectIdentity } from "./components/Sidebar.tsx"
import { QuotaChips } from "./components/QuotaBar.tsx"
import { RestartFrizzButton } from "./components/RestartFrizzButton.tsx"
import { StatusBar } from "./components/StatusBar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { STATUS_BAR_ACTION, STATUS_BAR_ICON } from "./lib/statusBar.ts"
import { store } from "./store.ts"
import "./styles.css"

// SIDEBAR-STATUS MOCKUPS (maintainer 2026-08-19: "move the top left status bar contents s.t. they are
// loose along the top of the sidebar prompt box. mock up some options").
//
// Every option renders the REAL <Sidebar/> at a REAL width against a real board, with the status marks
// injected into the prompt box's own wrapper — so each is judged where it will actually live, not in a
// swatch. `?option=` picks one:
//
//   current  — today's floating top-left chip, for the before/after
//   a        — one loose line, SPLIT: identity left, actions + quota right
//   b        — one loose line, LEFT-PACKED, today's hairline dividers kept
//   c        — TWO lines: identity + actions on top, quota beneath
//   d        — one loose line, actions ride the IDENTITY, quota pinned right
//   e        — QUIET: identity + quota only; the actions fade in on hover (?hover=1 forces them on)
//   f        — A, plus the NARROW-WIDTH fix: under a 330px sidebar the connection WORD drops and the
//              dot carries the state alone, so the repo name never truncates (see the note below)
//
// `?font=mono` flips the type family — the app renders in two (html[data-font], applied before first
// paint) and a fixture that leaves it unset silently renders mono.
// `?w=` is only advisory; the shot's viewport width is what drives the sidebar's clamp().

const params = new URLSearchParams(location.search)
const option = params.get("option") ?? "a"
const forceHover = params.get("hover") === "1"
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"

// ── stubbed reads ────────────────────────────────────────────────────────────────────────────────
// The bar's three live readings (quota, auth, restart-capability) have no source in a fixture, so the
// gear/reload pair and both quota percentages would otherwise render as placeholders forever.
const nowSeconds = Math.floor(Date.now() / 1000)
const windows = (fiveHour: number, weekly: number) => [
  { key: "5h", label: "5h", usedPercent: fiveHour, resetsAt: nowSeconds + 2 * 3600 },
  { key: "weekly", label: "Weekly", usedPercent: weekly, resetsAt: nowSeconds + 3 * 86400 },
]
const quota = {
  claude: { status: "ok", planType: "max", windows: windows(17, 38) },
  codex: { status: "ok", planType: "pro", windows: windows(41, 29) },
}
const auth = { claude: "authed", codex: "authed", emails: { claude: "colin@pullfrog.com", codex: "colinmcd94@gmail.com" } }
const codexModels = [
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high"] },
]
const preferences = {
  backend: "claude",
  claude: { model: "opus", effort: "high", permissionMode: "auto" },
  codex: { model: "gpt-5.6-sol", effort: "medium", permissionMode: "default" },
}

const nativeFetch = window.fetch.bind(window)
const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
  const url = new URL(href, location.origin)
  if (url.pathname === "/_frizz/control/status")
    return new Response(JSON.stringify({ protocol: 1, state: "ready", updateRestart: true }), { headers: { "content-type": "application/json" } })
  if (url.pathname === "/_frizz/rpc/quota") return json(quota)
  if (url.pathname === "/_frizz/rpc/authStatus") return json(auth)
  if (url.pathname === "/_frizz/rpc/dispatchPreferencesGet") return json(preferences)
  if (url.pathname === "/_frizz/rpc/codexModels") return json(codexModels)
  if (url.pathname === "/_frizz/rpc/settingsGet") return json({})
  if (url.pathname.startsWith("/_frizz/rpc/")) return json(null)
  return nativeFetch(input, init)
}

// ── the board ────────────────────────────────────────────────────────────────────────────────────
const base = {
  kind: "session", state: "open", status: "active", mechanism: null, backend: "claude",
  permissionMode: "default", humanBlocked: false, pendingQuestion: false, crashed: false,
  archived: false, foreign: false, ready: false, unread: false, hasPlan: false, dependsOn: [],
  externalDeps: [], errors: [], warnings: [], agents: [], subAgents: [], bgShells: [],
} as const

const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN

const cue = (id: string, title: string, restedMsAgo: number, extra: Partial<ThreadView> = {}) =>
  ({
    ...base, id, title, runtime: "turn-idle", needsYou: true,
    sessionId: `aaaaaaaa-bbbb-cccc-dddd-${id.slice(0, 12).padEnd(12, "0")}`,
    spawnedAt: ago(restedMsAgo + 30 * MIN),
    lastUserAt: ago(restedMsAgo + 25 * MIN),
    lastAssistantAt: ago(restedMsAgo),
    lastActivityAt: ago(Math.max(0, restedMsAgo - 4 * MIN)),
    ...extra,
  }) as unknown as ThreadView

const threads: ThreadView[] = [
  cue("fix-queue-focus", "Fix queue focus after an archive", 2 * HOUR),
  cue("rewrite-the-shutdown-path", "Rewrite the shutdown path so a detached broker daemon is reaped on exit", 5 * HOUR),
  cue("ship-it", "Ship it", 14 * MIN),
  {
    ...base, id: "sweep-tailer-nudges", title: "Sweep the tailer nudge regressions", runtime: "running",
    needsYou: false, sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000009",
    activity: "Replaying the nudge fixture", lastActivityAt: ago(20_000), lastUserAt: ago(9 * MIN),
  } as unknown as ThreadView,
  {
    ...base, id: "audit-broker-crash-paths", title: "Audit every exit path the broker can take",
    runtime: "turn-idle", needsYou: false, sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000010",
    subAgents: [{ id: "c1", label: "Trace the SIGTERM path", subagentType: "frizz:opus-medium", startedAt: ago(3 * MIN), state: "running" }],
    lastActivityAt: ago(60_000), lastUserAt: ago(22 * MIN),
  } as unknown as ThreadView,
]

store.board = { projectDir: "/fixture/frizz", projectLabel: "colinhacks/frizz", threads, plans: [] } as unknown as BoardSnapshot
store.drawers = []

const identity = projectIdentity({ projectLabel: "colinhacks/frizz" })

// ── the marks, as three reusable groups ──────────────────────────────────────────────────────────
function Actions({ className = "" }: { className?: string }) {
  // Same 24px targets and the same `-mx-1.5` ink trim the shipped bar uses (lib/statusBar.ts), so the
  // rhythm inside this pair is already the measured one — only the row around it is new.
  return (
    <span className={`flex shrink-0 items-center gap-3 ${className}`}>
      <button type="button" aria-label="Settings" title="Settings" className={STATUS_BAR_ACTION}>
        <SettingsIcon size={STATUS_BAR_ICON} aria-hidden="true" />
      </button>
      <RestartFrizzButton />
    </span>
  )
}

function Divider() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
}

// Every loose row shares this: no fill, no border, no shadow — it sits ON the page, flush with the
// composer's own outer edge, and `mb-2.5` is the only thing holding it off the prompt box.
function LooseRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div data-loose-status className={`mb-2.5 flex min-w-0 items-center gap-3 text-[12px] ${className}`}>{children}</div>
}

function OptionA() {
  return (
    <LooseRow>
      <IdentityMark identity={identity} state="open" />
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <Actions />
        <Divider />
        <QuotaChips />
      </span>
    </LooseRow>
  )
}

function OptionB() {
  return (
    <LooseRow>
      <IdentityMark identity={identity} state="open" />
      <Divider />
      <Actions />
      <Divider />
      <QuotaChips />
    </LooseRow>
  )
}

function OptionC() {
  return (
    <div data-loose-status className="mb-2.5 flex min-w-0 flex-col gap-1.5 text-[12px]">
      <div className="flex min-w-0 items-center gap-3">
        <IdentityMark identity={identity} state="open" />
        <Actions className="ml-auto" />
      </div>
      <QuotaChips />
    </div>
  )
}

function OptionD() {
  return (
    <LooseRow>
      <IdentityMark identity={identity} state="open" />
      <Actions />
      <span className="ml-auto shrink-0">
        <QuotaChips />
      </span>
    </LooseRow>
  )
}

function OptionE() {
  return (
    <LooseRow className="group">
      <IdentityMark identity={identity} state="open" />
      <Actions className={`transition-opacity ${forceHover ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"} ml-auto`} />
      <span className="shrink-0">
        <QuotaChips />
      </span>
    </LooseRow>
  )
}

// THE NARROW-SIDEBAR PROBLEM, and one fix for it. The sidebar floors at 272px in the tablet band, and
// all six marks do not fit: measured at an 820px viewport the repo truncates to "f…" in every one-line
// option, and to NOTHING in the left-packed one — the single reading that must survive is the first
// one dropped. Today's floating bar never hit this because it was capped to the VIEWPORT, not to the
// sidebar column.
//
// The cheapest thing to give up is the connection WORD: the dot already carries the state, and
// "connected" is the reading nobody looks at. Dropping it below a 330px column frees ~72px — enough
// for the full repo name at the 272px floor, with room left over.
//
// In a fixture that is a stylesheet; in the real component it would be a prop on IdentityMark, since
// the connection cluster is its own last child and nothing else should be reaching into it.
const TIGHT_IDENTITY_CSS = `
@container (max-width: 330px) {
  [data-tight-identity] [data-project-identity-state] > span:last-child > span:last-child { display: none; }
}
`

function OptionF() {
  return (
    <>
      <style>{TIGHT_IDENTITY_CSS}</style>
      <div data-tight-identity className="@container">
        <OptionA />
      </div>
    </>
  )
}

const OPTIONS: Record<string, () => ReactNode> = { a: OptionA, b: OptionB, c: OptionC, d: OptionD, e: OptionE, f: OptionF }

// ── injection ────────────────────────────────────────────────────────────────────────────────────
// The mockup belongs INSIDE the sidebar's prompt-box wrapper, above <DispatchForm/>. Rather than fork
// Sidebar for a mockup, find that wrapper after mount (it is the rail's previous sibling) and portal
// into a host prepended to it. If the shape ever changes this fails LOUDLY rather than quietly
// rendering an option that is not where it claims to be.
function PromptBoxTopSlot({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const rail = document.querySelector("[data-sidebar-rail]")
    const wrapper = rail?.previousElementSibling
    if (!(wrapper instanceof HTMLElement)) throw new Error("mockup fixture: could not find the sidebar's prompt-box wrapper")
    // Marks the crop target for `shot.mjs --clip`, so the strip can be photographed at a scale where
    // its alignment is actually judgeable instead of as a 30px band inside a 1440px frame.
    wrapper.setAttribute("data-mockup-crop", "")
    const el = document.createElement("div")
    wrapper.prepend(el)
    setHost(el)
    return () => el.remove()
  }, [])
  return host ? createPortal(children, host) : null
}

const Option = OPTIONS[option]

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <div className="relative flex min-h-screen justify-center gap-[clamp(28px,3.4vw,52px)] bg-bg px-5 text-fg text-sm">
        {option === "current" && <StatusBar identity={identity} connection="open" />}
        <Sidebar />
        {/* A stand-in workpane, so the sidebar is judged beside content rather than against a void. */}
        <div className="min-w-0 w-[720px] shrink pt-24">
          <div className="rounded-xl border border-border bg-panel p-4">
            <div className="text-[13px] font-medium text-fg">Fix queue focus after an archive</div>
            <div className="mt-2 text-[12px] leading-relaxed text-muted">
              The queue card stands in for the workpane here; the mockup is the strip above the prompt box.
            </div>
          </div>
        </div>
        {option !== "current" && Option && <PromptBoxTopSlot><Option /></PromptBoxTopSlot>}
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
