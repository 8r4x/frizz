// Turn a `codex` binary setting — a bare name, an absolute provisioned path, or nothing — into an
// argv PREFIX that `spawn`/`execFile` can run without a shell on every platform.
//
// The Claude side has the same resolver (claude-broker-host.ts resolveClaudeExecutableAbsolute) and
// the same reason for it: on Windows a bare name only reaches a real `.exe`. `npm i -g @openai/codex`
// writes THREE files into the bin dir — `codex` (a `#!/bin/sh` script), `codex.cmd` and `codex.ps1` —
// and libuv's PATH search appends only `.com`/`.exe`, so spawn("codex") is ENOENT, spawn("codex.cmd")
// is EINVAL (node refuses .cmd/.bat without a shell since CVE-2024-27980), and the ConPTY that ran
// sign-in until 2026-09-24 found neither. Every reader that probed the bare name — the dispatch preflight's
// `codex --version`, the quota chip's `codex app-server`, the sign-in pane's `codex login` — therefore
// read an installed Codex as "not installed" whenever the runtime pin had fallen back to PATH
// (Windows audit 2026-09-11, finding 8).
//
// Codex differs from Claude in WHAT the `.cmd` shim calls. Claude's shim calls a native `claude.exe`;
// Codex's npm bin is a JS launcher (`bin/codex.js`, read from @openai/codex@0.154.0 on 2026-09-11)
// that locates the native binary at `vendor/<triple>/bin/codex.exe` inside the platform package
// (`@openai/codex-win32-x64` / `-arm64`, an npm alias of `@openai/codex@<v>-win32-<arch>`) and, in the
// older layout, inside the package's own `vendor/`. So the resolution order on Windows is:
//
//   1. a real `codex.exe` on PATH (a standalone install, or the provisioned pin passed absolute);
//   2. the `.cmd` shim, followed to its target — and when that target is the JS launcher, the native
//      `codex.exe` beside it, run DIRECTLY: one process, so a caller's kill lands on codex itself
//      rather than on a node wrapper that would leave it orphaned (on win32 `kill` is TerminateProcess
//      and forwards nothing);
//   3. the JS launcher as `[process.execPath, codex.js]` when the vendored binary is not where the
//      launcher of that version puts it — a layout change costs one extra process, not the feature.
//
// Pure over its injected environment so a table of Windows layouts can be pinned on the machines that
// actually run this suite; the defaults read the real process and filesystem. Path arithmetic follows
// the INJECTED platform (path.win32 under "win32"), not the host's, for the same reason.
import { accessSync, constants as fsConstants, readFileSync } from "node:fs"
import { posix, win32 } from "node:path"

/** What to run: `file` plus the argv that must precede the caller's own arguments. */
export interface CodexExecutable {
  file: string
  args: string[]
}

export interface CodexExecutableDeps {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  /** The node that runs the JS launcher when no native binary is found beside it. */
  execPath?: string
  /** Does `path` exist ("exists"), or exist and carry the execute bit ("executable")? */
  access?: (path: string, mode: "exists" | "executable") => boolean
  /** The text of a `.cmd` shim, or undefined when it cannot be read. */
  readFile?: (path: string) => string | undefined
}

/** Raised when nothing on PATH resolves. Carries `code: "ENOENT"` so a caller that classifies spawn
 *  errors (auth-status's "missing ONLY on a positive ENOENT") reads it as the same positive miss the
 *  OS would have reported for a bare name on POSIX. */
export class CodexExecutableNotFoundError extends Error {
  readonly code = "ENOENT"
  constructor(candidate: string) {
    super(`could not resolve '${candidate}' to an executable on PATH`)
    this.name = "CodexExecutableNotFoundError"
  }
}

