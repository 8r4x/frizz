// LIVE PROBE: can a follow-up PREEMPT the operation already in flight, instead of waiting it out?
//   nub packages/server/src/backend/_live_broker_interrupt_send.mts
//
// WHY. Measured over the maintainer's own 14 days of transcripts, a follow-up sent to a BUSY Claude
// worker waits p50 13.8s / p90 49s / p99 2.5m — and Claude Code is not dawdling: it drains its queue
// at the first sampling boundary that exists. The wait IS the remaining time of whatever was already
// running (a long `Bash`, or a 90-second reasoning+answer generation). The only way to go faster is to
// preempt that operation, and the broker already carries an unused `interrupt` frame all the way down
// to the SDK's `query.interrupt()`, whose receipt reports `still_queued` — suggesting queued inputs
// SURVIVE an interrupt.
//
// THE DIFFERENTIAL, one variable, the same 90-second Bash call in flight both times:
//   CONTROL — sendInput alone            → expect delivery only when the sleep returns
//   TEST    — sendInput then interrupt() → expect delivery within seconds
//
// What must ALSO hold for this to be shippable, and is asserted here:
//   · the queued message is NOT lost by the interrupt (the whole feature depends on `still_queued`)
//   · the session still works afterwards — a third, ordinary follow-up must land normally
import { execFileSync } from "node:child_process"
import { mkdtempSync, existsSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { forkBroker, killBroker } from "./claude-broker-host.ts"
import { connectClaudeBroker } from "./claude-broker-client.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "intsend-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "intsend-repo-")))
execFileSync("git", ["init", "-q", cwd])
const sessionId = randomUUID()

const t0 = Date.now()
const at = (): string => `t+${String(Date.now() - t0).padStart(6)}ms`
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

let toolUses = 0
let results = 0
const files = { control: join(cwd, "CONTROL.txt"), test: join(cwd, "TEST.txt"), after: join(cwd, "AFTER.txt") }
const landed: Record<string, number> = {}
const fileTimer = setInterval(() => {
  for (const [name, path] of Object.entries(files)) {
    if (landed[name] === undefined && existsSync(path)) {
      landed[name] = Date.now() - t0
      console.log(`FILE  ${at()} ${name} landed after ${toolUses} tool uses`)
    }
  }
}, 25)

const env = Object.fromEntries(
  ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
)
const record = await forkBroker({ stateDir, cwd, sessionId, executablePath: claudeBin, env, permissionMode: "bypassPermissions" })

const client = connectClaudeBroker(record.socketPath, {
  onEvent: (event: ClaudeQueryEvent) => {
    if (event.kind === "result") results++
    if (event.kind === "assistant") toolUses += event.toolUses.length
    const anyEvent = event as unknown as Record<string, unknown>
    const text = Array.isArray(anyEvent.text) ? (anyEvent.text as string[]).join(" ") : ""
    const tools = event.kind === "assistant" && event.toolUses.length ? ` tools=${event.toolUses.map((t) => t.name).join(",")}` : ""
    if (event.kind !== "user") console.log(`EVENT ${at()} kind=${event.kind}${tools} text=${JSON.stringify(text.slice(0, 70))}`)
  },
  onPermissionRequest: (requestId) => client.answerPermission(requestId, { behavior: "allow" }),
  onDiagnostic: (d) => console.log(`DIAG  ${at()} ${JSON.stringify(d).slice(0, 160)}`),
})

const waitFor = async (pred: () => boolean, ms: number, what: string): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) { console.log(`WAIT  ${at()} TIMEOUT waiting for ${what}`); return false }
    await new Promise((r) => setTimeout(r, 25))
  }
  return true
}

// One long Bash call, exactly the shape the census found in flight when a real steer is swallowed.
// NOT a bare `sleep`: Claude Code's own tool policy refuses a standalone sleep, which ends the turn
// instead of occupying it and silently destroys the control (measured — the first run of this probe
// did exactly that). A python sleep is an ordinary long command and runs.
const sleeper = (label: string) =>
  `Use the Bash tool ONCE to run \`python3 -c "import time; time.sleep(90)"\` with a timeout of ` +
  `120000ms. Do not run anything else first. When it returns, reply ${label} and stop.`
const writeFile = (name: string) => `Write a file called ${name} in the repo root containing the word OK. Do it now.`

try {
  // ── CONTROL: send into a long tool call, no interrupt ───────────────────────────────────────────
  console.log(`SEND  ${at()} CONTROL turn (sleep 90)`)
  client.sendInput({ id: randomUUID(), text: sleeper("CONTROL-DONE") })
  await waitFor(() => toolUses >= 1, 120_000, "the sleep to start")
  await new Promise((r) => setTimeout(r, 3_000))
  const controlSent = Date.now() - t0
  console.log(`SEND  ${at()} CONTROL follow-up (no interrupt)`)
  client.sendInput({ id: randomUUID(), text: writeFile("CONTROL.txt") })
  await waitFor(() => landed.control !== undefined, 240_000, "CONTROL.txt")
  await waitFor(() => results >= 2, 180_000, "the control turns to settle")

  // ── TEST: same shape, but interrupt right after the send ────────────────────────────────────────
  const toolsBefore = toolUses
  console.log(`\nSEND  ${at()} TEST turn (sleep 90)`)
  client.sendInput({ id: randomUUID(), text: sleeper("TEST-DONE") })
  await waitFor(() => toolUses >= toolsBefore + 1, 120_000, "the second sleep to start")
  await new Promise((r) => setTimeout(r, 3_000))
  const testSent = Date.now() - t0
  console.log(`SEND  ${at()} TEST follow-up + interrupt`)
  client.sendInput({ id: randomUUID(), text: writeFile("TEST.txt") })
  client.interrupt()
  await waitFor(() => landed.test !== undefined, 240_000, "TEST.txt")

  // ── AFTERWARDS: is the session still usable? ────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 4_000))
  console.log(`\nSEND  ${at()} an ordinary follow-up after the interrupt`)
  client.sendInput({ id: randomUUID(), text: writeFile("AFTER.txt") })
  await waitFor(() => landed.after !== undefined, 180_000, "AFTER.txt")

  console.log("\n──────── ANALYSIS ────────")
  const controlGap = landed.control !== undefined ? landed.control - controlSent : null
  const testGap = landed.test !== undefined ? landed.test - testSent : null
  console.log(`CONTROL  sendInput alone     : ${controlGap === null ? "NEVER" : `${(controlGap / 1000).toFixed(1)}s`}`)
  console.log(`TEST     sendInput + interrupt: ${testGap === null ? "NEVER" : `${(testGap / 1000).toFixed(1)}s`}`)
  ok("the queued message survives the interrupt", testGap !== null)
  ok("the interrupt actually preempts the in-flight tool", testGap !== null && controlGap !== null && testGap < controlGap / 2,
    `${testGap}ms vs ${controlGap}ms`)
  ok("the session still takes an ordinary follow-up afterwards", landed.after !== undefined)
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
} catch (err) {
  console.log(`ERROR ${err instanceof Error ? err.stack : String(err)}`)
  failures++
} finally {
  clearInterval(fileTimer)
  try { client.close() } catch {}
  try { killBroker(stateDir, sessionId) } catch {}
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
