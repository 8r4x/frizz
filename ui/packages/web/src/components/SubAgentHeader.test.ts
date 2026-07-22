import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SubAgentHeader } from "./SubAgentHeader.tsx"

test("the sub-agent drawer header names the work without repeating profile or runtime state", () => {
  const html = renderToStaticMarkup(createElement(SubAgentHeader, {
    label: "Complete GVS fix differential repro",
    onClose: () => undefined,
  }))

  assert.match(html, /Complete GVS fix differential repro/)
  assert.match(html, /aria-label="Close"/)
  assert.doesNotMatch(html, /fray:opus-xhigh/)
  assert.doesNotMatch(html, /running|stale|finished|unavailable/)
})
