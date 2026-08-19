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
  threadIdentityName,
  type Settings,
  type PermissionMode,
  type ProviderAuth,
} from "@frizz/shared"
import { log as frizzLog } from "./logging.ts"
import { PERM_DIR_ENV, permRequestDir, type Project } from "./project.ts"
import type { SessionRow, Storage } from "./storage.ts"
import type { BoardManager } from "./board.ts"
import type { AgentBackend, BackendKind, BuiltCommand, FrizzMcp } from "./backend/types.ts"
import { CHROME_DEVTOOLS_MCP, CLAUDE_WORKER_ENV, FRIZZ_MCP, WORKER_DISALLOWED_TOOLS, frizzMcpEnv } from "./backend/types.ts"
import { buildWorkerPrompt } from "./workerPrompt.ts"
import { codexSandbox, CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS } from "./backend/codex.ts"
import type { CodexAppServerBridge } from "./backend/codex-app-server.ts"
import { claudeBrokerBridgeEnabled, type ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import { claudeUltracodeFlags, resolveClaudeEffort } from "./backend/claude-effort.ts"
import { ProviderAuthRequiredError } from "./backend/auth-status.ts"
import { readBoard, type FrizzBoard, type FrizzThread } from "./frizz.ts"
import { SYSTEM_PROMPT_DIR, cleanupAdoptionSessionFiles, systemPromptPath } from "./session-files.ts"
import {
  ADOPTION_ATTEMPT_LEASE_MS,
  abandonAdoptionAttempt,
  reconcileAdoptionClaims,
  type AdoptionRecoveryRuntime,
  productionRuntime as productionAdoptionRuntime,
} from "./adoption-recovery.ts"

// Dispatch = provision the thread's scratch DIRECTORY + compose the full prompt + fork a detached
// BROKER DAEMON for the session + register the session row. NOT tmux: this file still says the word
// thirty times in comments below, all of them describing a path that no longer exists (there is no
// tmux.ts and dispatch never execs tmux — see the invariant in ARCHITECTURE.md). A Claude thread is
// `claude_runtime="broker"`, forked by claude-broker-host.ts with `detached: true`.
// Session-first (2026-07-09): a new dispatch
// writes NO .frizz/<slug>.md thread file — the session IS the thread, and it gets an empty folder
// (.frizz/threads/<sessionId>/) to use as it likes. The prompt is the ONLY intelligence: the worker
// contract + this repo's FRIZZ.md + the scratch orientation + the task. Project-specific conventions
// live in FRIZZ.md alone — the old settings `dispatchPreamble` was retired in favour of it, so there is
// exactly ONE operator-authored surface.

// title -> slug. The rule itself lives in @frizz/shared beside the ThreadSlug contract (the
// registry's boot repair recognises dispatch-minted slugs with it); re-exported here because every
// caller reaches for it through the dispatcher.
export { slugify }

// Derive a concrete thread title from the prompt when the human didn't supply one: the first ~6
// words of the prompt's first line, capped at 48 chars, ellipsized if anything was dropped. The
// thread FILE always needs a title (frizz requires one) and the slug derives from it, so this never
// returns empty. Claude later renames the session (ai-title), which the UI prefers for display.
// Leading filler that carries no topic ("also spin up…", "please go ahead and…") and trailing
// function words a truncation must never end on (the old first-6-words cut produced slugs like
// "also-spin-up-a-sub-agent-to" — a dangling mid-phrase chop that reads as garbage in .frizz/).
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

// First free slug: <base>, then <base>-2, -3, … skipping any existing .frizz/<slug>.md AND any taken
// registry slug (session-first: new dispatches have no .frizz file, so uniqueness must also clear the
// storage rows — else two fileless sessions could collide on a slug). `taken` is the row predicate.
export function resolveSlug(frizzDir: string, base: string, taken?: (slug: string) => boolean): string {
  base = ThreadSlug.parse(base)
  const isTaken = (slug: string) => existsSync(join(frizzDir, `${slug}.md`)) || (taken?.(slug) ?? false)
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

// Resolve an adoption source without ever accepting an indirect path. Both `.frizz` and the selected
// markdown file must be real (not symlink) direct children of the real project root. Reading the file
// into the identity digest closes replacement/content races across the fresh-board authorization pass.
export function resolveLegacyThreadFile(projectDir: string, value: unknown): LegacyThreadFileIdentity | null {
  const parsed = ThreadSlug.safeParse(value)
  if (!parsed.success) return null
  try {
    const projectRoot = realpathSync(projectDir)
    const frizzPath = join(projectRoot, ".frizz")
    const frizzStat = lstatSync(frizzPath)
    if (!frizzStat.isDirectory() || frizzStat.isSymbolicLink()) return null
    const realFrizz = realpathSync(frizzPath)
    if (dirname(realFrizz) !== projectRoot || basename(realFrizz) !== ".frizz") return null

    const path = join(realFrizz, `${parsed.data}.md`)
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink()) return null
    const realPath = realpathSync(path)
    if (dirname(realPath) !== realFrizz || basename(realPath) !== `${parsed.data}.md`) return null
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

export function isAdoptableLegacyBoardThread(thread: FrizzThread, slug: string): boolean {
  return thread.id === slug &&
    ADOPTABLE_LEGACY_STATUSES.has(thread.status) &&
    thread.owner == null &&
    Array.isArray(thread.agents) && thread.agents.length === 0 &&
    Array.isArray(thread.errors) && thread.errors.length === 0
}

function boardAuthorizesAdoption(board: FrizzBoard, slug: string): boolean {
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

// ---- THE THREAD SCRATCH DIRECTORY ----------------------------------------------------------------
// `.frizz/threads/<sessionId>/` — a folder the worker and its sub-agents may use however they like, and
// nothing more than that. NOTHING is provisioned into it: no skeleton, no reserved filename, no format.
//
// It REPLACED a canonical `scratch.md` (2026-08-06, maintainer's call). That pad was one file every
// worker was told to maintain, whose head a hook spliced into the context after a compaction, and whose
// sharing with sub-agents needed a whole merge-only contract — an epilogue per backend, a legend line in
// every provisioned pad, and a paragraph of the worker contract — all of it existing only to stop
// children clobbering the one file. A folder deletes that surface outright: each agent writes its OWN
// file, so there is nothing to merge and nothing to clobber.
//
// What replaced the compaction injection is `mcp__frizz__recurring_prompt`'s POST-COMPACTION trigger
// (scheduler SOURCE 7). The worker links whatever doc it wrote here and frizz hands that link back the
// moment the context is summarized away. Durable in SQLite, and visible to the operator — which the hook
// injection never was.
export function scratchDirRelPath(sessionId: string): string {
  return `.frizz/threads/${sessionId}`
}

// Provision the thread's scratch directory. Creates the folder and NOTHING inside it, returning the
// project-relative path. sessionId is a fresh UUID at both dispatch and adopt, so this never collides.
export function writeScratchDir(projectDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId)) throw new Error("invalid session id")
  const projectRoot = realpathSync(projectDir)
  const frizzDir = ensureSafeDirectDirectory(projectRoot, ".frizz")
  const threadsDir = ensureSafeDirectDirectory(frizzDir, "threads")
  ensureSafeDirectDirectory(threadsDir, sessionId)
  return scratchDirRelPath(sessionId)
}

// The FIXED worker system prompt for `kind`, compiled in via workerPrompt.ts (single source of truth).
// Not user-modifiable — project-specific conventions ride FRIZZ.md (frizzConfigBlock), appended
// separately. Thin adapter kept so existing callers (spawn/adopt/resume builders + tests) are untouched.
export function loadWorkerPrompt(kind: BackendKind = "claude"): string {
  return buildWorkerPrompt(kind, { monitorsDir: monitorScriptsDir() })
}

// The portable CI/review monitors, which ship inside the worker plugin (`sync-portable-monitors.mjs`
// copies `monitors/` there, and `runtime/cc-worker` carries them in a published artifact). Claude finds
// them through the `frizz:gh` skill; codex has no skills, so its prompt needs the absolute path or the
// model writes its own poll loop instead. Verified against a real file rather than assumed, so a layout
// change degrades to the prompt's relative fallback instead of naming a directory that isn't there.
export function monitorScriptsDir(): string | undefined {
  const plugin = workerPluginDir()
  if (!plugin) return undefined
  const dir = join(plugin, "skills", "gh", "scripts")
  return existsSync(join(dir, "ci-watch.mjs")) ? dir : undefined
}

// ---- scratch-directory re-orientation (always on) ----
// Deliberately NOT settings-gated. A worker that has just lost its context should always be told what
// it left itself, and that is not a posture a project opts into. Claude needs no plumbing at all here
// (the plugin's hooks.json is always registered); codex does, because its hooks can only arrive as
// per-conversation config.
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
  // `--session` is mandatory: codex reports its OWN rollout session id to the hook, so without frizz's
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
          command: `node ${JSON.stringify(bashBackgroundHook)} --frizz-thread`,
        }],
      }],
      // Native Codex children inherit the root scratch-directory instruction even with
      // `fork_turns:"none"`. Constrain it structurally at child start: its OWN file, never another
      // agent's.
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

