import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// ---- fence check at rest (cc-worker/hooks/fence-stop.mjs) ----
// A worker that hands a decision back in PROSE instead of a ```question fence renders as an ordinary
// handoff card with nothing to answer. Fence use decays with session depth (measured across 532 worker
// transcripts: 23% question fences at the first rest, 9% past the twentieth), so the backstop has to
// look at the actual final message rather than restate the rule earlier in the context. These tests
// EXECUTE the real hook the way Claude Code does — a JSON event on stdin, JSON on stdout — because the
// whole value of it is its wire behavior.

const here = dirname(fileURLToPath(import.meta.url))
const HOOK = join(here, "../../../cc-worker/hooks/fence-stop.mjs")
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

function newProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fence-stop-hook-"))
  mkdirSync(join(dir, ".fray", "threads", SID), { recursive: true })
  return dir
}

/** A transcript ending in one assistant message, after `turns` human prompts. */
function writeTranscript(dir: string, finalText: string, turns = 1, name = "transcript.jsonl"): string {
  const path = join(dir, name)
  const lines: string[] = []
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: `prompt ${i}` } }))
    lines.push(
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } })
    )
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t" }] } }))
  }
  lines.push(
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: finalText }] } })
  )
  writeFileSync(path, lines.join("\n") + "\n")
  return path
}

function runHook(dir: string, event: Record<string, unknown>, args: string[] = [`--session=${SID}`]): string {
  return execFileSync("node", [HOOK, ...args], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FRAY_UI_THREAD: "some-thread" },
  })
}

/** The live shape: the harness hands the hook the final text and the prompt it answers, so nothing
 *  depends on the transcript having been flushed yet. */
function decisionFor(
  dir: string,
  finalText: string,
  promptId = "prompt-1"
): { decision?: string; reason?: string } {
  return JSON.parse(
    runHook(dir, { session_id: SID, last_assistant_message: finalText, prompt_id: promptId, transcript_path: "" })
  )
}

/** The fallback shape: no `last_assistant_message`, no `prompt_id` — read it off disk. */
function decisionFromTranscript(dir: string, finalText: string, turns = 1): { decision?: string; reason?: string } {
  const transcript = writeTranscript(dir, finalText, turns)
  return JSON.parse(runHook(dir, { session_id: SID, transcript_path: transcript }))
}

// A real miss, taken verbatim in shape from the thread that prompted this: a decision deferred to the
// human in the closing paragraph, with no fence anywhere.
const PROSE_ASK =
  "I traced the stuck thread to `canRetry`, which requires an exited runtime, so there is no escape " +
  "hatch at all for a worker that is alive and unresponsive. Restart worker exists and does exactly " +
  "that, but it is `import.meta.env.DEV`-gated and your board serves a production bundle. The gate's " +
  "rationale is about build staleness, not about rescuing a stuck worker — so whether to expose it, " +
  "and under what label, is your call rather than something I should quietly flip."

