import {
  exportClaimPublicKey,
  parseFrame,
  relayHandshakeInput,
  serializeFrame,
  type RelayDownFrame,
  type RelayHandshake,
  type RelayUpFrame,
} from "@frizz/shared";
import { serveRelayRequest, serveRelayWebSocket, type NestedSession } from "./relay-agent.ts";

/**
 * The board's connection to the relay: dial out, prove who we are, then serve whatever arrives.
 *
 * The board is the one that reaches out. That single fact is what removes the inbound port, the tunnel
 * binary and the per-user DNS record all at once — and it is why a laptop behind any NAT works with no
 * configuration at all.
 *
 * RECONNECTION IS THE FEATURE, not an afterthought. A laptop sleeps, changes network and loses Wi-Fi
 * constantly; a relay connection that does not come back by itself would mean a board that is
 * permanently unreachable after the first suspend, with nothing on screen to say so.
 */

export interface RelayConnectionOptions {
  /** The claimed name, e.g. `ada`. */
  name: string;
  /** The identity that claimed it. The handshake proves ownership with the same key. */
  identity: CryptoKeyPair;
  /** The relay's origin, e.g. `https://frizz.sh`. */
  relayOrigin: string;
  /** The board on loopback, e.g. `http://127.0.0.1:9393`. */
  boardOrigin: string;
  /** The hostname visitors use, e.g. `https://ada.frizz.sh`. */
  publicOrigin: string;
  /** Injected so a test can drive this without a real relay. */
  socketFactory?: (url: string) => RelaySocket;
  onStatus?: (status: "connected" | "disconnected" | "retrying", detail?: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Bounded so a test does not wait out real backoff. */
  backoff?: (attempt: number) => number;
}

/** The bits of a WebSocket this uses. Node's global and `ws` both satisfy it. */
export interface RelaySocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

const b64url = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Exponential with a ceiling and jitter.
 *
 * The jitter matters more than the curve: when the relay restarts, every board on it is disconnected
 * in the same instant, and without jitter they would all return in the same instant too.
 */
export function defaultBackoff(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
  return Math.round(base / 2 + random() * (base / 2));
}

export async function signRelayHandshake(name: string, identity: CryptoKeyPair, issuedAt: number): Promise<RelayHandshake> {
  const pubkey = await exportClaimPublicKey(identity.publicKey);
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    identity.privateKey,
    relayHandshakeInput(name, pubkey, issuedAt) as BufferSource,
  );
  return { v: 1, name, pubkey, issuedAt, sig: b64url(signature) };
}

export interface RelayConnection {
  stop(): void;
  readonly connected: boolean;
}

export function connectRelay(options: RelayConnectionOptions): RelayConnection {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const backoff = options.backoff ?? defaultBackoff;
  const makeSocket =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as RelaySocket);

  let socket: RelaySocket | null = null;
  /** Local terminals, one per visitor session the relay has opened. */
  const nested = new Map<string, NestedSession>();
  let attempt = 0;
  let stopped = false;
  let retryHandle: unknown;

  const send = (frame: RelayUpFrame) => {
    try {
      socket?.send(serializeFrame(frame));
    } catch {
      // The socket died between the request arriving and its answer. The relay fails the request on
      // its side when the connection drops, so there is nothing useful to do here.
    }
  };

  const scheduleRetry = (reason: string) => {
    if (stopped) return;
    const delay = backoff(attempt++);
    options.onStatus?.("retrying", `${reason}; retrying in ${Math.round(delay / 1000)}s`);
    retryHandle = setTimer(() => void open(), delay);
  };

  const open = async (): Promise<void> => {
    if (stopped) return;
    let handshake: RelayHandshake;
    try {
      handshake = await signRelayHandshake(options.name, options.identity, now());
    } catch (error) {
      scheduleRetry(`could not sign the relay handshake: ${error instanceof Error ? error.message : error}`);
      return;
    }
    // The handshake rides in the URL so the relay can judge it before upgrading — an unproven socket
    // then never occupies the name's Durable Object at all.
    const encoded = b64url(new TextEncoder().encode(JSON.stringify(handshake)).buffer as ArrayBuffer);
    const url = `${options.relayOrigin.replace(/^http/, "ws").replace(/\/$/, "")}/_relay/connect?h=${encoded}`;

    const next = makeSocket(url);
    socket = next;

    next.addEventListener("open", () => {
      attempt = 0;
      options.onStatus?.("connected");
    });

    next.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const frame = parseFrame(event.data) as RelayDownFrame | null;
      if (!frame) return;
      if (frame.t === "ping") {
        send({ t: "pong", id: frame.id });
        return;
      }
      if (frame.t === "req") {
        void serveRelayRequest(frame, {
          origin: options.boardOrigin,
          publicOrigin: options.publicOrigin,
          send,
        });
        return;
      }
      if (frame.t === "ws-open") {
        nested.set(
          frame.id,
          serveRelayWebSocket(frame, {
            origin: options.boardOrigin,
            publicOrigin: options.publicOrigin,
            send,
          }),
        );
        return;
      }
      if (frame.t === "ws-msg") {
        nested.get(frame.id)?.message(frame.data, frame.more);
        return;
      }
      if (frame.t === "ws-close") {
        nested.get(frame.id)?.close();
        nested.delete(frame.id);
      }
    });

    const dropped = () => {
      if (socket !== next) return; // a socket we already replaced
      socket = null;
      // The relay is gone, so every terminal riding on it is too. Closing the local ends stops a pty
      // from being held open by a session nothing can reach any more.
      for (const session of nested.values()) session.close();
      nested.clear();
      options.onStatus?.("disconnected");
      scheduleRetry("the relay connection closed");
    };
    next.addEventListener("close", dropped);
    next.addEventListener("error", dropped);
  };

  void open();

  return {
    stop() {
      stopped = true;
      if (retryHandle !== undefined) clearTimer(retryHandle);
      try {
        socket?.close();
      } catch {
        // Already gone.
      }
      for (const session of nested.values()) session.close();
      nested.clear();
      socket = null;
    },
    get connected() {
      return socket !== null;
    },
  };
}
