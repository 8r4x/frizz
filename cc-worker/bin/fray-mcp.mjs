#!/usr/bin/env node
// @ts-check
/**
 * fray-mcp — THE fray MCP server: one unified, dependency-free MCP stdio server (mounted as `fray`,
 * so its tools are `mcp__fray__<tool>`) carrying every capability fray hands its own WORKERS. Today
 * that is exactly one tool, `spawn_thread`, which dispatches a brand-new TOP-LEVEL fray board thread
 * (its own session + scratchpad + independent drive — NOT an in-session Agent/Task helper). Future
 * worker-facing fray tools join the TOOLS registry below rather than mounting a second server: one
 * server keeps the worker's tool namespace coherent and the server-level pre-approval single.
 *
 * spawn_thread wraps fray's own dispatch RPC: it reads the running server's port from
 * `<state-dir>/server.lock` and POSTs `/rpc/dispatch`. The `/rpc` surface has no token auth — only a
 * loopback-origin CSRF gate — so a headerless local POST with `sec-fetch-site: same-origin` (undici
 * sends no Origin) satisfies it.
 *
 * Mounted by the server (dispatch.ts) into the Claude backend via `--mcp-config`. The server passes
 * FRAY_STATE_DIR in this process's env so we can locate server.lock without recomputing the project id.
 *
 * Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0. We implement exactly the four methods a
 * client drives (initialize, tools/list, tools/call, ping) plus the initialized notification. Hand-
 * rolled rather than pulling @modelcontextprotocol/sdk: the surface is tiny, it ships as one loose
 * .mjs next to bin/fray (no build/bundle/resolution concerns), and it matches this repo's own
 * hand-rolled-RPC aesthetic. The server NEVER crashes on a bad tool call: failures come back as an
 * isError tool result so the worker sees a message instead of a dead tool.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const PROTOCOL_FALLBACK = "2025-06-18"
// Comfortably above a codex dispatch's bounded rollout-discovery wait (~15s) so a legitimate slow
// dispatch is never aborted client-side (which would make the worker think it failed and retry,
// double-spawning). The server completes regardless; this is only the client's patience.
const DISPATCH_TIMEOUT_MS = 30_000

const SPAWN_THREAD = {
  name: "spawn_thread",
  description:
    "Spawn a brand-new, separate top-level fray thread — its own board card, session, and scratchpad, " +
    "driving INDEPENDENTLY. This is FIRE-AND-FORGET: the new thread reports to the HUMAN on the board via " +
    "its own final message, and its results NEVER come back to you, the caller. It is NOT an in-session " +
    "sub-agent. It returns only the new thread's slug and a ready-to-paste markdown link " +
    "`[title](/thread/<slug>)` that opens the thread in the fray drawer — put that link in your handoff. " +
    "USE IT ONLY for a distinct, self-contained effort that belongs on the board in its own right and whose " +
    "output you do NOT need to read. Do NOT use it for a helper whose result you must COLLECT and fold into " +
    "your own work — a self-review, a verification pass, a research prong, a critic, any collect-back helper: " +
    "those are in-session sub-agents (Claude: the Agent tool with `run_in_background`; Codex: native " +
    "delegation), which return their findings to you. Spawning such a helper here STRANDS it — its work lands " +
    "on another card and never reaches you, so you gain nothing. " +
    "You MUST deliberately choose `model` and `effort` to match the NEW thread's task complexity — they are " +
    "required, there is NO default. Do not reflexively pick the cheapest; a hard task on a weak model/effort " +
    "wastes the whole thread.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The full task/prompt for the new thread's worker. Be self-contained — the new thread starts with empty context.",
      },
      model: {
        type: "string",
        description:
          "REQUIRED — pick by the NEW task's complexity; there is no default. For the `claude` backend: " +
          "`opus` (the TOP tier — hardest reasoning, architecture, subtle correctness/security, adversarial " +
          "review, the fix that must land), `sonnet` (ordinary substantive implementation/research), `haiku` " +
          "(simple, fully-specified mechanical work). Do NOT pick `fable`: Opus 5 is just as good and cheaper, " +
          "so a high-intensity task takes `opus` at a higher `effort`, not a different model — `fable` only " +
          "when the human explicitly asks for it. For " +
          "the `codex` backend use a codex model id instead (e.g. `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna`). " +
          "Match the model to the backend you choose. Bias toward Opus/a strong model when the task is " +
          "non-trivial or its outcome is load-bearing.",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description:
          "REQUIRED — reasoning effort, pick by complexity; no default. `low` only for trivial tasks; " +
          "`medium` for routine work; `high` for ordinary substantive work; `xhigh` for hard coding/agentic " +
          "work; `max` for the single hardest problems. (Codex also accepts `ultra`.)",
      },
      backend: {
        type: "string",
        enum: ["claude", "codex"],
        description: "Optional agent backend (default `claude`). If `codex`, `model` must be a codex model id.",
      },
      title: { type: "string", description: "Optional short title for the new thread (else derived from the prompt)." },
    },
    required: ["prompt", "model", "effort"],
  },
}

const STOP_HOOK = {
  name: "stop_hook",
  description:
    "Arm a STOP HOOK on YOUR OWN thread: fray re-sends you `prompt` every time you come to rest, until " +
    "you end it. Use it to keep a long autonomous effort moving without the human driving every step, " +
    "and to rescue yourself from a wait that may never resolve.\n\n" +
    "USE THIS RATHER THAN `CronCreate` or `ScheduleWakeup`. Those are Claude Code's own in-session " +
    "schedulers and they CANNOT fire in the runtime fray runs you in: their gate stays shut for as long " +
    "as ANY background task of yours is outstanding, so the moment you are parked behind a background " +
    "shell or a sub-agent — exactly when you most need waking — they go silent. This one is delivered by " +
    "fray itself and is unaffected.\n\n" +
    "It fires on REST, not on a clock, so there is no interval to choose: you are re-prompted whenever " +
    "you stop, and never mid-turn. The text arrives as an ordinary user turn, VERBATIM, so write it as " +
    "an instruction to your future self.\n\n" +
    "IT KEEPS GOING UNTIL SOMETHING STOPS IT, and there are only two things that do: `action: \"stop\"` " +
    "on this tool, or the human switching it off in the thread footer. There is also an opt-out you " +
    "should be slow to use — replying ALLDONE on its own line tells fray there is no further work and " +
    "stops these prompts entirely. Be sure before you do: it permanently stalls the run, and a run " +
    "nobody is watching does not restart itself.\n\n" +
    "A thread has AT MOST ONE stop hook: calling this again REPLACES it. The human sees it in the thread " +
    "footer and can edit or switch it off there.\n\n" +
    "You can only ever arm your OWN thread — there is no parameter for anyone else's.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "stop"],
        description: "`start` arms (or replaces) this thread's stop hook; `stop` disarms it.",
      },
      prompt: {
        type: "string",
        description:
          "Required for `start`. The text delivered to you every time you come to rest, verbatim, as a " +
          "user turn. Make it self-contained and ACTIONABLE — say what to do and what would make it " +
          "right to stop — because you may receive it with none of the context you have right now.",
      },
    },
    required: ["action"],
  },
}

const HEARTBEAT = {
  name: "heartbeat",
  description:
    "Arm a HEARTBEAT on YOUR OWN thread: fray sends you `prompt` every `interval_seconds`, on the clock, " +
    "for as long as it is armed.\n\n" +
    "THE DUMB ONE, and that is the point. It consults nothing about what you are doing — not whether you " +
    "are resting, not your sub-agents or background shells. If the interval has elapsed, a beat is " +
    "queued. (It still LANDS when you next come to rest, because fray cannot interrupt a running turn.) " +
    "Use it when something must be revisited on a schedule no matter what you happen to believe at the " +
    "time; use `stop_hook` when the question is \"I stopped, is there more to do?\".\n\n" +
    "USE THIS RATHER THAN `CronCreate` or `ScheduleWakeup`. Those are Claude Code's own in-session " +
    "schedulers and they CANNOT fire in the runtime fray runs you in: their gate stays shut for as long " +
    "as ANY background task of yours is outstanding, so the moment you are parked behind a background " +
    "shell or a sub-agent — exactly when you most need waking — they go silent. This one is delivered by " +
    "fray itself and is unaffected.\n\n" +
    "The beat arrives VERBATIM as an ordinary user turn, so write it as an instruction to your future " +
    "self. A thread has AT MOST ONE heartbeat: calling this again REPLACES it. At most one beat is ever " +
    "outstanding and the clock runs from the last DELIVERED beat, so a long busy stretch yields one " +
    "catch-up beat rather than a backlog.\n\n" +
    "STOP IT when the work it drives is done (`action: \"stop\"`) — a heartbeat left armed on a finished " +
    "thread wakes it forever. The human sees it in the thread footer and can switch it off there. " +
    "Replying ALLDONE on its own line also stops it, along with any stop hook, but be sure before you " +
    "do: it permanently stalls the run. You can only ever arm your OWN thread.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "stop"],
        description: "`start` arms (or replaces) this thread's heartbeat; `stop` disarms it.",
      },
      prompt: {
        type: "string",
        description:
          "Required for `start`. The text delivered to you on every beat, verbatim, as a user turn. Make " +
          "it self-contained and ACTIONABLE — say what to do and what would make it right to stop — " +
          "because you may receive it with none of the context you have right now.",
      },
      interval_seconds: {
        type: "integer",
        description:
          "Required for `start`. Seconds between beats (minimum 60, maximum 86400). A beat only lands " +
          "when you are at rest, so a very short interval does not deliver faster than you actually stop.",
      },
    },
    required: ["action"],
  },
}

// The unified server's tool registry: `tools/list` returns these and `tools/call` routes by name.
// Adding a worker-facing fray tool = one entry here + one handler in `HANDLERS` — never a second
// MCP server, so every fray tool stays under the same `mcp__fray__*` namespace and the same
// server-level pre-approval the dispatch layer already grants.
const TOOLS = [SPAWN_THREAD, STOP_HOOK, HEARTBEAT]

/** @type {Record<string, (args: Record<string, unknown>) => Promise<string>>} */
const HANDLERS = {
  [SPAWN_THREAD.name]: spawnThread,
  [STOP_HOOK.name]: stopHook,
  [HEARTBEAT.name]: heartbeat,
}

