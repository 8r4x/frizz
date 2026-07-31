// READ-ONLY PROBE: what the timeline renders for sub-agent dispatches/completions, with timestamps.
import { readFileSync } from "node:fs"
import { createTranscriptFold } from "./transcript.ts"
const fold = createTranscriptFold("claude")
fold.ingest(readFileSync(process.argv[2], "utf8"))
fold.finalize()
const since = process.argv[3] ?? "1970"
const msgs = fold.allMessages() as any[]
const rows: any[] = []
for (const m of msgs)
  for (const c of m.tools ?? [])
    if (c.name === "Agent" && (m.at ?? "") >= since)
      rows.push({ at: m.at, kind: c.agentCompletion ? "COMPLETION" : "dispatch  ", st: c.agentStatus ?? "-", id: c.agentId ?? "-", d: String(c.detail ?? "").slice(0, 46) })
for (const r of rows) console.log(r.at?.slice(11, 19), r.kind, String(r.st).padEnd(9), String(r.id).padEnd(19), r.d)
console.log("\ndispatch cards:", rows.filter((r) => r.kind === "dispatch  ").length, " completion markers:", rows.filter((r) => r.kind === "COMPLETION").length)
