import type { SubAgentView } from "@fray-ui/shared"
import { pushSubAgentDrawer } from "../store.ts"
import { visibleChildOps } from "../lib/childOps.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"

// A queue handoff should name the work still running beneath the parent without turning it into a
// second operations toolbar. Live AND stale children render here (visibleChildOps "card", unified onto
// the rail's policy — a stale child is unresolved work, not gone, and a card that hid it read as "done
// underneath" while the rail still showed it); background shells/Monitors remain in BackgroundOpsStrip
// below as a separate runtime concern. The row itself is the shared ChildOpRow at "card" density — the
// same component, tokens and glyph the sidebar rail and the drawer's ops strip render. The dispatch's
// model+effort tag was REMOVED from these lines on 2026-07-27 (maintainer): the profile belongs to the
// prompt box's own control one line up, not repeated on every child line. It still rides the drill-in
// so the drawer knows which cell it opened.
export function QueueSubAgentLines({ slug, subAgents }: { slug: string; subAgents: readonly SubAgentView[] }) {
  const visible = visibleChildOps(subAgents, "card")
  if (visible.length === 0) return null
  return (
    <div data-queue-subagents className="flex min-w-0 flex-col gap-0.5 px-1 pt-1.5">
      {visible.map((agent, index) => (
        <ChildOpRow
          key={agent.id ?? `${agent.startedAt}-${index}`}
          kind="AGENT"
          label={agent.label}
          state={agent.state}
          density="card"
          startedAt={agent.startedAt}
          // What the child is DOING right now. The counters stay off a handoff card (see ChildOpRow).
          activityDetail={agent.activityDetail}
          parentSlug={slug}
          onOpen={agent.id ? () => pushSubAgentDrawer(slug, agent.id!, { label: agent.label, subagentType: agent.subagentType, startedAt: agent.startedAt }) : undefined}
        />
      ))}
    </div>
  )
}
