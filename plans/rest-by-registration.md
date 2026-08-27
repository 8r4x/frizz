# Rest by registration — replacing the awaiting fence with registered watchers and questions

Status: design settled with the maintainer 2026-08-26, in a grilling session. Implementation started the same day; see the checklist at the end for what has landed.

Supersedes the question half of [`persistent-stacked-questions-design.md`](persistent-stacked-questions-design.md) (2026-07-13, never built). See [Relationship to the 2026-07-13 memo](#relationship-to-the-2026-07-13-memo) for which of its forks this answers and which it dissolves.

## The shape

A worker comes to rest by **registering** what it is waiting on, not by **declaring** it in a fence. Registrations are durable rows that outlive the turn, show up to the human in the queue, and re-awaken the thread themselves.

The `` ```awaiting `` fence is deleted. So is the `` ```done `` fence and the `` ```question `` fence: all three become tool calls.

The verb surface is five tools:

| verb | what it does |
| --- | --- |
| `watch` | register a wait on an existing entity — a PR, a background shell, a sub-agent |
| `unwatch` | drop a registration |
| `ask` | register one or more questions for the human |
| `unask` | withdraw a question the worker no longer needs answered |
| `done` | mark the thread finished, with a rich markdown body |

`timer` stays its own verb, unchanged: a timer is *created*, not observed, and every other watch names something that already exists.

## Why this is not a reversal

The board already derives three of its four wait kinds from registries. A running sub-agent parks a thread with **no declaration at all**; PR watchers and timers get their rows whether or not the fence names them (`board.fenceWatchViews`). Background shells were the only fence-only kind, and the `thread_watch` registry that used to back them was retired on 2026-08-14. This finishes a migration that stalled one kind short.

## Watchers

- **Kind is explicit and validated against the target shape.** A mismatch — a PR ref registered as a shell — is refused rather than mis-registered.
- **Every registration carries a required timeout**, chosen by the worker for that particular wait. `for:` disappears; there is no single park duration any more.
- **A timeout cancels the row and re-wakes the worker**, which re-registers if the wait still matters. This forces a re-decision and stops one short timeout from waking a thread dozens of times.
- The ceiling is 24h, inherited from `AWAITING_FOR_MAX_MS`.
- **Sub-agents are auto-registered** by frizz when it sees the dispatch. The worker never calls `watch` for a child and cannot forget its way into a bump.
- A worker never watches something it intends to outlive. A dev server is not a wait; watching one is a mistake on the worker's part, not a case the gate has to handle.

### The sub-agent liveness gap, which auto-registration makes load-bearing

The two liveness mechanisms are not comparable today:

| | shells | sub-agents |
| --- | --- | --- |
| mechanism | `lsof -t` on the redirected output file — who holds this fd (`probeShellAlive`, `tailer.ts`) | mtime on the child's transcript (`entryStale`, `tailer.ts`) |
| kind of answer | exact | heuristic |
| threshold | 60s grace, 30s cache, dead verdict terminal | `SUBAGENT_STALE_MS`, 15 minutes without an append |

`tailer.ts` carries a **known hole**, audited 2026-08-02 and documented in place: the child's transcript path is parsed out of the launch ack's *prose*, so when it fails to resolve, `entryStale` returns false on every clock — that child can never go stale, and it parks its thread forever via `hasLiveOwnWork`. Measured at 61 of 4068 dispatches (1.50%), all one snake_case ack shape, all in six session files from 2026-07-08..13, so it is not in current use.

**Decision:** do the fix the comment already names — resolve the path from the sidecar index, which already maps `toolUseId` → transcript — and keep the 15-minute mtime rule. Putting a clock on the dispatch instant was tried and reverted; it regresses `tailer.descendants.test.ts`.

## Questions

- **A question is a registered object with an id frizz mints.** It persists until answered, withdrawn by the worker (`unask`), or dismissed by the human — across any number of turns and rests. This is the "one copy that sticks around" property the stop hook currently clobbers.
- **A question never ends a turn.** Registering one returns immediately; the worker banks it and keeps going on work that does not depend on the answer. Frizz cannot enforce when a worker stops, only what happens at the stop.
- **Questions carry no timeout.** A question waits on a person indefinitely. A timing-out question either re-asks as noise or silently drops something a human owes.
- **Several questions per `ask` call**, as a **static tree**: follow-ups hang off an *option*, so picking it reveals its children. **Capped at 3 levels deep.**
- **A branch not taken returns nothing.** The answered set plus the branch taken is the whole payload.
- **Input types are single-select, multi-select, free text, and per-option preview content.** Nothing further. Preview is the one addition that changes a decision — two diffs or two mockups side by side; a slider or date picker is novelty.
- **The card submits as a unit on Send**, carrying whatever was answered. Nothing half-wakes a turn.
- **The answer payload is structured, keyed by question id, and restates the question text.** The worker never saw the id — frizz minted it — so the id alone cannot be correlated back.
- **The human can dismiss a question with an ×** on its card. Dismissals do **not** wake the worker: they queue and flush with the next steer, because a human dismissing questions is almost always dismissing several in a row and is right there anyway.

## `done`

- **`done` is a tool** taking a rich markdown body, not a fence. A gate can refuse a tool call; a fence can only be bumped after the fact, by which time its card has already rendered.
- **Both pending questions and live watchers block it.** A worker must resolve or drop what it registered before it can claim to be finished.
- **There is no `force` bypass.** A bypass riding the gated call gets learned: the first refusal teaches `force: true`, it is then passed pre-emptively, and the gate degrades to a two-token tax. Any gate whose escape hatch is a parameter on the gated call is not a gate.
- Marking done is **not** dismissal. A done thread sits in the queue as a done card until the human archives it, exactly as the `` ```done `` fence behaves today.
- A worker that stops with nothing registered and no `done` is bumped for a handoff, as today.

## Autonomous mode

- **One switch carrying a customizable prompt.** Autonomy and the goal prompt collapse into a single control; the prompt is its payload.
- It lives **on the thread**, settable from the board and by the worker, shown in the footer, and flippable mid-effort.
- **The `ask` tool is present and refuses**: *"autonomous mode — decide and proceed."* The refusal lands at the exact moment of temptation, which no amount of contract text read hours earlier can do. An absent tool leaves a worker that wants to ask with nowhere to put it, and it fakes a question in prose that nothing parses.
- **Flipping into autonomous mode cancels pending questions and bumps the worker**, and the mode's prompt hands those cancelled questions back as decisions the worker now makes for itself.

## Rendering

- At rest with both outstanding, the card shows **the questions, with monitors collapsed behind a count**. The question is the actionable thing and two expanded surfaces compete for one glance.
- With watchers and no questions, the card is a **waiting card** with more richness.
- **The snooze button rides the waiting card, not a card that is actively asking.** Its snooze is not a wall-clock one — it is "put this thread into the park band until something wakes it."
- **`Held` is renamed `Snoozed`**, and survives for the human's own parks: a wall-clock snooze, an auto-resumed limit pause, and the indefinite snooze above. The worker-declared park was the only tenant this redesign removes. The rename moves the group key too, not just the label — `groups.ts` already carries the cost of a key that drifted from its label (the archived section keys on `"inactive"` while it reads "Done").

## Migration

Frizz keeps **accepting** the `` ```awaiting `` fence during the transition and converts it to registrations — it already resolves the same three handles per shell — so workers whose contract is frozen at dispatch keep parking instead of being bumped at every rest. A `` ```done `` fence is accepted ungated for the same window. Both stop being *written* as contracts refresh, then get deleted.

## Relationship to the 2026-07-13 memo

[`persistent-stacked-questions-design.md`](persistent-stacked-questions-design.md) was blocked on four forks plus five policy choices. Registration changes the ground under most of them.

**Dissolved.** That memo's entire identity apparatus — stable server-emitted `sourceMessageId`s, transcript epochs, inode rotation, byte-identical assistant messages, half-written fences creating no record, Codex `task_complete` versus `final_answer` — exists to recover question identity by *parsing markdown out of a transcript*. A registered question has an id because frizz minted it at registration. None of that machinery is needed.

| memo item | status here |
| --- | --- |
| Fork 1 — authority | **A, and now the only option.** The client never mints anything; the server is authoritative by construction. |
| Fork 2 — what marks a question addressed | **A.** Explicit answer or dismiss only, with dismiss first-class (the ×) and `unask` as the worker's own withdrawal. |
| Fork 3 — stacking UX and navigation | **Partly.** Open questions collect and render together at rest rather than staying positional. Reaching an old question from the queue is not separately settled. |
| Fork 4 — first-cut scope | **Obsolete.** There are no fenced markdown questions to scope; `ask` is the only path. |
| Policy 5 — dismissal delivery | **Neither listed option.** Not local-only, not a notify-and-wake: dismissals queue and flush on the next steer. |
| Policy 7 — submission unit | **7B, the batch.** The card submits as a unit. The memo flags per-attempt recovery UI as mandatory under this choice; that cost is taken on deliberately. |
| Policy 6 — rollout/backfill | Not revisited. |
| Policy 8 — archive with open questions | **Neither listed option.** Human archive overrides everything — it takes the questions and registrations with it. |
| Policy 9 — approval and danger dismissal | **A.** No × on an approval or a danger-tagged question; ordinary kinds keep it. The danger *styling* is toned down as part of this work. |

## Archive, and which questions the × reaches

**Human archive overrides everything.** Archiving a thread is the human's absolute action: it takes pending questions and live registrations with it, with no Reopen dance and no refusal. Nothing the worker registered can hold an archive open — the gate on `done` binds the worker, not the human.

**The × does not reach an approval or a danger-tagged question.** Those are answered or they stay pending; a generic close icon is not consent for something irreversible. Declining is a real option inside the question, not a dismissal of it. Ordinary question and multi-select kinds keep the ×.

**Danger-tagged questions look too scary and get toned down as part of this work.** They should almost never appear — the contract already scopes the tag narrowly, to force-merge, deletion, history rewrite and prod rollback — so the criteria stay and the treatment changes. Today `QuestionBlockCard` passes `tone="danger"` straight to `TranscriptCard`, which is the same full-strength red the provider-fault and sign-in-required banners wear. A question that is merely irreversible is not an error, and it should not shout like one.

## Implementation checklist

In dependency order. Independent slices first, so each lands on its own.

- [x] **Sub-agent liveness** — resolve the child transcript path from the sidecar index so `entryStale` always has a clock to run. Prerequisite for trusting auto-registration. (`5155ca7e`)
- [x] **`Held` → `Snoozed`** — label and group key. (`aa0053da`, and the vocabulary sweep that followed it.)
- [x] **Danger-question styling** — stop wearing the provider-fault red. (`3f0eab5c`, which split a `risk` tone off `danger`.)
- [x] **`watch` / `unwatch`, end to end** — the `thread_watch` table (`818eeeb3`), the RPC (`70eb4123`), the board park (`c8bf63ef`), the waker's settle-and-expire sweep (`07f6dd90`), and the two worker-facing verbs (`2f4d84c2`). Verified against a real disposable stack rather than its parts: a real MCP child → real RPC → real SQLite → real board, with a real process holding the shell's output file.
- [x] **`ask` / `unask` / `done`** — the question registry (`2318e7fe`), its RPC (`da24c124`), the answer delivery through the durable outbox (`b6bc6bce`), the two question verbs with their card (`a7d9f946`), and the gated completion verb (`ee4169b2`). Verified end to end against a real disposable stack — a real MCP child over stdio, real RPC, real SQLite, real board, real waker — all 22 assertions green, including `done` refusing while a question is open and a newer user record spending a recorded completion.
- [x] **Question rendering** — the static tree, the ×, submit-on-Send, the structured answer payload (`a7d9f946`). A registration is PRODUCER 3 of the shared question model: `QuestionBlockCard` is unchanged apart from an option-`preview` reveal and a `label`/`aside` slot, so a registered question, a fence and a native tool call cannot drift into three looks. Driven in a real browser, both fonts, with the optical pass run on the × (0.00px ink residual against the card glyph in mono and sans; 9.33px ink gap, down from 16.58).
- [x] **Autonomous mode** — the refusing `ask` and the cancel-and-wake on flip (`40f12f0d`). NO switch was built: the thread-level control the memo describes already exists and IS the Goal, whose own switch was deleted 2026-08-16 precisely because arming a Goal is that consent. Restoring it would have re-litigated a recorded decision that this memo's own "collapse into a single control" wording agrees with.
- [x] **Board** — park derived from live registrations (`c8bf63ef`), and the waiting card with its event-snooze already appears for a FENCE-FREE registration, which is the property the whole redesign rests on (asserted end to end in the `watch` e2e: `awaitingBackground === true` with no fence written). A registered question outranks that card, so nothing competes with the ask for one glance; the live waits stay listed one compact line each in the ops strip under the prompt box.
  - **NOT built: "monitors collapsed behind a count".** With the waiting card suppressed there is no second expanded surface to collapse, which is what the count was for — and a count over the two or three lines this strip usually holds would spend the same height to say less. If a card is ever seen carrying eight live ops beside a question, revisit it there rather than here.
- [x] **Contract + migration** — the worker prompt teaches every verb beside the fence it replaces (`2f4d84c2`, `a7d9f946`, `ee4169b2`, `40f12f0d`), and the standing rule now reads **"ALWAYS SIGN OFF"** rather than "always sign off with a FENCE", because frizz honours a registration as one: `done`, `ask` and `watch` each silence the sign-off nudge (`c1863973`) and a registered done ends the Goal (`6c9ca767`).
  - **NOT built: converting a fence into registrations.** The memo wanted conversion so that workers whose contract is frozen at dispatch keep parking — but the DECLARATION path was never removed, so those workers already park, and the conversion would be machinery whose only remaining benefit is unifying two code paths that both work. Writing rows on a worker's behalf, from prose, on exactly the threads this exists to protect, is a worse trade than leaving the fence path alone until it is deleted outright.
