import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { wakeDeliveryToken } from "@frizz/shared"
import { createStorage, type Storage, type SessionRow } from "./storage.ts"
import { createScheduler, parsePrRef, ghPrViewArgs, evalRollup, parseGithubReviewActivities, isBotGithubActor, type GithubReviewActivity, type PrRef, type PrStatus } from "./scheduler.ts"
import { createGithubReviewFetcher } from "./github-review.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"
import type { Tailer, SessionTelemetry, FenceView, TurnState } from "./tailer.ts"

// ---- pure helpers ----

test("parsePrRef: owner/repo#N, PR URLs, .git strip; garbage → undefined", () => {
  assert.deepEqual(parsePrRef("acme/app#391"), { owner: "acme", repo: "app", number: 391 })
  assert.deepEqual(parsePrRef("  acme/app#391  "), { owner: "acme", repo: "app", number: 391 })
  assert.deepEqual(parsePrRef("https://github.com/acme/app/pull/391"), { owner: "acme", repo: "app", number: 391 })
  assert.deepEqual(parsePrRef("acme/app.git#12"), { owner: "acme", repo: "app", number: 12 })
  assert.equal(parsePrRef("not a ref"), undefined)
  assert.equal(parsePrRef("acme/app#0"), undefined)
  // an actions-run URL carries no PR number → not a PR ref
  assert.equal(parsePrRef("https://github.com/acme/app/actions/runs/12345"), undefined)
})

test("ghPrViewArgs uses numeric selector + explicit normalized repo (never owner/repo#N)", () => {
  const ref = parsePrRef("acme/app.git#12")
  assert.ok(ref)
  assert.deepEqual(ghPrViewArgs(ref), [
    "pr",
    "view",
    "12",
    "--repo",
    "acme/app",
    "--json",
    "state,mergedAt,statusCheckRollup,headRefOid",
  ])
})

test("GitHub review GraphQL normalization preserves actor type + review state", () => {
  const got = parseGithubReviewActivities({
    data: { repository: { pullRequest: {
      reviews: { nodes: [{ id: "R1", state: "APPROVED", submittedAt: "2026-07-09T12:01:00Z", author: { login: "alice", __typename: "User" } }] },
      comments: { nodes: [{ id: "C1", createdAt: "2026-07-09T12:02:00Z", author: { login: "dependabot[bot]", __typename: "Bot" } }] },
    } } },
  })
  assert.deepEqual(got.map((a) => [a.id, a.actor, a.actorType, a.kind, a.reviewState]), [
    ["review:R1", "alice", "User", "review", "APPROVED"],
    ["comment:C1", "dependabot[bot]", "Bot", "comment", undefined], // comments carry no review state
  ])
})

// The actor is presentation only — it picks the steer's 🤖/👤 icon and never gates a wake.
test("bot actors are recognized by __typename or a [bot] login suffix", () => {
  const mk = (over: Partial<GithubReviewActivity>): GithubReviewActivity => ({ id: "x", actor: "a", kind: "review", ...over })
  assert.equal(isBotGithubActor(mk({ actor: "pullfrog", actorType: "Bot" })), true)
  assert.equal(isBotGithubActor(mk({ actor: "dependabot[bot]" })), true)
  assert.equal(isBotGithubActor(mk({ actor: "alice", actorType: "User" })), false)
  assert.equal(isBotGithubActor(mk({ actor: "alice" })), false)
})

test("evalRollup: empty → pending; all-complete → done; in-progress → pending; failure → done+failed", () => {
  assert.deepEqual(evalRollup([]), { done: false, ok: false })
  assert.deepEqual(evalRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }]), { done: true, ok: true })
  // pending (not yet done): `ok` just means "no failure seen yet" — only consulted once done.
  assert.deepEqual(evalRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }]), { done: false, ok: true })
  assert.deepEqual(evalRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), { done: true, ok: false })
  // StatusContext shape (legacy): state PENDING → pending; state FAILURE → failed
  assert.deepEqual(evalRollup([{ state: "SUCCESS" }, { state: "PENDING" }]), { done: false, ok: true })
  assert.deepEqual(evalRollup([{ state: "SUCCESS" }, { state: "FAILURE" }]), { done: true, ok: false })
  // SHAPE SURPRISE: an entry we can't classify (no recognizable status/state) must read as PENDING,
  // never as done+green — else a `ci:` wait could false-fire "green" on a malformed rollup.
  assert.deepEqual(evalRollup([{}]), { done: false, ok: true })
  assert.deepEqual(evalRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, {}]), { done: false, ok: true })
})

// ---- scheduler harness ----

function tmpStorage(): Storage {
  return createStorage(join(mkdtempSync(join(tmpdir(), "frizz-sched-")), "ui.db"))
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `sid-${slug}`,
    tmux_name: `frizz-${slug}`,
    spawned_at: "2026-07-01T00:00:00.000Z",
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
    ...over,
  }
}

function awaiting(hints: FenceView["hints"], body = ""): FenceView {
  return { kind: "awaiting", body, hints }
}
function tele(fence?: FenceView, turn: TurnState = "idle"): SessionTelemetry {
  return { turn, permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastFence: fence }
}

function fakeTailer(map: Map<string, SessionTelemetry>): Tailer {
  return {
    get: (slug: string) => map.get(slug),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  }
}

interface Harness {
  storage: Storage
  tele: Map<string, SessionTelemetry>
  resumes: { slug: string; message: string; deliveryId?: string }[]
  clock: { ms: number }
  pr: { result: PrStatus | undefined; calls: PrRef[] }
  review: { result: GithubReviewActivity[] | undefined; calls: PrRef[] }
  make(over?: Partial<Parameters<typeof createScheduler>[0]>): ReturnType<typeof createScheduler>
}

function harness(): Harness {
  const storage = tmpStorage()
  const teleMap = new Map<string, SessionTelemetry>()
  const resumes: { slug: string; message: string; deliveryId?: string }[] = []
  const clock = { ms: Date.parse("2026-07-09T12:00:00.000Z") }
  const pr: { result: PrStatus | undefined; calls: PrRef[] } = { result: undefined, calls: [] }
  const review: { result: GithubReviewActivity[] | undefined; calls: PrRef[] } = { result: undefined, calls: [] }
  return {
    storage,
    tele: teleMap,
    resumes,
    clock,
    pr,
    review,
    make(over) {
      return createScheduler({
        storage,
        tailer: fakeTailer(teleMap),
        resume: (slug, message, deliveryId) => void resumes.push({ slug, message, deliveryId }),
        now: () => clock.ms,
        fetchPr: async (ref) => {
          pr.calls.push(ref)
          return pr.result
        },
        fetchGithubReview: async (ref) => {
          review.calls.push(ref)
          return review.result
        },
        log: () => {},
        pollMs: 0, // poll every tick in tests
        ...over,
      })
    },
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

// ---- THE SAFETY GUARD: no boot mass-fire ----

test("boot-safety: a long-PAST timer fence never fires (only a witnessed crossing does)", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(h.clock.ms - 60_000) }], "re-check")))
  const s = h.make()
  await s.tick()
  h.clock.ms += 60_000
  await s.tick()
  await s.tick()
  assert.deepEqual(h.resumes, [], "a fence already elapsed at first sight must never resume")
})

test("boot-safety: an already-MERGED pr fence never fires on boot", async () => {
  const h = harness()
  h.storage.upsertSession(row("p"))
  h.tele.set("p", tele(awaiting([{ kind: "pr", value: "acme/app#391" }])))
  h.pr.result = { state: "MERGED", mergedAt: "2026-07-01T00:00:00Z", rollup: [] }
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.deepEqual(h.resumes, [], "a PR already merged at first sight must never resume")
})

// ---- single-fire on a witnessed transition ----

test("timer: fires exactly once on the witnessed crossing, with the prose in the steer", async () => {
  const h = harness()
  const target = h.clock.ms + 30_000
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(target) }], "Re-poll the rollout.")))
  const s = h.make()
  await s.tick() // armed (unmet)
  assert.equal(h.resumes.length, 0)
  h.clock.ms = target + 1000
  await s.tick() // crosses → fire
  await s.tick() // fence still present → must NOT re-fire (single-fire)
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].slug, "t")
  assert.equal(h.resumes[0].message, "⏰ Your timer fired: Re-poll the rollout.. Continue.")
})

