// FRIZZ ON A PHONE — the whole product, mocked up for a 390pt viewport.
//
// Not a test and not shipped UI: a DESIGN SURFACE, in the shape `awaiting-mockups-fixture.tsx`
// established. Every screen renders in the app's REAL stylesheet on the app's REAL tokens, so a choice
// made here is a choice about the thing that would ship.
//
//   nubx vite --port 5477 --strictPort          (from packages/web)
//   http://localhost:5477/mobile-mockup-fixture.html                — the gallery, every screen
//                                              ?screen=board        — one screen, alone, at 1:1
//                                              ?font=mono           — the other font setting
//                                              ?still=1             — freeze the spinners for a still
//
// ── What is being designed ────────────────────────────────────────────────────────────────────────
// The desktop app is three standing surfaces at once: a project rail, a thread rail, and a workpane,
// with threads opening as right-hand drawers that stack. None of that survives 390pt. The phone gets
// the same INFORMATION MODEL — Rested / Active / Held / Done, the accent meaning "awaiting you", the
// checkbox status family — expressed as a two-level drill-down where every drawer becomes a sheet at a
// detent, every rail row becomes a full-width list row, and the four bands become four tabs.
//
// THIS IS A WEBSITE, not an app-store submission (maintainer 2026-08-17: "This is a freaking website
// that people go to, not a mobile app at this point"). So there is no push notification, no lock
// screen and no install flow here: everything drawn is something a browser tab can do today.
//
// ── The rulings, and who made them ────────────────────────────────────────────────────────────────
// Round 2 rewrote most of round 1 against the maintainer's review. Each of these is theirs:
//
//   1. NO PROMPT BOX ON THE BOARD. A docked composer for a NEW thread is not the same kind of thing as
//      a reply box, and the liveness indicator round 1 parked above it belonged to a running thread,
//      not over a control that starts one. Creating a thread is the floating + in the bottom right;
//      live work is drawn on the running thread's own row.
//   2. NO PROJECT SWITCHER. The board already has a way back to Projects; a switcher in the title as
//      well is two doors to one room.
//   3. NO YELLOW CARD FOR A QUESTION. The rail marks an ask with the accent "?" and nothing else —
//      "it's clean and it's consistent and it's subtle" — so that mark is all an asking row gets here.
//   4. FULL WIDTH, NOT CARDS. A card spends side margins AND its own padding on every row.
//   5. THE BANDS ARE TABS along the bottom, in a tab bar whose icons are the status family itself.
//   6. NO ANSWERING FROM THE LIST. You open the thread, read the context that produced the question,
//      and answer it there.
//
// Kept from round 1: every drawer is a sheet at a detent with the parent scaled back behind it; the
// accent is spent only on the ask and on one primary verb per screen (so nav actions are neutral); and
// iOS's 17/15/13/11.5 type scale with a 44pt touch floor rather than the desktop's 13px-everything.
//
// Screens, in `?screen=` order: home · board · board-active · board-held · thread · answer · actions ·
// dispatch · snooze · settings · subagent · search · empty · plan · kit
import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"
import {
  Archive, ArrowUpRight, Bell, Check, ChevronRight, Clock, Copy, Ellipsis, FileText, Github, Hourglass,
  Image as ImageIcon, Info, Paperclip, Pencil, Plus, RotateCcw, Search, Settings as SettingsIcon,
  Sparkles, SquareTerminal, Timer, Type as TypeIcon, Wrench, X, Zap,
} from "lucide-react"
import {
  AskBox, BoxSpinnerM, Button, Canvas, Chip, ComposerDock, DoneBox, Fab, Group, GroupHeader, INK,
  Keyboard, LargeTitle, LiveDot, NavAction, NavBar, ON_CAP, Phone, Row, RowRule, Segmented,
  SheetHeader, SheetOver, StatusBox, TabBar, Toggle,
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
 * The desktop rail solved this exact bug the same way (Sidebar's TitleWithTrailers); a phone's title
 * column hits it far more often.
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

/**
 * A THREAD ROW — the phone's unit of board information, and what a rail row becomes.
 *
 * Full width, hairline-separated, no card. The anatomy is the rail's: the status glyph keeps its own
 * column so the marks read as a stripe down the list, the title wraps rather than truncating (the
 * rail's own rule), and the rest time is a right-justified column, because a title's length must not
 * decide where its timestamp sits. An asking thread is marked by the accent "?" in that glyph column
 * and by NOTHING else — no border, no tint, no rail.
 *
 * The separator is drawn by the row so it can be INSET to the text column (16 + 18 + 12 = 46), which is
 * what tells the eye the glyph column is a gutter rather than the first cell of a table.
 */
function ThreadRow({
  glyph,
  title,
  provider,
  age,
  gloss,
  activity,
  children,
  dim,
  last,
}: {
  glyph: ReactNode
  title: string
  provider?: "claude" | "codex"
  age?: string
  gloss?: ReactNode
  activity?: ReactNode
  children?: ReactNode
  dim?: boolean
  last?: boolean
}) {
  return (
    <div className={dim ? "opacity-60" : ""}>
      <div className="flex items-start gap-3 px-4 pb-2.5 pt-2.5">
        <span data-ink="row-glyph" className="flex h-[21px] shrink-0 items-center justify-center">{glyph}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <div className="flex min-w-0 items-baseline gap-3">
            <span data-ink="row-title" className="min-w-0 flex-1 text-[15px] font-medium leading-[21px] tracking-[-0.01em] text-fg">
              <TitleWithMark title={title} provider={provider} />
            </span>
            {age ? <span className="shrink-0 text-[11.5px] leading-[21px] tabular-nums text-muted/60">{age}</span> : null}
          </div>
          {gloss ? <span className="min-w-0 truncate text-[13px] leading-[18px] text-muted">{gloss}</span> : null}
          {activity ? <span className="min-w-0 truncate text-[13px] leading-[18px] text-muted/85">{activity}</span> : null}
        </div>
      </div>
      {children}
      {last ? null : <div className="ml-[46px] h-px bg-border/70" />}
    </div>
  )
}

/**
 * An indented child-op row — the rail's ⤷ line.
 *
 * THIS is where a liveness dot belongs: under the thread that owns the work, never over a control that
 * starts a new one.
 */
function ChildOp({ kind, label, elapsed }: { kind: "agent" | "shell"; label: string; elapsed: string }) {
  return (
    <div className="flex items-baseline gap-2 pb-1.5 pl-[46px] pr-4">
      <span data-ink="op-dot" className="flex shrink-0"><LiveDot kind={kind} /></span>
      <span data-ink="op-label" className="min-w-0 flex-1 truncate text-[12.5px] leading-[19px] text-muted">{label}</span>
      <span className="shrink-0 text-[11.5px] leading-[19px] tabular-nums text-muted/55">{elapsed}</span>
    </div>
  )
}

// ══ 1 · home ════════════════════════════════════════════════════════════════════════════════════
// EVERY PROJECT ON THE MACHINE, and what each of them wants from you. The desktop grid shows a name, a
// path and a last-opened date, because opening forty databases to draw forty cards is exactly what lazy
// activation exists to avoid. A phone is the surface you check away from your desk, so the one thing
// worth paying for is the answer to "does anything need me": a per-board state summary, and the accent
// count of asks. Sorted by that count, so the answer is the top of the screen.
const PROJECTS = [
  { slug: "nub", label: "nubjs/nub", tint: "bg-[#e8b923] text-bg", initial: "N", path: "~/code/nub", asks: 2, active: 2, held: 1, when: "now" },
  { slug: "zod", label: "colinhacks/zod", tint: "bg-[#4a9eff] text-bg", initial: "Z", path: "~/code/zod", asks: 1, active: 0, held: 2, when: "2h" },
  { slug: "frizz", label: "colinhacks/frizz", tint: "bg-[#b47feb] text-bg", initial: "F", path: "~/Documents/projects/frizz", asks: 0, active: 3, held: 0, when: "12m" },
  { slug: "acme-app", label: "acme/app", tint: "bg-[#4ac97e] text-bg", initial: "A", path: "~/work/acme/app", asks: 0, active: 0, held: 1, when: "yesterday" },
  { slug: "pullfrog", label: "pullfrog/web", tint: "bg-[#6b7280] text-bg", initial: "P", path: "~/code/pullfrog", asks: 0, active: 0, held: 0, when: "3d" },
  { slug: "sonner", label: "emilkowal/sonner", tint: "bg-[#33363c] text-fg", initial: "S", path: "~/code/sonner", asks: 0, active: 0, held: 0, when: "1w" },
]

function ProjectRow({ p, last }: { p: (typeof PROJECTS)[number]; last?: boolean }) {
  const quiet = p.asks === 0 && p.active === 0 && p.held === 0
  return (
    <div>
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
      {last ? null : <div className="ml-[72px] h-px bg-border/70" />}
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
          <ProjectRow p={PROJECTS[0]} />
          <ProjectRow p={PROJECTS[1]} last />
        </Group>

        <GroupHeader>All projects</GroupHeader>
        <Group>
          {PROJECTS.slice(2).map((p, i, all) => (
            <ProjectRow key={p.slug} p={p} last={i === all.length - 1} />
          ))}
        </Group>

        <div className="px-4 pt-4">
          {/* Dashed and never filled: an affordance, not a project — the desktop grid's own ruling. */}
          <button className="flex h-[48px] w-full items-center justify-center gap-2 rounded-[12px] border border-dashed border-border-strong text-[15px] text-muted active:border-accent active:text-fg">
            <Plus size={17} className={ON_CAP} />
            Add a project
          </button>
        </div>
      </div>
    </Canvas>
  )
}

// ══ 2–4 · the board ═════════════════════════════════════════════════════════════════════════════
// THE PROJECT PAGE, as a tab view. The bands are the app's own, in the app's own words: Rested (the
// cue) → Active (spinning, and nothing else) → Held → Done. On a phone they are four tabs rather than
// four stacked sections, so the band you are reading gets the whole screen instead of a quarter of it.
//
// The tab bar's icons ARE the status family, which makes it the legend for the list above it. The +
// starts a thread. Nothing on this screen is a composer.

const TAB_ICON = 21

function boardTabs(active: string) {
  return [
    // The icon is the BAND's mark — an at-rest row's empty box — not an ask mark: Rested is where asks
    // land, but a rested thread is not itself a question. The accent BADGE is what says one of these
    // three is waiting on you, and it is the only accent in the bar.
    { id: "rested", label: "Rested", icon: <StatusBox size={TAB_ICON} />, count: 3, asks: true },
    { id: "active", label: "Active", icon: <BoxSpinnerM size={TAB_ICON} frozen={still} />, count: 3 },
    { id: "held", label: "Held", icon: <StatusBox size={TAB_ICON}><Hourglass size={13} className="text-muted/75" /></StatusBox>, count: 2 },
    { id: "done", label: "Done", icon: <DoneBox size={TAB_ICON} />, count: 6 },
  ]
}

function BoardTopBar() {
  return (
    <NavBar
      back="Projects"
      // No switcher. The way to another project is the way you came (maintainer 2026-08-17: "Kind of
      // weird to have that and the projects, like the ability to go back to a project… I think we
      // should probably just drop the switcher").
      title={
        <span className="flex items-center gap-1.5">
          <ProjectSquare label="N" tint="bg-[#e8b923] text-bg" size={17} />
          <span className="font-mono-keep text-[15px]">nubjs/nub</span>
        </span>
      }
      trailing={<NavAction label="Board actions"><Ellipsis size={20} /></NavAction>}
    />
  )
}

/**
 * A row mid-swipe.
 *
 * Full-width rows are what make this read right: the row slides under the SCREEN edge, exactly as a
 * Mail cell does, instead of sliding out of a floating card and looking broken. A swipe caught in a
 * still always cuts a word in half — that is the gesture, not a rendering fault.
 */
function SwipedRow() {
  return (
    <div className="relative overflow-hidden">
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
        <ThreadRow
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

function BoardShell({ tab, children }: { tab: string; children: ReactNode }) {
  return (
    <Canvas>
      <BoardTopBar />
      {/* 83pt of tab bar + safe area, and the + floats clear of both. */}
      <div className="min-h-0 flex-1 overflow-hidden pb-[83px]">{children}</div>
      <Fab />
      <TabBar tabs={boardTabs(tab)} active={tab} />
    </Canvas>
  )
}

/** Rested — the cue. Every row here is at rest; the accent "?" is the only thing marking an ask. */
function BoardRestedScreen() {
  return (
    <BoardShell tab="rested">
      <Group className="border-t-0">
        <ThreadRow
          glyph={<AskBox />}
          title="Fix the cache collision in the resolver"
          provider="claude"
          age="4m"
          gloss="Should the settings store use SQLite or a JSON file?"
        />
        <ThreadRow
          glyph={<StatusBox />}
          title="Audit the parser for edge cases"
          provider="claude"
          age="1h"
          gloss="Waiting on your call about the tokenizer"
        />
        <SwipedRow />
        <ThreadRow
          glyph={<AskBox />}
          title="Pick the retry policy for the socket reconnect"
          provider="codex"
          age="5h"
          gloss="Two options, both reversible"
        />
        <ThreadRow
          glyph={<StatusBox />}
          title="Port the v2 drivers to the new host API"
          provider="claude"
          age="2d"
          gloss="Rested — nothing running"
        />
        <ThreadRow
          glyph={<StatusBox />}
          title="Compress the board payload on the wire"
          provider="claude"
          age="2d"
          gloss="780KB → 137KB, landed on main"
        />
        <ThreadRow
          glyph={<AskBox />}
          title="Decide what a restart does to a live turn"
          provider="claude"
          age="3d"
          gloss="Needs a call before the next release"
        />
        <ThreadRow
          glyph={<StatusBox />}
          title="Pin the batch-local result memo"
          provider="codex"
          age="4d"
          gloss="Rested — nothing running"
        />
        <ThreadRow
          glyph={<StatusBox />}
          title="Teach the tailer about the 20k backlog"
          provider="claude"
          age="6d"
          gloss="Rested — nothing running"
          last
        />
      </Group>
    </BoardShell>
  )
}

/**
 * Active — SPINNING, and nothing else.
 *
 * The only band whose rows carry live work, so the only one whose rows carry a liveness dot: the blue
 * one under a row is that thread's background shell, the yellow one its sub-agent. No rest times here —
 * a row that is still running has not made a handoff, so it has nothing to date.
 */
function BoardActiveScreen() {
  return (
    <BoardShell tab="active">
      <Group className="border-t-0">
        <ThreadRow
          glyph={<BoxSpinnerM frozen={still} />}
          title="Migrate the board store to valtio 2"
          provider="claude"
          activity={<span className="shimmer-text">Running the focused tests</span>}
        >
          <div className="flex flex-col">
            <ChildOp kind="agent" label="Audit the parser for edge cases" elapsed="2m" />
            <ChildOp kind="shell" label="gh run watch 1842" elapsed="4m" />
          </div>
        </ThreadRow>
        <ThreadRow
          glyph={<BoxSpinnerM frozen={still} />}
          title="Draft the changelog for 0.4"
          provider="codex"
          activity={<span className="shimmer-text">Reading packages/server/src/router.ts</span>}
        >
          <div className="flex flex-col">
            <ChildOp kind="shell" label="vite dev --host" elapsed="18m" />
          </div>
        </ThreadRow>
        <ThreadRow
          glyph={<BoxSpinnerM frozen={still} />}
          title="Chase the socket reconnect flake"
          provider="claude"
          activity={<span className="shimmer-text">Inspecting the broker handshake</span>}
          last
        />
      </Group>
    </BoardShell>
  )
}

/** Held — dimmed, and every row says what it is waiting for. */
function BoardHeldScreen() {
  return (
    <BoardShell tab="held">
      <Group className="border-t-0">
        <ThreadRow
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
        <ThreadRow
          dim
          glyph={<StatusBox><Timer size={11} className="text-muted/75" /></StatusBox>}
          title="Retry the flaky socket test"
          provider="claude"
          age="20m"
          gloss="Wakes at 5:00 PM"
          last
        />
      </Group>
    </BoardShell>
  )
}

// ══ 5 · thread ══════════════════════════════════════════════════════════════════════════════════
// THE TRANSCRIPT, full screen — and the only place a composer belongs, because here there is a
// conversation to add to. Everything the desktop draws in a stacked right-hand drawer, in the one place
// a phone has.

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

          {/* THE ASK, in the one place it is answerable: inside the thread, under the context that
              produced it (maintainer 2026-08-17: "you should just be clicking into the thread in order
              to review the rest of the message and the full context, and then answer the questions that
              way"). The card wears the app's ordinary chrome — the "?" carries the state, not a colour. */}
          <div className="rounded-[12px] border border-border-strong bg-panel p-3.5">
            <div className="flex items-baseline gap-2">
              <span className={ON_CAP}><AskBox size={15} /></span>
              <span className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted">Question</span>
            </div>
            <p className="m-0 mt-2 text-[15px] leading-[21px] text-fg">
              Should the settings store use SQLite or a JSON file?
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button kind="accent" size="sm">Answer</Button>
              <Button kind="tinted" size="sm">Ask something back</Button>
            </div>
          </div>

          <div className="flex items-center gap-3 py-1">
            <span className="h-px flex-1 bg-border/60" />
            <span className="shrink-0 text-[11.5px] text-muted/60">rested 4m</span>
            <span className="h-px flex-1 bg-border/60" />
          </div>
        </div>
      </div>
      <ComposerDock />
    </Canvas>
  )
}

// ══ 6 · answer ══════════════════════════════════════════════════════════════════════════════════
// ANSWERING, pushed from the thread. Each option is a 56pt row, and the send action is docked rather
// than appended to the last question, because it answers BOTH and must be reachable without scrolling
// to the bottom of the ask.

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
    <button className={`flex min-h-[56px] w-full items-start gap-3 px-4 py-3 text-left ${chosen ? "bg-accent/[0.09]" : ""}`}>
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

function QuestionBlock({
  prompt,
  options,
}: {
  prompt: string
  options: { letter: string; label: string; why: string; chosen?: boolean; rec?: boolean }[]
}) {
  return (
    <Group>
      <div className="px-4 pb-2.5 pt-3">
        <p className="m-0 text-[15px] font-medium leading-[21px] text-fg">{prompt}</p>
      </div>
      {options.map((option) => (
        <div key={option.letter}>
          <div className="h-px bg-border/70" />
          <OptionRow {...option} />
        </div>
      ))}
    </Group>
  )
}

function AnswerScreen() {
  return (
    <Canvas>
      <NavBar back="Thread" title="2 questions" subtitle="Fix the cache collision" />
      <div className="min-h-0 flex-1 overflow-hidden pb-[100px]">
        <div className="px-4 pt-4">
          <p className="m-0 text-[13.5px] leading-[19px] text-muted">
            The resolver fix is written and its test is green. Both of these change what ships, so they
            are yours to call.
          </p>
        </div>

        <GroupHeader>Question 1 of 2</GroupHeader>
        <QuestionBlock
          prompt="Should the settings store use SQLite or a JSON file?"
          options={[
            { letter: "A", label: "SQLite", why: "Transactional, and it matches how sessions are already stored", chosen: true, rec: true },
            { letter: "B", label: "JSON file", why: "Zero deps and human-editable, but racy under concurrent writes" },
            { letter: "C", label: "Something else", why: "Type your own answer" },
          ]}
        />

        <GroupHeader>Question 2 of 2</GroupHeader>
        <QuestionBlock
          prompt="Should the normalized key be written into the on-disk cache too?"
          options={[
            { letter: "A", label: "Migrate on next read", why: "No downtime; a stale entry is corrected the first time it is hit", rec: true },
            { letter: "B", label: "Rebuild the cache once", why: "Clean, but the first boot after the update is slow" },
          ]}
        />
      </div>
      <div className="absolute inset-x-0 bottom-0 z-30 border-t border-border/70 bg-bg/85 px-4 pb-[30px] pt-2.5 backdrop-blur-xl">
        <Button kind="accent" size="lg" full>Send 1 of 2 answers</Button>
      </div>
    </Canvas>
  )
}

// ══ 7 · actions ═════════════════════════════════════════════════════════════════════════════════
// THE THREAD-ACTIONS SHEET, over a receded board. Everything the desktop scatters across a row hover, a
// header cluster and a footer, in one list at the bottom of the screen where the thumb is.

function ActionsScreen() {
  return (
    <Canvas>
      <SheetOver detent={0.68} behind={<BoardRestedScreen />}>
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

          <div className="flex flex-col gap-4 overflow-hidden pb-[34px]">
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

// ══ 8 · dispatch ════════════════════════════════════════════════════════════════════════════════
// NEW THREAD, WITH THE KEYBOARD UP — the only honest way to draw a composer. The + opens this: a real
// writing surface with the dispatch controls under it, in the 553 points that survive once the keyboard
// is showing. Everything below that line has to be reached by scrolling the form, so nothing lives
// there that you need WHILE typing; what you do need mid-sentence rides the accessory bar.
//
// The verb is SUBMIT (maintainer 2026-08-17). "Dispatch" is what the system does with the thread;
// "Submit" is what the person at the keyboard is doing.

function DispatchScreen() {
  return (
    <Canvas>
      <NavBar
        title="New thread"
        subtitle="nubjs/nub"
        leading={<button className="px-2 text-[17px] text-fg/85">Cancel</button>}
        trailing={<button className="px-2 text-[17px] font-semibold text-accent">Submit</button>}
      />
      <div className="min-h-0 flex-1 overflow-hidden pb-[347px]">
        <div className="px-4 pb-1 pt-4">
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
              label — squeezed beside "Effort" the segmented control had 37pt per cell and "xhigh" had to
              be dropped, which quietly misrepresents what the product offers. */}
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

// ══ 9 · snooze ══════════════════════════════════════════════════════════════════════════════════
// A SMALL-DETENT SHEET, and the argument for detents at all: this is a five-second decision, so it takes
// half the screen and leaves the board visible behind it. Every option resolves its own wall clock on
// the right — "this evening" is not an instruction the reader should have to convert.

function SnoozeScreen() {
  return (
    <Canvas>
      <SheetOver detent={0.5} behind={<BoardRestedScreen />}>
        {/* NO confirm button. Every row here IS the choice, so a Done would be a second tap that can
            only ever mean "yes, the thing I just tapped" — and a permanently-dim one, until then. */}
        <SheetHeader title="Snooze" leading={<button className="px-2 text-[16px] text-fg/85">Cancel</button>} />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden pt-3">
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
          <p className="m-0 px-4 text-[12.5px] leading-[17px] text-muted/70">
            A snoozed thread moves to Held and wakes itself at the time you pick. Nothing stops running.
          </p>
        </div>
      </SheetOver>
    </Canvas>
  )
}

// ══ 10 · settings ═══════════════════════════════════════════════════════════════════════════════
// THE SETTINGS DRAWER, as full-width rows. The desktop drawer is a scrolling form; this is the same
// content in the shape a phone reader already knows how to skim.

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
          <Row icon={<Sparkles size={15} className="text-fg" />} iconTint="bg-elevated" label="Compact rows" detail="One line per thread on the board" trailing={<Toggle />} />
        </Group>

        <GroupHeader>Dispatch defaults</GroupHeader>
        <Group>
          <Row icon={<Sparkles size={15} className="text-fg" />} iconTint="bg-elevated" label="Model" value="Opus 5" chevron />
          <RowRule inset={57} />
          <Row icon={<Zap size={15} className="text-fg" />} iconTint="bg-elevated" label="Effort" value="High" chevron />
          <RowRule inset={57} />
          <Row icon={<Wrench size={15} className="text-fg" />} iconTint="bg-elevated" label="Permissions" value="Ask" chevron />
        </Group>

        <GroupHeader>Alerts</GroupHeader>
        <Group>
          {/* BROWSER notifications, not push. This is a website, so what it can offer is the tab's own
              Notification permission and a title badge — there is no APNs and no lock screen here. */}
          <Row
            icon={<Bell size={15} className="text-fg" />}
            iconTint="bg-[#e8b923]/18"
            label="Alert me when a thread needs me"
            detail="Uses this browser's notifications"
            trailing={<Toggle on />}
          />
          <RowRule inset={57} />
          <Row icon={<Check size={15} className="text-fg" />} iconTint="bg-[#4ac97e]/18" label="Alert me when a thread finishes" trailing={<Toggle />} />
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

// ══ 11 · subagent ═══════════════════════════════════════════════════════════════════════════════
// THE DRILL-IN SHEET, at the large detent, over its parent thread. This is the phone's answer to the
// desktop's STACKED drawers: a sub-agent opened from a thread opens over it, so the parent stays
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
          <Row icon={<DoneBox />} label="Make the resolver cache keys stable" detail="nubjs/nub · done yesterday" />
          <RowRule inset={53} />
          <Row
            icon={<StatusBox><Hourglass size={11} className="text-muted/75" /></StatusBox>}
            label="Resolver cache: migrate on read"
            detail="colinhacks/zod · held, wakes 5:00 PM"
          />
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
        <p className="m-0 px-4 pt-4 text-[12.5px] leading-[17px] text-muted/70">
          Search covers every project on this machine, not just the one you are in.
        </p>
      </div>
    </Canvas>
  )
}

// ══ 13 · empty ══════════════════════════════════════════════════════════════════════════════════
// A PROJECT WITH NOTHING IN IT. The desktop's first-run state centres the prompt box as the whole
// screen. Here the + is the way in, so the empty space carries the invitation instead — three starters,
// because the hard part of a fresh board is not the composer, it is knowing what to type into it.

function EmptyScreen() {
  return (
    <Canvas>
      <NavBar
        back="Projects"
        title={
          <span className="flex items-center gap-1.5">
            <ProjectSquare label="P" tint="bg-[#6b7280] text-bg" size={17} />
            <span className="font-mono-keep text-[15px]">pullfrog/web</span>
          </span>
        }
        trailing={<NavAction label="Board actions"><Ellipsis size={20} /></NavAction>}
      />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-[83px]">
        {/* THE RASTER ICON, not `/favicon.svg`. That file is one 58KB path — the mark's loose fibers as a
            single mega-geometry — and Chrome re-tessellates it on every raster: the screens that drew it
            could not complete a 390×844 headless screenshot in TEN MINUTES, while every screen without
            it shot in sixteen seconds. */}
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
      <Fab />
      <TabBar
        tabs={[
          { id: "rested", label: "Rested", icon: <StatusBox size={TAB_ICON} />, count: 0 },
          { id: "active", label: "Active", icon: <BoxSpinnerM size={TAB_ICON} frozen={still} />, count: 0 },
          { id: "held", label: "Held", icon: <StatusBox size={TAB_ICON}><Hourglass size={13} className="text-muted/75" /></StatusBox>, count: 0 },
          { id: "done", label: "Done", icon: <DoneBox size={TAB_ICON} />, count: 0 },
        ]}
        active="rested"
      />
    </Canvas>
  )
}

// ══ 14 · plan ═══════════════════════════════════════════════════════════════════════════════════
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
      <div className="min-h-0 flex-1 overflow-hidden px-4 pb-[96px] pt-4">
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

// ══ 15 · kit ════════════════════════════════════════════════════════════════════════════════════
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
                <Button kind="filled" size="sm">Submit</Button>
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

          <KitSection title="Reply box">
            <div className="flex items-end gap-2">
              <div className="flex min-h-[44px] min-w-0 flex-1 items-center rounded-[22px] border border-border-strong bg-panel px-3.5 py-[11px]">
                <span className="text-[16px] leading-[21px] text-fg">Use SQLite</span>
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
  { id: "board", title: "2 · Board — Rested", note: "The cue, full width. An ask is marked by the accent ? and nothing else. One row mid-swipe.", render: () => <BoardRestedScreen /> },
  { id: "board-active", title: "3 · Board — Active", note: "Spinning threads with their live children under them — the only band that carries a liveness dot.", render: () => <BoardActiveScreen /> },
  { id: "board-held", title: "4 · Board — Held", note: "Dimmed, and every row says what it is waiting for.", render: () => <BoardHeldScreen /> },
  { id: "thread", title: "5 · Thread", note: "The transcript, and the only surface with a composer. The ask is answered here, in context.", render: () => <ThreadScreen /> },
  { id: "answer", title: "6 · Answering", note: "Pushed from the thread: one 56pt row per option, send docked.", render: () => <AnswerScreen /> },
  { id: "actions", title: "7 · Thread actions", note: "A medium-detent sheet over a receded board.", render: () => <ActionsScreen /> },
  { id: "dispatch", title: "8 · New thread", note: "What the + opens, drawn with the keyboard up because that is the real height.", render: () => <DispatchScreen /> },
  { id: "snooze", title: "9 · Snooze", note: "A five-second decision at a small detent, every option resolving its own clock.", render: () => <SnoozeScreen /> },
  { id: "settings", title: "10 · Settings", note: "Browser notifications, not push — this is a website.", render: () => <SettingsScreen /> },
  { id: "subagent", title: "11 · Sub-agent", note: "The drill-in, at the large detent over its parent — the desktop's stacked drawers.", render: () => <SubAgentScreen /> },
  { id: "search", title: "12 · Search", note: "The command palette, without a chord to open it.", render: () => <SearchScreen /> },
  { id: "empty", title: "13 · Empty board", note: "A project with nothing in it yet, and three ways to start.", render: () => <EmptyScreen /> },
  { id: "plan", title: "14 · Plan", note: "The one genuinely long-form artifact in Frizz, read at the phone's measure.", render: () => <PlanScreen /> },
  { id: "kit", title: "15 · Controls", note: "The whole vocabulary on one screen.", render: () => <KitScreen /> },
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
          Fifteen screens, drawn at 390×844 in the app's own stylesheet and tokens. Append{" "}
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
