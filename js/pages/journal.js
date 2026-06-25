// ============================================================
// JOURNAL
// ============================================================

const _REGIME_BADGE_COLORS = {
  riskOn:    { bg: '#dcfce7', fg: '#15803d' },
  riskOff:   { bg: '#fef3c7', fg: '#b45309' },
  panic:     { bg: '#fee2e2', fg: '#b91c1c' },
  highVol:   { bg: '#fef3c7', fg: '#d97706' },
  trend:     { bg: '#dbeafe', fg: '#1d4ed8' },
  sideways:  { bg: '#f1f5f9', fg: '#475569' },
  unknown:   { bg: '#f1f5f9', fg: '#6b7280' },
};

function _journalRegimeBadge(regime) {
  if (!regime) return '<span class="text-xs text-muted">—</span>';
  const c = _REGIME_BADGE_COLORS[regime] || _REGIME_BADGE_COLORS.unknown;
  return `<span style="background:${c.bg};color:${c.fg};border-radius:3px;padding:1px 5px;font-size:10px;font-weight:600;white-space:nowrap">${regime}</span>`;
}

// "FROM REC?" provenance badge — distinguishes regular AI Recommendations from
// Day Trading / Intraday recs from purely manual or imported trades.
// t.recId non-null => AI-sourced; which recHistory the id resolves against tells us
// whether it came from the regular portfolio Recommendations flow or the Day Trading /
// Intraday flow. Manual/imported trades have recId === null.
function _journalProvenanceBadge(t) {
  if (!t.recId) {
    return '<span class="badge badge-skipped" title="Manually entered or CSV-imported trade — no linked AI recommendation">✋ Manual</span>';
  }
  const inRecHistory = (state.recHistory || []).some(r => r.id === t.recId);
  const inDayTrading  = !inRecHistory && (
    (state.dayTrading?.recommendations || []).some(r => r.id === t.recId) ||
    (state.intraday?.recommendations   || []).some(r => r.id === t.recId)
  );
  const execLabel = t.recExecuted ? 'Yes' : 'No';
  if (inDayTrading) {
    return `<span class="badge ${t.recExecuted?'badge-executed':'badge-skipped'}" title="From Day Trading / Intraday recommendation — executed: ${execLabel}">📈 Day Trade</span>`;
  }
  // Default to the regular AI Recommendations flow (covers both resolved matches and
  // legacy rows whose parent rec has since been pruned from recHistory).
  return `<span class="badge ${t.recExecuted?'badge-executed':'badge-skipped'}" title="From AI Recommendations — executed: ${execLabel}">🤖 AI</span>`;
}

