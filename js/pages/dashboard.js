// ============================================================
// DASHBOARD
// ============================================================

const _STALE_DAYS = 14;

function _parseDD_MM_YYYY(d) {
  if (!d) return null;
  const p = d.split('-');
  if (p.length !== 3) return null;
  return new Date(+p[2], +p[1] - 1, +p[0]);
}

function _buildStaleNudgeCard() {
  const holdings = mergedPortfolio();
  if (!holdings.length) return '';

  const stale = [];
  for (const h of holdings) {
    const recsForTicker  = state.recHistory.filter(r => r.ticker === h.ticker);
    const lastRec        = recsForTicker.sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    const tradesForTicker = state.tradeJournal.filter(t => t.ticker === h.ticker);
    const lastTrade      = tradesForTicker.sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];

    let latestDate = null;
    const recDate   = _parseDD_MM_YYYY(lastRec?.date);
    const tradeDate = _parseDD_MM_YYYY(lastTrade?.date);
    if (recDate && tradeDate) latestDate = recDate > tradeDate ? recDate : tradeDate;
    else latestDate = recDate || tradeDate;

    const daysSince = latestDate
      ? Math.floor((Date.now() - latestDate.getTime()) / 86400000)
      : null;

    if (daysSince === null || daysSince >= _STALE_DAYS) {
      stale.push({ ticker: h.ticker, sector: h.sector, daysSince });
    }
  }

  if (!stale.length) return '';

  return `
    <div class="card section-gap" style="border-left:3px solid #d97706">
      <div class="flex-between" style="margin-bottom:6px">
        <div class="card-title" style="margin:0;color:#b45309">Positions needing attention (${stale.length})</div>
        <span class="text-xs text-muted">No recommendation in ${_STALE_DAYS}+ days</span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${stale.map(s => `
          <button class="btn btn-sm" onclick="showPage('signals')"
            style="border:1px solid #fde68a;background:#fef3c7;color:#92400e;font-size:11px"
            title="${s.daysSince !== null ? s.daysSince + ' days since last rec' : 'Never analysed'}">
            ${s.ticker}
            <span style="opacity:0.7;font-size:10px;margin-left:3px">${s.daysSince !== null ? s.daysSince + 'd' : 'new'}</span>
          </button>`).join('')}
      </div>
      <div class="text-xs text-muted" style="margin-top:6px">
        Run an analysis or go to <button class="btn btn-sm" style="font-size:11px" onclick="showPage('signals')">Live Signals</button> to refresh.
      </div>
    </div>`;
}

