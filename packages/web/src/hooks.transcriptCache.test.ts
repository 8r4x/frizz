import assert from "node:assert/strict"
import { test } from "node:test"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { latestConfirmation, transcriptStaleTime } from "./hooks.ts"

// The transcript query had no staleTime, so every open re-read the whole transcript — including a return
// to the thread you just left, which painted from cache in 63ms and then spent 1998ms on a request whose
// answer was already on screen (measured on a copy of the maintainer's 558-thread board, 2026-09-04).
// The number is the easy half. These cases pin the GATE, because a stale transcript is far worse than a
// slow one: the cache may only be served while the board says the thread has NOT moved since we read it.

function board(rows: Array<{ id: string; lastActivityAt?: string }>): BoardSnapshot {
  return { threads: rows as ThreadView[], errors: [] } as unknown as BoardSnapshot
}

const READ_AT = Date.parse("2026-09-04T12:00:00.000Z")
const at = (offsetMs: number) => new Date(READ_AT + offsetMs).toISOString()

test("a thread that has not moved since the read is served from cache", () => {
  const rows = board([{ id: "calm", lastActivityAt: at(-60_000) }])
  assert.equal(transcriptStaleTime(rows, "calm", READ_AT), 15_000)
})

test("a thread the board says moved AFTER the read is re-read on sight", () => {
  const rows = board([{ id: "advancing", lastActivityAt: at(1) }])
  assert.equal(transcriptStaleTime(rows, "advancing", READ_AT), 0, "one millisecond of lead is still a lead")
  assert.equal(transcriptStaleTime(board([{ id: "advancing", lastActivityAt: at(30_000) }]), "advancing", READ_AT), 0)
})

test("no marker to gate on means no cache window", () => {
  // A board that has not seeded yet, a thread in another project, a row with no activity recorded, and a
  // marker the client cannot parse. Every one of them is "we cannot prove this copy is current".
  assert.equal(transcriptStaleTime(null, "unknown", READ_AT), 0)
  assert.equal(transcriptStaleTime(board([{ id: "other" }]), "unknown", READ_AT), 0)
  assert.equal(transcriptStaleTime(board([{ id: "fresh" }]), "fresh", READ_AT), 0)
  assert.equal(transcriptStaleTime(board([{ id: "bad", lastActivityAt: "not a date" }]), "bad", READ_AT), 0)
})

test("an empty cache entry is never served: dataUpdatedAt 0 predates every marker", () => {
  assert.equal(transcriptStaleTime(board([{ id: "cold", lastActivityAt: at(-3_600_000) }]), "cold", 0), 0)
})

// ---- the watchdog's notion of "confirmed" (see useTranscript) ----
// A push or a refetch stamps dataUpdatedAt; on a streaming thread that stamp is seconds old while the
// newest message carrying an `at` can be minutes old (a long tool stretch). The watchdog must read the
// stamp, or it fires on every tick of a perfectly live view and re-reads the whole transcript each time.
test("latestConfirmation: a fresh cache stamp outranks an old rendered tail; the tail is the floor without one", () => {
  const stamp = Date.parse("2026-09-18T23:52:30.000Z")
  assert.equal(latestConfirmation(stamp, "2026-09-18T23:50:29.000Z"), "2026-09-18T23:52:30.000Z")
  assert.equal(latestConfirmation(stamp, undefined), "2026-09-18T23:52:30.000Z")
  assert.equal(latestConfirmation(0, "2026-09-18T23:50:29.000Z"), "2026-09-18T23:50:29.000Z")
  assert.equal(latestConfirmation(undefined, undefined), undefined)
  // A rendered tail NEWER than the stamp (server clock ahead of a push landing) still wins — never behind.
  assert.equal(latestConfirmation(stamp, "2026-09-18T23:53:00.000Z"), "2026-09-18T23:53:00.000Z")
})
