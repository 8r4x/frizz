import { test } from "node:test"
import assert from "node:assert/strict"
import { splitQuestionBlocks, parseQuestionBlock, composeBlockAnswer, optionId, recommendedIndex } from "./questionBlocks.ts"

// ---- splitQuestionBlocks ----

test("no fences → a single prose segment", () => {
  assert.deepEqual(splitQuestionBlocks("just some prose\n\nmore prose"), [
    { kind: "prose", text: "just some prose\n\nmore prose" },
  ])
})

test("empty / whitespace-only text → no segments", () => {
  assert.deepEqual(splitQuestionBlocks(""), [])
  assert.deepEqual(splitQuestionBlocks("   \n  "), [])
})

test("a single question block with surrounding prose (default kind)", () => {
  const text = "Here is my status.\n\n```question\nWhich default?\n\nA. Plain\nB. JSON\n```\n\nThanks!"
  assert.deepEqual(splitQuestionBlocks(text), [
    { kind: "prose", text: "Here is my status.\n\n" },
    { kind: "question", text: "Which default?\n\nA. Plain\nB. JSON", questionKind: "question", danger: false },
    { kind: "prose", text: "\n\nThanks!" },
  ])
})

test("info-string kinds: the RETIRED `approval` degrades to question; bare/other → question", () => {
  // `approval` is gone (2026-07-26). A legacy transcript's gate must still render — as the two-option
  // question it always was — never as a parse failure.
  const approval = splitQuestionBlocks("```question approval\nShip it?\n```")
  assert.deepEqual(approval, [{ kind: "question", text: "Ship it?", questionKind: "question", danger: false }])
  const bare = splitQuestionBlocks("```question\nShip it?\n```")
  assert.equal(bare[0].kind === "question" && bare[0].questionKind, "question")
  const explicit = splitQuestionBlocks("```question question\nShip it?\n```")
  assert.equal(explicit[0].kind === "question" && explicit[0].questionKind, "question")
})

test("multiple question blocks in order", () => {
  const text = "```question\nQ1?\nA. a\nB. b\n```\nbetween\n```question danger\nQ2?\n```"
  assert.deepEqual(splitQuestionBlocks(text), [
    { kind: "question", text: "Q1?\nA. a\nB. b", questionKind: "question", danger: false },
    { kind: "prose", text: "\nbetween\n" },
    { kind: "question", text: "Q2?", questionKind: "question", danger: true },
  ])
})

// ---- info-string kinds: multi, danger, multi-token degradation ----

test("```question multi → kind multi, no danger", () => {
  const segs = splitQuestionBlocks("```question multi\nWhich to fix?\n- A. one\n- B. two\n```")
  assert.deepEqual(segs, [{ kind: "question", text: "Which to fix?\n- A. one\n- B. two", questionKind: "multi", danger: false }])
})

test("```question multi danger → multi + danger (order-independent)", () => {
  const a = splitQuestionBlocks("```question multi danger\nWhich to force-delete?\n```")
  assert.deepEqual(a, [{ kind: "question", text: "Which to force-delete?", questionKind: "multi", danger: true }])
  const b = splitQuestionBlocks("```question danger multi\nWhich to force-delete?\n```")
  assert.equal(b[0].kind === "question" && b[0].questionKind, "multi")
  assert.equal(b[0].kind === "question" && b[0].danger, true)
})

test("legacy `approval danger` still carries danger onto the degraded question", () => {
  const a = splitQuestionBlocks("```question approval danger\nForce-merge?\n```")
  assert.deepEqual(a, [{ kind: "question", text: "Force-merge?", questionKind: "question", danger: true }])
  // Plain legacy `approval` carries no danger; trailing/internal whitespace is stripped, not tokenized.
  const b = splitQuestionBlocks("```question   approval   \nShip it?\n```")
  assert.equal(b[0].kind === "question" && b[0].questionKind, "question")
  assert.equal(b[0].kind === "question" && b[0].danger, false)
})

