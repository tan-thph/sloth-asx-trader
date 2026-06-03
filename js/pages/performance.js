function _buildDivForecastCard() {
  const holdings = mergedPortfolio().filter(h => {
    const d = state.dividendData[h.ticker];
    return d && d.annualDivPerShare != null && d.annualDivPerShare > 0;
  });
  if (!holdings.length) return '';

  // Franking credit gross-up: assumes 100% franked at 30% corporate tax rate
  // grossedUp = cash / (1 - 0.30); frankingCredit = grossedUp - cash
  const CORP_TAX = 0.30;
  const grossUp = v => v / (1 - CORP_TAX);

  const pv = portfolioValue();
  const tc = totalCost();
  let totalAnnual = 0, totalGrossed = 0;

  const rows = holdings.map(h => {
    const d = state.dividendData[h.ticker];
    const annual = h.shares * d.annualDivPerShare;
    const grossed = grossUp(annual);
    const frankingCredit = grossed - annual;
    totalAnnual  += annual;
    totalGrossed += grossed;

    const freqMap = { 'Quarterly': 4, 'Semi-annual': 2, 'Monthly': 12, 'Annual': 1 };
    const paymentsPerYear = freqMap[d.frequencyLabel] || 2;
    const perPayment = annual / paymentsPerYear;
    const yieldOnCost = h.avgPrice > 0 ? (d.annualDivPerShare / h.avgPrice * 100) : null;

    return `<tr>
      <td style="padding:5px 8px;font-size:12px;font-weight:600">${h.ticker}</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right">$${d.annualDivPerShare.toFixed(4)}</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right">${h.shares}</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right;color:#16a34a;font-weight:600">+$${fmt(annual)}</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right">+$${fmt(grossed)}</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right;color:#6d28d9">+$${fmt(frankingCredit)}</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right">${d.frequencyLabel||'?'} (~$${fmt(perPayment)})</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right">${yieldOnCost != null ? fmt(yieldOnCost) + '%' : '—'}</td>
    </tr>`;
  });

  const totalFranking = totalGrossed - totalAnnual;
  const netYield = tc > 0 ? (totalAnnual / tc * 100) : 0;
  const grossYield = tc > 0 ? (totalGrossed / tc * 100) : 0;

  return `
    <div class="card section-gap">
      <div class="flex-between" style="margin-bottom:10px">
        <div>
          <div class="card-title" style="margin:0">Dividend Income Forecast (12 months)</div>
          <div class="text-xs text-muted" style="margin-top:2px">Grossed-up assumes 100% franking at 30% corporate tax rate</div>
        </div>
        <div style="display:flex;gap:16px;align-items:center">
          <div style="text-align:right">
            <div class="text-xs text-muted">Annual cash income</div>
            <div style="font-size:16px;font-weight:700;color:#16a34a">+$${fmt(totalAnnual)}</div>
            <div class="text-xs text-muted">${fmt(netYield)}% yield on cost</div>
          </div>
          <div style="text-align:right">
            <div class="text-xs text-muted">Grossed-up (with franking)</div>
            <div style="font-size:16px;font-weight:700;color:#7c3aed">+$${fmt(totalGrossed)}</div>
            <div class="text-xs text-muted">+$${fmt(totalFranking)} franking credits</div>
          </div>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:left">Ticker</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:right">$/share/yr</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:right">Shares</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:right">Cash Income</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:right">Grossed-up</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:right;color:#6d28d9">Franking Cr.</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:right">Frequency</th>
            <th style="padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:right">Yield on Cost</th>
          </tr></thead>
          <tbody>${rows.join('')}
            <tr style="border-top:1px solid var(--border)">
              <td colspan="3" style="padding:6px 8px;font-size:12px;font-weight:700">Total</td>
              <td style="padding:6px 8px;font-size:12px;font-weight:700;text-align:right;color:#16a34a">+$${fmt(totalAnnual)}</td>
              <td style="padding:6px 8px;font-size:12px;font-weight:700;text-align:right">+$${fmt(totalGrossed)}</td>
              <td style="padding:6px 8px;font-size:12px;font-weight:700;text-align:right;color:#6d28d9">+$${fmt(totalFranking)}</td>
              <td style="padding:6px 8px;font-size:12px;text-align:right"></td>
              <td style="padding:6px 8px;font-size:12px;font-weight:700;text-align:right">${fmt(netYield)}% cash · ${fmt(grossYield)}% grossed</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`;
}