test("only-at-rest: an in-flight thread with a (stale) awaiting fence never fires", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(h.clock.ms + 1000) }]), "in-flight"))
  const s = h.make()
  await s.tick()
  h.clock.ms += 10_000
  await s.tick()
  assert.equal(h.resumes.length, 0)
})

test("archived thread is skipped entirely", async () => {
  const h = harness()
  h.storage.upsertSession(row("t", { state: "archived", archived: 1 }))
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(h.clock.ms + 1000) }])))
  const s = h.make()
  await s.tick()
  h.clock.ms += 10_000
  await s.tick()
  assert.equal(h.resumes.length, 0)
})

test("human/session hints are descriptive, not scheduler-actionable — no fire, no crash", async () => {
  const h = harness()
  h.storage.upsertSession(row("human"))
  h.storage.upsertSession(row("session"))
  h.tele.set("human", tele(awaiting([{ kind: "human", value: "Alice must approve fork CI" }])))
  h.tele.set("session", tele(awaiting([{ kind: "session", value: "other-thread" }])))
  const s = h.make()
  await s.tick()
  h.clock.ms += 10_000
  await s.tick()
  assert.equal(h.resumes.length, 0)
})

// ---- re-await after a fence clears arms fresh ----

test("a NEW awaiting rest (after the fence cleared) arms and fires again", async () => {
  const h = harness()
  const t1 = h.clock.ms + 10_000
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(t1) }])))
  const s = h.make()
  await s.tick() // arm #1
  h.clock.ms = t1 + 1000
  await s.tick() // fire #1
  assert.equal(h.resumes.length, 1)
  // The agent's turn supersedes the fence → tailer clears it.
  h.tele.set("t", tele(undefined))
  await s.tick() // prune
  // Later the worker re-awaits a NEW timer.
  const t2 = h.clock.ms + 10_000
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(t2) }])))
  await s.tick() // arm #2 (fresh)
  assert.equal(h.resumes.length, 1)
  h.clock.ms = t2 + 1000
  await s.tick() // fire #2
  assert.equal(h.resumes.length, 2)
})

// ---- idempotency across a server restart ----

test("restart idempotency: a delivered outbox wake is not re-fired by a fresh scheduler on the same db", async () => {
  const h = harness()
  const target = h.clock.ms + 10_000
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(target) }])))
  const s1 = h.make()
  await s1.tick() // arm
  h.clock.ms = target + 1000
  await s1.tick() // fire (persists the marker)
  assert.equal(h.resumes.length, 1)
  // Server restarts BEFORE the agent's superseding turn lands — the fence is still present.
  const s2 = h.make()
  await s2.tick()
  await s2.tick()
  assert.equal(h.resumes.length, 1, "the delivered outbox terminal state must prevent a re-fire after restart")
})

test("registered future timer crosses during server downtime and fires exactly once after restart", async () => {
  const h = harness()
  const target = h.clock.ms + 10_000
  h.storage.upsertSession(row("t"))
  h.tele.set("t", { ...tele(awaiting([{ kind: "timer", value: iso(target) }])), lastActivityAt: iso(h.clock.ms) })
  await h.make().tick() // future timer registration is persisted
  h.clock.ms = target + 60_000 // server was down across the crossing
  const restarted = h.make()
  await restarted.tick()
  await restarted.tick()
  assert.equal(h.resumes.length, 1)
})

test("pr-watch baselines existing activity, then wakes once on a new review across restart", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", {
    ...tele(awaiting([
      { kind: "human", value: "repo maintainer review" },
      { kind: "pr-watch", value: "acme/app#391" },
    ])),
    lastActivityAt: fenceAt,
  })
  const old: GithubReviewActivity = { id: "review:old", actor: "alice", actorType: "User", at: iso(h.clock.ms - 1000), kind: "review" }
  h.review.result = [old]
  await h.make().tick() // persist baseline, no wake for existing review
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  h.review.result = [
    { id: "review:new", actor: "bob", actorType: "User", at: iso(h.clock.ms), kind: "review" },
    old,
  ]
  const restarted = h.make()
  await restarted.tick()
  await restarted.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /@bob/)
})

test("pr-watch: a bot review AGENT's review (Pullfrog/Copilot) wakes the watcher — a review is the signal whoever files it", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr-watch", value: "nubjs/nub#544" }])), lastActivityAt: fenceAt })
  h.review.result = [] // no prior activity to baseline
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  // Pullfrog (the maintainer's own review agent) submits its review as a GitHub App — __typename "Bot".
  // The old all-bots filter swallowed exactly this and left the watcher asleep (nubjs/nub#544).
  h.clock.ms += 10_000
  h.review.result = [{ id: "review:pf", actor: "pullfrog", actorType: "Bot", at: iso(h.clock.ms), kind: "review", reviewState: "COMMENTED" }]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1, "the bot review agent's review woke the watcher")
  assert.match(h.resumes[0].message, /@pullfrog/)
  assert.doesNotMatch(h.resumes[0].message, /human/, "the steer no longer claims the reviewer is human")
})

// Review apps like CodeRabbit or Greptile file their findings as a CONVERSATION COMMENT, not a formal
// review. Gating comments on the actor left the watcher asleep through exactly those reviews, so there
// is no actor filter at all any more: a bot comment wakes like any other.
test("pr-watch: a bot COMMENT wakes the watcher, and the steer names it as a bot", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr-watch", value: "nubjs/nub#544" }])), lastActivityAt: fenceAt })
  h.review.result = []
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  h.review.result = [{ id: "comment:coderabbit", actor: "coderabbitai[bot]", actorType: "Bot", at: iso(h.clock.ms), kind: "comment" }]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1, "a bot's conversation comment is review activity like any other")
  assert.match(h.resumes[0].message, /@coderabbitai\[bot\]/)
  assert.match(h.resumes[0].message, /🤖/, "the steer must not imply a person filed it")
  assert.doesNotMatch(h.resumes[0].message, /👤/)
})

// A worker tracking a SET of PRs writes one `pr-watch:` line per PR, and the waker must poll EVERY
// ref — activity on any of them is the wake. Nothing pinned this, and in its absence a worker watching
// 11 adoption PRs concluded (in writing, to the operator) that a watch "can't fan out across repos"
// and fell back to a 7-day timer sweep; a real CHANGES_REQUESTED review then sat unreported for a day
// and a half (burned 2026-07-30). The shared harness returns ONE activity list for every ref, so this
// test supplies a per-ref fetcher — otherwise "the third ref woke it" proves nothing.
test("pr-watch fans out: every ref in a multi-PR fence is polled, and the LAST one's activity wakes", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("multi"))
  h.tele.set("multi", {
    ...tele(awaiting([
      { kind: "pr-watch", value: "acme/a#1" },
      { kind: "pr-watch", value: "acme/b#2" },
      { kind: "pr-watch", value: "acme/c#3" },
    ])),
    lastActivityAt: fenceAt,
  })
  const byRef = new Map<string, GithubReviewActivity[]>([["acme/a#1", []], ["acme/b#2", []], ["acme/c#3", []]])
  const polled: string[] = []
  const make = () => h.make({
    fetchGithubReview: async (ref: PrRef) => {
      const key = `${ref.owner}/${ref.repo}#${ref.number}`
      polled.push(key)
      return byRef.get(key) ?? []
    },
  })
  await make().tick() // baseline every ref
  assert.deepEqual([...new Set(polled)].sort(), ["acme/a#1", "acme/b#2", "acme/c#3"])
  assert.equal(h.resumes.length, 0)

  // Activity on the THIRD hint only — the one a first-hint-wins watcher would never see.
  h.clock.ms += 10_000
  byRef.set("acme/c#3", [{ id: "review:z", actor: "carol", actorType: "User", at: iso(h.clock.ms), kind: "review" }])
  const s = make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /@carol/)
  assert.match(h.resumes[0].message, /acme\/c#3/, "the steer names the PR that actually moved")
})

