import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, FileText, Loader2, Paperclip, X } from "lucide-react"
import { ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, isAllowedAttachmentName } from "@frizz/shared"
import { showToast } from "../store.ts"
import { joinComposerValue, splitComposerValue } from "../lib/imagePaths.ts"
import { shouldInterruptSubmitComposerEnter, shouldRestoreOptionEnterNewline, shouldSubmitComposerEnter } from "../lib/composerKeyboard.ts"
import { queueComposerHandlesOptionEnter } from "../lib/queueComposerKeyboard.ts"
import { RAIL_ACTION_OFFSET, RAIL_PAPERCLIP_OFFSET, RAIL_PAPERCLIP_PLAIN_OFFSET, RAIL_RESERVE_PLAIN, RAIL_RESERVE_WITH_ACTION, RAIL_SEND_OFFSET } from "../lib/iconRhythm.ts"
import { apiBase } from "../lib/base-path.ts"
import { localImageUrl } from "../lib/markdownTargets.ts"

// The shared prompt composer (the pattern the user called "perfect"): ONE rounded bordered box
// holding a borderless auto-growing textarea plus a small round accent send button hovering INSIDE
// at the bottom-right. Grows with content up to maxHeight, then scrolls. Plain Enter submits;
// modifier-Enter uses the browser's native newline behavior, with a no-op fallback for Chromium's
// macOS Option-Enter quirk. Queue retains its separately-owned Option-Enter handling. Escape BLURS
// (climbs out — the next Esc, at rest, unwinds a drawer via
// App's window handler). Keyboard handling is entirely LOCAL: the focus machine that used to
// arbitrate boundary keys was deleted with the mouse-only sidebar. `surface` remains only as a
// data- tag for per-card input targeting (TodosView queries [data-surface="queueComposer"]).
// Upload a dropped/pasted/picked file and return its server-side absolute path. The path goes INTO the
// message text: workers open it with their Read/file tool; the chat renders images via /local-image and
// non-image files as an openable chip. The safe-tier allowlist (images + common docs/text/code) is
// enforced server-side too — the /attach route is the trust gate.
async function uploadAttachment(file: File, name: string): Promise<string | null> {
  // The project this upload is FOR, resolved before the file is read rather than after. `apiBase()`
  // answers for whatever the address bar says at the instant it is called, and reading a large file is
  // long enough for the operator to switch projects: the attachment then landed in the state directory
  // of a project the message was never going to, while the message itself went to the thread they
  // started from. Anything read across an await has to be captured on THIS side of it.
  const base = apiBase()
  const buf = await file.arrayBuffer()
  let bin = ""
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  const res = await fetch(`${base}/attach`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, data: btoa(bin) }),
  })
  if (!res.ok) return null
  const json = (await res.json()) as { path?: string }
  return json.path ?? null
}

