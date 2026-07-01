// ============================================================
// DAY TRADING PAGE
// ============================================================

// Signal display labels — must match what the AI returns in signalsHit[]
const _DT_SIGNALS = ['BB Primary', 'RSI<35', 'Vol Z-Score', 'Fib Zone', 'OBV div'];
// Keywords used to match AI-returned signal strings (case-insensitive)
const _DT_SIG_KEYS = ['bb', 'rsi', 'vol', 'fib', 'obv'];

// ── Time-based exit helpers ───────────────────────────────────────────────

// Approximate trading days elapsed from entryDateStr (YYYY-MM-DD) to today.
// Formula: calendarDays × (5/7) — sufficient precision for a 8–15 day window.
function _dtTradingDaysElapsed(entryDateStr) {
  if (!entryDateStr) return 0;
  var entry = new Date(entryDateStr);
  var calendarMs = Date.now() - entry.getTime();
  if (calendarMs < 0) return 0;
  return Math.floor((calendarMs / 86400000) * 5 / 7);
}

// Regime-aware max hold in trading days. Uses CURRENT regime (not entry regime).
// highVol/riskOff: mean-reversion must happen fast or the trade is failing.
// riskOn/trend:    slow grind — give it room to work before forcing exit.
function _dtMaxHoldDays() {
  var TIME_STOP_DAYS = { riskOn: 15, trend: 15, sideways: 12, highVol: 10, riskOff: 8 };
  var regime = (state.currentRegime && state.currentRegime.regime) || 'sideways';
  return TIME_STOP_DAYS[regime] != null ? TIME_STOP_DAYS[regime] : 12;
}