test("unknown / extra tokens degrade to kind question without breaking parsing", () => {
  // No recognized base token → question; the block still parses (never a hard fail).
  const a = splitQuestionBlocks("```question wat\nStill a question?\n```")
  assert.deepEqual(a, [{ kind: "question", text: "Still a question?", questionKind: "question", danger: false }])
  // A recognized kind survives an unknown neighbor token; danger still detected alongside noise.
  const b = splitQuestionBlocks("```question multi frobnicate danger\nPick some\n- A. x\n```")
  assert.equal(b[0].kind === "question" && b[0].questionKind, "multi")
  assert.equal(b[0].kind === "question" && b[0].danger, true)
})

test("unterminated fence degrades to plain prose (no question segment)", () => {
  const text = "prose\n\n```question\nnever closed...\nstill going"
  const segs = splitQuestionBlocks(text)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, "prose")
  assert.equal(segs[0].text, text)
})

test("a normal (non-question) code fence is left in prose", () => {
  const text = "run this:\n\n```bash\nnpm test\n```"
  assert.deepEqual(splitQuestionBlocks(text), [{ kind: "prose", text }])
})

// ---- a QUOTED opener is not an ask ----
// Documenting the protocol means showing the syntax, and the correct authoring form wraps the sample in
// a ```` fence. Hoisting that sample out into a live answerable card ALSO strands the enclosing ````
// delimiters as prose, whose unterminated fence then swallows the rest of the message (2026-07-25).

const TICK4 = "`".repeat(4)

test("a ```question sample inside a ```` fence stays prose — no phantom card", () => {
  const text = `${TICK4}\n\`\`\`question\nShip it?\n\n- A. Yes\n- B. No\n\`\`\`\n${TICK4}\n\nTrailing prose.`
  const segs = splitQuestionBlocks(text)
  assert.deepEqual(segs.map((s) => s.kind), ["prose"])
  assert.equal(segs[0].text, text) // the whole thing renders as the code block it is
})

test("a ```question sample inside a ```markdown fence stays prose", () => {
  const segs = splitQuestionBlocks("```markdown\n```question\nShip it?\n- A. Yes\n```\n```")
  assert.deepEqual(segs.map((s) => s.kind), ["prose"])
})

test("a REAL question after a quoted sample is still found", () => {
  const text = `Here is the syntax:\n\n${TICK4}\n\`\`\`question\nExample?\n- A. Yes\n\`\`\`\n${TICK4}\n\n\`\`\`question\nSo: ship it?\n\n- A. Yes\n- B. No\n\`\`\``
  const segs = splitQuestionBlocks(text)
  const asks = segs.filter((s) => s.kind === "question")
  assert.equal(asks.length, 1)
  assert.equal(asks[0].kind === "question" && asks[0].text, "So: ship it?\n\n- A. Yes\n- B. No")
})

// ---- parseQuestionBlock: choice detection ----

test("lettered options (markdown list form) → chips, stripped from context", () => {
  const body = "Which store?\n\n- A. SQLite — transactional\n- B. JSON — zero deps\n\nRecommendation: A, for consistency."
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "Which store?")
  assert.deepEqual(p.options, ["A. SQLite — transactional", "B. JSON — zero deps"])
  assert.equal(p.recommendation, "Recommendation: A, for consistency.")
})

test("options FOLLOWED by a trailing Note paragraph → chips STILL detected, note → trailingMd (the nub#440 bug)", () => {
  // The worker put a footnote after the choices; the old "options must be trailing" rule then found no
  // run and dropped every chip. Inline markdown (backticks, **bold**, em-dash) must not confuse it either.
  const body =
    "How do you want to proceed?\n\n" +
    "- A. Merge as-is (`--admin`) — my recommendation\n" +
    "- B. Switch to **pnpm-owned** first\n" +
    "- C. Hold — review it yourself\n\n" +
    "Note: the invalid-URL warn-drop is in the PR body as recommend-only."
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, ["A. Merge as-is (`--admin`) — my recommendation", "B. Switch to **pnpm-owned** first", "C. Hold — review it yourself"])
  assert.equal(p.contextMd, "How do you want to proceed?")
  assert.equal(p.trailingMd, "Note: the invalid-URL warn-drop is in the PR body as recommend-only.")
})

