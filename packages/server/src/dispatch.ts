import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, mkdirSync, rmSync, type Stats } from "node:fs"
import { basename, join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import {
  AdoptThreadInput,
  DISPATCH_TASK_BANNER_MARKER,
  DispatchInput,
  THREAD_SLUG_MAX_CHARS,
  ThreadSlug,
  slugify,
  tmuxSessionName,
  type ContextWindow,
  type Settings,
  type PermissionMode,
  type ProviderAuth,
} from "@fray-ui/shared"
import { PERM_DIR_ENV, permRequestDir, type Project } from "./project.ts"
import type { SessionRow, Storage } from "./storage.ts"
import type { BoardManager } from "./board.ts"
import type { AgentBackend, BackendKind, BuiltCommand, FrayMcp } from "./backend/types.ts"
import { CHROME_DEVTOOLS_MCP, claudeWorkerEnv, FRAY_MCP, WORKER_DISALLOWED_TOOLS } from "./backend/types.ts"
import { buildWorkerPrompt } from "./workerPrompt.ts"
import { codexSandbox, CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS } from "./backend/codex.ts"
import type { CodexAppServerBridge } from "./backend/codex-app-server.ts"
import { claudeBrokerBridgeEnabled, type ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import { ProviderAuthRequiredError } from "./backend/auth-status.ts"
import { readBoard, type FrayBoard, type FrayThread } from "./fray.ts"
import * as tmux from "./tmux.ts"
import { SYSTEM_PROMPT_DIR, cleanupAdoptionSessionFiles, systemPromptPath } from "./session-files.ts"
import {
  ADOPTION_ATTEMPT_LEASE_MS,
  abandonAdoptionAttempt,
  reconcileAdoptionClaims,
  type AdoptionRecoveryRuntime,
} from "./adoption-recovery.ts"

// Dispatch = provision the thread's scratchpad + compose the full prompt + spawn a detached `claude`
// in a tmux session + register the session row. Session-first (2026-07-09): a new dispatch writes NO
// .fray/<slug>.md thread file — the session IS the thread, and its durable working memory is a
// scratchpad (.fray/threads/<sessionId>/scratch.md). The prompt is the ONLY intelligence: the worker
// contract + this repo's FRAY.md + scratchpad orientation + the task. Project-specific conventions
// live in FRAY.md alone — the old settings `dispatchPreamble` was retired in favour of it, so there is
// exactly ONE operator-authored surface.

// title -> slug. The rule itself lives in @fray-ui/shared beside the ThreadSlug contract (the
// registry's boot repair recognises dispatch-minted slugs with it); re-exported here because every
// caller reaches for it through the dispatcher.
export { slugify }

// Derive a concrete thread title from the prompt when the human didn't supply one: the first ~6
// words of the prompt's first line, capped at 48 chars, ellipsized if anything was dropped. The
// thread FILE always needs a title (fray requires one) and the slug derives from it, so this never
// returns empty. Claude later renames the session (ai-title), which the UI prefers for display.
// Leading filler that carries no topic ("also spin up…", "please go ahead and…") and trailing
// function words a truncation must never end on (the old first-6-words cut produced slugs like
// "also-spin-up-a-sub-agent-to" — a dangling mid-phrase chop that reads as garbage in .fray/).
const LEAD_FILLER = new Set(["also", "please", "and", "then", "now", "ok", "okay", "hey", "just", "so", "well", "next", "go", "ahead", "lets", "let's", "can", "you", "could", "would"])
const TRAIL_STOP = new Set([
  "to", "a", "an", "the", "of", "for", "with", "in", "on", "at", "by", "and", "or", "but", "that",
  "this", "it", "is", "are", "be", "as", "into", "from", "my", "our", "your", "their",
])

export function fallbackTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n", 1)[0].trim()
  let allWords = firstLine.split(/\s+/).filter(Boolean)
  // Strip topic-free lead-ins, but never below two words of substance.
  while (allWords.length > 2 && LEAD_FILLER.has(allWords[0].toLowerCase().replace(/[^a-z]/g, ""))) allWords = allWords.slice(1)
  let words = allWords.slice(0, 6)
  // Never END on a dangling function word — back off (keeping at least two words).
  while (words.length > 2 && TRAIL_STOP.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ""))) words = words.slice(0, -1)
  let t = words.join(" ")
  let truncated = words.length < allWords.length
  if (t.length > 48) {
    t = t.slice(0, 47).trimEnd()
    truncated = true
  }
  if (truncated) t += "…"
  return t || "thread"
}

// First free slug: <base>, then <base>-2, -3, … skipping any existing .fray/<slug>.md AND any taken
// registry slug (session-first: new dispatches have no .fray file, so uniqueness must also clear the
// storage rows — else two fileless sessions could collide on a slug). `taken` is the row predicate.
export function resolveSlug(frayDir: string, base: string, taken?: (slug: string) => boolean): string {
  base = ThreadSlug.parse(base)
  const isTaken = (slug: string) => existsSync(join(frayDir, `${slug}.md`)) || (taken?.(slug) ?? false)
  if (!isTaken(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const stem = base.slice(0, THREAD_SLUG_MAX_CHARS - suffix.length).replace(/-+$/g, "") || "thread"
    const candidate = ThreadSlug.parse(`${stem}${suffix}`)
    if (!isTaken(candidate)) return candidate
  }
}

interface LegacyThreadFileIdentity {
  path: string
  realPath: string
  contents: Buffer
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  digest: string
}

function sameFileStat(a: LegacyThreadFileIdentity, b: LegacyThreadFileIdentity): boolean {
  return a.path === b.path && a.realPath === b.realPath && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.digest === b.digest
}

// Resolve an adoption source without ever accepting an indirect path. Both `.fray` and the selected
// markdown file must be real (not symlink) direct children of the real project root. Reading the file
// into the identity digest closes replacement/content races across the fresh-board authorization pass.
export function resolveLegacyThreadFile(projectDir: string, value: unknown): LegacyThreadFileIdentity | null {
  const parsed = ThreadSlug.safeParse(value)
  if (!parsed.success) return null
  try {
    const projectRoot = realpathSync(projectDir)
    const frayPath = join(projectRoot, ".fray")
    const frayStat = lstatSync(frayPath)
    if (!frayStat.isDirectory() || frayStat.isSymbolicLink()) return null
    const realFray = realpathSync(frayPath)
    if (dirname(realFray) !== projectRoot || basename(realFray) !== ".fray") return null

    const path = join(realFray, `${parsed.data}.md`)
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink()) return null
    const realPath = realpathSync(path)
    if (dirname(realPath) !== realFray || basename(realPath) !== `${parsed.data}.md`) return null
    let contents: Buffer
    let openedBefore: Stats
    let openedAfter: Stats
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      openedBefore = fstatSync(fd)
      contents = readFileSync(fd)
      openedAfter = fstatSync(fd)
    } finally {
      closeSync(fd)
    }
    const after = lstatSync(path)
    if (before.dev !== openedBefore.dev || before.ino !== openedBefore.ino ||
        openedBefore.dev !== openedAfter.dev || openedBefore.ino !== openedAfter.ino ||
        openedBefore.size !== openedAfter.size || openedBefore.mtimeMs !== openedAfter.mtimeMs ||
        openedBefore.ctimeMs !== openedAfter.ctimeMs || after.dev !== openedAfter.dev ||
        after.ino !== openedAfter.ino || after.size !== openedAfter.size ||
        after.mtimeMs !== openedAfter.mtimeMs || after.ctimeMs !== openedAfter.ctimeMs ||
        !openedAfter.isFile() || !after.isFile() || after.isSymbolicLink()) {
      return null
    }
    return {
      path,
      realPath,
      contents,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      digest: createHash("sha256").update(contents).digest("hex"),
    }
  } catch {
    return null
  }
}

const ADOPTABLE_LEGACY_STATUSES = new Set(["planning", "planned", "active", "needs-human", "blocked"])

export function isAdoptableLegacyBoardThread(thread: FrayThread, slug: string): boolean {
  return thread.id === slug &&
    ADOPTABLE_LEGACY_STATUSES.has(thread.status) &&
    thread.owner == null &&
    Array.isArray(thread.agents) && thread.agents.length === 0 &&
    Array.isArray(thread.errors) && thread.errors.length === 0
}

function boardAuthorizesAdoption(board: FrayBoard, slug: string): boolean {
  const matches = board.threads.filter((thread) => thread.id === slug)
  if (matches.length !== 1 || !isAdoptableLegacyBoardThread(matches[0], slug)) return false
  return !board.errorItems.some((item) => item.file === `${slug}.md`)
}

function ensureSafeDirectDirectory(parent: string, name: string): string {
  const path = join(parent, name)
  try {
    mkdirSync(path)
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (code !== "EEXIST") throw error
  }
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe project directory")
  const real = realpathSync(path)
  if (dirname(real) !== parent || basename(real) !== name) throw new Error("unsafe project directory")
  return real
}

