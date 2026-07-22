import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { readBackgroundShellOutput } from "./background-shell-output.ts"

test("background shell output reads a bounded, presentation-safe tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-shell-output-"))
  try {
    const path = join(dir, "task.output")
    writeFileSync(path, `discard-me\n12345\u001b[31mred\u001b[0m\rprogress`)
    assert.deepEqual(readBackgroundShellOutput(path, 24), {
      output: "345red\nprogress",
      truncated: true,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("background shell output degrades safely when the task file is unavailable", () => {
  assert.deepEqual(readBackgroundShellOutput("/definitely/missing/fray-shell-output"), { output: "", truncated: false })
})
