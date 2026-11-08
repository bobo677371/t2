/* build_screen.js —— 全市场选股：超跌 + 离低点 + 基本面过滤 + 板块集中度
 *
 * 输出 screen.json，随页面部署。手机只做展示，不发起全市场请求。
 *
 * 三重过滤：
 *   ① 基本面：净利润>0、PE(TTM)>0、总市值>=30亿、ROE>0   —— 排除亏损和经营差的
 *   ② 技术面：已验证组合 + 「离 20 日低点 3% 以上」闸门
 *   ③ 板块面：给出行业名称与板块 20 日涨跌，并提示集中度
 *
 * 用法: node build_screen.js [最大扫描数]
 *   环境变量 SCREEN_OUT 可指定输出路径（GitHub Actions 里设为 dist/screen.json）
 */
'use strict';
global.window = global;
const fs = require('fs');
const path = require('path');

const APP = fs.existsSync(path.join(__dirname, 'app.js'))
  ? path.join(__dirname, 'app.js')
  : path.join(__dirname, '..', 'dist', 'app.js');
require(APP);
const T2 = global.T2;

const KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const LIST = 'https://push2.eastmoney.com/api/qt/clist/get';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const MAX_CAND = parseInt(process.argv[2] || '1500', 10);
const CONCURRENCY = 4;

/* 基本面门槛 */
const MIN_MKT_CAP = 3e9;     // 总市值 >= 30 亿
const MIN_ROE = 0;           // ROE > 0
const MAX_PE = 150;          // PE(TTM) 上限，排除极端高估

/* 组合清单（全部带 @offlow 闸门：收盘 > 20日最低 × 1.03）
 * disc / val = 发现集(2010-2017) / 验证集(2018-2026) 的 20 日上涨率
 * 加闸门后各组合提升 4~17pp，且两段同时改善 */
const COMBOS = [
  { ids: ['rsi_os', '@offlow'], n: 4295, disc: 0.617, val: 0.679 },
  { ids: ['gap', 'rsi_os', '@offlow'], n: 208, disc: 0.644, val: 0.798 },
  { ids: ['big_yang', 'rsi_os', '@offlow'], n: 249, disc: 0.651, val: 0.775 },
  { ids: ['big_yang', 'rsi_os', 'strong_close', '@offlow'], n: 212, disc: 0.677, val: 0.792 },
  { ids: ['three_black', 'gap', 'rsi_os', '@offlow'], n: 117, disc: 0.560, val: 0.855 },
];

COMBOS.forEach(c => {
  c.ids = c.ids.filter(id => id.startsWith('@') || T2.PATTERNS.some(p => p.id === id));
  c.name = c.ids.map(id => id === '@offlow' ? '离低点3%'
    : T2.PATTERNS.find(p => p.id === id).name).join(' + ');
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      if (i < retries - 1) await sleep(700 * (i + 1));
    }
  }
  throw last;
}

