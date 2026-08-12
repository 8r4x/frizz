import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// ---- the Stop fence hook (cc-worker/hooks/stop-fence.mjs) ----
// The contract states the fence grammar ONCE, in the appended system prompt, and that text is always
// present (the SDK re-sends systemPrompt every request; compaction only rewrites the message array).
// What it is NOT is NEARBY: on a long thread it sits hundreds of thousands of tokens behind the moment
// the worker decides how to stop. This hook is the only surface that speaks AT that moment.
//
// These tests EXECUTE the real hook the way Claude Code does — a JSON event on stdin, JSON on stdout —
// because the whole value of a hook is its wire behavior, not its source.
//
// The two properties worth defending are both about COST, in opposite directions:
//   - it must be SILENT for a worker that did nothing wrong (every fire costs a full model turn), and
//   - it must never nag TOWARD a fence: `done` is a dismissal, so trading a forgotten `done` for a
//     premature one is the more expensive mistake. Both messages name bare rest as correct.

const here = dirname(fileURLToPath(import.meta.url))
const HOOK = join(here, "../../../cc-worker/hooks/stop-fence.mjs")
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const DEEP = 400_000
const SHALLOW = 20_000

function newProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "stop-fence-hook-"))
  mkdirSync(join(dir, ".frizz", "threads", SID), { recursive: true })
  return dir
}

/** A transcript whose newest usage record reports `tokens` of context fill — the shape Claude Code
 *  writes, and what the depth gate reads. */
function writeTranscript(dir: string, tokens: number): string {
  const path = join(dir, "transcript.jsonl")
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: tokens - 1002 }
  writeFileSync(
    path,
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) +
      "\n" +
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage } }) +
      "\n"
  )
  return path
}

function runHook(dir: string, event: Record<string, unknown>, env: Record<string, string> = {}): string {
  return execFileSync("node", [HOOK], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: dir,
      FRIZZ_THREAD: "some-thread",
      ...env,
    },
  })
}

/** The default event: a deep thread whose last message is plain prose with no fence and no ask. */
function stopEvent(dir: string, message: string, tokens = DEEP, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: "Stop",
    session_id: SID,
    transcript_path: writeTranscript(dir, tokens),
    stop_hook_active: false,
    last_assistant_message: message,
    ...extra,
  }
}

function contextOf(out: string): string {
  if (!out.trim()) return ""
  const parsed = JSON.parse(out)
  assert.equal(parsed.hookSpecificOutput?.hookEventName, "Stop", "must address the Stop event")
  return String(parsed.hookSpecificOutput?.additionalContext ?? "")
}

const PROGRESS = "Landed the parser change and the tests are green. Next I will wire the reader side."

// ---- silence: the common case must cost nothing ----

test("a message that already carries a fence is silent", () => {
  const dir = newProject()
  for (const fence of ["done", "awaiting", "question"]) {
    const message = "Here is the summary.\n\n```" + fence + "\n- did the thing\n```"
    assert.equal(runHook(dir, stopEvent(dir, message)), "", `\`\`\`${fence} must satisfy the hook`)
  }
})

test("a fence tag with a modifier still counts as a fence", () => {
  const dir = newProject()
  const message = "Pick one.\n\n```question danger\nForce-push?\n\n- A. yes\n- B. no\n```"
  assert.equal(runHook(dir, stopEvent(dir, message)), "")
})

test("outside a frizz worker the hook is inert", () => {
  const dir = newProject()
  assert.equal(runHook(dir, stopEvent(dir, PROGRESS), { FRIZZ_THREAD: "" }), "")
})

test("the env escape hatch silences it, and only an explicit off value does", () => {
  const dir = newProject()
  assert.equal(runHook(dir, stopEvent(dir, PROGRESS), { FRIZZ_STOP_FENCE_HOOK: "off" }), "")
  assert.notEqual(runHook(newProject(), stopEvent(dir, PROGRESS), { FRIZZ_STOP_FENCE_HOOK: "yes" }), "")
})

test("a sub-agent's stop is its parent's business, not the human's", () => {
  const dir = newProject()
  assert.equal(runHook(dir, stopEvent(dir, PROGRESS, DEEP, { agent_id: "agent-1" })), "")
})

test("stop_hook_active is honoured — the runtime's own re-entry flag", () => {
  const dir = newProject()
  assert.equal(runHook(dir, stopEvent(dir, PROGRESS, DEEP, { stop_hook_active: true })), "")
})

test("a shallow thread is left alone — 'forgot' is not the plausible reading there", () => {
  const dir = newProject()
  assert.equal(runHook(dir, stopEvent(dir, PROGRESS, SHALLOW)), "")
})

test("an empty or missing last message says nothing", () => {
  const dir = newProject()
  assert.equal(runHook(dir, stopEvent(dir, "   ")), "")
  assert.equal(runHook(dir, { hook_event_name: "Stop", session_id: SID, stop_hook_active: false }), "")
})

// ---- the loop guard, which must not depend on stop_hook_active behaving as documented ----

test("resting again on the SAME message is silent: the worker considered the reminder and declined", () => {
  const dir = newProject()
  const asking = "I finished the parser. Should I also migrate the reader?"
  assert.notEqual(runHook(dir, stopEvent(dir, asking)), "", "the first unfenced ask is worth one turn")
  assert.equal(runHook(dir, stopEvent(dir, asking)), "", "the second is an argument, not a reminder")
})

test("the cooldown holds even when a DIFFERENT message follows immediately", () => {
  const dir = newProject()
  assert.notEqual(runHook(dir, stopEvent(dir, "Should I migrate the reader?")), "")
  assert.equal(runHook(dir, stopEvent(dir, "Want me to delete the old path?")), "", "cooled down")
})