function _buildAttributionCard(closedTrades) {
  if (!closedTrades.length) return '';

  // Sector attribution
  const sectorMap = {};
  closedTrades.forEach(t => {
    const holding = typeof getPortfolioHolding === 'function' ? getPortfolioHolding(t.ticker) : null;
    const sector = t.sector || holding?.sector || 'Other';
    if (!sectorMap[sector]) sectorMap[sector] = { wins: 0, losses: 0, pnl: 0 };
    if (t.pnl > 0)  sectorMap[sector].wins++;
    if (t.pnl < 0)  sectorMap[sector].losses++;
    sectorMap[sector].pnl += Number(t.pnl) || 0;
  });
  const sectorRows = Object.entries(sectorMap)
    .sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))
    .map(([name, d]) => {
      const tot = d.wins + d.losses;
      const wr = tot ? (d.wins / tot * 100).toFixed(0) + '%' : '—';
      const pnlCol = d.pnl >= 0 ? '#16a34a' : '#dc2626';
      return `<tr>
        <td style="padding:5px 8px;font-size:12px;font-weight:500">${name}</td>
        <td style="padding:5px 8px;font-size:12px;text-align:center">${d.wins}W / ${d.losses}L</td>
        <td style="padding:5px 8px;font-size:12px;text-align:center">${wr}</td>
        <td style="padding:5px 8px;font-size:12px;text-align:right;color:${pnlCol};font-weight:600">${d.pnl >= 0 ? '+' : ''}$${fmt(Math.abs(d.pnl))}</td>
      </tr>`;
    }).join('');

  // Regime attribution (match via recId → recHistory.regime)
  const regimeMap = {};
  closedTrades.forEach(t => {
    const matchedRec = t.recId ? state.recHistory.find(r => r.id === t.recId) : null;
    const regime = matchedRec?.regime || 'unknown';
    if (!regimeMap[regime]) regimeMap[regime] = { wins: 0, losses: 0, pnl: 0 };
    if (t.pnl > 0)  regimeMap[regime].wins++;
    if (t.pnl < 0)  regimeMap[regime].losses++;
    regimeMap[regime].pnl += Number(t.pnl) || 0;
  });
  const regimeRows = Object.entries(regimeMap)
    .sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))
    .map(([name, d]) => {
      const tot = d.wins + d.losses;
      const wr = tot ? (d.wins / tot * 100).toFixed(0) + '%' : '—';
      const pnlCol = d.pnl >= 0 ? '#16a34a' : '#dc2626';
      return `<tr>
        <td style="padding:5px 8px;font-size:12px;font-weight:500">${name}</td>
        <td style="padding:5px 8px;font-size:12px;text-align:center">${d.wins}W / ${d.losses}L</td>
        <td style="padding:5px 8px;font-size:12px;text-align:center">${wr}</td>
        <td style="padding:5px 8px;font-size:12px;text-align:right;color:${pnlCol};font-weight:600">${d.pnl >= 0 ? '+' : ''}$${fmt(Math.abs(d.pnl))}</td>
      </tr>`;
    }).join('');

  const tableStyle = 'width:100%;border-collapse:collapse';
  const thStyle = 'padding:5px 8px;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:left';

  return `
    <div class="card">
      <div class="card-title">Performance Attribution</div>
      <div class="grid-2" style="gap:12px">
        <div>
          <div class="text-xs text-muted" style="margin-bottom:6px;font-weight:600">By Sector</div>
          ${sectorRows ? `<table style="${tableStyle}"><thead><tr>
            <th style="${thStyle}">Sector</th>
            <th style="${thStyle};text-align:center">W / L</th>
            <th style="${thStyle};text-align:center">Win %</th>
            <th style="${thStyle};text-align:right">P&amp;L</th>
          </tr></thead><tbody>${sectorRows}</tbody></table>`
          : '<div class="text-xs text-muted">No sector data available</div>'}
        </div>
        <div>
          <div class="text-xs text-muted" style="margin-bottom:6px;font-weight:600">By Regime at Entry</div>
          ${regimeRows ? `<table style="${tableStyle}"><thead><tr>
            <th style="${thStyle}">Regime</th>
            <th style="${thStyle};text-align:center">W / L</th>
            <th style="${thStyle};text-align:center">Win %</th>
            <th style="${thStyle};text-align:right">P&amp;L</th>
          </tr></thead><tbody>${regimeRows}</tbody></table>`
          : '<div class="text-xs text-muted">No regime data available</div>'}
        </div>
      </div>
    </div>`;
}

