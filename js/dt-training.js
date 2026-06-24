/**
 * dt-training.js — Day trading ML training and history frontend.
 *
 * Provides:
 *   dtSaveSnapshot(rec, tradeType, signals, macroData)  → Promise<id|null>
 *   dtCloseSnapshot(snapshotId, exitData)               → Promise<void>
 *   dtBuildFeatures(signals, macro)                     → feature object
 *   dtPredictLocal(features, model)                     → win probability (0–1)
 *   renderDtHistoryTab()                                → HTML string
 *   renderDtModelTab()                                  → HTML string
 *   dtTrain()                                           → fires training, re-renders
 *   dtLoadModel()                                       → populates window._dtModel
 *   dtLoadHistory(page)                                 → populates window._dtHistory
 *
 * No Claude API calls — all computation is deterministic / local numpy on the backend.
 */

/* ── Model cache (populated on first History/Model tab open) ──────────────── */
var _dtModel      = null;  // { swing: model_obj|null, intraday: model_obj|null }
var _dtImportances = null; // { swing: [...], intraday: [...] }
var _dtHistItems  = null;  // null = not yet fetched; [] = fetched but empty
var _dtHistLoading = false; // true = fetch already in flight — prevents duplicate requests
var _dtHistOffset = 0;
var _dtHistMore   = false;
var _dtStats      = null;  // summary stats
var _dtHistFilter = { ticker: '', outcome: 'all', recordType: 'executed' }; // client-side history filter state
var _dtExpandedIds = {}; // { [snapshotId]: true } — which History rows have the entry/exit technicals drawer open
// recordType: 'executed' (default — real trades only) | 'all' (executed + shadow ML training rows)
// Shadow rows (record_type='shadow') are written by the ML bias-correction pipeline for
// below-threshold setups (see routes/day_trade_training.py _resolve_shadow_outcomes) — they
// are never executed/closed and resolve via r_multiple after ~8 days, not exit_price/exit_date.

/* ── Feature builder ─────────────────────────────────────────────────────── */
/**
 * Build a flat feature object from live signals + macro state.
 * Matches the FEATURES list in routes/day_trade_training.py.
 */
function dtBuildFeatures(signals, macro) {
  var s = signals || {};
  var m = macro   || {};

  var price   = s.current_price || 0;
  var sma20   = s.sma_20;
  var sma50   = s.sma_50;
  var sma200  = s.sma_200;
  var atr14   = s.atr_14;

  return {
    rsi_14:          s.rsi_14        != null ? s.rsi_14        : null,
    bb_pct_b:        s.bb_pct_b      != null ? s.bb_pct_b      : null,
    bb_bandwidth:    s.bb_bandwidth  != null ? s.bb_bandwidth  : null,
    atr_pct:         (atr14 && price) ? (atr14 / price * 100)   : null,
    adx:             s.adx           != null ? s.adx           : null,
    volume_zscore:   s.volume_zscore != null ? s.volume_zscore : null,
    mfi_14:          s.mfi_14        != null ? s.mfi_14        : null,
    stoch_k:         s.stoch_k       != null ? s.stoch_k       : null,
    williams_r:      s.williams_r    != null ? s.williams_r    : null,
    cci_20:          s.cci_20        != null ? s.cci_20        : null,
    setup_score:     s.score         != null ? s.score         : null,
    price_vs_sma20:  (sma20 && price)  ? ((price / sma20  - 1) * 100) : null,
    price_vs_sma50:  (sma50 && price)  ? ((price / sma50  - 1) * 100) : null,
    asx200_5d_ret:   m.asx200_5d_ret != null ? m.asx200_5d_ret : null,
    adl_ratio:       m.advance_decline_ratio != null ? m.advance_decline_ratio : null,
    // Ordinal regime risk (Sprint 61) — keep in sync with _REGIME_RISK in
    // routes/day_trade_training.py. null when regime unknown (model imputes mean).
    regime_risk:     (function () {
      var _RR = { riskOn: 0, trend: 1, sideways: 2, highVol: 3, riskOff: 4, panic: 5 };
      var reg = (typeof state !== 'undefined' && state.currentRegime && state.currentRegime.regime) || null;
      return (reg != null && _RR[reg] != null) ? _RR[reg] : null;
    })(),
    intraday_rsi:    s.intraday_rsi       != null ? s.intraday_rsi       : null,
    vwap_position:   s.vwap_pct           != null ? s.vwap_pct           : null,
    volume_accel:    s.volume_acceleration != null ? s.volume_acceleration : null,
  };
}

/* ── Client-side logistic regression prediction ───────────────────────────── */
/**
 * Given a feature object and a trained model (from GET /api/daytrading/model),
 * returns the estimated win probability (0–1).
 * Returns null if the model is unavailable.
 */
function dtPredictLocal(features, model) {
  if (!model || !model.feature_names || !model.weights) return null;
  var fn   = model.feature_names;
  var w    = model.weights;
  var mu   = model.feature_means;
  var sig  = model.feature_stds;
  var bias = model.bias || 0;

  var logit = bias;
  for (var i = 0; i < fn.length; i++) {
    // IMPUTATION GUARD: use training mean for missing values so Z-score = 0 (neutral),
    // not artificially negative. Passing 0 for RSI (mean≈50) gives Z ≈ −4 — wrong.
    var raw = (features[fn[i]] != null) ? parseFloat(features[fn[i]]) : (mu[i] || 0);
    var std = (sig[i] && sig[i] > 1e-9) ? sig[i] : 1;
    var z   = (raw - mu[i]) / std;
    logit  += z * w[i];
  }
  // Ridge regression: return raw logit as expected R-multiple (no sigmoid)
  if (model.model_type === 'ridge') {
    return logit;
  }
  // Legacy logistic regression: apply sigmoid for win probability
  logit = Math.max(-20, Math.min(20, logit));
  return 1 / (1 + Math.exp(-logit));
}

