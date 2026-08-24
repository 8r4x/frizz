import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AwaitingBackgroundCard, awaitingBackgroundSubject } from "./AwaitingBackgroundCard.tsx"
import type { ThreadView } from "@frizz/shared"

// One card, three surfaces, and since 2026-08-15 one TABLE: every kind of live work the thread declared
// gets a row, grouped by kind, with a light-gray status right-justified and a chevron
// (maintainer: "Definitely group them by kind. They should all consistently use the chevron […] and right
// justify the status label").
//
// What these pin is what can silently go wrong: a row claiming work that is not live, a kind losing its
// row entirely (which is how a declared shell watch went unrendered for a day), and the snooze leaking
// onto a surface that must not offer it.

const agent = (state: "running" | "stale") => ({ id: "toolu_a", label: "Audit the parser", subagentType: "frizz:opus-high", startedAt: "2026-07-28T09:00:00.000Z", state })
// A live sub-agent OF a sub-agent (depth 2 = a grandchild, 3 = a great-grandchild).
const nested = (depth: number) => ({ id: `toolu_d${depth}`, label: "Trace the cache key", startedAt: "2026-07-28T09:00:00.000Z", state: "running" as const, depth })
const shell = (state: "running") => ({ id: "toolu_s", taskId: "bzvtnt3ig", label: "vite dev", startedAt: "2026-07-28T09:00:00.000Z", state })
const thread = (subAgents: unknown[], bgShells: unknown[]) =>
  ({ id: "demo-thread", subAgents, bgShells } as unknown as Pick<ThreadView, "id" | "subAgents" | "bgShells">)

// A DECLARED shell wait — what a worker's `watch: <handle>` fence hint becomes server-side.
const shellWatch = (target: string) => ({ id: `shell:demo:${target}`, kind: "shell" as const, target, state: "armed" as const, createdAt: "2026-07-28T09:00:00.000Z" })
const watcher = () => ({ id: "github:t:acme/app#1", kind: "github" as const, target: "acme/app#1", state: "armed" as const, createdAt: "2026-07-28T09:00:00.000Z" })
// An ARMED TIMER — what a `thread_timer` registration becomes server-side (board.fenceWatchViews). The
// fire instant is built off the real clock because the row renders a live countdown against Date.now.
const timerWatch = (inMinutes = 34, prompt = "Re-check: tip quiet, install green") => ({
  id: "timer:demo:tmr_a1",
  kind: "timer" as const,
  target: "tmr_a1",
  state: "armed" as const,
  createdAt: "2026-07-28T09:00:00.000Z",
  timer: { fireAt: new Date(Date.now() + inMinutes * 60_000).toISOString(), prompt },
})

const render = (t: Parameters<typeof AwaitingBackgroundCard>[0]["thread"]) =>
  renderToStaticMarkup(createElement(AwaitingBackgroundCard, { thread: t }))
