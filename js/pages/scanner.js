// ============================================================
// MARKET SCANNER
// ============================================================

let _scanPollTimer    = null;
let _scannerSort      = { col: 'score', dir: 'desc' };
let _scannerUniverse  = 'asx200';
let _scannerSector    = null;   // null = all sectors; string = filter to one sector
let _scannerTab       = 'opportunities';   // 'opportunities' | 'screener' | 'compare' | 'factor-stability'

// Technical Screener Sandbox state
let _screenerData     = null;   // last fetched analyse result
let _screenerTicker   = '';
let _screenerLoading  = false;
let _screenerError    = '';
let _screenerChartMode = 'candle';
let _screenerOverlays  = { bb: true, sma50: true, pivots: false };
let _screenerHoverIdx  = -1;   // index of candle under cursor; -1 = none

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

  // Post-render init for the Compare tab (fill inputs + run if tickers set)
  if (_scannerTab === 'compare') _initCompareTab();

  // Resume polling if a scan is running
  if (scanState.running) _startScanPoller(gen);
}

function _buildScannerHTML(s) {
  const running  = s.running;
  const hasData  = !running && s.results && s.results.length > 0;
  const pct      = s.total > 0 ? Math.round(s.progress / s.total * 100) : 0;
  const universeLabels = { asx20:'ASX 20', asx50:'ASX 50', asx100:'ASX 100', asx200:'ASX 200' };

  // Tab nav
  const tabNav = `
  <div style="display:flex;gap:2px;margin-bottom:14px;border-bottom:1px solid var(--border-light);padding-bottom:0">
    ${[['opportunities','◈ Opportunities'],['screener','⊙ Technical Screener'],['compare','↔ Compare'],['factor-stability','🔬 Factor Stability']].map(([id,label]) => `
      <button onclick="scannerSetTab('${id}')" style="padding:7px 16px;font-size:13px;font-weight:600;border:none;
        border-bottom:2px solid ${_scannerTab===id?'var(--accent-primary)':'transparent'};
        background:transparent;cursor:pointer;
        color:${_scannerTab===id?'var(--accent-primary)':'var(--text-muted)'};
        transition:color 0.15s,border-color 0.15s">${label}</button>`).join('')}
  </div>`;

  if (_scannerTab === 'screener')          return tabNav + _buildScreenerHTML();
  if (_scannerTab === 'compare')           return tabNav + _buildCompareShell();
  if (_scannerTab === 'factor-stability')  return tabNav + _buildFactorStabilityHTML();

  return tabNav + `
  <!-- Config bar -->
  <div class="card" style="margin-bottom:14px;padding:12px 16px">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:12px;color:var(--text-muted)">Universe:</span>
        ${['asx20','asx50','asx100','asx200'].map(u => `
          <button onclick="scannerSetUniverse('${u}')" class="btn btn-sm"
            style="${(_scannerUniverse===u)?'background:#3b82f6;color:#fff;':''}">
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
        ${s.scanned_at ? `<span style="font-size:11px;color:var(--text-muted)">Last scan: ${s.scanned_at} · ${s.filtered_count||0} passed filter${s.breadth_ratio != null ? ` · ${Math.round(s.breadth_ratio*100)}% above SMA20` : ''}</span>` : ''}
        <button class="btn btn-sm" onclick="scannerSavePreset()" title="Save current settings as a preset">⊕ Save</button>
        ${running
          ? `<button class="btn btn-sm btn-danger" onclick="stopMarketScan()">■ Stop</button>`
          : `<button class="btn btn-primary" onclick="startMarketScan()" id="scan-btn">▶ Run Scan</button>`}
      </div>
    </div>
    ${(state.savedScreeners||[]).length ? `
    <div style="display:flex;align-items:center;gap:6px;margin-top:10px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--text-muted)">Presets:</span>
      ${(state.savedScreeners||[]).map(p => `
        <button class="btn btn-sm" onclick="scannerLoadPreset(${JSON.stringify(p.name)})" title="${p.config.universe} · $${(p.config.min_adv_aud/1e6).toFixed(0)}M">${p.name}</button>
        <button class="btn btn-sm" onclick="scannerDeletePreset(${JSON.stringify(p.name)})" style="padding:2px 5px;font-size:10px" title="Delete preset">✕</button>
      `).join('')}
    </div>` : ''}

    ${running ? `
    <div style="margin-top:10px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:4px">
        <span>◎ ${s.stage === 'downloading' ? 'Downloading price data…' : `Scoring ${s.progress} / ${s.total} tickers…`}</span>
        <span>${pct}%</span>
      </div>
      <div style="height:4px;background:var(--border-light);border-radius:2px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:#3b82f6;border-radius:2px;transition:width 0.3s"></div>
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
    const border    = active ? '2px solid #3b82f6' : '1px solid var(--border-light)';
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
                  border:${allActive ? '2px solid #3b82f6' : '1px solid var(--border-light)'};
                  cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px">
        <span style="font-size:18px">◈</span>
        <span style="font-size:11px;font-weight:600;color:${allActive ? '#3b82f6' : 'var(--text-secondary)'}">${allActive ? '✓ All' : 'All'}</span>
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
    return `<th title="${title}" style="cursor:pointer;user-select:none${active?';color:#3b82f6':''}"
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
            background:#3b82f6;color:#fff;padding:2px 8px;border-radius:10px">
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
          <th title="Composite opportunity score (0-100): trend + pullback quality + volume + momentum" style="min-width:110px;cursor:pointer;user-select:none${_scannerSort.col==='score'?';color:#3b82f6':''}" onclick="scannerSort('score')">Score${_scannerSort.col==='score'?(_scannerSort.dir==='desc'?' ↓':' ↑'):''}</th>
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
    const inPortfolio = portfolioTickers.has(r.ticker);
    const inWatchlist = watchlistTickers.has(r.ticker);
    const trendIcon  = r.trend_score >= 25 ? '↑' : r.trend_score >= 15 ? '→' : '↓';
    const trendColor = r.trend_score >= 25 ? '#16a34a' : r.trend_score >= 15 ? '#d97706' : '#dc2626';
    const rsiColor   = r.rsi < 35 ? '#16a34a' : r.rsi > 65 ? '#dc2626' : '#d97706';
    const r5c        = r.ret_5d  >= 0 ? '#16a34a' : '#dc2626';
    const r20c       = r.ret_20d >= 0 ? '#16a34a' : '#dc2626';
    const highColor  = r.pct_from_high >= -10 ? '#d97706' : r.pct_from_high >= -20 ? '#16a34a' : '#94a3b8';
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
      <td><strong>${r.ticker}</strong></td>
      <td>$${fmt(r.current_price, 3)}</td>
      <td>${scoreBar(r.score)}</td>
      <td style="text-align:center"><span style="color:${trendColor};font-weight:600">${trendIcon} ${r.trend_score}</span></td>
      <td style="text-align:center"><span style="color:${rsiColor}">${fmt(r.rsi,1)}</span></td>
      <td style="text-align:center;color:${r5c};font-weight:600">${r.ret_5d>=0?'+':''}${fmt(r.ret_5d,1)}%</td>
      <td style="text-align:center;color:${r20c}">${r.ret_20d>=0?'+':''}${fmt(r.ret_20d,1)}%</td>
      <td style="text-align:center;color:${highColor}">${fmt(r.pct_from_high,1)}%</td>
      <td style="text-align:center;color:var(--text-muted);font-size:11px">${fmt(r.adv_aud,1)}M</td>
      <td style="white-space:nowrap">${actionBtn}</td>
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
          <th>Action</th>
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

// ── Technical Screener Sandbox ────────────────────────────────────────────────

function _buildScreenerHTML() {
  const d = _screenerData;

  // Search bar
  const searchBar = `
  <div class="card" style="margin-bottom:14px;padding:12px 16px">
    <div style="font-size:13px;font-weight:600;margin-bottom:10px">Technical Screener Sandbox</div>
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">
      Type standard ASX ticker codes (e.g. CBA, BHP, WTC, RIO, TLS) to run technical indicator scans on 1-year historical prices from Yahoo Finance.
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <div style="position:relative;flex:0 0 200px">
        <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:13px">⌕</span>
        <input id="screener-input" type="text" placeholder="CBA"
          value="${_screenerTicker}"
          style="width:100%;padding:7px 10px 7px 30px;font-size:13px;font-weight:600;text-transform:uppercase;
                 border:1px solid var(--border-medium);border-radius:var(--radius-sm);
                 background:var(--bg-secondary);color:var(--text-primary);box-sizing:border-box"
          onkeydown="if(event.key==='Enter')runScreener()"
          oninput="this.value=this.value.toUpperCase()">
      </div>
      <button class="btn btn-primary" onclick="runScreener()" ${_screenerLoading?'disabled':''} style="padding:7px 18px">
        ${_screenerLoading ? '⟳ Fetching…' : 'Fetch Details'}
      </button>
      ${_screenerError ? `<span style="font-size:11px;color:#ef4444">${_screenerError}</span>` : ''}
    </div>
  </div>`;

  if (!d) return searchBar;

  const f = d.fundamentals || {};
  const sr = d.support_resistance || {};
  const cd = d.chart_data || [];

  // OHLCV header bar
  const lastBar = cd[cd.length - 1] || {};
  const chgPct = d.return_1d != null ? d.return_1d : 0;
  const chgCol = chgPct >= 0 ? '#16a34a' : '#dc2626';

  const ohlcvHeader = `
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:10px;flex-wrap:wrap">
    <div>
      <span style="font-size:16px;font-weight:700;color:var(--text-primary)">${d.ticker}.AX Technical Desk</span>
      <span style="font-size:11px;color:var(--text-muted);margin-left:8px">${lastBar.date || ''}</span>
    </div>
    <div style="display:flex;gap:12px;font-size:12px;color:var(--text-muted)">
      <span>O: <strong style="color:var(--text-primary)">$${fmt(lastBar.open,2)}</strong></span>
      <span>H: <strong style="color:#16a34a">$${fmt(lastBar.high,2)}</strong></span>
      <span>L: <strong style="color:#dc2626">$${fmt(lastBar.low,2)}</strong></span>
      <span>C: <strong style="color:${chgCol}">$${fmt(lastBar.close,2)}</strong></span>
      <span>V: <strong style="color:var(--text-secondary)">${lastBar.volume ? Math.round(lastBar.volume/1000)+'k' : 'n/a'}</strong></span>
    </div>
  </div>`;

  // Chart toggles — buttons have IDs so screenerSetChartMode / screenerToggleOverlay
  // can update them in-place without calling renderPage() (which would destroy the canvas).
  const overlayBtn = (key, label, active) =>
    `<button id="screener-ov-${key}" onclick="screenerToggleOverlay('${key}')"
      style="padding:3px 10px;font-size:11px;font-weight:600;
      border-radius:4px;border:1px solid ${active?'var(--accent-primary)':'var(--border-medium)'};
      background:${active?'var(--accent-primary)':'transparent'};
      color:${active?'#fff':'var(--text-muted)'};cursor:pointer">${label}</button>`;

  const modeBtn = (m, label) =>
    `<button id="screener-mode-${m}" onclick="screenerSetChartMode('${m}')"
      style="padding:3px 10px;font-size:11px;font-weight:600;
      border-radius:4px;border:1px solid ${_screenerChartMode===m?'var(--accent-primary)':'var(--border-medium)'};
      background:${_screenerChartMode===m?'var(--accent-primary)':'transparent'};
      color:${_screenerChartMode===m?'#fff':'var(--text-muted)'};cursor:pointer">${label}</button>`;

  const chartCard = `
  <div class="card" style="margin-bottom:14px">
    ${ohlcvHeader}
    <div style="display:flex;justify-content:flex-end;gap:6px;margin-bottom:8px;flex-wrap:wrap">
      ${modeBtn('candle','Candle')}${modeBtn('line','Line')}
      ${overlayBtn('bb',   'BB (20, 2)', _screenerOverlays.bb)}
      ${overlayBtn('sma50','SMA50',      _screenerOverlays.sma50)}
      ${overlayBtn('pivots','Pivots',    _screenerOverlays.pivots)}
    </div>
    <canvas id="screener-chart" style="width:100%;display:block"></canvas>
  </div>`;

  // ── Score card computation (mirrors indicators.py _score_ticker logic) ──
  const cp      = d.current_price || 0;
  const sma20   = d.sma_20 || cp;
  const sma50v  = d.sma_50 || cp;
  const rsi14   = d.rsi_14 || 50;
  const volRatio = d.volume_ratio || 1;
  const ret5d   = d.return_5d || 0;
  const pctHigh = f.pct_from_52w_high || 0;

  // Trend (0-30): price vs SMA20 + price vs SMA50 + SMA rising (proxy: price > SMA20)
  const trendPts = (cp > sma20 ? 10 : 0) + (cp > sma50v ? 10 : 0) + (d.trend_direction === 'bullish' ? 10 : 0);
  // Pullback (0-30): RSI zone + position from high
  let rsiPts = 3;
  if      (35 <= rsi14 && rsi14 <= 55) rsiPts = 15;
  else if (30 <= rsi14 && rsi14 <  35) rsiPts = 12;
  else if (55 <  rsi14 && rsi14 <= 65) rsiPts = 10;
  else if (rsi14 < 30)                 rsiPts = 5;
  let posPts = 4;
  if      (pctHigh >= -20 && pctHigh <= -5)  posPts = 15;
  else if (pctHigh >  -5  && pctHigh <= 0)   posPts = 9;
  else if (pctHigh >= -30 && pctHigh <  -20) posPts = 10;
  const pullbackPts = rsiPts + posPts;
  // Volume (0-20)
  let volPts = 5;
  if      (volRatio > 1.5) volPts = 20;
  else if (volRatio > 1.1) volPts = 15;
  else if (volRatio > 0.8) volPts = 10;
  // Momentum (0-20)
  let momPts = 5;
  if      (ret5d > 3)  momPts = 20;
  else if (ret5d > 0)  momPts = 15;
  else if (ret5d > -2) momPts = 10;

  const totalScore = trendPts + pullbackPts + volPts + momPts;
  const scoreColor = totalScore >= 70 ? '#16a34a' : totalScore >= 50 ? '#d97706' : '#94a3b8';

  const scoreRow = (label, pts, maxPts) => {
    const col = (pts / maxPts) >= 0.7 ? '#16a34a' : (pts / maxPts) >= 0.4 ? '#d97706' : '#94a3b8';
    return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:12px;color:var(--text-muted)">${label}</span>
      <div style="display:flex;align-items:center;gap:6px">
        <div style="width:80px;height:4px;background:var(--border-light);border-radius:2px;overflow:hidden">
          <div style="width:${Math.round(pts/maxPts*100)}%;height:100%;background:${col};border-radius:2px"></div>
        </div>
        <span style="font-size:12px;font-weight:600;color:${col};min-width:42px;text-align:right">${pts} / ${maxPts}</span>
      </div>
    </div>`;
  };

  const scoreCard = `
  <div class="card" style="flex:1;min-width:220px">
    <div style="font-size:11px;font-weight:700;color:var(--accent-primary);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Confluence Score Card</div>
    <div style="display:flex;align-items:baseline;gap:4px;margin-bottom:14px">
      <span style="font-size:28px;font-weight:800;color:${scoreColor}">${totalScore}</span>
      <span style="font-size:14px;color:var(--text-muted)">/&nbsp;100</span>
      <span style="margin-left:8px;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;
        background:${scoreColor}22;color:${scoreColor}">
        ${totalScore >= 70 ? 'Strong' : totalScore >= 50 ? 'Moderate' : 'Weak'}
      </span>
    </div>
    ${scoreRow('Trend setup',          trendPts,   30)}
    ${scoreRow('Pullback zone',        pullbackPts,30)}
    ${scoreRow('Volume accumulation',  volPts,     20)}
    ${scoreRow('Short mom score',      momPts,     20)}
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border-light);display:flex;justify-content:space-between">
      <span style="font-size:11px;color:var(--text-muted)">90d off high drawdown</span>
      <span style="font-size:12px;font-weight:600;color:${pctHigh >= -10 ? '#d97706' : pctHigh >= -20 ? '#16a34a' : '#94a3b8'}">
        ${pctHigh >= 0 ? '+' : ''}${fmt(pctHigh,1)}%
      </span>
    </div>
  </div>`;

  // ── Calculated Indicator Readings ──
  const iRow = (label, val, color) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px">
       <span style="font-size:12px;color:var(--text-muted)">${label}</span>
       <span style="font-size:13px;font-weight:600;color:${color||'var(--text-primary)'};">${val}</span>
     </div>`;

  const adxLabel = d.adx ? (d.adx >= 40 ? 'strong' : d.adx >= 25 ? 'trending' : 'weak') : '';
  const rsiColor = rsi14 < 35 ? '#16a34a' : rsi14 > 65 ? '#dc2626' : '#d97706';
  const adxColor = d.adx >= 40 ? '#16a34a' : d.adx >= 25 ? '#d97706' : '#94a3b8';
  const bbPctPct = d.bb_pct_b != null ? Math.round(d.bb_pct_b * 100) + '%' : 'n/a';

  const indicatorsCard = `
  <div class="card" style="flex:1;min-width:220px">
    <div style="font-size:11px;font-weight:700;color:var(--accent-primary);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Calculated Indicator Readings</div>
    ${iRow('RSI (14-day):', d.rsi_14 != null ? fmt(d.rsi_14,1) : 'n/a', rsiColor)}
    ${iRow('ADX (14-day):', d.adx != null ? fmt(d.adx,1) + (adxLabel ? ` <span style="font-size:10px;color:${adxColor}">(${adxLabel})</span>` : '') : 'n/a', adxColor)}
    ${iRow('BB %B envelope:', bbPctPct, '#94a3b8')}
    ${iRow('ATR volatility (%):', d.atr_14 != null ? `$${fmt(d.atr_14,3)} (${fmt(d.atr_pct,1)}%)` : 'n/a', '#94a3b8')}
    ${iRow('Volume Z-Score:', d.volume_z_score != null ? fmt(d.volume_z_score,2) : 'n/a',
           d.volume_z_score > 1.5 ? '#16a34a' : d.volume_z_score > 0.5 ? '#d97706' : '#94a3b8')}
    ${iRow('20d ADV liquidity:', d.adv_20 != null ? '$' + fmt(d.adv_20/1e6,1) + 'M AUD' : 'n/a', '#94a3b8')}
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border-light);display:flex;justify-content:space-between">
      <span style="font-size:11px;color:var(--text-muted)">Composite signal</span>
      <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:8px;
        background:${d.composite_signal==='BUY'?'#14532d':d.composite_signal==='SELL'?'#450a0a':'#1e293b'};
        color:${d.composite_signal==='BUY'?'#86efac':d.composite_signal==='SELL'?'#fca5a5':'#94a3b8'}">
        ${d.composite_signal || 'NEUTRAL'}
      </span>
    </div>
  </div>`;

  // ── Support / Resistance Pivots ──
  const pivRow = (label, val, color) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px">
       <span style="font-size:12px;color:var(--text-muted)">${label}</span>
       <span style="font-size:13px;font-weight:600;color:${color}">$${val != null ? fmt(val,2) : 'n/a'}</span>
     </div>`;

  const pivotsCard = `
  <div class="card" style="flex:1;min-width:200px">
    <div style="font-size:11px;font-weight:700;color:var(--accent-primary);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Support / Resistance Pivots</div>
    ${pivRow('Resistance R2:', sr.r2,    '#f87171')}
    ${pivRow('Resistance R1:', sr.r1,    '#fca5a5')}
    ${pivRow('Pivot line:',    sr.pivot, '#94a3b8')}
    ${pivRow('Support S1:',    sr.s1,    '#4ade80')}
    ${pivRow('Support S2:',    sr.s2,    '#16a34a')}
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border-light);display:flex;justify-content:space-between">
      <span style="font-size:11px;color:var(--text-muted)">Analyst target</span>
      <span style="font-size:12px;font-weight:600;color:var(--text-primary)">
        ${f.analyst_target ? '$' + fmt(f.analyst_target, 2) : 'n/a'}
        ${f.analyst_recommendation ? `<span style="font-size:10px;color:var(--text-muted);margin-left:4px">(${f.analyst_recommendation})</span>` : ''}
      </span>
    </div>
  </div>`;

  return searchBar + chartCard + `
  <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">
    ${scoreCard}${indicatorsCard}${pivotsCard}
  </div>`;
}

// Controls
function scannerSetTab(tab) {
  _scannerTab = tab;
  renderPage();
}

// Post-render init for the Compare tab embedded in the scanner
// Mirrors what renderComparePage() does as a standalone page.
function _initCompareTab() {
  if (typeof _compareTickers === 'undefined') return;
  _compareTickers.forEach((t, i) => {
    const inp = document.getElementById(`cmp-tick-${i}`);
    if (inp && t) inp.value = t;
  });
  if (_compareTickers.some(t => t) && typeof runComparison === 'function') {
    runComparison();
  }
}

function screenerSetChartMode(mode) {
  _screenerChartMode = mode;
  _updateScreenerButtons();
  _drawScreenerChart();
}

function screenerToggleOverlay(key) {
  _screenerOverlays[key] = !_screenerOverlays[key];
  _updateScreenerButtons();
  _drawScreenerChart();
}

// _updateScreenerButtons — replaces the full style string (cssText) on each toggle button
// so that active vs inactive state is always rendered correctly regardless of prior state.
// Never calls renderPage(), so the canvas element is preserved in the DOM.
function _updateScreenerButtons() {
  const base    = 'padding:3px 10px;font-size:11px;font-weight:600;border-radius:4px;cursor:pointer;';
  const active  = base + 'border:1px solid var(--accent-primary);background:var(--accent-primary);color:#fff';
  const inactive = base + 'border:1px solid var(--border-medium);background:transparent;color:var(--text-muted)';

  ['candle', 'line'].forEach(m => {
    const btn = document.getElementById(`screener-mode-${m}`);
    if (btn) btn.style.cssText = (_screenerChartMode === m) ? active : inactive;
  });
  ['bb', 'sma50', 'pivots'].forEach(key => {
    const btn = document.getElementById(`screener-ov-${key}`);
    if (btn) btn.style.cssText = _screenerOverlays[key] ? active : inactive;
  });
}

// _drawScreenerChart — draws (or retries via rAF until the canvas is in the DOM).
// Safe to call immediately after renderPage(): rAF retries until canvas.offsetWidth > 0.
function _drawScreenerChart() {
  if (!_screenerData?.chart_data?.length) return;
  const canvas = document.getElementById('screener-chart');
  if (!canvas || canvas.offsetWidth === 0) {
    requestAnimationFrame(_drawScreenerChart);   // retry next frame
    return;
  }
  // Attach crosshair event listeners once per canvas element
  if (!canvas._screenerListenersAttached) {
    canvas._screenerListenersAttached = true;
    canvas.addEventListener('mousemove',  _screenerMouseMove);
    canvas.addEventListener('mouseleave', _screenerMouseLeave);
  }
  drawCandleChart('screener-chart', _screenerData.chart_data, {
    mode:       _screenerChartMode,
    showBB:     _screenerOverlays.bb,
    showSMA50:  _screenerOverlays.sma50,
    showPivots: _screenerOverlays.pivots,
    pivots:     _screenerData.support_resistance,
    height:     320,
    hoverIdx:   _screenerHoverIdx,
  });
}

// Crosshair mouse handlers ──────────────────────────────────────────────────

function _screenerMouseMove(e) {
  if (!_screenerData?.chart_data?.length) return;
  const rect   = e.currentTarget.getBoundingClientRect();
  const mx     = e.clientX - rect.left;
  const n      = _screenerData.chart_data.length;
  const PAD_L  = 62;
  const PAD_R  = _screenerOverlays.pivots ? 80 : 8;
  const W      = rect.width;
  const chartX0 = PAD_L;
  const chartW  = W - PAD_L - PAD_R;

  if (mx < chartX0 || mx > W - PAD_R) {
    if (_screenerHoverIdx !== -1) { _screenerHoverIdx = -1; _drawScreenerChart(); }
    return;
  }
  const idx = Math.max(0, Math.min(n - 1, Math.floor((mx - chartX0) / (chartW / n))));
  if (idx !== _screenerHoverIdx) { _screenerHoverIdx = idx; _drawScreenerChart(); }
}

function _screenerMouseLeave() {
  if (_screenerHoverIdx !== -1) { _screenerHoverIdx = -1; _drawScreenerChart(); }
}

async function runScreener() {
  const input = document.getElementById('screener-input');
  const ticker = (input?.value || _screenerTicker).trim().toUpperCase().replace('.AX','');
  if (!ticker) { _screenerError = 'Enter a ticker'; renderPage(); return; }
  if (!state.serverOk) { _screenerError = 'Backend not running'; renderPage(); return; }

  _screenerTicker  = ticker;
  _screenerLoading = true;
  _screenerError   = '';
  _screenerData    = null;
  _screenerHoverIdx = -1;   // clear stale crosshair from previous ticker
  renderPage();

  try {
    const r = await fetch(`${API}/api/analyse/${ticker}`);
    if (!r.ok) { throw new Error(`${r.status} ${r.statusText}`); }
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    if (!d.chart_data?.length) throw new Error('No chart data returned');
    _screenerData = d;
    _screenerLoading = false;
    _screenerError = '';
    renderPage();
    _drawScreenerChart();  // rAF retry loop handles timing — no setTimeout needed
  } catch (e) {
    _screenerLoading = false;
    _screenerError = `⚠ ${e.message}`;
    renderPage();
  }
}

// ── Controls ──────────────────────────────────────────────────────────────────

function scannerSetUniverse(u) {
  _scannerUniverse = u;
  _scannerSector   = null;   // reset sector filter when universe changes
  renderPage();
}

// ── Saved screener presets ────────────────────────────────────────────────────

function scannerSavePreset() {
  const name = prompt('Preset name (e.g. "Oversold large-caps"):');
  if (!name || !name.trim()) return;
  const adv = parseFloat(document.getElementById('scanner-adv')?.value || 2000000);
  const excludeHoldings = document.getElementById('scanner-exclude')?.checked ?? true;
  const config = { universe: _scannerUniverse, min_adv_aud: adv, excludeHoldings };
  if (!state.savedScreeners) state.savedScreeners = [];
  const existing = state.savedScreeners.findIndex(p => p.name === name.trim());
  if (existing >= 0) {
    state.savedScreeners[existing] = { name: name.trim(), savedAt: new Date().toISOString(), config };
    toast(`Preset "${name.trim()}" updated`, 'success');
  } else {
    state.savedScreeners.push({ name: name.trim(), savedAt: new Date().toISOString(), config });
    toast(`Preset "${name.trim()}" saved`, 'success');
  }
  scheduleSave();
  renderPage();
}

function scannerLoadPreset(name) {
  const preset = (state.savedScreeners||[]).find(p => p.name === name);
  if (!preset) return;
  _scannerUniverse = preset.config.universe || 'asx200';
  _scannerSector = null;
  renderPage();
  // Apply DOM values after render
  setTimeout(() => {
    const advEl = document.getElementById('scanner-adv');
    if (advEl) advEl.value = String(preset.config.min_adv_aud || 2000000);
    const exclEl = document.getElementById('scanner-exclude');
    if (exclEl) exclEl.checked = preset.config.excludeHoldings !== false;
  }, 50);
  toast(`Loaded preset "${name}"`, 'info');
}

function scannerDeletePreset(name) {
  state.savedScreeners = (state.savedScreeners||[]).filter(p => p.name !== name);
  scheduleSave();
  renderPage();
  toast(`Preset "${name}" deleted`, 'info');
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
          if (s.stage === 'complete') {
            toast(`Scan complete — ${s.results?.length || 0} opportunities found from ${s.filtered_count} candidates`, 'success');
            if (typeof alertScanComplete === 'function') alertScanComplete(s.results || []);
          } else if (s.error) {
            toast(`Scan failed: ${s.error}`, 'error');
          }
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
  if (!state.analysisConfig) state.analysisConfig = {};
  if (!extras.includes(ticker)) {
    state.analysisConfig.extraTickers = [...extras, ticker];
  }
  watchlistAddTicker(ticker);  // also add to proper watchlist
  saveStateToDb();
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
  for (const t of tickers) {
    if (!portfolio.has(t)) watchlistAddTicker(t, '', true);
  }
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

// ============================================================
// ── FACTOR STABILITY TAB (§1.6 overfitting guard) ────────────
// ============================================================

function _buildFactorStabilityHTML() {
  const portfolioTickers = mergedPortfolio().map(h => h.ticker).join(', ');
  return `
    <div class="card section-gap">
      <div class="card-title">Factor Stability — §1.6 Overfitting Guard</div>
      <p class="text-xs text-muted" style="margin-bottom:12px">
        K-fold cross-validation of the eight <code>_score_ticker</code> signal factors.
        Each factor's Information Coefficient (rank correlation with 20-bar forward return)
        is measured in-sample and out-of-sample. Factors where OOS IC drops below 30% of
        in-sample IC, or flips sign, are flagged as potentially overfitted.
      </p>
      <div class="grid-2" style="gap:14px">
        <div class="form-row">
          <div class="form-label">Tickers to test (comma-separated)</div>
          <input type="text" id="fs-tickers" value="${escapeHTML(portfolioTickers)}"
            placeholder="CBA, BHP, TLS…" style="text-transform:uppercase">
        </div>
        <div class="form-row">
          <div class="form-label">History period</div>
          <select id="fs-period">
            <option value="1y">1 year</option>
            <option value="2y" selected>2 years</option>
            <option value="3y">3 years</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-label">K-folds</div>
          <select id="fs-folds">
            <option value="3">3 folds</option>
            <option value="5" selected>5 folds</option>
            <option value="7">7 folds</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-label">Forward return window (bars)</div>
          <select id="fs-fwd">
            <option value="10">10 days (~2 weeks)</option>
            <option value="20" selected>20 days (~1 month)</option>
            <option value="40">40 days (~2 months)</option>
          </select>
        </div>
      </div>
      <div class="flex-row mt-1" style="gap:10px;align-items:center">
        <button class="btn btn-primary" id="fs-run-btn" onclick="runFactorStability()">🔬 Run Stability Check</button>
        ${!state.serverOk ? '<span class="text-xs text-danger">⚠ Backend server required</span>'
          : '<span class="text-xs text-muted">Tests each scoring factor OOS across all supplied tickers</span>'}
      </div>
    </div>
    <div id="fs-results"></div>
  `;
}

async function runFactorStability() {
  if (!state.serverOk) { toast('Backend server required', 'error'); return; }

  const tickerStr = document.getElementById('fs-tickers').value || '';
  const tickers   = tickerStr.split(/[,\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
  const period    = document.getElementById('fs-period').value;
  const n_folds   = parseInt(document.getElementById('fs-folds').value, 10);
  const fwd       = parseInt(document.getElementById('fs-fwd').value, 10);

  if (!tickers.length) { toast('Enter at least one ticker', 'error'); return; }

  const btn = document.getElementById('fs-run-btn');
  if (btn) btn.disabled = true;

  document.getElementById('fs-results').innerHTML = `
    <div class="card"><div class="empty-state" style="padding:2rem">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <p class="text-muted mt-1">Running ${n_folds}-fold IC analysis on ${tickers.length} ticker(s)…</p>
      <p class="text-xs text-muted">Fetching ${period} of history and cross-validating factor signals</p>
    </div></div>`;

  try {
    const r   = await fetch(`${API}/api/scanner/factor-stability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers, period, n_folds, forward_bars: fwd }),
    });
    const res = await r.json();
    if (btn) btn.disabled = false;

    if (!r.ok || res.error) {
      document.getElementById('fs-results').innerHTML =
        `<div class="card"><div class="text-danger" style="padding:1rem">Error: ${escapeHTML(res.error || 'Unknown error')}</div></div>`;
      return;
    }
    document.getElementById('fs-results').innerHTML = _renderFactorStabilityResults(res);
  } catch (err) {
    if (btn) btn.disabled = false;
    document.getElementById('fs-results').innerHTML =
      `<div class="card"><div class="text-danger" style="padding:1rem">Fetch error: ${escapeHTML(err.message)}</div></div>`;
  }
}

