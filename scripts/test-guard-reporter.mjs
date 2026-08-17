// Counts the verdicts the PARENT actually received, per file, and writes them where
// scripts/run-tests.mjs can reconcile them against each child's own tally.
//
// A reporter sits downstream of the child->parent report stream, so it sees exactly the loss this
// guard is looking for: when a child's pipe is truncated the missing verdicts never reach here
// either. The destination is a FILE, which node drains properly on force exit (unlike a pipe — the
// asymmetry that causes nodejs/node#64833 in the first place).

export default async function* testGuardReporter(source) {
  const perFile = Object.create(null);
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const file = event.data.file;
    if (!file) continue;
    perFile[file] = (perFile[file] ?? 0) + 1;
  }
  yield JSON.stringify({ perFile });
}
