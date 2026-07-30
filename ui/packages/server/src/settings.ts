import { Settings } from "@fray-ui/shared"
import type { Storage } from "./storage.ts"

const SETTINGS_KEY = "settings"


export const defaultSettings = (): Settings => ({
  // `auto` = the CLI's classifier mode: safe actions auto-approve, risky ones still prompt in
  // the embedded terminal. Fewer invisible permission stalls than acceptEdits/default.
  permissionMode: "auto",
  model: undefined,
  effort: undefined,
  notifications: true,
  font: "sans",
  localFileOpener: "system",
  // Runtime release gate ON by default (opt-out) — the browser-QA + screenshot-in-handoff loop is
  // fray's differentiator. A project that doesn't want it flips this off in Settings.
  runtimeGate: true,
  // Auto-resume limit-paused threads ON by default (opt-out): a fleet cut off mid-work by an
  // exhausted subscription window should pick itself back up when the window rolls, not sit idle
  // until the operator happens to notice hours later.
  autoResumeOnLimit: true,
})

// Settings persist as one JSON blob under settings['settings']. Read merges over defaults
// (so a schema addition lands with a sane value on an old DB); a parse/validation miss also
// degrades to defaults rather than throwing.
export function getSettings(storage: Storage): Settings {
  const raw = storage.getSetting(SETTINGS_KEY)
  if (raw === undefined) return defaultSettings()
  const parsed = Settings.safeParse({ ...defaultSettings(), ...(raw as object) })
  return parsed.success ? parsed.data : defaultSettings()
}

export function setSettings(storage: Storage, next: Settings): Settings {
  const validated = Settings.parse(next)
  storage.setSetting(SETTINGS_KEY, validated)
  return validated
}

// Clear the stored blob so getSettings falls back to defaults (incl. the shipped default preamble).
export function resetSettings(storage: Storage): Settings {
  storage.deleteSetting(SETTINGS_KEY)
  return defaultSettings()
}
