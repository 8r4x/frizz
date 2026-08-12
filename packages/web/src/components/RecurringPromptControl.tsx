import { useEffect, useRef, useState } from "react"
import { Target } from "lucide-react"
import {
  RECURRING_PROMPT_MAX,
  DEFAULT_GOAL_TRIGGERS,
  DEFAULT_RECURRING_PROMPT,
  type ThreadView,
} from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { formatAgo } from "../lib/durationLabels.ts"
import { INK_TRIM_GOAL } from "../lib/iconRhythm.ts"
import { showToast } from "../store.ts"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"
import { Switch } from "./ui/Switch.tsx"

// THE GOAL PANEL: one glyph in the thread footer holding what this thread is TRYING TO ACHIEVE, which
// frizz re-sends so the operator does not have to type it again.
//
// It was called "the recurring prompt" until 2026-08-11, which named the MECHANISM rather than the
// content and left the panel describing itself by how it is delivered. What an operator writes here is
// the goal; the switches below it are only WHEN it arrives.
//
// ONE piece of text, and up to three independent reasons to send it:
//
//   STOP HOOK  (scheduler SOURCE 5) — every time the thread comes to REST. No clock, nothing to tune:
//     if it stopped, it is prompted. This is the one that drives an effort forward.
//   HEARTBEAT  (scheduler SOURCE 4) — every N minutes, consulting nothing about what the thread is
//     doing, and DELIVERED MID-TURN. This is the one that reaches a thread that never stops.
//
// NEITHER MECHANISM ON IS THE OFF STATE, and that is why this panel has no third master switch. It used to
// be two separate features with two prompts and two enable toggles; the argument for keeping them apart
// rested on a delivery rule that no longer holds (while a beat waited for rest, a schedule could only
// ever fire AT a rest, where the rest trigger had already fired — same words, same instant). Once
// mid-turn delivery pulled them apart, "nudge this whenever it stops, and at least every N minutes even
// if it doesn't" became one intent costing two prompts to express. Maintainer 2026-08-03, on the master
// switch: "we can delete the top-level toggle since you can now achieve that by just disabling both of
// the other two toggles."
//
// The trigger renders ALWAYS, muted when nothing is armed — a control that only appears once its own
// feature is on cannot be used to turn the feature on. That makes it the one permanent child of the
// footer's left cluster, where everything else is a reading that hides itself when it has nothing to say.
export function RecurringPromptControl({ thread }: { thread: ThreadView }) {
  const [open, setOpen] = useState(false)
  const armed = thread.recurringPrompt
  // COLOURED IF ANY MECHANISM IS LIVE. The glyph answers one question — "is frizz going to re-prompt
  // this thread on its own?" — and any one of them is a yes.
  const live = armed?.stopHook === true || armed?.heartbeat === true || armed?.postCompaction === true

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* No tooltip. This trigger used to carry one that printed the WHOLE armed prompt on hover — a
          second, uninvited panel covering the footer every time the pointer crossed a 12px glyph
          (maintainer 2026-08-02: "the hover-based popover is silly"). The prompt has one home now, and
          you get there by clicking. */}
      <PopoverTrigger asChild>
        <button
          type="button"
          data-recurring-prompt
          data-recurring-prompt-on={live ? "true" : "false"}
          aria-label={live ? "Goal (on)" : "Goal"}
          className={`flex items-center rounded-md px-0.5 py-0.5 outline-none ${INK_TRIM_GOAL}`}
        >
          {/* A TARGET, and the ONLY surface that says this exists (the rail deliberately carries no
              mark — see groups.ts).

              The mark has now been three things, and each replacement fixed a real misreading. It was a
              square-in-a-circle (`CircleStop`), which in a strip whose other children are live verbs
              read as a stop button — "it seems like clicking it would cause the entire session to stop"
              (maintainer 2026-08-03). It became a `HeartPulse`, which said the true opposite thing:
              something is keeping this thread beating.

              The heartbeat stopped being true on 2026-08-11, when the panel was renamed GOAL. A
              heartbeat names ONE of the three triggers — and not the important one. What the panel
              holds is the thing the thread is trying to achieve, re-sent on whichever triggers the
              operator picked, so the mark is the goal rather than the delivery mechanism. Concentric
              rings survive 12px where lucide's `Goal` (a post and a ball) turns to mush.

              GREY by default and coloured only while something is actually armed: the footer's left
              cluster is a status strip first, so a control with nothing to report has to read as quiet
              as the empty slot it would otherwise leave. Amber, not the app's accent yellow, so it
              reads as a state rather than the focus motif.

              QUIET, NOT DIMMER THAN ITS NEIGHBOURS. This was `text-muted/45` against the meter's and
              the hourglass's `text-muted/60`, and the left cluster consequently read as three marks
              from three different families (maintainer 2026-08-04: "the icon brightnesses and spacing
              look absolutely terrible"). The cluster is one status group, so it takes one tone — the
              armed/idle distinction is carried by the amber, which is the state worth seeing, and not
              by holding the resting glyph a step below the readouts beside it. */}
          <Target size={12} className={live ? "text-amber-400/90" : "text-muted/60 hover:text-muted"} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        // WIDE, and it takes the whole viewport when the viewport is small. A 21rem cap made this a
        // narrow column for prose that can run to 4000 characters, and on a phone-width screen it was
        // narrower than the space actually available. The panel is a writing surface, so it is sized
        // like one: ~110 columns where there is room, everything-minus-a-margin where there is not.
        className="w-[min(46rem,calc(100vw-1.5rem))] p-3 text-[11px] leading-relaxed text-fg"
        // Radix otherwise autofocuses the first focusable child, which is a toggle segment — and a focus
        // ring sitting on "Off" reads as the toggle being SET to off by the act of opening the panel.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <PromptPanel thread={thread} armed={armed} />
      </PopoverContent>
    </Popover>
  )
}