function renderJournal() {
  // ── Initialise filter state (matches recHistoryFilter shape) ──────────────
  // Migrate old shape {type,value} or missing fields to current shape
  if (!state.journalFilter || !('ticker' in state.journalFilter)) {
    state.journalFilter = {ticker:'',action:'all',status:'all',pnl:'all',dateFrom:'',dateTo:'',sortBy:'date_desc'};
  }
  const jf = state.journalFilter;

  // ── Apply filters ──────────────────────────────────────────────────────────
  let filtered = state.tradeJournal.slice();

  if (jf.ticker) filtered = filtered.filter(t => t.ticker && t.ticker.includes(jf.ticker.toUpperCase()));
  if (jf.action !== 'all') filtered = filtered.filter(t => (t.action||'').toUpperCase() === jf.action);
  if (jf.status !== 'all') filtered = filtered.filter(t => t.status === jf.status);
  if (jf.pnl === 'winners') filtered = filtered.filter(t => t.pnl != null && t.pnl > 0);
  if (jf.pnl === 'losers')  filtered = filtered.filter(t => t.pnl != null && t.pnl < 0);
  if (jf.pnl === 'open')    filtered = filtered.filter(t => t.status === 'open' || t.status === 'trimmed');
  if (jf.dateFrom) {
    filtered = filtered.filter(t => {
      if (!t.date) return false;
      const [dd,mm,yyyy] = t.date.split('-');
      return `${yyyy}-${mm}-${dd}` >= jf.dateFrom;
    });
  }
  if (jf.dateTo) {
    filtered = filtered.filter(t => {
      if (!t.date) return false;
      const [dd,mm,yyyy] = t.date.split('-');
      return `${yyyy}-${mm}-${dd}` <= jf.dateTo;
    });
  }

  // ── Sort ───────────────────────────────────────────────────────────────────
  // Dates are stored as DD-MM-YYYY; convert to YYYY-MM-DD for correct chronological order.
  const _jDateKey = d => { if (!d) return ''; const p = d.split('-'); return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : d; };
  if (jf.sortBy === 'date_desc')  filtered.sort((a,b) => _jDateKey(b.date).localeCompare(_jDateKey(a.date)));
  if (jf.sortBy === 'date_asc')   filtered.sort((a,b) => _jDateKey(a.date).localeCompare(_jDateKey(b.date)));
  if (jf.sortBy === 'pnl_desc')   filtered.sort((a,b) => (b.pnl||0) - (a.pnl||0));
  if (jf.sortBy === 'pnl_asc')    filtered.sort((a,b) => (a.pnl||0) - (b.pnl||0));

  // ── Summary stats of filtered set ─────────────────────────────────────────
  const closed     = filtered.filter(t => t.status === 'closed');
  const totalPnL   = closed.reduce((s,t) => s + (t.pnl||0), 0);
  const totalFees  = filtered.reduce((s,t) => s + (Number(t.fees)||0), 0);
  const wins       = closed.filter(t => (t.pnl||0) > 0).length;
  const losses     = closed.filter(t => (t.pnl||0) < 0).length;
  const winRate    = (wins + losses) > 0 ? (wins / (wins + losses) * 100) : null;

  // Quick-filter tickers
  const allTickers = [...new Set(state.tradeJournal.map(t => t.ticker))].filter(Boolean).sort();

  const hasFilters = jf.ticker || jf.action !== 'all' || jf.status !== 'all' ||
                     jf.pnl !== 'all' || jf.dateFrom || jf.dateTo;

  const selStyle = `style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-secondary);color:var(--text-primary);font-size:12px;font-family:var(--font)"`;

  return `
    <!-- Top action bar -->
    <div class="flex-between section-gap">
      <div class="flex-row">
        <span class="text-sm text-muted">Realised P&L: <strong class="${totalPnL>=0?'text-success':'text-danger'}">${sign(totalPnL)}$${fmt(Math.abs(totalPnL))}</strong></span>
        <span class="text-sm text-muted">Fees: <strong>$${fmt(totalFees)}</strong></span>
        ${winRate !== null ? `<span class="text-sm text-muted">Win rate: <strong class="${winRate>=50?'text-success':'text-danger'}">${fmt(winRate,0)}%</strong> <span class="text-xs">(${wins}W / ${losses}L)</span></span>` : ''}
        <span class="text-xs text-muted">${filtered.length} of ${state.tradeJournal.length} trades</span>
      </div>
      <div class="flex-row">
        <button class="btn btn-sm" onclick="addManualTrade()">+ Log Trade</button>
        <button class="btn btn-sm" onclick="manualReconcile()" title="Auto-create missing CGT parcels">⟳ Reconcile</button>
        <button class="btn btn-sm btn-primary" onclick="exportCSV()">↓ Export CSV</button>
      </div>
    </div>

    ${_buildMonthlyPnlCard()}

    <!-- Filter bar (matches rec history style) -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.6px">Filters</div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="text-xs text-muted">${filtered.length} of ${state.tradeJournal.length} shown</span>
          ${hasFilters ? `<button class="btn btn-sm" onclick="resetJournalFilter()">✕ Clear filters</button>` : ''}
        </div>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
        <!-- Ticker search -->
        <div>
          <div class="form-label" style="margin-bottom:3px">Ticker</div>
          <input type="text" placeholder="e.g. CBA" value="${jf.ticker}"
            oninput="setJournalFilterKey('ticker', this.value.toUpperCase())"
            style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:12px;width:80px">
        </div>
        <!-- Action -->
        <div>
          <div class="form-label" style="margin-bottom:3px">Action</div>
          <select onchange="setJournalFilterKey('action', this.value)" ${selStyle}>
            <option value="all"    ${jf.action==='all'   ?'selected':''}>All actions</option>
            <option value="BUY"    ${jf.action==='BUY'   ?'selected':''}>BUY</option>
            <option value="SELL"   ${jf.action==='SELL'  ?'selected':''}>SELL</option>
            <option value="TOP_UP" ${jf.action==='TOP_UP'?'selected':''}>TOP_UP</option>
            <option value="TRIM"   ${jf.action==='TRIM'  ?'selected':''}>TRIM</option>
            <option value="DRP"        ${jf.action==='DRP'       ?'selected':''}>DRP</option>
            <option value="RECLASSIFY" ${jf.action==='RECLASSIFY'?'selected':''}>Reclassify</option>
          </select>
        </div>
        <!-- Status -->
        <div>
          <div class="form-label" style="margin-bottom:3px">Status</div>
          <select onchange="setJournalFilterKey('status', this.value)" ${selStyle}>
            <option value="all"     ${jf.status==='all'    ?'selected':''}>All</option>
            <option value="open"    ${jf.status==='open'   ?'selected':''}>Open</option>
            <option value="trimmed" ${jf.status==='trimmed'?'selected':''}>Trimmed</option>
            <option value="closed"  ${jf.status==='closed' ?'selected':''}>Closed</option>
          </select>
        </div>
        <!-- P&L outcome -->
        <div>
          <div class="form-label" style="margin-bottom:3px">Outcome</div>
          <select onchange="setJournalFilterKey('pnl', this.value)" ${selStyle}>
            <option value="all"     ${jf.pnl==='all'    ?'selected':''}>All outcomes</option>
            <option value="winners" ${jf.pnl==='winners'?'selected':''}>Winners ✓</option>
            <option value="losers"  ${jf.pnl==='losers' ?'selected':''}>Losers ✗</option>
            <option value="open"    ${jf.pnl==='open'   ?'selected':''}>Open positions</option>
          </select>
        </div>
        <!-- Date from -->
        <div>
          <div class="form-label" style="margin-bottom:3px">From</div>
          <input type="date" value="${jf.dateFrom}" onchange="setJournalFilterKey('dateFrom', this.value)"
            style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:12px">
        </div>
        <!-- Date to -->
        <div>
          <div class="form-label" style="margin-bottom:3px">To</div>
          <input type="date" value="${jf.dateTo}" onchange="setJournalFilterKey('dateTo', this.value)"
            style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:12px">
        </div>
        <!-- Sort -->
        <div>
          <div class="form-label" style="margin-bottom:3px">Sort by</div>
          <select onchange="setJournalFilterKey('sortBy', this.value)" ${selStyle}>
            <option value="date_desc" ${jf.sortBy==='date_desc'?'selected':''}>Newest first</option>
            <option value="date_asc"  ${jf.sortBy==='date_asc' ?'selected':''}>Oldest first</option>
            <option value="pnl_desc"  ${jf.sortBy==='pnl_desc' ?'selected':''}>Best P&L first</option>
            <option value="pnl_asc"   ${jf.sortBy==='pnl_asc'  ?'selected':''}>Worst P&L first</option>
          </select>
        </div>
      </div>

      <!-- Quick-filter ticker chips -->
      ${allTickers.length > 0 ? `
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:10px;padding-top:10px;border-top:0.5px solid var(--border-light)">
        <span class="text-xs text-muted" style="white-space:nowrap;padding-top:3px">Quick:</span>
        <button class="btn btn-sm ${!jf.ticker?'btn-primary':''}" style="font-size:11px;padding:2px 8px" onclick="setJournalFilterKey('ticker','')">All</button>
        ${allTickers.map(t => `<button class="btn btn-sm ${jf.ticker===t?'btn-primary':''}" style="font-size:11px;padding:2px 8px" onclick="setJournalFilterKey('ticker','${t}')">${t}</button>`).join('')}
      </div>` : ''}
    </div>

    <!-- Stats row (only when filtered set has data) -->
    ${filtered.length > 0 ? `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md);font-size:12px">
        <span class="text-muted">Closed</span> <strong>${closed.length}</strong>
      </div>
      <div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md);font-size:12px">
        <span class="text-muted">Won</span> <strong class="text-success">${wins}</strong>
      </div>
      <div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md);font-size:12px">
        <span class="text-muted">Lost</span> <strong class="text-danger">${losses}</strong>
      </div>
      ${winRate !== null ? `
      <div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md);font-size:12px">
        <span class="text-muted">Win rate</span> <strong class="${winRate>=50?'text-success':'text-danger'}">${fmt(winRate,0)}%</strong>
      </div>` : ''}
      <div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md);font-size:12px">
        <span class="text-muted">Net P&L</span>
        <strong class="${totalPnL>=0?'text-success':'text-danger'}">${totalPnL>=0?'+':''}$${fmt(Math.abs(totalPnL))}</strong>
      </div>
      <div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md);font-size:12px">
        <span class="text-muted">Fees</span> <strong>$${fmt(totalFees)}</strong>
      </div>
      <div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md);font-size:12px">
        <span class="text-muted">Net after fees</span>
        <strong class="${(totalPnL-totalFees)>=0?'text-success':'text-danger'}">${(totalPnL-totalFees)>=0?'+':''}$${fmt(Math.abs(totalPnL-totalFees))}</strong>
      </div>
    </div>` : ''}

    <!-- Trade table -->
    <div class="card">
      ${filtered.length === 0 ? `
        <div class="empty-state" style="padding:2rem">
          <div class="empty-icon">▣</div>
          <p>${state.tradeJournal.length === 0 ? 'No trades logged yet.' : 'No trades match your filters.'}</p>
          ${hasFilters ? `<button class="btn btn-sm mt-1" onclick="resetJournalFilter()">Clear filters</button>` : `<button class="btn btn-sm mt-1" onclick="addManualTrade()">+ Log first trade</button>`}
        </div>
      ` : `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Date</th><th>Time</th><th>Ticker</th><th>Action</th>
            <th>Qty</th><th>Entry</th><th>Exit</th><th>Fees</th>
            <th>Gross P&L</th><th>Status</th><th>Parcel</th><th>FROM REC?</th><th>Regime</th><th></th>
          </tr></thead>
          <tbody>
            ${filtered.map(t => {
              const pnl = t.pnl != null ? t.pnl : (t.exitPrice
                ? (t.action==='BUY' ? (t.exitPrice-t.entryPrice)*t.qty : (t.entryPrice-t.exitPrice)*t.qty) - t.fees
                : null);
              const realIdx = state.tradeJournal.indexOf(t);
              // t.parcel (e.g. "P#12" or "P#12-1") is set on disposal-slice rows
              // created by buildDisposalJournalEntries() — one row per parcel
              // actually matched, so this is the precise originating lot, not
              // just a "N lots consumed" count. Legacy rows (pre-dating this)
              // fall back to the old aggregate rendering.
              const parcelBadge = t.parcel
                ? `<span class="badge badge-executed" title="${escapeHTML(t.parcel)}">${escapeHTML(t.parcel)}</span>`
                : (t.action === 'SELL' || t.action === 'TRIM')
                  ? (t.disposalIds && t.disposalIds.length
                      ? `<span class="badge badge-executed" title="${t.disposalIds.length} parcel(s) consumed">${t.disposalIds.length} lot${t.disposalIds.length!==1?'s':''}</span>`
                      : '<span class="text-xs text-muted">—</span>')
                  : (t.parcelId
                      ? `<span class="badge badge-executed" title="Parcel #${t.parcelId}">P#${t.parcelId}</span>`
                      : `<span class="badge badge-pending" title="Click ⟳ Reconcile to fix">Missing</span>`);
              const matchedRec = t.recId
                ? (state.recHistory.find(r => r.id === t.recId)
                   || (state.dayTrading?.recommendations || []).find(r => r.id === t.recId)
                   || (state.intraday?.recommendations   || []).find(r => r.id === t.recId))
                : null;
              return `<tr>
                <td class="text-xs">${t.date}</td>
                <td class="text-xs text-muted">${t.timestamp||'&mdash;'}</td>
                <td><strong>${t.ticker}</strong></td>
                <td>${actionBadge(t.action)}</td>
                <td>${t.qty}</td>
                <td>$${fmt(t.entryPrice)}</td>
                <td>${t.exitPrice ? '$'+fmt(t.exitPrice) : '&mdash;'}</td>
                <td>$${fmt(t.fees)}</td>
                <td class="${pnl!=null?(pnl>=0?'text-success':'text-danger'):'text-muted'}">${pnl!=null?(pnl>=0?'+':'')+' $'+fmt(Math.abs(pnl)):'Open'}</td>
                <td><span class="badge ${t.status==='open'?'badge-open':t.status==='trimmed'?'badge-trim':t.status==='reclass'?'badge-drp':'badge-closed'}">${t.status==='reclass'?'reclassified':t.status}</span></td>
                <td>${parcelBadge}</td>
                <td>${_journalProvenanceBadge(t)}${matchedRec?._thesis?'<span style="font-size:10px;margin-left:3px" title="'+escapeHTML(matchedRec._thesis)+'">📋</span>':''}</td>
                <td>${_journalRegimeBadge(matchedRec?.regime || t.regime)}</td>
                <td style="white-space:nowrap">
                  <button class="btn btn-sm" id="jtoggle-${realIdx}" onclick="toggleJournalDetail(${realIdx})" title="Show technicals & thesis">▸</button>
                  <button class="btn btn-sm btn-danger" onclick="removeJournalTrade(${realIdx})" title="Remove trade">✕</button>
                </td>
              </tr>
              <tr id="jdetail-${realIdx}" style="display:none">
                <td colspan="14" style="background:var(--bg-inset);padding:10px 14px"></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`}
    </div>
  `;
}

// ── Trade detail drawer (technicals + thesis per transaction) ────────────────
// Cache backend trade-detail by learning-event id. Values: object | 'pending' | 'none' | 'error'.
let _journalDetailCache = {};

async function toggleJournalDetail(realIdx) {
  const row = document.getElementById('jdetail-' + realIdx);
  const btn = document.getElementById('jtoggle-' + realIdx);
  if (!row) return;
  const isOpen = row.style.display !== 'none';
  if (isOpen) {
    row.style.display = 'none';
    if (btn) btn.textContent = '▸';
    return;
  }
  row.style.display = '';
  if (btn) btn.textContent = '▾';
  const cell = row.querySelector('td');
  const t = state.tradeJournal[realIdx];
  if (!t) { cell.innerHTML = '<span class="text-xs text-muted">Trade not found.</span>'; return; }
  // Mirror the table row's lookup (line ~258) — recId can resolve against the
  // regular AI Recommendations history OR a Day Trading / Intraday rec, which
  // live in separate arrays. Searching recHistory alone left the drawer's
  // thesis/entry-driver/regime context blank for every day-trade-sourced row.
  const matchedRec = t.recId
    ? (state.recHistory.find(r => r.id === t.recId)
       || (state.dayTrading?.recommendations || []).find(r => r.id === t.recId)
       || (state.intraday?.recommendations   || []).find(r => r.id === t.recId))
    : null;
  const lid = matchedRec?._learningId || null;
  // AI-linked trade: ensure rich backend detail is fetched (entry technicals live server-side).
  if (lid && (_journalDetailCache[lid] === undefined)) {
    cell.innerHTML = '<span class="text-xs text-muted">Loading trade detail…</span>';
    _journalDetailCache[lid] = 'pending';
    try {
      const r = await fetch(`${API}/api/learning/trade-detail?ids=${lid}`);
      const d = await r.json();
      _journalDetailCache[lid] = (d.ok && d.details && d.details[lid]) ? d.details[lid] : 'none';
    } catch { _journalDetailCache[lid] = 'error'; }
  }
  cell.innerHTML = _buildJournalDetailHTML(t, matchedRec, lid);
}

function _journalSig(label, val, fmtFn) {
  if (val == null || Number.isNaN(Number(val))) return '';
  return `<div style="display:flex;justify-content:space-between;gap:10px;padding:2px 0">
    <span class="text-muted">${label}</span><strong>${fmtFn ? fmtFn(val) : val}</strong></div>`;
}

// Entry→exit comparison row — shows both values plus a colour-coded delta
// arrow when both sides are present. Falls back to a single-value row when
// only one side has data (e.g. a still-open BUY with no exit yet).
function _journalSigPair(label, entryVal, exitVal, fmtFn) {
  const hasEntry = entryVal != null && !Number.isNaN(Number(entryVal));
  const hasExit  = exitVal  != null && !Number.isNaN(Number(exitVal));
  if (!hasEntry && !hasExit) return '';
  const f = fmtFn || (v => v);
  if (hasEntry && hasExit) {
    const d = Number(exitVal) - Number(entryVal);
    const color = d > 0 ? 'var(--up)' : d < 0 ? 'var(--down)' : 'var(--text-tertiary)';
    return `<div style="display:flex;justify-content:space-between;gap:10px;padding:2px 0">
      <span class="text-muted">${label}</span>
      <strong>${f(entryVal)} → ${f(exitVal)} <span style="color:${color};font-size:11px">${d>=0?'▲':'▼'}${Math.abs(d).toFixed(2)}</span></strong>
    </div>`;
  }
  return `<div style="display:flex;justify-content:space-between;gap:10px;padding:2px 0">
    <span class="text-muted">${label}</span><strong>${hasEntry ? f(entryVal) : f(exitVal)}</strong></div>`;
}

function _buildJournalDetailHTML(t, matchedRec, lid) {
  const det = lid ? _journalDetailCache[lid] : null;
  const detObj = (det && typeof det === 'object') ? det : null;

  // Resolve fields from richest available source: backend detail → client rec → manual entry.
  // `trade_thesis` is only ever populated when a human typed a note into the optional
  // "thesis" field at execution time (recommendations.js _thesis) — for the vast majority
  // of AI-sourced trades it's NULL even though Claude's own rationale (rationale_summary)
  // was captured at log time. Fall back to that so the drawer doesn't say "No thesis
  // recorded." right above an "explanation" line that duplicates the same missing info.
  const thesis        = detObj?.trade_thesis || matchedRec?._thesis || t.thesis || null;
  const thesisIsFallback = !thesis && !!detObj?.rationale_summary;
  const thesisDisplay = thesis || detObj?.rationale_summary || null;
  const entryDriver = detObj?.primary_entry_driver || matchedRec?.primary_entry_driver || null;
  const exitDriver  = detObj?.sell_primary_driver || null;
  const verdict     = detObj?.thesis_verdict || matchedRec?.thesis_verdict || null;
  const sig         = detObj?.entry_signals || t.entrySignals || null;
  // Exit signals: snapshotted at fill time by _snapshotLiveTechnicals() in
  // recommendations.js (same shape as entry). Only present for closed SELL/TRIM
  // trades — a still-open BUY/TOP_UP has no exit yet.
  const exitSig     = detObj?.exit_signals || t.exitSignals || null;
  const exitQuality = detObj?.exit_quality_tag || null;
  const source      = lid ? 'AI recommendation' : 'Manual entry';
  const hasEntrySig = sig && Object.values(sig).some(v => v != null);
  const hasExitSig  = exitSig && Object.values(exitSig).some(v => v != null);

  const EXIT_QUALITY_STYLE = {
    exit_into_strength:            { color: 'var(--warn)', label: '⚠ Exit into strength' },
    exit_after_reversal_confirmed: { color: 'var(--up)',   label: '✓ Reversal confirmed' },
    exit_into_weakness:            { color: 'var(--down)', label: '▼ Exit into weakness' },
    exit_neutral:                  { color: 'var(--text-tertiary)', label: 'Neutral exit' },
  };
  const EXIT_QUALITY_TOOLTIP = {
    exit_into_strength: 'Sold while RSI/BB%b were still in bullish territory — the technical setup had not actually broken down. May have cut a winner early.',
    exit_after_reversal_confirmed: 'Momentum had genuinely turned (RSI cooled and MACD histogram negative) before the exit — a well-timed technical exit.',
    exit_into_weakness: 'Sold near an oversold extreme (RSI/BB%b deeply negative) — check whether this was a panic exit rather than a planned one.',
    exit_neutral: 'No strong technical signal either way at the moment of exit.',
  };

  // Technicals block — entry-only for open positions, entry→exit comparison
  // (with colour-coded delta) once a SELL/TRIM has captured the exit snapshot.
  let sigHtml;
  if (hasEntrySig || hasExitSig) {
    const eqStyle = exitQuality ? EXIT_QUALITY_STYLE[exitQuality] : null;
    sigHtml = `<div style="min-width:240px">
      <div class="flex-between" style="margin-bottom:4px">
        <div class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.04em">${hasExitSig ? 'Technicals: entry → exit' : 'Technicals at entry'}</div>
        ${eqStyle ? `<span style="font-size:10px;padding:1px 6px;border-radius:8px;border:1px solid ${eqStyle.color};color:${eqStyle.color};cursor:help" title="${escapeHTML(EXIT_QUALITY_TOOLTIP[exitQuality] || '')}">${eqStyle.label}</span>` : ''}
      </div>
      <div style="font-size:12px">
        ${_journalSigPair('RSI(14)', sig?.rsi_14, exitSig?.rsi_14, v => Number(v).toFixed(1))}
        ${_journalSigPair('BB %b', sig?.bb_pct_b, exitSig?.bb_pct_b, v => Number(v).toFixed(2))}
        ${_journalSigPair('ADX(14)', sig?.adx_14, exitSig?.adx_14, v => Number(v).toFixed(1))}
        ${_journalSigPair('ATR %', sig?.atr_pct, exitSig?.atr_pct, v => Number(v).toFixed(2) + '%')}
        ${_journalSigPair('Return 5d', sig?.return_5d, exitSig?.return_5d, v => (v>=0?'+':'') + Number(v).toFixed(1) + '%')}
        ${_journalSigPair('Return 20d', sig?.return_20d, exitSig?.return_20d, v => (v>=0?'+':'') + Number(v).toFixed(1) + '%')}
        ${_journalSigPair('MACD Hist', sig?.macd_hist, exitSig?.macd_hist, v => Number(v).toFixed(3))}
      </div></div>`;
  } else {
    sigHtml = `<div style="min-width:240px"><div class="text-xs text-muted" style="margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em">Technicals at entry</div>
      <div class="text-xs text-muted" style="font-style:italic">Not captured at trade time.</div></div>`;
  }

  // Thesis + drivers block
  // Verdicts come from computeThesisDrift() (learning-loop.js), which compares the
  // entry-time technicals against current technicals for the position's entry driver:
  //  - validated:   the technical pattern that justified entry (e.g. oversold RSI/%b for
  //                  mean_reversion, positive 5d return for momentum_breakout, ADX>20 trend
  //                  resumption for trend_pullback) is confirmed by the latest snapshot.
  //  - invalidated: the same comparison shows the setup broke down (RSI/%b worsened,
  //                  momentum reversed, trend lost strength) — the original reason to hold
  //                  no longer applies.
  //  - irrelevant:  the driver is fundamental_value/macro_tailwind (not technically
  //                  verifiable), the driver is unrecognised, or the entry/now technicals
  //                  are too ambiguous to call either way.
  const VC_TOOLTIP = {
    validated:   'Validated: the technical setup that justified the original entry (e.g. oversold reversal, momentum, or trend resumption) is still confirmed by current price action.',
    invalidated: 'Invalidated: the technical setup that justified the entry has broken down (e.g. momentum reversed, trend lost strength) — the original thesis no longer holds.',
    irrelevant:  'Irrelevant: the entry driver is fundamental/macro (not technically verifiable), unrecognised, or there is not enough entry-vs-current technical data to judge whether the thesis held.',
  };
  const VC = { validated:['var(--up)','✅ Validated'], invalidated:['var(--down)','❌ Invalidated'], irrelevant:['var(--text-tertiary)','➖ Irrelevant'] };
  const vc = verdict ? (VC[verdict] || ['var(--text-tertiary)', verdict]) : null;
  const vcTitle = verdict ? (VC_TOOLTIP[verdict] || '') : '';
  const driverChip = (label, val, color) => val
    ? `<span style="display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;background:${color||'var(--bg-surface)'};border:1px solid var(--border);margin-right:5px">${label}: ${escapeHTML(String(val).replace(/_/g,' '))}</span>`
    : '';
  const thesisHtml = `<div style="flex:1;min-width:240px">
    <div class="text-xs text-muted" style="margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em">Thesis & drivers <span style="text-transform:none">· ${source}</span></div>
    <div style="margin-bottom:6px">
      ${driverChip('Entry', entryDriver)}
      ${driverChip('Exit', exitDriver)}
      ${vc ? `<span style="font-size:11px;padding:1px 7px;border-radius:10px;border:1px solid ${vc[0]};color:${vc[0]};cursor:help" title="${escapeHTML(vcTitle)}">${vc[1]}</span>` : ''}
    </div>
    <div style="font-size:12px;line-height:1.45">${thesisDisplay
        ? (thesisIsFallback ? '<span class="text-xs text-muted" style="font-style:italic">(Claude\'s rationale — no explicit thesis note was recorded) </span>' : '') + escapeHTML(thesisDisplay)
        : '<span class="text-muted" style="font-style:italic">No thesis recorded.</span>'}</div>
    ${detObj?.rationale_summary && detObj.rationale_summary !== thesisDisplay ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:5px">${escapeHTML(detObj.rationale_summary)}</div>` : ''}
  </div>`;

  // Outcome line (prefer backend, fall back to journal)
  const oc = detObj?.outcome_status || (t.status === 'closed' ? (t.pnl >= 0 ? 'win' : 'loss') : 'open');
  const pnlPct = detObj?.realized_pnl_pct;
  const ocColor = oc === 'win' ? 'var(--up)' : (oc === 'loss' ? 'var(--down)' : 'var(--text-tertiary)');
  const outcomeHtml = `<div style="min-width:150px">
    <div class="text-xs text-muted" style="margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em">Outcome</div>
    <div style="font-size:13px;font-weight:600;color:${ocColor}">${oc}${pnlPct != null ? ` · ${(pnlPct>=0?'+':'')}${Number(pnlPct).toFixed(1)}%` : ''}</div>
    ${detObj?.exit_reason ? `<div style="font-size:11px;color:var(--text-tertiary)">exit: ${escapeHTML(detObj.exit_reason)}</div>` : ''}
    ${detObj?.regime ? `<div style="font-size:11px;color:var(--text-tertiary)">regime: ${escapeHTML(detObj.regime)}</div>` : ''}
    ${detObj?.ai_confidence != null ? `<div style="font-size:11px;color:var(--text-tertiary)">conf: ${Math.round(detObj.ai_confidence*100)}%</div>` : ''}
  </div>`;

  const loading = (det === 'pending') ? '<div class="text-xs text-muted">Loading trade detail…</div>' : '';
  return `${loading}<div style="display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start">
    ${thesisHtml}${sigHtml}${outcomeHtml}</div>`;
}

function setJournalFilterKey(key, value) {
  if (!state.journalFilter) state.journalFilter = {
    ticker: '', action: 'all', status: 'all', pnl: 'all',
    dateFrom: '', dateTo: '', sortBy: 'date_desc'
  };
  state.journalFilter[key] = value;
  renderPage();
}

function resetJournalFilter() {
  state.journalFilter = {
    ticker: '', action: 'all', status: 'all', pnl: 'all',
    dateFrom: '', dateTo: '', sortBy: 'date_desc'
  };
  renderPage();
}

// Legacy shims — kept so any saved onclick refs still work
function setJournalFilter(type, value) {
  if (type === 'all') { resetJournalFilter(); return; }
  setJournalFilterKey(type, value || '');
}
function setJournalStatusFilter(status) { setJournalFilterKey('status', status); }
function setJournalActionFilter(action) { setJournalFilterKey('action', action); }

// Capture a technical snapshot for a ticker at the time of a same-day manual trade.
// Prefers in-memory live signals; falls back to a fresh /api/analyse fetch.
// Returns null when signals are unavailable (offline, new ticker, or backdated trade).
// tradeDate must equal todayStr() — we never attach today's technicals to a past fill.
async function _fetchSignalSnapshot(ticker, tradeDate) {
  if (tradeDate && tradeDate !== todayStr()) return null;
  let s = state.liveSignals?.[ticker];
  if (!s) {
    try {
      const r = await fetch(`${API}/api/analyse/${encodeURIComponent(ticker)}`);
      if (r.ok) s = await r.json();
    } catch { /* offline — leave null */ }
  }
  if (!s || s.rsi_14 == null) return null;
  return {
    // Core oscillators
    rsi_14:     s.rsi_14     ?? null,
    bb_pct_b:   s.bb_pct_b   ?? null,
    adx_14:     s.adx        ?? s.adx_14 ?? null,
    atr_pct:    s.atr_pct    ?? null,
    // Returns
    return_5d:  s.return_5d  ?? null,
    return_20d: s.return_20d ?? null,
    return_60d: s.return_60d ?? null,
    // Momentum
    macd_hist:  s.macd_hist  ?? null,
    setup_score:s.score      ?? null,
    // Sector relative strength
    sector_rs_5d: s.sector_rs_5d ?? null,
    // Volume context
    adv_20:     s.adv_20     ?? null,
    // Price at entry
    price:      s.current_price ?? null,
  };
}

async function addManualTrade() {
  const ticker = prompt('Ticker:'); if(!ticker) return;
  const action = (prompt('Action (BUY/SELL):') || 'BUY').toUpperCase();
  const qty = Number(prompt('Quantity:')); if(!qty) return;
  const price = Number(prompt('Price ($):')); if(!price) return;
  const dateInput = prompt('Date (DD-MM-YYYY, blank = today):');
  const tradeDate = (dateInput && dateInput.match(/^\d{2}-\d{2}-\d{4}$/)) ? dateInput : todayStr();
  const thesisInput = (prompt('Thesis / why (optional — recorded for review):') || '').trim();
  const fees = state.settings.brokerage;
  const symbol = ticker.toUpperCase();
  // Snapshot live technicals — only when trade is today; backdated fills get null.
  const entrySignals = await _fetchSignalSnapshot(symbol, tradeDate);
  const thesis = thesisInput || null;
  // Same today-only gate as entrySignals — stamping today's regime onto a
  // backdated manual entry would misrepresent the conditions at that date.
  const regime = (tradeDate === todayStr())
    ? ((state.currentRegime && state.currentRegime.regime) || null)
    : null;
  let tradeEntry;
  let _disposalEntries = null;

  if(action === 'SELL') {
    const holding = getPortfolioHolding(symbol);
    if(holding && holding.shares >= qty) {
      const prevLen = state.cgtDisposals.length;
      const { disposals } = applySellToPortfolio(symbol, qty, price, fees, tradeDate);
      // One Trade Journal row per parcel matched (mirrors markExecuted()) —
      // a manual sell spanning multiple lots shows as separate rows, each
      // labelled with its originating parcel, and the original BUY/TOP_UP
      // row(s) get their status updated to 'closed'/'trimmed'.
      _disposalEntries = buildDisposalJournalEntries({
        ticker: symbol, account: holding.account || 'personal', disposals, tradePrice: price, action,
        recId: null, recExecuted: false, timestamp: nowSydney(), date: tradeDate,
        regime, exitSignals: entrySignals, disposalIdBase: prevLen,
      });
      // Manual trades carry a free-text thesis the disposal helper doesn't
      // know about — attach it to each row created for this sale.
      _disposalEntries.forEach(e => { e.thesis = thesis; });
      tradeEntry = _disposalEntries[0] || null;
    } else {
      tradeEntry = {
        id: state.tradeJournal.length + 1, date: tradeDate, ticker: symbol, action,
        qty, entryPrice: price, exitPrice: null, fees,
        status: 'open', pnl: null, recId: null, recExecuted: false, timestamp: nowSydney(),
        entrySignals, thesis, regime
      };
      toast('Sell logged — no matching portfolio position found. Portfolio unchanged.', 'warn');
    }
  } else {
    const sector = prompt('Sector (optional, e.g. Banking):') || 'Other';
    applyBuyToPortfolio(symbol, qty, price, tradeDate, fees, sector);
    const newParcel = state.cgtParcels[state.cgtParcels.length - 1];
    state.cash -= qty * price + fees;
    tradeEntry = {
      id: state.tradeJournal.length + 1, date: tradeDate, ticker: symbol, action,
      qty, entryPrice: price, exitPrice: null, fees,
      status: 'open', pnl: null,
      parcelId: newParcel ? newParcel.id : null,
      recId: null, recExecuted: false, timestamp: nowSydney(),
      entrySignals, thesis, regime
    };
  }

  if (!_disposalEntries) {
    state.tradeJournal.unshift(tradeEntry);
  }
  toast('Trade logged', 'success');
  scheduleSave();
  renderPage();
}
function removeJournalTrade(i) {
  const t = state.tradeJournal[i];
  if(!t || !confirm(`Remove ${t.action} ${t.qty}x ${t.ticker} on ${t.date}?`)) return;
  // rollbackTradeJournalEntry() only has branches for an open BUY/TOP_UP or a
  // closed SELL/TRIM — a trimmed BUY row, a RECLASSIFY row, or anything else
  // it can't safely reverse returns false. Refuse to delete in that case:
  // splicing the row out anyway would silently desync the journal from
  // portfolio/parcel state (deleting the only record of an open lot, or of
  // an account-reclassification, without reversing anything).
  if (!rollbackTradeJournalEntry(t)) {
    toast(`Can't remove this ${t.action} row — its effect on your portfolio can't be safely reversed (e.g. a trimmed lot or a reclassification). Reverse it manually if needed.`, 'error');
    return;
  }
  state.tradeJournal.splice(i,1);
  toast('Trade removed from journal','success');
  scheduleSave();
  renderPage();
}
function manualReconcile() {
  const n = reconcileJournalParcels();
  scheduleSave();
  renderPage();
  if (n > 0) toast(`Reconciled: ${n} missing parcel${n!==1?'s':''} created and linked`, 'success');
  else toast('All BUY trades already have parcels — nothing to reconcile', 'info');
}
function exportCSV() {
  // Main journal CSV
  const h='Date,Time,Ticker,Action,Qty,EntryPrice,ExitPrice,Fees,GrossPnL,Status,ParcelID,RecID,FromRec\n';
  const rows=state.tradeJournal.map(t=>[
    t.date, t.timestamp||'', t.ticker, t.action, t.qty,
    t.entryPrice, t.exitPrice||'', t.fees, t.pnl!=null?t.pnl.toFixed(2):'',
    t.status, t.parcelId||'', t.recId||'', t.recId?(t.recExecuted?'Yes':'No'):'Manual'
  ].join(',')).join('\n');
  const blob=new Blob([h+rows],{type:'text/csv'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`asx_trades_${todayStr()}.csv`; a.click();

  // CGT disposals CSV (ATO-ready)
  if(state.cgtDisposals.length) {
    setTimeout(()=>{
      const h2='SaleDate,Ticker,SalePrice,SaleQty,Proceeds,ParcelDate,CostPerShare,CostBase,SaleFee,GrossGain,CGTDiscount,NetGain,HeldDays,50%Eligible,ParcelID\n';
      const r2=state.cgtDisposals.map(d=>[
        d.saleDate, d.ticker, d.salePrice, d.saleQty,
        d.proceeds.toFixed(2), d.parcelDate||'Unknown', d.parcelCostPerShare.toFixed(4),
        d.costBase.toFixed(2), d.saleFee.toFixed(2), d.grossGain.toFixed(2),
        d.discount.toFixed(2), d.netGain.toFixed(2), d.heldDays!=null?d.heldDays:'?',
        d.eligible50?'Yes':'No', d.parcelId||'No parcel'
      ].join(',')).join('\n');
      const b2=new Blob([h2+r2],{type:'text/csv'});
      const a2=document.createElement('a'); a2.href=URL.createObjectURL(b2); a2.download=`asx_cgt_${todayStr()}.csv`; a2.click();
      toast('CGT disposals CSV also exported','success');
    }, 600);
  }
  toast('Trade journal CSV exported','success');
}

// ── Monthly P&L chart ─────────────────────────────────────────────────────────

function _buildMonthlyPnlCard() {
  const closed = state.tradeJournal.filter(t => t.status === 'closed' && t.pnl != null);
  if (closed.length < 2) return '';

  // Bucket by YYYY-MM (date format is DD-MM-YYYY)
  const buckets = {};
  closed.forEach(t => {
    if (!t.date) return;
    const parts = t.date.split('-');
    if (parts.length < 3) return;
    const key = `${parts[2]}-${parts[1]}`;  // YYYY-MM
    buckets[key] = (buckets[key] || 0) + (t.pnl || 0);
  });

  const months = Object.keys(buckets).sort().slice(-18);  // last 18 months
  if (months.length < 2) return '';

  const totalWinMonths  = months.filter(m => buckets[m] > 0).length;
  const totalLoseMonths = months.filter(m => buckets[m] < 0).length;
  const bestMonth       = months.reduce((best, m) => buckets[m] > (buckets[best]||0) ? m : best, months[0]);
  const worstMonth      = months.reduce((worst, m) => buckets[m] < (buckets[worst]||0) ? m : worst, months[0]);

  setTimeout(() => _drawMonthlyPnlChart('monthly-pnl-chart', buckets, months), 60);

  return `
  <div class="card section-gap">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
      <div class="card-title" style="margin:0">Monthly P&amp;L</div>
      <div style="display:flex;gap:16px;font-size:11px">
        <span class="text-success">▲ ${totalWinMonths} winning</span>
        <span class="text-danger">▼ ${totalLoseMonths} losing</span>
        <span class="text-muted">Best: <strong class="text-success">$${fmt(buckets[bestMonth])}</strong> (${bestMonth})</span>
        <span class="text-muted">Worst: <strong class="text-danger">$${fmt(buckets[worstMonth])}</strong> (${worstMonth})</span>
      </div>
    </div>
    <canvas id="monthly-pnl-chart" style="width:100%;height:140px"></canvas>
  </div>`;
}

function _drawMonthlyPnlChart(canvasId, buckets, months) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (typeof _fitCanvas === 'function') _fitCanvas(canvas);
  else { canvas.width = canvas.offsetWidth || 800; canvas.height = canvas.offsetHeight || 140; }
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const PAD_L = 58, PAD_R = 8, PAD_T = 10, PAD_B = 28;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  ctx.clearRect(0, 0, W, H);

  const values = months.map(m => buckets[m] || 0);
  const maxAbs = Math.max(...values.map(Math.abs), 1);
  const barW   = Math.max(4, Math.floor(chartW / months.length) - 2);
  const step   = chartW / months.length;
  const midY   = PAD_T + chartH / 2;

  const _gc = typeof chartColor === 'function'
    ? (tok, fb) => chartColor(tok, fb)
    : (tok, fb) => fb;

  // Zero line
  ctx.strokeStyle = _gc('--chart-grid', 'rgba(128,128,128,0.25)');
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(PAD_L, midY); ctx.lineTo(W - PAD_R, midY); ctx.stroke();

  // Y-axis grid + labels
  ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  ctx.fillStyle = _gc('--text-tertiary', 'rgba(128,128,128,0.6)');
  [0.5, 1].forEach(f => {
    const yPos = midY - f * (chartH / 2);
    const yNeg = midY + f * (chartH / 2);
    const label = '$' + fmt(maxAbs * f, 0);
    ctx.fillText(label,    PAD_L - 4, yPos + 3);
    ctx.fillText('-' + label, PAD_L - 4, yNeg + 3);
    ctx.strokeStyle = _gc('--chart-grid', 'rgba(128,128,128,0.08)');
    ctx.beginPath(); ctx.moveTo(PAD_L, yPos); ctx.lineTo(W - PAD_R, yPos); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD_L, yNeg); ctx.lineTo(W - PAD_R, yNeg); ctx.stroke();
  });

  // Bars
  months.forEach((m, i) => {
    const v    = buckets[m] || 0;
    const x    = PAD_L + i * step + (step - barW) / 2;
    const barH = Math.abs(v) / maxAbs * (chartH / 2);
    const y    = v >= 0 ? midY - barH : midY;
    ctx.fillStyle = v >= 0 ? _gc('--up', '#16a34a') : _gc('--down', '#dc2626');
    ctx.globalAlpha = 0.75;
    ctx.fillRect(x, y, barW, barH || 1);
    ctx.globalAlpha = 1;

    // Month label
    const label = m.slice(2).replace('-', '/');  // YY/MM
    ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = _gc('--text-tertiary', 'rgba(128,128,128,0.7)');
    ctx.fillText(label, x + barW / 2, H - 6);
  });
}
