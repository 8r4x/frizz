import { renderQrLines } from "@frizz/server/qr";

/**
 * "Press L for a fresh access link" — an ephemeral full-screen QR, then back to the readout.
 *
 * Why a pane and not a line in the readout: the readout is SCROLLBACK. A QR that lives there is the
 * same leak as a standing secret, just harder to grep for, and it would still be on screen long after
 * the code behind it expired. A pane shows a credential for as long as someone is looking at it and
 * then takes it away.
 *
 * Three things this has to get right or it is worse than not existing:
 *
 * CTRL-C MUST STILL WORK. Raw mode stops the TTY translating ^C into SIGINT, so a naive implementation
 * silently makes the board unkillable from its own terminal. This re-raises SIGINT by hand.
 * NEVER LEAVE THE TERMINAL IN RAW MODE. Every exit path — key, expiry, error, process death — restores
 * it, or the operator's shell is left echoing nothing after Frizz stops.
 * TTY ONLY. Under a pipe, CI, or `--debug` there is no keyboard and no cursor addressing, so this does
 * not install itself at all and the plain records path is untouched.
 */

export interface AccessLink {
  code: string;
  url: string;
  expiresAt: number;
}

export interface AccessPaneOptions {
  /** Mint a fresh single-use link. Null when the board has no public origin, which disables the pane. */
  issue: () => AccessLink | null;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  now?: () => number;
  /** How ^C is re-raised. Injectable because signal delivery is async and therefore untestable inline. */
  onInterrupt?: () => void;
}

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
/** The key that opens the pane. Lowercase and uppercase both, because shift-lock is not an error. */
const OPEN_KEYS = new Set(["l", "L"]);
const CTRL_C = "\x03";

export interface AccessPane {
  /** Restore the terminal and stop listening. Safe to call more than once. */
  dispose(): void;
  /** The pane is showing a code that has just been spent; repaint it as stale. */
  markConsumed(): void;
}

function secondsUntil(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function installAccessPane(options: AccessPaneOptions): AccessPane | null {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const now = options.now ?? Date.now;
  const onInterrupt = options.onInterrupt ?? (() => process.kill(process.pid, "SIGINT"));
  // No keyboard, no pane. Also covers pipes, CI, and anything reading our stdout as records.
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return null;

  let open = false;
  let disposed = false;
  let shown: AccessLink | null = null;
  let consumed = false;

  const paint = () => {
    if (!shown) return;
    const remaining = secondsUntil(shown.expiresAt, now());
    const status = consumed
      ? "This link has been used. Press L for another."
      : remaining === 0
        ? "This link has expired. Press L for another."
        : `Single use, expires in ${remaining}s.`;
    output.write(CLEAR);
    output.write("\n");
    for (const row of renderQrLines(shown.url)) output.write(`  ${row}\n`);
    output.write(`\n  ${shown.url}\n`);
    output.write(`\n  ${DIM}${status}  Press any other key to close.${RESET}\n`);
  };

  let ticker: NodeJS.Timeout | undefined;

  const close = () => {
    if (!open) return;
    open = false;
    shown = null;
    consumed = false;
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    output.write(ALT_SCREEN_OFF);
    output.write(SHOW_CURSOR);
  };

  const openPane = () => {
    const link = options.issue();
    // No public origin means nothing to show. Say so rather than flashing an empty pane.
    if (!link) return;
    shown = link;
    consumed = false;
    open = true;
    output.write(ALT_SCREEN_ON);
    output.write(HIDE_CURSOR);
    paint();
    // Repaint once a second so the countdown is honest and expiry is visible rather than silent.
    ticker = setInterval(paint, 1_000);
    ticker.unref?.();
  };

  const onKey = (chunk: Buffer | string) => {
    const key = chunk.toString();
    // Raw mode means the TTY no longer turns ^C into a signal. Do it by hand, or the board becomes
    // unkillable from the terminal that started it.
    if (key.includes(CTRL_C)) {
      restore();
      onInterrupt();
      return;
    }
    if (open) {
      close();
      return;
    }
    if (OPEN_KEYS.has(key)) openPane();
  };

  const restore = () => {
    if (disposed) return;
    disposed = true;
    close();
    input.off("data", onKey);
    try {
      input.setRawMode?.(false);
    } catch {
      // The stream may already be torn down during shutdown; nothing left to restore.
    }
    input.pause();
    process.off("exit", restore);
  };

  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  input.on("data", onKey);
  // Belt and braces: an unexpected exit must not leave the shell in raw mode.
  process.on("exit", restore);

  return {
    dispose: restore,
    markConsumed: () => {
      if (!open) return;
      consumed = true;
      paint();
    },
  };
}
