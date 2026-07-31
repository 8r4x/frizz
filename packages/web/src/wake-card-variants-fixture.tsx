// DESIGN ARTIFACT — ten renderings of the GitHub pr-watch wake, side by side, for the maintainer to
// pick from ("I hate the design of the new comment notification card… design a bunch of alternatives").
//
// Every variant is built out of the app's REAL tokens and the real lucide glyphs, in the real font
// stacks, so what the shot shows is what would ship. Variant 0 is the CURRENT card rendered through
// the actual `GithubWakeCard` component off a real `formatGithubWakeSteer` string — the baseline is
// literally the shipped code, not a redraw of it.
//
// Delete this fixture once a variant is chosen and built.
import { useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { Bot, Github, MessageSquare, User } from "lucide-react"
import { formatGithubWakeSteer, type GithubWakeSteer } from "@fray-ui/shared"
import { GithubWakeCard } from "./components/GithubWakeCard.tsx"
import { wakeItemAge } from "./lib/githubWakeCard.ts"
import { ICON_LABEL_NUDGE } from "./lib/iconAlign.ts"
import "./styles.css"

const PR_URL = "https://github.com/nubjs/nub/pull/587"
const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString()

const SINGLE: GithubWakeSteer = {
  ref: "nubjs/nub#587",
  omitted: 0,
  items: [{ label: "review comment", actor: "pullfrog", bot: true, at: at(6), url: `${PR_URL}#discussion_r2211884` }],
}
const BURST: GithubWakeSteer = {
  ref: "nubjs/nub#587",
  omitted: 0,
  items: [
    { label: "review comment", actor: "pullfrog", bot: true, at: at(6), url: `${PR_URL}#discussion_r2211884` },
    { label: "comment", actor: "colinhacks", bot: false, at: at(11), url: `${PR_URL}#issuecomment-33412` },
    { label: "approval", actor: "colinhacks", bot: false, at: at(12), url: `${PR_URL}#pullrequestreview-991` },
  ],
}

const AGE = wakeItemAge(SINGLE.items[0].at)!
const ITEM_URL = SINGLE.items[0].url!
// Identifiers inside a petite-caps line stay in ordinary case: a login and an `owner/repo#N` are
// tokens you match against GitHub, and small-capping them makes them read as prose.
const IDENT = "[font-variant-caps:normal]"

// ── shared leaf pieces ────────────────────────────────────────────────────────────────────────────

function Ref({ className = "text-accent" }: { className?: string }) {
  return (
    <a href={PR_URL} className={`${className} underline decoration-current/40 underline-offset-2 hover:decoration-current`}>
      nubjs/nub#587
    </a>
  )
}
function Actor({ className = "" }: { className?: string }) {
  return <span className={className}>@pullfrog</span>
}
function Avatar({ size = 18, actor = "pullfrog" }: { size?: number; actor?: string }) {
  return (
    <img
      src={`https://github.com/${actor}.png?size=64`}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-full ring-1 ring-border"
      style={{ width: size, height: size }}
    />
  )
}
// One hover/focus treatment for a whole-row target, so a variant that makes the entire line clickable
// says so the same way everywhere.
const ROW_HOVER = "outline-none transition-colors hover:bg-elevated/70 focus-visible:bg-elevated/70"

// ── the variants ──────────────────────────────────────────────────────────────────────────────────

// 0 — what ships today. The real component, off the real wire format.
function V0({ steer, dense }: { steer: GithubWakeSteer; dense: boolean }) {
  return <GithubWakeCard text={formatGithubWakeSteer(steer)} wrap={dense} />
}

// 1 — the app's OWN divider idiom (WakeDivider), which already carries every other child event: a
// background shell resting, a Monitor timing out, a sub-agent completing, a sub-agent reporting up.
function V1({ steer }: { steer: GithubWakeSteer }) {
  const one = steer.items.length === 1
  return (
    <div className="flex flex-col gap-1">
      <div className="my-1 flex items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-border/70" />
        {/* The age sits OUTSIDE the truncating span and never shrinks: at queue width the sentence
            clips, but "how stale is this" is the one field that must survive the clip. */}
        <span className="petite-caps flex min-w-0 items-center gap-1.5 text-[12px] text-muted/70">
          <Github size={12} className={`shrink-0 ${ICON_LABEL_NUDGE}`} />
          <span className="min-w-0 truncate">
            {one ? (
              <>
                New {steer.items[0].label} from <Actor className={`${IDENT} text-fg/80`} /> on <Ref className={`${IDENT} text-muted/70`} />
              </>
            ) : (
              <>
                {steer.items.length} new items on <Ref className={`${IDENT} text-muted/70`} />
              </>
            )}
          </span>
          {one && <span className={`${IDENT} shrink-0 tabular-nums`}>· {AGE}</span>}
        </span>
        <span aria-hidden className="h-px flex-1 bg-border/70" />
      </div>
      {!one && <BurstRows steer={steer} className="mx-auto" />}
    </div>
  )
}

// 2 — the same hairline, but ANCHORED LEFT so the label starts on the transcript's own spine and the
// rule runs out to the right. Nothing is centred, so nothing floats.
function V2({ steer }: { steer: GithubWakeSteer }) {
  const one = steer.items.length === 1
  return (
    <div className="flex flex-col gap-1">
      <div className="my-1 flex items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-5 text-muted">
          <Github size={12} className={`shrink-0 ${ICON_LABEL_NUDGE}`} />
          <span className="min-w-0 truncate">
            {one ? (
              <>
                <span className="text-fg/85">New {steer.items[0].label} from @pullfrog</span> on <Ref className="text-muted" />
              </>
            ) : (
              <>
                {steer.items.length} new items on <Ref className="text-muted" />
              </>
            )}
          </span>
          {one && <span className="shrink-0 tabular-nums text-muted/70">· {AGE}</span>}
        </span>
        <span aria-hidden className="h-px min-w-4 flex-1 bg-border/70" />
      </div>
      {!one && <BurstRows steer={steer} />}
    </div>
  )
}

// 3 — a CHIP that shrinks to its content. The current card's worst feature is ~500px of dead air
// between the title and the right-justified ref; a fit-width pill cannot have any.
function V3({ steer }: { steer: GithubWakeSteer }) {
  const one = steer.items.length === 1
  return (
    <div className="flex flex-col gap-1.5">
      <a
        href={one ? ITEM_URL : PR_URL}
        className={`flex w-fit max-w-full items-center gap-2 rounded-full border border-border bg-panel-2 py-1 pl-2.5 pr-3 text-[12px] leading-5 ${ROW_HOVER}`}
      >
        <Github size={12} className={`shrink-0 text-muted ${ICON_LABEL_NUDGE}`} />
        <span className="min-w-0 truncate text-fg/85">
          {one ? (
            <>
              New {steer.items[0].label} from <span className="text-fg">@pullfrog</span>
            </>
          ) : (
            `${steer.items.length} new items`
          )}
        </span>
        <span aria-hidden className="h-3 w-px shrink-0 bg-border-strong" />
        <span className="shrink-0 text-accent">nubjs/nub#587</span>
        {one && <span className="shrink-0 tabular-nums text-muted/70">{AGE}</span>}
      </a>
      {!one && <BurstRows steer={steer} />}
    </div>
  )
}

// 4 — NO chrome at all: the transcript-metadata line, the same quiet full-width row `Ran 2 tool calls`
// wears. A wake is peer progress, not an announcement.
function V4({ steer }: { steer: GithubWakeSteer }) {
  const one = steer.items.length === 1
  return (
    <div className="flex flex-col">
      <a
        href={one ? ITEM_URL : PR_URL}
        className={`-mx-2 flex items-center gap-2 rounded px-2 py-0.5 text-[14px] leading-5 text-muted ${ROW_HOVER}`}
      >
        <Github size={14} className={`shrink-0 ${ICON_LABEL_NUDGE}`} />
        {/* The age rides IMMEDIATELY after the sentence rather than being pinned to the right edge —
            pinning it is exactly what opens the ~500px of dead middle the current card is disliked for. */}
        <span className="min-w-0 truncate">
          {one ? (
            <>
              New {steer.items[0].label} from <span className="text-fg/80">@pullfrog</span> on <span className="text-accent">nubjs/nub#587</span>
            </>
          ) : (
            <>
              {steer.items.length} new items on <span className="text-accent">nubjs/nub#587</span>
            </>
          )}
        </span>
        {one && <span className="shrink-0 tabular-nums text-[12px] text-muted/60">· {AGE}</span>}
      </a>
      {!one && <BurstRows steer={steer} />}
    </div>
  )
}

// 5 — AVATAR-led, the way GitHub itself says "who did this". The face is the fastest actor lookup
// there is, and it lets the sentence drop the `@login` prefix noise.
function V5({ steer }: { steer: GithubWakeSteer }) {
  const one = steer.items.length === 1
  if (!one) {
    return (
      <div className="flex w-fit max-w-full flex-col gap-1 rounded-xl border border-border bg-panel-2 px-3 py-2">
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <Github size={12} className={`shrink-0 ${ICON_LABEL_NUDGE}`} />
          {steer.items.length} new items on <Ref />
        </div>
        {steer.items.map((i) => (
          <a key={i.url} href={i.url} className={`-mx-1 flex items-center gap-2 rounded px-1 py-0.5 text-[12px] leading-5 ${ROW_HOVER}`}>
            <Avatar size={16} actor={i.actor} />
            <span className="text-fg/90">@{i.actor}</span>
            <span className="text-muted">{i.label}</span>
            <span className="tabular-nums text-muted/60">{wakeItemAge(i.at)}</span>
          </a>
        ))}
      </div>
    )
  }
  return (
    <a
      href={ITEM_URL}
      className={`flex w-fit max-w-full items-center gap-2 rounded-lg border border-border bg-panel-2 py-1.5 pl-2 pr-3 text-[13px] leading-5 ${ROW_HOVER}`}
    >
      <Avatar />
      <span className="min-w-0 truncate">
        <span className="text-fg">@pullfrog</span>
        <span className="text-muted"> left a {steer.items[0].label} on </span>
        <span className="text-accent">nubjs/nub#587</span>
      </span>
      <span className="shrink-0 tabular-nums text-[12px] text-muted/60">{AGE}</span>
    </a>
  )
}

// 6 — a TIMELINE entry: an accent rail down the left, no box. GitHub's own event language, and the
// rail is a much cheaper "something happened here" mark than four borders and a fill.
function V6({ steer }: { steer: GithubWakeSteer }) {
  const one = steer.items.length === 1
  return (
    <div className="border-l-2 border-accent/40 py-0.5 pl-3">
      <div className="flex items-baseline gap-2 text-[13px] leading-5">
        <span className="min-w-0">
          <span className="font-medium text-fg/90">{one ? `New ${steer.items[0].label} from @pullfrog` : `${steer.items.length} new items`}</span>
          <span className="text-muted"> on </span>
          <Ref />
        </span>
        {one && <span className="shrink-0 tabular-nums text-[12px] text-muted/60">{AGE}</span>}
      </div>
      {!one && <BurstRows steer={steer} className="mt-0.5" />}
    </div>
  )
}

// 7 — keep the CARD, but size it for its content: fit-width, one control-scale inset, the glyph
// leading the line instead of parked in a corner it has nothing to anchor to.
function V7({ steer }: { steer: GithubWakeSteer }) {
  const one = steer.items.length === 1
  return (
    <div className="w-fit max-w-full rounded-lg border border-border-strong bg-panel-2 px-3 py-2">
      <a href={one ? ITEM_URL : PR_URL} className="flex items-center gap-2 text-[13px] leading-5">
        <Github size={13} className={`shrink-0 text-muted ${ICON_LABEL_NUDGE}`} />
        <span className="min-w-0 truncate text-fg/90">{one ? `New ${steer.items[0].label} from @pullfrog` : `${steer.items.length} new items`}</span>
        <span className="shrink-0 text-accent">nubjs/nub#587</span>
        {one && <span className="shrink-0 tabular-nums text-[12px] text-muted/60">{AGE}</span>}
      </a>
      {!one && <BurstRows steer={steer} className="mt-1" />}
    </div>
  )
}

// 8 — keep the full card chrome, but EARN it: a real title and a real metadata line, so the p-4 inset
// wraps two lines of content instead of one and the corner glyph has a block to mark.
function V8({ steer }: { steer: GithubWakeSteer }) {
  const one = steer.items.length === 1
  return (
    <div className="min-w-0 max-w-[85%] rounded-xl border border-border-strong bg-panel-2 p-4">
      <div className="flex min-w-0 items-start gap-2">
        {/* The TITLE carries the permalink, so the metadata line below needs no third link — an
            "Open the comment" link there wrapped onto two lines at queue width and read as clutter. */}
        <a href={ITEM_URL} className="min-w-0 flex-1 text-[13px] font-medium leading-5 tracking-tight text-fg hover:underline hover:decoration-fg/40 hover:underline-offset-2">
          {one ? `New ${steer.items[0].label} from @pullfrog` : `${steer.items.length} new items on this PR`}
        </a>
        <Github aria-hidden size={14} className="card-icon-offset shrink-0 text-fg" />
      </div>
      {one ? (
        <div className="card-md mt-1 flex min-w-0 items-center gap-2 text-[13px] leading-5 text-fg/75">
          <Ref />
          <span className="text-muted/50">·</span>
          <span className="tabular-nums text-muted">{AGE}</span>
        </div>
      ) : (
        <div className="mt-1">
          <BurstRows steer={steer} />
        </div>
      )}
    </div>
  )
}

// 9 — a quiet BANNER: full width, no border, a wash one step off the page and an accent edge. Present
// without competing with a done/question card, and the full width means no dead middle to notice.
function V9({ steer }: { steer: GithubWakeSteer }) {
  const one = steer.items.length === 1
  return (
    <div className="overflow-hidden rounded-lg border-l-2 border-accent/50 bg-panel">
      <a href={one ? ITEM_URL : PR_URL} className={`flex items-center gap-2 px-3 py-1.5 text-[13px] leading-5 ${ROW_HOVER}`}>
        <MessageSquare size={13} className={`shrink-0 text-accent/80 ${ICON_LABEL_NUDGE}`} />
        {/* The band is full-width, but its CONTENT still packs left: pinning the age to the far edge
            is the one habit that reopens the dead middle this whole exercise is about. */}
        <span className="min-w-0 truncate">
          <span className="text-fg/90">{one ? `New ${steer.items[0].label} from @pullfrog` : `${steer.items.length} new items`}</span>
          <span className="text-muted"> · nubjs/nub#587</span>
        </span>
        {one && <span className="shrink-0 tabular-nums text-[12px] text-muted/60">· {AGE}</span>}
      </a>
      {!one && (
        <div className="px-3 pb-1.5">
          <BurstRows steer={steer} />
        </div>
      )}
    </div>
  )
}

// The item list a BURST needs, shared by every variant that doesn't define its own — so the comparison
// is between the SHAPES, not between ten different ways of listing three comments.
function BurstRows({ steer, className = "" }: { steer: GithubWakeSteer; className?: string }) {
  return (
    <div className={`flex w-fit max-w-full flex-col ${className}`}>
      {steer.items.map((i) => {
        const Icon = i.bot ? Bot : User
        return (
          <a key={i.url} href={i.url} className={`-mx-2 flex items-center gap-1.5 rounded px-2 py-0.5 text-[12px] leading-5 ${ROW_HOVER}`}>
            <Icon size={12} className={`shrink-0 text-muted/70 ${ICON_LABEL_NUDGE}`} />
            <span className="text-fg/90">@{i.actor}</span>
            <span className="text-muted">{i.label}</span>
            <span className="tabular-nums text-muted/60">{wakeItemAge(i.at)}</span>
          </a>
        )
      })}
    </div>
  )
}

const VARIANTS: { n: number; name: string; note: string; render: (steer: GithubWakeSteer, dense: boolean) => ReactNode }[] = [
  { n: 0, name: "Current", note: "what ships today — the real component", render: (s, d) => <V0 steer={s} dense={d} /> },
  { n: 1, name: "Wake divider", note: "the idiom every other child event already uses", render: (s) => <V1 steer={s} /> },
  { n: 2, name: "Left-anchored rule", note: "same hairline, nothing centred", render: (s) => <V2 steer={s} /> },
  { n: 3, name: "Chip", note: "shrinks to content — no dead middle possible", render: (s) => <V3 steer={s} /> },
  { n: 4, name: "Meta line", note: "no chrome; the `Ran 2 tool calls` row", render: (s) => <V4 steer={s} /> },
  { n: 5, name: "Avatar row", note: "GitHub's own way of saying who", render: (s) => <V5 steer={s} /> },
  { n: 6, name: "Timeline rail", note: "an accent edge instead of a box", render: (s) => <V6 steer={s} /> },
  { n: 7, name: "Dense card", note: "the card, sized for one line", render: (s) => <V7 steer={s} /> },
  { n: 8, name: "Two-line card", note: "keeps the chrome, gives it a body", render: (s) => <V8 steer={s} /> },
  { n: 9, name: "Quiet banner", note: "full-width wash, accent edge", render: (s) => <V9 steer={s} /> },
]

// ── the page ──────────────────────────────────────────────────────────────────────────────────────

// Real neighbours, because a notification is only ever judged against what sits above and below it.
function Context({ children, dense }: { children: ReactNode; dense: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[14px] leading-5 text-muted">Ran 2 tool calls</div>
      <div className="text-[14px] leading-6 text-fg/90">
        {dense ? "Pushed the branch; CI is green." : "Pushed the fix and the regression test. CI came back green on all three jobs, so the branch is ready for review."}
      </div>
      {/* `data-wake` is the handle the ink-measurement routine uses to find each variant's glyph
          cluster without every variant having to carry probe attributes of its own. */}
      <div data-wake>{children}</div>
      <div className="text-[14px] leading-6 text-fg/90">
        {dense ? "Reading the comment now." : "Reading that comment now — it's on the resolver change, so I'll fold the answer into the same commit."}
      </div>
    </div>
  )
}

function Panel({ label, width, children }: { label: string; width: number; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="petite-caps text-[11px] tracking-wide text-muted/50">{label}</div>
      <div className="rounded-lg border border-border/60 bg-bg p-4" style={{ width }}>
        {children}
      </div>
    </div>
  )
}

// The CONTACT SHEET: every variant stacked at one width with nothing between them, so the ten shapes
// can be compared in a single glance (and a single screenshot). The per-variant sections below are
// where each one gets judged IN CONTEXT; this is where the shortlist gets picked.
function Sheet({ steer, sans }: { steer: GithubWakeSteer; sans: boolean }) {
  return (
    <div className="flex flex-col gap-5" style={{ width: 720 }}>
      {VARIANTS.map((v) => (
        <div key={v.n} id={`s${v.n}`} className="flex items-start gap-3">
          <span className="w-4 shrink-0 pt-0.5 text-right tabular-nums text-[12px] font-medium text-accent">{v.n}</span>
          <div className="min-w-0 flex-1">{v.render(steer, false)}</div>
        </div>
      ))}
      <div className="text-[11px] text-muted/50">{sans ? "system-ui" : "mono"} · thread width 720px</div>
    </div>
  )
}

function App() {
  const [sans, setSans] = useState(!new URLSearchParams(location.search).has("mono"))
  const [burst, setBurst] = useState(new URLSearchParams(location.search).has("burst"))
  const sheet = new URLSearchParams(location.search).has("sheet")
  document.documentElement.dataset.font = sans ? "sans" : "mono"
  const steer = burst ? BURST : SINGLE
  if (sheet) {
    return (
      <div className="min-h-screen bg-bg px-8 py-6 text-fg">
        <Sheet steer={steer} sans={sans} />
      </div>
    )
  }
  return (
    <div className="min-h-screen bg-bg px-8 py-6 text-fg">
      <div className="mb-6 flex items-center gap-4">
        <h1 className="text-[15px] font-medium">GitHub wake card — alternatives</h1>
        {[
          { on: sans, set: setSans, a: "sans", b: "mono" },
          { on: burst, set: setBurst, a: "burst (3)", b: "single item" },
        ].map((t) => (
          <button
            key={t.a}
            data-toggle={t.a}
            onClick={() => t.set(!t.on)}
            className="rounded-md border border-border-strong px-2 py-1 text-[12px] text-muted hover:text-fg"
          >
            {t.on ? t.a : t.b}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-8">
        {VARIANTS.map((v) => (
          // `id`, not only a data attribute: `shot.mjs` splits its flags on `=`, so a
          // `--clip=[data-variant="3"]` selector is truncated to garbage and silently shoots the
          // whole viewport instead. `#v3` has no `=` in it.
          <div key={v.n} id={`v${v.n}`} data-variant={v.n} className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <span className="tabular-nums text-[13px] font-medium text-accent">{v.n}</span>
              <span className="text-[13px] font-medium text-fg">{v.name}</span>
              <span className="text-[12px] text-muted">— {v.note}</span>
            </div>
            <div className="flex items-start gap-6">
              <Panel label="thread" width={760}>
                <Context dense={false}>{v.render(steer, false)}</Context>
              </Panel>
              <Panel label="queue rail" width={360}>
                <Context dense>{v.render(steer, true)}</Context>
              </Panel>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
