# Watchers beyond GitHub — what Linear and GitLab would take

Status: assessment, written 2026-09-14 alongside the GitHub issue watcher (`mcp__frizz__watch_issue`, commit `7a274712` and the follow-ups on `main`). Nothing here is built. The maintainer's framing: "a similar structure where we require the user to be signed in to their respective CLIs."

## What a watcher is made of today

The GitHub issue watcher was built by threading one new `kind` through every layer the PR watcher already had. Those layers are the checklist for any further provider, and each one is a place a second provider would either reuse or fork:

| Layer | Where it lives | GitHub PR | GitHub issue (2026-09-14) |
| --- | --- | --- | --- |
| Registry row | `pr_watch` (`storage.ts`): `kind`, `owner`, `repo`, `number`, `cursor`, `expires_at` | `kind='pull'` | `kind='issue'`, same columns |
| Ref grammar | `awaiting.ts` `parsePrRef` / `parseIssueRef` | `owner/repo#N`, `/pull/N` URL | `owner/repo#N`, `/issues/N` URL |
| Registration probe | `scheduler.ts` `probePrReadable` / `probeIssueReadable` | `gh pr view` | `gh issue view`, refuses a PR number |
| Fetch | `github-review.ts`, one batched GraphQL request per tick, token from `gh auth token` | `pullRequest(number:)` fragment | `issue(number:)` fragment in the same batch |
| Diff and report | `scheduler.ts` `evalPrWatches` / `evalIssueWatch`: cursor of seen ids plus baselines, one undelivered report, re-mint | CI verdict, reviews, comments, labels, conflicts, reviewers, merge/close | comments, labels, assignees, close with reason |
| Wake text | `@frizz/shared` `prWatchWakeMessage` / `issueWatchWakeMessage`, parsed back by the chat's divider parsers | | same line shapes on purpose |
| Status book | `awaiting.ts` `GITHUB_STATUS_SETTING` / `GITHUB_ISSUE_STATUS_SETTING` | `GithubWatchStatus` | `GithubIssueStatus` |
| Board row | `board.ts` `fenceWatchViews`: `kind: "github"`, `subject: pull \| issue` | checks glyph, counts | issue glyph, "Open · N comments" |
| Fence key | `prs:` / `issues:` → hint kinds `pr` / `issue`, checked against the registry | | |
| Worker tool | `frizz-mcp.mjs` `watch_pr` / `watch_issue`, both over `addOwnPrWatch` / `dropOwnPrWatch` / `listOwnPrWatches` | | `kind: "issue"` on the add |
| Everything that names kinds | `activity`, `done` blockers, the sign-off nudge, the park corrections, `workerPrompt.ts`, the `gh` skill | | |

The row and the RPCs are GitHub-shaped: `owner`, `repo` and an integer `number`. That is the one thing a second provider cannot reuse as-is, and it is the first thing to change.

## The generalization to do first

Before a second provider, turn the registry into a provider-generic one and put the GitHub code behind an interface. Doing it as part of the first non-GitHub watcher is how the tmux vocabulary outlived tmux: the second provider would be bolted onto GitHub's row and column names and every later reader would have to know that `owner/repo#N` sometimes means `TEAM-123`.

- **Row.** Add `provider TEXT NOT NULL DEFAULT 'github'` and `target TEXT` (the normalized ref, opaque to storage) to `pr_watch`; GitHub keeps writing `owner`/`repo`/`number` and the other providers leave them null. The table keeps its name; renaming buys nothing and touches 60 call sites.
- **Interface.** One `WatchProvider` per provider: `parseRef(kind, text) → target | undefined`, `probe(target) → PrProbe`, `fetchBatch(targets) → Map<target, snapshot | failure>`, `diff(cursor, snapshot) → { changes, settled, status }`, `wake(...)`. `evalPrWatches` becomes a loop over providers; the GitHub implementation is the existing code moved, not rewritten. The issue watcher already shows every seam this interface cuts at (the `kind === "issue"` branches in the fetch, the eval, the probe and the views).
- **Status.** One status book per provider, or one book keyed by `provider:target` with a per-provider reading schema. The board row gains `provider`, and the web branches its glyph, its link and its status line on it. GitHub hovercards stay GitHub-only.
- **Fence and tools.** Either one key per provider-kind (`mrs:`, `linear:`) or one `watches:` key with prefixed refs (`gitlab:group/project!12`). The per-kind keys match what exists; the prefixed form scales better and is what the `activity` readout would print either way. Decide once, before the first non-GitHub key ships.

