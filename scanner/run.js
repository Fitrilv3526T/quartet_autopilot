'use strict';
/* QUARTET scan: fetch data -> simulate the four strategies -> paper-trading replay -> docs/data/*.json|csv
   Node 20+, zero dependencies. Run by GitHub Actions every 30 minutes (see .github/workflows/scan.yml). */
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const C = require('./core.js');
const { DAY, HOUR } = C;
const ROOT = path.join(__dirname, '..'), DATA_DIR = path.join(ROOT, 'docs', 'data');
const NOW = process.env.QUARTET_NOW ? Number(process.env.QUARTET_NOW) : Date.now();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ALTS = ['DOGE', 'SHIB', 'LINK', 'BCH', 'ATOM', 'TRX', 'FIL', 'LTC', 'XRP', 'ADA', 'AVAX', 'SOL', 'DOT'].map(a => a + 'USDT');
const SPOT_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com', 'https://api-gcp.binance.com'];
const ARCHIVE = 'https://data.binance.vision/data/futures/um';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fetchFn = (typeof globalThis.__QUARTET_FETCH === 'function') ? globalThis.__QUARTET_FETCH : fetch;   // tests inject a mock

async function http(url, { json = true, buf = false, tries = 3, timeout = 25000 } = {}) {
  let last;
  for (let a = 0; a < tries; a++) {
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), timeout);
      const r = await fetchFn(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, signal: ctl.signal });
      clearTimeout(to);
      if (r.status === 404) { const e = new Error('404 ' + url); e.status = 404; throw e; }
      if (!r.ok) { const e = new Error(r.status + ' ' + url); e.status = r.status; throw e; }
      return buf ? Buffer.from(await r.arrayBuffer()) : json ? await r.json() : await r.text();
    } catch (e) { last = e; if (e.status === 404 || e.status === 451 || e.status === 403) break; await sleep(700 * (a + 1)); }
  }
  throw last;
}

/* ---------- minimal zip reader (first file only; uses the central directory so data descriptors are fine) ---------- */
function unzipFirst(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('bad zip');
  const cdOff = buf.readUInt32LE(e + 16), method = buf.readUInt16LE(cdOff + 10), csize = buf.readUInt32LE(cdOff + 20), lho = buf.readUInt32LE(cdOff + 42);
  const nameLen = buf.readUInt16LE(lho + 26), extraLen = buf.readUInt16LE(lho + 28), start = lho + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + csize);
  return (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
}

/* ---------- data: equities (Yahoo, Stooq fallback) ---------- */
function toBars(rows) {
  rows.sort((a, b) => a.t - b.t);
  const out = []; for (const r of rows) if (!out.length || out[out.length - 1].t !== r.t) out.push(r); else out[out.length - 1] = r;
  const n = out.length, B = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n) };
  out.forEach((r, i) => { B.t[i] = r.t; B.o[i] = r.o; B.h[i] = r.h; B.l[i] = r.l; B.c[i] = r.c; });
  return B;
}
async function yahoo(sym) {
  let err;
  for (const host of ['query1', 'query2']) {
    try {
      const j = await http(`https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?range=3y&interval=1d&includeAdjustedClose=true`);
      const r = j.chart.result[0], off = r.meta.gmtoffset || 0, q = r.indicators.quote[0], adj = (r.indicators.adjclose || [{}])[0].adjclose, rows = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) continue;
        const k = adj && adj[i] != null ? adj[i] / q.close[i] : 1;
        rows.push({ t: Math.floor((r.timestamp[i] + off) * 1000 / DAY) * DAY, o: q.open[i] * k, h: q.high[i] * k, l: q.low[i] * k, c: q.close[i] * k });
      }
      return { bars: toBars(rows), live: Number.isFinite(r.meta.regularMarketPrice) ? r.meta.regularMarketPrice : null, source: 'Yahoo Finance' };
    } catch (e) { err = e; }
  }
  throw err;
}
async function stooq(sym) {
  const txt = await http(`https://stooq.com/q/d/l/?s=${sym.toLowerCase()}.us&i=d`, { json: false });
  const rows = [];
  for (const line of txt.trim().split('\n').slice(1)) { const [d, o, h, l, c] = line.split(','); const t = Date.parse(d + 'T00:00:00Z'); if (t && +c > 0) rows.push({ t, o: +o, h: +h, l: +l, c: +c }); }
  if (rows.length < 300) throw new Error('stooq: too few rows');
  const bars = toBars(rows.slice(-800));
  return { bars, live: null, source: 'Stooq (fallback)' };
}
async function equity(sym) { try { return await yahoo(sym); } catch (e1) { try { return await stooq(sym); } catch (e2) { throw new Error(`${sym}: Yahoo failed (${e1.message}); Stooq failed (${e2.message})`); } } }

