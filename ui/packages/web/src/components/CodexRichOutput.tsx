import { useEffect, useId, useState, type ReactNode } from "react"
import {
  Archive,
  CalendarClock,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  LayoutTemplate,
  MessageSquareCode,
  Network,
  PackageCheck,
  Upload,
} from "lucide-react"
import type { CodexHostDirective, CodexHostDirectiveValue } from "../lib/codexHostDirectives.ts"

function text(attrs: CodexHostDirective["attrs"], key: string): string | undefined {
  const value = attrs[key]
  return typeof value === "string" && value ? value : undefined
}

function number(attrs: CodexHostDirective["attrs"], key: string): number | undefined {
  const value = attrs[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function webUrl(attrs: CodexHostDirective["attrs"], key: string): string | undefined {
  const value = text(attrs, key)
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined
  } catch { return undefined }
}

function Card({ directive, icon, eyebrow, title, children }: { directive: CodexHostDirective; icon: ReactNode; eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <section
      data-codex-directive={directive.name}
      className="min-w-0 rounded-lg border border-border bg-panel-2/75 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-muted" aria-hidden>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted">{eyebrow}</div>
          <div className="mt-0.5 break-words text-[13px] font-medium text-fg">{title}</div>
          {children}
        </div>
      </div>
    </section>
  )
}

function Detail({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return <div className={`mt-1 break-words text-[11px] leading-4 text-muted${mono ? " font-mono-keep" : ""}`}>{children}</div>
}

function TemplateCard({ directive }: { directive: CodexHostDirective }) {
  const attrs = directive.attrs
  const displayName = text(attrs, "display_name") ?? text(attrs, "skill_name") ?? "Artifact template"
  const kind = text(attrs, "artifact_kind")
  const skill = text(attrs, "skill_name")
  const directory = text(attrs, "skill_directory")
  const [preview, setPreview] = useState(Boolean(directory))
  return (
    <Card directive={directive} icon={<LayoutTemplate size={16} />} eyebrow={kind ? `${kind} template` : "Template"} title={displayName}>
      {skill && <Detail mono>{skill.startsWith("$") ? skill : `$${skill}`}</Detail>}
      {directory && <Detail mono>{directory}</Detail>}
      {preview && directory && (
        <img
          src={`/local-image?path=${encodeURIComponent(`${directory}/assets/preview.png`)}`}
          alt={`${displayName} template preview`}
          loading="lazy"
          onError={() => setPreview(false)}
          className="mt-2 max-h-44 max-w-full rounded-md border border-border object-contain"
        />
      )}
    </Card>
  )
}

function CodeCommentCard({ directive }: { directive: CodexHostDirective }) {
  const attrs = directive.attrs
  const file = text(attrs, "file")
  const start = number(attrs, "start")
  const end = number(attrs, "end") ?? start
  const priority = number(attrs, "priority")
  const location = file ? `${file}${start ? `:${start}${end && end !== start ? `-${end}` : ""}` : ""}` : "Code location unavailable"
  return (
    <Card directive={directive} icon={<MessageSquareCode size={16} />} eyebrow={priority === undefined ? "Code comment" : `P${priority} code comment`} title={text(attrs, "title") ?? "Review finding"}>
      {text(attrs, "body") && <Detail>{text(attrs, "body")}</Detail>}
      {file ? (
        <button type="button" className="local-file-action mt-1 max-w-full break-all text-left font-mono-keep text-[11px] text-accent underline decoration-dotted underline-offset-2" data-local-path={file} title={location}>
          {location}
        </button>
      ) : <Detail mono>{location}</Detail>}
    </Card>
  )
}

const GIT_PRESENTATION = {
  "git-stage": [PackageCheck, "Git", "Changes staged"],
  "git-commit": [GitCommitHorizontal, "Git", "Commit created"],
  "git-create-branch": [GitBranch, "Git", "Branch created"],
  "git-push": [Upload, "Git", "Branch pushed"],
  "git-create-pr": [GitPullRequest, "Git", "Pull request created"],
} as const

function GitCard({ directive }: { directive: CodexHostDirective }) {
  const [Icon, eyebrow, title] = GIT_PRESENTATION[directive.name as keyof typeof GIT_PRESENTATION]
  const cwd = text(directive.attrs, "cwd")
  const branch = text(directive.attrs, "branch")
  const url = webUrl(directive.attrs, "url")
  const draft = directive.attrs.isDraft === true
  return (
    <Card directive={directive} icon={<Icon size={16} />} eyebrow={eyebrow} title={`${title}${draft ? " as draft" : ""}`}>
      {branch && <Detail mono>{branch}</Detail>}
      {cwd && <Detail mono>{cwd}</Detail>}
      {url && <a className="mt-1 block break-all text-[11px] text-accent underline underline-offset-2" href={url} target="_blank" rel="noopener noreferrer">Open pull request</a>}
      <Detail>Reported by Codex</Detail>
    </Card>
  )
}

function ThreadCard({ directive }: { directive: CodexHostDirective }) {
  const id = text(directive.attrs, "threadId")
  const pending = text(directive.attrs, "pendingWorktreeId")
  return (
    <Card directive={directive} icon={<Network size={16} />} eyebrow="Codex thread" title={pending ? "Thread setup queued" : "Thread created"}>
      {(id || pending) && <Detail mono>{id ?? pending}</Detail>}
      <Detail>Recorded from the native Codex host</Detail>
    </Card>
  )
}

function LifecycleCard({ directive }: { directive: CodexHostDirective }) {
  const reason = text(directive.attrs, "reason")
  return (
    <Card directive={directive} icon={<Archive size={16} />} eyebrow="Codex lifecycle" title="Archive requested">
      {reason && <Detail>{reason}</Detail>}
      <Detail>Recorded only · Fray state unchanged</Detail>
    </Card>
  )
}

function scheduleSummary(value: CodexHostDirectiveValue | undefined): string | undefined {
  if (typeof value !== "string" || !value) return undefined
  const interval = value.match(/(?:^|;)FREQ=HOURLY(?:;|$).*?(?:^|;)INTERVAL=(\d+)(?:;|$)/)?.[1]
  if (interval) return `Every ${interval} hour${interval === "1" ? "" : "s"}`
  if (/(?:^|;)FREQ=WEEKLY(?:;|$)/.test(value)) return "Weekly schedule"
  return "Custom schedule"
}

function AutomationCard({ directive }: { directive: CodexHostDirective }) {
  const attrs = directive.attrs
  const mode = text(attrs, "mode")
  const name = text(attrs, "name") ?? "Automation"
  const schedule = scheduleSummary(attrs.rrule)
  const status = text(attrs, "status")
  return (
    <Card directive={directive} icon={<CalendarClock size={16} />} eyebrow="Codex automation" title={name}>
      {(mode || status || schedule) && <Detail>{[mode, status, schedule].filter(Boolean).join(" · ")}</Detail>}
      {text(attrs, "prompt") && <Detail>{text(attrs, "prompt")}</Detail>}
      <Detail>Suggestion only · no schedule changed</Detail>
    </Card>
  )
}

export function CodexDirectiveCard({ directive }: { directive: CodexHostDirective }) {
  if (directive.name === "artifact-template") return <TemplateCard directive={directive} />
  if (directive.name === "code-comment") return <CodeCommentCard directive={directive} />
  if (directive.name.startsWith("git-")) return <GitCard directive={directive} />
  if (directive.name === "created-thread") return <ThreadCard directive={directive} />
  if (directive.name === "archive" || directive.name === "archive-thread") return <LifecycleCard directive={directive} />
  return <AutomationCard directive={directive} />
}

type MermaidModule = typeof import("mermaid")["default"]
let mermaidModule: Promise<MermaidModule> | undefined

function loadMermaid(): Promise<MermaidModule> {
  mermaidModule ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      themeVariables: {
        background: "#181b20",
        primaryColor: "#181b20",
        primaryTextColor: "#e6e7e9",
        primaryBorderColor: "#33363c",
        lineColor: "#8b8f96",
        secondaryColor: "#26282d",
        tertiaryColor: "#0d0e10",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
    })
    return mermaid
  })
  return mermaidModule
}

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId()
  const [state, setState] = useState<{ html?: string; error?: string }>({})
  useEffect(() => {
    let live = true
    setState({})
    if (source.length > 50_000) {
      setState({ error: "Diagram source exceeds the 50 KB rendering limit" })
      return () => { live = false }
    }
    const id = `fray-mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`
    void loadMermaid()
      .then((mermaid) => mermaid.render(id, source))
      .then(({ svg }) => { if (live) setState({ html: svg }) })
      .catch((error: unknown) => {
        if (!live) return
        const message = error instanceof Error ? error.message.split(/\n| for text:/, 1)[0] : "Unknown diagram error"
        setState({ error: message.slice(0, 240) })
      })
      // Mermaid appends a `d<id>` scratch container to document.body while rendering. Its rejection
      // path leaves that node behind as a giant error diagram unless the host removes it explicitly.
      .finally(() => document.getElementById(`d${id}`)?.remove())
    return () => { live = false }
  }, [reactId, source])

  if (state.error) {
    return (
      <section data-mermaid-state="error" className="rounded-lg border border-border bg-panel-2/75 px-3 py-2.5">
        <div className="text-[12px] font-medium text-fg">Diagram unavailable</div>
        <div className="mt-1 text-[11px] text-muted">{state.error}</div>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-bg p-2 font-mono-keep text-[11px] text-muted">{source}</pre>
      </section>
    )
  }
  if (!state.html) return <div data-mermaid-state="loading" role="status" aria-label="Rendering diagram" className="h-24 animate-pulse rounded-lg bg-panel-2" />
  return <div data-mermaid-state="ready" className="overflow-x-auto rounded-lg border border-border bg-panel-2/75 p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: state.html }} />
}
