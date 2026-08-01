import assert from "node:assert/strict"
import { test } from "node:test"
import { canRestart, canUpdateRestart, getFraySupervisorStatus, isDevFrayBuild, requestFrayRestart, requestFrayUpdateRestart } from "./restart.ts"

const response = (body: string, status = 200, contentType = "application/json") => new Response(body, { status, headers: { "content-type": contentType } })

test("restart controls negotiate an explicit JSON protocol and reject SPA HTML fallbacks", async () => {
  const html = async () => response("<!doctype html><title>Fray</title>", 200, "text/html")
  assert.equal(await getFraySupervisorStatus(html as typeof fetch), null)
  await assert.rejects(requestFrayUpdateRestart(html as typeof fetch), /unavailable/)
})

test("restart controls reject stale protocol, missing routes, and network failures", async () => {
  const stale = async () => response(JSON.stringify({ protocol: 0, state: "ready" }))
  const missing = async () => response("missing", 404, "text/plain")
  const failed = async () => { throw new Error("network down") }
  assert.equal(await getFraySupervisorStatus(stale as typeof fetch), null)
  assert.equal(await getFraySupervisorStatus(missing as typeof fetch), null)
  assert.equal(await getFraySupervisorStatus(failed as typeof fetch), null)
  assert.equal(canRestart(null), false)
  assert.equal(canRestart({ protocol: 1, state: "ready" }), true)
  assert.equal(canUpdateRestart({ protocol: 1, state: "ready" }), false)
  assert.equal(canUpdateRestart({ protocol: 1, state: "ready", updateRestart: true }), true)
})

test("ordinary restart remains available without the update capability", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined
  const supported = async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { input, init }
    return response(JSON.stringify({ protocol: 1, state: "ready" }), 202)
  }
  await requestFrayRestart(supported as typeof fetch)
  assert.equal(request?.input, "/_fray/control/restart")
  assert.equal(request?.init?.method, "POST")
})

test("update and restart requires an explicit supervisor capability and uses its one endpoint", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined
  const supported = async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { input, init }
    return response(JSON.stringify({ protocol: 1, state: "ready", artifactDigest: "a".repeat(64), updateRestart: true }))
  }
  assert.equal((await getFraySupervisorStatus(supported as typeof fetch))?.artifactDigest, "a".repeat(64))
  assert.equal((await getFraySupervisorStatus(supported as typeof fetch))?.updateRestart, true)
  await requestFrayUpdateRestart(supported as typeof fetch)
  assert.equal(request?.input, "/_fray/control/update-restart")
  assert.equal(request?.init?.method, "POST")

  const failure = async () => response(JSON.stringify({ protocol: 1, state: "failed", message: "candidate rejected" }), 503)
  await assert.rejects(requestFrayUpdateRestart(failure as typeof fetch), /candidate rejected/)
})

test("an accepted update transition is not misreported as a restart failure", async () => {
  const accepted = async () => response(JSON.stringify({ protocol: 1, state: "restarting" }), 202)
  assert.equal((await requestFrayUpdateRestart(accepted as typeof fetch)).state, "restarting")
})

// The two conditions behind the Update-vs-Restart label. Conflating them shipped: production reported
// only the CAPABILITY, so a fully current Fray still offered "Update Fray" and a click reinstalled its
// own version and restarted the app for nothing.
test("the update label needs the verb wired AND a newer artifact to actually exist", () => {
  const status = (over: Record<string, unknown>) =>
    ({ protocol: 1, state: "ready", ...over }) as Parameters<typeof canUpdateRestart>[0]

  assert.equal(canUpdateRestart(status({ updateRestart: true, updateAvailable: true })), true)
  assert.equal(
    canUpdateRestart(status({ updateRestart: true, updateAvailable: false })), false,
    "already current ⇒ offer a plain Restart, never an Update that installs nothing",
  )
  assert.equal(
    canUpdateRestart(status({ updateRestart: true })), true,
    "absent ⇒ assume available, so fray-dev (which can always rebuild from source) is unchanged",
  )
  assert.equal(
    canUpdateRestart(status({ updateRestart: false, updateAvailable: true })), false,
    "availability can never conjure the verb on a supervisor that cannot promote an artifact",
  )
})

// Why a field at all: the client cannot see this. `import.meta.env.DEV` is a Vite COMPILE-TIME
// constant, false in the production bundle every fray-dev artifact serves — so the dev-only
// Restart-worker verb was eliminated from the build it exists for. The launcher answers instead.
test("a development build is only ever what the supervisor explicitly reports", async () => {
  const status = (over: Record<string, unknown>) =>
    ({ protocol: 1, state: "ready", ...over }) as Parameters<typeof isDevFrayBuild>[0]

  assert.equal(isDevFrayBuild(status({ dev: true })), true, "fray-dev / pnpm dev")
  assert.equal(
    isDevFrayBuild(status({})), false,
    "a published Fray, and any supervisor predating the field, must never show a dev-only verb",
  )
  assert.equal(
    isDevFrayBuild(status({ updateRestart: true })), false,
    "Update & Restart is wired in PRODUCTION too — it can never stand in for a dev signal",
  )
  assert.equal(isDevFrayBuild(null), false, "an unreachable supervisor is not a licence to show one")

  // And it has to survive the wire, not just the predicate.
  const dev = async () => response(JSON.stringify({ protocol: 1, state: "ready", dev: true }))
  assert.equal(isDevFrayBuild(await getFraySupervisorStatus(dev as typeof fetch)), true)
})
