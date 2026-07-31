// The CODEX wake must reject INTO the scheduler, not swallow its own failure.
//
// The scheduler awaits `resume` and owns retry/supersede on rejection (scheduler.ts `deliverDue`).
// The codex branch used to run its bridge work in a detached `void (async () => …)().catch(() => {})`
// IIFE and return `undefined` synchronously — so the scheduler saw an instant success, ACKED the
// delivery, and the real bridge failure landed seconds later into a bare catch and vanished. No log,
// no retry, the wake lost permanently. Claude's synchronous `resumeThread` throws straight into the
// same catch and retries correctly, so this was CODEX-ONLY and silent: an `awaiting timer:` or
// limit-auto-resume codex thread could simply never wake.
//
// These drive the REAL exported delivery function, so reverting it to fire-and-forget fails here —
// unlike a scheduler-level test with an injected `resume`, which passes either way because it never
// touches this code.
import assert from "node:assert/strict"
import { test } from "node:test"
import { deliverCodexWake } from "./context.ts"

const row = (over: Record<string, unknown> = {}) => ({
  session_id: "sess-1",
  agent_session_id: null as string | null,
  codex_runtime: "app-server" as string | null,
  ...over,
})

function bridge(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  return {
    calls,
    adoptExternalRollout: async () => { calls.push("adopt"); return {} as never },
    binding: () => ({ state: "active" }) as never,
    resumeOwnedSession: async () => { calls.push("resume"); return {} as never },
    followUp: async () => { calls.push("followUp") },
    ...over,
  }
}

const storage = () => {
  const runtimes: string[] = []
  return { runtimes, setCodexRuntime: (_s: string, r: string) => void runtimes.push(r) }
}

test("a failing bridge REJECTS the returned promise — the scheduler can see it and retry", async () => {
  const b = bridge({ followUp: async () => { throw new Error("codex app-server bridge unavailable") } })
  await assert.rejects(
    deliverCodexWake({
      bridge: b as never,
      storage: storage() as never,
      cwd: "/tmp",
      row: row(),
      slug: "t",
      deliveryMessage: "continue",
      deliveryId: "d1",
    }),
    /bridge unavailable/,
    "a detached IIFE would resolve undefined here and the wake would be silently ACKED",
  )
})

test("the happy path resolves only AFTER the follow-up actually landed", async () => {
  const b = bridge()
  const settled = await deliverCodexWake({
    bridge: b as never,
    storage: storage() as never,
    cwd: "/tmp",
    row: row(),
    slug: "t",
    deliveryMessage: "continue",
    deliveryId: "d1",
  }).then(() => "resolved")
  assert.equal(settled, "resolved")
  assert.deepEqual(b.calls, ["followUp"], "an already-active app-server binding needs no adopt or resume")
})

test("a legacy tmux rollout is adopted and marked app-server before the follow-up", async () => {
  const b = bridge()
  const s = storage()
  await deliverCodexWake({
    bridge: b as never,
    storage: s as never,
    cwd: "/tmp",
    row: row({ codex_runtime: null, agent_session_id: "rollout-9" }),
    slug: "t",
    deliveryMessage: "continue",
    deliveryId: "d1",
  })
  assert.deepEqual(b.calls, ["adopt", "followUp"], "adoption precedes delivery")
  assert.deepEqual(s.runtimes, ["app-server"], "and the row is migrated exactly once")
})

test("a failed ADOPTION also rejects, rather than delivering into an unbound session", async () => {
  const b = bridge({ adoptExternalRollout: async () => { throw new Error("rollout is already bound") } })
  await assert.rejects(
    deliverCodexWake({
      bridge: b as never,
      storage: storage() as never,
      cwd: "/tmp",
      row: row({ codex_runtime: null, agent_session_id: "rollout-9" }),
      slug: "t",
      deliveryMessage: "continue",
      deliveryId: "d1",
    }),
    /already bound/,
  )
  assert.equal(b.calls.includes("followUp"), false, "no delivery after a failed adoption")
})

test("a detached binding is reactivated before the follow-up", async () => {
  const b = bridge({ binding: () => ({ state: "detached" }) as never })
  await deliverCodexWake({
    bridge: b as never,
    storage: storage() as never,
    cwd: "/tmp",
    row: row(),
    slug: "t",
    deliveryMessage: "continue",
    deliveryId: "d1",
  })
  assert.deepEqual(b.calls, ["resume", "followUp"])
})
