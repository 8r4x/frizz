// The client's view of the server's RPC surface — the ONE declaration every browser call site is
// checked against.
//
// WHY THIS FILE IS SEPARATE FROM rpc.ts (and why it may only contain types + plain data):
// it is compiled a SECOND time, by the server package's typecheck, where `packages/server/src/
// rpc-contract.ts` proves — procedure by procedure — that every declaration below is EXACTLY the
// zod `input`/`output` of the real router. That is the structural gate that replaced the old
// hand-mirroring hazard: a server schema change the client does not satisfy now fails
// `npm run typecheck` instead of surfacing as a runtime toast in the operator's face
// ("Couldn't finish: sessionId: Required").
//
// The gate only works while this module stays importable from a NODE program with no DOM lib and no
// browser globals. So: `import type` only, no runtime imports, no `location`/`fetch`/`window`, and
// nothing but the `PROCEDURES` data table as a value. Transport concerns (fetch, RpcCallOpts, the
// Proxy) live in rpc.ts, which is browser-only and never enters the server program.
import type {
  BoardSnapshot,
  Settings,
  DispatchInput,
  AdoptThreadInput,
  AdoptThreadResult,
  FollowUpInput,
  ConfirmAwaitingInput,
  RenameThreadInput,
  AiRenameThreadResult,
  SetThreadPermissionInput,
  SetThreadPermissionResult,
  ThreadProfileOptionsInput,
  ThreadProfileOptionsResult,
  SetThreadProfileInput,
  SetThreadProfileResult,
  SetThreadSnoozeInput,
  TranscriptMessage,
  TranscriptPage,
  TranscriptEarlierInput,
  GithubStatus,
  GithubItem,
  GithubBatchInput,
  GithubBatchResult,
  CodexModel,
  QuotaSnapshot,
  AuthSnapshot,
  AccountLogoutInput,
  AccountLogoutResult,
  AccountLoginStartInput,
  AccountLoginStartResult,
  AccountLoginStatusInput,
  AccountLoginStatusResult,
  DispatchPreferences,
  SetDispatchPreferenceInput,
  ListInteractionsInput,
  ListInteractionsResult,
  GetInteractionInput,
  GetInteractionResult,
  ResolveInteractionInput,
  ResolveInteractionResult,
  CancelInteractionInput,
  CancelInteractionResult,
  CompletionHold,
} from "@fray-ui/shared"

// Per-call transport options — declared here (not in rpc.ts) only because two procedures name it in
// their signature. It is a CLIENT-side extension: the drift gate compares `Parameters<…>[0]`, so an
// extra trailing optional argument is deliberately invisible to it.
export interface RpcCallOpts {
  signal?: AbortSignal
}

