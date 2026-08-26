import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Dev is served same-origin through the server's Vite middleware, so no proxy.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  // The browser e2e suite (scripts/e2e-web.mjs) boots this vite over a working tree other agents are
  // often editing mid-run. With the watcher on, each of those edits becomes an HMR update or full
  // reload in the middle of a test — a fixture that mounts its root at module top level re-evaluates
  // and the test fails on React's "createRoot() on a container that has already been passed to
  // createRoot()" console error, a flake with nothing behind it. The suite never edits files, so its
  // server neither watches nor pushes.
  ...(process.env.FRIZZ_E2E_STATIC_VITE ? { server: { hmr: false, watch: null } } : {}),
})
