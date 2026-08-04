import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AwaitingBackgroundCard, awaitingBackgroundSubject } from "./AwaitingBackgroundCard.tsx"
import type { ThreadView } from "@frizz/shared"

// One card, three surfaces. The two things that can silently go wrong are (a) the sentence claiming a
// kind of work that isn't actually live, and (b) the snooze leaking onto a surface that must not offer
// it — so those are what these pin.

const agent = (state: "running" | "stale") => ({ label: "Audit the parser", startedAt: "2026-07-28T09:00:00.000Z", state })
// A live sub-agent OF a sub-agent (depth 2 = a grandchild, 3 = a great-grandchild).
const nested = (depth: number) => ({ label: "Trace the cache key", startedAt: "2026-07-28T09:00:00.000Z", state: "running" as const, depth })
const shell = (state: "running") => ({ label: "vite dev", startedAt: "2026-07-28T09:00:00.000Z", state })
const thread = (subAgents: unknown[], bgShells: unknown[]) =>
  ({ subAgents, bgShells } as unknown as Pick<ThreadView, "subAgents" | "bgShells">)

test("awaitingBackgroundSubject names exactly the work that is RUNNING", () => {
  assert.equal(awaitingBackgroundSubject(thread([agent("running")], [])), "1 sub-agent")
  assert.equal(awaitingBackgroundSubject(thread([agent("running"), agent("running")], [])), "2 sub-agents")
  // A shell-only thread must never claim a sub-agent: a launched dev server is not a child whose
  // result you await. The noun is the maintainer's own ("background shells"), matching the title.
  assert.equal(awaitingBackgroundSubject(thread([], [shell("running")])), "1 background shell")
  assert.equal(awaitingBackgroundSubject(thread([], [shell("running"), shell("running")])), "2 background shells")
  // BOTH kinds live — the case that used to drop the shells behind the agent count entirely.
  assert.equal(awaitingBackgroundSubject(thread([agent("running")], [shell("running")])), "1 sub-agent and 1 background shell")
  assert.equal(
    awaitingBackgroundSubject(thread([agent("running"), agent("running")], [shell("running")])),
    "2 sub-agents and 1 background shell",
  )
  // A STALE sub-agent is not live work: it must not be counted, and with a live shell beside it the
  // sentence falls back to the shell alone rather than claiming a sub-agent that stopped reporting.
  assert.equal(awaitingBackgroundSubject(thread([agent("stale")], [shell("running")])), "1 background shell")
  // A DESCENDANT — a sub-agent's own sub-agent — rides `subAgents` so the rows can nest, but the
  // sentence says "it dispatched", and this thread's worker dispatched no such thing. Counting it would
  // make the card claim work the agent never launched.
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

  // The drawer and the full-screen page pass no action — and must then render no button at all, not a
  // disabled or hidden one (maintainer 2026-07-25).
  const bare = renderToStaticMarkup(
    createElement(AwaitingBackgroundCard, { thread: thread([agent("running")], []) }),
  )
  assert.doesNotMatch(bare, /<button/)
  assert.doesNotMatch(bare, /Snooze/)
  // …while still saying the same thing, on the same card chrome, with the same kind header.
  assert.match(bare, /Awaiting background work/)
  assert.match(bare, /has come to rest/)
  assert.match(bare, /data-awaiting-background/)
})

// THE TITLE NAMES THE SHAPE, and there are two of them (maintainer 2026-08-04: 'the card that says
// "awaiting background work" should be renamed to "background shells running"'). The rename is scoped to
// the rest it describes: a shell-only rest is the one that queues, and it is not awaiting anything. A
// rest on a live sub-agent IS awaiting a result and never mentions shells it did not launch, so it keeps
// the older title on the drawer/full-screen surfaces where it still renders.
test("the card's title names the shape: shells running vs awaiting a dispatched result", () => {
  const text = (t: Parameters<typeof AwaitingBackgroundCard>[0]["thread"]) =>
    renderToStaticMarkup(createElement(AwaitingBackgroundCard, { thread: t })).replace(/<[^>]+>/g, "").replace(/&#x27;|&rsquo;/g, "’")

  const shellsOnly = text(thread([], [shell("running"), shell("running")]))
  assert.match(shellsOnly, /Background shells running/)
  assert.doesNotMatch(shellsOnly, /Awaiting background work/)

  const withChild = text(thread([agent("running")], [shell("running")]))
  assert.match(withChild, /Awaiting background work/)
  assert.doesNotMatch(withChild, /Background shells running/)
})

// THE SENTENCE HAS TO AGREE WITH THE RAIL. Since 2026-08-01 the rail draws two different marks for the
// two kinds of live own work — a dispatched sub-agent spins (it will return and re-invoke the parent), a
// background shell pulses (it never returns anything) — and this card is the WORDS for the same state,
// now its only worded surface. "Awaiting the results from a dev server" describes a wait that is not
// happening, so a shell-only rest gets its own verb.
test("the card's verb matches what is actually running: results are AWAITED, a shell is merely LEFT running", () => {
  const render = (t: Parameters<typeof AwaitingBackgroundCard>[0]["thread"]) =>
    renderToStaticMarkup(createElement(AwaitingBackgroundCard, { thread: t })).replace(/<[^>]+>/g, "").replace(/&#x27;|&rsquo;/g, "’")

  const agentsOnly = render(thread([agent("running")], []))
  assert.match(agentsOnly, /awaiting the results from 1 sub-agent it dispatched/)
  assert.match(agentsOnly, /when the work comes back/)

  const shellsOnly = render(thread([], [shell("running"), shell("running")]))
  assert.match(shellsOnly, /it left 2 background shells running/)
  assert.match(shellsOnly, /resumes on its own when one of them finishes/)
  // ONE shell is the common case on a real board, and "one of them" is false of it.
  const oneShell = render(thread([], [shell("running")]))
  assert.match(oneShell, /it left 1 background shell running. It resumes on its own when it finishes/)
  assert.doesNotMatch(shellsOnly, /awaiting the results/, "a launched shell returns nothing to await")
  // AND IT MUST NOT SAY "returns to the queue": since 2026-08-04 this card IS the queue card for a
  // shell-only rest, so promising the human it will arrive where they are already looking is the one
  // sentence that cannot be true here.
  assert.doesNotMatch(shellsOnly, /returns to the queue/)

  // BOTH live → there IS something to await, so the dispatch sentence wins and still names the shells.
  // That shape is excused from the queue, so "returns to the queue" is still the true promise for it.
  const both = render(thread([agent("running")], [shell("running")]))
  assert.match(both, /awaiting the results from 1 sub-agent and 1 background shell it dispatched/)
  assert.match(both, /returns to the queue on its own/)
})