/* ── Snapshot save (called at trade execution) ────────────────────────────── */
/**
 * POST the entry snapshot to the backend. Returns the new snapshot id (or null on error).
 * rec        — the rec/position object (must have ticker, target, stopLoss, etc.)
 * tradeType  — 'swing' | 'intraday'
 * signals    — state.liveSignals[ticker] or intraday signals object
 * macroData  — state.macroData (may be null/stale)
 * entryPrice — actual executed price (overrides rec.priceRange)
 * execQty    — actual executed quantity
 * opts       — optional { record_type, shadow_reason }
 */
function dtSaveSnapshot(rec, tradeType, signals, macroData, entryPrice, execQty, opts) {
  if (!rec || !rec.ticker) return Promise.resolve(null);

  var s = signals   || {};
  var m = macroData || {};

  var price = entryPrice || (rec.priceRange ? rec.priceRange[0] : 0);
  var features = dtBuildFeatures(s, m);

  // Macro snapshot fields not in dtBuildFeatures
  var body = Object.assign({
    ticker:        rec.ticker,
    action:        rec.action || 'BUY',
    trade_type:    tradeType || 'swing',
    record_type:   (opts && opts.record_type)   || 'executed',
    shadow_reason: (opts && opts.shadow_reason) || null,
    target:      rec.target   || null,
    stop_loss:   rec.stopLoss || null,
    hold_days:   rec.holdDays || null,
    confidence:  rec.confidence || null,
    // Prefer the regime stamped on the rec at scan time (_dtBuildRecs sets
    // rec.regime from state.currentRegime at the moment the setup was found).
    // Falling back to the LIVE state.currentRegime here was the bug: a rec can
    // sit pending for up to 3 days (_dtDismissStaleRecs) before execution, and
    // regime can flip — or not be classified yet at all on first page load —
    // by the time dtSaveSnapshot() fires, silently mislabeling/nulling the
    // snapshot's regime. Mirrors the recHistory regime-stamp fix (4bf219a).
    regime:      (rec.regime && rec.regime !== 'unknown' ? rec.regime : null)
                 || (state.currentRegime && state.currentRegime.regime)
                 || null,
    entry_date:  todayStr(),
    entry_price: price,
    qty:         execQty || rec.qty || null,
    // Intraday-specific (may be null for swing trades)
    intraday_rsi: s.intraday_rsi      || null,
    vwap_position: s.vwap_pct         || null,
    volume_accel:  s.volume_acceleration || null,
    // Macro
    asx200_price: m.asx200            || null,
    asx200_5d_ret: m.asx200_5d_ret    || null,
    adl_ratio:    m.advance_decline_ratio || null,
    rba_rate:     m.rba_rate          || null,
    // Sector
    sector:       s.sector || rec.sector || null,
    sector_5d_ret: null,   // could be fetched from sector ETF; omitted for now
    // Full ATR fields
    atr_14:       s.atr_14 || null,
    price_vs_sma200: (s.sma_200 && price) ? ((price / s.sma_200 - 1) * 100) : null,
    rsi_9:        s.rsi_9 || null,
    macd_hist:    s.macd_hist || null,
    bb_pct_b:     s.bb_pct_b || null,
    bb_bandwidth: s.bb_bandwidth || null,
    adx:          s.adx || null,
    volume_zscore: s.volume_zscore || null,
    mfi_14:       s.mfi_14 || null,
    stoch_k:      s.stoch_k || null,
    williams_r:   s.williams_r || null,
    cci_20:       s.cci_20 || null,
    setup_score:  s.score || null,
  }, features);

  return fetch(`${API}/api/daytrading/snapshot`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
    .then(function(r) { return r.json(); })
    .then(function(d) { return d.ok ? d.id : null; })
    .catch(function() { return null; });
}

/* ── Snapshot close (called when trade is closed) ────────────────────────── */
/**
 * PATCH exit data onto an existing snapshot.
 * snapshotId — integer id returned by dtSaveSnapshot
 * exitData   — { exit_price, entry_price, exit_date, exit_reason, actual_hold_days,
 *                exitSignals? } — exitSignals is the object returned by
 *                _snapshotLiveTechnicals() (recommendations.js), diagnostic-only —
 *                never a model training input (exit-time indicators don't exist
 *                yet at the entry decision, so they'd be data leakage as a feature).
 */
function dtCloseSnapshot(snapshotId, exitData) {
  if (!snapshotId || !exitData) return Promise.resolve(null);

  var body = {
    exit_price:       exitData.exit_price       || null,
    entry_price:      exitData.entry_price       || null,
    exit_date:        exitData.exit_date         || todayStr(),
    exit_reason:      exitData.exit_reason       || 'manual',
    actual_hold_days: exitData.actual_hold_days  || null,
    pnl_pct:          exitData.pnl_pct           || null,
    exit_signals_json: exitData.exitSignals ? JSON.stringify(exitData.exitSignals) : null,
    regime_at_close:  (state.currentRegime && state.currentRegime.regime) || null,
  };

  // Compute pnl_pct if not supplied
  if (body.pnl_pct == null && body.exit_price && body.entry_price) {
    body.pnl_pct = (body.exit_price - body.entry_price) / body.entry_price * 100;
  }

  return fetch(`${API}/api/daytrading/snapshot/` + snapshotId + '/close', {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
    .then(function(r) { return r.json(); })
    .catch(function() { return null; });
}

/* ── Infer exit reason ────────────────────────────────────────────────────── */
function dtInferExitReason(closePrice, entryPrice, target, stopLoss, action) {
  var isSell = action === 'SELL' || action === 'TRIM';
  if (!isSell) {
    // BUY / long position
    if (target && Math.abs(closePrice - target) / target < 0.01) return 'target';
    if (stopLoss && Math.abs(closePrice - stopLoss) / stopLoss < 0.01) return 'stop';
    if (stopLoss && closePrice <= stopLoss) return 'stop';
    if (target && closePrice >= target) return 'target';
  } else {
    // Short / exit position
    if (target && Math.abs(closePrice - target) / target < 0.01) return 'target';
    if (stopLoss && closePrice >= stopLoss) return 'stop';
    if (target && closePrice <= target) return 'target';
  }
  return 'manual';
}

/* ── Load model into _dtModel ────────────────────────────────────────────── */
function dtLoadModel() {
  return fetch(`${API}/api/daytrading/model`)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok && d.available) {
        _dtModel = {
          swing:    d.swing    || null,
          intraday: d.intraday || null,
        };
        _dtImportances = d.importances || { swing: [], intraday: [] };
      } else {
        _dtModel = null;
        _dtImportances = null;
      }
      return _dtModel;
    })
    .catch(function() { _dtModel = null; _dtImportances = null; return null; });
}

