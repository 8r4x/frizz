import { useEffect, useRef, useState } from "react"
import { CircleStop } from "lucide-react"
import {
  HEARTBEAT_PROMPT_MAX,
  STOP_HOOK_MAX,
  ALLDONE_SENTINEL,
  type ThreadView,
} from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { formatAgo } from "../lib/durationLabels.ts"
import { showToast } from "../store.ts"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"

// THE RECURRING-PROMPT PANEL: one glyph in the thread footer opening both of fray's ways to re-prompt a
// thread without the operator typing. They are separate features on purpose, because they answer
// different questions and fail in opposite directions:
//
//   STOP HOOK (scheduler SOURCE 5) — "you stopped; is there more?" Fires every time the thread comes to
//     REST. No clock and no cadence: if it stopped, it is prompted.
//   HEARTBEAT (scheduler SOURCE 4) — "it has been ten minutes." Fires on a CHOSEN clock and consults
//     nothing about what the thread is doing.
//
// The stop hook is the one you want for driving an effort forward; the heartbeat is the one you want
// when a thread must be revisited on a schedule regardless of what it is up to. Both stop only two
// ways: this panel's toggle, or the agent replying ALLDONE — which is a PERMANENT opt-out, and is why
// both delivered messages warn against it rather than merely offering it.
//
// The trigger renders ALWAYS, muted when neither is armed — a control that only appears once its own
// feature is on cannot be used to turn the feature on. That makes it the one permanent child of the
// footer's left cluster, where everything else is a reading that hides itself when it has nothing to say.
export function StopHookControl({ thread }: { thread: ThreadView }) {
  const [open, setOpen] = useState(false)
  const hook = thread.stopHook
  const beat = thread.heartbeat
  // COLOURED IF EITHER IS LIVE. The glyph answers one question — "is fray going to re-prompt this
  // thread on its own?" — and both features are a yes.
  const live = hook?.enabled === true || beat?.enabled === true

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* No tooltip. This trigger used to carry one that printed the WHOLE armed prompt on hover — a
          second, uninvited panel covering the footer every time the pointer crossed a 12px glyph
          (maintainer 2026-08-02: "the hover-based popover is silly"). The prompt has one home now, and
          you get there by clicking. */}
      <PopoverTrigger asChild>
        <button
          type="button"
          data-stop-hook
          data-stop-hook-on={live ? "true" : "false"}
          aria-label={live ? "Recurring prompts (on)" : "Recurring prompts"}
          className="flex items-center rounded-md px-0.5 py-0.5 outline-none"
        >
          {/* The square-in-a-circle, and the ONLY surface that says either of these exists (the rail
              deliberately carries no mark — see groups.ts). GREY by default and coloured only while
              something is actually armed: the footer's left cluster is a status strip first, so a
              control with nothing to report has to read as quiet as the empty slot it would otherwise
              leave. Amber, not the app's accent yellow, so it reads as a state rather than the focus
              motif. */}
          <CircleStop size={12} className={live ? "text-amber-400/90" : "text-muted/45 hover:text-muted"} />
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
        <Section
          kind="stop-hook"
          title="Stop hook"
          armed={hook}
          max={STOP_HOOK_MAX}
          placeholder="What should this thread keep doing every time it stops?"
          save={(prompt, enabled) => rpc.setThreadStopHook({ slug: thread.id, sessionId: thread.sessionId ?? "", prompt, enabled })}
          explainer={
            <>
              Sent every time the agent comes to rest. It stops only if you switch it off, or if the
              agent replies{" "}
              <code className="font-mono font-medium text-fg/85">{ALLDONE_SENTINEL}</code> to say there
              is no further work — which stalls the run until something else moves it.
            </>
          }
        />
        {/* One rule between two controls that are easy to mistake for one. Without it the second toggle
            reads as a sub-option of the first. */}
        <hr className="my-3 border-border/70" />
        <Section
          kind="heartbeat"
          title="Heartbeat"
          armed={beat}
          max={HEARTBEAT_PROMPT_MAX}
          placeholder="What should this thread be told on a schedule, whatever it is doing?"
          interval={beat?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS}
          save={(prompt, enabled, intervalSeconds) => rpc.setThreadHeartbeat({
            slug: thread.id,
            sessionId: thread.sessionId ?? "",
            prompt,
            enabled,
            ...(prompt === null ? {} : { intervalSeconds }),
          })}
          explainer={
            <>
              Sent on the clock, whatever the agent is doing — a beat due mid-turn is delivered at its
              next rest rather than interrupting it. Same two ways out: this switch, or{" "}
              <code className="font-mono font-medium text-fg/85">{ALLDONE_SENTINEL}</code>.
            </>
          }
        />
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
// 1 minute floor (a beat cannot deliver faster than the thread stops anyway) and 24 hours.
const MIN_MINUTES = 1
const MAX_MINUTES = 24 * 60
const DEFAULT_INTERVAL_SECONDS = 600