export function Composer({
  value,
  onChange,
  onSubmit,
  surface,
  placeholder,
  id,
  minHeight = 44,
  maxHeight = 220,
  autoFocus,
  busy,
  footer,
  leftAction,
  slashSuggest,
  onInterruptSubmit,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  // Pure data- tag on the textarea (e.g. TodosView targets [data-surface="queueComposer"] to focus a
  // card's input). No focus registry behind it anymore.
  surface: string
  placeholder?: string
  id?: string
  minHeight?: number
  maxHeight?: number
  autoFocus?: boolean
  // While busy the textarea is locked and the send button spins — used for the New-thread dispatch
  // round-trip so the composer commits instantly instead of sitting live during the spawn.
  busy?: boolean
  // Rendered INSIDE the box along its bottom edge (the dispatch form's inline mode/model/effort
  // readouts). The textarea auto-grows above it; the footer strip is always reserved.
  footer?: React.ReactNode
  // A small action rendered just LEFT of the send button (the dispatch composer's GitHub-picker icon).
  // Only surfaces that pass it get it; reply/queue composers omit it.
  leftAction?: React.ReactNode
  // SKILLS TYPEAHEAD. When set, a draft that is exactly one `/`-led token opens a suggestion menu of
  // the thread's invocable skills above the box (fetched lazily, once, on first trigger). The list is
  // whatever the thread's own harness reports — the caller owns sourcing entirely; this component only
  // renders and completes. Surfaces without a session to ask (the dispatch composer) omit it and the
  // whole affordance is inert.
  slashSuggest?: () => Promise<Array<{ name: string; description: string }>>
  // INTERRUPT AND SEND, bound to ⌘/Ctrl-Enter. Set only while the thread's worker is mid-turn AND its
  // runtime can be preempted; the caller owns that policy entirely.
  //
  // KEYBOARD ONLY — there is deliberately no button here. It used to render a ⚡ in the rail, and the
  // bolt was the wrong picture of the thing (maintainer, 2026-08-03: "we need to drop the lightning
  // bolt icon to mean force push. That doesn't make any sense."). Preempting is now offered where the
  // waiting message actually IS: a ↑ on the queued bubble itself (UserBubble's push-now control), which
  // needs no message payload because the send is already in the provider's queue. The shortcut stays
  // because it is a real send path with muscle memory behind it — only the picture was wrong.
  onInterruptSubmit?: () => void
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)

  // Attachment paths live INSIDE the draft `value` (trailing lines) so submit, draft persistence, and
  // the worker/transcript pipeline stay untouched — but the box PRESENTS them as chips, not raw path
  // text. Split the value into the prose the textarea shows and the trailing attachment paths shown as
  // chips; recombine on every edit so the parent's `value` remains "prose + trailing paths" exactly.
  const { prose, attachments } = useMemo(() => splitComposerValue(value), [value])
  const attachmentPaths = attachments.map((a) => a.path)
  // Latest committed value, readable from an async callback that outlived its render. `takeFiles`
  // awaits the upload, so by the time it commits, `value`/`prose`/`attachmentPaths` in its closure may
  // be stale (the user typed, or another intake landed); it re-derives from this ref instead.
  const valueRef = useRef(value)
  valueRef.current = value
  // Synchronous in-box edits funnel through here: the textarea edits prose (paths unchanged); chip
  // removal edits the path list (prose unchanged). Either way the parent gets the rejoined value.
  const setProse = (nextProse: string) => onChange(joinComposerValue(nextProse, attachmentPaths))
  const setPaths = (nextPaths: string[]) => onChange(joinComposerValue(prose, nextPaths))

  // Attachment intake: drag-and-drop, paste, or the paperclip file picker. Each allowed file's absolute
  // path (returned by /attach) is appended to the message on its own line — images render as inline
  // blocks in the transcript, non-image docs as an openable chip, and the worker opens either with its
  // Read/file tool. An allowed file is any image by MIME (a pasted screenshot often has an empty/generic
  // name — the MIME check preserves the original image-paste behavior) OR any safe-tier file by name
  // (docs/text/code the picker's `accept` surfaces). The /attach route re-validates as the trust gate.
  async function takeFiles(files: FileList | File[] | null) {
    if (!files) return
    // Serialize intake: the paperclip button is disabled while uploading, but drop/paste are not, so a
    // second batch could race the first and clobber it (both commit against the same pre-upload base).
    // Reject the concurrent batch with feedback instead — uploads are quick; the user can re-drop.
    if (uploading) {
      showToast("An upload is already in progress — try again in a moment")
      return
    }
    // Effective upload name: the file's real name, else — for a nameless image paste — one derived
    // from its actual MIME subtype. The old blanket `"pasted.png"` fallback stored a TIFF/JPEG paste
    // as lying .png bytes (broken thumbnail, misled worker Read). The name then goes through the SAME
    // shared allowlist the server enforces, so nothing uploads only to 400, and every rejection gets
    // a toast instead of the old silent drop (dropping a .zip or unsupported image did nothing).
    const named = [...files].map((f) => {
      const sub = f.type.startsWith("image/") ? f.type.slice("image/".length).toLowerCase() : ""
      const ext = sub === "jpeg" ? "jpg" : sub === "svg+xml" ? "svg" : sub
      return { file: f, name: f.name || (ext ? `pasted.${ext}` : "") }
    })
    const typed = named.filter(({ name }) => {
      if (isAllowedAttachmentName(name)) return true
      showToast(`${name || "File"}: unsupported file type`)
      return false
    })
    if (!typed.length) return
    // Reject an oversized file up front with a clear message (the server would 400 anyway — surface it
    // instead of silently dropping). MB is base-10 to match how the OS reports file sizes; floor, so
    // the stated max is never larger than what the server actually accepts.
    const allowed = typed.filter(({ file, name }) => {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        showToast(`${name} is too large (max ${Math.floor(ATTACHMENT_MAX_BYTES / 1e6)} MB)`)
        return false
      }
      return true
    })
    if (!allowed.length) return
    // Snapshot the draft at intake: if it is non-empty now but EMPTY when the upload lands, the
    // message was sent (or the draft deliberately cleared) mid-upload — committing the path then
    // would plant an orphan chip that silently rides along with the user's NEXT, unrelated message.
    // Discard with a toast instead. (Enter/Send inside this box are gated on `uploading`, but a
    // surface can still clear the draft externally — the queue card's "Send answers" button.)
    // Best-effort heuristic, not airtight: typing NEW text after such an external clear makes the
    // draft non-empty again before the upload lands, and the path then joins that newer draft.
    const baseValue = valueRef.current
    setUploading(true)
    const paths: string[] = []
    try {
      for (const { file, name } of allowed) {
        const path = await uploadAttachment(file, name)
        // A null means /attach rejected it (decode/write failure — the type allowlist already ran
        // client-side above). Don't leave the user guessing why nothing appeared.
        if (path) paths.push(path)
        else showToast(`Could not attach ${name}`)
      }
    } finally {
      setUploading(false)
    }
    if (paths.length && baseValue !== "" && valueRef.current === "") {
      showToast("Attachment discarded — the message was sent before the upload finished")
      requestAnimationFrame(() => taRef.current?.focus())
      return
    }
    // Commit against the LATEST value (valueRef), not this callback's render-time closure — the user
    // may have typed, or a prior intake committed, while the upload was in flight. Re-derive prose +
    // existing paths from the freshest value and append this batch, so nothing typed/attached mid-upload
    // is clobbered. The paperclip picker (and, on some browsers, drop/paste) pull focus off the textarea;
    // restore it after the async upload settles so the user can keep typing without re-clicking the box.
    if (paths.length) {
      const latest = splitComposerValue(valueRef.current)
      onChange(joinComposerValue(latest.prose, [...latest.attachments.map((a) => a.path), ...paths]))
    }
    requestAnimationFrame(() => taRef.current?.focus())
  }

  // Auto-grow: reset to auto, then snap to content height clamped at maxHeight. A first layout pass
  // can precede font settlement or a narrow drawer's final width, leaving scrollHeight stale and the
  // last wrapped line hidden beneath the in-box controls. Recheck on the next frame and when fonts
  // settle so the textarea always owns enough height for its actual wrapped content.
  useLayoutEffect(() => {
    let active = true
    const resize = () => {
      const el = taRef.current
      if (!el || !active) return
      el.style.height = "auto"
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    }
    resize()
    const frame = requestAnimationFrame(resize)
    void document.fonts?.ready.then(resize)
    const el = taRef.current
    let width = el?.clientWidth ?? 0
    // A responsive drawer can rewrap a preserved draft without changing its value. Observe width
    // only (not height, which this effect itself owns) and recompute from the new scrollHeight.
    let resizeFrame: number | undefined
    const observer = el ? new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry.contentRect.width)
      if (nextWidth === width) return
      width = nextWidth
      // Writing `height` while ResizeObserver is delivering causes Chromium's loop warning. Run the
      // measurement in the next frame: the composer still tracks a drawer rewrap, without a browser
      // console error for every narrow-width resize.
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(resize)
    }) : undefined
    if (el) observer?.observe(el)
    return () => {
      active = false
      cancelAnimationFrame(frame)
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      observer?.disconnect()
    }
    // Footer PRESENCE (not node identity) is the layout signal: it flips the textarea's bottom
    // padding class. Some call sites rebuild the footer JSX every parent render (each board tick on
    // an open thread), and depending on the node itself tore down and rebuilt the ResizeObserver +
    // fonts.ready hook on every one of those renders for zero layout change.
  }, [value, maxHeight, Boolean(footer)])

  // The browser BLURS a focused element the instant it becomes `disabled`, so every `busy` window
  // evicts the caret and the user must re-click the box to keep typing. A focusout whose target is
  // ALREADY disabled is exactly that eviction and nothing else (a user-initiated blur always fires
  // while the element is still enabled), so it is the precise signal for taking focus back once the
  // box unlocks — and it is why a surface that deliberately blurs on send (the queue card dissolving
  // itself) is honored rather than fought: that blur lands while still enabled and never arms this.
  // The listener must be NATIVE: React does not dispatch synthetic events for disabled form controls,
  // so `onBlur` never sees this one (verified in a real browser — the synthetic handler stays silent
  // while the native focusout fires with disabled=true). Note `busy` is not only the send round-trip:
  // it also tracks board-derived control state, so this can fire on a lock the user never initiated.
  const evictedRef = useRef(false)
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    const onFocusOut = () => { evictedRef.current = el.disabled }
    el.addEventListener("focusout", onFocusOut)
    return () => el.removeEventListener("focusout", onFocusOut)
  }, [])
  useEffect(() => {
    if (busy || !evictedRef.current) return
    evictedRef.current = false
    // Restore only INTO THE VACUUM the eviction left — never steal focus back from somewhere the user
    // deliberately moved while the box was locked. The vacuum is <body> when the composer sits on the
    // page, but inside a modal drawer Radix's focus scope catches the eviction on the dialog container
    // instead; both are ANCESTORS of the box, which is exactly what a deliberate destination is not.
    const el = taRef.current
    const active = document.activeElement
    // preventScroll: this restore can land seconds after the send (a dispatch waits out session
    // startup), by which time the user may have scrolled far away — taking focus back must not yank
    // the page with it.
    if (el && (!active || active.contains(el))) el.focus({ preventScroll: true })
  }, [busy])

  // SKILLS TYPEAHEAD state. `skillItems` is the harness's list, fetched once on the first `/` trigger
  // (null = not asked yet; [] = asked, nothing to offer — including a fetch that failed, which must
  // read as "no suggestions", never as an error the operator has to dismiss). `dismissedFor` records
  // the exact draft an Escape closed the menu over, so it stays closed until the draft CHANGES —
  // without it the menu would reopen on the very next render.
  const [skillItems, setSkillItems] = useState<Array<{ name: string; description: string }> | null>(null)
  const [suggestSel, setSuggestSel] = useState(0)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  // Active while the draft is exactly one `/`-led token — the shape of a skill invocation still being
  // typed. A space (arguments have begun) or a newline closes it.
  const slashActive = Boolean(slashSuggest) && /^\/\S*$/.test(prose)
  useEffect(() => {
    if (!slashActive || skillItems !== null) return
    let live = true
    // Errors resolve to "asked, nothing to offer": the caller decides whether to retry on a later
    // trigger by handing this component a fresh mount (drawer reopen) — a typeahead never toasts.
    void slashSuggest!().then(
      (items) => { if (live) setSkillItems(items) },
      () => { if (live) setSkillItems([]) },
    )
    return () => { live = false }
  }, [slashActive, skillItems, slashSuggest])
  const suggestions = useMemo(() => {
    if (!slashActive || !skillItems || dismissedFor === prose) return []
    const query = prose.slice(1).toLowerCase()
    // Prefix matches first (what completion usually wants), then substring matches — those are what
    // surface a namespaced skill (`frizz:gh`) from its bare name.
    const starts = skillItems.filter((s) => s.name.toLowerCase().startsWith(query))
    const contains = skillItems.filter((s) => !s.name.toLowerCase().startsWith(query) && s.name.toLowerCase().includes(query))
    return [...starts, ...contains]
  }, [slashActive, skillItems, dismissedFor, prose])
  const suggestOpen = suggestions.length > 0
  // Reset the highlight whenever the draft changes: the filtered list under it just changed too.
  useEffect(() => { setSuggestSel(0) }, [prose])
  // Keep the highlighted row in view when arrowing through a list taller than the menu.
  const suggestListRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    suggestListRef.current?.querySelector(`[data-suggest-index="${suggestSel}"]`)?.scrollIntoView({ block: "nearest" })
  }, [suggestSel])
  function acceptSuggestion(item: { name: string }) {
    const next = `/${item.name} `
    setProse(next)
    requestAnimationFrame(() => taRef.current?.setSelectionRange(next.length, next.length))
  }

  const hasContent = value.trim().length > 0
  // ONE rail slot. Reserving it must track what is actually rendered — the padding/offset classes below
  // key off `railAction`, and a truthy element that renders null would carve out an empty hole (the bug
  // GithubTrigger's `useGithubTriggerVisible` exists to prevent). Its only filler now is `leftAction`
  // (the dispatch composer's GitHub picker); interrupt-and-send gave up its button here and kept only
  // ⌘/Ctrl-Enter — see the `onInterruptSubmit` prop doc.
  const railAction = leftAction ?? null

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget
    const keyboardEvent = {
      key: e.key,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing,
      keyCode: e.keyCode,
    }
    // The open skills menu claims its keys FIRST — above all Enter (accept, not send) and Escape
    // (close the menu, not blur; the blur branch below must not see this keypress). Modified Enter
    // deliberately falls through: ⌘-Enter mid-name is the operator overriding the menu, not using it.
    if (suggestOpen && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        setSuggestSel((current) => {
          const delta = e.key === "ArrowDown" ? 1 : -1
          return (current + delta + suggestions.length) % suggestions.length
        })
        return
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        acceptSuggestion(suggestions[suggestSel] ?? suggestions[0])
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        setDismissedFor(prose)
        return
      }
    }
    if (queueComposerHandlesOptionEnter(surface, e.key, e.altKey)) {
      // Option-Enter inserts a newline EXPLICITLY (Claude Code muscle memory). Merely exempting it
      // from submit is not enough: on macOS Chrome, Option-Enter in a textarea inserts nothing
      // natively, so we splice the newline at the caret ourselves and restore the caret after the
      // controlled re-render.
      e.preventDefault()
      e.stopPropagation()
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? start
      setProse(el.value.slice(0, start) + "\n" + el.value.slice(end))
      requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1))
      return
    }
    // `!uploading` closes a confirmed data-loss race: Enter while /attach is in flight used to send
    // the prose WITHOUT the pending attachment, whose path then landed in the cleared composer and
    // silently rode along with the next unrelated message. Typing stays enabled during upload (the
    // commit re-derives from valueRef); only SENDING waits for the attachment to land.
    if (shouldSubmitComposerEnter(keyboardEvent, hasContent && !busy && !uploading)) {
      // Only a plain Enter submits. Modified Enter and IME composition deliberately retain native
      // textarea behavior, so they cannot accidentally submit or lose their newline.
      e.preventDefault()
      e.stopPropagation()
      onSubmit()
      return
    }
    // ⌘/Ctrl-Enter — same send, but it preempts what the worker is doing so the message is read now
    // instead of when the current command finishes. Ordered AFTER the plain-Enter branch (which it
    // cannot match) and BEFORE the Option-Enter newline repair (which it also cannot match).
    if (shouldInterruptSubmitComposerEnter(keyboardEvent, Boolean(onInterruptSubmit) && hasContent && !busy && !uploading)) {
      e.preventDefault()
      e.stopPropagation()
      onInterruptSubmit!()
      return
    }
    if (shouldRestoreOptionEnterNewline(keyboardEvent)) {
      // Do NOT prevent the modifier path: first allow the browser to insert its native newline.
      // Chromium/macOS sometimes leaves the DOM unchanged, so repair only that no-op on the next
      // frame; browsers that did insert keep their value and never take this branch.
      const before = el.value
      const start = el.selectionStart ?? before.length
      const end = el.selectionEnd ?? start
      requestAnimationFrame(() => {
        if (el.value !== before) return
        setProse(before.slice(0, start) + "\n" + before.slice(end))
        requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1))
      })
    }
    if (e.key === "Escape" && !e.nativeEvent.isComposing) {
      // Climb out: blur the textarea and STOP the event — the same physical keypress must not also
      // reach App's window handler and pop a drawer. The NEXT Esc, at rest, unwinds normally.
      // Mid-IME-composition Esc is the IME's own cancel — leave it to the editor, don't blur.
      e.preventDefault()
      e.stopPropagation()
      el.blur()
    }
    // Arrow keys just move the caret — no boundary semantics (the nav walk they used to drive is gone).
  }

  return (
    // Focused = the accent (yellow) border: the visual handoff from the nav chevron to the box.
    // While a file drags over, the border dashes and a hint overlay appears (screenshot intake).
    <div
      className={`group relative rounded-xl border bg-bg transition-colors focus-within:border-accent ${
        dragging ? "border-dashed border-accent" : "border-border"
      }`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void takeFiles(e.dataTransfer.files)
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-bg/80 text-[12px] text-muted">
          Drop file to attach
        </div>
      )}
      {/* The skills menu, floated ABOVE the box (the composer lives at the bottom of its surface, so
          up is the direction with room). Rows are text-only — a name and its one-line description —
          which keeps this out of icon-ink territory entirely. Mousedown is prevented on every row for
          the same reason as the send button: choosing a suggestion must never blur the textarea. */}
      {suggestOpen && (
        <div
          ref={suggestListRef}
          data-slash-menu
          className="absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-56 overflow-y-auto rounded-lg border border-border bg-bg py-1 shadow-lg"
        >
          {suggestions.map((s, i) => (
            <button
              key={s.name}
              type="button"
              data-suggest-index={i}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => acceptSuggestion(s)}
              onMouseEnter={() => setSuggestSel(i)}
              // px-3.5 matches the textarea's own text inset, so the completed `/name` lands exactly
              // under the row that offered it.
              className={`flex w-full items-baseline gap-2 px-3.5 py-1.5 text-left ${i === suggestSel ? "bg-panel-2" : ""}`}
            >
              <span className="shrink-0 text-[12px] font-medium text-fg">/{s.name}</span>
              {s.description && <span className="min-w-0 truncate text-[11px] text-muted">{s.description}</span>}
            </button>
          ))}
        </div>
      )}
      <textarea
        id={id}
        ref={taRef}
        data-surface={surface}
        value={prose}
        autoFocus={autoFocus}
        disabled={busy}
        onChange={(e) => setProse(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          // Any file item claims the whole paste (preventDefault) — deliberately. An image paste
          // usually carries a junk text/html or filename text/plain fallback that must NOT be
          // inserted as text. Known trade-off: a genuinely mixed text+file clipboard loses its text
          // half; revisit only with a heuristic that can tell the fallback from real prose.
          const files = [...e.clipboardData.items].filter((i) => i.kind === "file").map((i) => i.getAsFile()!).filter(Boolean)
          if (files.length) {
            e.preventDefault()
            void takeFiles(files)
          }
        }}
        placeholder={placeholder}
        rows={1}
        spellCheck={false}
        style={{ minHeight, maxHeight }}
        // With a footer strip the box is an INSET-FOOTER layout: the strip below already reserves the
        // vertical band the floating buttons occupy, so the text runs FULL width (no right rail carved
        // out of every line). Without a footer the box is a single compact row and the right padding is
        // what keeps text from sliding under the floating paperclip/send buttons.
        className={`block w-full resize-none bg-transparent px-3.5 ${footer ? "py-2.5 pb-3" : `py-2.5 ${railAction ? RAIL_RESERVE_WITH_ACTION : RAIL_RESERVE_PLAIN}`} text-[13px] leading-relaxed text-fg outline-none placeholder:text-muted scrollbar-none disabled:opacity-60`}
      />
      {/* Attachment chips along the bottom row — one square tile per attached file (image thumbnail or
          file-type icon), each removable. The paths still live in `value`; these tiles just render them
          instead of the raw absolute-path text. Reserve the right rail so tiles never slip under the
          paperclip/send buttons on the last row. */}
      {attachments.length > 0 && (
        <div className={`flex flex-wrap gap-1.5 px-3 pb-2 ${railAction ? RAIL_RESERVE_WITH_ACTION : RAIL_RESERVE_PLAIN}`}>
          {attachments.map((a, i) => (
            <AttachmentChip
              key={`${a.path}-${i}`}
              attachment={a}
              disabled={busy}
              onRemove={() => setPaths(attachmentPaths.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}
      {/* Inline footer strip along the bottom edge — always reserved below the auto-growing text.
          Inset = 6px (px-1.5 pb-1.5) so the leftmost readout chip's rounded-md (6px) bottom-left
          corner reads CONCENTRIC with the box's rounded-xl (12px): inner radius (6) = outer (12) −
          inset (6), i.e. both arcs share a center. At the old px-2 (8px) the chip's corner sat 2px
          inside the box arc and read misaligned. */}
      {/* Reserve the right-side action rail. Without this, three shrinkable readouts can extend under
          the absolutely positioned GitHub/send buttons on narrow composers. */}
      {footer && <div className={`flex min-w-0 flex-wrap items-center gap-1 pl-1.5 pb-1.5 ${railAction ? RAIL_RESERVE_WITH_ACTION : RAIL_RESERVE_PLAIN}`}>{footer}</div>}
      {/* THE RIGHT RAIL, right to left: send, then the optional rail action, then the paperclip. The
          offsets are NOT an even 36px pitch any more — they are derived from each button's INK, which
          is the only thing the eye measures the rail by. Send is a FILLED square, so its ink is its
          whole 28px box; the paperclip paints 13px of its 28 and the GitHub mark 12.75, so an even
          pitch put 22.25px of clear space between the two icons against 15.75px between the GitHub
          mark and send — "the attachment icon and the GitHub icon feel further apart than the GitHub
          icon and the up arrow" (maintainer 2026-08-04). The derivation and the residual are in
          lib/iconRhythm.ts; the rows above reserve the leftmost button's box edge + 8px so prose keeps
          its clearance off the rail either way. */}
      {railAction && <div className={`absolute bottom-2 ${RAIL_ACTION_OFFSET} flex items-center`}>{railAction}</div>}
      {/* Attach: a hidden file input driven by the paperclip. Sits in the right rail LEFT of the send
          button (and left of any railAction), so it never overlaps the mode/model footer or the send
          affordance. Accept is the shared safe-tier allowlist; the /attach route re-validates. */}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void takeFiles(e.target.files)
          e.target.value = "" // reset so re-picking the same file fires change again
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy || uploading}
        title="Attach files"
        aria-label="Attach files"
        // With no rail action the paperclip TAKES the rail-action slot — at its OWN offset, not the
        // rail action’s, because it paints 1px less dead space on that side (lib/iconRhythm.ts).
        className={`absolute bottom-2 ${railAction ? RAIL_PAPERCLIP_OFFSET : RAIL_PAPERCLIP_PLAIN_OFFSET} flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-[color,background-color] enabled:hover:bg-panel-2/70 enabled:hover:text-fg disabled:opacity-50`}
      >
        {uploading ? <Loader2 size={15} strokeWidth={2} className="animate-spin" /> : <Paperclip size={15} strokeWidth={2} />}
      </button>
      <button
        type="button"
        // Prevent the mousedown default so clicking Send never blurs the textarea (the repo's idiom for
        // every submit affordance that sits beside a live input). Focus then never leaves the box on the
        // click path, so there is nothing to restore — and a surface that blurs on send stays in charge.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSubmit}
        // `uploading` mirrors the Enter gate above: sending mid-upload dropped the pending attachment.
        disabled={!hasContent || busy || uploading}
        title="Send (Enter)"
        aria-label="Send"
        className={`absolute bottom-2 ${RAIL_SEND_OFFSET} flex h-7 w-7 items-center justify-center rounded-lg transition-all ${
          // Active = neutral-bright (light-on-dark) primary, NOT accent — yellow stays the focus motif.
          hasContent && !busy && !uploading
            ? "bg-fg text-bg hover:opacity-90 active:scale-95"
            : "bg-panel-2 text-muted"
        }`}
      >
        {busy ? <Loader2 size={14} strokeWidth={2.5} className="animate-spin" /> : <ArrowUp size={14} strokeWidth={2.5} />}
      </button>
    </div>
  )
}

// One attached file as a compact square tile. An image renders a /local-image thumbnail (object-cover,
// the same gated route the transcript uses); a document renders a bordered tile with a file glyph and
// its extension. A broken image (route 4xx / missing file) falls back to the document tile so a stale
// path is never a blank square. The × removes just this path from the draft. `title` carries the full
// path so the raw location is still one hover away.
function AttachmentChip({
  attachment,
  disabled,
  onRemove,
}: {
  attachment: { path: string; kind: "image" | "file" }
  disabled?: boolean
  onRemove: () => void
}) {
  const [broken, setBroken] = useState(false)
  const base = attachment.path.split("/").filter(Boolean).pop() || attachment.path
  const ext = (base.includes(".") ? base.split(".").pop()! : "").toUpperCase()
  const asImage = attachment.kind === "image" && !broken
  return (
    <div className="group/att relative h-11 w-11" title={base}>
      {asImage ? (
        <img
          src={localImageUrl(attachment.path)}
          alt={base}
          onError={() => setBroken(true)}
          className="h-11 w-11 rounded-md border border-border object-cover"
        />
      ) : (
        <div className="flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-md border border-border bg-panel-2 px-1">
          <FileText size={15} strokeWidth={2} className="shrink-0 text-muted" />
          {ext && <span className="max-w-full truncate text-[8px] font-medium leading-none text-muted/80">{ext}</span>}
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        title={`Remove ${base}`}
        aria-label={`Remove ${base}`}
        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-bg text-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/att:opacity-100 disabled:hidden"
      >
        <X size={10} strokeWidth={2.5} />
      </button>
    </div>
  )
}
