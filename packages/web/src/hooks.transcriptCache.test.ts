import assert from "node:assert/strict"
import { test } from "node:test"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { transcriptStaleTime } from "./hooks.ts"

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
