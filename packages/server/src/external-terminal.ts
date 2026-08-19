// POSIX shell quoting for a command copied into the user's terminal. Keep the command construction
// server-side: callers never turn an untrusted display field into a shell argument.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

// RESUME — the only external-terminal command frizz builds. This starts a NEW provider process that
// rebuilds the conversation from the transcript on disk; it is NOT a second view of a running one.
// Anything that lives only in the running process's memory — a pending permission prompt above all —
// is invisible here, because the transcript does not contain it (verified 2026-07-25: a worker parked
// on a prompt had NO record of it in its JSONL; the last durable line predated the prompt by 74s).
// That limitation is now unavoidable rather than a reason to choose something else; see the note below.
//
// It carries the provider's permission-bypass flag because a human driving a session by hand should
// not be re-prompted for work the unattended worker was already trusted to do. claude:
// `--dangerously-skip-permissions`. codex: `--dangerously-bypass-approvals-and-sandbox` (the same
// flag works on the `resume` subcommand).
export function providerResumeCommand(backend: "claude" | "codex", projectDir: string, sessionId: string): string {
  const resume = backend === "codex"
    ? `codex resume ${shellQuote(sessionId)} --dangerously-bypass-approvals-and-sandbox`
    : `claude --resume ${shellQuote(sessionId)} --dangerously-skip-permissions`
  return `cd ${shellQuote(projectDir)} && ${resume}`
}

// WHY THERE IS NO ATTACH. This module used to export a second builder alongside the resume, for a
// thread frizz was still driving: it joined the exact terminal the worker was running in, so the human
// saw the live screen — an in-flight turn, and critically any permission prompt the worker was parked
// on — which is the one thing a resume structurally cannot show. It went with the multiplexer on
// 2026-08-02 (commit 3dc5bb1d). A worker no longer runs in a terminal at all: a Claude thread runs
// inside the session broker daemon and a codex thread inside the app-server daemon, both driven over
// pipes, so there is no screen to join. router.ts's threadTerminalCommand therefore answers every
// runtime state with the resume above, and the live-runtime states are served in the dashboard instead
// — a parked permission prompt arrives as an answerable card, not as something to go find in a terminal.
//
// The hazard that builder guarded is worth carrying forward, because it outlives the transport: frizz's
// slug allocator mints `<slug>-2` for a repeated prompt, so `frizz-X` and `frizz-X-2` routinely coexist,
// and any lookup that resolves a thread by NAME PREFIX silently lands on the wrong one. Verified
// 2026-07-25: a bare `-t frizz-set-up-a-canary-build-system` (no such session) prefix-matched into the
// running `…-2` thread, while the exact-match spelling correctly refused. Sending a human to the wrong
// agent's terminal is the class of bug to keep guarding. providerResumeCommand is immune by
// construction — it addresses the PROVIDER's own session id, read off the thread's registry row by
// router.ts, and never a slug or a thread name — so keep it that way.
