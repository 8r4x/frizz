import { useQuery } from "@tanstack/react-query"
import { Github } from "lucide-react"
import { rpc } from "../api/rpc.ts"
import { openGithubPicker } from "../store.ts"

// Whether the GitHub trigger will render at all. Callers that RESERVE LAYOUT for the trigger (the
// Composer's `leftAction` slot shifts the paperclip over to make room) must gate on this and pass
// nothing when it's false — a `<GithubTrigger />` element is truthy even when it renders null, so
// passing it unconditionally reserves an empty hole where the icon would be.
export function useGithubTriggerVisible(): boolean {
  const status = useQuery({ queryKey: ["githubStatus"], queryFn: () => rpc.githubStatus() })
  return Boolean(status.data?.inRepo && status.data.authed)
}

// The auth-gated door into the GitHub picker — a small GitHub icon that sits just LEFT of the dispatch
// composer's send button (maintainer 2026-07-10: not a full-width pill). Renders ONLY when gh is authed
// AND the project is a gh-resolvable GitHub repo — otherwise NOTHING (a hidden feature, not a disabled
// control). `githubStatus` is shared with App's not-signed-in hint via the query cache (one fetch);
// detection is cached server-side, `authed` re-checked live, so a later `gh auth login` surfaces it.
// No profile gating: the picker carries its own model/effort selector, so an unloaded or unavailable
// saved pair is something to FIX in there, not a reason to refuse to open.
export function GithubTrigger({ className = "" }: { className?: string }) {
  if (!useGithubTriggerVisible()) return null
  return (
    <button
      type="button"
      onClick={openGithubPicker}
      onMouseDown={(e) => e.preventDefault()}
      title="Investigate this issue and make recommendations"
      aria-label="Investigate this issue and make recommendations"
      className={`flex h-7 w-7 items-center justify-center rounded-lg text-muted outline-none transition-[color,background-color,box-shadow] enabled:hover:bg-panel-2/70 enabled:hover:text-fg enabled:focus-visible:bg-panel-2/70 enabled:focus-visible:text-muted enabled:focus-visible:ring-1 enabled:focus-visible:ring-muted/80 enabled:focus-visible:ring-offset-1 enabled:focus-visible:ring-offset-bg enabled:active:bg-elevated enabled:active:text-muted disabled:bg-transparent disabled:text-muted/35 ${className}`}
    >
      <Github size={15} strokeWidth={2} />
    </button>
  )
}