test("the state file is what enforces both guards", () => {
  const dir = newProject()
  runHook(dir, stopEvent(dir, "Should I migrate the reader?"))
  const state = JSON.parse(readFileSync(join(dir, ".frizz", "threads", SID, ".stop-fence-state.json"), "utf8"))
  assert.ok(state.firedAtMs > 0)
  assert.equal(state.tokensAtFire, DEEP)
  assert.ok(String(state.lastMessage).startsWith("Should I migrate"))
})

// ---- the unfenced ask: the defect that actually costs the human a round trip ----

test("an unfenced ask is named as one, and is told the question-block shape", () => {
  const dir = newProject()
  const out = contextOf(runHook(dir, stopEvent(dir, "The parser is done. Should I migrate the reader too?")))
  assert.match(out, /⟦fence check⟧/)
  assert.match(out, /asks the human something/)
  assert.match(out, /```question/)
  assert.match(out, /ONE line/)
  assert.match(out, /\(recommended\)/)
  // The ACTION must lead. A draft that opened with the diagnosis and buried the instruction did not move
  // a real model at all, while a flat imperative did — so pin that the imperative is present and early.
  assert.match(out, /SEND IT AGAIN NOW/)
  assert.ok(out.indexOf("SEND IT AGAIN NOW") < out.indexOf("Two exits"), "the action precedes the exits")
  // It must still offer the other answer: a rhetorical question is not a defect.
  assert.match(out, /rest again unchanged/)
  // And it must not become a way to ask permission for the dispatched work.
  assert.match(out, /asking permission to do work you were already dispatched to do/)
})

test("an ask is detected on a phrase as well as a question mark", () => {
  const dir = newProject()
  for (const message of [
    "I have two options here. Let me know which you prefer.",
    "Want me to also delete the legacy path.",
    "This one is your call.",
  ]) {
    const out = contextOf(runHook(newProject(), stopEvent(dir, message)))
    assert.match(out, /asks the human something/, `should flag: ${message}`)
  }
})

// These two assert on the CLASSIFICATION, not on silence. At this depth the periodic reminder is due
// either way, so "it said nothing" would pass for the wrong reason; what must hold is that neither
// message is read as a handback to the human.
test("an ask deep in the NARRATION is not an ask — only the tail is scanned", () => {
  const dir = newProject()
  const message =
    "I wondered: should I migrate the reader?\n\n" +
    "x".repeat(4000) +
    "\n\nI decided yes, did it, and the suite is green. Nothing is outstanding on my side."
  const out = contextOf(runHook(dir, stopEvent(dir, message)))
  assert.doesNotMatch(out, /asks the human something/,"a question asked and then ANSWERED is not a handback")
  assert.match(out, /very often RIGHT/, "it is an ordinary deep bare rest")
})

test("a `?` inside a fenced code block does not count — the strip is what makes this usable", () => {
  const dir = newProject()
  const message = "Fixed the glob. The failing case was:\n\n```sh\ngrep -c 'what?' file\n```"
  const out = contextOf(runHook(dir, stopEvent(dir, message)))
  assert.doesNotMatch(out, /asks the human something/,"a pasted command is not a question to the human")
  assert.match(out, /very often RIGHT/)
})

test("a shallow thread with a pasted `?` is fully silent — neither path fires", () => {
  const dir = newProject()
  const message = "Fixed the glob. The failing case was:\n\n```sh\ngrep -c 'what?' file\n```"
  assert.equal(runHook(dir, stopEvent(dir, message, SHALLOW)), "")
})

// ---- the periodic four-option reminder ----

test("a deep unfenced rest gets the four options, with bare rest named FIRST and as correct", () => {
  const dir = newProject()
  const out = contextOf(runHook(dir, stopEvent(dir, PROGRESS)))
  assert.match(out, /⟦fence check⟧/)
  assert.match(out, /~400k tokens deep/)
  // The anti-nag property. This is the one that keeps a forgotten `done` from becoming a premature one.
  assert.match(out, /very often RIGHT/)
  assert.match(out, /bare rest is the ordinary handoff and the default/)
  assert.match(out, /rest again unchanged/)
  // All four states, and the trap in each.
  assert.match(out, /```done ` is a DISMISSAL/)
  assert.match(out, /never fits a thread still pointing at future work/)
  assert.match(out, /`human:` \/ `timer:` \/ `pr-watch:` gate, never on CI or a merge/)
  assert.match(out, /```question ` is the ask/)
  // And the stop criterion outranks all of it.
  assert.match(out, /still has parts left, none of them apply/)
})

test("the reminder is paced by CONTEXT GROWTH, not by every stop", () => {
  const dir = newProject()
  assert.notEqual(runHook(dir, stopEvent(dir, PROGRESS, 400_000)), "")
  // A different message and no cooldown left, but the thread has barely grown.
  const soon = { ...stopEvent(dir, "Still going.", 410_000), stop_hook_active: false }
  assert.equal(runHook(dir, soon, { FRIZZ_STOP_FENCE_COOLDOWN_MS: "1" }), "", "10k of growth is not a new reminder")
  const later = { ...stopEvent(dir, "Now much later.", 600_000), stop_hook_active: false }
  assert.notEqual(runHook(dir, later, { FRIZZ_STOP_FENCE_COOLDOWN_MS: "1" }), "", "200k of growth is")
})

test("an unreadable transcript never produces the depth-based reminder", () => {
  const dir = newProject()
  const event = { ...stopEvent(dir, PROGRESS), transcript_path: join(dir, "nope.jsonl") }
  assert.equal(runHook(dir, event), "", "no usage record → no depth → silence is always safe")
})
