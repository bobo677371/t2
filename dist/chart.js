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

  /* 记住用户选的档位和位置：静默刷新会重建图表，不记住就会跳回默认的 120 */
  const lastView = { bars: 120, offset: 0 };

  function render(container, k, ind) {
    const active = lastView.bars;
    container.innerHTML = `
      <div class="chart-hd">
        <div class="chart-legend">
          <span style="color:${COL.ma5}">MA5</span>
          <span style="color:${COL.ma20}">MA20</span>
          <span style="color:${COL.ma60}">MA60</span>
        </div>
        <div class="chart-presets">
          ${PRESETS.map(n => `<button data-bars="${n}"${n === active ? ' class="on"' : ''}>${n}</button>`).join('')}
        </div>
      </div>
      <canvas class="kchart"></canvas>`;
    const canvas = container.querySelector('canvas');
    const st = mount(canvas, k, ind);
    st.bars = active;
    st.offset = Math.min(lastView.offset, Math.max(0, st.n - 10));
    st.draw();

    container.querySelectorAll('[data-bars]').forEach(btn => {
      btn.onclick = () => {
        container.querySelectorAll('[data-bars]').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        st.bars = +btn.dataset.bars;
        st.offset = 0;
        lastView.bars = st.bars;
        lastView.offset = 0;
        st.draw();
      };
    });
    // 拖动后同步记住位置
    const sync = () => { lastView.offset = st.offset; };
    canvas.addEventListener('touchend', sync, { passive: true });
    canvas.addEventListener('mouseup', sync);
    return st;
  }

  global.T2Chart = { render, COL };

  /* ---------------------------------------------------------------- 分时图 */

  /** 画分时：价格线 + 均价线 + 昨收基准 + 成交量
   *  data = { preClose, points:[{t,c,v,avg}] }
   */
  function mountTrend(container, data) {
    if (!container || !data || !data.points || !data.points.length) return null;
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block';
    container.appendChild(canvas);
    const pts = data.points;
    const n = pts.length;
    let minY = Infinity, maxY = -Infinity, maxV = 0;
    for (const p of pts) {
      if (p.c < minY) minY = p.c;
      if (p.c > maxY) maxY = p.c;
      if (Number.isFinite(p.avg)) { if (p.avg < minY) minY = p.avg; if (p.avg > maxY) maxY = p.avg; }
      if (p.v > maxV) maxV = p.v;
    }
    const pc = data.preClose;
    if (Number.isFinite(pc)) { minY = Math.min(minY, pc); maxY = Math.max(maxY, pc); }
    if (!(maxY > minY)) { maxY = minY + 1; }
    const padY = (maxY - minY) * 0.08;
    minY -= padY; maxY += padY;

    const last = pts[n - 1].c;
    const isUp = !Number.isFinite(pc) || last >= pc;
    const lineCol = isUp ? COL.up : COL.down;

    const PAD_L = 8, PAD_R = 52, PAD_T = 10, VOL_H = 42, PAD_B = 18;

    function draw() {
      const { ctx, w, h } = fit(canvas);
      const plotW = w - PAD_L - PAD_R;
      const plotH = h - PAD_T - VOL_H - PAD_B;
      if (plotW <= 10 || plotH <= 10) return;

      const X = i => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
      const Y = v => PAD_T + (1 - (v - minY) / (maxY - minY)) * plotH;

      // 网格 + 右侧价格刻度
      ctx.font = '10px -apple-system,system-ui,sans-serif';
      ctx.textBaseline = 'middle';
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const v = maxY - (i / ticks) * (maxY - minY);
        const y = Y(v);
        ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD_L, y + 0.5); ctx.lineTo(PAD_L + plotW, y + 0.5); ctx.stroke();
        const pct = Number.isFinite(pc) && pc ? (v / pc - 1) * 100 : NaN;
        ctx.fillStyle = Number.isFinite(pct) ? (pct >= 0 ? COL.up : COL.down) : COL.axis;
        ctx.textAlign = 'left';
        ctx.fillText(v.toFixed(v > 1000 ? 2 : 3), PAD_L + plotW + 5, y);
      }

      // 昨收基准线
      if (Number.isFinite(pc)) {
        const y = Y(pc);
        ctx.strokeStyle = COL.cross; ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(PAD_L, y + 0.5); ctx.lineTo(PAD_L + plotW, y + 0.5); ctx.stroke();
        ctx.setLineDash([]);
      }

      // 成交量柱
      const volTop = PAD_T + plotH + 8;
      const bw = Math.max(1, plotW / n - 0.6);
      for (let i = 0; i < n; i++) {
        const vh = maxV ? (pts[i].v / maxV) * (VOL_H - 6) : 0;
        const prevC = i > 0 ? pts[i - 1].c : (Number.isFinite(pc) ? pc : pts[i].c);
        ctx.fillStyle = pts[i].c >= prevC ? COL.up : COL.down;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(X(i) - bw / 2, volTop + (VOL_H - 6) - vh, bw, vh);
        ctx.globalAlpha = 1;
      }

      // 均价线
      let anyAvg = false;
      ctx.strokeStyle = COL.ma5; ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = pts[i].avg;
        if (!Number.isFinite(a)) continue;
        const x = X(i), y = Y(a);
        if (!anyAvg) { ctx.moveTo(x, y); anyAvg = true; } else ctx.lineTo(x, y);
      }
      if (anyAvg) ctx.stroke();

      // 价格线 + 下方渐变填充
      ctx.beginPath();
      for (let i = 0; i < n; i++) { const x = X(i), y = Y(pts[i].c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.strokeStyle = lineCol; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.lineTo(X(n - 1), PAD_T + plotH);
      ctx.lineTo(X(0), PAD_T + plotH);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + plotH);
      g.addColorStop(0, isUp ? 'rgba(245,69,92,.22)' : 'rgba(62,207,142,.22)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fill();

      // 时间刻度
      ctx.fillStyle = COL.axis; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const marks = n > 200 ? [0, 60, 120, 180, n - 1] : [0, Math.floor(n / 2), n - 1];
      for (const i of marks) {
        if (i < 0 || i >= n) continue;
        const t = String(pts[i].t || '');
        const hhmm = t.length >= 16 ? t.slice(11, 16) : t;
        ctx.fillText(hhmm, Math.min(Math.max(X(i), 18), PAD_L + plotW - 18), PAD_T + plotH + 4);
      }

      // 最后一笔价格标签
      const yl = Y(last);
      ctx.fillStyle = lineCol;
      ctx.fillRect(PAD_L + plotW + 2, yl - 8, PAD_R - 3, 16);
      ctx.fillStyle = '#0e1116'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(last.toFixed(last > 1000 ? 2 : 3), PAD_L + plotW + 5, yl);
    }

    draw();
    let raf = 0;
    const onResize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(onResize);
      ro.observe(canvas);
    } else {
      window.addEventListener('resize', onResize);
    }
    return { draw };
  }

  global.T2Chart = global.T2Chart || {};
  global.T2Chart.mountTrend = mountTrend;
})(window);


