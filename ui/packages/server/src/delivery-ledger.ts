import type { TranscriptMessage } from "@fray-ui/shared"
import type { Storage } from "./storage.ts"
import { decodeDeliveryMarkers, deliveryTag, stripDeliveryMarkers } from "./delivery-marker.ts"

// ── The Claude follow-up delivery ledger ───────────────────────────────────────────────────────────────
// Fray's Claude steer path used to be fire-and-forget: tmux keys went into the pane and the ONLY record
// that a follow-up existed was the CLIENT's optimistic gray bubble, reconciled by exact text match
// against whatever later appeared in the JSONL. That made the queued/delivered rendering an inference —
// a mangled injection (the multiline split), a slash command, or a plain reload made the message ghost
// or vanish. This ledger makes the send a server-owned state machine instead:
//
//   followUp(deliveryId) ──▶ pending ──(enqueue record matches)──▶ enqueued ──(queued_command /
//   user record matches)──▶ delivered (dropped from the ledger — the real transcript record takes over)
//   pending ──(no evidence for PENDING_TIMEOUT_MS)──▶ unconfirmed (kept, projected with a warning,
//   dropped after UNCONFIRMED_DROP_MS — the terminal pane is the recovery surface)
//
// The ledger is persisted on the session row (`delivery_ledger`, a small JSON array), correlated by the
// tailer as it folds new JSONL records, and PROJECTED into
// the rendered transcript by readThreadTranscript: a pending/enqueued item renders as the gray queued
// bubble (sourceId `delivery:<id>`) so the queued affordance is server truth — reload-safe, and consumed
// by the client's optimistic bubble via deliveryId rather than text.
//
// 'enqueued' deliberately never times out: an enqueue record is positive evidence Claude Code holds the
// message in its own queue, and a mid-turn queue legitimately lasts as long as the turn does.

export const PENDING_TIMEOUT_MS = 60_000
export const UNCONFIRMED_DROP_MS = 60 * 60_000
export const MAX_LEDGER_ITEMS = 20

export type DeliveryState = "pending" | "enqueued" | "unconfirmed"

export interface DeliveryLedgerItem {
  id: string
  text: string
  state: DeliveryState
  at: string // ISO8601 — when fray accepted/injected the follow-up
  updatedAt: string
  // How many times the submit-confirmer (delivery-confirm.ts) has re-sent a BARE Enter because this
  // item was still provably sitting in the pane's composer. Absent on every pre-existing row; capped by
  // MAX_SUBMIT_ATTEMPTS, after which the item is aged straight to `unconfirmed` so the drawer says so.
  submitAttempts?: number
}

// The form every text comparison in this module runs in.
//
// The steer channel REWRITES fray's bytes before they reach the JSONL, so the text fray sent and the
// text the transcript records are not equal and an exact compare strands the send as `unconfirmed`
// forever. The channel is a COMPOSITION of two rewriters fray does not own — tmux `paste-buffer`
// (LF→CR) and Claude Code's TUI paste handler (`/\r\n|\r/`→`\n`, `\t`→four spaces) — and measuring it
// against a live claude 2.1.219 TUI, driven through fray's own paste sequence, showed:
//
//     sent          recorded          note
//     \t            "    "            four spaces, not a tab stop
//     \r\n          \n\n              the line break DOUBLES (CR→LF then LF→newline)
//     \r            \n
//     trailing " ", unicode, nbsp, long unwrapped lines — preserved verbatim
//
// Two distinct classes, not one. The maintainer hit the tab class (2026-07-25,
// `were-taking-over-from-another-agent`: a 1448-char send with two tabs recorded as 1454 chars with
// none, 34ms after the send, and still marked unconfirmed at the 60s timeout). The CRLF class is worse
// and just as reachable — anything pasted from a Windows-authored source or many web textareas — and a
// comparison that preserved line COUNT still stranded it.
//
// So do not model the channel; be INVARIANT to it. Every whitespace run — spaces, tabs, newlines alike
// — collapses to a single space, which is stable under every rewrite above and under any future
// re-flow in the same family (a re-wrap, a trailing-space trim, a different tab width). What actually
// keeps this safe is unchanged and lives elsewhere: evidence must be CONTEMPORANEOUS, a mid-record
// match must clear COMPOSED_ANCHOR_MIN, and composition consumes items in order. Precedent: the far
// more dangerous decision in this system — whether to press Enter on a live composer — has always been
// gated on FULL whitespace removal (`squash` in delivery-confirm.ts). Applied to BOTH sides of every
// comparison, so the composition offsets in matchComposedText stay internally consistent.
//
// What this deliberately does NOT forgive: differing WORDS. A send whose text the channel altered
// beyond whitespace still ages to `unconfirmed`, which is the warning doing its job.
const canon = (s: string): string => s.replace(/\s+/g, " ").trim()