async function renderPerformancePage(gen) {
  const el = document.getElementById('main-content');
  if (state._renderGen !== gen) return;
  // Refresh outcomes from journal once, BEFORE render — keeps render pure.
  if (typeof reconcileRecOutcomes === 'function') reconcileRecOutcomes();
  el.innerHTML = renderPerformance(); // sync render first (no waiting)
  // Then fetch and draw equity curve overlay
  if (state.serverOk && state.portfolio.length) {
    const equityDiv = document.getElementById('perf-equity-curve');
    try {
      const resp = await fetch(`${API}/api/portfolio/nav-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portfolio: state.portfolio.map(h => ({ ticker: h.ticker, shares: h.shares })),
          cash:      state.cash || 0,
          period:    '1y',
        }),
      });
      if (resp.ok && state._renderGen === gen) {
        const navData = await resp.json();
        if (!navData.error) {
          if (equityDiv) {
            equityDiv.innerHTML = _buildEquityCurveCard(navData);
            setTimeout(() => { if (state._renderGen === gen) _drawEquityCurveChart(navData); }, 60);
          }
        } else if (equityDiv) {
          equityDiv.innerHTML = `<div class="card" style="margin-bottom:12px;padding:12px 16px;border-left:3px solid #f59e0b;background:var(--bg-secondary)">
            <span style="font-size:13px;color:var(--text-secondary)">⚠ Equity curve unavailable: ${escapeHTML(navData.error)}</span>
            ${_retryBtn('⟳ Retry', 'showPage(\'performance\')')}
          </div>`;
        }
      } else if (equityDiv && state._renderGen === gen) {
        equityDiv.innerHTML = `<div class="card" style="margin-bottom:12px;padding:12px 16px;border-left:3px solid #f59e0b;background:var(--bg-secondary)">
          <span style="font-size:13px;color:var(--text-secondary)">⚠ Equity curve unavailable — server returned ${resp.status}</span>
          ${_retryBtn('⟳ Retry', 'showPage(\'performance\')')}
        </div>`;
      }
    } catch (e) {
      if (equityDiv && state._renderGen === gen) {
        equityDiv.innerHTML = `<div class="card" style="margin-bottom:12px;padding:12px 16px;border-left:3px solid #f59e0b;background:var(--bg-secondary)">
          <span style="font-size:13px;color:var(--text-secondary)">⚠ Equity curve unavailable — ${escapeHTML(e.message || 'network error')}</span>
          ${_retryBtn('⟳ Retry', 'showPage(\'performance\')')}
        </div>`;
      }
    }
  }
}

function renderPerformance() {
  const closedTrades=state.tradeJournal.filter(t=>t.pnl!=null);
  const wins=closedTrades.filter(t=>t.pnl>0).length;
  const losses=closedTrades.filter(t=>t.pnl<0).length;
  const total=wins+losses;
  const winRate=total?wins/total*100:0;
  const execRecs=state.tradeJournal.filter(t=>t.recId != null);
  const execRate=state.recHistory.length?execRecs.length/state.recHistory.length*100:0;
  const totalFees=state.tradeJournal.reduce((s,t)=>s+(Number(t.fees)||0),0);
  const realised=closedTrades.reduce((s,t)=>s+(Number(t.pnl)||0),0);
  const skipped=state.recHistory.filter(r=>!r.executed);

  // Dividend income metrics
  const annualDivIncome = mergedPortfolio().reduce((sum, h) => {
    const d = state.dividendData[h.ticker];
    return sum + (d && d.annualDivPerShare != null ? h.shares * d.annualDivPerShare : 0);
  }, 0);
  const pv = portfolioValue();
  const totalCostVal = totalCost();
  const unrealised = totalGain();
  const netTotalReturn = realised + unrealised; // capital gains only
  const totalReturnWithDiv = netTotalReturn + annualDivIncome; // annualised
  const totalReturnPct = totalCostVal > 0 ? (netTotalReturn / totalCostVal) * 100 : 0;
  const divYieldOnCost = totalCostVal > 0 ? (annualDivIncome / totalCostVal) * 100 : 0;
  const totalReturnWithDivPct = totalReturnPct + divYieldOnCost;

  // ── Risk-adjusted metrics ──────────────────────────────────────────────────
  // Sortino ratio: mean(pnl%) / downside_deviation (target return = 0)
  // Journal entries store the buy price as entryPrice (not avgPrice/price)
  const pnlPcts = closedTrades.map(t => {
    const ep   = Number(t.entryPrice) || Number(t.avgPrice) || Number(t.price) || 0;
    const cost = t.qty && ep > 0 ? Number(t.qty) * ep : null;
    return cost && cost > 0 ? Number(t.pnl) / cost : 0;
  });
  const meanRet = pnlPcts.length ? pnlPcts.reduce((s,v)=>s+v,0)/pnlPcts.length : 0;
  const downside = pnlPcts.filter(v=>v<0);
  const downsideDev = downside.length
    ? Math.sqrt(downside.reduce((s,v)=>s+v*v,0)/downside.length)
    : 0;
  const sortinoRatio = downsideDev > 0 ? meanRet / downsideDev : null;

  // Profit Factor = gross wins / gross losses (replaces Calmar — works immediately, no history req)
  const grossWins   = closedTrades.filter(t=>t.pnl>0).reduce((s,t)=>s+Number(t.pnl),0);
  const grossLosses = Math.abs(closedTrades.filter(t=>t.pnl<0).reduce((s,t)=>s+Number(t.pnl),0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : null);

  // Avg Win $ / Avg Loss $ (replaces Avg Hold — no closeDate dependency)
  const winPnls  = closedTrades.filter(t=>t.pnl>0).map(t=>Number(t.pnl));
  const lossPnls = closedTrades.filter(t=>t.pnl<0).map(t=>Math.abs(Number(t.pnl)));
  const avgWinAud  = winPnls.length  ? winPnls.reduce((s,v)=>s+v,0)/winPnls.length   : null;
  const avgLossAud = lossPnls.length ? lossPnls.reduce((s,v)=>s+v,0)/lossPnls.length : null;
  const payoffRatio = avgWinAud != null && avgLossAud != null && avgLossAud > 0
    ? avgWinAud / avgLossAud : null;

  // Streaks
  const sortedTrades = [...closedTrades].sort((a,b) => (a.date||'').localeCompare(b.date||''));
  let winStreak=0, lossStreak=0, curW=0, curL=0;
  sortedTrades.forEach(t => {
    if (t.pnl > 0) { curW++; curL=0; if(curW>winStreak) winStreak=curW; }
    else            { curL++; curW=0; if(curL>lossStreak) lossStreak=curL; }
  });

  // ── Drawdown from portfolio history ───────────────────────────────────────
  const ph = state.portfolioHistory || [];
  let _ddPeak = 0, _ddMax = 0, _ddCurrent = 0;
  if (ph.length > 1) {
    for (const snap of ph) {
      const nw = Number(snap.netWorth) || 0;
      if (nw > _ddPeak) _ddPeak = nw;
      if (_ddPeak > 0) {
        const dd = (_ddPeak - nw) / _ddPeak * 100;
        if (dd > _ddMax) _ddMax = dd;
      }
    }
    const lastNw = Number(ph[ph.length - 1].netWorth) || 0;
    _ddCurrent = _ddPeak > 0 ? Math.max(0, (_ddPeak - lastNw) / _ddPeak * 100) : 0;
  }
  const ddAlertPct = Number(state.settings.drawdownAlertPct) || 10;
  const ddAlertActive = _ddCurrent > 0 && _ddCurrent >= ddAlertPct;

  const confBuckets=[0.5,0.6,0.7,0.8,0.9].map(c=>{
    const b=state.recHistory.filter(r=>r.confidence>=c&&r.confidence<c+0.1&&r.outcome!=='open'&&r.outcome!=='skipped');
    const w=b.filter(r=>r.outcome==='win').length;
    return {conf:fmt(c*100,0)+'%',wins:w,total:b.length,rate:b.length?w/b.length:null};
  });
  const apiCostLabel = 'API costs (Claude Console)';
  const apiCostValue = `<a href="https://console.anthropic.com/settings/cost" target="_blank" rel="noopener"
    style="font-size:13px;color:#3b82f6;font-weight:500;text-decoration:underline;display:inline-flex;align-items:center;gap:4px">
    View on Anthropic Console ↗</a>`;
  return `
    <!-- Equity curve placeholder — filled async by renderPerformancePage -->
    <div id="perf-equity-curve">
      ${state.serverOk && state.portfolio.length
        ? `<div class="card" style="margin-bottom:14px;padding:14px 18px;min-height:56px;display:flex;align-items:center;gap:10px">
             <div class="loading-dots"><span></span><span></span><span></span></div>
             <span class="text-xs text-muted">Loading portfolio NAV history…</span>
           </div>`
        : ''}
    </div>

    ${ddAlertActive ? `
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:var(--radius-md);padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px">
      <span style="font-size:18px">⚠️</span>
      <div>
        <strong style="color:#dc2626">Drawdown alert: portfolio is down ${_ddCurrent.toFixed(1)}% from peak</strong>
        <div class="text-xs" style="color:#7f1d1d;margin-top:2px">Alert threshold is ${ddAlertPct}%. Consider reviewing position sizes and stops.</div>
      </div>
    </div>` : ''}

    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-label">Win Rate</div><div class="metric-value ${winRate>=50?'up':'down'}">${fmt(winRate,0)}%</div><div class="metric-sub">${wins}W / ${losses}L</div></div>
      <div class="metric-card"><div class="metric-label">Execution Rate</div><div class="metric-value">${fmt(execRate,0)}%</div><div class="metric-sub">${execRecs.length} of ${state.recHistory.length} recs</div></div>
      <div class="metric-card"><div class="metric-label">Realised P&L</div><div class="metric-value ${realised>=0?'up':'down'}">${sign(realised)}$${fmt(Math.abs(realised))}</div></div>
      <div class="metric-card"><div class="metric-label">Fees Paid</div><div class="metric-value">$${fmt(totalFees)}</div></div>
      ${ph.length > 1 ? `
      <div class="metric-card">
        <div class="metric-label">Current Drawdown</div>
        <div class="metric-value ${_ddCurrent > ddAlertPct ? 'down' : _ddCurrent > 5 ? '' : 'up'}">${_ddCurrent > 0 ? '-' : ''}${_ddCurrent.toFixed(1)}%</div>
        <div class="metric-sub">from peak net worth</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Max Drawdown</div>
        <div class="metric-value ${_ddMax > 20 ? 'down' : _ddMax > 10 ? '' : 'up'}">${_ddMax > 0 ? '-' : ''}${_ddMax.toFixed(1)}%</div>
        <div class="metric-sub" style="display:flex;align-items:center;gap:6px">
          Alert at
          <input type="number" value="${ddAlertPct}" min="1" max="50" step="1"
            style="width:44px;padding:1px 4px;font-size:11px;border-radius:3px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary)"
            onchange="updateSetting('drawdownAlertPct', this.value); renderPage()" title="Alert threshold %">%
        </div>
      </div>` : ''}
    </div>

    <!-- Total Return card with dividend overlay -->
    <div class="card section-gap">
      <div class="card-title">Total Return Decomposition</div>
      <div class="grid-4" style="gap:8px;margin-bottom:12px">
        <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)">
          <div class="text-xs">Unrealised Gain</div>
          <div style="font-size:18px;font-weight:600;color:${unrealised>=0?'#16a34a':'#dc2626'}">${sign(unrealised)}$${fmt(Math.abs(unrealised))}</div>
          <div class="text-xs text-muted">${fmt(pv>0?unrealised/totalCostVal*100:0)}% on cost</div>
        </div>
        <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)">
          <div class="text-xs">Realised P&L</div>
          <div style="font-size:18px;font-weight:600;color:${realised>=0?'#16a34a':'#dc2626'}">${sign(realised)}$${fmt(Math.abs(realised))}</div>
          <div class="text-xs text-muted">${closedTrades.length} closed trades</div>
        </div>
        ${annualDivIncome > 0 ? `
        <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)">
          <div class="text-xs">Est. Annual Div Income</div>
          <div style="font-size:18px;font-weight:600;color:#16a34a">+$${fmt(annualDivIncome)}</div>
          <div class="text-xs text-muted">${fmt(divYieldOnCost)}% yield on cost · vs RBA ${state.rbaRate.toFixed(2)}%</div>
        </div>
        <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)">
          <div class="text-xs">Total Return (Capital + Yield)</div>
          <div style="font-size:18px;font-weight:600;color:${totalReturnWithDivPct>=0?'#16a34a':'#dc2626'}">${sign(totalReturnWithDivPct)}${fmt(Math.abs(totalReturnWithDivPct))}%</div>
          <div class="text-xs text-muted">${fmt(totalReturnPct)}% capital + ${fmt(divYieldOnCost)}% yield</div>
        </div>` : `
        <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)">
          <div class="text-xs">Total Return (Capital)</div>
          <div style="font-size:18px;font-weight:600;color:${totalReturnPct>=0?'#16a34a':'#dc2626'}">${sign(totalReturnPct)}${fmt(Math.abs(totalReturnPct))}%</div>
          <div class="text-xs text-muted">Load dividend data for full return</div>
        </div>
        <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)">
          <div class="text-xs">Div Income</div>
          <div style="font-size:18px;font-weight:600;color:var(--text-secondary)">—</div>
          <div class="text-xs text-muted"><button class="btn btn-sm" onclick="fetchDividends(state.portfolio.map(h=>h.ticker),true).then(renderPage)">Load Dividends</button></div>
        </div>`}
      </div>
    </div>

    ${_buildDivForecastCard()}

    <div class="grid-2">
      <div class="card">
        <div class="card-title">Confidence Calibration</div>
        <p class="text-xs text-muted mb-1">Predicted confidence vs actual win rate.</p>
        ${confBuckets.map(b=>`
          <div class="signal-row">
            <span class="text-sm">${b.conf} confidence</span>
            ${b.total>0?`<div class="flex-row"><div class="conf-bar" style="width:100px"><div class="conf-fill" style="width:${b.rate*100}%;background:${confColor(b.rate)}"></div></div><span class="text-xs">${fmt(b.rate*100,0)}% actual (${b.total} trades)</span></div>`:'<span class="text-xs text-muted">No data</span>'}
          </div>`).join('')}
      </div>
      <div class="card">
        <div class="card-title">Recommendation Outcomes</div>
        ${(()=>{
          // Read-only reconciliation for display. State mutation is handled
          // separately by reconcileRecOutcomes() (called from journal close flows).
          const reconciledHistory = computeReconciledRecHistory();
          const execWon  = reconciledHistory.filter(r=>r.executed&&r.outcome==='win').length;
          const execLost = reconciledHistory.filter(r=>r.executed&&r.outcome==='loss').length;
          const execOpen = reconciledHistory.filter(r=>r.executed&&r.outcome==='open').length;
          const rows = [
            ['Executed & Won', execWon, '#22c55e'],
            ['Executed & Lost', execLost, '#ef4444'],
            ['Executed (Open)', execOpen, '#3b82f6'],
            ['Skipped', skipped.length, '#9ca3af']
          ];
          return rows.map(([l,c,col]) =>
            '<div class="signal-row"><div class="flex-row"><div style="width:10px;height:10px;border-radius:2px;background:'+col+';flex-shrink:0"></div><span class="text-sm">'+l+'</span></div><strong>'+c+'</strong></div>'
          ).join('');
        })()}
        <div class="divider"></div>
        <div class="signal-row"><span class="text-sm text-muted">Net after all costs</span><strong class="${realised-totalFees>=0?'text-success':'text-danger'}">${sign(realised-totalFees)}$${fmt(Math.abs(realised-totalFees))}</strong></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Cost Breakdown</div>
      <div class="grid-3" style="gap:8px">
        <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)"><div class="text-xs">Total brokerage</div><div style="font-size:18px;font-weight:600">$${fmt(totalFees)}</div></div>
        <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)"><div class="text-xs">${apiCostLabel}</div><div style="font-size:18px;font-weight:600">${apiCostValue}</div></div>
        <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)"><div class="text-xs">Net after costs</div><div style="font-size:18px;font-weight:600;color:${realised-totalFees>=0?'#16a34a':'#dc2626'}">${sign(realised-totalFees)}$${fmt(Math.abs(realised-totalFees))}</div></div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">Risk-Adjusted Ratios</div>
        <div class="grid-2" style="gap:8px;margin-bottom:10px">
          <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)">
            <div class="text-xs">Sortino Ratio</div>
            <div style="font-size:18px;font-weight:600;color:${sortinoRatio==null?'var(--text-secondary)':sortinoRatio>=1?'#16a34a':sortinoRatio>=0?'#d97706':'#dc2626'}">
              ${sortinoRatio==null?'—':fmt(sortinoRatio,2)}
            </div>
            <div class="text-xs text-muted">Return / downside deviation · ≥ 1.0 = good</div>
          </div>
          <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)"
               title="Gross wins ÷ gross losses. > 1.5 = edge exists. > 2.0 = strong edge.">
            <div class="text-xs">Profit Factor</div>
            <div style="font-size:18px;font-weight:600;color:${profitFactor==null?'var(--text-secondary)':profitFactor===Infinity?'#16a34a':profitFactor>=2?'#16a34a':profitFactor>=1.5?'#16a34a':profitFactor>=1?'#d97706':'#dc2626'}">
              ${profitFactor==null?'—':profitFactor===Infinity?'∞':fmt(profitFactor,2)}
            </div>
            <div class="text-xs text-muted">${losses===0?'No losing trades yet':'Gross wins / gross losses · ≥ 1.5 = edge'}</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Trade Streaks &amp; Payoff</div>
        <div class="grid-2" style="gap:8px">
          <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)">
            <div class="text-xs">Longest Win Streak</div>
            <div style="font-size:18px;font-weight:600;color:#16a34a">${winStreak} trade${winStreak!==1?'s':''}</div>
            <div class="text-xs text-muted">Consecutive wins</div>
          </div>
          <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)">
            <div class="text-xs">Longest Loss Streak</div>
            <div style="font-size:18px;font-weight:600;color:${lossStreak>=3?'#dc2626':lossStreak>=2?'#d97706':'var(--text-primary)'}">${lossStreak} trade${lossStreak!==1?'s':''}</div>
            <div class="text-xs text-muted">Consecutive losses</div>
          </div>
          <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)"
               title="Average dollar P&L on winning trades.">
            <div class="text-xs">Avg Win</div>
            <div style="font-size:18px;font-weight:600;color:${avgWinAud==null?'var(--text-secondary)':'#16a34a'}">
              ${avgWinAud==null?'—':'$'+fmt(avgWinAud)}
            </div>
            <div class="text-xs text-muted">${winPnls.length>0?`${winPnls.length} winning trade${winPnls.length!==1?'s':''}·${payoffRatio!=null?' ratio '+fmt(payoffRatio,1)+'×':''}` : 'No winning trades yet'}</div>
          </div>
          <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)"
               title="Average dollar loss on losing trades. Avg Win ÷ Avg Loss = payoff ratio.">
            <div class="text-xs">Avg Loss</div>
            <div style="font-size:18px;font-weight:600;color:${avgLossAud==null?'var(--text-secondary)':'#dc2626'}">
              ${avgLossAud==null?'—':'$'+fmt(avgLossAud)}
            </div>
            <div class="text-xs text-muted">${lossPnls.length>0?`${lossPnls.length} losing trade${lossPnls.length!==1?'s':''}` : 'No losing trades yet'}</div>
          </div>
        </div>
      </div>
    </div>

    ${_buildAttributionCard(closedTrades)}

    <div class="card">
      <div class="flex-between" style="align-items:center">
        <div>
          <div class="card-title" style="margin:0">Trade Journal Export</div>
          <div class="text-xs text-muted" style="margin-top:2px">ATO-compatible CSV — drop into your tax spreadsheet or accountant portal</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-sm" onclick="syncClosedTradesToLearningLoop()" style="white-space:nowrap" title="Push closed trade outcomes from Performance tab into the Learning Loop database">
            🧠 Sync to Learning Loop
          </button>
          <button class="btn btn-sm" onclick="exportTradeJournalCSV()" style="white-space:nowrap">
            ↓ Export CSV
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Portfolio Equity Curve ────────────────────────────────────────────────────

