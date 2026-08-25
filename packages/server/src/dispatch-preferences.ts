import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DispatchPreferences,
  type Backend,
  type CodexModel,
  type PermissionMode,
  type SetDispatchPreferenceInput,
  type Settings,
} from "@frizz/shared"
import { frizzPaths } from "./frizz-paths.ts"
import { writeMachineFile } from "./settings.ts"
import type { Storage } from "./storage.ts"

// The prompt box's model + effort profile is a property of the OPERATOR, not of a repository: the
// person who picks Opus/xhigh in one project expects the next project's prompt box to open on the same
// profile (maintainer 2026-08-25: "it should also be applied globally across all projects"). One
// server serves every project, so the record lives in one machine-level file beside settings.json,
// exactly the way `font` does (see settings.ts for why that file exists and why `home` is required).
//
// The per-project SQLite row under KEY is where the record lived until 2026-08-25. It stays as a READ
// fallback rather than being migrated: a project that chose a profile before the file existed keeps
// showing it, and the next selection — written to the file — is what makes it the machine's. Every
// write still mirrors into the row, so an older server reading this database sees the same choice.
const KEY = "dispatch-preferences.v1"

export function machineDispatchPreferencesPath(home: string): string {
  return join(frizzPaths({ home }).data, "dispatch-preferences.json")
}

/** The machine's record, or undefined when there is none or it does not parse. Never throws. */
export function readMachineDispatchPreferences(home: string): DispatchPreferences | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(machineDispatchPreferencesPath(home), "utf8"))
  } catch {
    return undefined
  }
  const parsed = DispatchPreferences.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

function permissionFor(backend: Backend, mode: PermissionMode): PermissionMode {
  if (backend === "codex") {
    if (mode === "plan" || mode === "bypassPermissions") return mode
    return "default"
  }
  return mode === "plan" ? "auto" : mode
}

// Migrate the existing single Settings profile without writing anything. This preserves the old
// configured choice on first use while ensuring a merely displayed fallback never becomes stored
// intent. Once a composer selection is changed, the dedicated record becomes authoritative.
export function defaultDispatchPreferences(
  settings: Settings,
  codexModels: readonly CodexModel[] = [],
): DispatchPreferences {
  // Older Settings records predate the explicit backend field. Infer those from the same live Codex
  // catalogue the picker uses so a saved GPT choice migrates into the Codex profile instead of being
  // mistaken for an unavailable Claude model.
  const backend: Backend = settings.backend ?? (codexModels.some((model) => model.slug === settings.model) ? "codex" : "claude")
  const selected = {
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    permissionMode: permissionFor(backend, settings.permissionMode),
  }
  return {
    backend,
    claude: backend === "claude" ? selected : { permissionMode: "auto" },
    codex: backend === "codex" ? selected : { permissionMode: "default" },
  }
}

// machine file → this project's stored row → the Settings-derived default. Read-time validation
// never rewrites either store: an invalid record degrades in memory only.
export function getDispatchPreferences(
  storage: Storage,
  settings: Settings,
  home: string,
  codexModels: readonly CodexModel[] = [],
): DispatchPreferences {
  const machine = readMachineDispatchPreferences(home)
  if (machine) return machine
  const parsed = DispatchPreferences.safeParse(storage.getSetting(KEY))
  return parsed.success ? parsed.data : defaultDispatchPreferences(settings, codexModels)
}

export function setDispatchPreference(
  storage: Storage,
  settings: Settings,
  home: string,
  update: SetDispatchPreferenceInput,
  codexModels: readonly CodexModel[] = [],
): DispatchPreferences {
  const current = getDispatchPreferences(storage, settings, home, codexModels)
  let next: DispatchPreferences
  if (update.field === "backend") {
    next = { ...current, backend: update.value }
  } else if (update.field === "profile") {
    next = {
      ...current,
      backend: update.backend,
      [update.backend]: {
        ...current[update.backend],
        model: update.model,
        effort: update.effort,
      },
    }
  } else {
    const profile = current[update.backend]
    next = {
      ...current,
      ...(update.field === "model" ? { backend: update.backend } : {}),
      [update.backend]: { ...profile, [update.field]: update.value },
    }
  }
  const validated = DispatchPreferences.parse(next)
  writeMachineFile(machineDispatchPreferencesPath(home), validated)
  storage.setSetting(KEY, validated)
  return validated
}
