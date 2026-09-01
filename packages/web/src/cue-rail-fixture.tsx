import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { Sidebar } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for THE CUE (maintainer 2026-08-08): the rested band moved to the TOP of the rail, right
// under the prompt box, with the running band beneath it — and every cue row now carries a
// right-justified label saying when that thread came to rest.
//
// Renders the REAL <Sidebar/> over a board built to exercise exactly what the change can get wrong:
//
//   CUE (top, queue order)          the rest-time column, at four magnitudes and three title lengths
//     · just now / minutes / hours / days — the widest reading ("14m") against the shortest
//     · a LONG title that wraps to three lines: the label must stay on the FIRST line, right-justified,
//       and must not be squeezed or wrapped by the title beside it
//     · a SHORT title: the label must hold the same right edge as every other row (it is a COLUMN —
//       a title's length must not decide where its timestamp sits)
//   ── rule ──
//   ACTIVE (below)                  NO rest-time column: a spinning row has not handed anything back
//   HELD (dimmed, collapsed)        unchanged, still last before Done
//
// TWO FONTS: the prose/UI font is a user setting and every glyph placed beside text ships against two
// different cap heights, so this fixture takes `?font=mono` and defaults to `sans` (index.html's own
// default). Judge the label's baseline in BOTH — a fixture that leaves `data-font` unset silently
// renders mono and hides half the answer.

const font = new URLSearchParams(location.search).get("font") === "mono" ? "mono" : "sans"
document.documentElement.dataset.font = font

const base = {
  kind: "session",
  state: "open",
  status: "active",
  mechanism: null,
  backend: "claude",
  permissionMode: "default",
  humanBlocked: false,
  pendingQuestion: false,
  crashed: false,
  archived: false,
  foreign: false,
  ready: false,
  unread: false,
  hasPlan: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  subAgents: [],
  bgShells: [],
} as const

// Anchored to the LOAD instant so the readings are the same every run, whenever the fixture is opened.
const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// A cue row: at rest with a queue card behind it (needsYou), dated by its own last output.
const cue = (id: string, title: string, restedMsAgo: number, extra: Partial<ThreadView> = {}) =>
  ({
    ...base,
    id,
    title,
    runtime: "turn-idle",
    needsYou: true,
    sessionId: `aaaaaaaa-bbbb-cccc-dddd-${id.slice(0, 12).padEnd(12, "0")}`,
    spawnedAt: ago(restedMsAgo + 30 * MIN),
    lastUserAt: ago(restedMsAgo + 25 * MIN),
    lastAssistantAt: ago(restedMsAgo),
    // Deliberately LATER than the rest instant: a background sub-agent's completion bumps this, and the
    // column must ignore it — it dates the agent's own rest, not the tailer's last record of any kind.
    lastActivityAt: ago(Math.max(0, restedMsAgo - 4 * MIN)),
    ...extra,
  }) as unknown as ThreadView

const threads: ThreadView[] = [
  cue("fix-queue-focus", "Fix queue focus after an archive", 2 * DAY),
  cue(
    "rewrite-the-shutdown-path-so-a-detached-broker-daemon-is-reaped",
    "Rewrite the shutdown path so a detached broker daemon is reaped on exit instead of outliving its server",
    5 * HOUR,
  ),
  cue("ship-it", "Ship it", 14 * MIN),
  cue("align-the-composer-icons", "Align the composer icons", 20_000, {
    // A legacy `.frizz` activity gloss, kept as data the row must IGNORE: a rail row is a title and
    // nothing else (2026-08-19), so this string must not appear anywhere under it.
    activity: "Measuring the chevron's ink box",
  }),
  // THE ROW THAT USED TO CARRY A SUBTITLE: at rest with a live background shell (the pulsing dot) and a
  // fence naming the PR it registered a watcher on. It printed "PR Homebrew/homebrew-core#298614" under
  // its title until 2026-08-19; now the ref is on the indicator's popover and the row is a title alone.
  cue("investigate-homebrew-core-tap", "Investigate homebrew core tap submission for nub", 5 * MIN, {
    awaitingBackground: true,
    bgShells: [{ id: "bzvtnt3ig", label: "brew audit", startedAt: ago(4 * MIN), state: "running" }],
    // A fence written the CURRENT way: frontmatter, a `---`, then Markdown. The prose lives in the BODY
    // and there is no `reason:` line at all — a key retired outright on 2026-08-24, when the frontmatter
    // became YAML and could no longer hold prose. This is the shape the popover has to read, and the one
    // it dropped on the floor while it read only the hint.
    lastFence: {
      kind: "awaiting",
      body: [
        "The tap submission is queued behind their CI backlog.",
        "",
        "- the audit passes locally, so this is their queue rather than the formula",
        "- if it goes red I will re-run rather than resubmit",
      ].join("\n"),
      hints: [
        { kind: "pr", value: "Homebrew/homebrew-core#298614" },
        { kind: "shell", value: "bzvtnt3ig" },
        { kind: "for", value: "2h" },
      ],
    },
  } as Partial<ThreadView>),
  // A STALLED cue row: `offersRetry`, so the hover-revealed Retry button is pinned to the SAME right
  // edge as the rest time. The label has to yield to it rather than be half-covered by it.
  cue("kill-the-tailer-flake", "Kill the tailer flake", 47 * MIN, { runtime: "exited", crashed: true }),
  // ── the running band, below the rule: no rest-time column on any of these ──
  {
    ...base,
    id: "sweep-tailer-nudges",
    title: "Sweep the tailer nudge regressions",
    runtime: "running",
    needsYou: false,
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000009",
    activity: "Replaying the nudge fixture",
    lastActivityAt: ago(20_000),
    lastUserAt: ago(9 * MIN),
  } as unknown as ThreadView,
  {
    ...base,
    id: "audit-broker-crash-paths",
    title: "Audit every exit path the broker can take",
    runtime: "turn-idle",
    needsYou: false,
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000010",
    subAgents: [{ id: "c1", label: "Trace the SIGTERM path", subagentType: "frizz:opus-medium", startedAt: ago(3 * MIN), state: "running" }],
    lastActivityAt: ago(60_000),
    lastUserAt: ago(22 * MIN),
  } as unknown as ThreadView,
  // ── held, dimmed and collapsed: the band order below the cue is otherwise unchanged ──
  {
    ...base,
    id: "migrate-session-schema",
    title: "Migrate the session schema",
    runtime: "turn-idle",
    needsYou: false,
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000011",
    lastFence: { kind: "awaiting", body: "", hints: [{ kind: "shell", value: "@dana — schema review" }] },
    lastAssistantAt: ago(40 * MIN),
    lastActivityAt: ago(40 * MIN),
    lastUserAt: ago(70 * MIN),
  } as unknown as ThreadView,
]

// `projectLabel` is what the StatusRow above the prompt box renders as this board's identity; without
// it the rail draws a nameless placeholder where every real board shows its repo.
store.board = { projectDir: "/fixture/frizz", projectLabel: "colinhacks/frizz", threads } as unknown as BoardSnapshot
store.drawers = []

// The rail's composer and its pickers read the ordinary RPC surface; answer everything with the empty
// success envelope so nothing real is hit and no request can fail the render.
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <div className="flex min-h-screen bg-bg text-fg">
        <Sidebar />
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
