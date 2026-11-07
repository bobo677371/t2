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

  async function load(sym) {
    if (busy) return;
    busy = true;
    main.innerHTML = `<section class="empty"><div class="spinner"></div><p>拉取 ${esc(sym.name || sym.code)}…</p></section>`;
    try {
      const k = await T2.fetchKline(sym);
      const d = T2.computeIndicators(k);
      const flags = T2.computePatterns(k, d);
      const state = T2.computeState(k, d);
      const h = T2.health(k, d, flags);
      current = { sym, k, d, state, h };
      render();
      try { localStorage.setItem(LS_KEY, JSON.stringify({ m: sym.market, c: sym.code, k: sym.kind })); } catch (_) {}
    } catch (err) {
      main.innerHTML = `<div class="err">加载失败：${esc(err.message)}<br><br>检查网络后重试</div>`;
    } finally {
      busy = false;
    }
  }

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

    // 体检榜单：只显示有统计意义的，按 |z| 排
    const ranked = h.list
      .filter(p => p.applies && Number.isFinite(p.z))
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
      .slice(0, 12);

    /** 次日上涨率：高于基准标红字，低于基准标绿字，一眼看出方向 */
    const rateCls = (p) => p.upRate > p.baseRate ? 'rate-hi' : p.upRate < p.baseRate ? 'rate-lo' : '';

    main.innerHTML = `
<section class="card quote">
  <div class="name">${esc(shown)}<span class="code">${sym.market}.${esc(k.code)}</span></div>
  <div class="big">
    <span class="px ${chgCls}">${fmtNum(state.close, 2)}</span>
    <span class="chg ${chgCls}">${state.change >= 0 ? '+' : ''}${fmtPct(state.change, 2)}</span>
  </div>
  <div class="meta">${esc(state.date)} · 成交 ${fmtAmt(state.amount)} · 共 ${k.close.length} 根日线</div>
</section>

<section class="card chart-card">
  <h2>日 K</h2>
  <div id="chartbox" class="chartbox"></div>
</section>

<section class="card">
  <h2>状态</h2>
  <div class="dims">
    ${dims.map(([k2, v, s]) => `<div class="dim"><div class="k">${k2}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}
    <div class="dim wide"><div class="k">量能</div><div class="v">${VOLUME[state.volume]}</div>
      <div class="s">量比 ${fmtNum(current.d.vr[last])} · 位于近 750 日的 ${fmtNum(state.volUpPct, 0)}% 分位</div></div>
  </div>
</section>

<section class="card">
  <h2>今日触发 <span class="pnum">${triggered.length} 个</span></h2>
  ${triggered.length ? `<div class="legend">
      <span><b>n</b> 历史触发次数</span>
      <span><b>次日涨</b> 触发后次日收涨的比例</span>
      <span>基准 <b>${fmtPct(h.baseRate)}</b></span>
    </div>
    <div class="plist">${triggered.map(p => {
      const v = VERDICT[p.verdict] || ['—', ''];
      return `<div class="prow" data-pid="${p.id}"><span class="pn ${dirCls(p)}">${dirName(p)}</span>
        <span class="pnum">n=${p.n}</span>
        <span class="pnum ${rateCls(p)}">${fmtPct(p.upRate)}</span>
        <span class="badge ${v[1]}">${v[0]}</span></div>`;
    }).join('')}</div>`
    : '<div class="muted">今天没有形态触发</div>'}
</section>

<section class="card">
  <h2>形态体检 <span class="pnum">区间 ${T2.HEALTH_FROM} 起</span></h2>
  <div class="legend">
    <span><b>n</b> 历史触发次数</span>
    <span><b>次日涨</b> 触发后次日收涨的比例</span>
    <span>全样本基准 <b>${fmtPct(h.baseRate)}</b></span>
    <span><b>z</b> 与基准的标准化偏离</span>
  </div>
  <div class="dirlegend">
    <span class="dir-bull"><i class="arw">▲</i>传统看多</span>
    <span class="dir-bear"><i class="arw">▼</i>传统看空</span>
    <span class="dir-neutral"><i class="arw">·</i>方向中性</span>
    <span class="dl-note">名字颜色＝教科书里的说法，不是实测结论</span>
  </div>
  <div class="plist">
    ${ranked.map(p => {
      const v = VERDICT[p.verdict] || ['—', ''];
      return `<div class="prow" data-pid="${p.id}"><span class="pn ${dirCls(p)}">${dirName(p)}</span>
        <span class="pnum">n=${p.n}</span>
        <span class="pnum ${rateCls(p)}">${fmtPct(p.upRate)}</span>
        <span class="pz">${p.z >= 0 ? '+' : ''}${fmtNum(p.z)}</span>
        <span class="badge ${v[1]}">${v[0]}</span></div>`;
    }).join('')}
  </div>
  <div class="note">
    <b>形态名颜色</b>（▲红 / ▼绿 / ·灰）＝这种形态在教科书里通常被当成看多 / 看空 / 中性，
    <b>和实测结果无关</b>，两者经常相反。<br>
    <b>百分比颜色</b>（红 / 绿）＝这次实测的次日上涨率相对基准偏高 / 偏低，才是数据。<br>
    z 是与基准比较的标准化偏离：|z| ≥ 1.96 才算单次显著，
    34 个形态同时检验时需 |z| ≥ 3.17 才算校正后显著。<br>
    样本少于 ${T2.MIN_N} 次一律标「样本不足」，不当结论用。
  </div>
</section>

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
        <div><span>次日上涨</span><b class="${p.upRate > p.baseRate ? 'rate-hi' : 'rate-lo'}">${fmtPct(p.upRate)}</b></div>
        <div><span>基准</span><b>${fmtPct(p.baseRate)}</b></div>
        <div><span>差异</span><b class="${cls2(deltaPp)}">${Number.isFinite(deltaPp) ? (deltaPp > 0 ? '+' : '') + deltaPp.toFixed(1) + ' pp' : '—'}</b></div>
        <div><span>z 值</span><b>${Number.isFinite(p.z) ? (p.z > 0 ? '+' : '') + p.z.toFixed(2) : '—'}</b></div>
        <div><span>5 日均涨</span><b class="${cls2(p.fwd5)}">${bp(p.fwd5)}</b></div>
        <div><span>10 日均涨</span><b class="${cls2(p.fwd10)}">${bp(p.fwd10)}</b></div>
      </div>

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
    if (row) openDetail(row.dataset.pid);
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

