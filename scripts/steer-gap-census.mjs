// CENSUS over the maintainer's REAL Claude sessions: when a follow-up is handed to Claude Code while
// the worker is MID-TURN, how long does it sit queued, and how many tool calls run in that window?
//
//   nub scripts/steer-gap-census.mjs [--days N] [--project <substr>]
//
// The ground truth is the session JSONL. Claude Code writes `queue-operation`/`enqueue` the instant it
// accepts a follow-up, `queue-operation`/`remove` if something takes it back out, and `dequeue` +
// a `user` record when it actually delivers it into the conversation.
//
// TWO POPULATIONS, and mixing them hides the answer:
//   · IDLE sends   — the worker was at rest, enqueue and dequeue share a timestamp. These dominate by
//                    count and drag every percentile to zero.
//   · MID-TURN sends — the worker was working. This is the complaint's population, isolated here as
//                    "a tool_use ran between the enqueue and the dequeue, or the gap exceeded 1s".
// `<task-notification>` and other harness-generated wakes are reported separately from operator prose.
import { readdirSync, statSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const days = Number(args[args.indexOf('--days') + 1]) || 7
const projectFilter = args.includes('--project') ? args[args.indexOf('--project') + 1] : null
const since = Date.now() - days * 86_400_000

const root = join(homedir(), '.claude', 'projects')
const files = []
for (const project of readdirSync(root)) {
  if (projectFilter && !project.includes(projectFilter)) continue
  const dir = join(root, project)
  let names
  try { names = readdirSync(dir) } catch { continue }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    let st
    try { st = statSync(path) } catch { continue }
    if (st.mtimeMs < since) continue
    files.push({ project, path })
  }
}
console.log(`scanning ${files.length} session transcripts modified in the last ${days} day(s)\n`)

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
const HARNESS = /^(<task-notification>|<system-reminder>|<local-command|Your scratchpad is|\[Request interrupted)/
const samples = []
let removed = 0
let unmatched = 0

for (const { project, path } of files) {
  const queued = new Map() // normalized text → [{ ts, tools }]
  let toolUses = 0
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    const ts = Date.parse(rec.timestamp ?? '')
    if (rec.type === 'assistant') {
      const content = rec.message?.content
      if (Array.isArray(content)) toolUses += content.filter((b) => b?.type === 'tool_use').length
      continue
    }
    if (rec.type === 'queue-operation') {
      const key = norm(rec.content)
      if (!key) continue
      if (rec.operation === 'enqueue') {
        const list = queued.get(key) ?? []
        list.push({ ts, tools: toolUses })
        queued.set(key, list)
      } else if (rec.operation === 'remove') {
        const list = queued.get(key)
        if (list?.length) { list.shift(); if (!list.length) queued.delete(key); removed++ }
      }
      continue
    }
    if (rec.type === 'user' && !rec.isMeta) {
      const content = rec.message?.content
      let text = ''
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) text = content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
      if (!text) continue
      const key = norm(text)
      const list = queued.get(key)
      if (!list?.length) continue
      const open = list.shift()
      if (!list.length) queued.delete(key)
      if (!Number.isFinite(ts) || !Number.isFinite(open.ts)) continue
      samples.push({
        session: path.split('/').pop().slice(0, 8),
        gapMs: ts - open.ts,
        tools: toolUses - open.tools,
        harness: HARNESS.test(key),
        text: key.slice(0, 64),
      })
    }
  }
  for (const [, list] of queued) unmatched += list.length
}

const fmt = (ms) => ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`
const report = (label, rows) => {
  if (!rows.length) { console.log(`${label}: none\n`); return }
  const sorted = [...rows].sort((a, b) => a.gapMs - b.gapMs)
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  console.log(`${label}  (n=${sorted.length})`)
  for (const p of [0.5, 0.75, 0.9, 0.95, 0.99]) {
    const s = pick(p)
    console.log(`  p${String(p * 100).padStart(2)}  gap=${fmt(s.gapMs).padStart(7)}  tool calls in the gap=${String(s.tools).padStart(3)}`)
  }
  const worst = sorted.slice(-8).reverse()
  for (const s of worst) console.log(`   worst  ${fmt(s.gapMs).padStart(7)}  ${String(s.tools).padStart(3)} tools  ${s.session}  ${JSON.stringify(s.text.slice(0, 54))}`)
  console.log()
}

// MID-TURN: the worker was demonstrably busy — the queue held the message across at least one tool
// call, or across more than a second (an idle session dequeues in the same millisecond).
const midTurn = (s) => s.tools > 0 || s.gapMs >= 1_000
console.log(`${samples.length} enqueue→dequeue pairs matched; ${removed} taken back out with an explicit remove; ${unmatched} never matched\n`)
report('ALL sends', samples)
report('MID-TURN sends, operator prose', samples.filter((s) => midTurn(s) && !s.harness))
report('MID-TURN sends, harness wakes  ', samples.filter((s) => midTurn(s) && s.harness))
