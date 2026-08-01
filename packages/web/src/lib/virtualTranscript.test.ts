import { test } from "node:test"
import assert from "node:assert/strict"
import type { ChatMessage } from "../hooks.ts"
import { buildVirtualTranscriptMessageRows, earlierLoadGate, nextTailFollow, TAIL_FOLLOW_PX } from "./virtualTranscript.ts"

function message(over: Partial<ChatMessage>): ChatMessage {
  return {
    role: "assistant",
    text: "message",
    tools: [],
    sourceId: "message",
    ...over,
  } as ChatMessage
}

test("virtual transcript rows omit queued and empty messages while preserving source keys", () => {
  const rows = buildVirtualTranscriptMessageRows(
    [
      message({ sourceId: "first" }),
      message({ sourceId: "empty", text: "" }),
      message({ sourceId: "queued", queued: true }),
      message({ sourceId: "last" }),
    ],
    (candidate) => candidate.text === "",
    () => 14,
  )
  assert.deepEqual(rows.map(({ key, messageIndex, gap }) => ({ key, messageIndex, gap })), [
    { key: "first", messageIndex: 0, gap: 0 },
    { key: "last", messageIndex: 3, gap: 14 },
  ])
})

test("the gap of each row is charged against the previous RENDERED message", () => {
  // The skipped rows must not become the `previous` the gap is measured from — a queued bubble sits at
  // the bottom of the pane, and an empty message paints nothing, so neither is a neighbour of anything.
  const rows = buildVirtualTranscriptMessageRows(
    [
      message({ sourceId: "a" }),
      message({ sourceId: "queued", queued: true }),
      message({ sourceId: "b" }),
      message({ sourceId: "c" }),
    ],
    () => false,
    (previous, next) => (previous.sourceId === "a" && next.sourceId === "b" ? 10 : 14),
  )
  assert.deepEqual(rows.map((row) => ({ key: row.key, gap: row.gap })), [
    { key: "a", gap: 0 },
    { key: "b", gap: 10 },
    { key: "c", gap: 14 },
  ])
})

test("legacy duplicate rows still receive unique render keys", () => {
  const duplicate = message({ sourceId: undefined })
  const rows = buildVirtualTranscriptMessageRows([duplicate, duplicate], () => false, () => 14)
  assert.notEqual(rows[0]?.key, rows[1]?.key)
})

// A pane 700px tall over `scrollHeight` of content, with the reader `distance` px off the bottom.
function view(scrollHeight: number, distance: number, over: Partial<Parameters<typeof nextTailFollow>[0]> = {}) {
  const clientHeight = 700
  return {
    scrollHeight,
    clientHeight,
    scrollTop: scrollHeight - clientHeight - distance,
    previousScrollHeight: scrollHeight,
    following: true,
    readerMoved: false,
    ...over,
  }
}

test("growing content re-pins a reader who is at the tail", () => {
  // The transcript grew by 122px (a row mounting at its estimate) under a reader parked at the bottom.
  assert.deepEqual(
    nextTailFollow(view(2122, 122, { previousScrollHeight: 2000 })),
    { following: true, scrollTop: 1422 },
  )
})

test("growing content leaves a reader who scrolled away exactly where they are", () => {
  assert.deepEqual(
    nextTailFollow(view(2122, 722, { previousScrollHeight: 2000, following: false })),
    { following: false, scrollTop: null },
  )
})

test("a reader who nudged up even a couple of lines is not attached", () => {
  // The rule the reader expects, literally: if the bottom of the transcript is not at the bottom of the
  // pane, nothing that lands may move them. 24px is smaller than a single wheel notch and used to count
  // as "at the tail" — one append dragged such a reader 346px back down.
  for (const nudge of [8, 24, 64, 240]) {
    assert.deepEqual(nextTailFollow(view(2000, nudge)), { following: false, scrollTop: null }, `${nudge}px up must detach`)
    // …and content landing afterwards must leave them exactly where they are.
    assert.deepEqual(
      nextTailFollow(view(2122, nudge + 122, { previousScrollHeight: 2000, following: false })),
      { following: false, scrollTop: null },
    )
  }
})

test("the attachment band stays a rounding epsilon, not a comfort zone", () => {
  // Guards the constant itself: anything a reader could deliberately scroll to must be outside it.
  assert.ok(TAIL_FOLLOW_PX <= 4, `TAIL_FOLLOW_PX must stay sub-perceptual, got ${TAIL_FOLLOW_PX}`)
})

test("a reader-driven scroll reclassifies attachment but never writes back", () => {
  // Same scroll height ⇒ only the reader can have moved, so the distance is their intent. Beyond the
  // threshold detaches; inside it stays attached — and NEITHER writes, or the wheel gets fought.
  assert.deepEqual(nextTailFollow(view(2000, TAIL_FOLLOW_PX + 1)), { following: false, scrollTop: null })
  assert.deepEqual(nextTailFollow(view(2000, TAIL_FOLLOW_PX - 1)), { following: true, scrollTop: null })
})

test("a scroll landing in the same beat as a resize is the reader's while a gesture is live", () => {
  const scrolledUpMidStream = { previousScrollHeight: 2000, readerMoved: true }
  assert.deepEqual(nextTailFollow(view(2122, 500, scrolledUpMidStream)), { following: false, scrollTop: null })
  // Without the gesture the same shape is content growth, so attachment (and the re-pin) survives.
  assert.deepEqual(
    nextTailFollow(view(2122, 500, { previousScrollHeight: 2000 })),
    { following: true, scrollTop: 1422 },
  )
})

test("a shrink that brings the tail back to a detached reader re-attaches them", () => {
  assert.deepEqual(
    nextTailFollow(view(1400, 0, { previousScrollHeight: 2000, following: false })),
    { following: true, scrollTop: null },
  )
})

test("sub-pixel residue at the true bottom never provokes a write", () => {
  assert.deepEqual(nextTailFollow(view(2122, 1, { previousScrollHeight: 2000 })), { following: true, scrollTop: null })
})

test("content shorter than the pane is never scrolled", () => {
  assert.deepEqual(
    nextTailFollow({ scrollTop: 0, scrollHeight: 400, clientHeight: 700, previousScrollHeight: 200, following: true, readerMoved: false }),
    { following: true, scrollTop: null },
  )
})

test("earlier-page loading fires once at the top until the reader leaves or explicitly rearms", () => {
  const first = earlierLoadGate({ armed: true, scrollTop: 0, readerMoved: true, hasEarlier: true, loading: false })
  assert.deepEqual(first, { armed: false, shouldLoad: true })
  assert.deepEqual(
    earlierLoadGate({ armed: first.armed, scrollTop: 0, readerMoved: true, hasEarlier: true, loading: false }),
    { armed: false, shouldLoad: false },
  )
  const leftTop = earlierLoadGate({ armed: false, scrollTop: 700, readerMoved: true, hasEarlier: true, loading: false })
  assert.deepEqual(leftTop, { armed: true, shouldLoad: false })
  assert.equal(
    earlierLoadGate({ armed: leftTop.armed, scrollTop: 400, readerMoved: true, hasEarlier: true, loading: false }).shouldLoad,
    true,
  )
})
