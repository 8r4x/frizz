import { test } from "node:test"
import assert from "node:assert/strict"
import type { TranscriptMessage } from "@fray-ui/shared"
import {
  parseDeliveryLedger,
  serializeDeliveryLedger,
  correlateDeliveryRecord,
  ageDeliveries,
  projectDeliveryLedger,
  PENDING_TIMEOUT_MS,
  UNCONFIRMED_DROP_MS,
  type DeliveryLedgerItem,
} from "./delivery-ledger.ts"

const T0 = Date.parse("2026-07-21T12:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()
const item = (over: Partial<DeliveryLedgerItem> = {}): DeliveryLedgerItem => ({
  id: "d-1",
  text: "fix the bug",
  state: "pending",
  at: iso(T0),
  updatedAt: iso(T0),
  ...over,
})
const msg = (over: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
  role: "user",
  text: "fix the bug",
  tools: [],
  parts: [],
  ...over,
})

// ---- parse / serialize ----
test("parse tolerates null, garbage, and malformed entries", () => {
  assert.deepEqual(parseDeliveryLedger(null), [])
  assert.deepEqual(parseDeliveryLedger("not json"), [])
  assert.deepEqual(parseDeliveryLedger(JSON.stringify([{ id: "x" }, item()])), [item()])
  assert.equal(serializeDeliveryLedger([]), null)
})

// ---- correlation ----
test("an enqueue record matching a pending item moves it to enqueued", () => {
  const out = correlateDeliveryRecord([item()], { type: "queue-operation", operation: "enqueue", content: "fix the bug\n", timestamp: iso(T0 + 500) }, iso(T0 + 500))
  assert.equal(out[0].state, "enqueued")
})

test("a queued_command attachment delivers (drops) the item", () => {
  const out = correlateDeliveryRecord(
    [item({ state: "enqueued" })],
    { type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "human" }, prompt: "fix the bug" }, timestamp: iso(T0 + 9000) },
    iso(T0 + 9000),
  )
  assert.deepEqual(out, [])
})

test("a plain user record delivers the item (idle submit / dead-session resume)", () => {
  const out = correlateDeliveryRecord([item()], { type: "user", message: { role: "user", content: "fix the bug" }, timestamp: iso(T0 + 3000) }, iso(T0 + 3000))
  assert.deepEqual(out, [])
})

test("an isMeta user record is never delivery evidence", () => {
  const out = correlateDeliveryRecord([item()], { type: "user", isMeta: true, message: { role: "user", content: "fix the bug" }, timestamp: iso(T0 + 3000) }, iso(T0 + 3000))
  assert.equal(out.length, 1)
})

test("a record timestamped BEFORE the send never resolves it (restart replay of old history)", () => {
  const out = correlateDeliveryRecord([item()], { type: "user", message: { role: "user", content: "fix the bug" }, timestamp: iso(T0 - 60_000) }, iso(T0))
  assert.equal(out.length, 1)
  const enq = correlateDeliveryRecord([item()], { type: "queue-operation", operation: "enqueue", content: "fix the bug", timestamp: iso(T0 - 60_000) }, iso(T0))
  assert.equal(enq[0].state, "pending")
})

test("non-matching text leaves the ledger untouched (same array identity)", () => {
  const items = [item()]
  const out = correlateDeliveryRecord(items, { type: "user", message: { role: "user", content: "unrelated" }, timestamp: iso(T0 + 1000) }, iso(T0 + 1000))
  assert.equal(out, items)
})

// ---- aging ----
test("a pending item times out to unconfirmed; enqueued never does", () => {
  const out = ageDeliveries([item(), item({ id: "d-2", state: "enqueued" })], T0 + PENDING_TIMEOUT_MS + 1000)
  assert.equal(out.find((i) => i.id === "d-1")?.state, "unconfirmed")
  assert.equal(out.find((i) => i.id === "d-2")?.state, "enqueued")
})

test("an unconfirmed item is dropped after the drop window", () => {
  const out = ageDeliveries([item({ state: "unconfirmed" })], T0 + UNCONFIRMED_DROP_MS + 1000)
  assert.deepEqual(out, [])
})

// ---- merged submissions (the "Delivery unconfirmed" bug) ----
// fray pastes a follow-up into Claude Code's composer and sends Enter. When the TUI swallows that Enter
// mid-render the text STAYS in the composer, and the next follow-up's paste lands after it — so one
// Enter submits the accumulation and Claude Code records ONE enqueue whose content is the concatenation.
// Byte shapes below are taken from the maintainer's own transcript (2026-07-23, `why-when-i-try-to-change`),
// where four such sends all reached the agent and all four rendered "Delivery unconfirmed" forever.
const merged = (a: string, b: string, sep = "") => ({
  type: "queue-operation", operation: "enqueue", timestamp: iso(T0 + 1000), content: `${a}${sep}${b}`,
})