export interface Api {
  board(): Promise<BoardSnapshot>
  threadBody(input: { slug: string }): Promise<{ markdown: string }>
  threadTranscript(input: { slug: string }): Promise<TranscriptPage>
  threadTranscriptEarlier(input: TranscriptEarlierInput): Promise<TranscriptPage>
  subAgentTranscript(input: { slug: string; id: string }): Promise<{ messages: TranscriptMessage[]; state: "running" | "stale" | "done" | "gone" }>
  backgroundShellOutput(input: { slug: string; id: string }): Promise<{ command: string | null; output: string; truncated: boolean; state: "running" | "done" | "gone" }>
  // The × on a live sub-agent / background-shell row: retire the op from tracking. `dismissed:false`
  // when the id is no longer live (already gone).
  dismissBackgroundOp(input: { slug: string; id: string }): Promise<{ dismissed: boolean }>
  // Scoped typed requests are read/answered only for the current registered session. There is
  // deliberately no browser create method: provider adapters alone can journal a request.
  pendingInteractions(input: ListInteractionsInput): Promise<ListInteractionsResult>
  interactionGet(input: GetInteractionInput): Promise<GetInteractionResult>
  interactionResolve(input: ResolveInteractionInput): Promise<ResolveInteractionResult>
  interactionCancel(input: CancelInteractionInput): Promise<CancelInteractionResult>
  dispatch(input: DispatchInput): Promise<{ slug: string; sessionId: string }>
  adoptThread(input: AdoptThreadInput): Promise<AdoptThreadResult>
  followUp(input: FollowUpInput): Promise<void>
  setThreadPermission(input: SetThreadPermissionInput): Promise<SetThreadPermissionResult>
  threadProfileOptions(input: ThreadProfileOptionsInput): Promise<ThreadProfileOptionsResult>
  setThreadProfile(input: SetThreadProfileInput): Promise<SetThreadProfileResult>
  markRead(input: { slug: string }): Promise<void>
  // Opening a thread records read/seen telemetry only. Queue membership is lifecycle-driven and is
  // never cleared by viewing a resting thread. No-op for a foreign thread (no registry row).
  threadSeen(input: { slug: string }): Promise<void>
  // The ONLY writer of a session thread's open|archived lifecycle (the done fence mutates nothing).
  setThreadState(input: { slug: string; state: "open" | "archived" }): Promise<void>
  // Completes an inactive session immediately. A live provider shell reports that confirmation is
  // required; the caller must opt into its termination before the row can move to Done. `hold` carries
  // WHY it declined — the executing turn and/or the named live sub-agents/shells — for the dialog to name.
  // `sessionId` binds the click to the session the tab was looking at: a stale tab fails closed rather
  // than completing whatever now owns the slug.
  completeThread(input: { slug: string; sessionId: string; terminateLive?: boolean }): Promise<{ needsConfirmation: boolean; hold?: CompletionHold }>
  setThreadSnooze(input: SetThreadSnoozeInput): Promise<void>
  // Event-snooze the awaiting-background card: hide it until the thread's own background work returns
  // (the parent comes to a NEW rest). No deadline and no scheduler — the board re-surfaces it the moment
  // rested_at advances. `sessionId` binds the click to the session the tab was looking at.
  snoozeAwaitingBackground(input: { slug: string; sessionId: string }): Promise<void>
  // An awaiting fence is only a PROPOSAL — confirming binds ONE exact final-message generation to
  // durable state (the scheduled bump / the operator-confirmed wait).
  confirmAwaiting(input: ConfirmAwaitingInput): Promise<void>
  // Hard-delete: drop a stalled/exited phantom's registry row and tombstone its transcript id.
  // Refused for a genuinely live session — archive that one instead.
  forgetThread(input: { slug: string }): Promise<void>
  // A plan artifact's markdown (.fray/plans/*.md); `path` is a PlanView.path from the board snapshot.
  planBody(input: { path: string }): Promise<{ markdown: string }>
  // Hard-delete a plan artifact (.fray/plans/*.md). Secure-resolver gated server-side; idempotent.
  planDelete(input: { path: string }): Promise<void>
  // A session thread's scratchpad (.fray/threads/<session-id>/scratch.md) — read-only doc tab.
  threadScratchpad(input: { slug: string }): Promise<{ markdown: string }>
  // Server-authoritative, shell-safe provider resume command for a registered Fray-owned session.
  // A live Fray-owned runtime is deliberately unavailable: a second provider client is uncoordinated.
  threadTerminalCommand(input: { slug: string }): Promise<{ command: string | null; mode: "resume" | "unavailable"; reason: string | null }>
  openExternal(input: { url: string }): Promise<void>
  openLocalFile(input: { path: string; image?: boolean }): Promise<{ action: "opened" | "copy"; path: string }>
  // Classify path references (as they appear in inline code) → canonical openable path, or null when the
  // candidate doesn't resolve to a real file under the server's openable roots. Drives clickable inline code.
  resolveLocalPaths(input: { paths: string[] }): Promise<{ resolved: { input: string; path: string | null }[] }>
  markComplete(input: { slug: string }): Promise<void>
  setThreadStatus(input: { slug: string; status: "active" | "planning" | "planned" | "needs-human" | "blocked" | "done" | "dismissed" }): Promise<void>
  dismissThread(input: { slug: string }): Promise<void>
  repairThread(input: { file: string }): Promise<{ slug: string }>
  archiveThread(input: { slug: string }): Promise<void>
  killAgent(input: { slug: string }): Promise<void>
  renameThread(input: RenameThreadInput): Promise<void>
  aiRenameThread(input: { slug: string }): Promise<AiRenameThreadResult>
  // The selectable Codex models + per-model effort options, read server-side from the authoritative
  // ~/.codex/models_cache.json (never a hand-maintained list). The model picker's Codex section and its
  // effort dropdown are driven by this; a tiny client fallback covers the loading/no-cache state.
  codexModels(): Promise<CodexModel[]>
  // Provider subscription quota (5h + weekly windows) for the sidebar status bar. `force` bypasses
  // the shared freshness window for an explicit user recheck.
  quota(input?: { force?: boolean }, opts?: RpcCallOpts): Promise<QuotaSnapshot>
  // Per-provider LOCAL credential presence for the new-thread dispatch gate. Distinct from quota's
  // overloaded "unavailable" — reports only whether a credential exists. Never rejects.
  authStatus(input?: undefined, opts?: RpcCallOpts): Promise<AuthSnapshot>
  accountLogout(input: AccountLogoutInput): Promise<AccountLogoutResult>
  // Slice B login utility: start/attach/inspect/cancel the restricted `claude auth login` terminal.
  accountLoginStart(input: AccountLoginStartInput): Promise<AccountLoginStartResult>
  accountLoginStatus(input: AccountLoginStatusInput): Promise<AccountLoginStatusResult>
  accountLoginCancel(input: AccountLoginStatusInput): Promise<Record<never, never>>
  settingsGet(): Promise<Settings>
  settingsSet(input: Settings): Promise<Settings>
  // Takes an empty object, not nothing: the router declares `input: z.object({})` (a mutation always
  // has an input schema), and the transport posts `{}` for it.
  settingsReset(input: Record<never, never>): Promise<Settings>
  dispatchPreferencesGet(): Promise<DispatchPreferences>
  dispatchPreferenceSet(input: SetDispatchPreferenceInput): Promise<DispatchPreferences>
  // The shipped GitHub batch-dispatch prompt templates — the Settings UI prefills its editors from
  // these and resets to them (an empty githubIssuePrompt/githubPrPrompt setting = the server default).
  githubPromptDefaults(): Promise<{ issue: string; pr: string }>
  // GitHub-first batch dispatch. Detection (installed/inRepo/nameWithOwner) is cached server-side;
  // `authed` is re-checked live per call. githubList reads the repo's issues/PRs; githubDispatchBatch
  // hydrates each selected item fresh + spins up one thread per item (sequential, reuses dispatch).
  githubStatus(): Promise<GithubStatus>
  githubList(input: { kind: "issues" | "prs"; sort: "recent" | "reactions"; limit?: number }): Promise<{ items: GithubItem[] }>
  githubDispatchBatch(input: GithubBatchInput): Promise<GithubBatchResult>
}