test("pr-watch retries a failed resume from its durable pending cursor across restart and network loss", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", {
    ...tele(awaiting([
      { kind: "human", value: "repo maintainer review" },
      { kind: "pr-watch", value: "acme/app#391" },
    ])),
    lastActivityAt: fenceAt,
  })
  const old: GithubReviewActivity = { id: "review:old", actor: "alice", actorType: "User", at: iso(h.clock.ms - 1000), kind: "review" }
  h.review.result = [old]
  await h.make().tick() // durable baseline

  h.clock.ms += 10_000
  h.review.result = [
    { id: "review:new", actor: "bob", actorType: "User", at: iso(h.clock.ms), kind: "review" },
    old,
  ]
  let attempts = 0
  const failing = h.make({
    resume: () => {
      attempts++
      throw new Error("tmux temporarily unavailable")
    },
  })
  await failing.tick()
  assert.equal(attempts, 1)
  assert.equal(h.resumes.length, 0)

  // A fresh scheduler can deliver the persisted outbox item without another successful GitHub read.
  h.review.result = undefined
  h.clock.ms += 30_001 // the uncertain delivery lease expires before another process may retry
  const restarted = h.make({
    resume: (slug, message) => {
      attempts++
      h.resumes.push({ slug, message })
    },
  })
  await restarted.tick()
  await restarted.tick()
  assert.equal(attempts, 2, "one failed and one successful delivery; the delivered outbox state blocks a third")
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /@bob/)
})

test("pr-watch: baselines, then bumps on a new human comment", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr-watch", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = [{ id: "comment:old", actor: "alice", actorType: "User", at: iso(h.clock.ms - 1000), kind: "comment" }]
  await h.make().tick() // baseline existing activity, no wake
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  h.review.result = [
    { id: "comment:new", actor: "carol", actorType: "User", at: iso(h.clock.ms), kind: "comment" },
    { id: "comment:old", actor: "alice", actorType: "User", at: iso(h.clock.ms - 1000), kind: "comment" },
  ]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /@carol/)
  assert.match(h.resumes[0].message, /comment/)
  assert.match(h.resumes[0].message, /👤/, "a User actor still reads as a person")
})

// The steer used to name only the PR and the actor. A worker woken that way has no way to address the
// exact item, so its only move is a broad re-read of the thread — and on the real nubjs/nub#587 wake
// that handed back TWO comments from @colinhacks, one of them hours stale and already handled. The
// permalink addresses exactly one item; the ISO timestamp orders it against the worker's own last turn.
test("pr-watch: the bump steer carries the item's permalink and timestamp, not just the actor", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr-watch", value: "nubjs/nub#587" }])), lastActivityAt: fenceAt })
  h.review.result = [{ id: "comment:stale", actor: "colinhacks", actorType: "User", at: iso(h.clock.ms - 1000), kind: "comment", url: "https://github.com/nubjs/nub/pull/587#issuecomment-1" }]
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  const at = iso(h.clock.ms)
  h.review.result = [
    { id: "comment:fresh", actor: "colinhacks", actorType: "User", at, kind: "comment", url: "https://github.com/nubjs/nub/pull/587#issuecomment-2" },
    { id: "comment:stale", actor: "colinhacks", actorType: "User", at: iso(h.clock.ms - 11_000), kind: "comment", url: "https://github.com/nubjs/nub/pull/587#issuecomment-1" },
  ]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(
    h.resumes[0].message,
    `👤 New GitHub comment on nubjs/nub#587 from @colinhacks at ${at}. Read that exact comment — ignore older activity you have already handled — and continue: https://github.com/nubjs/nub/pull/587#issuecomment-2`,
  )
  assert.doesNotMatch(h.resumes[0].message, /issuecomment-1\b/, "the stale comment the worker already handled is never named")
  assert.ok(h.resumes[0].message.endsWith("issuecomment-2"), "the URL ends the steer so no trailing period joins the href")
})

// Every id in the fresh set is marked seen the moment the cursor is persisted, so an activity this
// steer does not name is never mentioned to anyone again. Naming only `fresh[0]` dropped the rest.
test("pr-watch: a BURST between polls is enumerated in full, oldest first — none is silently dropped", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr-watch", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = []
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  const t1 = iso(h.clock.ms - 2000)
  const t2 = iso(h.clock.ms - 1000)
  const t3 = iso(h.clock.ms)
  h.review.result = [
    { id: "review:c", actor: "dana", actorType: "User", at: t3, kind: "review", reviewState: "APPROVED", url: "https://github.com/acme/app/pull/391#pullrequestreview-3" },
    { id: "comment:b", actor: "coderabbitai[bot]", actorType: "Bot", at: t2, kind: "comment", url: "https://github.com/acme/app/pull/391#issuecomment-2" },
    { id: "comment:a", actor: "carol", actorType: "User", at: t1, kind: "comment", url: "https://github.com/acme/app/pull/391#issuecomment-1" },
  ]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(
    h.resumes[0].message,
    [
      "👤 3 new GitHub items on acme/app#391. Read exactly these — ignore older activity you have already handled — and continue:",
      "",
      `- 👤 comment from @carol at ${t1}: https://github.com/acme/app/pull/391#issuecomment-1`,
      `- 🤖 comment from @coderabbitai[bot] at ${t2}: https://github.com/acme/app/pull/391#issuecomment-2`,
      `- 👤 approval from @dana at ${t3}: https://github.com/acme/app/pull/391#pullrequestreview-3`,
      // Dana's approval is the only REVIEW in the burst, so the steer's derived tail names exactly one
      // read — the two issue comments carry their substance in their own bodies and need no help.
      "",
      "A review's body is often empty because its substance is inline comments. Read them, one call each:",
      "gh api --paginate repos/acme/app/pulls/391/reviews/3/comments",
    ].join("\n"),
  )
})

// The cap keeps the NEWEST items (they matter most) and the header still counts the whole burst, so a
// worker is never told "3 new items" when 30 landed.
test("pr-watch: a burst past the enumeration cap counts everything and says how many it did not name", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr-watch", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = []
  await h.make().tick()

  h.clock.ms += 10_000
  h.review.result = Array.from({ length: 13 }, (_, i) => ({
    id: `comment:${i}`,
    actor: "carol",
    actorType: "User",
    at: iso(h.clock.ms - (12 - i) * 100),
    kind: "comment" as const,
    url: `https://github.com/acme/app/pull/391#issuecomment-${i}`,
  }))
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  const msg = h.resumes[0].message
  assert.match(msg, /^👤 13 new GitHub items on acme\/app#391\./, "the header counts the whole burst, not just the named ones")
  assert.equal(msg.split("\n").filter((l) => l.startsWith("- ")).length, 11, "10 named items plus the overflow line")
  assert.match(msg, /- …and 3 more not listed — check acme\/app#391 for the rest$/)
  assert.match(msg, /issuecomment-12/, "the newest item survives the cap")
  assert.doesNotMatch(msg, /issuecomment-2:/, "the oldest three are the ones dropped")
})

// A pending cursor written before the enumeration existed still owes its worker a wake. Reading the
// bare object as a one-element list is what keeps that promise across the upgrade.
test("pr-watch: a legacy single-object pending cursor still delivers after the upgrade", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr-watch", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  const fenceId = `${fenceAt}pr-watch:acme/app#391`
  h.storage.setSetting("waker.registrations.v1", [{
    key: `r ${fenceId}`,
    timers: {},
    reviews: {
      "pr-watch:acme/app#391": {
        baseline: true,
        seen: ["comment:pending"],
        pending: { id: "comment:pending", actor: "erin", actorType: "User", at: fenceAt, kind: "comment" },
      },
    },
  }])
  h.review.result = []
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1, "the wake the old scheduler owed is still delivered")
  assert.match(h.resumes[0].message, /@erin/)
  assert.match(h.resumes[0].message, /New GitHub comment on acme\/app#391/)
})

test("pr-watch: an APPROVAL is named specifically in the bump steer", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr-watch", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = [] // no prior activity to baseline
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  h.review.result = [{ id: "review:appr", actor: "dana", actorType: "User", at: iso(h.clock.ms), kind: "review", reviewState: "APPROVED" }]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /approval/)
  assert.match(h.resumes[0].message, /@dana/)
})

// The label fills a noun slot, so GitHub's verb-phrase wording ("requested changes") would read as
// "New GitHub requested changes on acme/app#391 from @erin".
test("pr-watch: CHANGES_REQUESTED is named as a noun, so the steer stays a grammatical sentence", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr-watch", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = []
  await h.make().tick()

  h.clock.ms += 10_000
  const at = iso(h.clock.ms)
  h.review.result = [{ id: "review:cr", actor: "erin", actorType: "User", at, kind: "review", reviewState: "CHANGES_REQUESTED" }]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(
    h.resumes[0].message,
    `👤 New GitHub change request on acme/app#391 from @erin at ${at}. Read that exact change request — ignore older activity you have already handled — and continue.`,
  )
})

