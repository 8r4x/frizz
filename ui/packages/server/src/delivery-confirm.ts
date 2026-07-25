import type { BoardManager } from "./board.ts"
import type { SessionRow, Storage } from "./storage.ts"
import * as tmux from "./tmux.ts"
import { inspectClaudeComposer } from "./permission-controller.ts"
import { stripDeliveryMarkers } from "./delivery-marker.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"
import {
  parseDeliveryLedger,
  serializeDeliveryLedger,
  type DeliveryLedgerItem,
} from "./delivery-ledger.ts"

// ── Submit confirmation: prove the Enter actually landed, and press it again when it did not ────────
//
// fray steers a Claude thread by pasting the follow-up into Claude Code's TUI composer and sending
// Enter over tmux. The TUI can SWALLOW that Enter: it folds the keystroke into the paste it is still
// ingesting and inserts it as a literal newline instead of submitting. The text then just sits in the
// composer, unsent, until some LATER Enter submits the whole accumulation as one glued message. That
// is the operator's "steering feels slow / the agent never saw it" — measured on their own live thread
// as enqueue→dequeue gaps of 3s to 112s, and as single queue records that were byte-exact
// concatenations of two separately-sent follow-ups.
//
// resume.ts now sends every follow-up through the bracketed-paste + blocking-settle path, which took
// the measured swallow rate from 16/20 (single-line `send-keys`) to 0/20 mid-turn. This module is the
// safety net for the residual: it watches the composer and re-presses Enter when — and only when — the
// pane provably still holds fray's own unsent text.
//
// ── Why this can never double-send ────────────────────────────────────────────────────────────────
//  1. The retry sends a BARE `Enter` key and nothing else. The message text is never re-injected, so
//     no mechanism exists by which a second copy of it could reach the composer.
//  2. The retry only fires when the composer's CURRENT content is exactly fray's own outstanding
//     follow-up text. If the first Enter had landed, Claude Code has already cleared the composer, the
//     content no longer matches, and no key is sent at all.
//  3. The one remaining race — the original Enter takes effect in the window between our capture and
//     our keystroke — lands our Enter on an already-empty composer. Enter on an empty Claude composer
//     is a NO-OP: verified against a real claude 2.1.218 TUI (6 bare Enters into an empty mid-turn
//     composer produced zero new JSONL records). So the worst case is a wasted keystroke.
// Verified end to end: 8/8 deliberately-swallowed sends recovered by one bare Enter each, producing
// exactly 8 queue records with zero duplicate payloads.
//
// ── Why this can never submit the human's draft ───────────────────────────────────────────────────
// The composer must be accounted for IN FULL by fray's own outstanding items, compared with every
// whitespace removed (so the pane's soft-wrapping cannot break the identity). One extra character the
// operator typed — before, after, or between — leaves an unconsumed remainder and the retry is
// declined. A large paste that Claude Code collapses to its opaque `[Pasted text #N +M lines]` chip is
// likewise never retried: a chip is unverifiable, so the item is surfaced as unconfirmed instead.

const POLL_MS = 500

// A just-injected follow-up is legitimately still in the composer for a moment while the TUI ingests
// the bracketed paste and submits it. Only a send older than this is a candidate for a re-press.
export const SUBMIT_GRACE_MS = 1_500

// Bare Enters we will press for one stuck item before giving up and telling the operator. Three ticks
// of a TUI that keeps refusing to submit is not a race any more.
export const MAX_SUBMIT_ATTEMPTS = 3

