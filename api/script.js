// Serves the userscript with this deployment's own address stamped in, so the bot can send
// people back to this site for help whatever domain it is deployed on.
//
//   GET /farmbot.user.js   (rewritten to this function by vercel.json)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cached = null;

export default function handler(req, res) {
  if (!cached) cached = readFileSync(join(process.cwd(), 'public', 'farmbot.user.js'), 'utf8');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const site = host ? `${proto}://${host}` : '';
  // Point the help links at whichever host serves this copy (production is https://cubie.land).
  const body = site ? cached.replace(/__HELP_URL__/g, site).replace(/https:\/\/cubie\.land/g, site) : cached.replace(/__HELP_URL__/g, 'https://cubie.land');
  res.setHeader('content-type', 'text/javascript; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.status(200).send(body);
}
