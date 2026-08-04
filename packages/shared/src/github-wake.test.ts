import { test } from "node:test"
import assert from "node:assert/strict"
import {
  formatGithubWakeSteer,
  parseGithubWakeSteer,
  stripWakeDeliveryToken,
  wakeDeliveryToken,
  type GithubWakeSteer,
} from "./index.ts"

const single: GithubWakeSteer = {
  ref: "nubjs/nub#587",
  omitted: 0,
  items: [{ label: "comment", actor: "colinhacks", bot: false, at: "2026-07-29T15:39:28Z", url: "https://github.com/nubjs/nub/pull/587#issuecomment-5120099362" }],
}

const burst: GithubWakeSteer = {
  ref: "nubjs/nub#587",
  omitted: 0,
  items: [
    { label: "comment", actor: "colinhacks", bot: false, at: "2026-07-29T15:39:28Z", url: "https://github.com/nubjs/nub/pull/587#issuecomment-5120099362" },
    { label: "review comment", actor: "pullfrog", bot: true, at: "2026-07-29T15:46:04Z", url: "https://github.com/nubjs/nub/pull/587#pullrequestreview-4810252801" },
    { label: "approval", actor: "dana", bot: false, at: "2026-07-29T15:47:52Z", url: "https://github.com/nubjs/nub/pull/587#pullrequestreview-4810267375" },
  ],
}

// THE contract this pair exists for: whatever the scheduler composes, the chat can rebuild. A wording
// tweak on the formatter that the parser doesn't know about silently downgrades every card in the chat
// to a plain text blob, and nothing else in either package would fail.
test("github wake steer round-trips through its own parser", () => {
  for (const [name, steer] of [
    ["single", single],
    ["burst", burst],
    ["capped burst", { ...burst, omitted: 7 }],
    ["single, no timestamp or url", { ref: "acme/app#1", omitted: 0, items: [{ label: "approval", actor: "dana", bot: false }] }],
    ["bot-only burst", { ref: "acme/app#1", omitted: 0, items: [
      { label: "comment", actor: "coderabbitai[bot]", bot: true, at: "2026-07-29T10:00:00Z" },
      { label: "review", actor: "pullfrog", bot: true, at: "2026-07-29T10:01:00Z" },
    ] }],
    ["a login with punctuation", { ref: "acme/app.js#12", omitted: 0, items: [
      { label: "comment", actor: "a-b_c[bot]", bot: true, at: "2026-07-29T10:00:00Z", url: "https://github.com/acme/app.js/pull/12#issuecomment-1" },
      { label: "change request", actor: "erin", bot: false },
    ] }],
  ] as [string, GithubWakeSteer][]) {
    assert.deepEqual(parseGithubWakeSteer(formatGithubWakeSteer(steer)), steer, name)
  }
})

// The card is a projection of the delivered text, which always arrives with the machine-facing token
// appended — so the two must compose in that order without the token defeating the parse.
//
// The token used to make the parse FAIL, and that was asserted as the contract. It is not one worth
// keeping: the only thing a refusal buys is that a missed strip degrades to the raw-text card WITH
// `<!-- frizz-wake:… -->` showing, which is the very bug the strip exists to prevent. A parser that
// reads the steer either way is strictly better, and it falls out of dropping unrecognized lines.
test("a delivered wake parses with or without its delivery token", () => {
  const delivered = `${formatGithubWakeSteer(burst)}\n\n${wakeDeliveryToken("a".repeat(64))}`
  assert.deepEqual(parseGithubWakeSteer(delivered), burst, "a machine-facing tail must not cost the card")
  assert.deepEqual(parseGithubWakeSteer(stripWakeDeliveryToken(delivered)), burst)
})

// THE regression this file exists to prevent, stated directly: on 2026-07-31 the steer gained a
// review-read tail, the shipped parsers had never seen those two lines, and every already-open tab
// rendered the raw-text fallback card instead of the divider. Nothing reloads those tabs — `boot.ts`
// adopts a new server boot id in place on purpose — so the parser has to tolerate a line the build it
// runs in has never heard of. This asserts that for lines NO build has heard of.
test("a steer that grew lines this parser has never seen still renders its card", () => {
  for (const tail of [
    "\n\nSome future paragraph a later build appends to speak to the worker.",
    "\n\ngh gist create --public # a command shape this build does not know",
    "\n\nA lead-in:\nline one\nline two\n\nand a trailing note",
  ]) {
    assert.deepEqual(parseGithubWakeSteer(formatGithubWakeSteer(single) + tail), single, tail)
    assert.deepEqual(parseGithubWakeSteer(formatGithubWakeSteer(burst) + tail), burst, tail)
  }
})

