import assert from "node:assert/strict";
import { test } from "node:test";
import { Readout, formatDuration, tildePath, visibleLength } from "./readout.ts";

class Capture {
  chunks: string[] = [];
  constructor(
    readonly isTTY: boolean,
    readonly columns = 100
  ) {}
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get raw(): string {
    return this.chunks.join("");
  }
  /** What the terminal would actually show: replay the erase-region sequences onto a line buffer. */
  get rendered(): string {
    const lines: string[] = [];
    let line = "";
    for (const chunk of this.chunks) {
      let index = 0;
      while (index < chunk.length) {
        const escape = /^\x1b\[([0-9;?]*)([a-zA-Z])/.exec(chunk.slice(index));
        if (escape) {
          index += escape[0].length;
          const [, params, final] = escape;
          if (final === "A") {
            // Rewind N rows: drop them from the buffer.
            const count = Number(params || "1");
            for (let step = 0; step < count; step++) lines.pop();
          } else if (final === "J") {
            line = "";
          }
          continue;
        }
        const char = chunk[index++]!;
        if (char === "\n") {
          lines.push(line);
          line = "";
        } else if (char === "\r") {
          line = "";
        } else {
          line += char;
        }
      }
    }
    if (line) lines.push(line);
    return lines.join("\n");
  }
}

test("formatDuration reads naturally at every magnitude", () => {
  assert.equal(formatDuration(412), "412ms");
  assert.equal(formatDuration(1_240), "1.2s");
  assert.equal(formatDuration(34_300), "34s");
});

test("paths under home are shortened so the block stays narrow", () => {
  assert.equal(tildePath("/Users/x/code/fray", "/Users/x"), "~/code/fray");
  assert.equal(tildePath("/Users/x", "/Users/x"), "~");
  assert.equal(tildePath("/opt/other", "/Users/x"), "/opt/other");
  assert.equal(tildePath("/Users/xanadu/thing", "/Users/x"), "/Users/xanadu/thing");
});

test("a TTY boot repaints one region rather than accumulating rows", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, version: "0.1.2", tickMs: 60_000 });
  readout.plan([
    { key: "workspace", label: "Workspace" },
    { key: "server", label: "Server" },
  ]);
  readout.begin("workspace");
  readout.settle("workspace", "done", "fray");
  readout.begin("server", "starting");

  const shown = out.rendered;
  // Each step appears EXACTLY once on screen despite many repaints — that is the whole point.
  assert.equal(shown.match(/Workspace/g)?.length, 1, shown);
  assert.equal(shown.match(/Server/g)?.length, 1, shown);
  assert.match(shown, /✓ {2}Workspace\s+fray/);
  assert.match(shown, /Server\s+starting/);
  // The repaint really is a rewind, not just newlines.
  assert.match(out.raw, /\x1b\[\d+A/);
});

test("the repaint is wrapped in synchronized output so a frame cannot be caught half-drawn", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  assert.match(out.raw, /\x1b\[\?2026h/);
  assert.match(out.raw, /\x1b\[\?2026l/);
  readout.stop();
});

test("rows are truncated to the terminal width so a wrap can never desynchronize the region", () => {
  const out = new Capture(true, 40);
  const readout = new Readout({ output: out, color: false, tickMs: 60_000 });
  readout.plan([{ key: "artifact", label: "Artifact" }]);
  readout.begin("artifact", "x".repeat(300));
  for (const line of out.rendered.split("\n")) {
    assert.equal(visibleLength(line) <= 39, true, `row exceeded the width: ${line.length}`);
  }
  readout.stop();
});

test("the ready block names one address, and it is the one to open", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, version: "0.1.2", tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server");
  readout.ready(
    [
      { label: "Local", value: "http://127.0.0.1:4923/", accent: true },
      { label: "Project", value: "fray — ~/code/fray" },
      { label: "Logs", value: "~/.fray/projects/abc/logs/fray-1.log" },
    ],
    "press ctrl-c to stop"
  );
  const shown = out.rendered;
  assert.match(shown, /FRAY v0\.1\.2\s+ready in/);
  assert.match(shown, /➜ {2}Local:\s+http:\/\/127\.0\.0\.1:4923\//);
  assert.match(shown, /➜ {2}Logs:\s+~\/\.fray/);
  assert.match(shown, /press ctrl-c to stop/);
  // Exactly one address — the child's private port must never appear beside it.
  assert.equal(shown.match(/http:\/\//g)?.length, 1, shown);
  // The boot steps are replaced by the block, not left above it.
  assert.equal(shown.includes("Server"), false, shown);
});

test("labels in the ready block align on one column regardless of length", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, tickMs: 60_000 });
  readout.ready([
    { label: "Local", value: "A" },
    { label: "Project", value: "B" },
  ]);
  const rows = out.rendered.split("\n").filter((line) => line.includes("➜"));
  assert.equal(rows.length, 2);
  const columns = rows.map((row) => row.indexOf(row.trimEnd().slice(-1)));
  assert.equal(columns[0], columns[1], `values must start at the same column:\n${rows.join("\n")}`);
});