// The first USER message a dispatched agent receives: scratch-directory orientation + custom
// instructions + task. Session-first (2026-07-09) — the old thread-ownership contract is REPLACED by
// this orientation (a new dispatch owns no .frizz file). The fixed worker prompt (workerPrompt.ts) and
// the same scratch line at SYSTEM level travel via --append-system-prompt (see buildClaudeCommand) so
// they survive compaction and re-apply on resume; this composes the visible-message half.
export function composePrompt(sessionId: string, prompt: string, kind: BackendKind = "claude"): string {
  // The sub-agent clause is the ONE thing that differs between backends here: Claude's children are
  // dispatched with a prompt this worker writes, so it must be told to name the directory in it; codex's
  // native children inherit the conversation and already have it.
  const children =
    kind === "codex"
      ? "Native sub-agents share it — have each write its OWN file rather than all editing one."
      : "Name it in a sub-agent's prompt when you want its notes to land somewhere you can read; give each child its OWN file rather than having them all edit one."
  const scratch =
    `Your scratch directory is \`.frizz/threads/${sessionId}/\` — yours to use however you like, for as many files as you like. It is EMPTY and nothing is expected in it: a single direct task usually needs nothing, and writing notes is never a substitute for doing the work. ${children} On a long effort, write the doc you would want if you lost your context — the approach, what you rejected, the human's decisions — and then ARM \`mcp__frizz__recurring_prompt\` with \`post_compaction: true\` and a prompt that LINKS that file, so frizz hands it back the moment your context is compacted. Nothing here is read automatically; the link you arm is what survives.`
  // The banner makes the system→human handoff unmistakable to the worker, and NOTHING of frizz's is
  // allowed below it: the framing note goes here, ABOVE, so everything past the banner is the
  // operator's prompt byte for byte. That is also what the transcript projectors cut on
  // (DISPATCH_TASK_BANNER_MARKER), so the first chat bubble shows the operator's words alone.
  const handoff =
    "\n\nEverything above the banner below is frizz system orientation. Everything below it is the human operator's own prompt, verbatim — that, and nothing else, is your task."
  return `${scratch}${handoff}\n\n\n${DISPATCH_TASK_BANNER_MARKER}${prompt}`
}

