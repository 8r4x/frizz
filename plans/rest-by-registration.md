# Rest by registration — replacing the awaiting fence with registered watchers and questions

Status: design settled with the maintainer 2026-08-26, in a grilling session. Not implemented. Two forks remain open (see [Still open](#still-open)).

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
| Policy 8 — archive with open questions | **Open.** See below. |
| Policy 9 — approval and danger dismissal | **Open.** See below. |

## Still open

Two forks the 2026-07-13 memo raised that this session's decisions make live again, both created by choices made here rather than inherited:

1. **Archive with pending questions.** `done` is gated on them, but archiving is the human's own action and nothing gates it. The memo's recommendation was to retain the open questions, suppress their queue effect, and require Reopen before answering or dismissing.
2. **Dismissing a danger-tagged or approval question.** The × is currently universal. The memo's recommendation was that non-danger question/multi kinds may be dismissed, while a non-danger *approval* and every *danger*-tagged kind require an explicit delivered Answer or Decline — a generic close icon being insufficient for something irreversible.
