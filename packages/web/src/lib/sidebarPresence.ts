import type { BoardSnapshot } from "@frizz/shared"

export type SidebarPresence = {
  projectDir: string | null
  hasBeenVisible: boolean
}

// A board keyframe is a point-in-time transport snapshot, not a declaration that the workspace lost
// its navigation. In particular, a reconnect/rebuild can briefly report no Frizz-owned rows while a
// live delta or the next keyframe repopulates them. Keep the desktop rail mounted after this project
// has had something to navigate; only a genuinely fresh project retains the centered first-task view.
export function nextSidebarPresence(
  previous: SidebarPresence,
  board: Pick<BoardSnapshot, "projectDir" | "threads"> | null,
): SidebarPresence {
  if (!board) return previous
  const projectChanged = previous.projectDir !== board.projectDir
  // FOREIGN SESSIONS COUNT (2026-08-19, reversing the earlier rule that they did not). They used to be
  // discounted because nothing rendered them, so a board holding only terminal sessions was blank in
  // every meaningful sense. Now they have their own rail band — and the project where that band matters
  // MOST is exactly the one this predicate used to call fresh: a repo you have worked in from the
  // terminal and never dispatched a frizz thread in. Discounting them there hid the only surface that
  // could show them. A truly empty board — no threads of any origin — still gets the centered
  // first-task view.
  const hasWorkspaceContent = board.threads.length > 0
  return {
    projectDir: board.projectDir,
    hasBeenVisible: projectChanged ? hasWorkspaceContent : previous.hasBeenVisible || hasWorkspaceContent,
  }
}