function isItem(v: unknown): v is DeliveryLedgerItem {
  if (!v || typeof v !== "object") return false
  const i = v as Partial<DeliveryLedgerItem>
  return typeof i.id === "string" && typeof i.text === "string" && typeof i.at === "string" &&
    typeof i.updatedAt === "string" && (["pending", "enqueued", "unconfirmed"] as const).includes(i.state as DeliveryState)
}

export function parseDeliveryLedger(json: string | null | undefined): DeliveryLedgerItem[] {
  if (!json) return []
  try {
    const doc = JSON.parse(json)
    return Array.isArray(doc) ? doc.filter(isItem) : []
  } catch {
    return []
  }
}

export function serializeDeliveryLedger(items: DeliveryLedgerItem[]): string | null {
  return items.length ? JSON.stringify(items) : null
}

// Record a freshly accepted follow-up. Idempotent on id (an RPC retry must not double-project), capped
// so a wedged session can't grow the row without bound (oldest evicted first — they're the stalest
// unconfirmed sends, and the terminal is their recovery surface).
// `state` defaults to `pending` — a Claude send is fire-into-a-composer and has no receipt until the
// JSONL shows one. A CODEX send passes `enqueued` instead, because the app-server RPC returning a turn
// id IS the receipt: the provider has positively accepted the text. That distinction matters beyond
// bookkeeping — `pending` is what ages into the amber "check the terminal" warning, and a codex
// app-server thread has no terminal composer to check, so it must never enter that state.
export function appendDelivery(
  storage: Storage,
  slug: string,
  item: { id: string; text: string; now?: number; state?: DeliveryState },
): void {
  const row = storage.getSession(slug)
  if (!row) return
  const items = parseDeliveryLedger(row.delivery_ledger)
  if (items.some((existing) => existing.id === item.id)) return
  const at = new Date(item.now ?? Date.now()).toISOString()
  items.push({ id: item.id, text: item.text, state: item.state ?? "pending", at, updatedAt: at })
  while (items.length > MAX_LEDGER_ITEMS) items.shift()
  storage.setDeliveryLedger(slug, serializeDeliveryLedger(items))
}

// Has this exact send already been recorded as delivered? The entry is written only once
// `resumeThread` returns, so a hit is positive evidence the text crossed into the worker. This makes a
// replayed deliveryId a no-op — defense-in-depth against a replay from any source (a stale tab, an
// at-least-once transport). It is NOT what makes the client retry safe: because the append trails the
// injection, a hit only ever exists for an ALREADY-delivered send, never for the pre-injection refusals
// the client actually replays. Keeping every retryable throw upstream of the first write is the real
// guarantee; a miss here proves nothing.
export function hasDelivery(storage: Storage, slug: string, id: string): boolean {
  const row = storage.getSession(slug)
  if (!row) return false
  return parseDeliveryLedger(row.delivery_ledger).some((item) => item.id === id)
}

