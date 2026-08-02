#!/usr/bin/env node
// @ts-check
// PreToolUse hook on AskUserQuestion (fray-worker). A fray-ui worker runs under a dashboard, not a
// live chat: an interactive question prompt PARKS the turn, and a parked turn cannot be steered —
// every follow-up the operator sends queues up unread behind it. Deny with a redirect to the async
// pattern: ask in the FINAL MESSAGE via one or more ```question fenced blocks, then come to rest;
// answers arrive as the next user message.
// GATE: inert unless FRAY_UI_THREAD is set. FAIL OPEN on parse errors.
//
// This hook is the BACKSTOP, not the primary: both Claude transports now drop the tool outright
// (WORKER_DISALLOWED_TOOLS — the tmux argv's --disallowedTools=, the broker's SDK `disallowedTools`),
// so a worker should never reach here. It stood down between 2026-07-27 and 2026-08-02, while fray
// rendered the call as a real dashboard question card. That was reverted because the card was never the
// problem: a native ask PARKS the turn, so the operator's follow-ups queue up unread behind it and the
// only way out is answering that one card. A ```question fence ends the turn instead.
import { readFileSync } from 'node:fs';

const slug = process.env.FRAY_UI_THREAD;
if (!slug) process.exit(0);

try {
  JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // fail open — a broken hook must never halt work
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Interactive prompts freeze a fray worker: the turn parks until someone answers, and every follow-up the operator sends queues up behind it unread. Ask in your FINAL MESSAGE instead, using one or more ```question fenced blocks — each self-contained (context + the specific question + lettered `- A. …` options + a Recommendation); the fray-ui Queue renders each as a card and the human replies "A"/"2"/prose in the composer. A ```question block IS the handback: write it and END YOUR TURN (do NOT also add a done/awaiting fence, and do NOT invoke this tool again) — the human answers from the queue.',
    },
  }),
);
process.exit(0);
