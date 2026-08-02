// Map a Claude tool-permission request (the SDK's canUseTool escalation) to a fray InteractionStore
// entry, and map the human's decision back to a ClaudePermissionDecision. Under permissionMode "auto"
// the SDK's model classifier auto-approves the safe/common majority BEFORE canUseTool — so canUseTool
// fires only for the genuinely risky minority the classifier escalates. Those are exactly the ones that
// belong in front of a human, so the broker journals each as a provider-neutral approval interaction
// (provider.kind "claude") and gates the tool on the dashboard decision — the SDK-typed equivalent of
// what a tmux worker surfaces, but as a clean approve/deny card instead of a stuck pane.
//
// ONE tool on that channel is not an authorization request at all: AskUserQuestion. It is refused
// outright — see the bottom of this file.
import { homedir } from "node:os"
import {
  INTERACTION_PROTOCOL_VERSION,
  InteractionRequest,
  type InteractionRequest as InteractionRequestType,
} from "@fray-ui/shared"
import { redactCredentialSyntax } from "../credential-redaction.ts"
import type { ClaudePermissionDecision, ClaudePermissionRequest } from "./claude-agent-sdk-protocol.ts"

// The decision IDs the fray web CANONICALIZES for a permission-approval card (typedInteractions.ts
// specFor): the security verb is a fixed vocabulary, not provider-chosen, so an unrecognized id renders
// NO button ("N advertised choices cannot be safely… shown"). `grant-turn` = approve-once, `deny` = deny.
export const CLAUDE_PERMISSION_DECISIONS = {
  allow: "grant-turn",
  deny: "deny",
} as const

// The two decisions every Claude tool-approval offers. Durable/session-scoped grants are a later
// refinement; a single-turn grant/deny is the safe, complete first contract. Labels come from the web's
// canonical spec ("Grant for turn" / "Deny"); the ones here are the provider-context fallback.
const ALLOWED_DECISIONS: InteractionRequestType["allowedDecisions"] = [
  { id: CLAUDE_PERMISSION_DECISIONS.allow, semantic: "approve", label: "Grant for turn", description: "Allow this tool call to run once." },
  { id: CLAUDE_PERMISSION_DECISIONS.deny, semantic: "deny", label: "Deny", description: "Block this tool call." },
]

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// Mirrors the shared interaction protocol's UNSAFE_TEXT class: the zod schemas reject it outright, so
// text bound for a CARD is scrubbed of it rather than allowed to sink the whole request.
const SCRUB_UNSAFE_TEXT = new RegExp("[\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]", "gu")

function displayText(value: string, max: number, fallback: string, redact = true): string {
  const scrubbed = (redact ? redactCredentialSyntax(value) : value).replace(SCRUB_UNSAFE_TEXT, "").trim()
  return scrubbed === "" ? fallback : clip(scrubbed, max)
}

function singleLine(value: string, max: number, fallback: string, redact = true): string {
  return displayText(value.replace(/[\r\n]+/gu, " "), max, fallback, redact)
}

/** `~`-shorten a path for the prompt — putting the directory in front of the command only pays off if it
 *  stays narrow. (`src/readout.ts` has the CLI's own copy; the server package cannot import the root
 *  project without a circular project reference, and this is four lines of pure string work.) */
function tildePath(path: string): string {
  const home = homedir()
  if (!path.startsWith(home)) return path
  const rest = path.slice(home.length)
  return rest === "" ? "~" : rest.startsWith("/") ? `~${rest}` : path
}

// The argument that says WHAT a tool call will do, in the order the tools that actually escalate carry
// it. It leads the preview on its own; everything else follows as a labelled line.
const SUBJECT_KEYS = ["command", "file_path", "notebook_path", "path", "url", "pattern", "query", "prompt"]

// InteractionPreview is bounded on THREE axes (16k chars, 24k UTF-8 bytes, 256 lines), and a request
// that overruns any of them fails to parse — which would turn a display problem into a DENIED tool
// call. These caps are low enough that the byte bound is unreachable even for all-3-byte text, so no
// separate byte clamp is needed. Same reasoning caps the message below InteractionDescription's 8k.
const PREVIEW_MAX_CHARS = 6_000
const PREVIEW_MAX_LINES = 200

/** Render a tool input as the text a human reads instead of the JSON a machine reads: the subject
 *  argument verbatim (newlines intact — a heredoc is unreadable escaped), then the rest as `key: value`.
 *  `shown` is prose the card already displays, so the arg carrying it is dropped rather than repeated. */
function inputPreview(input: Record<string, unknown> | undefined, shown: string | undefined): string {
  if (!input) return ""
  const subject = SUBJECT_KEYS.find((key) => typeof input[key] === "string" && input[key] !== "")
  const lines = Object.entries(input)
    .filter((entry) => entry[0] !== subject && entry[1] !== "" && entry[1] !== null && entry[1] !== shown)
    .map((entry) => `${entry[0]}: ${typeof entry[1] === "string" ? entry[1] : JSON.stringify(entry[1])}`)
  if (subject) lines.unshift(String(input[subject]))
  const text = redactCredentialSyntax(lines.join("\n\n")).split("\n")
  return clip(text.length > PREVIEW_MAX_LINES ? `${text.slice(0, PREVIEW_MAX_LINES).join("\n")}\n…` : text.join("\n"), PREVIEW_MAX_CHARS)
}

/** Build the durable interaction request for a Claude tool-permission escalation, or return null when it
 *  can't be represented (never blocks the daemon — the caller falls back to a decision hook). */
