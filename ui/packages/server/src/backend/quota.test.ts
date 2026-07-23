import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseCodexQuotaFromRollout } from "./codex-quota.ts"
import { parseClaudeUsage, parseClaudeUsageOutput, tokenFromCredentialsJson, readClaudeQuota, claudeQuotaRefreshSettled } from "./claude-quota.ts"

// ---- Codex rollout parsing ----

test("codex: live event_msg-wrapped rate_limits (payload.rate_limits)", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-15T10:00:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 100 } },
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1783730191 },
        secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1784316991 },
      },
    },
  })
  const q = parseCodexQuotaFromRollout(line + "\n")
  assert.equal(q?.status, "ok")
  assert.equal(q?.planType, "pro")
  assert.deepEqual(q?.windows.map((w) => [w.key, w.usedPercent]), [["5h", 12.5], ["weekly", 40]])
})

test("codex: flattened top-level rate_limits (exec/fixture shape)", () => {
  const line = JSON.stringify({
    type: "token_count",
    info: {},
    rate_limits: {
      plan_type: "pro",
      primary: { used_percent: 0, window_minutes: 300, resets_at: 1 },
      secondary: { used_percent: 0, window_minutes: 10080, resets_at: 2 },
    },
  })
  const q = parseCodexQuotaFromRollout(line)
  assert.equal(q?.windows.length, 2)
})

test("codex: window labeled by window_minutes, not primary/secondary name (real single-window case)", () => {
  // Real observed: `primary` carries the WEEKLY window (10080), `secondary` is null.
  const line = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: { plan_type: "pro", primary: { used_percent: 88, window_minutes: 10080, resets_at: 9 }, secondary: null },
    },
  })
  const q = parseCodexQuotaFromRollout(line)
  assert.equal(q?.windows.length, 1)
  assert.equal(q?.windows[0]!.key, "weekly")
  assert.equal(q?.windows[0]!.usedPercent, 88)
})

test("codex: last token_count wins; junk lines skipped", () => {
  const stale = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 10, window_minutes: 300 } } } })
  const fresh = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 55, window_minutes: 300 } } } })
  const raw = [stale, "not json {", JSON.stringify({ type: "response_item" }), fresh].join("\n")
  const q = parseCodexQuotaFromRollout(raw)
  assert.equal(q?.windows[0]!.usedPercent, 55)
})

test("codex: no rate_limits anywhere → undefined", () => {
  assert.equal(parseCodexQuotaFromRollout(JSON.stringify({ type: "response_item" })), undefined)
  assert.equal(parseCodexQuotaFromRollout(""), undefined)
})

// ---- Claude usage endpoint parsing ----

test("claude: five_hour + seven_day utilization → windows", () => {
  const q = parseClaudeUsage(
    { five_hour: { utilization: 34, reset_at: "2026-07-15T18:00:00Z" }, seven_day: { utilization: 61, reset_at: "2026-07-18T00:00:00Z" } },
    "max",
  )
  assert.equal(q.status, "ok")
  assert.equal(q.planType, "max")
  assert.deepEqual(q.windows.map((w) => [w.key, w.usedPercent]), [["5h", 34], ["weekly", 61]])
  assert.equal(typeof q.windows[0]!.resetsAt, "number")
})

test("claude: surfaces model-specific weekly caps (opus/sonnet) when present", () => {
  const q = parseClaudeUsage({
    five_hour: { utilization: 10, reset_at: "2026-07-15T18:00:00Z" },
    seven_day: { utilization: 40, reset_at: "2026-07-18T00:00:00Z" },
    seven_day_opus: { utilization: 91, reset_at: "2026-07-18T00:00:00Z" },
  })
  assert.deepEqual(q.windows.map((w) => w.key), ["5h", "weekly", "weekly-opus"])
  // The binding limit (opus 91% used) is the highest usedPercent → the chip's "tightest" pick.
  assert.equal(Math.max(...q.windows.map((w) => w.usedPercent)), 91)
})

