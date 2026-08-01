import { createRequire } from "node:module"
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import assert from "node:assert/strict"
import * as claudeRuntime from "@fray-ui/claude-agent-sdk-runtime"
import {
  CLAUDE_AGENT_SDK_FOUNDATION_FLAG,
  createClaudeDiagnosticRedactor,
  createClaudeQueryFactory,
  claudeAgentSdkFoundationEnabled,
  mapAssistant,
  mapTask,
  type ClaudeQueryHandle,
} from "./claude-agent-sdk.ts"
import {
  CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES,
  CLAUDE_AGENT_SDK_MAX_INPUT_BYTES,
  ClaudeAgentSdkProtocolError,
  boundedJsonObject,
  utf8Bytes,
  type ClaudeDiagnostic,
  type ClaudeQueryEvent,
} from "./claude-agent-sdk-protocol.ts"

const serverRequire = createRequire(import.meta.url)
const runtimePackagePath = fileURLToPath(new URL("../../../claude-agent-sdk-runtime/package.json", import.meta.url))
const runtimeRequire = createRequire(runtimePackagePath)
const sdkEntry = runtimeRequire.resolve("@anthropic-ai/claude-agent-sdk")
const sdkPackage = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf8")) as {
  version?: string
  optionalDependencies?: Record<string, string>
}
const runtimePackage = JSON.parse(readFileSync(runtimePackagePath, "utf8")) as { dependencies?: Record<string, string> }
const runtimeZodPackage = JSON.parse(readFileSync(runtimeRequire.resolve("zod/package.json"), "utf8")) as { version?: string }
const serverZodPackage = JSON.parse(readFileSync(serverRequire.resolve("zod/package.json"), "utf8")) as { version?: string }
const fakeExecutable = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const INPUT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

interface CaptureRecord {
  kind: string
  [key: string]: unknown
}

interface Harness {
  dir: string
  capturePath: string
  diagnostics: ClaudeDiagnostic[]
  handle: ClaudeQueryHandle
  close(): Promise<void>
}

test("Agent SDK and its Zod 4 peer are pinned behind a runtime-only membrane while the server remains on Zod 3", () => {
  assert.equal(sdkPackage.version, "0.3.207")
  assert.equal(runtimePackage.dependencies?.["@anthropic-ai/claude-agent-sdk"], "0.3.207")
  assert.equal(runtimePackage.dependencies?.zod, "4.4.3")
  assert.equal(runtimeZodPackage.version, "4.4.3")
  assert.match(serverZodPackage.version ?? "", /^3\./)
  assert.notEqual(runtimeRequire.resolve("zod"), serverRequire.resolve("zod"))
  assert.deepEqual(Object.keys(claudeRuntime), ["query"], "no Zod schema or provider union crosses the runtime membrane")
  assert.deepEqual(sdkPackage.optionalDependencies, {
    "@anthropic-ai/claude-agent-sdk-linux-x64": "0.3.207",
    "@anthropic-ai/claude-agent-sdk-linux-arm64": "0.3.207",
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl": "0.3.207",
    "@anthropic-ai/claude-agent-sdk-linux-arm64-musl": "0.3.207",
    "@anthropic-ai/claude-agent-sdk-darwin-x64": "0.3.207",
    "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.207",
    "@anthropic-ai/claude-agent-sdk-win32-x64": "0.3.207",
    "@anthropic-ai/claude-agent-sdk-win32-arm64": "0.3.207",
  })
  assert.equal(claudeAgentSdkFoundationEnabled({}), false)
  assert.equal(claudeAgentSdkFoundationEnabled({ [CLAUDE_AGENT_SDK_FOUNDATION_FLAG]: "true" }), false)
  assert.equal(claudeAgentSdkFoundationEnabled({ [CLAUDE_AGENT_SDK_FOUNDATION_FLAG]: "1" }), true)
  assert.throws(
    () => createClaudeQueryFactory({ executablePath: fakeExecutable }),
    (error: unknown) => error instanceof ClaudeAgentSdkProtocolError && /disabled/.test(error.message),
  )
})

test("real SDK + fake executable: init owns the requested session, input streams, and trailing events follow result", { timeout: 10_000 }, async () => {
  const harness = startHarness("basic", { ANTHROPIC_BASE_URL: "https://api.example.test" })
  try {
    const control = await withTimeout(harness.handle.initializationResult(), "initialization result")
    assert.deepEqual(control.commands[0], {
      name: "review",
      description: "Review changes",
      argumentHint: "<path>",
      aliases: ["inspect"],
    })
    assert.equal(control.models[0]?.resolvedModel, "claude-sonnet-test")

    const ready = await withTimeout(harness.handle.ready(), "session init")
    assert.equal(ready.sessionId, SESSION_ID)
    assert.equal(ready.claudeCodeVersion, "2.1.207")
    assert.deepEqual(ready.capabilities, ["interrupt_receipt_v1", "future_unknown_capability"])

    await harness.handle.send({ id: INPUT_ID, text: "hello from streaming input" })
    const events = await collectThrough(harness.handle, "prompt-suggestion")
    assert.deepEqual(events.map((event) => event.kind), ["init", "user", "assistant", "result", "prompt-suggestion"])
    assert.equal(events.find((event) => event.kind === "result")?.kind, "result")
    assert.equal((events.find((event) => event.kind === "result") as Extract<ClaudeQueryEvent, { kind: "result" }>).result, "fake final result")
    assert.equal((events.at(-1) as Extract<ClaudeQueryEvent, { kind: "prompt-suggestion" }>).suggestion, "Run another fake turn")

    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "user-input"))
    const startup = records.find((row) => row.kind === "startup") as CaptureRecord
    const argv = startup.argv as string[]
    assert.deepEqual(argv.slice(0, 5), ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"])
    assert.ok(argv.includes("--no-session-persistence"))
    // PROJECT + LOCAL, never USER: a dispatched worker reads the repo's own CLAUDE.md / AGENTS.md and
    // .claude/skills, and never the operator's personal ~/.claude config. This pinned the empty (fully
    // hermetic) form until 2026-07-26, when a measured differential showed the broker — by then the
    // DEFAULT Claude transport — was answering `NO-CLAUDE-MD` where a plain `claude -p` in the same
    // cwd read the project's first heading.
    assert.ok(argv.includes("--setting-sources=project,local"), `argv had: ${argv.filter((a) => a.startsWith("--setting-sources")).join(",") || "no --setting-sources flag"}`)
    assert.equal(argv[argv.indexOf("--session-id") + 1], SESSION_ID)
    assert.deepEqual(startup.environment, {
      frayFakeInheritedPresent: false,
      frayFakeOverridePresent: false,
      clientApp: "fray/claude-agent-sdk-foundation",
      entrypoint: "sdk-ts",
      pathPresent: true,
      homePresent: true,
      nodeOptionsPresent: false,
      anthropicApiKeyPresent: false,
      anthropicBaseUrlPresent: true,
      anthropicAuthTokenPresent: false,
      oauthTokenPresent: false,
      githubTokenPresent: false,
      openaiApiKeyPresent: false,
      awsSecretAccessKeyPresent: false,
      fraySecretPresent: false,
      arbitrarySecretPresent: false,
    })
    assert.deepEqual(records.find((row) => row.kind === "user-input"), {
      kind: "user-input",
      uuid: INPUT_ID,
      text: "hello from streaming input",
      // An ordinary send is a MAIN-THREAD turn and must stay one. `null` here is the whole guarantee
      // that adding sub-agent addressing did not quietly re-route every follow-up fray sends.
      parentToolUseId: null,
    })
  } finally {
    await harness.close()
  }
})

