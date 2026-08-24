import { useState } from "react"
import { createRoot } from "react-dom/client"
import { Composer } from "./components/Composer.tsx"
import "./styles.css"

// Browser QA + e2e surface for the composer's SKILLS TYPEAHEAD (issue #21): a draft that is exactly
// one `/`-led token opens a menu of the thread's invocable skills above the box. The suggestion
// source is stubbed here — the real ThreadComposerBox wires it to the threadSkills RPC, whose
// server side has its own tests; this fixture proves the Composer half (trigger, filter, keyboard,
// accept, dismiss) against a list shaped like a real harness reply.
//
// `?font=mono` flips the app's font setting — this app renders in two fonts and a fixture that never
// sets `data-font` silently pins the mono default (see AGENTS.md).
const font = new URLSearchParams(location.search).get("font") ?? "sans"
document.documentElement.dataset.font = font

const SKILLS = [
  { name: "frizz-stack", description: "Boot a real, fully-isolated, disposable Frizz you can poke" },
  { name: "frizz:gh", description: "The gh-CLI playbook for a frizz worker signed into GitHub" },
  { name: "headless-browser", description: "Drive a local page in Chrome and capture it without putting a window on screen" },
  { name: "optical-spacing", description: "Space a row of small marks by the ink the eye reads instead of the boxes CSS lays out" },
  { name: "visual-review", description: "Judge and dial in the visual correctness of a UI change by measuring glyph ink" },
]

// Test hooks: how many times the composer asked for the list (must stay 1 across re-triggers), and
// every draft that reached submit (the popup's Enter must complete, not send).
const hooks = { fetches: 0, submitted: [] as string[], value: "" }
;(window as unknown as { __typeahead: typeof hooks }).__typeahead = hooks

function Fixture() {
  const [value, setValue] = useState("")
  hooks.value = value
  return (
    <div className="flex min-h-screen flex-col justify-end bg-bg p-10 text-fg">
      <div className="w-full max-w-[520px]">
        <Composer
          surface="chatComposer"
          value={value}
          onChange={setValue}
          onSubmit={() => {
            hooks.submitted.push(hooks.value)
            setValue("")
          }}
          placeholder="Reply…"
          slashSuggest={() => {
            hooks.fetches += 1
            return Promise.resolve(SKILLS)
          }}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
