// ============================================================
// BACKTEST  —  two modes:
//   1. AI Replay  : measures forward returns for actual executed recommendations
//   2. Technical  : RSI / MACD / BB / Momentum / Buy-and-Hold benchmark
// ============================================================

// ── Shared state ──────────────────────────────────────────────────────────────
if (!window._btMode) window._btMode = 'ai';   // 'ai' | 'tech'

// ============================================================
// RENDER
// ============================================================
function renderBacktest() {
  return `
    <div class="flex-row" style="gap:0;margin-bottom:16px;border-bottom:1px solid var(--border-light)">
      <button class="tab ${_btMode==='ai'?'active':''}"  data-bt-tab="ai"   onclick="_btSwitch('ai')">🤖 AI Replay</button>
      <button class="tab ${_btMode==='tech'?'active':''}" data-bt-tab="tech" onclick="_btSwitch('tech')">📈 Technical Benchmark</button>
    </div>
    <div id="bt-panel">${_btMode==='ai' ? _renderAiPanel() : _renderTechPanel()}</div>
  `;
}

function _btSwitch(mode) {
  window._btMode = mode;
  // Update active underline on tab buttons without re-rendering the whole page
  document.querySelectorAll('[data-bt-tab]').forEach(el => {
    el.classList.toggle('active', el.dataset.btTab === mode);
  });
  const panel = document.getElementById('bt-panel');
  if (panel) panel.innerHTML = mode === 'ai' ? _renderAiPanel() : _renderTechPanel();
}

// ============================================================
// ── MODE 1: AI RECOMMENDATION REPLAY ─────────────────────────
// ============================================================
function _renderAiPanel() {
  const executed = (state.recHistory || []).filter(r =>
    r.executed && r.action && r.action !== 'HOLD' && r.action !== 'WATCH'
  );
  const allRecs  = (state.recHistory || []);

  // Date range
  let dateRange = '—';
  if (executed.length) {
    const sorted = [...executed].sort((a, b) => _recDateISO(a) < _recDateISO(b) ? -1 : 1);
    dateRange = `${sorted[0].date} → ${sorted[sorted.length - 1].date}`;
  }

  // Action breakdown preview
  const actionCounts = {};
  executed.forEach(r => { actionCounts[r.action] = (actionCounts[r.action] || 0) + 1; });
  const actionSummary = Object.entries(actionCounts)
    .map(([a, n]) => `${n} ${a}`).join(' · ') || '—';

  const hasData = executed.length > 0;

  return `
    <div class="card section-gap">
      <div class="card-title">AI Recommendation Replay</div>
      <p class="text-xs text-muted" style="margin-bottom:14px">
        Measures actual forward price movement for every executed AI recommendation —
        the only honest way to evaluate whether the AI's calls made money.
      </p>

      ${!hasData ? `
        <div class="empty-state" style="padding:2rem 1rem">
          <div class="empty-icon">🤖</div>
          <p>No executed recommendations yet.</p>
          <p class="sub">Mark recommendations as executed on the Recommendations page, then return here to measure outcomes.</p>
        </div>
      ` : `
        <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:12px 16px;margin-bottom:16px;display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
          <div>
            <div class="text-xs text-muted">Executed trades</div>
            <div style="font-size:18px;font-weight:700;color:var(--text-primary)">${executed.length}</div>
            <div class="text-xs text-muted">of ${allRecs.length} total recs</div>
          </div>
          <div>
            <div class="text-xs text-muted">Date range</div>
            <div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-top:3px">${dateRange}</div>
          </div>
          <div>
            <div class="text-xs text-muted">Actions</div>
            <div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-top:3px">${actionSummary}</div>
          </div>
        </div>

        <div class="grid-2" style="gap:14px;margin-bottom:14px">
          <div class="form-row">
            <div class="form-label">Measure outcomes at</div>
            <select id="bt-ai-horizon">
              <option value="1w">1 week</option>
              <option value="2w">2 weeks</option>
              <option value="1mo" selected>1 month</option>
              <option value="3mo">3 months</option>
            </select>
          </div>
          <div class="form-row">
            <div class="form-label">Brokerage per trade ($)</div>
            <input type="number" value="${state.settings.brokerage}" id="bt-ai-brokerage">
          </div>
        </div>
        <div class="flex-row">
          <button class="btn btn-primary" id="bt-ai-run-btn" onclick="runAiReplay()">▷ Run Analysis</button>
          ${!state.serverOk ? '<span class="text-xs text-danger">⚠ Backend required (yfinance prices)</span>' : '<span class="text-xs text-muted">Fetches forward prices via yfinance</span>'}
        </div>
      `}
    </div>
    <div id="bt-ai-results"></div>
  `;
}