test("stopTask reaches the provider control channel with the exact runtime task id", { timeout: 10_000 }, async () => {
  const harness = startHarness("basic")
  try {
    await harness.handle.ready()
    await harness.handle.stopTask("agent-task-123")
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "stop-task"))
    assert.deepEqual(
      records.filter((row) => row.kind === "stop-task").map((row) => row.taskId),
      ["agent-task-123"],
    )
    await assert.rejects(() => harness.handle.stopTask("../unsafe task"), /not a valid opaque id/)
  } finally {
    await harness.close()
  }
})

test("session init mismatch fails ownership before exposing provider events", { timeout: 10_000 }, async () => {
  const harness = startHarness("mismatch")
  try {
    await assert.rejects(harness.handle.initializationResult(), /session ownership mismatch/)
    await assert.rejects(harness.handle.ready(), /session ownership mismatch/)
    await assert.rejects(harness.handle.next(), /session ownership mismatch/)
    assert.ok(harness.diagnostics.some((event) => event.kind === "lifecycle" && event.phase === "crashed"))
  } finally {
    await harness.close()
  }
})

test("resume selection uses the explicit owned UUID and never falls back to a new session", { timeout: 10_000 }, async () => {
  const harness = startHarness("basic", {}, {}, { kind: "resume", sessionId: SESSION_ID })
  try {
    assert.equal((await harness.handle.ready()).sessionId, SESSION_ID)
    await harness.handle.send({ id: INPUT_ID, text: "resume input" })
    await collectThrough(harness.handle, "result")
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "user-input"))
    const argv = records.find((row) => row.kind === "startup")?.argv as string[]
    assert.equal(argv[argv.indexOf("--resume") + 1], SESSION_ID)
    assert.equal(argv.includes("--session-id"), false)
  } finally {
    await harness.close()
  }
})

test("initialization capabilities remain hidden when the provider never establishes session ownership", { timeout: 10_000 }, async () => {
  const harness = startHarness("no-init")
  const initialization = harness.handle.initializationResult()
  try {
    await assert.rejects(withTimeout(initialization, "withheld initialization", 150), /timed out/)
  } finally {
    await harness.close()
  }
  await assert.rejects(initialization)
})

test("a same-session re-init is tolerated (real claude re-emits init every turn) and the stream continues", { timeout: 10_000 }, async () => {
  const harness = startHarness("duplicate-init")
  try {
    await harness.handle.ready()
    const init = await harness.handle.next()
    assert.equal(init.value?.kind, "init")
    // The provider re-emits init for the SAME session at each turn; it is swallowed (not surfaced, not
    // fatal), and the next genuine event — the result — is delivered normally.
    const next = await harness.handle.next()
    assert.equal(next.value?.kind, "result")
  } finally {
    await harness.close()
  }
})

test("control frames that precede the session init are tolerated (same session) and init still owns the stream", { timeout: 10_000 }, async () => {
  const harness = startHarness("preinit-control")
  try {
    const ready = await harness.handle.ready()
    assert.equal(ready.kind, "init") // the pre-init control frame was swallowed; init resolved ready
    const init = await harness.handle.next()
    assert.equal(init.value?.kind, "init") // and init is still the FIRST event a consumer sees
  } finally {
    await harness.close()
  }
})

test("a pre-init control frame from a DIFFERENT session is rejected (ownership before init)", { timeout: 10_000 }, async () => {
  const harness = startHarness("preinit-mismatch")
  try {
    await assert.rejects(harness.handle.ready(), /session ownership mismatch/)
  } finally {
    await harness.close()
  }
})

test("a SUBSTANTIVE event before init is rejected even from the owned session", { timeout: 10_000 }, async () => {
  const harness = startHarness("preinit-substantive")
  try {
    await assert.rejects(harness.handle.ready(), /non-init event before session ownership/)
  } finally {
    await harness.close()
  }
})

test("a re-init that switches to a different session id is rejected", { timeout: 10_000 }, async () => {
  const harness = startHarness("cross-session-reinit")
  try {
    await harness.handle.ready()
    const init = await harness.handle.next()
    assert.equal(init.value?.kind, "init")
    await assert.rejects(harness.handle.next(), /session ownership mismatch/)
  } finally {
    await harness.close()
  }
})

test("every post-init provider event must carry the owned session id", { timeout: 10_000 }, async () => {
  const harness = startHarness("missing-session")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "missing session" })
    const init = await harness.handle.next()
    assert.equal(init.value?.kind, "init")
    await assert.rejects(harness.handle.next(), /missing session ownership/)
  } finally {
    await harness.close()
  }
})

test("a later provider event cannot cross the initialized session boundary", { timeout: 10_000 }, async () => {
  const harness = startHarness("late-mismatch")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "cross session" })
    const init = await harness.handle.next()
    assert.equal(init.value?.kind, "init")
    await assert.rejects(harness.handle.next(), /crossed session ownership/)
  } finally {
    await harness.close()
  }
})

test("canUseTool request and structured allow response traverse the real SDK control channel", { timeout: 10_000 }, async () => {
  let observedRequest: unknown
  const harness = startHarness("permission", {}, {
    canUseTool: async (request) => {
      observedRequest = request
      return {
        behavior: "allow",
        updatedInput: { ...request.input, approvedBy: "fray-test" },
        updatedPermissions: [{
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "printf *" }],
          behavior: "allow",
          destination: "session",
        }],
      }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "request permission" })
    const events = await collectThrough(harness.handle, "result")
    assert.ok(events.some((event) => event.kind === "user" && event.toolResultIds.includes("tool-use-permission-1")))
    assert.deepEqual(observedRequest, {
      requestId: "permission-request-1",
      toolUseId: "tool-use-permission-1",
      agentId: "agent-main",
      toolName: "Bash",
      input: { command: "printf safe" },
      blockedPath: "/tmp/outside",
      decisionReason: "outside the working directory",
      title: "Run a safe command",
      displayName: "Run command",
      description: "Print a test marker",
      suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "printf *" }], behavior: "allow", destination: "session" }],
    })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "host-response"))
    const response = records.find((row) => row.kind === "host-response")?.response as Record<string, unknown>
    assert.deepEqual(response.response, {
      behavior: "allow",
      updatedInput: { command: "printf safe", approvedBy: "fray-test" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "printf *" }], behavior: "allow", destination: "session" }],
      toolUseID: "tool-use-permission-1",
    })
  } finally {
    await harness.close()
  }
})

