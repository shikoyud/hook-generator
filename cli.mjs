#!/usr/bin/env node
// Same logic as the website, for people who do have Node:
//   node cli.mjs game-xxxx.js [--write]
import { readFileSync, appendFileSync } from 'node:fs';
import { findNames } from './public/anchors.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node cli.mjs <game-*.js> [--write]');
  process.exit(2);
}
const src = readFileSync(file, 'utf8');
const r = findNames(src);
console.log(r.line);
if (!r.complete) {
  console.error('missing anchors:\n  ' + r.missing.join('\n  '));
  process.exit(1);
}
if (process.argv.includes('--write')) {
  if (src.includes('window.__fs=')) console.error('hook already present, not appending');
  else {
    appendFileSync(file, (src.endsWith('\n') ? '' : '\n') + r.line + '\n');
    console.error(`appended to ${file}`);
  }
}
