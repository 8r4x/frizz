import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpTranscriptWriter, acpTranscriptPath, createAcpBackend, parseAcpLine, projectAcpTranscript, type AcpRecord } from "./acp-transcript.ts"
import { newTailState } from "../tailer.ts"

// One recorded turn, in the shape the bridge writes it (an opencode turn that wrote a file, ran a
// command, then answered), followed by a follow-up whose turn is still open.
const T = (s: number) => `2026-09-15T22:00:${String(s).padStart(2, "0")}.000Z`
const RECORDS: AcpRecord[] = [
  { kind: "acp-session", at: T(0), agent: { id: "opencode", name: "OpenCode", version: "1.18.29" }, acpSessionId: "ses_1", cwd: "/tmp/p", model: "opencode/big-pickle" },
  { kind: "user-message", at: T(1), text: "Create hello.txt and cat it.", synthetic: false },
  { kind: "turn-start", at: T(1) },
  { kind: "reasoning", at: T(2), text: "The user wants a file, then a cat." },
  { kind: "assistant-text", at: T(2), text: "I'll write the file first.", final: false, messageId: "m1" },
  { kind: "tool-call", at: T(3), id: "call_w", name: "write", input: { filePath: "/tmp/p/hello.txt", content: "hi" }, acp: { kind: "edit", title: "hello.txt", locations: ["/tmp/p/hello.txt"] } },
  { kind: "tool-result", at: T(4), id: "call_w", text: "Wrote file successfully." },
  { kind: "tool-call", at: T(4), id: "call_b", name: "bash", input: { command: "cat hello.txt", workdir: "/tmp/p" }, acp: { kind: "execute", title: "cat hello.txt" } },
  { kind: "tool-result", at: T(5), id: "call_b", text: "hi" },
  { kind: "assistant-text", at: T(6), text: "Done: the file", final: false, messageId: "m2" },
  { kind: "assistant-text", at: T(6), text: " contains `hi`.", final: true, messageId: "m2" },
  { kind: "context-usage", at: T(6), tokens: 14120, window: 200000 },
  { kind: "turn-end", at: T(6), finalText: "Done: the file contains `hi`.", successful: true },
  { kind: "user-message", at: T(9), text: "Now delete it.", synthetic: false },
  { kind: "turn-start", at: T(9) },
]
const RAW = RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n"

test("acp-transcript: parseAcpLine strips the transcript-only fields and skips the header", () => {
  assert.deepEqual(parseAcpLine(JSON.stringify(RECORDS[0])), [])
  assert.deepEqual(parseAcpLine(JSON.stringify(RECORDS[4])), [{ kind: "assistant-text", at: T(2), text: "I'll write the file first.", final: false }])
  assert.deepEqual(parseAcpLine(JSON.stringify(RECORDS[5])), [{ kind: "tool-call", at: T(3), id: "call_w", name: "write", input: { filePath: "/tmp/p/hello.txt", content: "hi" } }])
  assert.deepEqual(parseAcpLine("not json"), [])
  assert.deepEqual(parseAcpLine('{"kind":"something-new","at":"x"}'), [], "an unknown record kind is skipped, never thrown")
})

test("acp-transcript: the fold reaches idle with the final preview after the first turn, and in-flight after the follow-up", () => {
  const backend = createAcpBackend({ stateDir: "/tmp/state" })
  assert.equal(backend.transcriptPath("abc"), acpTranscriptPath("/tmp/state", "abc"))
  const s = newTailState("t", "s", "/x")
  const lines = RAW.split("\n")
  for (const line of lines.slice(0, 13)) backend.foldLine(s, line)
  assert.equal(s.model, "opencode/big-pickle", "the header pins the model the agent reported")
  assert.equal(s.turn, "idle")
  assert.equal(s.lastAssistant, "Done: the file contains `hi`.")
  assert.equal(s.lastAssistantAt, T(6))
  assert.equal(s.lastUserAt, T(1))
  assert.equal(s.firstUserText, "Create hello.txt and cat it.")
  for (const line of lines.slice(13)) backend.foldLine(s, line)
  assert.equal(s.turn, "in-flight")
  assert.equal(s.lastUserAt, T(9))
})

test("acp-transcript: the drawer projection — user bubble, reasoning, one assistant message with ordered parts, tool statuses", () => {
  const msgs = projectAcpTranscript(RAW, "acp:s")
  assert.deepEqual(msgs.map((m) => [m.role, m.kind ?? "message"]), [
    ["user", "message"], ["assistant", "reasoning"], ["assistant", "message"], ["user", "message"],
  ])
  assert.equal(msgs[0]!.text, "Create hello.txt and cat it.")
  assert.equal(msgs[0]!.sourceId, "acp:s:1")
  assert.equal(msgs[1]!.text, "The user wants a file, then a cat.")
  const a = msgs[2]!
  assert.deepEqual(a.parts.map((p) => p.kind), ["text", "tools", "text"])
  assert.equal(a.text, "I'll write the file first.\n\nDone: the file contains `hi`.", "two partial flushes of message m2 render as one text part")
  assert.deepEqual(a.tools.map((t) => [t.name, t.status, t.detail, t.output]), [
    ["write", "completed", "/tmp/p/hello.txt", "Wrote file successfully."],
    ["bash", "completed", "cat hello.txt", "hi"],
  ])
  assert.equal(a.tools[1]!.command, "cat hello.txt")
  assert.equal(a.tools[0]!.command, undefined)
  assert.match(a.tools[0]!.input ?? "", /hello\.txt/)
  assert.equal(msgs[3]!.text, "Now delete it.")
})

test("acp-transcript: a provider error closes the assistant message with the error attached; a synthetic user record is a wake", () => {
  const recs: AcpRecord[] = [
    { kind: "user-message", at: T(1), text: "go", synthetic: false },
    { kind: "turn-start", at: T(1) },
    { kind: "provider-error", at: T(2), error: { message: "Authentication required", code: "-32000" } },
    { kind: "turn-end", at: T(2), successful: false },
    { kind: "user-message", at: T(3), text: "Goal: keep going", synthetic: true },
  ]
  const msgs = projectAcpTranscript(recs.map((r) => JSON.stringify(r)).join("\n"))
  assert.equal(msgs.length, 3)
  assert.equal(msgs[1]!.providerError?.message, "Authentication required")
  assert.equal(msgs[2]!.wake, true)
})

test("acp-transcript: the writer creates the file under <stateDir>/acp on construction and appends one JSON line per record", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "acp-transcript-"))
  const w = new AcpTranscriptWriter(acpTranscriptPath(stateDir, "sess-1"))
  assert.equal(readFileSync(w.path, "utf8"), "")
  w.append(RECORDS[0]!)
  w.append(RECORDS[1]!)
  const lines = readFileSync(w.path, "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[1]!).text, "Create hello.txt and cat it.")
})