function renderDashboard() {
  const pv=portfolioValue(), nw=totalNetWorth(), gain=totalGain(), gainPct=(gain/totalCost())*100;
  const pending=state.recommendations.filter(r=>r.status==='pending').length;
  const execRate=state.recHistory.length ? state.recHistory.filter(r=>r.executed).length/state.recHistory.length : 0;
  // ── Schedule: read from state.settings, not hardcoded ─────────────────────
  const _schedHHMM = sydneyHHMM(); // correct Sydney time string "HH:MM"
  const _nowMins   = timeToMins(_schedHHMM);
  const _ss        = state.settings;
  const _enabled   = !!_ss.scheduleEnabled;
  const _start     = _ss.scheduleWindowStart || '10:00';
  const _end       = _ss.scheduleWindowEnd   || '15:45';
  const _intv      = _ss.scheduleIntervalMins || 60;
  const _startM    = timeToMins(_start);
  const _endM      = timeToMins(_end);
  // Build slot list: start, start+intv, start+2*intv … then final = end (if not already included)
  const _slotMins  = [];
  for (let t = _startM; t < _endM; t += _intv) _slotMins.push(t);
  if (!_slotMins.includes(_endM)) _slotMins.push(_endM); // guaranteed close run
  const _schedule  = _slotMins.map(m => {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    const t  = hh + ':' + mm;
    const isFirst = m === _startM;
    const isLast  = m === _endM;
    const label   = isFirst ? 'Open' : isLast ? 'Close' : '';
    // past: slot end was before now (slot is "done"); current: slot window is now active
    const slotStartM = m;
    const nextSlotM  = _slotMins[_slotMins.indexOf(m) + 1] ?? (m + _intv);
    const past    = _nowMins > slotStartM + 2; // grace of 2 mins so "current" doesn't flicker
    const current = _nowMins >= slotStartM - 1 && _nowMins < slotStartM + 3;
    return { t, label, past, current, m };
  });
  const _lastRunMins = _ss._lastScheduledRunAt ? timeToMins(_ss._lastScheduledRunAt) : null;
  const hasLive = Object.keys(state.liveSignals).length > 0;

  return `
    ${!state.serverOk ? `<div class="info-banner">⚠ Backend server not running. Start it with: <code>python3 asx_server.py</code> — then click "Refresh Prices" for live yfinance data.</div>` : ''}
    ${renderCriticalAlertBanners()}
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Net Worth</div>
        <div class="metric-value">$${fmt(nw)}</div>
        <div class="metric-sub">Portfolio + Cash</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Portfolio Value</div>
        <div class="metric-value">$${fmt(pv)}</div>
        <div class="metric-sub ${gain>=0?'up':'down'}">${sign(gain)}$${fmt(Math.abs(gain))} (${sign(gainPct)}${fmt(Math.abs(gainPct))}%)</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Cash Available</div>
        <div class="metric-value">$${fmt(state.cash)}</div>
        <div class="metric-sub">${fmt((state.cash/nw)*100)}% of net worth · RBA ${state.rbaRate.toFixed(2)}%</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Pending Recs</div>
        <div class="metric-value">${pending}</div>
        <div class="metric-sub">Exec rate: ${fmt(execRate*100,0)}%</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">Holdings Overview</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Ticker</th><th>Sector</th><th>Value</th><th>P&L</th><th>Wt%</th>${hasLive?'<th>Signal</th>':''}</tr></thead>
            <tbody>
              ${mergedPortfolio().map(h=>{
                const val=h.shares*h.currentPrice, pl=(h.currentPrice-h.avgPrice)*h.shares, plp=((h.currentPrice-h.avgPrice)/h.avgPrice)*100;
                const sig=state.liveSignals[h.ticker];
                return `<tr>
                  <td>
                    <strong>${h.ticker}</strong>
                    ${state.criticalAlerts?.[h.ticker] && !state.criticalAlerts[h.ticker].dismissed
                      ? `<span title="${state.criticalAlerts[h.ticker].type==='single_day'?'Flash crash: '+state.criticalAlerts[h.ticker].pct.toFixed(1)+'% today':'3-day decline: '+state.criticalAlerts[h.ticker].pct.toFixed(1)+'%'}" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:#ef4444;color:#fff;font-size:9px;font-weight:700;margin-left:4px;cursor:help" onclick="event.stopPropagation()">!</span>`
                      : ''}
                  </td>
                  <td><span class="text-xs">${h.sector}</span></td>
                  <td>$${fmt(val)}</td>
                  <td class="${pl>=0?'text-success':'text-danger'}">${sign(pl)}$${fmt(Math.abs(pl))}</td>
                  <td class="text-xs">${fmt((val/pv)*100)}%</td>
                  ${hasLive?`<td>${sig&&!sig.error?actionBadge(sig.composite_signal):'<span class="text-xs text-muted">—</span>'}</td>`:''}
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        ${hasLive?`<div class="text-xs text-muted mt-1">Signals from yfinance · <button class="btn btn-sm" onclick="showPage('signals')">View full signals →</button></div>`:`<div class="text-xs text-muted mt-1">Go to Live Signals to fetch real-time technical indicators.</div>`}
      </div>
      <div class="card">
        <div class="card-title">Recent Recommendations</div>
        ${state.recHistory.filter(r=>(r.action||'').toUpperCase()!=='HOLD').slice(0,8).map(r=>`
          <div class="rec-card ${r.executed?'executed-card':'skipped-card'}" style="margin-bottom:8px">
            <div class="flex-between mb-1">
              <div class="flex-row">${actionBadge(r.action)}<strong>${r.ticker}</strong><span class="text-xs">${r.date}</span></div>
              ${statusBadge(r.executed?'executed':'skipped')}
            </div>
            <div class="flex-row">
              <div class="conf-bar"><div class="conf-fill" style="width:${r.confidence*100}%;background:${confColor(r.confidence)}"></div></div>
              <span class="text-xs">${fmt(r.confidence*100,0)}% conf</span>
              <span class="text-xs text-muted">Net: $${fmt(r.netProfit)}</span>
            </div>
          </div>`).join('')}
        <button class="btn btn-sm mt-1" onclick="showPage('recommendations')">View all &rarr;</button>
      </div>
    </div>

    ${_buildStaleNudgeCard()}

    <div class="card section-gap">
      <div class="flex-between" style="margin-bottom:8px">
        <div class="card-title" style="margin:0">Today's Analysis Schedule (Sydney)</div>
        <div class="flex-row" style="gap:8px">
          <span style="font-size:12px;color:var(--text-muted)">Now: ${_schedHHMM}</span>
          ${_enabled
            ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#dcfce7;color:#15803d;font-weight:600">● Active</span>`
            : `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg-secondary);color:var(--text-muted);font-weight:500">○ Disabled</span>`}
          <button class="btn btn-sm" onclick="showPage('settings')" style="font-size:11px">⚙ Configure</button>
        </div>
      </div>

      ${!_enabled
        ? `<div style="padding:10px 14px;border-radius:var(--radius-md);border:0.5px dashed var(--border-medium);color:var(--text-muted);font-size:12px">
            Auto-scheduler is off. Enable it in Settings → Auto-Analysis Scheduler.<br>
            <span style="font-size:11px;opacity:0.7">Configured window: ${_start} – ${_end} · every ${_intv}m · ${_ss.scheduleWeekdaysOnly?'weekdays only':'all days'}</span>
          </div>`
        : `<div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
              ${_schedule.map(s => {
                const ran = _lastRunMins != null && Math.abs(_lastRunMins - s.m) <= 2;
                return '<div class="schedule-pill ' + (s.past ? 'past' : s.current ? 'current' : '') + '" title="' + s.t + (s.label ? ' — ' + s.label : '') + '">'
                  + (ran ? '✓ ' : s.current ? '▶ ' : s.past ? '✓ ' : '')
                  + s.t
                  + (s.label ? ' <span style="opacity:0.6;font-size:10px">— ' + s.label + '</span>' : '')
                  + '</div>';
              }).join('')}
            </div>
            <div style="font-size:11px;color:var(--text-muted);display:flex;flex-wrap:wrap;gap:14px">
              <span>📅 ${_ss.scheduleWeekdaysOnly ? 'Mon–Fri only' : 'All days'}</span>
              <span>⏱ Every ${_intv < 60 ? _intv + 'min' : (_intv/60) + 'hr'}</span>
              <span>🕐 Window: ${_start} – ${_end}</span>
              ${state.analysisLastSummary ? '<span>⟳ Last run: ' + state.analysisLastSummary.time + ' ' + state.analysisLastSummary.date + '</span>' : ''}
              ${_ss.scheduleRunOnOpen ? '<span>🚀 Runs on open</span>' : ''}
            </div>
          </div>`}
    </div>

    <div class="card section-gap" id="morning-brief-card">
      <div class="flex-between" style="margin-bottom:4px">
        <div class="card-title" style="margin:0">Morning Brief</div>
        <div class="flex-row" style="gap:8px">
          ${window._morningBrief ? `<span class="text-xs text-muted">${window._morningBrief.date}</span>` : ''}
          <button class="btn btn-sm btn-primary" onclick="generateMorningBrief()" id="brief-btn">
            ${window._morningBrief ? '⟳ Refresh' : 'Generate Brief'}
          </button>
        </div>
      </div>
      ${window._morningBrief
        ? `<div style="font-size:13px;line-height:1.65;white-space:pre-wrap;color:var(--text-primary);margin-top:6px">${escapeHTML(window._morningBrief.text)}</div>`
        : `<p class="text-xs text-muted">Chain macro + regime + holdings into a concise session note. Requires an API key.</p>`}
      <div id="brief-loading" style="display:none;padding:8px 0">
        <div class="loading-dots"><span></span><span></span><span></span></div>
      </div>
    </div>
  `;
}

let _morningBriefRunning = false;

async function generateMorningBrief() {
  if (_morningBriefRunning) return;
  const btn = document.getElementById('brief-btn');
  const loading = document.getElementById('brief-loading');
  if (!btn) return;

  _morningBriefRunning = true;
  btn.disabled = true;
  btn.textContent = 'Generating…';
  if (loading) loading.style.display = 'block';

  try {
    const pv = portfolioValue(), nw = totalNetWorth();
    const merged = mergedPortfolio();
    const regime = state.currentRegime;

    const holdingLines = merged.map(h => {
      const sig = state.liveSignals[h.ticker];
      const pl = ((h.currentPrice - h.avgPrice) / h.avgPrice * 100).toFixed(1);
      return `  ${h.ticker} (${h.sector}): $${(h.shares * h.currentPrice).toFixed(0)}, P&L ${pl}%` +
        (sig ? `, RSI ${sig.rsi_14 != null ? sig.rsi_14.toFixed(0) : '?'}, score ${sig.score != null ? sig.score : '?'}` : '');
    }).join('\n');

    const macro = state.macroData;
    const macroLine = macro
      ? `ASX200: ${macro.asx200 != null ? macro.asx200.toFixed(0) : '?'}, AUD/USD: ${macro.audusd != null ? macro.audusd.toFixed(4) : '?'}, sentiment: ${macro.sentiment || '?'} (${macro.bullish != null ? macro.bullish + '% bullish' : '?'})`
      : 'No macro data — run Morning Macro first.';

    const regimeLine = regime
      ? `Regime: ${regime.regime} (${Math.round((regime.confidence || 0) * 100)}% confidence)`
      : 'Regime: unknown';

    const pendingCount = state.recommendations.filter(r => r.status === 'pending').length;
    const rbaLine = `RBA cash rate: ${state.rbaRate}%`;

    const prompt =
`Date: ${new Date().toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
${macroLine}
${regimeLine}
${rbaLine}
Portfolio: $${pv.toFixed(0)} holdings + $${state.cash.toFixed(0)} cash = $${nw.toFixed(0)} net worth
Pending recs: ${pendingCount}

Holdings:
${holdingLines || '  (none)'}

Write a morning briefing covering:
1. Market regime and macro context (1-2 sentences)
2. Key risks or events to watch today (1-2 sentences)
3. Any holdings that stand out based on their signals or recent price action (1-2 sentences)
4. One suggested focus for the session (1 sentence)`;

    const text = await callClaude('briefing', prompt);
    window._morningBrief = {
      text,
      date: new Date().toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' }),
    };
    renderPage();
  } catch (e) {
    toast('Brief failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Generate Brief'; }
    if (loading) loading.style.display = 'none';
  } finally {
    _morningBriefRunning = false;
  }
}
