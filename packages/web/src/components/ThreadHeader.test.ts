import assert from "node:assert/strict"
import test from "node:test"
import { PANE_HEADER_HEIGHT_CLASS } from "../lib/paneHeaderHeight.ts"
import { THREAD_HEADER_CLASS, THREAD_HEADER_CONTROLS_CLASS, THREAD_HEADER_TITLE_CLASS } from "../lib/threadHeaderLayout.ts"

// The thread header is the one pane header not drawn by ui/SheetHeader, so it is the one that can
// drift: it measured 52.75px beside the file viewer's 48 when it carried a minimum plus padding. One
// row wide it is the shared fixed height, bare of vertical padding; only the ≤640px wrap goes auto.
test("thread header is the fixed pane-header height, and only the two-row wrap may exceed it", () => {
  const wide = THREAD_HEADER_CLASS.split(/\s+/).filter((token) => !token.startsWith("max-[640px]:"))
  assert.ok(wide.includes(PANE_HEADER_HEIGHT_CLASS), `wide tokens carry ${PANE_HEADER_HEIGHT_CLASS}: ${wide.join(" ")}`)
  assert.equal(wide.find((token) => /^(min-h-|py-|pt-|pb-)/.test(token)), undefined)
  assert.match(THREAD_HEADER_CLASS, /max-\[640px\]:h-auto/)
  assert.match(THREAD_HEADER_CLASS, /max-\[640px\]:min-h-12/)
})

test("drawer thread header reserves a separate, unbroken control row before the sheet becomes cramped", () => {
  assert.match(THREAD_HEADER_CLASS, /max-\[640px\]:flex-wrap/)
  assert.match(THREAD_HEADER_CLASS, /max-\[640px\]:gap-y-2/)
  assert.match(THREAD_HEADER_TITLE_CLASS, /min-w-0/)
  assert.match(THREAD_HEADER_TITLE_CLASS, /max-\[640px\]:basis-full/)
  assert.match(THREAD_HEADER_CONTROLS_CLASS, /max-\[640px\]:w-full/)
  assert.match(THREAD_HEADER_CONTROLS_CLASS, /max-\[640px\]:justify-between/)
  assert.doesNotMatch(THREAD_HEADER_CLASS, /provider/i)
})
