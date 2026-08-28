// VERIFICATION FIXTURE for the shipped hover timestamp — not a mockup, and not a hand-rebuilt copy.
//
// It imports the REAL `MessageRow` from `components/MessageTimestamp.tsx` and the REAL `messageStamp`
// from `lib/activityTime.ts`, on the REAL stylesheet, so what renders here is the code that ships.
//
// It also reproduces the one thing a plain fixture would miss: the transcript's rows are
// `absolute … transform: translateY()` (ChatView's virtualizer), which makes EVERY ROW ITS OWN
// STACKING CONTEXT. That is why the reveal — drawn past its row's bottom edge, into the gap the next
// row owns as its top padding — needs `hover:z-20` on the row wrapper to avoid being painted
// underneath. The rows below are stacked exactly that way, at the two gaps that actually occur
// (STEP 14px and META_CARD_STEP 6px), so the failure this guards against is reproduced, not imagined.
//
//   nub exec vite build   then open the inlined bundle
//   (a dev server needs listen(), which this sandbox refuses — hence the static build)
//   ?hover=<n>  paints row n as if hovered, because a camera cannot hold a pointer
import { createRoot } from "react-dom/client"
import { MessageRow } from "./components/MessageTimestamp.tsx"
import { messageStamp } from "./lib/activityTime.ts"
import "./styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
const FORCED = params.has("hover") ? Number(params.get("hover")) : -1
// The reveal is opacity-driven off a real `:hover`, and a camera cannot hold a pointer. Force the ONE
// row under test from OUTSIDE the component — a stylesheet override on its row — rather than adding a
// prop to `MessageRow` that exists only for photography. What renders is still the shipped element,
// at the shipped opacity, in the shipped position.
if (FORCED >= 0) {
  const style = document.createElement("style")
  style.textContent = `[data-verify-row="${FORCED}"] time { opacity: 1 !important; }`
  document.head.appendChild(style)
}

const iso = (daysAgo: number, h: number, m: number) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

// A day apart at nearly the same clock time — the case the unconditional date exists for, and the one
// a bare "10:31 AM" could not tell apart.
const ROWS = [
  { at: iso(1, 17, 42), gap: 14, kind: "user", h: 47, text: "Check whether auto-merge actually armed on #3778 — the queue said false again." },
  { at: iso(0, 9, 14), gap: 14, kind: "agent", h: 30, text: "CI green (85 checks) and mergeState=CLEAN, but auto-merge shows false again. Let me re-arm it." },
  // A TIGHT row: META_CARD_STEP is 6px, well under the 16px reading, so this is where the reveal
  // overflows furthest into its neighbour and where the stacking fix has to hold.
  { at: iso(0, 9, 27), gap: 6, kind: "meta", h: 20, text: "Ran 5 tool calls" },
  { at: iso(0, 10, 31), gap: 14, kind: "agent", h: 52, text: "Already queued — auto=false is just how the queue reports it once it takes the PR. CI is fully green and the state is CLEAN, so it's waiting its turn." },
]

function Body({ kind, text }: { kind: string; text: string }) {
  if (kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] text-bg">{text}</div>
      </div>
    )
  }
  if (kind === "meta") return <div className="text-[14px] leading-5 text-muted">{text}</div>
  return <div className="text-[13px] leading-6 text-fg">{text}</div>
}

function Sheet() {
  let top = 0
  const placed = ROWS.map((r) => {
    const y = top
    top += r.gap + r.h
    return { ...r, y }
  })
  return (
    <div className="mx-auto w-[min(900px,calc(100%-48px))] py-10">
      <h1 className="mb-1 text-[15px] font-semibold text-fg">Trailing reveal — the shipped component</h1>
      <p className="mb-8 max-w-[92ch] text-[12px] leading-5 text-muted/80">
        Real <code className="text-muted/60">MessageRow</code> and real <code className="text-muted/60">messageStamp</code>, on the real
        stylesheet, in transform-positioned rows that reproduce the transcript's virtualizer — so the stacking the reveal depends on is
        genuinely exercised. Row 3 sits at the 6px tight gap, where the reading overflows furthest into its neighbour.
      </p>
      <div className="relative rounded-lg border border-border/60 bg-bg py-6" style={{ height: top + 56 }}>
        {placed.map((r, i) => (
          <div
            key={i}
            className={`absolute left-0 top-0 w-full hover:z-20 ${i === FORCED ? "z-20" : ""}`}
            style={{ transform: `translateY(${r.y}px)` }}
            data-verify-row={i}
          >
            <MessageRow at={r.at} gap={r.gap}>
              <Body kind={r.kind} text={r.text} />
            </MessageRow>
          </div>
        ))}
      </div>
      <p className="mt-6 text-[12px] leading-5 text-muted/80">
        Readings this build produces: {ROWS.map((r) => messageStamp(r.at)).join("   ·   ")}
      </p>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Sheet />)