// The steer is a NOTIFICATION that activity landed, never an instruction to change the PR's state.
// "Re-open the PR and continue" meant "go read it", but a woken worker reads `gh pr reopen`: the real
// wake on nubjs/nub#551 (a @vercel comment) burned a turn on the ambiguity, and the failure mode one
// step past that is reopening a PR the maintainer closed deliberately.
test("pr-watch: the bump steer never reads as an instruction to mutate the PR", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr-watch", value: "nubjs/nub#551" }])), lastActivityAt: fenceAt })
  h.review.result = []
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  h.review.result = [{ id: "comment:vercel", actor: "vercel", actorType: "Bot", at: iso(h.clock.ms), kind: "comment" }]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  const message = h.resumes[0].message
  assert.match(message, /nubjs\/nub#551/)
  assert.match(message, /@vercel/)
  assert.doesNotMatch(message, /re-?open/i, "the steer must not order the worker to reopen the PR")
  assert.doesNotMatch(message, /\b(close|merge|approve)\b/i, "nor any other PR state change")
})

test("pr-watch: 'Arm watcher' — a new-activity bump CLEARS the user snooze so the card re-surfaces", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr-watch", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = [] // baseline empty
  await h.make().tick()

  // The human parked the card via "Arm watcher" — a user snooze with a far-future safety timeout.
  const safety = iso(h.clock.ms + 24 * 3600_000)
  h.storage.setSnoozedUntil("r", safety)
  assert.equal(h.storage.getSession("r")?.snoozed_until, safety)

  // A real human review lands well before the safety instant. The scheduler keeps polling the snoozed
  // thread, fires, and CLEARS the snooze so the card returns to the queue immediately.
  h.clock.ms += 10_000
  h.review.result = [{ id: "review:new", actor: "erin", actorType: "User", at: iso(h.clock.ms), kind: "review", reviewState: "COMMENTED" }]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1, "the bump resumed the worker")
  assert.equal(h.storage.getSession("r")?.snoozed_until, null, "the user snooze was cleared by the activity bump")
})

test("pr-watch: one scheduler tick batches distinct refs and deduplicates duplicate refs", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  for (const [slug, pr] of [["first", 544], ["second", 549], ["duplicate", 544]] as const) {
    h.storage.upsertSession(row(slug))
    h.tele.set(slug, { ...tele(awaiting([{ kind: "pr-watch", value: `nubjs/nub#${pr}` }])), lastActivityAt: fenceAt })
  }
  let tokenCalls = 0
  const requests: any[] = []
  const fetchGithubReview = createGithubReviewFetcher({
    getToken: async () => {
      tokenCalls++
      return "token"
    },
    request: async (_input, init) => {
      const request = JSON.parse(String(init?.body))
      requests.push(request)
      return new Response(JSON.stringify({
        data: {
          ref0: { pullRequest: { reviews: { nodes: [] }, comments: { nodes: [] } } },
          ref1: { pullRequest: { reviews: { nodes: [] }, comments: { nodes: [] } } },
          rateLimit: { cost: 2, remaining: 4_000, resetAt: iso(h.clock.ms + 60 * 60_000), limit: 5_000 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } })
    },
    now: () => h.clock.ms,
  })

  await h.make({ fetchGithubReview }).tick()
  assert.equal(tokenCalls, 1)
  assert.equal(requests.length, 1)
  assert.deepEqual(Object.values(requests[0].variables).filter((value) => typeof value === "number").sort(), [544, 549])
})

test("pr-watch: precise failures are coalesced in logs and recovery is explicit", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr-watch", value: "nubjs/nub#544" }])), lastActivityAt: fenceAt })
  const logs: string[] = []
  let recovered = false
  const scheduler = h.make({
    log: (message) => logs.push(message),
    fetchGithubReview: async () => recovered
      ? { status: "ok", activity: [] }
      : { status: "error", failure: { kind: "timeout", message: "GitHub GraphQL request timed out after 15s" } },
  })

  await scheduler.tick()
  h.clock.ms += 60_000
  await scheduler.tick()
  assert.deepEqual(logs, [
    "waker: GitHub review check failed for nubjs/nub#544 (r) [timeout] — GitHub GraphQL request timed out after 15s",
  ])

  recovered = true
  h.clock.ms += 60_000
  await scheduler.tick()
  assert.deepEqual(logs, [
    "waker: GitHub review check failed for nubjs/nub#544 (r) [timeout] — GitHub GraphQL request timed out after 15s",
    "waker: GitHub review check recovered for nubjs/nub#544 (r); 1 identical repeats were suppressed",
  ])
})

// ---- PR / CI transitions + graceful gh failure ----

test("pr: open→merged transition fires with the merged steer", async () => {
  const h = harness()
  h.storage.upsertSession(row("p"))
  h.tele.set("p", tele(awaiting([{ kind: "pr", value: "acme/app#391" }])))
  const s = h.make()
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [] }
  await s.tick() // armed (open)
  assert.equal(h.resumes.length, 0)
  h.pr.result = { state: "MERGED", mergedAt: "2026-07-09T12:05:00Z", rollup: [] }
  await s.tick() // merged → fire
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].message, "✅ PR acme/app#391 merged. Continue.")
})

test("ci: pending→(gh failure)→green; a transient gh failure is skipped, never fires early or crashes", async () => {
  const h = harness()
  h.storage.upsertSession(row("c"))
  h.tele.set("c", tele(awaiting([{ kind: "ci", value: "acme/app#391" }])))
  const s = h.make()
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "IN_PROGRESS" }], workflowRuns: [{ workflowName: "CI", event: "pull_request", status: "IN_PROGRESS" }] }
  await s.tick() // armed (pending)
  h.pr.result = undefined // gh unavailable this tick
  await s.tick() // indeterminate → no fire, no crash
  assert.equal(h.resumes.length, 0)
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], workflowRuns: [{ workflowName: "CI", event: "pull_request", status: "COMPLETED", conclusion: "SUCCESS" }] }
  await s.tick() // checks green → fire
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].message, "✅ CI is green on acme/app#391. Continue.")
})

// "CI failed" alone sent every woken worker straight back to `gh pr checks` to learn WHICH job went
// red. The rollup already carries the job names, so the steer names them.
test("ci: a failing check still wakes the worker, and the steer NAMES the failed jobs", async () => {
  const h = harness()
  h.storage.upsertSession(row("c"))
  h.tele.set("c", tele(awaiting([{ kind: "ci", value: "acme/app#391" }])))
  const s = h.make()
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "IN_PROGRESS" }], workflowRuns: [{ workflowName: "CI", event: "pull_request", status: "IN_PROGRESS" }] }
  await s.tick()
  h.pr.result = {
    state: "OPEN",
    mergedAt: null,
    rollup: [
      { name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "test (node 24)", status: "COMPLETED", conclusion: "FAILURE" },
      { context: "vercel/preview", state: "ERROR" },
    ],
    workflowRuns: [{ workflowName: "CI", event: "pull_request", status: "COMPLETED", conclusion: "FAILURE" }],
  }
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].message, "❌ CI failed on acme/app#391 — test (node 24), vercel/preview, CI. Continue.")
})

// A green check must never leak into the failed list, and a red one with no reportable name must not
// produce a dangling "— " tail.
test("ci: an unnamed failure degrades to the bare failed steer rather than an empty list", async () => {
  const h = harness()
  h.storage.upsertSession(row("c"))
  h.tele.set("c", tele(awaiting([{ kind: "ci", value: "acme/app#391" }])))
  const s = h.make()
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "IN_PROGRESS" }], workflowRuns: [{ event: "pull_request", status: "IN_PROGRESS" }] }
  await s.tick()
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "COMPLETED", conclusion: "FAILURE" }], workflowRuns: [{ event: "pull_request", status: "COMPLETED", conclusion: "FAILURE" }] }
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].message, "❌ CI failed on acme/app#391. Continue.")
})

test("ci: a partial green rollup remains pending for an exact-head fork gate, then an approved rerun wakes once", async () => {
  const h = harness()
  h.storage.upsertSession(row("fork-gate"))
  h.tele.set("fork-gate", tele(awaiting([{ kind: "ci", value: "acme/app#391" }])))
  const s = h.make()
  h.pr.result = {
    state: "OPEN", mergedAt: null,
    rollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    workflowRuns: [{ workflowName: "CI", event: "pull_request", status: "COMPLETED", conclusion: "ACTION_REQUIRED", databaseId: 1, createdAt: "2026-07-14T10:00:00Z" }],
  }
  await s.tick()
  assert.equal(h.resumes.length, 0, "fork approval is pending even when statusCheckRollup is green")
  h.pr.result = {
    state: "OPEN", mergedAt: null,
    // GitHub can retain the old ACTION_REQUIRED check in the rollup after approval.
    rollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "ACTION_REQUIRED" }],
    workflowRuns: [
      { workflowName: "CI", event: "pull_request", status: "COMPLETED", conclusion: "ACTION_REQUIRED", databaseId: 1, createdAt: "2026-07-14T10:00:00Z" },
      { workflowName: "CI", event: "pull_request", status: "COMPLETED", conclusion: "SUCCESS", databaseId: 2, createdAt: "2026-07-14T10:02:00Z" },
    ],
  }
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1, "only the latest approved rerun may satisfy the fence")
  assert.match(h.resumes[0].message, /CI is green/)
})

