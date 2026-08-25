import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  claimIdentityFromPrivateKey,
  exportClaimPrivateKey,
  exportClaimPublicKey,
  generateClaimIdentity,
} from "@frizz/shared";

/**
 * The keypair that owns this machine's `<name>.frizz.sh` names.
 *
 * There is no account behind a claimed name — the key IS the account, which is what lets the feature
 * exist without Frizz growing a login. Ownership moves the way an SSH key does: copy the file.
 */

/** One key per machine, beside the rest of Frizz's user-level state. */
export function claimIdentityPath(home = homedir()): string {
  return join(home, ".frizz", "identity.key");
}

/**
 * Load the identity, or mint one on first use.
 *
 * DELIBERATELY NOT the same policy as the session key, which replaces a corrupt file and moves on.
 * That is right there — the worst case is signing devices out. Here the worst case is that someone's
 * name silently stops being theirs, and they find out when a renewal is refused rather than at the
 * moment the file broke. So an unreadable key is an ERROR naming the file: it is recoverable from a
 * backup, and it must never be papered over by quietly generating a different identity.
 */
export async function loadOrCreateClaimIdentity(home = homedir()): Promise<CryptoKeyPair> {
  const path = claimIdentityPath(home);
  let stored: Buffer | undefined;
  try {
    stored = readFileSync(path);
  } catch {
    stored = undefined;
  }

  if (stored !== undefined) {
    const identity = await claimIdentityFromPrivateKey(new Uint8Array(stored));
    if (identity) return identity;
    throw new Error(
      `${path} is not a usable Frizz identity key. It is what proves you own your frizz.sh name, so it is not replaced automatically — restore it from a backup, or delete it to claim a new name.`
    );
  }

  const identity = await generateClaimIdentity();
  mkdirSync(dirname(path), { recursive: true });
  // 0600 before anything is written: a world-readable identity is a name anyone on the box can take.
  writeFileSync(path, await exportClaimPrivateKey(identity.privateKey), { mode: 0o600 });
  return identity;
}

/** The public half, base64url — what the registry stores and what a renewal is checked against. */
export async function claimIdentityFingerprint(identity: CryptoKeyPair): Promise<string> {
  return exportClaimPublicKey(identity.publicKey);
}
