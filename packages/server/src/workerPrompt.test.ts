import assert from "node:assert/strict"
import test from "node:test"
import { buildWorkerPrompt } from "./workerPrompt.ts"

test("both worker backends receive the gerund activity-caption contract", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /starts with an `-ing` verb\*\*, in sentence case/)
    assert.match(prompt, /Reading src\/config\.ts/)
    // The imperative is the form that keeps slipping through, so the contract must name it and show
    // the conversion — and must forbid papering over it with a `Running` prefix.
    assert.match(prompt, /`Find relative links in the README` → `Finding relative links in the README`/)
    assert.match(prompt, /Never prefix a description with `Running`/)
  }
})

// THE CEILING, which is the counterweight to a stop criterion that otherwise only ever says "do not
// stop". Traced 2026-08-17 on `investigate-nubjs-nub-642`: dispatched to TRIAGE an issue and recommend
// what to do, it produced the analysis, asked one design question, got no answer for 36 hours, and then
// — under a Goal telling it that a written-up plan is not an ending and that unanswered calls are its own
// to make — decided the question itself and shipped seven commits, a moved global bin dir, shell-profile
// writing and a docs change. Nothing woke it but its own background completions.
//
// "Keep going" is unbounded by construction: there is always more to do in any repo, so a worker
// forbidden to stop can only stop by widening its remit. Both halves have to be in the contract.
test("the contract bounds the work to the task, not only the stopping", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /THE INSTRUCTION IS ALSO THE CEILING/)
    assert.match(prompt, /Work you notice on the way is a FINDING, not a task/)
    // An ANALYSIS job ends with its analysis. Denying that is what turned a triage into a feature branch.
    assert.match(prompt, /the document is the ending/i)
    assert.match(prompt, /Implementing what it proposes is the NEXT job/)
    // …and silence from the human is not a mandate.
    assert.match(prompt, /unanswered question is not permission to build the answer/i)
  }
})

// The placement rule's whole arc, because the contract has now taught three different things here and a
// stale assertion would resurrect the wrong one. (1) 2026-08-28 morning, "Same question showing up twice
// in a row": register-then-refence drew two cards, so the rule was "never also fence it". (2) The same
// afternoon the maintainer reversed it ("it kind of makes sense to me for the agent to decide where
// questions render in its own rest message"), and the fence became the PLACEMENT. (3) 2026-08-30 the
// maintainer retired placement ("Retire mid-prose placement" — measured: 15 of 17 real markers sat at
// the tail where the card lands anyway, 2 of 3,005 transcripts couched one mid-prose). The card now
// draws itself at its rest, a fence naming or restating a registration draws nothing, and the contract
// must teach the withdrawal — a question left out of the write-up is still open and still gates `done`.
test("the contract teaches that a registered question draws itself, and how to unask one", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /EVERY OPEN QUESTION DRAWS ITS OWN CARD AT ITS REST/)
    assert.match(prompt, /draws NOTHING: one question, one card/)
    // Leaving one out is not how a worker drops it — that is what `unask` is for.
    assert.match(prompt, /it is one you\s+`unask`/)
    // And the retired grammar must be GONE, not merely contradicted somewhere further down: the empty
    // placement fence taught by example is exactly what a worker would keep writing.
    assert.doesNotMatch(prompt, /PLACE EVERY OPEN QUESTION/)
    assert.doesNotMatch(prompt, /```question qst_ab12cd34\n\s*```/)
    assert.doesNotMatch(prompt, /A REGISTERED QUESTION IS NEVER ALSO FENCED/)
  }
})
