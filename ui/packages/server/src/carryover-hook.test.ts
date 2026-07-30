import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// ---- carryover hook (cc-worker/hooks/carryover.mjs) ----
// The per-session brief that is re-injected VERBATIM at every session start and after every
// compaction. These tests EXECUTE the real hook the way Claude Code does — argv flags, a JSON event
// on stdin, output on stdout — rather than asserting on its source, because the whole value of the
// hook is its wire behavior. The three channels were also verified live against cli 2.1.220 (a real
// session quoted a sentinel from the brief with zero tool calls; `PreCompact:manual` and the
// `UserPromptSubmit` nudge both logged status 0); this file is the regression net under that.

const here = dirname(fileURLToPath(import.meta.url))
const HOOK = join(here, "../../../../cc-worker/hooks/carryover.mjs")
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

function newProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "carryover-"))
  mkdirSync(join(dir, ".fray", "threads", SID), { recursive: true })
  return dir
}

function threadFile(dir: string, name: string): string {
  return join(dir, ".fray", "threads", SID, name)
}

function writeBrief(dir: string, body: string): void {
  writeFileSync(threadFile(dir, "carryover.md"), body)
}

// A transcript whose newest usage record reports `tokens` of context fill — the same shape Claude
// Code writes (`input + cache_creation + cache_read`), which is what the nudge reads.
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

function runHook(
  dir: string,
  args: string[],
  event: Record<string, unknown>,
  env: Record<string, string> = {}
): string {
  return execFileSync("node", [HOOK, ...args], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FRAY_UI_THREAD: "", FRAY_CARRYOVER: "", ...env },
  })
}

function additionalContext(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext as string
}

test("session-start with no brief teaches the mechanism and injects nothing else", () => {
  const dir = newProject()
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "startup" }))
  assert.match(ctx, /⟦carryover brief⟧/)
  assert.match(ctx, new RegExp(`\\.fray/threads/${SID}/carryover\\.md`))
  assert.match(ctx, /injected\s+VERBATIM/)
  // No brief on disk → no restored block at all.
  assert.doesNotMatch(ctx, /⟦end carryover⟧/)
})

test("session-start injects the brief BYTE-FOR-BYTE, with a compaction-specific lead", () => {
  const dir = newProject()
  // Deliberately awkward content: markdown, a quote, and trailing whitespace must all survive.
  const brief = '# Brief\n\nRejected: retries — the human said "they just move the race".\n\tindented\n'
  writeBrief(dir, brief)
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))
  assert.ok(ctx.includes(brief), "the brief must appear verbatim, not reformatted")
  assert.match(ctx, /⟦carryover — restored after compaction⟧/)
  assert.match(ctx, /⟦end carryover⟧/)

  const resumed = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "resume" }))
  assert.ok(resumed.includes(brief))
  assert.match(resumed, /⟦carryover — restored on resume⟧/)
})

test("precompact emits PLAIN stdout (never JSON) so it reaches the summarizer's instructions", () => {
  const dir = newProject()
  writeBrief(dir, "the approach and why\n")
  const out = runHook(dir, ["--mode=precompact"], { session_id: SID, trigger: "auto" })
  assert.ok(out.includes("the approach and why"))
  // The PreCompact channel is the trimmed stdout itself; emitting JSON here would hand the
  // summarizer a blob of JSON as its instructions.
  assert.throws(() => JSON.parse(out), "precompact output must not be JSON")
  assert.doesNotMatch(out, /hookSpecificOutput/)
})

test("precompact stays silent when there is no brief", () => {
  const dir = newProject()
  assert.equal(runHook(dir, ["--mode=precompact"], { session_id: SID, trigger: "auto" }), "")
})

test("an oversized brief is clipped, and says so rather than silently truncating", () => {
  const dir = newProject()
  writeBrief(dir, "x".repeat(5000))
  const ctx = additionalContext(
    runHook(dir, ["--mode=session-start"], { session_id: SID, source: "startup" }, { FRAY_CARRYOVER_MAX_CHARS: "500" })
  )
  assert.match(ctx, /clipped at 500 characters/)
  assert.ok(!ctx.includes("x".repeat(600)), "content past the cap must not be injected")
})

test("every silence gate holds: project registration under fray, sub-agents, and the kill switch", () => {
  const dir = newProject()
  writeBrief(dir, "should never appear\n")
  const evt = { session_id: SID, source: "compact" }
  // The repo-local `.claude/settings.json` copy defers to the plugin one inside a fray worker,
  // so a fray session never gets the brief injected twice.
  assert.equal(runHook(dir, ["--mode=session-start", "--via=project"], evt, { FRAY_UI_THREAD: "some-thread" }), "")
  // …but it DOES fire for a plain claude session in the same repo.
  assert.notEqual(runHook(dir, ["--mode=session-start", "--via=project"], evt), "")
  // A sub-agent has its own short-lived context and no claim on the worker's brief.
  assert.equal(runHook(dir, ["--mode=session-start"], { ...evt, agent_id: "sub-1" }), "")
  assert.equal(runHook(dir, ["--mode=session-start"], evt, { FRAY_CARRYOVER: "off" }), "")
  // With no session id there is no key, and an unkeyed brief would bleed across sessions.
  assert.equal(runHook(dir, ["--mode=session-start"], { source: "compact" }, { CLAUDE_CODE_SESSION_ID: "" }), "")
})

