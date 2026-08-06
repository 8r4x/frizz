import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./styles.css"

// STATUS-BAR FIXTURE — the top-left bar in its FULLY POPULATED state, which no sandboxed stack can
// produce: an adhoc stack has no restart-capable supervisor (so the reload button renders null) and no
// provider credentials under its temp HOME (so both quota chips sit on the loading placeholder
// forever). Stubbing the three reads the bar depends on is the only way to actually LOOK at the
// finished thing: identity + connection + settings + reload + two live quota percentages on one line.
//
// Query params drive the states worth eyeballing:
//   ?state=low        — Claude in the amber warn zone, Codex critical
//   ?state=weeklywall — a HEALTHY 5h window behind a nearly-spent weekly one. The chip must still read
//                       the 5h number; this is the state where the old "swap to the tightest window"
//                       headline used to hijack it and show the weekly figure instead.
//   ?state=signedout  — Codex signed out (em dash + Sign in popover, and NO account line)
//   ?state=longemail  — an account address past the popover's width, to check the truncation
//   ?connection=closed|connecting
//   ?identity=loading|unavailable

const params = new URLSearchParams(window.location.search)
const state = params.get("state") ?? "healthy"
const nowSeconds = Math.floor(Date.now() / 1000)

function windows(fiveHourUsed: number, weeklyUsed: number) {
  return [
    { key: "5h", label: "5h", usedPercent: fiveHourUsed, resetsAt: nowSeconds + 2 * 3600 },
    { key: "weekly", label: "Weekly", usedPercent: weeklyUsed, resetsAt: nowSeconds + 3 * 86400 },
  ]
}

const quota =
  state === "low"
    ? {
        claude: { status: "ok", planType: "max", windows: windows(82, 64) },
        codex: { status: "ok", planType: "pro", windows: windows(95, 71) },
      }
    : state === "weeklywall"
      ? {
          claude: { status: "ok", planType: "max", windows: windows(18, 93) },
          codex: { status: "ok", planType: "pro", windows: windows(24, 88) },
        }
      : {
          claude: { status: "ok", planType: "max", windows: windows(17, 38) },
          codex: { status: "ok", planType: "pro", windows: windows(41, 29) },
        }

// `emails` is the account each credential belongs to — the popover's "signed in as who?" line. A
// signed-out provider carries none (the server omits it rather than leave a stale label under an em
// dash), and ?state=longemail pins the truncation at the popover's 15rem cap.
const emails =
  state === "signedout"
    ? { claude: "colin@pullfrog.com" }
    : state === "longemail"
      ? { claude: "colin.mcdonnell.with.a.long.name@some-long-company-domain.example.com", codex: "colinmcd94@gmail.com" }
      : { claude: "colin@pullfrog.com", codex: "colinmcd94@gmail.com" }

const auth =
  state === "signedout"
    ? { claude: "authed", codex: "signed-out", emails }
    : { claude: "authed", codex: "authed", emails }

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  if (url.pathname === "/_frizz/control/status") return json({ protocol: 1, state: "ready", updateRestart: true })
  // Every RPC response is the {result} envelope, never the payload bare.
  if (url.pathname === "/_frizz/rpc/quota") return json({ result: quota })
  if (url.pathname === "/_frizz/rpc/authStatus") return json({ result: auth })
  if (url.pathname === "/_frizz/rpc/settingsGet") return json({ result: {} })
  return nativeFetch(input, init)
}

const { StatusBar } = await import("./components/StatusBar.tsx")
const { projectIdentity } = await import("./components/Sidebar.tsx")

const identityMode = params.get("identity")
const identity = projectIdentity(
  identityMode === "loading" ? null : { projectLabel: identityMode === "unavailable" ? "frizz" : "colinhacks/frizz" },
)
const connection = (params.get("connection") ?? "open") as "open" | "connecting" | "closed"

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <main className="min-h-screen bg-bg text-fg">
      <StatusBar identity={identity} connection={connection} />
      {/* A stand-in for the page body, so the bar is judged against real content, not a void. */}
      <div className="px-4 pt-16 text-[13px] text-muted">Page content sits below the bar.</div>
    </main>
  </QueryClientProvider>,
)
