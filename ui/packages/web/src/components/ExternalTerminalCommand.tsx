import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, TerminalSquare } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { rpc } from "../api/rpc.ts"
import { createCopyCommandFeedback } from "../lib/copyCommandFeedback.ts"
import { showToast } from "../store.ts"
import { Tooltip } from "./Tooltip.tsx"

const COPIED_TOAST = "Provider resume command copied"
const COPY_FAILED_TOAST = "Could not copy provider resume command"

// react-query cache key for a thread's resolved resume command. It is prefetched on hover/focus (see
// CopyTerminalCommandButton) so the CLICK can write it SYNCHRONOUSLY — no server round-trip inside the
// clipboard gesture. That single change fixes both reported bugs: the copy stops silently failing inside
// a live queue card (the async write otherwise lost its activation/focus window across the RPC), and the
// "copied" check stops lagging a full round-trip behind the click.
const terminalCommandKey = (slug: string) => ["terminalCommand", slug] as const

// Resolve the provider resume command, surfacing the server's reason when there is none to copy.
function resolveTerminalCommand(slug: string): Promise<string> {
  return rpc.threadTerminalCommand({ slug }).then((result) => {
    if (!result.command) throw new Error(result.reason ?? "No verified provider session is available to resume")
    return result.command
  })
}

// COLD-cache fallback: a click that beat the hover/focus prefetch still needs the command, so it does the
// round-trip inside the gesture. A plain `writeText` AFTER awaiting the RPC loses the click's transient
// user activation — the write then silently fails (always in Safari; in Chrome once activation expires or
// the window blurs). So write via the async ClipboardItem form: `clipboard.write` is invoked SYNCHRONOUSLY
// within the gesture and fed a promise, and the browser keeps activation alive while it resolves. A
// rejecting item-promise rejects `write` with the SAME error, so the "no resumable session yet" reason
// still reaches the toast. Older engines without async-ClipboardItem support fall back to fetch-then-writeText.
async function copyResumeCommandAsync(slug: string): Promise<void> {
  const commandPromise = resolveTerminalCommand(slug)
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
    mutationFn: () => copyResumeCommandAsync(slug),
  })
  return (callbacks) => copy.mutate(undefined, {
    onSuccess: () => {
      callbacks?.onSuccess?.()
      showToast(COPIED_TOAST)
    },
    onError: (error) => {
      callbacks?.onError?.()
      showToast(error instanceof Error ? `${COPY_FAILED_TOAST}: ${error.message}` : COPY_FAILED_TOAST, { duration: 7000 })
    },
  })
}

// Always clickable for a Fray-owned session — resuming the same session in another terminal is safe
// (both CLIs allow multiple attached views), so there is no live-ownership gate. The click always
// attempts a copy; if the server genuinely has no resumable id (e.g. codex before its first turn),
// the copy surfaces the reason as a toast rather than pre-disabling the affordance.
export function CopyTerminalCommandButton({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false)
  const feedback = useRef<ReturnType<typeof createCopyCommandFeedback> | null>(null)
  if (!feedback.current) {
    feedback.current = createCopyCommandFeedback(setCopied, {
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    })
  }
  const queryClient = useQueryClient()
  const copyAsync = useCopyTerminalCommand(slug)

  useEffect(() => () => feedback.current?.dispose(), [])

  // Warm the command into the query cache BEFORE the click, so handleCopy can write it synchronously.
  // Fires on hover and keyboard focus — both reliably precede the click by far more than the (DB-read)
  // RPC takes. staleTime dedupes repeat hovers; a failed resolve caches no data, so the click cleanly
  // falls through to the async path (which re-runs the RPC and surfaces the reason).
  function prefetch() {
    void queryClient.prefetchQuery({
      queryKey: terminalCommandKey(slug),
      queryFn: () => resolveTerminalCommand(slug),
      staleTime: 15_000,
    })
  }

  // WARM cache (the common case, courtesy of the hover/focus prefetch): write the already-resolved command
  // SYNCHRONOUSLY inside the gesture — no RPC in the clipboard's activation window. That is what makes the
  // copy reliable in a live queue card (an async write otherwise lost that window to a focus/activation
  // blip) and what makes the check appear at once instead of a round-trip late. The check still lands only
  // once writeText actually resolves — honest, but effectively instant since the value is already in hand;
  // a genuine failure toasts and leaves no check. COLD cache: the activation-safe async path, unchanged.
  function handleCopy() {
    const command = queryClient.getQueryData<string>(terminalCommandKey(slug))
    if (command && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(command).then(
        () => {
          feedback.current?.begin()
          showToast(COPIED_TOAST)
        },
        () => showToast(COPY_FAILED_TOAST, { duration: 7000 }),
      )
      return
    }
    copyAsync({ onSuccess: () => feedback.current?.begin() })
  }

  const label = copied ? "Provider resume command copied" : "Copy provider resume command"
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={handleCopy}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
      >
        {copied
          ? <Check size={14} strokeWidth={2.2} className="text-fg" />
          : <TerminalSquare size={14} strokeWidth={1.8} />}
      </button>
    </Tooltip>
  )
}
