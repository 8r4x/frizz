import { formatFixedDuration, formatToolDuration } from "./durationLabels.ts"
import { AGENT_OUTCOME_VERB } from "./subAgentCompletion.ts"

// WHAT A DISPATCH CARD'S RIGHT-HAND READING SAYS — the whole vocabulary and tone matrix, in one place.
//
// It was previously spread across two renderers inside AgentBlock, chosen by whether the client still
// held a live record for the child, and the two disagreed about everything a reader can see. Eight rows
// of the same kind rendered as: "3m" / "stopped 41m" / "failed 12m" in lowercase sans at three different
// alphas, then "CANCELLED" in amber petite-caps and "FAILED · 12 SEC" in red petite-caps (maintainer
// 2026-07-29: "a bizarre mix of font sizes, color saturations, and capitalization"). Two of those pairs
// were the SAME EVENT twice: a killed child reads "stopped", and a dispatch whose child record aged out
// reads "cancelled" — same interruption, different word, different colour, different typography.
//
// Whether a child record survived is an internal data-availability detail. It must never change the
// words or the tone, so both paths now resolve through this function.
//
// THREE decisions it encodes:
//
//  1. THE WORDS come from AGENT_OUTCOME_VERB, the same map the completion divider reads, and a NOMINAL
//     outcome has none: a card showing a runtime and no liveness mark already means "it ran and stopped"
//     (maintainer 2026-07-29). Only "stopped" and "failed" are things no mark can say.
//
//  2. THE DURATION is spelled out at minute resolution — the form the completion divider two lines below
//     it already uses (formatFixedDuration), so the card and the divider describing one child read
//     identically: "STOPPED · 41 MIN" on both. This deliberately drops the compact "41m" form:
//     durationLabels.ts states the house rule (spell units out in a small-caps status row so an
//     uppercase M cannot read as "million") and scopes the compact exception to the dense child-op row,
//     which is fighting for horizontal room against a ×, a live step and two counters. A dispatch card's
//     reading shares its row with a title and a chevron, so it never qualified for that exception.
//     The precise duration is not lost — it rides the tooltip.
//
//  3. THE TONE is binary. A genuine failure is the red every tool card uses; EVERYTHING else, including
//     an interruption, is the quiet muted gray. Amber is gone from this row: it was saying "caution"
//     about a dispatch someone deliberately stopped.
export type AgentReadingStatus = "pending" | "completed" | "failed" | "cancelled"

export interface AgentReadingInput {
  /** The harness's terminal verdict on the child, once the transcript records one. */
  agentStatus?: "completed" | "failed" | "killed"
  /** Dispatch→completion elapsed, from the harness. */
  agentElapsedMs?: number
  /** The client's live record for this child, while it still holds one. */
  liveState?: "running" | "stale" | "rested"
  /** Elapsed since dispatch. Passed in rather than computed so this stays pure and the live clock drives it. */
  liveElapsedMs?: number
  /** The dispatch CALL's own status — the only signal left when no child record exists. */
  status?: AgentReadingStatus
  durationMs?: number
}

export interface AgentReading {
  /** The verb, or absent when a mark (or the absence of one) already carries the state. */
  label?: string
  duration?: string
  tone: "muted" | "failed"
  /** The tooltip: a full sentence, carrying the PRECISE duration the minute-resolution reading rounds. */
  title: string
  /**
   * A pending dispatch with no child record has no liveness mark on the left, so the reading is the only
   * place motion can live. A neutral spinner, never the background dot: an untracked dispatch is not a
   * provably-detached job (see operationIndicators.ts), and this keeps the one-indicator-per-row rule.
   */
  showSpinner: boolean
}

const precise = (ms?: number): string | undefined => (ms === undefined ? undefined : formatToolDuration(ms))
const coarse = (ms?: number): string | undefined => {
  if (ms === undefined) return undefined
  return formatFixedDuration(ms) || undefined
}

/** The reading, or null when there is genuinely nothing to report (never a fabricated one). */
export function agentReading(input: AgentReadingInput): AgentReading | null {
  const { agentStatus, agentElapsedMs, liveState, liveElapsedMs, status, durationMs } = input

  // 1. A RESOLVED child: the harness's own verdict and elapsed win over the call's.
  if (agentStatus) {
    const stopped = agentStatus === "killed"
    const failed = agentStatus === "failed"
    const exact = precise(agentElapsedMs)
    return {
      label: agentStatus === "completed" ? undefined : AGENT_OUTCOME_VERB[agentStatus],
      duration: coarse(agentElapsedMs),
      tone: failed ? "failed" : "muted",
      title: `${stopped ? "Stopped" : failed ? "Failed" : "Ran for"}${stopped || failed ? " after" : ""} ${exact ?? "an unknown time"}`,
      showSpinner: false,
    }
  }

  // 2. A TRACKED child: the mark on the left says running / stale / rested, so the reading is the bare
  //    runtime. Only a RUNNING child is "working" — a stale or rested one has stopped producing, and a
  //    tooltip claiming otherwise would contradict the mark beside it.
  if (liveState) {
    const exact = precise(liveElapsedMs)
    return {
      label: undefined,
      duration: coarse(liveElapsedMs),
      tone: "muted",
      title: liveState === "running" ? `Working for ${exact ?? "an unknown time"}` : `Dispatched ${exact ?? "an unknown time"} ago`,
      showSpinner: false,
    }
  }

  // 3. NO child record — the call's own status is all that is left. "cancelled" is the same event as a
  //    killed child, so it says the same word: the reader must not be able to tell that fray lost the
  //    correlation.
  if (status === "pending") return { label: "running", tone: "muted", title: "Running", showSpinner: true }
  if (!status && durationMs === undefined) return null
  const failed = status === "failed"
  const stopped = status === "cancelled"
  const exact = precise(durationMs)
  return {
    label: stopped ? AGENT_OUTCOME_VERB.killed : failed ? AGENT_OUTCOME_VERB.failed : undefined,
    duration: coarse(durationMs),
    tone: failed ? "failed" : "muted",
    title: `${stopped ? "Stopped after" : failed ? "Failed after" : "Ran for"} ${exact ?? "an unknown time"}`,
    showSpinner: false,
  }
}
