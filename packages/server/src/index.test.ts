import assert from "node:assert/strict"
import { test } from "node:test"
import { splitTenantRequest } from "./index.ts"

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
