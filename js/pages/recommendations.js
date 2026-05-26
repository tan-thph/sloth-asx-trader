// ============================================================
// RECOMMENDATIONS
// ============================================================
function renderRecommendations() {
  const pending=state.recommendations.filter(r=>r.status==='pending'&&(r.action||'').toUpperCase()!=='HOLD');
  return `
    <div class="tabs">
      <button class="tab active" id="tab-pending" onclick="switchRecTab('pending')">Pending (${pending.length})</button>
      <button class="tab" id="tab-run" onclick="switchRecTab('run')">▶ Run Analysis</button>
      <button class="tab" id="tab-history" onclick="switchRecTab('history')">History (${state.recHistory.filter(r=>(r.action||'').toUpperCase()!=='HOLD').length})</button>
      <button class="tab" id="tab-rules" onclick="switchRecTab('rules')">⚙ Rules</button>
    </div>
    <div id="rec-content">${renderPendingRecs(pending)}</div>
  `;
}
function switchRecTab(tab) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  const activeTab = document.getElementById('tab-'+tab);
  if(activeTab) activeTab.classList.add('active');
  if(tab==='pending') {
    document.getElementById('rec-content').innerHTML=renderPendingRecs(state.recommendations.filter(r=>r.status==='pending'&&(r.action||'').toUpperCase()!=='HOLD'));
    if (typeof initRecStalenessChecks === 'function') initRecStalenessChecks().catch(() => {});
  }
  else if(tab==='run') document.getElementById('rec-content').innerHTML=renderRunAnalysisPanel();
  else if(tab==='history') document.getElementById('rec-content').innerHTML=renderRecHistory();
  else document.getElementById('rec-content').innerHTML=renderRecRulesPanel();
}