// The scratchpad skeleton (a CONVENTION, never validated): a compact continuity structure plus a
// visible task-status/collaboration legend. Its body remains ordinary free-form Markdown; workers may
// optionally prepend the reserved `stop_hook` frontmatter described in the contract. Both backends
// share it with sub-agents, so stable per-agent subsections + merge-only edits keep concurrent progress
// useful instead of destructive.
export function scratchpadContent(title: string, kind: BackendKind = "claude"): string {
  const guide = `> Status legend: \`[ ]\` pending · \`[/]\` in progress · \`[x]\` complete · \`[-]\` cancelled · \`[?]\` blocked / needs input
> Collaboration: re-read before every edit; preserve existing content; keep each agent's updates under its own \`### <agent path>\` subsection in Agent progress. A scoped scratchpad merge is Fray coordination state and remains allowed when a delegated task limits its deliverable paths. Never delete, truncate, reinitialize, move, or replace the whole file.`
  if (kind === "codex") {
    return `# Scratchpad — ${title}

The canonical record of this thread, your compaction-survival mechanism, and the progress document shared with native sub-agents.

${guide}

## Goal

## Task list

- [ ]

## Decisions

## Shared context

## Agent progress

## Verification

## Next action
`
  }
  return `# Scratchpad — ${title}

The canonical record of this thread, your compaction-survival mechanism, and the blackboard your sub-agents read and update.

${guide}

## Goal

## Task list

- [ ]

## Decisions

## Shared context

## Agent progress

## Verification

## Next action
`
}

// The thread scratchpad's project-relative path — the ONE spelling, shared by the writer below, the
// board's doc-tab visibility probe, and the reader RPC. The tab is offered iff this file exists and
// shows what this file holds, so a reader that spells the path out separately silently renders every
// scratchpad as "No scratchpad yet." — which is exactly what it did.
export function scratchpadRelPath(sessionId: string): string {
  return `.fray/threads/${sessionId}/scratch.md`
}

// Provision the thread's scratchpad (.fray/threads/<sessionId>/scratch.md), atomic tmp+rename. Returns the
// project-relative path. sessionId is a fresh UUID at both dispatch and adopt, so this never clobbers.
export function writeScratchpad(projectDir: string, sessionId: string, title: string, kind: BackendKind = "claude"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId)) throw new Error("invalid session id")
  const projectRoot = realpathSync(projectDir)
  const frayDir = ensureSafeDirectDirectory(projectRoot, ".fray")
  const threadsDir = ensureSafeDirectDirectory(frayDir, "threads")
  const dir = ensureSafeDirectDirectory(threadsDir, sessionId)
  const rel = scratchpadRelPath(sessionId)
  const path = join(dir, "scratch.md")
  // Deterministic per-session staging name lets restart recovery remove a SIGKILL artifact; the
  // session id is unique, so randomizing this filename only made the orphan undiscoverable.
  const tmp = join(dir, ".scratch.tmp")
  try {
    writeFileSync(tmp, scratchpadContent(title, kind), { flag: "wx", mode: 0o600 })
    if (existsSync(path)) throw new Error("scratchpad already exists")
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  return rel
}

// The FIXED worker system prompt for `kind`, compiled in via workerPrompt.ts (single source of truth).
// The runtimeGate flag toggles the settings-gated Runtime-release-gate section. Not user-modifiable —
// project-specific conventions ride FRAY.md (frayConfigBlock), appended separately. Thin adapter kept
// so existing callers (spawn/adopt/resume builders + tests) are untouched.
export function loadWorkerPrompt(kind: BackendKind = "claude", runtimeGate = true): string {
  return buildWorkerPrompt(kind, { runtimeGate })
}

// ---- scratchpad reinforcement (always on) ----
// Deliberately NOT settings-gated. The scratchpad is the canonical document for a thread, so
// re-grounding on it after a compaction is what makes the pad worth writing — not a posture a project
// opts into. Claude needs no plumbing at all here (the plugin's hooks.json is always registered);
// codex does, because its hooks can only arrive as per-conversation config.
//
// Measured against codex-cli 0.144.6, and the reason this is config rather than argv or a file:
// `codex exec` runs NO hooks from ANY discovery path (repo `.codex/hooks.json`,
// `$CODEX_HOME/hooks.json`, `-c hooks.…`), with or without trust bypass — while the app-server DOES
// run them when they arrive as config overrides on the conversation. `bypass_hook_trust` is required
// because codex SILENTLY SKIPS untrusted hook definitions, which is indistinguishable from a broken
// feature.
//
// NOTE the deliberate asymmetry with Claude: codex exposes NO PreCompact/PostCompact context-injection
// wire type (only SessionStart / UserPromptSubmit / PostToolUse / PreToolUse / PermissionRequest /
// SubagentStart have one), so the summarizer-steering channel is Claude-only. The load-bearing
// channel — restoring the pad on SessionStart(compact) — is available on both.
export function codexScratchpadHookConfig(
  hookScript: string | undefined,
  sessionId: string
): Record<string, unknown> {
  if (!hookScript || !sessionId) return {}
  // `--session` is mandatory: codex reports its OWN rollout session id to the hook, so without fray's
  // thread id the hook would resolve a scratchpad path that does not exist.
  const cmd = (mode: string) => ({
    hooks: [
      {
        type: "command",
        command: `node ${JSON.stringify(hookScript)} --session=${JSON.stringify(sessionId)} ${mode}`,
      },
    ],
  })
  const bashBackgroundHook = join(dirname(hookScript), "bash-background.mjs")
  const scratchpadStopHook = join(dirname(hookScript), "scratchpad-stop.mjs")
  return {
    bypass_hook_trust: true,
    hooks: {
      // Codex canonicalizes both direct and unified exec_command calls as Bash and exposes their
      // command at tool_input.command. Register the same lifecycle guard as Claude; the explicit flag
      // is necessary because the shared app-server daemon cannot carry a per-conversation env marker.
      PreToolUse: [{
        matcher: "^Bash$",
        hooks: [{
          type: "command",
          command: `node ${JSON.stringify(bashBackgroundHook)} --fray-ui-thread`,
        }],
      }],
      // An optional scratchpad-frontmatter reminder can keep a worker from forgetting owned work when
      // it tries to rest. The hook itself persists the two-minute anti-loop cooldown.
      Stop: [{
        hooks: [{
          type: "command",
          command: `node ${JSON.stringify(scratchpadStopHook)} --session=${JSON.stringify(sessionId)}`,
        }],
      }],
      // Native Codex children inherit the root scratchpad mandate even with `fork_turns:"none"`.
      // Constrain it structurally at child start: shared writes, but only merge-style scoped edits.
      SubagentStart: [cmd("--mode=subagent-start")],
      SessionStart: [cmd("--mode=session-start")],
      UserPromptSubmit: [cmd("--mode=nudge")],
      PostToolUse: [cmd("--mode=nudge --event=PostToolUse")],
    },
  }
}

/** Absolute path to the scratchpad hook inside the discovered worker plugin, when there is one. */
export function scratchpadHookScript(): string | undefined {
  const plugin = workerPluginDir()
  return plugin ? join(plugin, "hooks", "scratchpad.mjs") : undefined
}

// The first USER message a dispatched agent receives: scratchpad orientation + custom instructions +
// task. Session-first (2026-07-09) — the old thread-ownership contract is REPLACED by scratchpad
// orientation (a new dispatch owns no .fray file). The fixed worker prompt (workerPrompt.ts) and the
// same scratchpad line at SYSTEM level travel via --append-system-prompt (see buildClaudeCommand) so
// they survive compaction and re-apply on resume; this composes the visible-message half.
export function composePrompt(sessionId: string, prompt: string, kind: BackendKind = "claude"): string {
  const scratch =
    kind === "codex"
      ? `Your scratchpad is \`.fray/threads/${sessionId}/scratch.md\` — an OPTIONAL scratch file kept for you, not a deliverable. A single direct task usually needs nothing in it, and writing in it never substitutes for doing the work. On a long effort it is useful crash insurance and a shared progress document for native sub-agents: keep the approach, what you rejected, and the human's decisions in it as you go, mid-work, then keep working; re-read it after any compaction or resume before asserting anything. Each native sub-agent should merge its own scoped progress into it rather than leaving the root as its sole writer, but must re-read before each edit, preserve all existing content, and never delete, truncate, reinitialize, move, or replace the whole file.`
      : `Your scratchpad is \`.fray/threads/${sessionId}/scratch.md\` — an OPTIONAL scratch file kept for you, not a deliverable. A single direct task usually needs nothing in it, and writing in it never substitutes for doing the work. On a long effort it is useful crash insurance and the shared blackboard for your sub-agents: keep the approach, what you rejected, and the human's decisions in it as you go, mid-work, then keep working; re-read it after any compaction or resume, and pass its path to every sub-agent you dispatch. Each sub-agent should merge its own scoped progress into it rather than leaving the root as its sole writer, but must re-read before each edit, preserve all existing content, and never delete, truncate, reinitialize, move, or replace the whole file.`
  // The banner makes the system→human handoff unmistakable to the worker, and NOTHING of fray's is
  // allowed below it: the framing note goes here, ABOVE, so everything past the banner is the
  // operator's prompt byte for byte. That is also what the transcript projectors cut on
  // (DISPATCH_TASK_BANNER_MARKER), so the first chat bubble shows the operator's words alone.
  const handoff =
    "\n\nEverything above the banner below is fray system orientation. Everything below it is the human operator's own prompt, verbatim — that, and nothing else, is your task."
  return `${scratch}${handoff}\n\n\n${DISPATCH_TASK_BANNER_MARKER}${prompt}`
}

