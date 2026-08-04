// Proof that the BATCHED pane capture (tmux.capturePanes — one tmux invocation for the whole board,
// the fix for the tailer's per-thread capture storm) returns byte-identical text to the per-slug
// capturePane it replaces, and therefore cannot change a single perm-prompt verdict.
//
// This is the risk the batching introduces and the only one worth a harness: the tick's capture exists
// to detect an interactive permission prompt, so if the framed/split text differed from the individual
// capture by even a trailing newline, frizz could silently stop surfacing "this thread needs you".
// Real tmux, real panes painted with real modal captures, real functions — no fixtures.
//
// Also exercises the two failure modes the batch is built around:
//   • a target that does not exist ABORTS tmux's command list, so the map must simply be missing those
//     slugs (the tailer falls back per-slug) rather than returning wrong text for them;
//   • the retry rounds must still recover the panes that follow the dead one.
//
// Usage: nub scripts/verify-batched-pane-capture.mjs   (exit 0 = all green)
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { matchesPermPrompt } from "../packages/server/src/tailer.ts"
import { capturePane, capturePanes, setSocket } from "../packages/server/src/tmux.ts"

const socket = `batchcap-${randomUUID().slice(0, 8)}`
const work = mkdtempSync(join(tmpdir(), "batchcap-"))
setSocket(socket)
const tmux = (...a) => execFileSync("tmux", ["-L", socket, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}

// A genuine tool-approval modal, verbatim from a disposable claude session — the shape the tick MUST
// keep detecting through the batched path.
const MODAL = [
  " Bash command",
  "   touch approved-me.txt",
  "   Create an empty file called approved-me.txt",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to repro/ from this project",
  "   3. No",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n")

// An ordinary working pane: a composer, plus transcript text that QUOTES a prompt. Must stay negative.
const WORKING = [
  "  I'm about to run a command. Do you want to proceed? — I'll ask via the real prompt.",
  "─".repeat(120),
  "❯ ",
  "─".repeat(120),
  "  repro · main · Opus 4.8 · 17%",
  "  accept edits on · ← 3 agents",
].join("\n")

const paint = (slug, screen) => {
  const file = join(work, `${slug}.txt`)
  writeFileSync(file, `${screen}\n`)
  tmux("new-session", "-d", "-s", `frizz-${slug}`, "-x", "200", "-y", "50", "--", "sh", "-c", `cat ${file}; sleep 60`)
}

try {
  const painted = [
    ["batch-one", WORKING],
    ["batch-two", MODAL],
    ["batch-three", WORKING],
    ["batch-four", MODAL],
  ]
  for (const [slug, screen] of painted) paint(slug, screen)
  execFileSync("sleep", ["0.6"]) // let `cat` finish painting every pane

  const slugs = painted.map(([slug]) => slug)
  const batched = capturePanes(slugs)
  check("every requested pane is in the batch", batched.size === slugs.length, `${batched.size}/${slugs.length}`)

  for (const slug of slugs) {
    const single = capturePane(slug)
    const fromBatch = batched.get(slug) ?? ""
    check(`${slug}: batched text is byte-identical to the per-slug capture`, fromBatch === single,
      fromBatch === single ? undefined : `single=${JSON.stringify(single.slice(0, 60))} batch=${JSON.stringify(fromBatch.slice(0, 60))}`)
    check(`${slug}: perm-prompt verdict is unchanged`, matchesPermPrompt(fromBatch) === matchesPermPrompt(single),
      `verdict=${matchesPermPrompt(single)}`)
  }
  // The verdicts themselves must still be right, or "identical" would just mean identically broken.
  check("a real modal is still detected through the batch", matchesPermPrompt(batched.get("batch-two") ?? "") === true)
  check("a working pane quoting a prompt is still NOT detected", matchesPermPrompt(batched.get("batch-one") ?? "") === false)

  // A dead target aborts tmux's command list. The map must omit it (and, thanks to the retry rounds,
  // still carry the panes that come after it) — never mis-attribute one pane's text to another slug.
  const withGhost = capturePanes(["batch-one", "batch-ghost-not-a-session", "batch-three", "batch-four"])
  check("a missing session is simply absent from the map", !withGhost.has("batch-ghost-not-a-session"))
  check("panes AFTER the missing one are still recovered by the retry rounds",
    withGhost.has("batch-three") && withGhost.has("batch-four"),
    `keys=${[...withGhost.keys()].join(",")}`)
  check("recovered text is still correct after a truncated round",
    withGhost.get("batch-four") === capturePane("batch-four"))

  const empty = capturePanes([])
  check("an empty request spawns nothing and returns an empty map", empty.size === 0)
} finally {
  try { tmux("kill-server") } catch {}
  rmSync(work, { recursive: true, force: true })
}

const failed = results.filter((ok) => !ok).length
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed}/${results.length} CHECKS FAILED`)
process.exit(failed === 0 ? 0 : 1)
