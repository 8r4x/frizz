import { test } from "node:test"
import assert from "node:assert/strict"
import type { TranscriptMessage, TranscriptPage } from "@fray-ui/shared"
import {
  captureTranscriptViewportAnchor,
  prependEarlierPage,
  previousUserBoundary,
  reconcileLatestPage,
  reconcileLiveMessages,
  resolveVisibleStart,
  restoreTranscriptViewportAnchor,
  transcriptAnchorScrollDelta,
} from "./transcriptPagination.ts"

const message = (role: "user" | "assistant", sourceId: string): TranscriptMessage => ({
  sourceId,
  role,
  text: sourceId,
  tools: [],
  parts: [],
})

const page = (ids: Array<["user" | "assistant", string]>, overrides: Partial<TranscriptPage> = {}): TranscriptPage => ({
  messages: ids.map(([role, id]) => message(role, id)),
  beforeCursor: null,
  hasEarlier: false,
  reachedTurnBoundary: true,
  transcriptKey: "transcript-A",
  ...overrides,
})

test("client boundary selection handles first-visible assistant, user, consecutive users, and no prior user", () => {
  const messages = [message("user", "u0"), message("assistant", "a0"), message("user", "u1"), message("user", "u2"), message("assistant", "a2")]
  assert.equal(previousUserBoundary(messages, 4), 3, "assistant-visible start steps to preceding user")
  assert.equal(previousUserBoundary(messages, 3), 2, "user-visible start steps to user immediately before it")
  assert.equal(previousUserBoundary(messages, 2), 0)
  assert.equal(previousUserBoundary([message("assistant", "event")], 1), 0, "no user reveals the remaining prefix")
  assert.equal(previousUserBoundary(messages, 0), null)
})

test("client prepend is gap-free/idempotent across a repeated response", () => {
  const current = { ...page([["user", "u2"], ["assistant", "a2"]], { beforeCursor: "cursor-2", hasEarlier: true }) }
  const earlier = page([["user", "u1"], ["assistant", "a1"]], { beforeCursor: "cursor-1", hasEarlier: true })
  const once = prependEarlierPage(current, earlier)
  const twice = prependEarlierPage(once, earlier)
  assert.deepEqual(twice.messages.map((m) => m.sourceId), ["u1", "a1", "u2", "a2"])
  assert.equal(twice.beforeCursor, "cursor-1")
})

test("client latest reconciliation retains loaded history across concurrent append and refreshes overlap", () => {
  const loaded = prependEarlierPage(
    page([["user", "u2"], ["assistant", "a2-old"]], { beforeCursor: "cursor-2", hasEarlier: true }),
    page([["user", "u1"], ["assistant", "a1"]], { beforeCursor: "cursor-1", hasEarlier: true }),
  )
  const incoming = page([["user", "u2"], ["assistant", "a2-old"], ["user", "u3"], ["assistant", "a3"]], { beforeCursor: "new-window", hasEarlier: true })
  const reconciled = reconcileLatestPage(loaded, incoming)
  assert.deepEqual(reconciled.messages.map((m) => m.sourceId), ["u1", "a1", "u2", "a2-old", "u3", "a3"])
  assert.equal(reconciled.beforeCursor, "cursor-1")
})

test("client transcript replacement discards loaded history instead of mixing sessions", () => {
  const loaded = { ...page([["user", "old-u"], ["assistant", "old-a"]]), historyLoaded: true }
  const replacement = page([["user", "new-u"], ["assistant", "new-a"]], { transcriptKey: "transcript-B" })
  assert.deepEqual(reconcileLatestPage(loaded, replacement).messages.map((m) => m.sourceId), ["new-u", "new-a"])
})

test("an expanded queue card whose start message was trimmed away keeps showing what is still held", () => {
  const messages = [message("user", "u1"), message("assistant", "a1"), message("user", "u2"), message("assistant", "a2")]
  const lastUserIdx = 2
  // Ordinary case: the reader expanded back to u1 and u1 is still in the window.
  assert.equal(resolveVisibleStart(messages, "u1", lastUserIdx), 0)
  // Unexpanded: the default window is the latest turn.
  assert.equal(resolveVisibleStart(messages, null, lastUserIdx), lastUserIdx)
  // THE TRIM: the reader expanded back to a message the 300-cap window has since dropped. Falling back to
  // `lastUserIdx` would silently collapse the card they had just expanded; keep the whole held window.
  assert.equal(resolveVisibleStart(messages, "trimmed-away", lastUserIdx), 0)
})

