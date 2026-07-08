// ============================================================
// CGT PARCEL TRACKER
// ============================================================
// ── CGT FILTER STATE & HELPERS ──────────────────────────────────────────────
if (!window._cgtFilter) window._cgtFilter = {
  disposal: { ticker: '', yearFY: 'all', outcome: 'all', sortBy: 'date_desc', mode: 'all' },
  parcel:   { ticker: '', discount: 'all', minHeld: 0, mode: 'all' }
};
// Back-compat: a persisted _cgtFilter from before the disposal Book filter existed
// won't carry disposal.mode — default it so the dropdown and filter logic work.
if (window._cgtFilter.disposal && window._cgtFilter.disposal.mode === undefined) {
  window._cgtFilter.disposal.mode = 'all';
}

// Dates in this app are stored DD-MM-YYYY (see todayStr(), utils.js); parseDate()
// already knows how to read that (with a native-Date fallback for anything else).
// Returns the Australian FY-start year for a date string, or null if unparseable.
function _dateFY(dateStr) {
  const d = typeof parseDate === 'function' ? parseDate(dateStr) : new Date(dateStr);
  if (!d || isNaN(d)) return null;
  const yr = d.getFullYear(), mo = d.getMonth() + 1; // 1-12
  return mo >= 7 ? yr : yr - 1;
}
function _saleDateFY(saleDate) { return _dateFY(saleDate); }

function setCgtDisposalFilter(key, value) {
  window._cgtFilter.disposal[key] = value;
  renderPage();
}
function resetCgtParcelFilter() {
  if (!window._cgtFilter) window._cgtFilter = {};
  window._cgtFilter.parcel = { ticker: '', discount: 'all', minHeld: 0, mode: 'all' };
  renderPage();
}

function resetCgtDisposalFilter() {
  if (!window._cgtFilter) window._cgtFilter = {};
  window._cgtFilter.disposal = { ticker: '', yearFY: 'all', outcome: 'all', sortBy: 'date_desc', mode: 'all' };
  renderPage();
}

function setCgtParcelFilter(key, value) {
  window._cgtFilter.parcel[key] = value;
  renderPage();
}

