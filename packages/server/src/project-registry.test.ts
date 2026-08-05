import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  deriveSlug,
  findBySlug,
  forgetProject,
  listProjects,
  readRegistry,
  registerProject,
  renameProject,
} from "./project-registry.ts"

const A = "029a30af-f126-40e3-b04c-d80e74e3e090"
const B = "50577e5e-802f-4567-bd0e-cf7cbf3d2ed5"

function sandbox(): string {
  const home = mkdtempSync(join(tmpdir(), "frizz-registry-"))
  mkdirSync(join(home, ".frizz"), { recursive: true }) // legacy collapse root, so data lands under it
  return home
}
/** A directory that looks like a registered project — `.frizz/.id` is what "still exists" means. */
function project(home: string, rel: string, id?: string): string {
  const dir = join(home, rel)
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  if (id) writeFileSync(join(dir, ".frizz", ".id"), `${id}\n`)
  return dir
}

test("a fresh registration takes the directory basename", () => {
  const home = sandbox()
  try {
    const { entry, action } = registerProject({ dir: project(home, "code/frizz", A), id: A }, home)
    assert.equal(action, "created")
    assert.equal(entry?.slug, "frizz")
    assert.equal(findBySlug("frizz", home)?.id, A)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// `~/x/app` and `~/y/app` are both `app`. This is a live case — pullfrog/app is registered today.
test("a generic basename is qualified by its parent", () => {
  const home = sandbox()
  try {
    const { entry } = registerProject({ dir: project(home, "pullfrog/app", A), id: A }, home)
    assert.equal(entry?.slug, "pullfrog-app")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// A URL must never change under someone who bookmarked it.
test("on collision the incumbent keeps its slug and the newcomer is qualified", () => {
  const home = sandbox()
  try {
    const first = registerProject({ dir: project(home, "a/zod", A), id: A }, home)
    assert.equal(first.entry?.slug, "zod")
    const second = registerProject(
      { dir: project(home, "b/zod", B), id: B, remoteOwner: "colinhacks" },
      home,
    )
    assert.equal(second.entry?.slug, "colinhacks-zod")
    assert.equal(findBySlug("zod", home)?.id, A, "the incumbent is untouched")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a slug that would shadow Frizz's own routes is refused", () => {
  const taken = new Set<string>()
  // These are reachable: a repo really can be called `rpc` or `assets`.
  for (const reserved of ["rpc", "assets", "events", "health"]) {
    assert.notEqual(deriveSlug(`/x/${reserved}`, taken), reserved, reserved)
  }
  // `_frizz` itself is unreachable BY CONSTRUCTION — slugify strips the underscore, so a directory
  // named `_frizz` derives `frizz`, and no derived slug can ever begin with one.
  assert.equal(deriveSlug("/x/_frizz", taken), "frizz")
})

test("numeric suffixes carry on once every qualifier is taken", () => {
  const taken = new Set(["zod", "colinhacks-zod", "a-zod"])
  assert.equal(deriveSlug("/a/zod", taken, { remoteOwner: "colinhacks" }), "zod-2")
})

// The whole reason the registry is keyed by id rather than path.
test("a moved project keeps its id, its slug and its threads", () => {
  const home = sandbox()
  try {
    const before = project(home, "old/place", A)
    const first = registerProject({ dir: before, id: A }, home)
    assert.equal(first.entry?.slug, "place")
    rmSync(before, { recursive: true, force: true }) // it moved: the old path is gone

    const after = project(home, "new/place", A)
    const moved = registerProject({ dir: after, id: A }, home)
    assert.equal(moved.action, "moved")
    assert.equal(moved.entry?.slug, "place", "the URL survives the move")
    assert.equal(moved.entry?.path, after)
    assert.equal(readRegistry(home).projects.length, 1, "not a second card")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The one case an id-in-the-tree cannot tell apart on its own — and the registry sees it for free.
test("a copied checkout is detected rather than stealing the original's board", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "orig", A), id: A }, home)
    // `cp -R` brought .frizz/.id along, and the ORIGINAL still exists.
    const copy = project(home, "copy", A)
    const result = registerProject({ dir: copy, id: A }, home)
    assert.equal(result.action, "duplicate")
    assert.equal(result.entry, undefined, "nothing written — the caller mints a fresh id")
    assert.equal(readRegistry(home).projects.length, 1)
    assert.equal(readRegistry(home).projects[0]?.path, join(home, "orig"))

    // With a new id it registers as its own project.
    const reminted = registerProject({ dir: copy, id: B }, home)
    assert.equal(reminted.action, "created")
    assert.equal(readRegistry(home).projects.length, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a directory whose id changed is re-keyed in place", () => {
  const home = sandbox()
  try {
    const dir = project(home, "swap", A)
    registerProject({ dir, id: A }, home)
    const result = registerProject({ dir, id: B }, home)
    assert.equal(result.action, "rekeyed")
    assert.equal(readRegistry(home).projects.length, 1)
    assert.equal(readRegistry(home).projects[0]?.id, B)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the grid gets most-recent-first with dead paths marked stale", () => {
  const home = sandbox()
  try {
    const gone = project(home, "gone", A)
    registerProject({ dir: gone, id: A, now: () => new Date("2026-01-01T00:00:00Z") }, home)
    registerProject(
      { dir: project(home, "live", B), id: B, now: () => new Date("2026-08-01T00:00:00Z") },
      home,
    )
    rmSync(gone, { recursive: true, force: true })

    const listed = listProjects(home)
    assert.equal(listed[0]?.id, B, "most recently opened first")
    assert.equal(listed[0]?.stale, false)
    assert.equal(listed[1]?.stale, true, "the dead path is marked, not silently dropped")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("rename is the escape hatch, and it refuses a reserved or taken slug", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "one", A), id: A }, home)
    registerProject({ dir: project(home, "two", B), id: B }, home)

    assert.equal(renameProject(A, { slug: "Work Stuff" }, home)?.slug, "work-stuff")
    assert.equal(findBySlug("work-stuff", home)?.id, A)
    assert.throws(() => renameProject(A, { slug: "rpc" }, home), /reserved/)
    assert.throws(() => renameProject(A, { slug: "two" }, home), /already uses/)

    assert.equal(renameProject(A, { archived: true }, home)?.archived, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a corrupt registry reads as empty rather than throwing", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "p", A), id: A }, home)
    writeFileSync(join(home, ".frizz", "registry.json"), "{ not json")
    assert.deepEqual(readRegistry(home).projects, [], "an index that cannot be read is rebuilt, not fatal")
    const again = registerProject({ dir: project(home, "p", A), id: A }, home)
    assert.equal(again.action, "created")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("forgetting a project removes exactly one card", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "one", A), id: A }, home)
    registerProject({ dir: project(home, "two", B), id: B }, home)
    assert.equal(forgetProject(A, home), true)
    assert.equal(forgetProject(A, home), false, "idempotent")
    assert.deepEqual(readRegistry(home).projects.map((p) => p.id), [B])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
