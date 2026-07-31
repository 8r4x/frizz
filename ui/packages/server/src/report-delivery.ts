// ── Sub-agent report delivery repair ───────────────────────────────────────────────────────────────
// A background sub-agent's final report reaches its parent as a completion `<task-notification>`, and
// that notification rides THREE record shapes in the session JSONL (see tailer.ts `notificationText`).
// Two of them are NOT equivalent to the third, and conflating them is the bug this module exists for:
//
//   queue-operation  — the runtime ACCEPTED the notification into its input queue. Bookkeeping only.
//                      The model has not seen a word of it.
//   user record      — MODEL-FACING. The report is in the agent's context.
//   attachment       — (`type:"queued_command"`) MODEL-FACING. Same.
//
// MEASURED ON THE OPERATOR'S OWN CORPUS (2026-07-30, two real nub threads): a large fraction of
// `status=completed` notifications appear ONLY as queue-operations — an `enqueue` followed by a
// `remove`, with no `user` record and no attachment anywhere in the file. Raw-grepping every line that
// mentions those task-ids finds exactly those two records and nothing else. On the busier thread that
// was 39 of 117 completed reports (33%); the dropped payloads ran 3.3k–23.6k characters and were
// finished adversarial reviews — "3 HARD COMPILE breaks", "2 blocking, 2 should-fix", "Two hard
// CI-gate breaks". The orchestrator landed those diffs believing they had been reviewed. Worse, fray's
// own timeline rendered NOTHING for them, because the tailer retires a sub-agent row on any terminal
// notification regardless of carrier — so the row simply vanished and the loss was invisible.
//
// Payload size was the obvious suspect and is NOT the mechanism: 3,318 chars was dropped on that same
// thread while 12,299 was delivered. The drop is upstream of fray, inside a dependency we do not own
// (Claude Code's own queue, SDK stream-json under the broker — fray only ever READS these records).
//
// So this module does not try to explain the drop. It observes the model-facing carriers directly and
// repairs on ABSENCE, which is correct whatever the upstream cause turns out to be.
//
// IDEMPOTENCE IS CARRIED BY THE TRANSCRIPT, not by a persisted flag. The repair fray injects is itself
// a user record, and it embeds `REPAIR_MARKER` + the task-id. On any later re-fold — a fray restart, a
// cold resume, a full re-read of the file — that record is model-facing evidence for exactly this
// task-id, so the report resolves as delivered and is never repaired twice. Nothing to persist,
// nothing to migrate, and the evidence lives in the same file as the thing it is evidence about.

/** A completion report the runtime queued. Cleared the moment a model-facing carrier names it. */
export interface QueuedReport {
  taskId: string
  /** The dispatch's tool_use id, when the notification carried one (the recovery shape omits it). */
  toolUseId?: string
  /** The child's transcript — the FULL report, and what the repair points at. */
  outputFile?: string
  /** The `<summary>` line, e.g. `Agent "Correctness review of X" finished`. */
  summary?: string
  /** ISO8601 of the queue-operation record that enqueued it. */
  queuedAt?: string
  /** Characters in the `<result>` block — what the agent would have read. */
  chars: number
}

/** Marker embedded in an injected repair so a later re-fold reads it as delivery evidence. */
export const REPAIR_MARKER = "fray-report-repair"

// Bounds the tracking map. Sized GENEROUSLY on purpose: an evicted entry is a lost report that fray
// then silently declines to repair, which is precisely the failure this module exists to end — so the
// cap must not be the thing that reintroduces it. Entries are ~200 bytes, so even a long-lived
// orchestrator costs tens of kilobytes. Measured against the corpus, one real thread accumulated 242
// dropped reports over three days; at 64 the replay detected only 63 of them, at 256 it detects all.
export const MAX_TRACKED_REPORTS = 256
// How long a queued report may sit unresolved before fray treats it as dropped. The runtime delivers
// a queued notification at a TURN BOUNDARY, so the honest signal is "the agent came to rest and it
// still is not in its context" — this timer is only the floor under that check, sized well past a
// normal queue-to-delivery gap (35 ms on the measured cold-rest delivery, sub-second on every other
// delivered sample in the corpus).
export const REPORT_REPAIR_AFTER_MS = 90_000

/**
 * Is this record shape one that puts the notification into the MODEL's context?
 *
 * `queue-operation` is the runtime's own bookkeeping and is deliberately NOT model-facing — that
 * distinction is the entire basis of this module.
 */
export function isModelFacingCarrier(recType: unknown): boolean {
  return recType === "user" || recType === "attachment"
}

