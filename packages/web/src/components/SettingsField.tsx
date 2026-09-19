import { HelpCircle } from "lucide-react"
import type { ReactNode } from "react"
import { Tooltip } from "./Tooltip.tsx"

// A settings label with an instant tooltip on a small HelpCircle — keeps explanatory prose OUT of the
// form body (one control per line reads clean when the "why" lives in the tooltip). Shared by the
// Settings drawer and the in-context settings popovers, so a field looks the same in either.
export function LabelWithHelp({ label, help }: { label: string; help: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
      {label}
      <Tooltip label={help} side="right" clickable>
        <button type="button" aria-label={`About ${label}`} className="inline-flex size-4 items-center justify-center text-muted/60 hover:text-fg transition-colors">
          <HelpCircle size={12} />
        </button>
      </Tooltip>
    </span>
  )
}

export function SettingsField({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <LabelWithHelp label={label} help={help} />
      {children}
    </div>
  )
}