function renderRunAnalysisPanel() {
  const cfg = state.analysisConfig;
  const portfolioTickers = mergedPortfolio().map(h=>h.ticker);
  const extraTickers = cfg.extraTickers || [];
  const allTickers = [...new Set([...portfolioTickers, ...extraTickers])];

  return `
    <div style="display:flex;flex-direction:column;gap:14px">

      <!-- Portfolio tickers (display only) -->
      <div class="card">
        <div class="card-title">Portfolio Tickers (always included)</div>
        <div class="flex-row" style="flex-wrap:wrap;gap:6px;margin-top:4px">
          ${portfolioTickers.length ? portfolioTickers.map(t=>`
            <span style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;background:var(--bg-secondary);border:0.5px solid var(--border-medium);border-radius:6px;font-size:12px;font-weight:600">
              ${t}
            </span>`).join('') : '<span class="text-xs text-muted">No portfolio holdings yet.</span>'}
        </div>
      </div>

      <!-- Extra tickers -->
      <div class="card">
        <div class="card-title">Additional Tickers to Analyse</div>
        <p class="text-xs text-muted" style="margin-bottom:10px">Add ASX tickers you want to evaluate for entry (e.g. watchlist stocks not yet in portfolio). These will be fetched via yfinance and included in the AI analysis.</p>
        <div class="flex-row" style="flex-wrap:wrap;gap:6px;margin-bottom:10px" id="extra-ticker-chips">
          ${extraTickers.map(t=>`
            <span style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;background:#dbeafe;color:#1d4ed8;border-radius:6px;font-size:12px;font-weight:600;border:0.5px solid #93c5fd">
              ${t}
              <button onclick="removeExtraTicker('${t}')" style="background:none;border:none;cursor:pointer;color:#1d4ed8;font-size:13px;padding:0;line-height:1">×</button>
            </span>`).join('')}
        </div>
        <div class="flex-row" style="gap:8px">
          <input type="text" id="extra-ticker-input" placeholder="e.g. WDS, MIN, NXT" maxlength="20"
            style="width:200px;flex-shrink:0"
            onkeydown="if(event.key==='Enter'||event.key===',')addExtraTickerFromInput()">
          <button class="btn btn-sm" onclick="addExtraTickerFromInput()">+ Add Ticker</button>
          ${extraTickers.length ? `<button class="btn btn-sm btn-danger" onclick="clearExtraTickers()">Clear all</button>` : ''}
        </div>
        <div style="margin-top:8px">
          <div class="form-label" style="margin-bottom:4px">Quick-add from watchlist</div>
          <div class="flex-row" style="flex-wrap:wrap;gap:5px">
            ${['WDS','MIN','FMG','RIO','NAB','ANZ','WBC','WOW','COL','REA','SEK','ASX','VAS','VGS','IVV'].filter(t=>!portfolioTickers.includes(t)&&!extraTickers.includes(t)).map(t=>
              `<button class="btn btn-sm" style="font-size:11px;padding:3px 8px" onclick="addExtraTicker('${t}')">${t}</button>`
            ).join('')}
          </div>
        </div>
      </div>

      <!-- Market view / instructions -->
      <div class="card">
        <div class="card-title">Market View & Instructions</div>
        <p class="text-xs text-muted" style="margin-bottom:10px">Add your current market commentary, thematic views, or specific instructions. The AI will incorporate these into its analysis and reasoning.</p>

        <div class="form-row">
          <textarea id="market-view-input" rows="5" placeholder="e.g. RBA likely to cut rates in Q3 — favour rate-sensitive sectors (REITs, banks). Iron ore softening — cautious on BHP/FMG near-term. Looking for yield plays above 4%. Avoid adding more mining exposure. Expecting volatility ahead of US CPI this week."
            style="font-size:13px;line-height:1.65"
            oninput="state.analysisConfig.marketView=this.value;scheduleSave()">${cfg.marketView||''}</textarea>
        </div>

        <!-- Saved views -->
        ${cfg.savedViews&&cfg.savedViews.length ? `
        <div style="margin-top:8px">
          <div class="form-label" style="margin-bottom:6px">Saved views (click to restore)</div>
          <div style="display:flex;flex-direction:column;gap:4px">
            ${cfg.savedViews.slice().reverse().map((v,ri)=>{
              const i = cfg.savedViews.length - 1 - ri;
              return `
              <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;background:var(--bg-secondary);border-radius:var(--radius-md);border:0.5px solid var(--border-light)">
                <div style="flex:1;min-width:0">
                  <div class="text-xs text-muted" style="margin-bottom:2px">${v.savedAt||''}</div>
                  <div style="font-size:12px;color:var(--text-primary);white-space:pre-wrap;overflow:hidden;max-height:48px;text-overflow:ellipsis">${v.text}</div>
                </div>
                <div class="flex-row" style="gap:4px;flex-shrink:0">
                  <button class="btn btn-sm" onclick="restoreSavedView(${i})" title="Restore this view">↩ Use</button>
                  <button class="btn btn-sm btn-danger" onclick="deleteSavedView(${i})" title="Delete">✕</button>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>` : ''}

        <div class="flex-row" style="margin-top:10px;gap:8px">
          <button class="btn btn-sm" onclick="saveCurrentView()">💾 Save view</button>
          <button class="btn btn-sm" onclick="clearMarketView()">Clear</button>
        </div>
      </div>

      <!-- Analysis summary & run -->
      <div class="card">
        <div class="card-title">Analysis Summary</div>
        <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.7">
          <div><strong>Tickers to analyse:</strong> <span style="font-weight:600;color:var(--text-primary)">${allTickers.join(', ') || '—'}</span>
            <span class="text-xs text-muted" style="margin-left:6px">(${portfolioTickers.length} portfolio + ${extraTickers.length} additional)</span>
          </div>
          <div><strong>Live signals:</strong>
            ${allTickers.filter(t=>state.liveSignals[t]&&!state.liveSignals[t].error).length} / ${allTickers.length} cached
            <span class="text-xs text-muted">(will fetch missing on run)</span>
          </div>
          <div><strong>Market view:</strong> ${cfg.marketView ? `<span style="color:var(--text-primary)">${cfg.marketView.substring(0,80)}${cfg.marketView.length>80?'…':''}</span>` : '<span class="text-muted">None (general analysis)</span>'}</div>
          ${!state.serverOk?`<div style="color:#d97706;margin-top:4px">⚠ Backend offline — analysis will use cached/no live data</div>`:''}
        </div>
        <div class="flex-row">
          <button class="btn btn-primary" onclick="runAnalysisFromPanel()" ${state.analysisRunning?'disabled':''} style="${state.analysisRunning?'opacity:0.6':''}" id="run-analysis-btn">
            ${state.analysisRunning ? '<span class="loading-dots"><span></span><span></span><span></span></span> Running...' : '▶ Run Full Analysis'}
          </button>
          <span class="text-xs text-muted">Analyses all ${allTickers.length} tickers · ~$${(state.settings.apiCostPerRun||0.08).toFixed(2)} API cost</span>
          ${(()=>{
            const td = todayStr();
            const execToday = state.recHistory.filter(r => r.date === td && r.executed).length;
            const maxTrades = state.settings.maxTradesPerDay || 5;
            const remaining = Math.max(0, maxTrades - execToday);
            const pct = execToday / maxTrades;
            const col = remaining === 0 ? '#ef4444' : remaining <= 1 ? '#f59e0b' : '#22c55e';
            return '<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:4px;border:0.5px solid '+col+';color:'+col+';font-size:11px">'
              + remaining + '/' + maxTrades + ' trade slots remaining today'
              + (remaining === 0 ? ' — cap reached' : '')
              + '</span>';
          })()}
        </div>
      </div>

    </div>
  `;
}

function addExtraTicker(ticker) {
  const t = ticker.toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(!t) return;
  const portfolioTickers = mergedPortfolio().map(h=>h.ticker);
  if(portfolioTickers.includes(t)) { toast(`${t} is already in your portfolio`, 'info'); return; }
  if(!state.analysisConfig.extraTickers) state.analysisConfig.extraTickers=[];
  if(state.analysisConfig.extraTickers.includes(t)) { toast(`${t} already added`, 'info'); return; }
  state.analysisConfig.extraTickers.push(t);
  scheduleSave();
  // Re-render just the run panel
  const el = document.getElementById('rec-content');
  if(el) el.innerHTML = renderRunAnalysisPanel();
  // Make sure the Run Analysis tab stays active
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  const tab = document.getElementById('tab-run');
  if(tab) tab.classList.add('active');
}

function addExtraTickerFromInput() {
  const input = document.getElementById('extra-ticker-input');
  if(!input) return;
  const raw = input.value.trim().toUpperCase().replace(/[^A-Z0-9,\s]/g,'');
  const tickers = raw.split(/[,\s]+/).filter(Boolean);
  tickers.forEach(t => addExtraTicker(t));
  input.value = '';
}

function removeExtraTicker(ticker) {
  state.analysisConfig.extraTickers = (state.analysisConfig.extraTickers||[]).filter(t=>t!==ticker);
  scheduleSave();
  const el = document.getElementById('rec-content');
  if(el) el.innerHTML = renderRunAnalysisPanel();
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  const tab = document.getElementById('tab-run');
  if(tab) tab.classList.add('active');
}

function clearExtraTickers() {
  state.analysisConfig.extraTickers = [];
  scheduleSave();
  const el = document.getElementById('rec-content');
  if(el) el.innerHTML = renderRunAnalysisPanel();
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  const tab = document.getElementById('tab-run');
  if(tab) tab.classList.add('active');
}

function saveCurrentView() {
  const ta = document.getElementById('market-view-input');
  const text = ta ? ta.value.trim() : state.analysisConfig.marketView;
  if(!text) { toast('Write your market view first', 'info'); return; }
  // Also update the live value
  state.analysisConfig.marketView = text;
  if(!state.analysisConfig.savedViews) state.analysisConfig.savedViews=[];
  state.analysisConfig.savedViews.push({ text, savedAt: todayStr()+' '+nowSydney() });
  // Keep last 5
  if(state.analysisConfig.savedViews.length > 5) state.analysisConfig.savedViews.shift();
  scheduleSave();
  toast('Market view saved','success');
  const el = document.getElementById('rec-content');
  if(el) el.innerHTML = renderRunAnalysisPanel();
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  const tab = document.getElementById('tab-run');
  if(tab) tab.classList.add('active');
}

function restoreSavedView(idx) {
  const v = state.analysisConfig.savedViews[idx];
  if(!v) return;
  state.analysisConfig.marketView = v.text;
  scheduleSave();
  const el = document.getElementById('rec-content');
  if(el) el.innerHTML = renderRunAnalysisPanel();
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  const tab = document.getElementById('tab-run');
  if(tab) tab.classList.add('active');
  toast('View restored','success');
}

function deleteSavedView(idx) {
  state.analysisConfig.savedViews.splice(idx, 1);
  scheduleSave();
  const el = document.getElementById('rec-content');
  if(el) el.innerHTML = renderRunAnalysisPanel();
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  const tab = document.getElementById('tab-run');
  if(tab) tab.classList.add('active');
}

function clearMarketView() {
  const ta = document.getElementById('market-view-input');
  if(ta) ta.value = '';
  state.analysisConfig.marketView = '';
  scheduleSave();
  toast('Market view cleared','info');
}

async function runAnalysisFromPanel() {
  // Capture current textarea value before running
  const ta = document.getElementById('market-view-input');
  if(ta) state.analysisConfig.marketView = ta.value.trim();
  scheduleSave();
  await runAnalysis();
}
function renderPendingRecs(recs) {
  const summary = state.analysisLastSummary;
  if(!recs.length) {
    const hasRunBefore = summary && summary.text;
    return `<div class="card"><div class="empty-state" style="text-align:left;padding:1.5rem">
      <div style="text-align:center;margin-bottom:1rem"><div class="empty-icon">◆</div></div>
      ${hasRunBefore ? `
        <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:14px 16px;margin-bottom:1rem;border-left:3px solid var(--border-medium)">
          <div style="font-size:11px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px">
            Analyst Summary · ${summary.time} ${summary.date}
          </div>
          <p style="font-size:13px;line-height:1.75;color:var(--text-primary);white-space:pre-wrap">${summary.text}</p>
        </div>
        <p class="sub" style="text-align:center">No actionable setups found — see reasoning above. Run again when conditions change.</p>
      ` : `
        <p style="color:var(--text-secondary);font-size:14px;text-align:center">No pending recommendations.</p>
        <p class="sub" style="text-align:center">Go to <strong>▶ Run Analysis</strong> tab to configure and run. The AI will use live yfinance indicator data when available.</p>
      `}
      <div style="text-align:center;margin-top:1rem">
        <button class="btn btn-primary" onclick="switchRecTab('run')">▶ Run Analysis</button>
      </div>
    </div></div>`;
  }

  const summaryBanner = (state.analysisLastSummary?.text && recs.length) ? `
    <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:12px 16px;margin-bottom:12px;border-left:3px solid #3b82f6">
      <div style="font-size:11px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px">
        Analyst Summary · ${state.analysisLastSummary.time} ${state.analysisLastSummary.date}
      </div>
      <p style="font-size:13px;line-height:1.7;color:var(--text-primary);white-space:pre-wrap">${state.analysisLastSummary.text}</p>
    </div>` : '';

  const tile = (label, body, sub) => `
    <div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md)">
      <div class="text-xs">${label}</div>
      <div style="font-weight:600;font-size:13px">${body}</div>
      ${sub ? `<div class="text-xs text-muted" style="margin-top:2px">${sub}</div>` : ''}
    </div>`;

  return summaryBanner + recs.map(r => {
    const isReducing = r.action === 'SELL' || r.action === 'TRIM';
    const holding   = isReducing ? getPortfolioHolding(r.ticker) : null;
    const avgCost   = holding ? holding.avgPrice : null;
    const heldQty   = holding ? holding.shares : 0;
    const qty       = r.qty || 0;
    // Sell price = the lower bound of the AI's priceRange (treat as a limit). If the
    // AI returned a single number or only target, fall back gracefully.
    const sellPrice = r.priceRange?.[0] ?? r.target;

    // Recompute Net Realised P&L using the user's actual portfolio avg cost — the AI
    // doesn't know your real cost basis, so its netProfit can be wrong.
    const fees = state.settings.brokerage;
    const realisedPnl = (isReducing && avgCost != null && sellPrice != null)
      ? (sellPrice - avgCost) * qty - fees
      : null;
    // For BUY/TOP_UP: if AI netProfit is missing, compute from (target - entry_mid) * qty - round-trip fees
    let displayPnl;
    if (isReducing) {
      displayPnl = realisedPnl != null ? realisedPnl : r.netProfit;
    } else {
      if (r.netProfit != null) {
        displayPnl = r.netProfit;
      } else if (r.target && r.priceRange) {
        const entryMid = (Number(r.priceRange[0]) + Number(r.priceRange[1])) / 2;
        displayPnl = (r.target - entryMid) * qty - fees * 2; // round-trip brokerage
      } else {
        displayPnl = null;
      }
    }
    const pnlColor   = (displayPnl ?? 0) >= 0 ? '#16a34a' : '#dc2626';
    const pnlSign    = (displayPnl ?? 0) >= 0 ? '+ ' : '− ';

    // Top tiles differ by action type — sell-side recs get sell-oriented info.
    const topTiles = isReducing
      ? `
        ${tile('Sell at (limit)',
               `<span class="text-success">$${fmt(sellPrice)}</span>`,
               `${qty} share${qty===1?'':'s'} · stop if breaks $${fmt(r.stopLoss)}`)}
        ${tile('Cost basis (your avg)',
               avgCost != null ? `$${fmt(avgCost)} <span class="text-muted">× ${qty}</span>` : '<span class="text-muted">no holding</span>',
               avgCost != null ? `Holding ${heldQty} share${heldQty===1?'':'s'} · cost = $${fmt(avgCost*qty)}` : '—')}
        ${tile('Net realised P&L (est.)',
               `<span style="color:${pnlColor}">${displayPnl!=null?pnlSign+'$'+fmt(Math.abs(displayPnl)):'<span style="color:var(--text-tertiary)">—</span>'}</span>`,
               avgCost != null
                 ? `($${fmt(sellPrice)} − $${fmt(avgCost)}) × ${qty} − $${fees} fee`
                 : `AI estimate · cost basis unavailable`)}
      `
      : `
        ${tile('Entry range', `$${fmt(r.priceRange[0])} &ndash; $${fmt(r.priceRange[1])}`)}
        ${tile('Target / Stop-loss',
               `<span class="text-success">$${fmt(r.target)}</span> / <span class="text-danger">$${fmt(r.stopLoss)}</span>`)}
        ${tile('Est. P&L if target hit',
               `<span style="color:${pnlColor}">${displayPnl!=null?pnlSign+'$'+fmt(Math.abs(displayPnl)):'<span style="color:var(--text-tertiary)">—</span>'}</span>`,
               displayPnl!=null?`(target − entry) × ${qty} − $${fees*2} round-trip`:'No target/entry data')}
      `;

    const qtyLine = r.action === 'TRIM'   ? `Trim: ${qty||'—'} of ${heldQty} shares`
                  : r.action === 'TOP_UP' ? `Add: ${qty||'—'} shares`
                  : r.action === 'SELL'   ? `Sell: ${qty||'—'} of ${heldQty} shares`
                  : `Qty: ${qty||'—'} shares`;

    // Pre-fill execution defaults (persisted on the rec object, updated live)
    const execPrice = r._execPrice != null ? r._execPrice
      : isReducing
        ? (r.priceRange?.[0] ?? r.target ?? '')
        : r.priceRange
          ? (((r.priceRange[0]||0) + (r.priceRange[1]||0)) / 2).toFixed(3)
          : '';
    const execQty  = r._execQty  != null ? r._execQty  : (qty || '');
    const execFee  = r._execFee  != null ? r._execFee  : fees;

    return `
    <div class="rec-card" id="rec-${r.id}">
      <!-- Header row -->
      <div class="flex-between mb-1">
        <div class="flex-row">${actionBadge(r.action)}<strong style="font-size:15px">${r.ticker}</strong><span class="text-xs">${r.sector||''}</span>${r.isWatchlist?'<span class="badge" style="background:#ede9fe;color:#6d28d9;border:none">★ Watchlist</span>':''}<span class="badge badge-pending">Pending</span><span class="text-xs text-muted">Generated ${r.generatedAt||r.date}</span></div>
        <div class="flex-row">
          <button class="btn btn-sm btn-success" onclick="confirmExecute('${r.id}')">✓ Mark Executed</button>
          <button class="btn btn-sm btn-danger" onclick="markSkipped('${r.id}')">✕ Skip</button>
        </div>
      </div>

      <!-- AI price tiles -->
      <div class="grid-3 mb-1" style="margin-top:10px">${topTiles}</div>

      <!-- Confidence + signals -->
      <div class="flex-row mb-1">
        <div class="conf-bar" style="width:110px"><div class="conf-fill" style="width:${r.confidence*100}%;background:${confColor(r.confidence)}"></div></div>
        <span class="text-xs">${fmt(r.confidence*100,0)}% confidence</span>
        <span class="text-xs text-muted">|</span>
        <span class="text-xs">${qtyLine}</span>
      </div>

      <!-- Reasoning -->
      <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md);font-size:13px;line-height:1.65;margin-bottom:8px">
        <strong>Reasoning:</strong> ${r.reasoning}
      </div>
      ${r.risks?`<div class="text-xs text-muted mb-1"><strong>Risks:</strong> ${r.risks}</div>`:''}
      <div class="flex-row" style="margin-bottom:10px">
        ${(r.signals||[]).map(s=>`<span style="font-size:11px;padding:2px 8px;background:var(--bg-secondary);border-radius:4px;border:0.5px solid var(--border-light)">${s}</span>`).join('')}
      </div>

      <!-- ── Execution details (always visible) ── -->
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;background:var(--bg-secondary);border-radius:var(--radius-md);border:1px solid #3b82f6;margin-bottom:10px">
        <span style="font-size:11px;font-weight:600;color:#60a5fa;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap">Execution details</span>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:12px;color:var(--text-secondary);white-space:nowrap">Qty</label>
          <input type="number" id="exec-qty-${r.id}" value="${execQty}" step="1" min="1"
            oninput="persistExecField('${r.id}','_execQty',Number(this.value));updateExecTotal('${r.id}')"
            style="width:72px;padding:4px 8px;border:1.5px solid #f59e0b;border-radius:6px;font-size:13px;font-weight:600;background:var(--bg-primary);color:var(--text-primary)"
            title="Shares ${isReducing?'sold':'bought'}">
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:12px;color:var(--text-secondary);white-space:nowrap">Price $</label>
          <input type="number" id="exec-price-${r.id}" value="${execPrice}" step="0.001" min="0"
            oninput="persistExecField('${r.id}','_execPrice',Number(this.value));updateExecTotal('${r.id}')"
            style="width:90px;padding:4px 8px;border:1.5px solid #3b82f6;border-radius:6px;font-size:13px;font-weight:600;background:var(--bg-primary);color:var(--text-primary)"
            title="Actual execution price">
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:12px;color:var(--text-secondary);white-space:nowrap">Brokerage $</label>
          <input type="number" id="exec-fee-${r.id}" value="${execFee}" step="0.01" min="0"
            oninput="persistExecField('${r.id}','_execFee',Number(this.value));updateExecTotal('${r.id}')"
            style="width:72px;padding:4px 8px;border:1px solid var(--border-medium);border-radius:6px;font-size:13px;background:var(--bg-primary);color:var(--text-primary)"
            title="Brokerage fee">
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-left:auto">
          <span style="font-size:12px;color:var(--text-secondary);white-space:nowrap">${isReducing ? 'Net proceeds:' : 'Total cost:'}</span>
          <span id="exec-total-${r.id}" style="font-size:14px;font-weight:700;color:${isReducing?'#16a34a':'#f59e0b'};white-space:nowrap">${(()=>{
            const q=Number(execQty)||0, p=Number(execPrice)||0, f=Number(execFee)||0;
            if(!q||!p) return '—';
            const total = isReducing ? q*p - f : q*p + f;
            return '$' + total.toFixed(2);
          })()}</span>
        </div>
      </div>

      <!-- Staleness check banner (only shown for recs ≥ 2 days old) -->
      ${_recAgeInDays(r) >= 2 ? `<div id="staleness-${r.id}" style="margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;
                    background:#f8fafc;border:1px solid var(--border);border-radius:6px;font-size:11px;color:var(--text-muted)">
          <span>⏳</span>
          <span>Rec is ${_recAgeInDays(r)} day(s) old — checking if setup is still valid…</span>
        </div>
      </div>` : ''}

      <!-- Position Sizing Calculator (BUY / TOP_UP only) -->
      ${!isReducing ? renderPositionSizer(r) : ''}

      <!-- Feedback -->
      <div style="display:flex;gap:8px;align-items:center;padding-top:8px;border-top:0.5px solid var(--border-light)">
        <input type="text" id="feedback-${r.id}" placeholder="Optional feedback for next analysis run (e.g. 'too aggressive', 'ignore WDS for now')" value="${r.feedback||''}"
          style="flex:1;padding:6px 10px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-secondary);color:var(--text-primary);font-size:12px;font-family:var(--font)">
        <button class="btn btn-sm" onclick="submitFeedback('${r.id}')">💬 Save Feedback</button>
      </div>
    </div>
  `;
  }).join('');
}
// ── Entry Staleness Check ─────────────────────────────────────────────────────
// Parses DD-MM-YYYY rec.date into whole days elapsed (0 if unparseable).
function _recAgeInDays(rec) {
  const s = rec.date || '';
  const p = s.split('-');
  if (p.length === 3 && p[2].length === 4) {
    const d = new Date(+p[2], +p[1] - 1, +p[0]);
    const now = new Date(); now.setHours(0,0,0,0); d.setHours(0,0,0,0);
    return Math.max(0, Math.floor((now - d) / 86400000));
  }
  return 0;
}

/**
 * After the recommendations page renders, kick off background staleness checks
 * for any pending recs that are ≥ 2 days old.  Each check updates its banner div
 * without triggering a full re-render.
 */
async function initRecStalenessChecks() {
  if (typeof debateStatus !== 'function') return;
  const pending = state.recommendations.filter(r => r.status === 'pending' && _recAgeInDays(r) >= 2);
  if (!pending.length) return;

  // Check Ollama once; skip all if offline
  const status = await debateStatus();
  if (!status?.available) {
    // Still update the banners to show "Ollama offline — verify manually"
    pending.forEach(r => {
      const el = document.getElementById(`staleness-${r.id}`);
      if (el) el.innerHTML = _stalenessBanner(r.id, null, _recAgeInDays(r));
    });
    return;
  }

  const model = typeof preferredDebateModel === 'function'
    ? preferredDebateModel(status.models) : 'qwen3:9b';

  // Run sequentially — one Ollama call at a time avoids memory pressure
  for (const r of pending) {
    const el = document.getElementById(`staleness-${r.id}`);
    if (!el) continue;
    const signals = state.liveSignals?.[r.ticker] || {};
    const age = _recAgeInDays(r);
    try {
      const result = await fetchStaleness(r.ticker, signals, r.action, r.confidence, age, { model });
      el.innerHTML = _stalenessBanner(r.id, result, age);
    } catch {
      el.innerHTML = _stalenessBanner(r.id, null, age);
    }
  }
}

/** Build the staleness banner HTML for a given result. */
function _stalenessBanner(recId, result, daysAgo) {
  if (!result?.ok) {
    return `<div style="padding:6px 10px;background:#f8fafc;border:1px solid var(--border);
                         border-radius:6px;font-size:11px;color:var(--text-muted)">
      ⚠ Rec is ${daysAgo} day(s) old — Ollama offline, verify setup manually before executing.
    </div>`;
  }
  const cfg = {
    VALID:       { bg: '#f0fdf4', border: '#bbf7d0', color: '#15803d', icon: '✓' },
    WEAKENED:    { bg: '#fffbeb', border: '#fde68a', color: '#92400e', icon: '⚠' },
    INVALIDATED: { bg: '#fef2f2', border: '#fecaca', color: '#991b1b', icon: '✗' },
  }[result.verdict] || { bg: '#f8fafc', border: 'var(--border)', color: 'var(--text-muted)', icon: '?' };
  const label = { VALID: 'Setup still valid', WEAKENED: 'Setup weakened', INVALIDATED: 'Setup invalidated' }[result.verdict] || result.verdict;
  return `<div style="padding:6px 10px;background:${cfg.bg};border:1px solid ${cfg.border};
                       border-radius:6px;font-size:11px;display:flex;gap:6px;align-items:flex-start">
    <span style="font-weight:700;color:${cfg.color};flex-shrink:0">${cfg.icon} ${label}</span>
    <span style="color:${cfg.color}">${result.reason || ''}</span>
    <span style="margin-left:auto;white-space:nowrap;color:var(--text-muted)">${daysAgo}d old · ${result.model||''}</span>
  </div>`;
}

// ── REC HISTORY FILTER STATE ──────────────────────────────────
if (!state.recHistoryFilter) state.recHistoryFilter = {
  ticker: '', action: 'all', status: 'all', outcome: 'all',
  dateFrom: '', dateTo: '', minConf: 0, sortBy: 'date_desc'
};

function applyRecHistoryFilter(hist) {
  if ((hist.action||'').toUpperCase() === 'HOLD') return false;
  const f = state.recHistoryFilter;
  if (f.ticker && !hist.ticker.includes(f.ticker.toUpperCase())) return false;
  if (f.action !== 'all' && hist.action !== f.action) return false;
  if (f.status !== 'all') {
    if (f.status === 'executed' && !hist.executed) return false;
    if (f.status === 'skipped' && hist.executed) return false;
  }
  if (f.outcome !== 'all' && (hist.outcome || 'open') !== f.outcome) return false;
  if (f.minConf > 0 && (hist.confidence || 0) < f.minConf / 100) return false;
  if (f.dateFrom) {
    // dateFrom is YYYY-MM-DD; hist.date is DD-MM-YYYY
    const [dd,mm,yyyy] = (hist.date||'').split('-');
    const histISO = `${yyyy}-${mm}-${dd}`;
    if (histISO < f.dateFrom) return false;
  }
  if (f.dateTo) {
    const [dd,mm,yyyy] = (hist.date||'').split('-');
    const histISO = `${yyyy}-${mm}-${dd}`;
    if (histISO > f.dateTo) return false;
  }
  return true;
}

function resetRecHistoryFilter() {
  state.recHistoryFilter = { ticker:'', action:'all', status:'all', outcome:'all', dateFrom:'', dateTo:'', minConf:0, sortBy:'date_desc' };
  const el = document.getElementById('rec-content');
  if (el) el.innerHTML = renderRecHistory();
}

function setRecHistoryFilter(key, value) {
  if (!state.recHistoryFilter) state.recHistoryFilter = {};
  state.recHistoryFilter[key] = value;
  const el = document.getElementById('rec-content');
  if (el) el.innerHTML = renderRecHistory();
}

function renderRecHistory() {
  if (!state.recHistoryFilter || Object.keys(state.recHistoryFilter).length === 0) {
     state.recHistoryFilter = {
    ticker:'', action:'all', status:'all', outcome:'all',
    dateFrom:'', dateTo:'', minConf:0, sortBy:'date_desc'
  }; }
  const f = state.recHistoryFilter;

  // Get unique tickers from history for quick-filter chips
  const allTickers = [...new Set(state.recHistory.map(r=>r.ticker))].sort();

  // Filter
  let filtered = state.recHistory.filter(applyRecHistoryFilter);

  // Sort
  if (f.sortBy === 'date_desc')    filtered = filtered.slice().sort((a,b) => (b.date||'').localeCompare(a.date||''));
  else if (f.sortBy === 'date_asc') filtered = filtered.slice().sort((a,b) => (a.date||'').localeCompare(b.date||''));
  else if (f.sortBy === 'conf_desc') filtered = filtered.slice().sort((a,b) => (b.confidence||0) - (a.confidence||0));
  else if (f.sortBy === 'pnl_desc') filtered = filtered.slice().sort((a,b) => (b.actualProfit||b.netProfit||0) - (a.actualProfit||a.netProfit||0));

  // Summary stats of filtered set
  const execCount  = filtered.filter(r=>r.executed).length;
  const wonCount   = filtered.filter(r=>r.outcome==='win').length;
  const lostCount  = filtered.filter(r=>r.outcome==='loss').length;
  const totalActualPnl = filtered.filter(r=>r.actualProfit!=null).reduce((s,r)=>s+(r.actualProfit||0),0);
  const selStyle = `style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-secondary);color:var(--text-primary);font-size:12px;font-family:var(--font)"`;
  const inputStyle = `style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-secondary);color:var(--text-primary);font-size:12px;font-family:var(--font);width:100px"`;

  const hasFilters = f.ticker || f.action!=='all' || f.status!=='all' || f.outcome!=='all' || f.dateFrom || f.dateTo || f.minConf > 0;

  return `<div class="card">
    <!-- Filter Bar -->
    <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:12px 14px;margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.6px">Filters</div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="text-xs text-muted">${filtered.length} of ${state.recHistory.length} shown</span>
          ${hasFilters ? '<button class="btn btn-sm" onclick="resetRecHistoryFilter()">✕ Clear filters</button>' : ''}
          <button class="btn btn-sm btn-danger" onclick="clearRecHistory()">🗑 Clear history</button>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
        <!-- Ticker search -->
        <div>
          <div class="form-label" style="margin-bottom:3px">Ticker</div>
          <input type="text" placeholder="e.g. CBA" value="${f.ticker}" oninput="setRecHistoryFilter('ticker',this.value.toUpperCase())"
            style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:12px;width:80px">
        </div>
        <!-- Action filter -->
        <div>
          <div class="form-label" style="margin-bottom:3px">Action</div>
          <select onchange="setRecHistoryFilter('action',this.value)" ${selStyle}>
            <option value="all" ${f.action==='all'?'selected':''}>All actions</option>
            ${['BUY','TOP_UP','SELL','TRIM'].map(a=>`<option value="${a}" ${f.action===a?'selected':''}>${a}</option>`).join('')}
          </select>
        </div>
        <!-- Status filter -->
        <div>
          <div class="form-label" style="margin-bottom:3px">Status</div>
          <select onchange="setRecHistoryFilter('status',this.value)" ${selStyle}>
            <option value="all" ${f.status==='all'?'selected':''}>All</option>
            <option value="executed" ${f.status==='executed'?'selected':''}>Executed</option>
            <option value="skipped" ${f.status==='skipped'?'selected':''}>Skipped</option>
          </select>
        </div>
        <!-- Outcome filter -->
        <div>
          <div class="form-label" style="margin-bottom:3px">Outcome</div>
          <select onchange="setRecHistoryFilter('outcome',this.value)" ${selStyle}>
            <option value="all" ${f.outcome==='all'?'selected':''}>All outcomes</option>
            <option value="win"     ${f.outcome==='win'?'selected':''}>Won ✓</option>
            <option value="loss"    ${f.outcome==='loss'?'selected':''}>Lost ✗</option>
            <option value="open"    ${f.outcome==='open'?'selected':''}>Open</option>
            <option value="skipped" ${f.outcome==='skipped'?'selected':''}>Skipped</option>
          </select>
        </div>
        <!-- Date range -->
        <div>
          <div class="form-label" style="margin-bottom:3px">From</div>
          <input type="date" value="${f.dateFrom}" onchange="setRecHistoryFilter('dateFrom',this.value)"
            style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:12px">
        </div>
        <div>
          <div class="form-label" style="margin-bottom:3px">To</div>
          <input type="date" value="${f.dateTo}" onchange="setRecHistoryFilter('dateTo',this.value)"
            style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:12px">
        </div>
        <!-- Min confidence -->
        <div>
          <div class="form-label" style="margin-bottom:3px">Min confidence</div>
          <select onchange="setRecHistoryFilter('minConf',Number(this.value))" ${selStyle}>
            <option value="0"  ${f.minConf===0?'selected':''}>Any</option>
            <option value="55" ${f.minConf===55?'selected':''}>≥55%</option>
            <option value="65" ${f.minConf===65?'selected':''}>≥65%</option>
            <option value="75" ${f.minConf===75?'selected':''}>≥75%</option>
            <option value="85" ${f.minConf===85?'selected':''}>≥85%</option>
          </select>
        </div>
        <!-- Sort -->
        <div>
          <div class="form-label" style="margin-bottom:3px">Sort by</div>
          <select onchange="setRecHistoryFilter('sortBy',this.value)" ${selStyle}>
            <option value="date_desc"  ${f.sortBy==='date_desc'?'selected':''}>Newest first</option>
            <option value="date_asc"   ${f.sortBy==='date_asc'?'selected':''}>Oldest first</option>
            <option value="conf_desc"  ${f.sortBy==='conf_desc'?'selected':''}>Highest confidence</option>
            <option value="pnl_desc"   ${f.sortBy==='pnl_desc'?'selected':''}>Best P&L first</option>
          </select>
        </div>
      </div>
      ${allTickers.length > 0 ? `
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:10px;padding-top:10px;border-top:0.5px solid var(--border-light)">
        <span class="text-xs text-muted" style="white-space:nowrap;padding-top:3px">Quick:</span>
        <button class="btn btn-sm ${!f.ticker?'btn-primary':''}" style="font-size:11px;padding:2px 8px" onclick="setRecHistoryFilter('ticker','')">All</button>
        ${allTickers.map(t=>`<button class="btn btn-sm ${f.ticker===t?'btn-primary':''}" style="font-size:11px;padding:2px 8px" onclick="setRecHistoryFilter('ticker','${t}')">${t}</button>`).join('')}
      </div>` : ''}
    </div>

    <!-- Stats row -->
    ${filtered.length > 0 ? `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md);font-size:12px">
        <span class="text-muted">Executed</span> <strong>${execCount}</strong>
      </div>
      <div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md);font-size:12px">
        <span class="text-muted">Won</span> <strong class="text-success">${wonCount}</strong>
      </div>
      <div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md);font-size:12px">
        <span class="text-muted">Lost</span> <strong class="text-danger">${lostCount}</strong>
      </div>
      ${execCount > 0 ? `<div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md);font-size:12px">
        <span class="text-muted">Win rate</span> <strong>${wonCount+lostCount > 0 ? fmt(wonCount/(wonCount+lostCount)*100,0)+'%' : '—'}</strong>
      </div>` : ''}
      ${totalActualPnl !== 0 ? `<div style="background:var(--bg-secondary);padding:8px 12px;border-radius:var(--radius-md);font-size:12px">
        <span class="text-muted">Actual P&L</span> <strong class="${totalActualPnl>=0?'text-success':'text-danger'}">${totalActualPnl>=0?'+':''}$${fmt(Math.abs(totalActualPnl))}</strong>
      </div>` : ''}
    </div>` : ''}

    ${filtered.length === 0 ? `<div class="empty-state" style="padding:2rem"><div class="empty-icon">◆</div><p>${state.recHistory.length === 0 ? 'No recommendation history yet.' : 'No records match your filters.'}</p></div>` : `
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Ticker</th><th>Action</th><th>Confidence</th><th>Est. P&L<br><span style="font-weight:400;font-size:10px">at target</span></th><th>Status</th><th>Outcome</th><th>Actual P&L</th><th>Feedback</th></tr></thead>
      <tbody>
        ${filtered.map((r)=>{
          const realIdx = state.recHistory.indexOf(r);
          return `<tr>
            <td class="text-xs">${r.date}</td>
            <td><strong>${r.ticker}</strong></td>
            <td>${actionBadge(r.action)}</td>
            <td><div class="flex-row"><div class="conf-bar" style="width:60px"><div class="conf-fill" style="width:${(r.confidence||0)*100}%;background:${confColor(r.confidence||0)}"></div></div><span class="text-xs">${fmt((r.confidence||0)*100,0)}%</span></div></td>
            <td class="text-xs ${r.netProfit!=null?(r.netProfit>=0?'text-success':'text-danger'):''}">${r.netProfit!=null?(r.netProfit>=0?'+ ':'− ')+'$'+fmt(Math.abs(r.netProfit)):'&mdash;'}</td>
            <td>${statusBadge(r.executed?'executed':'skipped')}</td>
            <td class="text-xs ${r.outcome==='win'?'text-success':r.outcome==='loss'?'text-danger':'text-muted'}">${r.outcome==='win'?'✓ Win':r.outcome==='loss'?'✗ Loss':r.outcome||'&mdash;'}</td>
            <td class="${r.actualProfit!=null?(r.actualProfit>=0?'text-success':'text-danger'):'text-muted'}">${r.actualProfit!=null?(r.actualProfit>=0?'+ ':'− ')+'$'+fmt(Math.abs(r.actualProfit)):'&mdash;'}</td>
            <td style="min-width:180px">
              <div style="display:flex;gap:6px;align-items:center">
                <input type="text" id="hfb-${realIdx}" value="${r.feedback||''}" placeholder="Add feedback…"
                  style="flex:1;padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-secondary);color:var(--text-primary);font-size:11px;font-family:var(--font)">
                <button class="btn btn-sm" onclick="addHistoryFeedback(${realIdx})" title="Save feedback">✓</button>
              </div>
              ${r.feedback?`<div class="text-xs text-muted" style="margin-top:3px">💬 ${r.feedback}</div>`:''}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>`}
  </div>`;
}
// Persist user-edited execution field onto the rec object (survives tab switches within session)
function persistExecField(recId, field, value) {
  const rec = state.recommendations.find(r => r.id === recId);
  if (rec) { rec[field] = value; scheduleSave(); }
}

// Recalculate and display total cost / net proceeds in the execution details box
function updateExecTotal(recId) {
  const qty   = parseFloat(document.getElementById(`exec-qty-${recId}`)?.value)   || 0;
  const price = parseFloat(document.getElementById(`exec-price-${recId}`)?.value) || 0;
  const fee   = parseFloat(document.getElementById(`exec-fee-${recId}`)?.value)   || 0;
  const el    = document.getElementById(`exec-total-${recId}`);
  if (!el) return;
  if (!qty || !price) { el.textContent = '—'; return; }
  const rec = state.recommendations.find(r => r.id === recId);
  const isReducing = rec && (rec.action === 'SELL' || rec.action === 'TRIM');
  const total = isReducing ? qty * price - fee : qty * price + fee;
  el.textContent = '$' + total.toFixed(2);
}

function confirmExecute(recId) {
  const qtyEl   = document.getElementById(`exec-qty-${recId}`);
  const priceEl = document.getElementById(`exec-price-${recId}`);
  const feeEl   = document.getElementById(`exec-fee-${recId}`);
  const qty   = parseInt(qtyEl?.value);
  const price = parseFloat(priceEl?.value);
  const fee   = parseFloat(feeEl?.value ?? state.settings.brokerage);
  if (isNaN(qty)   || qty <= 0)  { toast('Enter a valid quantity (shares)', 'error'); qtyEl?.focus(); return; }
  if (isNaN(price) || price <= 0){ toast('Enter a valid execution price', 'error'); priceEl?.focus(); return; }
  if (isNaN(fee)   || fee < 0)   { toast('Enter a valid brokerage fee', 'error'); feeEl?.focus(); return; }
  markExecuted(recId, price, fee, qty);
}

function _detectExitReason(exitPrice, stopLoss, target) {
  if (!exitPrice || exitPrice <= 0) return 'manual';
  if (stopLoss && exitPrice <= stopLoss * 1.005) return 'stop_hit';
  if (target   && exitPrice >= target  * 0.995)  return 'target_hit';
  return 'manual';
}

function markExecuted(id, execPrice, execFee, execQty) {
  const rec = state.recommendations.find(r => r.id === id); if(!rec) return;
  const time = nowSydney();
  const today = todayStr();
  rec.status = 'executed';
  rec.executedAt = time;

  const qty        = (execQty  !== undefined && !isNaN(execQty)  && execQty  > 0) ? execQty  : (rec.qty || 10);
  const fees       = (execFee  !== undefined && !isNaN(execFee))                  ? execFee  : state.settings.brokerage;
  const tradePrice = (execPrice !== undefined && !isNaN(execPrice) && execPrice > 0) ? execPrice : (rec.priceRange?.[0] ?? 0);
  const isReducing = rec.action === 'SELL' || rec.action === 'TRIM';

  let tradeEntry;
  let realizedPnl = null;   // will be set for SELL/TRIM when holding exists

  if (isReducing) {
    const holding = getPortfolioHolding(rec.ticker);
    if (holding && holding.shares >= qty) {
      // Derive open date from earliest live parcel so Performance hold-duration is accurate
      const liveParcels = (state.cgtParcels || []).filter(p => p.ticker === rec.ticker && (p.shares || 0) > 0);
      const openDate = liveParcels.length
        ? liveParcels.reduce((earliest, p) => (p.date && p.date < earliest ? p.date : earliest), liveParcels[0].date || today)
        : null;
      const prevDisposalLen = state.cgtDisposals.length;
      const { disposals } = applySellToPortfolio(rec.ticker, qty, tradePrice, fees, today);
      realizedPnl = disposalsToPnl(disposals);
      tradeEntry = {
        id: state.tradeJournal.length + 1, date: openDate || today, ticker: rec.ticker, action: rec.action,
        qty, entryPrice: holding.avgPrice, exitPrice: tradePrice, fees,
        status: 'closed', pnl: realizedPnl, closeDate: today,
        disposalIds: disposals.map((_, i) => prevDisposalLen + i),
        recId: rec.id, recExecuted: true, timestamp: time
      };
    } else {
      tradeEntry = {
        id: state.tradeJournal.length + 1, date: today, ticker: rec.ticker, action: rec.action,
        qty, entryPrice: tradePrice, exitPrice: null, fees,
        status: 'open', pnl: null, recId: rec.id, recExecuted: true, timestamp: time
      };
      toast(`${rec.action} ${rec.ticker}: not enough shares held — logged but portfolio unchanged.`, 'warn');
    }
  } else {
    // BUY or TOP_UP — open/add to a position
    applyBuyToPortfolio(rec.ticker, qty, tradePrice, today, fees, rec.sector);
    const newParcel = state.cgtParcels[state.cgtParcels.length - 1];
    state.cash -= qty * tradePrice + fees;
    tradeEntry = {
      id: state.tradeJournal.length + 1, date: today, ticker: rec.ticker, action: rec.action,
      qty, entryPrice: tradePrice, exitPrice: null, fees,
      status: 'open', pnl: null,
      parcelId: newParcel ? newParcel.id : null,
      recId: rec.id, recExecuted: true, timestamp: time
    };
  }

  // Save to journal
  state.tradeJournal.unshift(tradeEntry);

  // Save to recHistory — include all execution details so backtest can use them
  const histEntry = {
    id: rec.id, date: today, ticker: rec.ticker, action: rec.action,
    confidence: rec.confidence, priceRange: rec.priceRange, target: rec.target,
    stopLoss: rec.stopLoss, expectedProfit: rec.expectedProfit, netProfit: rec.netProfit,
    qty, executedPrice: tradePrice, executedFee: fees,
    executed: true, executedAt: time,
    outcome: 'open',
    actualProfit: realizedPnl,
    reasoning: rec.reasoning || null,
    feedback: rec.feedback || null,
    journalId: tradeEntry.id,
    _learningId: rec._learningId || null,
  };
  state.recHistory.unshift(histEntry);

  // Update learning loop: mark event as executed, or log fresh if no prior event
  if (state.serverOk) {
    const pv = typeof PROMPT_VERSION !== 'undefined' ? PROMPT_VERSION : 'unknown';
    const entryP = tradeEntry.entryPrice || tradePrice;
    const exitP  = tradeEntry.exitPrice  ?? null;
    const pnlPct = realizedPnl != null && entryP > 0
      ? +((realizedPnl / (entryP * qty)) * 100).toFixed(2) : null;
    const outcome = realizedPnl != null
      ? (realizedPnl > 0 ? 'win' : realizedPnl < 0 ? 'loss' : 'breakeven') : null;
    const holdDays = (tradeEntry.date && today)
      ? Math.max(0, Math.round((new Date(today) - new Date(tradeEntry.date)) / 86400000))
      : null;
    const currentRegime = typeof state._lastRegime === 'string' ? state._lastRegime : null;
    const sector = rec.sector || (typeof getPortfolioHolding === 'function'
      ? getPortfolioHolding(rec.ticker)?.sector : null) || null;

    if (rec._learningId) {
      // Existing learning event → update with full outcome context
      const outcomePayload = {
        id: rec._learningId, was_executed: true,
        actual_entry_price: entryP ?? null,
        actual_exit_price:  exitP  ?? null,
        sector,
      };
      if (outcome) {
        const exitReason = _detectExitReason(exitP || tradePrice, rec.stopLoss, rec.target);
        outcomePayload.outcome_status      = outcome;
        outcomePayload.realized_pnl_aud    = +realizedPnl.toFixed(2);
        outcomePayload.realized_pnl_pct    = pnlPct;
        outcomePayload.holding_period_days = holdDays;
        outcomePayload.exit_reason         = exitReason;
      }
      fetch(`${API}/api/learning/outcome`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(outcomePayload),
      }).catch(() => {});

      // #2: when position fully closes, reconcile all open BUY/TOP_UP learning events for this ticker
      if (isReducing && outcome) {
        const remaining = getPortfolioHolding(rec.ticker);
        const positionClosed = !remaining || (remaining.shares || 0) <= 0;
        if (positionClosed) {
          const exitReason = _detectExitReason(exitP || tradePrice, rec.stopLoss, rec.target);
          const parentRecs = (state.recHistory || []).filter(r =>
            r.ticker === rec.ticker &&
            r._learningId &&
            r._learningId !== rec._learningId &&
            r.outcome === 'open' &&
            (r.action === 'BUY' || r.action === 'TOP_UP')
          );
          for (const pr of parentRecs) {
            // Compute per-entry outcome so a TOP_UP at a higher price than exit
            // isn't wrongly marked 'win' just because the overall position was profitable.
            const prEntry = pr.executedPrice || pr.priceRange?.[0] || null;
            const prQty   = pr.qty || null;
            let prOutcome = outcome;   // fallback: inherit overall exit outcome
            let prPnlPct  = null;
            let prPnlAud  = null;
            if (prEntry && prEntry > 0) {
              prPnlPct  = +((tradePrice - prEntry) / prEntry * 100).toFixed(2);
              if (prQty) prPnlAud = +((tradePrice - prEntry) * prQty).toFixed(2);
              prOutcome = tradePrice > prEntry ? 'win' : tradePrice < prEntry ? 'loss' : 'breakeven';
            }
            fetch(`${API}/api/learning/outcome`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id:                  pr._learningId,
                outcome_status:      prOutcome,
                exit_reason:         exitReason,
                actual_exit_price:   tradePrice,
                holding_period_days: holdDays,
                ...(prPnlPct != null ? { realized_pnl_pct: prPnlPct } : {}),
                ...(prPnlAud != null ? { realized_pnl_aud: prPnlAud } : {}),
              }),
            }).catch(() => {});
            const rh = state.recHistory.find(r => r.id === pr.id);
            if (rh) rh.outcome = prOutcome;
          }
        }
      }
    } else if (isReducing && realizedPnl != null) {
      // No prior learning event (manually-imported position).
      const rrRatio = entryP && rec.stopLoss && rec.target && entryP !== rec.stopLoss
        ? +Math.abs((rec.target - entryP) / (entryP - rec.stopLoss)).toFixed(2) : null;
      const exitReason = _detectExitReason(exitP || tradePrice, rec.stopLoss, rec.target);
      fetch(`${API}/api/learning/log`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type:          'recommendation',
          ticker:              rec.ticker,
          regime:              currentRegime,
          prompt_version:      pv,
          ai_confidence:       rec.confidence ?? null,
          ensemble_confidence: rec.ensembleConfidence ?? null,
          recommendation:      rec.action,
          rationale_summary:   rec.reasoning ? rec.reasoning.slice(0, 400) : null,
          suggested_stop:      rec.stopLoss ?? null,
          suggested_target:    rec.target ?? null,
          rr_ratio:            rrRatio,
          was_executed:        true,
          outcome_status:      outcome,
          realized_pnl_aud:    +realizedPnl.toFixed(2),
          realized_pnl_pct:    pnlPct,
          holding_period_days: holdDays,
          exit_reason:         exitReason,
          actual_entry_price:  entryP ?? null,
          actual_exit_price:   exitP  ?? null,
          sector,
          notes:               'Manually imported position — no prior BUY event logged',
        }),
      }).then(r => r.json()).then(res => {
        if (res.id) {
          histEntry._learningId = res.id;
          const rh = state.recHistory.find(r => r.id === rec.id);
          if (rh) rh._learningId = res.id;
          // #5: fire auto-postmortem on fresh-logged losses/breakevens
          if ((outcome === 'loss' || outcome === 'breakeven') && typeof triggerPostmortem === 'function') {
            triggerPostmortem(res.id).catch(() => {});
          }
          if (outcome && typeof fetchSkillScore === 'function') {
            fetchSkillScore(res.id).catch(() => {});
          }
        }
      }).catch(() => {});
    }
  }

  // #5: auto-postmortem on loss/breakeven when we already had a _learningId
  if (state.serverOk && rec._learningId && (outcome === 'loss' || outcome === 'breakeven')) {
    if (typeof triggerPostmortem === 'function') triggerPostmortem(rec._learningId).catch(() => {});
  }
  if (state.serverOk && rec._learningId && outcome) {
    if (typeof fetchSkillScore === 'function') fetchSkillScore(rec._learningId).catch(() => {});
  }

  toast(`${rec.ticker} ${rec.action} ${qty} @ $${fmt(tradePrice)} (fee $${fmt(fees)}) — logged`, 'success');
  scheduleSave();
  renderPage();
}
function markSkipped(id) {
  const rec=state.recommendations.find(r=>r.id===id); if(!rec) return;
  rec.status='skipped';
  state.recHistory.unshift({
    id: rec.id, date: todayStr(), ticker: rec.ticker, action: rec.action,
    confidence: rec.confidence, priceRange: rec.priceRange, target: rec.target,
    stopLoss: rec.stopLoss, expectedProfit: rec.expectedProfit, netProfit: rec.netProfit,
    executed: false, executedAt: null, outcome: 'skipped', actualProfit: null,
    feedback: rec.feedback || null, _learningId: rec._learningId || null,
  });
  // Update learning loop: mark event as skipped (fire-and-forget)
  if (rec._learningId && state.serverOk) {
    fetch(`${API}/api/learning/outcome`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rec._learningId, outcome_status: 'skipped', was_executed: false }),
    }).catch(() => {});
  }
  toast(`${rec.ticker} skipped`,'info'); scheduleSave(); renderPage();
}
function clearRecHistory() {
  if(!confirm('Remove all recommendation history entries?')) return;
  state.recHistory = [];
  scheduleSave();
  renderPage();
  toast('Recommendation history cleared','success');
}
function submitFeedback(recId) {
  const el = document.getElementById(`feedback-${recId}`);
  if (!el) return;
  const text = el.value.trim();
  const rec = state.recommendations.find(r => r.id === recId);
  if (rec) {
    rec.feedback = text || null;
    // Sync to recHistory if this rec was already moved there
    const histEntry = state.recHistory.find(r => r.id === recId);
    if (histEntry) histEntry.feedback = text || null;
    scheduleSave();
    toast(text ? `Feedback saved — will be included in next analysis run` : 'Feedback cleared', 'success');
  }
}
function addHistoryFeedback(idx) {
  const el = document.getElementById(`hfb-${idx}`);
  if (!el) return;
  const text = el.value.trim();
  if (state.recHistory[idx]) {
    state.recHistory[idx].feedback = text || null;
    scheduleSave();
    // Re-render feedback label without full page re-render
    const label = el.parentElement.nextElementSibling;
    if (label) label.remove();
    if (text) {
      const div = document.createElement('div');
      div.className = 'text-xs text-muted';
      div.style.marginTop = '3px';
      div.textContent = `💬 ${text}`;
      el.parentElement.insertAdjacentElement('afterend', div);
    }
    toast(text ? 'Feedback saved' : 'Feedback cleared', 'success');
  }
}

// ============================================================
// POSITION SIZING CALCULATOR
// ============================================================
function renderPositionSizer(rec) {
  const nw      = totalNetWorth();
  const entry   = rec.priceRange ? ((rec.priceRange[0] + rec.priceRange[1]) / 2) : rec.priceRange?.[0] || 0;
  const stop    = rec.stopLoss || 0;
  const target  = rec.target   || 0;
  const fees    = state.settings.brokerage || 10;
  const riskPct = 1.0;   // default 1% risk — user can change via input

  const riskAmt   = nw * riskPct / 100;
  const perShare  = entry > stop && stop > 0 ? entry - stop : null;
  const recQty    = perShare ? Math.floor(riskAmt / perShare) : rec.qty || 0;
  const posValue  = recQty * entry;
  const posWeight = nw > 0 ? posValue / nw * 100 : 0;
  const maxLoss   = perShare ? recQty * perShare + fees : null;
  const potGain   = target > entry ? recQty * (target - entry) - fees * 2 : null;
  const rr        = maxLoss && potGain ? potGain / maxLoss : null;

  const sId = `sizer-${rec.id}`;

  return `
  <details style="margin-bottom:10px" id="${sId}-details">
    <summary style="cursor:pointer;padding:7px 10px;background:var(--bg-secondary);border-radius:var(--radius-md);border:0.5px solid var(--border-light);font-size:12px;font-weight:600;color:var(--text-secondary);user-select:none;list-style:none;display:flex;align-items:center;gap:6px">
      <span>📐</span> Position Sizing Calculator
      <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:4px">(click to expand)</span>
    </summary>
    <div style="padding:12px;border:0.5px solid var(--border-light);border-top:none;border-radius:0 0 var(--radius-md) var(--radius-md);background:var(--bg-primary)">

      <!-- Inputs row -->
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
        <div>
          <div class="form-label">Risk % of net worth</div>
          <div style="display:flex;align-items:center;gap:4px">
            <input type="number" id="${sId}-risk" value="${riskPct}" min="0.1" max="10" step="0.1"
              style="width:65px;padding:4px 8px;border-radius:6px;border:1px solid var(--border-medium);font-size:13px;background:var(--bg-primary);color:var(--text-primary)"
              oninput="updateSizer('${rec.id}')">
            <span class="text-xs text-muted">% = $<span id="${sId}-risk-amt">${fmt(riskAmt, 0)}</span></span>
          </div>
        </div>
        <div>
          <div class="form-label">Entry price $</div>
          <input type="number" id="${sId}-entry" value="${entry.toFixed(3)}" step="0.001" min="0"
            style="width:90px;padding:4px 8px;border-radius:6px;border:1px solid var(--border-medium);font-size:13px;background:var(--bg-primary);color:var(--text-primary)"
            oninput="updateSizer('${rec.id}')">
        </div>
        <div>
          <div class="form-label">Stop-loss $</div>
          <input type="number" id="${sId}-stop" value="${stop.toFixed(3)}" step="0.001" min="0"
            style="width:90px;padding:4px 8px;border-radius:6px;border:1px solid #ef4444;font-size:13px;background:var(--bg-primary);color:var(--text-primary)"
            oninput="updateSizer('${rec.id}')">
        </div>
        <div>
          <div class="form-label">Target $</div>
          <input type="number" id="${sId}-target" value="${target.toFixed(3)}" step="0.001" min="0"
            style="width:90px;padding:4px 8px;border-radius:6px;border:1px solid #16a34a;font-size:13px;background:var(--bg-primary);color:var(--text-primary)"
            oninput="updateSizer('${rec.id}')">
        </div>
      </div>

      <!-- Results -->
      <div id="${sId}-output" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
        ${sizerOutput(recQty, posValue, posWeight, maxLoss, potGain, rr, fees, nw)}
      </div>
    </div>
  </details>`;
}

function sizerOutput(qty, posValue, posWeight, maxLoss, potGain, rr, fees, nw) {
  const maxPosPct = (state.settings.maxPositionPct || 15);
  const overweight = posWeight > maxPosPct;
  const rrColor = rr == null ? 'var(--text-muted)' : rr >= 3 ? '#16a34a' : rr >= 2 ? '#d97706' : '#dc2626';
  const tile = (label, val, sub, color) =>
    `<div style="padding:8px 10px;background:var(--bg-secondary);border-radius:6px;border:0.5px solid var(--border-light)">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">${label}</div>
      <div style="font-weight:600;font-size:13px;color:${color||'var(--text-primary)'};">${val}</div>
      ${sub ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">${sub}</div>` : ''}
    </div>`;
  return [
    tile('Suggested Qty', qty > 0 ? `${qty} shares` : '—', qty > 0 ? `$${fmt(posValue)} total` : 'check stop-loss'),
    tile('Position Size', posValue > 0 ? `$${fmt(posValue)}` : '—', `${fmt(posWeight, 1)}% of net worth`, overweight ? '#ef4444' : undefined),
    tile('Max loss if stopped', maxLoss != null ? `$${fmt(maxLoss)}` : '—', maxLoss != null ? `inc. $${fees} brokerage` : 'set stop-loss'),
    tile('Potential gain', potGain != null ? `$${fmt(potGain)}` : '—', potGain != null ? 'if target hit (2× brokerage)' : 'set target'),
    tile('R:R ratio', rr != null ? `${rr.toFixed(1)} : 1` : '—', rr != null ? (rr >= 2 ? '✓ Acceptable' : '⚠ Below 2:1 — avoid') : '', rrColor),
    overweight ? tile('⚠ Position limit', `Max ${maxPosPct}% rule`, `Reduce qty to stay within limit`, '#ef4444') : '',
  ].join('');
}

function updateSizer(recId) {
  const sId = `sizer-${recId}`;
  const riskPct  = parseFloat(document.getElementById(`${sId}-risk`)?.value)   || 1;
  const entry    = parseFloat(document.getElementById(`${sId}-entry`)?.value)   || 0;
  const stop     = parseFloat(document.getElementById(`${sId}-stop`)?.value)    || 0;
  const target   = parseFloat(document.getElementById(`${sId}-target`)?.value)  || 0;
  const nw       = totalNetWorth();
  const fees     = state.settings.brokerage || 10;

  const riskAmt  = nw * riskPct / 100;
  const perShare = entry > stop && stop > 0 ? entry - stop : null;
  const qty      = perShare ? Math.floor(riskAmt / perShare) : 0;
  const posValue = qty * entry;
  const posWeight = nw > 0 ? posValue / nw * 100 : 0;
  const maxLoss  = perShare ? qty * perShare + fees : null;
  const potGain  = target > entry && qty > 0 ? qty * (target - entry) - fees * 2 : null;
  const rr       = maxLoss && potGain ? potGain / maxLoss : null;

  const riskAmtEl = document.getElementById(`${sId}-risk-amt`);
  if (riskAmtEl) riskAmtEl.textContent = fmt(riskAmt, 0);

  const out = document.getElementById(`${sId}-output`);
  if (out) out.innerHTML = sizerOutput(qty, posValue, posWeight, maxLoss, potGain, rr, fees, nw);
}

// ============================================================
// RECOMMENDATIONS — RULES PANEL
// ============================================================

const _REC_RULE_DEFAULTS = {
  minConfidence: 0.62, minIndepFactors: 3, bearCaseThreshold: 0.70,
  highRiskMinConf: 0.75, veryHighRiskMinConf: 0.80,
  minRrRatio: 2.0, stopAtrMultiple: 1.5,
  maxPositionPct: 15, maxSectorPct: 30,
  sameTickerWindowDays: 7, minHoldingDays: 1,
  minChurnProfitAud: 100, minChurnProfitPct: 2,
  dividendYieldPremium: 1.5, highConvYieldPremium: 2.5,
  highVarThreshold1: -3.5, highVarThreshold2: -5.0, highDdThreshold: 25,
  compositeRiskHighScore: 67, compositeRiskVeryHighScore: 80,
  exDivProtectDays: 5, exDivFlagDays: 10,
  cgtHoldMonthsMin: 11, cgtHoldMonthsMax: 12,
  customRules: '',
};

function _recRuleVal(key) {
  return state.analysisConfig.rules?.[key] ?? _REC_RULE_DEFAULTS[key];
}

function renderRecRulesPanel() {
  const v = _recRuleVal;

  const nf = (label, key, min, max, step, hint) => `
    <div>
      <div class="form-label">${label}</div>
      <input type="number" value="${v(key)}" min="${min}" max="${max}" step="${step}"
        style="width:110px" title="${hint}"
        onchange="setRecRule('${key}', Number(this.value))">
      <div class="text-xs text-muted mt-1" style="max-width:200px">${hint}</div>
    </div>`;

  const isModified = Object.keys(_REC_RULE_DEFAULTS).some(
    k => k !== 'customRules' && (state.analysisConfig.rules?.[k] ?? _REC_RULE_DEFAULTS[k]) !== _REC_RULE_DEFAULTS[k]
  );

  return `
    <div style="display:flex;flex-direction:column;gap:14px">

      ${isModified ? `
      <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:var(--radius-md);padding:10px 14px;font-size:12px;color:#92400e;display:flex;align-items:center;justify-content:space-between">
        <span>Custom rules active — defaults have been modified. These are applied on every analysis run.</span>
        <button class="btn btn-sm" onclick="resetRecRules()" style="white-space:nowrap">↺ Reset all</button>
      </div>` : `
      <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 14px;font-size:12px;color:var(--text-muted)">
        Using default rules. Edit any value below to override — changes are applied immediately on the next run.
      </div>`}

      <!-- Confidence & Conviction -->
      <div class="card">
        <div class="card-title">Confidence &amp; Conviction</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:8px">
          ${nf('Min confidence floor', 'minConfidence', 0.40, 1.0, 0.01, 'Recs below this are dropped client-side')}
          ${nf('Min independent factors', 'minIndepFactors', 1, 5, 1, 'Non-technical factors required before any rec')}
          ${nf('Bear case threshold', 'bearCaseThreshold', 0.50, 1.0, 0.05, 'Confidence above which a bear case is required')}
          ${nf('High-risk min confidence', 'highRiskMinConf', 0.50, 1.0, 0.05, 'Applied when portfolio risk score > compositeRiskHighScore')}
          ${nf('Very-high-risk min conf', 'veryHighRiskMinConf', 0.50, 1.0, 0.05, 'Applied when portfolio risk score > compositeRiskVeryHighScore (no new BUYs threshold)')}
        </div>
      </div>

      <!-- Risk / Reward -->
      <div class="card">
        <div class="card-title">Risk / Reward</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:8px">
          ${nf('Min R:R ratio', 'minRrRatio', 1.0, 5.0, 0.5, 'Minimum reward:risk — recs below this are rejected')}
          ${nf('Stop ATR multiple', 'stopAtrMultiple', 0.5, 5.0, 0.5, 'Stop-loss = entry − N×ATR14')}
        </div>
      </div>

      <!-- Position Sizing -->
      <div class="card">
        <div class="card-title">Position Sizing</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:8px">
          ${nf('Max position size (%)', 'maxPositionPct', 5, 50, 1, 'Single-position weight ceiling')}
          ${nf('Max sector concentration (%)', 'maxSectorPct', 10, 80, 5, 'Max portfolio weight in any one sector')}
        </div>
      </div>

      <!-- Anti-churn -->
      <div class="card">
        <div class="card-title">Anti-churn Rules</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:8px">
          ${nf('Same-ticker window (days)', 'sameTickerWindowDays', 1, 30, 1, 'No BUY→SELL flip on same ticker within this window')}
          ${nf('Min holding days', 'minHoldingDays', 0, 30, 1, 'Minimum hold period before SELL/TRIM is valid')}
          ${nf('Min churn profit ($AUD)', 'minChurnProfitAud', 0, 1000, 10, 'Reject SELL/TRIM if net profit below this dollar amount')}
          ${nf('Min churn profit (%)', 'minChurnProfitPct', 0, 20, 0.5, 'Reject SELL/TRIM if net profit below this % of position')}
        </div>
      </div>

      <!-- Dividend & Income -->
      <div class="card">
        <div class="card-title">Dividend &amp; Income Rules</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:8px">
          ${nf('Dividend yield premium (%)', 'dividendYieldPremium', 0, 5, 0.25, 'Minimum yield premium over RBA rate for income classification')}
          ${nf('High-conviction yield premium (%)', 'highConvYieldPremium', 0, 6, 0.25, 'Premium required for high-conviction overweight income plays')}
        </div>
      </div>

      <!-- Portfolio Risk Thresholds -->
      <div class="card">
        <div class="card-title">Portfolio Risk Thresholds</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:8px">
          ${nf('VaR1d threshold 1 (%)', 'highVarThreshold1', -20, 0, 0.5, 'VaR1d below this → reduce qty by 25%')}
          ${nf('VaR1d threshold 2 (%)', 'highVarThreshold2', -20, 0, 0.5, 'VaR1d below this → reduce qty by 50%')}
          ${nf('MaxDD90d threshold (%)', 'highDdThreshold', 5, 60, 1, 'Max drawdown above this → mandatory stop-loss note')}
          ${nf('Composite risk high score', 'compositeRiskHighScore', 30, 95, 1, 'Risk score above this → raise min confidence')}
          ${nf('Composite risk very-high score', 'compositeRiskVeryHighScore', 50, 100, 1, 'Risk score above this → no new BUY positions')}
        </div>
      </div>

      <!-- Ex-dividend & CGT -->
      <div class="card">
        <div class="card-title">Ex-dividend &amp; CGT Rules</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:8px">
          ${nf('Ex-div protect window (days)', 'exDivProtectDays', 0, 30, 1, 'No TRIM/SELL within this many days before ex-div')}
          ${nf('Ex-div flag window (days)', 'exDivFlagDays', 0, 60, 1, 'Flag TRIM/SELL when ex-div is within this range')}
          ${nf('CGT window start (months)', 'cgtHoldMonthsMin', 6, 12, 1, 'Start of CGT discount warning window')}
          ${nf('CGT window end (months)', 'cgtHoldMonthsMax', 10, 18, 1, 'End of CGT discount window — flag any SELL before this')}
        </div>
      </div>

      <!-- Custom Rules -->
      <div class="card">
        <div class="card-title">Custom Rule Injection</div>
        <p class="text-xs text-muted" style="margin-bottom:10px">Appended verbatim to every analysis run as additional AI instructions. Plain English only — no JSON.</p>
        <textarea rows="5" placeholder="e.g. Never recommend commodity stocks while iron ore spot < $100/t. Always favour dividend payers over growth stocks in the current macro regime."
          style="font-size:13px;line-height:1.65;width:100%"
          oninput="setRecRule('customRules', this.value)">${v('customRules')}</textarea>
      </div>

      <!-- Footer -->
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-size:13px;font-weight:600">Rules applied on next run</div>
          <div class="text-xs text-muted">Confidence floor is enforced client-side · all other rules injected into AI user message</div>
        </div>
        <div class="flex-row">
          <button class="btn btn-sm" onclick="resetRecRules()">↺ Reset to defaults</button>
          <button class="btn btn-primary btn-sm" onclick="switchRecTab('run');setTimeout(runAnalysisFromPanel,50)">▶ Run Analysis Now</button>
        </div>
      </div>

    </div>
  `;
}

function setRecRule(key, value) {
  if (!state.analysisConfig.rules) state.analysisConfig.rules = {};
  state.analysisConfig.rules[key] = value;
  scheduleSave();
}

function resetRecRules() {
  state.analysisConfig.rules = { ..._REC_RULE_DEFAULTS };
  scheduleSave();
  const el = document.getElementById('rec-content');
  if (el) el.innerHTML = renderRecRulesPanel();
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const tab = document.getElementById('tab-rules');
  if (tab) tab.classList.add('active');
  toast('Analysis rules reset to defaults', 'success');
}
