# frizz.sh

The one-page site at [frizz.sh](https://frizz.sh). Static: no framework, no build step.

| Path | What it is |
| --- | --- |
| `index.html` | The page. The cursive `fff` mark is inlined from `assets/logo-concepts/final/fff.svg` so the stroke can draw itself on load. |
| `site.css` | The board's own tokens from `packages/web/src/styles.css`, JetBrains Mono for display and code, the system sans for body text. |
| `img/` | Screenshots captured from a sandboxed `scripts/adhoc-stack.mjs` instance (seeded threads, no real data), downscaled to ~2x. The picker shot lists `colinhacks/zod` because this repo had one open issue at capture time. |
| `og.html` | Source for `img/og.png`, the 1200×630 social card. Not deployed (`.vercelignore`). |
| `fonts/` | JetBrains Mono 2.304 woff2, under the OFL in `fonts/OFL.txt`. |
| `docs/` | The remote-access guides, at `/docs`. They mirror [`docs/remote-access.md`](../docs/remote-access.md), which `src/cloud.ts` names in its error messages — change one and change the other. One file per route, sharing `site.css` and the same `.doc` column as the homepage. |

## Why `/docs` and not `docs.frizz.sh`

The relay Worker owns `*.frizz.sh/*`, and a workers route beats a custom domain — a subdomain here is
answered by the relay with *No Frizz board has claimed this name*, which is exactly how `registrar.frizz.sh`
went down the day the relay shipped. A path on the apex is not covered by that wildcard. A subdomain would
work only with its own more-specific route, the way the registrar has one.

## Deploying

The Vercel project is `frizz` under the `colinhacks-projects` scope, deployed from this directory with the CLI:

```sh
vercel --cwd site --prod
```

## Regenerating the social card

```sh
python3 -m http.server 8765 --directory site   # in one shell
node scripts/shot.mjs http://127.0.0.1:8765/og.html site/img/og.png "" --w=1200 --h=630 --dsf=1 --wait=1500
```
