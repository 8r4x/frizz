// POSIX shell quoting for a command copied into the user's terminal. Keep the command construction
// server-side: callers never turn an untrusted display field into a shell argument.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

// RESUME — for a thread whose pane is GONE. This starts a NEW provider process that rebuilds the
// conversation from the transcript on disk; it is NOT a second view of a running one. Anything that
// lives only in the running process's memory — a pending permission prompt above all — is invisible
// here, because the transcript does not contain it (verified 2026-07-25: a worker parked on a prompt
// had NO record of it in its JSONL; the last durable line predated the prompt by 74s). Prefer
// tmuxAttachCommand whenever fray still owns a live pane.
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

// ATTACH — for a thread fray is still driving. This joins the EXACT pane the worker is running in, so
// the human sees the live screen: an in-flight turn, and critically any permission prompt the worker
// is parked on. That is the whole reason to prefer it over a resume, which cannot show either.
//
// The `=` prefix forces EXACT session-name resolution and is not optional. tmux otherwise resolves a
// bare name by prefix, and fray's slug allocator mints `<slug>-2` for a repeated prompt, so
// `fray-X` and `fray-X-2` routinely coexist. Verified here 2026-07-25 against a live socket: a bare
// `-t fray-set-up-a-canary-build-system` (no such session) silently PREFIX-MATCHED into the running
// `…-2` pane, while the `=` form correctly refused. Attaching a human to the wrong agent's terminal
// is exactly the class of bug the rest of tmux.ts already guards with this spelling.
export function tmuxAttachCommand(socket: string, tmuxName: string): string {
  return `tmux -L ${shellQuote(socket)} attach -t ${shellQuote(`=${tmuxName}`)}`
}
