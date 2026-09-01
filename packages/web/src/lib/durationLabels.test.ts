import assert from "node:assert/strict"
import test from "node:test"
import { formatAgo, formatCountdown, formatCountdownSeconds, formatElapsedMinutes, formatFixedDuration,
  formatToolDuration, formatCompactElapsed, formatRuntimeElapsed,
} from "./durationLabels.ts"

// THE HOUSE DURATION GRAMMAR (maintainer 2026-08-31: `"40 minutes" -> "40m"` / `2hr 35m` / "Use this
// stylization everywhere. EVERYWHERE"). Every formatter in this module spells its units the same way —
// ms · s · m · hr · d · w — whatever ladder it climbs. This test is the pin: a reading that reverts to
// `40 min`, `2 hr 8 min` or `1h 17m` fails here rather than shipping as a fifth vocabulary.
test("every formatter spells its units in the house grammar", () => {
  assert.equal(formatToolDuration(128 * 60_000), "128m")
  assert.equal(formatToolDuration(128 * 60_000 + 3_000), "128m 3s")
  assert.equal(formatToolDuration(450), "450ms")
  assert.equal(formatToolDuration(0.4), "<1ms")
  assert.equal(formatToolDuration(2_300), "2.3s")
  assert.equal(formatElapsedMinutes(128), "2hr 8m")
  assert.equal(formatElapsedMinutes(40), "40m", "the maintainer's own example: 40 minutes reads 40m")
  assert.equal(formatElapsedMinutes(155), "2hr 35m", "and the compound one")
  assert.equal(formatFixedDuration(128 * 60_000), "2hr 8m")
  assert.equal(formatFixedDuration(20_000), "<1m")
  assert.equal(formatCountdownSeconds(45), "45s")
  assert.equal(formatCountdownSeconds(128), "2m 08s")
  assert.equal(formatCountdownSeconds(5_400), "1hr 30m")
  assert.equal(formatAgo(new Date(Date.now() - 40 * 60_000).toISOString()), "40m ago")

  // The grammar as a SHAPE: a number (or `<1`), its unit glued on, and at most one more pair after a
  // single space. A reading that reverts to `40 min`, `2 hr 8 min` or `1h 17m` cannot match it.
  const HOUSE_GRAMMAR = /^(?:<1|\d+(?:\.\d)?)(?:ms|s|m|hr|d|w|mo|y)(?: \d+(?:ms|s|m|hr|d|w|mo|y))?$/
  const readings = [
    formatToolDuration(0.4), formatToolDuration(450), formatToolDuration(2_300),
    formatToolDuration(128 * 60_000 + 3_000), formatElapsedMinutes(155), formatFixedDuration(128 * 60_000),
    formatCountdownSeconds(5_400), formatCountdownSeconds(128), formatCompactElapsed(65 * 60_000),
    formatRuntimeElapsed(3 * 86_400_000 + 4 * 3_600_000), formatRuntimeElapsed(13 * 3_600_000 + 48 * 60_000),
    formatCountdown(3 * 3_600_000 + 5 * 60_000), formatCountdown(2 * 86_400_000 + 3 * 3_600_000),
  ]
  for (const reading of readings) assert.match(reading, HOUSE_GRAMMAR, `off the house grammar: "${reading}"`)
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

test("formatRuntimeElapsed: the runtime slot's s/m/hr/d/w ladder, two units at most", () => {
  const S = 1_000, M = 60 * S, H = 60 * M, D = 24 * H, W = 7 * D
  // The maintainer's ladder, 2026-08-08 (`"2m" "1h 17m" etc (smhdw)`), in the house spelling the
  // 2026-08-31 sweep settled on: hours are `hr`.
  assert.equal(formatRuntimeElapsed(2 * M), "2m")
  assert.equal(formatRuntimeElapsed(H + 17 * M), "1hr 17m")

  assert.equal(formatRuntimeElapsed(0), "0s")
  assert.equal(formatRuntimeElapsed(42 * S), "42s")
  assert.equal(formatRuntimeElapsed(59_999), "59s")
  assert.equal(formatRuntimeElapsed(M), "1m")
  // Seconds never ride beside another unit — past a minute they are noise, which is what made the old
  // `120m 00s` reading both wrong in scale and wide enough to overflow the panel.
  assert.equal(formatRuntimeElapsed(2 * M + 5 * S), "2m")
  assert.equal(formatRuntimeElapsed(59 * M + 59 * S), "59m")
  assert.equal(formatRuntimeElapsed(2 * H), "2hr", "a whole hour drops the empty minutes")
  assert.equal(formatRuntimeElapsed(13 * H + 48 * M), "13hr 48m")
  assert.equal(formatRuntimeElapsed(23 * H + 59 * M), "23hr 59m")

  assert.equal(formatRuntimeElapsed(D), "1d")
  assert.equal(formatRuntimeElapsed(3 * D + 4 * H), "3d 4hr")
  assert.equal(formatRuntimeElapsed(6 * D + 23 * H), "6d 23hr")
  assert.equal(formatRuntimeElapsed(W), "1w")
  assert.equal(formatRuntimeElapsed(2 * W + 3 * D), "2w 3d")
  assert.equal(formatRuntimeElapsed(9 * W + 6 * D), "9w 6d", "weeks are the top of the ladder")

  assert.equal(formatRuntimeElapsed(-1), "", "never a fabricated reading")
  assert.equal(formatRuntimeElapsed(Number.NaN), "")
})

test("formatCountdown: padded, two units, in the house grammar", () => {
  const S = 1_000, M = 60 * S, H = 60 * M, D = 24 * H
  assert.equal(formatCountdown(45 * S), "45s")
  assert.equal(formatCountdown(12 * M + 5 * S), "12m 05s")
  assert.equal(formatCountdown(3 * H + 5 * M), "3hr 05m", "the trailing unit pads and never drops")
  assert.equal(formatCountdown(2 * D + 3 * H), "2d 3hr", "past a day it goes unpadded")
  assert.equal(formatCountdown(0), "0s")
})