const text = (t: Parameters<typeof AwaitingBackgroundCard>[0]["thread"]) =>
  render(t).replace(/<[^>]+>/g, "").replace(/&#x27;|&rsquo;/g, "’")

test("awaitingBackgroundSubject names exactly the work that is RUNNING", () => {
  assert.equal(awaitingBackgroundSubject(thread([agent("running")], [])), "1 sub-agent")
  assert.equal(awaitingBackgroundSubject(thread([agent("running"), agent("running")], [])), "2 sub-agents")
  // A shell-only thread must never claim a sub-agent: a launched dev server is not a child whose
  // result you await. The noun is the maintainer's own ("background shells"), matching the title.
  assert.equal(awaitingBackgroundSubject(thread([], [shell("running")])), "1 background shell")
  assert.equal(awaitingBackgroundSubject(thread([], [shell("running"), shell("running")])), "2 background shells")
  // BOTH kinds live — the case that used to drop the shells behind the agent count entirely.
  assert.equal(awaitingBackgroundSubject(thread([agent("running")], [shell("running")])), "1 sub-agent and 1 background shell")
  // A STALE sub-agent is not live work: it must not be counted, and with a live shell beside it the
  // sentence falls back to the shell alone rather than claiming a sub-agent that stopped reporting.
  assert.equal(awaitingBackgroundSubject(thread([agent("stale")], [shell("running")])), "1 background shell")
  // A DESCENDANT — a sub-agent's own sub-agent — rides `subAgents` so the rows can nest, but the
  // sentence says "it dispatched", and this thread's worker dispatched no such thing.
  assert.equal(awaitingBackgroundSubject(thread([agent("running"), nested(2), nested(3)], [])), "1 sub-agent")
})

test("the card carries the snooze ONLY when a surface passes one", () => {
  const withAction = renderToStaticMarkup(
    createElement(AwaitingBackgroundCard, {
      thread: thread([agent("running")], []),
      actions: createElement("button", { type: "button" }, "Snooze"),
    }),
  )
  assert.match(withAction, /Snooze/)
  assert.match(withAction, /<button/)

  // The drawer and the full-screen page pass no action — and must then render no SNOOZE at all, not a
  // disabled or hidden one (maintainer 2026-07-25). They still carry the rows, whose openable ones are
  // themselves buttons, so the assertion is on the verb rather than on the tag.
  const bare = render(thread([agent("running")], []))
  assert.doesNotMatch(bare, /Snooze/)
  // …while still saying the same thing, on the same card chrome, with the same kind header.
  assert.match(bare, /Awaiting/)
  assert.match(bare, /data-awaiting-background/)
  assert.match(bare, /data-wait-kind="agent"/)
})

// THE TITLE NAMES THE SHAPE, and there are two of them (maintainer 2026-08-04: 'the card that says
// "awaiting background work" should be renamed to "background shells running"'). The rename is scoped to
// the rest it describes: a shell-only rest is the one that queues, and it is not awaiting anything.
test("the card's title names the shape: shells running vs awaiting a dispatched result", () => {
  const shellsOnly = text(thread([], [shell("running"), shell("running")]))
  assert.match(shellsOnly, /Background shells running/)
  assert.doesNotMatch(shellsOnly, /Awaiting/)

  const withChild = text(thread([agent("running")], [shell("running")]))
  assert.match(withChild, /Awaiting/)
  assert.doesNotMatch(withChild, /Background shells running/)
})

// ---- ONE ROW PER THING, GROUPED BY KIND ----------------------------------------------------------
test("every kind the thread declared gets a row, under its own heading", () => {
  const t = {
    ...thread([agent("running")], [shell("running")]),
    watches: [shellWatch("bzvtnt3ig"), watcher(), timerWatch()],
  } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  const html = render(t)
  assert.match(html, /data-wait-kind="agent"/)
  assert.match(html, /data-wait-kind="shell"/)
  assert.match(html, /data-wait-kind="github"/)
  assert.match(html, /data-wait-kind="timer"/)
  const body = text(t)
  for (const head of ["Sub-agents", "Background shells", "Pull requests", "Timers"]) assert.match(body, new RegExp(head))
  // MOST-ALIVE FIRST, the order the ops strip already settled: a sub-agent and a shell are running right
  // now, a watched PR is waiting on somebody else, and a timer is waiting on nothing but the clock.
  assert.ok(body.indexOf("Sub-agents") < body.indexOf("Background shells"))
  assert.ok(body.indexOf("Background shells") < body.indexOf("Pull requests"))
  assert.ok(body.indexOf("Pull requests") < body.indexOf("Timers"))
})

// THE FOURTH KIND (maintainer 2026-08-24: this card "enumerates all of the pull requests and the
// background shells … I don't understand why timer isn't represented in the same way"). The row's NAME
// is the timer's own prompt — the id names nothing to a human — and its status counts down to the fire
// instant. Non-interactive by the settled id-less policy: nothing to open, so no chevron and no control.
test("an armed timer gets a row: named by its prompt, counting down, non-interactive", () => {
  const t = { ...thread([], []), watches: [timerWatch()] } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  const body = text(t)
  assert.match(body, /Timers/)
  assert.match(body, /Re-check: tip quiet, install green/)
  assert.match(body, /fires in 3[34]m/)
  const html = render(t)
  assert.doesNotMatch(html, /lucide-chevron-right/, "nothing to open, so no chevron")
  assert.doesNotMatch(html, /<a |<button/, "no dead link and no disabled control either")
  // A DUE-BUT-UNDELIVERED timer (the scheduler's tick runs seconds behind the instant) says so in the
  // present progressive rather than counting to zero or negative.
  assert.match(text({ ...thread([], []), watches: [timerWatch(-1)] } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]), /firing…/)
})

