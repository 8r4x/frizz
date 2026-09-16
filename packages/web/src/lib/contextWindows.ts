export const DEFAULT_AUTO_COMPACT_WINDOW = 500_000
export const AUTO_COMPACT_WINDOW_OPTIONS = [
  { value: "200000", label: "200k" },
  { value: "350000", label: "350k" },
  { value: "500000", label: "500k (default)" },
  { value: "750000", label: "750k" },
  { value: "1000000", label: "1M (maximum)" },
]

export const CONTEXT_WINDOW_HELP = {
  claude: "Compaction window for new Claude threads in this project. Applies on dispatch or after the worker exits, not to a running worker.",
  codex: "Context window for new Codex threads in this project. Each model caps the value at its own maximum. Applies on dispatch or a cold resume, not to a running worker.",
}
