// ============================================================
// MARKET SCANNER
// ============================================================

let _scanPollTimer    = null;
let _scannerSort      = { col: 'score', dir: 'desc' };
let _scannerUniverse  = 'asx200';
let _scannerSector    = null;   // null = all sectors; string = filter to one sector

async function renderScannerPage(gen) {
  const el = document.getElementById('main-content');
  if (state._renderGen !== gen) return;

  // Fetch current status immediately (may have cached results)
  let scanState = {};
  if (state.serverOk) {
    try {
      const r = await fetch(`${API}/api/market/scan/status`);
      if (r.ok) scanState = await r.json();
    } catch {}
  }
  if (state._renderGen !== gen) return;

  el.innerHTML = _buildScannerHTML(scanState);

  // Resume polling if a scan is running
  if (scanState.running) _startScanPoller(gen);
}

function _buildScannerHTML(s) {
  const running  = s.running;
  const hasData  = !running && s.results && s.results.length > 0;
  const pct      = s.total > 0 ? Math.round(s.progress / s.total * 100) : 0;
  const universeLabels = { asx20:'ASX 20', asx50:'ASX 50', asx100:'ASX 100', asx200:'ASX 200' };

  return `
  <!-- Config bar -->
  <div class="card" style="margin-bottom:14px;padding:12px 16px">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:12px;color:var(--text-muted)">Universe:</span>
        ${['asx20','asx50','asx100','asx200'].map(u => `
          <button onclick="scannerSetUniverse('${u}')" class="btn btn-sm"
            style="${(_scannerUniverse===u)?'background:var(--accent-primary);color:#fff;':''}">
            ${universeLabels[u]}
          </button>`).join('')}
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:12px;color:var(--text-muted)">Min liquidity:</span>
        <select id="scanner-adv" style="font-size:12px;padding:3px 6px;border-radius:var(--radius-sm);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary)">
          <option value="1000000">$1M/day</option>
          <option value="2000000" selected>$2M/day</option>
          <option value="5000000">$5M/day</option>
          <option value="10000000">$10M/day</option>
        </select>
      </div>
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">
        <input type="checkbox" id="scanner-exclude" checked> Exclude my holdings
      </label>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
        ${s.scanned_at ? `<span style="font-size:11px;color:var(--text-muted)">Last scan: ${s.scanned_at} · ${s.filtered_count||0} passed filter</span>` : ''}
        ${running
          ? `<button class="btn btn-sm btn-danger" onclick="stopMarketScan()">■ Stop</button>`
          : `<button class="btn btn-primary" onclick="startMarketScan()" id="scan-btn">▶ Run Scan</button>`}
      </div>
    </div>

    ${running ? `
    <div style="margin-top:10px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:4px">
        <span>◎ ${s.stage === 'downloading' ? 'Downloading price data…' : `Scoring ${s.progress} / ${s.total} tickers…`}</span>
        <span>${pct}%</span>
      </div>
      <div style="height:4px;background:var(--border-light);border-radius:2px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:var(--accent-primary);border-radius:2px;transition:width 0.3s"></div>
      </div>
    </div>` : ''}
  </div>

  ${s.error ? `<div class="info-banner" style="margin-bottom:12px">⚠ Scan error: ${s.error}</div>` : ''}

  ${!hasData && !running ? `
  <div class="card">
    <div class="empty-state" style="padding:40px 0">
      <div class="empty-icon" style="font-size:48px">◈</div>
      <p>Select a universe and click <strong>Run Scan</strong> to find opportunities across the ${universeLabels[_scannerUniverse]}.</p>
      <p class="text-xs text-muted" style="margin-top:8px">
        The scanner evaluates trend, RSI pullback quality, volume accumulation,<br>and short-term momentum. Results are sector-diversified (max 4 per sector).
      </p>
      ${!state.serverOk ? '<p class="text-xs" style="color:#ef4444;margin-top:8px">⚠ Backend not running — start asx_server.py first.</p>' : ''}
    </div>
  </div>` : ''}

  ${hasData ? _buildSectorOverview(s.sector_stats) : ''}
  ${hasData ? _buildResultsTable(s.results) : ''}
  ${hasData && _scannerSector ? _buildSectorAllTickers(s.all_results, _scannerSector) : ''}
  `;
}

