// `owner/repo#N` → the PR's own URL. Shared by every card that carries a GitHub reference: the wake
// card's title-row ref (a burst's items normally have their own permalinks, but the ref must stay
// clickable when GitHub returned none) and the awaiting card's `prs:` refs, which have no other
// link to offer at all. Null when the ref isn't the expected shape, in which case the card renders it
// as plain text rather than a broken link.
//
// The `/pull/N` path is right for the frizz uses (both sides carry PR refs) and GitHub redirects it to
// `/issues/N` when the number is an issue, so a mistyped kind still lands the human on the right page.
export function githubRefUrl(ref: string): string | null {
  const m = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)#(\d+)$/.exec(ref.trim())
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : null
}
