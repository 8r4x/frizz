import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { CodexModel, SetDispatchPreferenceInput } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import {
  applyDispatchPreferenceUpdate,
  resolveDispatchPreferences,
  type ResolvedDispatchPreferences,
} from "../lib/dispatchPreferences.ts"

// THE durable new-thread profile (backend + model + effort), shared by every surface that starts a
// thread from the prompt box: the dispatch composer and the GitHub batch picker. Both read the same
// preference row and write it through the same scoped mutation, so a selection made in either is the
// profile the other dispatches with — there is no second, surface-local copy to drift.
export function useDispatchProfile(): {
  // Undefined until BOTH durable intent and the Codex catalogue have landed. Rendering a profile
  // before then can classify a saved Codex model as Claude merely because the catalogue is cold.
  resolved: ResolvedDispatchPreferences | undefined
  codexList: readonly CodexModel[]
  loadError: boolean
  saveProfile: (update: SetDispatchPreferenceInput) => void
} {
  const queryClient = useQueryClient()
  const preferences = useQuery({ queryKey: ["dispatchPreferencesGet"], queryFn: () => rpc.dispatchPreferencesGet() })
  // The codex model catalogue + per-model effort options, from the authoritative ~/.codex cache (never a
  // hand-maintained list).
  const codexModels = useQuery({ queryKey: ["codexModels"], queryFn: () => rpc.codexModels() })
  const codexList = codexModels.data ?? []

  const preference = useMutation({
    mutationFn: (update: SetDispatchPreferenceInput) => rpc.dispatchPreferenceSet(update),
    // TanStack serializes mutations sharing this scope. This prevents a fast pair of selections from
    // reaching SQLite out of order while optimistic query data keeps every mounted composer in sync.
    scope: { id: "dispatch-preferences" },
    onMutate: (update) => {
      const current = queryClient.getQueryData<Awaited<ReturnType<typeof rpc.dispatchPreferencesGet>>>(["dispatchPreferencesGet"])
      if (current) queryClient.setQueryData(["dispatchPreferencesGet"], applyDispatchPreferenceUpdate(current, update))
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: ["dispatchPreferencesGet"] })
      showToast(`Could not save new-thread preference: ${(error as Error).message.slice(0, 80)}`)
    },
  })

  const controlsReady = !!preferences.data && !!codexModels.data
  const resolved = useMemo(
    () => controlsReady ? resolveDispatchPreferences(preferences.data!, codexList) : undefined,
    [controlsReady, preferences.data, codexList],
  )

  return {
    resolved,
    codexList,
    loadError: preferences.isError || codexModels.isError,
    saveProfile: preference.mutate,
  }
}
