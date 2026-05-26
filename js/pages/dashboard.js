// ============================================================
// DASHBOARD
// ============================================================
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
  `;
}
