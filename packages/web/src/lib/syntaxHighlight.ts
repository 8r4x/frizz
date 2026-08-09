import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import diff from "highlight.js/lib/languages/diff"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import rust from "highlight.js/lib/languages/rust"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

// First-cut fenced-language set. Keep this explicit: importing highlight.js/lib/core plus only these
// grammars avoids shipping the package's ~190-language default bundle. Aliases are normalized here
// rather than guessed by highlightAuto, so unknown/user-controlled info strings always stay plaintext.
const GRAMMARS = {
  bash,
  css,
  diff,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
} as const

export const SUPPORTED_FENCE_LANGUAGES = Object.freeze({
  bash: ["bash", "sh", "shell", "zsh"],
  css: ["css"],
  diff: ["diff", "patch"],
  javascript: ["javascript", "js", "jsx", "mjs", "cjs"],
  json: ["json", "jsonc"],
  markdown: ["markdown", "md", "mdx"],
  python: ["python", "py"],
  rust: ["rust", "rs"],
  sql: ["sql"],
  typescript: ["typescript", "ts", "tsx", "mts", "cts"],
  xml: ["xml", "html", "svg"],
  yaml: ["yaml", "yml"],
} as const)

export type SupportedFenceLanguage = keyof typeof SUPPORTED_FENCE_LANGUAGES
export type FenceLanguage = SupportedFenceLanguage | "plaintext"

for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar)

const ALIAS_TO_LANGUAGE = new Map<string, SupportedFenceLanguage>()
for (const [language, aliases] of Object.entries(SUPPORTED_FENCE_LANGUAGES)) {
  for (const alias of aliases) ALIAS_TO_LANGUAGE.set(alias, language as SupportedFenceLanguage)
}

const PLAINTEXT_ALIASES = new Set(["", "text", "txt", "plain", "plaintext"])

// Marked passes the whole fence info string as `lang`; highlighting uses its first whitespace-delimited
// word just as Marked's stock renderer does. The remaining metadata is intentionally left untouched for
// the upstream signal/question fence parsers, which remove their special blocks before markdown render.
export function resolveFenceLanguage(infoString?: string): FenceLanguage {
  const declared = (infoString ?? "").trim().split(/\s+/, 1)[0].toLowerCase()
  if (PLAINTEXT_ALIASES.has(declared)) return "plaintext"
  return ALIAS_TO_LANGUAGE.get(declared) ?? "plaintext"
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === '"') return "&quot;"
    return "&#39;"
  })
}

// The copy affordance is minted HERE, in the HTML string, rather than rendered as a component: a fenced
// block leaves this pipeline as markup that every surface injects with innerHTML, so there is no React
// element to hang a button on. That is the same constraint the sanitizer's local-file link already lives
// under (markdown.ts), and the click is likewise handled by one delegated listener — lib/copy-code.ts.
//
// The WRAPPER exists because `<pre>` is the scroller (`overflow-x: auto`): a button positioned inside it
// rides the content and slides out of view the moment a long line is scrolled, so the anchor has to be an
// element that does not scroll. A SPAN rather than a div for the reason markdown.ts's frameImage gives —
// this HTML is re-parsed by the browser when a surface injects it, and a non-phrasing wrapper makes the
// parser restructure the block around it; `.md-code` supplies the display/position it needs.
//
// The button carries no inline `<svg>`: the sanitizer drops svg WITH its subtree, so both glyphs (copy,
// and the check the delegated handler swaps to) are lucide paths carried as mask-image data URIs in
// styles.css, exactly as the markdown task marks are.
export const CODE_BLOCK_CLASS = "md-code"
export const CODE_COPY_CLASS = "md-code-copy"
export const CODE_COPIED_CLASS = "is-copied"
export const COPY_CODE_LABEL = "Copy code"

export function renderHighlightedCode(text: string, infoString?: string): string {
  const language = resolveFenceLanguage(infoString)
  // Match Marked's stock code renderer: exactly one trailing LF is present in the resulting <code>,
  // preserving selection/copy behavior for both complete and still-streaming (unclosed) fences.
  const code = `${text.replace(/\n$/, "")}\n`
  let value: string
  if (language === "plaintext") {
    value = escapeHtml(code)
  } else {
    try {
      value = hljs.highlight(code, { language, ignoreIllegals: true }).value
    } catch {
      // A malformed grammar input must never take down transcript rendering. The raw text remains
      // visible, escaped, and selectable; there is deliberately no automatic language guessing.
      value = escapeHtml(code)
    }
  }
  // No whitespace anywhere inside the <pre>: it preserves it, so a newline before the <code> would print
  // as a blank first line. The button follows the block in DOM order so a keyboard walk reaches the code
  // before its affordance, and `title` is the accessible name — `aria-label` is not in the render allowlist.
  return `<span class="${CODE_BLOCK_CLASS}"><pre><code class="hljs language-${language}">${value}</code></pre>`
    + `<button type="button" class="${CODE_COPY_CLASS}" title="${COPY_CODE_LABEL}"></button></span>\n`
}
