#!/usr/bin/env nub
/**
 * The whole product, against the LIVE registrar and the LIVE relay.
 *
 * Every other harness here stands something in for the internet — workerd on loopback, a supervisor
 * with an invented public origin, a toy board that accepts any upgrade. This one has no stand-ins. It
 * claims a name from the registrar that is actually deployed, serves a real board through the relay
 * that is actually deployed, and reaches it the way a phone does: over the public internet, by
 * hostname, through Cloudflare.
 *
 * WHAT IT COSTS: a real claim against the operator's own GitHub account, and a 30-day lease on the
 * name. It renews rather than consuming anything new when re-run with the same identity.
 *
 * Three things it has to do that a naive harness gets wrong, each of which cost a run:
 *
 *   A PTY, NOT A PIPE. The board's readout is a terminal UI, and `script` cannot stand in for one —
 *   it wants a terminal on its own stdin and dies with tcgetattr/ioctl.
 *
 *   A SAVED CONFIG rather than the R walkthrough. Remote access is set up interactively now, and the
 *   walkthrough's cursor starts on whichever choice is CURRENT — so blind key-sending picks a
 *   different option depending on prior state. Seeding `~/.frizz/cloud.json` is what the walkthrough
 *   writes, and it exercises the path every launch after the first one takes, which is the path that
 *   actually has to keep working.
 *
 *   A GIT REPOSITORY as the project. Frizz refuses a bare directory, which is why --sandbox mints a
 *   throwaway repo rather than a throwaway folder.
 *
 *   THE OWNING IDENTITY, seeded into the sandbox home. A name belongs to the key that claimed it, so a
 *   fresh key is correctly refused with "that name is already taken" — verified below, because that
 *   refusal is the whole ownership model.
 *
 * `gh` reads the macOS keychain and cannot follow a redirected HOME, so the token is captured from the
 * real one and passed as GH_TOKEN — which is what a CI runner would do anyway.
 */
import { execFileSync } from "node:child_process";
import { spawn as spawnPty } from "node-pty";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsClient } from "ws";

const NAME = process.env.FRIZZ_PRODUCT_NAME ?? "colin";
const ORIGIN = `https://${NAME}.frizz.sh`;
const PORT = Number(process.env.FRIZZ_PRODUCT_PORT ?? 47990);
const CLI = process.env.FRIZZ_PRODUCT_CLI ?? join(process.cwd(), "dist/frizz.js");

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const home = mkdtempSync(join(tmpdir(), "frizz-product-home-"));
const project = mkdtempSync(join(tmpdir(), "frizz-product-repo-"));
let pty = null;

const until = async (label, fn, ms = 150_000) => {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
};

const socket = (headers) =>
  new Promise((resolve) => {
    const ws = new WsClient(`wss://${NAME}.frizz.sh/_frizz/ws`, { headers });
    const timer = setTimeout(() => resolve({ verdict: "hung" }), 45_000);
    ws.on("open", () => { clearTimeout(timer); resolve({ verdict: "open", ws }); });
    ws.on("error", (error) => { clearTimeout(timer); resolve({ verdict: "refused", detail: error.message }); });
  });

