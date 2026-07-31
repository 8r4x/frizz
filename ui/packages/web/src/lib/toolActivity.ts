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
  "name" | "prompt" | "agentId" | "sendTo" | "sendBody"
>): boolean {
  return tool.prompt !== undefined
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

/** The newest ordinary call in the landed assistant tail, regardless of its individual status. */
export function liveToolActivityTail(messages: readonly ChatMessage[]): TranscriptToolCall | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    // Optimistic queued user bubbles are pinned separately and have not interrupted the active turn.
    if (message.queued) continue
    const tools = messageToolTail(message)
    return tools?.[tools.length - 1]
  }
  return undefined
}

function withoutLiveToolTail(message: ChatMessage): ChatMessage {
  const tail = messageToolTail(message)
  if (!tail) return message

  // `message.tools` is the flattened provider view while `parts` preserves exact render order.
  // Remove the whole live run from both. A completed latest call is still live while the turn is
  // running: revealing its digest during the inter-call gap makes the row jump to `Ran N` +
  // `Working…`, only to disappear again when the next call lands.
  const tools = message.tools.length >= tail.length
    ? message.tools.slice(0, message.tools.length - tail.length)
    : message.tools.filter((tool) => !tail.includes(tool))
  let removedTail = false
  const parts = message.parts
    ? message.parts.reduceRight<NonNullable<ChatMessage["parts"]>>((out, part) => {
        if (!removedTail && part.kind === "tools" && part.tools === tail) {
          removedTail = true
          return out
        }
        out.unshift(part)
        return out
      }, [])
    : message.parts
  return { ...message, tools, parts }
}

/**
 * Historical transcript rows exclude the live ordinary-tool tail.
 *
 * Its newest call supplies the bottom runtime gerund instead. Callers use this only while the turn
 * is running, so individual call completion cannot flash a digest between sequential calls. Once a
 * visible block ends the run—or the turn goes idle—the unmodified message renders `Ran N tool calls`.
 */
export function historicalToolActivityMessages(
  entries: readonly ToolActivityMessage[],
): ToolActivityMessage[] {
  let liveTailMessage: ChatMessage | undefined
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i].message
    if (message.queued) continue
    if (messageToolTail(message)) liveTailMessage = message
    break
  }

  if (!liveTailMessage) return [...entries]
  const out: ToolActivityMessage[] = []
  for (const entry of entries) {
    const message = entry.message === liveTailMessage
      ? withoutLiveToolTail(entry.message)
      : entry.message
    if (transparentAssistantMessage(message)) continue
    out.push(message === entry.message ? entry : { ...entry, message })
  }
  return out
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
  // An authored description is always a better activity label than the raw command in `fallback`.
  // Some providers send a noun phrase rather than an imperative (for example, "Final workflow
  // validation"). Keep it intact behind a gerund instead of leaking `Running <long command>`.
  if (!gerund) return `Running ${clean}`
  return gerund + (firstSpace === -1 ? "" : clean.slice(firstSpace))
}

/**
 * Rewrite absolute in-project paths as project-relative ones for display.
 *
 * `detail` carries the provider's raw input, and every Claude/Codex file tool passes an ABSOLUTE path,
 * so the shimmer reads `Editing /Users/me/Documents/projects/fray/ui/packages/web/src/App.tsx` — one
 * short row whose only identifying part is pushed off the end by a home prefix that never varies.
 * Stripping the project root leaves `Editing ui/packages/web/src/App.tsx`.
 *
 * The root is the board's `projectDir`, which is the git toplevel of the dir the server was launched in
 * — so when Fray runs on a linked worktree that IS the worktree root, and no separate detection is
 * needed. A worktree a worker created underneath the project keeps its own directory in the relative
 * path (`wt-fix/ui/…`), which is exactly the disambiguation you want. Paths outside the project are left
 * absolute: there is no root that makes them both shorter and honest.
 *
 * Applied to the finished label rather than to `detail` alone so a Bash description's arguments shorten
 * too, and every occurrence is replaced because a command line can name several paths. The trailing
 * slash is part of the needle, so a sibling checkout (`…/fray-old/a.ts`) never matches.
 *
 * A path outside the project still gets its home prefix collapsed to `~` — `~/.claude/CLAUDE.md` says
 * the same thing in a quarter of the width. The browser can't read $HOME, so it comes from the project
 * root's own leading `/Users/<user>` or `/home/<user>`; any other shape (a repo under `/opt`, `/srv`, a
 * volume) yields no home and those paths stay absolute rather than being cut at a guess.
 */
export function relativeToolPaths(label: string, projectDir: string | undefined): string {
  const root = projectDir?.trim().replace(/\/+$/, "")
  if (!root || root === "/" || !root.startsWith("/")) return label
  const withinProject = label.replaceAll(`${root}/`, "")
  const home = /^(\/(?:Users|home)\/[^/]+)(?:\/|$)/.exec(root)?.[1]
  return home ? withinProject.replaceAll(`${home}/`, "~/") : withinProject
}

/** A concise, sentence-case gerund for the latest visible activity. */
export function toolActivityLabel(
  tool: Pick<TranscriptToolCall, "name" | "detail" | "desc">,
  projectDir?: string,
): string {
  return relativeToolPaths(rawToolActivityLabel(tool), projectDir)
}

function rawToolActivityLabel(tool: Pick<TranscriptToolCall, "name" | "detail" | "desc">): string {
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

/** Tools whose whole job is to write a file — the ones the digest reports as "edited". */
const FILE_WRITING_TOOL_NAMES = new Set(["edit", "multiedit", "write", "apply patch"])

/** The collapsed render shape merges consecutive edits to one file, so `edits` is the plural of `edit`. */
export interface FileWritingTool {
  name: string
  detail?: string
  edit?: { file: string }
  edits?: { file: string }[]
}

/**
 * How many DISTINCT files a settled run wrote.
 *
 * Creation, deletion and modification all collapse to one "edited" reading — the digest is a one-line
 * recap, not a changelog, and splitting it three ways buys nothing (maintainer 2026-07-31: "no need to
 * be pedantic"). The path comes from the structured `edit` payload where there is one; a codex
 * apply_patch the server could not reconstruct (a `Delete File`, a multi-file hunk) still arrives named
 * Edit with the file as its `detail`, which is why the name check is the fallback rather than dead code.
 * A Bash `rm`/`mv` is deliberately not inspected — the digest counts file tools, not shell side effects.
 */
export function editedFileCount(tools: readonly FileWritingTool[]): number {
  const files = new Set<string>()
  for (const tool of tools) {
    for (const edit of tool.edits ?? (tool.edit ? [tool.edit] : [])) {
      if (edit.file.trim()) files.add(edit.file.trim())
    }
    if (tool.edit || tool.edits?.length) continue
    const detail = tool.detail?.trim()
    if (detail && FILE_WRITING_TOOL_NAMES.has(normalizedToolName(tool.name))) files.add(detail)
  }
  return files.size
}

export function settledToolActivityLabel(total: number, editedFiles = 0): string {
  const calls = `Ran ${total} tool ${total === 1 ? "call" : "calls"}`
  if (editedFiles === 0) return calls
  return `${calls}, edited ${editedFiles} file${editedFiles === 1 ? "" : "s"}`
}

export type ToolActivityTool = TranscriptMessage["tools"][number]
