import { handleClaim, sweepExpiredClaims, type ClaimRecord, type ClaimStore } from "./claim-handler.ts"
import { createCloudflareApi } from "./cloudflare.ts"

/**
 * The registration Worker for `<name>.frizz.sh`.
 *
 * It runs during signup and never again — it is not on the data plane, so a board that is already
 * running keeps working whether or not this is up. Protecting that property is worth more than any
 * other choice here: nothing in Frizz should ever have to reach this to stay reachable.
 */

/**
 * Structural only, so this package needs no `@cloudflare/workers-types`.
 *
 * A real `KVNamespace` satisfies this. Declaring only the methods actually used keeps the registrar
 * typecheckable by the repo's ordinary Node tsconfig, which knows nothing about workerd.
 */
export interface KvNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }>
}

export interface RegistrarEnv {
  /** Zone-scoped Cloudflare token. NEVER leaves this Worker. */
  CF_API_TOKEN: string
  CF_ACCOUNT_ID: string
  CF_ZONE_ID: string
  /** The apex names hang off, e.g. `frizz.sh`. */
  FRIZZ_ZONE: string
  CLAIMS: KvNamespace
}

/** KV holds one small JSON row per name: who owns it, which tunnel serves it, and its lease. */
export function kvClaimStore(kv: KvNamespace): ClaimStore {
  return {
    async read(name) {
      const raw = await kv.get(`claim:${name}`)
      if (!raw) return null
      try {
        return JSON.parse(raw) as ClaimRecord
      } catch {
        // A row we cannot parse is treated as absent rather than fatal. The name then behaves as
        // unclaimed, which is recoverable; throwing would make one bad row a permanent 500 for a
        // hostname nobody can release.
        return null
      }
    },
    async write(name, record) {
      await kv.put(`claim:${name}`, JSON.stringify(record))
    },
    async remove(name) {
      await kv.delete(`claim:${name}`)
    },
    async readOwner(pubkey) {
      return kv.get(`owner:${pubkey}`)
    },
    async writeOwner(pubkey, name) {
      await kv.put(`owner:${pubkey}`, name)
    },
    async removeOwner(pubkey) {
      await kv.delete(`owner:${pubkey}`)
    },
    async list() {
      // KV pages its listing, and a page boundary is invisible from one call. Following the cursor is
      // what stops the sweeper from silently only ever seeing the first 1,000 names.
      const names: string[] = []
      let cursor: string | undefined
      for (;;) {
        const page = await kv.list({ prefix: "claim:", ...(cursor ? { cursor } : {}) })
        for (const key of page.keys) names.push(key.name.slice("claim:".length))
        if (page.list_complete || !page.cursor) return names
        cursor = page.cursor
      }
    },
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })

function claimDeps(env: RegistrarEnv) {
  return {
    api: createCloudflareApi({
      token: env.CF_API_TOKEN,
      accountId: env.CF_ACCOUNT_ID,
      zoneId: env.CF_ZONE_ID,
    }),
    store: kvClaimStore(env.CLAIMS),
    zone: env.FRIZZ_ZONE,
    now: () => Date.now(),
  }
}

export default {
  /**
   * Return lapsed names to the pool.
   *
   * Without this the two capped resources — 200 DNS records in the zone, 1,000 tunnels in the account
   * — fill up with names nobody uses any more, and new signups stop for a reason nothing points at.
   * The claim path releases a lapsed name on demand, but only when somebody asks for that exact name.
   */
  async scheduled(_event: unknown, env: RegistrarEnv): Promise<void> {
    const result = await sweepExpiredClaims(claimDeps(env))
    // Worker logs are the only place a sweep is visible, so say what happened even when it is nothing.
    console.log(
      `swept ${result.released.length} expired name(s)` +
        `${result.failed.length ? `, ${result.failed.length} failed: ${result.failed.join(", ")}` : ""}` +
        `${result.remaining ? `, ${result.remaining} left for the next run` : ""}`
    )
  },

  async fetch(request: Request, env: RegistrarEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== "/claim") return json(404, { error: "not-found" })
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } })
    }

    // A body that is not JSON is the claimant's mistake, not a crash. The handler validates
    // everything past this point, including that the thing parsed is shaped like a claim at all.
    const body = await request.json().catch(() => null)

    const outcome = await handleClaim(body, claimDeps(env))

    return json(outcome.status, outcome.body)
  },
}
