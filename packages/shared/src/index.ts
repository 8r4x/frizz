import { z } from "zod"
import { InteractionLifecycle, InteractionOpaqueId, InteractionRevision, InteractionThreadSlug } from "./interactions.ts"
import { ThreadSlug } from "./thread-slug.ts"

// ---- Attachment intake (drag/drop, paste, file picker) ----
// The "safe tier": formats an agent's Read/file tool consumes with NO conversion step, so a dropped
// file lands on disk and its absolute path — inserted as plain text into the message — is read directly
// by both backends. Images render inline in chat AND are seen visually by Claude/Codex; the doc/text/
// code set is read as text (or, for PDF, natively rendered by Claude's Read). Office formats
// (docx/xlsx/pptx) are DELIBERATELY excluded — they'd reach the agent as opaque zip/XML garbage.
// Inline-renderable raster images: served back to the chat via the gated /local-image proxy and seen
// visually by the agent. SVG is DELIBERATELY not here — it is an XSS vector when served as an image
// (which is why the server's /local-image content-type map omits it), so an attached .svg is treated
// as a document (an openable chip + the agent reads its XML), never rendered inline.
export const ATTACHMENT_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const
export const ATTACHMENT_DOC_EXTENSIONS = [
  "pdf", "svg", "txt", "text", "log", "md", "markdown", "csv", "tsv", "json", "jsonl",
  "yaml", "yml", "toml", "ini", "xml", "html", "htm", "css", "scss", "sql",
  "sh", "bash", "zsh", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go",
  "rs", "java", "kt", "c", "h", "cpp", "cc", "hpp", "cs", "php", "swift", "lua", "r",
] as const
export const ATTACHMENT_EXTENSIONS = [...ATTACHMENT_IMAGE_EXTENSIONS, ...ATTACHMENT_DOC_EXTENSIONS] as const

// Cap on the /attach base64 payload (~chars). A screenshot is small; a PDF can be larger, so the cap
// is generous but bounded — base64 is ~4/3 the byte size, so this is ~18MB of binary.
export const ATTACHMENT_MAX_BASE64_CHARS = 25_000_000
// The equivalent RAW-byte budget (base64 inflates ~4/3), for a client-side pre-check that rejects an
// oversized file with a clear message before it spends time encoding a doomed upload.
export const ATTACHMENT_MAX_BYTES = Math.floor(ATTACHMENT_MAX_BASE64_CHARS / 4) * 3

const ATTACHMENT_EXT_SET: ReadonlySet<string> = new Set(ATTACHMENT_EXTENSIONS)
// Lowercased extension (no dot) of a filename, or "" when it has none.
export function attachmentExtension(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name.trim())
  return m ? m[1].toLowerCase() : ""
}
export function isAllowedAttachmentName(name: string): boolean {
  return ATTACHMENT_EXT_SET.has(attachmentExtension(name))
}
// The <input accept> value for the file picker: every allowed extension as `.ext`.
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(",")

// ---- Frizz board vocabulary (mirrors board/config.mjs) ----

// Declaration order IS the lifecycle order (STATUS_ORDER = FrizzStatus.options), consumed by the
// status pickers and the roadmap-count ordering. `needs-human` is a FIRST-CLASS status — the declared
// "awaiting a human" state and THE queue definition — and sits at the human gate between `active`
// (work in flight) and `blocked` (now narrowed to machine-waits only: blocking_threads / revalidate_at).
export const FrizzStatus = z.enum(["planning", "planned", "active", "needs-human", "blocked", "done", "dismissed"])
export type FrizzStatus = z.infer<typeof FrizzStatus>

// How a blocked thread unblocks. `human` = the awaiting-you queue.
export const BlockMechanism = z.enum(["human", "threads", "timer"])
export type BlockMechanism = z.infer<typeof BlockMechanism>

// ---- Runtime state of the Claude process bound to a thread ----

export const RuntimeState = z.enum([
  "none", // no session ever spawned for this thread
  "spawning",
  "running", // process alive, turn in flight
  "perm-prompt", // process alive, paused on an interactive permission prompt (answer in the terminal)
  "turn-idle", // process alive, waiting at the prompt
  "exited", // tmux session gone or pane dead
])
export type RuntimeState = z.infer<typeof RuntimeState>

// Which agent CLI a dispatch/thread runs on (Codex-support epic, Phase 3). Mirrors BackendKind in
// server/backend/types.ts (the wire can't import it — it lives behind the server boundary). A model
// selection drives this: a Claude model ⇒ "claude", an OpenAI/GPT model ⇒ "codex".
export const Backend = z.enum(["claude", "codex"])
export type Backend = z.infer<typeof Backend>

// One selectable Codex model, derived server-side from the AUTHORITATIVE ~/.codex/models_cache.json
// (the codexModels RPC) rather than a hand-maintained list — the source of two live breakages (a bare
// `gpt-5.6` that codex 400s, and a single hardcoded effort set that's wrong per-model). `slug` is the
// `codex -m` id; `efforts` is exactly that model's supported reasoning levels (5.6 → …/max/ultra, 5.5 →
// …/xhigh), so the effort dropdown offers only what the chosen model actually accepts. Ordered by the
// cache's `priority` (index 0 = the codex default). See .frizz/codex-model-cache.md.
export const CodexModel = z.object({
  slug: z.string(),
  displayName: z.string(),
  defaultEffort: z.string(),
  efforts: z.array(z.string()),
})
export type CodexModel = z.infer<typeof CodexModel>

// A provider-scoped launch profile. The server is the catalogue authority for existing threads:
// callers receive only models that belong to the row's exact backend and each model carries its
// complete supported effort set. The intentionally generic shape also lets a future backend expose
// its own native ids without teaching the browser how to classify model names.
export const ThreadProfileOption = z.object({
  model: z.string().min(1),
  label: z.string().min(1),
  defaultEffort: z.string().min(1),
  efforts: z.array(z.string().min(1)).min(1),
})
export type ThreadProfileOption = z.infer<typeof ThreadProfileOption>

export const ThreadAgent = z.object({
  id: z.string(),
  label: z.string().optional(),
  state: z.string().optional(),
})

// A LIVE background sub-agent the thread's worker dispatched and is now resting against — derived by
// the JSONL tailer from Agent-tool dispatches + their task-notifications, NOT the .frizz file. This is
// what makes a "dispatched a sub-agent, then came to rest" worker read as in-motion rather than idle.
// `running` = the child's transcript is still being appended to; `stale` = no output for a while (a
// completion record we likely missed). Distinct from `ThreadAgent`/`agents` (frizz frontmatter).
export const SubAgentView = z.object({
  label: z.string(), // the dispatch's `description` (e.g. "Investigate nubjs/nub GitHub issue 376")
  startedAt: z.string(), // ISO8601 of the dispatch record
  // running — appending to its transcript now. stale — tracked, but quiet past the staleness ceiling.
  // rested — its RUN ended (the harness notified `completed`/`failed`) while its own fan-out kept
  // running. Not a phantom and not a lie: `completed` does not mean finished — the same notification
  // says outright that a stopped agent can be resumed and may notify again — and a child that rests
  // holding live grandchildren used to take the entire branch off the board with it. See anchorRoots in
  // tailer.ts. Only ever emitted for a DIRECT child that still has something running under it, so it
  // clears itself when that work does. Every liveness reading keys on "running", so a rested row holds
  // nothing back: it does not block a rest, hold the queue, or gate Mark-as-done.
  state: z.enum(["running", "stale", "rested"]),
  // The worker-profile cell (model+effort) from the dispatch's `subagent_type`. It is NO LONGER drawn as
  // a tag on the child rows under the prompt box (maintainer 2026-07-27: the profile belongs to the
  // prompt box's own control one line up, not repeated on every child line); the transcript's dispatch
  // card still shows it, the sidebar rail carries it in the row tooltip, and the drill-in passes it to
  // the drawer. Optional — absent on dispatches without it.
  subagentType: z.string().optional(),
  // The dispatch tool_use id (the stable correlation key: same id on the Agent tool_use block, the
  // completion <task-notification>, and the transcript AgentBlock). Optional — absent on a pre-restart
  // server that doesn't emit it yet → the drill-in drawer's entry point is simply not offered. Present
  // → the banner row / AgentBlock is clickable and resolves this exact child's transcript.
  id: z.string().optional(),
  // Can frizz actually END this child's work right now? Computed SERVER-side (board.ts, the one place
  // holding both the session row and the tailer's telemetry) and never re-derived by a client — the
  // same discipline as `steerable`, and for the same reason: the policy depends on the thread's
  // TRANSPORT, which the browser has no honest way to know.
  //
  // It exists because the × that offers to stop a child must not appear on a row where stopping is
  // impossible (maintainer 2026-07-30: "We shouldn't show the X if it doesn't fucking work"). Only a
  // broker-backed Claude thread has a per-child control channel (`Query.stopTask`); a tmux thread runs
  // its sub-agents inside the CLI process and a codex thread inside its own, and neither exposes one.
  // Absent/false on a pre-restart server's snapshot ⇒ the × is simply not offered on a RUNNING row,
  // which fails toward showing no control rather than a false one.
  stoppable: z.boolean().optional(),
  // ISO8601 of the child transcript's last append (its output file's mtime — the SAME signal that
  // decides running vs stale). Surfaced so a row can show "last active 6 min ago": the state alone only
  // says quiet-for-15-min, not HOW quiet. Optional — absent before the output path resolves, or on a
  // pre-restart server. Minute-bucketed into the board signature server-side, so a running child's
  // steadily-advancing mtime does not spam deltas.
  lastActivityAt: z.string().optional(),
  // ---- what the child is actually DOING, from the provider's own task_* event stream ----
  // A live sub-agent used to be a name and a spinner: start, stop, nothing in between. These come off
  // the Claude Agent SDK's typed task lifecycle (stream-only — none of it is in the session JSONL), so
  // they are present for a BROKER thread and absent for a tmux one, an older CLI, or a pre-restart
  // server. Render each only when set; never assume they arrive together.
  activity: z.string().optional(), // the tool the child is running right now (e.g. "Bash", "Edit")
  // What the current step IS, in words — the provider rewrites it per tool call ("Running Print
  // current date and time"). Measured against a real session this is the richest LIVE field: `summary`
  // stayed empty on every progress event and only arrived with the terminal notification.
  activityDetail: z.string().optional(),
  summary: z.string().optional(), // the provider's rolling one-line summary of the child's work
  toolUses: z.number().optional(), // tool calls the child has made so far
  tokens: z.number().optional(), // total tokens the child has spent so far
  durationMs: z.number().optional(), // the provider's own working-time measure (excludes paused)
  // ---- NESTING: a sub-agent's sub-agent, and so on down ----
  // 1 = a child this thread's worker dispatched itself (the only kind that used to reach any surface).
  // 2 = a grandchild, 3 = a great-grandchild, … Its dispatch is in an ANCESTOR's transcript rather than
  // this thread's, so it is derived from claude's flat descendant sidecars, not from the fold — see the
  // DESCENDANTS note in tailer.ts. Absent on a pre-restart server's snapshot, which is why every reader
  // treats absent as 1 (`isDirectSubAgent`) instead of testing for the field.
  depth: z.number().optional(),
  // The dispatch tool_use id of the sub-agent that dispatched THIS one — the `id` of another row in the
  // same list. Absent at depth 1 (the thread itself is the parent). Present → the row indents under it.
  parentId: z.string().optional(),
})
export type SubAgentView = z.infer<typeof SubAgentView>

// A sub-agent THIS thread's worker dispatched itself, as opposed to one of its descendants.
//
// Every LIVENESS reading keys on this and never on the raw list. A descendant has no retirement signal
// in this thread's transcript — a direct child clears on its <task-notification>, but a sidecar is
// written once and never deleted — so counting descendants as live work would hold a thread out of the
// queue (hasLiveBackgroundWork) for the full staleness window after a grandchild finished, which is
// exactly the invisible-for-hours failure the queue exists to prevent. Descendants are a RENDERING
// concern: they show what is happening under the thread, and they change no thread state.
export function isDirectSubAgent(agent: { depth?: number }): boolean {
  return (agent.depth ?? 1) === 1
}

// A LIVE background SHELL the worker launched (Bash run_in_background:true) — same tailer tracking as a
// sub-agent (dispatch → launch output path → task-notification clear). Foreground-blocking waits keep
// the turn in-flight, so the spinner already covers them; this is for ops that PERSIST across a rest
// (a CI watcher, a long build). New servers include the stable tool-use id so the row can open its
// read-only output drawer; it stays optional for old snapshots. The raw command remains behind that
// drawer's scoped RPC rather than inflating or exposing it in every board snapshot.
export const BgShellView = z.object({
  label: z.string(), // the command's `description`, else its first-line summary
  startedAt: z.string(), // ISO8601 of the launch record
  state: z.enum(["running", "stale"]),
  id: z.string().optional(),
  // Can frizz actually END this shell right now? The same contract as SubAgentView.stoppable — computed
  // server-side, never re-derived by a client — but it takes TWO answers, because a shell's control
  // handle is not implied by the thread's transport alone:
  //   · the TAILER contributes "we hold a provider task handle for this shell" (its launch ack names
  //     one, or the task stream paired one to its tool_use id);
  //   · the BOARD contributes "this thread has a control channel at all" (broker-backed Claude).
  // Both must hold. The tailer's half is what closes the seconds-long window between a shell's row
  // appearing (at its tool_use) and its task id arriving (at its launch ack), where an × keyed only on
  // the transport would render and then fail — "We shouldn't show the X if it doesn't fucking work".
  //
  // Until 2026-08-01 this field did not exist and no shell could be stopped: the server refused
  // categorically, on the belief that frizz "holds no handle on its process". That was measured wrong —
  // a background Bash is a TASK in the same session-wide registry a sub-agent lives in, so
  // `Query.stopTask` ends it (verified end-to-end in backend/_live_shell_stop.mts: the OS process is
  // gone inside a second).
  stoppable: z.boolean().optional(),
  // Frizz cannot read this shell's output, so the row must NOT offer a drill-in. True only for a CODEX
  // background exec: codex keeps a yielded command's output inside its own session and hands it back
  // only when the model polls, so there is no file for frizz to tail — unlike a Claude shell, whose
  // output file frizz reads directly. Absent ⇒ readable, which is every row that predates codex shells.
  //
  // A positive flag for the EXCEPTION rather than a `readable` that every existing row would have to
  // start setting: an old snapshot then keeps its drill-in instead of silently losing it.
  outputUnavailable: z.boolean().optional(),
  // The command this shell runs, when frizz knows it independently of the label. Set only on a CODEX
  // row, where it is the ONE thing the board's copy of the shell and the transcript's copy share — see
  // lib/childOps.ts mergeBackgroundShells, which reconciles the two on it. A Claude row leaves it
  // absent: its two copies already reconcile on the launch tool_use id, and a `command` that merely
  // repeated the label would make two identically-described shells collide into one row.
  command: z.string().optional(),
  // ISO8601 of the shell output file's last write — "last active 6 min ago" for a quiet-but-live
  // watcher. Optional (see SubAgentView.lastActivityAt).
  lastActivityAt: z.string().optional(),
  // The PROVIDER's session-wide background-task handle (`bzvtnt3ig`), as distinct from `id`, which is
  // the launch tool_use id. Both name the same shell and neither is a substitute for the other:
  // `id` is what the two copies of a row reconcile on, and this is the handle the runtime hands the
  // MODEL — "Command running in background with ID: bzvtnt3ig" is the only id a worker ever sees, so
  // it is the one it registers a `shell` watcher against. Matching on `id`/`label` alone meant every
  // such watcher was unfireable (scheduler.evalWatchers, 2026-08-14). Absent for a CODEX row, whose
  // single `processId` IS its `id`, and for a Claude row between its tool_use and its launch ack.
  taskId: z.string().optional(),
})
export type BgShellView = z.infer<typeof BgShellView>

// WHY "Mark as done" stopped to ask instead of ending the session outright. The server already knows
// the exact evidence it refused on (an executing turn, named live children, or no telemetry at all) —
// this carries it to the confirm dialog so the human reads "2 sub-agents and 1 background shell are
// still running, here they are" rather than a bare "this thread is still running". Labels are the same
// worker-authored strings the board's ops strip already renders; the lists are capped and the true
// totals travel separately so a long list can say "+N more" instead of silently truncating.
export const CompletionHoldOp = z.object({
  label: z.string(),
  state: z.enum(["running", "stale"]),
})
export type CompletionHoldOp = z.infer<typeof CompletionHoldOp>
export const CompletionHold = z.object({
  turnInFlight: z.boolean().default(false), // the session's own turn is mid-execution
  // Telemetry is missing entirely (live runtime, unreadable transcript). We can neither confirm nor
  // rule out work in flight, so the dialog says exactly that rather than inventing a specific cause.
  unobservable: z.boolean().default(false),
  subAgents: z.array(CompletionHoldOp).default([]),
  subAgentCount: z.number().default(0), // total live sub-agents (≥ subAgents.length)
  bgShells: z.array(CompletionHoldOp).default([]),
  bgShellCount: z.number().default(0), // total live background shells (≥ bgShells.length)
})
export type CompletionHold = z.infer<typeof CompletionHold>

// A PENDING native AskUserQuestion — the worker (or any session) called Claude Code's AskUserQuestion
// tool and is frozen at its TUI dialog, no tool_result yet. Safety net for pre-contract / adopted
// sessions that bypass the thread-file ask channel: we surface the REAL question(s) so the human knows
// what's being asked, and route them to answer in the terminal (a deny-hook enforces the contract
// channel for compliant workers; answering here is deliberately NOT wired — too fragile). Structured
// input is capped defensively (never trust a foreign tool's payload shape).
export const AskOption = z.object({
  label: z.string(),
  description: z.string().optional(),
})
export const AskQuestion = z.object({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(AskOption),
})
export const PendingAsk = z.object({
  questions: z.array(AskQuestion),
})
export type PendingAsk = z.infer<typeof PendingAsk>

// A backend-native terminal modal that has paused the session outside the transcript. Deliberately
// carries no option values or tool payload: those may contain commands, repository data, or secrets;
// Frizz only needs a safe family/title to route the human to the terminal without auto-answering.
export const NativeInputRequired = z.object({
  kind: z.enum(["tool-approval", "permission", "confirmation", "selection"]),
  title: z.string().max(120),
})
export type NativeInputRequired = z.infer<typeof NativeInputRequired>
// ---- THE AWAITING FENCE ---------------------------------------------------------------------------
// A worker ends every turn in exactly ONE of three terminal states: a ```question (it needs the human), a
// ```awaiting park (it is waiting on work that is actually running), or ```done. This is that middle one,
// and it is PURE STRUCTURE — a list of things frizz can look up, a duration, and one line of prose.
//
//   shell:  <runtime task id>   a background shell it launched      → checked against live telemetry
//   agent:  <runtime agent id>  a sub-agent it dispatched           → checked against live telemetry
//   timer:  tmr_…               a timer it set                      → checked against thread_timer
//   pr:     wpr_…               a PR watcher it registered          → checked against its PR registry
//   for:    2h                  REQUIRED. How long the park may stand (parseAwaitingDuration).
//   reason: <one line>          The one free-text field — what the human reads on the resting card.
//
// REGISTRATION IS ORTHOGONAL TO THIS FENCE (maintainer 2026-08-15). Dispatching a shell or a sub-agent,
// setting a timer, registering a PR watcher — none of that is a fence, and none of it parks anything.
// Those things simply exist and frizz watches them. The fence is only how a worker declares that it has
// STOPPED, and names which of them it stopped for.
//
// EVERY NAME IS CHECKED, THE MOMENT THE FENCE LANDS. All valid ⇒ the thread goes to Held. Any name that
// is dead, unknown, or another thread’s ⇒ the worker is BUMPED immediately. It does not fail open and it
// does not park: a wait that cannot resolve must never be able to look like one that can.
//
// WHAT WAS DELETED, AND WHY, BECAUSE EACH ONE WAS A WAY TO STALL SILENTLY:
//   `human: <person>`  parked a thread in Held and NOTHING EVER FIRED IT. Waiting on a person is a
//                      ```question — that is what a question is for.
//   `timer: <instant>` an absolute instant the worker computed. One was written 5h55m in the past; it
//                      parsed, armed nothing, and stalled its thread for 5.5 hours. `for:` is a duration
//                      precisely so this cannot be expressed (see parseAwaitingDuration).
//   `pr-watch: ref`    free text the poller armed from. A PR is now a registered watcher with an id.
//   `watch: id`        superseded: a shell is named directly by its runtime handle.
//   `pr:`/`ci:`/`session:` legacy conditions nothing has fired for a long time.
//   prose bodies       replaced by the single `reason:` line, so the fence is machine-checkable.
export const AwaitingHint = z.object({
  kind: z.enum(["shell", "agent", "timer", "pr", "for", "reason"]),
  value: z.string(),
})
export type AwaitingHint = z.infer<typeof AwaitingHint>

/** The four kinds that NAME A LIVE THING. Every one is checked against something frizz can look up — a
 *  runtime handle in this thread's telemetry, or a row in one of its registries — which is the whole
 *  point of the grammar. `for`/`reason` describe the park itself and name nothing. */
export const AWAITING_ITEM_KINDS = ["shell", "agent", "timer", "pr"] as const
export type AwaitingItemKind = (typeof AWAITING_ITEM_KINDS)[number]
export function isAwaitingItemKind(kind: string): kind is AwaitingItemKind {
  return (AWAITING_ITEM_KINDS as readonly string[]).includes(kind)
}

/** `for: 2h` — how long this park may stand before frizz bumps the worker to re-check everything.
 *
 *  A DURATION, NEVER AN INSTANT, and that is the entire point. The grammar this replaced took an absolute
 *  ISO instant, which a worker has to compute — and on 2026-08-15 one wrote `timer: 2026-08-14T19:45:00Z`
 *  into a fence it published at `01:39:59Z`, an instant already 5h55m gone. It parsed (the old validator
 *  checked shape only), armed nothing (an already-past timer is never registered — the boot no-mass-fire
 *  guard), and the thread sat 5.5 hours looking parked with nothing able to wake it. A duration cannot be
 *  written in the past, needs no clock arithmetic and carries no timezone, so that failure is not merely
 *  caught here — it is unrepresentable. */
