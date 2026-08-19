import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { IdentityMark, projectIdentity } from "./Sidebar.tsx"

function board(projectLabel: string) {
  return { projectLabel }
}

function render(label: string | null, connection: "connecting" | "open" | "closed" = "connecting"): string {
  return renderToStaticMarkup(createElement(IdentityMark, {
    identity: projectIdentity(label === null ? null : board(label)),
    state: connection,
  }))
}

test("cold project loading reserves a quiet identity measure without guessing frizz", () => {
  const html = render(null)

  assert.match(html, /data-project-identity-state="loading"/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /aria-label="Project identity loading; connecting…"/)
  assert.match(html, /class="identity-placeholder" aria-hidden="true"/)
  assert.doesNotMatch(html, />frizz</)
  assert.doesNotMatch(html, /animate-/)
})

test("the verified board identity renders the repo, with the way back beside it", () => {
  const html = render("openai/frizz", "open")

  assert.match(html, /data-project-identity-state="verified"/)
  assert.match(html, /aria-label="Project: openai\/frizz; connected"/)
  assert.match(html, /<span class="font-semibold text-fg\/90">frizz<\/span>/)
  // NO OWNER. It is not somewhere you can go and it is not what tells you which board you are on —
  // the repo name is (maintainer 2026-08-06: hide it "regardless of whether the sidebar is hidden").
  assert.doesNotMatch(html, />openai</)
  // It survives where it costs nothing: the tooltip and the accessible label.
  assert.match(html, /title="openai\/frizz"/)
  // And with the rail hidden — the shipped default — the home crumb is the way back to the grid.
  assert.match(html, /aria-label="All projects"/)
  assert.doesNotMatch(html, /identity-placeholder/)
})

test("the home crumb steps aside when the project rail is showing", () => {
  const identity = projectIdentity(board("openai/frizz"))
  const html = renderToStaticMarkup(
    createElement(IdentityMark, { identity, state: "open" as const, railVisible: true }),
  )
  // Two ways back to the same page is one too many; the rail IS the way back when it is there.
  assert.doesNotMatch(html, /aria-label="All projects"/)
  assert.match(html, /<span class="font-semibold text-fg\/90">frizz<\/span>/)
})

test("a healthy connection paints no indicator at all", () => {
  // A green dot and the word "connected" led this cluster in every state until 2026-08-19, which meant
  // it said the same thing every second of every session (maintainer: "drop the connected indicator,
  // certainly. It's pretty useless"). The board moving IS the indicator now. The state still reaches
  // assistive technology through the aria-label, which is asserted above.
  const html = render("openai/frizz", "open")

  assert.doesNotMatch(html, />connected</)
  assert.doesNotMatch(html, /rounded-full/)
})

test("a DEGRADED connection still paints, because a silently frozen board is the failure it catches", () => {
  assert.match(render("openai/frizz", "connecting"), />connecting…</)
  assert.match(render("openai/frizz", "closed"), />disconnected</)
  // An open socket that had to fall back to SSE is degraded too — that is the whole point of naming it.
  const fallback = renderToStaticMarkup(createElement(IdentityMark, {
    identity: projectIdentity(board("openai/frizz")),
    state: "open" as const,
    boardFallback: { actualBytes: 9_000_000, maxBytes: 8_000_000 },
  }))
  assert.match(fallback, />connected · SSE fallback</)
  assert.match(fallback, /data-board-sync-fallback="true"/)
})

test("a reconnect retains the currently adopted verified identity", () => {
  // The app keeps its last adopted board while the stream reconnects; projectIdentity is deliberately
  // stateless, so passing that same board cannot flash a loading fallback.
  const identity = projectIdentity(board("openai/frizz"))
  const html = renderToStaticMarkup(createElement(IdentityMark, { identity, state: "connecting" }))

  assert.equal(identity.state, "verified")
  assert.match(html, /Project: openai\/frizz; connecting…/)
  assert.doesNotMatch(html, /identity-placeholder/)
})