// The text of a `queued_command` attachment's prompt. A typed follow-up carries a bare string; one the
// human attached an image to carries an ARRAY of content blocks, with the words in the `text` ones —
// 10 such in this machine's corpus, every one text+image. Both readers (correlation here, rendering in
// transcript.ts) share this so a send with a screenshot attached behaves exactly like a typed one.
// Lives here rather than in transcript.ts because transcript.ts already imports this module.
export function attachmentPromptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt
  if (!Array.isArray(prompt)) return ""
  return prompt
    .filter((b): b is { type: string; text: string } =>
      Boolean(b) && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n")
}

// Extract the plain text of a user record (string content, or the joined text blocks) — mirrors the
// transcript parser's reading, minimally.
function userRecordText(rec: Record<string, unknown>): string {
  const message = rec.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => Boolean(b) && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
      .map((b) => b.text)
      .join("\n")
  }
  return ""
}

// A codex rollout's own user-message records. Codex writes the human turn TWICE in two shapes, and both
// count as evidence the text reached it:
//   • `event_msg` / `user_message`  — payload.message, a plain string. This is the one the transcript
//     renderer treats as the authoritative human turn (see backend/codex.ts), 232 in this corpus.
//   • `response_item` / `message` role:"user" — payload.content[], the model-facing copy, 424 here.
// Deliberately narrow on both so a claude record can never fall down this branch, and vice versa.
function isCodexUserMessage(r: Record<string, unknown>): boolean {
  const payload = r.payload as { type?: unknown; role?: unknown } | undefined
  if (!payload) return false
  if (r.type === "event_msg" && payload.type === "user_message") return true
  return payload.type === "message" && payload.role === "user"
}

function codexUserMessageText(r: Record<string, unknown>): string {
  const payload = r.payload as { content?: unknown; message?: unknown } | undefined
  if (typeof payload?.message === "string") return payload.message
  const content = payload?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b): b is { type: string; text: string } =>
      Boolean(b) && typeof (b as { text?: unknown }).text === "string" &&
      ((b as { type?: unknown }).type === "input_text" || (b as { type?: unknown }).type === "text"))
    .map((b) => b.text)
    .join("\n")
}