/**
 * Is this notification an AGENT's report, as opposed to a background shell's or Monitor's exit line?
 *
 * Only an agent's is worth repairing. A shell's output stays on disk and pollable, so losing its
 * notification costs nothing a re-read cannot recover; a sub-agent's findings exist ONLY inside the
 * notification, so a drop is total. Without this gate the detector fires on ~880 shell/monitor
 * notifications per thread against ~39 real losses — burying the signal it exists to raise.
 *
 * Keyed on the harness's own `<summary>` prose, which is the same class of dependency the tailer
 * already rests on ("Command running in background with ID:", "Monitor started (task"). It is not a
 * guess: measured over 1,178 real notifications across two production threads, `Agent "…"` summaries
 * and long (>12 char) task-ids agree PERFECTLY — 289 agent/long, 884 shell+monitor/short, zero
 * crossover either way. The id shape is therefore kept as a corroborating fallback for the recovery
 * shape, which carries no per-op summary at all.
 *
 * Deliberately NOT keyed on correlating `<tool-use-id>` back to an `Agent` dispatch: a re-steered
 * child's notification carries the SendMessage's id and a grandchild's dispatch lives in another
 * transcript entirely, so that key matched only 76 of 170 real agent reports.
 */
export function isAgentReport(summary: string | undefined, taskId: string): boolean {
  if (summary?.startsWith('Agent "')) return true
  if (summary) return false // a summary that names something else is exactly that
  return taskId.length > 12
}

/** Every `<task-id>` named by a notification block (a recovery block names several at once). */
export function blockTaskIds(block: string): string[] {
  return [...block.matchAll(/<task-id>([^<]*)<\/task-id>/g)]
    .map((m) => m[1].trim())
    // The orphan-scan sentinel correlates to no real dispatch — the tailer skips it too.
    .filter((id) => id.length > 0 && !id.startsWith("__orphan_summary__"))
}

/** Pull the fields a repair needs out of one `<task-notification>` block. */
export function parseReportBlock(block: string, at?: string): Omit<QueuedReport, "taskId"> {
  const grab = (tag: string): string | undefined =>
    block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() || undefined
  return {
    toolUseId: grab("tool-use-id"),
    outputFile: grab("output-file"),
    summary: grab("summary"),
    queuedAt: at,
    chars: grab("result")?.length ?? 0,
  }
}

/**
 * Does this model-facing record resolve a report fray injected a repair for?
 *
 * The repair is not a `<task-notification>`, so the ordinary notification fold will never see it. This
 * is what closes the idempotence loop described at the top of the file.
 */
export function repairedTaskIds(text: string): string[] {
  if (!text.includes(REPAIR_MARKER)) return []
  return [...text.matchAll(new RegExp(`${REPAIR_MARKER}:([A-Za-z0-9_-]+)`, "g"))].map((m) => m[1])
}

/**
 * The message fray injects when a report was dropped.
 *
 * A POINTER, never the payload. The child's transcript on disk already holds the full report — more
 * of it than the truncated `<result>` excerpt ever carried (one measured child's output file was
 * 739,475 bytes against a 12k excerpt). Re-injecting tens of thousands of characters would also feed
 * the runtime the very thing it just failed to move, which is a poor way to fix a delivery failure.
 *
 * It is addressed to the agent, in the imperative, because it is not an FYI: the agent's next action
 * has to change. It names the file, the size, and what was lost.
 */
export function repairMessage(report: QueuedReport): string {
  const who = report.summary?.replace(/\s+/g, " ").trim() || `Sub-agent ${report.taskId}`
  const size = report.chars > 0 ? ` (~${report.chars.toLocaleString("en-US")} characters)` : ""
  const where = report.outputFile
    ? `Its full report is on disk at ${report.outputFile} — READ THAT FILE before you continue.`
    : `Its report was not recoverable from disk; re-run the work or ask the child again.`
  return [
    `[${REPAIR_MARKER}:${report.taskId}] ${who}, but its report never reached you.`,
    `The runtime queued the completion and then discarded it without delivering it${size}, so it is`,
    `NOT in your context and you have not read it, whatever your earlier summary may have implied.`,
    where,
    `If you already acted on this work as though it were reviewed, revisit that decision now.`,
  ].join(" ")
}

/**
 * Which tracked reports are due for repair?
 *
 * Two conditions, and both matter. The age floor keeps fray off a notification that is simply still
 * in flight. `atRest` is the real discriminator: a queued notification is handed to the model at a
 * turn boundary, so once the agent has finished a turn and the report STILL is not in its context,
 * waiting longer cannot help — the delivery that was going to happen already didn't.
 */
export function reportsDueForRepair(
  reports: Iterable<QueuedReport>,
  opts: { nowMs: number; atRest: boolean; afterMs?: number },
): QueuedReport[] {
  if (!opts.atRest) return []
  const afterMs = opts.afterMs ?? REPORT_REPAIR_AFTER_MS
  const due: QueuedReport[] = []
  for (const r of reports) {
    const queuedMs = r.queuedAt ? Date.parse(r.queuedAt) : Number.NaN
    // An unparseable/absent stamp must not make a report eternally un-repairable — treat it as due,
    // since it can only have been queued before now.
    if (Number.isNaN(queuedMs) || opts.nowMs - queuedMs >= afterMs) due.push(r)
  }
  return due
}
