import { renderQrLines } from "@frizz/server/qr";
import { installPaneHost, type Pane } from "./pane-host.ts";

/**
 * "Press L for a fresh access link" — an ephemeral full-screen QR, then back to the readout.
 *
 * Why a pane and not a line in the readout: the readout is SCROLLBACK. A QR that lives there is the
 * same leak as a standing secret, just harder to grep for, and it would still be on screen long after
 * the code behind it expired. A pane shows a credential for as long as someone is looking at it and
 * then takes it away.
 *
 * The keyboard itself — raw mode, ^C, restoring the shell — belongs to the pane host (pane-host.ts),
 * which routes L here and R to the remote-access pane. This file only knows how to paint a link.
 */

export interface AccessLink {
  code: string;
  url: string;
  expiresAt: number;
}

export interface AccessPaneOptions {
  /** Mint a fresh single-use link. Null when the board has no public origin, which disables the pane. */
  issue: () => AccessLink | null;
  output?: NodeJS.WriteStream;
  now?: () => number;
}

export const ALT_SCREEN_ON = "\x1b[?1049h";
export const ALT_SCREEN_OFF = "\x1b[?1049l";
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const CLEAR = "\x1b[2J\x1b[H";
export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";

export interface AccessPane extends Pane {
  /** The pane is showing a code that has just been spent; repaint it as stale. */
  markConsumed(): void;
}

function secondsUntil(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function createAccessPane(options: AccessPaneOptions): AccessPane {
  const output = options.output ?? process.stdout;
  const now = options.now ?? Date.now;

  let open = false;
  let shown: AccessLink | null = null;
  let consumed = false;
  let ticker: NodeJS.Timeout | undefined;

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

  return {
    open() {
      const link = options.issue();
      // No public origin means nothing to show. Say so rather than flashing an empty pane.
      if (!link) return false;
      shown = link;
      consumed = false;
      open = true;
      output.write(ALT_SCREEN_ON);
      output.write(HIDE_CURSOR);
      paint();
      // Repaint once a second so the countdown is honest and expiry is visible rather than silent.
      ticker = setInterval(paint, 1_000);
      ticker.unref?.();
      return true;
    },
    key(key) {
      // The readout footer and this pane's own expired/consumed lines all say "press L for a fresh
      // link" — so L while the pane is open must mint one in place. Before this, every key closed the
      // pane, which made L a toggle: the exact keystroke the copy invited took the QR away instead.
      if (key === "l" || key === "L") {
        const link = options.issue();
        // The origin can drop while the pane is up (the R pane clearing the remote setup); with
        // nothing left to mint, close rather than keep showing a link that no longer works.
        if (!link) return "close";
        shown = link;
        consumed = false;
        paint();
        return "keep";
      }
      return "close";
    },
    close() {
      if (!open) return;
      open = false;
      shown = null;
      consumed = false;
      if (ticker) clearInterval(ticker);
      ticker = undefined;
      output.write(ALT_SCREEN_OFF);
      output.write(SHOW_CURSOR);
    },
    markConsumed() {
      if (!open) return;
      consumed = true;
      paint();
    },
  };
}

/**
 * The L-only host, kept for the launchers' simplest case and for the tests: a pane host with a single
 * binding. Launchers that also mount the remote-access pane build the host themselves.
 */
export interface InstalledAccessPane {
  dispose(): void;
  markConsumed(): void;
}

export function installAccessPane(
  options: AccessPaneOptions & { input?: NodeJS.ReadStream; onInterrupt?: () => void },
): InstalledAccessPane | null {
  const pane = createAccessPane(options);
  const host = installPaneHost({
    bindings: { l: pane, L: pane },
    ...(options.input ? { input: options.input } : {}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.onInterrupt ? { onInterrupt: options.onInterrupt } : {}),
  });
  if (!host) return null;
  return { dispose: host.dispose, markConsumed: () => pane.markConsumed() };
}
