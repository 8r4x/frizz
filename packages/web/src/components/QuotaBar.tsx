import { useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import type { Backend, ProviderAuth, ProviderQuota, QuotaWindow } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { ProviderMark } from "./ProviderMark.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"
import { SignInModal } from "./SignInModal.tsx"
import { PROVIDER_LABEL } from "../lib/signIn.ts"

// THE QUOTA CHIPS — the tail of the top-left StatusBar, one compact chip per backend (Claude, Codex)
// showing REMAINING subscription quota as a battery-style meter. Click a chip for the full per-window
// breakdown. The chip is ALSO the provider auth surface: a signed-out provider shows the em dash and
// its popover leads with a Sign in button instead of a quota breakdown a signed-out account can't have.
//
// These used to float above the sidebar's dispatch box. Quota is ACCOUNT-global — it was never a
// property of the composer it was parked on — so it now sits with the rest of the global status.
// The chips carry no wrapper padding or justification of their own: StatusBar owns the layout, and a
// chip that brought its own box would break the single-line rhythm.
//
// The live connection state is NOT repeated here: it lives in the same bar's IdentityMark (the one
// canonical connection indicator), a few pixels to the left.
//
// Quota is polled (rpc.quota) rather than pushed on the board: it is ACCOUNT-global, not per-thread.
// The server keeps the reading warm on its own 1-minute heartbeat (refreshClaudeQuotaInBackground), so
// this poll just reads that warm cache — a cheap local RPC, no provider round-trip — and a 30s cadence
// keeps the chip tracking the cache within half a minute instead of drifting minutes stale during a
// fast burn. An UNAVAILABLE read re-polls at 15s (a blip should self-heal in seconds), and opening a
// chip's popover forces a fresh read of both quota and auth — the popover is the recheck.

// Every quota/auth request carries an abort deadline. Without one, a single response the server never
// finishes (a dev-server restart severing an in-flight request) leaves the fetch pending FOREVER:
// react-query stays "fetching" and never retries, the recheck latch never clears, and the chip freezes
// into an em dash with a dead click target — the exact reported failure. The deadline turns that into
// an ordinary error the next poll recovers from, while `data` keeps the last good reading.
const POLL_TIMEOUT_MS = 30_000
// A forced recheck legitimately runs Claude Code's `/usage` CLI behind a cross-process lock (~27s
// worst case), so it gets a longer leash.
const RECHECK_TIMEOUT_MS = 45_000

function deadline(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

export function QuotaChips() {
  const queryClient = useQueryClient()
  const recheckInFlight = useRef<Promise<void> | null>(null)
  const [rechecking, setRechecking] = useState(false)
  // Keep the last value through refetches so the bar never flickers to empty. The query never
  // rejects meaningfully (the server degrades each provider to "unavailable").
  const quota = useQuery({
    queryKey: ["quota"],
    queryFn: ({ signal }) => rpc.quota(undefined, { signal: deadline(POLL_TIMEOUT_MS, signal) }),
    refetchInterval: (query) => {
      const d = query.state.data
      const degraded = !d || d.claude.status !== "ok" || d.codex.status !== "ok"
      return degraded ? 15_000 : 30_000
    },
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  })
  // The credential surface. Same cache key as the dispatch gate, so a sign-in from either place
  // updates both. Polled slowly; the popover-open refetch is the responsive path.
  const auth = useQuery({
    queryKey: ["authStatus"],
    queryFn: ({ signal }) => rpc.authStatus(undefined, { signal: deadline(POLL_TIMEOUT_MS, signal) }),
    refetchInterval: 120_000,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })

  const recheck = (backend: Backend) => {
    if (recheckInFlight.current) return
    setRechecking(true)
    const request = Promise.all([
      rpc.quota({ force: backend === "claude" }, { signal: deadline(RECHECK_TIMEOUT_MS) })
        .then((snapshot) => queryClient.setQueryData(["quota"], snapshot)),
      queryClient.refetchQueries({ queryKey: ["authStatus"] }),
    ]).then(() => {}).catch(() => {})
      .finally(() => {
        recheckInFlight.current = null
        setRechecking(false)
      })
    recheckInFlight.current = request
  }

  return (
    <div data-quota-bar className="flex shrink-0 items-center gap-2.5 text-[11px]">
      <QuotaChip backend="claude" quota={quota.data?.claude} auth={auth.data?.claude} email={auth.data?.emails?.claude} loading={quota.isLoading} fetching={quota.isFetching || rechecking} onRecheck={() => recheck("claude")} />
      <QuotaChip backend="codex" quota={quota.data?.codex} auth={auth.data?.codex} email={auth.data?.emails?.codex} loading={quota.isLoading} fetching={quota.isFetching || rechecking} onRecheck={() => recheck("codex")} />
    </div>
  )
}

// One provider's chip: the provider mark + the 5-HOUR window's remaining quota, as a percentage. Clicking
// opens a Popover with the full per-window breakdown (both windows + reset times + plan), the account the
// credential belongs to — and forces a fresh quota+auth read, so the chip doubles as the recheck control.
// Signed out → the em dash, and the popover offers Sign in. Unavailable → a muted dash whose Popover
// explains why; loading (first fetch) → a quiet non-interactive placeholder.
function QuotaChip({
  backend,
  quota,
  auth,
  email,
  loading,
  fetching,
  onRecheck,
}: {
  backend: Backend
  quota: ProviderQuota | undefined
  auth: ProviderAuth | undefined
  email: string | undefined
  loading: boolean
  fetching: boolean
  onRecheck: () => void
}) {
  const providerLabel = PROVIDER_LABEL[backend]
  const [signIn, setSignIn] = useState(false)

  // First fetch, nothing cached yet — a quiet placeholder, no popover (there is nothing to show).
  if (!quota && loading) {
    return (
      <span className="flex items-center gap-1 text-muted/45">
        <ProviderMark backend={backend} className="translate-y-0!" />
        <span className="tabular-nums">··</span>
      </span>
    )
  }

  // A positive signed-out outranks any quota reading: a signed-out account HAS no usable quota, and
  // "Usage endpoint unreachable" would be a misdiagnosis. Fails open — unknown/loading render quota.
  const signedOut = auth === "signed-out"
  const unavailable = !quota || quota.status !== "ok" || quota.windows.length === 0
  const detail = quota?.detail ?? "quota unavailable"

  // The headline is ALWAYS the 5-hour window — "how much can I do right now" is the number that matters
  // day-to-day, and it is the only reading the chip ever shows. The weekly / Opus wall is one click away
  // in the popover. Falls back to the tightest window only when there is no 5h window at all.
  const headline = unavailable ? undefined : pickHeadline(quota!.windows)
  const remaining = headline ? clampPct(100 - headline.usedPercent) : 0
  const dash = signedOut || unavailable

  return (
    <>
      <Popover
        onOpenChange={(open) => {
          // Opening the chip IS the recheck. This is a true server-side cache bypass, not a replay of
          // the last cached failure with a decorative spinner.
          if (open) onRecheck()
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={
              signedOut
                ? `${providerLabel}: signed out`
                : unavailable
                  ? `${providerLabel} quota: ${detail}`
                  : `${providerLabel} quota: ${remaining}% remaining`
            }
            className="flex items-center gap-1.5 min-w-0 rounded outline-none transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-border-strong"
          >
            {dash ? (
              <span className="flex items-center gap-1 text-muted/45">
                <ProviderMark backend={backend} className="translate-y-0!" />
                <span className="tabular-nums">—</span>
              </span>
            ) : (
              <>
                <ProviderMark backend={backend} className="translate-y-0!" />
                <span className={`tabular-nums ${toneText(remaining)}`}>{remaining}%</span>
              </>
            )}
          </button>
        </PopoverTrigger>
        {/* Drops DOWN from the bar. The chips sit at the very top of the viewport now, so the old
            side="top" would have had nowhere to go but a collision flip on every single open. */}
        <PopoverContent side="bottom" align="start" className="w-[min(15rem,calc(100vw-1.5rem))] p-3 text-[11px] leading-relaxed text-fg">
          {/* The IDENTITY block: who this provider is, which plan, and which account — one unit, held
              together by its own tight internal leading and separated from the numbers below by mb-2.
              Measured cap-band gaps: 10.9px inside the block vs 18.9px to the first window row, so the
              email reads as part of the header rather than as a homeless row between two blocks. At the
              original mt-0.5/mb-1.5 those gaps were 12.9 and 16.9 — too close to call either way. */}
          <div className="mb-2">
            <div className="flex items-center gap-1.5 font-medium">
              <ProviderMark backend={backend} />
              <span>{providerLabel}</span>
              {!signedOut && quota?.planType && <span className="text-muted/70">· {cap(quota.planType)} plan</span>}
              {fetching && <Loader2 size={11} className="animate-spin text-muted/60" aria-label="Rechecking" />}
            </div>
            {/* WHICH account this is. Sits above the quota/unavailable/sign-in branch because it is an
                AUTH fact, not a quota one — a provider whose usage endpoint is down still knows who you
                are, and that is exactly when "am I on the right account?" gets asked. Tone matches the
                plan label beside it (both are identity metadata, so the block reads as one). Selectable
                and title-carrying, so a long address stays copyable past the 15rem truncation. */}
            {email && (
              <div data-quota-account className="truncate text-muted/70 select-text" title={email}>
                {email}
              </div>
            )}
          </div>
          {signedOut ? (
            <div className="flex flex-col gap-2.5">
              <div className="text-muted/80">Signed out of {providerLabel}.</div>
              <button
                type="button"
                onClick={() => setSignIn(true)}
                className="self-start rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white outline-none transition-opacity hover:opacity-90"
              >
                Sign in
              </button>
            </div>
          ) : unavailable ? (
            <div className="text-muted/80">{detail}</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {quota!.windows.map((w) => {
                const left = clampPct(100 - w.usedPercent)
                const reset = resetText(w)
                return (
                  <li key={w.key} className="flex items-center justify-between gap-3">
                    <span className="text-muted/80">{w.label}</span>
                    <span className="flex items-center gap-2 tabular-nums">
                      <span className={toneText(left)}>{left}% left</span>
                      {reset && <span className="text-muted/55">resets {reset}</span>}
                    </span>
                  </li>
                )
              })}
              {quota!.detail && <li className="pt-1 text-muted/55">{quota!.detail}</li>}
            </ul>
          )}
        </PopoverContent>
      </Popover>
      {signIn && (
        <SignInModal
          backend={backend}
          onClose={() => setSignIn(false)}
          onAuthed={() => {
            setSignIn(false)
            // Fresh credential must bypass the cached signed-out verdict immediately.
            onRecheck()
          }}
        />
      )}
    </>
  )
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

// The remaining % at/below which a window is no longer "a good amount of quota" — it enters the warn
// zone, where the tone drops the calm neutral for the amber alarm.
const HEALTHY_MIN = 25

// Which window's number leads the chip: ALWAYS the 5-hour one — the immediate runway, the number that
// matters day-to-day. The chip is a FIXED-MEANING readout, not a "whichever limit is tightest" indicator:
// it used to swap to the weekly / Opus wall once anything dropped into the warn zone, which made the same
// glyph mean different things at different times — you had to open the popover just to learn which window
// the number described. The other windows are still in that popover, one click away. The tightest-window
// fallback survives only for a provider that reports no 5h window at all.
function pickHeadline(windows: QuotaWindow[]): QuotaWindow {
  return windows.find((w) => w.key === "5h") ?? windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
}

// Severity by REMAINING: healthy (neutral light gray — no alarm), low (amber), critical (red). Color is
// spent only on states that want attention; a healthy quota is just information, so it reads as a calm
// neutral light gray rather than any hue (green, in any shade, fought the muted dark palette).
function toneText(remaining: number): string {
  if (remaining <= 8) return "text-red-400"
  if (remaining <= HEALTHY_MIN) return "text-accent"
  return "text-fg/70"
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

// A short reset label from a unix-seconds instant: "3:40pm" if within a day, else a weekday ("Thu").
// A reset in the PAST (stale data past its rollover) is suppressed rather than shown as a misleading
// already-elapsed clock time.
function resetText(w: QuotaWindow): string | null {
  if (!w.resetsAt) return null
  const ms = w.resetsAt * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const delta = ms - Date.now()
  if (delta <= 0) return null
  const withinDay = delta < 24 * 3600_000
  if (withinDay) {
    let h = d.getHours()
    const m = d.getMinutes()
    const ap = h >= 12 ? "pm" : "am"
    h = h % 12 || 12
    return m === 0 ? `${h}${ap}` : `${h}:${String(m).padStart(2, "0")}${ap}`
  }
  return d.toLocaleDateString(undefined, { weekday: "short" })
}
