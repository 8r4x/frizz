import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadView } from "@fray-ui/shared"
import { HeaderActions } from "./HeaderActions.tsx"
import { TooltipProvider } from "./Tooltip.tsx"
import { offersRetry } from "../groups.ts"

// HeaderActions is rendered by BOTH the queue card and the full thread drawer, so it is the last place
// the Retry verb could disagree with the rail's yellow [!]. It used to: the drawer passed no
// `showExitAction` and the component gated on raw `canRetry`, which ignores `state` — so every ARCHIVED
// exited thread opened with a Retry pill while its rail row showed the muted [✓] (maintainer
// 2026-07-23: "threads that appear to just have come to rest, but they have a retry button and they are
// not yellow. They don't have an exclamation point"). It now gates on `offersRetry`, the same
// derivation as the mark.

const base = { kind: "session", backend: "claude", title: "A worker", status: "active", subAgents: [] } as unknown as ThreadView

function header(extra: Partial<ThreadView>): string {
  const t = { ...base, id: "t", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(HeaderActions, { thread: t, onDone: () => {} })),
  )
}

const RETRY = /aria-label="Retry exited session"/

test("the drawer/queue header offers Retry on a stalled thread — crashed or exited at bare rest", () => {
  for (const [name, extra] of [
    ["exited mid-turn (crashed)", { runtime: "exited", crashed: true, needsYou: true }],
    ["exited at bare rest", { runtime: "exited", crashed: false }],
    ["exited, pre-reload snapshot with no `crashed`", { runtime: "exited", needsYou: true }],
  ] as [string, Partial<ThreadView>][]) {
    assert.match(header(extra), RETRY, `a ${name} thread must offer Retry`)
  }
})

test("an ARCHIVED exited thread gets NO Retry — the 158-thread bug", () => {
  // The exact shape of every exited row on the real board when this was reported. `canRetry` is true
  // (the process IS gone and IS reattachable), but the thread is at rest on purpose, so the header must
  // stay silent and let the composer be the way to reopen it.
  assert.doesNotMatch(header({ runtime: "exited", crashed: true, needsYou: true, state: "archived" }), RETRY)
})

test("no Retry on threads that are live, answered, finished, held, or read-only", () => {
  for (const [name, extra] of [
    ["working", { runtime: "running" }],
    ["live at rest (turn-idle)", { runtime: "turn-idle" }],
    ["exited mid-ask (answer it, don't retry)", { runtime: "exited", crashed: true, humanBlocked: true, status: "needs-human" }],
    ["exited after a done fence", { runtime: "exited", lastFence: { kind: "done", hints: [] } }],
    ["exited but snoozed (held)", { runtime: "exited", snoozedUntil: "2999-01-01T00:00:00.000Z" }],
    ["foreign (read-only)", { runtime: "exited", crashed: true, needsYou: true, foreign: true }],
  ] as [string, Partial<ThreadView>][]) {
    assert.doesNotMatch(header(extra), RETRY, `a ${name} thread must not offer Retry`)
  }
})

test("the header's Retry is DEFINITIONALLY the stalled mark — one predicate, no surface-local gate", () => {
  // Pins the invariant rather than a list: whatever offersRetry says, the rendered header must agree.
  // A future surface-local override (the old `showExitAction` escape hatch) breaks this test first.
  for (const extra of [
    { runtime: "exited", crashed: true, needsYou: true },
    { runtime: "exited", crashed: false },
    { runtime: "exited", crashed: true, state: "archived" },
    { runtime: "exited", lastFence: { kind: "done", hints: [] } },
    { runtime: "turn-idle" },
    { runtime: "running" },
    { runtime: "exited", foreign: true },
  ] as Partial<ThreadView>[]) {
    const t = { ...base, id: "t", ...extra } as ThreadView
    assert.equal(RETRY.test(header(extra)), offersRetry(t), `${JSON.stringify(extra)}: header Retry must equal offersRetry`)
  }
})
