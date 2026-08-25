import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useLocation } from "react-router"
import { rpc } from "../api/rpc.ts"

/**
 * Whether the permanent project rail is showing.
 *
 * ONE definition, because two surfaces depend on it and they must never both be absent: the rail
 * itself, and the status bar's home crumb, which exists precisely to be the way back when the rail
 * is not there. Defaults to HIDDEN while the query is still in flight — the rail appearing a beat
 * late is a smaller wrong than it flashing in and out on every load.
 *
 * THE CACHE ENTRY IS PER PROJECT, AND THIS HOOK OUTLIVES A PROJECT. `["settingsGet"]` hashes under
 * the project the URL names at RENDER time (lib/queryKeyScope.ts), and the layout that calls this
 * hook is mounted once and never re-rendered by a navigation — so without the `useLocation()` below
 * it stayed bound to whichever project's entry it was cold-loaded on. The settings drawer, which
 * only ever mounts inside a board, writes its save under the CURRENT project's entry. Cold-load `/`,
 * click into a project, flip "Project sidebar" to "Always shown": the select flipped and the rail
 * did not, until a reload happened to land on a board (maintainer 2026-08-24: "it literally only
 * shows up when I'm in the home page"). Reading the location re-renders this on every navigation,
 * so the key re-hashes under the project now on screen — the same entry the drawer writes.
 *
 * `keepPreviousData` is what keeps that re-hash from blinking: the new project's entry starts empty
 * and the rail would drop out for the round trip. `projectRail` is a MACHINE setting (server
 * settings.ts), so the previous project's answer is the right placeholder, not merely a tolerable one.
 */
export function useProjectRailVisible(): boolean {
  useLocation()
  const settings = useQuery({
    queryKey: ["settingsGet"],
    queryFn: () => rpc.settingsGet(),
    placeholderData: keepPreviousData,
  })
  return settings.data?.projectRail === true
}
