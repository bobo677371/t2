/* ==========================================================================
 * T2 · 大盘技术面小工具
 * app.js — 取数 + 指标 + 形态 + 五维状态 + 体检引擎
 *
 * 设计约束（踩过的坑，改代码前先看）：
 *   1. 指数 fqt=0，ETF/个股 fqt=2（后复权）。ETF 有分红，不复权会造假跳空
 *   2. 任何形态的判定只用 T 日及之前的数据；前向收益必须落在 T 之后
 *   3. 体检区间默认 2010-01-01 起（早期市场结构不同，会污染基准率）
 *   4. 样本不足必须显示「样本不足」，不许算个数字出来
 *   5. 基准永远并排显示
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- 常量 */

  const API = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
  const QUOTE = 'https://push2.eastmoney.com/api/qt/stock/get';

  const HEALTH_FROM = '2010-01-01';   // 体检区间起点
  const MIN_N = 30;                    // 低于此样本量判定为「样本不足」
  const BONFERRONI_Z = 3.17;           // 33~34 个形态的校正阈值

  /* ---------------------------------------------------------------- 工具 */

  const isNum = v => typeof v === 'number' && isFinite(v);

  /** 滚动窗口，返回与输入等长的数组，前 w-1 个为 NaN */
  function rolling(arr, w, fn) {
    const out = new Float64Array(arr.length).fill(NaN);
    for (let i = w - 1; i < arr.length; i++) out[i] = fn(arr, i, w);
    return out;
  }

  /** 滚动均值 */
  function sma(arr, w) {
    return rolling(arr, w, (a, i, n) => {
      let s = 0, c = 0;
      for (let j = i - n + 1; j <= i; j++) { if (isNum(a[j])) { s += a[j]; c++; } }
      return c === n ? s / n : NaN;
    });
  }

  /** 滚动标准差（总体，与 numpy 默认一致） */
  function std(arr, w) {
    return rolling(arr, w, (a, i, n) => {
      let s = 0, q = 0, c = 0;
      for (let j = i - n + 1; j <= i; j++) { if (isNum(a[j])) { s += a[j]; q += a[j] * a[j]; c++; } }
      if (c !== n) return NaN;
      const m = s / n;
      return Math.sqrt(Math.max(0, q / n - m * m));
    });
  }

  function ema(arr, n) {
    const out = new Float64Array(arr.length).fill(NaN);
    const k = 2 / (n + 1);
    let prev = NaN, sum = 0, cnt = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!isNum(v)) { out[i] = prev; continue; }
      if (!isNum(prev)) {
        sum += v; cnt++;
        if (cnt === n) { prev = sum / n; out[i] = prev; }
      } else {
        prev = v * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  /** Wilder 平滑（RSI/ATR/ADX 用） */
  function wilder(arr, n) {
    const out = new Float64Array(arr.length).fill(NaN);
    let prev = NaN;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!isNum(v)) continue;
      if (!isNum(prev)) {
        if (i >= n - 1) {
          let s = 0, c = 0;
          for (let j = i - n + 1; j <= i; j++) if (isNum(arr[j])) { s += arr[j]; c++; }
          if (c === n) { prev = s / n; out[i] = prev; }
        }
      } else {
        prev = (prev * (n - 1) + v) / n;
        out[i] = prev;
      }
    }
    return out;
  }

  /** 分位排名：v 在最近 w 个样本中的百分位（0-100） */
  function pctRank(arr, w) {
    return rolling(arr, w, (a, i, n) => {
      const v = a[i];
      if (!isNum(v)) return NaN;
      let less = 0, tot = 0;
      for (let j = i - n + 1; j <= i; j++) {
        if (isNum(a[j])) { tot++; if (a[j] < v) less++; }
      }
      return tot ? (less / tot) * 100 : NaN;
    });
  }

  /** 一阶差分，首元素 NaN */
  function diff(arr) {
    const out = new Float64Array(arr.length).fill(NaN);
    for (let i = 1; i < arr.length; i++) out[i] = arr[i] - arr[i - 1];
    return out;
  }

  function rollingMax(arr, w) {
    return rolling(arr, w, (a, i, n) => {
      let m = -Infinity;
      for (let j = i - n + 1; j <= i; j++) if (isNum(a[j]) && a[j] > m) m = a[j];
      return m === -Infinity ? NaN : m;
    });
  }

  function rollingMin(arr, w) {
    return rolling(arr, w, (a, i, n) => {
      let m = Infinity;
      for (let j = i - n + 1; j <= i; j++) if (isNum(a[j]) && a[j] < m) m = a[j];
      return m === Infinity ? NaN : m;
    });
  }

  /* ---------------------------------------------------------------- 标的解析 */

  let INDEX = null;   // [{market, code, name, py, kind}]

  async function loadIndex(url = 'symbols.json') {
    if (INDEX) return INDEX;
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error('索引加载失败 HTTP ' + res.status);
    const doc = await res.json();
    INDEX = doc.d.map(r => ({ market: r[0], code: r[1], name: r[2], py: r[3], kind: r[4] }));
    INDEX.__ver = doc.v;
    return INDEX;
  }

  const KIND_BONUS = { i: 3, e: 1, s: 0 };

  /** 与 test_index.py 完全一致的打分 */
  function scoreOne(code, name, py, q) {
    if (code === q) return 100;
    if (code.startsWith(q)) return 92;
    if (py && py.startsWith(q)) return 84;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 72;
    if (py && py.includes(q)) return 55;
    return 0;
  }

  function search(q, limit = 12) {
    q = (q || '').trim().toLowerCase();
    if (!q || !INDEX) return [];
    const hits = [];
    for (const r of INDEX) {
      const base = scoreOne(r.code, r.name, r.py, q);
      if (base) hits.push({ ...r, score: base + (KIND_BONUS[r.kind] || 0) });
    }
    hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length || (a.code < b.code ? -1 : 1));
    return hits.slice(0, limit);
  }

  /** 按代码前缀推断市场：1=沪 0=深/北 */
  function guessMarket(code) {
    if (/^(60|68|51|58|56|50|11|13|90)/.test(code)) return 1;
    return 0;
  }

  /** 解析任意输入 -> 标的对象；解析不出返回 null */
  function resolve(query) {
    const raw = (query || '').trim();
    if (!raw) return null;

    // 1) 索引精确命中（代码或别名）
    const lower = raw.toLowerCase();
    const hit = INDEX && INDEX.find(r => r.code === lower);
    if (hit) return { ...hit };

    // 2) 通达信 / 带前缀写法：1A0001、sh000001、000001.SH
    let m = raw.match(/^(\d)[aA](\d{6})$/);
    if (m) return { market: +m[1], code: m[2], name: '', py: '', kind: '?', guessed: true };
    m = raw.match(/^(sh|sz|bj)(\d{6})$/i);
    if (m) {
      const p = m[1].toLowerCase();
      return { market: p === 'sh' ? 1 : 0, code: m[2], name: '', py: '', kind: '?', guessed: true };
    }
    m = raw.match(/^(\d{6})\.(sh|sz|bj)$/i);
    if (m) return { market: m[2].toLowerCase() === 'sh' ? 1 : 0, code: m[1], name: '', py: '', kind: '?', guessed: true };

    // 3) 纯 6 位数字：按前缀推断（索引没有则猜）
    if (/^\d{6}$/.test(raw)) {
      return { market: guessMarket(raw), code: raw, name: '', py: '', kind: '?', guessed: true };
    }

    // 4) 名称/拼音模糊 -> 取第一条
    const cand = search(raw, 1);
    if (cand.length) return cand[0];

    return null;
  }

  function secid(sym) { return sym.market + '.' + sym.code; }

  /** 用 stock/get 校验并取回名称（索引兜底用） */
  async function probeName(sym) {
    const qs = new URLSearchParams({ secid: secid(sym), fields: 'f57,f58' });
    const res = await fetch(`${QUOTE}?${qs}`, { cache: 'no-store' });
    const doc = await res.json();
    const d = doc && doc.data;
    return d && d.f58 ? String(d.f58) : null;
  }

  /* ---------------------------------------------------------------- 取数 */

  function fqtFor(sym) {
    // 指数不复权；ETF / 个股后复权（ETF 有分红，不复权会造假跳空）
    return sym.kind === 'i' ? 0 : 2;
  }

  async function fetchKline(sym, opts = {}) {
    const fqt = opts.fqt !== undefined ? opts.fqt : fqtFor(sym);
    const qs = new URLSearchParams({
      secid: secid(sym),
      fields1: 'f1,f2,f3,f4',
      fields2: 'f51,f52,f53,f54,f55,f56,f57',
      klt: '101',
      fqt: String(fqt),
      beg: '19900101',
      end: '20500101',
    });
    const res = await fetch(`${API}?${qs}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('行情接口 HTTP ' + res.status);
    const doc = await res.json();
    const d = doc && doc.data;
    if (!d || !d.klines || !d.klines.length) throw new Error('该标的暂无数据');

    const n = d.klines.length;
    const k = {
      name: d.name || sym.name || '',
      code: d.code || sym.code,
      kind: sym.kind || 's',     // 形态适用性依赖它；缺失会把指数当成股票
      fqt,
      date: new Array(n), open: new Float64Array(n), high: new Float64Array(n),
      low: new Float64Array(n), close: new Float64Array(n),
      volume: new Float64Array(n), amount: new Float64Array(n),
    };
    for (let i = 0; i < n; i++) {
      const p = d.klines[i].split(',');
      k.date[i] = p[0];
      k.open[i] = +p[1];
      k.close[i] = +p[2];
      k.high[i] = +p[3];
      k.low[i] = +p[4];
      k.volume[i] = +p[5];
      k.amount[i] = +p[6];
    }
    return k;
  }

  /* ---------------------------------------------------------------- 指标 */

  function computeIndicators(k) {
    const { close, high, low, open, amount } = k;
    const n = close.length;

    const ret = new Float64Array(n).fill(NaN);
    for (let i = 1; i < n; i++) ret[i] = close[i] / close[i - 1] - 1;

    const logRet = new Float64Array(n).fill(NaN);
    for (let i = 1; i < n; i++) logRet[i] = Math.log(close[i] / close[i - 1]);

    // 均线
    const ma5 = sma(close, 5), ma10 = sma(close, 10),
          ma20 = sma(close, 20), ma60 = sma(close, 60);

    // 真实波幅 & ATR
    const tr = new Float64Array(n).fill(NaN);
    for (let i = 1; i < n; i++) {
      tr[i] = Math.max(high[i] - low[i],
                       Math.abs(high[i] - close[i - 1]),
                       Math.abs(low[i] - close[i - 1]));
    }
    const atr14 = wilder(tr, 14);

    // RSI14
    const up = new Float64Array(n).fill(NaN), dn = new Float64Array(n).fill(NaN);
    for (let i = 1; i < n; i++) {
      const d = close[i] - close[i - 1];
      up[i] = d > 0 ? d : 0;
      dn[i] = d < 0 ? -d : 0;
    }
    const au = wilder(up, 14), ad = wilder(dn, 14);
    const rsi14 = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (isNum(au[i]) && isNum(ad[i])) rsi14[i] = 100 - 100 / (1 + au[i] / (ad[i] || 1e-12));
    }

    // MACD
    const ema12 = ema(close, 12), ema26 = ema(close, 26);
    const dif = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (isNum(ema12[i]) && isNum(ema26[i])) dif[i] = ema12[i] - ema26[i];
    const dea = ema(dif, 9);
    const macd = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (isNum(dif[i]) && isNum(dea[i])) macd[i] = (dif[i] - dea[i]) * 2;

    // ADX14
    const pDM = new Float64Array(n).fill(NaN), nDM = new Float64Array(n).fill(NaN);
    for (let i = 1; i < n; i++) {
      const upM = high[i] - high[i - 1], dnM = low[i - 1] - low[i];
      pDM[i] = (upM > dnM && upM > 0) ? upM : 0;
      nDM[i] = (dnM > upM && dnM > 0) ? dnM : 0;
    }
    const apDM = wilder(pDM, 14), anDM = wilder(nDM, 14), aTR = atr14;
    const pDI = new Float64Array(n).fill(NaN), nDI = new Float64Array(n).fill(NaN), dx = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (isNum(apDM[i]) && isNum(aTR[i]) && aTR[i] > 0) pDI[i] = 100 * apDM[i] / aTR[i];
      if (isNum(anDM[i]) && isNum(aTR[i]) && aTR[i] > 0) nDI[i] = 100 * anDM[i] / aTR[i];
      if (isNum(pDI[i]) && isNum(nDI[i]) && pDI[i] + nDI[i] > 0) dx[i] = 100 * Math.abs(pDI[i] - nDI[i]) / (pDI[i] + nDI[i]);
    }
    const adx14 = wilder(dx, 14);

    // 布林
    const sd20 = std(close, 20);
    const bollUp = new Float64Array(n).fill(NaN), bollDn = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (isNum(ma20[i]) && isNum(sd20[i])) { bollUp[i] = ma20[i] + 2 * sd20[i]; bollDn[i] = ma20[i] - 2 * sd20[i]; }
    }

    // 量比：成交额 / 20 日均额
    const amt20 = sma(amount, 20);
    const vr = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (isNum(amt20[i]) && amt20[i] > 0) vr[i] = amount[i] / amt20[i];

    // 波动：20 日已实现波动（年化）
    const rv20 = new Float64Array(n).fill(NaN);
    const sdLog = std(logRet, 20);
    for (let i = 0; i < n; i++) if (isNum(sdLog[i])) rv20[i] = sdLog[i] * Math.sqrt(243);

    // 位置
    const hi250 = rollingMax(high, 250), lo250 = rollingMin(low, 250);
    const hi20 = rollingMax(high, 20), lo20 = rollingMin(low, 20);

    return {
      n, ret, logRet, ma5, ma10, ma20, ma60, atr14, rsi14,
      dif, dea, macd, adx14, pDI, nDI, bollUp, bollDn, sd20,
      vr, rv20, hi250, lo250, hi20, lo20,
      rv20Pct: pctRank(rv20, 750),
      vrPct: pctRank(vr, 750),
    };
  }

  /* ---------------------------------------------------------------- 形态库 */

  /* 每个形态：{ id, name, cat, desc, applies, fn }
   * applies: ['i','e','s'] 中允许的类型
   * fn(k, ind, i) -> boolean
   */

  const P = [];

  function def(id, name, cat, desc, fn, applies) {
    P.push({ id, name, cat, desc, fn, applies: applies || ['i', 'e', 's'] });
  }

  const isUp = (k, i) => k.close[i] > k.open[i];
  const body = (k, i) => Math.abs(k.close[i] - k.open[i]);
  const rng = (k, i) => Math.max(k.high[i] - k.low[i], 1e-9);
  const upper = (k, i) => k.high[i] - Math.max(k.close[i], k.open[i]);
  const lower = (k, i) => Math.min(k.close[i], k.open[i]) - k.low[i];

  /* --- 单根 K 线 (8) --- */
  def('big_yang', '大阳线', 'k', '涨 >2% 且实体占振幅 70% 以上',
    (k, d, i) => d.ret[i] > 0.02 && body(k, i) >= 0.7 * rng(k, i));

  def('big_yin', '大阴线', 'k', '跌 >2% 且实体占振幅 70% 以上',
    (k, d, i) => d.ret[i] < -0.02 && body(k, i) >= 0.7 * rng(k, i));

  def('marubozu', '光头光脚', 'k', '实体占振幅 95% 以上，几乎没有影线',
    (k, d, i) => body(k, i) >= 0.95 * rng(k, i));

  def('hammer', '锤头线', 'k', '下影 ≥ 2 倍实体，上影很小',
    (k, d, i) => lower(k, i) >= 2 * body(k, i) && upper(k, i) <= 0.5 * body(k, i) && body(k, i) / rng(k, i) <= 0.35);

  def('inv_hammer', '倒锤头', 'k', '上影 ≥ 2 倍实体，下影很小',
    (k, d, i) => upper(k, i) >= 2 * body(k, i) && lower(k, i) <= 0.5 * body(k, i) && body(k, i) / rng(k, i) <= 0.35);

  def('doji', '十字星', 'k', '实体 ≤ 振幅 10%',
    (k, d, i) => body(k, i) / rng(k, i) <= 0.10 && rng(k, i) > 0);

  def('long_lower', '长下影', 'k', '下影 ≥ 振幅一半',
    (k, d, i) => lower(k, i) >= 0.5 * rng(k, i));

  def('long_upper', '长上影', 'k', '上影 ≥ 振幅一半',
    (k, d, i) => upper(k, i) >= 0.5 * rng(k, i));

  /* --- K 线组合 (6) --- */
  def('bull_engulf', '看涨吞没', 'k2', '阳包阴：今日实体完全包住昨日阴线实体',
    (k, d, i) => i > 0 && d.ret[i] > 0 && d.ret[i - 1] < 0 &&
      body(k, i) > body(k, i - 1) && k.close[i] > k.open[i - 1] && k.open[i] < k.close[i - 1]);

  def('bear_engulf', '看跌吞没', 'k2', '阴包阳：今日实体完全包住昨日阳线实体',
    (k, d, i) => i > 0 && d.ret[i] < 0 && d.ret[i - 1] > 0 &&
      body(k, i) > body(k, i - 1) && k.close[i] < k.open[i - 1] && k.open[i] > k.close[i - 1]);

  def('harami', '孕线', 'k2', '今日实体完全落在昨日实体之内',
    (k, d, i) => i > 0 && body(k, i) < body(k, i - 1) &&
      Math.max(k.open[i], k.close[i]) < Math.max(k.open[i - 1], k.close[i - 1]) &&
      Math.min(k.open[i], k.close[i]) > Math.min(k.open[i - 1], k.close[i - 1]));

  def('three_white', '红三兵', 'k2', '连续三根阳线',
    (k, d, i) => i > 1 && d.ret[i] > 0 && d.ret[i - 1] > 0 && d.ret[i - 2] > 0);

  def('three_black', '三只乌鸦', 'k2', '连续三根阴线',
    (k, d, i) => i > 1 && d.ret[i] < 0 && d.ret[i - 1] < 0 && d.ret[i - 2] < 0);

  def('gap', '跳空缺口', 'k2', '今日最低高于昨日最高，或今日最高低于昨日最低',
    (k, d, i) => i > 0 && (k.low[i] > k.high[i - 1] || k.high[i] < k.low[i - 1]));

  /* --- 量价 (7)，阈值按分位思路：1.3 / 0.8 约对应 90% / 10% 分位 --- */
  def('vol_up_rise', '放量涨', 'v', '涨且量比 > 1.3',
    (k, d, i) => d.ret[i] > 0 && d.vr[i] > 1.3);

  def('vol_up_fall', '放量跌', 'v', '跌且量比 > 1.3',
    (k, d, i) => d.ret[i] < 0 && d.vr[i] > 1.3);

  def('vol_dn_rise', '缩量涨', 'v', '涨且量比 < 0.8',
    (k, d, i) => d.ret[i] > 0 && d.vr[i] < 0.8);

  def('vol_dn_fall', '缩量跌', 'v', '跌且量比 < 0.8',
    (k, d, i) => d.ret[i] < 0 && d.vr[i] < 0.8);

  def('divergence', '量价背离', 'v', '收盘创 20 日新高，但量比 < 1',
    (k, d, i) => isNum(d.hi20[i]) && k.close[i] >= d.hi20[i] && d.vr[i] < 1);

  def('huge_vol', '天量', 'v', '量比 ≥ 2（约 99% 分位以上）',
    (k, d, i) => d.vr[i] >= 2);

  def('tiny_vol', '地量', 'v', '量比 ≤ 0.5',
    (k, d, i) => d.vr[i] <= 0.5);

  /* --- 趋势位置 (7) --- */
  def('above_ma20', '站上 MA20', 't', '收盘由下向上穿越 MA20',
    (k, d, i) => i > 0 && isNum(d.ma20[i]) && isNum(d.ma20[i - 1]) &&
      k.close[i] > d.ma20[i] && k.close[i - 1] <= d.ma20[i - 1]);

  def('below_ma20', '跌破 MA20', 't', '收盘由上向下穿越 MA20',
    (k, d, i) => i > 0 && isNum(d.ma20[i]) && isNum(d.ma20[i - 1]) &&
      k.close[i] < d.ma20[i] && k.close[i - 1] >= d.ma20[i - 1]);

  def('break_high20', '突破 20 日新高', 't', '收盘 ≥ 近 20 日最高',
    (k, d, i) => isNum(d.hi20[i]) && k.close[i] >= d.hi20[i]);

  def('break_low20', '跌破 20 日新低', 't', '收盘 ≤ 近 20 日最低',
    (k, d, i) => isNum(d.lo20[i]) && k.close[i] <= d.lo20[i]);

  def('bull_align', '均线多头排列', 't', 'MA5 > MA20 > MA60 且收盘在 MA5 上',
    (k, d, i) => isNum(d.ma60[i]) && d.ma20[i] > d.ma60[i] && d.ma5[i] > d.ma20[i] && k.close[i] > d.ma5[i]);

  // 粘合度：四条均线的离散系数，取近 250 日 20% 分位以下
  function squeezeSeries(k, d) {
    const n = k.close.length;
    const out = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const v = [d.ma5[i], d.ma10[i], d.ma20[i], d.ma60[i]];
      if (v.some(x => !isNum(x))) continue;
      const m = v.reduce((a, b) => a + b, 0) / 4;
      const s = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / 4);
      out[i] = s / m;
    }
    return out;
  }
  const SQUEEZE_TH = 20;  // 分位阈值

  def('ma_squeeze', '均线粘合', 't', 'MA5/10/20/60 离散系数处于近 250 日 20% 分位以下',
    (k, d, i) => {
      if (!d.__sq) d.__sq = squeezeSeries(k, d);
      const sq = d.__sq;
      if (!isNum(sq[i])) return false;
      let less = 0, tot = 0;
      for (let j = Math.max(0, i - 249); j <= i; j++) if (isNum(sq[j])) { tot++; if (sq[j] < sq[i]) less++; }
      return tot > 60 && (less / tot) * 100 <= SQUEEZE_TH;
    });

  def('squeeze_break', '均线粘合突破', 't', '粘合状态下首次上穿四条均线最大值（同一次粘合只计一次）',
    (k, d, i) => {
      if (!d.__sq) d.__sq = squeezeSeries(k, d);
      const sq = d.__sq;
      if (!isNum(sq[i])) return false;
      let less = 0, tot = 0;
      for (let j = Math.max(0, i - 249); j <= i; j++) if (isNum(sq[j])) { tot++; if (sq[j] < sq[i]) less++; }
      if (tot < 60 || (less / tot) * 100 > SQUEEZE_TH) return false;
      const mx = Math.max(d.ma5[i], d.ma10[i], d.ma20[i], d.ma60[i]);
      if (!(k.close[i] > mx)) return false;
      // 去重：前一日若也满足「粘合 + 在最大值之上」，则本次不算首次
      const prevOk = (j) => {
        if (j < 1 || !isNum(sq[j])) return false;
        let l2 = 0, t2 = 0;
        for (let q = Math.max(0, j - 249); q <= j; q++) if (isNum(sq[q])) { t2++; if (sq[q] < sq[j]) l2++; }
        if (t2 < 60 || (l2 / t2) * 100 > SQUEEZE_TH) return false;
        return k.close[j] > Math.max(d.ma5[j], d.ma10[j], d.ma20[j], d.ma60[j]);
      };
      return !prevOk(i - 1);
    });

  /* --- 指标 (4) --- */
  def('macd_gold', 'MACD 金叉', 'm', 'DIF 由下向上穿越 DEA',
    (k, d, i) => i > 0 && isNum(d.dif[i]) && isNum(d.dea[i]) && isNum(d.dif[i - 1]) && isNum(d.dea[i - 1]) &&
      d.dif[i] > d.dea[i] && d.dif[i - 1] <= d.dea[i - 1]);

  def('macd_dead', 'MACD 死叉', 'm', 'DIF 由上向下穿越 DEA',
    (k, d, i) => i > 0 && isNum(d.dif[i]) && isNum(d.dea[i]) && isNum(d.dif[i - 1]) && isNum(d.dea[i - 1]) &&
      d.dif[i] < d.dea[i] && d.dif[i - 1] >= d.dea[i - 1]);

  def('rsi_ob', 'RSI 超买', 'm', 'RSI14 > 70',
    (k, d, i) => d.rsi14[i] > 70);

  def('rsi_os', 'RSI 超卖', 'm', 'RSI14 < 30',
    (k, d, i) => d.rsi14[i] < 30);

  /* --- A 股特色 (2) --- */

  // 涨停幅度：按代码前缀
  function limitRate(code) {
    if (/^300|^688/.test(code)) return 0.20;
    if (/^(8|4|92)/.test(code)) return 0.30;
    if (/^(60|000|001|002|003)/.test(code)) return 0.10;
    return 0.10;
  }

  def('limit_up_shrink', '缩量板', 'a', '涨停封板且量比 < 0.8（仅个股，指数无此形态）',
    (k, d, i) => {
      if (i < 1) return false;
      const lim = limitRate(k.code || '');
      const chg = k.close[i] / k.close[i - 1] - 1;
      return Math.abs(k.close[i] - k.high[i]) < 1e-6 && chg >= lim - 0.002 && d.vr[i] < 0.8;
    }, ['s']);

  def('strong_close', '强势收盘', 'a', '收盘位于当日区间上部 20% 且当日上涨（尾盘拉升的日线代理）',
    (k, d, i) => {
      const r = rng(k, i);
      return (k.close[i] - k.low[i]) / r >= 0.8 && d.ret[i] > 0;
    });

  /* --- 计算全历史触发 --- */

  function computePatterns(k, d) {
    const n = k.close.length;
    const flags = {};
    for (const p of P) {
      const arr = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        try { arr[i] = p.fn(k, d, i) ? 1 : 0; } catch (e) { arr[i] = 0; }
      }
      flags[p.id] = arr;
    }
    return flags;
  }

  /* ---------------------------------------------------------------- 体检引擎 */

  /**
   * 对每个形态统计：触发次数、次日上涨率、基准、z、5日/10日平均收益、结论
   * 只用 HEALTH_FROM 之后的数据，且前向收益不得越过数组末尾
   */
  function health(k, d, flags) {
    const n = k.close.length;
    const startIdx = (() => {
      for (let i = 0; i < n; i++) if (k.date[i] >= HEALTH_FROM) return i;
      return 0;
    })();

    // 基准：区间内无条件次日上涨率
    let baseUp = 0, baseN = 0;
    for (let i = startIdx; i < n - 1; i++) {
      baseN++;
      if (k.close[i + 1] > k.close[i]) baseUp++;
    }
    const baseRate = baseN ? baseUp / baseN : NaN;

    const out = [];
    for (const p of P) {
      if (!p.applies.includes(k.kind || 's')) {
        out.push({ ...p, applies: false, n: 0, verdict: 'skip' });
        continue;
      }
      const f = flags[p.id];
      let cnt = 0, up = 0, f5 = [], f10 = [], hitIdx = [];
      for (let i = startIdx; i < n - 1; i++) {
        if (!f[i]) continue;
        cnt++;
        if (k.close[i + 1] > k.close[i]) up++;
        if (i + 5 < n) f5.push(k.close[i + 5] / k.close[i] - 1);
        if (i + 10 < n) f10.push(k.close[i + 10] / k.close[i] - 1);
        if (hitIdx.length < 10) hitIdx.push(i);
      }
      const upRate = cnt ? up / cnt : NaN;
      const se = cnt ? Math.sqrt(baseRate * (1 - baseRate) / cnt) : NaN;
      const z = cnt ? (upRate - baseRate) / se : NaN;
      const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

      let verdict;
      if (cnt < MIN_N) verdict = 'low_n';
      else if (Math.abs(z) < 1.96) verdict = 'same';
      else if (Math.abs(z) >= BONFERRONI_Z) verdict = 'strong';
      else verdict = 'weak';

      out.push({
        id: p.id, name: p.name, cat: p.cat, desc: p.desc,
        applies: true, n: cnt, upRate, baseRate, delta: upRate - baseRate, z,
        fwd5: avg(f5), fwd10: avg(f10), verdict,
        lastHits: hitIdx.reverse().slice(0, 10),
        triggersToday: n > 0 ? !!f[n - 1] : false,
      });
    }
    return { baseRate, baseN, startIdx, list: out };
  }

  /* ---------------------------------------------------------------- 五维状态 */

  function computeState(k, d) {
    const n = k.close.length, i = n - 1;
    const c = k.close[i];

    // 趋势：均线排列 + MA20 斜率 + 偏离
    let trend = 'unknown';
    if (isNum(d.ma60[i]) && isNum(d.ma20[i])) {
      const slopeOk = i >= 20 && isNum(d.ma20[i - 20]) && d.ma20[i] > d.ma20[i - 20];
      const slopeDn = i >= 20 && isNum(d.ma20[i - 20]) && d.ma20[i] < d.ma20[i - 20];
      if (d.ma5[i] > d.ma20[i] && d.ma20[i] > d.ma60[i] && slopeOk) trend = 'up';
      else if (d.ma5[i] < d.ma20[i] && d.ma20[i] < d.ma60[i] && slopeDn) trend = 'down';
      else trend = 'flat';
    }

    // 强度
    let strength = 'unknown';
    if (isNum(d.adx14[i])) strength = d.adx14[i] < 20 ? 'weak' : d.adx14[i] > 40 ? 'strong' : 'mid';

    // 位置（250 日分位）
    let posPct = NaN;
    if (isNum(d.hi250[i]) && isNum(d.lo250[i]) && d.hi250[i] > d.lo250[i]) {
      posPct = (c - d.lo250[i]) / (d.hi250[i] - d.lo250[i]) * 100;
    }
    let position = 'unknown';
    if (isNum(posPct)) position = posPct < 30 ? 'low' : posPct > 70 ? 'high' : 'mid';

    // 波动
    let volPct = d.rv20Pct[i];
    let volatility = 'unknown';
    if (isNum(volPct)) volatility = volPct < 30 ? 'low' : volPct > 70 ? 'high' : 'mid';

    // 量能
    let volUpPct = d.vrPct[i];
    let volume = 'unknown';
    if (isNum(volUpPct)) volume = volUpPct < 25 ? 'shrink' : volUpPct > 80 ? 'expand' : 'normal';

    return {
      trend, strength, position, posPct, volatility, volPct, volume, volUpPct,
      close: c, change: d.ret[i], date: k.date[i],
      amount: k.amount[i], atrPct: d.atr14[i] / c,
    };
  }

  /* ---------------------------------------------------------------- 导出 */

  global.T2 = {
    // 常量
    PATTERNS: P, HEALTH_FROM, MIN_N,
    // 工具
    sma, std, ema, diff, pctRank, rollingMax, rollingMin,
    // 解析
    loadIndex, search, resolve, secid, guessMarket, probeName,
    // 数据
    fetchKline, fqtFor,
    // 计算
    computeIndicators, computePatterns, health, computeState,
    getIndex: () => INDEX,
  };
})(window);