test("a fenceless rest that defers a decision in prose is blocked once, with the phrase quoted back", () => {
  const dir = newProject()
  const out = decisionFor(dir, PROSE_ASK)
  assert.equal(out.decision, "block")
  assert.match(out.reason ?? "", /```question/)
  assert.match(out.reason ?? "", /your call/, "the matched phrase is quoted so the worker can see what tripped it")
  // The three branches, including the one that lets an aside stay an aside — this never demands work.
  assert.match(out.reason ?? "", /recommendation FIRST/)
  assert.match(out.reason ?? "", /rest\s+again as you were/)
})

test("the same rest is never poked twice, and the re-emitted message cannot chain a loop", () => {
  const dir = newProject()
  assert.equal(decisionFor(dir, PROSE_ASK).decision, "block")
  // Re-emitting still fenceless (branch 3: the worker judged it rhetorical) answers the SAME prompt,
  // so the guard holds. Keying on the message instead would re-fire here forever.
  assert.deepEqual(decisionFor(dir, PROSE_ASK + " Resting as-is."), {})
  // A NEW human turn re-arms it, with no timed cooldown swallowing a rapid second turn.
  assert.equal(decisionFor(dir, PROSE_ASK, "prompt-2").decision, "block")
})

test("the payload's own final message is preferred, because the transcript lags the rest", () => {
  const dir = newProject()
  // Live measurement: of four real broker workers, two had the final message flushed to the
  // transcript by the time Stop ran and two did not. A transcript that still ends on the PREVIOUS
  // turn must not shadow what the harness handed us.
  const transcript = writeTranscript(dir, "An earlier, already-answered message. ".repeat(8))
  const out = JSON.parse(
    runHook(dir, { session_id: SID, transcript_path: transcript, prompt_id: "p", last_assistant_message: PROSE_ASK })
  )
  assert.equal(out.decision, "block")
})

test("without the payload fields it falls back to the transcript, for claude and for codex", () => {
  assert.equal(decisionFromTranscript(newProject(), PROSE_ASK).decision, "block")
  // A codex rollout carries `event_msg`/`agent_message` rather than claude's assistant records.
  const dir = newProject()
  const rollout = join(dir, "rollout.jsonl")
  writeFileSync(
    rollout,
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: PROSE_ASK } }) + "\n"
  )
  assert.equal(JSON.parse(runHook(dir, { session_id: SID, transcript_path: rollout })).decision, "block")
})

test("stop_hook_active stands the check down — another Stop hook is already driving the continuation", () => {
  const dir = newProject()
  const out = runHook(dir, { session_id: SID, last_assistant_message: PROSE_ASK, prompt_id: "p", stop_hook_active: true })
  assert.deepEqual(JSON.parse(out), {})
})

test("an already-fenced rest is silent, for every fence the server recognizes", () => {
  for (const tail of [
    "\n\n```question\nShould the restart control ship outside DEV?\n\n- A. Yes (recommended)\n- B. No\n```",
    "\n\n```done\n- Landed the fix in `RestartFrayButton.tsx`.\n```",
    "\n\n```awaiting\nhuman: maintainer to confirm the label\nHolding for the call above.\n```",
  ]) {
    const dir = newProject()
    assert.deepEqual(decisionFor(dir, PROSE_ASK + tail), {}, tail.slice(0, 20))
  }
})

test("a fence that does not CLOSE the message is not a fence — the server's end-anchor, mirrored", () => {
  const dir = newProject()
  // A worker quoting the protocol mid-message, then closing with a real prose ask.
  const quoted = "Here is the shape:\n\n```done\n- example\n```\n\n" + PROSE_ASK
  assert.equal(decisionFor(dir, quoted).decision, "block")
})

test("silence is the default for everything that is not a deferred decision", () => {
  const dir = newProject()
  // A plain report with no ask.
  assert.deepEqual(
    decisionFor(dir, "Traced the hang to the launcher lock and fixed it in `launcher.ts`. ".repeat(12)),
    {}
  )
  // Too short to be a handback — this exact greeting was the corpus's only false positive.
  assert.deepEqual(decisionFor(newProject(), "Hi! What would you like to work on?"), {})
  // The deferral is three paragraphs up and the message ends on a completion note, so the closing
  // window does not see it.
  assert.deepEqual(
    decisionFor(newProject(), "Say the word and I can take it further.\n\n" + "All four fixes are on local `main` and the suite is green. ".repeat(20)),
    {}
  )
})

test("a missing, unreadable or still-running transcript degrades to silence, never a crash", () => {
  const dir = newProject()
  assert.deepEqual(JSON.parse(runHook(dir, { session_id: SID })), {})
  assert.deepEqual(JSON.parse(runHook(dir, { session_id: SID, transcript_path: join(dir, "nope.jsonl") })), {})
  // A turn whose last record is a tool_result is mid-flight, not at rest.
  const path = join(dir, "midflight.jsonl")
  writeFileSync(
    path,
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: PROSE_ASK }] } }) +
      "\n" +
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t" }] } }) +
      "\n"
  )
  assert.deepEqual(JSON.parse(runHook(dir, { session_id: SID, transcript_path: path })), {})
})

test("a sub-agent's own text never counts — the fence is the TOP-LEVEL worker's handback", () => {
  const dir = newProject()
  const path = join(dir, "sidechain.jsonl")
  writeFileSync(
    path,
    JSON.stringify({ type: "user", message: { role: "user", content: "go" } }) +
      "\n" +
      JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: PROSE_ASK }] } }) +
      "\n" +
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Collected the helper's finding; the cache key is normalized now. ".repeat(6) }] } }) +
      "\n"
  )
  assert.deepEqual(JSON.parse(runHook(dir, { session_id: SID, transcript_path: path })), {})
})

test("the hook is inert outside a fray worker", () => {
  const dir = newProject()
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ session_id: SID, last_assistant_message: PROSE_ASK, prompt_id: "p" }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FRAY_UI_THREAD: "", FRAY_SESSION_ID: "" },
  })
  assert.deepEqual(JSON.parse(out), {})
})

test("the one-shot guard is persisted where the thread's other hook state lives", () => {
  const dir = newProject()
  decisionFor(dir, PROSE_ASK, "prompt-abc")
  const state = JSON.parse(readFileSync(join(dir, ".fray", "threads", SID, ".fence-stop-state.json"), "utf8"))
  assert.equal(state.key, "prompt-abc")
  assert.match(state.firedAt, /^\d{4}-\d{2}-\d{2}T/)
})
