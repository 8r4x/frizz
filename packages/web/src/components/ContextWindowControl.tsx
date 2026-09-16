import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronDown } from "lucide-react"
import { useRef } from "react"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { CODEX_CONTEXT_WINDOW_DEFAULT, codexContextWindowOptions, formatTokens } from "../lib/codexContextWindow.ts"
import { AUTO_COMPACT_WINDOW_OPTIONS, CONTEXT_WINDOW_HELP, DEFAULT_AUTO_COMPACT_WINDOW } from "../lib/contextWindows.ts"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"

export function ContextWindowControl({ backend, open, onOpenChange }: {
  backend: "claude" | "codex"
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const client = useQueryClient()
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  const models = useQuery({ queryKey: ["codexModels"], queryFn: () => rpc.codexModels(), enabled: backend === "codex" })
  const busy = useIsMutating({ mutationKey: ["contextWindowSet"] }) > 0
  const optionsRef = useRef<HTMLDivElement>(null)
  const mutation = useMutation({
    mutationKey: ["contextWindowSet"],
    mutationFn: (tokens: number | null) => rpc.contextWindowSet({ backend, tokens }),
    // Hold the originating cache entry: a project switch during the request must not publish this
    // project's settings into the next project's cache (query hashes are project-scoped).
    onMutate: () => ({ query: client.getQueryCache().find({ queryKey: ["settingsGet"] }) }),
    onSuccess: (saved, _tokens, context) => { context?.query?.setData(saved) },
    onError: (error) => showToast(`Could not save context window: ${(error as Error).message.slice(0, 80)}`),
  })
  const stored = backend === "claude" ? settings.data?.autoCompactWindow ?? DEFAULT_AUTO_COMPACT_WINDOW : settings.data?.codexContextWindow
  const value = stored === undefined ? CODEX_CONTEXT_WINDOW_DEFAULT : String(stored)
  const options = backend === "codex" ? codexContextWindowOptions(models.data, stored) : [
    ...AUTO_COMPACT_WINDOW_OPTIONS,
    ...(!AUTO_COMPACT_WINDOW_OPTIONS.some((o) => o.value === value) ? [{ value, label: formatTokens(stored!) }] : []),
  ]
  const label = backend === "claude" ? "Compaction window" : "Context window"
  const provider = backend === "claude" ? "Claude Code" : "Codex"
  const selected = options.find((o) => o.value === value)!

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <RadixMenu.Item asChild disabled={!settings.data || busy} onSelect={(event) => event.preventDefault()}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${provider} ${label.toLowerCase()}`}
            title={CONTEXT_WINDOW_HELP[backend]}
            disabled={!settings.data || busy}
            className="context-window-trigger inline-flex shrink-0 items-baseline gap-1.5 rounded-[5px] border border-border/80 bg-transparent px-1.5 py-0.5 text-[11px] leading-4 text-muted outline-none hover:border-muted hover:bg-panel-2 hover:text-fg data-[state=open]:border-muted data-[state=open]:bg-panel-2 data-[state=open]:text-fg disabled:opacity-45"
            style={{ fontVariantCaps: "normal", letterSpacing: "normal" }}
          >
            <span className="context-window-value">{settings.data ? selected.label.split(" (")[0] : "…"}</span>
            {/* Measured in sans/mono: 6.2px/5.3px of painted gap, <0.3px vertical residual. Trim the
                chevron's quarter-em side bearings; cap-height alignment follows the selected font. */}
            <ChevronDown aria-hidden="true" className="-mx-[0.25em] size-[1em] shrink-0 translate-y-[calc(0.5em_-_0.5cap)]" />
          </button>
        </PopoverTrigger>
      </RadixMenu.Item>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={5}
        className="w-[204px] max-w-[calc(100vw-1rem)] p-1 text-[12px] leading-[18px]"
        style={{ fontVariantCaps: "normal", letterSpacing: "normal" }}
        data-context-window-menu={backend}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          optionsRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
        }}
        onKeyDown={(event) => {
          event.stopPropagation() // Do not feed the parent model menu's typeahead / roving focus.
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
          event.preventDefault()
          const buttons = [...optionsRef.current!.querySelectorAll<HTMLButtonElement>("button")]
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
          buttons[next]?.focus()
        }}
      >
        <p className="px-2 py-1.5 text-[11px] text-muted">{label}</p>
        <div ref={optionsRef} role="menu" aria-label={`${provider} ${label.toLowerCase()} options`}>
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              role="menuitemradio"
              aria-checked={option.value === value}
              disabled={busy}
              onClick={() => {
                onOpenChange(false)
                if (option.value !== value) mutation.mutate(option.value === CODEX_CONTEXT_WINDOW_DEFAULT ? null : Number(option.value))
              }}
              className="flex w-full items-center justify-between rounded-[5px] px-2 py-1.5 text-left text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:bg-panel-2 aria-checked:bg-panel-2 aria-checked:text-fg"
            >
              <span>{option.label}</span>
              {option.value === value && <Check aria-hidden="true" size={13} className="text-accent" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