function _buildEquityCurveCard(d) {
  const isUp = d.total_return >= 0;
  const retColor = isUp ? '#16a34a' : '#dc2626';
  const benchLabel = d.bench_return != null
    ? `<span class="text-xs text-muted" style="margin-left:12px">VAS benchmark: <span style="color:${d.bench_return>=0?'#16a34a':'#dc2626'};font-weight:600">${d.bench_return>=0?'+':''}${d.bench_return.toFixed(2)}%</span></span>`
    : '';
  return `
    <div class="card" style="margin-bottom:14px">
      <div class="flex-between" style="margin-bottom:10px">
        <div>
          <div class="card-title" style="margin:0">Portfolio NAV — 1 Year</div>
          <div style="margin-top:4px;display:flex;align-items:center;flex-wrap:wrap;gap:4px">
            <span style="font-size:15px;font-weight:700;color:${retColor}">${isUp?'+':''}${d.total_return.toFixed(2)}%</span>
            <span class="text-xs text-muted">total return</span>
            ${benchLabel}
            <span class="text-xs text-muted" style="margin-left:12px">Max DD: <span style="color:${d.max_drawdown>18?'#dc2626':d.max_drawdown>8?'#d97706':'#16a34a'};font-weight:600">${d.max_drawdown.toFixed(1)}%</span></span>
          </div>
        </div>
        <div style="display:flex;gap:12px;font-size:11px;color:var(--text-muted)">
          <span><span style="display:inline-block;width:18px;height:2px;background:#3b82f6;vertical-align:middle;margin-right:4px"></span>Portfolio</span>
          ${d.benchmark ? `<span><span style="display:inline-block;width:18px;height:2px;border-top:2px dashed #f59e0b;vertical-align:middle;margin-right:4px"></span>VAS</span>` : ''}
        </div>
      </div>
      <div style="overflow-x:auto">
        <canvas id="equity-curve-canvas" style="width:100%;height:200px;display:block"></canvas>
      </div>
    </div>`;
}