test("claude: malformed / empty body → unavailable, never throws", () => {
  assert.equal(parseClaudeUsage(null).status, "unavailable")
  assert.equal(parseClaudeUsage({}).status, "unavailable")
  assert.equal(parseClaudeUsage({ five_hour: { reset_at: "x" } }).status, "unavailable")
})

// ---- Credential blob parsing (same shape whether it comes from ~/.claude/.credentials.json OR the
// macOS Keychain "Claude Code-credentials" generic password — `security -w` prints this exact blob). ----

test("claude creds: nested claudeAiOauth.accessToken (current shape)", () => {
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ claudeAiOauth: { accessToken: "tok-abc" } })), "tok-abc")
})

test("claude creds: flat access_token (drifted/older shape)", () => {
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ access_token: "tok-flat" })), "tok-flat")
})

test("claude creds: garbage / empty / no token → undefined, never throws", () => {
  assert.equal(tokenFromCredentialsJson("not json {"), undefined)
  assert.equal(tokenFromCredentialsJson("null"), undefined)
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ claudeAiOauth: { accessToken: "" } })), undefined)
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ other: 1 })), undefined)
})

// ---- Claude Code `/usage` parsing + cross-window cache ----

const usageText = [
  "You are currently using your subscription to power your Claude Code usage",
  "Current session: 20% used · resets 4pm",
  "Current week (all models): 44% used · resets Thu",
  "Current week (Sonnet only): 61% used · resets Thu",
].join("\n")
const usageEnvelope = JSON.stringify({ type: "result", subtype: "success", result: usageText })

test("claude CLI usage: parses independent session, weekly, and model-scoped windows", () => {
  const now = new Date("2026-07-22T15:00:00").getTime()
  const q = parseClaudeUsageOutput(usageText, now)
  assert.equal(q.status, "ok")
  assert.deepEqual(q.windows.map((w) => [w.key, w.label, w.usedPercent]), [
    ["5h", "5h", 20],
    ["weekly", "Weekly", 44],
    ["weekly-sonnet", "Sonnet wk", 61],
  ])
  assert.equal(q.windows[0]?.resetsAt, Math.round(new Date("2026-07-22T16:00:00").getTime() / 1000))
})

test("claude CLI usage: parses the JSON result envelope and rejects cost-only signed-out output", () => {
  assert.equal(parseClaudeUsageOutput(usageEnvelope).status, "ok")
  const missing = parseClaudeUsageOutput(JSON.stringify({ result: "Total cost: $0.00\nUsage: 0 input" }))
  assert.equal(missing.status, "unavailable")
  assert.equal(missing.detail, "Claude Code did not report subscription quota")
})

test("claude CLI usage: parses the live '<Mon> <D> at <clock> (<tz>)' reset labels", () => {
  const now = new Date("2026-07-23T10:30:00").getTime()
  const q = parseClaudeUsageOutput(
    [
      "Current session: 17% used · resets Jul 23 at 3pm (America/Los_Angeles)",
      "Current week (Fable): 45% used · resets Jul 27 at 12:59am (America/Los_Angeles)",
    ].join("\n"),
    now,
  )
  assert.equal(q.status, "ok")
  assert.deepEqual(q.windows.map((w) => [w.key, w.usedPercent]), [["5h", 17], ["weekly-fable", 45]])
  assert.equal(q.windows[0]?.resetsAt, Math.round(new Date("2026-07-23T15:00:00").getTime() / 1000))
  assert.equal(q.windows[1]?.resetsAt, Math.round(new Date("2026-07-27T00:59:00").getTime() / 1000))
})

test("claude CLI usage: a year-less date label crossing New Year resolves forward", () => {
  const now = new Date("2026-12-30T10:00:00").getTime()
  const q = parseClaudeUsageOutput("Current session: 5% used · resets Jan 2 at 3pm (America/Los_Angeles)", now)
  assert.equal(q.windows[0]?.resetsAt, Math.round(new Date("2027-01-02T15:00:00").getTime() / 1000))
})

