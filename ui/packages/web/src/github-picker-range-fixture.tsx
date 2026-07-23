import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, CodexModel, DispatchPreferences, GithubItem } from "@fray-ui/shared"
import { GithubPickerModal } from "./components/GithubPickerModal.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Drives the REAL GitHub picker against a stubbed /rpc seam (same idiom as
// dispatch-composer-profile-fixture) so shift-click range selection can be exercised in a real
// browser: real React state, real rows, real mouse events. 24 rows — more than the picker's
// MAX_BATCH of 20 — so a single shift-click can also prove the per-batch cap truncates the range
// instead of silently overshooting. Row numbers are deliberately NON-contiguous and descending, which
// is what the list really looks like, and it catches any code that confuses a row's key with its index.
const NUMBERS = [412, 409, 407, 400, 398, 395, 390, 388, 381, 377, 370, 366, 361, 359, 352, 348, 344, 340, 337, 333, 330, 328, 321, 318]

const items: GithubItem[] = NUMBERS.map((number, i) => ({
  kind: "issue",
  number,
  title: `Fixture issue ${number} — an issue title long enough to truncate in the row`,
  url: `https://github.com/fixture/repo/issues/${number}`,
  state: "OPEN",
  author: i % 3 === 0 ? "octocat" : "hubot",
  createdAt: new Date(Date.now() - (i + 1) * 3 * 60 * 60 * 1000).toISOString(),
  updatedAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000).toISOString(),
  labels: i % 4 === 0 ? [{ name: "bug", color: "d73a4a" }] : [],
  comments: (i * 3) % 7,
  reactions: (i * 5) % 11,
}))

const codexModels: CodexModel[] = []
const preferences: DispatchPreferences = {
  backend: "claude",
  claude: { model: "opus", effort: "high", permissionMode: "auto" },
  codex: { permissionMode: "default" },
} as DispatchPreferences

const dispatched: unknown[] = []

declare global {
  interface Window { githubPickerRangeFixture?: { dispatched: unknown[] } }
}
window.githubPickerRangeFixture = { dispatched }

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.origin)
  if (url.pathname === "/rpc/githubStatus") return json({ inRepo: true, authed: true, nameWithOwner: "fixture/repo" })
  if (url.pathname === "/rpc/githubList") return json({ items })
  if (url.pathname === "/rpc/codexModels") return json(codexModels)
  if (url.pathname === "/rpc/dispatchPreferencesGet") return json(preferences)
  if (url.pathname === "/rpc/githubDispatchBatch") {
    // Isolated seam: the fixture never starts a worker. It records the payload so a test can assert
    // that what dispatches is exactly what the human watched themselves check.
    dispatched.push(JSON.parse(String(init?.body ?? "{}")))
    return json({ dispatched: [], failed: [] })
  }
  return nativeFetch(input, init)
}

function json(result: unknown): Response {
  return new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json", "x-fray-boot": "fixture" } })
}

store.board = { projectDir: "/fixture/github-picker-range" } as BoardSnapshot

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <GithubPickerModal onClose={() => {}} />
    {/* Mounted so the cap's "N max per batch" toast is observable, exactly as it is in the app. */}
    <Toaster />
  </QueryClientProvider>,
)
