import assert from "node:assert/strict"
import test from "node:test"
import { childOpSubtree } from "./childOps.ts"
import { childOpDismisser } from "./dismissChildOp.ts"

// The board ships ONE flat list per thread — every direct child and every descendant, each naming its
// dispatcher. A SUB-AGENT drawer's ops strip has to cut its own branch out of that list, or it would
// advertise a sibling's fan-out as the work running under the child you opened.
const FOREST = [
  { id: "a", label: "branch A", state: "rested" },
  { id: "a1", label: "A's child", state: "running", depth: 2, parentId: "a" },
  { id: "a1x", label: "A's grandchild", state: "running", depth: 3, parentId: "a1" },
  { id: "b", label: "branch B", state: "running" },
  { id: "b1", label: "B's child", state: "running", depth: 2, parentId: "b" },
]

test("a sub-agent drawer lists its own subtree, depth-first, and never a sibling's", () => {
  assert.deepEqual(childOpSubtree(FOREST, "a").map((op) => op.id), ["a1", "a1x"])
  assert.deepEqual(childOpSubtree(FOREST, "b").map((op) => op.id), ["b1"])
  // A leaf child, and an id the thread does not track, both come back empty rather than falling back
  // to the whole forest — an empty strip is the honest reading of "nothing runs under this one".
  assert.deepEqual(childOpSubtree(FOREST, "a1x"), [])
  assert.deepEqual(childOpSubtree(FOREST, "unknown"), [])
})

test("the indent is re-based on the drawer's own root while `depth` stays the thread's reading", () => {
  const rows = childOpSubtree(FOREST, "a")
  // What the row INDENTS by: a child this sub-agent dispatched itself starts flush, exactly as a
  // direct child does in the thread's own strip.
  assert.deepEqual(rows.map((op) => op.displayDepth), [1, 2])
  // What the row IS: untouched, because childOpDismisser reads it. Re-basing here would have handed
  // every row a × that retires an op this thread never tracked — a control that silently does nothing.
  assert.deepEqual(rows.map((op) => op.depth), [2, 3])
})

test("a descendant row still refuses the × after the indent is re-based", () => {
  for (const row of childOpSubtree(FOREST, "a")) {
    assert.equal(childOpDismisser("t", { ...row, stoppable: true }), undefined, `${row.id} is not a direct child`)
  }
  // The control the drawer DOES offer for these is its own "Stop sub-agent" button, not this ×.
})

test("a self-parented row terminates instead of spinning", () => {
  const cyclic = [
    { id: "x", state: "running", depth: 2, parentId: "root" },
    { id: "root", state: "running", depth: 2, parentId: "x" },
  ]
  assert.deepEqual(childOpSubtree(cyclic, "root").map((op) => op.id), ["x"])
})
