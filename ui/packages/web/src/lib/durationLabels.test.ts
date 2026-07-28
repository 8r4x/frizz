import assert from "node:assert/strict"
import test from "node:test"
import { formatCountdownSeconds, formatElapsedMinutes, formatFixedDuration, formatToolDuration,
  formatCompactElapsed,
} from "./durationLabels.ts"

test("duration labels use unambiguous spelled compact units", () => {
  assert.equal(formatToolDuration(128 * 60_000), "128 min")
  assert.equal(formatToolDuration(128 * 60_000 + 3_000), "128 min 3 sec")
  assert.equal(formatElapsedMinutes(128), "2 hr 8 min")
  assert.equal(formatFixedDuration(128 * 60_000), "2 hr 8 min")
  assert.equal(formatCountdownSeconds(128), "2 min 08 sec")
})

test("formatCompactElapsed: seconds, minutes, hours — the dense child-row forms", () => {
  // The maintainer's exact spec, 2026-07-28: "12m" or "1hr 5m" or "38s".
  assert.equal(formatCompactElapsed(0), "0s")
  assert.equal(formatCompactElapsed(38_000), "38s")
  assert.equal(formatCompactElapsed(59_999), "59s")
  assert.equal(formatCompactElapsed(60_000), "1m")
  assert.equal(formatCompactElapsed(12 * 60_000), "12m")
  assert.equal(formatCompactElapsed(59 * 60_000), "59m")
  assert.equal(formatCompactElapsed(65 * 60_000), "1hr 5m")
  assert.equal(formatCompactElapsed(60 * 60_000), "1hr", "a whole hour drops the empty minutes")
  assert.equal(formatCompactElapsed(-1), "", "never a fabricated reading")
  assert.equal(formatCompactElapsed(Number.NaN), "")
})
