import { test } from "node:test"
import assert from "node:assert/strict"
import { inheritWorkerEnvironment, isFrizzInternalEnvKey } from "./worker-env.ts"

// The rule is a PREFIX, not a list, and that is the point: the three allowlists this replaced drifted
// apart precisely because each was hand-kept. A prefix cannot drift — a new FRIZZ_ variable is denied
// the day someone adds it, without anyone remembering to update anything.
test("isFrizzInternalEnvKey denies frizz's control plane by prefix and nothing else", () => {
  for (const key of [
    "FRIZZ_CLAUDE_BROKER",           // a daemon's entire config as JSON
    "FRIZZ_CODEX_APP_SERVER_DAEMON", // the codex twin of it
    "FRIZZ_LAUNCH_OWNER_TOKEN",      // which server owns which project
    "FRIZZ_SERVER_LOCK",
    "FRIZZ_THREAD",               // hook identity — re-added per thread by workerEnv
    "FRIZZ_PERM_DIR",
    "FRIZZ_",                        // degenerate, still ours
  ]) assert.equal(isFrizzInternalEnvKey(key), true, `${key} must not be inherited`)

  // Everything the operator legitimately set, INCLUDING the ones the old allowlists dropped and the
  // credentials it deliberately withheld. Withholding those was never a boundary — a worker has a
  // shell and can read ~/.aws/credentials — and the cost was builds inside a worker diverging from the
  // same build in the operator's own terminal.
  for (const key of [
    "PATH", "HOME", "SHELL", "LANG",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
    "SSH_AUTH_SOCK", "GPG_TTY", "GIT_CONFIG_GLOBAL",
    "NVM_DIR", "GOPATH", "CARGO_HOME", "JAVA_HOME", "PYENV_ROOT",
    "GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY",
    "MYFRIZZ_TOKEN",  // contains "FRIZZ" but is not OURS — the prefix must anchor at the start
    "XFRIZZ_",
  ]) assert.equal(isFrizzInternalEnvKey(key), false, `${key} must be inherited`)
})

test("inheritWorkerEnvironment copies everything but frizz's own, and drops undefined", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy.test:8080",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    GITHUB_TOKEN: "gh-token",
    FRIZZ_CLAUDE_BROKER: '{"socketPath":"/tmp/s"}',
    FRIZZ_THREAD: "some-other-thread",
    UNSET: undefined,
  }
  assert.deepEqual(inheritWorkerEnvironment(source), {
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy.test:8080",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    GITHUB_TOKEN: "gh-token",
  })

  // A snapshot, not a live view: the child must not observe later mutations of the caller's env.
  const mutable: NodeJS.ProcessEnv = { A: "1" }
  const snapshot = inheritWorkerEnvironment(mutable)
  mutable.B = "2"
  assert.deepEqual(snapshot, { A: "1" })
  assert.notEqual(snapshot as unknown, mutable as unknown)
})

// The callers all merge their per-thread `workerEnv` ON TOP of this, which is what puts back the
// handful of FRIZZ_ variables a worker genuinely needs — with THIS thread's values rather than the
// server's. Pinned here because the ordering is the whole reason denying the prefix is safe.
test("a caller's per-thread overrides restore the frizz vars a worker needs", () => {
  const server: NodeJS.ProcessEnv = { FRIZZ_THREAD: "server-thread", FRIZZ_PERM_DIR: "/server/perm", PATH: "/usr/bin" }
  const merged: Record<string, string> = { ...inheritWorkerEnvironment(server), FRIZZ_THREAD: "my-thread", FRIZZ_PERM_DIR: "/my/perm" }
  assert.equal(merged.FRIZZ_THREAD, "my-thread", "the thread's own identity, never the server's")
  assert.equal(merged.FRIZZ_PERM_DIR, "/my/perm")
  assert.equal(merged.PATH, "/usr/bin")
})