// ---- durable delivery outbox: crash boundaries, recovery, retries, and concurrency ----

function dueTimer(h: Harness, slug: string, delayMs = 1_000): { target: number; fence: FenceView } {
  const target = h.clock.ms + delayMs
  const fence = awaiting([{ kind: "timer", value: iso(target) }], `Wake ${slug}.`)
  h.storage.upsertSession(row(slug))
  h.tele.set(slug, { ...tele(fence), lastActivityAt: iso(h.clock.ms) })
  return { target, fence }
}

test("hard crash after enqueue recovers the pending wake on restart", async () => {
  const h = harness()
  const { target } = dueTimer(h, "enqueue-crash")
  let crash = true
  const scheduler = h.make({
    crashPoint: (point) => {
      if (crash && point === "after-enqueue") throw new Error("SIGKILL after enqueue")
    },
  })
  await scheduler.tick() // register the future timer
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)

  const store = createWakeDeliveryStore(h.storage.db)
  assert.equal(store.list().length, 1)
  assert.equal(store.list()[0].state, "pending")
  assert.equal(store.list()[0].attempts, 0)
  assert.equal(h.resumes.length, 0)

  const dbPath = h.storage.db.name
  h.storage.close()
  const reopened = createStorage(dbPath)
  crash = false
  const restarted = h.make({ storage: reopened })
  await restarted.tick()
  await restarted.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(createWakeDeliveryStore(reopened.db).list()[0].state, "delivered")
  reopened.close()
})

test("hard crash after atomic claim leaves a lease; restart retries only after it expires", async () => {
  const h = harness()
  const { target } = dueTimer(h, "claim-crash")
  let crash = true
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    retryBaseMs: 10,
    crashPoint: (point) => {
      if (crash && point === "after-claim") throw new Error("SIGKILL after claim")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)

  const store = createWakeDeliveryStore(h.storage.db)
  assert.equal(store.list()[0].state, "leased")
  assert.equal(store.list()[0].attempts, 1)
  assert.equal(h.resumes.length, 0)

  const dbPath = h.storage.db.name
  h.storage.close()
  const reopened = createStorage(dbPath)
  crash = false
  const restarted = h.make({ storage: reopened, deliveryLeaseMs: 100, retryBaseMs: 10 })
  await restarted.tick()
  assert.equal(h.resumes.length, 0, "an unexpired claim cannot be stolen by the new scheduler")
  h.clock.ms += 101
  await restarted.tick()
  assert.equal(h.resumes.length, 1)
  const recovered = createWakeDeliveryStore(reopened.db).list()[0]
  assert.equal(recovered.state, "delivered")
  assert.equal(recovered.attempts, 2)
  reopened.close()
})

test("hard crash after successful delivery but before ack is confirmed by the stable token, never replayed", async () => {
  const h = harness()
  const { target, fence } = dueTimer(h, "delivery-crash")
  let deliveredId = ""
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    resume: (_slug, _message, deliveryId) => {
      deliveredId = deliveryId
      h.resumes.push({ slug: "delivery-crash", message: "delivered", deliveryId })
    },
    crashPoint: (point) => {
      if (point === "after-delivery") throw new Error("SIGKILL after tmux accepted input")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)
  assert.equal(h.resumes.length, 1)

  const store = createWakeDeliveryStore(h.storage.db)
  assert.equal(store.list()[0].state, "leased")
  assert.equal(store.list()[0].attempts, 1)
  // The backend transcript consumed the exact idempotency token before the control plane restarted.
  h.tele.set("delivery-crash", {
    ...tele(fence),
    lastActivityAt: iso(target - 1_000),
    lastUserText: `wake input ${wakeDeliveryToken(deliveredId)}`,
  })
  h.clock.ms += 101
  const dbPath = h.storage.db.name
  h.storage.close()
  const reopened = createStorage(dbPath)
  const restarted = h.make({ storage: reopened, deliveryLeaseMs: 100 })
  await restarted.tick()
  await restarted.tick()
  assert.equal(h.resumes.length, 1, "confirmed external delivery must not be duplicated")
  const confirmed = createWakeDeliveryStore(reopened.db).list()[0]
  assert.equal(confirmed.state, "delivered")
  assert.equal(confirmed.deliveredAt, h.clock.ms)
  reopened.close()
})

