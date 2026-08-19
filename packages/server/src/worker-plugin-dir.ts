import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// The frizz-worker plugin (single-thread worker contract + hooks + the worker-facing bin/ scripts), a
// sibling of board/ in the Frizz source tree. Deployed artifacts carry it at runtime/cc-worker, but
// pnpm may load this module through a nested store rather than the flat node_modules layout. Search
// module ancestors so the closure remains discoverable in either layout; an explicitly verified
// artifact path wins.
//
// This lives in its own leaf module (node builtins only) rather than in dispatch.ts, where it was born
// and from which it is still re-exported: backend/types.ts needs it to resolve `bin/browser-mcp.mjs`
// for BOTH backends, and dispatch.ts imports backend/types.ts, so keeping it there would be a cycle.
// The ancestor walk is unaffected by the move — this file sits in the same directory dispatch.ts does,
// so the default `import.meta.url` starts from the same place.
export function resolveWorkerPluginDir(
  moduleUrl = import.meta.url,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const override = env.FRIZZ_WORKER_PLUGIN_DIR
  if (override && existsSync(join(override, ".claude-plugin", "plugin.json")))
    return override
  let current = dirname(fileURLToPath(moduleUrl))
  for (;;) {
    const candidate = join(current, "cc-worker")
    if (existsSync(join(candidate, ".claude-plugin", "plugin.json"))) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}
