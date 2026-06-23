// ============================================================
// WATCHLIST PAGE
// ============================================================

function renderWatchlistPage(gen) {
  const el = document.getElementById('main-content');
  el.innerHTML = _buildWatchlistHTML();
  setTimeout(() => { if (state._renderGen === gen) _drawWatchlistSparklines(); }, 50);
  _loadWatchlistSignals(gen);
}

// Draw the inline 30-day trend sparkline for every watchlist row that has
// chart_data loaded. Canvases must exist in the DOM first (render-then-draw,
// same two-step pattern as drawCandleChart/_sigChartDraw in pages/signals.js).
function _drawWatchlistSparklines() {
  (state.watchlist || []).forEach(item => {
    const sig = state.liveSignals && state.liveSignals[item.ticker];
    if (!sig || !sig.chart_data?.length) return;
    const canvas = document.getElementById(`wl-spark-${item.ticker}`);
    if (!canvas) return;
    const closes = sig.chart_data.slice(-30).map(d => d.close);
    _drawSparkline(canvas, closes);
  });
}

function _buildWatchlistHTML() {
  const wl = state.watchlist || [];
  return `
    <div class="card section-gap">
      <div class="flex-between" style="margin-bottom:1rem">
        <div class="card-title" style="margin:0">Watchlist</div>
        <div class="text-xs text-muted">${wl.length} ticker${wl.length !== 1 ? 's' : ''} · monitor without holding</div>
      </div>
      <div class="flex-row" style="gap:8px;margin-bottom:1rem">
        <input type="text" id="wl-ticker-input" placeholder="Ticker (e.g. WDS)"
          style="padding:6px 10px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:13px;width:120px;font-family:var(--font);text-transform:uppercase"
          oninput="this.value=this.value.toUpperCase()"
          onkeydown="if(event.key==='Enter')watchlistAdd()">
        <input type="text" id="wl-notes-input" placeholder="Notes (optional)"
          style="padding:6px 10px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:13px;flex:1;font-family:var(--font)"
          onkeydown="if(event.key==='Enter')watchlistAdd()">
        <button class="btn btn-sm btn-primary" onclick="watchlistAdd()">+ Add</button>
      </div>
      ${wl.length === 0 ? `
        <div class="empty-state" style="padding:2rem">
          <div class="empty-icon">⭐</div>
          <p>Your watchlist is empty.</p>
          <p class="sub">Add tickers you're watching but don't hold — live signals load automatically. You can also add from the Market Scanner via the ⭐ button.</p>
        </div>
      ` : `
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="border-bottom:0.5px solid var(--border-medium)">
              <th style="text-align:left;padding:6px 10px;color:var(--text-secondary);font-weight:600">Ticker</th>
              <th style="text-align:left;padding:6px 10px;color:var(--text-secondary);font-weight:600">Notes</th>
              <th style="text-align:right;padding:6px 10px;color:var(--text-secondary);font-weight:600">Price</th>
              <th style="text-align:center;padding:6px 10px;color:var(--text-secondary);font-weight:600">RSI</th>
              <th style="text-align:center;padding:6px 10px;color:var(--text-secondary);font-weight:600">Score</th>
              <th style="text-align:center;padding:6px 10px;color:var(--text-secondary);font-weight:600">BB%B</th>
              <th style="text-align:center;padding:6px 10px;color:var(--text-secondary);font-weight:600">Trend</th>
              <th style="text-align:center;padding:6px 10px;color:var(--text-secondary);font-weight:600">30d</th>
              <th style="padding:6px 10px"></th>
            </tr></thead>
            <tbody id="watchlist-rows">
              ${wl.map(item => _watchlistRow(item)).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
    ${wl.length > 0 ? `
    <div class="card" style="margin-top:1rem">
      <div class="card-title">Set Indicator Alerts</div>
      <div class="text-xs text-muted" style="margin-bottom:12px">Fire a notification when a technical condition is met for any watchlist ticker.</div>
      <div class="flex-row" style="gap:8px;flex-wrap:wrap">
        <select id="ind-alert-ticker" style="padding:6px 10px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;font-family:var(--font)">
          ${[...new Set([...(state.watchlist||[]).map(w=>w.ticker), ...state.portfolio.map(h=>h.ticker)])].sort().map(t=>`<option value="${t}">${t}</option>`).join('')}
        </select>
        <select id="ind-alert-type" style="padding:6px 10px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;font-family:var(--font)" onchange="watchlistAlertTypeChange()">
          <option value="rsi_below">RSI below</option>
          <option value="rsi_above">RSI above</option>
          <option value="bb_breakout">BB breakout (price ≥ upper)</option>
          <option value="bb_breakdown">BB breakdown (price ≤ lower)</option>
          <option value="volume_spike">Volume spike (×avg)</option>
        </select>
        <input type="number" id="ind-alert-value" value="30" min="0" step="1"
          style="padding:6px 10px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:13px;width:80px;font-family:var(--font)"
          placeholder="Value">
        <button class="btn btn-sm btn-primary" onclick="watchlistAddIndicatorAlert()">+ Set Alert</button>
      </div>
      ${(state.priceAlerts||[]).filter(a=>['rsi_below','rsi_above','bb_breakout','bb_breakdown','volume_spike'].includes(a.type)).length > 0 ? `
        <div style="margin-top:12px">
          <div class="text-xs text-muted" style="margin-bottom:6px">Active indicator alerts:</div>
          ${(state.priceAlerts||[]).filter(a=>['rsi_below','rsi_above','bb_breakout','bb_breakdown','volume_spike'].includes(a.type)).map(a=>`
            <div class="flex-between" style="padding:6px 0;border-bottom:0.5px solid var(--border-light);font-size:12px">
              <span><strong>${a.ticker}</strong> · ${_indAlertLabel(a)} ${a.value != null ? a.value : ''}</span>
              <div class="flex-row" style="gap:6px">
                ${a.triggeredAt ? `<span class="badge badge-executed">Fired ${a.triggeredAt.slice(0,10)}</span><button class="btn btn-sm" onclick="rearmPriceAlert('${a.id}')">Re-arm</button>` : '<span class="badge badge-pending">Active</span>'}
                <button class="btn btn-sm btn-danger" onclick="deletePriceAlert('${a.id}')">✕</button>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>` : ''}
  `;
}

function _indAlertLabel(a) {
  switch (a.type) {
    case 'rsi_below':    return 'RSI ≤';
    case 'rsi_above':    return 'RSI ≥';
    case 'bb_breakout':  return 'Price ≥ BB upper';
    case 'bb_breakdown': return 'Price ≤ BB lower';
    case 'volume_spike': return 'Volume ≥';
    default: return a.type;
  }
}

function watchlistAlertTypeChange() {
  const type = document.getElementById('ind-alert-type')?.value;
  const valEl = document.getElementById('ind-alert-value');
  if (!valEl) return;
  if (type === 'rsi_below') { valEl.value = '30'; valEl.placeholder = 'RSI level'; }
  else if (type === 'rsi_above') { valEl.value = '70'; valEl.placeholder = 'RSI level'; }
  else if (type === 'bb_breakout' || type === 'bb_breakdown') { valEl.value = ''; valEl.placeholder = 'n/a'; }
  else if (type === 'volume_spike') { valEl.value = '2'; valEl.placeholder = '× avg'; }
}

function watchlistAddIndicatorAlert() {
  const ticker = document.getElementById('ind-alert-ticker')?.value;
  const type   = document.getElementById('ind-alert-type')?.value;
  const valStr = document.getElementById('ind-alert-value')?.value;
  if (!ticker || !type) { toast('Select ticker and alert type', 'error'); return; }
  const value = (type === 'bb_breakout' || type === 'bb_breakdown') ? 0 : parseFloat(valStr);
  if ((type !== 'bb_breakout' && type !== 'bb_breakdown') && isNaN(value)) {
    toast('Enter a valid threshold value', 'error'); return;
  }
  if (!state.priceAlerts) state.priceAlerts = [];
  state.priceAlerts.push({
    id: 'ind-' + Date.now(),
    ticker,
    type,
    value,
    referencePrice: null,
    active: true,
    createdAt: new Date().toISOString(),
    triggeredAt: null,
    lastPrice: null,
  });
  scheduleSave();
  toast(`Indicator alert set for ${ticker}`, 'success');
  renderPage();
}

function _watchlistRow(item) {
  const sig = state.liveSignals && state.liveSignals[item.ticker];
  const rsi   = sig ? sig.rsi_14 : null;
  const score = sig ? sig.score  : null;
  const bb    = sig ? sig.bb_pct_b : null;
  const price = sig ? sig.current_price : null;
  const ret1d = sig ? sig.return_1d : null;
  const trend = sig ? sig.trend_direction : null;

  const rsiColor   = rsi  == null ? 'var(--text-muted)' : rsi < 30 ? '#16a34a' : rsi > 70 ? '#dc2626' : 'var(--text-primary)';
  const scoreColor = score == null ? 'var(--text-muted)' : score >= 75 ? '#16a34a' : score >= 50 ? '#f59e0b' : '#dc2626';
  const trendBadge = trend == null ? '' :
    trend === 'bullish' ? '<span style="color:#16a34a;font-size:11px">▲ bullish</span>' :
    trend === 'bearish' ? '<span style="color:#dc2626;font-size:11px">▼ bearish</span>' :
                          '<span style="color:var(--text-muted);font-size:11px">→ neutral</span>';

  return `<tr style="border-bottom:0.5px solid var(--border-light)">
    <td style="padding:8px 10px">
      <strong>${item.ticker}</strong>
      ${item.addedAt ? `<div class="text-xs text-muted">${item.addedAt.slice(0,10)}</div>` : ''}
    </td>
    <td style="padding:8px 10px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);font-size:12px">${item.notes || ''}</td>
    <td style="padding:8px 10px;text-align:right">
      ${price != null ? `<div style="font-weight:600">$${fmt(price)}</div>` : '<div class="text-muted">—</div>'}
      ${ret1d != null ? `<div class="text-xs ${ret1d >= 0 ? 'text-success' : 'text-danger'}">${ret1d >= 0 ? '+' : ''}${fmt(ret1d)}%</div>` : ''}
    </td>
    <td style="padding:8px 10px;text-align:center;font-weight:600;color:${rsiColor}">${rsi != null ? rsi.toFixed(0) : '—'}</td>
    <td style="padding:8px 10px;text-align:center;font-weight:600;color:${scoreColor}">${score != null ? score.toFixed(0) : '—'}</td>
    <td style="padding:8px 10px;text-align:center">${bb != null ? fmt(bb * 100, 0) + '%' : '—'}</td>
    <td style="padding:8px 10px;text-align:center">${trendBadge}</td>
    <td style="padding:8px 10px;text-align:center">
      ${sig && sig.chart_data?.length > 1
        ? `<canvas id="wl-spark-${item.ticker}" width="80" height="24" style="width:80px;height:24px;display:inline-block;vertical-align:middle"></canvas>`
        : '<span class="text-xs text-muted">—</span>'}
    </td>
    <td style="padding:8px 10px;text-align:right;white-space:nowrap">
      ${sig
        ? `<button class="btn btn-sm" onclick="showPage('signals')" title="View signals">◇</button>`
        : `<button class="btn btn-sm" onclick="watchlistFetchSignal('${item.ticker}')" title="Fetch signals">⟳</button>`}
      <button class="btn btn-sm" onclick="compareFromWatchlist('${item.ticker}')" title="Open in side-by-side Compare" style="margin-left:4px">&#8644;</button>
      <button class="btn btn-sm btn-danger" onclick="watchlistRemove('${item.ticker}')" title="Remove" style="margin-left:4px">&#10005;</button>
    </td>
  </tr>`;
}

async function _loadWatchlistSignals(gen) {
  const wl = state.watchlist || [];
  if (!wl.length || !state.serverOk) return;
  try {
    await fetchSignals(wl.map(w => w.ticker));
    if (state._renderGen !== gen) return;
    const tbody = document.getElementById('watchlist-rows');
    if (tbody) tbody.innerHTML = (state.watchlist || []).map(item => _watchlistRow(item)).join('');
    setTimeout(() => { if (state._renderGen === gen) _drawWatchlistSparklines(); }, 50);
  } catch {}
}

function watchlistAdd() {
  const tickerEl = document.getElementById('wl-ticker-input');
  const notesEl  = document.getElementById('wl-notes-input');
  if (!tickerEl) return;
  const ticker = tickerEl.value.trim().toUpperCase();
  const notes  = notesEl ? notesEl.value.trim() : '';
  if (!ticker) { toast('Enter a ticker', 'error'); return; }
  if (!state.watchlist) state.watchlist = [];
  if (state.watchlist.find(w => w.ticker === ticker)) {
    toast(`${ticker} is already on your watchlist`, 'info'); return;
  }
  state.watchlist.push({ ticker, addedAt: new Date().toISOString(), notes });
  if (tickerEl) tickerEl.value = '';
  if (notesEl)  notesEl.value  = '';
  scheduleSave();
  renderPage();
  toast(`${ticker} added to watchlist`, 'success');
}

function watchlistRemove(ticker) {
  state.watchlist = (state.watchlist || []).filter(w => w.ticker !== ticker);
  scheduleSave();
  renderPage();
  toast(`${ticker} removed from watchlist`, 'info');
}

async function watchlistFetchSignal(ticker) {
  toast(`Fetching signals for ${ticker}…`, 'info');
  try {
    await fetchSignals([ticker], true);
    renderPage();
  } catch (e) {
    toast(`Signal fetch failed: ${e.message}`, 'error');
  }
}

// Open this ticker in the Compare page, pre-filling it as Ticker 1
function compareFromWatchlist(ticker) {
  if (typeof compareFromOutside === 'function') {
    // Carry the full watchlist (up to 4) so the user can quickly compare them
    const others = (state.watchlist || [])
      .filter(w => w.ticker !== ticker)
      .map(w => w.ticker)
      .slice(0, 3);
    compareFromOutside([ticker, ...others]);
  } else {
    showPage('compare');
  }
}

// Called by scanner to add to the proper watchlist (silent = suppress per-ticker toast)
function watchlistAddTicker(ticker, notes = '', silent = false) {
  if (!ticker) return;
  ticker = ticker.toUpperCase().trim();
  if (!state.watchlist) state.watchlist = [];
  if (state.watchlist.find(w => w.ticker === ticker)) {
    if (!silent) toast(`${ticker} already on watchlist`, 'info');
    return;
  }
  state.watchlist.push({ ticker, addedAt: new Date().toISOString(), notes });
  scheduleSave();
  if (!silent) toast(`${ticker} added to watchlist`, 'success');
}
