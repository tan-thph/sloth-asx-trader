// ============================================================
// DAY TRADING PAGE
// ============================================================

// Signal display labels — must match what the AI returns in signalsHit[]
const _DT_SIGNALS = ['BB Primary', 'RSI<35', 'Vol Z-Score', 'Fib Zone', 'OBV div'];
// Keywords used to match AI-returned signal strings (case-insensitive)
const _DT_SIG_KEYS = ['bb', 'rsi', 'vol', 'fib', 'obv'];

function renderDayTradingPage(gen) {
  const el = document.getElementById('main-content');
  el.innerHTML = _renderDayTrading();
  _renderDtExtraChips();
}

function _renderDayTrading() {
  const dt = state.dayTrading;
  const activeTab = dt.activeTab || 'setups';
  return `
    <div class="tabs" style="margin-bottom:14px">
      <button class="tab ${activeTab === 'setups'   ? 'active' : ''}" id="dt-tab-setups"   onclick="switchDtTab('setups')">Setups</button>
      <button class="tab ${activeTab === 'intraday' ? 'active' : ''}" id="dt-tab-intraday" onclick="switchDtTab('intraday')">⚡ Intraday</button>
      <button class="tab ${activeTab === 'rules'    ? 'active' : ''}" id="dt-tab-rules"    onclick="switchDtTab('rules')">⚙ Rules</button>
      <button class="tab ${activeTab === 'history'  ? 'active' : ''}" id="dt-tab-history"  onclick="switchDtTab('history')">📋 History</button>
      <button class="tab ${activeTab === 'model'    ? 'active' : ''}" id="dt-tab-model"    onclick="switchDtTab('model')">🧠 Model</button>
    </div>
    <div id="dt-tab-content">
      ${activeTab === 'setups'   ? _renderDtSetupsTab()
        : activeTab === 'intraday' ? _renderDtIntradayTab()
        : activeTab === 'history'  ? renderDtHistoryTab()
        : activeTab === 'model'    ? renderDtModelTab()
        : _renderDtRulesTab()}
    </div>
  `;
}

function switchDtTab(tab) {
  state.dayTrading.activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const tabEl = document.getElementById('dt-tab-' + tab);
  if (tabEl) tabEl.classList.add('active');
  const el = document.getElementById('dt-tab-content');
  if (!el) return;
  if (tab === 'setups') {
    el.innerHTML = _renderDtSetupsTab();
    _renderDtExtraChips();
  } else if (tab === 'intraday') {
    el.innerHTML = _renderDtIntradayTab();
  } else if (tab === 'history') {
    // Reset page so fresh data loads
    _dtHistItems = []; _dtHistOffset = 0; _dtHistMore = false; _dtStats = null;
    el.innerHTML = renderDtHistoryTab();
  } else if (tab === 'model') {
    _dtModel = undefined;  // force re-fetch with importances
    _dtStats = null;
    Promise.all([dtLoadModelWithImportances(), dtLoadStats()]).then(function() {
      if ((state.dayTrading && state.dayTrading.activeTab) === 'model') {
        el.innerHTML = renderDtModelTab();
      }
    });
    el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted)">Loading model…</div>';
  } else {
    el.innerHTML = _renderDtRulesTab();
  }
}