// The schedule is a NUMBER OF MINUTES, typed. It began as a dropdown of round presets and that was
// wrong twice over: it decided for the operator which cadences were reasonable (the whole point of
// making the schedule modifiable was that they know and we do not), and it read the interval back in
// mixed units — "Every 2 hr" for a thing whose every other surface counts minutes. Minutes are the unit
// now, everywhere, and any number in range is allowed.
//
// The bounds are the schema's, restated here only so the input can enforce them at the point of typing:
// a 1 minute floor (a delivery is read at the agent's next tool boundary, so faster buys no promptness)
// and 24 hours.
const MIN_MINUTES = 1
const MAX_MINUTES = 24 * 60
const DEFAULT_INTERVAL_SECONDS = 600

interface Draft {
  text: string
  stopHook: boolean
  heartbeat: boolean
  postCompaction: boolean
  /** The HOLD, not a fourth trigger: while it is on, none of the three is sent for as long as the thread
   *  is waiting on the human. */
  pauseOnQuestions: boolean
  seconds: number
}

/** The cadence a draft actually carries, resolved from the STRING in the minutes field rather than from
 *  the last committed number. The field commits on blur, and dismissing the panel does not always blur it
 *  — Escape removes the input from the DOM before any blur fires — so reading the committed value alone
 *  silently discarded a cadence the operator had typed and could plainly see. Measured on the running app:
 *  type 55 over a 25-minute schedule, press Escape, reopen ⇒ still 25.
 *
 *  Out of range, empty or unparseable falls back to what is already stored, which is what makes this safe
 *  to resolve on every draft rather than only on commit. So does the first clause: a cadence the field can
 *  only ROUND (a worker may arm 90 seconds; the field can only say "2") reads back as the number already
 *  stored, so a dismiss that changed nothing writes nothing. */
