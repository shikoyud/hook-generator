// Shared between the Vercel function and the browser page.
// Finds the minified names the bot needs in a Farming Season bundle.
// Names change on every build; the anchors are string literals and code shapes that do not.

const ID = '[A-Za-z_$][\\w$]*';
const esc = (s) => s.replace(/\$/g, '\\$');

export const ORDER = [
  'q', 'U', 'Ca', 'Pg', 'jf', 'W', 'or', 'wr', 'Or', 'te', 'hr', 'de', 'je', 'Ae', 'Fe',
  'cap', 'dr', 'kr', 'passive', 'siloBuilt', 'siloCount', 'siloCap',
];

export const WHAT = {
  q: 'farm store (farm, visiting, op)',
  U: 'UI controller (place, mode, queued, work)',
  Ca: 'human-check instance (recordJob, flag, jobs)',
  Pg: 'Phaser game',
  jf: 'job submitter used by panel buttons',
  W: 'game clock',
  or: 'field state reader',
  wr: 'animal state reader',
  Or: 'tree slot state reader',
  te: 'crop list',
  hr: 'crop value for this farm',
  de: 'is a silo crop',
  je: 'tree list',
  Ae: 'animal table',
  Fe: 'building table',
  cap: 'daily harvest cap',
  dr: 'animal product value',
  kr: 'tree fruit value',
  passive: 'accrued village income',
  siloBuilt: 'silo built',
  siloCount: 'silo stock',
  siloCap: 'silo capacity',
};

/**
 * @param {string} src bundle text
 * @returns {{names: Record<string,string>, line: string, missing: string[]}}
 */
export function findNames(src) {
  const names = {};
  const missing = [];
  const find = (key, re, group = 1) => {
    const m = src.match(re);
    if (!m) {
      missing.push(`${key}: ${re.source.slice(0, 80)}`);
      return null;
    }
    return m[group];
  };
  const findAll = (key, re) => {
    const m = src.match(re);
    if (!m) {
      missing.push(`${key}: ${re.source.slice(0, 80)}`);
      return [];
    }
    return m.slice(1);
  };

  const humanClass = find('Ca (class)', new RegExp(`(${ID})=class\\{owner=\`\`;status=\\{mode:\`off\``));
  names.Ca = humanClass ? find('Ca', new RegExp(`(${ID})=new ${esc(humanClass)}\\b`)) : null;
  names.q = find('q', new RegExp(`(${ID})=new class\\{farm=null`));
  names.U = find('U', new RegExp(`(${ID})=\\{place:\`farm\`,selectedField:null`));
  names.Pg = find('Pg', new RegExp(`(${ID})=new ${ID}\\.default\\.Game\\(\\{`));
  names.jf = find('jf', new RegExp(`function (${ID})\\(e,t=!1\\)\\{if\\(!${ID}\\.visiting&&!${ID}\\.allow\\(\\)\\)return!1`));
  names.W = find('W', new RegExp(`(${ID})=new class\\{speed=`));
  names.or = find('or', new RegExp(`function (${ID})\\(e,t\\)\\{if\\(!e\\.crop\\)return\\{state:\`empty\`\\}`));
  names.wr = find('wr', new RegExp(`function (${ID})\\(e,t\\)\\{return\\{hungry:!e\\.fedWindows`));
  names.Or = find('Or', new RegExp(`function (${ID})\\(e,t\\)\\{if\\(!e\\.tree\\)return\\{state:\`empty\`\\}`));
  [names.te, names.de, names.hr] = findAll(
    'te/de/hr (seed button)',
    new RegExp(`let i=(${ID})\\.map\\(t=>\`\\s*<button class="seed [\\s\\S]{0,400}?\\$\\{(${ID})\\(t\\.id\\)\\?\`silo · 5 bags\`:\`\\+\\$\\{${ID}\\((${ID})\\(e,t\\)\\)\\}\``)
  );
  names.je = find('je', new RegExp(`let t=(${ID})\\.map\\(t=>\`<button class="seed" data-action="plant-tree"`));
  names.Ae = find('Ae', new RegExp(`A \\$\\{(${ID})\\[r\\.kind\\]\\.name\\.toLowerCase\\(\\)\\} died after 24 hours`));
  names.Fe = find('Fe', new RegExp(`t\\.kind in (${ID})&&e\\.animals\\.some\\(`));
  names.cap = find('cap', new RegExp(`Math\\.min\\(n,(${ID})\\(e\\)-e\\.today\\.harvestEarned\\)`));
  names.dr = find('dr', new RegExp(`let s=(${ID})\\(e,i\\.kind\\),c=${ID}\\(e,s\\);i\\.productReady=!1`));
  names.kr = find('kr', new RegExp(`let s=(${ID})\\(e,o\\.tree\\),c=${ID}\\(e,s\\);return a\\.lastHarvestAt=r`));
  const claimFn = find('passive (claim op)', new RegExp(`claimPassive:\\(e,t\\)=>(${ID})\\(e,t\\)`));
  names.passive = claimFn ? find('passive', new RegExp(`function ${esc(claimFn)}\\(e,t\\)\\{let n=Math\\.floor\\((${ID})\\(e,t\\)\\)`)) : null;
  [, names.siloBuilt, names.siloCount, names.siloCap] = findAll(
    'silo (built/count/cap)',
    new RegExp(`if\\((${ID})\\(i\\.crop\\.id\\)&&(${ID})\\(e,n\\)&&(${ID})\\(e\\)<(${ID})\\(e\\)\\)return ${ID}\\(e,i\\.crop\\.id,1\\)`)
  );

  for (const k of ORDER) if (!names[k]) names[k] = null;
  const found = ORDER.filter((k) => names[k]);
  const line = `window.__fs={${found.map((k) => (names[k] === k ? k : `${k}:${names[k]}`)).join(',')}};`;
  return { names, line, missing, complete: missing.length === 0 };
}

/** Pull every /assets/*.js reference out of HTML or JS text. */
export function assetRefs(text) {
  const out = new Set();
  const re = /(?:\.\/|\/)?assets\/[\w.-]+\.js/g;
  let m;
  while ((m = re.exec(text))) out.add(m[0].replace(/^\.\//, '/').replace(/^(?!\/)/, '/'));
  return [...out];
}

export const isGameBundle = (p) => /\/game-[\w-]+\.js$/.test(p);