// The SYSTEM-level scratchpad orientation (survives compaction, rebuilds on every resume): a scratchpad
// line, plus a PLAN line when the thread is associated with a plan artifact. Passed as extraSystemPrompt
// on dispatch, adopt, AND the followUp resume path.
export function scratchpadOrientation(sessionId: string, planPath?: string | null, kind: BackendKind = "claude"): string {
  const scratch =
    kind === "codex"
      ? `SCRATCHPAD (optional): .fray/threads/${sessionId}/scratch.md — a scratch file kept FOR YOU, not a deliverable. A single direct task usually needs nothing in it; writing in it is never a substitute for doing the work. Useful on a long effort as crash insurance, and a shared progress document for native sub-agents (write your task list, the approach and what you rejected, and anything that must outlive your context there, as you go; re-read it after any compaction or resume). Each native sub-agent should merge its own scoped progress into it rather than leaving the root as its sole writer, but must re-read before each edit, preserve all existing content, and never delete, truncate, reinitialize, move, or replace the whole file.`
      : `SCRATCHPAD (optional): .fray/threads/${sessionId}/scratch.md — a scratch file kept FOR YOU, not a deliverable. A single direct task usually needs nothing in it; writing in it is never a substitute for doing the work. Useful on a long effort as crash insurance, and the shared blackboard for your sub-agents (write your task list, the approach and what you rejected, and anything that must outlive your context there, as you go; re-read it after any compaction or resume; pass this path in every sub-agent prompt). Each sub-agent should merge its own scoped progress into it rather than leaving the root as its sole writer, but must re-read before each edit, preserve all existing content, and never delete, truncate, reinitialize, move, or replace the whole file.`
  const lines = [scratch]
  if (planPath) lines.push(`PLAN: ${planPath} — the durable plan artifact this thread works from; read it FIRST.`)
  return lines.join("\n")
}

// A project can ship a repo-committed `FRAY.md` at its root to steer fray workers with its OWN
// engineering-PROCESS norms — gates, review depth, commit/PR conventions — which OVERRIDE fray's
// built-in PROCESS defaults (NOT the fray-mechanical contract: signal fences, scratchpad, the browser
// runtime gate stay in force — the injected header says so, matching the "Defer" section of the worker
// contract). When present, its contents are injected into every worker's SYSTEM prompt (dispatch,
// adopt, AND resume; both backends) under that header, so both backends see it without relying on the
// agent choosing to open the file. Read fresh on every spawn/resume, so an edit takes effect on the
// next launch.
//
// The read is guarded by statSync BEFORE readFileSync: only a regular file under a size cap is read.
// That keeps one accidental/hostile FRAY.md from wedging the server's event loop on EVERY dispatch and
// resume — a FIFO would make readFileSync block forever, a symlink loop throws, a directory/device
// isn't a regular file, and a runaway/generated file is rejected by size rather than fully slurped.
// The surviving content is then clipped to keep token/context cost bounded. Returns "" when
// absent/oversized/non-regular/empty — the caller drops it from the composed extra-system-prompt.
const FRAY_MD_MAX_CHARS = 12_000
const FRAY_MD_MAX_BYTES = 64 * 1024
export function frayConfigBlock(projectDir: string): string {
  const path = join(projectDir, "FRAY.md")
  let body: string
  try {
    const st = statSync(path) // follows a symlink to its target; ENOENT/ELOOP throw → caught
    if (!st.isFile() || st.size > FRAY_MD_MAX_BYTES) return "" // not a regular file, or runaway size
    body = readFileSync(path, "utf8").trim()
  } catch {
    return "" // no FRAY.md, unreadable, symlink loop, etc. → inject nothing
  }
  if (!body) return ""
  const clipped = body.length > FRAY_MD_MAX_CHARS ? `${body.slice(0, FRAY_MD_MAX_CHARS)}\n\n[FRAY.md truncated]` : body
  return `PROJECT FRAY CONFIG (from this repo's FRAY.md) — the project's own conventions for fray workers. They OVERRIDE the fray worker PROCESS defaults above (review depth, gates, git/PR conventions, the quality bar) wherever they conflict; follow them. They do NOT relax the fray-mechanical contract — the signal fences, scratchpad, and browser runtime gate still bind:\n\n${clipped}`
}

// A DispatchInput.planPath is honored only when it is a well-formed .fray/plans/*.md path AND the file
// exists; anything else is ignored (stored as null). Shape check forecloses traversal.
const PLAN_PATH_RE = /^\.fray\/plans\/[A-Za-z0-9][A-Za-z0-9._ -]*\.md$/
export function validPlanPath(projectDir: string, planPath: string | undefined): string | null {
  if (!planPath || !PLAN_PATH_RE.test(planPath)) return null
  return existsSync(join(projectDir, planPath)) ? planPath : null
}

// Workers have NO coherent interactive-plan-mode semantics: plan mode stays read-only until an
// INTERACTIVE ExitPlanMode approval, which a headless dashboard worker can't satisfy (no one is at
// the keyboard) and which blocks all edits until then — a softlock. A worker "plans" by writing a
// plan artifact (.fray/plans/*.md) and asking via a ```question fence, never via interactive plan
// mode. So a worker is NEVER spawned in plan mode: `plan` is coerced to the safe fray-ui default
// (`auto`). Applied inside BOTH spawn builders so dispatch, adopt, AND resume are all covered. (The
// dispatch UI still OFFERS "plan" in its permission-mode dropdown — dropping it in web/options.ts is
// a follow-up for UI honesty; this coercion is the actual enforcement + the softlock fix.)
function workerPermissionMode(m: PermissionMode): PermissionMode {
  return m === "plan" ? "auto" : m
}

// Every fray-CREATED worker launches maximally non-interactive: an unattended headless worker cannot
// answer an interactive prompt, so a RESTRICTIVE dispatch-time permission choice is a footgun, not a
// feature — it just stalls the thread on a modal nobody is watching. Claude gets `auto`; codex gets
// `bypassPermissions` (→ `-s danger-full-access`). These are the FLOOR the dispatch/adopt paths stamp
// (a client-sent permissionMode is still ignored); the only thing that moves it is the operator's own
// Settings choice — see workerDispatchPermission, which can only relax it further.
export const WORKER_DISPATCH_PERMISSION: Record<BackendKind, PermissionMode> = {
  claude: "auto",
  codex: "bypassPermissions",
}

// The permission mode a NEW worker of `kind` actually launches with, given the operator's Settings.
//
// Only ONE deviation from WORKER_DISPATCH_PERMISSION is honored: a Claude worker may be dispatched in
// `bypassPermissions` (claude's `--dangerously-skip-permissions`) when Settings asks for it. That
// direction is safe for a headless worker BECAUSE it is strictly more permissive than `auto` — nothing
// can stall on an unanswerable prompt. The restrictive modes stay unreachable on purpose: `default`,
// `acceptEdits` and `plan` are the softlock this function's floor exists to prevent, so a stored value
// left over from an older build (Settings.permissionMode predates this control and accepts the whole
// enum) coerces back to the floor rather than quietly wedging every dispatch. Codex has no equivalent
// axis to raise — it already launches at danger-full-access.
export function workerDispatchPermission(kind: BackendKind, settings: Pick<Settings, "permissionMode">): PermissionMode {
  if (kind === "claude" && settings.permissionMode === "bypassPermissions") return "bypassPermissions"
  return WORKER_DISPATCH_PERMISSION[kind]
}

// Canonical value that describes the permission policy the backend ACTUALLY receives. Claude's
// headless-worker plan request is coerced to auto (above); Codex's three sandbox levels share the
// PermissionMode storage field, so all workspace-write aliases collapse to `default`.
export function effectivePermissionMode(kind: BackendKind, mode: PermissionMode): PermissionMode {
  if (kind === "claude") return workerPermissionMode(mode)
  if (mode === "plan" || mode === "bypassPermissions") return mode
  return "default"
}