const AWAITING_DURATION_RE = /^(\d{1,5})(s|m|h|d)$/
const DURATION_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
/** The park's ceiling. A worker may ask for less; anything longer is capped rather than refused, so a
 *  fat-fingered `for: 9999d` still parks — it just cannot disappear a thread for a decade. */
export const AWAITING_FOR_MAX_MS = 24 * 60 * 60 * 1000
/** Milliseconds, or null when the value is not a duration. */
export function parseAwaitingDuration(value: string): number | null {
  const m = AWAITING_DURATION_RE.exec(value.trim())
  if (!m) return null
  const ms = Number(m[1]) * DURATION_UNIT_MS[m[2]]
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.min(ms, AWAITING_FOR_MAX_MS)
}

// A user-chosen snooze is UI lifecycle state, not agent-authored transcript state. The browser
// serializes local date/time input with Date#toISOString, so the wire/storage representation is one
// unambiguous UTC instant. Keeping this stricter than the legacy awaiting-timer grammar avoids locale
// strings and offset-normalization surprises at the RPC boundary.
export const SnoozeUntil = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  "Snooze time must be an ISO-8601 UTC instant",
).refine((value) => {
  const instant = Date.parse(value)
  // Date.parse normalizes impossible calendar dates in some runtimes (for example February 31).
  // Round-trip the canonical UTC serialization so the durable deadline is a real exact instant.
  return Number.isFinite(instant) && new Date(instant).toISOString() === value
}, "Snooze time must be valid")
export type SnoozeUntil = z.infer<typeof SnoozeUntil>

// The follow-up a snooze carries. Its presence is what turns a snooze from a passive reminder (the
// card re-surfaces, you act) into a SCHEDULED BUMP (frizz resumes the agent with this text at the
// deadline). Trimmed at the boundary so whitespace can never arm a wake that delivers nothing, and
// capped like a composer message because it is delivered as an ordinary user turn.
export const SNOOZE_PROMPT_MAX = 4000
export const SnoozePrompt = z.string().trim().min(1).max(SNOOZE_PROMPT_MAX)
export type SnoozePrompt = z.infer<typeof SnoozePrompt>

// ---- THE RECURRING PROMPT (scheduler SOURCES 4 and 5) --------------------------------------------
// ONE piece of text, and up to two independent reasons to send it:
//
//   ON REST      (SOURCE 5) — every time the thread comes to a stop. No clock and nothing to tune: if
//                it stopped, it is prompted. This is what drives an effort forward.
//   ON SCHEDULE  (SOURCE 4) — every N minutes on a clock the operator sets, consulting nothing about
//                what the thread is doing and DELIVERED MID-TURN. This is what reaches a thread that
//                never stops.
//
// Either, both, or neither. NEITHER IS THE OFF STATE — there is deliberately no separate enable switch,
// because with both triggers off nothing can fire and a third toggle would only be a way to disagree
// with the other two (maintainer 2026-08-03: "we can delete the top-level toggle since you can now
// achieve that by just disabling both of the other two toggles").
//
// WHY ONE PROMPT AND NOT TWO FEATURES. These shipped as separate features with separate prompts, and
// the argument for keeping them apart rested on something that is no longer true. While a beat was held
// until the thread rested, a schedule could only ever deliver AT a rest — and the rest trigger fires at
// every rest — so with one shared text the schedule's deliveries were a strict subset of the rest
// trigger's: same words, same instants, nothing added. Mid-turn delivery is what pulled the two apart,
// and once they genuinely diverge, "nudge this thread whenever it stops, and at least every N minutes
// even if it doesn't" is ONE intent that used to cost two prompts and two toggles to express.
//
// What that costs, stated plainly: you can no longer run two DIFFERENT texts on the two triggers.
// Weighed and accepted — the shared-intent case is the common one.
export const RECURRING_PROMPT_MAX = SNOOZE_PROMPT_MAX
// One minute floor: a delivery is read at the agent's next sampling boundary, so a sub-minute cadence
// buys no promptness — it only churns the outbox and talks over the work. One day ceiling keeps a
// forgotten schedule from being indistinguishable from a dead one.
export const RECURRING_MIN_INTERVAL_SECONDS = 60
export const RECURRING_MAX_INTERVAL_SECONDS = 24 * 60 * 60
export const RecurringPromptText = z.string().trim().min(1).max(RECURRING_PROMPT_MAX)

// WHAT THE PANEL OPENS WITH on a thread that has never armed one, and what every new thread is born
// carrying. The overwhelmingly common reason an operator reaches for this control is the same one every
// time — the thread stopped with work left in it — so the panel writes that sentence for them rather
// than making them phrase it again. It is a starting point, not a fixed string: it is seeded into an
// editable textarea and anything typed over it wins.
//
// IT IS DELIBERATELY LOPSIDED (maintainer 2026-08-14: "should bias the agent strongly towards continuing
// with its work if there is incomplete work, unless there is a pressing or imminent decision that is
// needed from the human"). The two clauses used to read as equal branches — keep going, or ask — and an
// even split is not what this delivery is for: it lands on a thread that has already stopped, so the
// only outcome worth buying is the one where it starts again. Hence the first sentence sends the worker
// straight back to the work and NAMES the endings a worker mistakes for one, because the ordinary
// failure is not a worker that refuses to continue, it is one that mistook a milestone for the finish.
//
// The stop clause is what keeps that from being a nag, and it is narrowed rather than dropped. A thread
// told only to "keep going" answers a question it cannot resolve by guessing; told this, it hands back
// the one class of question worth stopping for — the human's own, and blocking NOW — through the fence
// the board already renders as an answerable card, and decides the rest itself.
//
// Nothing here teaches the ```done exit, because the trailer already does (`OPT_OUT_NOTE`), on every
// delivery, whatever the operator has typed over this text.
/** The triggers a Goal carries when nobody has chosen otherwise — the stop hook on, and the question
 *  hold with it. ONE definition, read by BOTH the dispatch that arms a brand-new thread and the footer
 *  panel that seeds an unarmed one, because a default that lives in two places is a default that
 *  eventually disagrees with itself.
 *
 *  `heartbeat` off: a cadence nobody chose is exactly the ambiguity the minutes field exists to remove.
 *  `postCompaction` off: it is useless without a prompt that LINKS the doc to re-read, which only the
 *  worker can write. */
export const DEFAULT_GOAL_TRIGGERS = {
  stopHook: true,
  heartbeat: false,
  postCompaction: false,
  pauseOnQuestions: true,
} as const

// NO BACKTICKED FENCE NAMES IN HERE. This text is rendered as markdown wherever the operator sees it,
// and a lone ``` opens a code block that swallows the rest of the card. The trailer can afford them; the
// prompt says "question fence" in words instead.
export const DEFAULT_RECURRING_PROMPT =
  "Keep going. If ANY part of the original task is unfinished, unverified, or deferred, resume it NOW — a milestone, a green test run, a written-up plan and a long turn are none of them endings. Stop only for a decision that is genuinely the human's AND that blocks you right now: ask that one in a question fence. Every other open choice — a name, a default, a reversible design call — is yours to make: decide it, say in one line which way you went, and carry on."
export const RecurringIntervalSeconds = z
  .number()
  .int()
  .min(RECURRING_MIN_INTERVAL_SECONDS)
  .max(RECURRING_MAX_INTERVAL_SECONDS)

// What the board renders for a thread carrying one. The three triggers are independent booleans rather
// than one `enabled` flag, and the text survives all of them being switched off so re-arming costs no
// retyping. `intervalSeconds` is present whenever a schedule has ever been set, INCLUDING while the
// heartbeat is off — otherwise flipping the schedule back on would lose the cadence the operator chose.
export const ThreadRecurringPrompt = z.object({
  prompt: z.string(),
  /** The three mechanisms, named as the panel labels them. `stopHook` fires at every rest; `heartbeat`
   *  fires on `intervalSeconds`; `postCompaction` fires whenever the harness summarizes the thread's
   *  context away. The latter two both reach the agent mid-turn. */
  stopHook: z.boolean(),
  heartbeat: z.boolean(),
  postCompaction: z.boolean(),
  /** NOT a fourth trigger — a HOLD over all three. While it is on, nothing is sent for as long as the
   *  thread is blocked on the human: an unanswered ```question fence, a native ask, or a permission
   *  prompt. The footer panel seeds it ON for a fresh arming, with the stop hook, because they are one
   *  intent — see scheduler.ts, "WHAT A PENDING QUESTION DOES TO ALL THREE TRIGGERS". The stored column
   *  still defaults OFF, so an existing row and an older caller both keep the behaviour they had. */
  pauseOnQuestions: z.boolean(),
  intervalSeconds: z.number().int().positive().optional(),
  armedAt: z.string(),
  /** Last delivery per trigger; stamped separately so each reads its own clock. */
  lastRestFiredAt: z.string().optional(),
  lastScheduleFiredAt: z.string().optional(),
  lastCompactFiredAt: z.string().optional(),
}).strict()
export type ThreadRecurringPrompt = z.infer<typeof ThreadRecurringPrompt>

// ---- The opt-out ---------------------------------------------------------------------------------
// THE OPT-OUT IS THE ```done FENCE, as of 2026-08-11. A worker that signs off as done has said "there
// is no further work here", and frizz stops prompting it — every trigger, because a run that keeps
// being woken has not stalled and the whole point of the signal is that it has finished.
//
// IT USED TO BE A SENTINEL WORD, `ALLDONE`, and collapsing the two is the change. One vocabulary beats
// two: the worker already has to end its turn with a fence, and a second magic token that ALSO means
// "stop" was a rule to remember on top of a rule to remember. Maintainer 2026-08-11: "we should drop
// ALLDONE in favor of simply ```done".
//
// It is not a "skip this one" — it is the end of the arrangement, and nothing but new activity on the
// thread reopens it. Every delivered message therefore names it in one de-emphasized line and warns
// against it in the same breath: the failure it guards is a worker that signs off to look tidy and
// silently parks an effort nobody is watching.
//
// Mechanically it needs no stored state at all, which is what makes it honest: both the fence and the
// legacy sentinel are folded off the FINAL assistant message, so either holds for exactly as long as
// that message is the thread's last word. Anything the thread says or receives afterwards reopens the
// loop by itself.

/** LEGACY. The sentinel that used to be the opt-out, superseded by the ```done fence on 2026-08-11.
 *
 * STILL HONOURED, and deliberately: workers dispatched before the change are running right now with
 * trailers that told them to reply `ALLDONE`, and a scheduler that stopped recognizing it the same day
 * would silently take their exit away and loop them forever. It is no longer ADVERTISED anywhere — see
 * `OPT_OUT_NOTE` — so nothing new learns it, and the recogniser can be deleted once no session predates
 * the change. */
export const ALLDONE_SENTINEL = "ALLDONE"

/** Does this assistant text defer its recurring prompt? True iff some line, stripped of markdown
 * emphasis/backticks and trailing punctuation, IS the sentinel.
 *
 * CASE-SENSITIVE, which is load-bearing now that the word is `AWAITING`: frizz's own signal-fence
 * grammar opens with ```awaiting, and a worker parking on a fence writes that token constantly. Lowered
 * case would make every ```awaiting fence silently suppress a bump as well. */
export function saysAllDone(text: string | undefined): boolean {
  if (typeof text !== "string") return false
  for (const line of text.split(/\r?\n/)) {
    // Tolerate the ways a model dresses a line: a list bullet, bold/italic, code ticks, a quote marker,
    // and trailing punctuation. The comparison itself is EXACT and case-sensitive — "all done" is prose,
    // and only the shouted token is the opt-out.
    const bare = line.trim().replace(/^[*_`>\s-]+/, "").replace(/[*_`.!\s]+$/, "")
    if (bare === ALLDONE_SENTINEL) return true
  }
  return false
}

// THE TRAILER, in one de-emphasized line, on both sources.
//
// It has two jobs pulling against each other: a worker being re-prompted needs to know the opt-out
// exists at all, and it must not reach for it. So the line OFFERS and WARNS in the same breath, and
// stays parenthetical — the operator's own words are the message; this is a footnote about the
// machinery. Expanding it is how a worker starts treating "am I allowed to stop?" as the question,
// instead of the work it was actually sent.
const OPT_OUT_NOTE =
  "To stop these, sign off with a ```done fence — but ONLY when the work is genuinely finished:" +
  " it files this thread away, and nothing but new work from the human reopens it."

/** What frizz delivers when the ON REST trigger fires: the operator's words VERBATIM, then the trailer.
 * Kept beside the parser so the wording sent and the wording recognized can never drift apart.
 *
 * IT DOES NOT ADVERTISE THE OTHER EXIT, and that is a budget decision rather than an oversight. An
 * ```awaiting fence on a wait the scheduler owns now holds this trigger too (scheduler
 * `parkedOnAWaitItCannotAdvance`), so a parked worker could in principle be told so here — but the
 * trailer is capped at a footnote, the shared note already spends all of it, and the worker contract
 * teaches the park at length. A worker that parks stops being bumped, so it never reads this line
 * again; the one that does read it is mid-work, where ```done is the only exit worth naming.
 *
 * `overQuestion` IS THE ONE CASE THAT NEEDS MORE THAN A FOOTNOTE. In Autonomous mode the rest trigger
 * fires over an unanswered ```question fence (scheduler `restMessageIsSignedOff`), so this delivery can
 * land on a worker whose own last word was a question to the human. Handed the bare goal there, the
 * honest thing for it to do is ask again — its question really is unanswered — and the operator gets the
 * same card twice, which is precisely the loop the unconditional hold used to prevent. So the delivery
 * that crosses a pending question SAYS SO: no answer is coming, make the call yourself. The clause
 * carries no parenthesis, because `RECURRING_TRAILER` matches the trailer up to the first one. */
export function restPromptMessage(prompt: string, opts: { overQuestion?: boolean } = {}): string {
  const note = opts.overQuestion ? `${AUTONOMOUS_OVER_QUESTION_NOTE} ${OPT_OUT_NOTE}` : OPT_OUT_NOTE
  return `${prompt.trim()}\n\n(Goal — sent each time you come to rest. ${note})`
}

// What the trailer adds when the bump crosses the worker's own unanswered question. It has to do two
// things the plain note does not: overrule the worker's correct instinct to re-ask, and tell it what to
// do with the decision instead — because a call the operator cannot see is worse than the question.
const AUTONOMOUS_OVER_QUESTION_NOTE =
  "Your ```question is still unanswered and the operator has AUTONOMOUS MODE on for this thread," +
  " which means they are not coming to answer it: decide it yourself, say in one line which way you" +
  " went and what would reverse it, and carry on. Do NOT re-ask it."

/** What frizz delivers when the POST-COMPACTION trigger fires (scheduler SOURCE 7).
 *
 * This one lands in a context that has just been summarized away, which is the whole reason it exists —
 * so unlike its two siblings the trailer must first say WHERE the reader is, or the operator's words
 * arrive with nothing to attach to. It also answers the compaction preamble in the same breath: a
 * worker reading "a previous conversation that ran out of context" routinely treats it as a report on
 * ITSELF and starts winding down, and this delivery is the one piece of frizz text guaranteed to land
 * in that exact window.
 *
 * Like the schedule trigger's, it may arrive MID-TURN — a compaction does not stop the work. */
export function compactionPromptMessage(prompt: string): string {
  return (
    `${prompt.trim()}\n\n(Goal — your context was just compacted. This is what you asked to` +
    " be handed back: re-ground on it before doing anything else, and treat it as authoritative over" +
    " anything the summary implies. The window is close to empty again, which is normal and not a reason" +
    ` to wind down or hand off. ${OPT_OUT_NOTE})`
  )
}

/** What frizz delivers when the ON SCHEDULE trigger fires. Same text, same shape, and it names the
 * cadence — which is the ONE thing that distinguishes the two deliveries now that the prompt is shared.
 * A worker needs that distinction: a scheduled delivery may arrive MID-TURN, so reading one does not
 * mean it has stopped.
 *
 * The trailer's exact wording is pinned by `parseRecurringPrompt` below and by the prompt goldens —
 * change one and you must change all three. */
export function schedulePromptMessage(prompt: string, intervalSeconds: number): string {
  return `${prompt.trim()}\n\n(Goal — sent every ${formatIntervalLabel(intervalSeconds)}. ${OPT_OUT_NOTE})`
}

/** "10 min" / "2 hr" / "90s" — whole units only, because a cadence printed to the second promises a
 * precision the delivery does not have (it is read at the agent's next sampling boundary). */
export function formatIntervalLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`
}

/** What a delivered recurring prompt looks like once it is back out of the transcript.
 *
 * The chat needs to tell a delivery from a human message, and to say WHICH TRIGGER fired, and the
 * transcript carries no structure — a delivery is an ordinary user turn. So this parses the trailer the
 * two composers above emit, exactly as `parseGithubWakeSteer` parses the steer its own formatter writes.
 * That is not a text GUESS: the format is frizz's, it is defined ten lines up, and both directions live
 * in this file so they cannot drift. Anything that does not match returns undefined and renders as it
 * did before — text is never lost to a parse. */
export interface RecurringPrompt {
  kind: "rest" | "schedule" | "compaction" | "signoff"
  /** The cadence as the trailer stated it ("10 min"); absent for a rest or post-compaction delivery. */
  every?: string
  /** The operator's own words, with the trailer removed. */
  prompt: string
}
// The LEGACY alternates matter: transcripts written before the two features merged carry
// "Stop hook — …" / "Heartbeat — sent every …", and those messages are still sitting in every open
// thread on disk. Dropping them from the pattern would not lose the text (a non-match falls through to
// plain rendering) but it would silently demote a whole thread's history from wake dividers to prose.
//
// The post-compaction alternate does not say "sent …" at all — its trailer opens by telling the reader
// where they are, because it lands in a window that was just emptied. So it is matched on its own
// opening clause rather than bent into the shared "sent X" shape.
const RECURRING_TRAILER =
  /\n\n\((?:Goal|Recurring prompt|Stop hook|Heartbeat) — (?:sent (?:(each time you come to rest)|every ([^.)]+))|(your context was just compacted))\. [^)]*\)$/
export function parseRecurringPrompt(text: string | undefined): RecurringPrompt | undefined {
  if (typeof text !== "string") return undefined
  // Frizz's built-in sign-off reminder (scheduler SOURCE 9). It carries no trailer — it is not the
  // operator's text with a note attached, it IS frizz's text — so it is matched on its own opening
  // marker and collapsed like any other repeating frizz delivery. Left as a card it dominated the queue
  // item it was complaining about (maintainer 2026-08-12, with a screenshot of exactly that).
  if (text.trimStart().startsWith(SIGNOFF_NUDGE_MARKER)) return { kind: "signoff", prompt: "" }
  const m = RECURRING_TRAILER.exec(text.trimEnd())
  if (!m) return undefined
  const prompt = text.trimEnd().slice(0, m.index).trim()
  if (!prompt) return undefined
  if (m[3]) return { kind: "compaction", prompt }
  return m[2]
    ? { kind: "schedule", every: m[2].trim(), prompt }
    : { kind: "rest", prompt }
}

// ---- ONE-OFF TIMERS (scheduler SOURCE 6) ---------------------------------------------------------
// A worker's own alarm clock: text it asks frizz to hand back at ONE instant, once. It is the recurring
// prompt's ON SCHEDULE trigger with the repetition taken out — same durable outbox, same mid-turn
// delivery — and a thread may hold ARBITRARILY MANY at a time, which is the whole reason they are rows
// of their own rather than another set of `recurring_*` columns on the session (one row can hold one
// arrangement; a worker that wants "check the deploy in 10 min AND re-read the spec in an hour" needs
// two).
//
// MID-TURN, like the heartbeat and unlike the human's snooze. A timer set for 15:00 that a busy thread
// only hears at 15:50 has not kept its promise, and "in ten minutes" is the instruction being obeyed.
// Both transports take a queued mid-turn message without aborting the work in flight.
//
// NO ALLDONE OPT-OUT, and no trailer teaching one. That sentinel exists because a RECURRING trigger is
// an infinite bump generator with no terminating condition; a one-off has exactly one delivery in it, so
// the only thing worth saying in the trailer is that this was a timer and it will not fire again.
export const TIMER_PROMPT_MAX = SNOOZE_PROMPT_MAX
// Ten seconds is the scheduler's own tick, so a shorter delay would promise a precision the delivery
// cannot have. Thirty days is far past any real "come back to this later" while still rejecting a
// mistyped epoch. The armed CAP is what makes "arbitrarily many" safe: a looping tool call cannot fill
// the table, and 64 outstanding alarms is well beyond what any real effort schedules.
export const TIMER_MIN_DELAY_SECONDS = 10
export const TIMER_MAX_DELAY_SECONDS = 30 * 24 * 60 * 60
export const TIMER_MAX_ARMED = 64

export const TimerPromptText = z.string().trim().min(1).max(TIMER_PROMPT_MAX)

/** What frizz delivers when a one-off timer fires: the worker's own words VERBATIM, then a one-line
 *  trailer naming the INSTANT — with several timers armed at once, the instant is the only thing that
 *  says WHICH one this is.
 *
 *  Deliberately NOT parsed back out for a bespoke transcript line, unlike a recurring delivery. That
 *  parser exists because a recurring prompt repeats the same paragraph down the whole transcript and has
 *  to collapse to a divider; a one-off is said once, so the chat's generic first-party wake card — the
 *  one already written for "a CI/timer/limit wake" — shows it correctly with no new component. */
/** What frizz delivers when one of a thread's background shells finishes while the thread is RESTING.
 *
 *  There is no operator text to carry — nobody asked for this wake, a finished shell simply happened —
 *  so the message IS the news, and it has two jobs: say WHICH shell precisely enough to act on, and say
 *  why frizz is the one saying it. The second matters because the agent has a runtime notification for
 *  exactly this event and will reasonably wonder why it did not arrive: it only ever reaches a RUNNING
 *  turn, so a shell that finishes behind a rested worker is never reported by anyone else. */
/** What frizz delivers when a REGISTERED PR WATCHER has something to report.
 *
 *  Two things can move and the message names which: CI reaching a terminal verdict, and new review or
 *  comment activity. Both in one message when both happened in one poll — a worker woken twice for one
 *  glance at the same PR is a wasted turn.
 *
 *  It says the watcher is STILL ARMED, because the opposite is the expensive mistake: a worker that
 *  thinks its watcher is spent will re-register (a duplicate, so two wakes per event) or stop waiting. */
export function prWatchWakeMessage(input: {
  target: string
  checks?: { verdict: "passing" | "failing"; passed: number; failed: number; failing: string[] }
  review?: string
  merged?: boolean
  closed?: boolean
}): string {
  const lines: string[] = []
  if (input.merged || input.closed) {
    lines.push(`\u23f0 ${input.target} was ${input.merged ? "MERGED" : "CLOSED"}.`, "")
    lines.push("(This watcher is spent — there is nothing further to report on a finished PR.)")
    return lines.join("\n")
  }
  if (input.checks) {
    const c = input.checks
    lines.push(
      c.verdict === "passing"
        ? `\u2705 CI PASSED on ${input.target} — ${c.passed} check${c.passed === 1 ? "" : "s"} green.`
        : `\u274c CI FAILED on ${input.target}${c.failing.length ? `: ${c.failing.join(", ")}` : ""}.`,
    )
  }
  if (input.review) {
    if (lines.length) lines.push("")
    lines.push(input.review)
  }
  lines.push("", "(Registered PR watcher — STILL ARMED. It reports again on the next CI change, review or" +
    " comment. Drop it with `mcp__frizz__watch_pr` when it stops mattering.)")
  return lines.join("\n")
}

export function shellDoneMessage(shell: { taskId?: string; label: string; status: "completed" | "failed" | "killed" }): string {
  const what = shell.taskId ? `\`${shell.taskId}\` — ${shell.label}` : shell.label
  const verb = shell.status === "failed" ? "FAILED" : shell.status === "killed" ? "was STOPPED" : "finished"
  return (
    `\u23f0 Your background shell ${verb}: ${what}.\n\n` +
    "(Frizz sends this because it finished after you came to rest, where your runtime's own completion" +
    " notification does not reach you. Read its output if you still need it.)"
  )
}

