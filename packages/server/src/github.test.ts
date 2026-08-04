import { test } from "node:test"
import assert from "node:assert/strict"
import { GITHUB_DISPATCH_UI_BOUNDARY } from "@fray-ui/shared"
import {
  reactionCount,
  commentCount,
  parseSearchJson,
  pageCountFor,
  SEARCH_RESULT_WINDOW,
  summarizeLinkedPrs,
  linkedPrQuery,
  parseLinkedPrJson,
  truncateBody,
  renderGithubPrompt,
  effectiveTemplate,
  DEFAULT_ISSUE_PROMPT,
  DEFAULT_PR_PROMPT,
  PROMPT_TOKENS,
  type HydratedIssue,
  type HydratedPr,
} from "./github.ts"

// All tests inject gh output (no real gh shell-out) — the parsing/scoring/templating fns are pure.

// ---- reactionCount ----

test("reactionCount: reads the search row's reactions.total_count", () => {
  assert.equal(reactionCount({ url: "…", total_count: 449, "+1": 347, heart: 71, rocket: 31 }), 449)
  assert.equal(reactionCount({ total_count: 0 }), 0)
})

test("reactionCount: empty / missing / malformed → 0, never throws", () => {
  assert.equal(reactionCount(undefined), 0)
  assert.equal(reactionCount(null), 0)
  assert.equal(reactionCount("nope"), 0)
  assert.equal(reactionCount({}), 0)
  assert.equal(reactionCount({ total_count: "3" }), 0) // non-numeric ignored
  assert.equal(reactionCount({ total_count: -2 }), 0)
})

// ---- pageCountFor ----

test("pageCountFor: rounds up, and an empty list still has one page", () => {
  assert.equal(pageCountFor(0, 30), 1)
  assert.equal(pageCountFor(1, 30), 1)
  assert.equal(pageCountFor(30, 30), 1)
  assert.equal(pageCountFor(31, 30), 2)
  assert.equal(pageCountFor(988, 30), 33)
})

test("pageCountFor: never offers a page past GitHub's servable search window", () => {
  // The API refuses results beyond the 1000th however large total_count is, so the pager must stop
  // where the data does rather than handing out pages that come back empty.
  assert.equal(pageCountFor(50_000, 30), Math.ceil(SEARCH_RESULT_WINDOW / 30))
  assert.equal(pageCountFor(50_000, 100), 10)
})

test("pageCountFor: a nonsense total or page size degrades to one page", () => {
  assert.equal(pageCountFor(Number.NaN, 30), 1)
  assert.equal(pageCountFor(-5, 30), 1)
  assert.equal(pageCountFor(100, 0), 1)
})

// ---- commentCount ----

test("commentCount: array length (the older gh list returned the comment ARRAY, not a count)", () => {
  assert.equal(commentCount([{ body: "a" }, { body: "b" }, { body: "c" }]), 3)
  assert.equal(commentCount([]), 0)
})

test("commentCount: tolerates a bare number; absent/garbage → undefined", () => {
  assert.equal(commentCount(12), 12)
  assert.equal(commentCount(undefined), undefined)
  assert.equal(commentCount(-1), undefined)
  assert.equal(commentCount("5"), undefined)
})

// ---- parseSearchJson ----
//
// The fixtures below are verbatim-shaped `GET /search/issues` rows (snake_case, html_url,
// reactions.total_count, user.login, draft) — the exact wire shape listItems now parses.

test("parseSearchJson: issues — remaps the search shape and carries total_count", () => {
  const raw = JSON.stringify({
    total_count: 988,
    incomplete_results: false,
    items: [
      {
        number: 326,
        title: "Support multiple accounts",
        html_url: "https://github.com/cli/cli/issues/326",
        reactions: { url: "…", total_count: 418, "+1": 347, heart: 71 },
        updated_at: "2026-07-01T00:00:00Z",
        comments: 2,
        created_at: "2026-06-01T00:00:00Z",
        user: { login: "octocat", id: 583231 },
        labels: [{ id: 1, name: "enhancement", color: "a2eeef", description: "…" }],
        state: "open",
      },
    ],
  })
  const { items, total } = parseSearchJson(raw, "issues")
  assert.equal(total, 988)
  assert.equal(items.length, 1)
  assert.deepEqual(items[0], {
    kind: "issue",
    number: 326,
    title: "Support multiple accounts",
    url: "https://github.com/cli/cli/issues/326",
    reactions: 418,
    updatedAt: "2026-07-01T00:00:00Z",
    labels: [{ name: "enhancement", color: "a2eeef" }],
    comments: 2,
    createdAt: "2026-06-01T00:00:00Z",
    author: "octocat",
    // Uppercased, so rows keep the casing the picker's StateIcon has always been handed.
    state: "OPEN",
  })
})