function begDate(daysBack = 400) {
  const d = new Date(); d.setDate(d.getDate() - daysBack);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/* ---------- ① 全市场快照（含基本面 + 行业） ---------- */
async function fetchAllQuotes() {
  const out = [];
  for (let pn = 1; pn <= 56; pn++) {
    const qs = new URLSearchParams({
      pn, pz: 100, po: 1, np: 1, fltt: 2, invt: 2, fid: 'f3',
      fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',
      fields: 'f2,f3,f12,f13,f14,f17,f18,f20,f23,f37,f45,f100,f115,f221',
    });
    const d = await getJson(`${LIST}?${qs}`);
    const arr = (d && d.data && d.data.diff) || [];
    for (const r of arr) {
      if (!Number.isFinite(r.f3)) continue;
      const gap = (Number.isFinite(r.f17) && Number.isFinite(r.f18) && r.f18 > 0) ? r.f17 / r.f18 - 1 : 0;
      out.push({
        mkt: r.f13, code: r.f12, name: r.f14, chg: r.f3, gap,
        cap: r.f20, pb: r.f23, roe: r.f37, profit: r.f45,
        pe: r.f115, ind: r.f100, period: r.f221,
      });
    }
    if (pn % 14 === 0) console.log(`    行情 ${pn}/56  累计 ${out.length}`);
    await sleep(110);
  }
  return out;
}

/* ---------- ② 板块代码表（行业名 -> BK 代码） ---------- */
async function fetchSectorMap() {
  const map = {};
  for (let pn = 1; pn <= 6; pn++) {
    const qs = new URLSearchParams({
      pn, pz: 100, po: 1, np: 1, fltt: 2, invt: 2, fid: 'f3',
      fs: 'm:90+t:2', fields: 'f12,f14',
    });
    const d = await getJson(`${LIST}?${qs}`);
    const arr = (d && d.data && d.data.diff) || [];
    for (const r of arr) map[r.f14] = r.f12;
    if (arr.length < 100) break;
    await sleep(100);
  }
  console.log(`   板块代码表 ${Object.keys(map).length} 个`);
  return map;
}

/* 板块 20 日涨跌幅 */
async function fetchSectorTrend(bkCode) {
  const qs = new URLSearchParams({
    secid: '90.' + bkCode, fields1: 'f1', fields2: 'f51,f53',
    klt: '101', fqt: '0', beg: begDate(90), end: '20500101',
  });
  const d = await getJson(`${KLINE}?${qs}`);
  const ks = (d && d.data && d.data.klines) || [];
  if (ks.length < 21) return null;
  const n = ks.length;
  const c = ks.map(x => +x.split(',')[1]);
  const r5 = c[n - 1] / c[n - 6] - 1;
  const r20 = c[n - 1] / c[n - 21] - 1;
  return { r5, r20, name: d.data.name };
}

/* ---------- ③ 单只票的轻量日线 ---------- */
async function fetchLight(mkt, code) {
  const qs = new URLSearchParams({
    secid: mkt + '.' + code, fields1: 'f1', fields2: 'f51,f52,f53,f54,f55,f56,f57',
    klt: '101', fqt: '2', beg: begDate(), end: '20500101',
  });
  const d = await getJson(`${KLINE}?${qs}`);
  const data = d && d.data;
  if (!data || !data.klines || data.klines.length < 120) return null;
  const rows = data.klines, n = rows.length;
  const k = {
    name: data.name || '', code: data.code || code, kind: 's', fqt: 2, scale: 1,
    date: new Array(n), open: new Float64Array(n), high: new Float64Array(n),
    low: new Float64Array(n), close: new Float64Array(n),
    volume: new Float64Array(n), amount: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const p = rows[i].split(',');
    k.date[i] = p[0]; k.open[i] = +p[1]; k.close[i] = +p[2];
    k.high[i] = +p[3]; k.low[i] = +p[4]; k.volume[i] = +p[5]; k.amount[i] = +p[6];
  }
  return k;
}

async function main() {
  const t0 = Date.now();
  console.log('=== 全市场选股 ===');
  console.log(`组合 ${COMBOS.length} 个 ｜ 基本面门槛：净利润>0, PE(TTM) 0~${MAX_PE}, 市值>=${MIN_MKT_CAP / 1e8}亿, ROE>${MIN_ROE}\n`);

  console.log('① 拉全市场快照…');
  const all = await fetchAllQuotes();
  console.log(`   共 ${all.length} 只`);

  // ② 粗筛：急跌 + 基本面
  const c1 = all.filter(x => x.chg <= -2 || x.gap <= -0.015);
  const c2 = c1.filter(x =>
    Number.isFinite(x.profit) && x.profit > 0 &&          // 不亏损
    Number.isFinite(x.pe) && x.pe > 0 && x.pe < MAX_PE && // 正 PE 且不极端
    Number.isFinite(x.cap) && x.cap >= MIN_MKT_CAP &&     // 不是微盘
    Number.isFinite(x.roe) && x.roe > MIN_ROE             // ROE 为正
  );
  console.log(`② 粗筛：急跌 ${c1.length} 只 → 过基本面 ${c2.length} 只（剔除 ${c1.length - c2.length} 只）`);

  const cand = c2.sort((a, b) => a.chg - b.chg).slice(0, MAX_CAND);

  // ③ 逐只算形态
  const hits = [];
  let done = 0, failed = 0, idx = 0;

  async function worker() {
    while (idx < cand.length) {
      const c = cand[idx++];
      done++;
      if (done % 50 === 0) {
        const el = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(`   …${done}/${cand.length}  命中 ${hits.length}  失败 ${failed}  ${el}s`);
      }
      let k;
      try { k = await fetchLight(c.mkt, c.code); } catch (e) { failed++; continue; }
      if (!k) { failed++; continue; }

      const d = T2.computeIndicators(k), f = T2.computePatterns(k, d);
      const i = k.close.length - 1;
      const offlow = Number.isFinite(d.lo20[i]) && k.close[i] > d.lo20[i] * 1.03;

      for (const cb of COMBOS) {
        let on = true;
        for (const id of cb.ids) {
          const pass = id === '@offlow' ? offlow : !!f[id][i];
          if (!pass) { on = false; break; }
        }
        if (!on) continue;
        hits.push({
          mkt: c.mkt, code: c.code, name: c.name || k.name, date: k.date[i],
          chg: +c.chg.toFixed(2), gap: +(c.gap * 100).toFixed(2), px: +k.close[i].toFixed(3),
          combo: cb.name, len: cb.ids.length,
          disc: +(cb.disc * 100).toFixed(1), val: +(cb.val * 100).toFixed(1), nv: cb.n,
          ind: c.ind || '—',
          pe: Number.isFinite(c.pe) ? +c.pe.toFixed(1) : null,
          cap: Number.isFinite(c.cap) ? +(c.cap / 1e8).toFixed(0) : null,
          roe: Number.isFinite(c.roe) ? +c.roe.toFixed(1) : null,
          profit: Number.isFinite(c.profit) ? +(c.profit / 1e8).toFixed(2) : null,
        });
      }
      await sleep(45);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // ④ 同票去重（保留验证集最好的组合）
  const byStock = new Map();
  for (const h of hits) {
    const key = h.mkt + '.' + h.code;
    const cur = byStock.get(key);
    if (!cur) { byStock.set(key, h); continue; }
    if (h.val > cur.val) { h.also = (cur.also || []).concat([cur.combo]); byStock.set(key, h); }
    else cur.also = (cur.also || []).concat([h.combo]);
  }
  const list = [...byStock.values()].sort((a, b) => b.val - a.val || b.disc - a.disc);

  // ⑤ 板块信息：只查命中票涉及的板块
  console.log(`\n③ 查板块走势（命中票涉及 ${new Set(list.map(x => x.ind)).size} 个行业）…`);
  const sectorMap = await fetchSectorMap();
  const sectorTrend = {};
  for (const ind of new Set(list.map(x => x.ind))) {
    const bk = sectorMap[ind];
    if (!bk) { sectorTrend[ind] = null; continue; }
    try { sectorTrend[ind] = await fetchSectorTrend(bk); }
    catch (e) { sectorTrend[ind] = null; }
    await sleep(80);
  }
  let okSec = 0;
  for (const h of list) {
    const t = sectorTrend[h.ind];
    if (t) { h.indR20 = +(t.r20 * 100).toFixed(1); h.indR5 = +(t.r5 * 100).toFixed(1); okSec++; }
    else { h.indR20 = null; h.indR5 = null; }
  }
  console.log(`   拿到 ${okSec}/${list.length} 只的板块走势`);

  // ⑥ 板块集中度
  const cnt = {};
  for (const h of list) cnt[h.ind] = (cnt[h.ind] || 0) + 1;
  const sectors = Object.entries(cnt).sort((a, b) => b[1] - a[1])
    .map(([name, n2]) => {
      const t = sectorTrend[name];
      return { name, n: n2, pct: +(n2 / list.length * 100).toFixed(0), r20: t ? +(t.r20 * 100).toFixed(1) : null };
    });
  const top = sectors[0];
  const warn = (list.length >= 3 && top && top.pct >= 40);

  const out = {
    v: new Date().toISOString().slice(0, 10),
    at: new Date().toISOString(),
    scanned: all.length,
    drop: c1.length,
    fund: c2.length,
    filtered: cand.length,
    failed,
    hits: list.length,
    combos: COMBOS.length,
    sectors,
    warn: warn ? `${list.length} 只里 ${top.n} 只属于「${top.name}」（${top.pct}%），实际是一个板块事件` : null,
    rows: list.map(h => ({
      m: h.mkt, c: h.code, n: h.name, d: h.date,
      chg: h.chg, gap: h.gap, px: h.px,
      combo: h.combo, len: h.len,
      val: h.val, disc: h.disc, nv: h.nv, src: 'V',
      ind: h.ind, indR20: h.indR20, indR5: h.indR5,
      pe: h.pe, cap: h.cap, roe: h.roe, profit: h.profit,
      also: h.also || [],
    })),
  };
  const OUT = process.env.SCREEN_OUT || 'screen.json';
  fs.writeFileSync(OUT, JSON.stringify(out));

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n④ 完成：扫描 ${cand.length} 只、失败 ${failed}、命中 ${list.length} 只，用时 ${secs}s`);
  console.log(`   ${OUT} ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
  if (warn) console.log(`   ⚠️  ${out.warn}`);
  console.log('\n 板块分布：');
  sectors.slice(0, 8).forEach(s => {
    console.log(`   ${String(s.n).padStart(2)} 只  ${s.name.padEnd(12)} ${String(s.pct).padStart(3)}%   板块20日 ${s.r20 == null ? '—' : (s.r20 >= 0 ? '+' : '') + s.r20 + '%'}`);
  });
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