async function downloadEofyPack() {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  const now = new Date();
  const year = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const yearInput = prompt(`Download EOFY tax pack for which financial year? (e.g. ${year} = FY${year}–${year+1})`, year);
  if (!yearInput) return;
  const fy = parseInt(yearInput, 10);
  if (isNaN(fy) || fy < 2000 || fy > 2100) { toast('Invalid year', 'error'); return; }
  try {
    toast(`Building EOFY pack for FY${fy}–${fy+1}…`);
    const resp = await fetch(`${API}/api/tax/eofy-pack?year=${fy}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `eofy_tax_pack_FY${fy}-${fy+1}.zip`;
    a.click();
    toast(`EOFY pack downloaded: FY${fy}–${fy+1}`, 'success');
  } catch (e) {
    toast('EOFY pack failed: ' + e.message, 'error');
  }
}

function exportDisposalCSV() {
  if (!state.cgtDisposals.length) { toast('No disposals to export', 'error'); return; }
  // Apply current filter
  const f = window._cgtFilter.disposal;
  const now = new Date();
  const fyStart = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  // Paper/real firewall (gotcha #88): this is an ATO-facing export — REAL only,
  // mirroring the server-side EOFY pack. A paper disposal in a file handed to an
  // accountant would defeat the whole firewall.
  const _all = state.cgtDisposals.length;
  let rows = state.cgtDisposals.filter(d => isRealTrade(d));
  const _paperExcluded = _all - rows.length;
  if (!rows.length) {
    toast(`No REAL disposals to export — all ${_all} disposal(s) are paper trades (excluded from tax exports)`, 'warning');
    return;
  }
  if (f.ticker) rows = rows.filter(d => d.ticker.includes(f.ticker.toUpperCase()));
  if (f.yearFY !== 'all') {
    const fyNum = parseInt(f.yearFY);
    rows = rows.filter(d => _saleDateFY(d.saleDate) === fyNum);
  }
  if (f.outcome !== 'all') rows = rows.filter(d => f.outcome === 'gain' ? d.grossGain >= 0 : d.grossGain < 0);
  const h = 'SaleDate,Ticker,SalePrice,SaleQty,Proceeds,ParcelDate,CostPerShare,CostBase,SaleFee,GrossGain,CGTDiscount,NetGain,HeldDays,50%Eligible,ParcelID\n';
  const csv = rows.map(d => [
    d.saleDate, d.ticker, d.salePrice, d.saleQty, d.proceeds.toFixed(2),
    d.parcelDate || 'Unknown', d.parcelCostPerShare.toFixed(4), d.costBase.toFixed(2),
    d.saleFee.toFixed(2), d.grossGain.toFixed(2), d.discount.toFixed(2),
    d.netGain.toFixed(2), d.heldDays != null ? d.heldDays : '?',
    d.eligible50 ? 'Yes' : 'No', d.parcelId || 'No parcel'
  ].join(',')).join('\n');
  const blob = new Blob([h + csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `asx_cgt_disposals_${f.yearFY !== 'all' ? 'FY' + f.yearFY : 'all'}_${todayStr()}.csv`;
  a.click();
  toast(`Exported ${rows.length} REAL disposal record(s)${_paperExcluded ? ` (${_paperExcluded} paper excluded)` : ''}`, 'success');
}

function setCgtMethod(m) {
  state.cgtMethod = m;
  scheduleSave();
  renderPage();
}

async function addParcelManually() {
  const ticker = prompt('Ticker (e.g. WDS):'); if(!ticker) return;
  const date = prompt('Buy date (DD-MM-YYYY):');
  if(!date || !date.match(/^\d{2}-\d{2}-\d{4}$/)) { toast('Invalid date format', 'error'); return; }
  const qty = Number(prompt('Shares purchased:')); if(!qty) return;
  const cost = Number(prompt('Cost per share ($):')); if(!cost) return;
  const fees = Number(prompt('Brokerage paid ($, e.g. 10):') || state.settings.brokerage);
  const sector = prompt('Sector (optional):') || 'Other';
  // Paper/real firewall (gotcha #88): a CGT parcel is tax data — the user must
  // say whether it's a real lot. Without this, manually-added parcels were
  // always paper (mode-less ⇒ 'paper') and could never enter the EOFY pack.
  const mode = await askTradeMode(`Add CGT parcel ${ticker.toUpperCase()} (${qty} shares)`);
  if (mode == null) return;   // cancelled — no writes
  addParcel(ticker, date, qty, cost, fees, sector, undefined, mode);
  scheduleSave();
  renderPage();
  toast(`Parcel added: ${qty} × ${ticker.toUpperCase()} @ $${cost}`, 'success');
}

function deleteParcel(id) {
  const p = state.cgtParcels.find(x => x.id === id);
  if(!p) return;
  if(!confirm(`Delete parcel: ${p.remainingQty}/${p.qty} × ${p.ticker} @ $${p.costPerShare} (${p.date})?`)) return;
  state.cgtParcels = state.cgtParcels.filter(x => x.id !== id);
  scheduleSave();
  renderPage();
  toast('Parcel deleted', 'success');
}

function renderCGT() {
  const parcels = state.cgtParcels;
  const disposals = state.cgtDisposals;
  const today = todayStr();

  // Paper/real firewall (gotcha #88): the headline TAX-LIABILITY figures (FY
  // gain, discount, net CGT) are estimates of what you actually owe the ATO —
  // they sum REAL disposals only, matching the EOFY pack. The disposals TABLE
  // below still lists paper rows (with a ◦ PAPER badge) for reference.
  const realDisposals  = disposals.filter(d => isRealTrade(d));
  const paperDisposalCount = disposals.length - realDisposals.length;
  const totalGrossGain = realDisposals.reduce((s,d) => s + d.grossGain, 0);
  const totalDiscount  = realDisposals.reduce((s,d) => s + d.discount, 0);
  const totalNetGain   = realDisposals.reduce((s,d) => s + d.netGain, 0);

  const tickerMap = {};
  parcels.forEach(p => {
    if(!tickerMap[p.ticker]) tickerMap[p.ticker] = [];
    tickerMap[p.ticker].push(p);
  });

  // CGT urgency: parcels within 45 days of 12-month mark that are profitable
  const urgentParcels = parcels.filter(p => {
    if (p.remainingQty <= 0 || !p.date) return false;
    const held = daysBetween(p.date, today);
    if (held < 320 || held >= 365) return false;
    const holding = getPortfolioHolding(p.ticker);
    const currentPrice = holding ? holding.currentPrice : 0;
    return currentPrice > p.costPerShare; // only warn if profitable
  });
  const urgentBanner = urgentParcels.length ? `
    <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:flex-start;gap:10px">
      <span style="font-size:18px;flex-shrink:0">⏰</span>
      <div>
        <div style="font-weight:700;color:#92400e;font-size:13px;margin-bottom:2px">CGT Discount Approaching</div>
        <div style="font-size:12px;color:#78350f">
          ${urgentParcels.map(p => {
            const held = daysBetween(p.date, today);
            return `<strong>${p.ticker}</strong> — ${365 - held} day(s) until 50% discount (parcel #${p.id}, ${p.remainingQty} shares @ $${fmt(p.costPerShare)})`;
          }).join('<br>')}
        </div>
        <div style="font-size:11px;color:#92400e;margin-top:4px">Consider waiting before selling — early exit forfeits the 50% CGT discount.</div>
      </div>
    </div>` : '';

  const methodLabels = { fifo:'FIFO', lifo:'LIFO', minimise:'Minimise Tax', maximise:'Maximise Loss' };
  const methodDescs  = {
    fifo:     'First In First Out — oldest lots sold first (ATO default)',
    lifo:     'Last In First Out — newest lots sold first',
    minimise: 'CGT-discounted (>12mo) lots first, then highest-cost',
    maximise: 'Highest-cost lots first — maximise realised loss for tax-loss harvesting',
  };

  const now = new Date();
  const fyStart = now.getMonth() >= 6 ? `${now.getFullYear()}-07-01` : `${now.getFullYear()-1}-07-01`;
  // FY figures: REAL only — see realDisposals comment above.
  const fyDisposals = realDisposals.filter(d => d.saleDate >= fyStart);
  const fyGross = fyDisposals.reduce((s,d)=>s+d.grossGain,0);
  const fyNet   = fyDisposals.reduce((s,d)=>s+d.netGain,0);
  const fyDisc  = fyDisposals.reduce((s,d)=>s+d.discount,0);

  // Collapse state stored on window to survive re-renders
  if (window._cgtCollapsed === undefined) window._cgtCollapsed = { disposals: false, parcels: false };
  const dc = window._cgtCollapsed.disposals;
  const pc = window._cgtCollapsed.parcels;

  return `
    ${urgentBanner}
    <!-- Method selector -->
    <div class="card section-gap">
      <div class="flex-between">
        <div>
          <div class="card-title" style="margin:0">CGT Method</div>
          <div class="text-xs text-muted" style="margin-top:3px">${methodDescs[state.cgtMethod]}</div>
        </div>
        <div class="flex-row" style="gap:6px">
          ${Object.entries(methodLabels).map(([k,v])=>`
            <button class="btn btn-sm ${state.cgtMethod===k?'btn-primary':''}" onclick="setCgtMethod('${k}')">${v}</button>
          `).join('')}
        </div>
      </div>
    </div>

    <!-- FY Summary -->
    <div class="metrics-grid section-gap">
      <div class="metric-card">
        <div class="metric-label">FY Gross Capital Gain</div>
        <div class="metric-value ${fyGross>=0?'up':'down'}">${fyGross>=0?'+':''}$${fmt(Math.abs(fyGross))}</div>
        <div class="metric-sub">Current FY (from ${fyStart})${paperDisposalCount ? ' · real only' : ''}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">50% Discount Applied</div>
        <div class="metric-value text-success">−$${fmt(fyDisc)}</div>
        <div class="metric-sub">On eligible &gt;12-month parcels</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">FY Net Capital Gain</div>
        <div class="metric-value ${fyNet>=0?'up':'down'}">${fyNet>=0?'+':''}$${fmt(Math.abs(fyNet))}</div>
        <div class="metric-sub">After discount &amp; losses</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">All-Time Net Gain</div>
        <div class="metric-value ${totalNetGain>=0?'up':'down'}">${totalNetGain>=0?'+':''}$${fmt(Math.abs(totalNetGain))}</div>
        <div class="metric-sub">${realDisposals.length} real disposal${realDisposals.length!==1?'s':''}${paperDisposalCount ? ` · ${paperDisposalCount} paper excluded` : ''}</div>
      </div>
    </div>

    <!-- ① DISPOSAL HISTORY (filtered, collapsible) -->
    ${(()=>{
      const f = window._cgtFilter.disposal;
      // Derive available FY years from all trade activity (disposals + open/closed
      // parcel acquisition dates), plus always include the current FY, so the
      // dropdown reflects actual trading history instead of a fixed range.
      const nowFY = _dateFY(today);
      const fyYearSet = new Set(disposals.map(d => _dateFY(d.saleDate)));
      parcels.forEach(p => fyYearSet.add(_dateFY(p.date)));
      fyYearSet.add(nowFY);
      fyYearSet.delete(null);
      const fyYears = [...fyYearSet].sort().reverse();
      // Apply filters
      let fDisposals = disposals.slice();
      if (f.ticker) fDisposals = fDisposals.filter(d => d.ticker.includes(f.ticker.toUpperCase()));
      if (f.yearFY !== 'all') {
        const fyNum = parseInt(f.yearFY);
        fDisposals = fDisposals.filter(d => _saleDateFY(d.saleDate) === fyNum);
      }
      if (f.outcome !== 'all') fDisposals = fDisposals.filter(d => f.outcome === 'gain' ? d.grossGain >= 0 : d.grossGain < 0);
      // Book filter (paper/real firewall #88): display-only — the disposal list shows
      // both books (with ●LIVE/◦PAPER badges); this narrows the view. Export/EOFY stay
      // real-only regardless (exportDisposalCSV forces isRealTrade). Fail-safe: (d.mode||'paper').
      if ((f.mode||'all') !== 'all') fDisposals = fDisposals.filter(d => (d.mode || 'paper') === f.mode);
      if (f.sortBy === 'date_asc')    fDisposals.sort((a,b) => a.saleDate.localeCompare(b.saleDate));
      else if (f.sortBy === 'gain_desc') fDisposals.sort((a,b) => b.netGain - a.netGain);
      else if (f.sortBy === 'gain_asc')  fDisposals.sort((a,b) => a.netGain - b.netGain);
      else fDisposals.sort((a,b) => b.saleDate.localeCompare(a.saleDate)); // date_desc default
      const fGross = fDisposals.reduce((s,d)=>s+d.grossGain,0);
      const fDisc  = fDisposals.reduce((s,d)=>s+d.discount,0);
      const fNet   = fDisposals.reduce((s,d)=>s+d.netGain,0);
      const hasFilter = f.ticker || f.yearFY !== 'all' || f.outcome !== 'all' || (f.mode||'all') !== 'all';
      const selS = 'style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-secondary);color:var(--text-primary);font-size:11px;font-family:var(--font)"';
      return '<div class="card section-gap">'
      + '<div class="flex-between" style="cursor:pointer;user-select:none" onclick="window._cgtCollapsed.disposals=!window._cgtCollapsed.disposals;renderPage()">'
      + '<div class="card-title" style="margin:0">'
      + '<span style="margin-right:8px;font-size:11px;color:var(--text-tertiary)">' + (dc?'▶':'▼') + '</span>'
      + 'Disposal History'
      + '<span class="text-xs text-muted" style="margin-left:8px;font-weight:400">' + fDisposals.length + (hasFilter ? ' shown of '+disposals.length : ' event' + (disposals.length!==1?'s':'')) + '</span>'
      + (fDisposals.length ? '<span class="text-xs text-muted" style="margin-left:8px;font-weight:400">· Net: <span class="' + (fNet>=0?'text-success':'text-danger') + '">' + (fNet>=0?'+':'') + '$' + fmt(Math.abs(fNet)) + '</span></span>' : '')
      + '</div>'
      + '<div class="flex-row" style="gap:6px" onclick="event.stopPropagation()">'
      + '<button class="btn btn-sm btn-primary" onclick="exportDisposalCSV()">↓ Export CSV</button>'
      + '<button class="btn btn-sm" onclick="downloadEofyPack()" title="Download EOFY tax pack (CGT disposals + fees) as ZIP">↓ EOFY Pack</button>'
      + '<span class="btn btn-sm">' + (dc?'Expand':'Collapse') + '</span>'
      + '</div>'
      + '</div>'
      // Filter bar
      + (!dc ? '<div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 12px;margin-top:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">'
      + '<div><div class="form-label" style="margin-bottom:3px">Ticker</div><input type="text" placeholder="e.g. CBA" value="' + f.ticker + '" oninput="setCgtDisposalFilter(\'ticker\',this.value.toUpperCase())" style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:11px;width:80px"></div>'
      + '<div><div class="form-label" style="margin-bottom:3px">Financial Year</div><select onchange="setCgtDisposalFilter(\'yearFY\',this.value)" ' + selS + '><option value="all"' + (f.yearFY==='all'?' selected':'') + '>All years</option>' + fyYears.map(y => '<option value="'+y+'"' + (f.yearFY==y?' selected':'') + '>FY '+y+'/'+(y+1).toString().slice(-2)+'</option>').join('') + '</select></div>'
      + '<div><div class="form-label" style="margin-bottom:3px">Outcome</div><select onchange="setCgtDisposalFilter(\'outcome\',this.value)" ' + selS + '><option value="all"' + (f.outcome==='all'?' selected':'') + '>All</option><option value="gain"' + (f.outcome==='gain'?' selected':'') + '>Gains only</option><option value="loss"' + (f.outcome==='loss'?' selected':'') + '>Losses only</option></select></div>'
      + '<div><div class="form-label" style="margin-bottom:3px">Book</div><select onchange="setCgtDisposalFilter(\'mode\',this.value)" ' + selS + '>'
        + '<option value="all"' + ((f.mode||'all')==='all'?' selected':'') + '>All</option>'
        + '<option value="real"' + (f.mode==='real'?' selected':'') + '>● Live</option>'
        + '<option value="paper"' + (f.mode==='paper'?' selected':'') + '>◦ Paper</option>'
        + '</select></div>'
      + '<div><div class="form-label" style="margin-bottom:3px">Sort</div><select onchange="setCgtDisposalFilter(\'sortBy\',this.value)" ' + selS + '><option value="date_desc"' + (f.sortBy==='date_desc'?' selected':'') + '>Newest first</option><option value="date_asc"' + (f.sortBy==='date_asc'?' selected':'') + '>Oldest first</option><option value="gain_desc"' + (f.sortBy==='gain_desc'?' selected':'') + '>Best gain</option><option value="gain_asc"' + (f.sortBy==='gain_asc'?' selected':'') + '>Worst gain</option></select></div>'
      + (hasFilter ? '<button class="btn btn-sm" onclick="resetCgtDisposalFilter()">✕ Clear</button>' : '')
      + '</div>' : '')
      // Table or empty
      + (!dc ? (disposals.length === 0
        ? '<div class="empty-state" style="padding:1.5rem;margin-top:12px"><div class="empty-icon">◇</div><p>No disposals yet — they appear automatically when you log a SELL trade.</p></div>'
        : fDisposals.length === 0
          ? '<div class="empty-state" style="padding:1.5rem;margin-top:12px"><div class="empty-icon">◇</div><p>No disposals match your filters.</p></div>'
          : '<div class="table-wrap" style="margin-top:12px"><table class="tbl-stack">'
          + '<thead><tr><th>Sale Date</th><th>Ticker</th><th>Qty</th><th>Sale Price</th><th>Parcel Date</th><th>Cost/Share</th><th>Cost Base</th><th>Proceeds</th><th>Sale Fee</th><th>Gross Gain</th><th>Held</th><th>50% Disc.</th><th>Net CGT Gain</th></tr></thead>'
          + '<tbody>'
          + fDisposals.map(d => '<tr>'
            + '<td data-label="Sale Date" class="text-xs">' + d.saleDate + '</td>'
            + '<td data-label="Ticker"><strong>' + d.ticker + '</strong>'
            + (isRealTrade(d)
                ? ' <span class="badge" style="font-size:9px;padding:1px 5px;background:#16a34a22;color:#16a34a" title="Real disposal — included in tax exports">● LIVE</span>'
                : ' <span class="badge badge-drp" style="font-size:9px;padding:1px 5px" title="Paper disposal — simulated; EXCLUDED from all tax exports">◦ PAPER</span>')
            + '</td>'
            + '<td data-label="Qty">' + d.saleQty + '</td>'
            + '<td data-label="Sale Price">$' + fmt(d.salePrice) + '</td>'
            + '<td data-label="Parcel Date" class="text-xs">' + (d.parcelDate || '<span class="text-muted">Unknown</span>') + '</td>'
            + '<td data-label="Cost/Share">$' + fmt(d.parcelCostPerShare) + '</td>'
            + '<td data-label="Cost Base">$' + fmt(d.costBase) + '</td>'
            + '<td data-label="Proceeds">$' + fmt(d.proceeds) + '</td>'
            + '<td data-label="Sale Fee" class="text-xs">$' + fmt(d.saleFee) + '</td>'
            + '<td data-label="Gross Gain" class="' + (d.grossGain>=0?'text-success':'text-danger') + '">' + (d.grossGain>=0?'+':'') + '$' + fmt(Math.abs(d.grossGain)) + '</td>'
            + '<td data-label="Held" class="text-xs">' + (d.heldDays != null ? d.heldDays+'d' : '?') + '</td>'
            + '<td data-label="50% Disc.">' + (d.eligible50 && d.grossGain > 0 ? '<span class="badge badge-executed">−$'+fmt(d.discount)+'</span>' : '<span class="text-xs text-muted">—</span>') + '</td>'
            + '<td data-label="Net CGT Gain" class="' + (d.netGain>=0?'text-success':'text-danger') + '" style="font-weight:600">' + (d.netGain>=0?'+':'') + '$' + fmt(Math.abs(d.netGain)) + '</td>'
            + '</tr>'
          ).join('')
          + '</tbody>'
          + '<tfoot><tr style="border-top:1px solid var(--border-medium);font-weight:600">'
          + '<td colspan="9" style="padding:8px 12px;font-size:12px">' + (hasFilter ? 'Filtered totals ('+fDisposals.length+' of '+disposals.length+')' : 'All-time totals') + '</td>'
          + '<td class="' + (fGross>=0?'text-success':'text-danger') + '">' + (fGross>=0?'+':'') + '$' + fmt(Math.abs(fGross)) + '</td>'
          + '<td></td>'
          + '<td class="text-success">−$' + fmt(fDisc) + '</td>'
          + '<td class="' + (fNet>=0?'text-success':'text-danger') + '">' + (fNet>=0?'+':'') + '$' + fmt(Math.abs(fNet)) + '</td>'
          + '</tr></tfoot>'
          + '</table></div>'
      ) : '')
      + '</div>';
    })()}

    <!-- ② OPEN PARCELS (filtered, collapsible) -->
    ${(()=>{
      const pf = window._cgtFilter.parcel;
      const allOpen = parcels.filter(p => p.remainingQty > 0);
      // Build filtered tickerMap
      const filteredTickerMap = {};
      parcels.forEach(p => {
        if (p.remainingQty <= 0) return;
        if (pf.ticker && !p.ticker.includes(pf.ticker.toUpperCase())) return;
        if (pf.discount !== 'all') {
          const held = daysBetween(p.date, today);
          if (pf.discount === 'eligible' && held < 365) return;
          if (pf.discount === 'ineligible' && held >= 365) return;
        }
        if ((pf.mode||'all') !== 'all' && (p.mode || 'paper') !== pf.mode) return;
        if (!filteredTickerMap[p.ticker]) filteredTickerMap[p.ticker] = [];
        filteredTickerMap[p.ticker].push(p);
      });
      const filteredLots = Object.values(filteredTickerMap).flat();
      const hasFilter = pf.ticker || pf.discount !== 'all' || (pf.mode||'all') !== 'all';
      const selS = 'style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-secondary);color:var(--text-primary);font-size:11px;font-family:var(--font)"';
      const allTickers = [...new Set(allOpen.map(p=>p.ticker))].sort();
      let html = '<div class="card">';
      html += '<div class="flex-between" style="cursor:pointer;user-select:none" onclick="window._cgtCollapsed.parcels=!window._cgtCollapsed.parcels;renderPage()">';
      html += '<div class="card-title" style="margin:0">'
        + '<span style="margin-right:8px;font-size:11px;color:var(--text-tertiary)">' + (pc?'▶':'▼') + '</span>'
        + 'Open Parcels'
        + '<span class="text-xs text-muted" style="margin-left:8px;font-weight:400">' + (hasFilter ? filteredLots.length + ' shown of ' + allOpen.length : allOpen.length + ' lot' + (allOpen.length!==1?'s':'') + ' · ' + allOpen.reduce((s,p)=>s+p.remainingQty,0) + ' shares') + '</span>'
        + '</div>';
      html += '<div class="flex-row" style="gap:6px" onclick="event.stopPropagation()">'
        + '<button class="btn btn-sm" onclick="addParcelManually()">+ Add Parcel</button>'
        + '<button class="btn btn-sm btn-primary" onclick="exportDisposalCSV()">↓ Export CGT CSV</button>'
        + '<span class="btn btn-sm">' + (pc?'Expand':'Collapse') + '</span>'
        + '</div></div>';
      if (!pc) {
        // Filter bar
        html += '<div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 12px;margin-top:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">';
        html += '<div><div class="form-label" style="margin-bottom:3px">Ticker</div><input type="text" placeholder="e.g. BHP" value="' + pf.ticker + '" oninput="setCgtParcelFilter(\'ticker\',this.value.toUpperCase())" style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:11px;width:80px"></div>';
        html += '<div><div class="form-label" style="margin-bottom:3px">CGT Discount</div><select onchange="setCgtParcelFilter(\'discount\',this.value)" ' + selS + '>'
          + '<option value="all"' + (pf.discount==='all'?' selected':'') + '>All parcels</option>'
          + '<option value="eligible"' + (pf.discount==='eligible'?' selected':'') + '>50% eligible (>12mo)</option>'
          + '<option value="ineligible"' + (pf.discount==='ineligible'?' selected':'') + '>Not yet eligible</option>'
          + '</select></div>';
        html += '<div><div class="form-label" style="margin-bottom:3px">Book</div><select onchange="setCgtParcelFilter(\'mode\',this.value)" ' + selS + '>'
          + '<option value="all"' + ((pf.mode||'all')==='all'?' selected':'') + '>All</option>'
          + '<option value="real"' + (pf.mode==='real'?' selected':'') + '>● Live</option>'
          + '<option value="paper"' + (pf.mode==='paper'?' selected':'') + '>◦ Paper</option>'
          + '</select></div>';
        if (allTickers.length > 0) {
          html += '<div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center"><span class="text-xs text-muted" style="white-space:nowrap">Quick:</span><button class="btn btn-sm ' + (!pf.ticker?'btn-primary':'') + '" style="font-size:11px;padding:2px 8px" onclick="setCgtParcelFilter(\'ticker\',\'\')">All</button>';
          html += allTickers.map(t => '<button class="btn btn-sm ' + (pf.ticker===t?'btn-primary':'') + '" style="font-size:11px;padding:2px 8px" onclick="setCgtParcelFilter(\'ticker\',\''+t+'\')">'+t+'</button>').join('');
          html += '</div>';
        }
        if (hasFilter) html += '<button class="btn btn-sm" onclick="resetCgtParcelFilter()">✕ Clear</button>';
        html += '</div>';
        // Table
        if (allOpen.length === 0) {
          html += '<div class="empty-state" style="padding:1.5rem;margin-top:12px"><div class="empty-icon">◈</div><p>No parcels yet. Log trades via the Trade Journal or click <strong>+ Add Parcel</strong>.</p></div>';
        } else if (filteredLots.length === 0) {
          html += '<div class="empty-state" style="padding:1.5rem;margin-top:12px"><div class="empty-icon">◈</div><p>No parcels match your filters.</p></div>';
        } else {
          html += '<div style="margin-top:12px">';
          for (const [ticker, tParcels] of Object.entries(filteredTickerMap)) {
            const holding = getPortfolioHolding(ticker);
            const currentPrice = holding ? holding.currentPrice : 0;
            const openParcels = tParcels.filter(p => p.remainingQty > 0);
            if (!openParcels.length) continue;
            html += '<div style="margin-bottom:1.25rem">';
            html += '<div class="flex-between" style="margin-bottom:6px"><div class="flex-row">'
              + '<strong style="font-size:14px">' + ticker + '</strong>'
              + '<span class="text-xs text-muted">' + openParcels.length + ' lot' + (openParcels.length!==1?'s':'') + ' · ' + openParcels.reduce((s,p)=>s+p.remainingQty,0) + ' shares</span>'
              + (currentPrice ? '<span class="text-xs text-muted">Current: $' + fmt(currentPrice) + '</span>' : '')
              + '</div></div>';
            html += '<div class="table-wrap"><table class="tbl-stack">'
              + '<thead><tr>'
              + '<th>Parcel #</th><th>Buy Date</th><th>Held</th><th>Discount?</th>'
              + '<th>Original Qty</th><th>Remaining</th><th>Cost/Share</th><th>Buy Fee</th>'
              + '<th>Cost Base</th>' + (currentPrice ? '<th>Unrealised P&L</th>' : '')
              + '<th>Est. Net CGT<br><span style="font-weight:400;font-size:10px">if sold today @ $' + fmt(currentPrice||0) + '</span></th>'
              + '<th></th>'
              + '</tr></thead><tbody>';
            openParcels.sort((a,b)=>a.date.localeCompare(b.date)).forEach(p => {
              const held = daysBetween(p.date, today);
              const eligible = held >= 365;
              const costBase = p.remainingQty * p.costPerShare + (p.fees * p.remainingQty / p.qty);
              const proceeds = currentPrice ? p.remainingQty * currentPrice : null;
              const unrealPnl = proceeds != null ? proceeds - costBase : null;
              let estNetCgt = null;
              if (proceeds != null) {
                const grossG = proceeds - costBase;
                estNetCgt = grossG - (eligible && grossG > 0 ? grossG * 0.5 : 0);
              }
              html += '<tr>'
                + '<td data-label="Parcel #" class="text-xs text-muted">#' + p.id
                + (p.action === 'DRP' ? ' <span class="badge badge-drp" style="font-size:9px;padding:1px 5px">DRP</span>' : '')
                + (isRealTrade(p)
                    ? ' <span class="badge" style="font-size:9px;padding:1px 5px;background:#16a34a22;color:#16a34a" title="Real lot — included in tax exports">● LIVE</span>'
                    : ' <span class="badge badge-drp" style="font-size:9px;padding:1px 5px" title="Paper lot — simulated; EXCLUDED from all tax exports">◦ PAPER</span>')
                + '</td>'
                + '<td data-label="Buy Date" class="text-xs">' + p.date + '</td>'
                + '<td data-label="Held" class="text-xs">' + held + 'd</td>'
                + '<td data-label="Discount?">' + (eligible ? '<span class="badge badge-executed">50% ✓</span>' : '<span class="badge badge-pending">' + (365-held) + 'd left</span>') + '</td>'
                + '<td data-label="Original Qty">' + p.qty + '</td>'
                + '<td data-label="Remaining"><strong>' + p.remainingQty + '</strong>' + (p.remainingQty < p.qty ? '<span class="text-xs text-muted"> (' + (p.qty-p.remainingQty) + ' sold)</span>' : '') + '</td>'
                + '<td data-label="Cost/Share">$' + fmt(p.costPerShare) + '</td>'
                + '<td data-label="Buy Fee" class="text-xs">$' + fmt(p.fees) + '</td>'
                + '<td data-label="Cost Base">$' + fmt(costBase) + '</td>'
                + (currentPrice ? '<td data-label="Unrealised P&L" class="' + (unrealPnl!=null?(unrealPnl>=0?'text-success':'text-danger'):'') + '">' + (unrealPnl!=null?(unrealPnl>=0?'+':'')+'$'+fmt(Math.abs(unrealPnl)):'—') + '</td>' : '')
                + '<td data-label="Est. Net CGT" class="' + (estNetCgt!=null?(estNetCgt>=0?'text-success':'text-danger'):'') + ' text-xs">'
                  + (estNetCgt!=null?(estNetCgt>=0?'+':'')+'$'+fmt(Math.abs(estNetCgt)):'—')
                  + (eligible&&estNetCgt!=null&&estNetCgt>0?'<br><span style="color:var(--text-tertiary);font-size:10px">disc. applied</span>':'')
                + '</td>'
                + '<td data-label="Actions"><button class="btn btn-sm btn-danger" onclick="deleteParcel(' + p.id + ')">✕</button></td>'
                + '</tr>';
            });
            html += '</tbody></table></div></div>';
          }
          html += '</div>';
        }
      }
      html += '</div>';
      return html;
    })()}

    <!-- ③ TAX-LOSS HARVEST PLANNER -->
    ${(()=>{
      const openParcels = parcels.filter(p => p.remainingQty > 0);
      if (!openParcels.length) return '';

      // Build losers: open parcels where current price < cost/share
      const losers = [];
      const holdingsMap = {};
      for (const h of state.portfolio) holdingsMap[h.ticker] = h.currentPrice;

      for (const p of openParcels) {
        const cp = holdingsMap[p.ticker];
        if (!cp) continue;
        const costBase  = p.remainingQty * p.costPerShare + (p.fees * p.remainingQty / p.qty);
        const proceeds  = p.remainingQty * cp;
        const unrLoss   = proceeds - costBase;
        if (unrLoss >= 0) continue;
        // Check wash-sale risk: any BUY trade in the last 30 days for same ticker
        const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0,10).replace(/-/g,'-');
        const recentBuy = (state.tradeJournal || []).some(t => {
          if (t.ticker !== p.ticker || (t.action||'').toUpperCase() !== 'BUY') return false;
          return t.date >= thirtyAgo;
        });
        losers.push({ ...p, costBase, proceeds, unrLoss, currentPrice: cp, washSaleRisk: recentBuy });
      }

      losers.sort((a, b) => a.unrLoss - b.unrLoss); // worst loss first

      if (!losers.length) return `
        <div class="card" style="margin-top:1rem">
          <div class="card-title">Tax-Loss Harvest Planner</div>
          <div class="text-xs text-muted">No unrealised losses on open parcels to harvest this FY.</div>
        </div>`;

      const totalHarvestable = losers.reduce((s, l) => s + l.unrLoss, 0);
      const netAfterHarvest  = fyGross + totalHarvestable; // fyGross - |loss|

      // EOFY countdown
      const now2 = new Date();
      const fyEndYear = now2.getMonth() >= 6 ? now2.getFullYear() + 1 : now2.getFullYear();
      const fyEnd  = new Date(`${fyEndYear}-06-30`);
      const daysToEOFY = Math.max(0, Math.ceil((fyEnd - now2) / 86400000));

      return `
        <div class="card" style="margin-top:1rem">
          <div class="flex-between" style="margin-bottom:1rem">
            <div>
              <div class="card-title" style="margin:0">Tax-Loss Harvest Planner</div>
              <div class="text-xs text-muted" style="margin-top:3px">Open parcels with unrealised losses you could sell before EOFY to offset capital gains.</div>
            </div>
            <div style="text-align:right">
              <div class="text-xs text-muted">EOFY 30 Jun ${fyEndYear}</div>
              <div style="font-size:18px;font-weight:700;color:${daysToEOFY <= 30 ? '#dc2626' : 'var(--text-primary)'}">${daysToEOFY}d</div>
            </div>
          </div>

          <div class="metrics-grid" style="margin-bottom:1rem">
            <div class="metric-card">
              <div class="metric-label">FY Realised Gain (net)</div>
              <div class="metric-value ${fyNet >= 0 ? 'up' : 'down'}">${fyNet >= 0 ? '+' : ''}$${fmt(Math.abs(fyNet))}</div>
              <div class="metric-sub">Available to offset</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Max Harvestable Loss</div>
              <div class="metric-value down">−$${fmt(Math.abs(totalHarvestable))}</div>
              <div class="metric-sub">${losers.length} parcel${losers.length !== 1 ? 's' : ''} combined</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Net CGT After Harvest</div>
              <div class="metric-value ${netAfterHarvest >= 0 ? 'up' : 'down'}">${netAfterHarvest >= 0 ? '+' : ''}$${fmt(Math.abs(netAfterHarvest))}</div>
              <div class="metric-sub">${netAfterHarvest < 0 ? 'Surplus loss carries forward' : 'Remaining taxable gain'}</div>
            </div>
          </div>

          <div class="table-wrap">
            <table class="tbl-stack">
              <thead><tr>
                <th>Ticker</th><th>Parcel</th><th>Qty</th><th>Cost/Share</th><th>Current</th><th>Cost Base</th><th>Proceeds</th><th>Unr. Loss</th><th>Held</th><th>Wash-Sale?</th>
              </tr></thead>
              <tbody>
                ${losers.map(l => {
                  const held = daysBetween(l.date, today);
                  return `<tr>
                    <td data-label="Ticker"><strong>${l.ticker}</strong></td>
                    <td data-label="Parcel" class="text-xs text-muted">#${l.id} · ${l.date}</td>
                    <td data-label="Qty">${l.remainingQty}</td>
                    <td data-label="Cost/Share">$${fmt(l.costPerShare)}</td>
                    <td data-label="Current">$${fmt(l.currentPrice)}</td>
                    <td data-label="Cost Base">$${fmt(l.costBase)}</td>
                    <td data-label="Proceeds">$${fmt(l.proceeds)}</td>
                    <td data-label="Unr. Loss" class="text-danger" style="font-weight:600">−$${fmt(Math.abs(l.unrLoss))}</td>
                    <td data-label="Held" class="text-xs">${held}d${held >= 365 ? ' <span class="badge badge-executed">CGT disc.</span>' : ''}</td>
                    <td data-label="Wash-Sale?">${l.washSaleRisk ? '<span class="badge badge-pending" title="Bought same ticker in last 30 days — may trigger wash-sale rules">⚠ Risk</span>' : '<span class="text-xs text-muted">—</span>'}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
          <div class="text-xs text-muted" style="margin-top:8px">
            ⚠ Wash-sale warning: selling a parcel at a loss and repurchasing the same ticker within 30 days may disallow the loss deduction. Seek tax advice before acting.
          </div>
        </div>`;
    })()}

  ${_buildFranking45DayCard()}
  `;
}

function _buildFranking45DayCard() {
  // The 45-day rule: hold shares "at risk" for ≥45 days (within 45 days before/after ex-div)
  // to claim the franking credit offset. Days run from day after purchase to day of sale inclusive.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const warnings = [];
  const eligible = [];

  (state.cgtParcels || []).filter(p => p.remainingQty > 0).forEach(p => {
    const div = state.dividendData[p.ticker];
    if (!div?.exDividendDate) return;
    const exDate = new Date(div.exDividendDate.slice(0, 10));

    let purchaseDate = null;
    if (p.date) {
      const parts = p.date.split('-');
      if (parts.length === 3 && parts[2].length === 4) {
        purchaseDate = new Date(+parts[2], +parts[1] - 1, +parts[0]);
      } else {
        purchaseDate = new Date(p.date);
      }
    }
    if (!purchaseDate || isNaN(purchaseDate)) return;

    // Days held since purchase
    const heldDays = Math.floor((today - purchaseDate) / 86400000);
    // Days since ex-div (negative = ex-div is in the future)
    const daysSinceExDiv = Math.floor((today - exDate) / 86400000);

    if (daysSinceExDiv >= 0 && daysSinceExDiv <= 90) {
      // Ex-div has passed — need 45 days post-purchase, and purchase must have been ≤45 days before ex-div
      const daysBeforeExDiv = Math.floor((exDate - purchaseDate) / 86400000);
      const meetsPre  = daysBeforeExDiv >= 0 && daysBeforeExDiv <= 45;
      const meetsPost = heldDays >= 45;
      if (meetsPre && !meetsPost) {
        const daysNeeded = 45 - heldDays;
        warnings.push({ ticker: p.ticker, parcelId: p.id, qty: p.remainingQty, exDate, daysNeeded, issue: `Hold ${daysNeeded} more day(s) after purchase to qualify`, stage: 'holding' });
      } else if (meetsPre && meetsPost) {
        eligible.push({ ticker: p.ticker, parcelId: p.id, qty: p.remainingQty, exDate });
      }
    } else if (daysSinceExDiv < 0) {
      // Ex-div is upcoming — check if purchase is within the 45-day window before ex-div
      const daysToExDiv = Math.abs(daysSinceExDiv);
      const mustHoldAfter = new Date(exDate); mustHoldAfter.setDate(mustHoldAfter.getDate() + 45);
      if (daysToExDiv <= 45) {
        // Bought within 45 days of ex-div — must hold until 45 days post-ex-div
        const daysToCompliance = Math.ceil((mustHoldAfter - today) / 86400000);
        warnings.push({ ticker: p.ticker, parcelId: p.id, qty: p.remainingQty, exDate, daysNeeded: daysToCompliance, issue: `Hold until ${mustHoldAfter.toLocaleDateString('en-AU')} (${daysToCompliance}d) for franking eligibility`, stage: 'pre-exdiv' });
      }
    }
  });

  if (!warnings.length && !eligible.length) return '';

  const warnRows = warnings.map(w => `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:0.5px solid var(--border-light)">
      <span style="font-size:14px;flex-shrink:0">⚠️</span>
      <div>
        <div style="font-size:12px;font-weight:600">${w.ticker} — parcel #${w.parcelId} (${w.qty} sh)</div>
        <div class="text-xs text-muted">${w.issue} · ex-div: ${w.exDate.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})}</div>
      </div>
    </div>`).join('');

  const eligRows = eligible.map(e => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0">
      <span style="color:#16a34a;font-weight:700;font-size:13px">✓</span>
      <span style="font-size:12px">${e.ticker} parcel #${e.parcelId} — franking eligible (ex-div ${e.exDate.toLocaleDateString('en-AU',{day:'numeric',month:'short'})})</span>
    </div>`).join('');

  return `
    <div class="card section-gap">
      <div class="card-title">Franking Credit — 45-Day Rule</div>
      <p class="text-xs text-muted" style="margin-bottom:10px">
        To claim franking credits you must hold shares "at risk" for 45+ days around the ex-dividend date (30 days if ≤$5000 total franking).
        Selling too early forfeits the offset.
      </p>
      ${warnRows ? `<div style="margin-bottom:10px">${warnRows}</div>` : ''}
      ${eligRows}
      ${!warnRows && !eligRows ? '<div class="text-xs text-muted">No parcels with upcoming ex-div dates in dividend data. Load dividends first.</div>' : ''}
    </div>`;
}
