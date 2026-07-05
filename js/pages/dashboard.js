// ============================================================
// DASHBOARD
// ============================================================

const _STALE_DAYS = 14;

// RBA meeting dates — fetched live from rba.gov.au via /api/rba-meetings (24h cache).
// This fallback is used only when the backend is unreachable.
let _rbaMeetings = [
  '2026-02-03', '2026-03-17', '2026-05-05', '2026-06-16',
  '2026-08-11', '2026-09-29', '2026-11-03', '2026-12-08',
  '2027-02-09', '2027-03-23', '2027-05-04', '2027-06-22',
  '2027-08-10', '2027-09-28', '2027-11-02', '2027-12-14',
];
let _rbaMeetingsFetched = false;

async function _fetchRbaMeetings() {
  if (_rbaMeetingsFetched) return;
  try {
    const res = await fetch(`${API}/api/rba-meetings`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.meetings && data.meetings.length) {
      _rbaMeetings = data.meetings;
      _rbaMeetingsFetched = true;
    }
  } catch (_) {}
}

function _buildEconomicCalendarCard() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today); horizon.setDate(horizon.getDate() + 45);

  const events = [];

  // RBA meetings
  for (const d of _rbaMeetings) {
    const dt = new Date(d);
    if (dt >= today && dt <= horizon) {
      const diffDays = Math.round((dt - today) / 86400000);
      events.push({ date: dt, label: 'RBA Board Meeting', ticker: null, type: 'rba', days: diffDays });
    }
  }

  // Portfolio ex-div dates
  mergedPortfolio().forEach(h => {
    const div = state.dividendData[h.ticker];
    if (!div?.exDividendDate) return;
    const dt = new Date(div.exDividendDate.slice(0, 10));
    if (dt >= today && dt <= horizon) {
      const diffDays = Math.round((dt - today) / 86400000);
      events.push({ date: dt, label: `${h.ticker} ex-div (~$${div.nextEstAmount != null ? div.nextEstAmount.toFixed(4) : (div.annualDivPerShare / 4).toFixed(4)}/sh)`, ticker: h.ticker, type: 'exdiv', days: diffDays });
    }
  });

  // Earnings dates from earningsCalendar
  Object.entries(state.earningsCalendar || {}).forEach(([ticker, ec]) => {
    if (!ec?.nextEarningsDate) return;
    const dt = new Date(ec.nextEarningsDate.slice(0, 10));
    if (dt >= today && dt <= horizon) {
      const diffDays = Math.round((dt - today) / 86400000);
      events.push({ date: dt, label: `${ticker} earnings`, ticker, type: 'earnings', days: diffDays });
    }
  });

  if (!events.length) return '';
  events.sort((a, b) => a.date - b.date);

  const typeStyle = {
    rba:     { bg: '#ede9fe', fg: '#6d28d9', icon: '🏦' },
    exdiv:   { bg: '#dcfce7', fg: '#15803d', icon: '💰' },
    earnings:{ bg: '#fef3c7', fg: '#b45309', icon: '📊' },
  };

  const rows = events.map(e => {
    const s = typeStyle[e.type];
    const urgency = e.days === 0 ? ' Today!' : e.days === 1 ? ' Tomorrow' : ` in ${e.days}d`;
    return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:0.5px solid var(--border-light)">
      <span style="font-size:14px">${s.icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:500">${e.label}</div>
        <div class="text-xs text-muted">${e.date.toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'})}</div>
      </div>
      <span style="background:${s.bg};color:${s.fg};border-radius:3px;padding:2px 8px;font-size:11px;font-weight:600;white-space:nowrap">${urgency}</span>
    </div>`;
  });

  return `
    <div class="card section-gap" id="econ-calendar-card">
      <div class="card-title">Upcoming Catalysts (45 days)</div>
      ${rows.join('')}
    </div>`;
}

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

function _buildCashTrackerCard() {
  const tds = state.termDeposits || [];
  const today = new Date(); today.setHours(0,0,0,0);
  const fmtAmt = v => '$' + Number(v || 0).toLocaleString('en-AU', { minimumFractionDigits: 0 });
  const deployable = tds.reduce((sum, td) => {
    if (!td.maturityDate) return sum;
    const mat = new Date(td.maturityDate);
    const days = Math.round((mat - today) / 86400000);
    return days <= 30 && days >= 0 ? sum + Number(td.amount || 0) : sum;
  }, state.cash || 0);

  const tdRows = tds.map((td, i) => {
    const mat = td.maturityDate ? new Date(td.maturityDate) : null;
    const days = mat ? Math.round((mat - today) / 86400000) : null;
    const daysLabel = days == null ? '—' : days < 0 ? '<span class="text-danger">Matured</span>' :
      days === 0 ? '<span class="text-success">Today</span>' :
      `<span class="${days<=30?'text-warning':'text-muted'}">${days}d</span>`;
    const interest = (td.rate && td.amount) ? fmtAmt(td.amount * td.rate / 100) + '/yr' : '';
    return `<tr>
      <td style="padding:4px 6px">${escapeHTML(td.label||'TD')}</td>
      <td style="padding:4px 6px;text-align:right">${fmtAmt(td.amount)}</td>
      <td style="padding:4px 6px;text-align:right">${td.rate?td.rate+'%':'—'} <span class="text-xs text-muted">${interest}</span></td>
      <td style="padding:4px 6px;text-align:center">${daysLabel}</td>
      <td style="padding:4px 6px;text-align:right">
        <button class="btn btn-sm" style="padding:1px 6px;font-size:11px" onclick="removeTD(${i})">✕</button>
      </td>
    </tr>`;
  }).join('');

  return `
    <div class="card section-gap">
      <div class="flex-between" style="margin-bottom:8px">
        <div class="card-title" style="margin:0">Cash & Term Deposits</div>
        <span class="text-xs text-muted">Deployable ≤30d: <strong style="color:var(--text-primary)">${fmtAmt(deployable)}</strong></span>
      </div>
      <div class="signal-row" style="margin-bottom:8px">
        <span>Idle cash</span>
        <strong>${fmtAmt(state.cash)}</strong>
      </div>
      ${tds.length ? `<table style="width:100%;font-size:12px;border-collapse:collapse">
        <thead><tr style="color:var(--text-muted);font-size:11px">
          <th style="text-align:left;padding:3px 6px">Label</th>
          <th style="text-align:right;padding:3px 6px">Amount</th>
          <th style="text-align:right;padding:3px 6px">Rate</th>
          <th style="text-align:center;padding:3px 6px">Matures</th>
          <th></th>
        </tr></thead>
        <tbody>${tdRows}</tbody>
      </table>` : '<p class="text-xs text-muted" style="margin:0">No term deposits recorded.</p>'}
      <details style="margin-top:10px">
        <summary class="text-xs text-muted" style="cursor:pointer">+ Add term deposit</summary>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;font-size:12px">
          <input id="td-label" placeholder="Label (e.g. CBA 6mo)" class="input-sm" style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary)">
          <input id="td-amount" type="number" placeholder="Amount ($)" class="input-sm" style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary)">
          <input id="td-rate" type="number" step="0.01" placeholder="Rate % p.a." class="input-sm" style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary)">
          <input id="td-maturity" type="date" class="input-sm" style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary)">
          <input id="td-notes" placeholder="Notes (optional)" class="input-sm" style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);grid-column:span 2">
          <button class="btn btn-sm btn-primary" style="grid-column:span 2" onclick="addTD()">Add</button>
        </div>
      </details>
    </div>`;
}

async function addTD() {
  const label = (document.getElementById('td-label')?.value || '').trim();
  const amount = parseFloat(document.getElementById('td-amount')?.value || '0');
  const rate = parseFloat(document.getElementById('td-rate')?.value || '0') || null;
  const maturityDate = document.getElementById('td-maturity')?.value || '';
  const notes = (document.getElementById('td-notes')?.value || '').trim();
  if (!label || !amount) { toast('Label and amount are required', 'error'); return; }
  if (!Array.isArray(state.termDeposits)) state.termDeposits = [];
  state.termDeposits.push({ id: Date.now(), label, amount, rate, maturityDate, notes });
  await saveStateToDb();
  renderPage();
}

async function removeTD(index) {
  if (!Array.isArray(state.termDeposits)) return;
  state.termDeposits.splice(index, 1);
  await saveStateToDb();
  renderPage();
}

// ============================================================
// OPS HEADER STRIP — Dashboard-only always-on status line
// ============================================================
// Consolidates signals already tracked elsewhere (server reachability via the
// sidebar's srv-dot/srv-label, DB status, current regime, /health last_backup)
// into one compact line at the top of the Dashboard. Deliberately reuses the
// existing 30s checkServer() heartbeat (scheduler.js) and the existing 5s
// clock tick — no new setInterval is created here. checkServer() stashes the
// raw /health JSON on state._health and calls _refreshOpsStrip() after every
// poll; the 5s clock tick calls _updateOpsStripClock(). Both are no-ops when
// the strip isn't mounted (i.e. any page other than Dashboard).

// last_backup from /health is a bare "YYYYMMDD" date string (see
// routes/market.py — backup_db() names files "<db>.bak-YYYYMMDD"). No time
// component is available, so "age" is day-granularity: "today" / "Nd ago".
function _opsBackupAge(lastBackup) {
  if (!lastBackup || lastBackup.length < 8) return 'unknown';
  const y = +lastBackup.slice(0, 4), m = +lastBackup.slice(4, 6), d = +lastBackup.slice(6, 8);
  const bakDate = new Date(y, m - 1, d);
  if (isNaN(bakDate.getTime())) return 'unknown';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today - bakDate) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function _opsRegimeBadge() {
  const regime = state.currentRegime?.regime;
  if (!regime) return '<span style="color:var(--text-tertiary)">regime: —</span>';
  const c = _REGIME_BADGE_COLORS[regime] || _REGIME_BADGE_COLORS.unknown;
  return `<span style="background:${c.bg};color:${c.fg};border-radius:3px;padding:1px 6px;font-weight:600">regime: ${regime}</span>`;
}

function _buildOpsStrip() {
  const ok = !!state.serverOk;
  const health = state._health;
  const dbOk = ok; // DB is reachable iff the server answered /health at all
  const backupAge = ok ? _opsBackupAge(health?.last_backup) : '—';
  return `
    <div id="ops-strip" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);padding:6px 10px;margin-bottom:10px;border:0.5px solid var(--border-light);border-radius:var(--radius-md, 6px);background:var(--bg-inset)">
      <span id="ops-strip-conn">${ok ? '<span style="color:#16a34a">●</span> connected' : '<span style="color:#dc2626">●</span> disconnected'}</span>
      <span id="ops-strip-regime">${_opsRegimeBadge()}</span>
      <span id="ops-strip-db">${dbOk ? '<span style="color:#16a34a">DB ok</span>' : '<span style="color:#dc2626">DB unreachable</span>'}</span>
      <span id="ops-strip-backup">backup ${escapeHTML(backupAge)}</span>
      <span id="ops-strip-clock" style="margin-left:auto;color:var(--text-tertiary)">${nowSydney()}</span>
    </div>`;
}

// Patches the strip's DOM in place after checkServer()'s 30s poll — no
// re-render of the whole Dashboard, so it's safe to call even if the user is
// mid-interaction with another card. Pure no-op off the Dashboard page.
function _refreshOpsStrip() {
  const el = document.getElementById('ops-strip');
  if (!el || state.page !== 'dashboard') return;
  el.outerHTML = _buildOpsStrip();
}

// Patches just the clock span on the existing 5s tick (scheduler.js) — avoids
// stacking a second timer purely to move a clock hand.
function _updateOpsStripClock() {
  const el = document.getElementById('ops-strip-clock');
  if (el) el.textContent = nowSydney();
}

function renderDashboard() {
  // Kick off RBA meetings fetch in background; re-render calendar card when it arrives
  _fetchRbaMeetings().then(() => {
    const cal = document.getElementById('econ-calendar-card');
    if (cal) cal.outerHTML = _buildEconomicCalendarCard() || '';
  });

  // Ops strip's regime badge needs state.currentRegime, which is otherwise only
  // populated as a side effect of running AI analysis — fetch it here so the
  // badge doesn't show "—" until the user happens to trigger a recommendation.
  if (!state.currentRegime) {
    fetchAndClassifyRegime().then(() => {
      const el = document.getElementById('ops-strip-regime');
      if (el) el.outerHTML = `<span id="ops-strip-regime">${_opsRegimeBadge()}</span>`;
    });
  }

  // Paper/real view mode (gotcha #88) — same toggle as the Portfolio page,
  // driving the SAME state.portfolioViewMode. The portfolio math helpers
  // (portfolioValue/totalNetWorth/totalGain/totalCost/viewCash/mergedPortfolio)
  // already narrow to the active mode, so the cards + holdings table below react
  // to the toggle automatically.
  const _vm = state.portfolioViewMode || 'all';
  const _hasPaper = (state.portfolio || []).some(h => (h.mode||'paper') !== 'real')
    || (Number(state.paperCash) || 0) > 0;

  const pv=portfolioValue(), nw=totalNetWorth(), gain=totalGain(), gainPct=(gain/totalCost())*100;
  const _cash = viewCash();
  // Live/paper split annotation on Net Worth — only meaningful in the combined
  // 'all' view. Real = real portfolio + real cash; paper = paper holdings mkt
  // value (no cash, gotcha #88).
  const _rnw = realNetWorth();
  const _paperPv = paperPortfolioValue();
  const _hasPaperNw = _vm === 'all' && (_paperPv > 0.005);
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
    ${_buildOpsStrip()}
    ${!state.serverOk ? `<div class="info-banner">⚠ Backend server not running. Start it with: <code>python3 asx_server.py</code> — then click "Refresh Prices" for live yfinance data.</div>` : ''}
    ${renderCriticalAlertBanners()}
    ${_hasPaper ? (()=>{
      const _VM_LABELS = { all:'All', real:'● Live only', paper:'◦ Paper only' };
      return `<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;align-items:center">
        <span class="text-xs text-muted" style="margin-right:2px">Trade mode:</span>
        ${['all','real','paper'].map(m => `
          <button class="btn btn-sm" style="${m===_vm?'background:var(--accent-primary);color:#fff;border-color:var(--accent-primary)':''}" onclick="state.portfolioViewMode='${m}';renderPage()">${_VM_LABELS[m]}</button>
        `).join('')}
        <span class="text-xs text-muted" style="align-self:center;margin-left:4px">Paper trades are simulated — excluded from CGT/EOFY, real cash &amp; real performance.</span>
      </div>`;
    })() : ''}
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Net Worth${_vm!=='all'?` <span class="text-xs text-muted">(${_vm==='real'?'live':'paper'})</span>`:''}</div>
        <div class="metric-value">$${fmt(nw)}</div>
        <div class="metric-sub">${_hasPaperNw ? `● live $${fmt(_rnw)} · ◦ paper $${fmt(_paperPv)}` : _vm==='paper' ? 'Paper holdings (no cash)' : 'Portfolio + Cash'}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Portfolio Value</div>
        <div class="metric-value">$${fmt(pv)}</div>
        <div class="metric-sub ${gain>=0?'up':'down'}">${sign(gain)}$${fmt(Math.abs(gain))} (${sign(gainPct)}${fmt(Math.abs(gainPct))}%)</div>
      </div>
      ${_vm==='paper' ? `
      <div class="metric-card">
        <div class="metric-label">Positions</div>
        <div class="metric-value">${mergedPortfolio().length}</div>
        <div class="metric-sub">Paper book — no cash concept</div>
      </div>` : `
      <div class="metric-card">
        <div class="metric-label">Cash Available</div>
        <div class="metric-value">$${fmt(_cash)}</div>
        <div class="metric-sub">${fmt(nw>0?(_cash/nw)*100:0)}% of net worth · RBA ${state.rbaRate.toFixed(2)}%</div>
      </div>`}
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

    ${_buildEconomicCalendarCard()}
    ${_buildCashTrackerCard()}
  `;
}