test("lettered options (bare form, no list marker)", () => {
  const body = "Pick one:\nA. Tabs\nB. Spaces"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "Pick one:")
  assert.deepEqual(p.options, ["A. Tabs", "B. Spaces"])
  assert.equal(p.recommendation, undefined)
})

test("numbered options → chips", () => {
  const body = "How many retries?\n\n1. Zero\n2. Three\n3. Ten"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "How many retries?")
  assert.deepEqual(p.options, ["1. Zero", "2. Three", "3. Ten"])
})

// ---- the question line is never an option ----
// A handoff carrying several blocks makes workers number the QUESTION too ("C. Does `brokerTo` …?"),
// which OPTION_RE cannot tell from a choice: the question was chipped as option 0, the card rendered NO
// question at all, and the freetext row re-used the letter (options ended at B → placeholder "C.").
// Every case below is a verbatim shape from the transcript corpus on this machine.

test("a LETTER-numbered question line is context, not the first option", () => {
  const body = "C. Does `brokerTo` imply net access to the host?\n\n- A. No — the host must also be in `net` (recommended)\n- B. Yes — listing a host auto-allows it"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "C. Does `brokerTo` imply net access to the host?")
  assert.deepEqual(p.options, ["A. No — the host must also be in `net`", "B. Yes — listing a host auto-allows it"])
  assert.equal(p.recommendedIdx, 0) // the recommendation follows the option, not the old off-by-one index
})

test("a question numbered with the SAME letter its options start at is still context", () => {
  const body = "A. What does `...` become?\n\n- A. Repurpose it\n- B. Drop it\n- C. Keep it"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "A. What does `...` become?")
  assert.deepEqual(p.options, ["A. Repurpose it", "B. Drop it", "C. Keep it"])
})

test("a NUMBER-numbered question line is context, even against numbered options", () => {
  const body = "3. What should `<tmp>` mean?\n\n1. A private writable per-run directory\n2. The OS shared temp dir"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "3. What should `<tmp>` mean?")
  assert.deepEqual(p.options, ["1. A private writable per-run directory", "2. The OS shared temp dir"])
})

test("a numbered PLAN above the choices stays prose (the whole lead-in is context)", () => {
  const body = "Retire the existing PRs? The plan:\n\n1. Sync local `main`\n2. Re-land the four fixes\n3. Close the redundant PRs\n\n- A. Yes — do the full plan\n- B. Hold"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "Retire the existing PRs? The plan:\n\n1. Sync local `main`\n2. Re-land the four fixes\n3. Close the redundant PRs")
  assert.deepEqual(p.options, ["A. Yes — do the full plan", "B. Hold"])
})

test("a numbered question with NO options is a freetext question, not a one-option card", () => {
  const p = parseQuestionBlock("4. Which name do you want?", "question")
  assert.deepEqual(p.options, [])
  assert.equal(p.contextMd, "4. Which name do you want?")
})

test("a block that OPENS with a real option run keeps every option (no question to demote)", () => {
  // "A." opens the list and "B." continues it, so nothing here is a question — eating option A to invent
  // one would silently lose a choice.
  const p = parseQuestionBlock("- A. Approve as-is\n- B. Approve with edits", "question")
  assert.deepEqual(p.options, ["A. Approve as-is", "B. Approve with edits"])
  assert.equal(p.contextMd, "")
})

test("a lone MARKED option is still an option (only a bare leading line is demoted)", () => {
  const p = parseQuestionBlock("- A. Approve as-is", "question")
  assert.deepEqual(p.options, ["A. Approve as-is"])
})

