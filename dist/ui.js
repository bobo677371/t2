/* ui.js — 界面渲染
 * 只负责把 app.js 算好的东西画出来，不做任何计算
 */
(function () {
  'use strict';

  const T2 = window.T2;
  const $ = id => document.getElementById(id);
  const main = $('main'), qEl = $('q'), sug = $('suggest'), clr = $('clr');

  const KIND = { i: ['指数', 'i'], e: ['ETF', 'e'], s: ['股票', 's'] };
  const VERDICT = {
    low_n: ['样本不足', 'low_n'],
    same: ['无显著差异', 'same'],
    weak: ['单次显著', 'weak'],
    strong: ['校正后显著', 'strong'],
  };
  /* 传统语境下的方向：红=看多 绿=看空 灰=中性。只影响着色，不影响统计。 */
  const DIR_CLS = { bull: 'dir-bull', bear: 'dir-bear', neutral: 'dir-neutral' };
  const DIR_ARROW = { bull: '▲', bear: '▼', neutral: '·' };
  const DIR_TEXT = { bull: '传统看多', bear: '传统看空', neutral: '方向中性' };
  const dirCls = p => DIR_CLS[p.dir] || 'dir-neutral';
  const dirArrow = p => DIR_ARROW[p.dir] || '·';
  const dirName = (p) => `<i class="arw">${dirArrow(p)}</i>${esc(p.name)}`;
  const TREND = { up: '上行', down: '下行', flat: '走平', unknown: '—' };
  const STRENGTH = { weak: '弱', mid: '中等', strong: '强', unknown: '—' };
  const POSITION = { low: '低位', mid: '中位', high: '高位', unknown: '—' };
  const VOLATILITY = { low: '低', mid: '中', high: '高', unknown: '—' };
  const VOLUME = { shrink: '缩量', normal: '平量', expand: '放量', unknown: '—' };

  const LS_KEY = 't2.last';
  let current = null, busy = false;

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtPct = (x, d = 1) => Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '—';
  const fmtNum = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
  const hhmm = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : 'flat';

  /** 千亿/亿 单位 */
  function fmtAmt(x) {
    if (!Number.isFinite(x)) return '—';
    if (x >= 1e12) return (x / 1e12).toFixed(2) + ' 万亿';
    if (x >= 1e8) return (x / 1e8).toFixed(0) + ' 亿';
    if (x >= 1e4) return (x / 1e4).toFixed(0) + ' 万';
    return String(Math.round(x));
  }

  /* ---------------- 搜索 ---------------- */

  /* ---------------- 索引懒加载 ----------------
   * 首屏不等 294KB 的 symbols.json：默认标的是硬编码的，直接能画。
   * 索引只在第一次点搜索框时才拉，拉之前输入会提示「索引加载中」。
   */
  let _idxState = 0;          // 0=未加载 1=加载中 2=就绪 -1=失败
  let _idxPromise = null;

  function ensureIndex() {
    if (_idxState === 2) return Promise.resolve(true);
    if (_idxPromise) return _idxPromise;
    _idxState = 1;
    _idxPromise = T2.loadIndex()
      .then(() => { _idxState = 2; return true; })
      .catch(err => { _idxState = -1; _idxPromise = null; console.warn('索引加载失败', err); return false; });
    return _idxPromise;
  }

  function renderSuggest(list, note) {
    if (note) {
      sug.innerHTML = `<div class="row" style="color:var(--dim);cursor:default">${esc(note)}</div>`;
      sug.hidden = false;
      return;
    }
    if (!list.length) { sug.hidden = true; return; }
    sug.innerHTML = list.map(r => {
      const [label, c] = KIND[r.kind] || ['?', ''];
      return `<div class="row" data-m="${r.market}" data-c="${esc(r.code)}" data-k="${r.kind}">
        <span class="nm">${esc(r.name)}</span>
        <span class="cd">${r.market}.${esc(r.code)}</span>
        <span class="tag ${c}">${label}</span></div>`;
    }).join('');
    sug.hidden = false;
  }

  let timer = null;
  qEl.addEventListener('focus', () => { ensureIndex(); });

  qEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const v = qEl.value.trim();
      if (!v) { sug.hidden = true; return; }
      if (_idxState === 2) { renderSuggest(T2.search(v, 10)); return; }
      if (_idxState === -1) { renderSuggest([], '索引加载失败，可直接输 6 位代码回车'); return; }
      renderSuggest([], '正在加载搜索索引…');
      ensureIndex().then(ok => {
        const cur = qEl.value.trim();
        if (ok && cur) renderSuggest(T2.search(cur, 10));
        else if (!ok) renderSuggest([], '索引加载失败，可直接输 6 位代码回车');
      });
    }, 110);
  });

  sug.addEventListener('click', e => {
    const row = e.target.closest('.row');
    if (!row) return;
    sug.hidden = true;
    qEl.value = '';
    qEl.blur();
    load({ market: +row.dataset.m, code: row.dataset.c, kind: row.dataset.k, name: row.querySelector('.nm').textContent });
  });

  clr.onclick = () => { qEl.value = ''; sug.hidden = true; qEl.focus(); };

  qEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const v = qEl.value.trim();
      if (!v) return;
      const sym = T2.resolve(v);
      if (sym) { sug.hidden = true; qEl.value = ''; qEl.blur(); load(sym); }
    }
  });

  /* ---------------- 主流程 ---------------- */

  /* 自动刷新：iOS PWA 从后台恢复时不会重新加载页面，
   * 不做这件事就会拿着几小时前的数据当成最新。 */
  let lastLoadAt = 0;                 // 上次成功取数的时间戳
  const FRESH_MS = 3 * 60 * 1000;     // 3 分钟内不重复拉
  let autoTimer = null;

  async function load(sym, opts = {}) {
    const silent = !!opts.silent;
    if (busy) return;
    busy = true;
    const keepY = window.scrollY;
    if (!silent) {
      main.innerHTML = `<section class="empty"><div class="spinner"></div><p>拉取 ${esc(sym.name || sym.code)}…</p></section>`;
    }
    try {
      const k = await T2.fetchKline(sym);
      const d = T2.computeIndicators(k);
      const flags = T2.computePatterns(k, d);
      const state = T2.computeState(k, d);
      const baseline = await T2.loadBaseline();
      const screen = await T2.loadScreen();
      // 实时数据：任何一个失败都不影响主流程
      const [trR, brR, etR] = await Promise.allSettled([
        T2.fetchTrends(sym, 1), T2.fetchBreadth(), T2.fetchEtfFlows(),
      ]);
      const rt = {
        trend: trR.status === 'fulfilled' ? trR.value : null,
        breadth: brR.status === 'fulfilled' ? brR.value : null,
        etf: etR.status === 'fulfilled' ? etR.value : null,
      };
      const h = T2.health(k, d, flags, baseline);
      current = { sym, k, d, state, h, flags, screen, rt };
      lastLoadAt = Date.now();
      render();
      if (silent) window.scrollTo(0, keepY);
      try { localStorage.setItem(LS_KEY, JSON.stringify({ m: sym.market, c: sym.code, k: sym.kind })); } catch (_) {}
    } catch (err) {
      if (silent) {
        toast('刷新失败：' + err.message);
      } else {
    main.innerHTML = `<div class="err">加载失败：${esc(err.message)}<br><br>检查网络后重试</div>`;
      }
    } finally {
      busy = false;
    }
  }

  /** 静默刷新当前标的（数据够新就跳过） */
  function maybeRefresh(force) {
    if (!current) return;
    if (busy) return;
    if (!force && Date.now() - lastLoadAt < FRESH_MS) return;
    load(current.sym, { silent: true });
  }

  /** 轻提示 */
  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('on');
      setTimeout(() => { el.hidden = true; }, 220);
    }, 2200);
  }

  /* 回到前台 / 从 bfcache 恢复 / 切回标签页 —— 都检查一次 */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeRefresh(false);
  });
  window.addEventListener('pageshow', e => { if (e.persisted) maybeRefresh(false); });
  window.addEventListener('focus', () => maybeRefresh(false));

  function render() {
    const { sym, k, state, h } = current;
    const last = k.close.length - 1;
    const shown = k.name || sym.name || sym.code;
    const chgCls = cls(state.change);

    const triggered = h.list.filter(p => p.triggersToday);

    const dims = [
      ['趋势', TREND[state.trend], `MA5 ${fmtNum(current.d.ma5[last])} / MA20 ${fmtNum(current.d.ma20[last])}`],
      ['强度', STRENGTH[state.strength], `ADX ${fmtNum(current.d.adx14[last])}`],
      ['位置', POSITION[state.position], `年内 ${fmtNum(state.posPct, 0)}% 分位`],
      ['波动', VOLATILITY[state.volatility], `20日年化 ${fmtPct(current.d.rv20[last])}`],
    ];

    // 体检榜单：按 20 日 z 排序
    const ranked = h.list
      .filter(p => p.applies && Number.isFinite(p.z20))
      .sort((a, b) => Math.abs(b.z20) - Math.abs(a.z20))
      .slice(0, 14);

    /** 一行形态：第一行名字+结论，第二行 n 与三个周期 */
    const rowHTML = (p) => {
      const v = VERDICT[p.verdict] || ['—', ''];
      const c20 = p.up20 > p.base20 + 0.01 ? 'rate-hi' : p.up20 < p.base20 - 0.01 ? 'rate-lo' : '';
      const mkt = p.mkt ? `<div class="l3">
          <span class="lbl">全市场</span>
          <span class="pnum">n=${p.mkt.n}</span>
          <span class="hcell"><i>1日</i>${fmtPct(p.mkt.u1)}</span>
          <span class="hcell"><i>5日</i>${fmtPct(p.mkt.u5)}</span>
          <span class="hcell"><i>20日</i>${fmtPct(p.mkt.u20)}</span>
        </div>` : '';
      return `<div class="prow2" data-pid="${p.id}">
        <div class="l1">
          <span class="pn ${dirCls(p)}">${dirName(p)}</span>
          <span class="badge ${v[1]}">${v[0]}</span>
        </div>
        <div class="l2">
          <span class="lbl">本票</span>
          <span class="pnum">n=${p.n}</span>
          <span class="hcell"><i>1日</i>${fmtPct(p.upRate)}</span>
          <span class="hcell"><i>5日</i>${fmtPct(p.up5)}</span>
          <span class="hcell ${c20}"><i>20日</i>${fmtPct(p.up20)}</span>
        </div>
        ${mkt}
      </div>`;
    };

    /** 组合检查：今天同时触发的形态两两组合，看有没有超越最强成分 */
    const comboHTML = () => {
      const act = T2.activeToday(k, current.flags);
      if (act.length < 2) return '';
      const rows = [];
      for (let a = 0; a < act.length; a++) {
        for (let b = a + 1; b < act.length; b++) {
          const A = act[a], B = act[b];
          const st = T2.comboStats(k, current.flags, h.startIdx, [A, B]);
          if (!st[20].den) continue;
          const pa = h.list.find(x => x.id === A), pb = h.list.find(x => x.id === B);
          const r20 = st[20].up / st[20].den;
          const best = Math.max(pa ? pa.up20 : 0, pb ? pb.up20 : 0);
          rows.push({
            key: A + '|' + B,
            name: (pa ? pa.name : A) + ' + ' + (pb ? pb.name : B),
            n: st.n, r1: st[1].den ? st[1].up / st[1].den : NaN,
            r5: st[5].den ? st[5].up / st[5].den : NaN,
            r20, best, gain: r20 - best,
          });
        }
      }
      if (!rows.length) return '';
      rows.sort((x, y) => y.gain - x.gain);
      return `<section class="card">
        <h2>组合检查 <span class="pnum">今天同时触发了 ${act.length} 个</span></h2>
        <div class="note" style="padding-top:0;padding-bottom:8px">
          组合真正的价值，在于它<b>比其中最强的那一个还强</b>。否则只是把强条件重说一遍。
        </div>
        <div class="combolist">${rows.map(r => {
          const hi = r.gain > 0.03 ? 'gain-hi' : r.gain < -0.01 ? 'gain-lo' : '';
          return `<div class="combo">
            <div class="c1">${esc(r.name)}</div>
            <div class="c2">
              <span class="pnum">n=${r.n}</span>
              <span class="hcell"><i>1日</i>${fmtPct(r.r1)}</span>
              <span class="hcell"><i>5日</i>${fmtPct(r.r5)}</span>
              <span class="hcell"><i>20日</i>${fmtPct(r.r20)}</span>
            </div>
            <div class="c3 ${hi}">最强成分 ${fmtPct(r.best)} · 提升 ${r.gain >= 0 ? '+' : ''}${(r.gain * 100).toFixed(1)}pp${r.gain > 0.03 ? ' ↑ 有增量' : ' — 无增量'}</div>
          </div>`;
        }).join('')}</div>
      </section>`;
    };

    /** 次日上涨率：高于基准标红字，低于基准标绿字，一眼看出方向 */
    const rateCls = (p) => p.upRate > p.baseRate ? 'rate-hi' : p.upRate < p.baseRate ? 'rate-lo' : '';

    /** 今日信号：全市场扫盘命中的票（含板块、基本面、集中度） */
    const screenHTML = () => {
      const sc = current.screen;
      if (!sc || !Array.isArray(sc.rows)) return '';
      const rows = sc.rows;
      if (!rows.length) {
        return `<section class="card">
          <h2>今日信号 <span class="pnum">0 只</span></h2>
          <div class="muted">全市场扫描 ${sc.scanned} 只，今天没有票命中已验证组合</div>
        </section>`;
      }

      // 两条风险提示：板块集中度 + 板块本身在跌
      const secArr = Array.isArray(sc.sectors) ? sc.sectors : [];
      const top = secArr[0];
      const top3Pct = secArr.slice(0, 3).reduce((a, s) => a + (s.pct || 0), 0);
      const concentrated = top && sc.hits >= 5 && (top.pct >= 20 || top3Pct >= 45);
      const deepDown = rows.filter(r => Number.isFinite(r.indR20) && r.indR20 < -12);
      const secFalling = rows.length >= 5 && deepDown.length / rows.length >= 0.5;

      const warnHTML = (concentrated || secFalling) ? `<div class="sigwarn">
        ${concentrated ? `⚠️ <b>板块高度集中</b>：${sc.hits} 只里 ${top.n} 只属于「${esc(top.name)}」（${top.pct}%），前三个板块合计 ${top3Pct}%。<br>
          <span class="sw-sub">这些票同涨同跌，<b>买 5 只和买 1 只的风险差不多</b>，不是分散投资。</span><br>` : ''}
        ${secFalling ? `⚠️ <b>板块本身在跌</b>：${deepDown.length}/${rows.length} 只的所属板块近 20 日跌超 12%。<br>
          <span class="sw-sub">这不是"个股超跌"，是整个赛道在崩。均值回归的前提是板块还在，这里的前提可能不成立。</span>` : ''}
      </div>` : '';

      // 板块分布条
      const sectorHTML = Array.isArray(sc.sectors) && sc.sectors.length
        ? `<div class="seclist">${sc.sectors.slice(0, 6).map(s => {
            const down = Number.isFinite(s.r20) && s.r20 < -10;
            return `<span class="secbar ${down ? 'sec-down' : ''}">
              <b>${esc(s.name)}</b> ${s.n}只 ${s.pct}%
              ${Number.isFinite(s.r20) ? `<i>板块20日 ${s.r20 >= 0 ? '+' : ''}${s.r20}%</i>` : ''}
            </span>`;
          }).join('')}</div>`
        : '';

      const rowHTML2 = (r) => {
        const secDown = Number.isFinite(r.indR20) && r.indR20 < -12;
        const peTxt = Number.isFinite(r.pe) ? `PE ${r.pe}` : '';
        const capTxt = Number.isFinite(r.cap) ? `市值 ${r.cap}亿` : '';
        return `<div class="sig" data-m="${r.m}" data-c="${esc(r.c)}">
          <div class="s1">
            <span class="snm">${esc(r.n)}</span>
            <span class="scd">${esc(r.c)}</span>
            <span class="schg ${r.chg >= 0 ? 'up' : 'down'}">${r.chg >= 0 ? '+' : ''}${Number(r.chg).toFixed(2)}%</span>
          </div>
          <div class="s2">
            <span class="scmb">${esc(r.combo)}</span>
            <span class="sv">${r.val}%</span>
            <span class="ssrc ${r.src === 'D' ? 'src-d' : 'src-v'}">${r.src === 'D' ? '样本外' : '样本内'}</span>
          </div>
          <div class="s3">
            <span class="sind ${secDown ? 'ind-down' : ''}">${esc(r.ind || '—')}${Number.isFinite(r.indR20) ? ` · 板块20日 ${r.indR20 >= 0 ? '+' : ''}${r.indR20}%` : ''}</span>
            <span class="sfund">${peTxt}${peTxt && capTxt ? ' · ' : ''}${capTxt}</span>
          </div>
        </div>`;
      };

      return `<section class="card">
        <h2>今日信号 <span class="pnum">${sc.hits} 只 · 扫描 ${sc.scanned} 只</span></h2>
        ${warnHTML}
        <div class="note" style="padding-top:0;padding-bottom:6px">
          已剔除亏损、PE 异常、市值 &lt;30 亿、ROE≤0 的票；
          且收盘价必须高于 <b>20 日最低 3% 以上</b>（避免在还在创新低的下跌中继里买）。
        </div>
        ${sectorHTML}
        <div class="siglist">${rows.slice(0, 40).map(rowHTML2).join('')}</div>
        <div class="note">扫描于 ${sc.at ? String(sc.at).slice(0, 16).replace('T', ' ') : '—'} ·
          下跌 ${sc.drop || '—'} 只 → 过基本面 ${sc.fund || '—'} 只 → 命中 ${sc.hits} 只</div>
      </section>`;
    };

    /** 分时图 */
    const trendHTML = () => {
      const rt = current.rt;
      if (!rt || !rt.trend || !rt.trend.points || !rt.trend.points.length) return '';
      const p = rt.trend.points, pc = rt.trend.preClose;
      const last = p[p.length - 1].c;
      const chg = Number.isFinite(pc) && pc ? (last / pc - 1) * 100 : NaN;
      const hi = p.reduce((a, x) => Math.max(a, x.c), -Infinity);
      const lo = p.reduce((a, x) => Math.min(a, x.c), Infinity);
      const cls = !Number.isFinite(chg) ? 'flat' : chg >= 0 ? 'up' : 'down';
      return `<section class="card">
        <h2>分时 <span class="pnum">${esc(String(p[p.length - 1].t).slice(0, 10))}</span></h2>
        <div class="rt-sum">
          <span class="rt-px ${cls}">${last.toFixed(last > 1000 ? 2 : 3)}</span>
          <span class="${cls}">${Number.isFinite(chg) ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '—'}</span>
          <span class="rt-meta">高 ${hi.toFixed(2)} · 低 ${lo.toFixed(2)}</span>
        </div>
        <div id="trendbox" class="trendbox"></div>
        <div class="note" style="padding-bottom:0">黄线＝均价　灰虚线＝昨收 ${Number.isFinite(pc) ? pc.toFixed(2) : ''}</div>
      </section>`;
    };

    /** 市场实时：涨跌家数 + 宽基 ETF 资金流 */
    const marketHTML = () => {
      const rt = current.rt;
      if (!rt) return '';
      const br = rt.breadth || [];
      const etf = (rt.etf || []).slice().sort((a, b) => (b.flow || 0) - (a.flow || 0));
      if (!br.length && !etf.length) return '';

      const brHTML = br.length ? `<div class="brlist">${br.map(x => {
        const up = x.up || 0, dn = x.down || 0, fl = x.flat || 0;
        const tot = up + dn + fl || 1;
        return `<div class="brrow">
          <span class="brn">${esc(x.name)}</span>
          <span class="brbar"><i style="width:${(up / tot * 100).toFixed(1)}%"></i></span>
          <span class="brt"><b class="up">${up}</b><em>/</em><b class="down">${dn}</b></span>
        </div>`;
      }).join('')}</div>` : '';

      const etfHTML = etf.length ? `<div class="etflist">${etf.map(x => {
        const f = (x.flow || 0) / 1e8;
        const nm = String(x.name || '').replace(/ETF.*$/, '').replace(/华泰柏瑞|华夏|易方达|南方|华安|华泰/g, '');
        return `<div class="etfrow">
          <span class="etfn">${esc(nm)}</span>
          <span class="etfc ${x.chg >= 0 ? 'up' : 'down'}">${x.chg >= 0 ? '+' : ''}${Number(x.chg).toFixed(2)}%</span>
          <span class="etff ${f >= 0 ? 'up' : 'down'}">${f >= 0 ? '+' : ''}${f.toFixed(2)}亿</span>
        </div>`;
      }).join('')}</div>` : '';

      const sum = etf.reduce((a, x) => a + (x.flow || 0), 0) / 1e8;
      return `<section class="card">
        <h2>市场实时</h2>
        ${brHTML ? `<div class="rt-sub">涨跌家数（红涨绿跌）</div>${brHTML}` : ''}
        ${etfHTML ? `<div class="rt-sub">宽基 ETF 主力净流入　合计 <b class="${sum >= 0 ? 'up' : 'down'}">${sum >= 0 ? '+' : ''}${sum.toFixed(2)} 亿</b></div>${etfHTML}` : ''}
        <div class="note">主力净流入＝大单买额−大单卖额，盘中实时变化，收盘后才定型；不是申购赎回份额。</div>
      </section>`;
    };

    main.innerHTML = `
<section class="card quote">
  <div class="name">
    <span>${esc(shown)}<span class="code">${sym.market}.${esc(k.code)}</span></span>
    <button id="btnRefresh" class="refresh${busy ? ' spin' : ''}" aria-label="刷新" title="刷新">⟳</button>
  </div>
  <div class="big">
    <span class="px ${chgCls}">${fmtNum(state.close, 2)}</span>
    <span class="chg ${chgCls}">${state.change >= 0 ? '+' : ''}${fmtPct(state.change, 2)}</span>
  </div>
  <div class="meta">${esc(state.date)} · 成交 ${fmtAmt(state.amount)} · 共 ${k.close.length} 根日线 · 更新于 ${hhmm(lastLoadAt)}</div>
</section>

<section class="card chart-card">
  <h2>日 K</h2>
  <div id="chartbox" class="chartbox"></div>
</section>

${trendHTML()}

<section class="card">
  <h2>状态</h2>
  <div class="dims">
    ${dims.map(([k2, v, s]) => `<div class="dim"><div class="k">${k2}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}
    <div class="dim wide"><div class="k">量能</div><div class="v">${VOLUME[state.volume]}</div>
      <div class="s">量比 ${fmtNum(current.d.vr[last])} · 位于近 750 日的 ${fmtNum(state.volUpPct, 0)}% 分位</div></div>
  </div>