interface ArmedView {
  prompt: string
  enabled: boolean
  lastFiredAt?: string
}

// One section per feature. Both are the same shape — a toggle, a prompt, an explanation — so they are
// one component: two copies would drift, and the whole point of showing them together is that the
// operator can compare them.
function Section({
  kind, title, armed, max, placeholder, explainer, interval, save,
}: {
  kind: "stop-hook" | "heartbeat"
  title: string
  armed: ArmedView | undefined
  max: number
  placeholder: string
  explainer: React.ReactNode
  /** Heartbeat only — its chosen cadence. Absent ⇒ this section has no schedule to pick. */
  interval?: number
  save: (prompt: string | null, enabled: boolean, intervalSeconds: number) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  // The panel's own draft. Seeded from the server row when the section MOUNTS (the popover unmounts its
  // content on close, so that is once per open) rather than tracked live, so a board refresh mid-sentence
  // cannot rewrite what the operator is typing or dictating.
  const [enabled, setEnabled] = useState(armed?.enabled ?? false)
  const [text, setText] = useState(armed?.prompt ?? "")
  const [seconds, setSeconds] = useState(interval ?? DEFAULT_INTERVAL_SECONDS)
  // The minutes field is a STRING while it is being typed, so a half-typed value ("", "1" on the way to
  // "120") is not immediately clamped out from under the caret. It becomes a number on commit.
  const [minutes, setMinutes] = useState(String(Math.round((interval ?? DEFAULT_INTERVAL_SECONDS) / 60)))
  const textarea = useRef<HTMLTextAreaElement>(null)
  // What was last SENT, so a blur or a close can skip a round-trip when nothing actually changed —
  // otherwise every stray click through the panel re-arms the row and mints a new generation.
  const sent = useRef({ enabled: armed?.enabled ?? false, prompt: armed?.prompt ?? "", seconds: interval ?? DEFAULT_INTERVAL_SECONDS })

  // Persist on unmount too: closing the popover destroys this subtree, and without this a prompt typed
  // and then dismissed with Escape would be silently lost.
  const latest = useRef({ enabled, text, seconds })
  latest.current = { enabled, text, seconds }
  useEffect(() => () => { void persistNow(latest.current.enabled, latest.current.text, latest.current.seconds) }, [])

  async function persistNow(nextEnabled: boolean, nextText: string, nextSeconds: number): Promise<void> {
    const prompt = nextText.trim() || null
    const unchanged = prompt === (sent.current.prompt || null)
      && nextEnabled === sent.current.enabled
      && nextSeconds === sent.current.seconds
    if (unchanged) return
    // Nothing armed and nothing typed — a bare toggle flip has nothing to persist yet. Keep the local
    // flip (it is what makes the textarea editable) and let the first real text carry it up.
    if (prompt === null && !armed) {
      sent.current = { enabled: nextEnabled, prompt: "", seconds: nextSeconds }
      return
    }
    setBusy(true)
    try {
      await save(prompt, nextEnabled, nextSeconds)
      sent.current = { enabled: nextEnabled, prompt: prompt ?? "", seconds: nextSeconds }
      showToast(prompt === null ? `${title} cleared` : nextEnabled ? `${title} on` : `${title} off`)
    } catch (error) {
      showToast((error instanceof Error ? error.message : `Could not save the ${title.toLowerCase()}`).slice(0, 100))
    } finally {
      setBusy(false)
    }
  }
  const persist = () => void persistNow(enabled, text, seconds)
  // Clamp on COMMIT, not on keystroke. An out-of-range or empty field snaps back to something legal and
  // the field is rewritten to match, so what the operator sees is always what was actually stored.
  function commitMinutes(): void {
    const parsed = Math.round(Number(minutes))
    const clamped = Number.isFinite(parsed) && parsed > 0
      ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, parsed))
      : Math.round(seconds / 60)
    setMinutes(String(clamped))
    setSeconds(clamped * 60)
    void persistNow(enabled, text, clamped * 60)
  }
  // Is there anything to save? Compared against what was last SENT, so the button is live exactly when
  // a click would change something on the server — the alternative (always enabled) makes "Save" a
  // button you cannot tell the effect of, which is the complaint it exists to answer.
  const dirty = (text.trim() || null) !== (sent.current.prompt || null)
    || enabled !== sent.current.enabled
    || seconds !== sent.current.seconds

  return (
    <section data-hook-section={kind}>
      {/* The switch sits BESIDE its label, not at the far end of the row: a `justify-between` pair reads
          as one control at 21rem and as two unrelated things at 46rem. What earns the far end is the
          reading that belongs there — when it last fired. */}
      <div className="mb-2 flex items-center gap-3">
        <span className="font-medium">{title}</span>
        <OnOffToggle
          kind={kind}
          value={enabled}
          disabled={busy}
          onChange={(next) => {
            setEnabled(next)
            void persistNow(next, text, seconds)
            if (next) requestAnimationFrame(() => textarea.current?.focus())
          }}
        />
        {interval !== undefined && (
          // "Every [N] min" reads as one phrase, so the words sit in the same row as the field rather
          // than becoming a label above it. The input is sized to its content (4ch fits 1440) and its
          // digits are tabular, so the box does not twitch as the number changes.
          <span className="flex shrink-0 items-center gap-1.5 text-muted">
            Every
            <input
              type="number"
              data-heartbeat-minutes
              inputMode="numeric"
              min={MIN_MINUTES}
              max={MAX_MINUTES}
              disabled={busy}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              onBlur={commitMinutes}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitMinutes() } }}
              aria-label="Heartbeat schedule in minutes"
              className="w-[4.5ch] rounded-md border border-border bg-bg px-1 py-[3px] text-center text-[11px] leading-none tabular-nums text-fg outline-none focus:border-border-strong disabled:opacity-45 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            min
          </span>
        )}
        {armed?.lastFiredAt && (
          <span className="ml-auto truncate text-muted/55">Last sent {formatAgo(armed.lastFiredAt)}</span>
        )}
      </div>
      {/* readOnly, not disabled, when off: the text is the operator's own writing and stays readable and
          selectable while parked. Only the ability to CHANGE it tracks the toggle. */}
      <textarea
        ref={textarea}
        data-stop-hook-text={kind === "stop-hook" ? "" : undefined}
        data-heartbeat-text={kind === "heartbeat" ? "" : undefined}
        value={text}
        readOnly={!enabled}
        maxLength={max}
        onChange={(e) => setText(e.target.value)}
        onBlur={persist}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault()
            persist()
          }
        }}
        placeholder={enabled ? placeholder : "Turn it on to write one"}
        // `field-sizing: content` — the browser sizes the box from what is in it. It replaced a flat
        // `rows={4}`, which made a prompt that can run to 4000 chars a four-line peephole you scrolled
        // your own writing through. `min-h`/`max-h` are the only bounds it needs.
        //
        // Deliberately NOT a JS auto-grow (maintainer 2026-08-02: "this should be a browser-native
        // style, you shouldn't need to write JavaScript auto-grow logic"). The measure-and-set version
        // is also the one that broke: driven from an effect it ran with a null ref, because the panel
        // mounts behind a Radix portal a render later, and never ran again. Chromium ≥123.
        className={`field-sizing-content max-h-[28vh] min-h-[4rem] w-full resize-none overflow-y-auto rounded-md border border-border bg-bg px-2 py-1.5 text-[12px] leading-snug outline-none placeholder:text-muted/50 focus:border-border-strong ${enabled ? "text-fg" : "cursor-default text-muted/60"}`}
      />
      {/* The explanation and the Save share one row, which is what puts the button at the section's
          bottom-right without a bar of its own. `items-end` rather than `items-center`: the explainer is
          two lines of prose and the button is one control, so centring them would float the button in
          the middle of the paragraph — aligning their BASE edges reads as the paragraph and its action.
          The button keeps its own line-height so its label sits optically centred in its box.

          What the operator needs from this text is WHEN IT FIRES AND WHEN IT WILL NOT, because a hook
          they armed sitting silent on a still thread is what looks broken from the outside. */}
      <div className="mt-2 flex items-end gap-3">
        <p className="min-w-0 flex-1 text-muted/70">{explainer}</p>
        <button
          type="button"
          data-hook-save={kind}
          disabled={busy || !dirty}
          onMouseDown={(e) => e.preventDefault()}
          onClick={persist}
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
// row with an 11px heading, not a form label.
function OnOffToggle({ kind, value, disabled, onChange }: {
  kind: string
  value: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="inline-flex w-fit shrink-0 rounded-md border border-border bg-bg p-0.5" role="group" aria-label={`${kind} enabled`}>
      {[{ v: false, label: "Off" }, { v: true, label: "On" }].map((o) => (
        <button
          key={o.label}
          type="button"
          disabled={disabled}
          aria-pressed={value === o.v}
          data-stop-hook-toggle={kind === "stop-hook" ? o.label.toLowerCase() : undefined}
          data-heartbeat-toggle={kind === "heartbeat" ? o.label.toLowerCase() : undefined}
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
