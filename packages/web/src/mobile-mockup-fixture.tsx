// FRIZZ ON A PHONE — the whole product, mocked up as a native-feeling iOS app.
//
// Not a test and not shipped UI: a DESIGN SURFACE, in the shape `awaiting-mockups-fixture.tsx`
// established. Every screen renders in the app's REAL stylesheet on the app's REAL tokens, so a choice
// made here is a choice about the thing that would ship.
//
//   nubx vite --port 5477 --strictPort          (from packages/web)
//   http://localhost:5477/mobile-mockup-fixture.html                — the gallery, every screen
//                                              ?screen=board        — one screen, alone, at 1:1
//                                              ?font=mono           — the other font setting
//
// ── What is being designed ────────────────────────────────────────────────────────────────────────
// The desktop app is three standing surfaces at once: a project rail, a thread rail, and a workpane,
// with threads opening as right-hand drawers that stack. None of that survives a 390pt viewport. The
// phone gets the same INFORMATION MODEL — Rested / Active / Held / Done, the accent meaning "awaiting
// you", the checkbox status family — expressed as a two-level drill-down where every drawer becomes a
// sheet at a detent and every rail row becomes a card.
//
// Six rulings this mockup makes. All reversible, all worth arguing with:
//
//   1. NO TAB BAR. Frizz is projects → board → thread. A tab bar spends 49pt on navigation that the
//      hierarchy does not have, and the bottom edge is worth more as the prompt box.
//   2. THE PROMPT BOX DOCKS TO THE BOTTOM. It is the top of the sidebar on desktop; on a phone the
//      bottom edge is the only place a thumb reaches without a grip change.
//   3. A ROW BECOMES A CARD. The rail's job is scanning forty threads; a phone shows five. The density
//      buys detail instead: the gloss, the live tool line, the child ops, and — for the one state that
//      matters — the whole question, answerable without opening the thread.
//   4. EVERY DRAWER IS A SHEET AT A DETENT, with the parent scaled back behind it. The desktop's stack
//      of overlapping right-hand drawers becomes a stack of sheets, dismissed by flicking down.
//   5. THE ACCENT IS STILL THE ASK. iOS tints every nav action with the app colour; here that would put
//      four yellow controls on a screen whose yellow is supposed to mean "a worker is waiting for you".
//      So nav actions are neutral, and the accent is spent on exactly two things: the awaiting-you marks
//      and counts, and the ONE primary verb of a screen (Send answer, Dispatch).
//   6. THE TYPE SCALE IS iOS'S, NOT THE DESKTOP'S. 17/15/13/11.5 against 13px-everything. See the note
//      at the top of `mobile-mockup-kit.tsx`.
//
// Screens, in `?screen=` order: home · board · board-ask · thread · answer · actions · dispatch ·
// snooze · settings · subagent · switcher · search · empty · notification · plan · kit
import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"
import {
  Archive, ArrowUpRight, Bell, Check, ChevronDown, ChevronRight, Clock, Copy, Ellipsis, FileText,
  Github, Hourglass, Image as ImageIcon, Info, Paperclip, Pencil, Plus, RotateCcw, Search,
  Settings as SettingsIcon, Sparkles, SquareTerminal, Timer, Type as TypeIcon, Wrench, X, Zap,
} from "lucide-react"
import {
  AskBox, BoxSpinnerM, Button, Canvas, Chip, ComposerDock, DoneBox, Group, GroupHeader, Keyboard,
  LargeTitle, LiveDot, NavAction, NavBar, ON_CAP, Phone, Row, RowRule, Segmented, SheetHeader,
  SheetOver, StatusBox, Toggle, INK,
} from "./mobile-mockup-kit.tsx"
import "./styles.css"

const params = new URLSearchParams(location.search)
// THIS APP RENDERS IN TWO FONTS and a fixture that sets neither silently takes the MONO default —
// which is how a glyph measured at a 0.00px residual once rode visibly high in the maintainer's sans
// window. Sans is the shipped default, so it is this fixture's default too.
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
const only = params.get("screen")?.toLowerCase() ?? null
// `?still=1` freezes the box spinners at a legible phase. A screenshot of a live spinner is a coin flip
// between "obviously running" and "identical to the empty at-rest box", and the still IS the deliverable
// here — so the shot script asks for the frozen phase rather than hoping for it.
const still = params.has("still")

// ══ shared pieces ═══════════════════════════════════════════════════════════════════════════════

/** A project's square mark — the rail's own square, at the sizes a phone needs. */
function ProjectSquare({ label, tint, size = 44 }: { label: string; tint: string; size?: number }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center font-semibold ${tint}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), fontSize: Math.round(size * 0.42) }}
    >
      {label}
    </span>
  )
}

/**
 * The provider mark that trails a thread title on every surface in the app.
 *
 * The left margin is not decoration: the mark carries no whitespace of its own, so without one it reads
 * as a colour bleeding out of the title's last letter. See TitleWithMark for the other half of the
 * problem — where the line is allowed to break.
 */
function ProviderMark({ kind }: { kind: "claude" | "codex" }) {
  return (
    <span
      aria-hidden
      className={`${ON_CAP} ml-1.5 inline-block size-[8px] rounded-[2px] ${kind === "claude" ? "bg-[#d97757]" : "bg-muted/60"}`}
    />
  )
}

/**
 * A title with its provider mark glued to the last word.
 *
 * The mark is an ATOMIC inline box and the line breaker is free to break right before it even though no
 * whitespace separates the two — which strands the mark alone on a second line under a wrapping title.
 * The desktop rail solved this exact bug the same way (Sidebar's TitleWithTrailers); a phone's 250pt
 * title column hits it far more often.
 */
function TitleWithMark({ title, provider }: { title: string; provider?: "claude" | "codex" }) {
  if (!provider) return <>{title}</>
  const cut = title.lastIndexOf(" ")
  const head = cut === -1 ? "" : title.slice(0, cut + 1)
  const tail = cut === -1 ? title : title.slice(cut + 1)
  return (
    <>
      {head}
      <span className="whitespace-nowrap">
        {tail}
        <ProviderMark kind={provider} />
      </span>
    </>
  )
}

/** The band header on the board: the app's own nomenclature, plus its count. */
function Band({ label, count, collapsed }: { label: string; count: number; collapsed?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 px-5 pb-2 pt-3.5">
      {collapsed !== undefined ? (
        <ChevronRight data-ink="band-chevron" size={12} className={`shrink-0 ${INK.chevron12} text-muted/60 transition-transform ${collapsed ? "" : "rotate-90"}`} />
      ) : null}
      <span data-ink="band-label" className="text-[12px] font-semibold uppercase tracking-[0.07em] text-muted/80">{label}</span>
      {/* -1.5px: two TEXT runs on one gap read looser than a glyph and a label, because each carries its
          own side bearing (measured: chevron→label 7.00px of ink, label→count 8.38px, both on gap-1.5).
          The count is a mark here rather than prose, so it takes the trim and the row reads as one gap. */}
      <span data-ink="band-count" className="-ml-[1.5px] text-[12px] tabular-nums text-muted/50">{count}</span>
    </div>
  )
}

/**
 * A thread card — the phone's unit of board information, and the thing "a rail row" becomes.
 *
 * The anatomy is the rail's, re-laid for a 358pt measure: the status glyph keeps its own column so the
 * marks form a readable stripe down the board, the title wraps rather than truncating (the rail's own
 * rule), the rest time is a right-justified column because a title's length must not decide where its
 * timestamp sits, and everything under the title is the row's subtitle stack.
 */