// The assembled system prompt (worker norms + spawn-specific orientation) is ~16KB — passing it
// inline as `--append-system-prompt <text>` on the tmux `new-session` command line EXCEEDS tmux's
// command-length limit and fails EVERY spawn with a silent "command too long" (found 2026-07-09:
// 100% of dispatch/adopt/resume broken). claude accepts `--append-system-prompt-file <path>`, so we
// write the prompt to a per-session file and pass the (short) path instead — the tmux command stays
// tiny. Written per invocation (dispatch AND resume) into a stable per-session path, so a resume
// after OS temp-cleanup just rewrites it. Returns the flag pair to splice into argv (empty if no
// system prompt). NOTE: keep using `--append-system-prompt` for genuinely SHORT text would also
// work, but a single file path is uniformly safe regardless of prompt growth.
function systemPromptFlags(sessionId: string, system: string): string[] {
  if (!system) return []
  mkdirSync(SYSTEM_PROMPT_DIR, { recursive: true })
  const path = systemPromptPath(sessionId)
  writeFileSync(path, system)
  return ["--append-system-prompt-file", path]
}

// Resolve the descriptor for the unified fray MCP server: the abs path to the stdio server script
// (shipped as a sibling of bin/fray in the worker plugin dir, so it rides the SAME ship+resolve path
// that already carries the plugin to prod) + the project state dir the script reads server.lock from.
// Returns undefined when the plugin dir or script can't be found — the worker then simply lacks the
// fray tools rather than failing to spawn. `env`/`moduleUrl` injectable for tests.
export function resolveFrayMcp(
  stateDir: string,
  moduleUrl = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
  slug?: string,
): FrayMcp | undefined {
  const pluginDir = resolveWorkerPluginDir(moduleUrl, env)
  if (!pluginDir) return undefined
  const scriptPath = join(pluginDir, "bin", FRAY_MCP.script)
  if (!existsSync(scriptPath)) return undefined
  return { scriptPath, stateDir, ...(slug ? { slug } : {}) }
}

// Claude flags that mount the fray-injected MCP servers via ONE inline `--mcp-config` JSON and
// PRE-APPROVE their tools (`--allowedTools`) so a headless worker never blocks on a permission prompt
// it has nobody to answer. execvp runs the argv with NO shell (tmux.ts), so the JSON travels literally.
// chrome-devtools is ALWAYS mounted (the runtime release gate needs a browser out of the box on any
// machine — parity with the codex backend's `-c` injection, same CHROME_DEVTOOLS_MCP spec); the
// server-level `mcp__chrome-devtools` rule pre-approves every tool it exposes. The unified `fray`
// server rides along when its descriptor resolved, pre-approved the same server-level way.
export interface ClaudeMcpStdioConfig { command: string; args?: string[]; env?: Record<string, string> }
export interface ClaudeMcpConfig { mcpServers: Record<string, ClaudeMcpStdioConfig>; allowedTools: string[] }

// The structured fray MCP mount, shared by the tmux CLI path (rendered to --mcp-config/--allowedTools
// flags below) AND the broker SDK path (passed straight into query()'s mcpServers/allowedTools). One
// source of truth so both transports mount the SAME servers with the SAME pre-approvals.
export function claudeMcpConfig(mcp?: FrayMcp): ClaudeMcpConfig {
  const mcpServers: Record<string, ClaudeMcpStdioConfig> = {
    [CHROME_DEVTOOLS_MCP.name]: { command: CHROME_DEVTOOLS_MCP.command, args: [...CHROME_DEVTOOLS_MCP.args] },
  }
  const allowedTools = [`mcp__${CHROME_DEVTOOLS_MCP.name}`]
  if (mcp) {
    // command is the ABSOLUTE node path (process.execPath — the node running the fray server), NOT bare
    // "node": Claude spawns the MCP-server process itself, and a worker's PATH varies by launch context
    // (a GUI-launched tmux, a login-shell difference) — if `node` isn't on it, the MCP server never
    // starts and the tool silently never appears in the worker. An absolute path removes that dependency.
    // FRAY_THREAD_SLUG is what lets a tool act on the CALLING thread (`heartbeat` arms a wake for
    // itself). The MCP server is spawned per worker, so its env is the only channel through which it
    // can know which thread it belongs to — nothing in the MCP protocol carries a caller identity.
    // A resume keeps the same slug, so this stays correct across the whole life of the thread.
    const env: Record<string, string> = { FRAY_STATE_DIR: mcp.stateDir }
    if (mcp.slug) env.FRAY_THREAD_SLUG = mcp.slug
    mcpServers[FRAY_MCP.name] = { command: process.execPath, args: [mcp.scriptPath], env }
    // Server-level, like chrome-devtools above: every tool the unified fray server exposes (today
    // `mcp__fray__spawn_thread`) is pre-approved, so adding one never needs an allow-list edit.
    allowedTools.push(`mcp__${FRAY_MCP.name}`)
  }
  return { mcpServers, allowedTools }
}

// Claude flags that mount the fray-injected MCP servers via ONE inline `--mcp-config` JSON and
// PRE-APPROVE their tools (`--allowedTools`) so a headless worker never blocks on a permission prompt
// it has nobody to answer. execvp runs the argv with NO shell (tmux.ts), so the JSON travels literally.
// chrome-devtools is ALWAYS mounted (the runtime release gate needs a browser out of the box on any
// machine — parity with the codex backend's `-c` injection, same CHROME_DEVTOOLS_MCP spec); the
// server-level `mcp__chrome-devtools` rule pre-approves every tool it exposes. The unified `fray`
// server rides along when its descriptor resolved, pre-approved the same server-level way.
export function claudeMcpFlags(mcp?: FrayMcp): string[] {
  const { mcpServers, allowedTools } = claudeMcpConfig(mcp)
  const config = JSON.stringify({ mcpServers })
  // ONE comma-joined `--allowedTools=` in EQUALS form: the flag is VARIADIC, so a space-separated
  // value with a positional right behind it (e.g. the minimal no-system-prompt argv, where the prompt
  // directly follows) would be swallowed as a second rule. The equals form binds exactly one token —
  // immune to argv reordering. Verified live: `claude -p --allowedTools=mcp__chrome-devtools <prompt>`
  // runs the tools unprompted with the prompt surviving as the positional.
  return ["--mcp-config", config, `--allowedTools=${allowedTools.join(",")}`]
}

// A fray worker runs under a dashboard, not a live chat, so a BLOCKING question tool would hang the
// session invisibly — there is nobody at the keyboard to click it. Remove it at spawn rather than
// arguing against it in prose: the contract used to spend a paragraph on "NEVER invoke it" AND a
// PreToolUse hook denied it, three mechanisms for one prohibition. Taking the tool away is the cheap
// one, and it makes the other two unnecessary (the hook stays as belt-and-braces for a session that
// somehow reaches the tool anyway). EQUALS form for the same reason as --allowedTools: the flag is
// variadic and a space-separated value would swallow the positional prompt behind it.
//
// This is the TMUX path only. The broker deliberately does NOT drop the same tool — it can put the
// question in front of the operator as a card — so the list lives in WORKER_DISALLOWED_TOOLS
// (backend/types.ts) where that asymmetry is written down rather than being inferable only from a
// missing call site.
export function workerDisallowedToolFlags(): string[] {
  return [`--disallowedTools=${WORKER_DISALLOWED_TOOLS.join(",")}`]
}

// The `claude` argv for a fresh dispatch. session-id is PINNED so we can resume the exact
// conversation later. claudeBin is injectable so tests build the command without spawning.
export function buildClaudeCommand(opts: {
  sessionId: string
  permissionMode: PermissionMode
  model?: string
  effort?: string
  prompt: string
  claudeBin?: string
  pluginDir?: string
  // Injectable for tests; defaults to the compiled-in worker contract ("" disables the append).
  workerPrompt?: string
  // Extra spawn-specific system-prompt text appended AFTER the worker norms (e.g. the adoption
  // orientation) — system-level so the visible transcript carries only the human's own words.
  extraSystemPrompt?: string
  frayMcp?: FrayMcp
}): string[] {
  const argv = [opts.claudeBin ?? "claude", "--session-id", opts.sessionId, "--permission-mode", workerPermissionMode(opts.permissionMode)]
  if (opts.model) argv.push("--model", opts.model)
  if (opts.effort) argv.push("--effort", opts.effort)
  if (opts.pluginDir) argv.push("--plugin-dir", opts.pluginDir)
  argv.push(...claudeMcpFlags(opts.frayMcp))
  argv.push(...workerDisallowedToolFlags())
  // The fixed worker norms live in the SYSTEM prompt: rebuilt on every invocation (incl. resume)
  // and immune to compaction, unlike a first user message.
  const worker = opts.workerPrompt ?? loadWorkerPrompt()
  const system = [worker, opts.extraSystemPrompt?.trim()].filter(Boolean).join("\n\n")
  argv.push(...systemPromptFlags(opts.sessionId, system))
  argv.push(opts.prompt)
  return argv
}

