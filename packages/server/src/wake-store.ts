import type { ProjectScope } from "./project-scope.ts"
import type Database from "./sqlite.ts"

export type WakeDeliveryState = "pending" | "leased" | "delivered" | "superseded" | "exhausted"

export interface WakeDeliveryInput {
  id: string
  slug: string
  sessionId: string
  fenceId: string
  hintKey: string
  message: string
  reason: string
}

export interface WakeDelivery extends WakeDeliveryInput {
  state: WakeDeliveryState
  attempts: number
  nextAttemptAt: number
  leaseOwner: string | null
  leaseUntil: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
  deliveredAt: number | null
  terminalAt: number | null
  /** When the wake was last handed to the worker's runtime and is awaiting confirmation — see
   *  `markSent`. Null while pending, and cleared by every fresh claim. */
  sentAt: number | null
}

interface WakeDeliveryRow {
  id: string
  thread_slug: string
  session_id: string
  fence_id: string
  hint_key: string
  message: string
  reason: string
  state: WakeDeliveryState
  attempts: number
  next_attempt_at: number
  lease_owner: string | null
  lease_until: number | null
  last_error: string | null
  created_at: number
  updated_at: number
  delivered_at: number | null
  terminal_at: number | null
  sent_at: number | null
}

export interface WakeDeliveryStore {
  enqueue(input: WakeDeliveryInput, now: number): { effect: "created" | "existing"; delivery: WakeDelivery }
  get(id: string): WakeDelivery | undefined
  list(): WakeDelivery[]
  listOpen(): WakeDelivery[]
  claim(owner: string, now: number, leaseUntil: number, maxAttempts: number): WakeDelivery | undefined
  deferFailure(id: string, owner: string, now: number, retryAt: number, error: string): boolean
  recoverExpired(id: string, now: number, retryAt: number, maxAttempts: number, error: string): WakeDelivery | undefined
  acknowledge(id: string, owner: string, now: number): boolean
  /** SENT, NOT DELIVERED. The transport accepted the wake (a socket frame with no reply), and whether the
   *  worker ever reads it is decided later — by the token showing up in its transcript, or by its
   *  process outliving `confirmUntil`. The row stays leased to the owner until then, so a dead process
   *  can send it round again instead of filing a lost wake as done. */
  markSent(id: string, owner: string, now: number, confirmUntil: number): boolean
  confirm(id: string, now: number): boolean
  supersede(id: string, now: number, reason: string): boolean
}

const OUTBOX_CAP = 2_000

function delivery(row: WakeDeliveryRow): WakeDelivery {
  return {
    id: row.id,
    slug: row.thread_slug,
    sessionId: row.session_id,
    fenceId: row.fence_id,
    hintKey: row.hint_key,
    message: row.message,
    reason: row.reason,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    terminalAt: row.terminal_at,
    sentAt: row.sent_at ?? null,
  }
}