test("AskUserQuestion preserves original questions and returns the exact updatedInput answer contract", { timeout: 10_000 }, async () => {
  const harness = startHarness("ask", {}, {
    canUseTool: async (request) => {
      assert.equal(request.toolName, "AskUserQuestion")
      const questions = request.input.questions
      assert.ok(Array.isArray(questions))
      return {
        behavior: "allow",
        updatedInput: {
          questions,
          answers: { "Which release channel?": "Stable" },
        },
      }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "ask me" })
    await collectThrough(harness.handle, "result")
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.requestId === "ask-request-1" && row.kind === "host-response"))
    const response = records.find((row) => row.requestId === "ask-request-1" && row.kind === "host-response")?.response as {
      response?: { updatedInput?: Record<string, unknown>; toolUseID?: string }
    }
    assert.deepEqual(response.response?.updatedInput, {
      questions: [{
        question: "Which release channel?",
        header: "Channel",
        options: [{ label: "Stable", description: "Use stable" }, { label: "Beta", description: "Use beta" }],
        multiSelect: false,
      }],
      answers: { "Which release channel?": "Stable" },
    })
    assert.equal(response.response?.toolUseID, "tool-use-ask-1")
  } finally {
    await harness.close()
  }
})

test("form and URL MCP elicitation callbacks both traverse the real SDK control channel", { timeout: 10_000 }, async () => {
  const modes: Array<string | undefined> = []
  const harness = startHarness("elicitation", {}, {
    onElicitation: async (request) => {
      modes.push(request.mode)
      if (request.mode === "form") {
        assert.deepEqual(request.requestedSchema, {
          type: "object",
          properties: { region: { type: "string", enum: ["us-west", "eu-central"] } },
          required: ["region"],
        })
        return { action: "accept", content: { region: "us-west" } }
      }
      assert.equal(request.url, "https://example.test/approve?id=safe")
      assert.equal(request.elicitationId, "elicitation-safe-1")
      return { action: "accept" }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "elicit" })
    await collectThrough(harness.handle, "result")
    assert.deepEqual(modes, ["form", "url"])
    const records = await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => row.kind === "host-response").length >= 2)
    const form = records.find((row) => row.requestId === "elicitation-form-1")?.response as { response?: unknown }
    const url = records.find((row) => row.requestId === "elicitation-url-1")?.response as { response?: unknown }
    assert.deepEqual(form.response, { action: "accept", content: { region: "us-west" } })
    assert.deepEqual(url.response, { action: "accept" })
  } finally {
    await harness.close()
  }
})

test("reinitialize reuses the cached decision for a same-id same-payload permission redelivery", { timeout: 10_000 }, async () => {
  const calls: string[] = []
  const harness = startHarness("redelivery", {}, {
    canUseTool: async (request) => {
      calls.push(request.requestId)
      return { behavior: "allow", updatedInput: request.input }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "redeliver" })
    await waitFor(() => calls.length === 1, "first permission callback")
    await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => row.kind === "host-response" && row.requestId === "permission-request-1").length === 1)

    const refreshed = await harness.handle.reinitialize()
    assert.equal(refreshed.outputStyle, "default")
    await collectThrough(harness.handle, "result")
    assert.deepEqual(calls, ["permission-request-1"])
    const records = readCapture(harness.capturePath)
    assert.equal(records.filter((row) => row.kind === "host-response" && row.requestId === "permission-request-1").length, 2)
    assert.equal(records.filter((row) => row.kind === "host-control" && row.subtype === "initialize").length, 2)
  } finally {
    await harness.close()
  }
})

test("same permission request id with a conflicting redelivery payload fails closed", { timeout: 10_000 }, async () => {
  const calls: string[] = []
  const harness = startHarness("conflicting-redelivery", {}, {
    canUseTool: async (request) => {
      calls.push(String(request.input.command))
      return { behavior: "allow", updatedInput: request.input }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "conflict" })
    await waitFor(() => calls.length === 1, "first conflicting permission callback")
    await harness.handle.reinitialize()
    const records = await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => row.kind === "host-response" && row.requestId === "permission-request-1").length >= 2)
    assert.deepEqual(calls, ["printf safe"])
    const second = records.filter((row) => row.kind === "host-response" && row.requestId === "permission-request-1")[1]?.response as { subtype?: string; error?: string }
    assert.equal(second.subtype, "error")
    assert.match(second.error ?? "", /conflict/i)
  } finally {
    await harness.close()
  }
})

test("a permission control request without requestId fails before entering the host callback", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("permission-missing-request-id", {}, {
    canUseTool: async () => {
      calls += 1
      return { behavior: "allow" }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "missing request id" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "host-response"))
    assert.equal(calls, 0)
    const response = records.find((row) => row.kind === "host-response")?.response as { subtype?: string; error?: string }
    assert.equal(response.subtype, "error")
    assert.match(response.error ?? "", /requestId|request id|text/i)
  } finally {
    await harness.close()
  }
})

test("provider-consumed input cannot bypass UUID backpressure or duplicate protection", { timeout: 10_000 }, async () => {
  const harness = startHarness("hold-inputs")
  try {
    await harness.handle.ready()
    for (let index = 0; index < 64; index += 1) {
      await harness.handle.send({ id: inputId(index), text: `queued ${index}` })
    }
    await assert.rejects(harness.handle.send({ id: inputId(0), text: "duplicate" }), /already outstanding/)
    await assert.rejects(harness.handle.send({ id: inputId(64), text: "overflow" }), /outstanding input limit/)
  } finally {
    await harness.close()
  }
})

