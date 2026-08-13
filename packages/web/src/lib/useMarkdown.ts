import { useMemo, useSyncExternalStore } from "react"
import { mdToHtml, mdInlineToHtml } from "./markdown.ts"
import { githubRepoForLinks, subscribeGithubRepo } from "./githubAutolink.ts"

// Memoized markdown rendering, for every surface that drops agent prose into `dangerouslySetInnerHTML`.
//
// It exists because `mdToHtml` is not a pure function of its argument: the GitHub autolinker
// (githubAutolink.ts) reads the project's repo from module state, and that state arrives from the board a
// beat after a thread's own transcript query resolves. Every call site used to memoize on the markdown
// STRING alone, so the HTML built during that beat — with no repo, hence no links — was the HTML the
// reader kept for the life of the page. Making the repo a subscribed render input is what fixes it, and
// putting it in one hook is what stops the next markdown surface from reintroducing the bug.
//
// useSyncExternalStore over a SCALAR rather than useSnapshot, matching lib/deliverQueuedNow.ts: this
// runs in every prose block on screen, and the value changes at most once per page.

/** The repo GitHub-style references link to, as a render input. */
export function useGithubRepoForLinks(): string | null {
  return useSyncExternalStore(subscribeGithubRepo, githubRepoForLinks, githubRepoForLinks)
}

/** Block prose → sanitized HTML. `asDocument`/`baseDir` are the built-in file reader's (see mdToHtml). */
export function useMarkdownHtml(md: string, opts?: { baseDir?: string; asDocument?: boolean }): string {
  const repo = useGithubRepoForLinks()
  const { baseDir, asDocument } = opts ?? {}
  // `repo` is deliberately a dependency without appearing in the body — it is an input to mdToHtml
  // through githubAutolink.ts's module state, not through this argument list.
  return useMemo(() => mdToHtml(md, { baseDir, document: asDocument }), [md, baseDir, asDocument, repo])
}

/** Inline-only prose → sanitized HTML, for hosts that are one line tall (see mdInlineToHtml). */
export function useInlineMarkdownHtml(md: string, opts?: { inertInteractive?: boolean }): string {
  const repo = useGithubRepoForLinks()
  const inertInteractive = opts?.inertInteractive
  return useMemo(() => mdInlineToHtml(md, { inertInteractive }), [md, inertInteractive, repo])
}
