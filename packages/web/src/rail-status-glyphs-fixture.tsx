import { createRoot } from "react-dom/client"
import type { ThreadView } from "@frizz/shared"
import { ThreadIndicator } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// EVERY RAIL STATUS MARK, side by side, drawn by the REAL <ThreadIndicator/> — the measuring surface for
// scripts/verify-rail-status-glyphs.mjs. The rail is a checkbox family (one 15px rounded box, a
// different mark inside per state), and a family only reads as one when the marks carry comparable
// optical WEIGHT. That is a pixel question no DOM measurement can answer, so the marks have to render
// somewhere a screenshot can reach them, isolated from row titles and hover affordances.
//
// It renders the shipped component rather than a mock-up on purpose: a reconstruction drifts from the
// thing that ships, and this exists precisely to catch a mark that is wrong in the app.

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
  spawnedAt: "2026-08-01T09:00:00.000Z",
} as const

const liveChild = [{ id: "a1", label: "c", startedAt: "2026-08-01T09:05:00.000Z", state: "running" as const }]

// One thread per state the rail can resolve, named by the kind sessionIndicatorKind returns for it.
const STATES: { kind: string; t: ThreadView }[] = [
  { kind: "working", t: { ...base, id: "working", runtime: "turn-idle", needsYou: false, subAgents: liveChild } as unknown as ThreadView },
  // Shell-only, deliberately: a live sub-agent resolves to `working`, not to this mark. `needsYou: false`
  // because the server excuses a rest on live own work from the queue outright.
  { kind: "background", t: { ...base, id: "background", runtime: "turn-idle", needsYou: false, awaitingBackground: true, bgShells: [{ label: "nub run dev", startedAt: "2026-08-01T09:02:00.000Z", state: "running" }] } as unknown as ThreadView },
  // No background shell on this one, deliberately: the blue dot outranks the heart since 2026-08-02, so
  // a thread carrying both resolves to `background` and the heart would never render here to be measured.
  { kind: "rest", t: { ...base, id: "rest", runtime: "turn-idle", needsYou: true } as unknown as ThreadView },
  { kind: "needs-input", t: { ...base, id: "needs-input", runtime: "turn-idle", needsYou: true, pendingQuestion: true } as unknown as ThreadView },
  { kind: "stalled", t: { ...base, id: "stalled", runtime: "exited", needsYou: true, sessionId: "s" } as unknown as ThreadView },
  { kind: "done", t: { ...base, id: "done", runtime: "turn-idle", needsYou: true, lastFence: { kind: "done", body: "shipped", hints: [] } } as unknown as ThreadView },
  { kind: "snoozed", t: { ...base, id: "snoozed", runtime: "turn-idle", needsYou: false, lastFence: { kind: "awaiting", body: "", hints: [{ kind: "shell", value: "maintainer must approve" }] } } as unknown as ThreadView },
  { kind: "archived", t: { ...base, id: "archived", state: "archived", runtime: "exited", needsYou: false } as unknown as ThreadView },
]

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {/* Flat panel background, matching the rail's own surface — the ink probe reads "anything that
        differs from the corner pixel", so the surface behind every mark must be one flat colour. */}
    <div data-rail-glyphs className="flex items-center gap-6 bg-bg p-6">
      {STATES.map(({ kind, t }) => (
        <span key={kind} className="flex items-center justify-center" title={kind}>
          <ThreadIndicator t={t} />
        </span>
      ))}
    </div>
  </TooltipProvider>,
)
