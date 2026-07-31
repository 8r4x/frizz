import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { scratchpadContent, codexScratchpadHookConfig } from "./dispatch.ts"

// ---- scratchpad reinforcement hook (cc-worker/hooks/scratchpad.mjs) ----
// Keeps the ONE per-thread scratchpad written and re-grounded across compaction: it injects the pad's
// head back after a compaction/resume, hands it to the summarizer, and nudges when the context has
// moved on since the last write. These tests EXECUTE the real hook the way Claude Code does — argv
// flags, a JSON event on stdin, output on stdout — rather than asserting on its source, because the
// whole value of the hook is its wire behavior. Verified live against cli 2.1.220 as well: a real
// session quoted injected text with zero tool calls, `PreCompact:manual` logged status 0, and
// PostToolUse additionalContext reached the model mid-turn.

const here = dirname(fileURLToPath(import.meta.url))
const HOOK = join(here, "../../../../cc-worker/hooks/scratchpad.mjs")
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

function newProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "scratchpad-hook-"))
  mkdirSync(join(dir, ".fray", "threads", SID), { recursive: true })
  return dir
}

function padPath(dir: string): string {
  return join(dir, ".fray", "threads", SID, "scratch.md")
}

function writePad(dir: string, body: string): void {
  writeFileSync(padPath(dir), body)
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
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: dir,
      FRAY_UI_THREAD: "",
      FRAY_SCRATCHPAD_HOOK: "",
      ...env,
    },
  })
}

function additionalContext(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext as string
}

test("a fresh startup teaches the contract instead of echoing the pad's own skeleton", () => {
  const dir = newProject()
  // The real skeleton fray writes at dispatch — headings, orientation line, an empty task box.
  writePad(dir, scratchpadContent("some effort"))
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "startup" }))
  assert.match(ctx, /⟦scratchpad⟧/)
  assert.match(ctx, /is the CANONICAL document for this thread/)
  // Injecting an empty template back would be pure noise, and a fresh start has lost nothing.
  assert.doesNotMatch(ctx, /⟦end scratchpad⟧/)
  assert.doesNotMatch(ctx, /reground here/)
})

test("a written scratchpad's head is injected BYTE-FOR-BYTE after a compaction, with a re-read pointer", () => {
  const dir = newProject()
  const pad = '# Scratchpad\n\nRejected: retries — the human said "they just move the race".\n\tindented\n'
  writePad(dir, pad)
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))
  assert.ok(ctx.includes(pad), "the pad must appear verbatim, not reformatted")
  assert.match(ctx, /⟦scratchpad — reground here⟧/)
  assert.match(ctx, /RE-GROUND ON IT BEFORE DOING ANYTHING ELSE/, "the pad is the canonical record")
  assert.match(ctx, /re-read the full file/i, "injection is the floor; the pointer is the ceiling")
  assert.match(ctx, new RegExp(`\\.fray/threads/${SID}/scratch\\.md`))
  assert.match(ctx, /⟦end scratchpad⟧/)
})

test("a fresh startup does not pay for the pad — only the context-losing sources restore it", () => {
  const dir = newProject()
  writePad(dir, "# Scratchpad\n\nreal content here\n")
  const startup = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "startup" }))
  assert.doesNotMatch(startup, /⟦end scratchpad⟧/, "a brand-new session has lost nothing to restore")
  for (const source of ["compact", "resume", "clear"]) {
    const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source }))
    assert.match(ctx, /⟦end scratchpad⟧/, `${source} has lost context and must get the pad back`)
  }
})

test("precompact emits PLAIN stdout (never JSON) so it reaches the summarizer's instructions", () => {
  const dir = newProject()
  writePad(dir, "the approach and why\n")
  const out = runHook(dir, ["--mode=precompact"], { session_id: SID, trigger: "auto" })
  assert.ok(out.includes("the approach and why"))
  // Emitting JSON here would hand the summarizer a blob of JSON as its literal instructions.
  assert.throws(() => JSON.parse(out), "precompact output must not be JSON")
  assert.doesNotMatch(out, /hookSpecificOutput/)
  // An unwritten pad has nothing to preserve.
  writePad(dir, scratchpadContent("some effort"))
  assert.equal(runHook(dir, ["--mode=precompact"], { session_id: SID, trigger: "auto" }), "")
})

test("an oversized pad is clipped, and says so rather than silently truncating", () => {
  const dir = newProject()
  writePad(dir, "x".repeat(5000))
  const ctx = additionalContext(
    runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }, { FRAY_SCRATCHPAD_MAX_CHARS: "500" })
  )
  assert.match(ctx, /clipped at 500 characters/)
  assert.ok(!ctx.includes("x".repeat(600)), "content past the cap must not be injected")
})

