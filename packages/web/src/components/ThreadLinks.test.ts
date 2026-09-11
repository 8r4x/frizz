import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ThreadLinks } from "./ThreadLinks.tsx"
import { CHILD_ARROW } from "../lib/childOps.ts"

test("registered destinations keep the selected row grammar without advertising live work", () => {
  const html = renderToStaticMarkup(createElement(ThreadLinks, { links: [
    { id: "lnk_url", kind: "link", label: "Open dev server", target: "http://localhost:5173/" },
    { id: "lnk_file", kind: "file", label: "Working <plan>", target: "/tmp/plan.md" },
  ] }))
  assert.equal(html.split(CHILD_ARROW).length - 1, 2)
  assert.match(html, /border-t/)
  assert.match(html, /lucide-external-link/)
  assert.match(html, /lucide-file-text/)
  assert.match(html, /href="http:\/\/localhost:5173\/" target="_blank" rel="noopener noreferrer"/)
  assert.match(html, /data-link-destination/)
  assert.match(html, /Working &lt;plan&gt;/)
  assert.match(html, />Link<\/span>/)
  assert.match(html, />File<\/span>/)
  assert.doesNotMatch(html, /data-running-indicator|frizz-live-dot|>Links</)
})

test("no registrations means no divider or empty heading", () => {
  assert.equal(renderToStaticMarkup(createElement(ThreadLinks, { links: [] })), "")
})
