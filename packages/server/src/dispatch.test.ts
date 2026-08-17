import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DISPATCH_TASK_BANNER_MARKER } from "@frizz/shared"
import { buildClaudeCommand, loadWorkerPrompt, composePrompt, monitorScriptsDir, resolveWorkerPluginDir, scratchpadOrientation, workerPluginDir, frizzConfigBlock, workerDispatchPermission, WORKER_DISPATCH_PERMISSION } from "./dispatch.ts"
import { parseTranscript } from "./transcript.ts"
import { CHROME_DEVTOOLS_MCP, FRIZZ_MCP } from "./backend/types.ts"

// ---- Backend-aware worker contract (worker-contract-backend-aware) ----
// loadWorkerPrompt(kind) delegates to buildWorkerPrompt in workerPrompt.ts (a single compiled-in TS
// source, no runtime markdown/marker fill). The CLAUDE output must still reproduce the pre-split
// contract BYTE-FOR-BYTE (the regression bar); the CODEX output has its own golden.

const here = dirname(fileURLToPath(import.meta.url))
// The FROZEN pre-split claude contract body (the exact string a claude dispatch got before the split).
// Regenerate ONLY when the shipped claude contract is deliberately changed — an unexpected diff here is
// a regression (a core/claude-fragment edit that altered what a claude worker receives).
// The markdown loader trims the contract body; normalize the fixture's conventional POSIX newline
// before making the byte-for-byte comparison of the actual prompt content.
const CLAUDE_GOLDEN = readFileSync(join(here, "WORKER_PROMPT.claude.golden.txt"), "utf8").trimEnd()
const CODEX_GOLDEN = readFileSync(join(here, "WORKER_PROMPT.codex.golden.txt"), "utf8").trimEnd()
const SESSION_SEED = readFileSync(join(here, "../../../cc-worker/hooks/session-seed.mjs"), "utf8")

test("loadWorkerPrompt: default kind is claude", () => {
  assert.equal(loadWorkerPrompt(), loadWorkerPrompt("claude"))
})

test("Claude dispatch supplies the discovered worker plugin via --plugin-dir", () => {
  const plugin = workerPluginDir()
  assert.ok(plugin, "the packaged worker plugin must be discoverable")
  assert.doesNotThrow(() => readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"))
  const argv = buildClaudeCommand({
    sessionId: "plugin-dispatch",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    pluginDir: plugin,
  })
  assert.deepEqual(argv.slice(argv.indexOf("--plugin-dir"), argv.indexOf("--plugin-dir") + 2), ["--plugin-dir", plugin])
})

test("Claude dispatch mounts chrome-devtools + the unified frizz MCP server and pre-approves both", () => {
  const argv = buildClaudeCommand({
    sessionId: "mcp-dispatch",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    frizzMcp: { scriptPath: "/abs/plugin/bin/frizz-mcp.mjs", stateDir: "/home/.frizz/projects/pid" },
  })
  const cfgRaw = argv[argv.indexOf("--mcp-config") + 1]
  assert.ok(cfgRaw, "argv must carry an inline --mcp-config")
  const cfg = JSON.parse(cfgRaw)
  // Chrome DevTools rides EVERY dispatch (runtime-gate browser QA, parity with the codex `-c`
  // injection — both derive from the canonical CHROME_DEVTOOLS_MCP spec).
  assert.deepEqual(cfg.mcpServers[CHROME_DEVTOOLS_MCP.name], {
    command: CHROME_DEVTOOLS_MCP.command,
    args: [...CHROME_DEVTOOLS_MCP.args],
  })
  assert.deepEqual(cfg.mcpServers[FRIZZ_MCP.name], {
    command: process.execPath, // absolute node path, not bare "node" (worker PATH-independence)
    args: ["/abs/plugin/bin/frizz-mcp.mjs"],
    env: { FRIZZ_STATE_DIR: "/home/.frizz/projects/pid" },
  })
  // No FRIZZ_PROJECT_ID here because this descriptor carries none: the id is stamped by the SERVER at
  // spawn, from the worker's own project, and is never a tool argument — which is what makes "spawn a
  // thread on another project's board" unexpressible rather than merely discouraged. The same reason
  // FRIZZ_THREAD_SLUG is env-only.
  // Tools are pre-approved so a headless worker never blocks on a permission prompt. One comma-joined
  // EQUALS-form token: --allowedTools is variadic, so a space-separated value could swallow a
  // following positional (the prompt) — the equals form binds exactly one token. BOTH rules are
  // SERVER-level, so a tool added to either server needs no allow-list edit.
  assert.ok(argv.includes("--allowedTools=mcp__chrome-devtools,mcp__frizz"))
  // The prompt stays the trailing positional (flags never displace it).
  assert.equal(argv[argv.length - 1], "test")
})

test("Claude dispatch stamps the singleton's lock path and the worker's OWN project into the frizz MCP env", () => {
  const argv = buildClaudeCommand({
    sessionId: "mcp-tenant",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    frizzMcp: {
      scriptPath: "/abs/plugin/bin/frizz-mcp.mjs",
      stateDir: "/home/.frizz/projects/tenant",
      serverLock: "/home/.frizz/projects/launcher/server.lock",
      projectId: "b47f4055-4262-432a-af18-ded4cbfb3071",
    },
  })
  const cfg = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]!)
  // One process serves N projects and writes ONE lock (the launcher's), so a tenant's worker is told
  // where that lock is; and the RPC it POSTs is prefixed with its own project, because unprefixed
  // means the LAUNCHING project — the difference between spawning onto your board and onto someone
  // else's. Neither value is derivable inside the worker, and neither is a tool argument.
  assert.deepEqual(cfg.mcpServers[FRIZZ_MCP.name].env, {
    FRIZZ_STATE_DIR: "/home/.frizz/projects/tenant",
    FRIZZ_SERVER_LOCK: "/home/.frizz/projects/launcher/server.lock",
    FRIZZ_PROJECT_ID: "b47f4055-4262-432a-af18-ded4cbfb3071",
  })
})

