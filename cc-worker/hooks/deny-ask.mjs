#!/usr/bin/env node
// @ts-check
// PreToolUse hook on AskUserQuestion (frizz-worker). A frizz worker runs under a dashboard, not a
// live chat: an interactive question prompt would hang the session invisibly (nobody is at the
// keyboard to click it). Deny with a redirect to the async pattern: ask in the FINAL MESSAGE via one
// or more ```question fenced blocks, then come to rest; answers arrive as the next user message.
// GATE: inert unless FRIZZ_THREAD is set. FAIL OPEN on parse errors.
//
// SECOND GATE: also inert when FRIZZ_NATIVE_ASK=1. The premise above — "nobody is at the keyboard" —
// is only true where the question has nowhere to go. On the Claude session-broker path frizz now
// intercepts the call at canUseTool and renders it as a real question card on the dashboard, which the
// operator answers and which returns the chosen labels to the tool. The broker bridge sets that var
// only when an InteractionStore is actually wired to render and resolve the card, so a denial here
// would block a question the operator CAN see. Any other path leaves the var unset, so it keeps the
// deny plus the ```question redirect.
import { readFileSync } from 'node:fs';

const slug = process.env.FRIZZ_THREAD;
if (!slug) process.exit(0);
if (process.env.FRIZZ_NATIVE_ASK === '1') process.exit(0);

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
        'Interactive prompts freeze headless workers (no one is at the keyboard to answer). Ask in your FINAL MESSAGE instead, using one or more ```question fenced blocks — each self-contained (context + the specific question + lettered `- A. …` options + a Recommendation); the frizz Queue renders each as a card and the human replies "A"/"2"/prose in the composer. A ```question block IS the handback: write it and END YOUR TURN (do NOT also add a done/awaiting fence, and do NOT invoke this tool again) — the human answers from the queue.',
    },
  }),
);
process.exit(0);
