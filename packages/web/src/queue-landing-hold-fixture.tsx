import { useEffect } from "react"
import { createRoot } from "react-dom/client"
import { proxy, useSnapshot } from "valtio"
import type { ThreadView } from "@frizz/shared"
import { activeSidebarSection, type SidebarSectionGeometry } from "./lib/sidebarScrollspy.ts"
import { resolveRoutedThread, store } from "./store.ts"
import "./styles.css"

// A cold `/thread/<slug>` deep link to the SECOND card of a queue whose cards have not found their
// height yet (queueLandingHold.e2e.test.ts). The real board renders skeleton cards first and grows
// them as transcripts and pictures arrive; here the test grows them by hand (`__grow`) so it decides
// exactly when the layout moves relative to the landing.
//
// `?anchor=none` turns off Chrome's native scroll anchoring for the page, so the only thing that can
// keep a card in place once the page is scrolled is the landing hold itself — the test uses it to tell
// "the hold kept it there" from "the browser did".

const thread = (id: string, title: string) =>
  ({ id, kind: "session", title, backend: "claude", runtime: "turn-idle", status: "needs-human", needsYou: true, subAgents: [] }) as unknown as ThreadView

store.board = { threads: [thread("hold-a", "Hold A thread"), thread("hold-b", "Hold B thread")] } as typeof store.board
store.drawers = []

if (new URLSearchParams(location.search).get("anchor") === "none") document.documentElement.style.overflowAnchor = "none"

// Skeleton heights: short enough that the whole page fits the viewport, exactly like the measured cold
// load (the document was 900px tall at a 900px viewport when the routed landing ran).
const heights = proxy<Record<string, number>>({ "hold-a": 160, "hold-b": 120 })

declare global {
  interface Window {
    __route: (slug: string) => void
    __grow: (slug: string, px: number) => void
    __spy: () => string | null
  }
}

window.__route = (slug) => { store.routeThreadSlug = slug }
window.__grow = (slug, px) => { heights[slug] = (heights[slug] ?? 0) + px }
// The sidebar's reading marker, from the same geometry and the same rule the rail uses (Sidebar.tsx
// syncActiveSection): what the rail would select for this screen.
window.__spy = () => {
  const items = [...document.querySelectorAll<HTMLElement>('[data-queue-card][data-queue-leaving="false"]')].map((slot): SidebarSectionGeometry => {
    const { top, bottom } = (slot.querySelector<HTMLElement>("[data-queue-card-root]") ?? slot).getBoundingClientRect()
    return { id: slot.dataset.queueCard!, top, bottom }
  })
  const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
  return activeSidebarSection(items, window.innerHeight, maxScrollY > 0 && window.scrollY >= maxScrollY - 1)
}

function Card({ id, label }: { id: string; label: string }) {
  const h = useSnapshot(heights)[id]
  return (
    <section data-queue-card={id} data-queue-leaving="false">
      <div data-queue-card-root={id} className="rounded-xl border border-border bg-panel p-5" style={{ height: h }}>{label}</div>
    </section>
  )
}

function Fixture() {
  const snap = useSnapshot(store)
  // App.tsx's routed effect, verbatim in shape: settle the parked slug once the queue has committed.
  useEffect(() => { resolveRoutedThread() }, [snap.routeThreadSlug])
  return (
    <main className="mx-auto max-w-2xl bg-bg px-4 py-5 text-fg">
      <div className="h-24 rounded-lg border border-border p-3 text-muted">prompt box</div>
      <div className="py-8">
        <Card id="hold-a" label="Hold A thread — the card ABOVE, which grows after the landing" />
        <hr className="my-10 border-border" />
        <Card id="hold-b" label="Hold B thread — the deep-linked card" />
      </div>
      {snap.drawers.length > 0 && <aside data-fixture-thread-drawer>drawer open</aside>}
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