test("Claude dispatch still mounts + pre-approves chrome-devtools when no frizz-MCP descriptor is supplied", () => {
  const argv = buildClaudeCommand({ sessionId: "no-mcp", permissionMode: "auto", prompt: "test", workerPrompt: "" })
  const cfg = JSON.parse(argv[argv.indexOf("--mcp-config") + 1])
  assert.deepEqual(Object.keys(cfg.mcpServers), [CHROME_DEVTOOLS_MCP.name])
  assert.ok(argv.includes("--allowedTools=mcp__chrome-devtools"))
})

test("Claude worker surfaces share the canonical per-session scratch DIRECTORY path", () => {
  const sessionId = "scratch-canonical"
  const canonical = `.frizz/threads/${sessionId}/`
  assert.match(composePrompt(sessionId, "task", "claude"), new RegExp(canonical.replaceAll("/", "\\/")))
  assert.match(scratchpadOrientation(sessionId, null, "claude"), new RegExp(canonical.replaceAll("/", "\\/")))
  assert.match(SESSION_SEED, /\.frizz\/threads\//)
  // No surface may resurrect the canonical filename: nothing reserves a name in that directory now.
  assert.doesNotMatch(composePrompt(sessionId, "task", "claude"), /scratch\.md/)
  assert.doesNotMatch(scratchpadOrientation(sessionId, null, "claude"), /scratch\.md/)
  assert.doesNotMatch(SESSION_SEED, /scratch\.md/)
  assert.doesNotMatch(SESSION_SEED, /\.frizz\/scratch\//)
})

// ---- FRIZZ.md project-config injection (defer-to-project-norms) ----
// A repo-committed FRIZZ.md at the project root is injected into the worker SYSTEM prompt under an
// "overrides frizz defaults" header, so a project's own norms win over frizz's built-in defaults.
test("frizzConfigBlock: absent FRIZZ.md injects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-absent-"))
  assert.equal(frizzConfigBlock(dir), "")
})

test("frizzConfigBlock: empty/whitespace FRIZZ.md injects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-empty-"))
  writeFileSync(join(dir, "FRIZZ.md"), "\n  \n")
  assert.equal(frizzConfigBlock(dir), "")
})

test("frizzConfigBlock: present FRIZZ.md is wrapped in an overrides-frizz-defaults header", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-present-"))
  const body = "## Our norms\n- Gates: `pnpm check`\n- Skip adversarial review on small UI diffs."
  writeFileSync(join(dir, "FRIZZ.md"), body + "\n")
  const block = frizzConfigBlock(dir)
  assert.match(block, /PROJECT FRIZZ CONFIG \(from this repo's FRIZZ\.md\)/)
  // Header is scoped to PROCESS defaults and explicitly does NOT relax the frizz-mechanical contract —
  // so a FRIZZ.md can't contradict the "Defer" section's non-negotiable browser/signal gates.
  assert.match(block, /OVERRIDE the frizz worker PROCESS defaults above/)
  assert.match(block, /do NOT relax the frizz-mechanical contract/)
  assert.ok(block.includes(body), "the FRIZZ.md body must be present verbatim")
})

test("frizzConfigBlock: an over-cap FRIZZ.md content is clipped with a truncation marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-clip-"))
  writeFileSync(join(dir, "FRIZZ.md"), "x".repeat(50_000)) // > 12k chars, < 64KB → read then clipped
  const block = frizzConfigBlock(dir)
  assert.match(block, /\[FRIZZ\.md truncated\]/)
  assert.ok(block.length < 20_000, "the injected block must stay within the system-prompt budget")
})

test("frizzConfigBlock: a runaway (>64KB) FRIZZ.md is rejected unread, not slurped", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-runaway-"))
  writeFileSync(join(dir, "FRIZZ.md"), "x".repeat(200_000)) // exceeds the read-size guard
  assert.equal(frizzConfigBlock(dir), "")
})

test("frizzConfigBlock: a non-regular FRIZZ.md (a directory) injects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-dir-"))
  mkdirSync(join(dir, "FRIZZ.md"))
  assert.equal(frizzConfigBlock(dir), "")
})

test("frizzConfigBlock composes AFTER the worker contract (override position) in the system prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-order-"))
  writeFileSync(join(dir, "FRIZZ.md"), "PROJECT-NORM-SENTINEL")
  const sessionId = "frizz-md-order"
  const system = [loadWorkerPrompt("claude"), scratchpadOrientation(sessionId, null, "claude"), frizzConfigBlock(dir)]
    .filter(Boolean)
    .join("\n\n")
  assert.ok(system.indexOf("PROJECT-NORM-SENTINEL") > system.indexOf("Defer to the project's own norms"))
})

test("artifact worker resolver finds runtime/cc-worker through pnpm's nested module store", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-worker-plugin-resolver-"))
  const runtime = join(root, "runtime")
  const module = join(runtime, "node_modules", ".pnpm", "@frizz+server@fixture", "node_modules", "@frizz", "server", "src", "dispatch.js")
  const plugin = join(runtime, "cc-worker")
  mkdirSync(dirname(module), { recursive: true })
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true })
  writeFileSync(module, "export {}\n")
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}\n")
  assert.equal(resolveWorkerPluginDir(pathToFileURL(module).href, {}), plugin)
})

test("loadWorkerPrompt(claude) is BYTE-IDENTICAL to the pre-split contract (the regression bar)", () => {
  assert.equal(loadWorkerPrompt("claude"), CLAUDE_GOLDEN)
})

