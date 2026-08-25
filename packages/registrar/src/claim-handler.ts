import {
  CLAIM_LEASE_MS,
  claimLeaseExpired,
  tunnelNameForClaim,
  verifyClaim,
  type ClaimRejection,
} from "@frizz/shared"

/**
 * The registrar's decision logic, with every side effect injected.
 *
 * This is where a name becomes a hostname. It holds no Cloudflare credentials and opens no sockets of
 * its own — the zone token lives in the Worker that wraps this, and never anywhere else, which is the
 * property the whole security argument rests on. Keeping the decisions here also means they can be
 * tested against fakes rather than against someone's real DNS zone.
 */

/** What we remember about a claimed name. The pubkey is the owner; the timestamps are the lease. */
export interface ClaimRecord {
  pubkey: string
  tunnelId: string
  port: number
  claimedAt: number
  renewedAt: number
}

export interface ClaimStore {
  read(name: string): Promise<ClaimRecord | null>
  write(name: string, record: ClaimRecord): Promise<void>
  remove(name: string): Promise<void>
}

export interface CloudflareApi {
  createTunnel(name: string): Promise<{ id: string; token: string }>
  /** Re-read an existing tunnel's run token, so a renewal need not destroy and recreate the tunnel. */
  tunnelToken(id: string): Promise<string>
  setTunnelIngress(id: string, hostname: string, service: string): Promise<void>
  upsertDnsRecord(hostname: string, target: string): Promise<void>
  deleteTunnel(id: string): Promise<void>
  deleteDnsRecord(hostname: string): Promise<void>
}

export interface ClaimDeps {
  api: CloudflareApi
  store: ClaimStore
  /** The zone names hang off, e.g. `frizz.sh`. */
  zone: string
  now: () => number
}

export type ClaimFailure = ClaimRejection | "name-taken" | "malformed" | "provisioning-failed"

export type ClaimOutcome =
  | { status: 200; body: { hostname: string; token: string; leaseExpiresAt: number; renewed: boolean } }
  | { status: 400 | 409 | 502; body: { error: ClaimFailure; message: string } }

const MESSAGES: Record<ClaimFailure, string> = {
  "bad-version": "this Frizz is too old to claim a name — upgrade and try again",
  "bad-name": "that name is not usable as a hostname",
  "bad-port": "the port must be between 1 and 65535",
  "bad-pubkey": "the identity key was unreadable",
  "bad-signature": "the claim was not signed by the key it names",
  expired: "the claim is too old — check this machine's clock and try again",
  "from-the-future": "the claim is dated ahead of the server — check this machine's clock",
  "name-taken": "that name belongs to someone else",
  malformed: "the request body was not a claim",
  "provisioning-failed": "the name could not be provisioned; nothing was left behind",
}

const reject = (error: ClaimFailure, status: 400 | 409 | 502 = 400): ClaimOutcome => ({
  status,
  body: { error, message: MESSAGES[error] },
})

/**
 * Claim or renew a name.
 *
 * Renewal is the SAME call as a claim, deliberately. The CLI runs it on every launch, so making it a
 * separate endpoint would mean two code paths that have to agree about ownership — and the one that
 * runs a hundred times more often would be the less tested of the two.
 */
export async function handleClaim(body: unknown, deps: ClaimDeps): Promise<ClaimOutcome> {
  const now = deps.now()
  const verdict = await verifyClaim(body, now)
  if (!verdict.ok) return reject(verdict.reason)

  const { name, port, pubkey } = verdict.payload
  const hostname = `${name}.${deps.zone}`
  const existing = await deps.store.read(name)

  if (existing && existing.pubkey !== pubkey) {
    // A lapsed lease returns the name to the pool. Checking it HERE rather than in a sweeper is what
    // makes the pool self-healing: a name frees up the moment someone else wants it, so the registry
    // never depends on a cron job having run.
    if (!claimLeaseExpired(existing.renewedAt, now)) return reject("name-taken", 409)
    await releaseQuietly(deps, name, hostname, existing.tunnelId)
  } else if (existing) {
    return renew(existing, { name, hostname, port, pubkey }, deps, now)
  }

  return create({ name, hostname, port, pubkey }, deps, now)
}

interface ClaimTarget {
  name: string
  hostname: string
  port: number
  pubkey: string
}

async function renew(
  existing: ClaimRecord,
  target: ClaimTarget,
  deps: ClaimDeps,
  now: number
): Promise<ClaimOutcome> {
  try {
    // The board may have moved port since the last launch, so ingress is re-asserted every time
    // rather than only when it looks changed — one idempotent call is cheaper than a stale tunnel
    // pointing at a port nothing serves.
    if (existing.port !== target.port) {
      await deps.api.setTunnelIngress(existing.tunnelId, target.hostname, `http://localhost:${target.port}`)
    }
    const token = await deps.api.tunnelToken(existing.tunnelId)
    await deps.store.write(target.name, { ...existing, port: target.port, renewedAt: now })
    return {
      status: 200,
      body: { hostname: target.hostname, token, leaseExpiresAt: now + CLAIM_LEASE_MS, renewed: true },
    }
  } catch {
    return reject("provisioning-failed", 502)
  }
}

async function create(target: ClaimTarget, deps: ClaimDeps, now: number): Promise<ClaimOutcome> {
  const tunnelName = tunnelNameForClaim(target.name)
  let tunnel: { id: string; token: string }
  try {
    tunnel = await deps.api.createTunnel(tunnelName)
  } catch {
    return reject("provisioning-failed", 502)
  }

  try {
    await deps.api.setTunnelIngress(tunnel.id, target.hostname, `http://localhost:${target.port}`)
    await deps.api.upsertDnsRecord(target.hostname, `${tunnel.id}.cfargotunnel.com`)
    await deps.store.write(target.name, {
      pubkey: target.pubkey,
      tunnelId: tunnel.id,
      port: target.port,
      claimedAt: now,
      renewedAt: now,
    })
  } catch {
    // UNWIND, or the account leaks a tunnel on every failed claim. Tunnels are capped at 1,000 per
    // account, so a leak here is not untidiness — it is a countdown to the product stopping.
    await releaseQuietly(deps, target.name, target.hostname, tunnel.id)
    return reject("provisioning-failed", 502)
  }

  return {
    status: 200,
    body: {
      hostname: target.hostname,
      token: tunnel.token,
      leaseExpiresAt: now + CLAIM_LEASE_MS,
      renewed: false,
    },
  }
}

/**
 * Tear a name down, ignoring failures.
 *
 * Every caller is already handling a failure or reclaiming a lapsed name, and neither has anything
 * better to do if cleanup also fails. Each step is attempted independently so one dead resource does
 * not strand the other two.
 */
async function releaseQuietly(deps: ClaimDeps, name: string, hostname: string, tunnelId: string): Promise<void> {
  await Promise.allSettled([
    deps.api.deleteDnsRecord(hostname),
    deps.api.deleteTunnel(tunnelId),
    deps.store.remove(name),
  ])
}
