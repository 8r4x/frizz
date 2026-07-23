import { join } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ProviderQuota, QuotaWindow } from "@fray-ui/shared"

const execFileAsync = promisify(execFile)

// Claude Code's non-interactive `/usage` command owns the unstable parts of reading subscription
// quota: secure-storage variants, OAuth refresh/rotation, endpoint retries, and its seeded fallback
// from recent API headers. Fray consumes that public CLI surface instead of impersonating an old
// Claude Code build with a raw access token.
const OK_TTL_MS = 3 * 60_000
const FAIL_TTL_MS = 10_000
const STALE_MAX_AGE_MS = 24 * 60 * 60_000
// The lock must outlive the 12s CLI timeout, and followers must be willing to wait through that same
// bound. Otherwise a merely slow first process would make every other Fray window give up early.
const LOCK_STALE_MS = 20_000
const LOCK_WAIT_MS = 15_000
const LOCK_POLL_MS = 50

function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override && override.trim() ? override : join(homedir(), ".claude")
}

// Pull the OAuth access token out of a Claude credentials blob. The shape has drifted across
// versions, so probe the known nests defensively; return undefined when absent.
export function tokenFromCredentialsJson(raw: string): string | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!doc || typeof doc !== "object") return undefined
  const root = doc as Record<string, unknown>
  const oauth = root.claudeAiOauth && typeof root.claudeAiOauth === "object" ? (root.claudeAiOauth as Record<string, unknown>) : root
  const token = oauth.accessToken ?? oauth.access_token
  return typeof token === "string" && token ? token : undefined
}

// Map one usage window from the endpoint (utilization 0..100, reset_at ISO) → a QuotaWindow.
function toWindow(raw: unknown, key: string, label: string): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const w = raw as Record<string, unknown>
  const util = typeof w.utilization === "number" && Number.isFinite(w.utilization) ? w.utilization : undefined
  if (util === undefined) return undefined
  const resetIso = typeof w.reset_at === "string" ? w.reset_at : undefined
  const resetMs = resetIso ? Date.parse(resetIso) : NaN
  const resetsAt = Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : undefined
  return { key, label, usedPercent: util, resetsAt }
}

// Parse the endpoint's JSON body → a ProviderQuota. Total: never throws. Exported for a fixture test.
// Surfaces the model-specific weekly caps (seven_day_opus / seven_day_sonnet) too: on a Max plan the
// Opus weekly cap is frequently the BINDING limit, so omitting it would let the chip show a rosy general
// weekly % while the user is actually near their Opus wall. The chip's "tightest window" then reflects it.
export function parseClaudeUsage(body: unknown, planType?: string): ProviderQuota {
  if (!body || typeof body !== "object") return { status: "unavailable", windows: [], detail: "Malformed usage response" }
  const b = body as Record<string, unknown>
  const windows = [
    toWindow(b.five_hour, "5h", "5h"),
    toWindow(b.seven_day, "weekly", "Weekly"),
    toWindow(b.seven_day_opus, "weekly-opus", "Opus wk"),
    toWindow(b.seven_day_sonnet, "weekly-sonnet", "Sonnet wk"),
  ].filter((x): x is QuotaWindow => x !== undefined)
  if (windows.length === 0) return { status: "unavailable", windows: [], detail: "No usage windows reported" }
  return { status: "ok", planType, windows }
}

type UsageExec = (claudeBin: string) => Promise<string>

export interface ClaudeQuotaDeps {
  now?: () => number
  execUsage?: UsageExec
  cacheDir?: string
}

interface SharedQuota {
  at: number
  quota: ProviderQuota
}

function cachePaths(cacheDir: string, configDir: string) {
  const profile = createHash("sha256").update(configDir).digest("hex").slice(0, 12)
  return {
    data: join(cacheDir, `claude-${profile}.json`),
    lock: join(cacheDir, `claude-${profile}.lock`),
  }
}

