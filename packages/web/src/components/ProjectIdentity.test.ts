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

test("a board without an owner/repo identity stays neutral rather than showing its directory name", () => {
  const identity = projectIdentity(board("frizz"))
  const html = render("frizz", "open")

  assert.deepEqual(identity, { state: "unavailable" })
  assert.match(html, /aria-label="Project identity unavailable; connected"/)
  assert.match(html, /identity-placeholder/)
  assert.doesNotMatch(html, />frizz</)
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
  assert.match(html, /class="flex items-center gap-1 shrink-0"/)
  assert.doesNotMatch(html, /w-16/)
  assert.doesNotMatch(html, /identity-slot--placeholder/)
})
