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

test("the first verified board identity renders the repo, with a way back to the grid", () => {
  const html = render("openai/frizz", "open")

  assert.match(html, /data-project-identity-state="verified"/)
  assert.match(html, /aria-label="Project: openai\/frizz; connected"/)
  assert.match(html, /<span class="font-semibold text-fg\/90">frizz<\/span>/)
  // The home crumb is the reason the owner went: `home / owner / repo` had only two segments you
  // could actually go to, so the owner became chrome beside a real link.
  assert.match(html, /href="\/"/)
  assert.match(html, /aria-label="All projects"/)
  // It survives in the tooltip and the accessible label, so the identity is still discoverable.
  assert.doesNotMatch(html, />openai</)
  assert.match(html, /title="openai\/frizz"/)
  assert.doesNotMatch(html, /identity-placeholder/)
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