test("parseSearchJson: prs — kind='pr', draft→isDraft, and NO comment badge", () => {
  const raw = JSON.stringify({
    total_count: 2,
    items: [
      {
        number: 13844,
        title: "perf(status): O(1) map lookup",
        html_url: "https://github.com/cli/cli/pull/13844",
        reactions: { total_count: 0 },
        updated_at: "2026-07-10T15:01:40Z",
        // The search API returns a comment count for PRs; the PR row deliberately doesn't show one.
        comments: 7,
        state: "open",
        draft: true,
        pull_request: { url: "…" },
      },
    ],
  })
  const { items } = parseSearchJson(raw, "prs")
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "pr")
  assert.equal(items[0].number, 13844)
  assert.equal(items[0].reactions, 0)
  assert.equal(items[0].comments, undefined)
  assert.equal(items[0].isDraft, true)
})

test("parseSearchJson: skips rows with a bad/missing number; keeps valid ones", () => {
  const raw = JSON.stringify({
    total_count: 4,
    items: [
      { title: "no number" },
      { number: 0, title: "zero" },
      { number: -5, title: "negative" },
      { number: 7, title: "good", html_url: "u", updated_at: "t" },
    ],
  })
  const { items } = parseSearchJson(raw, "issues")
  assert.equal(items.length, 1)
  assert.equal(items[0].number, 7)
})

test("parseSearchJson: unparseable / wrong shape → empty page (never throws)", () => {
  assert.deepEqual(parseSearchJson("not json", "issues"), { items: [], total: 0 })
  assert.deepEqual(parseSearchJson("{}", "issues"), { items: [], total: 0 })
  assert.deepEqual(parseSearchJson("42", "prs"), { items: [], total: 0 })
  // A bare ARRAY is the OLD `gh issue list` shape — it must not be mistaken for a page of results.
  assert.deepEqual(parseSearchJson("[{\"number\":1}]", "issues"), { items: [], total: 0 })
})

test("parseSearchJson: missing string fields default to ''; a missing total falls back to the row count", () => {
  const { items, total } = parseSearchJson(JSON.stringify({ items: [{ number: 3 }, { number: 4 }] }), "issues")
  assert.equal(total, 2)
  assert.equal(items[0].title, "")
  assert.equal(items[0].url, "")
  assert.equal(items[0].updatedAt, "")
  assert.equal(items[0].reactions, 0)
})

// ---- truncateBody ----

test("truncateBody: short body passes through unchanged", () => {
  assert.equal(truncateBody("hello", 5, "issue"), "hello")
})

test("truncateBody: long body is capped with a pointer to the full item", () => {
  const big = "x".repeat(20_000)
  const outIssue = truncateBody(big, 42, "issue")
  assert.ok(outIssue.length < big.length)
  assert.ok(outIssue.includes("[truncated — read full via `gh issue view 42`]"))
  const outPr = truncateBody(big, 99, "pr")
  assert.ok(outPr.includes("[truncated — read full via `gh pr view 99`]"))
})

// ---- prompt templating (renderGithubPrompt) ----

const issue: HydratedIssue = {
  number: 326,
  title: "Support multiple accounts",
  body: "When I switch accounts the token is wrong.",
  url: "https://github.com/cli/cli/issues/326",
  labels: ["enhancement", "auth"],
}

test("renderGithubPrompt: substitutes all tokens + prepends the THREAD tag", () => {
  const tmpl = "Repo {repo} · Issue #{n}: {title}\nURL: {url}\nLabels: {labels}\n--\n{body}"
  const p = renderGithubPrompt(tmpl, "cli/cli", issue, "investigate-cli-cli-326", "issue")
  assert.ok(p.startsWith("THREAD: investigate-cli-cli-326\n\n"))
  assert.ok(p.includes("Repo cli/cli · Issue #326: Support multiple accounts"))
  assert.ok(p.includes("URL: https://github.com/cli/cli/issues/326"))
  assert.ok(p.includes("Labels: enhancement, auth"))
  assert.ok(p.includes("When I switch accounts the token is wrong."))
})

