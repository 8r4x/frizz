import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadLifecycleFooter } from "./ThreadLifecycleFooter.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// THE EYE'S TOOLTIP, which was read once as `Watching 2 things / Shell: bzvtnt3ig / Shell: b8m0w8qjk`
// and produced exactly the wrong reading (maintainer 2026-08-14: "shells are not watchers… I don't see
// either of them as background shells underneath the prompt box"). Three separate defects sat in that
// one string, and these pin all three: it named a KIND where the wait belonged, it printed a handle that
// appears nowhere else in the UI, and it presented a watcher that can never fire as a live wait.

const base = {
  kind: "session",
  backend: "claude",
  title: "A worker",
  status: "active",
  runtime: "turn-idle",
  subAgents: [],
  foreign: false,
  state: "open",
  archived: false,
} as unknown as ThreadView

function footer(extra: Partial<ThreadView>): string {
  const thread = { ...base, id: "t", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadLifecycleFooter, { thread, sticky: true })),
    ),
  )
}

const watch = (over: Partial<ThreadView["watches"][number]> = {}) => ({
  id: "wch_1", kind: "shell" as const, target: "bzvtnt3ig", state: "armed" as const,
  createdAt: new Date(Date.now() - 34 * 60_000).toISOString(), seen: true, ...over,
})

test("no armed watcher ⇒ no eye at all", () => {
  assert.doesNotMatch(footer({ watches: [] }), /data-armed-watches/)
  assert.doesNotMatch(footer({ watches: [watch({ state: "fired" })] }), /data-armed-watches/)
})

// The row under the prompt box says "Running a larger spot-check batch"; the registry says `bzvtnt3ig`.
// They are the same shell, and printing the handle made them read as two unrelated things.
test("a shell watcher is named the way the strip under the prompt box names it", () => {
  const html = footer({
    watches: [watch()],
    bgShells: [{ label: "Running a larger spot-check batch", startedAt: new Date().toISOString(), state: "running", id: "toolu_01Mk", taskId: "bzvtnt3ig" }],
  })
  assert.match(html, /Shell: Running a larger spot-check batch/)
  assert.doesNotMatch(html, /bzvtnt3ig/, "the runtime handle is frizz's business, not the operator's")
})

// A shell watcher fires SEEN-THEN-GONE, so one whose target was never observed alive is wedged until the
// worker drops it. Saying "watching" and nothing else is the state the maintainer could not decode.
test("a watcher frizz has never seen alive says so instead of implying a live wait", () => {
  const html = footer({ watches: [watch({ seen: false })], bgShells: [] })
  assert.match(html, /never seen running, so this will not fire/)
})

test("a watcher that HAS been seen just names its target, however unresolvable", () => {
  const html = footer({ watches: [watch({ seen: true })], bgShells: [] })
  assert.match(html, /Shell: bzvtnt3ig/)
  assert.doesNotMatch(html, /will not fire/)
})

// The `github` kind shares this readout and has no registry row behind it. Labelling it `Shell:` was the
// literal category error in "shells are not watchers".
test("a PR watcher is never called a shell", () => {
  const html = footer({ watches: [watch({ id: "github:t:acme/app#391", kind: "github", target: "acme/app#391" })] })
  assert.match(html, /PR acme\/app#391/)
  assert.doesNotMatch(html, /Shell/)
})

test("the count is the number of WATCHERS, and each gets its own line", () => {
  const html = footer({ watches: [watch(), watch({ id: "wch_2", target: "b8m0w8qjk" })] })
  assert.match(html, /Watching 2 things/)
  assert.match(html, /data-armed-watches="2"/)
})