// ---- THE BUILT-IN SIGN-OFF NUDGE (scheduler SOURCE 9) --------------------------------------------
// The rules arrive when they are ABOUT TO BE USED, rather than 200k tokens earlier in a system prompt
// the agent has long since stopped attending to. Maintainer 2026-08-11: "the agent seems to often
// forget about this stuff when it's added to the additional system prompt anyway."
//
// Delivered ONLY to a rest that carried NO fence at all — a thread that signed off correctly never sees
// it, so the whole cost of the mechanism is paid by exactly the rests that were about to produce an
// untriageable queue item. That is the invariant it exists to buy: every item in the queue is a
// question you can answer or a checkmark you can archive.
//
// IT REACHES EVERY THREAD, including one the operator has put in AUTONOMOUS MODE. That case was carved
// out for a day (2026-08-13 → 2026-08-14) on the reading that the invariant is about a queue a HUMAN
// triages, so a thread nobody is waiting on does not need it. Two things sank that: this text now opens
// by sending a half-finished thread back to the WORK rather than offering a menu of ways to stop, so it
// no longer pulls against the Goal arriving beside it; and it is the only delivery that names the
// ```awaiting park at all (the Goal's own trailer deliberately does not — see restPromptMessage), so
// silencing it left the longest-running threads — the autonomous ones, the ones most likely to hold
// background work — with no way to learn how to park on it.
//
// SHORT, because it competes with the agent's own conclusion for attention, and because a long one
// invites the agent to treat "how do I sign off?" as the task. Three facts and a shape.
//
// IT LEADS WITH "GO BACK TO THE WORK", not with the fence menu (2026-08-14, the same change that made
// `DEFAULT_RECURRING_PROMPT` lopsided — see the comment there). The two deliveries land on the SAME rest
// and must not pull against each other: a nudge whose first instruction is "pick one of these three ways
// to stop" hands a half-finished thread a menu with no correct entry on it, and the agent picks the
// closest — usually `done`, which is a dismissal. So the fence menu is now the OTHERWISE branch, and the
// first branch says the fence is not what a thread with parts left owes. Nothing is lost from the
// invariant: a thread that goes back to work leaves the queue by SPINNING, which is the outcome the
// reminder wanted anyway.
/** The nudge's opening line, exported because it does DOUBLE DUTY: it tells the agent whose message
 *  this is, and it is what the transcript matches on to collapse the delivery to one hairline rather
 *  than rendering frizz's boilerplate as a card over the agent's own words. A text match is honest here
 *  — frizz writes this string and frizz reads it, both from this file. */
export const SIGNOFF_NUDGE_MARKER = "**This message is from frizz, not from the human.**"

/** The live things a thread could legitimately park on, appended to the reminder so the agent does not
 *  have to go looking for ids it cannot see. Maintainer 2026-08-14: "the handoff lists out all of the
 *  background shells and sub-agents with their identifiers so that it's really easy for the agent to
 *  produce an awaiting fence that lists out the IDs properly."
 *
 *  It goes at the END and stays short. A long preamble is what made an agent omit half its handoff once
 *  already, and this section is a lookup table, not an instruction. */
export interface SignoffLiveOps {
  /** Running background shells, named by the handle the RUNTIME gave the worker — the string it was
   *  actually shown ("Command running in background with ID: bzvtnt3ig"), not the launch tool_use id.
   *  These are what a `shell:` line names. */
  shells: { id?: string; label: string }[]
  /** Running sub-agents, named the same way. A fence may park on one, though it does not need to: a
   *  finished sub-agent re-invokes its parent by itself. */
  subAgents: { id?: string; label: string }[]
  /** Armed one-off timers, by row id (`tmr_…`) — what a `timer:` line names. */
  timers?: { id?: string; label: string }[]
  /** Registered pull requests, by ref (`owner/repo#N`) — what a `pr:` line names. */
  prs?: { id?: string; label: string }[]
}

// THE NUDGE PRINTS THE IDS, and that is not a convenience — it is what makes the fence writable at all.
// The awaiting grammar references live things BY ID, so a worker that has lost them (a compaction, a long
// turn) cannot write a correct fence and will be bumped for naming something wrong. Giving it the exact
// lines here closes that loop at the one moment it is provably needed: it just rested without a fence.
// `mcp__frizz__activity` returns the same list on demand, from the same source.
export function signoffNudgeMessage(ops?: SignoffLiveOps): string {
  const lines: string[] = []
  const section = (heading: string, kind: string, items: { id?: string; label: string }[]) => {
    if (!items.length) return
    lines.push("", heading)
    for (const i of items) lines.push(`- \`${kind}: ${i.id ?? "?"}\`  — ${i.label}`)
  }
  section("Background shells still running:", "shell", ops?.shells ?? [])
  section("Sub-agents still running (they re-invoke you on their own, so parking on one is optional):", "agent", ops?.subAgents ?? [])
  section("Timers you have armed:", "timer", ops?.timers ?? [])
  section("Pull requests you registered:", "pr", ops?.prs ?? [])
  if (lines.length) {
    lines.push("", "An ```awaiting fence takes one such line per thing you are ACTUALLY waiting on, plus a")
    lines.push("required `for:` duration (`30s`/`15m`/`2h`/`3d`) and a one-line `reason:`. Frizz checks every")
    lines.push("id: name something that is not running and you are bumped rather than parked.")
  }
  return lines.length === 0 ? SIGNOFF_NUDGE_MESSAGE : `${SIGNOFF_NUDGE_MESSAGE}\n${lines.join("\n")}`
}

export const SIGNOFF_NUDGE_MESSAGE = [
  `${SIGNOFF_NUDGE_MARKER} Nothing about your task has changed, and no new work is being asked of you.`,
  "",
  "You rested without a fence, so this thread cannot be triaged.",
  "",
  "**IF THE TASK STILL HAS PARTS LEFT, THE FENCE IS NOT WHAT YOU OWE — THE WORK IS.** Pick that back up",
  "in THIS turn and sign off once it is genuinely finished. A milestone, a green test run and a long turn",
  "are not endings, and neither is naming the next step or writing it into a scratch file.",
  "",
  "Otherwise, add a fence at the END of your next message:",
  "",
  "- `` ```question `` — you need the human. One question per fence, lettered options, one recommended.",
  "- `` ```done `` — genuinely FINISHED. A DISMISSAL: the card is filed away and nobody looks again, so",
  "  if anything is still owed, it is not done. Body: 1-3 sentences, then bullets, each opening with a",
  "  **bolded verb phrase**.",
  "- `` ```awaiting `` — you are WAITING on background work. Your shells and sub-agents are watched",
  "  automatically (frizz wakes you when one finishes, fence or no fence); this is how you come to REST",
  "  meanwhile. Name each thing on its own `watch: <id>` line, using the id or label listed at the end of",
  "  this message. Name only what you are ACTUALLY waiting for, never a dev server you left running — a",
  "  name matching nothing live is not a wait, and the thread queues as usual.",
  "",
  "**DO NOT REPEAT YOURSELF.** If the message you just wrote already stands on its own, reply with the",
  "fence ALONE — the human reads both together, so restating it costs them the second read for nothing.",
  "",
  "Only if it does NOT stand alone, fix that first, briefly. It has to be readable cold: the human has",
  "seen nothing since their own last message — the Goal, this reminder, a watcher wake all came from",
  "frizz — so anything you assumed they had followed, they have not.",
].join("\n")

export function timerPromptMessage(prompt: string, fireAt: string): string {
  return `${prompt.trim()}\n\n(One-off timer, set for ${fireAt}. It has fired and will not repeat.)`
}

/** What is being waited ON: one of the worker's own background shells, or a pull request. */
// NEITHER KIND HAS A REGISTRY ROW BEHIND IT any more (2026-08-14). Both are derived from the worker's
// own ```awaiting fence — `shell` from a `watch:` line, `github` from a `pr-watch:` one — so this strip
// lists exactly what will wake the thread and cannot drift from it.
//
// `github` became a view kind first (2026-08-13). A PR wait lives in the worker's
// ```awaiting fence — that is deliberate and settled (`f366e2d`, "the fence owns PR watching") — but the
// operator still wants to SEE it standing, in the same strip under the prompt box that lists sub-agents
// and background shells: "showing the active watchers underneath the prompt box, similar to how
// subagents work… now GitHub watchers can be included in the ranks of those" (maintainer 2026-08-13).
// So the board SYNTHESIZES one row per parseable `pr-watch:` hint on the thread's standing fence. It is
// derived state, not a registration: it appears when the worker parks, vanishes when it says anything
// else, and carries no drop affordance, because there is no row to drop.
export const ThreadWatchKind = z.enum(["shell", "github"])
export type ThreadWatchKind = z.infer<typeof ThreadWatchKind>

/** How a watched PR's checks stand right now, in the shape GitHub's own merge box states it: a rollup
 *  verdict plus the counts behind it, and whether the PR can actually be merged.
 *
 *  IT DECIDES A QUEUE RULE, not just a readout (maintainer 2026-08-14: "if there is a GitHub watcher
 *  registered and the GitHub actions are still running, then that should remain in the running active
 *  rail. Only if CI has failed or completed successfully should it show up back in the queue"). So it
 *  has to travel — a card that renders check state the board cannot also read would put the two out of
 *  step, which is the drift that produced two cards saying different things about the same wait. */
export const GithubChecksState = z.enum(["none", "running", "passing", "failing"])
export type GithubChecksState = z.infer<typeof GithubChecksState>

/** Can GitHub merge it? `blocked` covers a required review or a failing required check — GitHub reports
 *  the two the same way, and neither is something frizz should claim to distinguish. */
export const GithubMergeState = z.enum(["mergeable", "blocked", "conflicting", "unknown"])
export type GithubMergeState = z.infer<typeof GithubMergeState>

export const GithubWatchStatus = z.object({
  checks: GithubChecksState,
  /** The counts behind the verdict, so the card can say "3 running, 12 passed" the way GitHub does
   *  rather than only "checks are running". */
  running: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** The failing job NAMES, capped — what a human actually needs to decide whether to look. */
  failing: z.array(z.string()).max(8).default([]),
  merge: GithubMergeState,
  /** OPEN | CLOSED | MERGED, lowercased. A merged or closed PR ends the wait outright. */
  state: z.enum(["open", "closed", "merged"]),
  /** When frizz last heard from GitHub. A poll can fail or be rate-limited, and a stale reading stated
   *  as current is worse than no reading. */
  polledAt: z.string(),
}).strict()
export type GithubWatchStatus = z.infer<typeof GithubWatchStatus>

/** One wait the thread has out, as the board states it.
 *
 *  A `github` row is DERIVED FROM THE FENCE — a `pr-watch:` line — and has no registration behind it. A
 *  `shell` row is derived the same way, from a `watch:` line. Neither is a record: both live exactly as
 *  long as the fence that declares them, which is also exactly as long as the scheduler watches them.
 *  That coupling is the point — the strip lists what will actually wake the thread, and the two cannot
 *  drift into claiming different things. */
export const ThreadWatchView = z.object({
  id: z.string(),
  kind: ThreadWatchKind,
  target: z.string(),
  state: z.enum(["armed", "fired", "dropped"]),
  createdAt: z.string(),
  /** `github` rows only, and absent until the first successful poll. */
  github: GithubWatchStatus.optional(),
}).strict()
export type ThreadWatchView = z.infer<typeof ThreadWatchView>

/** The ceiling on registered PR watchers per thread. A tool call in a loop cannot fill the table, and
 *  the refusal names the number so a worker drops one rather than retrying. */
/** What an old worker's `watch_pr` gets when its MCP binary predates `for` and cannot send one.
 *  Bounded deliberately: long enough for an ordinary review round, short enough that a watcher nobody
 *  renews stops polling on its own. */
export const PR_WATCH_DEFAULT_FOR_MS = 6 * 60 * 60 * 1000

export const PR_WATCH_MAX_ARMED = 32

/** One registered PR watcher, as the worker's own tool reads it back. */
export const PrWatchView = z.object({
  id: z.string(),
  /** `owner/repo#N`, normalized — the same string the board's row and the status book are keyed by. */
  target: z.string(),
  state: z.enum(["armed", "dropped", "settled"]),
  createdAt: z.string(),
  /** The PR's checks/mergeability as the poller last saw it. Absent until the first successful poll. */
  github: GithubWatchStatus.optional(),
}).strict()
export type PrWatchView = z.infer<typeof PrWatchView>

export const AddOwnPrWatchInput = z.object({
  slug: ThreadSlug,
  /** `owner/repo#123` or a PR URL. Parsed server-side; an unparseable ref is refused rather than stored,
   *  because a watcher that can never fire is worse than none — the worker rests believing it is covered. */
  target: z.string().trim().min(1).max(200),
  /** How long to watch, as a DURATION (`30m`, `2h`, `3d` — parseAwaitingDuration).
   *
   *  A PR nobody ever reviews would otherwise be polled forever, and a thread parked on it would wait
   *  forever with it — the same unbounded wait the awaiting fence's `for:` closes, one level down. A
   *  duration rather than an instant for the same reason it is one there: it cannot be written in the
   *  past (maintainer 2026-08-15, asking for it explicitly).
   *
   *  REQUIRED BY THE TOOL, OPTIONAL ON THE WIRE, and the asymmetry is deliberate. A worker's MCP server
   *  outlives every frizz restart, so a session dispatched before this existed still holds a binary that
   *  cannot send it — and making the RPC reject that would break `watch_pr` outright for every thread
   *  already running, with no recourse from inside those threads. Absent ⇒ PR_WATCH_DEFAULT_FOR, which
   *  still BOUNDS the poll; the point of the field is that a worker chooses, and one that cannot choose
   *  is better bounded than broken. */
  for: z.string().trim().min(1).max(16).optional(),
}).strict()
export type AddOwnPrWatchInput = z.infer<typeof AddOwnPrWatchInput>

export const AddOwnPrWatchResult = z.object({
  id: z.string(),
  target: z.string(),
  /** True when this exact PR was ALREADY watched by this thread, so the call registered nothing new.
   *  Re-registering after a compaction is the common case, and a duplicate would double every wake. */
  alreadyArmed: z.boolean(),
  watches: z.array(PrWatchView),
}).strict()
export type AddOwnPrWatchResult = z.infer<typeof AddOwnPrWatchResult>

export const DropOwnPrWatchInput = z.object({
  slug: ThreadSlug,
  id: z.string().min(1).max(64),
}).strict()
export type DropOwnPrWatchInput = z.infer<typeof DropOwnPrWatchInput>

export const DropOwnPrWatchResult = z.object({
  dropped: z.boolean(),
  watches: z.array(PrWatchView),
}).strict()
export type DropOwnPrWatchResult = z.infer<typeof DropOwnPrWatchResult>

export const ListOwnPrWatchesInput = z.object({ slug: ThreadSlug }).strict()
export type ListOwnPrWatchesInput = z.infer<typeof ListOwnPrWatchesInput>

export const OwnPrWatchesResult = z.object({ watches: z.array(PrWatchView) }).strict()
export type OwnPrWatchesResult = z.infer<typeof OwnPrWatchesResult>

/** One armed (or just-settled) timer, as the worker's own tool reads it back. */
export const ThreadTimerView = z.object({
  id: z.string(),
  prompt: z.string(),
  /** The exact UTC instant it fires — the same string the delivered trailer names. */
  fireAt: z.string(),
  state: z.enum(["armed", "fired", "cancelled"]),
  createdAt: z.string(),
}).strict()
export type ThreadTimerView = z.infer<typeof ThreadTimerView>

// The signal fence on a thread's FINAL assistant message — the fence language IS the state, the
// body is the message. `done` = checked success card in the queue until the human Archives it (the
// fence itself MUTATES NOTHING — maintainer-settled); `awaiting` = a parked human/timer wait.
// Only excuses WHILE it is the final message — any newer activity clears it. ```question fences
// keep their own machinery (pendingQuestion / questionBlocks) and are NOT an excusal.
export const ThreadFence = z.object({
  kind: z.enum(["done", "awaiting"]),
  body: z.string(), // fence body minus hint lines, capped server-side; may be ""
  hints: z.array(AwaitingHint).default([]),
})
export type ThreadFence = z.infer<typeof ThreadFence>

// A plan artifact: .frizz/plans/*.md — no schema, no validation; prompted into existence. A plan
// with no live thread is backlog; a plan's threads are its history (associated via plan_path).
export const PlanView = z.object({
  path: z.string(), // project-relative, e.g. ".frizz/plans/standalone-ui.md"
  title: z.string(), // first markdown heading, else the filename stem
  updatedAt: z.string().optional(), // ISO8601 file mtime
  threadIds: z.array(ThreadSlug).default([]), // threads dispatched from this plan
})
export type PlanView = z.infer<typeof PlanView>

// ---- Subscription usage-limit pause (auto-resume) ------------------------------------------------
// Which metered subscription window the provider says is exhausted. "session" is the 5-hour rolling
// window (Claude's "You've hit your session limit"); "weekly" is the 7-day window; "unknown" is a
// limit stop whose phrasing we could not attribute — never auto-resumed on a text-derived clock.
export const LimitWindow = z.enum(["session", "weekly", "unknown"])
export type LimitWindow = z.infer<typeof LimitWindow>

// A thread whose turn was cut off mid-work by an exhausted subscription window, plus what frizz will
// do about it. `resumesAt` is a unix-seconds instant resolved from the provider's own reset clock (or
// its usage endpoint) — absent when neither source could supply one, in which case `autoResume` is
// false and the thread stays a normal human handoff.
export const LimitPause = z.object({
  backend: Backend,
  window: LimitWindow,
  at: z.string(), // ISO8601 of the limit record — "when the agent got cut off"
  resumesAt: z.number().optional(), // unix seconds the window rolls
  // Whether frizz intends to deliver its own "continue" once `resumesAt` passes. False when the
  // setting is off, the instant is unresolvable, or the pause is too old to safely resume.
  autoResume: z.boolean(),
})
export type LimitPause = z.infer<typeof LimitPause>

