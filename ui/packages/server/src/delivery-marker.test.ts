import { test } from "node:test"
import assert from "node:assert/strict"
import {
  deliveryTag,
  encodeDeliveryMarker,
  decodeDeliveryMarkers,
  stripDeliveryMarkers,
  hasDeliveryMarker,
} from "./delivery-marker.ts"

const ID_A = "cc151fdd-c0aa-4587-8655-29deef22879f"
const ID_B = "9a2b7c10-1111-4222-8333-444455556666"

test("a marker round-trips its deliveryId", () => {
  const marked = "fix the bug" + encodeDeliveryMarker(ID_A)
  assert.deepEqual(decodeDeliveryMarkers(marked), [deliveryTag(ID_A)])
})

test("distinct ids get distinct tags, and a marker only decodes its own", () => {
  assert.notEqual(deliveryTag(ID_A), deliveryTag(ID_B))
  assert.deepEqual(decodeDeliveryMarkers("x" + encodeDeliveryMarker(ID_B)), [deliveryTag(ID_B)])
})

test("a glued submission yields every constituent's tag, in order", () => {
  const glued = "first send" + encodeDeliveryMarker(ID_A) + "\nsecond send" + encodeDeliveryMarker(ID_B)
  assert.deepEqual(decodeDeliveryMarkers(glued), [deliveryTag(ID_A), deliveryTag(ID_B)])
})

test("the marker is invisible: stripping restores the original text exactly", () => {
  const text = "> <tmp>: \"r\"\tno, but lossy vs intent\nWhy does this happen?"
  assert.equal(stripDeliveryMarkers(text + encodeDeliveryMarker(ID_A)), text)
})

test("stripping is a no-op on unmarked text (the overwhelmingly common case)", () => {
  const text = "an ordinary message with no marker at all"
  assert.equal(stripDeliveryMarkers(text), text)
  assert.equal(hasDeliveryMarker(text), false)
})

test("a marker survives the measured channel rewrites", () => {
  // The channel rewrites whitespace (tabs → spaces, CRLF → doubled newline) but leaves the marker's
  // codepoints alone — measured on a live claude 2.1.219 TUI. Encode/decode must agree under that.
  const sent = "col1\tcol2\r\nrow2" + encodeDeliveryMarker(ID_A)
  const recorded = sent.replace(/\r\n|\r/g, "\n\n").replace(/\t/g, "    ")
  assert.deepEqual(decodeDeliveryMarkers(recorded), [deliveryTag(ID_A)])
  assert.equal(stripDeliveryMarkers(recorded), "col1    col2\n\nrow2")
})

test("marker codepoints are NOT whitespace — the ledger can never mistake one for a space", () => {
  // Load-bearing: delivery-ledger collapses \s+ and delivery-confirm removes it entirely. If a marker
  // codepoint matched \s, a marked send and a clean one would compare equal by accident.
  assert.equal(/\s/.test(encodeDeliveryMarker(ID_A)), false)
})

test("a truncated or half-mangled marker decodes to nothing but still strips clean", () => {
  const half = ("body" + encodeDeliveryMarker(ID_A)).slice(0, -1) // lost the closing delimiter
  assert.deepEqual(decodeDeliveryMarkers(half), [])
  assert.equal(stripDeliveryMarkers(half), "body") // no visible residue for the human
})

test("a tag is stable across processes (no hash seed drift)", () => {
  assert.equal(deliveryTag("d-1"), deliveryTag("d-1"))
  assert.equal(deliveryTag(ID_A) >>> 0, deliveryTag(ID_A))
})