// Fold ONE freshly appended JSONL record into the ledger. Pure: returns the same array when nothing
// matched, a new array otherwise. `nowIso` stamps updatedAt (injectable for tests).
export function correlateDeliveryRecord(
  items: DeliveryLedgerItem[],
  rec: unknown,
  nowIso: string,
): DeliveryLedgerItem[] {
  if (!items.length || !rec || typeof rec !== "object") return items
  const r = rec as Record<string, unknown>
  // Evidence must be CONTEMPORANEOUS: a server-restart prime replays the whole JSONL through this
  // correlator, and an OLD user record that happens to repeat a pending item's text ("continue") must
  // not count as its delivery. A record timestamped before the send (small skew allowance) never
  // resolves an item; an untimestamped record is accepted (every observed shape carries one).
  const recMs = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN
  const contemporaneous = (item: DeliveryLedgerItem): boolean => {
    if (!Number.isFinite(recMs)) return true
    const born = Date.parse(item.at)
    return !Number.isFinite(born) || recMs >= born - 5_000
  }

  // Claude Code accepted the message into its own queue → positive receipt, still undelivered.
  // Deliberately NOT gated on state==='pending': the evidence can arrive long after PENDING_TIMEOUT_MS
  // aged the item to 'unconfirmed' (87s and 12min observed in the maintainer's own transcript, because
  // the composer can hold a paste for minutes before the TUI submits it). An enqueue record is positive
  // proof the message reached Claude Code's queue, so it must clear the amber warning whenever it lands.
  if (r.type === "queue-operation" && r.operation === "enqueue" && typeof r.content === "string") {
    const matched = accountFor(items, r.content, contemporaneous)
    if (matched.size === 0) return items
    return items.map((item, index) =>
      matched.has(index) && item.state !== "enqueued" ? { ...item, state: "enqueued", updatedAt: nowIso } : item,
    )
  }

  // DEQUEUE — Claude Code taking the message back OUT of its own queue and into the turn.
  //
  // fray used to learn this only from the `queued_command` attachment that follows, and the gap is real:
  // across 263 dequeues in this machine's transcripts the attachment lands 1 to 19 records later (p50 2,
  // p95 6). For that whole window the send is already being worked on while fray still renders it as a
  // gray queued bubble — which the chat pins BELOW the working indicator, so the spinner appears above
  // the very message it is answering. Resolving on the dequeue closes the window.
  //
  // `remove` is the usable signal: all 2398 in the corpus carry their content, so they can be
  // correlated. The `dequeue` operation is NOT — all 1032 of them carry no content at all, and a bare
  // handshake cannot be attributed to a specific send. `popAll` never appeared.
  //
  // A content-bearing `remove` is also what a CANCELLATION looks like (the human ESC-ing a queued
  // message in the terminal). Dropping the item is right either way: the message is provably no longer
  // queued, so continuing to render fray's own synthetic bubble for it would be a lie in both readings,
  // and the transcript's own records go on telling the true story.
  if (r.type === "queue-operation" && r.operation === "remove" && typeof r.content === "string" && r.content.trim()) {
    const dequeued = accountFor(items, r.content, contemporaneous)
    if (dequeued.size === 0) return items
    return items.filter((_, index) => !dequeued.has(index))
  }

  // Delivery into the agent's context: the queued_command attachment (mid-turn/turn-start pickup) or a
  // plain user record (idle submit / dead-session resume / the 2.1.207 print-path shape). Either one
  // resolves the item — delivered items leave the ledger; the real transcript record renders from here.
  let deliveredText: string | null = null
  if (r.type === "attachment") {
    const att = r.attachment as { type?: unknown; commandMode?: unknown; prompt?: unknown } | undefined
    if (att?.type === "queued_command" && att.commandMode === "prompt") {
      // Array-shaped for an image-bearing follow-up; the same reader the transcript uses, so a send
      // with a screenshot attached correlates exactly like a typed one.
      const text = attachmentPromptText(att.prompt)
      if (text) deliveredText = text
    }
  } else if (r.type === "user" && r.isMeta !== true) {
    const text = userRecordText(r)
    if (text) deliveredText = text
  } else if (isCodexUserMessage(r)) {
    // CODEX rollout shape: {timestamp, type:"response_item", payload:{type:"message", role:"user",
    // content:[{type:"input_text", text}]}}. The app-server RPC already receipted this send, so the
    // ledger item exists only to render the bubble until the rollout materialises it — which measured
    // 3.3s at p50 but 71s, 212s and 4.6h in the tail, well past the client ghost floor that would
    // otherwise retire the only copy of the message on screen.
    const text = codexUserMessageText(r)
    if (text) deliveredText = text
  }
  if (deliveredText === null) return items
  const delivered = accountFor(items, deliveredText, contemporaneous)
  if (delivered.size === 0) return items
  return items.filter((_, index) => !delivered.has(index))
}

// Which ledger items one evidence record accounts for — BY IDENTITY first, by text only as the fallback.
//
// fray stamps every follow-up it pastes with an invisible marker carrying that send's deliveryId
// (delivery-marker.ts), so the normal path is an exact lookup: no prose is compared at all and no
// rewrite of the surrounding text — tab expansion, CRLF doubling, a re-wrap, a future mangling nobody
// has met yet — can break it. A record that glues several sends together carries every constituent's
// marker, so all of them resolve from the one record.
//
// The text path remains for everything a marker cannot cover: sends already in flight when this shipped,
// adopted/foreign panes, and any send whose marker the channel destroyed. It runs on the STRIPPED text
// so a marker never perturbs the comparison.
export function accountFor(
  items: readonly DeliveryLedgerItem[],
  recordText: string,
  contemporaneous: (item: DeliveryLedgerItem) => boolean,
): Set<number> {
  const matched = new Set<number>()
  const tags = decodeDeliveryMarkers(recordText)
  if (tags.length) {
    const wanted = new Set(tags)
    // A tag held by more than one outstanding item is ambiguous — refuse the shortcut for those and let
    // the text path decide, rather than resolving an arbitrary one of them.
    const owners = new Map<number, number[]>()
    items.forEach((item, index) => {
      const tag = deliveryTag(item.id)
      if (wanted.has(tag)) owners.set(tag, [...(owners.get(tag) ?? []), index])
    })
    for (const [, indexes] of owners) {
      if (indexes.length !== 1) continue
      const index = indexes[0]
      if (contemporaneous(items[index])) matched.add(index)
    }
  }
  // The text path then runs over the WHOLE ledger, not just the leftovers. Letting it re-consume an
  // item a marker already resolved costs nothing (both sides union into one set) and is what keeps a
  // MIXED record working: when a marked send is glued ahead of an unmarked one, the composition still
  // walks the marked text first and so meets the unmarked item at a clean prefix boundary.
  for (const index of matchComposedText(items, canon(stripDeliveryMarkers(recordText)), contemporaneous)) {
    matched.add(index)
  }
  return matched
}

