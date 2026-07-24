import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, openSync, closeSync, writeSync, writeFileSync, utimesSync, statSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type Storage, type SessionRow } from "./storage.ts"
import { Bus } from "./bus.ts"
import { createTailer } from "./tailer.ts"
import type { Project } from "./project.ts"
import { createTailStateCache, encodeTailState, decodeTailState, measureFence, fenceMatches } from "./tail-cache.ts"

// The durable prime cache exists to remove the FULL re-fold of every transcript on every boot. Its one
// non-negotiable property is that it can only ever make boot FASTER, never make the derived state
// DIFFERENT — so almost every test here is the same shape: derive a thread's telemetry twice, once
// through a cold fold from byte 0 and once through the cache, and assert the two are identical.

function tmp(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}

const stamp = (n: number) => `2026-07-01T00:00:${String(n).padStart(2, "0")}.000Z`
const user = (n: number, text: string) => JSON.stringify({
  type: "user", timestamp: stamp(n), promptSource: "typed", message: { content: [{ type: "text", text }] },
})
const assistant = (n: number, text: string, stop = "end_turn") => JSON.stringify({
  type: "assistant", timestamp: stamp(n), message: { model: "claude-opus-4-8", stop_reason: stop, content: [{ type: "text", text }] },
})
const title = (t: string) => JSON.stringify({ type: "ai-title", aiTitle: t })

interface Harness {
  dir: string
  storage: Storage
  bus: Bus
  path: (sessionId: string) => string
}

function harness(): Harness {
  const dir = tmp("fray-tailcache-")
  const storage = createStorage(join(dir, "ui.db"))
  return { dir, storage, bus: new Bus(), path: (id) => join(dir, `${id}.jsonl`) }
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "sid", tmux_name: "fray-t", spawned_at: "2026-07-01T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: null, meta: null, seen_at: null, plan_path: null, transcript_id: null, ...over,
  }
}

/** One boot: build a tailer over the harness, prime it, and return the thread's telemetry. */
function boot(h: Harness, over: Partial<Parameters<typeof createTailer>[0]> = {}) {
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => {},
    now: () => Date.parse("2026-07-01T01:00:00.000Z"),
    paneDead: () => true,
    capturePane: () => "",
    sessionLogDir: h.dir,
    ...over,
  })
  t.start()
  const telemetry = t.get("t")
  t.stop()
  return telemetry
}

// Tolerant of the table not existing yet: a boot with the cache disabled never creates it.
const cachedSlugs = (h: Harness): string[] => {
  try {
    return h.storage.db.prepare<[], { slug: string }>("SELECT slug FROM tail_state").all().map((r) => r.slug)
  } catch {
    return []
  }
}

// ---- the codec ----

test("tail-cache codec: round-trips Maps, and every field it was not told about", () => {
  const state = {
    slug: "t", offset: 42, partial: "xy", turn: "idle",
    subAgents: new Map([["toolu_1", { kind: "agent", label: "child", startedAt: stamp(1) }]]),
    // A field the codec has never heard of must survive: the whole point of a generic codec is that
    // the next TailState field cannot be silently dropped by someone forgetting to add it here.
    somethingAddedLater: { nested: [1, 2, 3] },
  }
  const back = decodeTailState(encodeTailState(state))
  assert.ok(back)
  assert.equal(back.offset, 42)
  assert.ok(back.subAgents instanceof Map, "a Map must come back as a Map, not a plain object")
  assert.equal((back.subAgents as Map<string, { label: string }>).get("toolu_1")?.label, "child")
  assert.deepEqual(back.somethingAddedLater, { nested: [1, 2, 3] })
})

test("tail-cache codec: garbage decodes to null rather than throwing", () => {
  assert.equal(decodeTailState("{not json"), null)
  assert.equal(decodeTailState("[1,2,3]"), null)
  assert.equal(decodeTailState("null"), null)
})

// ---- the file fence ----

test("tail-cache fence: an append still matches; a truncation and a same-size rewrite do not", () => {
  const dir = tmp("fray-fence-")
  const path = join(dir, "a.jsonl")
  writeFileSync(path, "aaaa\nbbbb\ncccc\n")
  const at = statSync(path).size
  const fence = measureFence(path, at)
  assert.ok(fence)

  // Appended: the prefix we folded is untouched, so the fence holds and the tailer consumes the delta.
  appendFileSync(path, "dddd\n")
  assert.equal(fenceMatches(fence, measureFence(path, at)!), true)

  // Truncated below the folded prefix: no fence at all (the file cannot supply those bytes).
  writeFileSync(path, "aa\n")
  assert.equal(measureFence(path, at), null)

  // Rewritten IN PLACE to the same length, and the mtime restored, so size+mtime alone would accept
  // it. The content digest is what refuses.
  writeFileSync(path, "aaaa\nbbbb\ncccc\n")
  const before = statSync(path)
  const fd = openSync(path, "r+")
  writeSync(fd, Buffer.from("zzzz"), 0, 4, 0)
  closeSync(fd)
  utimesSync(path, before.atime, before.mtime)
  const rewritten = measureFence(path, at)
  assert.ok(rewritten)
  assert.equal(rewritten.size, fence.size)
  assert.equal(fenceMatches(fence, rewritten), false, "an in-place rewrite must never pass the fence")
  rmSync(dir, { recursive: true, force: true })
})

test("tail-cache fence: an offset of 0 or a missing file has no fence", () => {
  const dir = tmp("fray-fence-")
  const path = join(dir, "a.jsonl")
  writeFileSync(path, "aaaa\n")
  assert.equal(measureFence(path, 0), null)
  assert.equal(measureFence(join(dir, "missing.jsonl"), 10), null)
  rmSync(dir, { recursive: true, force: true })
})

