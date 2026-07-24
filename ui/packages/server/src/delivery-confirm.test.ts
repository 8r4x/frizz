import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDeliveryConfirmer,
  composerAccountedBy,
  decideSubmit,
  MAX_SUBMIT_ATTEMPTS,
  SUBMIT_GRACE_MS,
  type DeliveryConfirmTerminal,
} from "./delivery-confirm.ts"
import { inspectClaudeComposer } from "./permission-controller.ts"
import { parseDeliveryLedger, serializeDeliveryLedger, type DeliveryLedgerItem } from "./delivery-ledger.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import type { BoardManager } from "./board.ts"

const T0 = Date.parse("2026-07-23T12:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()
const item = (over: Partial<DeliveryLedgerItem> = {}): DeliveryLedgerItem => ({
  id: "d-1",
  text: "please rerun the failing test",
  state: "pending",
  at: iso(T0),
  updatedAt: iso(T0),
  ...over,
})

// A real Claude composer region: the last `❯` row, wrapped continuation lines, the footer divider, and
// an idle footer. Modeled on captures taken from a live claude 2.1.218 pane.
const pane = (composer: string) =>
  `assistant output above\n────────\n❯ ${composer}\n────────\n  proj · Haiku 4.5\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `sid-${slug}`,
    tmux_name: `fray-${slug}`,
    spawned_at: "2026-07-23T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: slug,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    permission_mode: "default",
    permission_pending: null,
    backend: "claude",
    ...over,
  }
}

// ── composerAccountedBy: the gate that decides whether the pane is fray's to submit ────────────────

test("a composer that is exactly our one outstanding send is accounted for", () => {
  assert.deepEqual(composerAccountedBy("please rerun the failing test", [{ index: 0, text: "please rerun the failing test" }]), [0])
})

test("pane soft-wrapping cannot break the identity (whitespace is not compared)", () => {
  // inspectClaudeComposer joins the composer's wrapped rows with a space; the sent text had none there.
  assert.deepEqual(
    composerAccountedBy("please rerun the failing te st", [{ index: 0, text: "please rerun the failing test" }]),
    [0],
  )
})

test("two swallowed sends that the composer glued together are both accounted for", () => {
  const candidates = [{ index: 0, text: "first follow-up" }, { index: 1, text: "second follow-up" }]
  assert.deepEqual(composerAccountedBy("first follow-up second follow-up", candidates), [0, 1])
  // …and with the literal newline the swallowed Enter itself inserted between them.
  assert.deepEqual(composerAccountedBy("first follow-up\nsecond follow-up", candidates), [0, 1])
})

test("an item that already landed is skipped, not required", () => {
  const candidates = [{ index: 0, text: "already submitted" }, { index: 1, text: "still stuck here" }]
  assert.deepEqual(composerAccountedBy("still stuck here", candidates), [1])
})

test("ONE extra character the operator typed disqualifies the whole composer", () => {
  const candidates = [{ index: 0, text: "please rerun the failing test" }]
  assert.equal(composerAccountedBy("please rerun the failing test!", candidates), null)
  assert.equal(composerAccountedBy("wait — please rerun the failing test", candidates), null)
  assert.equal(composerAccountedBy("please rerun the failing", candidates), null)
})

test("a human draft that shares no text with ours is never accounted for", () => {
  assert.equal(composerAccountedBy("actually hold on, I'll do it myself", [{ index: 0, text: "please rerun the failing test" }]), null)
})

test("Claude Code's opaque paste chip is never accounted for", () => {
  // A big/multi-line paste renders as a chip instead of the text, so its content is unverifiable.
  const candidates = [{ index: 0, text: "a\nvery\nlong\nfollow\nup\nmessage\nwith\nmany\nlines" }]
  assert.equal(composerAccountedBy("[Pasted text #1 +8 lines]", candidates), null)
  assert.equal(composerAccountedBy("[Pasted text #1]", candidates), null)
  assert.equal(composerAccountedBy("please rerun the failing test [Pasted text #2 +3 lines]",
    [{ index: 0, text: "please rerun the failing test" }]), null)
})

// ── decideSubmit: the full decision ───────────────────────────────────────────────────────────────

test("an EMPTY composer is idle — the first Enter landed, so nothing is pressed", () => {
  assert.deepEqual(decideSubmit(inspectClaudeComposer(pane("")), [item()], T0 + 10_000), { kind: "idle" })
})

test("an unreadable pane never presses a key", () => {
  assert.deepEqual(decideSubmit(inspectClaudeComposer("no composer here at all"), [item()], T0 + 10_000), { kind: "idle" })
})

test("a send younger than the grace window is left alone (the TUI is still ingesting the paste)", () => {
  const composer = inspectClaudeComposer(pane("please rerun the failing test"))
  assert.deepEqual(decideSubmit(composer, [item()], T0 + SUBMIT_GRACE_MS - 1), { kind: "idle" })
  assert.deepEqual(decideSubmit(composer, [item()], T0 + SUBMIT_GRACE_MS), { kind: "resend", items: [0] })
})

test("an ENQUEUED item can never account for composer text (it is receipted, not sitting there)", () => {
  const composer = inspectClaudeComposer(pane("please rerun the failing test"))
  assert.deepEqual(decideSubmit(composer, [item({ state: "enqueued" })], T0 + 10_000), { kind: "idle" })
})

test("retries are bounded, then the failure is surfaced instead of pressed forever", () => {
  const composer = inspectClaudeComposer(pane("please rerun the failing test"))
  for (let attempts = 0; attempts < MAX_SUBMIT_ATTEMPTS; attempts++) {
    assert.deepEqual(decideSubmit(composer, [item({ submitAttempts: attempts })], T0 + 10_000), { kind: "resend", items: [0] })
  }
  assert.deepEqual(
    decideSubmit(composer, [item({ submitAttempts: MAX_SUBMIT_ATTEMPTS })], T0 + 10_000),
    { kind: "exhausted", items: [0] },
  )
})

// ── the controller, against real storage ──────────────────────────────────────────────────────────

function harness() {
  const storage: Storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-delivery-confirm-")), "ui.db"))
  const panes = new Map<string, string>()
  const keys: string[] = []
  let clock = T0
  const captured: string[][] = []
  const terminal: DeliveryConfirmTerminal = {
    capturePanes: (slugs) => {
      captured.push([...slugs])
      const out = new Map<string, string>()
      for (const slug of slugs) { const text = panes.get(slug); if (text !== undefined) out.set(slug, text) }
      return out
    },
    sendKey: (slug, key) => void keys.push(`${slug}:${key}`),
    findExpectedAdoptionPane: () => ({ kind: "absent" }),
    captureExpectedAdoptionPane: () => ({ kind: "unavailable" }),
    sendKeyToExpectedAdoptionPane: () => true,
  }
  let refreshes = 0
  const board = { refresh: () => void refreshes++ } as unknown as BoardManager
  const confirmer = createDeliveryConfirmer({ storage, board, terminal, now: () => clock })
  return {
    storage, panes, keys, captured, confirmer,
    refreshes: () => refreshes,
    advance: (ms: number) => { clock += ms },
    ledger: (slug: string) => parseDeliveryLedger(storage.getSession(slug)?.delivery_ledger ?? null),
    seed(slug: string, items: DeliveryLedgerItem[], over: Partial<SessionRow> = {}) {
      storage.upsertSession(row(slug, over))
      // `backend` is not part of the upsert's column list — it has its own writer.
      if (over.backend) storage.setBackend(slug, over.backend)
      storage.setDeliveryLedger(slug, serializeDeliveryLedger(items))
    },
  }
}

test("a swallowed follow-up gets ONE bare Enter, and the attempt is recorded", () => {
  const h = harness()
  h.seed("stuck", [item()])
  h.panes.set("stuck", pane("please rerun the failing test"))
  h.advance(SUBMIT_GRACE_MS)
  h.confirmer.tick()
  assert.deepEqual(h.keys, ["stuck:Enter"], "exactly one bare Enter — the text is never re-sent")
  assert.equal(h.ledger("stuck")[0].submitAttempts, 1)
})

test("a landed follow-up presses NOTHING — the double-send that would duplicate it never happens", () => {
  const h = harness()
  h.seed("landed", [item()])
  // Claude Code cleared the composer on submit; the JSONL evidence just hasn't been folded yet.
  h.panes.set("landed", pane(""))
  h.advance(SUBMIT_GRACE_MS + 60_000)
  h.confirmer.tick()
  h.confirmer.tick()
  h.confirmer.tick()
  assert.deepEqual(h.keys, [])
  assert.equal(h.ledger("landed")[0].submitAttempts, undefined)
})

test("a human's draft in the pane is never submitted", () => {
  const h = harness()
  h.seed("human", [item()])
  h.panes.set("human", pane("please rerun the failing test and also check the lockfile"))
  h.advance(SUBMIT_GRACE_MS + 60_000)
  h.confirmer.tick()
  assert.deepEqual(h.keys, [], "our text is in there, but the operator added to it — hands off")
})

test("retries stop at the bound and the item is surfaced as unconfirmed", () => {
  const h = harness()
  h.seed("wedged", [item()])
  h.panes.set("wedged", pane("please rerun the failing test"))
  h.advance(SUBMIT_GRACE_MS)
  for (let i = 0; i < MAX_SUBMIT_ATTEMPTS + 3; i++) h.confirmer.tick()
  assert.equal(h.keys.length, MAX_SUBMIT_ATTEMPTS, "bounded — a permanently wedged composer is not hammered")
  assert.equal(h.ledger("wedged")[0].state, "unconfirmed", "the operator is told, rather than left waiting")
})

test("a board with no outstanding send spends ZERO tmux calls", () => {
  const h = harness()
  h.storage.upsertSession(row("quiet"))
  h.confirmer.tick()
  assert.deepEqual(h.captured, [], "no ledger, no capture — this must not become a per-tick tax")
})

test("codex rows are never inspected — the app-server bridge owns their delivery", () => {
  const h = harness()
  h.seed("cdx", [item()], { backend: "codex" })
  h.panes.set("cdx", pane("please rerun the failing test"))
  h.advance(SUBMIT_GRACE_MS + 60_000)
  h.confirmer.tick()
  assert.deepEqual(h.captured, [])
  assert.deepEqual(h.keys, [])
})

test("every candidate row is captured in ONE batched call, never one capture per thread", () => {
  const h = harness()
  for (const slug of ["a", "b", "c"]) {
    h.seed(slug, [item({ id: `d-${slug}` })])
    h.panes.set(slug, pane("please rerun the failing test"))
  }
  h.advance(SUBMIT_GRACE_MS)
  h.confirmer.tick()
  assert.equal(h.captured.length, 1, "one tmux exec for the whole board")
  assert.deepEqual(h.captured[0].sort(), ["a", "b", "c"])
  assert.deepEqual(h.keys.sort(), ["a:Enter", "b:Enter", "c:Enter"])
})

test("two glued sends are submitted by one Enter, and both record the attempt", () => {
  const h = harness()
  h.seed("glued", [item({ id: "d-1", text: "first follow-up" }), item({ id: "d-2", text: "second follow-up" })])
  h.panes.set("glued", pane("first follow-up second follow-up"))
  h.advance(SUBMIT_GRACE_MS)
  h.confirmer.tick()
  assert.deepEqual(h.keys, ["glued:Enter"])
  assert.deepEqual(h.ledger("glued").map((i) => i.submitAttempts), [1, 1])
})