function _buildSectorOverview(sectorStats) {
  if (!sectorStats || !sectorStats.length) return '';

  const tiles = sectorStats.map(s => {
    const active    = _scannerSector === s.sector;
    const scoreCol  = s.avg_score >= 65 ? '#16a34a' : s.avg_score >= 45 ? '#d97706' : '#94a3b8';
    const ret5Col   = s.avg_ret_5d  >= 0 ? '#16a34a' : '#dc2626';
    const ret20Col  = s.avg_ret_20d >= 0 ? '#16a34a' : '#dc2626';
    const barW      = Math.round(s.avg_score);
    const border    = active ? '2px solid var(--accent-primary)' : '1px solid var(--border-light)';
    const bg        = active ? 'var(--bg-tertiary,#1e293b)' : 'var(--bg-secondary)';

    return `
    <div onclick='scannerSetSector(${JSON.stringify(s.sector)})'
         style="flex:0 0 auto;width:150px;padding:10px 12px;border-radius:var(--radius-md);
                background:${bg};border:${border};cursor:pointer;transition:border 0.15s"
         title="Click to filter results to ${s.sector}">
      <div style="font-size:11px;font-weight:600;color:var(--text-primary);
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:6px">
        ${active ? '✓ ' : ''}${s.sector}
      </div>
      <!-- score bar -->
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:5px">
        <div style="flex:1;height:5px;background:var(--border-light);border-radius:2px;overflow:hidden">
          <div style="width:${barW}%;height:100%;background:${scoreCol};border-radius:2px"></div>
        </div>
        <span style="font-size:11px;font-weight:700;color:${scoreCol};min-width:24px">${s.avg_score}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted)">
        <span>5d <strong style="color:${ret5Col}">${s.avg_ret_5d >= 0 ? '+' : ''}${s.avg_ret_5d.toFixed(1)}%</strong></span>
        <span>20d <strong style="color:${ret20Col}">${s.avg_ret_20d >= 0 ? '+' : ''}${s.avg_ret_20d.toFixed(1)}%</strong></span>
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
        ${s.count} ticker${s.count !== 1 ? 's' : ''} · top: <strong>${s.top_ticker}</strong>
      </div>
    </div>`;
  }).join('');

  const allActive = _scannerSector === null;
  return `
  <div class="card" style="margin-bottom:14px">
    <div class="flex-between" style="margin-bottom:10px">
      <div>
        <span class="card-title" style="margin:0">Sector Overview</span>
        <span class="text-xs text-muted" style="margin-left:8px">avg score &amp; returns across all ${sectorStats.reduce((a,s)=>a+s.count,0)} liquid tickers scanned · click to filter</span>
      </div>
      ${!allActive ? `<button class="btn btn-sm" onclick="scannerSetSector(null)">✕ Clear filter</button>` : ''}
    </div>
    <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:4px">
      <div onclick="scannerSetSector(null)"
           style="flex:0 0 auto;width:80px;padding:10px 12px;border-radius:var(--radius-md);
                  background:${allActive ? 'var(--bg-tertiary,#1e293b)' : 'var(--bg-secondary)'};
                  border:${allActive ? '2px solid var(--accent-primary)' : '1px solid var(--border-light)'};
                  cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px">
        <span style="font-size:18px">◈</span>
        <span style="font-size:11px;font-weight:600;color:${allActive ? 'var(--accent-primary)' : 'var(--text-secondary)'}">${allActive ? '✓ All' : 'All'}</span>
      </div>
      ${tiles}
    </div>
  </div>`;
}

