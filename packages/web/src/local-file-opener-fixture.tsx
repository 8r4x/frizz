import { createRoot } from "react-dom/client"
import "./styles.css"
import { mdToHtml } from "./lib/markdown.ts"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"
import { store } from "./store.ts"

// Both destinations a local-file link can have, on one page. A `.md` file is rendered by Frizz's own
// reader (the interceptor pushes a `markdown` drawer and never calls the RPC); anything else is handed
// to the desktop opener through `openLocalFile`. The two readouts below are what the e2e test asserts,
// so a regression in EITHER direction — a Markdown link that launches an editor, a PDF that silently
// opens a reader that cannot render it — fails loudly rather than looking fine in the markup.
//
// The page also carries the two destinations a worker WRITES rather than spells out: a project-relative
// path and a home-anchored one. Both used to stay relative hrefs, which the browser resolved against
// the thread page — clicking a handoff link navigated to `/thread/<slug>/.frizz/threads/<id>/HANDOFF.md`
// and out of the app. `baseDir`/`homeDir` are what useMarkdownHtml hands the renderer off the board.
const BASE_DIR = "/fixture"
const HOME_DIR = "/fixture/home"
type FixtureWindow = Window & {
  __localFileFixtureOpened?: string[]
  __localFileFixtureDrawers?: () => { kind: string; path?: string }[]
}

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href)
  if (url.pathname === "/_frizz/rpc/openLocalFile") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string }
    const w = window as FixtureWindow
    w.__localFileFixtureOpened = [...(w.__localFileFixtureOpened ?? []), body.path ?? ""]
    return new Response(JSON.stringify({ result: { action: "copy", path: body.path } }), {
      headers: { "content-type": "application/json", "x-frizz-boot": "local-file-fixture" },
    })
  }
  return nativeFetch(input, init)
}

;(window as FixtureWindow).__localFileFixtureDrawers = () =>
  store.drawers.map((d) => ({ kind: d.kind, path: d.path }))

installLocalFileLinkInterceptor()
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-xl p-8">
    <p className="mb-4 text-sm text-muted">Local artifact link fixture</p>
    <div
      className="md-body"
      dangerouslySetInnerHTML={{
        __html: mdToHtml([
          "Read the [review report](/fixture/report.md).",
          "",
          "Open the [signed contract](/fixture/contract.pdf).",
          "",
          "![descriptive alt](/fixture/shot.png)",
          "",
          "The write-up is in [`HANDOFF.md`](.frizz/threads/6d56ea2f/HANDOFF.md).",
          "",
          "The rules are in [`CLAUDE.md`](~/.claude/CLAUDE.md).",
        ].join("\n"), { baseDir: BASE_DIR, homeDir: HOME_DIR }),
      }}
    />
  </main>,
)