/* ── Load history page ────────────────────────────────────────────────────── */
function dtLoadHistory(reset) {
  if (reset) { _dtHistItems = null; _dtHistOffset = 0; _dtHistMore = false; }
  var limit = 20;
  var recordType = (_dtHistFilter && _dtHistFilter.recordType) || 'executed';
  return fetch(`${API}/api/daytrading/history?limit=` + limit + '&offset=' + _dtHistOffset + '&record_type=' + recordType)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) {
        _dtHistItems = (_dtHistItems || []).concat(d.items || []);
        _dtHistMore  = d.has_more || false;
        _dtHistOffset += limit;
      } else {
        // Don't leave _dtHistItems as null — that would keep the UI in "Loading…" forever.
        _dtHistItems = _dtHistItems || [];
      }
      return d;
    })
    .catch(function() {
      _dtHistItems = _dtHistItems || [];
      return null;
    });
}

/* ── Load stats ───────────────────────────────────────────────────────────── */
function dtLoadStats() {
  return fetch(`${API}/api/daytrading/stats`)
    .then(function(r) { return r.json(); })
    .then(function(d) { if (d.ok) _dtStats = d; return d; })
    .catch(function() { return null; });
}

/* ── Train model ─────────────────────────────────────────────────────────── */
function dtTrain() {
  var btn = document.getElementById('dt-train-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Training…'; }

  fetch(`${API}/api/daytrading/train`, { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) {
        var swingOk = d.models && d.models.swing && d.models.swing.ok;
        var swingM  = (d.models && d.models.swing) || {};
        var r2disp  = swingM.r2_oos  != null ? 'OOS R²=' + swingM.r2_oos.toFixed(3)
                    : d.r2_score     != null ? 'R²=' + d.r2_score.toFixed(3) : null;
        var trainMsg = swingOk && r2disp
          ? 'Model trained — ' + r2disp + ' on ' + (d.n_samples || '?') + ' trades'
          : 'Model trained on ' + (d.n_samples || '?') + ' trades';
        toast(trainMsg, 'success');
        // Refresh model cache and re-render
        dtLoadModel().then(function() {
          var el = document.getElementById('dt-tab-content');
          if (el) el.innerHTML = renderDtModelTab();
        });
      } else {
        toast(d.error || 'Training failed', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '🔁 Train Model'; }
      }
    })
    .catch(function() {
      toast('Training failed — server unreachable', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🔁 Train Model'; }
    });
}

