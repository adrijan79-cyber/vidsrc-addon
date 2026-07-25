# vidsrc-addon

Stremio addon that serves streams for movies and TV shows from vidsrc mirrors.

For each title it returns:

- **Native HLS** — an `m3u8` extracted via [`@definisi/vidsrc-scraper`](https://www.npmjs.com/package/@definisi/vidsrc-scraper) for in-app playback (best effort — may not always resolve).
- **Browser mirrors** — 6 vidsrc mirror embeds (`.xyz` / `.to` / `.me` / `.pm` / `.in` / `.net`) as `externalUrl` streams that open in your browser.

The HLS stream is listed first so Stremio-compatible clients pick it by default when it resolves; the browser mirrors are always included as fallbacks.

## Install

Deploy your own copy (see below), open the deployment URL, and click **Install in Stremio**. Or paste the manifest URL (`https://<your-deploy>/manifest.json`) into Stremio manually.

Cinemeta provides the IMDb ids that this addon matches on, so it works out of the box for anything with an IMDb id (`tt…`).

## Deploy

Requires Node 18+ and a Vercel account.

```
npx vercel        # link the project
npx vercel --prod # deploy
```

Runtime dep: `@definisi/vidsrc-scraper` (small, ~8kB unpacked, uses axios).

### Environment

- `TMDB_API_KEY` *(recommended)* — a free key from [TMDB](https://www.themoviedb.org/settings/api). Used to resolve IMDb ids to TMDB ids (the scraper's embed source only accepts TMDB). Without it, the addon still works but returns only the browser mirrors; the native HLS stream will be omitted.

Add it to Vercel: `vercel env add TMDB_API_KEY production`, paste the key, then redeploy.

## Endpoints

- `/` — install landing page
- `/manifest.json` — Stremio manifest
- `/stream/:type/:id` — streams for a movie (`tt1234567`) or episode (`tt1234567:1:2`)

## Layout

- `api/manifest.js` — serves the Stremio manifest
- `api/stream.js` — orchestrates scraping + mirror fallbacks
- `api/configure.js` — landing page with install deep link
- `lib/manifest.js` — addon metadata
- `lib/sources.js` — mirror list and id parser
- `lib/tmdb.js` — IMDb→TMDB id resolver (uses `TMDB_API_KEY`)

## Known limitations

- The HLS scraper depends on vidsrc.xyz's page structure and will break whenever they change it. When that happens the browser mirrors keep working, and the scraper can be repaired independently.
- Only IMDb ids are supported. TMDB / Kitsu / MAL ids are not.
- Some titles are unavailable on all mirrors; that is a source-side limitation.
