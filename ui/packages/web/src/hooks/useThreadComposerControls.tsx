import { useMutation, useQuery } from "@tanstack/react-query"
import type { PermissionMode } from "@fray-ui/shared"
import type { ReactNode } from "react"
import { useSnapshot } from "valtio"
import { rpc } from "../api/rpc.ts"
import { PERMISSION_COLOR, permOptionsFor, permValueFor } from "../lib/options.ts"
import {
  threadFollowUpBlocked,
  threadComposerStatus,
  threadPermissionBlockedReason,
  threadPermissionEffectMessage,
} from "../lib/threadPermissions.ts"
import { showToast, store } from "../store.ts"
import { ProfileGridSelector } from "../components/ProfileGridSelector.tsx"
import { Select } from "../components/ui/Select.tsx"
import { threadProfileControlState, threadProfileEffectMessage } from "../lib/threadProfile.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"

// One control strip for every place a registered thread can be steered. This lives outside the
// component module so exporting the hook does not invalidate Vite Fast Refresh for ThreadActionBar.
export function useThreadComposerControls(slug: string): { busy: boolean; footer: ReactNode; status: ReactNode } {
  const snap = useSnapshot(store)
  const thread = snap.board?.threads.find((candidate) => candidate.id === slug)
  const permission = useMutation({
    mutationFn: (permissionMode: PermissionMode) => rpc.setThreadPermission({ slug, permissionMode }),
  })
  const profiles = useQuery({
    queryKey: ["threadProfileOptions", slug],
    queryFn: () => rpc.threadProfileOptions({ slug }),
    enabled: Boolean(thread && !thread.foreign && thread.kind === "session"),
    staleTime: 5_000,
  })
  const profile = useMutation({
    mutationFn: (target: { model: string; effort: string }) => rpc.setThreadProfile({ slug, ...target }),
  })
  const localBusy = permission.isPending || profile.isPending

  // Legacy/rowless and foreign transcripts have no Fray-owned runtime profile to mutate. Keep their
  // existing composer behavior, but never render a misleading disabled "Mode unknown" control.
  if (!thread || thread.foreign || thread.kind !== "session") return { busy: localBusy, footer: null, status: null }

  // The board's pending bit is authoritative across every mounted surface (queue + drawer + another
  // tab). A local React mutation alone cannot prevent a second composer from steering the pane during
  // the backend handoff.
  const busy = localBusy || threadFollowUpBlocked(thread)

  const model = thread.model?.trim()
  const effort = thread.effort?.trim()
  const backend = thread.backend === "codex" ? "codex" : "claude"
  const displayedPermission = thread.permissionMode ? permValueFor(backend, thread.permissionMode) : undefined
  // OPTIMISTIC PENDING. Both of these controls are backed by a runtime handoff that can take a
  // half-second or more, and the board's own pending bit only appears once the server has claimed the
  // row — so picking a model used to produce NO visible response at all until it landed, which reads
  // as a dropped click and invites a second one. The in-flight mutation variables give us the exact
  // target immediately, expressed in the SAME "→ … pending" affordance the server's bit drives, so the
  // local hint and the authoritative one are indistinguishable and hand over without a flicker.
  // Deliberately NOT rendered as the applied value: the server may still answer "next-resume", and a
  // control that claims a live change it did not make is worse than a slow one.
  const optimisticProfile = profile.isPending ? profile.variables : undefined
  const optimisticPermission = permission.isPending ? permission.variables : undefined
  const pendingModel = thread.profilePendingModel ?? optimisticProfile?.model
  const pendingEffort = thread.profilePendingEffort ?? optimisticProfile?.effort
  const pendingPermissionMode = thread.permissionPending ?? optimisticPermission
  const pendingPermission = pendingPermissionMode ? permValueFor(backend, pendingPermissionMode) : undefined
  const permissionOptions = permOptionsFor(backend)
  const pendingLabel = pendingPermission ? permissionOptions.find((option) => option.value === pendingPermission)?.label : undefined
  const permissionBlocked = threadPermissionBlockedReason(thread)
  const permissionUnknown = displayedPermission === undefined
  const localPermissionBlocked = permission.isPending
    ? "Applying the permission change"
    : profile.isPending
      ? "A model and effort change is already in progress"
      : null
  const permissionControlBlocked = permissionBlocked ?? localPermissionBlocked
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
      onSuccess: (result) => showToast(threadProfileEffectMessage(result.effect)),
      onError: (e) => showToast(`Profile change failed: ${(e as Error).message.slice(0, 120)}`),
    })
  }

  function changePermission(value: string) {
    permission.mutate(value as PermissionMode, {
      onSuccess: (result) => showToast(threadPermissionEffectMessage(result.effect, backend)),
      onError: (e) => showToast(`Permission change failed: ${(e as Error).message.slice(0, 100)}`),
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
              : backend === "codex"
                ? "Change this conversation's model and effort; a running turn keeps the profile it started with"
                : "Change this conversation's model and effort; active work queues the change until a safe idle boundary"
            : "The current live backend profile is unavailable; controls fail closed"}
          disabled={busy || !catalogLoaded || !modelSelectable || profiles.isError}
          compact
          side="top"
          className="min-w-0 max-w-[min(72%,20rem)] px-1.5 py-0.5"
        />
        <Select
          variant="readout"
          value={displayedPermission ?? ""}
          onValueChange={changePermission}
          options={permissionOptions}
          placeholder="Mode unknown"
          ariaLabel={backend === "codex" ? "Thread sandbox" : "Thread permission mode"}
          title={
            (permissionUnknown ? "Current runtime permission mode is not available yet" : permissionControlBlocked) ??
            (pendingLabel
              ? `${pendingLabel} is being reconciled with backend telemetry`
              : thread.runtime === "exited"
                ? "Saved per thread and applied when this conversation resumes"
                // Codex retunes a LIVE thread in place (thread/settings/update) — nothing is reopened,
                // and the control stays usable during a turn. Say what actually happens instead of
                // borrowing Claude's reattach language.
                : backend === "codex"
                  ? "Change this conversation's sandbox; a running turn keeps the one it started with"
                  : "Reopen this idle conversation with the selected runtime permission mode")
          }
          disabled={busy || permissionUnknown || permissionControlBlocked !== null}
          indicatorPosition="right"
          side="top"
          className={`${PROMPT_CONTROL_TYPOGRAPHY_CLASS} shrink-0 px-1.5 py-0.5 ${displayedPermission ? PERMISSION_COLOR[displayedPermission] : "text-muted/50"}`}
        />
        {pendingModel && pendingEffort && (
          <span className="min-w-0 truncate text-[9px] text-muted/50">
            → {pendingModel} · {pendingEffort} {thread.profileChangeQueued ? "queued" : "pending"}
          </span>
        )}
        {pendingLabel && (
          <span className="min-w-0 truncate text-[9px] text-muted/50">
            → {pendingLabel} {thread.controlError ? "blocked" : "pending"}
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