// The SYSTEM-level scratch-directory orientation (survives compaction, rebuilds on every resume): the
// scratch line, plus a PLAN line when the thread is associated with a plan artifact. Passed as
// extraSystemPrompt on dispatch, adopt, AND the followUp resume path.
//
// It names the POST-COMPACTION trigger deliberately. This text is one of the few things that reliably
// reaches a worker after a resume, and a scratch directory nothing ever reads back is a folder of notes
// nobody opens — the arming is what turns it into compaction insurance.
export function scratchpadOrientation(sessionId: string, planPath?: string | null, kind: BackendKind = "claude"): string {
  const children =
    kind === "codex"
      ? "native sub-agents share it, so give each its own file"
      : "name it in a sub-agent's prompt when you want its notes back, and give each child its own file"
  const scratch =
    `SCRATCH DIRECTORY: .frizz/threads/${sessionId}/ — yours, free-form, as many files as you like, and nothing is expected in it. A single direct task usually needs none; writing notes is never a substitute for doing the work. On a long effort write the doc you would want if you lost your context (${children}), then arm mcp__frizz__recurring_prompt with post_compaction: true and a prompt LINKING that file — frizz hands the link back when your context is compacted. Nothing in this directory is read automatically.`
  const lines = [scratch]
  if (planPath) lines.push(`PLAN: ${planPath} — the durable plan artifact this thread works from; read it FIRST.`)
  return lines.join("\n")
}

// A project can ship a repo-committed `FRIZZ.md` at its root to steer frizz workers with its OWN
// engineering-PROCESS norms — gates, review depth, commit/PR conventions — which OVERRIDE frizz's
// built-in PROCESS defaults (NOT the frizz-mechanical contract: signal fences, scratchpad, sub-agent
// dispatch and the question handback stay in force — the injected header says so, matching the "Defer"
// section of the worker contract). When present, its contents are injected into every worker's SYSTEM
// prompt (dispatch, adopt, AND resume; both backends) under that header, so both see it without relying on the
// agent choosing to open the file. Read fresh on every spawn/resume, so an edit takes effect on the
// next launch.
//
// The read is guarded by statSync BEFORE readFileSync: only a regular file under a size cap is read.
// That keeps one accidental/hostile FRIZZ.md from wedging the server's event loop on EVERY dispatch and
// resume — a FIFO would make readFileSync block forever, a symlink loop throws, a directory/device
// isn't a regular file, and a runaway/generated file is rejected by size rather than fully slurped.
// The surviving content is then clipped to keep token/context cost bounded. Returns "" when
// absent/oversized/non-regular/empty — the caller drops it from the composed extra-system-prompt.
const FRIZZ_MD_MAX_CHARS = 12_000
const FRIZZ_MD_MAX_BYTES = 64 * 1024
export function frizzConfigBlock(projectDir: string): string {
  const path = join(projectDir, "FRIZZ.md")
  let body: string
  try {
    const st = statSync(path) // follows a symlink to its target; ENOENT/ELOOP throw → caught
    if (!st.isFile() || st.size > FRIZZ_MD_MAX_BYTES) return "" // not a regular file, or runaway size
    body = readFileSync(path, "utf8").trim()
  } catch {
    return "" // no FRIZZ.md, unreadable, symlink loop, etc. → inject nothing
  }
  if (!body) return ""
  const clipped = body.length > FRIZZ_MD_MAX_CHARS ? `${body.slice(0, FRIZZ_MD_MAX_CHARS)}\n\n[FRIZZ.md truncated]` : body
  return `PROJECT FRIZZ CONFIG (from this repo's FRIZZ.md) — the project's own conventions for frizz workers. They OVERRIDE the frizz worker PROCESS defaults above (review depth, gates, git/PR conventions, the quality bar) wherever they conflict; follow them. They do NOT relax the frizz-mechanical contract — the signal fences, the scratchpad, sub-agent dispatch and the question handback still bind:\n\n${clipped}`
}