function ThreadCard({
  glyph,
  title,
  provider,
  age,
  gloss,
  activity,
  meta,
  children,
  dim,
  ask,
}: {
  glyph: ReactNode
  title: string
  provider?: "claude" | "codex"
  age?: string
  gloss?: ReactNode
  activity?: ReactNode
  meta?: ReactNode
  children?: ReactNode
  dim?: boolean
  /** Awaiting-you: the accent rail down the leading edge. The one card on the board that shouts. */
  ask?: boolean
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-[14px] border bg-panel ${
        ask ? "border-accent/35" : "border-border/70"
      } ${dim ? "opacity-60" : ""}`}
    >
      {ask ? <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent" /> : null}
      <div className="flex items-start gap-3 px-4 pb-2.5 pt-2.5">
        <span data-ink="card-glyph" className="flex h-[21px] shrink-0 items-center justify-center">{glyph}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <div className="flex min-w-0 items-baseline gap-3">
            <span data-ink="card-title" className="min-w-0 flex-1 text-[15px] font-medium leading-[21px] tracking-[-0.01em] text-fg">
              <TitleWithMark title={title} provider={provider} />
            </span>
            {age ? <span className="shrink-0 text-[11.5px] leading-[21px] tabular-nums text-muted/60">{age}</span> : null}
          </div>
          {gloss ? (
            <span className={`min-w-0 text-[13px] leading-[18px] text-muted ${ask ? "line-clamp-2" : "truncate"}`}>{gloss}</span>
          ) : null}
          {activity ? <span className="min-w-0 truncate text-[13px] leading-[18px] text-muted/85">{activity}</span> : null}
          {meta ? <div className="mt-1 flex flex-wrap items-center gap-1.5">{meta}</div> : null}
        </div>
      </div>
      {children}
    </div>
  )
}

/** An indented child-op row — the rail's ⤷ line, at card density. */
function ChildOp({ kind, label, elapsed }: { kind: "agent" | "shell"; label: string; elapsed: string }) {
  return (
    <div className="flex items-baseline gap-2 pl-[49px] pr-4">
      <span data-ink="op-dot" className="flex shrink-0"><LiveDot kind={kind} /></span>
      <span data-ink="op-label" className="min-w-0 flex-1 truncate text-[12.5px] leading-[19px] text-muted">{label}</span>
      <span className="shrink-0 text-[11.5px] leading-[19px] tabular-nums text-muted/55">{elapsed}</span>
    </div>
  )
}

// ══ 1 · home ════════════════════════════════════════════════════════════════════════════════════
// EVERY PROJECT ON THE MACHINE, and what each of them wants from you. The desktop grid shows a name, a
// path and a last-opened date, because opening forty databases to draw forty cards is exactly what lazy
// activation exists to avoid. A phone is the surface you check from a sofa, so the one thing worth
// paying for is the answer to "does anything need me": a per-board state summary, and the accent count
// that says how many asks are waiting. Sorted by that count, so the answer is the top of the screen.
const PROJECTS = [
  { slug: "nub", label: "nubjs/nub", tint: "bg-[#e8b923] text-bg", initial: "N", path: "~/code/nub", asks: 2, active: 2, held: 1, when: "now" },
  { slug: "zod", label: "colinhacks/zod", tint: "bg-[#4a9eff] text-bg", initial: "Z", path: "~/code/zod", asks: 1, active: 0, held: 2, when: "2h" },
  { slug: "frizz", label: "colinhacks/frizz", tint: "bg-[#b47feb] text-bg", initial: "F", path: "~/Documents/projects/frizz", asks: 0, active: 3, held: 0, when: "12m" },
  { slug: "acme-app", label: "acme/app", tint: "bg-[#4ac97e] text-bg", initial: "A", path: "~/work/acme/app", asks: 0, active: 0, held: 1, when: "yesterday" },
  { slug: "pullfrog", label: "pullfrog/web", tint: "bg-[#6b7280] text-bg", initial: "P", path: "~/code/pullfrog", asks: 0, active: 0, held: 0, when: "3d" },
  { slug: "sonner", label: "emilkowal/sonner", tint: "bg-[#33363c] text-fg", initial: "S", path: "~/code/sonner", asks: 0, active: 0, held: 0, when: "1w" },
]

function ProjectRowCard({ p }: { p: (typeof PROJECTS)[number] }) {
  const quiet = p.asks === 0 && p.active === 0 && p.held === 0
  return (
    <div className="flex items-center gap-3 py-2.5 pl-4 pr-3">
      <ProjectSquare label={p.initial} tint={p.tint} />
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="truncate text-[16px] font-medium leading-[21px] tracking-[-0.01em] text-fg">{p.label}</span>
        {quiet ? (
          <span className="truncate font-mono-keep text-[12.5px] leading-[16px] text-muted/70">{p.path}</span>
        ) : (
          <span className="flex min-w-0 items-baseline gap-2.5 text-[12.5px] leading-[16px] text-muted">
            {p.active > 0 && (
              <span className="flex shrink-0 items-baseline gap-1.5">
                <span data-ink="meta-dot" className="flex shrink-0"><LiveDot kind="agent" /></span>
                <span data-ink="meta-active">{p.active} active</span>
              </span>
            )}
            {p.held > 0 && (
              <span className="flex shrink-0 items-baseline gap-1.5">
                <Hourglass data-ink="meta-glass" size={11} className={`${ON_CAP} ${INK.hourglass} text-muted/70`} />
                <span data-ink="meta-held">{p.held} held</span>
              </span>
            )}
            <span className="min-w-0 truncate text-muted/55">{p.when}</span>
          </span>
        )}
      </div>
      {p.asks > 0 ? (
        <span className="flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[12.5px] font-semibold text-bg">
          {p.asks}
        </span>
      ) : null}
      <ChevronRight size={17} className="shrink-0 text-muted/45" />
    </div>
  )
}

function HomeScreen() {
  return (
    <Canvas>
      {/* At the top of the scroll the nav bar carries no inline title — the large title below IS the
          title. Scrolled, the two swap. */}
      <NavBar
        border={false}
        trailing={
          <>
            <NavAction label="Search"><Search size={20} /></NavAction>
            <NavAction label="Settings"><SettingsIcon size={20} /></NavAction>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden pb-[34px]">
        <LargeTitle>Projects</LargeTitle>
        <div className="px-4 pb-1 pt-1.5">
          <div className="flex h-[36px] items-center gap-2 rounded-[10px] bg-panel-2 px-2.5">
            <Search size={15} className="shrink-0 text-muted/70" />
            <span className="text-[16px] text-muted/60">Search projects and threads</span>
          </div>
        </div>

        <GroupHeader trailing="3 asks">Needs you</GroupHeader>
        <Group>
          <ProjectRowCard p={PROJECTS[0]} />
          <RowRule inset={72} />
          <ProjectRowCard p={PROJECTS[1]} />
        </Group>

        <GroupHeader>All projects</GroupHeader>
        <Group>
          {PROJECTS.slice(2).map((p, i) => (
            <div key={p.slug}>
              {i > 0 ? <RowRule inset={72} /> : null}
              <ProjectRowCard p={p} />
            </div>
          ))}
        </Group>

        <div className="px-4 pt-3">
          {/* Dashed and never filled: an affordance, not a project — the desktop grid's own ruling,
              which a phone has more reason to keep, since here it is the last thing in a scroll. */}
          <button className="flex h-[52px] w-full items-center justify-center gap-2 rounded-[14px] border border-dashed border-border-strong text-[15px] text-muted active:border-accent active:text-fg">
            <Plus size={17} className={ON_CAP} />
            Add a project
          </button>
        </div>
      </div>
    </Canvas>
  )
}

// ══ 2 · board ═══════════════════════════════════════════════════════════════════════════════════
// THE PROJECT PAGE. The bands are the app's own, in the app's own order and the app's own words —
// Rested (the cue) first, under the prompt box's reach; Active below it; Held dimmed and labelled; Done
// collapsed. "Active" means SPINNING and nothing else, so a rested row never lands in it and never
// carries a spinner. Only the cue's cards date their rest: a row that is still running has not made a
// handoff, so it has nothing to date.

function BoardTopBar() {
  return (
    <NavBar
      back="Projects"
      title={
        <span className="flex items-center gap-1.5">
          <ProjectSquare label="N" tint="bg-[#e8b923] text-bg" size={17} />
          <span className="font-mono-keep text-[15px]">nubjs/nub</span>
          <ChevronDown size={13} className="text-muted/70" />
        </span>
      }
      trailing={<NavAction label="Board actions"><Ellipsis size={20} /></NavAction>}
    />
  )
}

/** The board's asking card, collapsed: the question in one line and the verb that opens it. */
function AskCardCollapsed() {
  return (
    <ThreadCard
      ask
      glyph={<AskBox />}
      title="Fix the cache collision in the resolver"
      provider="claude"
      age="4m"
      gloss="Should the settings store use SQLite or a JSON file?"
    >
      <div className="flex items-center gap-2 px-4 pb-3 pl-[49px]">
        <Button kind="accent" size="sm">Answer</Button>
        <Button kind="tinted" size="sm">Open</Button>
      </div>
    </ThreadCard>
  )
}

/**
 * A card mid-swipe.
 *
 * The card slides and its LEADING content is clipped by the group's own rounded mask, which is exactly
 * what an inset-grouped row does in Mail. It is the one place a static mockup looks wrong while being
 * right — a swipe caught mid-gesture always cuts a word in half.
 */
function SwipedCard() {
  return (
    <div className="relative overflow-hidden rounded-[14px]">
      <div className="absolute inset-y-0 right-0 flex">
        <div className="flex w-[76px] flex-col items-center justify-center gap-1 bg-elevated text-muted">
          <Clock size={19} />
          <span className="text-[11.5px]">Snooze</span>
        </div>
        <div className="flex w-[76px] flex-col items-center justify-center gap-1 bg-live/85 text-bg">
          <Check size={19} strokeWidth={2.6} />
          <span className="text-[11.5px] font-medium">Done</span>
        </div>
      </div>
      <div className="relative -translate-x-[152px]">
        <ThreadCard
          glyph={<StatusBox />}
          title="Rewrite the release notes for 0.4"
          provider="codex"
          age="3d"
          gloss="Rested — nothing running"
        />
      </div>
    </div>
  )
}

function BoardBands({ ask }: { ask: ReactNode }) {
  return (
    <>
      <Band label="Rested" count={3} />
      <div className="flex flex-col gap-2 px-4">
        {ask}
        <ThreadCard
          glyph={<StatusBox />}
          title="Audit the parser for edge cases"
          provider="claude"
          age="1h"
          gloss="Waiting on your call about the tokenizer"
        />
        <SwipedCard />
      </div>

      <Band label="Active" count={2} />
      <div className="flex flex-col gap-2 px-4">
        <ThreadCard
          glyph={<BoxSpinnerM frozen={still} />}
          title="Migrate the board store to valtio 2"
          provider="claude"
          activity={<span className="shimmer-text">Running the focused tests</span>}
        >
          <div className="flex flex-col gap-0.5 pb-3">
            <ChildOp kind="agent" label="Audit the parser for edge cases" elapsed="2m" />
            <ChildOp kind="shell" label="gh run watch 1842" elapsed="4m" />
          </div>
        </ThreadCard>
        <ThreadCard
          glyph={<BoxSpinnerM frozen={still} />}
          title="Draft the changelog for 0.4"
          provider="codex"
          activity={<span className="shimmer-text">Reading packages/server/src/router.ts</span>}
        />
      </div>

      <Band label="Held" count={2} collapsed={false} />
      <div className="flex flex-col gap-2 px-4">
        <ThreadCard
          dim
          glyph={<StatusBox><Hourglass size={11} className="text-muted/75" /></StatusBox>}
          title="Land the tenant routing fix"
          provider="claude"
          age="2h"
          gloss={
            <span className="flex items-baseline gap-1.5">
              <LiveDot kind="github" quiet />
              Waiting on acme/app#391 — checks running
            </span>
          }
        />
        <ThreadCard
          dim
          glyph={<StatusBox><Timer size={11} className="text-muted/75" /></StatusBox>}
          title="Retry the flaky socket test"
          provider="claude"
          age="20m"
          gloss="Wakes at 5:00 PM"
        />
      </div>

      <Band label="Done" count={6} collapsed />
    </>
  )
}

function BoardScreen({ dockOps = true, ask }: { dockOps?: boolean; ask?: ReactNode }) {
  return (
    <Canvas>
      <BoardTopBar />
      <div className="min-h-0 flex-1 overflow-hidden pb-[110px]">
        <BoardBands ask={ask ?? <AskCardCollapsed />} />
      </div>
      <ComposerDock
        ops={
          dockOps ? (
            <div className="flex items-baseline gap-2 text-[12px] leading-[17px] text-muted">
              <LiveDot kind="shell" />
              <span className="min-w-0 flex-1 truncate">vite dev --host</span>
              <span className="shrink-0 tabular-nums text-muted/55">18m</span>
            </div>
          ) : null
        }
      />
    </Canvas>
  )
}

// ══ 3 · board-ask ═══════════════════════════════════════════════════════════════════════════════
// THE SAME BOARD, with the asking card expanded in place. This is the whole argument for cards over
// rows: the reason to pick the phone up is a worker that stopped, and answering it should not cost a
// navigation. Tapping "Answer" expands the question here; only a question too long to read in a card
// (or one of several) pushes the full-screen `answer` surface.

function AskCardExpanded() {
  return (
    <ThreadCard
      ask
      glyph={<AskBox />}
      title="Fix the cache collision in the resolver"
      provider="claude"
      age="4m"
      gloss="Awaiting your answer"
    >
      <div className="mx-4 mb-3.5 rounded-[10px] border border-border/70 bg-bg/60 p-3">
        <p className="m-0 text-[14px] leading-[19px] text-fg/90">
          Should the settings store use SQLite or a JSON file?
        </p>
        <div className="mt-2.5 flex flex-col gap-1.5">
          {[
            { key: "A", label: "SQLite", why: "Transactional, and it matches how sessions are already stored", rec: true },
            { key: "B", label: "JSON file", why: "Zero deps and human-editable, but racy under concurrent writes" },
          ].map((option) => (
            <button
              key={option.key}
              className={`flex min-h-[44px] items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-left ${
                option.rec ? "border-accent/45 bg-accent/[0.07]" : "border-border bg-panel-2"
              }`}
            >
              <span
                className={`mt-[1px] flex size-[18px] shrink-0 items-center justify-center rounded-full border text-[10.5px] font-semibold ${
                  option.rec ? "border-accent bg-accent text-bg" : "border-border-strong text-muted"
                }`}
              >
                {option.key}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[14px] font-medium leading-[18px] text-fg">
                  {option.label}
                  {option.rec ? <span className="ml-1.5 text-[11.5px] font-normal text-accent">recommended</span> : null}
                </span>
                <span className="text-[12.5px] leading-[16px] text-muted">{option.why}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <Button kind="accent" size="sm" className="flex-1">Send answer</Button>
          <Button kind="tinted" size="sm">Open thread</Button>
        </div>
      </div>
    </ThreadCard>
  )
}

// ══ 4 · thread ══════════════════════════════════════════════════════════════════════════════════
// THE TRANSCRIPT, full screen. Everything the desktop draws in a stacked right-hand drawer, in the one
// place a phone has, with the same composer docked under it.

/** A tool call, at reading density: the glyph, the target, the elapsed, and a chevron that expands it. */
function ToolCard({ icon, label, detail, elapsed }: { icon: ReactNode; label: string; detail?: string; elapsed?: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] border border-border/70 bg-panel px-3 py-2.5">
      <span className="shrink-0 text-muted/70">{icon}</span>
      <span className="min-w-0 flex-1 truncate font-mono-keep text-[12.5px] leading-[17px] text-fg/80">
        {label}
        {detail ? <span className="text-muted/70"> {detail}</span> : null}
      </span>
      {elapsed ? <span className="shrink-0 text-[11.5px] tabular-nums text-muted/55">{elapsed}</span> : null}
      <ChevronRight size={15} className="shrink-0 text-muted/45" />
    </div>
  )
}

function ThreadScreen() {
  return (
    <Canvas>
      <NavBar
        back="Board"
        title="Fix the cache collision"
        subtitle="rested 4m · opus · high"
        trailing={<NavAction label="Thread actions"><Ellipsis size={20} /></NavAction>}
      />
      <div className="min-h-0 flex-1 overflow-hidden px-4 pb-[104px] pt-4">
        <div className="flex flex-col gap-3.5">
          {/* The human's own words, in the app's user-bubble fill. Right-INSET rather than
              right-aligned: a full-width bubble would read as a system banner. */}
          <div className="self-end rounded-[16px] rounded-br-[6px] bg-user-bubble px-3.5 py-2.5 text-[15px] leading-[21px] text-bg" style={{ maxWidth: "78%" }}>
            the resolver keys on the raw id — fix it and pin it with a test
          </div>

          <p className="m-0 text-[15px] leading-[22px] text-fg/90">
            The lookup builds its key from the raw id, so two ids that normalize to the same value share
            a cache entry. I will key on the normalized id and pin it with a test at the resolver level.
          </p>

          <div className="flex flex-col gap-1.5">
            <ToolCard icon={<FileText size={14} />} label="src/resolver.ts" detail="· 214 lines" elapsed="0.2s" />
            <ToolCard icon={<Pencil size={14} />} label="src/resolver.ts" detail="+7 −3" elapsed="0.4s" />
            <ToolCard icon={<SquareTerminal size={14} />} label="nub --test packages/server" elapsed="8.1s" />
          </div>

          {/* A ```done fence, as the app's own signal card: the gutter glyph, the eyebrow, the ledger. */}
          <div className="rounded-[12px] border border-live/25 bg-live/[0.06] p-3.5">
            <div className="flex items-baseline gap-2">
              <Check size={13} strokeWidth={2.8} className={`${ON_CAP} text-live`} />
              <span className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-live/90">Done</span>
            </div>
            <ul className="m-0 mt-2 flex list-disc flex-col gap-1.5 pl-4 text-[14px] leading-[20px] text-fg/85 marker:text-muted/60">
              <li>
                <span className="font-semibold">Fixed the cache collision</span> in{" "}
                <code className="rounded bg-panel-2 px-1 py-[1px] font-mono-keep text-[12.5px]">src/resolver.ts</code> — the
                lookup now keys on the normalized id.
              </li>
              <li>
                <span className="font-semibold">Added a regression test</span>; the focused suite is green.
              </li>
            </ul>
            <div className="mt-3 flex items-center gap-2">
              <Button kind="filled" size="sm">Mark as done</Button>
              <Button kind="tinted" size="sm">Reopen</Button>
            </div>
          </div>

          {/* The rest divider — the app's own "this is where the worker stopped" rule, which is also
              what keeps the tail of a finished transcript from reading as an unfinished one. */}
          <div className="flex items-center gap-3 py-1">
            <span className="h-px flex-1 bg-border/60" />
            <span className="shrink-0 text-[11.5px] text-muted/60">rested 4m</span>
            <span className="h-px flex-1 bg-border/60" />
          </div>
        </div>
      </div>
      <ComposerDock placeholder="Reply or steer…" />
    </Canvas>
  )
}

