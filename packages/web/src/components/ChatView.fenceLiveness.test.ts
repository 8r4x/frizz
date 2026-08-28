import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
const renderText = () => {
  const render = source.match(/const renderText = \([\s\S]*?\n {2}\}/)?.[0]
  assert.ok(render, "renderText must exist")
  return render
}

// An ```awaiting fence that is not a LIVE wait draws NOTHING — not the card, and not its prose. Two ways
// it stops being live: frizz REFUSED the park (the flag the server sets when it folds the correction out
// of the transcript, transcript.ts markFenceRefused), or the worker has SPOKEN since, which settles by
// construction whatever the fence named.
test("a fence that is not a live wait is skipped before it ever reaches a card", () => {
  assert.match(
    renderText(),
    /if \(fseg\.fenceKind === "awaiting" && \(m\.fenceRefused \|\| staleAwaiting \|\| restingCardShown\)\) continue/,
    "both non-live cases must be skipped, not rendered as an empty card",
  )
  // SKIPPED, not returned as null from the card: the block list is interleaved with explicit spacers, so
  // a slot that renders nothing still spends one.
  assert.ok(
    renderText().indexOf("staleAwaiting") < renderText().indexOf("<FenceCard"),
    "the skip must come before the push, so no block slot is spent on a fence that draws nothing",
  )
  // …and `done` is untouched: a finished thread stays finished, whatever frizz thought of its last park
  // and however long ago it was written.
  assert.doesNotMatch(renderText(), /(fenceRefused|staleAwaiting)[^\n]*"done"/)
})

// A LIVE FENCE THE RESTING CARD STATES IS SKIPPED THE SAME WAY. FenceCard returns null when the thread is
// at rest on the fence (the resting card opens on its body), but a null child is not a skipped block: the
// block list is interleaved with spacers, so the slot still spent its 14px — a gap dangling under the
// prose, above the resting card, on every rested awaiting thread (maintainer 2026-08-28, with a
// screenshot). So the owning surfaces pass `restingCardShown` and the block never reaches the card.
test("a fence the resting card states never reaches the card either", () => {
  // Every surface that owns a thread passes the flag for the LAST agent message only — the one whose
  // fence the resting card is about — so the memo boundary holds for every other row.
  const chat = source
  const todos = readFileSync(new URL("./TodosView.tsx", import.meta.url), "utf8")
  assert.equal(chat.match(/restingCardShown=\{(?:row\.)?messageIndex === lastAgentIdx && restingShown\}/g)?.length, 2, "both thread-view columns pass it")
  assert.equal(todos.match(/restingCardShown=\{globalIdx === lastAgentIdx && restingShown\}/g)?.length, 2, "both queue-card message paths pass it")
  // …and the emptiness walk agrees, or a fence-only last message keeps its spacer and its rest divider.
  const helper = source.match(/export function rendersNothingIn[\s\S]*?\n}/)?.[0]
  assert.ok(helper, "rendersNothingIn must exist")
  assert.match(helper, /restingCardShown = false/, "it takes the resting-card reason")
  assert.match(helper, /entry\.messageIndex === lastAgentIdx\) stale\.add\(entry\.message\)/, "…and folds the last message in")
  assert.equal(chat.match(/rendersNothingIn\([a-zA-Z]+, lastAgentIdx, restingShown\)/g)?.length, 3, "every rendersNothingIn call passes it")
  assert.match(todos, /const hidesAwaiting = \(idx: number\) => isStaleAwaiting\(idx\) \|\| \(idx === lastAgentIdx && restingShown\)/)
  assert.doesNotMatch(todos, /message(?:RendersNothing|HasRenderableText)\([a-z]+, isStaleAwaiting\(/, "the queue card's predicates take the union")
})

