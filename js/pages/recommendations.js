// ============================================================
// RECOMMENDATIONS
// ============================================================

let _recPricePollTimer = null;
function _stopRecPoller() {
  if (_recPricePollTimer) { clearInterval(_recPricePollTimer); _recPricePollTimer = null; }
}
function _startRecPoller() {
  _stopRecPoller();
  _recPricePollTimer = setInterval(_refreshRecPrices, 60000);
}
async function _refreshRecPrices() {
  if (!state.serverOk) return;
  const tickers = [...new Set(
    state.recommendations.filter(r => r.status === 'pending').map(r => r.ticker)
  )];
  if (!tickers.length) return;
  await Promise.all(tickers.map(async t => {
    try {
      const d = await fetch(`${API}/api/quote/${encodeURIComponent(t)}`).then(r => r.json());
      if (d?.current_price) {
        if (!state.liveSignals[t]) state.liveSignals[t] = {};
        state.liveSignals[t].current_price = d.current_price;
        if (d.fetched_at) { state.priceTimestamps = state.priceTimestamps || {}; state.priceTimestamps[t] = d.fetched_at; }
      }
    } catch (_) {}
  }));
  if (state.page === 'recommendations') {
    const el = document.getElementById('rec-content');
    const activeTab = document.querySelector('.tab.active')?.id;
    if (el && activeTab === 'tab-pending') {
      el.innerHTML = renderPendingRecs(
        state.recommendations.filter(r => r.status === 'pending' && (r.action||'').toUpperCase() !== 'HOLD')
      );
    }
  }
}

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