// A DispatchInput.planPath is honored only when it is a well-formed .frizz/plans/*.md path AND the file
// exists; anything else is ignored (stored as null). Shape check forecloses traversal.
const PLAN_PATH_RE = /^\.frizz\/plans\/[A-Za-z0-9][A-Za-z0-9._ -]*\.md$/
export function validPlanPath(projectDir: string, planPath: string | undefined): string | null {
  if (!planPath || !PLAN_PATH_RE.test(planPath)) return null
  return existsSync(join(projectDir, planPath)) ? planPath : null
}

// Workers have NO coherent interactive-plan-mode semantics: plan mode stays read-only until an
// INTERACTIVE ExitPlanMode approval, which a headless dashboard worker can't satisfy (no one is at
// the keyboard) and which blocks all edits until then — a softlock. A worker "plans" by writing a
// plan artifact (.frizz/plans/*.md) and asking via a ```question fence, never via interactive plan
// mode. So a worker is NEVER spawned in plan mode: `plan` is coerced to the safe frizz default
// (`auto`). Applied inside BOTH spawn builders so dispatch, adopt, AND resume are all covered. (The
// dispatch UI still OFFERS "plan" in its permission-mode dropdown — dropping it in web/options.ts is
// a follow-up for UI honesty; this coercion is the actual enforcement + the softlock fix.)
function workerPermissionMode(m: PermissionMode): PermissionMode {
  return m === "plan" ? "auto" : m
}

// Every frizz-CREATED worker launches maximally non-interactive: an unattended headless worker cannot
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

/** Where the frizz MCP server should look for the running server, and whose board it acts on. */
export interface FrizzMcpTarget {
  /** THIS project's state dir. Identity, and the lock path a pre-singleton server published. */
  stateDir: string
  /** The LAUNCHING project's `server.lock` — the only one this process writes. See FrizzMcp. */
  serverLock?: string
  /** THIS project's registry id, so the script addresses `/_frizz/<id>/rpc/…` and not the launcher's. */
  projectId?: string
}

// Resolve the descriptor for the unified frizz MCP server: the abs path to the stdio server script
// (shipped as a sibling of bin/frizz in the worker plugin dir, so it rides the SAME ship+resolve path
// that already carries the plugin to prod) + where the script finds the running server and which
// project it addresses. Returns undefined when the plugin dir or script can't be found — the worker
// then simply lacks the frizz tools rather than failing to spawn. `env`/`moduleUrl` injectable for
// tests. A bare state dir is still accepted (one project, one server: the pre-singleton shape).
export function resolveFrizzMcp(
  target: string | FrizzMcpTarget,
  moduleUrl = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
  slug?: string,
): FrizzMcp | undefined {
  const { stateDir, serverLock, projectId } = typeof target === "string" ? { stateDir: target } : target
  const pluginDir = resolveWorkerPluginDir(moduleUrl, env)
  if (!pluginDir) return undefined
  const scriptPath = join(pluginDir, "bin", FRIZZ_MCP.script)
  if (!existsSync(scriptPath)) return undefined
  return {
    scriptPath,
    stateDir,
    ...(serverLock ? { serverLock } : {}),
    ...(projectId ? { projectId } : {}),
    ...(slug ? { slug } : {}),
  }
}

// Claude flags that mount the frizz-injected MCP servers via ONE inline `--mcp-config` JSON and
// PRE-APPROVE their tools (`--allowedTools`) so a headless worker never blocks on a permission prompt
// it has nobody to answer. execvp runs the argv with NO shell (tmux.ts), so the JSON travels literally.
// chrome-devtools is ALWAYS mounted (a worker gets a browser out of the box on any
// machine — parity with the codex backend's `-c` injection, same CHROME_DEVTOOLS_MCP spec); the
// server-level `mcp__chrome-devtools` rule pre-approves every tool it exposes. The unified `frizz`
// server rides along when its descriptor resolved, pre-approved the same server-level way.
export interface ClaudeMcpStdioConfig { command: string; args?: string[]; env?: Record<string, string> }
export interface ClaudeMcpConfig { mcpServers: Record<string, ClaudeMcpStdioConfig>; allowedTools: string[] }

