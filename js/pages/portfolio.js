// ============================================================
// PORTFOLIO
// ============================================================
function renderPortfolio() {
  const pv = portfolioValue();
  const merged = mergedPortfolio();
  return `
    <div class="flex-between section-gap">
      <div class="flex-row">
        <span class="text-sm text-muted">Invested: <strong>$${fmt(totalCost())}</strong></span>
        <span class="text-sm text-muted">Market value: <strong>$${fmt(pv)}</strong></span>
      </div>
      <div class="flex-row">
        <button class="btn btn-sm" onclick="document.getElementById('csvUpload').click()" title="Import simple CSV (ticker, shares, avg_price, date)">↑ Import CSV</button>
        <input type="file" id="csvUpload" accept=".csv" style="display:none" onchange="handleCSV(event)">
        <button class="btn btn-sm" onclick="document.getElementById('brokerCsvUpload').click()" title="Import CommSec or SelfWealth trade history CSV">↑ Broker CSV</button>
        <input type="file" id="brokerCsvUpload" accept=".csv" style="display:none" onchange="handleBrokerCSV(event)">
        <button class="btn btn-sm" onclick="refreshPrices()">⟳ Live Prices</button>
        <button class="btn btn-sm btn-primary" onclick="addHolding()">+ Add Holding</button>
      </div>
    </div>

    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-label">Total Invested</div><div class="metric-value">$${fmt(totalCost())}</div></div>
      <div class="metric-card"><div class="metric-label">Market Value</div><div class="metric-value">$${fmt(pv)}</div></div>
      <div class="metric-card"><div class="metric-label">Unrealised P&L</div><div class="metric-value ${totalGain()>=0?'up':'down'}">${sign(totalGain())}$${fmt(Math.abs(totalGain()))}</div></div>
      <div class="metric-card"><div class="metric-label">Cash Available</div><div class="metric-value">$${fmt(viewCash())}</div>${(()=>{
        // Show the real/paper split under Cash when both pools are in play (gotcha #88 Phase D).
        const vm = state.portfolioViewMode || 'all';
        const pc = Number(state.paperCash) || 0;
        if (vm === 'all' && pc > 0) return `<div class="text-xs text-muted">$${fmt(state.cash)} live · $${fmt(pc)} paper</div>`;
        if (vm === 'paper') return `<div class="text-xs text-muted">paper cash</div>`;
        if (vm === 'real')  return `<div class="text-xs text-muted">live cash</div>`;
        return '';
      })()}</div>
      ${(()=>{
        const annualIncome = merged.reduce((sum, h) => {
          const d = state.dividendData[h.ticker];
          if (d && d.annualDivPerShare != null) return sum + h.shares * d.annualDivPerShare;
          return sum;
        }, 0);
        const yieldOnCost = totalCost() > 0 ? (annualIncome / totalCost()) * 100 : 0;
        return annualIncome > 0 ? `
          <div class="metric-card">
            <div class="metric-label">Est. Annual Div Income</div>
            <div class="metric-value text-success">$${fmt(annualIncome)}</div>
            <div class="metric-sub" title="Annual dividend income ÷ original cost basis (avg purchase price). See Morning Macro for the same income ÷ current market value figure — they differ when price has moved since purchase.">${fmt(yieldOnCost)}% yield on cost</div>
          </div>` : '';
      })()}
    </div>

    ${(()=>{
      const warnings = state._splitWarnings;
      if (!warnings) return '';
      const splits = Object.entries(warnings).filter(([, v]) => v && v.length > 0);
      if (!splits.length) return '';
      const items = splits.map(([t, events]) =>
        events.map(e => `<strong>${t}</strong>: ${e.ratio}:1 split on ${e.date}`).join(', ')
      ).join('; ');
      // Build per-split apply buttons
      const applyBtns = splits.map(([t, events]) =>
        events.map(e => `<button class="btn btn-sm" style="background:#f59e0b;color:#fff;border-color:#d97706;margin-top:6px;margin-right:4px" onclick="applySplitAdjustment('${t}',${e.ratio},'${e.date}')">Apply ${t} ${e.ratio}:1 split</button>`).join('')
      ).join('');
      return `
      <div class="critical-alert-banner" style="border-color:#f59e0b;background:#fffbeb;color:#92400e;margin-bottom:12px">
        <span style="font-size:16px">⚠️</span>
        <div style="flex:1">
          <div style="font-weight:600;margin-bottom:2px">Recent stock split detected — verify your cost base</div>
          <div style="font-size:12px">${items}. Click below to auto-adjust shares, avg price, and CGT parcels.</div>
          <div>${applyBtns}</div>
        </div>
      </div>`;
    })()}

    ${(()=>{
      const crw = state._capitalReturnWarnings;
      if (!crw) return '';
      const flagged = Object.entries(crw).filter(([, v]) => v && v.length > 0);
      if (!flagged.length) return '';
      const items = flagged.map(([t, events]) =>
        events.map(e => `<strong>${t}</strong>: ${e.amount_pct}% payment on ${e.date} ($${e.amount}/share)`).join(', ')
      ).join('; ');
      return `
      <div class="critical-alert-banner" style="border-color:#f97316;background:#fff7ed;color:#9a3412;margin-bottom:12px">
        <span style="font-size:16px">💰</span>
        <div style="flex:1">
          <div style="font-weight:600;margin-bottom:2px">Large distribution detected — verify your cost base</div>
          <div style="font-size:12px">${items}. Payments ≥5% of current price may be special dividends or capital returns that reduce your cost base for CGT purposes. Check your broker confirmation and update your CGT parcels if required.</div>
        </div>
      </div>`;
    })()}

    ${merged.length === 0 ? _emptyCard('⬢',
      'No holdings yet',
      'Add your first trade to start tracking your portfolio. Import a broker CSV to bulk-load positions, or add holdings manually below.',
      `<button class="btn btn-primary" onclick="document.getElementById('brokerCsvUpload').click()">↑ Import Broker CSV</button>
       <button class="btn" style="margin-left:8px" onclick="showPage('journal')">+ Add Trade Manually</button>`) : ''}

    ${(()=>{
      const _ACCT_LABELS = { all:'All accounts', personal:'Personal', super:'Super', trading:'Trading' };
      const _ACCT_COLORS = { personal:'#6366f1', super:'#16a34a', trading:'#d97706' };
      const cur = state.activeAccount || 'all';
      return `<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">
        ${['all','personal','super','trading'].map(a => `
          <button class="btn btn-sm" style="${a===cur?'background:var(--accent-primary);color:#fff;border-color:var(--accent-primary)':''}" onclick="state.activeAccount='${a}';renderPage()">${_ACCT_LABELS[a]}</button>
        `).join('')}
        ${cur !== 'all' ? `<span class="text-xs text-muted" style="align-self:center;margin-left:4px">Viewing ${_ACCT_LABELS[cur]} account — analysis and signals use this account's holdings only.</span>` : ''}
      </div>`;
    })()}

    ${(()=>{
      // Paper/real view-mode toggle (gotcha #88 Phase D). Default 'all' shows both,
      // distinguished by per-row LIVE/PAPER badges. NAV history + tax stay real-only
      // regardless. Only surfaced once a paper position/cash actually exists, so a
      // pure-real user never sees clutter.
      const hasPaper = (state.portfolio || []).some(h => (h.mode||'paper') !== 'real')
        || (Number(state.paperCash) || 0) > 0;
      if (!hasPaper) return '';
      const _VM_LABELS = { all:'All', real:'● Live only', paper:'◦ Paper only' };
      const vm = state.portfolioViewMode || 'all';
      return `<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;align-items:center">
        <span class="text-xs text-muted" style="margin-right:2px">Trade mode:</span>
        ${['all','real','paper'].map(m => `
          <button class="btn btn-sm" style="${m===vm?'background:var(--accent-primary);color:#fff;border-color:var(--accent-primary)':''}" onclick="state.portfolioViewMode='${m}';renderPage()">${_VM_LABELS[m]}</button>
        `).join('')}
        <span class="text-xs text-muted" style="align-self:center;margin-left:4px">Paper trades are simulated — excluded from CGT/EOFY, real cash &amp; real performance.</span>
      </div>`;
    })()}

    <div style="display:grid;grid-template-columns:1fr 220px;gap:12px;align-items:start;margin-bottom:12px">
    <div class="card">
      <div class="flex-between" style="margin-bottom:10px">
        <div class="card-title" style="margin:0">Holdings</div>
        <div class="flex-row" style="gap:8px">
          <span class="text-xs text-muted">Click a row to expand individual buy lots</span>
          <button class="btn btn-sm" onclick="fetchDividends(state.portfolio.map(h=>h.ticker),true).then(renderPage)" title="Refresh dividend data">⟳ Dividends</button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="tbl-stack">
          <thead><tr><th></th><th>Ticker</th><th>Sector</th>${state.activeAccount==='all'?'<th>Account</th>':''}<th>Lots</th><th>Total Shares</th><th>Avg Cost</th><th>Current</th><th>Value</th><th>P&L ($)</th><th>P&L (%)</th><th>Weight</th><th>Div Yield</th><th title="Franking percentage — 100% = fully franked (tax credit included)">Franking</th><th>Ex-Div Date</th><th></th></tr></thead>
          <tbody>
            ${merged.slice().sort((a, b) => (b.shares * b.currentPrice) - (a.shares * a.currentPrice)).map(h => {
              const val = h.shares * h.currentPrice;
              const pl  = (h.currentPrice - h.avgPrice) * h.shares;
              const plp = ((h.currentPrice - h.avgPrice) / h.avgPrice) * 100;
              const _pts = state.priceTimestamps && state.priceTimestamps[h.ticker];
              const _stale = _pts && (Date.now() - new Date(_pts).getTime()) > 25 * 60 * 1000;
              const _staleBadge = _stale ? '<span class="text-xs" style="color:#f59e0b;margin-left:3px" title="Price data older than 25 min">⚠ stale</span>' : '';
              // Find state.portfolio entries for this ticker in the same account only —
              // WES personal and WES trading are separate rows and must not share an index.
              const hAcct = h.account || 'personal';
              const hMode = h.mode || 'paper';
              // Filter parcels by account AND mode (gotcha #88) so a paper WES row
              // only counts/shows its own paper parcels, never the real ones.
              const openParcels = state.cgtParcels.filter(p => p.ticker === h.ticker && p.remainingQty > 0 && (p.account || 'personal') === hAcct && (p.mode || 'paper') === hMode);
              const lots = openParcels.length;
              const rawEntries = state.portfolio.filter(e => e.ticker === h.ticker && (e.account || 'personal') === hAcct && (e.mode || 'paper') === hMode);
              const portfolioIdx = state.portfolio.findIndex(e => e.ticker === h.ticker && (e.account || 'personal') === hAcct && (e.mode || 'paper') === hMode);
              // Always expandable when there's at least one lot — per-lot account
              // reassignment + split controls live in the expanded row, so even a
              // single-lot holding needs to be reachable (not just multi-lot ones).
              const hasMulti = lots > 0;
              // Dividend data
              const dv = state.dividendData[h.ticker];
              const divYieldStr = dv && dv.dividendYield != null
                ? `<span class="text-success">${(dv.dividendYield*100).toFixed(2)}%</span><span class="text-xs text-muted" style="display:block">${dv.frequencyLabel||''}</span>`
                : '<span class="text-muted text-xs">—</span>';
              const exDivStr = dv && dv.exDividendDate
                ? `<span class="text-xs">${dv.exDividendDate}</span>${dv.nextEstAmount != null ? `<span class="text-xs text-muted" style="display:block">est $${dv.nextEstAmount.toFixed(4)}</span>` : ''}`
                : '<span class="text-muted text-xs">—</span>';
              const frankingStr = dv
                ? (dv.frankingPct != null
                    ? `<span class="${dv.frankingPct===100?'text-success':dv.frankingPct===0?'text-muted':''}" style="font-size:12px">${dv.frankingPct.toFixed(0)}%</span>`
                    : '<span class="text-muted text-xs">—</span>')
                : '<span class="text-muted text-xs">—</span>';
              const _ACCT_COLORS = {personal:'#6366f1',super:'#16a34a',trading:'#d97706'};
              const acct = h.account || 'personal';
              // Display-only — account is now reassigned per-lot (expand row below),
              // not per whole holding, since a holding can be split across accounts.
              const acctBadge = state.activeAccount === 'all'
                ? `<td data-label="Account"><span class="text-xs" style="background:${_ACCT_COLORS[acct]}22;color:${_ACCT_COLORS[acct]};padding:1px 5px;border-radius:3px" title="Expand lots below to reassign individual lots">${acct}</span></td>`
                : '';
              const _lotsKey = `${h.ticker}-${hAcct}-${hMode}`;
              // LIVE/PAPER badge (gotcha #88 Phase D) — always shown so real and
              // paper rows are unambiguous even in the default 'all' view.
              const modeBadge = hMode === 'real'
                ? '<span class="badge" style="margin-left:4px;font-size:9px;background:#16a34a22;color:#16a34a" title="Live/real trade — counts toward CGT, real cash & real performance">● LIVE</span>'
                : '<span class="badge badge-drp" style="margin-left:4px;font-size:9px" title="Paper trade — simulated; excluded from CGT, real cash & real performance">◦ PAPER</span>';
              return `
                <tr style="cursor:${hasMulti?'pointer':'default'}" onclick="${hasMulti?`toggleLots('${_lotsKey}')`:''}" title="${hasMulti?'Click to expand lots':''}">
                  <td class="m-hide" style="width:20px;text-align:center;color:var(--text-tertiary)">${hasMulti?`<span id="lots-arrow-${_lotsKey}" style="font-size:10px">▶</span>`:'&nbsp;'}</td>
                  <td data-label="Ticker"><strong>${h.ticker}</strong>${modeBadge}</td>
                  <td data-label="Sector"><span class="text-xs">${h.sector}</span></td>
                  ${acctBadge}
                  <td data-label="Lots" class="text-xs text-muted">${lots > 0 ? `${lots} lot${lots!==1?'s':''}` : '—'}</td>
                  <td data-label="Total Shares">${h.shares}</td>
                  <td data-label="Avg Cost">$${fmt(h.avgPrice)}</td>
                  <td data-label="Current">$${fmt(h.currentPrice)}${_staleBadge}</td>
                  <td data-label="Value">$${fmt(val)}</td>
                  <td data-label="P&L ($)" class="${pl>=0?'text-success':'text-danger'}">${sign(pl)}$${fmt(Math.abs(pl))}</td>
                  <td data-label="P&L (%)" class="${plp>=0?'text-success':'text-danger'}">${sign(plp)}${fmt(Math.abs(plp))}%</td>
                  <td data-label="Weight" class="text-xs">${fmt((val/pv)*100)}%</td>
                  <td data-label="Div Yield">${divYieldStr}</td>
                  <td data-label="Franking">${frankingStr}</td>
                  <td data-label="Ex-Div Date">${exDivStr}</td>
                  <td data-label="Actions" style="white-space:nowrap">
                    <button class="btn btn-sm" style="background:#ede9fe;color:#6d28d9;border-color:#c4b5fd;margin-right:4px" onclick="event.stopPropagation();showDrpModal('${h.ticker}')" title="Record a Dividend Reinvestment Plan share issue">DRP</button>
                    <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();removeHolding(${portfolioIdx})">✕</button>
                  </td>
                </tr>
                ${hasMulti ? `
                <tr id="lots-${_lotsKey}" style="display:none">
                  <td colspan="15" style="padding:0">
                    <table style="width:100%;background:var(--bg-secondary);border-radius:0">
                      <thead><tr>
                        <td style="width:20px"></td>
                        <th style="padding:6px 12px;font-size:11px;color:var(--text-secondary)">Parcel #</th>
                        <th style="padding:6px 12px;font-size:11px;color:var(--text-secondary)">Buy Date</th>
                        <th style="padding:6px 12px;font-size:11px;color:var(--text-secondary)">Qty (Remaining)</th>
                        <th style="padding:6px 12px;font-size:11px;color:var(--text-secondary)">Cost/Share</th>
                        <th style="padding:6px 12px;font-size:11px;color:var(--text-secondary)">Cost Base</th>
                        <th style="padding:6px 12px;font-size:11px;color:var(--text-secondary)">Mkt Value</th>
                        <th style="padding:6px 12px;font-size:11px;color:var(--text-secondary)">Unrealised P&L</th>
                        <th style="padding:6px 12px;font-size:11px;color:var(--text-secondary)">Held</th>
                        <th style="padding:6px 12px;font-size:11px;color:var(--text-secondary)">50% Disc?</th>
                        <th style="padding:6px 12px;font-size:11px;color:var(--text-secondary)">Account</th>
                        <th style="padding:6px 12px;font-size:11px;color:var(--text-secondary)">Actions</th>
                      </tr></thead>
                      <tbody>
                        ${openParcels.sort((a,b)=>a.date.localeCompare(b.date)).map(p => {
                          const costBase = p.remainingQty * p.costPerShare;
                          const mktVal   = p.remainingQty * h.currentPrice;
                          const lotPl    = mktVal - costBase;
                          const held     = daysBetween(p.date, todayStr());
                          const disc     = held >= 365;
                          const pAcct    = p.account || 'personal';
                          const splittable = p.remainingQty >= p.qty && p.qty > 1;
                          return `<tr>
                            <td></td>
                            <td style="padding:5px 12px;font-size:12px" class="text-muted">#${p.id}</td>
                            <td style="padding:5px 12px;font-size:12px">${p.date}</td>
                            <td style="padding:5px 12px;font-size:12px">${p.remainingQty}${p.remainingQty<p.qty?` <span class="text-muted">(of ${p.qty})</span>`:''}</td>
                            <td style="padding:5px 12px;font-size:12px">$${fmt(p.costPerShare)}</td>
                            <td style="padding:5px 12px;font-size:12px">$${fmt(costBase)}</td>
                            <td style="padding:5px 12px;font-size:12px">$${fmt(mktVal)}</td>
                            <td style="padding:5px 12px;font-size:12px" class="${lotPl>=0?'text-success':'text-danger'}">${sign(lotPl)}$${fmt(Math.abs(lotPl))}</td>
                            <td style="padding:5px 12px;font-size:12px">${held}d</td>
                            <td style="padding:5px 12px;font-size:12px">${disc?'<span class="badge badge-executed">✓ Eligible</span>':`<span class="text-xs text-muted">${365-held}d left</span>`}</td>
                            <td style="padding:5px 12px;font-size:12px">
                              <select style="font-size:11px;padding:1px 4px" onclick="event.stopPropagation()" onchange="event.stopPropagation();setParcelAccount(${p.id}, this.value)">
                                ${['personal','super','trading'].map(a => `<option value="${a}" ${a===pAcct?'selected':''}>${{personal:'Personal',super:'Super',trading:'Trading'}[a]}</option>`).join('')}
                              </select>
                            </td>
                            <td style="padding:5px 12px;font-size:12px;white-space:nowrap">
                              <button class="btn btn-sm" style="font-size:11px;padding:2px 6px" ${splittable?'':'disabled title="Already fully split or partially sold"'}
                                onclick="event.stopPropagation();promptSplitParcel(${p.id})">✂ Split</button>
                            </td>
                          </tr>`;
                        }).join('')}
                      </tbody>
                    </table>
                  </td>
                </tr>` : ''}
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ${_buildSectorSidebar(merged, pv)}
    </div>

    ${(()=>{
      // ── Dividend Income Schedule card ──────────────────────────────────────
      const divRows = mergedPortfolio()
        .map(h => ({ h, d: state.dividendData[h.ticker] }))
        .filter(({d}) => d && !d.error && (d.dividendYield != null || d.annualDivPerShare != null));

      if (!divRows.length) return '';

      // Sort by ex-div date (soonest first; nulls last)
      divRows.sort((a, b) => {
        if (!a.d.exDividendDate && !b.d.exDividendDate) return 0;
        if (!a.d.exDividendDate) return 1;
        if (!b.d.exDividendDate) return -1;
        return a.d.exDividendDate.localeCompare(b.d.exDividendDate);
      });

      const todayISO = new Date().toISOString().slice(0,10);
      const totalAnnualIncome = divRows.reduce((sum, {h, d}) => {
        return sum + (d.annualDivPerShare != null ? h.shares * d.annualDivPerShare : 0);
      }, 0);
      const totalFwdYield = portfolioValue() > 0 ? (totalAnnualIncome / portfolioValue()) * 100 : 0;

      // ── Annualised capital gain (weighted by parcel holding period) ──────────
      // For each open parcel: annualised gain = (currentPrice - costPerShare) / costPerShare / yearsHeld
      // Weighted by cost base to get portfolio-level annualised capital gain %
      const todayMs = Date.now();
      let totalCapGainAnnual = 0; // $ annualised
      let totalCostBase = 0;
      (state.cgtParcels || []).forEach(p => {
        if ((p.remainingQty || 0) <= 0) return;
        const holding = mergedPortfolio().find(h => h.ticker === p.ticker);
        if (!holding || !holding.currentPrice) return;
        const buyDate = parseDate(p.date); // handles DD-MM-YYYY and YYYY-MM-DD
        if (!buyDate || isNaN(buyDate.getTime())) return;
        const yearsHeldRaw = (todayMs - buyDate.getTime()) / (365.25 * 24 * 3600 * 1000);
        // Floor the annualisation denominator at 1 year — dividing by a fraction of
        // a year for recent buys (e.g. 3 days = 0.008y) explodes the annualised figure
        // by 100×.  For positions held < 1y we show the actual total gain/loss %, which
        // is more meaningful than a spurious extrapolated annual rate.
        const yearsHeld = Math.max(yearsHeldRaw, 1);
        const costBase = p.remainingQty * p.costPerShare;
        const mktVal   = p.remainingQty * holding.currentPrice;
        const gain     = mktVal - costBase;
        totalCapGainAnnual += gain / yearsHeld;
        totalCostBase += costBase;
      });
      const totalPortVal = portfolioValue();
      const annCapGainYield = totalPortVal > 0 ? (totalCapGainAnnual / totalPortVal) * 100 : 0;
      const totalReturnYield = totalFwdYield + annCapGainYield;
      const rba = state.rbaRate || 0;
      const divSpread   = totalFwdYield   - rba;
      const totalSpread = totalReturnYield - rba;

      const rows = divRows.map(({h, d}) => {
        const annualIncome = d.annualDivPerShare != null ? h.shares * d.annualDivPerShare : null;
        const yieldOnCost = d.dividendYield != null ? (d.dividendYield * 100).toFixed(2) + '%' : '—';
        const yocReal = h.avgPrice > 0 && d.annualDivPerShare != null
          ? ((d.annualDivPerShare / h.avgPrice) * 100).toFixed(2) + '%' : '—';
        const exStr = d.exDividendDate || '—';
        const isSoon = d.exDividendDate && d.exDividendDate >= todayISO &&
          (new Date(d.exDividendDate) - new Date(todayISO)) / 86400000 <= 30;
        const isPast = d.exDividendDate && d.exDividendDate < todayISO;
        const exCell = isSoon
          ? `<span style="color:#16a34a;font-weight:600">${exStr} ⚡</span>`
          : isPast
          ? `<span class="text-muted">${exStr}</span>`
          : `<span>${exStr}</span>`;
        const nextAmt = d.nextEstAmount != null ? `$${d.nextEstAmount.toFixed(4)}` : '—';
        // Payout ratio = Annual DPS ÷ Trailing EPS (from yfinance).
        // >100% is normal for infrastructure/REITs due to non-cash depreciation eating EPS;
        // use cash-flow payout for those. Flag red only if 80–200%, show a note above 200%.
        const pr = d.payoutRatio;
        const payoutStr = pr != null
          ? pr > 2.0
            ? `<span style="color:#d97706" title="Payout ratio ${(pr*100).toFixed(0)}% — common for trusts/REITs/infrastructure where GAAP EPS understates cash earnings due to depreciation. Not necessarily distressed.">${(pr*100).toFixed(0)}% <span style="font-size:9px">trust</span></span>`
            : `<span class="${pr > 0.8 ? 'text-danger' : ''}" title="Payout ratio: annual dividends ÷ trailing EPS">${(pr*100).toFixed(0)}%</span>`
          : '—';
        // Franking credits
        const fp = d.frankingPct ?? null;
        const frankStr = fp != null
          ? `<span class="${fp===100?'text-success':fp===0?'text-muted':''}">${fp.toFixed(0)}%</span>`
          : '—';
        // Grossed-up yield at 30% corporate tax rate
        const rawYield = d.dividendYield;
        const grossedUp = rawYield != null && fp != null
          ? (rawYield + rawYield * (fp / 100) * (30 / 70)) * 100
          : null;
        const grossedStr = grossedUp != null
          ? `<span class="text-xs text-muted">${grossedUp.toFixed(2)}% gross</span>`
          : '';
        // Data source badge
        const srcBadge = d.source === 'asx+yfinance'
          ? `<span style="font-size:9px;background:#dbeafe;color:#1d4ed8;padding:1px 4px;border-radius:3px">ASX</span>`
          : d.source === 'yfinance'
          ? `<span style="font-size:9px;background:#f3f4f6;color:#6b7280;padding:1px 4px;border-radius:3px">yf</span>`
          : '';
        const payDate = d.paymentDate ? `<span class="text-xs text-muted" style="display:block">pay ${d.paymentDate}</span>` : '';
        return `<tr>
          <td><strong>${h.ticker}</strong> ${srcBadge}<span class="text-xs text-muted" style="display:block">${d.frequencyLabel||''}</span></td>
          <td>${yieldOnCost}${grossedStr ? '<br>'+grossedStr : ''}</td>
          <td>${yocReal}</td>
          <td>${frankStr}</td>
          <td>${nextAmt}</td>
          <td>${exCell}${payDate}</td>
          <td>${payoutStr}</td>
          <td class="text-success">${annualIncome != null ? '$'+fmt(annualIncome) : '—'}</td>
          <td class="text-xs">${d.history?.length ? d.history.slice(0,3).map(x=>`${(x.date||x.ex_date||'').slice(5)}: $${x.amount}`).join('<br>') : '—'}</td>
        </tr>`;
      }).join('');

      return `
    <div class="card section-gap">
      <div class="flex-between" style="margin-bottom:10px">
        <div>
          <div class="card-title" style="margin:0">Dividend Income Schedule</div>
          <div class="text-xs text-muted" style="margin-top:3px;line-height:1.7">
            <span>Est. annual income: <strong class="text-success">$${fmt(totalAnnualIncome)}</strong>
            · <span title="Annual dividend income ÷ current market value (matches Morning Macro's Portfolio Forward Yield). The YoC column below uses cost basis instead — they differ when price has moved since purchase.">Div yield (mkt value): <strong>${fmt(totalFwdYield)}%</strong></span>
            ${annCapGainYield !== 0 ? `· Cap gain: <strong class="${annCapGainYield >= 0 ? 'text-success' : 'text-danger'}" title="Annualised capital gain (floored at 1yr — recent buys show total unrealised %)">${annCapGainYield >= 0 ? '+' : ''}${fmt(annCapGainYield)}%</strong>` : ''}
            · <span title="Dividend yield + annualised capital appreciation">Total return: <strong class="${totalReturnYield >= rba ? 'text-success' : 'text-danger'}">${fmt(totalReturnYield)}%</strong></span>
            · vs RBA ${rba.toFixed(2)}%:
              <span title="Dividend income only vs RBA" class="text-xs" style="margin-left:2px">div <span class="${divSpread >= 0 ? 'text-success' : 'text-danger'}">${divSpread >= 0 ? '+' : ''}${fmt(divSpread)}%</span></span>
              <span style="margin:0 4px;color:#9ca3af">|</span>
              <span title="Total return (dividends + capital gain) vs RBA" class="text-xs">total <span class="${totalSpread >= 0 ? 'text-success' : 'text-danger'}">${totalSpread >= 0 ? '+' : ''}${fmt(totalSpread)}%</span></span>
            </span>
          </div>
        </div>
        <button class="btn btn-sm" onclick="fetchDividends(state.portfolio.map(h=>h.ticker),true).then(renderPage)" title="Refresh all dividend data">⟳ Refresh</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Ticker</th>
            <th title="Forward dividend yield — grossed-up yield shown below (includes franking tax credit at 30% corp tax)">Fwd Yield</th>
            <th title="Yield on your average cost basis">YoC</th>
            <th title="Franking percentage from ASX — 100% = fully franked">Franking</th>
            <th title="Estimated next payment per share">Next Est.</th>
            <th>Ex-Div Date <span style="color:#16a34a">⚡</span>=within 30d</th>
            <th title="Dividend payout ratio — >80% flagged">Payout</th>
            <th>Annual Income</th>
            <th>Recent Payments</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
    })()}

    ${renderPriceAlertsCard()}

    <div class="card">
      <div class="card-title">CSV Import Format</div>
      <p class="text-xs text-muted" style="margin-bottom:8px">Each row is a separate buy lot. Multiple rows for the same ticker are kept as individual CGT parcels (FIFO ordered). <strong>date is required</strong> — import will be blocked without it.</p>
      <pre class="code-block">date,ticker,shares,avg_price,sector,fees
15-06-2023,CBA,50,118.20,Banking,10
08-01-2024,CBA,30,124.50,Banking,10
20-11-2023,BHP,80,43.10,Mining,10
01-03-2024,TLS,200,3.92,Telecoms,10</pre>
      <p class="text-xs text-muted" style="margin-top:8px">Columns: <code>date</code> (DD-MM-YYYY, required) · <code>ticker</code> · <code>shares</code> · <code>avg_price</code> · <code>sector</code> (optional) · <code>fees</code> (optional)</p>
    </div>
  `;
}

// ============================================================
// PRICE ALERTS CARD (rendered inside Portfolio page)
// ============================================================
function renderPriceAlertsCard() {
  const alerts = state.priceAlerts || [];
  const priceMap = {};
  for (const h of state.portfolio) priceMap[h.ticker] = h.currentPrice;
  const allTickers = [...new Set([
    ...state.portfolio.map(h => h.ticker),
    ...(state.analysisConfig.extraTickers || []),
  ])].sort();

  const alertRows = alerts.map(a => {
    const isTriggered = !!a.triggeredAt;
    const typeLabel = a.type === 'above' ? '↑ Above' : a.type === 'below' ? '↓ Below' : '↓ Drop %';
    const thresholdLabel = a.type === 'pct_drop'
      ? `${a.value}% from $${fmt(a.referencePrice)}`
      : `$${fmt(a.value)}`;
    const currentPrice = priceMap[a.ticker];
    let distanceLabel = '';
    if (currentPrice != null && a.type !== 'pct_drop') {
      if (a.type === 'above') {
        distanceLabel = currentPrice >= a.value
          ? `<span class="text-xs" style="color:#16a34a">(now $${fmt(currentPrice)} — already above)</span>`
          : `<span class="text-xs text-muted">(now $${fmt(currentPrice)}, $${fmt(a.value - currentPrice)} away)</span>`;
      } else {
        distanceLabel = currentPrice <= a.value
          ? `<span class="text-xs" style="color:#ef4444">(now $${fmt(currentPrice)} — already below)</span>`
          : `<span class="text-xs text-muted">(now $${fmt(currentPrice)}, $${fmt(currentPrice - a.value)} away)</span>`;
      }
    }
    return `
    <tr style="${isTriggered ? 'background:rgba(245,158,11,0.06)' : ''}">
      <td><strong>${a.ticker}</strong></td>
      <td><span style="font-size:11px;padding:2px 7px;border-radius:4px;background:${a.type==='above'?'#dcfce7':a.type==='below'?'#fee2e2':'#fef3c7'};color:${a.type==='above'?'#15803d':a.type==='below'?'#dc2626':'#92400e'};font-weight:600">${typeLabel}</span></td>
      <td>${thresholdLabel} ${distanceLabel}</td>
      <td>${isTriggered
        ? `<span style="color:#f59e0b;font-weight:600">🔔 Triggered $${a.lastPrice != null ? fmt(a.lastPrice) : '—'}</span>`
        : `<span style="color:#16a34a;font-size:11px">● Active</span>`}</td>
      <td style="font-size:11px;color:var(--text-muted)">${a.createdAt ? a.createdAt.slice(0,10) : '—'}</td>
      <td>
        <div class="flex-row" style="gap:4px">
          ${isTriggered ? `<button class="btn btn-sm" onclick="rearmPriceAlert('${a.id}')" title="Re-arm this alert">↺ Re-arm</button>` : ''}
          <button class="btn btn-sm btn-danger" onclick="deletePriceAlert('${a.id}')" style="font-size:11px;padding:3px 8px">✕</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `
  <div class="card">
    <div class="flex-between" style="margin-bottom:12px">
      <div>
        <div class="card-title" style="margin:0">🔔 Price Alerts</div>
        <div class="text-xs text-muted" style="margin-top:3px">Triggers a banner + browser notification when price crosses your threshold. Checked on every price refresh.</div>
      </div>
      ${typeof Notification !== 'undefined' && Notification.permission === 'default'
        ? `<button class="btn btn-sm" onclick="requestNotificationPermission()">Enable notifications</button>` : ''}
    </div>

    <!-- Add new alert -->
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;padding:10px 12px;background:var(--bg-secondary);border-radius:var(--radius-md);margin-bottom:12px">
      <div>
        <div class="form-label">Ticker</div>
        <select id="alert-ticker" style="width:120px;padding:5px 8px;border-radius:6px;border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:13px">
          ${allTickers.map(t => `<option value="${t}">${t}</option>`).join('')}
          <option value="__custom__">Other…</option>
        </select>
        <input type="text" id="alert-ticker-custom" placeholder="e.g. WDS" style="display:none;width:80px;margin-left:4px;padding:5px 8px;border-radius:6px;border:0.5px solid var(--border-medium);font-size:13px">
      </div>
      <div>
        <div class="form-label">Type</div>
        <select id="alert-type" style="width:130px;padding:5px 8px;border-radius:6px;border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:13px"
          onchange="document.getElementById('alert-value-label').textContent=this.value==='pct_drop'?'Drop %':'Price ($)'">
          <option value="below">↓ Falls below</option>
          <option value="above">↑ Rises above</option>
          <option value="pct_drop">↓ Drops by %</option>
        </select>
      </div>
      <div>
        <div class="form-label" id="alert-value-label">Price ($)</div>
        <input type="number" id="alert-value" step="0.01" min="0.01" placeholder="e.g. 120.00"
          style="width:120px;padding:5px 8px;border-radius:6px;border:0.5px solid var(--border-medium);font-size:13px"
          onkeydown="if(event.key==='Enter')submitPriceAlert()">
      </div>
      <button class="btn btn-primary btn-sm" onclick="submitPriceAlert()" style="align-self:flex-end;margin-bottom:1px">+ Add Alert</button>
    </div>

    <!-- Alert list -->
    ${alerts.length === 0
      ? `<div class="text-xs text-muted" style="padding:10px 4px">No alerts set yet. Add one above to get notified when a price hits your target.</div>`
      : `<div class="table-wrap"><table>
          <thead><tr><th>Ticker</th><th>Type</th><th>Threshold</th><th>Status</th><th>Created</th><th></th></tr></thead>
          <tbody>${alertRows}</tbody>
        </table></div>`}
  </div>`;
}

function submitPriceAlert() {
  const sel = document.getElementById('alert-ticker');
  const custom = document.getElementById('alert-ticker-custom');
  const ticker = sel.value === '__custom__' ? (custom.value.trim().toUpperCase()) : sel.value;
  const type  = document.getElementById('alert-type').value;
  const value = parseFloat(document.getElementById('alert-value').value);
  if (!ticker) { toast('Select a ticker', 'error'); return; }
  if (isNaN(value) || value <= 0) { toast('Enter a valid threshold value', 'error'); return; }
  addPriceAlert(ticker, type, value);
  document.getElementById('alert-value').value = '';
  renderPage();
}

// Show custom ticker input when "Other…" selected
document.addEventListener('change', e => {
  if (e.target.id === 'alert-ticker') {
    const custom = document.getElementById('alert-ticker-custom');
    if (custom) custom.style.display = e.target.value === '__custom__' ? 'inline-block' : 'none';
  }
});

// key is `${ticker}-${account}` e.g. "WES-trading" — unique per row even when the same
// ticker is held in multiple accounts.
function toggleLots(key) {
  const row = document.getElementById(`lots-${key}`);
  const arrow = document.getElementById(`lots-arrow-${key}`);
  if (!row) return;
  const open = row.style.display !== 'none';
  // '' (not 'table-row') so the stacked-card mobile CSS can restyle the row
  row.style.display = open ? 'none' : '';
  if (arrow) arrow.textContent = open ? '▶' : '▼';
}

function handleCSV(e) {
  const file = e.target.files[0]; if (!file) return;
  // Reset input so same file can be re-imported if needed
  e.target.value = '';
  const reader = new FileReader();
  reader.onload = async ev => {
    const lines = ev.target.result.trim().split('\n');
    const header = lines[0].toLowerCase().replace(/\s/g,'');

    // Detect column positions from header
    const cols = header.split(',');
    const ci = name => cols.findIndex(c => c.includes(name));
    const iDate    = ci('date');
    const iTicker  = ci('ticker') >= 0 ? ci('ticker') : ci('symbol') >= 0 ? ci('symbol') : ci('stock');
    const iShares  = ci('shares') >= 0 ? ci('shares') : ci('qty') >= 0 ? ci('qty') : ci('quantity');
    const iPrice   = ci('price') >= 0 ? ci('price') : ci('avg') >= 0 ? ci('avg') : ci('cost');
    const iSector  = ci('sector');
    const iFees    = ci('fee') >= 0 ? ci('fee') : ci('brokerage');

    if (iTicker < 0 || iShares < 0 || iPrice < 0) {
      toast('CSV must include columns: ticker, shares, avg_price (and date)', 'error');
      return;
    }

    // Validate all rows have a date before doing anything
    const dataLines = lines.slice(1).filter(l => l.trim());
    const missingDates = [];
    const parsedRows = [];

    for (let i = 0; i < dataLines.length; i++) {
      const parts = dataLines[i].split(',').map(s => s.trim().replace(/^"|"$/g,''));
      const ticker  = parts[iTicker]?.toUpperCase();
      const shares  = Number(parts[iShares]);
      const price   = Number(parts[iPrice]);
      const dateRaw = iDate >= 0 ? parts[iDate] : '';
      const sector  = iSector >= 0 ? (parts[iSector] || 'Other') : 'Other';
      const fees    = iFees >= 0 ? Number(parts[iFees] || 0) : 0;

      if (!ticker || !shares || !price) continue;

      // Validate date format
      const dateValid = dateRaw && /^\d{2}-\d{2}-\d{4}$/.test(dateRaw);
      if (!dateValid) missingDates.push(`Row ${i+2}: ${ticker} — "${dateRaw || 'blank'}"`);

      parsedRows.push({ ticker, shares, price, date: dateRaw, sector, fees, dateValid });
    }

    if (missingDates.length > 0) {
      const msg = `Import blocked — ${missingDates.length} row(s) missing a valid date (DD-MM-YYYY):\n\n${missingDates.slice(0,8).join('\n')}${missingDates.length>8?`\n...and ${missingDates.length-8} more`:''}`;
      alert(msg);
      toast(`Import failed — add dates to all rows`, 'error');
      return;
    }

    // Sort chronologically so FIFO parcel order is correct.
    // Dates are DD-MM-YYYY — convert to YYYY-MM-DD for lexicographic sort.
    const _toISO = d => { const p = (d||'').split('-'); return p.length===3 ? `${p[2]}-${p[1]}-${p[0]}` : (d||''); };
    parsedRows.sort((a, b) => _toISO(a.date).localeCompare(_toISO(b.date)));

    // Audit fix #3: scope every lookup/write by account, mirroring applyBuyToPortfolio.
    // Without this, an import lands on whichever holding object for that ticker
    // happens to be first in state.portfolio — corrupting a different account's
    // avgPrice/share-count when the same ticker is held in more than one account.
    const importAccount = (state.activeAccount && state.activeAccount !== 'all')
      ? state.activeAccount : 'personal';

    // Paper/real firewall (gotcha #88): ask once for the whole import batch.
    const mode = await askTradeMode(`Import ${parsedRows.length} holding row(s)`);
    if (mode == null) { toast('Import cancelled', 'info'); return; }

    let added = 0, updated = 0, parcelsCreated = 0;

    for (const row of parsedRows) {
      const { ticker, shares, price, date, sector, fees } = row;

      // Check for exact duplicate parcel (same ticker + date + qty + price + account + mode) — skip
      const dupParcel = state.cgtParcels.find(p =>
        p.ticker === ticker && p.date === date &&
        p.qty === shares && Math.abs(p.costPerShare - price) < 0.005 &&
        (p.account || 'personal') === importAccount && (p.mode || 'paper') === mode
      );
      if (dupParcel) continue;

      // Update portfolio holding (weighted avg across all lots), scoped to account+mode
      const existing = state.portfolio.find(h =>
        h.ticker === ticker && (h.account || 'personal') === importAccount && (h.mode || 'paper') === mode);
      if (existing) {
        const totalCostVal = existing.shares * existing.avgPrice + shares * price;
        existing.shares += shares;
        existing.avgPrice = totalCostVal / existing.shares;
        if (sector !== 'Other') existing.sector = sector;
        updated++;
      } else {
        state.portfolio.push({ ticker, shares, avgPrice: price, currentPrice: price, sector, account: importAccount, mode });
        added++;
      }

      // Create CGT parcel
      addParcel(ticker, date, shares, price, fees, sector, importAccount, mode);
      const newParcel = state.cgtParcels[state.cgtParcels.length - 1];
      parcelsCreated++;

      // Create a BUY journal entry for this lot
      state.tradeJournal.push({
        id: nextJournalId(),
        date,
        ticker,
        action: 'BUY',
        qty: shares,
        entryPrice: price,
        exitPrice: null,
        fees,
        status: 'open',
        pnl: null,
        parcelId: newParcel.id,
        recId: null,
        recExecuted: false,
        timestamp: `${date} (imported)`,
        imported: true,
        account: importAccount,
        mode,
      });
    }

    // Re-sort journal chronologically after import (DD-MM-YYYY → convert to YYYY-MM-DD)
    state.tradeJournal.sort((a, b) => _toISO(a.date||'').localeCompare(_toISO(b.date||'')));

    toast(`Imported ${added + updated} holdings · ${parcelsCreated} CGT parcels created — click Refresh Prices for live data`, 'success');
    scheduleSave();
    renderPage();
  };
  reader.readAsText(file);
}
async function handleBrokerCSV(e) {
  const file = e.target.files[0]; if (!file) return;
  e.target.value = '';
  if (!state.serverOk) { toast('Backend server required for broker CSV import', 'error'); return; }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('broker', 'auto');

  toast('Parsing broker CSV…', 'info');
  let result;
  try {
    const r = await fetch(`${API}/api/import/csv`, { method: 'POST', body: formData });
    result = await r.json();
  } catch (ex) {
    toast(`Broker CSV upload failed: ${ex.message}`, 'error');
    return;
  }

  if (!result.ok) {
    toast(`Broker CSV error: ${result.error}`, 'error');
    return;
  }

  const rows = result.rows || [];
  if (rows.length === 0) {
    const skipMsg = result.skipped && result.skipped.length
      ? `\n\nSkipped ${result.skipped.length} rows:\n` + result.skipped.slice(0,5).map(s=>`  Row ${s.row}: ${s.reason}`).join('\n')
      : '';
    alert(`No importable BUY rows found (detected: ${result.broker}).${skipMsg}`);
    return;
  }

  // Sort chronologically — backend already sorts but ensure it
  rows.sort((a, b) => a.date.localeCompare(b.date));

  // Audit fix #3: see handleCSV's importAccount comment — same scoping applies here.
  const importAccount = (state.activeAccount && state.activeAccount !== 'all')
    ? state.activeAccount : 'personal';

  // Paper/real firewall (gotcha #88): ask once for the whole broker import batch.
  const mode = await askTradeMode(`Import broker CSV (${rows.length} buy row(s))`);
  if (mode == null) { toast('Import cancelled', 'info'); return; }

  let added = 0, updated = 0, parcelsCreated = 0;
  for (const row of rows) {
    const { ticker, shares, price, date, brokerage } = row;
    const dupParcel = state.cgtParcels.find(p =>
      p.ticker === ticker && p.date === date &&
      p.qty === shares && Math.abs(p.costPerShare - price) < 0.005 &&
      (p.account || 'personal') === importAccount && (p.mode || 'paper') === mode
    );
    if (dupParcel) continue;

    const existing = state.portfolio.find(h =>
      h.ticker === ticker && (h.account || 'personal') === importAccount && (h.mode || 'paper') === mode);
    if (existing) {
      const totalCostVal = existing.shares * existing.avgPrice + shares * price;
      existing.shares += shares;
      existing.avgPrice = totalCostVal / existing.shares;
      updated++;
    } else {
      state.portfolio.push({ ticker, shares, avgPrice: price, currentPrice: price, sector: 'Other', account: importAccount, mode });
      added++;
    }
    addParcel(ticker, date, shares, price, brokerage || 0, 'Other', importAccount, mode);
    const newParcel = state.cgtParcels[state.cgtParcels.length - 1];
    parcelsCreated++;
    state.tradeJournal.push({
      id: nextJournalId(),
      date, ticker, action: 'BUY', qty: shares, entryPrice: price,
      exitPrice: null, fees: brokerage || 0, status: 'open', pnl: null,
      parcelId: newParcel.id, recId: null, recExecuted: false,
      timestamp: `${date} (broker import)`, imported: true,
      account: importAccount, mode,
    });
  }
  const _brokerISO = d => { const p = (d||'').split('-'); return p.length===3 ? `${p[2]}-${p[1]}-${p[0]}` : (d||''); };
  state.tradeJournal.sort((a, b) => _brokerISO(a.date||'').localeCompare(_brokerISO(b.date||'')));

  let msg = `Broker CSV (${result.broker}): ${added + updated} holdings · ${parcelsCreated} parcels`;
  if (result.skipped && result.skipped.length) msg += ` · ${result.skipped.length} rows skipped`;
  toast(msg, 'success');
  if (result.skipped && result.skipped.length > 0) {
    console.warn('[BrokerCSV] Skipped rows:', result.skipped);
  }

  const sells = result.sells || [];
  if (sells.length > 0) {
    scheduleSave();
    renderPage();
    _showSellImportConfirmation(sells, result.broker, importAccount, mode);
    return;
  }
  scheduleSave();
  renderPage();
}

function _computeSellPreview(ticker, shares, price, date, brokerage, importAccount, mode) {
  const acct = importAccount || 'personal';
  const md   = mode || 'paper';
  const openParcels = (state.cgtParcels || [])
    .filter(p => p.ticker === ticker && p.remainingQty > 0 && (p.account || 'personal') === acct && (p.mode || 'paper') === md)
    .slice()
    .sort((a, b) => {
      // Parse DD-MM-YYYY for correct chronological ordering
      const pa = typeof parseDate === 'function' ? parseDate(a.date) : new Date(a.date);
      const pb = typeof parseDate === 'function' ? parseDate(b.date) : new Date(b.date);
      return pa - pb;
    });

  if (!openParcels.length) return null;

  let remaining = shares;
  let totalCost = 0;
  let cgtDiscount = false;
  let cgtWarning = false;

  for (const p of openParcels) {
    if (remaining <= 0) break;
    const consumed = Math.min(remaining, p.remainingQty);
    totalCost += consumed * p.costPerShare;
    const heldDays = typeof daysBetween === 'function'
      ? daysBetween(p.date, date)
      : Math.floor((new Date(date.split('-').reverse().join('-')) - new Date(p.date.split('-').reverse().join('-'))) / 86400000);
    if (heldDays >= 365) cgtDiscount = true;
    if (heldDays >= 320 && heldDays < 365) cgtWarning = true;
    remaining -= consumed;
  }

  const totalProceeds = shares * price;
  const gain = totalProceeds - totalCost - brokerage;
  return { totalCost, gain, cgtDiscount, cgtWarning, unmatched: remaining };
}

function _showSellImportConfirmation(sells, broker, importAccount, mode) {
  document.getElementById('sell-import-dialog')?.remove();

  const rows = sells.map(s => {
    const preview = _computeSellPreview(s.ticker, s.shares, s.price, s.date, s.brokerage, importAccount, mode);
    const noParcel = !preview;
    const gainClass = !preview ? '' : preview.gain >= 0 ? 'color:#16a34a' : 'color:#dc2626';
    const gainStr   = !preview ? '—' : `${preview.gain >= 0 ? '+' : ''}$${Math.abs(preview.gain).toFixed(2)}`;
    const cgtStr    = !preview ? '—' : preview.cgtDiscount ? '<span style="color:#16a34a">✓ Yes</span>' : '<span style="color:var(--text-muted)">No</span>';
    const warnBadge = preview?.cgtWarning ? ' <span style="background:#fef3c7;color:#92400e;border-radius:3px;padding:1px 5px;font-size:10px">⏰ CGT at risk</span>' : '';
    const noBadge   = noParcel ? '<span style="background:#fee2e2;color:#dc2626;border-radius:3px;padding:1px 5px;font-size:10px">No parcels — will skip</span>' : '';
    const costStr   = preview ? `$${preview.totalCost.toFixed(2)}` : '—';
    return `<tr style="opacity:${noParcel ? 0.6 : 1}">
      <td style="padding:6px 8px;font-size:12px;font-weight:600">${s.ticker}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right">${s.shares}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right">$${s.price.toFixed(2)}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right">${costStr}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right;${gainClass}">${gainStr}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:center">${cgtStr}${warnBadge}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:right">$${s.brokerage.toFixed(2)}</td>
      <td style="padding:6px 8px;font-size:12px">${noBadge}</td>
    </tr>`;
  });

  const dialog = document.createElement('dialog');
  dialog.id = 'sell-import-dialog';
  dialog.style.cssText = 'padding:0;border:none;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.35);background:var(--bg-primary);color:var(--text-primary);max-width:760px;width:95vw';
  dialog.innerHTML = `
    <div style="padding:20px 24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div style="font-size:15px;font-weight:700">SELL Import — ${broker.charAt(0).toUpperCase()+broker.slice(1)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">Review FIFO-matched disposals before applying. Uses current CGT method (${state.cgtMethod || 'fifo'}).</div>
        </div>
        <button onclick="document.getElementById('sell-import-dialog')?.remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-muted);padding:2px 6px">✕</button>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="border-bottom:2px solid var(--border)">
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);text-align:left">Ticker</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);text-align:right">Shares</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);text-align:right">Price</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);text-align:right">Cost Basis</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);text-align:right">Gain/Loss</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);text-align:center">CGT Discount?</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);text-align:right">Brokerage</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted)"></th>
          </tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
        <button class="btn btn-sm" onclick="document.getElementById('sell-import-dialog')?.remove()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="_applyImportedSells(${JSON.stringify(sells).replace(/"/g, '&quot;')}, ${JSON.stringify(importAccount || 'personal').replace(/"/g, '&quot;')}, ${JSON.stringify(mode || 'paper').replace(/"/g, '&quot;')});document.getElementById('sell-import-dialog')?.remove()">Apply SELL imports</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.remove(); });
  dialog.showModal();
}

function _applyImportedSells(sells, importAccount, mode) {
  // Audit fix #3: scope every lookup by account — matchSaleAgainstParcels already
  // accepts an account param (via getParcelsForTicker), it just wasn't being passed.
  // Paper/real firewall (gotcha #88): also scope by mode so an imported sell only
  // consumes same-mode parcels/holdings.
  const acct = importAccount || 'personal';
  const md   = mode || 'paper';
  let applied = 0, skipped = 0;
  for (const s of sells) {
    const { ticker, shares, price, date, brokerage } = s;
    if (!shares || shares <= 0) continue;
    const openParcels = (state.cgtParcels || []).filter(p =>
      p.ticker === ticker && p.remainingQty > 0 && (p.account || 'personal') === acct && (p.mode || 'paper') === md
    );
    if (!openParcels.length) {
      console.warn(`[SellImport] No open ${md} parcels for ${ticker} in account ${acct} — skipped`);
      skipped++;
      continue;
    }

    // FIFO parcel matching via existing helper (mutates parcel.remainingQty, pushes to cgtDisposals)
    const disposals = matchSaleAgainstParcels(ticker, shares, price, date, brokerage, state.cgtMethod || 'fifo', acct, md);
    state.cgtDisposals.push(...disposals);

    // Update portfolio holding. Audit fix #11: round to 4dp + epsilon zero-check
    // (mirrors applySellToPortfolio in portfolio-helpers.js) so a phantom near-zero
    // residual from floating-point drift doesn't survive as a leftover holding.
    const holding = state.portfolio.find(h =>
      h.ticker === ticker && (h.account || 'personal') === acct && (h.mode || 'paper') === md);
    if (holding) {
      holding.shares = Math.round((holding.shares - shares) * 10000) / 10000;
      if (Math.abs(holding.shares) < _SHARE_EPSILON) {
        state.portfolio = state.portfolio.filter(h =>
          !(h.ticker === ticker && (h.account || 'personal') === acct && (h.mode || 'paper') === md));
      }
    }

    // Trade journal: one row PER PARCEL matched (gotcha #66), patching each
    // original BUY/TOP_UP/RECLASSIFY row's status to 'closed'/'trimmed' —
    // same model markExecuted()/addManualTrade() already use. The previous
    // version here hand-rolled a single aggregate row using only the FIRST
    // parcel's cost basis (wrong/misleading for multi-parcel disposals) and
    // never patched the original rows, leaving fully-sold BUY rows stuck on
    // status:'open' forever after a CSV-imported sale.
    const newEntries = buildDisposalJournalEntries({
      ticker, account: acct, disposals, tradePrice: price, action: 'SELL',
      recId: null, recExecuted: false, timestamp: nowSydney(), date,
      regime: null, exitSignals: null, mode: md,
    });
    // buildDisposalJournalEntries already sets each entry's `fees` from the
    // disposal's own proportionally-allocated saleFee (matchSaleAgainstParcels
    // splits the flat `brokerage` across every parcel matched) — don't
    // overwrite it with the flat brokerage figure, only tag provenance.
    newEntries.forEach(e => { e.imported = true; });
    applied++;
  }
  const _sellISO = d => { const p = (d||'').split('-'); return p.length===3 ? `${p[2]}-${p[1]}-${p[0]}` : (d||''); };
  state.tradeJournal.sort((a, b) => _sellISO(a.date||'').localeCompare(_sellISO(b.date||'')));
  scheduleSave();
  renderPage();
  const msg = skipped > 0
    ? `Applied ${applied} SELL import(s) · ${skipped} skipped (no parcels)`
    : `Applied ${applied} SELL import(s)`;
  toast(msg, applied > 0 ? 'success' : 'warning');
}

// Splits one open parcel into two sibling lots, then re-renders. Pure mutation
// logic lives in splitParcel() (portfolio-helpers.js) — this is the UI wrapper
// (prompt + validation feedback + render), mirroring deleteParcel()'s pattern.
function promptSplitParcel(parcelId) {
  const p = state.cgtParcels.find(x => x.id === parcelId);
  if (!p) return;
  if (p.remainingQty < p.qty) { toast('Cannot split a partially-sold parcel', 'error'); return; }
  const input = prompt(
    `Split parcel #${p.id} (${p.qty} × ${p.ticker} @ $${fmt(p.costPerShare)}) — ` +
    `how many shares should move into the NEW lot? (1–${p.qty - 1})`
  );
  if (input == null) return;
  const qty = Number(input);
  if (!(qty > 0) || qty >= p.qty) { toast('Invalid split quantity', 'error'); return; }
  if (splitParcel(parcelId, qty)) {
    renderPage();
    toast(`Split parcel #${p.id} — ${qty} share(s) moved to a new lot`, 'success');
  } else {
    toast('Split failed', 'error');
  }
}

async function addHolding() {
  const ticker = prompt('Ticker (e.g. NAB):'); if (!ticker) return;
  const dateRaw = prompt('Buy date (DD-MM-YYYY):');
  if (!dateRaw || !/^\d{2}-\d{2}-\d{4}$/.test(dateRaw)) { toast('Invalid date — use DD-MM-YYYY format', 'error'); return; }
  const shares = Number(prompt('Shares:')); if (!shares) return;
  const avg = Number(prompt('Avg buy price ($):')); if (!avg) return;
  const sector = prompt('Sector (e.g. Banking):') || 'Other';
  const fees = Number(prompt('Brokerage paid ($, e.g. 10):') || state.settings.brokerage);
  const acctRaw = (prompt('Account (personal / super / trading):') || 'personal').trim().toLowerCase();
  const account = ['personal','super','trading'].includes(acctRaw) ? acctRaw : 'personal';
  const symbol = ticker.toUpperCase();

  // Paper/real firewall (gotcha #88): choose mode before any state mutation.
  // Without this, Add Holding could only ever create paper positions (addParcel
  // defaults mode-less parcels to 'paper') — there was no way to record a real
  // pre-existing holding through this primary manual-entry path.
  const mode = await askTradeMode(`Add holding ${symbol} (${shares} shares)`);
  if (mode == null) return;   // cancelled — no writes

  // Update portfolio (scoped by account AND mode)
  const existing = state.portfolio.find(h =>
    h.ticker === symbol && (h.account || 'personal') === account && (h.mode || 'paper') === mode);
  if (existing) {
    const totalCostVal = existing.shares * existing.avgPrice + shares * avg;
    existing.shares += shares;
    existing.avgPrice = totalCostVal / existing.shares;
    if (sector !== 'Other') existing.sector = sector;
  } else {
    state.portfolio.push({ ticker: symbol, shares, avgPrice: avg, currentPrice: avg, sector, account, mode });
  }

  // Create CGT parcel — account MUST match the portfolio row above, or
  // getParcelsForTicker(ticker, method, 'trading'/'super') finds zero
  // parcels for this holding (it always defaulted to 'personal' here).
  addParcel(symbol, dateRaw, shares, avg, fees, sector, account, mode);
  const newParcel = state.cgtParcels[state.cgtParcels.length - 1];

  // Snapshot live technicals when the buy is dated today — same helper and
  // same-day-only guard as addManualTrade() (journal.js). Shows a loading toast
  // only when a live fetch is actually required (not already cached).
  let entrySignals = null;
  if (dateRaw === todayStr()) {
    const needsFetch = !state.liveSignals?.[symbol]?.rsi_14;
    if (needsFetch) toast(`⟳ Fetching live signals for ${symbol}…`, 'info');
    entrySignals = await _fetchSignalSnapshot(symbol, dateRaw);
  }

  // Create journal entry
  state.tradeJournal.unshift({
    id: nextJournalId(),
    date: dateRaw,
    ticker: symbol,
    action: 'BUY',
    qty: shares,
    entryPrice: avg,
    exitPrice: null,
    fees,
    status: 'open',
    pnl: null,
    parcelId: newParcel.id,
    recId: null,
    recExecuted: false,
    timestamp: `${dateRaw} (manual)`,
    account,
    mode,
    sector,
    entrySignals,
  });

  toast(`Added ${symbol} — click Refresh Prices to get live price`, 'success');
  scheduleSave();
  renderPage();
}
// Blocks removal while open CGT parcels still exist for this (ticker,account)
// — removing only the state.portfolio row left them orphaned, and the NEXT
// unrelated setParcelAccount() call for that ticker (any parcel, any account)
// would call _recomputeHoldingFromParcels() and silently resurrect the row
// the user thought they'd deleted. Forcing a sell/reassign first keeps
// state.portfolio and state.cgtParcels from ever disagreeing about whether
// a holding exists.
function removeHolding(i) {
  const h = state.portfolio[i];
  if (!h) return;
  const acct = h.account || 'personal';
  const openParcels = (state.cgtParcels || []).filter(p =>
    p.ticker === h.ticker && (p.account || 'personal') === acct && p.remainingQty > 0
  );
  if (openParcels.length) {
    toast(`Cannot remove ${h.ticker} (${acct}) — ${openParcels.length} open lot(s) still exist. Sell them or reassign to another account first.`, 'error');
    return;
  }
  if(!confirm(`Remove ${h.ticker}?`)) return;
  state.portfolio.splice(i,1); scheduleSave(); renderPage();
}

// ── Portfolio sector sidebar ───────────────────────────────────────────────────

const _DONUT_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
  '#06b6d4','#84cc16','#f97316','#ec4899','#64748b',
  '#14b8a6','#a855f7','#eab308','#6366f1','#22c55e',
];

function _buildSectorSidebar(merged, totalValue) {
  if (!merged || !merged.length || !totalValue) return '';

  // Bucket by sector
  const sectorMap = {};
  merged.forEach(h => {
    const val = h.shares * h.currentPrice;
    sectorMap[h.sector || 'Other'] = (sectorMap[h.sector || 'Other'] || 0) + val;
  });
  const sectors = Object.entries(sectorMap).sort((a, b) => b[1] - a[1]);
  const maxSec = sectors[0]?.[1] || 1;

  return `
  <div class="card" style="min-width:0">
    <div class="card-title" style="margin-bottom:12px">Sectors</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      ${sectors.map(([sec, val]) => {
        const w = totalValue > 0 ? (val / totalValue * 100) : 0;
        const barPct = (val / maxSec * 100).toFixed(1);
        return `<div>
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">
            <span style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px" title="${sec}">${sec}</span>
            <span class="text-muted">${fmt(w, 1)}%</span>
          </div>
          <div style="background:var(--bg-secondary);border-radius:3px;height:7px;overflow:hidden">
            <div style="width:${barPct}%;height:100%;background:var(--accent-primary);border-radius:3px;transition:width 0.3s"></div>
          </div>
        </div>`;
      }).join('')}
    </div>

    <div style="margin-top:16px;padding-top:12px;border-top:0.5px solid var(--border-light)">
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Weights</div>
      <div style="display:flex;flex-direction:column;gap:5px">
        ${[...merged]
          .map((h, origIdx) => ({
            h, origIdx,
            w: totalValue > 0 ? (h.shares * h.currentPrice / totalValue * 100) : 0,
          }))
          .sort((a, b) => b.w - a.w)
          .map(({ h, w }, sortIdx) => `<div style="display:flex;align-items:center;gap:6px;font-size:11px">
            <span style="width:7px;height:7px;border-radius:2px;flex-shrink:0;background:${_DONUT_COLORS[sortIdx % _DONUT_COLORS.length]}"></span>
            <span style="font-weight:600;flex:0 0 38px">${h.ticker}</span>
            <div style="flex:1;background:var(--bg-secondary);border-radius:2px;height:5px;overflow:hidden">
              <div style="width:${Math.min(w,100)}%;height:100%;background:${_DONUT_COLORS[sortIdx % _DONUT_COLORS.length]};opacity:0.7"></div>
            </div>
            <span class="text-muted" style="flex:0 0 30px;text-align:right">${fmt(w,1)}%</span>
          </div>`).join('')}
      </div>
    </div>
  </div>`;
}

function applySplitAdjustment(ticker, ratio, date) {
  if (!confirm(`Apply ${ratio}:1 split for ${ticker} on ${date}?\n\nThis will:\n• Multiply shares by ${ratio}\n• Divide avg price by ${ratio}\n• Multiply all open CGT parcel quantities by ${ratio}\n• Divide CGT parcel cost-per-share by ${ratio}\n\nMake sure this split has not already been applied.`)) return;

  // Adjust portfolio holding. Audit fix #3: a corporate split applies to EVERY
  // account that holds this ticker, not just the first array match — the CGT
  // parcel loop below already (correctly) adjusts parcels across all accounts,
  // so adjusting only one holding object left other accounts' holdings silently
  // out of sync with their own (now-adjusted) parcels.
  const holdings = state.portfolio.filter(h => h.ticker === ticker);
  holdings.forEach(holding => {
    holding.shares       = Math.round(holding.shares * ratio * 10000) / 10000;
    holding.avgPrice     = Math.round(holding.avgPrice / ratio * 10000) / 10000;
    holding.currentPrice = Math.round(holding.currentPrice / ratio * 10000) / 10000;
  });

  // Adjust open CGT parcels for this ticker (correctly account-agnostic — a split affects all lots)
  let parcelCount = 0;
  (state.cgtParcels || []).forEach(p => {
    if (p.ticker === ticker && (p.remainingQty || 0) > 0) {
      p.qty          = Math.round(p.qty          * ratio * 10000) / 10000;
      p.remainingQty = Math.round(p.remainingQty * ratio * 10000) / 10000;
      p.costPerShare = Math.round(p.costPerShare / ratio * 10000) / 10000;
      parcelCount++;
    }
  });

  // Dismiss the split warning for this ticker so the button doesn't show again
  if (state._splitWarnings) state._splitWarnings[ticker] = [];

  saveStateToDb();
  renderPage();
  toast(`Split applied: ${ticker} ${ratio}:1 — ${holdings.length} holding(s) updated, ${parcelCount} parcel(s) adjusted`, 'success');
}

async function checkPortfolioSplits() {
  if (!state.serverOk || !state.portfolio.length) return;
  const tickers = [...new Set(state.portfolio.map(h => h.ticker))].join(',');
  try {
    const r = await fetch(`${API}/api/portfolio/splits-check?tickers=${encodeURIComponent(tickers)}`);
    if (!r.ok) return;
    state._splitWarnings = await r.json();
    const hasSplits = Object.values(state._splitWarnings).some(v => v && v.length > 0);
    if (hasSplits) renderPage();
  } catch {}
}

async function checkCapitalReturns() {
  if (!state.serverOk || !state.portfolio.length) return;
  // Only run once per page load (undefined = not yet checked, {} = checked clean)
  if (state._capitalReturnWarnings !== undefined) return;
  const tickers = [...new Set(state.portfolio.map(h => h.ticker))].join(',');
  try {
    const r = await fetch(`${API}/api/portfolio/capital-returns-check?tickers=${encodeURIComponent(tickers)}`);
    if (!r.ok) return;
    state._capitalReturnWarnings = await r.json();
    const hasEvents = Object.values(state._capitalReturnWarnings).some(v => v && v.length > 0);
    if (hasEvents) renderPage();
  } catch {}
}

function showDrpModal(ticker) {
  const existing = document.getElementById('drp-modal');
  if (existing) existing.remove();

  const today = todayStr();
  const holding = mergedPortfolio().find(h => h.ticker === ticker);
  const currentPrice = holding ? holding.currentPrice : '';

  const modal = document.createElement('div');
  modal.id = 'drp-modal';
  modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center`;
  modal.innerHTML = `
    <div style="background:var(--bg-primary);border-radius:10px;padding:24px;width:360px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,0.3)">
      <div style="font-weight:700;font-size:15px;margin-bottom:16px">Record DRP — ${ticker}</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <label style="font-size:12px;color:var(--text-secondary)">DRP Shares (required)
          <input id="drp-shares" type="number" min="0" step="any" placeholder="e.g. 12"
            style="display:block;width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);font-size:13px">
        </label>
        <label style="font-size:12px;color:var(--text-secondary)">DRP Price per Share (required)
          <input id="drp-price" type="number" min="0" step="any" value="${currentPrice}"
            style="display:block;width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);font-size:13px">
        </label>
        <label style="font-size:12px;color:var(--text-secondary)">Settlement Date
          <input id="drp-date" type="date" value="${today}"
            style="display:block;width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);font-size:13px">
        </label>
        <label style="font-size:12px;color:var(--text-secondary)">Dividend Amount (optional, for reference)
          <input id="drp-divamt" type="number" min="0" step="any" placeholder="e.g. 45.60"
            style="display:block;width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);font-size:13px">
        </label>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button class="btn btn-sm" onclick="document.getElementById('drp-modal').remove()">Cancel</button>
        <button class="btn btn-sm" style="background:#6d28d9;color:#fff;border-color:#5b21b6" onclick="applyDrpEvent('${ticker}')">Apply DRP</button>
      </div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
  document.getElementById('drp-shares').focus();
}

function applyDrpEvent(ticker) {
  const drpShares = parseFloat(document.getElementById('drp-shares')?.value);
  const drpPrice  = parseFloat(document.getElementById('drp-price')?.value);
  const date      = document.getElementById('drp-date')?.value || todayStr();

  if (!drpShares || drpShares <= 0) { toast('DRP shares must be a positive number', 'error'); return; }
  if (!drpPrice  || drpPrice  <= 0) { toast('DRP price must be a positive number', 'error'); return; }

  document.getElementById('drp-modal')?.remove();

  // Match by ticker + active account so multi-account users update the right parcel
  const acct = state.activeAccount && state.activeAccount !== 'all' ? state.activeAccount : null;
  const holding = state.portfolio.find(h =>
    h.ticker === ticker && (!acct || (h.account || 'personal') === acct)
  ) || state.portfolio.find(h => h.ticker === ticker);
  if (!holding) { toast(`No holding found for ${ticker}`, 'error'); return; }

  const newShares  = holding.shares + drpShares;
  const newAvgPrice = Math.round(
    ((holding.shares * holding.avgPrice) + (drpShares * drpPrice)) / newShares * 10000
  ) / 10000;
  holding.shares   = Math.round(newShares   * 10000) / 10000;
  holding.avgPrice = newAvgPrice;

  // Audit fix #3: the holding lookup above is correctly account-scoped, but this
  // parcel previously had no account field at all — it would silently default to
  // 'personal' everywhere parcels are read (p.account || 'personal'), even when
  // the actual holding being reinvested into is 'trading'/'super'.
  // Paper/real firewall (gotcha #88): a DRP is a reinvestment of an existing
  // position — it inherits that holding's mode, no separate gatekeeper prompt.
  const drpMode = holding.mode || 'paper';
  const parcelId = nextParcelId();
  (state.cgtParcels = state.cgtParcels || []).push({
    id: parcelId, ticker, action: 'DRP', qty: drpShares, costPerShare: drpPrice,
    date, remainingQty: drpShares, fees: 0, notes: 'DRP — dividend reinvestment',
    account: holding.account || 'personal', mode: drpMode,
  });

  state.tradeJournal.push({
    id: nextJournalId(), date, ticker, action: 'DRP', qty: drpShares,
    entryPrice: drpPrice, exitPrice: null, fees: 0, pnl: 0,
    status: 'open', recId: null, recExecuted: false, closeDate: null,
    parcelId, account: holding.account || 'personal', mode: drpMode,
    // Only stamp today's regime when the DRP date is actually today — a
    // backdated settlement date shouldn't carry today's market regime.
    regime: (date === todayStr()) ? ((state.currentRegime && state.currentRegime.regime) || null) : null,
  });

  scheduleSave();
  renderPage();
  toast(`DRP recorded: ${drpShares} shares of ${ticker} @ $${fmt(drpPrice)}`, 'success');
}