test("an ambiguous delivery error is not replayed when the transcript already confirms its token", async () => {
  const h = harness()
  const { target, fence } = dueTimer(h, "ambiguous")
  let calls = 0
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    resume: (_slug, _message, deliveryId) => {
      calls++
      h.tele.set("ambiguous", {
        ...tele(fence),
        lastActivityAt: iso(target - 1_000),
        lastUserText: `accepted ${wakeDeliveryToken(deliveryId)}`,
      })
      throw new Error("connection dropped after terminal accepted the input")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await scheduler.tick()
  assert.equal(calls, 1)
  assert.equal(createWakeDeliveryStore(h.storage.db).list()[0].state, "leased")

  await h.make({ deliveryLeaseMs: 100 }).tick()
  assert.equal(calls, 1)
  assert.equal(createWakeDeliveryStore(h.storage.db).list()[0].state, "delivered")
})

test("hard crash after ack leaves an exact delivered terminal state and never replays", async () => {
  const h = harness()
  const { target } = dueTimer(h, "ack-crash")
  const scheduler = h.make({
    crashPoint: (point) => {
      if (point === "after-ack") throw new Error("SIGKILL after ack")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)
  assert.equal(h.resumes.length, 1)

  const store = createWakeDeliveryStore(h.storage.db)
  assert.equal(store.list()[0].state, "delivered")
  const dbPath = h.storage.db.name
  h.storage.close()
  const reopened = createStorage(dbPath)
  await h.make({ storage: reopened }).tick()
  assert.equal(h.resumes.length, 1)
  reopened.close()
})

test("a pending wake whose exact fence is replaced becomes superseded without delivery", async () => {
  const h = harness()
  const { target } = dueTimer(h, "human-won")
  const scheduler = h.make({
    crashPoint: (point) => {
      if (point === "after-enqueue") throw new Error("stop after durable enqueue")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)
  h.tele.set("human-won", tele(undefined)) // a human follow-up superseded the awaiting fence

  await h.make().tick()
  const item = createWakeDeliveryStore(h.storage.db).list()[0]
  assert.equal(item.state, "superseded")
  assert.equal(h.resumes.length, 0)
})

test("delivery failures use bounded exponential retry windows and terminate exhausted", async () => {
  const h = harness()
  const { target } = dueTimer(h, "exhaust")
  let attempts = 0
  const scheduler = h.make({
    deliveryLeaseMs: 10,
    retryBaseMs: 10,
    retryMaxMs: 40,
    maxDeliveryAttempts: 3,
    resume: () => {
      attempts++
      throw new Error(`terminal unavailable ${attempts}`)
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await scheduler.tick() // attempt 1, retry window 10ms
  assert.equal(attempts, 1)
  h.clock.ms += 9
  await scheduler.tick()
  assert.equal(attempts, 1)
  h.clock.ms += 1
  await scheduler.tick() // attempt 2, retry window 20ms
  assert.equal(attempts, 2)
  h.clock.ms += 20
  await scheduler.tick() // attempt 3, retry window 40ms
  assert.equal(attempts, 3)
  h.clock.ms += 40
  await scheduler.tick() // terminal exhaustion, never a fourth callback
  await scheduler.tick()

  const item = createWakeDeliveryStore(h.storage.db).list()[0]
  assert.equal(item.state, "exhausted")
  assert.equal(item.attempts, 3)
  assert.equal(item.lastError, "terminal unavailable 3")
  assert.equal(attempts, 3)
})

// An ordinary wake takes exactly one attempt, so a pre-flight "delivering … (attempt 1)" spent its
// whole life telling the human about a retry counter that had never retried anything — it read as if
// something had already gone wrong. The default line is now a CONFIRMATION of a delivery that landed.
test("the happy path logs one delivery CONFIRMATION, with no attempt counter", async () => {
  const h = harness()
  const { target } = dueTimer(h, "quiet")
  const logs: string[] = []
  const scheduler = h.make({ log: (message) => logs.push(message) })
  await scheduler.tick() // armed (unmet)
  h.clock.ms = target + 1
  await scheduler.tick() // crosses → queue + deliver
  assert.equal(h.resumes.length, 1)
  assert.deepEqual(logs, [
    `waker: queued quiet — timer ${iso(target)}`,
    `waker: delivered quiet — timer ${iso(target)}`,
  ])
})

test("attempt counts surface only where they inform: the failure, then the delivery that recovered", async () => {
  const h = harness()
  const { target } = dueTimer(h, "flaky")
  const logs: string[] = []
  let failing = true
  const scheduler = h.make({
    log: (message) => logs.push(message),
    deliveryLeaseMs: 10,
    retryBaseMs: 10,
    retryMaxMs: 40,
    maxDeliveryAttempts: 3,
    resume: (slug, message, deliveryId) => {
      if (failing) throw new Error("tmux pane busy")
      h.resumes.push({ slug, message, deliveryId })
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await scheduler.tick() // attempt 1 throws
  failing = false
  h.clock.ms += 10 // the retry window elapses
  await scheduler.tick() // attempt 2 lands
  assert.equal(h.resumes.length, 1)
  assert.deepEqual(logs, [
    `waker: queued flaky — timer ${iso(target)}`,
    "waker: delivery FAILED for flaky (attempt 1 of 3): tmux pane busy",
    `waker: delivered flaky — timer ${iso(target)} (on attempt 2)`,
  ])
})

test("two scheduler instances on separate SQLite connections atomically claim one wake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sched-concurrent-"))
  const path = join(dir, "ui.db")
  const firstStorage = createStorage(path)
  const secondStorage = createStorage(path)
  const telemetry = new Map<string, SessionTelemetry>()
  const clock = { ms: Date.parse("2026-07-09T12:00:00.000Z") }
  const target = clock.ms + 1_000
  firstStorage.upsertSession(row("concurrent"))
  telemetry.set("concurrent", {
    ...tele(awaiting([{ kind: "timer", value: iso(target) }])),
    lastActivityAt: iso(clock.ms),
  })

  const deliveries: string[] = []
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const began = new Promise<void>((resolve) => { started = resolve })
  const resume = async (_slug: string, _message: string, deliveryId: string) => {
    deliveries.push(deliveryId)
    started()
    await gate
  }
  const make = (storage: Storage) => createScheduler({
    storage,
    tailer: fakeTailer(telemetry),
    resume,
    now: () => clock.ms,
    fetchPr: async () => undefined,
    fetchGithubReview: async () => undefined,
    pollMs: 0,
    log: () => {},
  })
  const first = make(firstStorage)
  const second = make(secondStorage)
  await Promise.all([first.tick(), second.tick()]) // both register the future timer
  clock.ms = target + 1

  const firstTick = first.tick()
  const secondTick = second.tick()
  await began
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(deliveries.length, 1, "the second scheduler observes the lease instead of delivering")
  release()
  await Promise.all([firstTick, secondTick])

  assert.equal(new Set(deliveries).size, 1)
  const items = createWakeDeliveryStore(secondStorage.db).list()
  assert.equal(items.length, 1)
  assert.equal(items[0].state, "delivered")
  assert.equal(items[0].attempts, 1)
  secondStorage.close()
  firstStorage.close()
})

test("a slow condition pass cannot create an already-expired delivery lease", async () => {
  const h = harness()
  const { target } = dueTimer(h, "fresh-lease")
  let claimedLease = 0
  let advanced = false
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    crashPoint: (point, item) => {
      if (point === "after-enqueue" && !advanced) {
        advanced = true
        h.clock.ms += 60_000 // stand in for a slow condition/API pass before outbox delivery
      }
      if (point === "after-claim") claimedLease = item.leaseUntil ?? 0
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await scheduler.tick()

  assert.equal(h.resumes.length, 1)
  assert.ok(claimedLease > h.clock.ms, "claim time is sampled at delivery, not inherited from tick start")
})

test("scheduler stop rejects new ticks and drains an in-flight delivery before storage may close", async () => {
  const h = harness()
  const { target } = dueTimer(h, "shutdown-delivery")
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const delivering = new Promise<void>((resolve) => { started = resolve })
  const scheduler = h.make({
    resume: async (slug, message, deliveryId) => {
      h.resumes.push({ slug, message, deliveryId })
      started()
      await gate
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  const tick = scheduler.tick()
  await delivering

  let stopped = false
  const stopping = scheduler.stop().then(() => { stopped = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(stopped, false, "stop waits at the external delivery boundary")
  await assert.rejects(scheduler.tick(), /shutting down/)

  release()
  await Promise.all([tick, stopping])
  assert.equal(stopped, true)
  assert.equal(createWakeDeliveryStore(h.storage.db).list()[0].state, "delivered")
  h.storage.close()
})

// ---- SOURCE 2: subscription-limit auto-resume ------------------------------------------------------
// The recorded phrasings/timestamps below are verbatim from real ~/.claude transcripts.

const LA = "America/Los_Angeles"
// A 15:26-PDT session stop whose window rolls at 17:50 PDT — the 2026-07-21 record.
const SESSION_FAULT_AT = "2026-07-21T22:26:23.160Z"
const SESSION_RESET_MS = Date.parse("2026-07-22T00:50:00.000Z")

function limitTele(fault: SessionTelemetry["limitFault"], turn: TurnState = "idle"): SessionTelemetry {
  return { turn, permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, limitFault: fault }
}
const sessionFault = () => ({ window: "session" as const, at: SESSION_FAULT_AT, resetClock: { hour: 17, minute: 50, timeZone: LA } })

function limitHarness(): Harness {
  const h = harness()
  h.clock.ms = Date.parse(SESSION_FAULT_AT) + 1000
  return h
}

test("limit: a paused thread is NOT resumed while the window is still closed", async () => {
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make()
  await s.tick()
  h.clock.ms = SESSION_RESET_MS - 60_000 // one minute short of the stated reset
  await s.tick()
  assert.deepEqual(h.resumes, [], "resuming before the provider's own reset just re-hits the wall")
  h.storage.close()
})

test("limit: EVERY thread the window cut off is resumed once, with a continue", async () => {
  const h = limitHarness()
  for (const slug of ["a", "b", "c"]) {
    h.storage.upsertSession(row(slug))
    h.tele.set(slug, limitTele(sessionFault()))
  }
  const s = h.make()
  await s.tick()
  h.clock.ms = SESSION_RESET_MS + 61_000 // past the reset + the grace
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug).sort(), ["a", "b", "c"], "the whole interrupted fleet picks itself back up")
  for (const r of h.resumes) assert.match(r.message, /session usage limit that interrupted you has reset\. Continue/)
  // Idempotence: the fold clears the fault the moment our continue lands, which is what retires it.
  h.tele.set("a", limitTele(undefined))
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 3, "one wake per interruption, never a second")
  h.storage.close()
})

test("limit: a thread already MOVING again is left alone", async () => {
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault(), "in-flight"))
  const s = h.make()
  await s.tick()
  h.clock.ms = SESSION_RESET_MS + 61_000
  await s.tick()
  assert.deepEqual(h.resumes, [], "something else already resumed it; never step on a live turn")
  h.storage.close()
})

test("limit: an ARCHIVED thread is never woken", async () => {
  const h = limitHarness()
  h.storage.upsertSession(row("a", { state: "archived", archived: 1 }))
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make()
  await s.tick()
  h.clock.ms = SESSION_RESET_MS + 61_000
  await s.tick()
  assert.deepEqual(h.resumes, [])
  h.storage.close()
})

test("limit: BOOT SAFETY — a stale pause from long ago never mass-fires", async () => {
  // A server starting days later replays every transcript from byte zero and sees the old faults. That
  // must not wake a whole fleet at once, long after the operator moved on. The budget runs from when
  // the window came BACK (5h for a session limit) plus the 36h grace, so three days is well past it.
  const h = limitHarness()
  for (const slug of ["a", "b", "c"]) {
    h.storage.upsertSession(row(slug))
    h.tele.set(slug, limitTele(sessionFault()))
  }
  h.clock.ms = Date.parse(SESSION_FAULT_AT) + 3 * 24 * 60 * 60_000
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.deepEqual(h.resumes, [], "an aged-out pause is a human handoff, not an auto-resume")
  h.storage.close()
})

test("limit: a pause from LAST NIGHT is still picked up (the grace is deliberate, not accidental)", async () => {
  // The mirror of the boot guard, and the reason the feature exists: hitting the wall at 3pm and
  // finding the whole fleet still parked next morning is the failure being removed. Asserted so a
  // future tightening of the age constant cannot quietly reintroduce it.
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make()
  await s.tick()
  h.clock.ms = Date.parse(SESSION_FAULT_AT) + 18 * 60 * 60_000
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug), ["a"])
  h.storage.close()
})

test("limit: a WEEKLY pause waits for the usage endpoint, and never guesses from its dateless clock", async () => {
  const h = limitHarness()
  const day = 24 * 3_600_000
  const faultAt = "2026-06-24T23:27:13.000Z" // the real weekly stop: 16:27 PDT, reading "resets 4pm"
  const faultMs = Date.parse(faultAt)
  h.clock.ms = faultMs + 1000
  h.storage.upsertSession(row("w"))
  h.tele.set("w", limitTele({ window: "weekly", at: faultAt, resetClock: { hour: 16, minute: 0, timeZone: LA } }))

  // Still inside the fault's own week: the reported window ends 3 days out, so it began 4 days BEFORE
  // the fault. Reading that dateless "4pm" as today's would have fired here — into a dry account.
  let resetsAt = (faultMs + 3 * day) / 1000
  const s = h.make({ readQuota: async () => ({
    claude: { status: "ok" as const, windows: [{ key: "weekly", label: "Weekly", usedPercent: 100, resetsAt }] },
    codex: { status: "unavailable" as const, windows: [] },
  }) })
  await s.tick()
  h.clock.ms = faultMs + day
  await s.tick()
  assert.equal(h.resumes.length, 0, "a dateless weekly clock must never be read as same-day")

  // The week rolls: the reported window now begins an hour AFTER the fault.
  resetsAt = (faultMs + 7 * day + 3_600_000) / 1000
  h.clock.ms = faultMs + 7 * day
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug), ["w"])
  assert.match(h.resumes[0].message, /weekly usage limit that interrupted you has reset/)
  h.storage.close()
})

test("limit: an unreadable usage endpoint holds the wake rather than guessing", async () => {
  const h = limitHarness()
  const faultAt = "2026-06-24T23:27:13.000Z"
  h.clock.ms = Date.parse(faultAt) + 1000
  h.storage.upsertSession(row("w"))
  h.tele.set("w", limitTele({ window: "weekly", at: faultAt }))
  const s = h.make({ readQuota: async () => { throw new Error("usage endpoint unreachable") } })
  await s.tick()
  h.clock.ms = Date.parse(faultAt) + 8 * 24 * 3_600_000
  await s.tick()
  assert.deepEqual(h.resumes, [], "indeterminate must never resolve to 'go'")
  h.storage.close()
})

test("limit: a session pause with no account headroom still resumes from its own clock", async () => {
  // The account-availability trigger consults the (cheap, cached) snapshot for a session limit too, but
  // an uninformative/unavailable reading must never BLOCK the reliable text-clock resume.
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make({ readQuota: async () =>
    ({ claude: { status: "unavailable" as const, windows: [] }, codex: { status: "unavailable" as const, windows: [] } }) })
  await s.tick()
  h.clock.ms = SESSION_RESET_MS + 61_000
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug), ["a"], "the message's own clock still answers when quota can't")
  h.storage.close()
})

test("limit: account headroom on the blown window resumes a session pause BEFORE its own clock", async () => {
  // The account-switch / raised-cap case: quota freed up on the signed-in account while the original
  // 17:50 reset is still hours away. The paused thread should pick itself back up without waiting.
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make({ readQuota: async () => ({
    claude: { status: "ok" as const, windows: [{ key: "5h", label: "5h", usedPercent: 20, resetsAt: (Date.parse(SESSION_FAULT_AT) + 3_600_000) / 1000 }] },
    codex: { status: "unavailable" as const, windows: [] },
  }) })
  await s.tick() // fault ~1s old: younger than the min-age, so a reading that could predate the fault is NOT trusted
  assert.equal(h.resumes.length, 0, "a reading that might predate the fault must not resume into the wall it came from")
  h.clock.ms = Date.parse(SESSION_FAULT_AT) + 3 * 60_000 // past the 2-min min-age, still hours before 17:50
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug), ["a"], "freed-up quota resumes without waiting for the original clock")
  h.storage.close()
})

test("limit: a still-near-full window does NOT trigger the account-availability resume", async () => {
  // Jitter near 100% must never fire the headroom trigger — that would resume the fleet straight back
  // into the wall. Only a drop below the floor counts.
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make({ readQuota: async () => ({
    claude: { status: "ok" as const, windows: [{ key: "5h", label: "5h", usedPercent: 90, resetsAt: (Date.parse(SESSION_FAULT_AT) + 3_600_000) / 1000 }] },
    codex: { status: "unavailable" as const, windows: [] },
  }) })
  await s.tick()
  h.clock.ms = Date.parse(SESSION_FAULT_AT) + 5 * 60_000 // well past the min-age, still before the 17:50 clock
  await s.tick()
  assert.deepEqual(h.resumes, [], "90% used is not headroom — no early resume; it waits for the real reset")
  h.storage.close()
})

test("limit: the early resume is spent ONCE per wall — bouncing off it does not re-fire forever", async () => {
  // The 2026-07-30 incident, reproduced. An early (headroom) resume lands in a process that is still
  // latched on its own 429, so it bounces: a NEW fault, a later `at`, the SAME 17:50 wall. The account
  // still reads healthy, so nothing in the headroom trigger's own premise has changed — which is how
  // this ran every 2 minutes for half an hour and wrote 184 limit records into one transcript.
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault()))
  const healthyAccount = async () => ({
    claude: { status: "ok" as const, windows: [{ key: "5h", label: "5h", usedPercent: 1, resetsAt: (Date.parse(SESSION_FAULT_AT) + 3_600_000) / 1000 }] },
    codex: { status: "unavailable" as const, windows: [] },
  })
  const s = h.make({ readQuota: healthyAccount })
  h.clock.ms = Date.parse(SESSION_FAULT_AT) + 3 * 60_000
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug), ["a"], "the one early attempt still happens")

  // It bounced. Same wall, new fault record — exactly what the tailer folds when the latched process
  // answers the wake with another synthetic 429.
  for (let bounce = 1; bounce <= 5; bounce++) {
    const at = new Date(Date.parse(SESSION_FAULT_AT) + bounce * 2 * 60_000 + 3 * 60_000).toISOString()
    h.tele.set("a", limitTele({ window: "session", at, resetClock: { hour: 17, minute: 50, timeZone: LA } }))
    h.clock.ms = Date.parse(at) + 3 * 60_000
    await s.tick()
  }
  assert.equal(h.resumes.length, 1, "every later bounce off the SAME wall must be ignored, not re-woken")

  // The wall itself is what clears it: once the provider's own reset passes, trigger (1) fires and the
  // thread resumes normally. The guard must never turn into a permanent block.
  h.clock.ms = SESSION_RESET_MS + 2 * 60_000
  await s.tick()
  assert.equal(h.resumes.length, 2, "past its stated reset the thread resumes on its own clock")
  h.storage.close()
})