test("every silence gate holds: project registration under fray, sub-agents, and the kill switch", () => {
  const dir = newProject()
  writePad(dir, "should never appear\n")
  const evt = { session_id: SID, source: "compact" }
  // The repo-local `.claude/settings.json` copy defers to the plugin one inside a fray worker.
  assert.equal(runHook(dir, ["--mode=session-start", "--via=project"], evt, { FRAY_UI_THREAD: "t" }), "")
  assert.notEqual(runHook(dir, ["--mode=session-start", "--via=project"], evt), "")
  // Load-bearing for the ONE-scratchpad rule: a sub-agent never acts against its dispatcher's pad.
  assert.equal(runHook(dir, ["--mode=session-start"], { ...evt, agent_id: "sub-1" }), "")
  assert.equal(runHook(dir, ["--mode=session-start"], evt, { FRAY_SCRATCHPAD_HOOK: "off" }), "")
  // …but a non-off value never disables it: absence means ON now.
  assert.notEqual(runHook(dir, ["--mode=session-start"], evt, { FRAY_SCRATCHPAD_HOOK: "maybe" }), "")
  // With no session id there is no key, and an unkeyed pad would bleed across sessions.
  assert.equal(runHook(dir, ["--mode=session-start"], { source: "compact" }, { CLAUDE_CODE_SESSION_ID: "" }), "")
})

test("the codex guard denies child access to the canonical root pad and leaves root/unrelated calls alone", () => {
  const dir = newProject()
  const relative = `.fray/threads/${SID}/scratch.md`
  const absolute = padPath(dir)
  const child = { session_id: "codex-rollout-id", agent_id: "/root/reviewer", hook_event_name: "PreToolUse" }

  for (const toolEvent of [
    { tool_name: "apply_patch", tool_input: { patch: `*** Delete File: ${absolute}` } },
    { tool_name: "exec_command", tool_input: { cmd: `cat > ${relative} <<'EOF'\nchild state\nEOF` } },
    { tool_name: "exec_command", tool_input: { cmd: `cat ${relative}` } },
  ]) {
    const out = JSON.parse(runHook(dir, [`--session=${SID}`, "--mode=guard"], { ...child, ...toolEvent }))
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse")
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny")
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /belongs to the top-level \/root worker/)
  }

  assert.equal(
    runHook(dir, [`--session=${SID}`, "--mode=guard"], {
      ...child,
      tool_name: "exec_command",
      tool_input: { cmd: "git status --short" },
    }),
    "",
    "a child's unrelated tool calls are not the guard's concern"
  )
  assert.equal(
    runHook(dir, [`--session=${SID}`, "--mode=guard"], {
      session_id: "codex-rollout-id",
      tool_name: "apply_patch",
      tool_input: { patch: `*** Delete File: ${absolute}` },
    }),
    "",
    "the top-level root owns the pad and remains able to maintain it"
  )
})

test("the nudge tracks context GROWTH, not an absolute threshold or wall clock", () => {
  const dir = newProject()
  const stale = { FRAY_SCRATCHPAD_STALE_TOKENS: "60000" }
  const nudge = (tokens: number) =>
    runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: writeTranscript(dir, tokens) }, stale)

  assert.equal(nudge(20_000), "", "below the threshold the hook must say nothing")

  // An unwritten pad measures growth from ZERO — the whole session is unpersisted.
  const empty = additionalContext(nudge(70_000))
  assert.match(empty, /⟦scratchpad empty⟧/)
  assert.match(empty, /~70k tokens deep/)

  assert.equal(nudge(75_000), "", "a second nudge must not follow immediately")

  writePad(dir, "now written with real content\n")
  assert.equal(nudge(76_000), "", "a fresh write silences the nudge")
  assert.equal(nudge(120_000), "", "44k of growth is still under the interval")

  const restale = additionalContext(nudge(140_000))
  assert.match(restale, /⟦scratchpad stale⟧/)
  assert.match(restale, /grown ~64k tokens/)
})

test("the mid-turn channel reports itself as PostToolUse so the harness accepts the injection", () => {
  const dir = newProject()
  const out = runHook(
    dir,
    ["--mode=nudge", "--event=PostToolUse"],
    { session_id: SID, transcript_path: writeTranscript(dir, 90_000) },
    { FRAY_SCRATCHPAD_STALE_TOKENS: "60000" }
  )
  // A fray worker runs enormous autonomous turns; a turn-boundary-only nudge can miss a whole
  // session's work. The event name must match the firing hook or the payload is rejected.
  assert.equal(JSON.parse(out).hookSpecificOutput.hookEventName, "PostToolUse")
  assert.match(additionalContext(out), /⟦scratchpad empty⟧/)
})

