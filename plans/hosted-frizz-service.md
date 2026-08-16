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
| The Zero Trust reselling clause covers **Access, Gateway, RBI, email security, CASB, DLP** — **NOT Tunnel** | [Zero Trust service-specific terms](https://www.cloudflare.com/service-specific-terms-zero-trust-services/), product list read verbatim |
| The **general** agreement is the real constraint, and it is broader | [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/) §2.2.1(a) "rent, lease, loan, export, or sell access to the Services to any third party, or sign up for the Services on behalf of a third party"; §2.2.1(j) "use the Services to provide a virtual private network or other similar proxy services" |
| Non-Enterprise accounts cap at **1,000 tunnels** | [Cloudflare One account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) — also 100 edge connections per tunnel |
| **Cloudflare for SaaS** is the sanctioned "extend Cloudflare to your end customers" product | [docs](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/); Shopify, Webflow, Kinsta, Render ship on it |
| DO **WebSocket hibernation applies to INCOMING connections** (`ctx.acceptWebSocket()`) | [Durable Objects WebSocket docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) — the agent dials in, so this is the right direction |
| `frizz.sh` is active in the **personal** account | zone `2dc5dbf9a1e0f4acf5641c8cae508591`, account `3eef35e2fc9f974f5b2dfaad9f021bbe` |
| Frizz has **no authentication of any kind** today | reaching the port is the authorization; `EXPOSED_WARNING` says so |
| cloudflared's origin-facing contract | port-less `Host`, `x-forwarded-for`, `x-forwarded-proto: https`, `cf-*`; app reads carry no Origin + `sec-fetch-site: same-origin` |

## The decision that shapes everything: do NOT use Cloudflare Access

My earlier advice — "prototype with Access, it is zero code" — is right for a free toy and **wrong the
moment money is involved**, for two independent reasons:

1. **It sets a $7/user/month COGS floor.** Every paying customer consumes an Access seat past the first
   50. If you charge $15, you have given away half your margin before hosting anything.
2. **It is the one place the Zero Trust reselling clause genuinely does bite.** That clause enumerates
   Access, Gateway, RBI, email security, CASB and DLP — so it says nothing about Tunnel, but a paid
   product whose access control *is* Cloudflare Access is squarely what it describes.

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

## The terms question, correctly stated

An earlier draft of this plan said the blocker was the Zero Trust reselling clause. **That was the wrong
clause.** Cloudflare Tunnel is not one of the enumerated Zero Trust Services, so it does not apply.

The real constraint is the general [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/),
which applies to everything:

- **§2.2.1(a)** — no "rent, lease, loan, export, or sell access to the Services to any third party, or
  sign up for the Services on behalf of a third party."
- **§2.2.1(j)** — no "use the Services to provide a virtual private network or other similar proxy
  services."

(j) is the sharp one, and it is aimed squarely at this product's shape. Two consequences worth being
precise about:

1. **This is not a "Cloudflare Tunnel is disallowed" finding — it is a self-serve-terms finding.** The
   clause ends where a written agreement begins, and Cloudflare sells exactly that: **Cloudflare for
   SaaS** exists to extend Cloudflare to a provider's end customers, and Shopify, Webflow, Kinsta and
   Render are shipping on it. So the path exists; it runs through a sales conversation and an Enterprise
   agreement, not through self-serve signup. The 1,000-tunnel account cap forces that same conversation
   at scale anyway, so the two arrive together.
2. **Building your own tunnel on Workers + Durable Objects does NOT dodge this.** It is still Cloudflare's
   network, and "providing proxy services" arguably describes a hand-rolled proxy more plainly than it
   describes using their supported product. Escaping §2.2.1(j) means moving the *data plane* off
   Cloudflare — which is a much bigger decision than which tunnel library to use.

**What to do about it: do not let it block Stages 0–2.** Self-hosting, the Frizz auth layer, and even a
free tier where users authenticate with their own GitHub are not "selling access to the Services." Ask
Cloudflare before Stage 3, when there is a real product to describe and the question is concrete.

Also: move `frizz.sh` out of the personal Cloudflare account before it carries a business. Moving a zone
between accounts later means removing and re-adding it, with a DNS gap.

## Building the tunnel ourselves

Worth costing, both as leverage in that conversation and as insurance if the answer is no.

**Cloudflare Workers + Durable Objects — no servers, ~1–2 weeks for a credible v1.** One DO per subdomain
holds a WebSocket the user's agent dials *in* on; the Worker routes `<name>.frizz.sh` to that DO, which
forwards over the socket. Hibernation applies to incoming sockets, so idle tunnels cost approximately
nothing and connections survive. No regions, no autoscaling, no machines.

**The hard part is not routing — it is multiplexing.** The board is itself WebSocket-heavy (the board
socket plus every terminal pane), so you are tunnelling WebSockets *inside* a WebSocket, alongside
concurrent HTTP. That means your own framing, stream ids, backpressure, and reconnect/resume semantics.
cloudflared gets this from QUIC streams for free. This is the piece that turns "a weekend" into "a
fortnight, then a long tail of edge cases," and it is where a DIY tunnel earns its bugs.

**Off Cloudflare, if §2.2.1(j) forces it:**

- **Fly.io** — the best fit for "no infrastructure management" outside Cloudflare. Anycast plus Machines,
  deploy a container running a small tunnel server (`frp`, `rathole`, or your own). Hosting arbitrary
  network services *is* their business, so the terms fit naturally. You pay egress, which Cloudflare
  does not charge you for — that is the real cost of leaving.
- **ngrok** — they sell embedding into other products, which is the "just buy it" answer and the fastest
  legitimate path. Public list pricing includes data transfer at $0.10/GB, so it becomes a genuine
  per-user COGS line; OEM terms need a sales conversation of their own.
- **A VPS running `frp`/`rathole`** — cheapest and most controllable, and explicitly ruled out: it is
  infrastructure management.

**The engineering conclusion, which is cheap and worth doing regardless: make the transport pluggable in
Frizz.** Do not hard-code `cloudflared`. If the tunnel is a strategy behind a small interface, then the
answer to the terms question — and any later cost or reliability surprise — becomes a swap rather than a
rewrite. That is a day of design discipline now against a fortnight of migration later.

## Rejected

- **Cloudflare Access as the product's auth** — $7/user COGS floor and probable ToS conflict. See above.
- **A proxy Worker in front of `*.frizz.sh`** — removes per-user DNS writes, but puts you on the data
  plane: their bandwidth on your bill, your uptime in front of every board, and you can see everything.
- **Nested `<repo>.<user>.frizz.sh`** — needs paid ACM with a wildcard per user, 50 SANs per cert. Moot
  now that Frizz is one server per machine.
- **Shipping a Cloudflare token in the client** — impossible to scope safely; see verified premises.
- **Vercel as the front** — no tunnel product, and `vercel.json` rewrites do not proxy WebSocket
  upgrades to an external destination. Frizz's board and terminals are all WebSockets.

## Stage 1, concretely: single-use codes instead of one standing secret

What shipped in `ec6ecb1` is a **floor**: one long-lived bearer secret, printed at launch, traded for a
year-long cookie. It works, and its weaknesses are structural rather than fixable by tuning:

- The secret lands in terminal scrollback, shell history, and (as of 2026-08-16) an email. Every copy is
  permanently valid.
- It only rotates when the board restarts, which is exactly when it is most disruptive to rotate.
- There is one secret for the whole machine, so "let someone see this board" is indistinguishable from
  "hand over every project on my laptop".

### The mechanism

Separate **codes** from **sessions** — the single most important move, and the reason this generalises.

- A **code** is single-use and short-lived (~5 minutes). It authorizes exactly one exchange.
- A **session** is what the code mints: a long-lived signed cookie, independently revocable.
- `GET /?frizz_code=<code>` → atomic compare-and-set on the code (used exactly once, no TOCTOU) → mint
  session → redirect to a clean URL, as the current exchange already does.

Once that split exists, everything else is a policy on top: expiry, per-device naming, "sign out all
devices", and eventually a real IdP minting the session instead of a code. The hosted product's JWT is
the same shape with GitHub in front, which is why this is not throwaway work.

### QR is the right affordance, not a gimmick

The actual problem is moving a credential from a terminal to a phone, and a 32-character token is
miserable to type. Render the code as a QR in the terminal (half-block glyphs; a minimal encoder is
small enough not to warrant a dependency). Repainting it the moment it is consumed — the server already
knows, because consumption goes through one endpoint — makes the staleness visible instead of implicit.

### Show it in an EPHEMERAL pane, not the standing readout

Tempting to print the QR in the launch readout. Don't:

- The readout is scrollback. A QR sitting in scrollback is the same leak as the token today, just harder
  to grep for.
- Frizz deliberately degrades to plain parseable records when stdout is not a TTY (`if (!readout)`), and
  a permanent live region fights `--debug`, piping, and CI.

So: keep the standing readout exactly as it is, and add a keypress (TTY only) that opens a temporary
full-screen pane showing a freshly minted code as a QR, which restores the normal readout on dismiss or
expiry. That is the maintainer's second sketch and it is the safer of the two.

### Keep the standing secret for headless

`FRIZZ_PUBLIC_TOKEN` stays, for boxes with no TTY where nobody can press a key — a server, a container, a
CI runner. Interactive launches default to single-use codes; headless ones keep the pinned secret. Say so
in the readout, because the two postures have genuinely different risk.

### Cautions worth encoding in the tests

- Single-use must be **atomic**. Two browsers racing one code is the bug that makes "single-use" a lie.
- Short expiry: a QR photographed over a shoulder, or caught in a screen recording, is a real vector.
- Rate-limit redemption, and never write a code to a log file or the terminal title.
- Sessions need revocation, or "I shared my board once" becomes permanent.