/* ---------- data: crypto spot daily klines ---------- */
async function klines(sym) {
  let err;
  for (const h of SPOT_HOSTS) {
    try {
      const j = await http(`${h}/api/v3/klines?symbol=${sym}&interval=1d&limit=1000`);
      if (!Array.isArray(j) || j.length < 250) throw new Error('short history');
      return { bars: toBars(j.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }))), source: h.replace('https://', '') };
    } catch (e) { err = e; }
  }
  throw new Error(`${sym}: ${err && err.message}`);
}

/* ---------- data: funding history (archive months + a source chain for the recent days) ---------- */
const ym = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
function addSettle(map, ts, rate) { const d = Math.floor(ts / DAY) * DAY; const e = map.get(d) || { sum: 0, n: 0 }; e.sum += rate; e.n++; map.set(d, e); }
async function fundingArchive(sym, map) {
  const months = []; const d0 = new Date(NOW); let y = d0.getUTCFullYear(), m = d0.getUTCMonth();
  for (let i = 0; i < 5; i++) { m--; if (m < 0) { m = 11; y--; } months.push(`${y}-${String(m + 1).padStart(2, '0')}`); }
  let got = 0;
  for (const mo of months.reverse()) {
    try {
      const txt = unzipFirst(await http(`${ARCHIVE}/monthly/fundingRate/${sym}/${sym}-fundingRate-${mo}.zip`, { buf: true, tries: 2 }));
      for (const line of txt.trim().split('\n')) { const c = line.split(','); const ts = Number(c[0]); if (!Number.isFinite(ts) || ts < 1e12) continue; addSettle(map, ts, Number(c[c.length - 1])); }
      got++;
    } catch (e) { /* month not published yet or missing */ }
  }
  return got;
}
async function fundingFapi(sym, fromMs, map) {
  let start = fromMs, n = 0;
  for (let page = 0; page < 6; page++) {
    const j = await http(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${start}&limit=1000`, { tries: 2 });
    if (!Array.isArray(j) || !j.length) break;
    for (const r of j) { addSettle(map, r.fundingTime, Number(r.fundingRate)); n++; }
    start = j[j.length - 1].fundingTime + 1; if (j.length < 1000) break;
  }
  if (!n) throw new Error('empty');
  return n;
}
async function premiumDay(sym, dayMs) {          // reconstruct three settlements from 1-minute premium-index candles
  const txt = unzipFirst(await http(`${ARCHIVE}/daily/premiumIndexKlines/${sym}/1m/${sym}-1m-${ymd(dayMs)}.zip`, { buf: true, tries: 2 }));
  const rows = []; for (const line of txt.trim().split('\n')) { const c = line.split(','); const ts = Number(c[0]); if (Number.isFinite(ts) && ts > 1e12) rows.push([ts, Number(c[4])]); }
  rows.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let k = 0; k < 3; k++) {
    const lo = dayMs + k * 8 * HOUR, hi = lo + 8 * HOUR, w = rows.filter(r => r[0] >= lo && r[0] < hi);
    if (w.length < 470) return null;
    let sw = 0, s = 0; w.forEach((r, i) => { s += (i + 1) * r[1]; sw += i + 1; });
    const P = s / sw; out.push([lo, P + Math.max(-0.0005, Math.min(0.0005, 0.0001 - P))]);
  }
  return out;
}
async function premiumValidated(sym, map) {      // does the reconstruction reproduce known archive funding? (last 3 archived days)
  const days = [...map.keys()].filter(d => map.get(d).n >= 3).sort((a, b) => a - b).slice(-3); if (days.length < 2) return { ok: false, mae: null };
  let err = 0, n = 0;
  for (const d of days) { const rec = await premiumDay(sym, d); if (!rec) return { ok: false, mae: null }; const real = map.get(d).sum, recSum = rec.reduce((a, r) => a + r[1], 0); err += Math.abs(recSum - real); n++; }
  const mae = err / n; return { ok: mae < 0.00012, mae };      // tolerance: 0.012% per DAY (three settlements)
}
async function fundingOkx(sym, map) {
  const j = await http(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${sym.replace('USDT', '-USDT')}-SWAP&limit=100`, { tries: 2 });
  const rows = (j.data || []); if (!rows.length) throw new Error('empty');
  for (const r of rows) addSettle(map, Number(r.fundingTime), Number(r.realizedRate != null && r.realizedRate !== '' ? r.realizedRate : r.fundingRate));
  return rows.length;
}
async function funding(sym) {
  const map = new Map(), src = [];
  const nArc = await fundingArchive(sym, map); src.push({ id: 'archive', label: 'Binance monthly archive', months: nArc });
  const yesterday = Math.floor(NOW / DAY) * DAY - DAY;
  const completeDays = () => [...map.entries()].filter(([, e]) => e.n >= 3).map(([d]) => d);
  let last = completeDays().sort((a, b) => a - b).pop() || null;
  const missingFrom = () => (last ? last + DAY : yesterday - 70 * DAY);
  const tried = [];
  if (last == null || last < yesterday) {
    try { const n = await fundingFapi(sym, missingFrom(), map); src.push({ id: 'binance-api', label: 'Binance futures API', rows: n }); } catch (e) { tried.push('Binance API: ' + (e.status || e.message)); }
    last = completeDays().sort((a, b) => a - b).pop() || null;
  }
  let val = null;
  if (last != null && last < yesterday) {
    try {
      val = await premiumValidated(sym, map);
      if (val.ok) {
        let n = 0; for (let d = last + DAY; d <= yesterday; d += DAY) { const rec = await premiumDay(sym, d).catch(() => null); if (!rec) break; for (const [ts, f] of rec) addSettle(map, ts, f); n++; }
        src.push({ id: 'premium-index', label: 'Reconstructed from premium index (validated)', days: n, mae: val.mae });
      } else tried.push('premium-index reconstruction not validated' + (val.mae != null ? ` (error ${(val.mae * 100).toFixed(4)}% per day)` : ''));
    } catch (e) { tried.push('premium-index: ' + (e.status || e.message)); }
    last = completeDays().sort((a, b) => a - b).pop() || null;
  }
  if (last == null || last < yesterday) {
    try { const n = await fundingOkx(sym, map); src.push({ id: 'okx-proxy', label: 'OKX funding (proxy, not Binance)', rows: n }); } catch (e) { tried.push('OKX: ' + (e.status || e.message)); }
    last = completeDays().sort((a, b) => a - b).pop() || null;
  }
  if (last == null) throw new Error('no funding data from any source (' + tried.join('; ') + ')');
  const first = Math.min(...completeDays()), f = []; for (let d = first; d <= last; d += DAY) { const e = map.get(d); f.push(e && e.n >= 3 ? e.sum : NaN); }
  return { daily: { start: first, f }, sources: src, tried, lastDayMs: last, stale: last < yesterday - DAY };
}

/* ---------- helpers for output ---------- */
const priceFn = (barsBySym) => (sym, dayMs) => {
  const b = barsBySym[sym]; if (!b) return NaN; let lo = 0, hi = b.t.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (b.t[m] <= dayMs) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? b.c[ans] : NaN;
};
const num = (x, d = 6) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const cleanPos = (p) => ({ strat: p.strat, label: p.label, sym: p.sym, side: p.side, sigMs: p.sigMs, entryMs: p.entryMs, exitMs: p.exitMs || null, entry: num(p.entry, 8), exit: num(p.exit, 8), stop: num(p.stop, 8), tp: num(p.tp, 8),
  last: num(p.last, 8), N: num(p.N, 2), riskAmt: num(p.riskAmt, 2), pnl: num(p.pnl, 2), unreal: num(p.unreal, 2), R: num(p.R, 3), pct: num(p.pct, 5), outcome: p.outcome || null, fundTotal: num(p.fundTotal, 6), bars: p.t ? p.t.bars : null, maxHoldEnd: p.t ? (p.t.maxHoldEnd || null) : null, status: p.status, joined: !!(p.t && p.t.joined) });
const cleanLog = (l) => ({ strat: l.strat, sym: l.sym, side: l.side, sigMs: l.sigMs, entryMs: l.entryMs, entry: num(l.entry, 8), stop: num(l.stop, 8), tp: num(l.tp, 8), N: num(l.N, 2), status: l.status });

const { SLEEVES: META, RESEARCH } = require('./meta.js');

/* ---------- main ---------- */
async function main() {
  const cfgFile = path.join(ROOT, 'config.json');
  const user = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  const cfg = JSON.parse(JSON.stringify(C.DEFAULTS));
  for (const k of ['startEquity', 'risk', 'carryNotional', 'gapFills']) if (user[k] !== undefined) cfg[k] = user[k];
  if (user.enabled) Object.assign(cfg.enabled, user.enabled);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const prevFile = path.join(DATA_DIR, 'state.json'), prev = fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, 'utf8')) : null;
  let startMs = user.startMs || (prev && prev.startMs) || null;
  if (!startMs) { startMs = Math.floor(NOW / HOUR) * HOUR; user.startMs = startMs; fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({ startEquity: cfg.startEquity }, user), null, 2) + '\n'); console.log('Paper trading starts now:', new Date(startMs).toISOString()); }
  cfg.startMs = startMs;

  const health = { sources: [], warnings: [] }, sleeves = {}, errors = {};
  const live = {}, bars = {};
  const prevSleeve = (id) => prev && (prev.sleeves || []).find(s => s.id === id);

  /* equities */
  const eqData = {};
  if (cfg.enabled.rsi2 || cfg.enabled.ibs) {
    for (const sym of ['SPY', 'QQQ']) {
      try { const r = await equity(sym); eqData[sym] = r; bars[sym] = r.bars; if (r.live) live[sym] = r.live; health.sources.push({ id: 'eq-' + sym, label: `${sym} daily candles`, ok: true, detail: r.source, asOfMs: r.bars.t[r.bars.t.length - 1] }); }
      catch (e) { errors[sym] = e.message; health.sources.push({ id: 'eq-' + sym, label: `${sym} daily candles`, ok: false, detail: e.message }); }
    }
  }
  /* crypto */
  const cryptoData = {};
  if (cfg.enabled.st) {
    for (const sym of ['BTCUSDT', ...ALTS]) {
      try { const r = await klines(sym); cryptoData[sym] = r; bars[sym] = r.bars; live[sym] = r.bars.c[r.bars.c.length - 1]; }
      catch (e) { errors[sym] = e.message; }
    }
    const okN = Object.keys(cryptoData).length;
    health.sources.push({ id: 'crypto-klines', label: 'Crypto daily candles (14 pairs)', ok: !!cryptoData.BTCUSDT && okN >= 10, detail: `${okN} of 14 pairs loaded via ${(cryptoData.BTCUSDT || {}).source || 'none'}`, asOfMs: cryptoData.BTCUSDT ? cryptoData.BTCUSDT.bars.t.at(-1) : null });
  }
  const fundData = {};
  if (cfg.enabled.carry) {
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      try { fundData[sym] = await funding(sym); const f = fundData[sym];
        health.sources.push({ id: 'fund-' + sym, label: `${sym.slice(0, 3)} funding history`, ok: !f.stale, detail: f.sources.map(s => s.label).join(' + ') + (f.tried.length ? ' | tried: ' + f.tried.join('; ') : ''), asOfMs: f.lastDayMs + DAY });
        if (f.stale) health.warnings.push(`${sym.slice(0, 3)} funding data ends ${ymd(f.lastDayMs)}; carry signals are paused until fresher funding is available.`);
        if (f.sources.some(s => s.id === 'okx-proxy')) health.warnings.push(`${sym.slice(0, 3)} funding for recent days comes from OKX (a proxy), not Binance.`);
      } catch (e) { errors['fund-' + sym] = e.message; health.sources.push({ id: 'fund-' + sym, label: `${sym.slice(0, 3)} funding history`, ok: false, detail: e.message }); }
    }
  }

  const prices = priceFn(bars), sleeveOut = [];
  const mkReplay = (id, trades, logOnly, sc) => C.replaySleeve(id, trades, logOnly, sc, { startMs, nowMs: NOW, startEquity: cfg.startEquity, riskFrac: cfg.risk, prices, livePrice: live });
  const finish = (id, res, watch, extra = {}) => {
    const st = C.sleeveStats(res, cfg.startEquity);
    sleeveOut.push(Object.assign({ id, meta: META[id], startEquity: cfg.startEquity, stats: st, equity: res.equity.map(e => [e.t, num(e.eq, 2)]), open: res.open.map(cleanPos), closed: res.closed.map(cleanPos).sort((a, b) => b.exitMs - a.exitMs),
      log: res.log.sort((a, b) => b.entryMs - a.entryMs).slice(0, 80).map(cleanLog), watch, stale: false }, extra));
  };
  const fail = (id, why) => { const p = prevSleeve(id); if (p) { p.stale = true; p.staleReason = why; sleeveOut.push(p); } else sleeveOut.push({ id, meta: META[id], startEquity: cfg.startEquity, stats: null, equity: [], open: [], closed: [], log: [], watch: null, stale: true, staleReason: why }); health.warnings.push(`${META[id].short}: ${why}`); };

  /* RSI(2) and IBS */
  for (const id of ['rsi2', 'ibs']) {
    if (!cfg.enabled[id]) continue;
    if (!eqData.SPY || !eqData.QQQ) { fail(id, 'equity data unavailable: ' + Object.values(errors).join(' | ')); continue; }
    const trades = [], logOnly = [], watch = { items: [] };
    for (const sym of ['SPY', 'QQQ']) {
      const r = C.equityTrades(id, sym, bars[sym], cfg, NOW, startMs); trades.push(...r.trades); logOnly.push(...r.logOnly.slice(-3));
      const I = r.indicators, i = I.lc, b = bars[sym];
      const open = r.trades.find(t => t.status === 'open');
      watch.items.push(id === 'rsi2'
        ? { sym, asOfMs: b.t[i], close: num(b.c[i], 2), value: num(I.rsi[i], 1), trigger: cfg.rsi2.entry, test: 'below', aboveSma: b.c[i] > I.sma[i], smaDistPct: num((b.c[i] / I.sma[i] - 1) * 100, 2), met: I.rsi[i] < cfg.rsi2.entry && b.c[i] > I.sma[i], holding: !!open, live: num(live[sym], 2) }
        : { sym, asOfMs: b.t[i], close: num(b.c[i], 2), value: num(I.ibs[i], 3), trigger: cfg.ibs.entry, test: 'below', met: I.ibs[i] < cfg.ibs.entry, holding: !!open, live: num(live[sym], 2) });
    }
    const res = mkReplay(id, trades, logOnly, Object.assign({ cost: cfg[id].cost, maxPos: cfg[id].maxPos, maxGross: cfg[id].maxGross }, {}));
    finish(id, res, watch);
  }
  /* Funding carry */
  if (cfg.enabled.carry) {
    if (!Object.keys(fundData).length) fail('carry', 'funding data unavailable: ' + Object.entries(errors).filter(([k]) => k.startsWith('fund')).map(([, v]) => v).join(' | '));
    else {
      const trades = [], watch = { items: [] };
      for (const sym of Object.keys(fundData)) {
        const f = fundData[sym], r = C.carryTrades(sym, f.daily, cfg, NOW, startMs);
        const frozen = f.stale; trades.push(...r.trades);
        watch.items.push({ sym, annNow: num(r.annNow, 4), entry: cfg.carry.entry, exit: cfg.carry.exit, state: r.state, lastDayMs: r.lastDayMs, recent: r.recent.map(x => num(x, 4)), source: f.sources.map(s => s.label).join(' + '), stale: frozen, k: cfg.carry.k });
      }
      const res = mkReplay('carry', trades, [], { notional: cfg.carryNotional, costSide: cfg.carry.costSide, maxGross: cfg.carry.maxGross });
      finish('carry', res, watch);
    }
  }
  /* Supertrend */
  if (cfg.enabled.st) {
    if (!cryptoData.BTCUSDT || Object.keys(cryptoData).length < 11) fail('st', 'crypto candles unavailable: ' + Object.entries(errors).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(' | '));
    else {
      const btc = bars.BTCUSDT, pre = C.btcRegime(btc, cfg.st.regimeSma), trades = [], logOnly = [], coins = [];
      const lcB = C.completeness(btc, NOW, 'crypto').lc, sma = pre.sma[lcB];
      for (const sym of ALTS) {
        if (!bars[sym]) continue;
        const r = C.supertrendTrades(sym, bars[sym], btc, cfg, NOW, startMs, pre); trades.push(...r.trades); logOnly.push(...r.logOnly.slice(-2));
        const lc = r.lc; let flipAgo = 0; for (let t = lc; t > 0 && r.dirs[t] === r.dirs[lc]; t--) flipAgo++;
        coins.push({ sym, dir: r.dirs[lc], daysInDir: flipAgo, atrPct: num(r.atr[lc] / bars[sym].c[lc] * 100, 2), close: num(bars[sym].c[lc], 6), holding: r.trades.some(t => t.status === 'open') });
      }
      const res = mkReplay('st', trades, logOnly, { cost: cfg.st.cost, maxPos: cfg.st.maxPos, maxGross: cfg.st.maxGross });
      finish('st', res, { regime: { btcClose: num(btc.c[lcB], 2), sma200: num(sma, 2), up: btc.c[lcB] > sma, asOfMs: btc.t[lcB] }, coins });
    }
  }

  /* combined account */
  const order = ['rsi2', 'ibs', 'carry', 'st'], list = order.map(id => sleeveOut.find(s => s.id === id)).filter(Boolean);
  const dayMap = new Map(); let total0 = 0;
  for (const s of list) { total0 += s.startEquity; for (const [t, e] of s.equity) dayMap.set(t, (dayMap.get(t) || 0) + e); }
  const eqCombined = [...dayMap.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => list.every(s => s.equity.some(e => e[0] === t))).map(([t, e]) => [t, num(e, 2)]);
  let peak = total0, mdd = 0; for (const [, e] of eqCombined) { peak = Math.max(peak, e); mdd = Math.min(mdd, e / peak - 1); }
  const eqNow = eqCombined.length ? eqCombined.at(-1)[1] : total0;
  const state = { v: 1, updatedMs: NOW, startMs, cfg: { startEquity: cfg.startEquity, risk: cfg.risk, carryNotional: cfg.carryNotional, gapFills: cfg.gapFills }, health,
    combined: { startEquity: total0, equityNow: eqNow, ret: eqNow / total0 - 1, maxDD: mdd, equity: eqCombined, closed: list.reduce((a, s) => a + (s.stats ? s.stats.closed : 0), 0), open: list.reduce((a, s) => a + (s.stats ? s.stats.open : 0), 0) },
    sleeves: list, research: RESEARCH, errors };

  /* write only when something material changed (or every 3 hours) so the repo history stays readable */
  const digest = (s) => crypto.createHash('sha1').update(JSON.stringify([s.sleeves.map(x => [x.id, x.open.map(p => [p.sym, p.entryMs]), x.closed.length, x.stale]), s.health.warnings])).digest('hex');
  const changed = !prev || digest(prev) !== digest(state), dueMs = 3 * HOUR;
  if (!changed && prev && NOW - prev.updatedMs < dueMs && !process.env.QUARTET_FORCE) { console.log('No material change; not rewriting state.json'); return; }
  fs.writeFileSync(prevFile, JSON.stringify(state));
  const rows = [['strategy', 'symbol', 'side', 'entry_utc', 'exit_utc', 'entry', 'exit', 'size_usd', 'pnl_usd', 'R', 'outcome']];
  for (const s of list) for (const p of s.closed) rows.push([s.id, p.sym, p.side === 1 ? 'long' : 'short', new Date(p.entryMs).toISOString(), new Date(p.exitMs).toISOString(), p.entry, p.exit, p.N, p.pnl, p.R, p.outcome]);
  fs.writeFileSync(path.join(DATA_DIR, 'closed_trades.csv'), rows.map(r => r.map(x => (x == null ? '' : x)).join(',')).join('\n') + '\n');
  console.log(`state.json written: equity ${eqNow} (${(state.combined.ret * 100).toFixed(2)}%), open ${state.combined.open}, closed ${state.combined.closed}`);
  await notify(prev, state);
}