// The codex contract prints the ABSOLUTE path of the bundled CI/review monitors, which differs per
// checkout — so the golden keeps the unfilled token and the comparison substitutes it back. The fill
// itself is pinned separately below.
test("loadWorkerPrompt(codex) is BYTE-IDENTICAL to its golden (regenerate on deliberate codex edits)", () => {
  const monitors = monitorScriptsDir()
  const normalized = monitors ? loadWorkerPrompt("codex").replaceAll(monitors, "{{FRIZZ_MONITORS_DIR}}") : loadWorkerPrompt("codex")
  assert.equal(normalized, CODEX_GOLDEN)
})

// Codex has no skills and no plugin, so "use the bundled monitors" is only actionable as a path it can
// actually open — an unresolvable one used to be the reason the model wrote its own short-poll loop.
test("the codex contract names the bundled monitors by a path that exists", () => {
  const dir = monitorScriptsDir()
  assert.ok(dir, "the worker plugin ships the portable monitors; resolving it must not fail in the repo")
  assert.ok(existsSync(join(dir!, "ci-watch.mjs")))
  assert.ok(existsSync(join(dir!, "review-watch.mjs")))
  const escaped = dir!.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
  assert.match(loadWorkerPrompt("codex"), new RegExp(`node ${escaped}/ci-watch\\.mjs `))
  assert.match(loadWorkerPrompt("codex"), new RegExp(`node ${escaped}/review-watch\\.mjs `))
})

// The contract must govern RESTING, not just asking. Before this, `The stop criterion` covered only
// when to ask a human — so a worker that finished part one of a two-part instruction, wrote it up and
// rested was doing something no rule addressed, and the write-up templates made it feel correct.
test("both contracts forbid resting while the instruction still has parts left", () => {
  for (const kind of ["claude", "codex"] as const) {
    const c = loadWorkerPrompt(kind).replace(/\s+/g, " ")
    assert.match(c, /COMING TO REST IS A STOP/, `${kind}: resting must be governed like a question`)
    assert.match(c, /do not write up — do the next part in this same turn/, `${kind}: must name the remedy`)
    assert.match(c, /Recording work is not doing work/, `${kind}: must close the scratchpad loophole`)
    assert.match(c, /IT IS OPTIONAL, IT IS NOT A DELIVERABLE/, `${kind}: the pad must read as optional`)
  }
})