export function draftIntervalSeconds(minutes: string, seconds: number): number {
  if (minutes === String(Math.round(seconds / 60))) return seconds
  const parsed = Math.round(Number(minutes))
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, parsed)) * 60
    : seconds
}

// THE ONE DRAFT WHOSE AUTOSAVE FAILED, held outside the panel because the panel is already gone by the
// time it can know: dismissing IS the save gesture, so a write that is refused takes the operator's text
// down with the subtree that was holding it. Reproduced on the running app — arm a thread whose session
// has since been replaced, type, click out: a toast names the refusal and there is nothing left to retry
// from. The next open of that same thread seeds from this instead of the server's row, so the text is in
// front of them again, and the next dismissal tries the write again.
//
// ONE entry, not a map: it is a rescue, not a draft store, and a single slot cannot grow without bound.
let rescued: { slug: string; draft: Draft } | null = null

/** A draft in the shape the `sent` mirror keeps it — the same fields, with the text under the name the
 *  server row uses. One converter so a new field cannot be added to the draft and silently forgotten by
 *  the mirror, which is what makes the "nothing changed, send nothing" check trustworthy. */
function draftAsSent(d: Draft) {
  return {
    prompt: d.text.trim(),
    stopHook: d.stopHook,
    heartbeat: d.heartbeat,
    postCompaction: d.postCompaction,
    pauseOnQuestions: d.pauseOnQuestions,
    seconds: d.seconds,
  }
}

/** Does this panel open PRE-FILLED — the standard sentence, stop hook on — rather than empty?
 *
 *  Only for a thread that has nothing armed, because an armed row's own words are the thing to show.
 *  And never for an ARCHIVED one: the server refuses to arm a shelved thread (router
 *  `assertRecurringPromptArmable`), and since there is no Save button the seeded draft would be written
 *  by the dismissal — so merely LOOKING at a shelved thread's panel would end in an error toast.
 *
 *  Extracted and exported so the test beside this file can pin all three branches cheaply. Both are
 *  ALSO driven in a real browser — an archived thread's panel opens empty and its dismissal writes
 *  nothing. Watch the selector when you re-check that: `/thread/<slug>` leaves the BOARD rendered
 *  behind the drawer, and a rested thread's queue card carries its own footer, so an unscoped
 *  `querySelector("[data-recurring-prompt]")` finds the board's heart rather than the drawer's and
 *  reports the wrong thread's panel. Scope to `[role=dialog]`. */
export function seedsDefaults(
  thread: Pick<ThreadView, "archived">,
  armed: ThreadView["recurringPrompt"],
): boolean {
  return !thread.archived && !armed
}

/** What will actually happen, as one clause per ARMED trigger. With three of them a nested ternary can
 *  no longer say what is on — and an operator who misreads which trigger they armed waits for a delivery
 *  that is never coming. Empty when nothing is armed; the callers phrase that case themselves. */
function triggerClauses(d: Pick<Draft, "stopHook" | "heartbeat" | "postCompaction" | "seconds">): string[] {
  return [
    d.stopHook ? "at every rest" : null,
    d.heartbeat ? `every ${Math.round(d.seconds / 60)} min` : null,
    d.postCompaction ? "after every compaction" : null,
  ].filter((c): c is string => c !== null)
}

