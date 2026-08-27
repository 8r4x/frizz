// THE QUESTION REGISTRY at the RPC boundary — the real router against real SQLite.
//
// `mcp__frizz__ask` registers a question the human owes an answer to, so that asking stops being a
// fenced block with the lifetime of the message carrying it (plans/rest-by-registration.md). The
// tailer recomputes `pendingQuestion` from the LATEST assistant text on every assistant record
// (`lastAssistantHasQuestion = hasQuestionBlock(raw)` — an assignment, not an OR) and clears it on any
// human turn, so a worker that asks and then says one more sentence has silently un-asked. A row does
// not do that, and these tests are about the ways a question could still go missing.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AskedQuestion, BoardSnapshot, Settings } from "@frizz/shared"
import { ASK_MAX_OPEN, questionAnswerMessage } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-ask-rpc-"))
  const project: Project = { dir, id: "ask", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"))
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0,
    rebuild: async () => snapshot,
    refresh: () => { refreshes++; return snapshot },
    start: async () => {},
    stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => undefined, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const ctx = {
    project, storage, board, tailer,
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
  } as unknown as AppContext
  return {
    storage,
    router: createRouter(ctx),
    refreshes: () => refreshes,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-08-26T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

const simple = (question = "SQLite or a JSON file?"): AskedQuestion => ({
  question,
  kind: "question",
  options: [
    { label: "SQLite — transactional, matches how sessions are already stored", recommended: true },
    { label: "JSON file — zero deps, human-editable, racy under concurrent writes" },
  ],
})

test("ask registers a question, mints its id, and reads back the whole open set", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const result = await h.router.ask.handler({ input: { slug: "t", questions: [simple()] } })
    assert.equal(result.registered.length, 1)
    assert.match(result.registered[0].id, /^qst_[0-9a-f]{12}$/)
    // THE WORKER NEVER CHOSE THE ID — frizz minted it — which is exactly why the answer restates the
    // question text later on: an id alone cannot be correlated back to anything the worker wrote.
    assert.deepEqual(result.open.map((q) => q.id), [result.registered[0].id])
    assert.deepEqual(result.open[0].spec, simple())
    assert.equal(h.refreshes() > 0, true, "the board must re-derive: an open question is a queue member")
  } finally { h.close() }
})

test("registering the same question twice is TWO questions, unlike a watch", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.ask.handler({ input: { slug: "t", questions: [simple()] } })
    const again = await h.router.ask.handler({ input: { slug: "t", questions: [simple()] } })
    // Two identically-worded questions are two things the human owes an answer to. Collapsing them the
    // way an idempotent watch collapses a re-registration would silently drop one.
    assert.equal(again.open.length, 2)
    assert.notEqual(again.open[0].id, again.open[1].id)
  } finally { h.close() }
})

test("a malformed tree is REFUSED with the fault named, and nothing is stored", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    // A `multi` with no options renders as a plain free-text box — SILENTLY, so the worker never learns
    // its multi-select did nothing. A shape zod accepts can still be a question nobody can answer.
    await assert.rejects(
      () => h.router.ask.handler({ input: { slug: "t", questions: [{ question: "Which?", kind: "multi" }] } }),
      /needs options/,
    )
    // "Recommended" means nothing when it is on two of three choices.
    await assert.rejects(
      () => h.router.ask.handler({ input: { slug: "t", questions: [{
        question: "Which?", kind: "question",
        options: [{ label: "A", recommended: true }, { label: "B", recommended: true }],
      }] } }),
      /only ONE option may be/,
    )
    // A follow-up hangs off the option TAKEN, so a multi-select cannot carry one: several picked options
    // would open several branches at once, and the tree stops being static.
    await assert.rejects(
      () => h.router.ask.handler({ input: { slug: "t", questions: [{
        question: "Which?", kind: "multi",
        options: [{ label: "A", followUps: [{ question: "And then?", kind: "question", options: [{ label: "x" }] }] }, { label: "B" }],
      }] } }),
      /cannot carry follow-ups/,
    )
    assert.deepEqual(h.storage.listThreadQuestions("t"), [])
  } finally { h.close() }
})

test("a follow-up tree deeper than three levels is refused", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const leaf: AskedQuestion = { question: "L4", kind: "question", options: [{ label: "x" }] }
    const l3: AskedQuestion = { question: "L3", kind: "question", options: [{ label: "x", followUps: [leaf] }] }
    const l2: AskedQuestion = { question: "L2", kind: "question", options: [{ label: "x", followUps: [l3] }] }
    const l1: AskedQuestion = { question: "L1", kind: "question", options: [{ label: "x", followUps: [l2] }] }
    // Three levels is a question, a follow-up on the option taken, and one more. Past that the human is
    // filling in a form rather than answering, and the worker should be deciding the rest itself.
    await assert.rejects(() => h.router.ask.handler({ input: { slug: "t", questions: [l1] } }), /the limit is 3/)
    const ok = await h.router.ask.handler({ input: { slug: "t", questions: [l2] } })
    assert.equal(ok.registered.length, 1, "exactly three levels is fine")
  } finally { h.close() }
})

