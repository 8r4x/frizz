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
  // The settled body carries the muted tone on a `card-md` WRAPPER, because `.card-md .md-body` inherits
  // colour by design and would otherwise outrank a utility class on the element itself.
  assert.match(code, /className="card-md text-muted"/, "the settled body's tone rides a wrapper")
  assert.match(code, /if \(body\.trim\(\) === ""\) return null/, "a fence that is pure frontmatter has no prose to leave behind")
})
