import assert from "node:assert/strict"
import test from "node:test"
import { encodeBody, parseFrame, serializeFrame } from "@frizz/shared"
import { BoardSocket, type SocketLike } from "./board-socket.ts"

/** A socket that records what the relay sent, so a fake board can answer it. */
function fakeSocket() {
  const sent: string[] = []
  let closed: number | undefined
  const socket: SocketLike = {
    send: (d) => void sent.push(d),
    close: (code) => { closed = code },
  }
  return {
    socket,
    sent,
    get closed() { return closed },
    lastId() {
      const frame = parseFrame(sent[sent.length - 1]!)
      return frame?.id ?? ""
    },
  }
}

const text = (s: string) => new TextEncoder().encode(s)

test("a request reaches the board and its answer comes back", async () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)

  const pending = relay.request({ method: "GET", url: "https://ada.frizz.sh/x", headers: [["accept", "*/*"]] })
  const sent = parseFrame(board.sent[0]!)
  assert.equal(sent?.t, "req")

  relay.handleFrame(serializeFrame({
    t: "res", id: board.lastId(), status: 200,
    headers: [["content-type", "text/plain"]], body: encodeBody(text("hi")), end: true,
  }))
  const response = await pending
  assert.equal(response.status, 200)
  assert.equal(new TextDecoder().decode(response.body!), "hi")
})

test("a STREAMED body reaches the visitor while it is still being produced", async () => {
  // This is the whole reason the head and the body are separate frames. Frizz's event feed is SSE: the
  // response never ends, so buffering until it does would mean the board never appears to load at all.
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)

  const chunks: string[] = []
  let ended = false
  const pending = relay.request(
    { method: "GET", url: "https://ada.frizz.sh/events", headers: [] },
    { push: (c) => chunks.push(new TextDecoder().decode(c)), end: () => { ended = true } }
  )
  const id = board.lastId()

  relay.handleFrame(serializeFrame({
    t: "res", id, status: 200, headers: [["content-type", "text/event-stream"]], end: false,
  }))
  const head = await pending
  assert.equal(head.status, 200, "the head resolves before the body is finished")
  assert.equal(ended, false)

  relay.handleFrame(serializeFrame({ t: "res-chunk", id, data: encodeBody(text("data: one\n")) }))
  relay.handleFrame(serializeFrame({ t: "res-chunk", id, data: encodeBody(text("data: two\n")) }))
  assert.deepEqual(chunks, ["data: one\n", "data: two\n"])
  assert.equal(ended, false, "an open stream must not be closed early")

  relay.handleFrame(serializeFrame({ t: "res-end", id }))
  assert.equal(ended, true)
})

test("a request with no board connected fails immediately rather than hanging", async () => {
  const relay = new BoardSocket()
  await assert.rejects(
    relay.request({ method: "GET", url: "https://ada.frizz.sh/", headers: [] }),
    /not connected/
  )
})

test("a board that disconnects fails everything in flight", async () => {
  // Otherwise every visitor waits out the full timeout for an answer that can never arrive.
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  const pending = relay.request({ method: "GET", url: "https://ada.frizz.sh/", headers: [] })
  relay.detach(board.socket)
  await assert.rejects(pending, /disconnected/)
  assert.equal(relay.connected, false)
})

test("a reconnect replaces the old socket and fails what was riding on it", async () => {
  const first = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(first.socket)
  const pending = relay.request({ method: "GET", url: "https://ada.frizz.sh/", headers: [] })

  const second = fakeSocket()
  relay.attach(second.socket)
  await assert.rejects(pending, /reconnected/)
  assert.equal(first.closed, 1000, "the stale socket is closed, not left open")
  assert.equal(relay.connected, true)
})

test("a stale socket closing later does not detach the live one", async () => {
  // The old socket's close event arrives AFTER the replacement is in place. Treating it as a detach
  // would tear down a board that had just successfully reconnected.
  const first = fakeSocket()
  const second = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(first.socket)
  relay.attach(second.socket)
  relay.detach(first.socket)
  assert.equal(relay.connected, true)
})

test("a request the board never answers times out", async () => {
  const board = fakeSocket()
  const fire: Array<() => void> = []
  const relay = new BoardSocket({
    requestTimeoutMs: 1,
    setTimer: (fn) => { fire.push(fn); return fire.length },
    clearTimer: () => {},
  })
  relay.attach(board.socket)
  const pending = relay.request({ method: "GET", url: "https://ada.frizz.sh/", headers: [] })
  fire[0]!()
  await assert.rejects(pending, /did not answer in time/)
})

test("hop-by-hop headers never reach the board", () => {
  const board = fakeSocket()
  const relay = new BoardSocket()
  relay.attach(board.socket)
  void relay.request({
    method: "GET", url: "https://ada.frizz.sh/", headers: [["Connection", "keep-alive"], ["X-Keep", "1"]],
  })
  const frame = parseFrame(board.sent[0]!) as { headers: Array<[string, string]> }
  assert.deepEqual(frame.headers, [["X-Keep", "1"]])
})

test("a late or unknown frame is ignored rather than throwing", () => {
  const relay = new BoardSocket()
  relay.attach(fakeSocket().socket)
  for (const raw of ['{"t":"res","id":"nope","status":200,"headers":[],"end":true}', "garbage", '{"t":"pong","id":"x"}']) {
    assert.doesNotThrow(() => relay.handleFrame(raw))
  }
})