// A merged submission's constituent text must be at least this long before it may be matched at a
// non-zero offset (i.e. after content this ledger never sent — a draft the operator had already typed
// into the pane). Whole-record and prefix-anchored matches are exact and are not length-gated; this
// bound exists so a short generic send ("continue") can't be resolved by merely APPEARING inside an
// unrelated message the human typed in the terminal.
const COMPOSED_ANCHOR_MIN = 24

// Which ledger items a single JSONL evidence record accounts for.
//
// The naive rule — whole-string equality — is what shipped, and it is wrong for the case the operator
// actually hit. fray injects a follow-up by pasting into Claude Code's composer and sending Enter, and
// the TUI can SWALLOW that Enter while it is mid-render: the text stays in the composer, and the NEXT
// follow-up's paste lands after it, so its Enter submits the ACCUMULATION as one message. Claude Code
// then writes exactly one `queue-operation enqueue` and one `queued_command` attachment whose text is
// the CONCATENATION of the N sends. Verified byte-exact against the maintainer's own transcript
// (2026-07-23, thread `why-when-i-try-to-change`): a 709-char enqueue = item(565) + "\n" + item(143),
// and a 379-char enqueue = item(196) + item(183) with no separator at all. Under whole-string equality
// NONE of the four constituents matched, all four aged to `unconfirmed`, and the drawer told the
// operator to "check the terminal" for four messages the agent had already read and acted on.
//
// So: consume the record left-to-right, taking any unconsumed item whose text is a PREFIX of what's
// left (skipping the newline the composer may insert between pastes). Every consumed segment is a
// whole item text anchored at a boundary the previous items produced, so this is strictly a
// generalization of equality — it can only match MORE of a record that the ledger genuinely composed,
// never a coincidental substring in the middle of an unrelated message.
export function matchComposedText(
  items: readonly DeliveryLedgerItem[],
  recordText: string,
  contemporaneous: (item: DeliveryLedgerItem) => boolean,
): Set<number> {
  const matched = new Set<number>()
  if (!recordText) return matched
  let rest = recordText
  // The composer may already have held content this ledger never sent (a draft the human typed in the
  // pane). Anchor once on the earliest long-enough item that occurs in the record, then compose forward
  // from it — every later segment must be a clean prefix of what remains.
  let anchored = false
  const candidate = (index: number): string | null => {
    if (matched.has(index)) return null
    const item = items[index]
    if (!contemporaneous(item)) return null
    const text = canon(item.text)
    return text || null
  }
  for (let guard = 0; guard < items.length && rest.length > 0; guard++) {
    let hit: { index: number; at: number; length: number } | null = null
    // Prefix matches always win — they are exact composition, and never length-gated.
    for (let index = 0; index < items.length; index++) {
      const text = candidate(index)
      if (text && rest.startsWith(text)) { hit = { index, at: 0, length: text.length }; break }
    }
    if (!hit && !anchored) {
      for (let index = 0; index < items.length; index++) {
        const text = candidate(index)
        if (!text || text.length < COMPOSED_ANCHOR_MIN) continue
        const at = rest.indexOf(text)
        if (at > 0 && (!hit || at < hit.at)) hit = { index, at, length: text.length }
      }
    }
    if (!hit) break
    matched.add(hit.index)
    anchored = true
    // Any whitespace the composer left at the seam is separator, not content — the same argument that
    // already let a newline be skipped here, widened to match the canonical form above.
    rest = rest.slice(hit.at + hit.length).replace(/^\s+/, "")
  }
  return matched
}