test("limit: a limit wake and a fence wake for the same session get distinct deliveries", async () => {
  // Both sources share one outbox. If their identities could collide, arming one would silently
  // swallow the other's wake for that session.
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  const target = SESSION_RESET_MS + 5 * 60_000
  h.tele.set("a", { ...limitTele(sessionFault()), lastFence: awaiting([{ kind: "timer", value: iso(target) }], "re-check") })
  const s = h.make()
  await s.tick() // arms the timer (witnessed unmet) and sees the limit still closed
  h.clock.ms = SESSION_RESET_MS + 61_000
  await s.tick() // the limit resets first
  assert.deepEqual(h.resumes.map((r) => r.slug), ["a"])
  assert.match(h.resumes[0].message, /usage limit/)
  const ids = createWakeDeliveryStore(h.storage.db).list().map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length, "no delivery-id collision between the two wake sources")
  h.storage.close()
})

// ---- SOURCE 3: the user snooze --------------------------------------------------------------------

// A snooze that carries a prompt is the human's own `awaiting timer:` — park until an instant, then
// resume with a message. These lock down that it rides the SAME outbox, delivers the prompt verbatim,
// and settles the row that armed it.

function snoozeRow(slug: string, until: string, prompt: string | null): SessionRow {
  return row(slug, { snoozed_until: until, snooze_prompt: prompt })
}

