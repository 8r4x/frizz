import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { resolveLocalImage } from "./local-image.ts"

test("a Windows image URL pathname reads the same file as either drive separator", { skip: process.platform !== "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "frizz-local-image-win-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "shot space %.png")
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
  writeFileSync(file, png)
  for (const path of [file, file.replaceAll("\\", "/"), decodeURIComponent(pathToFileURL(file).pathname), `/${file}`]) {
    assert.deepEqual(resolveLocalImage(path), { status: 200, contentType: "image/png", body: png })
  }
  const directory = join(root, "directory.png")
  mkdirSync(directory)
  assert.equal(resolveLocalImage(decodeURIComponent(pathToFileURL(directory).pathname)).status, 404)
  assert.equal(resolveLocalImage(decodeURIComponent(pathToFileURL(join(root, "missing.png")).pathname)).status, 404)
  assert.equal(resolveLocalImage("shot.png").status, 400)
  assert.equal(resolveLocalImage(file.replace(/\.png$/, ".txt")).status, 400)
})