// Returns HTML badge for time-stop warning on executed swing recs.
// Warn at 80% of limit (amber), alert at 100% (red). Returns '' when not near limit.
function _dtTimeStopBadge(r) {
  if (!r || r.status !== 'executed' || !r.date) return '';
  var days = _dtTradingDaysElapsed(r.date);
  var maxDays = _dtMaxHoldDays();
  var pct = maxDays > 0 ? days / maxDays : 0;
  if (pct >= 1.0) {
    return '<span style="background:#ef4444;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px" title="Time stop exceeded — close by EOD">⏰ TIME STOP ' + days + 'd/' + maxDays + 'd</span>';
  } else if (pct >= 0.8) {
    return '<span style="background:#f59e0b;color:#000;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px" title="Approaching time stop — monitor closely">⏱ ' + days + 'd/' + maxDays + 'd</span>';
  }
  return '';
}

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
      <button class="tab ${activeTab === 'setups'   ? 'active' : ''}" id="dt-tab-setups"   onclick="switchDtTab('setups')">Swing day-trading</button>
      <button class="tab ${activeTab === 'intraday' ? 'active' : ''}" id="dt-tab-intraday" onclick="switchDtTab('intraday')">⚡ Intraday</button>
      <button class="tab ${activeTab === 'history'  ? 'active' : ''}" id="dt-tab-history"  onclick="switchDtTab('history')">📋 History</button>
      <button class="tab ${activeTab === 'model'    ? 'active' : ''}" id="dt-tab-model"    onclick="switchDtTab('model')">🧠 Model</button>
    </div>
    <div id="dt-tab-content">
      ${activeTab === 'setups'   ? _renderDtSetupsTab()
        : activeTab === 'intraday' ? _renderDtIntradayTab()
        : activeTab === 'history'  ? renderDtHistoryTab()
        : renderDtModelTab()}
    </div>
  `;
}

function switchDtTab(tab) {
  // 'rules' was a top-level tab — redirect to swing setups rules sub-tab
  if (tab === 'rules') { switchDtTab('setups'); switchSwingSubTab('rules'); return; }
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
    _dtHistItems = null; _dtHistOffset = 0; _dtHistMore = false; _dtStats = null; _dtHistLoading = false;
    el.innerHTML = renderDtHistoryTab();
  } else {
    _dtModel = undefined;
    _dtStats = null;
    Promise.all([dtLoadModelWithImportances(), dtLoadStats()]).then(function() {
      if ((state.dayTrading && state.dayTrading.activeTab) === 'model') {
        el.innerHTML = renderDtModelTab();
      }
    });
    el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted)">Loading model…</div>';
  }
}

function switchSwingSubTab(subTab) {
  if (!state.dayTrading) return;
  state.dayTrading._swingSubTab = subTab;
  const el = document.getElementById('dt-tab-content');
  if (el) { el.innerHTML = _renderDtSetupsTab(); if (subTab === 'setups') _renderDtExtraChips(); }
}

function switchIntradaySubTab(subTab) {
  if (!state.intraday) return;
  state.intraday._subTab = subTab;
  const el = document.getElementById('dt-tab-content');
  if (el) el.innerHTML = _renderDtIntradayTab();
}

function _renderDtSetupsTab() {
  const subTab = (state.dayTrading && state.dayTrading._swingSubTab) || 'setups';
  const subTabs = `
    <div class="tabs tabs-sm" style="margin-bottom:14px;border-bottom:0.5px solid var(--border-light);padding-bottom:0">
      <button class="tab ${subTab === 'setups' ? 'active' : ''}" style="font-size:12px;padding:5px 14px"
        onclick="switchSwingSubTab('setups')">Setups</button>
      <button class="tab ${subTab === 'rules' ? 'active' : ''}" style="font-size:12px;padding:5px 14px"
        onclick="switchSwingSubTab('rules')">⚙ Rules</button>
    </div>`;
  if (subTab === 'rules') return subTabs + _renderDtRulesTab();
  return subTabs + _renderDtSwingMain();
}

function _renderDtSwingMain() {
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
          Scans for swing-trade setups (5–15 day holds) using orthogonal confluence. Requires BB Primary
          + ticked confirmations, plus all hard filters (liquidity, SMA200, ADX, no catalyst).
          Choose what to scan below, then run.
        </p>
        <div style="display:flex;gap:7px;flex-wrap:wrap">
          ${_renderDtUniverseSelectorHtml()}
        </div>
        ${summaryHtml}
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" ${dt.analysisRunning ? 'disabled' : ''}
            onclick="runDayTradeAnalysis()"
            style="display:flex;align-items:center;gap:7px">
            ${dt.analysisRunning
              ? '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Scanning…'
              : '▶ Run Day Trade Scan (' + _dtUniverseLabel(dt.universeKey) + ')'}
          </button>
          ${(dt.analysisRunning && dt.scanProgress != null)
            ? '<button class="btn btn-sm" onclick="cancelUniverseScan()" style="color:#ef4444;border-color:#ef4444;font-size:11px">✕ Cancel</button>'
            : ''}
        </div>
        ${(dt.analysisRunning && dt.scanProgress != null) ? `<div id="dt-universe-progress">${_renderUniverseProgressHtml()}</div>` : ''}
      </div>
    </div>

    <!-- Signal legend -->
    <div class="card" style="margin-bottom:14px;padding:10px 14px">
      <div style="font-size:11px;color:var(--text-muted);display:flex;flex-wrap:wrap;gap:12px;align-items:center">
        <span><b>#1 PRIMARY:</b> BB reclaim</span>
        <span><b>#2:</b> RSI&lt;${ap.rsiThreshold} turning up</span>
        <span><b>#3:</b> Vol Z-Score &gt;${ap.volZScore}σ</span>
        <span><b>#4:</b> Fib zone (60d return ${ap.fibReturnMin}% to ${ap.fibReturnMax}%)</span>
        <span><b>#5:</b> OBV div. (bonus)</span>
        <span style="margin-left:auto;color:var(--text-tertiary)"><button class="btn btn-sm" style="font-size:10px;padding:2px 7px" onclick="switchSwingSubTab('rules')">⚙ Edit rules</button></span>
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

const _DT_FILTER_DEFAULTS = {
  maxBbPctB: 0.20, minAdvAud: 1500000, sma200Floor: 0.985, sma50Floor: 0.970,
  maxAdx: 35, minAdr: 0.25, vovMult: 1.3, timeOfWeekFilter: true,
  enabled: { maxBbPctB: true, minAdvAud: true, sma200Floor: true, sma50Floor: true, maxAdx: true, minAdr: true, vovMult: true },
};
// rsiThreshold/volZScore default ON, fibZone/obvRising default OFF — approximates
// the old "Signal #1 + any 2 of 4" combination rule's default strictness (2
// signals) as a fixed AND-subset, since "any N of M" isn't representable by
// per-signal on/off alone. Freely re-enable fibZone/obvRising — this is just
// a starting point, not a hard recommendation.
const _DT_AI_DEFAULTS     = {
  stopAtrMultiple: 2.5, minRrRatio: 2.0, minConfidence: 0.50, maxPositionPct: 20,
  rsiThreshold: 35, volZScore: 1.5, fibReturnMin: -20, fibReturnMax: -5,
  enabled: { minRrRatio: true, minConfidence: true, rsiThreshold: true, volZScore: true, fibZone: false, obvRising: false },
};

function _renderDtRulesTab() {
  const fp = { ..._DT_FILTER_DEFAULTS, ...(state.dayTrading.filterParams || {}),
               enabled: { ..._DT_FILTER_DEFAULTS.enabled, ...((state.dayTrading.filterParams || {}).enabled || {}) } };
  const ap = { ..._DT_AI_DEFAULTS,     ...(state.dayTrading.aiParams     || {}),
               enabled: { ..._DT_AI_DEFAULTS.enabled,     ...((state.dayTrading.aiParams     || {}).enabled || {}) } };

  const fpModified = Object.keys(_DT_FILTER_DEFAULTS).some(k => k !== 'enabled' && fp[k] !== _DT_FILTER_DEFAULTS[k])
    || Object.keys(_DT_FILTER_DEFAULTS.enabled).some(k => fp.enabled[k] !== _DT_FILTER_DEFAULTS.enabled[k]);
  const apModified = Object.keys(_DT_AI_DEFAULTS).some(k => k !== 'enabled' && ap[k] !== _DT_AI_DEFAULTS[k])
    || Object.keys(_DT_AI_DEFAULTS.enabled).some(k => ap.enabled[k] !== _DT_AI_DEFAULTS.enabled[k]);
  const anyModified = fpModified || apModified;

  // One table row: checkbox (rule on/off) + label/hint + value input(s).
  // valueHtml is pre-built per-row since some rules have 2 inputs (Fib zone)
  // and some have none (OBV rising, time-of-week — pure boolean rules).
  const row = (group, key, label, hint, valueHtml) => `
    <tr>
      <td style="width:28px;text-align:center">
        <input type="checkbox" ${_ruleOn({enabled: (group==='filterParams'?fp:ap).enabled}, key) ? 'checked' : ''}
          onchange="setDtRuleEnabled('${group}','${key}',this.checked)" title="Enable/disable this rule">
      </td>
      <td style="padding:4px 8px">
        <div style="font-size:12px;font-weight:600">${label}</div>
        <div class="text-xs text-muted">${hint}</div>
      </td>
      <td style="text-align:right;white-space:nowrap">${valueHtml || ''}</td>
    </tr>`;

  const numInput = (group, key, value, min, max, step) => `
    <input type="number" value="${value}" min="${min}" max="${max}" step="${step}" style="width:100px"
      onchange="setDtParam('${group}','${key}',this.value)">`;

  return `
    <div style="display:flex;flex-direction:column;gap:14px">

      ${anyModified ? `
      <div style="background:var(--warn-bg);border:1px solid var(--warn);border-radius:var(--radius-md);padding:10px 14px;font-size:12px;color:var(--warn);display:flex;align-items:center;justify-content:space-between">
        <span>Custom scanner rules active. Pre-filter applied immediately — AI params injected on next scan.</span>
        <button class="btn btn-sm" onclick="resetDtRules()" style="white-space:nowrap;color:var(--warn)">↺ Reset all</button>
      </div>` : `
      <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 14px;font-size:12px;color:var(--text-muted)">
        Using default scanner rules. Tick/untick rules or edit thresholds below — pre-filter applies immediately, AI params on next scan.
      </div>`}

      <!-- Pre-filter rules -->
      <div class="card">
        <div class="card-title">
          Pre-filter Rules
          <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:6px">applied client-side — AI never sees tickers that fail a TICKED rule</span>
        </div>
        <table class="dt-rules-table" style="width:100%;margin-top:8px">
          <tbody>
            ${row('filterParams', 'maxBbPctB', 'BB %B ceiling', 'Price must be at/below this Bollinger %B level (0 = at lower band)',
              numInput('filterParams', 'maxBbPctB', fp.maxBbPctB, 0, 1, 0.01))}
            ${row('filterParams', 'minAdvAud', 'Min liquidity (ADV $AUD)', '20-day average daily value — liquidity floor',
              numInput('filterParams', 'minAdvAud', fp.minAdvAud, 0, 50000000, 100000))}
            ${row('filterParams', 'sma200Floor', 'SMA200 floor (ratio)', 'Price must be ≥ SMA200 × this (0.985 = within 1.5% below SMA200)',
              numInput('filterParams', 'sma200Floor', fp.sma200Floor, 0.80, 1.05, 0.005))}
            ${row('filterParams', 'sma50Floor', 'SMA50 floor (fallback, <200d listings)', 'Used instead of SMA200 floor when a ticker has under 200 days of history',
              numInput('filterParams', 'sma50Floor', fp.sma50Floor, 0.80, 1.05, 0.005))}
            ${row('filterParams', 'maxAdx', 'ADX ceiling', 'Skip stocks already in a strong, confirmed uptrend',
              numInput('filterParams', 'maxAdx', fp.maxAdx, 10, 60, 1))}
            ${row('filterParams', 'minAdr', 'Market breadth floor (ADR)', 'Suppress ALL new BUYs when ASX200 advance/decline ratio is below this',
              numInput('filterParams', 'minAdr', fp.minAdr, 0, 1, 0.05))}
            ${row('filterParams', 'vovMult', 'Volatility expansion ceiling (VoV)', 'Skip when ATR14 is expanding rapidly vs its recent baseline (stop distance already stale)',
              numInput('filterParams', 'vovMult', fp.vovMult, 0.5, 4, 0.1))}
          </tbody>
        </table>
        <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;cursor:pointer">
          <input type="checkbox" ${fp.timeOfWeekFilter ? 'checked' : ''} onchange="setDtParam('filterParams','timeOfWeekFilter',this.checked)">
          Block entries Monday before 11:00 AEST / Friday from 14:00 AEST (gap-risk window)
        </label>
      </div>

      <!-- Sizing parameters (not pass/fail rules — always applied to whatever qualifies) -->
      <div class="card">
        <div class="card-title">
          Sizing Parameters
          <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:6px">no on/off — these size the trade, not gate it</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:8px">
          <div>
            <div class="form-label">Stop ATR multiple</div>
            ${numInput('aiParams', 'stopAtrMultiple', ap.stopAtrMultiple, 0.5, 6, 0.5)}
            <div class="text-xs text-muted mt-1">Stop = entry − N×ATR14</div>
          </div>
          <div>
            <div class="form-label">Max position (% of allocated)</div>
            ${numInput('aiParams', 'maxPositionPct', ap.maxPositionPct, 5, 100, 5)}
            <div class="text-xs text-muted mt-1">Max single position as % of allocated day-trade capital</div>
          </div>
        </div>
      </div>

      <!-- AI / Entry Signal rules -->
      <div class="card">
        <div class="card-title">
          AI &amp; Entry Signal Rules
          <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:6px">every TICKED rule below must pass — untick to exclude it entirely</span>
        </div>
        <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:8px 12px;margin:8px 0 0;font-size:11px;color:var(--text-muted)">
          Signal #1 (BB reclaim) is automatic — guaranteed by the pre-filter's BB %B rule above, so it isn't shown as its own row here.
        </div>
        <table class="dt-rules-table" style="width:100%;margin-top:8px">
          <tbody>
            ${row('aiParams', 'minRrRatio', 'Min reward:risk ratio', 'Reject setups with reward:risk below this',
              numInput('aiParams', 'minRrRatio', ap.minRrRatio, 0.5, 5, 0.25))}
            ${row('aiParams', 'minConfidence', 'Min AI confidence', 'Recs below this confidence are dropped client-side',
              numInput('aiParams', 'minConfidence', ap.minConfidence, 0.20, 1, 0.05))}
            ${row('aiParams', 'rsiThreshold', 'RSI oversold (Signal #2)', 'RSI must be below this level',
              numInput('aiParams', 'rsiThreshold', ap.rsiThreshold, 20, 55, 1))}
            ${row('aiParams', 'volZScore', 'Volume surge (Signal #3)', 'Volume Z-score must be at/above this',
              numInput('aiParams', 'volZScore', ap.volZScore, 0.25, 4, 0.25))}
            ${row('aiParams', 'fibZone', 'Fib retracement zone (Signal #4)', '60-day return must fall within this range',
              numInput('aiParams', 'fibReturnMin', ap.fibReturnMin, -60, -5, 1) + ' to ' + numInput('aiParams', 'fibReturnMax', ap.fibReturnMax, -30, -1, 1))}
            ${row('aiParams', 'obvRising', 'OBV rising (Signal #5, bonus)', 'On-balance volume trend must be rising — no threshold, pure on/off', '')}
          </tbody>
        </table>
      </div>

      <!-- Always-applied quant engine checks — NOT part of the toggle system above -->
      <div class="card">
        <div class="card-title">
          Always-Applied Quant Engine Checks
          <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:6px">not togglable — risk-management floors, not preferences</span>
        </div>
        <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:8px 12px;margin:8px 0;font-size:11px;color:var(--text-muted)">
          Every candidate that clears the rules above still passes through the deterministic sizing engine (<code>computeTradeParams()</code>). These 9 checks always run regardless of what's ticked above — a candidate can pass every visible rule and still be rejected here. Counts below are from the most recent scan.
        </div>
        ${_renderDtQuantChecksTable()}
      </div>

      <!-- Footer -->
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-size:13px;font-weight:600">Scanner rules applied</div>
          <div class="text-xs text-muted">Pre-filter is live · AI params injected on next scan run</div>
        </div>
        <div class="flex-row">
          <button class="btn btn-sm" onclick="resetDtRules()">↺ Reset to defaults</button>
          <button class="btn btn-primary btn-sm" onclick="switchSwingSubTab('setups');setTimeout(runDayTradeAnalysis,50)">▶ Run Scan Now</button>
        </div>
      </div>

    </div>
  `;
}

// Renders the "Always-Applied Quant Engine Checks" table. Reads counts from
// state.dayTrading.lastSummary.quantStats (populated by _dtBuildRecs() via the
// quantStats accumulator — see js/day-trading-analysis.js). Empty/undefined
// until the first scan of the session runs.
const _DT_QUANT_CHECK_DESCRIPTIONS = {
  noSignals:     'Live signals unavailable for the ticker at scan time',
  noWinProb:     'Confidence value missing going into sizing',
  noAtr:         'Price or ATR14 unavailable — can\'t place a stop',
  noTarget:      'No valid target found above entry price',
  rrFloor:       'Reward:risk below the minimum floor (duplicates the "Min reward:risk ratio" row above — sizing enforces it independently)',
  noLiquidity:   '20-day ADV data unavailable — liquidity cap can\'t be computed',
  negativeKelly: 'Kelly fraction ≤ 0 — the trade has negative expected value',
  sizingZero:    'Risk/position/liquidity constraints combined size the trade to 0 shares',
  minTradeSize:  'Position too small vs. the configured minimum trade notional',
  other:         'Rejected by computeTradeParams() for another reason',
};

function _renderDtQuantChecksTable() {
  const qs = state.dayTrading.lastSummary?.quantStats || {};
  const rows = Object.keys(_DT_QUANT_CHECK_DESCRIPTIONS).map(key => {
    const n = qs[key] || 0;
    return `
      <tr>
        <td style="padding:4px 8px">
          <div style="font-size:12px;font-weight:600">${DT_QUANT_REJECT_LABELS[key] || key}</div>
          <div class="text-xs text-muted">${_DT_QUANT_CHECK_DESCRIPTIONS[key]}</div>
        </td>
        <td style="text-align:right;white-space:nowrap;font-size:12px;font-weight:${n ? 700 : 400};color:${n ? 'var(--warn)' : 'var(--text-muted)'}">${n || '—'}</td>
      </tr>`;
  }).join('');
  return `
    <table class="dt-rules-table" style="width:100%;margin-top:4px">
      <tbody>${rows}</tbody>
    </table>`;
}

function setDtRuleEnabled(group, key, checked) {
  if (!state.dayTrading[group]) state.dayTrading[group] = {};
  if (!state.dayTrading[group].enabled) state.dayTrading[group].enabled = {};
  state.dayTrading[group].enabled[key] = !!checked;
  scheduleSave();
  const el = document.getElementById('dt-tab-content');
  // Must re-render via _renderDtSetupsTab() (not _renderDtRulesTab() alone) —
  // the latter omits the "Setups / ⚙ Rules" sub-tab bar that wraps it, which
  // made every checkbox toggle silently drop those tab buttons until the user
  // navigated away and back to force a full re-render.
  if (el) el.innerHTML = _renderDtSetupsTab();
}

function setDtParam(group, key, rawValue) {
  // Boolean fields (e.g. timeOfWeekFilter, bound to a checkbox's .checked)
  // must not go through Number() — Number(true)/Number(false) coerce to 1/0,
  // silently corrupting the field into a number where boolean logic expects
  // true/false.
  const value = typeof rawValue === 'boolean' ? rawValue : Number(rawValue);
  if (!state.dayTrading[group]) state.dayTrading[group] = {};
  state.dayTrading[group][key] = value;
  scheduleSave();
  // Refresh the active-params summary line on the setups tab if visible
  const el = document.getElementById('dt-tab-content');
  if (el && (state.dayTrading.activeTab || 'setups') === 'setups' &&
      (state.dayTrading._swingSubTab || 'setups') === 'rules') {
    const badge = el.querySelector('[data-dt-active-params]');
    if (badge) {
      const fp = { ..._DT_FILTER_DEFAULTS, ...(state.dayTrading.filterParams || {}) };
      badge.textContent = `Active: BB %B ≤ ${fp.maxBbPctB} · ADV ≥ $${(fp.minAdvAud/1000).toFixed(0)}k · SMA200 floor ${(fp.sma200Floor*100).toFixed(1)}% · ADX ≤ ${fp.maxAdx}`;
    }
  }
}

function resetDtRules() {
  // Deep-copy `enabled` — a shallow {..._DT_FILTER_DEFAULTS} would leave
  // filterParams.enabled pointing at the SAME object as the shared defaults
  // constant, so the next setDtRuleEnabled() call would mutate the defaults
  // themselves (corrupting every future reset for the rest of the session).
  state.dayTrading.filterParams = { ..._DT_FILTER_DEFAULTS, enabled: { ..._DT_FILTER_DEFAULTS.enabled } };
  state.dayTrading.aiParams     = { ..._DT_AI_DEFAULTS,     enabled: { ..._DT_AI_DEFAULTS.enabled } };
  scheduleSave();
  const el = document.getElementById('dt-tab-content');
  if (el) el.innerHTML = _renderDtSetupsTab();
  toast('Swing scanner rules reset to defaults', 'success');
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
    <div class="card" style="border-left:3px solid ${borderColor};padding:12px 14px${(isStale || r._stale) ? ';opacity:.75' : ''}">
      <div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap">

        <!-- Left: ticker + signals -->
        <div style="min-width:200px;flex:1">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
            <span style="font-size:16px;font-weight:700">${r.ticker}</span>
            <span style="background:#f59e0b;color:#000;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px">BUY</span>
            ${isExecuted ? `<span style="background:#6366f1;color:#fff;font-size:10px;padding:2px 7px;border-radius:4px">EXECUTED</span>` : ''}
            ${isClosed   ? `<span style="background:#059669;color:#fff;font-size:10px;padding:2px 7px;border-radius:4px">CLOSED</span>` : ''}
            ${isStale    ? `<span style="background:#ef444422;color:#ef4444;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px" title="Setup is ${recAgeDays}d old — signals may no longer be valid">⚠ STALE ${recAgeDays}d</span>` : ''}
            ${r._stale   ? `<span style="background:#f59e0b22;color:#f59e0b;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px" title="Did not reappear in the latest universe scan (missed ${r._staleScans || 1}/${3} scan(s)) — kept until it reappears or expires">⚠ NOT IN LATEST SCAN</span>` : ''}
            ${r.holdDays ? `<span style="font-size:11px;color:var(--text-muted)">${r.holdDays}d hold est.</span>` : ''}
            ${isPending && typeof dtWinProbLabel === 'function' ? dtWinProbLabel(r) : ''}
            ${isExecuted ? _dtTimeStopBadge(r) : ''}
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

// ── Universe selector (merged into the "Run Day Trade Scan" card) ────────────
// Replaces the old separate "ASX Index Scanner" card + "Scan ASX N" button —
// the selector now controls what runDayTradeAnalysis() scans directly
// (see the dispatcher in day-trading-analysis.js).

function _dtUniverseLabel(key) {
  if (!key || key === 'portfolio_watchlist') return 'Portfolio+Watchlist';
  return (ASX_UNIVERSE_META[key] || {}).label || key;
}

function _renderDtUniverseSelectorHtml() {
  const dt = state.dayTrading;
  const uKey = dt.universeKey || 'portfolio_watchlist';
  const isScanning = dt.analysisRunning;
  const portfolioTickers = mergedPortfolio().map(h => h.ticker);
  const pwCount = new Set([...portfolioTickers, ...(dt.extraTickers || [])]).size;

  const options = [
    { key: 'portfolio_watchlist', label: 'Portfolio+Watchlist', desc: 'Your current holdings + day-trade watchlist tickers only.', count: pwCount },
    ...['asx20', 'asx50', 'asx100', 'asx200'].map(k => ({
      key: k, label: ASX_UNIVERSE_META[k].label, desc: ASX_UNIVERSE_META[k].desc, count: getUniverseTickers(k).length,
    })),
  ];

  return options.map(({ key, label, desc, count }) => {
    const active = key === uKey;
    return `<button
      class="btn btn-sm"
      onclick="state.dayTrading.universeKey='${key}';scheduleSave();renderPage()"
      style="font-size:11px;font-weight:${active ? '700' : '400'};background:${active ? '#6366f1' : 'var(--bg-secondary)'};color:${active ? '#fff' : 'var(--text-secondary)'};border-color:${active ? '#6366f1' : 'var(--border-medium)'}"
      ${isScanning ? 'disabled' : ''}
      title="${desc}"
    >${label} <span style="opacity:.7">(${count})</span></button>`;
  }).join('');
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
  const subTab = (state.intraday._subTab) || 'setups';
  const subTabs = `
    <div class="tabs tabs-sm" style="margin-bottom:14px;border-bottom:0.5px solid var(--border-light);padding-bottom:0">
      <button class="tab ${subTab === 'setups' ? 'active' : ''}" style="font-size:12px;padding:5px 14px"
        onclick="switchIntradaySubTab('setups')">Setups</button>
      <button class="tab ${subTab === 'rules' ? 'active' : ''}" style="font-size:12px;padding:5px 14px"
        onclick="switchIntradaySubTab('rules')">⚙ Rules</button>
    </div>`;
  if (subTab === 'rules') return subTabs + _renderIntradayRulesContent();
  return subTabs + _renderIntradaySetupsContent();
}

function _renderIntradayRulesContent() {
  const id = state.intraday;
  const IDEFS = INTRADAY_DEFAULTS;
  const ip = { ...IDEFS, ...(id.params || {}),
               enabled: { ...IDEFS.enabled, ...((id.params || {}).enabled || {}) } };
  const allocated = id.allocatedCash != null ? id.allocatedCash : Math.round(state.cash * ip.allocPct / 100);

  const anyModified = Object.keys(IDEFS).some(k => k !== 'enabled' && ip[k] !== IDEFS[k])
    || Object.keys(IDEFS.enabled).some(k => ip.enabled[k] !== IDEFS.enabled[k]);

  const nf = (label, key, value, min, max, step, hint, parser) => `
    <div>
      <div class="form-label">${label}</div>
      <input type="number" value="${value}" min="${min}" max="${max}" step="${step}" style="width:110px" title="${hint}"
        onchange="updateIntradayParam('${key}', ${parser || 'parseFloat'}(this.value))">
      <div class="text-xs text-muted mt-1" style="max-width:220px">${hint}</div>
    </div>`;

  // One table row: checkbox (rule on/off) + label/hint + value input.
  const row = (key, label, hint, valueHtml) => `
    <tr>
      <td style="width:28px;text-align:center">
        <input type="checkbox" ${_ruleOn(ip, key) ? 'checked' : ''}
          onchange="updateIntradayRuleEnabled('${key}',this.checked)" title="Enable/disable this rule">
      </td>
      <td style="padding:4px 8px">
        <div style="font-size:12px;font-weight:600">${label}</div>
        <div class="text-xs text-muted">${hint}</div>
      </td>
      <td style="text-align:right;white-space:nowrap">${valueHtml || ''}</td>
    </tr>`;

  const numInput = (key, value, min, max, step, parser) => `
    <input type="number" value="${value}" min="${min}" max="${max}" step="${step}" style="width:100px"
      onchange="updateIntradayParam('${key}', ${parser || 'parseFloat'}(this.value))">`;

  return `
    <div style="display:flex;flex-direction:column;gap:14px">

      ${anyModified ? `
      <div style="background:var(--warn-bg);border:1px solid var(--warn);border-radius:var(--radius-md);padding:10px 14px;font-size:12px;color:var(--warn);display:flex;align-items:center;justify-content:space-between">
        <span>Custom intraday rules active — applied on next scan.</span>
        <button class="btn btn-sm" onclick="resetIntradayRules()" style="white-space:nowrap;color:var(--warn)">↺ Reset all</button>
      </div>` : `
      <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 14px;font-size:12px;color:var(--text-muted)">
        Using default intraday rules. Tick/untick rules or edit thresholds below — changes apply on next scan.
      </div>`}

      <!-- Trade Parameters -->
      <div class="card">
        <div class="card-title">
          Trade Parameters
          <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:6px">sizing, stops &amp; targets — no on/off, always applied to whatever qualifies</span>
        </div>
        <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:8px 12px;margin:8px 0;font-size:11px;color:var(--text-muted)">
          Active: ATR stop ×<b>${ip.stopAtrMult}</b> · ATR target ×<b>${ip.targetAtrMult}</b> · Max <b>${ip.maxPositions}</b> positions · Alloc <b>${ip.allocPct}%</b> (=$${fmt(allocated, 0)})
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px">
          ${nf('ATR stop multiplier', 'stopAtrMult', ip.stopAtrMult, 0.5, 4, 0.25, 'Stop = entry − N × 5m ATR (when ≥15 bars). Higher = wider stop.')}
          ${nf('ATR target multiplier', 'targetAtrMult', ip.targetAtrMult, 0.5, 5, 0.25, 'Target = VWAP + N × 5m ATR. Higher = more ambitious exit.')}
          ${nf('Max positions', 'maxPositions', ip.maxPositions, 1, 5, 1, 'Maximum concurrent intraday trades', 'parseInt')}
          ${nf('Capital allocation (%)', 'allocPct', ip.allocPct, 5, 50, 5, 'Percentage of available cash allocated to intraday')}
        </div>
        <div style="margin-top:12px;padding:8px 10px;background:var(--bg-inset);border-radius:6px;font-size:11px;color:var(--text-muted)">
          Fallback (ATR unavailable): Target <b>+${ip.targetPct}%</b> · Stop <b>−${ip.stopPct}%</b>
          &nbsp;<span style="opacity:.6">|</span>&nbsp;
          ${nf('', 'targetPct', ip.targetPct, 1, 10, 0.5, 'Fallback target when ATR unavailable').replace('<div class="form-label"></div>','')}
          ${nf('', 'stopPct', ip.stopPct, 0.5, 5, 0.5, 'Fallback stop when ATR unavailable').replace('<div class="form-label"></div>','')}
        </div>
      </div>

      <!-- Entry Rules -->
      <div class="card">
        <div class="card-title">
          Entry Rules
          <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:6px">every TICKED rule below must pass — untick to exclude it entirely</span>
        </div>
        <table class="dt-rules-table" style="width:100%;margin-top:8px">
          <tbody>
            ${row('entryWindow', 'Entry window (10:45–15:00 AEST)', 'Hard market-structure constraint — untick only for testing outside market hours', '')}
            ${row('minScore', 'Min setup score', 'Setup quality composite score (0–100) — tickers below this are excluded',
              numInput('minScore', ip.minScore, 20, 90, 5, 'parseInt'))}
            ${row('minRrRatio', 'Min reward:risk ratio', 'Skip setups where (target−entry) / (entry−stop) is below this',
              numInput('minRrRatio', ip.minRrRatio, 0.5, 5, 0.25))}
            ${row('vwapThreshold', 'VWAP discount (confirmation signal)', 'Price must be ≤ this % from VWAP (negative = below). −0.3 = price is 0.3% below VWAP',
              numInput('vwapThreshold', ip.vwapThreshold, -5, 0, 0.1))}
            ${row('rsiThreshold', 'RSI oversold (confirmation signal)', 'Intraday 5m RSI must be at/below this value',
              numInput('rsiThreshold', ip.rsiThreshold, 20, 70, 1, 'parseInt'))}
            ${row('volRising', 'Volume rising (confirmation signal)', 'Last-3-bar avg volume must exceed the 20-bar baseline', '')}
            ${row('aboveOpen', 'Price above today\'s open (confirmation signal)', 'Current price must be above the session open', '')}
          </tbody>
        </table>

        <div style="margin-top:12px">
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
      </div>

      <!-- Info -->
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-size:13px;font-weight:600">How it works</div>
          <div class="text-xs text-muted">⏰ Entry window 10:45–15:00 AEST (untick above to bypass for testing) · ATR-based stops/targets use 5m bars (≥15 required); fixed-% fallback otherwise · confirmation signals computed client-side from raw scan data · yfinance 5m data has ~5–15 min latency</div>
        </div>
        <div class="flex-row">
          <button class="btn btn-sm" onclick="resetIntradayRules()">↺ Reset to defaults</button>
          <button class="btn btn-primary btn-sm" onclick="switchIntradaySubTab('setups');setTimeout(runIntradayScan,50)"
            style="background:#10b981;border-color:#10b981">⚡ Scan Now</button>
        </div>
      </div>

    </div>
  `;
}

function updateIntradayRuleEnabled(key, checked) {
  if (!state.intraday) return;
  if (!state.intraday.params) state.intraday.params = {};
  if (!state.intraday.params.enabled) state.intraday.params.enabled = {};
  state.intraday.params.enabled[key] = !!checked;
  scheduleSave();
  const el = document.getElementById('dt-tab-content');
  if (el) el.innerHTML = _renderDtIntradayTab();
}

function resetIntradayRules() {
  if (!state.intraday) return;
  // universeKey must reset to the literal default ('asx100'), not preserve
  // whatever the user last picked — preserving it here was silently keeping
  // _renderIntradayRulesContent()'s `anyModified` check permanently true
  // (it compares against the literal 'asx100' default), so the "Custom
  // intraday rules active" banner never cleared once the universe had ever
  // been changed, no matter how many times Reset all was clicked.
  // `enabled` is deep-copied — a shallow {...INTRADAY_DEFAULTS} would leave
  // params.enabled pointing at INTRADAY_DEFAULTS.enabled itself, so the next
  // updateIntradayRuleEnabled() call would mutate the shared defaults.
  state.intraday.params = {
    ...INTRADAY_DEFAULTS, universeKey: 'asx100',
    enabled: { ...INTRADAY_DEFAULTS.enabled },
  };
  scheduleSave();
  const el = document.getElementById('dt-tab-content');
  if (el) el.innerHTML = _renderDtIntradayTab();
  toast('Intraday rules reset to defaults', 'success');
}

function _renderIntradaySetupsContent() {
  const id = state.intraday;
  const ip = { ...INTRADAY_DEFAULTS, universeKey: 'asx100', ...(id.params || {}),
               enabled: { ...INTRADAY_DEFAULTS.enabled, ...((id.params || {}).enabled || {}) } };
  const allocated = id.allocatedCash != null
    ? id.allocatedCash
    : Math.round(state.cash * ip.allocPct / 100);
  const openPositions = id.openPositions || [];
  const recs = id.recommendations || [];
  const pending = recs.filter(r => r.status === 'pending');
  const scanInfo = id.lastScan;

  // SPI defensive mode: check if any scan result flagged spi_defensive
  const _spiDefensive = (id.recommendations || []).some(function(r) { return r.spi_defensive; });
  const _spiChg = (id.lastScan && id.recommendations && id.recommendations[0] && id.recommendations[0].spi_chg != null)
    ? id.recommendations[0].spi_chg : null;
  const spiWarningBanner = (_spiDefensive && _spiChg != null)
    ? `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:12px;color:#92400e">
        ⚠ <strong>SPI200 Defensive Mode</strong> — Futures ${_spiChg.toFixed(1)}% ≤ −1.5% before 11:00 AEST.
        VWAP Discount entries (Mode B) are disabled. Only VWAP Recapture setups would qualify.
       </div>`
    : '';

  // ── Action bar ────────────────────────────────────────────────────────────
  const universeLabel = scanInfo && scanInfo.universeLabel
    ? scanInfo.universeLabel
    : (ASX_UNIVERSE_META && ASX_UNIVERSE_META[ip.universeKey] ? ASX_UNIVERSE_META[ip.universeKey].label : ip.universeKey.toUpperCase());
  const scanStatus = scanInfo
    ? `Last scan: ${scanInfo.date} ${scanInfo.time} · ${scanInfo.universeLabel || universeLabel} · ${scanInfo.passed}/${scanInfo.total} passed · ${scanInfo.count} setup${scanInfo.count !== 1 ? 's' : ''}`
    : 'No scan run yet.';
  const actionBar = `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-size:13px;font-weight:600">ASX Intraday Scanner
            ${!_ruleOn(ip, 'entryWindow') ? '<span style="background:#ef4444;color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;margin-left:6px">⚠️ NO WINDOW</span>' : ''}
            ${Object.keys(INTRADAY_DEFAULTS.enabled).filter(k => k !== 'entryWindow' && !_ruleOn(ip, k)).length
              ? '<span style="background:#ef4444;color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;margin-left:6px">⚠️ RULES OFF</span>' : ''}
          </div>
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
      </div>
      <div style="margin-top:10px;padding-top:8px;border-top:0.5px solid var(--border-light);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          ${['asx20','asx50','asx100','asx200'].map(k => {
            const meta = (typeof ASX_UNIVERSE_META !== 'undefined' && ASX_UNIVERSE_META[k]) || { label: k.toUpperCase() };
            const active = ip.universeKey === k;
            return `<button class="btn btn-sm" onclick="updateIntradayParam('universeKey','${k}')"
              style="font-size:11px;padding:2px 8px;font-weight:${active ? '700' : '400'};background:${active ? '#10b981' : 'var(--bg-secondary)'};color:${active ? '#fff' : 'var(--text-secondary)'};border-color:${active ? '#10b981' : 'var(--border-medium)'}">
              ${meta.label}
            </button>`;
          }).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:10px">
          <span>Target <b>+${ip.targetPct}%</b> · Stop <b>−${ip.stopPct}%</b> · Score ≥ <b>${ip.minScore}</b></span>
          <button class="btn btn-sm" style="font-size:10px;padding:2px 7px" onclick="switchIntradaySubTab('rules')">⚙ Rules</button>
        </div>
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
    ${spiWarningBanner}
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

