import { request as httpRequest } from "node:http";
// The WHATWG `WebSocket` global cannot set request headers, and the visitor's Host, Origin and session
// cookie are exactly what the board's upgrade gate reads. `ws` is already in the published bundle.
import { WebSocket as WsWebSocket } from "ws";
import {
  decodeBody,
  encodeBody,
  RELAY_MAX_FRAME_BODY,
  serializeFrame,
  stripHopByHop,
  type RelayDownFrame,
  type RelayUpFrame,
} from "@frizz/shared";

/**
 * The board's half of the relay: it answers requests that arrive down the socket.
 *
 * Everything here talks to the LOCAL board over loopback. The relay never reaches in — the board
 * reaches out and then serves what it is asked, which is the whole reason this needs no inbound port
 * and no tunnel binary.
 *
 * Kept separate from the connection loop so it can be driven against a real local server in a test
 * without any relay, socket or Cloudflare involved.
 */

export interface ServeOptions {
  /** The board's loopback origin, e.g. `http://127.0.0.1:9393`. */
  origin: string;
  /** Where a frame goes. Separated so a test can collect them instead of writing to a socket. */
  send: (frame: RelayUpFrame) => void;
  /**
   * The public origin the visitor used, so the board's own gate sees the request as arriving there.
   *
   * WITHOUT THIS THE BOARD REFUSES EVERY RELAYED REQUEST. Frizz's origin gate keys on the request
   * having arrived AS the declared public origin; a request forwarded to loopback with a loopback Host
   * would be judged local and skip the access gate entirely, which is the opposite of what anyone
   * wants for a board on the internet.
   */
  publicOrigin: string;
}

/** A response streams when it has no length we can know up front — SSE above all. */
function shouldStream(headers: Array<[string, string]>): boolean {
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === "content-type" && value.includes("text/event-stream")) return true;
    if (lower === "transfer-encoding" && value.includes("chunked")) return true;
  }
  return false;
}

/**
 * Answer one relayed request from the local board.
 *
 * Resolves when the response is fully handed over — immediately for an ordinary body, or when the
 * stream ends for one that streams. An SSE body never ends, so this promise is expected to stay
 * pending for as long as the visitor keeps the connection open.
 */
export function serveRelayRequest(frame: Extract<RelayDownFrame, { t: "req" }>, options: ServeOptions): Promise<void> {
  const target = new URL(frame.url);
  const local = new URL(options.origin);
  const publicUrl = new URL(options.publicOrigin);

  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of stripHopByHop(frame.headers)) headers[name] = value;
    // Present the request as the visitor's, not as loopback. See ServeOptions.publicOrigin.
    headers.host = publicUrl.host;

    const req = httpRequest(
      {
        host: local.hostname,
        port: local.port,
        path: `${target.pathname}${target.search}`,
        method: frame.method,
        headers,
        setHost: false,
      },
      (res) => {
        const outHeaders = Object.entries(res.headers).flatMap(([name, value]) =>
          value === undefined ? [] : Array.isArray(value) ? value.map((v) => [name, v] as [string, string]) : [[name, String(value)] as [string, string]],
        );
        const streaming = shouldStream(outHeaders);

        if (streaming) {
          options.send({ t: "res", id: frame.id, status: res.statusCode ?? 502, headers: outHeaders, end: false });
          res.on("data", (chunk: Buffer) => {
            // Chunked on the way out too: one oversized frame would be dropped by the relay rather
            // than delivered, and a silently truncated event stream is very hard to diagnose.
            for (let at = 0; at < chunk.length; at += RELAY_MAX_FRAME_BODY) {
              options.send({
                t: "res-chunk",
                id: frame.id,
                data: encodeBody(new Uint8Array(chunk.subarray(at, at + RELAY_MAX_FRAME_BODY))),
              });
            }
          });
          res.on("end", () => {
            options.send({ t: "res-end", id: frame.id });
            resolve();
          });
          res.on("error", () => {
            options.send({ t: "res-end", id: frame.id });
            resolve();
          });
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          if (body.byteLength <= RELAY_MAX_FRAME_BODY) {
            options.send({
              t: "res",
              id: frame.id,
              status: res.statusCode ?? 502,
              headers: outHeaders,
              ...(body.byteLength > 0 ? { body: encodeBody(new Uint8Array(body)) } : {}),
              end: true,
            });
            resolve();
            return;
          }
          // Too big for one frame, so it takes the streaming path instead of being dropped. This is
          // why there is one streaming implementation rather than a separate one for large bodies.
          options.send({ t: "res", id: frame.id, status: res.statusCode ?? 502, headers: outHeaders, end: false });
          for (let at = 0; at < body.byteLength; at += RELAY_MAX_FRAME_BODY) {
            options.send({
              t: "res-chunk",
              id: frame.id,
              data: encodeBody(new Uint8Array(body.subarray(at, at + RELAY_MAX_FRAME_BODY))),
            });
          }
          options.send({ t: "res-end", id: frame.id });
          resolve();
        });
        res.on("error", () => {
          options.send({ t: "res", id: frame.id, status: 502, headers: [], end: true });
          resolve();
        });
      },
    );

    req.on("error", (error) => {
      // The board is on the same machine, so this is almost always "it just went down". Answer rather
      // than leaving the visitor to time out, and say something they can act on.
      options.send({
        t: "res",
        id: frame.id,
        status: 502,
        headers: [["content-type", "text/plain; charset=utf-8"]],
        body: encodeBody(new TextEncoder().encode(`Frizz is not answering on this machine: ${error.message}`)),
        end: true,
      });
      resolve();
    });

    if (frame.body) req.write(Buffer.from(decodeBody(frame.body)));
    req.end();
  });
}