function _buildResultsTable(results) {
  // Apply sector filter then sort
  const filtered = _scannerSector
    ? results.filter(r => r.sector === _scannerSector)
    : results;

  const sorted = [...filtered].sort((a, b) => {
    const v = _scannerSort.dir === 'desc' ? b[_scannerSort.col] - a[_scannerSort.col]
                                          : a[_scannerSort.col] - b[_scannerSort.col];
    return isNaN(v) ? 0 : v;
  });

  const portfolioTickers = new Set(state.portfolio.map(h => h.ticker));
  const watchlistTickers = new Set(state.analysisConfig?.extraTickers || []);

  const colHdr = (col, label, title='') => {
    const active = _scannerSort.col === col;
    const arrow  = active ? (_scannerSort.dir === 'desc' ? ' ↓' : ' ↑') : '';
    return `<th title="${title}" style="cursor:pointer;user-select:none${active?';color:var(--accent-primary)':''}"
      onclick="scannerSort('${col}')">${label}${arrow}</th>`;
  };

  const scoreBar = (score, w=60) => {
    const color = score >= 70 ? '#16a34a' : score >= 50 ? '#d97706' : '#94a3b8';
    return `<div style="display:flex;align-items:center;gap:6px">
      <div style="width:${w}px;height:6px;background:var(--border-light);border-radius:3px;overflow:hidden">
        <div style="width:${score}%;height:100%;background:${color};border-radius:3px"></div>
      </div>
      <span style="font-size:12px;font-weight:600;color:${color}">${score}</span>
    </div>`;
  };

  const rows = sorted.map((r, i) => {
    const inPortfolio = portfolioTickers.has(r.ticker);
    const inWatchlist = watchlistTickers.has(r.ticker);
    const trendIcon   = r.trend_score >= 25 ? '↑' : r.trend_score >= 15 ? '→' : '↓';
    const trendColor  = r.trend_score >= 25 ? '#16a34a' : r.trend_score >= 15 ? '#d97706' : '#dc2626';
    const rsiColor    = r.rsi < 35 ? '#16a34a' : r.rsi > 65 ? '#dc2626' : '#d97706';
    const ret5Color   = r.ret_5d >= 0 ? '#16a34a' : '#dc2626';
    const ret20Color  = r.ret_20d >= 0 ? '#16a34a' : '#dc2626';
    const highColor   = r.pct_from_high >= -10 ? '#d97706' : r.pct_from_high >= -20 ? '#16a34a' : '#94a3b8';

    const actionBtn = inPortfolio
      ? `<span class="badge badge-neutral" style="font-size:10px">In portfolio</span>`
      : inWatchlist
        ? `<span class="badge" style="background:#dcfce7;color:#15803d;font-size:10px">✓ Watchlist</span>
           <button class="btn btn-sm" style="font-size:10px" onclick="scannerRunSignals('${r.ticker}')">→ Signals</button>`
        : `<button class="btn btn-sm btn-primary" style="font-size:10px;padding:2px 8px"
             onclick="scannerAddToWatchlist('${r.ticker}')">+ Watchlist</button>
           <button class="btn btn-sm" style="font-size:10px;padding:2px 8px"
             onclick="scannerRunSignals('${r.ticker}')">→ Signals</button>`;

    return `<tr>
      <td style="font-size:11px;color:var(--text-muted)">${i + 1}</td>
      <td><strong>${r.ticker}</strong></td>
      <td><span class="text-xs" style="background:var(--bg-secondary);padding:2px 6px;border-radius:10px">${r.sector}</span></td>
      <td style="font-weight:600">$${fmt(r.current_price, 3)}</td>
      <td>${scoreBar(r.score)}</td>
      <td style="text-align:center"><span style="color:${trendColor};font-weight:600">${trendIcon} ${r.trend_score}</span></td>
      <td style="text-align:center"><span style="color:${rsiColor}">${fmt(r.rsi, 1)}</span></td>
      <td style="text-align:center;color:${ret5Color};font-weight:600">${r.ret_5d >= 0 ? '+' : ''}${fmt(r.ret_5d, 1)}%</td>
      <td style="text-align:center;color:${ret20Color}">${r.ret_20d >= 0 ? '+' : ''}${fmt(r.ret_20d, 1)}%</td>
      <td style="text-align:center;color:${highColor}">${fmt(r.pct_from_high, 1)}%</td>
      <td style="text-align:center;color:var(--text-muted);font-size:11px">${fmt(r.adv_aud, 1)}M</td>
      <td style="white-space:nowrap">${actionBtn}</td>
    </tr>`;
  }).join('');

  return `
  <div class="card">
    <div class="flex-between" style="margin-bottom:10px">
      <div>
        <div class="card-title" style="margin:0">
          Opportunities — ${sorted.length} result${sorted.length !== 1 ? 's' : ''}
          ${_scannerSector ? `<span style="margin-left:8px;font-size:12px;font-weight:400;
            background:var(--accent-primary);color:#fff;padding:2px 8px;border-radius:10px">
            ${_scannerSector} ✕</span>` : ''}
        </div>
        <div class="text-xs text-muted" style="margin-top:2px">
          Sorted by ${_scannerSort.col} ${_scannerSort.dir === 'desc' ? '↓' : '↑'} ·
          ${_scannerSector ? `filtered to ${_scannerSector}` : 'max 4 per sector'} ·
          click column headers to sort
        </div>
      </div>
      <button class="btn btn-sm" onclick="scannerAddAllToWatchlist(${JSON.stringify(sorted.map(r=>r.ticker))})">+ Add all to Watchlist</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>#</th>
          <th>Ticker</th>
          <th>Sector</th>
          <th>Price</th>
          <th title="Composite opportunity score (0-100): trend + pullback quality + volume + momentum" style="min-width:110px;cursor:pointer;user-select:none${_scannerSort.col==='score'?';color:var(--accent-primary)':''}" onclick="scannerSort('score')">Score${_scannerSort.col==='score'?(_scannerSort.dir==='desc'?' ↓':' ↑'):''}</th>
          ${colHdr('trend_score','Trend','Price vs SMA20/50, SMA slope (0-30)')}
          ${colHdr('rsi','RSI','RSI-14: 35-55 is ideal opportunity zone')}
          ${colHdr('ret_5d','5d%','5-day price return')}
          ${colHdr('ret_20d','20d%','20-day price return')}
          ${colHdr('pct_from_high','vs High','% below 90-day high — ideal -5% to -20%')}
          ${colHdr('adv_aud','Vol $M','Average daily $ turnover (millions)')}
          <th>Action</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="margin-top:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;font-size:11px;color:var(--text-muted)">
      <div><strong style="color:var(--text-primary)">Score</strong> = Trend(30) + Pullback(30) + Volume(20) + Momentum(20)</div>
      <div><strong style="color:var(--text-primary)">Trend</strong> = price vs SMA20/50 + SMA slope (bullish alignment)</div>
      <div><strong style="color:var(--text-primary)">Pullback</strong> = RSI zone 35-55 + position 5-20% off high</div>
      <div><strong style="color:var(--text-primary)">Volume</strong> = 5-day avg vs 20-day avg (accumulation signal)</div>
    </div>
  </div>`;
}

