// ==UserScript==
// @name         Farming Season bot
// @namespace    fs-bot
// @version      0.3.0
// @description  Automation for Farming Season: farm loop, crop planner, cap-aware planting, village income, battle runs. Stays inside the game's human-check rules.
// @match        https://farmingseason.io/*
// @match        https://*.farmingseason.io/*
// @homepageURL  https://cubie.land
// @downloadURL  https://cubie.land/farmbot.user.js
// @updateURL    https://cubie.land/farmbot.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
  Requires a hook line appended to the end of the game bundle (game-*.js). Names change on
  every build, so generate it:   node make-hook.mjs game-xxxx.js   (add --write to append).

  Console use: paste this whole file, then  __bot.start()  /  __bot.stop()  /  __bot.panel()
*/

(function () {
  'use strict';

  const IS_NODE = typeof window === 'undefined';
  const SEC = 1000;
  // The helper site (install guide, hook generator). The site stamps its own address in
  // when it serves this file; a local copy falls back to the public one.
  const HELP_URL = /^https?:/.test('__HELP_URL__') ? '__HELP_URL__' : 'https://cubie.land';

  // ------------------------------------------------------------------ CONFIG
  const CONFIG = {
    // pacing (seconds)
    delayMin: 3,
    delayMax: 8,
    idleChance: 0.08,
    idleMin: 15,
    idleMax: 40,
    // rule guard
    budgetFraction: 1 / 3, // of the game's 60 jobs/min/farmer
    minCv: 0.2, // game flags under 0.08
    // farm
    maxPending: 3,
    retryAfter: 60, // seconds to skip a target after a refusal
    defaultCrop: null, // crop id used by 'auto' when a field has no history
    capAware: true, // stop planting cash crops once today's projected income reaches the cap
    plantKeepsReserve: false, // hold planting while energy − 2 would drop under today's remaining meals
    mineMinCarts: 2, // collect the mine at this many carts (2 = full; a cart every 6 h, max 2)
    bulk: true, // use the game's Harvest all / Plant all path: one bulkStart op, 2 energy for the whole batch
    bulkMin: 2, // batch only when at least this many fields qualify
    waitForBatch: true, // hold a ready harvest while other fields ripen within waitMinutes, then harvest all together
    waitMinutes: 5,
    feedFirst: true, // grow wheat/corn for the silo until feed covers feedDaysAhead, then the plan's crop
    feedExtraDays: 0, // on top of today's remaining meals, keep this many extra days of feed
    mixFeed: true, // mix grain into bags automatically (costs no energy)
    // energy purchases (see Core.energyPlan)
    autoEnergy: false, // master switch; the reasons below pick what energy may be bought for
    energyForMeals: true, // today's remaining animal meals
    energyForWaiting: true, // ready crops, ripe fruit, products, full mine, today's oil
    energyForCycles: true, // extra plant+harvest cycles under the harvest cap (margin applies)
    energyForBattle: false, // another arena run while the loot cap is open (margin applies to last run's loot)
    energyMargin: 1.5, // a plant+harvest cycle must return at least this × its energy cost
    energyBuffer: 0, // extra energy to keep on hand beyond what the next jobs cost
    energyTopUp: false, // when buying, also cover the day's worthwhile crop cycles (bigger, rarer buys)
    energyMinBuy: 10, // never buy fewer than this at once
    energyMaxBuy: 60, // never buy more than this at once
    energyMaxPerDay: 300, // hard stop per farm day
    energyTokenKeep: 0, // tokens that must stay in the wallet
    energyTokenFraction: 0.5, // spend at most this share of the wallet per purchase
    energyBuyEvery: 90, // seconds between purchases
    // village income
    claim: true,
    claimMin: 1, // tokens accrued before collecting
    claimEvery: 30, // minutes between collections
    // battle (separate mode, started with the Battle button)
    maxWave: 30,
    keepAliveMin: 20,
    keepAliveMax: 45,
    // perk order: survive first (less damage, more dodges), then kill faster
    perkPriority: ['guard', 'dash', 'blade', 'haste', 'reach', 'swift', 'crit', 'storm', 'thorns', 'magnet'],
    battleCautionHp: 0.35, // below this share of max HP the hero kites instead of pressing in
    mortarRadius: 30, // game hurts within 18 px of a marker; keep a margin
    projectileMargin: 16, // extra clearance beyond the game's 6/8 px hit radius
    projectileHorizon: 1.4, // seconds ahead to look for incoming shots
    projectileDashAt: 0.35, // dash (dodge) when impact is this close and sidestepping is late
  };

  // -------------------------------------------------------------------- CORE
  // Pure functions. No DOM, no game globals. Exported for node tests.
  const Core = {
    // Same statistic as Ca.recordJob: gaps between consecutive jobs, last 25.
    gapRatio(jobs) {
      if (jobs.length < 2) return { n: 0, mean: 0, sd: 0, ratio: Infinity };
      const gaps = jobs.slice(1).map((t, i) => t - jobs[i]).slice(-25);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
      return { n: gaps.length, mean, sd, ratio: mean > 0 ? sd / mean : 0 };
    },

    // What the game would conclude if a job were recorded at `now`.
    simulateRecord(jobs, now, farmers) {
      const list = [...jobs, now];
      while (list.length > 80 * farmers) list.shift();
      const count = list.filter((t) => now - t < 60 * SEC).length;
      const { ratio } = Core.gapRatio(list);
      return { count, ratio, fast: count > 60 * farmers, regular: list.length > 25 && ratio < 0.08 };
    },

    // Bot's own, stricter test.
    guard(jobs, now, farmers, cfg) {
      const sim = Core.simulateRecord(jobs, now, farmers);
      const budget = 60 * farmers * cfg.budgetFraction;
      if (sim.count > budget) return { ok: false, reason: 'rate', ...sim, budget };
      if (jobs.length + 1 > 25 && sim.ratio < cfg.minCv) return { ok: false, reason: 'regular', ...sim, budget };
      return { ok: true, ...sim, budget };
    },

    // Log-uniform between delayMin and delayMax, with occasional idle stretches.
    nextDelay(cfg, rng = Math.random) {
      if (rng() < cfg.idleChance) return (cfg.idleMin + rng() * (cfg.idleMax - cfg.idleMin)) * SEC;
      const lo = Math.log(Math.max(0.05, cfg.delayMin));
      const hi = Math.log(Math.max(cfg.delayMin, cfg.delayMax));
      return Math.exp(lo + rng() * (hi - lo)) * SEC;
    },

    // Same key the game uses for meals: YYYY-MM-DD + S (before 12:00 local) / A.
    mealWindow(now, tzMin) {
      const d = new Date(now + (tzMin || 0) * 60000);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}${d.getUTCHours() < 12 ? 'S' : 'A'}`;
    },

    // Timestamp of the next local midnight (farm time).
    dayEnd(now, tzMin) {
      const off = (tzMin || 0) * 60000;
      const local = now + off;
      const next = Date.UTC(new Date(local).getUTCFullYear(), new Date(local).getUTCMonth(), new Date(local).getUTCDate() + 1);
      return next - off;
    },

    isBuilt: (o, now) => !o.buildUntil || now >= o.buildUntil,

    // The game assigns the i-th animal of a kind to building floor(i / capacity) among that
    // kind's buildings sorted by build time, and charges feeding/collecting once per building per
    // window/day. Returns the occupied buildings with their animals.
    occupiedBuildings(farm, h) {
      const out = [];
      const kinds = [...new Set(farm.animals.map((a) => a.kind))];
      for (const kind of kinds) {
        const bkind = Object.keys(h.Fe).find((k) => h.Fe[k] && h.Fe[k].animal === kind);
        if (!bkind) continue;
        const buildings = farm.structures.filter((s) => s.kind === bkind).sort((a, b) => (a.buildUntil ?? 0) - (b.buildUntil ?? 0));
        if (!buildings.length) continue;
        const animals = farm.animals.filter((a) => a.kind === kind);
        const cap = h.animalsPer ? Math.max(1, h.animalsPer(bkind, farm.level)) : Infinity;
        const groups = new Map();
        animals.forEach((a, i) => {
          const b = buildings[Math.min(buildings.length - 1, cap === Infinity ? 0 : Math.floor(i / cap))];
          if (!groups.has(b)) groups.set(b, []);
          groups.get(b).push(a);
        });
        for (const [b, list] of groups) out.push({ building: b, animals: list, kind });
      }
      return out;
    },

    // Energy to keep for the remaining meals today (2 per occupied animal building per unfed window).
    mealReserve(farm, now, h) {
      return Core.mealReserveDetail(farm, now, h).energy;
    },

    // Mine state, same arithmetic as the game: a cart every 6 h from the last collection
    // (or build end), at most 2; `full` means production has stopped.
    mineState(structure, now) {
      if (!Core.isBuilt(structure, now)) return { carts: 0, full: false, nextMs: 216e5 };
      const built = structure.buildUntil ?? 0;
      let since = structure.mineAt ?? built;
      since = Math.max(since > now ? built : since, built);
      const elapsed = Math.max(0, now - since);
      const carts = Math.min(2, Math.floor(elapsed / 216e5));
      return { carts, full: carts >= 2, nextMs: carts >= 2 ? 0 : 216e5 - (elapsed % 216e5) };
    },
    // Oil well: once per farm day.
    oilReady(structure, now, tzMin) {
      return Core.isBuilt(structure, now) && structure.collectDay !== Core.mealWindow(now, tzMin).slice(0, 10);
    },

    // Feed plan: how much wheat and corn still has to be grown so that bags + mixable grain
    // cover `feedDaysAhead` days of meals. Counts grain already growing in the fields.
    // Returns null when the farm has no animals or no silo.
    feedPlan(farm, now, h, cfg) {
      if (!h.feedPerMeal || !farm.animals.length) return null;
      const siloOk = !!(h.siloBuilt && h.siloBuilt(farm, now));
      const dailyNeed = farm.animals.reduce((n, a) => n + 2 * h.feedPerMeal(a.kind), 0);
      // meals still to come today, per animal: the current window if not eaten yet, plus the
      // afternoon window when it is still morning
      const win = Core.mealWindow(now, farm.tz);
      const morning = win.endsWith('S');
      let remainingToday = 0;
      for (const a of farm.animals) {
        const left = (a.fedWindows.includes(win) ? 0 : 1) + (morning ? 1 : 0);
        remainingToday += left * h.feedPerMeal(a.kind);
      }
      const silo = farm.silo || {};
      const bags = silo.feed || 0, wheat = silo.wheat || 0, corn = silo.corn || 0;
      const pairs = Math.min(wheat, corn);
      const coverBags = bags + pairs * 10;
      const target = remainingToday + dailyNeed * (cfg.feedExtraDays ?? 0);
      const mixes = Math.max(0, Math.ceil((target - coverBags) / 10));
      let wheatNeed = Math.max(0, mixes - (wheat - pairs));
      let cornNeed = Math.max(0, mixes - (corn - pairs));
      let growingW = 0, growingC = 0;
      for (const f of farm.fields) {
        if (f.crop === 'wheat') growingW++;
        else if (f.crop === 'corn') growingC++;
      }
      wheatNeed = Math.max(0, wheatNeed - growingW);
      cornNeed = Math.max(0, cornNeed - growingC);
      const capacityLeft = siloOk && h.siloCap ? h.siloCap(farm) - h.siloCount(farm) : Infinity;
      let next = null;
      if (siloOk && capacityLeft > 0 && (wheatNeed > 0 || cornNeed > 0)) {
        next = wheatNeed > cornNeed ? 'wheat' : cornNeed > wheatNeed ? 'corn' : wheat + growingW <= corn + growingC ? 'wheat' : 'corn';
      }
      return {
        siloOk, dailyNeed, remainingToday, bags, wheat, corn, pairs, coverBags, target,
        daysCovered: dailyNeed ? coverBags / dailyNeed : Infinity,
        mixes, wheatNeed, cornNeed, growingW, growingC, capacityLeft, next,
        shouldMix: siloOk && pairs >= 1 && bags < target,
      };
    },

    // Same as mealReserve, with the pieces: buildings with animals, meals left today per
    // building (2 before noon, 1 after; minus the current meal if that building was fed).
    mealReserveDetail(farm, now, h) {
      const win = Core.mealWindow(now, farm.tz);
      const morning = win.endsWith('S');
      let buildings = 0, meals = 0;
      for (const { building: st } of Core.occupiedBuildings(farm, h)) {
        buildings++;
        meals += (st.fedWindow === win ? 0 : 1) + (morning ? 1 : 0);
      }
      return { buildings, meals, energy: meals * 2, windowsLeft: morning ? 2 : 1, text: `${buildings} building${buildings === 1 ? '' : 's'} × ${buildings ? (meals / buildings).toFixed(meals % buildings ? 1 : 0) : 0} meal(s) left × 2 = ${meals * 2}` };
    },

    siloCropChoice(farm) {
      const s = farm.silo || {};
      return (s.wheat || 0) <= (s.corn || 0) ? 'wheat' : 'corn';
    },

    // Today's harvest-cap picture: what is already earned or committed against the cap.
    // Values are pre-multiplier (the bank bonus is applied at payout), so this is conservative.
    incomeProjection(farm, now, h) {
      const cap = h.cap(farm);
      const earned = farm.today.harvestEarned || 0;
      const carry = farm.harvestCarry || 0;
      const siloOk = !!(h.siloBuilt && h.siloBuilt(farm, now) && h.siloCount(farm) < h.siloCap(farm));
      const end = Core.dayEnd(now, farm.tz);
      const cash = (cropId) => !(h.de(cropId) && siloOk);
      let ready = 0, growing = 0, trees = 0, animals = 0;
      for (const f of farm.fields) {
        if (!f.crop) continue;
        const st = h.or(f, now);
        if (!st.crop || !cash(st.crop.id)) continue;
        const v = h.hr(farm, st.crop);
        if (st.state === 'ready') ready += v;
        else if (st.state === 'growing' && f.plantedAt + st.crop.minutes * 60000 <= end) growing += v;
      }
      for (const s of farm.structures) {
        if (!s.slots) continue;
        for (const slot of s.slots) {
          if (!slot.tree) continue;
          const st = h.Or(slot, now);
          if (!st.tree) continue;
          if (st.state === 'ready' || slot.lastHarvestAt + st.tree.hours * 3600e3 <= end) trees += h.kr(farm, st.tree);
        }
      }
      for (const a of farm.animals) if (a.productReady) animals += h.dr(farm, a.kind);
      const total = earned + carry + ready + growing + trees + animals;
      return { cap, earned, carry, ready, growing, trees, animals, total, siloOk, room: Math.max(0, cap - total) };
    },

    resolveCrop(fieldId, plan, last, crops, cfg) {
      const planned = plan[fieldId];
      if (planned && planned !== 'auto' && crops.some((c) => c.id === planned)) return planned;
      if (last[fieldId] && crops.some((c) => c.id === last[fieldId])) return last[fieldId];
      if (cfg.defaultCrop && crops.some((c) => c.id === cfg.defaultCrop)) return cfg.defaultCrop;
      return crops[0] ? crops[0].id : null;
    },

    // One job by priority: feed > collect > harvest > tree-harvest > plant.
    pickJob({ farm, now, queued, plan, last, cfg, h, skip = {} }) {
      if (!farm) return null;
      const win = Core.mealWindow(now, farm.tz);
      const free = (key) => !queued.has(key) && !(skip[key] > now);
      const energy = farm.today.energy;

      const hungry = farm.animals
        .map((a) => ({ a, v: h.wr(a, now, win) }))
        .filter(({ a, v }) => v.hungry && free(`feed:${a.id}`))
        .sort((x, y) => x.v.msToStarve - y.v.msToStarve);
      if (hungry.length && (energy >= 2 || (hungry[0].a.meals ?? 1) === 0)) {
        const id = hungry[0].a.id;
        return { job: { type: 'feed', animalId: id }, key: `feed:${id}`, why: 'hungry' };
      }
      if (energy < 2) return null;

      const ready = farm.animals.find((a) => a.productReady && free(`collect:${a.id}`));
      if (ready) return { job: { type: 'collect', animalId: ready.id }, key: `collect:${ready.id}`, why: 'product ready' };

      const holdHarvest = cfg.waitForBatch && cfg.bulk && Core.ripeningSoon(farm, now, h, cfg.waitMinutes ?? 5, free).length > 0;
      if (!holdHarvest) {
        for (const f of farm.fields) {
          if (!Core.isBuilt(f, now) || !free(`field:${f.id}`)) continue;
          const st = h.or(f, now);
          if (st.state === 'ready') {
            return { job: { type: 'harvest', fieldId: f.id }, key: `field:${f.id}`, why: 'ready', crop: st.crop && st.crop.id };
          }
        }
      }

      for (const s of farm.structures) {
        if (!s.slots || !Core.isBuilt(s, now)) continue;
        for (let i = 0; i < s.slots.length; i++) {
          const key = `tree:${s.id}:${i}`;
          if (!free(key)) continue;
          if (h.Or(s.slots[i], now).state === 'ready') {
            return { job: { type: 'tree-harvest', structureId: s.id, slot: i }, key, why: 'fruit ripe' };
          }
        }
      }

      for (const s of farm.structures) {
        const key = `rwa:${s.id}`;
        if (!free(key)) continue;
        if (s.kind === 'oilwell' && Core.oilReady(s, now, farm.tz)) {
          return { job: { type: 'fuel', structureId: s.id }, key, why: 'oil ready' };
        }
        if (s.kind === 'mine') {
          const m = Core.mineState(s, now);
          if (m.carts >= 1 && (m.full || m.carts >= (cfg.mineMinCarts ?? 2))) {
            return { job: { type: 'mine', structureId: s.id }, key, why: `${m.carts} cart${m.carts > 1 ? 's' : ''}${m.full ? ' (full)' : ''}` };
          }
        }
      }

      const reserve = cfg.plantKeepsReserve === false ? 0 : Core.mealReserve(farm, now, h);
      if (energy - 2 < reserve) return null;
      const empties = farm.fields.filter((f) => Core.isBuilt(f, now) && free(`field:${f.id}`) && h.or(f, now).state === 'empty');
      const choice = Core.plantChoices({ farm, now, h, cfg, plan, last, fields: empties })[0];
      return choice ? { job: { type: 'plant', fieldId: choice.fieldId, crop: choice.crop }, key: `field:${choice.fieldId}`, why: choice.why } : null;
    },

    // Why nothing is being planted right now, for the status line. null = nothing to explain.
    idleReason({ farm, now, queued, plan, last, cfg, h, skip = {} }) {
      const free = (key) => !queued.has(key) && !(skip[key] > now);
      const empties = farm.fields.filter((f) => Core.isBuilt(f, now) && free(`field:${f.id}`) && h.or(f, now).state === 'empty');
      if (!empties.length) return null;
      const energy = farm.today.energy;
      if (energy < 2) return `${empties.length} empty field(s), no energy`;
      const reserve = cfg.plantKeepsReserve === false ? 0 : Core.mealReserve(farm, now, h);
      if (energy - 2 < reserve) {
        const d = Core.mealReserveDetail(farm, now, h);
        return `${empties.length} empty field(s): planting costs 2, but ${reserve} is kept for today's remaining meals (${d.text}), so ${reserve + 2} is needed and you have ${energy}. Turn off "keep energy for meals" or buy energy.`;
      }
      const choices = Core.plantChoices({ farm, now, h, cfg, plan, last, fields: empties });
      if (!choices.length) {
        const proj = cfg.capAware !== false && h.cap ? Core.incomeProjection(farm, now, h) : null;
        if (proj && proj.total >= proj.cap) return `${empties.length} empty field(s): harvest cap reached and the silo is ${proj.siloOk ? 'ready' : 'full or missing'}`;
        return `${empties.length} empty field(s): no crop could be chosen (check the plan)`;
      }
      return null;
    },

    // What to plant on each of the given empty fields, in order. Feed-first needs are spread
    // across the fields, and the harvest-cap room is consumed as crops are assigned, so a batch
    // never overshoots what a single field at a time would have done.
    plantChoices({ farm, now, h, cfg, plan, last, fields }) {
      const proj = cfg.capAware !== false && h.cap ? Core.incomeProjection(farm, now, h) : null;
      let committed = proj ? proj.total : 0;
      const valueOf = (cropId) => {
        const c = h.crops.find((x) => x.id === cropId);
        return c ? h.hr(farm, c) : 0;
      };
      const fits = (cropId) => !proj || committed + valueOf(cropId) <= proj.cap;
      const feed = cfg.feedFirst ? Core.feedPlan(farm, now, h, cfg) : null;
      let wheatNeed = feed ? feed.wheatNeed : 0, cornNeed = feed ? feed.cornNeed : 0;
      let grainRoom = feed ? feed.capacityLeft : 0;
      const out = [];
      for (const f of fields) {
        if (feed && feed.siloOk && grainRoom > 0 && (wheatNeed > 0 || cornNeed > 0)) {
          const crop = wheatNeed > cornNeed ? 'wheat' : cornNeed > wheatNeed ? 'corn' : feed.wheat + feed.growingW <= feed.corn + feed.growingC ? 'wheat' : 'corn';
          if (crop === 'wheat') wheatNeed--;
          else cornNeed--;
          grainRoom--;
          out.push({ fieldId: f.id, crop, why: `feed plan: need ${wheatNeed} wheat, ${cornNeed} corn more` });
          continue;
        }
        let crop = Core.resolveCrop(f.id, plan, last, h.crops, cfg);
        if (!crop) continue;
        let why = plan[f.id] && plan[f.id] !== 'auto' ? 'plan' : 'auto';
        if (proj) {
          if (h.de(crop)) {
            if (!proj.siloOk && !fits(crop)) continue; // would sell as cash over the cap
            if (!proj.siloOk) committed += valueOf(crop);
          } else if (!fits(crop)) {
            if (!proj.siloOk) continue;
            crop = Core.siloCropChoice(farm);
            why = 'cap reached: silo crop';
          } else committed += valueOf(crop);
        }
        out.push({ fieldId: f.id, crop, why });
      }
      return out;
    },

    // Fields that will be ready within `minutes` from now (growing, built, not queued).
    ripeningSoon(farm, now, h, minutes, free = () => true) {
      const out = [];
      for (const f of farm.fields) {
        if (!f.crop || !Core.isBuilt(f, now) || !free(`field:${f.id}`)) continue;
        const st = h.or(f, now);
        if (st.state === 'growing' && st.remainingMs <= minutes * 60000) out.push({ id: f.id, remainingMs: st.remainingMs });
      }
      return out.sort((a, b) => a.remainingMs - b.remainingMs);
    },

    // Nearest-neighbour walk order, as the game's Harvest all does, starting near the middle.
    walkOrder(fields) {
      if (fields.length < 3) return fields.slice();
      const cx = fields.reduce((a, f) => a + f.x, 0) / fields.length, cy = fields.reduce((a, f) => a + f.y, 0) / fields.length;
      const rest = fields.slice();
      let cur = { x: cx, y: cy };
      const out = [];
      while (rest.length) {
        rest.sort((a, b) => Math.hypot(a.x - cur.x, a.y - cur.y) - Math.hypot(b.x - cur.x, b.y - cur.y));
        cur = rest.shift();
        out.push(cur);
      }
      return out;
    },

    // A batch to run through the game's bulk path: one `bulkStart` op charges 2 energy for every
    // field of that kind, then each field is queued as a normal job. Harvest first, then plant.
    // Returns {kind, jobs:[{job,key,why}]} or null when fewer than cfg.bulkMin fields qualify.
    bulkPlan({ farm, now, queued, plan, last, cfg, h, skip = {} }) {
      if (!farm || !cfg.bulk) return null;
      const free = (key) => !queued.has(key) && !(skip[key] > now);
      const energy = farm.today.energy;
      const min = cfg.bulkMin ?? 2;
      // Animals: every hungry one in one burst (feed), every ready product in one burst (collect).
      // The game charges 2 per building per meal whatever the order; the burst saves pacing.
      const win = Core.mealWindow(now, farm.tz);
      const hungry = farm.animals.filter((a) => h.wr(a, now, win).hungry && free(`feed:${a.id}`));
      if (hungry.length >= min && (energy >= 2 || hungry.some((a) => (a.meals ?? 1) === 0))) {
        const order = Core.occupiedBuildings(farm, h).flatMap((g) => g.animals).filter((a) => hungry.includes(a)).concat(hungry.filter((a) => !Core.occupiedBuildings(farm, h).some((g) => g.animals.includes(a))));
        return { kind: 'feed', jobs: order.map((a) => ({ job: { type: 'feed', animalId: a.id }, key: `feed:${a.id}`, why: 'hungry' })) };
      }
      const products = farm.animals.filter((a) => a.productReady && free(`collect:${a.id}`));
      if (products.length >= min && energy >= 2) {
        return { kind: 'collect', jobs: products.map((a) => ({ job: { type: 'collect', animalId: a.id }, key: `collect:${a.id}`, why: 'product ready' })) };
      }
      const built = farm.fields.filter((f) => Core.isBuilt(f, now) && free(`field:${f.id}`));
      const ready = built.filter((f) => h.or(f, now).state === 'ready');
      if (ready.length && cfg.waitForBatch && cfg.bulk) {
        const soon = Core.ripeningSoon(farm, now, h, cfg.waitMinutes ?? 5, free);
        if (soon.length) return { kind: 'wait', jobs: [], ready: ready.length, soon: soon.length, inMs: soon[soon.length - 1].remainingMs };
      }
      if (ready.length >= min && energy >= 2) {
        const jobs = Core.walkOrder(ready).map((f) => ({ job: { type: 'harvest', fieldId: f.id }, key: `field:${f.id}`, why: 'ready', crop: h.or(f, now).crop?.id }));
        return { kind: 'harvest', jobs };
      }
      const reserve = cfg.plantKeepsReserve === false ? 0 : Core.mealReserve(farm, now, h);
      if (energy - 2 < reserve) return null;
      const empties = built.filter((f) => h.or(f, now).state === 'empty');
      if (empties.length < min) return null;
      const choices = Core.plantChoices({ farm, now, h, cfg, plan, last, fields: Core.walkOrder(empties) });
      if (choices.length < min) return null;
      return { kind: 'plant', jobs: choices.map((c) => ({ job: { type: 'plant', fieldId: c.fieldId, crop: c.crop }, key: `field:${c.fieldId}`, why: c.why })) };
    },

    // How much energy to buy right now, and why. Pure: needs farm, now, helpers, cfg,
    // the crop plan and the per-field crop memory. Returns { buy, reason, ... }.
    //
    // Idea: energy is worth buying for two things only.
    //  1. Work that is already waiting: meals, ready crops, ripe fruit, products. These are
    //     bought whenever the wallet allows (a ready crop is paid for already).
    //  2. More plant+harvest cycles today, but only while they still fit under the harvest cap,
    //     only as many as the day has time for, and only if a cycle returns energyMargin × what
    //     its 4 energy cost. Silo crops are never a reason to buy.
    energyPlan({ farm, now, h, cfg, plan = {}, last = {}, boughtToday = 0 }) {
      const out = { buy: 0, reason: '', need: 0, cycles: 0, cycleEnergy: 0, pricePer: 0, room: 0 };
      if (!h.energyPrice || !h.cap) return { ...out, reason: 'price or cap not in hook' };
      const energy = farm.today.energy;
      const pricePer = h.energyPrice(farm, 10) / 10;
      out.pricePer = pricePer;

      // 1. work the bot could do right now, split by reason. Only unpaid work counts: meals
      //    for the *current* window (later meals are bought when they come due), harvests
      //    waiting, and planting the empty fields.
      const win = Core.mealWindow(now, farm.tz);
      let meals = 0;
      if (cfg.energyForMeals !== false) {
        for (const g of Core.occupiedBuildings(farm, h)) {
          if (g.building.fedWindow !== win && g.animals.some((a) => !a.fedWindows.includes(win))) meals += 2;
        }
      }
      let need = 0;
      const readyFields = farm.fields.filter((f) => f.crop && Core.isBuilt(f, now) && h.or(f, now).state === 'ready').length;
      need += cfg.bulk && readyFields >= (cfg.bulkMin ?? 2) ? 2 : readyFields * 2;
      for (const s of farm.structures) {
        if (!s.slots) continue;
        for (const slot of s.slots) if (slot.tree && h.Or(slot, now).state === 'ready') need += 2;
      }
      for (const s of farm.structures) {
        if (s.kind === 'oilwell' && Core.oilReady(s, now, farm.tz)) need += 2;
        if (s.kind === 'mine' && Core.mineState(s, now).carts >= (cfg.mineMinCarts ?? 2)) need += 2;
      }
      for (const g of Core.occupiedBuildings(farm, h)) {
        if (g.animals.some((a) => a.productReady)) need += 2;
      }
      if (cfg.energyForWaiting === false) need = 0;
      out.waiting = need;
      out.meals = meals;
      // planting that is possible right now (empty, built fields with a crop to plant)
      let planting = 0;
      if (cfg.energyForCycles !== false) {
        const empties = farm.fields.filter((f) => Core.isBuilt(f, now) && h.or(f, now).state === 'empty');
        const choices = empties.length ? Core.plantChoices({ farm, now, h, cfg, plan, last, fields: empties }) : [];
        planting = choices.length ? (cfg.bulk && choices.length >= (cfg.bulkMin ?? 2) ? 2 : choices.length * 2) : 0;
      }
      out.planting = planting;
      need += meals + planting;
      out.need = need;
      // Trigger only when the work in front of us cannot be paid for.
      if (energy >= need + (cfg.energyBuffer || 0)) return { ...out, reason: `energy ${energy} covers ${need} now (${meals} meals, ${out.waiting} harvests, ${planting} planting)` };

      // 2. extra cycles today
      const proj = Core.incomeProjection(farm, now, h);
      out.room = proj.room;
      const msLeft = Core.dayEnd(now, farm.tz) - now;
      const candidates = [];
      for (const f of farm.fields) {
        if (!Core.isBuilt(f, now)) continue;
        const st = h.or(f, now);
        let cropId = plan[f.id] && plan[f.id] !== 'auto' ? plan[f.id] : st.crop ? st.crop.id : last[f.id] || cfg.defaultCrop || (h.crops[0] && h.crops[0].id);
        const crop = h.crops.find((c) => c.id === cropId);
        if (!crop || h.de(crop.id)) continue;
        const v = h.hr(farm, crop);
        const cycleMs = crop.minutes * 60000;
        const after = st.state === 'growing' ? st.remainingMs : 0;
        const n = Math.max(0, Math.floor((msLeft - after) / cycleMs));
        for (let i = 0; i < n; i++) candidates.push(v);
      }
      candidates.sort((a, b) => b - a);
      // With bulk, one plant batch and one harvest batch cover every field for 2 energy each,
      // so a cycle costs 4 energy spread over all cash fields instead of 4 per field.
      const cashFields = Math.max(1, new Set(farm.fields.filter((f) => Core.isBuilt(f, now)).map((f) => f.id)).size);
      const perCycle = cfg.bulk && cashFields >= (cfg.bulkMin ?? 2) ? Math.max(0.5, 4 / cashFields) : 4;
      let room = proj.room, cycles = 0;
      const cycleCost = perCycle * pricePer * cfg.energyMargin;
      for (const v of candidates) {
        if (v > room) break; // would only pile into tomorrow's carry
        if (v < cycleCost) break; // not worth the energy
        room -= v;
        cycles++;
      }
      if (cfg.energyForCycles === false) cycles = 0;
      out.cycles = cycles;
      out.cycleEnergy = Math.ceil(cycles * perCycle);

      // Amount: the shortfall for the work now, topped up with the day's worthwhile cycles so we
      // do not buy 10 at a time all day.
      const target = need + (cfg.energyTopUp ? out.cycleEnergy : 0) + (cfg.energyBuffer || 0);
      let shortfall = target - energy;
      if (shortfall <= 0) return { ...out, reason: `energy ${energy} covers the work now` };

      // amount: at least energyMinBuy, at most energyMaxBuy, within the daily cap and the wallet
      let buy = Math.min(cfg.energyMaxBuy, Math.max(cfg.energyMinBuy, Math.ceil(shortfall / 10) * 10));
      buy = Math.min(buy, Math.max(0, cfg.energyMaxPerDay - boughtToday));
      if (buy <= 0) return { ...out, reason: `daily limit ${cfg.energyMaxPerDay} reached` };
      const wallet = Math.max(0, (farm.tokens || 0) - cfg.energyTokenKeep);
      const budget = Math.floor(wallet * cfg.energyTokenFraction);
      while (buy > 0 && h.energyPrice(farm, buy) > budget) buy -= 10;
      if (buy < Math.min(cfg.energyMinBuy, 10)) return { ...out, reason: `wallet ${farm.tokens} too low (budget ${budget})` };
      return { ...out, buy, reason: `short for: ${out.meals} meals + ${out.waiting} harvests + ${out.planting} planting${cfg.energyTopUp ? ` + ${out.cycleEnergy} for ${cycles} cycles` : ''} − ${energy} on hand` };
    },

    // Energy for one more arena run. A run costs 5; buy only if the previous run's loot was worth
    // at least energyMargin × the price of those 5, within the same daily and wallet limits.
    battleEnergyPlan({ farm, h, cfg, lastLoot, boughtToday = 0 }) {
      if (!cfg.autoEnergy || !cfg.energyForBattle || !h.energyPrice) return { buy: 0, reason: 'battle purchases off' };
      const energy = farm.today.energy;
      if (energy >= 5) return { buy: 0, reason: `energy ${energy} ≥ 5` };
      const price5 = h.energyPrice(farm, 5);
      if (lastLoot != null && lastLoot < price5 * cfg.energyMargin) return { buy: 0, reason: `last run earned ${Math.round(lastLoot)} < ${Math.ceil(price5 * cfg.energyMargin)} (5 energy × margin)` };
      let buy = Math.max(cfg.energyMinBuy, 5 - energy);
      buy = Math.ceil(buy / 5) * 5;
      buy = Math.min(buy, Math.max(0, cfg.energyMaxPerDay - boughtToday));
      if (buy <= 0) return { buy: 0, reason: `daily limit ${cfg.energyMaxPerDay} reached` };
      const wallet = Math.max(0, (farm.tokens || 0) - cfg.energyTokenKeep);
      const budget = Math.floor(wallet * cfg.energyTokenFraction);
      while (buy >= 5 && h.energyPrice(farm, buy) > budget) buy -= 5;
      if (buy < 5 || energy + buy < 5) return { buy: 0, reason: `wallet ${farm.tokens} too low (budget ${budget})` };
      return { buy, reason: `another run (last loot ${lastLoot == null ? 'unknown' : Math.round(lastLoot)})` };
    },

    shouldClaim(accrued, lastClaimAt, now, cfg) {
      return accrued >= cfg.claimMin && now - lastClaimAt >= cfg.claimEvery * 60000;
    },

    // Escape vector away from mortar markers. `radius` is the danger radius per marker.
    // Returns {vec:[x,y]|null, nearest}.
    mortarEscape(hero, mortars, radius) {
      const reach = radius + 12;
      let vx = 0, vy = 0, nearest = Infinity, onTop = false;
      for (const m of mortars) {
        const dx = hero.x - m.x, dy = hero.y - m.y;
        const d = Math.hypot(dx, dy);
        nearest = Math.min(nearest, d);
        if (d > reach) continue;
        const w = (reach - d) / reach;
        if (d < 1) onTop = true;
        else {
          vx += (dx / d) * w;
          vy += (dy / d) * w;
        }
      }
      if (!isFinite(nearest) || nearest > reach) return { vec: null, nearest: isFinite(nearest) ? nearest : Infinity };
      let len = Math.hypot(vx, vy);
      if (len < 1e-6) {
        // standing exactly on a marker with no other push: try 8 directions, pick the freest
        let best = null, bestScore = -Infinity;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const px = hero.x + Math.cos(a) * reach, py = hero.y + Math.sin(a) * reach;
          const score = Math.min(...mortars.map((m) => Math.hypot(px - m.x, py - m.y)));
          if (score > bestScore) (bestScore = score), (best = [Math.cos(a), Math.sin(a)]);
        }
        return { vec: best, nearest };
      }
      void onTop;
      return { vec: [vx / len, vy / len], nearest };
    },

    // Immediate melee-type threats that the game's own routine handles poorly:
    //  - bomber in `fuse`: explodes 0.65 s after fusing, 38 px radius -> walk out, dash if close
    //  - flyer (bat) in `windup`: lunges at the spot it locked -> step off that spot sideways
    //  - low health: kite away from everything near, let auto-attack catch what follows
    // enemies: [{x,y,state,brain,radius,alive,lock?}]; hero: {x,y,hpPct}
    threatVector(hero, enemies, opts = {}) {
      const caution = opts.cautionHp ?? 0.35;
      let vx = 0, vy = 0, dash = false, dashVec = null, reasons = [];
      for (const e of enemies) {
        if (!e.alive) continue;
        const dx = hero.x - e.x, dy = hero.y - e.y, d = Math.hypot(dx, dy) || 1;
        if (e.brain === 'bomber' && e.state === 'fuse' && d < 64) {
          const w = 2 * (64 - d) / 64 + 1;
          vx += (dx / d) * w;
          vy += (dy / d) * w;
          if (d < 44 && !dash) (dash = true), (dashVec = [dx / d, dy / d]);
          reasons.push('bomb');
        } else if (e.brain === 'flyer' && e.state === 'windup' && e.lock) {
          const lx = hero.x - e.lock.x, ly = hero.y - e.lock.y, ld = Math.hypot(lx, ly);
          if (ld < 26) {
            // perpendicular to the lunge line (flyer -> lock), on the side we are already on
            const fx = e.lock.x - e.x, fy = e.lock.y - e.y, fd = Math.hypot(fx, fy) || 1;
            let px = -fy / fd, py = fx / fd;
            if (lx * px + ly * py < 0) (px = -px), (py = -py);
            vx += px * 1.5;
            vy += py * 1.5;
            reasons.push('bat');
          }
        }
      }
      if (hero.hpPct < caution) {
        let kx = 0, ky = 0, near = 0, closest = Infinity;
        for (const e of enemies) {
          if (!e.alive) continue;
          const dx = hero.x - e.x, dy = hero.y - e.y, d = Math.hypot(dx, dy) || 1;
          if (d > 110) continue;
          const w = (110 - d) / 110;
          kx += (dx / d) * w;
          ky += (dy / d) * w;
          near++;
          closest = Math.min(closest, d);
        }
        if (near) {
          const kl = Math.hypot(kx, ky) || 1;
          vx += (kx / kl) * 1.2;
          vy += (ky / kl) * 1.2;
          if (closest < 30 && !dash) (dash = true), (dashVec = [kx / kl, ky / kl]);
          reasons.push('low hp');
        }
      }
      const len = Math.hypot(vx, vy);
      return { vec: len > 1e-6 ? [vx / len, vy / len] : null, dash, dashVec, reasons };
    },

    // Predictive evasion for arrows and fireballs.
    // hero: {x, y} (the game tests hits against y - 6; pass the adjusted point).
    // projs: [{x, y, vx, vy, kind}] with velocity in px/s.
    // Returns {vec:[x,y]|null, dash:boolean, dashVec:[x,y]|null, threats:number, soonest:number}.
    //
    // For each shot, find the time and distance of closest approach along its straight path.
    // If it will pass inside the hit radius + margin within the horizon, sidestep perpendicular
    // to its flight, on the side the hero is already offset to. Nearer shots weigh more. When a
    // hit is imminent and the hero is still inside the lane, ask for a dash as well: the dodge
    // makes the hero untouchable for its duration.
    projectileEvasion(hero, projs, opts = {}) {
      const margin = opts.margin ?? 16, horizon = opts.horizon ?? 1.4, dashAt = opts.dashAt ?? 0.35;
      let vx = 0, vy = 0, threats = 0, soonest = Infinity, dash = false, dashVec = null;
      for (const p of projs) {
        const sp2 = p.vx * p.vx + p.vy * p.vy;
        if (sp2 < 1) continue;
        const rx = hero.x - p.x, ry = hero.y - p.y;
        const tc = (rx * p.vx + ry * p.vy) / sp2; // time to closest approach
        if (tc < 0 || tc > horizon) continue; // moving away, or too far off to matter yet
        const mx = rx - p.vx * tc, my = ry - p.vy * tc; // miss vector at closest approach
        const miss = Math.hypot(mx, my);
        const radius = (p.kind === 'fireball' ? 8 : 6) + margin;
        if (miss >= radius) continue;
        threats++;
        soonest = Math.min(soonest, tc);
        const sp = Math.sqrt(sp2);
        let px = -p.vy / sp, py = p.vx / sp; // unit perpendicular
        const side = mx * px + my * py;
        if (side < 0 || (side === 0 && (opts.preferSign ?? 1) < 0)) (px = -px), (py = -py);
        const w = (1 - miss / radius) * (1 + (horizon - tc) / horizon);
        vx += px * w;
        vy += py * w;
        if (tc <= dashAt && miss < radius - margin / 2) {
          dash = true;
          dashVec = [px, py];
        }
      }
      const len = Math.hypot(vx, vy);
      return { vec: len > 1e-6 ? [vx / len, vy / len] : null, dash, dashVec, threats, soonest };
    },

    fmtMinutes(m) {
      if (m < 60) return `${m} min`;
      const hh = Math.floor(m / 60);
      const mm = Math.round(m % 60);
      return mm ? `${hh} h ${mm} min` : `${hh} h`;
    },

    cropLabel(crop, farm, hr, de) {
      const t = Core.fmtMinutes(crop.minutes);
      if (de(crop.id)) return `${crop.name} · ${t} · silo`;
      const v = hr(farm, crop);
      const perHour = v / (crop.minutes / 60);
      return `${crop.name} · ${t} · +${v.toFixed(2)} · ${perHour.toFixed(2)}/h`;
    },

    fillPlan(fields, crops, strategy, valueOf, de) {
      const cash = crops.filter((c) => !de(c.id));
      const best = (score) => cash.reduce((b, c) => (!b || score(c) > score(b) ? c : b), null);
      const plan = {};
      fields.forEach((f, i) => {
        let id = 'auto';
        if (strategy === 'perHour') id = best((c) => valueOf(c) / c.minutes)?.id ?? 'auto';
        else if (strategy === 'perHarvest') id = best((c) => valueOf(c))?.id ?? 'auto';
        else if (strategy === 'wheat' || strategy === 'corn') id = strategy;
        else if (strategy === 'alternate') id = i % 2 ? 'corn' : 'wheat';
        plan[f.id] = id;
      });
      return plan;
    },
  };

  if (IS_NODE) {
    module.exports = { Core, CONFIG };
    return;
  }

  // ------------------------------------------------------------- BROWSER PART
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
  };

  const cfg = Object.assign({}, CONFIG, store.get('fsbot:cfg', {}));
  delete cfg.aggressive;
  const saveCfg = () => store.set('fsbot:cfg', cfg);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const $ = (sel, root = document) => root.querySelector(sel);

  // ----------------------------------------------------------------- LOGGING
  const LOG = [];
  const logListeners = new Set();
  function log(msg, level = 'info') {
    const e = { t: Date.now(), msg: String(msg), level };
    LOG.push(e);
    if (LOG.length > 200) LOG.shift();
    (level === 'bad' ? console.warn : console.log)(`[fsbot] ${e.msg}`);
    logListeners.forEach((l) => l(e));
  }

  // ------------------------------------------------------------------- HELP
  let helpOpened = false;
  const errorTimes = [];
  // Send the person to the helper site. Opens a new tab at most once per page load; the panel
  // keeps a Help button either way.
  function help(reason) {
    if (!HELP_URL) return;
    log(`Help: ${reason} → ${HELP_URL}`, 'bad');
    if (helpOpened) return;
    helpOpened = true;
    try {
      const w = window.open(HELP_URL, '_blank', 'noopener');
      if (!w) log('Pop-up blocked: use the Help button in the panel.', 'bad');
    } catch {}
  }
  // Repeated runtime errors (3 within 5 minutes) also point to the site.
  function noteError(where, e) {
    log(`${where} error: ${e && e.message ? e.message : e}`, 'bad');
    console.error(e);
    const now = Date.now();
    errorTimes.push(now);
    while (errorTimes.length && now - errorTimes[0] > 5 * 60 * SEC) errorTimes.shift();
    if (errorTimes.length >= 3) help(`${errorTimes.length} errors in 5 minutes`);
  }

  // -------------------------------------------------------------- GAME HOOK
  let G = null; // window.__fs
  let hookProblems = [];
  const stats = { flags: 0, lastFlag: '', jobs: 0, bulk: 0, refused: 0, battles: 0, claims: 0, claimed: 0, energyBought: 0, energySpent: 0 };

  const isFn = (v) => typeof v === 'function';
  const HOOK_CHECKS = {
    q: (v) => v && isFn(v.op) && 'farm' in v,
    U: (v) => v && typeof v.place === 'string' && v.queued instanceof Set && isFn(v.work),
    Ca: (v) => v && isFn(v.flag) && isFn(v.recordJob) && Array.isArray(v.jobs) && isFn(v.onBlock),
    Pg: (v) => v && v.scene && isFn(v.scene.getScene),
    jf: (v) => isFn(v) && v.length <= 2,
    W: (v) => v && isFn(v.now),
    or: (v) => isFn(v) && v.length === 2 && v({ crop: null }, 0)?.state === 'empty',
    wr: (v) => isFn(v) && v.length === 2 && 'hungry' in (v({ fedWindows: [], lastFedAt: 0 }, 0) || {}),
    Or: (v) => isFn(v) && v.length === 2 && v({ tree: null }, 0)?.state === 'empty',
    te: (v) => Array.isArray(v) && v.length > 0 && 'minutes' in v[0] && 'id' in v[0],
    hr: (v) => isFn(v) && v.length === 2,
    de: (v) => isFn(v) && v.length === 1 && !!v('wheat') && !v('__nope__'),
    je: (v) => Array.isArray(v) && (v.length === 0 || 'hours' in v[0]),
    Ae: (v) => v && typeof v === 'object' && Object.values(v).some((a) => a && 'product' in a),
    Fe: (v) => v && typeof v === 'object' && Object.values(v).some((b) => b && 'animal' in b),
    cap: (v) => isFn(v) && v.length === 1,
    dr: (v) => isFn(v) && v.length === 2,
    kr: (v) => isFn(v) && v.length === 2,
    passive: (v) => isFn(v) && v.length === 2,
    siloBuilt: (v) => isFn(v) && v.length === 2,
    siloCount: (v) => isFn(v) && v.length === 1,
    siloCap: (v) => isFn(v) && v.length === 1,
    energyPrice: (v) => isFn(v) && v.length === 2,
    feedPerMeal: (v) => isFn(v) && v.length === 1,
    battleCap: (v) => isFn(v) && v.length === 1,
    animalsPer: (v) => isFn(v) && v.length === 2,
  };
  const describe = (v) => {
    if (v === null) return 'null';
    if (typeof v === 'function') return `function ${v.name || ''}(${v.length})`;
    if (typeof v !== 'object') return typeof v;
    if (Array.isArray(v)) return `array[${v.length}]`;
    return `object{${Object.keys(v).slice(0, 4).join(',')}}`;
  };
  function validateHook(h) {
    const bad = [];
    for (const [k, test] of Object.entries(HOOK_CHECKS)) {
      let ok = false;
      try {
        ok = !!test(h[k]);
      } catch {}
      if (!ok) bad.push(`${k} (${h[k] === undefined ? 'missing' : 'wrong object: ' + describe(h[k])})`);
    }
    return bad;
  }

  function attach() {
    const h = window.__fs;
    if (!h) return false;
    hookProblems = validateHook(h);
    if (hookProblems.length) return false;
    G = h;
    if (!G.Ca.__botWrapped) {
      const orig = G.Ca.flag.bind(G.Ca);
      G.Ca.flag = (reason, detail) => {
        stats.flags++;
        stats.lastFlag = `${reason} (${detail})`;
        log(`HUMAN CHECK FLAG: ${reason} ${detail}`, 'bad');
        return orig(reason, detail);
      };
      G.Ca.__botWrapped = true;
    }
    G.Ca.onBlock((b) => log(b ? 'Gate up: paused until you solve the check.' : 'Gate cleared: resuming.', b ? 'bad' : 'good'));
    if (G.q.onReject) G.q.onReject((m) => log(`Server rejected: ${m}`, 'bad'));
    return true;
  }

  const owner = () => (G.q.farm && G.q.farm.owner ? G.q.farm.owner.toLowerCase() : 'local');
  const goHome = () => {
    const btn = $('#battle-ui [data-action="go-home"]') || $('[data-action="go-home"]');
    if (btn) btn.click();
    return !!btn;
  };
  const helpers = () => ({
    or: G.or,
    wr: (a, now) => G.wr(a, now),
    Or: G.Or,
    de: G.de,
    Fe: G.Fe,
    crops: G.te || [],
    hr: G.hr,
    kr: G.kr,
    dr: G.dr,
    cap: G.cap,
    siloBuilt: G.siloBuilt,
    siloCount: G.siloCount,
    siloCap: G.siloCap,
    energyPrice: G.energyPrice,
    feedPerMeal: G.feedPerMeal,
    battleCap: G.battleCap,
    animalsPer: G.animalsPer,
  });

  // ---------------------------------------------------------------- PLANNER
  const Planner = {
    plan: {},
    last: {},
    errors: {},
    load() {
      this.plan = store.get(`fsbot:plan:${owner()}`, {});
      this.last = store.get(`fsbot:last:${owner()}`, {});
    },
    save() {
      store.set(`fsbot:plan:${owner()}`, this.plan);
      store.set(`fsbot:last:${owner()}`, this.last);
    },
    set(fieldId, cropId) {
      this.plan[fieldId] = cropId;
      delete this.errors[fieldId];
      this.save();
    },
    fill(strategy) {
      const farm = G.q.farm;
      if (!farm) return;
      this.plan = Core.fillPlan(farm.fields, G.te, strategy, (c) => G.hr(farm, c), G.de);
      this.errors = {};
      this.save();
    },
    remember(fieldId, cropId) {
      if (!cropId) return;
      this.last[fieldId] = cropId;
      this.save();
    },
    refused(fieldId, msg) {
      this.errors[fieldId] = msg || 'refused';
      this.plan[fieldId] = 'auto';
      this.save();
    },
  };

  // ------------------------------------------------------------------ PACER
  const Pacer = {
    check() {
      return Core.guard(G.Ca.jobs, performance.now(), G.Ca.farmers || 1, cfg);
    },
    delay() {
      return Core.nextDelay(cfg);
    },
    live() {
      const now = performance.now();
      const jobs = G.Ca.jobs;
      return { perMin: jobs.filter((t) => now - t < 60 * SEC).length, allowed: 60 * (G.Ca.farmers || 1), ratio: Core.gapRatio(jobs).ratio, n: jobs.length };
    },
  };

  // ------------------------------------------------------------------- FARM
  const Farm = {
    skip: {},
    status: 'stopped',
    lastClaimAt: 0,
    lastProj: null,
    lastBuyAt: 0,
    lastEnergyPlan: null,
    lastMixAt: 0,
    lastFeed: null,
    mixFeed(farm, now) {
      const fp = G.feedPerMeal ? Core.feedPlan(farm, now, helpers(), cfg) : null;
      this.lastFeed = fp;
      if (!cfg.mixFeed || !fp || !fp.shouldMix) return;
      if (now - this.lastMixAt < 60 * SEC) return;
      this.lastMixAt = now;
      // Same op as the silo's "Mix all" button. Costs no energy; not a farmer job.
      const r = G.q.op('makeFeed', 'max');
      if (r.ok) log(`Silo: mixed ${fp.pairs} wheat + ${fp.pairs} corn → +${fp.pairs * 10} bags.`, 'good');
      else log(`Mixing refused: ${r.msg}`, 'bad');
    },
    boughtDay: null,
    boughtToday: 0,
    rollDay(farm, now) {
      const day = Core.mealWindow(now, farm.tz).slice(0, 10);
      if (this.boughtDay !== day) {
        this.boughtDay = day;
        this.boughtToday = 0;
      }
    },
    // Same op the shop's "Buy" button uses. Not a farmer job, so the game does not count it
    // in recordJob; purchases are still spaced by energyBuyEvery.
    purchase(farm, now, amount, reason, force = false) {
      if (!force && now - this.lastBuyAt < cfg.energyBuyEvery * SEC) return false;
      const cost = G.energyPrice(farm, amount);
      this.lastBuyAt = now;
      const r = G.q.op('buyEnergy', amount);
      if (r.ok) {
        this.boughtToday += amount;
        stats.energyBought += amount;
        stats.energySpent += cost;
        log(`Bought ${amount} energy for ${cost} tokens (${reason}).`, 'good');
        return true;
      }
      log(`Energy purchase refused: ${r.msg}`, 'bad');
      return false;
    },
    buyEnergy(farm, now) {
      if (!cfg.autoEnergy || !G.energyPrice) return;
      this.rollDay(farm, now);
      const p = Core.energyPlan({ farm, now, h: helpers(), cfg, plan: Planner.plan, last: Planner.last, boughtToday: this.boughtToday });
      this.lastEnergyPlan = p;
      if (p.buy) this.purchase(farm, now, p.buy, p.reason);
    },
    farmReady() {
      return G.U.place === 'farm' && !G.q.visiting && G.U.mode.type === 'normal';
    },
    claimIncome(farm, now) {
      if (!cfg.claim || !G.passive) return;
      const accrued = Math.floor(G.passive(farm, now));
      if (!Core.shouldClaim(accrued, this.lastClaimAt, now, cfg)) return;
      this.lastClaimAt = now;
      // Same call the "Collect village income" button makes (q.op). Not a farmer job, so the
      // game does not count it in recordJob; we still space it out via claimEvery.
      const r = G.q.op('claimPassive');
      if (r.ok) {
        stats.claims++;
        stats.claimed += r.gained || accrued;
        log(`Collected village income: +${r.gained ?? accrued}`, 'good');
      } else log(`Village income not collected: ${r.msg}`, 'bad');
    },
    step() {
      const farm = G.q.farm;
      if (!farm) return (this.status = 'no farm open');
      if (G.Ca.blocked) return (this.status = 'paused: human check');
      if (Battle.engaged) return (this.status = 'paused while battle mode runs');
      if (!this.farmReady()) {
        if (G.U.place === 'battle') goHome();
        return (this.status = `waiting for farm view (${G.U.place})`);
      }
      const now = G.W.now();
      this.claimIncome(farm, now);
      this.mixFeed(farm, now);
      this.buyEnergy(farm, now);
      this.lastProj = G.cap ? Core.incomeProjection(farm, now, helpers()) : null;

      const pending = G.U.pendingJobs().length;
      if (pending >= cfg.maxPending) return (this.status = `farmer busy (${pending} queued)`);

      const args = { farm, now, queued: G.U.queued, plan: Planner.plan, last: Planner.last, cfg, h: helpers(), skip: this.skip };
      const batch = Core.bulkPlan(args);
      if (batch && batch.kind === 'wait') {
        this.status = `waiting ${Math.ceil(batch.inMs / 60000)} min so ${batch.ready + batch.soon} fields can be harvested together`;
        // fall through to other work (feeding, collecting, fruit) but not the harvest
        const pick = Core.pickJob(args);
        if (pick && pick.job.type !== 'harvest' && pick.job.type !== 'plant') {
          const g = Pacer.check();
          if (!g.ok) return;
          if (G.jf(pick.job, true)) {
            stats.jobs++;
            log(`${pick.job.type} ${pick.job.animalId || pick.job.structureId} — ${pick.why} (while waiting for the harvest batch)`);
          }
        }
        return;
      }
      if (batch) {
        const g = Pacer.check();
        if (!g.ok) {
          stats.refused++;
          this.status = `holding: ${g.reason} (${g.count}/${Math.floor(g.budget)} per min)`;
          return;
        }
        // Same sequence as the game's Harvest all / Plant all button: bulkStart (2 energy for the
        // batch), then every field as a normal job in one synchronous burst, which recordJob
        // counts once, exactly like the button.
        if (batch.kind === 'harvest' || batch.kind === 'plant') {
          const r = G.q.op('bulkStart', batch.kind);
          if (!r.ok) {
            log(`Bulk ${batch.kind} refused: ${r.msg}`, 'bad');
            for (const j of batch.jobs) this.skip[j.key] = now + cfg.retryAfter * SEC;
            return;
          }
        }
        let sent = 0;
        for (const j of batch.jobs) {
          if (j.job.type === 'harvest') Planner.remember(j.job.fieldId, j.crop);
          if (!G.jf(j.job, true)) {
            this.skip[j.key] = now + cfg.retryAfter * SEC;
            break;
          }
          sent++;
        }
        stats.jobs++;
        stats.bulk++;
        const what = batch.kind === 'feed' || batch.kind === 'collect' ? 'animals' : 'fields';
        this.status = `${batch.kind} all: ${sent} ${what}`;
        const buildings = batch.kind === 'feed' || batch.kind === 'collect' ? new Set(Core.occupiedBuildings(farm, helpers()).filter((g) => g.animals.some((a) => batch.jobs.some((j) => j.job.animalId === a.id))).map((g) => g.building.id)).size : 0;
        log(batch.kind === 'feed' ? `Feed all: ${sent} animals in ${buildings} building${buildings === 1 ? '' : 's'} (2 energy per building per meal).` : batch.kind === 'collect' ? `Collect all: ${sent} animals in ${buildings} building${buildings === 1 ? '' : 's'} (2 energy per building per day).` : `${batch.kind === 'harvest' ? 'Harvest' : 'Plant'} all: ${sent} field${sent === 1 ? '' : 's'} for 2 energy${batch.kind === 'plant' ? ' (' + [...new Set(batch.jobs.map((j) => j.job.crop))].join(', ') + ')' : ''}.`);
        return;
      }

      const pick = Core.pickJob(args);

      if (!pick) {
        const why = Core.idleReason(args);
        this.status = why ? `idle: ${why}` : 'idle';
        return;
      }

      const g = Pacer.check();
      if (!g.ok) {
        stats.refused++;
        this.status = `holding: ${g.reason} (${g.count}/${Math.floor(g.budget)} per min, cv ${isFinite(g.ratio) ? g.ratio.toFixed(2) : '-'})`;
        return;
      }

      if (pick.job.type === 'harvest') Planner.remember(pick.job.fieldId, pick.crop);
      const ok = G.jf(pick.job, true);
      if (ok) {
        stats.jobs++;
        this.status = `${pick.job.type} (${pick.why})`;
        log(`${pick.job.type} ${pick.job.fieldId || pick.job.animalId || pick.job.structureId}${pick.job.crop ? ' ' + pick.job.crop : ''} — ${pick.why}`);
      } else {
        this.skip[pick.key] = now + cfg.retryAfter * SEC;
        this.status = `refused ${pick.job.type}`;
        log(`Refused ${pick.job.type} on ${pick.key}; skipping for ${cfg.retryAfter}s`, 'bad');
        if (pick.job.type === 'plant' && pick.why === 'plan') Planner.refused(pick.job.fieldId, 'game refused this crop');
      }
    },
  };

  // ----------------------------------------------------------------- BATTLE
  const Battle = {
    engaged: false,
    phase: 'off',
    since: 0,
    timer: null,
    keepAliveAt: 0,
    patched: null,
    capDay: null,
    retreating: false,
    hiddenWarned: false,
    strafe: 1,
    lastLoot: null,
    dodges: 0,
    projEvades: 0,
    projDodges: 0,
    threatEvades: 0,
    threatDodges: 0,

    scene() {
      try {
        return G.Pg.scene.getScene('battle');
      } catch {
        return null;
      }
    },
    today() {
      return Core.mealWindow(G.W.now(), G.q.farm.tz).slice(0, 10);
    },
    stopRequested: false,
    // Returns null when another run may start, otherwise the reason it may not.
    blockReason(farm) {
      if (this.stopRequested) return 'stop requested';
      if (this.capDay === this.today()) return 'loot cap reached today';
      if (G.battleCap) {
        const cap = G.battleCap(farm), earned = farm.today.battleEarned ?? 0;
        if (cap > 0 && earned >= cap) return `loot cap reached today (${Math.round(earned)}/${Math.round(cap)})`;
      }
      if (farm.today.energy < 5) return `energy ${farm.today.energy} < 5`;
      if (document.hidden) return 'tab hidden (game pauses battles)';
      return null;
    },
    shouldStart(farm) {
      return this.blockReason(farm) === null;
    },
    // Battle button: go to the arena and play runs until energy, the loot cap or Stop ends it.
    begin() {
      if (this.engaged) return;
      if (!G && !attach()) return log('Cannot start battle: hook not found.', 'bad');
      const farm = G.q.farm;
      if (!farm) return log('Cannot start battle: open a farm first.', 'bad');
      this.stopRequested = false;
      const why = this.blockReason(farm);
      if (why) return log(`Battle not started: ${why}.`, 'bad');
      this.engage();
      Panel.refresh(true);
    },
    // Stop battle button: retreat from a running fight, then leave the arena.
    end() {
      if (!this.engaged) return;
      this.stopRequested = true;
      const s = this.scene();
      const inRun = !!(s && s.run && s.run.active);
      if (inRun && !this.retreating) {
        this.retreating = true;
        log('Stop requested: retreating from the current run.');
        this.key('Escape', 'Escape');
      } else if (!inRun) {
        this.disengage('stopped');
      }
      Panel.refresh(true);
    },
    engage() {
      this.engaged = true;
      this.retreating = false;
      this.setPhase('go');
      log('Battle mode: heading to the arena.');
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        try {
          this.tick();
        } catch (e) {
          noteError('battle', e);
        }
      }, 400);
    },
    disengage(reason) {
      clearInterval(this.timer);
      this.timer = null;
      this.unpatch();
      this.engaged = false;
      this.setPhase('off');
      if (reason) log(`Leaving arena: ${reason}`);
      if (G.U.place === 'battle') goHome();
    },
    setPhase(p) {
      if (this.phase !== p) {
        this.phase = p;
        this.since = Date.now();
        Panel.refresh();
      }
    },

    // Movement: mortar escape > Rat King windup strafe > game's own botInput().
    smartInput(s) {
      const hero = s.hero;
      const mortars = [];
      for (const c of s.children.list) {
        if (c.active && c.texture && c.texture.key === 'b_mortar') mortars.push({ x: c.x, y: c.y + 6 }); // sprite sits 6 px above the impact point
      }
      if (mortars.length) {
        const esc = Core.mortarEscape(hero, mortars, cfg.mortarRadius);
        if (esc.vec) {
          if (esc.nearest < cfg.mortarRadius * 0.7 && hero.dodgeCd <= 0 && hero.dodge(esc.vec[0], esc.vec[1])) this.dodges++;
          return esc.vec;
        }
      }
      // Arrows and fireballs: sidestep early, dash only when it is about to land.
      const projs = (s.projs || []).filter((p) => p.sprite && p.sprite.active).map((p) => ({ x: p.sprite.x, y: p.sprite.y, vx: p.vx, vy: p.vy, kind: p.kind }));
      if (projs.length) {
        const ev = Core.projectileEvasion({ x: hero.x, y: hero.y - 6 }, projs, { margin: cfg.projectileMargin, horizon: cfg.projectileHorizon, dashAt: cfg.projectileDashAt, preferSign: this.strafe });
        if (ev.vec) {
          if (ev.dash && hero.dodgeCd <= 0 && hero.dodge(ev.dashVec[0], ev.dashVec[1])) this.projDodges++;
          this.projEvades++;
          // keep a little of the normal behaviour so the hero still closes in afterwards
          const base = typeof s.botInput === 'function' ? s.botInput() : [0, 0];
          const x = ev.vec[0] * 0.85 + base[0] * 0.15, y = ev.vec[1] * 0.85 + base[1] * 0.15;
          const l = Math.hypot(x, y) || 1;
          return [x / l, y / l];
        }
      }
      // Bombers about to blow, bats mid-lunge, and a hero on low health.
      const enemiesLite = s.enemies.map((e) => ({ x: e.x, y: e.y, state: e.state, brain: e.rule && e.rule.brain, radius: e.rule && e.rule.radius, alive: e.alive, lock: e.lock }));
      const tv = Core.threatVector({ x: hero.x, y: hero.y, hpPct: hero.stats && hero.stats.maxHp ? hero.hp / hero.stats.maxHp : 1 }, enemiesLite, { cautionHp: cfg.battleCautionHp });
      if (tv.vec) {
        if (tv.dash && hero.dodgeCd <= 0 && hero.dodge(tv.dashVec[0], tv.dashVec[1])) this.threatDodges++;
        this.threatEvades++;
        const base = typeof s.botInput === 'function' ? s.botInput() : [0, 0];
        const lowHp = tv.reasons.includes('low hp');
        const k = lowHp ? 0.7 : 0.85; // kiting still lets the auto-attack bite when they close in
        const x = tv.vec[0] * k + base[0] * (1 - k), y = tv.vec[1] * k + base[1] * (1 - k);
        const l = Math.hypot(x, y) || 1;
        return [x / l, y / l];
      }
      // A ranged enemy winding up aims at where the hero stands (archers lock the spot, wizards
      // track): drift sideways so the shot is already off-line when it leaves.
      const shooter = s.enemies.find((e) => e.alive && e.state === 'windup' && e.rule && (e.rule.brain === 'archer' || e.rule.brain === 'caster') && Math.hypot(e.x - hero.x, e.y - hero.y) < 260);
      if (shooter) {
        const dx = hero.x - shooter.x, dy = hero.y - shooter.y, d = Math.hypot(dx, dy) || 1;
        const sx = (-dy / d) * this.strafe, sy = (dx / d) * this.strafe;
        const base = typeof s.botInput === 'function' ? s.botInput() : [0, 0];
        const x = sx * 0.6 + base[0] * 0.4, y = sy * 0.6 + base[1] * 0.4;
        const l = Math.hypot(x, y) || 1;
        return [x / l, y / l];
      }
      const boss = s.enemies.find((e) => e.isBoss && e.alive);
      if (boss && boss.state === 'windup' && boss.nextMove === 'mortar') {
        // Mortars will target where the hero stands when the volley fires: keep moving sideways.
        const dx = hero.x - boss.x, dy = hero.y - boss.y, d = Math.hypot(dx, dy) || 1;
        let sx = (-dy / d) * this.strafe, sy = (dx / d) * this.strafe;
        // flip the strafe direction near the arena edges so we do not pin ourselves
        // (arena = world minus 42 px left/right, 164 px top, 38 px bottom; camera bounds = world)
        let b = null;
        try {
          const cb = s.cameras.main.getBounds();
          b = { x0: 46, y0: 168, x1: cb.width - 46, y1: cb.height - 42 };
        } catch {}
        if (b && (hero.x + sx * 40 < b.x0 || hero.x + sx * 40 > b.x1 || hero.y + sy * 40 < b.y0 || hero.y + sy * 40 > b.y1)) {
          this.strafe = -this.strafe;
          sx = -sx;
          sy = -sy;
        }
        return [sx * 0.9 + (dx / d) * 0.3, sy * 0.9 + (dy / d) * 0.3].map((v, _, arr) => v / (Math.hypot(arr[0], arr[1]) || 1));
      }
      return typeof s.botInput === 'function' ? s.botInput() : [0, 0];
    },
    patch(scene) {
      if (this.patched) return;
      const self = this;
      this.patched = { scene, moveInput: scene.moveInput };
      scene.moveInput = function () {
        if (this.mode !== 'play' && this.mode !== 'countdown') return [0, 0];
        try {
          return self.smartInput(this);
        } catch (e) {
          return typeof this.botInput === 'function' ? this.botInput() : [0, 0];
        }
      };
    },
    unpatch() {
      if (!this.patched) return;
      this.patched.scene.moveInput = this.patched.moveInput;
      this.patched = null;
    },
    key(code, key) {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      const init = { code, key, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keydown', init));
      window.dispatchEvent(new KeyboardEvent('keyup', init));
    },
    keepAlive() {
      if (Math.random() < 0.02) this.strafe = -this.strafe; // vary the strafe side now and then
      if (Date.now() < this.keepAliveAt) return;
      this.keepAliveAt = Date.now() + rand(cfg.keepAliveMin, cfg.keepAliveMax) * SEC;
      this.key('KeyX', 'x');
    },
    tick() {
      const s = this.scene();
      const farm = G.q.farm;
      if (!s || !farm) return this.disengage('no scene');
      if (G.Ca.blocked) return;
      const age = Date.now() - this.since;

      if (this.phase === 'go') {
        if (G.U.place !== 'battle') {
          const btn = $('[data-action="go-battle"]');
          if (btn && age > 500) btn.click();
          if (age > 15 * SEC) return this.disengage('could not open the arena');
          return;
        }
        if (!G.Pg.scene.isActive('battle')) return;
        if (s.run.active) return this.setPhase('run');
        const lobby = $('#battle-ui [data-b="start"]');
        if (lobby) {
          if ($('#battle-ui .bnote')) {
            this.capDay = this.today();
            return this.disengage("today's loot is already collected");
          }
          if (age > 800) {
            lobby.click();
            this.setPhase('starting');
          }
          return;
        }
        if (age > 20 * SEC) return this.disengage('lobby did not appear');
        return;
      }

      if (this.phase === 'starting') {
        if (s.run.active) {
          stats.battles++;
          this.dodges = 0;
          this.projEvades = 0;
          this.projDodges = 0;
          this.threatEvades = 0;
          this.threatDodges = 0;
          log(`Battle run started (energy ${farm.today.energy}).`);
          return this.setPhase('run');
        }
        if (age > 10 * SEC) return this.disengage('run did not start (energy?)');
        return;
      }

      if (this.phase === 'run') {
        if (s.mode === 'countdown' || s.mode === 'play') {
          this.patch(s);
          this.keepAlive();
          if (document.hidden && !this.hiddenWarned) {
            this.hiddenWarned = true;
            log('Tab hidden: the game pauses battle runs while hidden.', 'bad');
          }
          const wantOut = s.run.capHit || s.wave >= cfg.maxWave || this.stopRequested;
          if (wantOut && !this.retreating && s.mode === 'play') {
            this.retreating = true;
            log(this.stopRequested ? 'Stop requested: retreating.' : s.run.capHit ? 'Loot cap reached: retreating.' : `Wave ${s.wave} reached: retreating.`);
            this.key('Escape', 'Escape');
          }
          return;
        }
        if (s.mode === 'perk') {
          const btns = [...document.querySelectorAll('#battle-ui [data-perk]')];
          if (!btns.length) return;
          const lowHp = s.hero && s.hero.stats && s.hero.hp / s.hero.stats.maxHp < cfg.battleCautionHp;
          const pri = lowHp ? ['guard', 'dash', ...(cfg.perkPriority || [])] : cfg.perkPriority || [];
          const offered = new Map(btns.map((b) => [b.dataset.perk, b]));
          const chosen = pri.find((id) => offered.has(id));
          const pick = chosen ? offered.get(chosen) : btns[Math.floor(Math.random() * btns.length)];
          if (age > 600) {
            pick.click();
            log(`Wave ${s.wave} cleared, perk: ${pick.dataset.perk}`);
            this.since = Date.now();
          }
          return;
        }
        if (s.mode === 'pause') {
          if (this.retreating) {
            const y = $('#battle-ui [data-b="yes"]');
            const r = $('#battle-ui [data-b="retreat"]');
            if (y) y.click();
            else if (r) r.click();
          } else if (!document.hidden) {
            const res = $('#battle-ui [data-b="resume"]');
            if (res && age > 1500) res.click();
          }
          return;
        }
        if (s.mode === 'over') {
          if (s.run.capHit) this.capDay = this.today();
          this.lastLoot = s.run.loot;
          this.unpatch();
          this.retreating = false;
          log(`Run over: wave ${s.wave}, ${s.run.kills} kills, loot ${Math.round(s.run.loot)}, ${this.dodges} mortar dodges, ${this.projDodges} shot dodges (${this.projEvades} frames evading), ${this.threatDodges} bomb/bat/low-hp dashes${s.run.died ? ', died' : ''}.`);
          return this.setPhase('summary');
        }
        if (s.mode === 'lobby') return this.setPhase('go');
        return;
      }

      if (this.phase === 'summary') {
        if (age < 1500) return;
        if (farm.today.energy < 5 && cfg.autoEnergy && cfg.energyForBattle && G.energyPrice && !this.stopRequested && this.capDay !== this.today()) {
          Farm.rollDay(farm, G.W.now());
          const p = Core.battleEnergyPlan({ farm, h: helpers(), cfg, lastLoot: this.lastLoot, boughtToday: Farm.boughtToday });
          if (p.buy) Farm.purchase(farm, G.W.now(), p.buy, `battle: ${p.reason}`, true);
          else log(`No energy bought for battle: ${p.reason}.`);
        }
        const why = this.blockReason(farm);
        if (!why && !G.Ca.blocked) {
          const again = $('#battle-ui [data-b="again"]');
          if (again) {
            again.click();
            return this.setPhase('starting');
          }
        }
        return this.disengage(why || 'back to the farm');
      }
    },
  };

  // ------------------------------------------------------------------ RUNNER
  let running = false;
  let loopId = 0;
  async function loop(myId) {
    while (running && myId === loopId) {
      try {
        Farm.step();
      } catch (e) {
        noteError('farm', e);
      }
      Panel.refresh();
      await sleep(Pacer.delay());
    }
  }
  function start() {
    if (running) return;
    if (!G && !attach()) {
      Panel.refresh();
      return log(hookProblems.length ? `Hook wrong for this build: ${hookProblems.join('; ')}` : 'window.__fs missing: add the hook line to the game bundle.', 'bad');
    }
    Planner.load();
    running = true;
    loopId++;
    log(`Bot started (farmers ${G.Ca.farmers}, check mode ${G.Ca.status.mode}).`, 'good');
    Panel.refresh(true);
    loop(loopId);
  }
  function stop() {
    running = false;
    Farm.status = 'stopped';
    log('Bot stopped.');
    Panel.refresh(true);
  }

  // ------------------------------------------------------------------- PANEL
  const CSS = `
#fsbot{position:fixed;right:12px;bottom:12px;width:380px;max-height:72vh;z-index:99999;font:12px/1.4 system-ui,sans-serif;color:#1d2a1a;background:#fbf7ea;border:2px solid #5a4631;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden}
#fsbot.min .fb-body,#fsbot.min .fb-tabs{display:none}
#fsbot .fb-head{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#5a4631;color:#fbf7ea;cursor:move;user-select:none}
#fsbot .fb-head b{flex:1}
#fsbot .fb-head a.help{background:#d9a400;color:#1d2a1a;text-decoration:none;border-radius:5px;padding:3px 8px;font-weight:700}
#fsbot .fb-head button,#fsbot .fb-tabs button{background:#8a6d4a;color:#fff;border:0;border-radius:5px;padding:3px 8px;cursor:pointer;font:inherit}
#fsbot .fb-tabs{display:flex;gap:4px;padding:6px 8px 0}
#fsbot .fb-tabs button.on{background:#2f7d3a}
#fsbot .fb-body{padding:8px;overflow:auto}
#fsbot .row{display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px dashed #d8cfb8}
#fsbot .row span:last-child{font-weight:600;text-align:right}
#fsbot .bad{color:#b3261e}#fsbot .good{color:#2f7d3a}
#fsbot .btn{background:#2f7d3a;color:#fff;border:0;border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer}
#fsbot .btn.stop{background:#b3261e}#fsbot .btn.sm{padding:3px 8px;background:#8a6d4a}#fsbot .btn.battle{background:#7a3b8f}
#fsbot .ctl{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
#fsbot label.tg{display:flex;align-items:center;gap:4px}
#fsbot h4{margin:8px 0 2px;font-size:12px;color:#5a4631}
#fsbot details{margin:8px 0 0;border:1px solid #d8cfb8;border-radius:6px;background:#fffdf5}
#fsbot details>summary{cursor:pointer;padding:5px 8px;font-weight:700;color:#5a4631;list-style:none;display:flex;justify-content:space-between}
#fsbot details>summary::after{content:'+';color:#8a6d4a}
#fsbot details[open]>summary::after{content:'–'}
#fsbot details>*:not(summary){margin-left:8px;margin-right:8px}
#fsbot details>.row:last-child,#fsbot details>p:last-child{margin-bottom:6px}
#fsbot table{width:100%;border-collapse:collapse;margin-top:6px}
#fsbot th,#fsbot td{padding:3px 4px;border-bottom:1px solid #e3dac4;text-align:left;vertical-align:middle}
#fsbot tr.sel td{background:#fff3c4}
#fsbot tr.err td{background:#ffd9d6}
#fsbot select{max-width:170px;font:inherit}
#fsbot svg{display:block;margin:6px auto;background:#e9e1cc;border:1px solid #c7b995;border-radius:4px}
#fsbot svg rect{fill:#8fc06a;stroke:#466b2d;cursor:pointer}
#fsbot svg rect.empty{fill:#d9c89a}#fsbot svg rect.ready{fill:#f2c94c}#fsbot svg rect.sel{stroke:#b3261e;stroke-width:2}
#fsbot svg text{font-size:7px;pointer-events:none;fill:#1d2a1a}
#fsbot .log{font:11px/1.35 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
#fsbot .log div{border-bottom:1px solid #eee;padding:1px 0}
#fsbot .hint{color:#6b5d47;font-size:11px}
`;

  const Panel = {
    el: null,
    tab: 'bot',
    sel: null,
    plannerTimer: null,
    mount() {
      if (this.el) return this.el;
      const st = document.createElement('style');
      st.textContent = CSS;
      document.head.appendChild(st);
      const el = (this.el = document.createElement('div'));
      el.id = 'fsbot';
      el.innerHTML = `<div class="fb-head"><b>FS bot</b>${HELP_URL ? `<a class="help" href="${HELP_URL}" target="_blank" rel="noopener">Help</a>` : ''}<button data-t="min">–</button></div>
<div class="fb-tabs"><button data-tab="bot" class="on">Bot</button><button data-tab="plan">Planner</button><button data-tab="log">Log</button></div>
<div class="fb-body"></div>`;
      document.body.appendChild(el);
      el.querySelector('[data-t="min"]').onclick = () => el.classList.toggle('min');
      el.querySelectorAll('[data-tab]').forEach((b) => {
        b.onclick = () => {
          this.tab = b.dataset.tab;
          el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
          this.render();
        };
      });
      this.drag(el, el.querySelector('.fb-head'));
      el.addEventListener('pointerdown', () => (this.pressing = true));
      document.addEventListener('pointerup', () => {
        if (!this.pressing) return;
        this.pressing = false;
        setTimeout(() => this.refresh(), 0); // after the click handler ran
      });
      logListeners.add(() => this.tab === 'log' && this.render());
      // keep the panel live even when the bot is stopped (farm loads, energy changes, battle phases)
      setInterval(() => this.refresh(), 2000);
      if (G && G.q && typeof G.q.subscribe === 'function') {
        try { G.q.subscribe(() => this.refresh()); } catch {}
      }
      this.render();
      return el;
    },
    drag(el, handle) {
      let sx, sy, ox, oy;
      handle.onmousedown = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        sx = e.clientX;
        sy = e.clientY;
        const r = el.getBoundingClientRect();
        ox = r.left;
        oy = r.top;
        const mv = (e) => {
          el.style.left = ox + e.clientX - sx + 'px';
          el.style.top = oy + e.clientY - sy + 'px';
          el.style.right = 'auto';
          el.style.bottom = 'auto';
        };
        const up = () => {
          document.removeEventListener('mousemove', mv);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', mv);
        document.addEventListener('mouseup', up);
      };
    },
    pressing: false,
    typing() {
      const a = document.activeElement;
      return !!a && this.el.contains(a) && (a.tagName === 'INPUT' && a.type !== 'checkbox' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
    },
    // Re-render the current tab. Skipped only while a mouse button is held inside the panel
    // (a rebuild between mousedown and click would eat the click) or a field is being edited.
    refresh(force = false) {
      if (!this.el) return;
      if (!force && (this.pressing || this.typing())) return;
      if (this.tab === 'bot') this.renderBot();
      else if (this.tab === 'plan') this.renderPlan();
    },
    body() {
      return this.el.querySelector('.fb-body');
    },
    render() {
      if (!this.el) return;
      clearInterval(this.plannerTimer);
      if (this.tab === 'bot') this.renderBot();
      else if (this.tab === 'plan') {
        this.renderPlan();
        this.plannerTimer = setInterval(() => this.tab === 'plan' && this.refresh(), 5000);
      } else this.renderLog();
    },
    esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
    renderBot() {
      const b = this.body();
      if (!G) {
        const helpLink = HELP_URL ? `<p><a class="btn" style="display:inline-block;text-decoration:none" href="${HELP_URL}" target="_blank" rel="noopener">Open the helper site</a></p>` : `<p class="hint">Generate the line with <code>node make-hook.mjs game-xxxx.js</code>.</p>`;
        b.innerHTML = hookProblems.length
          ? `<p class="bad">The hook line is for an older game build. These entries point at the wrong thing:</p><ul>${hookProblems.map((p) => `<li class="bad">${this.esc(p)}</li>`).join('')}</ul><p class="hint">The game renames everything on each update. Generate a new line and redo the override with the current file.</p>${helpLink}`
          : `<p class="bad">Hook line not found (window.__fs).</p><p class="hint">Usually DevTools was closed, so the override did not apply. Open DevTools, check the purple dot on the game file, reload. Or generate the line again.</p>${helpLink}`;
        return;
      }
      const farm = G.q.farm;
      const live = Pacer.live();
      const now = G.W.now();
      const reserve = farm ? Core.mealReserve(farm, now, helpers()) : 0;
      const ratio = isFinite(live.ratio) ? live.ratio.toFixed(2) : '–';
      const row = (k, v, cls = '') => `<div class="row"><span>${k}</span><span class="${cls}">${v}</span></div>`;
      const n = (v) => Math.round(v).toLocaleString();
      const proj = farm && G.cap ? Core.incomeProjection(farm, now, helpers()) : null;
      const accrued = farm && G.passive ? Math.floor(G.passive(farm, now)) : null;
      const d = farm ? Core.mealReserveDetail(farm, now, helpers()) : null;
      const open = (k) => (store.get('fsbot:open', {})[k] ? ' open' : '');
      const sec = (k, title, inner) => `<details data-sec="${k}"${open(k)}><summary>${title}</summary>${inner}</details>`;
      const cb = (key, label, title = '', disabled = false) => `<label class="tg" title="${this.esc(title)}"><input type="checkbox" data-c="${key}" ${cfg[key] ? 'checked' : ''} ${disabled ? 'disabled' : ''}> ${label}</label>`;
      const energyLine = !farm ? 'waiting for your farm…' : G.energyPrice ? (cfg.autoEnergy ? (Farm.lastEnergyPlan ? (Farm.lastEnergyPlan.buy ? `next: buy ${Farm.lastEnergyPlan.buy} (${Farm.lastEnergyPlan.reason})` : Farm.lastEnergyPlan.reason) : 'waiting for first tick') : 'auto-buy off') : 'price function not in hook';
      b.innerHTML = `
<div class="ctl">${running ? '<button class="btn stop" data-a="stop">Stop farming</button>' : '<button class="btn" data-a="start">Start farming</button>'}
${Battle.engaged ? '<button class="btn stop" data-a="battleStop">Stop battle</button>' : (() => { const why = farm ? Battle.blockReason(farm) : null; return `<button class="btn battle" data-a="battle" ${why ? 'disabled title="' + this.esc(why) + '"' : ''}>Battle</button>${why ? `<span class="hint bad">${this.esc(why)}</span>` : ''}`; })()}</div>
${row('Farming', this.esc(running ? Farm.status : 'stopped'), running ? 'good' : '')}
${row('Battle', Battle.engaged ? `running · ${this.esc(Battle.phase)}` : farm && G.battleCap ? `off · loot today ${Math.round(farm.today.battleEarned ?? 0)} / ${Math.round(G.battleCap(farm))}` : 'off', Battle.engaged ? 'good' : '')}
${row('Energy', farm ? `${farm.today.energy}${d && d.energy ? ` · meals still need ${d.energy}` : ''}` : '–')}
${row('Human check', `${G.Ca.status.mode}${G.Ca.blocked ? ' · <b class="bad">GATE UP</b>' : ''}${G.Ca.status.verified ? '' : ' · unverified'}${stats.flags ? ` · <b class="bad">${stats.flags} flag(s)</b>` : ''}`, G.Ca.blocked || stats.flags ? 'bad' : '')}
${row('Pace', `${live.perMin}/${live.allowed} per min · variation ${ratio}`, live.perMin > live.allowed * cfg.budgetFraction || (isFinite(live.ratio) && live.ratio < cfg.minCv) ? 'bad' : '')}

${sec('farm', 'Farming options', `
<div class="ctl">${cb('bulk', 'batch jobs', 'Feed all, Collect all, Harvest all, Plant all in one burst each, as the game\'s own buttons do. Fields: 2 energy for the whole batch. Animals: the game charges 2 per building per meal whatever you do; the burst just counts as one job for pacing.')}
<label class="tg" title="A ready field is left standing while other fields will ripen within this many minutes, so one Harvest all covers them for 2 energy. Feeding, collecting and fruit still happen meanwhile."><input type="checkbox" data-c="waitForBatch" ${cfg.waitForBatch ? 'checked' : ''}> wait up to <input type="number" min="1" max="60" step="1" value="${cfg.waitMinutes}" data-n="waitMinutes" style="width:46px"> min to harvest together</label>
${cb('capAware', 'cap-aware planting', 'Plant cash crops only while they fit under today\'s harvest cap; otherwise silo crops.')}
${cb('plantKeepsReserve', 'keep energy for meals', 'Planting waits while energy − 2 would drop under what today\'s remaining animal meals need. Off: plant whenever 2 energy is available; hungry animals are still fed first.')}
${cb('claim', 'village income', 'Collect town-hall income automatically.')}</div>
${d ? `<p class="hint">Meal reserve now: ${this.esc(d.text)} (${d.windowsLeft} meal window${d.windowsLeft === 1 ? '' : 's'} left today).</p>` : ''}`)}

${sec('energy', `Energy purchases · ${cfg.autoEnergy ? 'on' : 'off'}`, `
<div class="ctl">${cb('autoEnergy', 'auto-buy energy', 'Master switch.')}</div>
<div class="ctl"><span class="hint">buy for:</span>
${cb('energyForMeals', 'meals', 'Today\'s remaining animal meals.', !cfg.autoEnergy)}
${cb('energyForWaiting', 'waiting harvests', 'Ready crops, ripe fruit, products, full mine, today\'s oil.', !cfg.autoEnergy)}
${cb('energyForCycles', 'extra crop cycles', 'Cycles that fit under today\'s cap and earn at least the margin over their energy cost.', !cfg.autoEnergy)}
${cb('energyForBattle', 'battle runs', 'Between runs, 5 more while the loot cap is open and the last run paid off.', !cfg.autoEnergy)}</div>
<div class="ctl">${cb('energyTopUp', 'buy ahead for the cycles of the day', 'Off: buy just the shortfall, rounded up to the minimum (10). On: when a purchase happens, also cover the crop cycles that still fit under the cap today, so buys are bigger and rarer.', !cfg.autoEnergy)}</div>
${row('Plan', this.esc(energyLine), cfg.autoEnergy && Farm.lastEnergyPlan && Farm.lastEnergyPlan.buy ? 'good' : '')}
${farm && G.energyPrice ? row('Price', `${(G.energyPrice(farm, 10) / 10).toFixed(2)} tokens each`) + row('Bought today / total', `${Farm.boughtToday} / ${stats.energyBought} (${n(stats.energySpent)} tokens)`) + row('Amount', cfg.energyTopUp ? `shortfall + cycles ahead, ${cfg.energyMinBuy}–${cfg.energyMaxBuy} per buy` : `the shortfall, rounded up to ${cfg.energyMinBuy} (max ${cfg.energyMaxBuy})`) + row('Limits', `${cfg.energyMaxPerDay}/day · ≤${Math.round(cfg.energyTokenFraction * 100)}% of wallet · cycles need ${cfg.energyMargin}× their cost`) : ''}`)}

${sec('cap', `Harvest cap today${proj ? ` · ${n(proj.total)} / ${n(proj.cap)}` : ''}`, !farm ? '<p class="hint">waiting for your farm…</p>' : proj ? row('Earned', n(proj.earned)) + (proj.carry ? row('Carried to tomorrow', n(proj.carry)) : '') + row('Ready / growing crops', `${n(proj.ready)} / ${n(proj.growing)}`) + row('Orchard fruit', n(proj.trees)) + row('Animal products', n(proj.animals)) + row('Room for cash crops', proj.total >= proj.cap ? 'none: silo crops only' : n(proj.room), proj.total >= proj.cap ? 'bad' : 'good') + row('Silo', proj.siloOk ? 'has room' : 'full or missing') : '<p class="hint">cap function not in hook: regenerate the hook line</p>')}

${sec('stats', 'Counters', row('Jobs sent / held', `${stats.jobs} (${stats.bulk} batches) / ${stats.refused}`) + row('Farmers', G.Ca.farmers) + row('Battle runs', stats.battles) + row('Village income', accrued == null ? '–' : `${n(accrued)} accrued · collected ${stats.claims}× (${n(stats.claimed)})`) + row('Flags seen', stats.flags ? `${stats.flags} · ${this.esc(stats.lastFlag)}` : '0', stats.flags ? 'bad' : 'good') + `<p class="hint">Delays ${cfg.delayMin}–${cfg.delayMax}s, idle ${cfg.idleMin}–${cfg.idleMax}s. Advanced: <code>__bot.cfg</code> then <code>__bot.save()</code>.</p>`)}`;
      // Store the open/closed state on the click itself (the native toggle event is async and a
      // refresh can rebuild the panel before it fires), then re-render from the stored state.
      b.querySelectorAll('details[data-sec] > summary').forEach((sum) => {
        sum.addEventListener('click', (e) => {
          e.preventDefault();
          const el = sum.parentElement;
          const o = store.get('fsbot:open', {});
          o[el.dataset.sec] = !el.open;
          store.set('fsbot:open', o);
          this.refresh(true);
        });
      });
      b.querySelector('[data-a="start"]')?.addEventListener('click', start);
      b.querySelector('[data-a="stop"]')?.addEventListener('click', stop);
      b.querySelector('[data-a="battle"]')?.addEventListener('click', () => Battle.begin());
      b.querySelector('[data-a="battleStop"]')?.addEventListener('click', () => Battle.end());
      b.querySelectorAll('[data-c]').forEach((i) => {
        i.onchange = () => {
          cfg[i.dataset.c] = i.checked;
          saveCfg();
          log(`${i.dataset.c}: ${i.checked ? 'on' : 'off'}`);
          this.render();
        };
      });
      b.querySelectorAll('[data-n]').forEach((i) => {
        i.onchange = () => {
          const v = Number(i.value);
          if (Number.isFinite(v) && v > 0) {
            cfg[i.dataset.n] = v;
            saveCfg();
            log(`${i.dataset.n}: ${v}`);
            this.render();
          }
        };
      });
    },
    renderPlan() {
      const b = this.body();
      const farm = G && G.q.farm;
      if (!farm) {
        b.innerHTML = '<p class="bad">Open a farm first.</p>';
        return;
      }
      Planner.load();
      const now = G.W.now();
      const crops = G.te || [];
      const opts = (cur) =>
        [`<option value="auto" ${cur === 'auto' || !cur ? 'selected' : ''}>Auto (replant last)</option>`]
          .concat(crops.map((c) => `<option value="${c.id}" ${cur === c.id ? 'selected' : ''}>${this.esc(Core.cropLabel(c, farm, G.hr, G.de))}</option>`))
          .join('');
      const state = (f) => {
        if (!Core.isBuilt(f, now)) return 'preparing';
        const s = G.or(f, now);
        if (s.state === 'empty') return 'empty';
        if (s.state === 'ready') return `ready · ${s.crop.name}`;
        const left = Math.max(0, Math.round(s.remainingMs / 60000));
        return `${s.crop.name} · ${Core.fmtMinutes(left)} left`;
      };
      const rows = farm.fields
        .map((f, i) => {
          const err = Planner.errors[f.id];
          const cls = `${this.sel === f.id ? 'sel' : ''} ${err ? 'err' : ''}`;
          const last = Planner.last[f.id] ? crops.find((c) => c.id === Planner.last[f.id])?.name ?? Planner.last[f.id] : '–';
          return `<tr class="${cls}" data-f="${f.id}"><td>${i + 1}</td><td>${f.x},${f.y}</td><td>${this.esc(state(f))}</td><td>${this.esc(last)}</td><td><select data-f="${f.id}">${opts(Planner.plan[f.id])}</select>${err ? `<div class="bad">${this.esc(err)}</div>` : ''}</td></tr>`;
        })
        .join('');
      const xs = farm.fields.map((f) => f.x), ys = farm.fields.map((f) => f.y);
      const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
      const cell = 14, pad = 4;
      const w = (maxX - minX + 1) * cell + pad * 2, h = (maxY - minY + 1) * cell + pad * 2;
      const tiles = farm.fields
        .map((f, i) => {
          const st = Core.isBuilt(f, now) ? G.or(f, now).state : 'building';
          const x = pad + (f.x - minX) * cell, y = pad + (f.y - minY) * cell;
          return `<rect data-f="${f.id}" class="${st} ${this.sel === f.id ? 'sel' : ''}" x="${x}" y="${y}" width="${cell - 1}" height="${cell - 1}"></rect><text x="${x + 2}" y="${y + 9}">${i + 1}</text>`;
        })
        .join('');
      const proj = G.cap ? Core.incomeProjection(farm, now, helpers()) : null;
      const fp = G.feedPerMeal ? Core.feedPlan(farm, now, helpers(), cfg) : null;
      const feedBox = !G.feedPerMeal
        ? '<p class="hint">feed function not in hook: regenerate the hook line</p>'
        : !fp
          ? '<p class="hint">No animals yet.</p>'
          : `<div class="row"><span>Animals eat</span><span>${fp.dailyNeed} bags/day · ${fp.remainingToday} still to eat today</span></div>
<div class="row"><span>Feed bags</span><span class="${fp.bags < fp.dailyNeed ? 'bad' : 'good'}">${fp.bags} (${fp.daysCovered === Infinity ? '∞' : fp.daysCovered.toFixed(1)} days with grain)</span></div>
<div class="row"><span>Grain in silo</span><span>${fp.wheat} wheat · ${fp.corn} corn → ${fp.pairs * 10} bags mixable</span></div>
<div class="row"><span>Growing now</span><span>${fp.growingW} wheat · ${fp.growingC} corn fields</span></div>
<div class="row"><span>Still to grow (target ${fp.target} bags)</span><span class="${fp.wheatNeed + fp.cornNeed ? '' : 'good'}">${fp.wheatNeed} wheat · ${fp.cornNeed} corn</span></div>
<div class="row"><span>Next empty field</span><span>${!fp.siloOk ? 'no silo built' : fp.next ? `<b>${fp.next}</b> (feed first)` : "your plan's crop (feed covered)"}</span></div>`;
      b.innerHTML = `
<h4>Feed for the animals</h4>
<div class="ctl"><label class="tg"><input type="checkbox" data-c="feedFirst" ${cfg.feedFirst ? 'checked' : ''}> feed first</label>
<label class="tg">today's remaining meals + <input type="number" min="0" max="7" step="1" value="${cfg.feedExtraDays}" data-n="feedExtraDays" style="width:46px"> extra day(s)</label>
<label class="tg"><input type="checkbox" data-c="mixFeed" ${cfg.mixFeed ? 'checked' : ''}> auto-mix bags</label></div>
${feedBox}
<p class="hint">With "feed first" on, every empty field grows wheat or corn (whichever is shorter) until bags plus mixable grain cover the meals your animals still have coming today (plus the extra days above), counting fields already growing grain. After that the field gets the crop you chose below. Grain never counts against the harvest cap.</p>
<h4>Crop plan</h4>
<div class="ctl"><span class="hint">Fill all:</span>
<button class="btn sm" data-s="perHour">Best /h</button><button class="btn sm" data-s="perHarvest">Best /harvest</button>
<button class="btn sm" data-s="wheat">Wheat</button><button class="btn sm" data-s="corn">Corn</button>
<button class="btn sm" data-s="alternate">Alternate</button><button class="btn sm" data-s="auto">Auto</button></div>
${proj ? `<p class="hint">Cap today ${Math.round(proj.cap).toLocaleString()} · projected ${Math.round(proj.total).toLocaleString()} ${proj.total >= proj.cap ? '<b class="bad">(cap reached: cash crops are swapped for silo crops)</b>' : `(${Math.round(proj.room).toLocaleString()} room)`}</p>` : ''}
${farm.fields.length ? `<svg width="${Math.min(360, w)}" height="${h}" viewBox="0 0 ${w} ${h}">${tiles}</svg>` : '<p class="hint">No fields yet.</p>'}
<table><thead><tr><th>#</th><th>x,y</th><th>Now</th><th>Last</th><th>Plant</th></tr></thead><tbody>${rows}</tbody></table>
<p class="hint">Value = this farm's harvest price per crop (before the daily cap). Quick crops earn more per hour, slow crops more per harvest. Silo crops feed animals and are never capped.</p>`;
      b.querySelectorAll('[data-c]').forEach((i) => {
        i.onchange = () => {
          cfg[i.dataset.c] = i.checked;
          saveCfg();
          log(`${i.dataset.c}: ${i.checked ? 'on' : 'off'}`);
          this.renderPlan();
        };
      });
      b.querySelectorAll('[data-n]').forEach((i) => {
        i.onchange = () => {
          const v = Number(i.value);
          if (Number.isFinite(v) && v >= 0) {
            cfg[i.dataset.n] = v;
            saveCfg();
            log(`${i.dataset.n}: ${v}`);
            this.renderPlan();
          }
        };
      });
      b.querySelectorAll('select[data-f]').forEach((s) => {
        s.onchange = () => {
          Planner.set(s.dataset.f, s.value);
          log(`Plan: field ${farm.fields.findIndex((f) => f.id === s.dataset.f) + 1} → ${s.value}`);
          this.renderPlan();
        };
      });
      b.querySelectorAll('[data-s]').forEach((btn) => {
        btn.onclick = () => {
          Planner.fill(btn.dataset.s);
          log(`Plan filled: ${btn.dataset.s}`);
          this.renderPlan();
        };
      });
      b.querySelectorAll('svg rect, tr[data-f]').forEach((r) => {
        r.onclick = (e) => {
          if (e.target.tagName === 'SELECT') return;
          this.sel = this.sel === r.dataset.f ? null : r.dataset.f;
          this.renderPlan();
        };
      });
    },
    renderLog() {
      const b = this.body();
      b.innerHTML = `<div class="log">${LOG.slice()
        .reverse()
        .map((e) => `<div class="${e.level}">${new Date(e.t).toLocaleTimeString()} ${this.esc(e.msg)}</div>`)
        .join('')}</div>`;
    },
  };

  // --------------------------------------------------------------- BOOTSTRAP
  window.__bot = { start, stop, battle: () => Battle.begin(), stopBattle: () => Battle.end(), cfg, save: saveCfg, Core, Planner, Battle, Farm, stats, log: LOG, panel: () => Panel.mount() };

  (async () => {
    const t0 = Date.now();
    let attached = false;
    while (!attached) {
      try {
        attached = attach();
      } catch (e) {
        log(`attach failed: ${e.message}`, 'bad');
        help('attach failed: ' + e.message);
        break;
      }
      if (attached || Date.now() - t0 > 30 * SEC) break;
      await sleep(500);
    }
    Panel.mount();
    if (G) {
      Planner.load();
      log('Ready. Hook found. Press Start.');
    } else if (hookProblems.length) {
      log(`Hook found but wrong for this build: ${hookProblems.join('; ')}. Generate a new line.`, 'bad');
      help('hook line is for an older game build');
    } else {
      log('window.__fs not found after 30 s. Add the hook line and reload.', 'bad');
      help('hook line missing');
    }
  })();
})();
