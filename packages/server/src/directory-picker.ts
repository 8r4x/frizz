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
 * The timeout reaped a dialog nobody answered, possibly one nobody could SEE — it opens on the
 * server's desktop, which is not always the one in front of the operator. So it is not "cancelled",
 * which would leave the click doing nothing, and on Linux it is not "try the next tool" either: that
 * opened kdialog for another five minutes after zenity timed out. It is unavailable, and the caller's
 * fallback opens.
 */
const timedOut = (error: unknown) => (error as { killed?: unknown }).killed === true

const unanswered = (what: "folder" | "image"): DirectoryPick => ({
  kind: "unavailable",
  reason: `no ${what} was chosen within 5 minutes`,
})

/**
 * `choose folder` returns an alias; `POSIX path of` is what turns it into something openable, and it
 * comes back with a trailing slash that every path comparison in the codebase would then miss on.
 */
const OSASCRIPT = (prompt: string) =>
  `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`

/**
 * Choose an IMAGE, with the dialog already standing in `startIn`.
 *
 * The rail used a browser `<input type="file">`, which cannot be aimed anywhere — the OS decides,
 * and it lands wherever you last were. A project's icon almost always lives in the project (a logo in
 * the repo, a screenshot you just took of it), so opening the picker anywhere else means navigating
 * back to a directory Frizz already knows the path of.
 *
 * `default location` is a hint, not a jail: the operator can still browse anywhere, which is why
 * a missing or unreadable startIn simply falls back to the OS default rather than failing.
 */
export async function pickImageFile(
  startIn: string | undefined,
  prompt = "Choose an image for this project",
  platform: NodeJS.Platform = process.platform,
): Promise<DirectoryPick> {
  if (platform === "darwin") {
    // `of type` takes UTIs; public.image covers every format the rail accepts and nothing else.
    const location = startIn ? ` default location POSIX file ${JSON.stringify(startIn)}` : ""
    const script = `POSIX path of (choose file with prompt ${JSON.stringify(prompt)} of type {"public.image"}${location})`
    try {
      const { stdout } = await run("osascript", ["-e", script], { timeout: PICKER_TIMEOUT_MS })
      const path = stdout.trim().replace(/\/+$/u, "")
      return path ? { kind: "picked", path } : { kind: "cancelled" }
    } catch (error) {
      if (timedOut(error)) return unanswered("image")
      if (/User canceled|-128/u.test(stderrOf(error))) return { kind: "cancelled" }
      return { kind: "unavailable", reason: firstLine(stderrOf(error)) || "the image picker did not open" }
    }
  }
  if (platform === "linux") {
    for (const [bin, args] of [
      ["zenity", ["--file-selection", `--title=${prompt}`, ...(startIn ? [`--filename=${startIn}/`] : [])]],
      ["kdialog", ["--getopenfilename", startIn ?? ".", "image/png image/svg+xml image/webp image/jpeg image/gif"]],
    ] as const) {
      try {
        const { stdout } = await run(bin, [...args], { timeout: PICKER_TIMEOUT_MS })
        const path = stdout.trim()
        return path ? { kind: "picked", path } : { kind: "cancelled" }
      } catch (error) {
        if (timedOut(error)) return unanswered("image")
        if ((error as { code?: unknown }).code === 1) return { kind: "cancelled" }
      }
    }
    return { kind: "unavailable", reason: "install zenity or kdialog for an image picker" }
  }
  return { kind: "unavailable", reason: `no image picker on ${platform}` }
}

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
      if (timedOut(error)) return unanswered("folder")
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
        if (timedOut(error)) return unanswered("folder")
        // Exit 1 from either tool means "dismissed"; ENOENT means "not installed, try the next one".
        if ((error as { code?: unknown }).code === 1) return { kind: "cancelled" }
      }
    }
    return { kind: "unavailable", reason: "install zenity or kdialog for a folder picker" }
  }
  if (platform === "win32") return pickWindowsFolder(prompt)
  return { kind: "unavailable", reason: `no folder picker on ${platform}` }
}