test("a run that does NOT open a list is left alone — a skipped letter never eats a choice", () => {
  // "A, C" is a typo'd list, not a question above a list: demoting A would drop a real option, so the
  // ambiguous case keeps the old behavior.
  const p = parseQuestionBlock("Pick one:\n- A. Foo\n- C. Bar", "question")
  assert.deepEqual(p.options, ["A. Foo", "C. Bar"])
  assert.equal(p.contextMd, "Pick one:")
})

test("options that legitimately start at B are not re-read as question + list", () => {
  const p = parseQuestionBlock("Pick one:\n- B. Foo\n- C. Bar", "question")
  assert.deepEqual(p.options, ["B. Foo", "C. Bar"])
})

// ---- grouped options: a prose heading between choices doesn't end the run ----

test("a group heading between C and D keeps ALL SIX options answerable", () => {
  const body =
    "Package name — brainstorm.\n\n" +
    "Thread / loom family (fray = a frayed thread):\n" +
    "- A. **frayloom** — keeps the lineage\n" +
    "- B. **warp** — the taut loom threads\n" +
    "- C. **selvage** — the edge that doesn't fray\n\n" +
    "Melee family (fray = a scrap/brawl of agents):\n" +
    "- D. **melee** — a direct synonym\n" +
    "- E. **fracas** — a noisy fray\n" +
    "- F. **tussle** — a scrappy fray\n\n" +
    "Also still open: `frayui`, `frayhq`."
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options.map(optionId), ["A", "B", "C", "D", "E", "F"])
  assert.equal(p.options[3], "D. **melee** — a direct synonym")
  // The heading rides WITH the option it introduces instead of being stranded below the chips.
  assert.equal(p.optionHeadings?.[3], "Melee family (fray = a scrap/brawl of agents):")
  assert.equal(p.optionHeadings?.[0], undefined)
  assert.equal(p.contextMd, "Package name — brainstorm.\n\nThread / loom family (fray = a frayed thread):")
  assert.equal(p.trailingMd, "Also still open: `frayui`, `frayhq`.")
})

test("a SECOND question's list restarts at A, so the run still ends at the first set", () => {
  // Two asks crammed into one block: the heading rule must not weld them into one six-option menu.
  const body =
    "Two scope calls:\n\n" +
    "**1. Which formats?**\n- A. Safe tier\n- B. Safe tier + office\n\n" +
    "**2. Should I proceed?**\n- A. Implement now\n- B. Stop here"
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, ["A. Safe tier", "B. Safe tier + office"])
  assert.equal(p.optionHeadings, undefined)
  assert.match(p.trailingMd ?? "", /^\*\*2\. Should I proceed\?\*\*/)
})

test("a numbered list after lettered options is trailing prose, not a continuation", () => {
  const body = "Approve the plan?\n\n- A. Approve all three\n- B. Adjust one\n\nThe three calls:\n1. SURFACE — config-only\n2. STREAMING — pipe bridge"
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, ["A. Approve all three", "B. Adjust one"])
  assert.equal(p.trailingMd, "The three calls:\n1. SURFACE — config-only\n2. STREAMING — pipe bridge")
})

test("a Recommendation line always closes the choices, even with more options below", () => {
  const body = "Pick:\n- A. One\n- B. Two\n\nRecommendation: A\n\n- C. A later, unrelated list item"
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, ["A. One", "B. Two"])
  assert.equal(p.recommendation, "Recommendation: A")
})

test("prose between a numbered question line and its options still finds the options", () => {
  // The question line is demoted, which empties the run — the real list sits below the prose.
  const body = "9. How is host loopback exposed?\nThe knot is nested runs.\n- A. Require an explicit target\n- B. Keep current"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "9. How is host loopback exposed?\nThe knot is nested runs.")
  assert.deepEqual(p.options, ["A. Require an explicit target", "B. Keep current"])
})

test("no trailing option run → freetext-only (empty options), whole body is context", () => {
  const body = "What should I name the flag? Give me a short kebab-case string."
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, [])
  assert.equal(p.contextMd, body)
})