// The structured frizz MCP mount, shared by the tmux CLI path (rendered to --mcp-config/--allowedTools
// flags below) AND the broker SDK path (passed straight into query()'s mcpServers/allowedTools). One
// source of truth so both transports mount the SAME servers with the SAME pre-approvals.
export function claudeMcpConfig(mcp?: FrizzMcp): ClaudeMcpConfig {
  const mcpServers: Record<string, ClaudeMcpStdioConfig> = {
    [CHROME_DEVTOOLS_MCP.name]: { command: CHROME_DEVTOOLS_MCP.command, args: [...CHROME_DEVTOOLS_MCP.args] },
  }
  const allowedTools = [`mcp__${CHROME_DEVTOOLS_MCP.name}`]
  if (mcp) {
    // command is the ABSOLUTE node path (process.execPath — the node running the frizz server), NOT bare
    // "node": Claude spawns the MCP-server process itself, and a worker's PATH varies by launch context
    // (a GUI-launched tmux, a login-shell difference) — if `node` isn't on it, the MCP server never
    // starts and the tool silently never appears in the worker. An absolute path removes that dependency.
    // FRIZZ_THREAD_SLUG is the MCP server's CALLER IDENTITY — the channel through which a tool could act
    // on its own thread. The MCP server is spawned per worker and nothing in the MCP protocol carries a
    // caller identity, so its env is the only place this can come from; a resume keeps the same slug, so
    // it stays correct for the whole life of the thread. No SHIPPED tool reads it today (the one that
    // did, a worker-armed heartbeat, was removed 2026-08-02 in favour of the operator's stop hook, which
    // the board arms directly). Kept because it costs one line and is the whole prerequisite for any
    // future thread-scoped tool.
    // FRIZZ_SERVER_LOCK and FRIZZ_PROJECT_ID (frizzMcpEnv) are what make the tools work in a project
    // the singleton did NOT launch from: the first says where the one published lock is, the second
    // says whose board to act on. Both omitted ⇒ the script keeps its original behaviour (this
    // project's own lock, unprefixed RPC), which is exactly right for one project on its own server.
    const env = frizzMcpEnv(mcp)
    mcpServers[FRIZZ_MCP.name] = { command: process.execPath, args: [mcp.scriptPath], env }
    // Server-level, like chrome-devtools above: every tool the unified frizz server exposes (today
    // `mcp__frizz__spawn_thread`) is pre-approved, so adding one never needs an allow-list edit.
    allowedTools.push(`mcp__${FRIZZ_MCP.name}`)
  }
  return { mcpServers, allowedTools }
}

// Claude flags that mount the frizz-injected MCP servers via ONE inline `--mcp-config` JSON and
// PRE-APPROVE their tools (`--allowedTools`) so a headless worker never blocks on a permission prompt
// it has nobody to answer. execvp runs the argv with NO shell (tmux.ts), so the JSON travels literally.
// chrome-devtools is ALWAYS mounted (a worker gets a browser out of the box on any
// machine — parity with the codex backend's `-c` injection, same CHROME_DEVTOOLS_MCP spec); the
// server-level `mcp__chrome-devtools` rule pre-approves every tool it exposes. The unified `frizz`
// server rides along when its descriptor resolved, pre-approved the same server-level way.
export function claudeMcpFlags(mcp?: FrizzMcp): string[] {
  const { mcpServers, allowedTools } = claudeMcpConfig(mcp)
  const config = JSON.stringify({ mcpServers })
  // ONE comma-joined `--allowedTools=` in EQUALS form: the flag is VARIADIC, so a space-separated
  // value with a positional right behind it (e.g. the minimal no-system-prompt argv, where the prompt
  // directly follows) would be swallowed as a second rule. The equals form binds exactly one token —
  // immune to argv reordering. Verified live: `claude -p --allowedTools=mcp__chrome-devtools <prompt>`
  // runs the tools unprompted with the prompt surviving as the positional.
  return ["--mcp-config", config, `--allowedTools=${allowedTools.join(",")}`]
}

// A frizz worker runs under a dashboard, not a live chat, so a BLOCKING question tool would hang the
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
  frizzMcp?: FrizzMcp
}): string[] {
  const argv = [opts.claudeBin ?? "claude", "--session-id", opts.sessionId, "--permission-mode", workerPermissionMode(opts.permissionMode)]
  // NO 1M window here, deliberately. The broker spawn requests it (claude-context-window.ts), but only
  // because it can pair the request with `fallbackModel` — and `--fallback-model` is documented
  // "(only works with --print)", which this interactive argv is not. An unpaired `[1m]` is a hard 400
  // that kills the session on any subscription without the long-context beta, so this path asks for
  // nothing. It costs no live thread: every claude row is stamped claude_runtime="broker" at dispatch
  // and never migrated (isBrokerClaudeRow), so this argv is the legacy transport.
  if (opts.model) argv.push("--model", opts.model)
  // "ultracode" is a settings flag, not an --effort value, and it only takes when the pinned effort is
  // xhigh — see resolveClaudeEffort.
  const effort = resolveClaudeEffort(opts.effort)
  if (effort.effort) argv.push("--effort", effort.effort)
  argv.push(...claudeUltracodeFlags(effort))
  if (opts.pluginDir) argv.push("--plugin-dir", opts.pluginDir)
  argv.push(...claudeMcpFlags(opts.frizzMcp))
  argv.push(...workerDisallowedToolFlags())
  // The fixed worker norms live in the SYSTEM prompt: rebuilt on every invocation (incl. resume)
  // and immune to compaction, unlike a first user message.
  const worker = opts.workerPrompt ?? loadWorkerPrompt()
  const system = [worker, opts.extraSystemPrompt?.trim()].filter(Boolean).join("\n\n")
  argv.push(...systemPromptFlags(opts.sessionId, system))
  argv.push(opts.prompt)
  return argv
}

