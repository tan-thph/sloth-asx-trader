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
    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-label">Win Rate</div><div class="metric-value ${winRate>=50?'up':'down'}">${fmt(winRate,0)}%</div><div class="metric-sub">${wins}W / ${losses}L</div></div>
      <div class="metric-card"><div class="metric-label">Execution Rate</div><div class="metric-value">${fmt(execRate,0)}%</div><div class="metric-sub">${execRecs.length} of ${state.recHistory.length} recs</div></div>
      <div class="metric-card"><div class="metric-label">Realised P&L</div><div class="metric-value ${realised>=0?'up':'down'}">${sign(realised)}$${fmt(Math.abs(realised))}</div></div>
      <div class="metric-card"><div class="metric-label">Fees Paid</div><div class="metric-value">$${fmt(totalFees)}</div></div>
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
          // Reconcile outcomes: for each executed rec, find matching trade journal entry and derive win/loss from P&L
          const reconciledHistory = state.recHistory.map(r => {
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
          reconciledHistory.forEach((r, i) => {
            if (state.recHistory[i] && r.outcome !== state.recHistory[i].outcome) {
              state.recHistory[i].outcome = r.outcome;
              state.recHistory[i].actualProfit = r.actualProfit;
            }
          });
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
  `;
}