test("snooze: a due prompt-carrying snooze bumps the thread with the prompt VERBATIM, exactly once", async () => {
  const h = harness()
  const until = iso(h.clock.ms + 60_000)
  h.storage.upsertSession(snoozeRow("s", until, "Check whether CI went green and land it if so."))
  h.tele.set("s", tele())
  const s = h.make()
  await s.tick()
  assert.equal(h.resumes.length, 0, "a snooze still in the future must not fire")

  h.clock.ms = Date.parse(until)
  await s.tick()
  await s.tick() // must not double-bump
  assert.deepEqual(h.resumes.map((r) => r.slug), ["s"])
  // No "⏰ your snooze fired" preamble: the human scheduled a turn, so the worker receives that turn.
  assert.equal(h.resumes[0].message, "Check whether CI went green and land it if so.")
  // The row that armed the bump is settled by the delivery, so nothing re-arms on the next tick.
  assert.equal(h.storage.getSession("s")?.snoozed_until, null)
  assert.equal(h.storage.getSession("s")?.snooze_prompt, null)
  h.storage.close()
})

test("snooze: a snooze WITHOUT a prompt never wakes the agent (it is a reminder the board owns)", async () => {
  const h = harness()
  const until = iso(h.clock.ms + 60_000)
  h.storage.upsertSession(snoozeRow("s", until, null))
  h.tele.set("s", tele())
  const s = h.make()
  h.clock.ms = Date.parse(until) + 60_000
  await s.tick()
  assert.deepEqual(h.resumes, [], "the historical snooze only re-surfaces the card")
  h.storage.close()
})

test("snooze: an OVERDUE snooze found at boot does fire — unlike an unregistered timer fence", async () => {
  // The deliberate divergence from the boot-mass-fire guard. A fence hint is only a claim in a
  // transcript, so an already-past one is untrustworthy; a snooze row is an explicit durable promise
  // the human made, so a deadline that crossed while frizz was down is exactly what it is FOR.
  const h = harness()
  h.storage.upsertSession(snoozeRow("s", iso(h.clock.ms - 3 * 3_600_000), "Pick this back up."))
  h.tele.set("s", tele())
  const s = h.make()
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.message), ["Pick this back up."])
  h.storage.close()
})

test("snooze: waking now before delivery supersedes the queued bump", async () => {
  const h = harness()
  const until = iso(h.clock.ms + 60_000)
  h.storage.upsertSession(snoozeRow("s", until, "stale follow-up"))
  h.tele.set("s", tele(undefined, "in-flight")) // busy → enqueued, but delivery defers
  const s = h.make()
  h.clock.ms = Date.parse(until)
  await s.tick()
  assert.deepEqual(h.resumes, [], "a mid-turn thread is not stepped on")

  h.storage.setSnoozedUntil("s", null) // the human hit "Wake now" (or sent a follow-up)
  h.tele.set("s", tele())
  await s.tick()
  assert.deepEqual(h.resumes, [], "the human already said something newer than the message we held")
  assert.equal(createWakeDeliveryStore(h.storage.db).list()[0]?.state, "superseded")
  h.storage.close()
})

test("snooze: re-snoozing before delivery keeps the NEW deadline and mints its own bump", async () => {
  const h = harness()
  const first = iso(h.clock.ms + 60_000)
  h.storage.upsertSession(snoozeRow("s", first, "old prompt"))
  h.tele.set("s", tele(undefined, "in-flight"))
  const s = h.make()
  h.clock.ms = Date.parse(first)
  await s.tick() // enqueued, undeliverable (busy)

  const second = iso(h.clock.ms + 3_600_000)
  h.storage.setSnoozedUntil("s", second, "new prompt")
  h.tele.set("s", tele())
  await s.tick()
  assert.equal(h.resumes.length, 0, "the superseded bump must not deliver")
  assert.equal(h.storage.getSession("s")?.snoozed_until, second, "settling the stale wake must not erase the fresh snooze")

  h.clock.ms = Date.parse(second)
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.message), ["new prompt"])
  h.storage.close()
})

test("snooze: a bump that comes due mid-turn is HELD, then delivered once the thread rests", async () => {
  const h = harness()
  const until = iso(h.clock.ms + 60_000)
  h.storage.upsertSession(snoozeRow("s", until, "resume the audit"))
  h.tele.set("s", tele(undefined, "in-flight"))
  const s = h.make()
  h.clock.ms = Date.parse(until)
  await s.tick()
  assert.equal(h.resumes.length, 0)

  h.tele.set("s", tele()) // comes to rest
  h.clock.ms += 60_000
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.message), ["resume the audit"], "a deadline crossed mid-turn is owed, not dropped")
  h.storage.close()
})

test("snooze: an archived thread never bumps", async () => {
  const h = harness()
  const until = iso(h.clock.ms - 60_000)
  h.storage.upsertSession(row("s", { snoozed_until: until, snooze_prompt: "nope", state: "archived", archived: 1 }))
  h.tele.set("s", tele())
  const s = h.make()
  await s.tick()
  assert.deepEqual(h.resumes, [])
  h.storage.close()
})

test("snooze: a snooze wake and a fence wake for the same session get distinct deliveries", async () => {
  const h = harness()
  const target = h.clock.ms + 30_000
  h.storage.upsertSession(snoozeRow("s", iso(target), "snooze prompt"))
  h.tele.set("s", tele(awaiting([{ kind: "timer", value: iso(target) }], "re-check")))
  const s = h.make()
  await s.tick() // arms the fence timer (witnessed unmet); the snooze is not yet due
  h.clock.ms = target + 1000
  await s.tick()
  const ids = createWakeDeliveryStore(h.storage.db).list().map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length, "no delivery-id collision between the snooze and fence sources")
  assert.equal(ids.length, 2, "both sources armed their own wake for this session")
  h.storage.close()
})

// A resume that fails ASYNCHRONOUSLY must retry exactly like one that throws synchronously.
//
// This is the codex-wake shape. context.ts delivers a codex wake over the app-server bridge, which is
// inherently async, and it used to run that work in a DETACHED IIFE (`void (async () => …)().catch(…)`)
// and return undefined immediately. The scheduler awaits `resume`, so it saw an instant success and
// ACKED the delivery; the real bridge failure landed seconds later into a bare `.catch` and vanished —
// no log, no retry, the wake lost forever. Claude's synchronous `resumeThread` throws straight into the
// scheduler's catch and retries, so the bug was CODEX-ONLY and silent: an `awaiting timer:` or
// limit-auto-resume codex thread could simply never wake.
//
// Returning the promise is the whole fix, and this test is what keeps it returned: revert to
// fire-and-forget and the rejection never reaches the scheduler, so no retry happens and this fails.
test("a resume that REJECTS asynchronously is retried, exactly like a synchronous throw", async () => {
  const h = harness()
  h.storage.upsertSession(row("async-wake"))
  h.tele.set("async-wake", tele(awaiting([{ kind: "timer", value: iso(h.clock.ms + 1_000) }])))

  // The fence must be WITNESSED pending before it can fire (the boot-safety guard), so take a durable
  // baseline while it is still in the future, then cross it.
  await h.make().tick()
  h.clock.ms += 2_000

  let attempts = 0
  const failing = h.make({
    resume: () => {
      attempts++
      // No `throw` — an already-rejected promise, which is what an async bridge delivery produces.
      return Promise.reject(new Error("codex app-server bridge unavailable"))
    },
  })
  await failing.tick()
  assert.equal(attempts, 1, "the due wake was attempted")
  assert.equal(h.resumes.length, 0, "and it did not count as delivered")

  // The lease expires, and a later generation redelivers it — proving the failure was never ACKed.
  h.clock.ms += 30_001
  const restarted = h.make({
    resume: (slug, message) => {
      attempts++
      h.resumes.push({ slug, message })
    },
  })
  await restarted.tick()
  await restarted.tick()
  assert.equal(attempts, 2, "the async rejection was retried, not swallowed")
  assert.equal(h.resumes.length, 1, "and the retry delivered exactly once")
})
