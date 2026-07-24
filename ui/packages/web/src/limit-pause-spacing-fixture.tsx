import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { Hourglass } from "lucide-react"
import type { LimitPause } from "@fray-ui/shared"
import { LimitPauseCard } from "./components/ChatView.tsx"
import "./styles.css"

// Browser QA for the usage-limit pause card's vertical spacing. The reported "garbage spacing" was the
// old items-start layout leaving the (tallest) Continue button hanging below the sentence inside the
// card's padding. This fixture renders the OLD layout (static replica) directly above the REAL, updated
// LimitPauseCard so the before/after is one screenshot, at both a wide and a narrow width.

const SLUG = "limit-pause-spacing"

// 8:00 PM today → the exact "continuing automatically at 8:00 PM." wording from the report.
const eightPm = new Date()
eightPm.setHours(20, 0, 0, 0)
const sessionPause: LimitPause = {
  backend: "claude",
  window: "session",
  at: new Date().toISOString(),
  resumesAt: Math.round(eightPm.getTime() / 1000),
  autoResume: true,
}

// The OLD layout, byte-for-byte on the classes that shipped, so the screenshot shows what changed.
function LimitPauseCardOld() {
  return (
    <div data-limit-pause-old className="flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-md border border-amber-500/40 bg-panel-2 px-3 py-2 text-[12px]">
      <Hourglass size={13} className="mt-[2px] shrink-0 text-amber-400" />
      <span className="min-w-[12rem] flex-1 text-fg/90">
        <span className="font-medium">Paused by the Claude session limit</span>
        {" — continuing automatically at 8:00 PM."}
      </span>
      <button className="ml-auto shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90">Continue now</button>
    </div>
  )
}

function Row({ label, width, children }: { label: string; width: number; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] text-muted">{label} · {width}px</p>
      <div style={{ width }} className="min-w-0">{children}</div>
    </div>
  )
}

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-8 text-fg">
      <div className="mx-auto max-w-[820px] space-y-8">
        <section className="space-y-3">
          <h2 className="text-[13px] font-semibold text-amber-300/90">BEFORE — items-start (button hangs below the sentence)</h2>
          <Row label="wide (single line)" width={720}><LimitPauseCardOld /></Row>
          <Row label="narrow (sentence wraps / button drops)" width={360}><LimitPauseCardOld /></Row>
        </section>
        <section className="space-y-3">
          <h2 className="text-[13px] font-semibold text-emerald-300/90">AFTER — items-center (everything vertically centered)</h2>
          <Row label="wide (single line)" width={720}><LimitPauseCard slug={SLUG} sessionId="s1" pause={sessionPause} /></Row>
          <Row label="narrow (sentence wraps / button drops)" width={360}><LimitPauseCard slug={SLUG} sessionId="s1" pause={sessionPause} /></Row>
          <Row label="wide · no clock (once the window resets)" width={720}>
            <LimitPauseCard slug={SLUG} sessionId="s1" pause={{ ...sessionPause, resumesAt: undefined }} />
          </Row>
          <Row label="wide · manual (auto-resume off)" width={720}>
            <LimitPauseCard slug={SLUG} sessionId="s1" pause={{ ...sessionPause, autoResume: false }} />
          </Row>
        </section>
      </div>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Fixture />
  </QueryClientProvider>,
)
