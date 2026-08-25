import { request as httpRequest } from "node:http";
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

/** Serialize a frame for the socket. Exported so the connection loop and tests agree on encoding. */
export const encodeFrame = (frame: RelayUpFrame): string => serializeFrame(frame);
