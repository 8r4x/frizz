import { useQuery } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"

/**
 * Whether the permanent project rail is showing.
 *
 * ONE definition, because two surfaces depend on it and they must never both be absent: the rail
 * itself, and the status bar's home crumb, which exists precisely to be the way back when the rail
 * is not there. Defaults to HIDDEN while the query is still in flight — the rail appearing a beat
 * late is a smaller wrong than it flashing in and out on every load.
 */
export function useProjectRailVisible(): boolean {
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  return settings.data?.projectRail === true
}
