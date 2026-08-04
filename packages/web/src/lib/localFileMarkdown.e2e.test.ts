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
      if (request.url().includes("/local-image?path=%2Ffixture%2Fshot.png")) {
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
        button: node.querySelector("button")?.getAttribute("data-local-path"),
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
      button: "/fixture/report.md",
      imageSrc: "/local-image?path=%2Ffixture%2Fshot.png",
      imagePath: "/fixture/shot.png",
      imageAlt: "descriptive alt",
      framedIn: "SPAN",
      frameInsideParagraph: true,
    })
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
