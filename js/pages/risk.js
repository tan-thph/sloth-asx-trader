// ============================================================
// PORTFOLIO RISK DASHBOARD
// ============================================================

let _riskPageScore = null; // set by buildRiskPage, read by renderRiskPage for gauge

async function renderRiskPage(gen) {
  const el = document.getElementById('main-content');
  const merged = mergedPortfolio();

  if (!merged.length) {
    el.innerHTML = `<div class="card"><div class="empty-state">
      <div class="empty-icon">◎</div>
      <p>No holdings in portfolio yet.</p>
    </div></div>`;
    return;
  }

  // Loading skeleton
  el.innerHTML = `
    <div class="card" style="text-align:center;padding:2rem">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <p class="text-xs text-muted" style="margin-top:10px">Fetching 90-day risk data from yfinance…</p>
    </div>`;

  const tickers = merged.map(h => h.ticker);
  let riskData = { metrics: {}, correlation: {} };

  if (state.serverOk) {
    try {
      const rf = state.rbaRate || 4.35;
      const resp = await fetch(`${API}/api/risk?tickers=${tickers.join(',')}&rf=${rf}`);
      if (resp.ok) riskData = await resp.json();
    } catch {}
  }

  if (state._renderGen !== gen) return; // navigated away mid-fetch
  el.innerHTML = buildRiskPage(merged, riskData);

  // Draw charts after DOM is ready
  setTimeout(() => {
    if (state._renderGen !== gen) return;
    drawRiskScoreGauge(_riskPageScore);
    drawSectorPie(merged);
    drawCorrelationHeatmap(merged, riskData.correlation || {});
  }, 60);
}