// WINDOWS: a WinForms FolderBrowserDialog, opened from a PowerShell child.
//
// Two editions draw two dialogs. `pwsh` (PowerShell 7, .NET 8) draws the modern "Select Folder"
// dialog, with a path box the operator can paste into; Windows PowerShell 5.1 (.NET Framework, on
// every Windows install) draws the old tree, which can only be clicked through. The better one is not
// guaranteed to be installed, so it is tried first and the old one is the fallback, ENOENT deciding.
//
// AND THE DIALOG HAS TO BE RAISED, which is the whole reason this is more than one line. The server is
// a background process — the browser is the foreground one — and Windows refuses a background
// process the foreground, so the dialog opened BEHIND the browser, where nobody saw it, and sat
// there until the timeout killed it: "Add a project" read as doing nothing (measured 2026-09-18 and
// 2026-09-21 on Windows Server 2022; the "Browse For Folder" window was there, below every browser
// window). Topmost is refused the same way: SetWindowPos(HWND_TOPMOST) reports success and the style
// never takes. What works is the AttachThreadInput route: share the foreground thread's input queue
// for the one SetForegroundWindow call, then detach.
//
// The window that gets raised is an OWNER, not the dialog. ShowDialog blocks until the dialog is gone,
// so straight-line script cannot raise the dialog; a timer inside the modal loop can, but it has to
// guess which window is the dialog, and it once guessed the hidden parking window WinForms gives an
// ownerless dialog (seen 2026-09-21 on the deployed server). An owner form needs no guess: it is
// raised BEFORE the dialog opens, and a modal dialog opens on top of its active owner — that is what
// ownership means to the window manager. The form is one pixel, off-screen, and closed with the dialog.
const WINDOWS_PICKER_EDITIONS = ["pwsh", "powershell"] as const

const WINDOWS_RAISE_NATIVE =
  "Add-Type -Namespace Frizz -Name Native -MemberDefinition '" +
  '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' +
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr pid);' +
  '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();' +
  '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);' +
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);' +
  '[DllImport("user32.dll")] public static extern bool IsHungAppWindow(System.IntPtr h);' +
  "';"

/**
 * The owner form, shown and made the foreground window; `$o` is what ShowDialog is then handed.
 *
 * It keeps a taskbar button, titled with the prompt, so the operator can find the picker again after a
 * click back into the browser buries it — an owned dialog has no taskbar button of its own, and the old
 * picker had none at all. The form itself is a pixel at -32000,-32000 that nobody sees; with `Location`
 * set, WinForms does not re-centre it on `Show`.
 *
 * The plain, sanctioned SetForegroundWindow goes first, and it is often enough: Windows grants it when
 * its foreground lock has lapsed (200 s without input, by default), and measured 2026-09-21 it took on
 * every idle run — from a background node process, even from the Task Scheduler. It is refused exactly
 * when the operator has just been clicking, which is what "Add a project" IS. Only then is the
 * foreground thread's input queue shared (AttachThreadInput) for a second attempt. That step is the
 * documented way to be refused less, not a right, and it is used for one call: when there is no
 * foreground thread (a locked desktop), or it is this thread, or its window is hung (sharing a hung
 * queue would hang the picker too), it is skipped, and the taskbar button is what is left.
 *
 * Both attempts are checked, not assumed: in 1 of 4 review rounds the first SetForegroundWindow did not
 * take even with the attach in place (the operator was mid-input), so a miss is retried a few times.
 */
const WINDOWS_RAISE_OWNER =
  "$o = New-Object System.Windows.Forms.Form -Property @{ ShowInTaskbar = $true; StartPosition = 'Manual';" +
  " Location = (New-Object System.Drawing.Point(-32000, -32000)); Size = (New-Object System.Drawing.Size(1, 1)) };" +
  "$o.Text = $d.Description;" +
  "$o.Show();" +
  "$fg = [Frizz.Native]::GetForegroundWindow();" +
  "[void][Frizz.Native]::SetForegroundWindow($o.Handle);" +
  "if ([Frizz.Native]::GetForegroundWindow() -ne $o.Handle) {" +
  " $theirs = [Frizz.Native]::GetWindowThreadProcessId($fg, [IntPtr]::Zero); $mine = [Frizz.Native]::GetCurrentThreadId();" +
  " $attached = ($theirs -ne 0) -and ($theirs -ne $mine) -and -not [Frizz.Native]::IsHungAppWindow($fg) -and [Frizz.Native]::AttachThreadInput($theirs, $mine, $true);" +
  " foreach ($try in 1..4) { [void][Frizz.Native]::SetForegroundWindow($o.Handle); if ([Frizz.Native]::GetForegroundWindow() -eq $o.Handle) { break }; Start-Sleep -Milliseconds 50 };" +
  " if ($attached) { [void][Frizz.Native]::AttachThreadInput($theirs, $mine, $false) } };"

