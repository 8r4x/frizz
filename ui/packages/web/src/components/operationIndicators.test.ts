import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { hasPendingToolSpinner, hasRunningToolIndicator, isRunningOperation, liveBackgroundOperationState, runningOperations } from "../lib/operationIndicators.ts"

test("multiple simultaneous background operations get individual live indicators while terminal states do not", () => {
  const operations = [
    { label: "Inspect logs", state: "running" },
    { label: "Run regression suite", state: "running" },
    { label: "Watch CI", state: "running" },
    { label: "Tail build log", state: "running" },
    { label: "Prior investigation", state: "stale" },
    { label: "Completed build", state: "completed" },
    { label: "Failed build", state: "failed" },
    { label: "Cancelled build", state: "cancelled" },
  ]
  assert.deepEqual(runningOperations(operations).map((operation) => operation.label), ["Inspect logs", "Run regression suite", "Watch CI", "Tail build log"])
  for (const state of ["stale", "completed", "failed", "cancelled", undefined]) assert.equal(isRunningOperation(state), false)
})

test("tool disclosures pulse only while their own call is pending", () => {
  assert.equal(hasRunningToolIndicator("pending", "background"), true)
  for (const status of ["completed", "failed", "cancelled"] as const) {
    assert.equal(hasRunningToolIndicator(status), false)
  }
  assert.equal(hasRunningToolIndicator("pending", "unknown"), false)
})

// The dot is the BACKGROUND signal, so the two pending kinds must be told apart, not merged: a detached
// op pulses, an ordinary long-running command spins. Exactly one indicator ever applies.
test("only a DETACHED pending call gets the live dot; a foreground one gets the spinner", () => {
  assert.equal(hasRunningToolIndicator("pending"), false, "a foreground Bash is not a background job")
  assert.equal(hasPendingToolSpinner("pending"), true, "…it spins instead")

  assert.equal(hasPendingToolSpinner("pending", "background"), false, "a detached op never doubles up")
  assert.equal(hasRunningToolIndicator("pending", "background"), true)

  // An orphaned Codex poll is a process fray cannot place — it claims neither liveness nor progress.
  assert.equal(hasRunningToolIndicator("pending", "unknown"), false)
  assert.equal(hasPendingToolSpinner("pending", "unknown"), false)

  for (const status of ["completed", "failed", "cancelled", undefined] as const) {
    assert.equal(hasPendingToolSpinner(status), false, `${status} is not in progress`)
  }
})

test("the foreground spinner keeps its mark under reduced motion, in the chip's own tone", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  // currentColor, NOT a --live-dot hue: the spinner must never read as the shell blue or agent accent.
  assert.match(css, /\.fray-tool-spinner \{[^}]*border-top-color: currentColor/)
  assert.doesNotMatch(css, /\.fray-tool-spinner \{[^}]*--live-dot/)
  assert.match(css, /\.fray-tool-spinner \{[^}]*animation: fray-tool-spin/)
  assert.match(css, /@keyframes fray-tool-spin/)
  // Motion off, mark still drawn — an in-progress call that renders nothing reads as finished.
  assert.match(css, /\.fray-tool-spinner \{ animation: none; border-color:/)
})

test("live background telemetry overrides a completed launch wrapper without borrowing another operation's state", () => {
  const operations = [
    { label: "Watch CI", state: "running" as const },
    { label: "Tail build log", state: "stale" as const },
  ]
  assert.equal(liveBackgroundOperationState({ backgroundState: "background", desc: "Watch CI" }, operations), "running")
  assert.equal(liveBackgroundOperationState({ backgroundState: "background", detail: "Tail build log" }, operations), "stale")
  assert.equal(liveBackgroundOperationState({ backgroundState: "background", desc: "Unrelated shell" }, operations), undefined)
  assert.equal(liveBackgroundOperationState({ backgroundState: "unknown", desc: "Watch CI" }, operations), undefined)
  assert.equal(liveBackgroundOperationState({ name: "Interrupt process", backgroundState: "background", detail: "session 35985" }, operations), undefined)
})

test("reduced motion keeps live work visible as a static ring in its own hue", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  // The static ring is recolored through the same --live-dot variable as the animated dot, so a
  // reduced-motion shell keeps its blue ring and a sub-agent its accent-yellow one.
  assert.match(css, /\.fray-live-dot \{ animation: none; background: transparent; border: 2px solid var\(--live-dot\); box-shadow: none; \}/)
})

test("running shells pulse blue and running sub-agents pulse the accent-yellow", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  // A distinct blue token, kept separate from the accent.
  assert.match(css, /--color-shell:\s*#[0-9a-fA-F]{3,8};/)
  // The live dot defaults to the accent-yellow (sub-agent) and the --shell modifier swaps in the blue.
  assert.match(css, /\.fray-live-dot \{[^}]*--live-dot: var\(--color-accent\)/)
  assert.match(css, /\.fray-live-dot--shell \{ --live-dot: var\(--color-shell\); \}/)
  assert.match(css, /\.fray-live-dot--agent \{ --live-dot: var\(--color-accent\); \}/)
  // The quiet-but-alive shell dot follows the shell blue too.
  assert.match(css, /\.fray-live-dot-quiet--shell \{ --live-dot: var\(--color-shell\); \}/)
})

test("a quiet-but-alive background shell breathes, and stays visible as a static ring under reduced motion", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  // It must ANIMATE (breathe) rather than sit as a dead gray dot…
  assert.match(css, /\.fray-live-dot-quiet \{[^}]*animation: fray-live-breathe/)
  assert.match(css, /@keyframes fray-live-breathe/)
  // …and degrade to a static ring (never fully disappear) when motion is reduced.
  assert.match(css, /\.fray-live-dot-quiet \{ animation: none;[^}]*border: 1\.5px solid/)
})
