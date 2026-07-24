import { runningOperations } from "./operationIndicators.ts"

// ── THE CHILD-OPERATION ROW VOCABULARY ───────────────────────────────────────────────────────────
//
// Four surfaces list a thread's CHILD operations — the sidebar rail's sub-agent rows, a queue card's
// live child lines, the drawer's background-ops strip, and the completion-hold dialog. All four render
// the SAME row (an arrow, a liveness mark, a label), and all four were written independently. They
// drifted exactly as duplicated layout always does: two arrow alphas (/45 and /40 — six pixels apart
// on a single queue card, which is how the maintainer caught it), two stale-dot alphas (/30 and /25 at
// the same size with the same tooltip), and three different answers for an id-less child.
//
// These tokens are the ONE source for that vocabulary and `components/ChildOpRow.tsx` is the ONE
// renderer. Nothing else in the web sources may spell the glyph out again — `subAgentArrow.test.ts`
// fails the build if any rendered literal escapes this file.

// U+2937 ARROW POINTING DOWNWARDS THEN CURVING RIGHTWARDS — the one "branches from its parent" glyph,
// established by the sidebar's sub-agent rows and now shared verbatim by every child surface.
export const CHILD_ARROW = "⤷"

// /45, not /40. Two alphas were live at once; the rail (which established the glyph) and the queue card
// used /45, the ops strip and the completion dialog /40. The arrow is the row's STRUCTURAL marker — the
// thing that says "this line hangs off the one above it" — so it takes the brighter of the two rather
// than sitting below the muted label it introduces.
export const CHILD_ARROW_CLASS = "shrink-0 text-[11px] leading-none text-muted/45"

// The flat dot for a child with no recent output. /30 (the rail's value); the ops strip's /25 was the
// outlier and read as a smudge next to the same dot one surface over.
export const CHILD_STALE_DOT_CLASS = "block h-1.5 w-1.5 rounded-full bg-muted/30"
export const CHILD_STALE_TITLE = "stale — no recent output"

// A tracked background shell/Monitor is a LIVE process even when quiet (its entry only clears on a
// terminal notification), so it breathes rather than showing the flat stale dot — and says so.
export const CHILD_QUIET_SHELL_TITLE = "running — no recent output"

export const CHILD_OPEN_TITLE = { AGENT: "Open sub-agent transcript", SHELL: "Open background shell output" } as const
export const CHILD_DISMISS_TITLE = "Dismiss — stop tracking this finished operation"
export const CHILD_DISMISS_NOUN = { AGENT: "sub-agent", SHELL: "background shell" } as const

// ── LIVENESS FILTERS — three surfaces, three policies, DELIBERATELY LISTED TOGETHER ──────────────
//
// The three surfaces do NOT agree on which children are worth showing, and this is the one place that
// says so out loud. Behaviour here is the pre-existing behaviour of each site, preserved verbatim:
//
//   card  — `running` only. A stale child vanishes from the queue card entirely.
//   rail  — `running` OR `stale`, and only children carrying an `id`. A stale child dims; an id-less
//           child (an old snapshot shape) is dropped.
//   sheet — no filter at all. Everything the board reports gets a row.
//
// So one stale sub-agent is simultaneously invisible on its card, dimmed on the rail, and listed in the
// drawer. Whether that is right is a PRODUCT question, not a refactor: unifying it would change what
// three surfaces show. Until the maintainer rules, every caller routes through here so the divergence
// is one function instead of three scattered predicates.
export type ChildOpRecord = { readonly state: string; readonly id?: string }

export function visibleChildOps<T extends ChildOpRecord>(ops: readonly T[], surface: "rail"): readonly (T & { id: string })[]
export function visibleChildOps<T extends ChildOpRecord>(ops: readonly T[], surface: "card" | "sheet"): readonly T[]
export function visibleChildOps<T extends ChildOpRecord>(ops: readonly T[], surface: "rail" | "card" | "sheet"): readonly T[] {
  if (surface === "card") return runningOperations(ops)
  if (surface === "rail") return ops.filter((op): op is T & { id: string } => Boolean(op.id) && (op.state === "running" || op.state === "stale"))
  return ops
}