test("the open set is bounded, and an archived thread refuses outright", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    for (let i = 0; i < ASK_MAX_OPEN; i++) {
      await h.router.ask.handler({ input: { slug: "t", questions: [simple(`Q${i}?`)] } })
    }
    // A worker holding more than this outstanding is not asking, it is refusing to decide.
    await assert.rejects(
      () => h.router.ask.handler({ input: { slug: "t", questions: [simple("one more?")] } }),
      new RegExp(`the limit is ${ASK_MAX_OPEN}`),
    )

    h.storage.upsertSession(row("gone", { state: "archived", archived: 1 }))
    await assert.rejects(
      () => h.router.ask.handler({ input: { slug: "gone", questions: [simple()] } }),
      /Reopen this thread/,
    )
  } finally { h.close() }
})

test("unask is the worker's own withdrawal, scoped to its thread", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.upsertSession(row("other"))
    const { registered } = await h.router.ask.handler({ input: { slug: "t", questions: [simple()] } })
    const id = registered[0].id

    const foreign = await h.router.unask.handler({ input: { slug: "other", id } })
    assert.equal(foreign.withdrawn, false, "another thread cannot withdraw it")
    assert.equal(h.storage.getThreadQuestion(id)?.state, "open")

    const own = await h.router.unask.handler({ input: { slug: "t", id } })
    assert.equal(own.withdrawn, true)
    assert.deepEqual(own.open, [])
    assert.equal(h.storage.getThreadQuestion(id)?.state, "withdrawn")
    assert.equal((await h.router.unask.handler({ input: { slug: "t", id } })).withdrawn, false, "and not repeatable")
  } finally { h.close() }
})

test("answering stores the answer WITHOUT delivering it, and leaves the row for the waker", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const { registered } = await h.router.ask.handler({ input: { slug: "t", questions: [simple(), simple("Ship it?")] } })
    const [a, b] = registered

    const result = await h.router.answerQuestions.handler({ input: { slug: "t", answers: [
      { questionId: a.id, question: a.spec.question, chosen: ["SQLite"] },
      { questionId: b.id, question: b.spec.question, chosen: [], text: "not yet" },
    ] } })
    assert.deepEqual(result.answered.sort(), [a.id, b.id].sort())
    assert.deepEqual(result.open, [])
    // ANSWERING IS NOT DELIVERING: an answer given while the worker's process was down has to survive
    // the gap, or it is lost in the same silence the fence used to lose the QUESTION in.
    assert.deepEqual(h.storage.undeliveredAnswers().map((q) => q.id).sort(), [a.id, b.id].sort())
    assert.equal(h.storage.getThreadQuestion(a.id)?.delivered, 0)

    // An id belonging to another thread answers nothing, and an already-settled one is silently absent
    // rather than an error — two browser tabs answering the same card is a race nobody should see.
    h.storage.upsertSession(row("other"))
    const again = await h.router.answerQuestions.handler({ input: { slug: "other", answers: [
      { questionId: a.id, question: "x", chosen: ["JSON"] },
    ] } })
    assert.deepEqual(again.answered, [])
    assert.equal(JSON.parse(h.storage.getThreadQuestion(a.id)!.answer!).chosen[0], "SQLite")
  } finally { h.close() }
})

test("the × dismisses an ordinary question and CANNOT reach a danger-tagged one", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const danger: AskedQuestion = {
      question: "Force-push over the rewritten history?",
      kind: "question", danger: true,
      options: [{ label: "Force-push it" }, { label: "Leave it — reopen the branch instead" }],
    }
    const { registered } = await h.router.ask.handler({ input: { slug: "t", questions: [simple(), danger] } })
    const [ordinary, irreversible] = registered

    const result = await h.router.dismissQuestions.handler({ input: { slug: "t", ids: [ordinary.id, irreversible.id] } })
    // A generic close icon is not consent for something irreversible. Declining is a real option INSIDE
    // the question, so the danger row stays open and the ordinary one goes.
    assert.deepEqual(result.dismissed, [ordinary.id])
    assert.deepEqual(result.open.map((q) => q.id), [irreversible.id])
    assert.equal(h.storage.getThreadQuestion(ordinary.id)?.state, "dismissed")
    assert.equal(h.storage.getThreadQuestion(irreversible.id)?.state, "open")
    // A dismissal settles WITHOUT an answer, so there is nothing to hand the worker.
    assert.deepEqual(h.storage.undeliveredAnswers(), [])
  } finally { h.close() }
})

test("the answer message restates each question and carries the dismissals along", () => {
  // The worker never saw an id, so `{id: choice}` would be unreadable to it. And a dismissal RIDES the
  // next message rather than waking anybody: the human dismissing questions is almost always dismissing
  // several in a row and is sitting right there, so a wake per × would be a turn per click.
  const message = questionAnswerMessage([
    {
      questionId: "qst_a", question: "SQLite or a JSON file?", chosen: ["SQLite"],
      followUps: [{ questionId: "qst_b", question: "Migrate the existing rows?", chosen: ["Yes, at boot"] }],
    },
  ], ["qst_c", "qst_d"])
  assert.match(message, /“SQLite or a JSON file\?” → SQLite/)
  assert.match(message, /^ {2}- “Migrate the existing rows\?” → Yes, at boot$/m, "a follow-up is indented under the option that opened it")
  assert.match(message, /2 other questions were DISMISSED without an answer/)
  assert.match(message, /Do not re-ask\./)
})