function _buildSectorAllTickers(allResults, sector) {
  if (!allResults || !sector) return '';
  const sectorRows = [...allResults]
    .filter(r => r.sector === sector)
    .sort((a, b) => b.score - a.score);
  if (!sectorRows.length) return '';

  const portfolioTickers = new Set(state.portfolio.map(h => h.ticker));
  const watchlistTickers = new Set(state.analysisConfig?.extraTickers || []);

  const scoreBar = (score, w=50) => {
    const color = score >= 70 ? '#16a34a' : score >= 50 ? '#d97706' : '#94a3b8';
    return `<div style="display:flex;align-items:center;gap:5px">
      <div style="width:${w}px;height:5px;background:var(--border-light);border-radius:2px;overflow:hidden">
        <div style="width:${score}%;height:100%;background:${color};border-radius:2px"></div>
      </div>
      <span style="font-size:11px;font-weight:600;color:${color}">${score}</span>
    </div>`;
  };

  const rows = sectorRows.map(r => {
    const trendIcon  = r.trend_score >= 25 ? '↑' : r.trend_score >= 15 ? '→' : '↓';
    const trendColor = r.trend_score >= 25 ? '#16a34a' : r.trend_score >= 15 ? '#d97706' : '#dc2626';
    const rsiColor   = r.rsi < 35 ? '#16a34a' : r.rsi > 65 ? '#dc2626' : '#d97706';
    const r5c        = r.ret_5d  >= 0 ? '#16a34a' : '#dc2626';
    const r20c       = r.ret_20d >= 0 ? '#16a34a' : '#dc2626';
    const highColor  = r.pct_from_high >= -10 ? '#d97706' : r.pct_from_high >= -20 ? '#16a34a' : '#94a3b8';
    const tag = portfolioTickers.has(r.ticker)
      ? `<span style="font-size:9px;background:#334155;color:#94a3b8;padding:1px 5px;border-radius:8px;margin-left:4px">held</span>`
      : watchlistTickers.has(r.ticker)
      ? `<span style="font-size:9px;background:#14532d;color:#86efac;padding:1px 5px;border-radius:8px;margin-left:4px">watch</span>`
      : '';
    return `<tr>
      <td><strong>${r.ticker}</strong>${tag}</td>
      <td>$${fmt(r.current_price, 3)}</td>
      <td>${scoreBar(r.score)}</td>
      <td style="text-align:center"><span style="color:${trendColor};font-weight:600">${trendIcon} ${r.trend_score}</span></td>
      <td style="text-align:center"><span style="color:${rsiColor}">${fmt(r.rsi,1)}</span></td>
      <td style="text-align:center;color:${r5c};font-weight:600">${r.ret_5d>=0?'+':''}${fmt(r.ret_5d,1)}%</td>
      <td style="text-align:center;color:${r20c}">${r.ret_20d>=0?'+':''}${fmt(r.ret_20d,1)}%</td>
      <td style="text-align:center;color:${highColor}">${fmt(r.pct_from_high,1)}%</td>
      <td style="text-align:center;color:var(--text-muted);font-size:11px">${fmt(r.adv_aud,1)}M</td>
    </tr>`;
  }).join('');

  return `
  <div class="card" style="margin-top:14px">
    <div class="flex-between" style="margin-bottom:10px">
      <div>
        <span class="card-title" style="margin:0">All ${sector} Tickers</span>
        <span class="text-xs text-muted" style="margin-left:8px">${sectorRows.length} liquid tickers · no opportunity rules applied · sorted by score</span>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Ticker</th><th>Price</th>
          <th style="min-width:100px">Score</th>
          <th style="text-align:center">Trend</th>
          <th style="text-align:center">RSI</th>
          <th style="text-align:center">5d%</th>
          <th style="text-align:center">20d%</th>
          <th style="text-align:center">vs High</th>
          <th style="text-align:center">Vol $M</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="text-xs text-muted mt-1">
      All tickers from the scanned universe in the ${sector} sector that passed the liquidity filter.
      No score threshold, diversification cap, or opportunity rules applied.
    </p>
  </div>`;
}

