#!/usr/bin/env node
// REAL-SUBSYSTEM VERIFICATION of the pr-watch wake steer.
//
// No stubbed GitHub. This drives the REAL scheduler with the REAL GraphQL fetcher (the maintainer's
// own `gh` token, real HTTPS to api.github.com) and a REAL SQLite storage + wake outbox, against a
// REAL public PR — nubjs/nub#587, the exact thread whose wake started this. Its comment history is
// the perfect fixture: TWO comments from the SAME author eight hours apart, which the old
// actor-only steer ("New GitHub comment … from @colinhacks") could not tell apart, so the woken
// worker re-read the thread and re-litigated the stale one.
//
//   node ui/scripts/verify-pr-watch-steer.mjs
//
// Requires `gh auth status` to be green. Exits nonzero on any failed assertion.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "../packages/server/src/storage.ts"
import { createScheduler } from "../packages/server/src/scheduler.ts"
import { createGithubReviewFetcher } from "../packages/server/src/github-review.ts"

const PR = "nubjs/nub#587"
const STALE_AT = "2026-07-29T07:36:03Z" // @colinhacks — already handled; what the worker wrongly re-read
const FRESH_AT = "2026-07-29T15:39:28Z" // @colinhacks — the wake's real subject
const LATER_AT = "2026-07-29T15:46:04Z" // @pullfrog's first review, which landed minutes later

let failures = 0
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

// The real fetcher, shared by every scenario: reads the real token from `gh auth token` and speaks
// real HTTPS. `asOf` replays the PR's own history by hiding activity that had not happened yet at
// that instant — every tick is still a live round-trip against real GitHub, returning real ids,
// real authors and real permalinks.
const live = createGithubReviewFetcher()
const asOf = (instant) => async (ref) => {
  const result = await live(ref)
  if (result.status !== "ok") return result
  const cutoff = Date.parse(instant)
  return { status: "ok", activity: result.activity.filter((a) => Date.parse(a.at ?? "") <= cutoff) }
}

async function run(label, { fenceAt, fetchGithubReview, ticks = [] }) {
  const home = mkdtempSync(join(tmpdir(), "fray-prwatch-"))
  try {
    const storage = createStorage(join(home, "ui.db"))
    const resumes = []
    const logs = []
    storage.upsertSession({
      slug: label, session_id: `sid-${label}`, tmux_name: `fray-${label}`, spawned_at: fenceAt,
      last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
      title: label, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
    })
    const fence = { kind: "awaiting", body: `pr-watch: ${PR}\nWatching for review.`, hints: [{ kind: "pr-watch", value: PR }] }
    let fetcher = fetchGithubReview
    const scheduler = createScheduler({
      storage,
      tailer: {
        get: () => ({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastFence: fence, lastActivityAt: fenceAt }),
        foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
      },
      resume: (slug, message, deliveryId) => void resumes.push({ slug, message, deliveryId }),
      fetchGithubReview: (ref) => fetcher(ref),
      log: (m) => logs.push(m),
      pollMs: 0,
    })
    // Each phase swaps in a later view of the PR, then ticks twice (poll+enqueue, then deliver).
    for (const phase of ticks.length ? ticks : [fetchGithubReview]) {
      fetcher = phase
      await scheduler.tick()
      await scheduler.tick()
    }
    await scheduler.stop()
    const failed = logs.find((l) => l.includes("review check failed"))
    check("the real GitHub poll succeeded", !failed, failed ?? "no failure logged")
    return resumes
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- A. THE REPORTED BUG, replayed on the real timeline -------------------------------------------
// The worker rested at noon; at 15:39 @colinhacks left ONE comment. That is the wake it received, and
// the steer it got named only the PR and the author.
console.log(`\nA. the reported wake — one fresh comment from an author who had commented before`)
{
  const resumes = await run("reported", {
    fenceAt: "2026-07-29T12:00:00.000Z",
    ticks: [asOf("2026-07-29T15:00:00Z"), asOf("2026-07-29T15:40:00Z")],
  })
  check("woke exactly once", resumes.length === 1, `${resumes.length} resume(s)`)
  const msg = resumes[0]?.message ?? ""
  console.log(`\n--- the steer a real worker now receives ---\n${msg}\n---\n`)
  check("names the PR", msg.includes(PR))
  check("names the actor", msg.includes("@colinhacks"))
  check("carries the FRESH comment's exact timestamp", msg.includes(FRESH_AT))
  check("carries a real GitHub permalink to that one comment", /https:\/\/github\.com\/nubjs\/nub\/pull\/587#issuecomment-\d+$/.test(msg.trim()))
  check("never names the stale, already-handled comment", !msg.includes(STALE_AT))
  check("tells the worker to read that exact item", /Read that exact comment/.test(msg))
  check("scopes it away from older activity", /ignore older activity you have already handled/.test(msg))
  check("the URL ends the steer, so no period joins the href", /\d$/.test(msg.trim()))
  check("never reads as an instruction to mutate the PR", !/re-?open|reopen|merge it|close it/i.test(msg))
}

// ---- B. THE BURST, on the same real PR ------------------------------------------------------------
// A worker resting since noon that is polled ONCE after 15:47 has three real fresh items waiting. The
// old code named `fresh[0]` — @pullfrog's 15:47 review — and marked the other two seen, so the
// maintainer's 15:39 comment would have been swallowed and never mentioned to anyone.
console.log(`\nB. a burst collected in one poll — every item must be named`)
{
  const resumes = await run("burst", { fenceAt: "2026-07-29T12:00:00.000Z", fetchGithubReview: asOf("2026-07-29T16:00:00Z") })
  check("woke exactly once", resumes.length === 1, `${resumes.length} resume(s)`)
  const msg = resumes[0]?.message ?? ""
  console.log(`\n--- the steer a real worker now receives ---\n${msg}\n---\n`)
  check("counts the whole burst", /^👤 3 new GitHub items on nubjs\/nub#587\./.test(msg))
  check("names the maintainer's comment the old code would have dropped", msg.includes(FRESH_AT) && msg.includes("@colinhacks"))
  check("names the later bot reviews too", msg.includes(LATER_AT) && msg.includes("@pullfrog"))
  check("lists them oldest-first, the order they were written", msg.indexOf(FRESH_AT) < msg.indexOf(LATER_AT))
  check("every named item carries its own permalink", msg.split("\n").filter((l) => l.startsWith("- ")).every((l) => /https:\/\/github\.com\//.test(l)))
  check("never names the stale, already-handled comment", !msg.includes(STALE_AT))
}

// ---- C. NEGATIVE CONTROL --------------------------------------------------------------------------
// The same scheduler and the same real PR with a fence past all existing activity must stay SILENT.
// A wake that fires either way proves nothing.
console.log(`\nC. control — a fence past all real activity`)
{
  const resumes = await run("control", { fenceAt: new Date(Date.now() + 3_600_000).toISOString(), fetchGithubReview: live })
  check("stays silent", resumes.length === 0, `${resumes.length} resume(s)`)
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