test("the nudge tracks context GROWTH, not an absolute threshold or wall clock", () => {
  const dir = newProject()
  const stale = { FRAY_CARRYOVER_STALE_TOKENS: "60000" }
  const nudge = (tokens: number) =>
    runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: writeTranscript(dir, tokens) }, stale)

  // Early in a session there is nothing worth preserving yet.
  assert.equal(nudge(20_000), "", "below the threshold the hook must say nothing")

  // No brief at all → the baseline is zero, so the first nudge lands once the session is deep enough.
  const missing = additionalContext(nudge(70_000))
  assert.match(missing, /⟦carryover missing⟧/)
  assert.match(missing, /~70k tokens deep/)

  // Repeat nudges are spaced by the same interval rather than firing on every prompt.
  assert.equal(nudge(75_000), "", "a second nudge must not follow immediately")

  // Writing the brief rebases the baseline and buys a full interval of silence.
  writeBrief(dir, "now written\n")
  assert.equal(nudge(76_000), "", "a freshly written brief silences the nudge")
  assert.equal(nudge(120_000), "", "44k of growth is still under the interval")

  // …and once the context has genuinely moved on, it asks for a refresh.
  const restale = additionalContext(nudge(140_000))
  assert.match(restale, /⟦carryover stale⟧/)
  assert.match(restale, /grown by ~64k tokens/)
})

test("the nudge rebases when a human hand-edits the brief mid-session", () => {
  const dir = newProject()
  const stale = { FRAY_CARRYOVER_STALE_TOKENS: "10000" }
  const nudge = (tokens: number) =>
    runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: writeTranscript(dir, tokens) }, stale)

  writeBrief(dir, "v1\n")
  nudge(20_000)
  assert.notEqual(nudge(40_000), "", "stale after 20k of growth")

  // A hand edit is just an mtime change — the same signal an agent's Write produces.
  writeBrief(dir, "v2, edited by the human\n")
  const future = new Date(Date.now() + 1000)
  utimesSync(threadFile(dir, "carryover.md"), future, future)
  assert.equal(nudge(45_000), "", "an edit from any source rebases the baseline")
})

test("the nudge is silent when the transcript carries no readable usage", () => {
  const dir = newProject()
  const path = join(dir, "empty.jsonl")
  writeFileSync(path, "not json\n{}\n")
  assert.equal(runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: path }), "")
  // A missing transcript path must not throw either — the nudge is an optimization, silence is safe.
  assert.equal(runHook(dir, ["--mode=nudge"], { session_id: SID }), "")
})

test("the hook creates the thread directory so the agent's first Write lands", () => {
  const dir = mkdtempSync(join(tmpdir(), "carryover-bare-"))
  runHook(dir, ["--mode=session-start"], { session_id: SID, source: "startup" })
  // It must NOT create the file: absent is the signal the nudge reads as "never written".
  assert.throws(() => readFileSync(join(dir, ".fray", "threads", SID, "carryover.md"), "utf8"))
  assert.doesNotThrow(() => writeFileSync(join(dir, ".fray", "threads", SID, "carryover.md"), "ok\n"))
})

test("hooks.json registers all three carryover channels", () => {
  const raw = readFileSync(join(here, "../../../../cc-worker/hooks/hooks.json"), "utf8")
  const cfg = JSON.parse(raw) as Record<string, Record<string, { matcher?: string; hooks: { command: string }[] }[]>>
  const commandsFor = (event: string) =>
    (cfg.hooks[event] ?? []).flatMap((entry) => entry.hooks.map((h) => h.command))
  // SessionStart must cover compact AND the other three sources: a resumed or cleared session has
  // lost just as much context as a compacted one.
  for (const matcher of ["startup", "resume", "clear", "compact"]) {
    const entry = (cfg.hooks.SessionStart ?? []).find((e) => e.matcher === matcher)
    assert.ok(entry, `SessionStart must register a ${matcher} matcher`)
    assert.ok(
      entry.hooks.some((h) => h.command.includes("carryover.mjs") && h.command.includes("--mode=session-start")),
      `SessionStart:${matcher} must inject the carryover brief`
    )
  }
  for (const trigger of ["auto", "manual"]) {
    const entry = (cfg.hooks.PreCompact ?? []).find((e) => e.matcher === trigger)
    assert.ok(entry, `PreCompact must register a ${trigger} matcher`)
    assert.ok(entry.hooks.some((h) => h.command.includes("carryover.mjs") && h.command.includes("--mode=precompact")))
  }
  assert.ok(commandsFor("UserPromptSubmit").some((c) => c.includes("carryover.mjs") && c.includes("--mode=nudge")))
})
