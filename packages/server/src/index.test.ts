import assert from "node:assert/strict"
import { test } from "node:test"
import { splitTenantRequest, unknownProjectPage } from "./index.ts"

// A project slug and one of Frizz's own route names occupy the same position, so `/_frizz/rpc/board`
// and `/_frizz/nub/rpc/board` are indistinguishable until you know which slugs exist. The registry
// settles it — and cannot be ambiguous, because it refuses to mint a slug that shadows a route name.
test("splitTenantRequest tells a project slug from one of Frizz's own routes", () => {
  const known = (s: string) => ["nub", "frizz", "pullfrog-app"].includes(s)

  assert.deepEqual(splitTenantRequest("/_frizz/nub/rpc/board", known), {
    slug: "nub",
    rest: "/_frizz/rpc/board",
  })
  assert.deepEqual(splitTenantRequest("/_frizz/pullfrog-app/events", known), {
    slug: "pullfrog-app",
    rest: "/_frizz/events",
  })
  // Query strings ride along on the rest, untouched.
  assert.deepEqual(splitTenantRequest("/_frizz/nub/local-image?path=%2Ftmp%2Fa.png", known), {
    slug: "nub",
    rest: "/_frizz/local-image?path=%2Ftmp%2Fa.png",
  })
  // A bare slug with nothing after it still addresses that tenant.
  assert.deepEqual(splitTenantRequest("/_frizz/nub", known), { slug: "nub", rest: "/_frizz/" })

  // An UNPREFIXED route is the launching project — a client that has not learned about slugs keeps working.
  assert.equal(splitTenantRequest("/_frizz/rpc/board", known), undefined)
  assert.equal(splitTenantRequest("/_frizz/events", known), undefined)
  assert.equal(splitTenantRequest("/_frizz/health", known), undefined)
  // An unknown first segment is a route name we have not met, never a project.
  assert.equal(splitTenantRequest("/_frizz/not-a-project/rpc/board", known), undefined)
  // Anything outside the reserved prefix is a project PAGE, handled by the SPA rather than here.
  assert.equal(splitTenantRequest("/nub", known), undefined)
  assert.equal(splitTenantRequest("/nub/thread/x", known), undefined)
  assert.equal(splitTenantRequest("/", known), undefined)
})

// A page for a project nobody has is the one URL the CLIENT cannot resolve: it renders the app, every
// call it makes is answered 404 by the launching project, the board never lands, and it sits on
// "connecting…" retrying forever. The registry is the authority, so the server answers instead.
test("unknownProjectPage names the slug of a project page that does not exist", () => {
  const known = (s: string) => ["nub", "frizz", "pullfrog-app"].includes(s)

  assert.equal(unknownProjectPage("/project/deleted-last-week", known), "deleted-last-week")
  assert.equal(unknownProjectPage("/project/deleted-last-week/thread/fix-auth", known), "deleted-last-week")
  assert.equal(unknownProjectPage("/project/deleted-last-week/thread/x/full", known), "deleted-last-week")
  // A slug can be percent-encoded in the address bar and must be compared decoded, or every project
  // with a character worth encoding looks missing.
  assert.equal(unknownProjectPage("/project/pullfrog%2Dapp", known), undefined)

  // Everything that is NOT a missing project page is left alone.
  assert.equal(unknownProjectPage("/project/nub", known), undefined)
  assert.equal(unknownProjectPage("/project/nub/status/active", known), undefined)
  assert.equal(unknownProjectPage("/", known), undefined, "the grid")
  assert.equal(unknownProjectPage("/thread/fix-auth", known), undefined, "the launching project, unprefixed")
  assert.equal(unknownProjectPage("/project", known), undefined, "no slug to be missing")
  assert.equal(unknownProjectPage("/project/", known), undefined)
  assert.equal(unknownProjectPage("/assets/index-D2Pc7U9B.js", known), undefined, "a bundle, not a page")
})
