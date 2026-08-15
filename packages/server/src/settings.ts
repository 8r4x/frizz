import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Settings } from "@frizz/shared"
import { frizzPaths } from "./frizz-paths.ts"
import type { Storage } from "./storage.ts"

const SETTINGS_KEY = "settings"

/**
 * The settings that describe the MACHINE rather than a project.
 *
 * `font` was already inconsistent before one server served every project: the server stored it per
 * project while the client mirrors it to localStorage per ORIGIN for the pre-paint FOUC guard
 * (web/lib/font.ts). One origin turns that latent split into a visible one — the previous project's
 * font flashing on load. `notifications` tracks an OS permission and `localFileOpener` names which
 * editor is installed; neither was ever a property of a repository.
 *
 * There is no migration. Resolution falls back through the project blob (see getSettings), so an
 * existing project keeps its values until the user next saves, and that save is what promotes them.
 *
 * `home` is REQUIRED and deliberately not defaulted to homedir(). These were pure storage functions
 * before this file learned about a machine-level file; defaulting it silently turned every existing
 * caller — the test suite included — into one that reads and WRITES the real ~/.frizz. That is not
 * hypothetical: the first run of this change wrote `notifications: false` into the maintainer's own
 * settings, which would have quietly turned their desktop notifications off.
 */
const MACHINE_KEYS = ["font", "notifications", "localFileOpener", "projectRail"] as const
type MachineSettings = Pick<Settings, (typeof MACHINE_KEYS)[number]>

export function machineSettingsPath(home: string): string {
  return join(frizzPaths({ home }).data, "settings.json")
}

function pickMachine(settings: Settings): MachineSettings {
  return Object.fromEntries(MACHINE_KEYS.map((key) => [key, settings[key]])) as MachineSettings
}

/** Whatever of the machine settings is readable. A miss is a fallback, never an error. */
export function readMachineSettings(home: string): Partial<MachineSettings> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(machineSettingsPath(home), "utf8"))
  } catch {
    return {}
  }
  if (!raw || typeof raw !== "object") return {}
  const parsed = Settings.partial().safeParse(raw)
  if (!parsed.success) return {}
  return pickPresent(parsed.data)
}

function pickPresent(partial: Partial<Settings>): Partial<MachineSettings> {
  const out: Partial<MachineSettings> = {}
  for (const key of MACHINE_KEYS) if (partial[key] !== undefined) Object.assign(out, { [key]: partial[key] })
  return out
}

/** open(wx) → fsync → rename, as everywhere else here: a reader never sees a half file. */
export function writeMachineSettings(next: MachineSettings, home: string): void {
  const path = machineSettingsPath(home)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temp, "w", 0o600)
    writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } catch {
    // Machine settings are a preference, not state. Failing to persist a font must not fail the save.
    if (fd !== undefined) try { closeSync(fd) } catch { /* already gone */ }
    try { rmSync(temp, { force: true }) } catch { /* already gone */ }
  }
}


export const defaultSettings = (): Settings => ({
  // `auto` = the CLI's classifier mode: safe actions auto-approve, risky ones still surface an approval
  // card. Fewer invisible permission stalls than acceptEdits/default. The Settings "Claude permissions"
  // control can raise this to `bypassPermissions` (--dangerously-skip-permissions) — the only other
  // value a headless worker can run in, and the only deviation workerDispatchPermission honors.
  permissionMode: "auto",
  model: undefined,
  effort: undefined,
  notifications: true,
  font: "sans",
  localFileOpener: "system",
  // Hidden until asked for — see the schema for why.
  projectRail: false,
})

// Settings persist as one JSON blob under settings['settings']. Read merges over defaults
// (so a schema addition lands with a sane value on an old DB); a parse/validation miss also
// degrades to defaults rather than throwing.
export function getSettings(storage: Storage, home: string): Settings {
  const raw = storage.getSetting(SETTINGS_KEY)
  const project =
    raw === undefined
      ? defaultSettings()
      : (Settings.safeParse({ ...defaultSettings(), ...(raw as object) }).data ?? defaultSettings())
  // machine file → this project's stored blob → shipped default. The middle term is what makes this
  // need no migration: a project that has a font keeps it until the next save promotes it upward.
  return { ...project, ...readMachineSettings(home) }
}

export function setSettings(storage: Storage, next: Settings, home: string): Settings {
  const validated = Settings.parse(next)
  writeMachineSettings(pickMachine(validated), home)
  storage.setSetting(SETTINGS_KEY, validated)
  return validated
}

// Clear the stored blob so getSettings falls back to defaults (incl. the shipped default prompt).
// A reset means DEFAULTS, so the machine file goes too — leaving it would resurrect the old font.
export function resetSettings(storage: Storage, home: string): Settings {
  storage.deleteSetting(SETTINGS_KEY)
  try {
    rmSync(machineSettingsPath(home), { force: true })
  } catch {
    // Nothing to reset, or unreadable — either way defaults are what the caller gets.
  }
  return defaultSettings()
}
