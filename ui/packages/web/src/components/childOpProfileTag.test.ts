import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ChildOpRow, type ChildOpDensity } from "./ChildOpRow.tsx"

// The model+effort tag belongs to the two PROMPT-BOX densities and only to them: those are the pulsing
// rows the maintainer reads under a composer, and the rail has no horizontal room (its type reading
// stays in the row tooltip). Pin the split here — a tag that leaked into the rail would push every
// sidebar label past its truncation point, and one dropped from the sheet would silently un-answer the
// ask that added it.
function row(density: ChildOpDensity, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(ChildOpRow, {
    kind: "AGENT",
    label: "Audit the parser",
    state: "running",
    density,
    subagentType: "fray:opus-high",
    ...extra,
  }))
}

test("both prompt-box densities render the dispatch's model + effort", () => {
  for (const density of ["card", "sheet"] as const) {
    const html = row(density)
    assert.match(html, /\[opus › high\]/, density)
    // The raw dispatch string stays reachable rather than being replaced by the reading.
    assert.match(html, /title="fray:opus-high"/, density)
  }
})

test("the sidebar rail renders no tag, whatever it is passed", () => {
  const html = row("rail")
  assert.doesNotMatch(html, /data-agent-profile/)
  assert.doesNotMatch(html, /opus/)
})

test("a dispatch whose type names no model gets no tag — never a guessed one", () => {
  for (const subagentType of ["general-purpose", "Explore", undefined]) {
    const html = row("sheet", { subagentType })
    assert.doesNotMatch(html, /data-agent-profile/, String(subagentType))
  }
})

test("a background SHELL has no profile to show", () => {
  // Callers leave subagentType unset for shells; even if one leaked through, there is nothing to parse.
  const html = renderToStaticMarkup(createElement(ChildOpRow, {
    kind: "SHELL",
    label: "Watch CI",
    state: "running",
    density: "sheet",
  }))
  assert.doesNotMatch(html, /data-agent-profile/)
})