test("renderGithubPrompt: generated compact lead precedes an exact UI boundary; full template remains below it", () => {
  const template = "INTERNAL TEMPLATE\nRepo={repo}\nBody={body}\n<!-- ordinary-custom-comment -->"
  const p = renderGithubPrompt(template, "cli/cli", issue, "investigate-cli-cli-326", "issue")
  const marker = `\n\n${GITHUB_DISPATCH_UI_BOUNDARY}\n\n`
  const cut = p.indexOf(marker)
  assert.notEqual(cut, -1)
  assert.equal(
    p.slice(0, cut),
    "THREAD: investigate-cli-cli-326\n\nInvestigate this issue and make recommendations\n\nIssue #326: Support multiple accounts\nRepository: cli/cli\nURL: https://github.com/cli/cli/issues/326",
  )
  assert.equal(
    p.slice(cut + marker.length),
    "INTERNAL TEMPLATE\nRepo=cli/cli\nBody=When I switch accounts the token is wrong.\n<!-- ordinary-custom-comment -->",
  )
  assert.equal(p.split(GITHUB_DISPATCH_UI_BOUNDARY).length - 1, 1)
})

test("renderGithubPrompt: empty labels render 'none'", () => {
  const p = renderGithubPrompt("Labels: {labels}", "cli/cli", { ...issue, labels: [] }, "s", "issue")
  assert.ok(p.includes("Labels: none"))
})

test("renderGithubPrompt: oversized body is truncated (kind-aware pointer)", () => {
  const pIssue = renderGithubPrompt("{body}", "cli/cli", { ...issue, body: "y".repeat(20_000) }, "s", "issue")
  assert.ok(pIssue.includes("[truncated — read full via `gh issue view 326`]"))
  const pPr = renderGithubPrompt("{body}", "cli/cli", { ...issue, number: 99, body: "y".repeat(20_000) }, "s", "pr")
  assert.ok(pPr.includes("[truncated — read full via `gh pr view 99`]"))
})

test("renderGithubPrompt: single-pass — a {token} INSIDE item content is NOT re-expanded (no injection)", () => {
  // A hostile body/title containing a placeholder must appear verbatim, never re-substituted.
  const evil = { ...issue, title: "{repo}", body: "leak {url} {n} {labels}" }
  const p = renderGithubPrompt("T={title}\nB={body}", "cli/cli", evil, "s", "issue")
  assert.ok(p.includes("T={repo}")) // title's literal "{repo}" survives, not re-expanded to cli/cli
  assert.ok(p.includes("B=leak {url} {n} {labels}")) // body placeholders survive verbatim
})

test("renderGithubPrompt: unknown {placeholder} in the template is left verbatim", () => {
  const p = renderGithubPrompt("known {repo} unknown {frobnicate}", "cli/cli", issue, "s", "issue")
  assert.ok(p.includes("known cli/cli unknown {frobnicate}"))
})

test("DEFAULT_ISSUE_PROMPT: branches on bug vs feature; DEFAULT_PR_PROMPT is the audit template", () => {
  // Issue default instructs classify + both branches.
  assert.ok(/classify/i.test(DEFAULT_ISSUE_PROMPT))
  assert.ok(/if it is a BUG/i.test(DEFAULT_ISSUE_PROMPT))
  assert.ok(/if it is a FEATURE/i.test(DEFAULT_ISSUE_PROMPT))
  assert.ok(/reproduce/i.test(DEFAULT_ISSUE_PROMPT))
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("public API / UX surface"))
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("read-only"))
  // Issue investigations are headed for a fix: NOT a done fence (that reads as complete), but the other
  // fences are the worker's to use — the handback nudges toward a question. Mirrors the contract's
  // bug/issue rule (workerPrompt.ts).
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("```question```"))
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("NOT ```done```"))
  // The defaults are TEMPLATES: they carry {token}s and NOT the THREAD tag (the server prepends it).
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("{repo}") && DEFAULT_ISSUE_PROMPT.includes("{n}"))
  assert.ok(!DEFAULT_ISSUE_PROMPT.includes("THREAD:"))
  // PR default is the adversarial audit template.
  assert.ok(DEFAULT_PR_PROMPT.includes("AUDIT thread"))
  assert.ok(DEFAULT_PR_PROMPT.includes("gh pr diff {n} -R {repo}"))
  assert.ok(DEFAULT_PR_PROMPT.includes("keep CI/bot/merge"))
  assert.ok(DEFAULT_PR_PROMPT.includes("backend wait primitive"))
  assert.ok(DEFAULT_PR_PROMPT.includes("```done```"))
  assert.ok(!DEFAULT_PR_PROMPT.includes("bare rest"))
  assert.ok(!DEFAULT_PR_PROMPT.includes("THREAD:"))
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("gh issue view {n} -R {repo}"))
  assert.ok(DEFAULT_PR_PROMPT.includes("gh pr view {n} -R {repo}"))
})

