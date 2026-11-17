'use strict';
/* ===== QUARTET engine: four tested strategies, one paper-trading replay =====
   rsi2   RSI(2) mean reversion, SPY + QQQ (daily, long only)
   ibs    IBS mean reversion,   SPY + QQQ (daily, long only)
   carry  Funding-rate carry,   BTC + ETH (long spot / short perp, delta neutral)
   st     Supertrend + BTC 200-day regime, 13 altcoins (daily, long and short)
   Pure functions, no network, no DOM. Rules ported from the tested Python backtests (Cell 1 and Cell 2). */
const DAY = 86400000, HOUR = 3600000;
const EQ_CLOSE_MS = 21 * HOUR;            // US cash close, stored as 21:00 UTC (20:00 UTC in summer; the 30-minute margin is added when judging "complete")
const EQ_COMPLETE_MS = 21.5 * HOUR;       // an equity daily bar counts as complete this long after its date starts

const DEFAULTS = {
  startEquity: 10000,                      // paper dollars PER strategy
  risk: 0.01,                              // fraction of equity risked per trade (rsi2, ibs, st)
  carryNotional: 0.4,                      // fraction of equity per coin held as spot (and the same short perp)
  gapFills: true,                          // stops that gap through fill at the open (worse), like real life
  enabled: { rsi2: true, ibs: true, carry: true, st: true },
  rsi2: { entry: 5, exit: 65, maxHold: 5, stopAtr: 2, sma: 200, cost: 0.001, maxPos: 0.5, maxGross: 1.0 },
  ibs: { entry: 0.05, exit: 0.75, maxHold: 7, stopAtr: 2, cost: 0.001, maxPos: 0.5, maxGross: 1.0 },
  carry: { k: 21, entry: 0.05, exit: 0.0, costSide: 0.002, maxGross: 1.0 },
  st: { period: 14, mult: 3, tpR: 3, maxHold: 30, regimeSma: 200, cost: 0.003, maxPos: 0.25, maxGross: 1.0 }
};

/* ---------- indicators (match the pandas versions used in the backtests) ---------- */
function atrW(h, l, c, n) {            // Wilder smoothing, pandas ewm(alpha=1/n, adjust=False, min_periods=n)
  const N = h.length, o = new Float64Array(N).fill(NaN), a = 1 / n; let prev = NaN;
  for (let i = 0; i < N; i++) {
    const tr = i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    prev = i === 0 ? tr : a * tr + (1 - a) * prev;
    if (i >= n - 1) o[i] = prev;
  }
  return o;
}
function rsiW(c, n) {
  const N = c.length, o = new Float64Array(N).fill(NaN), a = 1 / n; let au = NaN, ad = NaN;
  for (let i = 1; i < N; i++) {
    const d = c[i] - c[i - 1], up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
    if (i === 1) { au = up; ad = dn; } else { au = a * up + (1 - a) * au; ad = a * dn + (1 - a) * ad; }
    if (i >= n) o[i] = 100 - 100 / (1 + au / ad);
  }
  return o;
}
function smaRoll(a, n) {
  const N = a.length, o = new Float64Array(N).fill(NaN); let s = 0;
  for (let i = 0; i < N; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; }
  return o;
}
function ibsArr(h, l, c) { const o = new Float64Array(c.length); for (let i = 0; i < c.length; i++) o[i] = (c[i] - l[i]) / (h[i] - l[i]); return o; }
function supertrendDir(h, l, c, mult, period) {
  const a = atrW(h, l, c, period), n = c.length, dirs = new Int8Array(n), fu = new Float64Array(n).fill(NaN), fl = new Float64Array(n).fill(NaN);
  let s = -1; for (let i = 0; i < n; i++) if (!Number.isNaN(a[i])) { s = i; break; }
  if (s < 0) return dirs;
  const hl2 = (i) => (h[i] + l[i]) / 2;
  fu[s] = hl2(s) + mult * a[s]; fl[s] = hl2(s) - mult * a[s]; dirs[s] = c[s] > hl2(s) ? 1 : -1;
  for (let t = s + 1; t < n; t++) {
    const ub = hl2(t) + mult * a[t], lb = hl2(t) - mult * a[t];
    fu[t] = (ub < fu[t - 1] || c[t - 1] > fu[t - 1]) ? ub : fu[t - 1];
    fl[t] = (lb > fl[t - 1] || c[t - 1] < fl[t - 1]) ? lb : fl[t - 1];
    if (dirs[t - 1] === -1 && c[t] > fu[t - 1]) dirs[t] = 1;
    else if (dirs[t - 1] === 1 && c[t] < fl[t - 1]) dirs[t] = -1;
    else dirs[t] = dirs[t - 1];
  }
  return dirs;
}