// A LIVE FENCE BESIDE AN OPEN REGISTERED QUESTION IS PROSE. The resting card already yields to an open
// question (server deriveAwaitingBackground), but the fence card in the message did not, so a worker that
// registered a question, kept working and fenced its next rest drew a parked-looking card — hourglass,
// shell table — on top of the ask (maintainer 2026-08-28: "Weird that there's both an awaiting block and
// open questions"). The body is the handoff and stays; the chrome goes, and the question is the one card.
test("a live fence beside an open registered question keeps its prose and loses its card", () => {
  const render = renderText()
  const asking = render.indexOf('fseg.fenceKind === "awaiting" && (thread?.questions?.length ?? 0) > 0')
  assert.notEqual(asking, -1, "the branch keys on the thread's OPEN registered questions — the same count the server's resting-card gate reads")
  // ORDER: a refused or settled fence draws nothing, question or not; a live one on an asking thread draws
  // its prose; only a live one on a thread with nothing open reaches the card.
  assert.ok(render.indexOf("restingCardShown)) continue") < asking, "the non-live skips come first")
  const card = render.indexOf("<FenceCard")
  assert.ok(asking < card, "…and the prose branch comes before the card")
  assert.match(render.slice(asking, card), /<ProseHtml[^>]*md=\{fseg\.body\}/, "the fence's BODY renders through the ordinary prose sheet")
  assert.match(render.slice(asking, card), /\n\s*continue\n/, "…and the block never reaches the card")
})