function _renderDtSetupsTab() {
  const dt = state.dayTrading;
  const allocated = dt.allocatedCash != null ? dt.allocatedCash : Math.round(state.cash * 0.20);
  const riskPct = dt.riskPct || 1.5;
  const riskPerTrade = allocated * riskPct / 100;

  const pending   = (dt.recommendations || []).filter(r => r.status === 'pending');
  const executed  = (dt.recommendations || []).filter(r => r.status === 'executed');
  const closed    = (dt.recommendations || []).filter(r => r.status === 'closed');
  const dismissed = (dt.recommendations || []).filter(r => r.status === 'dismissed');

  // Pre-filter rejection breakdown bar — shows how many tickers each filter rejected
  const fs = dt.lastSummary?.filterStats;
  const filterBreakdownHtml = fs
    ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;font-size:10px">
         ${[
           {label:'BB %B', n:fs.bb, color:'#6366f1'},
           {label:'ADV',   n:fs.adv,color:'#f59e0b'},
           {label:'SMA200',n:fs.sma,color:'#ef4444'},
           {label:'ADX',   n:fs.adx,color:'#8b5cf6'},
           ...(fs.noData ? [{label:'No data',n:fs.noData,color:'#6b7280'}] : []),
         ].map(f => `<span style="padding:2px 7px;border-radius:9px;background:${f.color}22;color:${f.color};font-weight:600">
           ${f.label} −${f.n}</span>`).join('')}
       </div>`
    : '';

  const summaryHtml = dt.lastSummary
    ? `<div style="background:var(--bg-secondary);border:0.5px solid var(--border-medium);border-radius:6px;padding:9px 12px">
         <div class="text-xs text-muted" style="margin-bottom:3px">Last scan: ${dt.lastSummary.date} ${dt.lastSummary.time || ''}</div>
         <div style="font-size:13px;line-height:1.5">${(dt.lastSummary.text || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
         ${filterBreakdownHtml}
       </div>`
    : '<div class="text-xs text-muted">No scan run yet.</div>';

  // Build active-params summary line from current state
  const fp = { ...DT_FILTER, ...(dt.filterParams || {}) };
  const ap = { ...DT_AI_PARAMS, ...(dt.aiParams || {}) };
  const paramsLine = `BB %B ≤ ${fp.maxBbPctB} · ADV ≥ $${(fp.minAdvAud/1000).toFixed(0)}k · SMA200 floor ${(fp.sma200Floor*100).toFixed(1)}% · ADX ≤ ${fp.maxAdx} · Stop ${ap.stopAtrMultiple}×ATR · Min R:R ${ap.minRrRatio}:1`;

  return `
    <!-- Config + Run -->
    <div class="grid-2" style="margin-bottom:14px">
      <div class="card">
        <div class="card-title" style="display:flex;align-items:center;gap:8px">
          <span style="background:#f59e0b;color:#000;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:.5px">DAY TRADE</span>
          Allocation &amp; Risk
        </div>
        <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:4px">
          <div>
            <div class="form-label">Allocated capital ($)</div>
            <input type="number" id="dt-allocated-cash" value="${allocated}" min="0" max="${state.cash}"
              style="width:100%"
              onchange="state.dayTrading.allocatedCash=Number(this.value);scheduleSave();_updateDtRiskDisplay()">
            <div class="text-xs text-muted mt-1">Available: $${fmt(state.cash)}</div>
          </div>
          <div>
            <div class="form-label">Max risk per trade (%)</div>
            <input type="number" id="dt-risk-pct" value="${riskPct}" min="0.5" max="5" step="0.5"
              style="width:100%"
              onchange="state.dayTrading.riskPct=Number(this.value);scheduleSave();_updateDtRiskDisplay()">
            <div class="text-xs text-muted mt-1" id="dt-risk-display">= $${fmt(riskPerTrade)} per trade</div>
          </div>
        </div>
        <div style="margin-top:10px">
          <div class="form-label">Watchlist tickers (day trade only)</div>
          <div id="dt-extra-chips" class="flex-row" style="flex-wrap:wrap;gap:5px;margin-bottom:6px"></div>
          <div class="flex-row" style="gap:7px">
            <input type="text" id="dt-extra-input" placeholder="e.g. MIN, FMG" maxlength="10" style="width:160px"
              onkeydown="if(event.key==='Enter'||event.key===',')_addDtExtraTicker()">
            <button class="btn btn-sm" onclick="_addDtExtraTicker()">+ Add</button>
          </div>
        </div>
      </div>

      <div class="card" style="display:flex;flex-direction:column;gap:10px">
        <div class="card-title">Run Day Trade Scan</div>
        <p class="text-xs text-muted" style="margin:0">
          Scans portfolio + watchlist tickers for swing-trade setups (5–15 day holds) using orthogonal confluence.
          Requires BB Primary + ≥2 of 4 confirmations, plus all hard filters (liquidity, SMA200, ADX, no catalyst).
        </p>
        ${summaryHtml}
        <button class="btn btn-primary" ${dt.analysisRunning ? 'disabled' : ''}
          onclick="runDayTradeAnalysis()"
          style="align-self:flex-start;display:flex;align-items:center;gap:7px">
          ${dt.analysisRunning
            ? '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Scanning…'
            : '▶ Run Day Trade Scan'}
        </button>
      </div>
    </div>

    <!-- Universe Scanner -->
    ${_renderUniverseScannerCard()}

    <!-- Signal legend -->
    <div class="card" style="margin-bottom:14px;padding:10px 14px">
      <div style="font-size:11px;color:var(--text-muted);display:flex;flex-wrap:wrap;gap:12px;align-items:center">
        <span><b>#1 PRIMARY:</b> BB reclaim</span>
        <span><b>#2:</b> RSI&lt;${ap.rsiThreshold} turning up</span>
        <span><b>#3:</b> Vol Z-Score &gt;${ap.volZScore}σ</span>
        <span><b>#4:</b> Fib zone (60d return ${ap.fibReturnMin}% to ${ap.fibReturnMax}%)</span>
        <span><b>#5:</b> OBV div. (bonus)</span>
        <span style="margin-left:auto;color:var(--text-tertiary)"><button class="btn btn-sm" style="font-size:10px;padding:2px 7px" onclick="switchDtTab('rules')">⚙ Edit rules</button></span>
      </div>
      <div style="font-size:10px;color:var(--text-tertiary);margin-top:6px;border-top:0.5px solid var(--border-light);padding-top:6px">Active: ${paramsLine}</div>
    </div>

    <!-- Pending setups -->
    <div style="margin-bottom:6px;font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">
      Active Setups (${pending.length})
    </div>
    ${pending.length === 0
      ? `<div class="card" style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px">
           No pending setups. Run a scan to find confluence entries.
         </div>`
      : `<div style="display:flex;flex-direction:column;gap:10px">
           ${pending.map(r => _renderDtRec(r)).join('')}
         </div>`}

    ${executed.length ? `
      <div style="margin:16px 0 6px;font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">
        Executed Today (${executed.length})
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${executed.map(r => _renderDtRec(r, true)).join('')}
      </div>` : ''}

    ${closed.length ? `
      <div style="margin:16px 0 6px;font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">
        Closed Trades (${closed.length})
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${closed.map(r => _renderDtRec(r, true)).join('')}
      </div>` : ''}

    ${dismissed.length ? `
      <div style="margin:16px 0 4px">
        <button class="btn btn-sm" onclick="_toggleDtDismissed(this)" style="font-size:11px">
          Show dismissed (${dismissed.length})
        </button>
        <div id="dt-dismissed" style="display:none;flex-direction:column;margin-top:8px;gap:8px">
          ${dismissed.map(r => _renderDtRec(r, true)).join('')}
        </div>
      </div>` : ''}
  `;
}

// ── Day Trading Rules Panel ────────────────────────────────────────────────────

const _DT_FILTER_DEFAULTS = { maxBbPctB: 0.20, minAdvAud: 1500000, sma200Floor: 0.985, maxAdx: 35 };
const _DT_AI_DEFAULTS     = { stopAtrMultiple: 2.5, minRrRatio: 2.0, minConfidence: 0.50, maxPositionPct: 20, rsiThreshold: 35, volZScore: 1.5, fibReturnMin: -20, fibReturnMax: -5 };

function _renderDtRulesTab() {
  const fp = { ..._DT_FILTER_DEFAULTS, ...(state.dayTrading.filterParams || {}) };
  const ap = { ..._DT_AI_DEFAULTS,     ...(state.dayTrading.aiParams     || {}) };

  const fpModified = Object.keys(_DT_FILTER_DEFAULTS).some(k => fp[k] !== _DT_FILTER_DEFAULTS[k]);
  const apModified = Object.keys(_DT_AI_DEFAULTS).some(k => ap[k] !== _DT_AI_DEFAULTS[k]);
  const anyModified = fpModified || apModified;

  const nf = (label, group, key, value, min, max, step, hint) => `
    <div>
      <div class="form-label">${label}</div>
      <input type="number" value="${value}" min="${min}" max="${max}" step="${step}"
        style="width:120px" title="${hint}"
        onchange="setDtParam('${group}','${key}',this.value)">
      <div class="text-xs text-muted mt-1" style="max-width:210px">${hint}</div>
    </div>`;

  return `
    <div style="display:flex;flex-direction:column;gap:14px">

      ${anyModified ? `
      <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:var(--radius-md);padding:10px 14px;font-size:12px;color:#92400e;display:flex;align-items:center;justify-content:space-between">
        <span>Custom scanner rules active. Pre-filter applied immediately — AI params injected on next scan.</span>
        <button class="btn btn-sm" onclick="resetDtRules()" style="white-space:nowrap">↺ Reset all</button>
      </div>` : `
      <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 14px;font-size:12px;color:var(--text-muted)">
        Using default scanner rules. Edit any value below — pre-filter applies immediately, AI params on next scan.
      </div>`}

      <!-- Pre-filter thresholds -->
      <div class="card">
        <div class="card-title">
          Pre-filter Thresholds
          <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:6px">applied client-side — AI never sees tickers that fail these</span>
        </div>
        <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:8px 12px;margin:8px 0;font-size:11px;color:var(--text-muted)">
          Active: BB %B ≤ <b>${fp.maxBbPctB}</b> · ADV ≥ <b>$${(fp.minAdvAud/1000).toFixed(0)}k</b> · SMA200 floor <b>${(fp.sma200Floor*100).toFixed(1)}%</b> · ADX ≤ <b>${fp.maxAdx}</b>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px">
          ${nf('Max BB %B', 'filterParams', 'maxBbPctB', fp.maxBbPctB, 0, 1, 0.01,
            'Price must be at or below this Bollinger %B level (0 = at lower band)')}
          ${nf('Min ADV ($AUD)', 'filterParams', 'minAdvAud', fp.minAdvAud, 0, 50000000, 100000,
            '20-day average daily value — liquidity floor')}
          ${nf('SMA200 floor (ratio)', 'filterParams', 'sma200Floor', fp.sma200Floor, 0.80, 1.05, 0.005,
            'Price must be ≥ SMA200 × this (0.985 = within 1.5% below SMA200)')}
          ${nf('Max ADX', 'filterParams', 'maxAdx', fp.maxAdx, 10, 60, 1,
            'ADX ceiling — skip stocks already in a strong trend')}
        </div>
      </div>

      <!-- AI Signal Thresholds -->
      <div class="card">
        <div class="card-title">
          AI Signal Thresholds
          <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:6px">injected into AI prompt on every scan</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:8px">
          ${nf('Stop ATR multiple', 'aiParams', 'stopAtrMultiple', ap.stopAtrMultiple, 0.5, 6, 0.5,
            'Stop = entry − N×ATR14')}
          ${nf('Min R:R ratio', 'aiParams', 'minRrRatio', ap.minRrRatio, 1, 5, 0.5,
            'Reject setups with reward:risk below this')}
          ${nf('Min confidence', 'aiParams', 'minConfidence', ap.minConfidence, 0.20, 1, 0.05,
            'AI recs below this confidence are dropped client-side')}
          ${nf('Max position (% of allocated)', 'aiParams', 'maxPositionPct', ap.maxPositionPct, 5, 100, 5,
            'Max single position as % of allocated day-trade capital')}
        </div>
      </div>

      <!-- Entry Signal Thresholds -->
      <div class="card">
        <div class="card-title">
          Entry Signal Thresholds
          <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:6px">shape which confirmations qualify</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:8px">
          ${nf('RSI threshold (Signal #2)', 'aiParams', 'rsiThreshold', ap.rsiThreshold, 20, 55, 1,
            'RSI must have dipped below this level in the past 5 days')}
          ${nf('Vol Z-score floor (Signal #3)', 'aiParams', 'volZScore', ap.volZScore, 0.5, 4, 0.25,
            'Minimum volume Z-score for Signal #3 confirmation')}
          ${nf('Fib return min (%, Signal #4)', 'aiParams', 'fibReturnMin', ap.fibReturnMin, -60, -5, 1,
            '60-day return lower bound for Fibonacci retracement zone')}
          ${nf('Fib return max (%, Signal #4)', 'aiParams', 'fibReturnMax', ap.fibReturnMax, -30, -1, 1,
            '60-day return upper bound for Fibonacci retracement zone')}
        </div>
      </div>

      <!-- Footer -->
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-size:13px;font-weight:600">Scanner rules applied</div>
          <div class="text-xs text-muted">Pre-filter is live · AI params injected on next scan run</div>
        </div>
        <div class="flex-row">
          <button class="btn btn-sm" onclick="resetDtRules()">↺ Reset to defaults</button>
          <button class="btn btn-primary btn-sm" onclick="switchDtTab('setups');setTimeout(runDayTradeAnalysis,50)">▶ Run Scan Now</button>
        </div>
      </div>

    </div>
  `;
}

function setDtParam(group, key, rawValue) {
  const value = Number(rawValue);
  if (!state.dayTrading[group]) state.dayTrading[group] = {};
  state.dayTrading[group][key] = value;
  scheduleSave();
  // Refresh the active-params summary line on the setups tab if visible
  const el = document.getElementById('dt-tab-content');
  if (el && (state.dayTrading.activeTab || 'setups') === 'rules') {
    // Re-render just the active-filter badge inside the rules panel
    const badge = el.querySelector('[data-dt-active-params]');
    if (badge) {
      const fp = { ..._DT_FILTER_DEFAULTS, ...(state.dayTrading.filterParams || {}) };
      badge.textContent = `Active: BB %B ≤ ${fp.maxBbPctB} · ADV ≥ $${(fp.minAdvAud/1000).toFixed(0)}k · SMA200 floor ${(fp.sma200Floor*100).toFixed(1)}% · ADX ≤ ${fp.maxAdx}`;
    }
  }
}

function resetDtRules() {
  state.dayTrading.filterParams = { ..._DT_FILTER_DEFAULTS };
  state.dayTrading.aiParams     = { ..._DT_AI_DEFAULTS };
  scheduleSave();
  const el = document.getElementById('dt-tab-content');
  if (el) el.innerHTML = _renderDtRulesTab();
  toast('Day trade scanner rules reset to defaults', 'success');
}

function _renderDtRec(r, compact = false) {
  const signalsHit = r.signalsHit || [];
  const filtersPass = r.filtersPass || {};
  const rrRatio = r.rrRatio || 0;
  const rrColor = rrRatio >= 2.5 ? '#10b981' : rrRatio >= 2.0 ? '#f59e0b' : '#ef4444';
  const confPct = Math.round((r.confidence || 0) * 100);
  const isPending  = r.status === 'pending';
  const isExecuted = r.status === 'executed';
  const isClosed   = r.status === 'closed';

  // Stale badge — pending rec older than 3 days may have a stale setup
  const recAgeDays = r.generatedAtMs ? Math.floor((Date.now() - r.generatedAtMs) / 86400000) : 0;
  const isStale    = isPending && recAgeDays >= 3;

  // Match each display signal against the AI-returned signalsHit strings
  const sigDots = _DT_SIGNALS.map((label, i) => {
    const key = _DT_SIG_KEYS[i];
    const hit = signalsHit.some(h => h.toLowerCase().indexOf(key) !== -1);
    const isPrimary = i === 0;
    const bg    = hit ? (isPrimary ? '#f59e0b' : '#10b981') : 'var(--bg-secondary)';
    const color = hit ? '#000' : 'var(--text-muted)';
    return `<span style="font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;background:${bg};color:${color}">
      ${isPrimary ? '⬢ ' : ''}${label}
    </span>`;
  }).join('');

  const filterIcons = [
    { label: 'Liquidity',   ok: filtersPass.liquidityOk },
    { label: 'SMA200',      ok: filtersPass.aboveSMA200 },
    { label: 'ADX ok',      ok: filtersPass.adxOk },
    { label: 'No catalyst', ok: filtersPass.noCatalyst },
  ].map(f =>
    `<span style="font-size:10px;color:${f.ok ? '#10b981' : '#ef4444'}">${f.ok ? '✓' : '✗'} ${f.label}</span>`
  ).join(' ');

  const reasoningHtml = r.reasoning
    ? `<div style="font-size:12px;margin-top:6px;color:var(--text-secondary)">${r.reasoning}</div>` : '';
  const stopReasonHtml = r.stopReason
    ? `<div style="font-size:11px;margin-top:3px;color:#ef4444">⚠ Invalidated if: ${r.stopReason}</div>` : '';

  const entryLow  = Array.isArray(r.priceRange) ? r.priceRange[0] : null;
  const entryHigh = Array.isArray(r.priceRange) ? r.priceRange[1] : null;

  const borderColor = isClosed ? '#059669' : isExecuted ? '#6366f1' : isPending ? '#f59e0b' : '#6b7280';
  return `
    <div class="card" style="border-left:3px solid ${borderColor};padding:12px 14px${isStale ? ';opacity:.75' : ''}">
      <div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap">

        <!-- Left: ticker + signals -->
        <div style="min-width:200px;flex:1">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
            <span style="font-size:16px;font-weight:700">${r.ticker}</span>
            <span style="background:#f59e0b;color:#000;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px">BUY</span>
            ${isExecuted ? `<span style="background:#6366f1;color:#fff;font-size:10px;padding:2px 7px;border-radius:4px">EXECUTED</span>` : ''}
            ${isClosed   ? `<span style="background:#059669;color:#fff;font-size:10px;padding:2px 7px;border-radius:4px">CLOSED</span>` : ''}
            ${isStale    ? `<span style="background:#ef444422;color:#ef4444;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px" title="Setup is ${recAgeDays}d old — signals may no longer be valid">⚠ STALE ${recAgeDays}d</span>` : ''}
            ${r.holdDays ? `<span style="font-size:11px;color:var(--text-muted)">${r.holdDays}d hold est.</span>` : ''}
            ${isPending && typeof dtWinProbLabel === 'function' ? dtWinProbLabel(r) : ''}
          </div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px">${sigDots}</div>
          <div style="font-size:11px;color:var(--text-muted);display:flex;gap:10px;flex-wrap:wrap">${filterIcons}</div>
          ${reasoningHtml}
          ${stopReasonHtml}
        </div>

        <!-- Right: price levels + sizing -->
        <div style="min-width:220px">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">
            <div style="text-align:center;padding:6px;background:var(--bg-secondary);border-radius:6px">
              <div style="font-size:10px;color:var(--text-muted)">Entry</div>
              <div style="font-size:13px;font-weight:600">${entryLow != null ? '$' + entryLow.toFixed(3) : '?'}</div>
              <div style="font-size:10px;color:var(--text-muted)">${entryHigh != null ? '–$' + entryHigh.toFixed(3) : ''}</div>
            </div>
            <div style="text-align:center;padding:6px;background:rgba(16,185,129,.08);border-radius:6px;border:0.5px solid rgba(16,185,129,.3)">
              <div style="font-size:10px;color:var(--text-muted)">Target</div>
              <div style="font-size:13px;font-weight:600;color:#10b981">${r.target != null ? '$' + Number(r.target).toFixed(3) : '?'}</div>
            </div>
            <div style="text-align:center;padding:6px;background:rgba(239,68,68,.08);border-radius:6px;border:0.5px solid rgba(239,68,68,.3)">
              <div style="font-size:10px;color:var(--text-muted)">Stop</div>
              <div style="font-size:13px;font-weight:600;color:#ef4444">${r.stopLoss != null ? '$' + Number(r.stopLoss).toFixed(3) : '?'}</div>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:8px">
            <span>Qty: <b>${r._execQty != null ? r._execQty : (r.qty != null ? r.qty : '?')} shares</b>${r._execQty != null && r._execQty !== r.qty ? `<span style="color:var(--text-muted);font-size:10px;margin-left:3px">(AI: ${r.qty})</span>` : ''}</span>
            <span style="color:${rrColor}">R:R <b>${rrRatio ? rrRatio.toFixed(1) : '?'}:1</b></span>
            <span>Conf: <b>${confPct}%</b></span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:10px">
            <span>Risk: <span style="color:#ef4444">-$${r.riskAUD != null ? Number(r.riskAUD).toFixed(0) : '?'}</span></span>
            <span>Reward: <span style="color:#10b981">+$${r.rewardAUD != null ? Number(r.rewardAUD).toFixed(0) : '?'}</span></span>
          </div>
          ${isPending ? `
            <div class="flex-row" style="gap:7px">
              <button class="btn btn-primary btn-sm" onclick="executeDayTrade('${r.id}')" style="flex:1">✓ Execute</button>
              <button class="btn btn-sm btn-danger" onclick="dismissDayTradeRec('${r.id}')">Dismiss</button>
            </div>` : ''}
          ${isExecuted ? `
            <div class="flex-row" style="gap:7px;margin-top:8px">
              <button class="btn btn-sm" onclick="_closeDayTrade('${r.id}')"
                style="flex:1;font-size:11px;color:#6366f1;border-color:#6366f1">
                📋 Record Close
              </button>
            </div>` : ''}
          ${isClosed && r._closePrice ? `
            <div style="margin-top:6px;font-size:11px;color:var(--text-muted)">
              Closed ${r._closedAt || ''} @ $${Number(r._closePrice).toFixed(3)}
            </div>` : ''}
        </div>
      </div>
    </div>`;
}

// ── Universe Scanner Card ─────────────────────────────────────────────────────

function _renderUniverseScannerCard() {
  const dt = state.dayTrading;
  const uKey = dt.universeKey || 'asx200';
  const isRunning = dt.analysisRunning;
  const isScanning = isRunning && dt.scanProgress != null;
  const universeKeys = ['asx20','asx50','asx100','asx200'];

  const selectorHtml = universeKeys.map(k => {
    const meta = ASX_UNIVERSE_META[k];
    const count = getUniverseTickers(k).length;
    const active = k === uKey;
    return `<button
      class="btn btn-sm"
      onclick="state.dayTrading.universeKey='${k}';scheduleSave();renderPage()"
      style="font-size:11px;font-weight:${active ? '700' : '400'};background:${active ? '#6366f1' : 'var(--bg-secondary)'};color:${active ? '#fff' : 'var(--text-secondary)'};border-color:${active ? '#6366f1' : 'var(--border-medium)'}"
      ${isScanning ? 'disabled' : ''}
      title="${meta.desc}"
    >${meta.label} <span style="opacity:.7">(${count})</span></button>`;
  }).join('');

  const progressHtml = isScanning
    ? `<div id="dt-universe-progress">${_renderUniverseProgressHtml()}</div>`
    : '<div id="dt-universe-progress"></div>';

  // Last universe scan summary (shown below progress)
  const lastSummary = dt.lastSummary?.source === 'universe'
    ? `<div style="margin-top:8px;font-size:12px;color:var(--text-secondary);line-height:1.45">
         <span style="color:var(--text-muted);font-size:11px">Last universe scan: ${dt.lastSummary.date} ${dt.lastSummary.time || ''}</span><br>
         ${(dt.lastSummary.text || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
       </div>`
    : '';

  const meta = ASX_UNIVERSE_META[uKey] || {};
  const tickerCount = getUniverseTickers(uKey).length;

  return `
  <div class="card" style="margin-bottom:14px">
    <div class="card-title" style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="background:#6366f1;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:.5px">UNIVERSE</span>
      ASX Index Scanner
    </div>
    <p class="text-xs text-muted" style="margin:0 0 10px 0">
      Scans an entire ASX index for BB confluence setups. Pre-filters ${tickerCount} tickers client-side
      (BB near lower band + ADV>$1.5M + SMA200 + ADX), then sends only candidates to AI.
    </p>
    <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px">
      ${selectorHtml}
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="runUniverseScan()"
        ${isRunning ? 'disabled' : ''}
        style="background:#6366f1;border-color:#6366f1;display:flex;align-items:center;gap:6px">
        ${isScanning
          ? '<span class="spinner" style="width:12px;height:12px;border-width:2px"></span> Scanning…'
          : '⬡ Scan ' + meta.label}
      </button>
      ${isScanning ? `<button class="btn btn-sm" onclick="cancelUniverseScan()" style="color:#ef4444;border-color:#ef4444;font-size:11px">✕ Cancel</button>` : ''}
      <span class="text-xs text-muted">${meta.desc}</span>
    </div>
    ${progressHtml}
    ${lastSummary}
  </div>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function _updateDtRiskDisplay() {
  const allocated = state.dayTrading.allocatedCash != null
    ? state.dayTrading.allocatedCash
    : Math.round(state.cash * 0.20);
  const el = document.getElementById('dt-risk-display');
  if (el) el.textContent = `= $${fmt(allocated * (state.dayTrading.riskPct || 1.5) / 100)} per trade`;
}

function _renderDtExtraChips() {
  const container = document.getElementById('dt-extra-chips');
  if (!container) return;
  container.innerHTML = (state.dayTrading.extraTickers || []).map(t => `
    <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;background:#dbeafe;color:#1d4ed8;border-radius:6px;font-size:12px;font-weight:600;border:0.5px solid #93c5fd">
      ${t}
      <button onclick="_removeDtExtraTicker('${t}')" style="background:none;border:none;cursor:pointer;color:#1d4ed8;font-size:13px;padding:0">×</button>
    </span>`).join('');
}

function _addDtExtraTicker() {
  const input = document.getElementById('dt-extra-input');
  if (!input) return;
  const tickers = input.value.toUpperCase().split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
  const portfolio = mergedPortfolio().map(h => h.ticker);
  for (const t of tickers) {
    if (t && !state.dayTrading.extraTickers.includes(t) && !portfolio.includes(t)) {
      state.dayTrading.extraTickers.push(t);
    }
  }
  input.value = '';
  scheduleSave();
  _renderDtExtraChips();
}

function _removeDtExtraTicker(ticker) {
  state.dayTrading.extraTickers = state.dayTrading.extraTickers.filter(t => t !== ticker);
  scheduleSave();
  _renderDtExtraChips();
}

function _toggleDtDismissed(btn) {
  const el = document.getElementById('dt-dismissed');
  if (!el) return;
  const shown = el.style.display === 'flex';
  el.style.display = shown ? 'none' : 'flex';
  const count = (state.dayTrading.recommendations || []).filter(r => r.status === 'dismissed').length;
  btn.textContent = shown ? `Show dismissed (${count})` : `Hide dismissed`;
}

// ── ⚡ Intraday tab ───────────────────────────────────────────────────────────

function _renderDtIntradayTab() {
  if (!state.intraday) state.intraday = {
    recommendations: [], openPositions: [], todayPnl: 0,
    lastScan: null, scanRunning: false, autoRefresh: false,
    allocatedCash: null,
    params: { targetPct: 3.5, stopPct: 1.5, maxPositions: 2, minScore: 40, allocPct: 20, universeKey: 'asx100' },
  };
  const id = state.intraday;
  const ip = { targetPct: 3.5, stopPct: 1.5, maxPositions: 2, minScore: 40, allocPct: 20, universeKey: 'asx100', extremeMode: false,
               ...(id.params || {}) };
  const allocated = id.allocatedCash != null
    ? id.allocatedCash
    : Math.round(state.cash * ip.allocPct / 100);
  const openPositions = id.openPositions || [];
  const recs = id.recommendations || [];
  const pending = recs.filter(r => r.status === 'pending');
  const scanInfo = id.lastScan;

  // ── Config card ──────────────────────────────────────────────────────────
  const configCard = `
    <div class="card" style="margin-bottom:14px">
      <div class="card-title" style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="background:#10b981;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:.5px">INTRADAY</span>
        Configuration
        ${ip.extremeMode ? '<span style="background:#ef4444;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px">⚠️ EXTREME MODE</span>' : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px">
        <div>
          <div class="form-label">Target exit (%)</div>
          <input type="number" min="1" max="10" step="0.5" value="${ip.targetPct}"
            style="width:100%" onchange="updateIntradayParam('targetPct', parseFloat(this.value))">
          <div class="text-xs text-muted mt-1">Sell when price rises this %</div>
        </div>
        <div>
          <div class="form-label">Stop loss (%)</div>
          <input type="number" min="0.5" max="5" step="0.5" value="${ip.stopPct}"
            style="width:100%" onchange="updateIntradayParam('stopPct', parseFloat(this.value))">
          <div class="text-xs text-muted mt-1">Exit if price falls this %</div>
        </div>
        <div>
          <div class="form-label">Max positions</div>
          <input type="number" min="1" max="5" step="1" value="${ip.maxPositions}"
            style="width:100%" onchange="updateIntradayParam('maxPositions', parseInt(this.value))">
          <div class="text-xs text-muted mt-1">Concurrent intraday trades</div>
        </div>
        <div>
          <div class="form-label">Min score (0–100)</div>
          <input type="number" min="20" max="90" step="5" value="${ip.minScore}"
            style="width:100%" onchange="updateIntradayParam('minScore', parseInt(this.value))">
          <div class="text-xs text-muted mt-1">Setup quality threshold</div>
        </div>
        <div>
          <div class="form-label">Capital allocation (%)</div>
          <input type="number" min="5" max="50" step="5" value="${ip.allocPct}"
            style="width:100%" onchange="updateIntradayParam('allocPct', parseFloat(this.value))">
          <div class="text-xs text-muted mt-1">= $${fmt(allocated, 0)} of $${fmt(state.cash, 0)}</div>
        </div>
      </div>

      <!-- Universe selector -->
      <div style="margin-top:12px;padding-top:10px;border-top:0.5px solid var(--border-light)">
        <div class="form-label" style="margin-bottom:7px">Scan universe</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${['asx20','asx50','asx100','asx200'].map(k => {
            const meta = (typeof ASX_UNIVERSE_META !== 'undefined' && ASX_UNIVERSE_META[k]) || { label: k.toUpperCase() };
            const count = (typeof getUniverseTickers !== 'undefined') ? getUniverseTickers(k).length : '?';
            const active = ip.universeKey === k;
            return `<button class="btn btn-sm"
              onclick="updateIntradayParam('universeKey','${k}')"
              style="font-size:11px;font-weight:${active ? '700' : '400'};background:${active ? '#10b981' : 'var(--bg-secondary)'};color:${active ? '#fff' : 'var(--text-secondary)'};border-color:${active ? '#10b981' : 'var(--border-medium)'}">
              ${meta.label} <span style="opacity:.7">(${count})</span>
            </button>`;
          }).join('')}
        </div>
        <div class="text-xs text-muted mt-1">Larger universes find more setups but take longer to scan</div>
      </div>

      <!-- Extreme mode toggle -->
      <div style="margin-top:10px;padding:8px 10px;background:${ip.extremeMode ? 'rgba(239,68,68,.08)' : 'var(--bg-secondary)'};border:0.5px solid ${ip.extremeMode ? 'rgba(239,68,68,.4)' : 'var(--border-light)'};border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div>
          <div style="font-size:12px;font-weight:600;color:${ip.extremeMode ? '#ef4444' : 'var(--text-secondary)'}">⚠️ Extreme Mode</div>
          <div class="text-xs text-muted">Bypasses entry window, VWAP and RSI gates — shows all setups above min score. For testing only.</div>
        </div>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;white-space:nowrap">
          <input type="checkbox" ${ip.extremeMode ? 'checked' : ''}
            onchange="updateIntradayParam('extremeMode', this.checked)">
          ${ip.extremeMode ? '<span style="color:#ef4444;font-weight:600">On</span>' : 'Off'}
        </label>
      </div>

      <div style="margin-top:10px;padding-top:8px;border-top:0.5px solid var(--border-light);font-size:11px;color:var(--text-muted)">
        ⏰ Entry window: 10:45–15:00 AEST only · ⚠️ yfinance 5m data has ~5–15 min latency — prices are indicative
      </div>
    </div>`;

  // ── Action bar ────────────────────────────────────────────────────────────
  const universeLabel = scanInfo && scanInfo.universeLabel
    ? scanInfo.universeLabel
    : (ASX_UNIVERSE_META && ASX_UNIVERSE_META[ip.universeKey] ? ASX_UNIVERSE_META[ip.universeKey].label : ip.universeKey.toUpperCase());
  const scanStatus = scanInfo
    ? `Last scan: ${scanInfo.date} ${scanInfo.time} · ${scanInfo.universeLabel || universeLabel} · ${scanInfo.passed}/${scanInfo.total} passed · ${scanInfo.count} setup${scanInfo.count !== 1 ? 's' : ''}`
    : 'No scan run yet.';
  const actionBar = `
    <div class="card" style="margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-size:13px;font-weight:600">ASX Intraday Scanner</div>
        <div class="text-xs text-muted">${scanStatus}</div>
      </div>
      <div class="flex-row" style="gap:8px;flex-wrap:wrap;align-items:center">
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">
          <input type="checkbox" ${id.autoRefresh ? 'checked' : ''}
            onchange="updateIntradayParam('autoRefresh', this.checked)">
          Auto-refresh (2 min)
        </label>
        <button class="btn btn-primary btn-sm" ${id.scanRunning ? 'disabled' : ''}
          onclick="runIntradayScan()"
          style="background:#10b981;border-color:#10b981;display:flex;align-items:center;gap:6px">
          ${id.scanRunning
            ? '<span class="spinner" style="width:12px;height:12px;border-width:2px"></span> Scanning…'
            : '⚡ Scan ASX'}
        </button>
      </div>
    </div>`;

  // ── Open Positions ────────────────────────────────────────────────────────
  const todayPnl = id.todayPnl || 0;
  const pnlColor = todayPnl >= 0 ? '#10b981' : '#ef4444';
  const openPosHtml = openPositions.length === 0
    ? '<div class="text-xs text-muted" style="padding:8px 0">No open intraday positions.</div>'
    : openPositions.map(pos => {
        // Try to get live price from portfolio or liveSignals
        let livePrice = null;
        const ph = (state.portfolio || []).find(h => h.ticker === pos.ticker);
        if (ph && ph.currentPrice) livePrice = ph.currentPrice;
        else if (state.liveSignals && state.liveSignals[pos.ticker]) {
          livePrice = state.liveSignals[pos.ticker].current_price;
        }
        const unrlPnl = livePrice != null
          ? (livePrice - pos.entryPrice) * pos.qty
          : null;
        const unrlPct = livePrice != null
          ? (livePrice - pos.entryPrice) / pos.entryPrice * 100
          : null;
        const unrlColor = unrlPnl != null ? (unrlPnl >= 0 ? '#10b981' : '#ef4444') : 'var(--text-muted)';
        return `
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:8px 0;border-bottom:0.5px solid var(--border-light)">
            <div style="min-width:80px">
              <div style="font-size:14px;font-weight:700">${pos.ticker}</div>
              <div class="text-xs text-muted">${pos.qty} shares · entered ${pos.enteredAt}</div>
            </div>
            <div style="display:flex;gap:14px;flex:1;flex-wrap:wrap">
              <div><div class="text-xs text-muted">Entry</div><div style="font-size:13px">$${pos.entryPrice.toFixed(3)}</div></div>
              <div><div class="text-xs text-muted">Target</div><div style="font-size:13px;color:#10b981">$${pos.target.toFixed(3)}</div></div>
              <div><div class="text-xs text-muted">Stop</div><div style="font-size:13px;color:#ef4444">$${pos.stop.toFixed(3)}</div></div>
              ${livePrice != null ? `
              <div><div class="text-xs text-muted">Live</div><div style="font-size:13px">$${livePrice.toFixed(3)}</div></div>
              <div><div class="text-xs text-muted">P&L</div>
                <div style="font-size:13px;color:${unrlColor}">${unrlPnl >= 0 ? '+' : ''}$${(unrlPnl||0).toFixed(2)} (${(unrlPct||0) >= 0 ? '+' : ''}${(unrlPct||0).toFixed(2)}%)</div>
              </div>` : ''}
            </div>
            <div class="flex-row" style="gap:6px">
              ${livePrice != null
                ? `<button class="btn btn-sm btn-primary" style="font-size:11px"
                    onclick="_showCloseIntradayDialog('${pos.id}', ${livePrice.toFixed(3)})">
                    Close @ $${livePrice.toFixed(3)}</button>`
                : `<button class="btn btn-sm" style="font-size:11px"
                    onclick="_showCloseIntradayDialog('${pos.id}', null)">
                    Close</button>`}
            </div>
          </div>`;
      }).join('');

  const positionsCard = `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="card-title" style="margin:0">Open Positions (${openPositions.length}/${ip.maxPositions})</div>
        <div style="font-size:13px;font-weight:600;color:${pnlColor}">
          Today P&L: ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)}
        </div>
      </div>
      ${openPosHtml}
    </div>`;

  // ── Setup candidates ──────────────────────────────────────────────────────
  const slotsLeft = ip.maxPositions - openPositions.length;
  const setupsHtml = pending.length === 0
    ? `<div class="card" style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px">
         ${id.scanRunning ? 'Scanning…' : id.lastScan ? 'No qualifying setups found. Run scan again during entry window (10:45–15:00 AEST).' : 'Run a scan to discover intraday setups.'}
       </div>`
    : pending.map(r => {
        const scoreColor  = r.intradayScore >= 70 ? '#10b981' : r.intradayScore >= 50 ? '#f59e0b' : '#6b7280';
        const canExecute  = slotsLeft > 0 && r.status === 'pending';
        const ageMinutes  = r.generatedAtMs ? Math.floor((Date.now() - r.generatedAtMs) / 60000) : 0;
        const isStaleIdt  = ageMinutes >= 90;
        return `
          <div class="card" style="border-left:3px solid #10b981;padding:12px 14px;margin-bottom:10px${isStaleIdt ? ';opacity:.72' : ''}">
            <div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap">
              <div style="min-width:200px;flex:1">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
                  <span style="font-size:16px;font-weight:700">${r.ticker}</span>
                  <span style="background:#10b981;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px">INTRADAY BUY</span>
                  <span style="background:${scoreColor};color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px">Score ${r.intradayScore}</span>
                  ${isStaleIdt ? `<span style="background:#ef444422;color:#ef4444;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px" title="VWAP and RSI levels are ${ageMinutes}min old — rescan for fresh data">⚠ STALE ${ageMinutes}min</span>` : ''}
                </div>
                <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px">
                  ${(r.signals || []).map(s => `<span style="font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;background:#d1fae5;color:#065f46">${s}</span>`).join('')}
                </div>
                <div style="font-size:11px;color:var(--text-muted);display:flex;gap:10px;flex-wrap:wrap">
                  <span>VWAP: $${r.vwap != null ? r.vwap.toFixed(3) : '—'} (${r.pctFromVwap != null ? r.pctFromVwap.toFixed(2) : '—'}%)</span>
                  ${r.intradayRsi != null ? `<span>RSI: ${r.intradayRsi}</span>` : ''}
                  <span>R:R ${r.rrRatio}:1</span>
                  <span class="text-xs text-muted">Gen: ${r.generatedAt}</span>
                </div>
              </div>
              <div style="min-width:220px">
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">
                  <div style="text-align:center;padding:6px;background:var(--bg-secondary);border-radius:6px">
                    <div style="font-size:10px;color:var(--text-muted)">Entry</div>
                    <div style="font-size:13px;font-weight:600">$${r.priceRange[0].toFixed(3)}</div>
                  </div>
                  <div style="text-align:center;padding:6px;background:rgba(16,185,129,.08);border-radius:6px;border:0.5px solid rgba(16,185,129,.3)">
                    <div style="font-size:10px;color:var(--text-muted)">Target</div>
                    <div style="font-size:13px;font-weight:600;color:#10b981">$${r.target.toFixed(3)}</div>
                  </div>
                  <div style="text-align:center;padding:6px;background:rgba(239,68,68,.08);border-radius:6px;border:0.5px solid rgba(239,68,68,.3)">
                    <div style="font-size:10px;color:var(--text-muted)">Stop</div>
                    <div style="font-size:13px;font-weight:600;color:#ef4444">$${r.stopLoss.toFixed(3)}</div>
                  </div>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:10px">
                  <span>Qty: <b>${r._execQty != null ? r._execQty : (r.qty != null ? r.qty : '?')} shares</b>${r._execQty != null && r._execQty !== r.qty ? `<span style="color:var(--text-muted);font-size:10px;margin-left:3px">(AI: ${r.qty})</span>` : ''}</span>
                  <span>Conf: <b>${Math.round((r.confidence || 0) * 100)}%</b></span>
                </div>
                <button class="btn btn-primary btn-sm" style="width:100%;background:#10b981;border-color:#10b981"
                  ${canExecute ? '' : 'disabled'}
                  onclick="executeIntradayTrade('${r.id}')">
                  ${canExecute ? '⚡ Execute' : slotsLeft <= 0 ? 'Max positions' : 'Executed'}
                </button>
              </div>
            </div>
          </div>`;
      }).join('');

  return `
    ${configCard}
    ${actionBar}
    ${positionsCard}
    <div style="margin-bottom:6px;font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">
      Intraday Setups (${pending.length})
    </div>
    ${setupsHtml}
  `;
}

// ── Shared trade-confirm dialog ───────────────────────────────────────────────
// Shows a <dialog> to confirm execution price + brokerage before committing.
// Used by executeIntradayTrade, _showCloseIntradayDialog, and executeDayTrade.
// action: 'BUY' | 'SELL'
// _showTradeDialog — confirms a day/intraday trade.
//
// BUY  (readOnlyQty = false, the default):
//   The "Shares" field is editable — user can override the AI-suggested qty.
//   onConfirm receives (price, fee, actualQty).
//
// SELL (readOnlyQty = true):
//   The "Shares" field is shown for reference but is NOT editable — the close
//   always uses the quantity determined by the caller (e.g. the full position).
//   Accepting user edits here would silently change the close amount since the
//   callers use their own closure variable for the qty, not the dialog value.
//   Partial-close support is a separate, future feature.
//   onConfirm still receives (price, fee, qty) for consistency.
function _showTradeDialog({ ticker, action, qty, defaultPrice, title, readOnlyQty = false }, onConfirm) {
  const existing = document.getElementById('trade-confirm-dialog');
  if (existing) existing.remove();

  const defaultFee  = (state.settings && state.settings.brokerage) || 10;
  const actionColor = action === 'BUY' ? '#10b981' : '#6366f1';
  const priceLabel  = action === 'BUY' ? 'Entry price ($)' : 'Close price ($)';
  const btnLabel    = action === 'BUY' ? '⚡ Confirm BUY' : '✓ Confirm SELL';

  // BUY: show hint reminding user they can change the AI qty.
  // SELL: read-only — show "Closing N shares" as context only.
  const qtyHint = readOnlyQty
    ? `Closing full position`
    : `AI-suggested: <b>${qty}</b> shares — adjust as needed`;

  const dialog = document.createElement('dialog');
  dialog.id = 'trade-confirm-dialog';
  dialog.style.cssText = 'border-radius:10px;border:1px solid var(--border-medium);padding:20px 24px;min-width:310px;max-width:390px;background:var(--bg-primary);color:var(--text-primary)';
  dialog.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <span style="background:${actionColor};color:#fff;font-size:11px;font-weight:700;padding:3px 9px;border-radius:5px">${action}</span>
      <span style="font-size:15px;font-weight:700">${ticker}</span>
      ${readOnlyQty ? `<span style="font-size:13px;color:var(--text-muted)">&times;${qty} shares</span>` : ''}
    </div>
    <div style="display:grid;gap:10px;margin-bottom:16px">
      ${!readOnlyQty ? `
      <div>
        <div class="form-label">Shares</div>
        <input id="tcd-qty" type="number" step="1" min="1" value="${qty}" style="width:100%">
        <div style="font-size:10px;color:var(--text-muted);margin-top:3px">${qtyHint}</div>
      </div>` : ''}
      <div>
        <div class="form-label">${priceLabel}</div>
        <input id="tcd-price" type="number" step="0.001" value="${Number(defaultPrice).toFixed(3)}" min="0.001" style="width:100%">
      </div>
      <div>
        <div class="form-label">Brokerage fee ($)</div>
        <input id="tcd-fee" type="number" step="1" value="${defaultFee}" min="0" style="width:100%">
      </div>
      <div id="tcd-cost-line" style="font-size:12px;color:var(--text-muted);padding:6px 8px;background:var(--bg-secondary);border-radius:5px"></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-sm" onclick="document.getElementById('trade-confirm-dialog')?.remove()">Cancel</button>
      <button class="btn btn-primary btn-sm" id="tcd-confirm"
        style="background:${actionColor};border-color:${actionColor}">${btnLabel}</button>
    </div>`;

  document.body.appendChild(dialog);
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.remove(); });

  const qtyEl    = !readOnlyQty ? dialog.querySelector('#tcd-qty') : null;
  const priceEl  = dialog.querySelector('#tcd-price');
  const feeEl    = dialog.querySelector('#tcd-fee');
  const costLine = dialog.querySelector('#tcd-cost-line');

  const _upd = () => {
    const q = qtyEl ? (Math.max(0, parseInt(qtyEl.value) || 0)) : qty;
    const p = parseFloat(priceEl.value) || 0;
    const f = parseFloat(feeEl.value)   || 0;
    const gross = q * p;
    const net   = action === 'BUY' ? gross + f : gross - f;
    const label = action === 'BUY'
      ? `Cost: $${net.toFixed(2)} (${q} × $${p.toFixed(3)} + $${f.toFixed(2)} brokerage)`
      : `Proceeds: $${(gross - f).toFixed(2)} (${q} × $${p.toFixed(3)} − $${f.toFixed(2)} brokerage)`;
    costLine.textContent = label;
  };
  if (qtyEl) qtyEl.addEventListener('input', _upd);
  priceEl.addEventListener('input', _upd);
  feeEl.addEventListener('input', _upd);
  _upd();

  dialog.querySelector('#tcd-confirm').onclick = () => {
    const actualQty = qtyEl ? parseInt(qtyEl.value) : qty;
    const price     = parseFloat(priceEl.value);
    const fee       = parseFloat(feeEl.value);
    if (!actualQty || actualQty < 1)  { toast('Enter a valid quantity (≥ 1)', 'error'); qtyEl?.focus();  return; }
    if (!price || price <= 0)         { toast('Enter a valid price', 'error');           priceEl.focus(); return; }
    if (isNaN(fee) || fee < 0)        { toast('Enter a valid brokerage fee', 'error');   feeEl.focus();   return; }
    dialog.remove();
    onConfirm(price, fee, actualQty);
  };

  dialog.showModal();
  (qtyEl || priceEl).focus();
  (qtyEl || priceEl).select();
}

// ── Execute an intraday trade ─────────────────────────────────────────────────

function executeIntradayTrade(recId) {
  if (!state.intraday) return;
  const rec = (state.intraday.recommendations || []).find(r => r.id === recId);
  if (!rec || rec.status !== 'pending') return;

  const ip = { maxPositions: 2, ...(state.intraday.params || {}) };
  if ((state.intraday.openPositions || []).length >= ip.maxPositions) {
    toast('Max intraday positions reached', 'error'); return;
  }

  _showTradeDialog({
    ticker: rec.ticker,
    action: 'BUY',
    qty:    rec.qty,
    defaultPrice: rec.priceRange[0],
  }, (entryPrice, brokerage, actualQty) => {
    // actualQty is the user-entered value (may differ from AI-suggested rec.qty)
    const qty  = actualQty || rec.qty;
    const cost = qty * entryPrice + brokerage;
    if (cost > state.cash) { toast('Insufficient cash for this trade', 'error'); return; }

    if (!state.intraday.openPositions) state.intraday.openPositions = [];
    const newPos = {
      id:         rec.id,
      ticker:     rec.ticker,
      qty,                       // actual qty, not AI-suggested
      entryPrice,
      entryFees:  brokerage,     // stored so close P&L uses actual round-trip cost
      target:     rec.target,
      stop:       rec.stopLoss,
      enteredAt:  nowSydney(),
    };
    state.intraday.openPositions.push(newPos);

    // Add a 'trading' account portfolio holding so the position appears on the Portfolio page
    // and is included in NAV / price refresh cycles (refreshPrices loops state.portfolio).
    const sector = (state.liveSignals?.[rec.ticker] || {}).sector || 'Other';
    applyBuyToPortfolio(rec.ticker, qty, entryPrice, todayStr(), brokerage, sector, 'trading');

    // Seed liveSignals with the entry price immediately so Live/P&L renders on the first
    // renderPage() call after this dialog closes — before the next refreshPrices() fires.
    if (!state.liveSignals) state.liveSignals = {};
    if (!state.liveSignals[rec.ticker]) state.liveSignals[rec.ticker] = {};
    state.liveSignals[rec.ticker].current_price = entryPrice;

    // Record BUY leg in trade journal — creates a paired entry that closeIntradayPosition
    // patches on exit, so the journal shows both legs of the round-trip trade.
    if (!state.tradeJournal) state.tradeJournal = [];
    const intradayBuyEntry = {
      id:          Date.now(),
      date:        todayStr(),
      ticker:      rec.ticker,
      action:      'BUY',
      qty,
      entryPrice,
      exitPrice:   null,
      fees:        brokerage,
      pnl:         null,
      status:      'open',
      sector,
      account:     'trading',
      notes:       'Intraday BUY',
    };
    state.tradeJournal.unshift(intradayBuyEntry);
    newPos._journalId = intradayBuyEntry.id;   // link so close can patch the entry

    state.cash -= cost;
    rec.status   = 'executed';
    rec._execQty = qty;          // remember actual qty for display / close dialog

    scheduleSave();
    if (typeof pushCashToDb === 'function') pushCashToDb(state.cash);
    toast(`⚡ Intraday BUY: ${rec.ticker} × ${qty} @ $${entryPrice.toFixed(3)} (fee $${brokerage})`, 'success');

    // Record ML training snapshot for intraday trade
    if (typeof dtSaveSnapshot === 'function') {
      const itSig = Object.assign({}, (state.liveSignals && state.liveSignals[rec.ticker]) || {}, {
        intraday_rsi:        rec._intradayRsi || null,
        vwap_pct:            rec._vwapPct     || null,
        volume_acceleration: rec._volumeAccel || null,
        score:               rec.setupScore   || null,
      });
      dtSaveSnapshot(rec, 'intraday', itSig, state.macroData || {}, entryPrice, qty)
        .then(function(snapId) { if (snapId) newPos._snapshotId = snapId; scheduleSave(); });
    }

    renderPage();
  });
}

// ── Show close dialog, then close the position ────────────────────────────────

function _showCloseIntradayDialog(posId, suggestedPrice) {
  if (!state.intraday) return;
  const pos = (state.intraday.openPositions || []).find(p => p.id === posId);
  if (!pos) return;

  _showTradeDialog({
    ticker: pos.ticker,
    action: 'SELL',
    qty:    pos.qty,
    defaultPrice: suggestedPrice || pos.target || pos.entryPrice,
    readOnlyQty: true,   // closing the full position; qty is not editable here
  }, (closePrice, brokerage) => {
    closeIntradayPosition(posId, closePrice, brokerage);
  });
}

function closeIntradayPosition(posId, closePrice, brokerage) {
  if (!state.intraday || !closePrice || isNaN(closePrice)) return;
  const pos = (state.intraday.openPositions || []).find(p => p.id === posId);
  if (!pos) return;

  const sellFee   = (brokerage != null && !isNaN(brokerage)) ? brokerage : ((state.settings && state.settings.brokerage) || 10);
  const buyFee    = (pos.entryFees != null) ? pos.entryFees : ((state.settings && state.settings.brokerage) || 10);
  const gross     = (closePrice - pos.entryPrice) * pos.qty;
  const net       = gross - sellFee - buyFee;   // net P&L after both legs of brokerage

  if (!state.intraday.todayPnl) state.intraday.todayPnl = 0;
  state.intraday.todayPnl += net;
  state.intraday.pnlDate   = todayStr();   // stamp date so day-change reset works

  // Remove the 'trading' portfolio holding and write a CGT disposal.
  // applySellToPortfolio also credits cash internally — do not credit manually.
  const { ok: soldOk } = applySellToPortfolio(
    pos.ticker, pos.qty, closePrice, sellFee, todayStr(),
    state.cgtMethod || 'FIFO', 'trading'
  );
  // Fallback cash credit for positions opened before the portfolio fix was deployed.
  if (!soldOk) state.cash += pos.qty * closePrice - sellFee;

  // Patch the open BUY journal entry written at entry time, or create a fallback
  // combined entry for positions opened before this fix was deployed.
  const sector = (state.liveSignals?.[pos.ticker] || {}).sector || 'Other';
  if (!state.tradeJournal) state.tradeJournal = [];
  const pairedBuyEntry = pos._journalId
    ? state.tradeJournal.find(e => e.id === pos._journalId)
    : null;
  if (pairedBuyEntry) {
    pairedBuyEntry.exitPrice  = closePrice;
    pairedBuyEntry.fees       = sellFee + buyFee;
    pairedBuyEntry.pnl        = net;
    pairedBuyEntry.status     = 'closed';
    pairedBuyEntry.closeDate  = todayStr();
    pairedBuyEntry.sector     = pairedBuyEntry.sector || sector;
  } else {
    state.tradeJournal.unshift({
      id:          Date.now(),
      date:        todayStr(),
      ticker:      pos.ticker,
      action:      'SELL',
      qty:         pos.qty,
      entryPrice:  pos.entryPrice,
      exitPrice:   closePrice,
      fees:        sellFee + buyFee,
      pnl:         net,
      status:      'closed',
      sector,
      account:     'trading',
      notes:       'Intraday same-day close',
      closeDate:   todayStr(),
    });
  }

  state.intraday.openPositions = state.intraday.openPositions.filter(p => p.id !== posId);

  // Record close outcome in ML snapshot
  if (typeof dtCloseSnapshot === 'function' && pos._snapshotId) {
    const pnlPct = pos.entryPrice ? (closePrice - pos.entryPrice) / pos.entryPrice * 100 : null;
    const exitReason = typeof dtInferExitReason === 'function'
      ? dtInferExitReason(closePrice, pos.entryPrice, pos.target, pos.stop, 'BUY')
      : 'manual';
    dtCloseSnapshot(pos._snapshotId, {
      exit_price: closePrice,
      entry_price: pos.entryPrice,
      exit_date: todayStr(),
      exit_reason: exitReason,
      actual_hold_days: 0,
      pnl_pct: pnlPct,
    });
  }

  scheduleSave();
  if (typeof pushCashToDb === 'function') pushCashToDb(state.cash);
  const sign = net >= 0 ? '+' : '';
  toast(`Closed ${pos.ticker}: ${sign}$${net.toFixed(2)} (buy $${buyFee} + sell $${sellFee} fees)`, net >= 0 ? 'success' : 'warning');
  renderPage();
}

// ── Close / record exit for an executed swing trade ──────────────────────────
// Opens _showTradeDialog (SELL) then journals the exit, updates cash, marks rec.

function _closeDayTrade(recId) {
  const rec = (state.dayTrading && state.dayTrading.recommendations || []).find(r => r.id === recId);
  if (!rec || rec.status !== 'executed') return;

  // Locate the open journal entry so we can read the actual entry price and fee
  const journalEntry = (state.tradeJournal || []).find(e => e.recId === rec.id && e.status === 'open');
  const entryPrice   = journalEntry ? journalEntry.entryPrice : (rec.priceRange ? rec.priceRange[0] : 0);
  const buyFee       = journalEntry ? (journalEntry.fees || 0) : ((state.settings && state.settings.brokerage) || 10);

  // Pre-fill close price with target (best case) so user edits down if needed
  const suggestedClose = rec.target || entryPrice;

  // Use actual executed qty (may differ from AI-suggested rec.qty if user adjusted at entry)
  const execQty = rec._execQty || journalEntry?.qty || rec.qty;

  _showTradeDialog({
    ticker: rec.ticker,
    action: 'SELL',
    qty:    execQty,
    defaultPrice: suggestedClose,
    readOnlyQty: true,   // closing the full (executed) position; qty is not editable here
  }, (closePrice, sellFee) => {
    // Use the canonical helper so the CGT page sees the disposal and portfolio
    // holding is removed.  applySellToPortfolio also credits cash internally.
    const prevDisposalLen = (state.cgtDisposals || []).length;
    const { ok: soldOk, disposals } = applySellToPortfolio(
      rec.ticker, execQty, closePrice, sellFee, todayStr(),
      state.cgtMethod || 'FIFO', 'trading'
    );

    let net;
    if (soldOk && disposals.length) {
      // P&L = sum of gross gains (each parcel's proceeds - cost basis - allocated sell fee).
      // Buy fee is already embedded in each parcel's costPerShare via applyBuyToPortfolio.
      net = disposalsToPnl(disposals);
      // Cash already credited inside applySellToPortfolio — do not add again.
    } else {
      // Fallback: portfolio entry missing (swing rec executed before this fix was deployed).
      // Fall back to manual arithmetic and credit cash the old way.
      const gross = (closePrice - entryPrice) * execQty;
      net = gross - sellFee - buyFee;
      state.cash += execQty * closePrice - sellFee;
    }

    // Update or create journal entry
    if (journalEntry) {
      journalEntry.exitPrice   = closePrice;
      journalEntry.fees        = buyFee + sellFee;
      journalEntry.pnl         = net;
      journalEntry.status      = 'closed';
      journalEntry.closeDate   = todayStr();
      if (soldOk && disposals.length) {
        journalEntry.disposalIds = disposals.map((_, i) => prevDisposalLen + i);
      }
    } else {
      if (!state.tradeJournal) state.tradeJournal = [];
      state.tradeJournal.unshift({
        id:          Date.now(),
        date:        todayStr(),
        ticker:      rec.ticker,
        action:      'SELL',
        qty:         execQty,
        entryPrice,
        exitPrice:   closePrice,
        fees:        buyFee + sellFee,
        pnl:         net,
        status:      'closed',
        recId:       rec.id,
        closeDate:   todayStr(),
        disposalIds: soldOk && disposals.length
          ? disposals.map((_, i) => prevDisposalLen + i)
          : undefined,
        notes:       `SwingTrade close | Stop $${rec.stopLoss} | Target $${rec.target}`,
      });
    }

    rec.status      = 'closed';
    rec._closedAt   = todayStr();
    rec._closePrice = closePrice;

    // Record close outcome in ML snapshot
    if (typeof dtCloseSnapshot === 'function' && rec._snapshotId) {
      const pnlPct = entryPrice ? (closePrice - entryPrice) / entryPrice * 100 : null;
      const holdDays = journalEntry && journalEntry.date
        ? Math.round((Date.now() - new Date(journalEntry.date).getTime()) / 86400000)
        : null;
      const exitReason = typeof dtInferExitReason === 'function'
        ? dtInferExitReason(closePrice, entryPrice, rec.target, rec.stopLoss, 'BUY')
        : 'manual';
      dtCloseSnapshot(rec._snapshotId, {
        exit_price: closePrice,
        entry_price: entryPrice,
        exit_date: todayStr(),
        exit_reason: exitReason,
        actual_hold_days: holdDays,
        pnl_pct: pnlPct,
      });
    }

    scheduleSave();
    if (typeof pushCashToDb === 'function') pushCashToDb(state.cash);
    const sign = net >= 0 ? '+' : '';
    toast(`Closed swing ${rec.ticker}: ${sign}$${net.toFixed(2)} (buy $${buyFee} + sell $${sellFee} fees)`, net >= 0 ? 'success' : 'warning');
    renderPage();
  });
}

// ── Update a single intraday parameter ───────────────────────────────────────

function updateIntradayParam(key, val) {
  if (!state.intraday) return;
  if (key === 'autoRefresh') {
    state.intraday.autoRefresh = !!val;
  } else {
    if (!state.intraday.params) state.intraday.params = {};
    state.intraday.params[key] = val;
  }
  scheduleSave();
  renderPage();
}