/* ---------- bar completeness ---------- */
/* equities: bar.t = midnight UTC of the trading date. crypto: bar.t = candle open (00:00 UTC). Returns index of the last COMPLETE bar and of the forming bar (or -1). */
function completeness(bars, nowMs, kind) {
  const n = bars.c.length; let lc = n - 1, forming = -1;
  const done = (t) => kind === 'equity' ? nowMs >= t + EQ_COMPLETE_MS : nowMs >= t + DAY;
  if (n && !done(bars.t[n - 1])) { lc = n - 2; forming = n - 1; }
  return { lc, forming };
}
const closeMs = (kind, t) => kind === 'equity' ? t + EQ_CLOSE_MS : t + DAY;

/* ---------- RSI(2) / IBS : trades on one symbol ---------- */
function equityTrades(kind, sym, bars, cfg, nowMs, startMs) {
  const P = cfg[kind], n = bars.c.length, { lc, forming } = completeness(bars, nowMs, 'equity');
  const a = atrW(bars.h, bars.l, bars.c, 14), rsi = kind === 'rsi2' ? rsiW(bars.c, 2) : null, ibs = ibsArr(bars.h, bars.l, bars.c);
  const sma = kind === 'rsi2' ? smaRoll(bars.c, P.sma) : null;
  const trades = [], logOnly = []; let busy = -1;
  const label = kind === 'rsi2' ? 'RSI(2) dip buy' : 'IBS dip buy';
  for (let i = 1; i <= lc; i++) {
    let sig;
    if (kind === 'rsi2') sig = rsi[i] < P.entry && bars.c[i] > sma[i]; else sig = ibs[i] < P.entry;
    if (!sig || Number.isNaN(a[i]) || !(a[i] > 0)) continue;
    const entryMs = closeMs('equity', bars.t[i]);
    const rec = { strat: kind, label, sym, side: 1, sigMs: bars.t[i], entryMs, entry: bars.c[i] };
    if (entryMs < startMs) { rec.status = 'BEFORE PAPER START (not traded)'; logOnly.push(rec); continue; }
    if (i <= busy) continue;
    const risk = P.stopAtr * a[i], entry = bars.c[i], stop = entry - risk, last = Math.min(i + P.maxHold, n - 1);
    let res = null;
    for (let j = i + 1; j <= last; j++) {
      const isForming = j === forming;
      if (bars.l[j] <= stop) { res = { outcome: 'stop', x: j, exit: cfg.gapFills ? Math.min(stop, bars.o[j]) : stop }; break; }
      if (isForming) break;
      const ind = kind === 'rsi2' ? rsi[j] : ibs[j];
      if (ind > P.exit) { res = { outcome: 'signal', x: j, exit: bars.c[j] }; break; }
      if (j === i + P.maxHold) { res = { outcome: 'time', x: j, exit: bars.c[j] }; break; }
    }
    const t = Object.assign(rec, { kind: 'px', stop, tp: null, riskPct: risk / entry, maxHoldEnd: closeMs('equity', bars.t[Math.min(i + P.maxHold, n - 1)]) });
    if (res) { t.status = 'closed'; t.outcome = res.outcome; t.exit = res.exit; t.exitMs = closeMs('equity', bars.t[res.x]); t.bars = res.x - i; busy = res.x; }
    else { t.status = 'open'; busy = Infinity; t.bars = Math.max(0, Math.min(lc, last) - i); }
    trades.push(t);
  }
  return { trades, logOnly, indicators: { rsi, ibs, sma, atr: a, lc, forming } };
}

