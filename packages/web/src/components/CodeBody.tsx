import { useMemo } from "react"
import { renderCodeBody } from "../lib/codeBody.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import type { FenceLanguage } from "../lib/syntaxHighlight.ts"

// A `<pre>` whose content is syntax-highlighted — the drop-in replacement for the transcript's raw
// `<pre>{text}</pre>` code bodies (a Bash card's command, a Read card's excerpt, a background shell's
// command). It renders the SAME element with the SAME className the surface passed, so every one of
// those surfaces keeps its own padding, wrapping, clamp and border rules; only colour is added.
//
// `hljs` on the element is what the palette hangs off (styles.css) — the same class the markdown fence
// renderer puts on its `<code>`, so a command in a transcript card and the same command in a fenced
// block colour identically.
export function CodeBody({
  text,
  language,
  className = "",
  ...rest
}: {
  text: string
  language: FenceLanguage
  className?: string
} & Omit<React.HTMLAttributes<HTMLPreElement>, "children" | "className" | "dangerouslySetInnerHTML">) {
  const html = useInnerHtml(useMemo(() => renderCodeBody(text, language), [text, language]))
  return <pre {...rest} className={`hljs ${className}`} dangerouslySetInnerHTML={html} />
}