test("a failure names the step it died in and where to read the whole story", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server");
  assert.equal(readout.activeStep()?.key, "server");
  readout.fail("server: port 4923 is already in use", "/tmp/logs/fray-1.log");
  const shown = out.rendered;
  assert.match(shown, /✗ {2}Fray could not start/);
  assert.match(shown, /port 4923 is already in use/);
  assert.match(shown, /Full log: \/tmp\/logs\/fray-1\.log/);
});

test("a note scrolls above the region instead of landing inside it", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server");
  readout.note("warning: tmux is old");
  const lines = out.rendered.split("\n");
  const noteRow = lines.findIndex((line) => line.includes("warning: tmux is old"));
  const stepRow = lines.findIndex((line) => line.includes("Server"));
  assert.notEqual(noteRow, -1);
  assert.equal(noteRow < stepRow, true, `the note must stay above the region:\n${out.rendered}`);
  readout.stop();
});

test("a pipe gets newline-delimited records and never an escape sequence", () => {
  const out = new Capture(false);
  const readout = new Readout({ output: out, color: false, version: "0.1.2", tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server", "starting");
  readout.settle("server", "done");
  readout.ready([{ label: "Local", value: "http://127.0.0.1:4923/" }]);
  const raw = out.raw;
  assert.equal(raw.includes("\x1b"), false, "a pipe must never receive terminal control codes");
  assert.match(raw, /fray: ··· server — starting\n/);
  assert.match(raw, /fray: done server\n/);
  assert.match(raw, /fray: ready in /);
  assert.match(raw, /fray: local: http:\/\/127\.0\.0\.1:4923\/\n/);
});

test("--debug streams records, suppresses the repaint, and does not duplicate the feed", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, debug: true, tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server", "starting");
  readout.note("12:00:00 INFO  supervisor   starting Fray");
  assert.equal(out.raw.includes("\x1b["), false, "debug mode must not repaint");
  assert.match(out.raw, /12:00:00 INFO {2}supervisor {3}starting Fray/);
  // The log feed is the authoritative account under --debug; the step rows would restate it in a
  // second format right beside it.
  assert.equal(out.raw.includes("fray: ··· server"), false, out.raw);
  // The final summary still prints — it carries the URL, which the feed does not present as such.
  readout.ready([{ label: "Local", value: "http://127.0.0.1:4923/" }]);
  assert.match(out.raw, /fray: local: http:\/\/127\.0\.0\.1:4923\//);
});

test("colour is suppressed when asked, and emitted when not", () => {
  const plain = new Capture(true);
  new Readout({ output: plain, color: false, tickMs: 60_000 }).plan([{ key: "a", label: "A" }]);
  assert.equal(/\x1b\[3\dm/.test(plain.raw), false);

  const colored = new Capture(true);
  new Readout({ output: colored, color: true, tickMs: 60_000 }).plan([{ key: "a", label: "A" }]);
  assert.equal(/\x1b\[3\dm/.test(colored.raw), true);
});
