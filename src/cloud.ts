import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `frizz up` — one command for "start the server and reach it from anywhere".
 *
 * Before this, reaching a board from a phone meant two terminals and three flags: a launch with
 * `--public-origin https://…`, a separate `cloudflared tunnel … run …` in another window, and
 * remembering that closing either one silently breaks the phone. Nothing about that is discoverable,
 * and getting it wrong produces either "Forbidden" or a Cloudflare error with no hint which half died.
 *
 * So the tunnel becomes a supervised CHILD of the board. One process to start, one to stop, and the two
 * halves cannot drift out of sync because they share a lifetime.
 *
 * Deliberately does NOT ask about the port. There is a default, and `FRIZZ_PORT` overrides it for the
 * few people who care — a prompt for it would be a question almost nobody has an answer to.
 *
 * NOTE: this runs a tunnel the operator ALREADY OWNS. It does not create one, and it cannot: creating a
 * tunnel and its DNS record needs a zone-scoped Cloudflare token, which can never live on a user's
 * machine. Self-service is Stage 2 in plans/hosted-frizz-service.md.
 */

export interface CloudConfig {
  /** The public hostname, e.g. `colin.frizz.sh`. Stored without a scheme; it is always https. */
  hostname: string;
  /** The cloudflared tunnel name to run. */
  tunnel: string;
  /** Optional explicit cloudflared config path; defaults beside the others in ~/.cloudflared. */
  config?: string;
}

export function cloudConfigPath(home = homedir()): string {
  return join(home, ".frizz", "cloud.json");
}

export function readCloudConfig(home = homedir()): CloudConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(cloudConfigPath(home), "utf8")) as Partial<CloudConfig>;
    if (typeof parsed.hostname !== "string" || typeof parsed.tunnel !== "string") return null;
    if (!parsed.hostname || !parsed.tunnel) return null;
    return { hostname: parsed.hostname, tunnel: parsed.tunnel, ...(parsed.config ? { config: parsed.config } : {}) };
  } catch {
    return null;
  }
}

export function writeCloudConfig(config: CloudConfig, home = homedir()): void {
  const path = cloudConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Strip a scheme, path or trailing dot someone pastes in, so `https://x.dev/` and `x.dev` both work. */
export function normalizeHostname(raw: string): string {
  const trimmed = raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!trimmed || !trimmed.includes(".")) {
    throw new Error(`invalid hostname: ${raw} (expected something like colin.frizz.sh)`);
  }
  return trimmed.toLowerCase();
}

/**
 * Ask once, remember forever. Asked only when there is no saved config and no explicit hostname —
 * the whole point is that the second run of `up` is a single word.
 */
export async function promptForCloudConfig(): Promise<CloudConfig> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hostname = normalizeHostname(await rl.question("Public hostname for this board (e.g. colin.frizz.sh): "));
    // The tunnel usually shares the hostname's first label, which is what `cloudflared tunnel create`
    // encourages — offer that rather than making them look it up.
    const suggested = hostname.split(".")[0]!;
    const answer = (await rl.question(`cloudflared tunnel name [${suggested}]: `)).trim();
    return { hostname, tunnel: answer || suggested };
  } finally {
    rl.close();
  }
}

/** Where cloudflared's config for this tunnel lives, unless the operator named one. */
export function resolveTunnelConfigPath(config: CloudConfig, home = homedir()): string | null {
  if (config.config) return config.config;
  const candidate = join(home, ".cloudflared", "frizz.yml");
  return existsSync(candidate) ? candidate : null;
}

export interface TunnelHandle {
  child: ChildProcess;
  stop: () => void;
}

/**
 * Run the tunnel as a child of this launcher.
 *
 * Its stdout is deliberately swallowed except for failures: cloudflared is chatty (four "Registered
 * tunnel connection" lines plus QUIC noise) and interleaving that with the board readout makes both
 * unreadable. What matters is whether it came up, and that is reported by the caller.
 */
export function startTunnel(
  config: CloudConfig,
  onExit: (code: number | null) => void,
  onError: (message: string) => void,
  home = homedir(),
): TunnelHandle {
  const configPath = resolveTunnelConfigPath(config, home);
  const args = [
    "tunnel",
    ...(configPath ? ["--config", configPath] : []),
    "--no-autoupdate",
    "run",
    config.tunnel,
  ];
  const child = spawn("cloudflared", args, { stdio: ["ignore", "pipe", "pipe"] });
  // ENOENT arrives as an 'error' event, and an unhandled one on a ChildProcess THROWS — so without
  // this, `frizz up` on a machine without cloudflared crashed with a stack trace instead of saying
  // which program to install. That is the first thing a new user hits, so it is the last thing that
  // should be a crash.
  child.once("error", (error: NodeJS.ErrnoException) => {
    onError(
      error.code === "ENOENT"
        ? "cloudflared is not installed or not on PATH — install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        : `could not start cloudflared: ${error.message}`,
    );
  });
  child.once("exit", (code) => onExit(code));
  return {
    child,
    // SIGTERM rather than kill(): cloudflared drains its edge connections, which stops Cloudflare
    // serving a 530 to anyone mid-request while it goes away.
    stop: () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } },
  };
}
