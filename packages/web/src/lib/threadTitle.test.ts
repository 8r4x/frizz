import { test } from "node:test"
import assert from "node:assert/strict"
import { aiRenameAvailability, manualThreadTitleSeed, threadTitleToCommit } from "./threadTitle.ts"

test("threadTitleToCommit: trims a human title and preserves empty/unchanged titles as no-ops", () => {
  assert.equal(threadTitleToCommit("  Human-readable thread title  ", "generated-slug"), "Human-readable thread title")
  assert.equal(threadTitleToCommit("   ", "Keep this"), undefined)
  assert.equal(threadTitleToCommit(" Keep this ", "Keep this"), undefined)
})

test("manualThreadTitleSeed: never seeds an editor with an internal slug or placeholder", () => {
  assert.equal(manualThreadTitleSeed("generated-slug", "generated-slug"), "")
  assert.equal(manualThreadTitleSeed("Untitled thread", "generated-slug"), "")
  assert.equal(manualThreadTitleSeed("Spinning up a thread…", "generated-slug"), "")
  assert.equal(manualThreadTitleSeed("Readable title", "generated-slug"), "Readable title")
})

test("aiRenameAvailability: any LIVE broker Claude session can be renamed; Codex and foreign rows never fake native support", () => {
  assert.deepEqual(aiRenameAvailability({ kind: "session", backend: "claude", runtime: "turn-idle" }), {
    show: true, enabled: true, label: "Rename with Claude — a fresh title from the opening request",
  })
  // The verb goes through the broker's control channel, not the session's composer, so a turn in
  // flight or an open permission prompt is no longer a reason to refuse it — that gate belonged to the
  // deleted `/rename`-typing path and made the button a silent no-op on every running thread.
  assert.equal(aiRenameAvailability({ kind: "session", backend: "claude", runtime: "running" }).enabled, true)
  assert.equal(aiRenameAvailability({ kind: "session", backend: "claude", runtime: "perm-prompt" }).enabled, true)
  // What it genuinely needs is a live daemon to ask.
  assert.equal(aiRenameAvailability({ kind: "session", backend: "claude", runtime: "exited" }).enabled, false)
  assert.match(aiRenameAvailability({ kind: "session", backend: "claude", runtime: "exited" }).label, /Resume/)
  assert.equal(aiRenameAvailability({ kind: "session", backend: "claude", runtime: "spawning" }).enabled, false)
  assert.equal(aiRenameAvailability({ kind: "session", backend: "codex", runtime: "turn-idle" }).show, false)
  assert.equal(aiRenameAvailability({ kind: "session", backend: "claude", foreign: true, runtime: "turn-idle" }).show, false)
  // A pre-broker Claude row has no control channel; the RPC refuses it, so it gets no button at all.
  assert.equal(aiRenameAvailability({ kind: "session", backend: "claude", claudeRuntime: "pty", runtime: "turn-idle" }).show, false)
  assert.equal(aiRenameAvailability({ kind: "session", backend: "claude", claudeRuntime: "broker", runtime: "turn-idle" }).show, true)
})
