import { useEffect, useRef, useState } from "react"
import { CircleStop } from "lucide-react"
import { STOP_HOOK_MAX, STOP_HOOK_SENTINEL, type ThreadView } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { formatAgo } from "../lib/durationLabels.ts"
import { showToast } from "../store.ts"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"

// The operator's half of a stop hook (server: scheduler.ts SOURCE 5) — text fray re-sends every
// time this thread comes to REST, until the worker answers with the AWAITING sentinel.
//
// It replaced an interval-based, WORKER-armed version of the same idea (removed 2026-08-02), and both
// halves of that were wrong. The operator watching a thread stop short could not arm it at all — only
// the worker could, from inside the session — so their only move was retyping the same follow-up by
// hand every time. And the interval was a number nobody could pick: rest is the event they actually
// mean, so rest is the trigger, and there is no cadence here to get wrong.
//
// It renders ALWAYS, muted when nothing is armed — a control that only appears once its own feature is
// on cannot be used to turn the feature on. That makes it the one permanent child of the footer's
// left cluster, where everything else is a reading that hides itself when it has nothing to say.
export function StopHookControl({ thread }: { thread: ThreadView }) {
  const armed = thread.stopHook
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // The popover's own draft. Seeded from the server row each time it opens rather than tracked live, so
  // a board refresh mid-sentence cannot rewrite what the operator is typing (or dictating) into it.
  const [enabled, setEnabled] = useState(armed?.enabled ?? false)
  const [text, setText] = useState(armed?.prompt ?? "")
  const textarea = useRef<HTMLTextAreaElement>(null)
  // What was last SENT, so blur/close can skip a round-trip when nothing actually changed — otherwise
  // every stray click through the panel would re-arm the row and mint a new generation.
  const sent = useRef({ enabled: armed?.enabled ?? false, prompt: armed?.prompt ?? "" })

  useEffect(() => {
    if (!open) return
    setEnabled(armed?.enabled ?? false)
    setText(armed?.prompt ?? "")
    sent.current = { enabled: armed?.enabled ?? false, prompt: armed?.prompt ?? "" }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seeding is an OPEN event, not a subscription
  }, [open])

  // One write for the toggle and the text together (they are one row server-side). An empty draft is a
  // CLEAR rather than an error: the operator emptying the box means "stop doing this", and refusing it
  // would leave the only way out being a prompt they no longer want.
  async function persist(nextEnabled: boolean, nextText: string): Promise<void> {
    const prompt = nextText.trim() || null
    if (prompt === (sent.current.prompt || null) && nextEnabled === sent.current.enabled) return
    if (prompt === null && !armed) {
      // Nothing armed and nothing typed — the toggle alone has nothing to persist yet. Keep the local
      // flip (it is what makes the textarea editable) and let the first real text carry it up.
      sent.current = { enabled: nextEnabled, prompt: "" }
      return
    }
    setBusy(true)
    try {
      await rpc.setThreadStopHook({
        slug: thread.id,
        sessionId: thread.sessionId ?? "",
        prompt,
        enabled: nextEnabled,
      })
      sent.current = { enabled: nextEnabled, prompt: prompt ?? "" }
      showToast(prompt === null ? "Stop hook cleared" : nextEnabled ? "Stop hook on" : "Stop hook off")
    } catch (error) {
      showToast((error instanceof Error ? error.message : "Could not save the stop hook").slice(0, 100))
    } finally {
      setBusy(false)
    }
  }

  function toggle(next: boolean) {
    setEnabled(next)
    void persist(next, text)
    // Turning it on is a request to write the thing, so put the caret where the writing happens.
    if (next) requestAnimationFrame(() => textarea.current?.focus())
  }

  const live = !!armed?.enabled

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) void persist(enabled, text) }}>
      {/* No tooltip. This trigger used to carry one that printed the WHOLE armed prompt on hover — a
          second, uninvited panel covering the footer every time the pointer crossed a 12px glyph
          (maintainer 2026-08-02: "the hover-based popover is silly"). The prompt has one home now, and
          you get there by clicking. */}
      <PopoverTrigger asChild>
        <button
          type="button"
          data-stop-hook
          data-stop-hook-on={live ? "true" : "false"}
          aria-label={live ? "Stop hook (on)" : "Stop hook"}
          className="flex items-center rounded-md px-0.5 py-0.5 outline-none"
        >
          {/* The square-in-a-circle, and the ONLY surface that says a stop hook exists (the rail
              deliberately carries no mark for one — see groups.ts). GREY by default and coloured only
              while the hook is actually armed and enabled: the footer's left cluster is a status strip
              first, so a control with nothing to report has to read as quiet as the empty slot it
              would otherwise leave. Amber, not the app's accent yellow, so it reads as a state rather
              than as the focus motif. */}
          <CircleStop size={12} className={live ? "text-amber-400/90" : "text-muted/45 hover:text-muted"} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        // WIDE, and it takes the whole viewport when the viewport is small. The old 21rem cap made this
        // a narrow column for prose that can run to 4000 characters, and on a phone-width screen it was
        // narrower than the space actually available. The panel is a writing surface, so it is sized
        // like one: ~110 columns where there is room, everything-minus-a-margin where there is not.
        className="w-[min(46rem,calc(100vw-1.5rem))] p-3 text-[11px] leading-relaxed text-fg"
        // Radix otherwise autofocuses the first focusable child, which is the Off segment — and a
        // focus ring sitting on "Off" reads as the toggle being SET to off by the act of opening the
        // panel. Send the caret to the textarea when there is something to write in, and nowhere at
        // all when there is not.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          if (enabled) textarea.current?.focus()
        }}
      >
        {/* The switch sits BESIDE its label, not at the far end of the row. They were a `justify-between`
            pair, which reads as one control while the panel is 21rem and as two unrelated things once it
            is 46rem — 700px of gulf between a word and the switch it names. What earns the far end is the
            reading that belongs there: when it last fired. That also retires the orphan line this used to
            leave under the explanation. */}
        <div className="mb-2 flex items-center gap-3">
          <span className="font-medium">Stop hook</span>
          <OnOffToggle value={enabled} disabled={busy} onChange={toggle} />
          {armed?.lastFiredAt && (
            <span className="ml-auto truncate text-muted/55">Last sent {formatAgo(armed.lastFiredAt)}</span>
          )}
        </div>
        {/* readOnly, not disabled, when off: the text is the operator's own writing and stays readable
            and selectable while parked. Only the ability to CHANGE it tracks the toggle. */}
        <textarea
          ref={textarea}
          data-stop-hook-text
          value={text}
          readOnly={!enabled}
          maxLength={STOP_HOOK_MAX}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void persist(enabled, text)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault()
              void persist(enabled, text)
              setOpen(false)
            }
          }}
          placeholder={enabled ? "What should this thread keep doing every time it stops?" : "Turn it on to write one"}
          // `field-sizing: content` — the browser sizes the box from what is in it. It replaced a flat
          // `rows={4}`, which made a prompt that can run to STOP_HOOK_MAX (4000 chars) a four-line
          // peephole you scrolled your own writing through. `min-h`/`max-h` are the only bounds it
          // needs: a comfortable empty size, and a ceiling that keeps the explanation below on screen
          // (past which it scrolls).
          //
          // Deliberately NOT a JS auto-grow (maintainer 2026-08-02: "this should be a browser-native
          // style, you shouldn't need to write JavaScript auto-grow logic"). The measure-and-set version
          // is also the one that broke: driven from an effect on this component it ran with a null ref,
          // because the panel mounts behind a Radix portal a render later, and never ran again. There is
          // no render timing to lose to when the browser owns the sizing. Chromium ≥123, which is what
          // this app runs in.
          className={`field-sizing-content max-h-[42vh] min-h-[4.5rem] w-full resize-none overflow-y-auto rounded-md border border-border bg-bg px-2 py-1.5 text-[12px] leading-snug outline-none placeholder:text-muted/50 focus:border-border-strong ${enabled ? "text-fg" : "cursor-default text-muted/60"}`}
        />
        {/* What the operator needs from this line is WHEN IT WILL NOT FIRE, because that is what looks
            broken from the outside: a hook they armed, a thread sitting still, and no bump. Both holds
            are self-clearing and neither turns the hook off, so the line says that rather than leaving
            them to wonder whether it is working.

            The sentinel is set in mono with NO horizontal padding: a padded chip put a visible gap
            between the word and the punctuation after it, which reads as a typo. Weight and family
            carry the "this is a literal string" job on their own. */}
        <p className="mt-2 text-muted/70">
          Sent when the agent comes to rest, then at most once every 10 minutes however often it stops.
          It can skip a single turn by replying{" "}
          <code className="font-mono font-medium text-fg/85">{STOP_HOOK_SENTINEL}</code> while it waits
          on something — that never turns it off; only this switch does.
        </p>
      </PopoverContent>
    </Popover>
  )
}

// The same segmented Off|On the settings form uses — Off on the LEFT (switch convention, right = on),
// active segment inverted. Deliberately NOT a second switch idiom invented for this one panel: the app
// already has exactly one shape for a boolean, and a popover is a bad place to introduce a second.
// Sized down from the settings copy because it shares a row with an 11px heading, not a form label.
function OnOffToggle({ value, disabled, onChange }: { value: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="inline-flex w-fit shrink-0 rounded-md border border-border bg-bg p-0.5" role="group" aria-label="Stop hook enabled">
      {[{ v: false, label: "Off" }, { v: true, label: "On" }].map((o) => (
        <button
          key={o.label}
          type="button"
          disabled={disabled}
          aria-pressed={value === o.v}
          data-stop-hook-toggle={o.label.toLowerCase()}
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