// Convert DD-MM-YYYY rec date to sortable YYYY-MM-DD
function _recDateISO(r) {
  if (!r || !r.date) return '';
  const parts = r.date.split('-');
  if (parts.length !== 3) return r.date;
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

async function runAiReplay() {
  if (!state.serverOk) { toast('Backend server required for price fetching', 'error'); return; }

  const horizon   = document.getElementById('bt-ai-horizon').value;
  const brokerage = Number(document.getElementById('bt-ai-brokerage').value) || state.settings.brokerage;

  const executed = (state.recHistory || []).filter(r =>
    r.executed && r.action && r.action !== 'HOLD' && r.action !== 'WATCH'
  );

  if (!executed.length) { toast('No executed recommendations to analyse', 'error'); return; }

  const btn = document.getElementById('bt-ai-run-btn');
  if (btn) btn.disabled = true;

  const horizonLabels = { '1w': '1 week', '2w': '2 weeks', '1mo': '1 month', '3mo': '3 months' };

  document.getElementById('bt-ai-results').innerHTML = `
    <div class="card"><div class="empty-state">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <p class="text-muted mt-1">Fetching forward prices for ${executed.length} trades…</p>
      <p class="text-xs text-muted">Measuring ${horizonLabels[horizon]} outcomes via yfinance</p>
    </div></div>`;

  // Build payload — include all execution details captured at trade time
  // Also pass tradeJournal so backend can look up BUY/TOP_UP open P&L using current prices
  const journalByRecId = {};
  (state.tradeJournal || []).forEach(j => { if (j.recId) journalByRecId[j.recId] = j; });

  const trades = executed.map(r => {
    const journal = journalByRecId[r.id] || null;
    return {
      ticker:        r.ticker,
      action:        r.action,
      date:          r.date,
      executedPrice: r.executedPrice || (journal?.entryPrice) || null,
      executedQty:   r.qty           || (journal?.qty)        || 0,
      priceMid:      r.priceRange ? (r.priceRange[0] + r.priceRange[1]) / 2 : null,
      priceRange:    r.priceRange    || null,
      target:        r.target        || null,
      stopLoss:      r.stopLoss      || null,
      confidence:    r.confidence    || 0,
      // Pre-computed realized P&L from Trade Journal (SELL/TRIM only)
      actualProfit:  (r.actualProfit !== null && r.actualProfit !== undefined)
                       ? r.actualProfit
                       : (journal?.pnl ?? null),
    };
  });

  try {
    const res = await fetch(`${API}/api/backtest/ai-replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trades, horizon, brokerage }),
    }).then(r => { if (!r.ok) throw new Error('Server error ' + r.status); return r.json(); });

    if (res.error) throw new Error(res.error);
    _renderAiResults(res, horizon, horizonLabels[horizon]);

  } catch(e) {
    document.getElementById('bt-ai-results').innerHTML = `
      <div class="card"><div class="empty-state">
        <div class="empty-icon">▷</div>
        <p class="text-danger">Analysis error: ${e.message}</p>
      </div></div>`;
  } finally {
    const btn2 = document.getElementById('bt-ai-run-btn');
    if (btn2) btn2.disabled = false;
  }
}

function _renderAiResults(res, horizon, horizonLabel) {
  const hitColor  = res.hitRate >= 60 ? 'up' : res.hitRate >= 45 ? '' : 'down';
  const hasPnl    = res.hasPnl;
  const partialPct = res.totalTrades > 0 ? Math.round(res.partialCount / res.totalTrades * 100) : 0;
  // Flag: if >50% of trades don't have full horizon data, warn the user
  const dataWarning = res.partialCount > 0 && res.partialCount >= res.totalTrades * 0.5;

  // Confidence breakdown table
  const confRows = (res.byConfidence || []).map(b => {
    const c = b.hitRate >= 60 ? 'text-success' : b.hitRate >= 45 ? '' : 'text-danger';
    return `<tr>
      <td>${b.label}</td>
      <td>${b.count}</td>
      <td class="${c}">${b.hitRate}%</td>
      <td class="${b.avgReturn >= 0 ? 'text-success' : 'text-danger'}">${b.avgReturn >= 0 ? '+' : ''}${fmt(b.avgReturn)}%</td>
    </tr>`;
  }).join('');

  // Action breakdown table
  const actionRows = (res.byAction || []).map(b => {
    const c = b.hitRate >= 60 ? 'text-success' : b.hitRate >= 45 ? '' : 'text-danger';
    return `<tr>
      <td>${actionBadge(b.action)}</td>
      <td>${b.count}</td>
      <td class="${c}">${b.hitRate}%</td>
      <td class="${b.avgReturn >= 0 ? 'text-success' : 'text-danger'}">${b.avgReturn >= 0 ? '+' : ''}${fmt(b.avgReturn)}%</td>
    </tr>`;
  }).join('');

  // P&L source label for the trade rows
  const pnlSourceLabel = s => ({
    realized:   '<span title="Exact realized P&L from Trade Journal" style="font-size:9px;color:#22c55e">✓ realized</span>',
    unrealized: '<span title="Unrealized: qty × current price vs entry" style="font-size:9px;color:#60a5fa">~ open</span>',
    estimated:  '<span title="Estimated from price movement (no cost basis)" style="font-size:9px;color:#f59e0b">~ est.</span>',
    none:       '',
  }[s] || '');

  // Individual trades table
  const tradeRows = (res.trades || [])
    .sort((a, b) => (b.entryDate || '').localeCompare(a.entryDate || ''))
    .map(t => {
      const hitIcon  = t.isHit === true ? '✓' : t.isHit === false ? '✗' : '—';
      const hitClass = t.isHit === true ? 'text-success' : t.isHit === false ? 'text-danger' : 'text-muted';
      const chgClass = t.priceChangePct >= 0 ? 'text-success' : 'text-danger';
      const confPct  = Math.round((t.confidence || 0) * 100);
      const pnlCell  = t.pnl != null
        ? `<span class="${t.pnl >= 0 ? 'text-success' : 'text-danger'}">${t.pnl >= 0 ? '+' : ''}$${fmt(Math.abs(t.pnl))}</span> ${pnlSourceLabel(t.pnlSource)}`
        : `<span class="text-muted">—</span> <span style="font-size:9px;color:var(--text-tertiary)">no qty</span>`;
      const noteText = [t.note, t.qty > 0 ? `${t.qty} shares` : ''].filter(Boolean).join(' · ');
      return `<tr>
        <td class="text-xs">${t.entryDate || '—'}</td>
        <td><strong>${t.ticker}</strong></td>
        <td>${actionBadge(t.action)}</td>
        <td class="text-xs">${confPct}%</td>
        <td>$${fmt(t.entryPrice)}</td>
        <td>$${fmt(t.exitPrice)}</td>
        <td class="${chgClass}">${t.priceChangePct >= 0 ? '+' : ''}${fmt(t.priceChangePct)}%</td>
        <td>${pnlCell}</td>
        <td class="${hitClass}" style="font-weight:700;font-size:15px">${hitIcon}</td>
        <td class="text-xs text-muted">${noteText}</td>
      </tr>`;
    }).join('');

  // Portfolio value curve: starting value + cumulative P&L at each trade entry date
  // Starting value = current net worth MINUS the net P&L already made (= value before any of these trades)
  const currentNetWorth  = totalNetWorth();
  const startPortfolio   = currentNetWorth - (res.netPnl || 0);
  const hasEquity        = hasPnl && res.equityCurve && res.equityCurve.length > 1;
  // Build portfolio value array for drawing (add starting value as first point)
  const portfolioCurve   = hasEquity
    ? [{ date: res.equityCurve[0].date, value: startPortfolio, label: 'start' },
       ...res.equityCurve.map(p => ({ date: p.date, value: round2(startPortfolio + p.pnl), ticker: p.ticker, action: p.action }))]
    : [];

  // tiny helper
  function round2(n) { return Math.round(n * 100) / 100; }

  document.getElementById('bt-ai-results').innerHTML = `

    ${res.totalTrades === 0 ? `
      <div class="card"><div class="empty-state">
        <div class="empty-icon">📭</div>
        <p>No trades could be scored — price data may not be available for the trade dates.</p>
        <p class="sub">Check that your tickers are valid ASX codes and trade dates are not in the future.</p>
      </div></div>
    ` : ''}

    ${dataWarning ? `
    <div style="background:#292200;border:1px solid #854d0e;border-radius:var(--radius-md);padding:10px 14px;margin-bottom:12px;font-size:12px;color:#fbbf24">
      ⚠ <strong>${res.partialCount} of ${res.totalTrades} trades</strong> don't have full ${horizonLabel} data yet
      (trades too recent — exit = today's price, not ${horizonLabel} forward).
      Directional accuracy results are <strong>preliminary</strong> and will change as time passes.
    </div>` : ''}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">

      <!-- SCORECARD 1: Execution P&L — real money made/lost -->
      <div class="card" style="border-left:3px solid #22c55e;padding:14px 16px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-tertiary);margin-bottom:10px">
          💰 Execution P&L — actual money made
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
          <div>
            <div class="text-xs text-muted">Net P&L</div>
            <div style="font-size:20px;font-weight:700;color:${hasPnl ? ((res.netPnl||0)>=0?'#22c55e':'#ef4444') : 'var(--text-tertiary)'}">
              ${hasPnl ? ((res.netPnl||0) >= 0 ? '+' : '') + '$' + fmt(Math.abs(res.netPnl||0)) : '—'}
            </div>
            <div class="text-xs text-muted">${hasPnl ? 'incl. brokerage' : 'needs qty in rec'}</div>
          </div>
          <div>
            <div class="text-xs text-muted">Realized (closed)</div>
            <div style="font-size:16px;font-weight:600;color:${res.realizedPnl!=null?((res.realizedPnl>=0)?'#22c55e':'#ef4444'):'var(--text-tertiary)'}">
              ${res.realizedPnl != null ? (res.realizedPnl >= 0 ? '+' : '') + '$' + fmt(Math.abs(res.realizedPnl)) : '—'}
            </div>
            <div class="text-xs text-muted">${res.realizedCount} SELL/TRIM trades</div>
          </div>
          <div>
            <div class="text-xs text-muted">Unrealized (open)</div>
            <div style="font-size:16px;font-weight:600;color:${res.unrealizedPnl!=null?((res.unrealizedPnl>=0)?'#22c55e':'#ef4444'):'var(--text-tertiary)'}">
              ${res.unrealizedPnl != null ? (res.unrealizedPnl >= 0 ? '+' : '') + '$' + fmt(Math.abs(res.unrealizedPnl)) : '—'}
            </div>
            <div class="text-xs text-muted">${res.openCount} BUY/TOP_UP positions</div>
          </div>
        </div>
      </div>

      <!-- SCORECARD 2: Directional Accuracy — was AI right about price direction? -->
      <div class="card" style="border-left:3px solid #3b82f6;padding:14px 16px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-tertiary);margin-bottom:10px">
          🎯 Directional Accuracy — was AI right?
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
          <div>
            <div class="text-xs text-muted">Hit Rate</div>
            <div class="metric-value ${hitColor}" style="font-size:20px">${fmt(res.hitRate, 0)}%</div>
            <div class="text-xs text-muted">${res.totalTrades} trades</div>
          </div>
          <div>
            <div class="text-xs text-muted">Avg when right</div>
            <div style="font-size:16px;font-weight:600;color:#22c55e">${res.avgWin != null ? '+' + fmt(res.avgWin) + '%' : '—'}</div>
            <div class="text-xs text-muted">price moved correctly</div>
          </div>
          <div>
            <div class="text-xs text-muted">Avg when wrong</div>
            <div style="font-size:16px;font-weight:600;color:#ef4444">${res.avgLoss != null ? fmt(res.avgLoss) + '%' : '—'}</div>
            <div class="text-xs text-muted">price moved opposite</div>
          </div>
        </div>
        ${res.avgReturnFull != null && res.fullCount > 0 ? `
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-light);font-size:11px;color:var(--text-secondary)">
          Full-horizon avg (${res.fullCount} trades with complete ${horizonLabel} data):
          <strong class="${res.avgReturnFull >= 0 ? 'text-success' : 'text-danger'}">${res.avgReturnFull >= 0 ? '+' : ''}${fmt(res.avgReturnFull)}%</strong>
          vs all-trades avg <strong>${res.avgReturn >= 0 ? '+' : ''}${fmt(res.avgReturn)}%</strong>
        </div>` : ''}
      </div>
    </div>

    ${(res.byConfidence || []).length ? `
    <div class="grid-2 section-gap" style="gap:16px">
      <div class="card">
        <div class="card-title">By Confidence Band</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Band</th><th>Trades</th><th>Hit %</th><th>Avg Chg</th></tr></thead>
            <tbody>${confRows}</tbody>
          </table>
        </div>
        <p class="text-xs text-muted mt-1">Hit = price moved in predicted direction at ${horizonLabel}</p>
      </div>
      <div class="card">
        <div class="card-title">By Action Type</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Action</th><th>Trades</th><th>Hit %</th><th>Avg Directional %</th></tr></thead>
            <tbody>${actionRows}</tbody>
          </table>
        </div>
        <p class="text-xs text-muted mt-1">
          Hit = price moved in predicted direction at ${horizonLabel}.<br>
          BUY/TOP_UP: positive % = price rose (good). SELL/TRIM: positive % = price fell after exit (AI was right to reduce).
          Negative TRIM % = price kept rising after trimming (AI trimmed too early).
        </p>
      </div>
    </div>` : ''}

    ${hasEquity ? `
    <div class="card section-gap">
      <div class="card-title">Portfolio Value — as AI trades were executed (entry date order)</div>
      <canvas id="bt-ai-equity-chart" style="width:100%;height:220px"></canvas>
      <p class="text-xs text-muted mt-1">
        Baseline = current portfolio value (${fmt(currentNetWorth,0) ? '$'+fmt(currentNetWorth) : '?'}) minus net P&L from these trades = starting point before first recommendation.
        Each dot = one trade. SELL/TRIM P&L from Trade Journal · BUY/TOP_UP = qty × (current price − entry) − brokerage.
      </p>
    </div>` : hasPnl ? '' : `
    <div class="card section-gap" style="opacity:0.6">
      <div class="card-title">P&L Curve — not yet available</div>
      <p class="text-xs text-muted" style="padding:12px 0">
        Confirm trade quantities in the execution form to enable the P&L curve.
        The hit rate and directional accuracy above are still valid.
      </p>
    </div>`}

    ${tradeRows ? `
    <div class="card section-gap">
      <div class="card-title">Trade-by-Trade Outcomes</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Entry</th><th>Ticker</th><th>Action</th><th>Conf</th><th>Entry $</th><th>Exit $</th><th>Change</th><th>P&L</th><th>Hit</th><th>Note</th></tr></thead>
          <tbody>${tradeRows}</tbody>
        </table>
      </div>
      <p class="text-xs text-muted mt-1">
        ✓ = AI was correct direction · ✗ = AI was wrong · Exit price = close at ${horizonLabel} from entry (or latest available).
        <br>⚠ Past performance does not guarantee future results.
      </p>
    </div>` : ''}
  `;

  if (hasEquity) {
    setTimeout(() => _drawAiEquity(portfolioCurve), 80);
  }
}

function _drawAiEquity(curve) {
  const canvas = document.getElementById('bt-ai-equity-chart');
  if (!canvas || curve.length < 2) return;
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth || 900;
  canvas.height = 220;
  const W = canvas.width, H = canvas.height;
  const PAD = { t: 24, r: 24, b: 36, l: 78 };
  const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;

  const dates  = curve.map(p => p.date  || '');
  const values = curve.map(p => p.value);
  const actions = curve.map(p => p.action || '');

  const minV = Math.min(...values), maxV = Math.max(...values);
  const pad  = (maxV - minV) * 0.08 || 500;   // 8% vertical breathing room
  const lo   = minV - pad, hi = maxV + pad;
  const range = hi - lo || 1;

  const xOf = i => PAD.l + (i / Math.max(values.length - 1, 1)) * cW;
  const yOf = v => PAD.t + cH - ((v - lo) / range) * cH;

  // Y-axis formatter: always dollar portfolio values
  const fmtY = v => '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0));

  ctx.clearRect(0, 0, W, H);

  // Grid lines + Y labels (5 horizontal bands)
  ctx.lineWidth = 0.5;
  [0, 0.25, 0.5, 0.75, 1].forEach(f => {
    const val = hi - f * range;
    const y   = PAD.t + f * cH;
    ctx.strokeStyle = 'rgba(128,128,128,0.12)';
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
    ctx.fillStyle = 'rgba(150,150,150,0.75)'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(fmtY(val), PAD.l - 5, y + 4);
  });

  if (values.length < 2) return;

  const startVal = values[0];
  const finalVal = values[values.length - 1];
  const isUp     = finalVal >= startVal;
  const lineCol  = isUp ? '#16a34a' : '#dc2626';

  // Gradient fill under curve (from start value baseline, not zero)
  const startY = yOf(startVal);
  const grad   = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + cH);
  grad.addColorStop(0, isUp ? 'rgba(22,163,74,0.22)' : 'rgba(220,38,38,0.22)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  values.forEach((v, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)));
  ctx.lineTo(xOf(values.length - 1), startY);
  ctx.lineTo(PAD.l, startY);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

  // Start-value baseline
  ctx.strokeStyle = 'rgba(128,128,128,0.3)'; ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(PAD.l, startY); ctx.lineTo(W - PAD.r, startY); ctx.stroke();
  ctx.setLineDash([]);

  // Portfolio value line
  ctx.beginPath();
  values.forEach((v, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)));
  ctx.strokeStyle = lineCol; ctx.lineWidth = 2; ctx.stroke();

  // Trade dots — colour by action type
  const actionColor = a => ({ BUY:'#3b82f6', TOP_UP:'#8b5cf6', SELL:'#f97316', TRIM:'#f59e0b' }[a] || lineCol);
  values.forEach((v, i) => {
    if (i === 0) return;   // skip start placeholder
    ctx.beginPath();
    ctx.arc(xOf(i), yOf(v), 4, 0, Math.PI * 2);
    ctx.fillStyle = actionColor(actions[i]);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.5;
    ctx.fill(); ctx.stroke();
  });

  // Start and final value labels
  ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(160,160,160,0.8)';
  ctx.fillText(fmtY(startVal) + ' ▸ start', PAD.l + 2, startY - 5);
  ctx.textAlign = 'right'; ctx.fillStyle = lineCol;
  ctx.fillText(fmtY(finalVal), xOf(values.length - 1), yOf(finalVal) - 8);

  // X-axis date labels — deduplicate (skip if same as previous)
  ctx.fillStyle = 'rgba(128,128,128,0.8)'; ctx.textAlign = 'center'; ctx.font = '10px sans-serif';
  const totalLabels = Math.min(8, values.length);
  const step = Math.max(1, Math.floor(values.length / totalLabels));
  let lastLabel = '';
  for (let i = 0; i < dates.length; i += step) {
    const label = dates[i] ? dates[i].slice(5) : '';   // MM-DD
    if (label && label !== lastLabel) {
      ctx.fillText(label, xOf(i), H - 10);
      lastLabel = label;
    }
  }

  // Action legend
  const legend = [['BUY','#3b82f6'],['TOP_UP','#8b5cf6'],['SELL','#f97316'],['TRIM','#f59e0b']];
  let lx = PAD.l;
  legend.forEach(([label, col]) => {
    ctx.beginPath(); ctx.arc(lx + 5, PAD.t - 10, 4, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.fillStyle = 'rgba(160,160,160,0.8)'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(label, lx + 12, PAD.t - 7);
    lx += label.length * 7 + 20;
  });
}

// ============================================================
// ── MODE 2: TECHNICAL STRATEGY BENCHMARK ─────────────────────
// ============================================================
function _renderTechPanel() {
  const portfolioTickers = mergedPortfolio().map(h => h.ticker).join(',');
  return `
    <div class="card section-gap">
      <div class="card-title">Technical Strategy Benchmark</div>
      <p class="text-xs text-muted" style="margin-bottom:12px">
        Run a classic technical strategy against historical prices. Useful for benchmarking —
        compare whether the AI outperforms a simple rule-based approach on the same tickers.
      </p>
      <div class="grid-2" style="gap:14px">
        <div class="form-row">
          <div class="form-label">Tickers (comma-separated)</div>
          <input type="text" value="${portfolioTickers}" id="bt-tickers" placeholder="e.g. CBA,BHP,TLS">
        </div>
        <div class="form-row">
          <div class="form-label">Period</div>
          <select id="bt-period">
            <option value="3mo">3 months</option>
            <option value="6mo">6 months</option>
            <option value="1y" selected>1 year</option>
            <option value="2y">2 years</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-label">Starting capital ($)</div>
          <input type="number" value="${fmt(totalNetWorth(),0).replace(/,/g,'')}" id="bt-capital">
        </div>
        <div class="form-row">
          <div class="form-label">Strategy</div>
          <select id="bt-strategy">
            <option value="rsi_trend">RSI + Trend Following</option>
            <option value="macd">MACD Crossover</option>
            <option value="bb_reversion">BB Mean Reversion</option>
            <option value="momentum">Momentum (ADX)</option>
            <option value="buy_hold">Buy &amp; Hold (benchmark)</option>
          </select>
        </div>
      </div>
      <div class="form-row" style="max-width:200px">
        <div class="form-label">Brokerage per trade ($)</div>
        <input type="number" value="${state.settings.brokerage}" id="bt-brokerage">
      </div>
      <div class="flex-row mt-1">
        <button class="btn btn-primary" id="bt-run-btn" onclick="runBacktest()">▷ Run Backtest</button>
        ${!state.serverOk ? '<span class="text-xs text-danger">⚠ Backend server required</span>' : '<span class="text-xs text-muted">Powered by yfinance historical data</span>'}
      </div>
    </div>
    <div id="backtest-results"></div>
  `;
}

async function runBacktest() {
  if (!state.serverOk) { toast('Backend server required for backtesting', 'error'); return; }
  const tickers  = document.getElementById('bt-tickers').value.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  const period   = document.getElementById('bt-period').value;
  const capital  = Number(document.getElementById('bt-capital').value) || 50000;
  const strategy = document.getElementById('bt-strategy').value;
  const brokerage = Number(document.getElementById('bt-brokerage').value) || state.settings.brokerage;

  if (!tickers.length) { toast('Enter at least one ticker', 'error'); return; }

  const btn = document.getElementById('bt-run-btn');
  if (btn) btn.disabled = true;

  document.getElementById('backtest-results').innerHTML = `
    <div class="card"><div class="empty-state">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <p class="text-muted mt-1">Running backtest on yfinance data for ${tickers.join(', ')}…</p>
      <p class="text-xs text-muted">Fetching ${period} of OHLCV data and computing signals</p>
    </div></div>`;

  try {
    const r = await fetch(`${API}/api/backtest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers, period, capital, strategy, brokerage }),
    });
    if (!r.ok) throw new Error('Server error ' + r.status);
    const res = await r.json();
    if (res.error) throw new Error(res.error);

    const strategyLabels = {
      rsi_trend:    'RSI + Trend Following',
      macd:         'MACD Crossover',
      bb_reversion: 'BB Mean Reversion',
      momentum:     'Momentum (ADX)',
      buy_hold:     'Buy & Hold',
    };

    const tickerRows = Object.entries(res.tickers).map(([t, v]) => {
      if (v.error) return `<tr><td><strong>${t}</strong></td><td colspan="7" class="text-danger text-xs">${v.error}</td></tr>`;
      const retColor = v.totalReturn >= 0 ? 'text-success' : 'text-danger';
      // Show "1 (open)" for buy-and-hold style where the only "trade" is still open
      const closedCount = v.closedTrades != null ? v.closedTrades : v.totalTrades;
      const openCount   = v.totalTrades - closedCount;
      const tradesLabel = closedCount + (openCount > 0 ? ` <span class="text-xs text-muted">(+${openCount} open)</span>` : '');
      // Win rate only makes sense when there are closed trades
      const winRateLabel = closedCount > 0 ? `${fmt(v.winRate, 0)}%` : '<span class="text-muted text-xs">—</span>';
      const avgWinLabel  = v.avgWin  ? `+$${fmt(v.avgWin)}`  : '<span class="text-muted">—</span>';
      const avgLossLabel = v.avgLoss ? `$${fmt(v.avgLoss)}`  : '<span class="text-muted">—</span>';
      return `<tr>
        <td><strong>${t}</strong></td>
        <td class="${retColor}">${v.totalReturn >= 0 ? '+' : ''}${fmt(v.totalReturn)}%</td>
        <td>${tradesLabel}</td>
        <td>${winRateLabel}</td>
        <td class="text-success">${avgWinLabel}</td>
        <td class="text-danger">${avgLossLabel}</td>
        <td class="${v.totalPnl >= 0 ? 'text-success' : 'text-danger'}">${v.totalPnl >= 0 ? '+' : ''}$${fmt(Math.abs(v.totalPnl))}</td>
      </tr>`;
    }).join('');

    const allTrades = Object.values(res.tickers)
      .filter(v => v.trades)
      .flatMap(v => v.trades)
      .sort((a, b) => {
        // Put open positions at top; otherwise sort by exitDate descending
        if (a.isOpen && !b.isOpen) return -1;
        if (!a.isOpen && b.isOpen) return 1;
        return (b.exitDate || '').localeCompare(a.exitDate || '');
      })
      .slice(0, 15);

    const tradeRows = allTrades.map(t => {
      const isOpen     = t.isOpen;
      const exitLabel  = isOpen ? '<span class="badge" style="background:#1e3a5f;color:#60a5fa;border:none">held open</span>' : `<span class="text-xs">${t.exitDate}</span>`;
      const pnlClass   = t.pnl >= 0 ? 'text-success' : 'text-danger';
      const pnlLabel   = isOpen
        ? `<span class="${pnlClass}" title="Unrealised">${t.pnl >= 0 ? '+' : ''}$${fmt(Math.abs(t.pnl))} <span class="text-xs text-muted">unrealised</span></span>`
        : `<span class="${pnlClass}">${t.pnl >= 0 ? '+' : ''}$${fmt(Math.abs(t.pnl))}</span>`;
      return `<tr${isOpen ? ' style="opacity:0.75"' : ''}>
        <td><strong>${t.ticker}</strong></td>
        <td class="text-xs">${t.entryDate}</td>
        <td>${exitLabel}</td>
        <td>${t.qty}</td>
        <td>$${fmt(t.entryPrice)}</td>
        <td>$${fmt(t.exitPrice)}</td>
        <td>${t.holdDays}d</td>
        <td>${pnlLabel}</td>
      </tr>`;
    }).join('');

    const hasEquity = res.equityCurve && res.equityCurve.length > 0;

    document.getElementById('backtest-results').innerHTML = `
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="metric-label">Avg Return (${period})</div>
          <div class="metric-value ${res.totalReturn >= 0 ? 'up' : 'down'}">${res.totalReturn >= 0 ? '+' : ''}${fmt(res.totalReturn)}%</div>
          <div class="metric-sub">$${fmt(capital)} → $${fmt(capital * (1 + res.totalReturn / 100))}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Sharpe Ratio</div>
          <div class="metric-value ${(res.sharpe||0) >= 1 ? 'up' : (res.sharpe||0) >= 0 ? '' : 'down'}">${res.sharpe != null ? fmt(res.sharpe) : '—'}</div>
          <div class="metric-sub">${res.sharpe != null ? (res.sharpe >= 1 ? 'Good' : res.sharpe >= 0.5 ? 'Acceptable' : 'Poor') : 'n/a'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Max Drawdown</div>
          <div class="metric-value down">${res.maxDrawdown != null ? fmt(res.maxDrawdown) + '%' : '—'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Win Rate</div>
          <div class="metric-value ${res.winRate >= 50 ? 'up' : res.winRate > 0 ? '' : 'down'}">${res.winRate > 0 ? fmt(res.winRate, 0) + '%' : strategy === 'buy_hold' ? '—' : '0%'}</div>
          <div class="metric-sub">${res.totalTrades} trade${res.totalTrades !== 1 ? 's' : ''} · PF: ${res.profitFactor != null ? fmt(res.profitFactor) : '—'}${strategy === 'buy_hold' ? ' · position held open' : ''}</div>
        </div>
      </div>

      ${hasEquity ? `
      <div class="card section-gap">
        <div class="card-title">Equity Curve — ${strategyLabels[strategy] || strategy} · ${period}</div>
        <canvas id="bt-equity-chart" style="width:100%;height:220px"></canvas>
        <div class="text-xs text-muted mt-1">Each ticker allocated $${fmt(capital / tickers.length)} starting capital</div>
      </div>` : ''}

      <div class="card section-gap">
        <div class="card-title">Per-Ticker Results</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Ticker</th><th>Return</th><th>Trades</th><th>Win %</th><th>Avg Win</th><th>Avg Loss</th><th>Net P&L</th></tr></thead>
            <tbody>${tickerRows}</tbody>
          </table>
        </div>
      </div>

      ${allTrades.length ? `
      <div class="card">
        <div class="card-title">Recent Trade Log (last 15)</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Ticker</th><th>Entry</th><th>Exit</th><th>Qty</th><th>Entry $</th><th>Exit $</th><th>Held</th><th>P&L</th></tr></thead>
            <tbody>${tradeRows}</tbody>
          </table>
        </div>
        <p class="text-xs text-muted mt-1">⚠ Past performance does not guarantee future results. Signal generation uses EOD prices.</p>
      </div>` : ''}
    `;

    if (hasEquity) setTimeout(() => drawBacktestEquity(res.equityCurve), 80);

  } catch(e) {
    document.getElementById('backtest-results').innerHTML = `
      <div class="card"><div class="empty-state">
        <div class="empty-icon">▷</div>
        <p class="text-danger">Backtest error: ${e.message}</p>
        <p class="sub">Check server logs and ensure tickers are valid ASX codes.</p>
      </div></div>`;
  } finally {
    const btn2 = document.getElementById('bt-run-btn');
    if (btn2) btn2.disabled = false;
  }
}