test("both nudge channels share one interval, so mid-turn firing does not multiply reminders", () => {
  const dir = newProject()
  const stale = { FRAY_SCRATCHPAD_STALE_TOKENS: "60000" }
  const t = (tokens: number) => ({ session_id: SID, transcript_path: writeTranscript(dir, tokens) })

  assert.notEqual(runHook(dir, ["--mode=nudge", "--event=PostToolUse"], t(70_000), stale), "", "first fires")
  // The turn-boundary channel must respect the budget the mid-turn channel just spent.
  assert.equal(runHook(dir, ["--mode=nudge"], t(75_000), stale), "", "shared state suppresses the sibling")
  assert.equal(runHook(dir, ["--mode=nudge", "--event=PostToolUse"], t(80_000), stale), "")
})

test("the nudge rebases when a human hand-edits the pad mid-session", () => {
  const dir = newProject()
  const stale = { FRAY_SCRATCHPAD_STALE_TOKENS: "10000" }
  const nudge = (tokens: number) =>
    runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: writeTranscript(dir, tokens) }, stale)

  writePad(dir, "v1 with content\n")
  nudge(20_000)
  assert.notEqual(nudge(40_000), "", "stale after 20k of growth")

  writePad(dir, "v2, edited by the human\n")
  const future = new Date(Date.now() + 1000)
  utimesSync(padPath(dir), future, future)
  assert.equal(nudge(45_000), "", "an edit from any source rebases the baseline")
})

test("the nudge is silent when the transcript carries no readable usage", () => {
  const dir = newProject()
  const path = join(dir, "empty.jsonl")
  writeFileSync(path, "not json\n{}\n")
  assert.equal(runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: path }), "")
  assert.equal(runHook(dir, ["--mode=nudge"], { session_id: SID }), "")
})

test("hooks.json wires every channel, and no stale carryover registration survives", () => {
  const raw = readFileSync(join(here, "../../../../cc-worker/hooks/hooks.json"), "utf8")
  assert.doesNotMatch(raw, /carryover/, "the separate carryover doc was collapsed into the scratchpad")
  const cfg = JSON.parse(raw) as Record<string, Record<string, { matcher?: string; hooks: { command: string }[] }[]>>
  const commandsFor = (event: string) =>
    (cfg.hooks[event] ?? []).flatMap((entry) => entry.hooks.map((h) => h.command))

  for (const matcher of ["startup", "resume", "clear", "compact"]) {
    const entry = (cfg.hooks.SessionStart ?? []).find((e) => e.matcher === matcher)
    assert.ok(entry, `SessionStart must register a ${matcher} matcher`)
    assert.ok(entry.hooks.some((h) => h.command.includes("scratchpad.mjs") && h.command.includes("--mode=session-start")))
  }
  for (const trigger of ["auto", "manual"]) {
    const entry = (cfg.hooks.PreCompact ?? []).find((e) => e.matcher === trigger)
    assert.ok(entry, `PreCompact must register a ${trigger} matcher`)
    assert.ok(entry.hooks.some((h) => h.command.includes("scratchpad.mjs") && h.command.includes("--mode=precompact")))
  }
  assert.ok(commandsFor("UserPromptSubmit").some((c) => c.includes("scratchpad.mjs") && c.includes("--mode=nudge")))
  // The mid-turn channel must be UNMATCHED (every tool), not scoped to one tool name.
  const midTurn = (cfg.hooks.PostToolUse ?? []).find((e) =>
    e.hooks.some((h) => h.command.includes("scratchpad.mjs"))
  )
  assert.ok(midTurn, "PostToolUse must carry the mid-turn nudge")
  assert.equal(midTurn.matcher, undefined, "the mid-turn nudge must fire after every tool call")
  assert.ok(midTurn.hooks.some((h) => h.command.includes("--event=PostToolUse")))
})

// ---- backend parity: the CODEX delivery path ----
// Codex cannot be gated the way Claude is. Measured against codex-cli 0.144.6:
//   • `codex exec` runs NO hooks from any discovery path — only the app-server does, and only when
//     the hooks arrive as per-conversation config overrides (with bypass_hook_trust).
//   • The app-server daemon is SHARED per project, so its environment cannot carry a per-conversation
//     decision — hence `--enabled` rather than the env var.
//   • Codex reports its OWN rollout session id to the hook, not fray's thread id — hence `--session`.
// Verified live: SessionStart / UserPromptSubmit / Stop all fired through CodexAppServerBridge with
// the real scratchpad.mjs wired exactly as codexScratchpadHookConfig wires it.