test("loadWorkerPrompt: no unresolved {{FRIZZ_*}} markers survive in either backend's contract", () => {
  assert.doesNotMatch(loadWorkerPrompt("claude"), /\{\{FRIZZ_/)
  assert.doesNotMatch(loadWorkerPrompt("codex"), /\{\{FRIZZ_/)
})

test("loadWorkerPrompt(claude) carries the Claude-Code-only guidance", () => {
  const raw = loadWorkerPrompt("claude")
  const c = raw.replace(/\s+/g, " ") // pin content, not line-wrap
  assert.match(c, /a top-level `claude` session/)
  assert.match(c, /`claude -r`/)
  assert.match(c, /## Sub-agents/)
  assert.match(c, /plain Agent tool \+ `run_in_background: true`/)
  assert.match(c, /namespaced string `frizz:<model>-<effort>`/)
  assert.match(c, /name your scratch directory and the OWN FILE it should write there/)
  // Claude frizz workers have NO fork option (`subagent_type: "fork"` does not resolve); say so
  // explicitly so a worker never blocks hunting for one — the codex fork_context failure mode.
  assert.match(c, /There is NO fork\/inherit option here/)
  assert.match(c, /absence of a fork switch is NOT a blocker to report/)
  assert.match(c, /## Automated waits in Claude Code/)
  assert.match(c, /`Monitor`/)
  assert.match(c, /`persistent: true`/)
  assert.match(c, /TaskOutput[\s\S]{0,80}deprecated/)
  assert.match(c, /`Read` on that output path/)
})

test("loadWorkerPrompt(codex) OMITS every Claude-Code-only construct a codex worker can't use", () => {
  const c = loadWorkerPrompt("codex")
  // No Claude session/wake, no Agent tool, no frizz profiles, no sub-agent blackboard framing.
  assert.doesNotMatch(c, /claude session/)
  assert.doesNotMatch(c, /claude -r/)
  assert.doesNotMatch(c, /## Sub-agents/)
  assert.doesNotMatch(c, /Agent tool/)
  assert.doesNotMatch(c, /run_in_background/)
  assert.doesNotMatch(c, /frizz:<model>-<effort>/)
  assert.doesNotMatch(c, /frizz:opus/)
  assert.doesNotMatch(c, /blackboard/)
})

test("loadWorkerPrompt(codex) carries codex's OWN session/wake + model/effort/sandbox framing", () => {
  const c = loadWorkerPrompt("codex")
  assert.match(c, /a top-level `codex` session/)
  assert.match(c, /`codex resume`/)
  assert.match(c, /## Own one task/)
  assert.match(c, /not the dashboard's portfolio orchestrator/)
  assert.match(c, /Work solo unless the TASK or a later human follow-up explicitly asks/)
  assert.match(c, /## Bounded native delegation/)
  assert.match(c, /### CI\/review monitor selection/)
  assert.match(c, /project-local `AGENTS\.md`/)
  assert.match(c, /terminal event\/exit semantics/)
  assert.match(c, /never silently shadow it with Frizz/)
  assert.match(c, /persistent `exec_command` \/ `write_stdin` session/)
  assert.match(c, /Luna child is optional\nonly/)
  assert.match(c, /active native spawn tool/)
  assert.match(c, /configured namespace is `frizz`/)
  assert.match(c, /context-fork control/)
  // Both directions must be teachable: fresh for clean-room/adversarial, fork when the child
  // genuinely continues the parent's reasoning. An unset control silently forks EVERYTHING.
  assert.match(c, /Pass NO parent history \(`fork_turns: "none"`\) for an INDEPENDENT/)
  assert.match(c, /FORK instead \(`fork_turns: "all"`/)
  assert.match(c, /schema default is a FULL fork/)
  assert.match(c, /`gpt-5\.6-luna` \+ `medium`/)
  assert.match(c, /`gpt-5\.6-terra` \+ `medium`/)
  assert.match(c, /`gpt-5\.6-sol` \+ `high` or `xhigh`/)
  assert.match(c, /Before any Sol or xhigh spawn/)
  assert.match(c, /why Terra \+ medium is inadequate/)
  assert.doesNotMatch(c, /do that work INLINE yourself/)
  // The effort enum must match what frizz actually sends codex: codexEffort (backend/codex.ts) passes
  // the complete outer universe through; the selected model gates which levels it accepts.
  assert.match(c, /reasoning effort \(low \/ medium \/ high \/ xhigh \/ max \/ ultra\)/)
  assert.match(c, /read-only/)
  assert.match(c, /workspace-write/)
  assert.match(c, /danger-full-access/)
  assert.match(c, /## Automated waits in Codex/)
  assert.match(c, /persistent `exec_command` \/\n`write_stdin` monitor session/)
  assert.match(c, /`write_stdin`/)
  assert.match(c, /partial\n?`gh pr checks` rollup is not a CI-green verdict/)
  assert.match(c, /`ACTION_REQUIRED` fork gates as pending/)
})

test("loadWorkerPrompt(codex) requests exactly one first-output invisible title comment", () => {
  const c = loadWorkerPrompt("codex")
  assert.match(c, /## Thread title signal/)
  assert.match(c, /<!-- frizz title="Fix queue focus" -->/)
  assert.match(c, /very FIRST assistant message/)
  assert.match(c, /before any[\s\S]*commentary[\s\S]*tool call/)
  assert.match(c, /3-8 word title/)
  assert.match(c, /strips this comment from visible chat/)
  assert.match(c, /human rename always wins/)
  assert.match(c, /Never use an H1\nfor the title signal/)
  assert.doesNotMatch(loadWorkerPrompt("claude"), /<!-- frizz-title:/)
})

test("loadWorkerPrompt(codex) never turns an ordinary thread label into unconditional fan-out", () => {
  const c = loadWorkerPrompt("codex")
  assert.doesNotMatch(c, /Fan out one sub-agent per independent prong/)
  assert.doesNotMatch(c, /re-verified; fan out and loop/)
  assert.doesNotMatch(c, /Draft the plan → dispatch a critic sub-agent/)
  assert.doesNotMatch(c, /dispatch fresh-context reviewer\(s\) on the diff/)
  assert.match(c, /the audit label alone does not authorize fan-out/)
  assert.match(c, /Add fresh-context reviewer agents only under the explicit delegation policy/)
})

test("loadWorkerPrompt: the backend-AGNOSTIC core is present in BOTH contracts", () => {
  for (const kind of ["claude", "codex"] as const) {
    const raw = loadWorkerPrompt(kind)
    // Whitespace-normalized: these pin CONTENT, not line-wrap. Reflowing a paragraph must not fail the
    // suite (the 2026-07-25 restructure broke ~15 assertions purely on rewrapped lines).
    const c = raw.replace(/\s+/g, " ")
    for (const fence of [/```done/, /```awaiting/, /```question/]) assert.match(raw, fence) // fence grammar
    if (kind === "codex") assert.match(raw, /## Thread types/) // claude's lean contract drops it
    assert.match(raw, /## Git discipline/)
    assert.match(raw, /## Quality bar/)
    assert.match(raw, /## The stop criterion/)
    // THE CURRENT AWAITING GRAMMAR (2026-08-15): structural lines only. `human:` used to be pinned here;
    // it is deleted, because it parked a thread in Held and nothing ever fired it. Waiting on a person is
    // a ```question now, and this asserts the contract says so rather than merely omitting the old kind.
    assert.match(c, /shell: bzvtnt3ig/)
    assert.match(c, /for: 2h/)
    assert.match(c, /reason:/)
    assert.doesNotMatch(c, /human:/, "the human gate must not come back")
    // `timer:` NAMES A ROW NOW, never an instant. The instant grammar is deleted: one was written 5h55m
    // in the past, parsed, armed nothing, and stalled its thread for 5.5 hours (2026-08-15).
    assert.match(c, /timer: tmr_/)
    assert.doesNotMatch(c, /timer: <ISO-8601 instant>/, "the instant grammar must not come back")
    // The legacy compatibility note is gone with the kinds it described; the contract states the six
    // structural lines and nothing else, so there is no "never emit these" footnote left to carry.
    assert.doesNotMatch(c, /remain parser compatibility/)
    assert.match(raw, /## Agent completion invariant/)
    assert.match(c, /let it run to its terminal return/)
    assert.match(c, /partially applied edits, tests, and owned processes/)
    assert.match(c, /only the affected service, never by stopping a writer/)
    assert.match(c, /!\[descriptive alt\]\(\/absolute\/path\.png\)/)
    assert.match(c, /eligible absolute local image paths through its guarded local-image proxy/)
  }
})

test("awaiting re-entry: every worker-contract surface requires a fresh fence after a follow-up", () => {
  // This is deliberately pinned across the shipped backend contracts (the single source — the former
  // frizz:worker skill copy was deleted; session-seed is a slim pointer, see its own test). A
  // human turn clears lastFence in the tailer, so merely saying "already parked" cannot restore the
  // state: the worker must make a fresh decision, then repeat a current human/timer fence or re-arm
  // the active backend wait for an automatable condition.
  for (const raw of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    const c = raw.replace(/\s+/g, " ") // pin content, not line-wrap
    // NAME THE PR ON EVERY REST. The human reads these as a queue of cards from a dozen threads, and one
    // that says "pushed the fix, CI is green" without a number cannot be placed without opening it
    // (maintainer 2026-08-16: "I keep being unclear what PR is being implemented in a given chat").
    assert.match(c, /NAME THE PULL REQUEST, EVERY TIME YOU REST/)
    assert.match(c, /EVERY resting message, not just the one where it first appeared/)
    assert.match(c, /No PR yet.{0,40}say what the work is against instead/)
    assert.match(c, /back to awaiting/)
    assert.match(c, /already parked/)
    assert.match(c, /emit a FRESH fence/)
    // The six structural lines, in order, and nothing between them a worker could mistake for prose.
    assert.match(c, /shell:[^\n]*agent:[^\n]*timer:[^\n]*pr:[^\n]*for:[^\n]*reason:/)
    assert.match(c, /automatable[\s\S]{0,100}(?:arm|re-arm)/i)
  }
})

test("end-state contract: a fenceless rest is a DEFECT, done checks, awaiting parks on checked items", () => {
  // Whitespace-normalized throughout: these pin the RULES, not the line-wrap.
  for (const raw of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    const c = raw.replace(/\s+/g, " ")
    // REVERSED 2026-08-12. A bare rest used to be "the ordinary handoff"; it is now the one outcome
    // frizz actively corrects (scheduler SOURCE 9), so the contract must not still bless it — a
    // reminder that contradicts the system prompt teaches nothing.
    assert.match(c, /ALWAYS SIGN OFF WITH A FENCE/)
    assert.match(c, /bare rest[\s\S]{0,60}item nobody can triage/i)
    assert.doesNotMatch(c, /bare rest[^.]*ordinary handoff/i)
    // Still says WHERE a fenceless rest lands — the worker has to know the cost of not signing off.
    assert.match(c, /sits in the queue meaning nothing/i)
    assert.match(c, /(?:question|permission)[\s\S]{0,100}higher.priority/i)
    assert.match(c, /checked success card[^.]*queue/)
    assert.match(c, /until the human (?:explicitly )?(?:A|a)rchives? it/)
    // done is gated on LANDED work — merged, not merely committed/pushed/PR-opened (an open PR parks
    // on awaiting until it merges); a pre-fix bug/issue investigation never earns it, while a
    // commissioned research/audit effort's finished report does (done-requires-landed-work)
    assert.match(c, /COMPLETED\s+the effort's real work/)
    assert.match(c, /code LANDED on the project's mainline/)
    assert.match(c, /Code written but not LANDED is not done/)
    assert.match(c, /open PR is work still ahead of the merge/)
    assert.match(c, /`done` waits for the MERGE/)
    // `pr:`, NOT the retired `pr-watch:` — the 2026-08-15 grammar dropped that spelling, so a fence
    // written the old way parses as prose and the park names nothing (AWAITING_HINT_RE in tailer.ts).
    assert.match(c, /park the PR on[\s\S]{0,40}`pr:`/)
    // The git-discipline + implementation-thread surfaces must not contradict it by fencing on a PR.
    assert.match(c, /Opening the PR does NOT finish the thread — the MERGE does/)
    assert.doesNotMatch(c, /done ` fence naming the PR\/paths/)
    assert.doesNotMatch(c, /changes sitting uncommitted/)
    assert.match(c, /investigat(?:ed|ing|ion)[\s\S]{0,300}NOT `?done`?/i)
    assert.match(c, /research or audit EFFORT[\s\S]{0,200}earns `done`/)
    assert.match(c, /awaiting[\s\S]{0,140}(?:human|timestamp)/i)
    assert.match(c, /(?:CI|automatable)[\s\S]{0,180}(?:stay ACTIVE|stay active|active wait|live operation)/i)
    // `done` is taught as a DISMISSAL, not a summary: its card is the one-click path into Inactive
    // (groups.ts), so anything living only in the conversation dies with the thread. The rule is the
    // intent-level heuristic — "points at future work AT ALL" → not done — not a scenario list, and
    // the planning carve-out is DERIVED from it (the artifact outlives the thread), never asserted
    // as an arbitrary exception (done-is-a-dismissal).
    //
    // The 2026-07-25 restructure CUT the rhetorical scaffolding that used to carry this ("ask one
    // question before you fence: if this thread is never opened again…", "Two instances worth
    // naming", "the clearest case of all"). Those were rationale, not rules. The operative rules
    // below are what must survive; do not re-add the essay to satisfy a test.
    assert.match(c, /`done` is a DISMISSAL, not a summary/)
    assert.match(c, /files the thread away where nobody looks again/)
    assert.match(c, /points at future work AT ALL/)
    assert.match(c, /[Uu]ncertain is not done/)
    // Unlanded code and the live code-change discussion remain INSTANCES of the heuristic.
    assert.match(c, /live code-change discussion/)
    assert.match(c, /PLANNING session whose plan file is FULLY written and PERSISTED/)
    assert.match(c, /FULLY written and PERSISTED \(`\.frizz\/plans\/<topic>\.md`\)/)
    assert.match(c, /artifact already lives outside the thread, so dismissing the thread loses nothing/)
    // 2026-08-16, TWO threads in one sitting fenced `done` on work that was still owed, and both read
    // the contract correctly to get there — so these are the wording defects, not model defects:
    //
    //   zod #6022  reached `decline`, DRAFTED the close comment, wrote "not posted", fenced `done`.
    //              The audit carve-out said a finished report earns `done` and gave no exit condition,
    //              so a verdict that ENDS IN AN ACT the human must perform read as a finished report.
    //   zod #6065  finished its mandate, discovered an unlanded fix, reasoned "the fix is not mine, so
    //              I do not OWE it" — widening "not a process that happens to still be RUNNING" from a
    //              background-process carve-out into a general test — and fenced `done`.
    //
    // Its self-diagnosis also named a real deadlock the contract created: `done` barred by future work,
    // `awaiting` barred with nothing running, `question` seemingly barred with nothing pending, and
    // "bare-rest instead" contradicted by ALWAYS SIGN OFF WITH A FENCE. The resolution is a named
    // section with three ordered exits, and it is what connects spawn_thread to the `done` test.
    assert.match(c, /RECOMMENDATION IS NOT A CONCLUSION, AND AN UNSENT DRAFT IS NOT A DELIVERABLE/)
    assert.match(c, /WROTE but did not SEND/)
    assert.match(c, /BACKGROUND PROCESS that happens to still be running/)
    assert.match(c, /Read that carve-out\s+narrowly: its subject is a running process, and nothing else/)
    assert.match(c, /Follow-up work you DISCOVERED blocks[\s\S]{0,120}even when it is someone else's to do/)
    assert.match(c, /"not mine" is not "not owed"/)
    assert.match(c, /Neither\s+exception stretches to a report that ENDS IN A DECISION the human has yet to make/)
    // The deadlock's exit, in order: do it, hand it to its own card, ask. Never stretch `done`.
    assert.match(c, /### When the work is finished but the thread found more/)
    assert.match(c, /HAND IT OFF TO ITS OWN CARD[\s\S]{0,120}`mcp__frizz__spawn_thread`/)
    assert.match(c, /stretching `done` is not how you break it/)
    assert.match(c, /A bare rest is the residual, not a plan/)
    // The fourth exit is DROP, and it is the one the maintainer asked for by name (2026-08-16): a
    // finished handoff that still trails "one thing to carry forward…" is clutter — too weak to act on,
    // too present to ignore, archived unread. What is not worth a card is not worth a sentence.
    assert.match(c, /DELETE EVERY DANGLING "WORTH DOING LATER"/)
    assert.match(c, /one thing to\s+carry forward…/i)
    assert.match(c, /DO it, SPAWN it onto\s+its own card, ASK about it, or DROP it/)
    assert.match(c, /does not deserve a trailing\s+sentence either. DROP it/)
    // ...and the card must not restate the prose. Same maintainer note; the rule already existed in
    // this repo's FRIZZ.md but never in the contract every worker gets.
    assert.match(c, /TWO SURFACES, NOT ONE MESSAGE WRITTEN TWICE/)
    assert.match(c, /would read the same in either,\s+it belongs in exactly ONE of them/)
    // ...and spawn_thread's own section points BACK, so a worker reading either one finds the link.
    assert.match(c, /Its most valuable use is the one that unblocks/)
    // The stop criterion's "you marked it (recommended), so you already knew — implement it instead"
    // is the counter-pull that pushed zod #6022 away from a question. It only holds where the worker
    // CAN act; under a read-only boundary the recommendation IS the question, never a silent `done`.
    assert.match(c, /knowing the answer and being ABLE TO ACT ON IT come apart/)
    assert.match(c, /It becomes the QUESTION, with the recommendation as option A/)
    // The planning thread type derives the same carve-out where a worker reads its deliverable —
    // codex-only now, since claude's lean contract drops ## Thread types. Claude still carries the
    // rule itself in End-of-turn signals (FULLY written and PERSISTED, asserted above).
    if (/## Thread types/.test(raw)) {
      assert.match(c, /WRITTEN, PERSISTED file is the whole reason a planning thread may/)
      assert.match(c, /design outlives the thread's dismissal/)
    }
    // The tail recap repeats the heuristic (not the scenario) for a worker skimming the end.
    assert.match(c, /Nor is a turn on a thread that still points at future work/)
  }
  // The runtime re-grounding carries the same intent in one line (slim, not a second contract copy).
  assert.match(SESSION_SEED, /```done[^;]*is a DISMISSAL \(its card files the thread away where nobody looks again\)/)
  // The escape from `done` is now a QUESTION, not a bare rest — a fenceless rest stopped being an
  // acceptable outcome on 2026-08-12 (scheduler SOURCE 9 corrects it).
  assert.match(SESSION_SEED, /points at future work AT ALL[^;]*ask a ```question instead, and uncertain is not done/)
  assert.match(SESSION_SEED, /ALWAYS SIGN OFF WITH A FENCE/)
  // The fact a worker cannot discover on its own, and the one it most often gets wrong: its shells are
  // watched AUTOMATICALLY, and the fence line is how it comes to REST meanwhile — not a registration.
  assert.match(SESSION_SEED, /watched AUTOMATICALLY/)
  assert.match(SESSION_SEED, /`watch: <id>` line/)
  assert.match(SESSION_SEED, /because that artifact outlives the thread/)
  // The seed carries the two 2026-08-16 wrong-`done` cases in one clause each — a worker that never
  // scrolls the system prompt still gets the recommendation rule and the discovered-follow-up rule.
  assert.match(SESSION_SEED, /follow-up work you DISCOVERED even when someone else will do it/)
  assert.match(SESSION_SEED, /never a done card, because a draft you wrote but did not send is filed away with the thread/)
  assert.match(SESSION_SEED, /mcp__frizz__spawn_thread gives it its own card and only THEN is done honest/)
  assert.match(SESSION_SEED, /TWO SURFACES, not one message written twice/)
  assert.match(SESSION_SEED, /if it is not worth a card it is not worth a sentence/)
  assert.match(SESSION_SEED, /code LANDED on the mainline — an open PR is NOT done, park it on ```awaiting until it MERGES/)
  assert.doesNotMatch(SESSION_SEED, /BARE REST[^\n]*quiet/i)
  assert.doesNotMatch(SESSION_SEED, /```done \/ ```awaiting excuse/)
  assert.match(SESSION_SEED, /real work is COMPLETE/)
  // The seed now also carries the autonomy anchor — the single most-violated norm in practice
  // (measured: 25% of threads opened with a permission-gate question). See workerPrompt.ts header.
  assert.match(SESSION_SEED, /DECIDE rather than ask/)
  assert.match(SESSION_SEED, /asking permission to do the work you were dispatched to do is not a question/)
})

test("session-seed is a SLIM runtime pointer, not a fourth full contract copy", () => {
  // The full contract lives ONCE in the system prompt (loadWorkerPrompt) — the on-demand frizz:worker
  // skill copy was deleted. The SessionStart hook only re-grounds: it points at the system prompt, carries the runtime
  // scratchpad path + a signal-at-rest anchor, and must NOT re-duplicate the re-entry drill or any
  // browser-QA checklist (that duplication is exactly what drifted and what this slim removes).
  assert.match(SESSION_SEED, /lives in your SYSTEM PROMPT/i)
  // The worker-skill copy is GONE — the seed must not tell workers to load a skill that no longer exists.
  assert.doesNotMatch(SESSION_SEED, /frizz:worker/)
  assert.match(SESSION_SEED, /\.frizz\/threads\//)
  assert.doesNotMatch(SESSION_SEED, /scratch\.md/, "no filename is reserved in the scratch directory")
  for (const fence of [/```done/, /```awaiting/, /```question/]) assert.match(SESSION_SEED, fence)
  assert.doesNotMatch(SESSION_SEED, /RUNTIME RELEASE GATE:/)
  assert.doesNotMatch(SESSION_SEED, /never build a bespoke screenshot tool/)
  assert.doesNotMatch(SESSION_SEED, /back to awaiting/)
})

test("runtime release gate: WIPED — no worker surface carries browser-QA opinionation", () => {
  // The settings-toggled Runtime-release-gate module was deleted (maintainer 2026-08-03: "extremely
  // overfit to our specific requirements inside of this repo. Wipe it entirely."). Browser-QA policy
  // now belongs to a project's own FRIZZ.md/CLAUDE.md, which frizzConfigBlock injects per repo — never to
  // every worker Frizz dispatches anywhere.
  for (const raw of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    const c = raw.replace(/\s+/g, " ")
    assert.doesNotMatch(c, /Runtime release gate/i)
    assert.doesNotMatch(c, /SKIP IT for the small and the certain/i)
    assert.doesNotMatch(c, /never build a bespoke screenshot tool/i)
    assert.doesNotMatch(c, /Chrome DevTools MCP/i)
    assert.doesNotMatch(c, /agent-browser/i)
    // The generic, repo-agnostic verification rule stays — it names no browser.
    assert.match(c, /Verify behavior end-to-end before calling anything done/i)
    // …as does the handoff-rendering guidance for screenshots a worker DOES produce.
    assert.match(c, /Visual evidence in handoffs/)
    assert.match(c, /End-of-turn signals/)
  }
})

test("visual-evidence handoffs: provider contracts keep embeds safe, useful, and interpretable", () => {
  for (const raw of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    const c = raw.replace(/\s+/g, " ") // pin content, not line-wrap
    assert.match(c, /meaningful alt text/i)
    assert.match(c, /eligible workspace[\s\S]{0,80}allowlisted image files/i)
    assert.match(c, /outside that safe boundary[\s\S]{0,80}non-navigable/i)
    assert.match(c, /(?:Do not[\s\S]{0,60}bulk-embed|screenshot bulk[\s\S]{0,30}forbidden)/i)
    assert.match(c, /concise textual finding[\s\S]{0,100}when images are unavailable/i)
  }
})

// ---- composePrompt: the first VISIBLE user message's scratchpad line is backend-aware ----

test("composePrompt gives each backend's sub-agents their OWN file, never a shared document", () => {
  const claude = composePrompt("sid", "do the thing", "claude")
  assert.match(claude, /Name it in a sub-agent's prompt/)
  assert.match(claude, /give each child its OWN file rather than having them all edit one/)
  assert.equal(composePrompt("sid", "do the thing"), claude) // default = claude (unchanged)

  const codex = composePrompt("sid", "do the thing", "codex")
  assert.match(codex, /Native sub-agents share it — have each write its OWN file/)

  for (const [kind, text] of [["claude", claude], ["codex", codex]] as const) {
    // The merge contract is GONE, not reworded: one file per writer is what removed the hazard.
    assert.doesNotMatch(text, /merge/i, `${kind} must not reintroduce a shared-document merge contract`)
    assert.doesNotMatch(text, /blackboard/, `${kind} must not reintroduce the shared blackboard`)
    // The arming is the whole compaction story now, so both must name it.
    assert.match(text, /post_compaction: true/, `${kind} must teach the arming`)
  }
  assert.ok(codex.endsWith("do the thing")) // the task still rides through, and rides through LAST
})

// The pad is OPTIONAL and is NOT a deliverable — pinned because the opposite framing has a measured
// behavioural cost. Presented as "the CANONICAL record" with a mandatory "next action" field, a worker
// treats WRITING the next step as equivalent to DOING it, writes "next: X" for an X the human already
// asked for, and rests mid-mandate. Both surfaces must keep saying optional, and must keep saying that
// writing in it is not doing the work.
test("every scratch surface presents notes as optional and never a substitute for the work", () => {
  for (const kind of ["claude", "codex"] as const) {
    const prompt = composePrompt("sid", "do the thing", kind)
    assert.match(prompt, /nothing is expected in it/, `${kind} composePrompt must not present notes as mandatory`)
    assert.match(prompt, /never a substitute for doing the work/, `${kind} composePrompt must refuse the substitution`)
    assert.doesNotMatch(prompt, /CANONICAL/, `${kind} composePrompt must not re-promote a canonical doc`)

    const orientation = scratchpadOrientation("sid", null, kind)
    assert.match(orientation, /nothing is expected in it/, `${kind} orientation must not present notes as mandatory`)
    assert.match(orientation, /never a substitute for doing the work/, `${kind} orientation must refuse the substitution`)
    assert.doesNotMatch(orientation, /CANONICAL/, `${kind} orientation must not re-promote a canonical doc`)
  }
})

// ---- composePrompt: the system→human handoff carries a loud demarcation banner ----

test("composePrompt puts NOTHING of frizz's below the banner — the operator's prompt is the whole tail", () => {
  const task = "Fix the thing.\n\nWith a second paragraph."
  const composed = composePrompt("sid", task, "claude")

  // The banner sits between the orientation/instructions and the task, padded by blank lines.
  const banner = composed.indexOf("YOUR TASK")
  assert.notEqual(banner, -1)
  // Anchor on the scratchpad orientation: the operator preamble moved to the system prompt, and
  // asserting `indexOf(...) < banner` on an ABSENT string passes vacuously (-1 < banner).
  assert.ok(composed.indexOf(".frizz/threads/") < banner)
  assert.doesNotMatch(composed, /PROJECT INSTRUCTIONS/)
  assert.match(composed, /\n\n\n\n=+\n=+ {4}YOUR TASK {4}=+\n=+\n/)
  // THE property the banner exists for: below it is the operator's prompt, byte for byte. The framing
  // note that used to sit underneath now sits above, and the bare `TASK:` marker is gone entirely.
  assert.ok(composed.endsWith(`${DISPATCH_TASK_BANNER_MARKER}${task}`))
  assert.equal(composed.indexOf(DISPATCH_TASK_BANNER_MARKER), composed.lastIndexOf(DISPATCH_TASK_BANNER_MARKER))
  assert.ok(!composed.includes("\nTASK:\n"))
  assert.ok(composed.indexOf("frizz system orientation") < banner)

  // Round-trip through the real parser: the UI's first user message shows exactly the human's words,
  // while the stored text keeps the whole machine-facing prompt the worker actually received.
  const raw = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { content: composed },
  })
  const [message] = parseTranscript(raw)
  assert.equal(message.displayText, task)
  assert.equal(message.text, composed)
})

// The broker runtime delivers the dispatch prompt as a `queue-operation` enqueue record, NOT as a plain
// `user` record — which is how the whole composed prompt (orientation, project instructions, banner and
// all) ended up rendered in the first chat bubble of every broker thread.
test("composePrompt round-trips through the BROKER's enqueue record with the same bubble", () => {
  const task = "run `claude rc` in this repo"
  const composed = composePrompt("sid", task, "claude")
  const raw = [
    JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:00:00.000Z", operation: "enqueue", content: composed }),
    JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:00:00.100Z", operation: "dequeue", content: composed }),
  ].join("\n")
  const [message] = parseTranscript(raw)
  assert.equal(message.displayText, task)
  assert.equal(message.text, composed) // the raw content stays the queued-bubble map's key
  assert.equal(message.queued, false)
})

// ---- scratchpadOrientation: the SYSTEM-level line is backend-aware ----

test("scratchpadOrientation names the directory, the arming, and one file per sub-agent", () => {
  const claude = scratchpadOrientation("sid", null, "claude")
  assert.match(claude, /SCRATCH DIRECTORY: \.frizz\/threads\/sid\//)
  assert.match(claude, /name it in a sub-agent's prompt when you want its notes back, and give each child its own file/)
  assert.equal(scratchpadOrientation("sid", null), claude)

  const codex = scratchpadOrientation("sid", null, "codex")
  assert.match(codex, /native sub-agents share it, so give each its own file/)

  for (const [kind, text] of [["claude", claude], ["codex", codex]] as const) {
    // Compaction recovery is the ARMING, not the folder — a worker told only about the folder writes
    // notes nothing will ever hand back.
    assert.match(text, /post_compaction: true/, `${kind} must name the trigger`)
    assert.match(text, /Nothing in this directory is read automatically/, `${kind} must not imply an injection`)
    assert.doesNotMatch(text, /merge/i, `${kind} must not reintroduce the merge contract`)
    assert.doesNotMatch(text, /scratch\.md/, `${kind} must not reserve a filename`)
  }

  // The plan line is agnostic and appended for both.
  assert.match(scratchpadOrientation("sid", ".frizz/plans/x.md", "codex"), /PLAN: \.frizz\/plans\/x\.md/)
})

// ---- workerDispatchPermission: the Settings-driven launch mode for a NEW worker ----
// The floor (WORKER_DISPATCH_PERMISSION) keeps an unattended worker out of any mode that could stall it
// on an unanswerable prompt. The ONE deviation Settings can ask for is bypassPermissions on Claude,
// which is strictly more permissive and therefore cannot softlock.

test("workerDispatchPermission: Claude launches at the auto floor unless Settings asks to bypass", () => {
  assert.equal(workerDispatchPermission("claude", { permissionMode: "auto" }), "auto")
  assert.equal(workerDispatchPermission("claude", { permissionMode: "bypassPermissions" }), "bypassPermissions")
  assert.equal(WORKER_DISPATCH_PERMISSION.claude, "auto") // the floor itself is still auto
})

test("workerDispatchPermission: a restrictive stored mode can never reach a Claude spawn", () => {
  // Settings.permissionMode accepts the whole enum (it predates this control), but every mode that
  // would park a headless worker on a modal nobody is watching coerces back to the floor.
  for (const mode of ["default", "acceptEdits", "plan"] as const) {
    assert.equal(workerDispatchPermission("claude", { permissionMode: mode }), "auto")
  }
})

test("workerDispatchPermission: codex ignores the Claude setting and stays at full access", () => {
  // Codex has no permission-mode axis to raise — it already dispatches at danger-full-access, and the
  // Settings control is Claude-only, so neither value may move it.
  assert.equal(workerDispatchPermission("codex", { permissionMode: "auto" }), "bypassPermissions")
  assert.equal(workerDispatchPermission("codex", { permissionMode: "bypassPermissions" }), "bypassPermissions")
})

test("buildClaudeCommand carries bypassPermissions through to --permission-mode", () => {
  // The tmux fallback transport. (The broker — the default — passes the same mode into the SDK, which
  // additionally sets allowDangerouslySkipPermissions for exactly this value.)
  const argv = buildClaudeCommand({ sessionId: "bypass-dispatch", permissionMode: "bypassPermissions", prompt: "test", workerPrompt: "" })
  assert.deepEqual(
    argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2),
    ["--permission-mode", "bypassPermissions"],
  )
})