test("a new boot or project has no retained identity and only accepts its own board", () => {
  const prior = projectIdentity(board("openai/old-project"))
  const freshBoot = projectIdentity(null)
  const replacement = projectIdentity(board("other-org/new-project"))

  assert.deepEqual(prior, { state: "verified", label: "openai/old-project", owner: "openai", repo: "old-project" })
  assert.deepEqual(freshBoot, { state: "loading" })
  assert.deepEqual(replacement, { state: "verified", label: "other-org/new-project", owner: "other-org", repo: "new-project" })
})

test("a repo with NO REMOTE shows its directory name, not the loading skeleton", () => {
  // `projectLabel` falls back to the directory basename when there is no origin remote, and this used
  // to fold into "unavailable" — which draws the cold placeholder. No keyframe was ever going to
  // resolve it into an owner/repo, so that skeleton stayed up for the life of the session (maintainer
  // 2026-08-19: "it just shows a skeleton forever"). It is a settled ANSWER, not a pending one.
  const identity = projectIdentity(board("scratch-pad"))
  const html = render("scratch-pad", "open")

  assert.deepEqual(identity, { state: "local", name: "scratch-pad" })
  assert.match(html, /data-project-identity-state="local"/)
  assert.match(html, /<span class="font-semibold text-fg\/90">scratch-pad<\/span>/)
  assert.doesNotMatch(html, /identity-placeholder/)
  // Not aria-busy, and the label says WHAT it is rather than that something is missing.
  assert.doesNotMatch(html, /aria-busy/)
  assert.match(html, /aria-label="Project: scratch-pad; local repository with no git remote; connected"/)
  // It still refuses to GUESS an owner — the identity carries a name and no owner/repo at all, which
  // the deepEqual above pins. (The only slash on screen is the home crumb's separator, below.)
  // That separator belongs to the NAME, so a local repo keeps `home / scratch-pad`.
  assert.match(html, /aria-label="All projects"/)
  assert.match(html, /class="-ml-1 shrink-0 text-muted\/60">\//)
})

test("only a keyframe with NOTHING nameable falls back to the placeholder", () => {
  // A broken server, not a project shape. The placeholder is honest here because something really is
  // missing — which is exactly what it stopped meaning while it also covered every remote-less repo.
  assert.deepEqual(projectIdentity({ projectLabel: "", projectName: "" }), { state: "unavailable" })
  // …and `projectName` is the second chance before it: the server always computes a basename.
  assert.deepEqual(projectIdentity({ projectLabel: "", projectName: "scratch-pad" }), { state: "local", name: "scratch-pad" })
})

test("long repository names remain truncatable and expose the full accessible identity", () => {
  const label = "an-owner-with-a-long-name/a-repository-name-that-needs-to-truncate-in-the-corner"
  const html = render(label, "open")

  assert.match(html, /class="block min-w-0 truncate"/)
  assert.match(html, new RegExp(`title="${label}"`))
  assert.match(html, new RegExp(`aria-label="Project: ${label}; connected"`))
})

test("the resolved identity and live status form one compact flexible cluster", () => {
  const html = render("openai/frizz", "open")

  assert.match(html, /class="identity-slot identity-slot--resolved"/)
  assert.doesNotMatch(html, /w-16/)
  assert.doesNotMatch(html, /identity-slot--placeholder/)
  // The status cluster's own measure is chosen by its CONTENT — reserving a fixed column left a
  // conspicuous blank track after owner/repo resolved. It renders only while degraded now, so a
  // healthy render is the one that must carry no track at all.
  assert.doesNotMatch(html, /class="flex items-center gap-1 shrink-0"/)
  assert.match(render("openai/frizz", "closed"), /class="flex items-center gap-1 shrink-0"/)
})

test("a board keyframe without a project label is unavailable, never a crash", () => {
  // The identity renders inside the SIDEBAR COLUMN now, above the prompt box — a throw here takes the
  // whole rail with it rather than one line of detached corner chrome. `projectLabel` is required on
  // the wire, so this guards only a partial keyframe, which is exactly the case that used to reach
  // `.trim()` of undefined.
  assert.deepEqual(projectIdentity({} as { projectLabel: string }), { state: "unavailable" })
  assert.deepEqual(projectIdentity({ projectLabel: "   " }), { state: "unavailable" })
})
