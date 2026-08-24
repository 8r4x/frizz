import { createRoot } from "react-dom/client"
import { useSnapshot } from "valtio"
import "./styles.css"
import { store } from "./store.ts"

// The board ships in two fonts (html[data-font], applied before first paint in index.html), and a
// fixture that sets neither silently renders the MONO default — so make the choice explicit and
// switchable: ?font=mono for the mono stack, sans otherwise (the setting most real windows run).
const params = new URLSearchParams(window.location.search)
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
// ?versionless drops the registry launcher's version fields, i.e. the frizz-dev / legacy popover.
const versions = params.has("versionless") ? {} : { version: "0.4.2", updateVersion: "0.5.0" }

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  if (url.pathname === "/_frizz/control/status") {
    return new Response(JSON.stringify({ protocol: 1, state: "ready", updateRestart: true, ...versions }), {
      headers: { "content-type": "application/json" },
    })
  }
  if (url.pathname === "/_frizz/control/update-restart") {
    const requests = Number(window.sessionStorage.getItem("restartFixtureRequests") ?? "0") + 1
    window.sessionStorage.setItem("restartFixtureRequests", String(requests))
    await new Promise((resolve) => window.setTimeout(resolve, 1_000))
    return new Response(JSON.stringify({ protocol: 1, state: "restarting" }), {
      headers: { "content-type": "application/json" },
    })
  }
  return nativeFetch(input, init)
}

const { RestartFrizzButton } = await import("./components/RestartFrizzButton.tsx")
const { RestartOverlay } = await import("./components/RestartOverlay.tsx")

function Fixture() {
  const snap = useSnapshot(store)
  const restarting = snap.controlPlaneState === "restarting"
  return (
    <main className="min-h-screen bg-bg p-3 sm:p-8">
      <RestartOverlay open={restarting} message={snap.controlPlaneMessage} />
      <div inert={restarting}>
        {/* A focusable background control so QA can prove Tab cannot reach behind the scrim. */}
        <button type="button" data-testid="decoy" className="mb-4 rounded border border-border px-2 py-1">decoy</button>
        {/* Left-aligned, so the panel opens rightward off a `w-fit` wrapper exactly as it does off the
            status row above the prompt box, which is where this button really lives. */}
        <div className="w-fit"><RestartFrizzButton /></div>
      </div>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
