import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardManager } from "./board.ts"
import type { SessionRow, Storage } from "./storage.ts"
import {
  composerAccountedBy,
  decideSubmit,
  createDeliveryConfirmer,
  SUBMIT_GRACE_MS,
  MAX_SUBMIT_ATTEMPTS,
  type DeliveryConfirmTerminal,
} from "./delivery-confirm.ts"
import { serializeDeliveryLedger, type DeliveryLedgerItem } from "./delivery-ledger.ts"
import type { ClaudeComposerState } from "./permission-controller.ts"

const T0 = Date.parse("2026-07-23T12:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()

const item = (over: Partial<DeliveryLedgerItem> = {}): DeliveryLedgerItem => ({
  id: "d-1",
  text: "please fix the failing test",
  state: "pending",
  at: iso(T0),
  updatedAt: iso(T0),
  ...over,
})

const typed = (text: string): ClaudeComposerState => ({ kind: "typed", text })

// ───────────────────────── composerAccountedBy — the "never touch a human draft" core ────────────
// This is the single function that decides whether the pane's CURRENT contents are entirely fray's
// own outstanding sends. A null answer means "keep your hands off this composer".

test("composerAccountedBy: an exact single-item composer is accounted for", () => {
  assert.deepEqual(composerAccountedBy("please fix the failing test", [{ index: 0, text: "please fix the failing test" }]), [0])
})

test("composerAccountedBy: an empty composer is never ours", () => {
  assert.equal(composerAccountedBy("", [{ index: 0, text: "anything" }]), null)
  assert.equal(composerAccountedBy("   \n  ", [{ index: 0, text: "anything" }]), null)
})

test("composerAccountedBy: whitespace/soft-wrap differences do not defeat the match", () => {
  // The pane may soft-wrap or re-space the text; squash() removes ALL whitespace before comparing.
  assert.deepEqual(
    composerAccountedBy("please  fix\n the   failing\ttest", [{ index: 0, text: "please fix the failing test" }]),
    [0],
  )
})

test("composerAccountedBy: two sends concatenated (the swallow bug) are both accounted for", () => {
  // Claude Code writes ONE record whose text is the concatenation of the two sends the TUI glued.
  assert.deepEqual(
    composerAccountedBy("first followupsecond followup", [
      { index: 0, text: "first followup" },
      { index: 1, text: "second followup" },
    ]),
    [0, 1],
  )
})

test("composerAccountedBy: composition skips an item that already landed", () => {
  // Candidate 0 already landed (not in the composer); only candidate 1's text is present. The loop
  // skips 0 and consumes 1 — a landed send must not block accounting for the one still sitting there.
  assert.deepEqual(
    composerAccountedBy("second followup", [
      { index: 0, text: "first followup" },
      { index: 1, text: "second followup" },
    ]),
    [1],
  )
})

test("composerAccountedBy: a human PREFIX draft leaves the composer unaccounted (null)", () => {
  // The operator typed text BEFORE fray's — the composer no longer starts with any candidate, so it
  // is declined. This is the guarantee that fray never submits the human's own draft.
  assert.equal(
    composerAccountedBy("my own thought please fix the failing test", [{ index: 0, text: "please fix the failing test" }]),
    null,
  )
})

test("composerAccountedBy: a human SUFFIX draft leaves an unconsumed remainder (null)", () => {
  // fray's text is consumed, but the operator's trailing characters remain — declined.
  assert.equal(
    composerAccountedBy("please fix the failing test and also the linter", [{ index: 0, text: "please fix the failing test" }]),
    null,
  )
})

test("composerAccountedBy: a human draft BETWEEN two sends is declined", () => {
  assert.equal(
    composerAccountedBy("first followupHUMANsecond followup", [
      { index: 0, text: "first followup" },
      { index: 1, text: "second followup" },
    ]),
    null,
  )
})

test("composerAccountedBy: an opaque paste chip is never ours", () => {
  // Claude Code collapses a big paste into `[Pasted text #N +M lines]`. It is unverifiable, so refuse.
  assert.equal(composerAccountedBy("[Pasted text #3 +48 lines]", [{ index: 0, text: "please fix the failing test" }]), null)
  assert.equal(
    composerAccountedBy("please fix the failing test [Pasted text #1]", [{ index: 0, text: "please fix the failing test" }]),
    null,
  )
})

// ───────────────────────── decideSubmit — the whole decision as a pure function ───────────────────

test("decideSubmit: a non-typed composer (empty/unavailable) is always idle", () => {
  assert.deepEqual(decideSubmit({ kind: "empty" }, [item()], T0 + SUBMIT_GRACE_MS + 1), { kind: "idle" })
  assert.deepEqual(decideSubmit({ kind: "unavailable" }, [item()], T0 + SUBMIT_GRACE_MS + 1), { kind: "idle" })
})

test("decideSubmit: a matching outstanding send past the grace window is a resend", () => {
  const d = decideSubmit(typed("please fix the failing test"), [item()], T0 + SUBMIT_GRACE_MS + 1)
  assert.deepEqual(d, { kind: "resend", items: [0] })
})

test("decideSubmit: a send still inside the grace window is left alone", () => {
  // The TUI is legitimately still ingesting the fresh bracketed paste — do not re-press yet.
  assert.deepEqual(decideSubmit(typed("please fix the failing test"), [item()], T0 + SUBMIT_GRACE_MS - 1), { kind: "idle" })
})

test("decideSubmit: an 'enqueued' item is excluded — a receipted send is not in the composer", () => {
  // Claude Code positively receipted the send into its own queue; the composer text that happens to
  // equal it must NOT be treated as an unsent draft to re-press.
  assert.deepEqual(
    decideSubmit(typed("please fix the failing test"), [item({ state: "enqueued" })], T0 + SUBMIT_GRACE_MS + 1),
    { kind: "idle" },
  )
})

test("decideSubmit: at MAX attempts the decision escalates to exhausted, not another press", () => {
  const d = decideSubmit(
    typed("please fix the failing test"),
    [item({ submitAttempts: MAX_SUBMIT_ATTEMPTS })],
    T0 + SUBMIT_GRACE_MS + 1,
  )
  assert.deepEqual(d, { kind: "exhausted", items: [0] })
})

test("decideSubmit: a composer holding a human draft is idle even with an outstanding send", () => {
  assert.deepEqual(
    decideSubmit(typed("something else entirely"), [item()], T0 + SUBMIT_GRACE_MS + 1),
    { kind: "idle" },
  )
})

// ───────────────────────── the confirmer tick, against fake storage + terminal ────────────────────
// Builds the smallest real path: allSessions → candidate filter → capture → decideSubmit → ledger
// write + a BARE Enter. The terminal only exposes sendKey("Enter") — there is no text-injection door,
// which is the structural reason a re-press can never deliver a second copy of the message.

// A pane string inspectClaudeComposer parses as a typed composer holding `text` (or empty when blank).
const pane = (text: string) => `scrollback line\n❯ ${text}\n${"─".repeat(30)}\n`

interface FakeRow {
  slug: string
  session_id: string
  backend: string
  codex_runtime: string | null
  delivery_ledger: string | null
  runtime_generation: number
}

const row = (over: Partial<FakeRow> = {}): SessionRow =>
  ({
    slug: "thread-a",
    session_id: "sess-1",
    backend: "claude",
    codex_runtime: null,
    delivery_ledger: serializeDeliveryLedger([item({ at: iso(T0 - SUBMIT_GRACE_MS - 5_000) })]),
    runtime_generation: 0,
    ...over,
  }) as unknown as SessionRow

function harness(opts: {
  rows: SessionRow[]
  getSession?: (slug: string) => SessionRow | undefined
  captureThrows?: boolean
  paneFor?: (r: SessionRow) => string | undefined
  now?: number
}) {
  const keys: { slug: string; key: string }[] = []
  const writes: { slug: string; ledger: string | null }[] = []
  const captured: string[] = []
  let refreshes = 0
  const bySlug = new Map(opts.rows.map((r) => [r.slug, r]))
  const storage = {
    allSessions: () => opts.rows,
    getSession: opts.getSession ?? ((slug: string) => bySlug.get(slug)),
    getAdoptionClaim: () => undefined,
    setDeliveryLedger: (slug: string, ledger: string | null) => writes.push({ slug, ledger }),
  } as unknown as Storage
  const board = { refresh: () => { refreshes++ } } as unknown as BoardManager
  const terminal: DeliveryConfirmTerminal = {
    capturePanes: (slugs) => {
      captured.push(...slugs)
      if (opts.captureThrows) throw new Error("tmux unreachable")
      const m = new Map<string, string>()
      for (const slug of slugs) {
        const r = bySlug.get(slug)
        const text = r ? (opts.paneFor ? opts.paneFor(r) : r.delivery_ledger ? pane(item().text) : undefined) : undefined
        if (text !== undefined) m.set(slug, text)
      }
      return m
    },
    sendKey: (slug, key) => { keys.push({ slug, key }) },
    findExpectedAdoptionPane: () => ({ kind: "absent" }) as never,
    captureExpectedAdoptionPane: () => ({ kind: "unavailable" }) as never,
    sendKeyToExpectedAdoptionPane: () => false,
  }
  const confirmer = createDeliveryConfirmer({ storage, board, terminal, now: () => opts.now ?? T0 })
  return { confirmer, keys, writes, captured, refreshes: () => refreshes }
}

test("tick: presses ONE bare Enter for a claude row whose composer still holds fray's own send", () => {
  const h = harness({ rows: [row()] })
  h.confirmer.tick()
  assert.equal(h.keys.length, 1, "exactly one key press")
  assert.deepEqual(h.keys[0], { slug: "thread-a", key: "Enter" }, "and it is a BARE Enter — no text re-injected")
  // submitAttempts was incremented and persisted BEFORE the press.
  assert.equal(h.writes.length, 1)
  const persisted = JSON.parse(h.writes[0].ledger ?? "[]") as DeliveryLedgerItem[]
  assert.equal(persisted[0].submitAttempts, 1)
})

test("tick: a human draft in the composer is never submitted", () => {
  // The pane holds a human draft that merely CONTAINS fray's text — one extra char must decline it.
  const h = harness({ rows: [row()], paneFor: () => pane("wait, actually " + item().text + " but carefully") })
  h.confirmer.tick()
  assert.equal(h.keys.length, 0, "no Enter pressed on a human draft")
  assert.equal(h.writes.length, 0, "and the ledger is untouched")
})

test("tick: a codex row is skipped entirely — no capture, no press", () => {
  const h = harness({ rows: [row({ slug: "codex-thread", backend: "codex" })] })
  h.confirmer.tick()
  assert.deepEqual(h.captured, [], "no pane was captured for a codex row")
  assert.equal(h.keys.length, 0)
})

test("tick: an app-server codex row (headless, no composer) is skipped", () => {
  const h = harness({ rows: [row({ slug: "codex-app", backend: "codex", codex_runtime: "app-server" })] })
  h.confirmer.tick()
  assert.deepEqual(h.captured, [], "no pane was captured for a headless app-server codex row")
  assert.equal(h.keys.length, 0)
})

test("tick: tmux unreachable this tick — no evidence, no action", () => {
  const h = harness({ rows: [row()], captureThrows: true })
  h.confirmer.tick()
  assert.equal(h.keys.length, 0, "no press when the pane could not be captured")
  assert.equal(h.writes.length, 0)
})

test("tick: at MAX attempts the item is aged to unconfirmed and NOT pressed again", () => {
  const h = harness({
    rows: [row({
      delivery_ledger: serializeDeliveryLedger([
        item({ at: iso(T0 - SUBMIT_GRACE_MS - 5_000), submitAttempts: MAX_SUBMIT_ATTEMPTS }),
      ]),
    })],
  })
  h.confirmer.tick()
  assert.equal(h.keys.length, 0, "exhausted: no more Enter presses")
  assert.equal(h.writes.length, 1, "the ledger was rewritten")
  const persisted = JSON.parse(h.writes[0].ledger ?? "[]") as DeliveryLedgerItem[]
  assert.equal(persisted[0].state, "unconfirmed", "the item is surfaced as unconfirmed for the operator")
})

test("tick: a ledger the tailer replaced under us is not written back over", () => {
  // allSessions yields the ledger the tick started from; the re-read (getSession) returns a DIFFERENT
  // ledger — the tailer folded a new record. The decision made against the stale copy must be dropped.
  const started = row()
  const replaced = row({ delivery_ledger: serializeDeliveryLedger([item({ id: "d-2", text: "totally different" })]) })
  const h = harness({
    rows: [started],
    getSession: () => replaced, // both the binding read and the re-read see the replaced ledger
    paneFor: () => pane(item().text),
  })
  h.confirmer.tick()
  assert.equal(h.keys.length, 0, "no press once the ledger changed underneath the tick")
  assert.equal(h.writes.length, 0, "and nothing was written back over the tailer's newer ledger")
})

test("tick: a resting board with no outstanding steer spends ZERO tmux calls", () => {
  const h = harness({ rows: [row({ delivery_ledger: null })] })
  h.confirmer.tick()
  assert.deepEqual(h.captured, [], "candidateRows filtered it out before any capture")
})
