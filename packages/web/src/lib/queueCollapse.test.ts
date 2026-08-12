import { test } from "node:test"
import assert from "node:assert/strict"
import { isGoalBump, supersededAskIndices, survivesQueueCollapse } from "./queueCollapse.ts"

// The REAL Goal delivery frizz wrote into the maintainer's zod thread on 2026-08-12, verbatim — trailer,
// the `<!-- frizz-wake:… -->` token and all. The token is the whole reason `text` cannot be matched
// directly (the trailer regex is `$`-anchored), so a synthesized fixture without it would pass while the
// app kept rendering the hairline.
const GOAL_TEXT =
  "If further work towards the original task/goal remains, keep going. If there are open questions that require human input, ask them with question fences.\n\n" +
  "(Goal — sent each time you come to rest. To stop these, sign off with a ```done fence — but ONLY when the work is genuinely finished: it files this thread away, and nothing but new work from the human reopens it. Sign off either way — ```question if you need the human, ```done if it is truly finished: 1-3 sentences, then **bolded verb phrase** bullets.)\n\n" +
  "<!-- frizz-wake:c6f2d0f6ac80b70c94d4310334e92a8852245d9076df1cb2529a37251f7310b3 -->"
const GOAL_DISPLAY = GOAL_TEXT.replace(/\n*<!-- frizz-wake:[a-f0-9]+ -->$/, "")

const ask = (body: string) => "Here is where things stand.\n\n```question\n" + body + "\n```\n"

// ---- isGoalBump ----

test("the Goal bump is matched on the PRESENTATION text, not the raw text", () => {
  assert.equal(isGoalBump({ text: GOAL_TEXT, displayText: GOAL_DISPLAY, wake: true }), true)
  // No displayText → the raw text still carries the delivery token after the `$`-anchored trailer, so
  // the parse cannot fire. This is the shape the pre-ef1afce code was matching, and it is why the
  // hairline rendered anyway.
  assert.equal(isGoalBump({ text: GOAL_TEXT, wake: true }), false)
})

test("a wake that is not the Goal, and an ordinary message, are not bumps", () => {
  assert.equal(isGoalBump({ text: "👤 Review from @colinhacks on acme/app#391", wake: true }), false)
  assert.equal(isGoalBump({ text: GOAL_TEXT, displayText: GOAL_DISPLAY }), false, "no wake flag → not a delivery")
})

// ---- supersededAskIndices ----

test("a verbatim re-ask supersedes the older copy, and only the older copy", () => {
  const blocks = "Ship it?\n\n- A. Yes (recommended)\n- B. No"
  const messages = [
    { text: "Working on it." },
    { text: "The engineering is finished and green.\n\n" + ask(blocks) },
    { text: "Confirmed independently: every check now passes.\n\n" + ask(blocks) },
  ]
  assert.deepEqual([...supersededAskIndices(messages)], [1], "only the earlier of the two identical asks")
})

test("two DIFFERENT asks never supersede each other", () => {
  const messages = [
    { text: ask("Ship it?\n\n- A. Yes\n- B. No") },
    { text: ask("Delete the branch?\n\n- A. Yes\n- B. No") },
  ]
  assert.deepEqual([...supersededAskIndices(messages)], [])
})

test("supersession keys on the question BLOCKS, never the prose around them", () => {
  // The measured case: the two fences were byte-identical and ONLY the lead paragraph differed.
  const blocks = "Which handler shape?\n\n- A. Return a fragment (recommended)\n- B. Policy only"
  const messages = [
    { text: "Two things are genuinely yours to decide.\n\n" + ask(blocks) },
    { text: "Confirmed independently: the PR is fully green.\n\n" + ask(blocks) },
  ]
  assert.deepEqual([...supersededAskIndices(messages)], [0])
})

test("a message with no question fence is never superseded", () => {
  assert.deepEqual([...supersededAskIndices([{ text: "plain prose" }, { text: "plain prose" }])], [])
})

// ---- survivesQueueCollapse ----

test("an open ask survives the collapse; a superseded one does not", () => {
  const blocks = "Ship it?\n\n- A. Yes\n- B. No"
  const messages = [{ text: ask(blocks) }, { text: ask(blocks) }]
  const superseded = supersededAskIndices(messages)
  assert.equal(survivesQueueCollapse(messages[0], 0, superseded), false, "the older copy collapses")
  assert.equal(survivesQueueCollapse(messages[1], 1, superseded), true, "the newest copy carries the decision")
})

test("a wake survives the collapse — it is what says the agent was re-invoked", () => {
  const none = new Set<number>()
  // A scheduler delivery (a pr-watch wake), and the `boundary:"wake"` divider a sub-agent or
  // background-shell completion draws.
  assert.equal(survivesQueueCollapse({ text: "👤 Review from @colinhacks on acme/app#391", wake: true }, 3, none), true)
  assert.equal(survivesQueueCollapse({ text: "Sub-agent « Watching CI » finished", boundary: "wake" }, 4, none), true)
})

test("the GOAL's own bump does not survive — the card refuses to narrate it", () => {
  const none = new Set<number>()
  assert.equal(survivesQueueCollapse({ text: GOAL_TEXT, displayText: GOAL_DISPLAY, wake: true }, 5, none), false)
})

test("ordinary chatter collapses", () => {
  const none = new Set<number>()
  assert.equal(survivesQueueCollapse({ text: "Let me read the implementation." }, 2, none), false)
  assert.equal(survivesQueueCollapse({ text: "", boundary: "rest" }, 2, none), false)
})