export type ProcType = "query" | "mutation"

// The GET-vs-POST decision for every procedure. It drifts exactly as silently as the types do — a
// query flipped to a mutation server-side turns every client call into a 404/405 — so the same gate
// compares this table against each procedure's `_tag`. `as const` keeps the literal types the gate
// needs; the `satisfies` keeps it exhaustive over `Api`.
export const PROCEDURES = {
  board: "query",
  threadBody: "query",
  threadTranscript: "query",
  threadTranscriptEarlier: "query",
  subAgentTranscript: "query",
  backgroundShellOutput: "query",
  dismissBackgroundOp: "mutation",
  pendingInteractions: "query",
  interactionGet: "query",
  interactionResolve: "mutation",
  interactionCancel: "mutation",
  dispatch: "mutation",
  adoptThread: "mutation",
  followUp: "mutation",
  setThreadPermission: "mutation",
  threadProfileOptions: "query",
  setThreadProfile: "mutation",
  markRead: "mutation",
  threadSeen: "mutation",
  setThreadState: "mutation",
  completeThread: "mutation",
  setThreadSnooze: "mutation",
  snoozeAwaitingBackground: "mutation",
  confirmAwaiting: "mutation",
  forgetThread: "mutation",
  planBody: "query",
  planDelete: "mutation",
  threadScratchpad: "query",
  threadTerminalCommand: "query",
  openExternal: "mutation",
  openLocalFile: "mutation",
  resolveLocalPaths: "query",
  markComplete: "mutation",
  setThreadStatus: "mutation",
  dismissThread: "mutation",
  repairThread: "mutation",
  archiveThread: "mutation",
  killAgent: "mutation",
  renameThread: "mutation",
  aiRenameThread: "mutation",
  codexModels: "query",
  quota: "query",
  authStatus: "query",
  accountLogout: "mutation",
  accountLoginStart: "mutation",
  accountLoginStatus: "query",
  accountLoginCancel: "mutation",
  settingsGet: "query",
  settingsSet: "mutation",
  settingsReset: "mutation",
  dispatchPreferencesGet: "query",
  dispatchPreferenceSet: "mutation",
  githubPromptDefaults: "query",
  githubStatus: "query",
  githubList: "query",
  githubDispatchBatch: "mutation",
} as const satisfies Record<keyof Api, ProcType>
