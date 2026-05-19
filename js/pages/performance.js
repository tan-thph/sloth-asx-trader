async function renderPerformancePage(gen) {
  const el = document.getElementById('main-content');
  if (state._renderGen !== gen) return;
  el.innerHTML = renderPerformance(); // sync render first (no waiting)
  // Then fetch and draw equity curve overlay
  if (state.serverOk && state.portfolio.length) {
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
          // Inject the equity curve card above the existing content
          const equityDiv = document.getElementById('perf-equity-curve');
          if (equityDiv) {
            equityDiv.innerHTML = _buildEquityCurveCard(navData);
            setTimeout(() => { if (state._renderGen === gen) _drawEquityCurveChart(navData); }, 60);
          }
        }
      }
    } catch {}
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