// A SUB-AGENT STEER is one addressed input frame and nothing else — there is no per-agent control
// request in the SDK (`stopTask` / `backgroundTasks` are the whole per-task surface). So the ONE thing
// the adapter must get right is which value lands in `parent_tool_use_id`: null keeps the message on
// the session's main thread (every follow-up fray has ever sent, which must stay byte-identical), and
// the child's dispatch tool_use id routes it into that child's own conversation. Asserted on the wire
// frame the CLI actually reads, because that is where the routing decision is consumed.
test("addressing an input routes it to the sub-agent; omitting it stays a main-thread turn", { timeout: 10_000 }, async () => {
  const harness = startHarness("hold-inputs")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: inputId(0), text: "main thread" })
    await harness.handle.send({ id: inputId(1), text: "steer the child", parentToolUseId: "toolu_child_01" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => row.kind === "user-input").length === 2)
    const inputs = records.filter((row) => row.kind === "user-input")
    assert.equal(inputs[0]?.parentToolUseId, null, "an unaddressed send is the main turn, exactly as before")
    assert.equal(inputs[1]?.parentToolUseId, "toolu_child_01", "the steer carries the child's dispatch id")
  } finally {
    await harness.close()
  }
})

test("an addressing id is validated as an opaque provider id, never passed through raw", { timeout: 10_000 }, async () => {
  const harness = startHarness("hold-inputs")
  try {
    await harness.handle.ready()
    await assert.rejects(
      harness.handle.send({ id: inputId(2), text: "hostile", parentToolUseId: "toolu bad id" }),
      /not a valid opaque id/,
    )
  } finally {
    await harness.close()
  }
})

test("an exact provider receipt releases an input UUID for deliberate reuse", { timeout: 10_000 }, async () => {
  const harness = startHarness("basic")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "first use" })
    await collectThrough(harness.handle, "user")
    await harness.handle.send({ id: INPUT_ID, text: "second use after receipt" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => row.kind === "user-input" && row.uuid === INPUT_ID).length === 2)
    assert.equal(records.filter((row) => row.kind === "user-input" && row.uuid === INPUT_ID).length, 2)
  } finally {
    await harness.close()
  }
})

test("a synthetic user-role event cannot spoof an outstanding input UUID receipt", { timeout: 10_000 }, async () => {
  const harness = startHarness("synthetic-receipt")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "keep this outstanding" })
    const events = await collectThrough(harness.handle, "user")
    const synthetic = events.find((event) => event.kind === "user") as Extract<ClaudeQueryEvent, { kind: "user" }>
    assert.equal(synthetic.synthetic, true)
    assert.equal(synthetic.messageId, INPUT_ID)
    await assert.rejects(harness.handle.send({ id: INPUT_ID, text: "spoofed duplicate" }), /already outstanding/)
  } finally {
    await harness.close()
  }
})

test("an unmarked tool-result event cannot spoof an outstanding input UUID receipt", { timeout: 10_000 }, async () => {
  const harness = startHarness("tool-result-receipt")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "keep tool result outstanding" })
    const events = await collectThrough(harness.handle, "user")
    const toolResult = events.find((event) => event.kind === "user") as Extract<ClaudeQueryEvent, { kind: "user" }>
    assert.equal(toolResult.synthetic, false)
    assert.deepEqual(toolResult.toolResultIds, ["receipt-tool"])
    await assert.rejects(harness.handle.send({ id: INPUT_ID, text: "tool-result duplicate" }), /already outstanding/)
  } finally {
    await harness.close()
  }
})

test("subagent assistant progress cannot release a main-thread outstanding input", { timeout: 10_000 }, async () => {
  const harness = startHarness("subagent-progress")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "main-thread input" })
    const events = await collectThrough(harness.handle, "assistant")
    const assistant = events.find((event) => event.kind === "assistant") as Extract<ClaudeQueryEvent, { kind: "assistant" }>
    assert.equal(assistant.parentToolUseId, "subagent-parent-tool")
    await assert.rejects(harness.handle.send({ id: INPUT_ID, text: "subagent-spoofed duplicate" }), /already outstanding/)
  } finally {
    await harness.close()
  }
})

test("provider progression without an echo releases only the progressed outstanding input", { timeout: 10_000 }, async () => {
  const harness = startHarness("progress-no-receipt")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "progress" })
    await harness.handle.send({ id: inputId(1), text: "still queued" })
    await collectThrough(harness.handle, "assistant")
    await collectThrough(harness.handle, "result")
    await harness.handle.send({ id: INPUT_ID, text: "reused after progression" })
    await assert.rejects(harness.handle.send({ id: inputId(1), text: "must remain outstanding" }), /already outstanding/)
  } finally {
    await harness.close()
  }
})

test("interrupt receipt and live permission-mode change are capability/control-channel grounded", { timeout: 10_000 }, async () => {
  const harness = startHarness("controls")
  try {
    const init = await harness.handle.ready()
    assert.ok(init.capabilities.includes("interrupt_receipt_v1"))
    assert.deepEqual(await harness.handle.interrupt(), {
      stillQueued: ["11111111-1111-4111-8111-111111111111", "internal-queue-id"],
    })
    await harness.handle.setPermissionMode("auto")
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "host-control" && row.subtype === "set_permission_mode"))
    assert.ok(records.some((row) => row.kind === "host-control" && row.subtype === "interrupt"))
    assert.ok(records.some((row) => row.kind === "host-control" && row.subtype === "set_permission_mode" && row.mode === "auto"))
  } finally {
    await harness.close()
  }
})

test("older/no-receipt capability returns undefined instead of fabricating queue state", { timeout: 10_000 }, async () => {
  const harness = startHarness("controls-no-receipt")
  try {
    const init = await harness.handle.ready()
    assert.deepEqual(init.capabilities, [])
    assert.equal(await harness.handle.interrupt(), undefined)
  } finally {
    await harness.close()
  }
})

test("clean EOF completes the event iterator after result and trailing events", { timeout: 10_000 }, async () => {
  const harness = startHarness("eof")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "finish" })
    await collectThrough(harness.handle, "prompt-suggestion")
    assert.deepEqual(await withTimeout(harness.handle.next(), "EOF"), { done: true, value: undefined })
    assert.ok(harness.diagnostics.some((event) => event.kind === "lifecycle" && event.phase === "closed"))
  } finally {
    await harness.close()
  }
})

test("subprocess crash rejects the iterator without transparent respawn", { timeout: 10_000 }, async () => {
  const harness = startHarness("crash")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "crash" })
    const init = await harness.handle.next()
    assert.equal(init.value?.kind, "init")
    await assert.rejects(withTimeout(harness.handle.next(), "crash"), /Claude SDK process failed/)
    assert.ok(harness.diagnostics.some((event) => event.kind === "lifecycle" && event.phase === "crashed"))
    const starts = readCapture(harness.capturePath).filter((row) => row.kind === "startup")
    assert.equal(starts.length, 1, "the SDK did not silently respawn the fake child")
  } finally {
    await harness.close()
  }
})

