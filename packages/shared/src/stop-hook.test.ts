// The stop hook's two pure pieces: the sentinel parser that DEFERS a bump, and the trailer that teaches
// the worker the protocol. They are tested together because they are one contract — the wording
// delivered and the wording recognized have to agree, and nothing else in the system checks that they do.
import { test } from "node:test"
import assert from "node:assert/strict"
import { STOP_HOOK_SENTINEL, saysAwaiting, stopHookMessage } from "./index.ts"

test("saysAwaiting: the sentinel defers a bump on its own line, however the worker dressed it", () => {
  assert.equal(saysAwaiting("AWAITING"), true)
  assert.equal(saysAwaiting("Checked CI, nothing to do.\n\nAWAITING"), true)
  assert.equal(saysAwaiting("**AWAITING**"), true)
  assert.equal(saysAwaiting("`AWAITING`"), true)
  assert.equal(saysAwaiting("- AWAITING"), true)
  assert.equal(saysAwaiting("AWAITING."), true)
  assert.equal(saysAwaiting("done\r\nAWAITING\r\n"), true, "CRLF transcripts must parse the same")
})

// The expensive failure is the FALSE POSITIVE: it silences a bump the operator was expecting, with no
// error anywhere. A worker restating the protocol — which the delivered trailer invites it to do — must
// never count, so the sentinel is only ever read as a whole line.
test("saysAwaiting: the sentinel embedded in prose does NOT defer a bump", () => {
  assert.equal(saysAwaiting("I'll reply AWAITING when there's nothing left."), false)
  assert.equal(saysAwaiting("Nothing yet, so no AWAITING from me."), false)
  assert.equal(saysAwaiting("AWAITINGISH"), false)
  assert.equal(saysAwaiting("all done"), false, "the sentinel is exact, not a phrase match")
  assert.equal(saysAwaiting(""), false)
  assert.equal(saysAwaiting(undefined), false)
})

// THE COLLISION THIS NAME CREATES, pinned because it is invisible until it silently eats every bump on
// a parked thread: fray's own signal-fence grammar opens with ```awaiting, so a worker parking on a
// human/timer/PR gate writes that token as a whole line constantly. Only CASE separates the two.
test("saysAwaiting: an ```awaiting signal fence does NOT defer a bump", () => {
  assert.equal(saysAwaiting("```awaiting\nhuman: the maintainer has to approve the release\n```"), false)
  assert.equal(saysAwaiting("Parked on review.\n\n```awaiting\npr-watch: acme/app#391\n```"), false)
  assert.equal(saysAwaiting("awaiting"), false, "the lowercase fence word is never the sentinel")
  assert.equal(saysAwaiting("Awaiting"), false)
})

test("stopHookMessage leads with the operator's words and teaches BOTH exits", () => {
  const message = stopHookMessage("  keep fixing the failing tests  ")
  assert.ok(message.startsWith("keep fixing the failing tests"), "the operator's text comes first, verbatim")
  assert.ok(message.includes(STOP_HOOK_SENTINEL), "the trailer names the exact sentinel")
  // Naming only the sentinel is what let a worker read "skip this rest" as "we are finished here", so
  // the trailer has to carry the SCOPE of the sentinel and the OTHER exit alongside it.
  assert.match(message, /THIS rest/, "it says the sentinel is per-rest")
  assert.match(message, /stays\s+armed/, "…and that the hook survives it")
  assert.match(message, /action: "stop"/, "…and names the exit that actually disarms it")
  // The trailer says the word — and the parser must NOT read the trailer's own mention as a close. It
  // is delivered as a USER turn so it never reaches the fold, but this pins the shape regardless.
  assert.equal(saysAwaiting(message), false)
})
