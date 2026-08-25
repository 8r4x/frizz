import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The GitHub identity behind a name claim, taken from the `gh` CLI the operator is already signed in to.
 *
 * WHY A TOKEN AND NOT JUST A USERNAME. Reading the username locally proves nothing — the CLI could
 * send any string, so a loop could claim a name per invented account and the limit would mean exactly
 * nothing. The registrar has to check with GitHub itself, and a token is what lets it.
 *
 * The token is sent ONCE, at the first claim. The registrar exchanges it for a numeric user id, keeps
 * the id, and discards the token; renewals afterwards carry no token at all, because the keypair
 * already proves ownership. So a name does not depend on GitHub — or on this having been stored
 * anywhere — to stay alive.
 */

export class GithubIdentityError extends Error {
  constructor(
    message: string,
    readonly code: "missing-gh" | "not-signed-in",
  ) {
    super(message);
    this.name = "GithubIdentityError";
  }
}

/**
 * Ask `gh` for the token it is already using.
 *
 * Deliberately does NOT trigger a login. Someone claiming a name should be told to run `gh auth login`
 * themselves rather than have a browser opened at them by a command they thought was about hostnames.
 */
export async function githubAccessToken(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await run("gh", ["auth", "token"], { encoding: "utf8" }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new GithubIdentityError(
        "claiming a name needs the GitHub CLI, which is not installed — see https://cli.github.com, then run `gh auth login`",
        "missing-gh",
      );
    }
    throw new GithubIdentityError(
      "claiming a name needs a signed-in GitHub CLI — run `gh auth login` and try again",
      "not-signed-in",
    );
  }

  const token = stdout.trim();
  if (!token) {
    throw new GithubIdentityError(
      "the GitHub CLI returned no token — run `gh auth login` and try again",
      "not-signed-in",
    );
  }
  return token;
}

/** Who `gh` is signed in as. Shown before a claim so nobody binds a name to the wrong account. */
export async function githubLogin(): Promise<string | null> {
  try {
    const { stdout } = await run("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