test("explicit close ends stdin and cleans up the fake subprocess", { timeout: 10_000 }, async () => {
  const harness = startHarness("close")
  await harness.handle.ready()
  await harness.handle.close()
  try {
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "stdin-end" || row.kind === "signal"))
    assert.ok(records.some((row) => row.kind === "stdin-end" || row.kind === "signal"))
    assert.ok(harness.diagnostics.some((event) => event.kind === "lifecycle" && event.phase === "closed"))
  } finally {
    rmSync(harness.dir, { recursive: true, force: true })
  }
})

test("close is one shared idempotent operation and all send/control entry points fail once closing starts", { timeout: 10_000 }, async () => {
  const harness = startHarness("close")
  await harness.handle.ready()
  const firstClose = harness.handle.close()
  const secondClose = harness.handle.close()
  assert.equal(firstClose, secondClose)
  await Promise.all([firstClose, secondClose])
  await assert.rejects(harness.handle.send({ id: INPUT_ID, text: "too late" }), /closed/)
  await assert.rejects(harness.handle.initializationResult(), /closed/)
  await assert.rejects(harness.handle.reinitialize(), /closed/)
  await assert.rejects(harness.handle.interrupt(), /closed/)
  await assert.rejects(harness.handle.setPermissionMode("auto"), /closed/)
  rmSync(harness.dir, { recursive: true, force: true })
})

test("an in-flight control request cannot win a race with close", { timeout: 10_000 }, async () => {
  const harness = startHarness("hanging-control")
  await harness.handle.ready()
  const interrupt = harness.handle.interrupt()
  await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "host-control" && row.subtype === "interrupt"))
  const close = harness.handle.close()
  await assert.rejects(interrupt, /closed/)
  await withTimeout(close, "close racing control")
  rmSync(harness.dir, { recursive: true, force: true })
})

test("form elicitation rejects secret-like fields before invoking the host callback", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("elicitation-secret", {}, {
    onElicitation: async () => {
      calls += 1
      return { action: "decline" }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "request secret" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "host-response" && row.requestId === "elicitation-secret-1"))
    assert.equal(calls, 0)
    const response = records.find((row) => row.requestId === "elicitation-secret-1")?.response as { subtype?: string; error?: string }
    assert.equal(response.subtype, "error")
    assert.match(response.error ?? "", /secret|sensitive|URL/i)
  } finally {
    await harness.close()
  }
})

test("form elicitation treats authorization-code fields as secret even under an innocuous title", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("elicitation-secret-auth-code", {}, {
    onElicitation: async () => {
      calls += 1
      return { action: "decline" }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "request auth code" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.requestId === "elicitation-secret-auth-code-1"))
    assert.equal(calls, 0)
    const response = records.find((row) => row.requestId === "elicitation-secret-auth-code-1")?.response as { subtype?: string }
    assert.equal(response.subtype, "error")
  } finally {
    await harness.close()
  }
})

test("URL elicitation rejects a confused form schema before invoking the host callback", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("elicitation-url-with-schema", {}, {
    onElicitation: async () => {
      calls += 1
      return { action: "accept" }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "confused elicitation" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.requestId === "elicitation-url-with-schema-1"))
    assert.equal(calls, 0)
    const response = records.find((row) => row.requestId === "elicitation-url-with-schema-1")?.response as { subtype?: string }
    assert.equal(response.subtype, "error")
  } finally {
    await harness.close()
  }
})

test("form elicitation rejects nested provider schemas before invoking the host callback", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("elicitation-nested-schema", {}, {
    onElicitation: async () => {
      calls += 1
      return { action: "decline" }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "nested schema" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.requestId === "elicitation-nested-schema-1"))
    assert.equal(calls, 0)
    const response = records.find((row) => row.requestId === "elicitation-nested-schema-1")?.response as { subtype?: string }
    assert.equal(response.subtype, "error")
  } finally {
    await harness.close()
  }
})

test("form elicitation rejects callback content outside the advertised schema", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("elicitation-invalid-response", {}, {
    onElicitation: async () => {
      calls += 1
      return { action: "accept", content: { region: "north" } }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "invalid response" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.requestId === "elicitation-invalid-response-1"))
    assert.equal(calls, 1)
    const response = records.find((row) => row.requestId === "elicitation-invalid-response-1")?.response as { subtype?: string }
    assert.equal(response.subtype, "error")
  } finally {
    await harness.close()
  }
})

test("hostile permission metadata is rejected without entering the callback", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("permission-hostile", {}, {
    canUseTool: async (request) => {
      calls += 1
      return { behavior: "deny", message: String(request.requestId) }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "hostile request" })
    await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "host-response" && row.requestId === "hostile-request"))
    assert.equal(calls, 0)
  } finally {
    await harness.close()
  }
})

test("permission authority text is rejected rather than sanitized before host review", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("permission-ambiguous-text", {}, {
    canUseTool: async (request) => {
      calls += 1
      return { behavior: "deny", message: request.toolName }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "ambiguous tool" })
    await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.requestId === "ambiguous-text-request"))
    assert.equal(calls, 0)
  } finally {
    await harness.close()
  }
})

test("permission callback idempotency state is bounded under a request flood", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("permission-flood", {}, {
    canUseTool: async (request) => {
      calls += 1
      return { behavior: "allow", updatedInput: request.input }
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "flood" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => row.kind === "host-response" && String(row.requestId).startsWith("permission-flood-")).length === 140)
    // The bound is on STATE, not on a session's lifetime allowance. These 140 requests SETTLE as they
    // go, so the map never holds more than the cap while every request is still served.
    //
    // This asserted `calls === 128` with 12 errors until 2026-07-27, which pinned the actual bug: the
    // cache only ever added entries, so after 128 DISTINCT ids a session rejected every further
    // permission for the rest of its life — a long orchestrator thread silently losing the ability to
    // run any approval-gated tool, with nothing the operator could see. The test could not tell a
    // burst from a lifetime, so the defect was protected by a test that looked like it covered it.
    //
    // A genuinely CONCURRENT flood — callbacks that never settle, so nothing can be evicted — must
    // still reject; that is the shape covered by the hanging-callback test below.
    assert.equal(calls, 140, "every settled request is served; the cap is a concurrency budget")
    assert.equal(records.filter((row) => {
      const response = row.response as { subtype?: string } | undefined
      return row.kind === "host-response" && String(row.requestId).startsWith("permission-flood-") && response?.subtype === "error"
    }).length, 0, "and none are refused just because the session has been busy")
  } finally {
    await harness.close()
  }
})

