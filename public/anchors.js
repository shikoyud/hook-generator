// Shared between the Vercel function and the browser page.
// Finds the minified names the bot needs in a Farming Season bundle.
// Names change on every build; the anchors are string literals and code shapes that do not.

const ID = '[A-Za-z_$][\\w$]*';
const esc = (s) => s.replace(/\$/g, '\\$');

export const ORDER = [
  'q', 'U', 'Ca', 'Pg', 'jf', 'W', 'or', 'wr', 'Or', 'te', 'hr', 'de', 'je', 'Ae', 'Fe',
  'cap', 'dr', 'kr', 'passive', 'siloBuilt', 'siloCount', 'siloCap', 'energyPrice', 'feedPerMeal', 'battleCap', 'animalsPer', 'fishTable', 'fishScale', 'fishBase', 'baitPrice', 'keepItem',
];

// Names added for newer game features. Older builds lack them; the bot then skips that feature.
export const OPTIONAL = new Set(['fishTable', 'fishScale', 'fishBase', 'baitPrice', 'keepItem']);

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
  energyPrice: 'token price of n energy',
  feedPerMeal: 'feed bags one animal eats per meal',
  battleCap: 'daily arena loot cap',
  animalsPer: 'animals one building holds at a level',
  fishTable: 'fish species with catch chance and value range',
  fishScale: 'divisor for fish value',
  fishBase: 'fish value base for this farm',
  baitPrice: 'token price of one bait',
  keepItem: 'animal kind to pantry item (eggs, milk)',
};

/**
 * @param {string} src bundle text
 * @returns {{names: Record<string,string>, line: string, missing: string[]}}
 */

// Pretty-printed copies (DevTools "{}" or a formatter) put whitespace around punctuation; the
// anchors are written for the minified text, so collapse that whitespace first when needed.
export function normalize(src) {
  return src.replace(/\s*([=(){}\[\],;:?<>!&|+\-*/%])\s*/g, '$1');
}

export function findNames(input) {
  const first = findNamesRaw(input);
  if (first.complete || !/\n/.test(input.slice(0, 5000))) return first;
  const second = findNamesRaw(normalize(input));
  return second.missing.length < first.missing.length ? { ...second, normalized: true } : first;
}

function findNamesRaw(src) {
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
  // `new V.default.Game({` up to build Cna0d58N, `new z.Game({` from LG9ka9IO
  names.Pg = find('Pg', new RegExp(`(${ID})=new ${ID}(?:\\.default)?\\.Game\\(\\{`));
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
  names.Ae = find('Ae', new RegExp(`A \\$\\{(${ID})\\[r\\.kind\\]\\.name\\.toLowerCase\\(\\)\\}\\s*died after 24 hours`));
  names.Fe = find('Fe', new RegExp(`t\\.kind in (${ID})&&e\\.animals\\.some\\(`));
  names.cap = find('cap', new RegExp(`Math\\.min\\(n,(${ID})\\(e\\)-e\\.today\\.harvestEarned\\)`));
  names.dr = find('dr', new RegExp(`let ${ID}=(${ID})\\(e,i\\.kind\\),${ID}=${ID}\\(e,${ID}\\);(?:return )?i\\.productReady=!1`));
// keepItem (optional): animal kind -> pantry item, `c=De()?Ke[i.kind]:void 0` (pantry update)
names.keepItem = find('keepItem', new RegExp(`=${ID}\\(\\)\\?(${ID})\\[i\\.kind\\]:void 0(?:,[^;]{0,60})?;if\\(${ID}&&e\\.keep\\?\\.\\[`));
  // from LG9ka9IO the variables are `c` and `l` (fruit may go to the pantry first), so match any
  names.kr = find('kr', new RegExp(`let (${ID})=(${ID})\\(e,o\\.tree\\),${ID}=${ID}\\(e,\\1\\);return a\\.lastHarvestAt=r`), 2);
  const claimFn = find('passive (claim op)', new RegExp(`claimPassive:\\(e,t\\)=>(${ID})\\(e,t\\)`));
  names.passive = claimFn ? find('passive', new RegExp(`function ${esc(claimFn)}\\(e,t\\)\\{let n=Math\\.floor\\((${ID})\\(e,t\\)\\)`)) : null;
  [, names.siloBuilt, names.siloCount, names.siloCap] = findAll(
    'silo (built/count/cap)',
    new RegExp(`if\\((${ID})\\(i\\.crop\\.id\\)&&(${ID})\\(e,n\\)&&(${ID})\\(e\\)<(${ID})\\(e\\)\\)return ${ID}\\(e,i\\.crop\\.id,1\\)`)
  );

  // energyPrice: `Mi=(e,t)=>Math.ceil(Ee(be(e.level)*t))`
  names.energyPrice = find('energyPrice', new RegExp(`(${ID})=\\(e,t\\)=>Math\\.ceil\\(${ID}\\(${ID}\\(e\\.level\\)\\*t\\)\\)`));

  // feedPerMeal: `hi=e=>e.animals.reduce((e,t)=>e+j(t.kind)*2,0)`
  names.feedPerMeal = find('feedPerMeal', new RegExp(`e\\.animals\\.reduce\\(\\(e,t\\)=>e\\+(${ID})\\(t\\.kind\\)\\*2,0\\)`));

  // battleCap: `Ri=e=>Math.max(0,Ii(e)-(e.today.battleEarned??0))` -> Ii
  names.battleCap = find('battleCap', new RegExp(`e=>Math\\.max\\(0,(${ID})\\(e\\)-\\(e\\.today\\.battleEarned\\?\\?0\\)\\)`));

  // animalsPer: building capacity, from the animal→building assignment `Math.floor(r/ee(Kn(t.kind),e.level))`
  names.animalsPer = find('animalsPer', new RegExp(`Math\\.floor\\(r/(${ID})\\(${ID}\\(t\\.kind\\),e\\.level\\)\\)`));

  // fish catch: `let[,n,r]=ra(e.owner,t),i=he(),a=pe(),...l=Math.round(na(e)*(s.lo+r*(s.hi-s.lo))/a)`
  [names.fishTable, names.fishScale, names.fishBase] = findAll('fishTable/fishScale/fishBase', new RegExp(`let\\[,n,r\\]=${ID}\\(e\\.owner,t\\),i=(${ID})\\(\\),a=(${ID})\\(\\)[\\s\\S]{0,260}?l=Math\\.round\\((${ID})\\(e\\)\\*\\(s\\.lo\\+r\\*\\(s\\.hi-s\\.lo\\)\\)/a\\)`));
  // bait: `let o=ta(e)*t;return ar(e,o,`normal`)?(i.bait+=t`
  names.baitPrice = find('baitPrice', new RegExp(`let o=(${ID})\\(e\\)\\*t;return ${ID}\\(e,o,\`normal\`\\)\\?\\(i\\.bait\\+=t`));

  for (const k of ORDER) if (!names[k]) names[k] = null;
  const found = ORDER.filter((k) => names[k]);
  const line = `window.__fs={${found.map((k) => (names[k] === k ? k : `${k}:${names[k]}`)).join(',')}};`;
  const isOptional = (m) => m.split(':')[0].split('/').every((k) => OPTIONAL.has(k.trim()));
  const required = missing.filter((m) => !isOptional(m));
  return { names, line, missing: required, optionalMissing: missing.filter(isOptional), complete: required.length === 0 };
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
