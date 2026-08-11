import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here. Needs a REAL Frizz serving at least two projects, which
// `scripts/adhoc-stack.mjs` builds in one command:
//   nub scripts/adhoc-stack.mjs --port=45781 --project=/abs/a --also-project=/abs/b > /tmp/stack.log 2>&1 &
//   FRIZZ_PROJECT_SWITCH_E2E_URL=http://127.0.0.1:45781 nub --test --test-force-exit \
//     packages/web/src/lib/projectSwitch.e2e.test.ts
const baseUrl = process.env.FRIZZ_PROJECT_SWITCH_E2E_URL

// WHICH PROJECT THE LIVE FEED IS POINTED AT, after a client-side switch — the one thing no unit test
// here can reach. The pieces are all individually fine and were when this broke: `apiBase()` derives
// the right base from the path, `wsUrl()` derives from `apiBase()`, `rebindProject()` drops and
// re-opens correctly, and `<App/>` is keyed by slug so it genuinely remounts. The bug lived in the
// seam — routes.tsx guarded the rebind with a `useRef` seeded from the slug it was looking at, so any
// switch that changed which ROUTE matched (the grid to a board, which is what the grid's tiles do)
// mounted a FRESH component whose ref already said "bound", skipped the rebind entirely, and left the
// socket on the previous project. Every board then rendered the launching project's threads under
// another project's URL, and nothing but a document load recovered it (reported 2026-08-11).
//
// So this asserts the socket URL, not the render: it is the one artifact that says which project the
// board data is actually coming from, and it is recorded from `evaluateOnNewDocument` so the module-load
// connection is captured too.
test("switching projects from the grid re-points the live feed at the project the URL names", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await page.evaluateOnNewDocument(() => {
      const w = window as unknown as { __wsUrls: string[]; WebSocket: typeof WebSocket }
      w.__wsUrls = []
      const Native = w.WebSocket
      w.WebSocket = new Proxy(Native, {
        construct(target, args: [string, ...unknown[]]) {
          w.__wsUrls.push(String(args[0]))
          return Reflect.construct(target, args)
        },
      })
    })
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })

    const slugs = await page.evaluate(() =>
      [...document.querySelectorAll('a[href^="/project/"]')]
        .map((a) => a.getAttribute("href")!.split("/")[2]!)
        .filter((s, i, all) => all.indexOf(s) === i))
    assert.ok(slugs.length >= 2, `needs a stack serving ≥2 projects, saw: ${slugs.join(", ") || "none"}`)

    // The BOARD socket for a project, ignoring the per-thread terminal sockets (/term/:slug). Matched
    // with a regex rather than `endsWith("…")`, which frizzRouteUrls.test.ts reads as a hand-built
    // client URL — this only recognises one, it never constructs one.
    const isBoard = /\/ws$/
    const boardSocket = async () => (await page.evaluate(() =>
      (window as unknown as { __wsUrls: string[] }).__wsUrls))
      .filter((u) => isBoard.test(u)).at(-1)

    for (const slug of slugs.slice(0, 2)) {
      await page.evaluate((s) => {
        (document.querySelector(`a[href="/project/${s}"]`) as HTMLAnchorElement).click()
      }, slug)
      await page.waitForFunction((s) => location.pathname === `/project/${s}`, {}, slug)
      // The rebind is an effect + a socket open, so give the new one a moment to be constructed.
      await page.waitForFunction((s) =>
        ((window as unknown as { __wsUrls: string[] }).__wsUrls
          .filter((u) => /\/ws$/.test(u)).at(-1) ?? "").includes(`/_frizz/${s}/`), { timeout: 15_000 }, slug)
        .catch(() => {})
      assert.match(
        (await boardSocket()) ?? "",
        new RegExp(`/_frizz/${slug}/ws$`),
        `the board feed on /project/${slug} must address ${slug}, not whichever project it was last bound to`,
      )
      // …and the keyframe that feed delivers actually renders: the header resolves an identity rather
      // than sitting on its neutral placeholder, which is what a board bound to nothing looks like.
      await page.waitForFunction(() =>
        document.querySelector("[data-project-identity-state]")
          ?.getAttribute("data-project-identity-state") !== "loading", { timeout: 15_000 })
        .catch(() => assert.fail(`the board for ${slug} never resolved an identity`))
      await page.goBack({ waitUntil: "networkidle2" })
      await page.waitForFunction(() => location.pathname === "/")
    }
  } finally {
    await browser.close()
  }
})

