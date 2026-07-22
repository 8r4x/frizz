export const CODEX_HOST_DIRECTIVE_NAMES = [
  "artifact-template",
  "code-comment",
  "created-thread",
  "git-stage",
  "git-commit",
  "git-create-branch",
  "git-push",
  "git-create-pr",
  "archive",
  "archive-thread",
  "automation-update",
] as const

export type CodexHostDirectiveName = typeof CODEX_HOST_DIRECTIVE_NAMES[number]
export type CodexHostDirectiveValue = string | number | boolean
export type CodexHostDirective = {
  name: CodexHostDirectiveName
  attrs: Readonly<Record<string, CodexHostDirectiveValue>>
}

const NAMES = new Set<string>(CODEX_HOST_DIRECTIVE_NAMES)
const ATTRIBUTE_NAME = /[a-zA-Z_][a-zA-Z0-9_-]*/y
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

function attributes(source: string): Readonly<Record<string, CodexHostDirectiveValue>> | null {
  const result: Record<string, CodexHostDirectiveValue> = {}
  let index = 0
  while (index < source.length) {
    while (/\s/.test(source[index] ?? "")) index++
    if (index >= source.length) break
    ATTRIBUTE_NAME.lastIndex = index
    const keyMatch = ATTRIBUTE_NAME.exec(source)
    if (!keyMatch || Object.hasOwn(result, keyMatch[0])) return null
    const key = keyMatch[0]
    index = ATTRIBUTE_NAME.lastIndex
    if (source[index] !== "=") return null
    index++

    if (source[index] === '"') {
      const start = index
      index++
      let escaped = false
      while (index < source.length) {
        const char = source[index++]
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') break
      }
      if (source[index - 1] !== '"') return null
      try {
        result[key] = JSON.parse(source.slice(start, index)) as string
      } catch { return null }
    } else {
      const start = index
      while (index < source.length && !/\s/.test(source[index])) index++
      const token = source.slice(start, index)
      if (token === "true" || token === "false") result[key] = token === "true"
      else if (NUMBER.test(token)) result[key] = Number(token)
      else return null
    }
    if (index < source.length && !/\s/.test(source[index])) return null
  }
  return result
}

// Codex host directives are presentation hints, not commands. This parser deliberately recognizes
// only the known names and exact standalone shape; callers decide how to present the inert payload.
export function parseCodexHostDirective(line: string): CodexHostDirective | null {
  const match = line.match(/^\s*::([a-z][a-z0-9-]*)\{([^\n]*)\}\s*$/)
  if (!match || !NAMES.has(match[1])) return null
  const attrs = attributes(match[2])
  return attrs ? { name: match[1] as CodexHostDirectiveName, attrs } : null
}