/* ---------- Supertrend + BTC regime : trades on one coin ---------- */
function supertrendTrades(sym, bars, btc, cfg, nowMs, startMs, pre) {
  const P = cfg.st, n = bars.c.length, { lc, forming } = completeness(bars, nowMs, 'crypto');
  const cut = lc + 1;
  const dirs = supertrendDir(bars.h.subarray(0, cut), bars.l.subarray(0, cut), bars.c.subarray(0, cut), P.mult, P.period);
  const a = atrW(bars.h, bars.l, bars.c, P.period);
  const trades = [], logOnly = []; let busy = -1;
  for (let t = 1; t <= lc; t++) {
    if (dirs[t] === dirs[t - 1] || dirs[t - 1] === 0) continue;
    const side = dirs[t], j0 = pre.btcIdx.get(bars.t[t]);
    if (j0 === undefined || !pre.regOk[j0]) continue;
    if ((side === 1 && !pre.regUp[j0]) || (side === -1 && pre.regUp[j0])) continue;
    if (!(a[t] > 0)) continue;
    const entryMs = bars.t[t] + DAY;
    const rec = { strat: 'st', label: 'Supertrend flip', sym, side, sigMs: bars.t[t], entryMs };
    if (entryMs < startMs) { rec.status = 'BEFORE PAPER START (not traded)'; rec.entry = t + 1 < n ? bars.o[t + 1] : null; logOnly.push(rec); continue; }
    if (t < busy) continue;
    const e = t + 1;
    if (e > n - 1) { rec.status = 'PENDING (next candle not open yet)'; logOnly.push(rec); continue; }
    const risk = P.mult * a[t], entry = bars.o[e], stop = side === 1 ? entry - risk : entry + risk, tp = side === 1 ? entry + P.tpR * risk : entry - P.tpR * risk;
    const last = Math.min(e + P.maxHold - 1, n - 1); let res = null;
    for (let k = e; k <= last; k++) {
      const stopHit = side === 1 ? bars.l[k] <= stop : bars.h[k] >= stop, tpHit = side === 1 ? bars.h[k] >= tp : bars.l[k] <= tp;
      if (stopHit) { res = { outcome: 'stop', x: k, exit: cfg.gapFills ? (side === 1 ? Math.min(stop, bars.o[k]) : Math.max(stop, bars.o[k])) : stop }; break; }
      if (tpHit) { res = { outcome: 'target', x: k, exit: cfg.gapFills ? (side === 1 ? Math.max(tp, bars.o[k]) : Math.min(tp, bars.o[k])) : tp }; break; }
      if (k === forming) break;
      if (k === e + P.maxHold - 1) { res = { outcome: 'time', x: k, exit: bars.c[k] }; break; }
    }
    const tr = Object.assign(rec, { kind: 'px', entry, stop, tp, riskPct: risk / entry, maxHoldEnd: bars.t[Math.min(e + P.maxHold - 1, n - 1)] + DAY });
    if (res) { tr.status = 'closed'; tr.outcome = res.outcome; tr.exit = res.exit; tr.exitMs = bars.t[res.x] + DAY; tr.bars = res.x - e + 1; busy = res.x; }
    else { tr.status = 'open'; busy = Infinity; tr.bars = Math.max(0, Math.min(lc, last) - e + 1); }
    trades.push(tr);
  }
  return { trades, logOnly, dirs, atr: a, lc, forming };
}
function btcRegime(btc, period) {
  const sma = smaRoll(btc.c, period), up = new Uint8Array(btc.c.length), ok = new Uint8Array(btc.c.length), idx = new Map();
  for (let i = 0; i < btc.c.length; i++) { idx.set(btc.t[i], i); ok[i] = Number.isNaN(sma[i]) ? 0 : 1; up[i] = btc.c[i] > sma[i] ? 1 : 0; }
  return { regUp: up, regOk: ok, btcIdx: idx, sma };
}

/* ---------- Funding carry : trades on one coin ----------
   daily = { start: dayMs of first element, f: [daily funding sum or NaN] } (complete UTC days only) */