// ══ 5 · answer ══════════════════════════════════════════════════════════════════════════════════
// THE ASK, given the whole screen — the surface a card cannot hold: several questions at once. Each
// option is a 56pt row, and the send action is docked rather than appended to the last card, because it
// answers BOTH questions and must be reachable without scrolling to the bottom of the ask.

function OptionRow({
  letter,
  label,
  why,
  chosen,
  rec,
}: {
  letter: string
  label: string
  why: string
  chosen?: boolean
  rec?: boolean
}) {
  return (
    <button
      className={`flex min-h-[56px] w-full items-start gap-3 border-b border-border/60 px-3.5 py-3 text-left last:border-b-0 ${
        chosen ? "bg-accent/[0.09]" : ""
      }`}
    >
      <span
        className={`mt-[1px] flex size-[20px] shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
          chosen ? "border-accent bg-accent text-bg" : "border-border-strong text-muted"
        }`}
      >
        {chosen ? <Check size={13} strokeWidth={3} /> : letter}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-medium leading-[20px] text-fg">
          {label}
          {rec ? <span className="ml-1.5 text-[12px] font-normal text-accent">recommended</span> : null}
        </span>
        <span className="text-[13px] leading-[17px] text-muted">{why}</span>
      </span>
    </button>
  )
}

