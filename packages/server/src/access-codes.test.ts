import assert from "node:assert/strict"
import test from "node:test"
import { AccessStore, DEFAULT_CODE_TTL_MS, secretsMatch } from "./access-codes.ts"

/** A clock the test drives, so expiry is exercised without sleeping through it. */
function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

function counter() {
  let n = 0
  return () => `token-${++n}`
}

test("a code works exactly once, and the second attempt says so", () => {
  // The property the whole design rests on. If a code can be spent twice, "single-use" is a comment.
  const store = new AccessStore({ randomToken: counter() })
  const { code } = store.issue()

  const first = store.redeem(code)
  assert.equal(first.ok, true)
  assert.ok(first.ok && first.session.length > 0)

  const second = store.redeem(code)
  assert.deepEqual(second, { ok: false, reason: "already-used" })

  // Consumed codes stop being offered, but are REMEMBERED so a replay is distinguishable from a typo.
  assert.deepEqual(store.outstanding(), [])
  assert.deepEqual(store.redeem("token-never-issued"), { ok: false, reason: "unknown" })
})

test("two redemptions of one code cannot both win", () => {
  // The race a naive check-then-set loses. Redeem is synchronous and marks consumed before returning,
  // so interleaving is impossible — this pins that rather than trusting it.
  const store = new AccessStore({ randomToken: counter() })
  const { code } = store.issue()
  const results = [store.redeem(code), store.redeem(code), store.redeem(code)]
  assert.equal(results.filter((r) => r.ok).length, 1, "exactly one redemption may succeed")
})

test("codes expire on a human timescale, because a photographed QR is a real vector", () => {
  const time = clock()
  const store = new AccessStore({ now: time.now, randomToken: counter() })
  const { code, expiresAt } = store.issue()
  assert.equal(expiresAt - time.now(), DEFAULT_CODE_TTL_MS)

  time.advance(DEFAULT_CODE_TTL_MS - 1)
  assert.equal(store.outstanding().length, 1, "still redeemable one millisecond before expiry")

  time.advance(2)
  assert.deepEqual(store.redeem(code), { ok: false, reason: "expired" })
  assert.deepEqual(store.outstanding(), [], "expired codes are swept, not left to accumulate")
})

test("issuing a code does not invalidate one already outstanding", () => {
  // Pressing the key twice, or two people asking at once, must not silently break the first QR.
  const store = new AccessStore({ randomToken: counter() })
  const first = store.issue()
  const second = store.issue()
  assert.notEqual(first.code, second.code)
  assert.equal(store.outstanding().length, 2)
  assert.equal(store.redeem(first.code).ok, true)
  assert.equal(store.redeem(second.code).ok, true)
})

test("a session verifies, expires on its own terms, and does not survive a restart", () => {
  const time = clock()
  const store = new AccessStore({ now: time.now, randomToken: counter(), sessionTtlMs: 10_000 })
  const redeemed = store.redeem(store.issue().code)
  assert.ok(redeemed.ok)
  const session = redeemed.session

  assert.equal(store.verifySession(session), true)
  time.advance(10_001)
  assert.equal(store.verifySession(session), false, "a session past its own expiry is refused")

  // A fresh process means a fresh signing key, so yesterday's cookie is not a way back in.
  const restarted = new AccessStore({ now: time.now, randomToken: counter() })
  assert.equal(restarted.verifySession(session), false)
})

test("a forged or tampered session is refused", () => {
  const store = new AccessStore({ randomToken: counter() })
  const redeemed = store.redeem(store.issue().code)
  assert.ok(redeemed.ok)
  const session = redeemed.session
  const [expiry, nonce, signature] = session.split(".")

  for (const forged of [
    undefined,
    "",
    "garbage",
    session.slice(0, -1),
    `${expiry}.${nonce}.${"A".repeat(signature!.length)}`,
    // The interesting one: push the expiry far out and keep the original signature.
    `${Number(expiry) + 10_000_000}.${nonce}.${signature}`,
  ]) {
    assert.equal(store.verifySession(forged), false, `accepted a forged session: ${String(forged)}`)
  }
})

test("consumption notifies, so a launcher can repaint a spent QR", () => {
  const seen: string[] = []
  const store = new AccessStore({ randomToken: counter(), onConsumed: (code) => seen.push(code) })
  const { code } = store.issue()
  store.redeem(code)
  store.redeem(code)
  assert.deepEqual(seen, [code], "fires on the successful redemption only")
})

test("secret comparison is length-safe and constant-time", () => {
  assert.equal(secretsMatch("abc", "abc"), true)
  assert.equal(secretsMatch("abc", "abd"), false)
  assert.equal(secretsMatch("abc", "abcd"), false, "different lengths must not throw")
  assert.equal(secretsMatch("", ""), true)
})
