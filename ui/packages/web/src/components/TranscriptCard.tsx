// The shared card chrome every transcript card wears — extracted from ChatView so it can be imported
// by any surface without importing the whole thread view (and without a module cycle). The comments
// below are the maintainer-settled rules for these shapes; they moved here verbatim.
import { useMemo, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { mdToHtml } from "../lib/markdown.ts"
import { ICON_LABEL_NUDGE } from "../lib/iconAlign.ts"

// Queue cards live in the narrow needs-you rail, so a worker message carrying a long UNBREAKABLE token
// — a Windows path, a box-drawing error dump — must wrap at the character level rather than bleed past
// the card edge (maintainer 2026-07-10: it "looks so bad"). Applied ONLY in the dense (queue) surface:
// `overflow-wrap:anywhere` breaks unbreakable PROSE runs to fit, and code fences additionally get
// `whitespace-pre-wrap` + `break-all` so their long lines wrap INSIDE the <pre> instead of forcing the
// horizontal scroll/overflow. The roomier thread view keeps its scroll-on-overflow default (wrap=false).
export const QUEUE_WRAP = "[overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap [&_pre]:break-all"

// ── The shared card chrome ────────────────────────────────────────────────────────────────────────
// Every card the transcript sets off from the prose — the ```done / ```awaiting signal fences, a
// ```question block, and the runtime banners (permission, provider fault, usage-limit pause, native
// input) — wears the SAME two parts, so they read as one family rather than a pile of one-off shapes
// (maintainer 2026-07-24: "I like the little checkmark with the Done label — we should have something
// similar for all the other kinds of cards").

// Part one: the kind header. A small glyph plus the kind in quiet uppercase, at the card's top-left.
// It is the card's IDENTITY, so it never carries prose — the sentence belongs in the body below.
export function CardKind({
  icon: Icon,
  label,
  tone = "text-muted/70",
}: {
  icon: LucideIcon
  label: ReactNode
  // The kind's own color language: muted by default, red for danger/fault, amber for a pause, accent
  // for "this one is waiting on you".
  tone?: string
}) {
  return (
    <div className={`mb-1.5 flex items-center gap-1 text-[10px] uppercase tracking-wide ${tone}`}>
      <Icon size={12} className={`shrink-0 ${ICON_LABEL_NUDGE}`} />
      {label}
    </div>
  )
}

// The card's MEANING, and the ONLY thing allowed to vary between kinds (maintainer 2026-07-24: the
// styling across kinds was "vastly different… almost no consistency"). Every card is otherwise the
// same shell — same fill, same border weight, same padding, same body scale, same action row — so a
// tone is a two-token swap on the border and the kind header, never a different card:
//   neutral   — a statement of fact (done, awaiting, a question)
//   attention — the agent is BLOCKED on you, answerable only in your external terminal
//   caution   — fray paused itself and will continue on its own (a usage limit)
//   danger    — something is broken or the action is irreversible (sign-in fault, a destructive gate)
//
// Only THREE border colors, though: `caution` keeps the neutral border and says its piece in an amber
// kind header. Its amber and the accent gold sit ~15° apart on the wheel, so as two lit borders they
// were indistinguishable — and a self-resolving pause must never compete for the eye with "your agent
// is stuck waiting on you". Border = how loud; the header = what it is.
export type CardTone = "neutral" | "attention" | "caution" | "danger"
const CARD_TONES: Record<CardTone, { border: string; kind: string }> = {
  neutral: { border: "border-border-strong", kind: "text-muted/70" },
  attention: { border: "border-accent/45", kind: "text-accent/80" },
  caution: { border: "border-border-strong", kind: "text-amber-400" },
  danger: { border: "border-red-500/45", kind: "text-red-400" },
}

// Part two: the SHELL. One rounded panel-2 card at one padding for every kind. Cards used to disagree
// about all three of fill (panel-2 / elevated / an accent or red wash), border color, and whether they
// carried a shadow — which is what made nine sibling cards read as nine unrelated shapes.
export function TranscriptCard({
  tone = "neutral",
  icon,
  label,
  children,
  className = "",
  ...rest
}: {
  tone?: CardTone
  icon: LucideIcon
  label: ReactNode
  children: ReactNode
  className?: string
} & Omit<ComponentPropsWithoutRef<"div">, "children" | "className">) {
  return (
    <div {...rest} className={`min-w-0 rounded-lg border ${CARD_TONES[tone].border} bg-panel-2 px-4 py-3 ${className}`}>
      <CardKind icon={icon} label={label} tone={CARD_TONES[tone].kind} />
      {children}
    </div>
  )
}

// Part three: the body copy. One scale for every card's sentence, so a two-line explanation in one
// card is not visibly larger than the same sentence in the card above it.
export const CARD_BODY = "block min-w-0 text-[12px] leading-5 text-fg/85"

// Part two: the action row, ALWAYS right-justified (maintainer 2026-07-24). A card's buttons are its
// trailing verb; hung on the left they read as another paragraph of the body and every card disagreed
// with every other about where to look for the action. Any explainer text passed as the first child
// takes the leftover width (`flex-1 min-w-0`) and wraps its own lines there, so the button still
// anchors the right edge on a narrow queue card instead of being pushed onto its own line.
export function CardActions({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mt-3 flex flex-wrap items-center justify-end gap-x-2.5 gap-y-2 ${className}`}>{children}</div>
}

// The primary (light-on-dark) verb EVERY card's main action wears — the done card's white
// "Mark as done" chrome. Exported because this is a rule, not a per-card choice (maintainer 2026-07-24:
// the buttons inside these cards should ALWAYS be white): a card is a request for one action, and the
// recessed outlined chrome some of them wore read as a secondary — or worse, disabled — affordance.
// The ONLY departure is a genuinely secondary sibling standing beside the primary (the provider-fault
// card's "Retry" next to "Sign in"), which stays outlined so the pair keeps a hierarchy.
export const CARD_PRIMARY_BUTTON = "bg-fg px-2.5 py-1 text-bg hover:opacity-90"
// The same verb with the icon+label layout every card action uses. Cards differ only in what they pass
// beyond this (shrink-0, a disabled treatment), never in the fill.
export const CARD_PRIMARY_ACTION = `flex shrink-0 items-center gap-1 rounded-md text-[11px] font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/60 ${CARD_PRIMARY_BUTTON}`
