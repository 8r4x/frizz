// END-TO-END proof that a REAL Claude broker worker cannot call AskUserQuestion.
//
//   nub scripts/verify-ask-reblock.mjs <port>
//
// Dispatches a genuine broker session (real claude, real SDK daemon) into whatever throwaway project the
// stack on <port> owns, and asks it — in its own words — whether the tool is in its tool list. A unit
// test can only prove that `disallowedTools` was passed; only the real binary proves the model actually
// cannot see it. Reads the verdict out of the session's own transcript JSONL.
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createRpcClient } from "./lib/rpc-client.mjs"

const port = process.argv[2] ?? "4953"
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()

const board = await api.query("board")
const cwdSlug = board.projectDir.replaceAll("/", "-")

const PROMPT = [
  "Answer in ONE short paragraph and then stop. Do NOT use any other tool first.",
  "",
  "Is the tool named AskUserQuestion available to you in this session? Answer literally:",
  "start your reply with AVAILABLE=YES or AVAILABLE=NO, then say how you know.",
  "Then actually TRY to call AskUserQuestion once with a throwaway question, and report verbatim what",
  "happened — whether the tool existed at all, or whether the call was refused and with what message.",
].join("\n")

const { slug, sessionId } = await api.mutate("dispatch", { prompt: PROMPT, backend: "claude", model: "sonnet", effort: "low" })
console.log(`dispatched ${slug} / ${sessionId}`)

const transcript = join(homedir(), ".claude", "projects", cwdSlug, `${sessionId}.jsonl`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const read = () => {
  if (!existsSync(transcript)) return []
  return readFileSync(transcript, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
}

const deadline = Date.now() + 300_000
let records = []
for (;;) {
  records = read()
  const done = records.some((r) => r.type === "assistant" && r.message?.stop_reason === "end_turn")
  if (done) break
  if (Date.now() > deadline) { console.log("TIMEOUT waiting for the turn to end"); break }
  await sleep(3_000)
}

const say = (label, value) => console.log(`${label}: ${value}`)
const toolUses = records.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []))
  .filter((b) => b?.type === "tool_use").map((b) => b.name)
const text = records.filter((r) => r.type === "assistant")
  .flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []))
  .filter((b) => b?.type === "text").map((b) => b.text).join("\n")

say("tool_use names in the transcript", JSON.stringify(toolUses))
say("AskUserQuestion attempted", String(toolUses.includes("AskUserQuestion")))
console.log("---- the worker's own words ----")
console.log(text.trim().slice(0, 2_000))
console.log("--------------------------------")

const pass = !toolUses.includes("AskUserQuestion") && /AVAILABLE=NO/i.test(text)
console.log(pass ? "PASS: the tool is gone from a real broker worker" : "FAIL: see above")
if (!pass) process.exitCode = 1