// A push carries messages only, so the envelope can only survive by being carried over. On a thread past
// the server's MAX_MESSAGES cap the window SLIDES on every new message, which used to take the
// envelope-dropping branch and silently cost the reader `hasEarlier`/`beforeCursor`/`transcriptKey` — i.e.
// the "Load earlier messages" affordance and the only route back to the history the slide just trimmed.
test("a live push against a SLID window keeps the page envelope", () => {
  const held = {
    ...page([["user", "u1"], ["assistant", "a1"], ["user", "u2"], ["assistant", "a2"]], { beforeCursor: "cursor-1", hasEarlier: true }),
    historyLoaded: false,
  }
  // The window moved on by two: u1/a1 fell off the head, u3/a3 arrived at the tail.
  const pushed = [message("user", "u2"), message("assistant", "a2"), message("user", "u3"), message("assistant", "a3")]
  const next = reconcileLiveMessages(held, pushed) as typeof held
  assert.deepEqual(next.messages.map((m) => m.sourceId), ["u2", "a2", "u3", "a3"])
  assert.equal(next.hasEarlier, true, "a slid window has MORE earlier history, not less")
  assert.equal(next.beforeCursor, "cursor-1")
  assert.equal(next.transcriptKey, "transcript-A")
})

test("a live push with no overlap at all is a session replacement and discards the window", () => {
  const held = { ...page([["user", "old-u"], ["assistant", "old-a"]], { hasEarlier: true }), historyLoaded: false }
  const next = reconcileLiveMessages(held, [message("user", "new-u")])
  assert.deepEqual(next.messages.map((m) => m.sourceId), ["new-u"])
  assert.equal((next as { hasEarlier?: boolean }).hasEarlier, undefined, "nothing of the old world is carried over")
})

test("a live push against a slid window still splices in explicitly loaded history", () => {
  const loaded = {
    ...page([["user", "u1"], ["assistant", "a1"], ["user", "u2"], ["assistant", "a2"]], { beforeCursor: "cursor-1", hasEarlier: true }),
    historyLoaded: true,
  }
  const pushed = [message("user", "u2"), message("assistant", "a2"), message("user", "u3")]
  const next = reconcileLiveMessages(loaded, pushed) as typeof loaded
  assert.deepEqual(next.messages.map((m) => m.sourceId), ["u1", "a1", "u2", "a2", "u3"])
  assert.equal(next.beforeCursor, "cursor-1")
})

test("scroll-anchor restoration applies the exact post-prepend top delta", () => {
  let top = 240
  const node = {
    dataset: { transcriptSourceId: "u2" },
    getBoundingClientRect: () => ({ top, bottom: top + 40 }),
  }
  const root = { querySelectorAll: () => [node] }
  const anchor = captureTranscriptViewportAnchor(root as unknown as HTMLElement)
  assert.deepEqual(anchor, { sourceId: "u2", top: 240 })
  top = 910
  let correction = 0
  assert.equal(restoreTranscriptViewportAnchor(root as unknown as HTMLElement, anchor, (delta) => { correction = delta }), true)
  assert.equal(correction, 670)
  assert.equal(transcriptAnchorScrollDelta(240, 910), 670)
})

test("scroll-anchor skips the pinned (sticky) user message and anchors on a natural-flow node", () => {
  // The pinned band comes first in DOM order and — being sticky — sits at the pane top with an
  // invariant rect, which would otherwise win as the anchor and zero out every load-earlier delta.
  const sticky = {
    dataset: { transcriptSourceId: "u-pinned", transcriptSticky: "true" },
    getBoundingClientRect: () => ({ top: 12, bottom: 60 }),
  }
  const flow = {
    dataset: { transcriptSourceId: "a1" },
    getBoundingClientRect: () => ({ top: 300, bottom: 360 }),
  }
  const root = { querySelectorAll: () => [sticky, flow] }
  const anchor = captureTranscriptViewportAnchor(root as unknown as HTMLElement)
  assert.deepEqual(anchor, { sourceId: "a1", top: 300 })
})
