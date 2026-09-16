import assert from "node:assert/strict"
import { test } from "node:test"
import { CodexExecutionHealth, MACOS_SERVICE_PROBE, MACOS_SERVICE_PROBE_TIMEOUT_MS } from "./codex-execution-health.ts"

test("macOS probes the backend context with a bounded local command, never DNS", async () => {
  const health = new CodexExecutionHealth("darwin", async () => { throw new Error("healthy backend must not probe parent") })
  await health.check({ request: async (method, params, timeout) => {
    assert.equal(method, "command/exec")
    assert.deepEqual(params, { command: MACOS_SERVICE_PROBE, cwd: "/", timeoutMs: MACOS_SERVICE_PROBE_TIMEOUT_MS, sandboxPolicy: { type: "dangerFullAccess" } })
    assert.equal(timeout, 4_000)
    return { exitCode: 0, stdout: "system/com.apple.configd = {\n state = running\n}", stderr: "" }
  } }, "project test, backend PID 123")
})

test("failure is attributed to backend or parent without treating protocol success as health", async () => {
  for (const hostHealthy of [true, false]) {
    for (const result of [{ exitCode: 141 }, { exitCode: 0, stdout: "" }, null, "timeout"]) {
      const health = new CodexExecutionHealth("darwin", async () => hostHealthy)
      await assert.rejects(health.check({ request: async () => {
        if (result === "timeout") throw new Error("timed out")
        return result
      } }, "project test, backend PID 123"), (error: Error) => {
        assert.match(error.message, /backend PID 123/)
        assert.match(error.message, /existing work and conversation history were not changed/)
        assert.match(error.message, hostHealthy ? /host context is healthy/ : /host context also failed/)
        return true
      })
    }
  }
})

test("concurrent admissions share a probe but later admissions recheck", async () => {
  let finish!: (value: unknown) => void
  let probes = 0
  const connection = { request: async () => { probes++; return new Promise((resolve) => { finish = resolve }) } }
  const health = new CodexExecutionHealth("darwin", async () => true)
  const first = health.check(connection, "test")
  const second = health.check(connection, "test")
  assert.equal(first, second)
  finish({ exitCode: 0, stdout: "system/com.apple.configd = {" })
  await first
  const failed = health.check(connection, "test")
  finish({ exitCode: 141 })
  await assert.rejects(failed, /launchctl exited 141/)
  assert.equal(probes, 2)
})

test("Linux and Windows do not run the macOS probe", async () => {
  for (const platform of ["linux", "win32"] as const) {
    await new CodexExecutionHealth(platform).check({ request: async () => { assert.fail("unexpected probe") } }, "test")
  }
})
