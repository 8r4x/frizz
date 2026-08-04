import { readFileSync, realpathSync, statSync } from "node:fs"
import { extname, isAbsolute } from "node:path"

const IMAGE_CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export type LocalImageResult =
  | { status: 400 | 404 }
  | { status: 200; contentType: string; body: Buffer }

// Screenshot paths in agent markdown can live anywhere on disk. This resolver is deliberately
// unconfined: the HTTP callers apply Frizz's loopback/origin gate before reaching it, while the
// extension allowlist, realpath, and regular-file check keep the response limited to image bytes.
export function resolveLocalImage(rawPath: string | undefined): LocalImageResult {
  if (!rawPath || !isAbsolute(rawPath)) return { status: 400 }

  const contentType = IMAGE_CONTENT_TYPE[extname(rawPath).toLowerCase()]
  if (!contentType) return { status: 400 }

  let real: string
  try {
    real = realpathSync(rawPath)
  } catch {
    return { status: 404 }
  }

  try {
    if (!statSync(real).isFile()) return { status: 404 }
    return { status: 200, contentType, body: readFileSync(real) }
  } catch {
    return { status: 404 }
  }
}
