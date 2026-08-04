# Hosted Frizz: `<name>.frizz.sh` as a paid service

Status: THINKING. No code written for this. Owner effort: frizz worker thread (remote-access).
Prerequisite already shipped: `--public-origin` (`ab88796`, `a730613`) — the self-host tier works today.

## Why

Frizz runs on your machine and binds loopback. Reaching it from anywhere means a tunnel, and today
that means the user brings their own Cloudflare or Tailscale account and their own domain. The product
idea is to sell the part that is annoying: identity, a stable name, and auth in front of a board that
otherwise has none. `npx frizz --cloud` and you are at `colin.frizz.sh` from your phone.

What you are selling is **reachability and identity, not compute**. The agents still run on the user's
machine with the user's credentials. That is the whole reason the margin can be good — and it is also
what makes the security bar unusually high, because every customer is handing your namespace a
direct line to a shell on their laptop.

## Verified premises (ground truth, measured 2026-08-03/04)

These are the facts the design rests on. Each was checked, not recalled.

| Premise | Evidence |
| --- | --- |
| Cloudflare API tokens scope to a **zone**, never to a record | [Cloudflare permissions docs](https://developers.cloudflare.com/fundamentals/api/reference/permissions/); record-level is an open feature request |
| ⇒ a zone-writing token can never ship in the client | any user could then take/delete any subdomain, or repoint the apex |
| A **per-tunnel run token** is narrow — runs that tunnel, nothing else | this is what makes the vending-machine design safe |
| A **remotely-managed** tunnel (`config_src: "cloudflare"`) needs no `cert.pem` | created + configured via API, run via `cloudflared tunnel run --token` |
| Universal SSL covers `*.frizz.sh` **one level only** | deeper (`a.b.frizz.sh`) needs Advanced Certificate Manager, paid, wildcard-per-level, 50 SANs/cert |
| ⇒ the namespace must be flat: `colin.frizz.sh` | fine now that Frizz is one server per machine |
| GitHub device flow needs only a **public `client_id`**, no secret | [octokit/auth-oauth-device](https://github.com/octokit/auth-oauth-device.js/) — the CLI can do the whole login itself |
| Cloudflare Access free tier is **50 seats, then $7/user/mo** | [Access pricing](https://www.cloudflare.com/sase/products/access/) |
| Cloudflare **prohibits reselling Zero Trust to third parties** without written permission | [Zero Trust service-specific terms](https://www.cloudflare.com/service-specific-terms-zero-trust-services/) |
| `frizz.sh` is active in the **personal** account | zone `2dc5dbf9a1e0f4acf5641c8cae508591`, account `3eef35e2fc9f974f5b2dfaad9f021bbe` |
| Frizz has **no authentication of any kind** today | reaching the port is the authorization; `EXPOSED_WARNING` says so |
| cloudflared's origin-facing contract | port-less `Host`, `x-forwarded-for`, `x-forwarded-proto: https`, `cf-*`; app reads carry no Origin + `sec-fetch-site: same-origin` |

## The decision that shapes everything: do NOT use Cloudflare Access

My earlier advice — "prototype with Access, it is zero code" — is right for a free toy and **wrong the
moment money is involved**, for two independent reasons:

1. **It sets a $7/user/month COGS floor.** Every paying customer consumes an Access seat past the first
   50. If you charge $15, you have given away half your margin before hosting anything.
2. **It is probably contractually prohibited.** Cloudflare's Zero Trust terms bar reselling the service
   to third parties absent written permission. A paid product whose access control *is* Cloudflare
   Access, sold to customers, is squarely the thing that clause describes.

So: **Frizz grows its own auth layer.** That is a day or two of work, it removes the per-user cost
entirely, it is portable across tunnels (works for self-hosters on Tailscale or ssh too), and it is
defense in depth regardless — today a misconfigured edge means total compromise.

This is the single highest-leverage item in this plan and it blocks everything after it.

## Architecture

**Data plane: Cloudflare's edge. You never proxy a byte.** Each user's traffic goes browser → Cloudflare
→ their own tunnel → their laptop. You carry no bandwidth cost, you are not on the hot path, and you
cannot read their traffic. If your control plane is down, every existing board keeps working and only
new signups break. Getting this right is worth more than any other architectural choice here.

**Control plane: one Worker + D1.** It is a credential vending machine, ~a few hundred lines:

```
POST /device/start      → GitHub device flow (public client_id, CLI shows the code)
POST /device/poll       → exchange for a GitHub token; verify; read numeric user id
POST /claim             → create tunnel via CF API, create CNAME, return the per-tunnel token
GET  /jwks              → public keys, so Frizz verifies sessions offline
GET  /login?return=…    → browser GitHub OAuth → mint a short-lived JWT → redirect back
POST /stripe/webhook    → subscription lifecycle → enable/disable
```

**Identity: GitHub, keyed on the numeric user id — never the login string.** Handles get renamed and
released; keying on the string means the next holder of `colinhacks` inherits the subdomain. This is
the same shape as the documented tunnel-subdomain recycling hijacks. **Never release a claimed
subdomain**, for the same reason.

**Board auth: a signed session Frizz verifies itself.**

1. Browser hits `colin.frizz.sh`, Frizz sees no session cookie.
2. Redirect to `auth.frizz.sh/login?return=…`; GitHub OAuth; Worker mints a short-lived JWT naming the
   subdomain and the user.
3. Redirect back; Frizz validates the JWT against cached JWKS — **offline, no call to your Worker** —
   and sets an `HttpOnly; Secure; SameSite=Lax` cookie.

Frizz's existing origin gate already refuses cross-site mutations, so CSRF is covered by machinery that
exists. The new surface is the cookie and the JWT.

## What Frizz itself has to gain (the code work)

1. **Session layer** — JWT verify, JWKS cache, cookie, login redirect, logout. Gate every route the
   `--public-origin` path serves. *This is the prerequisite for everything.*
2. **`frizz login` / `--cloud`** — device flow, store the per-tunnel token in `~/.frizz/`, supervise
   `cloudflared` as a child process (restart, backoff, health).
3. **A `cloudflared` binary** — bundle per platform (~30 MB each, ugly in an npm package) or download
   on first `--cloud` use with a pinned checksum. Prefer download-on-demand; the package stays small
   and self-hosters never pay for it.
4. **Revocation** — the Worker says the subscription lapsed, Frizz stops serving the public origin and
   says why. Must fail closed.
5. **Local escape hatch** — `--public-origin` and loopback keep working with no account, forever. The
   free/self-host tier is what makes the paid tier feel like convenience rather than a toll booth.

## What changes because it is *paid*

The free prototype needs almost no state. Billing changes that.

- **Stripe Checkout + Customer Portal.** Do not build billing UI. Portal handles card updates,
  cancellation, invoices.
- **Subscription state is now load-bearing**: `subscription.deleted`, `payment_failed`, and
  `customer.subscription.updated` webhooks must disable the tunnel. Grace period on failed payment
  (people's cards expire; do not nuke their board same-day).
- **Reconciliation cron.** D1, Cloudflare, and Stripe *will* drift — a webhook is missed, a tunnel is
  deleted by hand. A nightly job that reconciles all three and reports drift is not optional at the
  point people are paying.
- **Recovery and support.** Lost laptop, new machine, "my subdomain is stuck". Needs a re-issue path
  that proves identity (GitHub re-auth) and rotates the tunnel token.
- **Abuse.** Someone will put a phishing page behind `*.frizz.sh`. You are the party of record. Needs a
  ToS, an abuse contact, and a per-user + global kill switch you have actually tested.
- **Tax.** Stripe Tax; it is a checkbox and it is not optional for a real business.

## Cost model

Marginal cost per user is approximately **zero** if you avoid Access — that is the entire point of the
design above. Fixed: Workers paid plan $5/mo, D1 negligible at this scale, tunnels free, bandwidth is
Cloudflare's. Variable: Stripe at 2.9% + 30¢. Domain ~$30/yr for `.sh`.

The thing that would wreck this model is anything that puts you on the data plane, or Access seats.

## Security: the part that deserves the most paranoia

**A Frizz board runs shell commands as its owner. An auth bug here is remote code execution on your
customers' laptops, not a data leak.** That reframes several ordinary choices:

- **Vanity subdomains advertise the target list.** `colin.frizz.sh` lets anyone enumerate your customers
  from GitHub handles. For a paid product vanity is part of the value, so buy it back with genuinely
  strong auth rather than obscurity — but know the trade you are making. (Microsoft's dev tunnels chose
  opaque ids for exactly this reason, and require the *same account on both ends*.)
- **The per-tunnel token on the user's disk is a bearer credential.** Stolen, it does not reach their
  machine — but it lets the thief serve traffic *as* `colin.frizz.sh`, which is a good phishing primitive.
  Make rotation a first-class operation, not a support ticket.
- **Secrets never touch the client.** The Cloudflare zone token lives only as a Worker secret
  (`wrangler secret put`), never in `wrangler.toml`, never in the repo, never in the npm package. Add a
  pre-publish grep for token-shaped strings over `npm pack` output, and turn on GitHub push protection.
- Short JWT lifetime, refresh via redirect, no token left in the URL after exchange, rate limit the
  Worker's claim endpoint.

## Staged build

**Stage 0 — done.** `--public-origin` + docs. Self-host tier: bring your own Cloudflare/Tailscale.
Costs you nothing and is a real product on its own.

**Stage 1 — Frizz auth layer.** JWT sessions. Needed by every later stage, valuable standalone (it
closes the "misconfigured edge = total compromise" hole for self-hosters today).

**Stage 2 — free tier with subdomains.** Worker + D1 + GitHub device flow + tunnel vending. No billing.
Validates demand and the whole mechanism.

**Stage 3 — paid.** Stripe, revocation, reconciliation, ToS, support.

Do not skip Stage 1 to get to Stage 2 faster; Stage 2 without it is a public directory of unauthenticated
shells.

## Go/no-go item to settle before Stage 3

**Get Cloudflare's written position on this use case.** Building tunnels for paying third parties may be
"reselling Zero Trust" under their service-specific terms. If they say no, the whole data-plane story
changes and the economics with it. This is cheap to ask and expensive to discover late — do it before
writing billing code, not after.

Also: move `frizz.sh` out of the personal Cloudflare account before it carries a business. Moving a zone
between accounts later means removing and re-adding it, with a DNS gap.

## Rejected

- **Cloudflare Access as the product's auth** — $7/user COGS floor and probable ToS conflict. See above.
- **A proxy Worker in front of `*.frizz.sh`** — removes per-user DNS writes, but puts you on the data
  plane: their bandwidth on your bill, your uptime in front of every board, and you can see everything.
- **Nested `<repo>.<user>.frizz.sh`** — needs paid ACM with a wildcard per user, 50 SANs per cert. Moot
  now that Frizz is one server per machine.
- **Shipping a Cloudflare token in the client** — impossible to scope safely; see verified premises.
- **Vercel as the front** — no tunnel product, and `vercel.json` rewrites do not proxy WebSocket
  upgrades to an external destination. Frizz's board and terminals are all WebSockets.