async function notify(prev, state) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID; if (!token || !chat || !prev) return;
  const seen = new Set(); for (const s of prev.sleeves || []) { for (const p of s.open || []) seen.add(`o|${s.id}|${p.sym}|${p.entryMs}`); for (const p of s.closed || []) seen.add(`c|${s.id}|${p.sym}|${p.entryMs}`); }
  const msgs = [];
  for (const s of state.sleeves) { for (const p of s.open) if (!seen.has(`o|${s.id}|${p.sym}|${p.entryMs}`)) msgs.push(`${s.meta.short}: paper ENTRY ${p.sym} ${p.side === 1 ? 'long' : 'short'}${p.entry ? ' @ ' + p.entry : ''}`);
    for (const p of s.closed) if (!seen.has(`c|${s.id}|${p.sym}|${p.entryMs}`)) msgs.push(`${s.meta.short}: paper EXIT ${p.sym} (${p.outcome}) P&L ${p.pnl >= 0 ? '+' : ''}${p.pnl}`); }
  for (const m of msgs.slice(0, 10)) { try { await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: m }) }); } catch (e) { /* ignore */ } }
}

if (require.main === module) main().catch(e => { console.error('SCAN FAILED:', e); process.exit(1); });
module.exports = { main, unzipFirst, funding, premiumDay };
