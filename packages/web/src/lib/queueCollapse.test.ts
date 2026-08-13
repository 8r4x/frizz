import { test } from "node:test"
import assert from "node:assert/strict"
import { isGoalBump, queueCollapseSegments, segmentFolds, supersededAskIndices, survivesQueueCollapse } from "./queueCollapse.ts"

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

test("a SCHEDULER wake survives — nothing else on the card represents it", () => {
  const none = new Set<number>()
  assert.equal(survivesQueueCollapse({ text: "👤 Review from @colinhacks on acme/app#391", wake: true }, 3, none), true)
})

test("a background-task/sub-agent COMPLETION does not survive — its launch card already stands for it", () => {
  const none = new Set<number>()
  // Keeping it renders one event twice, and inverted: the completion flows in transcript order while the
  // launch is one synthesized row at the foot of the span.
  assert.equal(survivesQueueCollapse({ text: "Sub-agent « Watching CI » finished", boundary: "wake" }, 4, none), false)
  assert.equal(survivesQueueCollapse({ text: "Background task «Running the full suite» finished", boundary: "wake" }, 5, none), false)
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

// ---- queueCollapseSegments ----
//
// ONE FOLD PER WAKE. These are the shapes the maintainer described on 2026-08-12 — a thread driven
// across several watcher wakes, and the run whose calls landed after its closing prose.

// Shorthand: `p` prose, `t` a tools-only step, `w` a wake, `x` a message the card drops outright.
const p = (tools = 0) => ({ text: true, tools, countable: true })
const t = (tools = 1) => ({ tools, countable: true })
const w = () => ({ opens: true, survives: true, countable: true })
const x = () => ({ skip: true })

test("with no wake the whole run is one segment, anchored on the first and last prose", () => {
  const segs = queueCollapseSegments([x(), p(), t(3), t(2), p()], 1)
  assert.equal(segs.length, 1)
  assert.deepEqual(
    { start: segs[0].start, end: segs[0].end, open: segs[0].open, close: segs[0].close, woken: segs[0].woken },
    { start: 1, end: 4, open: 1, close: 4, woken: false },
  )
  assert.equal(segs[0].tools, 5)
  assert.equal(segs[0].steps, 2, "the two tools-only middles are hidden whole")
})

test("a wake CUTS: each run gets its own fold, and the wake itself belongs to neither", () => {
  //  0 ask · 1 prose · 2 tools · 3 prose · 4 WAKE · 5 tools · 6 tools · 7 prose
  const segs = queueCollapseSegments([x(), p(), t(4), p(), w(), t(3), t(2), p()], 1)
  assert.equal(segs.length, 2)
  assert.deepEqual([segs[0].start, segs[0].end, segs[0].woken], [1, 3, false])
  assert.deepEqual([segs[1].start, segs[1].end, segs[1].woken], [5, 7, true])
  assert.equal(segs[0].tools, 4)
  assert.equal(segs[1].tools, 5, "the second run's calls are ITS run's, not the first's")
})

// The screenshot that started this: "a bunch of bash calls show up right at the end". They are the same
// run's work — the agent simply stopped narrating before it stopped working — so they fold with it.
test("calls made AFTER the closing prose stay inside that run's fold", () => {
  const segs = queueCollapseSegments([x(), p(), p(), t(6), t(1)], 1)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].end, 4, "the run reaches past its closing prose")
  assert.equal(segs[0].close, 2)
  assert.equal(segs[0].tools, 7)
})

test("a message the card drops outright anchors nothing and counts as nothing", () => {
  // A Goal bump / rest divider sits at 2. Expanding reveals nothing where it stood, so counting it as a
  // hidden step would promise a row the expansion never shows.
  const segs = queueCollapseSegments([x(), p(), x(), t(2), p()], 1)
  assert.equal(segs[0].steps, 1)
  assert.equal(segs[0].tools, 2)
})

test("a mid-run ask keeps its own row, so it is not counted as hidden", () => {
  const segs = queueCollapseSegments([x(), p(), { text: true, countable: true, survives: true }, t(3), p()], 1)
  assert.equal(segs[0].steps, 1, "only the tools-only middle is hidden")
})

// ---- segmentFolds ----

test("a WOKEN run folds even when one message both opens and closes it", () => {
  const [seg] = queueCollapseSegments([w(), t(9), p()], 0)
  assert.equal(seg.open, seg.close, "one prose message doing both jobs")
  assert.equal(segmentFolds(seg), true, "its wake hairline is the anchor above the fold")
})

// Today's rule, kept deliberately: a lone agent turn has nothing intermediate, and a divider standing
// between the human's ask and the only answer reads as the card withholding the answer.
test("the FIRST run does NOT fold when one message both opens and closes it", () => {
  const [seg] = queueCollapseSegments([x(), t(9), p()], 1)
  assert.equal(segmentFolds(seg), false)
})

test("a run with nothing hidden never folds", () => {
  const [seg] = queueCollapseSegments([x(), p(), p()], 1)
  assert.equal(seg.tools, 0)
  assert.equal(seg.steps, 0)
  assert.equal(segmentFolds(seg), false)
})

test("a run with no prose at all never folds — it has no anchor to render", () => {
  const [seg] = queueCollapseSegments([w(), t(4)], 0)
  assert.equal(seg.open, -1)
  assert.equal(segmentFolds(seg), false)
})
