import type { TranscriptMessage, TranscriptToolCall } from "@fray-ui/shared"
import type { ChatMessage } from "../hooks.ts"

export interface ToolActivityMessage {
  message: ChatMessage
  /** Index in the unmodified transcript array. */
  messageIndex: number
}

const SUB_AGENT_TOOL_NAMES = new Set([
  "agent",
  "agents",
  "follow up",
  "interrupt",
  "send message",
  "spawn agent",
  "wait for agents",
])

function readableToolName(name: string): string {
  const segment = name.split("__").pop() || name
  return segment.replaceAll("_", " ").trim()
}

function normalizedToolName(name: string): string {
  return readableToolName(name).toLowerCase()
}

/** Calls that keep their dedicated card instead of entering the minimal activity disclosure. */
export function isToolActivityException(tool: Pick<
  TranscriptToolCall,
  "name" | "backgroundState" | "prompt" | "agentId" | "sendTo" | "sendBody"
>): boolean {
  return tool.backgroundState === "unknown"
    || tool.prompt !== undefined
    || tool.agentId !== undefined
    || tool.sendTo !== undefined
    || tool.sendBody !== undefined
    || SUB_AGENT_TOOL_NAMES.has(normalizedToolName(tool.name))
}

function pureToolMessage(message: ChatMessage): TranscriptToolCall[] | null {
  if (message.role !== "assistant" || message.kind || message.queued) return null
  if (message.parts && message.parts.length > 0) {
    const tools: TranscriptToolCall[] = []
    for (const part of message.parts) {
      if (part.kind === "text") {
        if (part.text.trim()) return null
      } else {
        tools.push(...part.tools)
      }
    }
    return tools.length > 0 && tools.every((tool) => !isToolActivityException(tool)) ? tools : null
  }
  if (message.text.trim() || message.tools.length === 0) return null
  return message.tools.every((tool) => !isToolActivityException(tool)) ? message.tools : null
}

// A provider can emit an assistant shell that contains no renderable content between two calls
// (Codex result/bracket records do this frequently). It is not a transcript boundary merely because
// it received a source id.
function transparentAssistantMessage(message: ChatMessage): boolean {
  if (message.role !== "assistant" || message.kind || message.queued) return false
  if (message.text.trim() || message.tools.length > 0) return false
  return !message.parts?.some((part) =>
    part.kind === "text" ? part.text.trim().length > 0 : part.tools.length > 0,
  )
}

// A prose-bearing message may END with tools: the prose closes the previous activity run and its tool
// tail starts the next one. Subsequent pure-tool provider messages belong to that tail until another
// visible block arrives. Dedicated tool cards are themselves visible blocks and therefore do not
// qualify as a mergeable tail.
function messageToolTail(message: ChatMessage): TranscriptToolCall[] | null {
  if (message.role !== "assistant" || message.kind || message.queued) return null
  if (!message.parts?.length) return pureToolMessage(message)
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]
    if (part.kind === "text") {
      if (part.text.trim()) return null
      continue
    }
    if (part.tools.length === 0) continue
    return part.tools.every((tool) => !isToolActivityException(tool)) ? part.tools : null
  }
  return null
}

function appendToolTail(message: ChatMessage, tools: TranscriptToolCall[], at?: string): ChatMessage {
  const combinedTools = [...message.tools, ...tools]
  const parts = message.parts?.map((part) =>
    part.kind === "text" ? part : { ...part, tools: [...part.tools] },
  ) ?? []
  let tailIndex = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.kind === "text") {
      if (part.text.trim()) break
      continue
    }
    if (part.tools.length > 0) {
      tailIndex = i
      break
    }
  }
  const tailPart = parts[tailIndex]
  if (tailPart?.kind === "tools") {
    parts[tailIndex] = { kind: "tools", tools: [...tailPart.tools, ...tools] }
  } else {
    parts.push({ kind: "tools", tools })
  }
  return {
    ...message,
    at: at ?? message.at,
    tools: combinedTools,
    parts,
  }
}

/**
 * Coalesce a visible activity run into one presentation message.
 *
 * Providers split a long tool run into several assistant messages and sometimes insert empty assistant
 * records between calls. Neither is visible, so neither can mint another loader/digest. A prose-bearing
 * message's final tools part starts a fresh run after that prose. A dedicated block tool (sub-agent,
 * send, etc.) ends it. The first source id remains stable as the run grows, while `at` advances to the
 * latest batch so a pending card's clock still starts from the call it represents.
 */
export function coalesceToolActivityMessages(messages: readonly ChatMessage[]): ToolActivityMessage[] {
  const out: ToolActivityMessage[] = []
  let activityTail: ToolActivityMessage | null = null

  messages.forEach((message, messageIndex) => {
    if (transparentAssistantMessage(message)) return
    const tools = pureToolMessage(message)
    if (tools && activityTail) {
      activityTail.message = appendToolTail(activityTail.message, tools, message.at)
      return
    }
    const entry = { message, messageIndex }
    out.push(entry)
    activityTail = messageToolTail(message) ? entry : null
  })

  return out
}

