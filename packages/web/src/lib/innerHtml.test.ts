import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

// fileURLToPath, never `.pathname`: a file URL's pathname keeps the leading slash a Windows drive path
// does not have (`/C:/…`), which readdirSync then resolves against the current drive as `C:\C:\…` and
// fails with ENOENT. It also decodes percent-escapes, so a checkout under a directory with a space in
// it works on every platform.
const SRC = fileURLToPath(new URL("..", import.meta.url))

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    // Fixtures are dev-only harnesses that render once and are never mounted in the product; the rule
    // below is about surfaces that re-render.
    else if (/\.tsx$/.test(entry.name) && !entry.name.endsWith("-fixture.tsx")) out.push(full)
  }
  return out
}

// React 19 skips a prop only when `next === prev`, and `dangerouslySetInnerHTML` takes an OBJECT — so an
// inline `{ __html }` literal fails that reference check on every render and React re-assigns
// `element.innerHTML` unconditionally, throwing away and rebuilding the subtree from identical markup.
// That rebuild recreates any <img> inside it, which re-issues its request; a screenshot whose file is
// gone then 404s, flips the row's height, re-measures the virtualized transcript and renders again —
// the frame-rate jitter loop this guard exists to keep from coming back. See lib/innerHtml.ts.
test("every dangerouslySetInnerHTML prop is memoized through useInnerHtml", () => {
  const offenders: string[] = []
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8")
    for (const [i, line] of source.split("\n").entries()) {
      if (/dangerouslySetInnerHTML=\{\{/.test(line)) offenders.push(`${file.slice(SRC.length)}:${i + 1}`)
    }
  }
  assert.deepEqual(offenders, [], "pass useInnerHtml(html) instead of an inline { __html } literal")
})

test("a markdown screenshot whose file is gone degrades to a stable path line", () => {
  const links = readFileSync(new URL("./local-file-links.ts", import.meta.url), "utf8")
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8")

  // `error` does not bubble, so the delegated listener is useless without the capture flag.
  assert.match(links, /addEventListener\("error", \w+, true\)/)
  assert.match(links, /removeEventListener\("error", \w+, true\)/)
  assert.match(links, /md-image-missing/)
  // BlockImage's <img> carries the same data-local-image marker but is React-owned and has its own
  // onError fallback — replacing that node would corrupt the tree React is reconciling.
  assert.match(links, /closest\(["'`]\.md-body, \.md-inline["'`]\)/)

  const fallback = styles.match(/\.md-body \.md-image-missing \{[\s\S]*?\n\}/)?.[0]
  assert.ok(fallback, "the missing-screenshot fallback style should remain discoverable")
  // Block, so it holds one stable line instead of collapsing and reflowing the transcript.
  assert.match(fallback, /display:\s*block/)
})
