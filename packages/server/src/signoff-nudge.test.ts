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
  return { s, storage, slug, delivered, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("a rest with no fence is told how to sign off, and the text names all three ways", async () => {
  const h = nudger({})
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /```question/)
    assert.match(h.delivered[0], /```done/)
    assert.match(h.delivered[0], /mcp__frizz__watch/)
    // `done` must arrive with its COST attached, or it becomes the cheapest way to stop being nudged —
    // the exact failure the retired ALLDONE warning existed for.
    assert.match(h.delivered[0], /DISMISSAL/)
    // SELF-CONTAINEDNESS is the point the first version missed: the human has seen nothing since their
    // own last message, and everything in between came from frizz. An agent that does not know that
    // writes a handoff about the last thing it touched.
    assert.match(h.delivered[0], /read cold/i)
    assert.match(h.delivered[0], /came from frizz/)
    // The 1-3-sentences shape belongs to a `done` BODY and nowhere else — read as general guidance it
    // made an agent omit most of what had happened (maintainer 2026-08-12, with the screenshot).
    assert.match(h.delivered[0], /brevity is a RULE is a[\s\S]{0,20}done/)
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
      assert.deepEqual(h.delivered, [])
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