// One sidebar row: frizz board thread + runtime overlay.
export const ThreadView = z.object({
  id: ThreadSlug, // slug; filename is <slug>.md
  title: z.string(),
  status: FrizzStatus,
  statusText: z.string().optional(),
  // Form-constrained gerund label (≤100 chars, e.g. "Awaiting CI on PR #391") the worker maintains;
  // the listing row's at-a-glance gloss. Optional → absent on old threads renders nothing. Distinct
  // from statusText, which keeps its own surfaces (queue cards / board gloss).
  activity: z.string().optional(),
  next: z.string().optional(),
  // DERIVED (board shell-out, from the body): the thread keeps a `## Plan` section, i.e. it carries a
  // plan document → the sidebar renders a quiet PLAN badge. NOT a status and NOT a frontmatter flag
  // (that was deliberately rejected); orthogonal to the Plans section, which keys on status. Defaults
  // false so an old snapshot / pre-restart server (which omits it) parses.
  hasPlan: z.boolean().default(false),
  mechanism: BlockMechanism.nullable(), // set only when status=blocked
  humanBlocked: z.boolean(),
  ready: z.boolean(), // deps cleared, auto-fire candidate
  dependsOn: z.array(ThreadSlug),
  externalDeps: z.array(z.string()),
  owner: z.string().optional(),
  revalidate: z.string().optional(), // ISO8601
  agents: z.array(ThreadAgent),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  // runtime overlay (from the UI server, not the .frizz file)
  runtime: RuntimeState,
  sessionId: z.string().optional(),
  tmuxName: z.string().optional(),
  unread: z.boolean(),
  archived: z.boolean(), // user hid the row from the nav; respawn/resume un-archives
  lastAssistant: z.string().optional(), // trimmed preview of last assistant text
  spawnedAt: z.string().optional(), // ISO8601
  lastActivityAt: z.string().optional(), // ISO8601, from jsonl tail — ANY record (incl. sub-agent/system)
  // ISO8601 of the agent's OWN last output (Claude: last assistant record; Codex: turn-end/final text).
  // This is the "rest time" — when the thread's own turn last came to rest — and UNLIKE lastActivityAt
  // it is NOT bumped by a background sub-agent's completion notification (a promptSource:system record).
  // The queue/rested-band order key and the at-rest "Last active" label both key off this. Optional so
  // old snapshots parse; the client falls back to lastActivityAt/spawnedAt when absent.
  lastAssistantAt: z.string().optional(),
  aiTitle: z.string().optional(), // Claude's own auto-generated session title (latest ai-title record)
  // True when `title` is a machine-guessed dispatch slug (title_auto=1), NOT a real name — the display
  // then shows a "Spinning up a thread…" placeholder instead of the guess until aiTitle lands. Optional
  // (absent ⇒ legacy/slim row) so old snapshots parse; absent is treated as "not provisional".
  titleAuto: z.boolean().optional(),
  // True when a HUMAN named this thread (rename / native /rename / an adopted file heading) and no
  // backend auto-title may replace it. FALSE is the interesting case: a title hard-coded by a dispatch
  // CALLER — `Investigate acme/app#391`, a parent agent's guess through spawn_thread — reads as a real
  // name (titleAuto false) yet still yields to the worker's own aiTitle, which is usually the more
  // informative one. Optional (absent ⇒ legacy/slim row): the display then derives it the pre-split way,
  // treating any non-guessed title as the human's. The server enforces this too by withholding aiTitle
  // from a locked row; the client keeps its own copy so a stale record can never win on either side.
  titleLocked: z.boolean().optional(),
  // Live background sub-agents the worker dispatched (tailer-derived). Defaults to [] so an old
  // snapshot/row (or a pre-restart server that doesn't emit the field yet) parses without breaking.
  subAgents: z.array(SubAgentView).default([]),
  // Live background SHELLS the worker launched (tailer-derived). Same default-[] discipline. Rendered
  // in the anchored background-ops strip alongside sub-agents; ids make current rows drillable.
  bgShells: z.array(BgShellView).default([]),
  // The thread's ARMED WATCHERS — registry-derived, not folded from the transcript, which is what makes
  // them survive the worker saying one more sentence. Same default-[] discipline as the two above.
  //
  // These NEVER park the thread: a row with an armed watcher stays a visible queue handoff, and Snooze
  // remains the only way to hide one (maintainer 2026-08-12, choosing this over auto-Held for every
  // kind). So this field is for the operator to SEE what a thread is waiting on — it deliberately feeds
  // no queue-membership rule.
  watches: z.array(ThreadWatchView).default([]),
  // A pending native AskUserQuestion the session is frozen on (tailer-derived). Optional — absent
  // when there's no unanswered ask. Feeds needsAction + the read-only question render + "Answer in Terminal".
  pendingAsk: PendingAsk.optional(),
  // A verified backend-native terminal modal (Codex tool approval / permission / confirmation /
  // selection) that is blocking transcript progress. The title is fixed/sanitized server-side and
  // options/tool payloads are never exposed. Registered sessions only; foreign rows remain read-only.
  nativeInputRequired: NativeInputRequired.optional(),
  // Derived safety net (tailer): at rest with an unanswered ```question the worker asked in chat but
  // never encoded as blocked. Defaults false so old snapshots/rows parse. Feeds needsAction.
  pendingQuestion: z.boolean().default(false),
  // ISO8601 of the newest REAL user interaction (answer/steer/dispatch) — the chronological listing
  // sort key. Optional; the listing falls back to spawnedAt when absent (a dispatch IS an interaction).
  lastUserAt: z.string().optional(),
  // Runtime provider-auth rejection (claude-auth plan): the session's provider positively rejected
  // its credential (Claude: synthetic isApiErrorMessage 401 record, or the 401/login text on a
  // boot-failed pane). Bounded by design — only the typed category travels, never raw provider/pane
  // text. Drives the trusted sign-in recovery card. Optional so old snapshots/servers parse.
  providerFault: z.object({
    backend: z.enum(["claude", "codex"]),
    category: z.enum(["authentication_required", "authentication_rejected"]),
  }).optional(),
  // The session's turn was cut off by an exhausted SUBSCRIPTION window. Distinct from providerFault:
  // the credential is fine, the account is simply out of quota until the window rolls, so the recovery
  // is to WAIT and continue — not to sign in. Same discipline as providerFault: only typed data
  // travels, never the provider's own error text. Optional so old snapshots/servers parse.
  limitPause: LimitPause.optional(),

  // ---- Session-first fields (ALL optional: absent ⇒ a legacy .frizz-file row / pre-restart server;
  // the client treats such rows as Legacy-shelf material). Deliberately not zod-defaulted so server
  // constructors that predate the model still typecheck and old snapshots parse unchanged. ----
  // "session" = a session-backed thread (the working rail's unit); "legacy" (or absent) = a .frizz
  // file row, rendered read-only in the collapsed Legacy shelf.
  kind: z.enum(["session", "legacy"]).optional(),
  // No registry row (a maintainer terminal discovered from the JSONL dir): read-only transcript,
  // no tmux verbs (no composer / kill / resume), never in Needs-you, no archive/seen state.
  foreign: z.boolean().optional(),
  // ui.db lifecycle for session threads (open|archived) — written ONLY by explicit Archive/Reopen.
  state: z.enum(["open", "archived"]).optional(),
  // Exact durable user snooze. While this instant is in the future, an otherwise-resting thread is
  // suppressed from Queue and shown dimmed in Held. Hard interactive gates (question, permission,
  // native approval, crash) deliberately break through it. Expired values are cleared server-side.
  snoozedUntil: SnoozeUntil.optional(),
  // The prompt this snooze will deliver at its deadline, when it carries one. Present ⇒ the wake is an
  // AUTO-bump (the scheduler resumes the agent with exactly this text) rather than a reminder, which is
  // the distinction the held row's tooltip renders. Absent ⇒ the card merely re-surfaces.
  snoozePrompt: z.string().optional(),
  /** The EVENT snooze on the resting card is armed for this exact rest — the human has said "hide this
   *  until something reports". Distinct from `snoozedUntil`, which is a wall-clock park on the whole
   *  thread: this one has no deadline and clears itself when the thread comes to a NEW rest.
   *
   *  It travels because the chat has to honour it too (2026-08-14). Until then only the QUEUE did, on
   *  the reasoning that the card states a FACT the drawer must keep showing or it blanks at rest and
   *  reads as "the agent died". That reasoning holds for a thread nobody has parked; once the human has
   *  explicitly parked THIS rest, showing them the same card with the same button one surface over is
   *  not information, and they said so. */
  bgSnoozed: z.boolean().optional(),
  // Which Claude transport serves this thread: "broker" = a session-broker-owned Agent SDK session
  // (typed control channel), "tmux" = the interactive TUI in a pane. Only the broker can be asked to
  // reload its plugin closure in place, so the board needs it to decide whether to offer that verb at
  // all rather than render a button that throws.
  claudeRuntime: z.enum(["tmux", "broker"]).optional(),
  // The thread's recurring prompt, when one has been written. Present with BOTH triggers false ⇒ the
  // text and the cadence are kept but nothing fires — that pair of falses IS the off state, which is
  // why there is no separate enable flag here to disagree with them.
  recurringPrompt: ThreadRecurringPrompt.optional(),
  // The signal fence on the final assistant message, present only while the thread is excused by it.
  lastFence: ThreadFence.optional(),
  // SERVER-DERIVED queue membership: explicit questions, checked/done handoffs, plus the process-level
  // blocks (perm-prompt / pendingAsk / crash) that a view can't clear. The client renders the
  // queue off this bit alone for session threads (legacy rows keep needsAction()).
  needsYou: z.boolean().optional(),
  // True only for the crash/stall branch (pane exited while the transcript still says in-flight).
  // Once every ordinary rest also queues, runtime=exited + needsYou is no longer enough for clients
  // to distinguish a failed worker from a clean completed process.
  crashed: z.boolean().optional(),
  // The queued reason is "resting while its OWN background work (sub-agents / shells) is still live,
  // with no human ask": the agent came to rest awaiting results it dispatched, not awaiting the human.
  // The card renders the informational awaiting-background banner + an event-Snooze that hides it until
  // the work returns (the parent re-rests). True only when this is the SOLE queue reason (no question /
  // ask / native input / done fence outranks it) and no event-snooze is armed for the current rest.
  // Optional like needsYou/crashed: absent ⇒ a pre-restart server or a non-session row; the client
  // treats absence as false.
  awaitingBackground: z.boolean().optional(),
  // Exact typed-interaction presence for this CURRENT registered session. The board already derives
  // this from the scoped durable journal to compute needsYou; exposing the reason lets React avoid a
  // pendingInteractions RPC for every unrelated question/completion card. Optional preserves rolling
  // compatibility: a client paired with an older server treats absence as "unknown" and keeps the
  // previous query behavior, while a current server always emits true/false for owned session rows.
  pendingInteraction: z.boolean().optional(),
  // True only while a durable typed interaction still needs a USER decision. This is deliberately
  // distinct from pendingInteraction: after the human answers, provider delivery can remain queued or
  // sent (and therefore pending/readable) without remaining a hard gate that disables Snooze.
  // Optional keeps rolling client/server reloads compatible; current servers always emit the bit.
  actionableInteraction: z.boolean().optional(),
  // ISO8601 read/seen telemetry (threadSeen RPC — recorded when the human opens the thread). Kept for
  // compatibility and analytics only; viewing never acknowledges or removes a queue handoff.
  seenAt: z.string().optional(),
  // Project-relative plan artifact this thread was dispatched from (.frizz/plans/*.md), if any.
  planPath: z.string().optional(),
  // Which agent backend runs this thread (Codex-support epic, Phase 3) — drives the subtle per-row
  // rail badge. Optional so a legacy/foreign/pre-restart row parses; absent OR "claude" ⇒ no badge
  // (Claude is the unmarked default), "codex" ⇒ the small Codex badge.
  backend: Backend.optional(),
  // The backend-native permission/sandbox profile this session was launched (or explicitly
  // re-attached) with. Persisted per thread: never inferred from mutable Settings. Optional for
  // migrated/foreign sessions whose actual process mode is unknown.
  permissionMode: z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  // A durable requested mode that has not yet appeared in backend telemetry. The UI renders this as
  // pending beside permissionMode; it never replaces the observed value optimistically.
  permissionPending: z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  // Raw durable barrier bit. Unlike permissionPending this remains true for a future/corrupt value,
  // so rolling clients fail closed instead of enabling another composer while ownership is unknown.
  permissionChangePending: z.boolean().optional(),
  // The last DENIAL the worker's permission POLICY made for this thread (cc-worker/hooks/
  // perm-policy.mjs), and how many times it has denied. A refusal changes what the worker can do, so
  // it earns a card. Approvals and deferrals are deliberately absent: a deferral already shows as a
  // permission prompt / Needs you, and an approval blocks nobody — the quiet line that used to report
  // one stuck to the bottom of the thread forever, describing a command the reader had long moved past.
  permPolicy: z.object({
    decision: z.literal("deny"),
    rule: z.string(),
    reason: z.string(),
    tool: z.string().nullable(),
    at: z.string(),
    command: z.string().optional(),
  }).optional(),
  permDenies: z.number().optional(),
  // Atomic model+effort handoff state. The displayed model/effort remain the last committed launch
  // target until both pending values are attached and readiness-proven for a new generation.
  profilePendingModel: z.string().optional(),
  profilePendingEffort: z.string().optional(),
  profileChangePending: z.boolean().optional(),
  // One durable runtime-control owner serializes reattach/resume/native-composer mutations. Unknown
  // future owner values still disable the composer rather than being treated as idle.
  runtimeControlPending: z.boolean().optional(),
  // controlError is an actionable reason the controller failed closed (for example a busy thread).
  controlError: z.string().optional(),
  // The session's concrete model + reasoning effort: pinned launch metadata for new dispatches,
  // refined/backfilled from backend transcript telemetry where available (Claude records model;
  // Codex records both). Never derived from current Settings. Strings keep future backend-native
  // values forward-compatible; absent when neither durable source knows → the UI renders no guess.
  model: z.string().optional(),
  effort: z.string().optional(),
  // How full the session's context window is right now — the footer's fullness readout. BOTH halves
  // are provider-measured and the field is emitted ONLY when both are present, so a client never has
  // to decide what to do with half a fraction: absent ⇒ no reading, never a 0% dial. Codex reports
  // both on every `token_count`; a Claude row gets `tokens` from each assistant record's usage but
  // `window` only once its first broker turn has ended (and never at all for a tmux/foreign row).
  // `tokens` legitimately DROPS after a compaction — the context really did get smaller.
  context: z.object({ tokens: z.number(), window: z.number() }).optional(),
})
export type ThreadView = z.infer<typeof ThreadView>

// STRUCTURED board error — a machine-readable companion to the legacy `errors: string[]` so the
// client can tell a REPAIRABLE error from an inert one and which file it names. `no-frontmatter` is
// the one-click-repairable case (a thread .md written with no YAML frontmatter, invisible to the
// queue/status system until healed); everything else is `other` (a dangling dep, a bad status, a
// board-read failure) and renders as today with no repair affordance. Additive: the legacy string
// array is untouched, this is a PARALLEL field. `file` is the .md basename (or "" for a board-level
// failure with no single file).
export const BoardErrorItem = z.object({
  file: z.string(),
  kind: z.enum(["no-frontmatter", "other"]),
  message: z.string(),
})
export type BoardErrorItem = z.infer<typeof BoardErrorItem>

export const BoardSnapshot = z.object({
  projectDir: z.string(),
  projectName: z.string(),
  projectLabel: z.string(), // "owner/repo" from the git origin remote; falls back to projectName
  // "owner/repo" ONLY when that origin remote is github.com — the link target the rendered-markdown
  // autolinker turns `#123` and a bare commit hash into. Deliberately NOT projectLabel, which is a
  // host-agnostic DISPLAY name: a GitLab origin yields an owner/repo there too, and pointing its `#12`
  // at github.com would be a wrong destination rather than a missing one. Absent means the
  // augmentation stays off (no remote, another forge, or a pre-restart server).
  githubRepo: z.string().optional(),
  // This project's URL slug — the `<slug>` in `/project/<slug>`. The client cannot derive it: a
  // PREFIXED page reads it off its own path, but the LAUNCHING project is served unprefixed and so has
  // nothing to read, which left `/` — the all-projects GRID — as the only URL its queue could name.
  // Optional so a pre-restart server keeps working; absent means "fall back to `/`", i.e. the old
  // behaviour. Registry-derived, so it is the same slug every other surface links to.
  projectSlug: z.string().optional(),
  // The server's home directory — the expansion of a `~` a worker wrote in prose. Agents reference
  // files that way constantly (`~/.claude/CLAUDE.md`), and the browser has no way to derive it, so a
  // `~`-anchored Markdown link had no absolute path to become and stayed a same-origin anchor that
  // navigated out of Frizz. The client only ever uses it to build a path it then hands BACK to the
  // server, which realpath-gates it exactly as it gates one the author typed in full. Optional so a
  // pre-restart server keeps working; absent means `~` links stay unresolved, i.e. the old behaviour.
  homeDir: z.string().optional(),
  // (No `.frizz/ exists` bit here on purpose. Threads are session-first — the ui.db registry IS the
  // board — so `.frizz/` presence says nothing about whether this project has one. Its only consumer
  // was a shell gate that dead-ended `.frizz`-less repos; the server still probes the directory
  // locally where it genuinely matters, for plan/scratchpad storage.)
  threads: z.array(ThreadView),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  // Structured mirror of `errors` (see BoardErrorItem). Optional so a pre-restart server / old
  // snapshot that omits it still parses; the client treats absent as "no structured errors" and
  // falls back to rendering the plain `errors` strings.
  errorItems: z.array(BoardErrorItem).optional(),
  // Plan artifacts (.frizz/plans/*.md) — the Plans rail section. Optional for the same pre-restart
  // back-compat reason (absent ⇒ old server ⇒ no Plans section data).
  plans: z.array(PlanView).optional(),
})
export type BoardSnapshot = z.infer<typeof BoardSnapshot>

// ---- Provider quota (subscription rate-limit windows) ----
// A single usage window for a provider's plan — the 5-hour rolling window or the weekly window that
// Claude/Codex subscriptions meter against. `usedPercent` is 0..100 (how much of the window is spent,
// so remaining = 100 - usedPercent); `resetsAt` is a unix-seconds instant the window rolls over.
export const QuotaWindow = z.object({
  key: z.string(), // stable id: "5h" | "weekly" (provider-neutral)
  label: z.string(), // short human label for the chip ("5h", "Weekly")
  usedPercent: z.number(), // 0..100
  resetsAt: z.number().optional(), // unix seconds; absent when the source doesn't report it
})
export type QuotaWindow = z.infer<typeof QuotaWindow>

// One provider's quota. `status: "ok"` carries live windows; "unavailable" means we could not read it
// (no recent session, endpoint unreachable, not logged in) and the UI shows a neutral dash + `detail`.
export const ProviderQuota = z.object({
  status: z.enum(["ok", "unavailable"]),
  planType: z.string().optional(), // "pro" / "max" / etc. when the source reports it
  windows: z.array(QuotaWindow),
  detail: z.string().optional(), // why unavailable, or an extra note
})
export type ProviderQuota = z.infer<typeof ProviderQuota>

// The polled quota snapshot the sidebar status bar renders — one entry per agent backend.
export const QuotaSnapshot = z.object({
  claude: ProviderQuota,
  codex: ProviderQuota,
})
export type QuotaSnapshot = z.infer<typeof QuotaSnapshot>

// ---- Provider auth (local credential presence) ----
// Whether a provider's LOCAL credential exists — the signal the new-thread dispatch gate keys on.
// DISTINCT from quota's "unavailable": that is overloaded with transient endpoint failures, whereas
// this reports credential presence only. "signed-out" = we positively found no credential; "unknown" =
// we couldn't determine it (read error). The gate BLOCKS on "signed-out" and FAILS OPEN on "unknown".
export const ProviderAuth = z.enum(["authed", "signed-out", "unknown"])
export type ProviderAuth = z.infer<typeof ProviderAuth>

// WHICH account each credential belongs to — the email the provider's own on-disk account record
// carries. Purely informational (the quota popover answers "signed in as who?"); nothing gates on it,
// so every field is optional and an unreadable record simply yields nothing rather than an error.
// Deliberately a SIBLING of the per-provider auth verdicts rather than nested with them: the gate's
// shape (`snapshot[backend] === "signed-out"`) is load-bearing in dispatch and must not move.
export const AccountEmails = z.object({
  claude: z.string().max(320).optional(),
  codex: z.string().max(320).optional(),
})
export type AccountEmails = z.infer<typeof AccountEmails>

// The per-provider auth snapshot the new-thread gate reads — one entry per agent backend.
export const AuthSnapshot = z.object({
  claude: ProviderAuth,
  codex: ProviderAuth,
  emails: AccountEmails,
})
export const AccountLogoutInput = z.object({ backend: z.enum(["claude", "codex"]) }).strict()
export type AccountLogoutInput = z.infer<typeof AccountLogoutInput>
// Result of the typed provider logout action. "blocked" = refused because the provider had live
// turns (account state is process-global; changing it mid-request produces ambiguous failures);
// "failed" = the CLI errored AND the credential still reads present. `auth` is the post-attempt
// credential state so the client can refresh its snapshot without another round-trip.
export const AccountLogoutResult = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  auth: ProviderAuth,
  activeThreads: z.number().int().positive().optional(),
  detail: z.string().max(200).optional(),
})
export type AccountLogoutResult = z.infer<typeof AccountLogoutResult>
// Slice B login utility: start/inspect/cancel the restricted `claude auth login` terminal. The
// attempt id is slug-shaped so it can ride the hardened /term/<slug> transport; it is server-issued
// and opaque — the client never constructs one.
export const AccountLoginStartInput = z.object({ backend: z.enum(["claude", "codex"]) }).strict()
export type AccountLoginStartInput = z.infer<typeof AccountLoginStartInput>
export const AccountLoginStartResult = z.object({ attemptId: ThreadSlug })
export type AccountLoginStartResult = z.infer<typeof AccountLoginStartResult>
export const AccountLoginStatusInput = z.object({ attemptId: ThreadSlug }).strict()
export type AccountLoginStatusInput = z.infer<typeof AccountLoginStatusInput>
// `auth` is the live credential re-read; the client treats state:"exited" + auth:"authed" as a
// completed sign-in. The NEXT real provider request remains the validity proof (an expired token
// also reads "authed" here — the runtime 401 classifier covers that).
export const AccountLoginStatusResult = z.object({
  state: z.enum(["running", "exited", "unknown"]),
  auth: ProviderAuth,
})
export type AccountLoginStatusResult = z.infer<typeof AccountLoginStatusResult>
export type AuthSnapshot = z.infer<typeof AuthSnapshot>

// ---- Settings ----

export const PermissionMode = z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"])
export type PermissionMode = z.infer<typeof PermissionMode>

// Where a vetted local artifact link opens. This is intentionally a server-owned setting: the
// browser never gets permission to navigate to file:// or choose an arbitrary executable.
export const LocalFileOpener = z.enum(["system", "cursor", "vscode", "finder", "copy"])
export type LocalFileOpener = z.infer<typeof LocalFileOpener>

