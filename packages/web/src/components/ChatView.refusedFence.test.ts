import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")

// A fence frizz REFUSED is not a wait, so it draws nothing: an "Awaiting" card with an hourglass and a
// park button asserts a park frizz declined to arm, and the settled-fence prose under it is a handoff the
// worker is about to write again in its re-fence. The server sets the flag when it folds the correction
// out of the transcript (transcript.ts markFenceRefused).
test("a refused awaiting fence is skipped before it ever reaches a card", () => {
  const render = source.match(/const renderText = \([\s\S]*?\n {2}\}/)?.[0]
  assert.ok(render, "renderText must exist")
  assert.match(
    render,
    /if \(m\.fenceRefused && fseg\.fenceKind === "awaiting"\) continue/,
    "the fence block must be skipped, not rendered as an empty card",
  )
  // SKIPPED, not returned as null from the card: the block list is interleaved with explicit spacers, so
  // a slot that renders nothing still spends one.
  assert.ok(
    render.indexOf("m.fenceRefused") < render.indexOf("<FenceCard"),
    "the skip must come before the push, so no block slot is spent on a fence that draws nothing",
  )
  // …and `done` is untouched: a finished thread stays finished whatever frizz thought of its last park.
  assert.doesNotMatch(render, /fenceRefused[^\n]*"done"/)
})

// The fence's prose has been BLOCK markdown since frontmatter landed (2026-08-17), but every body kept
// the `md-inline` class, which styles only code/strong/em/links — so a `<ul>` arrived with Tailwind's
// preflight reset still on it and a handoff's bullet list rendered as flat unmarked lines.
test("every awaiting-fence body renders through the block markdown sheet", () => {
  const card = source.match(/export function FenceCard\([\s\S]*?\n}/)?.[0]
  assert.ok(card, "FenceCard must exist")
  // Comments off first — the note explaining WHY the class moved names the old one, and an unstripped
  // match would be satisfied by that sentence rather than by the code.
  const code = card.replace(/^\s*\/\/.*$/gm, "")
  assert.doesNotMatch(code, /md-inline/, "a fence body is block markdown — md-inline gives its lists no markers")
  assert.match(code, /if \(body\.trim\(\) === ""\) return null/, "a fence that is pure frontmatter has no prose to leave behind")
})

// A SETTLED fence's body is ordinary prose: plain `md-body`, no muted tone and no card scale. Both were
// leftovers from the card frame this branch exists to strip, and they survived it riding a `card-md
// text-muted` wrapper — so free-standing the body drew a 13px grey paragraph between two 14px white ones
// with no chrome to explain the difference, and read as broken (maintainer 2026-08-20: "still seeing this
// fucking light gray lines"). "Settled" retracts the claim that a wait is still open — the frame, the
// hourglass, the item table, the park button. It was never a reason to whisper the message.
test("a settled awaiting fence's prose reads like every other thing the worker said", () => {
  const card = source.match(/export function FenceCard\([\s\S]*?\n}/)?.[0]
  assert.ok(card, "FenceCard must exist")
  // The stale branch alone — the card branches below it legitimately mute their own machinery rows.
  const settled = card.match(/if \(stale === true && fenceKind === "awaiting"\) \{[\s\S]*?\n {2}\}/)?.[0]
  assert.ok(settled, "the settled-fence branch must exist")
  const code = settled.replace(/^\s*\/\/.*$/gm, "")
  assert.doesNotMatch(code, /card-md|text-muted|text-fg\//, "a settled body wears no dimming and no card scale")
  assert.match(code, /className=\{`md-body\$\{wrap \? ` \$\{QUEUE_WRAP\}` : ""\}`\}/, "it renders through the same plain block sheet ProseHtml uses")
})