function _onAnalysisModelSelect(val) {
  if (val === '__custom__') {
    const inp = document.getElementById('analysis-model-custom');
    if (inp) { inp.style.display = ''; inp.value = state.settings.analysisModel && !['','claude-opus-4-8','claude-haiku-4-5-20251001'].includes(state.settings.analysisModel) ? state.settings.analysisModel : ''; inp.focus(); updateSetting('analysisModel', inp.value.trim()); }
  } else {
    updateSetting('analysisModel', val);
    const inp = document.getElementById('analysis-model-custom');
    if (inp) { inp.style.display = 'none'; inp.value = ''; }
  }
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
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:8px">
          <div>
            <div class="form-label" style="margin-bottom:3px">Claude model</div>
            ${(()=>{
              const _knownM = ['','claude-opus-4-8','claude-haiku-4-5-20251001'];
              const _isCustom = !!(state.settings.analysisModel && !_knownM.includes(state.settings.analysisModel));
              const _selStyle = 'padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-secondary);color:var(--text-primary);font-size:12px;font-family:var(--font)';
              return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                <select id="analysis-model-select" onchange="_onAnalysisModelSelect(this.value)" style="${_selStyle}">
                  <option value="" ${!state.settings.analysisModel?'selected':''}>claude-sonnet-4-6 (default)</option>
                  <option value="claude-opus-4-8" ${state.settings.analysisModel==='claude-opus-4-8'?'selected':''}>claude-opus-4-8 (most capable)</option>
                  <option value="claude-haiku-4-5-20251001" ${state.settings.analysisModel==='claude-haiku-4-5-20251001'?'selected':''}>claude-haiku-4-5 (fastest)</option>
                  <option value="__custom__" ${_isCustom?'selected':''}>Custom…</option>
                </select>
                <input id="analysis-model-custom" type="text"
                  value="${_isCustom?escapeHTML(state.settings.analysisModel):''}"
                  placeholder="e.g. claude-sonnet-4-7"
                  oninput="updateSetting('analysisModel',this.value.trim())"
                  style="${_selStyle};width:200px;${_isCustom?'':'display:none'}"
                  title="Enter the exact model ID from Anthropic's docs"/>
              </div>`;
            })()}
          </div>
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
function _sectorConcentrationWarning(rec) {
  if (!rec.sector || rec.action === 'SELL' || rec.action === 'TRIM') return '';
  const isSameTicker = state.portfolio.some(h => h.ticker === rec.ticker);
  if (isSameTicker) return '';
  const sameSector = state.portfolio.filter(h => h.sector === rec.sector);
  if (!sameSector.length) return '';
  const pv = portfolioValue();
  if (pv <= 0) return '';
  const sectorVal = sameSector.reduce((s, h) => s + h.shares * (h.currentPrice || h.avgPrice), 0);
  const sectorWt = sectorVal / pv * 100;
  const maxSect = Number(state.analysisConfig?.rules?.maxSectorPct) || 30;
  if (sectorWt < maxSect * 0.7) return '';
  const col = sectorWt >= maxSect ? '#dc2626' : '#d97706';
  const bg  = sectorWt >= maxSect ? '#fee2e2' : '#fef3c7';
  const names = sameSector.map(h => h.ticker).join(', ');
  return `<span style="background:${bg};color:${col};border-radius:3px;padding:1px 6px;font-size:10px;font-weight:600;white-space:nowrap" title="Sector ${rec.sector} is ${sectorWt.toFixed(0)}% of portfolio (max ${maxSect}%) via ${names}">⚠ ${rec.sector} ${sectorWt.toFixed(0)}%</span>`;
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
    // Claude's recs are account-blind (built from mergedPortfolio() across all
    // accounts) — if this ticker is actually held in more than one account, we
    // cannot know which one the rec means. Surface an explicit picker rather
    // than silently guessing 'personal' (the old behavior), which was the root
    // cause of Day Trading positions going stale/duplicated when a SELL/TRIM
    // meant for the 'trading' account silently executed against 'personal'.
    const _rTicker = isReducing ? _normTicker(r.ticker) : null;
    const _rAccts = isReducing
      ? [...new Set(state.portfolio.filter(h => _normTicker(h.ticker) === _rTicker).map(h => h.account || 'personal'))]
      : [];
    // Scoped to the single matching account when unambiguous (reuses _rAccts,
    // computed above). When the ticker is held in 2+ accounts, this preview
    // can't know which one the rec means — show nothing rather than silently
    // picking whichever state.portfolio row happens to be first; the actual
    // execution path in markExecuted() resolves the account correctly via
    // the picker, so only this pre-execution preview was ever misleading.
    const holding   = isReducing && _rAccts.length === 1 ? getPortfolioHolding(r.ticker, _rAccts[0]) : null;
    const avgCost   = holding ? holding.avgPrice : null;
    const heldQty   = holding ? holding.shares : 0;
    const qty       = r.qty || 0;
    // Sell price = the lower bound of the AI's priceRange (treat as a limit). If the
    // AI returned a single number or only target, fall back gracefully.
    const sellPrice = r.priceRange?.[0] ?? r.target;

    // Live price from signals cache (updated by price poller every 60s)
    const livePx = state.liveSignals?.[r.ticker]?.current_price ??
                   mergedPortfolio().find(h => h.ticker === r.ticker)?.currentPrice ?? null;
    const livePxBadge = livePx != null
      ? `<span style="font-size:12px;padding:1px 6px;background:var(--bg-secondary);border:0.5px solid var(--border-medium);border-radius:4px;color:var(--text-secondary)">$${fmt(livePx)}</span>`
      : '';
    let entryStatusTag = '';
    if (!isReducing && livePx != null && r.priceRange?.[0] != null && r.priceRange?.[1] != null) {
      const [lo, hi] = r.priceRange;
      if (livePx < lo)
        entryStatusTag = `<span style="font-size:10px;padding:1px 5px;background:#dcfce7;color:#15803d;border-radius:3px">▼ ${fmt(((lo - livePx) / lo) * 100, 1)}% below entry</span>`;
      else if (livePx > hi)
        entryStatusTag = `<span style="font-size:10px;padding:1px 5px;background:#fee2e2;color:#dc2626;border-radius:3px">▲ ${fmt(((livePx - hi) / hi) * 100, 1)}% above entry</span>`;
      else
        entryStatusTag = `<span style="font-size:10px;padding:1px 5px;background:#fef3c7;color:#d97706;border-radius:3px">● In entry range</span>`;
    } else if (isReducing && livePx != null && sellPrice != null) {
      const dist = ((sellPrice - livePx) / livePx) * 100;
      entryStatusTag = dist >= 0
        ? `<span style="font-size:10px;padding:1px 5px;background:#dcfce7;color:#15803d;border-radius:3px">▼ ${fmt(dist, 1)}% to sell target</span>`
        : `<span style="font-size:10px;padding:1px 5px;background:#fee2e2;color:#dc2626;border-radius:3px">▲ ${fmt(Math.abs(dist), 1)}% above target</span>`;
    }

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

    const _warns = Array.isArray(r._ruleWarnings) ? r._ruleWarnings : [];
    return `
    <div class="rec-card" id="rec-${r.id}"${_warns.length ? ' style="border-left:3px solid #dc2626"' : ''}>
      <!-- Header row -->
      <div class="flex-between mb-1">
        <div class="flex-row">${actionBadge(r.action)}${r._confidenceHeld ? '<span class="badge" style="background:#fef2f2;color:#dc2626;border:1px solid #fca5a5;font-weight:700" title="AI confidence is below the minimum threshold — review carefully before executing">⛔ HELD</span>' : ''}<strong style="font-size:15px">${r.ticker}</strong>${livePxBadge}${entryStatusTag}<span class="text-xs">${r.sector||''}</span>${_sectorConcentrationWarning(r)}${r._corrNote?`<span class="badge" style="background:#fef3c7;color:#92400e;border:none" title="${escapeHTML(r._corrNote)}">⚡ Corr</span>`:''}${r._budgetScaled?`<span class="badge" style="background:#fff7ed;color:#c2410c;border:none" title="${escapeHTML(r._budgetNote||'')}">⚠ Budget</span>`:''}${r._preEarningsAdj?`<span class="badge" style="background:#eff6ff;color:#1d4ed8;border:none" title="Stop distance widened 30% — earnings within 14 days">📅 Pre-earnings</span>`:''}${r._varAdjusted?`<span class="badge" style="background:#fef2f2;color:#b91c1c;border:none" title="Position size reduced ${r._varMult===0.5?'50%':'25%'} — VaR1d ${r._varMult===0.5?'< -5.0%':'< -3.5%'} (high-risk ticker)">📉 VaR adj</span>`:''}${r.isWatchlist?'<span class="badge" style="background:#ede9fe;color:#6d28d9;border:none">★ Watchlist</span>':''}${r._source==='local'?'<span class="badge" style="background:#fff7ed;color:#92400e;border:none" title="Generated by local Ollama model — simplified 5-driver taxonomy">🔒 Local</span>':''}${r._stopTrailed?`<span class="badge" style="background:#f0fdf4;color:#15803d;border:1px solid #86efac" title="Stop trailed at ${r._stopTrailedAt||''}">📍 Trailed</span>`:''}<span class="badge badge-pending">Pending</span><span class="text-xs text-muted">Generated ${r.generatedAt||r.date}</span></div>
        <div class="flex-row">
          <button class="btn btn-sm btn-success" onclick="confirmExecute('${r.id}')">✓ Mark Executed</button>
          <button class="btn btn-sm btn-danger" onclick="markSkipped('${r.id}')">✕ Skip</button>
          <button class="btn btn-sm" onclick="trailStop('${r.id}')" title="Trail stop to current price × ATR">📍 Trail</button>
          <button class="btn btn-sm" onclick="showRecTraceability('${r.id}')" title="Why did I get this rec? — full decision trail">ℹ️</button>
        </div>
      </div>

      <!-- Failed-rule review panel: rec kept visible by user decision (2026-06-11);
           Skip if you agree with the rules, or Execute on your own judgment -->
      ${_warns.length ? `
      <div style="margin-top:8px;padding:8px 12px;border-radius:var(--radius-md);background:var(--down-bg, rgba(220,38,38,0.08));border:1px solid rgba(220,38,38,0.35);border-left:3px solid #dc2626">
        <div style="font-size:11px;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:0.5px">
          ⚠ Failed ${_warns.length} rule${_warns.length !== 1 ? 's' : ''} — would have been dropped. Skip, or execute on your own judgment.
        </div>
        <ul style="margin:5px 0 0 16px;font-size:11.5px;color:var(--text-secondary);line-height:1.55">
          ${_warns.map(w => `<li>${escapeHTML(w)}</li>`).join('')}
        </ul>
      </div>` : ''}

      <!-- AI price tiles -->
      <div class="grid-3 mb-1" style="margin-top:10px">${topTiles}</div>

      <!-- Confidence + signals -->
      <div class="flex-row mb-1">
        <div class="conf-bar" style="width:110px"><div class="conf-fill" style="width:${r.confidence*100}%;background:${confColor(r.confidence)}"></div></div>
        <span class="text-xs">${fmt(r.confidence*100,0)}% confidence</span>
        <span class="text-xs text-muted">|</span>
        <span class="text-xs">${qtyLine}</span>
      </div>

      <!-- SELL/TRIM decision tags (primary_driver · secondary_factors · urgency) -->
      ${isReducing && r.primary_driver ? (() => {
        const URGENCY_STYLE = {
          immediate: 'background:#fef2f2;color:#dc2626;border:1px solid #fca5a5',
          routine:   'background:#f0fdf4;color:#16a34a;border:1px solid #86efac',
          monitor:   'background:#fefce8;color:#ca8a04;border:1px solid #fde047',
        };
        const urgencyStyle = URGENCY_STYLE[r.urgency] || 'background:var(--bg-secondary);color:var(--text-secondary);border:1px solid var(--border-light)';
        const secondaryChips = (r.secondary_factors || []).map(t =>
          `<span style="font-size:10px;padding:2px 7px;background:var(--bg-secondary);border:1px solid var(--border-light);border-radius:3px;color:var(--text-secondary)">${t.replace(/_/g,' ')}</span>`
        ).join('');
        const altTickerBadge = r.alternativeTicker
          ? `<span style="font-size:10px;padding:2px 7px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:3px;color:#1d4ed8" title="Redeploy into ${r.alternativeTicker}">→ ${r.alternativeTicker}</span>`
          : '';
        const reallocationLine = r.reallocationSuggestion
          ? `<div style="margin-top:6px;padding:5px 8px;background:var(--bg-inset,var(--bg-secondary));border-radius:4px;border-left:2px solid #60a5fa;font-size:11px;color:var(--text-secondary);display:flex;align-items:flex-start;gap:5px">
              <span style="font-weight:700;color:#3b82f6;white-space:nowrap;flex-shrink:0">↪ Capital:</span>
              <span>${escapeHTML(r.reallocationSuggestion)}</span>
             </div>`
          : '';
        return `
        <div style="padding:7px 10px;background:var(--bg-secondary);border-radius:var(--radius-md);margin-bottom:8px;border-left:3px solid #f59e0b">
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:5px">
            <span style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-right:2px">Sell reason</span>
            <span style="font-size:11px;font-weight:600;padding:2px 8px;background:#fff7ed;border:1px solid #fed7aa;border-radius:3px;color:#c2410c">${r.primary_driver.replace(/_/g,' ')}</span>
            ${secondaryChips}
            ${altTickerBadge}
            <span style="margin-left:auto;font-size:10px;font-weight:600;padding:2px 8px;border-radius:3px;${urgencyStyle}">${r.urgency || '?'}</span>
          </div>
          ${reallocationLine}
        </div>`;
      })() : ''}

      <!-- Thesis Check (SELL/TRIM only — shows when entry context was available) -->
      ${isReducing && r._thesisCheck ? (() => {
        const tc = r._thesisCheck;
        const VERDICT_CONFIG = {
          validated:   { icon: '✅', label: 'Validated',   color: 'var(--up)',           bg: 'var(--up-bg, #f0fdf4)',   border: '#86efac' },
          invalidated: { icon: '❌', label: 'Invalidated', color: 'var(--down)',          bg: 'var(--down-bg, #fef2f2)', border: '#fca5a5' },
          irrelevant:  { icon: '➖', label: 'Irrelevant',  color: 'var(--text-tertiary)', bg: 'var(--bg-inset)',         border: 'var(--border)' },
        };
        const vc = VERDICT_CONFIG[tc.verdict] || VERDICT_CONFIG.irrelevant;
        // Show the first indicator delta pair as "Bought because / Now"
        const deltaKeys = Object.keys(tc.deltas || {});
        const firstKey  = deltaKeys[0];
        const firstDelta = firstKey ? tc.deltas[firstKey] : null;
        const fmt2 = v => v != null ? Number(v).toFixed(2) : '—';
        const entryLabel = firstKey
          ? `${firstKey.replace(/_/g, ' ')}: ${fmt2(firstDelta?.entry)}`
          : (r._entryDriver || 'unknown');
        const nowLabel = firstKey ? fmt2(firstDelta?.now) : '—';
        return `
        <div style="padding:8px 12px;background:${vc.bg};border:1px solid ${vc.border};border-left:3px solid ${vc.color};border-radius:var(--radius-md);margin-bottom:8px;font-size:12px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:10px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px">Thesis Check</span>
            <span style="font-weight:600;color:${vc.color}">${vc.icon} ${vc.label}</span>
          </div>
          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:3px">
            <span style="color:var(--text-secondary)">Bought because: <strong>${escapeHTML(r._entryDriver || 'untagged')}</strong> · Entry: <strong>${escapeHTML(entryLabel)}</strong></span>
            <span style="color:var(--text-secondary)">Now: <strong>${escapeHTML(nowLabel)}</strong></span>
          </div>
          ${tc.reason ? `<div style="color:var(--text-tertiary);font-size:11px">${escapeHTML(tc.reason)}</div>` : ''}
        </div>`;
      })() : ''}

      <!-- Reasoning -->
      <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius-md);font-size:13px;line-height:1.65;margin-bottom:8px">
        <strong>Reasoning:</strong> ${escapeHTML(r.reasoning)}
      </div>

      <!-- Bull / Bear cases -->
      ${(r.bullCase || r.bearCase) ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
        ${r.bullCase ? `<div style="padding:6px 9px;background:var(--up-bg,rgba(22,163,74,0.08));border:1px solid rgba(22,163,74,0.3);border-radius:var(--radius-md);font-size:11.5px;color:var(--text-secondary)">
          <span style="font-weight:700;color:var(--up,#16a34a);display:block;margin-bottom:2px;font-size:10px;text-transform:uppercase;letter-spacing:0.4px">▲ Bull case</span>
          ${escapeHTML(r.bullCase)}
        </div>` : '<div></div>'}
        ${r.bearCase ? `<div style="padding:6px 9px;background:var(--down-bg,rgba(220,38,38,0.06));border:1px solid rgba(220,38,38,0.25);border-radius:var(--radius-md);font-size:11.5px;color:var(--text-secondary)">
          <span style="font-weight:700;color:var(--down,#dc2626);display:block;margin-bottom:2px;font-size:10px;text-transform:uppercase;letter-spacing:0.4px">▼ Bear case</span>
          ${escapeHTML(r.bearCase)}
        </div>` : '<div></div>'}
      </div>` : ''}

      <!-- Scenarios (bull/base/bear p% + expected return) -->
      ${r.scenarios && r.scenarios.bull && r.scenarios.base && r.scenarios.bear ? (() => {
        const sc = r.scenarios;
        const fmtPct = v => v != null ? (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%' : '—';
        const fmtP   = v => v != null ? Math.round(v * 100) + '%' : '?';
        const scCell = (label, data, color, bg) =>
          `<div style="text-align:center;padding:5px 4px;background:${bg};border-radius:4px">
            <div style="font-size:9px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.5px">${label}</div>
            <div style="font-size:13px;font-weight:700;color:${color};margin:1px 0">${fmtPct(data.ret)}</div>
            <div style="font-size:10px;color:var(--text-muted)">${fmtP(data.p)} prob</div>
          </div>`;
        return `
        <div style="margin-bottom:8px">
          <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">12-month scenarios</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px">
            ${scCell('Bull',sc.bull,'#15803d','var(--up-bg,rgba(22,163,74,0.08))')}
            ${scCell('Base',sc.base,'var(--text-secondary)','var(--bg-secondary)')}
            ${scCell('Bear',sc.bear,'#dc2626','var(--down-bg,rgba(220,38,38,0.06))')}
          </div>
        </div>`;
      })() : ''}

      <!-- Invalidation condition -->
      ${r.invalidationCondition ? `
      <div style="display:flex;align-items:flex-start;gap:7px;padding:6px 10px;background:rgba(217,119,6,0.07);border:1px solid rgba(217,119,6,0.35);border-radius:var(--radius-md);margin-bottom:8px;font-size:11.5px;color:var(--text-secondary)">
        <span style="font-weight:700;color:#d97706;white-space:nowrap;flex-shrink:0;font-size:10px;text-transform:uppercase;letter-spacing:0.4px;padding-top:1px">⚡ Invalidated if</span>
        <span>${escapeHTML(r.invalidationCondition)}</span>
      </div>` : ''}

      ${r.risks?`<div class="text-xs text-muted mb-1"><strong>Risks:</strong> ${escapeHTML(r.risks)}</div>`:''}
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
        ${_rAccts.length > 1 ? `
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:12px;color:#f59e0b;font-weight:600;white-space:nowrap">⚠ Account</label>
          <select id="exec-acct-${r.id}"
            style="padding:4px 8px;border:1.5px solid #f59e0b;border-radius:6px;font-size:12px;font-weight:600;background:var(--bg-primary);color:var(--text-primary)"
            title="${r.ticker} is held in multiple accounts — pick which one this ${r.action} applies to">
            ${_rAccts.map(a => `<option value="${escapeHTML(a)}">${escapeHTML(a)}</option>`).join('')}
          </select>
        </div>` : ''}
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

      <!-- Tags (for Learning Loop) -->
      <div style="display:flex;gap:8px;align-items:center;padding-top:6px">
        <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;flex-shrink:0">Tags:</span>
        <input type="text" id="tags-${r.id}" placeholder="e.g. breakout, earnings, dip-buy (comma-separated)" value="${r._tags||''}"
          style="flex:1;padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-light);background:var(--bg-secondary);color:var(--text-primary);font-size:11px;font-family:var(--font)"
          title="Trade tags for performance filtering">
      </div>
      <!-- Thesis capture -->
      <div style="display:flex;gap:8px;align-items:flex-start;padding-top:6px">
        <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;flex-shrink:0;padding-top:5px">Thesis:</span>
        <textarea id="thesis-${r.id}" rows="2" placeholder="Write your investment thesis — what needs to stay true for this trade to work?"
          oninput="persistExecField('${r.id}','_thesis',this.value)"
          style="flex:1;padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-light);background:var(--bg-secondary);color:var(--text-primary);font-size:11px;font-family:var(--font);resize:vertical"
          title="Investment thesis — reviewed at trade exit">${escapeHTML(r._thesis||'')}</textarea>
      </div>
      <!-- Why this rec? traceability panel -->
      ${(() => {
        const hasContext = r._genRegime || r._signalsSnap || r._calibSnap;
        if (!hasContext) return '';
        const regimeLine = r._genRegime ? `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span style="font-weight:600;color:var(--text-secondary)">Regime</span>
          <span style="padding:1px 7px;background:var(--bg-secondary);border:0.5px solid var(--border-light);border-radius:3px">${r._genRegime}</span>
          ${r._genRegimeConf != null ? `<span class="text-muted">${fmt(r._genRegimeConf*100,0)}% conf</span>` : ''}
        </div>` : '';
        let sigLines = '';
        if (r._signalsSnap) {
          const s = r._signalsSnap;
          const cells = [
            s.rsi_14    != null ? `RSI ${fmt(s.rsi_14,1)}` : null,
            s.adx       != null ? `ADX ${fmt(s.adx,1)}` : null,
            s.bb_pctb   != null ? `BB%B ${fmt(s.bb_pctb,2)}` : null,
            s.atr_14    != null ? `ATR $${fmt(s.atr_14,3)}` : null,
            s.score     != null ? `Score ${Math.round(s.score)}/100` : null,
            s.obv_trend != null ? `OBV ${s.obv_trend}` : null,
            s.macd_signal != null ? `MACD ${s.macd_signal}` : null,
            s.volume_ratio != null ? `Vol×${fmt(s.volume_ratio,1)}` : null,
            s.rs_score  != null ? `RS ${fmt(s.rs_score,0)}` : null,
          ].filter(Boolean);
          if (cells.length) {
            sigLines = `<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
              <span style="font-weight:600;color:var(--text-secondary)">Signals</span>
              ${cells.map(c=>`<span style="padding:1px 7px;background:var(--bg-secondary);border:0.5px solid var(--border-light);border-radius:3px">${c}</span>`).join('')}
            </div>`;
          }
        }
        const calibLine = r._calibSnap ? `<div style="color:var(--text-muted);font-family:monospace;font-size:10px;background:var(--bg-secondary);padding:5px 8px;border-radius:3px;white-space:pre-wrap;word-break:break-word;max-height:80px;overflow-y:auto">
          <span style="font-weight:600;font-family:var(--font)">Calibration:</span> ${escapeHTML(r._calibSnap)}</div>` : '';
        let debateLine = '';
        if (typeof _getCachedDebate === 'function') {
          const sig = state.liveSignals && state.liveSignals[r.ticker];
          const d = sig ? _getCachedDebate(r.ticker, sig) : null;
          if (d && d.bull && d.bear) {
            const synth = d.synthesis?.winner ? `[${d.synthesis.winner.toUpperCase()}] ` : '';
            const snippet = synth + (d.synthesis?.key_pivot || (d.bull.slice(0,80) + '…'));
            debateLine = `<div style="color:var(--text-secondary);background:var(--bg-secondary);padding:5px 8px;border-radius:3px;font-size:10px;border-left:2px solid #7c3aed">
              <span style="font-weight:600;font-size:11px">Debate (${d.model||'?'}): </span>${escapeHTML(snippet)}</div>`;
          }
        }
        return `
        <details style="margin-top:8px;border-top:0.5px solid var(--border-light);padding-top:6px">
          <summary style="font-size:11px;color:var(--text-muted);cursor:pointer;user-select:none;list-style:none;display:flex;align-items:center;gap:5px">
            <span style="transition:transform 0.15s" class="trace-arrow">▶</span> 🔍 Why this rec? (generation context)
          </summary>
          <div style="margin-top:7px;display:grid;gap:6px;font-size:11px" onclick="event.stopPropagation()">
            ${regimeLine}${sigLines}${calibLine}${debateLine}
          </div>
        </details>`;
      })()}

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
    <div class="table-wrap"><table class="tbl-stack">
      <thead><tr><th style="width:16px"></th><th>Date</th><th>Ticker</th><th>Action</th><th>Confidence</th><th>Target / Stop</th><th>Status</th><th>Outcome</th><th>Actual P&L</th></tr></thead>
      <tbody>
        ${filtered.map((r)=>{
          const realIdx = state.recHistory.indexOf(r);
          const detId = 'hdet-' + r.id;
          const hasDetail = !!(r.reasoning || r.scenarios || r.bullCase || r.bearCase || r.reallocationSuggestion || r.invalidationCondition);
          const regBadge = r.regime ? `<span class="badge" style="font-size:10px;background:var(--bg-inset,#f3f4f6);color:var(--text-secondary)">${r.regime}</span>` : '';
          const scenHtml = r.scenarios ? (() => {
            const keys = ['bull','base','bear'];
            return '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px">'
              + keys.map(k => { const s = r.scenarios[k]; if (!s) return '';
                const col = k==='bull'?'var(--up,#15803d)':k==='bear'?'var(--down,#b91c1c)':'var(--text-secondary)';
                return `<div style="background:var(--bg-inset,#f3f4f6);border-radius:4px;padding:6px 8px;text-align:center"><div style="font-size:10px;font-weight:700;color:${col};text-transform:uppercase">${k}</div><div style="font-size:12px;font-weight:600;color:var(--text-primary)">${s.p!=null?Math.round(s.p*100)+'%':'?'}</div><div style="font-size:11px;color:var(--text-secondary)">${s.ret!=null?(s.ret>=0?'+':'')+fmt(s.ret,0)+'%':'?'}</div></div>`; }).join('')
              + '</div>';
          })() : '';
          const mkSection = (label, col, txt) => txt ? `<div style="margin-bottom:6px"><span style="font-size:10px;font-weight:700;color:${col};text-transform:uppercase">${label}</span><div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${escapeHTML(txt)}</div></div>` : '';
          const reasonHtml = r.reasoning ? `<div style="margin-bottom:6px"><span style="font-size:10px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase">Reasoning</span><div style="font-size:12px;color:var(--text-primary);margin-top:2px;line-height:1.55">${escapeHTML(reasoningText(r.reasoning))}</div></div>` : '';
          const fbHtml = `<div style="margin-top:10px;display:flex;gap:6px;align-items:center">
              <span class="text-xs text-muted" style="white-space:nowrap">Feedback:</span>
              <input type="text" id="hfb-${realIdx}" value="${r.feedback||''}" placeholder="Add feedback..."
                onclick="event.stopPropagation()"
                style="flex:1;padding:3px 7px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:11px;font-family:var(--font)">
              <button class="btn btn-sm" onclick="addHistoryFeedback(${realIdx});event.stopPropagation()" title="Save">&#x2713;</button>
            </div>${r.feedback?`<div class="text-xs text-muted" style="margin-top:3px">&#x1F4AC; ${r.feedback}</div>`:''}`;
          return `<tr onclick="toggleHistDetail('${detId}')" style="cursor:pointer">
            <td style="padding:6px 4px;color:var(--text-tertiary);font-size:11px;text-align:center">${hasDetail?'&#9654;':''}</td>
            <td data-label="Date" class="text-xs">${r.date}</td>
            <td data-label="Ticker"><strong>${r.ticker}</strong> ${regBadge}</td>
            <td data-label="Action">${actionBadge(r.action)}</td>
            <td data-label="Confidence"><div class="flex-row"><div class="conf-bar" style="width:50px"><div class="conf-fill" style="width:${(r.confidence||0)*100}%;background:${confColor(r.confidence||0)}"></div></div><span class="text-xs">${fmt((r.confidence||0)*100,0)}%</span></div></td>
            <td data-label="Target/Stop" class="text-xs">${r.target?'$'+fmt(r.target):'&mdash;'} / ${r.stopLoss?'$'+fmt(r.stopLoss):'&mdash;'}</td>
            <td data-label="Status">${statusBadge(r.executed?'executed':'skipped')}${r._stopWidened?`<span class="badge" style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;margin-left:4px" title="Stop widened: $${(r._stopWidenedFrom??0).toFixed(2)} to $${(r.stopLoss??0).toFixed(2)}">↔ Widened</span>`:''}</td>
            <td data-label="Outcome" class="text-xs ${r.outcome==='win'?'text-success':r.outcome==='loss'?'text-danger':'text-muted'}">${r.outcome==='win'?'&#x2713; Win':r.outcome==='loss'?'&#x2717; Loss':r.outcome||'&mdash;'}</td>
            <td data-label="Actual P&L" class="${r.actualProfit!=null?(r.actualProfit>=0?'text-success':'text-danger'):'text-muted'}">${r.actualProfit!=null?(r.actualProfit>=0?'+':'-')+'$'+fmt(Math.abs(r.actualProfit)):'&mdash;'}</td>
          </tr>
          <tr id="${detId}" style="display:none;background:var(--bg-secondary)">
            <td colspan="9" style="padding:10px 16px 14px">
              ${scenHtml}
              ${mkSection('Bull case','var(--up,#15803d)',r.bullCase)}${mkSection('Bear case','var(--down,#b91c1c)',r.bearCase)}${mkSection('Reallocation','var(--text-tertiary)',r.reallocationSuggestion)}${mkSection('Invalidated if','#d97706',r.invalidationCondition)}
              ${reasonHtml}
              ${fbHtml}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>`}
  </div>`;
}
function toggleHistDetail(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const isOpen = el.style.display !== 'none';
  el.style.display = isOpen ? 'none' : '';
  const row = el.previousElementSibling;
  if (row) { const arrow = row.querySelector('td:first-child'); if (arrow) arrow.textContent = isOpen ? '▶' : '▼'; }
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
  const acctEl  = document.getElementById(`exec-acct-${recId}`);
  const qty   = parseInt(qtyEl?.value);
  const price = parseFloat(priceEl?.value);
  const fee   = parseFloat(feeEl?.value ?? state.settings.brokerage);
  const acct  = acctEl?.value || undefined;   // only present when the ticker is held in >1 account
  if (isNaN(qty)   || qty <= 0)  { toast('Enter a valid quantity (shares)', 'error'); qtyEl?.focus(); return; }
  if (isNaN(price) || price <= 0){ toast('Enter a valid execution price', 'error'); priceEl?.focus(); return; }
  if (isNaN(fee)   || fee < 0)   { toast('Enter a valid brokerage fee', 'error'); feeEl?.focus(); return; }
  _showPreTradeChecklist(recId, () => markExecuted(recId, price, fee, qty, acct));
}

function _showPreTradeChecklist(recId, onConfirm) {
  // Remove any previous dialog
  document.getElementById('pre-trade-dialog')?.remove();

  const rec = state.recommendations.find(r => r.id === recId);
  const isReducing = rec && (rec.action === 'SELL' || rec.action === 'TRIM');

  // ── Confidence-floor breach: dedicated hard gate, not just one of six items ──
  // Matches the exact warning string built in analysis.js (~line 1210-1211).
  const lowConfWarning = (rec && Array.isArray(rec._ruleWarnings))
    ? rec._ruleWarnings.find(w => /below the \d+% floor/.test(w))
    : null;
  let lowConfBanner = '';
  if (lowConfWarning) {
    const floorPct = (100 * (state.analysisConfig.rules?.minConfidence ?? 0.62)).toFixed(0);
    const confPct  = (100 * (rec.confidence || 0)).toFixed(0);
    lowConfBanner = `<div style="background:#fee2e2;border:2px solid #dc2626;border-radius:6px;padding:10px 12px;margin-bottom:12px">
      <div style="font-size:13px;font-weight:800;color:#991b1b;text-transform:uppercase;letter-spacing:0.3px">⚠ Below Confidence Floor</div>
      <div style="font-size:12px;color:#991b1b;margin-top:4px;line-height:1.5">
        This rec's calibration-adjusted confidence is <strong>${confPct}%</strong>, below the system's <strong>${floorPct}%</strong> floor.
        Recs in this range have historically underperformed — executing means overriding that empirical signal on your own judgment.
      </div>
    </div>`;
  }

  // CGT warning: check if any parcel for this ticker is within 45 days of 12-month mark
  let cgtWarning = '';
  if (isReducing && rec) {
    const today = new Date();
    const liveParcels = (state.cgtParcels || []).filter(p =>
      p.ticker === rec.ticker && p.remainingQty > 0
    );
    const urgentParcels = liveParcels.filter(p => {
      if (!p.date) return false;
      const [dd, mm, yyyy] = p.date.split('-').map(Number);
      const buyDate = new Date(yyyy, mm - 1, dd);
      const heldDays = Math.floor((today - buyDate) / 86400000);
      return heldDays >= 320 && heldDays < 365;
    });
    if (urgentParcels.length) {
      const minDays = urgentParcels.reduce((min, p) => {
        const [dd, mm, yyyy] = p.date.split('-').map(Number);
        const buyDate = new Date(yyyy, mm - 1, dd);
        const held = Math.floor((today - buyDate) / 86400000);
        return Math.min(min, 365 - held);
      }, 365);
      cgtWarning = `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#92400e">
        <strong>⚠ CGT Discount Warning</strong><br>
        Selling ${rec.ticker} now will crystallise full-rate CGT. <strong>${minDays} day(s)</strong> until the 50% discount applies on ${urgentParcels.length} parcel(s).
      </div>`;
    }
  }

  const items = [
    { id: 'chk-thesis',   label: 'I have a written thesis / reason for this trade' },
    { id: 'chk-catalyst', label: 'I\'ve identified the catalyst or trigger' },
    { id: 'chk-stop',     label: 'Stop loss is set and within my risk tolerance' },
    { id: 'chk-size',     label: 'Position size is within my risk budget' },
    { id: 'chk-avg',      label: isReducing
        ? 'I\'m not exiting in panic — the thesis has actually changed'
        : 'I\'m not averaging into a losing position without a plan' },
    { id: 'chk-reason',   label: isReducing
        ? 'This exit is to harvest profits or manage risk — not panic or FOMO'
        : 'This entry fits a planned strategy — not FOMO or impulse buying' },
  ];

  const lowConfItemId = 'chk-low-conf-ack';
  const lowConfItemHtml = lowConfWarning ? `
    <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px;background:#fee2e2;border:1px solid #dc2626;border-radius:6px;padding:8px 10px">
      <input type="checkbox" id="${lowConfItemId}" onchange="_updateChecklistBtn()" style="margin-top:2px;width:16px;height:16px;flex-shrink:0">
      <span style="font-weight:600;color:#991b1b">I understand this recommendation's confidence is below the system floor and am executing on my own judgment, not the AI's.</span>
    </label>` : '';

  const dialog = document.createElement('dialog');
  dialog.id = 'pre-trade-dialog';
  dialog.dataset.lowConf = lowConfWarning ? '1' : '0';
  dialog.style.cssText = 'padding:0;border:none;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.35);background:var(--bg-primary);color:var(--text-primary);max-width:440px;width:90vw';
  dialog.innerHTML = `
    <div style="padding:20px 22px">
      <div style="font-size:15px;font-weight:700;margin-bottom:4px">Pre-Trade Checklist</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">${rec ? rec.action + ' ' + rec.ticker : ''} — tick at least 4 to proceed</div>
      ${lowConfBanner}
      ${cgtWarning}
      <div id="checklist-items" style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
        ${items.map(it => `
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="${it.id}" onchange="_updateChecklistBtn()" style="margin-top:2px;width:16px;height:16px;flex-shrink:0">
            <span>${it.label}</span>
          </label>`).join('')}
        ${lowConfItemHtml}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="document.getElementById('pre-trade-dialog').close()" class="btn btn-sm">Cancel</button>
        ${lowConfWarning ? '' : '<button id="checklist-override-btn" onclick="_checklistProceed(\'override\')" class="btn btn-sm" style="color:var(--text-muted)">Proceed anyway</button>'}
        <button id="checklist-confirm-btn" onclick="_checklistProceed('confirm')" class="btn btn-sm btn-success" disabled>✓ Execute Trade</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);

  // Store callback so the close handlers can call it
  dialog._onConfirm = onConfirm;
  dialog.showModal();
  _updateChecklistBtn();
}

// ── §9.4: "Why did I get this rec?" traceability modal ────────────────────────
// Pure UI assembly — every input already lives on the rec object as an audit
// field written by the pipeline (calibration, quant engine, validator, gates).
function showRecTraceability(recId) {
  const r = (state.recommendations || []).find(x => x.id === recId)
         || (state.recHistory || []).find(x => x.id === recId);
  if (!r) { toast('Rec not found', 'error'); return; }

  const row = (label, value) => value == null || value === '' ? '' :
    `<div style="display:flex;gap:10px;padding:3px 0;font-size:12px">
       <span style="flex:0 0 150px;color:var(--text-muted)">${label}</span>
       <span style="flex:1;min-width:0;word-break:break-word">${value}</span>
     </div>`;
  const section = (title, rowsHtml) => !rowsHtml ? '' :
    `<div style="margin-bottom:12px">
       <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-tertiary);margin-bottom:4px;border-bottom:0.5px solid var(--border-light);padding-bottom:3px">${title}</div>
       ${rowsHtml}</div>`;
  const list = arr => Array.isArray(arr) && arr.length
    ? `<ul style="margin:0 0 0 14px;padding:0">${arr.map(x => `<li>${escapeHTML(String(x))}</li>`).join('')}</ul>` : null;
  const pct = v => v != null ? `${(v * 100).toFixed(0)}%` : null;

  const origConf = r._calibApplied?.orig ?? r.confidence;
  const genRows =
    row('Generated', `${r.generatedAt || r.date || ''}${r.regime ? ` · regime: <strong>${r.regime}</strong>` : ''}`) +
    row('Source', r._source === 'local' ? '🔒 Local Ollama model' : 'Claude (tool-schema output)') +
    row('Action', `${r.action} ${r.ticker}${r.isWatchlist ? ' ★watchlist' : ''}`);
  const confRows =
    row('Claude confidence', pct(origConf)) +
    (r._calibApplied
      ? row('Calibration applied', `${r._calibApplied.adj > 0 ? '+' : ''}${(r._calibApplied.adj * 100).toFixed(0)}pp (band ${r._calibApplied.band || '—'}) → ${pct(r.confidence)}`)
      : '') +
    row('Ensemble (½AI + ½indicator)', pct(r.ensembleConfidence));
  const sizingRows =
    row('Quant engine', r._quantEngine
      ? `qty=${r.qty}${r._constraintBinding ? ` · binding constraint: ${r._constraintBinding}` : ''}`
      : (r._fallbackSized
        ? `declined — fallback min-trade sizing applied (qty=${r.qty}; see warnings)`
        : (r._exitSized ? null : 'AI values kept (engine skipped)'))) +
    row('Exit sizing', r._exitSized ? (r._exitSized === 'full' ? 'SELL — full holding' : `TRIM — ${r._exitSized} of holding (weightGuidance midpoint)`) : null) +
    row('Risk / reward', r.riskAUD != null ? `$${fmt(r.riskAUD)} / $${fmt(r.rewardAUD)} (R:R ${r.rrRatio ?? '—'})` : null) +
    row('Pre-earnings widen', r._preEarningsAdj ? 'stop ×1.3 — earnings ≤14d' : null) +
    row('Correlation', r._corrNote || null) +
    row('Heat budget', r._budgetScaled ? (r._budgetNote || 'scaled to fit risk budget') : null) +
    row('VaR adjustment', r._varAdjusted ? `qty ×${r._varMult} (VaR1d ${r._varMult === 0.5 ? '< −5.0%' : '< −3.5%'})` : null) +
    row('Stop repaired', r._stopRepaired ? `ATR floor applied (${r._stopRepairedMult}×ATR)` : null) +
    row('Stop widened', r._stopWidened ? `$${(r._stopWidenedFrom ?? 0).toFixed(2)} → $${(r.stopLoss ?? 0).toFixed(2)} (${r._stopWidenedRegime} regime)` : null) +
    row('Stop trailed', r._stopTrailed ? `at ${(r._stopTrailedAt || '').slice(0, 16)}` : null);
  const validatorRows =
    row('Auto-repairs', list(r._validatorFixed)) +
    row('Rule warnings', list(r._ruleWarnings)) +
    row('Driver mention', r._driverMentionAppended ? 'appended to reasoning by validator' : null);
  const thesisRows =
    row('Factors used', list(r.factorsUsed)) +
    row('Reasoning', r.reasoning ? escapeHTML(r.reasoning) : null) +
    row('Invalidation', r.invalidationCondition ? escapeHTML(r.invalidationCondition) : null) +
    row('Bear case', r.bearCase ? escapeHTML(r.bearCase) : null) +
    (r.primary_driver ? row('Exit tags', `${r.primary_driver}${Array.isArray(r.secondary_factors) && r.secondary_factors.length ? ' · ' + r.secondary_factors.join(', ') : ''}${r.urgency ? ' · ' + r.urgency : ''}`) : '');

  const dialog = document.createElement('dialog');
  dialog.id = 'rec-trace-dialog';
  dialog.style.cssText = 'padding:0;border:none;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.35);background:var(--bg-primary);color:var(--text-primary);max-width:560px;width:92vw';
  dialog.innerHTML = `
    <div style="padding:18px 20px">
      <div class="flex-between" style="margin-bottom:12px">
        <div style="font-size:15px;font-weight:700">ℹ️ Why this rec — ${r.action} ${r.ticker}</div>
        <button class="btn btn-sm" onclick="document.getElementById('rec-trace-dialog').close()">✕</button>
      </div>
      ${section('Generation', genRows)}
      ${section('Confidence trail', confRows)}
      ${section('Sizing & risk gates', sizingRows)}
      ${section('Validator', validatorRows)}
      ${section('Thesis', thesisRows)}
    </div>`;
  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
}

function _updateChecklistBtn() {
  const dialog = document.getElementById('pre-trade-dialog');
  if (!dialog) return;
  const checked = dialog.querySelectorAll('input[type=checkbox]:checked').length;
  const btn = document.getElementById('checklist-confirm-btn');
  const isLowConf = dialog.dataset.lowConf === '1';
  let ok = checked >= 4;
  if (isLowConf) {
    const lowConfChecked = !!document.getElementById('chk-low-conf-ack')?.checked;
    ok = ok && lowConfChecked;
  }
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '0.5';
}

function _checklistProceed(mode) {
  const dialog = document.getElementById('pre-trade-dialog');
  // Confidence-floor breach: the dedicated acknowledgment checkbox is a
  // non-negotiable gate — there is no override path that skips it (the
  // "Proceed anyway" button is not even rendered in this case, but guard
  // here too in case mode==='override' is ever reachable for this rec).
  if (dialog?.dataset.lowConf === '1') {
    const ackChecked = !!document.getElementById('chk-low-conf-ack')?.checked;
    if (!ackChecked) {
      toast('You must tick the confidence-floor acknowledgment before executing this trade', 'error');
      return;
    }
  }
  const cb = dialog?._onConfirm;
  dialog?.close();
  dialog?.remove();
  if (cb) cb();
}

// _detectExitReason is defined in utils.js (single canonical copy)

function _showThesisReview(thesisText, learningId, ticker) {
  document.getElementById('thesis-review-dialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'thesis-review-dialog';
  dialog.style.cssText = 'padding:0;border:none;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.35);background:var(--bg-primary);color:var(--text-primary);max-width:420px;width:90vw';
  dialog.innerHTML = `
    <div style="padding:20px 22px">
      <div style="font-size:15px;font-weight:700;margin-bottom:4px">Thesis Review — ${ticker}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Now that the position is closed, was your original thesis correct?</div>
      <div style="background:var(--bg-secondary);border-left:3px solid #3b82f6;padding:10px 12px;border-radius:4px;font-size:12px;line-height:1.6;margin-bottom:16px;font-style:italic">"${escapeHTML(thesisText)}"</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="tr-held"    class="btn btn-sm btn-success"  style="flex:1">✓ Thesis Held</button>
        <button id="tr-partial" class="btn btn-sm"              style="flex:1;background:#d97706;color:#fff;border-color:#d97706">⚡ Partially</button>
        <button id="tr-broken"  class="btn btn-sm btn-danger"   style="flex:1">✗ Thesis Broken</button>
      </div>
      <div style="text-align:right;margin-top:10px">
        <button class="btn btn-sm" onclick="document.getElementById('thesis-review-dialog')?.remove()">Skip</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  dialog.showModal();
  const submit = verdict => {
    dialog.remove();
    if (!learningId || !state.serverOk) return;
    const noteTag = verdict === 'held' ? '[THESIS: held ✓]' : verdict === 'partial' ? '[THESIS: partial ⚡]' : '[THESIS: broken ✗]';
    fetch(`${API}/api/learning/outcome`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: learningId, notes: `${noteTag} ${thesisText.slice(0, 200)}` }),
    }).catch(() => {});
  };
  dialog.querySelector('#tr-held').onclick    = () => submit('held');
  dialog.querySelector('#tr-partial').onclick = () => submit('partial');
  dialog.querySelector('#tr-broken').onclick  = () => submit('broken');
}

