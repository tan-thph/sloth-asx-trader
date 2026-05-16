// ============================================================
// PORTFOLIO RISK DASHBOARD
// ============================================================

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
    drawSectorPie(merged);
    drawCorrelationHeatmap(merged, riskData.correlation || {});
  }, 60);
}

function buildRiskPage(merged, riskData) {
  const metrics     = riskData.metrics || {};
  const pv          = portfolioValue();
  const nw          = totalNetWorth();

  // ── Portfolio-level weighted metrics ──────────────────────────────────────
  let wBeta = 0, wVol = 0, wSharpe = 0, covered = 0;
  for (const h of merged) {
    const m = metrics[h.ticker];
    if (!m) continue;
    const w = pv > 0 ? (h.shares * h.currentPrice) / pv : 0;
    wBeta   += m.beta           * w;
    wVol    += m.volatility_ann * w;
    wSharpe += m.sharpe         * w;
    covered++;
  }
  const hasMeta = covered > 0;

  const betaColor  = wBeta < 0.8 ? '#16a34a' : wBeta < 1.2 ? '#d97706' : '#dc2626';
  const volColor   = wVol  < 15  ? '#16a34a' : wVol  < 25  ? '#d97706' : '#dc2626';
  const shColor    = wSharpe > 1  ? '#16a34a' : wSharpe > 0  ? '#d97706' : '#dc2626';

  // ── Sector concentration ──────────────────────────────────────────────────
  const sectorMap = {};
  for (const h of merged) {
    const val = h.shares * h.currentPrice;
    const sec = h.sector || 'Other';
    sectorMap[sec] = (sectorMap[sec] || 0) + val;
  }
  const sectorEntries = Object.entries(sectorMap).sort((a,b) => b[1]-a[1]);
  const topSector = sectorEntries[0];
  const topSectorPct = pv > 0 ? topSector[1]/pv*100 : 0;

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
    </tr>`;
  }).join('');

  return `
  <!-- Portfolio-level summary tiles -->
  <div class="metrics-grid" style="margin-bottom:0">
    <div class="metric-card">
      <div class="metric-label">Portfolio Beta (vs VAS)</div>
      <div class="metric-value" style="color:${betaColor}">${hasMeta ? fmt(wBeta,2) : '—'}</div>
      <div class="metric-sub">${wBeta<0.8?'Defensive — less volatile than market':wBeta<1.2?'Neutral — moves with market':'Aggressive — amplifies market moves'}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Weighted Volatility (ann.)</div>
      <div class="metric-value" style="color:${volColor}">${hasMeta ? fmt(wVol,1)+'%' : '—'}</div>
      <div class="metric-sub">${wVol<15?'Low — stable portfolio':wVol<25?'Moderate':'High — significant price swings expected'}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Portfolio Sharpe Ratio</div>
      <div class="metric-value" style="color:${shColor}">${hasMeta ? fmt(wSharpe,2) : '—'}</div>
      <div class="metric-sub">${wSharpe>1?'Good — solid risk-adjusted return':wSharpe>0?'Acceptable — positive but modest':'Poor — return not compensating for risk'}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Top Sector Concentration</div>
      <div class="metric-value" style="color:${topSectorPct>40?'#ef4444':topSectorPct>25?'#d97706':'var(--text-primary)'}">${topSector[0]}</div>
      <div class="metric-sub">${fmt(topSectorPct,1)}% of portfolio${topSectorPct>40?' — concentrated risk':''}</div>
    </div>
  </div>

  ${!hasMeta && !state.serverOk ? `
  <div class="info-banner" style="margin-top:12px">⚠ Backend offline — start <code>python asx_server.py</code> to fetch beta, volatility and correlation data.</div>` : ''}
  ${!hasMeta && state.serverOk ? `
  <div class="info-banner" style="margin-top:12px">Risk data loading or unavailable — yfinance may be rate-limited. Try again in a moment.</div>` : ''}

  <div class="grid-2" style="margin-top:14px">
    <!-- Sector Pie -->
    <div class="card">
      <div class="card-title">Sector Concentration</div>
      <canvas id="sector-pie" width="340" height="220" style="display:block;margin:0 auto"></canvas>
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:4px">
        ${sectorEntries.map(([sec, val]) => {
          const pct = pv > 0 ? val/pv*100 : 0;
          const warn = pct > 40 ? '#ef4444' : pct > 25 ? '#d97706' : '';
          return `<div style="display:flex;align-items:center;gap:8px;font-size:12px">
            <div style="width:10px;height:10px;border-radius:50%;background:${sectorColor(sec)};flex-shrink:0"></div>
            <span style="flex:1">${sec}</span>
            <span style="font-weight:600${warn?';color:'+warn:''}">${fmt(pct,1)}%</span>
            <span class="text-muted">$${fmt(val,0)}</span>
          </div>`;
        }).join('')}
      </div>
    </div>

    <!-- Correlation Heatmap -->
    <div class="card">
      <div class="card-title">Correlation Matrix (90-day returns)</div>
      ${Object.keys(riskData.correlation||{}).length >= 2
        ? `<canvas id="corr-heatmap" width="340" height="340" style="display:block;margin:0 auto;max-width:100%"></canvas>
           <p class="text-xs text-muted" style="margin-top:8px">-1 = perfect inverse · 0 = uncorrelated · +1 = perfect correlation. Highly correlated holdings (>0.8) provide little diversification.</p>`
        : `<div class="text-xs text-muted" style="padding:20px 0">Need ≥ 2 holdings with data to show correlation. Refresh prices first.</div>`}
    </div>
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
const SECTOR_COLORS = {
  'Banking':    '#3b82f6', 'Financials':  '#60a5fa', 'Fintech': '#818cf8',
  'Mining':     '#f59e0b', 'Resources':   '#fbbf24', 'Energy':  '#f97316',
  'Healthcare': '#10b981', 'Biotech':     '#34d399',
  'REITs':      '#8b5cf6', 'Property':    '#a78bfa',
  'Telecoms':   '#06b6d4', 'Technology':  '#22d3ee',
  'Retail':     '#ec4899', 'Consumer':    '#f472b6',
  'Utilities':  '#84cc16', 'Infrastructure': '#a3e635',
  'Other':      '#94a3b8',
};
function sectorColor(sector) {
  return SECTOR_COLORS[sector] || SECTOR_COLORS['Other'];
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

  const cx = W / 2, cy = H / 2, r = Math.min(cx, cy) - 12;
  let angle = -Math.PI / 2;
  for (const [sec, val] of entries) {
    const slice = (val / pv) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = sectorColor(sec);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label if slice > 8%
    if (slice / (2 * Math.PI) > 0.08) {
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
  }
}

// ── Correlation heatmap ───────────────────────────────────────────────────────
function drawCorrelationHeatmap(merged, corr) {
  const canvas = document.getElementById('corr-heatmap');
  if (!canvas) return;
  const tickers = Object.keys(corr);
  if (tickers.length < 2) return;

  const n    = tickers.length;
  const pad  = 36;
  const cell = Math.min(Math.floor((Math.min(canvas.width, canvas.height) - pad * 2) / n), 52);
  const size = cell * n + pad * 2;
  canvas.width  = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const val  = (corr[tickers[i]] || {})[tickers[j]] ?? 0;
      const x    = pad + j * cell;
      const y    = pad + i * cell;

      // Colour: red for high positive, blue for negative, white for ~0
      const r = val > 0 ? Math.round(220 * val) : 0;
      const b = val < 0 ? Math.round(220 * Math.abs(val)) : 0;
      const g = i === j ? 200 : Math.round(220 * (1 - Math.abs(val)));
      ctx.fillStyle = i === j ? '#e2e8f0' : `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y, cell - 2, cell - 2);

      // Value text
      ctx.fillStyle = Math.abs(val) > 0.5 ? '#fff' : '#1e293b';
      ctx.font = `${Math.min(11, cell/4)}px system-ui,sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(val.toFixed(2), x + (cell-2)/2, y + (cell-2)/2);
    }

    // Ticker labels — top
    ctx.fillStyle = 'var(--text-secondary)';
    ctx.font = `bold ${Math.min(11, cell/4)}px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tickers[i], pad + i * cell + (cell-2)/2, pad / 2);

    // Ticker labels — left
    ctx.textAlign = 'right';
    ctx.fillText(tickers[i], pad - 4, pad + i * cell + (cell-2)/2);
  }
}