function carryTrades(sym, daily, cfg, nowMs, startMs) {
  const P = cfg.carry, n = daily.f.length, todayMs = Math.floor(nowMs / DAY) * DAY, dayAt = (i) => daily.start + i * DAY;
  const lastIdx = n - 1;                                         // last day with known funding
  const horizon = Math.round((todayMs - daily.start) / DAY);      // index of today (held-state target)
  const ann = new Float64Array(n).fill(NaN);
  for (let i = P.k - 1; i < n; i++) { let s = 0, ok = true; for (let q = i - P.k + 1; q <= i; q++) { if (Number.isNaN(daily.f[q])) { ok = false; break; } s += daily.f[q]; } if (ok) ann[i] = s / P.k * 365; }
  const pos = new Uint8Array(Math.max(n, horizon) + 2); let on = false;
  for (let t = 0; t <= lastIdx; t++) {
    if (!Number.isNaN(ann[t])) { if (!on && ann[t] > P.entry) on = true; else if (on && ann[t] < P.exit) on = false; }
    pos[t + 1] = on ? 1 : 0;
  }
  const holdIdx = lastIdx + 1;                                     // = today when data is complete through yesterday
  const trades = []; let runStart = -1;
  const flush = (endExclusive, open) => {
    const startIdx = runStart, entryMsRaw = dayAt(startIdx);
    const exitMs = open ? null : dayAt(endExclusive);
    if (!open && exitMs <= startMs) return;                         // ended before the paper account started
    const entryMs = Math.max(entryMsRaw, Math.floor(startMs / DAY) * DAY);     // a hedge that is already on when the paper run starts is joined at the start of that day
    if (entryMs > nowMs) return;
    const fund = []; for (let i = startIdx; i < (open ? holdIdx : endExclusive); i++) if (i <= lastIdx && dayAt(i) >= entryMs && !Number.isNaN(daily.f[i])) fund.push([dayAt(i), daily.f[i]]);
    trades.push({ kind: 'carry', strat: 'carry', label: 'Funding carry', sym, side: 1, sigMs: entryMsRaw - DAY, entryMs, joined: entryMsRaw < entryMs, status: open ? 'open' : 'closed', exitMs, outcome: open ? null : 'funding turned weak', fund, entry: null, exit: null, stop: null, tp: null, bars: (open ? holdIdx : endExclusive) - startIdx });
  };
  for (let i = 1; i <= holdIdx; i++) {
    if (pos[i] === 1 && runStart < 0) runStart = i;
    if (pos[i] === 0 && runStart >= 0) { flush(i, false); runStart = -1; }
  }
  if (runStart >= 0) flush(holdIdx + 1, true);
  const lastAnn = ann[lastIdx], recent = []; for (let i = Math.max(0, lastIdx - 29); i <= lastIdx; i++) recent.push(Number.isNaN(ann[i]) ? null : ann[i]);
  return { trades, state: on, annNow: Number.isNaN(lastAnn) ? null : lastAnn, lastDayMs: dayAt(lastIdx), recent, k: P.k };
}

/* ---------- Paper-trading replay (deterministic: rebuilt from candle data at every scan) ----------
   trades: simulated trades (any strategy mix for ONE sleeve). prices(sym, dayStartMs) -> last known close at/before that day.
   Returns open/closed positions with sizing, equity curve (one point per day), max drawdown, signal log. */