/* ── Render: History tab ─────────────────────────────────────────────────── */
function renderDtHistoryTab() {
  // null = not yet fetched — start a single load and show a spinner.
  // _dtHistLoading guards against multiple concurrent fetches when renderPage()
  // is called repeatedly (e.g. from runDayTradeAnalysis) before the first resolves.
  if (_dtHistItems === null) {
    if (!_dtHistLoading) {
      _dtHistLoading = true;
      Promise.all([dtLoadHistory(true), dtLoadStats()]).then(function() {
        _dtHistLoading = false;
        var el = document.getElementById('dt-tab-content');
        if (el && (state.dayTrading && state.dayTrading.activeTab) === 'history') {
          el.innerHTML = renderDtHistoryTab();
        }
      });
    }
    return _dtHistLoadingHTML();
  }

  var stats  = _dtStats;
  var items  = _dtHistItems;

  var statsHTML = '';
  if (stats) {
    var wr = stats.win_rate_pct != null ? stats.win_rate_pct.toFixed(1) + '%' : '—';
    var aw = stats.avg_win_pct  != null ? '+' + stats.avg_win_pct.toFixed(2) + '%' : '—';
    var al = stats.avg_loss_pct != null ? stats.avg_loss_pct.toFixed(2) + '%'  : '—';
    var ah = stats.avg_hold_days != null ? stats.avg_hold_days.toFixed(1) + 'd' : '—';
    statsHTML = `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
        ${_dtStatCard('Win Rate', wr, stats.win_rate_pct >= 50 ? '#059669' : '#dc2626')}
        ${_dtStatCard('Avg Win', aw, '#059669')}
        ${_dtStatCard('Avg Loss', al, '#dc2626')}
        ${_dtStatCard('Avg Hold', ah, 'var(--text-primary)')}
      </div>
      <div style="display:flex;gap:10px;margin-bottom:14px;font-size:12px;color:var(--text-secondary)">
        <span>✅ ${stats.wins || 0} wins</span>
        <span>❌ ${stats.losses || 0} losses</span>
        <span>➡️ ${stats.breakevens || 0} breakeven</span>
        <span style="color:var(--text-tertiary)">· ${stats.open_trades || 0} open</span>
      </div>`;
  }

  // Client-side filtering (ticker substring + outcome). Backend supports an
  // `outcome` query param too, but since pages are accumulated client-side
  // via "Load more", filtering the already-fetched _dtHistItems keeps the
  // UX simple and matches the convention used by other pages (e.g. journal.js).
  // recordType is the exception — it's applied server-side (dtLoadHistory passes
  // it as a query param) because shadow rows can dominate a page of "executed"
  // results, so the toggle re-fetches from offset 0 rather than post-filtering.
  var hf = _dtHistFilter;
  var filteredItems = items;
  if (hf.ticker) {
    var tQuery = hf.ticker.toUpperCase();
    filteredItems = filteredItems.filter(function(it) { return it.ticker && it.ticker.toUpperCase().indexOf(tQuery) !== -1; });
  }
  if (hf.outcome !== 'all') {
    filteredItems = filteredItems.filter(function(it) { return (it.outcome || 'open') === hf.outcome; });
  }
  var hasHistFilters = !!hf.ticker || hf.outcome !== 'all' || hf.recordType !== 'executed';

  var filterHTML = `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.6px">Filters</div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="text-xs text-muted">${filteredItems.length} of ${items.length} shown</span>
          ${hasHistFilters ? `<button class="btn btn-sm" onclick="resetDtHistFilter()">✕ Clear filters</button>` : ''}
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
        <div>
          <div class="form-label" style="margin-bottom:3px">Ticker</div>
          <input type="text" placeholder="e.g. CBA" value="${hf.ticker}"
            oninput="setDtHistFilterKey('ticker', this.value.toUpperCase())"
            style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:12px;width:80px">
        </div>
        <div>
          <div class="form-label" style="margin-bottom:3px">Outcome</div>
          <select onchange="setDtHistFilterKey('outcome', this.value)"
            style="padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:12px">
            <option value="all"        ${hf.outcome==='all'       ?'selected':''}>All outcomes</option>
            <option value="win"        ${hf.outcome==='win'       ?'selected':''}>Win ✓</option>
            <option value="loss"       ${hf.outcome==='loss'      ?'selected':''}>Loss ✗</option>
            <option value="breakeven"  ${hf.outcome==='breakeven' ?'selected':''}>Breakeven</option>
            <option value="open"       ${hf.outcome==='open'      ?'selected':''}>Open</option>
          </select>
        </div>
        <div>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);cursor:pointer;padding-bottom:5px"
            title="Shadow records are ML training data written for below-threshold setups — never executed, never manually closed. They resolve via r_multiple after ~8 days instead of an exit price/date.">
            <input type="checkbox" ${hf.recordType === 'all' ? 'checked' : ''}
              onchange="setDtHistFilterKey('recordType', this.checked ? 'all' : 'executed')">
            🔬 Show shadow records (ML training data, not real trades)
          </label>
        </div>
      </div>
    </div>`;

  var rowsHTML = '';
  if (items.length === 0) {
    rowsHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">No completed trades recorded yet.<br>Execute a day trade to start building your history.</div>';
  } else if (filteredItems.length === 0) {
    rowsHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">No trades match the current filters.</div>';
  } else {
    rowsHTML = `
      <table class="tbl-stack" style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="border-bottom:1px solid var(--border);color:var(--text-secondary)">
            <th style="text-align:left;padding:5px 4px">Ticker</th>
            <th style="text-align:left;padding:5px 4px">Type</th>
            <th style="text-align:left;padding:5px 4px">Entry</th>
            <th style="text-align:right;padding:5px 4px">Exit</th>
            <th style="text-align:right;padding:5px 4px">P&L%</th>
            <th style="text-align:right;padding:5px 4px">P&L $</th>
            <th style="text-align:center;padding:5px 4px">Hold</th>
            <th style="text-align:left;padding:5px 4px">Outcome</th>
            <th style="text-align:left;padding:5px 4px">Regime</th>
            <th style="text-align:right;padding:5px 4px"></th>
          </tr>
        </thead>
        <tbody>
          ${filteredItems.map(_dtHistRow).join('')}
        </tbody>
      </table>
      ${_dtHistMore
        ? `<div style="text-align:center;margin-top:10px">
             <button class="btn btn-sm" onclick="dtLoadMoreHistory()">Load more</button>
           </div>`
        : ''}`;
  }

  return `
    <div style="padding:4px 0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-weight:600">Trade History (${stats ? stats.total : '…'})</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" onclick="dtDeleteAllHistory()" style="color:#dc2626;border-color:#dc2626">
            🗑 Clear All
          </button>
        </div>
      </div>
      ${statsHTML}
      ${filterHTML}
      ${rowsHTML}
    </div>`;
}