test("a merged enqueue confirms EVERY send it is composed of (newline-joined)", () => {
  const a = item({ id: "d-a", text: "You should probably also investigate how the client and server ever got out of sync." })
  const b = item({ id: "d-b", text: "You have to remind me again why we are not just using the SDK for codex." })
  const out = correlateDeliveryRecord([a, b], merged(a.text, b.text, "\n"), iso(T0 + 1000))
  assert.deepEqual(out.map((i) => i.state), ["enqueued", "enqueued"])
})

test("a merged enqueue confirms both sends when the composer joined them with NO separator", () => {
  const a = item({ id: "d-a", text: "http://127.0.0.1:4919/thread/why-when-i-try-to-change" })
  const b = item({ id: "d-b", text: "> codex remote-control start|stop|pair — you sure this is the same kind of thing?" })
  const out = correlateDeliveryRecord([a, b], merged(a.text, b.text), iso(T0 + 1000))
  assert.deepEqual(out.map((i) => i.state), ["enqueued", "enqueued"])
})

test("a merged queued_command DELIVERS every send it is composed of", () => {
  const a = item({ id: "d-a", text: "the first long follow-up the composer swallowed" })
  const b = item({ id: "d-b", text: "the second follow-up whose Enter submitted both" })
  const rec = {
    type: "attachment", timestamp: iso(T0 + 1000),
    attachment: { type: "queued_command", commandMode: "prompt", prompt: `${a.text}\n${b.text}` },
  }
  assert.deepEqual(correlateDeliveryRecord([a, b], rec, iso(T0 + 1000)), [])
})

test("an ALREADY-unconfirmed item is rescued by a late enqueue", () => {
  // Observed: 87s and 12min between the send and the enqueue record, because the composer held the
  // paste. PENDING_TIMEOUT_MS is 60s, so the item had already gone amber — and used to stay that way.
  const stale = item({ state: "unconfirmed" })
  const out = correlateDeliveryRecord([stale], {
    type: "queue-operation", operation: "enqueue", timestamp: iso(T0 + 90_000), content: stale.text,
  }, iso(T0 + 90_000))
  assert.equal(out[0].state, "enqueued")
})

test("a merged record leaves an item it does NOT contain alone", () => {
  const a = item({ id: "d-a", text: "the first long follow-up the composer swallowed" })
  const other = item({ id: "d-b", text: "an unrelated send that never reached the composer" })
  const out = correlateDeliveryRecord([a, other], merged(a.text, "trailing text nobody sent", "\n"), iso(T0 + 1000))
  assert.deepEqual(out.map((i) => i.state), ["enqueued", "pending"])
})

test("a SHORT send is never resolved by merely appearing inside an unrelated message", () => {
  // The whole safety of the composition rule: a segment may only match mid-record when it is long
  // enough to be unambiguous. "continue" typed inside a human's own terminal message must not confirm
  // a pending "continue" fray sent.
  const items = [item({ text: "continue" })]
  const rec = { type: "user", timestamp: iso(T0 + 1000), message: { content: "ok, please continue with the plan" } }
  // Same array identity: nothing matched, so the caller writes nothing back to the row.
  assert.equal(correlateDeliveryRecord(items, rec, iso(T0 + 1000)), items)
})

// ---- channel rewrites (the "Delivery unconfirmed" bug class) ----
// The steer channel is tmux `paste-buffer` (LF→CR) composed with Claude Code's TUI paste handler
// (CR/CRLF→LF, TAB→four spaces). Measured against a live claude 2.1.219 TUI driven through fray's own
// paste sequence: a tab becomes four spaces and a CRLF becomes TWO newlines. Both classes stranded a
// send that the agent had already read. TABBED below is the maintainer's own stranded text
// (2026-07-25, `were-taking-over-from-another-agent`).
const TABBED = '> <tmp>: "r"\tno, but lossy vs intent\tsilently widens to rw on both\nWhy does this happen?'
const EXPANDED = TABBED.replace(/\t/g, "    ")
// The measured composition, applied the way the real channel applies it.
const throughChannel = (s: string) => s.replace(/\r\n|\r/g, "\n\n").replace(/\t/g, "    ")

test("a CRLF send survives the channel doubling its line breaks", () => {
  const text = "Review the sandbox design.\r\nThe ACL cleanup matters most.\r\nShip it when green."
  const out = correlateDeliveryRecord(
    [item({ text })],
    { type: "user", message: { role: "user", content: throughChannel(text) }, timestamp: iso(T0 + 40) },
    iso(T0 + 40),
  )
  assert.deepEqual(out, [])
})

