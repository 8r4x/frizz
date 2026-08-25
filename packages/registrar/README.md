# Registrar

The Worker that hands out `<name>.frizz.sh`. It creates a Cloudflare Tunnel and a DNS record for a
claimed name, and returns a per-tunnel run token to the machine that asked.

It runs during signup and never again. **It is not on the data plane** — a board that is already
running keeps working whether or not this Worker is up, and nothing in Frizz has to reach it to stay
reachable. Protect that property above anything else here.

## How a name is owned

There are no accounts. A name belongs to whoever holds an Ed25519 private key, kept at
`~/.frizz/identity.key` on the claiming machine. Every claim is signed; the signature covers the
public key, so a request cannot be re-attributed by swapping it. Ownership moves between machines the
way an SSH key does: copy the file.

A name is a **30-day lease**. The CLI renews it on every launch, which is also how it collects that
run's token. An unrenewed name is released — on demand when someone else asks for it, and by a daily
sweep for names nobody wants.

## Deploying

Needs a Cloudflare API token with **Cloudflare Tunnel: Edit**, **Zone DNS: Edit** on the zone, and
**Workers Scripts: Edit**.

```sh
cd packages/registrar

# 1. the registry: one small JSON row per claimed name
wrangler kv namespace create CLAIMS      # paste the id into wrangler.toml

# 2. the credentials — never in the committed config
wrangler secret put CF_API_TOKEN
wrangler secret put CF_ACCOUNT_ID
wrangler secret put CF_ZONE_ID

# 3. ship it
wrangler deploy
```

Then point the CLI at it. The default is `https://registrar.frizz.sh`; override with `FRIZZ_REGISTRAR`
to test against a deployment before it takes that name.

```sh
FRIZZ_REGISTRAR=https://frizz-registrar.<subdomain>.workers.dev frizz --cloud
```

## The limits that shape this

One claimed name costs one DNS record and one tunnel, and both are capped:

| Resource | Limit |
| --- | --- |
| DNS records per zone, free plan | 200 for a zone created after 2024-09-01 |
| DNS records per zone, Pro | 3,500 |
| Tunnels per account | 1,000 |

So the runway is 200 names free, then 1,000 on Pro, then an Enterprise conversation. Everything in
`claim-handler.ts` that looks like fussy cleanup exists because of those numbers: a leaked tunnel per
failed claim, or a name that is never released, is a countdown to new signups stopping for a reason
nothing points at.

## Verifying

The decision logic takes its side effects by injection, so it runs against fakes:

```sh
nub --test packages/registrar/src/          # the handler, the Worker, the Cloudflare client
nub scripts/verify-claim-e2e.mjs            # CLI client → real socket → real handler
```

**`cloudflare.ts` has never been run against the live API.** Its request shapes come from
documentation rather than from a response anyone has seen, and its tests cover only its logic — a fake
answers whatever the test asks it to, so an assertion about a URL asserts a belief back to itself. The
first real deploy is what retires that, and the likeliest surprises are the token endpoint returning a
bare string and whether the DNS upsert wants `PUT` or `PATCH`.
