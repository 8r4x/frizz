import { test } from "node:test"
import assert from "node:assert/strict"
import {
  formatGithubWakeSteer,
  isGithubWakeBacklog,
  parseGithubWakeSteer,
  parsePrWatchWake,
  prWatchWakeMessage,
  splitWakeDeliveries,
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

// The runtime merges deliveries that land while the worker is mid-turn into ONE user record. Every
// anchored projection in this file then reads the LAST delivery only, and the ones above it — token,
// trailer and all — are stranded mid-text where nothing can see them. Splitting first is what restores
// each one's own presentation; the boundary is the token alone on its line, which is exactly how the
// runtime joins them and is never how prose quotes one.
test("a coalesced record splits into its deliveries, and a quoted token is not a boundary", () => {
  const a = "KEEP GOING.\n\n(Recurring prompt — sent each time you come to rest. …)"
  const b = `<frizz-relay:b7xm5f1db> Background command "trace" completed (exit code 0).`
  const ta = wakeDeliveryToken("a".repeat(64))
  const tb = wakeDeliveryToken("b".repeat(64))
  assert.deepEqual(splitWakeDeliveries(`${a}\n\n${ta}\n${b}\n\n${tb}`), [`${a}\n\n${ta}`, `${b}\n\n${tb}`])
  // A trailing segment the runtime appended with no token of its own (a human follow-up merged onto a
  // wake) is still its own message — it must not ride along inside the wake's card.
  assert.deepEqual(splitWakeDeliveries(`${a}\n\n${ta}\nand one more thing`), [`${a}\n\n${ta}`, "and one more thing"])
  // One delivery, or none, is the overwhelming case and must come back untouched.
  assert.deepEqual(splitWakeDeliveries(`${a}\n\n${ta}`), [`${a}\n\n${ta}`])
  assert.deepEqual(splitWakeDeliveries("just a follow-up"), ["just a follow-up"])
  // …and the human asking about a token mid-sentence keeps one bubble, as stripWakeDeliveryToken does.
  const quoting = `Why is ${ta} showing up in the bubble?`
  assert.deepEqual(splitWakeDeliveries(quoting), [quoting])
})

// The display strip is the BACKSTOP the split leans on. The split has to model how the RUNTIME joins
// coalesced deliveries, which is not frizz's format to pin — so if a joiner change ever defeats it, a
// token must still never reach the human's eyes. On its own line it is plumbing wherever it sits; only
// a token quoted mid-sentence is the human's own words.
test("a token on its own line is stripped from anywhere, quoted prose is not", () => {
  const t = wakeDeliveryToken("a".repeat(64))
  assert.equal(stripWakeDeliveryToken(`steer\n\n${t}`), "steer")
  assert.equal(stripWakeDeliveryToken(`steer\n\n${t}\nand a stranded tail`), "steer\n\nand a stranded tail")
  assert.equal(stripWakeDeliveryToken(`${t}\nplumbing led this one`), "plumbing led this one")
  const quoting = `Why is ${t} showing up in the bubble?`
  assert.equal(stripWakeDeliveryToken(quoting), quoting)
  assert.equal(stripWakeDeliveryToken("ordinary text\n"), "ordinary text\n", "no token, no rewrite")
})

// ---- isGithubWakeBacklog ----
//
// The chat has to tell a FIRST-PARK REPLAY apart from news, because they read as opposite things and
// only one of them is an event (maintainer 2026-08-13: "That already is preexisting on the PR, which I
// find quite weird"). The flag rides the delivered TEXT rather than the steer, which is what keeps the
// formatter's round-trip above intact — so this is the test that the two stay in step.
test("a backlog replay is recognizable from its delivered text, and ordinary news is not", () => {
  assert.equal(isGithubWakeBacklog(formatGithubWakeSteer(burst, { backlog: true })), true)
  assert.equal(isGithubWakeBacklog(formatGithubWakeSteer(single, { backlog: true })), true)
  assert.equal(isGithubWakeBacklog(formatGithubWakeSteer(burst)), false, "an ordinary burst is news")
  assert.equal(isGithubWakeBacklog(formatGithubWakeSteer(single)), false)
  assert.equal(isGithubWakeBacklog(undefined), false)
  // A legacy transcript written before the tail existed reads as not-a-backlog, which is what it was.
  assert.equal(isGithubWakeBacklog("🤖 New GitHub comment on acme/app#1 from @dana."), false)
})

// Marking it must not cost the round trip — the whole reason `backlog` is an argument and not a field.
test("the backlog tail leaves the steer parseable, unchanged", () => {
  assert.deepEqual(parseGithubWakeSteer(formatGithubWakeSteer(burst, { backlog: true })), burst)
  assert.deepEqual(parseGithubWakeSteer(formatGithubWakeSteer(single, { backlog: true })), single)
})

// ---- parsePrWatchWake ----
//
// Same contract as the steer's round trip, for the OTHER half of what a watcher says. These lines fell
// through to the raw-text card for want of a parser, so the same watcher spoke in two voices down one
// transcript; the pair below is what keeps them in one voice from now on.
test("a pr-watch status line round-trips through its own parser", () => {
  for (const [name, input, want] of [
    ["merged", { target: "nubjs/nub#760", merged: true }, { ref: "nubjs/nub#760", kind: "merged" }],
    ["closed", { target: "nubjs/nub#760", closed: true }, { ref: "nubjs/nub#760", kind: "closed" }],
    ["ci green", { target: "acme/app#12", checks: { verdict: "passing", passed: 3, failed: 0, failing: [] } },
      { ref: "acme/app#12", kind: "ci", verdict: "passing", passed: 3, failing: [] }],
    ["ci green, one check", { target: "acme/app#12", checks: { verdict: "passing", passed: 1, failed: 0, failing: [] } },
      { ref: "acme/app#12", kind: "ci", verdict: "passing", passed: 1, failing: [] }],
    ["ci red", { target: "acme/app.js#12", checks: { verdict: "failing", passed: 1, failed: 2, failing: ["build", "test (macos)"] } },
      { ref: "acme/app.js#12", kind: "ci", verdict: "failing", failing: ["build", "test (macos)"] }],
    ["ci red, no named jobs", { target: "acme/app#12", checks: { verdict: "failing", passed: 0, failed: 1, failing: [] } },
      { ref: "acme/app#12", kind: "ci", verdict: "failing", failing: [] }],
  ] as [string, Parameters<typeof prWatchWakeMessage>[0], unknown][]) {
    assert.deepEqual(parsePrWatchWake(prWatchWakeMessage(input)), want, name)
  }
})

// A delivery routinely carries BOTH parts — one poll saw CI flip and a comment land — and the chat draws
// a divider per part. Each parser must therefore find its own line and ignore the other's, whichever
// order they arrive in, and neither may be defeated by the machine-facing tail below them.
test("a wake carrying CI and review activity yields both parts", () => {
  const text = prWatchWakeMessage({
    target: "nubjs/nub#587",
    checks: { verdict: "failing", passed: 1, failed: 1, failing: ["build"] },
    review: formatGithubWakeSteer(single),
  })
  assert.deepEqual(parsePrWatchWake(text), { ref: "nubjs/nub#587", kind: "ci", verdict: "failing", failing: ["build"] })
  assert.deepEqual(parseGithubWakeSteer(text.slice(text.indexOf(formatGithubWakeSteer(single)))), single)
  // The STEER PARSER READS LINE 0 AND NOTHING ELSE, so a status line above one means the server serves
  // no `wakeSteer` for this delivery. That is not an accident to be tidied up later — GithubWakeCard
  // relies on it: it is what keeps an already-open tab on an older bundle rendering the whole text
  // rather than drawing the review hairline alone and silently dropping the CI verdict beside it.
  assert.equal(parseGithubWakeSteer(text), null, "a status line above the steer must defeat the served parse")
  assert.deepEqual(parsePrWatchWake(`${text}\n\n${wakeDeliveryToken("a".repeat(64))}`), {
    ref: "nubjs/nub#587", kind: "ci", verdict: "failing", failing: ["build"],
  }, "a machine-facing tail must not cost the divider")
})

// The trailer, the review steer and ordinary agent prose are all NOT status lines. A false positive here
// puts a divider on a message that never said a PR finished, which is worse than the card it replaces.
test("text with no pr-watch status line parses as none", () => {
  assert.equal(parsePrWatchWake(formatGithubWakeSteer(burst)), null)
  assert.equal(parsePrWatchWake("(This watcher is spent — there is nothing further to report on a finished PR.)"), null)
  assert.equal(parsePrWatchWake("⏰ Your background shell finished: `bzvtnt3ig` — the churn suite."), null)
  assert.equal(parsePrWatchWake("⏰ nub#760 was CLOSED."), null, "a bare number is not an owner/repo#N")
  assert.equal(parsePrWatchWake("⏰ nubjs/nub#760 was ABANDONED."), null)
})
