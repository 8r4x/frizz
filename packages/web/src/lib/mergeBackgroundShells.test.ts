import assert from "node:assert/strict"
import test from "node:test"
import { mergeBackgroundShells } from "./childOps.ts"

// ONE background shell, TWO reporters. The board's tracked telemetry knows the launching tool_use id;
// the transcript projection knows only what the rendered message carries. The ops strip lists both and
// must draw ONE row.
//
// The regression these pin (maintainer, 2026-07-31, screenshot of two identical "Building release
// candidate and launcher" rows — "One background shell is clickable. The other is not"): the old key was
// label + startedAt, and the two sources DO NOT SHARE AN INSTANT. The board's is the tool_use record's
// timestamp; the transcript's is the projected message's, and a turn whose thinking and prose land before
// its call splits them by seconds. Real bytes from that launch (nub session ccc520d9): one message id
// spanning 19:11:27.256 / 19:11:28.190 / 19:11:32.200, the last being the Bash call.

const board = { id: "toolu_01Voy", label: "Building release candidate and launcher", startedAt: "2026-07-31T19:11:32.200Z", state: "running" }

test("the same shell reported by both sources collapses onto its launch id, however far the instants drift", () => {
  const merged = mergeBackgroundShells([board], [
    { label: "Building release candidate and launcher", startedAt: "2026-07-31T19:11:28.190Z", state: "running", launchId: "toolu_01Voy" },
  ])
  assert.equal(merged.length, 1, "two reporters, one process, one row")
  assert.equal(merged[0], board, "and the surviving row is the BOARD's — the one carrying the drill-in id")
})

test("a transcript-only shell still gets its row — this is codex's whole path", () => {
  const merged = mergeBackgroundShells([], [{ label: "Watching CI", startedAt: "2026-07-31T19:00:00.000Z", state: "running" }])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, undefined, "no id ⇒ the row renders non-interactive, never dropped")
})

test("label+startedAt survives as the fallback for a transcript with no launch id", () => {
  // A pre-restart server ships no `shellId`. Matching on the old key is still better than the duplicate.
  const merged = mergeBackgroundShells([board], [
    { label: "Building release candidate and launcher", startedAt: "2026-07-31T19:11:32.200Z", state: "running" },
  ])
  assert.equal(merged.length, 1)
})

test("two genuinely distinct shells the model described identically both keep their row", () => {
  const merged = mergeBackgroundShells(
    [board, { id: "toolu_02Zzz", label: "Building release candidate and launcher", startedAt: "2026-07-31T19:20:00.000Z", state: "running" }],
    [],
  )
  assert.equal(merged.length, 2, "the id is the identity — a shared label is not a collision")
})

test("a transcript row whose launch id is unknown to the board is not swallowed by a same-label board row", () => {
  const merged = mergeBackgroundShells([board], [
    { label: "Building release candidate and launcher", startedAt: "2026-07-31T19:40:00.000Z", state: "running", launchId: "toolu_03Qqq" },
  ])
  assert.equal(merged.length, 2)
})
