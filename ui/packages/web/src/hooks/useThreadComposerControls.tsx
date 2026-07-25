import { useMutation, useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useSnapshot } from "valtio"
import { rpc } from "../api/rpc.ts"
import { threadFollowUpBlocked, threadComposerStatus } from "../lib/threadPermissions.ts"
import { showToast, store } from "../store.ts"
import { ProfileGridSelector } from "../components/ProfileGridSelector.tsx"
import { threadProfileControlState } from "../lib/threadProfile.ts"

// One control strip for every place a registered thread can be steered. This lives outside the
// component module so exporting the hook does not invalidate Vite Fast Refresh for ThreadActionBar.
//
// The per-thread permission/sandbox picker was REMOVED from this strip (2026-07-23). Fray workers run
// non-interactively (`-a never` codex / auto claude), so no restrictive mode has an interactive-approval
// story to satisfy — a narrowed sandbox just wedges the thread on a prompt nobody is watching, and a
// codex `workspace-write` the operator never chose kept leaking in from terminal `codex resume`
// excursions on the shared rollout. Dispatch already exposes no permission choice; this drops the last
// two surfaces that did (queue card + drawer). The backend setThreadPermission plumbing is left in place
// for now — only the UI affordance is gone. What remains here is the model/effort selector.
export function useThreadComposerControls(slug: string): { busy: boolean; footer: ReactNode; status: ReactNode } {
  const snap = useSnapshot(store)
  const thread = snap.board?.threads.find((candidate) => candidate.id === slug)
  const profiles = useQuery({
    queryKey: ["threadProfileOptions", slug],
    queryFn: () => rpc.threadProfileOptions({ slug }),
    enabled: Boolean(thread && !thread.foreign && thread.kind === "session"),
    staleTime: 5_000,
  })
  const profile = useMutation({
    mutationFn: (target: { model: string; effort: string }) => rpc.setThreadProfile({ slug, ...target }),
  })
  const localBusy = profile.isPending

  // Legacy/rowless and foreign transcripts have no Fray-owned runtime profile to mutate. Keep their
  // existing composer behavior, but never render a misleading disabled control.
  if (!thread || thread.foreign || thread.kind !== "session") return { busy: localBusy, footer: null, status: null }

  // The board's pending bit is authoritative across every mounted surface (queue + drawer + another
  // tab). A local React mutation alone cannot prevent a second composer from steering the pane during
  // the backend handoff.
  const busy = localBusy || threadFollowUpBlocked(thread)

  const model = thread.model?.trim()
  const effort = thread.effort?.trim()
  const backend = thread.backend === "codex" ? "codex" : "claude"
  // OPTIMISTIC PENDING. The profile control is backed by a runtime handoff that can take a half-second
  // or more, and the board's own pending bit only appears once the server has claimed the row — so
  // picking a model used to produce NO visible response at all until it landed, which reads as a dropped
  // click and invites a second one. The in-flight mutation variables give us the exact target
  // immediately, expressed in the SAME "→ … pending" affordance the server's bit drives, so the local
  // hint and the authoritative one are indistinguishable and hand over without a flicker. Deliberately
  // NOT rendered as the applied value: the server may still answer "next-resume", and a control that
  // claims a live change it did not make is worse than a slow one.
  const optimisticProfile = profile.isPending ? profile.variables : undefined
  const pendingModel = thread.profilePendingModel ?? optimisticProfile?.model
  const pendingEffort = thread.profilePendingEffort ?? optimisticProfile?.effort
  const profileOptions = profiles.data?.options ?? []
  const { modelSelectable } = threadProfileControlState(profileOptions, model, effort, thread.runtime === "exited")
  const catalogLoaded = profiles.data !== undefined
  const profileGroups = [{
    id: backend,
    label: backend === "codex" ? "Codex" : "Claude Code",
    options: profileOptions,
  }]
  const composerStatus = threadComposerStatus(profiles.isError ? (profiles.error as Error).message : undefined)

  function changeProfile(target: { model: string; effort: string }) {
    profile.mutate(target, {
      onSuccess: (result) => showToast(result.effect === "next-resume"
        ? "Model and effort saved for the next resume"
        : "Model and effort applied"),
      onError: (e) => showToast(`Profile change failed: ${(e as Error).message.slice(0, 120)}`),
    })
  }

  return {
    busy,
    footer: (
      <div
        data-thread-composer-controls
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5"
      >
        <ProfileGridSelector
          groups={profileGroups}
          value={{ provider: backend, model, effort }}
          pending={pendingModel || pendingEffort
            ? { provider: backend, model: pendingModel, effort: pendingEffort }
            : undefined}
          onValueChange={({ model: nextModel, effort: nextEffort }) => changeProfile({ model: nextModel, effort: nextEffort })}
          placeholder={profiles.isPending ? "Profile loading…" : "Profile unknown"}
          ariaLabel="Thread model and effort"
          menuAriaLabel={`Choose ${backend === "codex" ? "Codex" : "Claude Code"} model and effort`}
          title={modelSelectable
            ? thread.runtime === "exited"
              ? "Saved per thread and applied when this conversation resumes"
              : "Change this idle conversation's model and reasoning effort"
            : "The current live backend profile is unavailable; controls fail closed"}
          disabled={busy || !catalogLoaded || !modelSelectable || profiles.isError}
          compact
          side="top"
          className="min-w-0 max-w-[min(72%,20rem)] px-1.5 py-0.5"
        />
        {pendingModel && pendingEffort && (
          <span className="min-w-0 truncate text-[9px] text-muted/50">
            → {pendingModel} · {pendingEffort} pending
          </span>
        )}
      </div>
    ),
    status: composerStatus ? (
          <div
            data-thread-control-error=""
            className="px-1 pt-1 text-[9.5px] leading-tight text-muted/65"
          >
            {composerStatus.message}
          </div>
        ) : null,
  }
}
