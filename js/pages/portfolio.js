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
      <div class="metric-card"><div class="metric-label">Cash Available</div><div class="metric-value">$${fmt(state.cash)}</div></div>
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
            <div class="metric-sub">${fmt(yieldOnCost)}% yield on cost</div>
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
          <button class="btn btn-sm" style="${a===cur?'background:var(--accent);color:#fff;border-color:var(--accent)':''}" onclick="state.activeAccount='${a}';renderPage()">${_ACCT_LABELS[a]}</button>
        `).join('')}
        ${cur !== 'all' ? `<span class="text-xs text-muted" style="align-self:center;margin-left:4px">Viewing ${_ACCT_LABELS[cur]} account — analysis and signals use this account's holdings only.</span>` : ''}
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
        <table>
          <thead><tr><th></th><th>Ticker</th><th>Sector</th>${state.activeAccount==='all'?'<th>Account</th>':''}<th>Lots</th><th>Total Shares</th><th>Avg Cost</th><th>Current</th><th>Value</th><th>P&L ($)</th><th>P&L (%)</th><th>Weight</th><th>Div Yield</th><th title="Franking percentage — 100% = fully franked (tax credit included)">Franking</th><th>Ex-Div Date</th><th></th></tr></thead>
          <tbody>
            ${merged.slice().sort((a, b) => (b.shares * b.currentPrice) - (a.shares * a.currentPrice)).map(h => {
              const val = h.shares * h.currentPrice;
              const pl  = (h.currentPrice - h.avgPrice) * h.shares;
              const plp = ((h.currentPrice - h.avgPrice) / h.avgPrice) * 100;
              const _pts = state.priceTimestamps && state.priceTimestamps[h.ticker];
              const _stale = _pts && (Date.now() - new Date(_pts).getTime()) > 25 * 60 * 1000;
              const _staleBadge = _stale ? '<span class="text-xs" style="color:#f59e0b;margin-left:3px" title="Price data older than 25 min">⚠ stale</span>' : '';
              const openParcels = state.cgtParcels.filter(p => p.ticker === h.ticker && p.remainingQty > 0);
              const lots = openParcels.length;
              // Find all state.portfolio entries for this ticker
              const rawEntries = state.portfolio.filter(e => e.ticker === h.ticker);
              const portfolioIdx = state.portfolio.findIndex(e => e.ticker === h.ticker);
              const hasMulti = lots > 1;
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
              const acctBadge = state.activeAccount === 'all'
                ? `<td><span class="text-xs" style="background:${_ACCT_COLORS[acct]}22;color:${_ACCT_COLORS[acct]};padding:1px 5px;border-radius:3px;cursor:pointer" onclick="event.stopPropagation();_cycleHoldingAccount('${h.ticker}')" title="Click to change account">${acct}</span></td>`
                : '';
              return `
                <tr style="cursor:${hasMulti?'pointer':'default'}" onclick="${hasMulti?`toggleLots('${h.ticker}')`:''}" title="${hasMulti?'Click to expand lots':''}">
                  <td style="width:20px;text-align:center;color:var(--text-tertiary)">${hasMulti?`<span id="lots-arrow-${h.ticker}" style="font-size:10px">▶</span>`:'&nbsp;'}</td>
                  <td><strong>${h.ticker}</strong></td>
                  <td><span class="text-xs">${h.sector}</span></td>
                  ${acctBadge}
                  <td class="text-xs text-muted">${lots > 0 ? `${lots} lot${lots!==1?'s':''}` : '—'}</td>
                  <td>${h.shares}</td>
                  <td>$${fmt(h.avgPrice)}</td>
                  <td>$${fmt(h.currentPrice)}${_staleBadge}</td>
                  <td>$${fmt(val)}</td>
                  <td class="${pl>=0?'text-success':'text-danger'}">${sign(pl)}$${fmt(Math.abs(pl))}</td>
                  <td class="${plp>=0?'text-success':'text-danger'}">${sign(plp)}${fmt(Math.abs(plp))}%</td>
                  <td class="text-xs">${fmt((val/pv)*100)}%</td>
                  <td>${divYieldStr}</td>
                  <td>${frankingStr}</td>
                  <td>${exDivStr}</td>
                  <td style="white-space:nowrap">
                    <button class="btn btn-sm" style="background:#ede9fe;color:#6d28d9;border-color:#c4b5fd;margin-right:4px" onclick="event.stopPropagation();showDrpModal('${h.ticker}')" title="Record a Dividend Reinvestment Plan share issue">DRP</button>
                    <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();removeHolding(${portfolioIdx})">✕</button>
                  </td>
                </tr>
                ${hasMulti ? `
                <tr id="lots-${h.ticker}" style="display:none">
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
                      </tr></thead>
                      <tbody>
                        ${openParcels.sort((a,b)=>a.date.localeCompare(b.date)).map(p => {
                          const costBase = p.remainingQty * p.costPerShare;
                          const mktVal   = p.remainingQty * h.currentPrice;
                          const lotPl    = mktVal - costBase;
                          const held     = daysBetween(p.date, todayStr());
                          const disc     = held >= 365;
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
            · Div yield: <strong>${fmt(totalFwdYield)}%</strong>
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

function toggleLots(ticker) {
  const row = document.getElementById(`lots-${ticker}`);
  const arrow = document.getElementById(`lots-arrow-${ticker}`);
  if (!row) return;
  const open = row.style.display !== 'none';
  row.style.display = open ? 'none' : 'table-row';
  if (arrow) arrow.textContent = open ? '▶' : '▼';
}

function handleCSV(e) {
  const file = e.target.files[0]; if (!file) return;
  // Reset input so same file can be re-imported if needed
  e.target.value = '';
  const reader = new FileReader();
  reader.onload = ev => {
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

    // Sort chronologically so FIFO parcel order is correct
    parsedRows.sort((a, b) => a.date.localeCompare(b.date));

    let added = 0, updated = 0, parcelsCreated = 0;

    for (const row of parsedRows) {
      const { ticker, shares, price, date, sector, fees } = row;

      // Check for exact duplicate parcel (same ticker + date + qty + price) — skip
      const dupParcel = state.cgtParcels.find(p =>
        p.ticker === ticker && p.date === date &&
        p.qty === shares && Math.abs(p.costPerShare - price) < 0.005
      );
      if (dupParcel) continue;

      // Update portfolio holding (weighted avg across all lots)
      const existing = state.portfolio.find(h => h.ticker === ticker);
      if (existing) {
        const totalCostVal = existing.shares * existing.avgPrice + shares * price;
        existing.shares += shares;
        existing.avgPrice = totalCostVal / existing.shares;
        if (sector !== 'Other') existing.sector = sector;
        updated++;
      } else {
        state.portfolio.push({ ticker, shares, avgPrice: price, currentPrice: price, sector });
        added++;
      }

      // Create CGT parcel
      addParcel(ticker, date, shares, price, fees, sector);
      const newParcel = state.cgtParcels[state.cgtParcels.length - 1];
      parcelsCreated++;

      // Create a BUY journal entry for this lot
      state.tradeJournal.push({
        id: state.tradeJournal.length + 1,
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
      });
    }

    // Re-sort journal chronologically after import
    state.tradeJournal.sort((a, b) => (a.date||'').localeCompare(b.date||''));

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

  let added = 0, updated = 0, parcelsCreated = 0;
  for (const row of rows) {
    const { ticker, shares, price, date, brokerage } = row;
    const dupParcel = state.cgtParcels.find(p =>
      p.ticker === ticker && p.date === date &&
      p.qty === shares && Math.abs(p.costPerShare - price) < 0.005
    );
    if (dupParcel) continue;

    const existing = state.portfolio.find(h => h.ticker === ticker);
    if (existing) {
      const totalCostVal = existing.shares * existing.avgPrice + shares * price;
      existing.shares += shares;
      existing.avgPrice = totalCostVal / existing.shares;
      updated++;
    } else {
      state.portfolio.push({ ticker, shares, avgPrice: price, currentPrice: price, sector: 'Other' });
      added++;
    }
    addParcel(ticker, date, shares, price, brokerage || 0, 'Other');
    const newParcel = state.cgtParcels[state.cgtParcels.length - 1];
    parcelsCreated++;
    state.tradeJournal.push({
      id: state.tradeJournal.length + 1,
      date, ticker, action: 'BUY', qty: shares, entryPrice: price,
      exitPrice: null, fees: brokerage || 0, status: 'open', pnl: null,
      parcelId: newParcel.id, recId: null, recExecuted: false,
      timestamp: `${date} (broker import)`, imported: true,
    });
  }
  state.tradeJournal.sort((a, b) => (a.date||'').localeCompare(b.date||''));

  let msg = `Broker CSV (${result.broker}): ${added + updated} holdings · ${parcelsCreated} parcels`;
  if (result.skipped && result.skipped.length) msg += ` · ${result.skipped.length} rows skipped`;
  toast(msg, 'success');
  if (result.skipped && result.skipped.length > 0) {
    console.warn('[BrokerCSV] Skipped rows:', result.skipped);
  }
  scheduleSave();
  renderPage();
}

function _cycleHoldingAccount(ticker) {
  const _cycle = {personal:'super', super:'trading', trading:'personal'};
  state.portfolio.filter(h => h.ticker === ticker).forEach(h => {
    h.account = _cycle[h.account || 'personal'] || 'personal';
  });
  scheduleSave();
  renderPage();
}

function addHolding() {
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

  // Update portfolio
  const existing = state.portfolio.find(h => h.ticker === symbol && (h.account || 'personal') === account);
  if (existing) {
    const totalCostVal = existing.shares * existing.avgPrice + shares * avg;
    existing.shares += shares;
    existing.avgPrice = totalCostVal / existing.shares;
    if (sector !== 'Other') existing.sector = sector;
  } else {
    state.portfolio.push({ ticker: symbol, shares, avgPrice: avg, currentPrice: avg, sector, account });
  }

  // Create CGT parcel
  addParcel(symbol, dateRaw, shares, avg, fees, sector);
  const newParcel = state.cgtParcels[state.cgtParcels.length - 1];

  // Create journal entry
  state.tradeJournal.unshift({
    id: state.tradeJournal.length + 1,
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
  });

  toast(`Added ${symbol} — click Refresh Prices to get live price`, 'success');
  scheduleSave();
  renderPage();
}
function removeHolding(i) {
  if(!confirm(`Remove ${state.portfolio[i].ticker}?`)) return;
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
            <div style="width:${barPct}%;height:100%;background:var(--accent);border-radius:3px;transition:width 0.3s"></div>
          </div>
        </div>`;
      }).join('')}
    </div>

    <div style="margin-top:16px;padding-top:12px;border-top:0.5px solid var(--border-light)">
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Weights</div>
      <div style="display:flex;flex-direction:column;gap:5px">
        ${merged.map((h, i) => {
          const w = totalValue > 0 ? (h.shares * h.currentPrice / totalValue * 100) : 0;
          const pl = h.avgPrice > 0 ? ((h.currentPrice - h.avgPrice) / h.avgPrice * 100) : 0;
          return `<div style="display:flex;align-items:center;gap:6px;font-size:11px">
            <span style="width:7px;height:7px;border-radius:2px;flex-shrink:0;background:${_DONUT_COLORS[i % _DONUT_COLORS.length]}"></span>
            <span style="font-weight:600;flex:0 0 38px">${h.ticker}</span>
            <div style="flex:1;background:var(--bg-secondary);border-radius:2px;height:5px;overflow:hidden">
              <div style="width:${Math.min(w,100)}%;height:100%;background:${_DONUT_COLORS[i % _DONUT_COLORS.length]};opacity:0.7"></div>
            </div>
            <span class="text-muted" style="flex:0 0 30px;text-align:right">${fmt(w,1)}%</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

function applySplitAdjustment(ticker, ratio, date) {
  if (!confirm(`Apply ${ratio}:1 split for ${ticker} on ${date}?\n\nThis will:\n• Multiply shares by ${ratio}\n• Divide avg price by ${ratio}\n• Multiply all open CGT parcel quantities by ${ratio}\n• Divide CGT parcel cost-per-share by ${ratio}\n\nMake sure this split has not already been applied.`)) return;

  // Adjust portfolio holding
  const holding = state.portfolio.find(h => h.ticker === ticker);
  if (holding) {
    holding.shares       = Math.round(holding.shares * ratio * 10000) / 10000;
    holding.avgPrice     = Math.round(holding.avgPrice / ratio * 10000) / 10000;
    holding.currentPrice = Math.round(holding.currentPrice / ratio * 10000) / 10000;
  }

  // Adjust open CGT parcels for this ticker
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
  toast(`Split applied: ${ticker} ${ratio}:1 — ${holding ? 'holding' : 'no holding'} updated, ${parcelCount} parcel(s) adjusted`, 'success');
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

  const holding = state.portfolio.find(h => h.ticker === ticker);
  if (!holding) { toast(`No holding found for ${ticker}`, 'error'); return; }

  const newShares  = holding.shares + drpShares;
  const newAvgPrice = Math.round(
    ((holding.shares * holding.avgPrice) + (drpShares * drpPrice)) / newShares * 10000
  ) / 10000;
  holding.shares   = Math.round(newShares   * 10000) / 10000;
  holding.avgPrice = newAvgPrice;

  const parcelId = Date.now();
  (state.cgtParcels = state.cgtParcels || []).push({
    id: parcelId, ticker, action: 'DRP', qty: drpShares, costPerShare: drpPrice,
    date, remainingQty: drpShares, notes: 'DRP — dividend reinvestment',
  });

  state.tradeJournal.push({
    id: parcelId + 1, date, ticker, action: 'DRP', qty: drpShares,
    entryPrice: drpPrice, exitPrice: null, fees: 0, pnl: 0,
    status: 'open', recId: null, recExecuted: false, closeDate: null,
    parcelId,
  });

  scheduleSave();
  renderPage();
  toast(`DRP recorded: ${drpShares} shares of ${ticker} @ $${fmt(drpPrice)}`, 'success');
}