export function buildClaudePermissionInteraction(
  request: ClaudePermissionRequest,
  owner: { projectId: string; threadSlug: string; sessionId: string; cwd: string },
): InteractionRequestType | null {
  const tool = request.toolName || "tool"
  // A shell command is shown the way a terminal shows it: the working directory becomes the prompt in
  // front of the command instead of a muted line under it, and the title says what is about to happen
  // rather than naming the tool twice. Only a tool that actually takes a `command` earns that layout —
  // a file path or an MCP argument sitting behind a `❯` would claim to be a shell line and isn't.
  const command = typeof request.input?.command === "string" ? request.input.command : ""
  const title = clip(command ? "Run a command?" : `Approve ${tool}?`, 150)
  // Say the WHY once and the WHAT once. The tool name is already the title, so it is not repeated as
  // prose, as a "requested permission", or as a resource label — the card carries each fact one time.
  const description = request.description ? clip(redactCredentialSyntax(request.description), 1_000) : ""
  const message = clip(
    [description, request.blockedPath ? `Blocked path: ${clip(request.blockedPath, 500)}` : ""].filter(Boolean).join("\n\n"),
    2_000,
  )
  // The input is UNTRUSTED provider text; redact credential syntax and bound it hard before it ever
  // reaches a card. It is display-only and is never parsed or executed by fray.
  const preview = inputPreview(request.input, request.description)
  const parsed = InteractionRequest.safeParse({
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    contentFormat: "plain-text",
    provider: { kind: "claude", name: "Claude session broker" },
    source: { kind: "tool", id: clip(request.toolUseId || tool, 500), label: clip(tool, 150) },
    owner: {
      projectId: owner.projectId,
      threadSlug: owner.threadSlug,
      sessionId: owner.sessionId,
      // The broker has no codex-style turn/item ids; the requestId uniquely identifies this escalation
      // within the session and is what the daemon answers against, so it anchors both.
      turnId: clip(request.requestId, 500),
      itemId: clip(request.requestId, 500),
      sessionEpoch: 0,
      capabilityRevision: 0,
    },
    providerRequestId: clip(request.requestId, 500),
    allowedDecisions: ALLOWED_DECISIONS,
    payload: {
      kind: "permission-approval",
      title,
      // `permission` is the card's readable identity, the way Codex's is "network+filesystem". It was
      // the requestId, which put a bare UUID on screen and told the operator nothing.
      permission: singleLine(tool, 250, "tool"),
      ...(message ? { message } : {}),
      ...(preview ? { preview } : {}),
      ...(command
        ? { promptLabel: singleLine(tildePath(owner.cwd), 250, "~", false) }
        : { workingDirectoryLabel: clip(owner.cwd, 2_000) }),
    },
    expiresAt: null,
  })
  return parsed.success ? parsed.data : null
}

/** Map a resolved interaction's decision id to the Claude decision the daemon applies. Anything that is
 *  not an explicit approve is treated as a deny — fail closed. */
export function claudePermissionDecisionFor(decisionId: string | undefined): ClaudePermissionDecision {
  if (decisionId === CLAUDE_PERMISSION_DECISIONS.allow || decisionId === "grant-session") return { behavior: "allow" }
  return { behavior: "deny", message: "The operator denied this tool call." }
}

// ---------------------------------------------------------------------------------------------
// AskUserQuestion — refused, not rendered
// ---------------------------------------------------------------------------------------------
// AskUserQuestion arrives on this same canUseTool channel but is not an authorization request: the tool
// collects a CHOICE, and the SDK contract returns that choice in the decision's `updatedInput`. Between
// 2026-07-27 (f5134b4) and 2026-08-02 fray honoured that contract — the call became a real
// `agent-question` card and the operator's pick reached the model verbatim. That code is deleted, and
// deleted deliberately: the card worked and the mechanics around it did not.
//
// A native ask BLOCKS the turn. A ```question fence ENDS it. That difference is the whole argument:
//   - a parked turn cannot be steered. Follow-ups the operator types pile up as queued sends the turn
//     will never consume, so the ONE way out is answering that one card;
//   - the row keeps reading `running` while it waits, so it does not look like a thread that stopped;
//   - the tool's `header` becomes the card title (a live one read "Default") and each option's rationale
//     has to be folded into its label, where the card clips it mid-word. A fence carries both in full.
// Measured on a live thread 2026-08-02: 90 minutes parked, two operator messages stranded behind it.
//
// So the tool is taken away at query start (WORKER_DISALLOWED_TOOLS, backend/types.ts) on both Claude
// transports, the cc-worker PreToolUse hook denies it, and the bridge denies it here if it somehow still
// arrives. `agent-question` itself stays — Codex's item/tool/requestUserInput still produces one, and
// codex ASKS AT REST rather than mid-turn, which is the case this whole objection does not apply to.
export const CLAUDE_ASK_USER_QUESTION_TOOL = "AskUserQuestion"

export const CLAUDE_ASK_DENY_MESSAGE =
  "Interactive question prompts freeze a fray worker: the turn parks until someone answers, and every " +
  "follow-up the operator sends queues up behind it unread. Ask in your FINAL MESSAGE instead, using one " +
  "or more ```question fenced blocks — each self-contained (context + the specific question + lettered " +
  "`- A. …` options + a recommendation) — then END YOUR TURN. The fray queue renders each block as a card " +
  "and the answer arrives as your next user message."

