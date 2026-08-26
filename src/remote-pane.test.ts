import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudConfig } from "./cloud.ts";
import { createRemotePane } from "./remote-pane.ts";

function fakeOutput() {
  const chunks: string[] = [];
  return {
    stream: { write: (chunk: string) => { chunks.push(chunk); return true; } } as unknown as NodeJS.WriteStream,
    text: () => chunks.join(""),
    reset: () => { chunks.length = 0; },
  };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function build(overrides: Partial<Parameters<typeof createRemotePane>[0]> = {}) {
  const out = fakeOutput();
  let current: CloudConfig | null = null;
  const applied: Array<CloudConfig | null> = [];
  const pane = createRemotePane({
    port: 9393,
    current: () => current,
    apply: async (next) => { applied.push(next); current = next; },
    claim: async (name) => ({ hostname: `${name}.frizz.sh`, claim: name, serve: "relay" }),
    issueLink: () => (current ? { code: "c0de", url: `https://${current.hostname}/?frizz_code=c0de`, expiresAt: Date.now() + 300_000 } : null),
    probes: {
      github: async () => ({ installed: true, login: "ada" }),
      cloudflared: async () => ({ version: "2025.8.1" }),
      tailscale: async () => ({ installed: true, dnsName: "mac-mini.corgi-alpha.ts.net" }),
    },
    output: out.stream,
    ...overrides,
  });
  const type = (text: string) => { for (const ch of text) pane.key(ch); };
  return { pane, out, applied, type, current: () => current };
}

test("R opens the chooser with every setup, and Off applies loopback-only", async () => {
  const { pane, out, applied } = build();
  assert.equal(pane.open(), true);
  for (const title of ["frizz.sh name", "Cloudflare Tunnel", "Tailscale", "Something else", "Off"]) assert.match(out.text(), new RegExp(title));
  assert.match(out.text(), /Off.*\(current\)/s);
  pane.key("5");
  assert.equal(pane.key("\r"), "keep");
  await settle();
  assert.deepEqual(applied, [null]);
  assert.match(out.text(), /Loopback only/);
  // The done screen closes on any key.
  assert.equal(pane.key("x"), "close");
});

test("Cloudflare Tunnel asks for the hostname and the tunnel, then serves them", async () => {
  const { pane, out, applied, type } = build();
  pane.open();
  pane.key("2");
  pane.key("\r");
  await settle();
  assert.match(out.text(), /cloudflared tunnel route dns my-board board\.example\.com/);
  assert.match(out.text(), /cloudflared\s+found, 2025\.8\.1 ✓/);
  type("board.example.com");
  pane.key("\r"); // next field
  type("my-board");
  pane.key("\r"); // submit
  await settle();
  assert.deepEqual(applied, [{ hostname: "board.example.com", tunnel: "my-board" }]);
  assert.match(out.text(), /Serving https:\/\/board\.example\.com \(Cloudflare Tunnel\)/);
  assert.match(out.text(), /frizz_code=c0de/);
});

test("Tailscale offers this machine's MagicDNS name and saves an external origin", async () => {
  const { pane, out, applied } = build();
  pane.open();
  pane.key("3");
  pane.key("\r");
  await settle();
  assert.match(out.text(), /tailscale serve --bg 9393/);
  assert.match(out.text(), /https:\/\/mac-mini\.corgi-alpha\.ts\.net/);
  pane.key("\r"); // accept the placeholder
  await settle();
  assert.deepEqual(applied, [{ hostname: "mac-mini.corgi-alpha.ts.net", serve: "external", provider: "tailscale" }]);
});

test("a frizz.sh name is claimed for the signed-in account, and a failure goes back to the form", async () => {
  const claims: string[] = [];
  const { pane, out, applied, type } = build({
    claim: async (name) => {
      claims.push(name);
      if (name === "taken") throw new Error("that name is taken");
      return { hostname: `${name}.frizz.sh`, claim: name, serve: "relay" };
    },
  });
  pane.open();
  pane.key("1"); // the cursor starts on the current setup (Off), so pick frizz.sh explicitly
  pane.key("\r");
  await settle();
  assert.match(out.text(), /signed in as ada ✓/);
  type("taken");
  pane.key("\r");
  await settle();
  assert.match(out.text(), /Could not apply that: that name is taken/);
  assert.equal(pane.key("x"), "keep"); // back to the form
  for (let i = 0; i < 5; i++) pane.key("\x7f");
  type("ada");
  pane.key("\r");
  await settle();
  assert.deepEqual(claims, ["taken", "ada"]);
  assert.deepEqual(applied, [{ hostname: "ada.frizz.sh", claim: "ada", serve: "relay" }]);
  assert.match(out.text(), /Serving https:\/\/ada\.frizz\.sh \(frizz\.sh\)/);
});

test("escape leaves a form for the menu, and leaves the menu for the readout", () => {
  const { pane } = build();
  pane.open();
  pane.key("4");
  pane.key("\r");
  assert.equal(pane.key("\x1b"), "keep");
  assert.equal(pane.key("\x1b"), "close");
});

test("under --sandbox the frizz.sh screen says a claim is real, and the others say nothing", async () => {
  const { pane, out } = build({ sandbox: true });
  pane.open();
  pane.key("1");
  pane.key("\r");
  await settle();
  assert.match(out.text(), /This is a sandbox, but a claim is real/);
  pane.key("\x1b");
  out.reset();
  pane.key("4");
  pane.key("\r");
  assert.doesNotMatch(out.text(), /claim is real/);
});