/* ── History filter state helpers ────────────────────────────────────────── */
function setDtHistFilterKey(key, value) {
  _dtHistFilter[key] = value;
  var el = document.getElementById('dt-tab-content');
  if (key === 'recordType') {
    // recordType is a server-side query param (not a client-side post-filter like
    // ticker/outcome) — must re-fetch from offset 0 so pagination/has_more reflect
    // the new scope.
    if (el) el.innerHTML = _dtHistLoadingHTML();
    dtLoadHistory(true).then(function() {
      if (el) el.innerHTML = renderDtHistoryTab();
    });
    return;
  }
  if (el) el.innerHTML = renderDtHistoryTab();
}

function resetDtHistFilter() {
  var recordTypeChanged = _dtHistFilter.recordType !== 'executed';
  _dtHistFilter = { ticker: '', outcome: 'all', recordType: 'executed' };
  var el = document.getElementById('dt-tab-content');
  if (recordTypeChanged) {
    if (el) el.innerHTML = _dtHistLoadingHTML();
    dtLoadHistory(true).then(function() {
      if (el) el.innerHTML = renderDtHistoryTab();
    });
    return;
  }
  if (el) el.innerHTML = renderDtHistoryTab();
}

function _dtHistLoadingHTML() {
  return '<div style="text-align:center;padding:32px;color:var(--text-muted)">Loading history…</div>';
}

function _dtStatCard(label, value, color) {
  return `<div class="card" style="padding:10px;text-align:center">
    <div style="font-size:10px;color:var(--text-muted);margin-bottom:3px">${label}</div>
    <div style="font-size:18px;font-weight:700;color:${color}">${value}</div>
  </div>`;
}

/* ── Entry/exit technicals detail drawer (History tab) ───────────────────── */
// Entry technicals are columns on the snapshot row itself (rsi_14, bb_pct_b,
// adx, atr_pct, macd_hist, setup_score — captured by dtSaveSnapshot() at
// execution time). Exit technicals live in exit_signals_json (captured by
// _snapshotLiveTechnicals() at close time) — diagnostic-only, mirrors the
// equivalent Journal-page drawer for swing/SELL trades.
var DT_EXIT_QUALITY_STYLE = {
  exit_into_strength:            { color: '#d97706', label: '⚠ Exit into strength' },
  exit_after_reversal_confirmed: { color: '#059669', label: '✓ Reversal confirmed' },
  exit_into_weakness:            { color: '#dc2626', label: '▼ Exit into weakness' },
  exit_neutral:                  { color: 'var(--text-tertiary)', label: 'Neutral exit' },
};

function _dtToggleDetail(id) {
  _dtExpandedIds[id] = !_dtExpandedIds[id];
  var el = document.getElementById('dt-tab-content');
  if (el) el.innerHTML = renderDtHistoryTab();
}

function _dtBuildDetailRow(item) {
  var exitSig = null;
  if (item.exit_signals_json) {
    try { exitSig = JSON.parse(item.exit_signals_json); } catch (e) { exitSig = null; }
  }
  var eq = item.exit_quality_tag ? DT_EXIT_QUALITY_STYLE[item.exit_quality_tag] : null;

  var pair = (typeof _journalSigPair === 'function') ? _journalSigPair : function() { return ''; };
  var rowsHtml = [
    pair('RSI(14)',     item.rsi_14,      exitSig && exitSig.rsi_14,    function(v) { return Number(v).toFixed(1); }),
    pair('BB %b',       item.bb_pct_b,    exitSig && exitSig.bb_pct_b,  function(v) { return Number(v).toFixed(2); }),
    pair('ADX',         item.adx,         exitSig && exitSig.adx_14,    function(v) { return Number(v).toFixed(1); }),
    pair('ATR %',       item.atr_pct,     exitSig && exitSig.atr_pct,   function(v) { return Number(v).toFixed(2) + '%'; }),
    pair('MACD Hist',   item.macd_hist,   exitSig && exitSig.macd_hist, function(v) { return Number(v).toFixed(3); }),
    pair('Setup Score', item.setup_score, exitSig && exitSig.setup_score, function(v) { return Number(v).toFixed(0); }),
  ].join('');
  if (!rowsHtml) {
    rowsHtml = '<div class="text-xs text-muted" style="font-style:italic">No technicals captured for this trade.</div>';
  }

  return `<tr style="border-bottom:1px solid var(--border-subtle)">
    <td colspan="10" style="padding:8px 10px 12px;background:var(--bg-surface)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.04em">Technicals: entry${exitSig ? ' → exit' : ''}</div>
        ${eq ? `<span style="font-size:10px;padding:1px 6px;border-radius:8px;border:1px solid ${eq.color};color:${eq.color}">${eq.label}</span>` : ''}
      </div>
      <div style="font-size:12px;max-width:340px">${rowsHtml}</div>
    </td>
  </tr>`;
}

