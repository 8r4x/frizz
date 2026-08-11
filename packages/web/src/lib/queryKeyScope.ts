import { hashKey } from "@tanstack/react-query"
import { projectSlug } from "./base-path.ts"

// THE CACHE IS PER PROJECT, AND NOBODY HAS TO REMEMBER THAT.
//
// One Frizz serves every project on the machine from one origin, so `["transcript", "fix-auth"]` names
// a different thread depending on which project asked — thread slugs are unique only WITHIN a project
// (see `rebindProject` in api/socket.ts). `["settingsGet"]` is worse: the server reads a per-project
// blob (`getSettings` in packages/server/src/settings.ts), so the same key genuinely holds different
// data per project. Every key in this app was project-blind, and what stood between that and a visible
// bug was a `removeQueries` sweep on every switch — a rule, enforced in one place, that a late response
// or a new call site could walk around.
//
// react-query identifies a cache entry by its HASH, not by the key array, and the hash function is a
// client-level default. So the project can be folded in ONCE, here, and every query — including every
// one written after this — is scoped without its author doing anything. That is the difference between
// a convention and a property: prefixing 19 key shapes by hand would have worked exactly until the
// twentieth.
//
// WHAT THIS BUYS, concretely: a response for project A that resolves after the operator has switched
// lands under A's hash, where nothing on B's page is looking. B cannot read it, and B's own observers
// build their own entries. Returning to A finds A's cache still warm instead of a wiped one.

/**
 * Keys that name the MACHINE rather than one project, and must stay shared.
 *
 * `projectsList` is the rail's own data — scoping it would refetch the whole list on every switch and
 * blank the rail mid-navigation, which is the flicker the client-side router exists to remove.
 * `threadLocate` deliberately searches every registered project server-side, so a per-project copy
 * would be several caches of one answer.
 */
const MACHINE_WIDE = new Set(["projectsList", "threadLocate"])

/** The `queryKeyHashFn` for this app's QueryClient. Nothing else should need to call it. */
export function projectScopedQueryKeyHash(key: readonly unknown[]): string {
  const head = key[0]
  if (typeof head === "string" && MACHINE_WIDE.has(head)) return hashKey(key)
  // The page's own project, or "" for the unprefixed launching project — which is a REAL project and
  // must therefore be a stable scope of its own, not an absence of one.
  return hashKey([`project:${projectSlug() ?? ""}`, ...key])
}