That refactor is roughly the size of the issue watcher itself: it moves code rather than writing it, but it touches the same 24 files.

## GitLab — the close cousin

**Auth: fits the premise exactly.** `glab` is GitLab's official CLI; `glab auth token` prints the token the way `gh auth token` does, and `glab config get host` names the instance, so self-hosted GitLab comes for free. A registration probe is `glab mr view <iid> -R group/project` or `glab issue view`.

**Refs.** `group/project!12` for a merge request, `group/project#12` for an issue, and the `/-/merge_requests/12` and `/-/issues/12` URL forms. Project paths can carry subgroups (`group/sub/project`), which is why the row needs an opaque `target` rather than `owner`/`repo`.

**Fetch.** GitLab's GraphQL endpoint (`<host>/api/graphql`) takes aliased fields like GitHub's, so the one-request-per-tick batching carries over: `project(fullPath:) { mergeRequest(iid:) { state mergedAt headPipeline { status } approvedBy { nodes { username } } notes(last: 50) { ... } labels { nodes { title } } reviewers { nodes { username } } detailedMergeStatus } }` and `issue(iid:) { state closedAt notes labels assignees }`. Rate limiting is by response headers (`RateLimit-Remaining`, `RateLimit-Reset`) rather than a `rateLimit` field, so the budget guard reads headers instead of the body.

**Report.** A merge request maps onto the PR report almost one-to-one: pipeline status is the CI verdict (a pipeline is one status, not a rollup of checks, so "which job failed" needs `headPipeline { jobs(statuses: FAILED) }`), approvals are reviews, notes are comments, `detailedMergeStatus: CONFLICT` is the conflict clause, and the close/merge settles. A GitLab issue is the GitHub issue report with `notes` for `comments`. The wake text can reuse the GitHub composers with the noun swapped, and the chat's divider parsers would need the `!12` ref shape added to `WAKE_REF`.

**Size.** About the issue watcher again on top of the generalization: the fetcher and the probe are new, the diff and the wake are ports, the web gets a GitLab glyph and link. Call it two to three days of agent work including the refactor, with the real-runtime check needing a `glab`-authenticated account and a project the server can read.

## Linear — smaller surface, weaker premise

**Auth: the premise does not quite hold.** Linear ships no official CLI. The community ones (`linear-cli`, `lin`, a few npm packages) each keep their own config, none of them is the thing a user is reliably "signed in to", and Linear's own supported path is a personal API key or an OAuth app. The honest shape is `LINEAR_API_KEY` in the server's environment (or a `~/.frizz` setting), with the registration probe refusing when it is unset, rather than reading a CLI's config file. That is a different story from `gh`/`glab` and should be said in the tool description.

**Refs.** `TEAM-123` identifiers, and `https://linear.app/<workspace>/issue/TEAM-123/<slug>` URLs. String identifiers, so again the opaque `target` column.

**Fetch.** Linear's GraphQL API accepts the identifier directly: `issue(id: "TEAM-123") { state { name type } title comments(last: 50) { nodes { id body createdAt url user { name } } } labels { nodes { name } } assignee { name } priority history(last: 20) { nodes { fromState { name } toState { name } createdAt } } }`. Aliased batching works. The rate limit is complexity-based per API key; the guard would read `X-Complexity` and `X-RateLimit-*` headers.

**Report.** Comments and labels as for a GitHub issue; assignee changes; and state transitions, which on Linear are the whole point — `Backlog → In Progress → Done` is what a worker waiting on triage wants to hear. Workflow states are per-team and named freely, but every state carries a `type` (`backlog`, `unstarted`, `started`, `completed`, `canceled`), so "settle when `type` is `completed` or `canceled`" is stable across teams. Priority changes are a fifth reportable thing GitHub has no equivalent of.

**Size.** Smaller than GitLab in code (one subject, no CI, no merge) but it needs the new status shape, the new auth source and a decision on where the key lives. One to two days on top of the generalization; the real-runtime check needs a Linear workspace and a key, which this repo has no fixture for.

## Recommendation

1. Do the generalization first, as its own effort, moving GitHub behind the provider interface with no behaviour change. It is the part that gets harder every time a provider lands without it.
2. GitLab second, because its CLI fits the sign-in premise exactly and its report is a port of GitHub's.
3. Linear third, once the key-source question is settled; without an official CLI its "signed in" story is an environment variable, and that should be a deliberate choice rather than an accident of which community CLI happened to be installed.
