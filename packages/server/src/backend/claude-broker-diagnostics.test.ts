import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import {
  claudeBrokerDiagnosticLogPath,
  createClaudeBrokerDiagnosticWriter,
  readClaudeBrokerDiagnostics,
} from "./claude-broker-diagnostics.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "frizz-brokerdiag-"))
const meta = { daemonPid: 4242, generation: "gen-1" }

test("the writer creates its directory and appends one JSON line per diagnostic", () => {
  const dir = tmp()
  const path = claudeBrokerDiagnosticLogPath(dir, "sess")
  const write = createClaudeBrokerDiagnosticWriter(path, meta, () => new Date("2026-07-01T00:00:00.000Z"))
  write({ kind: "lifecycle", phase: "started" })
  write({ kind: "stderr", message: "something went wrong", truncated: false })
  write({ kind: "lifecycle", phase: "crashed", message: "claude exited 1" })

  const lines = readFileSync(path, "utf8").trim().split("\n")
  assert.equal(lines.length, 3)
  const first = JSON.parse(lines[0])
  assert.deepEqual(first, { at: "2026-07-01T00:00:00.000Z", daemonPid: 4242, generation: "gen-1", diagnostic: { kind: "lifecycle", phase: "started" } })
})

test("stderr is KEPT — for Claude it carries the error text, not a byte-count ping", () => {
  // The codex sink drops `stderr` because those are high-frequency pings. Claude's is the CLI's own
  // (credential-redacted, 4KB-capped) error output, which is the whole point of the log.
  const dir = tmp()
  const path = claudeBrokerDiagnosticLogPath(dir, "sess")
  createClaudeBrokerDiagnosticWriter(path, meta)({ kind: "stderr", message: "Error: not logged in", truncated: false })
  const records = readClaudeBrokerDiagnostics(dir, "sess")
  assert.equal(records.length, 1)
  assert.equal(records[0].diagnostic.kind, "stderr")
})

test("readClaudeBrokerDiagnostics returns nothing for a session that never wrote one", () => {
  assert.deepEqual(readClaudeBrokerDiagnostics(tmp(), "never"), [])
})

test("a truncated final line — the normal shape of a killed writer — is skipped, not thrown", () => {
  // This is the case the log exists for: the daemon died mid-append. Refusing to read the file then
  // would lose exactly the forensics it was written to preserve.
  const dir = tmp()
  const path = claudeBrokerDiagnosticLogPath(dir, "sess")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ at: "2026-07-01T00:00:00.000Z", daemonPid: 1, generation: "g", diagnostic: { kind: "lifecycle", phase: "started" } }) + "\n")
  appendFileSync(path, '{"at":"2026-07-01T00:00:01.000Z","daemonPid":1,"gener')

  const records = readClaudeBrokerDiagnostics(dir, "sess")
  assert.equal(records.length, 1)
  assert.equal(records[0].diagnostic.kind, "lifecycle")
})

test("the rotated file is read BEFORE the current one, so history stays in order", () => {
  const dir = tmp()
  const path = claudeBrokerDiagnosticLogPath(dir, "sess")
  mkdirSync(dirname(path), { recursive: true })
  const line = (msg: string) => JSON.stringify({ at: "2026-07-01T00:00:00.000Z", daemonPid: 1, generation: "g", diagnostic: { kind: "stderr", message: msg, truncated: false } }) + "\n"
  writeFileSync(`${path}.1`, line("older"))
  writeFileSync(path, line("newer"))
  const messages = readClaudeBrokerDiagnostics(dir, "sess").map((r) => (r.diagnostic as { message: string }).message)
  assert.deepEqual(messages, ["older", "newer"])
})

test("a write failure never throws back into the session it is observing", () => {
  // The directory path is occupied by a FILE, so mkdirSync and appendFileSync both fail.
  const dir = tmp()
  writeFileSync(join(dir, "claude-broker"), "not a directory")
  const write = createClaudeBrokerDiagnosticWriter(claudeBrokerDiagnosticLogPath(dir, "sess"), meta)
  assert.doesNotThrow(() => write({ kind: "lifecycle", phase: "crashed", message: "boom" }))
})