function _dtHistRow(item) {
  var isShadow = item.record_type === 'shadow';
  var outcome = item.outcome || 'open';
  var outcomeColor = outcome === 'win' ? '#059669' : outcome === 'loss' ? '#dc2626' : outcome === 'open' ? '#6366f1' : '#94a3b8';
  var typeLabel = item.trade_type === 'intraday' ? '⚡' : '◈';

  if (isShadow) {
    // Shadow rows are ML bias-correction training data (routes/day_trade_training.py
    // _resolve_shadow_outcomes) — never executed, never manually closed. They resolve
    // via r_multiple ~8 days after entry, not exit_price/exit_date/pnl_pct, so the
    // Exit/P&L%/P&L $/Hold columns would otherwise show misleading "—" placeholders
    // that look like broken real trades.
    var resolved = item.r_multiple != null;
    var rStr = resolved
      ? (item.r_multiple >= 0 ? '+' : '') + Number(item.r_multiple).toFixed(2) + 'R'
      : 'Pending (~8d)';
    var rColor = resolved ? (item.r_multiple >= 0 ? '#059669' : '#dc2626') : 'var(--text-muted)';
    var shadowReasonLabel = item.shadow_reason ? String(item.shadow_reason).replace(/_/g, ' ') : '—';

    return `<tr style="border-bottom:1px solid var(--border-subtle);opacity:0.85">
      <td data-label="Ticker" style="padding:5px 4px;font-weight:600">${item.ticker}</td>
      <td data-label="Type" style="padding:5px 4px;color:var(--text-muted)">${typeLabel} ${item.trade_type || 'swing'}</td>
      <td data-label="Entry" style="padding:5px 4px">${item.entry_date || '—'}<br><span style="color:var(--text-muted)">$${item.entry_price != null ? Number(item.entry_price).toFixed(3) : '—'}</span></td>
      <td data-label="Exit" style="padding:5px 4px;text-align:right;color:var(--text-muted);font-size:11px">N/A<br><span title="${shadowReasonLabel}">(${shadowReasonLabel})</span></td>
      <td data-label="P&L%" colspan="2" style="padding:5px 4px;text-align:right;font-weight:600;color:${rColor}">${rStr}</td>
      <td data-label="Hold" style="padding:5px 4px;text-align:center;color:var(--text-muted)">—</td>
      <td data-label="Outcome" style="padding:5px 4px">
        <span style="background:#a855f722;color:#a855f7;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600" title="ML training data — confidence was below the action threshold, never an executed trade">🔬 SHADOW</span>
      </td>
      <td data-label="Regime" style="padding:5px 4px;color:var(--text-muted);font-size:11px">${item.regime || '—'}</td>
      <td style="padding:5px 4px;text-align:right">
        <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:#dc2626" onclick="dtDeleteSnapshot(${item.id})">✕</button>
      </td>
    </tr>`;
  }

  var pnlStr = item.pnl_pct != null ? (item.pnl_pct >= 0 ? '+' : '') + item.pnl_pct.toFixed(2) + '%' : '—';
  var pnlColor = item.pnl_pct >= 0 ? '#059669' : '#dc2626';

  // $ P&L is not persisted server-side (only pnl_pct / r_multiple are) — compute it
  // client-side from entry_price/exit_price/qty. Direction-aware: day-trade
  // strategies in this codebase (js/intraday-strategy.js) are long-only ('BUY'),
  // but SELL/TRIM-style short exits are handled defensively in case that changes.
  var pnlDollar = null;
  if (item.entry_price != null && item.exit_price != null && item.qty != null) {
    var isShort = item.action === 'SELL' || item.action === 'TRIM';
    var diff = isShort
      ? (Number(item.entry_price) - Number(item.exit_price))
      : (Number(item.exit_price) - Number(item.entry_price));
    pnlDollar = diff * Number(item.qty);
  }
  var pnlDollarStr = pnlDollar != null
    ? (pnlDollar >= 0 ? '+$' : '-$') + Math.abs(pnlDollar).toFixed(2)
    : '—';
  var pnlDollarColor = pnlDollar != null ? (pnlDollar >= 0 ? '#059669' : '#dc2626') : 'var(--text-muted)';

  var isExpanded = !!_dtExpandedIds[item.id];
  var mainRow = `<tr style="border-bottom:${isExpanded ? 'none' : '1px solid var(--border-subtle)'}">
    <td data-label="Ticker" style="padding:5px 4px;font-weight:600">
      <button class="btn btn-sm" style="font-size:10px;padding:0 4px;margin-right:3px;border:none;background:none" onclick="_dtToggleDetail(${item.id})" title="Show technicals at entry/exit">${isExpanded ? '▾' : '▸'}</button>
      ${item.ticker}
    </td>
    <td data-label="Type" style="padding:5px 4px;color:var(--text-muted)">${typeLabel} ${item.trade_type || 'swing'}</td>
    <td data-label="Entry" style="padding:5px 4px">${item.entry_date || '—'}<br><span style="color:var(--text-muted)">$${item.entry_price != null ? Number(item.entry_price).toFixed(3) : '—'}</span></td>
    <td data-label="Exit" style="padding:5px 4px;text-align:right">${item.exit_date || '—'}<br><span style="color:var(--text-muted)">${item.exit_price != null ? '$' + Number(item.exit_price).toFixed(3) : '—'}</span></td>
    <td data-label="P&L%" style="padding:5px 4px;text-align:right;font-weight:600;color:${pnlColor}">${pnlStr}</td>
    <td data-label="P&L $" style="padding:5px 4px;text-align:right;font-weight:600;color:${pnlDollarColor}">${pnlDollarStr}</td>
    <td data-label="Hold" style="padding:5px 4px;text-align:center;color:var(--text-muted)">${item.actual_hold_days != null ? item.actual_hold_days + 'd' : '—'}</td>
    <td data-label="Outcome" style="padding:5px 4px"><span style="background:${outcomeColor}22;color:${outcomeColor};padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600">${outcome.toUpperCase()}</span></td>
    <td data-label="Regime" style="padding:5px 4px;color:var(--text-muted);font-size:11px">${item.regime || '—'}</td>
    <td style="padding:5px 4px;text-align:right">
      <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:#dc2626" onclick="dtDeleteSnapshot(${item.id})">✕</button>
    </td>
  </tr>`;
  return mainRow + (isExpanded ? _dtBuildDetailRow(item) : '');
}

function dtLoadMoreHistory() {
  dtLoadHistory(false).then(function() {
    var el = document.getElementById('dt-tab-content');
    if (el) el.innerHTML = renderDtHistoryTab();
  });
}

