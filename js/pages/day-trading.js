// ============================================================
// DAY TRADING PAGE
// ============================================================

function renderDayTradingPage(gen) {
  const el = document.getElementById('main-content');
  el.innerHTML = _renderDayTrading();
  // Restore extra ticker list
  _renderDtExtraChips();
}

function _renderDayTrading() {
  const dt = state.dayTrading;
  const allocated = dt.allocatedCash != null ? dt.allocatedCash : Math.round(state.cash * 0.20);
  const riskPct = dt.riskPct || 1.5;
  const riskPerTrade = allocated * riskPct / 100;

  const pending = (dt.recommendations || []).filter(r => r.status === 'pending');
  const executed = (dt.recommendations || []).filter(r => r.status === 'executed');
  const dismissed = (dt.recommendations || []).filter(r => r.status === 'dismissed');

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
          Scans portfolio + watchlist tickers for swing-trade setups using Bollinger Band + RSI + MACD confluence.
          Requires ≥3 of 6 signals (BB Primary is mandatory) plus all entry filters.
        </p>
        ${dt.lastSummary ? `
          <div style="background:var(--bg-secondary);border:0.5px solid var(--border-medium);border-radius:6px;padding:9px 12px">
            <div class="text-xs text-muted" style="margin-bottom:3px">Last scan: ${dt.lastSummary.date} ${dt.lastSummary.time || ''}</div>
            <div style="font-size:13px;line-height:1.5">${escHtml(dt.lastSummary.text || '')}</div>
          </div>` : '<div class="text-xs text-muted">No scan run yet.</div>'}
        <button class="btn btn-primary" ${dt.analysisRunning ? 'disabled' : ''}
          onclick="runDayTradeAnalysis()"
          style="align-self:flex-start;display:flex;align-items:center;gap:7px">
          ${dt.analysisRunning
            ? '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Scanning…'
            : '▶ Run Day Trade Scan'}
        </button>
      </div>
    </div>

    <!-- Signal legend -->
    <div class="card" style="margin-bottom:14px;padding:10px 14px">
      <div style="font-size:11px;color:var(--text-muted);display:flex;flex-wrap:wrap;gap:12px">
        <span><b>Signal #1 (PRIMARY):</b> BB lower band</span>
        <span><b>#2:</b> RSI&lt;40 turning up</span>
        <span><b>#3:</b> MACD hist improving</span>
        <span><b>#4:</b> Stoch&lt;25 crossing up</span>
        <span><b>#5:</b> Volume spike (&gt;1.2×)</span>
        <span><b>#6:</b> OBV bullish divergence</span>
        <span style="margin-left:auto">Need ≥3 incl. #1 • R:R ≥ 2:1 • Stop = entry − 1.5×ATR</span>
      </div>
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

    ${dismissed.length ? `
      <div style="margin:16px 0 4px">
        <button class="btn btn-sm" onclick="_toggleDtDismissed(this)" style="font-size:11px">
          Show dismissed (${dismissed.length})
        </button>
        <div id="dt-dismissed" style="display:none;margin-top:8px;display:flex;flex-direction:column;gap:8px">
          ${dismissed.map(r => _renderDtRec(r, true)).join('')}
        </div>
      </div>` : ''}
  `;
}

function _renderDtRec(r, compact = false) {
  const signals = ['BB Primary', 'RSI<40', 'MACD hist', 'Stoch<25', 'Volume', 'OBV div'];
  const hit = new Set(r.signalsHit || []);
  const filtersPass = r.filtersPass || {};
  const rrColor = (r.rrRatio || 0) >= 2.5 ? '#10b981' : (r.rrRatio || 0) >= 2.0 ? '#f59e0b' : '#ef4444';
  const confPct = Math.round((r.confidence || 0) * 100);
  const isPending = r.status === 'pending';
  const isExecuted = r.status === 'executed';

  const filterIcons = [
    { label: 'Above SMA200', ok: filtersPass.aboveSMA200 },
    { label: 'ADX ok', ok: filtersPass.adxOk },
    { label: 'No catalyst', ok: filtersPass.noCatalyst },
  ].map(f => `<span style="font-size:10px;color:${f.ok ? '#10b981' : '#ef4444'}">${f.ok ? '✓' : '✗'} ${f.label}</span>`).join(' ');

  return `
    <div class="card" style="border-left:3px solid ${isExecuted ? '#6366f1' : isPending ? '#f59e0b' : '#6b7280'};padding:12px 14px">
      <div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap">
        <!-- Left: ticker + signals -->
        <div style="min-width:200px;flex:1">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:16px;font-weight:700">${r.ticker}</span>
            <span style="background:#f59e0b;color:#000;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px">BUY</span>
            ${isExecuted ? `<span style="background:#6366f1;color:#fff;font-size:10px;padding:2px 7px;border-radius:4px">EXECUTED</span>` : ''}
            <span style="font-size:11px;color:var(--text-muted)">${r.holdDays ? r.holdDays + 'd hold' : ''}</span>
          </div>
          <!-- Signal dots -->
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px">
            ${signals.map((s, i) => {
              const matched = [...hit].some(h => h.toLowerCase().includes(s.toLowerCase().split('<')[0].split('>')[0].trim().toLowerCase().split(' ')[0]));
              const isPrimary = i === 0;
              return `<span style="font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600;background:${matched ? (isPrimary ? '#f59e0b' : '#10b981') : 'var(--bg-secondary)'};color:${matched ? '#000' : 'var(--text-muted)'}">
                ${isPrimary ? '⬢ ' : ''}${s}
              </span>`;
            }).join('')}
          </div>
          <div style="font-size:11px;color:var(--text-muted);display:flex;gap:10px;flex-wrap:wrap">
            ${filterIcons}
          </div>
          ${r.reasoning ? `<div style="font-size:12px;margin-top:6px;color:var(--text-secondary)">${escHtml(r.reasoning)}</div>` : ''}
          ${r.stopReason ? `<div style="font-size:11px;margin-top:3px;color:#ef4444">⚠ Invalidated if: ${escHtml(r.stopReason)}</div>` : ''}
        </div>

        <!-- Right: price levels + sizing -->
        <div style="min-width:220px">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">
            <div style="text-align:center;padding:6px;background:var(--bg-secondary);border-radius:6px">
              <div style="font-size:10px;color:var(--text-muted)">Entry</div>
              <div style="font-size:13px;font-weight:600">$${r.priceRange ? r.priceRange[0].toFixed(3) : '?'}</div>
              <div style="font-size:10px;color:var(--text-muted)">–$${r.priceRange ? r.priceRange[1].toFixed(3) : '?'}</div>
            </div>
            <div style="text-align:center;padding:6px;background:rgba(16,185,129,.08);border-radius:6px;border:0.5px solid rgba(16,185,129,.3)">
              <div style="font-size:10px;color:var(--text-muted)">Target</div>
              <div style="font-size:13px;font-weight:600;color:#10b981">$${r.target?.toFixed(3) || '?'}</div>
            </div>
            <div style="text-align:center;padding:6px;background:rgba(239,68,68,.08);border-radius:6px;border:0.5px solid rgba(239,68,68,.3)">
              <div style="font-size:10px;color:var(--text-muted)">Stop</div>
              <div style="font-size:13px;font-weight:600;color:#ef4444">$${r.stopLoss?.toFixed(3) || '?'}</div>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:8px">
            <span>Qty: <b>${r.qty || '?'} shares</b></span>
            <span style="color:${rrColor}">R:R <b>${r.rrRatio?.toFixed(1) || '?'}:1</b></span>
            <span>Conf: <b>${confPct}%</b></span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:10px">
            <span>Risk: <span style="color:#ef4444">-$${r.riskAUD?.toFixed(0) || '?'}</span></span>
            <span>Reward: <span style="color:#10b981">+$${r.rewardAUD?.toFixed(0) || '?'}</span></span>
          </div>
          ${isPending ? `
            <div class="flex-row" style="gap:7px">
              <button class="btn btn-primary btn-sm" onclick="executeDayTrade('${r.id}')" style="flex:1">
                ✓ Execute
              </button>
              <button class="btn btn-sm btn-danger" onclick="dismissDayTradeRec('${r.id}')">Dismiss</button>
            </div>` : ''}
        </div>
      </div>
    </div>`;
}

// ── Helper functions ───────────────────────────────────────────────────────────

function _updateDtRiskDisplay() {
  const allocated = state.dayTrading.allocatedCash != null
    ? state.dayTrading.allocatedCash
    : Math.round(state.cash * 0.20);
  const riskPct = state.dayTrading.riskPct || 1.5;
  const el = document.getElementById('dt-risk-display');
  if (el) el.textContent = `= $${fmt(allocated * riskPct / 100)} per trade`;
}

function _renderDtExtraChips() {
  const container = document.getElementById('dt-extra-chips');
  if (!container) return;
  const extras = state.dayTrading.extraTickers || [];
  container.innerHTML = extras.map(t => `
    <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;background:#dbeafe;color:#1d4ed8;border-radius:6px;font-size:12px;font-weight:600;border:0.5px solid #93c5fd">
      ${t}
      <button onclick="_removeDtExtraTicker('${t}')" style="background:none;border:none;cursor:pointer;color:#1d4ed8;font-size:13px;padding:0">×</button>
    </span>`).join('');
}

function _addDtExtraTicker() {
  const input = document.getElementById('dt-extra-input');
  if (!input) return;
  const tickers = input.value.toUpperCase().split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
  for (const t of tickers) {
    if (t && !state.dayTrading.extraTickers.includes(t) && !mergedPortfolio().find(h => h.ticker === t)) {
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
  const shown = el.style.display !== 'none';
  el.style.display = shown ? 'none' : 'flex';
  btn.textContent = shown
    ? `Show dismissed (${(state.dayTrading.recommendations || []).filter(r => r.status === 'dismissed').length})`
    : 'Hide dismissed';
}
