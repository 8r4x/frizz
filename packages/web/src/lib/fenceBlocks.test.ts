import { test } from "node:test"
import assert from "node:assert/strict"
import { splitFenceBlocks, parseFenceBody, hasFence } from "./fenceBlocks.ts"

// ---- splitFenceBlocks ----

test("no fences → a single prose segment", () => {
  assert.deepEqual(splitFenceBlocks("just some prose\n\nmore prose"), [
    { kind: "prose", text: "just some prose\n\nmore prose" },
  ])
})

test("empty / whitespace-only text → no segments", () => {
  assert.deepEqual(splitFenceBlocks(""), [])
  assert.deepEqual(splitFenceBlocks("   \n  "), [])
})

test("a done fence with surrounding prose", () => {
  const text = "Shipped the fix.\n\n```done\nMerged PR and cleaned up the branch.\n```\n\nAnything else?"
  assert.deepEqual(splitFenceBlocks(text), [
    { kind: "prose", text: "Shipped the fix.\n\n" },
    { kind: "fence", fenceKind: "done", body: "Merged PR and cleaned up the branch.", hints: [] },
    { kind: "prose", text: "\n\nAnything else?" },
  ])
})

// THE SIX STRUCTURAL KINDS, and this parser has to agree with the server's (tailer.ts AWAITING_HINT_RE)
// line for line: a kind only one of them knows renders one way and parks another, which is exactly how a
// worker ends up LOOKING parked on something frizz never armed.
test("an awaiting fence: the six structural lines parse, and prose stays prose", () => {
  const text = "```awaiting\nWaiting on a named maintainer at a scheduled checkpoint.\nshell: bzvtnt3ig\npr: owner/repo#12\ntimer: tmr_a1b2c3\n```"
  assert.deepEqual(splitFenceBlocks(text), [
    {
      kind: "fence",
      fenceKind: "awaiting",
      body: "Waiting on a named maintainer at a scheduled checkpoint.",
      hints: [
        { kind: "shell", value: "bzvtnt3ig" },
        { kind: "pr", value: "owner/repo#12" },
        { kind: "timer", value: "tmr_a1b2c3" },
      ],
    },
  ])
})

// CASE-INSENSITIVE on the six kinds, and a DELETED kind is prose — not a hint under another name.
// `human:`, `ci:` and `session:` were removed with the grammar (2026-08-15); a worker still writing one
// must have it fall to the body, where a human reads it, rather than silently minting a wait.
test("awaiting hint kinds are case-insensitive, and a deleted kind is just prose", () => {
  const { hints, body } = parseFenceBody("Shell: bzvtnt3ig\nTimer: tmr_a1b2c3\nFor: 2h\nReason: waiting on the suite\nprose tail", "awaiting")
  assert.deepEqual(hints, [
    { kind: "shell", value: "bzvtnt3ig" },
    { kind: "timer", value: "tmr_a1b2c3" },
    { kind: "for", value: "2h" },
    { kind: "reason", value: "waiting on the suite" },
  ])
  assert.equal(body, "prose tail")

  const legacy = parseFenceBody("human: Alice approves\nci: build 9\nsession: sub-123\nstill here", "awaiting")
  assert.deepEqual(legacy.hints, [], "a deleted kind mints no hint")
  assert.match(legacy.body, /Alice approves/, "…and stays readable in the body")
})

test("a done fence never carries hints — hint-looking lines stay in the body", () => {
  const { hints, body } = parseFenceBody("all set\npr: owner/repo#7", "done")
  assert.deepEqual(hints, [])
  assert.equal(body, "all set\npr: owner/repo#7")
})

test("an awaiting fence with no hints → empty hints, whole body prose", () => {
  const segs = splitFenceBlocks("```awaiting\nJust waiting a bit.\n```")
  assert.deepEqual(segs, [{ kind: "fence", fenceKind: "awaiting", body: "Just waiting a bit.", hints: [] }])
})

test("multiple fences in order", () => {
  const text = "```awaiting\nhold\ntimer: 10m\n```\nlater\n```done\nfinished\n```"
  assert.deepEqual(splitFenceBlocks(text), [
    { kind: "fence", fenceKind: "awaiting", body: "hold", hints: [{ kind: "timer", value: "10m" }] },
    { kind: "prose", text: "\nlater\n" },
    { kind: "fence", fenceKind: "done", body: "finished", hints: [] },
  ])
})

test("a ```question fence is NOT a signal fence — left in prose", () => {
  const text = "```question\nWhich default?\nA. one\nB. two\n```"
  assert.deepEqual(splitFenceBlocks(text), [{ kind: "prose", text }])
  assert.equal(hasFence(text), false)
})

test("a plain code fence is left in prose", () => {
  const text = "run this:\n\n```bash\nnpm test\n```"
  assert.deepEqual(splitFenceBlocks(text), [{ kind: "prose", text }])
})

test("unterminated fence degrades to plain prose (no fence segment)", () => {
  const text = "prose\n\n```done\nnever closed…\nstill going"
  const segs = splitFenceBlocks(text)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, "prose")
  assert.equal(segs[0].text, text)
})

test("CRLF line endings are handled", () => {
  const segs = splitFenceBlocks("```awaiting\r\nhold on\r\nshell: bzvtnt3ig\r\n```")
  assert.deepEqual(segs, [{ kind: "fence", fenceKind: "awaiting", body: "hold on", hints: [{ kind: "shell", value: "bzvtnt3ig" }] }])
})

test("hasFence detects done and awaiting, ignores question/plain", () => {
  assert.equal(hasFence("```done\nx\n```"), true)
  assert.equal(hasFence("```awaiting\nx\n```"), true)
  assert.equal(hasFence("```question\nx\n```"), false)
  assert.equal(hasFence("no fences here"), false)
})

test("a signal fence QUOTED inside a code fence is prose, not a card", () => {
  // A worker explaining the protocol wraps its sample in a ```` fence; hoisting the sample into a card
  // also orphans the enclosing delimiters, whose unterminated fence swallows the rest of the message.
  const t4 = "`".repeat(4)
  const text = `Write it like this:\n\n${t4}\n\`\`\`done\n- Landed the fix.\n\`\`\`\n${t4}\n\nThat's the whole grammar.`
  assert.deepEqual(splitFenceBlocks(text).map((s) => s.kind), ["prose"])
  assert.equal(hasFence(text), false)
  // …but a real fence after the quoted sample still lands.
  assert.equal(hasFence(`${text}\n\n\`\`\`done\n- Actually landed it.\n\`\`\``), true)
})

test("an empty done body is allowed (body may be '')", () => {
  const segs = splitFenceBlocks("```done\n\n```")
  assert.deepEqual(segs, [{ kind: "fence", fenceKind: "done", body: "", hints: [] }])
})