test("re-grounding is UNCONDITIONAL — no setting, no flag, no env var required", () => {
  const dir = newProject()
  writePad(dir, "# Scratchpad\n\ncanonical content\n")
  // No opt-in of any kind: the pad is the canonical document, so a compacted worker always gets it
  // back. An earlier revision gated this behind a default-OFF setting, which meant the DEFAULT worker
  // recovered nothing after a compaction — the exact failure the pad exists to prevent.
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))
  assert.match(ctx, /⟦scratchpad — reground here⟧/)
  assert.match(ctx, /canonical content/)
  // The only escape hatch is an explicit env off — a one-off, not a project posture.
  assert.equal(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }, { FRAY_SCRATCHPAD_HOOK: "off" }), "")
})

test("an EMPTY pad still re-grounds after compaction, and says the pad is empty", () => {
  const dir = newProject()
  writePad(dir, scratchpadContent("some effort"))
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))
  // "You lost your context and your pad is empty" is the most urgent thing the next turn can hear —
  // staying silent here was the old behavior and it left the worker with nothing.
  assert.match(ctx, /⟦scratchpad — reground here⟧/)
  assert.match(ctx, /absent or has nothing substantive in it/)
  assert.match(ctx, /That exact path is authoritative/)
  assert.match(ctx, /do not search other `\.fray\/threads\/\*\/scratch\.md` files/)
  assert.match(ctx, /retained compaction summary/)
})

test("--session overrides the reported id, so a codex worker finds FRAY's pad and not its own", () => {
  const dir = newProject()
  writePad(dir, "# Scratchpad\n\nfray thread content\n")
  // Exactly what codex sends: its own rollout session id, and a transcript under ~/.codex/sessions.
  const codexEvent = {
    session_id: "019fb427-93aa-7ab0-91af-436173f99bc4",
    source: "compact",
    hook_event_name: "SessionStart",
    transcript_path: "/Users/x/.codex/sessions/2026/07/30/rollout-019fb427.jsonl",
  }
  // Without --session the hook addresses codex's id — a path that does not exist — so it can only
  // fall back to the contract text.
  const derived = additionalContext(runHook(dir, ["--mode=session-start"], codexEvent))
  assert.doesNotMatch(derived, /fray thread content/)
  // With it, the real pad is found and restored.
  const explicit = additionalContext(
    runHook(dir, [`--session=${SID}`, "--mode=session-start"], codexEvent)
  )
  assert.match(explicit, /fray thread content/)
  assert.match(explicit, new RegExp(`\\.fray/threads/${SID}/scratch\\.md`))
})

test("a codex rollout carries no readable claude usage, so the nudge degrades to silence", () => {
  const dir = newProject()
  writePad(dir, "content\n")
  const rollout = join(dir, "rollout.jsonl")
  // The real codex rollout shape — event_msg/payload, not claude's message.usage.
  writeFileSync(
    rollout,
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hi" } }) + "\n"
  )
  // Silence, never a crash and never a bogus token count: the codex nudge channel simply does not
  // fire until a rollout-aware token parser exists. The codex INJECTION channel is unaffected.
  assert.equal(runHook(dir, [`--session=${SID}`, "--mode=nudge"], { session_id: SID, transcript_path: rollout }), "")
})

// ---- codex delivery is unconditional too ----

test("the codex hook config is built unconditionally, and carries what codex requires", () => {
  // No plugin path or no session id must still produce nothing rather than a broken command.
  assert.deepEqual(codexScratchpadHookConfig(undefined, "sid-1"), {})
  assert.deepEqual(codexScratchpadHookConfig("/p/scratchpad.mjs", ""), {})

  const cfg = codexScratchpadHookConfig("/p/scratchpad.mjs", "sid-1") as {
    bypass_hook_trust?: boolean
    hooks?: Record<string, { hooks: { command: string }[] }[]>
  }
  // Codex silently SKIPS untrusted hook definitions, so without this the config is delivered and ignored.
  assert.equal(cfg.bypass_hook_trust, true)
  // Codex exposes no PreCompact/PostCompact wire type, so summarizer steering stays Claude-only.
  // PreToolUse carries the root-pad ownership guard; the remaining events inject or nudge.
  assert.deepEqual(Object.keys(cfg.hooks ?? {}).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "UserPromptSubmit"])
  for (const entries of Object.values(cfg.hooks ?? {})) {
    const cmd = entries[0].hooks[0].command
    assert.match(cmd, /--session="sid-1"/, "fray's thread id must override codex's own reported session id")
    assert.doesNotMatch(cmd, /--enabled/, "there is no opt-in flag any more")
    assert.match(cmd, /scratchpad\.mjs/)
  }
  assert.match(cfg.hooks?.PreToolUse?.[0]?.hooks[0]?.command ?? "", /--mode=guard/)
})
