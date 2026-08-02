// What is Claude Code actually DOING between accepting a mid-turn follow-up and delivering it?
//   nub scripts/steer-gap-anatomy.mjs [--days N] [--min 20]
//
// The census says operator prose sent mid-turn waits a median of ~14s with ~0 tool calls in the gap.
// Two very different worlds produce that number and they imply opposite fixes:
//   · ONE long tool call is in flight — the model cannot be sampled until it returns, so "next tool
//     boundary" is the floor and nothing but interrupting can beat it.
//   · The model is emitting work that this counter is missing — then there IS headroom.
// So dump the raw record sequence inside the slowest gaps, with the in-flight tool named.
import { readdirSync, statSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const days = Number(args[args.indexOf('--days') + 1]) || 14
const minGap = (Number(args[args.indexOf('--min') + 1]) || 20) * 1000
const since = Date.now() - days * 86_400_000
const HARNESS = /^(<task-notification>|<system-reminder>|<local-command|Your scratchpad is|\[Request interrupted)/
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)

const root = join(homedir(), '.claude', 'projects')
const files = []
for (const project of readdirSync(root)) {
  const dir = join(root, project)
  let names
  try { names = readdirSync(dir) } catch { continue }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    try { if (statSync(path).mtimeMs < since) continue } catch { continue }
    files.push(path)
  }
}

const found = []
for (const path of files) {
  const recs = []
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try { recs.push(JSON.parse(line)) } catch {}
  }
  const open = new Map()
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    if (rec.type === 'queue-operation' && rec.operation === 'enqueue' && rec.content) {
      const key = norm(rec.content)
      const list = open.get(key) ?? []; list.push(i); open.set(key, list)
      continue
    }
    if (rec.type === 'queue-operation' && rec.operation === 'remove' && rec.content) {
      const list = open.get(norm(rec.content)); if (list?.length) list.shift()
      continue
    }
    if (rec.type !== 'user' || rec.isMeta) continue
    const c = rec.message?.content
    let text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : ''
    if (!text) continue
    const key = norm(text)
    const list = open.get(key)
    if (!list?.length) continue
    const start = list.shift()
    if (HARNESS.test(key)) continue
    const gap = Date.parse(rec.timestamp) - Date.parse(recs[start].timestamp)
    if (!(gap >= minGap)) continue
    found.push({ path, start, end: i, gap, recs, key })
  }
}

found.sort((a, b) => b.gap - a.gap)
console.log(`${found.length} mid-turn operator sends with a gap ≥ ${minGap / 1000}s\n`)

for (const hit of found.slice(0, 8)) {
  const { recs, start, end, gap, key } = hit
  const t0 = Date.parse(recs[start].timestamp)
  console.log(`════ gap ${(gap / 1000).toFixed(1)}s  ${hit.path.split('/').pop().slice(0, 8)}  ${JSON.stringify(key.slice(0, 60))}`)
  // What tool, if any, was already running when the message was accepted?
  for (let j = start - 1; j >= 0 && j > start - 40; j--) {
    const r = recs[j]
    if (r.type !== 'assistant') continue
    const uses = Array.isArray(r.message?.content) ? r.message.content.filter((b) => b?.type === 'tool_use') : []
    if (!uses.length) break
    console.log(`   in flight at enqueue: ${uses.map((u) => u.name).join(', ')} (started ${((Date.parse(r.timestamp) - t0) / 1000).toFixed(1)}s relative)`)
    break
  }
  for (let j = start + 1; j < end; j++) {
    const r = recs[j]
    const dt = ((Date.parse(r.timestamp) - t0) / 1000).toFixed(1)
    if (r.type === 'assistant') {
      const c = r.message?.content
      const uses = Array.isArray(c) ? c.filter((b) => b?.type === 'tool_use') : []
      const thinking = Array.isArray(c) ? c.some((b) => b?.type === 'thinking') : false
      console.log(`   +${dt}s  assistant ${uses.length ? `tool_use: ${uses.map((u) => u.name).join(', ')}` : thinking ? 'thinking' : 'text'}`)
    } else if (r.type === 'user') {
      const c = r.message?.content
      const results = Array.isArray(c) ? c.filter((b) => b?.type === 'tool_result') : []
      console.log(`   +${dt}s  user ${results.length ? 'tool_result' : 'text'}`)
    } else {
      console.log(`   +${dt}s  ${r.type}${r.operation ? '/' + r.operation : ''}`)
    }
  }
  console.log(`   +${((Date.parse(recs[end].timestamp) - t0) / 1000).toFixed(1)}s  ◀ DELIVERED\n`)
}
