import type { TranscriptMessage } from "@fray-ui/shared"
import type { Storage } from "./storage.ts"

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
export function appendDelivery(storage: Storage, slug: string, item: { id: string; text: string; now?: number }): void {
  const row = storage.getSession(slug)
  if (!row) return
  const items = parseDeliveryLedger(row.delivery_ledger)
  if (items.some((existing) => existing.id === item.id)) return
  const at = new Date(item.now ?? Date.now()).toISOString()
  items.push({ id: item.id, text: item.text, state: "pending", at, updatedAt: at })
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
    const matched = matchComposedText(items, canon(r.content), contemporaneous)
    if (matched.size === 0) return items
    return items.map((item, index) =>
      matched.has(index) && item.state !== "enqueued" ? { ...item, state: "enqueued", updatedAt: nowIso } : item,
    )
  }

  // Delivery into the agent's context: the queued_command attachment (mid-turn/turn-start pickup) or a
  // plain user record (idle submit / dead-session resume / the 2.1.207 print-path shape). Either one
  // resolves the item — delivered items leave the ledger; the real transcript record renders from here.
  let deliveredText: string | null = null
  if (r.type === "attachment") {
    const att = r.attachment as { type?: unknown; commandMode?: unknown; prompt?: unknown } | undefined
    if (att?.type === "queued_command" && att.commandMode === "prompt" && typeof att.prompt === "string") {
      deliveredText = canon(att.prompt)
    }
  } else if (r.type === "user" && r.isMeta !== true) {
    const text = userRecordText(r)
    if (text) deliveredText = canon(text)
  }
  if (deliveredText === null) return items
  const delivered = matchComposedText(items, deliveredText, contemporaneous)
  if (delivered.size === 0) return items
  return items.filter((_, index) => !delivered.has(index))
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
    let handled = false
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "user" || canon(m.text) !== text) continue
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
