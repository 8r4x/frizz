import { useEffect, useRef } from "react"
import { Copy, TerminalSquare } from "lucide-react"
import { showToast } from "../store.ts"
import { useBackgroundShellOutput } from "../hooks.ts"
import { elapsedSince } from "../lib/durationLabels.ts"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

export function BackgroundShellSheet({
  id,
  slug,
  shellId,
  label,
  startedAt,
  depth,
  widthDepth,
}: {
  id: number
  slug: string
  shellId: string
  label: string
  startedAt?: string
  depth: number
  widthDepth: number
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const query = useBackgroundShellOutput(slug, shellId)
  const state = query.data?.state
  const command = query.data?.command
  const output = query.data?.output ?? ""

  // Follow live output only while the reader remains close to the bottom; inspecting earlier lines
  // must not be interrupted by the next 1.5s poll.
  useEffect(() => {
    const element = scrollerRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    if (distance < 160) element.scrollTop = element.scrollHeight
  }, [output])

  const age = elapsedSince(startedAt)
  const stateLabel = state === "running" ? `running${age ? ` ${age}` : ""}` : state === "done" ? "finished" : state === "gone" ? "unavailable" : ""
  const unavailable = query.isError || state === "gone"

  async function copyCommand() {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      showToast("Command copied")
    } catch {
      showToast("Could not copy command")
    }
  }

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          <SheetHeader
            title={label}
            icon={<TerminalSquare aria-hidden size={14} className="shrink-0 text-muted/60" />}
            meta={stateLabel ? <span className="shrink-0 whitespace-nowrap text-[11.5px] text-muted/60">{stateLabel}</span> : undefined}
            onClose={close}
          />

          <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            {unavailable ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">Background shell output is no longer available.</div>
            ) : (
              // The drawer body is NEVER gated behind a full-height spinner: a slow first fetch (HTTP pool
              // contention on a busy instance) then reads as "stuck rendering forever" behind a context-free
              // spinner, when the truth is simply "no output has arrived yet". Render the structure up front and
              // state the real situation in the output pane — the <pre> itself lays out a full 512 KB in <35ms,
              // so nothing here is slow to render; the wait is always for the data, and we say so.
              <div className="flex flex-col gap-5">
                <section>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h2 className="petite-caps text-[10px] text-muted/65">Command</h2>
                    {command && (
                      <button type="button" onClick={copyCommand} className="flex items-center gap-1 rounded px-1.5 py-1 text-[10.5px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60">
                        <Copy aria-hidden size={11} /> Copy
                      </button>
                    )}
                  </div>
                  <pre data-background-shell-command className="font-mono-keep overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg/75 px-3 py-2.5 text-[12px] leading-relaxed text-fg/85">{command || (query.isLoading ? "Loading…" : "Command unavailable for this background operation.")}</pre>
                </section>
                <section>
                  <div className="mb-2 flex items-center gap-2">
                    <h2 className="petite-caps text-[10px] text-muted/65">Output</h2>
                    {state === "running" && <span aria-hidden className="fray-live-dot fray-live-dot--shell" data-running-indicator="shell-drawer" />}
                    {query.data?.truncated && <span className="text-[10.5px] text-muted/50">Showing latest 512 KB</span>}
                  </div>
                  {output ? (
                    <pre data-background-shell-output className="font-mono-keep min-h-40 whitespace-pre-wrap break-words rounded-md border border-border bg-[#090b10] px-3 py-3 text-[12px] leading-relaxed text-fg/85">{output}</pre>
                  ) : (
                    <div data-background-shell-output className="flex min-h-40 items-center justify-center rounded-md border border-border bg-[#090b10] px-4 text-center text-[12px] text-muted/60">
                      {state === "done" ? "No output was captured." : "No output yet."}
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        </>
      )}
    </Sheet>
  )
}