</section>

${marketHTML()}

<section class="card">
  <h2>今日触发 <span class="pnum">${triggered.length} 个</span></h2>
  ${triggered.length ? `<div class="legend">
      <span><b>n</b> 历史触发次数</span>
      <span>数字是 <b>1日 / 5日 / 20日</b> 后收盘上涨的比例</span>
      <span>基准 <b>${fmtPct(h.baseRate, 0)} / ${fmtPct(h.base5, 0)} / ${fmtPct(h.base20, 0)}</b></span>
    </div>
    <div class="plist">${triggered.map(rowHTML).join('')}</div>`
    : '<div class="muted">今天没有形态触发</div>'}
</section>

${comboHTML()}

<section class="card">
  <details class="fold">
  <summary><b>形态体检</b> <span class="pnum">区间 ${T2.HEALTH_FROM} 起 · 共 ${T2.PATTERNS.length} 个形态，点开看统计</span></summary>
  <div class="legend">
    <span><b>本票</b>＝这只票自己的历史（每次点开都按当前标的重算）</span>
    <span><b>全市场</b>＝同一形态在 ${h.mktStocks || 233} 只股票上的平均（参照系）</span>
    <span>本票基准 <b>${fmtPct(h.baseRate, 0)} / ${fmtPct(h.base5, 0)} / ${fmtPct(h.base20, 0)}</b></span>
  </div>
  <div class="dirlegend">
    <span class="dir-bull"><i class="arw">▲</i>传统看多</span>
    <span class="dir-bear"><i class="arw">▼</i>传统看空</span>
    <span class="dir-neutral"><i class="arw">·</i>方向中性</span>
    <span class="dl-note">名字颜色＝教科书说法；数字颜色＝相对基准高低</span>
  </div>
  <div class="plist">${ranked.map(rowHTML).join('')}</div>
  <div class="note">
    <b>形态名颜色</b>（▲红 / ▼绿 / ·灰）＝这种形态在教科书里通常被当成看多 / 看空 / 中性，
    <b>和实测结果无关</b>，两者经常相反。<br>
    <b>百分比颜色</b>（红 / 绿）＝这次实测的次日上涨率相对基准偏高 / 偏低，才是数据。<br>
    z 是与基准比较的标准化偏离：|z| ≥ 1.96 才算单次显著，
    34 个形态同时检验时需 |z| ≥ 3.17 才算校正后显著。<br>
    样本少于 ${T2.MIN_N} 次一律标「样本不足」，不当结论用。
  </div>
  </details>
