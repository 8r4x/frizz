import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRAY_DRAWER_COMPOSER_INSET_E2E_URL

test("thread drawer keeps the prompt box inset evenly while safe-area padding stays below lifecycle actions", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--force-color-profile=srgb"],
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  try {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/drawer-composer-footer-fixture.html`, { waitUntil: "networkidle0" })
    const measure = () => page.$eval("[data-thread-action-bar]", (actionBar) => {
      const composer = actionBar.querySelector<HTMLElement>("[data-surface=drawerFooterFixture]")?.closest<HTMLElement>(".group")
      const lifecycle = document.querySelector<HTMLElement>("[data-thread-lifecycle-footer]")
      const chatFooter = document.querySelector<HTMLElement>("[data-thread-chat-footer]")
      const ops = actionBar.querySelector<HTMLElement>("[data-background-ops]")
      if (!composer || !lifecycle || !chatFooter || !ops) throw new Error("drawer footer fixture is incomplete")
      const bar = actionBar.getBoundingClientRect()
      const box = composer.getBoundingClientRect()
      const lastRow = ops.lastElementChild as HTMLElement
      // The BOTTOM inset is optical, not box-equal: the last thing above the footer's hairline is a
      // line of text, and a row parks its baseline above its own box bottom by the line box's
      // half-leading, so a box-equal 12px reads as ~16px of air. Measure where the eye reads the row
      // ENDING — the baseline of its label — and hold THAT 12px off the bar's bottom edge, matching
      // the 12px above the composer's border. How much leading there is depends on the FONT, which is
      // why the correction is a font-switched custom property and why this runs under both modes.
      const label = [...lastRow.querySelectorAll<HTMLElement>("span")]
        .reverse()
        .find((span) => span.childNodes.length === 1 && span.firstChild?.nodeType === 3 && /\S/.test(span.textContent ?? ""))
      if (!label) throw new Error("the last ops row has no measurable label")
      const probe = document.createElement("span")
      probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
      label.appendChild(probe)
      const baseline = probe.getBoundingClientRect().bottom
      probe.remove()
      const lifecycleStyle = getComputedStyle(lifecycle)
      const chatFooterStyle = getComputedStyle(chatFooter)
      return {
        top: box.top - bar.top,
        right: bar.right - box.right,
        left: box.left - bar.left,
        // Rows hang TIGHT off the prompt box — deliberately less than the frame (see BackgroundOpsStrip
        // call sites): the column belongs to the composer, so it must not read as a separate block.
        hang: (ops.firstElementChild as HTMLElement).getBoundingClientRect().top - box.bottom,
        opticalBottom: bar.bottom - baseline,
        boxBottom: bar.bottom - lastRow.getBoundingClientRect().bottom,
        chatFooterBottom: chatFooterStyle.paddingBottom,
        lifecycleBottom: lifecycleStyle.paddingBottom,
      }
    })

    const inset = await measure()
    assert.deepEqual([inset.top, inset.right, inset.left], [12, 12, 12])
    assert.equal(inset.hang, 6, "the ops column hangs tight off the prompt box")
    assert.ok(
      Math.abs(inset.opticalBottom - 12) <= 0.5,
      `the last ops row's baseline sits 12px off the bar's bottom edge, matching the composer's own inset (got ${inset.opticalBottom})`,
    )
    assert.equal(inset.chatFooterBottom, "0px")
    assert.ok(Number.parseFloat(inset.lifecycleBottom) >= 8, "safe-area floor belongs below lifecycle actions")

    // The other font mode. The BOX gap must move (mono's baseline sits ~2px higher in the same line
    // box) while the OPTICAL one holds — that difference is the whole reason the correction is a
    // font-switched property rather than a Tailwind utility, and a single shared value fails here.
    await page.evaluate(() => { document.documentElement.dataset.font = "mono" })
    const mono = await measure()
    assert.ok(
      Math.abs(mono.opticalBottom - 12) <= 0.5,
      `the optical inset survives the mono font mode (got ${mono.opticalBottom})`,
    )
    assert.notEqual(mono.boxBottom, inset.boxBottom, "the box gap tracks the font, so the optical one need not")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
