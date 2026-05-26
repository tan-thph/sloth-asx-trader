async function renderPerformancePage(gen) {
  const el = document.getElementById('main-content');
  if (state._renderGen !== gen) return;
  // Refresh outcomes from journal once, BEFORE render — keeps render pure.
  if (typeof reconcileRecOutcomes === 'function') reconcileRecOutcomes();
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

  // Calmar ratio: annualised return / max drawdown.
  // Requires ≥ 90d of trading history — shorter spans extrapolate too aggressively.
  // Annualisation factor is clamped so a 31-day span doesn't 12× the numerator
  // while max-drawdown stays raw, which produced absurd Calmar values previously.
  let calmarRatio = null;
  // 'trades' | 'span' | 'noderawdown' | false
  let calmarInsufficient = closedTrades.length < 5 ? 'trades' : false;
  if (!calmarInsufficient) {
    const sorted = [...closedTrades].sort((a,b) => (a.date||'').localeCompare(b.date||''));
    let cumPnl = 0, peak = 0, maxDD = 0;
    sorted.forEach(t => {
      cumPnl += Number(t.pnl)||0;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak > 0 ? (peak - cumPnl) / peak * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    });
    const firstDate = sorted[0]?.date;
    const lastDate  = sorted[sorted.length-1]?.date;
    const daySpan   = firstDate && lastDate
      ? (new Date(lastDate) - new Date(firstDate)) / 86400000 : 0;
    if (daySpan < 90) {
      calmarInsufficient = 'span';
    } else {
      // Clamp to ≤ 4× to suppress wild extrapolation on short histories.
      const annFactor = Math.min(365 / daySpan, 4);
      const annReturn = realised * annFactor;
      const cost0     = totalCostVal || 1;
      if (maxDD === 0) {
        calmarInsufficient = 'nodrawdown';
      } else {
        calmarRatio = (annReturn / cost0 * 100) / maxDD;
      }
    }
  }

  // Streaks and avg hold days
  const sortedTrades = [...closedTrades].sort((a,b) => (a.date||'').localeCompare(b.date||''));
  let winStreak=0, lossStreak=0, curW=0, curL=0;
  sortedTrades.forEach(t => {
    if (t.pnl > 0) { curW++; curL=0; if(curW>winStreak) winStreak=curW; }
    else            { curL++; curW=0; if(curL>lossStreak) lossStreak=curL; }
  });
  const holdDays = t => {
    // closeDate is set on SELL entries; date is open (buy) date for BUY, open date for SELL.
    // Fallback: if status='closed' and only date exists, the entry pre-dates the closeDate field.
    const open  = t.date;
    const close = t.closeDate;
    if (!open || !close) return null;
    const diff = Math.round((new Date(close) - new Date(open)) / 86400000);
    return diff >= 0 ? diff : null;
  };
  const winHolds  = closedTrades.filter(t=>t.pnl>0).map(holdDays).filter(d=>d!=null);
  const lossHolds = closedTrades.filter(t=>t.pnl<0).map(holdDays).filter(d=>d!=null);
  const avgHoldWin  = winHolds.length  ? winHolds.reduce((s,v)=>s+v,0)/winHolds.length   : null;
  const avgHoldLoss = lossHolds.length ? lossHolds.reduce((s,v)=>s+v,0)/lossHolds.length : null;

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
            <div class="text-xs text-muted">Downside deviation only · ≥ 1.0 = good</div>
          </div>
          <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)">
            <div class="text-xs">Calmar Ratio</div>
            <div style="font-size:18px;font-weight:600;color:${calmarRatio==null?'var(--text-secondary)':calmarRatio>=1?'#16a34a':calmarRatio>=0?'#d97706':'#dc2626'}">
              ${calmarRatio==null?'—':fmt(calmarRatio,2)}
            </div>
            <div class="text-xs text-muted">${
              calmarInsufficient === 'trades'     ? `Needs ≥ 5 closed trades (have ${closedTrades.length})` :
              calmarInsufficient === 'span'       ? 'Needs ≥ 90 days between first & last closed trade' :
              calmarInsufficient === 'nodrawdown' ? 'No drawdown yet — all trades profitable' :
              'Ann. return / max drawdown · ≥ 1.0 = good'
            }</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Trade Streaks &amp; Hold Duration</div>
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
               title="Hold duration = close date minus open date. Only counted for trades executed via Recommendations tab (which records both open and close dates).">
            <div class="text-xs">Avg Hold — Winners</div>
            <div style="font-size:18px;font-weight:600">${avgHoldWin!=null?Math.round(avgHoldWin)+'d':'—'}</div>
            <div class="text-xs text-muted">${winHolds.length > 0 ? `${winHolds.length} winning trade${winHolds.length!==1?'s':''}` : 'No winning closes yet'}</div>
          </div>
          <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md)"
               title="Hold duration = close date minus open date. Only counted for trades executed via Recommendations tab (which records both open and close dates).">
            <div class="text-xs">Avg Hold — Losers</div>
            <div style="font-size:18px;font-weight:600">${avgHoldLoss!=null?Math.round(avgHoldLoss)+'d':'—'}</div>
            <div class="text-xs text-muted">${lossHolds.length > 0 ? `${lossHolds.length} losing trade${lossHolds.length!==1?'s':''}` : 'No losing closes yet'}</div>
          </div>
        </div>
      </div>
    </div>

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
function _detectExitReason(exitPrice, stopLoss, target) {
  if (!exitPrice || exitPrice <= 0) return 'manual';
  if (stopLoss && exitPrice <= stopLoss * 1.005) return 'stop_hit';
  if (target   && exitPrice >= target  * 0.995)  return 'target_hit';
  return 'manual';
}

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
      const resp = await fetch(`${API}/api/learning/outcome`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: r._learningId,
          outcome_status:      r.outcome,
          was_executed:        r.executed,
          realized_pnl_aud:    r.actualProfit != null ? +r.actualProfit.toFixed(2) : null,
          realized_pnl_pct:    r._pnlPct != null ? +r._pnlPct.toFixed(2) : null,
          holding_period_days: r._holdDays ?? null,
          actual_entry_price:  r._entryPrice ?? null,
          actual_exit_price:   r._exitPrice  ?? null,
          sector:              r._sector     ?? null,
          exit_reason:         _detectExitReason(r._exitPrice, r.stopLoss, r.target),
        }),
      });
      if ((await resp.json()).ok) updated++;
    } catch (_) {}
  }

  for (const r of toLog) {
    try {
      const resp = await fetch(`${API}/api/learning/log`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type:          'recommendation',
          ticker:              r.ticker,
          prompt_version:      pv,
          ai_confidence:       r.confidence ?? null,
          ensemble_confidence: r.ensembleConfidence ?? null,
          recommendation:      r.action,
          rationale_summary:   r.reasoning ? r.reasoning.slice(0, 400) : null,
          suggested_stop:      r.stopLoss ?? null,
          suggested_target:    r.target ?? null,
          was_executed:        true,
          outcome_status:      r.outcome,
          realized_pnl_aud:    r.actualProfit != null ? +r.actualProfit.toFixed(2) : null,
          realized_pnl_pct:    r._pnlPct != null ? +r._pnlPct.toFixed(2) : null,
          holding_period_days: r._holdDays ?? null,
          actual_entry_price:  r._entryPrice ?? null,
          actual_exit_price:   r._exitPrice  ?? null,
          sector:              r._sector     ?? null,
          exit_reason:         _detectExitReason(r._exitPrice, r.stopLoss, r.target),
        }),
      });
      const res = await resp.json();
      if (res.id) { r._learningId = res.id; logged++; }
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