</section>

${screenHTML()}

<section class="card">
  <h2>说明</h2>
  <div class="note">
    · ${k.fqt === 0 ? '指数：不复权' : 'ETF / 个股：前复权（按最新收盘价折算，价格为真实报价）'}（fqt=${k.fqt}${k.scale && k.scale !== 1 ? '，缩放 ' + k.scale.toFixed(4) : ''}）<br>
    · 「强势收盘」是尾盘拉升的日线代理，不是真尾盘<br>
    · 「缩量板」只对个股适用，指数/ETF 自动跳过<br>
    · 本工具只描述状态，不预测涨跌
  </div>
</section>`;

    // 画 K 线（必须等 innerHTML 落地后再挂载）
    const box = $('chartbox');
    if (box && window.T2Chart) {
      try { T2Chart.render(box, k, current.d); }
      catch (e) { box.innerHTML = '<div class="muted">图表渲染失败</div>'; }
    }
    // 画分时
    const tbox = $('trendbox');
    if (tbox && window.T2Chart && window.T2Chart.mountTrend && current.rt && current.rt.trend) {
      try { window.T2Chart.mountTrend(tbox, current.rt.trend); }
      catch (e) { tbox.innerHTML = '<div class="muted">分时渲染失败</div>'; }
    }

    // 手动刷新
    const btn = $('btnRefresh');
    if (btn) btn.onclick = () => { maybeRefresh(true); };
  }

  /* ---------------- 形态详情弹层 ---------------- */

  const sheet = $('sheet');
  const sheetPanel = sheet ? sheet.querySelector('.sheet-panel') : null;
  if (!sheet) console.warn('[T2] 缺少 #sheet 容器，详情弹层不可用');
  else sheet.querySelector('.sheet-bd').onclick = closeDetail;

  function openDetail(pid) {
    if (!current || !sheetPanel) return;
    const { h, k } = current;
    const p = h.list.find(x => x.id === pid);
    if (!p) return;

    const v = VERDICT[p.verdict] || ['—', ''];
    const deltaPp = Number.isFinite(p.delta) ? (p.delta * 100) : NaN;
    const bp = x => Number.isFinite(x) ? (x * 10000).toFixed(1) + ' bp' : '—';
    const cls2 = x => Number.isFinite(x) ? (x > 0 ? 'up' : x < 0 ? 'down' : 'flat') : '';

    // 判定说明
    const reasons = [];
    if (p.verdict === 'low_n') reasons.push(`触发次数 ${p.n} < ${T2.MIN_N}，样本不足，不下结论`);
    if (p.verdict === 'same') reasons.push('与基准的差异在抽样噪声范围内');
    if (p.verdict === 'weak') reasons.push('单次检验显著，但 34 个形态同时检验时未通过校正');
    if (p.verdict === 'strong') reasons.push('通过多重检验校正，是本工具里唯一够强的证据等级');
    if (Number.isFinite(deltaPp) && deltaPp < 0 && p.verdict !== 'low_n') reasons.push('方向与常见说法相反');

    // 最近触发
    const hits = p.lastHits.slice(0, 10).map(i => {
      const nx = i + 1 < k.close.length ? k.close[i + 1] / k.close[i] - 1 : NaN;
      const nx5 = i + 5 < k.close.length ? k.close[i + 5] / k.close[i] - 1 : NaN;
      return `<div class="drow">
        <span class="d">${k.date[i]}</span>
        <span class="v ${cls2(nx)}">${Number.isFinite(nx) ? (nx > 0 ? '+' : '') + (nx * 100).toFixed(2) + '%' : '—'}</span>
        <span class="v ${cls2(nx5)}">${Number.isFinite(nx5) ? (nx5 > 0 ? '+' : '') + (nx5 * 100).toFixed(2) + '%' : '—'}</span>
      </div>`;
    }).join('');

    sheetPanel.innerHTML = `
      <div class="sheet-hd">
        <div class="sh-t">
          <div class="sh-name">${esc(p.name)}</div>
          <div class="sh-desc">${esc(p.desc)}</div>
        </div>
        <button class="sh-x" aria-label="关闭">✕</button>
      </div>

      <div class="sh-badges">
        <span class="badge ${v[1]}">${v[0]}</span>
        <span class="badge dirbadge ${dirCls(p)}">${dirArrow(p)} ${DIR_TEXT[p.dir] || '方向中性'}</span>
        ${p.triggersToday ? '<span class="badge today">今日触发</span>' : ''}
      </div>

      <div class="sh-stats">
        <div><span>历史触发</span><b>${p.n} 次</b></div>
        <div><span>20 日 z 值</span><b>${Number.isFinite(p.z20) ? (p.z20 > 0 ? '+' : '') + p.z20.toFixed(2) : '—'}</b></div>
      </div>

      <div class="hztable">
        <div class="hzhead"><span>持有</span><span>本形态</span><span>基准</span><span>差</span></div>
        ${[[1, p.upRate, p.baseRate], [5, p.up5, p.base5], [20, p.up20, p.base20]].map(([h2, a, b2]) => {
          const d2 = a - b2;
          const cc = d2 > 0.01 ? 'rate-hi' : d2 < -0.01 ? 'rate-lo' : '';
          return `<div class="hzrow"><span>${h2} 日后</span><b>${fmtPct(a)}</b><b>${fmtPct(b2)}</b><b class="${cc}">${Number.isFinite(d2) ? (d2 > 0 ? '+' : '') + (d2 * 100).toFixed(1) + 'pp' : '—'}</b></div>`;
        }).join('')}
      </div>

      ${p.mkt ? `<div class="sh-mkt">
        全市场同形态（${p.mkt.n} 次）：1日 ${fmtPct(p.mkt.u1)} · 5日 ${fmtPct(p.mkt.u5)} · 20日 ${fmtPct(p.mkt.u20)}
        ${Number.isFinite(p.up20) && Number.isFinite(p.mkt.u20)
          ? `<br>本票 20 日 ${fmtPct(p.up20)}，比全市场 ${(p.up20 - p.mkt.u20) >= 0 ? '高' : '低'} ${Math.abs((p.up20 - p.mkt.u20) * 100).toFixed(1)}pp`
          : ''}
      </div>` : ''}

      ${reasons.length ? `<div class="sh-warn">${reasons.map(r => '· ' + esc(r)).join('<br>')}</div>` : ''}

      <div class="sh-sub">最近 10 次触发</div>
      <div class="dhead"><span>日期</span><span>次日</span><span>5 日后</span></div>
      <div class="dlist">${hits || '<div class="muted">无记录</div>'}</div>

      <div class="sh-foot">
        次日 = 触发日收盘 → 次日收盘；5 日后 = 触发日收盘 → 第 5 个交易日收盘。<br>
        这是历史条件概率，不是收益率，也没扣成本。
      </div>`;

    sheetPanel.querySelector('.sh-x').onclick = closeDetail;
    sheet.hidden = false;
    // 双 rAF：先让 display 变成 flex 完成一次布局，再加 open 才能触发过渡
    requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('open')));
  }

  function closeDetail() {
    if (!sheet) return;
    sheet.classList.remove('open');
    setTimeout(() => { sheet.hidden = true; }, 200);
  }

  /* 点击形态行 -> 打开详情 */
  main.addEventListener('click', e => {
    const row = e.target.closest('.prow[data-pid]');
    if (row) { openDetail(row.dataset.pid); return; }
    const sig = e.target.closest('.sig[data-c]');
    if (sig) {
      load({ market: +sig.dataset.m, code: sig.dataset.c, kind: 's', name: '' });
    }
  });

  /* ---------------- 启动 ---------------- */

  (function boot() {
    // 首屏不等索引：默认标的是硬编码的，直接开画
    let sym = { market: 1, code: '000001', kind: 'i', name: '上证指数' };
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (saved && saved.c) sym = { market: saved.m, code: saved.c, kind: saved.k, name: '' };
    } catch (_) {}
    load(sym);
  })();
})();















