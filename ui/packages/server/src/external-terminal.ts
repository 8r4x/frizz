// POSIX shell quoting for a command copied into the user's terminal. Keep the command construction
// server-side: callers never turn an untrusted display field into a shell argument.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

// The copied command re-attaches a HUMAN to a session Fray was driving non-interactively, so it also
// carries the provider's permission-bypass flag: without it the resumed terminal falls back to the
// CLI's default interactive approvals and the human gets prompted on every tool call — exactly the
// friction the running worker never had. claude: `--dangerously-skip-permissions` (bypass all
// permission checks). codex: `--dangerously-bypass-approvals-and-sandbox` (skip all confirmations,
// no sandbox) — the same flag works on the `resume` subcommand.
export function providerResumeCommand(backend: "claude" | "codex", projectDir: string, sessionId: string): string {
  const resume = backend === "codex"
    ? `codex resume ${shellQuote(sessionId)} --dangerously-bypass-approvals-and-sandbox`
    : `claude --resume ${shellQuote(sessionId)} --dangerously-skip-permissions`
  return `cd ${shellQuote(projectDir)} && ${resume}`
}
