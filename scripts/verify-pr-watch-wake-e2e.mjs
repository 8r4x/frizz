// FULL-STACK e2e for the pr-watch wake steer, against a disposable adhoc stack.
//
// This exercises the whole chain with nothing stubbed: a REAL session row + a REAL tmux pane + a REAL
// JSONL the REAL tailer reads → the REAL scheduler polling REAL GitHub (nubjs/nub#587) → the REAL
// durable outbox → the REAL tmux bracketed-paste delivery. The pane captures raw bytes, so the
// assertion is on what a woken worker's terminal ACTUALLY received, not on what the scheduler intended.
//
// Boot the stack with --wakers first, then:
//   node scripts/verify-pr-watch-wake-e2e.mjs --home=/abs/temp-home --socket=fray-adhoc-NNNN-PID
//
// Prints the captured steer and exits nonzero on any failed assertion.
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, readFileSync, existsSync, globSync } from "node:fs"
import { join } from "node:path"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, socket, cwd = "/Users/colinmcd94/Documents/projects/fray" } = flags
if (!home || !socket) {
  console.error("usage: node verify-pr-watch-wake-e2e.mjs --home=/abs/temp-home --socket=<tmux-socket>")
  process.exit(1)
}

const SLUG = "prwatch-587"
const SESSION_ID = "prwatch587-0000-4000-8000-00000000".slice(0, 36).padEnd(36, "0")
const TMUX_NAME = `fray-${SLUG}`
const CAPTURE = join(home, "pane-capture.bin")
// Before @colinhacks' 15:39 comment and @pullfrog's 15:46/15:47 reviews, so all three are post-fence.
const FENCE_AT = "2026-07-29T12:00:00.000Z"

const db = globSync(join(home, ".fray/projects/*/ui.db"))[0]
if (!db) throw new Error(`no ui.db under ${home}/.fray/projects — is the stack booted?`)

let failures = 0
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

// ---- 1. a real pane that captures exactly what tmux delivers -------------------------------------
// `stty raw -echo` removes the line discipline so the bracketed-paste framing and the embedded
// newlines reach the file byte-for-byte, which is the only way to prove a MULTI-LINE steer survives
// the paste path intact rather than arriving split into one message per line.
writeFileSync(CAPTURE, "")
execFileSync("tmux", ["-L", socket, "new-session", "-d", "-s", TMUX_NAME, `sh -c 'stty raw -echo; cat > ${CAPTURE}'`], { stdio: "ignore" })

// ---- 2. a real transcript whose final message is an awaiting pr-watch fence ------------------------
const cwdSlug = cwd.replace(/[/.]/g, "-")
const jsonlDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(jsonlDir, { recursive: true })
const fenceText = [
  "Pushed the branch and CI is green.",
  "",
  "```awaiting",
  "pr-watch: nubjs/nub#587",
  "PR is open. Watching for review — I'll address comments or merge on approval.",
  "```",
].join("\n")
const records = [
  {
    parentUuid: null, isSidechain: false, type: "user",
    message: { role: "user", content: "TASK:\nWatch nubjs/nub#587 for review activity." },
    uuid: "00000001-0000-4000-8000-000000000000", timestamp: FENCE_AT, session_id: SESSION_ID, cwd,
  },
  {
    parentUuid: null, isSidechain: false, type: "assistant",
    message: {
      model: "claude-opus-5", id: "msg_prwatch587", type: "message", role: "assistant",
      content: [{ type: "text", text: fenceText }], stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 120 },
    },
    uuid: "00000002-0000-4000-8000-000000000000", timestamp: FENCE_AT, session_id: SESSION_ID, cwd,
  },
]
const jsonlPath = join(jsonlDir, `${SESSION_ID}.jsonl`)
writeFileSync(jsonlPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (slug, session_id, tmux_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES ('${SLUG}', '${SESSION_ID}', '${TMUX_NAME}', '${FENCE_AT}', 'Watch nubjs/nub#587', 'claude', 'opus', 'high', 'default', '${FENCE_AT}')`,
])
console.log(`seeded ${SLUG} → ${SESSION_ID}\nwaiting for the real scheduler to poll GitHub and deliver…\n`)

// ---- 3. wait for the REAL wake to cross tmux -------------------------------------------------------
const deadline = Date.now() + 120_000
let captured = ""
while (Date.now() < deadline) {
  captured = existsSync(CAPTURE) ? readFileSync(CAPTURE, "utf8") : ""
  if (captured.includes("New GitHub")) break
  await new Promise((r) => setTimeout(r, 2000))
}

// Strip the bracketed-paste framing tmux wraps the payload in; what remains is the literal text the
// worker's composer receives.
const payload = captured.replace(/\[200~/g, "").replace(/\[201~/g, "").replace(/\r/g, "\n")
console.log(`--- raw bytes the pane received (${captured.length}) ---\n${payload}\n---\n`)

check("the wake crossed tmux into the real pane", /[Nn]ew GitHub/.test(payload), payload ? "" : "nothing captured within 120s")
// Bracketed-paste framing is APPLICATION-NEGOTIATED: tmux emits the \e[200~ wrapper only for a client
// that has enabled DECSET 2004, which a raw `cat` never does — so its absence here says nothing about
// the real TUI path. What this fixture CAN prove, and what actually matters, is that the whole
// multi-line steer arrived as ONE contiguous delivery with its line breaks intact rather than split
// into one message per line (the exact failure `pasteText` exists to prevent).
check("the steer arrived as one contiguous block", (payload.match(/[Nn]ew GitHub/g) ?? []).length === 1)
check("counts the whole real burst", /3 new GitHub items on nubjs\/nub#587/.test(payload))
check("names the maintainer's comment", payload.includes("@colinhacks") && payload.includes("2026-07-29T15:39:28Z"))
check("names the bot reviews", payload.includes("@pullfrog"))
const bullets = payload.split("\n").filter((l) => l.trim().startsWith("- "))
check("every named item carries a real permalink", bullets.length > 0 && bullets.every((l) => /https:\/\/github\.com\/nubjs\/nub\/pull\/587#/.test(l)))
check("the embedded newlines survived the paste", bullets.length === 3, `${bullets.length} bullet line(s)`)
check("never names the stale 07:36 comment", payload.length > 0 && !payload.includes("2026-07-29T07:36:03Z"))

// ---- 4. render it: append what the worker received, so the chat shows the real steer ---------------
// From the steer's leading icon THROUGH the wake-delivery token, because a real worker's transcript
// records the delivered text WITH that token — it is how the outbox acks the delivery, and it is
// also the server's only tell that fray (not the human) wrote the turn, which is what promotes it
// out of the human's bubble into the first-party card. Dropping it here would silently test the
// wrong render path.
const start = payload.search(/[\u{1F464}\u{1F916}]/u)
const steer = payload.slice(start < 0 ? 0 : start).trim()
const delivered = {
  parentUuid: "00000002-0000-4000-8000-000000000000", isSidechain: false, type: "user",
  message: { role: "user", content: steer },
  uuid: "00000003-0000-4000-8000-000000000000", timestamp: new Date().toISOString(), session_id: SESSION_ID, cwd,
}
writeFileSync(jsonlPath, readFileSync(jsonlPath, "utf8") + JSON.stringify(delivered) + "\n")
console.log(`appended the delivered steer to the transcript for the render check\n`)

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
