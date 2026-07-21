import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./ExternalTerminalCommand.tsx", import.meta.url)), "utf8")

test("copy command button acknowledges only on real success and renders both icon states", () => {
  // The check is driven from a completed clipboard write, NEVER shown optimistically before it lands —
  // otherwise the user pastes into the race before the command is on the clipboard. WARM path: begin()
  // lives inside the writeText success branch. COLD fallback: begin() rides the async mutation's onSuccess.
  assert.match(source, /writeText\(command\)\.then\(\s*\(\) => \{\s*feedback\.current\?\.begin\(\)/)
  assert.match(source, /copyAsync\(\{ onSuccess: \(\) => feedback\.current\?\.begin\(\) \}\)/)
  assert.match(source, /copied\s*\? <Check[\s\S]*: <TerminalSquare/)
  assert.match(source, /useEffect\(\(\) => \(\) => feedback\.current\?\.dispose\(\), \[\]\)/)
  assert.match(source, /const label = copied \? "Provider resume command copied" : "Copy provider resume command"/)
})

test("the click writes a PREFETCHED command synchronously (no RPC inside the clipboard gesture)", () => {
  // The command is warmed into the query cache on hover/focus, so the click reads it synchronously and
  // writes without a round-trip in the activation window — the fix for the dead-in-a-queue-card copy and
  // the laggy check. Cold cache falls through to the activation-safe async path.
  assert.match(source, /onPointerEnter=\{prefetch\}/)
  assert.match(source, /onFocus=\{prefetch\}/)
  assert.match(source, /queryClient\.prefetchQuery\(\{\s*queryKey: terminalCommandKey\(slug\)/)
  assert.match(source, /const command = queryClient\.getQueryData<string>\(terminalCommandKey\(slug\)\)/)
  assert.match(source, /if \(command && navigator\.clipboard\?\.writeText\) \{/)
})

test("the confirmation check is the app foreground (white), not the live green", () => {
  assert.match(source, /<Check size=\{14\} strokeWidth=\{2\.2\} className="text-fg" \/>/)
  assert.doesNotMatch(source, /text-live/)
})

test("copy survives the async RPC by writing through the activation-safe ClipboardItem promise", () => {
  // A plain writeText AFTER awaiting the RPC loses the click's user activation; the ClipboardItem
  // promise form keeps it alive. writeText remains only as the fallback for engines without it.
  assert.match(source, /navigator\.clipboard\.write\(\[\s*new ClipboardItem\(\{ "text\/plain": commandPromise\.then/)
})
