import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeLocalPath } from "./local-path.ts"

test("only Windows sheds a URL pathname's slash before a drive", () => {
  for (const path of ["C:/docs/plan.md", "d:\\docs\\plan.md"]) {
    assert.equal(normalizeLocalPath(`/${path}`, "win32"), path)
    assert.equal(normalizeLocalPath(path, "win32"), path)
    assert.equal(normalizeLocalPath(`/${path}`, "darwin"), `/${path}`)
    assert.equal(normalizeLocalPath(`/${path}`, "linux"), `/${path}`)
  }
  for (const path of ["/docs/plan.md", "//host/share/file.md", "relative.md", "/C:relative.md"]) {
    assert.equal(normalizeLocalPath(path, "win32"), path)
  }
})
