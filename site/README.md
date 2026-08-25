# frizz.sh

The one-page site at [frizz.sh](https://frizz.sh). Static: no framework, no build step.

| Path | What it is |
| --- | --- |
| `index.html` | The page. The cursive `fff` mark is inlined from `assets/logo-concepts/final/fff.svg` so the stroke can draw itself on load. |
| `site.css` | The board's own tokens from `packages/web/src/styles.css`, JetBrains Mono for display and code, the system sans for body text. |
| `img/` | Copies of the README screenshots in `assets/` — a copy, not a symlink, because the deploy uploads files. Re-copy when a screenshot changes. |
| `og.html` | Source for `img/og.png`, the 1200×630 social card. Not deployed (`.vercelignore`). |
| `fonts/` | JetBrains Mono 2.304 woff2, under the OFL in `fonts/OFL.txt`. |

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
