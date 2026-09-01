import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SheetHeader } from "./SheetHeader.tsx"

test("SheetHeader renders the title and a lucide close button (never a typographic ×)", () => {
  const html = renderToStaticMarkup(createElement(SheetHeader, {
    title: "Fix the flip-surface width",
    onClose: () => undefined,
  }))
  assert.match(html, /Fix the flip-surface width/)
  assert.match(html, /aria-label="Close"/)
  // The lucide <X> renders an <svg class="lucide lucide-x"> sized to 15; never the bare × glyph the
  // MissingThread fallback still uses (D12 follow-up).
  assert.match(html, /lucide-x/)
  assert.match(html, /width="15"/)
  assert.doesNotMatch(html, /×/)
})

test("SheetHeader renders subtitle, icon, meta, and actions when provided", () => {
  const html = renderToStaticMarkup(createElement(SheetHeader, {
    title: "Background shell",
    subtitle: "plan-42.md",
    icon: createElement("span", { "data-testid": "icon" }, "IC"),
    meta: createElement("span", { "data-testid": "meta" }, "running 3m"),
    actions: createElement("span", { "data-testid": "actions" }, "● unsaved"),
    onClose: () => undefined,
  }))
  assert.match(html, /plan-42\.md/)
  assert.match(html, /data-testid="icon"/)
  assert.match(html, /data-testid="meta"/)
  assert.match(html, /running 3m/)
  assert.match(html, /data-testid="actions"/)
  assert.match(html, /● unsaved/)
})

test("SheetHeader omits subtitle/icon/meta/actions markers when not provided", () => {
  const html = renderToStaticMarkup(createElement(SheetHeader, {
    title: "Just a title",
    onClose: () => undefined,
  }))
  assert.doesNotMatch(html, /data-testid=/)
})

test("initialFocus stamps data-dialog-initial-focus on the close button; omitted, it is absent", () => {
  const withFocus = renderToStaticMarkup(createElement(SheetHeader, {
    title: "Thread unavailable",
    onClose: () => undefined,
    initialFocus: true,
  }))
  assert.match(withFocus, /data-dialog-initial-focus/)

  const withoutFocus = renderToStaticMarkup(createElement(SheetHeader, {
    title: "Thread unavailable",
    onClose: () => undefined,
  }))
  assert.doesNotMatch(withoutFocus, /data-dialog-initial-focus/)
})