// THE TAIL MOUNTS WITH THE TRANSCRIPT, NOT BEFORE IT. The board lands first, so the queue card used to
// paint its resting/done/rested card under the "Loading…" line and then shove it down ~1s later when the
// messages mounted above it — the layout shift the maintainer refreshed into (2026-08-28).
test("the queue card holds its tail cards until the transcript window has loaded", () => {
  const todos = readFileSync(new URL("./TodosView.tsx", import.meta.url), "utf8")
  assert.match(todos, /\{!q\.isLoading && showsRestingCard\(thread\) && \(/)
  assert.match(todos, /\{!q\.isLoading && showsRegisteredDoneCard\(thread, /)
  assert.match(todos, /\{!q\.isLoading && showsRestedCard\(thread, /)
  // The thread view's eager branch is what renders while ITS window loads (count === 0 on both production
  // callers), and it drew the same chain alone at the top of an empty pane. Same hold, both halves of it —
  // the spacer gate and the chain — or the slot opens before the rung.
  assert.match(source, /const tailReady = !q\.isLoading/)
  assert.match(source, /\{tailReady && \(\(thread\?\.providerFault/, "the plain path's spacer gate waits for the transcript")
  assert.match(source, /\{!tailReady \? null : thread\?\.providerFault && !thread\.foreign \? \(/, "…and so does the chain it opens for")
})

// THE CARD NEVER LEARNS ABOUT STALENESS. It used to: a `stale` branch stripped the frame and printed the
// body as free-standing prose. That prose is what the whole block now drops with it, so a prop that can
// only mean "draw a settled card" would be a card shape that no longer exists.
test("FenceCard has no settled branch to fall into", () => {
  const card = source.match(/export function FenceCard\([\s\S]*?\n}/)?.[0]
  assert.ok(card, "FenceCard must exist")
  assert.doesNotMatch(card, /\bstale\b/, "a settled fence never reaches the card, so it takes no `stale` prop")
})

// The fence's prose has been BLOCK markdown since frontmatter landed (2026-08-17), but every body kept
// the `md-inline` class, which styles only code/strong/em/links — so a `<ul>` arrived with Tailwind's
// preflight reset still on it and a handoff's bullet list rendered as flat unmarked lines.
test("every awaiting-fence body renders through the block markdown sheet", () => {
  const card = source.match(/export function FenceCard\([\s\S]*?\n}/)?.[0]
  assert.ok(card, "FenceCard must exist")
  // Comments off first — the note explaining WHY the class moved names the old one, and an unstripped
  // match would be satisfied by that sentence rather than by the code.
  const code = card.replace(/^\s*\/\/.*$/gm, "")
  assert.doesNotMatch(code, /md-inline/, "a fence body is block markdown — md-inline gives its lists no markers")
})

// WHETHER A MESSAGE RENDERS AT ALL IS NOW POSITIONAL, and that is the part with teeth. The contract
// invites a worker to rest on the fence ALONE, so a whole message can be one awaiting fence and no prose
// — 99 of the 6,999 awaiting fences in this machine's transcripts are that shape. Once settled, such a
// message draws nothing, and every surface that walks the transcript has to agree: a predicate that still
// reports it visible spends an adjacency spacer on an empty slot and saves a rest divider with nothing
// under it, which is the exact bug the refused-fence strip was added for.
test("the empty-message predicates take the settled case", () => {
  for (const fn of ["messageRendersNothing", "messageHasRenderableText"]) {
    const re = new RegExp(`export function ${fn}\\(m: ChatMessage, staleAwaiting\\?: boolean\\)`)
    assert.match(source, re, `${fn} must accept the message's staleness`)
  }
  const blank = source.match(/function blankText\([\s\S]*?\n}/)?.[0]
  assert.ok(blank, "blankText must exist")
  assert.match(
    blank.replace(/^\s*\/\/.*$/gm, ""),
    /if \(!m\.fenceRefused && !staleAwaiting\) return !text\.trim\(\)/,
    "a settled fence must be stripped exactly as a refused one is",
  )
})

// ONE CUT, SHARED. The renderer marks a fence settled by comparing its index against the last assistant
// message; so must the spacer walk, or a message renders on one path and not the other. `rendersNothingIn`
// is how the position reaches a row builder that only takes `(message) => boolean`, and it keys on the
// message OBJECT because coalescing replaces that object when it absorbs a tool tail.
test("every transcript surface cuts staleness at the same index", () => {
  const scan = source.match(/export function lastAssistantIndex[\s\S]*?\n}/)?.[0]
  assert.ok(scan, "lastAssistantIndex must exist")
  // SAID, not "is the last assistant ROW". A `kind:"event"` line — rest, wake, compaction, sub-agent
  // completion — carries role:"assistant" and no utterance. Counting one puts the cut AFTER the fence it
  // protects, and since every rested thread ends with an "Agent rested" event that made EVERY live fence
  // read as settled: card and hourglass stripped off the one wait still open. That is the defect behind
  // the "light gray lines" reports, and restyling the body twice could never have fixed it.
  assert.match(scan, /messages\[i\]\.kind !== "event"/, "a synthetic event row is not the agent speaking")
  // Nobody re-derives it by hand — a second copy of the scan is how two surfaces' cuts drift apart.
  assert.equal(
    source.match(/for \(let i = messages\.length - 1; i >= 0; i--\) if \(messages\[i\]\.role === "assistant"/g)?.length,
    1,
    "the last-assistant scan must exist exactly once, inside lastAssistantIndex",
  )
  const helper = source.match(/export function rendersNothingIn[\s\S]*?\n}/)?.[0]
  assert.ok(helper, "rendersNothingIn must exist")
  assert.match(helper, /new WeakSet<ChatMessage>\(\)/, "it keys on the message object the entry holds")
  assert.match(helper, /entry\.messageIndex < lastAgentIdx/, "…cut at the same index the renderer uses")
  // Both transcript columns go through it; a bare `messageRendersNothing` handed to a row builder is the
  // regression — it cannot see position, so it reports a settled fence-only message as visible.
  assert.doesNotMatch(source, /\n\s+messageRendersNothing,\n/, "no row builder may take the position-blind predicate")
})

// THE FALLBACK IS THE RESTING CARD'S TABLE, NOT THE FENCE'S MACHINERY. A live fence whose thread is not
// at rest on it — mid-turn on a follow-up the human sent while the worker was still working, or woken by
// the very shell it named — reaches FenceCard rather than the resting card, and until 2026-08-28 that
// branch printed the fence's items as one muted line of runtime ids ("shell b7w140a81   for 45m"). A
// shell wait met it most, because a shell wait is the one that resumes mid-turn (maintainer 2026-08-27,
// with a screenshot: "for shells, I keep on seeing this fucking disgusting thing"). The board synthesizes
// the same watch rows whether or not the thread is idle, so the card draws the same table the resting
// card does, off the same thread.
test("the fallback fence card draws the wait table and never the raw ids", () => {
  const card = source.match(/export function FenceCard\([\s\S]*?\n}/)?.[0]
  assert.ok(card, "FenceCard must exist")
  const code = card.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  assert.match(code, /<AwaitingWaitTable thread=\{fenceThread\} divider \/>/, "the resting card's own table, off the same thread")
  assert.doesNotMatch(code, /awaitingItemLabels|awaitingForLabel|itemLabels|forLabel/, "no label line of ids and a duration")
  // A `prs:` entry that the table already rows as a github watch gets no chip as well — one PR, one place.
  assert.match(code, /const unrowed = watched\.filter\(\(w\) => !rowedRefs\.has\(w\.ref\)\)/)
  assert.doesNotMatch(code, /watched\.length|watched\[0\]|watched\.map/, "every chip site reads the unrowed set")
})
