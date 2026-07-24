import { test } from "node:test"
import assert from "node:assert/strict"
import { createGithubReviewFetcher } from "./github-review.ts"

const ref = (number: number) => ({ owner: "nubjs", repo: "nub", number })

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

test("review fetcher gets the gh token once and batches + deduplicates same-turn PR reads", async () => {
  let tokenCalls = 0
  const requests: { url: string; init?: RequestInit; body: any }[] = []
  const fetcher = createGithubReviewFetcher({
    getToken: async () => {
      tokenCalls++
      return "secret-from-gh"
    },
    request: async (input, init) => {
      requests.push({ url: String(input), init, body: JSON.parse(String(init?.body)) })
      return response({
        data: {
          ref0: {
            pullRequest: {
              reviews: { nodes: [{ id: "R544", state: "APPROVED", submittedAt: "2026-07-24T17:00:00Z", author: { login: "pullfrog", __typename: "Bot" } }] },
              comments: { nodes: [] },
            },
          },
          ref1: {
            pullRequest: {
              reviews: { nodes: [] },
              comments: { nodes: [{ id: "C549", createdAt: "2026-07-24T17:01:00Z", author: { login: "colinhacks", __typename: "User" } }] },
            },
          },
          rateLimit: { cost: 2, remaining: 4_800, resetAt: "2026-07-24T18:00:00Z", limit: 5_000 },
        },
      })
    },
    now: () => Date.parse("2026-07-24T17:05:00Z"),
  })

  const [first, second, duplicate] = await Promise.all([fetcher(ref(544)), fetcher(ref(549)), fetcher(ref(544))])
  assert.equal(tokenCalls, 1)
  assert.equal(requests.length, 1, "both distinct PRs share one HTTP request")
  assert.equal(requests[0].url, "https://api.github.com/graphql")
  assert.equal(requests[0].init?.headers && (requests[0].init.headers as Record<string, string>).authorization, "Bearer secret-from-gh")
  assert.deepEqual(requests[0].body.variables, {
    owner0: "nubjs",
    repo0: "nub",
    number0: 544,
    owner1: "nubjs",
    repo1: "nub",
    number1: 549,
  })
  assert.deepEqual(first, {
    status: "ok",
    activity: [{ id: "review:R544", actor: "pullfrog", actorType: "Bot", at: "2026-07-24T17:00:00Z", kind: "review", reviewState: "APPROVED" }],
  })
  assert.deepEqual(second, {
    status: "ok",
    activity: [{ id: "comment:C549", actor: "colinhacks", actorType: "User", at: "2026-07-24T17:01:00Z", kind: "comment" }],
  })
  assert.deepEqual(duplicate, first)
})

test("review fetcher reports gh-token auth failures precisely and retries token lookup next batch", async () => {
  let tokenCalls = 0
  let requestCalls = 0
  const fetcher = createGithubReviewFetcher({
    getToken: async () => {
      tokenCalls++
      if (tokenCalls === 1) throw new Error("not logged in")
      return "fresh-token"
    },
    request: async () => {
      requestCalls++
      return response({
        data: {
          ref0: { pullRequest: { reviews: { nodes: [] }, comments: { nodes: [] } } },
          rateLimit: { cost: 1, remaining: 4_000, resetAt: "2026-07-24T18:00:00Z", limit: 5_000 },
        },
      })
    },
  })

  const failed = await fetcher(ref(544))
  assert.equal(failed.status, "error")
  if (failed.status === "error") {
    assert.equal(failed.failure.kind, "gh-auth")
    assert.match(failed.failure.message, /not logged in/)
  }
  assert.equal(requestCalls, 0)

  const recovered = await fetcher(ref(544))
  assert.deepEqual(recovered, { status: "ok", activity: [] })
  assert.equal(tokenCalls, 2)
  assert.equal(requestCalls, 1)
})

test("review fetcher honors the real rate-limit reset without hammering GitHub", async () => {
  let requestCalls = 0
  const clock = { ms: Date.parse("2026-07-24T17:00:00Z") }
  const reset = new Date(clock.ms + 10 * 60_000)
  const fetcher = createGithubReviewFetcher({
    getToken: async () => "token",
    request: async () => {
      requestCalls++
      return response(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset.getTime() / 1000),
          },
        },
      )
    },
    now: () => clock.ms,
  })

  const exhausted = await fetcher(ref(544))
  assert.equal(exhausted.status, "error")
  if (exhausted.status === "error") {
    assert.equal(exhausted.failure.kind, "rate-limit")
    assert.equal(exhausted.failure.retryAt, reset.toISOString())
  }
  clock.ms += 60_000
  assert.deepEqual(await fetcher(ref(544)), { status: "deferred" })
  assert.equal(requestCalls, 1, "the reset guard suppresses another HTTP request")
})

test("review fetcher invalidates a rejected token so the next batch asks gh again", async () => {
  let tokenCalls = 0
  let requestCalls = 0
  const fetcher = createGithubReviewFetcher({
    getToken: async () => `token-${++tokenCalls}`,
    request: async () => {
      requestCalls++
      if (requestCalls === 1) return response({ message: "Bad credentials" }, { status: 401 })
      return response({
        data: {
          ref0: { pullRequest: { reviews: { nodes: [] }, comments: { nodes: [] } } },
          rateLimit: { cost: 1, remaining: 4_000, resetAt: "2026-07-24T18:00:00Z", limit: 5_000 },
        },
      })
    },
  })

  const rejected = await fetcher(ref(544))
  assert.equal(rejected.status, "error")
  if (rejected.status === "error") assert.equal(rejected.failure.kind, "gh-auth")
  assert.deepEqual(await fetcher(ref(544)), { status: "ok", activity: [] })
  assert.equal(tokenCalls, 2)
})