test("a lone Recommendation line without options stays in context (not special)", () => {
  const body = "Some prose.\n\nRecommendation: do the thing."
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, [])
  assert.equal(p.contextMd, body)
})

test("a go/no-go gate is an ordinary two-option question", () => {
  const p = parseQuestionBlock("Ready to ship?\nA. Ship it\nB. Hold", "question")
  assert.equal(p.kind, "question")
  assert.deepEqual(p.options, ["A. Ship it", "B. Hold"])
})

test("CRLF line endings are handled in both split and parse", () => {
  const segs = splitQuestionBlocks("```question\r\nWhich?\r\nA. one\r\nB. two\r\n```")
  assert.equal(segs[0].kind, "question")
  const p = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  assert.equal(p.contextMd, "Which?")
  assert.deepEqual(p.options, ["A. one", "B. two"])
})

test("parse defaults danger to false and threads a passed danger flag through", () => {
  const noFlag = parseQuestionBlock("Ready?\nA. Yes", "question")
  assert.equal(noFlag.danger, false)
  const flagged = parseQuestionBlock("Ready?\nA. Yes", "question", true)
  assert.equal(flagged.kind, "question")
  assert.equal(flagged.danger, true)
  // danger threads through the freetext-only (no trailing options) return path too.
  const freetext = parseQuestionBlock("Type a reason.", "question", true)
  assert.deepEqual(freetext.options, [])
  assert.equal(freetext.danger, true)
})

test("multi kind carries through parse with options detected", () => {
  const body = "Which findings should I fix?\n\n- A. Null deref in parse()\n- B. Off-by-one in slice()\n- C. Flaky timeout test"
  const p = parseQuestionBlock(body, "multi")
  assert.equal(p.kind, "multi")
  assert.equal(p.contextMd, "Which findings should I fix?")
  assert.deepEqual(p.options, ["A. Null deref in parse()", "B. Off-by-one in slice()", "C. Flaky timeout test"])
})

// ---- optionId ----

test("optionId extracts the leading letter/number identifier, uppercased", () => {
  assert.equal(optionId("A. SQLite — transactional"), "A")
  assert.equal(optionId("b) lowercase becomes upper"), "B")
  assert.equal(optionId("3. Ten"), "3")
  // No lettered/numbered prefix → the trimmed text (defensive fallback).
  assert.equal(optionId("  just prose  "), "just prose")
})

// ---- composeBlockAnswer ----

test("compose single-select: freetext overrides the chosen chip, else the chosen option text", () => {
  const blk = parseQuestionBlock("Pick one\nA. SQLite\nB. JSON", "question")
  assert.equal(composeBlockAnswer(blk, { chosen: 0, text: "" }), "A. SQLite")
  assert.equal(composeBlockAnswer(blk, { chosen: 0, text: "actually neither" }), "actually neither")
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "" }), "")
})

test("compose a danger gate: same single-select semantics as any question", () => {
  const blk = parseQuestionBlock("Ship it?\nA. Approve\nB. Hold", "question", true)
  assert.equal(composeBlockAnswer(blk, { chosen: 1, text: "" }), "B. Hold")
  // A MULTI-LINE freetext answer survives compose verbatim — the box takes newlines (2026-07-26).
  assert.equal(composeBlockAnswer(blk, { chosen: 0, text: "Hold.\n\nRerun CI first." }), "Hold.\n\nRerun CI first.")
})

test("compose multi: selected letters in option order, freetext appends color", () => {
  const blk = parseQuestionBlock("Which to fix?\n- A. one\n- B. two\n- C. three\n- D. four", "multi")
  // Selected letters render in OPTION order regardless of click order.
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "", chosenSet: [2, 0, 3] }), "A, C, D")
  // Freetext appends as color after the letters.
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "and skip the flaky one", chosenSet: [0, 2] }), "A, C — and skip the flaky one")
  // Selecting none + text-only stays valid (freetext alone).
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "none of these — do X instead", chosenSet: [] }), "none of these — do X instead")
  // Nothing selected and no text → unanswered.
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "", chosenSet: [] }), "")
  // A multi block with an absent chosenSet is treated as an empty selection.
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "" }), "")
})

