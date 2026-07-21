import { useMutation } from "@tanstack/react-query"
import { Check, TerminalSquare } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { rpc } from "../api/rpc.ts"
import { createCopyCommandFeedback } from "../lib/copyCommandFeedback.ts"
import { showToast } from "../store.ts"
import { Tooltip } from "./Tooltip.tsx"

// The resume command needs a server round-trip to resolve, but a plain `writeText` AFTER awaiting that
// RPC loses the click's transient user activation — the write then silently fails (always in Safari;
// in Chrome once activation expires or the window blurs). So write via the async ClipboardItem form:
// `clipboard.write` is invoked SYNCHRONOUSLY within the gesture and fed a promise, and the browser
// keeps activation alive while it resolves. A rejecting item-promise rejects `write` with the SAME
// error (verified), so the "no resumable session yet" reason still reaches the toast. Older engines
// without async-ClipboardItem support fall back to fetch-then-writeText.
async function copyResumeCommand(slug: string): Promise<void> {
  const commandPromise = rpc.threadTerminalCommand({ slug }).then((result) => {
    if (!result.command) throw new Error(result.reason ?? "No verified provider session is available to resume")
    return result.command
  })
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/plain": commandPromise.then((command) => new Blob([command], { type: "text/plain" })) }),
    ])
    return
  }
  const command = await commandPromise
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable; copy the command from a secure Fray page")
  await navigator.clipboard.writeText(command)
}

interface CopyCallbacks {
  onSuccess?: () => void
  onError?: () => void
}

export function useCopyTerminalCommand(slug: string): (callbacks?: CopyCallbacks) => void {
  const copy = useMutation({
    mutationFn: () => copyResumeCommand(slug),
  })
  return (callbacks) => copy.mutate(undefined, {
    onSuccess: () => {
      callbacks?.onSuccess?.()
      showToast("Provider resume command copied")
    },
    onError: (error) => {
      callbacks?.onError?.()
      showToast(error instanceof Error ? `Could not copy provider resume command: ${error.message}` : "Could not copy provider resume command", { duration: 7000 })
    },
  })
}

// Always clickable for a Fray-owned session — resuming the same session in another terminal is safe
// (both CLIs allow multiple attached views), so there is no live-ownership gate. The click always
// attempts a copy; if the server genuinely has no resumable id (e.g. codex before its first turn),
// the mutation surfaces the reason as a toast rather than pre-disabling the affordance.
export function CopyTerminalCommandButton({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false)
  const feedback = useRef<ReturnType<typeof createCopyCommandFeedback> | null>(null)
  if (!feedback.current) {
    feedback.current = createCopyCommandFeedback(setCopied, {
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    })
  }
  const copy = useCopyTerminalCommand(slug)

  useEffect(() => () => feedback.current?.dispose(), [])

  // Acknowledge only once the clipboard write has actually resolved — an optimistic check flashed on
  // click before the async copy landed, so the user pasted into the race and got nothing. The check
  // now means the command is genuinely on the clipboard.
  function handleCopy() {
    copy({ onSuccess: () => feedback.current?.begin() })
  }

  const label = copied ? "Provider resume command copied" : "Copy provider resume command"
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={handleCopy}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
      >
        {copied
          ? <Check size={14} strokeWidth={2.2} className="text-fg" />
          : <TerminalSquare size={14} strokeWidth={1.8} />}
      </button>
    </Tooltip>
  )
}