// The fray-worker plugin (single-thread worker contract + hooks), a sibling of board/ in the Fray
// source tree. Deployed artifacts carry it at runtime/cc-worker, but pnpm may load this module
// through a nested store rather than the flat node_modules layout. Search module ancestors so the
// closure remains discoverable in either layout; an explicitly verified artifact path wins.
export function resolveWorkerPluginDir(
  moduleUrl = import.meta.url,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const override = env.FRAY_WORKER_PLUGIN_DIR
  if (override && existsSync(join(override, ".claude-plugin", "plugin.json")))
    return override
  let current = dirname(fileURLToPath(moduleUrl))
  for (;;) {
    const candidate = join(current, "cc-worker")
    if (existsSync(join(candidate, ".claude-plugin", "plugin.json"))) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function workerPluginDir(): string | undefined {
  return resolveWorkerPluginDir()
}

// Claude Code caps WebSearch at 200 calls per SESSION (verified in the 2.1.220 bundle:
// `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION ?? 200`, enforced in the WebSearch tool against a
// `taskRegistry` counter). A fray worker is long-lived and research-heavy — it burns that budget on
// work a chat session never would — and past the cap the tool stops searching and merely returns
// "this session has used its web search budget", which reads to the model as a dead end rather than
// as a quota. Raise it far enough that a real effort never hits it, while keeping a finite backstop
// against a runaway search loop; Claude Code has no unlimited sentinel, so a large integer is the
// only expression of "effectively uncapped".
export const WORKER_MAX_WEB_SEARCHES = 10000

// The SAME quiet-cap problem, on the sub-agent path (verified in the same 2.1.220 bundle — all three
// read `Z.<VAR> ?? <default>` through the identical `int({min:1,digitsOnly:true})` parser):
//
//   CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION  default 200 — TOTAL Task spawns for the whole session.
//     Past it every spawn throws "Subagent spawn limit reached (N of 200 agents spawned)… ask the user
//     to raise CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION". A fray worker is long-lived and dispatches a
//     helper per prong across many turns, so it reaches 200 on work a chat session never would — and
//     the failure reads to the model as "stop delegating", not as a quota. Lifted like the search
//     budget: no machine cost to a high ceiling, since this counts spawns over time, not live ones.
//
//   CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS   default 20 — LIVE agents at once. Past it a spawn throws
//     "Concurrent subagent limit reached… Do not retry", so a fan-out wider than 20 silently loses its
//     tail. Raised, but NOT to the same sentinel: every live sub-agent is a real process and API
//     stream on this machine, so this one is a genuine resource dial (the orphan-reaper work exists
//     because runaway fan-out really does burn the box). 100 clears any real fan-out with a bound left.
//
// NOT lifted: CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH. Its default is not a constant at all — it resolves
// through a server-gated feature value — but the worker contract already tells workers to keep fan-out
// shallow because a rested sub-agent is not reliably re-woken by grandchildren. Raising the nesting cap
// would buy depth that fray's own wake path cannot deliver on, so the cap and the contract agree.
export const WORKER_MAX_SUBAGENTS = 10000
export const WORKER_MAX_CONCURRENT_SUBAGENTS = 100

// Claude Code parses these variables as a strictly-digits integer >= 1 (`int({min:1,digitsOnly:true})`)
// and silently falls back to its own default on anything else, so an operator override is honored
// only in exactly that shape.
function workerCap(name: string, lifted: number, env: NodeJS.ProcessEnv): string {
  const override = env[name]
  if (override !== undefined && /^[1-9][0-9]*$/.test(override)) return override
  return String(lifted)
}

// Claude Code reads these inherited process variables as sub-agent profile defaults. A Fray worker
// chooses its profile explicitly through the launch argv and plugin agent profiles, so let neither
// a shell nor a globally configured Claude session silently replace that selection. Empty tmux
// environment entries override inherited values while preserving every auth/config variable.
//
// The CAPS are the deliberate exception to that masking: a profile override hijacks the worker's
// identity, but a cap is operator policy, so an explicitly configured one is passed through rather
// than overridden. They are always set EXPLICITLY (never left to inheritance) because a tmux pane
// inherits the tmux SERVER's environment — captured whenever that server first started, which may
// predate the current fray process by days.
export function claudeWorkerEnvironment(contextWindow?: ContextWindow, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    ...claudeWorkerEnv(contextWindow),
    CLAUDE_CODE_SUBAGENT_MODEL: "",
    CLAUDE_CODE_EFFORT_LEVEL: "",
    CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: workerCap("CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION", WORKER_MAX_WEB_SEARCHES, env),
    CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: workerCap("CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION", WORKER_MAX_SUBAGENTS, env),
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: workerCap("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", WORKER_MAX_CONCURRENT_SUBAGENTS, env),
  }
}

// The `claude` argv to RESUME an existing session with a follow-up (used when the tmux session
// has died and a live sendKeys is impossible).
export function buildClaudeResumeCommand(opts: {
  sessionId: string
  permissionMode: PermissionMode
  model?: string
  effort?: string
  message?: string
  claudeBin?: string
  pluginDir?: string
  workerPrompt?: string
  // Extra system-prompt text appended AFTER the worker norms (e.g. the scratchpad orientation) — the
  // system prompt is rebuilt per invocation, so a resume must re-carry it or the scratchpad is forgotten.
  extraSystemPrompt?: string
  // The fray MCP server must ride resume too (a resumed worker keeps the capability).
  frayMcp?: FrayMcp
}): string[] {
  const argv = [opts.claudeBin ?? "claude", "--permission-mode", workerPermissionMode(opts.permissionMode)]
  if (opts.model) argv.push("--model", opts.model)
  if (opts.effort) argv.push("--effort", opts.effort)
  if (opts.pluginDir) argv.push("--plugin-dir", opts.pluginDir)
  argv.push(...claudeMcpFlags(opts.frayMcp))
  argv.push(...workerDisallowedToolFlags())
  // The system prompt is rebuilt per invocation — the resume must re-carry the worker norms too.
  // Same file-based path as buildClaudeCommand (see systemPromptFlags): inline would blow tmux's
  // command-length limit.
  const worker = opts.workerPrompt ?? loadWorkerPrompt()
  const system = [worker, opts.extraSystemPrompt?.trim()].filter(Boolean).join("\n\n")
  argv.push(...systemPromptFlags(opts.sessionId, system))
  argv.push("-r", opts.sessionId)
  if (opts.message) argv.push(opts.message)
  return argv
}

export interface Dispatcher {
  // `opts.backend` selects the agent backend for THIS dispatch (Codex-support epic, Phase 2); omitted /
  // "claude" is the default, so the RPC path (which passes no opts until the Phase-3 UI picker wires
  // DispatchInput.backend through) is byte-identical to before. A codex dispatch pre-arms the cwd trust
  // gate, spawns the codex TUI, then sentinel-discovers + pins the rollout id on the row.
  dispatch(input: DispatchInput, opts?: { backend?: BackendKind }): Promise<{ slug: string; sessionId: string }>
  // Cold-adopt an EXISTING thread fray-ui didn't originate (e.g. a repo with a pre-existing .fray
  // board): spawn a fresh worker pointed at the thread file. Fray's contract makes this sound —
  // the doc, not the conversation, is the durable context; the worker reads it and continues.
  adopt(slug: string, message?: string): Promise<{ slug: string; sessionId: string }>
}

export interface DispatchDeps {
  project: Project
  storage: Storage
  board: BoardManager
  // Adoption never authorizes from the BoardManager's potentially stale cache. Re-scan the legacy
  // board at click time, after the selected file has passed the direct-file containment check.
  readBoard?: typeof readBoard
  getSettings: () => Settings
  claudeBin?: string // injectable (tests / a stand-in command)
  spawn?: typeof tmux.spawn // injectable so tests don't touch tmux; identity is mandatory for safe rollback
  ensureServer?: typeof tmux.ensureServer
  hasSession?: typeof tmux.hasSession
  // Adoption rollback may stop only the exact pane identity returned by its own spawn. There is no
  // name-targeted fallback: a competing/current owner of the slug must never be killed.
  killPane?: typeof tmux.killPane
  killExpectedAdoptionPane?: typeof tmux.killExpectedAdoptionPane
  // Per-session agent-backend resolver that builds the spawn argv + injection (Codex-support epic).
  // Injected by the composition layer (context.ts); when absent (tests) dispatch falls back to the
  // local Claude argv builder, producing a byte-identical command. Selected by `opts.backend`.
  backendFor?: (kind?: string) => AgentBackend
  // The Codex app-server bridge (context.ts). A codex dispatch runs SOLELY over the JSON-RPC bridge
  // (persisted session + turn/start); there is no tmux TUI transport. Absent ⇒ a codex dispatch fails
  // loudly rather than falling back to a retired path.
  codexAppServer?: CodexAppServerBridge
  // The Claude session-broker bridge (context.ts). When present + the broker flag is on, a claude
  // dispatch runs over the broker (headless, no tmux pane) instead of the interactive TUI.
  claudeBroker?: ClaudeAgentBrokerBridge
  // Failure cleanup targets only the exact freshly-spawned slug. Injectable so timeout tests can prove
  // no neighboring tmux session is touched.
  killSession?: typeof tmux.killSession
  // Provider auth preflight (claude-auth plan, Slice A): resolves the target provider's credential
  // state BEFORE any thread state exists; a positive "signed-out" rejects the dispatch with
  // ProviderAuthRequiredError. Injected by the composition layer (context.ts: `claude auth status
  // --json` for Claude, the local auth.json read for Codex). Absent (tests) ⇒ no preflight, so unit
  // tests never shell out or depend on the developer's real credential state.
  preflightAuth?: (kind: BackendKind) => Promise<ProviderAuth>
  // Codex-only: is the `codex` executable actually runnable? Auth says a credential EXISTS; this says
  // whether the binary the dispatch needs is installed. "missing" (a positive ENOENT) rejects EARLY,
  // before any thread state, with a message that names the real problem instead of the deep
  // "daemon exited before it became ready" a missing binary otherwise produces. Fails open on
  // "unknown". Absent (tests) ⇒ no probe.
  preflightCodexBinary?: () => Promise<"present" | "missing" | "unknown">
  // Durable adoption recovery seams. Production uses tmux's token-aware exact-pane implementation;
  // focused tests inject an in-memory private server and deterministic time.
  adoptionRuntime?: AdoptionRecoveryRuntime
  adoptionNow?: () => number
  adoptionAttemptToken?: () => string
}

export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const spawn = deps.spawn ?? tmux.spawn
  const ensureServer = deps.ensureServer ?? tmux.ensureServer
  const hasSession = deps.hasSession ?? tmux.hasSession
  const killPane = deps.killPane ?? tmux.killPane
  const killSession = deps.killSession ?? tmux.killSession
  const readBoardSource = deps.readBoard ?? readBoard
  const frayDir = join(deps.project.dir, ".fray")
  const adoptionRuntime: AdoptionRecoveryRuntime = deps.adoptionRuntime ?? {
    lookupAdoptionPane: tmux.lookupAdoptionPane,
    findAdoptionPane: tmux.findAdoptionPane,
    findPaneIdentity: tmux.findPaneIdentity,
    killExpectedAdoptionPane: deps.killExpectedAdoptionPane ?? tmux.killExpectedAdoptionPane,
  }

  // Build the detached-spawn command through the backend seam for the chosen `kind` (falling back to
  // the local Claude builder when no resolver is injected — identical argv). Returns argv + prewrites.
  function buildSpawnCommand(o: {
    sessionId: string
    // The thread this worker will serve, so its fray MCP server can act on its own thread.
    slug: string
    permissionMode: PermissionMode
    model?: string
    effort?: string
    prompt: string
    extraSystemPrompt?: string
    kind?: BackendKind
    runtimeGate: boolean
    // Claude only; the codex branch never reads it. Threaded rather than read from a captured settings
    // snapshot so a mid-run change reaches the next spawn (matching runtimeGate above).
    contextWindow?: ContextWindow
  }): BuiltCommand {
    const frayMcp = resolveFrayMcp(deps.project.stateDir, undefined, undefined, o.slug)
    const backend = deps.backendFor?.(o.kind)
    if (backend) {
      const built = backend.buildSpawn({
        sessionId: o.sessionId,
        cwd: deps.project.dir,
        prompt: o.prompt,
        workerContract: loadWorkerPrompt(o.kind, o.runtimeGate),
        extraSystemPrompt: o.extraSystemPrompt,
        permissionMode: o.permissionMode,
        model: o.model,
        effort: o.effort,
        frayMcp,
      })
      return built
    }
    const argv = buildClaudeCommand({
      sessionId: o.sessionId,
      permissionMode: o.permissionMode,
      model: o.model,
      effort: o.effort,
      prompt: o.prompt,
      claudeBin: deps.claudeBin,
      pluginDir: workerPluginDir(),
      extraSystemPrompt: o.extraSystemPrompt,
      workerPrompt: loadWorkerPrompt("claude", o.runtimeGate),
      frayMcp,
    })
    return { argv, env: claudeWorkerEnvironment(o.contextWindow), prewrite: [] }
  }

  function writePrewrites(built: BuiltCommand): void {
    for (const file of built.prewrite) {
      if (file.mode === undefined) writeFileSync(file.path, file.contents)
      else writeFileSync(file.path, file.contents, { mode: file.mode })
    }
  }

  function cleanupPrewrites(built: BuiltCommand): void {
    for (const path of new Set(built.prewrite.map((file) => file.path))) {
      try {
        rmSync(path, { force: true })
      } catch {
        // Best-effort: these session-id-keyed files are inert and never identify another worker.
      }
    }
  }

  function cleanupDispatchFiles(scratchRel: string, built: BuiltCommand, sessionId: string): void {
    cleanupPrewrites(built)
    try {
      rmSync(join(deps.project.dir, scratchRel), { force: true })
    } catch {
      // The session-id-keyed scratchpad is inert and never identifies another worker.
    }
    cleanupAdoptionSessionFiles(deps.project.dir, sessionId)
  }

  return {
    async dispatch(input, opts) {
      // Dispatcher is a server boundary too: tests, schedulers, and future transports may call it
      // without traversing the RPC parser. Reject malformed explicit slugs before scratch/tmux/SQLite.
      input = DispatchInput.parse(input)
      const settings = deps.getSettings()
      const kind: BackendKind = opts?.backend ?? "claude"
      // Auth preflight (Slice A): block ONLY on a positive "signed-out" — "unknown" (flaky read,
      // missing binary, timeout) fails OPEN so a network blip never traps a logged-in user. Runs
      // before the scratchpad/tmux/registry so a rejected dispatch leaves zero trace; the browser
      // keeps the draft and opens the sign-in modal off the sentinel message.
      if (deps.preflightAuth && (await deps.preflightAuth(kind).catch((): ProviderAuth => "unknown")) === "signed-out") {
        throw new ProviderAuthRequiredError(kind)
      }
      // Codex needs the `codex` executable, not just a credential. Probe it here, in the same
      // zero-trace window as the auth preflight, so a missing binary fails with an actionable message
      // BEFORE any scratchpad/registry state is created — instead of proceeding to a deep app-server
      // "daemon exited before it became ready". Fails open on "unknown" (see readCodexBinaryState).
      if (kind === "codex" && deps.preflightCodexBinary &&
        (await deps.preflightCodexBinary().catch((): "unknown" => "unknown")) === "missing") {
        throw new Error("Codex is not installed, or the `codex` executable is not on PATH. Install the Codex CLI and retry.")
      }
      // Title: explicit human title, else the heuristic chop. (A headless `claude -p` titling pass
      // was tried and REMOVED — print mode is going away for Max subscription auth, which is the
      // whole reason the workers run as interactive tmux sessions. Claude's own evolving ai-title
      // takes over the display name seconds after the session starts; only the slug is heuristic.)
      const title = input.title?.trim() || fallbackTitle(input.prompt)
      const base = input.slug ?? slugify(title)
      const slug = resolveSlug(frayDir, base, (s) => deps.storage.getSession(s) !== undefined)
      // Codex TUI does not reliably emit either a native title or Fray's requested hidden marker.
      // Keep the already bounded, deterministic dispatch title as the durable automatic fallback.
      // Unlike the full composed prompt, fallbackTitle is capped and topic-oriented; a later valid
      // provider/Fray signal may still replace it through the title_auto CAS.
      const registryTitle = title
      const sessionId = randomUUID()
      const permissionMode = workerDispatchPermission(kind, settings)
      // Resolve the profile ONCE for this session. It feeds both the CLI argv and the persisted row,
      // so the thread UI describes what this dispatch actually launched with rather than whatever the
      // mutable global defaults happen to be when the drawer is opened later.
      const model = input.model ?? settings.model
      const effort = input.effort ?? settings.effort
      const planPath = validPlanPath(deps.project.dir, input.planPath)

      // Session-first: provision the scratchpad (the durable working memory) — NO .fray/<slug>.md file.
      // The scratchpad keys on the fray-minted sessionId, which stays the row's session_id for BOTH
      // backends (codex's discovered rollout id is pinned separately on agent_session_id).
      const scratchRel = writeScratchpad(deps.project.dir, sessionId, title, kind)

      const prompt = composePrompt(sessionId, input.prompt, kind)
      const runtimeGate = settings.runtimeGate !== false

      // Codex app-server transport: a PERSISTED JSON-RPC session + the prompt as its first turn. No
      // tmux pane and no rollout discovery — the bridge returns the codex session id, which the tailer
      // locates on disk exactly like a discovered rollout (identical filename suffix). This is the SOLE
      // codex transport: the tmux TUI path was retired, so a codex dispatch that can't reach the bridge
      // fails loudly rather than degrading. The worker contract + scratchpad orientation ride
      // baseInstructions, and the fray title protocol rides developerInstructions.
      if (kind === "codex") {
        const bridge = deps.codexAppServer
        if (!bridge) {
          cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
          throw new Error("Codex app-server is unavailable; cannot start this thread. Check that `codex` is installed and its app-server protocol matches the pinned revision (re-pin if you upgraded codex).")
        }
        const extraSystemPrompt = [scratchpadOrientation(sessionId, planPath, kind), frayConfigBlock(deps.project.dir)]
          .filter(Boolean).join("\n\n")
        try {
          const spawned = await bridge.spawnDispatch({
            threadSlug: slug,
            sessionId,
            cwd: deps.project.dir,
            prompt,
            model,
            effort,
            sandbox: codexSandbox(permissionMode) as "read-only" | "workspace-write" | "danger-full-access",
            baseInstructions: [loadWorkerPrompt("codex", runtimeGate), extraSystemPrompt].filter(Boolean).join("\n\n"),
            developerInstructions: CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS,
            config: { model_reasoning_summary: "detailed", ...codexScratchpadHookConfig(scratchpadHookScript(), sessionId) },
          })
          deps.storage.upsertSession({
            slug,
            session_id: sessionId,
            tmux_name: tmuxSessionName(slug),
            spawned_at: new Date().toISOString(),
            last_read_at: null,
            unread: 0,
            exited: 0,
            archived: 0,
            rested_at: null,
            title_auto: input.title?.trim() ? 0 : 1,
            title_locked: 0, // a caller's hard-coded title is not a human's — the worker may rename it
            title: registryTitle,
            state: "open",
            meta: null,
            seen_at: null,
            plan_path: planPath,
            transcript_id: null,
            model: model ?? null,
            effort: effort ?? null,
            permission_mode: permissionMode,
          })
          deps.storage.setBackend(slug, "codex")
          // The codex SESSION id (not the thread id) matches the rollout filename the tailer scans for.
          deps.storage.setAgentSession(slug, spawned.binding.codexSessionId)
          deps.storage.setCodexRuntime(slug, "app-server")
          void deps.board.rebuild().catch(() => {})
          return { slug, sessionId }
        } catch (err) {
          // No tmux fallback — the app-server is the sole codex transport. If it can't be reached (or the
          // installed codex drifted from the pinned protocol), fail LOUDLY with an actionable hint rather
          // than silently degrading to the retired TUI path. Clean up the scratchpad + any partial bridge
          // binding so a failed dispatch leaves no trace.
          try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch { /* best-effort */ }
          cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
          throw new Error(`Codex app-server could not start this thread: ${(err as Error).message}. Check that \`codex\` is installed and its app-server protocol matches the pinned revision (re-pin if you upgraded codex).`)
        }
      }

      // Claude session-broker transport: a DETACHED daemon owns the Claude Agent SDK session over a
      // local socket, so the session OUTLIVES fray — a restart reconnects to the LIVE session instead
      // of cold resume-from-disk — while keeping structured TYPED permissions (no tmux pane, no PTY, no
      // TUI scraping). Gated behind FRAY_CLAUDE_BROKER_BRIDGE until the cutover is proven live; when off
      // (or the bridge is absent, e.g. tests), claude falls through to the tmux path below, byte-identical
      // to before. The worker contract + scratchpad orientation ride the appended system prompt, and
      // persistSession makes the daemon write the tailer-readable transcript JSONL — read exactly like
      // any tmux claude thread — so the board/tailer treat this row as headless via isHeadlessRow.
      if (kind === "claude" && deps.claudeBroker && claudeBrokerBridgeEnabled()) {
        const bridge = deps.claudeBroker
        const appendSystemPrompt = [
          loadWorkerPrompt("claude", runtimeGate),
          scratchpadOrientation(sessionId, planPath, kind),
          frayConfigBlock(deps.project.dir),
        ].filter(Boolean).join("\n\n")
        try {
          await bridge.spawnDispatch({
            threadSlug: slug,
            sessionId,
            cwd: deps.project.dir,
            prompt,
            permissionMode,
            appendSystemPrompt,
            model,
            effort,
          })
          deps.storage.upsertSession({
            slug,
            session_id: sessionId,
            tmux_name: tmuxSessionName(slug),
            spawned_at: new Date().toISOString(),
            last_read_at: null,
            unread: 0,
            exited: 0,
            archived: 0,
            rested_at: null,
            title_auto: input.title?.trim() ? 0 : 1,
            title_locked: 0, // a caller's hard-coded title is not a human's — the worker may rename it
            title: registryTitle,
            state: "open",
            meta: null,
            seen_at: null,
            plan_path: planPath,
            transcript_id: null,
            model: model ?? null,
            effort: effort ?? null,
            permission_mode: permissionMode,
          })
          deps.storage.setBackend(slug, "claude")
          deps.storage.setClaudeRuntime(slug, "broker")
          void deps.board.rebuild().catch(() => {})
          return { slug, sessionId }
        } catch (err) {
          // No tmux fallback once we've committed to the broker for this dispatch: fail LOUDLY and leave
          // no trace. Release any partial daemon binding and roll back the scratchpad.
          try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch { /* best-effort */ }
          cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
          throw new Error(`Claude session broker could not start this thread: ${(err as Error).message}.`)
        }
      }

      const built = buildSpawnCommand({
        sessionId,
        slug,
        permissionMode,
        model,
        effort,
        prompt,
        extraSystemPrompt: [scratchpadOrientation(sessionId, planPath, kind), frayConfigBlock(deps.project.dir)].filter(Boolean).join("\n\n"),
        kind,
        runtimeGate,
        contextWindow: settings.contextWindow,
      })

      // Spawn BEFORE writing the registry row so a spawn failure never strands a contentless row on
      // the board (C1). If the spawn throws, roll back the scratchpad we just provisioned too — a
      // failed dispatch must leave NO trace (no orphan row, no litter) — then surface the concise error.
      ensureServer()
      try {
        writePrewrites(built)
        spawn(slug, built.argv, deps.project.dir, { ...built.env, FRAY_UI_THREAD: slug, [PERM_DIR_ENV]: permRequestDir(deps.project) })
      } catch (err) {
        if (err instanceof tmux.TmuxSpawnError && err.identity) {
          try {
            killPane(err.identity)
          } catch {
            // Exact generation only; never fall back to the reusable slug.
          }
        }
        cleanupDispatchFiles(scratchRel, built, sessionId)
        throw err
      }

      deps.storage.upsertSession({
        slug,
        session_id: sessionId,
        tmux_name: tmuxSessionName(slug),
        spawned_at: new Date().toISOString(),
        last_read_at: null,
        unread: 0,
        exited: 0,
        archived: 0,
        // Backend telemetry becomes the display name either way. Without a caller title the stored
        // text is a machine guess the UI must not present as a name (title_auto); WITH one it reads as
        // a real name until the worker supplies a better one — never as a human's choice, so it stays
        // unlocked. Claude retains its historical fallback.
        rested_at: null,
        title_auto: input.title?.trim() ? 0 : 1,
        title_locked: 0,
        title: registryTitle,
        state: "open",
        meta: null,
        seen_at: null,
        plan_path: planPath,
        transcript_id: null,
        model: model ?? null,
        effort: effort ?? null,
        permission_mode: permissionMode,
      })

      // Respond immediately — the client switches views on the slug; the rebuild fans out over the
      // socket moments later.
      //
      // setImmediate, not a bare call: `rebuildOnce` is declared async but its body contains no
      // await (expireDue → recomputeLegacyTerminalState → recomputePlans → assemble → publish are
      // all synchronous, and the middle two stat the filesystem per registry row). So invoking it
      // ran the WHOLE rebuild before the promise was returned, and `void` deferred nothing — the
      // dispatch response sat behind a full board assembly over every session row. Handing it to the
      // next tick is what the comment above always claimed the code did.
      setImmediate(() => void deps.board.rebuild().catch(() => {}))
      return { slug, sessionId }
    },

    async adopt(slug, message) {
      const unavailable = () => new Error("thread is not available for adoption")
      const parsed = AdoptThreadInput.safeParse({ slug, message })
      if (!parsed.success) throw unavailable()
      slug = parsed.data.slug
      message = parsed.data.message

      // Authorization is deliberately reconstructed from current raw inputs instead of trusting a
      // browser affordance or the BoardManager cache: exact direct file identity + one fresh, valid,
      // nonterminal, unowned, agentless board row + no registry/tmux owner. Every precondition shares
      // one non-oracular failure and occurs before ensureServer, scratch creation, spawn, or storage.
      const source = resolveLegacyThreadFile(deps.project.dir, slug)
      if (!source) throw unavailable()
      let freshBoard: FrayBoard
      try {
        freshBoard = await readBoardSource(deps.project.dir)
        if (!boardAuthorizesAdoption(freshBoard, slug)) throw unavailable()
      } catch {
        throw unavailable()
      }
      // A registry row owns its slug regardless of whether its worker is currently alive, exited, or
      // archived. Adoption is a cold-start path, never a replacement/resume path.
      try {
        if (deps.storage.getSession(slug)) throw unavailable()
      } catch {
        throw unavailable()
      }

      // Retry performs the same leased reconciliation as boot. A stale attempt can be removed only
      // after its token is absent (or its exact tuple was killed); an active/finalized/conflicted claim
      // remains authoritative and returns the same non-oracular response as every other ineligible row.
      try {
        const outcome = reconcileAdoptionClaims({
          storage: deps.storage,
          projectDir: deps.project.dir,
          now: deps.adoptionNow,
          runtime: adoptionRuntime,
          slug,
        }).get(slug)
        // A retired-token orphan has no live claim by design. Its reconciliation outcome is therefore
        // an independent ownership fence: do not infer safety solely from the row/claim registry.
        if (outcome && outcome !== "recovered-stale-attempt") throw unavailable()
        if (deps.storage.getSession(slug) || deps.storage.getAdoptionClaim(slug)) throw unavailable()
      } catch {
        throw unavailable()
      }

      // `hasSession` deliberately includes remain-on-exit panes. Even a dead name collision is safer to
      // surface than to name-kill: another process may be concurrently registering/replacing it, and a
      // slug-targeted cleanup could destroy the wrong worker. tmux's atomic new-session name claim is the
      // second line of defense if a worker appears immediately after this check.
      try {
        if (hasSession(slug)) throw unavailable()
      } catch {
        throw unavailable()
      }
      const recheckedSource = resolveLegacyThreadFile(deps.project.dir, slug)
      if (!recheckedSource || !sameFileStat(source, recheckedSource)) throw unavailable()

      const settings = deps.getSettings()
      const sessionId = randomUUID()
      const attemptToken = deps.adoptionAttemptToken?.() ?? randomUUID()
      const now = deps.adoptionNow ?? Date.now
      const reservedAtMs = now()
      try {
        if (!deps.storage.reserveAdoptionClaim({
          slug,
          attemptToken,
          sessionId,
          reservedAtMs,
          leaseExpiresAtMs: reservedAtMs + ADOPTION_ATTEMPT_LEASE_MS,
        })) {
          throw unavailable()
        }
      } catch {
        throw unavailable()
      }

      let scratchRel: string | undefined
      let built: BuiltCommand | undefined
      let spawnedIdentity: tmux.PaneIdentity | undefined
      const rollback = (identity = spawnedIdentity): void => {
        let abandoned = false
        try {
          abandoned = abandonAdoptionAttempt({
            storage: deps.storage,
            projectDir: deps.project.dir,
            slug,
            attemptToken,
            sessionId,
            identity,
            runtime: adoptionRuntime,
          })
        } catch {
          // Leave the durable claim for boot recovery if tmux/storage is temporarily unavailable.
        }
        if (!abandoned) return
        if (scratchRel && built) cleanupDispatchFiles(scratchRel, built, sessionId)
        else cleanupAdoptionSessionFiles(deps.project.dir, sessionId)
      }

      // The adoption orientation is SYSTEM-level (the visible transcript carries only the human's own
      // words). Session-first: the legacy file is prior CONTEXT to read first, NOT a contract to maintain
      // — the worker works session-first from here (scratchpad + end-of-turn fences), leaving the file's
      // frontmatter untouched.
      const adoption =
        "ADOPTION: this thread predates you and has prior context recorded in `.fray/" +
        slug +
        ".md` (a previous agent or session worked it — you have no access to that conversation, and you don't need it). READ THAT FILE FIRST for context: `## Goal` is the mission, `## Status`/`## Decisions`/`## Next step` are where things stand. It is CONTEXT, not a contract — do NOT edit its frontmatter. You work session-first from here: keep your working state in your scratchpad and signal end-of-turn with the done/awaiting fences. The human's message below is your steer on top of that context."
      const task = message?.trim() || "Pick up this thread and continue from where the file says things stand."
      // Provision a scratchpad too (the adopted worker's durable memory); the legacy file stays read-only.
      try {
        scratchRel = writeScratchpad(deps.project.dir, sessionId, slug)
      } catch {
        rollback()
        throw unavailable()
      }
      const prompt = composePrompt(sessionId, task)
      const permissionMode = workerDispatchPermission("claude", settings)
      const runtimeGate = settings.runtimeGate !== false
      try {
        built = buildSpawnCommand({
          sessionId,
          slug,
          permissionMode,
          model: settings.model,
          effort: settings.effort,
          prompt,
          extraSystemPrompt: [scratchpadOrientation(sessionId), frayConfigBlock(deps.project.dir), adoption].filter(Boolean).join("\n\n"),
          runtimeGate,
          contextWindow: settings.contextWindow,
        })
      } catch {
        rollback()
        throw unavailable()
      }

      // Keep the authorized file identity stable through local provisioning and server startup. If
      // either step loses the source, remove only this UUID-keyed scratch/prewrite set and never spawn.
      const beforeEnsure = resolveLegacyThreadFile(deps.project.dir, slug)
      if (!beforeEnsure || !sameFileStat(source, beforeEnsure)) {
        rollback()
        throw unavailable()
      }
      try {
        ensureServer()
      } catch {
        rollback()
        throw unavailable()
      }
      const beforeSpawn = resolveLegacyThreadFile(deps.project.dir, slug)
      if (!beforeSpawn || !sameFileStat(source, beforeSpawn)) {
        rollback()
        throw unavailable()
      }

      // The durable reservation predates new-session. The attempt token is installed by new-session
      // itself; its returned tuple is synchronously committed before either follow-up setup command.
      // Thus every post-create failure is recoverable even if this process is killed at the boundary.
      try {
        writePrewrites(built)
        const fenced = deps.storage.withAdoptionSpawnFence(
          slug,
          attemptToken,
          now() + ADOPTION_ATTEMPT_LEASE_MS,
          (bindPane) => spawn(
            slug,
            built!.argv,
            deps.project.dir,
            { ...built!.env, FRAY_UI_THREAD: slug, [PERM_DIR_ENV]: permRequestDir(deps.project) },
            {
              adoptionAttemptToken: attemptToken,
              onCreated: (identity) => {
                spawnedIdentity = identity
                const observedAt = now()
                if (!bindPane(identity, observedAt + ADOPTION_ATTEMPT_LEASE_MS)) {
                  throw new Error("adoption claim lost before pane binding")
                }
              },
            },
          ),
        )
        if (!fenced.acquired) throw new Error("adoption claim retired before spawn")
        spawnedIdentity = fenced.value
      } catch (error) {
        const identity = spawnedIdentity ?? (error instanceof tmux.TmuxSpawnError ? error.identity : undefined)
        rollback(identity)
        throw unavailable()
      }

      // Revalidate the exact identity and renew the lease across unusually slow post-create setup.
      // withAdoptionSpawnFence already rejects a spawn implementation that skipped onCreated.
      let rebound = false
      try {
        const reboundAt = now()
        rebound = deps.storage.recordAdoptionPane(
          slug,
          attemptToken,
          spawnedIdentity,
          reboundAt + ADOPTION_ATTEMPT_LEASE_MS,
        )
      } catch {
        rollback()
        throw unavailable()
      }
      if (!rebound) {
        rollback()
        throw unavailable()
      }

      const adopted = {
        slug,
        session_id: sessionId,
        tmux_name: tmuxSessionName(slug),
        spawned_at: new Date(now()).toISOString(),
        last_read_at: null,
        unread: 0,
        exited: 0,
        archived: 0,
        rested_at: null,
        title_auto: 0, // adopted threads keep their file title
        title_locked: 1, // …and that heading is human-authored, so no auto-title may overwrite it
        title: null,
        state: "open",
        meta: null,
        seen_at: null,
        plan_path: null,
        transcript_id: null,
        // Adoption starts a NEW session using the dispatch defaults in force at that moment. Pin those
        // values now; a later settings change must not relabel this adopted conversation.
        model: settings.model ?? null,
        effort: settings.effort ?? null,
        permission_mode: permissionMode,
        // Adoption always starts a fresh Claude session. Keep both identity columns in the SAME atomic
        // insert so a prior/competing Codex owner can never leak its native id into this row.
        backend: "claude",
        agent_session_id: null,
      } satisfies SessionRow

      let claimed = false
      try {
        claimed = deps.storage.finalizeAdoptionClaim(slug, attemptToken, adopted, now())
      } catch {
        rollback()
        throw unavailable()
      }
      if (!claimed) {
        rollback()
        throw unavailable()
      }

      void deps.board.rebuild().catch(() => {})
      return { slug, sessionId }
    },
  }
}
