// ============================================================
// PORTFOLIO VALUE HISTORY PAGE
// ============================================================
let _historyPeriod = 'monthly';

function renderPortfolioHistory() {
  const history = state.portfolioHistory;
  const now = totalNetWorth();
  const pv  = portfolioValue();

  // Compute period-bucketed data
  function getFilteredData(period) {
    if (!history.length) return [];
    const today = new Date();
    let cutoff;
    if (period === 'daily')   { cutoff = new Date(today); cutoff.setDate(today.getDate() - 30); }
    if (period === 'weekly')  { cutoff = new Date(today); cutoff.setDate(today.getDate() - 90); }
    if (period === 'monthly') { cutoff = new Date(today); cutoff.setFullYear(today.getFullYear() - 2); }
    if (period === 'yearly')  { cutoff = new Date(today); cutoff.setFullYear(today.getFullYear() - 10); }
    if (!cutoff) { cutoff = new Date(today); cutoff.setFullYear(today.getFullYear() - 10); }

    const filtered = history.filter(s => parseDate(s.date) >= cutoff);

    if (period === 'daily') return filtered;

    // Group
    const grouped = {};
    filtered.forEach(s => {
      let key;
      const d = parseDate(s.date);
      if (period === 'weekly') {
        const startOfWeek = new Date(d); startOfWeek.setDate(d.getDate() - d.getDay());
        key = startOfWeek.toISOString().slice(0,10);
      } else if (period === 'monthly') {
        key = `${s.date.slice(6,10)}-${s.date.slice(3,5)}-01`;
      } else { // yearly
        key = `${s.date.slice(6,10)}-01-01`;
      }
      grouped[key] = s; // last entry in period wins
    });
    return Object.keys(grouped).sort().map(k => grouped[k]);
  }

  const data = getFilteredData(_historyPeriod);

  // Stats
  const first = data[0];
  const change = first ? now - first.netWorth : 0;
  const changePct = first && first.netWorth ? (change / first.netWorth) * 100 : 0;
  const maxNW = data.length ? Math.max(...data.map(d=>d.netWorth)) : now;
  const minNW = data.length ? Math.min(...data.map(d=>d.netWorth)) : now;

  const periodLabels = {daily:'Last 30 days',weekly:'Last 90 days',monthly:'Last 2 years',yearly:'All time'};

  // Summary row for individual holdings
  const holdingRows = state.portfolio.map(h => {
    const val = h.shares * h.currentPrice;
    const cost = h.shares * h.avgPrice;
    const pl = val - cost;
    const plp = cost ? (pl/cost)*100 : 0;
    return { ticker: h.ticker, sector: h.sector, val, pl, plp };
  }).sort((a,b) => b.val - a.val);

  return `
    <div class="metrics-grid" style="margin-bottom:1.25rem">
      <div class="metric-card">
        <div class="metric-label">Net Worth (now)</div>
        <div class="metric-value">$${fmt(now)}</div>
        <div class="metric-sub">Stocks + Cash</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Portfolio Value</div>
        <div class="metric-value">$${fmt(pv)}</div>
        <div class="metric-sub">Equities only</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Cash</div>
        <div class="metric-value">$${fmt(state.cash)}</div>
        <div class="metric-sub">${fmt(state.cash/now*100)}% of net worth</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Period Change</div>
        <div class="metric-value ${change>=0?'up':'down'}">${change>=0?'+':''}$${fmt(Math.abs(change))}</div>
        <div class="metric-sub ${change>=0?'up':'down'}">${change>=0?'+':''}${fmt(Math.abs(changePct))}% · ${periodLabels[_historyPeriod]}</div>
      </div>
    </div>

    <div class="card section-gap">
      <div class="flex-between" style="margin-bottom:1rem">
        <div class="card-title" style="margin:0">Portfolio Value Over Time</div>
        <div class="flex-row" style="gap:6px">
          ${['daily','weekly','monthly','yearly'].map(p=>`
            <button class="btn btn-sm ${_historyPeriod===p?'btn-primary':''}" onclick="_historyPeriod='${p}';document.getElementById('main-content').innerHTML=renderPortfolioHistory();setTimeout(drawHistoryChart,80)">${p.charAt(0).toUpperCase()+p.slice(1)}</button>
          `).join('')}
          <button class="btn btn-sm" onclick="recordPortfolioSnapshot();scheduleSave();document.getElementById('main-content').innerHTML=renderPortfolioHistory();setTimeout(drawHistoryChart,80)" title="Record today's snapshot now">⊕ Snapshot</button>
        </div>
      </div>

      ${data.length < 2 ? `
        <div class="empty-state" style="padding:2rem">
          <div class="empty-icon">▥</div>
          <p>Not enough data yet for this period.</p>
          <p class="sub">Snapshots are auto-recorded when you refresh prices. Click <strong>⊕ Snapshot</strong> above to record today's value now.</p>
        </div>
      ` : `
        <div style="position:relative;width:100%;height:240px;margin-bottom:8px">
          <canvas id="history-chart" style="width:100%;height:240px"></canvas>
        </div>
        <div class="flex-row" style="gap:16px;font-size:11px;color:var(--text-secondary);margin-top:4px">
          <span>─ <span style="color:#3b82f6">Net Worth</span></span>
          <span>─ <span style="color:#22c55e">Portfolio</span></span>
          <span>── <span style="color:#f59e0b">Cash</span></span>
          <span style="margin-left:auto">Peak: $${fmt(maxNW)} · Trough: $${fmt(minNW)}</span>
        </div>
        <div style="margin-top:12px">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr>
              <th style="text-align:left;padding:5px 8px;color:var(--text-secondary);font-weight:600;border-bottom:0.5px solid var(--border-light)">Date</th>
              <th style="text-align:right;padding:5px 8px;color:var(--text-secondary);font-weight:600;border-bottom:0.5px solid var(--border-light)">Net Worth</th>
              <th style="text-align:right;padding:5px 8px;color:var(--text-secondary);font-weight:600;border-bottom:0.5px solid var(--border-light)">Portfolio</th>
              <th style="text-align:right;padding:5px 8px;color:var(--text-secondary);font-weight:600;border-bottom:0.5px solid var(--border-light)">Cash</th>
              <th style="text-align:right;padding:5px 8px;color:var(--text-secondary);font-weight:600;border-bottom:0.5px solid var(--border-light)">Δ Net Worth</th>
            </tr></thead>
            <tbody>
              ${data.slice().reverse().slice(0,20).map((s,i,arr)=>{
                const prev = arr[i+1];
                const delta = prev ? s.netWorth - prev.netWorth : null;
                return `<tr>
                  <td style="padding:5px 8px">${s.date}</td>
                  <td style="padding:5px 8px;text-align:right;font-weight:600">$${fmt(s.netWorth)}</td>
                  <td style="padding:5px 8px;text-align:right">$${fmt(s.portfolioValue)}</td>
                  <td style="padding:5px 8px;text-align:right">$${fmt(s.cash)}</td>
                  <td style="padding:5px 8px;text-align:right;color:${delta==null?'var(--text-muted)':delta>=0?'#16a34a':'#dc2626'}">${delta==null?'—':(delta>=0?'+':'')+' $'+fmt(Math.abs(delta))}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
          ${data.length > 20 ? `<p class="text-xs text-muted mt-1">Showing 20 most recent entries of ${data.length} total.</p>` : ''}
        </div>
      `}
    </div>

    <div class="card">
      <div class="card-title">Current Holdings Breakdown</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Ticker</th><th>Sector</th><th>Value</th><th>Unrealised P&L</th><th>Return</th><th>Weight</th></tr></thead>
          <tbody>
            ${holdingRows.map(h=>`<tr>
              <td><strong>${h.ticker}</strong></td>
              <td><span class="text-xs">${h.sector}</span></td>
              <td>$${fmt(h.val)}</td>
              <td class="${h.pl>=0?'text-success':'text-danger'}">${h.pl>=0?'+':''}$${fmt(Math.abs(h.pl))}</td>
              <td class="${h.plp>=0?'text-success':'text-danger'}">${h.plp>=0?'+':''}${fmt(Math.abs(h.plp))}%</td>
              <td>
                <div class="flex-row" style="gap:6px">
                  <div class="conf-bar" style="width:60px"><div class="conf-fill" style="width:${fmt(h.val/pv*100,0)}%;background:#3b82f6"></div></div>
                  <span class="text-xs">${fmt(h.val/pv*100)}%</span>
                </div>
              </td>
            </tr>`).join('')}
            <tr style="border-top:0.5px solid var(--border-medium)">
              <td colspan="2"><strong>Cash</strong></td>
              <td>$${fmt(state.cash)}</td>
              <td colspan="2" class="text-muted">—</td>
              <td class="text-xs">${fmt(state.cash/now*100)}% of total</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function drawHistoryChart() {
  const canvas = document.getElementById('history-chart');
  if (!canvas) return;

  function getFilteredData(period) {
    const history = state.portfolioHistory;
    if (!history.length) return [];
    const today = new Date();
    let cutoff = new Date(today);
    if (period === 'daily')   cutoff.setDate(today.getDate() - 30);
    if (period === 'weekly')  cutoff.setDate(today.getDate() - 90);
    if (period === 'monthly') cutoff.setFullYear(today.getFullYear() - 2);
    if (period === 'yearly')  cutoff.setFullYear(today.getFullYear() - 10);
    const filtered = history.filter(s => parseDate(s.date) >= cutoff);
    if (period === 'daily') return filtered;
    const grouped = {};
    filtered.forEach(s => {
      let key;
      const d = parseDate(s.date);
      if (period === 'weekly') {
        const sow = new Date(d); sow.setDate(d.getDate() - d.getDay());
        key = sow.toISOString().slice(0,10);
      } else if (period === 'monthly') {
        key = `${s.date.slice(6,10)}-${s.date.slice(3,5)}-01`;
      } else {
        key = `${s.date.slice(6,10)}-01-01`;

      }
      grouped[key] = s;
    });
    return Object.keys(grouped).sort().map(k => grouped[k]);
  }

  const data = getFilteredData(_historyPeriod);
  if (data.length < 2) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.offsetWidth || 600;
  const h = 240;
  canvas.width = w; canvas.height = h;

  const nwArr = data.map(d => d.netWorth);
  const pvArr = data.map(d => d.portfolioValue);
  const cashArr = data.map(d => d.cash);
  const allVals = [...nwArr, ...pvArr, ...cashArr];
  const minV = Math.min(...allVals) * 0.98;
  const maxV = Math.max(...allVals) * 1.02;
  const range = maxV - minV || 1;

  const pad = { t: 16, r: 16, b: 40, l: 72 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;

  const px = v => pad.t + ch - ((v - minV) / range) * ch;
  const py = i => pad.l + (i / (data.length - 1)) * cw;

  // Dark mode detection
  const isDark = window.matchMedia('(prefers-color-scheme:dark)').matches;
  const gridCol = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
  const textCol = isDark ? '#888' : '#999';

  ctx.clearRect(0, 0, w, h);

  // Grid lines + y-axis labels
  ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  [0, 0.25, 0.5, 0.75, 1].forEach(f => {
    const yv = minV + range * (1 - f);
    const y = px(yv);
    ctx.strokeStyle = gridCol; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = textCol;
    ctx.fillText('$' + (yv >= 1000 ? (yv/1000).toFixed(0)+'k' : yv.toFixed(0)), pad.l - 6, y + 3);
  });

  // X-axis labels
  ctx.textAlign = 'center'; ctx.fillStyle = textCol;
  const step = Math.max(1, Math.floor(data.length / 6));
  data.forEach((d, i) => {
    if (i % step !== 0 && i !== data.length - 1) return;
    const lbl = _historyPeriod === 'yearly' ? d.date.slice(6,10) :
                _historyPeriod === 'monthly' ? d.date.slice(3,10) :
                d.date.slice(0,5);
    ctx.fillText(lbl, py(i), h - pad.b + 14);
  });

  // Draw a line series
  function drawLine(arr, color, dashed) {
    ctx.beginPath();
    arr.forEach((v, i) => i === 0 ? ctx.moveTo(py(i), px(v)) : ctx.lineTo(py(i), px(v)));
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    if (dashed) ctx.setLineDash([4, 3]); else ctx.setLineDash([]);
    ctx.stroke(); ctx.setLineDash([]);
  }

  // Gradient fill under net worth
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
  grad.addColorStop(0, 'rgba(59,130,246,0.18)');
  grad.addColorStop(1, 'rgba(59,130,246,0)');
  ctx.beginPath();
  nwArr.forEach((v, i) => i === 0 ? ctx.moveTo(py(i), px(v)) : ctx.lineTo(py(i), px(v)));
  ctx.lineTo(py(data.length - 1), pad.t + ch);
  ctx.lineTo(py(0), pad.t + ch);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

  drawLine(nwArr, '#3b82f6', false);
  drawLine(pvArr, '#22c55e', false);
  drawLine(cashArr, '#f59e0b', true);

  // Dots at last point
  [['#3b82f6', nwArr], ['#22c55e', pvArr], ['#f59e0b', cashArr]].forEach(([col, arr]) => {
    const lastX = py(arr.length - 1), lastY = px(arr[arr.length - 1]);
    ctx.beginPath(); ctx.arc(lastX, lastY, 4, 0, Math.PI*2);
    ctx.fillStyle = col; ctx.fill();
  });
}


async function fetchSignals(tickers, forceRefresh=false) {
  if(!state.serverOk) return {};
  const now = Date.now();
  const stale = tickers.filter(t => forceRefresh || !state.lastSignalFetch[t] || (now - state.lastSignalFetch[t]) > 15*60*1000);
  if(!stale.length) return state.liveSignals;

  try {
    const r = await fetch(`${API}/api/analyse/batch`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({tickers: stale, period:'6mo'})
    });
    if(!r.ok) return state.liveSignals;
    const data = await r.json();
    stale.forEach(t => {
      state.liveSignals[t] = data[t];
      state.lastSignalFetch[t] = now;
    });
  } catch {}
  // Recompute critical alerts whenever fresh signal data arrives
  computeCriticalAlerts();
  return state.liveSignals;
}

// ============================================================
// MINI SPARKLINE CANVAS
// ============================================================
function drawSparkline(canvasId, data, color='#3b82f6') {
  const canvas = document.getElementById(canvasId);
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.offsetWidth || canvas.width;
  const h = canvas.offsetHeight || canvas.height;
  canvas.width = w; canvas.height = h;
  if(!data || data.length<2) return;
  const prices = data.map(d=>d.close);
  const min=Math.min(...prices), max=Math.max(...prices), range=max-min||1;
  ctx.clearRect(0,0,w,h);
  const grad=ctx.createLinearGradient(0,0,0,h);
  grad.addColorStop(0, color+'44');
  grad.addColorStop(1, color+'00');
  ctx.beginPath();
  prices.forEach((p,i)=>{
    const x=(i/(prices.length-1))*w, y=h-((p-min)/range)*(h-8)-4;
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  });
  ctx.strokeStyle=color;
  ctx.lineWidth=1.5;
  ctx.stroke();
  ctx.lineTo(w,h); ctx.lineTo(0,h); ctx.closePath();
  ctx.fillStyle=grad;
  ctx.fill();
}

// ============================================================
// CANDLESTICK / OHLCV CHART  (Technical Screener Sandbox)
// ============================================================

// _sma(arr, n) — simple moving average series, result[i] = null for i < n-1
function _sma(arr, n) {
  return arr.map((_, i) => {
    if (i < n - 1) return null;
    let s = 0; for (let j = i - n + 1; j <= i; j++) s += arr[j];
    return s / n;
  });
}

// _bbands(closes, n, mult) — {upper[], mid[], lower[]}
function _bbands(closes, n = 20, mult = 2) {
  const mid = _sma(closes, n);
  const upper = [], lower = [];
  closes.forEach((_, i) => {
    if (i < n - 1) { upper.push(null); lower.push(null); return; }
    const slice = closes.slice(i - n + 1, i + 1);
    const mean = mid[i];
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    upper.push(mean + mult * std);
    lower.push(mean - mult * std);
  });
  return { upper, mid, lower };
}

/**
 * drawCandleChart(canvasId, chartData, options)
 *
 * chartData: [{date, open, high, low, close, volume}, ...]
 * options: {
 *   mode: 'candle' | 'line',
 *   showBB: bool,  showSMA50: bool,  showPivots: bool,
 *   pivots: {r2, r1, pivot, s1, s2},
 *   height: number (default 320),
 * }
 *
 * Layout:
 *   LEFT  (PAD_L = 62) — Y-axis price labels, right-aligned
 *   RIGHT (PAD_R = 8 | 80) — pivot labels when showPivots, else narrow margin
 *   TOP   (PAD_T = 12)
 *   BOTTOM (PAD_B = 24) — X-axis date labels
 *   Bottom 18 % of height — volume histogram strip
 */
function drawCandleChart(canvasId, chartData, options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !chartData || chartData.length < 2) return;

  const {
    mode       = 'candle',
    showBB     = true,
    showSMA50  = true,
    showPivots = false,
    pivots     = null,
    height     = 320,
  } = options;

  const dpr = window.devicePixelRatio || 1;
  const W   = Math.max(canvas.offsetWidth || 700, 300);
  const H   = height;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Y-axis labels on LEFT, pivot labels on RIGHT (own zone)
  const PAD_L   = 62;
  const PAD_R   = showPivots ? 80 : 8;
  const PAD_T   = 12;
  const PAD_B   = 24;
  const VOL_H   = Math.round(H * 0.18);
  const PRICE_H = H - PAD_T - VOL_H - PAD_B - 6;

  ctx.clearRect(0, 0, W, H);

  const n      = chartData.length;
  const closes = chartData.map(d => d.close);
  const highs  = chartData.map(d => d.high);
  const lows   = chartData.map(d => d.low);
  const vols   = chartData.map(d => d.volume);

  // Overlays
  const sma20Series = _sma(closes, 20);
  const sma50Series = showSMA50 ? _sma(closes, 50) : null;
  const bb          = showBB    ? _bbands(closes, 20, 2) : null;

  // Price range (include overlays and in-view pivots)
  const allPriceVals = [...highs, ...lows];
  if (bb) {
    bb.upper.filter(Boolean).forEach(v => allPriceVals.push(v));
    bb.lower.filter(Boolean).forEach(v => allPriceVals.push(v));
  }
  if (pivots && showPivots) {
    [pivots.r2, pivots.r1, pivots.pivot, pivots.s1, pivots.s2]
      .filter(Boolean).forEach(v => allPriceVals.push(v));
  }
  const priceMin   = Math.min(...allPriceVals);
  const priceMax   = Math.max(...allPriceVals);
  const priceRange = priceMax - priceMin || 1;
  const volMax     = Math.max(...vols) || 1;

  // Chart area bounds
  const chartX0 = PAD_L;
  const chartX1 = W - PAD_R;
  const chartW  = chartX1 - chartX0;
  const priceY0 = PAD_T;
  const priceY1 = PAD_T + PRICE_H;
  const volY0   = priceY1 + 6;
  const volY1   = volY0 + VOL_H;

  const xAt  = i => chartX0 + (i + 0.5) / n * chartW;
  const pyAt = v => priceY0 + (1 - (v - priceMin) / priceRange) * PRICE_H;
  const vyAt = v => volY1 - (v / volMax) * VOL_H;

  const slotW   = chartW / n;
  const candleW = Math.max(1, Math.min(slotW * 0.7, 10));

  // Helper: draw a series line
  const drawLine = (series, color, width, dash = []) => {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.setLineDash(dash);
    let started = false;
    series.forEach((v, i) => {
      if (v == null) return;
      const x = xAt(i), y = pyAt(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke(); ctx.setLineDash([]);
  };

  // ── Grid lines ──────────────────────────────────────────────────────────
  const gridSteps = 5;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth   = 0.5;
  for (let g = 0; g <= gridSteps; g++) {
    const y = priceY0 + (g / gridSteps) * PRICE_H;
    ctx.beginPath(); ctx.moveTo(chartX0, y); ctx.lineTo(chartX1, y); ctx.stroke();
  }

  // ── Volume bars ──────────────────────────────────────────────────────────
  chartData.forEach((d, i) => {
    const up = d.close >= d.open;
    ctx.fillStyle = up ? 'rgba(22,163,74,0.35)' : 'rgba(220,38,38,0.35)';
    const x = xAt(i), top = vyAt(d.volume), barH = volY1 - top;
    ctx.fillRect(x - candleW / 2, top, candleW, barH);
  });

  // ── BB fill + lines ──────────────────────────────────────────────────────
  if (bb) {
    ctx.beginPath();
    let started = false;
    bb.upper.forEach((v, i) => {
      if (v == null) return;
      const x = xAt(i), y = pyAt(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    for (let i = n - 1; i >= 0; i--) {
      const v = bb.lower[i];
      if (v == null) continue;
      ctx.lineTo(xAt(i), pyAt(v));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(99,179,237,0.07)';
    ctx.fill();
    drawLine(bb.upper, 'rgba(99,179,237,0.55)', 1, [3, 3]);
    drawLine(bb.lower, 'rgba(99,179,237,0.55)', 1, [3, 3]);
  }

  // ── SMA20 (amber) ────────────────────────────────────────────────────────
  drawLine(sma20Series, '#f59e0b', 1.2);

  // ── SMA50 (purple) ───────────────────────────────────────────────────────
  if (sma50Series) drawLine(sma50Series, '#a78bfa', 1.2);

  // ── Pivot lines + RIGHT-SIDE labels (own zone, no collision) ─────────────
  if (pivots && showPivots) {
    const pvtDefs = [
      { v: pivots.r2,    color: '#f87171', label: 'R2' },
      { v: pivots.r1,    color: '#fca5a5', label: 'R1' },
      { v: pivots.pivot, color: '#94a3b8', label: 'P'  },
      { v: pivots.s1,    color: '#86efac', label: 'S1' },
      { v: pivots.s2,    color: '#4ade80', label: 'S2' },
    ];
    // Track placed label Y positions to avoid overlapping text
    const usedY = [];
    ctx.font = '9px sans-serif';
    pvtDefs.forEach(({ v, color, label }) => {
      if (!v) return;
      let y = pyAt(v);
      if (y < priceY0 - 4 || y > priceY1 + 4) return; // off-chart
      // Nudge label if too close to an already-placed label
      while (usedY.some(uy => Math.abs(uy - y) < 11)) y += 11;
      usedY.push(y);
      // Dashed line across chart area only
      ctx.beginPath(); ctx.strokeStyle = color + '88'; ctx.lineWidth = 0.8;
      ctx.setLineDash([4, 4]);
      ctx.moveTo(chartX0, pyAt(v)); ctx.lineTo(chartX1, pyAt(v));
      ctx.stroke(); ctx.setLineDash([]);
      // Label in right margin
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.fillText(`${label} $${v.toFixed(2)}`, chartX1 + 4, y + 3);
    });
    ctx.textAlign = 'left';
  }

  // ── Candles ──────────────────────────────────────────────────────────────
  if (mode !== 'line') {
    chartData.forEach((d, i) => {
      const x    = xAt(i);
      const up   = d.close >= d.open;
      const col  = up ? '#16a34a' : '#dc2626';
      const bodyTop    = pyAt(Math.max(d.open, d.close));
      const bodyBottom = pyAt(Math.min(d.open, d.close));
      const bodyH = Math.max(bodyBottom - bodyTop, 1);
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, pyAt(d.high)); ctx.lineTo(x, bodyTop);
      ctx.moveTo(x, bodyBottom);  ctx.lineTo(x, pyAt(d.low));
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
    });
  }

  // ── Line mode ─────────────────────────────────────────────────────────────
  if (mode === 'line') {
    drawLine(closes, '#3b82f6', 1.5);
  }

  // ── Y-axis price labels — LEFT side, right-aligned ──────────────────────
  ctx.fillStyle = 'rgba(148,163,184,0.85)';
  ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let g = 0; g <= gridSteps; g++) {
    const v = priceMax - (g / gridSteps) * priceRange;
    const y = priceY0 + (g / gridSteps) * PRICE_H;
    const label = v >= 100 ? '$' + v.toFixed(2) : '$' + v.toFixed(3);
    ctx.fillText(label, chartX0 - 4, y + 3);
  }

  // ── X-axis date labels ───────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(148,163,184,0.7)';
  ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
  const labelEvery = Math.max(1, Math.round(n / 6));
  chartData.forEach((d, i) => {
    if (i % labelEvery !== 0 && i !== n - 1) return;
    ctx.fillText(d.date ? d.date.slice(5) : '', xAt(i), H - PAD_B + 14);
  });
}

// ============================================================
// PRICE CHART
// ============================================================
function drawPriceChart(canvasId, chartData, sma20, sma50, bbUpper, bbLower) {
  const canvas = document.getElementById(canvasId);
  if(!canvas || !chartData?.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.offsetWidth; const h = canvas.height = 180;
  canvas.width = w;
  const prices = chartData.map(d=>d.close);
  const allVals = [...prices];
  if(sma20) allVals.push(sma20);
  if(bbUpper) allVals.push(bbUpper);
  if(bbLower) allVals.push(bbLower);
  const min=Math.min(...allVals)-Math.min(...allVals)*0.01, max=Math.max(...allVals)+Math.max(...allVals)*0.01;
  const range=max-min||1;
  const px=(v) => h-((v-min)/range)*h;
  const py=(i) => (i/(chartData.length-1))*(w-8)+4;

  ctx.clearRect(0,0,w,h);

  // BB fill
  if(bbUpper && bbLower) {
    ctx.beginPath();
    chartData.forEach((_,i)=>{ const x=py(i); i===0?ctx.moveTo(x,px(bbUpper)):ctx.lineTo(x,px(bbUpper)); });
    chartData.slice().reverse().forEach((_,i)=>{ const ii=chartData.length-1-i; ctx.lineTo(py(ii),px(bbLower)); });
    ctx.closePath();
    ctx.fillStyle='rgba(59,130,246,0.07)';
    ctx.fill();
  }

  // Price line
  ctx.beginPath();
  chartData.forEach((d,i)=>{ const x=py(i),y=px(d.close); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
  ctx.strokeStyle='#3b82f6'; ctx.lineWidth=1.5; ctx.stroke();

  // SMA20
  if(sma20) {
    ctx.beginPath(); ctx.moveTo(4,px(sma20));
    chartData.forEach((_,i)=>ctx.lineTo(py(i),px(sma20)));
    ctx.strokeStyle='#f59e0b'; ctx.lineWidth=1; ctx.setLineDash([3,3]); ctx.stroke(); ctx.setLineDash([]);
  }
}