export const Settings = z.object({
  // The mode NEW Claude workers launch in. Settings surfaces exactly two of them — `auto` (the shipped
  // default) and `bypassPermissions` (--dangerously-skip-permissions) — because those are the only two
  // an unattended worker can actually run in; the server's workerDispatchPermission enforces that same
  // floor, so a restrictive value left here by an older build cannot reach a spawn.
  permissionMode: PermissionMode,
  model: z.string().optional(), // the agent's --model value; undefined = CLI default
  // The agent backend the selected model runs on (Codex-support epic, Phase 3). Persisted ALONGSIDE
  // `model` — a Claude model pins "claude", a GPT/Codex model pins "codex" — so the dependent controls
  // (permission-mode vs sandbox, the effort set) know which axis to present. Optional so an old blob
  // parses; absent ⇒ "claude" (derivable from `model` too, via backendForModel in web/lib/options).
  backend: Backend.optional(),
  // Reasoning effort. The ladder spans BOTH backends' universes: Claude's (low..max, plus "ultracode")
  // and codex's (adds "ultra" — a 5.6-sol/terra level above max). Which subset is OFFERED is
  // backend/model-gated in the UI (a codex model exposes exactly its cache `efforts`; "ultracode" is
  // offered only on an xhigh-capable Claude model), and the server passes the chosen value through per
  // backend — so the wire enum is simply the union.
  //
  // "ultracode" is a Claude rung with no `--effort` equivalent: Claude Code's effort flag stops at max,
  // and ultracode is a separate session-scoped setting meaning "xhigh + standing dynamic-workflow
  // orchestration". It travels the wire as an effort because that is how Claude Code's own `/effort`
  // presents it; resolveClaudeEffort (server/backend/claude-effort.ts) translates it at the spawn edge.
  effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]).optional(),
  notifications: z.boolean(),
  /**
   * The permanent column of project icons. OFF by default, on purpose.
   *
   * A rail of every project on the machine is a standing invitation to leave the thread you are in —
   * "just too tempting" (maintainer 2026-08-06). Frizz's home is one board; the grid is a page you go
   * to, not furniture you sit beside. Hidden, the way back is a breadcrumb in the status bar, which
   * costs a click exactly when you meant to switch and nothing when you did not.
   *
   * Machine-level, like the font: which chrome you want is a property of the person, not the repo.
   */
  projectRail: z.boolean(),
  // UI type family. `mono` (default) is the mono-forward system; `sans` swaps prose/UI chrome to a
  // sans stack while code / tool lines / the terminal stay mono. Optional so an old settings blob
  // parses; defaultSettings pins "mono".
  font: z.enum(["mono", "sans"]).optional(),
  // Default action for a vetted non-image local path in agent markdown. Image clicks always use the
  // OS default viewer so screenshots retain their expected behavior.
  localFileOpener: LocalFileOpener.optional(),
  // The GitHub batch-dispatch prompt template (the picker's per-item worker prompt). Optional: when
  // unset OR blank the server falls back to its exported DEFAULT_GITHUB_PROMPT. Substitution tokens
  // the server fills: {repo} {n} {title} {url} {labels} {body}. The leading `THREAD: <slug>` tag is
  // prepended by the server (not part of the editable template) so a custom prompt can never break the
  // thread↔.frizz-file binding. Optional so old settings blobs parse.
  //
  // ONE field, not one per kind. Issue and PR each had their own template until 2026-08-15, and the two
  // said the same thing twice: read the whole thread, be skeptical, cite what you checked, post nothing.
  // A person tuning "be more dubious" had to make the same edit in two boxes and keep them in step. The
  // ONE thing that genuinely differs per kind — which `gh` command reads the item — is a line in the
  // metadata block, so the merged template just carries both, and the worker picks the one that applies.
  //
  // There is no migration off the two old keys, and that is deliberate (the maintainer's call): Settings
  // is a non-strict z.object, so `githubIssuePrompt`/`githubPrPrompt` are STRIPPED the moment an old
  // blob is parsed. Any existing override is dropped and the reader gets the new shipped default —
  // exactly the intended backfill. Merging two customized templates into one has no correct answer.
  githubPrompt: z.string().optional(),
})
export type Settings = z.infer<typeof Settings>

// The new-thread composer's durable, workspace-scoped choices. Keep one profile per runtime so
// moving between Claude and Codex never overwrites the other runtime's model, effort, or permission
// selection. Fields stay optional for the first-run/default case: a displayed fallback is not stored
// as user intent until the human actually chooses it.
export const DispatchProviderPreferences = z.object({
  model: z.string().trim().min(1).max(200).optional(),
  effort: Settings.shape.effort,
  permissionMode: PermissionMode.optional(),
})
export type DispatchProviderPreferences = z.infer<typeof DispatchProviderPreferences>

export const DispatchPreferences = z.object({
  backend: Backend,
  claude: DispatchProviderPreferences,
  codex: DispatchProviderPreferences,
})
export type DispatchPreferences = z.infer<typeof DispatchPreferences>

// One complete launch profile. GitHub batch dispatch carries this whole tuple — read from the
// durable new-thread preference its own footer selector writes — instead of consulting Settings
// again: backend owns the model, and effort is part of the same atomic profile cell.
export const DispatchProfileSnapshot = z.object({
  backend: Backend,
  model: z.string().trim().min(1).max(200),
  effort: Settings.shape.effort.unwrap(),
  // IGNORED: dispatch permission is decided server-side (workerDispatchPermission) from the
  // non-interactive floor plus the operator's Settings choice, never per dispatch. Optional so old
  // clients that still send it parse.
  permissionMode: PermissionMode.optional(),
}).strict()
export type DispatchProfileSnapshot = z.infer<typeof DispatchProfileSnapshot>

// Atomic updates avoid read/modify/write races between the sidebar form and the anywhere composer.
// A matrix-cell selection is one complete model+effort profile mutation; permission remains an
// independent axis. Every provider-owned update names its runtime so a delayed request can never
// contaminate the other profile.
export const SetDispatchPreferenceInput = z.discriminatedUnion("field", [
  z.object({ field: z.literal("backend"), value: Backend }),
  z.object({
    field: z.literal("profile"),
    backend: Backend,
    model: z.string().trim().min(1).max(200),
    effort: Settings.shape.effort.unwrap(),
  }),
  z.object({ field: z.literal("model"), backend: Backend, value: z.string().trim().min(1).max(200) }),
  z.object({ field: z.literal("effort"), backend: Backend, value: Settings.shape.effort.unwrap() }),
])
export type SetDispatchPreferenceInput = z.infer<typeof SetDispatchPreferenceInput>

// ---- RPC inputs ----

export const DispatchInput = z.object({
  // Optional: when omitted, dispatch derives a fallback title from the prompt (Claude later renames
  // the session via ai-title, which the UI prefers for display). The thread FILE always gets a
  // concrete title regardless — frizz requires one.
  title: z.string().min(1).optional(),
  prompt: z.string().min(1),
  slug: ThreadSlug.optional(), // derived from title if omitted
  // IGNORED: dispatch permission is decided server-side (workerDispatchPermission) from the
  // non-interactive floor plus the operator's Settings choice, never per dispatch. Accepted-but-ignored
  // so old clients still parse.
  permissionMode: PermissionMode.optional(),
  model: z.string().optional(),
  // The agent backend for THIS dispatch (Codex-support epic, Phase 3). Omitted ⇒ the dispatcher
  // defaults to "claude", keeping the legacy RPC path byte-identical. The router forwards it into
  // `dispatch(input, { backend })`; the model picker sets it from the chosen model's family.
  backend: Backend.optional(),
  effort: Settings.shape.effort,
  // Project-relative plan artifact this dispatch works from (.frizz/plans/*.md): stored as the
  // thread's plan_path association and named to the worker in its system-prompt orientation.
  planPath: z.string().optional(),
})
export type DispatchInput = z.infer<typeof DispatchInput>

export const ADOPT_THREAD_MESSAGE_MAX_CHARS = 64 * 1024
export const AdoptThreadInput = z.object({
  slug: ThreadSlug,
  message: z.string().max(ADOPT_THREAD_MESSAGE_MAX_CHARS).optional(),
}).strict()
export type AdoptThreadInput = z.infer<typeof AdoptThreadInput>
export const AdoptThreadResult = z.object({ slug: ThreadSlug, sessionId: z.string().min(1) }).strict()
export type AdoptThreadResult = z.infer<typeof AdoptThreadResult>

export const FollowUpInput = z.object({
  slug: ThreadSlug,
  // Binds the call to the session the tab is looking at, so a stale page cannot deliver a follow-up
  // into a thread that has since been re-dispatched (merged from origin/main, 2026-07-21).
  sessionId: z.string().min(1),
  message: z.string().min(1),
  // Generated once before the optimistic clear so a transport replay can be idempotent.
  deliveryId: z.string().min(1).max(200).optional(),
  // Retire the worker's live process before delivering, so this message lands in a `claude` that has
  // just started. The operator's "Restart worker" verb — the ONLY caller that sets it — exists because
  // a worker inherits its plugin/hooks AND its system prompt at process start and can never pick up a
  // newer frizz build in place (hooks are read once, at startup). Everything else that needs a fresh
  // process derives it server-side; see needsFreshProcessForLimit.
  freshProcess: z.boolean().optional(),
  // PREEMPT the operation the worker is running right now, so this message is read at once instead of
  // when that operation finishes. The operator's "Interrupt and send" verb, and opt-in for the same
  // reason `freshProcess` is: it costs the in-flight tool call's result and the worker's in-memory
  // sub-agents.
  //
  // It exists because delivery is ALREADY as fast as queueing can be. Measured over 14 days of this
  // project's own transcripts, Claude Code drains its queue at the first sampling boundary that
  // exists; the wait an operator feels is the remaining time of whatever was in flight (a long `Bash`,
  // or one 73–133s reasoning+answer generation), which put mid-turn operator prose at p50 13.8s,
  // p90 49s, p99 2.5m. Preempting is the only lever left.
  //
  // Broker-backed Claude only — that is every Claude thread dispatched since the broker cutover. On
  // any other runtime the message is delivered normally and this is ignored, never refused: a send
  // that arrives is always better than a send that errors.
  interrupt: z.boolean().optional(),
})
export type FollowUpInput = z.infer<typeof FollowUpInput>

// Take a follow-up back out of the provider's queue — the operator clicked their own queued bubble to
// unqueue it and get the text back in the prompt box. Keyed by the same `deliveryId` the send carried,
// which IS the uuid the provider queued the message under.
export const UnqueueFollowUpInput = z.object({
  slug: ThreadSlug,
  // Same staleness guard as followUp: a stale tab must not unqueue against a re-dispatched session.
  sessionId: z.string().min(1),
  deliveryId: z.string().min(1).max(200),
}).strict()
export type UnqueueFollowUpInput = z.infer<typeof UnqueueFollowUpInput>
// `unqueued:false` is a real, expected outcome, NOT an error: the message had already been dequeued for
// execution. It is reported rather than thrown precisely because the operator must be able to tell
// "I took it back" from "it's already on its way" — `reason` is what the surface shows them.
export const UnqueueFollowUpResult = z.object({
  unqueued: z.boolean(),
  reason: z.string().optional(),
}).strict()
export type UnqueueFollowUpResult = z.infer<typeof UnqueueFollowUpResult>

// PUSH IT THROUGH NOW — the ↑ on a queued bubble. Carries no message, because there is nothing left to
// send: the words are already sitting in the provider's queue, and the only thing between the agent and
// them is the turn it is currently running. So this is the interrupt half of followUp's `interrupt`
// flag, on its own. Same order-is-the-contract (deliver, THEN interrupt) — here the delivery happened
// whenever the operator hit Enter, which is precisely why the decision no longer has to be made at send
// time the way the composer's old ⚡ demanded.
//
// It preempts the TURN, not one message: the SDK opens the next turn on everything queued, so with
// several bubbles waiting this delivers all of them, in order. The button's copy says so.
export const DeliverQueuedNowInput = z.object({
  slug: ThreadSlug,
  // Same staleness guard as unqueueFollowUp: a stale tab must not preempt a re-dispatched session.
  sessionId: z.string().min(1),
}).strict()
export type DeliverQueuedNowInput = z.infer<typeof DeliverQueuedNowInput>
// `interrupted:false` is an expected outcome, NOT an error: there was no live turn to preempt (the
// daemon is gone, or the agent is already resting), and the queued message is read the ordinary way.
// Reported rather than thrown so the surface can say which happened — the same truthfulness rule
// UnqueueFollowUpResult is built on.
export const DeliverQueuedNowResult = z.object({
  interrupted: z.boolean(),
  reason: z.string().optional(),
}).strict()
export type DeliverQueuedNowResult = z.infer<typeof DeliverQueuedNowResult>

export const SetThreadSnoozeInput = z.object({
  slug: ThreadSlug,
  sessionId: z.string().min(1),
  // null is the explicit "wake now"/cancel operation; presets and custom local input send UTC.
  until: SnoozeUntil.nullable(),
  // Optional scheduled follow-up. Omitted/null ⇒ a plain reminder snooze; a prompt ⇒ the thread is
  // automatically bumped with it at `until`. Always cleared together with the instant, so a wake-now
  // can never leave an armed prompt behind.
  prompt: SnoozePrompt.nullable().optional(),
}).strict()
export type SetThreadSnoozeInput = z.infer<typeof SetThreadSnoozeInput>

// The recurring prompt's OPERATOR half — the footer popover, arming and disarming in ONE call. The
// text, the two triggers and the cadence are all views of one row, and splitting them into separate
// mutations would let a tab holding only some of them clobber the rest on save.
//
// Session-guarded like every other browser write: a tab looking at a thread that has since been
// re-dispatched fails closed rather than arming whatever now owns the slug.
//
// `prompt: null` clears the row entirely. A prompt with both triggers false keeps the text and the
// cadence parked and silent — that IS the off state, and it is why there is no `enabled` field.
// `intervalSeconds` is required when `heartbeat` is true, because a schedule nobody chose is exactly
// the ambiguity the minutes field exists to remove.
export const SetThreadRecurringPromptInput = z.object({
  slug: ThreadSlug,
  sessionId: z.string().min(1),
  prompt: RecurringPromptText.nullable(),
  stopHook: z.boolean(),
  heartbeat: z.boolean(),
  // The POST-COMPACTION trigger (scheduler SOURCE 7, added 2026-08-06). Defaulted rather than required
  // so a client that predates it — an older tab, an older MCP server — keeps writing the row correctly
  // with the trigger off, which is the honest reading of a caller that has never heard of it.
  postCompaction: z.boolean().default(false),
  // The QUESTION HOLD (2026-08-11). Defaulted for the same reason as the trigger above: a caller that
  // has never heard of it means "don't hold", which is also this option's own default.
  pauseOnQuestions: z.boolean().default(false),
  intervalSeconds: RecurringIntervalSeconds.optional(),
}).strict()
// z.input, not z.infer: `postCompaction` is `.default(false)`, so the parsed OUTPUT has it
// required while the wire INPUT does not — and rpc-contract.ts compares the client type against
// z.input. Inferring the output here is what made the drift gate fire.
export type SetThreadRecurringPromptInput = z.input<typeof SetThreadRecurringPromptInput>

// The WORKER half, through `mcp__frizz__recurring_prompt` (which POSTs the same `/rpc/*` surface the
// board uses). A worker has no other way to keep a long effort moving — Claude Code's own in-session
// schedulers cannot fire in the runtime frizz spawns — so this is the counterpart to the operator's
// control above, writing the same row.
//
// Deliberately NOT session-guarded, unlike the operator's input: the MCP server is spawned with its
// thread's slug and keeps it across a resume, while the session id and generation bump underneath it.
// A guard here would fail on exactly the long-lived thread this exists for. The slug is stamped into
// that server's env by frizz, not supplied by the model.
//
// There is deliberately no thread parameter a model could aim elsewhere: a worker may only ever arm its
// OWN thread. One agent making a DIFFERENT thread loop forever is not a capability frizz hands out.
//
// `prompt: null` is the explicit stop, which is how a worker ends its own loop deliberately rather than
// by falling back on the ALLDONE sentinel.
export const SetOwnThreadRecurringPromptInput = z.object({
  slug: ThreadSlug,
  prompt: RecurringPromptText.nullable(),
  stopHook: z.boolean(),
  heartbeat: z.boolean(),
  // The POST-COMPACTION trigger (scheduler SOURCE 7, added 2026-08-06). Defaulted rather than required
  // so a client that predates it — an older tab, an older MCP server — keeps writing the row correctly
  // with the trigger off, which is the honest reading of a caller that has never heard of it.
  postCompaction: z.boolean().default(false),
  // The QUESTION HOLD (2026-08-11), defaulted exactly as the trigger above and for the same reason.
  pauseOnQuestions: z.boolean().default(false),
  intervalSeconds: RecurringIntervalSeconds.optional(),
}).strict()
// z.input, not z.infer: `postCompaction` is `.default(false)`, so the parsed OUTPUT has it
// required while the wire INPUT does not — and rpc-contract.ts compares the client type against
// z.input. Inferring the output here is what made the drift gate fire.
export type SetOwnThreadRecurringPromptInput = z.input<typeof SetOwnThreadRecurringPromptInput>

// What the write ANSWERS with: the row it just overwrote. A `start` REPLACES whatever the thread held —
// including text the HUMAN edited in the footer panel — and the writer could not previously see what it
// destroyed. Returning the superseded row lets the tool say so in the same breath, so a blind overwrite
// is at least a REPORTED one. `null` when the thread held nothing.
export const SetOwnThreadRecurringPromptResult = z.object({
  replaced: ThreadRecurringPrompt.nullable(),
}).strict()
export type SetOwnThreadRecurringPromptResult = z.infer<typeof SetOwnThreadRecurringPromptResult>

// The READ half, from `mcp__frizz__recurring_prompt` with `action: "get"`. Without it a worker can only
// write: it cannot tell whether it is armed at all, what text it armed before its context was compacted
// away, or whether the human has since edited it in the footer. Same caller rules as the write above —
// keyed on the slug alone, and no thread parameter a model could aim at anyone else's row.
export const GetOwnThreadRecurringPromptInput = z.object({
  slug: ThreadSlug,
}).strict()
export type GetOwnThreadRecurringPromptInput = z.infer<typeof GetOwnThreadRecurringPromptInput>

// `null` — rather than an omitted field — because "nothing is armed" is the answer a worker most needs
// to be able to tell apart from "this server is too old to know", which arrives as an HTTP 404 instead.
export const OwnThreadRecurringPromptResult = z.object({
  recurringPrompt: ThreadRecurringPrompt.nullable(),
}).strict()
export type OwnThreadRecurringPromptResult = z.infer<typeof OwnThreadRecurringPromptResult>

// ---- THE ONE-OFF TIMER's three worker procedures -------------------------------------------------
// Same caller and therefore the same rules as the recurring prompt above: no session guard (the MCP
// server outlives the session ids underneath it), and no thread parameter a model could aim elsewhere.
//
// `fireAt` is an exact UTC instant, resolved by the TOOL from whichever of "in N seconds" / "at this
// instant" the worker gave it — one representation reaches the server, so the row, the trailer and the
// scheduler all name the same string.
export const SetOwnThreadTimerInput = z.object({
  slug: ThreadSlug,
  prompt: TimerPromptText,
  fireAt: SnoozeUntil,
}).strict()
export type SetOwnThreadTimerInput = z.infer<typeof SetOwnThreadTimerInput>

export const CancelOwnThreadTimerInput = z.object({
  slug: ThreadSlug,
  id: z.string().min(1).max(64),
}).strict()
export type CancelOwnThreadTimerInput = z.infer<typeof CancelOwnThreadTimerInput>

export const ListOwnThreadTimersInput = z.object({
  slug: ThreadSlug,
}).strict()
export type ListOwnThreadTimersInput = z.infer<typeof ListOwnThreadTimersInput>

// Every one of the three answers with the thread's CURRENT armed set, so a worker never has to make a
// second call to see what it now holds — and so a `set` that lands while an earlier timer is still armed
// shows both.
export const OwnThreadTimersResult = z.object({
  timers: z.array(ThreadTimerView),
}).strict()
export type OwnThreadTimersResult = z.infer<typeof OwnThreadTimersResult>

// ---- THE ACTIVITY READOUT -------------------------------------------------------------------------
// EVERY kind of background work a thread has out, with the id the awaiting fence names it by, in ONE
// call. The fence is structural — it references things by id — so a worker that has lost its ids (a
// compaction, a long turn, a wake it did not expect) cannot write a correct fence at all. This is how it
// gets them back, and it is the same list the sign-off nudge prints, so the two can never disagree.
export const ThreadActivityItem = z.object({
  kind: z.enum(["shell", "agent", "timer", "pr"]),
  /** The string a `<kind>:` fence line must carry. For a shell that is the runtime task id the worker
   *  was shown; for a PR, `owner/repo#N`; for a timer, its `tmr_…` row id. */
  id: z.string(),
  label: z.string(),
  /** ISO8601 of when it started or was armed — absent when frizz has no instant for it. */
  since: z.string().optional(),
  /** A timer's fire instant, or a PR's expiry. Absent for shells and sub-agents. */
  until: z.string().optional(),
}).strict()
export type ThreadActivityItem = z.infer<typeof ThreadActivityItem>

export const ListOwnThreadActivityInput = z.object({
  slug: ThreadSlug,
}).strict()
export type ListOwnThreadActivityInput = z.infer<typeof ListOwnThreadActivityInput>

export const OwnThreadActivityResult = z.object({
  activity: z.array(ThreadActivityItem),
}).strict()
export type OwnThreadActivityResult = z.infer<typeof OwnThreadActivityResult>

export const SetOwnThreadTimerResult = z.object({
  id: z.string(),
  fireAt: z.string(),
  timers: z.array(ThreadTimerView),
}).strict()
export type SetOwnThreadTimerResult = z.infer<typeof SetOwnThreadTimerResult>

export const CancelOwnThreadTimerResult = z.object({
  cancelled: z.boolean(),
  timers: z.array(ThreadTimerView),
}).strict()
export type CancelOwnThreadTimerResult = z.infer<typeof CancelOwnThreadTimerResult>