function AnswerScreen() {
  return (
    <Canvas>
      <NavBar back="Thread" title="2 questions" subtitle="Fix the cache collision" />
      <div className="min-h-0 flex-1 overflow-hidden pb-[100px]">
        <div className="px-5 pt-4">
          <p className="m-0 text-[13.5px] leading-[19px] text-muted">
            The resolver fix is written and its test is green. Both of these change what ships, so they
            are yours to call.
          </p>
        </div>

        <GroupHeader>Question 1 of 2</GroupHeader>
        <Group>
          <div className="px-3.5 pb-2.5 pt-3">
            <p className="m-0 text-[15px] font-medium leading-[21px] text-fg">
              Should the settings store use SQLite or a JSON file?
            </p>
          </div>
          <div className="h-px bg-border/70" />
          <OptionRow letter="A" label="SQLite" why="Transactional, and it matches how sessions are already stored" chosen rec />
          <OptionRow letter="B" label="JSON file" why="Zero deps and human-editable, but racy under concurrent writes" />
          <OptionRow letter="C" label="Something else" why="Type your own answer" />
        </Group>

        <GroupHeader>Question 2 of 2</GroupHeader>
        <Group>
          <div className="px-3.5 pb-2.5 pt-3">
            <p className="m-0 text-[15px] font-medium leading-[21px] text-fg">
              Should the normalized key be written into the on-disk cache too?
            </p>
          </div>
          <div className="h-px bg-border/70" />
          <OptionRow letter="A" label="Migrate on next read" why="No downtime; a stale entry is corrected the first time it is hit" rec />
          <OptionRow letter="B" label="Rebuild the cache once" why="Clean, but the first boot after the update is slow" />
        </Group>
      </div>
      <div className="absolute inset-x-0 bottom-0 z-30 border-t border-border/70 bg-bg/85 px-4 pb-[30px] pt-2.5 backdrop-blur-xl">
        <Button kind="accent" size="lg" full>Send 1 of 2 answers</Button>
      </div>
    </Canvas>
  )
}

// ══ 6 · actions ═════════════════════════════════════════════════════════════════════════════════
// THE THREAD-ACTIONS SHEET, over a receded board. Everything the desktop scatters across a row hover, a
// header cluster and a footer, in one grouped list at the bottom of the screen where the thumb is.

function ActionsScreen() {
  return (
    <Canvas>
      <SheetOver detent={0.68} behind={<BoardScreen dockOps={false} />}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-2">
          <div className="flex items-start gap-3 px-4 pb-3 pt-1">
            <span className="pt-[2px]"><AskBox /></span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[16px] font-semibold tracking-[-0.01em] text-fg">
                Fix the cache collision in the resolver
              </span>
              <span className="truncate text-[12.5px] text-muted">Rested 4m · claude · opus · high</span>
            </div>
          </div>

          <div className="flex flex-col gap-3 overflow-hidden pb-[34px]">
            <Group>
              <Row icon={<Check size={16} className="text-live" />} label="Mark as done" />
              <RowRule inset={53} />
              <Row icon={<Clock size={16} className="text-muted" />} label="Snooze…" value="until 5:00 PM" chevron />
              <RowRule inset={53} />
              <Row icon={<RotateCcw size={16} className="text-muted" />} label="Retry this session" detail="Resume where it left off" />
            </Group>

            <Group>
              <Row icon={<Pencil size={16} className="text-muted" />} label="Rename thread" />
              <RowRule inset={53} />
              <Row icon={<Copy size={16} className="text-muted" />} label="Copy resume command" detail="Open this session in your own terminal" />
              <RowRule inset={53} />
              <Row icon={<FileText size={16} className="text-muted" />} label="Frizz document" chevron />
              <RowRule inset={53} />
              <Row icon={<ArrowUpRight size={16} className="text-muted" />} label="Open full page" chevron />
            </Group>

            <Group>
              <Row icon={<Archive size={16} className="text-red-400" />} label="Archive thread" tone="text-red-300" />
            </Group>
          </div>
        </div>
      </SheetOver>
    </Canvas>
  )
}

// ══ 7 · dispatch ════════════════════════════════════════════════════════════════════════════════
// THE FULL-SCREEN COMPOSER, WITH THE KEYBOARD UP — which is the only honest way to draw it. Tapping the
// dock's prompt box promotes it to this: a real writing surface with the dispatch controls under it, in
// the 553 points that survive once the keyboard is showing. Everything below that line has to be
// reachable by scrolling the form, so nothing lives there that you need WHILE typing; what you do need
// mid-sentence (an attachment, the profile you are dispatching under) rides the accessory bar.

