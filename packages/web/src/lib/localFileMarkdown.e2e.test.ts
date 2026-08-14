import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_LOCAL_FILE_MARKDOWN_E2E_URL

// A REAL 1x1 PNG. This used to be the 8-byte PNG signature alone, which is not a decodable image —
// Chrome fired `error` on it, lib/local-file-links.ts's missing-image handler (correctly) swapped the
// dead <img> for the plain path, and every assertion below read `undefined` off an element that was no
// longer there. The test had gone red on main before anyone noticed, because what it asserts is the
// markup, and the markup was fine. The bytes have to decode for this fixture to measure anything.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

test("Markdown local image syntax uses the gated image proxy and local files remain app actions", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      if (request.url().includes("/_frizz/local-image?path=%2Ffixture%2Fshot.png")) {
        void request.respond({ status: 200, contentType: "image/png", body: PIXEL_PNG })
      } else {
        void request.continue()
      }
    })
    await page.goto(`${baseUrl}/local-file-opener-fixture.html`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector('button[data-local-path="/fixture/report.md"]')
    const rendered = await page.$eval(".md-body", (node) => {
      const img = node.querySelector("img")
      return {
        buttons: [...node.querySelectorAll("button")].map((b) => b.getAttribute("data-local-path")),
        // The failure this whole page exists to catch is an anchor SURVIVING: a local path left as an
        // href is a same-origin URL, and one click leaves Frizz for a 404. Nothing here may be one.
        anchors: [...node.querySelectorAll("a")].map((a) => a.getAttribute("href")),
        imageSrc: img?.getAttribute("src"),
        imagePath: img?.getAttribute("data-local-path"),
        imageAlt: img?.getAttribute("alt"),
        // The picture is FRAMED, in the one frame every rendered image in the app sits in, and the
        // frame is built from spans so the paragraph marked wraps the image in survives the re-parse.
        framedIn: img?.closest(".md-image-frame")?.tagName,
        frameInsideParagraph: !!img?.closest("p"),
      }
    })
    assert.deepEqual(rendered, {
      // The last two are the reported bug: a path a worker wrote the way it typed it — relative to the
      // project, and home-anchored — has to arrive here as an absolute local-file button. Before the
      // rebase both stayed relative anchors the browser resolved against the PAGE.
      buttons: [
        "/fixture/report.md",
        "/fixture/contract.pdf",
        "/fixture/.frizz/threads/6d56ea2f/HANDOFF.md",
        "/fixture/home/.claude/CLAUDE.md",
      ],
      anchors: [],
      imageSrc: "/_frizz/local-image?path=%2Ffixture%2Fshot.png",
      imagePath: "/fixture/shot.png",
      imageAlt: "descriptive alt",
      framedIn: "SPAN",
      frameInsideParagraph: true,
    })

    // The ROUTING split, which the markup above deliberately cannot show: both links are the same
    // `data-local-path` button, and only the click decides where each one goes. A `.md` file is prose
    // Frizz renders ITSELF — it must push the reader drawer and never reach the desktop opener — while
    // any other local file must still be handed to the opener and open no drawer.
    await page.click('button[data-local-path="/fixture/report.md"]')
    await page.click('button[data-local-path="/fixture/contract.pdf"]')
    // And the rebased one routes by the SAME rule — the click handler never learns which syntax the
    // author used, only that the path it holds ends in `.md`.
    await page.click('button[data-local-path="/fixture/.frizz/threads/6d56ea2f/HANDOFF.md"]')
    const routed = await page.evaluate(() => ({
      opened: (window as unknown as { __localFileFixtureOpened?: string[] }).__localFileFixtureOpened ?? [],
      drawers: (window as unknown as { __localFileFixtureDrawers: () => unknown[] }).__localFileFixtureDrawers(),
    }))
    assert.deepEqual(routed, {
      opened: ["/fixture/contract.pdf"],
      drawers: [
        { kind: "markdown", path: "/fixture/report.md" },
        { kind: "markdown", path: "/fixture/.frizz/threads/6d56ea2f/HANDOFF.md" },
      ],
    })
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
