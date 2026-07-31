// Parse an assistant message's markdown for ```done / ```awaiting SIGNAL fences so the renderer can
// set each one off as a CARD in place of the raw block (mirrors questionBlocks.ts). Transcripts arrive
// as raw markdown, so the client parses fences itself — the grammar is identical to the fence spec the
// worker writes and the server's lastFence parser: an opening line exactly ```done or ```awaiting, the
// body, then a closing ``` line. Pure string logic, no DOM — unit-testable.
//
// The signal fence LANGUAGE is the state: `done` = a presentation-only success card (thread lifecycle
// actions live in a stable footer), `awaiting` = a compact parked human/timer handoff. Distinct
// from ```question blocks (their own machinery in questionBlocks.ts) — those never match here.

import { insideFence, type AwaitingHint } from "@fray-ui/shared"

export type FenceKind = "done" | "awaiting"

export type FenceSegment =
  | { kind: "prose"; text: string }
  | { kind: "fence"; fenceKind: FenceKind; body: string; hints: AwaitingHint[] }

// Opening fence begins a line: ```done or ```awaiting (NO info-string — the language alone is the
// state), a newline, then the body non-greedily to the next line that is exactly ``` (optional trailing
// spaces). The `m` flag anchors ^/$ to line boundaries; an unterminated opener never matches, so a
// half-written fence degrades to ordinary prose (markdown renders it as a plain code block). ```question
// can't match the (done|awaiting) alternation, so question blocks are left entirely to questionBlocks.ts.
const FENCE_BLOCK = /^```(done|awaiting)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm

// A parked-wait hint line inside an ```awaiting body. `pr-watch`/`human`/`timer` are current;
// pr/ci/session remain parseable for older transcripts. Case-insensitive; everything else is prose.
// `pr-watch` precedes `pr` so it wins the alternation on a `pr-watch:` line (a bare `pr:` still falls
// through to the legacy `pr`). (`github-review` was removed 2026-07-22 — displaced by `pr-watch`.)
const HINT_RE = /^(pr-watch|human|timer|pr|ci|session):\s*(\S.*)$/i

// Split the body of a fence into its prose (hint lines removed) and its parsed hints. `done` fences
// carry no hints — the whole body is prose.
// Defensive caps matching the server's lastFence parser (tailer.ts): 8 hints, 200-char values — so a
// pathological body can't render a divergent chip row between the sidebar gloss (server-parsed) and
// the in-chat card (client-parsed).
const HINT_MAX = 8
const HINT_VALUE_MAX = 200

export function parseFenceBody(raw: string, kind: FenceKind): { body: string; hints: AwaitingHint[] } {
  if (kind === "done") return { body: raw.trim(), hints: [] }
  const hints: AwaitingHint[] = []
  const prose: string[] = []
  for (const line of raw.split("\n")) {
    const l = line.replace(/\r$/, "")
    const m = l.match(HINT_RE)
    if (m) hints.push({ kind: m[1].toLowerCase() as AwaitingHint["kind"], value: m[2].trim().slice(0, HINT_VALUE_MAX) })
    else prose.push(l)
  }
  return { body: prose.join("\n").trim(), hints: hints.slice(0, HINT_MAX) }
}

// Split an assistant message's markdown into prose runs and signal-fence blocks, in document order.
// Prose runs that are whitespace-only are dropped (a fence never leads/trails with an empty prose slot).
export function splitFenceBlocks(text: string): FenceSegment[] {
  const segments: FenceSegment[] = []
  // A fence nested inside another code fence is being QUOTED (a worker showing the human what a ```done
  // block looks like), so it stays in the prose run and renders as the code block it is — see the same
  // guard in questionBlocks.ts.
  const quoted = insideFence(text)
  let lastIndex = 0
  FENCE_BLOCK.lastIndex = 0
  for (let m = FENCE_BLOCK.exec(text); m !== null; m = FENCE_BLOCK.exec(text)) {
    if (quoted(m.index)) {
      FENCE_BLOCK.lastIndex = m.index + 1
      continue
    }
    const prose = text.slice(lastIndex, m.index)
    if (prose.trim()) segments.push({ kind: "prose", text: prose })
    const fenceKind = m[1] as FenceKind
    const { body, hints } = parseFenceBody(m[2], fenceKind)
    segments.push({ kind: "fence", fenceKind, body, hints })
    lastIndex = m.index + m[0].length
  }
  const rest = text.slice(lastIndex)
  if (rest.trim()) segments.push({ kind: "prose", text: rest })
  return segments
}

// True when a message carries at least one signal fence — the cheap check ChatView uses to decide a
// message renders a fence card rather than the raw block. Goes through the splitter so a QUOTED fence
// (one nested in a code block) can never answer yes.
export function hasFence(text: string): boolean {
  return splitFenceBlocks(text).some((s) => s.kind === "fence")
}
