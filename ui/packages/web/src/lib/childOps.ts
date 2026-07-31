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

// A RESTED child: its run ended (the harness reported completed/failed) while the fan-out IT dispatched
// is still running. A HOLLOW dot of the same 1.5-unit geometry as the stale one — same box, same
// baseline, so nothing on the row shifts — because the reading is "this one stopped" while the rows
// indented beneath it are still pulsing. It is deliberately not the stale dot: stale means "probably
// still working, just quiet", and the action here is the opposite one (steer it, or its children's work
// is stranded).
export const CHILD_RESTED_DOT_CLASS = "block h-1.5 w-1.5 rounded-full border border-muted/45"
export const CHILD_RESTED_TITLE = "rested — it stopped, but the work it launched is still running"

// A tracked background shell/Monitor is a LIVE process even when quiet (its entry only clears on a
// terminal notification), so it breathes rather than showing the flat stale dot — and says so.
export const CHILD_QUIET_SHELL_TITLE = "running — no recent output"

export const CHILD_OPEN_TITLE = { AGENT: "Open sub-agent transcript", SHELL: "Open background shell output" } as const

// ── HOW MUCH the child has done — the quiet counter beside its current step ──────────────────────
//
// A live sub-agent used to be a name and a spinner. `activityDetail` (the provider's per-tool-call
// sentence) says what it is doing RIGHT NOW; this says how far it has got. Both come off the Claude
// Agent SDK's typed task stream, so both are absent for a tmux thread, a codex child, or an older CLI
// — the row must read fine without them, never leave a gap where one would have been.
//
// `toolUses` rides the board signature (it pushes promptly); `tokens` deliberately does NOT (it would
// churn), so it is a slow, secondary reading and must never be styled as something that ticks.
export function childProgressLabel(toolUses?: number, tokens?: number): string | undefined {
  const parts: string[] = []
  if (typeof toolUses === "number" && toolUses > 0) parts.push(`${toolUses} ${toolUses === 1 ? "tool" : "tools"}`)
  const compact = compactCount(tokens)
  if (compact) parts.push(`${compact} tok`)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

// 947 → "947", 13476 → "13.5k", 132000 → "132k", 2400000 → "2.4M". A raw six-digit token count next to
// a truncated label is noise; the magnitude is the whole reading. The decimal survives up to three
// significant figures and is dropped past them, where it would only be adding width.
function compactCount(n: number | undefined): string | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined
  const scale = (value: number, suffix: string) => `${value < 100 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)}${suffix}`
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return scale(n / 1_000, "k")
  return scale(n / 1_000_000, "M")
}
// The × on a child row — on EVERY surface that lists children, since 2026-07-30 (maintainer: "the X
// button to stop a sub-agent should show up everywhere sub-agents are listed"). It was an ops-strip-only
// affordance, which meant the rail and the queue card showed the same phantom child and offered no way
// to retire it. WHICH rows may carry it is a property of the ROW (a direct child with an id — see
// lib/dismissChildOp.ts), never of the surface it happens to be rendered on.
//
// The copy is per-STATE, because the × does two different honest things and must claim only the one it
// will actually do. This is the second half of the maintainer's 2026-07-30 ruling — first "the X button
// didn't actually kill the sub-agent", then, when a shell's × cleared the row and confessed in a toast
// that the work was probably still going: "We shouldn't show the X if it doesn't fucking work."
//
//   RUNNING  — the row is only given a × when the server says the child is STOPPABLE
//              (lib/dismissChildOp.ts), so here the word can be "stop" and mean it.
//   STALE / RESTED — nothing is running to stop. The × retires a finished op from tracking, which is
//              the phantom escape hatch it was built for, so it says "clear" and promises nothing more.
//
// A running row that cannot be stopped carries no × at all, so no wording is needed for it — the
// absence IS the honesty.
export const CHILD_DISMISS_TITLE = {
  running: "Stop — end this operation and clear the row",
  settled: "Clear — stop tracking this finished operation",
} as const
export const CHILD_DISMISS_VERB = { running: "Stop", settled: "Clear" } as const
export const CHILD_DISMISS_NOUN = { AGENT: "sub-agent", SHELL: "background shell" } as const

// ── LIVENESS FILTERS — the surfaces' policies, in ONE place ──────────────────────────────────────
//
// A child is worth showing while it is live OR stale — "stale" is not "gone", it is "running, but we
// have not seen output in a while", still unresolved work hanging off the thread. The card USED to show
// running-only, so a stale sub-agent vanished from its handoff card while the rail still dimmed it and
// the drawer still listed it — the same cross-surface inconsistency the shared row was built to end
// (maintainer ruling 2026-07-24: unify the card onto the rail's policy). Now:
//
//   card  — running OR stale OR rested. Same set as the rail, minus the rail's id requirement: an
//           id-less child still renders (non-interactive), never silently dropped.
//   rail  — the same set, and only children carrying an `id` (its rows are always drill-in targets;
//           an id-less child from an old snapshot shape has nothing to open, so the rail omits it).
//   sheet — no filter at all. Everything the board reports gets a row.
//
// `rested` joins the visible set for the same reason `stale` did, only more so: the server emits it ONLY
// for a child that still has running work under it (see anchorRoots in tailer.ts), so hiding it would
// hide the live grandchildren indented beneath it — which is exactly the disappearance this vocabulary
// keeps having to fix.
export type ChildOpRecord = { readonly state: string; readonly id?: string }

const unresolved = (op: ChildOpRecord): boolean => op.state === "running" || op.state === "stale" || op.state === "rested"

export function visibleChildOps<T extends ChildOpRecord>(ops: readonly T[], surface: "rail"): readonly (T & { id: string })[]
export function visibleChildOps<T extends ChildOpRecord>(ops: readonly T[], surface: "card" | "sheet"): readonly T[]
export function visibleChildOps<T extends ChildOpRecord>(ops: readonly T[], surface: "rail" | "card" | "sheet"): readonly T[] {
  if (surface === "card") return ops.filter(unresolved)
  if (surface === "rail") return ops.filter((op): op is T & { id: string } => Boolean(op.id) && unresolved(op))
  return ops
}