function buildRiskPage(merged, riskData) {
  const metrics     = riskData.metrics || {};
  const pv          = portfolioValue();
  const nw          = totalNetWorth();

  // ── Portfolio-level weighted metrics ──────────────────────────────────────
  let wBeta = 0, wVol = 0, wSharpe = 0, wVaR = 0, wMaxDD = 0, covered = 0;
  for (const h of merged) {
    const m = metrics[h.ticker];
    if (!m) continue;
    const w = pv > 0 ? (h.shares * h.currentPrice) / pv : 0;
    wBeta   += m.beta           * w;
    wVol    += m.volatility_ann * w;
    wSharpe += m.sharpe         * w;
    wVaR    += (m.var_95  ?? 0) * w;
    wMaxDD  += (m.max_drawdown ?? 0) * w;
    covered++;
  }
  const hasMeta = covered > 0;

  // ── Composite Risk Score (0–100) ──────────────────────────────────────────
  // 4 dimensions × 25 pts each: volatility, concentration, drawdown, beta
  const _clamp  = (v, lo, hi) => Math.max(0, Math.min(25, (v - lo) / (hi - lo) * 25));
  const sectorEntries0 = Object.entries((() => {
    const m = {};
    for (const h of merged) { const s = h.sector||'Other'; m[s]=(m[s]||0)+h.shares*h.currentPrice; }
    return m;
  })()).sort((a,b)=>b[1]-a[1]);
  const topConc = pv > 0 && sectorEntries0.length ? sectorEntries0[0][1]/pv*100 : 0;
  const compScore = hasMeta ? Math.round(
    _clamp(wVol,   10, 35) +   // 10–35% vol range
    _clamp(topConc,20, 60) +   // 20–60% concentration
    _clamp(wMaxDD,  5, 25) +   // 5–25% drawdown range
    _clamp(wBeta,  0.5,1.5)    // 0.5–1.5 beta range
  ) : null;
  _riskPageScore = compScore;
  const scoreColor = compScore == null ? 'var(--text-muted)'
    : compScore < 34 ? '#16a34a' : compScore < 67 ? '#d97706' : '#dc2626';
  const scoreLabel = compScore == null ? '—'
    : compScore < 34 ? 'Low Risk' : compScore < 67 ? 'Moderate' : 'High Risk';

  const betaColor  = wBeta < 0.8 ? '#16a34a' : wBeta < 1.2 ? '#d97706' : '#dc2626';
  const volColor   = wVol  < 15  ? '#16a34a' : wVol  < 25  ? '#d97706' : '#dc2626';
  const shColor    = wSharpe > 1  ? '#16a34a' : wSharpe > 0  ? '#d97706' : '#dc2626';
  const varColor   = wVaR > -2 ? '#16a34a' : wVaR > -3.5 ? '#d97706' : '#dc2626';
  const ddColor    = wMaxDD < 8  ? '#16a34a' : wMaxDD < 18  ? '#d97706' : '#dc2626';

  // ── Sector concentration (reuse sectorEntries0 computed above) ─────────────
  const sectorEntries = sectorEntries0;
  const topSector     = sectorEntries[0];
  const topSectorPct  = topConc;

  // Assign colors to sectors in sorted order (largest first) so top sectors get
  // the most distinct colors from our palette.
  const sectorColorMap = {};
  sectorEntries.forEach(([sec], i) => {
    sectorColorMap[sec] = sectorColor(sec, i);
  });

  // ── Per-holding metrics table ─────────────────────────────────────────────
  const holdingRows = merged.map(h => {
    const val = h.shares * h.currentPrice;
    const w   = pv > 0 ? val/pv*100 : 0;
    const m   = metrics[h.ticker];
    const ret30 = m?.return_30d;
    const ret30Color = ret30 == null ? '' : ret30 >= 0 ? '#16a34a' : '#dc2626';
    return `<tr>
      <td><strong>${h.ticker}</strong></td>
      <td><span class="text-xs">${h.sector||'—'}</span></td>
      <td>$${fmt(val)} <span class="text-xs text-muted">(${fmt(w,1)}%)</span></td>
      <td>${m ? fmt(m.volatility_ann,1)+'%' : '<span class="text-muted">—</span>'}</td>
      <td>${m ? (() => {
        const b = m.beta;
        const bc = b < 0.8 ? '#16a34a' : b < 1.2 ? '#d97706' : '#dc2626';
        return `<span style="color:${bc};font-weight:600">${fmt(b,2)}</span>`;
      })() : '<span class="text-muted">—</span>'}</td>
      <td>${m ? (() => {
        const s = m.sharpe; const sc = s > 1 ? '#16a34a' : s > 0 ? '#d97706' : '#dc2626';
        return `<span style="color:${sc}">${fmt(s,2)}</span>`;
      })() : '<span class="text-muted">—</span>'}</td>
      <td>${ret30 != null ? `<span style="color:${ret30Color};font-weight:600">${ret30>=0?'+':''}${fmt(ret30,1)}%</span>` : '<span class="text-muted">—</span>'}</td>
      <td>${m?.var_95 != null ? `<span style="color:${m.var_95>-2?'#16a34a':m.var_95>-3.5?'#d97706':'#dc2626'}">${fmt(m.var_95,2)}%</span>` : '<span class="text-muted">—</span>'}</td>
      <td>${m?.max_drawdown != null ? `<span style="color:${m.max_drawdown<8?'#16a34a':m.max_drawdown<18?'#d97706':'#dc2626'}">${fmt(m.max_drawdown,1)}%</span>` : '<span class="text-muted">—</span>'}</td>
    </tr>`;
  }).join('');

  const hasCorrData = Object.keys(riskData.correlation||{}).length >= 2;

  return `
  <!-- Composite Risk Score + summary tiles -->
  <div style="display:flex;gap:14px;align-items:stretch;flex-wrap:wrap;margin-bottom:14px">

    <!-- Score gauge -->
    <div class="metric-card" style="min-width:160px;flex:0 0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px">
      <div class="metric-label">Risk Score</div>
      <div style="position:relative;width:96px;height:96px">
        <canvas id="risk-score-gauge" width="96" height="96"></canvas>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
          <span style="font-size:26px;font-weight:700;color:${scoreColor}">${compScore ?? '—'}</span>
          <span style="font-size:10px;color:${scoreColor};font-weight:600">${scoreLabel}</span>
        </div>
      </div>
      <div class="text-xs text-muted" style="text-align:center">0 = safe · 100 = risky</div>
    </div>

    <!-- Metric tiles -->
    <div style="flex:1;display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px">
      <div class="metric-card">
        <div class="metric-label">Portfolio Beta (vs VAS)</div>
        <div class="metric-value" style="color:${betaColor}">${hasMeta ? fmt(wBeta,2) : '—'}</div>
        <div class="metric-sub">${wBeta<0.8?'Defensive':wBeta<1.2?'Neutral':'Aggressive'}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Weighted Volatility (ann.)</div>
        <div class="metric-value" style="color:${volColor}">${hasMeta ? fmt(wVol,1)+'%' : '—'}</div>
        <div class="metric-sub">${wVol<15?'Low':wVol<25?'Moderate':'High'}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Portfolio Sharpe</div>
        <div class="metric-value" style="color:${shColor}">${hasMeta ? fmt(wSharpe,2) : '—'}</div>
        <div class="metric-sub">${wSharpe>1?'Good':wSharpe>0?'Acceptable':'Poor'}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Top Sector</div>
        <div class="metric-value" style="color:${topSectorPct>40?'#ef4444':topSectorPct>25?'#d97706':'var(--text-primary)'}; font-size:16px">${topSector[0]}</div>
        <div class="metric-sub">${fmt(topSectorPct,1)}% of portfolio${topSectorPct>40?' — concentrated':''}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">1-Day VaR (95%)</div>
        <div class="metric-value" style="color:${varColor}">${hasMeta ? fmt(wVaR,2)+'%' : '—'}</div>
        <div class="metric-sub">Max expected daily loss</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Avg Max Drawdown (90d)</div>
        <div class="metric-value" style="color:${ddColor}">${hasMeta ? fmt(wMaxDD,1)+'%' : '—'}</div>
        <div class="metric-sub">${wMaxDD<8?'Shallow':wMaxDD<18?'Moderate':'Deep decline'}</div>
      </div>
    </div>
  </div>

  ${!hasMeta && !state.serverOk ? `
  <div class="info-banner" style="margin-top:12px">⚠ Backend offline — start <code>python asx_server.py</code> to fetch beta, volatility and correlation data.</div>` : ''}
  ${!hasMeta && state.serverOk ? `
  <div class="info-banner" style="margin-top:12px">Risk data loading or unavailable — yfinance may be rate-limited. Try again in a moment.</div>` : ''}

  <!-- Sector Pie — full row so legend has room -->
  <div class="card" style="margin-top:14px">
    <div class="card-title">Sector Concentration</div>
    <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
      <canvas id="sector-pie" width="260" height="260" style="flex-shrink:0;display:block"></canvas>
      <div style="flex:1;min-width:180px;display:flex;flex-direction:column;gap:6px;padding-top:4px">
        ${sectorEntries.map(([sec, val]) => {
          const pct = pv > 0 ? val/pv*100 : 0;
          const warn = pct > 40 ? '#ef4444' : pct > 25 ? '#d97706' : '';
          return `<div style="display:flex;align-items:center;gap:8px;font-size:12px">
            <div style="width:12px;height:12px;border-radius:3px;background:${sectorColorMap[sec]};flex-shrink:0"></div>
            <span style="flex:1">${sec}</span>
            <span style="font-weight:600${warn?';color:'+warn:''}">${fmt(pct,1)}%</span>
            <span class="text-muted" style="min-width:72px;text-align:right">$${fmt(val,0)}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>

  <!-- Correlation Heatmap — full width so cells are large enough to read -->
  <div class="card" style="margin-top:14px">
    <div class="card-title">Correlation Matrix (90-day returns)</div>
    ${hasCorrData
      ? `<div style="overflow-x:auto">
           <canvas id="corr-heatmap" style="display:block;margin:0 auto;max-width:100%"></canvas>
         </div>
         <p class="text-xs text-muted" style="margin-top:8px">
           -1 = perfect inverse &nbsp;·&nbsp; 0 = uncorrelated &nbsp;·&nbsp; +1 = perfect correlation.
           Holdings with correlation &gt; 0.8 provide little diversification benefit.
         </p>`
      : `<div class="text-xs text-muted" style="padding:20px 0">Need ≥ 2 holdings with data to show correlation. Refresh prices first.</div>`}
  </div>

  <!-- Per-holding metrics table -->
  <div class="card">
    <div class="flex-between" style="margin-bottom:10px">
      <div class="card-title" style="margin:0">Holdings Risk Profile</div>
      <button class="btn btn-sm" onclick="renderRiskPage(++state._renderGen)">⟳ Refresh</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Ticker</th>
          <th>Sector</th>
          <th>Value</th>
          <th title="Annualised volatility based on 90d daily returns">Vol (ann.)</th>
          <th title="Beta vs VAS (ASX 300 ETF). >1 = amplifies market, <1 = defensive">Beta</th>
          <th title="Sharpe ratio = (return - RBA rate) / volatility. >1 = good">Sharpe</th>
          <th title="Price return over last 30 calendar days">30d Return</th>
          <th title="1-day Value at Risk at 95% confidence (historical simulation)">VaR 1d</th>
          <th title="Maximum peak-to-trough decline over the 90-day period">Max DD</th>
        </tr></thead>
        <tbody>${holdingRows}</tbody>
      </table>
    </div>
    <p class="text-xs text-muted" style="margin-top:8px">
      Beta &amp; volatility sourced from 90-day daily returns via yfinance. Benchmark: VAS.AX (ASX 300).
      Sharpe uses RBA cash rate ${(state.rbaRate||4.35).toFixed(2)}% as risk-free rate.
    </p>
  </div>`;
}

// ── Sector colour palette ─────────────────────────────────────────────────────
// Named overrides for the most common yfinance sector strings.
// Anything not listed falls back to hash-based color generation so every
// sector always gets a distinct color regardless of the exact name.
const _SECTOR_NAMED = {
  // Banking / Finance
  'Banking':             '#3b82f6',
  'Financials':          '#60a5fa',
  'Financial Services':  '#2563eb',
  'Fintech':             '#818cf8',
  // Mining / Resources
  'Mining':              '#f59e0b',
  'Resources':           '#fbbf24',
  'Basic Materials':     '#d97706',
  'Materials':           '#b45309',
  // Energy
  'Energy':              '#f97316',
  'Oil & Gas':           '#ea580c',
  // Healthcare
  'Healthcare':          '#10b981',
  'Health Care':         '#059669',
  'Biotech':             '#34d399',
  'Biotechnology':       '#6ee7b7',
  // REITs / Property
  'REITs':               '#8b5cf6',
  'Real Estate':         '#7c3aed',
  'Property':            '#a78bfa',
  // Telecoms / Tech
  'Telecoms':            '#06b6d4',
  'Telecommunication Services': '#0891b2',
  'Communication Services': '#0284c7',
  'Technology':          '#22d3ee',
  'Information Technology': '#0ea5e9',
  // Consumer
  'Retail':              '#ec4899',
  'Consumer':            '#f472b6',
  'Consumer Cyclical':   '#db2777',
  'Consumer Defensive':  '#be185d',
  'Consumer Staples':    '#9d174d',
  'Consumer Discretionary': '#e11d48',
  // Industrials
  'Industrials':         '#84cc16',
  'Utilities':           '#65a30d',
  'Infrastructure':      '#a3e635',
  // Other
  'Other':               '#94a3b8',
  'Diversified':         '#64748b',
};

// Large palette of distinct hues for hash-based fallback
const _COLOR_PALETTE = [
  '#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6',
  '#ec4899','#06b6d4','#84cc16','#f59e0b','#10b981','#6366f1','#f43f5e',
  '#0ea5e9','#a855f7','#d946ef','#fb923c','#4ade80','#facc15',
];

function _hashSector(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function sectorColor(sector, fallbackIndex) {
  if (_SECTOR_NAMED[sector]) return _SECTOR_NAMED[sector];
  // Use position index if provided (gives stable ordering), otherwise hash name
  if (fallbackIndex !== undefined) {
    return _COLOR_PALETTE[fallbackIndex % _COLOR_PALETTE.length];
  }
  return _COLOR_PALETTE[_hashSector(sector) % _COLOR_PALETTE.length];
}

// ── Sector pie chart ──────────────────────────────────────────────────────────
function drawSectorPie(merged) {
  const canvas = document.getElementById('sector-pie');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const pv = portfolioValue();
  const sectorMap = {};
  for (const h of merged) {
    const sec = h.sector || 'Other';
    sectorMap[sec] = (sectorMap[sec] || 0) + h.shares * h.currentPrice;
  }
  const entries = Object.entries(sectorMap).sort((a,b) => b[1]-a[1]);
  if (!entries.length) return;

  const cx = W / 2, cy = H / 2, r = Math.min(cx, cy) - 10;
  let angle = -Math.PI / 2;
  entries.forEach(([sec, val], i) => {
    const slice = (val / pv) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = sectorColor(sec, i);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label if slice > 7%
    if (slice / (2 * Math.PI) > 0.07) {
      const mid = angle + slice / 2;
      const lx = cx + (r * 0.65) * Math.cos(mid);
      const ly = cy + (r * 0.65) * Math.sin(mid);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((val/pv*100).toFixed(0)+'%', lx, ly);
    }
    angle += slice;
  });
}

// ── Correlation heatmap ───────────────────────────────────────────────────────
function drawCorrelationHeatmap(merged, corr) {
  const canvas = document.getElementById('corr-heatmap');
  if (!canvas) return;
  const tickers = Object.keys(corr);
  if (tickers.length < 2) return;

  const n = tickers.length;

  // Compute cell size to fill available width (card is full-width now).
  // Use the container width, capped so cells don't get absurdly large.
  const containerW = canvas.parentElement ? canvas.parentElement.clientWidth || 700 : 700;
  const pad  = 48;
  const cell = Math.min(Math.floor((containerW - pad * 2) / n), 80);
  const size = cell * n + pad * 2;

  canvas.width  = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  const labelFont = `bold ${Math.min(12, Math.max(9, cell / 5))}px system-ui,sans-serif`;
  const valFont   = `${Math.min(12, Math.max(8, cell / 4))}px system-ui,sans-serif`;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const val = (corr[tickers[i]] || {})[tickers[j]] ?? 0;
      const x   = pad + j * cell;
      const y   = pad + i * cell;

      // Colour: red = high positive, blue = negative, near-white = uncorrelated
      const rv = val > 0 ? Math.round(220 * val)            : 0;
      const bv = val < 0 ? Math.round(220 * Math.abs(val))  : 0;
      const gv = i === j  ? 200 : Math.round(220 * (1 - Math.abs(val)));
      ctx.fillStyle = i === j ? '#e2e8f0' : `rgb(${rv},${gv},${bv})`;
      ctx.fillRect(x, y, cell - 2, cell - 2);

      // Value text
      ctx.fillStyle = Math.abs(val) > 0.5 ? '#fff' : '#1e293b';
      ctx.font = valFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(val.toFixed(2), x + (cell - 2) / 2, y + (cell - 2) / 2);
    }

    // Ticker labels — top row
    ctx.fillStyle = '#64748b';
    ctx.font = labelFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tickers[i], pad + i * cell + (cell - 2) / 2, pad / 2);

    // Ticker labels — left column
    ctx.textAlign = 'right';
    ctx.fillText(tickers[i], pad - 6, pad + i * cell + (cell - 2) / 2);
  }
}

// ── Composite Risk Score arc gauge ────────────────────────────────────────────
function drawRiskScoreGauge(score) {
  const canvas = document.getElementById('risk-score-gauge');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2 + 8;
  const r  = Math.min(cx, cy) - 8;
  ctx.clearRect(0, 0, W, H);

  // Background arc (grey track, 210° span)
  const startAngle = Math.PI * 0.75;
  const endAngle   = Math.PI * 2.25;
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.strokeStyle = 'rgba(148,163,184,0.25)';
  ctx.lineWidth   = 10;
  ctx.lineCap     = 'round';
  ctx.stroke();

  if (score == null) return;

  const frac  = Math.min(1, Math.max(0, score / 100));
  const fillEnd = startAngle + frac * (endAngle - startAngle);
  const color = score < 34 ? '#16a34a' : score < 67 ? '#d97706' : '#dc2626';

  // Coloured fill arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, fillEnd);
  ctx.strokeStyle = color;
  ctx.lineWidth   = 10;
  ctx.lineCap     = 'round';
  ctx.stroke();
}
