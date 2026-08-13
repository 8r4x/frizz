import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { useSnapshot } from "valtio"
import { Check, Copy, HelpCircle } from "lucide-react"
import { type Settings } from "@frizz/shared"
import { isRetryableRpcError, rpc } from "../api/rpc.ts"
import { store } from "../store.ts"
import { prefs } from "../lib/prefs.ts"
import { registerSettingsClose } from "../lib/overlays.ts"
import { SHEET_CLOSE_MS, SHEET_PANEL_CLASS, SHEET_SCRIM_CLASS, prefersReducedMotion } from "../lib/sheet.ts"
import { queryClient } from "../main.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { Select } from "./ui/Select.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { CLAUDE_DISPATCH_PERMISSION_OPTIONS } from "../lib/options.ts"

type NotifPerm = "default" | "granted" | "denied" | "unsupported"
export const SETTINGS_HELP = {
  permissionMode: "The permission mode new Claude Code threads launch with. Auto runs safe actions and asks you to approve the risky ones in the thread. Bypass launches the worker with --dangerously-skip-permissions: it never asks, so nothing waits on you and nothing is checked either. Takes effect on the next thread you dispatch; to change a thread that already exists, use the picker beside its model in the prompt box. Codex threads always run with full workspace access and are unaffected.",
  font: "Changes the interface reading font for this browser.",
  localFileOpener: "Chooses how vetted local artifact links open. Markdown files open in Frizz's own reader (which carries an Open action that uses this setting), and image clicks always use the OS default viewer.",
  compact: "Collapses long diffs by default in this browser. This takes effect immediately.",
  stickyUserMessage: "Keeps your most recent message stuck to the top of a thread while the reply scrolls underneath. It stays collapsed to a small card (hover to expand it) so a long message never blocks much of the view. Applies immediately in this browser.",
  queueOrder: "Orders the Needs-you queue and the sidebar's rested threads by when each was last active. Oldest first (FIFO, default) surfaces the longest-waiting item first so you cycle through everything; Newest first (LIFO) keeps the most recently active on top. Applies immediately in this browser.",
  notifications: "Shows a desktop notification when work needs attention while this window is hidden.",
  projectRail: "Shows a permanent column of every project on this machine down the left edge. Off by default: Frizz's home is one board, and a standing list of the others is an easy way to leave the thread you were in. With it off, the home crumb in the status bar is the way back to the projects page.",
} as const
function currentPerm(): NotifPerm {
  if (typeof Notification === "undefined") return "unsupported"
  return Notification.permission as NotifPerm
}

// Every control here WRITES AS YOU TOUCH IT — there is no Save button and no Cancel. A picker or a
// toggle persists on the click; a textarea persists this long after the last keystroke, so a long
// prompt is one write instead of one per character.
const SAVE_DEBOUNCE_MS = 500
// How long "Saved" lingers in the header before the row goes quiet again.
const SAVED_LINGER_MS = 1600
// A REPLAYABLE failure — a mutation refused because Frizz is mid-update — is worth waiting out rather
// than reporting. A promotion takes a few seconds; six tries covers it without becoming a poller.
const RETRY_DELAY_MS = 2000
const MAX_RETRIES = 6

type SaveState = "idle" | "saving" | "saved" | "error"

