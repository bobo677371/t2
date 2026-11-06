/* chart.js — 纯 canvas 的 K 线图（零依赖）
 * 不引 lightweight-charts 的原因：CDN 在国内不稳，且离线/PWA 要能跑。
 * 功能：蜡烛图 + MA5/20/60 + 成交量 + 拖拽平移 + 触摸十字光标 + 档位切换
 */
(function (global) {
  'use strict';

  const COL = {
    up: '#f5455c', down: '#3ecf8e', flat: '#8b95a5',
    grid: '#1b2029', axis: '#6b7484', text: '#8b95a5',
    ma5: '#f0a33c', ma20: '#4c8dff', ma60: '#a878ff',
    cross: '#5c6572', bg: '#171b22',
  };

  const PRESETS = [60, 120, 250, 500];

  function fit(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(rect.width, 1), h = Math.max(rect.height, 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function mount(canvas, k, ind) {
    const st = {
      k, ind,
      n: k.close.length,
      bars: 120,          // 可见根数
      offset: 0,          // 从右往左偏移多少根
      cross: null,        // 光标索引
      dragging: false,
      dragX: 0, dragOff: 0,
    };
    canvas.__t2 = st;

    const draw = () => drawImpl(canvas, st);
    st.draw = draw;

    // ---- 触摸/鼠标 ----
    const px = e => (e.touches ? e.touches[0].clientX : e.clientX);
    const localX = e => {
      const r = canvas.getBoundingClientRect();
      return px(e) - r.left;
    };

    canvas.addEventListener('touchstart', e => {
      if (e.touches.length > 1) return;
      st.dragging = true; st.dragX = localX(e); st.dragOff = st.offset;
      st.cross = null;
    }, { passive: true });

    canvas.addEventListener('touchmove', e => {
      if (e.touches.length > 1) { st.dragging = false; return; }
      const x = localX(e);
      if (st.dragging) {
        const r = canvas.getBoundingClientRect();
        const per = (r.width - 52) / st.bars;
        const shift = Math.round((x - st.dragX) / per);
        st.offset = clampOff(st.dragOff + shift, st);
        st.cross = null;
      }
      st.draw();
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchend', () => { st.dragging = false; }, { passive: true });

    // 桌面：mousemove 显示十字
    canvas.addEventListener('mousemove', e => {
      if (st.dragging) return;
      const r = canvas.getBoundingClientRect();
      st.cross = idxAt(localX(e), r.width, st);
      st.draw();
    });
    canvas.addEventListener('mouseleave', () => { st.cross = null; st.draw(); });
    canvas.addEventListener('mousedown', e => { st.dragging = true; st.dragX = localX(e); st.dragOff = st.offset; });
    canvas.addEventListener('mouseup', () => { st.dragging = false; });

    // ---- 尺寸变化 ----
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => st.draw());
      ro.observe(canvas);
    } else {
      window.addEventListener('resize', () => st.draw());
    }

    draw();
    return st;
  }

  function clampOff(off, st) {
    const maxOff = Math.max(0, st.n - 10);
    return Math.max(0, Math.min(maxOff, off));
  }

  function idxAt(x, w, st) {
    const left = 0, right = w - 52;
    if (x < left || x > right) return null;
    const { start, count } = window_(st);
    const per = (right - left) / count;
    const i = start + Math.floor(x / per);
    return i >= 0 && i < st.n ? i : null;
  }

  function window_(st) {
    const end = st.n - st.offset;
    const count = Math.min(st.bars, end);
    const start = end - count;
    return { start, count };
  }

  function drawImpl(canvas, st) {
    const { ctx, w, h } = fit(canvas);
    const { k, ind } = st;
    const { start, count } = window_(st);
    if (count <= 0) return;

    const AXIS_W = 52;           // 右侧价格轴
    const plotW = w - AXIS_W;
    const volH = Math.round(h * 0.26);
    const priceH = h - volH - 18;  // 底部留日期条

    // ---------- 取值范围 ----------
    let pMin = Infinity, pMax = -Infinity, vMax = 0;
    for (let i = start; i < start + count; i++) {
      if (k.low[i] < pMin) pMin = k.low[i];
      if (k.high[i] > pMax) pMax = k.high[i];
      if (k.amount[i] > vMax) vMax = k.amount[i];
      for (const arr of [ind.ma5, ind.ma20, ind.ma60]) {
        const v = arr[i];
        if (Number.isFinite(v)) { if (v < pMin) pMin = v; if (v > pMax) pMax = v; }
      }
    }
    const pad = (pMax - pMin) * 0.06 || 1;
    pMin -= pad; pMax += pad;
    const pRange = pMax - pMin || 1;

    const xOf = i => ((i - start) + 0.5) * (plotW / count);
    const yOf = p => priceH - ((p - pMin) / pRange) * (priceH - 8) - 4;
    const vOf = a => h - 18 - (a / (vMax || 1)) * (volH - 6);

    // ---------- 网格 + 价格轴 ----------
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    ctx.font = '10px -apple-system,sans-serif'; ctx.fillStyle = COL.text;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const gridN = 4;
    for (let g = 0; g <= gridN; g++) {
      const p = pMin + (pRange * g) / gridN;
      const y = Math.round(yOf(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
      ctx.fillText(fmtP(p), plotW + 5, y);
    }

    // ---------- 蜡烛 ----------
    const per = plotW / count;
    const cw = Math.max(1, Math.min(9, per * 0.68));
    for (let i = start; i < start + count; i++) {
      const o = k.open[i], c = k.close[i], hi = k.high[i], lo = k.low[i];
      const up = c >= o;
      const col = up ? COL.up : COL.down;
      const x = xOf(i);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      // 影线
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, yOf(hi)); ctx.lineTo(Math.round(x) + 0.5, yOf(lo)); ctx.stroke();
      // 实体
      const y1 = yOf(Math.max(o, c)), y2 = yOf(Math.min(o, c));
      const bodyH = Math.max(1, y2 - y1);
      ctx.fillRect(x - cw / 2, y1, cw, bodyH);
    }

    // ---------- 均线 ----------
    const lines = [[ind.ma5, COL.ma5], [ind.ma20, COL.ma20], [ind.ma60, COL.ma60]];
    ctx.lineWidth = 1.2;
    for (const [arr, col] of lines) {
      ctx.strokeStyle = col; ctx.beginPath();
      let started = false;
      for (let i = start; i < start + count; i++) {
        const v = arr[i];
        if (!Number.isFinite(v)) { started = false; continue; }
        const x = xOf(i), y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // ---------- 成交量 ----------
    ctx.fillStyle = COL.grid;
    ctx.fillRect(0, h - 18 - volH, plotW, 1);
    for (let i = start; i < start + count; i++) {
      const up = k.close[i] >= k.open[i];
      ctx.fillStyle = up ? 'rgba(245,69,92,.5)' : 'rgba(62,207,142,.5)';
      const y = vOf(k.amount[i]);
      ctx.fillRect(xOf(i) - cw / 2, y, cw, Math.max(1, h - 18 - y));
    }

    // ---------- 日期轴 ----------
    ctx.fillStyle = COL.text; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const step = Math.max(1, Math.floor(count / 4));
    for (let i = start + step - 1; i < start + count; i += step) {
      ctx.fillText(k.date[i].slice(2, 10), xOf(i), h - 14);
    }

    // ---------- 十字光标 ----------
    if (st.cross != null && st.cross >= start && st.cross < start + count) {
      const i = st.cross, x = xOf(i);
      ctx.strokeStyle = COL.cross; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 18); ctx.stroke();
      ctx.setLineDash([]);

      // 信息条
      const p = k.close[i], o = k.open[i], hi = k.high[i], lo = k.low[i];
      const chg = i > 0 ? p / k.close[i - 1] - 1 : 0;
      const txt = `${k.date[i]}  开${f(o)} 高${f(hi)} 低${f(lo)} 收${f(p)}  ${(chg * 100).toFixed(2)}%`;
      ctx.font = '10px -apple-system,sans-serif';
      const tw = ctx.measureText(txt).width + 12;
      ctx.fillStyle = 'rgba(14,17,22,.92)';
      ctx.fillRect(4, 4, Math.min(tw, plotW - 8), 18);
      ctx.fillStyle = chg >= 0 ? COL.up : COL.down;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, 10, 13);
    }
  }

  const f = v => (v >= 1000 ? v.toFixed(1) : v.toFixed(2));
  const fmtP = v => (v >= 1000 ? Math.round(v).toString() : v.toFixed(2));

  /* ---------------- 对外 ---------------- */

  function render(container, k, ind) {
    container.innerHTML = `
      <div class="chart-hd">
        <div class="chart-legend">
          <span style="color:${COL.ma5}">MA5</span>
          <span style="color:${COL.ma20}">MA20</span>
          <span style="color:${COL.ma60}">MA60</span>
        </div>
        <div class="chart-presets">
          ${PRESETS.map(n => `<button data-bars="${n}"${n === 120 ? ' class="on"' : ''}>${n}</button>`).join('')}
        </div>
      </div>
      <canvas class="kchart"></canvas>`;
    const canvas = container.querySelector('canvas');
    const st = mount(canvas, k, ind);
    container.querySelectorAll('[data-bars]').forEach(btn => {
      btn.onclick = () => {
        container.querySelectorAll('[data-bars]').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        st.bars = +btn.dataset.bars;
        st.offset = 0;
        st.draw();
      };
    });
    return st;
  }

  global.T2Chart = { render, COL };
})(window);
