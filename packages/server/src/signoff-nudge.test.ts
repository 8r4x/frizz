// THE BUILT-IN SIGN-OFF NUDGE (scheduler SOURCE 9) — frizz's own stop hook, always on and invisible.
//
// It exists to make ONE invariant true: every item in the queue is a question you can answer or a
// checkmark you can archive. So it fires on exactly one thing — a rest that carried NO fence — and on
// nothing else. Every test here is a way that could go wrong: nudging a thread that DID sign off (which
// arrives after a ```done and reads as frizz not having noticed), or nudging one forever (a nag loop
// frizz itself generates).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import { createScheduler } from "./scheduler.ts"

function nudger(tele: Partial<SessionTelemetry>, opts: { setting?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-signoff-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "resting"
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  if (opts.setting) storage.setSetting("signoffNudge", opts.setting)
  const delivered: string[] = []
  const s = createScheduler({
    storage,
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: "2026-08-12T00:00:00.000Z",
        // The AGENT spoke last, which is the shape of a real fenceless rest — and the one thing frizz's
        // own delivery cannot fake, since frizz only ever speaks as the user.
        lastAssistantAt: "2026-08-12T00:00:00.000Z",
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  // THE NUDGE'S OWN DELIVERIES. `delivered` is every wake the scheduler sent, and an awaiting fence
  // frizz cannot honour legitimately draws SOURCE 12's correction on the same rest — so "the nudge held"
  // has to be asked of the nudge's namespace, not of an empty array.
  const nudges = () => storage.db
    .prepare("SELECT message FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE 'signoff:%' AND state = 'delivered'")
    .all(slug) as { message: string }[]
  return { s, storage, slug, delivered, nudges, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("a rest with no fence is told how to sign off, and the text names all three ways", async () => {
  const h = nudger({})
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /```question/)
    assert.match(h.delivered[0], /```done/)
    assert.match(h.delivered[0], /```awaiting/)
    // THE CURRENT FENCE GRAMMAR, not the deleted `watch:` one — this reminder is the last thing many
    // workers read before writing a fence, so a stale example here teaches the wrong syntax to exactly
    // the audience that most needs the right one.
    assert.match(h.delivered[0], /shell: <the id your runtime gave you>/)
    assert.match(h.delivered[0], /for: 2h/)
    assert.match(h.delivered[0], /reason:/)
    assert.doesNotMatch(h.delivered[0], /`watch: <id>`/, "the deleted grammar must not come back")
    // THE GOAL'S VERBIAGE LIVES HERE NOW. A new thread no longer arms the default Goal (2026-08-16) —
    // the bump is the same nudge — so the bump has to carry what the Goal used to say about finishing
    // the work and about deciding rather than asking, or dropping it quietly removed both.
    assert.match(h.delivered[0], /unfinished, unverified, or deferred/)
    assert.match(h.delivered[0], /DECIDE RATHER THAN ASK/)
    // THE TASK IS ALSO THE CEILING. "Keep going" with no upper bound is unbounded by construction —
    // every codebase always has more to do — so a worker forbidden to stop can only stop by widening
    // what it was asked. Traced 2026-08-17 on `investigate-nubjs-nub-642`: dispatched to TRIAGE an
    // issue, it shipped seven commits instead. See DEFAULT_RECURRING_PROMPT for the full account.
    assert.match(h.delivered[0], /FINDING TO REPORT/, "discovered work is reported, not adopted")
    assert.match(h.delivered[0], /THE DOCUMENT IS THE ENDING/, "a triage/review/plan ends with its write-up")
    assert.match(h.delivered[0], /not permission to go build the answer/, "an unanswered question is not a mandate")
    // …and the old copy that made the wrong reading correct must not come back: it listed a written-up
    // plan among the things that are NOT an ending, which for an analysis task denies the deliverable.
    assert.doesNotMatch(h.delivered[0], /a written-up plan and a long turn are none of them endings/)
    // `\s` rather than a literal space: the message is a wrapped array of lines, so this phrase spans a
    // newline and a regex written for one line silently stops pinning anything.
    assert.match(h.delivered[0], /which way you went and\s+what would reverse/)
    // `done` must arrive with its COST attached, or it becomes the cheapest way to stop being nudged —
    // the exact failure the retired ALLDONE warning existed for.
    assert.match(h.delivered[0], /DISMISSAL/)
    // ...and "still owed" has to spell out the cases that read as finished: a RECOMMENDATION whose act
    // the human must perform, an unsent draft, and discovered follow-up that is someone else's to do.
    // Two zod threads fenced `done` on exactly those on 2026-08-16 — see workerPrompt.ts above SIGNALS.
    assert.match(h.delivered[0], /STILL OWED counts things you are not going to do yourself/)
    assert.match(h.delivered[0], /`mcp__frizz__spawn_thread`/)
    assert.match(h.delivered[0], /not\s+worth a card is not worth a SENTENCE/)
    assert.match(h.delivered[0], /the card is the ledger of what shipped/)
    // SELF-CONTAINEDNESS is the point the first version missed: the human has seen nothing since their
    // own last message, and everything in between came from frizz. An agent that does not know that
    // writes a handoff about the last thing it touched.
    assert.match(h.delivered[0], /readable cold/i)
    assert.match(h.delivered[0], /came from\s+frizz/)
    // THE HEADLINE INSTRUCTION: a thread whose handoff already stands alone should answer with the
    // fence and nothing else. Without this the agent restates its whole summary under the reminder and
    // the human reads it twice (maintainer 2026-08-12).
    // THE MENU IS THE SECOND BRANCH, NOT THE FIRST (2026-08-14). This delivery lands on a rest that may
    // simply be premature, and a fence menu handed to a half-finished thread has no correct entry on it —
    // the agent picks the closest, which is `done`, which files the thread away. So the reminder tells it
    // to resume first and only then offers the shapes. The Goal arriving on the same rest says the same
    // thing; two frizz deliveries pulling opposite ways is the failure this pins against.
    assert.match(h.delivered[0], /THE FENCE IS NOT WHAT YOU OWE — THE WORK IS/)
    assert.ok(
      h.delivered[0].indexOf("THE WORK IS") < h.delivered[0].indexOf("```question"),
      "resuming the work is offered BEFORE the fence menu, not as a footnote under it",
    )
    assert.match(h.delivered[0], /none of\s+them endings/, "and the endings a worker mistakes for one are named")
    assert.match(h.delivered[0], /DO NOT REPEAT YOURSELF/)
    assert.match(h.delivered[0], /reply with the\s+fence ALONE/)
    // The 1-3-sentences shape belongs to a `done` BODY and nowhere else — read as general guidance it
    // made an agent omit most of what had happened (maintainer 2026-08-12, with the screenshot).
    // The 1-3-sentence shape belongs to the `done` entry and nowhere else.
    assert.match(h.delivered[0], /done[\s\S]{0,220}1-3 sentences/)
    assert.doesNotMatch(h.delivered[0], /^Keep it SHORT/m)
  } finally { h.close() }
})

// A thread that signed off is not an untriageable item, whichever way it signed off. `awaiting` counts
// too while it still exists — it is a legitimate answer to "where do you stand".
for (const [what, tele] of [
  ["a done fence", { lastFence: { kind: "done" as const, body: "", hints: [] } }],
  ["an awaiting fence", { lastFence: { kind: "awaiting" as const, body: "", hints: [] } }],
  ["a question fence", { pendingQuestion: true }],
  ["a native ask", { pendingAsk: { id: "a1", questions: [] } }],
  ["a permission prompt", { permPrompt: true }],
  ["the legacy ALLDONE sentinel", { lastAssistantAllDone: true }],
] as Array<[string, Partial<SessionTelemetry>]>) {
  test(`${what} is already a sign-off, so nothing is injected`, async () => {
    const h = nudger(tele)
    try {
      await h.s.tick()
      assert.deepEqual(h.nudges(), [])
    } finally { h.close() }
  })
}

// A thread that is still working has not failed to sign off — it has not finished.
test("a busy thread is never nudged", async () => {
  const h = nudger({ turn: "in-flight" })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// ONE PER REST falls out of the delivery id being bound to the rest instant — no counter needed for it.
test("one nudge per rest, however many ticks run over it", async () => {
  const h = nudger({})
  try {
    await h.s.tick()
    await h.s.tick()
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
  } finally { h.close() }
})

// THE LOOP THIS ALMOST SHIPPED WITH. Frizz's own delivery lands as a USER record, so it advances both
// `lastActivityAt` and `lastUserAt`. The first design keyed the delivery id on the former and the cap's
// anchor on the latter, which meant the nudge minted a fresh id for a rest that never happened and reset
// its own counter with its own message: 22 deliveries to one thread in four minutes, measured on a real
// stack (the unit tests all passed, because they drove those fields by hand).
//
// The fix is to ask whether the AGENT spoke last, which nothing frizz says can affect.
test("a thread whose last word is frizz's own nudge is not nudged again", async () => {
  const h = nudger({
    lastAssistantAt: "2026-08-12T00:00:00.000Z",
    lastUserAt: "2026-08-12T00:00:30.000Z", // the delivery landed AFTER the agent's last word
    lastActivityAt: "2026-08-12T00:00:30.000Z",
  })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "the agent has not answered yet — there is nothing new to nudge")
  } finally { h.close() }
})

test("the cap stops a nag loop, and only SIGNING OFF gives the allowance back", async () => {
  let spokeAt = "2026-08-12T00:01:00.000Z"
  let fence: SessionTelemetry["lastFence"]
  const h = nudger({
    lastUserAt: "2026-08-12T00:00:00.000Z",
    get lastAssistantAt() { return spokeAt },
    get lastActivityAt() { return spokeAt },
    get lastFence() { return fence },
  } as Partial<SessionTelemetry>)
  try {
    // Three consecutive fenceless rests by the AGENT; only the first two are nudged.
    await h.s.tick()
    spokeAt = "2026-08-12T00:02:00.000Z"
    await h.s.tick()
    spokeAt = "2026-08-12T00:03:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 2, "capped at 2 consecutive")
    assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 2)

    // A user record does NOT restore it — that is exactly what frizz's own delivery is.
    spokeAt = "2026-08-12T00:04:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 2, "still capped")

    // Signing off does. It is the only event that proves the nudge worked.
    fence = { kind: "done", body: "", hints: [] }
    await h.s.tick()
    assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 0, "the allowance is back")
    fence = undefined
    spokeAt = "2026-08-12T00:05:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 3, "and the next fenceless rest is nudged again")
  } finally { h.close() }
})

// It lands on every live thread at once, so there has to be a way to stop it that is not a code change.
test("the kill switch silences it everywhere", async () => {
  const h = nudger({}, { setting: "off" })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// A SIGNED-OUT PROVIDER answers in milliseconds, so the auth failure is a real assistant message and
// therefore a real rest — which satisfies every other guard. Measured on a live stack: the bump fired
// ten times in a hundred seconds against a thread whose worker could only ever reply "Not logged in".
// Re-prompting cannot help; the thread already cards its auth fault and the sign-in recovery.
test("an auth-faulted thread is never re-prompted — the nudge cannot fix a signed-out provider", async () => {
  const h = nudger({ authFault: "authentication_rejected" } as never)
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// ---- THE TWO-DELIVERY INTERACTION -----------------------------------------------------------------
// Separating the reminder from the Goal (2026-08-12) means a thread WITH a Goal now has two sources
// firing on one fenceless rest. That is only safe because of two properties, and both are worth pinning
// now that they are load-bearing: the deliveries serialise, and a fence supersedes whatever is still
// queued — otherwise an agent that signed off would be handed "keep going" straight afterwards and the
// thread it just closed would reopen.
test("a Goal and the reminder both queue for one rest, and a fence supersedes what is left", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-both-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "both"
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  // An ordinary armed Goal — the stop hook and nothing else, which is what the footer panel arms when an
  // operator flips one switch.
  storage.setRecurringPromptBySlug(slug, {
    prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false,
    intervalMs: null, armedAt: "2026-08-12T00:00:00.000Z",
  })
  let fence: SessionTelemetry["lastFence"]
  const delivered: string[] = []
  const s = createScheduler({
    storage,
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: "2026-08-12T00:01:00.000Z", lastAssistantAt: "2026-08-12T00:01:00.000Z",
        lastUserAt: "2026-08-12T00:00:00.000Z", subAgents: [], bgShells: [],
        pendingQuestion: false, permPrompt: false, lastFence: fence,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  try {
    await s.tick()
    // Both fired for this rest: the operator's words AND frizz's protocol, as separate deliveries.
    assert.equal(delivered.length, 2)
    assert.ok(delivered.some((m) => m.startsWith("keep going")), "the Goal carries the operator's text")
    assert.ok(delivered.some((m) => m.includes("without a fence")), "and the reminder is frizz's own")
    // The reminder no longer carries the protocol twice — the trailer stopped duplicating it.
    const goal = delivered.find((m) => m.startsWith("keep going"))!
    assert.doesNotMatch(goal, /```question/)

    // The agent signs off. Neither source may fire again for this thread, and anything still queued for
    // the old rest is superseded rather than delivered on top of a closed thread.
    fence = { kind: "done", body: "shipped it", hints: [] }
    await s.tick()
    await s.tick()
    assert.equal(delivered.length, 2, "a signed-off thread is not re-prompted by either source")
  } finally { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ---- AND AN ARMED GOAL DOES NOT SWITCH IT OFF -----------------------------------------------------
// It did, for one day (2026-08-13 → 2026-08-14), for the subset of Goals the panel then called Autonomous
// mode — on the reading that this reminder buys a queue A HUMAN triages, and a self-driving thread is the
// operator saying nobody is triaging this one. The switch is gone (2026-08-16) and every Goal is now that
// kind, so the argument would apply to ALL of them if it held. Two facts killed it, and this test is the
// guard against re-deriving it:
//
//   THE REMINDER STOPPED BEING A MENU OF WAYS TO STOP. It now OPENS by sending a half-finished thread back
//   to the work, which is the Goal's own instruction — so the "two deliveries pulling opposite ways" the
//   suppression was built on no longer describes anything.
//
//   IT IS THE ONLY DELIVERY THAT NAMES THE PARK. The Goal's trailer names ```done and deliberately not
//   ```awaiting (see restPromptMessage — a budget decision), so silencing this left the threads most
//   likely to be holding background work with no way to learn how to park on it. Measured over five
//   consecutive bare rests with the suppression in: five Goal bumps, no reminder, the park never
//   mentioned once.
test("an armed Goal does not silence the reminder — both land on one rest", async () => {
  const h = nudger({})
  try {
    // The at-rest trigger driving, which is the exact row the reverted gate keyed on.
    h.storage.setRecurringPromptBySlug(h.slug, {
      prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false,
      intervalMs: null, armedAt: "2026-08-12T00:00:00.000Z",
    })
    await h.s.tick()
    assert.ok(h.delivered.some((m) => m.startsWith("keep going")), "the Goal fires")
    const reminder = h.delivered.find((m) => m.includes("without a fence"))
    assert.ok(reminder, "and so does the reminder")
    // The park is the thing the Goal's trailer cannot supply, so it is what the assertion is really
    // about. Matched on the FENCE rather than on whatever tool registers it, so a change to the
    // registration mechanism cannot silently turn this into a test of nothing.
    assert.match(reminder, /```awaiting/)
  } finally { h.close() }
})
