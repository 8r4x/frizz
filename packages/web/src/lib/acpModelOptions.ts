import type { AcpAgentModels } from "@frizz/shared"
import type { SelectOption } from "../components/ui/Select.tsx"

// The rows of the model dropdown beside an ACP agent's profile pill. Value "" is the agent's OWN
// default — Frizz asks for nothing and the agent opens on whatever its config names — and it is always
// the first row, so a thread never has to name a model to run. The list itself comes from the agent
// (session/new advertises it as a config option), so it is exactly what the agent will honour: an
// OpenCode signed into one provider lists that provider's models and nothing else.
export function acpModelOptions(models: AcpAgentModels | undefined, savedModelId: string | undefined): SelectOption[] {
  const current = models?.models.find((model) => model.id === models.current)
  const rows: SelectOption[] = [{
    value: "",
    label: current ? `Default · ${current.name}` : "Default",
    title: "The model the agent opens on when Frizz asks for none",
  }]
  // A saved model the agent no longer lists stays VISIBLE and verbatim rather than snapping to
  // Default: the operator chose it, and the bridge will note the refusal in the transcript if the
  // agent declines it. While the list is still loading (or failed) nothing is known either way, so
  // the saved id is shown as-is without the "(unavailable)" verdict.
  if (savedModelId && !models?.models.some((model) => model.id === savedModelId)) {
    rows.push(models && !models.error
      ? { value: savedModelId, label: `${savedModelId} (unavailable)`, title: "The agent no longer advertises this model" }
      : { value: savedModelId, label: savedModelId })
  }
  for (const model of models?.models ?? []) rows.push({ value: model.id, label: model.name, title: model.id })
  return rows
}
