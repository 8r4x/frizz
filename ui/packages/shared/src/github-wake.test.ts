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
test("a delivered wake parses after its delivery token is stripped", () => {
  const delivered = `${formatGithubWakeSteer(burst)}\n\n${wakeDeliveryToken("a".repeat(64))}`
  assert.equal(parseGithubWakeSteer(delivered), null, "the raw delivered text carries a tail the parser must not accept")
  assert.deepEqual(parseGithubWakeSteer(stripWakeDeliveryToken(delivered)), burst)
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
  assert.equal(parseGithubWakeSteer(text.split("\n").slice(0, -1).join("\n")), null, "a dropped line must not parse as a smaller burst")
  assert.equal(parseGithubWakeSteer(text.replace("3 new GitHub items", "4 new GitHub items")), null)
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