function DispatchScreen() {
  return (
    <Canvas>
      <NavBar
        title="New thread"
        subtitle="nubjs/nub"
        leading={<button className="px-2 text-[17px] text-fg/85">Cancel</button>}
        trailing={<button className="px-2 text-[17px] font-semibold text-accent">Dispatch</button>}
      />
      <div className="min-h-0 flex-1 overflow-hidden pb-[347px]">
        <div className="px-5 pb-1 pt-4">
          <p className="m-0 text-[17px] leading-[23px] text-fg">
            Port the v2 drivers to the new host API, then land it on main.
            <span className="ml-[1px] inline-block h-[19px] w-[2px] translate-y-[3px] bg-accent" />
          </p>
        </div>

        <GroupHeader>Worker</GroupHeader>
        <Group>
          <Row
            icon={<span className="size-[13px] rounded-[3px] bg-[#d97757]" />}
            iconTint="bg-[#d97757]/15"
            label="Agent"
            value="Claude"
            chevron
          />
          <RowRule inset={57} />
          <Row icon={<Sparkles size={15} className="text-fg" />} iconTint="bg-[#b47feb]/20" label="Model" value="Opus 5" chevron />
          <RowRule inset={57} />
          {/* EFFORT IS FIVE CELLS, so it takes its own full-width row rather than sharing one with its
              label — squeezed beside "Effort" the segmented control had 37pt per cell and "xhigh" had
              to be dropped, which quietly misrepresents what the product offers. */}
          <div className="flex flex-col gap-2 px-4 py-2.5">
            <div className="flex items-center gap-3">
              <span className="flex size-[29px] shrink-0 items-center justify-center rounded-[7px] bg-[#e8b923]/18">
                <Zap size={15} className="text-accent" />
              </span>
              <span className="text-[16px] tracking-[-0.01em] text-fg">Effort</span>
            </div>
            <Segmented options={["low", "med", "high", "xhigh", "max"]} value="high" />
          </div>
          <RowRule inset={57} />
          <Row icon={<Wrench size={15} className="text-fg" />} iconTint="bg-[#4a9eff]/18" label="Permissions" value="Ask" chevron />
        </Group>

        <GroupHeader>Context</GroupHeader>
        <Group>
          <Row icon={<Github size={15} className="text-fg" />} iconTint="bg-elevated" label="From a GitHub issue or PR" chevron />
          <RowRule inset={57} />
          <Row icon={<FileText size={15} className="text-fg" />} iconTint="bg-elevated" label="From a plan" value="none" chevron />
          <RowRule inset={57} />
          <Row
            icon={<SquareTerminal size={15} className="text-fg" />}
            iconTint="bg-elevated"
            label="Run in a worktree"
            detail="An isolated branch, merged when it lands"
            trailing={<Toggle on />}
          />
        </Group>
      </div>

      <Keyboard
        accessory={
          <div className="flex h-[48px] items-center gap-1 border-t border-border/70 bg-panel-2/95 px-2 backdrop-blur-xl">
            <NavAction label="Attach a file" tone="text-muted"><Paperclip size={19} /></NavAction>
            <NavAction label="Attach an image" tone="text-muted"><ImageIcon size={19} /></NavAction>
            <div className="ml-auto flex items-center gap-1.5 pr-1">
              <Chip tone="text-fg/80">opus · high</Chip>
              <Chip>ask</Chip>
            </div>
          </div>
        }
      />
    </Canvas>
  )
}

// ══ 8 · snooze ══════════════════════════════════════════════════════════════════════════════════
// A SMALL-DETENT SHEET, and the argument for detents at all: this is a five-second decision, so it
// takes half the screen and leaves the board visible behind it. Every option resolves its own wall
// clock on the right — "this evening" is not an instruction the reader should have to convert.

function SnoozeScreen() {
  return (
    <Canvas>
      <SheetOver detent={0.5} behind={<BoardScreen dockOps={false} />}>
        {/* NO confirm button. Every row here IS the choice, so a Done would be a second tap that can
            only ever mean "yes, the thing I just tapped" — and a permanently-dim one, until then. */}
        <SheetHeader title="Snooze" leading={<button className="px-2 text-[16px] text-fg/85">Cancel</button>} />
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-3">
          <Group>
            <Row icon={<Clock size={16} className="text-muted" />} label="In 30 minutes" value="10:11 AM" />
            <RowRule inset={53} />
            <Row icon={<Clock size={16} className="text-muted" />} label="In 2 hours" value="11:41 AM" />
            <RowRule inset={53} />
            <Row icon={<Clock size={16} className="text-muted" />} label="This evening" value="6:00 PM" />
            <RowRule inset={53} />
            <Row icon={<Clock size={16} className="text-muted" />} label="Tomorrow morning" value="9:00 AM" />
          </Group>
          <Group>
            <Row icon={<Timer size={16} className="text-muted" />} label="Pick a date and time…" chevron />
          </Group>
          <p className="m-0 px-6 text-[12.5px] leading-[17px] text-muted/70">
            A snoozed thread moves to Held and wakes itself at the time you pick. Nothing stops running.
          </p>
        </div>
      </SheetOver>
    </Canvas>
  )
}

// ══ 9 · settings ════════════════════════════════════════════════════════════════════════════════
// THE SETTINGS DRAWER, as grouped rows. The desktop drawer is a scrolling form; the phone version is the
// same content in the shape an iOS reader already knows how to skim.

function SettingsScreen() {
  return (
    <Canvas>
      <NavBar
        title="Settings"
        leading={<span className="w-[44px]" />}
        trailing={<button className="px-2 text-[17px] font-semibold text-accent">Done</button>}
      />
      <div className="min-h-0 flex-1 overflow-hidden pb-[34px]">
        <GroupHeader>Appearance</GroupHeader>
        <Group>
          <div className="flex min-h-[48px] items-center gap-3 pl-4 pr-3.5">
            <span className="flex size-[29px] shrink-0 items-center justify-center rounded-[7px] bg-elevated">
              <TypeIcon size={15} className="text-fg" />
            </span>
            <span className="shrink-0 text-[16px] tracking-[-0.01em] text-fg">Font</span>
            <Segmented className="ml-auto w-[150px]" options={["Sans", "Mono"]} value="Sans" />
          </div>
          <RowRule inset={57} />
          <Row icon={<Sparkles size={15} className="text-fg" />} iconTint="bg-elevated" label="Compact cards" detail="One line per thread on the board" trailing={<Toggle />} />
        </Group>

        <GroupHeader>Notifications</GroupHeader>
        <Group>
          <Row icon={<Bell size={15} className="text-fg" />} iconTint="bg-[#e8b923]/18" label="When a thread needs you" trailing={<Toggle on />} />
          <RowRule inset={57} />
          <Row icon={<Check size={15} className="text-fg" />} iconTint="bg-[#4ac97e]/18" label="When a thread finishes" trailing={<Toggle on />} />
          <RowRule inset={57} />
          <Row icon={<Github size={15} className="text-fg" />} iconTint="bg-[#b47feb]/18" label="When a watched PR settles" trailing={<Toggle />} />
        </Group>

        <GroupHeader>Dispatch defaults</GroupHeader>
        <Group>
          <Row icon={<Sparkles size={15} className="text-fg" />} iconTint="bg-elevated" label="Model" value="Opus 5" chevron />
          <RowRule inset={57} />
          <Row icon={<Zap size={15} className="text-fg" />} iconTint="bg-elevated" label="Effort" value="High" chevron />
          <RowRule inset={57} />
          <Row icon={<Wrench size={15} className="text-fg" />} iconTint="bg-elevated" label="Permissions" value="Ask" chevron />
        </Group>

        <GroupHeader>Frizz</GroupHeader>
        <Group>
          <Row icon={<Info size={15} className="text-fg" />} iconTint="bg-elevated" label="Version" value="0.4.2" />
          <RowRule inset={57} />
          <Row icon={<RotateCcw size={15} className="text-fg" />} iconTint="bg-elevated" label="Update and restart" detail="Frizz keeps the previous version if the build fails" />
        </Group>
      </div>
    </Canvas>
  )
}

// ══ 10 · subagent ═══════════════════════════════════════════════════════════════════════════════
// THE DRILL-IN SHEET, at the large detent, over its parent thread. This is the phone's answer to the
// desktop's STACKED drawers: a sub-agent opened from a thread opens over it, at 93%, so the parent stays
// visible above it and a flick down returns to exactly where you were.

