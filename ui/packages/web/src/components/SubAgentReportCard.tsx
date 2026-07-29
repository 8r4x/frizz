// A SUB-AGENT'S UPWARD REPORT, rendered as that child speaking rather than as the human's own words.
//
// Claude Code's agent-to-agent channel lets a BACKGROUND child push a message up to its parent
// mid-flight (`SendMessage({to:"main"})`). It is delivered into the parent's input queue exactly like a
// human follow-up, so the parent's transcript records it as an ordinary user turn whose text is the raw
// `<agent-message from="…">…</agent-message>` wrapper — and the chat rendered it in the off-white
// right-justified bubble the human's messages wear, XML and all. That claimed the operator had typed
// what a sub-agent reported. This card is the correction, and it is deliberately the same shape
// GithubWakeCard uses for the same defect one channel over: left-aligned, in the shared TranscriptCard
// chrome, with the body unwrapped back into readable prose.
import { Bot } from "lucide-react"
import { useMemo } from "react"
import { CARD_BODY, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"
import { MessageDebugId } from "./MessageDebugId.tsx"
import { mdToHtml } from "../lib/markdown.ts"

export function SubAgentReportCard({
  text,
  from,
  agentId,
  sourceId,
  wrap,
  queued,
}: {
  text: string
  from: string
  agentId?: string
  sourceId?: string
  wrap?: boolean
  queued?: boolean
}) {
  // A child's report is prose — it arrives with the markdown a model naturally writes (bullets, backticked
  // paths, a fenced snippet), so it renders through md-body like every other message body rather than as
  // the pre-wrap text blob the wake card's unstructured fallback uses.
  const html = useMemo(() => mdToHtml(text), [text])
  return (
    // NOT `self-end`: right-justification is the human's side of the conversation, and that placement was
    // most of what made a child's report read as something the operator sent.
    <div
      data-fray-msg={sourceId}
      data-fray-subagent-report
      // The child's own agentId — the ONE unambiguous identity when several children share a profile
      // label (the worker dispatch hook strips `name`, so `from` is just the subagent_type). Carried as
      // data rather than rendered: the outbound SendMessage card settled that a raw agentId shown as the
      // salient token is "a meaningless hash" (maintainer 2026-07-28). Here it is the hook a later change
      // can use to join this report to its card in the sub-agent drawer.
      data-fray-subagent-id={agentId}
      className={`group/msg relative min-w-0 max-w-[85%]${queued ? " opacity-60" : ""}`}
    >
      <MessageDebugId sourceId={sourceId} side="right" />
      {/* The sender rides the title row's `aside` slot — the same place the wake card puts the
          `owner/repo#N` it is about. It is the one short reference that identifies this card, so it
          belongs in the headline rather than spending a body line. */}
      <TranscriptCard
        icon={Bot}
        label="Sub-agent reported"
        aside={<span className="text-muted">{from}</span>}
      >
        <div className={`${CARD_BODY} md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
      </TranscriptCard>
    </div>
  )
}
