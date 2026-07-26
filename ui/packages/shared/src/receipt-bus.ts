// A typed bus of short-lived RUNTIME MILESTONES — "the ingest folded this event", "the tailer
// re-read this session", "the turn settled" — published by production code and awaited by tests and
// harnesses. Ported in plain TS from t3code's
// apps/server/src/orchestration/Services/RuntimeReceiptBus.ts, and it carries that file's central
// caveat verbatim: receipts are NOT part of the production event model. Nothing user-facing may read
// one. They exist so an integration test can await the exact instant a milestone happened instead of
// inferring it from persisted state or sleeping until it's probably true.
//
// Every receipt is stamped with a monotonic sequence, and the last `backlog` receipts are retained.
// That backlog is what makes `waitFor` safe against the classic race — the milestone lands between
// the action and the await, and the test hangs until its timeout for something that already happened.
// Capture `cursor()` BEFORE the action, pass it as `since`, and a receipt published in that window is
// still matched.
//
// `waitFor` with no `since` deliberately defaults to the cursor AT CALL TIME (future-only) rather
// than scanning the whole backlog: a wait that can be satisfied by a receipt from an earlier phase of
// the same test is a test that passes for the wrong reason.

export interface Receipt {
  readonly type: string
}

export interface ReceiptBusOptions {
  /** How many past receipts stay matchable via `since`. Default 512. */
  backlog?: number
}

export interface WaitForOptions {
  /** Only match receipts published after this cursor. Default: `cursor()` at call time. */
  since?: number
  /** Reject if unmatched for this long. Default 5000 ms. */
  timeoutMs?: number
  /** Included in the timeout error so a hung wait names itself. */
  label?: string
}

export interface ReceiptBus<T extends Receipt> {
  publish(receipt: T): void
  subscribe(listener: (receipt: T, seq: number) => void): () => void
  /** Sequence of the most recent receipt. Capture before an action, pass as `waitFor`'s `since`. */
  cursor(): number
  waitFor(predicate: (receipt: T) => boolean, options?: WaitForOptions): Promise<T>
  /** Convenience for the overwhelmingly common `r.type === type` case. */
  waitForType<K extends T["type"]>(type: K, options?: WaitForOptions): Promise<Extract<T, { type: K }>>
  /** Retained receipts, oldest first — for a failure message that shows what DID arrive. */
  recent(): ReadonlyArray<{ seq: number; receipt: T }>
  close(): void
}

export function createReceiptBus<T extends Receipt>(options: ReceiptBusOptions = {}): ReceiptBus<T> {
  const backlogMax = options.backlog ?? 512
  const backlog: Array<{ seq: number; receipt: T }> = []
  const listeners = new Set<(receipt: T, seq: number) => void>()
  let seq = 0
  let closed = false

  return {
    publish(receipt) {
      if (closed) return
      const entry = { seq: ++seq, receipt }
      backlog.push(entry)
      if (backlog.length > backlogMax) backlog.shift()
      // A listener that throws is the listener's problem, never the publisher's: production code
      // publishes receipts on the hot path and must not be destabilized by a test's assertion.
      for (const listener of [...listeners]) { try { listener(receipt, entry.seq) } catch { /* isolated */ } }
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    cursor: () => seq,

    waitFor(predicate, waitOptions = {}) {
      const since = waitOptions.since ?? seq
      const timeoutMs = waitOptions.timeoutMs ?? 5_000
      for (const entry of backlog) {
        if (entry.seq > since && predicate(entry.receipt)) return Promise.resolve(entry.receipt)
      }
      if (closed) return Promise.reject(new Error(`receipt bus closed while waiting for ${waitOptions.label ?? "a receipt"}`))
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe()
          const saw = backlog.filter((e) => e.seq > since).map((e) => e.receipt.type)
          reject(new Error(
            `timed out after ${timeoutMs}ms waiting for ${waitOptions.label ?? "a receipt"}; ` +
            `saw since cursor ${since}: [${saw.join(", ") || "nothing"}]`,
          ))
        }, timeoutMs)
        timer.unref?.()
        const unsubscribe = this.subscribe((receipt) => {
          if (!predicate(receipt)) return
          clearTimeout(timer)
          unsubscribe()
          resolve(receipt)
        })
      })
    },

    waitForType(type, waitOptions) {
      return this.waitFor((r) => r.type === type, { label: type, ...waitOptions }) as Promise<Extract<T, { type: typeof type }>>
    },

    recent: () => backlog.map((e) => ({ seq: e.seq, receipt: e.receipt })),

    close() {
      closed = true
      listeners.clear()
      backlog.length = 0
    },
  }
}