function trailStop(recId) {
  const rec = state.recommendations.find(r => r.id === recId);
  if (!rec) return;

  const signals = state.liveSignals?.[rec.ticker];
  const price = signals?.current_price || rec.priceRange?.[0];
  const atr = signals?.atr_14;

  if (!price || !atr) {
    toast(`No live price/ATR for ${rec.ticker} — refresh signals first`, 'error');
    return;
  }

  const regime = state.currentRegime?.regime || 'sideways';
  const mod = getRegimeModifiers(regime);
  const mult = mod.stopAtrMult ?? 2.5;

  const isBuy = rec.action === 'BUY' || rec.action === 'TOP_UP';
  const newStop = isBuy
    ? +(price - mult * atr).toFixed(4)
    : +(price + mult * atr).toFixed(4);

  const wouldTighten = isBuy
    ? newStop > rec.stopLoss
    : newStop < rec.stopLoss;

  if (!wouldTighten) {
    toast(`Stop already tighter than ${mult}×ATR trail (current $${rec.stopLoss.toFixed(3)} vs trail $${newStop.toFixed(3)})`);
    return;
  }

  const confirmed = confirm(
    `Trail stop for ${rec.ticker} ${rec.action}:\n` +
    `  Current stop: $${rec.stopLoss.toFixed(3)}\n` +
    `  New stop:     $${newStop.toFixed(3)} (${mult}×ATR @ $${price.toFixed(3)})\n\n` +
    `Proceed?`
  );
  if (!confirmed) return;

  rec.stopLoss = newStop;
  if (rec.target) {
    const stopDist = Math.abs(price - newStop);
    const targetDist = Math.abs(rec.target - price);
    rec.rrRatio = stopDist > 0 ? +(targetDist / stopDist).toFixed(2) : null;
  }
  rec._stopTrailed = true;
  rec._stopTrailedAt = new Date().toISOString();

  scheduleSave();
  renderPage();
  toast(`Stop trailed to $${newStop.toFixed(3)} for ${rec.ticker}`);
}

