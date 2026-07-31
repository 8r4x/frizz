# cc-worker — design decisions

The **fray** worker-side plugin (dir `cc-worker/`, manifest `name: "fray"` since 2026-07-08) is
consumed by fray-ui worker sessions: one interactive top-level
`claude` per `.fray/` thread, loaded via `claude --plugin-dir <repo>/cc-worker`. Each session is a
**worker bound to ONE thread** (slug in env `FRAY_UI_THREAD` + a `THREAD:` line in its prompt). The
human + the fray-ui app are the orchestrator; the worker just drives its one thread. This records
what was ported from the orchestrator `cc/` plugin, what was dropped, and why.

## Shared source, bundled runtime closure

- **`scripts/fray/config.mjs` and `scripts/fray/agent-bindings.mjs` are THIN SHIMS** that
  `export *` from `../../../cc/scripts/fray/*.mjs`. cc-worker never copies config/vocab/binding
  logic — there is exactly one source of truth (cc's). This assumes cc is a sibling dir (`../../cc/`
  from the plugin root), the same assumption fray-ui's server makes (`ui/ARCHITECTURE.md`: it imports
  the board logic from `../../cc/scripts/fray/*.mjs`).
- **`bin/fray` and `bin/fray-update`** are cc's exact shim pattern, resolving cc's real scripts at
  `../../cc/scripts/fray/{index,thread-update}.mjs` relative to the bin file (cwd-independent). They
  land on the worker's Bash PATH the way cc's do. `fray-update` is the worker's primary tool for
  owning its one thread file; `fray` lets it read/validate the board.
- **Portable artifact rule:** `ui/packages/cli/src/artifacts.ts` copies the exact sibling
  `cc/scripts/fray/` module closure to `runtime/cc/scripts/fray/`, beside `runtime/cc-worker/`.
  The existing shims therefore resolve inside an immutable artifact when the source checkout is gone;
  both the worker and cc closure are hashed in `manifest.runtimeFiles` and required at read time.
- **`agents/*.md`** are copied UNCHANGED from `cc/agents/` (16 profiles) — a worker dispatches its
  own helpers at the same model/effort cells as the orchestrator.

## Hooks ported (all gated on `FRAY_UI_THREAD` — inert if the plugin is loaded anywhere else)

| Hook | Event | Ported from | What it does for a worker |
| --- | --- | --- | --- |
| `session-seed.mjs` | SessionStart (startup/resume/clear/compact) | cc `session-seed.mjs` | Injects the single-thread worker contract + the bound slug + its file path; re-grounds on compact. Also writes cc's `off` sentinel defensively (see interplay). |
| `precompact-instructions.mjs` | PreCompact (auto/manual) | new — no cc equivalent | Steers WHAT SURVIVES compaction: emits an editorial brief asking the summarizer to preserve the high-level approach (plan, alternatives rejected, rationale) at high fidelity, plus a closing "Re-grounding before continuing:" section naming the scratchpad path and the files to re-read. **PLAIN STDOUT is the channel** — cc's usual `hookSpecificOutput` JSON would be handed to the summarizer as its literal instructions. Skips sub-agent contexts (the derived scratchpad path is only guaranteed for the top-level worker). |
| `scratchpad.mjs` | SessionStart (startup/resume/clear/compact) + PreCompact (auto/manual) + UserPromptSubmit + PostToolUse | new — no cc equivalent | Keeps the ONE per-thread scratchpad (`.fray/threads/<sid>/scratch.md`) written and re-grounded across compaction. `--mode=session-start` injects the pad's HEAD back verbatim on the context-losing sources (compact/resume/clear) plus a re-read pointer, and teaches the contract when the pad is still an unwritten skeleton; `--mode=precompact` (**plain stdout**) hands the head to the summarizer; `--mode=nudge` fires on BOTH UserPromptSubmit and PostToolUse (mid-turn — the one that matters for long autonomous turns) once context has grown past `STALE_TOKENS` since the last write. Both nudge channels share one state file, so mid-turn firing does not multiply reminders. NOT gated on `FRAY_UI_THREAD`; `--via=project` marks the repo-local registration and defers to this one inside a fray worker. |
| `agent-dispatch.mjs` | PreToolUse(Agent) | cc `agent-dispatch.mjs` | Enforces `run_in_background:true`, strips `name`/`team_name`, appends a worker-flavored orchestration epilogue. |
| `bash-background.mjs` | PreToolUse(Bash) | new | Denies a local shell job that escapes through `&` without a later `wait` or EXIT trap. Shell job control bypasses Claude's task registry, so Fray cannot track or wake it; self-contained probe concurrency remains allowed. |
| `agent-bind.mjs` | PostToolUse(Agent) | cc `agent-bind.mjs` (verbatim behavior) | Records `agentId → thread` into `.fray/.agent-bindings.jsonl` in cc's exact format, so a worker's THREAD-tagged helper renders on the fray-ui board's per-thread liveness. |
| `stop-flush.mjs` | Stop | cc `fray-stop-reminder.mjs` (dirty-check idea only) | If the worker's ONE thread file wasn't edited since the last rest, nudges it to flush its state (mtime dirty-check, cooldown-limited, least-alarming `additionalContext` channel). |

## cc hooks DROPPED — one line each on why

- **`fray-reminder.mjs` (UserPromptSubmit per-turn pulse)** — DROPPED. It nags the *orchestrator*
  about the whole board (pending-by-status, reconcile-stale, un-drained follow-ups, revalidate-due).
  A worker owns one thread and does not orchestrate a board; a per-turn board pulse is pure noise.
- **`fray-stop-reminder.mjs` (board-wide Stop reconcile + pop-one decision queue)** — DROPPED as-is;
  only its per-thread dirty-check idea is reused in `stop-flush.mjs`. The rest (reconcile every
  rested agent, pop the next human-blocked thread and present it) is orchestrator decision-queue work
  the fray-ui app + human own, not the worker.
- **`fray-notify-surface.mjs` (Stop) + `fray-notify` bin/`notify.mjs`** — DROPPED. The durable
  WIN/DECISION/BLOCKER notification queue is an orchestrator surfacing channel; in fray-ui the UI
  surfaces "awaiting you" from thread `status: blocked` + `status_text` directly, so the worker needs
  no separate notify queue.
- **`fray-subagent-rest.mjs` (SubagentStop recorder) + `fray-rest-guard.mjs` (SubagentStop guard)**
  — DROPPED. These feed the orchestrator's board-wide "reconcile every rested dispatched agent"
  machinery (`.rested-agents.jsonl`, the `.dispatch-count` gate). A worker actively collects its own
  handful of helpers before resting (contract in SKILL.md); it does not need the board-scale
  rest-reconciliation guard. The worker-facing half of the rest-guard's lesson (run long ops inline,
  don't rest on a waiter) is carried in the dispatch epilogue instead.
- **`fray-thread-edit-steer.mjs` (PostToolUse Edit/Write)** — DROPPED. It's an orchestrator
  convenience that steers an in-flight agent when the orchestrator hand-edits a thread; a worker edits
  its OWN thread and dispatches its OWN helpers, so there's nothing to cross-steer.
- **`session-end.mjs` (SessionEnd heartbeat clear)** — DROPPED. It clears the session-ownership
  HEARTBEAT so a dead orchestrator's threads orphan. Workers don't participate in cc's multi-session
  ownership model (no `owner_session` claims, no heartbeat) — the fray-ui app tracks which session
  drives which thread — so there's no heartbeat to clear.
