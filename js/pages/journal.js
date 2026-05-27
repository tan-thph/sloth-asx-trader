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
  if (jf.pnl === 'open')    filtered = filtered.filter(t => t.status === 'open');
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
  if (jf.sortBy === 'date_desc')  filtered.sort((a,b) => (b.date||'').localeCompare(a.date||''));
  if (jf.sortBy === 'date_asc')   filtered.sort((a,b) => (a.date||'').localeCompare(b.date||''));
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
          </select>
        </div>
        <!-- Status -->
        <div>
          <div class="form-label" style="margin-bottom:3px">Status</div>
          <select onchange="setJournalFilterKey('status', this.value)" ${selStyle}>
            <option value="all"    ${jf.status==='all'   ?'selected':''}>All</option>
            <option value="open"   ${jf.status==='open'  ?'selected':''}>Open</option>
            <option value="closed" ${jf.status==='closed'?'selected':''}>Closed</option>
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
            <th>Gross P&L</th><th>Status</th><th>Parcel</th><th>From Rec?</th><th>Regime</th><th></th>
          </tr></thead>
          <tbody>
            ${filtered.map(t => {
              const pnl = t.pnl != null ? t.pnl : (t.exitPrice
                ? (t.action==='BUY' ? (t.exitPrice-t.entryPrice)*t.qty : (t.entryPrice-t.exitPrice)*t.qty) - t.fees
                : null);
              const realIdx = state.tradeJournal.indexOf(t);
              const parcelBadge = t.action === 'SELL'
                ? (t.disposalIds && t.disposalIds.length
                    ? `<span class="badge badge-executed" title="${t.disposalIds.length} parcel(s) consumed">${t.disposalIds.length} lot${t.disposalIds.length!==1?'s':''}</span>`
                    : '<span class="text-xs text-muted">—</span>')
                : (t.parcelId
                    ? `<span class="badge badge-executed" title="Parcel #${t.parcelId}">P#${t.parcelId}</span>`
                    : `<span class="badge badge-pending" title="Click ⟳ Reconcile to fix">Missing</span>`);
              const matchedRec = t.recId ? state.recHistory.find(r => r.id === t.recId) : null;
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
                <td><span class="badge ${t.status==='open'?'badge-open':'badge-closed'}">${t.status}</span></td>
                <td>${parcelBadge}</td>
                <td><span class="badge ${t.recId&&t.recExecuted?'badge-executed':'badge-skipped'}" title="${matchedRec?._thesis ? 'Thesis: '+matchedRec._thesis : ''}">${t.recId?(t.recExecuted?'Rec: Yes':'Rec: No'):'Manual'}</span>${matchedRec?._thesis?'<span style="font-size:10px;margin-left:3px" title="'+escapeHTML(matchedRec._thesis)+'">📋</span>':''}</td>
                <td>${_journalRegimeBadge(matchedRec?.regime)}</td>
                <td><button class="btn btn-sm btn-danger" onclick="removeJournalTrade(${realIdx})" title="Remove trade">✕</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`}
    </div>
  `;
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

function addManualTrade() {
  const ticker = prompt('Ticker:'); if(!ticker) return;
  const action = (prompt('Action (BUY/SELL):') || 'BUY').toUpperCase();
  const qty = Number(prompt('Quantity:')); if(!qty) return;
  const price = Number(prompt('Price ($):')); if(!price) return;
  const dateInput = prompt('Date (DD-MM-YYYY, blank = today):');
  const tradeDate = (dateInput && dateInput.match(/^\d{2}-\d{2}-\d{4}$/)) ? dateInput : todayStr();
  const fees = state.settings.brokerage;
  const symbol = ticker.toUpperCase();
  let tradeEntry;

  if(action === 'SELL') {
    const holding = getPortfolioHolding(symbol);
    if(holding && holding.shares >= qty) {
      const prevLen = state.cgtDisposals.length;
      const { ok, disposals } = applySellToPortfolio(symbol, qty, price, fees, tradeDate);
      const grossPnl = disposalsToPnl(disposals);
      tradeEntry = {
        id: state.tradeJournal.length + 1, date: tradeDate, ticker: symbol, action,
        qty, entryPrice: holding.avgPrice, exitPrice: price, fees,
        status: 'closed', pnl: grossPnl,
        disposalIds: disposals.map((_,i) => prevLen + i),
        recId: null, recExecuted: false, timestamp: nowSydney()
      };
    } else {
      tradeEntry = {
        id: state.tradeJournal.length + 1, date: tradeDate, ticker: symbol, action,
        qty, entryPrice: price, exitPrice: null, fees,
        status: 'open', pnl: null, recId: null, recExecuted: false, timestamp: nowSydney()
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
      recId: null, recExecuted: false, timestamp: nowSydney()
    };
  }

  state.tradeJournal.unshift(tradeEntry);
  toast('Trade logged', 'success');
  scheduleSave();
  renderPage();
}
function removeJournalTrade(i) {
  const t = state.tradeJournal[i];
  if(!t || !confirm(`Remove ${t.action} ${t.qty}x ${t.ticker} on ${t.date}?`)) return;
  rollbackTradeJournalEntry(t);
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
