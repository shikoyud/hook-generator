// ==UserScript==
// @name         Farming Season bot
// @namespace    fs-bot
// @version      0.3.0
// @description  Automation for Farming Season: farm loop, crop planner, cap-aware planting, village income, battle runs. Stays inside the game's human-check rules.
// @match        https://farmingseason.io/*
// @match        https://*.farmingseason.io/*
// @homepageURL  __HELP_URL__
// @downloadURL  __HELP_URL__/farmbot.user.js
// @updateURL    __HELP_URL__/farmbot.user.js
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
  // Stamped by the helper site when it serves this file; empty when run from a local copy.
  const HELP_URL = /^https?:/.test('__HELP_URL__') ? '__HELP_URL__' : '';

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
    // energy purchases (see Core.energyPlan)
    autoEnergy: false, // off until you turn it on in the panel
    energyMargin: 1.5, // a plant+harvest cycle must return at least this × its energy cost
    energyBuyBelow: 8, // consider buying once energy is under this
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
    perkPriority: [],
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

    // Energy to keep for the remaining meals today (2 per animal building per unfed window).
    mealReserve(farm, now, h) {
      const win = Core.mealWindow(now, farm.tz);
      const morning = win.endsWith('S');
      let n = 0;
      for (const s of farm.structures) {
        const b = h.Fe[s.kind];
        if (!b || !b.animal) continue;
        if (!farm.animals.some((a) => a.kind === b.animal)) continue;
        n += (s.fedWindow === win ? 0 : 1) + (morning ? 1 : 0);
      }
      return n * 2;
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

      for (const f of farm.fields) {
        if (!Core.isBuilt(f, now) || !free(`field:${f.id}`)) continue;
        const st = h.or(f, now);
        if (st.state === 'ready') {
          return { job: { type: 'harvest', fieldId: f.id }, key: `field:${f.id}`, why: 'ready', crop: st.crop && st.crop.id };
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

      const reserve = Core.mealReserve(farm, now, h);
      if (energy - 2 < reserve) return null;
      const proj = cfg.capAware !== false && h.cap ? Core.incomeProjection(farm, now, h) : null;
      // A cash crop is planted only if its value still fits under today's cap.
      const fits = (cropId) => {
        if (!proj) return true;
        const c = h.crops.find((x) => x.id === cropId);
        return proj.total + (c ? h.hr(farm, c) : 0) <= proj.cap;
      };
      for (const f of farm.fields) {
        if (!Core.isBuilt(f, now) || !free(`field:${f.id}`)) continue;
        if (h.or(f, now).state !== 'empty') continue;
        let crop = Core.resolveCrop(f.id, plan, last, h.crops, cfg);
        if (!crop) continue;
        let why = plan[f.id] && plan[f.id] !== 'auto' ? 'plan' : 'auto';
        if (proj) {
          if (h.de(crop)) {
            if (!proj.siloOk && !fits(crop)) continue; // would sell as cash over the cap
          } else if (!fits(crop)) {
            if (!proj.siloOk) continue;
            crop = Core.siloCropChoice(farm);
            why = 'cap reached: silo crop';
          }
        }
        return { job: { type: 'plant', fieldId: f.id, crop }, key: `field:${f.id}`, why };
      }
      return null;
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
      if (energy >= cfg.energyBuyBelow) return { ...out, reason: `energy ${energy} ≥ ${cfg.energyBuyBelow}` };
      const pricePer = h.energyPrice(farm, 10) / 10;
      out.pricePer = pricePer;

      // 1. waiting work
      const win = Core.mealWindow(now, farm.tz);
      let need = Core.mealReserve(farm, now, h);
      for (const f of farm.fields) if (f.crop && Core.isBuilt(f, now) && h.or(f, now).state === 'ready') need += 2;
      for (const s of farm.structures) {
        if (!s.slots) continue;
        for (const slot of s.slots) if (slot.tree && h.Or(slot, now).state === 'ready') need += 2;
      }
      const readyKinds = new Set(farm.animals.filter((a) => a.productReady).map((a) => a.kind));
      for (const s of farm.structures) {
        const b = h.Fe[s.kind];
        if (b && b.animal && readyKinds.has(b.animal)) need += 2;
      }
      void win;
      out.need = need;

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
      let room = proj.room, cycles = 0;
      const cycleCost = 4 * pricePer * cfg.energyMargin;
      for (const v of candidates) {
        if (v > room) break; // would only pile into tomorrow's carry
        if (v < cycleCost) break; // not worth the energy
        room -= v;
        cycles++;
      }
      out.cycles = cycles;
      out.cycleEnergy = cycles * 4;

      const target = need + cycles * 4;
      let shortfall = target - energy;
      if (shortfall <= 0) return { ...out, reason: `energy ${energy} covers ${need} waiting + ${cycles} cycles` };

      // amount: at least energyMinBuy, at most energyMaxBuy, within the daily cap and the wallet
      let buy = Math.min(cfg.energyMaxBuy, Math.max(cfg.energyMinBuy, Math.ceil(shortfall / 10) * 10));
      buy = Math.min(buy, Math.max(0, cfg.energyMaxPerDay - boughtToday));
      if (buy <= 0) return { ...out, reason: `daily limit ${cfg.energyMaxPerDay} reached` };
      const wallet = Math.max(0, (farm.tokens || 0) - cfg.energyTokenKeep);
      const budget = Math.floor(wallet * cfg.energyTokenFraction);
      while (buy > 0 && h.energyPrice(farm, buy) > budget) buy -= 10;
      if (buy < Math.min(cfg.energyMinBuy, 10)) return { ...out, reason: `wallet ${farm.tokens} too low (budget ${budget})` };
      return { ...out, buy, reason: `${need} for waiting work + ${cycles * 4} for ${cycles} cycles − ${energy} on hand` };
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
  const stats = { flags: 0, lastFlag: '', jobs: 0, refused: 0, battles: 0, claims: 0, claimed: 0, energyBought: 0, energySpent: 0 };

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
    boughtDay: null,
    boughtToday: 0,
    buyEnergy(farm, now) {
      if (!cfg.autoEnergy || !G.energyPrice) return;
      const day = Core.mealWindow(now, farm.tz).slice(0, 10);
      if (this.boughtDay !== day) {
        this.boughtDay = day;
        this.boughtToday = 0;
      }
      const p = Core.energyPlan({ farm, now, h: helpers(), cfg, plan: Planner.plan, last: Planner.last, boughtToday: this.boughtToday });
      this.lastEnergyPlan = p;
      if (!p.buy || now - this.lastBuyAt < cfg.energyBuyEvery * SEC) return;
      const cost = G.energyPrice(farm, p.buy);
      this.lastBuyAt = now;
      // Same op the shop's "Buy" button uses. Not a farmer job: not counted by recordJob.
      const r = G.q.op('buyEnergy', p.buy);
      if (r.ok) {
        this.boughtToday += p.buy;
        stats.energyBought += p.buy;
        stats.energySpent += cost;
        log(`Bought ${p.buy} energy for ${cost} tokens (${p.reason}).`, 'good');
      } else log(`Energy purchase refused: ${r.msg}`, 'bad');
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
      this.buyEnergy(farm, now);
      this.lastProj = G.cap ? Core.incomeProjection(farm, now, helpers()) : null;

      const pending = G.U.pendingJobs().length;
      if (pending >= cfg.maxPending) return (this.status = `farmer busy (${pending} queued)`);

      const pick = Core.pickJob({ farm, now, queued: G.U.queued, plan: Planner.plan, last: Planner.last, cfg, h: helpers(), skip: this.skip });

      if (!pick) {
        this.status = 'idle';
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
    dodges: 0,
    projEvades: 0,
    projDodges: 0,

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
          const pri = cfg.perkPriority || [];
          const pick = btns.find((b) => pri.includes(b.dataset.perk)) || btns[Math.floor(Math.random() * btns.length)];
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
          this.unpatch();
          this.retreating = false;
          log(`Run over: wave ${s.wave}, ${s.run.kills} kills, loot ${Math.round(s.run.loot)}, ${this.dodges} mortar dodges, ${this.projDodges} shot dodges (${this.projEvades} frames evading)${s.run.died ? ', died' : ''}.`);
          return this.setPhase('summary');
        }
        if (s.mode === 'lobby') return this.setPhase('go');
        return;
      }

      if (this.phase === 'summary') {
        if (age < 1500) return;
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
    loop(loopId);
  }
  function stop() {
    running = false;
    Farm.status = 'stopped';
    log('Bot stopped.');
    Panel.refresh();
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
      logListeners.add(() => this.tab === 'log' && this.render());
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
    refresh(force = false) {
      if (!this.el || this.tab !== 'bot') return;
      // Rebuilding the DOM while the person is on it eats clicks on the checkboxes.
      if (!force && (this.el.matches(':hover') || this.el.contains(document.activeElement))) return;
      this.render();
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
        this.plannerTimer = setInterval(() => this.tab === 'plan' && this.renderPlan(), 5000);
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
      b.innerHTML = `
<div class="ctl">${running ? '<button class="btn stop" data-a="stop">Stop farming</button>' : '<button class="btn" data-a="start">Start farming</button>'}
${Battle.engaged ? '<button class="btn stop" data-a="battleStop">Stop battle</button>' : '<button class="btn battle" data-a="battle">Battle</button>'}</div>
<div class="ctl"><label class="tg" title="Buy energy when it runs low, only for work that pays: waiting meals/harvests, plus extra crop cycles that fit under today's cap and return at least ${cfg.energyMargin}× their cost."><input type="checkbox" data-c="autoEnergy" ${cfg.autoEnergy ? 'checked' : ''}> auto-buy energy</label>
<label class="tg"><input type="checkbox" data-c="claim" ${cfg.claim ? 'checked' : ''}> village income</label>
<label class="tg"><input type="checkbox" data-c="capAware" ${cfg.capAware ? 'checked' : ''}> cap-aware planting</label></div>
${row('Farming', this.esc(running ? Farm.status : 'stopped'), running ? 'good' : '')}
${row('Battle', Battle.engaged ? `running · ${this.esc(Battle.phase)}` : this.esc(farm ? (Battle.blockReason(farm) ? `off (${Battle.blockReason(farm)})` : 'off · press Battle') : 'off'), Battle.engaged ? 'good' : '')}
${row('Human check', `${G.Ca.status.mode}${G.Ca.blocked ? ' · <b class="bad">GATE UP</b>' : ''}${G.Ca.status.verified ? '' : ' · unverified'}`)}
${row('Jobs / min', `${live.perMin} / ${live.allowed} (bot budget ${Math.floor(live.allowed * cfg.budgetFraction)})`, live.perMin > live.allowed * cfg.budgetFraction ? 'bad' : '')}
${row('Gap variation', `${ratio} (game flags &lt; 0.08, bot holds &lt; ${cfg.minCv}) · n=${live.n}`, isFinite(live.ratio) && live.ratio < cfg.minCv ? 'bad' : '')}
${row('Energy', farm ? `${farm.today.energy} (today's meals still need ${reserve})` : '–')}
${row('Farmers', G.Ca.farmers)}
${row('Jobs sent / held', `${stats.jobs} / ${stats.refused}`)}
${row('Flags seen', stats.flags ? `${stats.flags} · ${this.esc(stats.lastFlag)}` : '0', stats.flags ? 'bad' : 'good')}
${row('Battle runs', stats.battles)}
<h4>Harvest cap today</h4>
${proj ? row('Cap', n(proj.cap)) + row('Earned', n(proj.earned)) + (proj.carry ? row('Carried to tomorrow', n(proj.carry)) : '') + row('Ready / growing crops', `${n(proj.ready)} / ${n(proj.growing)}`) + row('Orchard fruit', n(proj.trees)) + row('Animal products', n(proj.animals)) + row('Projected total', `${n(proj.total)} (${proj.total >= proj.cap ? 'cap reached: silo crops only' : n(proj.room) + ' room for cash crops'})`, proj.total >= proj.cap ? 'bad' : 'good') + row('Silo', proj.siloOk ? 'has room' : 'full or missing') : '<p class="hint">cap functions not in hook</p>'}
<h4>Energy purchases</h4>
${G.energyPrice && farm ? row('Price', `${(G.energyPrice(farm, 10) / 10).toFixed(2)} tokens per energy`) + row('Bought today / total', `${Farm.boughtToday} / ${stats.energyBought} (${n(stats.energySpent)} tokens)`) + row('Policy', cfg.autoEnergy ? (Farm.lastEnergyPlan ? this.esc(Farm.lastEnergyPlan.buy ? `buy ${Farm.lastEnergyPlan.buy}: ${Farm.lastEnergyPlan.reason}` : Farm.lastEnergyPlan.reason) : 'waiting for first tick') : 'off', cfg.autoEnergy && Farm.lastEnergyPlan && Farm.lastEnergyPlan.buy ? 'good' : '') + row('Limits', `${cfg.energyMinBuy}–${cfg.energyMaxBuy} per buy · ${cfg.energyMaxPerDay}/day · ≤${Math.round(cfg.energyTokenFraction * 100)}% of wallet · margin ${cfg.energyMargin}×`) : '<p class="hint">price function not in hook</p>'}
<h4>Village income</h4>
${accrued == null ? '<p class="hint">passive function not in hook</p>' : row('Accrued', n(accrued)) + row('Collected by bot', `${stats.claims}× · ${n(stats.claimed)}`) + row('Next check', `every ${cfg.claimEvery} min, min ${cfg.claimMin}`)}
<p class="hint">Delays ${cfg.delayMin}–${cfg.delayMax}s (idle ${cfg.idleMin}–${cfg.idleMax}s, ${Math.round(cfg.idleChance * 100)}%). Edit via <code>__bot.cfg</code>, then <code>__bot.save()</code>.</p>`;
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
      b.innerHTML = `
<div class="ctl"><span class="hint">Fill all:</span>
<button class="btn sm" data-s="perHour">Best /h</button><button class="btn sm" data-s="perHarvest">Best /harvest</button>
<button class="btn sm" data-s="wheat">Wheat</button><button class="btn sm" data-s="corn">Corn</button>
<button class="btn sm" data-s="alternate">Alternate</button><button class="btn sm" data-s="auto">Auto</button></div>
${proj ? `<p class="hint">Cap today ${Math.round(proj.cap).toLocaleString()} · projected ${Math.round(proj.total).toLocaleString()} ${proj.total >= proj.cap ? '<b class="bad">(cap reached: cash crops are swapped for silo crops)</b>' : `(${Math.round(proj.room).toLocaleString()} room)`}</p>` : ''}
${farm.fields.length ? `<svg width="${Math.min(360, w)}" height="${h}" viewBox="0 0 ${w} ${h}">${tiles}</svg>` : '<p class="hint">No fields yet.</p>'}
<table><thead><tr><th>#</th><th>x,y</th><th>Now</th><th>Last</th><th>Plant</th></tr></thead><tbody>${rows}</tbody></table>
<p class="hint">Value = this farm's harvest price per crop (before the daily cap). Quick crops earn more per hour, slow crops more per harvest. Silo crops feed animals and are never capped.</p>`;
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