function dtDeleteSnapshot(id) {
  if (!confirm('Delete this trade record?')) return;
  fetch(`${API}/api/daytrading/snapshot/` + id, { method: 'DELETE' })
    .then(function() {
      _dtHistItems = _dtHistItems.filter(function(x) { return x.id !== id; });
      if (_dtStats && _dtStats.total) _dtStats.total--;
      var el = document.getElementById('dt-tab-content');
      if (el) el.innerHTML = renderDtHistoryTab();
    });
}

function dtDeleteAllHistory() {
  if (!confirm('Delete ALL day trade history? This cannot be undone.')) return;
  // Delete each one (small dataset, fine for now)
  var ids = _dtHistItems.map(function(x) { return x.id; });
  Promise.all(ids.map(function(id) {
    return fetch(`${API}/api/daytrading/snapshot/` + id, { method: 'DELETE' });
  })).then(function() {
    _dtHistItems = [];
    _dtHistOffset = 0;
    _dtHistMore = false;
    _dtStats = null;
    var el = document.getElementById('dt-tab-content');
    if (el) el.innerHTML = renderDtHistoryTab();
    toast('History cleared', 'success');
  });
}

/* ── Render: Model tab ───────────────────────────────────────────────────── */
function renderDtModelTab() {
  // If model not loaded yet, fetch and re-render
  if (_dtModel === undefined) {
    Promise.all([dtLoadModel(), dtLoadStats()]).then(function() {
      var el = document.getElementById('dt-tab-content');
      if (el && (state.dayTrading && state.dayTrading.activeTab) === 'model') {
        el.innerHTML = renderDtModelTab();
      }
    });
    return _dtHistLoadingHTML();
  }

  var stats = _dtStats;
  var readyToTrain = stats && stats.ready_to_train;
  var minSamples = (stats && stats.min_train_samples) || 15;
  var completed  = (stats && stats.completed) || 0;

  var modelSection = '';
  if (_dtModel) {
    // Use swing model for display; fallback to intraday
    var m = (_dtModel.swing || _dtModel.intraday) || {};
    var r2Oos  = m.r2_oos  != null ? m.r2_oos.toFixed(4)  : null;
    var maeOos = m.mae_oos != null ? m.mae_oos.toFixed(4)  : null;
    var r2     = m.r2_score  != null ? m.r2_score.toFixed(4)  : '—';
    var mae    = m.mae_score != null ? m.mae_score.toFixed(4)  : '—';
    var cvLabel = m.cv_method === 'walk_forward' ? 'walk-forward' : m.cv_method === 'holdout' ? 'holdout' : null;
    var modelTypeLabel = (m.model_type === 'ridge') ? 'Ridge Regression' : 'Logistic Regression';

    // Feature importance chart — use swing importances
    var importHTML = '';
    var importSrc = (_dtImportances && _dtImportances.swing && _dtImportances.swing.length)
      ? _dtImportances.swing
      : (_dtImportances && _dtImportances.intraday ? _dtImportances.intraday : []);
    if (importSrc.length) {
      var maxIC = Math.max.apply(null, importSrc.map(function(x) { return Math.abs(x.ic); }));
      if (maxIC < 0.001) maxIC = 0.001;
      importHTML = '<div style="margin-top:12px">' +
        '<div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">Feature Importance (Spearman IC)</div>' +
        importSrc.slice(0, 12).map(function(f) {
          var barWidth = Math.min(100, Math.abs(f.ic) / maxIC * 100).toFixed(0);
          var icColor  = f.ic > 0 ? '#059669' : '#dc2626';
          var icSign   = f.ic >= 0 ? '+' : '';
          return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">' +
            '<span style="width:110px;font-size:11px;color:var(--text-secondary);flex-shrink:0;text-align:right">' + f.feature_name + '</span>' +
            '<div style="flex:1;height:12px;background:var(--bg-subtle);border-radius:3px;overflow:hidden">' +
              '<div style="width:' + barWidth + '%;height:100%;background:' + icColor + ';border-radius:3px"></div>' +
            '</div>' +
            '<span style="width:48px;font-size:11px;font-weight:600;color:' + icColor + '">' + icSign + f.ic.toFixed(3) + '</span>' +
          '</div>';
        }).join('') +
        '</div>';
    }

    modelSection = `
      <div class="card" style="padding:14px;margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:10px">Current Model — ${modelTypeLabel}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">Trained: ${m.trained_at || '—'} · ${m.n_samples || '—'} samples (${m.n_wins || 0}W / ${m.n_losses || 0}L)</div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:8px">
          ${r2Oos != null
            ? _dtStatCard('R² (OOS)', r2Oos, parseFloat(r2Oos) >= 0.1 ? '#059669' : parseFloat(r2Oos) >= 0 ? '#3b82f6' : '#dc2626')
            : _dtStatCard('R² Score', r2, '#3b82f6')}
          ${maeOos != null
            ? _dtStatCard('MAE OOS', maeOos, '#8b5cf6')
            : _dtStatCard('MAE (R)', mae, '#8b5cf6')}
        </div>
        ${r2Oos != null ? `
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;line-height:1.5">
          OOS = ${cvLabel || 'held-out'} · n_test=${m.n_test || 0} &nbsp;|&nbsp; Train fit: R²=${r2} MAE=${mae}
          <span style="opacity:0.7">(in-sample overstates skill)</span>
        </div>` : ''}
        ${importHTML}
      </div>`;
  } else {
    modelSection = `
      <div class="card" style="padding:14px;margin-bottom:12px;text-align:center;color:var(--text-muted)">
        <div style="font-size:24px;margin-bottom:8px">🧠</div>
        <div style="font-weight:600;margin-bottom:6px">No trained model yet</div>
        <div style="font-size:12px">
          The model learns from your completed trades.<br>
          ${completed < minSamples
            ? `<span style="color:#f59e0b">Need ${minSamples - completed} more completed trades before training (${completed}/${minSamples})</span>`
            : 'Click <strong>Train Model</strong> to fit the classifier.'}
        </div>
      </div>`;
  }

  var howItWorksHTML = `
    <div class="card" style="padding:14px;font-size:12px;color:var(--text-secondary);line-height:1.6">
      <div style="font-weight:600;color:var(--text-primary);margin-bottom:8px">How It Works</div>
      <ul style="margin:0;padding-left:18px">
        <li>Each day trade records 18 technical indicators and market context at entry time.</li>
        <li>When you close a trade, the outcome (win/loss) is automatically recorded.</li>
        <li>The training algorithm fits a <strong>logistic regression</strong> using gradient descent — no Claude API, no external calls.</li>
        <li><strong>Feature importance</strong> (Spearman IC) shows which indicators historically predict your wins.</li>
        <li>A <strong>win probability</strong> column appears in the Setups tab once the model is trained, helping you prioritise setups that match patterns that worked before.</li>
        <li>Retrain after every 10–20 new trades to keep the model fresh.</li>
      </ul>
    </div>`;

  return `
    <div style="padding:4px 0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="font-weight:600">Trading Intelligence Model</div>
        <button id="dt-train-btn" class="btn btn-primary btn-sm"
          ${readyToTrain ? '' : 'disabled title="Need more completed trades"'}
          onclick="dtTrain()">🔁 Train Model</button>
      </div>
      ${modelSection}
      ${howItWorksHTML}
    </div>`;
}

