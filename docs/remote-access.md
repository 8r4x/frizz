# Remote access

> Published as pages at [frizz.sh/docs](https://frizz.sh/docs), built from `site/docs/`. This file stays because `src/cloud.ts` names it in two error messages and the README links it — change one and change the other, or a reader gets a different answer depending on where they looked.

Frizz binds `127.0.0.1` and has no login of its own. To reach a board from a phone or another machine, put something in front of it that does the authenticating, then tell Frizz which origin that something serves.

```sh
# the board stays on loopback; the tunnel or proxy dials it
npx frizz --public-origin https://board.example.com
```

Naming the origin does two things. Frizz accepts requests arriving as that exact origin, and it prints a **single-use access link** — as a QR code, so a phone can scan it off the terminal. Scanning trades the code for a session cookie, so the link itself stops working the moment it is used.

```sh
npx frizz --link          # a fresh link for a board that is already running
```

Press `L` in the board's terminal for the same thing without leaving it.

> Anything that reaches the board can run shell commands as you. Whatever sits in front of the origin **is** the access control — Frizz's single-use links gate the first visit, not the network.

## A name on frizz.sh

The shortest path, and the only one that needs nothing of your own — no domain, no port forwarding, and no extra binary to install. Pick a name and Frizz claims it and serves it:

```sh
$ npx frizz up
Name for this board — a word claims <name>.frizz.sh, or paste a hostname you already run a tunnel for: ada
  claiming ada.frizz.sh for GitHub user ada
```

Requires the [GitHub CLI](https://cli.github.com) signed in. Frizz asks `gh` for a token, the registrar exchanges it for your account id and discards it, and the name is bound to that account. Renewals afterwards need neither — your machine's key proves ownership, so the name keeps working whether or not GitHub does.

Every launch renews the lease. A name nobody has run for **30 days** is released and can be claimed by someone else.

Your board stays on loopback and **dials out** to `frizz.sh`, which is what removes the inbound port, the tunnel binary and the DNS record all at once — a laptop behind any NAT works with no configuration. The connection comes back by itself after a sleep or a network change, so a board is reachable again when the machine is.

### What you are agreeing to

- **One name per GitHub account.** Accounts less than 30 days old cannot claim.
- **The name is a lease, not property.** It lapses after 30 days unused, and Frizz can reclaim any name at any time — that is the only enforcement there is, so it has to exist.
- **No warranty.** This is a free convenience on a domain someone else owns. Anything you cannot afford to lose access to belongs on a domain you control; every other section here shows how.
- **Your traffic passes through us.** A name on `frizz.sh` is served by a relay we run: every request and every keystroke goes through it. That is the trade a shared domain makes. Frizz's own access gate still runs on your machine, so a visitor meets it whether or not the relay is honest — but if you would rather no third party carried the bytes, use a domain you control.

Want your own domain instead? Everything below works without us.

## SSH port forwarding

The simplest option, and the only one that needs no flag at all. The forwarded port is loopback on both ends, so Frizz treats it as local:

```sh
ssh -L 9393:127.0.0.1:9393 you@your-machine
# then open http://127.0.0.1:9393 on the client
```

Nothing is exposed to the internet and no access link is involved. The cost is that the tunnel lives as long as the SSH session, which makes it awkward from a phone.

## Tailscale

Tailscale gives the machine a stable HTTPS name on your tailnet and terminates TLS itself, so only your devices can reach it:

```sh
tailscale serve --bg 9393     # see the Tailscale Serve docs for the current syntax
npx frizz --public-origin https://your-machine.your-tailnet.ts.net
```

Authentication is the tailnet — a device that is not signed into it cannot reach the name at all. Take the origin from what [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) reports it is serving, since the tailnet name is not something you choose.

## Cloudflare Tunnel

A tunnel reaches a board from anywhere without opening a port, and it needs a domain you control on Cloudflare. Create the tunnel and its DNS record once:

```sh
cloudflared tunnel login                                  # pick your zone
cloudflared tunnel create my-board
cloudflared tunnel route dns my-board board.example.com
```

Then point the tunnel at the board. Write this to `~/.cloudflared/frizz.yml`, which Frizz looks for by name — keep it out of `config.yml`, whose catch-all shadows other tunnels:

```yaml
tunnel: my-board
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: board.example.com
    service: http://127.0.0.1:9393
  - service: http_status:404
```

Run the two halves yourself, or let Frizz own the tunnel as a child process:

```sh
npx frizz up     # asks once for the hostname and tunnel name, then remembers both
```

Running it under Frizz is worth preferring, because the two halves then share a lifetime. A tunnel that outlives its board serves Cloudflare error 1033 to anyone who visits; a board that outlives its tunnel is unreachable with nothing to say why.

## Any other reverse proxy

The rule is the same for Caddy, nginx, ngrok or anything else: terminate TLS wherever you like, proxy to the board's loopback port, and pass the public origin to Frizz.

```sh
npx frizz --public-origin https://whatever-that-proxy-serves
```

Frizz checks that a request's `Host` matches the origin it was given, so the value has to be the exact origin a browser sees — scheme included, no trailing slash.

## Headless machines

A machine nobody watches still mints links on demand — sign in over SSH and ask the running board for one:

```sh
ssh you@box npx frizz --link
```

The link prints as a QR and a URL, is single-use, and expires in five minutes.
