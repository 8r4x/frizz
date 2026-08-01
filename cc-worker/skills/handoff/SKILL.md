---
name: handoff
description: The full fray end-of-turn signal reference for a fray-ui worker (invoke as fray:handoff) — every `awaiting` hint kind, the `question` fence tags (`danger`, `multi`), `done` body formatting, and worked examples of each. Your system-prompt contract carries the rules you need for the common case; load this when you are emitting an unusual fence, need a worked example of a tagged question card, or are unsure which fence a situation calls for.
---

# fray handoff reference

Your system prompt states the fence rules. This is the elaboration: the exact shapes, the tags, and
worked examples. Nothing here overrides the contract.

**Before you use any of it: is the turn actually over?** Every shape below is for a turn that has
genuinely ended. If the human's instruction still has parts left, none of them apply — you do not pick
a fence, you make the next tool call. Reaching for this reference at a milestone is the most common way
an effort dies half-finished; a verified increment, a green test run and a long turn are not endings,
and neither is announcing the next step or recording it in the scratchpad.

## Which fence?

| Situation | Fence |
|---|---|
| Ordinary handoff, turn has no other final state | **bare rest** (no fence) |
| Effort's real work is complete — code merged, plan/doc written, commissioned report finished | `done` |
| Waiting on a named third-party human, a wall-clock instant, or a PR's review | `awaiting` |
| You need the operator's input or approval | `question` |
| Mid-conversation (still working, or answering and continuing) | none |

Automatable waits — CI, releases, deploys, merge progression — are **never** `awaiting`. Dispatch a
sub-agent to own the wait, or use a `timer:` when the next check belongs at a later wall-clock time.

## `done`

Body is a bullet list, one `- ` item per completed task, each naming what shipped and where. The card
renders inline markdown: backtick every path/identifier/command, and make references real links.

```done
- Fixed the cache collision in [`src/resolver.ts`](https://github.com/acme/app/pull/391) — the lookup now keys on the normalized id.
- Added a regression test for the collision case; `npm test` green.
- Self-review folded in; `npm run lint` clean.
```

Do not write a narrative paragraph. Do not fence `done` on work that is not landed.

## `awaiting` — the three hint kinds

Lead the body with one or more `kind: value` lines, then prose naming the exact wake condition.

`pr-watch: owner/repo#NUMBER` — fray polls the PR and resumes you on ANY new activity after the fence:
a review, an approval, or a comment, from a **human or a bot alike** (review agents that post findings
as a conversation comment count exactly like a human reviewer). Baselined at the fence and durable
across a server/worker restart. Your thread **stays in the queue** as a visible "PR is up, watching it"
handoff — it does not hide in Held, because a PR whose reviews may never arrive must not silently
vanish. The human can Snooze it; new activity bumps it back.

```awaiting
pr-watch: acme/app#391
PR is open and CI is green. Watching for review — I'll address comments or merge on approval.
```

**One line watches one PR, and a fence may carry several.** The scheduler evaluates every hint in the
body, so repeat the line per PR — across any mix of repos — and activity on ANY of them wakes you. A
set of open PRs is NOT a reason to fall back to a periodic `timer:` sweep, which trades instant wakes
for a poll that can sit a day behind a review. The body keeps its first **8** hint lines and silently
drops the rest, so past 8 watch the 8 that matter and cover the tail with a `timer:`.

```awaiting
pr-watch: withastro/astro#17487
pr-watch: vitejs/vite#23019
pr-watch: strapi/strapi#26864
All three adoption PRs are open and green, in their maintainers' hands. Whichever gets a review first
wakes me and I'll address it.
```

`human: <actor + exact review/approval>` — a third party whose action cannot be supplied in this fray
conversation. **Parks you in the dimmed Held band.** A bot, automated reviewer, CI gate, or merge queue
is NOT a human wait. Pair with `pr-watch:` when a machine-readable PR exists (the `human:` supplies the
Held park, the `pr-watch:` supplies the cursor), or with `timer:` when none does.

```awaiting
human: dependabot maintainer review on dependabot/dependabot-core#15524
pr-watch: dependabot/dependabot-core#15524
The implementation and actionable checks are complete; address requested changes when review lands.
```

`timer: <ISO-8601 instant>` — the durable fray scheduler resumes you at that instant, across process
exits and restarts. The prose says exactly what to re-check.

```awaiting
timer: 2026-07-15T17:00:00Z
Re-check whether the external maintainer review arrived and reclassify any new failure.
```

`pr:` / `ci:` / `session:` remain parser compatibility for existing transcripts only. Never emit them.

### Re-entering a wait after a follow-up

Every human follow-up clears the previous fence. Never answer that you are "already parked" and never
rely on the old fence, scratchpad, or thread status: re-check the blocker, then either re-emit a fresh
`awaiting` with a current hint, or arm the active wait if it turns out to be automatable.