// Snapshot live technicals at fill time — shared shape for both the BUY/TOP_UP
// entry capture and the SELL/TRIM exit capture, so the Journal drawer can show
// an entry→exit delta on the same fields. Returns null when no live signal
// data is available for the ticker (e.g. manual import, signals never fetched).
function _snapshotLiveTechnicals(ticker, tradePrice) {
  const s = state.liveSignals?.[ticker] || {};
  if (s.rsi_14 == null) return null;
  return {
    rsi_14:       s.rsi_14       ?? null,
    bb_pct_b:     s.bb_pct_b     ?? null,
    adx_14:       s.adx          ?? s.adx_14 ?? null,
    atr_pct:      s.atr_pct      ?? null,
    return_5d:    s.return_5d    ?? null,
    return_20d:   s.return_20d   ?? null,
    setup_score:  s.score        ?? null,
    macd_hist:    s.macd_hist    ?? null,
    sector_rs_5d: s.sector_rs_5d ?? null,
    price:        parseFloat(tradePrice.toFixed(3)),
  };
}

async function markExecuted(id, execPrice, execFee, execQty, execAccount) {
  const rec = state.recommendations.find(r => r.id === id); if(!rec) return;

  // Immediately mark button as executed so the card looks settled before renderPage fires
  const _execBtn = document.querySelector(`button[onclick="confirmExecute('${id}')"]`);
  if (_execBtn) {
    _execBtn.textContent = '✓ Executed';
    _execBtn.disabled = true;
    _execBtn.classList.remove('btn-success');
    _execBtn.style.cssText += ';opacity:0.55;cursor:default';
  }

  const time = nowSydney();
  const today = todayStr();
  rec.status = 'executed';
  rec.executedAt = time;

  // Capture tags + thesis from inline inputs before the DOM changes
  const tagsVal = (document.getElementById(`tags-${id}`)?.value || '').trim();
  if (tagsVal) rec._tags = tagsVal;
  const thesisVal = (document.getElementById(`thesis-${id}`)?.value || '').trim();
  if (thesisVal) rec._thesis = thesisVal;

  const qty        = (execQty  !== undefined && !isNaN(execQty)  && execQty  > 0) ? execQty  : (rec.qty || 10);
  const fees       = (execFee  !== undefined && !isNaN(execFee))                  ? execFee  : state.settings.brokerage;
  const tradePrice = (execPrice !== undefined && !isNaN(execPrice) && execPrice > 0) ? execPrice : (rec.priceRange?.[0] ?? 0);
  const isReducing = rec.action === 'SELL' || rec.action === 'TRIM';

  // Ensure live signals are available before snapshotting — state.liveSignals
  // is only ever populated lazily by whichever page/scan the user last visited
  // (Live Signals, Watchlist, Scanner, Day Trading scan), not proactively for
  // the whole portfolio. Without this fallback, a ticker that simply wasn't
  // covered by the user's last visit (e.g. FMG/BHP after a banks-only scan)
  // would silently record a null entrySignals/exitSignals snapshot. Mirrors
  // the same fallback already used by executeDayTrade()/executeIntradayTrade().
  if (!state.liveSignals?.[rec.ticker]?.rsi_14) {
    try {
      const _sigR = await fetch(`${API}/api/analyse/${encodeURIComponent(rec.ticker)}`);
      if (_sigR.ok) {
        const _sigD = await _sigR.json();
        if (!state.liveSignals) state.liveSignals = {};
        state.liveSignals[rec.ticker] = { ...(_sigD || {}), ...state.liveSignals[rec.ticker] };
      }
    } catch { /* offline — proceed without signals; snapshot will be null */ }
  }

  // Same fallback for regime — a trade executed before the Dashboard's
  // background fetchAndClassifyRegime() call has resolved this session (e.g.
  // the very first trade of the day) would otherwise record a null regime.
  if (!state.currentRegime && typeof fetchAndClassifyRegime === 'function') {
    try { await fetchAndClassifyRegime(); } catch { /* offline — proceed without regime */ }
  }

  // Regime live at the moment this transaction is actually filled — distinct
  // from rec._genRegime (stamped at generation time, possibly days earlier for
  // a rec that sat pending). Prefers the live classifier state; falls back to
  // the last-known string cache (set during the most recent AI analysis run)
  // if the live read is for some reason unavailable.
  const execRegime = (state.currentRegime && state.currentRegime.regime)
    || (typeof state._lastRegime === 'string' ? state._lastRegime : null);

  let tradeEntry;
  let realizedPnl = null;   // will be set for SELL/TRIM when holding exists

  // Determine which account's holding this SELL/TRIM applies to. The rec itself
  // carries no account marker (analysis.js builds recs from mergedPortfolio()
  // across all accounts without tagging one back on). Ticker matching is
  // normalized (_normTicker strips an optional ".AX" suffix and uppercases) —
  // Claude's response-validator regex permits ".AX", and matching the raw
  // value against state.portfolio's always-bare tickers used to silently find
  // zero accounts, falling through to the wrong default below.
  const _matchingHoldings = state.portfolio.filter(h => _normTicker(h.ticker) === _normTicker(rec.ticker));
  const _distinctAccts = [...new Set(_matchingHoldings.map(h => h.account || 'personal'))];
  let sellAccount;
  if (execAccount && _distinctAccts.includes(execAccount)) {
    // Explicit choice from the rec card's account picker (rendered whenever
    // _distinctAccts.length > 1) — always trust this over any guess, since
    // only the user actually knows which account this rec was meant to close.
    sellAccount = execAccount;
  } else if (_distinctAccts.length === 1) {
    sellAccount = _distinctAccts[0];
  } else if (_distinctAccts.length > 1) {
    sellAccount = 'personal';
    console.warn(`[markExecuted] ${rec.ticker} is held in multiple accounts (${_distinctAccts.join(', ')}) — ` +
      `defaulting SELL/TRIM to 'personal'. Verify the correct account was debited.`);
  } else {
    sellAccount = 'personal';
  }

  let _disposalEntries = null;   // set when the SELL/TRIM branch creates per-parcel rows
  let _saleDisposals = null;     // raw disposals — used below for blended entryPrice/holdDays on the learning-loop payload
  if (isReducing) {
    const holding = getPortfolioHolding(rec.ticker, _distinctAccts.length === 1 ? sellAccount : undefined);
    if (holding && holding.shares >= qty) {
      const prevDisposalLen = state.cgtDisposals.length;
      const { disposals } = applySellToPortfolio(rec.ticker, qty, tradePrice, fees, today, undefined, sellAccount);
      _saleDisposals = disposals;
      realizedPnl = disposalsToPnl(disposals);
      // Snapshot live technicals at exit fill time (mirrors entrySignals on the
      // BUY/TOP_UP branch below) so the Journal drawer can show what the chart
      // looked like when the position was actually closed, not just when Claude
      // generated the SELL/TRIM rec. One snapshot for the whole execution —
      // every parcel slice in this batch was filled at the same moment.
      const execExitSignals = _snapshotLiveTechnicals(rec.ticker, tradePrice);
      // One Trade Journal row per parcel actually matched — not one aggregate
      // row for the whole sale. A TRIM spanning multiple lots (e.g. FIFO
      // consuming all of an older parcel plus part of a newer one) now shows
      // as separate rows, each labelled with the originating parcel, and each
      // original BUY/TOP_UP row's status is updated to 'closed'/'trimmed'
      // depending on what's left in that specific parcel.
      _disposalEntries = buildDisposalJournalEntries({
        ticker: rec.ticker, account: sellAccount, disposals, tradePrice, action: rec.action,
        recId: rec.id, recExecuted: true, timestamp: time, date: today,
        regime: execRegime, exitSignals: execExitSignals, disposalIdBase: prevDisposalLen,
      });
      tradeEntry = _disposalEntries[0] || null;
    } else {
      tradeEntry = {
        id: state.tradeJournal.length + 1, date: today, ticker: rec.ticker, action: rec.action,
        qty, entryPrice: tradePrice, exitPrice: null, fees,
        status: 'open', pnl: null, recId: rec.id, recExecuted: true, timestamp: time,
        regime: execRegime,
      };
      toast(`${rec.action} ${rec.ticker}: not enough shares held — logged but portfolio unchanged.`, 'warn');
    }
  } else {
    // BUY or TOP_UP — open/add to a position
    applyBuyToPortfolio(rec.ticker, qty, tradePrice, today, fees, rec.sector);
    const newParcel = state.cgtParcels[state.cgtParcels.length - 1];
    state.cash -= qty * tradePrice + fees;
    // Snapshot live technicals at execution time so the journal drawer can show
    // what the chart looked like when the trade was filled (not just when Claude
    // generated the rec, which may have been hours earlier).
    const execEntrySignals = _snapshotLiveTechnicals(rec.ticker, tradePrice);
    tradeEntry = {
      id: state.tradeJournal.length + 1, date: today, ticker: rec.ticker, action: rec.action,
      qty, entryPrice: tradePrice, exitPrice: null, fees,
      status: 'open', pnl: null,
      parcelId: newParcel ? newParcel.id : null,
      recId: rec.id, recExecuted: true, timestamp: time,
      entrySignals: execEntrySignals, regime: execRegime,
    };
  }

  // Save to journal. The SELL/TRIM-with-holding branch above already
  // unshifted its per-parcel rows via buildDisposalJournalEntries() (and
  // patched the original BUY/TOP_UP row(s) status directly by parcelId,
  // which is reliable regardless of which UI flow created them — Day
  // Trading's own executeDayTrade()/executeIntradayTrade() included) — only
  // the BUY/TOP_UP branch and the insufficient-shares fallback still need an
  // explicit unshift here.
  if (!_disposalEntries) {
    state.tradeJournal.unshift(tradeEntry);
  }

  // Day Trading sync: a position may have originated from Day Trading's own
  // flows (executeDayTrade / executeIntradayTrade), which keep their own
  // bookkeeping in state.dayTrading.recommendations[] and
  // state.intraday.openPositions[] — neither of which markExecuted() (the
  // generic Recommendations close path) otherwise touches.
  //
  // This used to gate on `sellAccount === 'trading'` — but sellAccount is a
  // guess when the ticker is held in multiple accounts (see resolution above),
  // so a SELL/TRIM meant to close a day-trade could silently default to
  // 'personal' and skip this block entirely, leaving the ticker stale in the
  // Day Trading tab AND creating a duplicate journal row (the original bug
  // report). Checking the ACTUAL remaining 'trading'-account shares after the
  // sale is ground truth, independent of which account the guess landed on —
  // if the trading-account holding is genuinely gone, sync; if this sale
  // didn't touch it (sellAccount correctly resolved to a different account),
  // tradingSharesLeft stays > 0 and we correctly leave the day-trade alone.
  // Also fixes a second bug: a partial TRIM that reduces but doesn't zero the
  // trading-account shares no longer force-closes the day-trade record.
  if (isReducing) {
    const _tradingHolding = state.portfolio.find(h =>
      _normTicker(h.ticker) === _normTicker(rec.ticker) && (h.account || 'personal') === 'trading');
    const _tradingSharesLeft = _tradingHolding ? (_tradingHolding.shares || 0) : 0;
    if (_tradingSharesLeft <= 0) {
      const dtRec = (state.dayTrading && state.dayTrading.recommendations || [])
        .find(r => _normTicker(r.ticker) === _normTicker(rec.ticker) && r.status === 'executed');
      if (dtRec) {
        dtRec.status      = 'closed';
        dtRec._closedAt    = today;
        dtRec._closePrice  = tradePrice;
      }
      if (state.intraday && Array.isArray(state.intraday.openPositions)) {
        const posIdx = state.intraday.openPositions.findIndex(p => _normTicker(p.ticker) === _normTicker(rec.ticker));
        if (posIdx !== -1) {
          state.intraday.openPositions.splice(posIdx, 1);
        }
      }
    }
  }

  // Save to recHistory — include all execution details so backtest can use them
  // SELL/TRIM that fully disposed a holding already know their P&L (realizedPnl,
  // set above) — outcome must reflect win/loss/breakeven immediately, not stay
  // 'open' forever. BUY/TOP_UP have no exit yet, so they correctly stay 'open'
  // until a later SELL/TRIM closes them. Previously this was hardcoded to
  // 'open' for every action, which is why the History tab showed every
  // executed SELL/TRIM as "open" even though it had already closed.
  const _immediateOutcome = realizedPnl != null
    ? (realizedPnl > 0 ? 'win' : realizedPnl < 0 ? 'loss' : 'breakeven')
    : 'open';
  const histEntry = {
    id: rec.id, date: today, ticker: rec.ticker, action: rec.action,
    confidence: rec.confidence, priceRange: rec.priceRange, target: rec.target,
    stopLoss: rec.stopLoss, expectedProfit: rec.expectedProfit, netProfit: rec.netProfit,
    qty, executedPrice: tradePrice, executedFee: fees,
    executed: true, executedAt: time,
    outcome: _immediateOutcome,
    actualProfit: realizedPnl,
    reasoning: rec.reasoning || null,
    feedback: rec.feedback || null,
    journalId: tradeEntry.id,
    _learningId: rec._learningId || null,
    _thesis: rec._thesis || null,
    regime: rec._genRegime || null,
  };
  state.recHistory.unshift(histEntry);

  // Update learning loop: mark event as executed, or log fresh if no prior event
  if (state.serverOk) {
    const pv = typeof PROMPT_VERSION !== 'undefined' ? PROMPT_VERSION : 'unknown';
    // Blended across all parcels matched by this sale (not just the first
    // disposal's own row) — tradeEntry.entryPrice now reflects only ONE
    // parcel since SELL/TRIM creates one journal row per parcel. The
    // learning-loop outcome payload still wants the whole-sale picture.
    const _soldQty = _saleDisposals ? _saleDisposals.reduce((s, d) => s + d.saleQty, 0) : 0;
    const entryP = (_saleDisposals && _soldQty > 0)
      ? _saleDisposals.reduce((s, d) => s + d.saleQty * d.parcelCostPerShare, 0) / _soldQty
      : (tradeEntry.entryPrice || tradePrice);
    const exitP  = tradeEntry.exitPrice  ?? null;
    const pnlPct = realizedPnl != null && entryP > 0
      ? +((realizedPnl / (entryP * qty)) * 100).toFixed(2) : null;
    const outcome = _immediateOutcome !== 'open' ? _immediateOutcome : null;
    // heldDays on the FIRST (FIFO-earliest) disposal mirrors the old openDate
    // semantics — the oldest parcel touched by this sale.
    const holdDays = (_saleDisposals && _saleDisposals.length)
      ? _saleDisposals[0].heldDays
      : ((tradeEntry.date && today && typeof parseDate === 'function')
          ? Math.max(0, Math.round((parseDate(today).getTime() - parseDate(tradeEntry.date).getTime()) / 86400000))
          : null);
    const currentRegime = execRegime;
    const sector = rec.sector || (typeof getPortfolioHolding === 'function'
      ? getPortfolioHolding(rec.ticker)?.sector : null) || null;

    if (rec._learningId) {
      // Existing learning event → update with full outcome context
      const outcomePayload = {
        id: rec._learningId, was_executed: true,
        actual_entry_price: entryP ?? null,
        actual_exit_price:  exitP  ?? null,
        sector,
        regime_at_execution: currentRegime,
        ...(rec._tags   ? { tags:         rec._tags   } : {}),
        ...(rec._thesis ? { trade_thesis: rec._thesis } : {}),
      };
      if (outcome) {
        const exitReason = _detectExitReason(exitP || tradePrice, rec.stopLoss, rec.target, rec.action);
        outcomePayload.outcome_status      = outcome;
        outcomePayload.realized_pnl_aud    = +realizedPnl.toFixed(2);
        outcomePayload.realized_pnl_pct    = pnlPct;
        outcomePayload.holding_period_days = holdDays;
        outcomePayload.exit_reason         = exitReason;
      }
      if (isReducing && tradeEntry.exitSignals) {
        outcomePayload.exit_signals_json = JSON.stringify(tradeEntry.exitSignals);
      }
      fetch(`${API}/api/learning/outcome`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(outcomePayload),
      }).catch(() => {});

      // #2: when position fully closes, reconcile all open BUY/TOP_UP learning events for this ticker
      if (isReducing && outcome) {
        // Scoped by sellAccount — an unscoped lookup would return the FIRST
        // state.portfolio row matching the ticker regardless of account, so
        // fully closing the position in ONE account (e.g. 'trading') could
        // false-negative as "still open" just because a DIFFERENT account
        // (e.g. 'personal') still holds shares of the same ticker.
        const remaining = getPortfolioHolding(rec.ticker, sellAccount);
        const positionClosed = !remaining || (remaining.shares || 0) <= 0;
        if (positionClosed) {
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
            // Parent is a BUY/TOP_UP (long): evaluate against its own stop/target.
            const prExitReason = _detectExitReason(tradePrice, pr.stopLoss, pr.target, pr.action);
            fetch(`${API}/api/learning/outcome`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id:                  pr._learningId,
                outcome_status:      prOutcome,
                exit_reason:         prExitReason,
                actual_exit_price:   tradePrice,
                holding_period_days: holdDays,
                regime_at_execution: currentRegime,
                // Phase 2+3: propagate thesis verdict from the SELL/TRIM rec to parent BUY events
                thesis_verdict:      rec._thesisCheck?.verdict ?? null,
                // Exit-signals capture: propagate the same exit snapshot onto the
                // parent BUY/TOP_UP event too, so its closed learning event carries
                // both sides of the trade (entry_signals_json was set at its own
                // execution; this is what the market looked like when it was closed).
                ...(tradeEntry.exitSignals ? { exit_signals_json: JSON.stringify(tradeEntry.exitSignals) } : {}),
                ...(prPnlPct != null ? { realized_pnl_pct: prPnlPct } : {}),
                ...(prPnlAud != null ? { realized_pnl_aud: prPnlAud } : {}),
              }),
            }).catch(() => {});
            const rh = state.recHistory.find(r => r.id === pr.id);
            if (rh) rh.outcome = prOutcome;
          }

          // #2b: thesis review — surface thesis from any parent BUY rec
          const thesisRec = (state.recHistory || []).find(r =>
            r.ticker === rec.ticker && r._thesis && (r.action === 'BUY' || r.action === 'TOP_UP')
          );
          if (thesisRec?._thesis) {
            const reviewLearningId = thesisRec._learningId || rec._learningId;
            setTimeout(() => _showThesisReview(thesisRec._thesis, reviewLearningId, rec.ticker), 400);
          }
        }
      }
    } else if (isReducing && realizedPnl != null) {
      // No prior learning event (manually-imported position).
      const rrRatio = entryP && rec.stopLoss && rec.target && entryP !== rec.stopLoss
        ? +Math.abs((rec.target - entryP) / (entryP - rec.stopLoss)).toFixed(2) : null;
      const exitReason = _detectExitReason(exitP || tradePrice, rec.stopLoss, rec.target, rec.action);
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
          rationale_summary:   rec.reasoning ? reasoningText(rec.reasoning).slice(0, 400) : null,
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
          tags:                rec._tags   || null,
          trade_thesis:        rec._thesis || null,
          ...(tradeEntry.exitSignals ? { exit_signals_json: JSON.stringify(tradeEntry.exitSignals) } : {}),
          notes:               'Manually imported position — no prior BUY event logged',
        }),
      }).then(r => r.json()).then(res => {
        if (res.id) {
          histEntry._learningId = res.id;
          const rh = state.recHistory.find(r => r.id === rec.id);
          if (rh) rh._learningId = res.id;
          // Postmortem and skill scoring are manual-only — use Debate Engine on Learning page
        }
      }).catch(() => {});
    }
  }

  // Postmortem and skill scoring are manual-only — use Debate Engine on Learning page

  const _execIdx = state.recommendations.findIndex(r => r.id === id);
  if (_execIdx !== -1) state.recommendations.splice(_execIdx, 1);
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
    regime: rec._genRegime || null,
  });
  // Update learning loop: mark event as skipped (fire-and-forget)
  if (rec._learningId && state.serverOk) {
    fetch(`${API}/api/learning/outcome`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rec._learningId, outcome_status: 'skipped', was_executed: false }),
    }).catch(() => {});
  }
  const _skipIdx = state.recommendations.findIndex(r => r.id === id);
  if (_skipIdx !== -1) state.recommendations.splice(_skipIdx, 1);
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
      <div style="background:var(--warn-bg);border:1px solid var(--warn);border-radius:var(--radius-md);padding:10px 14px;font-size:12px;color:var(--warn);display:flex;align-items:center;justify-content:space-between">
        <span>Custom rules active — defaults have been modified. These are applied on every analysis run.</span>
        <button class="btn btn-sm" onclick="resetRecRules()" style="white-space:nowrap;color:var(--warn)">↺ Reset all</button>
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