// ---- The SUPERSEDED worker shapes, kept alive for MCP servers already in flight -----------------
//
// A worker's `frizz-mcp.mjs` is spawned ONCE, out of the promoted build its session was dispatched with,
// and it lives as long as that session — across every frizz server restart. The server meanwhile gets
// restarted from newer source whenever the operator promotes a build. So `/rpc` is a VERSIONED CONTRACT
// between two processes that update INDEPENDENTLY, and renaming a procedure a worker's MCP server calls
// strands every session already running.
//
// Not hypothetical: merging the old `stop_hook` and `heartbeat` tools into one `recurring_prompt` renamed
// this procedure, and every worker holding an older MCP server started getting a bare HTTP 404 for its
// only means of keeping a long effort moving. The two shapes below are what those builds actually send;
// the router folds them onto the merged row above. Retire them only once no build that sends them can
// still be running — the cost of keeping them is two thin aliases, the cost of dropping them early is a
// live worker silently losing a capability mid-effort.
//
// The trigger each one owns is fixed: the stop hook was the ON-REST feature.
export const SetOwnThreadStopHookInput = z.object({
  slug: ThreadSlug,
  prompt: RecurringPromptText.nullable(),
  enabled: z.boolean(),
}).strict()
export type SetOwnThreadStopHookInput = z.infer<typeof SetOwnThreadStopHookInput>

// The heartbeat was the ON-SCHEDULE feature. This covers BOTH of its generations: the older one (posted
// as `setThreadHeartbeat`) carried no `enabled` field and signalled its stop with `prompt: null` alone,
// which is why `enabled` is optional here rather than required.
export const SetOwnThreadHeartbeatInput = z.object({
  slug: ThreadSlug,
  prompt: RecurringPromptText.nullable(),
  intervalSeconds: RecurringIntervalSeconds.optional(),
  enabled: z.boolean().optional(),
}).strict()
export type SetOwnThreadHeartbeatInput = z.infer<typeof SetOwnThreadHeartbeatInput>

// What an in-place plugin reload changed, as the board reports it. Counts answer "did my edit land?";
// `mcpServers` carries NAMES because a reload that changes MCP tools is the one with a real cost — the
// provider re-reads the whole conversation instead of using its prompt cache.
export const ThreadPluginReloadResult = z.object({
  plugins: z.number().int().min(0),
  commands: z.number().int().min(0),
  agents: z.number().int().min(0),
  mcpServers: z.array(z.string()),
  errorCount: z.number().int().min(0),
}).strict()
export type ThreadPluginReloadResult = z.infer<typeof ThreadPluginReloadResult>

// An ```awaiting fence is a PROPOSAL. Confirming binds ONE exact final-message generation — identified
// by the fence instant plus the hint it proposed — to durable state, so a later fence or an edited hint
// asks the operator again instead of inheriting a stale approval.
export const ConfirmAwaitingInput = z.object({
  slug: ThreadSlug,
  sessionId: z.string().min(1),
  fenceAt: z.string().datetime({ offset: true }),
  hint: AwaitingHint,
}).strict()
export type ConfirmAwaitingInput = z.infer<typeof ConfirmAwaitingInput>

// A human-authored display title for a registered session. Trimming happens at the RPC boundary so
// storage never has to distinguish whitespace-only names from real intent; the web input mirrors the
// same cap. This is metadata-only and therefore works identically for Claude and Codex sessions.
export const RenameThreadInput = z.object({
  slug: ThreadSlug,
  title: z.string().trim().min(1).max(200),
})
export type RenameThreadInput = z.infer<typeof RenameThreadInput>

// Claude-only native title generation. The server submits Claude Code's exact `/rename` command,
// observes the resulting custom-title transcript record, and returns the title it durably saved.
// Codex intentionally has no analog: its thread header exposes the manual metadata rename only.
export const AiRenameThreadInput = z.object({ slug: ThreadSlug })
export type AiRenameThreadInput = z.infer<typeof AiRenameThreadInput>
export const AiRenameThreadResult = z.object({ title: z.string().min(1).max(200) })
export type AiRenameThreadResult = z.infer<typeof AiRenameThreadResult>

export const SetThreadPermissionInput = z.object({
  slug: ThreadSlug,
  permissionMode: PermissionMode,
})
export type SetThreadPermissionInput = z.infer<typeof SetThreadPermissionInput>

export const SetThreadPermissionResult = z.object({
  // "next-turn" is the Codex mid-turn answer: `thread/settings/update` ACCEPTS a sandbox change while a
  // turn is running, but the running turn keeps the policy it started with (verified live — a turn that
  // attempted a write after the flip to danger-full-access was still refused). So the change is real and
  // durable, yet it does not reach work already executing. Distinct from "next-resume", which means
  // nothing was applied to the live session at all.
  //
  // It is ALSO the Claude answer, arrived at from the opposite direction: a permission mode is a LAUNCH
  // flag there, so frizz retires the idle worker process and the next turn cold-resumes under the new
  // one (router `setThreadPermission`). Same promise to the operator — stored, and true from the next
  // turn on — reached by restarting rather than by retuning.
  effect: z.enum(["applied", "next-turn", "next-resume"]),
})
export type SetThreadPermissionResult = z.infer<typeof SetThreadPermissionResult>

export const ThreadProfileOptionsInput = z.object({ slug: ThreadSlug }).strict()
export type ThreadProfileOptionsInput = z.infer<typeof ThreadProfileOptionsInput>
export const ThreadProfileOptionsResult = z.object({
  backend: Backend,
  options: z.array(ThreadProfileOption),
})
export type ThreadProfileOptionsResult = z.infer<typeof ThreadProfileOptionsResult>

export const SetThreadProfileInput = z.object({
  slug: ThreadSlug,
  model: z.string().trim().min(1).max(200),
  effort: z.string().trim().min(1).max(100),
}).strict()
export type SetThreadProfileInput = z.infer<typeof SetThreadProfileInput>
export const SetThreadProfileResult = z.object({
  effect: z.enum(["applied", "next-resume"]),
})
export type SetThreadProfileResult = z.infer<typeof SetThreadProfileResult>

// ---- DISPATCH TASK BANNER (composer ↔ transcript) -------------------------------------------------
// The loud fence frizz puts between its own dispatch orientation and the human operator's prompt. It is
// BOTH the worker's system→human handoff cue and the transcript's display boundary, so it lives here,
// next to the other exact presentation markers, rather than in either consumer.
//
// The rule the banner buys is: NOTHING of frizz's sits below it. Everything the worker needs to be told
// about the framing goes ABOVE — below the banner is the operator's prompt, byte for byte, and the
// first user bubble shows exactly that. (Until 2026-07-26 an explanation line and a bare `TASK:` marker
// sat between the banner and the prompt; that marker was the display cut, which is why the retired
// envelope is still recognized in transcript.ts.)
export const DISPATCH_TASK_BANNER = [
  "===============================================================",
  "======================    YOUR TASK    ========================",
  "===============================================================",
].join("\n")

// The exact cut: the banner on its own lines, followed by one blank line, then the prompt. Requiring
// the surrounding newlines keeps a banner quoted inside prose from being read as the boundary.
export const DISPATCH_TASK_BANNER_MARKER = `\n${DISPATCH_TASK_BANNER}\n\n`

// ---- GitHub-first batch dispatch (server ↔ web mirror; wrapper in server/github.ts) ----

// Exact, versioned presentation boundary in a GitHub batch-dispatch prompt. The worker receives the
// whole prompt; transcript normalization exposes only the generated lead above this line as
// `displayText`. Namespacing + versioning make an ordinary HTML comment or markdown example inert.
export const GITHUB_DISPATCH_UI_BOUNDARY = "<!-- frizz:github-dispatch-ui-boundary:v1 -->"

// ---- WAKE-DELIVERY TOKEN (scheduler ↔ transcript) ------------------------------------------------
// The scheduler appends this to every wake it delivers so the worker's own next user record proves the
// delivery landed (the outbox ack is `lastUserText.includes(wakeDeliveryToken(id))`) — which is exactly
// why the token must stay in the STORED text and can only ever be projected out for display.
//
// PRODUCER AND STRIPPER LIVE TOGETHER ON PURPOSE. The delivered message is recorded as an ordinary user
// turn, and the chat renders user text VERBATIM (a pre-wrap bubble, not markdown), so an unstripped
// token is shown to the human as literal `<!-- frizz-wake:… -->`. A format change on one side without the
// other silently brings that back; keeping the pair adjacent is the guard.
export function wakeDeliveryToken(id: string): string {
  return `<!-- frizz-wake:${id} -->`
}

// Anchored to end-of-text with its leading blank line, matching how context.ts appends it. Requiring
// that trailing position (rather than matching anywhere) keeps prose that merely quotes the token —
// this comment's own wording, a bug report pasting one — intact in the bubble.
const WAKE_DELIVERY_TOKEN_TAIL = /\n*<!-- frizz-wake:[A-Za-z0-9_-]+ -->\s*$/

// The token wherever it sits ON A LINE OF ITS OWN. That is how the scheduler always writes it, and it
// is never how prose quotes one — a human asking "why is <!-- frizz-wake:… --> in my bubble?" writes it
// mid-sentence, which this deliberately leaves alone (see the transcript test of exactly that).
//
// The tail anchor above is the RULE; this is the BACKSTOP. The tail is only correct while one record
// holds one delivery, and the runtime breaks that whenever two land while the worker is mid-turn
// (splitWakeDeliveries, below). Splitting restores the anchor — but the split has to model how the
// runtime joins, and that is not frizz's format to pin. So the display strip refuses to depend on it:
// a token on its own line is machine plumbing wherever it ended up, and no shape the runtime invents
// next can put one in front of the human again.
const WAKE_DELIVERY_TOKEN_LINE = /(?:^|\n)[ \t]*<!-- frizz-wake:[A-Za-z0-9_-]+ -->[ \t]*(?=\n|$)/g

// Display projection: the steer the human is meant to read, without the machine-facing token.
export function stripWakeDeliveryToken(text: string): string {
  const out = text.replace(WAKE_DELIVERY_TOKEN_LINE, "")
  // The blank line the token sat behind is its punctuation, not the message's — a token that LED the
  // text leaves one at the top, one that closed it leaves one at the bottom. Both go with it, and only
  // when something was actually removed, so an ordinary message with trailing whitespace does not
  // acquire a display projection (userDisplayText treats "changed" as "worth sending to the client").
  return out === text ? text.replace(WAKE_DELIVERY_TOKEN_TAIL, "") : out.replace(/^\n+/, "").replace(/\s+$/, "")
}

// Was this user turn WRITTEN BY FRIZZ rather than by the human? The token rides only on a scheduler
// delivery, so its presence is the one unambiguous tell — and it matters for presentation: a wake
// rendered in the human's own off-white right-justified bubble claims the operator typed it, when in
// fact frizz is reporting something it noticed. The chat renders these as a first-party card instead.
export function isWakeDelivery(text: string): boolean {
  return WAKE_DELIVERY_TOKEN_TAIL.test(text)
}

// A COALESCED delivery: several outbox messages merged by the runtime into ONE user record.
//
// Everything above assumes one record carries one delivery — the token is anchored to the END, and both
// the display strip and every downstream parse (the recurring-prompt trailer, the GitHub steer) read
// from there. That assumption breaks whenever two deliveries land while the worker is mid-turn: the
// runtime hands the model one user message holding both, joined by a newline, each still carrying its
// own token. The record then ends in a token — so `isWakeDelivery` says yes and the strip takes the
// LAST one — while the first delivery's own token and trailer are stranded in the middle, where no
// anchored parse can see them. That is exactly how a recurring prompt lost its `Recurring prompt · at
// rest` divider and rendered instead as a generic bell card with the whole run of deliveries inside it,
// interior `<!-- frizz-wake:… -->` and all (measured: 14 of 380 real deliveries on this machine).
//
// So cut the record back into the deliveries the scheduler actually sent, and let each one be projected
// on its own. A boundary is a token line WITH MORE CONTENT AFTER IT — the token ends a delivery, so
// anything below it came from the next one. Deliberately not keyed on the runtime's joiner (measured
// today as a single "\n"): that is its format, not frizz's, and a fix that hard-codes it silently stops
// working the day it changes. Whitespace between segments is dropped with the join.
/** One user record → the deliveries it carries, each ending in its own token. `[text]` when it carries
 *  a single delivery (or none), so every caller can treat the split as the general case. */
export function splitWakeDeliveries(text: string): string[] {
  const out: string[] = []
  let start = 0
  for (const m of text.matchAll(WAKE_DELIVERY_TOKEN_LINE)) {
    const end = m.index + m[0].length
    if (!text.slice(end).trim()) break // the LAST token — it closes the record, so nothing follows it
    out.push(text.slice(start, end))
    start = end
  }
  if (out.length === 0) return [text]
  const rest = text.slice(start).replace(/^\s*\n/, "")
  if (rest.trim()) out.push(rest)
  return out
}

// ---- THE agent-to-agent UPWARD message (a sub-agent reporting to its parent) ----------------------
// Claude Code's own wrapper for a message that arrived through the agent-to-agent channel — what a
// BACKGROUND CHILD produces by calling `SendMessage({to:"main"})`. It is delivered into the parent's
// input queue exactly like a human follow-up, so the parent's transcript records it as a user turn
// carrying this wrapper as its literal text. Recognizing it is what stops a child's report from
// rendering as the operator's own bubble with raw XML showing (the `wake` defect, one channel over).
//
// Anchored to the START of the text and required to close, so prose that merely QUOTES a wrapper — this
// repo's own tests and docs do — is left alone. `from` is the sender label; today that is the child's
// `subagent_type` (the worker dispatch hook strips `name`), so it is NOT unique across siblings — the
// delivery record's `origin.senderTaskId` is the unambiguous id, and the parser deliberately does not
// invent one here.
const AGENT_MESSAGE_WRAPPER = /^<agent-message from="([^"]*)">\n?([\s\S]*?)\n?<\/agent-message>\s*$/

// Parse an upward agent-to-agent message into its sender label and body, or undefined when `text` is
// not one. The body is returned verbatim (minus the wrapper's own framing newlines) — it is the part a
// human actually reads, and the part the transcript projects as `displayText`.
export function parseAgentMessage(text: string): { from: string; body: string } | undefined {
  const m = AGENT_MESSAGE_WRAPPER.exec(text.trim())
  if (!m) return undefined
  const from = m[1].trim()
  const body = m[2]
  // A wrapper with no readable body, or none naming its sender, is plumbing rather than a report. Both
  // degrade to the ordinary user path (a plain bubble) instead of an empty or unattributed child card —
  // the label is the whole point of the card, so inventing one would be worse than not drawing it.
  if (!body.trim() || !from) return undefined
  return { from, body }
}

// ---- THE pr-watch WAKE STEER (scheduler ↔ chat card) ---------------------------------------------
// FORMATTER AND PARSER LIVE TOGETHER, for the same reason the token and its stripper do. The scheduler
// composes this string and pastes it into a worker's composer; the chat then has nothing BUT that
// string to rebuild a first-party card from, because the structured activity lives in the scheduler's
// own cursor (keyed by fence generation) and never reaches the transcript. Two definitions of one
// format in two packages is a silent drift waiting to happen — a wording tweak on the producer would
// quietly downgrade every card in the chat to a plain text blob. Keeping the pair adjacent, with a
// round-trip test over both, is the guard.

// Zod rather than a bare interface because the SERVER hands the parsed steer to the chat on the
// transcript message (TranscriptMessage.wakeSteer), so it has to survive wire validation.
export const GithubWakeItem = z.object({
  label: z.string(), // the activity's noun ("comment", "approval", "change request", …)
  actor: z.string(), // GitHub login, no leading @
  bot: z.boolean(), // drives the 🤖/👤 icon; an app files most of what wakes this watcher
  at: z.string().optional(), // ISO8601
  url: z.string().optional(), // the item's own permalink
})
export type GithubWakeItem = z.infer<typeof GithubWakeItem>

export const GithubWakeSteer = z.object({
  ref: z.string(), // owner/repo#N
  items: z.array(GithubWakeItem),
  omitted: z.number(), // fresh items counted but not named (the enumeration cap)
})
export type GithubWakeSteer = z.infer<typeof GithubWakeSteer>

const WAKE_SCOPE = "ignore older activity you have already handled"

function wakeItemTail(item: GithubWakeItem): string {
  // The URL goes LAST and carries no trailing punctuation, so terminal autolinkers cannot swallow a
  // following period into the href.
  return `${item.at ? ` at ${item.at}` : ""}${item.url ? `: ${item.url}` : ""}`
}

// ---- the review-read tail -------------------------------------------------------------------------
// A review's substance is routinely NOT its body. A review app files an empty-bodied review carrying N
// inline comments, so the permalink above lands on an anchor whose obvious read — `gh api …/reviews/ID`
// — hands back `body: ""` and the worker has to GUESS where the content went.
//
// A worker woken by exactly that spent FOUR calls getting to it (2026-07-31, nubjs/nub#587): the body,
// the body again in full to be sure, a `…/pulls/N/comments` sweep filtered by `pull_request_review_id`
// that silently hit the 100-item default page, and finally the same sweep with `--paginate`. The one
// endpoint that answers the question in a single call — `…/pulls/N/reviews/ID/comments` — was never
// reached. So the steer names that call outright, fully materialized, once per review it woke for.
//
// The tail is DERIVED from the items and never stored: the parser drops these lines and rebuilds the
// steer from the header and item lines alone, which is what keeps the round-trip exact without adding a
// field to GithubWakeSteer. It is also invisible to the human — GithubWakeCard renders from the PARSE,
// not from this text — so it costs the card nothing to speak to the worker here.
const WAKE_REVIEW_LEAD = "A review's body is often empty because its substance is inline comments. Read them, one call each:"

// The review permalink is the only place the review id exists, but owner/repo/number come from `ref`,
// which the wake format already validates — so a surprising URL costs the hint, never a wrong command.
function wakeReviewReads({ ref, items }: GithubWakeSteer): string[] {
  const [repo, number] = ref.split("#")
  const ids = new Set<string>()
  for (const item of items) {
    const id = /#pullrequestreview-(\d+)$/.exec(item.url ?? "")?.[1]
    if (id) ids.add(id)
  }
  return [...ids].map((id) => `gh api --paginate repos/${repo}/pulls/${number}/reviews/${id}/comments`)
}

function wakeReviewTail(steer: GithubWakeSteer): string {
  const reads = wakeReviewReads(steer)
  return reads.length ? `\n\n${WAKE_REVIEW_LEAD}\n${reads.join("\n")}` : ""
}

// ---- the BACKLOG tail -----------------------------------------------------------------------------
// The one wake that names activity which is NOT new: the first time a thread parks on a given PR, the
// watcher hands over whatever was already sitting there (maintainer 2026-08-12, choosing this over a
// card that merely mentions it). A worker had parked on colinhacks/zod#6318 saying "waiting on review"
// with two unread reviews already on it, and the old baseline recorded them as handled — so the watcher
// slept on the very thing it was watching for.
//
// It rides as a derived TAIL on the ordinary burst shape rather than a third header, for the reason the
// parser documents below: an unrecognized line under the header is DROPPED, so every already-open tab
// renders this card exactly as before. A new header shape would have made them all fall back to prose.
//
// `backlog` is deliberately NOT a GithubWakeSteer field — it is an argument. Putting it in the schema
// would break the parse round-trip (the parser cannot recover it from the text), and that round-trip is
// the contract that keeps formatter and parser from drifting.
const WAKE_BACKLOG_TAIL =
  "These were already on the PR when you parked, so you may have handled some. Check what is still" +
  " unaddressed, deal with it, and re-park — this is the only time frizz replays a PR's existing" +
  " activity to you."

/** Is this delivered steer the FIRST-PARK REPLAY rather than news?
 *
 *  The chat needs to tell them apart, because they read as opposite things: activity that landed while
 *  the worker was parked is an event, and a PR's pre-existing history is not (maintainer 2026-08-13:
 *  "That already is preexisting on the PR, which I find quite weird… For PRs that have been around for a
 *  long time, it's going to render like a hundred reviews").
 *
 *  Matched on the TAIL rather than carried in `GithubWakeSteer`, which keeps the formatter's round-trip
 *  intact — see the note above on why `backlog` is an argument and not a field. A legacy transcript
 *  written before the tail existed simply reads as not-a-backlog, which is what it was. */
export function isGithubWakeBacklog(text: string | undefined): boolean {
  return typeof text === "string" && text.includes(WAKE_BACKLOG_TAIL)
}

export function formatGithubWakeSteer({ ref, items, omitted }: GithubWakeSteer, opts: { backlog?: boolean } = {}): string {
  const icon = items.some((i) => !i.bot) ? "👤" : "🤖"
  const reviewTail = wakeReviewTail({ ref, items, omitted }) + (opts.backlog ? `\n\n${WAKE_BACKLOG_TAIL}` : "")
  if (items.length === 1 && omitted === 0) {
    const item = items[0]
    const url = item.url ? `: ${item.url}` : "."
    return `${icon} New GitHub ${item.label} on ${ref} from @${item.actor}${item.at ? ` at ${item.at}` : ""}. Read that exact ${item.label} — ${WAKE_SCOPE} — and continue${url}${reviewTail}`
  }
  const more = omitted > 0 ? `\n- …and ${omitted} more not listed — check ${ref} for the rest` : ""
  // The blank line separates the instruction from the items. Frizz's transcript renders a delivered
  // wake as PLAIN TEXT with line breaks preserved, so this buys a paragraph break rather than an <li>,
  // and it keeps the two readable as distinct parts in a terminal composer too.
  // Each line carries its OWN 🤖/👤. A burst routinely mixes a maintainer's comment with a review
  // app's output, and "who is a person here" is the first thing both the worker and a human scanning
  // the card want — the header icon alone cannot say it, and a login is not a reliable tell (@pullfrog
  // is a GitHub App with no `[bot]` suffix). It is also what makes the format round-trip losslessly.
  const lines = items.map((i) => `- ${i.bot ? "🤖" : "👤"} ${i.label} from @${i.actor}${wakeItemTail(i)}`).join("\n")
  return `${icon} ${items.length + omitted} new GitHub items on ${ref}. Read exactly these — ${WAKE_SCOPE} — and continue:\n\n${lines}${more}${reviewTail}`
}

