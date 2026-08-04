import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { markDrawerClosing, resolveRoutedThread, store } from "../store.ts"
import { primeRoute } from "./router.ts"

function resetStore(): void {
  store.drawers = []
  store.view = "todos"
  store.routeThreadSlug = null
  store.board = null
}

// A board carrying exactly the fields the routing decision reads.
function boardWith(threads: Array<{ id: string; needsYou?: boolean }>): void {
  store.board = { threads: threads.map((t) => ({ ...t, needsYou: t.needsYou ?? false })) } as unknown as BoardSnapshot
}

// The queue card the URL should land on when the thread is already queued. `null` = no card mounted,
// which is how a non-queued (or not-yet-rendered) thread falls through to the drawer.
function mountQueueCard(slug: string | null): () => void {
  const globals = globalThis as typeof globalThis & { window?: Window; document?: Document; CSS?: typeof CSS }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  const card = {
    getBoundingClientRect: () => ({ top: 300 }),
    querySelector: () => null,
    setAttribute: () => {},
    removeAttribute: () => {},
    offsetWidth: 0,
  }
  globals.CSS = { escape: (value: string) => value } as typeof CSS
  globals.document = {
    querySelector: (selector: string) => (slug !== null && selector.includes(slug) ? card : null),
  } as unknown as Document
  globals.window = {
    scrollY: 0,
    scrollTo: () => {},
    clearTimeout: () => {},
    setTimeout: () => 0,
  } as unknown as Window
  return () => Object.assign(globals, previous)
}

test("primeRoute parks a direct thread route until the board can settle it", () => {
  resetStore()
  primeRoute("/thread/cold-load")
  // No board yet, so no drawer — deciding blind is what stacked a second panel over a queued
  // thread's card. The slug is held instead, and the address bar stays on it.
  assert.equal(store.routeThreadSlug, "cold-load")
  assert.equal(store.drawers.length, 0)
  assert.equal(store.view, "todos")
})

test("a parked route opens the chat drawer once the board says the thread is not queued", () => {
  resetStore()
  primeRoute("/thread/cold-load")
  boardWith([{ id: "cold-load" }])
  const restore = mountQueueCard(null)
  try {
    resolveRoutedThread()
  } finally {
    restore()
  }
  assert.deepEqual(
    store.drawers.map(({ kind, slug, routed }) => ({ kind, slug, routed })),
    [{ kind: "thread", slug: "cold-load", routed: true }],
  )
  assert.equal(store.routeThreadSlug, null)
})

test("a parked route for a QUEUED thread lands on its card instead of a second panel", () => {
  resetStore()
  primeRoute("/thread/queued-thread")
  boardWith([{ id: "queued-thread", needsYou: true }])
  const restore = mountQueueCard("queued-thread")
  try {
    resolveRoutedThread()
  } finally {
    restore()
  }
  // The queue card IS the thread's panel. A drawer over it renders the identical thing twice.
  assert.equal(store.drawers.length, 0)
  assert.equal(store.routeThreadSlug, null)
})

test("a queued thread with no card mounted still falls through to the drawer", () => {
  resetStore()
  primeRoute("/thread/queued-thread")
  boardWith([{ id: "queued-thread", needsYou: true }])
  const restore = mountQueueCard(null)
  try {
    resolveRoutedThread()
  } finally {
    restore()
  }
  assert.equal(store.drawers.length, 1)
  assert.equal(store.drawers[0]?.slug, "queued-thread")
})

test("resolveRoutedThread is inert without a board or a parked slug", () => {
  resetStore()
  resolveRoutedThread()
  assert.equal(store.drawers.length, 0)

  primeRoute("/thread/no-board")
  resolveRoutedThread()
  assert.equal(store.routeThreadSlug, "no-board", "a board-less resolve must not consume the parked slug")
  assert.equal(store.drawers.length, 0)
})

test("primeRoute is idempotent for the current direct thread and decodes its slug", () => {
  resetStore()
  primeRoute("/thread/a%20thread")
  primeRoute("/thread/a%20thread")
  assert.equal(store.routeThreadSlug, "a thread")
  assert.equal(store.drawers.length, 0)
})

test("priming the queue unwinds a routed drawer without leaving a phantom", () => {
  resetStore()
  primeRoute("/thread/cold-load")
  boardWith([{ id: "cold-load" }])
  const restore = mountQueueCard(null)
  try {
    resolveRoutedThread()
  } finally {
    restore()
  }
  assert.equal(store.drawers.length, 1)

  primeRoute("/")
  assert.equal(store.drawers.length, 0)
  assert.equal(store.routeThreadSlug, null)
  assert.equal(store.view, "todos")
})

test("a direct route reopens the closing layer instead of appending a duplicate", () => {
  resetStore()
  boardWith([{ id: "rapid-forward" }])
  const restore = mountQueueCard(null)
  try {
    primeRoute("/thread/rapid-forward")
    resolveRoutedThread()
    const closingId = store.drawers[0]?.id
    assert.ok(closingId)
    markDrawerClosing(closingId)

    primeRoute("/thread/rapid-forward")
    resolveRoutedThread()
  } finally {
    restore()
  }

  assert.equal(store.drawers.length, 1)
  assert.deepEqual(
    Object.fromEntries(Object.entries(store.drawers[0] ?? {}).filter(([key]) => ["kind", "slug", "routed", "closing"].includes(key))),
    { kind: "thread", slug: "rapid-forward", routed: true },
  )
})

test("landing on a thread already in the stack unwinds above it and parks nothing", () => {
  resetStore()
  boardWith([{ id: "below" }, { id: "above" }])
  const restore = mountQueueCard(null)
  try {
    primeRoute("/thread/below")
    resolveRoutedThread()
    primeRoute("/thread/above")
    resolveRoutedThread()
  } finally {
    restore()
  }
  // The one-drawer policy replaced `below`, so re-landing on it is a fresh park, not an unwind.
  primeRoute("/thread/above")
  assert.equal(store.routeThreadSlug, null, "the surface it asks for is already up")
  assert.equal(store.drawers.filter((d) => !d.closing).length, 1)
})

test("malformed percent escapes fall back to Queue instead of throwing before mount", () => {
  resetStore()
  primeRoute("/thread/existing")
  assert.doesNotThrow(() => primeRoute("/thread/%"))
  assert.equal(store.drawers.length, 0)
  assert.equal(store.routeThreadSlug, null)
  assert.equal(store.view, "todos")

  assert.doesNotThrow(() => primeRoute("/status/%"))
  assert.equal(store.view, "todos")
})