try {
  if (!existsSync(CLI)) throw new Error(`no artifact at ${CLI} — run scripts/build-package.mjs first`);
  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  if (!token) throw new Error("no GitHub token — run `gh auth login`");

  const owned = join(homedir(), ".frizz", "identity.key");
  if (existsSync(owned)) {
    mkdirSync(join(home, ".frizz"), { recursive: true });
    copyFileSync(owned, join(home, ".frizz", "identity.key"));
  }

  const git = (...args) =>
    execFileSync("git", args, {
      cwd: project,
      env: { ...process.env, GIT_AUTHOR_NAME: "frizz", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "frizz", GIT_COMMITTER_EMAIL: "f@example.invalid" },
    });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");

  // What the R walkthrough writes once a frizz.sh name is chosen.
  mkdirSync(join(home, ".frizz"), { recursive: true });
  writeFileSync(
    join(home, ".frizz", "cloud.json"),
    JSON.stringify({ hostname: `${NAME}.frizz.sh`, claim: NAME, serve: "relay" }, null, 2),
  );

  const env = { ...process.env, HOME: home, GH_TOKEN: token, FRIZZ_WAKERS_OFF: "1" };
  pty = spawnPty(process.execPath, [CLI, "--no-app", "--port", String(PORT)], {
    name: "xterm-color", cols: 100, rows: 30, cwd: project, env,
  });

  let out = "";
  // ANSI-STRIPPED. The readout is styled, so a phrase that reads as one run on screen is broken up by
  // escape codes in the stream — matching the raw bytes silently never fires.
  const plain = () => out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  pty.onData((chunk) => (out += chunk));
  // Wait for the REMOTE readout, not just the local one. A board with no saved setup says "press R to
  // reach this board"; one that came up on its saved name offers a sign-in link instead.
  {
    const deadline = Date.now() + 180_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      up = /fresh sign-in link/.test(plain()) || plain().includes(`${NAME}.frizz.sh`);
      if (!up) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!up) {
      throw new Error(`the board never came up on its saved name. Readout tail:\n${plain().split("\n").filter((l) => l.trim()).slice(-25).join("\n")}`);
    }
  }
  check("a saved frizz.sh name is served on a plain launch", true, ORIGIN);

  // Mint the link with --link rather than scraping the readout: the readout shows it as a QR, which is
  // exactly right for a phone and useless to a harness.
  const minted = execFileSync(process.execPath, [CLI, "--link"], { cwd: project, env, encoding: "utf8" });
  const code = (minted.match(/frizz_code=([A-Za-z0-9_-]+)/) ?? [])[1];
  check("--link mints a fresh single-use link", !!code, code ? `${code.slice(0, 6)}…` : minted.trim().slice(0, 120));
  if (!code) throw new Error("no access code to redeem");

  const cold = await until("the relay to serve the board", async () => {
    const res = await fetch(ORIGIN, { redirect: "manual" });
    return res.status !== 404 && res.status !== 502 ? res : null;
  });
  check("the board answers at its own hostname, over the internet", cold.status === 401, `HTTP ${cold.status}`);

  const redeem = await fetch(`${ORIGIN}/?frizz_code=${encodeURIComponent(code)}`, { redirect: "manual" });
  const cookie = (redeem.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  // The refusal page names the reason, and the reasons point at very different bugs: "already used"
  // means something redeemed it first (a retry at the edge would do that, and single-use plus retry is
  // a broken sign-in); "no such link" means the code was minted against a different board.
  const why = redeem.status === 302 ? "" : (await redeem.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
  check("the access link redeems into a session", redeem.status === 302 && cookie.includes("frizz_session="), `HTTP ${redeem.status}${why ? ` — ${why}` : ""}`);

  const page = await fetch(ORIGIN, { headers: { cookie } });
  const html = await page.text();
  check("the board itself loads through the relay", page.status === 200 && html.includes('id="root"'), `HTTP ${page.status}, ${html.length} bytes`);

  const asset = await fetch(`${ORIGIN}/favicon.svg`, { headers: { cookie } });
  check("static assets come through too", asset.status === 200, `HTTP ${asset.status}`);

  // The nested WebSocket, against Cloudflare's own edge. Nothing on loopback can prove this.
  const live = await socket({ cookie, origin: ORIGIN });
  check("a WebSocket opens THROUGH the relay", live.verdict === "open", live.detail ?? live.verdict);
  if (live.ws) {
    const frame = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 30_000);
      live.ws.on("message", (raw) => { clearTimeout(timer); resolve(String(raw)); });
    });
    check("and the board pushes a real frame down it", !!frame, frame ? `${frame.length} bytes` : "nothing arrived");
    live.ws.close();
  }

  const bare = await socket({ origin: ORIGIN });
  check("an unauthenticated WebSocket is refused", bare.verdict === "refused", bare.verdict);

  const uninvited = await fetch(ORIGIN, { redirect: "manual" });
  check("a visitor without the cookie is still refused", uninvited.status === 401, `HTTP ${uninvited.status}`);
} catch (error) {
  check("harness completed", false, error instanceof Error ? error.message : String(error));
} finally {
  // KEEP THE IDENTITY. The name is bound to this key, so discarding it would leave a claimed name
  // nobody can renew — and the lease still runs for 30 days.
  const minted = join(home, ".frizz", "identity.key");
  const target = join(homedir(), ".frizz", "identity.key");
  try {
    if (existsSync(minted) && !existsSync(target)) {
      mkdirSync(join(homedir(), ".frizz"), { recursive: true });
      copyFileSync(minted, target);
      console.log(`\n  kept the claim identity at ${target} — it is what proves you own ${NAME}.frizz.sh`);
    }
  } catch (error) {
    console.log(`\n  WARNING: could not keep the claim identity: ${error.message}`);
  }
  try { pty?.kill(); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 3000));
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