const WAKE_REF = String.raw`[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*#\d+`
const WAKE_SINGLE = new RegExp(
  String.raw`^(👤|🤖) New GitHub (.+?) on (${WAKE_REF}) from @(\S+?)(?: at (\S+?))?\. Read that exact .+? — ` +
    WAKE_SCOPE +
    String.raw` — and continue(?::\s*(\S+)|\.)$`,
)
const WAKE_MULTI_HEAD = new RegExp(
  String.raw`^(👤|🤖) (\d+) new GitHub items on (${WAKE_REF})\. Read exactly these — ` + WAKE_SCOPE + String.raw` — and continue:$`,
)
const WAKE_ITEM = /^- (👤|🤖) (.+?) from @(\S+?)(?: at (\S+?))?(?:: (\S+))?$/
const WAKE_MORE = /^- …and (\d+) more not listed — check .+ for the rest$/

// Rebuild the structured wake from its delivered text. `null` for anything that is not one of the two
// shapes above — the chat then falls back to rendering the text as-is, so a format the parser does not
// know costs a card, never the message.
//
// It is the FALLBACK path now: the server parses at projection time and hands the result over on
// `TranscriptMessage.wakeSteer`, so a current client never re-derives the card from prose. This still
// runs for a legacy transcript and for a server too old to send the field.
//
// UNRECOGNIZED LINES ARE DROPPED, not refused. That is the correction for a real defect: the steer
// gained a review-read tail (c741fb1), the parser learned an allowlist for exactly those two line
// shapes — and every ALREADY-OPEN tab, whose bundle predated it, started rendering the raw-text
// fallback card instead of the divider. Nothing reloads those tabs: `web/api/boot.ts` adopts a new
// server boot id in place on purpose, so an unsent draft survives a restart, which means a promoted
// artifact routinely leaves an old parser reading a new format. An allowlist has to be taught each new
// line and is wrong until it is; dropping what it does not recognize is right in advance. Structural
// integrity rides on the header's own COUNT instead (below), which is what actually catches a
// misread — a truncated or padded burst still returns null.
export function parseGithubWakeSteer(text: string): GithubWakeSteer | null {
  // Absent fields are OMITTED rather than set to undefined, so a parsed steer is deep-equal to the one
  // the formatter was handed — which is what makes the round-trip test a real contract.
  const item = (label: string, actor: string, bot: boolean, at?: string, url?: string): GithubWakeItem => ({
    label,
    actor,
    bot,
    ...(at ? { at } : {}),
    ...(url ? { url } : {}),
  })
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  // The FIRST line decides the shape. Anything below a single-item steer is agent-facing prose the
  // formatter derived (today the review-read tail, tomorrow whatever the next steer gains) — the card
  // has nothing to render from it, so it never gets a say in whether the card renders at all.
  const single = WAKE_SINGLE.exec(lines[0] ?? "")
  if (single) {
    return { ref: single[3], omitted: 0, items: [item(single[2], single[4], single[1] === "🤖", single[5], single[6])] }
  }
  const head = WAKE_MULTI_HEAD.exec(lines[0] ?? "")
  if (!head) return null
  const items: GithubWakeItem[] = []
  let omitted = 0
  for (const line of lines.slice(1)) {
    const more = WAKE_MORE.exec(line)
    if (more) {
      omitted = Number(more[1])
      continue
    }
    const m = WAKE_ITEM.exec(line)
    if (!m) continue // prose below the burst, not an item — see the header-count check below
    items.push(item(m[2], m[3], m[1] === "🤖", m[4], m[5]))
  }
  // The header's own count is the authority on how many landed; disagreeing with it means we misread.
  // Now that an unrecognized line is skipped rather than refused, this is the WHOLE integrity check —
  // a burst that lost a line to truncation, gained one to corruption, or whose item shape drifted out
  // from under this parser lands here and returns null, exactly as before.
  if (!items.length || items.length + omitted !== Number(head[2])) return null
  return { ref: head[3], omitted, items }
}

// The server's gh-CLI availability signal. `installed`/`inRepo`/`nameWithOwner` are STABLE for the
// process lifetime (resolved once at boot); `authed` can flip mid-session (the user runs
// `gh auth login`) so it is re-checked live on each githubStatus query.
export const GithubStatus = z.object({
  installed: z.boolean(),
  inRepo: z.boolean(),
  nameWithOwner: z.string().nullable(),
  authed: z.boolean(),
})
export type GithubStatus = z.infer<typeof GithubStatus>

// ── Hovercards for the GitHub references autolinked into prose ───────────────────────────────────
//
// One card = one `#123` / `owner/repo#123` / commit hash the autolinker turned into an anchor
// (web/lib/githubAutolink.ts). The wire shape is FLAT and every field past `kind` is optional rather
// than a discriminated union, because the same card renders an issue, a PR and a commit: a union
// would triple the schema and the rpc-contract gate for three shapes that differ by four fields.
//
// `ref` is the canonical key both sides cache on — `owner/repo#123` for an issue or PR,
// `owner/repo@<sha>` for a commit — and it is echoed back so a batched response can be matched to
// its request without positional assumptions.
export const GithubRefCard = z.object({
  ref: z.string(),
  kind: z.enum(["issue", "pr", "commit"]),
  repo: z.string(), // owner/repo, for the card's header line
  url: z.string(),
  title: z.string(),
  body: z.string(), // already truncated server-side to the card's excerpt budget
  state: z.string(), // OPEN | CLOSED | MERGED | DRAFT — empty for a commit, which has no state
  stateReason: z.string().optional(), // COMPLETED | NOT_PLANNED | REOPENED — GitHub's closed-issue nuance
  at: z.string().optional(), // ISO: opened-at for an issue/PR, committed-at for a commit
  authorLogin: z.string().optional(),
  authorName: z.string().optional(), // commits carry a git author name with no GitHub account behind it
  authorAvatar: z.string().optional(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })).default([]),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  comments: z.number().int().nonnegative().optional(),
  // Epoch ms of the fetch this card came from. The CLIENT owns the freshness decision (render the
  // cached card instantly, then revalidate if it is old), so it has to be able to see the age.
  fetchedAt: z.number().int().nonnegative(),
})
export type GithubRefCard = z.infer<typeof GithubRefCard>

// ONE request for every reference on the page. The whole point of the batch is that a hover costs no
// round trip at all: the client asks for a screenful of refs as the prose renders and answers the
// hover out of its own store. `refresh` is the revalidation half — set only for the handful of refs
// the client is actually looking at, it makes the server bypass its TTL for those.
export const GithubRefPreviewInput = z.object({
  refs: z.array(z.string().min(3).max(120)).min(1).max(100),
  refresh: z.boolean().default(false),
})
export type GithubRefPreviewInput = z.infer<typeof GithubRefPreviewInput>

// `missing` is a real answer, not a failure: a `#123` in prose can name an issue that does not exist
// (a worker misremembered, or the repo is private to someone else). The client caches it so the
// anchor never asks twice. `error` is set only when the whole batch failed — no gh, no token, rate
// limit — and the client keeps the plain link with no card rather than showing a broken one.
export const GithubRefPreviewResult = z.object({
  cards: z.array(GithubRefCard),
  missing: z.array(z.string()),
  error: z.string().optional(),
})
export type GithubRefPreviewResult = z.infer<typeof GithubRefPreviewResult>

// One row in the picker list. `reactions` is summed server-side across reactionGroups (the list ORDER
// already reflects the sort; this is a display badge). `comments` is optional (present for issues).
export const GithubItem = z.object({
  kind: z.enum(["issue", "pr"]),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  reactions: z.number().int().nonnegative(),
  updatedAt: z.string(),
  comments: z.number().int().nonnegative().optional(),
  // GitHub-mirror row fields — all optional/defaulted so a pre-restart snapshot still parses.
  createdAt: z.string().optional(), // for "opened <when>"
  author: z.string().optional(), // login
  labels: z.array(z.object({ name: z.string(), color: z.string() })).default([]),
  state: z.string().optional(), // OPEN | CLOSED | MERGED
  isDraft: z.boolean().optional(), // PRs only
  // ISSUES only: the pull requests whose bodies carry a closing keyword for this issue (GitHub's own
  // "linked pull requests"). Present means someone is already on it — the row paints the PR glyph so
  // a dispatch doesn't duplicate work in flight. `count` is what the badge shows, mirroring the
  // github.com issue list; `number`/`url`/`state` describe the PRIMARY one (open outranks merged),
  // which the badge links to and names in its tooltip. Absent for PRs and for unclaimed issues.
  linkedPrs: z
    .object({
      count: z.number().int().positive(),
      number: z.number().int().positive(),
      url: z.string(),
      state: z.string(), // OPEN | MERGED
      isDraft: z.boolean().optional(),
    })
    .optional(),
})
export type GithubItem = z.infer<typeof GithubItem>

// One PAGE request. `page` is 1-based; the server clamps it into GitHub's servable window and
// reports back which page it actually served.
export const GithubListInput = z.object({
  kind: z.enum(["issues", "prs"]),
  sort: z.enum(["recent", "reactions"]),
  page: z.number().int().min(1).default(1),
  perPage: z.number().int().min(1).max(100).default(30),
})
export type GithubListInput = z.infer<typeof GithubListInput>

// One page of rows plus what the pager needs to draw itself. `total` is every open item matching the
// query (not just this page); `pageCount` is that clamped to the search API's 1000-result window, so
// the pager never offers a page GitHub will refuse to serve.
export const GithubListResult = z.object({
  items: z.array(GithubItem),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageCount: z.number().int().positive(),
})
export type GithubListResult = z.infer<typeof GithubListResult>

// Minimal batch payload — the server re-hydrates title/body/url fresh from gh at dispatch (always
// current, small wire payload). Deliberately UNCAPPED: the picker pages through the whole repo and a
// human may well want every issue on a page (or several pages' worth) investigated at once. The
// server dispatches them SEQUENTIALLY, so a large batch is a long request, never a spawn burst.
export const GithubBatchInput = DispatchProfileSnapshot.extend({
  items: z.array(z.object({ kind: z.enum(["issue", "pr"]), number: z.number().int().positive() })).min(1),
}).strict()
export type GithubBatchInput = z.infer<typeof GithubBatchInput>

export const GithubBatchResult = z.object({
  dispatched: z.array(z.object({ number: z.number(), kind: z.string(), slug: ThreadSlug })),
  failed: z.array(z.object({ number: z.number(), kind: z.string(), error: z.string() })),
})
export type GithubBatchResult = z.infer<typeof GithubBatchResult>

// ---- SSE events on the global /events channel ----
// The channel is DELTA-based (see delta.ts): a full "board" frame is the connect keyframe and the
// resync frame; steady-state changes ship as "board-delta" (only the threads that actually changed).
// A one-thread status change ships one ThreadView, not the whole ~310KB board — that is the byte win.

// Board-level (non-thread) fields, diffed as a unit and shipped only when they change (BoardDelta.meta).
export const BoardMeta = z.object({
  projectDir: z.string(),
  projectName: z.string(),
  projectLabel: z.string(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  // Structured mirror of `errors` (see BoardErrorItem), diffed + shipped with the rest of the board
  // meta so the repair affordance survives a delta (not just the connect keyframe). Optional for the
  // same pre-restart back-compat reason as on BoardSnapshot.
  errorItems: z.array(BoardErrorItem).optional(),
  // Plan artifacts, diffed + shipped with the board meta so the Plans section survives deltas.
  plans: z.array(PlanView).optional(),
})
export type BoardMeta = z.infer<typeof BoardMeta>

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("board"),
    board: BoardSnapshot,
    // Monotonic publish counter this keyframe corresponds to (the client adopts it, then applies
    // deltas seq+1, seq+2 …). `bootId` is the server's per-process id. BOTH optional so a pre-restart
    // server's frame (which omits them) still parses; a new client treats absent seq as "no delta
    // tracking yet" and absent bootId as "unknown — no reload check".
    seq: z.number().optional(),
    bootId: z.string().optional(),
  }),
  z.object({
    // Keyed per-thread delta. `upserts` are COMPLETE ThreadViews for threads whose serialization
    // changed (or are new); `removed` are ids gone from the board; `meta` is present only when a
    // board-level field changed. Emitted only by a post-restart server → seq/bootId are required here.
    type: z.literal("board-delta"),
    seq: z.number(),
    bootId: z.string(),
    upserts: z.array(ThreadView),
    removed: z.array(ThreadSlug),
    meta: BoardMeta.optional(),
  }),
  z.object({
    type: z.literal("notify"),
    slug: ThreadSlug,
    kind: z.enum(["needs-decision", "turn-done", "exited"]),
    title: z.string(),
    body: z.string().optional(),
  }),
  z.object({
    // Payload-free invalidation for future interaction cards. Provider-controlled command/diff/form
    // metadata never rides the global event bus; clients re-read the authorization-scoped RPC instead.
    type: z.literal("interactions-invalidated"),
    slug: InteractionThreadSlug,
    sessionId: InteractionOpaqueId,
    interactionId: InteractionOpaqueId,
    lifecycle: InteractionLifecycle,
    recordRevision: InteractionRevision,
  }).strict(),
])
export type ServerEvent = z.infer<typeof ServerEvent>
export type BoardEvent = Extract<ServerEvent, { type: "board" }>
export type BoardDelta = Extract<ServerEvent, { type: "board-delta" }>

// Pure delta engine + client apply/decision helpers (kept in a sibling module, re-exported here so
// `@frizz/shared` stays the single entry point).
export * from "./code-fences.ts"
export * from "./delta.ts"
export * from "./drainable-worker.ts"
export * from "./interactions.ts"
export * from "./receipt-bus.ts"
export * from "./thread-slug.ts"

// ---- Rendered conversation (parsed mechanically from the session JSONL — no AI) ----

// Structured file-edit payload for Edit/Write/MultiEdit tool calls, so the client can render a
// syntax-highlighted diff instead of an opaque "edited file.ts" line. Write → old: "" (whole file
// is new); MultiEdit → one TranscriptToolCall per sub-edit. Both strings are capped (see
// transcript.ts EDIT_CAP) so transcripts stay light.
export const TranscriptEdit = z.object({
  file: z.string(),
  old: z.string(),
  new: z.string(),
})
export type TranscriptEdit = z.infer<typeof TranscriptEdit>

// One row of an agent's built-in TO-DO LIST. Set only for a call that ITSELF carries the whole list —
// Claude Code's `TaskList` (whose result enumerates every task), codex's `update_plan` and Claude's
// legacy `TodoWrite` (both of which pass the entire list on every call). The server normalizes those
// onto this one row so one client card renders all three.
//
// Deliberately NOT reconstructed for Claude's per-task deltas (`TaskCreate`/`TaskUpdate`, whose payload
// is `{taskId:"3", status:"completed"}` and nothing more). Deriving a list from them would mean the
// projector accumulating list state across the transcript, which is not its job (maintainer 2026-07-29:
// "don't bother with maintaining your own state here"). Those calls render as ordinary tool cards.
export const TranscriptTodo = z.object({
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
})
export type TranscriptTodo = z.infer<typeof TranscriptTodo>

export const TranscriptToolCall = z.object({
  name: z.string(),
  detail: z.string().optional(), // file path / command / description — whatever the input reveals
  edit: TranscriptEdit.optional(), // set only for Edit/Write/MultiEdit blocks
  // The model-authored one-line description of a Bash command (Claude Code's `description` input
  // field) — the collapsed block's title.
  desc: z.string().optional(),
  // Raw (multi-line) command, set only for a Bash call whose command spans multiple lines or runs
  // long — the client renders it as its own code block instead of the flattened one-line `detail`.
  command: z.string().optional(),
  // Capped human-readable input/source for any tool that has useful payload beyond its one-line
  // detail. Generic cards expand this exactly like Bash expands `command`; specialized cards may
  // retain it as failure context (for example a wrapped apply_patch that did not apply).
  input: z.string().optional(),
  // A capped excerpt of a Read call's tool_result (the file content it returned) — set only for Read
  // calls whose result shipped as text. The client renders it as a collapsed, bordered card (same
  // family as Bash/Edit) that expands to the excerpt. Absent for older transcripts / pre-restart
  // servers, in which case the client falls back to the compact one-line Read summary.
  read: z.string().optional(),
  // A capped excerpt of a tool's captured result. Codex records results for shell calls and for its
  // unified custom-tool wrapper; the client renders this as a second pane below either the Bash body
  // or a generic input body. Absent for Claude calls whose result isn't present in the transcript.
  output: z.string().optional(),
  // Absolute path to an IMAGE the tool returned in its result — e.g. a `take_screenshot` (chrome-devtools
  // MCP) or any tool whose tool_result carries a base64 image block. The server decodes the image once to
  // a content-hashed file under the OS temp dir and records the path here; the client renders it inline in
  // the tool card via the gated /local-image route (tmpdir is a trusted root). Absent for text-only results.
  outputImage: z.string().optional(),
  // Tool lifecycle inferred from call/result pairs. A just-appended call is `pending`; the matching
  // result promotes it to completed/failed/cancelled. Background launches deliberately remain pending
  // after their launch acknowledgement: a later provider-native completion is the only terminal fact.
  // Kept optional for pre-restart transcript data.
  // `exitCode` is present for shell-like results that expose it.
  status: z.enum(["pending", "completed", "failed", "cancelled"]).optional(),
  // A non-terminal shell has a durable, provider-neutral lifecycle identity. `background` means the
  // provider confirmed a live child/session; `unknown` means we saw a poll for an unpaired session.
  // Neither is rendered as done merely because the wrapper call returned.
  backgroundState: z.enum(["background", "unknown"]).optional(),
  // The launching tool_use id of a `background` shell — the SAME key the tailer tracks that shell under
  // (BgShellView.id), and therefore the only exact way to tell "the board's row and this transcript card
  // are one process" from "two processes the model described identically".
  //
  // The ops strip lists a live shell from BOTH sources, and it used to reconcile them on
  // label+startedAt. That key cannot hold: the board's instant is the tool_use RECORD's timestamp while
  // the transcript's is the projected MESSAGE's, and an assistant turn whose prose lands before its call
  // makes those differ by seconds (measured: 19:11:28.190 vs 19:11:32.200 on one real launch), so the
  // same shell rendered twice — once clickable, once not. Optional: absent on codex (whose background
  // execs are transcript-native and have no board row to collide with) and on pre-restart servers,
  // which fall back to the label+startedAt key.
  shellId: z.string().optional(),
  exitCode: z.number().int().optional(),
  // Execution context/result metadata that is useful in a compact card header without dumping a
  // backend envelope. `cwd` comes from exec_command's workdir/cwd, `sessionId` identifies a yielded
  // PTY process (and later write_stdin polls), and `durationMs` is result wall time when recorded.
  cwd: z.string().optional(),
  sessionId: z.union([z.string(), z.number()]).optional(),
  durationMs: z.number().nonnegative().optional(),
  // ---- Agent (sub-agent dispatch) block ----
  // Set only for an `Agent` tool_use that carried a `prompt`. The client promotes such a call into an
  // AgentBlock (same collapsed-card family as Bash/Read): the `detail` is the dispatch description,
  // `subagentType` the model+effort cell, and expanding reveals the (capped) dispatch `prompt`. All
  // optional so a pre-restart server / older transcript falls back to the plain `Agent(detail)` line.
  prompt: z.string().optional(), // the capped dispatch prompt (the AgentBlock's expanded body)
  subagentType: z.string().optional(), // the dispatch's subagent_type verbatim (e.g. "frizz:frizz-opus-high")
  agentId: z.string().optional(), // the Agent tool_use id — the correlation key to the live tracked sub-agent
  // Terminal outcome of the dispatched sub-agent, back-filled when a matching completion
  // <task-notification> appears LATER in the transcript. Drives the AgentBlock header's finished state
  // ("finished 35m" / "failed 12m"). Absent while the child is still live (or its completion was
  // missed) — in which case the live tracked-sub-agent overlay supplies "running Nm" instead.
  agentStatus: z.enum(["completed", "failed", "killed"]).optional(),
  agentElapsedMs: z.number().optional(), // dispatch → completion elapsed, for the finished-state label
  // TRUE only on the copy of the dispatch call the server re-emits, as its own standalone message, at
  // the position the completion <task-notification> landed (see transcript.ts completionEvents). That
  // copy is a TIMELINE MARKER, not a second tool call, so the client renders it as the centered wake
  // divider a background shell's completion already uses — never as a second AgentBlock card
  // (maintainer 2026-07-27: converge an agent finishing onto the background-shell rendering, which is
  // "more visually distinct in a big sea of tool call blocks"). The LAUNCH card, which carries the same
  // agentStatus/agentElapsedMs after back-fill, never sets this and stays an expandable prompt card.
  // Optional + additive: an old client ignores it and shows the previous duplicate-card rendering.
  agentCompletion: z.boolean().optional(),
  // ---- SendMessage (peer / agent-to-agent messaging) block ----
  // Set only for a `SendMessage` tool_use (an orchestrator steering a sub-agent, or a teammate note).
  // The client promotes such a call into the centred WAKE DIVIDER the sub-agent completion and upward
  // report already draw (maintainer 2026-07-31: "render 'Steered' or SendMessage using the same full
  // width notifications, the horizontal rule style component that we render when an agent completes").
  // `sendTo` is the recipient agent id/name, `sendSummary` the short recap, `sendBody` the (capped)
  // message body, and `sendType` the message type when it is NOT a plain "message" (e.g.
  // "shutdown_request"). Summary and body are retained because the SUB-AGENT DRAWER — where the same
  // call is read as the child's own record — still needs them; the parent's divider renders neither.
  // All optional so a pre-restart server / older transcript falls back to a bare divider.
  sendTo: z.string().optional(), // recipient agent id/name (the SendMessage `to`)
  sendSummary: z.string().optional(), // the short recap (the SendMessage `summary`)
  sendBody: z.string().optional(), // the capped message body (the SendMessage `message`/`content`)
  sendType: z.string().optional(), // the message type when not a plain "message" (e.g. "shutdown_request")
  // The steer's DRILL-IN pair, set only when the server could resolve `sendTo` to a child this same
  // transcript dispatched. A Claude `SendMessage` addresses its target by AGENT ID, which is both
  // meaningless to a reader and not a key any drawer resolves — every sub-agent lookup goes through the
  // DISPATCH tool_use id. The server owns that translation (childDispatchIds, the one record where a
  // child's two identities meet) and ships the result: `sendDispatchId` is what the divider's title
  // opens, `sendTargetLabel` the dispatch's own description, which is what the title reads.
  // Absent on codex (its peer tools name a target that was never dispatch-acked here) and on `to:"main"`
  // — in both cases the divider degrades to plain text rather than a link to an unavailable drawer.
  sendDispatchId: z.string().optional(),
  sendTargetLabel: z.string().optional(),
  // ---- SendUserFile (Claude Code file delivery) block ----
  // Set only for a `SendUserFile` tool_use — the worker surfacing files (screenshots, artifacts) to the
  // human. The client promotes such a call into a SentFilesCard that renders the delivered files inline
  // instead of a generic tool block: `sentImages` are absolute paths the server COPIED into its servable
  // screenshot cache (the sources are often scratchpad paths /local-image won't serve), each rendered
  // inline via the gated /local-image route; `sentFiles` are the basenames of any NON-image files
  // (rendered as openable chips); `caption` is the model's one-line caption, shown below. All optional so
  // a pre-restart server / older transcript falls back to the generic tool card.
  sentImages: z.array(z.string()).optional(),
  sentFiles: z.array(z.string()).optional(),
  caption: z.string().optional(),
  // ---- To-do list block ----
  // The whole to-do list, for the calls that carry it (see TranscriptTodo). The client promotes such a
  // call into a TodoBlock — a checklist card, one row per task with its status. Optional, so a
  // pre-restart server / older transcript falls back to the generic card.
  todos: z.array(TranscriptTodo).optional(),
})
export type TranscriptToolCall = z.infer<typeof TranscriptToolCall>

