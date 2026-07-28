import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const names = ["ci-watch.mjs", "github-watch.mjs", "review-watch.mjs"]
const targets = ["cc-worker/skills/gh/scripts"]

test("provider packages contain byte-identical generated monitor entrypoints", () => {
  for (const target of targets) for (const name of names) {
    const source = join(root, "monitors", name)
    const copy = join(root, target, name)
    assert.ok(existsSync(copy), `missing ${copy}`)
    assert.equal(readFileSync(copy, "utf8"), readFileSync(source, "utf8"), `${copy} drifted from ${source}`)
  }
})

test("portable monitor guidance requires declared-project precedence and explicit validation", () => {
  const guide = readFileSync(join(root, "monitors", "README.md"), "utf8")
  assert.match(guide, /inspect project-local `AGENTS\.md`, active skills, repository docs,[\s\S]*`package\.json` scripts, and declared monitor tooling/)
  assert.match(guide, /Validate its absolute command and its\s+terminal event\/exit contract before launching it/)
  assert.match(guide, /do not silently fall back[\s\S]*shadow it/)
})

// The codex ORCHESTRATOR skill is retired, but Codex is still a live fray-ui worker BACKEND, so its
// golden worker prompt keeps the same guidance bar the Claude one does.
test("worker guidance prefers declared tooling and makes no Luna child mandatory", () => {
  const claude = readFileSync(join(root, "cc-worker/skills/gh/SKILL.md"), "utf8")
  assert.match(claude, /project-local `AGENTS\.md`/)
  assert.match(claude, /terminal\s+event\/exit contract/)
  assert.match(claude, /never silently shadow/)
  assert.match(claude, /workflow name.*event|workflow name plus event/)
  assert.match(claude, /use native `Monitor`/)

  const promptDir = join(root, "ui/packages/server/src")
  const codexPrompt = readFileSync(join(promptDir, "WORKER_PROMPT.codex.golden.txt"), "utf8")
  const claudePrompt = readFileSync(join(promptDir, "WORKER_PROMPT.claude.golden.txt"), "utf8")
  for (const prompt of [codexPrompt, claudePrompt]) {
    assert.match(prompt, /project-local `AGENTS\.md`/)
    assert.match(prompt, /terminal event\/exit semantics/)
    assert.match(prompt, /silently shadow/)
  }
  assert.match(codexPrompt, /Luna child is optional/)
  assert.doesNotMatch(codexPrompt, /cheap monitor child/)
  assert.match(claudePrompt, /native `Monitor` is the\nClaude adapter/)
})
