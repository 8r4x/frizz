import { test } from "node:test"
import assert from "node:assert/strict"
import { Marked } from "marked"
import { stripFrontmatter, MARKDOWN_OPTIONS } from "./markdown.ts"

// mdToHtml's sanitizer needs a DOM, so the sanitizing half is exercised in the browser
// (markdownSanitizer.e2e.test.ts / markdownStrikethrough.e2e.test.ts). What runs here is the pure
// half — the app's real marked configuration, driven straight.
const marked = new Marked(MARKDOWN_OPTIONS)
const render = (md: string) => marked.parseInline(md, { async: false }) as string
const renderBlock = (md: string) => (marked.parse(md, { async: false }) as string).trim()

// The bug: marked's GFM opener is `~~?`, so a lone `~` opened a strikethrough. Agent prose is full of
// approximation and home-path tildes, and two on one line struck out everything between them.
test("strikethrough: an approximation tilde pair is prose, not a strikethrough", () => {
  assert.equal(render("up to ~35s + one 10s poll tick (~45s) before the client"),
    "up to ~35s + one 10s poll tick (~45s) before the client")
  assert.equal(render("bg-panel (val~21) barely differs from page bg (val~13)"),
    "bg-panel (val~21) barely differs from page bg (val~13)")
})

test("strikethrough: a pair of ~/ home paths survives intact", () => {
  assert.equal(render("SYSTEM ~/.claude/settings.json and hook (~/.orca/claude-hook.sh) on User"),
    "SYSTEM ~/.claude/settings.json and hook (~/.orca/claude-hook.sh) on User")
})

test("strikethrough: one tilde on each side is literal text", () => {
  assert.equal(render("~one tilde~"), "~one tilde~")
})

test("strikethrough: the ~~two-tilde~~ form still strikes, and still nests inline markup", () => {
  assert.equal(render("~~struck~~"), "<del>struck</del>")
  assert.equal(render("~~a **b** c~~"), "<del>a <strong>b</strong> c</del>")
  assert.equal(render("~~first~~ then ~single~ then ~~second~~"),
    "<del>first</del> then ~single~ then <del>second</del>")
})

// The sanitizer half of these behaviours is pinned in markdownSanitizer.e2e.test.ts (it needs a DOM);
// what's checkable here is that marked EMITS the markup the sanitizer now has to preserve.
test("task-list items emit a state-carrying marker, not a bare bullet", () => {
  const html = renderBlock("- [x] shipped\n- [ ] pending")
  assert.match(html, /<span class="md-task md-task-checked"><\/span> shipped/)
  assert.match(html, /<span class="md-task"><\/span> pending/)
  assert.doesNotMatch(html, /<input/, "an interactive control has no place in a transcript")
})

test("a list that does not start at 1 emits its own numbering", () => {
  assert.match(renderBlock("17. first\n18. second"), /^<ol start="17">/)
  assert.match(renderBlock("1. first\n2. second"), /^<ol>/)
})

test("strikethrough: non-strikethrough tilde shapes are unchanged", () => {
  assert.equal(render("`~~code~~` stays literal"), "<code>~~code~~</code> stays literal")
  assert.equal(render("~~unclosed"), "~~unclosed")
  assert.equal(render("~~ leading space ~~"), "~~ leading space ~~")
})

// stripFrontmatter underpins the thread header's "Fray document" gate (ChatView.ThreadHeader): the
// button shows iff `stripFrontmatter(threadBody).trim()` is non-empty. These lock the two invariants
// that gate relies on — a missing/frontmatter-only doc must reduce to empty (button HIDDEN, no
// dead-end "No thread file found"), a doc with real body must survive (button SHOWN).
test("stripFrontmatter: empty input stays empty (missing .fray/<slug>.md → doc button hidden)", () => {
  assert.equal(stripFrontmatter("").trim(), "")
})

test("stripFrontmatter: a frontmatter-only doc reduces to empty (no body → button hidden)", () => {
  const md = "---\ntitle: \"x\"\nstatus: active\n---\n"
  assert.equal(stripFrontmatter(md).trim(), "")
})

test("stripFrontmatter: real body survives frontmatter removal (button shown)", () => {
  const md = "---\ntitle: \"x\"\n---\n\n## Goal\nShip it.\n"
  assert.equal(stripFrontmatter(md).trim(), "## Goal\nShip it.")
})

test("stripFrontmatter: body without frontmatter is returned untouched", () => {
  assert.equal(stripFrontmatter("## Goal\nbody").trim(), "## Goal\nbody")
})

test("stripFrontmatter: CRLF frontmatter delimiters are handled", () => {
  const md = "---\r\ntitle: x\r\n---\r\n\r\nbody\r\n"
  assert.equal(stripFrontmatter(md).trim(), "body")
})