## `question` — the tags

Plain — an open question:

```question
Should the settings store use SQLite or a JSON file?

- A. SQLite — transactional, matches how sessions are already stored (recommended: consistency)
- B. JSON file — zero deps, human-editable, racy under concurrent writes
```

A GO/NO-GO gate has NO tag of its own — it is a plain `question` with two options, the go and the
decline. (There used to be an `approval` tag rendering one Approve button that SENT on click; it was
dropped 2026-07-26 because it couldn't express the decline and it bypassed the staging every other
block uses. A legacy `approval` token still parses — as a plain question — so old transcripts render,
but never write one.)

```question
Ready to create CONTRIBUTING.md with the draft above?

- A. Approve as-is (recommended)
- B. Hold — tell me what to change first
```

`danger` — reserve for the genuinely hard-to-undo (force-merge, deletion, history rewrite,
prod rollback). Renders in red. A routine ship is a plain question:

```question danger
Force-merge PR #391 over the failing flaky check and delete the `legacy-api` branch?

- A. Do it — the failure is the known-flaky timeout
- B. Hold — I'll wait for a green run
```

`multi` — select-several triage. Options render as checkboxes; the answer returns the chosen letters:

```question multi
Which of these findings should I fix in this pass?

- A. Null-deref in parse() — crashes on empty input
- B. Off-by-one in slice() — drops the last row
- C. Flaky timeout in the retry test — passes on rerun
```

### Rules that apply to every question

- Open the message with 2-4 sentences of status before the blocks.
- One block per independent question — never bundle.
- Lettered options, one markdown list item each, with a one-line tradeoff.
- Mark exactly one option `recommended` **on that option's line**, and put it first as `A`. Use
  `(recommended: one-line why)` to carry the rationale into the chip's tooltip. Do not use a separate
  `Recommendation:` line.
- Answerable COLD, in the human's own vocabulary — see the next section.
- A question IS the handback: no second fence.
- Before you write one, re-read the stop criterion. A question about work you were dispatched to do,
  or a fix you already recommend, is not a question.

### Write it in the human's own vocabulary

The reader has their original prompt and nothing else — not your plan, not your scratchpad, not the
transcript, not the names you settled on while working. A question that reads perfectly from inside the
session is routinely unanswerable from outside it. This is the most common defect in real question
cards, and it is entirely a wording problem: the decision was fine, the phrasing made it unavailable.

- **Translate the nomenclature you coined mid-effort.** Anything you named while working is invisible to
  the reader: phase / lane / tier / mode names, step or section numbers, "the C path", "the second
  variant", "the reconciler", "option 3 from earlier", "as in §2 of the plan". They will not go read your
  transcript to decode it, so say what the thing does instead of what you called it.
- **Minimize code identifiers; default to plain behavior.** File paths, function / type / component
  names, flags, env vars, table and column names usually cost the reader more than they give — lead with
  the behavior. Spend an identifier where it genuinely earns its place: the human already uses it, or the
  decision is literally about that name (they asked you to rename it, or to pick a flag's spelling). One
  well-chosen identifier is fine; a card assembled out of them is the failure mode.
- **Carry every decision input inside the block.** What happens today, each option's user-visible
  consequence, the cost of guessing wrong, and any number that matters. "As discussed above", a pointer
  to a file, or a reference to an earlier turn all point at something the reader cannot see from the card.
- **Define a load-bearing new term, or drop it.** If one unfamiliar word genuinely cannot be avoided,
  define it in the same sentence. Otherwise it is decoration, and it costs you the answer.

Bad — every noun here was invented during the effort, so the reader has no way into it:

```question
Should the queue lane keep the tier-2 fallback from step 3, or move to the unified resolver?

- A. Keep the tier-2 fallback (recommended)
- B. Move to the unified resolver
```

Good — same decision, stated in terms the human already owns:

```question
When you've read everything in a thread, should it stay in the "needs attention" group until you archive it, or drop out on its own?

- A. Drop out once it's read (recommended: keeps the group to threads that still need you)
- B. Stay until archived — nothing ever disappears without you acting on it
```

(That question line is deliberately unwrapped. Inside a fence a single newline is a HARD break —
`breaks: true` in the web markdown renderer — so hard-wrapping the sentence at your editor's column
renders a ragged break mid-question in the card. Keep the question, and each option, on one line.)

Test it before you send: read the block with your session forgotten, as if it were the only thing you
had ever seen about this work. Any word that only means something because of what you just did is a word
to reword.

## Never use the interactive question tool

`AskUserQuestion` (or any blocking prompt tool) would hang your session invisibly under the dashboard.
It is removed from your tool set at spawn; if you somehow reach it, a hook denies it. Use a `question`
fence.