// The shipped defaults are shaped so a user can rewrite the INSTRUCTIONS without touching the template
// tags: one prose paragraph carrying no tokens at all, then a trailing metadata block that carries every
// one of them. This test is the guard on that split — a {token} creeping back up into the paragraph is
// exactly the regression it exists to catch.
test("the defaults keep every {token} in the trailing metadata block, none in the instruction paragraph", () => {
  for (const [kind, template] of [
    ["issue", DEFAULT_ISSUE_PROMPT],
    ["pr", DEFAULT_PR_PROMPT],
  ] as const) {
    const [instructions, metadata, ...rest] = template.split("\n\n---\n\n")
    assert.equal(rest.length, 0, `${kind}: exactly one metadata block`)
    assert.ok(metadata, `${kind}: has a trailing metadata block`)
    assert.equal(instructions.match(/\{(repo|n|title|url|labels|body)\}/g), null, `${kind}: paragraph is token-free`)
    // ONE unwrapped line: the Settings textarea soft-wraps, so a hard newline at some source column
    // would render ragged in the box the user edits it in.
    assert.ok(!instructions.includes("\n"), `${kind}: instruction paragraph is a single unwrapped line`)
    // ALL SIX tokens live in the block — {body} included, so nobody has to hand-write it to inline the
    // report text (truncateBody caps it, and the UI boundary keeps the visible bubble compact).
    for (const token of PROMPT_TOKENS) {
      assert.ok(metadata.includes(`{${token}}`), `${kind}: metadata block carries {${token}}`)
    }
    // The block ends on the body, so the substituted report text is the last thing the worker reads.
    assert.ok(metadata.trimEnd().endsWith("{body}"), `${kind}: metadata block ends with {body}`)
  }
})

test("DEFAULT_ISSUE_PROMPT renders into a real issue prompt (round-trip through renderGithubPrompt)", () => {
  const p = renderGithubPrompt(DEFAULT_ISSUE_PROMPT, "cli/cli", issue, "investigate-cli-cli-326", "issue")
  assert.ok(p.startsWith("THREAD: investigate-cli-cli-326\n\n"))
  assert.ok(p.includes("Issue #326: Support multiple accounts"))
  assert.ok(p.includes("gh issue view 326 -R cli/cli --comments"))
  assert.ok(p.trimEnd().endsWith("When I switch accounts the token is wrong.")) // body inlined, last
  assert.ok(!p.includes("{repo}") && !p.includes("{n}")) // every token filled
})

const pr: HydratedPr = {
  number: 13844,
  title: "perf(status): O(1) map lookup",
  body: "Replaces the O(n) scan with a map.",
  url: "https://github.com/cli/cli/pull/13844",
  labels: ["external"],
  files: 2,
}

test("DEFAULT_PR_PROMPT renders into a real PR prompt (diff/checks by number)", () => {
  const p = renderGithubPrompt(DEFAULT_PR_PROMPT, "cli/cli", pr, "review-cli-cli-13844", "pr")
  assert.ok(p.startsWith("THREAD: review-cli-cli-13844\n\n"))
  assert.ok(p.includes("PR #13844: perf(status): O(1) map lookup"))
  assert.ok(p.includes("gh pr diff 13844 -R cli/cli"))
  assert.ok(p.includes("gh pr checks 13844 -R cli/cli"))
  assert.ok(p.trimEnd().endsWith("Replaces the O(n) scan with a map.")) // description inlined, last
  assert.ok(p.includes("read-only"))
})

// ---- linked closing PRs ----

function linkNode(number: number, state: string, isDraft = false) {
  return { number, url: `https://github.com/cli/cli/pull/${number}`, state, isDraft }
}

test("summarizeLinkedPrs: an open link is the primary over a merged one (work in flight is the signal)", () => {
  const prs = summarizeLinkedPrs([linkNode(700, "MERGED"), linkNode(812, "OPEN")])
  assert.deepEqual(prs, { count: 2, number: 812, url: "https://github.com/cli/cli/pull/812", state: "OPEN", isDraft: false })
})