/* Load importances into _dtModel after dtLoadModel() ─────────────────────── */
function dtLoadModelWithImportances() {
  // Delegates to dtLoadModel which now loads both models + importances
  return dtLoadModel();
}

/**
 * Returns an HTML badge with the expected R-multiple from the ML model.
 * Green ≥ +0.6R, amber +0.15 to +0.59R, red < +0.15R.
 * Returns '' if no model or no signals available.
 */
function dtExpectedRLabel(rec) {
  if (!_dtModel) return '';
  var tradeType = rec.tradeType || 'swing';
  var model = (tradeType === 'intraday' && _dtModel.intraday)
    ? _dtModel.intraday
    : (_dtModel.swing || _dtModel.intraday);
  if (!model) return '';

  var sigs     = (state.liveSignals && state.liveSignals[rec.ticker]) || {};
  var features = dtBuildFeatures(sigs, state.macroData || {});
  var expectedR = dtPredictLocal(features, model);
  if (expectedR === null || isNaN(expectedR)) return '';

  var color = expectedR >= 0.6 ? '#10b981' : expectedR >= 0.15 ? '#f59e0b' : '#ef4444';
  var label = (expectedR >= 0 ? '+' : '') + expectedR.toFixed(2) + 'R';
  return '<span style="background:' + color + ';color:#000;font-size:10px;font-weight:700;'
       + 'padding:2px 7px;border-radius:4px" title="Expected R-multiple — ridge regression ML model">'
       + '📊 ' + label + '</span>';
}

// Backward-compat alias — day-trading.js calls dtWinProbLabel(r)
function dtWinProbLabel(rec) { return dtExpectedRLabel(rec); }

/* ── Retrain nudge (Sprint 63) ───────────────────────────────────────────── */
/**
 * §14.10 says "retrain after every 10–20 new completed trades" but nothing
 * tracked it. Once ≥15 completed trades have accumulated past the last
 * training run's n_samples, push a one-shot bell notification (category
 * 'retrain' deep-links to the Day Trading page). One nudge per trained_at —
 * retraining changes trained_at, which re-arms the nudge automatically.
 * Note: `completed` spans both trade types while n_samples is the latest
 * model's scope — slightly noisy for mixed swing/intraday use, fine for a nudge.
 */
function _dtCheckRetrainNudge() {
  try {
    if (!_dtStats || !_dtStats.ok) return;
    var model = _dtStats.model;
    if (!model || !model.trained_at) return;   // no model yet — Model tab handles onboarding
    var newSince = (_dtStats.completed || 0) - (model.n_samples || 0);
    if (newSince < 15) return;
    var KEY = 'dt_retrain_nudged_for';
    if (localStorage.getItem(KEY) === String(model.trained_at)) return;  // already nudged for this model
    localStorage.setItem(KEY, String(model.trained_at));
    if (typeof pushNotification === 'function') {
      pushNotification('info', '🧠 ML model is stale',
        newSince + ' completed trades since the last training run ('
        + String(model.trained_at).slice(0, 10) + '). Retrain via Day Trading → 🧠 Model tab '
        + 'to fold them in (regime_risk applies retroactively). Tap to open.',
        'retrain');
    }
  } catch (_) { /* never break startup */ }
}

/* ── Initialise on startup (non-blocking) ────────────────────────────────── */
// Silently load model + stats so predictions are ready when the DT page opens.
// _dtModel is initialised to undefined so renderDtModelTab can distinguish
// "not loaded yet" from "loaded but null (no model)".
Promise.all([dtLoadModelWithImportances(), dtLoadStats()]).then(function() {
  _dtCheckRetrainNudge();
}).catch(function() {});
