// A serial queue worker that exposes `drain()` — the signal that resolves once the queue is EMPTY
// *and* the item currently in flight has finished. Ported (in plain TS; the original is Effect) from
// t3code's packages/shared/src/DrainableWorker.ts, whose whole reason for existing is the one this
// file inherits: a test that wants "the runtime has finished reacting to what I just sent" otherwise
// has to `sleep(200)` and hope. A sleep is either flaky or slow, and usually both.
//
// The invariant that makes it trustworthy: the outstanding count is incremented INSIDE `enqueue`,
// before the item is visible to the pump, and decremented only after `process()` settles. So there is
// no window where an item is queued but uncounted, and `drain()` can never resolve across it.
//
// Errors are contained: a `process()` rejection is reported to `onError` (default: swallow) and never
// stalls the pump or rejects a drain waiter. This is a telemetry-path worker — one bad item must not
// wedge the queue.

export interface DrainableWorkerOptions {
  /** Observe a rejected `process()` call. Default: swallow. Never throws back into the pump. */
  onError?: (error: unknown) => void
}

export interface DrainableWorker<A> {
  /** Enqueue an item. Returns immediately; the item is counted for `drain()` before this returns. */
  enqueue(item: A): void
  /** Resolves when the queue is empty and nothing is in flight. Resolves immediately when idle. */
  drain(): Promise<void>
  /** Items queued or in flight right now. */
  outstanding(): number
  /**
   * Stop the pump and discard anything still queued. In-flight work is NOT cancelled (there is
   * nothing to cancel it with) but its completion no longer feeds the queue. Pending `drain()`
   * waiters resolve, because after a close nothing more will ever be processed.
   */
  close(): void
}

export function createDrainableWorker<A>(
  process: (item: A) => void | Promise<void>,
  options: DrainableWorkerOptions = {},
): DrainableWorker<A> {
  const queue: A[] = []
  let inFlight = 0
  let pumping = false
  let closed = false
  const waiters: Array<() => void> = []

  const settle = (): void => {
    if (queue.length > 0 && !closed) return
    if (inFlight > 0 && !closed) return
    while (waiters.length) waiters.shift()!()
  }

  const pump = async (): Promise<void> => {
    if (pumping) return
    pumping = true
    try {
      while (!closed && queue.length > 0) {
        const item = queue.shift()!
        inFlight++
        try {
          await process(item)
        } catch (error) {
          options.onError?.(error)
        } finally {
          inFlight--
        }
      }
    } finally {
      pumping = false
      settle()
    }
  }

  return {
    enqueue(item) {
      if (closed) return
      queue.push(item)
      // Deliberately not awaited: enqueue is a fire-and-forget from the caller's perspective, and the
      // pump's own rejection path is already contained above. `void` documents that.
      void pump()
    },
    drain() {
      if (closed || (queue.length === 0 && inFlight === 0)) return Promise.resolve()
      return new Promise<void>((resolve) => { waiters.push(resolve) })
    },
    outstanding: () => queue.length + inFlight,
    close() {
      closed = true
      queue.length = 0
      settle()
    },
  }
}