// One block-ordered PART of an assistant turn — the fidelity fix. A turn's content interleaves text
// and tool_use blocks in a meaningful order (a "Let me draft the notes:" lead-in sits DIRECTLY above
// the call it introduces). The legacy split text/tools fields discarded that order (all tools rendered
// before all prose); `parts` preserves it. Contiguous same-kind blocks coalesce into one part.
export const TranscriptPart = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("tools"), tools: z.array(TranscriptToolCall) }),
])
export type TranscriptPart = z.infer<typeof TranscriptPart>

export const TranscriptMessage = z.object({
  // Stable identity of this PROVIDER-NEUTRAL projected message. The server derives it from the
  // transcript incarnation plus the source record that opened the rendered unit; clients use it only
  // for overlap reconciliation, keyed rendering, and scroll anchoring. Optional for rolling upgrades.
  sourceId: z.string().min(1).max(768).optional(),
  // Latest-window projection may pin an unresolved background shell whose original launch message
  // has scrolled into paginated history. The synthetic tools-only card points back to that canonical
  // source so loading the earlier page can replace (not duplicate) it.
  pinnedFromSourceId: z.string().min(1).max(768).optional(),
  role: z.enum(["user", "assistant"]),
  text: z.string(), // markdown; empty when the message was tool-calls only
  // Optional presentation-only projection of `text`. The full text remains available to persistence,
  // search, and transcript logic; shared chat surfaces use this compact form for generated prompts
  // whose machine-facing tail would otherwise dominate the first user bubble.
  displayText: z.string().optional(),
  tools: z.array(TranscriptToolCall),
  at: z.string().optional(), // ISO8601
  // Additive message variant. "event" is transcript PUNCTUATION emitted inline at the position a
  // sub-agent completion <task-notification> was seen (text like `Agent "…" finished — 35m`).
  // "reasoning" is a Codex model-reasoning SUMMARY (the plaintext `summary[]` of a rollout reasoning
  // record — Claude's thinking is redacted at every seam, so this is Codex-only); `text` holds the
  // summary markdown, rendered as a collapsed-by-default expandable block. Absent (undefined) → an
  // ordinary user/assistant message. Old clients that don't know a `kind` render it as a plain
  // assistant line, which is a graceful (if unstyled) degrade.
  kind: z.enum(["event", "reasoning"]).optional(),
  // Wall-clock the model spent THINKING, in ms — set only on a `kind:"reasoning"` message. Derived from
  // the rollout's per-step reasoning timestamps (Σ of each reasoning step's gap from the event before it,
  // which excludes tool-execution time). NOT rendered: it used to caption the reasoning disclosure as
  // "Thought for N seconds", and a permanent row reporting how long the model paused is exactly what the
  // transcript no longer carries (see ReasoningBlock). Kept because it is the server's own measurement
  // and costs nothing to project. Optional: absent on non-reasoning messages and on any reasoning block
  // whose timing couldn't be derived.
  durationMs: z.number().nonnegative().optional(),
  // A turn-BOUNDARY marker: this `kind:"event"` line was emitted at the position a turn opened or
  // closed, so it renders as a centered divider rule carrying the cause label — without it, two
  // consecutive assistant turns (each with its own trailing signal) paint as one seamless bubble.
  // Additive + optional: an old client ignores it and shows the plain quiet event line (graceful
  // degrade).
  //
  // It names WHICH KIND of boundary, because several unrelated events earn the divider and the client
  // has to tell them apart to put the right glyph on each:
  //   wake       — a background task/shell completion `<task-notification>` re-invoked the agent
  //   compaction — the provider rewrote the conversation and dropped everything above this point
  //   rest       — the agent CAME TO REST: its turn ended and nothing further is in flight
  // It was a bare boolean until the dividers grew icons (a shell glyph on a compaction line is simply
  // wrong), and the kind has to come from the SERVER: the alternative is the client sniffing the label
  // text, which is the guess this codebase refuses everywhere else. A string stays truthy, so any
  // surviving `if (boundary)` reads exactly as it did — including on a client that predates `rest`,
  // which draws it as an iconless divider rather than dropping it.
  boundary: z.enum(["wake", "compaction", "rest"]).optional(),
  // Block-ordered content for an assistant turn (see TranscriptPart). Defaults to [] so a pre-restart
  // server (which ships only text/tools) parses; the client renders `parts` when non-empty and falls
  // back to the legacy tools-then-text layout when it's empty. `text`/`tools` stay populated for that
  // fallback window and for consumers (useLiveAnswering, previews) that read the flat fields.
  parts: z.array(TranscriptPart).default([]),
  // A human follow-up SENT to a mid-turn worker that Claude Code has QUEUED but not yet delivered into
  // the agent's context (an `enqueue` queue-operation with no matching delivery record yet). Rendered as
  // a grayed user bubble — the SAME affordance the client uses for its own optimistic send. Flips to
  // undefined/false once the delivery (a `queued_command` attachment) materializes the message. Additive
  // + optional: a pre-restart client ignores it; an old server simply never sets it. NB: the client ALSO
  // sets this transiently on an optimistic local send (see web hooks.ts) — same meaning, same styling.
  queued: z.boolean().optional(),
  // Server-side delivery-ledger identity for a Claude follow-up (delivery-ledger.ts): set on a queued
  // bubble the ledger projects (or tags), so the client's optimistic copy of the SAME send is consumed
  // by id instead of by exact text — the text-match path stays only for id-less legacy flows. Additive.
  deliveryId: z.string().optional(),
  // The ledger's own state for that send. "pending": injected, no JSONL evidence yet. "enqueued":
  // Claude Code's queue holds it (positive receipt, undelivered). "unconfirmed": no evidence appeared
  // within the timeout — the injection likely mutated/never landed; the client renders a quiet warning
  // and the terminal is the recovery surface. Delivered sends never carry this (the ledger drops them;
  // the real transcript record renders). Additive + optional.
  deliveryState: z.enum(["pending", "enqueued", "unconfirmed"]).optional(),
  // FRIZZ wrote this user turn, not the human: it is a scheduler wake delivery (isWakeDelivery). The
  // client renders it as a first-party card rather than the human's off-white right-justified bubble,
  // which was claiming the operator had typed a message the watcher composed. Additive + optional: an
  // old client ignores it and shows the plain bubble (the previous behavior), and an old server simply
  // never sets it.
  wake: z.boolean().optional(),
  // The STRUCTURED wake, parsed by the server from the same text the same build formatted. The chat
  // renders the divider from this rather than re-deriving it from prose in the browser.
  //
  // It exists because re-deriving it in the browser is version-skewed by construction. `web/api/boot.ts`
  // adopts a new server boot id IN PLACE (so an unsent draft survives a restart), so a promoted artifact
  // swaps the server under tabs that keep their old bundle — and on 2026-07-31 a steer that gained two
  // agent-facing lines met parsers that predated them, which cost every open tab its card and dumped the
  // raw `gh api …` text into the transcript instead. Server-side, formatter and parser can never
  // disagree. Additive + optional: absent from a legacy transcript or an older server, and the client
  // falls back to `parseGithubWakeSteer` on the text.
  wakeSteer: GithubWakeSteer.optional(),
  // A SUB-AGENT (or peer session) wrote this user turn, not the human — the same defect class `wake`
  // above corrects. Claude Code's agent-to-agent channel (a background child calling
  // `SendMessage({to:"main"})`) delivers UPWARD into the parent's queue like any follow-up, so the
  // parent's transcript records it as an ordinary user turn whose text is the raw
  // `<agent-message from="…">…</agent-message>` wrapper. Left alone that renders as the operator's own
  // off-white bubble with the XML showing — claiming the human typed what a child reported.
  //
  // `peerFrom` is the sender label the wrapper carries (today the child's `subagent_type`, e.g.
  // `frizz:opus-high`, because the worker dispatch hook strips `name`), and `displayText` carries the
  // unwrapped body.
  //
  // `peerDispatchId` is what makes the chat's report line CLICKABLE: it is the child's Agent DISPATCH
  // tool_use id, which is the key `tailer.subAgent()` resolves a drawer against (live map, retired ring
  // and descendant sidecars are all keyed by it — see TranscriptToolCall.agentId, the same id).
  //
  // It is deliberately NOT the child's own agentId. The delivery record supplies `origin.senderTaskId`,
  // which IS that agentId and is the unambiguous sender identity when several children share one profile
  // label — but the drawer cannot resolve it, so handing it over would open an "unavailable" drawer. The
  // two identities meet in exactly one place: the dispatch's launch-ack record, whose `toolUseResult`
  // carries the new child's `agentId` beside the `tool_use_id` that spawned it. The parser correlates
  // there and stores the DISPATCH id here. Additive + optional: absent when the ack was never seen (a
  // resumed session whose dispatch scrolled out), and the line then renders as plain text, not a dead link.
  peerFrom: z.string().optional(),
  peerDispatchId: z.string().optional(),
  // …and the tell that `peerFrom` is ONLY that subagent_type — that the parser could not resolve the
  // dispatch's own description for this sender. It matters because a profile cell is not a name: every
  // child dispatched at `frizz:opus-high` reports under the identical string, so a divider reading
  // «frizz:opus-high» names the MODEL, not the work, and two siblings are indistinguishable
  // (maintainer 2026-08-06: "I'm also still occasionally seeing things like 'Agent <OPUS:HIGH>
  // rested'"). The client renders an unnamed sender as "Sub-agent reported" and keeps the cell in the
  // tooltip, rather than promoting a profile to a title.
  //
  // Resolution is genuinely late-arriving, not merely missing: the description comes from the DISPATCH
  // record, so a report rendered while the window has not yet reached that record is unnamed and gains
  // its title once it has. Set only on the Claude path — a codex peer names a real task.
  peerUnnamed: z.literal(true).optional(),
  // The sender's own RUNTIME agent id (`origin.senderTaskId`) — kept so a LATER pass can finish the job
  // the fold could not. The paged transcript RPC folds a bounded window, so a report whose dispatch
  // scrolled above the page start has no description available at fold time; the tailer still holds the
  // pairing, and `projectTranscriptPeerNames` uses this id to ask it. Never a drawer key on its own —
  // that is `peerDispatchId`, which the same pass can also supply once this resolves.
  peerSenderTaskId: z.string().optional(),
})
export type TranscriptMessage = z.infer<typeof TranscriptMessage>

// Backward transcript pagination is cursor-based rather than an arbitrary message-count offset. A
// cursor is opaque to the browser and binds one projected boundary to its exact session/transcript
// incarnation. `reachedTurnBoundary:false` is the explicit continuation-within-turn contract used
// only when one pathological turn crosses the bounded page ceiling.
export const TranscriptPageCursor = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/)
export type TranscriptPageCursor = z.infer<typeof TranscriptPageCursor>

export const TranscriptPage = z.object({
  messages: z.array(TranscriptMessage),
  beforeCursor: TranscriptPageCursor.nullable(),
  hasEarlier: z.boolean(),
  reachedTurnBoundary: z.boolean(),
  transcriptKey: z.string().min(1).max(256),
}).strict()
export type TranscriptPage = z.infer<typeof TranscriptPage>

export const TranscriptEarlierInput = z.object({
  slug: ThreadSlug,
  cursor: TranscriptPageCursor,
}).strict()
export type TranscriptEarlierInput = z.infer<typeof TranscriptEarlierInput>

// ---- Terminal WebSocket protocol (ws://host/term/:slug) ----
// client -> server: {t:"input", d:string} | {t:"resize", cols:number, rows:number}
// server -> client: raw utf8 terminal output frames
export type TermClientMsg = { t: "input"; d: string } | { t: "resize"; cols: number; rows: number }

// ---- /ws multiplex protocol (ws://host/ws) — stage 2: ONE socket for board + transcript + notify ----
// The board & notify frames REUSE the stage-1 ServerEvent shapes verbatim (wrapped in {t:"event"}), so the
// client feeds them through the exact same delta/seq/boot handler as SSE (see web/api/board-stream.ts).
// Transcript frames replace the 1.5s threadTranscript poll with server PUSH for subscribed slugs. Terminals
// keep their own /term/:slug socket. Coexists with /events as a graceful fallback (a pre-restart server has
// no /ws route → the client degrades to SSE + polling).

// Client -> server (zod-validated server-side): subscribe / unsubscribe a thread's transcript push.
// Keep the wire identifier aligned with every server-owned thread slug. Besides bounding retained
// subscription state, the shape excludes path separators/control text before it can reach transcript
// lookup code. Foreign session ids are UUID-shaped and remain valid under this grammar.
export const SocketTranscriptSlug = ThreadSlug
export const SocketClientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), topic: z.literal("transcript"), slug: SocketTranscriptSlug }).strict(),
  z.object({ t: z.literal("unsub"), topic: z.literal("transcript"), slug: SocketTranscriptSlug }).strict(),
])
export type SocketClientMsg = z.infer<typeof SocketClientMsg>

// server -> client (hand-built by the server, parsed defensively by the client — a plain union, no zod):
//   - {t:"event"}      wraps a ServerEvent (board keyframe / board-delta / notify)
//   - {t:"transcript"} the pushed transcript for a subscribed slug (replaces the poll response)
//   - {t:"payload-too-large"} is a stable, typed transport downgrade. A board overflow moves the client
//     to SSE once; a transcript overflow pauses only that subscription and leaves explicit HTTP refresh.
//   - {t:"resource-limited"} rejects one transcript subscription when the process/origin read budget is
//     exhausted. The board socket stays healthy and the client exposes an explicit retry instead of churn.
//   - {t:"hb"}         10s heartbeat so the client's staleness watchdog works as it did over SSE
export type SocketServerMsg =
  | { t: "event"; event: ServerEvent }
  | { t: "transcript"; slug: ThreadSlug; messages: TranscriptMessage[] }
  | { t: "payload-too-large"; channel: "board"; actualBytes: number; maxBytes: number }
  | { t: "payload-too-large"; channel: "transcript"; slug: ThreadSlug; actualBytes: number; maxBytes: number }
  | {
      t: "resource-limited"
      resource: "transcript-read"
      scope: "origin" | "global"
      slug: ThreadSlug
      retryAfterMs: number
    }
  | { t: "hb" }

/**
 * One card on the machine's project grid.
 *
 * Everything here comes from the registry index, which is why listing every project costs one file
 * read and never opens a database: the grid must stay cheap enough to be the home page even with
 * forty projects, and opening them to draw cards is exactly the cost lazy activation exists to avoid.
 */
export const ProjectCard = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  path: z.string(),
  lastOpenedAt: z.string(),
  /** The directory is gone — moved or deleted. The card stays so it can be reopened or forgotten. */
  stale: z.boolean(),
  /**
   * When this project's icon was last established, or absent if it never has been.
   *
   * Carried purely so the client can hang it off the `/_frizz/project-icon` URL: the icon bytes are
   * cached hard (a rail of forty squares is forty requests, and none of them should recur), which
   * means a newly uploaded icon would otherwise stay invisible behind the cached old one. A changed
   * version is a changed URL, so the swap is immediate without weakening the caching for everyone.
   *
   * Deliberately NOT "does this project have an icon". Answering that for a project nobody has
   * scanned yet would mean scanning it, and this list is one file read on purpose.
   */
  iconVersion: z.string().optional(),
  /**
   * Whether this project HAS an icon — and crucially, whether we have even looked.
   *
   * Three states, not a boolean, because the two "no icon to draw right now" cases must behave
   * differently and a boolean collapses them:
   *   · `icon`    — one is stored; draw it.
   *   · `none`    — scanned, nothing found. Draw the monogram and DO NOT request the icon route,
   *                 which is what stops an iconless project flashing its initials and then swapping.
   *   · `unknown` — never scanned. The monogram shows, but the request MUST still go out, because
   *                 that request is what triggers the (lazy, cached) scan in the first place.
   *
   * Collapsing `unknown` into `none` deadlocks the whole feature: no image element is rendered, so
   * the icon route is never called, so the scan never runs, so the project stays `unknown` forever.
   * Measured 2026-08-06 — a rail of 29 projects had scanned exactly ONE, and only because a probe
   * had fetched that one's URL by hand.
   */
  iconStatus: z.enum(["icon", "none", "unknown"]),
  /** An operator's uploaded icon, rather than one the scan found. Drives what the menu offers. */
  iconIsCustom: z.boolean().optional(),
})
export type ProjectCard = z.infer<typeof ProjectCard>

/** Formats the icon route will serve — a browser renders each of these in an `<img>`. */
export const PROJECT_ICON_EXTENSIONS = ["png", "svg", "ico", "webp", "jpg", "jpeg", "gif"] as const

/** 4 MB of base64. An app icon that does not fit in this is not an app icon. */
export const PROJECT_ICON_MAX_BASE64_CHARS = 4 * 1024 * 1024

/**
 * What the machine's folder picker came back with.
 *
 * `cancelled` is not an error — it is the commonest outcome after a mis-click, and rendering it as
 * one would put a red message on screen every time someone changed their mind.
 */
export const DirectoryPickResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("picked"), project: ProjectCard }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
])
export type DirectoryPickResult = z.infer<typeof DirectoryPickResult>

/** Where a thread slug actually lives, for a link that no longer says which project it belongs to. */
export const ThreadLocation = z.object({ projectSlug: z.string(), projectName: z.string() })
export type ThreadLocation = z.infer<typeof ThreadLocation>

/**
 * Everything Frizz itself serves lives under this prefix, so the top level stays free for the project
 * routes (`/project/<slug>`) and for the SPA's own route names. Without a reserved namespace the
 * deny-list is a growing list of route names that breaks the day someone clones a repo called
 * `settings`.
 *
 * One constant, exported to both sides, because a server route and the client URL that calls it
 * drifting apart is a 404 that looks like a hung request. The client end is `apiBase()`
 * (web/src/lib/base-path.ts), which appends the project slug; ARCHITECTURE.md § URL shape has the map.
 *
 * (This docstring sat ~80 lines up the file, stacked on ProjectCard's own, until 2026-08-07 — which is
 * why nothing here said where the client half lived.)
 */
export const FRIZZ_ROUTE_PREFIX = "/_frizz"
export function frizzRoute(path: string): string {
  return `${FRIZZ_ROUTE_PREFIX}${path.startsWith("/") ? path : `/${path}`}`
}

/**
 * `http://localhost:9393`.
 *
 * Unassigned in the IANA registry on both TCP and UDP — its neighbours `9390` (OpenVAS) and `9396`
 * are registered and it is not — clear of both Chromium's and Firefox's blocklists (the highest port
 * either blocks is 10080), no dev-tool default, and below every platform's ephemeral floor.
 *
 * Port choice CANNOT buy robustness on Windows: Hyper-V/WSL reservations reported at
 * microsoft/WSL#5514 and #5306 cover 89% of 1024-9999 between them, and every four-digit repeating
 * port is inside a block on at least one of those machines — as are Vite's 5173 and Postgres's 5432.
 * Robustness lives entirely in the fallback below.
 */
export const DEFAULT_PORT = 9393

/**
 * The dev server's own default, so `frizz-dev` never fights the singleton for `9393`.
 *
 * Picked off the same verified shortlist as DEFAULT_PORT: IANA-unassigned on TCP and UDP, on neither
 * browser's blocklist, no tool default. Adjacent by sight for the same reason the fallback is.
 */
export const DEFAULT_DEV_PORT = 9494

/**
 * The primary with a `1` in front: 9393 → 19393.
 *
 * Lands in `10896-24265`, a 13,370-port gap clean on both reported Windows machines, above the
 * highest browser-blocked port and below Linux's ephemeral floor (32768). The band is wide enough
 * that "clean" picks no winner, so the tiebreak is explicability — someone meeting
 * `localhost:19393` is meeting it while something is already going wrong, and it should read at a
 * glance as the same app on its backup port.
 */
export function fallbackPort(base: number): number {
  return base + 10_000
}
// A thread's stable identity string, `frizz-<slug>`. It named a tmux session once; frizz has no tmux,
// and this survives as the integrity check on the session row's `tmux_name` column — a row whose
// stored name does not re-derive from its own slug has been tampered with or mis-keyed.
export const threadIdentityName = (slug: string) => `frizz-${ThreadSlug.parse(slug)}`