// The kind-naming title is for background shells and NOTHING else: with a timer beside them the card
// holds a Timers group too, and "Background shells running" would name only half the wait.
test("a timer beside running shells takes the generic title", () => {
  const t = { ...thread([], [shell("running")]), watches: [shellWatch("bzvtnt3ig"), timerWatch()] } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.match(text(t), /Awaiting/)
  assert.doesNotMatch(text(t), /Background shells running/)
})

test("a heading never appears over an empty group", () => {
  const agentsOnly = text(thread([agent("running")], []))
  assert.match(agentsOnly, /Sub-agents/)
  assert.doesNotMatch(agentsOnly, /Background shells/)
  assert.doesNotMatch(agentsOnly, /Pull requests/)
})

// A SHELL REACHES THIS CARD ONLY WHEN THE WORKER DECLARED IT — the same rule the server applies to decide
// the card exists at all (board.hasDeclaredWait: "a dev server, a log tail and a test run are the same
// row here, and only the worker knows which of them it is actually resting behind"). This is the bug the
// table fixed: the fence parsed, the server built the `kind: "shell"` row, and the card dropped it.
test("a declared shell gets a row; an undeclared one running beside it does not", () => {
  const declared = {
    ...thread([], [shell("running"), { id: "toolu_x", taskId: "b7k2m1xq0", label: "some other server", startedAt: "2026-07-28T09:00:00.000Z", state: "running" }]),
    watches: [shellWatch("bzvtnt3ig")],
  } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  const body = text(declared)
  assert.match(body, /vite dev/, "the declared shell is named by its label, resolved off its taskId")
  assert.doesNotMatch(body, /some other server/, "an undeclared shell says nothing")

  // NO DECLARATION AT ALL ⇒ no shell rows, whatever is running. (The card still TITLES itself
  // "Background shells running" for that shape — the assertion has to be on the row, not the word.)
  assert.doesNotMatch(render(thread([], [shell("running")])), /data-wait-kind="shell"/)
})

test("a shell watch resolves its label off ANY of the three legal handles", () => {
  for (const target of ["toolu_s", "bzvtnt3ig", "vite dev"]) {
    const t = { ...thread([], [shell("running")]), watches: [shellWatch(target)] } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
    assert.match(text(t), /vite dev/, `${target} should resolve to the shell`)
  }
  // An UNRESOLVABLE target still renders, naming itself — never a vanished wait.
  const orphan = { ...thread([], []), watches: [shellWatch("bzz-nothing")] } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.match(text(orphan), /bzz-nothing/)
})

test("sub-agent rows are DIRECT and RUNNING only", () => {
  const t = thread([agent("running"), agent("stale"), nested(2)], [])
  const html = render(t)
  assert.equal(html.match(/data-wait-kind="agent"/g)?.length, 1)
  assert.doesNotMatch(text(t), /Trace the cache key/, "a grandchild was dispatched by the child, not by this thread")
})

