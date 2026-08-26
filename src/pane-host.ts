/**
 * One owner for the launcher's keyboard.
 *
 * Raw mode is a global: whoever turns it on owns every keystroke and owes the shell a restore on
 * every exit path. Two panes each doing that would fight over stdin and race to restore it. So the
 * host holds raw mode alone, routes keys — to the open pane while one is open, otherwise to whatever
 * pane the key is bound to — and re-raises ^C by hand, because raw mode stops the TTY doing it.
 *
 * TTY only. Under a pipe, CI, or `--debug` there is no keyboard and no cursor addressing, so the host
 * does not install and the plain records path is untouched.
 */

export interface Pane {
  /** Show the pane. False means there is nothing to show, and the host leaves the terminal alone. */
  open(): boolean;
  /** A key while this pane is open. Return "close" to hand the terminal back. */
  key(key: string): "close" | "keep";
  /** Take the pane down — after "close", or at shutdown. Must be safe to call when not open. */
  close(): void;
}

export interface PaneHost {
  /** Restore the terminal and stop listening. Safe to call more than once. */
  dispose(): void;
  /** Whether a pane currently has the screen. */
  isOpen(): boolean;
}

export interface PaneHostOptions {
  /** Key → pane. Bind both cases of a letter yourself; the host matches keys verbatim. */
  bindings: Record<string, Pane>;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** How ^C is re-raised. Injectable because signal delivery is async and therefore untestable inline. */
  onInterrupt?: () => void;
}

const CTRL_C = "\x03";

export function installPaneHost(options: PaneHostOptions): PaneHost | null {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const onInterrupt = options.onInterrupt ?? (() => process.kill(process.pid, "SIGINT"));
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return null;

  let active: Pane | null = null;
  let disposed = false;

  const closeActive = () => {
    if (!active) return;
    const pane = active;
    active = null;
    pane.close();
  };

  const onKey = (chunk: Buffer | string) => {
    const key = chunk.toString();
    if (key.includes(CTRL_C)) {
      restore();
      onInterrupt();
      return;
    }
    if (active) {
      if (active.key(key) === "close") closeActive();
      return;
    }
    const pane = options.bindings[key];
    if (pane && pane.open()) active = pane;
  };

  const restore = () => {
    if (disposed) return;
    disposed = true;
    closeActive();
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

  return { dispose: restore, isOpen: () => active !== null };
}