// ---- the whole-boot equivalence property ----

test("tail-cache: a warm boot derives EXACTLY what a cold boot derives", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "working", "tool_use"), assistant(3, "done"), title("a title")].map((l) => l + "\n").join(""))

  const cold = boot(h, { tailCache: null })
  assert.deepEqual(cachedSlugs(h), [], "an explicitly-disabled cache writes nothing")

  const seeding = boot(h)
  assert.deepEqual(seeding, cold, "seeding the cache must not change the derivation")
  assert.deepEqual(cachedSlugs(h), ["t"])

  const warm = boot(h)
  assert.deepEqual(warm, cold, "the cached derivation must equal the cold one")
})

test("tail-cache: a thread whose transcript GREW resumes at the cached offset and lands where a cold fold does", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "first answer")].map((l) => l + "\n").join(""))
  boot(h) // seed the cache at the current size

  appendFileSync(h.path("sid"), [user(3, "again"), assistant(4, "second answer")].map((l) => l + "\n").join(""))
  const warm = boot(h)

  // A fresh project with the SAME final bytes, folded from 0, is the reference.
  const reference = harness()
  reference.storage.upsertSession(row())
  writeFileSync(reference.path("sid"), [user(1, "go"), assistant(2, "first answer"), user(3, "again"), assistant(4, "second answer")].map((l) => l + "\n").join(""))
  assert.deepEqual(warm, boot(reference, { tailCache: null }))
  assert.equal(warm?.lastAssistant, "second answer")
})

test("tail-cache: a REPLACED transcript (same path, new file) is a miss, not a stale hit", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "old answer")].map((l) => l + "\n").join(""))
  boot(h)

  // Rewrite the file wholesale — a different transcript at the same path.
  rmSync(h.path("sid"))
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "brand new answer")].map((l) => l + "\n").join(""))

  const warm = boot(h)
  assert.equal(warm?.lastAssistant, "brand new answer", "the cache must never serve the replaced file's derivation")
})

test("tail-cache: a thread the registry calls DONE still invalidates when its JSONL grows", () => {
  const h = harness()
  // exited + archived: by every registry signal this thread is finished and will never move again.
  h.storage.upsertSession(row({ exited: 1, archived: 1, state: "archived" }))
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "done")].map((l) => l + "\n").join(""))
  boot(h)

  appendFileSync(h.path("sid"), assistant(9, "actually there is more") + "\n")
  assert.equal(boot(h)?.lastAssistant, "actually there is more")
})

test("tail-cache: a different fold schema is ignored, and pruned", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "answer")].map((l) => l + "\n").join(""))
  boot(h)
  assert.deepEqual(cachedSlugs(h), ["t"])

  // A boot whose fold implementation hashes differently must not read the old entries at all: their
  // derivation came from code that no longer exists.
  const cache = createTailStateCache(h.storage.db, "a-different-fold-schema")
  assert.equal(cache.load().size, 0)
  const warm = boot(h, { tailCache: cache })
  assert.equal(warm?.lastAssistant, "answer")
  // Re-seeded under the new schema; the entry from the retired one is gone.
  const remaining = h.storage.db.prepare<[], { fold_schema: string }>("SELECT fold_schema FROM tail_state").all()
  assert.deepEqual([...new Set(remaining.map((r) => r.fold_schema))], ["a-different-fold-schema"])
})

test("tail-cache: a CORRUPT stored state degrades to the full re-read", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "answer")].map((l) => l + "\n").join(""))
  const cold = boot(h, { tailCache: null })
  boot(h)

  h.storage.db.prepare("UPDATE tail_state SET state = ?").run("{ this is not json")
  assert.deepEqual(boot(h), cold, "a corrupt blob must be ignored, not trusted")

  h.storage.db.prepare("UPDATE tail_state SET state = ?").run(JSON.stringify({ offset: 999, partial: "" }))
  assert.deepEqual(boot(h), cold, "a blob whose offset disagrees with its own fence must be ignored")
})

test("tail-cache: a row with an OPEN delivery ledger keeps its full replay", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "answer")].map((l) => l + "\n").join(""))
  h.storage.setDeliveryLedger("t", JSON.stringify([
    { id: "d1", text: "please continue", state: "pending", at: stamp(3), updatedAt: stamp(3) },
  ]))
  boot(h)
  assert.deepEqual(cachedSlugs(h), [], "a thread with follow-ups in flight is never cached")
})

test("tail-cache: an entry for a slug the registry no longer has is pruned", () => {
  const h = harness()
  h.storage.upsertSession(row())
  h.storage.upsertSession(row({ slug: "u", session_id: "sid2", tmux_name: "fray-u" }))
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "a")].map((l) => l + "\n").join(""))
  writeFileSync(h.path("sid2"), [user(1, "go"), assistant(2, "b")].map((l) => l + "\n").join(""))
  boot(h)
  assert.deepEqual(cachedSlugs(h).sort(), ["t", "u"])

  h.storage.forgetSession("u")
  boot(h)
  assert.deepEqual(cachedSlugs(h), ["t"])
})

test("tail-cache: a MISSING table degrades to correct-but-slow rather than throwing", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "answer")].map((l) => l + "\n").join(""))
  const cold = boot(h, { tailCache: null })
  boot(h)
  h.storage.db.exec("DROP TABLE tail_state")
  // The next boot re-creates it; the derivation is unaffected either way.
  assert.deepEqual(boot(h), cold)
})
