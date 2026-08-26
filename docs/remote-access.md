# Remote access

Frizz binds `127.0.0.1` and has no login of its own. To reach a board from a phone or another machine, something in front of it carries the traffic, and Frizz gates the first visit with a single-use sign-in link.

Press **R** in the terminal running Frizz. A walkthrough offers four ways to reach the board, checks what each needs, prints the commands, and remembers your choice — a plain `npx frizz` serves it from then on. **Off** in the same place goes back to loopback only.

```
  Reach this board from anywhere

  ❯ frizz.sh name       <name>.frizz.sh — nothing to install; needs the GitHub CLI
    Cloudflare Tunnel   a domain you own on Cloudflare; cloudflared on this machine
    Tailscale           your tailnet; tailscale serve does the TLS
    Something else      any proxy or tunnel you run — tell Frizz its address
    Off                 loopback only  (current)
```

Whichever you pick, the board stays bound to loopback. The readout then shows a QR: scanning it trades a single-use code for a session cookie, so the link stops working the moment it is used. Press **L** for a fresh one at any time.

```sh
npx frizz --link          # a fresh link for a board that is already running — over SSH, for a headless box
npx frizz --sessions      # the devices holding a session
npx frizz --sign-out all  # revoke them
```

## A name on frizz.sh

The shortest path, and the only one that needs nothing of your own — no domain, no port forwarding, and no extra binary to install. Pick a name and Frizz claims it and serves it:

```
  frizz.sh name

  GitHub CLI   signed in as ada ✓

  Name   ada█
```

Requires the [GitHub CLI](https://cli.github.com) signed in. Frizz asks `gh` for a token, the registrar exchanges it for your account id and discards it, and the name is bound to that account. Renewals afterwards need neither — your machine's key proves ownership, so the name keeps working whether or not GitHub does.

Every launch renews the lease. A name nobody has run for **30 days** is released and can be claimed by someone else.

Your board stays on loopback and **dials out** to `frizz.sh`, which is what removes the inbound port, the tunnel binary and the DNS record all at once — a laptop behind any NAT works with no configuration. The connection comes back by itself after a sleep or a network change, so a board is reachable again when the machine is.

### What you are agreeing to

- **One name per GitHub account.** Accounts less than 30 days old cannot claim.
- **The name is a lease, not property.** It lapses after 30 days unused, and Frizz can reclaim any name at any time — that is the only enforcement there is, so it has to exist.
- **No warranty.** This is a free convenience on a domain someone else owns. Anything you cannot afford to lose access to belongs on a domain you control; every other section here shows how.
- **Your traffic is not ours.** It goes from your machine to the relay to whoever is visiting. The registrar runs at signup and never again, and Frizz has no way to see what passes over your board.

## Cloudflare Tunnel

Needs a domain you control on Cloudflare and `cloudflared` on this machine. Create the tunnel and its DNS record once, in another terminal:

```sh
cloudflared tunnel login                                  # pick your zone
cloudflared tunnel create my-board
cloudflared tunnel route dns my-board board.example.com
```

Then pick **Cloudflare Tunnel** and name them:

```
  Hostname   board.example.com
  Tunnel     my-board
```

Frizz writes `~/.cloudflared/frizz.yml` (an ingress from the hostname to the board's loopback port) and runs the tunnel beside the board, so the two share a lifetime: a tunnel that outlives its board serves Cloudflare error 1033, and a board that outlives its tunnel is unreachable with nothing to say why.

## Tailscale

Tailscale gives the machine a stable HTTPS name on your tailnet and terminates TLS itself, so only your devices can reach it. Run once, in another terminal:

```sh
tailscale serve --bg 9393     # Frizz's port
```

Then pick **Tailscale**. Frizz reads this machine's MagicDNS name from the daemon and offers it as the origin; enter accepts it.

## Something else

The rule is the same for Caddy, nginx, ngrok or anything else: terminate TLS wherever you like, proxy to `http://127.0.0.1:9393`, and give Frizz the exact origin a browser will show — scheme and host, no path. Frizz answers only to that `Host` and prints its sign-in link for it.

## Headless machines

A machine nobody watches still mints links on demand — sign in over SSH and ask the running board for one:

```sh
ssh you@box npx frizz --link
```

The link prints as a QR and a URL, is single-use, and expires in five minutes. The setup itself is made once from an interactive terminal; the saved choice (`~/.frizz/cloud.json`) is what a headless launch serves.

## SSH port forwarding

Needs no setup at all. The forwarded port is loopback on both ends, so Frizz treats it as local:

```sh
ssh -L 9393:127.0.0.1:9393 you@your-machine
# then open http://127.0.0.1:9393 on the client
```

Nothing is exposed and no sign-in link is involved. The cost is that the tunnel lives as long as the SSH session, which makes it awkward from a phone.