function SubAgentScreen() {
  return (
    <Canvas>
      <SheetOver detent={0.9} scrim="bg-black/30" behind={<ThreadScreen />}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-start gap-2.5 px-4 pb-3 pt-3">
            <span className="pt-[7px]"><LiveDot kind="agent" /></span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[16px] font-semibold leading-[21px] tracking-[-0.01em] text-fg">
                Audit the parser for edge cases
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone="text-fg/80">frizz:opus-high</Chip>
                <Chip>running 2m 14s</Chip>
              </div>
            </div>
            <NavAction label="Close" tone="text-muted"><X size={19} /></NavAction>
          </div>
          <div className="h-px bg-border/70" />

          <div className="min-h-0 flex-1 overflow-hidden px-4 pb-[84px] pt-3.5">
            <div className="flex flex-col gap-3">
              <p className="m-0 text-[14.5px] leading-[21px] text-fg/85">
                Walking the fixture corpus first, then the fuzz seeds. Two candidates so far, both in the
                escape handling.
              </p>
              <div className="flex flex-col gap-1.5">
                <ToolCard icon={<FileText size={14} />} label="src/parse/escape.ts" elapsed="0.3s" />
                <ToolCard icon={<SquareTerminal size={14} />} label="nub --test parser --fuzz" elapsed="41s" />
              </div>
              <div className="rounded-[10px] border border-border/70 bg-bg px-3 py-2.5">
                <pre className="m-0 overflow-hidden font-mono-keep text-[11.5px] leading-[17px] text-muted">{`✓ 214 passing
✗ escape/trailing-backslash
  expected "a\\\\" · got "a\\"`}</pre>
              </div>
              <p className="m-0 text-[14.5px] leading-[21px] text-fg/85">
                The first one is real: a trailing backslash at the end of a quoted run is consumed as an
                escape and the closing quote is swallowed. The second is the fuzzer feeding an unpaired
                surrogate, which the parser is entitled to reject.
              </p>
              <div className="flex flex-col gap-1.5">
                <ToolCard icon={<FileText size={14} />} label="src/parse/lexer.ts" detail="· 88 lines" elapsed="0.2s" />
                <ToolCard icon={<Pencil size={14} />} label="test/escape.spec.ts" detail="+18 −0" elapsed="0.6s" />
              </div>
            </div>
          </div>

          <div className="absolute inset-x-0 bottom-0 border-t border-border/70 bg-panel/90 px-3 pb-[26px] pt-2.5 backdrop-blur-xl">
            <div className="flex items-center gap-2">
              <div className="flex h-[42px] min-w-0 flex-1 items-center rounded-[21px] border border-border-strong bg-bg px-3.5 text-[15px] text-muted/70">
                Steer this sub-agent…
              </div>
              <button aria-label="Stop" className="flex size-[42px] shrink-0 items-center justify-center rounded-full bg-elevated text-muted">
                <X size={18} />
              </button>
            </div>
          </div>
        </div>
      </SheetOver>
    </Canvas>
  )
}

// ══ 11 · switcher ═══════════════════════════════════════════════════════════════════════════════
// THE PROJECT RAIL, as a sheet. The desktop keeps an optional permanent 57px column of every project; a
// phone cannot spend that, and should not — a standing invitation to leave the thread you are in is
// worse on the surface where you can only see one thing at a time. So it lives behind the board title,
// which carries a chevron saying so.

function SwitcherScreen() {
  return (
    <Canvas>
      <SheetOver detent={0.66} behind={<BoardScreen dockOps={false} />}>
        <SheetHeader title="Switch project" trailing={<button className="px-2 text-[16px] text-fg/85">Done</button>} />
        <div className="min-h-0 flex-1 overflow-hidden pt-3">
          <div className="px-4 pb-3">
            <div className="flex h-[36px] items-center gap-2 rounded-[10px] bg-panel-2 px-2.5">
              <Search size={15} className="shrink-0 text-muted/70" />
              <span className="text-[16px] text-muted/60">Filter</span>
            </div>
          </div>
          <Group>
            {PROJECTS.slice(0, 5).map((p, i) => (
              <div key={p.slug}>
                {i > 0 ? <RowRule inset={65} /> : null}
                <div className={`flex min-h-[52px] items-center gap-3 pl-4 pr-3.5 ${i === 0 ? "bg-white/[0.04]" : ""}`}>
                  <ProjectSquare label={p.initial} tint={p.tint} size={34} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[16px] leading-[21px] tracking-[-0.01em] text-fg">{p.label}</span>
                    <span className="truncate font-mono-keep text-[12px] leading-[16px] text-muted/70">{p.path}</span>
                  </div>
                  {p.asks > 0 ? (
                    <span className="flex size-[20px] shrink-0 items-center justify-center rounded-full bg-accent text-[11.5px] font-semibold text-bg">
                      {p.asks}
                    </span>
                  ) : null}
                  {i === 0 ? <Check size={17} className="shrink-0 text-fg" strokeWidth={2.6} /> : null}
                </div>
              </div>
            ))}
          </Group>
          {/* `pt-3` only — a `px-4` wrapper around a Group would inset it TWICE, and the second inset
              is visible the moment it sits under a full-width list. */}
          <div className="pt-3">
            <Group>
              <Row icon={<Plus size={16} className="text-muted" />} label="Add a project" />
            </Group>
          </div>
        </div>
      </SheetOver>
    </Canvas>
  )
}

// ══ 12 · search ═════════════════════════════════════════════════════════════════════════════════
// THE COMMAND PALETTE, which on a phone is simply SEARCH. ⌘K has no thumb, so the palette stops being a
// chord and becomes the magnifier in the nav bar — and its verbs stay in the results, under their own
// heading, exactly where a palette user expects to find them.

function SearchScreen() {
  return (
    <Canvas>
      <div className="shrink-0 bg-bg pt-[59px]">
        <div className="flex h-[52px] items-center gap-2 px-4">
          <div className="flex h-[36px] min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-panel-2 px-2.5">
            <Search size={15} className="shrink-0 text-muted/70" />
            <span className="min-w-0 flex-1 truncate text-[16px] text-fg">resolver</span>
            <span className="flex size-[17px] shrink-0 items-center justify-center rounded-full bg-muted/25 text-bg">
              <X size={11} strokeWidth={3} />
            </span>
          </div>
          <button className="shrink-0 text-[17px] text-fg/85">Cancel</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <GroupHeader>Threads</GroupHeader>
        <Group>
          <Row icon={<AskBox />} label="Fix the cache collision in the resolver" detail="nubjs/nub · rested 4m" />
          <RowRule inset={53} />
          <RowRule inset={53} />
          <Row icon={<DoneBox />} label="Make the resolver cache keys stable" detail="nubjs/nub · done yesterday" />
          <RowRule inset={53} />
          <Row icon={<StatusBox><Hourglass size={11} className="text-muted/75" /></StatusBox>} label="Resolver cache: migrate on read" detail="colinhacks/zod · held, wakes 5:00 PM" />
        </Group>
        <GroupHeader>Plans</GroupHeader>
        <Group>
          <Row icon={<FileText size={16} className="text-muted" />} label="Resolver rewrite, stage 2" detail="3 threads from this plan" chevron />
        </Group>
        <GroupHeader>Actions</GroupHeader>
        <Group>
          <Row icon={<Plus size={16} className="text-muted" />} label="New thread" />
          <RowRule inset={53} />
          <Row icon={<Github size={16} className="text-muted" />} label="Dispatch from an issue or PR" />
          <RowRule inset={53} />
          <Row icon={<SettingsIcon size={16} className="text-muted" />} label="Open settings" />
        </Group>
        <p className="m-0 px-6 pt-4 text-[12.5px] leading-[17px] text-muted/70">
          Search covers every project on this machine, not just the one you are in.
        </p>
      </div>
    </Canvas>
  )
}

// ══ 13 · empty ══════════════════════════════════════════════════════════════════════════════════
// A PROJECT WITH NOTHING IN IT. The desktop's first-run state centres the prompt box as the whole
// screen; the phone cannot centre a control it also needs docked, so the prompt box stays where it
// always is and the empty space above it carries the invitation instead. Three starters, because the
// hardest part of a fresh board is not the composer — it is knowing what to type into it.