// ---- WHAT THE ROW SAYS ---------------------------------------------------------------------------
test("a row with nothing to open is non-interactive — no chevron, never a disabled control", () => {
  const openable = render({ ...thread([agent("running")], []) } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"])
  assert.match(openable, /lucide-chevron-right/)
  // No id ⇒ nothing to drill into. ChildOpRow's settled policy, applied here.
  const idless = thread([{ label: "Audit the parser", startedAt: "2026-07-28T09:00:00.000Z", state: "running" }], [])
  assert.doesNotMatch(render(idless), /lucide-chevron-right/)
  assert.doesNotMatch(render(idless), /disabled/)
  assert.match(text(idless), /Audit the parser/, "…and the row is still there")
})

test("the sub-agent row says its profile without the dispatch namespace", () => {
  const body = text(thread([agent("running")], []))
  assert.match(body, /opus-high/)
  assert.doesNotMatch(body, /frizz:opus-high/)
})

// THE SENTENCE IS THE FALLBACK NOW, not the content. Every kind has a row, so counting the same things in
// prose above them is one fact written twice — the restatement that made this card busy (2026-08-14).
test("the prose sentence yields to the rows entirely", () => {
  const withRows = text(thread([agent("running")], []))
  assert.doesNotMatch(withRows, /awaiting the results from/)
  assert.doesNotMatch(withRows, /still running\./)
  // …and survives for the one reachable gap: a declared wait whose rows all failed to resolve.
  const noRows = text(thread([agent("stale")], [shell("running")]))
  assert.match(noRows, /1 background shell is still running/)
})

// ---- THE UNIFIED CARD (2026-08-24) ---------------------------------------------------------------
// Maintainer: "the card consist of the rendered message at the top of the card, followed by a
// horizontal divider, followed by all of the awaited items. Then we could put the snooze button in a
// footer." The fence's body used to render as a SEPARATE message above this card; now the card opens
// on it, and FenceCard renders nothing when the card shows.
//
// THE PROSE STRATUM ITSELF IS NOT PINNED HERE: rendering it calls the markdown pipeline, whose
// sanitizer needs a real DOM (lib/markdown.ts), and this file runs under node --test. What CAN be
// pinned DOM-free is everything around it — the divider's coupling to the prose, the machinery
// filter, the done-fence guard, the footer band — and the rendered prose is verified in the browser
// against a real parked worker (scripts/seed-timer-park.mjs).
test("no prose, no divider — and non-prose fences contribute nothing", () => {
  // Rows alone (a bare sub-agent rest has no fence): no seam over nothing.
  const bare = render({ ...thread([agent("running")], []) } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"])
  assert.doesNotMatch(bare, /-mx-4 mt-3 border-t border-border/)
  // A fence whose body is only unparsed machinery lines renders no prose and no divider either —
  // raw fence syntax must never reach the reader (awaitingProseBlock strips it to null).
  const machinery = {
    ...thread([], []),
    watches: [timerWatch()],
    lastFence: { kind: "awaiting", body: "watch: bzvtnt3ig", hints: [] },
  } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.doesNotMatch(render(machinery), /bzvtnt3ig/)
  assert.doesNotMatch(render(machinery), /-mx-4 mt-3 border-t border-border/)
  // A done fence is not a wait — its body must not open this card.
  const done = {
    ...thread([agent("running")], []),
    lastFence: { kind: "done", body: "All landed.", hints: [] },
  } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.doesNotMatch(text(done), /All landed/)
})

test("the snooze renders in a recessed footer band, flush with the card's bottom", () => {
  const t = { ...thread([agent("running")], []) } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  const withAction = renderToStaticMarkup(
    createElement(AwaitingBackgroundCard, { thread: t, actions: createElement("button", { type: "button" }, "Snooze") }),
  )
  assert.match(withAction, /-mx-4 mt-3 flex[^"]*border-t border-border bg-fg/, "the band runs edge to edge under a rule")
  assert.match(withAction, /pb-0/, "the shell yields its bottom padding to the band")
  // No actions => no band and the shell keeps its own padding (the drawer / full-screen shape).
  const bare = render(t)
  assert.doesNotMatch(bare, /pb-0/)
})