- **The `.dispatch-ledger.jsonl` write + THREAD-existence DENY gate + `.dispatch-count` bump**
  (inside cc's `agent-dispatch.mjs`) — DROPPED from the worker's PreToolUse. The ledger is a
  compaction-durable orchestrator record of which-agent-serves-which-thread across MANY threads; the
  THREAD-existence gate enforces the orchestrator's "file the thread before dispatching" discipline;
  the count only gates the (dropped) SubagentStop recorder. A worker owns exactly one, already-created
  thread and its helpers own no thread, so none apply. The `.agent-bindings.jsonl` write — the piece
  that actually renders sub-agent liveness on the board — IS kept (via `agent-bind.mjs`).

## Interplay with the orchestrator `cc` plugin (double-hook analysis)

**Question:** if the user has `cc` (the fray orchestrator plugin) enabled globally AND a fray-ui
worker session starts in the same repo, do both plugins' hooks fire (double-hook)?

**Finding — NO, not by default. cc is inert in a fresh worker session.** cc's every hook is gated on
`frayActive(projectDir, sessionId)` (`cc/scripts/fray/config.mjs`). That gate is **opt-IN per
session**: it requires `.fray/` to exist AND a per-session sentinel at
`.fray/.session-state/<session_id>` containing `on` (written by `fray on` / the orchestrator fray
skill's Step 0). With no sentinel it returns **false** — the documented default:

```
// config.mjs frayActive(), final line:
return false; // DEFAULT: OPT-IN — dormant until this session runs `fray on`
```

A freshly-spawned fray-ui worker has a distinct `CLAUDE_CODE_SESSION_ID` and never runs `fray on`, so
cc's `frayActive()` is false for it → **all cc hooks are silent no-ops in the worker.** Meanwhile
cc-worker gates on the orthogonal `FRAY_UI_THREAD` env, so the two plugins key off different signals
and do not both activate. No double-hook by default.

**Residual risk:** if, inside a worker session, someone runs `fray on` or loads the orchestrator
`fray` skill (whose Step 0 runs `fray on`), cc's `frayActive()` flips true AND cc-worker is active →
both fire (you'd get orchestrator board nags inside a worker — wrong).

**Mitigation implemented (cheap + safe + reversible):** `session-seed.mjs` writes cc's OWN per-session
`off` sentinel for the worker's session id via cc's shared `setSessionOverride(dir, sid, 'off')` on
every worker SessionStart. `frayActive()` short-circuits to false on an `off` override
(`if (override === 'off') return false`), so cc is **guaranteed dormant** in a worker session even if
something later attempts to activate it — unless the human deliberately runs `fray on` afterward
(which overwrites the sentinel), the explicit "I want this session to orchestrate too" escape hatch.
This uses cc's own public API (identical to what `fray off` does), touches only gitignored runtime
state keyed on this worker's session id, and does NOT disable cc-worker (which gates on
`FRAY_UI_THREAD`, not the sentinel). It's the safest cheap option: it neutralizes the other plugin
without a UI-side plugin-disable flag (Claude Code has no per-invocation "disable plugin X" flag), and
the worker SKILL.md additionally tells the worker not to run `fray on` / load the orchestrator skill.

## plugin.json

`name: "fray"` (renamed from `fray-worker` on 2026-07-08 — see the follow-up note), `version: "0.1.2"`,
`license: "MIT"`. Hooks are auto-discovered from `hooks/hooks.json` (same as cc — plugin.json carries
no explicit hooks reference); every hook command is wired via `${CLAUDE_PLUGIN_ROOT}`.

## Claude settings-source isolation — deliberately deferred

The portable worker launch passes its per-session plugin with `--plugin-dir` on both spawn and
resume, and clears only `CLAUDE_CODE_SUBAGENT_MODEL` plus `CLAUDE_CODE_EFFORT_LEVEL`: those inherited
variables would silently defeat Fray's selected worker/profile. It deliberately does **not** replace
`HOME`, `CLAUDE_CONFIG_DIR`, or Claude's settings sources. Doing so would also change authentication,
user-approved permissions, MCP configuration, and global plugin behavior; that is a product-policy
decision, not an artifact-portability implementation detail. A future isolation policy must specify
which settings/auth surfaces are preserved before adding `--settings`, a config-home override, or a
global-plugin disable mechanism.

## 2026-07-02: Stop hook removed
stop-flush.mjs is no longer wired (script kept for reference). User call: under fray-ui the
tailer/board already surface worker state live, and the block-until-file-edited nag forced even
trivial workers into Read/Edit dances that render as noise in the chat UI. Thread-file discipline
remains a prompt-level contract (worker system prompt + SKILL), not a hook-enforced gate.

## 2026-07-08: Developer-experience port — doctrine, thread-type presets, dialectic
Goal: carry the old cc/ plugin's developer experience (minus the orchestrator machinery) into
fray-ui workers. What landed:
- **`skills/dialectic/SKILL.md`** — ported from `cc/skills/dialectic/` (self-contained dueling-
  sub-agents methodology; no board/reconcile dependency). Its model-tier references use this
  plugin's namespace (`fray:opus-high`, etc. — see the naming note below).
- **`skills/worker/SKILL.md`** — added two sections: "Choosing a helper's model + effort" (the
  full Haiku/Sonnet/Opus tiering doctrine + effort ladder + bias-to-Opus corollary, adapted from
  `cc/skills/fray/SKILL.md:218-234` for a worker dispatching its OWN helpers) and "Thread-type
  presets" (research / audit / implementation / planning — deliverable shape + "done" bar each,
  derived from that skill's `:92-150`/`:242-317`/`:463` framing). Also added a status-field
  discipline section (later split into `activity` + `status_text` — see the follow-up) and an
  "awaiting your OWN sub-agent is NOT blocked" clarification.
- **`ui/WORKER_PROMPT.md`** (fray-ui system prompt, not in this plugin) — carries the terse version
  of the same three: a "Status discipline" block, the model/effort doctrine in the Sub-agents
  section, and a "Thread types" section. This is the maintainer's explicit ask that the preset
  vocabulary ride in the SYSTEM prompt passed to every worker. No dispatch.ts change, so no fray-ui
  server restart is needed — `loadWorkerPrompt()` re-reads the file per dispatch and each spawned
  `claude` rescans this plugin dir fresh.

### Naming: subagent_type is `fray:<model>-<effort>` (plugin renamed to `fray` on 2026-07-08)
The plugin's manifest `name` (`.claude-plugin/plugin.json`) drives the subagent-type NAMESPACE, and
each agent file's frontmatter `name` drives the agent name — verified empirically with a throwaway
plugin (`name:"fray"` + agent `name:opus-high` → `fray:opus-high`); the plugin DIRECTORY name does
not matter. So the profiles dispatch as `fray:opus-high` / `fray:sonnet-medium` / `fray:haiku`, and
the skills as `fray:worker` + `fray:dialectic`. A BARE name (`opus-high`, `haiku`) does NOT resolve
— the Agent tool returns "Agent type '…' not found. Available agents: … fray:haiku …" — so every
doctrine/dialectic reference uses the `fray:`-prefixed form (confirmed end-to-end: `subagent_type:
fray:haiku` returns PONG). See the follow-up note below for why the name is `fray`, not `fray-worker`.

## 2026-07-08 (follow-up): status split, validation hook, `fray:` namespace rename
Three maintainer refinements landed on top of the port:

**1. `status_text` split into `activity` + `status_text`.** The single overloaded field became two:
`activity` = the form-constrained LIVE label the UI renders beside the spinner (single line, ≤100
chars, present-progressive gerund); `status_text` = the classic 1–2-sentence human gloss that also
doubles as THE ask on a human-`blocked` thread (queue cards headline it; no gerund constraint). The
gerund/≤100 discipline moved OFF `status_text` and ONTO `activity` in `ui/WORKER_PROMPT.md` +
`skills/worker/SKILL.md`. (UI-side `activity` plumbing/rendering — board JSON → ThreadView → listing
row — is a SIBLING agent's scope; not touched here beyond `ui/WORKER_PROMPT.md`.)

**2. New PostToolUse validation hook — `hooks/thread-frontmatter-validate.mjs`** (matcher
`Edit|Write|MultiEdit`, wired in `hooks/hooks.json`). Gated on FRAY_UI_THREAD + a top-level
`.fray/<slug>.md` path (dotfiles + `.findings/` sidecars skipped via the vendored `threadSlug`). On
every thread-file edit it re-reads + validates the frontmatter and, on a HARD violation, returns
`{"decision":"block","reason":…}` (PostToolUse block — the worker sees the quoted reason and
re-edits); soft issues warn via `systemMessage`; a clean edit is silent; ANY error fails OPEN
(exit 0). Rules (mirroring cc's board validator `index.mjs:302-335`): required `title`+`status`;
`status` ∈ the vocab (legacy aliases warn, not block); `activity` single-line/≤100/gerund-heuristic
(first word ends in "ing"); `blocked` ⇒ at most ONE of `blocking_threads`/`revalidate_at`, and
human-blocked (neither) ⇒ `status_text` required; `status_text` >240 chars warns. SELF-CONTAINED: it
VENDORS minimal copies of cc's frontmatter parser (`index.mjs:82`), path matcher
(`fray-thread-edit-steer.mjs:67`), and vocab (`config.mjs:291`/`:301`) — cc-worker must not import cc
at runtime. Verified: 10 direct unit cases (pass/block/warn/inert) + a real headless worker whose bad
Write was blocked with the exact quoted reason.

**3. Plugin renamed `fray-worker` → `fray`; worker skill renamed `fray-worker` → `worker`.** The
maintainer disliked the old worker-prefixed dispatch namespace. Renamed the manifest `name` to `fray` and the 16 agent
files + their frontmatter from `fray-<model>-<effort>` to `<model>-<effort>` (bare `haiku`), so
dispatches read `fray:opus-high` etc. Renamed the worker skill dir + frontmatter `fray-worker` →
`worker` (giving `fray:worker`, not the stutter `fray:fray-worker`). The plugin DIRECTORY stays
`cc-worker/` (dispatch.ts points at that path — unchanged, no server restart). Every reference in
`ui/WORKER_PROMPT.md`, both skills, the hooks, and this file was updated; a grep for the old prefix token is clean.

**Accepted name collision.** The old GLOBAL orchestrator plugin (`cc/`) is ALSO named `fray`. This is
accepted as harmless: `cc/` is disabled in `~/.claude/settings.json` (`"fray@fray": false`) and, even
when enabled, loads only in ORCHESTRATOR sessions (a different process class) — never in a fray-ui
worker, which loads ONLY this plugin via `--plugin-dir cc-worker`. Verified: the headless worker env
(same settings.json) registers a clean `fray:*` set with no `cc/` agents present. If a user ever
loaded BOTH plugins in one session, Claude Code would namespace-collide two `fray` plugins — but that
combination does not occur on the worker path.

## 2026-07-08 (campaign): `needs-human` first-class status + interactive-prompt deny hooks
Part of the board-wide redesign (owned jointly with the fray-ui UI half): `needs-human` becomes a
first-class fray status — the declared "awaiting a human" state and the queue's definition — while
`blocked` narrows to MACHINE-waits only. The vocab/parser/validator changes live in the shared cc/
scripts (`config.mjs` STATUS/STATUS_ALIASES + new `effectiveStatus()`, `index.mjs`, `decisions.mjs`,
`statusline-fray.mjs`, `thread-update.mjs`, `fray-reminder.mjs`) — consumed by fray-ui's readBoard
shell-out, so they take effect on the next board rebuild with NO server restart. cc-worker-side:

- **`hooks/thread-frontmatter-validate.mjs`** — vendored vocab bumped: `needs-human` is canonical,
  `needs-decision` aliases to it. New rules: a `needs-human` thread (incl. a legacy `blocked` with no
  machine field, which reads as needs-human via the inlined `effectiveStatus`) REQUIRES a
  `status_text` (hard BLOCK); a machine-`blocked` thread with no mechanism field is a WARN suggesting
  needs-human (not a block — legacy tolerance); >1 mechanism stays a block.
- **`skills/worker/SKILL.md` + `ui/WORKER_PROMPT.md` + `hooks/session-seed.mjs`** — the worker status
  guidance rewritten to the new contract: an ask OR a result needing review → `status: needs-human`
  with a `status_text` ask ("Review: …"); `blocked` is machine-only; `done` means NOTHING is left for
  the human (Mark-as-done is the human's acknowledgment — never jump straight to `done` when review
  is pending).
- **`hooks/deny-ask.mjs`** (existing, PreToolUse `AskUserQuestion`) — deny reason re-pointed at
  `--status needs-human`. `AskUserQuestion` is a real tool → cleanly deniable via PreToolUse; verified
  by piping the hook its exact payload (deny + reason) and confirming inert when FRAY_UI_THREAD unset.
- **`hooks/deny-plan.mjs`** (NEW, PermissionRequest `ExitPlanMode`) — denies the plan-approval prompt.
  MECHANISM (per the Claude Code hooks docs): `ExitPlanMode` is a PERMISSION surface, not a plain
  tool, so it is denied via a **PermissionRequest** hook (matcher exactly `ExitPlanMode`), NOT
  PreToolUse. The deny JSON is `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":
  {"behavior":"deny"}}, "additionalContext":"<redirect>"}` — the instructive redirect rides
  **top-level `additionalContext`** (NOT `decision.message`), which Claude injects to the model as a
  plain-text system-reminder; exit 0 with the JSON on stdout (exit 2 makes Claude ignore it). CAVEAT:
  PermissionRequest hooks do NOT fire under `claude -p` (headless print mode), so the `-p` smoke test
  can't exercise it — but fray-ui workers run as INTERACTIVE tmux `claude` sessions, where they DO
  fire. Both deny hooks are FRAY_UI_THREAD-gated and fail-open. (`AskUserQuestion` was not surfaced as
  an invokable tool in the `-p` harness either, so both hooks were verified by piping their exact hook
  payloads rather than by driving a live prompt.)

### `hooks/perm-policy.mjs` — the worker's permission policy (2026-07-25)

Replaces the observe-only `perm-observe.mjs`. Same registration (PermissionRequest, matcher `*`), but
it now DECIDES: allow / deny / defer, first match wins.

WHY IT DECIDES. fray dispatches Claude workers at `--permission-mode auto`
(`WORKER_DISPATCH_PERMISSION`), and `auto` is **not** non-interactive — its classifier still raises a
prompt for anything it judges risky. With nobody at the keyboard that parks a thread invisibly; one sat
blocked on a `git push` for over a day. The blunt alternative was dispatching at `bypassPermissions`,
which was deliberately NOT chosen: bypass removes the decision POINT, so nothing can ever inspect a
request again. Keeping `auto` and deciding here preserves the seam — and Claude Code labels the outcome
in the pane ("Allowed by PermissionRequest hook"), so an auto-approval stays attributable rather than
being indistinguishable from bypass.

THE TABLE ships UNIVERSAL rules only; this plugin loads for every project fray drives, so a rule that
is right for one repo is wrong for the next. `catastrophic-delete` and `raw-disk-write` deny outright
(strictly safer than bypass, which would have allowed both). `restrictive-mode` DEFERS whenever
`permission_mode !== "auto"`, which is what makes a genuine lower-permission mode usable: move a thread
to `default` with the live permission control and its prompts come back. `FRAY_PERM_POLICY=review`
defers everything. Fail-safe INVERTS the old observer's fail-open — for a hook that can APPROVE, any
error must fall back to asking, never to allowing.

PAYLOAD (verified live, correcting an earlier note that claimed otherwise): the PermissionRequest hook
input carries `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`,
`hook_event_name`, `tool_name`, `tool_input`, and `permission_suggestions`. That is enough for a real
per-tool/per-command policy. Allow JSON is
`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":<tool_input>}}}`.

KNOWN LIMIT: an explicit `ask` RULE outranks this hook. `"permissions":{"ask":["Bash(git push:*)"]}`
raises a prompt an `allow` here does not override — Claude Code says so on the prompt itself. Isolated
against a hook that allows unconditionally (it prompted too), so this is Claude Code precedence, not a
defect, and arguably correct: an explicit human rule should beat a blanket policy. A repo carrying
`ask` rules can therefore still park a worker; the fix is that repo's settings.

MARKER: `<stateDir>/perm-requests/<slug>.json` now carries `decision` / `rule` / `reason` / `command`
alongside the original fields. The tailer treats ONLY a deferred request as a human block (an
auto-resolved one must never card as "Needs you"), and surfaces the last allow/deny as `permPolicy` —
the only durable record an approval leaves anywhere, since allows are never written to the transcript.
A marker with no `decision` (an older plugin build) still blocks exactly as before.

VERIFICATION: `ui/scripts/verify-perm-marker.mjs` runs the REAL hook the way Claude Code does and
asserts every branch. The allow path was additionally driven against a REAL interactive `claude` (it
cannot be exercised under `claude -p`, where PermissionRequest hooks do not fire).

### The `--settings` permission floor — BUILT, verified, then deliberately REMOVED (2026-07-08)
A `--settings` permission FLOOR was added to `ui/dispatch.ts` (`WORKER_DENY_SETTINGS =
{"permissions":{"deny":["AskUserQuestion","ExitPlanMode"]}}`, both command builders) and verified to
work: `claude -p --settings '{deny:[AskUserQuestion,ExitPlanMode,Bash]}'` → the model reports
`Bash: No` (control — a bare-name deny removes a normally-present tool from context), `Read/Write:
Yes`, `AskUserQuestion/ExitPlanMode: No`. It was then **removed on the maintainer's call**, and the
reasoning is worth keeping (it corrects the earlier "floor first, hooks failover" story):

- A bare-name deny removes the tool from the tool LIST, but a model **knows `AskUserQuestion` /
  `ExitPlanMode` from TRAINING** and can still attempt them. With the floor in place, that attempt
  hits a generic "no such tool" permission error — NOT the hook's instructive `needs-human` redirect
  (a permission `deny` is evaluated regardless of hook output and takes precedence, so the model sees
  the generic denial). So the floor can actually **prevent the tool-block education process**.
- Therefore: **hooks-only enforcement.** The deny HOOKS are themselves a hard deny AND they teach on
  contact (their `needs-human` redirect reaches the model — verified: deny-ask emits a PreToolUse
  `permissionDecisionReason`, deny-plan a PermissionRequest top-level `additionalContext`). The floor
  is gone; `dispatch.ts` + `server.test.ts` are reverted to clean.

### Plan-mode softlock fix (2026-07-08)
A worker in plan mode that calls `ExitPlanMode` would be denied by deny-plan — but plan mode ALSO
blocks file edits, so the redirect ("write the plan into your thread") is impossible to follow: a
softlock. deny-plan does not branch on the session's mode, so it cannot pass plan mode through. Fixed
at the SOURCE instead: `ui/dispatch.ts` `workerPermissionMode()` coerces `--permission-mode plan` → `auto` inside
BOTH command builders (so dispatch, adopt, AND resume never spawn a worker in plan mode). Workers plan
by writing the plan into the thread + `status: needs-human` (the contract), which has no plan-mode
requirement — so nothing is lost. deny-plan then denies `ExitPlanMode` UNCONDITIONALLY when gated:
for a real fray-ui worker (never in plan mode) that is always a spurious call → deny + redirect is
correct. RESIDUAL GAP (accepted, documented): the deny could softlock only a FOREIGN session that is
simultaneously in plan mode AND running with FRAY_UI_THREAD set AND this plugin loaded — a combination
fray-ui never produces. A normal plan-mode session outside fray-ui is untouched (deny-plan is inert
without FRAY_UI_THREAD). Follow-up for UI honesty: `web/src/lib/options.ts` still offers "plan" in the
dispatch permission-mode dropdown (coerced to `auto` at spawn) — the sibling can drop it there.

### Malformed-thread one-click repair — read-side recovery (2026-07-09)
INCIDENT: a worker that spawned before the frontmatter-validation write-hook existed wrote
`nub/.fray/sandbox-windows-backend.md` with its metadata in **bold prose** instead of YAML
frontmatter. The board banner correctly reported "sandbox-windows-backend.md: no YAML frontmatter",
but the thread was INVISIBLE to the queue/status system (the parser can't read its title/status →
`status: ?`) until the orchestrator hand-edited YAML. Maintainer directive: "make sure that doesn't
happen again."

TWO-SIDED DEFENSE:
- **Write-side (already existed):** the frontmatter-validation file-tool hook blocks a compliant
  worker from writing a thread `.md` with no frontmatter in the first place.
- **Read-side (this change):** RECOVERY for any straggler the write-hook can't catch — pre-hook
  files, hand edits, and (the residual, by design) **Bash-written files that bypass the file-tool
  hooks entirely**. The board now ships STRUCTURED, classified errors so the UI can offer one-click
  repair.

MECHANISM:
- `cc/scripts/fray/index.mjs` `--json` gains a parallel `errorItems: [{file, kind, message}]`
  (`kind: 'no-frontmatter'` = repairable, else `'other'`). The parser classifies — it knows exactly
  why it rejected the file. The legacy `errors: string[]` array is emitted UNCHANGED alongside it.
- `errorItems` flows through `readBoard`/`fray.ts` → `board.ts assemble()` → `BoardSnapshot` +
  `BoardMeta` (so the repair affordance survives a board delta, not just the keyframe) → the
  TodosView banner, which renders a **Repair** button per `no-frontmatter` item.
- `repairThread({file})` RPC (`repair.ts`) validates the file is a real `.md` DIRECTLY under `.fray/`
  (resolve + dirname===root guard; rejects `../`, `sub/`, absolute paths), refuses any file that
  already has a `---` block (repair is ONLY the missing-frontmatter case), then PREPENDS minimal
  frontmatter: `title` from the first `# H1` (else the filename slug), `status: active`, and a
  standing `status_text` flag that the status is unverified. Then a board rebuild.

CONSERVATIVE ON PURPOSE: repair NEVER infers status from prose. This morning's file said "DONE" in
bold — guessing wrong silently is worse than surfacing. `status: active` makes the thread visible;
if its agent is gone, the runtime crash-net cards it for human attention — the correct escalation.

RESIDUAL (accepted, documented): a Bash-written `.fray/*.md` bypasses the file-tool hooks by design,
so the write-side can't prevent it — the read-side repair is the safety net that heals it in one
click.

## 2026-07-09: v2 worker contract — the session-first rebuild (fences + scratchpad; thread-file contract DELETED)
The maintainer settled fray-ui on a SESSION-FIRST model: threads ARE claude sessions and the human's
dashboard shows the session TRANSCRIPT. Queue membership is explicit: `question` hands off to the
human, `done` queues a checked completion, process-level blocks surface themselves, `awaiting`
excuses a machine wait, and bare rest stays quiet. The entire `.fray/<slug>.md` ownership contract is
GONE: no thread files, no frontmatter, no `status`/`activity`/`status_text`, no `needs-human`, no
`blocked` machine fields, no `hasPlan`/`## Plan`, no `fray-update`. Workers now SIGNAL through their
FINAL MESSAGE and PERSIST through a SCRATCHPAD. This is the cc-worker-side realignment.

**The new signal model (taught in `ui/WORKER_PROMPT.md` §"End-of-turn signals" + `skills/worker/SKILL.md`):**
- **Bare rest is quiet** — a rested thread with no fence does NOT enter Needs-you and is not a human
  handoff. Human handoff is explicit via `question` (or a real process-level block).
- **` ```done `** — work complete + stands; body = 1–4 lines of what shipped + where. Renders a
  checked success card in the queue until explicit Archive; the fence MUTATES NOTHING
  (maintainer-settled), and a follow-up may still wake the worker.
- **` ```awaiting `** — waiting on a MACHINE (CI/PR/timer/session); body may lead with `kind: value`
  hint lines, kind ∈ pr|ci|timer|session. NEVER for a human wait.
- **` ```question `** — unchanged grammar (question / approval / multi / danger; trailing `- A. …`
  options + `Recommendation:`), now the ONLY handback-for-input; no status flip accompanies it.
- CONSISTENCY: the taught grammar matches the shared parser (`ui/packages/shared/src/index.ts`
  `ThreadFence` kind ∈ done|awaiting, `AwaitingHint` kind ∈ pr|ci|timer|session). Opening line is
  exactly ` ```done `/` ```awaiting ` (nothing after the language word); exactly one fence, at the end.

**The scratchpad (`.fray/threads/<session-id>/scratch.md`) — new §"Scratchpad" in both docs:** free-form
markdown, NO schema, NO validation. It is the worker's compaction-proof working memory (survive-
compaction to-do lists / work queues / Ralph-style epic checklists live here, not in ephemeral
context) AND the shared blackboard for parallel sub-agents (shared state is written into it; its PATH
is passed into every sub-agent prompt; helpers READ it, the worker folds their results back in). The
path is server-established convention already wired through `shared` (`scratchpadPath`), `router.ts`
(reads `.fray/threads/<session_id>/scratch.md`), and `dispatch.ts`.

**Hooks changed:**
- **DELETED `hooks/thread-frontmatter-validate.mjs`** + its `hooks.json` PostToolUse `Edit|Write|
  MultiEdit` entry. It validated thread-file frontmatter (status vocab / gerund `activity` / machine
  fields) — a contract that no longer exists. Nothing left to validate on file edits.
- **DELETED `hooks/stop-flush.mjs`** (already UNWIRED since the 2026-07-02 Stop-hook removal; kept
  "for reference" then). Its sole job was nudging the worker to flush state into its thread FILE —
  dead with the thread-file contract gone. No `hooks.json` entry to remove (it was never re-wired).
- **`hooks/session-seed.mjs`** — reseeded to the v2 contract: signal via the final message (bare rest
  is quiet; done queues checked completion; awaiting excuses a machine wait; question asks) + the
  scratchpad, whose concrete path is derived from
  the SessionStart `session_id` (`currentSessionId(input.session_id)` → `.fray/threads/<sid>/scratch.md`) and
  named in the seed. FRAY_UI_THREAD gating + the cc double-hook `off`-sentinel defense KEPT verbatim;
  the compact re-grounding now points at the scratchpad, not a thread file.
- **`hooks/agent-dispatch.mjs`** — epilogue no longer says "don't edit `.fray/` thread files or
  config.yml"; now "don't edit the dispatcher's scratchpad (`.fray/threads/<session-id>/scratch.md`) — READ it for shared
  context if its path is in your prompt, report in your FINAL MESSAGE." Background/name-strip
  enforcement unchanged.
- **`hooks/deny-ask.mjs`** — redirect retargeted off `fray-update … --status needs-human`: now "ask
  in your FINAL MESSAGE with ```question blocks, then rest; a question IS the handback (no extra
  fence)." Still PreToolUse(AskUserQuestion), FRAY_UI_THREAD-gated, fail-open.
- **`hooks/deny-plan.mjs`** — redirect retargeted off "write the plan into your thread `.fray/<slug>.md`
  + status: needs-human": now "write the plan into `.fray/plans/<topic>.md` and/or the scratchpad;
  ask via a ```question approval block." PermissionRequest(ExitPlanMode) mechanism + the plan-mode
  softlock reasoning (dispatch.ts coerces plan→auto) unchanged.
- **`hooks/agent-bind.mjs`** — UNCHANGED (functionally). It records `agentId → thread` into
  `.fray/.agent-bindings.jsonl` from a helper's `THREAD: <slug>` tag; that tag still rides the
  per-thread dispatch and references no dead status/frontmatter contract. NOTE for the server/tailer
  verticals: session-first sub-agent liveness is now TAILER-derived (`ThreadView.subAgents`), so the
  `.agent-bindings.jsonl` binding this hook writes may be VESTIGIAL. Left in place (harmless,
  fail-open, out of this vertical's delete scope) — a candidate for removal once the tailer path is
  confirmed to fully supersede board-side `bindingsByThread`.

**`skills/worker/SKILL.md`** — rewritten to the same pillars (version 0.2.0): the signal model
replaces the status-vocabulary sections; a scratchpad section replaces the "own ONE thread file"
sections; thread-type presets keep the research/audit/implementation/planning taxonomy but strip
every status reference (planning now delivers a `.fray/plans/<topic>.md` artifact). The sub-agents
section adds "pass the scratchpad path into helper prompts." `skills/dialectic` untouched.

**`plugin.json`** description updated: no more "validate thread-file frontmatter"; now fence signals
+ scratchpad blackboard + sub-agent profiles + deny-ask/deny-plan.

**What the server/web verticals must know:** (a) FRAY_UI_THREAD must keep being passed at spawn — every
hook still gates on it. (b) The scratchpad path convention is `.fray/threads/<session-id>/scratch.md` where
`<session-id>` is the pinned `--session-id` (the same id the SessionStart hook sees as `session_id`);
the seed hook NAMES that concrete path to the worker, so dispatch must keep pinning `--session-id`.
(c) `ui/packages/server/src/dispatch.ts` `composePrompt()` STILL emits the dead per-thread contract
("You own `.fray/<slug>.md` … set `status: blocked` … Set `status: done`") — that is server-vertical
scope (not editable here), but it now CONTRADICTS the v2 WORKER_PROMPT and must be rewritten to the
fence/scratchpad model (or dropped) by the dispatch owner. Flagged to server-core.

## 2026-07-12: awaiting reversal — park only human/timestamp gates; keep automation active

The v2 rule above made `awaiting` a broad machine-wait bucket. In practice workers emitted a fence
for CI, bots, releases, and merge progression, then returned with no process actually owning the
next transition. The rail's hourglass therefore implied a watcher that often did not exist. The
contract is now narrower:

- `awaiting` is a deliberate PARK for either `human: <actor + exact external review/approval>` or
  `timer: <ISO-8601 instant>`. The dashboard operator's own decision remains `question`.
- CI, automated review, releases/deploys, merge queues, and already-authorized merge progression
  stay ACTIVE. Claude workers use a background `Bash` one-shot or `Monitor`; Codex workers keep a
  blocking exec session alive and poll it. Their completion/event re-invokes the worker.
- `pr:` / `ci:` / `session:` continue to parse so old transcripts do not break. The existing PR/CI
  waker remains a compatibility bridge, but workers must not create new waits with those hints.
  `timer:` remains the durable scheduler path across process/session restart. `human:` is descriptive
  and intentionally not auto-fired.
- Every follow-up clears the old fence. “Back to awaiting” requires a fresh check: re-emit a current
  human/timer fence, or re-arm automation and remain active.

Claude Code 2.1.207 was audited before teaching this. fray-ui does not pass `--tools`,
`--allowedTools`, or `--disallowedTools`, and its helper profiles only select model/effort, so wait
tools are available to top-level workers and helpers. `Monitor` defaults to 300,000 ms (maximum
3,600,000 ms); `persistent:true` runs until `TaskStop` or session end. Background Bash reports an
output path; `TaskOutput` exists but is deprecated, so workers should `Read` that path for diagnostics.
Both Monitor and background Bash are session/process-bound, which is why durable wall-clock checks
remain `timer:` fences. Helpers must not return a final handoff while they still own a live watcher;
the top-level worker owns long-lived CI/PR/merge progression.

## 2026-07-13: ordinary rest returns to Queue; human Snooze/Archive own triage

The quiet-bare-rest rule above was reversed after live use showed that an owned Fray worker could
come to rest without choosing a fence and disappear from the only surface the operator routinely
triages. Queue membership is now server-derived from process rest, not dependent on perfect worker
signaling:

- Every owned, open session whose top-level turn is genuinely at rest enters Queue by default.
- A live child/Monitor still counts as in-flight work. A truthful external-human or future-timer
  `awaiting` fence remains dimmed in Held. Legacy CI/PR/session and hintless waits do not excuse rest.
- A human may durably Snooze an ordinary handoff (default one day, presets/custom exact instant) or
  Archive it. Due snoozes automatically re-enter Queue; Archive never does.
- Questions, permissions/native approvals, typed interactions, and crashes break through Snooze so a
  provider cannot be stranded behind an invisible hard gate. `done` remains the checked presentation,
  but it is still a resting handoff and can be snoozed.

The worker contract still teaches explicit `question`, `done`, and narrow `awaiting` fences because
they improve priority and presentation. A fence is no longer required merely to make a rested worker
discoverable.

## 2026-07-12: runtime release gate — real CDP evidence plus independent review

Major UI, server, and control-plane work may no longer reach `done` from unit/integration/mocked
evidence alone. The canonical `ui/WORKER_PROMPT.md` contract now requires real Chrome CDP QA against
a disposable full stack, relevant active/idle/error/restart coverage, desktop+narrow screenshots,
console/network inspection, and an explicit correctness+aesthetics assessment. Chrome DevTools MCP is
preferred when it is available to the current provider; `agent-browser` or the repository Puppeteer
harness are explicit fallbacks. Mocked DOM/routes can supplement but cannot be the sole evidence.

Completion also requires two distinct review passes: the implementer's self-review of diff+evidence,
then an independent fresh-context adversarial review; confirmed findings are fixed and affected gates
rerun. The exception is proportional and narrow: trivial non-runtime docs-only or provably mechanical
changes may skip CDP/independent review, while uncertainty applies the gate. This rule is mirrored in
`skills/worker/SKILL.md` (v0.2.2) and the SessionStart seed; the backend-aware prompt contract test pins
all four delivered surfaces, and the Claude expansion golden changes intentionally. The Codex addendum
no longer mislabels an author's inline second read as independent review: use delegation when available,
or report the gate unmet.

## 2026-07-21: Plugin slim-down — one contract copy, gh is the only injected skill

The plugin stops shipping three of its four skills. `skills/worker` is DELETED: it was a second copy
of the worker contract whose single source is `ui/packages/server/src/workerPrompt.ts` (the system
prompt, rebuilt on every dispatch/resume and compaction-immune) — every contract edit had to be made
twice, and the copies drifted. The session-seed pointer sentences that said "Load the `fray:worker`
skill for the full contract" now point at the system-prompt contract only, and the contract tests pin
the two backend prompts (not a skill copy). `skills/dialectic` is dropped from the plugin (generic
methodology nobody wired into the seed or prompt; workers on other people's projects never asked for
it). `skills/adhoc-cdp` MOVED to the fray repo's own `.agents/skills/adhoc-cdp` (agent-neutral; `.claude/skills/adhoc-cdp` is a symlink to it so Claude and Codex share one copy) — its content is
fray-ui-specific (adhoc-stack.mjs / shot.mjs), so it is a project skill, not global plugin cargo; the
generic "verify in a real browser" principle already lives in the prompt's runtime-gate section.
`skills/gh` remains the ONE injected skill: bulky, conditionally relevant, and its pointer is already
auth-gated in the seed — exactly the on-demand shape skills are for.

## 2026-07-22: The no-PR rule now also lives in AGENTS.md (docs, not a hook)

Root cause of "agents keep opening PRs despite FRAY.md": the worker contract + injected FRAY.md are a
SNAPSHOT frozen at session creation. The Codex worker that opened PR #17 and #18 (thread `862831cf`,
born 09:50 Jul 21) spawned minutes before FRAY.md injection first landed and hours before the no-PR
rule existed, so it never saw the rule and carried the base contract's "open a PR and report its URL"
on every turn. Editing FRAY.md does nothing for a session already in flight, and sub-agents never
receive FRAY.md at all.

Mitigation (docs only): the no-PR rule was added to `AGENTS.md` — the agent-neutral home Codex
re-reads FRESH every session and sub-agents load. That reaches NEW sessions of both backends without a
frozen snapshot. It does NOT retroactively reach an already-running frozen session; restart such a
session to pick up a rule change. A tool-layer enforcement hook (`deny-pr` PreToolUse) was built and
then deliberately reverted as overkill for a single-user repo — the doc reach is the intended fix.

## 2026-07-30: Carryover — a per-session brief the harness re-injects, so context survives compaction

The two existing mitigations for compaction loss both routed the context through a DECISION, and that
is where they leaked. The scratchpad survives on disk but only helps if the post-compaction turn
chooses to read it — a model decision, and it gets skipped. `precompact-instructions.mjs` steers the
summarizer, but the summary is a lossy retelling by a model that never saw the reasoning, and it is
regenerated from scratch every time. `carryover.mjs` removes the decision: whatever is in
`.fray/threads/<sid>/carryover.md` is spliced into the context window by the harness, before the
model's first token. The model cannot forget to read it and the summarizer cannot paraphrase it away.

**The file is authored by the AGENT, not by the hook** — it is a plain markdown file written with the
Write tool. Rejected: a CLI (`fray carryover set …`) and a dedicated MCP tool. Both add something to
learn and to keep installed, and neither buys anything over a file the agent already knows how to
write and a human can hand-edit mid-session (an edit is just an mtime change, which the nudge treats
exactly like an agent's write — pinned by a test).

**Keyed by session id**, taken from the hook's stdin `session_id` and falling back to
`CLAUDE_CODE_SESSION_ID` via the shared `currentSessionId`. Those two are equal (already relied on by
the activation sentinel), which is what lets the AGENT compute its own path from a Bash/Write call.
Stored beside the scratchpad rather than under `.fray/.session-state/` because the agent is already
told the thread dir. `.fray/` is gitignored in full, so a brief never reaches a commit, and nothing
enumerates `.fray/threads/*` to build the board (threads come from the DB), so writing a directory
there for a non-fray session cannot conjure a phantom thread card.

**Staleness is measured in context TOKENS, and as GROWTH, never an absolute.** The transcript's
newest usage record gives live context fill (`input + cache_creation + cache_read`); the hook reads
only the last 256 KB of the file, since transcripts reach tens of megabytes here. An absolute
threshold is unusable because the window is not knowable from a hook — a real compaction in this
project fired at preTokens 935,291 on a 1M-window session while a 200k session compacts near 160k.
Growth since the last write is window-independent and self-resetting. Wall clock and transcript BYTES
were both rejected: neither tracks context pressure (one large tool result adds megabytes to the file
without moving the window much).

**Why a nudge at all.** Without it the file is never written and the whole mechanism is decorative —
an agent that is never reminded does not stop to journal. It is the one part that is a heuristic, so
it is the one part with a cheap escape hatch: `FRAY_CARRYOVER_STALE_TOKENS` retunes it and
`FRAY_CARRYOVER=off` disables every mode.

**Registered twice, deduped deterministically.** The plugin registration ships to every fray worker
everywhere. The repo's own `.claude/settings.json` carries the same three registrations with
`--via=project` so plain (non-fray) `claude` sessions in this repo get the behavior too; that flag
exits when `FRAY_UI_THREAD` is set, because such a session already loads the plugin and would
otherwise inject the brief twice. A flag plus an env check — no lock file, no race.

VERIFIED LIVE against cli 2.1.220, in an isolated `/tmp` project, not by proxy:
- `SessionStart:startup` fired (exit 0, 63 ms) and a real session quoted a sentinel that existed ONLY
  in the brief — with **zero tool calls** in the transcript, so it came from context, not a file read.
- A real `/compact` produced a `compact_boundary`, and `SessionStart:compact` then delivered a brief
  whose sentinel had been swapped to a value that had NEVER appeared in that session's context — so
  the post-compaction injection demonstrably re-reads the file rather than echoing the summary.
- `PreCompact:manual [carryover.mjs --mode=precompact] completed with status 0` in the hook debug log.
- The `UserPromptSubmit` nudge fired live and reported ~31k tokens computed from the real transcript,
  confirming the usage parser works against Claude Code's actual format and not just a fixture.

Regression net: `ui/packages/server/src/carryover-hook.test.ts` executes the real script over its
wire contract (argv + stdin JSON + stdout) rather than asserting on its source.

## 2026-07-30 (same day, revised): carryover COLLAPSED into the scratchpad; the nudge moved mid-turn

The `carryover.md` brief shipped earlier today was redundant with the scratchpad and made the worker
maintain two overlapping documents (maintainer's call, and correct). ONE doc per thread is the rule.
`carryover.mjs` is DELETED and replaced by `scratchpad.mjs`, which does the same three things to
`scratch.md` — the pad the dispatcher already provisions, already names in the system prompt, and
already forbids sub-agents from writing.

Two behavior changes fell out of the retarget:

**Injection is scoped to the context-losing sources.** A brand-new `startup` has lost nothing, so it
gets the contract text only; `compact`/`resume`/`clear` get the pad's head injected verbatim PLUS an
explicit "re-read the full file" pointer. Injecting the head rather than only pointing at the file is
deliberate: a bare reminder routes recovery through a decision the model can skip, which is the exact
failure being fixed. The head is the floor; the pointer is the ceiling. The cap (12k chars, was 24k)
keeps that floor affordable now that the target is unbounded working memory rather than a bounded brief.

**"Present" no longer means "written".** fray provisions scratch.md with a skeleton, so file-absence
is gone as the unwritten signal. `substanceLength()` strips headings, the provisioned orientation line
and empty task boxes, and measures what remains. It is a heuristic on purpose — it only decides
whether to NUDGE, so a wrong call costs one redundant reminder, never correctness.

**The nudge now also fires on PostToolUse, and that is the real fix.** UserPromptSubmit alone only
fires at turn boundaries, and a fray worker runs enormous autonomous turns — dozens of tool calls
between human prompts — so a whole session's work could compact unpersisted without a single nudge.
PostToolUse `additionalContext` was verified live against cli 2.1.220 (a real session quoted a
sentinel injected after a Bash call, and through the plugin the model received the nudge mid-turn and
said it would update the pad). Both channels share one state file, so the interval is global: firing
per tool call makes the existing budget land SOONER and mid-turn, it does not multiply reminders.

### Researched: there is NO context-pressure hook, on either backend

Measured, so do not go looking again. Claude Code 2.1.220 exposes **31 hook events** and not one
signals an approaching context limit; **no hook input carries a token count at all**, and the docs say
plainly to poll the transcript yourself. Codex is the same. So the fill is computed here from the
transcript's newest usage record (`input + cache_creation + cache_read`), reading only the file's tail
because transcripts reach tens of megabytes. Growth-since-last-write remains the metric because the
window is not knowable from a hook.

Useful events noticed while enumerating, none wired yet: `PostToolBatch` (fires after a batch of
parallel tool calls resolves, before the next model call), `SubagentStart` (could carry the
read-only-pad rule structurally instead of via the dispatch epilogue's prose), `PostCompact`
(receives the summary), and `SessionStart`'s `initialUserMessage` output (injects a VISIBLE user
message rather than a system reminder) and `fork` matcher.

### Rejected: a blocking Stop gate

A Stop hook could refuse to let the worker rest until it writes. That was tried and removed on
2026-07-02 (maintainer's call): the block-until-file-edited nag forced even trivial workers into
Read/Edit dances that render as noise in the chat UI. This nudges; it never blocks.

### Verified feasible, NOT yet built: the background checkpoint fork

`claude -p --resume <sid> --fork-session` was tested end to end. The fork carries the FULL original
conversation (it reproduced a human quote that existed only in that transcript), it wrote to the
ORIGINAL thread's scratchpad when handed the absolute path, the original transcript was
**byte-identical before and after** (15,078 → 15,078 — the live session is never interrupted), the
original continued normally afterwards, and it is cheap because it HITS THE PROMPT CACHE (28,904
cache-read vs 413 cache-create). `SessionStart` has a `fork` matcher so hooks can tell they are in one.

Open problems before this could ship: the fork gets a NEW session id, so it must be handed the
ORIGINAL pad path explicitly (its own hooks would derive a different one); concurrent writes against
the live worker need an ownership rule; the spawn needs a single-flight lock so one threshold crossing
cannot fan out into many forks; and fray's discover/tailer must not adopt the fork's transcript as a
board thread.

### Codex parity gap

Codex 0.144.6 (installed) HAS a hooks system with nearly the same schema — SessionStart, SessionEnd,
PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, Stop, PreCompact, PostCompact,
SubagentStart, SubagentStop — plus `additionalContext`, all confirmed present in the installed binary.
Config lives at `~/.codex/hooks.json` or `[hooks]` in config.toml, repo-level `.codex/hooks.json`, or
plugin-bundled. SessionStart distinguishes a `compact` source. Codex is BETTER in one respect: it lets
you SET the compaction threshold (`model_auto_compact_token_limit`, with
`model_auto_compact_token_limit_scope` = `total` | `body_after_prefix`), so compaction can be made
predictable with headroom rather than merely detected. Wrinkle: codex enforces hook TRUST
(`--dangerously-bypass-hook-trust` exists for automation). **fray currently wires ZERO hooks for
codex**, so a codex worker has only prompt-level scratchpad discipline — the largest remaining gap.

## 2026-07-30 (third pass): reinforcement is OPT-IN, and the two backends are gated differently

> **SUPERSEDED the same day by the fourth pass below** — the opt-in gate was REMOVED. Re-grounding is
> unconditional now. The measured codex findings in this entry all still hold; only the gating does not.

Maintainer's call: the mechanism is opinionated, so it should be chosen rather than inherited. New
`scratchpadReinforcement` setting, **OFF by default** — the inverse of `runtimeGate` /
`autoResumeOnLimit`, which are opt-OUT. Toggle sits in the Settings drawer under "Auto-resume after
usage limits". `scratchpad.mjs` inverted its kill switch into an opt-in gate: absence means off.

**The two backends cannot be gated in the same place**, which is the whole design constraint here:

- **Claude → a worker ENV VAR.** `hooks.json` is static, so `FRAY_SCRATCHPAD_HOOK=on` is what decides
  whether the registered hooks do anything. Stamped on the tmux spawn, and on the broker/SDK path via
  a new per-fork `extraWorkerEnv` on `ClaudeAgentBrokerBridge` — evaluated per fork, so flipping the
  setting reaches the next dispatch or cold-resume without a server restart.
- **Codex → per-conversation CONFIG**, on the `config` override `CodexAppServerBridge` already
  supported, plus a `--enabled` flag. The env var is unusable there because the `codex app-server`
  daemon is SHARED per project and its environment cannot express a per-conversation decision;
  building the config at all already means the setting is on.

### Measured, so nobody re-derives it (codex-cli 0.144.6)

- **`codex exec` runs NO lifecycle hooks, from any discovery path** — not `<repo>/.codex/hooks.json`,
  not `$CODEX_HOME/hooks.json`, not `-c hooks.…`, with or without `bypass_hook_trust=true`, inside a
  git repo or outside one — even though the `hooks` feature flag reports as enabled. Probed with a
  marker file so "did the hook RUN" stayed separate from "did its output reach the model".
- **`codex app-server` DOES run them** when they arrive as config overrides. Verified through the real
  `CodexAppServerBridge` with the real `scratchpad.mjs`: SessionStart, UserPromptSubmit and Stop all
  fired. Probe kept at `backend/_live_codex_hooks.mts`.
- **`bypass_hook_trust` is required** — codex SILENTLY SKIPS untrusted hook definitions, so without it
  the config is delivered and ignored, which looks exactly like a broken feature.
- **Codex reports its OWN rollout session id to the hook** (e.g. `019fb427-…`, `transcript_path` under
  `~/.codex/sessions`), NOT fray's thread id. Hence the mandatory `--session=<fray sessionId>`:
  deriving the path would address a scratchpad that does not exist, and the worker would look
  unreinforced for a reason nobody could see. Codex does send `source` (`"startup"`), same field name
  as Claude, so the compact/resume branch works unchanged.
- **Codex has no PreCompact/PostCompact context-injection wire type** (only SessionStart /
  UserPromptSubmit / PostToolUse / PreToolUse / PermissionRequest / SubagentStart), so the
  summarizer-steering channel stays Claude-only.

### Known gap, deliberately not papered over

The codex NUDGE cannot fire yet: staleness is computed from Claude's transcript shape
(`message.usage`), and a codex rollout is a different format, so `contextTokens()` returns null and
the nudge degrades to SILENCE rather than to a wrong number — pinned by a test. Closing it needs a
rollout-aware token parser. The load-bearing channel (restoring the pad on SessionStart) works on both.

## 2026-07-30 (fourth pass): the gate comes OFF — the scratchpad is canonical, so re-grounding is not optional

Maintainer's correction, and it reverses the third pass's central decision: the thing that deserves an
opt-in is the FORK-based auto-updating (still unbuilt, and called "a little overkill"), NOT the
re-grounding. The scratchpad is the CANONICAL document for a thread, so reading it back after a
compaction is what makes the pad worth writing at all — a posture no project should have to opt into.

The bug this fixes is worse than a mis-scoped setting: `scratchpadReinforcement` defaulted to FALSE, so
the DEFAULT worker — every worker, in practice — got nothing back after a compaction. The mechanism was
shipped and inert. A feature that is off by default is a feature that does not exist.

Removed entirely: the `scratchpadReinforcement` setting (shared schema, server defaults, Settings
drawer toggle), the `FRAY_SCRATCHPAD_HOOK=on` env plumbing (`scratchpadHookEnv`, the tmux spawn stamp,
the broker bridge's `extraWorkerEnv` dep), and codex's `--enabled` flag. A dead toggle that gates
nothing is worse than no toggle; when the fork checkpointer is built it brings its own setting.

What survives: `--session=<fray sessionId>` on the codex path stays MANDATORY (codex reports its own
rollout session id, so the derived path would address a scratchpad that does not exist), and
`bypass_hook_trust` stays required (codex silently skips untrusted hook definitions). The escape hatch
is now `FRAY_SCRATCHPAD_HOOK=off` — env only, and only an explicit off value disables, because it is
for a one-off session, not a project posture.

Behavior change beyond ungating: **an EMPTY pad now re-grounds too.** Previously a compaction with an
unwritten pad fell through to the generic contract text; now it says plainly that context was just
lost, that the pad is the canonical record, to re-read it NOW, and that it currently has nothing in it
so it must be written. "You lost your context and your pad is empty" is the most actionable thing the
next turn can hear, and staying quiet about it left the worker with nothing at the exact moment it had
nothing.

VERIFIED against a real `/compact` with NO env var and NO flag set anywhere: `SessionStart:compact`
exit 0, delivering the re-grounding lead plus the pad head carrying a sentinel from the file. 17 hook
tests; full suite 2419 pass / 0 fail; typecheck clean.

## 2026-07-30 (fifth pass): the worker CONTRACT now explains what the scratchpad is FOR

The hooks made the scratchpad load-bearing, but the shipped worker contract still described it as a
place that "survives compaction" and handed over a path. That undersells it in the way that matters:
a worker told "here is a file that survives compaction" writes a task list; a worker told "this is the
canonical record of the thread and your compaction-survival mechanism" writes the REASONING, which is
precisely what compaction destroys and what a summary cannot reconstruct.

Rewritten in all four places a worker meets the pad, so the framing is consistent wherever it lands:

- `workerPrompt.ts` `SCRATCHPAD` (both backends) — now headed "the canonical record of this thread",
  and says plainly WHY: compaction drops the reasoning first (the plan, the alternatives ruled out,
  why the human chose what they chose), a summary preserves what you did and not why, so write that
  here AS YOU GO and re-read the file after any compaction or resume. Enumerates what belongs in it.
  The claude variant keeps the sub-agent blackboard job and now states that helpers READ but never
  EDIT it — the one-scratchpad rule, said where the worker actually reads it.
- `dispatch.ts` `scratchpadOrientation()` (system-level, rebuilt on every resume) and the first
  user-message line — same framing, one sentence each.
- `dispatch.ts` `scratchpadContent()` — the provisioned skeleton's own orientation line.
- `cc-worker/hooks/session-seed.mjs` — the runtime `SCRATCHPAD:` line.

**Deliberately NOT promised: automatic re-injection.** The prompt says fray "helps by feeding the head
of this file back into your context", and the IMPERATIVE it gives is unconditional — re-read the file
yourself after any compaction or resume. A contract that leans on a runtime guarantee degrades badly
wherever that channel is absent, and one such gap is known: codex's `thread/resume` does NOT re-send
the per-conversation `config`, so a COLD-resumed codex thread (fray restart, app-server daemon death)
may lose its hooks. Unverified either way — flagged, not assumed.

Fallout fixed in the same change (the hook's own template detector): `substanceLength()` recognised the
provisioned skeleton by a `^(Your|SCRATCHPAD:)` prefix plus the old wording. The new orientation line
starts differently, so a freshly provisioned pad read as WRITTEN — which made an empty pad skip its
re-grounding branch and made the summarizer swallow a skeleton. It now matches on the concept
(`compaction-survival mechanism|compaction-proof working memory`), which is also backward compatible
with pads already on disk under the old wording.

Goldens regenerated (a deliberate contract change); the diff is the scratchpad section and nothing
else. Two `dispatch.test.ts` assertions re-anchored — they pin the claude-keeps/codex-drops blackboard
asymmetry and were using the retired phrase as their anchor; the behavior they check is unchanged.
Suite 2413 pass / 0 fail, typecheck clean.

## 2026-07-30 (sixth pass): keep the helper epilogue universal

`hooks/agent-dispatch.mjs` appends its epilogue to every Claude `Agent` helper launched by a fray-ui
worker, regardless of the repository or kind of task. That makes it the wrong layer for requirements
about compilation, shared build locks, build/test ownership, or how long-running operations should
be managed.

The epilogue keeps only universal coordination: return a useful handoff, do not mutate the owning
worker's `.fray/` state unless explicitly assigned, and use the always-available `SendMessage`
upward channel when the dispatcher acting mid-flight could change the outcome. Task-specific
verification and process-lifecycle instructions belong in the dispatch prompt; repository-specific
ones belong in the repository's own guidance. Background dispatch enforcement and `name` /
`team_name` stripping are unchanged.

Correction during implementation: the first reduction also removed `SendMessage`. That was too
aggressive. Every helper receives the tool, and reaching the dispatcher before returning is
universally useful orchestration rather than repository policy. The restored wording treats it as
available directly and therefore drops the old deferred-tool / `ToolSearch` caveat.

## 2026-07-30 (sixth pass): the operator's Settings instructions move to the SYSTEM prompt

Question from the maintainer: is FRAY.md eagerly loaded, and did the Settings prompt get replaced by
it? Answer, from the code: **both exist, neither replaced the other** — and they were being treated
very differently.

- **FRAY.md** → `frayConfigBlock(projectDir)` → `extraSystemPrompt` at EVERY site (claude dispatch,
  codex dispatch, adopt, resume, broker follow-up, router follow-up). System-level, so it already
  survives compaction and is rebuilt on every resume. Nothing to fix.
- **The Settings preamble** (drawer label "Subagent instructions", schema field `dispatchPreamble`) →
  `composePrompt()` → the **FIRST USER MESSAGE** only. Never re-applied on resume, and the first user
  message is exactly what compaction replaces with a summary. So the repo's conventions survived while
  the operator's own standing instructions quietly did not.

Fixed by giving it the same treatment as FRAY.md: new `operatorInstructionsBlock(preamble)`, added to
the system-prompt composition at all six sites, and REMOVED from `composePrompt` (which loses its
`customInstructions` parameter). Moved rather than duplicated — leaving it in both would carry a second
copy of a potentially long preamble in context for the whole pre-compaction window, and the block sits
ABOVE the task banner either way, so the visible chat bubble is unchanged.

Two things fall out for free: an edited setting now reaches a thread that is ALREADY RUNNING (the
system prompt is rebuilt on every resume), and the block states its relationship to FRAY.md — follow
both, prefer the more specific where they genuinely conflict — so a worker meeting two operator-authored
surfaces knows how to reconcile them.

VERIFIED with a real `/compact`: a sentinel placed in `--append-system-prompt` was still readable by the
model after the compaction boundary (`compact_boundary` present in the transcript, model returned
`SORREL-EGRET-4402`). That is the property the move depends on, tested rather than assumed.

One test needed real rework rather than a signature patch: `server.test.ts` asserted the preamble
appeared in the composed first message — the exact behavior being moved — so it now asserts the
opposite plus a dedicated `operatorInstructionsBlock` test. A second (`dispatch.test.ts`'s banner test)
used `PROJECT INSTRUCTIONS` as its above-the-banner anchor; on an ABSENT string `indexOf(...) < banner`
passes VACUOUSLY (-1 < banner), so it was re-anchored on the scratchpad line and given an explicit
`doesNotMatch` instead. Suite 2460 pass / 0 fail, typecheck clean.

## 2026-07-30 (seventh pass): converge on FRAY.md — the Settings preamble is GONE

Maintainer's call, one pass after making the preamble durable: rather than maintain two
operator-authored surfaces, keep the one that is already versioned with the repo. `dispatchPreamble`
(drawer label "Subagent instructions") is deleted outright — schema, server default, the drawer field
and its draft plumbing, `operatorInstructionsBlock` and all six of its call sites.

**FRAY.md is now the ONLY place project conventions live.** It was already the better surface and
needed no work: `frayConfigBlock()` puts it in `extraSystemPrompt` at every site (claude dispatch,
codex dispatch, adopt, resume, broker follow-up, router follow-up), so it survives compaction and is
rebuilt on every resume. It is also reviewable in a diff, travels with a clone, and can differ per
branch — none of which a value in a local SQLite settings blob can do.

Checked before deleting rather than after: `DEFAULT_PREAMBLE` shipped as `""`, and a read of every
`~/.fray/projects/*/ui.db` found no project with a non-empty `dispatchPreamble`. So there is nothing to
migrate and no operator text is silently dropped. `Settings` is a plain `z.object`, so an older blob
that still carries the key parses fine — zod strips the unknown field.

Fallout fixed in the same change, since it was this change that made them false: two dispatch.ts
header comments still described the preamble as the prompt's "orchestration wisdom", and
`SettingsDrawer.test.ts` iterated a help-key list containing `subagentInstructions`. The
`operatorInstructionsBlock` test added one pass earlier was removed with the function.

Suite 2419 pass / 0 fail (two timing-sensitive tests — `app-socket` coalescing and the tmux SIGKILL
buffer — flaked under parallel load and pass in isolation; neither touches this change), typecheck
clean, and the drawer was re-driven in a real browser: the field is gone, and the Prompts section
measures as exactly two children at the standard 24px `gap-6` with no orphaned container left behind.

## 2026-07-30 (eighth pass): native Codex children merge the shared scratchpad

An apparent post-compaction continuity failure in thread `9540edc3-4807-4bb0-8e36-5940f92b452b`
was not path loss and was not Claude's on-disk token broker. The affected thread was a Codex session.
At its first compaction the worker immediately read the correct exact path; at a later compaction it
again addressed the correct path and got `ENOENT`. The directory and sibling artifacts remained.

The missing file was child corruption. Native child `/root/auditstatus_prepare`, launched with
`fork_turns:"none"`, still inherited the parent's developer-level `SCRATCHPAD:` mandate. It reasoned
"Planning isolated scratch creation" and replaced the parent's exact pad with its own `# SEA corpus
preparation` notes. Two minutes later it noticed the mistake, reasoned "Reverting unauthorized root
scratch changes", and tried to remove its replacement. A shell `rm -f` was denied, but its fallback
`apply_patch` `*** Delete File` succeeded. It could not restore the content it had overwritten, so the
pad remained absent until the root compacted nearly an hour later. `fork_turns:"none"` removes
conversational turns; it does not remove the root worker's base/developer instructions.

The deliberately prompt-level fix preserves the useful part of that inheritance:

- The Codex worker contract, system orientation, and first task message now make the pad explicitly
  collaborative. Children may read it and persist their own progress, but every edit is a merge:
  re-read first, patch only a scoped agent/task section, and preserve all existing state. Every
  native-child dispatch restates that rule.
- Codex registers `scratchpad.mjs --mode=subagent-start` as a `SubagentStart` hook. It injects the
  child-only epilogue structurally on every native dispatch: the child may update its scoped progress,
  but may never delete, truncate, reinitialize, move, or replace the whole file — including as cleanup
  or rollback after a mistake. This fixes the observed failure without a filesystem guard or a
  single-writer restriction.
- Newly provisioned pads recommend a light structure rather than enforce a machine schema: Goal,
  Task list, Decisions, Shared context, per-agent progress, Verification, and Next action. A visible
  legend uses `[ ]` pending, `[/]` in progress, `[x]` complete, `[-]` cancelled, and `[?]` blocked.
  Fray's Markdown renderer recognizes all five while the source stays readable in Obsidian/plain text.
- If a pad is unexpectedly absent or empty after compaction/resume, the re-grounding injection says
  the exact path is authoritative, forbids searching neighboring thread pads or broadly reloading repo
  docs, and tells the root to reconstruct from the retained summary plus directly named handoffs.

The root's apparently confused recovery is now explained too. The post-compaction hook correctly
reported that the pad had no substantive content, and the root's first call addressed the correct
exact path and got `ENOENT`. Only then did it search worktrees, list the surviving thread directory,
and read older handoffs to reconstruct state. Its "Writing initial scratch file" reasoning label was
model narration for recreating a currently absent file, not evidence that no pad had existed before.

## 2026-07-31: shared scratchpad updates are expected, not merely permitted

The collaborative contract above said children *may* update the shared scratchpad. A root worker then
treated batch file ownership and a dynamic-orchestrator mega-doc's single-writer rule as reasons to
centralize scratchpad writes and even make the pad immutable. That was the opposite of the intended
blackboard pattern.

The worker contract, dispatch orientation, Codex child hook, and Claude dispatch epilogue now say each
sub-agent should merge its own scoped progress as it works. Deliverable file ownership never includes
the Fray scratchpad, and a root must reconcile concurrent scoped updates rather than act as sole
writer. The existing merge-safety rules remain unchanged: re-read first, preserve all other content,
and never delete, truncate, reinitialize, move, or replace the pad.