function PromptPanel({ thread, armed }: {
  thread: ThreadView
  armed: ThreadView["recurringPrompt"]
}) {
  const [busy, setBusy] = useState(false)
  // WHAT AN UNARMED PANEL OPENS WITH, and it is a real default rather than an empty form: the standard
  // sentence, with the stop hook on. The reason an operator opens this control is almost always the same
  // one, and there is no Save button to press — so accepting the default costs exactly one dismissal, and
  // typing over it costs what typing always cost (maintainer 2026-08-11: "default recurring prompt should
  // be …", "make Stop Hook checked by default").
  //
  // NOT on an archived thread — see `seedsDefaults`, which carries the reason and the test.
  const seedDefaults = seedsDefaults(thread, armed)
  // The panel's own draft. Seeded when this MOUNTS (the popover unmounts its content on close, so that is
  // once per open) rather than tracked live, so a board refresh mid-sentence cannot rewrite what the
  // operator is typing or dictating. From the server row — unless the last dismissal of THIS thread's
  // panel failed to save, in which case that draft is what they were last looking at and the row is not.
  const carried = rescued?.slug === thread.id ? rescued.draft : null
  const [text, setText] = useState(carried?.text ?? armed?.prompt ?? (seedDefaults ? DEFAULT_RECURRING_PROMPT : ""))
  const [stopHook, setStopHook] = useState(carried?.stopHook ?? armed?.stopHook ?? (seedDefaults && DEFAULT_GOAL_TRIGGERS.stopHook))
  const [heartbeat, setHeartbeat] = useState(carried?.heartbeat ?? armed?.heartbeat ?? false)
  const [postCompaction, setPostCompaction] = useState(carried?.postCompaction ?? armed?.postCompaction ?? false)
  // ON with the stop hook, and for the stop hook's sake: a thread told "keep going" that has stopped to
  // ASK you something must not be told it again while it waits (maintainer 2026-08-11, of this switch:
  // "shoujld be ON BY DEFAULT"). Seeded like every other default here — only for an unarmed, unshelved
  // thread — so an existing row keeps whatever its operator chose.
  const [pauseOnQuestions, setPauseOnQuestions] = useState(carried?.pauseOnQuestions ?? armed?.pauseOnQuestions ?? (seedDefaults && DEFAULT_GOAL_TRIGGERS.pauseOnQuestions))
  const [seconds, setSeconds] = useState(carried?.seconds ?? armed?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS)
  // The minutes field is a STRING while it is being typed, so a half-typed value ("", "1" on the way to
  // "120") is not immediately clamped out from under the caret. It becomes a number on commit.
  const [minutes, setMinutes] = useState(String(Math.round((carried?.seconds ?? armed?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) / 60)))
  const textarea = useRef<HTMLTextAreaElement>(null)
  // What was last SENT, so a blur or a close can skip a round-trip when nothing actually changed —
  // otherwise every stray click through the panel re-arms the row and mints a new generation.
  //
  // SEEDED FROM THE SERVER ROW, never from the defaults above — which is exactly what makes the default a
  // default: the panel opens already differing from what is stored, so the dismissal that follows writes
  // it. An untouched open of an ALREADY-ARMED thread still matches and still writes nothing.
  const sent = useRef({
    prompt: armed?.prompt ?? "",
    stopHook: armed?.stopHook ?? false,
    heartbeat: armed?.heartbeat ?? false,
    postCompaction: armed?.postCompaction ?? false,
    pauseOnQuestions: armed?.pauseOnQuestions ?? false,
    seconds: armed?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
  })

  /** THE WHOLE PANEL AS ONE VALUE, which is what every save sends. The cadence comes from the minutes
   *  FIELD (see `draftIntervalSeconds`), so a number typed and never blurred travels with everything else
   *  instead of being dropped by whichever dismissal did not happen to blur it. */
  const draft = (over?: Partial<Draft>): Draft => ({
    text,
    stopHook,
    heartbeat,
    postCompaction,
    pauseOnQuestions,
    seconds: draftIntervalSeconds(minutes, seconds),
    ...over,
  })

  // AUTOSAVE ON DISMISS. Closing the popover destroys this subtree, and dismissing is how the panel is
  // normally left — by clicking out of it, by Escape, by clicking the trigger again — so the unmount is
  // the save, and it is the ONLY save for anything not already written by its own control.
  const latest = useRef<Draft>(draft())
  latest.current = draft()
  // Through a REF, because the cleanup below captures the render that armed it. `persistNow` closes over
  // the `thread` prop, and a thread whose session was replaced while the panel sat open would otherwise
  // autosave against the id it had when the panel OPENED — refused by the server, draft lost, for a
  // reason that had stopped being true.
  const persistRef = useRef<(next: Draft) => Promise<boolean>>(() => Promise.resolve(true))
  persistRef.current = (next) => persistNow(next)
  useEffect(() => () => { void persistRef.current(latest.current) }, [])

  // Writes go ONE AT A TIME. Leaving the panel fires two of them — the focused field's blur and the
  // unmount — and `sent.current` only catches up when a write RETURNS, so an unserialised pair sends the
  // same row twice and, if they land out of order, the older one reverts the toggle that was just moved.
  const queue = useRef<Promise<boolean>>(Promise.resolve(true))
  function persistNow(next: Draft): Promise<boolean> {
    const run = queue.current.catch(() => false).then(async () => {
      const ok = await persistDraft(next)
      // The rescue slot holds one fact: this thread has a draft the server has NOT got. A refusal puts it
      // there; anything that leaves the row matching — a landed write, or a draft that already matched —
      // takes it back out, so a reopen never resurrects text the server is already holding.
      if (ok) { if (rescued?.slug === thread.id) rescued = null }
      else rescued = { slug: thread.id, draft: next }
      return ok
    })
    queue.current = run
    return run
  }

  /** Resolves TRUE when the server row matches this draft — either it already did, or the write landed.
   *  FALSE only on a failed write, which is what puts the draft in the rescue slot above: the panel is
   *  already gone by then, and the operator needs the text back in front of them to retry. */
  async function persistDraft(next: Draft): Promise<boolean> {
    const prompt = next.text.trim() || null
    const unchanged = prompt === (sent.current.prompt || null)
      && next.stopHook === sent.current.stopHook
      && next.heartbeat === sent.current.heartbeat
      && next.postCompaction === sent.current.postCompaction
      && next.pauseOnQuestions === sent.current.pauseOnQuestions
      && next.seconds === sent.current.seconds
    if (unchanged) return true
    // Nothing armed and nothing typed — flipping a trigger before writing anything has nothing to
    // persist yet. Keep the local flip and let the first real text carry it up.
    if (prompt === null && !armed) {
      sent.current = { ...draftAsSent(next), prompt: "" }
      return true
    }
    setBusy(true)
    try {
      await rpc.setThreadRecurringPrompt({
        slug: thread.id,
        sessionId: thread.sessionId ?? "",
        prompt,
        stopHook: next.stopHook,
        heartbeat: next.heartbeat,
        postCompaction: next.postCompaction,
        pauseOnQuestions: next.pauseOnQuestions,
        // ALWAYS sent alongside a prompt, even while the schedule trigger is OFF. Gating this on
        // `heartbeat` looked right and silently destroyed data: switching the schedule off sent no
        // cadence, storage cleared the column, and reopening the panel showed the 10-minute default —
        // so an operator who parked a 30-minute schedule got 10 back when they switched it on again,
        // with nothing to indicate their number had been discarded. Caught in the browser, not by a
        // test: every unit here asserted on rows that still had a cadence.
        ...(prompt === null ? {} : { intervalSeconds: next.seconds }),
      })
      sent.current = { ...draftAsSent(next), prompt: prompt ?? "" }
      // The toast names WHAT WILL HAPPEN, not which switch moved. "On"/"off" was legible when there was
      // one toggle per feature and is ambiguous the moment two triggers share a row.
      const clauses = triggerClauses(next)
      showToast(
        prompt === null ? "Goal cleared"
          : clauses.length === 0 ? "Goal saved — no trigger is on, so nothing is sent"
          : `Goal: sent ${clauses.join(", ")}`,
      )
    } catch (error) {
      showToast((error instanceof Error ? error.message : "Could not save the recurring prompt").slice(0, 100))
      return false
    } finally {
      setBusy(false)
    }
    return true
  }
  const persist = () => void persistNow(draft())
  // Clamp on COMMIT, not on keystroke. An out-of-range or empty field snaps back to something legal and
  // the field is rewritten to match, so what the operator sees is always what was actually stored.
  function commitMinutes(): void {
    const next = draftIntervalSeconds(minutes, seconds)
    setMinutes(String(Math.round(next / 60)))
    setSeconds(next)
    void persistNow(draft({ seconds: next }))
  }
  // The far end of the header belongs to the reading, not to a control. Each trigger keeps its own clock,
  // so this names WHICH one last fired rather than implying they share a stamp — and only while exactly
  // one has ever fired, because "last sent at rest" over a row where the schedule fired more recently
  // would be a lie. With more than one stamp it reports the newest instant unqualified.
  const stamps = [
    { at: armed?.lastRestFiredAt, how: "at rest" },
    { at: armed?.lastScheduleFiredAt, how: "on schedule" },
    { at: armed?.lastCompactFiredAt, how: "after a compaction" },
  ].filter((s): s is { at: string; how: string } => s.at !== undefined)
  const newest = stamps.reduce<{ at: string; how: string } | undefined>(
    (best, s) => (best && Date.parse(best.at) >= Date.parse(s.at) ? best : s),
    undefined,
  )
  const lastLabel = newest === undefined ? null
    : stamps.length > 1 ? `Last sent ${formatAgo(newest.at)}`
    : `Last sent ${newest.how} ${formatAgo(newest.at)}`

  return (
    <section data-recurring-panel>
      <div className="mb-2 flex items-center gap-3">
        <span className="font-medium">Goal</span>
        {lastLabel && <span className="ml-auto truncate text-muted/55">{lastLabel}</span>}
      </div>
      {/* ALWAYS EDITABLE. It used to be `readOnly` until a master toggle was on, which made sense while
          that toggle was the feature's on switch. With the switch gone, gating the textarea on "some
          trigger is on" would mean an operator has to decide WHEN to send a prompt before they are
          allowed to write it — backwards. Write first, then pick the triggers. */}
      <textarea
        ref={textarea}
        data-recurring-text
        value={text}
        maxLength={RECURRING_PROMPT_MAX}
        onChange={(e) => setText(e.target.value)}
        onBlur={persist}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault()
            persist()
          }
        }}
        placeholder="What is this thread trying to achieve?"
        // `field-sizing: content` — the browser sizes the box from what is in it. It replaced a flat
        // `rows={4}`, which made a prompt that can run to 4000 chars a four-line peephole you scrolled
        // your own writing through. `min-h`/`max-h` are the only bounds it needs.
        //
        // Deliberately NOT a JS auto-grow (maintainer 2026-08-02: "this should be a browser-native
        // style, you shouldn't need to write JavaScript auto-grow logic"). The measure-and-set version
        // is also the one that broke: driven from an effect it ran with a null ref, because the panel
        // mounts behind a Radix portal a render later, and never ran again. Chromium ≥123.
        className="field-sizing-content max-h-[28vh] min-h-[4rem] w-full resize-none overflow-y-auto rounded-md border border-border bg-bg px-2 py-1.5 text-[12px] leading-snug text-fg outline-none placeholder:text-muted/50 focus:border-border-strong"
      />
      {/* THE THREE MECHANISMS, one per line under the text they all send. They are NAMED — Stop hook,
          Heartbeat, Compaction — rather than described, because those are the names everything else in
          frizz uses for them: the scheduler's passes, the delivery fence prefixes, the trailer on every
          delivered message, and the divider the chat renders. A panel that called them anything else
          would be the only surface with its own vocabulary.

          A THREE-COLUMN GRID (switch · name · gloss), not a flex row. Several mechanisms on one line was
          unreadable — the eye grouped "…it stops [Off|On] every 30 min" and the first control read as a
          separator between the two phrases rather than the end of the first. Stacked, each row says what
          it is and when it fires.

          THE SWITCH LEADS THE ROW, where it used to sit between the name and the gloss. Two reasons, and
          the second is the one that shows: a column of switches down the left edge is the shape every
          settings list has, so it scans as one list of booleans rather than three sentences with a
          control wedged into each; and the name column no longer has to be `auto`-sized against the
          longest label, so adding a row can never shove the controls sideways (which is precisely the
          hazard the Compaction row's comment below had to be written about).

          `items-baseline`, NOT `items-center` — the switch places itself on the text's CAP BAND and needs
          a shared baseline to do it (see ui/Switch.tsx). Centring the boxes instead read 1.45px low in
          the mono font while measuring clean in sans, which is the whole reason the correction is
          computed from `cap` rather than fitted. */}
      <div className="mt-3 grid grid-cols-[auto_auto_1fr] items-baseline gap-x-2.5 gap-y-2">
        <Switch
          testId="stop-hook"
          label="Stop hook"
          checked={stopHook}
          disabled={busy}
          onChange={(next) => {
            setStopHook(next)
            void persistNow(draft({ stopHook: next }))
            if (next && !text.trim()) requestAnimationFrame(() => textarea.current?.focus())
          }}
        />
        <span className={`font-medium ${stopHook ? "text-fg" : "text-muted"}`}>Stop hook</span>
        {/* "WITHOUT ASKING YOU SOMETHING" is not decoration — it is the trigger's actual contract. A rest
            whose final message carries a ```question fence is never bumped, whatever these switches say
            (scheduler.ts `restMessageAsksAQuestion`), because the fence IS the answer to the question the
            stop hook asks. A gloss that still promised "every time" would be the one surface claiming a
            delivery the scheduler declines to make. */}
        <span className="text-muted">every rest where it is not asking you something</span>

        <Switch
          testId="heartbeat"
          label="Heartbeat"
          checked={heartbeat}
          disabled={busy}
          onChange={(next) => {
            setHeartbeat(next)
            void persistNow(draft({ heartbeat: next }))
            if (next && !text.trim()) requestAnimationFrame(() => textarea.current?.focus())
          }}
        />
        <span className={`font-medium ${heartbeat ? "text-fg" : "text-muted"}`}>Heartbeat</span>
        {/* THE CADENCE IS CONDITIONAL: the field exists only while the heartbeat is on, because a number
            you cannot act on is a number you have to ignore. The gloss it leaves behind is not decoration
            — without it the row collapses to a name and a switch, the two rows stop being the same shape,
            and the panel jumps every time this is toggled. Same reason the wording stays parallel:
            "every … min, even mid-turn" and "on a clock, even mid-turn" are the same sentence with the
            number removed. */}
        {heartbeat ? (
          <span className="flex items-center gap-1.5 text-muted">
            every
            {/* Sized to its content (4ch fits 1440) with tabular digits, so the box does not twitch as
                the number changes. */}
            <input
              type="number"
              data-recurring-minutes
              inputMode="numeric"
              min={MIN_MINUTES}
              max={MAX_MINUTES}
              disabled={busy}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              onBlur={commitMinutes}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitMinutes() } }}
              aria-label="Heartbeat interval in minutes"
              className="w-[4.5ch] rounded-md border border-border bg-bg px-1 py-[3px] text-center text-[11px] leading-none tabular-nums text-fg outline-none focus:border-border-strong disabled:opacity-45 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            min, even mid-turn
          </span>
        ) : (
          <span className="text-muted">on a clock, even mid-turn</span>
        )}

        {/* POST-COMPACTION (scheduler SOURCE 7). Named for the event rather than the mechanism, unlike
            its two neighbours, because "compaction" IS the name everything uses for it — there is no
            frizz-coined term to be consistent with. It sits last because it is the only one that fires on
            something the harness does rather than on something the thread or the clock does.

            ONE WORD, not "After compaction". It was measured rather than chosen when the name column led
            the row and sized every switch with it ("After compaction" measured 91.61px of ink in a 93px
            column at 11px/500, dragging both existing switches ~38px right for a preposition the gloss
            already supplies). The switch column leads now, so the measurement no longer binds — but the
            bare noun is still the right label, because it sits with its siblings as one list of names
            (Stop hook · Heartbeat · Compaction) rather than one name and two phrases.

            The gloss carries the INSTRUCTION, not just the timing, because this trigger is useless
            without it: the prompt has to name a doc for the emptied window to be re-grounded ON. */}
        <Switch
          testId="post-compaction"
          label="Compaction"
          checked={postCompaction}
          disabled={busy}
          onChange={(next) => {
            setPostCompaction(next)
            void persistNow(draft({ postCompaction: next }))
            if (next && !text.trim()) requestAnimationFrame(() => textarea.current?.focus())
          }}
        />
        <span className={`font-medium ${postCompaction ? "text-fg" : "text-muted"}`}>Compaction</span>
        <span className="text-muted">when the context is summarized away — link the doc to re-read</span>

        {/* THE HOLD, and it is BELOW A RULE because it is not a fourth trigger. Every switch above adds a
            reason to send; this one takes them all away for as long as the thread is waiting on you, and
            reading it as a sibling of the three would make "on" look like more delivery rather than less.
            The rule spans all three columns and carries the row's own top margin.

            Its label is the whole sentence rather than a name, for the same reason: there is nothing
            elsewhere in frizz called this, so there is no vocabulary to be consistent with — and a name
            would have to be glossed anyway. The gloss says what COUNTS as a question, which is the part
            an operator cannot guess (a permission prompt is one; the agent's own rhetorical one is not).

            The stop hook already declines a rest that ends in a ```question fence, always. This is the
            broader version, ON by default: it covers the heartbeat and the compaction trigger too, and it
            counts a native ask and a permission prompt as questions — every way a thread can be waiting
            on you, not just the one it wrote down. Switching it off is the deliberate act, because the
            behaviour it buys is what the stop hook's own default assumes: a thread told "keep going"
            should not be told it again while it is holding a question up. */}
        <div className="col-span-3 mt-0.5 h-px bg-border/70" />
        <Switch
          testId="pause-on-questions"
          label="Autonomous mode"
          checked={pauseOnQuestions}
          disabled={busy}
          onChange={(next) => {
            setPauseOnQuestions(next)
            void persistNow(draft({ pauseOnQuestions: next }))
          }}
        />
        <span className={`col-span-2 ${pauseOnQuestions ? "text-fg" : "text-muted"}`}>
          <span className="font-medium">Autonomous mode</span>
          <span className="text-muted"> — a question fence, a native ask, or a permission prompt</span>
        </span>
      </div>
      {/* NO SAVE BUTTON. Every edit here writes itself — a switch on its own click, the text and the
          cadence on blur, and whatever is still uncommitted on the dismissal that unmounts this subtree
          (maintainer 2026-08-11: "no save button. (autosaves when you click out)"). A button that only
          ever duplicated what leaving the panel already did was one more thing to forget to press, and
          its disabled state was the only place the panel could say "nothing to do" — which nobody needed
          told. `busy` is the whole in-flight signal now, and it sits on the controls themselves.

          What the operator needs from this line is WHEN IT STOPS, because a prompt they armed sitting
          silent on a still thread is what looks broken from the outside. */}
      <p className="mt-3 text-muted/70">
        {!stopHook && !heartbeat && !postCompaction
          ? <>None is on, so nothing is sent — the text stays here for when you want it back.</>
          : <>
              Saved as you go. Switch them all off to stop it, or the agent stops it itself by signing
              off with a <code className="font-mono font-medium text-fg/85">```done</code> fence — which
              files the thread away until you send more work.
            </>}
      </p>
    </section>
  )
}
