// The worker-plugin closure: the files a `runtime/` tree MUST carry for a dispatched worker to be
// whole, and the assertion that says so loudly at build time.
//
// It lives in its own module because TWO build paths stage that tree and both must hold the same
// opinion about it: `artifacts.ts` (the frizz-dev promoted artifact, `~/.frizz/builds/<digest>/runtime`)
// and `scripts/prepare-package.mjs` (the published package, `<pkg>/runtime`). Each used to keep its own
// hand-copy of the list, so widening the closure meant editing both — and the two were only ever in
// agreement between the first edit and the second. Requiring `stop-fence.mjs` and
// `transcript-usage.mjs` is what made that obvious: the same two strings had to be typed into the
// artifact builder, the pack script and four test fixtures, and a worker whose plugin lacks them
// degrades in SILENCE, which is precisely the failure this assertion exists to prevent.
//
// `scripts/*.mjs` imports this .ts directly, as publish-manifest.mjs already does with its own half.
import { existsSync } from "node:fs";
import { join } from "node:path";

// The worker contract used to ship as markdown under runtime/prompts/ and get read at dispatch time;
// it is now compiled into the server bundle (workerPrompt.ts), so a promoted artifact carries no
// prompt closure. Old artifacts that still list prompts/ files remain valid (extra runtimeFiles are
// harmless); nothing reads them.
export const WORKER_PLUGIN_REQUIRED_FILES = [
  "cc-worker/.claude-plugin/plugin.json",
  "cc-worker/hooks/session-seed.mjs",
  "cc-worker/hooks/agent-bind.mjs",
  "cc-worker/hooks/stop-fence.mjs",
  // scratchpad.mjs and stop-fence.mjs both IMPORT this one, so an artifact missing it does not degrade
  // — the hooks throw on load and the worker silently loses its nudges and its fence check.
  "cc-worker/scripts/frizz/transcript-usage.mjs",
  "cc-worker/bin/frizz",
  "cc-worker/bin/frizz-update",
  "board/config.mjs",
  "board/agent-bindings.mjs",
  "board/index.mjs",
  "board/thread-update.mjs",
] as const;

/** Throw unless `root` (a staged `runtime/` tree, or the repo root it mirrors) holds every entry. */
export function assertWorkerPluginClosure(root: string): void {
  for (const file of WORKER_PLUGIN_REQUIRED_FILES) {
    if (!existsSync(join(root, file)))
      throw new Error(`Frizz worker plugin closure is missing ${file}`);
  }
}
