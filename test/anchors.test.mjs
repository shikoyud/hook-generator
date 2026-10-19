import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { findNames, assetRefs, isGameBundle, ORDER } from '../public/anchors.js';

test('assetRefs finds /assets/*.js in HTML and JS', () => {
  const html = `<script type="module" src="/assets/index-AbC.js"></script><link rel="modulepreload" href="/assets/vendor-x1.js">`;
  assert.deepEqual(assetRefs(html), ['/assets/index-AbC.js', '/assets/vendor-x1.js']);
  const js = 'import("./assets/game-laGmU-gn.js");m.f=["assets/dist-B.js"]';
  assert.deepEqual(assetRefs(js), ['/assets/game-laGmU-gn.js', '/assets/dist-B.js']);
});

test('isGameBundle', () => {
  assert.equal(isGameBundle('/assets/game-CjF6g9I6.js'), true);
  assert.equal(isGameBundle('/assets/index-CjF6g9I6.js'), false);
});

test('findNames reports every anchor as missing on unrelated text', () => {
  const r = findNames('console.log(1)');
  assert.equal(r.complete, false);
  assert.ok(r.missing.length >= 15);
  assert.equal(r.line, 'window.__fs={};');
});

// Real bundles, when present one level up (not committed with this folder).
const up = new URL('../../', import.meta.url);
const bundles = existsSync(up) ? readdirSync(up).filter((f) => /^game-[\w-]+\.js$/.test(f)) : [];
for (const f of bundles) {
  test(`findNames resolves all ${ORDER.length} names in ${f}`, () => {
    const r = findNames(readFileSync(new URL(f, up), 'utf8'));
    assert.deepEqual(r.missing, []);
    assert.ok(r.line.startsWith('window.__fs={q'));
  });
}