// ---- recommendedIndex ----

const OPTS = ["A. Implement all three", "B. Just the primary fix", "C. Diagnosis only"]

test("recommendedIndex: plain letter matches its option", () => {
  assert.equal(recommendedIndex("Recommendation: B — tightest fix", OPTS), 1)
  assert.equal(recommendedIndex("Recommendation: A.", OPTS), 0)
})

test("recommendedIndex: markdown-bolded letter still resolves (the **B** regression)", () => {
  // Real-world break: `Recommendation: **B** — …` used to return null and fall back to a muted caption.
  assert.equal(recommendedIndex("Recommendation: **B** — it's the tightest fix", OPTS), 1)
  assert.equal(recommendedIndex("Recommendation: _C_ for now", OPTS), 2)
  assert.equal(recommendedIndex("Recommendation: `A`", OPTS), 0)
})

test("recommendedIndex: also tolerates a bolded option identifier", () => {
  assert.equal(recommendedIndex("Recommendation: B", ["**A.** one", "**B.** two"]), 1)
})

test("recommendedIndex: numeric identifiers", () => {
  assert.equal(recommendedIndex("Recommendation: 2 — cheaper", ["1. one", "2. two", "3. three"]), 1)
})

test("recommendedIndex: no match → null (keeps the muted caption fallback)", () => {
  assert.equal(recommendedIndex(undefined, OPTS), null)
  assert.equal(recommendedIndex("Recommendation: whichever you prefer", OPTS), null)
  assert.equal(recommendedIndex("Recommendation: Z — off the list", OPTS), null)
  // Guard the `(?![A-Za-z0-9])` boundary: an English lead word must NOT read as its first-letter option
  // ("Approve" must not chip option A). Dropping the lookahead would silently regress this to 0.
  assert.equal(recommendedIndex("Recommendation: Approve as-is", OPTS), null)
})

// ---- inline "recommended" marker (the primary mechanism) ----

test("inline (recommended) marker → flags the option, strips the marker, no leftover text", () => {
  const p = parseQuestionBlock("How to proceed?\n\n- A. SQLite — transactional (recommended)\n- B. JSON — zero deps", "question")
  assert.equal(p.recommendedIdx, 0)
  assert.deepEqual(p.options, ["A. SQLite — transactional", "B. JSON — zero deps"])
  assert.equal(p.recommendedNote, undefined)
})

test("inline (recommended: why) → rationale captured as the note", () => {
  const p = parseQuestionBlock("Pick one:\n\n- A. one\n- B. two (recommended: cheaper and simpler)", "question")
  assert.equal(p.recommendedIdx, 1)
  assert.deepEqual(p.options, ["A. one", "B. two"])
  assert.equal(p.recommendedNote, "cheaper and simpler")
})

test("inline marker variants: **Recommended** — lead, trailing — recommended, no dangling separators", () => {
  const lead = parseQuestionBlock("Q?\n\n- A. keep it\n- B. **Recommended** — switch to pnpm", "question")
  assert.equal(lead.recommendedIdx, 1)
  assert.deepEqual(lead.options, ["A. keep it", "B. switch to pnpm"])
  const trail = parseQuestionBlock("Q?\n\n- A. Hold — recommended\n- B. Ship now", "question")
  assert.equal(trail.recommendedIdx, 0)
  assert.deepEqual(trail.options, ["A. Hold", "B. Ship now"])
})

test("inline marker preserves the option's own backticks/emphasis when stripping", () => {
  const p = parseQuestionBlock("Flag?\n\n- A. Use `--strict` (recommended)\n- B. Use `--safe`", "question")
  assert.deepEqual(p.options, ["A. Use `--strict`", "B. Use `--safe`"])
  assert.equal(p.recommendedIdx, 0)
})