function replaySleeve(id, trades, logOnly, sleeveCfg, o) {
  const { startMs, nowMs, startEquity, riskFrac, prices, livePrice } = o;
  const startDay = Math.floor(startMs / DAY), today = Math.floor(nowMs / DAY);
  const byDay = new Map();
  for (const t of trades) { const d = Math.floor(t.entryMs / DAY); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(t); }
  for (const l of byDay.values()) l.sort((a, b) => a.entryMs - b.entryMs || (a.sym < b.sym ? -1 : 1));
  let cash = startEquity, eqPrev = startEquity, peak = startEquity, maxDD = 0, gross = 0;
  const open = [], closed = [], equity = [], log = logOnly.map(x => Object.assign({}, x));
  const fundCum = (p, dayEndMs) => { let s = 0; for (const [d, f] of p.fund) if (d + DAY <= dayEndMs) s += f; return s; };
  for (let d = startDay; d <= today; d++) {
    const dayEnd = (d + 1) * DAY;
    for (const t of byDay.get(d) || []) {
      const rec = { strat: t.strat, label: t.label, sym: t.sym, side: t.side, sigMs: t.sigMs, entryMs: t.entryMs, entry: t.entry, stop: t.stop, tp: t.tp, riskPct: t.riskPct };
      let N;
      if (t.kind === 'carry') N = sleeveCfg.notional * eqPrev;
      else N = Math.min(riskFrac * eqPrev / t.riskPct, sleeveCfg.maxPos * eqPrev);
      let g = 0; for (const p of open) g += p.N;
      const room = sleeveCfg.maxGross * eqPrev - g;
      if (eqPrev <= 0 || room < 0.25 * N) { rec.status = 'SKIPPED: exposure cap reached'; log.push(rec); continue; }
      N = Math.min(N, room); rec.N = N; rec.riskAmt = t.kind === 'carry' ? null : N * t.riskPct; rec.status = 'TAKEN' + (t.joined ? ' (joined at paper start)' : '');
      log.push(rec); open.push(Object.assign({}, rec, { t, kind: t.kind, fund: t.fund || null }));
    }
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k], t = p.t;
      if (t.status === 'closed' && t.exitMs < dayEnd) {
        let pnl;
        if (t.kind === 'carry') { const f = fundCum(p, t.exitMs); p.fundTotal = f; pnl = p.N * (f - 2 * sleeveCfg.costSide); p.exit = null; }
        else pnl = p.N * (p.side * (t.exit / p.entry - 1) - sleeveCfg.cost);
        p.pnl = pnl; p.exitMs = t.exitMs; p.outcome = t.outcome; if (t.kind !== 'carry') p.exit = t.exit;
        p.R = p.riskAmt ? pnl / p.riskAmt : null; p.pct = p.N ? pnl / p.N : null;
        cash += pnl; closed.push(p); open.splice(k, 1);
      }
    }
    let unreal = 0, g = 0;
    for (const p of open) {
      if (p.kind === 'carry') { const f = fundCum(p, dayEnd); p.fundTotal = f; p.unreal = p.N * (f - sleeveCfg.costSide); p.last = null; }
      else {
        let px = (d === today && livePrice && Number.isFinite(livePrice[p.sym])) ? livePrice[p.sym] : prices(p.sym, d * DAY);
        if (!Number.isFinite(px)) px = p.entry;
        p.last = px; p.unreal = p.N * (p.side * (px / p.entry - 1) - sleeveCfg.cost / 2);
      }
      unreal += p.unreal; g += p.N;
    }
    const eq = cash + unreal; equity.push({ t: d * DAY, eq }); eqPrev = eq; gross = g / Math.max(eq, 1e-9);
    if (eq > peak) peak = eq; maxDD = Math.min(maxDD, eq / peak - 1);
  }
  return { id, open, closed, equity, log, maxDD, grossNow: gross, cash };
}

function sleeveStats(res, startEquity) {
  const c = res.closed, n = c.length, wins = c.filter(p => p.pnl > 0), losses = c.filter(p => p.pnl <= 0);
  const sw = wins.reduce((a, p) => a + p.pnl, 0), sl = -losses.reduce((a, p) => a + p.pnl, 0);
  const rs = c.map(p => p.R).filter(Number.isFinite), pcts = c.map(p => p.pct).filter(Number.isFinite);
  const eq = res.equity.length ? res.equity[res.equity.length - 1].eq : startEquity;
  return { closed: n, open: res.open.length, wins: wins.length, winRate: n ? wins.length / n : null, pf: sl > 0 ? sw / sl : (sw > 0 ? null : null),
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, avgPct: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null,
    pnl: eq - startEquity, ret: eq / startEquity - 1, equityNow: eq, maxDD: res.maxDD, grossNow: res.grossNow,
    fundingCollected: c.filter(p => p.kind === 'carry').reduce((a, p) => a + (p.fundTotal || 0) * p.N, 0) + res.open.filter(p => p.kind === 'carry').reduce((a, p) => a + (p.fundTotal || 0) * p.N, 0) };
}

function median(a) { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; }

if (typeof module !== 'undefined') module.exports = { DAY, HOUR, EQ_CLOSE_MS, EQ_COMPLETE_MS, DEFAULTS, atrW, rsiW, smaRoll, ibsArr, supertrendDir, completeness, equityTrades, supertrendTrades, btcRegime, carryTrades, replaySleeve, sleeveStats, median, closeMs };