// ── Equity curve renderer (technical benchmark) ───────────────
function drawBacktestEquity(equityCurve) {
  const canvas = document.getElementById('bt-equity-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth || 900;
  canvas.height = 220;
  const W = canvas.width, H = canvas.height;
  const PAD = { t: 20, r: 20, b: 30, l: 60 };
  const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;

  const combined = {};
  equityCurve.forEach(tc => {
    tc.curve.forEach(pt => { combined[pt.date] = (combined[pt.date] || 0) + pt.value; });
  });
  const dates  = Object.keys(combined).sort();
  const values = dates.map(d => combined[d]);

  if (values.length < 2) return;
  const minV = Math.min(...values), maxV = Math.max(...values);
  const range = maxV - minV || 1;

  const xOf = i => PAD.l + (i / (values.length - 1)) * cW;
  const yOf = v => PAD.t + cH - ((v - minV) / range) * cH;

  ctx.clearRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(128,128,128,0.12)'; ctx.lineWidth = 0.5;
  [0, 0.25, 0.5, 0.75, 1].forEach(f => {
    const y = PAD.t + f * cH;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
    const val = maxV - f * range;
    ctx.fillStyle = 'rgba(128,128,128,0.7)'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('$' + (val >= 1000 ? (val/1000).toFixed(0)+'k' : val.toFixed(0)), PAD.l - 4, y + 4);
  });

  const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + cH);
  const isUp = values[values.length - 1] >= values[0];
  grad.addColorStop(0, isUp ? 'rgba(22,163,74,0.2)' : 'rgba(220,38,38,0.2)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  values.forEach((v, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)));
  ctx.lineTo(xOf(values.length - 1), PAD.t + cH);
  ctx.lineTo(PAD.l, PAD.t + cH);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath();
  values.forEach((v, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)));
  ctx.strokeStyle = isUp ? '#16a34a' : '#dc2626'; ctx.lineWidth = 2; ctx.stroke();

  ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
  ctx.fillStyle = isUp ? '#16a34a' : '#dc2626';
  ctx.fillText('$' + (values[values.length-1] >= 1000 ? (values[values.length-1]/1000).toFixed(1)+'k' : fmt(values[values.length-1])), xOf(values.length-1) - 50, yOf(values[values.length-1]) - 6);

  ctx.fillStyle = 'rgba(128,128,128,0.8)'; ctx.textAlign = 'center';
  const step = Math.max(1, Math.floor(dates.length / 5));
  for (let i = 0; i < dates.length; i += step) {
    ctx.fillText(dates[i].slice(5), xOf(i), H - 8);
  }
}