async function withCache(run: (cacheDir: string) => Promise<void>) {
  const cacheDir = await mkdtemp(join(tmpdir(), "fray-quota-test-"))
  try {
    await run(cacheDir)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
}

test("claude quota: healthy result is shared, while force performs a real recheck", () => withCache(async (cacheDir) => {
  let calls = 0
  const execUsage = async () => {
    calls++
    return usageEnvelope
  }
  assert.equal((await readClaudeQuota("claude-test", { cacheDir, now: () => 0, execUsage })).status, "ok")
  assert.equal((await readClaudeQuota("claude-test", { cacheDir, now: () => 60_000, execUsage })).status, "ok")
  assert.equal(calls, 1)
  await readClaudeQuota("claude-test", { cacheDir, now: () => 60_001, execUsage }, { force: true })
  assert.equal(calls, 2)
}))

test("claude quota: concurrent project windows collapse onto one Claude Code invocation", () => withCache(async (cacheDir) => {
  let calls = 0
  const execUsage = async () => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 100))
    return usageEnvelope
  }
  const results = await Promise.all([
    readClaudeQuota("claude-test", { cacheDir, now: () => 1_000, execUsage }),
    readClaudeQuota("claude-test", { cacheDir, now: () => 1_000, execUsage }),
    readClaudeQuota("claude-test", { cacheDir, now: () => 1_000, execUsage }),
  ])
  assert.equal(calls, 1)
  assert.ok(results.every((result) => result.status === "ok"))
}))

test("claude quota: an expired reading is served instantly while a background refresh updates the cache", () => withCache(async (cacheDir) => {
  let calls = 0
  const execUsage = async () => {
    calls++
    return JSON.stringify({ type: "result", subtype: "success", result: `Current session: ${calls === 1 ? 20 : 55}% used · resets 4pm` })
  }
  await readClaudeQuota("claude-test", { cacheDir, now: () => 0, execUsage })
  assert.equal(calls, 1)
  // TTL expired: the poll gets the stale-but-recent reading back immediately (no CLI wait on the
  // request path) and the refresh happens behind it.
  const swr = await readClaudeQuota("claude-test", { cacheDir, now: () => 4 * 60_000, execUsage })
  assert.equal(swr.status, "ok")
  assert.equal(swr.windows[0]?.usedPercent, 20)
  assert.equal(swr.detail, undefined)
  await claudeQuotaRefreshSettled()
  assert.equal(calls, 2)
  const after = await readClaudeQuota("claude-test", { cacheDir, now: () => 4 * 60_000 + 1, execUsage })
  assert.equal(after.windows[0]?.usedPercent, 55)
  assert.equal(calls, 2)
}))

test("claude quota: a meaningfully old reading served via stale-while-revalidate says so", () => withCache(async (cacheDir) => {
  await readClaudeQuota("claude-test", { cacheDir, now: () => 0, execUsage: async () => usageEnvelope })
  const swr = await readClaudeQuota(
    "claude-test",
    { cacheDir, now: () => 15 * 60_000, execUsage: async () => { throw new Error("CLI down") } },
  )
  assert.equal(swr.status, "ok")
  assert.equal(swr.detail, "Refreshing · last updated 15m ago")
  await claudeQuotaRefreshSettled()
}))

test("claude quota: a failed refresh retains the last good reading with an honest stale label", () => withCache(async (cacheDir) => {
  await readClaudeQuota("claude-test", { cacheDir, now: () => 0, execUsage: async () => usageEnvelope })
  const stale = await readClaudeQuota(
    "claude-test",
    { cacheDir, now: () => 4 * 60_000, execUsage: async () => { throw new Error("CLI failed") } },
    { force: true },
  )
  assert.equal(stale.status, "ok")
  assert.equal(stale.windows[0]?.usedPercent, 20)
  assert.equal(stale.detail, "Could not refresh · last updated 4m ago")
}))