// npm's cmd-shim writes the target quoted and immediately followed by ` %*`, in both of its shapes:
//   "%dp0%\node_modules\@openai\codex\bin\codex.js" %*      (a shebang'd JS bin, via "%_prog%")
//   "%dp0%\codex.exe"   %*                                   (a non-script bin)
// The `IF EXIST "%dp0%\node.exe"` line also mentions %dp0%, which is why the trailing `%*` is part of
// the match rather than the line start (the JS form's target sits mid-line after `endLocal & …`).
const WINDOWS_SHIM_TARGET = /"%dp0%\\([^"]+)"\s+%\*/u

const WINDOWS_TRIPLE: Record<string, string> = {
  x64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
}

function defaultAccess(path: string, mode: "exists" | "executable"): boolean {
  try {
    accessSync(path, mode === "executable" ? fsConstants.X_OK : fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function defaultReadFile(path: string): string | undefined {
  try { return readFileSync(path, "utf8") } catch { return undefined }
}

/** The search path under whatever name this environment spells it — `Path` on Windows, and a plain
 *  copy of `process.env` (which is what the bridge hands around) has no `PATH` key at all there. */
function searchPath(env: NodeJS.ProcessEnv): string {
  const direct = env.PATH ?? env.Path ?? env.path
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === "path") return value ?? ""
  return ""
}

/** The native binary the JS launcher of this version would run, if it is where that launcher looks. */
function vendoredNativeBeside(launcherJs: string, arch: string, access: NonNullable<CodexExecutableDeps["access"]>): string | undefined {
  const triple = WINDOWS_TRIPLE[arch]
  if (!triple) return undefined
  const { dirname, join } = win32
  const pkgRoot = dirname(dirname(launcherJs)) // <…>\node_modules\@openai\codex\bin\codex.js → the package
  const platformPkg = `codex-win32-${arch}`
  const vendorRoots = [
    join(pkgRoot, "node_modules", "@openai", platformPkg, "vendor"), // nested under the package
    join(dirname(pkgRoot), platformPkg, "vendor"), // hoisted beside it: <prefix>\node_modules\@openai\<pkg>
    join(pkgRoot, "vendor"), // the pre-platform-package layout, binaries inside @openai/codex itself
  ]
  for (const root of vendorRoots) {
    const exe = join(root, triple, "bin", "codex.exe")
    if (access(exe, "exists")) return exe
  }
  return undefined
}

export function resolveCodexExecutable(bin: string | undefined, deps: CodexExecutableDeps = {}): CodexExecutable {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const execPath = deps.execPath ?? process.execPath
  const access = deps.access ?? defaultAccess
  const readFile = deps.readFile ?? defaultReadFile
  const windows = platform === "win32"
  const path = windows ? win32 : posix
  const candidate = bin && bin.length > 0 ? bin : "codex"
  // An absolute path (the provisioned pin) or an explicit relative one is the operator's word: run it
  // as given, exactly as the bare-name spawn did before this resolver existed.
  if (path.isAbsolute(candidate) || /[\\/]/u.test(candidate)) return { file: candidate, args: [] }
  for (const dir of searchPath(env).split(path.delimiter)) {
    if (!dir) continue
    if (!windows) {
      const full = path.join(dir, candidate)
      if (access(full, "executable")) return { file: full, args: [] }
      continue
    }
    const exe = path.join(dir, `${candidate}.exe`)
    if (access(exe, "exists")) return { file: exe, args: [] }
    // Otherwise follow the npm `.cmd` stub. Deliberately never the extensionless sibling: on Windows
    // that is a POSIX shell script and nothing can run it.
    const body = readFile(path.join(dir, `${candidate}.cmd`))
    const target = body === undefined ? undefined : WINDOWS_SHIM_TARGET.exec(body)?.[1]
    if (!target) continue
    const full = path.join(dir, target)
    if (!access(full, "exists")) continue
    if (!/\.(?:js|mjs|cjs)$/iu.test(full)) return { file: full, args: [] }
    const native = vendoredNativeBeside(full, arch, access)
    if (native) return { file: native, args: [] }
    return { file: execPath, args: [full] }
  }
  throw new CodexExecutableNotFoundError(candidate)
}