// The write side of the drawer. Three invariants, all silent when broken:
//
//  - WRITES ARE SERIALIZED. Every payload is a WHOLE Settings object, so two overlapping requests that
//    land out of order leave the server holding the older snapshot. Chaining each write onto the
//    previous one's settled promise makes the last thing touched the last thing stored.
//  - A PENDING DEBOUNCE IS FLUSHED ON CLOSE. Otherwise the last half-second of typing dies with the
//    unmount — precisely the keystrokes the Save button used to capture.
//  - A RETRYABLE FAILURE IS RETRIED. Removing the Save button also removed the operator's way to try
//    again, so the one failure the RPC layer certifies as side-effect-free — `isRetryableRpcError`,
//    which the composer already leans on during a control-plane restart — has to be replayed here.
//    Anything else is AMBIGUOUS (it may have landed) and must be reported, never re-sent.
function useAutosave() {
  const [state, setState] = useState<SaveState>("idle")
  const pending = useRef<Settings | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const inflight = useRef(0)
  const linger = useRef<number | undefined>(undefined)
  const retries = useRef(0)
  // `flush` schedules its own retry, so it needs a handle to itself that doesn't make the callback
  // depend on its own identity. Assigned immediately below.
  const flushRef = useRef<() => void>(() => {})

  const flush = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
    const next = pending.current
    if (!next) return
    pending.current = null
    inflight.current += 1
    setState("saving")
    chain.current = chain.current
      .then(() => rpc.settingsSet(next))
      .then((saved) => {
        // Publish the SERVER's validated copy instead of invalidating: this drawer is the only writer,
        // so a refetch would re-read what we just sent — and could race a write still queued behind it.
        queryClient.setQueryData(["settingsGet"], saved)
        inflight.current -= 1
        retries.current = 0
        if (inflight.current > 0 || pending.current) return
        setState("saved")
        if (linger.current !== undefined) window.clearTimeout(linger.current)
        linger.current = window.setTimeout(() => setState("idle"), SAVED_LINGER_MS)
      })
      .catch((error: unknown) => {
        inflight.current -= 1
        setState("error")
        // A newer value is already queued behind this one — it supersedes this payload entirely, so
        // replaying the stale one would undo the newer edit.
        if (pending.current || !isRetryableRpcError(error) || retries.current >= MAX_RETRIES) return
        retries.current += 1
        pending.current = next
        timer.current = window.setTimeout(flushRef.current, RETRY_DELAY_MS)
      })
  }, [])
  flushRef.current = flush

  const queue = useCallback(
    (next: Settings, debounce = false) => {
      pending.current = next
      retries.current = 0
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      timer.current = undefined
      if (!debounce) return flush()
      timer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
    },
    [flush],
  )

  useEffect(
    () => () => {
      flush()
      if (linger.current !== undefined) window.clearTimeout(linger.current)
    },
    [flush],
  )

  return { state, queue, flush }
}

