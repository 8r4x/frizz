#!/usr/bin/env node
// @ts-check
// Optional rest-time reminder carried by the thread's canonical scratchpad. A worker registers one
// by writing `stop_hook:` in scratch.md's YAML front matter and deregisters it by removing that key.
// The hook passes the message back verbatim when the worker tries to stop. A persisted two-minute
// cooldown prevents a forgotten reminder from creating a tight stop/block loop.
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { currentSessionId } from '../scripts/fray/config.mjs';

const COOLDOWN_MS = 2 * 60 * 1000;
const MAX_MESSAGE_CHARS = 8_000;

/** @param {string[]} argv @param {string} flag */
function flagValue(argv, flag) {
  const hit = argv.find((arg) => arg.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : null;
}

/** @param {string} value */
function inlineYamlString(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : '';
    } catch {
      return '';
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Reads only the reserved `stop_hook` key from top-of-file YAML front matter. The scratchpad body
 * remains free-form Markdown; accepting the common literal/folded block forms keeps multi-line
 * reminders readable without pulling a YAML runtime into a zero-dependency hook.
 * @param {string} source
 */
export function scratchpadStopMessage(source) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return null;
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^stop_hook:\s*(.*?)\s*$/);
    if (!match) continue;
    const value = match[1];
    if (value === '|' || value === '>-'
      || value === '>' || value === '|-' || value === '|+' || value === '>+') {
      const block = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() && !/^\s/.test(line)) break;
        block.push(line.replace(/^(?: {2}|\t)/, ''));
      }
      const text = value.startsWith('>')
        ? block.map((line) => line.trim()).join(' ').trim()
        : block.join('\n').trim();
      return text ? text.slice(0, MAX_MESSAGE_CHARS) : null;
    }
    const text = inlineYamlString(value);
    return text ? text.slice(0, MAX_MESSAGE_CHARS) : null;
  }
  return null;
}

/**
 * @param {unknown} input
 * @param {{ projectDir: string, sessionId: string, now?: number }} context
 */
export function evaluateScratchpadStop(input, context) {
  if (!input || typeof input !== 'object' || !context.sessionId) return {};
  const threadDir = join(context.projectDir, '.fray', 'threads', context.sessionId);
  let message;
  try {
    message = scratchpadStopMessage(readFileSync(join(threadDir, 'scratch.md'), 'utf8'));
  } catch {
    return {};
  }
  if (!message) return {};

  const now = context.now ?? Date.now();
  const statePath = join(threadDir, '.stop-hook-state.json');
  let lastFiredAt = 0;
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (Number.isFinite(state?.lastFiredAt)) lastFiredAt = state.lastFiredAt;
  } catch {
    // A missing/corrupt state is an unfired registration.
  }
  if (now - lastFiredAt < COOLDOWN_MS) return {};

  // Persist BEFORE blocking. If the state cannot be recorded, fail open rather than creating a stop
  // loop whose cooldown can never advance.
  const tempPath = `${statePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify({ lastFiredAt: now }) + '\n', { mode: 0o600 });
    renameSync(tempPath, statePath);
  } catch {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // best effort
    }
    return {};
  }
  return { decision: 'block', reason: message };
}

if (process.argv[1]?.endsWith('scratchpad-stop.mjs')) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const argv = process.argv.slice(2);
    const explicitSession = flagValue(argv, '--session');
    const sessionId = explicitSession || currentSessionId(input?.session_id);
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    process.stdout.write(JSON.stringify(evaluateScratchpadStop(input, { projectDir, sessionId })));
  } catch {
    process.stdout.write('{}');
  }
}
