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
var _dtHistItems  = [];    // current history page items
var _dtHistOffset = 0;
var _dtHistMore   = false;
var _dtStats      = null;  // summary stats

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
    regime:      (state.currentRegime && state.currentRegime.regime) || null,
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

  return fetch('/api/daytrading/snapshot', {
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
 * exitData   — { exit_price, entry_price, exit_date, exit_reason, actual_hold_days }
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
  };

  // Compute pnl_pct if not supplied
  if (body.pnl_pct == null && body.exit_price && body.entry_price) {
    body.pnl_pct = (body.exit_price - body.entry_price) / body.entry_price * 100;
  }

  return fetch('/api/daytrading/snapshot/' + snapshotId + '/close', {
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
  return fetch('/api/daytrading/model')
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
  if (reset) { _dtHistItems = []; _dtHistOffset = 0; _dtHistMore = false; }
  var limit = 20;
  return fetch('/api/daytrading/history?limit=' + limit + '&offset=' + _dtHistOffset)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) {
        _dtHistItems = _dtHistItems.concat(d.items || []);
        _dtHistMore  = d.has_more || false;
        _dtHistOffset += limit;
      }
      return d;
    })
    .catch(function() { return null; });
}

/* ── Load stats ───────────────────────────────────────────────────────────── */
function dtLoadStats() {
  return fetch('/api/daytrading/stats')
    .then(function(r) { return r.json(); })
    .then(function(d) { if (d.ok) _dtStats = d; return d; })
    .catch(function() { return null; });
}

/* ── Train model ─────────────────────────────────────────────────────────── */
function dtTrain() {
  var btn = document.getElementById('dt-train-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Training…'; }

  fetch('/api/daytrading/train', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) {
        var swingOk = d.models && d.models.swing && d.models.swing.ok;
        var trainMsg = swingOk
          ? 'Model trained — R²=' + (d.r2_score || 0).toFixed(3) + ' on ' + (d.n_samples || '?') + ' trades'
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
  // Trigger async load then re-render
  if (_dtHistItems.length === 0) {
    Promise.all([dtLoadHistory(true), dtLoadStats()]).then(function() {
      var el = document.getElementById('dt-tab-content');
      if (el && (state.dayTrading && state.dayTrading.activeTab) === 'history') {
        el.innerHTML = renderDtHistoryTab();
      }
    });
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

  var rowsHTML = '';
  if (items.length === 0) {
    rowsHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">No completed trades recorded yet.<br>Execute a day trade to start building your history.</div>';
  } else {
    rowsHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="border-bottom:1px solid var(--border);color:var(--text-secondary)">
            <th style="text-align:left;padding:5px 4px">Ticker</th>
            <th style="text-align:left;padding:5px 4px">Type</th>
            <th style="text-align:left;padding:5px 4px">Entry</th>
            <th style="text-align:right;padding:5px 4px">Exit</th>
            <th style="text-align:right;padding:5px 4px">P&L%</th>
            <th style="text-align:center;padding:5px 4px">Hold</th>
            <th style="text-align:left;padding:5px 4px">Outcome</th>
            <th style="text-align:left;padding:5px 4px">Regime</th>
            <th style="text-align:right;padding:5px 4px"></th>
          </tr>
        </thead>
        <tbody>
          ${items.map(_dtHistRow).join('')}
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
      ${rowsHTML}
    </div>`;
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

function _dtHistRow(item) {
  var outcome = item.outcome || 'open';
  var outcomeColor = outcome === 'win' ? '#059669' : outcome === 'loss' ? '#dc2626' : outcome === 'open' ? '#6366f1' : '#94a3b8';
  var pnlStr = item.pnl_pct != null ? (item.pnl_pct >= 0 ? '+' : '') + item.pnl_pct.toFixed(2) + '%' : '—';
  var pnlColor = item.pnl_pct >= 0 ? '#059669' : '#dc2626';
  var typeLabel = item.trade_type === 'intraday' ? '⚡' : '◈';
  return `<tr style="border-bottom:1px solid var(--border-subtle)">
    <td style="padding:5px 4px;font-weight:600">${item.ticker}</td>
    <td style="padding:5px 4px;color:var(--text-muted)">${typeLabel} ${item.trade_type || 'swing'}</td>
    <td style="padding:5px 4px">${item.entry_date || '—'}<br><span style="color:var(--text-muted)">$${item.entry_price != null ? Number(item.entry_price).toFixed(3) : '—'}</span></td>
    <td style="padding:5px 4px;text-align:right">${item.exit_date || '—'}<br><span style="color:var(--text-muted)">${item.exit_price != null ? '$' + Number(item.exit_price).toFixed(3) : '—'}</span></td>
    <td style="padding:5px 4px;text-align:right;font-weight:600;color:${pnlColor}">${pnlStr}</td>
    <td style="padding:5px 4px;text-align:center;color:var(--text-muted)">${item.actual_hold_days != null ? item.actual_hold_days + 'd' : '—'}</td>
    <td style="padding:5px 4px"><span style="background:${outcomeColor}22;color:${outcomeColor};padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600">${outcome.toUpperCase()}</span></td>
    <td style="padding:5px 4px;color:var(--text-muted);font-size:11px">${item.regime || '—'}</td>
    <td style="padding:5px 4px;text-align:right">
      <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:#dc2626" onclick="dtDeleteSnapshot(${item.id})">✕</button>
    </td>
  </tr>`;
}

function dtLoadMoreHistory() {
  dtLoadHistory(false).then(function() {
    var el = document.getElementById('dt-tab-content');
    if (el) el.innerHTML = renderDtHistoryTab();
  });
}

function dtDeleteSnapshot(id) {
  if (!confirm('Delete this trade record?')) return;
  fetch('/api/daytrading/snapshot/' + id, { method: 'DELETE' })
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
    return fetch('/api/daytrading/snapshot/' + id, { method: 'DELETE' });
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
    var r2  = m.r2_score  != null ? m.r2_score.toFixed(4)  : '—';
    var mae = m.mae_score != null ? m.mae_score.toFixed(4)  : '—';
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
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:10px">
          ${_dtStatCard('R² Score', r2, '#3b82f6')}
          ${_dtStatCard('MAE (R)', mae, '#8b5cf6')}
        </div>
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

/* ── Initialise on startup (non-blocking) ────────────────────────────────── */
// Silently load model + stats so predictions are ready when the DT page opens.
// _dtModel is initialised to undefined so renderDtModelTab can distinguish
// "not loaded yet" from "loaded but null (no model)".
Promise.all([dtLoadModelWithImportances(), dtLoadStats()]).then(function() {
  // Nothing to render here — tabs pull from the cache when opened
}).catch(function() {});
