import { useMemo } from "react"

// THE ONLY sanctioned way to pass `dangerouslySetInnerHTML`. Never write the `{ __html }` literal
// inline in JSX.
//
// React 19 compares props by REFERENCE. `updateProperties` (react-dom 19.2.7) skips a prop only when
// `nextValue === prevValue`, and `dangerouslySetInnerHTML` is an OBJECT — so a fresh `{ __html }`
// literal fails that check on every single render. It then reaches `setProp`, which assigns
// `domElement.innerHTML = value.__html` UNCONDITIONALLY: there is no string comparison anywhere on the
// update path. (React 18's `diffProperties` did compare the two `__html` STRINGS and emit no update
// when they matched; 19 dropped that path.) The result is that a re-render of an unchanged prose block
// throws away its whole DOM subtree and rebuilds it from identical markup.
//
// That is not merely wasted work. Measured on a real thread (2026-08-01): the rebuild recreated the
// `<img>` inside a message, which re-issued its `/local-image` request; the screenshot's file was gone,
// so it 404'd, collapsing the image box to 0px and then repainting Chrome's broken-glyph box. That
// flipped the VIRTUALIZED row's height 965px ↔ 988px, whose `measureElement` ResizeObserver re-rendered
// the transcript, which rebuilt the markup again — a self-sustaining loop running at frame rate:
// 233 `/local-image` requests and 2220 DOM mutations in four seconds, on an IDLE thread.
//
// Memoizing on the html STRING restores the comparison React 18 used to make for us: identical markup →
// identical object → React skips the write entirely and the DOM is left alone.
export function useInnerHtml(html: string): { __html: string } {
  return useMemo(() => ({ __html: html }), [html])
}