// LEAVING BEFORE THE BOARD LANDS — the race the re-bind cannot win, because it is not a race about
// binding at all. Open a project, switch away inside ~60ms, and that project's board is still on the
// wire: its `rpc.board()` seed and its keyframe arrive at a store that the switch has just EMPTIED,
// which is precisely the state `seedBoard` treats as "nothing here yet, take it". Measured in a real
// browser (2026-08-11): without the ownership check in store.ts this paints the wrong project's header
// under the other project's URL — `/project/frizz` reading `colinhacks/zod` — and it is the shipped
// bug's twin, reached with the binding entirely correct.
test("a board still in flight from the project we just left never lands on this one", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })

    const slugs = await page.evaluate(() =>
      [...document.querySelectorAll('a[href^="/project/"]')]
        .map((a) => a.getAttribute("href")!.split("/")[2]!)
        .filter((s, i, all) => all.indexOf(s) === i))
    assert.ok(slugs.length >= 2, `needs a stack serving ≥2 projects, saw: ${slugs.join(", ") || "none"}`)
    const [a, b] = slugs as [string, string]

    // What each project's header says when it is the one being shown. The identity is `owner/repo` from
    // the git remote, so two projects in one stack normally differ; if they do not, this test cannot
    // tell them apart and says so rather than passing vacuously.
    const identityOf = async (slug: string) => {
      await page.evaluate((s) => {
        (document.querySelector(`a[href="/project/${s}"]`) as HTMLAnchorElement).click()
      }, slug)
      await page.waitForFunction(() =>
        document.querySelector("[data-project-identity-state]")
          ?.getAttribute("data-project-identity-state") !== "loading", { timeout: 15_000 })
      const label = await page.evaluate(() =>
        document.querySelector("[data-project-identity-state]")?.getAttribute("aria-label") ?? "")
      await page.goBack({ waitUntil: "networkidle2" })
      await page.waitForFunction(() => location.pathname === "/")
      return label
    }
    const identityA = await identityOf(a)
    const identityB = await identityOf(b)
    assert.notEqual(identityA, identityB, `${a} and ${b} render the same identity — pick two projects with different git remotes`)

    const frames = await page.evaluate(async (from: string, to: string) => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const seen: { path: string; who: string }[] = []
      let stop = false
      const tick = () => {
        const s = {
          path: location.pathname,
          who: document.querySelector("[data-project-identity-state]")?.getAttribute("aria-label") ?? "",
        }
        const prev = seen.at(-1)
        if (!prev || prev.path !== s.path || prev.who !== s.who) seen.push(s)
        if (!stop) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      const go = (slug: string) => (document.querySelector(`a[href="/project/${slug}"]`) as HTMLAnchorElement).click()
      go(from)
      await wait(60) // gone before the board it asked for can arrive
      history.back()
      await wait(40)
      go(to)
      await wait(3000)
      stop = true
      return seen
    }, b, a)

    const wrong = frames.filter((f) => f.path === `/project/${a}` && f.who === identityB)
    assert.deepEqual(wrong, [], `${b}'s board painted under /project/${a}: ${JSON.stringify(frames)}`)
    assert.equal(frames.at(-1)?.who, identityA, `/project/${a} must settle on its own board`)
  } finally {
    await browser.close()
  }
})
