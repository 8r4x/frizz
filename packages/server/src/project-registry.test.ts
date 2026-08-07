import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  backfillRegistry,
  deriveSlug,
  findByPath,
  findBySlug,
  forgetProject,
  ICON_SCAN_VERSION,
  listProjects,
  readRegistry,
  registerProject,
  renameProject,
  reorderProjects,
  resolveProjectIcon,
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

/** The registry stores canonical paths, so an expectation built from a temp dir must match. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
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
    assert.equal(moved.entry?.path, canonical(after))
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
    assert.equal(readRegistry(home).projects[0]?.path, canonical(join(home, "orig")))

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

// A machine that has been running Frizz for months arrives at its first grid with ONE card, and the
// only way to fill it would be to visit every repository in a terminal — the chore one server per
// machine exists to end. Everything needed is already on disk.
test("backfill recovers projects from existing state dirs, and refuses to guess", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-backfill-"))
  try {
    const stateDir = (id: string) => join(home, ".frizz", "projects", id)
    const seed = (id: string, dir: string, file = "server.lock") => {
      mkdirSync(stateDir(id), { recursive: true })
      writeFileSync(join(stateDir(id), file), JSON.stringify({ projectDir: dir }))
    }
    const repo = (name: string) => {
      const dir = join(home, name)
      mkdirSync(dir, { recursive: true })
      return dir
    }

    const alpha = repo("alpha")
    const beta = repo("beta")
    const movedAway = join(home, "gone")
    const reidentified = repo("reidentified")

    seed("id-alpha", alpha)
    seed("id-beta", beta, "project-launch.owner") // the other file the launcher leaves
    seed("id-gone", movedAway) // directory no longer exists
    seed("id-stale", reidentified) // the project claims a DIFFERENT id now

    // Stands in for each project's own `.frizz/.id`.
    const claims: Record<string, string> = {
      [canonical(alpha)]: "id-alpha",
      [canonical(beta)]: "id-beta",
      [canonical(reidentified)]: "id-something-else",
    }
    const recovered = backfillRegistry(home, (root) => claims[root])
    assert.equal(recovered, 2)

    const slugs = listProjects(home).map((p) => p.slug).sort()
    assert.deepEqual(slugs, ["alpha", "beta"])
    assert.equal(
      listProjects(home).some((p) => p.path === canonical(movedAway)),
      false,
      "a directory that no longer exists is not a project",
    )
    assert.equal(
      listProjects(home).some((p) => p.path === canonical(reidentified)),
      false,
      "a checkout that claims another id is skipped rather than guessed at",
    )

    // Idempotent: a second pass adds nothing and disturbs nothing.
    assert.equal(backfillRegistry(home, (root) => claims[root]), 0)
    assert.deepEqual(listProjects(home).map((p) => p.slug).sort(), ["alpha", "beta"])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("recency is the default order, and the operator's arrangement replaces it", () => {
  const home = sandbox()
  try {
    const ids = [A, B, "7c1a0000-0000-4000-8000-000000000003"]
    ids.forEach((id, index) => {
      registerProject({ dir: project(home, `code/p${index}`, id), id, now: () => new Date(2026, 0, index + 1) }, home)
    })
    // Newest first while nobody has arranged anything.
    assert.deepEqual(listProjects(home).map((p) => p.id), [ids[2], ids[1], ids[0]])

    reorderProjects([ids[0], ids[2], ids[1]], home)
    assert.deepEqual(listProjects(home).map((p) => p.id), [ids[0], ids[2], ids[1]])
    // EVERY project is pinned, not only the one that moved — a half-ordered list falls back to
    // recency for the rest, and then the tail keeps rearranging itself under the operator.
    assert.deepEqual(readRegistry(home).projects.map((p) => p.order).sort(), [0, 1, 2])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a project registered after an arrangement lands at the end rather than jumping to the top", () => {
  const home = sandbox()
  try {
    registerProject({ dir: project(home, "code/a", A), id: A, now: () => new Date(2026, 0, 1) }, home)
    registerProject({ dir: project(home, "code/b", B), id: B, now: () => new Date(2026, 0, 2) }, home)
    reorderProjects([A, B], home)

    const C = "7c1a0000-0000-4000-8000-00000000000c"
    registerProject({ dir: project(home, "code/c", C), id: C, now: () => new Date(2026, 0, 9) }, home)
    // Newest by a mile, and still last: the operator arranged this list and a newcomer does not get
    // to displace the top of it.
    assert.deepEqual(listProjects(home).map((p) => p.id), [A, B, C])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("reordering a subset keeps the projects it did not name, after the ones it did", () => {
  const home = sandbox()
  try {
    const ids = [A, B, "7c1a0000-0000-4000-8000-000000000003"]
    ids.forEach((id, index) => {
      registerProject({ dir: project(home, `code/p${index}`, id), id, now: () => new Date(2026, 0, index + 1) }, home)
    })
    // A client that was mid-drag when a third project appeared sends only the two it knew about.
    reorderProjects([ids[1], ids[0]], home)
    assert.deepEqual(listProjects(home).map((p) => p.id), [ids[1], ids[0], ids[2]])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// `server.lock` and `project-launch.owner` are LIVENESS records — removed when the server stops. A
// backfill reading only those recovers whatever happened to be running and nothing else, which is why
// boron and pullfrog/app stayed missing from the maintainer's grid even after the identity fix that
// was supposed to find them. `launcher.json` is the one that survives (2026-08-06).
test("backfill recovers a project whose server is STOPPED, not just a running one", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-backfill-stopped-"))
  try {
    const stopped = join(home, "stopped-project")
    const running = join(home, "running-project")
    for (const [id, dir, file] of [["id-stopped", stopped, "launcher.json"], ["id-running", running, "server.lock"]]) {
      mkdirSync(dir, { recursive: true })
      const sd = join(home, ".frizz", "projects", id)
      mkdirSync(sd, { recursive: true })
      writeFileSync(join(sd, file), JSON.stringify({ projectDir: dir }))
    }
    const claims: Record<string, string> = { [canonical(stopped)]: "id-stopped", [canonical(running)]: "id-running" }
    assert.equal(backfillRegistry(home, (root) => claims[root]), 2)
    assert.deepEqual(listProjects(home).map((p) => p.slug).sort(), ["running-project", "stopped-project"])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// A rail rendered the same project twice — `/var/...` and `/private/var/...`, two ids, two slugs —
// because the launcher realpaths and the grid's add path did not. On macOS /var IS a symlink, so this
// is the default state of every temp path, not an edge case (2026-08-06).
test("one directory registers once, whatever spelling of its path a caller uses", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-canonical-"))
  try {
    const real = realpathSync(home)
    const dir = join(real, "project")
    mkdirSync(dir, { recursive: true })
    // The symlinked spelling, if this platform has one; otherwise the same path twice, which still
    // pins that a second registration of one directory is not a second project.
    const alias = join(home, "project")

    const first = registerProject({ dir: alias, id: "id-1" }, home)
    assert.equal(first.action, "created")
    assert.equal(first.entry?.path, canonical(alias), "stored canonically")

    const again = registerProject({ dir, id: "id-1" }, home)
    assert.notEqual(again.action, "created", "the same directory is not a new project")
    assert.equal(listProjects(home).length, 1)

    // And a lookup by either spelling finds it.
    assert.ok(findByPath(dir, home))
    assert.ok(findByPath(alias, home))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a cached 'no icon' is re-asked when the SCANNER changes, not just when it ages out", () => {
  const home = sandbox()
  try {
    const dir = project(home, "code/nub", A)
    registerProject({ dir, id: A }, home)

    // An older scanner concluded there was nothing here, moments ago.
    let asked = 0
    assert.equal(resolveProjectIcon(A, () => { asked++; return undefined }, { home, version: 1 }), undefined)
    assert.equal(asked, 1)

    // Same scanner version → the remembered answer stands, and nothing is re-scanned.
    assert.equal(resolveProjectIcon(A, () => { asked++; return undefined }, { home, version: 1 }), undefined)
    assert.equal(asked, 1, "a fresh answer from the same scanner is not re-asked")

    // A NEWER scanner → asked again immediately, without waiting out the 12-hour retry. This is the
    // difference between shipping a scan fix and shipping it half a day later.
    const found = join(dir, "site", "public", "icon.svg")
    assert.equal(resolveProjectIcon(A, () => { asked++; return found }, { home, version: 2 }), found)
    assert.equal(asked, 2)
    assert.equal(readRegistry(home).projects[0]?.iconScanVersion, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the shipped scan version is what an unversioned cache is compared against", () => {
  const home = sandbox()
  try {
    const dir = project(home, "code/legacy", A)
    registerProject({ dir, id: A }, home)
    // An entry written before versioning existed has no iconScanVersion at all, so it must re-scan.
    let asked = 0
    resolveProjectIcon(A, () => { asked++; return undefined }, { home })
    assert.equal(asked, 1)
    assert.equal(readRegistry(home).projects[0]?.iconScanVersion, ICON_SCAN_VERSION)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