test("hanging elicitation callbacks are concurrency-bounded under a provider flood", { timeout: 10_000 }, async () => {
  let calls = 0
  const harness = startHarness("elicitation-flood", {}, {
    onElicitation: async () => {
      calls += 1
      return new Promise(() => undefined)
    },
  })
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "flood elicitations" })
    const records = await waitForCapture(harness.capturePath, (rows) => rows.filter((row) => {
      const response = row.response as { subtype?: string } | undefined
      return row.kind === "host-response" && String(row.requestId).startsWith("elicitation-flood-") && response?.subtype === "error"
    }).length >= 12)
    assert.equal(calls, 128)
    assert.equal(records.filter((row) => {
      const response = row.response as { subtype?: string } | undefined
      return row.kind === "host-response" && String(row.requestId).startsWith("elicitation-flood-") && response?.subtype === "error"
    }).length, 12)
  } finally {
    await harness.close()
  }
})

test("closing aborts and detaches a permission callback that never settles", { timeout: 10_000 }, async () => {
  let callbackStarted = false
  let callbackAborted = false
  const harness = startHarness("permission", {}, {
    canUseTool: async (_request, context) => {
      callbackStarted = true
      context.signal.addEventListener("abort", () => { callbackAborted = true }, { once: true })
      return new Promise(() => undefined)
    },
  })
  await harness.handle.ready()
  await harness.handle.send({ id: INPUT_ID, text: "hang" })
  await waitFor(() => callbackStarted, "hanging callback")
  await withTimeout(harness.handle.close(), "close with hanging callback", 5_000)
  await waitFor(() => callbackAborted, "hanging callback abort")
  rmSync(harness.dir, { recursive: true, force: true })
})

test("a provider event flood trips the bounded output queue instead of retaining unbounded data", { timeout: 10_000 }, async () => {
  const harness = startHarness("event-flood")
  try {
    await harness.handle.ready()
    await harness.handle.send({ id: INPUT_ID, text: "flood events" })
    await waitFor(() => harness.diagnostics.some((event) => event.kind === "lifecycle" && event.phase === "crashed"), "event flood failure")
    await assert.rejects(harness.handle.next(), /queue limit/)
  } finally {
    await harness.close()
  }
})

test("child environment drops ambient cross-provider and arbitrary secrets while accepting an explicit Anthropic credential", { timeout: 10_000 }, async () => {
  const dangerous = {
    GITHUB_TOKEN: "github-must-not-cross",
    OPENAI_API_KEY: "openai-must-not-cross",
    AWS_SECRET_ACCESS_KEY: "aws-must-not-cross",
    FRAY_SHOULD_NOT_LEAK: "fray-must-not-cross",
    ARBITRARY_SECRET: "arbitrary-must-not-cross",
  } as const
  const previous = Object.fromEntries(Object.keys(dangerous).map((key) => [key, process.env[key]]))
  Object.assign(process.env, dangerous)
  const harness = startHarness("basic", { ANTHROPIC_API_KEY: "explicit-anthropic-test-key" })
  try {
    await harness.handle.ready()
    const records = await waitForCapture(harness.capturePath, (rows) => rows.some((row) => row.kind === "startup"))
    const environment = records.find((row) => row.kind === "startup")?.environment as Record<string, unknown>
    assert.equal(environment.anthropicApiKeyPresent, true)
    assert.equal(environment.githubTokenPresent, false)
    assert.equal(environment.openaiApiKeyPresent, false)
    assert.equal(environment.awsSecretAccessKeyPresent, false)
    assert.equal(environment.fraySecretPresent, false)
    assert.equal(environment.arbitrarySecretPresent, false)
    const capture = readFileSync(harness.capturePath, "utf8")
    for (const secret of [...Object.values(dangerous), "explicit-anthropic-test-key"]) assert.equal(capture.includes(secret), false)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await harness.close()
  }
})

test("stderr diagnostics are bounded, control-safe, and redact explicit secrets", { timeout: 10_000 }, async () => {
  const secret = "stage-one-secret-value"
  const harness = startHarness("diagnostic", { ANTHROPIC_API_KEY: secret })
  try {
    await harness.handle.ready()
    await waitFor(() => harness.diagnostics.some((event) => event.kind === "stderr"), "stderr diagnostic")
    const stderr = harness.diagnostics.filter((event): event is Extract<ClaudeDiagnostic, { kind: "stderr" }> => event.kind === "stderr")
    assert.ok(stderr.length > 0)
    for (const event of stderr) {
      assert.equal(event.message.includes(secret), false)
      assert.equal(/[\u001b\u202e]/u.test(event.message), false)
      assert.ok(utf8Bytes(event.message) <= CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES)
    }
    assert.ok(stderr.some((event) => event.message.includes("[REDACTED]")))
    assert.ok(stderr.some((event) => event.truncated))
    assert.equal(readFileSync(harness.capturePath, "utf8").includes(secret), false)
  } finally {
    await harness.close()
  }
})

test("thrown errors and stringified metadata redact CLI flags, userinfo, encoded URLs, quoting, and controls", () => {
  const fixtures = {
    user: "fixture-thrown-user-credential",
    password: "fixture thrown password credential",
    token: "fixture-thrown-token-credential",
    encoded: "%66%69%78%74%75%72%65-thrown-url-credential",
  }
  const redact = createClaudeDiagnosticRedactor({})
  const thrown = redact(new Error([
    `curl -u alice:${fixtures.user} --password="${fixtures.password}"`,
    `client --token=${fixtures.token}`,
    `https://bob%3A${fixtures.encoded}@example.test/private`,
    `control=${"\u001b"}[31m`,
  ].join("\n"))).message
  const metadata = redact({
    toString: () => JSON.stringify({
      command: `tool --secret ${fixtures.token}`,
      callback: `https://bob:${fixtures.user}@example.test/callback`,
    }),
  }).message

  for (const fixture of Object.values(fixtures)) {
    assert.equal(thrown.includes(fixture), false, fixture)
    assert.equal(metadata.includes(fixture), false, fixture)
  }
  assert.match(thrown, /curl -u alice:\[REDACTED\] --password=\[REDACTED\]/)
  assert.match(thrown, /--token=\[REDACTED\]/)
  assert.match(thrown, /https:\/\/bob%3A\[REDACTED\]@example\.test/)
  assert.equal(thrown.includes("\u001b"), false)
  assert.match(metadata, /--secret/)
  assert.match(metadata, /\[REDACTED\]/)
})

