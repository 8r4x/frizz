import { useEffect, useRef, useState } from "react"
import { HeartPulse } from "lucide-react"
import {
  RECURRING_PROMPT_MAX,
  ALLDONE_SENTINEL,
  type ThreadView,
} from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { formatAgo } from "../lib/durationLabels.ts"
import { INK_TRIM_HEARTBEAT } from "../lib/iconRhythm.ts"
import { showToast } from "../store.ts"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"

// THE RECURRING-PROMPT PANEL: one glyph in the thread footer opening frizz's way to re-prompt a thread
// without the operator typing it again. ONE piece of text, and up to two independent reasons to send it:
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
          aria-label={live ? "Recurring prompt (on)" : "Recurring prompt"}
          className={`flex items-center rounded-md px-0.5 py-0.5 outline-none ${INK_TRIM_HEARTBEAT}`}
        >
          {/* A HEART WITH A PULSE THROUGH IT, and the ONLY surface that says this exists (the rail
              deliberately carries no mark — see groups.ts).

              It was a square-in-a-circle (`CircleStop`) and that was the wrong mark for a reason no
              amount of tooltip could fix: in a strip whose other children are live verbs, a stop
              button reads as one — "it seems like clicking it would cause the entire session to stop"
              (maintainer 2026-08-03). A glyph that looks destructive on the way to a settings panel is
              worse than no glyph. A heartbeat says the opposite thing, which is also the true thing:
              something is keeping this thread beating.

              The HEART, not the bare pulse line (`Activity`) this shipped as for an afternoon: the line
              on its own reads as a metrics sparkline, and it is the enclosing heart that names the mark
              a HEARTBEAT — this thread has one, which is the entire state the glyph reports (maintainer
              2026-08-03: "I want it to be the heart icon with the pulse inside").

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
          <HeartPulse size={12} className={live ? "text-amber-400/90" : "text-muted/60 hover:text-muted"} />
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
        <PromptPanel thread={thread} armed={armed} close={() => setOpen(false)} />
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

interface Draft { text: string; stopHook: boolean; heartbeat: boolean; postCompaction: boolean; seconds: number }

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

function PromptPanel({ thread, armed, close }: {
  thread: ThreadView
  armed: ThreadView["recurringPrompt"]
  /** Dismiss the popover — Save's second job, once the write has actually landed. */
  close: () => void
}) {
  const [busy, setBusy] = useState(false)
  // The panel's own draft. Seeded from the server row when this MOUNTS (the popover unmounts its content
  // on close, so that is once per open) rather than tracked live, so a board refresh mid-sentence cannot
  // rewrite what the operator is typing or dictating.
  const [text, setText] = useState(armed?.prompt ?? "")
  const [stopHook, setStopHook] = useState(armed?.stopHook ?? false)
  const [heartbeat, setHeartbeat] = useState(armed?.heartbeat ?? false)
  const [postCompaction, setPostCompaction] = useState(armed?.postCompaction ?? false)
  const [seconds, setSeconds] = useState(armed?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS)
  // The minutes field is a STRING while it is being typed, so a half-typed value ("", "1" on the way to
  // "120") is not immediately clamped out from under the caret. It becomes a number on commit.
  const [minutes, setMinutes] = useState(String(Math.round((armed?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) / 60)))
  const textarea = useRef<HTMLTextAreaElement>(null)
  // What was last SENT, so a blur or a close can skip a round-trip when nothing actually changed —
  // otherwise every stray click through the panel re-arms the row and mints a new generation.
  const sent = useRef({
    prompt: armed?.prompt ?? "",
    stopHook: armed?.stopHook ?? false,
    heartbeat: armed?.heartbeat ?? false,
    postCompaction: armed?.postCompaction ?? false,
    seconds: armed?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
  })

  // Persist on unmount too: closing the popover destroys this subtree, and without this a prompt typed
  // and then dismissed with Escape would be silently lost.
  const latest = useRef<Draft>({ text, stopHook, heartbeat, postCompaction, seconds })
  latest.current = { text, stopHook, heartbeat, postCompaction, seconds }
  useEffect(() => () => { void persistNow(latest.current) }, [])

  /** Resolves TRUE when the server row matches this draft — either it already did, or the write landed.
   *  FALSE only on a failed write, which is what keeps Save from dismissing a panel whose change did not
   *  stick: the operator needs the text still in front of them to retry. */
  async function persistNow(next: Draft): Promise<boolean> {
    const prompt = next.text.trim() || null
    const unchanged = prompt === (sent.current.prompt || null)
      && next.stopHook === sent.current.stopHook
      && next.heartbeat === sent.current.heartbeat
      && next.postCompaction === sent.current.postCompaction
      && next.seconds === sent.current.seconds
    if (unchanged) return true
    // Nothing armed and nothing typed — flipping a trigger before writing anything has nothing to
    // persist yet. Keep the local flip and let the first real text carry it up.
    if (prompt === null && !armed) {
      sent.current = { prompt: "", stopHook: next.stopHook, heartbeat: next.heartbeat, postCompaction: next.postCompaction, seconds: next.seconds }
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
        // ALWAYS sent alongside a prompt, even while the schedule trigger is OFF. Gating this on
        // `heartbeat` looked right and silently destroyed data: switching the schedule off sent no
        // cadence, storage cleared the column, and reopening the panel showed the 10-minute default —
        // so an operator who parked a 30-minute schedule got 10 back when they switched it on again,
        // with nothing to indicate their number had been discarded. Caught in the browser, not by a
        // test: every unit here asserted on rows that still had a cadence.
        ...(prompt === null ? {} : { intervalSeconds: next.seconds }),
      })
      sent.current = { prompt: prompt ?? "", stopHook: next.stopHook, heartbeat: next.heartbeat, postCompaction: next.postCompaction, seconds: next.seconds }
      // The toast names WHAT WILL HAPPEN, not which switch moved. "On"/"off" was legible when there was
      // one toggle per feature and is ambiguous the moment two triggers share a row.
      const clauses = triggerClauses(next)
      showToast(
        prompt === null ? "Recurring prompt cleared"
          : clauses.length === 0 ? "Recurring prompt off — no trigger is on"
          : `Recurring prompt: ${clauses.join(", ")}`,
      )
    } catch (error) {
      showToast((error instanceof Error ? error.message : "Could not save the recurring prompt").slice(0, 100))
      return false
    } finally {
      setBusy(false)
    }
    return true
  }
  const persist = () => void persistNow({ text, stopHook, heartbeat, postCompaction, seconds })
  // Clamp on COMMIT, not on keystroke. An out-of-range or empty field snaps back to something legal and
  // the field is rewritten to match, so what the operator sees is always what was actually stored.
  function commitMinutes(): void {
    const parsed = Math.round(Number(minutes))
    const clamped = Number.isFinite(parsed) && parsed > 0
      ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, parsed))
      : Math.round(seconds / 60)
    setMinutes(String(clamped))
    setSeconds(clamped * 60)
    void persistNow({ text, stopHook, heartbeat, postCompaction, seconds: clamped * 60 })
  }
  // Is there anything to save? Compared against what was last SENT, so the button is live exactly when
  // a click would change something on the server — the alternative (always enabled) makes "Save" a
  // button you cannot tell the effect of, which is the complaint it exists to answer.
  const dirty = (text.trim() || null) !== (sent.current.prompt || null)
    || stopHook !== sent.current.stopHook
    || heartbeat !== sent.current.heartbeat
    || postCompaction !== sent.current.postCompaction
    || seconds !== sent.current.seconds

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
        <span className="font-medium">Recurring prompt</span>
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
        placeholder="What should this thread be told, again and again?"
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
      {/* THE TWO MECHANISMS, one per line under the text they both send. They are NAMED — Stop hook and
          Heartbeat — rather than described, because those are the names everything else in frizz uses for
          them: the scheduler's two passes, the delivery fence prefixes, the trailer on every delivered
          message, and the divider the chat renders. A panel that called them anything else would be the
          only surface with its own vocabulary.

          A THREE-COLUMN GRID (name · switch · gloss), not a flex row. Two mechanisms on one line was
          unreadable — the eye grouped "…it stops [Off|On] every 30 min" and the first switch read as a
          separator between the two phrases rather than the end of the first. Stacked, the switches line
          up in their own column and each row says what it is and when it fires.

          `items-center` per row; the grid's own rows are what align the pair, so no nudging. */}
      <div className="mt-2.5 grid grid-cols-[auto_auto_1fr] items-center gap-x-3 gap-y-1.5">
        <span className={`font-medium ${stopHook ? "text-fg" : "text-muted"}`}>Stop hook</span>
        <OnOffToggle
          kind="stop-hook"
          value={stopHook}
          disabled={busy}
          onChange={(next) => {
            setStopHook(next)
            void persistNow({ text, stopHook: next, heartbeat, postCompaction, seconds })
            if (next && !text.trim()) requestAnimationFrame(() => textarea.current?.focus())
          }}
        />
        <span className="text-muted">every time the agent comes to rest</span>

        <span className={`font-medium ${heartbeat ? "text-fg" : "text-muted"}`}>Heartbeat</span>
        <OnOffToggle
          kind="heartbeat"
          value={heartbeat}
          disabled={busy}
          onChange={(next) => {
            setHeartbeat(next)
            void persistNow({ text, stopHook, heartbeat: next, postCompaction, seconds })
            if (next && !text.trim()) requestAnimationFrame(() => textarea.current?.focus())
          }}
        />
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

            ONE WORD, not "After compaction", and the reason is measured rather than stylistic: the label
            column is `auto`, so it sizes to the LONGEST label and every switch in the grid moves with it.
            "After compaction" measured 91.61px of ink in a 93px column at 11px/500 — 1.4px of slack, on a
            surface whose font is a user setting — and it dragged both existing switches ~38px right for a
            preposition the gloss beside it already supplies. As a bare noun it sits with its siblings
            (Stop hook · Heartbeat · Compaction) and the column stops being hostage to this row.

            The gloss carries the INSTRUCTION, not just the timing, because this trigger is useless
            without it: the prompt has to name a doc for the emptied window to be re-grounded ON. */}
        <span className={`font-medium ${postCompaction ? "text-fg" : "text-muted"}`}>Compaction</span>
        <OnOffToggle
          kind="post-compaction"
          value={postCompaction}
          disabled={busy}
          onChange={(next) => {
            setPostCompaction(next)
            void persistNow({ text, stopHook, heartbeat, postCompaction: next, seconds })
            if (next && !text.trim()) requestAnimationFrame(() => textarea.current?.focus())
          }}
        />
        <span className="text-muted">when the context is summarized away — link the doc to re-read</span>
      </div>
      {/* The explanation and the Save share one row, which is what puts the button at the panel's
          bottom-right without a bar of its own. `items-end` rather than `items-center`: the explainer is
          two lines of prose and the button is one control, so centring them would float the button in
          the middle of the paragraph — aligning their BASE edges reads as the paragraph and its action.
          The button keeps its own line-height so its label sits optically centred in its box.

          What the operator needs from this text is WHEN IT FIRES AND WHEN IT WILL NOT, because a prompt
          they armed sitting silent on a still thread is what looks broken from the outside. */}
      <div className="mt-2 flex items-end gap-3">
        <p className="min-w-0 flex-1 text-muted/70">
          {/* ONE LINE. The rows above now carry when-each-fires, so this is only the two ways it ENDS —
              which is what an operator actually cannot infer from the panel. An earlier version repeated
              the mid-turn fact here and wrapped to three lines, parking Save beside a line holding the
              word "it." */}
          {!stopHook && !heartbeat && !postCompaction
            ? <>None is on, so nothing is sent — the text stays here for when you want it back.</>
            : <>
                Switch them all off to stop it, or the agent can reply{" "}
                <code className="font-mono font-medium text-fg/85">{ALLDONE_SENTINEL}</code> — which
                stalls the run until you move it.
              </>}
        </p>
        <button
          type="button"
          data-recurring-save
          disabled={busy || !dirty}
          onMouseDown={(e) => e.preventDefault()}
          // SAVE CLOSES THE PANEL — but only once the write has landed. Dismissing first would hide the
          // one surface that can report a failure, and the operator would walk away believing a prompt
          // was armed that never was. The unmount persist is a no-op by then: `sent.current` already
          // matches this draft, so it returns early rather than sending the same row twice.
          onClick={() => { void persistNow({ text, stopHook, heartbeat, postCompaction, seconds }).then((ok) => { if (ok) close() }) }}
          // Small, quiet, and INERT until there is something to save — the disabled state is the whole
          // signal. `shrink-0` so a long explainer can never squeeze the label; `leading-none` + the
          // symmetric py keeps the word optically centred rather than riding high on the default
          // line-box. Same radius and 11px scale as the toggle it answers to.
          className="shrink-0 rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-[5px] text-[11px] leading-none font-medium text-fg/80 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 disabled:opacity-40 disabled:hover:bg-panel-2/60 disabled:hover:text-fg/80"
        >
          {/* MEASURED, not guessed: the label's ink sat 0.62px BELOW its box's interior centre, against
              0.08–0.19px for the Off/On segments in the same panel — a word with no descender in a
              symmetrically padded box. Corrected in `em` so it tracks the font size rather than pinning
              to 11px, and re-measured to a 0.02px residual. */}
          <span className="inline-block translate-y-[-0.056em]">{busy ? "Saving…" : "Save"}</span>
        </button>
      </div>
    </section>
  )
}

// The same segmented Off|On the settings form uses — Off on the LEFT (switch convention, right = on),
// active segment inverted. Deliberately NOT a second switch idiom invented for this panel: the app
// already has exactly one shape for a boolean. Sized down from the settings copy because it shares a
// row with 11px prose, not a form label.
function OnOffToggle({ kind, value, disabled, onChange }: {
  kind: string
  value: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="inline-flex w-fit shrink-0 rounded-md border border-border bg-bg p-0.5" role="group" aria-label={`${kind} trigger`}>
      {[{ v: false, label: "Off" }, { v: true, label: "On" }].map((o) => (
        <button
          key={o.label}
          type="button"
          disabled={disabled}
          aria-pressed={value === o.v}
          data-recurring-toggle={`${kind}-${o.label.toLowerCase()}`}
          onClick={() => onChange(o.v)}
          className={`rounded px-2 py-0.5 text-[11px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/60 disabled:opacity-45 ${
            value === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
