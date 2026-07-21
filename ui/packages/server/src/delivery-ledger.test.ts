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