test("input, JSON, environment, and executable boundaries reject unsafe payloads before provider use", { timeout: 10_000 }, async () => {
  const harness = startHarness("close")
  try {
    await assert.rejects(
      harness.handle.send({ id: INPUT_ID, text: "x".repeat(CLAUDE_AGENT_SDK_MAX_INPUT_BYTES + 1) }),
      /input\.text exceeds/,
    )
    // A C0 control, not a format character. The example here used to be U+061C ARABIC LETTER MARK,
    // which a prompt body now legitimately carries: `validateInputMessage` was narrowed off the
    // display-grade class so that the U+200D every multi-part emoji is built from stops being
    // undeliverable (see claude-agent-sdk-protocol.test.ts). What this boundary still refuses is text
    // that cannot survive the wire, which is what the assertion is here to pin.
    await assert.rejects(
      harness.handle.send({ id: INPUT_ID, text: `unsafe${String.fromCodePoint(27)}input` }),
      /unsafe text/,
    )
    const tooDeep: Record<string, unknown> = {}
    let cursor = tooDeep
    for (let index = 0; index < 20; index += 1) {
      cursor.next = {}
      cursor = cursor.next as Record<string, unknown>
    }
    assert.throws(() => boundedJsonObject(tooDeep, "hostile"), /too complex/)
    const factory = createClaudeQueryFactory({ enabled: true, executablePath: fakeExecutable })
    assert.throws(() => factory.start({
      cwd: harness.dir,
      session: { kind: "new", sessionId: SESSION_ID },
      env: { "INVALID=KEY": "value" },
    }), /invalid key/)
    assert.throws(() => factory.start({
      cwd: harness.dir,
      session: { kind: "new", sessionId: SESSION_ID },
      env: { GITHUB_TOKEN: "must-not-cross" },
    }), /not allowlisted/)
    assert.throws(() => factory.start({
      cwd: harness.dir,
      session: { kind: "new", sessionId: SESSION_ID },
      env: { ANTHROPIC_API_KEY: "abc" },
    }), /too short/)
    assert.throws(() => factory.start({
      cwd: harness.dir,
      session: { kind: "new", sessionId: SESSION_ID },
      env: { ANTHROPIC_API_KEY: 123 as never },
    }), /must be text/)
    assert.throws(() => factory.start({
      cwd: `${harness.dir}\u061c`,
      session: { kind: "new", sessionId: SESSION_ID },
    }), /unsafe or oversized/)
    assert.throws(() => factory.start({
      cwd: harness.dir,
      session: { kind: "new", sessionId: SESSION_ID },
      permissionMode: { toString: () => "default" } as never,
    }), /unsupported/)
    assert.throws(() => createClaudeQueryFactory({ enabled: true, executablePath: join(harness.dir, "missing") }), /not executable/)
  } finally {
    await harness.close()
  }
})

function startHarness(
  scenario: string,
  env: Record<string, string | undefined> = {},
  callbacks: Pick<Parameters<ReturnType<typeof createClaudeQueryFactory>["start"]>[0], "canUseTool" | "onElicitation"> = {},
  session: Parameters<ReturnType<typeof createClaudeQueryFactory>["start"]>[0]["session"] = { kind: "new", sessionId: SESSION_ID },
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "fray-claude-sdk-"))
  const capturePath = join(dir, "capture.jsonl")
  const executablePath = join(dir, `fake-claude--${scenario}.mjs`)
  copyFileSync(fakeExecutable, executablePath)
  chmodSync(executablePath, 0o700)
  const diagnostics: ClaudeDiagnostic[] = []
  const factory = createClaudeQueryFactory({ enabled: true, executablePath })
  const handle = factory.start({
    cwd: dir,
    session,
    env: {
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ...env,
    },
    ...callbacks,
    onDiagnostic(event) {
      diagnostics.push(event)
    },
  })
  return {
    dir,
    capturePath,
    diagnostics,
    handle,
    async close() {
      await handle.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function inputId(index: number): string {
  return `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`
}

async function collectThrough(handle: ClaudeQueryHandle, kind: ClaudeQueryEvent["kind"]): Promise<ClaudeQueryEvent[]> {
  const events: ClaudeQueryEvent[] = []
  while (events.length < 32) {
    const next = await withTimeout(handle.next(), `event ${kind}`)
    if (next.done) throw new Error(`event stream ended before ${kind}`)
    events.push(next.value)
    if (next.value.kind === kind) return events
  }
  throw new Error(`event stream exceeded test bound before ${kind}`)
}

function readCapture(path: string): CaptureRecord[] {
  let contents = ""
  try {
    contents = readFileSync(path, "utf8")
  } catch {
    return []
  }
  return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CaptureRecord)
}

async function waitForCapture(path: string, predicate: (rows: CaptureRecord[]) => boolean): Promise<CaptureRecord[]> {
  let rows: CaptureRecord[] = []
  await waitFor(() => {
    rows = readCapture(path)
    return predicate(rows)
  }, "fake capture")
  return rows
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---- Session survival: a telemetry mapping failure must never end a session ----

const ASSISTANT_RAW = (input: Record<string, unknown>) => ({
  session_id: "11111111-2222-3333-4444-555555555555",
  uuid: "66666666-7777-8888-9999-000000000000",
  message: { content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input }] },
})

test("a tool input with a control character DEGRADES instead of killing the session", () => {
  // The live incident, 2026-07-27 07:03:55: a multi-hour orchestrator thread and every one of its
  // sub-agents destroyed by exactly this shape, because the mapper threw, the error propagated out of
  // the event iterator, and the broker daemon's pump treated any iterator error as terminal:
  //   lifecycle:crashed "assistant.content[0].input.command contains unsafe text"
  // A control character in a Bash command is trivially reachable — echoing terminal output, an ANSI
  // escape, anything binary. It must cost the ARGUMENTS of one telemetry event, never the session.
  const esc = String.fromCharCode(27)
  const event = mapAssistant(ASSISTANT_RAW({ command: `printf '${esc}[31mred${esc}[0m'` })) as Extract<ClaudeQueryEvent, { kind: "assistant" }>
  assert.equal(event.kind, "assistant")
  assert.equal(event.toolUses.length, 1, "the tool call is still reported")
  assert.equal(event.toolUses[0]!.name, "Bash", "id and name survive — only the arguments degrade")
  assert.ok("__frayUnrepresentable" in event.toolUses[0]!.input, `input was ${JSON.stringify(event.toolUses[0]!.input)}`)
})

test("an ordinary tool input is untouched by the degrade path", () => {
  const event = mapAssistant(ASSISTANT_RAW({ command: "ls -la" })) as Extract<ClaudeQueryEvent, { kind: "assistant" }>
  assert.deepEqual(event.toolUses[0]!.input, { command: "ls -la" })
})