// The frizz-worker plugin (single-thread worker contract + hooks), a sibling of board/ in the Frizz
// source tree. Deployed artifacts carry it at runtime/cc-worker, but pnpm may load this module
// through a nested store rather than the flat node_modules layout. Search module ancestors so the
// closure remains discoverable in either layout; an explicitly verified artifact path wins.
export function resolveWorkerPluginDir(
  moduleUrl = import.meta.url,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const override = env.FRIZZ_WORKER_PLUGIN_DIR
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

// Whether the "no worker plugin" alarm has already sounded in this process — the condition is a
// property of the INSTALL, not of any one dispatch, so it is worth exactly one loud line.
let missingPluginReported = false

/**
 * The production entry point for the plugin directory. `resolveWorkerPluginDir` stays the pure,
 * injectable one that tests drive with a synthetic module URL and legitimately expect `undefined` from.
 *
 * IT SHOUTS WHEN IT CANNOT RESOLVE, because every consumer of this value FAILS OPEN and does so in
 * silence: `if (opts.pluginDir) argv.push(…)`, `if (!pluginDir) return undefined`, `return plugin ? … :
 * undefined`. A worker dispatched without it loses the worker-contract hooks, the `frizz:*` sub-agent
 * profiles, the frizz MCP tools (spawn_thread / recurring_prompt / timer), the on-demand skills AND the
 * portable monitors — all five ride this one directory — and it still boots perfectly happily.
 * Measured against the real CLI on 2026-08-11: with the plugin dir a worker reports 16 `frizz:*` agent
 * types; with a path that does not exist it answers the prompt normally, exit 0, no error, no warning.
 * Nothing on the board would ever say so.
 *
 * That fail-open-and-say-nothing shape is not hypothetical here. The three defects a single directory
 * rename caused this week — a `core.hooksPath` into the old path, an untrusted codex project, and every
 * transcript stranded in the old bucket — were each invisible for days for exactly this reason. So the
 * one thing this MUST not do is fail quietly too.
 */
export function workerPluginDir(): string | undefined {
  const dir = resolveWorkerPluginDir()
  if (!dir && !missingPluginReported) {
    missingPluginReported = true
    frizzLog.error(
      "dispatch",
      "worker plugin NOT FOUND (no cc-worker/.claude-plugin/plugin.json among this module's ancestors, and " +
        "FRIZZ_WORKER_PLUGIN_DIR is unset or unverifiable). Workers dispatched now will silently lack the " +
        "worker contract hooks, the frizz:* sub-agent profiles, the frizz MCP tools and the portable monitors.",
    )
  }
  return dir
}

// Claude Code caps WebSearch at 200 calls per SESSION (verified in the 2.1.220 bundle:
// `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION ?? 200`, enforced in the WebSearch tool against a
// `taskRegistry` counter). A frizz worker is long-lived and research-heavy — it burns that budget on
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
//     to raise CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION". A frizz worker is long-lived and dispatches a
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
// would buy depth that frizz's own wake path cannot deliver on, so the cap and the contract agree.
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

// Claude Code reads these inherited process variables as sub-agent profile defaults. A Frizz worker
// chooses its profile explicitly through the launch argv and plugin agent profiles, so let neither
// a shell nor a globally configured Claude session silently replace that selection. Empty tmux
// environment entries override inherited values while preserving every auth/config variable.
//
// The CAPS are the deliberate exception to that masking: a profile override hijacks the worker's
// identity, but a cap is operator policy, so an explicitly configured one is passed through rather
// than overridden. They are always set EXPLICITLY (never left to inheritance) because a tmux pane
// inherits the tmux SERVER's environment — captured whenever that server first started, which may
// predate the current frizz process by days.
export function claudeWorkerEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    ...CLAUDE_WORKER_ENV,
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
  // The frizz MCP server must ride resume too (a resumed worker keeps the capability).
  frizzMcp?: FrizzMcp
}): string[] {
  const argv = [opts.claudeBin ?? "claude", "--permission-mode", workerPermissionMode(opts.permissionMode)]
  if (opts.model) argv.push("--model", opts.model)
  // Ultracode is session-scoped, so a resume must re-carry it exactly like the system prompt above.
  const effort = resolveClaudeEffort(opts.effort)
  if (effort.effort) argv.push("--effort", effort.effort)
  argv.push(...claudeUltracodeFlags(effort))
  if (opts.pluginDir) argv.push("--plugin-dir", opts.pluginDir)
  argv.push(...claudeMcpFlags(opts.frizzMcp))
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
  // Cold-adopt an EXISTING thread frizz didn't originate (e.g. a repo with a pre-existing .frizz
  // board): spawn a fresh worker pointed at the thread file. Frizz's contract makes this sound —
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
  // Inert since the broker became the only transport: dispatch spawns through the bridge, and there
  // is no pane to roll back. Both stay as accepted-and-ignored seams so existing fixtures still typecheck.
  spawn?: unknown
  killExpectedAdoptionPane?: unknown
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
  const readBoardSource = deps.readBoard ?? readBoard
  const frizzDir = join(deps.project.dir, ".frizz")
  const adoptionRuntime: AdoptionRecoveryRuntime = deps.adoptionRuntime ?? productionAdoptionRuntime

  // Build the detached-spawn command through the backend seam for the chosen `kind` (falling back to
  // the local Claude builder when no resolver is injected — identical argv). Returns argv + prewrites.


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
      // `recursive` because this is a DIRECTORY now, not one file. A failed dispatch has produced no
      // agent and therefore nothing in it, but removing it whole is what keeps a rejected dispatch from
      // leaving a trace — and the path is session-id-keyed, so it can never name another worker.
      rmSync(join(deps.project.dir, scratchRel), { force: true, recursive: true })
    } catch {
      // The session-id-keyed scratch directory is inert and never identifies another worker.
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
      const slug = resolveSlug(frizzDir, base, (s) => deps.storage.getSession(s) !== undefined)
      // Codex TUI does not reliably emit either a native title or Frizz's requested hidden marker.
      // Keep the already bounded, deterministic dispatch title as the durable automatic fallback.
      // Unlike the full composed prompt, fallbackTitle is capped and topic-oriented; a later valid
      // provider/Frizz signal may still replace it through the title_auto CAS.
      const registryTitle = title
      const sessionId = randomUUID()
      const permissionMode = workerDispatchPermission(kind, settings)
      // Resolve the profile ONCE for this session. It feeds both the CLI argv and the persisted row,
      // so the thread UI describes what this dispatch actually launched with rather than whatever the
      // mutable global defaults happen to be when the drawer is opened later.
      const model = input.model ?? settings.model
      const effort = input.effort ?? settings.effort
      const planPath = validPlanPath(deps.project.dir, input.planPath)

      // Session-first: provision the thread's scratch DIRECTORY (empty; the worker fills it or does
      // not) — NO .frizz/<slug>.md file. It keys on the frizz-minted sessionId, which stays the row's
      // session_id for BOTH backends (codex's discovered rollout id is pinned separately on
      // agent_session_id).
      const scratchRel = writeScratchDir(deps.project.dir, sessionId)

      const prompt = composePrompt(sessionId, input.prompt, kind)

      // Codex app-server transport: a PERSISTED JSON-RPC session + the prompt as its first turn. No
      // tmux pane and no rollout discovery — the bridge returns the codex session id, which the tailer
      // locates on disk exactly like a discovered rollout (identical filename suffix). This is the SOLE
      // codex transport: the tmux TUI path was retired, so a codex dispatch that can't reach the bridge
      // fails loudly rather than degrading. The worker contract + scratchpad orientation ride
      // baseInstructions, and the frizz title protocol rides developerInstructions.
      if (kind === "codex") {
        const bridge = deps.codexAppServer
        if (!bridge) {
          cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
          throw new Error("Codex app-server is unavailable; cannot start this thread. Check that `codex` is installed and its app-server protocol matches the pinned revision (re-pin if you upgraded codex).")
        }
        const extraSystemPrompt = [scratchpadOrientation(sessionId, planPath, kind), frizzConfigBlock(deps.project.dir)]
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
            baseInstructions: [loadWorkerPrompt("codex"), extraSystemPrompt].filter(Boolean).join("\n\n"),
            developerInstructions: CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS,
            config: { model_reasoning_summary: "detailed", ...codexScratchpadHookConfig(scratchpadHookScript(), sessionId) },
          })
          deps.storage.upsertSession({
            slug,
            session_id: sessionId,
            tmux_name: threadIdentityName(slug),
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
          // NO GOAL ON A BRAND-NEW THREAD (2026-08-16). Every thread used to be born with the stop-hook Goal
          // armed, because a worker that rested without signing off had nothing to bring it back. The built-in
          // handoff bump does that now — it fires on exactly the rests that need it, carries the three terminal
          // states and lists the thread's live work with the ids a fence needs — so arming a Goal as well is the
          // same nudge twice, and the maintainer called it redundant. Arming one is the FOOTER PANEL's job now,
          // and that panel prefills the default text without switching any trigger on.
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
      // local socket, so the session OUTLIVES frizz — a restart reconnects to the LIVE session instead
      // of cold resume-from-disk — while keeping structured TYPED permissions (no tmux pane, no PTY, no
      // TUI scraping). Gated behind FRIZZ_CLAUDE_BROKER_BRIDGE until the cutover is proven live; when off
      // (or the bridge is absent, e.g. tests), claude falls through to the tmux path below, byte-identical
      // to before. The worker contract + scratchpad orientation ride the appended system prompt, and
      // persistSession makes the daemon write the tailer-readable transcript JSONL — read exactly like
      // any tmux claude thread — so the board/tailer treat this row as headless via isHeadlessRow.
      // Claude session-broker transport, the SOLE claude transport — the tmux TUI path was retired,
      // so a claude dispatch that can't reach the broker fails loudly rather than degrading. Exactly
      // the shape the codex branch above already had.
      if (kind === "claude") {
        const bridge = deps.claudeBroker
        if (!bridge) {
          cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
          throw new Error("Claude session broker is unavailable; cannot start this thread.")
        }
        const appendSystemPrompt = [
          loadWorkerPrompt("claude"),
          scratchpadOrientation(sessionId, planPath, kind),
          frizzConfigBlock(deps.project.dir),
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
            tmux_name: threadIdentityName(slug),
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
          // NO GOAL ON A BRAND-NEW THREAD (2026-08-16). Every thread used to be born with the stop-hook Goal
          // armed, because a worker that rested without signing off had nothing to bring it back. The built-in
          // handoff bump does that now — it fires on exactly the rests that need it, carries the three terminal
          // states and lists the thread's live work with the ids a fence needs — so arming a Goal as well is the
          // same nudge twice, and the maintainer called it redundant. Arming one is the FOOTER PANEL's job now,
          // and that panel prefills the default text without switching any trigger on.
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

      // Both backends have exactly one transport now (codex → app-server, claude → broker) and each
      // branch above either returns or throws. A `kind` outside that pair is a programming error, not
      // a runtime state a dispatch should silently degrade on.
      cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
      throw new Error(`unsupported backend for dispatch: ${String(kind)}`)
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
      let freshBoard: FrizzBoard
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
      const rollback = (): void => {
        let abandoned = false
        try {
          abandoned = abandonAdoptionAttempt({
            storage: deps.storage,
            projectDir: deps.project.dir,
            slug,
            attemptToken,
            sessionId,
            runtime: adoptionRuntime,
          })
        } catch {
          // Leave the durable claim for boot recovery if storage is temporarily unavailable.
        }
        if (!abandoned) return
        if (scratchRel) cleanupDispatchFiles(scratchRel, { argv: [], env: {}, prewrite: [] }, sessionId)
        else cleanupAdoptionSessionFiles(deps.project.dir, sessionId)
      }

      // The adoption orientation is SYSTEM-level (the visible transcript carries only the human's own
      // words). Session-first: the legacy file is prior CONTEXT to read first, NOT a contract to maintain
      // — the worker works session-first from here (scratchpad + end-of-turn fences), leaving the file's
      // frontmatter untouched.
      const adoption =
        "ADOPTION: this thread predates you and has prior context recorded in `.frizz/" +
        slug +
        ".md` (a previous agent or session worked it — you have no access to that conversation, and you don't need it). READ THAT FILE FIRST for context: `## Goal` is the mission, `## Status`/`## Decisions`/`## Next step` are where things stand. It is CONTEXT, not a contract — do NOT edit its frontmatter. You work session-first from here: keep your working state in your scratchpad and signal end-of-turn with the done/awaiting fences. The human's message below is your steer on top of that context."
      const task = message?.trim() || "Pick up this thread and continue from where the file says things stand."
      // Provision a scratch directory too (the adopted worker's own space); the legacy file stays read-only.
      try {
        scratchRel = writeScratchDir(deps.project.dir, sessionId)
      } catch {
        rollback()
        throw unavailable()
      }
      const prompt = composePrompt(sessionId, task)
      const permissionMode = workerDispatchPermission("claude", settings)

      // Adoption spawns through the broker, exactly like a fresh dispatch. It used to claim a tmux
      // pane under a leased attempt token and rebind the pane identity across slow post-create setup —
      // a multi-process protocol whose entire purpose was making a PANE claim safe. There is no pane
      // to claim now: the daemon record plus the session id is the identity, so the attempt token
      // stays (it still fences two frizz processes racing the same slug) and everything pane-shaped goes.
      const bridge = deps.claudeBroker
      if (!bridge) {
        rollback()
        throw unavailable()
      }
      // Re-check the authorized file identity immediately before spawning: local provisioning above is
      // the window in which the source could have been replaced under us.
      const beforeSpawn = resolveLegacyThreadFile(deps.project.dir, slug)
      if (!beforeSpawn || !sameFileStat(source, beforeSpawn)) {
        rollback()
        throw unavailable()
      }
      try {
        await bridge.spawnDispatch({
          threadSlug: slug,
          sessionId,
          cwd: deps.project.dir,
          prompt,
          permissionMode,
          appendSystemPrompt: [
            loadWorkerPrompt("claude"),
            scratchpadOrientation(sessionId),
            frizzConfigBlock(deps.project.dir),
            adoption,
          ].filter(Boolean).join("\n\n"),
          model: settings.model,
          effort: settings.effort,
        })
      } catch {
        try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch { /* best-effort */ }
        rollback()
        throw unavailable()
      }

      const adopted = {
        slug,
        session_id: sessionId,
        tmux_name: threadIdentityName(slug),
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

      deps.storage.setClaudeRuntime(slug, "broker")
      void deps.board.rebuild().catch(() => {})
      return { slug, sessionId }
    },
  }
}
