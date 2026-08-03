// THE one rule for what a dispatched worker's process environment contains: everything fray itself was
// started with, MINUS fray's own control-plane variables. One module, used by every transport, because
// the thing this replaced was three independent ALLOWLISTS that had already drifted apart.
//
// ── WHY THIS IS A DENYLIST NOW ─────────────────────────────────────────────────────────────────
// Until 2026-08-02 each transport curated its own allowlist of variables to forward: ENV_ALLOWLIST
// (claude broker, 16 keys), EXPLICIT_CLAUDE_ENV_KEYS (the SDK layer, which THREW on anything else) and
// CODEX_APP_SERVER_ENV_KEYS (~35 keys). The stated rationale was that an agent's tool subprocesses
// inherit its environment, so forwarding host secrets broadens agent authority.
//
// That reasoning does not survive contact with what an agent can already do. A worker has a shell and
// full filesystem read: anything in the environment worth stealing is also sitting in ~/.aws/credentials,
// ~/.config/gh/hosts.yml or ~/.npmrc. Withholding GITHUB_TOKEN from a process that can run
// `gh auth token` is not a boundary.
//
// Meanwhile the cost was real and had already produced a defect. The three lists diverged: HTTP_PROXY,
// HTTPS_PROXY, NO_PROXY and SSL_CERT_FILE reached a CODEX worker and not a CLAUDE one, so behind a
// corporate proxy the same task succeeded or failed depending on which backend the operator picked.
// Neither list carried SSH_AUTH_SOCK (no ssh-agent, so no git over SSH), NODE_EXTRA_CA_CERTS (custom
// CAs), or any toolchain variable — NVM_DIR, GOPATH, CARGO_HOME, JAVA_HOME, PYENV_ROOT — so a build run
// inside a worker could behave differently from the identical build in the operator's own shell, for
// reasons nothing in the logs would explain. Every new variable also cost two edits in two files.
//
// t3code, the closest comparable tool (a GUI wrapping the same provider CLIs), passes process.env
// through verbatim and merges user overrides on top — see mergeProviderInstanceEnvironment. So does
// essentially every other developer tool. Matching that is the least-surprise behavior: if you export
// something before launching fray, your agents see it.
//
// ── WHAT IS STILL DENIED, AND WHY ──────────────────────────────────────────────────────────────
// Fray's OWN variables, by the `FRAY_` prefix. These are control plane, not developer environment:
//   · FRAY_CLAUDE_BROKER / FRAY_CODEX_APP_SERVER_DAEMON carry a daemon's entire config as JSON,
//     including socket paths and the record path it publishes to.
//   · FRAY_LAUNCH_OWNER_TOKEN, FRAY_SERVER_LOCK and the FRAY_LAUNCH_* set are the launch identity that
//     decides which server owns which project.
//   · FRAY_UI_THREAD / FRAY_PERM_DIR / FRAY_NATIVE_ASK / FRAY_PERM_POLICY are what the cc-worker hooks
//     gate on. A worker dispatched to work ON fray would otherwise inherit the SERVER's values and the
//     hooks would read another thread's identity.
// Denying the whole prefix rather than a hand-kept list is deliberate: it is the same "cannot drift"
// property the allowlists failed to hold, pointing the other way. The handful of FRAY_ variables a
// worker genuinely needs are re-added explicitly afterwards, because every caller merges its own
// `workerEnv` ON TOP of this (see the broker's `env:` and the bridge's `attach`).
//
// This is NOT a secrets boundary and must not be described as one. It keeps fray's plumbing out of a
// worker's environment; it does not keep the operator's credentials out, and it never could.
const FRAY_INTERNAL_PREFIX = "FRAY_"

/** Whether `key` is one of fray's own control-plane variables — the only thing a worker does not
 *  inherit. Exported so the transports and their tests share one predicate rather than three. */
export function isFrayInternalEnvKey(key: string): boolean {
  return key.startsWith(FRAY_INTERNAL_PREFIX)
}

/** The environment a dispatched worker starts from: `source` (fray's own process env by default) with
 *  fray's control-plane variables removed and undefined values dropped. Callers merge their per-thread
 *  `workerEnv` on top — that is what puts the FRAY_ variables a worker DOES need back, with this
 *  thread's values rather than the server's. */
export function inheritWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isFrayInternalEnvKey(key)) continue
    env[key] = value
  }
  return env
}
