import { useState } from "react"
import { Settings2 } from "lucide-react"
import { useEscapeToClose } from "../hooks/useEscapeToClose.ts"
import { SaveStatus, useSettingsDraft } from "../hooks/useSettingsAutosave.tsx"
import { GithubPromptEditor } from "./GithubPromptField.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"

// The gear in the GitHub picker's header, and the panel it opens: the triage prompt every thread this
// picker dispatches will run — editable right where it is about to be used, rather than a drawer away
// under Settings › Project (which still carries the same editor, for finding it cold).
//
// MODAL for the same reason the model picker's agent-settings panel is (see AgentSettingsPopover): a
// panel with a textarea in it must not be dismissable by anything short of a pointer-down outside,
// Escape, or its own controls. Closing it flushes a debounced edit at once, and the picker's dispatch
// button waits on that write (useIsMutating on SETTINGS_WRITE_KEY), so a prompt edited and dispatched
// in the same breath is the prompt the workers get.
export function GithubPromptPopover() {
  const [open, setOpen] = useState(false)
  useEscapeToClose(open, () => setOpen(false))
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Triage prompt settings"
          title="Edit the prompt every thread this picker starts will run"
          onMouseDown={(e) => e.preventDefault()}
          className="github-prompt-trigger inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted/70 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:bg-panel-2 focus-visible:text-fg data-[state=open]:bg-panel-2 data-[state=open]:text-fg"
        >
          <Settings2 aria-hidden="true" size={15} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={6} className="w-[560px] max-w-[calc(100vw-1rem)] p-4" data-github-prompt-menu="">
        <GithubPromptForm />
      </PopoverContent>
    </Popover>
  )
}

function GithubPromptForm() {
  const { draft, update, saveState } = useSettingsDraft()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] font-medium text-fg">Picker settings</span>
        <SaveStatus state={saveState} />
      </div>
      {!draft ? <div className="text-[12px] text-muted">Loading…</div> : <GithubPromptEditor draft={draft} onChange={update} rows={14} />}
    </div>
  )
}
