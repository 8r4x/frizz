import assert from "node:assert/strict"
import test from "node:test"
import { formatCountdownSeconds, formatElapsedMinutes, formatFixedDuration, formatToolDuration,
  formatCompactElapsed, formatRuntimeElapsed,
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

test("formatRuntimeElapsed: the runtime slot's s/m/h/d/w ladder, two units at most", () => {
  const S = 1_000, M = 60 * S, H = 60 * M, D = 24 * H, W = 7 * D
  // The maintainer's exact spec, 2026-08-08: `"2m" "1h 17m" etc (smhdw)`.
  assert.equal(formatRuntimeElapsed(2 * M), "2m")
  assert.equal(formatRuntimeElapsed(H + 17 * M), "1h 17m")

  assert.equal(formatRuntimeElapsed(0), "0s")
  assert.equal(formatRuntimeElapsed(42 * S), "42s")
  assert.equal(formatRuntimeElapsed(59_999), "59s")
  assert.equal(formatRuntimeElapsed(M), "1m")
  // Seconds never ride beside another unit — past a minute they are noise, which is what made the old
  // `120m 00s` reading both wrong in scale and wide enough to overflow the panel.
  assert.equal(formatRuntimeElapsed(2 * M + 5 * S), "2m")
  assert.equal(formatRuntimeElapsed(59 * M + 59 * S), "59m")
  assert.equal(formatRuntimeElapsed(2 * H), "2h", "a whole hour drops the empty minutes")
  assert.equal(formatRuntimeElapsed(13 * H + 48 * M), "13h 48m")
  assert.equal(formatRuntimeElapsed(23 * H + 59 * M), "23h 59m")

  assert.equal(formatRuntimeElapsed(D), "1d")
  assert.equal(formatRuntimeElapsed(3 * D + 4 * H), "3d 4h")
  assert.equal(formatRuntimeElapsed(6 * D + 23 * H), "6d 23h")
  assert.equal(formatRuntimeElapsed(W), "1w")
  assert.equal(formatRuntimeElapsed(2 * W + 3 * D), "2w 3d")
  assert.equal(formatRuntimeElapsed(9 * W + 6 * D), "9w 6d", "weeks are the top of the ladder")

  assert.equal(formatRuntimeElapsed(-1), "", "never a fabricated reading")
  assert.equal(formatRuntimeElapsed(Number.NaN), "")
})
