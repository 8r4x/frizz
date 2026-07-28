import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AwaitingBackgroundCard, awaitingBackgroundSubject } from "./AwaitingBackgroundCard.tsx"
import type { ThreadView } from "@fray-ui/shared"

// One card, three surfaces. The two things that can silently go wrong are (a) the sentence claiming a
// kind of work that isn't actually live, and (b) the snooze leaking onto a surface that must not offer
// it — so those are what these pin.

const agent = (state: "running" | "stale") => ({ label: "Audit the parser", startedAt: "2026-07-28T09:00:00.000Z", state })
const shell = (state: "running") => ({ label: "vite dev", startedAt: "2026-07-28T09:00:00.000Z", state })
const thread = (subAgents: unknown[], bgShells: unknown[]) =>
  ({ subAgents, bgShells } as unknown as Pick<ThreadView, "subAgents" | "bgShells">)

test("awaitingBackgroundSubject names exactly the work that is RUNNING", () => {
  assert.equal(awaitingBackgroundSubject(thread([agent("running")], [])), "1 sub-agent")
  assert.equal(awaitingBackgroundSubject(thread([agent("running"), agent("running")], [])), "2 sub-agents")
  // A shell-only thread must never claim a sub-agent: a launched dev server is not a child whose
  // result you await, and the neutral noun is what makes the sentence true.
  assert.equal(awaitingBackgroundSubject(thread([], [shell("running")])), "1 background task")
  assert.equal(awaitingBackgroundSubject(thread([], [shell("running"), shell("running")])), "2 background tasks")
  // BOTH kinds live — the case that used to drop the shells behind the agent count entirely.
  assert.equal(awaitingBackgroundSubject(thread([agent("running")], [shell("running")])), "1 sub-agent and 1 background task")
  assert.equal(
    awaitingBackgroundSubject(thread([agent("running"), agent("running")], [shell("running")])),
    "2 sub-agents and 1 background task",
  )
  // A STALE sub-agent is not live work: it must not be counted, and with a live shell beside it the
  // sentence falls back to the shell alone rather than claiming a sub-agent that stopped reporting.
  assert.equal(awaitingBackgroundSubject(thread([agent("stale")], [shell("running")])), "1 background task")
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