async function readShared(path: string): Promise<SharedQuota | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SharedQuota
    if (!Number.isFinite(parsed.at) || !parsed.quota || !Array.isArray(parsed.quota.windows)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

async function writeShared(path: string, value: SharedQuota): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await mkdir(path)
      return () => rm(path, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      try {
        if (Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MS) {
          await rm(path, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() >= deadline) throw new Error("Claude quota refresh lock timed out")
      await delay(LOCK_POLL_MS)
    }
  }
}

async function runClaudeUsage(claudeBin: string): Promise<string> {
  const { stdout } = await execFileAsync(
    claudeBin,
    ["-p", "/usage", "--safe-mode", "--output-format", "json", "--no-session-persistence", "--tools", ""],
    { encoding: "utf8", timeout: 12_000, maxBuffer: 2 * 1024 * 1024 },
  )
  return String(stdout)
}

const LINE_WINDOWS: Array<[RegExp, string, string]> = [
  [/^Current session$/i, "5h", "5h"],
  [/^Current week \(all models\)$/i, "weekly", "Weekly"],
  [/^Current week \(Opus only\)$/i, "weekly-opus", "Opus wk"],
  [/^Current week \(Sonnet only\)$/i, "weekly-sonnet", "Sonnet wk"],
]

function windowIdentity(title: string): [string, string] | undefined {
  for (const [pattern, key, label] of LINE_WINDOWS) {
    if (pattern.test(title)) return [key, label]
  }
  const scoped = /^Current week \((.+)\)$/i.exec(title)
  if (!scoped) return undefined
  const name = scoped[1]!.replace(/\s+only$/i, "")
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return slug ? [`weekly-${slug}`, `${name} wk`] : undefined
}

function parseResetLabel(label: string | undefined, now: number): number | undefined {
  if (!label) return undefined
  // Claude Code and Fray run on the same machine, so its explicit IANA suffix names the local timezone
  // already in effect here. Remove only that redundant suffix; never reinterpret it as UTC.
  const text = label.replace(/\s+\([^)]+\)\s*$/, "").trim()
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text)
  if (clock) {
    let hour = Number(clock[1]) % 12
    if (clock[3]!.toLowerCase() === "pm") hour += 12
    const date = new Date(now)
    date.setHours(hour, Number(clock[2] ?? 0), 0, 0)
    if (date.getTime() <= now) date.setDate(date.getDate() + 1)
    return Math.round(date.getTime() / 1000)
  }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) return undefined
  const date = new Date(parsed)
  // Date-only labels omit the year. A weekly reset crossing New Year must resolve forward, not to the
  // same month/day in the past.
  if (!/\b\d{4}\b/.test(text) && date.getTime() <= now) date.setFullYear(date.getFullYear() + 1)
  return Math.round(date.getTime() / 1000)
}

// Claude Code intentionally formats this output as a small line-oriented contract for non-interactive
// callers. Preserve its percentages and turn its local reset labels back into the unix instants Fray's
// display and subscription-limit scheduler already consume.
export function parseClaudeUsageOutput(stdout: string, now = Date.now()): ProviderQuota {
  let text = stdout
  try {
    const envelope = JSON.parse(stdout) as Record<string, unknown>
    if (typeof envelope.result === "string") text = envelope.result
  } catch {
    // Plain-text output is accepted too, which keeps this parser compatible with simple test doubles.
  }
  const windows: QuotaWindow[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(Current (?:session|week \(.+?\))):\s*(\d+(?:\.\d+)?)%\s+used\b(?:\s*·\s*resets\s+(.+?))?\s*$/i.exec(line)
    if (!match) continue
    const identity = windowIdentity(match[1]!)
    if (!identity) continue
    const resetsAt = parseResetLabel(match[3], now)
    windows.push({
      key: identity[0],
      label: identity[1],
      usedPercent: Number(match[2]),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    })
  }
  if (windows.length === 0) {
    return { status: "unavailable", windows: [], detail: "Claude Code did not report subscription quota" }
  }
  return { status: "ok", windows }
}

// The healthy cache is shared under ~/.fray so three project windows make one Claude Code request,
// not three simultaneous requests to the same account. A failed refresh serves the last known-good
// reading (clearly labeled in the popover) for at most one day instead of erasing useful data.
export async function readClaudeQuota(
  claudeBin = "claude",
  deps: ClaudeQuotaDeps = {},
  options: { force?: boolean } = {},
): Promise<ProviderQuota> {
  const now = (deps.now ?? Date.now)()
  const configDir = claudeConfigDir()
  const cacheDir = deps.cacheDir ?? join(homedir(), ".fray", "quota-cache")
  const paths = cachePaths(cacheDir, configDir)
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  } catch {
    try {
      return parseClaudeUsageOutput(await (deps.execUsage ?? runClaudeUsage)(claudeBin), now)
    } catch {
      return { status: "unavailable", windows: [], detail: "Claude Code usage unavailable" }
    }
  }
  const initial = await readShared(paths.data)
  if (!options.force && initial && now - initial.at < (initial.quota.status === "ok" ? OK_TTL_MS : FAIL_TTL_MS)) {
    return initial.quota
  }

  let release: (() => Promise<void>) | undefined
  try {
    release = await acquireLock(paths.lock)
    const afterLock = await readShared(paths.data)
    // Another Fray process may have completed the requested refresh while this process waited.
    if (afterLock && afterLock.at !== initial?.at && now - afterLock.at < OK_TTL_MS) return afterLock.quota

    const output = await (deps.execUsage ?? runClaudeUsage)(claudeBin)
    const quota = parseClaudeUsageOutput(output, now)
    if (quota.status !== "ok") throw new Error(quota.detail)
    await writeShared(paths.data, { at: now, quota }).catch(() => {})
    return quota
  } catch {
    const fallback = await readShared(paths.data)
    if (fallback?.quota.status === "ok" && now - fallback.at < STALE_MAX_AGE_MS) {
      return {
        ...fallback.quota,
        detail: `Could not refresh · last updated ${Math.max(1, Math.round((now - fallback.at) / 60_000))}m ago`,
      }
    }
    const unavailable = { status: "unavailable", windows: [], detail: "Claude Code usage unavailable" } satisfies ProviderQuota
    await writeShared(paths.data, { at: now, quota: unavailable }).catch(() => {})
    return unavailable
  } finally {
    await release?.().catch(() => {})
  }
}
