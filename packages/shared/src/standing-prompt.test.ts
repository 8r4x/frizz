// The standing prompt's two pure pieces: the sentinel parser that CLOSES the loop, and the trailer
// that teaches the worker the sentinel exists. They are tested together because they are one contract —
// the wording delivered and the wording recognized have to agree, and nothing else in the system
// checks that they do.
import { test } from "node:test"
import assert from "node:assert/strict"
import { STANDING_PROMPT_SENTINEL, saysAllDone, standingPromptMessage } from "./index.ts"

test("saysAllDone: the sentinel closes the loop on its own line, however the worker dressed it", () => {
  assert.equal(saysAllDone("ALLDONE"), true)
  assert.equal(saysAllDone("Checked CI, nothing to do.\n\nALLDONE"), true)
  assert.equal(saysAllDone("**ALLDONE**"), true)
  assert.equal(saysAllDone("`ALLDONE`"), true)
  assert.equal(saysAllDone("- ALLDONE"), true)
  assert.equal(saysAllDone("ALLDONE."), true)
  assert.equal(saysAllDone("done\r\nALLDONE\r\n"), true, "CRLF transcripts must parse the same")
})

// The expensive failure is the FALSE POSITIVE: it silences a standing prompt the operator armed, with
// no error anywhere. A worker restating the protocol — which the delivered trailer invites it to do —
// must never count, so the sentinel is only ever read as a whole line.
test("saysAllDone: the sentinel embedded in prose does NOT close the loop", () => {
  assert.equal(saysAllDone("I'll reply ALLDONE when there's nothing left."), false)
  assert.equal(saysAllDone("Nothing yet, so no ALLDONE from me."), false)
  assert.equal(saysAllDone("ALLDONEISH"), false)
  assert.equal(saysAllDone("all done"), false, "the sentinel is exact, not a phrase match")
  assert.equal(saysAllDone(""), false)
  assert.equal(saysAllDone(undefined), false)
})

test("standingPromptMessage leads with the operator's words and teaches the sentinel it parses", () => {
  const message = standingPromptMessage("  keep fixing the failing tests  ")
  assert.ok(message.startsWith("keep fixing the failing tests"), "the operator's text comes first, verbatim")
  assert.ok(message.includes(STANDING_PROMPT_SENTINEL), "the trailer names the exact sentinel")
  // The trailer says the word — and the parser must NOT read the trailer's own mention as a close. It
  // is delivered as a USER turn so it never reaches the fold, but this pins the shape regardless.
  assert.equal(saysAllDone(message), false)
})