/**
 * Headers a WebSocket CLIENT owns and a relay must never replay.
 *
 * These describe the handshake being made now, not the one the visitor made with the relay. Replaying
 * the visitor's `Sec-WebSocket-Key` would answer the local handshake with an accept value computed for
 * somebody else's key, which a strict client rejects.
 */
const HANDSHAKE_HEADERS: ReadonlySet<string> = new Set([
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-accept",
  "sec-websocket-extensions",
]);

/**
 * Open the board's end of a visitor's terminal and link the two.
 *
 * The board's terminals are WebSockets, so without this a relayed board can be read but not worked in.
 * The visitor's socket lives in the relay; this one is local; every message is carried between them as
 * a frame. Returns a handle the caller drives when frames arrive for this session.
 *
 * THE VISITOR'S HEADERS ARE THE WHOLE POINT OF THIS FUNCTION'S SHAPE, and getting them wrong fails in
 * both directions. Frizz gates an upgrade on three of them together: the `Host` decides whether the
 * request arrived publicly and so whether the access gate applies at all, the `Origin` has to agree
 * with it, and the session cookie is what proves the visitor redeemed an access code. Forward none of
 * them and the board destroys the socket, because a browser always sends an Origin and this would not.
 * Forward the Host alone and it is far worse: the board would judge the request LOCAL and hand a shell
 * to anyone who found the name.
 */
export function serveRelayWebSocket(
  frame: Extract<RelayDownFrame, { t: "ws-open" }>,
  options: {
    origin: string
    publicOrigin: string
    send: (frame: RelayUpFrame) => void
    connect?: (url: string, headers: Record<string, string>) => WebSocketLike
  },
): NestedSession {
  const target = new URL(frame.url);
  const local = new URL(options.origin);
  const publicUrl = new URL(options.publicOrigin);
  target.protocol = local.protocol === "https:" ? "wss:" : "ws:";
  target.host = local.host;

  const headers: Record<string, string> = {};
  for (const [name, value] of stripHopByHop(frame.headers)) {
    if (!HANDSHAKE_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  // Present the upgrade as the visitor's, not as loopback. See the note above: this single line is
  // what puts the board's access gate in front of a relayed terminal.
  headers.host = publicUrl.host;

  const open =
    options.connect ??
    ((url: string, h: Record<string, string>) => new WsWebSocket(url, { headers: h }) as unknown as WebSocketLike);
  let socket: WebSocketLike;
  try {
    socket = open(target.toString(), headers);
  } catch (error) {
    options.send({ t: "ws-ack", id: frame.id, ok: false });
    return { message: () => {}, close: () => {}, failed: error instanceof Error ? error.message : String(error) };
  }

  let acked = false;
  socket.addEventListener("open", () => {
    acked = true;
    options.send({ t: "ws-ack", id: frame.id, ok: true });
  });
  socket.addEventListener("message", (event: { data: unknown }) => {
    if (typeof event.data === "string") options.send({ t: "ws-msg", id: frame.id, data: event.data });
  });
  const gone = () => {
    // If it never opened, the ack is a REFUSAL. Sending ok:true first and closing immediately after
    // would leave the visitor with a terminal that opened and then died for no stated reason.
    if (!acked) {
      acked = true;
      options.send({ t: "ws-ack", id: frame.id, ok: false });
      return;
    }
    options.send({ t: "ws-close", id: frame.id });
  };
  socket.addEventListener("close", gone);
  socket.addEventListener("error", gone);

  return {
    message: (data: string) => {
      try {
        socket.send(data);
      } catch {
        // The local terminal went away between frames; its close event will tell the relay.
      }
    },
    close: () => {
      try {
        socket.close();
      } catch {
        // Already gone.
      }
    },
  };
}

/** The bits of a WebSocket the agent uses. Node's global satisfies it. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

export interface NestedSession {
  message: (data: string) => void;
  close: () => void;
  failed?: string;
}

/** Serialize a frame for the socket. Exported so the connection loop and tests agree on encoding. */
export const encodeFrame = (frame: RelayUpFrame): string => serializeFrame(frame);