test("tabs and CRLF together still deliver", () => {
  const text = "col1\tcol2\r\nrow2\tvalue\r\nand a closing line of prose"
  const out = correlateDeliveryRecord(
    [item({ text })],
    { type: "user", message: { role: "user", content: throughChannel(text) }, timestamp: iso(T0 + 40) },
    iso(T0 + 40),
  )
  assert.deepEqual(out, [])
})

test("a re-wrapped record (line breaks moved entirely) still delivers", () => {
  // Invariance, not channel-modelling: a future rewrite that re-flows lines must not resurrect the bug.
  const text = "the quick brown fox jumps over the lazy dog and keeps running"
  const rewrapped = "the quick brown fox\njumps over the lazy\ndog and keeps running"
  const out = correlateDeliveryRecord(
    [item({ text })],
    { type: "user", message: { role: "user", content: rewrapped }, timestamp: iso(T0 + 40) },
    iso(T0 + 40),
  )
  assert.deepEqual(out, [])
})

test("a user record whose tabs the TUI expanded still delivers the item", () => {
  const out = correlateDeliveryRecord(
    [item({ text: TABBED })],
    { type: "user", message: { role: "user", content: EXPANDED }, timestamp: iso(T0 + 34) },
    iso(T0 + 34),
  )
  assert.deepEqual(out, [])
})

test("a tab-expanded enqueue record still receipts the item", () => {
  const out = correlateDeliveryRecord(
    [item({ text: TABBED })],
    { type: "queue-operation", operation: "enqueue", content: EXPANDED, timestamp: iso(T0 + 500) },
    iso(T0 + 500),
  )
  assert.equal(out[0].state, "enqueued")
})

test("tab expansion does not break the merged-submission composition", () => {
  const a = item({ id: "d-a", text: "the first long follow-up\tthe composer swallowed" })
  const b = item({ id: "d-b", text: "the second follow-up\twhose Enter submitted both" })
  const rec = merged(a.text.replace(/\t/g, "    "), b.text.replace(/\t/g, "    "), "\n")
  assert.deepEqual(correlateDeliveryRecord([a, b], rec, iso(T0 + 1000)).map((i) => i.state), ["enqueued", "enqueued"])
})

test("the projection dedups against an already-delivered copy whose tabs were expanded", () => {
  // Without this the ledger appends a SECOND, amber copy of a message the transcript already renders —
  // the duplicate bubble the operator actually saw.
  const out = projectDeliveryLedger([msg({ text: EXPANDED, sourceId: "s:5" })], [item({ text: TABBED })])
  assert.equal(out.length, 1)
  assert.equal(out[0].deliveryId, undefined)
})

test("differing WORDS are still never matched — only whitespace is forgiven", () => {
  const items = [item({ text: "restart\tthe server" })]
  const rec = { type: "user", timestamp: iso(T0 + 1000), message: { content: "restart    the  daemon" } }
  assert.equal(correlateDeliveryRecord(items, rec, iso(T0 + 1000)), items)
})

test("a SHORT send is still never resolved by appearing inside an unrelated message, tabs or not", () => {
  const items = [item({ text: "\tcontinue" })]
  const rec = { type: "user", timestamp: iso(T0 + 1000), message: { content: "ok, please    continue with the plan" } }
  assert.equal(correlateDeliveryRecord(items, rec, iso(T0 + 1000)), items)
})

test("aging is identity-stable when nothing changes", () => {
  const items = [item({ state: "enqueued" })]
  assert.equal(ageDeliveries(items, T0 + 5000), items)
})

// ---- projection ----
test("an untracked send projects as a queued bubble at the tail", () => {
  const out = projectDeliveryLedger([msg({ text: "earlier", sourceId: "s:1" })], [item()])
  assert.equal(out.length, 2)
  const bubble = out[1]
  assert.equal(bubble.sourceId, "delivery:d-1")
  assert.equal(bubble.queued, true)
  assert.equal(bubble.deliveryId, "d-1")
  assert.equal(bubble.deliveryState, "pending")
})

test("the JSONL's own enqueue bubble is tagged in place, not double-rendered", () => {
  const existing = msg({ queued: true, sourceId: "s:9" })
  const out = projectDeliveryLedger([existing], [item({ state: "enqueued" })])
  assert.equal(out.length, 1)
  assert.equal(existing.deliveryId, "d-1")
  assert.equal(existing.deliveryState, "enqueued")
})

test("an already-delivered copy suppresses projection entirely (prune race)", () => {
  const out = projectDeliveryLedger([msg({ sourceId: "s:5" })], [item()])
  assert.equal(out.length, 1)
  assert.equal(out[0].deliveryId, undefined)
})
