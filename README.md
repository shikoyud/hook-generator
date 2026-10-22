# Farming Season bot helper

A small website with one button. It fetches `https://farmingseason.io/`, follows the page to the
`game-*.js` bundle the site is serving at that moment, finds the minified names the bot needs,
and prints the `window.__fs=…` hook line. It also hosts the bot userscript and a step-by-step
guide (English and Vietnamese) for installing it, including how to put the hook line into the
game with the browser's "Override content" feature, so nobody needs Node or server access.

## Deploy on Vercel (free tier)

1. Push this folder to a Git repository (GitHub, GitLab or Bitbucket).
2. On vercel.com: **Add New → Project**, import the repository. No framework, no build command,
   output directory left empty. Deploy.
3. Done. Production lives at **https://cubie.land**: the bot opens it on any error and uses it
   for Tampermonkey updates. The userscript is served through a tiny function that stamps the
   serving host into those links, so a preview deployment points at itself instead.

Optional: the environment variable `GAME_ORIGIN` overrides the game site if it ever moves.

## What visitors get

- **Generate** button: reads the live bundle, shows the file name, the hook line, a copy button
  and the table of resolved names. Press again after every game update.
- **Offline fallback**: choose or paste a bundle file; the same search runs in the browser.
- **Guide**: install Tampermonkey and the script, apply the hook line via DevTools → Sources →
  right-click → Override content, run the bot, what the toggles do, troubleshooting.
- **Language switch**: English / Tiếng Việt, remembered per browser, auto-picked from the
  browser language on first visit.
- `/farmbot.user.js`: the bot, with `@updateURL` pointing back at this site so Tampermonkey
  picks up new versions.

## Files

| File | Purpose |
|---|---|
| `public/index.html` | the page, both languages |
| `public/anchors.js` | the name search, shared by the function, the page and the CLI |
| `public/farmbot.user.js` | the bot (source copy; served through `api/script.js`) |
| `api/generate.js` | serverless function: find the bundle, run the search, return JSON |
| `api/script.js` | serves the userscript with the site address stamped in (`__HELP_URL__`) |
| `vercel.json` | rewrites `/farmbot.user.js` to `api/script.js` |
| `cli.mjs` | same search from a terminal: `node cli.mjs game-xxxx.js [--write]` |
| `test/anchors.test.mjs` | `npm test`; also checks any `game-*.js` found one folder up |

## API

`GET /api/generate` (uses farmingseason.io) or `GET /api/generate?bundle=https://farmingseason.io/assets/game-x.js`

```json
{ "ok": true, "file": "game-CjF6g9I6.js", "line": "window.__fs={...};", "names": {...}, "missing": [] }
```

Pretty-printed copies (saved from DevTools with the `{}` button) are matched on a
whitespace-collapsed copy automatically.

The fishing names (`fishTable`, `fishScale`, `fishBase`, `baitPrice`) and the pantry name
(`keepItem`) are optional: builds before those updates lack them, the line is generated without
them, and the bot skips the matching checks.

`ok: false` with `missing` listed means the game code changed around an anchor; the returned
line is partial. Each anchor in `public/anchors.js` is a string literal or code shape that sits
next to the name; search the bundle for that literal, read the name beside it, fix the regex.

## Updating the bot

Edit `public/farmbot.user.js` (keep the `__HELP_URL__` placeholders in the header and the
`HELP_URL` constant), bump `@version`, push. Tampermonkey installs the new version on its next
update check.

## Notes

- The function only fetches `http(s)` URLs on public hosts and refuses files over 6 MB.
- Results are never cached; every click fetches the live bundle.
- `.gitignore` keeps game bundles out of the repository.