function EmptyScreen() {
  return (
    <Canvas>
      <NavBar
        back="Projects"
        title={
          <span className="flex items-center gap-1.5">
            <ProjectSquare label="P" tint="bg-[#6b7280] text-bg" size={17} />
            <span className="font-mono-keep text-[15px]">pullfrog/web</span>
            <ChevronDown size={13} className="text-muted/70" />
          </span>
        }
        trailing={<NavAction label="Board actions"><Ellipsis size={20} /></NavAction>}
      />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 pb-[110px]">
        {/* THE RASTER ICON, not `/favicon.svg`. That file is one 58KB path — the mark's loose fibers as
            a single mega-geometry — and Chrome re-tessellates it on every raster: the three screens that
            drew it could not complete a 390×844 headless screenshot in TEN MINUTES, while every screen
            without it shot in sixteen seconds. An app icon is raster on iOS anyway — and it is the TOUCH
            icon rather than `icon-192.png`, which is transparent-backed and reads as a loose yellow
            squiggle once it is drawn at notification size. */}
        <img src="/apple-touch-icon.png" width={64} height={64} alt="" className="rounded-[15px] opacity-90" />
        <h2 className="m-0 mt-4 text-[19px] font-semibold tracking-[-0.015em] text-fg">No threads yet</h2>
        <p className="m-0 mt-1.5 text-center text-[14px] leading-[20px] text-muted">
          Describe a task and Frizz dispatches a worker for it. Everything it does lands back here.
        </p>
        <div className="mt-5 flex w-full flex-col gap-2">
          {["Find and fix the flaky test in the socket suite", "Review the diff on this branch", "Write the release notes for 0.4"].map(
            (starter) => (
              <button
                key={starter}
                className="flex min-h-[44px] items-center gap-2.5 rounded-[12px] border border-border/70 bg-panel px-3.5 py-2.5 text-left text-[14px] leading-[19px] text-fg/85"
              >
                <Sparkles size={15} className="shrink-0 text-muted/70" />
                <span className="min-w-0 flex-1">{starter}</span>
                <ArrowUpRight size={15} className="shrink-0 text-muted/45" />
              </button>
            ),
          )}
        </div>
      </div>
      <ComposerDock />
    </Canvas>
  )
}

// ══ 14 · notification ═══════════════════════════════════════════════════════════════════════════
// THE LOCK SCREEN, and the reason a phone client is worth building at all. Frizz already knows the
// moment a worker stops and asks — on a desktop that is a notification you walk back to your machine
// for. Here the ask arrives with its OPTIONS attached, so the round trip that unblocks a worker is one
// tap from a locked phone, and the thread is running again before you have unlocked it.
//
// Two rules this obeys. The notification carries the QUESTION, never the worker's reasoning — a
// notification is a decision surface, not a transcript. And the recommended option leads, marked, so
// the fast path is also the considered one.

/**
 * The app icon at notification size — and a finding rather than a detail.
 *
 * The Frizz mark is five fibers pulling loose from a wrapped bundle, and `ProjectGrid.tsx` already
 * records that below ~70px the strands collapse into a silhouette. A notification icon is 20–24pt, so
 * the shipped mark cannot survive there: drawn bare it reads as a yellow scribble. On its own tile it at
 * least reads as AN APP, which is what this slot is really for — but a phone client would want a
 * simplified mark cut for the small sizes, and that is a design decision for the maintainer, not one to
 * make inside a mockup.
 */
function AppMark({ quiet }: { quiet?: boolean }) {
  return (
    <span
      className={`mt-[1px] flex size-[22px] shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-white/[0.08] bg-[#191a20] ${
        quiet ? "opacity-80" : ""
      }`}
    >
      <img src="/apple-touch-icon.png" width={18} height={18} alt="" />
    </span>
  )
}

function NotificationScreen() {
  return (
    <Canvas className="bg-black">
      {/* The wallpaper: a quiet radial wash rather than a photo, so the notification is what the eye
          lands on and the mockup is judging the notification instead of the picture behind it. */}
      <div
        className="absolute inset-0"
        style={{ background: "radial-gradient(120% 90% at 50% 0%, #1b1d22 0%, #0d0e10 55%, #08090b 100%)" }}
      />
      <div className="relative flex min-h-0 flex-1 flex-col pb-[26px] pt-[76px]">
        <div className="flex flex-col items-center gap-1">
          <span className="text-[22px] font-medium tracking-[-0.01em] text-fg/85">Saturday, 16 August</span>
          <span className="text-[86px] font-semibold leading-[96px] tracking-[-0.03em] text-fg tabular-nums">9:41</span>
        </div>

        {/* Notifications stack at the BOTTOM of the lock screen, above the two utility buttons — iOS
            moved them there in 16 and it is the half of the screen a thumb can reach. */}
        <div className="mt-auto flex flex-col gap-2 px-3">
          {/* The expanded (long-pressed) notification, with the ask's own options as actions. */}
          <div className="overflow-hidden rounded-[20px] border border-white/[0.07] bg-white/[0.09] backdrop-blur-2xl">
            <div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
              <AppMark />
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[0.01em] text-fg/70">
                    FRIZZ · nubjs/nub
                  </span>
                  <span className="shrink-0 text-[12.5px] text-fg/50">now</span>
                </div>
                <span className="text-[15px] font-semibold leading-[20px] text-fg">
                  Fix the cache collision in the resolver
                </span>
                <span className="text-[15px] leading-[20px] text-fg/80">
                  Should the settings store use SQLite or a JSON file?
                </span>
              </div>
            </div>
            {/* The two answers, as notification actions. Answering here never opens the app. */}
            <div className="flex border-t border-white/[0.09]">
              <button className="flex h-[46px] flex-1 items-center justify-center gap-1.5 border-r border-white/[0.09] text-[15px] font-medium text-accent">
                SQLite
                <span className="text-[11.5px] font-normal text-accent/70">recommended</span>
              </button>
              <button className="flex h-[46px] flex-1 items-center justify-center text-[15px] text-fg/85">
                JSON file
              </button>
            </div>
          </div>

          {/* A second, quieter notification — the finished-work kind, which needs no action. */}
          <div className="flex items-start gap-2.5 rounded-[20px] border border-white/[0.05] bg-white/[0.06] px-3.5 py-3 backdrop-blur-2xl">
            <AppMark quiet />
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[0.01em] text-fg/60">
                  FRIZZ · colinhacks/zod
                </span>
                <span className="shrink-0 text-[12.5px] text-fg/45">14m ago</span>
              </div>
              <span className="truncate text-[15px] leading-[20px] text-fg/80">
                Port the v2 drivers — done, landed on main
              </span>
            </div>
          </div>
        </div>

        {/* The two lock-screen utilities, for scale and for honesty about what else lives down here. */}
        <div className="mt-5 flex items-center justify-between px-9">
          {[
            <path key="t" d="M9 2h6v3a3 3 0 0 1-1 2.2V22h-4V7.2A3 3 0 0 1 9 5Z" />,
            <>
              <path key="c1" d="M4 8h3l1.5-2h7L17 8h3v11H4Z" />
              <circle key="c2" cx="12" cy="13.5" r="3.5" />
            </>,
          ].map((glyph, i) => (
            <span key={i} className="flex size-[50px] items-center justify-center rounded-full bg-white/[0.12] backdrop-blur-2xl">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" className="text-fg/90" aria-hidden>
                {glyph}
              </svg>
            </span>
          ))}
        </div>
      </div>
    </Canvas>
  )
}

// ══ 15 · plan ═══════════════════════════════════════════════════════════════════════════════════
// A PLAN, READ ON A PHONE. Plans are the one artifact in Frizz that is genuinely long-form prose, and
// the one thing a phone is unambiguously good at. So the plan drawer becomes a reading surface — the
// app's own `.md-body` rhythm at the phone's measure — with the single verb it exists for docked at the
// bottom, where a reader's thumb already is when they reach the end.

function PlanScreen() {
  return (
    <Canvas>
      <NavBar
        back="Board"
        title="Resolver rewrite"
        subtitle="3 threads from this plan"
        trailing={<NavAction label="Plan actions"><Ellipsis size={20} /></NavAction>}
      />
      <div className="min-h-0 flex-1 overflow-hidden px-5 pb-[96px] pt-4">
        {/* The app's own markdown class, so the phone reads plans in exactly the rhythm the desktop
            does — one prose scale for the product, not a second one invented here. */}
        <div className="md-body" style={{ fontSize: 15 }}>
          <h1 className="m-0 text-[22px] font-semibold leading-[28px] tracking-[-0.015em]">Resolver rewrite, stage 2</h1>
          <p>
            The resolver keys its cache on the raw id. Stage 1 normalized the ids at the boundary; this
            stage moves the cache itself onto the normalized key and retires the compatibility shim.
          </p>
          <h2>What lands</h2>
          <ul className="pl-[1.75em]">
            <li className="list-none">
              <span className="md-task md-task-checked" />
              <span className="md-task-text">Normalize at the boundary</span>
            </li>
            <li className="list-none">
              <span className="md-task md-task-in-progress" />
              <span className="md-task-text">Key the cache on the normalized id</span>
            </li>
            <li className="list-none">
              <span className="md-task" />
              <span className="md-task-text">Retire the compatibility shim</span>
            </li>
          </ul>
          <p>
            The shim cannot go until the on-disk cache has migrated, which is a decision for whoever
            picks this up: migrate lazily on read, or rebuild once at boot.
          </p>
          <h2>The key</h2>
          <pre className="overflow-x-auto"><code>{`const key = normalizeId(raw)   // was: raw
cache.set(key, resolved)`}</code></pre>
          <p>
            Everything downstream already reads through <code>resolveId</code>, so nothing else has to
            change with it.
          </p>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 z-30 border-t border-border/70 bg-bg/85 px-4 pb-[30px] pt-2.5 backdrop-blur-xl">
        <Button kind="accent" size="lg" full>Implement this plan</Button>
      </div>
    </Canvas>
  )
}