/**
 * A PowerShell single-quoted literal: nothing inside it is expanded, and `'` is doubled. The curly
 * quotes U+2018..U+201B close a literal just as `'` does, so they are doubled too.
 */
function powershellLiteral(text: string): string {
  return `'${text.replace(/['\u2018-\u201b]/gu, (quote) => quote + quote)}'`
}

/**
 * The picked path is the one stdout line carrying this prefix. Anything else on stdout — a WARNING
 * both editions write there when redirected, a stray Add-Type line — is not mistaken for the path.
 */
const WINDOWS_PICKED_PREFIX = "frizz-picked:"

function windowsFolderScript(prompt: string): string {
  // `Description` is the only prompt the old dialog has; the modern one shows it as a label beside the
  // path box unless told to use it as the title. The property exists only on .NET 8, so ask first.
  //
  // The output encoding is set first. Windows PowerShell 5.1 writes a redirected stdout in the OEM
  // code page, and node decodes it as UTF-8, so a folder with a non-ASCII name comes back mangled and
  // registers a path that does not exist. pwsh already writes UTF-8; setting it there is harmless.
  //
  // Every statement runs under Stop inside one try: PowerShell otherwise carries on past a failed
  // Add-Type or Show, reaches the final if, and exits 0 with nothing on stdout — which reads as
  // "cancelled", and the grid does nothing for a second time. A failure exits 2 with a plain message
  // on stderr (pwsh's own error rendering carries ANSI colour codes that would land in the UI).
  return (
    "$ErrorActionPreference = 'Stop'; try {" +
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;" +
    "Add-Type -AssemblyName System.Windows.Forms;" +
    WINDOWS_RAISE_NATIVE +
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog;" +
    `$d.Description = ${powershellLiteral(prompt)};` +
    "if ($d.PSObject.Properties['UseDescriptionForTitle']) { $d.UseDescriptionForTitle = $true };" +
    WINDOWS_RAISE_OWNER +
    "$r = $d.ShowDialog($o); $o.Close();" +
    `if ($r -eq 'OK') { '${WINDOWS_PICKED_PREFIX}' + $d.SelectedPath }` +
    "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }"
  )
}

/** Exported for the test that pins the edition chain; `pickDirectory` is the door. */
export async function pickWindowsFolder(
  prompt: string,
  editions: readonly string[] = WINDOWS_PICKER_EDITIONS,
): Promise<DirectoryPick> {
  const script = windowsFolderScript(prompt)
  let failure: string | undefined
  for (const edition of editions) {
    try {
      const { stdout } = await run(edition, ["-NoProfile", "-STA", "-Command", script], {
        timeout: PICKER_TIMEOUT_MS,
        // The server has no console. Without this, a console-subsystem child gets a new, visible one
        // that sits beside the dialog for as long as it is open — and can take the foreground the raise
        // just won. The rule everywhere else in the server (local-file.ts, the daemon hosts).
        windowsHide: true,
      })
      // Cancel writes no prefixed line; the dialog itself strips any trailing separator.
      const picked = stdout.split("\n").find((line) => line.startsWith(WINDOWS_PICKED_PREFIX))
      const path = picked?.slice(WINDOWS_PICKED_PREFIX.length).trim() ?? ""
      return path ? { kind: "picked", path } : { kind: "cancelled" }
    } catch (error) {
      // On a machine where the raise did not take, a timeout is the dialog nobody SAW.
      if (timedOut(error)) return unanswered("folder")
      const { code } = error as { code?: unknown }
      // ENOENT is an edition that is not installed; EPERM is one Windows would not start for this
      // process (the Store package's app-execution alias, in a profile it is not registered for); a
      // non-zero exit is the script itself failing in that edition (a pwsh without WinForms, say).
      // Each means "the next edition", not "no picker"; the last failure's reason is the one reported.
      if (code === "ENOENT" || code === "EPERM") continue
      failure = windowsFailureLine(stderrOf(error)) || "the folder picker did not open"
      if (typeof code === "number") continue
      return { kind: "unavailable", reason: failure }
    }
  }
  return { kind: "unavailable", reason: failure ?? "no PowerShell found to open a folder picker" }
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

/** The first non-empty stderr line, with the ANSI colour codes of pwsh's error rendering stripped. */
function windowsFailureLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;]*m/gu, "")
  return plain.split("\n").map((line) => line.trim()).find(Boolean) ?? ""
}