export function SettingsDrawer() {
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  const [draft, setDraft] = useState<Settings | null>(null)
  const [perm, setPerm] = useState<NotifPerm>(currentPerm())
  const { state: saveState, queue, flush } = useAutosave()

  // Enter/exit animation. `shown` drives the slide (mount → next frame flips it true → slides in;
  // close flips it false → slides out). App renders <SettingsDrawer> only while showSettings is true,
  // so we keep ourselves mounted through the exit by delaying the store write until the slide ends.
  const [shown, setShown] = useState(false)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // Let App's window-level Esc handler trigger THIS animated close (slide-out) rather than flipping the
  // store flag and unmounting instantly. `close` is a hoisted declaration, so referencing it here is safe.
  useEffect(() => {
    registerSettingsClose(close)
    return () => registerSettingsClose(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The server's copy seeds the form once. It is never re-seeded afterwards: every save publishes the
  // stored value straight into this query's cache, so a later fetch can only agree with what is here.
  useEffect(() => {
    if (settings.data && !draft) setDraft(settings.data)
  }, [settings.data, draft])

  // The one entry point for every control: render the change, then persist it. `debounce` is for the
  // free-text fields alone — a picker or a toggle is a single discrete intent and writes on the spot.
  const update = useCallback(
    (next: Settings, opts?: { debounce?: boolean }) => {
      setDraft(next)
      queue(next, opts?.debounce)
    },
    [queue],
  )

  function close() {
    if (closing) return
    // Send whatever is still sitting in the debounce before the drawer goes away.
    flush()
    setClosing(true)
    setShown(false)
    window.setTimeout(() => (store.showSettings = false), prefersReducedMotion() ? 0 : SHEET_CLOSE_MS)
  }

  // Turning notifications on requests browser permission if not yet decided; we keep the toggle
  // truthful about the OS-level grant so a green checkbox can't imply notifications that won't fire.
  async function toggleNotifications(on: boolean) {
    if (!draft) return
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") {
      const result = (await Notification.requestPermission()) as NotifPerm
      setPerm(result)
    }
    update({ ...draft, notifications: on })
  }

  return (
    <div
      className={`${SHEET_SCRIM_CLASS} z-50 flex justify-end ${shown ? "opacity-100" : "opacity-0"}`}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className={`${SHEET_PANEL_CLASS} w-[560px] max-w-[94vw] ${shown ? "translate-x-0" : "translate-x-full"}`}
      >
        <SheetHeader title="Settings" actions={<SaveStatus state={saveState} />} onClose={close} />

        {!draft ? (
          <div className="p-4 text-[13px] text-muted">Loading…</div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-6">
            {/* The launch permission mode for NEW Claude workers. Only the two modes a headless worker
                can actually run in are offered (see CLAUDE_DISPATCH_PERMISSION_OPTIONS); the server's
                workerDispatchPermission enforces the same floor, so a restrictive value left in an old
                DB can never reach a spawn. A stored mode outside the two reads as the "Auto" floor —
                which is exactly what would be dispatched — rather than rendering the select blank. */}
            <SettingsField label="Claude permissions" help={SETTINGS_HELP.permissionMode}>
              <Select
                variant="bordered"
                value={draft.permissionMode === "bypassPermissions" ? "bypassPermissions" : "auto"}
                onValueChange={(v) => update({ ...draft, permissionMode: v as Settings["permissionMode"] })}
                options={CLAUDE_DISPATCH_PERMISSION_OPTIONS}
                indicatorPosition="right"
                ariaLabel="Claude permission mode"
              />
              {draft.permissionMode === "bypassPermissions" && <BypassHint />}
            </SettingsField>

            <SettingsField label="Font" help={SETTINGS_HELP.font}>
              <FontToggle value={draft.font ?? "mono"} onChange={(font) => update({ ...draft, font })} />
            </SettingsField>

            <SettingsField label="Project sidebar" help={SETTINGS_HELP.projectRail}>
              <Select
                variant="bordered"
                value={draft.projectRail ? "shown" : "hidden"}
                onValueChange={(v) => update({ ...draft, projectRail: v === "shown" })}
                options={[
                  { value: "hidden", label: "Hidden" },
                  { value: "shown", label: "Always shown" },
                ]}
                indicatorPosition="right"
                ariaLabel="Project sidebar"
              />
            </SettingsField>

            <SettingsField label="Local file links" help={SETTINGS_HELP.localFileOpener}>
              <Select
                variant="bordered"
                value={draft.localFileOpener ?? "system"}
                onValueChange={(v) => update({ ...draft, localFileOpener: v as Settings["localFileOpener"] })}
                options={[
                  { value: "system", label: "System default" },
                  { value: "cursor", label: "Cursor" },
                  { value: "vscode", label: "VS Code" },
                  { value: "finder", label: "Reveal in Finder" },
                  { value: "copy", label: "Copy path" },
                ]}
                indicatorPosition="right"
                ariaLabel="Local file link opener"
              />
            </SettingsField>

            {/* A client-only VIEW preference (localStorage, not server Settings): it never travels to
                the server at all, so it's wired straight to the prefs proxy rather than the draft. */}
            <SettingsField label="Compact mode" help={SETTINGS_HELP.compact}>
              <CompactToggle />
            </SettingsField>

            {/* Also a client-only VIEW preference (localStorage): applies immediately, wired to prefs. */}
            <SettingsField label="Sticky message" help={SETTINGS_HELP.stickyUserMessage}>
              <StickyMessageControl />
            </SettingsField>

            {/* Client-only VIEW preference (localStorage): applies immediately, wired to prefs. */}
            <SettingsField label="Queue order" help={SETTINGS_HELP.queueOrder}>
              <QueueOrderControl />
            </SettingsField>

            {/* Same segmented Off/On control as every other row (the old bare checkbox matched
                nothing else in the form). Off left, On right — switch convention. */}
            <SettingsField label="Desktop notifications" help={SETTINGS_HELP.notifications}>
              <OnOffToggle value={draft.notifications} onChange={toggleNotifications} />
              {draft.notifications && <PermHint perm={perm} />}
            </SettingsField>

            <PromptsSection draft={draft} setDraft={update} />
          </div>
        )}
      </div>
    </div>
  )
}

// The header's whole account of persistence, now that no button carries it. Quiet by design: the form
// writes itself, so the only states worth a word are the write in flight, the moment it lands, and the
// one that matters — a write that did NOT land, in the accent that means "this wants you".
function SaveStatus({ state }: { state: SaveState }) {
  if (state === "idle") return null
  if (state === "error") return <span className="text-[11px] font-normal text-accent">Couldn't save</span>
  return (
    <span className={`text-[11px] font-normal text-muted transition-opacity ${state === "saved" ? "opacity-70" : "opacity-100"}`}>
      {state === "saving" ? "Saving…" : "Saved"}
    </span>
  )
}

// A settings label with an instant tooltip on a small HelpCircle — keeps explanatory prose OUT of the
// form body (one control per line reads clean when the "why" lives in the tooltip).
function LabelWithHelp({ label, help }: { label: string; help: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
      {label}
      <Tooltip label={help} side="right" clickable>
        <button type="button" aria-label={`About ${label}`} className="inline-flex size-4 items-center justify-center text-muted/60 hover:text-fg transition-colors">
          <HelpCircle size={12} />
        </button>
      </Tooltip>
    </span>
  )
}

function SettingsField({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <LabelWithHelp label={label} help={help} />
      {children}
    </div>
  )
}

// The 6 substitution tokens the server fills in a GitHub batch-dispatch template, each with a one-word
// gloss of what it expands to. Kept in lockstep with PROMPT_TOKENS in server/github.ts (there is no
// shared const; this is a display hint only). Surfaced once, via the "?" popover on the token fields.
const GH_PROMPT_TOKENS: { token: string; gloss: string }[] = [
  { token: "repo", gloss: "repository" },
  { token: "n", gloss: "number" },
  { token: "title", gloss: "title" },
  { token: "url", gloss: "link" },
  { token: "labels", gloss: "labels" },
  { token: "body", gloss: "description" },
]

// "Prompts" — every user-editable prompt in one place: the Subagent instructions preamble (appended to
// EVERY dispatched agent) plus the two GitHub-picker investigation templates (Issue, PR). The two
// picker editors PREFILL with the shipped default (fetched from the server, the single source of truth)
// so the user edits from the real prompt; a stored override supersedes it. Empty override = default.
function PromptsSection({
  draft,
  setDraft,
}: {
  draft: Settings
  setDraft: (s: Settings, opts?: { debounce?: boolean }) => void
}) {
  const defaults = useQuery({ queryKey: ["githubPromptDefaults"], queryFn: () => rpc.githubPromptDefaults() })
  return (
    <div className="flex flex-col gap-6">
      <DividerLabel label="Prompts" />

      {/* The two GitHub-picker investigation templates. Each field carries its own label, so no group
          label is needed; tokens apply to BOTH, so the "?" popover lives once, right-aligned above them,
          rather than being repeated per field. */}
      {!defaults.data ? (
        <div className="text-[12px] text-muted">Loading defaults…</div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex justify-end">
            <TokenHelpPopover />
          </div>
          <GithubPromptField
            label="Issue investigation prompt"
            help="The prompt for each ISSUE dispatched from the picker. The default has the worker classify the issue as a bug or feature and branch: reproduce + fix-plan for a bug, or a plan + impact analysis for a feature."
            value={draft.githubIssuePrompt}
            fallback={defaults.data.issue}
            onChange={(v, opts) => setDraft({ ...draft, githubIssuePrompt: v }, opts)}
          />
          <GithubPromptField
            label="PR investigation prompt"
            help="The prompt for each PR dispatched from the picker. The default runs an adversarial review/audit — read the diff, verify correctness/edges/tests/CI, then recommend approve / request-changes."
            value={draft.githubPrPrompt}
            fallback={defaults.data.pr}
            onChange={(v, opts) => setDraft({ ...draft, githubPrPrompt: v }, opts)}
          />
        </div>
      )}
    </div>
  )
}

// A section header in the transcript's centered-divider idiom (see ChatView's EventLine): a small
// muted label flanked by faint hairlines, so a settings group reads as a titled band rather than a
// left-aligned caption.
function DividerLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 text-[11px] uppercase tracking-wide text-muted/70">
      <span aria-hidden className="h-px flex-1 bg-border/60" />
      <span className="shrink-0">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-border/60" />
    </div>
  )
}