test("an UNMAPPABLE frame is dropped and the session keeps running", { timeout: 10_000 }, async () => {
  // The degrade above rescues the input; this rescues everything else. mapSdkMessage can still throw
  // for a frame whose id/name/shape is unrepresentable, and that throw used to reach pump()'s catch —
  // which calls sdkQuery.close(), killing the claude process and every in-flight sub-agent, and
  // reporting lifecycle:crashed. The broker's own error tolerance cannot help: by then the query is
  // already closed. So the skip has to live here, at the mapper call itself.
  //
  // Three real sessions died this way on 2026-07-27 (two "unsafe text", one "oversized text").
  const harness = startHarness("unmappable-event")
  try {
    await harness.handle.ready()
    assert.equal((await harness.handle.next()).value?.kind, "init")
    await harness.handle.send({ id: "11111111-1111-4111-8111-111111111111", text: "go" })
    const kinds: string[] = []
    for (;;) {
      const next = await withTimeout(harness.handle.next(), "unmappable-event stream")
      if (next.done) break
      kinds.push(next.value.kind)
      if (next.value.kind === "result") break
    }
    // The turn completed: the bad frame cost only itself.
    assert.ok(kinds.includes("result"), `stream ended without a result; saw ${kinds.join(",")}`)
    assert.ok(kinds.includes("assistant"), `the assistant text after the bad frame was lost; saw ${kinds.join(",")}`)
    // ...and the drop is reported rather than silent, so an operator can still see it happened.
    assert.ok(
      harness.diagnostics.some((d) => d.kind === "stderr" && /unmappable event dropped/.test(d.message)),
      `no drop diagnostic; saw ${JSON.stringify(harness.diagnostics)}`,
    )
    // The session must NOT have been torn down as a crash.
    assert.ok(
      !harness.diagnostics.some((d) => d.kind === "lifecycle" && d.phase === "crashed"),
      "a dropped telemetry frame reported lifecycle:crashed",
    )
  } finally {
    await harness.close()
  }
})

test("an unrepresentable PERMISSION input is denied, not thrown — content vs protocol", () => {
  // Same class as the assistant crash, on a hotter path: canUseTool fires precisely for risky tool
  // calls, which is exactly where Bash commands (and therefore ANSI escapes) live.
  //
  // The validator stays strict — this decides whether authority is granted, so sanitizing the bytes
  // the provider will act on would be a security bug. What changed is the CONSEQUENCE: an input fray
  // cannot represent denies that one call instead of rejecting the SDK callback, which is how a
  // formatting problem used to become a dead session.
  const esc = String.fromCharCode(27)
  assert.throws(
    () => boundedJsonObject({ command: `printf '${esc}[31m'` }, "permission.input"),
    (e: unknown) => e instanceof ClaudeAgentSdkProtocolError && /unsafe text/.test((e as Error).message),
    "control bytes are still rejected — that strictness is deliberate and load-bearing",
  )
  // A protocol violation is a DIFFERENT case and must keep failing hard: with no requestId there is
  // no correlation id to answer against, so a deny would go nowhere. Pinned by the
  // "without requestId" test above.
  assert.doesNotThrow(() => boundedJsonObject({ command: "ls -la" }, "permission.input"))
})

// ---- Sub-agent task lifecycle: rich payload, and the same degrade contract ----
// These `system` messages are the ONLY place sub-agent progress exists — they are stream-only, absent
// from the session JSONL — so mapping them is what lets the board say what a child is doing. And they
// arrive carrying agent-authored strings (a description, a summary, a task's error text), which is
// exactly the class of value that killed a session on 2026-07-27. Every one of them degrades.

test("mapTask carries the whole sub-agent payload, not just two strings", () => {
  const event = mapTask({
    session_id: "11111111-2222-3333-4444-555555555555",
    uuid: "66666666-7777-8888-9999-000000000000",
    task_id: "task_abc",
    tool_use_id: "toolu_child",
    description: "Audit the tailer fold",
    subagent_type: "fray:opus-high",
    last_tool_name: "Bash",
    summary: "running the live harness",
    usage: { total_tokens: 40123, tool_uses: 18, duration_ms: 92_000 },
  }, "progress")
  assert.equal(event.kind, "task")
  assert.equal(event.phase, "progress")
  assert.equal(event.taskId, "task_abc")
  assert.equal(event.toolUseId, "toolu_child")
  assert.equal(event.description, "Audit the tailer fold")
  assert.equal(event.subagentType, "fray:opus-high")
  assert.equal(event.lastToolName, "Bash")
  assert.equal(event.summary, "running the live harness")
  assert.deepEqual(event.usage, { totalTokens: 40123, toolUses: 18, durationMs: 92_000 })
})

test("mapTask reads task_updated's status out of its patch", () => {
  const event = mapTask({ task_id: "t", patch: { status: "failed", description: "renamed", error: "boom" } }, "updated")
  assert.equal(event.status, "failed")
  assert.equal(event.description, "renamed")
  assert.equal(event.error, "boom")
})

test("mapTask DEGRADES every hostile field instead of throwing", () => {
  // A control character in a summary is the same shape as the control character in a Bash command that
  // destroyed a multi-hour thread — and a sub-agent's summary is agent-authored prose, so it is at
  // least as reachable. Nothing here may throw: `kind` and `phase` survive, bad fields drop out.
  const esc = String.fromCharCode(27)
  const event = mapTask({
    session_id: { not: "a string" },
    uuid: 42,
    description: "x".repeat(200_000), // far past the field cap
    summary: `${esc}[31mred${esc}[0m`, // the 2026-07-27 shape, in agent-authored prose
    last_tool_name: { nope: true }, // wrong type entirely
    usage: "not an object",
    patch: 7,
  }, "progress")
  assert.equal(event.kind, "task")
  assert.equal(event.phase, "progress")
  assert.equal(event.usage, undefined)
  assert.equal(event.lastToolName, undefined)
  assert.equal(event.sessionId, undefined)
  assert.ok((event.description?.length ?? 0) < 200_000, "an oversized description is truncated, not fatal")
  assert.ok(event.summary && !event.summary.includes(esc), "the control byte is sanitized out of the summary")
})

test("mapTask never throws, whatever the frame is", () => {
  // Exhaustive over the shapes a defensive mapper is expected to shrug at. The bar is not "correct
  // output" — it is "the session is still alive".
  for (const raw of [{}, { task_id: null }, { tasks: "no" }, { usage: [] }, { patch: null }, { task_id: [] }]) {
    for (const phase of ["started", "updated", "progress", "notification", "level"] as const) {
      assert.doesNotThrow(() => mapTask(raw as Record<string, unknown>, phase))
    }
  }
})

test("mapTask bounds the background_tasks_changed level set", () => {
  const tasks = Array.from({ length: 8 }, (_, i) => ({ task_id: `k${i}`, task_type: "agent", description: `child ${i}` }))
  const event = mapTask({ tasks }, "level")
  assert.equal(event.tasks?.length, 8)
  assert.equal(event.tasks?.[3]?.taskId, "k3")
  // Past the cap the whole list degrades to absent rather than growing without bound.
  const huge = mapTask({ tasks: Array.from({ length: 400 }, (_, i) => ({ task_id: `k${i}` })) }, "level")
  assert.equal(huge.tasks, undefined)
})