function _renderFactorStabilityResults(res) {
  const verdictStyle = {
    stable:            { bg: '#dcfce7', color: '#15803d', label: 'Stable' },
    marginal:          { bg: '#fef9c3', color: '#854d0e', label: 'Marginal' },
    weak:              { bg: '#ffedd5', color: '#9a3412', label: 'Weak' },
    overfitted:        { bg: '#fee2e2', color: '#b91c1c', label: 'Overfitted' },
    noise:             { bg: '#f3f4f6', color: '#6b7280', label: 'Noise' },
    insufficient_data: { bg: '#f3f4f6', color: '#6b7280', label: 'No data' },
  };

  const factorLabels = {
    above_sma20:  'Price > SMA20',
    above_sma50:  'Price > SMA50',
    sma20_rising: 'SMA20 rising',
    rsi_zone:     'RSI zone (35–55)',
    pullback_pct: 'Pullback depth',
    vol_surge:    'Volume surge',
    momentum_5d:  '5-day momentum',
    momentum_20d: '20-day momentum',
  };

  const overallIC = res.overall_weighted_ic != null ? res.overall_weighted_ic.toFixed(4) : '—';
  const overallColor = res.overall_weighted_ic > 0.05 ? '#15803d' : res.overall_weighted_ic > 0 ? '#854d0e' : '#b91c1c';

  const rows = (res.factors || []).map(f => {
    const vs = verdictStyle[f.verdict] || verdictStyle.noise;
    const trainIC = f.train_ic != null ? (f.train_ic >= 0 ? '+' : '') + f.train_ic.toFixed(4) : '—';
    const testIC  = f.test_ic  != null ? (f.test_ic  >= 0 ? '+' : '') + f.test_ic.toFixed(4) : '—';
    const testColor = f.test_ic == null ? 'var(--text-muted)'
      : f.test_ic > 0.05 ? '#15803d' : f.test_ic > 0 ? 'var(--text-primary)' : '#b91c1c';
    const stability = f.stability != null ? (f.stability * 100).toFixed(0) + '%' : '—';
    const stabColor = f.stability == null ? 'var(--text-muted)'
      : f.stability >= 0.6 ? '#15803d' : f.stability >= 0.3 ? '#854d0e' : '#b91c1c';

    // IC bar: visual representation of test IC magnitude
    const barWidth = f.test_ic != null ? Math.min(100, Math.abs(f.test_ic) * 500) : 0;
    const barColor = f.test_ic != null && f.test_ic < 0 ? '#dc2626' : '#16a34a';

    return `<tr>
      <td style="font-weight:600">${escapeHTML(factorLabels[f.factor] || f.factor)}</td>
      <td style="text-align:center">
        <span style="background:var(--bg-secondary);border-radius:4px;padding:2px 8px;font-size:11px">${f.weight}pt</span>
      </td>
      <td style="text-align:right;color:var(--text-secondary)">${trainIC}</td>
      <td style="text-align:right;color:${testColor};font-weight:600">${testIC}</td>
      <td style="text-align:right;color:${stabColor}">${stability}</td>
      <td style="width:80px">
        <div style="height:8px;background:var(--bg-secondary);border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${barWidth}%;background:${barColor};border-radius:4px;transition:width 0.4s"></div>
        </div>
      </td>
      <td>
        <span style="background:${vs.bg};color:${vs.color};border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600">${vs.label}</span>
      </td>
    </tr>`;
  }).join('');

  const summaryColor = res.overfitted_count > 0 ? '#b91c1c' : res.stable_count === res.factors.length ? '#15803d' : '#854d0e';

  return `
    <div class="card section-gap" style="margin-top:16px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:14px">
        <div>
          <div class="card-title" style="margin-bottom:4px">Factor Stability Results</div>
          <div class="text-xs text-muted">${res.tickers_used.join(', ')} · ${res.n_folds} folds · ${res.forward_bars}-bar forward return</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:8px 14px;text-align:center">
            <div class="text-xs text-muted">Weighted OOS IC</div>
            <div style="font-size:16px;font-weight:700;color:${overallColor}">${overallIC}</div>
          </div>
          <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:8px 14px;text-align:center">
            <div class="text-xs text-muted">Stable</div>
            <div style="font-size:16px;font-weight:700;color:#15803d">${res.stable_count}/${res.factors.length}</div>
          </div>
          ${res.overfitted_count > 0 ? `
          <div style="background:#fee2e2;border-radius:var(--radius-md);padding:8px 14px;text-align:center">
            <div class="text-xs" style="color:#b91c1c">Overfitted</div>
            <div style="font-size:16px;font-weight:700;color:#b91c1c">${res.overfitted_count}</div>
          </div>` : ''}
        </div>
      </div>

      <div style="padding:10px 14px;border-radius:var(--radius-md);margin-bottom:14px;
        background:${res.overfitted_count > 0 ? '#fee2e2' : res.stable_count === res.factors.length ? '#dcfce7' : '#fef9c3'}">
        <span style="font-weight:600;color:${summaryColor}">${escapeHTML(res.summary)}</span>
      </div>

      <div style="overflow-x:auto">
        <table class="table table-sm" style="font-size:12px">
          <thead>
            <tr>
              <th>Factor</th>
              <th style="text-align:center">Weight</th>
              <th style="text-align:right">Train IC</th>
              <th style="text-align:right">OOS IC</th>
              <th style="text-align:right">Stability</th>
              <th style="width:80px">OOS IC</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <div class="text-xs text-muted" style="margin-top:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:var(--radius-sm);line-height:1.6">
        <strong>IC</strong> = Spearman rank correlation between factor signal and ${res.forward_bars}-day forward return.
        <strong>Stability</strong> = OOS IC / Train IC — values ≥ 60% indicate the factor survives out-of-sample.
        Negative stability means the factor <em>reverses</em> OOS — a sign of overfitting.
        <strong>Weighted OOS IC</strong> = score-point-weighted average of |OOS IC| across all factors.
        A well-calibrated scorer typically shows IC of 0.05–0.15 on a diversified ticker set.
      </div>
    </div>
  `;
}
