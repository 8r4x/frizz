// Drive the two state transitions a RESTED sub-agent row must make, against the real server + real
// tailer, and print the board's own reading at each step.
//
//   1. rested → running   the parent re-steers the stopped child (`SendMessage` → a `resumedAgentId`
//                         ack). This is the exact sequence the reported nub session took, two minutes
//                         after the notification that made the branch vanish.
//   2. rested → gone      the fan-out under it falls silent. The anchor must retire itself; a phantom
//                         that outlives its own descendants is the failure this whole path guards.
//
// Usage: npx tsx scripts/verify-rested-transitions.mjs --port=4931 --home=/abs --slug=… --session=…
import { appendFileSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const port = Number(opt("port", "4931"))
const home = opt("home")
const slug = opt("slug", "sweep-the-grants-corpus-b")
const session = opt("session")
const cwdSlug = opt("project", process.cwd().replace(/\/ui$/, "")).replace(/\//g, "-")
const logDir = join(home, ".claude", "projects", cwdSlug)
const jsonl = join(logDir, `${session}.jsonl`)
const subagents = join(logDir, session, "subagents")

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()

const branch = async () => {
  const board = await api.query("board")
  const thread = (board.threads ?? []).find((t) => t.id === slug || t.slug === slug)
  return (thread?.subAgents ?? []).map((a) => `${"  ".repeat((a.depth ?? 1) - 1)}${a.label} [${a.state}]`)
}
const settle = async (predicate, label) => {
  for (let i = 0; i < 40; i++) {
    const rows = await branch()
    if (predicate(rows)) return rows
    await new Promise((r) => setTimeout(r, 500))
  }
  console.error(`TIMED OUT waiting for ${label}`)
  return await branch()
}

console.log("── step 0: the branch as the bug leaves it ──")
console.log((await branch()).join("\n"))

// ── step 1: the parent re-steers the rested child ────────────────────────────────────────────────
const now = () => new Date().toISOString()
appendFileSync(jsonl, `${JSON.stringify({
  type: "assistant", timestamp: now(),
  message: { id: "mResume", role: "assistant", stop_reason: "tool_use", content: [
    { type: "tool_use", id: "toolu_steer", name: "SendMessage", input: { to: "aSweep", summary: "Stay awake and collect your five children", message: "Your five sweep agents are alive and working. Stay awake and collect them." } },
  ] },
})}\n`)
appendFileSync(jsonl, `${JSON.stringify({
  type: "user", timestamp: now(),
  message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_steer", content: [{ type: "text", text: JSON.stringify({
      success: true,
      message: `Agent "aSweep" was stopped (completed); resumed it in the background with your message. You'll be notified when it finishes. Output: ${join(subagents, "agent-aSweep.jsonl")}`,
      resumedAgentId: "aSweep",
    }) }] },
  ] },
})}\n`)
// The revived child appends again, which is what its liveness reads off.
const fresh = Date.now() / 1000
utimesSync(join(subagents, "agent-aSweep.jsonl"), fresh, fresh)

console.log("\n── step 1: after the re-steer (expect the root back to running) ──")
console.log((await settle((rows) => rows.some((r) => r.startsWith("Sweep corpus") && r.includes("[running]")), "the root to revive")).join("\n"))

// ── step 2: the fan-out falls silent ─────────────────────────────────────────────────────────────
// Age every descendant transcript past the staleness ceiling, and the rested root's own transcript with
// them, so nothing under the branch reads as running any more.
const old = (Date.now() - 60 * 60 * 1000) / 1000
for (const n of [1, 2, 3, 4, 6]) utimesSync(join(subagents, `agent-aShard${n}.jsonl`), old, old)
// Retire the (now running again) root a second time — the same notification, which is exactly what the
// harness sends every time the agent stops.
appendFileSync(jsonl, `${JSON.stringify({
  type: "queue-operation", operation: "enqueue", timestamp: now(), content:
    `<task-notification>\n<task-id>aSweep</task-id>\n<tool-use-id>toolu_sweep</tool-use-id>\n<status>completed</status>\n<summary>Agent "Sweep corpus for system-library grants" finished</summary>\n</task-notification>`,
})}\n`)

console.log("\n── step 2: rested root + a silent fan-out (expect the whole branch gone) ──")
console.log((await settle((rows) => !rows.some((r) => r.includes("Sweep corpus")), "the branch to retire")).join("\n") || "(no rows under the thread)")