test("the single-item steer names the item and ends on its bare URL", () => {
  const text = formatGithubWakeSteer(single)
  assert.equal(
    text,
    "👤 New GitHub comment on nubjs/nub#587 from @colinhacks at 2026-07-29T15:39:28Z. Read that exact comment — ignore older activity you have already handled — and continue: https://github.com/nubjs/nub/pull/587#issuecomment-5120099362",
  )
  assert.ok(!/[.,;]$/.test(text), "a trailing period would be swallowed into the href by a terminal autolinker")
})

// Each line carries its own icon because a login is not a reliable tell — @pullfrog is a GitHub App
// with no `[bot]` suffix, and deriving `bot` from the login alone would render it as a person.
test("every burst line carries its own actor icon, and a suffix-less app still reads as a bot", () => {
  const lines = formatGithubWakeSteer(burst).split("\n").filter((l) => l.startsWith("- "))
  assert.deepEqual(lines.map((l) => l.slice(2, 4)), ["👤", "🤖", "👤"])
  assert.equal(parseGithubWakeSteer(formatGithubWakeSteer(burst))?.items[1].bot, true)
})

test("the header count is authoritative — a truncated or padded burst is refused, not guessed", () => {
  const text = formatGithubWakeSteer(burst)
  assert.ok(parseGithubWakeSteer(text))
  // Drop the last ITEM line, not the last line: the steer now ends on a review-read tail the parser
  // discards, so slicing the raw end would only remove a line that never carried an item.
  const lines = text.split("\n")
  const lastItem = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith("- ")).at(-1)![1]
  assert.equal(
    parseGithubWakeSteer(lines.filter((_, i) => i !== lastItem).join("\n")),
    null,
    "a dropped line must not parse as a smaller burst",
  )
  assert.equal(parseGithubWakeSteer(text.replace("3 new GitHub items", "4 new GitHub items")), null)
})

// The defect this tail exists for: a review app files an empty-bodied review whose substance is inline
// comments, and the permalink's obvious read returns that empty body. A woken worker spent four calls
// finding the endpoint that answers it in one (2026-07-31, nubjs/nub#587).
test("a review wake names the one call that reads its inline comments", () => {
  const review: GithubWakeSteer = {
    ref: "nubjs/nub#587",
    omitted: 0,
    items: [{ label: "review comment", actor: "pullfrog", bot: true, at: "2026-07-31T20:33:58Z", url: "https://github.com/nubjs/nub/pull/587#pullrequestreview-4831999377" }],
  }
  const text = formatGithubWakeSteer(review)
  assert.match(text, /^gh api --paginate repos\/nubjs\/nub\/pulls\/587\/reviews\/4831999377\/comments$/m)
  // The permalink still ends its own line — the tail is a separate paragraph, so no autolinker can
  // swallow the command into the href.
  assert.ok(text.split("\n")[0].endsWith("#pullrequestreview-4831999377"))
  assert.deepEqual(parseGithubWakeSteer(text), review, "the tail is derived, so it must not survive the parse")
})

test("the read tail is per-review, deduped, and absent when nothing woke a review", () => {
  const cmds = (s: GithubWakeSteer) => formatGithubWakeSteer(s).split("\n").filter((l) => l.startsWith("gh api "))
  // `burst` holds one issue comment and TWO distinct reviews.
  assert.deepEqual(cmds(burst), [
    "gh api --paginate repos/nubjs/nub/pulls/587/reviews/4810252801/comments",
    "gh api --paginate repos/nubjs/nub/pulls/587/reviews/4810267375/comments",
  ])
  assert.deepEqual(cmds(single), [], "a plain issue comment carries its substance in its own body")
  const twice = { ...burst, items: [burst.items[1], { ...burst.items[1], label: "approval", actor: "dana", bot: false }] }
  assert.deepEqual(cmds({ ...twice, omitted: 1 }), ["gh api --paginate repos/nubjs/nub/pulls/587/reviews/4810252801/comments"], "one review, one command")
})

// The tail lines must never be mistaken for the card's own content, in either direction.
test("the read tail neither adds items nor lets prose masquerade as one", () => {
  const text = formatGithubWakeSteer(burst)
  assert.equal(parseGithubWakeSteer(text)?.items.length, 3, "three items, not five")
  assert.equal(
    parseGithubWakeSteer("A review's body is often empty because its substance is inline comments. Read them, one call each:\ngh api --paginate repos/a/b/pulls/1/reviews/2/comments"),
    null,
    "the tail alone is not a wake",
  )
})

test("ordinary prose never masquerades as a wake card", () => {
  for (const text of [
    "plain follow-up",
    "",
    "👤 New GitHub comment on nubjs/nub#587 from @colinhacks. Read it and continue.", // the PRE-FIX steer
    "3 new GitHub items on nubjs/nub#587",
    "- comment from @someone",
    "👤 2 new GitHub items on nubjs/nub#587. Read exactly these — ignore older activity you have already handled — and continue:\n\n- 👤 comment from @a\nnot an item line",
  ]) {
    assert.equal(parseGithubWakeSteer(text), null, JSON.stringify(text))
  }
})
