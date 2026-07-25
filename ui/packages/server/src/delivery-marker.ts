// ── The invisible delivery marker ──────────────────────────────────────────────────────────────────
//
// fray steers a Claude worker by pasting into a human-facing TUI composer over tmux, and that channel
// REWRITES the bytes on the way through. Measured against a live claude 2.1.219 TUI, driven by fray's
// own paste sequence: tmux `paste-buffer` turns LF into CR, then the TUI's paste handler turns CR/CRLF
// back into LF and expands every TAB into four spaces — so a tab-bearing send and a CRLF-bearing send
// both arrive as different bytes than fray sent. Confirming delivery by comparing those bytes is
// therefore inference, and every mangling class fray has not yet met strands a send as "unconfirmed"
// while the agent has already read and acted on it.
//
// This replaces the inference with IDENTITY. Every follow-up fray pastes carries a marker encoding its
// deliveryId, so the correlator recognises its own send by looking the id up rather than by comparing
// prose. That is immune to any rewrite of the surrounding text, and it stays correct when the TUI glues
// several sends into one submission — each constituent brings its own marker along.
//
// ── Why zero-width, and why these three codepoints ────────────────────────────────────────────────
// The marker must survive the channel and must not be visible to the human reading their own terminal.
// Measured on the same live TUI: U+200B / U+200C / U+2060 round-trip BYTE-INTACT through tmux and the
// composer into the JSONL, and `tmux capture-pane` renders the line with no visible artefact. They are
// also deliberately NOT matched by JavaScript's `\s`, so a marker can never be mistaken for the
// whitespace the ledger's text comparison collapses.
//
// The cost is honest and bounded: the model sees 34 invisible codepoints at the end of each steer. fray
// owns every surface that renders this text, so the marker is stripped from the transcript before the
// human ever sees it (see stripDeliveryMarkers).
//
// ── Why this cannot resolve the wrong send ────────────────────────────────────────────────────────
//  1. The tag is a 32-bit hash of the deliveryId, so two DIFFERENT sends colliding inside one ledger
//     (≤20 items) is a ~1-in-10^7 event — and the correlator does not gamble on it anyway: it refuses
//     the marker path for any tag held by more than one outstanding item and falls back to text.
//  2. A marker only ever resolves an item whose evidence is CONTEMPORANEOUS, exactly as text evidence
//     does. A replayed transcript cannot resurrect an old send.
//  3. A marker is never SYNTHESISED from anything the human typed — it is emitted only by fray's own
//     injection path, so a human pasting prose into the terminal cannot forge one.

const ZERO = "​" // ZERO WIDTH SPACE      → bit 0
const ONE = "‌" // ZERO WIDTH NON-JOINER → bit 1
const EDGE = "⁠" // WORD JOINER           → delimiter

const TAG_BITS = 32

// Every codepoint this module may ever emit — the strip set. Kept separate from the marker grammar so
// stripping stays total: a truncated or half-mangled marker still leaves no visible residue behind.
const MARKER_CHARS = new RegExp(`[${ZERO}${ONE}${EDGE}]`, "g")
const MARKER_RE = new RegExp(`${EDGE}[${ZERO}${ONE}]{${TAG_BITS}}${EDGE}`, "g")

// FNV-1a over the deliveryId. Any stable 32-bit digest would do; this one is dependency-free and its
// avalanche is far better than the id's own leading hex, which for a v4 UUID is not uniformly random
// across the generators fray has used.
export function deliveryTag(deliveryId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < deliveryId.length; i++) {
    hash ^= deliveryId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function encodeDeliveryMarker(deliveryId: string): string {
  const bits = deliveryTag(deliveryId).toString(2).padStart(TAG_BITS, "0")
  let out = EDGE
  for (const bit of bits) out += bit === "1" ? ONE : ZERO
  return out + EDGE
}

// Every well-formed tag in `text`, in order. A malformed or truncated marker yields nothing — the
// caller then falls back to text correlation, which is the pre-marker behaviour.
export function decodeDeliveryMarkers(text: string): number[] {
  const out: number[] = []
  for (const match of text.matchAll(MARKER_RE)) {
    const bits = match[0].slice(EDGE.length, -EDGE.length)
    let value = 0
    for (const ch of bits) value = ((value << 1) | (ch === ONE ? 1 : 0)) >>> 0
    out.push(value >>> 0)
  }
  return out
}

// Remove every marker codepoint. Used on BOTH sides of the seam: on transcript text so the human never
// sees a marker, and on composer captures so delivery-confirm.ts still recognises fray's own unsent
// text in a pane. Cheap-exits on the overwhelmingly common marker-free string.
export function stripDeliveryMarkers(text: string): string {
  if (!text.includes(EDGE) && !text.includes(ZERO) && !text.includes(ONE)) return text
  return text.replace(MARKER_CHARS, "")
}

// Non-global twin: `MARKER_RE` carries /g for matchAll, and /g + .test() is a lastIndex footgun.
const MARKER_ONCE = new RegExp(MARKER_RE.source)

export function hasDeliveryMarker(text: string): boolean {
  return MARKER_ONCE.test(text)
}
