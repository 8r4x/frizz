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

// A question asked on BOTH surfaces at one rest drew two cards (2026-08-28, "Same question showing up
// twice in a row"): the worker registered it — the right move — and then re-fenced it at sign-off,
// because the contract called the fence the handback and never said "not both". For half a day the rule
// was "never also fence it"; the maintainer reversed that the same afternoon ("it kind of makes sense to
// me for the agent to decide where questions render in its own rest message"), so the fence is now the
// PLACEMENT and lib/questionShadow renders the registered card in its slot. One card either way — what
// the fence decides is where. The contract must teach the placement AND the withdrawal, because a
// question left out of the write-up is still open and still gates `done`.
test("the contract teaches a worker to PLACE its registered questions, or unask them", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /PLACE EVERY OPEN QUESTION IN YOUR HANDOFF, OR `unask` IT/)
    // The exact form, or a worker cannot write it: the id rides the fence's info string.
    assert.match(prompt, /```question qst_ab12cd34/)
    assert.match(prompt, /ONE card renders, and it is the\s+registered one/)
    // Leaving one out is not how a worker drops it — that is what `unask` is for.
    assert.match(prompt, /it is\s+one you `unask`/)
    // And the old rule must be GONE, not merely contradicted somewhere further down.
    assert.doesNotMatch(prompt, /A REGISTERED QUESTION IS NEVER ALSO FENCED/)
  }
})
