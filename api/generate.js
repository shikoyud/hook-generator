// Vercel serverless function: fetch the game site, locate the current game-*.js bundle,
// run the anchor search, return the hook line.
//
//   GET /api/generate                       -> uses https://farmingseason.io/
//   GET /api/generate?bundle=https://farmingseason.io/assets/game-xxxx.js
//
// GAME_ORIGIN in the Vercel project overrides the default site.

import { findNames, assetRefs, isGameBundle } from '../public/anchors.js';

// Browser-like headers: the game sits behind Cloudflare, which is more likely to challenge a
// bare server fetch than one that looks like a normal page load.
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9,vi;q=0.8',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
};
class StageError extends Error {
  constructor(stage, message, status, snippet) {
    super(message);
    this.stage = stage;
    this.status = status;
    this.snippet = snippet;
  }
}
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

async function text(url, stage) {
  let r;
  try {
    r = await fetch(url, { headers: HEADERS, redirect: 'follow', cache: 'no-store' });
  } catch (e) {
    throw new StageError(stage, `network error fetching ${url}: ${e.message}`, 0);
  }
  const body = await r.text();
  if (!r.ok) {
    const cf = /cloudflare|cf-chl|Just a moment|Attention Required/i.test(body) || r.headers.get('server') === 'cloudflare';
    throw new StageError(stage, `${r.status} ${r.statusText} for ${url}${cf && r.status === 403 ? ' (Cloudflare blocked the server request)' : ''}`, r.status, body.slice(0, 200));
  }
  if (body.length > MAX_BYTES) throw new StageError(stage, `${url} is too large (${body.length} bytes)`, r.status);
  if (stage === 'bundle' && /^\s*<!doctype html|^\s*<html/i.test(body)) {
    throw new StageError(stage, `${url} returned an HTML page instead of JavaScript (challenge page or wrong URL)`, r.status, body.slice(0, 200));
  }
  return body;
}

// Breadth-first through the site's JS assets until a game-*.js reference shows up.
async function locateBundle(origin) {
  const html = await text(origin.href, 'page');
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
        const js = await text(new URL(p, origin).href, 'asset');
        next.push(...assetRefs(js).filter((x) => !seen.has(x)));
      } catch {}
    }
    queue = next;
  }
  throw new StageError('locate', `No game-*.js reference found from ${origin.href} (looked at ${tried.length} assets)`, 0);
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
    const src = await text(bundleUrl, 'bundle');
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
    return res.status(502).json({
      ok: false,
      error: e.message || String(e),
      stage: e.stage || 'unknown',
      upstreamStatus: e.status ?? null,
      snippet: e.snippet || null,
      hint: e.status === 403 ? 'The game site refused the request from this server. Use the offline fallback: open the game, save the game-*.js file, and choose it on the page.' : null,
    });
  }
}
