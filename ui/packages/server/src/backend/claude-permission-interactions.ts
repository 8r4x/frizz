// Map a Claude tool-permission request (the SDK's canUseTool escalation) to a fray InteractionStore
// entry, and map the human's decision back to a ClaudePermissionDecision. Under permissionMode "auto"
// the SDK's model classifier auto-approves the safe/common majority BEFORE canUseTool — so canUseTool
// fires only for the genuinely risky minority the classifier escalates. Those are exactly the ones that
// belong in front of a human, so the broker journals each as a provider-neutral approval interaction
// (provider.kind "claude") and gates the tool on the dashboard decision — the SDK-typed equivalent of
// what a tmux worker surfaces, but as a clean approve/deny card instead of a stuck pane.
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

/** Build the durable interaction request for a Claude tool-permission escalation, or return null when it
 *  can't be represented (never blocks the daemon — the caller falls back to a decision hook). */
export function buildClaudePermissionInteraction(
  request: ClaudePermissionRequest,
  owner: { projectId: string; threadSlug: string; sessionId: string; cwd: string },
): InteractionRequestType | null {
  const tool = request.toolName || "tool"
  // The input is UNTRUSTED provider text; redact credential syntax and bound it hard before it ever
  // reaches a card. It is display-only and is never parsed or executed by fray.
  let inputSummary = ""
  try { inputSummary = clip(redactCredentialSyntax(JSON.stringify(request.input ?? {})), 3_800) } catch { inputSummary = "(uninspectable input)" }
  const title = clip(`Approve ${tool}?`, 150)
  const message = clip(
    `A ${tool} tool call needs your approval before it runs.` +
      (request.description ? `\n\n${clip(redactCredentialSyntax(request.description), 1_000)}` : "") +
      (inputSummary ? `\n\nInput: ${inputSummary}` : "") +
      (request.blockedPath ? `\n\nPath: ${clip(request.blockedPath, 500)}` : ""),
    7_900,
  )
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
      title,
      message,
      kind: "permission-approval",
      permission: clip(request.requestId, 500),
      resourceLabel: clip(tool, 2_000),
      workingDirectoryLabel: clip(owner.cwd, 2_000),
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
