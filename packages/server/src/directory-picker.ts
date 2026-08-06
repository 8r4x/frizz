import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

// THE NATIVE FOLDER PICKER, opened by the SERVER rather than the browser.
//
// It has to be the server, and that is not a shortcut. The browser's own File System Access API
// (`showDirectoryPicker`) hands back a FileSystemDirectoryHandle carrying the directory's NAME and
// nothing else — deliberately, since exposing absolute paths to a web page is the thing it exists to
// prevent. Frizz needs the path: a project IS a path. So the process that already lives on the
// machine, and already opens browsers and app windows, opens the picker too.
//
// A picker is not available everywhere, which is why every caller keeps a typed path as a fallback
// rather than treating this as the only way in.

export type DirectoryPick =
  | { kind: "picked"; path: string }
  /** The operator dismissed the dialog. Not an error — the commonest outcome after a mis-click. */
  | { kind: "cancelled" }
  /** No picker on this platform, or the tool that provides one is not installed. */
  | { kind: "unavailable"; reason: string }

/** Long enough for someone to actually browse for a folder; short enough not to leak a process. */
const PICKER_TIMEOUT_MS = 5 * 60_000

/**
 * `choose folder` returns an alias; `POSIX path of` is what turns it into something openable, and it
 * comes back with a trailing slash that every path comparison in the codebase would then miss on.
 */
const OSASCRIPT = (prompt: string) =>
  `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`

export async function pickDirectory(
  prompt = "Choose a folder to open in Frizz",
  platform: NodeJS.Platform = process.platform,
): Promise<DirectoryPick> {
  if (platform === "darwin") {
    try {
      const { stdout } = await run("osascript", ["-e", OSASCRIPT(prompt)], { timeout: PICKER_TIMEOUT_MS })
      const path = stdout.trim().replace(/\/+$/u, "")
      return path ? { kind: "picked", path } : { kind: "cancelled" }
    } catch (error) {
      // AppleScript reports a dismissed dialog as an ERROR (-128), not as empty output.
      if (/User canceled|-128/u.test(stderrOf(error))) return { kind: "cancelled" }
      return { kind: "unavailable", reason: firstLine(stderrOf(error)) || "the folder picker did not open" }
    }
  }
  if (platform === "linux") {
    // Neither is guaranteed present; try the GNOME one, then the KDE one, then give up gracefully.
    for (const [bin, args] of [
      ["zenity", ["--file-selection", "--directory", `--title=${prompt}`]],
      ["kdialog", ["--getexistingdirectory", "."]],
    ] as const) {
      try {
        const { stdout } = await run(bin, [...args], { timeout: PICKER_TIMEOUT_MS })
        const path = stdout.trim().replace(/\/+$/u, "")
        return path ? { kind: "picked", path } : { kind: "cancelled" }
      } catch (error) {
        // Exit 1 from either tool means "dismissed"; ENOENT means "not installed, try the next one".
        if ((error as { code?: unknown }).code === 1) return { kind: "cancelled" }
      }
    }
    return { kind: "unavailable", reason: "install zenity or kdialog for a folder picker" }
  }
  if (platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms;" +
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog;" +
      "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }"
    try {
      const { stdout } = await run("powershell", ["-NoProfile", "-STA", "-Command", script], {
        timeout: PICKER_TIMEOUT_MS,
      })
      const path = stdout.trim()
      return path ? { kind: "picked", path } : { kind: "cancelled" }
    } catch (error) {
      return { kind: "unavailable", reason: firstLine(stderrOf(error)) || "the folder picker did not open" }
    }
  }
  return { kind: "unavailable", reason: `no folder picker on ${platform}` }
}

function stderrOf(error: unknown): string {
  return typeof (error as { stderr?: unknown })?.stderr === "string"
    ? (error as { stderr: string }).stderr
    : error instanceof Error
      ? error.message
      : String(error)
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? ""
}
