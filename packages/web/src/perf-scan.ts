// DEV-ONLY render instrumentation, opt-in via `?scan=1`. react-scan patches React's reconciler hook,
// so this module must be imported BEFORE react-dom — main.tsx keeps it as its first import.
//
// It answers one question we otherwise can only guess at: when opening a thread drawer, WHICH
// components render, how many times, and how much of that was avoidable? Results land on
// `window.__frayScan` for a CDP routine to read back.
import { scan } from "react-scan"

interface ScanRecord {
  count: number
  selfTimeMs: number
  unnecessary: number
}

declare global {
  interface Window {
    __frayScan?: {
      records: Map<string, ScanRecord>
      reset(): void
      dump(limit?: number): { name: string; count: number; selfTimeMs: number; unnecessary: number }[]
      totals(): { components: number; renders: number; selfTimeMs: number; unnecessary: number }
    }
  }
}

export function installRenderScan(): void {
  if (!import.meta.env.DEV) return
  if (typeof window === "undefined") return
  if (!new URLSearchParams(window.location.search).has("scan")) return

  const records = new Map<string, ScanRecord>()
  window.__frayScan = {
    records,
    reset: () => records.clear(),
    dump: (limit = 40) =>
      [...records.entries()]
        .map(([name, r]) => ({ name, count: r.count, selfTimeMs: Math.round(r.selfTimeMs), unnecessary: r.unnecessary }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit),
    totals: () => {
      let renders = 0, selfTimeMs = 0, unnecessary = 0
      for (const r of records.values()) { renders += r.count; selfTimeMs += r.selfTimeMs; unnecessary += r.unnecessary }
      return { components: records.size, renders, selfTimeMs: Math.round(selfTimeMs), unnecessary }
    },
  }

  scan({
    enabled: true,
    log: false,
    showToolbar: false,
    onRender(fiber, renders) {
      const name = (fiber.type as { displayName?: string; name?: string } | null)?.displayName
        ?? (fiber.type as { name?: string } | null)?.name
        ?? "<anonymous>"
      let record = records.get(name)
      if (!record) { record = { count: 0, selfTimeMs: 0, unnecessary: 0 }; records.set(name, record) }
      for (const render of renders) {
        record.count += render.count ?? 1
        record.selfTimeMs += render.time ?? 0
        if (render.unnecessary) record.unnecessary += render.count ?? 1
      }
    },
  })
}
