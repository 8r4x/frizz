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
}

const norm = (s: string): string => s.replace(/\r\n?/g, "\n").trim()

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
  if (r.type === "queue-operation" && r.operation === "enqueue" && typeof r.content === "string") {
    const text = norm(r.content)
    const index = items.findIndex((item) => item.state === "pending" && norm(item.text) === text && contemporaneous(item))
    if (index === -1) return items
    const next = [...items]
    next[index] = { ...next[index], state: "enqueued", updatedAt: nowIso }
    return next
  }

  // Delivery into the agent's context: the queued_command attachment (mid-turn/turn-start pickup) or a
  // plain user record (idle submit / dead-session resume / the 2.1.207 print-path shape). Either one
  // resolves the item — delivered items leave the ledger; the real transcript record renders from here.
  let deliveredText: string | null = null
  if (r.type === "attachment") {
    const att = r.attachment as { type?: unknown; commandMode?: unknown; prompt?: unknown } | undefined
    if (att?.type === "queued_command" && att.commandMode === "prompt" && typeof att.prompt === "string") {
      deliveredText = norm(att.prompt)
    }
  } else if (r.type === "user" && r.isMeta !== true) {
    const text = userRecordText(r)
    if (text) deliveredText = norm(text)
  }
  if (deliveredText === null) return items
  const remaining = items.filter((item) => norm(item.text) !== deliveredText || !contemporaneous(item))
  return remaining.length === items.length ? items : remaining
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
    const text = norm(item.text)
    let handled = false
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "user" || norm(m.text) !== text) continue
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