// Level-triggered aging, run every tick: a pending item with no evidence for PENDING_TIMEOUT_MS becomes
// 'unconfirmed' (the injection likely mutated or never landed — the projection flags it); an unconfirmed
// item older than UNCONFIRMED_DROP_MS is dropped entirely.
export function ageDeliveries(items: DeliveryLedgerItem[], nowMs: number): DeliveryLedgerItem[] {
  if (!items.length) return items
  let changed = false
  const next: DeliveryLedgerItem[] = []
  for (const item of items) {
    const born = Date.parse(item.at)
    if (item.state === "pending" && Number.isFinite(born) && nowMs - born > PENDING_TIMEOUT_MS) {
      next.push({ ...item, state: "unconfirmed", updatedAt: new Date(nowMs).toISOString() })
      changed = true
      continue
    }
    if (item.state === "unconfirmed" && Number.isFinite(born) && nowMs - born > UNCONFIRMED_DROP_MS) {
      changed = true // dropped
      continue
    }
    // `enqueued` used to be IMMORTAL: nothing aged it and nothing dropped it, so a single missed
    // delivery record left a gray queued bubble pinned below the working indicator for the life of the
    // row — the "it still says queued long after the agent answered it" report. The reasoning for never
    // timing it out was sound (a mid-turn queue legitimately lasts as long as the turn) but it left no
    // escape hatch at all. Give it the same hour the unconfirmed items get: past that, a queue entry is
    // not a live queue entry, and the transcript's own records are a better witness than fray's
    // synthetic bubble. This only stops PROJECTING it; nothing about the real message is touched.
    if (item.state === "enqueued" && Number.isFinite(born) && nowMs - born > UNCONFIRMED_DROP_MS) {
      changed = true // dropped
      continue
    }
    next.push(item)
  }
  return changed ? next : items
}

// Project the ledger into a rendered transcript: every not-yet-delivered follow-up renders as the gray
// queued user bubble even when the JSONL carries no trace of it yet (reload-safe server truth replacing
// the client-only optimistic bubble). Rules, per item:
//  • the JSONL's own queued (enqueue) bubble already renders it → tag that bubble with the deliveryId
//    (the client's optimistic copy consumes by id) and don't double-render;
//  • a delivered copy already renders (correlation prune races a read by ≤1 tick) → skip entirely;
//  • otherwise append a queued bubble at the tail, where a just-sent follow-up belongs.
export function projectDeliveryLedger(messages: TranscriptMessage[], items: DeliveryLedgerItem[]): TranscriptMessage[] {
  if (!items.length) return messages
  for (const item of items) {
    const text = canon(item.text)
    const tag = deliveryTag(item.id)
    let handled = false
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "user") continue
      // Same order as correlation: identity if the rendered copy still carries our marker, text
      // otherwise. Transcript text is stripped for display before it reaches here, so in practice this
      // is the text compare — the tag check costs nothing and covers any surface that keeps the raw.
      if (!decodeDeliveryMarkers(m.text).includes(tag) && canon(stripDeliveryMarkers(m.text)) !== text) continue
      if (m.queued) {
        m.deliveryId = item.id
        m.deliveryState = item.state
      }
      handled = true // queued (tagged in place) or already delivered — either way, no projection
      break
    }
    if (handled) continue
    messages.push({
      sourceId: `delivery:${item.id}`,
      role: "user",
      text: item.text,
      tools: [],
      parts: [],
      at: item.at,
      queued: true,
      deliveryId: item.id,
      deliveryState: item.state,
    })
  }
  return messages
}