// ── Controls ──────────────────────────────────────────────────────────────────

function scannerSetUniverse(u) {
  _scannerUniverse = u;
  _scannerSector   = null;   // reset sector filter when universe changes
  renderPage();
}

function scannerSetSector(sector) {
  _scannerSector = (_scannerSector === sector) ? null : sector;  // toggle off if same
  renderPage();
}

function scannerSort(col) {
  if (_scannerSort.col === col) {
    _scannerSort.dir = _scannerSort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    _scannerSort = { col, dir: 'desc' };
  }
  renderPage();
}

async function startMarketScan() {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }

  const adv     = parseFloat(document.getElementById('scanner-adv')?.value || 2000000);
  const exclude = document.getElementById('scanner-exclude')?.checked
    ? state.portfolio.map(h => h.ticker) : [];

  const btn = document.getElementById('scan-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Starting…'; }

  try {
    const r = await fetch(`${API}/api/market/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ universe: _scannerUniverse, exclude, min_adv_aud: adv, max_results: 25 }),
    });
    if (r.status === 409) { toast('Scan already running', 'info'); renderPage(); return; }
    const d = await r.json();
    if (!d.ok) { toast(`Error: ${d.error}`, 'error'); renderPage(); return; }
    toast(`Scan started — ${d.message}`, 'success');
    renderPage();
    _startScanPoller(state._renderGen);
  } catch (e) {
    toast(`Scan failed: ${e.message}`, 'error');
    renderPage();
  }
}

async function stopMarketScan() {
  try { await fetch(`${API}/api/market/scan/stop`, { method: 'POST' }); } catch {}
}

function _startScanPoller(gen) {
  if (_scanPollTimer) return;
  _scanPollTimer = setInterval(async () => {
    try {
      const r = await fetch(`${API}/api/market/scan/status`);
      if (!r.ok) return;
      const s = await r.json();

      // Update progress bar in place without full re-render
      const bar = document.querySelector('#scan-progress-bar');
      if (bar && s.total > 0) bar.style.width = Math.round(s.progress / s.total * 100) + '%';

      if (!s.running) {
        clearInterval(_scanPollTimer);
        _scanPollTimer = null;
        if (state._renderGen === gen && state.page === 'scanner') {
          renderPage();
          if (s.stage === 'complete')
            toast(`Scan complete — ${s.results?.length || 0} opportunities found from ${s.filtered_count} candidates`, 'success');
          else if (s.error)
            toast(`Scan failed: ${s.error}`, 'error');
        }
      } else if (state.page === 'scanner' && state._renderGen === gen) {
        // Light update: just refresh the progress number
        const stagEl = document.querySelector('#scan-stage-label');
        if (stagEl) stagEl.textContent = s.stage === 'downloading'
          ? 'Downloading price data…'
          : `Scoring ${s.progress} / ${s.total} tickers…`;
        const pctEl = document.querySelector('#scan-pct-label');
        if (pctEl && s.total > 0) pctEl.textContent = Math.round(s.progress / s.total * 100) + '%';
      }
    } catch {}
  }, 1500);
}

function _stopScanPoller() {
  if (_scanPollTimer) { clearInterval(_scanPollTimer); _scanPollTimer = null; }
}

// ── Watchlist actions ─────────────────────────────────────────────────────────

function scannerAddToWatchlist(ticker) {
  const extras = state.analysisConfig?.extraTickers || [];
  if (extras.includes(ticker)) { toast(`${ticker} already in watchlist`, 'info'); return; }
  if (!state.analysisConfig) state.analysisConfig = {};
  state.analysisConfig.extraTickers = [...extras, ticker];
  saveStateToDb();
  toast(`${ticker} added to watchlist — will be included in next analysis`, 'success');
  renderPage();
}

function scannerAddAllToWatchlist(tickers) {
  const extras    = new Set(state.analysisConfig?.extraTickers || []);
  const portfolio = new Set(state.portfolio.map(h => h.ticker));
  let added = 0;
  for (const t of tickers) {
    if (!extras.has(t) && !portfolio.has(t)) { extras.add(t); added++; }
  }
  if (!state.analysisConfig) state.analysisConfig = {};
  state.analysisConfig.extraTickers = [...extras];
  saveStateToDb();
  toast(`${added} tickers added to watchlist`, added > 0 ? 'success' : 'info');
  renderPage();
}

async function scannerRunSignals(ticker) {
  // Add to watchlist if not already there, then navigate to signals page
  scannerAddToWatchlist(ticker);
  // Pre-fetch signals for this ticker
  toast(`Fetching signals for ${ticker}…`, 'info');
  try {
    await fetchSignals([ticker], true);
    showPage('signals');
  } catch (e) {
    toast(`Could not fetch signals: ${e.message}`, 'error');
  }
}