/** Whether the latest landed assistant block is already rendering the live activity shimmer. */
export function hasPendingToolActivityTail(messages: readonly ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    // Optimistic queued user bubbles are pinned separately and have not interrupted the active turn.
    if (message.queued) continue
    const tools = messageToolTail(message)
    return tools ? currentToolActivity(tools).pending : false
  }
  return false
}

function target(tool: Pick<TranscriptToolCall, "detail">): string | undefined {
  const detail = tool.detail?.trim()
  return detail || undefined
}

const IMPERATIVE_GERUNDS: Record<string, string> = {
  build: "Building",
  capture: "Capturing",
  check: "Checking",
  collect: "Collecting",
  compare: "Comparing",
  create: "Creating",
  inspect: "Inspecting",
  list: "Listing",
  open: "Opening",
  print: "Printing",
  read: "Reading",
  render: "Rendering",
  run: "Running",
  search: "Searching",
  start: "Starting",
  stop: "Stopping",
  test: "Testing",
  typecheck: "Typechecking",
  verify: "Verifying",
  wait: "Waiting",
  watch: "Watching",
}

function gerundDescription(description: string | undefined, fallback: string): string {
  const clean = description?.trim()
  if (!clean) return fallback
  const firstSpace = clean.indexOf(" ")
  const first = (firstSpace === -1 ? clean : clean.slice(0, firstSpace)).replace(/[.:]$/, "")
  if (/ing$/i.test(first)) return first.charAt(0).toUpperCase() + first.slice(1) + (firstSpace === -1 ? "" : clean.slice(firstSpace))
  const gerund = IMPERATIVE_GERUNDS[first.toLowerCase()]
  if (!gerund) return `${fallback} ${clean}`
  return gerund + (firstSpace === -1 ? "" : clean.slice(firstSpace))
}

/** A concise, sentence-case gerund for the latest visible activity. */
export function toolActivityLabel(tool: Pick<TranscriptToolCall, "name" | "detail" | "desc">): string {
  const name = normalizedToolName(tool.name)
  const detail = target(tool)
  const suffix = detail ? ` ${detail}` : ""

  if (name === "bash" || name === "exec" || name === "run command") {
    return gerundDescription(tool.desc, detail ? `Running ${detail}` : "Running a command")
  }
  if (name === "read" || name === "view image") return `Reading${suffix || " a file"}`
  if (name === "grep" || name === "search" || name === "search query" || name === "find") {
    return detail ? `Searching for ${detail}` : "Searching"
  }
  if (name === "glob" || name === "find files") return detail ? `Finding ${detail}` : "Finding files"
  if (name === "edit" || name === "write" || name === "apply patch") return detail ? `Editing ${detail}` : "Editing files"
  if (name === "todos" || name === "update plan") return "Updating the plan"
  if (name === "screenshot" || name === "snapshot") return detail ? `Capturing ${detail}` : "Capturing the page"
  if (name === "navigate") return detail ? `Navigating to ${detail}` : "Navigating"
  if (name === "evaluate") return "Evaluating the page"
  if (name === "pages") return "Listing pages"
  if (name === "new page") return "Opening a new page"
  if (name === "close page") return "Closing the page"
  if (name === "select page") return "Selecting a page"
  if (name === "console" || name === "console message") return "Reading the console"
  if (name === "network" || name === "network request") return "Inspecting network traffic"
  if (name === "press key") return detail ? `Pressing ${detail}` : "Pressing a key"
  if (name === "fill form") return "Filling the form"
  if (name === "dialog") return "Handling a dialog"
  if (name === "upload") return detail ? `Uploading ${detail}` : "Uploading a file"
  if (name === "wait for" || name === "wait") return detail ? `Waiting for ${detail}` : "Waiting"
  if (name === "resize") return "Resizing the page"
  if (name === "ask") return "Preparing a question"
  if (name === "web" || name === "web search") return detail ? `Searching for ${detail}` : "Searching the web"
  return `Using ${readableToolName(tool.name) || "a tool"}`
}

/** Prefer the newest pending call; otherwise summarize the final call in the settled batch. */
export function currentToolActivity<T extends Pick<TranscriptToolCall, "status">>(tools: readonly T[]): {
  tool: T | undefined
  pending: boolean
} {
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].status === "pending") return { tool: tools[i], pending: true }
  }
  return { tool: tools[tools.length - 1], pending: false }
}

export function settledToolActivityLabel(total: number): string {
  return `Ran ${total} tool ${total === 1 ? "call" : "calls"}`
}

export type ToolActivityTool = TranscriptMessage["tools"][number]