test("summarizeLinkedPrs: a merged link is kept when nothing is open", () => {
  assert.deepEqual(summarizeLinkedPrs([linkNode(616, "MERGED")]), {
    count: 1,
    number: 616,
    url: "https://github.com/cli/cli/pull/616",
    state: "MERGED",
    isDraft: false,
  })
})

test("summarizeLinkedPrs: the badge count is what the row shows — every qualifying link, not just the primary", () => {
  assert.equal(summarizeLinkedPrs([linkNode(1, "OPEN"), linkNode(2, "OPEN"), linkNode(3, "MERGED")])?.count, 3)
})

test("summarizeLinkedPrs: a PR closed WITHOUT merging closes nothing — out of the count AND the pick", () => {
  assert.equal(summarizeLinkedPrs([linkNode(590, "CLOSED")]), undefined)
  // …and a closed one alongside an open one neither shadows it nor inflates the count.
  const prs = summarizeLinkedPrs([linkNode(590, "CLOSED"), linkNode(599, "OPEN")])
  assert.equal(prs?.number, 599)
  assert.equal(prs?.count, 1)
})

test("summarizeLinkedPrs: draft state rides along; empty/malformed → undefined, never throws", () => {
  assert.equal(summarizeLinkedPrs([linkNode(601, "OPEN", true)])?.isDraft, true)
  assert.equal(summarizeLinkedPrs([]), undefined)
  assert.equal(summarizeLinkedPrs(undefined), undefined)
  assert.equal(summarizeLinkedPrs("nope"), undefined)
  assert.equal(summarizeLinkedPrs([{ number: 0, state: "OPEN" }]), undefined) // non-positive number
  assert.equal(summarizeLinkedPrs([{ state: "OPEN" }]), undefined) // no number
})

test("linkedPrQuery: one alias per issue, aliases derived from the number alone", () => {
  const q = linkedPrQuery([562, 610])
  assert.ok(q.includes("i562: issue(number: 562)"))
  assert.ok(q.includes("i610: issue(number: 610)"))
  assert.ok(q.includes("closedByPullRequestsReferences"))
})

test("parseLinkedPrJson: maps each alias to its issue number, skipping issues with no link", () => {
  const raw = JSON.stringify({
    data: {
      repository: {
        i562: { number: 562, closedByPullRequestsReferences: { nodes: [linkNode(599, "OPEN")] } },
        i610: { number: 610, closedByPullRequestsReferences: { nodes: [linkNode(616, "MERGED")] } },
        i605: { number: 605, closedByPullRequestsReferences: { nodes: [] } },
      },
    },
  })
  const map = parseLinkedPrJson(raw)
  assert.equal(map.size, 2)
  assert.equal(map.get(562)?.number, 599)
  assert.equal(map.get(610)?.state, "MERGED")
  assert.equal(map.get(605), undefined)
})

test("parseLinkedPrJson: malformed body / null alias / error payload → empty map, never throws", () => {
  assert.equal(parseLinkedPrJson("not json").size, 0)
  assert.equal(parseLinkedPrJson(JSON.stringify({ errors: [{ message: "rate limited" }] })).size, 0)
  assert.equal(parseLinkedPrJson(JSON.stringify({ data: { repository: null } })).size, 0)
  assert.equal(parseLinkedPrJson(JSON.stringify({ data: { repository: { i1: null } } })).size, 0)
})

// ---- effectiveTemplate (settings override vs default fallback) ----

test("effectiveTemplate: unset/blank falls back to the shipped default", () => {
  assert.equal(effectiveTemplate("issue", undefined), DEFAULT_ISSUE_PROMPT)
  assert.equal(effectiveTemplate("issue", ""), DEFAULT_ISSUE_PROMPT)
  assert.equal(effectiveTemplate("issue", "   \n\t "), DEFAULT_ISSUE_PROMPT) // whitespace-only = unset
  assert.equal(effectiveTemplate("pr", undefined), DEFAULT_PR_PROMPT)
  assert.equal(effectiveTemplate("pr", ""), DEFAULT_PR_PROMPT)
})

test("effectiveTemplate: a non-blank override is used verbatim (per kind)", () => {
  assert.equal(effectiveTemplate("issue", "my custom {title}"), "my custom {title}")
  assert.equal(effectiveTemplate("pr", "review {n}"), "review {n}")
})
