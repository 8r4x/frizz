import assert from "node:assert/strict"
import test from "node:test"
import { parseSourceId } from "./debug-message.mjs"

test("parseSourceId reads a Claude message id", () => {
  assert.deepEqual(parseSourceId("claude:c339e6e4-fc73-4f41-a2e6-1eea19ccd447:24009"), {
    backend: "claude",
    sessionId: "c339e6e4-fc73-4f41-a2e6-1eea19ccd447",
    offset: 24009,
  })
})

test("parseSourceId reads a Codex message id, including its event ordinal", () => {
  assert.deepEqual(parseSourceId("codex:0199f0ab-1111-2222-3333-444455556666:9312:2"), {
    backend: "codex",
    sessionId: "0199f0ab-1111-2222-3333-444455556666",
    offset: 9312,
    ordinal: 2,
  })
})

test("parseSourceId tolerates surrounding whitespace from a clipboard paste", () => {
  assert.equal(parseSourceId("  claude:abc:10\n")?.offset, 10)
})

test("parseSourceId rejects anything that is not a resolvable message id", () => {
  // Byte offset 0 is legitimate (the first record in a log), so it must NOT be rejected.
  assert.equal(parseSourceId("claude:abc:0")?.offset, 0)
  for (const bad of [
    "",
    "claude",
    "claude:abc",
    "claude:abc:notanumber",
    "claude:abc:10:20:30",
    "claude::10", // empty session id
    "delivery:abc123", // a ledger-projected optimistic bubble — no log record backs it
    "gemini:abc:10", // unknown backend
    undefined,
  ]) {
    assert.equal(parseSourceId(bad), undefined, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})
