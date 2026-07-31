import assert from "node:assert/strict"
import test from "node:test"
import { CODEX_HOST_DIRECTIVE_NAMES, parseCodexHostDirective } from "./codexHostDirectives.ts"

test("parses every known Codex host directive without granting it behavior", () => {
  for (const name of CODEX_HOST_DIRECTIVE_NAMES) {
    assert.deepEqual(parseCodexHostDirective(`::${name}{}`), { name, attrs: {} })
  }
})

test("parses escaped strings, numbers, and booleans", () => {
  assert.deepEqual(
    parseCodexHostDirective('::code-comment{title="[P2] \\"edge\\"" body="line\\nnext" file="/tmp/a.ts" start=10 priority=2 confidence=0.75 ready=true}'),
    {
      name: "code-comment",
      attrs: { title: '[P2] "edge"', body: "line\nnext", file: "/tmp/a.ts", start: 10, priority: 2, confidence: 0.75, ready: true },
    },
  )
})

test("rejects unknown, inline, malformed, and duplicate attributes", () => {
  for (const line of [
    "::future-card{}",
    "prefix ::archive{}",
    '::archive{reason="unterminated}',
    '::archive{reason="one" reason="two"}',
    "::code-comment{priority=high}",
  ]) assert.equal(parseCodexHostDirective(line), null)
})