// ══ 16 · kit ════════════════════════════════════════════════════════════════════════════════════
// THE CONTROL VOCABULARY on one screen, so the pieces can be judged against each other rather than one
// at a time inside a layout.

function KitSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted/70">{title}</span>
      {children}
    </div>
  )
}

function KitScreen() {
  return (
    <Canvas>
      <NavBar title="Controls" leading={<span className="w-[44px]" />} />
      <div className="min-h-0 flex-1 overflow-hidden px-4 pb-[34px] pt-3">
        <div className="flex flex-col gap-4">
          <KitSection title="Buttons">
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <Button kind="accent" className="flex-1">Send answer</Button>
                <Button kind="filled" className="flex-1">Mark as done</Button>
              </div>
              <div className="flex gap-2">
                <Button kind="tinted" className="flex-1">Snooze</Button>
                <Button kind="destructive" className="flex-1">Archive</Button>
              </div>
              <div className="flex items-center gap-2">
                <Button kind="plain" size="sm">Load earlier</Button>
                <Button kind="tinted" size="sm">Retry</Button>
                <Button kind="filled" size="sm">Dispatch</Button>
              </div>
            </div>
          </KitSection>

          <KitSection title="Segments and switches">
            <Segmented options={["low", "med", "high", "xhigh", "max"]} value="high" />
            <div className="flex items-center gap-3">
              <Toggle on />
              <Toggle />
              <Segmented className="flex-1" options={["Sans", "Mono"]} value="Sans" />
            </div>
          </KitSection>

          <KitSection title="Status marks">
            <div className="flex items-center gap-4 rounded-[12px] border border-border/70 bg-panel px-4 py-3">
              {[
                { mark: <AskBox />, label: "asks" },
                { mark: <BoxSpinnerM frozen />, label: "runs" },
                { mark: <StatusBox />, label: "rests" },
                { mark: <StatusBox><Hourglass size={11} className="text-muted/75" /></StatusBox>, label: "held" },
                { mark: <DoneBox />, label: "done" },
              ].map((item) => (
                <div key={item.label} className="flex flex-1 flex-col items-center gap-1.5">
                  {item.mark}
                  <span className="text-[11px] text-muted/70">{item.label}</span>
                </div>
              ))}
            </div>
            <div className="flex items-baseline justify-between rounded-[12px] border border-border/70 bg-panel px-4 py-3 text-[12.5px] text-muted">
              <span className="flex items-baseline gap-2"><LiveDot kind="agent" />agent</span>
              <span className="flex items-baseline gap-2"><LiveDot kind="shell" />shell</span>
              <span className="flex items-baseline gap-2"><LiveDot kind="github" />PR watch</span>
              <span className="flex items-baseline gap-2"><LiveDot kind="shell" quiet />quiet</span>
            </div>
          </KitSection>

          <KitSection title="Toast">
            <div className="flex items-center gap-2.5 rounded-[14px] border border-border-strong bg-elevated px-3.5 py-3 shadow-lg shadow-black/50">
              <Check size={15} className="shrink-0 text-live" strokeWidth={2.6} />
              <span className="min-w-0 flex-1 text-[13.5px] leading-[18px] text-fg/90">Answer sent — the worker is running again</span>
              <span className="shrink-0 text-[13.5px] font-medium text-accent">Undo</span>
            </div>
          </KitSection>

          <KitSection title="Prompt box">
            <div className="flex items-end gap-2">
              <div className="flex min-h-[44px] min-w-0 flex-1 flex-col gap-2 rounded-[22px] border border-border-strong bg-panel px-3.5 py-[11px]">
                <span className="text-[16px] leading-[21px] text-fg">Port the v2 drivers</span>
                <div className="flex items-center gap-1.5">
                  <Chip>opus · high</Chip>
                  <Chip>ask</Chip>
                </div>
              </div>
              <button aria-label="Send" className="flex size-[44px] shrink-0 items-center justify-center rounded-full bg-accent text-bg">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </button>
            </div>
          </KitSection>
        </div>
      </div>
    </Canvas>
  )
}

// ══ the gallery ═════════════════════════════════════════════════════════════════════════════════

const SCREENS: { id: string; title: string; note: string; render: () => ReactNode }[] = [
  { id: "home", title: "1 · Home", note: "Every project on the machine, sorted by what wants you. The accent count is the ask.", render: () => <HomeScreen /> },
  { id: "board", title: "2 · Project board", note: "Rested → Active → Held → Done, as cards. One card mid-swipe.", render: () => <BoardScreen /> },
  { id: "board-ask", title: "3 · Answering in place", note: "The asking card expanded on the board — the whole argument for cards over rows.", render: () => <BoardScreen ask={<AskCardExpanded />} /> },
  { id: "thread", title: "4 · Thread", note: "The transcript full screen, composer docked under the thumb.", render: () => <ThreadScreen /> },
  { id: "answer", title: "5 · Answering, full screen", note: "Several questions at once: one 56pt row per option, send docked.", render: () => <AnswerScreen /> },
  { id: "actions", title: "6 · Thread actions", note: "A medium-detent sheet over a receded board.", render: () => <ActionsScreen /> },
  { id: "dispatch", title: "7 · New thread", note: "The prompt box promoted, drawn with the keyboard up because that is the real height.", render: () => <DispatchScreen /> },
  { id: "snooze", title: "8 · Snooze", note: "A five-second decision at a small detent, every option resolving its own clock.", render: () => <SnoozeScreen /> },
  { id: "settings", title: "9 · Settings", note: "The settings drawer as grouped rows.", render: () => <SettingsScreen /> },
  { id: "subagent", title: "10 · Sub-agent", note: "The drill-in, at the large detent over its parent — the desktop's stacked drawers.", render: () => <SubAgentScreen /> },
  { id: "switcher", title: "11 · Project switcher", note: "The rail, behind the title chevron rather than a permanent column.", render: () => <SwitcherScreen /> },
  { id: "search", title: "12 · Search", note: "The command palette, without a chord to open it.", render: () => <SearchScreen /> },
  { id: "empty", title: "13 · Empty board", note: "A project with nothing in it yet, and three ways to start.", render: () => <EmptyScreen /> },
  { id: "notification", title: "14 · Lock screen", note: "The ask arrives with its options attached — the round trip that unblocks a worker, from a locked phone.", render: () => <NotificationScreen /> },
  { id: "plan", title: "15 · Plan", note: "The one genuinely long-form artifact in Frizz, read at the phone's measure.", render: () => <PlanScreen /> },
  { id: "kit", title: "16 · Controls", note: "The whole vocabulary on one screen.", render: () => <KitScreen /> },
]

function Gallery() {
  const shown = only ? SCREENS.filter((s) => s.id === only) : SCREENS
  if (only && shown.length === 1) {
    const screen = shown[0]
    return (
      <div className="flex min-h-dvh items-start justify-start bg-bg">
        <Phone id={screen.id} title={screen.title} solo>{screen.render()}</Phone>
      </div>
    )
  }
  return (
    <div className="min-h-dvh bg-bg px-10 py-12">
      <header className="mb-10 flex max-w-[720px] flex-col gap-2.5">
        <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em] text-fg">Frizz on a phone</h1>
        <p className="m-0 text-[14px] leading-[21px] text-muted">
          Sixteen screens, drawn at 390×844 in the app's own stylesheet and tokens. Append{" "}
          <code className="rounded bg-panel-2 px-1 py-0.5 font-mono-keep text-[12.5px]">?screen=board</code> for one on
          its own at 1:1, or <code className="rounded bg-panel-2 px-1 py-0.5 font-mono-keep text-[12.5px]">?font=mono</code>{" "}
          for the other font setting.
        </p>
      </header>
      <div className="flex flex-wrap gap-x-12 gap-y-14">
        {shown.map((screen) => (
          <Phone key={screen.id} id={screen.id} title={screen.title} note={screen.note}>
            {screen.render()}
          </Phone>
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Gallery />)
