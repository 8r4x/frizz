import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./ExternalTerminalCommand.tsx", import.meta.url)), "utf8")

test("copy command button acknowledges only on real success and renders both icon states", () => {
  // The check is driven from onSuccess (the clipboard write resolved), NOT optimistically on click —
  // otherwise the user pastes into the async race before the command has landed.
  assert.match(source, /function handleCopy\(\) \{\s*copy\(\{ onSuccess: \(\) => feedback\.current\?\.begin\(\) \}\)\s*\}/)
  assert.match(source, /copied\s*\? <Check[\s\S]*: <TerminalSquare/)
  assert.match(source, /useEffect\(\(\) => \(\) => feedback\.current\?\.dispose\(\), \[\]\)/)
  assert.match(source, /const label = copied \? "Provider resume command copied" : "Copy provider resume command"/)
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
