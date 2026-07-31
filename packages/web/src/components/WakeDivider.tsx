// The hairline+label+hairline chrome of a WAKE DIVIDER — extracted from ChatView so any surface can
// wear it without importing the whole thread view (and without a module cycle: ChatView imports the
// GitHub wake card, so the wake card could not reach back into ChatView for this).
//
// It is the one rendering EVERY child-event now shares. A background shell coming to rest, a Monitor
// timing out, a sub-agent finishing, a sub-agent reporting up mid-flight, and a pr-watch wake are the
// same class of event (something the worker is waiting on has reached a notable state, usually
// re-invoking the agent), and they read the same way: a centred section break that stands out from the
// tool cards around it, rather than one of them being a card indistinguishable from a hundred others
// (maintainer 2026-07-27). `children` is the whole line for a shell; the agent and GitHub dividers pass
// nodes so their titles can be links.
import type { ReactNode } from "react"
import { MessageDebugId } from "./MessageDebugId.tsx"

export function WakeDivider({ children, sourceId, ariaLabel, marker }: { children: ReactNode; sourceId?: string; ariaLabel?: string; marker?: string }) {
  return (
    <div
      data-fray-msg={sourceId}
      data-wake-divider={marker}
      className="group/msg relative my-1 flex items-center gap-3"
      // A divider carrying an interactive title is not an ARIA `separator` (a separator may not own a
      // focus stop), so only the inert shell-wake form takes the role — via `ariaLabel`.
      role={ariaLabel ? "separator" : undefined}
      aria-label={ariaLabel}
    >
      <MessageDebugId sourceId={sourceId} />
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      <span className="petite-caps flex min-w-0 items-center gap-1 break-words text-center text-[12px] text-muted/70">{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
    </div>
  )
}

// Identifiers riding INSIDE a divider's petite-caps label keep ordinary case. A GitHub login and an
// `owner/repo#N` are tokens you match against GitHub by eye, and small-capping them makes them read as
// prose — the surrounding frame words are what the petite-caps treatment is for.
export const WAKE_DIVIDER_IDENT = "[font-variant-caps:normal]"

// A lucide glyph riding a divider's label. It does NOT take ICON_LABEL_NUDGE, and the reason is the
// petite caps: that nudge is calibrated against a NORMAL-case label, which inks from cap-top to
// baseline, while this label inks from roughly x-height to baseline. The text's optical centre is
// therefore ~1.2px LOWER here, so a glyph centred by `items-center` reads HIGH rather than low — the
// opposite correction, and applying the ordinary nudge under mono (−1.7px) would push it ~2.1px high.
//
// Measured in the running app at 12px, with the ordinary nudge neutralized, against the label's own
// petite-caps ink (canvas `fontVariantCaps`, which the `font` shorthand CANNOT express — measuring a
// full cap band instead is what hid this in the first pass): +0.57px under system-ui, +0.45px under
// mono. Both stacks want the SAME sign and nearly the same amount, unlike ICON_LABEL_NUDGE, so this is
// one constant rather than a font-flipped variable. Residual after correcting: +0.09px / −0.03px.
//
// CALIBRATED FOR THE SIZE THAT SHIPS — this divider's 12px label in an 18px line box — and NOT claimed
// scale-invariant. The label's leading is a fixed 18px, so doubling the type size does not double the
// line box the glyph is centred in, and the required correction grows ~4x rather than 2x. The `em`
// spelling is the safer default if the scale and the leading ever move together; if either moves
// alone, re-measure rather than trusting this number.
export const WAKE_DIVIDER_ICON = "shrink-0 translate-y-[0.04em]"
