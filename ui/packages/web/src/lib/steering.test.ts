import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@fray-ui/shared"
import { isOptimisticallySteering, STEER_OPTIMISM_MS } from "./steering.ts"

const at = (lastActivityAt?: string) => ({ id: "t", lastActivityAt } as unknown as ThreadView)

test("a fresh steer renders as working before the server has said anything", () => {
  const sent = 1_000_000
  // Board activity predating the steer is exactly the stale reading the hint exists to cover.
  assert.equal(isOptimisticallySteering(at(new Date(sent - 5_000).toISOString()), sent, sent + 200), true)
  assert.equal(isOptimisticallySteering(at(undefined), sent, sent + 200), true)
})

test("server truth reclaims the row as soon as it is newer than the steer", () => {
  const sent = 1_000_000
  // Any activity stamped after the send means the tailer has looked since — whatever it reports now
  // (running, or already finished and back at rest) beats the guess.
  assert.equal(isOptimisticallySteering(at(new Date(sent + 1).toISOString()), sent, sent + 200), false)
})

test("the hint expires rather than spinning forever on a steer that produced nothing", () => {
  const sent = 1_000_000
  assert.equal(isOptimisticallySteering(at(undefined), sent, sent + STEER_OPTIMISM_MS - 1), true)
  assert.equal(isOptimisticallySteering(at(undefined), sent, sent + STEER_OPTIMISM_MS + 1), false)
})

test("a thread that was never steered is untouched", () => {
  assert.equal(isOptimisticallySteering(at(undefined), undefined, 1_000_000), false)
})

test("an unparseable activity stamp falls back to the hint rather than throwing it away", () => {
  const sent = 1_000_000
  assert.equal(isOptimisticallySteering(at("not-a-date"), sent, sent + 200), true)
})