/** @param {unknown} obj */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n")
}
/** @param {string|number} id @param {unknown} result */
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result })
}
/** @param {string|number} id @param {number} code @param {string} message */
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}
/** @param {string|number} id @param {string} text @param {boolean} [isError] */
function replyTool(id, text, isError) {
  reply(id, { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) })
}

function serverLockPort() {
  const lock = process.env.FRAY_SERVER_LOCK
    || (process.env.FRAY_STATE_DIR ? join(process.env.FRAY_STATE_DIR, "server.lock") : undefined)
  if (!lock) throw new Error("FRAY_STATE_DIR / FRAY_SERVER_LOCK not set — cannot locate the fray server")
  let parsed
  try {
    parsed = JSON.parse(readFileSync(lock, "utf8"))
  } catch (err) {
    throw new Error(`could not read the fray server lock at ${lock} (is the server running?): ${err instanceof Error ? err.message : err}`)
  }
  const port = parsed?.port
  if (!Number.isInteger(port)) throw new Error(`fray server lock at ${lock} has no valid port`)
  return port
}

/** The `spawn_thread` handler: POST /rpc/dispatch, return the worker-facing result text.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function spawnThread(args) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) throw new Error("`prompt` is required and must be a non-empty string")
  // model + effort are REQUIRED (no default) so the caller must choose by task complexity — a defaulted
  // model (e.g. the project's cheap default) is exactly the bug this guards. Enforced server-side too,
  // not only in the tool schema, so a lenient client can't skip the decision.
  const model = typeof args.model === "string" ? args.model.trim() : ""
  if (!model) throw new Error("`model` is required — choose one by the new task's complexity (claude: opus/sonnet/haiku, opus being the top tier; codex: a gpt-5.6 model id). There is no default.")
  const effort = typeof args.effort === "string" ? args.effort.trim() : ""
  if (!effort) throw new Error("`effort` is required — choose one by complexity (low/medium/high/xhigh/max). There is no default.")

  /** @type {Record<string, unknown>} */
  const body = { prompt, model, effort }
  if (typeof args.title === "string" && args.title.trim()) body.title = args.title.trim()
  if (args.backend === "claude" || args.backend === "codex") body.backend = args.backend

  const port = serverLockPort()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS)
  let res
  try {
    res = await fetch(`http://127.0.0.1:${port}/rpc/dispatch`, {
      method: "POST",
      // No Origin header (undici omits it for non-browser fetch); `sec-fetch-site: same-origin`
      // satisfies the server's loopback-origin gate (app.ts isTrustedLocalHttpRequest).
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    throw new Error(`dispatch request failed: ${err instanceof Error ? err.message : err}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`dispatch returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`)
  }
  const payload = await res.json().catch(() => null)
  const slug = payload?.result?.slug
  if (typeof slug !== "string" || !slug) throw new Error(`dispatch response missing a slug: ${JSON.stringify(payload)?.slice(0, 300)}`)
  const label = typeof body.title === "string" ? body.title : slug
  return (
    `Spawned a new fray thread \`${slug}\`. It is now on the board driving independently — it reports ` +
    `to the human via its own final message, NOT back to you, so do not wait on a result from it.\n\n` +
    `Paste this link to let the human open it in the drawer:\n\n[${label}](/thread/${slug})`
  )
}

/** POST a fray RPC procedure and return its parsed payload. Shares spawn_thread's transport rules:
 * the port comes from server.lock and `sec-fetch-site: same-origin` satisfies the loopback gate.
 * @param {string} procedure @param {Record<string, unknown>} body @returns {Promise<any>} */
async function callRpc(procedure, body) {
  const port = serverLockPort()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS)
  let res
  try {
    res = await fetch(`http://127.0.0.1:${port}/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    throw new Error(`${procedure} request failed: ${err instanceof Error ? err.message : err}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`${procedure} returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`)
  }
  return await res.json().catch(() => null)
}

/** Which thread this MCP server belongs to. Stamped into our env at spawn (dispatch.ts for the tmux
 * path, the broker bridge for the SDK path) because the MCP protocol carries no caller identity.
 * FRAY_UI_THREAD is the fallback: every fray worker process is tagged with it, so it is right
 * whenever the env is inherited — but it is not relied upon, hence the explicit var first.
 *
 * This is also the reason a model can never point `stop_hook` at someone else's thread: the slug is
 * read from HERE, never from the tool arguments. */
function threadSlug() {
  const slug = process.env.FRAY_THREAD_SLUG || process.env.FRAY_UI_THREAD
  if (!slug) {
    throw new Error(
      "this fray MCP server was not told which thread it belongs to (no FRAY_THREAD_SLUG), so it cannot " +
      "arm a stop hook for it. This is a fray bug — report it rather than working around it.",
    )
  }
  return slug
}

/** The `stop_hook` handler: arm or disarm this thread's rest-triggered re-prompt.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function stopHook(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "start" && action !== "stop") throw new Error("`action` must be either \"start\" or \"stop\"")

  if (action === "stop") {
    await callRpc("setOwnThreadStopHook", { slug, prompt: null, enabled: false })
    return "Stop hook disarmed and cleared. You will not be re-prompted when you come to rest, and the text is gone from the thread footer."
  }

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) {
    throw new Error("`prompt` is required to start a stop hook — it is the text you will be sent every time you come to rest")
  }

  await callRpc("setOwnThreadStopHook", { slug, prompt, enabled: true })
  return (
    "Stop hook armed — fray will send you this prompt every time you come to rest, and never mid-turn. " +
    "It replaces any stop hook this thread had before.\n\n" +
    "To END it, call this tool with `action: \"stop\"`. The human can also switch it off in the thread " +
    "footer. Replying ALLDONE stops it too, but only use that when there is genuinely nothing left — it " +
    "permanently stalls the run."
  )
}

const HEARTBEAT_MIN_INTERVAL_SECONDS = 60
const HEARTBEAT_MAX_INTERVAL_SECONDS = 24 * 60 * 60

/** The `heartbeat` handler: arm or disarm this thread's clock-driven wake.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function heartbeat(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "start" && action !== "stop") throw new Error("`action` must be either \"start\" or \"stop\"")

  if (action === "stop") {
    await callRpc("setOwnThreadHeartbeat", { slug, prompt: null, enabled: false })
    return "Heartbeat disarmed and cleared. You will no longer be woken on a schedule."
  }

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) throw new Error("`prompt` is required to start a heartbeat — it is the text you will be sent on every beat")
  const interval = typeof args.interval_seconds === "number" ? Math.round(args.interval_seconds) : NaN
  if (!Number.isFinite(interval)) throw new Error("`interval_seconds` is required to start a heartbeat")
  if (interval < HEARTBEAT_MIN_INTERVAL_SECONDS || interval > HEARTBEAT_MAX_INTERVAL_SECONDS) {
    throw new Error(`\`interval_seconds\` must be between ${HEARTBEAT_MIN_INTERVAL_SECONDS} and ${HEARTBEAT_MAX_INTERVAL_SECONDS}`)
  }

  await callRpc("setOwnThreadHeartbeat", { slug, prompt, intervalSeconds: interval, enabled: true })
  const every = interval % 60 === 0 ? `${interval / 60} min` : `${interval}s`
  return (
    `Heartbeat armed — fray will send you this prompt every ${every}, delivered when you come to rest ` +
    "(a beat that comes due mid-turn waits for your next rest rather than interrupting you). It replaces " +
    "any heartbeat this thread had before. Nothing about what you are doing suppresses a beat — only " +
    "disarming it, the human switching it off, or an ALLDONE reply, which permanently stalls the run.\n\n" +
    "Call this tool again with `action: \"stop\"` once the work it drives is finished. The human can also " +
    "edit or switch it off in the thread footer."
  )
}

/** @param {any} msg */
async function handle(msg) {
  const { id, method, params } = msg ?? {}
  const isNotification = id === undefined || id === null

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion
      reply(id, {
        protocolVersion: typeof requested === "string" ? requested : PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "fray", version: "0.1.0" },
      })
      return
    }
    case "notifications/initialized":
    case "initialized":
      return // notification — no reply
    case "ping":
      if (!isNotification) reply(id, {})
      return
    case "tools/list":
      reply(id, { tools: TOOLS })
      return
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : ""
      const handler = HANDLERS[name]
      if (!handler) {
        replyError(id, -32602, `unknown tool: ${params?.name}`)
        return
      }
      try {
        replyTool(id, await handler(params?.arguments ?? {}))
      } catch (err) {
        replyTool(id, `\`${name}\` failed: ${err instanceof Error ? err.message : String(err)}`, true)
      }
      return
    }
    default:
      if (!isNotification) replyError(id, -32601, `method not found: ${method}`)
      return
  }
}

// NDJSON reader: buffer stdin, dispatch each complete line. Messages never contain raw newlines.
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue // ignore unparseable lines
    }
    void handle(msg)
  }
})
process.stdin.on("end", () => process.exit(0))