// A real click-popover (NOT a hover tooltip) listing the substitution tokens, built on the shared
// Radix Popover: opaque from the first frame, portaled above the drawer, and it flips/shifts to stay
// on-screen. Opens on click; dismisses on outside-click or Esc (Radix handles both, and — being a
// non-modal Popover portaled to <body> — its Esc does not bubble to App's window-level Esc, so it
// closes only the panel, never the whole Settings drawer). Prefers opening UPWARD: the "?" lives low
// in the scroll body, and the roomy Subagent editor sits above it.
function TokenHelpPopover() {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Available tokens"
          className={`shrink-0 transition-colors ${open ? "text-accent" : "text-muted/60 hover:text-fg"}`}
        >
          <HelpCircle size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-56 p-3">
        <div className="mb-2 text-[11px] font-medium text-fg">Substitution tokens</div>
        <ul className="flex flex-col gap-1.5">
          {GH_PROMPT_TOKENS.map(({ token, gloss }) => (
            <li key={token} className="flex items-center justify-between gap-3 text-[11px]">
              <code className="font-mono-keep rounded border border-border bg-bg px-1 py-0.5 text-[10px] text-fg/80">
                {`{${token}}`}
              </code>
              <span className="text-muted/80">{gloss}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

// One prompt editor. `value` is the stored override (undefined = "use default"); `fallback` is the
// shipped default shown when there is no override, so the box always renders the effective prompt.
// Typing sets a concrete override; "Reset to default" clears it back to undefined (server default).
// Typing is the one input in the drawer that DEBOUNCES its write — a keystroke is not an intent, a
// pause is; "Reset to default" is a click, so it saves at once like every other control here.
function GithubPromptField({
  label,
  help,
  value,
  fallback,
  onChange,
}: {
  label: string
  help: string
  value: string | undefined
  fallback: string
  onChange: (v: string | undefined, opts?: { debounce?: boolean }) => void
}) {
  const customized = value != null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <LabelWithHelp label={label} help={help} />
        {customized && (
          <button
            type="button"
            className="text-[11px] text-muted hover:text-accent transition-colors"
            onClick={() => onChange(undefined)}
          >
            Reset to default
          </button>
        )}
      </div>
      <textarea
        value={value ?? fallback}
        // Emptying the box clears the override (→ undefined), so it snaps back to showing the default
        // and drops the "Reset" affordance — matching the server's blank-means-default semantics
        // instead of leaving a confusing empty box that still reads as "customized".
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value, { debounce: true })}
        rows={10}
        className="input resize-none text-[12px] leading-relaxed font-mono-keep"
        spellCheck={false}
      />
    </div>
  )
}

// Small segmented control for the mono/sans experiment. Two options, the active one inverted
// (bright-on-panel) like the primary button — quiet, no accent (yellow stays the focus motif). Each
// label previews its own family so the choice reads at a glance.
function FontToggle({ value, onChange }: { value: "mono" | "sans"; onChange: (v: "mono" | "sans") => void }) {
  const opts: { v: "mono" | "sans"; label: string; cls: string }[] = [
    { v: "mono", label: "Mono", cls: "" },
    { v: "sans", label: "Sans", cls: "" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${o.cls} ${
            value === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// The ONE boolean control shape for the whole form: a segmented Off|On pair, Off always on the LEFT
// (switch convention — right = on). Active segment inverted like the font toggle.
function OnOffToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const opts: { v: boolean; label: string }[] = [
    { v: false, label: "Off" },
    { v: true, label: "On" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.label}
          onClick={() => onChange(o.v)}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${
            value === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Compact-diff preference: client-only (localStorage prefs proxy), applies live — diff blocks across
// the app collapse/expand the instant it flips, with no server round-trip at all.
function CompactToggle() {
  const { compactDiffs } = useSnapshot(prefs)
  return <OnOffToggle value={compactDiffs} onChange={(v) => (prefs.compactDiffs = v)} />
}

// Sticky most-recent-message preference: client-only (localStorage prefs proxy), applies live to every
// thread/queue-card the instant it flips. On by default — a collapsed, hover-to-expand bubble.
function StickyMessageControl() {
  const { stickyUserMessage } = useSnapshot(prefs)
  return <OnOffToggle value={stickyUserMessage} onChange={(v) => (prefs.stickyUserMessage = v)} />
}

// Queue/rested-band direction: client-only (localStorage prefs proxy), applies live to the Needs-you
// queue and the sidebar's rested rows the instant it flips. FIFO by default (oldest-active first).
function QueueOrderControl() {
  const { queueOrder } = useSnapshot(prefs)
  const opts: { v: "fifo" | "lifo"; label: string }[] = [
    { v: "fifo", label: "Oldest first" },
    { v: "lifo", label: "Newest first" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => (prefs.queueOrder = o.v)}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${
            queueOrder === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Shown only while "Skip all permissions" is selected. The same quiet register as PermHint below — the
// tooltip already carries the full explanation, and this is a standing operating mode rather than an
// error, so it states the consequence plainly instead of shouting it in danger-red.
function BypassHint() {
  return (
    <span className="text-[11px] text-muted/70">
      New Claude threads will run every command, edit, and network call without asking you first.
    </span>
  )
}

// Quiet, small permission-state line under the notifications toggle. Everything is muted (the old
// loud-red denied line read as an error); the denied state additionally offers a recovery assist,
// since a page can't re-prompt once denied.
function PermHint({ perm }: { perm: NotifPerm }) {
  if (perm === "denied") return <NotifDeniedHelp />
  const text: Record<Exclude<NotifPerm, "denied">, string> = {
    granted: "Browser permission granted — notifications fire when the window is hidden.",
    default: "Browser permission not yet granted — notifications won't fire until you allow them.",
    unsupported: "This browser does not support desktop notifications.",
  }
  return <span className="text-[11px] text-muted/70">{text[perm]}</span>
}

type Browser = "chrome" | "edge" | "safari" | "firefox" | "other"
function detectBrowser(): Browser {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : ""
  if (/Firefox\//.test(ua)) return "firefox"
  if (/Edg\//.test(ua)) return "edge"
  if (/OPR\/|Brave\//.test(ua)) return "other"
  if (/Chrome\//.test(ua)) return "chrome"
  if (/Safari\//.test(ua)) return "safari"
  return "other"
}

// Once a site's notification permission is DENIED, the page can no longer meaningfully re-invoke
// requestPermission, and chrome://about: URLs can't be opened from a web page — so no real deep link
// exists. Best UX: browser-specific one-line instructions, plus (Chromium) the exact site-settings
// address as selectable + copyable mono text. Muted + small; only shown in the denied state.
function NotifDeniedHelp() {
  const browser = useMemo(detectBrowser, [])
  const origin = typeof location !== "undefined" ? location.origin : ""
  const chromiumUrl = `${browser === "edge" ? "edge" : "chrome"}://settings/content/siteDetails?site=${encodeURIComponent(origin)}`

  return (
    <div className="flex flex-col gap-1 text-[11px] text-muted/70">
      <span>Notifications are blocked for this site. Re-enable them in your browser, then reload.</span>
      {browser === "chrome" || browser === "edge" ? (
        <CopyableAddress url={chromiumUrl} hint="Paste this into a new tab, set Notifications → Allow:" />
      ) : browser === "safari" ? (
        <span>Safari → Settings → Websites → Notifications → allow {hostOf(origin)}, then reload.</span>
      ) : browser === "firefox" ? (
        <span>Firefox → Settings → Privacy &amp; Security → Permissions → Notifications → Settings → allow this site.</span>
      ) : (
        <span>Open this site's notification permission in your browser's settings and set it to Allow.</span>
      )}
    </div>
  )
}

function hostOf(origin: string) {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function CopyableAddress({ url, hint }: { url: string; hint: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the address is still selectable inline */
    }
  }
  return (
    <span className="flex w-full flex-col gap-1">
      <span>{hint}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <code className="min-w-0 flex-1 font-mono-keep select-all rounded border border-border bg-bg px-1.5 py-0.5 text-[10.5px] text-fg/90 break-all">
          {url}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy address"
          className="shrink-0 rounded border border-border p-1 text-muted hover:bg-panel-2 hover:text-fg transition-colors"
        >
          {copied ? <Check size={11} className="text-live" /> : <Copy size={11} />}
        </button>
      </span>
    </span>
  )
}
