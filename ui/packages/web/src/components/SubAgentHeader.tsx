import { X } from "lucide-react"

export function SubAgentHeader({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <header className="shrink-0 flex items-center gap-2.5 px-3 h-12 border-b border-border bg-panel">
      <div className="min-w-0 pl-1 flex-1">
        <span className="block truncate font-semibold text-[14px]" title={label}>{label}</span>
      </div>
      <button
        aria-label="Close"
        onClick={onClose}
        className="rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
      >
        <X size={15} />
      </button>
    </header>
  )
}
