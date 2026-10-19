// Vercel serverless function: fetch the game site, locate the current game-*.js bundle,
// run the anchor search, return the hook line.
//
//   GET /api/generate                       -> uses https://farmingseason.io/
//   GET /api/generate?bundle=https://farmingseason.io/assets/game-xxxx.js
//
// GAME_ORIGIN in the Vercel project overrides the default site.

import { findNames, assetRefs, isGameBundle } from '../public/anchors.js';

const UA = 'fs-hook-generator/1.0 (+https://vercel.com)';
const DEFAULT_ORIGIN = 'https://farmingseason.io/';
const MAX_BYTES = 6 * 1024 * 1024;

function validUrl(u) {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[::1\])/.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

async function text(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow', cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error(`${url} is too large (${len} bytes)`);
  const t = await r.text();
  if (t.length > MAX_BYTES) throw new Error(`${url} is too large`);
  return t;
}

// Breadth-first through the site's JS assets until a game-*.js reference shows up.
async function locateBundle(origin) {
  const html = await text(origin.href);
  const seen = new Set();
  let queue = assetRefs(html);
  const tried = [];
  for (let depth = 0; depth < 3 && queue.length; depth++) {
    const hit = queue.find(isGameBundle);
    if (hit) return { url: new URL(hit, origin).href, tried };
    const next = [];
    for (const p of queue.slice(0, 12)) {
      if (seen.has(p)) continue;
      seen.add(p);
      tried.push(p);
      try {
        const js = await text(new URL(p, origin).href);
        next.push(...assetRefs(js).filter((x) => !seen.has(x)));
      } catch {}
    }
    queue = next;
  }
  throw new Error(`No game-*.js reference found from ${origin.href} (looked at ${tried.length} assets)`);
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('access-control-allow-origin', '*');
  const q = req.query || {};
  try {
    let bundleUrl = null;
    let tried = [];
    if (q.bundle) {
      const u = validUrl(String(q.bundle));
      if (!u || !isGameBundle(u.pathname)) return res.status(400).json({ ok: false, error: 'bundle must be an http(s) URL ending in /game-<hash>.js' });
      bundleUrl = u.href;
    } else {
      const o = validUrl(String(q.origin || process.env.GAME_ORIGIN || DEFAULT_ORIGIN));
      if (!o) return res.status(400).json({ ok: false, error: 'Bad game site URL' });
      ({ url: bundleUrl, tried } = await locateBundle(o));
    }
    const src = await text(bundleUrl);
    const r = findNames(src);
    return res.status(200).json({
      ok: r.complete,
      bundle: bundleUrl,
      file: bundleUrl.split('/').pop(),
      bytes: src.length,
      line: r.line,
      names: r.names,
      missing: r.missing,
      alreadyHooked: src.includes('window.__fs='),
      tried,
      at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message || String(e) });
  }
}