test("'recommendation' (the noun) in option prose does NOT flag it — only the word 'recommended'", () => {
  const p = parseQuestionBlock("Q?\n\n- A. Merge as-is — my recommendation stands\n- B. Hold", "question")
  assert.equal(p.recommendedIdx, null)
  assert.deepEqual(p.options, ["A. Merge as-is — my recommendation stands", "B. Hold"])
})

test("first flagged option wins when several carry the marker", () => {
  const p = parseQuestionBlock("Q?\n\n- A. one\n- B. two (recommended)\n- C. three (recommended)", "question")
  assert.equal(p.recommendedIdx, 1)
})

test("no marker + no rec line → recommendedIdx null, no caption", () => {
  const p = parseQuestionBlock("Q?\n\n- A. one\n- B. two", "question")
  assert.equal(p.recommendedIdx, null)
  assert.equal(p.recommendation, undefined)
})

// ---- legacy "Recommendation: X" line still works as a fallback ----

test("legacy rec line: matches an option by letter → recommendedIdx + note, chip (no inline marker)", () => {
  const p = parseQuestionBlock("Pick:\n\n- A. one\n- B. two\n\nRecommendation: B — cheaper", "question")
  assert.equal(p.recommendedIdx, 1)
  assert.equal(p.recommendedNote, "Recommendation: B — cheaper")
  assert.equal(p.recommendation, "Recommendation: B — cheaper")
})

test("legacy rec line that names no option → recommendedIdx null but recommendation kept (muted caption)", () => {
  const p = parseQuestionBlock("Pick:\n\n- A. one\n- B. two\n\nRecommendation: whichever you like", "question")
  assert.equal(p.recommendedIdx, null)
  assert.equal(p.recommendation, "Recommendation: whichever you like")
})

test("inline marker WINS over a legacy rec line if both are present", () => {
  const p = parseQuestionBlock("Pick:\n\n- A. one (recommended)\n- B. two\n\nRecommendation: B", "question")
  assert.equal(p.recommendedIdx, 0)
})

// ---- inline marker: rationale separators + content-vs-marker (round-2 review fixes) ----

test("inline note accepts comma/semicolon separators, not just colon/dash", () => {
  const comma = parseQuestionBlock("Q?\n\n- A. Foo (recommended, because it's faster)\n- B. Bar", "question")
  assert.deepEqual(comma.options, ["A. Foo", "B. Bar"])
  assert.equal(comma.recommendedIdx, 0)
  assert.equal(comma.recommendedNote, "because it's faster")
  const semi = parseQuestionBlock("Q?\n\n- A. Foo (recommended; also cheapest)\n- B. Bar", "question")
  assert.equal(semi.recommendedNote, "also cheapest")
})

test("a bare interior 'recommended' is CONTENT, not a marker — never flagged, never rewritten", () => {
  const p = parseQuestionBlock("Q?\n\n- A. Use the recommended settings\n- B. Use custom settings", "question")
  assert.equal(p.recommendedIdx, null)
  assert.deepEqual(p.options, ["A. Use the recommended settings", "B. Use custom settings"])
  // A hyphenated neighbor ("recommended-only") is likewise left as content.
  const q = parseQuestionBlock("Q?\n\n- A. Enable recommended-only mode\n- B. Enable all", "question")
  assert.equal(q.recommendedIdx, null)
  assert.deepEqual(q.options, ["A. Enable recommended-only mode", "B. Enable all"])
})

test("inline marker with no space before the paren, preserving the label's own backticks", () => {
  const p = parseQuestionBlock("Flag?\n\n- A. Use `--strict`(recommended)\n- B. Use `--safe`", "question")
  assert.deepEqual(p.options, ["A. Use `--strict`", "B. Use `--safe`"])
  assert.equal(p.recommendedIdx, 0)
})
