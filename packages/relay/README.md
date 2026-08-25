# Relay

One wildcard hostname in front of every board. `*.frizz.sh` resolves here; a board dials in over a
WebSocket and holds it open, and a visitor's request for that board's hostname is routed to the
Durable Object holding that socket and framed down it.

**A claim creates no infrastructure**, which is the whole point: no DNS record per name and no tunnel
per name, so the 200-record ceiling that bounded the original design is gone. The [registrar](../registrar)
records who owns a name; this serves it.

**This IS on the data path**, unlike the registrar, and that is the trade the design makes
deliberately: unlimited names cost us the traffic. Nothing in a board is trusted to the relay — a
visitor still meets Frizz's own single-use access gate on the far side — but the bytes do pass through.

## What it carries

A board is mostly a live surface, so a plain request/response proxy would be useless for it. The
protocol in [`@frizz/shared/relay-protocol.ts`](../shared/src/relay-protocol.ts) frames three things:

- **a unary request**, answered in one frame;
- **a streamed response**, because the board's event feed is SSE and never ends — the head and the body
  are separate frames for exactly that reason;
- **a nested WebSocket**, because the board's terminals are WebSockets. The Durable Object asks the
  board to open its local end and links the two, and refuses the visitor's upgrade outright when it
  cannot: a pane that opens and stays silent is far harder to diagnose than one that fails.

A frame body caps at 512 KiB. A Cloudflare WebSocket message caps at 1 MiB and base64 costs a third on
top, so anything larger takes the streaming path rather than being dropped.

## How a board proves itself

The same Ed25519 identity that claimed the name, signing a handshake that rides in the connect URL —
before the upgrade, so an unproven socket never occupies the name's Durable Object at all. The relay
verifies it against the public key the registrar recorded, holds no secret of its own, and stops
believing a handshake older than five minutes.

## Deploying

```sh
cd packages/relay
wrangler deploy
```

Two things that will waste your time otherwise:

- **A route pattern without `/*` matches only the root path.** `*.frizz.sh` alone serves `/` and 522s
  everything else. The pattern is `*.frizz.sh/*`, and the trailing `/*` is not optional.
- **A workers route beats a custom domain.** This wildcard swallowed `registrar.frizz.sh` the day it
  shipped and took signup down. The registrar answers that with a more specific route of its own; do
  not remove it.

## Verifying

```sh
nub --test packages/relay/src/board-socket.test.ts packages/relay/src/worker.test.ts
nub scripts/verify-relay-e2e.mjs        # the frames, on real workerd
nub scripts/verify-relay-gate.mjs       # a relayed terminal against the REAL access gate
nub scripts/verify-relay-terminal.mjs   # a REAL pty, through the real terminal server
```

The unit tests drive the Durable Object's state machine against fakes, which proves each half and
nothing about the seam between them — and there are three seams here that all have to hold at once. So
the e2e harness runs the real Worker under `wrangler dev`, a real board on loopback, and a real agent
connecting them, including a terminal typed through both runtimes.

The three harnesses answer different questions, and each later one exists because the earlier cannot.
A board in `verify-relay-e2e.mjs` is a toy that accepts every upgrade, so a relay forwarding NO visitor
identity passes there and would fail against the real thing. `verify-relay-gate.mjs` puts the real
`RestartSupervisorProxy` in the path: an unauthenticated terminal is REFUSED and never reaches the
board, and a visitor holding a redeemed session gets through. `verify-relay-terminal.mjs` then replaces
the toy entirely, driving the real terminal server with a real pty behind the injected login source.

**Two measured facts worth not re-deriving.** `wrangler dev` does NOT enforce Cloudflare's 1 MiB
WebSocket message cap, so an UNCHUNKED build passes the end-to-end reassembly check — the assertion
that catches it is the unit test on serialized frame size. And `node-pty` delivers in 1 KiB chunks, so
a terminal alone can never approach that cap; the message that can is a board snapshot, which is why
`ws-msg` chunks at all.

The first harness uses `localhost` as the zone rather than `frizz.sh`, so `ada.localhost` is a valid board name and
resolves to loopback without touching DNS. Two traps it exists to remember: `wrangler dev` synthesizes
the request URL FROM THE ROUTE PATTERN, so the production config makes every request arrive as
`frizz.sh` — the harness writes a routeless config of its own. And `fetch` silently drops a `Host`
header, so a spoofed one proves nothing; use a real hostname.
