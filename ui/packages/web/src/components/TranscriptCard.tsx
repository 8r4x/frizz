// The shared card chrome every transcript card wears — extracted from ChatView so it can be imported
// by any surface without importing the whole thread view (and without a module cycle). The comments
// below are the maintainer-settled rules for these shapes; they moved here verbatim.
import { useMemo, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { mdToHtml } from "../lib/markdown.ts"

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
// input) — wears the SAME shell, body scale and action row, so they read as one family rather than a
// pile of one-off shapes
// (maintainer 2026-07-24: "I like the little checkmark with the Done label — we should have something
// similar for all the other kinds of cards").
//
// The ANATOMY is shadcn/ui's Alert, adopted wholesale (maintainer 2026-07-29: "the default shadcn
// call-out or alert box looks way better than ours"). Three rules carry the whole look:
//
//   1. The glyph sits in a fixed LEFT GUTTER — its own grid column — instead of inline at the head of
//      a text line. The gutter is the card's spine.
//   2. The kind is a real TITLE: sentence case, body size, medium weight, full-strength in the tone's
//      own color. It used to be a 10px UPPERCASE eyebrow, which reads as a metadata tag stuck above
//      the card rather than as the card's headline.
//   3. Everything below the title — body copy, option chips, the action row — starts on the TITLE's
//      left edge, not the card's. One vertical line runs the length of the card.
//
// shadcn does this with `grid-cols-[16px_1fr] gap-x-3` + `col-start-2` on the title and description;
// this is the same grid at fray's denser scale.

// The card's MEANING, and the ONLY thing allowed to vary between kinds (maintainer 2026-07-24: the
// styling across kinds was "vastly different… almost no consistency"). Every card is otherwise the
// same shell — same fill, same border weight, same padding, same body scale, same action row — so a
// tone is a two-token swap on the border and the title, never a different card:
//   neutral   — a statement of fact (done, awaiting, a question)
//   attention — the agent is BLOCKED on you, answerable only in your external terminal
//   caution   — fray paused itself and will continue on its own (a usage limit)
//   danger    — something is broken or the action is irreversible (sign-in fault, a destructive gate)
//
// Only THREE border colors, though: `caution` keeps the neutral border and says its piece in an amber
// title. Its amber and the accent gold sit ~15° apart on the wheel, so as two lit borders they were
// indistinguishable — and a self-resolving pause must never compete for the eye with "your agent is
// stuck waiting on you". Border = how loud; the title = what it is.
//
// The tone color lands on the icon AND the title together, exactly as shadcn's `[&>svg]:text-current`
// makes the glyph inherit its variant's foreground: they are one object, and a red glyph beside a
// grey word read as two.
export type CardTone = "neutral" | "attention" | "caution" | "danger"
const CARD_TONES: Record<CardTone, { border: string; head: string }> = {
  neutral: { border: "border-border-strong", head: "text-fg" },
  attention: { border: "border-accent/45", head: "text-accent" },
  caution: { border: "border-border-strong", head: "text-amber-400" },
  danger: { border: "border-red-500/45", head: "text-red-400" },
}

// The 14px gutter glyph is optically centred on the TITLE'S CAP BLOCK, not on its line box — same
// reasoning as ICON_LABEL_NUDGE (a short word inks from cap-top to baseline, so its mass rides high
// inside the font box while the glyph's ink is centred in its own). The amount is FONT-DEPENDENT, so
// like that nudge it is a CSS variable that flips with the type stack (styles.css): 2px under mono —
// which is also exactly shadcn's `translate-y-0.5` — and 3px under system-ui.
const CARD_ICON_OFFSET = "card-icon-offset"

// Part one: the SHELL. One rounded panel-2 card at one padding for every kind. Cards used to disagree
// about all three of fill (panel-2 / elevated / an accent or red wash), border color, and whether they
// carried a shadow — which is what made nine sibling cards read as nine unrelated shapes.
export function TranscriptCard({
  tone = "neutral",
  icon: Icon,
  label,
  aside,
  children,
  className = "",
  ...rest
}: {
  tone?: CardTone
  icon: LucideIcon
  label: ReactNode
  // Optional trailing slot, parked at the title row's RIGHT edge: the one thing the card is ABOUT,
  // when that is a short reference rather than prose (the wake card's `owner/repo#N` link). It rides
  // the title instead of taking a body line of its own, which keeps the body for the card's actual
  // content.
  aside?: ReactNode
  children: ReactNode
  className?: string
} & Omit<ComponentPropsWithoutRef<"div">, "children" | "className">) {
  const { border, head } = CARD_TONES[tone]
  return (
    <div
      {...rest}
      className={`grid min-w-0 grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1 rounded-lg border ${border} bg-panel-2 px-4 py-3 ${className}`}
    >
      <Icon aria-hidden="true" size={14} className={`col-start-1 row-start-1 shrink-0 ${CARD_ICON_OFFSET} ${head}`} />
      <div className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        {/* The title WRAPS rather than truncating: fray's kinds are short sentences ("Waiting on your
            answer — in your external terminal"), and the half of one that survives a narrow queue
            card is not the half that carries the meaning. */}
        <span className={`min-w-0 flex-1 text-[13px] font-medium leading-5 tracking-tight ${head}`}>{label}</span>
        {aside && <span className="shrink-0">{aside}</span>}
      </div>
      {/* One wrapper, so a card passing several children still lands them all in the title's column
          instead of letting grid auto-placement drop the second one into the icon gutter. `card-md`
          pulls any markdown rendered inside down to the card's own body scale (styles.css) — without
          it a ```done bullet list renders at the transcript's 14px prose scale and is visibly larger
          than the identical sentence in the card above it. */}
      <div className="card-md col-start-2 min-w-0 text-fg/75">{children}</div>
    </div>
  )
}

// Part two: the body copy — shadcn's AlertDescription. One scale for every card's sentence, so a
// two-line explanation in one card is not visibly larger than the same sentence in the card above it,
// and one step down in strength from the title so the hierarchy inside the card is unmistakable.
export const CARD_BODY = "block min-w-0 text-[13px] leading-5 text-fg/75"

// Part three: the action row, ALWAYS LEFT-justified (maintainer 2026-07-29). Every card's action starts
// at the same x as its title and its body copy, so the eye finds the verb on the one vertical
// line the whole card is already built on — rather than tracking to a right edge whose position moves
// with the card's width. The rule matters more than either direction did: what made nine sibling cards
// read as nine unrelated shapes was disagreeing about it at all.
//
// Explanatory copy for the action (the awaiting card's "This will dismiss the card…") goes IMMEDIATELY
// TO THE RIGHT of its button and is centered against it, so the pair reads as one control with its
// caption rather than as a sentence the button happens to sit near. `items-center` is what holds that
// alignment; the explainer takes the leftover width and wraps its own lines there (`flex-1 min-w-0`)
// instead of pushing the button onto a line of its own on a narrow queue card.
export function CardActions({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mt-3 flex flex-wrap items-center justify-start gap-x-2.5 gap-y-2 ${className}`}>{children}</div>
}

// The explainer that sits beside a card's action. Exported so every card spells its caption the same
// way instead of re-deriving the muted scale and the flex behavior at each call site.
export const CARD_ACTION_EXPLAINER = "min-w-0 flex-1 text-[11px] leading-snug text-muted/70"

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
