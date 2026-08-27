/** ONE class string for every icon control in a thread's top action strip.
 *
 *  The strip is rendered identically by the queue card's header and the thread header (see
 *  HeaderActions), and it now carries verbs from three different modules — the navigation icons
 *  HeaderActions owns, plus Reload plugins and Restart worker, which moved up out of the lifecycle
 *  footer on 2026-08-26 (maintainer: "the restart worker button should be at the top… it shouldn't be
 *  along the bottom"). Those two arrived wearing the FOOTER's chrome — a 24px square at `text-fg/55`
 *  with a hand-measured ink trim for that strip's 12px ink rhythm — and none of it transfers: this
 *  strip is 28px squares at `text-muted` on a flat `gap-0.5`. Sharing the string is what stops the
 *  imported verbs reading as a different family from the icons beside them.
 *
 *  It lives here rather than in HeaderActions.tsx because those two buttons are imported BY that file;
 *  taking the constant from it would close an import cycle. */
export const HEADER_ICON_CLASS =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-muted disabled:opacity-40"