// Claude Code collapses a big or multi-line paste into an opaque chip. Its content cannot be verified
// against what fray sent, so a composer containing one is never auto-submitted.
const PASTE_CHIP_RE = /\[Pasted text #\d+(?: \+\d+ lines?)?\]/

// Strip the invisible delivery marker BEFORE squashing. The marker's codepoints are deliberately not
// matched by `\s`, so without this the pane (which holds fray's stamped text) would never equal the
// ledger item (which holds the clean text) and the stuck-composer re-press would silently stop working.
const squash = (value: string): string => stripDeliveryMarkers(value).replace(/\s+/g, "")

export type SubmitDecision =
  | { kind: "idle" } // composer holds nothing of ours (empty, a human draft, a modal, a paste chip)
  | { kind: "resend"; items: number[] } // press Enter; these ledger indices are what it will submit
  | { kind: "exhausted"; items: number[] } // already re-pressed MAX times — surface the failure

// Which outstanding ledger items account for the composer, IN FULL and IN ORDER.
//
// `candidates` are index/text pairs in send order. The composer is consumed left to right: each
// candidate either matches at the cursor (and is consumed) or is skipped because it already landed.
// A leftover remainder — anything the operator typed, or a paste chip — yields null, and null always
// means "keep your hands off this composer".
export function composerAccountedBy(
  composerText: string,
  candidates: readonly { index: number; text: string }[],
): number[] | null {
  if (PASTE_CHIP_RE.test(composerText)) return null
  let rest = squash(composerText)
  if (!rest) return null
  const used: number[] = []
  for (const candidate of candidates) {
    const text = squash(candidate.text)
    if (!text) continue
    if (!rest.startsWith(text)) continue
    used.push(candidate.index)
    rest = rest.slice(text.length)
    if (!rest) break
  }
  return rest.length === 0 && used.length > 0 ? used : null
}

// The whole decision, as a pure function of (composer text, ledger, clock) so the hazardous cases —
// human draft, paste chip, first Enter already landed, retry exhaustion — are all unit-pinnable.
export function decideSubmit(
  composer: ReturnType<typeof inspectClaudeComposer>,
  items: readonly DeliveryLedgerItem[],
  nowMs: number,
): SubmitDecision {
  // Only a composer with visible text can be holding an unsent send. `empty` means Claude Code cleared
  // it, i.e. the submit landed; `unavailable` means we cannot read it and must not act blind.
  if (composer.kind !== "typed") return { kind: "idle" }
  // An `enqueued` item is positively receipted by Claude Code's own queue — it is NOT in the composer,
  // and including it would let a landed send account for text still sitting there.
  const candidates = items
    .map((item, index) => ({ index, item }))
    .filter(({ item }) => item.state !== "enqueued")
    .map(({ index, item }) => ({ index, text: item.text }))
  if (!candidates.length) return { kind: "idle" }
  const used = composerAccountedBy(composer.text, candidates)
  if (!used) return { kind: "idle" }
  // Never touch a send young enough that the TUI is simply still working through the paste.
  const due = used.filter((index) => {
    const born = Date.parse(items[index].at)
    return Number.isFinite(born) && nowMs - born >= SUBMIT_GRACE_MS
  })
  if (!due.length) return { kind: "idle" }
  const attempts = Math.max(...used.map((index) => items[index].submitAttempts ?? 0))
  return attempts >= MAX_SUBMIT_ATTEMPTS ? { kind: "exhausted", items: used } : { kind: "resend", items: used }
}

// How long a flushed Enter is given to clear the composer before the new follow-up is pasted anyway.
// Measured composer-clear times on a real claude 2.1.218 TUI: p50 ~500ms, max 848ms over 20 sends.
const FLUSH_SETTLE_MS = 900

export interface DeliveryConfirmTerminal {
  capturePanes(slugs: readonly string[]): Map<string, string>
  sendKey(slug: string, key: "Enter"): void
  findExpectedAdoptionPane(expected: tmux.ExpectedAdoptionPane): tmux.AdoptionPaneLookup
  captureExpectedAdoptionPane(expected: tmux.ExpectedAdoptionPane, escaped?: boolean): tmux.ExactPaneCapture
  sendKeyToExpectedAdoptionPane(expected: tmux.ExpectedAdoptionPane, key: "Enter"): boolean
}

export interface DeliveryConfirmerDeps {
  storage: Storage
  board: BoardManager
  terminal?: DeliveryConfirmTerminal
  now?: () => number
}

export interface DeliveryConfirmer {
  tick(): void
  start(): void
  stop(): void
}

// Submit a follow-up still stuck in the composer BEFORE pasting the next one on top of it.
//
// Without this, two steers sent closer together than the confirmer's grace window glue into one
// message: the first Enter is swallowed, the second paste lands directly after the stranded text, and
// the second Enter submits the pair. That is byte-for-byte the operator's `item(196) + item(183)` with
// no separator, and it reproduced here — twice in ten sends — at a 700ms cadence even with the
// confirmer running, because the next send beat the grace window.
//
// So the human-steer path checks first, and it is FREE on the normal path: a row with no outstanding
// ledger item never captures a pane at all. The same exact-match gate applies — a composer holding
// anything but fray's own unsent text is left completely alone, and only a bare Enter is ever sent.
export async function flushStuckComposer(deps: DeliveryConfirmerDeps, slug: string): Promise<void> {
  const now = deps.now ?? Date.now
  const terminal = deps.terminal ?? defaultTerminal()
  const row = deps.storage.getSession(slug)
  if (!row || row.backend === "codex" || row.codex_runtime === "app-server" || !row.delivery_ledger) return
  const items = parseDeliveryLedger(row.delivery_ledger)
  const candidates = items
    .map((item, index) => ({ index, item }))
    .filter(({ item }) => item.state !== "enqueued")
    .map(({ index, item }) => ({ index, text: item.text }))
  if (!candidates.length) return
  const binding = adoptionRuntimeBinding(deps.storage, row)
  if (binding.kind === "conflict") return
  let pane: string
  let press: () => boolean
  try {
    if (binding.kind === "unbound") {
      pane = terminal.capturePanes([slug]).get(slug) ?? ""
      press = () => {
        try {
          terminal.sendKey(slug, "Enter")
          return true
        } catch {
          return false
        }
      }
    } else {
      const captured = terminal.captureExpectedAdoptionPane(binding.claim, false)
      if (captured.kind !== "captured") return
      pane = captured.text
      press = () => terminal.sendKeyToExpectedAdoptionPane(binding.claim, "Enter")
    }
  } catch {
    return
  }
  const composer = inspectClaudeComposer(pane)
  // No grace window here, deliberately: we are about to paste on top of this composer either way, so
  // the moment it provably holds our own unsent text, submitting it is strictly better than gluing to
  // it. Every other guard is unchanged — typed-and-exactly-ours, and a bare Enter only.
  if (composer.kind !== "typed") return
  const used = composerAccountedBy(composer.text, candidates)
  if (!used) return
  const nowIso = new Date(now()).toISOString()
  const next = items.map((item, index) =>
    used.includes(index) ? { ...item, submitAttempts: (item.submitAttempts ?? 0) + 1, updatedAt: nowIso } : item,
  )
  deps.storage.setDeliveryLedger(slug, serializeDeliveryLedger(next))
  press()
  deps.board.refresh()
  await new Promise((resolve) => setTimeout(resolve, FLUSH_SETTLE_MS))
}

function defaultTerminal(): DeliveryConfirmTerminal {
  return {
    capturePanes: tmux.capturePanes,
    sendKey: tmux.sendKey,
    findExpectedAdoptionPane: tmux.findExpectedAdoptionPane,
    captureExpectedAdoptionPane: tmux.captureExpectedAdoptionPane,
    sendKeyToExpectedAdoptionPane: tmux.sendKeyToExpectedAdoptionPane,
  }
}

export function createDeliveryConfirmer(deps: DeliveryConfirmerDeps): DeliveryConfirmer {
  const now = deps.now ?? Date.now
  const terminal: DeliveryConfirmTerminal = deps.terminal ?? defaultTerminal()
  let timer: NodeJS.Timeout | null = null

  // Rows whose ledger holds an unreceipted follow-up old enough to be worth checking. Everything else
  // costs one string test — a board with no outstanding steer spends ZERO tmux calls per tick.
  function candidateRows(nowMs: number): { row: SessionRow; items: DeliveryLedgerItem[] }[] {
    const out: { row: SessionRow; items: DeliveryLedgerItem[] }[] = []
    for (const row of deps.storage.allSessions()) {
      if (row.backend === "codex") continue // the app-server bridge owns codex delivery end to end
      if (row.codex_runtime === "app-server") continue // headless: no composer to inspect
      if (!row.delivery_ledger) continue
      const items = parseDeliveryLedger(row.delivery_ledger)
      const ripe = items.some((item) => {
        if (item.state === "enqueued") return false
        if ((item.submitAttempts ?? 0) > MAX_SUBMIT_ATTEMPTS) return false
        const born = Date.parse(item.at)
        return Number.isFinite(born) && nowMs - born >= SUBMIT_GRACE_MS
      })
      if (ripe) out.push({ row, items })
    }
    return out
  }

  function tick(): void {
    const nowMs = now()
    const candidates = candidateRows(nowMs)
    if (!candidates.length) return
    // ONE batched capture for every unbound candidate. Per-slug `tmux capture-pane` costs ~105ms of
    // synchronous event-loop block each and was deliberately removed from the tick's hot path; this
    // path must not reintroduce it. Adopted rows capture by their exact pane tuple (identity-checked
    // server-side), which has no batched form and is rare.
    const unbound = candidates.filter(({ row }) => adoptionRuntimeBinding(deps.storage, row).kind === "unbound")
    let batch = new Map<string, string>()
    if (unbound.length) {
      try {
        batch = terminal.capturePanes(unbound.map(({ row }) => row.slug))
      } catch {
        return // tmux unreachable this tick — no evidence, no action
      }
    }
    let refresh = false
    for (const { row, items } of candidates) {
      const binding = adoptionRuntimeBinding(deps.storage, row)
      if (binding.kind === "conflict") continue
      let pane: string | undefined
      let press: (() => boolean) | undefined
      if (binding.kind === "unbound") {
        pane = batch.get(row.slug)
        press = () => {
          try {
            terminal.sendKey(row.slug, "Enter")
            return true
          } catch {
            return false
          }
        }
      } else {
        const claim = binding.claim
        const live = terminal.findExpectedAdoptionPane(claim)
        if (live.kind !== "found" || live.pane.dead) continue
        const captured = terminal.captureExpectedAdoptionPane(claim, false)
        if (captured.kind !== "captured") continue
        pane = captured.text
        press = () => terminal.sendKeyToExpectedAdoptionPane(claim, "Enter")
      }
      if (pane === undefined) continue
      const decision = decideSubmit(inspectClaudeComposer(pane), items, nowMs)
      if (decision.kind === "idle") continue
      // Re-read under the same synchronous turn: the tailer folds and rewrites this same column, and a
      // decision taken against a ledger it has since replaced must not be written back over it.
      const fresh = deps.storage.getSession(row.slug)
      if (!fresh || (fresh.delivery_ledger ?? null) !== (row.delivery_ledger ?? null)) continue
      const nowIso = new Date(nowMs).toISOString()
      if (decision.kind === "exhausted") {
        const next = items.map((item, index) =>
          decision.items.includes(index) && item.state !== "unconfirmed"
            ? { ...item, state: "unconfirmed" as const, updatedAt: nowIso }
            : item,
        )
        if (next.some((item, index) => item !== items[index])) {
          deps.storage.setDeliveryLedger(row.slug, serializeDeliveryLedger(next))
          refresh = true
        }
        continue
      }
      // Count the attempt BEFORE pressing: a keystroke that tmux accepted but the TUI ignored must
      // still burn its budget, or a permanently wedged composer would be re-pressed forever.
      const next = items.map((item, index) =>
        decision.items.includes(index)
          ? { ...item, submitAttempts: (item.submitAttempts ?? 0) + 1, updatedAt: nowIso }
          : item,
      )
      deps.storage.setDeliveryLedger(row.slug, serializeDeliveryLedger(next))
      refresh = true
      press()
    }
    if (refresh) deps.board.refresh()
  }

  return {
    tick,
    start() {
      if (timer) return
      timer = setInterval(() => {
        try {
          tick()
        } catch {
          // Telemetry-grade: a confirmer fault must never take down the producer loop.
        }
      }, POLL_MS)
      timer.unref?.()
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
  }
}
