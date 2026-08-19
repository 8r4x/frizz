import { useEffect, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { House, Settings as SettingsIcon } from "lucide-react"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { Sidebar, projectIdentity } from "./components/Sidebar.tsx"
import { QuotaChips } from "./components/QuotaBar.tsx"
import { RestartFrizzButton } from "./components/RestartFrizzButton.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "./lib/statusRow.ts"
import { ICON_LABEL_NUDGE } from "./lib/iconAlign.ts"
import { store, type ConnectionState } from "./store.ts"
import "./styles.css"

// STATUS-ROW MOCKUPS — the MIRRORED arrangement (maintainer 2026-08-19: "have a home icon on the far
// left, then the settings icon, then the restart icon, then the divider, then the agent readouts. All
// of this is left justified, then right justified. We just have the dot indicator, the green dot,
// followed by the name of the project").
//
//   home · settings · reload │ Claude · Codex                              ● project-name
//
// It inverts what shipped: the CONTROLS take the left edge and the IDENTITY becomes the right-hand
// readout, and the connection dot comes back — the DOT, not the word "connected", paired with the name
// it qualifies. Each option renders the REAL <Sidebar/> at a real width with the row injected into the
// prompt box's own wrapper, so it is judged where it will live.
//
//   ?option=mirror    — the arrangement above
//   ?option=mirror-b  — the same, with the home icon set off by its own divider
//   ?remote=none      — a git repo with NO ORIGIN REMOTE, which shows its directory name
//   ?connection=connecting|closed
//   ?font=mono

const params = new URLSearchParams(location.search)
const option = params.get("option") ?? "mirror"
const connection = (params.get("connection") ?? "open") as ConnectionState
const noRemote = params.get("remote") === "none"
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"

const nowSeconds = Math.floor(Date.now() / 1000)
const windows = (fiveHour: number, weekly: number) => [
  { key: "5h", label: "5h", usedPercent: fiveHour, resetsAt: nowSeconds + 2 * 3600 },
  { key: "weekly", label: "Weekly", usedPercent: weekly, resetsAt: nowSeconds + 3 * 86400 },
]

const nativeFetch = window.fetch.bind(window)
const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
  const url = new URL(href, location.origin)
  if (url.pathname === "/_frizz/control/status")
    return new Response(JSON.stringify({ protocol: 1, state: "ready", updateRestart: true }), { headers: { "content-type": "application/json" } })
  if (url.pathname === "/_frizz/rpc/quota")
    return json({
      claude: { status: "ok", planType: "max", windows: windows(17, 38) },
      codex: { status: "ok", planType: "pro", windows: windows(41, 29) },
    })
  if (url.pathname === "/_frizz/rpc/authStatus")
    return json({ claude: "authed", codex: "authed", emails: { claude: "colin@pullfrog.com", codex: "colinmcd94@gmail.com" } })
  if (url.pathname === "/_frizz/rpc/dispatchPreferencesGet")
    return json({ backend: "claude", claude: { model: "opus", effort: "high", permissionMode: "auto" }, codex: { model: "gpt-5.6-sol", effort: "medium", permissionMode: "default" } })
  if (url.pathname === "/_frizz/rpc/codexModels")
    return json([{ slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high"] }])
  if (url.pathname.startsWith("/_frizz/rpc/")) return json(null)
  return nativeFetch(input, init)
}

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

const cue = (id: string, title: string, restedMsAgo: number) =>
  ({
    ...base, id, title, runtime: "turn-idle", needsYou: true,
    sessionId: `aaaaaaaa-bbbb-cccc-dddd-${id.slice(0, 12).padEnd(12, "0")}`,
    spawnedAt: ago(restedMsAgo + 30 * MIN), lastUserAt: ago(restedMsAgo + 25 * MIN),
    lastAssistantAt: ago(restedMsAgo), lastActivityAt: ago(Math.max(0, restedMsAgo - 4 * MIN)),
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
]

// A NO-REMOTE repo is exactly what the server sends: `projectLabel` falls back to the directory
// basename, so the label simply has no slash in it.
store.board = {
  projectDir: noRemote ? "/Users/me/scratch-pad" : "/fixture/frizz",
  projectName: noRemote ? "scratch-pad" : "frizz",
  projectLabel: noRemote ? "scratch-pad" : "colinhacks/frizz",
  threads,
  plans: [],
} as unknown as BoardSnapshot
store.drawers = []
store.connection = connection

// ── the mirrored row ─────────────────────────────────────────────────────────────────────────────
function Divider() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
}

// The connection DOT, without the word. It is the whole reading now, so it keeps every state's colour
// — a green dot that is only ever green would be the decoration that was just removed.
function ConnectionDot({ state }: { state: ConnectionState }) {
  const map = {
    open: { cls: "bg-live", word: "connected" },
    connecting: { cls: "bg-accent", word: "connecting…" },
    closed: { cls: "bg-red-500", word: "disconnected" },
  } as const
  const m = map[state]
  return <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${m.cls}`} role="img" aria-label={m.word} title={m.word} />
}

function ProjectName() {
  const identity = projectIdentity(store.board)
  const name = identity.state === "verified" ? identity.repo : identity.state === "local" ? identity.name : null
  const title = identity.state === "verified" ? identity.label : name ?? undefined
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ConnectionDot state={connection} />
      {name ? (
        <span className="block min-w-0 truncate font-semibold text-fg/90" title={title}>{name}</span>
      ) : (
        <span className="identity-placeholder w-24" aria-hidden="true" />
      )}
    </span>
  )
}

function Actions() {
  return (
    <>
      <a href="/" title="All projects" aria-label="All projects" className={STATUS_ROW_ACTION}>
        <House size={STATUS_ROW_ICON} aria-hidden="true" className={ICON_LABEL_NUDGE} />
      </a>
      <button type="button" aria-label="Settings" title="Settings" className={STATUS_ROW_ACTION}>
        <SettingsIcon size={STATUS_ROW_ICON} aria-hidden="true" />
      </button>
      <RestartFrizzButton />
    </>
  )
}

// The arrangement as described: home, settings, reload, ONE divider, then the quota readouts — all of
// it left — and the dot + name pushed to the right edge.
function Mirror() {
  return (
    <div data-status-row className="mb-2.5 flex min-w-0 items-center gap-3 text-[12px]">
      <Actions />
      <Divider />
      <QuotaChips />
      <span className="ml-auto flex min-w-0 items-center">
        <ProjectName />
      </span>
    </div>
  )
}

// The same, with the home crumb set off by its own divider. Home is a NAVIGATION door out of this
// project; settings and reload act on the app you are already in. One divider groups all three as
// "buttons"; two say the first one leaves.
function MirrorB() {
  return (
    <div data-status-row className="mb-2.5 flex min-w-0 items-center gap-3 text-[12px]">
      <a href="/" title="All projects" aria-label="All projects" className={STATUS_ROW_ACTION}>
        <House size={STATUS_ROW_ICON} aria-hidden="true" className={ICON_LABEL_NUDGE} />
      </a>
      <Divider />
      <button type="button" aria-label="Settings" title="Settings" className={STATUS_ROW_ACTION}>
        <SettingsIcon size={STATUS_ROW_ICON} aria-hidden="true" />
      </button>
      <RestartFrizzButton />
      <Divider />
      <QuotaChips />
      <span className="ml-auto flex min-w-0 items-center">
        <ProjectName />
      </span>
    </div>
  )
}

const OPTIONS: Record<string, () => ReactNode> = { mirror: Mirror, "mirror-b": MirrorB }

// The mockup belongs INSIDE the sidebar's prompt-box wrapper. Rather than fork Sidebar, find that
// wrapper after mount (it is the rail's previous sibling) and portal into a host prepended to it —
// failing LOUDLY if the shape ever changes, rather than quietly rendering somewhere else.
function PromptBoxTopSlot({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const rail = document.querySelector("[data-sidebar-rail]")
    const wrapper = rail?.previousElementSibling
    if (!(wrapper instanceof HTMLElement)) throw new Error("mockup fixture: could not find the sidebar's prompt-box wrapper")
    wrapper.setAttribute("data-mockup-crop", "")
    // The shipped row renders inside Sidebar already; a mockup must REPLACE it, not stack under it.
    wrapper.querySelector("[data-status-row]")?.remove()
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
        <Sidebar />
        <div className="min-w-0 w-[720px] shrink pt-24">
          <div className="rounded-xl border border-border bg-panel p-4">
            <div className="text-[13px] font-medium text-fg">Fix queue focus after an archive</div>
            <div className="mt-2 text-[12px] leading-relaxed text-muted">
              The queue card stands in for the workpane; the mockup is the strip above the prompt box.
            </div>
          </div>
        </div>
        {Option && <PromptBoxTopSlot><Option /></PromptBoxTopSlot>}
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