/** The outbox table, idempotent; frizz-db.ts creates it ahead of a legacy import. */
export const WAKE_DELIVERY_TABLES = ["wake_delivery"] as const
export function ensureWakeDeliverySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wake_delivery (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      thread_slug     TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      fence_id        TEXT NOT NULL,
      hint_key        TEXT NOT NULL,
      message         TEXT NOT NULL,
      reason          TEXT NOT NULL,
      state           TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'delivered', 'superseded', 'exhausted')),
      attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at INTEGER NOT NULL,
      lease_owner     TEXT,
      lease_until     INTEGER,
      last_error      TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      delivered_at   INTEGER,
      terminal_at    INTEGER,
      sent_at        INTEGER,
      UNIQUE(project_id, thread_slug, session_id, fence_id)
    );
    CREATE INDEX IF NOT EXISTS wake_delivery_due
      ON wake_delivery(project_id, state, next_attempt_at, created_at);
  `)
}

export function createWakeDeliveryStore(scope: ProjectScope): WakeDeliveryStore {
  const db = scope.db
  ensureWakeDeliverySchema(db)

  const byId = scope.prepare<[string], WakeDeliveryRow>("SELECT * FROM wake_delivery WHERE project_id = @project_id AND id = ?")
  const all = scope.prepare<[], WakeDeliveryRow>("SELECT * FROM wake_delivery WHERE project_id = @project_id ORDER BY created_at, id")
  const open = scope.prepare<[], WakeDeliveryRow>(
    "SELECT * FROM wake_delivery WHERE project_id = @project_id AND state IN ('pending', 'leased') ORDER BY created_at, id",
  )
  const insert = scope.prepare(`
    INSERT INTO wake_delivery (
      project_id, id, thread_slug, session_id, fence_id, hint_key, message, reason, state, attempts,
      next_attempt_at, lease_owner, lease_until, last_error, created_at, updated_at,
      delivered_at, terminal_at
    ) VALUES (
      @project_id, @id, @slug, @sessionId, @fenceId, @hintKey, @message, @reason, 'pending', 0,
      @now, NULL, NULL, NULL, @now, @now, NULL, NULL
    )
    ON CONFLICT DO NOTHING
  `)
  const terminalCount = scope.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM wake_delivery WHERE project_id = @project_id AND state IN ('delivered', 'superseded', 'exhausted')",
  )
  const pruneTerminal = scope.prepare(`
    DELETE FROM wake_delivery WHERE project_id = @project_id AND id IN (
      SELECT id FROM wake_delivery
      WHERE project_id = @project_id AND state IN ('delivered', 'superseded', 'exhausted')
      ORDER BY terminal_at, created_at, id
      LIMIT ?
    )
  `)
  const due = scope.prepare<[number, number], WakeDeliveryRow>(`
    SELECT * FROM wake_delivery
    WHERE project_id = @project_id AND state = 'pending' AND next_attempt_at <= ? AND attempts < ?
    ORDER BY next_attempt_at, created_at, id
    LIMIT 1
  `)
  const claimStmt = scope.prepare(`
    UPDATE wake_delivery SET
      state = 'leased', attempts = attempts + 1, lease_owner = @owner, lease_until = @leaseUntil,
      last_error = NULL, sent_at = NULL, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state = 'pending' AND next_attempt_at <= @now AND attempts < @maxAttempts
  `)
  const deferFailureStmt = scope.prepare(`
    UPDATE wake_delivery SET
      lease_until = @retryAt, last_error = @error, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state = 'leased' AND lease_owner = @owner
  `)
  const markSentStmt = scope.prepare(`
    UPDATE wake_delivery SET
      sent_at = @now, lease_until = @confirmUntil, last_error = NULL, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state = 'leased' AND lease_owner = @owner
  `)
  const recoverExpiredStmt = scope.prepare(`
    UPDATE wake_delivery SET
      state = CASE WHEN attempts >= @maxAttempts THEN 'exhausted' ELSE 'pending' END,
      next_attempt_at = @retryAt,
      lease_owner = NULL,
      lease_until = NULL,
      last_error = @error,
      updated_at = @now,
      terminal_at = CASE WHEN attempts >= @maxAttempts THEN @now ELSE NULL END
    WHERE project_id = @project_id AND id = @id AND state = 'leased' AND lease_until <= @now
  `)
  const acknowledgeStmt = scope.prepare(`
    UPDATE wake_delivery SET
      state = 'delivered', lease_owner = NULL, lease_until = NULL, last_error = NULL,
      delivered_at = @now, terminal_at = @now, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state = 'leased' AND lease_owner = @owner
  `)
  const confirmStmt = scope.prepare(`
    UPDATE wake_delivery SET
      state = 'delivered', lease_owner = NULL, lease_until = NULL, last_error = NULL,
      delivered_at = @now, terminal_at = @now, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state IN ('pending', 'leased')
  `)
  const supersedeStmt = scope.prepare(`
    UPDATE wake_delivery SET
      state = 'superseded', lease_owner = NULL, lease_until = NULL, last_error = @reason,
      terminal_at = @now, updated_at = @now
    WHERE project_id = @project_id AND id = @id AND state IN ('pending', 'leased')
  `)

  const enqueueTxn = db.transaction((input: WakeDeliveryInput, now: number) => {
    const created = insert.run({ ...input, now }).changes === 1
    const row = byId.get(input.id)
    if (!row) throw new Error("wake delivery disappeared while it was being enqueued")
    if (
      row.thread_slug !== input.slug ||
      row.session_id !== input.sessionId ||
      row.fence_id !== input.fenceId ||
      row.hint_key !== input.hintKey ||
      row.message !== input.message ||
      row.reason !== input.reason
    ) {
      throw new Error(`wake delivery id collision for ${input.id}`)
    }
    const count = terminalCount.get()?.count ?? 0
    if (count > OUTBOX_CAP) pruneTerminal.run(count - OUTBOX_CAP)
    return { effect: created ? "created" as const : "existing" as const, delivery: delivery(row) }
  })

  const claimTxn = db.transaction((owner: string, now: number, leaseUntil: number, maxAttempts: number) => {
    const candidate = due.get(now, maxAttempts)
    if (!candidate) return undefined
    if (claimStmt.run({ id: candidate.id, owner, now, leaseUntil, maxAttempts }).changes !== 1) return undefined
    return delivery(byId.get(candidate.id)!)
  })

  return {
    enqueue: (input, now) => enqueueTxn.immediate(input, now),
    get: (id) => {
      const row = byId.get(id)
      return row ? delivery(row) : undefined
    },
    list: () => all.all().map(delivery),
    listOpen: () => open.all().map(delivery),
    claim: (owner, now, leaseUntil, maxAttempts) => claimTxn.immediate(owner, now, leaseUntil, maxAttempts),
    deferFailure: (id, owner, now, retryAt, error) => deferFailureStmt.run({
      id,
      owner,
      retryAt,
      error: error.slice(0, 500),
      now,
    }).changes === 1,
    recoverExpired: (id, now, retryAt, maxAttempts, error) => {
      if (recoverExpiredStmt.run({ id, now, retryAt, maxAttempts, error: error.slice(0, 500) }).changes !== 1) return undefined
      const row = byId.get(id)
      return row ? delivery(row) : undefined
    },
    acknowledge: (id, owner, now) => acknowledgeStmt.run({ id, owner, now }).changes === 1,
    markSent: (id, owner, now, confirmUntil) => markSentStmt.run({ id, owner, now, confirmUntil }).changes === 1,
    confirm: (id, now) => confirmStmt.run({ id, now }).changes === 1,
    supersede: (id, now, reason) => supersedeStmt.run({ id, now, reason: reason.slice(0, 500) }).changes === 1,
  }
}
