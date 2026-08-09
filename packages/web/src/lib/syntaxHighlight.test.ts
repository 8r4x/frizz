import assert from "node:assert/strict"
import test from "node:test"
import {
  renderHighlightedCode,
  resolveFenceLanguage,
  SUPPORTED_FENCE_LANGUAGES,
} from "./syntaxHighlight.ts"

test("first-cut fenced language set stays explicit and bundle-bounded", () => {
  assert.deepEqual(Object.keys(SUPPORTED_FENCE_LANGUAGES), [
    "bash", "css", "diff", "javascript", "json", "markdown",
    "python", "rust", "sql", "typescript", "xml", "yaml",
  ])
})

test("fence aliases resolve without guessing unknown languages", () => {
  assert.equal(resolveFenceLanguage("ts title=worker.ts"), "typescript")
  assert.equal(resolveFenceLanguage("JSX"), "javascript")
  assert.equal(resolveFenceLanguage("shell"), "bash")
  assert.equal(resolveFenceLanguage("rs"), "rust")
  assert.equal(resolveFenceLanguage("py"), "python")
  assert.equal(resolveFenceLanguage("yml"), "yaml")
  assert.equal(resolveFenceLanguage("totally-made-up"), "plaintext")
  assert.equal(resolveFenceLanguage(), "plaintext")
})

test("declared languages highlight multiline source and preserve whitespace", () => {
  const html = renderHighlightedCode("const answer: number = 42\n\tconsole.log(answer)\n", "ts")
  assert.match(html, /^<span class="md-code"><pre><code class="hljs language-typescript">/)
  assert.match(html, /hljs-keyword/)
  assert.match(html, /\n\t<span class="hljs-variable language_">console<\/span>/)
  assert.match(html, /\n<\/code><\/pre>/)
})

// `<pre>` preserves whitespace, so the copy button may not be separated from the code by so much as a
// newline — one would print as a blank first line in every fenced block in the app.
test("every fenced block carries a copy button, and no stray whitespace inside the pre", () => {
  const html = renderHighlightedCode("echo hi\n", "bash")
  assert.match(html, /<\/code><\/pre><button type="button" class="md-code-copy" title="Copy code"><\/button><\/span>\n$/)
  assert.equal(html.match(/<pre>([\s\S]*)<\/pre>/)?.[1].startsWith("<code"), true)
})

test("unknown and missing languages are escaped plaintext, never executable markup", () => {
  const malicious = `</code><img src=x onerror="globalThis.pwned = true">&'`
  for (const language of [undefined, "text", "brainfuck-but-not-enabled"]) {
    const html = renderHighlightedCode(malicious, language)
    assert.match(html, /class="hljs language-plaintext"/)
    assert.ok(!html.includes("<img"))
    assert.ok(html.includes("&lt;/code&gt;&lt;img src=x onerror=&quot;"))
    assert.ok(html.includes("&amp;&#39;"))
  }
})

test("long lines remain intact for the surface CSS to scroll or wrap", () => {
  const longToken = "x".repeat(1_024)
  const html = renderHighlightedCode(longToken, "plaintext")
  assert.equal(html.match(/<code[^>]*>([\s\S]*)<\/code>/)?.[1], `${longToken}\n`)
})