function _drawEquityCurveChart(d) {
  const canvas = document.getElementById('equity-curve-canvas');
  if (!canvas || !d.values?.length) return;
  canvas.width  = canvas.offsetWidth || 800;
  canvas.height = 200;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const PAD_L = 60, PAD_R = 16, PAD_T = 10, PAD_B = 28;
  const cW = W - PAD_L - PAD_R;
  const cH = H - PAD_T - PAD_B;

  const vals  = d.values;
  const bench = d.benchmark;
  const dates = d.dates;
  const allV  = bench ? [...vals, ...bench] : vals;
  const mn = Math.min(...allV) * 0.995;
  const mx = Math.max(...allV) * 1.005;
  const rng = mx - mn || 1;

  const xOf = i => PAD_L + (i / (vals.length - 1)) * cW;
  const yOf = v => PAD_T + (1 - (v - mn) / rng) * cH;

  ctx.clearRect(0, 0, W, H);

  // Horizontal grid lines
  ctx.strokeStyle = 'rgba(128,128,128,0.1)';
  ctx.lineWidth = 0.5;
  for (let g = 0; g <= 4; g++) {
    const y = PAD_T + (g / 4) * cH;
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
    const gridVal = mx - (g / 4) * rng;
    ctx.fillStyle = 'rgba(100,116,139,0.7)';
    ctx.font = '9px system-ui,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('$' + Math.round(gridVal).toLocaleString(), PAD_L - 4, y + 3);
  }

  // Benchmark line (dashed amber)
  if (bench?.length) {
    ctx.beginPath();
    bench.forEach((v, i) => { const x = xOf(i), y = yOf(v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Portfolio area fill
  const isUp = vals[vals.length - 1] >= vals[0];
  const grad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + cH);
  grad.addColorStop(0, isUp ? 'rgba(59,130,246,0.18)' : 'rgba(239,68,68,0.12)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  vals.forEach((v, i) => { const x = xOf(i), y = yOf(v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.lineTo(xOf(vals.length - 1), PAD_T + cH);
  ctx.lineTo(PAD_L, PAD_T + cH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Portfolio line (blue)
  ctx.beginPath();
  vals.forEach((v, i) => { const x = xOf(i), y = yOf(v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2;
  ctx.stroke();

  // X-axis date labels (show ~5 evenly spaced)
  if (dates?.length) {
    ctx.fillStyle = 'rgba(100,116,139,0.8)';
    ctx.font = '9px system-ui,sans-serif';
    ctx.textAlign = 'center';
    const step = Math.floor(dates.length / 4);
    [0, step, step*2, step*3, dates.length - 1].forEach(i => {
      if (i < dates.length) {
        const d2 = dates[i];
        const label = d2.slice(5); // MM-DD
        ctx.fillText(label, xOf(i), H - 6);
      }
    });
  }

  // Current value label
  const lastV = vals[vals.length - 1];
  ctx.fillStyle = '#3b82f6';
  ctx.font = 'bold 10px system-ui,sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('$' + lastV.toLocaleString(), W - PAD_R, yOf(lastV) - 4);
}

// ── ATO-compatible Trade Journal CSV Export ───────────────────────────────────
function exportTradeJournalCSV() {
  const trades = state.tradeJournal || [];
  if (!trades.length) {
    alert('No trade journal entries to export.');
    return;
  }

  // Columns: Open Date, Close Date, Ticker, Action, Qty, Buy Price, Sell Price,
  //          Brokerage, Cost Base, Proceeds, Gross P&L, CGT Discount Eligible
  const headers = [
    'Open Date', 'Close Date', 'Ticker', 'Action', 'Qty',
    'Buy Price', 'Sell Price', 'Brokerage (AUD)',
    'Cost Base (AUD)', 'Proceeds (AUD)', 'Gross P&L (AUD)', 'CGT Discount Eligible (>12m)'
  ];

  const esc = v => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };

  const rows = trades.map(t => {
    const isClose   = t.status === 'closed' && t.pnl != null;
    // Open/close dates: SELL entries now store date=open, closeDate=close
    const openDate  = t.date || '';
    const closeDate = t.closeDate || (isClose ? t.date : '') || '';
    const ticker    = t.ticker || '';
    const action    = t.action || t.type || '';
    const qty       = Number(t.qty) || 0;
    // entryPrice = buy price (avg cost for sells), exitPrice = sell price
    const buyPrice  = Number(t.entryPrice) || Number(t.avgPrice) || Number(t.price) || 0;
    const sellPrice = isClose ? (Number(t.exitPrice) || 0) : 0;
    const brokerage = Number(t.fees) || 0;
    // ATO cost base = qty × buy price + brokerage
    const costBase  = qty * buyPrice + brokerage;
    // Proceeds = costBase + P&L (or directly qty × sellPrice for transparency)
    const proceeds  = isClose ? Number((costBase + Number(t.pnl)).toFixed(2)) : '';
    const grossPnl  = isClose ? Number(t.pnl) : '';

    // CGT discount: held > 12 months and net gain > 0
    let cgtEligible = '';
    if (openDate && closeDate && openDate !== closeDate) {
      const held = (new Date(closeDate) - new Date(openDate)) / 86400000;
      cgtEligible = isClose ? (held > 365 && Number(grossPnl) > 0 ? 'Y' : 'N') : '';
    }

    return [
      esc(openDate), esc(closeDate), esc(ticker), esc(action),
      esc(qty),
      buyPrice  ? esc(buyPrice.toFixed(4))  : '',
      sellPrice ? esc(sellPrice.toFixed(4)) : '',
      esc(brokerage.toFixed(2)),
      esc(costBase.toFixed(2)),
      proceeds !== '' ? esc(proceeds.toFixed(2)) : '',
      grossPnl !== '' ? esc(Number(grossPnl).toFixed(2)) : '',
      esc(cgtEligible)
    ].join(',');
  });

  // Tax Year Summary row
  const closed    = trades.filter(t => t.pnl != null);
  const totalProc = closed.reduce((s, t) => {
    const qty = Number(t.qty) || 0;
    const ep  = Number(t.entryPrice) || Number(t.avgPrice) || Number(t.price) || 0;
    const fee = Number(t.fees) || 0;
    return s + (qty * ep + fee + Number(t.pnl));
  }, 0);
  const totalCostB = closed.reduce((s, t) => {
    const qty = Number(t.qty) || 0;
    const ep  = Number(t.entryPrice) || Number(t.avgPrice) || Number(t.price) || 0;
    return s + qty * ep + (Number(t.fees) || 0);
  }, 0);
  const netGain = closed.reduce((s,t) => s + Number(t.pnl), 0);
  const fyLabel = (() => {
    const now = new Date();
    const fy  = now.getMonth() >= 6 ? now.getFullYear()+1 : now.getFullYear();
    return `FY${fy} Summary`;
  })();
  rows.push([
    esc(fyLabel), '', '', '', '', '', '', '',
    esc(totalCostB.toFixed(2)),
    esc(totalProc.toFixed(2)),
    esc(netGain.toFixed(2)),
    ''
  ].join(','));

  const csv  = [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `sloth-trade-journal-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Sync closed trade outcomes → Learning Loop backend ────────────────────────
// For each recHistory entry with a _learningId and a reconciled win/loss outcome,
// call POST /api/learning/outcome. Also handles existing recs without a _learningId
// by re-logging them as new events with was_executed:true.
// _detectExitReason is defined in utils.js (single canonical copy)

async function syncClosedTradesToLearningLoop() {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }

  const history = state.recHistory || [];
  // Reconcile outcomes from trade journal (same logic as renderPerformance)
  const reconciled = history.map(r => {
    if (!r.executed || r.outcome === 'skipped') return r;
    const jMatch = state.tradeJournal.find(t =>
      (t.recId === r.id || (t.ticker === r.ticker && t.date === r.date)) &&
      t.status === 'closed' && t.pnl != null
    );
    if (jMatch) {
      const outcome = jMatch.pnl > 0 ? 'win' : jMatch.pnl < 0 ? 'loss' : 'breakeven';
      const entryPrice = jMatch.entryPrice || jMatch.avgPrice || (Array.isArray(r.priceRange) ? r.priceRange[0] : null);
      const qty = jMatch.qty || r.qty || 1;
      const pnlPct = entryPrice && qty ? (jMatch.pnl / (entryPrice * qty)) * 100 : null;
      const holdDays = (jMatch.date && jMatch.closeDate)
        ? Math.max(0, Math.round((new Date(jMatch.closeDate) - new Date(jMatch.date)) / 86400000))
        : null;
      const holding = typeof getPortfolioHolding === 'function' ? getPortfolioHolding(r.ticker) : null;
      const sector = r.sector || holding?.sector || null;
      return {
        ...r, outcome, actualProfit: jMatch.pnl, _pnlPct: pnlPct, _holdDays: holdDays,
        _entryPrice: entryPrice, _exitPrice: jMatch.exitPrice ?? null, _sector: sector,
      };
    }
    return r;
  });

  const toUpdate = reconciled.filter(r =>
    r._learningId && r.outcome && r.outcome !== 'open' && r.outcome !== 'skipped'
  );
  const toLog = reconciled.filter(r =>
    !r._learningId && r.executed && r.outcome && r.outcome !== 'open'
  );

  let updated = 0, logged = 0;
  const pv = typeof PROMPT_VERSION !== 'undefined' ? PROMPT_VERSION : 'unknown';

  for (const r of toUpdate) {
    try {
      // Backfill rr_ratio for legacy synced records that had it as NULL
      const _rrE2 = r._entryPrice ?? (Array.isArray(r.priceRange) ? r.priceRange[0] : null);
      const _rrS2 = r.stopLoss ?? null;
      const _rrT2 = r.target   ?? null;
      let _rr2 = null;
      if (_rrE2 && _rrS2 && _rrT2 && _rrE2 !== _rrS2) {
        const raw2 = Math.abs((_rrT2 - _rrE2) / (_rrE2 - _rrS2));
        if (isFinite(raw2) && raw2 > 0) _rr2 = +raw2.toFixed(2);
      }
      const resp = await fetch(`${API}/api/learning/outcome`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: r._learningId,
          outcome_status:      r.outcome,
          was_executed:        r.executed,
          rr_ratio:            _rr2,   // backfill for legacy NULL records
          realized_pnl_aud:    r.actualProfit != null ? +r.actualProfit.toFixed(2) : null,
          realized_pnl_pct:    r._pnlPct != null ? +r._pnlPct.toFixed(2) : null,
          holding_period_days: r._holdDays ?? null,
          actual_entry_price:  r._entryPrice ?? null,
          actual_exit_price:   r._exitPrice  ?? null,
          sector:              r._sector     ?? null,
          exit_reason:         _detectExitReason(r._exitPrice, r.stopLoss, r.target, r.action),
        }),
      });
      if ((await resp.json()).ok) updated++;
    } catch (_) {}
  }

  for (const r of toLog) {
    try {
      // Compute R:R from stored prices — the original log call skipped this.
      // Works for both BUY (stop below entry) and SELL/TRIM (stop above entry)
      // because Math.abs handles both sign combinations.
      const _rrEntry = r._entryPrice ?? (Array.isArray(r.priceRange) ? r.priceRange[0] : null);
      const _rrStop  = r.stopLoss ?? null;
      const _rrTgt   = r.target   ?? null;
      let _rrRatio   = null;
      if (_rrEntry && _rrStop && _rrTgt && _rrEntry !== _rrStop) {
        const raw = Math.abs((_rrTgt - _rrEntry) / (_rrEntry - _rrStop));
        if (isFinite(raw) && raw > 0) _rrRatio = +raw.toFixed(2);
      }
      // Rationale: join array to string if needed (old recs stored as array)
      const _rationale = (() => {
        if (!r.reasoning) return null;
        if (typeof r.reasoning === 'string') return r.reasoning.slice(0, 400);
        if (Array.isArray(r.reasoning)) return r.reasoning.join(' ').slice(0, 400);
        return null;
      })();

      const resp = await fetch(`${API}/api/learning/log`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type:          'recommendation',
          ticker:              r.ticker,
          prompt_version:      pv,
          agent_type:          'portfolio-scanner-sync',
          ai_confidence:       r.confidence ?? null,
          ensemble_confidence: r.ensembleConfidence ?? null,
          recommendation:      r.action,
          rationale_summary:   _rationale,
          suggested_stop:      r.stopLoss ?? null,
          suggested_target:    r.target ?? null,
          rr_ratio:            _rrRatio,
          was_executed:        true,
          outcome_status:      r.outcome,
          realized_pnl_aud:    r.actualProfit != null ? +r.actualProfit.toFixed(2) : null,
          realized_pnl_pct:    r._pnlPct != null ? +r._pnlPct.toFixed(2) : null,
          holding_period_days: r._holdDays ?? null,
          actual_entry_price:  r._entryPrice ?? null,
          actual_exit_price:   r._exitPrice  ?? null,
          sector:              r._sector     ?? null,
          exit_reason:         _detectExitReason(r._exitPrice, r.stopLoss, r.target, r.action),
        }),
      });
      const res = await resp.json();
      if (res.id) {
        r._learningId = res.id;
        // Persist _learningId back onto the original state.recHistory entry so
        // scheduleSave() writes it and the next Sync doesn't re-log the same trade.
        const orig = (state.recHistory || []).find(x => x.id === r.id);
        if (orig) orig._learningId = res.id;
        logged++;
      }
    } catch (_) {}
  }

  scheduleSave();
  toast(`Learning Loop sync: ${updated} outcomes updated, ${logged} historical trades logged`, 'success');
}

// ── Outcome reconciliation ────────────────────────────────────────────────────
// computeReconciledRecHistory() — pure: returns a copy of state.recHistory with
// each executed rec's outcome derived from the matching trade journal entry.
// Used by renderPerformance() for display.
function computeReconciledRecHistory() {
  return state.recHistory.map(r => {
    if (!r.executed || r.outcome === 'skipped') return r;
    const journalMatch = state.tradeJournal.find(t =>
      t.recId === r.id && t.status === 'closed' && t.pnl != null
    );
    if (journalMatch) {
      const outcome = journalMatch.pnl > 0 ? 'win' : journalMatch.pnl < 0 ? 'loss' : 'open';
      return { ...r, outcome, actualProfit: journalMatch.pnl };
    }
    const sameDayTrade = state.tradeJournal.find(t =>
      t.ticker === r.ticker && t.date === r.date && t.status === 'closed' && t.pnl != null
    );
    if (sameDayTrade) {
      const outcome = sameDayTrade.pnl > 0 ? 'win' : sameDayTrade.pnl < 0 ? 'loss' : 'open';
      return { ...r, outcome, actualProfit: sameDayTrade.pnl };
    }
    return r;
  });
}

// reconcileRecOutcomes() — mutates state.recHistory in place; call from trade
// close flows (journal closeTrade, sync to learning loop). Persists via scheduleSave().
function reconcileRecOutcomes() {
  const reconciled = computeReconciledRecHistory();
  let changed = 0;
  reconciled.forEach((r, i) => {
    const cur = state.recHistory[i];
    if (cur && (r.outcome !== cur.outcome || r.actualProfit !== cur.actualProfit)) {
      state.recHistory[i].outcome = r.outcome;
      state.recHistory[i].actualProfit = r.actualProfit;
      changed++;
    }
  });
  if (changed > 0) scheduleSave();
  return changed;
}
