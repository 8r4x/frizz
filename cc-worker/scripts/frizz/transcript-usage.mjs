// @ts-check
/**
 * How full the context window is, read from a Claude Code transcript. ONE copy, imported by every hook
 * that paces itself on context growth (`scratchpad.mjs`'s nudge, `stop-fence.mjs`'s reminder) — the
 * repo rule is one agent-neutral copy of shared tooling, and a second tail-reader would drift.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** How much of the transcript's tail to read. Transcripts reach tens of megabytes and the newest usage
 *  record is at the very end, so 128 KiB is generous. */
const TAIL_BYTES = 128 * 1024;

/**
 * Live context fill in tokens from the transcript's newest usage record, or null when there is none.
 *
 * Reads only the TAIL, and scans it BACKWARDS: on `PostToolUse` this runs after every single tool call,
 * and scanning backwards also means the one line the tail read may have cut in half is reached last,
 * where its parse failure is simply skipped.
 *
 * @param {string} path
 * @returns {number | null}
 */
export function contextTokens(path) {
  let fd = null;
  try {
    const size = statSync(path).size;
    const want = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(want);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const u = rec?.message?.usage;
      if (!u) continue;
      const n =
        (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