// Creates an Intraday open position from a parcel that was just reassigned
// INTO the 'trading' account via setParcelAccount() (portfolio-helpers.js).
// Unlike executeIntradayTrade(), this isn't a new transaction — entryPrice is
// the lot's own historical cost basis, no brokerage is charged (already paid
// at the original buy, captured in parcel.fees), and there's no paired
// journal BUY row to create (the original BUY row already exists; this is a
// reclassification of an existing holding, not a new trade).
async function _openIntradayPositionFromParcel(parcel) {
  const entryPrice = parcel.costPerShare;
  let target = null, stop = null;
  try {
    const r = await fetch(`${API}/api/intraday/${encodeURIComponent(parcel.ticker)}`);
    if (r.ok) {
      const d = await r.json();
      if (d.atr_5m && d.atr_5m > 0) {
        stop = +(entryPrice - INTRADAY_DEFAULTS.stopAtrMult * d.atr_5m).toFixed(3);
        target = d.vwap
          ? +(d.vwap + INTRADAY_DEFAULTS.targetAtrMult * d.atr_5m).toFixed(3)
          : +(entryPrice * (1 + INTRADAY_DEFAULTS.targetPct / 100)).toFixed(3);
      }
    }
  } catch (_) { /* ATR fetch is best-effort — fall back to fixed-pct below */ }
  if (stop == null) {
    stop   = +(entryPrice * (1 - INTRADAY_DEFAULTS.stopPct  / 100)).toFixed(3);
    target = +(entryPrice * (1 + INTRADAY_DEFAULTS.targetPct / 100)).toFixed(3);
  }

  if (!state.intraday) state.intraday = { recommendations: [], openPositions: [], todayPnl: 0 };
  if (!state.intraday.openPositions) state.intraday.openPositions = [];
  state.intraday.openPositions.push({
    id:         `LOT-${Date.now()}-${parcel.ticker}`,
    parcelId:   parcel.id,
    ticker:     parcel.ticker,
    qty:        parcel.remainingQty,
    entryPrice,
    entryFees:  0,            // no new transaction — original cost already in parcel.fees
    target, stop,
    enteredAt:  nowSydney(),
    _journalId: null,         // no paired journal row — reclassification, not a buy
  });
  scheduleSave();
  renderPage();
}

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
  }, async (entryPrice, brokerage, actualQty) => {
    // actualQty is the user-entered value (may differ from AI-suggested rec.qty)
    const qty  = actualQty || rec.qty;
    const cost = qty * entryPrice + brokerage;
    if (cost > state.cash) { toast('Insufficient cash for this trade', 'error'); return; }

    // Ensure daily-timeframe live signals are available — intraday scan candidates
    // are rarely in state.liveSignals (that cache is populated by the Live Signals
    // page's daily /api/analyse fetch, not the 5-min intraday scanner), so without
    // this fallback dtBuildFeatures()/entrySignals would record null RSI/BB%b/ADX/
    // ATR%/MACD for every intraday trade. Mirrors the same fix already in
    // executeDayTrade() (day-trading-analysis.js) for swing trades.
    if (!state.liveSignals?.[rec.ticker]?.rsi_14) {
      toast(`⟳ Fetching live signals for ${rec.ticker}…`, 'info');
      try {
        const _r = await fetch(`${API}/api/analyse/${encodeURIComponent(rec.ticker)}`);
        if (_r.ok) {
          const _d = await _r.json();
          if (!state.liveSignals) state.liveSignals = {};
          state.liveSignals[rec.ticker] = { ...(_d || {}), ...state.liveSignals[rec.ticker] };
        }
      } catch { /* offline — proceed without daily signals; intraday_rsi/vwap still capture */ }
    }

    if (!state.intraday.openPositions) state.intraday.openPositions = [];
    const newPos = {
      id:         rec.id,
      parcelId:   null,           // set below once applyBuyToPortfolio creates the parcel
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
    const newParcel = (state.cgtParcels || []).length
      ? state.cgtParcels[state.cgtParcels.length - 1]
      : null;
    // Links this position to its own parcel so setParcelAccount() (portfolio-helpers.js)
    // can find and remove it precisely if this lot is later moved out of 'trading'.
    newPos.parcelId = newParcel ? newParcel.id : null;

    // Seed liveSignals with the entry price immediately so Live/P&L renders on the first
    // renderPage() call after this dialog closes — before the next refreshPrices() fires.
    if (!state.liveSignals) state.liveSignals = {};
    if (!state.liveSignals[rec.ticker]) state.liveSignals[rec.ticker] = {};
    state.liveSignals[rec.ticker].current_price = entryPrice;

    // Record BUY leg in trade journal — creates a paired entry that closeIntradayPosition
    // patches on exit, so the journal shows both legs of the round-trip trade.
    if (!state.tradeJournal) state.tradeJournal = [];
    const _itSig = (state.liveSignals && state.liveSignals[rec.ticker]) || {};
    const intradayBuyEntry = {
      id:          Date.now(),
      date:        todayStr(),
      timestamp:   nowSydney(),
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
      parcelId:    newParcel ? newParcel.id : null,
      recId:       rec.id,
      recExecuted: true,
      regime:      (state.currentRegime && state.currentRegime.regime) || null,
      notes:       'Intraday BUY',
      entrySignals: {
        rsi_14:    _itSig.rsi_14    ?? null,
        bb_pct_b:  _itSig.bb_pct_b  ?? null,
        adx_14:    _itSig.adx ?? _itSig.adx_14 ?? null,
        atr_pct:   _itSig.atr_pct   ?? null,
        return_5d: _itSig.return_5d ?? null,
        return_20d:_itSig.return_20d ?? null,
        price:     entryPrice,
      },
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
        intraday_rsi:        rec.intradayRsi   ?? null,
        vwap_pct:            rec.pctFromVwap   ?? null,
        // No upstream numeric volume-acceleration metric exists yet — intraday-strategy.js
        // only computes a boolean `vol_rising` flag (3-bar mean vs rolling mean), not a
        // continuous acceleration value, so this column stays null rather than faking a number.
        volume_acceleration: null,
        score:               rec.intradayScore ?? rec.setupScore ?? null,
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

async function closeIntradayPosition(posId, closePrice, brokerage) {
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

  // Exit-signals capture: same fallback-fetch pattern as the entry side
  // (executeIntradayTrade) — without this, _snapshotLiveTechnicals() silently
  // returns null whenever state.liveSignals[ticker] is stale at close time,
  // which is the common case for an intraday-only ticker.
  if (!state.liveSignals?.[pos.ticker]?.rsi_14) {
    try {
      const _r = await fetch(`${API}/api/analyse/${encodeURIComponent(pos.ticker)}`);
      if (_r.ok) {
        const _d = await _r.json();
        if (!state.liveSignals) state.liveSignals = {};
        state.liveSignals[pos.ticker] = { ...(_d || {}), ...state.liveSignals[pos.ticker] };
      }
    } catch { /* offline — proceed without exit technicals */ }
  }
  const exitSignals = typeof _snapshotLiveTechnicals === 'function'
    ? _snapshotLiveTechnicals(pos.ticker, closePrice) : null;

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
    pairedBuyEntry.exitSignals = exitSignals;
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
      exitSignals,
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
      exitSignals,
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
  }, async (closePrice, sellFee) => {
    // Use the canonical helper so the CGT page sees the disposal and portfolio
    // holding is removed.  applySellToPortfolio also credits cash internally.
    const prevDisposalLen = (state.cgtDisposals || []).length;
    const { ok: soldOk, disposals } = applySellToPortfolio(
      rec.ticker, execQty, closePrice, sellFee, todayStr(),
      state.cgtMethod || 'FIFO', 'trading'
    );

    // Exit-signals capture: same fallback-fetch pattern as the entry side and
    // as closeIntradayPosition() — without it, _snapshotLiveTechnicals()
    // returns null whenever state.liveSignals[ticker] is stale at close time.
    if (!state.liveSignals?.[rec.ticker]?.rsi_14) {
      try {
        const _r = await fetch(`${API}/api/analyse/${encodeURIComponent(rec.ticker)}`);
        if (_r.ok) {
          const _d = await _r.json();
          if (!state.liveSignals) state.liveSignals = {};
          state.liveSignals[rec.ticker] = { ...(_d || {}), ...state.liveSignals[rec.ticker] };
        }
      } catch { /* offline — proceed without exit technicals */ }
    }
    const exitSignals = typeof _snapshotLiveTechnicals === 'function'
      ? _snapshotLiveTechnicals(rec.ticker, closePrice) : null;

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
      journalEntry.exitSignals = exitSignals;
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
        exitSignals,
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
        exitSignals,
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
