// TEST-BRANCH helper (windows-test): run the dev entry with plain node instead of nub.
//
// nub is the maintainer's runner and is not on npm, so an outside contributor cannot run
// `pnpm dev` as shipped. Plain node 22.7+ can transform the TypeScript itself, but the flag has
// to reach every child too: dev-supervisor.ts forks its control-plane child with execArgv: [],
// and the broker daemons are spawned as their own `node <file>` processes. NODE_OPTIONS is the
// one channel all of them inherit. The Claude Agent SDK strips NODE_OPTIONS before it spawns the
// provider CLI, which is exactly right — claude must not inherit a host loader flag.
import { spawn } from "node:child_process"

const env = { ...process.env }
env.NODE_OPTIONS = [env.NODE_OPTIONS, "--experimental-transform-types"].filter(Boolean).join(" ")
const child = spawn(process.execPath, ["packages/server/src/dev.ts"], { stdio: "inherit", env })
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
