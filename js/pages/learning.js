// ============================================================
// learning.js — Learning Loop page
//
// Fetches from GET /api/learning/stats and renders:
//   - Summary metric cards
//   - Confidence calibration table (win rate by confidence band)
//   - Regime performance table
//   - Prompt version history
//   - Recent events list
//   - Failed tickers
//
// API response shape (asx_server.py /api/learning/stats):
//   { total, closed, wins, overall_win_rate,
//     conf_bands: [{band, wins, total, win_rate}],
//     regime_stats: [{regime, wins, total, win_rate}],
//     version_stats: [{version, total_calls, wins, closed, win_rate}],
//     by_model: {modelName: {n, wins, win_rate, ci_lo, ci_hi, low_n, avg_pnl, avg_hold}},
//     recent_events: [{id, timestamp, ticker, recommendation, ai_confidence,
//                      ensemble_confidence, outcome_status, realized_pnl_pct,
//                      regime, prompt_version, was_executed}],
//     failed_tickers: [{ticker, error, context, timestamp}] }
//
// win_rate is already a percentage (0–100), NOT a 0–1 fraction.
// ============================================================

// Module-level cache: events keyed by id from the last render of
// _renderLearningContent(). Used by viewStoredDebate() to grab the
// postmortem_debate JSON blob without re-fetching from the server.
let _learningEventsById = {};

// ── Error-tag taxonomy + tag-cell renderers ───────────────────────────────────
// Hoisted to module scope (not just inside _renderLearningContent) so that
// tagLearningEvent() can re-render a single row's tag cell after a targeted
// PATCH without needing a full showPage('learning') re-render.
const _LL_ERROR_TYPE_LABELS = {
  overconfident:   { label: 'Overconfident',    color: '#dc2626' },
  missed_catalyst: { label: 'Missed catalyst',  color: '#d97706' },
  regime_mismatch: { label: 'Regime mismatch',  color: '#7c3aed' },
  poor_entry:      { label: 'Poor entry',       color: '#ea580c' },
  stop_too_tight:  { label: 'Stop too tight',   color: '#0891b2' },
  poor_rr:         { label: 'Poor R:R',         color: '#6b7280' },
  external_shock:  { label: 'External shock',   color: '#be185d' },
  thesis_broken:   { label: 'Thesis broken',    color: '#92400e' },
};

// Tag buttons — LOSS and BREAKEVEN only; wins don't get error tags (errors on wins = luck, not failure).
// Multiple tags supported — stored as comma-separated string ("overconfident,regime_mismatch").
// Each button toggles independently; auto-tagged buttons show 🔍 prefix + dashed border.
const _LL_TAG_STATUSES    = new Set(['loss', 'breakeven']);
const _LL_CLOSED_STATUSES = new Set(['win', 'loss', 'breakeven']); // kept for postmortem compat

function _llTagButtons(evId, currentTagStr, tagSource) {
  const activeTags = new Set(
    (currentTagStr || '').split(',').map(t => t.trim()).filter(Boolean)
  );
  const tags = [
    ['overconfident',   'OC', 'Overconfident — stated AI confidence was too high for actual risk'],
    ['missed_catalyst', 'MC', 'Missed catalyst — key earnings/news/macro event not accounted for'],
    ['regime_mismatch', 'RM', 'Regime mismatch — wrong strategy for the prevailing market regime'],
    ['poor_entry',      'PE', 'Poor entry — timing or price was suboptimal'],
    ['stop_too_tight',  'ST', 'Stop too tight — normal volatility triggered stop before the move played out'],
    ['poor_rr',         'PR', 'Poor R:R — reward:risk ratio was too low from the start'],
    ['external_shock',  'ES', 'External shock — outcome driven by unpredictable event (policy, black swan)'],
    ['thesis_broken',   'TB', 'Thesis broken — invalidated by new information that emerged after entry'],
  ];
  const escapedCurrent = JSON.stringify(currentTagStr || '').replace(/"/g, '&quot;');
  return `<div style="display:flex;gap:2px;flex-wrap:wrap">` +
    tags.map(([key, short, tip]) => {
      const active  = activeTags.has(key);
      const isAuto  = active && tagSource === 'auto';
      const meta    = _LL_ERROR_TYPE_LABELS[key] || { color: '#6b7280' };
      const border  = active
        ? (isAuto ? `1.5px dashed ${meta.color}` : `1px solid ${meta.color}`)
        : `1px solid ${meta.color}55`;
      return `<button
        onclick="toggleLearningTag(${evId}, ${escapedCurrent}, '${key}')"
        title="${tip}${isAuto ? ' (auto — click to toggle)' : ''}"
        style="font-size:9px;padding:1px 5px;border-radius:2px;line-height:1.5;cursor:pointer;
               border:${border};font-weight:${active ? 700 : 500};
               background:${active ? meta.color : 'transparent'};
               color:${active ? '#fff' : meta.color}"
      >${isAuto && active ? '🔍 ' : ''}${short}</button>`;
    }).join('') +
  `</div>`;
}

// tagCell: error tags only for loss/breakeven; open/win/expired get nothing.
// When error_type='none' (reviewed-clean), shows a small ✓ badge so it's
// distinguishable from unreviewed rows, then still renders the buttons for re-tagging.
function _llTagCell(evId, currentTagStr, status, tagSource) {
  if (!_LL_TAG_STATUSES.has(status)) return '';
  const noneBadge = (currentTagStr === 'none')
    ? `<span title="Reviewed by Ollama — no systematic error found"
             style="font-size:9px;padding:1px 5px;border-radius:2px;margin-right:3px;
                    color:var(--text-muted);border:1px solid var(--border);display:inline-block">✓ no error</span>`
    : '';
  return noneBadge + _llTagButtons(evId, currentTagStr, tagSource);
}

// ── Recent Events: filter rows by win tag-status ─────────────────────────────
// Rows carry data-wintag = pattern | none | untagged | na (non-win). Pure DOM
// toggle — no re-fetch/re-render — so it survives the frequent scheduleSave()
// re-render cycles as long as it's re-applied on demand.
function _llFilterWinTags(mode) {
  document.querySelectorAll('tr[data-wintag]').forEach(tr => {
    const s = tr.getAttribute('data-wintag');
    let show = true;
    if (mode === 'tagged')        show = (s === 'pattern' || s === 'none');
    else if (mode === 'untagged') show = (s === 'untagged');
    // 'all' (default) shows every row, including non-win 'na' rows.
    tr.style.display = show ? '' : 'none';
  });
}

// ── Batch classify state — persists across page re-renders ───────────────────
// renderLearningPage() calls _syncClassifyUI() after every re-render so the
// progress bar survives scheduleSave() / refreshPrices() re-render cycles.
window._classifyAllState = null;   // null = idle

function _syncClassifyUI() {
  const s    = window._classifyAllState;
  const btn  = document.getElementById('classify-all-btn');
  const prog = document.getElementById('classify-all-progress');

  if (!s) {
    if (btn)  { btn.disabled = false; btn.textContent = '🤖 Classify All Untagged'; }
    if (prog) prog.style.display = 'none';
    return;
  }

  const pct = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
  const statusLine =
    `🏷 ${s.tagged} tagged &nbsp;·&nbsp; ⬜ ${s.noneCount} no error &nbsp;·&nbsp; ❌ ${s.failed} failed`;

  if (btn) {
    btn.disabled  = s.running;
    btn.textContent = s.running ? `⏳ ${s.done}/${s.total}` : '🤖 Classify All Untagged';
  }

  if (prog) {
    prog.style.display = 'block';
    if (s.running) {
      prog.innerHTML =
        `<strong>Classifying ${s.done}/${s.total}</strong> (${s.model}) &nbsp;·&nbsp; ${statusLine}` +
        `<div style="margin-top:4px;height:4px;background:var(--border);border-radius:2px">` +
        `<div style="width:${pct}%;height:100%;background:#3b82f6;border-radius:2px;transition:width 0.3s"></div>` +
        `</div>`;
    } else {
      prog.innerHTML =
        `<strong>✅ Done — ${s.total} processed</strong> &nbsp;·&nbsp; ${statusLine}` +
        `<button class="btn btn-sm" style="margin-left:8px"` +
        ` onclick="window._classifyAllState=null;_syncClassifyUI();showPage('learning')">Refresh</button>`;
    }
  }
}

// ── Master date-window filter ────────────────────────────────────────────────
// One global window applied to the dated transaction-LIST cards (Recent Events,
// Buy/Sell Decision Trackers). Aggregate/stat cards (win-rates, calibration,
// matrices, verdicts) deliberately IGNORE it — they need full history to be the
// learning signal. Default 90 days so "years of data" never dumps hundreds of
// rows; 0 = All (bounded by each card's own count cap).
const _LL_WINDOW_PRESETS = [[30, '30d'], [90, '90d'], [180, '6M'], [365, '1Y'], [0, 'All']];
function _llWindowDays() {
  const v = state._llWindowDays;
  return (v === 0 || v > 0) ? v : 90;   // default 90d when unset
}
function _llWindowParam() {
  const d = _llWindowDays();
  return d > 0 ? `&days=${d}` : '';
}
// Client-side window filter for lists rendered from an already-fetched array
// (Recent Events rides the shared /stats payload, so it can't take a ?days param).
function _llWithinWindow(timestamp) {
  const d = _llWindowDays();
  if (d <= 0) return true;
  if (!timestamp) return true;                 // keep undated rows rather than hide them
  const t = new Date(timestamp).getTime();
  return isNaN(t) || t >= Date.now() - d * 86400000;
}
function setLlWindow(days) {
  state._llWindowDays = days;
  renderPage();   // full re-render so every dated card refetches with the new window
}

// ── Recent Events row-count filter ───────────────────────────────────────────
// Recent Events is server-capped (LIMIT on the SQL query, not a client slice) so
// pending-tag rows past the cap don't silently vanish. `events_limit` is sent as
// a query param on /api/learning/stats; changing it requires a refetch, same
// pattern as setLlWindow() above.
const _LL_EVENTS_LIMIT_PRESETS = [[30, '30'], [60, '60'], [90, '90'], [0, 'All']];
function _llEventsLimit() {
  const v = state._llEventsLimit;
  return (v === 0 || v > 0) ? v : 30;   // default 30 when unset
}
function setLlEventsLimit(n) {
  state._llEventsLimit = n;
  renderPage();   // full re-render so /api/learning/stats refetches with the new limit
}
function _llEventsLimitBar() {
  const cur = _llEventsLimit();
  return `<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
    <span class="text-xs text-muted">Show:</span>
    ${_LL_EVENTS_LIMIT_PRESETS.map(([n, lab]) => `<button class="btn btn-sm" style="${n === cur ? 'background:var(--accent-primary);color:#fff;border-color:var(--accent-primary)' : ''}" onclick="setLlEventsLimit(${n})" title="Show ${lab === 'All' ? 'all logged events' : lab + ' most recent events'}">${lab}</button>`).join('')}
  </div>`;
}
function _llWindowBar() {
  const cur = _llWindowDays();
  return `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px;padding:8px 10px;border:0.5px solid var(--border-light);border-radius:var(--radius-md,6px);background:var(--bg-inset)">
    <span class="text-xs" style="font-weight:600">📅 Show trades from:</span>
    ${_LL_WINDOW_PRESETS.map(([d, lab]) => `<button class="btn btn-sm" style="${d === cur ? 'background:var(--accent-primary);color:#fff;border-color:var(--accent-primary)' : ''}" onclick="setLlWindow(${d})">${lab}</button>`).join('')}
    <span class="text-xs text-muted" style="margin-left:4px">Applies to the dated lists (Recent Events, Buy/Sell Trackers). Stats &amp; calibration always use full history.</span>
  </div>`;
}

async function renderLearningPage(gen) {
  const el = document.getElementById('main-content');
  if (state._renderGen !== gen) return;

  // Skeleton while fetching
  el.innerHTML = `
    <div class="card" style="padding:18px;display:flex;align-items:center;gap:10px">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <span class="text-xs text-muted">Loading Learning Loop data…</span>
    </div>`;

  let data = null;
  let brierData = null;
  try {
    const [resp, brierResp] = await Promise.all([
      fetch(`${API}/api/learning/stats?events_limit=${_llEventsLimit()}`),
      fetch(`${API}/api/learning/calibration-stats`).catch(() => null),
    ]);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
    if (data.error) throw new Error(data.error);
    if (brierResp && brierResp.ok) brierData = await brierResp.json().catch(() => null);
  } catch (e) {
    if (state._renderGen !== gen) return;
    el.innerHTML = `<div class="card"><div class="text-muted text-sm" style="padding:12px">
      ⚠️ Could not load Learning Loop stats: ${e.message}<br>
      <span class="text-xs">Make sure the backend server is running and has processed at least one AI call.</span>
    </div></div>`;
    return;
  }
  if (state._renderGen !== gen) return;

  el.innerHTML = _renderLearningContent(data, brierData);

  // Restore batch-classify progress bar if a run is in progress or just finished.
  // Must happen immediately after innerHTML is set so the newly-created DOM elements exist.
  _syncClassifyUI();

  // Async: load debate engine status without blocking the main render
  if (typeof debateStatus === 'function') {
    renderLearningDebateCard().catch(() => {});
  }
  // Async: load Phase 6 calibration quality card
  renderCalibQualityCard().catch(() => {});
  // Async: load debate stats card (per-pairing agreement breakdown)
  renderDebateStatsCard().catch(() => {});
  // Async: load trading lessons card
  renderLessonsCard().catch(() => {});
  // Async: load calibration trend card (Learning Loop improvement E)
  renderCalibrationTrendCard().catch(() => {});
  renderCalibrationEfficacyCard().catch(() => {});
  // Async: load sell decision tracker card (Gap 3 + Gap 7)
  renderSellOutcomesCard().catch(() => {});
  // Async: load buy/top-up decision tracker card (entry-side complement)
  renderBuyOutcomesCard().catch(() => {});
  // Async: one-time backfill of pre-feature rule warnings from recHistory /
  // recommendations (_ruleWarnings persisted in extra_json) into the learning
  // events, THEN render the efficacy card so it populates from existing history
  // instead of only from new analysis runs.
  _backfillRuleWarningsOnce()
    .then(() => renderRuleEfficacyCard())
    .catch(() => { renderRuleEfficacyCard().catch(() => {}); });
  // Async: load thesis drift analytics card (Sprint 45)
  renderThesisDriftCard().catch(() => {});
  // Async: load thesis accuracy matrix card (Phase 2+3)
  renderThesisMatrixCard().catch(() => {});
  // Async: load execution alpha card (Sprint 63)
  renderExecutionAlphaCard().catch(() => {});
  // Async: load tag accuracy card (Gap 6)
  renderTagAccuracyCard().catch(() => {});
  // Async: load data-hygiene coverage strip (IMPROVEMENTS #3)
  renderCoverageCard().catch(() => {});
  // Async: load go-live readiness scorecard
  renderGoLiveCard().catch(() => {});
  // Async: load the dedicated HOLD Decisions card (per-HOLD 30-day passivity review)
  renderHoldDecisionsCard().catch(() => {});
  // Async: load entry signal factor analysis card
  renderFactorWinRatesCard().catch(() => {});
}

function _renderLearningContent(d, brier) {
  // Backend fields (flat, win_rate already 0-100)
  const total        = d.total            ?? 0;
  const closed       = d.closed           ?? 0;
  const wins         = d.wins             ?? 0;
  const overallWR    = d.overall_win_rate;                // null or 0-100
  const overallCiLo  = d.overall_ci_lo;                  // Wilson CI low (%)
  const overallCiHi  = d.overall_ci_hi;                  // Wilson CI high (%)
  const calibActive  = d.calibration_active ?? (closed >= 30);
  const confBands       = d.conf_bands        || [];
  const regimes         = d.regime_stats      || [];
  const versions        = d.version_stats     || [];
  // Recent Events rides the shared /stats payload (can't take a ?days param), so
  // apply the master window client-side. The list is already server-capped at 30.
  const events          = (d.recent_events   || []).filter(e => _llWithinWindow(e.timestamp));
  const failed          = d.failed_tickers    || [];
  const failPats        = d.failure_patterns  || {};
  const successPats     = d.success_patterns  || {};
  const debateInsights  = d.debate_insights   || [];
  const insufficientData  = d.insufficient_data ?? (closed < 10);
  const promptRegression  = d.prompt_regression  || null;  // Gap 5
  const phase8            = d.phase8             || null;  // Gap 2
  const nVirtualResolved  = d.n_virtual_resolved ?? 0;     // virtual outcomes resolved via OHLC scan
  const holdOutcomes      = d.hold_outcomes       || null; // HOLD passivity calibration (miss/correct rate)
  const byModel           = d.by_model            || {};   // per-LLM track record (Model-Aware Calibration Part B, Step 3)

  // Cache events by id so viewStoredDebate() can look up postmortem_debate JSON
  // without an extra HTTP round-trip.
  _learningEventsById = {};
  for (const ev of events) _learningEventsById[ev.id] = ev;

  // Helpers
  const fmt = (v, dp = 1) => v == null ? '—' : Number(v).toFixed(dp);
  const pct = (v) => v == null ? '—' : Number(v).toFixed(0) + '%';
  const rateColor = r => r == null ? 'var(--text-secondary)' : r >= 60 ? '#16a34a' : r >= 45 ? '#d97706' : '#dc2626';
  const sampleBadge = n => n < 5
    ? `<span title="Limited data — treat with caution" style="margin-left:4px;font-size:10px;color:#d97706;background:#fef3c7;border-radius:3px;padding:1px 5px">n=${n} ⚠</span>`
    : `<span style="margin-left:4px;font-size:10px;color:var(--text-muted)">(n=${n})</span>`;

  // Derive summary stats from conf_bands for high-conf win rate
  const hcBands = confBands.filter(b => !isNaN(parseFloat(b.band)) && parseFloat(b.band) >= 70);
  const hcTotal = hcBands.reduce((s, b) => s + (b.total || 0), 0);
  const hcWins  = hcBands.reduce((s, b) => s + (b.wins  || 0), 0);
  const hcWR    = hcTotal > 0 ? (hcWins / hcTotal * 100) : null;

  const latestVer   = versions.length ? versions[0].version : null;
  const latestCalls = versions.length ? versions[0].total_calls : 0;

  // ── Summary cards ─────────────────────────────────────────────────────────
  const summaryCards = `
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Total AI Events</div>
        <div class="metric-value">${total}</div>
        <div class="metric-sub">${total - closed} open · ${closed} closed</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Overall Win Rate</div>
        <div class="metric-value ${overallWR != null && overallWR >= 50 ? 'up' : 'down'}">${pct(overallWR)}</div>
        <div class="metric-sub">${wins}W / ${closed - wins}L (${closed} closed)</div>
        ${overallCiLo != null ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">95% CI: ${overallCiLo.toFixed(0)}–${overallCiHi.toFixed(0)}%${!calibActive ? ' · <span style="color:#d97706">n&lt;30, calibration paused</span>' : ''}</div>` : ''}
      </div>
      <div class="metric-card">
        <div class="metric-label">High-Conf Win Rate</div>
        <div class="metric-value ${hcWR != null && hcWR >= 60 ? 'up' : 'down'}">${pct(hcWR)}</div>
        <div class="metric-sub">Confidence ≥ 70% · ${hcTotal} trades${hcTotal < 5 ? ' · limited data' : ''}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Active Prompt Version</div>
        <div class="metric-value" style="font-size:13px">${latestVer || '—'}</div>
        <div class="metric-sub">${latestCalls} calls this version</div>
      </div>
      ${brier && brier.n > 0 ? `
      <div class="metric-card">
        <div class="metric-label">Brier Score</div>
        <div class="metric-value ${brier.brier_score <= 0.20 ? 'up' : brier.brier_score <= 0.25 ? '' : 'down'}">${brier.brier_score.toFixed(3)}</div>
        <div class="metric-sub">n=${brier.n} · 0=perfect · 0.25=random</div>
      </div>` : ''}
    </div>`;

  // ── Gap 5: Prompt regression banner ──────────────────────────────────────
  const regressionBanner = (() => {
    if (!promptRegression) return '';

    // Fix #19: evaluating state — new prompt, insufficient data for comparison.
    // Previously returned nothing (null → silent false-negative on the UI).
    if (promptRegression.status === 'evaluating') {
      return `
        <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;
                    padding:10px 14px;margin-bottom:12px;display:flex;gap:10px;align-items:flex-start">
          <span style="font-size:18px;line-height:1.2">⏳</span>
          <div style="flex:1">
            <strong style="font-size:13px">Evaluating ${promptRegression.current_version}</strong>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:3px">
              ${promptRegression.n_current} / ${promptRegression.min_n_required} closed trades
              &nbsp;·&nbsp; SE&nbsp;=&nbsp;${promptRegression.se_pp}pp — too wide for reliable comparison
              &nbsp;·&nbsp; No action needed, monitoring.
            </div>
          </div>
        </div>`;
    }

    const sig  = promptRegression.significant;
    const bdr  = sig ? 'rgba(239,68,68,.45)'  : 'rgba(245,158,11,.45)';
    const icon = sig ? '⚠️' : '🔔';
    const label = sig ? 'Significant regression detected' : 'Early warning — possible regression';
    return `
      <div style="background:var(--bg-surface);border:1px solid ${bdr};border-radius:6px;padding:10px 14px;margin-bottom:12px;display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:18px;line-height:1.2">${icon}</span>
        <div style="flex:1">
          <strong style="font-size:13px">${label}: ${promptRegression.current_version} vs ${promptRegression.prior_version}</strong>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:3px">
            Win rate dropped <strong>${promptRegression.drop_pp}pp</strong>
            (${promptRegression.prior_win_rate}% → ${promptRegression.current_win_rate}%)
            &nbsp;·&nbsp; SE = ${promptRegression.se_pp}pp
            &nbsp;·&nbsp; n = ${promptRegression.n_current} current / ${promptRegression.n_prior} prior
            ${sig ? ' &nbsp;·&nbsp; <strong>Review recent prompt changes.</strong>' : ' &nbsp;·&nbsp; Monitor — may be sampling noise.'}
          </div>
        </div>
      </div>`;
  })();

  // ── Gap 2: Phase 8 skill-weighting status note (Fix #10: Mann-Whitney Z) ───
  // Fix #39: also show z-score progress bar so users can see how close to activation
  const phase8Note = (() => {
    if (!phase8) return '';
    const icon    = phase8.active ? '✅' : '⏸️';
    const excl    = phase8.n_good_losses_excluded > 0
      ? ` · ${phase8.n_good_losses_excluded} good-loss${phase8.n_good_losses_excluded > 1 ? 'es' : ''} excluded`
      : '';
    const color   = phase8.active ? '#16a34a' : '#d97706';
    const label   = phase8.active
      ? `Phase 8 skill-weighting active (n=${phase8.n_scored}${excl})`
      : `Phase 8 skill-weighting paused — ${phase8.reason}`;

    // z-score progress toward activation (Fix #39)
    const z       = phase8.mann_whitney_z;
    const thresh  = phase8.mann_whitney_threshold ?? 1.28;
    const zProgressHtml = (() => {
      if (z == null) return '';
      const pct     = Math.min(100, Math.round((z / thresh) * 100));
      const barColor = phase8.active ? '#16a34a' : z >= thresh * 0.75 ? '#f59e0b' : '#6b7280';
      const gap     = phase8.active ? '' : ` · ${(thresh - z).toFixed(2)} more needed`;
      return `
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <div style="font-size:10px;color:var(--text-muted);white-space:nowrap">MW Z=${z.toFixed(2)} / ${thresh}</div>
          <div style="flex:1;max-width:120px;background:var(--bg-secondary);border-radius:3px;height:5px">
            <div style="width:${pct}%;height:5px;border-radius:3px;background:${barColor};transition:width .3s"></div>
          </div>
          <div style="font-size:10px;color:var(--text-muted)">${pct}%${gap}</div>
        </div>`;
    })();

    return `<div style="font-size:11px;color:${color};margin-bottom:8px">
      ${icon} ${label}${zProgressHtml}
    </div>`;
  })();

  // ── HOLD Passivity Check — did held longs sit through a drawdown they should have cut? ──
  // hold_outcomes comes from _resolve_hold_outcomes() (routes/learning.py, redesigned
  // 2026-07-09): each HOLD is graded ≥30 days after generation on the ENDPOINT return
  // over a fixed 20-trading-day forward window, direction-aware (a HOLD keeps a long, so
  // only a sustained downside past a VOL-SCALED band is a 'virtual_hold_miss'; up/flat is
  // 'virtual_hold_correct'). MIN_N mirrors _compute_hold_outcome_nudge()'s gate; the
  // ⚠HOLD_TOO_PASSIVE nudge is CI-gated on top (Wilson lower bound > 50%), so a bare
  // majority here does not by itself fire it.
  const HOLD_OUTCOME_MIN_N = 12;
  const holdOutcomesCard = (() => {
    if (!holdOutcomes || !holdOutcomes.n) {
      return `<div class="card section-gap">
        <div class="card-title">HOLD Passivity Check</div>
        <div class="text-xs text-muted">No resolved HOLDs yet — each HOLD needs ~30 days of price history before it's graded (did the held long sit through a drawdown it should have cut?). See the HOLD Decisions card below for per-ticker countdowns.</div>
      </div>`;
    }
    const gated   = holdOutcomes.n < HOLD_OUTCOME_MIN_N;
    const missPct = holdOutcomes.miss_rate ?? 0;
    const flagged = !gated && missPct > 50;
    const color   = gated ? '#6b7280' : flagged ? '#dc2626' : '#16a34a';
    const barPct  = Math.min(100, Math.round((holdOutcomes.n / HOLD_OUTCOME_MIN_N) * 100));
    return `<div class="card section-gap">
      <div class="card-title">HOLD Passivity Check</div>
      <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:6px">
        <div><span style="font-size:20px;font-weight:700;color:${color}">${holdOutcomes.miss_rate}%</span> <span class="text-xs text-muted">sat through a sustained drawdown</span></div>
        <div class="text-xs text-muted">${holdOutcomes.correct_rate}% held correctly · n=${holdOutcomes.n} resolved</div>
      </div>
      ${gated ? `
        <div style="display:flex;align-items:center;gap:8px">
          <div style="font-size:10px;color:var(--text-muted);white-space:nowrap">n=${holdOutcomes.n} / ${HOLD_OUTCOME_MIN_N} needed</div>
          <div style="flex:1;max-width:120px;background:var(--bg-secondary);border-radius:3px;height:5px">
            <div style="width:${barPct}%;height:5px;border-radius:3px;background:#6b7280"></div>
          </div>
          <div style="font-size:10px;color:var(--text-muted)">gated until n≥${HOLD_OUTCOME_MIN_N}</div>
        </div>
        <div class="text-xs text-muted" style="margin-top:4px">Below the minimum sample size — the ⚠HOLD_TOO_PASSIVE calibration nudge (injected into the next portfolio prompt) stays silent until enough HOLDs have resolved.</div>
      ` : flagged ? `
        <div class="text-xs" style="color:#dc2626">⚠ A majority of held longs sat through a sustained drawdown — if the Wilson CI clears 50%, the next portfolio analysis carries a HOLD_TOO_PASSIVE nudge telling Claude it's been too conservative.</div>
      ` : `
        <div class="text-xs" style="color:#16a34a">✓ Miss rate is healthy — patience is paying off here, no nudge active.</div>
      `}
    </div>`;
  })();

  // ── Calibration table ──────────────────────────────────────────────────────
  const calibCard = `
    <div class="card section-gap">
      <div class="card-title">Confidence Calibration</div>
      ${insufficientData ? `
      <div style="background:var(--warn-bg,#fef3c7);border:1px solid var(--warn,#d97706);border-radius:5px;padding:8px 10px;font-size:12px;margin-bottom:8px;display:flex;gap:8px;align-items:flex-start;color:var(--text-primary)">
        <span style="font-size:16px;line-height:1">⚠️</span>
        <div>
          <strong>Not enough data yet (${closed} closed trade${closed !== 1 ? 's' : ''})</strong> — calibration signals are unreliable below 10 closed trades.
          Keep running analyses and marking trade outcomes; patterns will emerge naturally.
        </div>
      </div>` : ''}
      <p class="text-xs text-muted mb-1">
        Predicted confidence vs actual win rate per band. 95% CI shown — wide intervals mean small samples.
        ${calibActive ? 'Calibration notes are injected into Claude prompts.' : '<strong style="color:#d97706">Calibration paused — need 30+ closed trades.</strong>'}
        ${nVirtualResolved > 0 ? `<span style="margin-left:6px;font-size:10px;color:#0891b2;background:#ecfeff;border:1px solid #a5f3fc;border-radius:3px;padding:1px 5px"
          title="Skipped/unexecuted recs where OHLC scan confirmed target or stop was hit — included in calibration at 0.75× speed-weighted discount">~${nVirtualResolved} virtual outcomes included</span>` : ''}
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Confidence Band</th>
            <th style="text-align:right;padding:4px 8px">Trades</th>
            <th style="text-align:right;padding:4px 8px">Wins</th>
            <th style="text-align:right;padding:4px 8px">Win Rate</th>
            <th style="text-align:left;padding:4px 8px">95% CI</th>
            <th style="text-align:left;padding:4px 8px;width:100px">vs Expected</th>
          </tr>
        </thead>
        <tbody>
          ${confBands.length ? confBands.map(b => {
            const midpoint = parseFloat(b.band) + 5;  // e.g. "70-80%" → 75
            const delta = b.win_rate != null ? b.win_rate - midpoint : null;
            const deltaStr = delta != null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}pp` : '';
            const dimStyle = b.low_n ? 'opacity:0.65' : '';
            const ciStr = b.ci_lo != null
              ? `<span style="font-size:10px;color:${b.low_n ? '#d97706' : 'var(--text-muted)'}">${b.ci_lo.toFixed(0)}–${b.ci_hi.toFixed(0)}%${b.low_n ? ' ⚠' : ''}</span>`
              : '<span class="text-muted text-xs">—</span>';
            return `
            <tr style="border-bottom:1px solid var(--border);${dimStyle}">
              <td style="padding:5px 8px">${b.band}${sampleBadge(b.total)}</td>
              <td style="padding:5px 8px;text-align:right">${b.total}</td>
              <td style="padding:5px 8px;text-align:right">${b.wins}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(b.win_rate)}">${pct(b.win_rate)}</td>
              <td style="padding:5px 8px">${ciStr}</td>
              <td style="padding:5px 8px">
                <div style="display:flex;align-items:center;gap:6px">
                  <div style="background:var(--bg-secondary);border-radius:3px;height:8px;width:80px;flex-shrink:0">
                    <div style="background:${rateColor(b.win_rate)};border-radius:3px;height:8px;width:${b.win_rate != null ? Math.min(80, Math.round(b.win_rate * 0.8)) : 0}px"></div>
                  </div>
                  ${delta != null ? `<span style="font-size:10px;color:${delta < -5 ? '#dc2626' : delta > 5 ? '#16a34a' : 'var(--text-muted)'}">${deltaStr}</span>` : ''}
                </div>
              </td>
            </tr>`;
          }).join('') : '<tr><td colspan="6" style="padding:8px;color:var(--text-muted)">No closed events yet.</td></tr>'}
        </tbody>
      </table>
      ${brier && brier.bins && brier.bins.length > 0 ? `
      <div style="margin-top:12px">
        <div class="text-xs text-muted" style="margin-bottom:6px">Reliability diagram — bar = actual win rate, line = perfect calibration</div>
        <div style="display:flex;align-items:flex-end;gap:6px;height:80px;padding:4px 0">
          ${brier.bins.map(b => {
            const actual = Math.round(b.actual_win_rate * 100);
            const expected = Math.round(b.mean_confidence * 100);
            const barH = Math.round(actual * 0.7);  // scale to 70px max
            const color = actual >= expected ? '#16a34a' : '#ef4444';
            return `
            <div style="display:flex;flex-direction:column;align-items:center;flex:1;gap:2px">
              <span style="font-size:9px;color:var(--text-muted)">${actual}%</span>
              <div style="width:100%;background:${color}22;border-radius:3px 3px 0 0;position:relative;height:70px;display:flex;align-items:flex-end">
                <div style="width:100%;height:${barH}px;background:${color};border-radius:3px 3px 0 0;opacity:0.8"></div>
                <div style="position:absolute;bottom:${Math.round(expected*0.7)}px;left:0;right:0;border-top:2px dashed #6b7280;opacity:0.6"></div>
              </div>
              <span style="font-size:9px;color:var(--text-muted)">${b.range}</span>
              <span style="font-size:9px;color:var(--text-muted)">n=${b.n}</span>
            </div>`;
          }).join('')}
        </div>
        <div style="font-size:9px;color:var(--text-muted);margin-top:2px">Dashed line = predicted confidence · Bar = actual win rate</div>
      </div>` : ''}
    </div>
    <div id="ll-calib-trend-card" style="display:none"></div>
    <div id="ll-calib-efficacy-card" style="display:none"></div>`;

  // ── Regime performance ─────────────────────────────────────────────────────
  const regimeCard = `
    <div class="card">
      <div class="card-title">Performance by Regime</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Regime</th>
            <th style="text-align:right;padding:4px 8px">Trades</th>
            <th style="text-align:right;padding:4px 8px">Wins</th>
            <th style="text-align:right;padding:4px 8px">Win Rate</th>
            <th style="text-align:left;padding:4px 8px">95% CI</th>
          </tr>
        </thead>
        <tbody>
          ${regimes.length ? regimes.map(r => {
            const ciStr = r.ci_lo != null
              ? `<span style="font-size:10px;color:${r.low_n ? '#d97706' : 'var(--text-muted)'}">${r.ci_lo.toFixed(0)}–${r.ci_hi.toFixed(0)}%${r.low_n ? ' ⚠' : ''}</span>`
              : '<span class="text-muted text-xs">—</span>';
            return `
            <tr style="border-bottom:1px solid var(--border);${r.total < 5 ? 'opacity:0.65' : ''}">
              <td style="padding:5px 8px">${r.regime || 'unknown'}${sampleBadge(r.total)}</td>
              <td style="padding:5px 8px;text-align:right">${r.total}</td>
              <td style="padding:5px 8px;text-align:right">${r.wins}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(r.win_rate)}">${pct(r.win_rate)}</td>
              <td style="padding:5px 8px">${ciStr}</td>
            </tr>`;
          }).join('') : '<tr><td colspan="5" style="padding:8px;color:var(--text-muted)">No regime data yet.</td></tr>'}
        </tbody>
      </table>
    </div>`;

  // ── Prompt version history ─────────────────────────────────────────────────
  const versionsCard = `
    <div class="card">
      <div class="card-title">Prompt Version History</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Version</th>
            <th style="text-align:right;padding:4px 8px">Calls</th>
            <th style="text-align:right;padding:4px 8px">Closed</th>
            <th style="text-align:right;padding:4px 8px">Win Rate</th>
            <th style="text-align:right;padding:4px 8px" title="Win-rate delta vs previous version (needs ≥3 closed each)">&#916; vs prev</th>
            <th style="text-align:right;padding:4px 8px">Realised P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          ${versions.length ? versions.map((v, idx) => {
            const pnlCol = v.total_pnl == null ? 'var(--text-muted)' : v.total_pnl >= 0 ? '#16a34a' : '#dc2626';
            const pnlStr = v.total_pnl == null ? '—' : (v.total_pnl >= 0 ? '+' : '') + '$' + fmt(Math.abs(v.total_pnl));
            // Δ vs prev: compare to the entry at idx+1 (versions sorted newest-first)
            let deltaHtml = '<span style="color:var(--text-muted)">—</span>';
            const prev = versions[idx + 1];
            if (prev && v.closed >= 3 && prev.closed >= 3 && v.win_rate != null && prev.win_rate != null) {
              const delta = (v.win_rate - prev.win_rate) * 100;
              const deltaCol = delta > 2 ? '#16a34a' : delta < -2 ? '#dc2626' : '#d97706';
              const arrow    = delta > 2 ? '&#8593;' : delta < -2 ? '&#8595;' : '&#8596;';
              deltaHtml = `<span style="color:${deltaCol};font-weight:600">${arrow}${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp</span>`;
            }
            const isCurrent = typeof PROMPT_VERSION !== 'undefined' && v.version === PROMPT_VERSION;
            return `
            <tr style="border-bottom:1px solid var(--border)${isCurrent ? ';background:rgba(99,102,241,.07)' : ''}">
              <td style="padding:5px 8px;font-family:monospace;font-size:11px">
                ${v.version}${isCurrent ? ' <span style="background:#6366f1;color:#fff;border-radius:8px;padding:0 5px;font-size:9px;vertical-align:middle">current</span>' : ''}
              </td>
              <td style="padding:5px 8px;text-align:right">${v.total_calls}</td>
              <td style="padding:5px 8px;text-align:right">${v.closed}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(v.win_rate)}">${v.closed < 3 ? '<span title="Limited data" style="color:#d97706">—</span>' : pct(v.win_rate)}</td>
              <td style="padding:5px 8px;text-align:right">${deltaHtml}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${pnlCol}">${pnlStr}</td>
            </tr>`;}).join('') : '<tr><td colspan="6" style="padding:8px;color:var(--text-muted)">No prompt version data yet.</td></tr>'}
        </tbody>
      </table>
    </div>`;

  // ── Failure patterns ───────────────────────────────────────────────────────
  const errorTypeLabels = {
    overconfident:   { label: 'Overconfident',    color: '#dc2626' },
    missed_catalyst: { label: 'Missed catalyst',  color: '#d97706' },
    regime_mismatch: { label: 'Regime mismatch',  color: '#7c3aed' },
    poor_entry:      { label: 'Poor entry',       color: '#ea580c' },
    stop_too_tight:  { label: 'Stop too tight',   color: '#0891b2' },
    poor_rr:         { label: 'Poor R:R',         color: '#6b7280' },
    external_shock:  { label: 'External shock',   color: '#be185d' },
    thesis_broken:   { label: 'Thesis broken',    color: '#92400e' },
  };
  const exitReasons   = Object.entries(failPats.by_exit_reason  || {});
  const errorTypes    = Object.entries(failPats.by_error_type   || {});
  const failureCard = (exitReasons.length || errorTypes.length) ? `
    <div class="card section-gap">
      <div class="card-title">Failure Patterns</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <div class="text-xs text-muted" style="margin-bottom:6px;font-weight:600">Exit reason distribution</div>
          ${exitReasons.length ? exitReasons.map(([reason, cnt]) => `
            <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12px;border-bottom:1px solid var(--border)">
              <span>${reason.replace(/_/g,' ')}</span>
              <span style="font-weight:600;color:var(--text-secondary)">${cnt}</span>
            </div>`).join('') : '<span class="text-xs text-muted">None yet</span>'}
        </div>
        <div>
          <div class="text-xs text-muted" style="margin-bottom:6px;font-weight:600">Error type tags (manual)</div>
          ${errorTypes.length ? errorTypes.map(([type, cnt]) => {
            const meta = errorTypeLabels[type] || { label: type, color: '#6b7280' };
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px;border-bottom:1px solid var(--border)">
              <span style="color:${meta.color}">${meta.label}</span>
              <span style="font-weight:600;color:var(--text-secondary)">${cnt}</span>
            </div>`;
          }).join('') : '<span class="text-xs text-muted">No tags yet — tag recent events below</span>'}
        </div>
      </div>
    </div>` : '';

  // ── Success patterns ───────────────────────────────────────────────────────
  // Two tag sources feed success_tags: the deterministic auto-tagger
  // (_classify_success_tags_deterministic, routes/learning.py) emits
  // regime_aligned/disciplined_hold/clean_path/thesis_confirmed/strong_process
  // automatically on every closed win; the manual 🔬 skill-score button can
  // additionally apply any of VALID_WIN_TAGS (routes/debate.py) — a wider,
  // more qualitative set (catalyst_capture, confluence_entry, good_sizing,
  // fundamental_value_entry, earnings_revision_driven, macro_tailwind_aligned,
  // contrarian_mean_reversion) that isn't technically derivable from captured
  // data alone. WIN_TAG_META must cover BOTH sets — the 3 deterministic-only
  // tags (clean_path, thesis_confirmed, strong_process) were previously absent
  // here and rendered as unstyled fallback text everywhere a real win carried them.
  const WIN_TAG_META = {
    // Deterministic (auto-tagged on every closed win, routes/learning.py)
    regime_aligned:            { label: 'Regime Aligned',         color: '#8b5cf6', tip: 'Won in a pro-risk regime (riskOn/trend) and hit target — not a lucky exit' },
    disciplined_hold:          { label: 'Disciplined Hold',       color: '#059669', tip: 'Held ≥5 days and reached target — no premature exit' },
    clean_path:                { label: 'Clean Path',             color: '#0d9488', tip: 'Shallow drawdown relative to peak gain (MAE < 30% of MFE) — a confident, low-stress win' },
    thesis_confirmed:          { label: 'Thesis Confirmed',       color: '#2563eb', tip: 'Entry thesis was validated or partially validated by the outcome' },
    strong_process:            { label: 'Strong Process',         color: '#ca8a04', tip: 'Skill score ≥7 — good analysis, not just a favourable outcome' },
    // Manual / LLM only (🔬 skill-score button, VALID_WIN_TAGS in routes/debate.py)
    catalyst_capture:          { label: 'Catalyst Capture',       color: '#3b82f6', tip: 'Trade captured a planned earnings/news/dividend event' },
    confluence_entry:          { label: 'Confluence Entry',       color: '#0891b2', tip: 'Multiple independent technical indicators aligned at entry' },
    good_sizing:               { label: 'Good Sizing',            color: '#d97706', tip: 'Position size was well-calibrated for conviction and risk' },
    fundamental_value_entry:   { label: 'Value Entry',            color: '#16a34a', tip: 'Entered at cheap valuation — fwdPE/PB below sector; strong FCF yield' },
    earnings_revision_driven:  { label: 'Earnings Revision',      color: '#0369a1', tip: 'Win driven by beat/miss trend or analyst upgrade momentum' },
    macro_tailwind_aligned:    { label: 'Macro Tailwind',         color: '#7c3aed', tip: 'Commodity, rate, or AUD/USD move directly supported the sector thesis' },
    contrarian_mean_reversion: { label: 'Contrarian Reversion',   color: '#be185d', tip: 'Oversold quality stock recovered as expected — value + patience' },
  };
  const successTypes = Object.entries(successPats.by_success_type || {})
    .sort((a, b) => b[1] - a[1]);
  // Disciplined-hold duration + payoff (backend success_patterns.disciplined_hold_stats).
  // How long the wins tagged "Disciplined Hold" (held ≥5d to target) actually ran,
  // and what they paid. min/max suppressed below n=3 (small-sample noise).
  const _dh = successPats.disciplined_hold_stats;
  const disciplinedHoldRow = _dh ? `
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <span title="Held through normal volatility; original thesis validated" style="font-size:11px;padding:1px 6px;border-radius:3px;font-weight:600;background:#05966922;color:#059669;white-space:nowrap">Disciplined Hold</span>
          <span class="text-xs text-muted">how long they ran &amp; what they paid · n=${_dh.n}</span>
        </div>
        <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px">
          <div><span class="text-xs text-muted">Holding period</span><br>
            <span style="font-weight:600">${_dh.days_min != null ? `${_dh.days_min}` : '—'}<span class="text-xs text-muted"> min</span> · ${_dh.days_avg}<span class="text-xs text-muted"> avg</span> · ${_dh.days_max != null ? `${_dh.days_max}` : '—'}<span class="text-xs text-muted"> max days</span></span>
          </div>
          <div><span class="text-xs text-muted">Avg return</span><br>
            <span style="font-weight:600;color:${(_dh.ret_avg ?? 0) >= 0 ? '#16a34a' : '#dc2626'}">${_dh.ret_avg != null ? `${_dh.ret_avg > 0 ? '+' : ''}${_dh.ret_avg}%` : '—'}</span>
          </div>
        </div>
        ${_dh.n < 3 ? `<div class="text-xs text-muted" style="margin-top:4px">min/max hidden below n=3 (too few to be meaningful) — showing average only.</div>` : ''}
      </div>` : '';
  const successCard = successTypes.length ? `
    <div class="card section-gap">
      <div class="card-title">Success Patterns</div>
      <p class="text-xs text-muted" style="margin-bottom:10px">
        What's working — success tags on closed wins (🏆 button). Dominant tags are emitted as positive calibration nudges.
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <div class="text-xs text-muted" style="margin-bottom:6px;font-weight:600">Success type tags</div>
          ${successTypes.map(([tag, cnt]) => {
            const meta = WIN_TAG_META[tag] || { label: tag, color: '#16a34a', tip: tag };
            const barW = Math.round((cnt / successTypes[0][1]) * 100);
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)">
              <div style="display:flex;align-items:center;gap:6px">
                <span title="${meta.tip}" style="font-size:11px;padding:1px 6px;border-radius:3px;font-weight:600;background:${meta.color}22;color:${meta.color};white-space:nowrap">${meta.label}</span>
                <div style="background:var(--bg-secondary);border-radius:2px;height:6px;width:60px">
                  <div style="background:${meta.color};border-radius:2px;height:6px;width:${barW * 0.6}px"></div>
                </div>
              </div>
              <span style="font-weight:600;color:var(--text-secondary);font-size:12px">${cnt}</span>
            </div>`;
          }).join('')}
        </div>
        <div>
          <div class="text-xs text-muted" style="margin-bottom:6px;font-weight:600">Calibration nudge rule</div>
          <p class="text-xs text-muted">When ≥33% of recent wins share a tag (ESS≥2.5), a positive nudge is injected into Claude's calibration block:</p>
          <div style="margin-top:8px;padding:6px 8px;background:var(--bg-secondary);border-radius:4px;font-family:monospace;font-size:11px;color:#16a34a">
            ✓confluence_entry(5/12wins,ESS=4.1)→lean into this
          </div>
          <p class="text-xs text-muted" style="margin-top:6px">Tag wins using the 🏆 button on individual rows below.</p>
        </div>
      </div>
      ${disciplinedHoldRow}
    </div>` : '';

  // ── Deepening stat cards ───────────────────────────────────────────────────
  const buyVsTopup       = d.buy_vs_topup       || {};
  const capitalEff       = d.capital_efficiency  || [];
  const ensDiv           = d.ensemble_divergence || {};
  const maeMfe           = d.mae_mfe_summary     || {};

  // ── BUY vs TOP_UP performance split ───────────────────────────────────────
  const buyRow   = buyVsTopup['BUY']    || {};
  const topupRow = buyVsTopup['TOP_UP'] || {};
  const buyVsTopupCard = (buyRow.n || topupRow.n) ? `
    <div class="card section-gap">
      <div class="card-title">BUY vs TOP_UP Performance</div>
      <p class="text-xs text-muted" style="margin-bottom:8px">Initial entries vs position additions — divergence reveals whether adding to winners/losers pays off.</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Action</th>
            <th style="text-align:right;padding:4px 8px">Trades</th>
            <th style="text-align:right;padding:4px 8px">Win Rate</th>
            <th style="text-align:right;padding:4px 8px">Avg P&amp;L%</th>
            <th style="text-align:right;padding:4px 8px">Avg Hold</th>
          </tr>
        </thead>
        <tbody>
          ${['BUY','TOP_UP'].map(action => {
            const r = buyVsTopup[action];
            if (!r || !r.n) return `<tr><td colspan="5" style="padding:5px 8px;color:var(--text-muted)">${action}: no data</td></tr>`;
            const pnlColor = r.avg_pnl == null ? 'var(--text-secondary)' : r.avg_pnl >= 0 ? '#16a34a' : '#dc2626';
            return `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 8px;font-weight:600">${action}</td>
              <td style="padding:5px 8px;text-align:right">${r.n}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(r.win_rate)}">${pct(r.win_rate)}</td>
              <td style="padding:5px 8px;text-align:right;color:${pnlColor}">${r.avg_pnl != null ? (r.avg_pnl >= 0 ? '+' : '') + r.avg_pnl.toFixed(1) + '%' : '—'}</td>
              <td style="padding:5px 8px;text-align:right;color:var(--text-secondary)">${r.avg_hold != null ? r.avg_hold.toFixed(0) + 'd' : '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : '';

  // ── REAL vs PAPER performance split (gotcha #88) ──────────────────────────
  // Does paper performance predict real performance? Only rendered once BOTH
  // buckets have data — a pure-paper (or pure-real) book has nothing to compare.
  const realVsPaper = d.real_vs_paper || {};
  const rvpReal  = realVsPaper['real']  || {};
  const rvpPaper = realVsPaper['paper'] || {};
  const realVsPaperCard = (rvpReal.n && rvpPaper.n) ? `
    <div class="card section-gap">
      <div class="card-title">Live vs Paper Performance</div>
      <p class="text-xs text-muted" style="margin-bottom:8px">Whether simulated (paper) results actually predict live results — a persistent gap suggests execution slippage, sizing nerves, or paper over-optimism.</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Mode</th>
            <th style="text-align:right;padding:4px 8px">Trades</th>
            <th style="text-align:right;padding:4px 8px">Win Rate</th>
            <th style="text-align:right;padding:4px 8px">Avg P&amp;L%</th>
            <th style="text-align:right;padding:4px 8px">Avg Hold</th>
          </tr>
        </thead>
        <tbody>
          ${[['real','● Live'],['paper','◦ Paper']].map(([key,label]) => {
            const r = realVsPaper[key];
            if (!r || !r.n) return `<tr><td colspan="5" style="padding:5px 8px;color:var(--text-muted)">${label}: no data</td></tr>`;
            const pnlColor = r.avg_pnl == null ? 'var(--text-secondary)' : r.avg_pnl >= 0 ? '#16a34a' : '#dc2626';
            return `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 8px;font-weight:600">${label}${sampleBadge(r.n)}</td>
              <td style="padding:5px 8px;text-align:right">${r.n}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(r.win_rate)}">${pct(r.win_rate)}</td>
              <td style="padding:5px 8px;text-align:right;color:${pnlColor}">${r.avg_pnl != null ? (r.avg_pnl >= 0 ? '+' : '') + r.avg_pnl.toFixed(1) + '%' : '—'}</td>
              <td style="padding:5px 8px;text-align:right;color:var(--text-secondary)">${r.avg_hold != null ? r.avg_hold.toFixed(0) + 'd' : '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${(rvpReal.win_rate != null && rvpPaper.win_rate != null && Math.abs(rvpReal.win_rate - rvpPaper.win_rate) >= 15 && rvpReal.n >= 5 && rvpPaper.n >= 5)
        ? `<p class="text-xs" style="margin-top:6px;color:#c2410c">⚠ ${Math.abs(rvpReal.win_rate - rvpPaper.win_rate).toFixed(0)}pp win-rate gap between live and paper — treat paper-derived confidence with caution.</p>`
        : ''}
    </div>` : '';

  // ── Per-model track record (Model-Aware Calibration Part B, Step 3) ──────────
  // Purely descriptive — no nudge derives from this. The calibration block and
  // go-live scorecard still blend every model's closed trades into one number
  // (the go-live 🎯 card only flags a mixed sample, see model_mix); this table
  // is what lets you SEE whether models actually differ before trusting any
  // future model-segmented split. Sorted by n desc server-side (routes/learning.py).
  const byModelEntries = Object.entries(byModel);
  const byModelCard = byModelEntries.length ? `
    <div class="card section-gap">
      <div class="card-title">Performance by Model</div>
      <p class="text-xs text-muted" style="margin-bottom:8px">Per-LLM track record — descriptive only, calibration still blends all models into one figure. A row spanning &gt;1 model is what the Go-Live 🎯 card's mixed-sample note is warning you about.</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Model</th>
            <th style="text-align:right;padding:4px 8px">Trades</th>
            <th style="text-align:right;padding:4px 8px">Win Rate</th>
            <th style="text-align:left;padding:4px 8px">95% CI</th>
            <th style="text-align:right;padding:4px 8px">Avg P&amp;L%</th>
            <th style="text-align:right;padding:4px 8px">Avg Hold</th>
          </tr>
        </thead>
        <tbody>
          ${byModelEntries.map(([name, r]) => {
            const pnlColor = r.avg_pnl == null ? 'var(--text-secondary)' : r.avg_pnl >= 0 ? '#16a34a' : '#dc2626';
            const ciStr = r.ci_lo != null
              ? `<span style="font-size:10px;color:${r.low_n ? '#d97706' : 'var(--text-muted)'}">${r.ci_lo.toFixed(0)}–${r.ci_hi.toFixed(0)}%${r.low_n ? ' ⚠' : ''}</span>`
              : '<span class="text-muted text-xs">—</span>';
            return `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 8px;font-family:monospace;font-size:11px">${escapeHTML(name)}${sampleBadge(r.n)}</td>
              <td style="padding:5px 8px;text-align:right">${r.n}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(r.win_rate)}">${pct(r.win_rate)}</td>
              <td style="padding:5px 8px">${ciStr}</td>
              <td style="padding:5px 8px;text-align:right;color:${pnlColor}">${r.avg_pnl != null ? (r.avg_pnl >= 0 ? '+' : '') + r.avg_pnl.toFixed(1) + '%' : '—'}</td>
              <td style="padding:5px 8px;text-align:right;color:var(--text-secondary)">${r.avg_hold != null ? r.avg_hold.toFixed(0) + 'd' : '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${byModelEntries.length > 1 ? `<p class="text-xs text-muted" style="margin-top:6px">Model captured per rec since 2026-07-17; older rows may show as <code>unknown/legacy</code> until <code>POST /api/learning/backfill-models</code> is run.</p>` : ''}
    </div>` : '';

  // ── Capital efficiency by entry driver ─────────────────────────────────────
  const capitalEffCard = capitalEff.length ? `
    <div class="card section-gap">
      <div class="card-title">Capital Efficiency by Entry Driver</div>
      <p class="text-xs text-muted" style="margin-bottom:8px">Daily P&amp;L rate (realized % ÷ hold days) — shows which setups return the most per day of capital deployed.</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Entry Driver</th>
            <th style="text-align:right;padding:4px 8px">n</th>
            <th style="text-align:right;padding:4px 8px">P&amp;L/day</th>
            <th style="text-align:right;padding:4px 8px">Avg P&amp;L%</th>
            <th style="text-align:right;padding:4px 8px">Avg Hold</th>
          </tr>
        </thead>
        <tbody>
          ${capitalEff.map(r => {
            const ppdColor = r.avg_pnl_per_day == null ? 'var(--text-secondary)' : r.avg_pnl_per_day >= 0 ? '#16a34a' : '#dc2626';
            const pnlColor = r.avg_pnl == null ? 'var(--text-secondary)' : r.avg_pnl >= 0 ? '#16a34a' : '#dc2626';
            return `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 8px">${r.driver.replace(/_/g,' ')}${sampleBadge(r.n)}</td>
              <td style="padding:5px 8px;text-align:right">${r.n}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${ppdColor}">${r.avg_pnl_per_day != null ? (r.avg_pnl_per_day >= 0 ? '+' : '') + r.avg_pnl_per_day.toFixed(3) + '%' : '—'}</td>
              <td style="padding:5px 8px;text-align:right;color:${pnlColor}">${r.avg_pnl != null ? (r.avg_pnl >= 0 ? '+' : '') + r.avg_pnl.toFixed(1) + '%' : '—'}</td>
              <td style="padding:5px 8px;text-align:right;color:var(--text-secondary)">${r.avg_hold != null ? r.avg_hold.toFixed(0) + 'd' : '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : '';

  // ── Ensemble divergence cross-tab ──────────────────────────────────────────
  const ensDivAligned  = ensDiv['aligned']  || {};
  const ensDivDiverged = ensDiv['diverged'] || {};
  const ensembleDivCard = (ensDivAligned.n || ensDivDiverged.n) ? `
    <div class="card section-gap">
      <div class="card-title">Ensemble vs AI Confidence Divergence</div>
      <p class="text-xs text-muted" style="margin-bottom:8px">When the indicator-composite score and Claude's stated confidence diverge by &gt;10pp — does alignment predict better outcomes?</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Group</th>
            <th style="text-align:right;padding:4px 8px">Trades</th>
            <th style="text-align:right;padding:4px 8px">Win Rate</th>
          </tr>
        </thead>
        <tbody>
          ${['aligned','diverged'].map(group => {
            const r = ensDiv[group];
            if (!r || !r.n) return `<tr><td colspan="3" style="padding:5px 8px;color:var(--text-muted)">${group}: no data</td></tr>`;
            return `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 8px;font-weight:600">${group === 'aligned' ? '✓ Aligned (≤10pp gap)' : '⚠ Diverged (>10pp gap)'}</td>
              <td style="padding:5px 8px;text-align:right">${r.n}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(r.win_rate)}">${pct(r.win_rate)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <p class="text-xs text-muted" style="margin-top:6px">If aligned win rate is consistently higher, size down when ensemble and AI confidence diverge significantly.</p>
    </div>` : '';

  // ── MAE/MFE path quality summary ───────────────────────────────────────────
  const maeMfeCard = (maeMfe.n_wins > 0 || maeMfe.n_losses > 0) ? `
    <div class="card section-gap">
      <div class="card-title">MAE / MFE Path Quality</div>
      <p class="text-xs text-muted" style="margin-bottom:8px">
        Maximum Adverse Excursion (worst drawdown before exit) and Maximum Favourable Excursion (best unrealised gain).
        Winners and losers compared — reveals stop placement and profit-capture patterns.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Outcome</th>
            <th style="text-align:right;padding:4px 8px">n</th>
            <th style="text-align:right;padding:4px 8px" title="Average worst intraday drawdown from entry">Avg MAE%</th>
            <th style="text-align:right;padding:4px 8px" title="Average best unrealised gain before exit">Avg MFE%</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:5px 8px;font-weight:600;color:#16a34a">Wins</td>
            <td style="padding:5px 8px;text-align:right">${maeMfe.n_wins}</td>
            <td style="padding:5px 8px;text-align:right;color:#d97706">${maeMfe.avg_mae_wins != null ? maeMfe.avg_mae_wins.toFixed(2) + '%' : '—'}</td>
            <td style="padding:5px 8px;text-align:right;color:#16a34a">${maeMfe.avg_mfe_wins != null ? '+' + maeMfe.avg_mfe_wins.toFixed(2) + '%' : '—'}</td>
          </tr>
          <tr>
            <td style="padding:5px 8px;font-weight:600;color:#dc2626">Losses</td>
            <td style="padding:5px 8px;text-align:right">${maeMfe.n_losses}</td>
            <td style="padding:5px 8px;text-align:right;color:#dc2626">${maeMfe.avg_mae_losses != null ? maeMfe.avg_mae_losses.toFixed(2) + '%' : '—'}</td>
            <td style="padding:5px 8px;text-align:right;color:#d97706">${maeMfe.avg_mfe_losses != null ? '+' + maeMfe.avg_mfe_losses.toFixed(2) + '%' : '—'}</td>
          </tr>
        </tbody>
      </table>
      ${maeMfe.avg_mae_wins != null && maeMfe.avg_mae_losses != null ? `
      <div style="margin-top:8px;padding:6px 10px;background:var(--bg-secondary);border-radius:4px;font-size:11px;color:var(--text-secondary)">
        ${Math.abs(maeMfe.avg_mae_wins) < Math.abs(maeMfe.avg_mae_losses || 0)
          ? '✓ Winners have shallower adverse excursion than losers — stop placement is reasonable.'
          : '⚠ Winners dig as deep as losers before recovering — stops may be too tight or entries poorly timed.'}
      </div>` : ''}
    </div>` : '';

  // ── Recent events ──────────────────────────────────────────────────────────
  const outcomeChip = o => {
    const map = { win:'#16a34a', loss:'#dc2626', breakeven:'#9ca3af', open:'#3b82f6', expired:'#6b7280', invalidated:'#d97706', skipped:'#6b7280' };
    const col = map[o] || '#9ca3af';
    return `<span style="background:${col}20;color:${col};border-radius:3px;padding:1px 6px;font-size:10px;font-weight:600">${o || 'open'}</span>`;
  };
  // Tag buttons / tag cell — hoisted to module scope as _llTagButtons()/_llTagCell()
  // (and _LL_TAG_STATUSES) so tagLearningEvent() can patch a single row's tag
  // cell after a tag click without a full page re-render. Kept as local aliases
  // here so the rest of this function doesn't need renaming.
  const TAG_STATUSES = _LL_TAG_STATUSES;
  const tagCell      = _llTagCell;

  const _winEvents = events.filter(e => e.outcome_status === 'win');
  const _winTagged = _winEvents.filter(e => (e.success_tags || '') !== '').length;
  const recentCard = `
    <div class="card section-gap">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:8px">
        <div class="card-title" style="margin:0">Recent Events (${events.length})</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${_winEvents.length ? `<span class="text-xs" title="Winning trades with a success tag (a pattern or a classified '✓ no pattern'). 🏆 gold = tagged, hollow = untagged.">🏆 Wins tagged: <strong>${_winTagged}/${_winEvents.length}</strong></span>
          <select onchange="_llFilterWinTags(this.value)" title="Filter rows by win tag-status"
            style="font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-secondary)">
            <option value="all">Wins: all</option>
            <option value="tagged">Wins: tagged only</option>
            <option value="untagged">Wins: untagged only</option>
          </select>` : ''}
          <span class="text-xs text-muted">Tag failures on closed trades · ✕ removes outliers from calibration</span>
          <button class="btn btn-sm" id="classify-all-btn"
            onclick="classifyAllPostmortems()"
            title="Run postmortem on every untagged loss/breakeven event using the current local model"
            style="white-space:nowrap">🤖 Classify All Untagged</button>
        </div>
      </div>
      <div style="margin-bottom:8px">${_llEventsLimitBar()}</div>
      <div id="classify-all-progress" style="display:none;margin-bottom:8px;padding:8px 10px;background:var(--bg-secondary);border-radius:5px;font-size:12px"></div>
      ${events.length ? `
        <div style="overflow:auto;max-height:640px">
          <table class="tbl-stack" style="width:100%;border-collapse:collapse;font-size:12px;min-width:620px">
            <thead>
              <tr style="color:var(--text-muted);border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg-primary);z-index:1">
                <th style="text-align:left;padding:4px 6px">Date</th>
                <th style="text-align:left;padding:4px 6px">Ticker</th>
                <th style="text-align:left;padding:4px 6px">Action</th>
                <th style="text-align:right;padding:4px 6px">Conf</th>
                <th style="text-align:left;padding:4px 6px">Regime</th>
                <th style="text-align:left;padding:4px 6px">Outcome</th>
                <th style="text-align:right;padding:4px 6px">P&amp;L%</th>
                <th style="text-align:left;padding:4px 6px" title="Loss/Breakeven only · OC=Overconfident · MC=Missed catalyst · RM=Regime mismatch · PE=Poor entry · ST=Stop too tight · PR=Poor R:R · ES=External shock · TB=Thesis broken · Multiple tags allowed — click to toggle, 🔍 = auto-tagged">Error tags ℹ</th>
                <th style="text-align:left;padding:4px 6px" title="Claude's generation-time tags — entry driver for BUY/TOP_UP; exit driver + urgency for SELL/TRIM; win pattern tags for wins">Claude ℹ</th>
                <th style="padding:4px 6px" title="Skill score (0–10): analysis quality vs luck. Sk = trigger Ollama scoring">
                  <div style="display:inline-flex;align-items:center;gap:2px">
                    <span style="width:28px;flex-shrink:0"></span>
                    <span style="width:26px;text-align:center">🔬 Sk</span>
                  </div>
                </th>
                <th style="padding:4px 6px"></th>
              </tr>
            </thead>
            <tbody>
              ${events.map(ev => {
                const pnlPct  = ev.realized_pnl_pct;
                const pnlStr  = pnlPct != null ? (pnlPct >= 0 ? '+' : '') + Number(pnlPct).toFixed(1) + '%' : '—';
                const pnlColor = pnlPct > 0 ? '#16a34a' : pnlPct < 0 ? '#dc2626' : 'var(--text-secondary)';
                const isOpen   = !ev.outcome_status || ev.outcome_status === 'open';
                const isClosed = new Set(['win','loss','breakeven']).has(ev.outcome_status);
                // 🛡 Protective stop — show badge if already marked, offer button for stop_hit losses
                const isProtective = ev.exit_reason === 'protective_stop';
                const protectiveEl = isProtective
                  ? `<span title="Protective stop — excluded from confidence calibration (market accident, not model error)"
                       style="font-size:10px;color:#15803d;margin-left:3px;cursor:default">🛡<span style="font-size:8px;vertical-align:middle;margin-left:1px">P</span></span>`
                  : (ev.exit_reason === 'stop_hit' && TAG_STATUSES.has(ev.outcome_status))
                    ? `<button onclick="markProtectiveStop(${ev.id})"
                         title="Mark as protective stop — this loss was deliberate capital protection during a market shock, not a model error. Excluded from calibration."
                         style="background:none;border:none;cursor:pointer;font-size:11px;padding:0 2px;color:var(--text-muted);line-height:1"
                         onmouseover="this.style.color='#15803d'" onmouseout="this.style.color='var(--text-muted)'"
                       >🛡<span style="font-size:8px;vertical-align:middle">?</span></button>`
                    : '';
                // 🏆 success tags — wins carry an explicit tag-status so you can tell
                // at a glance which winners are already classified:
                //   'pattern'  → success_tags chips (a standout pattern was found)
                //   'none'     → muted "✓ no pattern" chip (classified, nothing notable)
                //   'untagged' → no chip + hollow 🏆 button (not yet classified)
                // 'none' and NULL used to render identically (both blank), so a
                // classified-but-unremarkable win looked the same as one never tagged.
                const successTags = (ev.success_tags || '').split(',').map(t=>t.trim()).filter(Boolean);
                const WIN_TAG_COLORS = {
                  catalyst_capture: '#3b82f6', regime_aligned: '#8b5cf6',
                  confluence_entry: '#0891b2', disciplined_hold: '#059669',
                  good_sizing: '#d97706', none: '#6b7280',
                  // Deterministic-only tags (see WIN_TAG_META above)
                  clean_path: '#0d9488', thesis_confirmed: '#2563eb', strong_process: '#ca8a04',
                };
                const winTagState = ev.outcome_status !== 'win' ? 'na'
                  : (successTags.length && successTags[0] !== 'none') ? 'pattern'
                  : (ev.success_tags === 'none') ? 'none'
                  : 'untagged';
                const successTagsEl = winTagState === 'pattern'
                  ? successTags.map(t => `<span title="${t}" style="font-size:9px;padding:1px 4px;border-radius:3px;font-weight:600;background:${(WIN_TAG_COLORS[t]||'#3b82f6')}22;color:${WIN_TAG_COLORS[t]||'#3b82f6'};margin-right:2px">${t.replace(/_/g,' ')}</span>`).join('')
                  : winTagState === 'none'
                    ? `<span title="Classified — no standout success pattern found" style="font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;background:#6b728022;color:#6b7280">✓ no pattern</span>`
                    : '';

                // 🔍 post-mortem — always show for loss/breakeven so re-runs are possible.
                // Relabelled "Scrutinize" (current session) — same error_type tagging
                // endpoint/pipeline as before, just enriched with macro context
                // (_flatten_market_context) alongside the existing technical signals.
                const showPm = TAG_STATUSES.has(ev.outcome_status);
                const pmTitle = ev.error_type
                  ? 'Re-run scrutiny (will overwrite existing tag)'
                  : 'Scrutinize with local model — technical + macro context';
                // 🔬 skill score — badge (if scored) + button always shown for closed trades
                const skillScore = ev.skill_score;
                const skillBadgeContent = skillScore != null
                  ? `<span id="skill-badge-${ev.id}"
                       title="Skill score: ${skillScore}/10"
                       style="font-size:10px;padding:1px 5px;border-radius:3px;font-weight:600;white-space:nowrap;
                              background:${skillScore>=7?'#dcfce7':skillScore>=4?'#fef3c7':'#fee2e2'};
                              color:${skillScore>=7?'#15803d':skillScore>=4?'#92400e':'#991b1b'}"
                     >${skillScore.toFixed(1)}</span>`
                  : `<span id="skill-badge-${ev.id}"></span>`;

                // Fix #18: virtual outcome chip — shows for unexecuted rows with resolved OHLC outcome
                // Tooltip shows the effective calibration weight = 0.75 × speed_weight
                // (speed_weight = min(1.0, 7/bars_to_resolution): fast hits closer to 1.0)
                // Scoped to virtual_win/virtual_loss only (BUY/SELL/TRIM skipped-rec outcomes from
                // _resolve_virtual_outcomes). HOLD's virtual_hold_miss/virtual_hold_correct (from the
                // separate _resolve_hold_outcomes) get their own chip below in claudeTagsEl — they used
                // to fall through this same ternary, which only tests `=== 'virtual_win'`, so BOTH
                // hold outcomes rendered as an identical red "~L / stop hit" chip — backwards for
                // virtual_hold_correct (the GOOD outcome) and nonsensical either way (a HOLD has no stop).
                const _virtEffectiveWt = ev.virtual_speed_weight
                  ? (0.75 * ev.virtual_speed_weight).toFixed(2) : '0.75';
                const _isTradeVirtual = ev.virtual_outcome === 'virtual_win' || ev.virtual_outcome === 'virtual_loss';
                const virtualChip = (!ev.was_executed && _isTradeVirtual)
                  ? `<span title="Virtual outcome (skipped rec): OHLC scan found ${ev.virtual_outcome === 'virtual_win' ? 'target hit' : 'stop hit'} — included at ${_virtEffectiveWt}× weight in calibration (speed factor: ${ev.virtual_speed_weight ?? '1.0'}${ev.virtual_slippage_applied != null ? `; slippage ${(ev.virtual_slippage_applied * 100).toFixed(2)}% applied` : ''})"
                       style="font-size:9px;padding:1px 4px;border-radius:3px;font-weight:600;margin-left:3px;cursor:default;
                              background:${ev.virtual_outcome === 'virtual_win' ? '#f0fdf4' : '#fef2f2'};
                              color:${ev.virtual_outcome === 'virtual_win' ? '#15803d' : '#dc2626'};
                              border:1px solid ${ev.virtual_outcome === 'virtual_win' ? '#86efac' : '#fca5a5'}"
                     >~${ev.virtual_outcome === 'virtual_win' ? 'W' : 'L'}</span>`
                  : '';

                // ── Claude's generation-time tags ─────────────────────────────────────
                // For SELL/TRIM: sell_primary_driver + sell_urgency chips (logged at rec generation).
                // For wins:      success_tags chips (tagged by Ollama skill scorer).
                // For others:    em-dash placeholder.
                const isExitRec = ['SELL','TRIM'].includes((ev.recommendation||'').toUpperCase());
                const EXIT_DRIVER_META = {
                  thesis_broken:      { label: 'thes broken',  color: '#dc2626' },
                  stop_triggered:     { label: 'stop hit',     color: '#ea580c' },
                  target_reached:     { label: 'target hit',   color: '#16a34a' },
                  time_stop:          { label: 'time stop',    color: '#ca8a04' },
                  risk_management:    { label: 'risk mgmt',    color: '#7c3aed' },
                  better_opportunity: { label: 'better opp',   color: '#0891b2' },
                  position_sizing:    { label: 'pos sizing',   color: '#6366f1' },
                  tax_optimisation:   { label: 'tax optim',    color: '#059669' },
                  regime_change:      { label: 'regime chg',   color: '#d97706' },
                };
                const ENTRY_DRIVER_META = {
                  mean_reversion:     { label: 'mean rev',     color: '#3b82f6' },
                  momentum_breakout:  { label: 'breakout',     color: '#f97316' },
                  trend_pullback:     { label: 'trend pull',   color: '#16a34a' },
                  fundamental_value:  { label: 'fundamental',  color: '#7c3aed' },
                  macro_tailwind:     { label: 'macro',        color: '#0891b2' },
                };
                const URG_META = {
                  immediate: { label: 'immediate', color: '#dc2626' },
                  monitor:   { label: 'monitor',   color: '#ca8a04' },
                  routine:   { label: 'routine',   color: '#6b7280' },
                };
                const _chip = (key, label, color, title) =>
                  `<span title="${title}: ${key}"
                         style="font-size:9px;padding:1px 5px;border-radius:2px;font-weight:600;white-space:nowrap;
                                background:${color}20;color:${color};border:1px solid ${color}66"
                   >${label}</span>`;
                const claudeTagsEl = (() => {
                  // SELL/TRIM: exit driver + urgency
                  if (isExitRec && ev.sell_primary_driver) {
                    const dm = EXIT_DRIVER_META[ev.sell_primary_driver]
                      || { label: ev.sell_primary_driver.replace(/_/g,' '), color: '#6b7280' };
                    const um = ev.sell_urgency
                      ? (URG_META[ev.sell_urgency] || { label: ev.sell_urgency, color: '#6b7280' })
                      : null;
                    return `<div style="display:flex;gap:2px;flex-wrap:wrap;align-items:center">
                      ${_chip(ev.sell_primary_driver, dm.label, dm.color, 'Exit driver')}
                      ${um ? `<span title="Urgency: ${ev.sell_urgency}"
                              style="font-size:9px;padding:1px 5px;border-radius:2px;font-weight:500;white-space:nowrap;
                                     color:${um.color};border:1px solid ${um.color}55"
                            >${um.label}</span>` : ''}
                    </div>`;
                  }
                  // Wins: success tags take priority over entry driver chip for closed
                  // winners (most informative once Ollama has tagged the trade).
                  // Open wins (successTagsEl is '' = falsy) fall through to entry driver.
                  if (ev.outcome_status === 'win' && successTagsEl) return successTagsEl;
                  // BUY/TOP_UP: entry driver (open wins and losses/breakevens land here)
                  if (!isExitRec && ev.primary_entry_driver) {
                    const dm = ENTRY_DRIVER_META[ev.primary_entry_driver]
                      || { label: ev.primary_entry_driver.replace(/_/g,' '), color: '#6b7280' };
                    return _chip(ev.primary_entry_driver, dm.label, dm.color, 'Entry driver');
                  }
                  // HOLD: _resolve_hold_outcomes() (routes/learning.py) only judges a HOLD once it's
                  // ≥30 days old (needs runway to tell whether a real move was missed), so most HOLDs
                  // sit at virtual_outcome=NULL for a while — show a countdown instead of a blank dash
                  // so it reads as "not yet eligible", not "nothing captured".
                  if ((ev.recommendation || '').toUpperCase() === 'HOLD') {
                    if (ev.virtual_outcome === 'virtual_hold_correct') {
                      return `<span title="Resolved 30d+ after this HOLD: price stayed within an 8% band — patience was the right call, nothing actionable existed."
                                style="font-size:9px;padding:1px 5px;border-radius:2px;font-weight:600;white-space:nowrap;background:#16a34a20;color:#16a34a;border:1px solid #16a34a66">✓ correct hold</span>`;
                    }
                    if (ev.virtual_outcome === 'virtual_hold_miss') {
                      return `<span title="Resolved 30d+ after this HOLD: price moved ≥8% in one direction — a BUY or SELL/TRIM likely would have captured it."
                                style="font-size:9px;padding:1px 5px;border-radius:2px;font-weight:600;white-space:nowrap;background:#dc262620;color:#dc2626;border:1px solid #dc262666">✗ missed move</span>`;
                    }
                    if (ev.virtual_outcome === 'virtual_open') {
                      return `<span title="Eligible for grading but price history could not be fetched (delisted, insufficient bars, or a fetch error)." style="color:var(--text-muted);font-size:10px">no data</span>`;
                    }
                    const _ageDays = ev.timestamp ? Math.floor((Date.now() - new Date(ev.timestamp).getTime()) / 86400000) : null;
                    const _daysLeft = _ageDays != null ? Math.max(0, 30 - _ageDays) : null;
                    return `<span title="${_daysLeft != null ? `Graded automatically ${_daysLeft} day(s) from now — needs 30 days of price history to judge whether a real move was missed.` : 'Not yet graded.'}"
                              style="font-size:9px;padding:1px 5px;border-radius:2px;font-weight:500;white-space:nowrap;color:var(--text-muted);border:1px solid var(--border)">⏳ ${_daysLeft != null ? (_daysLeft > 0 ? `pending ${_daysLeft}d` : 'pending') : 'pending'}</span>`;
                  }
                  return `<span style="color:var(--text-muted);font-size:10px">—</span>`;
                })();

                // Fixed-slot button helpers — each slot is a flex cell of constant width
                const _slot = (w, html) =>
                  `<span style="width:${w}px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${html}</span>`;
                const _iconBtn = (id, onclick, title, icon, label, extraStyle='') =>
                  `<button id="${id}" onclick="${onclick}" title="${title}"
                     style="background:none;border:none;cursor:pointer;font-size:11px;padding:2px 3px;border-radius:3px;line-height:1.2;color:var(--text-secondary)${extraStyle}"
                     onmouseover="this.style.background='var(--bg-secondary)'"
                     onmouseout="this.style.background='none'"
                   >${icon}<span style="font-size:8px;display:block;line-height:1;text-align:center;color:var(--text-muted)">${label}</span></button>`;

                return `<tr id="ll-row-${ev.id}" data-wintag="${winTagState}" style="border-bottom:1px solid var(--border);${isOpen ? 'opacity:0.6' : ''}">
                  <td data-label="Date" style="padding:3px 6px;color:var(--text-muted);white-space:nowrap">${(ev.timestamp||'').slice(0,10)}</td>
                  <td data-label="Ticker" style="padding:3px 6px;font-weight:600">${ev.ticker||'—'}</td>
                  <td data-label="Action" style="padding:3px 6px">${ev.recommendation||'—'}</td>
                  <td data-label="Conf" style="padding:3px 6px;text-align:right">${ev.ai_confidence != null ? (ev.ai_confidence*100).toFixed(0)+'%' : '—'}</td>
                  <td data-label="Regime" style="padding:3px 6px;color:var(--text-muted);font-size:11px">${ev.regime||'—'}</td>
                  <td data-label="Outcome" style="padding:3px 6px;white-space:nowrap">${outcomeChip(ev.outcome_status)}${protectiveEl}${virtualChip}</td>
                  <td data-label="P&L%" style="padding:3px 6px;text-align:right;color:${pnlColor}">${pnlStr}</td>
                  <td id="ll-tagcell-${ev.id}" data-label="Error tags" style="padding:3px 6px">${tagCell(ev.id, ev.error_type, ev.outcome_status, ev.error_type_source)}</td>
                  <td data-label="Claude tags" style="padding:3px 6px">${claudeTagsEl}</td>
                  <td data-label="🔬 Skill" style="padding:3px 6px;white-space:nowrap">
                    <div style="display:inline-flex;align-items:center;gap:2px">
                      ${_slot(28, skillBadgeContent)}
                      ${_slot(26, isClosed
                        ? _iconBtn(`skill-btn-${ev.id}`, `triggerSkillScore(${ev.id})`,
                            skillScore != null ? 'Re-score outcome quality' : 'Score outcome quality (skill vs luck)',
                            '🔬', 'Sk')
                        : '')}
                    </div>
                  </td>
                  <td data-label="Actions" style="padding:3px 6px;white-space:nowrap">
                    <div style="display:inline-flex;align-items:center;gap:1px">
                      ${_slot(26, ev.outcome_status === 'win'
                        ? _iconBtn(`tagwin-btn-${ev.id}`, `triggerTagWin(${ev.id})`,
                            winTagState !== 'untagged' ? 'Tagged — click to re-tag this winning trade' : 'Untagged win: identify why this trade succeeded',
                            '&#127942;', winTagState !== 'untagged' ? 'Tagged' : 'Tag',
                            winTagState !== 'untagged' ? ';color:#d97706' : ';color:var(--text-muted);opacity:0.65')
                        : (showPm
                            ? _iconBtn(`pm-btn-${ev.id}`, `triggerDebatePostmortem(${ev.id})`, pmTitle, '🔍', 'Scrut')
                            : ''))}
                      ${_slot(26, showPm
                        ? _iconBtn(`adv-btn-${ev.id}`, `triggerAdversarialPostmortem(${ev.id})`,
                            ev.postmortem_debate ? 'Re-run adversarial debate' : 'Adversarial debate',
                            '&#9876;', 'vs')
                        : '')}
                      ${_slot(26, ev.postmortem_debate
                        ? _iconBtn(``, `viewStoredDebate(${ev.id})`, 'View stored debate transcript', '&#128220;', 'Tr')
                        : '')}
                      ${_slot(26, ev.postmortem_debate
                        ? _iconBtn(`adj-btn-${ev.id}`, `triggerAdjudication(${ev.id})`,
                            'Cloud adjudicator — score both models 0-10', '&#9878;', 'AI')
                        : '')}
                      ${_slot(20, `<button onclick="deleteLearningEvent(${ev.id})" title="Remove event"
                        style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:12px;padding:2px;border-radius:3px;line-height:1"
                        onmouseover="this.style.color='#dc2626'" onmouseout="this.style.color='var(--text-muted)'">✕</button>`)}
                    </div>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : '<p class="text-xs text-muted" style="padding:4px 8px">No AI events logged yet. Run an analysis to start building the audit trail.</p>'}
    </div>`;

  // ── Failed tickers ─────────────────────────────────────────────────────────
  const failedCard = failed.length ? `
    <div class="card section-gap">
      <div class="card-title">⚠️ Recently Failed Tickers (${failed.length})</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Time</th>
            <th style="text-align:left;padding:4px 8px">Ticker</th>
            <th style="text-align:left;padding:4px 8px">Error</th>
          </tr>
        </thead>
        <tbody>
          ${failed.slice(0, 10).map(f => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:4px 8px;color:var(--text-muted)">${(f.timestamp||'').slice(0,16).replace('T',' ')}</td>
              <td style="padding:4px 8px;font-weight:600">${f.ticker||'—'}</td>
              <td style="padding:4px 8px;color:#dc2626">${f.error||''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  // ── Debate Insights card (recent stored bull/bear summaries) ─────────────────
  const debateInsightsCard = debateInsights.length ? `
    <div class="card section-gap">
      <div class="card-title">💬 Recent Debate Summaries</div>
      <p class="text-xs text-muted" style="margin-bottom:8px">
        Stored bull/bear context from local model debate at analysis time.
        Useful for post-mortem: was the model's bear case correct?
      </p>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${debateInsights.map(di => {
          const pnlPct  = di.realized_pnl_pct;
          const pnlStr  = pnlPct != null ? (pnlPct >= 0 ? '+' : '') + Number(pnlPct).toFixed(1) + '%' : 'open';
          const pnlColor = pnlPct > 0 ? '#16a34a' : pnlPct < 0 ? '#dc2626' : 'var(--text-muted)';
          const summary = di.debate_summary || '';
          // Split on " / R:" to get bull/bear parts
          const splitIdx = summary.indexOf(' / R:');
          const bullPart = splitIdx > 0 ? summary.slice(2, splitIdx)         : summary; // strip "B:"
          const bearPart = splitIdx > 0 ? summary.slice(splitIdx + 4)        : '';      // strip " / R:"
          return `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:12px">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="font-weight:600">${di.ticker}</span>
              <div style="display:flex;gap:8px;align-items:center">
                <span style="color:${pnlColor};font-weight:600">${pnlStr}</span>
                <span style="font-size:10px;color:var(--text-muted)">${(di.timestamp||'').slice(0,10)}</span>
              </div>
            </div>
            ${bullPart ? `<div style="color:#16a34a;margin-bottom:2px"><span style="font-size:10px;font-weight:700;margin-right:4px">BULL</span>${bullPart}</div>` : ''}
            ${bearPart ? `<div style="color:#dc2626"><span style="font-size:10px;font-weight:700;margin-right:4px">BEAR</span>${bearPart}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  // ── Internal Debate Engine status card ────────────────────────────────────────
  // Rendered async after the main content — see renderLearningDebateCard()
  const debateCardPlaceholder = `
    <div id="ll-debate-card" class="card section-gap" style="display:none"></div>
    <div id="ll-tag-accuracy-card" class="card" style="display:none"></div>`;

  // ── Debate Stats card (per-pairing agreement metrics) ──────────────────────────
  // Rendered async — see renderDebateStatsCard()
  const debateStatsPlaceholder = `
    <div id="ll-debate-stats-card" class="card section-gap" style="display:none"></div>`;

  const digestHistory = state.digestHistory || [];
  const digestHistoryHtml = digestHistory.length === 0 ? '' : `
    <div style="margin-top:14px">
      <div class="text-xs text-muted" style="font-weight:600;margin-bottom:6px">Saved Digests (${digestHistory.length})</div>
      ${digestHistory.slice(0, 10).map((d, i) => `
        <details style="margin-bottom:6px;border:1px solid var(--border);border-radius:6px;overflow:hidden">
          <summary style="padding:6px 10px;cursor:pointer;font-size:12px;font-weight:600;background:var(--bg-secondary);display:flex;justify-content:space-between;align-items:center;list-style:none">
            <span>📋 ${d.date}</span>
            <button class="btn btn-sm" style="padding:1px 6px;font-size:11px"
              onclick="event.preventDefault();deleteDigest(${i})">✕</button>
          </summary>
          <div style="padding:10px;font-size:12px;line-height:1.6;white-space:pre-wrap;color:var(--text-primary)">${escapeHTML(d.text)}</div>
        </details>`).join('')}
    </div>`;

  const digestCard = `
    <div class="card section-gap" id="postmortem-digest-card">
      <div class="flex-between" style="margin-bottom:6px">
        <div class="card-title" style="margin:0">AI Postmortem Digest</div>
        <div style="display:flex;gap:6px;align-items:center">
          <label class="text-xs text-muted" style="display:flex;align-items:center;gap:4px">
            max tokens
            <input id="digest-max-tokens" type="number" min="300" max="4000" step="100" value="700"
              style="width:68px;padding:2px 4px" title="Max tokens for the digest response (300–4000)">
          </label>
          <button class="btn btn-sm btn-primary" onclick="generatePostmortemDigest()"
            id="digest-btn">Generate Digest</button>
        </div>
      </div>
      <p class="text-xs text-muted">
        Claude analyses your recent losses and failure patterns to extract actionable lessons.
        Each result is saved automatically.
      </p>
      <div id="digest-result" style="display:none;margin-top:10px"></div>
      ${digestHistoryHtml}
    </div>`;

  // ── AI Lesson Generator card ─────────────────────────────────────────────────
  // Distinct from the digest above: the digest is prose for YOU to read; this
  // distils ~100 closed trades + today's macro tape into SCOPED lessons written
  // to trading_lessons, which are injected back into every future decision prompt
  // for Claude to study. Manual-trigger only.
  const lessonGenCard = `
    <div class="card section-gap" id="lesson-gen-card">
      <div class="flex-between" style="margin-bottom:6px">
        <div class="card-title" style="margin:0">🎓 AI Lesson Generator</div>
        <div style="display:flex;gap:6px;align-items:center">
          <label class="text-xs text-muted" style="display:flex;align-items:center;gap:4px">
            trades
            <input id="lesson-gen-n" type="number" min="30" max="200" step="10" value="100"
              style="width:62px;padding:2px 4px" title="How many recent closed trades to learn from (30-200)">
          </label>
          <label class="text-xs text-muted" style="display:flex;align-items:center;gap:4px">
            max tokens
            <input id="lesson-gen-max-tokens" type="number" min="300" max="4000" step="100" value="900"
              style="width:68px;padding:2px 4px" title="Max tokens for the lessons response (300–4000)">
          </label>
          <button class="btn btn-sm btn-primary" onclick="generateTradingLessons()"
            id="lesson-gen-btn">Generate Lessons</button>
        </div>
      </div>
      <p class="text-xs text-muted">
        Claude studies your last ~100 closed trades alongside today's macro tape
        (US market, commodities, FX, market risk) and writes a few durable, scoped
        lessons. Each is saved to your Trading Lessons and fed into future analysis.
      </p>
      <div id="lesson-gen-result" style="display:none;margin-top:10px"></div>
    </div>`;

  // ── Trading Lessons card (async — filled by renderLessonsCard()) ─────────────
  const lessonsPlaceholder = `<div id="ll-lessons-card" class="card section-gap" style="min-height:60px"></div>`;

  // ── Sell Decision Tracker card (async — filled by renderSellOutcomesCard()) ──
  const sellOutcomesPlaceholder = `<div id="ll-sell-outcomes-card" class="card section-gap" style="min-height:60px"></div>`;

  // ── Buy/Top-Up Decision Tracker card (async — filled by renderBuyOutcomesCard()) ──
  const buyOutcomesPlaceholder = `<div id="ll-buy-outcomes-card" class="card section-gap" style="min-height:60px"></div>`;

  // ── Rule Override Efficacy card (async — filled by renderRuleEfficacyCard()) ──
  const ruleEfficacyPlaceholder = `<div id="ll-rule-efficacy-card" class="section-gap"></div>`;

  // ── Thesis Drift card (async — filled by renderThesisDriftCard()) ──
  const thesisDriftPlaceholder = `<div id="ll-thesis-drift-card"></div>`;

  // ── Execution Alpha card (async — filled by renderExecutionAlphaCard()) ──
  const execAlphaPlaceholder = `<div id="ll-exec-alpha-card"></div>`;

  // ── Calibration Quality card (async — filled by renderCalibQualityCard()) ──
  const calibQualityPlaceholder = `<div id="ll-calib-quality-card"></div>`;

  // ── Thesis Accuracy Matrix card (async — filled by renderThesisMatrixCard()) ──
  const thesisMatrixPlaceholder = `<div id="ll-thesis-matrix-card" class="section-gap"></div>`;

  const introNote = `
    <p style="font-size:11.5px;color:var(--text-secondary);margin-bottom:12px;line-height:1.5">
      The calibration cards below are derived from your actual trade history and are the primary learning signal.
      The Debate Engine (collapsed below) is supplementary and optional.
    </p>`;

  const debateCollapsible = `
    <details style="margin-top:16px" ontoggle="this.querySelector('.ll-details-arrow').textContent=this.open?'▼':'▶'">
      <summary style="cursor:pointer;font-size:12px;color:var(--text-secondary);font-weight:600;letter-spacing:0.4px;user-select:none;list-style:none;display:flex;align-items:center;gap:6px">
        <span class="ll-details-arrow" style="font-size:10px">▶</span>
        ADVANCED / EXPERIMENTAL — Debate Engine
        <span style="font-size:10px;font-weight:400;color:var(--text-muted);margin-left:4px">(optional; data-driven calibration above is the primary learning tool)</span>
      </summary>
      <div style="margin-top:8px">
        ${debateStatsPlaceholder}
        ${debateCardPlaceholder}
      </div>
    </details>`;

  // ── Coverage strip (async — filled by renderCoverageCard(); IMPROVEMENTS #3) ──
  const coveragePlaceholder = `<div id="ll-coverage-card"></div>`;

  // ── Go-live readiness scorecard (async — filled by renderGoLiveCard()) ──
  const goLivePlaceholder = `<div id="ll-golive-card"></div>`;

  // ── HOLD Decisions list (async — filled by renderHoldDecisionsCard()) ──
  const holdDecisionsPlaceholder = `<div id="ll-hold-decisions-card"></div>`;

  // Rule Override Efficacy promoted next to the other top-of-page scorecards
  // (Go-Live Readiness, Coverage) — feedback: it's a load-bearing secondary
  // calibration loop (are the deterministic quant rules themselves right?) and
  // was previously buried 28th in this assembly, well below the Debate Engine's
  // supplementary/optional material.
  return introNote + _llWindowBar() + summaryCards + goLivePlaceholder + coveragePlaceholder + ruleEfficacyPlaceholder + regressionBanner + phase8Note + holdOutcomesCard + holdDecisionsPlaceholder + calibCard + calibQualityPlaceholder +
    `<div class="grid-2" style="margin-top:14px">${regimeCard}${versionsCard}</div>` +
    failureCard + successCard +
    realVsPaperCard + byModelCard + buyVsTopupCard + capitalEffCard + ensembleDivCard + maeMfeCard +
    `<div id="ll-factor-winrates-card" style="display:none"></div>` +
    recentCard + failedCard + debateInsightsCard +
    digestCard + lessonGenCard + lessonsPlaceholder + sellOutcomesPlaceholder + buyOutcomesPlaceholder + thesisDriftPlaceholder +
    thesisMatrixPlaceholder + execAlphaPlaceholder + debateCollapsible;
}

// ── HOLD Decisions card (per-HOLD 30-day passivity review) ────────────────────
// HOLD recs never enter client rec state (analysis.js strips them from
// filteredRecs) — this is the ONLY place the model's "keep holding" calls are
// surfaced. Backed by GET /api/learning/hold-recs; each row shows the redesigned
// _resolve_hold_outcomes() verdict (endpoint-based, direction-aware, vol-scaled)
// once it's ≥30 days old, or a days-until-review countdown while pending.
async function renderHoldDecisionsCard() {
  const el = document.getElementById('ll-hold-decisions-card');
  if (!el) return;
  let d;
  try {
    const r = await fetch(`${API}/api/learning/hold-recs?limit=100`);
    d = await r.json();
  } catch { el.innerHTML = ''; return; }
  if (!d || !d.ok || !Array.isArray(d.holds) || d.holds.length === 0) {
    el.innerHTML = `<div class="card section-gap">
      <div class="card-title">HOLD Decisions</div>
      <div class="text-xs text-muted">No HOLD recommendations logged yet. HOLDs are the positions the model reviewed and chose to keep — they're logged separately from BUY/SELL/TRIM and graded 30 days later.</div>
    </div>`;
    return;
  }

  const _verdict = (h) => {
    if (h.virtual_outcome === 'virtual_hold_correct')
      return { icon: '✅', label: 'Held correctly', color: '#16a34a' };
    if (h.virtual_outcome === 'virtual_hold_miss')
      return { icon: '⚠️', label: 'Sat through drawdown', color: '#dc2626' };
    if (h.virtual_outcome === 'virtual_open')
      return { icon: '○', label: 'Not gradable', color: '#6b7280' };
    if (h.days_until_review != null)
      return { icon: '⏳', label: `Review in ${h.days_until_review}d`, color: '#d97706' };
    return { icon: '·', label: 'Pending', color: '#6b7280' };
  };

  const rows = d.holds.map(h => {
    const v = _verdict(h);
    const conf = (h.confidence != null) ? `${Math.round(h.confidence * 100)}%` : '—';
    const dateStr = (h.timestamp || '').slice(0, 10);
    const reason = h.reasoning ? escapeHTML(h.reasoning) : '';
    return `<tr>
      <td data-label="Ticker" style="font-weight:600">${escapeHTML(h.ticker || '')}</td>
      <td data-label="Date" class="text-xs text-muted">${dateStr}</td>
      <td data-label="Conf">${conf}</td>
      <td data-label="Regime" class="text-xs text-muted">${escapeHTML(h.regime || '—')}</td>
      <td data-label="30-day review"><span style="color:${v.color};font-weight:600;white-space:nowrap">${v.icon} ${v.label}</span></td>
      <td data-label="Rationale" class="text-xs text-muted" style="max-width:280px">${reason}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `<div class="card section-gap">
    <div class="card-title">HOLD Decisions</div>
    <p class="text-xs text-muted" style="margin-bottom:8px">
      Positions the model reviewed and chose to <strong>keep</strong> — logged separately from actionable recs. The <strong>30-day review</strong> is the redesigned passivity check: endpoint return over a 20-trading-day forward window vs a volatility-scaled band (a held long that sat through a sustained drawdown = ⚠️; up or flat = ✅). ${d.resolved_n} of ${d.n} graded so far.
    </p>
    <div style="overflow-x:auto">
      <table class="tbl tbl-stack" style="width:100%;font-size:13px">
        <thead><tr>
          <th style="text-align:left">Ticker</th><th style="text-align:left">Date</th>
          <th style="text-align:left">Conf</th><th style="text-align:left">Regime</th>
          <th style="text-align:left">30-day review</th><th style="text-align:left">Rationale</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// ── Data-hygiene coverage strip (IMPROVEMENTS #3) ─────────────────────────────
// The loop's worst silent failure mode is capture decay: a column stops being
// filled and the analytics built on it quietly empty (this is how NULL entry
// drivers blanked three whole cards for weeks). This strip makes each capture's
// fill-rate — and the work queues that fix them — visible at a glance.
async function renderCoverageCard() {
  const el = document.getElementById('ll-coverage-card');
  if (!el) return;
  let d;
  try {
    const r = await fetch(`${API}/api/learning/coverage`);
    d = await r.json();
  } catch (_) { return; }
  if (!d?.ok || !d.n_closed) { el.innerHTML = ''; return; }

  const cov = d.coverage || {}, q = d.queues || {};
  const cell = (label, c, hint) => {
    if (!c) return '';
    const pct = c.pct;
    const color = pct == null ? 'var(--text-muted)'
      : pct >= 80 ? 'var(--up, #22c55e)'
      : pct >= 50 ? '#f59e0b' : '#ef4444';
    const val = pct == null ? '—' : `${c.covered}/${c.total}`;
    return `<div style="text-align:center;min-width:86px" title="${escapeHTML(hint)}">
      <div style="font-size:15px;font-weight:700;color:${color}">${val}</div>
      <div class="text-xs text-muted">${label}</div>
    </div>`;
  };
  const chip = (label, text, warn, hint) => `
    <span class="text-xs" title="${escapeHTML(hint)}" style="padding:2px 8px;border-radius:10px;white-space:nowrap;
      border:1px solid ${warn ? '#f59e0b' : 'var(--border)'};color:${warn ? '#b45309' : 'var(--text-secondary)'}">
      ${label}: <strong>${text}</strong></span>`;

  const holdText = q.hold_events ? `${q.hold_resolved}/${q.hold_events}` : 'none yet';
  const virtText = q.virtual_pending
    ? `${q.virtual_pending}${q.days_until_virtual != null ? ` (eligible in ${q.days_until_virtual}d)` : ''}`
    : '0';

  el.innerHTML = `
    <div class="card section-gap">
      <div class="flex-between">
        <div class="card-title" style="margin:0">🧹 Capture Coverage <span class="text-xs text-muted" style="font-weight:400">(of closed trades — hover a cell for the fixing action)</span></div>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px">
        ${cell('Error tags', cov.error_type, 'Losses/breakevens with an error_type. Fix: deterministic tagger fills these lazily; use "Classify All Untagged" (Recent Events) for the pre-capture remainder.')}
        ${cell('Win tags', cov.success_tags, 'Wins with success_tags. Fix: deterministic success tagger fills lazily; 🏆 button for manual.')}
        ${cell('Entry driver', cov.entry_driver, 'Closed BUY/TOP_UP with primary_entry_driver. Fix: auto-backfills on every Learning Loop Sync (Performance page).')}
        ${cell('Thesis verdict', cov.thesis_verdict, 'Closed BUY/TOP_UP with a thesis_verdict. Not backfillable — needs exit-time signals; fills as positions close via SELL/TRIM recs.')}
        ${cell('MAE/MFE', cov.mae_mfe, 'Closed BUY/TOP_UP with path stats. Lazy resolver, 5 per calibration fetch — fills over time on its own.')}
        ${cell('Exit signals', cov.exit_signals, 'Closed SELL/TRIM with an exit snapshot. Captured at execution by markExecuted() — a gap here means executions bypassed the rec card.')}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        ${chip('Stuck open >60d', q.stuck_open_60d ?? 0, (q.stuck_open_60d ?? 0) > 0, 'Executed events never graded — almost always a missed Sync. Fix: Performance page → Sync to Learning Loop.')}
        ${chip('Virtual pending', virtText, false, 'Unexecuted recs awaiting the 30-day virtual-outcome gate; resolve automatically after that.')}
        ${chip('HOLD resolved', holdText, false, 'HOLD passivity grading (30-day lag, ±8% band). Accumulates from analysis runs.')}
        ${chip('Lessons', q.lessons ?? 0, (q.lessons ?? 0) === 0, 'Scoped lessons injected into future prompts. Fix: AI Lesson Generator card below → Generate Lessons.')}
      </div>
    </div>`;
}

// ── Go-live readiness scorecard ───────────────────────────────────────────────
// Turns "is the model good enough to trade live?" into an objective checklist.
// The user is running a ≥6-month paper validation first; this scores the paper
// track record against friction-adjusted bars (paper fills are frictionless, so
// every P&L criterion haircuts costs before judging). Read-only.
async function renderGoLiveCard() {
  const el = document.getElementById('ll-golive-card');
  if (!el) return;
  // Avoid double-counting friction: when Realistic Paper Fills is ON, each paper
  // trade's P&L already includes per-trade slippage, so the scorecard must NOT
  // also apply its flat haircut (pass friction_bps=0). When OFF, fills are clean
  // and the haircut is what accounts for real-world friction (default 30bps).
  const _realistic = state.settings?.paperRealisticFills !== false;
  const _fb = _realistic ? 0 : 30;
  let d;
  try {
    const r = await fetch(`${API}/api/learning/go-live-readiness?friction_bps=${_fb}`);
    d = await r.json();
  } catch (_) { return; }
  if (!d || !d.ok) { el.innerHTML = ''; return; }

  const OVERALL = {
    ready:     { label: 'READY TO GO LIVE', color: '#16a34a', bg: 'rgba(22,163,74,0.08)', icon: '🟢' },
    almost:    { label: 'ALMOST — keep paper trading', color: '#d97706', bg: 'rgba(217,119,6,0.08)', icon: '🟡' },
    not_ready: { label: 'NOT READY — keep paper trading', color: '#dc2626', bg: 'rgba(220,38,38,0.08)', icon: '🔴' },
  };
  const o = OVERALL[d.overall] || OVERALL.not_ready;
  const chip = { pass: ['✓', '#16a34a'], warn: ['~', '#d97706'], fail: ['✗', '#dc2626'] };

  const rows = (d.criteria || []).map(c => {
    const [mark, col] = chip[c.status] || chip.fail;
    return `
      <div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-top:1px solid var(--border)">
        <span style="color:${col};font-weight:800;font-size:15px;line-height:1.3;min-width:14px">${mark}</span>
        <div style="flex:1">
          <div style="font-weight:600;font-size:13px">${escapeHTML(c.label)}</div>
          <div class="text-xs text-muted" style="margin-top:1px">${escapeHTML(c.detail || '')}</div>
        </div>
      </div>`;
  }).join('');

  // Model-mix honesty note: calibration validates a (prompt × model) tuple, so a
  // scorecard blended across models measures a moving target. Surface the mix when
  // >1 model fed the sample (amber), otherwise a quiet confirmation line.
  const _mm = d.model_mix;
  const modelMixHtml = _mm ? `
      <div class="text-xs" style="margin:6px 0 2px;padding:6px 8px;border-radius:6px;
        background:${_mm.mixed ? 'rgba(217,119,6,0.08)' : 'transparent'};
        color:${_mm.mixed ? '#d97706' : 'var(--text-muted)'}">
        ${_mm.mixed ? '⚠ ' : ''}${escapeHTML(_mm.note || '')}
      </div>` : '';

  el.innerHTML = `
    <div class="card section-gap" style="border-left:3px solid ${o.color}">
      <div class="flex-between" style="flex-wrap:wrap;gap:6px">
        <div class="card-title" style="margin:0">🎯 Go-Live Readiness</div>
        <span style="font-weight:700;font-size:12px;color:${o.color};background:${o.bg};padding:3px 10px;border-radius:12px">
          ${o.icon} ${o.label} · ${d.n_pass}/${d.n_total}
        </span>
      </div>
      <div class="text-xs text-muted" style="margin:6px 0 2px">
        Paper track record scored against live-trading bars.
        ${_realistic
          ? `Realistic paper fills are <strong>on</strong>, so per-trade spread &amp; slippage is already baked into these P&amp;L figures (scorecard haircut 0bps to avoid double-counting).`
          : `Realistic paper fills are <strong>off</strong>, so P&amp;L criteria haircut ${d.friction_bps}bps/trade — real spread &amp; slippage would erode a frictionless paper edge.`}
        Thresholds are conservative by design.
      </div>
      ${modelMixHtml}
      ${rows}
    </div>`;
}

// ── Postmortem digest — AI summary of recent failure patterns ─────────────────
async function generatePostmortemDigest() {
  const btn = document.getElementById('digest-btn');
  const out = document.getElementById('digest-result');
  if (!btn || !out) return;
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }

  btn.disabled = true;
  btn.textContent = 'Generating…';
  out.style.display = 'block';
  out.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';

  try {
    const r = await fetch(`${API}/api/learning/digest-data`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error);

    const agg = d.aggregates || {};
    const wr = d.overall_total > 0 ? Math.round(d.overall_wins / d.overall_total * 100) : null;
    const errorParts = (d.error_dist || []).map(e => `${e.error_type}: ${e.n}`).join(', ');
    const exitParts  = (d.exit_dist  || []).map(e => `${e.exit_reason}: ${e.n}`).join(', ');
    const regimeParts = (d.regime_stats || [])
      .map(r => `${r.regime} ${r.win_rate != null ? r.win_rate + '% win' : ''}/${r.total} trades`)
      .join('; ');

    // Macro-bucket cross-tab — independent of the classified regime label.
    // '⚑' marks buckets whose win rate is significantly off the overall rate
    // (Wilson CI gated server-side — _ci_excludes()), so Claude doesn't treat
    // a 7/10 fluke the same as a real divergence.
    const macroParts = (agg.macro_bucket_stats || [])
      .map(b => `${b.bucket}: ${b.win_rate}% (n=${b.n})${b.flagged ? ' ⚑' : ''}`)
      .join('; ');

    // Luck vs skill split — invalidated/reversed-thesis losses are process
    // errors (fixable by a rule change); validated-thesis losses are bad
    // variance (the read was right, the trade still lost).
    const verdictParts = (agg.thesis_verdict_xtab || [])
      .map(v => `${v.verdict}: ${v.win_rate}% (n=${v.n})`)
      .join('; ');

    const driverParts = (agg.driver_xtab || [])
      .map(dr => `${dr.driver}: ${dr.win_rate}% (n=${dr.n})${dr.flagged ? ' ⚑' : ''}`)
      .join('; ');

    const skillLine = (agg.skill_score_avg?.win != null || agg.skill_score_avg?.loss != null)
      ? `Avg skill_score — wins: ${agg.skill_score_avg.win ?? '?'}, losses: ${agg.skill_score_avg.loss ?? '?'} (0-10 process-quality score)`
      : null;
    const confLine = (agg.confidence_avg?.win != null || agg.confidence_avg?.loss != null)
      ? `Avg stated confidence — wins: ${agg.confidence_avg.win != null ? Math.round(agg.confidence_avg.win * 100) + '%' : '?'}, losses: ${agg.confidence_avg.loss != null ? Math.round(agg.confidence_avg.loss * 100) + '%' : '?'}`
      : null;
    const exitQualityParts = Object.entries(agg.exit_quality_dist || {})
      .map(([k, v]) => `${k}: ${v}`).join(', ');

    const exemplarBlock = (d.exemplars || []).join('\n');

    const prompt =
`You are reviewing my ASX trading learning loop. This is a statistical sample of
${agg.n || 0} recent closed trades (wins and losses both included).

Overall win rate: ${wr != null ? wr + '%' : 'unknown'} (${d.overall_total} closed trades)
Error type distribution: ${errorParts || 'none tagged'}
Exit reason distribution: ${exitParts || 'none recorded'}
Regime performance (classified label): ${regimeParts || 'no data'}
Macro-condition performance (raw tape, independent of regime label): ${macroParts || 'insufficient data'}
Entry-driver win rate: ${driverParts || 'insufficient data'}
Thesis-verdict win rate (luck vs skill — see below): ${verdictParts || 'insufficient data'}
${skillLine || ''}
${confLine || ''}
Exit-quality tag distribution (closed SELL/TRIM only): ${exitQualityParts || 'none tagged'}

Curated examples (worst losses, best wins, process failures, validated stop-widening
evidence, early-exit drag cases — entry→exit technicals, macro tape, and my own
bull/bear case at the time):
${exemplarBlock || 'No exemplars available yet.'}

Please write a concise postmortem digest (under 320 words) in plain text. Structure it as:
1. The 2-3 most recurring patterns, each citing the specific stat above that supports it —
   do not state a pattern that isn't backed by one of these numbers.
2. Luck vs skill: based on the thesis-verdict win rates, how much of any recent drawdown
   is process error (invalidated/reversed thesis — fixable) vs bad variance (validated
   thesis, still lost — not fixable by a rule change)?
3. Any macro/regime-conditional pattern (cite a ⚑-flagged bucket if one exists; if none
   are flagged, say so plainly rather than inventing one).
4. One or two concrete, specific rule/threshold changes to make — no generic advice.`;

    const _digestTokens = Math.max(300, Math.min(4000, parseInt(document.getElementById('digest-max-tokens')?.value, 10) || 700));
    const text = await callClaude('assistant', prompt, { maxTokens: _digestTokens, noCache: true });
    const dateStr = new Date().toLocaleDateString('en-AU');
    out.innerHTML = `
      <div style="border-top:1px solid var(--border);padding-top:10px">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span class="text-xs text-muted" style="font-weight:600">AI Digest — ${dateStr}</span>
          <button class="btn btn-sm" onclick="document.getElementById('digest-result').style.display='none'">✕</button>
        </div>
        <div style="font-size:13px;line-height:1.6;white-space:pre-wrap;color:var(--text-primary)">${escapeHTML(text)}</div>
      </div>`;
    if (!Array.isArray(state.digestHistory)) state.digestHistory = [];
    state.digestHistory.unshift({ date: dateStr, text });
    if (state.digestHistory.length > 50) state.digestHistory.length = 50;
    await saveStateToDb();
    localStorage.setItem('lastPostmortemDigestDate', todayStr());
    // Store closed trade count so monthly reminder knows how many trades since last digest
    fetch(`${API}/api/learning/stats`).then(r => r.ok ? r.json() : null).then(d => {
      if (d && d.closed) localStorage.setItem('lastPostmortemDigestClosed', String(d.closed));
    }).catch(() => {});
  } catch (e) {
    out.innerHTML = `<div class="text-sm text-danger" style="padding:8px">${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Digest';
  }
}

// ── AI Lesson Generator ───────────────────────────────────────────────────────
// Manual-trigger. Distils ~100 closed trades + today's macro tape (US market,
// commodities, FX, market risk) into a few DURABLE, SCOPED lessons that are
// written to trading_lessons and injected into every future decision prompt.
// Distinct from generatePostmortemDigest(): the digest is prose for the user;
// this produces structured, persisted lessons for Claude to study next time.
async function generateTradingLessons() {
  const btn = document.getElementById('lesson-gen-btn');
  const out = document.getElementById('lesson-gen-result');
  if (!btn || !out) return;
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }

  let n = parseInt(document.getElementById('lesson-gen-n')?.value, 10);
  if (!Number.isFinite(n)) n = 100;
  n = Math.max(30, Math.min(200, n));

  btn.disabled = true;
  btn.textContent = 'Generating…';
  out.style.display = 'block';
  out.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';

  try {
    // 1. Trade learning data (~100 closed trades + CI-gated cross-tabs + exemplars)
    const r = await fetch(`${API}/api/learning/lesson-source?n=${n}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    if (!d.n_sample) {
      out.innerHTML = `<div class="text-sm text-muted" style="padding:8px">Not enough closed trades yet to distil lessons (need a handful of executed, closed recs first).</div>`;
      return;
    }

    // 2. Live macro tape — US market, commodities, FX, market risk. Fetch fresh
    //    (best-effort) and fall back to the morning brief already in state.macroData.
    let md = state.macroData || {};
    try {
      const mr = await fetch(`${API}/api/macro`);
      if (mr.ok) md = { ...(state.macroData || {}), ...(await mr.json()) };
    } catch (_) { /* best-effort — proceed with whatever state has */ }

    const _chg = (b) => (b && typeof b.change_pct === 'number')
      ? `${b.change_pct > 0 ? '+' : ''}${b.change_pct}%` : 'n/a';
    const _lvl = (b) => (b && typeof b.value === 'number') ? b.value : 'n/a';
    const regimeNow = state.currentRegime?.regime || 'unknown';
    const macroBlock =
`Current macro tape (today):
- Regime: ${regimeNow}
- US market: S&P 500 ${_chg(md.sp500)}, Nasdaq ${_chg(md.nasdaq)}
- Market risk: VIX ${_lvl(md.vix)} (${_chg(md.vix)}), ASX 20d vol ${md.asx_vol_20d ?? 'n/a'}, breadth(adv/decline) ${md.advance_decline_ratio ?? 'n/a'}
- Commodities: gold ${_chg(md.gold)}, oil ${_chg(md.oil)}, copper ${_chg(md.copper)}, iron ore ${_chg(md.iron_ore)}
- FX: AUD/USD ${_chg(md.aud_usd)}
- RBA cash rate: ${state.rbaRate ?? 'n/a'}%`;
    const briefNarrative = (md.analysis || md.keyDrivers)
      ? `\nThis morning's AI macro brief: ${md.analysis || md.keyDrivers}`.slice(0, 600)
      : '';

    // 3. Trade-data summary (reuse the digest framing)
    const agg = d.aggregates || {};
    const wr = d.overall_total > 0 ? Math.round(d.overall_wins / d.overall_total * 100) : null;
    const errorParts  = (d.error_dist || []).map(e => `${e.error_type}: ${e.n}`).join(', ');
    const regimeParts = (d.regime_stats || [])
      .map(x => `${x.regime} ${x.win_rate != null ? x.win_rate + '%' : '?'}/${x.total}`).join('; ');
    const driverParts = (d.buy_drivers || [])
      .map(x => `${x.driver} ${x.win_rate}%/${x.total} (avg ${x.avg_pnl ?? '?'}%)`).join('; ');
    const verdictParts = (agg.thesis_verdict_xtab || [])
      .map(v => `${v.verdict}: ${v.win_rate}% (n=${v.n})`).join('; ');
    const macroParts = (agg.macro_bucket_stats || [])
      .map(b => `${b.bucket}: ${b.win_rate}% (n=${b.n})${b.flagged ? ' ⚑' : ''}`).join('; ');
    const exemplarBlock = (d.exemplars || []).join('\n');

    // 4. Historical macro context block (last 60 sessions from macro_snapshots table)
    const histRows = (d.macro_history || []);
    let macroHistoryBlock = '';
    if (histRows.length >= 2) {
      const n = histRows.length;
      const _avg = (key) => {
        const vals = histRows.map(r => r[key]).filter(v => typeof v === 'number');
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      };
      const avgVix   = _avg('vix_level');
      const avgVol   = _avg('asx_vol_20d');
      const avgBreadth = _avg('advance_decline_ratio');
      const riskOffDays = histRows.filter(r => typeof r.asx200_chg === 'number' && r.asx200_chg < -0.5).length;
      const riskOnDays  = histRows.filter(r => typeof r.asx200_chg === 'number' && r.asx200_chg > 0.5).length;
      const highVolDays = histRows.filter(r => typeof r.asx_vol_20d === 'number' && r.asx_vol_20d > 15).length;
      const _f = (v, dp=1) => v != null ? `${v > 0 ? '+' : ''}${v.toFixed(dp)}` : 'n/a';
      const recent14 = histRows.slice(0, 14).reverse();
      const tableRows = recent14.map(r =>
        `${r.snapshot_date}: ASX${_f(r.asx200_chg)}% VIX${r.vix_level?.toFixed(1) ?? '?'} ` +
        `vol${r.asx_vol_20d?.toFixed(1) ?? '?'} breadth${r.advance_decline_ratio?.toFixed(2) ?? '?'} ` +
        `gold${_f(r.gold_chg)}% AUD${_f(r.aud_usd_chg)}% oil${_f(r.oil_chg)}%`
      ).join('\n');
      macroHistoryBlock =
`\nMacro history (last ${n} recorded sessions):
Avg VIX: ${avgVix?.toFixed(1) ?? 'n/a'}, Avg ASX realised vol: ${avgVol?.toFixed(1) ?? 'n/a'}%, Avg breadth: ${avgBreadth?.toFixed(2) ?? 'n/a'}
Risk-on sessions (ASX >+0.5%): ${riskOnDays}/${n}, Risk-off sessions (ASX <-0.5%): ${riskOffDays}/${n}, High-vol sessions (vol>15%): ${highVolDays}/${n}
Recent 14 sessions (oldest→newest, for trend direction):
${tableRows}`;
    }

    // 3.5. Local-LLM critic feedback — a separate 24B Ollama model's manually-run
    //      second opinion on past recs (routes/debate.py /api/debate/scrutinize).
    //      Aggregate track record only, not a raw dump — see routes/learning.py
    //      _compute_scrutiny_stats() for the accuracy-vs-outcome methodology.
    let scrutinyBlock = '';
    try {
      const sr = await fetch(`${API}/api/learning/scrutiny-stats`);
      if (sr.ok) {
        const s = await sr.json();
        if (s.ok && s.n_scrutinized > 0) {
          const disagreeExemplars = (s.exemplars || []).map(e =>
            `${e.action} ${e.ticker} → ${e.outcome}${e.realized_pnl_pct != null ? ' (' + e.realized_pnl_pct.toFixed(1) + '%)' : ''}, ` +
            `critic said: "${e.concerns || ''}" (critic was ${e.critic_right ? 'right' : 'wrong'})`
          ).join('\n');
          scrutinyBlock =
`\nLocal critic second opinion (a separate 24B model, manually run on ${s.n_scrutinized} past recs — treat as one more data point, not ground truth):
- Disagreed with ${s.n_disagree}/${s.n_scrutinized} recs (${s.disagree_rate ?? '?'}%)${s.disagree_accuracy != null ? `; when it disagreed, it was later proven right ${s.disagree_accuracy}% of the time (n=${s.n_disagree_resolved})` : ' — not enough resolved disagreements yet to judge its accuracy'}
${s.agree_accuracy != null ? `- When it agreed with the rec, the rec went on to win ${s.agree_accuracy}% of the time (n=${s.n_agree_resolved})` : ''}
${disagreeExemplars ? `Recent disagreements:\n${disagreeExemplars}` : ''}`;
        }
      }
    } catch (_) { /* best-effort — proceed without it */ }

    const prompt =
`You are distilling durable trading lessons for an ASX equity decision system. These
lessons will be stored and injected verbatim into FUTURE recommendation prompts for you
to follow — so each must be specific, actionable, and backed by the data below, not
generic advice.

Sample: ${d.n_sample} recent closed trades (BUY/TOP_UP/SELL/TRIM, wins and losses).
Overall win rate: ${wr != null ? wr + '%' : 'unknown'} (${d.overall_total} closed)
Error-tag distribution: ${errorParts || 'none tagged'}
Win rate by regime: ${regimeParts || 'no data'}
BUY entry-driver performance: ${driverParts || 'insufficient data'}
Thesis-verdict win rate (process vs luck): ${verdictParts || 'insufficient data'}
Macro-condition performance (⚑ = significant vs overall): ${macroParts || 'insufficient data'}

Curated examples (worst losses, best wins, process failures — entry→exit technicals,
macro tape, and my own bull/bear case at the time):
${exemplarBlock || 'No exemplars available yet.'}

${macroBlock}${briefNarrative}${macroHistoryBlock}${scrutinyBlock}

Write 3 to 6 lessons. Each lesson MUST:
- be ONE sentence, <= 200 characters, concrete and testable (cite a number/threshold/tag
  from the data when possible, e.g. "When VIX > 25, mean_reversion BUYs won only 31% (n=12) — require a confirmed reversal first");
- generalise to future decisions (a repeatable rule, not a one-off);
- carry an optional scope so it only fires in the right context.

Return ONLY a JSON object, no prose, no markdown fences, in exactly this shape:
{"lessons":[{"lesson_text":"...","regime":null|"riskOn"|"riskOff"|"highVol"|"panic"|"trend"|"sideways","sector":null|"Materials"|"Financials"|"Healthcare"|"Energy"|"RealEstate"|"Technology"|"Consumer"|"Industrials"|"Utilities"|"Communication","breadth_scope":null|"high_vol"|"low_vol"|"adl_below_0.3"|"adl_above_0.7"|"earnings_season"|"cgt_window"}]}
Use null for any scope that does not apply (a broadly-true lesson has all three null).`;

    const _lessonTokens = Math.max(300, Math.min(4000, parseInt(document.getElementById('lesson-gen-max-tokens')?.value, 10) || 900));
    const text = await callClaude('assistant', prompt, { maxTokens: _lessonTokens, noCache: true });

    // 4. Parse the JSON (tolerate stray prose / code fences)
    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch (_) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
    }
    const lessons = Array.isArray(parsed?.lessons) ? parsed.lessons : [];
    if (!lessons.length) throw new Error('Model returned no parseable lessons. Raw: ' + text.slice(0, 160));

    // 5. Persist each lesson to trading_lessons (source flags it as AI-generated)
    const _REGIMES = new Set(['riskOn', 'riskOff', 'highVol', 'panic', 'trend', 'sideways']);
    const _SCOPES  = new Set(['high_vol', 'low_vol', 'adl_below_0.3', 'adl_above_0.7', 'earnings_season', 'cgt_window']);
    const saved = [];
    for (const L of lessons) {
      const lesson_text = String(L?.lesson_text || '').trim().slice(0, 240);
      if (!lesson_text) continue;
      const body = {
        lesson_text,
        regime:        _REGIMES.has(L?.regime) ? L.regime : null,
        sector:        (L?.sector && typeof L.sector === 'string') ? L.sector : null,
        breadth_scope: _SCOPES.has(L?.breadth_scope) ? L.breadth_scope : null,
        source: 'ai_digest',
      };
      try {
        const resp = await fetch(`${API}/api/learning/lessons`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if ((await resp.json()).ok) saved.push(body);
      } catch (_) { /* skip the one that failed, keep the rest */ }
    }

    const dateStr = new Date().toLocaleDateString('en-AU');
    out.innerHTML = `
      <div style="border-top:1px solid var(--border);padding-top:10px">
        <div class="flex-between" style="margin-bottom:6px">
          <span class="text-xs text-muted" style="font-weight:600">${saved.length} lesson${saved.length === 1 ? '' : 's'} saved — ${dateStr}</span>
          <button class="btn btn-sm" onclick="document.getElementById('lesson-gen-result').style.display='none'">✕</button>
        </div>
        <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6;color:var(--text-primary)">
          ${saved.map(s => `<li>${escapeHTML(s.lesson_text)}${
            (s.regime || s.sector || s.breadth_scope)
              ? ` <span class="text-xs text-muted">[${[s.regime, s.sector, s.breadth_scope].filter(Boolean).join(' · ')}]</span>`
              : ''
          }</li>`).join('')}
        </ul>
        <p class="text-xs text-muted" style="margin-top:8px">These are now in your Trading Lessons below and will be injected into future analysis.</p>
      </div>`;
    toast(`${saved.length} AI lesson${saved.length === 1 ? '' : 's'} saved`, 'success');
    renderLessonsCard().catch(() => {});  // refresh the lessons list so they show immediately
  } catch (e) {
    out.innerHTML = `<div class="text-sm text-danger" style="padding:8px">${escapeHTML(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Lessons';
  }
}

// ── Delete a saved digest entry ───────────────────────────────────────────────
async function deleteDigest(index) {
  if (!Array.isArray(state.digestHistory)) return;
  state.digestHistory.splice(index, 1);
  await saveStateToDb();
  renderPage();
}

// ── Delete a single learning event (optimise calibration dataset) ─────────────
async function deleteLearningEvent(id) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  try {
    const resp = await fetch(`${API}/api/learning/event/${id}`, { method: 'DELETE' });
    const result = await resp.json();
    if (result.ok) {
      const row = document.getElementById(`ll-row-${id}`);
      if (row) {
        row.style.transition = 'opacity 0.2s';
        row.style.opacity = '0';
        setTimeout(() => row.remove(), 200);
      }
      toast('Learning event removed', 'success');
    } else {
      toast('Could not remove event: ' + (result.error || 'unknown error'), 'error');
    }
  } catch (e) {
    toast('Error removing event: ' + e.message, 'error');
  }
}

// ── Debate engine status card (async, rendered after main content) ────────────
async function renderLearningDebateCard() {
  const el = document.getElementById('ll-debate-card');
  if (!el) return;

  const status = await debateStatus();

  if (!status.available) {
    el.style.display = 'block';
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div class="card-title" style="margin:0">&#x1F916; Local Debate Engine</div>
        <span style="font-size:11px;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;padding:2px 8px;border-radius:4px">Offline</span>
      </div>
      <p class="text-xs text-muted" style="margin-top:6px">
        Ollama is not running. Install from
        <a href="https://ollama.com/download" target="_blank" style="color:#3b82f6">ollama.com/download</a>,
        then run <code style="background:var(--bg-secondary);padding:1px 4px;border-radius:2px">ollama pull qwen3.5:9b</code>
        to enable bull/bear debate before Claude analyses your portfolio.
      </p>
      <button onclick="startOllamaAndRefreshDebateCard()"
        style="margin-top:8px;font-size:11px;padding:4px 12px;border-radius:4px;background:#3b82f6;color:#fff;border:none;cursor:pointer">
        Try Starting Ollama
      </button>`;
    return;
  }

  // Ollama is running — show models, selector, and aggression control
  const models = status.models || [];
  const recommended = ['qwen3.5:9b', 'qwen3:9b', 'qwen3:4b', 'gemma4', 'gemma3:4b', 'qwen3:0.6b'];
  const pulledRec = models.filter(m => recommended.some(r => m.startsWith(r.split(':')[0])));
  const currentModel    = state.debate?.model || '';
  const currentOppModel = state.debate?.oppositionModel || '';
  const currentAgg      = state.debate?.aggression || 'light';

  // Cloud model presets — always shown; backend reads keys from news_settings
  const CLOUD_MODELS = [
    { value: 'groq:llama-3.3-70b-versatile', label: 'groq: llama-3.3-70b (free)' },
    { value: 'groq:mixtral-8x7b-32768',      label: 'groq: mixtral-8x7b (free)'  },
    { value: 'gemini:gemini-2.0-flash',       label: 'gemini: 2.0-flash (free)'   },
    { value: 'gemini:gemini-1.5-flash',       label: 'gemini: 1.5-flash (free)'   },
  ];

  const _mkOpts = (list, current, autoLabel) => [
    `<option value="" ${current === '' ? 'selected' : ''}>${autoLabel}</option>`,
    ...list.map(m => `<option value="${m}" ${current === m ? 'selected' : ''}>${m}</option>`),
    `<optgroup label="─ Cloud (needs key in News settings) ─">`,
    ...CLOUD_MODELS.map(c => `<option value="${c.value}" ${current === c.value ? 'selected' : ''}>${c.label}</option>`),
    `</optgroup>`,
  ].join('');

  const modelOptions    = _mkOpts(models, currentModel,    `Auto (${typeof preferredDebateModel === 'function' ? preferredDebateModel(models) : models[0] || '?'})`);
  const oppModelOptions = _mkOpts(models, currentOppModel, 'Auto (pick different model)');

  el.style.display = 'block';
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div class="card-title" style="margin:0">🤖 Debate Engine</div>
      <span style="font-size:11px;color:#16a34a;background:#f0fdf4;border:1px solid #bbf7d0;padding:2px 8px;border-radius:4px">● Online · ${models.length} local model${models.length !== 1 ? 's' : ''} pulled</span>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600">Primary model</div>
        <select onchange="setDebateModel(this.value)"
          style="width:100%;font-size:12px;padding:4px 6px;border-radius:5px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary)">
          ${modelOptions}
        </select>
      </div>
      <div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600">Debate depth</div>
        <select onchange="setDebateAggression(this.value)"
          style="width:100%;font-size:12px;padding:4px 6px;border-radius:5px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary)">
          <option value="none"  ${currentAgg === 'none'  ? 'selected' : ''}>None — skip debate</option>
          <option value="light" ${currentAgg === 'light' ? 'selected' : ''}>Light — top 3 tickers (fast)</option>
          <option value="full"  ${currentAgg === 'full'  ? 'selected' : ''}>Full — up to 8 tickers</option>
        </select>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600">Opposition model <span style="font-weight:400">(for ⚔️ debate)</span></div>
        <select onchange="setOppositionModel(this.value)"
          style="width:100%;font-size:12px;padding:4px 6px;border-radius:5px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary)">
          ${oppModelOptions}
        </select>
      </div>
      <div style="display:flex;align-items:flex-end">
        <p class="text-xs text-muted" style="margin:0;line-height:1.4">
          ⚔️ on each loss row runs an adversarial 3-phase debate between primary and opposition models — only on demand.
          Cloud models (groq:/gemini:) bypass Ollama and use your API key from News settings.
        </p>
      </div>
    </div>

    ${pulledRec.length === 0 ? `
      <div style="background:var(--warn-bg,#fef3c7);border:1px solid var(--warn,#d97706);border-radius:5px;padding:8px 10px;font-size:12px;margin-bottom:8px;color:var(--text-primary)">
        ⚠ No recommended model found. Pull one:
        <code style="background:rgba(0,0,0,.08);padding:1px 4px;border-radius:2px">ollama pull qwen3.5:9b</code>
        (best) · <code style="background:rgba(0,0,0,.08);padding:1px 4px;border-radius:2px">ollama pull qwen3:0.6b</code> (fast)
      </div>` : ''}

    <div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:10px">
      ${currentAgg === 'none'
        ? '⏸ Debate is disabled — no local model calls during analysis.'
        : `Bull/bear debate runs automatically before each portfolio analysis.
           Results are appended to Claude's user message and stored as
           <em>debate_summary</em> in the learning log for later review.
           Does <strong>not</strong> affect prompt-cache hits.`}
    </div>

    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <button id="ll-test-debate-btn" onclick="runTestDebate()"
        style="font-size:11px;padding:4px 12px;border-radius:4px;
               background:var(--bg-secondary);border:1px solid var(--border);
               color:var(--text-primary);cursor:pointer">
        ▶ Test Debate
      </button>
      <span class="text-xs text-muted">Runs a live bull/bear call right now against your first portfolio ticker.</span>
    </div>

    <div id="ll-debate-result" style="display:none;margin-top:12px"></div>`;

}

// ── Live test debate — fires a fresh call and shows result inline ──────────────
async function runTestDebate() {
  const btn = document.getElementById('ll-test-debate-btn');
  const resultEl = document.getElementById('ll-debate-result');
  if (!btn || !resultEl) return;

  if (!state.serverOk) { toast('Backend not running', 'error'); return; }

  const status = await debateStatus();
  if (!status.available) {
    toast('Ollama is not running', 'error');
    return;
  }

  // Pick first portfolio ticker with live signals
  const portfolio = typeof mergedPortfolio === 'function' ? mergedPortfolio() : state.portfolio || [];
  const ticker = portfolio.map(h => h.ticker).find(t => state.liveSignals?.[t] && !state.liveSignals[t].error);
  if (!ticker) {
    toast('No live signals available — run a portfolio analysis first', 'info');
    return;
  }

  const model = typeof preferredDebateModel === 'function'
    ? preferredDebateModel(status.models) : 'qwen3:9b';

  btn.disabled = true;
  btn.textContent = `⏳ Asking ${model}…`;
  resultEl.style.display = 'none';

  const t0 = Date.now();
  try {
    const result = await fetchDebate(ticker, state.liveSignals[ticker] || {}, {
      skipCache: true,
      model,
      timeout: 90,   // per-side; both run in parallel so wall-clock ≈ 90 s max
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (!result?.ok) {
      resultEl.style.display = 'block';
      resultEl.innerHTML = `
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:5px;padding:10px;font-size:12px;color:#dc2626">
          Debate failed: ${result?.error || 'no response'}
        </div>`;
      return;
    }

    resultEl.style.display = 'block';
    resultEl.innerHTML = `
      <div style="border:1px solid var(--border);border-radius:6px;overflow:hidden">
        <div style="background:var(--bg-secondary);padding:6px 10px;font-size:11px;
                    color:var(--text-muted);display:flex;justify-content:space-between">
          <span><strong>${ticker}</strong> · ${model}</span>
          <span>${elapsed}s${result._fromCache ? ' · from cache' : ' · fresh'}</span>
        </div>
        <div style="padding:10px;display:flex;flex-direction:column;gap:8px">
          <div style="font-size:12px">
            <div style="font-size:10px;font-weight:700;color:#16a34a;margin-bottom:3px;letter-spacing:.5px">BULL CASE</div>
            <div style="color:var(--text-primary);line-height:1.5">${result.bull}</div>
          </div>
          <div style="border-top:1px solid var(--border);padding-top:8px;font-size:12px">
            <div style="font-size:10px;font-weight:700;color:#dc2626;margin-bottom:3px;letter-spacing:.5px">BEAR CASE</div>
            <div style="color:var(--text-primary);line-height:1.5">${result.bear}</div>
          </div>
        </div>
      </div>`;
    toast(`✓ Test debate for ${ticker} completed in ${elapsed}s`, 'success');
  } catch (e) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<div style="color:#dc2626;font-size:12px">Error: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Test Debate';
  }
}

function setDebateModel(model) {
  if (!state.debate) state.debate = {};
  state.debate.model = model;
  scheduleSave();
  // Invalidate debate status cache so preferred model re-resolves
  if (typeof clearDebateStatusCache === 'function') clearDebateStatusCache();
  toast(model ? `Debate model set to ${model}` : 'Debate model set to Auto', 'success');
}

function setOppositionModel(model) {
  if (!state.debate) state.debate = {};
  state.debate.oppositionModel = model;
  scheduleSave();
  toast(model ? `Opposition model set to ${model}` : 'Opposition model set to Auto', 'success');
}

function setDebateAggression(level) {
  if (!state.debate) state.debate = {};
  state.debate.aggression = level;
  scheduleSave();
  const labels = { none: 'disabled', light: 'Light (3 tickers)', full: 'Full (8 tickers)' };
  toast(`Debate depth: ${labels[level] || level}`, 'success');
  // Re-render card so the description updates
  renderLearningDebateCard().catch(() => {});
}

async function startOllamaAndRefreshDebateCard() {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  try {
    await fetch(`${API}/api/ollama/start`, { method: 'POST' });
    toast('Ollama start command sent — retrying in 4s…', 'info');
    setTimeout(() => {
      if (typeof clearDebateStatusCache === 'function') clearDebateStatusCache();
      renderLearningDebateCard().catch(() => {});
    }, 4000);
  } catch {
    toast('Could not reach backend', 'error');
  }
}

// ── Scrutinize (auto-tag) a closed learning event using local model post-mortem ──
// Same /api/debate/postmortem endpoint and error_type tagging pipeline as before —
// current session enriched its context with macro data (_flatten_market_context)
// alongside the existing technical entry signals, and relabelled the button/toasts
// from "Auto-tag" to "Scrutinize" for consistency with the pending-rec scrutiny feature.
async function triggerDebatePostmortem(eventId) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  const btn = document.getElementById(`pm-btn-${eventId}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; btn.title = 'Asking local model…'; }

  try {
    const status = await debateStatus();
    if (!status.available) {
      toast('Ollama is not running — start it first', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🔍'; btn.title = 'Scrutinize with local model — technical + macro context'; }
      return;
    }
    const model = typeof preferredDebateModel === 'function'
      ? preferredDebateModel(status.models) : 'qwen3:9b';

    toast(`🔍 Asking ${model} to scrutinize event #${eventId}… (up to 60 s)`, 'info');
    const t0 = Date.now();

    const r = await fetch(`${API}/api/debate/postmortem`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: eventId, model, timeout: 60 }),
      signal:  AbortSignal.timeout(130_000),   // 130 s browser cap (server max 120 s)
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const result = await r.json();

    if (result.ok) {
      const tag = result.error_type !== 'none' ? result.error_type : null;
      if (tag) {
        toast(`🔍 Tagged as "${tag}" in ${elapsed}s — ${(result.reason || '').slice(0, 70)}`, 'success');
        showPage('learning');
      } else {
        toast(`🔍 No clear error found (${elapsed}s) — tag manually if needed`, 'info');
        if (btn) { btn.disabled = false; btn.textContent = '🔍'; btn.title = 'Scrutinize with local model — technical + macro context'; }
      }
    } else {
      const isTimeout = (result.error || '').includes('timeout');
      const hint = isTimeout ? ' Try a smaller model (qwen3:0.6b).' : '';
      toast(`Scrutiny failed (${elapsed}s): ${result.error || 'unknown'}${hint}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🔍'; btn.title = 'Scrutinize with local model — technical + macro context'; }
    }
  } catch (e) {
    toast('Scrutiny error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🔍'; btn.title = 'Scrutinize with local model — technical + macro context'; }
  }
}

// ── Batch: classify ALL untagged loss/breakeven events ───────────────────────
// State lives in window._classifyAllState so it survives renderPage() re-renders.
// _syncClassifyUI() is called after every state change and after every re-render
// so the progress bar re-binds to freshly created DOM elements automatically.
async function classifyAllPostmortems() {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  if (window._classifyAllState?.running) return;  // already running

  // Initial state — shows spinner immediately even before fetch completes
  window._classifyAllState = { running: true, total: 0, done: 0, tagged: 0, noneCount: 0, failed: 0, model: '…' };
  _syncClassifyUI();

  try {
    // 1. Check Ollama
    const status = await debateStatus();
    if (!status.available) {
      toast('Ollama is not running — start it first', 'error');
      window._classifyAllState = null;
      _syncClassifyUI();
      return;
    }
    const model = typeof preferredDebateModel === 'function'
      ? preferredDebateModel(status.models) : 'qwen3:9b';

    // 2. Fetch untagged list
    const listData = await fetch(`${API}/api/learning/untagged?limit=50`).then(r => r.json());
    const events   = listData.events || [];

    if (!events.length) {
      toast('No untagged loss/breakeven events found', 'info');
      window._classifyAllState = null;
      _syncClassifyUI();
      return;
    }

    // Update state with full count and model
    Object.assign(window._classifyAllState, { total: events.length, model });
    _syncClassifyUI();

    // 3. Process sequentially — Ollama is single-threaded
    for (const ev of events) {
      if (!window._classifyAllState) break;  // user dismissed

      try {
        const r = await fetch(`${API}/api/debate/postmortem`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ id: ev.id, model, timeout: 60 }),
          signal:  AbortSignal.timeout(130_000),
        });
        const result = await r.json();
        if (result.ok) {
          if (result.error_type && result.error_type !== 'none')
            window._classifyAllState.tagged++;
          else
            window._classifyAllState.noneCount++;
        } else {
          window._classifyAllState.failed++;
        }
      } catch (_) {
        if (window._classifyAllState) window._classifyAllState.failed++;
      }

      if (window._classifyAllState) {
        window._classifyAllState.done++;
        _syncClassifyUI();
      }
    }

    // 4. Mark done — brief pause so the "Done" state is visible, then reload the table
    if (window._classifyAllState) {
      window._classifyAllState.running = false;
      _syncClassifyUI();
      const s = window._classifyAllState;
      toast(`Batch done: ${s.tagged} tagged, ${s.noneCount} no error, ${s.failed} failed`, 'success');
      setTimeout(() => { window._classifyAllState = null; showPage('learning'); }, 800);
    }

  } catch (e) {
    toast('Batch classify error: ' + e.message, 'error');
    window._classifyAllState = null;
    _syncClassifyUI();
  }
}


// ── Score a closed event's outcome quality (skill vs luck) via local model ────
async function triggerSkillScore(eventId) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  const btn = document.getElementById(`skill-btn-${eventId}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; btn.title = 'Scoring…'; }

  try {
    const status = await debateStatus();
    if (!status.available) {
      toast('Ollama is not running — start it first', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🔬'; btn.title = 'Score outcome quality with local model'; }
      return;
    }
    const model = typeof preferredDebateModel === 'function'
      ? preferredDebateModel(status.models) : 'qwen3:9b';

    toast(`🔬 Asking ${model} to score event #${eventId}…`, 'info');
    const result = await fetchSkillScore(eventId, { model });

    if (result?.ok) {
      const score = result.skill_score;
      const bg    = score >= 7 ? '#dcfce7' : score >= 4 ? '#fef3c7' : '#fee2e2';
      const color = score >= 7 ? '#15803d' : score >= 4 ? '#92400e' : '#991b1b';
      // Update badge span only — button stays in the DOM so the user can re-score
      const badgeEl = document.getElementById(`skill-badge-${eventId}`);
      if (badgeEl) {
        badgeEl.outerHTML = `<span id="skill-badge-${eventId}"
          title="Skill score: ${score}/10 — ${(result.reason||'').slice(0,80)}"
          style="font-size:10px;padding:1px 5px;border-radius:3px;font-weight:600;background:${bg};color:${color}"
        >${score.toFixed(1)}</span>`;
      }
      // Re-enable button and update tooltip to reflect re-score mode
      if (btn) { btn.disabled = false; btn.textContent = '🔬'; btn.title = 'Re-score outcome quality'; }
      toast(`🔬 Skill score: ${score}/10 — ${(result.reason||'').slice(0,60)}`, 'success');
    } else {
      toast(`Skill score failed: ${result?.error || 'no response'}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🔬'; btn.title = 'Score outcome quality with local model'; }
    }
  } catch (e) {
    toast('Skill score error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🔬'; btn.title = 'Score outcome quality with local model'; }
  }
}

// ── Win success tagger ────────────────────────────────────────────────────────
// Triggered by the 🏆 Tag button on WIN rows. Asks local Ollama to classify
// why the trade succeeded using the VALID_WIN_TAGS taxonomy.
async function triggerTagWin(eventId) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  const btn = document.getElementById(`tagwin-btn-${eventId}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  try {
    const status = await debateStatus();
    if (!status.available) {
      toast('Ollama is not running — start it first', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🏆'; }
      return;
    }
    const model = typeof preferredDebateModel === 'function'
      ? preferredDebateModel(status.models) : 'qwen3:9b';

    toast(`🏆 Asking ${model} to tag win #${eventId}…`, 'info');
    const r = await fetch(`${API}/api/debate/tag-win`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: eventId, model }),
    });
    const result = await r.json();

    if (result?.ok) {
      const tags = result.success_tags || 'none';
      toast(`🏆 Win tagged: ${tags} — ${(result.reason||'').slice(0,60)}`, 'success');
      // Refresh the row so chips appear without a full re-render
      renderPage();
    } else {
      toast(`Tag-win failed: ${result?.error || 'no response'}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🏆'; }
    }
  } catch (e) {
    toast('Tag-win error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🏆'; }
  }
}

// ── Adversarial two-model postmortem debate ────────────────────────────────────
// Triggered only by the ⚔️ button — never runs automatically.
// Uses primary model (state.debate.model) vs opposition model (state.debate.oppositionModel).
async function triggerAdversarialPostmortem(eventId) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  const btn = document.getElementById(`adv-btn-${eventId}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; btn.title = 'Debate running…'; }

  const _isCloud = m => m && (m.startsWith('groq:') || m.startsWith('gemini:'));

  try {
    const primaryPref = state.debate?.model || '';
    const oppPref     = state.debate?.oppositionModel || '';
    const bothCloud   = _isCloud(primaryPref) && _isCloud(oppPref);

    let models = [];
    if (!bothCloud) {
      const status = await debateStatus();
      if (!status.available && !_isCloud(primaryPref)) {
        toast('Ollama is not running — start it or pick cloud models (groq:/gemini:)', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '⚔️'; btn.title = 'Adversarial postmortem debate'; }
        return;
      }
      models = status.models || [];
    }

    const modelA  = _isCloud(primaryPref) ? primaryPref
      : (typeof preferredDebateModel === 'function') ? preferredDebateModel(models) : (models[0] || 'qwen3:9b');

    // Opposition model — must differ from primary
    let modelB = oppPref;
    if (!modelB || modelB === modelA) {
      if (_isCloud(modelA)) {
        toast('⚔️ Set an opposition model (different cloud or local) to run the debate.', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '⚔️'; btn.title = 'Adversarial postmortem debate'; }
        return;
      }
      modelB = models.find(m => m !== modelA) || '';
    }
    if (!modelB) {
      toast('⚔️ Debate needs at least 2 models. Pull a second Ollama model or pick a cloud opposition.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '⚔️'; btn.title = 'Adversarial postmortem debate'; }
      return;
    }

    toast(`⚔️ ${modelA} vs ${modelB} — classifying event #${eventId}… (up to 3 min)`, 'info');
    const t0 = Date.now();

    const result = await fetchPostmortemDebate(eventId, modelA, modelB, { timeout: 90, priority: 'HIGH' });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (btn) { btn.disabled = false; btn.textContent = '⚔️'; btn.title = 'Adversarial postmortem debate'; }

    if (!result?.ok) {
      toast(`⚔️ Debate failed (${elapsed}s): ${result?.error || 'no response'}`, 'error');
      return;
    }

    showPostmortemDebateModal(result, eventId);

    const tag = (result.error_type && result.error_type !== 'none') ? result.error_type : null;
    if (tag) {
      toast(`⚔️ ${result.verdict}: "${tag}" in ${elapsed}s`, 'success');
      showPage('learning');
    } else {
      toast(`⚔️ ${result.verdict}: no clear error found (${elapsed}s)`, 'info');
    }
  } catch (e) {
    toast('Debate error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '⚔️'; btn.title = 'Adversarial postmortem debate'; }
  }
}

/**
 * Show a lightweight modal with the full adversarial debate transcript.
 * Creates (or reuses) a #pm-debate-modal overlay div.
 */
function showPostmortemDebateModal(result, eventId) {
  // Remove any existing modal
  const existing = document.getElementById('pm-debate-modal');
  if (existing) existing.remove();

  const d = result.debate || {};
  const p1 = d.phase_1 || {};
  const p3 = d.phase_3;

  const verdictColor = {
    'CONSENSUS':   '#16a34a',
    'PARTIAL':     '#d97706',
    'DIVERGED':    '#dc2626',
    'SINGLETON_A': '#0ea5e9',
    'SINGLETON_B': '#0ea5e9',
  }[result.verdict] || '#6b7280';

  const sourceLabel = {
    'debated-consensus': 'Both models agreed',
    'debated-merged':    'Tags merged from overlap',
    'debated-singleton': result.verdict === 'SINGLETON_A'
      ? `Only ${result.model_a} produced parseable output`
      : `Only ${result.model_b} produced parseable output`,
    'debated-synthesis': `Neutral synthesis by ${result.model_a} reconciled divergent positions`,
    'debated':           `Phase 3 synthesis fallback (synthesis parse failed)`,
    'adjudicated':       'Cloud adjudicator decided (see Phase 4 below)',
  }[result.error_type_source] || '';

  // Helper: format a number with sign + 1 decimal, or em-dash
  const _fnum = (v, dp = 2) => v == null ? '—' : Number(v).toFixed(dp);
  const _fpct = (v, dp = 1) => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(dp) + '%';

  // Trade context block — shows recommendation direction + prices upfront so
  // the user can immediately spot model misreads (e.g. SELL trade tagged with
  // "poor_entry" because model assumed BUY direction).
  // Also flags when stop/target are on the wrong side for the rec direction
  // (e.g. stop below entry for a SELL — stored incorrectly by the AI rec generator).
  const trade = d.trade;
  let stopDistPct = null, targetDistPct = null;
  if (trade?.entry && trade?.stop)   stopDistPct   = ((trade.stop   - trade.entry) / trade.entry) * 100;
  if (trade?.entry && trade?.target) targetDistPct = ((trade.target - trade.entry) / trade.entry) * 100;

  const _isExitAction = rec => rec && (rec.toUpperCase() === 'SELL' || rec.toUpperCase() === 'TRIM');
  // Direction warnings: for SELL/TRIM, stop should be above entry and target below
  const _dirWarn = (distPct, shouldBeAbove) => {
    if (distPct == null) return '';
    const above = distPct > 0;
    const ok = shouldBeAbove ? above : !above;
    return ok ? '' : ` <span style="background:#fef3c7;border:1px solid #fde68a;border-radius:3px;padding:1px 5px;font-size:10px;color:#92400e" title="This price is on the wrong side of entry for the trade direction — it may have been stored incorrectly by the AI rec.">⚠ wrong dir</span>`;
  };

  const isExit = _isExitAction(trade?.recommendation);
  const stopWarn   = trade ? _dirWarn(stopDistPct,   isExit)     : '';  // SELL: stop should be above (+)
  const targetWarn = trade ? _dirWarn(targetDistPct, !isExit)    : '';  // SELL: target should be below (-)

  const tradeBlock = trade ? `
    <div style="background:var(--bg-secondary);border:1px solid var(--border);
                border-radius:6px;padding:10px 14px">
      <div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.5px;margin-bottom:6px">
        TRADE CONTEXT
      </div>
      <div style="font-size:12px;color:var(--text-primary);display:grid;grid-template-columns:auto 1fr;gap:4px 14px">
        <span style="color:var(--text-muted)">Action</span>
        <span><strong>${trade.recommendation || '?'}</strong> ${trade.ticker || ''}${trade.hold_days != null ? ` · held ${trade.hold_days}d` : ''}${trade.regime ? ` · ${trade.regime}` : ''}
          ${isExit ? `<span style="font-size:10px;color:var(--text-muted);margin-left:6px">stop↑ above entry · target↓ below entry</span>` : `<span style="font-size:10px;color:var(--text-muted);margin-left:6px">stop↓ below entry · target↑ above entry</span>`}
        </span>

        <span style="color:var(--text-muted)">Entry</span>
        <span>$${_fnum(trade.entry, 3)}</span>

        <span style="color:var(--text-muted)">Stop</span>
        <span>$${_fnum(trade.stop, 3)}${stopDistPct != null ? ` <span style="color:var(--text-muted)">(${_fpct(stopDistPct)})</span>` : ''}${stopWarn}</span>

        <span style="color:var(--text-muted)">Target</span>
        <span>$${_fnum(trade.target, 3)}${targetDistPct != null ? ` <span style="color:var(--text-muted)">(${_fpct(targetDistPct)})</span>` : ''}${targetWarn}</span>

        <span style="color:var(--text-muted)">P&amp;L · Exit</span>
        <span>
          <span style="color:${trade.pnl_pct > 0 ? '#16a34a' : trade.pnl_pct < 0 ? '#dc2626' : 'var(--text-muted)'};font-weight:600">${_fpct(trade.pnl_pct)}</span>
          ${trade.exit_reason ? ` · <span style="color:var(--text-muted)">${trade.exit_reason}</span>` : ''}
        </span>

        ${trade.rr_ratio != null || trade.ai_confidence != null ? `
        <span style="color:var(--text-muted)">R:R · Conf</span>
        <span>${trade.rr_ratio != null ? trade.rr_ratio.toFixed(1) : '—'} · ${trade.ai_confidence != null ? (trade.ai_confidence * 100).toFixed(0) + '%' : '—'}</span>
        ` : ''}
      </div>
    </div>` : '';

  // Phase 4 (cloud adjudicator) — present only when 🧑‍⚖️ has been run.
  // Shows scores per model + winner + adjudicator reasoning.
  const p4 = d.phase_4;
  const phase4Html = p4 ? (() => {
    const winnerLabel = p4.winner === 'A' ? `Model A (${result.model_a})`
                      : p4.winner === 'B' ? `Model B (${result.model_b})`
                      : 'Neither (both missed something)';
    const winnerColor = p4.winner === 'NEITHER' ? '#d97706'
                      : (p4.winner === 'A' || p4.winner === 'B') ? '#7c3aed' : '#6b7280';
    const _scoreBar = (label, score, color) => {
      if (score == null) return `<div style="font-size:11px;color:var(--text-muted)">${label}: —</div>`;
      const pct = Math.max(0, Math.min(100, score * 10));
      return `
        <div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:3px">
          <span style="width:80px;color:var(--text-primary)">${label}</span>
          <div style="flex:1;background:var(--bg-secondary);border-radius:3px;height:8px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${color}"></div>
          </div>
          <span style="width:36px;text-align:right;font-weight:600">${score.toFixed(1)}/10</span>
        </div>`;
    };
    return `
      <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.5px">
            PHASE 4 — CLOUD ADJUDICATOR
          </div>
          <span style="font-size:10px;color:var(--text-muted);background:var(--bg-secondary);border:1px solid var(--border);padding:1px 6px;border-radius:3px">${p4.provider || '?'}:${p4.model || '?'}</span>
        </div>
        <div style="font-size:12px;color:var(--text-primary);margin-bottom:6px">
          Winner: <strong style="color:${winnerColor}">${winnerLabel}</strong>
          ${p4.final_tags ? ` → final tags: <strong>${p4.final_tags}</strong>` : ''}
        </div>
        ${_scoreBar(result.model_a || 'Model A', p4.score_a, '#16a34a')}
        ${_scoreBar(result.model_b || 'Model B', p4.score_b, '#0ea5e9')}
        ${p4.reason ? `<div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-top:6px">${p4.reason}</div>` : ''}
      </div>`;
  })() : '';

  // Phase 3 — neutral synthesis (replaces old challenge-and-defend round).
  // Shows the synthesis model, its final tags + reasoning, and the raw output.
  const phase3Html = p3 ? `
    <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.5px">
          PHASE 3 — NEUTRAL SYNTHESIS
        </div>
        <span style="font-size:10px;color:var(--text-muted);background:var(--bg-secondary);border:1px solid var(--border);padding:1px 6px;border-radius:3px">${p3.synthesis_model || result.model_a}</span>
      </div>
      <div style="font-size:12px;line-height:1.5;color:var(--text-primary);margin-bottom:6px">
        Final tags: <strong>${p3.final_tags || result.error_type || '—'}</strong>
      </div>
      ${p3.reason ? `<div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:6px">${p3.reason}</div>` : ''}
      ${p3.raw ? `
        <details style="margin-top:6px">
          <summary style="font-size:11px;color:var(--text-muted);cursor:pointer">Raw synthesis output</summary>
          <pre style="margin-top:4px;font-size:11px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;padding:8px;white-space:pre-wrap;word-break:break-word;color:var(--text-primary);max-height:200px;overflow-y:auto">${(p3.raw || '').replace(/</g,'&lt;')}</pre>
        </details>` : ''}
    </div>` : '';

  const modal = document.createElement('div');
  modal.id = 'pm-debate-modal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.5);padding:16px;`;
  modal.innerHTML = `
    <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:10px;
                max-width:600px;width:100%;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="display:flex;align-items:center;justify-content:space-between;
                  padding:14px 18px;border-bottom:1px solid var(--border)">
        <div>
          <span style="font-size:14px;font-weight:700;color:var(--text-primary)">
            ${result._stored ? '📜' : '⚔️'} Adversarial Debate — Event #${eventId}
          </span>
          <span style="margin-left:10px;font-size:11px;font-weight:600;
                       color:${verdictColor};background:${verdictColor}15;
                       border:1px solid ${verdictColor}40;padding:2px 8px;border-radius:4px">
            ${result.verdict}
          </span>
          ${result._stored ? `<span style="margin-left:6px;font-size:10px;color:var(--text-muted);background:var(--bg-secondary);border:1px solid var(--border);padding:2px 6px;border-radius:4px">STORED</span>` : ''}
        </div>
        <button onclick="document.getElementById('pm-debate-modal').remove()"
          style="background:none;border:none;cursor:pointer;font-size:18px;
                 color:var(--text-muted);padding:2px 6px;border-radius:4px;line-height:1"
          onmouseover="this.style.background='var(--bg-secondary)'"
          onmouseout="this.style.background='none'">✕</button>
      </div>

      <div style="padding:16px 18px;display:flex;flex-direction:column;gap:12px">

        ${tradeBlock}

        <!-- Final verdict -->
        <div style="background:${verdictColor}10;border:1px solid ${verdictColor}30;
                    border-radius:6px;padding:10px 14px">
          <div style="font-size:10px;font-weight:700;color:${verdictColor};letter-spacing:.5px;margin-bottom:4px">
            FINAL TAG
          </div>
          <div style="font-size:13px;font-weight:700;color:var(--text-primary)">
            ${result.error_type !== 'none' ? result.error_type : '(none — no clear error)'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${result.reason || ''}</div>
          ${sourceLabel ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-style:italic">${sourceLabel}</div>` : ''}
        </div>

        <!-- Phase 1: Model A -->
        <div style="border:1px solid var(--border);border-radius:6px;padding:10px 14px">
          <div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.5px;margin-bottom:6px">
            PHASE 1 — ${(result.model_a || 'Model A').toUpperCase()}
          </div>
          <div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:3px">
            ${p1.tags_a || '(none)'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);line-height:1.5">${p1.reason_a || ''}</div>
        </div>

        <!-- Phase 1: Model B -->
        <div style="border:1px solid var(--border);border-radius:6px;padding:10px 14px">
          <div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.5px;margin-bottom:6px">
            PHASE 1 — ${(result.model_b || 'Model B').toUpperCase()}
          </div>
          <div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:3px">
            ${p1.tags_b || '(none)'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);line-height:1.5">${p1.reason_b || ''}</div>
        </div>

        ${phase3Html}

        ${phase4Html}

        <!-- Models + timing footer -->
        <div style="font-size:11px;color:var(--text-muted);text-align:right">
          ${result.model_a} vs ${result.model_b} · ${result.elapsed_ms ? (result.elapsed_ms/1000).toFixed(1)+'s' : ''}
        </div>
      </div>
    </div>`;

  // Click outside to close
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  // ESC to close (one-shot listener — removed when modal is dismissed)
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      modal.remove();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
  // Also clean up the keydown listener when the modal is removed by other means
  const observer = new MutationObserver(() => {
    if (!document.body.contains(modal)) {
      document.removeEventListener('keydown', escHandler);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });
  document.body.appendChild(modal);
}

// ── Cloud adjudicator (Gemini / Groq / Claude) — score both models + pick winner
// Triggered by the AI judge button. When multiple providers are configured the
// user gets a compact picker; with only one available it fires immediately.
const _ADJ_BTN_HTML = '&#9878;<span style="font-size:8px;display:block;line-height:1;text-align:center">AI</span>';

function _adjBtnReset(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.innerHTML = _ADJ_BTN_HTML;
  btn.title = 'Cloud adjudicator';
}

async function triggerAdjudication(eventId) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  const btn = document.getElementById(`adj-btn-${eventId}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '&#8987;'; btn.title = 'Adjudicating…'; }

  try {
    const status = await adjudicatorStatus();
    const available = (status.providers || []).filter(p => p.available);

    if (!available.length) {
      toast('No cloud adjudicator configured. Add a Gemini or Groq key in News Scanner → Settings, or a Claude key in Settings → Claude API.', 'error');
      _adjBtnReset(btn);
      return;
    }

    // One provider available — fire directly
    if (available.length === 1) {
      _adjBtnReset(btn);
      return _runAdjudication(eventId, available[0].provider, available[0].model);
    }

    // Multiple available — show compact picker
    _adjBtnReset(btn);
    _showAdjudicatorPicker(eventId, available);
  } catch (e) {
    toast('Adjudicate error: ' + e.message, 'error');
    _adjBtnReset(btn);
  }
}

function _showAdjudicatorPicker(eventId, providers) {
  document.getElementById('_adj-picker')?.remove();

  const ICONS = { claude: '🤖', gemini: '🌟', groq: '⚡' };
  const providerBtns = providers.map(p => `
    <button
      onclick="document.getElementById('_adj-picker').remove();_runAdjudication(${eventId},'${p.provider}','${p.model}')"
      style="display:flex;align-items:center;gap:10px;width:100%;padding:10px 14px;margin-bottom:8px;
             background:var(--bg-secondary);border:1px solid var(--border-color);
             border-radius:var(--radius-md);cursor:pointer;color:var(--text-primary);font-size:13px;text-align:left">
      <span style="font-size:16px">${ICONS[p.provider] || '🔮'}</span>
      <span style="font-weight:600;text-transform:capitalize;min-width:54px">${p.provider}</span>
      <span style="color:var(--text-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.model}</span>
    </button>`).join('');

  const modal = document.createElement('div');
  modal.id = '_adj-picker';
  modal.style.cssText = [
    'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%)',
    'background:var(--bg-card);border:1px solid var(--border-color)',
    'border-radius:var(--radius-md);padding:20px 20px 14px',
    'z-index:9999;min-width:300px;max-width:380px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
  ].join(';');

  modal.innerHTML = `
    <div style="font-weight:600;font-size:14px;margin-bottom:14px;color:var(--text-primary)">
      &#9878; Choose Adjudicator
    </div>
    ${providerBtns}
    <button onclick="document.getElementById('_adj-picker').remove()"
      style="width:100%;padding:7px;background:none;border:1px solid var(--border-color);
             border-radius:var(--radius-sm);cursor:pointer;color:var(--text-muted);font-size:12px;margin-top:2px">
      Cancel
    </button>`;

  // Close on backdrop click
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

async function _runAdjudication(eventId, provider, model) {
  if (!state.serverOk) return;
  const btn = document.getElementById(`adj-btn-${eventId}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '&#8987;'; btn.title = 'Adjudicating…'; }

  try {
    toast(`&#9878; ${provider}:${model} adjudicating event #${eventId}…`, 'info');
    const t0 = Date.now();
    const result = await fetchAdjudication(eventId, provider);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    _adjBtnReset(btn);

    if (!result?.ok) {
      toast(`Adjudicate failed (${elapsed}s): ${result?.error || 'no response'}`, 'error');
      return;
    }

    const w = result.winner === 'NEITHER' ? 'NEITHER' : `Model ${result.winner}`;
    toast(`Adjudicator: ${w} (A=${result.score_a ?? '—'}, B=${result.score_b ?? '—'}) in ${elapsed}s`, 'success');
    clearAdjudicatorStatusCache();
    showPage('learning');
    setTimeout(() => viewStoredDebate(eventId), 100);
  } catch (e) {
    toast('Adjudicate error: ' + e.message, 'error');
    _adjBtnReset(btn);
  }
}

// ── View a stored adversarial debate transcript (no model call) ───────────────
// 📜 button on rows where ai_learning_events.postmortem_debate is non-null.
// Reads from the in-memory cache populated by _renderLearningContent.
function viewStoredDebate(eventId) {
  const ev = _learningEventsById[eventId];
  if (!ev || !ev.postmortem_debate) {
    toast('No stored debate for this event', 'error');
    return;
  }
  let debate;
  try {
    debate = typeof ev.postmortem_debate === 'string'
      ? JSON.parse(ev.postmortem_debate)
      : ev.postmortem_debate;
  } catch (e) {
    toast('Could not parse stored debate JSON', 'error');
    return;
  }
  const p1 = debate.phase_1 || {};
  // Reconstruct a result-shaped object for the modal
  const result = {
    ok:                true,
    id:                eventId,
    error_type:        ev.error_type || debate.final_tags || 'none',
    error_type_source: ev.error_type_source || 'debated',
    verdict:           debate.verdict || '?',
    reason:            '(stored transcript — see per-phase reasoning below)',
    model_a:           p1.model_a || '?',
    model_b:           p1.model_b || '?',
    debate:            debate,
    elapsed_ms:        null,
    _stored:           true,
  };
  showPostmortemDebateModal(result, eventId);
}

// ── Debate stats card — per-pairing agreement breakdown ────────────────────────
async function renderDebateStatsCard() {
  const el = document.getElementById('ll-debate-stats-card');
  if (!el) return;

  let data;
  try {
    const r = await fetch(`${API}/api/learning/debate-stats`);
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }

  if (!data.pairs?.length) return;   // No debates yet — hide card

  // For each pair, compute "agreement rate" = (consensus + partial) / total
  const rows = data.pairs.map(p => {
    const agreement = p.total ? Math.round((p.consensus + p.partial) / p.total * 100) : 0;
    const concedeStr = p.concede_rate != null
      ? `${Math.round(p.concede_rate * 100)}% <span class="text-xs text-muted">(${p.concede_count}/${p.concede_total})</span>`
      : '—';
    return `
      <tr style="border-bottom:1px solid var(--border)">
        <td style="padding:5px 8px;font-weight:600;font-size:11px">${p.model_a}</td>
        <td style="padding:5px 8px;font-weight:600;font-size:11px">${p.model_b}</td>
        <td style="padding:5px 8px;text-align:right">${p.total}</td>
        <td style="padding:5px 8px;text-align:right;color:#16a34a">${p.consensus}</td>
        <td style="padding:5px 8px;text-align:right;color:#d97706">${p.partial}</td>
        <td style="padding:5px 8px;text-align:right;color:#dc2626">${p.diverged}</td>
        <td style="padding:5px 8px;text-align:right;color:#0ea5e9">${p.singleton_a + p.singleton_b}</td>
        <td style="padding:5px 8px;text-align:right;font-weight:600">${agreement}%</td>
        <td style="padding:5px 8px;text-align:right">${concedeStr}</td>
      </tr>`;
  }).join('');

  el.style.display = 'block';
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <div class="card-title" style="margin:0">📊 Debate Stats</div>
      <span class="text-xs text-muted">${data.total_debates} debate${data.total_debates !== 1 ? 's' : ''} · ${data.pairs.length} pairing${data.pairs.length !== 1 ? 's' : ''}</span>
    </div>
    <p class="text-xs text-muted" style="margin-bottom:8px">
      Which model pairings actually disagree (useful) vs always rubber-stamp.
      High <strong>diverged %</strong> with low <strong>concede rate</strong> = healthy adversarial pressure.
    </p>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border);background:var(--bg-secondary)">
            <th style="text-align:left;padding:5px 8px">Model A</th>
            <th style="text-align:left;padding:5px 8px">Model B</th>
            <th style="text-align:right;padding:5px 8px" title="Total debates run between this pair">Total</th>
            <th style="text-align:right;padding:5px 8px" title="Both models agreed on tag set">Cons</th>
            <th style="text-align:right;padding:5px 8px" title="Partial overlap — intersection kept">Part</th>
            <th style="text-align:right;padding:5px 8px" title="Full divergence → Phase 3 challenge round">Div</th>
            <th style="text-align:right;padding:5px 8px" title="Only one model parsed (no debate possible)">Sgl</th>
            <th style="text-align:right;padding:5px 8px" title="(Consensus + Partial) / Total — how often models reached agreement without challenge">Agree%</th>
            <th style="text-align:right;padding:5px 8px" title="When diverged, how often A conceded to B in Phase 3 (high = A is less confident)">A→B</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${data.skipped ? `<p class="text-xs text-muted" style="margin-top:6px">⚠ ${data.skipped} transcript${data.skipped !== 1 ? 's' : ''} could not be parsed (skipped from stats)</p>` : ''}`;
}

// ── Phase 6: Calibration Quality card ────────────────────────────────────────
// Fetches today's cached calib quality result (or shows a Run button).
// Displays traffic-light verdict per confidence band plus the model's
// qualitative tag-clustering summary.
async function renderCalibQualityCard() {
  const el = document.getElementById('ll-calib-quality-card');
  if (!el) return;

  // Traffic-light helpers
  const VERDICT_ICON = {
    likely_noise:    '🟢',
    ambiguous:       '🟡',
    likely_systemic: '🔴',
  };
  const VERDICT_LABEL = {
    likely_noise:    'Likely noise',
    ambiguous:       'Ambiguous',
    likely_systemic: 'Likely systemic',
  };

  async function _fetchAndRender(force = false) {
    el.innerHTML = `<div class="card" style="margin-top:14px;padding:14px">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="loading-dots"><span></span><span></span><span></span></div>
        <span class="text-xs text-muted">${force ? 'Running calibration quality analysis…' : 'Loading calibration quality…'}</span>
      </div>
    </div>`;

    try {
      const regime = (state.currentRegime?.regime || '');
      // On auto-load always request cached data only — Ollama only fires when user clicks Run
      const url = `${API}/api/debate/calib-quality?regime=${encodeURIComponent(regime)}`
                + (force ? '&force=1' : '&cache_only=1');
      const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!r.ok) { el.innerHTML = ''; return; }
      const d = await r.json();
      if (!d.ok || !d.bands?.length) {
        // No cached result — show prompt to run manually
        el.innerHTML = `<div class="card" style="margin-top:14px;padding:14px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span class="text-sm text-muted">Calibration Quality — no results yet</span>
            <button class="btn btn-sm" onclick="window._runCalibQuality && window._runCalibQuality()">▶ Run debate</button>
          </div>
          <p class="text-xs text-muted" style="margin-top:6px">Runs a local Ollama debate to audit confidence band quality. Requires Ollama running.</p>
        </div>`;
        return;
      }
      _renderCard(d);
    } catch {
      el.innerHTML = '';
    }
  }

  function _renderCard(d) {
    const bands = d.bands || [];
    if (!bands.length) { el.innerHTML = ''; return; }

    const cachedNote = d.cached
      ? `<span class="text-xs text-muted" style="margin-left:6px">cached ${d.date}</span>`
      : `<span class="text-xs text-muted" style="margin-left:6px">${d.model} · ${(d.elapsed_ms/1000).toFixed(1)}s</span>`;

    const rows = bands.map(b => {
      const icon  = VERDICT_ICON[b.verdict]  || '⚪';
      const label = VERDICT_LABEL[b.verdict] || b.verdict;
      const wr    = b.actual_wr  != null ? (b.actual_wr  * 100).toFixed(0) + '%' : '—';
      const exp   = b.expected_wr != null ? (b.expected_wr * 100).toFixed(0) + '%' : '—';
      const delta = b.actual_wr != null && b.expected_wr != null
        ? ((b.actual_wr - b.expected_wr) * 100)
        : null;
      const deltaStr = delta != null
        ? `<span style="font-size:10px;color:${delta < -5 ? '#dc2626' : delta > 5 ? '#16a34a' : 'var(--text-muted)'}">${delta >= 0 ? '+' : ''}${delta.toFixed(0)}pp</span>`
        : '';
      const pNoise = b.p_noise != null ? (b.p_noise * 100).toFixed(0) + '%' : '—';
      const analysis = b.analysis
        ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;padding-left:22px">${b.analysis}</div>`
        : '';
      return `
        <div style="padding:6px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:14px" title="${label}">${icon}</span>
            <strong style="font-size:12px;min-width:50px">${b.band}</strong>
            <span class="text-xs text-muted">actual ${wr} vs expected ${exp}</span>
            ${deltaStr}
            <span class="text-xs text-muted" style="margin-left:auto">p_noise=${pNoise} · ESS=${b.ess}</span>
          </div>
          ${analysis}
        </div>`;
    }).join('');

    const suggestedLessonHtml = d.suggested_lesson
      ? `<div style="margin-top:10px;padding:8px 10px;background:var(--bg-secondary);border-radius:6px;border-left:3px solid #f59e0b;display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">
           <div style="flex:1;min-width:0">
             <div style="font-size:11px;font-weight:600;color:#b45309;margin-bottom:2px">Suggested lesson</div>
             <div style="font-size:12px" id="ll-cq-lesson-text">${escapeHTML(d.suggested_lesson)}</div>
           </div>
           <button class="btn btn-sm" style="white-space:nowrap;flex-shrink:0" onclick="window._createCalibLesson()">+ Create lesson</button>
         </div>`
      : '';

    el.innerHTML = `
      <div class="card" style="margin-top:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div class="card-title" style="margin:0">Calibration Quality</div>
          <div style="display:flex;align-items:center;gap:8px">
            ${cachedNote}
            <button class="btn btn-sm" onclick="renderCalibQualityCard._force()" title="Re-run analysis">↺ Refresh</button>
          </div>
        </div>
        <p class="text-xs text-muted" style="margin-bottom:10px">
          🟢 noise · 🟡 ambiguous · 🔴 systemic — verdict is pre-computed from binomial SE; model provides qualitative tag analysis only.
        </p>
        ${rows}
        ${d.summary ? `<div style="margin-top:10px;padding:8px;background:var(--bg-secondary);border-radius:6px;font-size:12px"><strong>Summary:</strong> ${d.summary}</div>` : ''}
        ${suggestedLessonHtml}
      </div>`;

    window._createCalibLesson = async function() {
      const text = document.getElementById('ll-cq-lesson-text')?.textContent?.trim();
      if (!text) return;
      try {
        const r = await fetch(`${API}/api/learning/lessons`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lesson_text: text, source: 'calib_quality' }),
        });
        const data = await r.json();
        if (data.ok) {
          toast('Lesson created from calibration quality analysis', 'success');
          document.querySelector('[onclick="window._createCalibLesson()"]')?.remove();
          renderLessonsCard().catch(() => {});
        } else {
          toast('Failed to create lesson: ' + (data.error || 'unknown'), 'error');
        }
      } catch {
        toast('Network error saving lesson', 'error');
      }
    };
  }

  // Expose force-refresh for the Refresh button and the "Run debate" button on empty state
  renderCalibQualityCard._force = () => _fetchAndRender(true);
  window._runCalibQuality = () => _fetchAndRender(true);

  // Initial load — use cached result if available
  if (!state.serverOk) return;
  await _fetchAndRender(false);
}

// ── Calibration trend card (Learning Loop improvement E) ─────────────────────
// Brier score over time — answers "is the learning loop actually learning"
// instead of only ever showing the latest snapshot. Snapshots are written
// lazily by GET /api/learning/calibration-stats (one row/day); this card is
// pure read via GET /api/learning/calibration-trend.
async function renderCalibrationTrendCard() {
  const el = document.getElementById('ll-calib-trend-card');
  if (!el || !state.serverOk) return;

  let data;
  try {
    const r = await fetch(`${API}/api/learning/calibration-trend`);
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }

  const snapshots = (data.snapshots || []).filter(s => s.brier_score != null);
  if (snapshots.length < 2) return;  // nothing useful to chart yet

  el.style.display = '';
  el.innerHTML = `
    <div class="card section-gap">
      <div class="card-title">Calibration Trend</div>
      <p class="text-xs text-muted mb-1">
        Brier score over time (lower = better calibrated; 0=perfect, 0.25=random).
        One snapshot per day — shows whether the learning loop's nudges/lessons/exemplars
        are actually sharpening confidence over time, not just the latest reading.
      </p>
      <canvas id="ll-calib-trend-canvas" style="width:100%;height:160px;display:block"></canvas>
    </div>`;

  if (typeof drawCalibrationTrendChart === 'function') {
    drawCalibrationTrendChart('ll-calib-trend-canvas', snapshots);
  }
}

// ── Calibration efficacy card ─────────────────────────────────────────────────
// Answers the one question the whole calibration layer never measured: do the
// deterministic confidence nudges actually beat Claude's raw confidence? Compares
// the Brier score of the original vs the post-nudge confidence over closed trades
// the nudge actually touched. If it's "hurting", the adjustment logic is net-
// negative and should be re-tuned or disabled. Pure read via
// GET /api/learning/calibration-efficacy.
async function renderCalibrationEfficacyCard() {
  const el = document.getElementById('ll-calib-efficacy-card');
  if (!el || !state.serverOk) return;

  let d;
  try {
    const r = await fetch(`${API}/api/learning/calibration-efficacy`);
    if (!r.ok) return;
    d = await r.json();
  } catch { return; }

  if (!d.ok || !d.n) return;  // nothing to show until a nudge has closed a trade

  const verdictMeta = {
    helping:        { label: '✓ Nudges are helping',      color: 'var(--up)' },
    hurting:        { label: '⚠ Nudges are hurting',      color: 'var(--down)' },
    neutral:        { label: '≈ Nudges are neutral',      color: 'var(--text-secondary)' },
    insufficient_n: { label: `Gathering data (need n≥${d.min_n})`, color: 'var(--text-muted)' },
  }[d.verdict] || { label: d.verdict, color: 'var(--text-muted)' };

  const impPp = d.improvement != null ? (d.improvement > 0 ? '+' : '') + d.improvement.toFixed(4) : '—';

  el.style.display = '';
  el.innerHTML = `
    <div class="card section-gap">
      <div class="card-title">Calibration Efficacy</div>
      <p class="text-xs text-muted mb-1">
        Does the deterministic confidence nudge actually beat Claude's raw confidence?
        Brier score (lower = better) of original vs post-nudge confidence, over the
        ${d.n} closed trade${d.n === 1 ? '' : 's'} a nudge changed.
      </p>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:baseline">
        <div><span class="text-xs text-muted">Original</span>
             <div style="font-size:18px;font-weight:600">${d.orig_brier ?? '—'}</div></div>
        <div><span class="text-xs text-muted">Adjusted</span>
             <div style="font-size:18px;font-weight:600">${d.adj_brier ?? '—'}</div></div>
        <div><span class="text-xs text-muted">Improvement</span>
             <div style="font-size:18px;font-weight:600;color:${verdictMeta.color}">${impPp}</div></div>
        <div style="align-self:center;color:${verdictMeta.color};font-weight:600">${verdictMeta.label}</div>
      </div>
    </div>`;
}

// ── Trading Lessons card ──────────────────────────────────────────────────────
// Shows all stored lessons with filter inputs. Lessons are distilled from
// adjudicated postmortems (auto) or added manually.
async function renderLessonsCard() {
  const el = document.getElementById('ll-lessons-card');
  if (!el || !state.serverOk) return;

  let data;
  try {
    const r = await fetch(`${API}/api/learning/lessons?limit=50`);
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }

  const lessons = data.lessons || [];

  // Lesson lifecycle scoring (Learning Loop improvement B) — retrospective
  // win-rate-before-vs-after health per lesson, keyed by lesson_id. Best-
  // effort: a failed fetch just means no health chips render, never blocks
  // the lessons table itself.
  let effectivenessById = {};
  try {
    const er = await fetch(`${API}/api/learning/lesson-effectiveness`);
    if (er.ok) {
      const ed = await er.json();
      (ed.lessons || []).forEach(l => { effectivenessById[l.lesson_id] = l; });
    }
  } catch { /* health chips are an enhancement, not required */ }

  const SOURCE_COLORS = { adjudicated: '#6d28d9', manual: '#0891b2' };

  const rows = lessons.map(l => {
    const scope = [l.ticker, l.sector, l.regime].filter(Boolean).join(' / ') || 'General';
    const srcColor = SOURCE_COLORS[l.source] || '#6b7280';
    const eff = effectivenessById[l.id];
    let healthHTML = '<span class="text-xs text-muted">—</span>';
    if (eff) {
      if (eff.insufficient_data) {
        healthHTML = `<span class="text-xs text-muted" title="Needs ≥5 matching trades since creation (n=${eff.n_after})">not enough data yet</span>`;
      } else if (eff.delta_pp != null) {
        const up = eff.delta_pp >= 0;
        const color = up ? 'var(--up,#16a34a)' : 'var(--down,#dc2626)';
        healthHTML = `<span style="font-size:11px;font-weight:600;color:${color}"
          title="Win rate ${eff.win_rate_before ?? '—'}% before → ${eff.win_rate_after}% after (n=${eff.n_before}/${eff.n_after})">
          ${up ? '▲' : '▼'} ${eff.delta_pp >= 0 ? '+' : ''}${eff.delta_pp}pp</span>`;
      }
    }
    return `<tr style="border-bottom:1px solid var(--border);font-size:12px">
      <td style="padding:5px 8px;color:var(--text-muted)">${(l.created_at||'').slice(0,10)}</td>
      <td style="padding:5px 8px;font-weight:600">${escapeHTML(scope)}</td>
      <td style="padding:5px 8px;line-height:1.4">${escapeHTML(l.lesson_text)}</td>
      <td style="padding:5px 8px">
        <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:${srcColor}22;color:${srcColor}">${l.source}</span>
      </td>
      <td style="padding:5px 8px">${healthHTML}</td>
      <td style="padding:5px 8px">
        <button onclick="deleteLesson(${l.id})" title="Delete lesson"
          style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:12px;padding:2px;border-radius:3px"
          onmouseover="this.style.color='#dc2626'" onmouseout="this.style.color='var(--text-muted)'">✕</button>
      </td>
    </tr>`;
  }).join('');

  el.style.display = '';
  el.innerHTML = `
    <div class="flex-between" style="margin-bottom:8px">
      <div class="card-title" style="margin:0">📚 Trading Lessons (${lessons.length})</div>
      <button class="btn btn-sm btn-primary" onclick="showAddLessonModal()">+ Add Lesson</button>
    </div>
    <p class="text-xs text-muted" style="margin-bottom:10px">
      Distilled rules from adjudicated postmortems (auto) and manual entries.
      Injected into every Claude analysis prompt when ticker/sector/regime matches.
    </p>
    ${lessons.length === 0
      ? '<p class="text-xs text-muted">No lessons yet. Run the cloud adjudicator (⚖AI) on a closed trade to auto-generate one, or add manually.</p>'
      : `<div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="color:var(--text-muted);border-bottom:2px solid var(--border);font-size:11px">
                <th style="text-align:left;padding:4px 8px">Date</th>
                <th style="text-align:left;padding:4px 8px">Scope</th>
                <th style="text-align:left;padding:4px 8px">Lesson</th>
                <th style="text-align:left;padding:4px 8px">Source</th>
                <th style="text-align:left;padding:4px 8px" title="Win rate on matching trades before vs after this lesson was created">Health</th>
                <th style="padding:4px 8px"></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`}
    <div id="ll-add-lesson-form" style="display:none;margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary)">
      <div class="text-xs text-muted" style="font-weight:700;margin-bottom:8px">Add Manual Lesson</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <textarea id="ll-lesson-text" rows="2" placeholder="Lesson text (required)…"
          style="padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);font-size:12px;resize:vertical"></textarea>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <input id="ll-lesson-ticker" placeholder="Ticker (opt.)" maxlength="6"
            style="width:90px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);font-size:12px">
          <input id="ll-lesson-sector" placeholder="Sector (opt.)"
            style="flex:1;min-width:100px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);font-size:12px">
          <input id="ll-lesson-regime" placeholder="Regime (opt.)"
            style="flex:1;min-width:100px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);font-size:12px">
        </div>
        <div>
          <div class="text-xs text-muted" style="margin-bottom:3px">Market Breadth Scope</div>
          <select id="ll-lesson-breadth"
            style="padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);font-size:12px;width:100%">
            <option value="">(none — always show)</option>
            <option value="adl_below_0.3">ADL below 0.3 (broad market weak)</option>
            <option value="adl_above_0.7">ADL above 0.7 (broad market strong)</option>
            <option value="high_vol">High volatility (A-VIX &gt; 25%)</option>
            <option value="low_vol">Low volatility (A-VIX &lt; 12%)</option>
            <option value="earnings_season">Earnings season (Feb / Aug)</option>
            <option value="cgt_window">CGT / EOFY window (May – Jun)</option>
          </select>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-primary" onclick="submitManualLesson()">Save</button>
          <button class="btn btn-sm" onclick="document.getElementById('ll-add-lesson-form').style.display='none'">Cancel</button>
        </div>
      </div>
    </div>`;
}

function showAddLessonModal() {
  const f = document.getElementById('ll-add-lesson-form');
  if (f) f.style.display = f.style.display === 'none' ? '' : 'none';
}

async function submitManualLesson() {
  const text         = (document.getElementById('ll-lesson-text')?.value || '').trim();
  const ticker       = (document.getElementById('ll-lesson-ticker')?.value || '').trim().toUpperCase() || null;
  const sector       = (document.getElementById('ll-lesson-sector')?.value || '').trim() || null;
  const regime       = (document.getElementById('ll-lesson-regime')?.value || '').trim() || null;
  const breadthScope = (document.getElementById('ll-lesson-breadth')?.value || '').trim() || null;
  if (!text) { toast('Lesson text is required', 'error'); return; }
  try {
    const r = await fetch(`${API}/api/learning/lessons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lesson_text: text, ticker, sector, regime, source: 'manual', breadth_scope: breadthScope }),
    });
    const d = await r.json();
    if (d.ok) {
      toast('Lesson saved', 'success');
      await renderLessonsCard();
    } else {
      toast('Save failed: ' + (d.error || 'unknown'), 'error');
    }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function deleteLesson(id) {
  if (!confirm('Delete this lesson?')) return;
  try {
    const r = await fetch(`${API}/api/learning/lesson/${id}`, { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) {
      toast('Lesson deleted', 'success');
      await renderLessonsCard();
    } else {
      toast('Delete failed: ' + (d.error || 'unknown'), 'error');
    }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ── Thesis Drift card (Sprint 45) ────────────────────────────────────────────
async function renderThesisDriftCard() {
  const el = document.getElementById('ll-thesis-drift-card');
  if (!el || !state.serverOk) return;

  try {
    const r = await fetch(`${API}/api/learning/thesis-drift`);
    if (!r.ok) { el.innerHTML = ''; return; }
    const d = await r.json();
    if (!d.ok) { el.innerHTML = ''; return; }

    const nManual = d.n_manual ?? 0;
    const nTarget = d.n_target ?? 0;
    const hasData = nManual >= 5 && nTarget >= 5;

    const fmtPct = v => v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '—';
    const fmtColor = v => v == null ? 'var(--text-muted)' : v >= 0 ? '#16a34a' : '#dc2626';

    let summaryHtml;
    if (!hasData) {
      summaryHtml = `<div class="text-xs text-muted" style="padding:6px 0">
        Not enough closed trades yet (need ≥5 in each category — have ${nManual} manual, ${nTarget} target hits).
      </div>`;
    } else {
      const drag = (d.avg_target_pct ?? 0) - (d.avg_manual_pct ?? 0);
      const isWarning = drag > 3;
      const summaryColor = isWarning ? '#d97706' : '#16a34a';
      const summaryText = isWarning
        ? `Early exits underperforming by ${drag.toFixed(1)}pp — consider holding longer`
        : `Early exit performance healthy (gap = ${drag.toFixed(1)}pp)`;
      summaryHtml = `
        <div style="display:flex;gap:12px;margin-bottom:10px">
          <div style="flex:1;padding:10px;background:var(--bg-secondary);border-radius:6px;text-align:center">
            <div style="font-size:20px;font-weight:700;color:${fmtColor(d.avg_manual_pct)}">${fmtPct(d.avg_manual_pct)}</div>
            <div class="text-xs text-muted">Early Exits (manual)</div>
            <div style="font-size:10px;color:var(--text-tertiary)">n = ${nManual}</div>
          </div>
          <div style="flex:1;padding:10px;background:var(--bg-secondary);border-radius:6px;text-align:center">
            <div style="font-size:20px;font-weight:700;color:${fmtColor(d.avg_target_pct)}">${fmtPct(d.avg_target_pct)}</div>
            <div class="text-xs text-muted">Target Hits</div>
            <div style="font-size:10px;color:var(--text-tertiary)">n = ${nTarget}</div>
          </div>
        </div>
        <div style="padding:7px 10px;border-radius:6px;background:${isWarning ? '#fffbeb' : '#f0fdf4'};border:1px solid ${isWarning ? '#fde68a' : '#bbf7d0'};font-size:12px;font-weight:600;color:${summaryColor}">
          ${isWarning ? '⚠' : '✓'} ${summaryText}
        </div>`;
    }

    el.innerHTML = `
      <div class="card" style="margin-top:14px">
        <div class="card-title" style="margin-bottom:10px">Thesis Drift</div>
        <p class="text-xs text-muted" style="margin-bottom:10px">
          Compares avg P&amp;L of manual early exits vs positions held to target. A large gap suggests the anti-churn rules should be stronger.
        </p>
        ${summaryHtml}
      </div>`;
  } catch {
    el.innerHTML = '';
  }
}

// ── Thesis Accuracy Matrix card (Phase 2+3) ──────────────────────────────────
// Shows per-driver × per-verdict breakdown: avg P&L, n, win rate.
// Data comes from GET /api/learning/thesis-matrix.
async function renderThesisMatrixCard() {
  const el = document.getElementById('ll-thesis-matrix-card');
  if (!el || !state.serverOk) return;

  let d;
  try {
    const r = await fetch(`${API}/api/learning/thesis-matrix`);
    if (!r.ok) { el.innerHTML = ''; return; }
    d = await r.json();
    if (!d.ok) { el.innerHTML = ''; return; }
  } catch { el.innerHTML = ''; return; }

  const nTotal  = d.n_total ?? 0;
  const drivers = d.drivers || ['mean_reversion','momentum_breakout','trend_pullback','fundamental_value','macro_tailwind'];
  const verdicts = d.verdicts || ['validated','invalidated','irrelevant'];
  const matrix  = d.matrix || {};
  const insight = d.insight || '';

  if (nTotal === 0) {
    el.innerHTML = `
      <div class="card" style="margin-top:14px">
        <div class="card-title" style="margin-bottom:8px">Thesis Accuracy Matrix</div>
        <p class="text-xs text-muted">No closed thesis-tagged trades yet — builds as you close positions.</p>
      </div>`;
    return;
  }

  const fmtPnl   = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
  const pnlColor = v => v == null ? 'var(--text-tertiary)' : v >= 0 ? 'var(--up)' : 'var(--down)';
  const fmtWr    = v => v == null ? '—' : `${Number(v).toFixed(0)}%`;

  const VERDICT_LABELS = {
    validated:   'Validated ✅',
    invalidated: 'Invalidated ❌',
    irrelevant:  'Irrelevant ➖',
  };
  const DRIVER_LABELS = {
    mean_reversion:   'Mean Reversion',
    momentum_breakout:'Momentum Breakout',
    trend_pullback:   'Trend Pullback',
    fundamental_value:'Fundamental Value',
    macro_tailwind:   'Macro Tailwind',
  };

  const headerCols = verdicts.map(v =>
    `<th data-label="${VERDICT_LABELS[v] || v}" style="text-align:center;font-size:11px;padding:6px 8px;color:var(--text-secondary);font-weight:600">${VERDICT_LABELS[v] || v}</th>`
  ).join('');

  const rows = drivers.map(dr => {
    const cells = verdicts.map(vd => {
      const cell = (matrix[dr] && matrix[dr][vd]) ? matrix[dr][vd] : null;
      const n  = cell?.n ?? 0;
      if (!n) return `<td data-label="${VERDICT_LABELS[vd] || vd}" style="text-align:center;padding:6px 8px;color:var(--text-tertiary);font-size:11px">—</td>`;
      const avgPnl = cell.avg_pnl_pct;
      const wr     = cell.win_rate;
      return `<td data-label="${VERDICT_LABELS[vd] || vd}" style="text-align:center;padding:6px 8px">
        <div style="font-size:13px;font-weight:600;color:${pnlColor(avgPnl)}">${fmtPnl(avgPnl)}</div>
        <div style="font-size:10px;color:var(--text-tertiary)">${fmtWr(wr)} wr · n=${n}</div>
      </td>`;
    }).join('');
    return `<tr>
      <td data-label="Driver" style="padding:6px 8px;font-size:12px;font-weight:600;white-space:nowrap">${DRIVER_LABELS[dr] || dr}</td>
      ${cells}
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="card" style="margin-top:14px">
      <div class="card-title" style="margin-bottom:8px">Thesis Accuracy Matrix <span style="font-size:11px;font-weight:400;color:var(--text-tertiary)">(n=${nTotal} closed)</span></div>
      ${insight ? `<p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px;padding:8px;background:var(--bg-inset);border-radius:6px;border-left:3px solid var(--chart-1, #3b82f6)">${escapeHTML(insight)}</p>` : ''}
      <div style="overflow-x:auto">
        <table class="tbl-stack" style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th style="text-align:left;padding:6px 8px;font-size:11px;color:var(--text-secondary);font-weight:600">Driver</th>
              ${headerCols}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p style="font-size:11px;color:var(--text-tertiary);margin:8px 0 0">
        Cells show avg P&amp;L% · win rate · n. Builds as you close SELL/TRIM recs that were tagged with an entry driver.
      </p>
    </div>`;
}

// ── Execution Alpha card (Sprint 63) ─────────────────────────────────────────
// Actual exits vs the simulated mechanical exit (stop / target / 15-bar
// time-stop) on the same entries. Positive alpha = manual decisions add value.
// Each page visit lazily resolves up to 5 more pending events server-side.
async function renderExecutionAlphaCard() {
  const el = document.getElementById('ll-exec-alpha-card');
  if (!el || !state.serverOk) return;

  try {
    const r = await fetch(`${API}/api/learning/execution-alpha`);
    if (!r.ok) { el.innerHTML = ''; return; }
    const d = await r.json();
    if (!d.ok) { el.innerHTML = ''; return; }

    const fmtPct   = v => v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '—';
    const fmtColor = v => v == null ? 'var(--text-muted)' : v >= 0 ? '#16a34a' : '#dc2626';
    const n = d.n || 0;

    let body;
    if (n < 5) {
      body = `<div class="text-xs text-muted" style="padding:6px 0">
        Not enough resolved trades yet (have ${n}, need ≥5${d.pending
          ? ` — ${d.pending} pending; up to 5 resolve on each visit to this page` : ''}).
      </div>`;
    } else {
      const alpha = d.alpha_pp ?? 0;
      const positive = alpha >= 0;
      const verdictColor = positive ? '#16a34a' : '#d97706';
      const verdictText = positive
        ? `Your exits add ${alpha.toFixed(1)}pp over the mechanical rules (${d.n_beat}/${n} trades beat the rules)`
        : `Mechanical rules outperform your exits by ${Math.abs(alpha).toFixed(1)}pp — consider trusting stops/targets more (${d.n_lag}/${n} trades lagged)`;
      const ex = d.mech_exits || {};
      const exitDist = ['stop', 'target', 'time']
        .filter(k => ex[k]).map(k => `${k}:${ex[k]}`).join(' · ');
      body = `
        <div style="display:flex;gap:12px;margin-bottom:10px">
          <div style="flex:1;padding:10px;background:var(--bg-secondary);border-radius:6px;text-align:center">
            <div style="font-size:20px;font-weight:700;color:${fmtColor(d.avg_actual_pct)}">${fmtPct(d.avg_actual_pct)}</div>
            <div class="text-xs text-muted">Your actual exits</div>
          </div>
          <div style="flex:1;padding:10px;background:var(--bg-secondary);border-radius:6px;text-align:center">
            <div style="font-size:20px;font-weight:700;color:${fmtColor(d.avg_mech_pct)}">${fmtPct(d.avg_mech_pct)}</div>
            <div class="text-xs text-muted">Mechanical exits</div>
          </div>
          <div style="flex:1;padding:10px;background:var(--bg-secondary);border-radius:6px;text-align:center">
            <div style="font-size:20px;font-weight:700;color:${fmtColor(alpha)}">${alpha >= 0 ? '+' : ''}${alpha.toFixed(1)}pp</div>
            <div class="text-xs text-muted">Execution alpha (n=${n})</div>
          </div>
        </div>
        <div style="padding:7px 10px;border-radius:6px;background:${positive ? '#f0fdf4' : '#fffbeb'};border:1px solid ${positive ? '#bbf7d0' : '#fde68a'};font-size:12px;font-weight:600;color:${verdictColor}">
          ${positive ? '✓' : '⚠'} ${verdictText}
        </div>
        ${exitDist ? `<div class="text-xs text-muted" style="margin-top:6px">Mechanical exit mix: ${exitDist}${d.pending ? ` · ${d.pending} pending` : ''}</div>` : ''}`;
    }

    el.innerHTML = `
      <div class="card" style="margin-top:14px">
        <div class="card-title" style="margin-bottom:10px">Execution Alpha</div>
        <p class="text-xs text-muted" style="margin-bottom:10px">
          Re-runs each executed BUY/TOP_UP entry through the mechanical rules (stop hit / target hit /
          15-bar time-stop, stop-first within a bar) and compares with what you actually realised.
        </p>
        ${body}
      </div>`;
  } catch {
    el.innerHTML = '';
  }
}

// ── Entry Signal Factor Analysis card ────────────────────────────────────────
// Shows mean entry-signal values for wins vs losses (empirical IC from real trades).
async function renderFactorWinRatesCard() {
  const el = document.getElementById('ll-factor-winrates-card');
  if (!el) return;
  try {
    const resp = await fetch(`${API}/api/learning/factor-win-rates`);
    if (!resp.ok) { el.style.display = 'none'; return; }
    const d = await resp.json();
    if (!d.ok || !d.factors || !d.factors.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = `
      <div class="card section-gap">
        <div class="card-title">Entry Signal Factor Analysis</div>
        <p class="text-xs text-muted" style="margin-bottom:8px">
          Mean signal value at entry for wins vs losses (executed BUY/TOP_UP only).
          A positive mean_diff means the factor was higher at entry on winners — useful for calibrating scanner thresholds.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
              <th style="text-align:left;padding:4px 8px">Factor</th>
              <th style="text-align:right;padding:4px 8px">n (W/L)</th>
              <th style="text-align:right;padding:4px 8px">Wins mean</th>
              <th style="text-align:right;padding:4px 8px">Losses mean</th>
              <th style="text-align:right;padding:4px 8px">Diff</th>
              <th style="text-align:left;padding:4px 8px">Signal</th>
            </tr>
          </thead>
          <tbody>
            ${d.factors.map(f => {
              const diffColor = Math.abs(f.mean_diff) < 1 ? 'var(--text-muted)' :
                                f.mean_diff > 0 ? '#16a34a' : '#dc2626';
              const diffStr = f.mean_diff >= 0 ? '+' + f.mean_diff.toFixed(3) : f.mean_diff.toFixed(3);
              return `<tr style="border-bottom:1px solid var(--border)">
                <td style="padding:5px 8px;font-family:monospace;font-size:11px">${f.factor}</td>
                <td style="padding:5px 8px;text-align:right;color:var(--text-muted)">${f.n_wins}/${f.n_losses}</td>
                <td style="padding:5px 8px;text-align:right">${f.wins_mean.toFixed(2)}</td>
                <td style="padding:5px 8px;text-align:right">${f.losses_mean.toFixed(2)}</td>
                <td style="padding:5px 8px;text-align:right;font-weight:600;color:${diffColor}">${diffStr}</td>
                <td style="padding:5px 8px;font-size:10px;color:var(--text-muted)">${f.interpretation}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (_) { el.style.display = 'none'; }
}

// ── Decision Tracker shared helpers (Sell + Buy/Top-Up) ──────────────────────
// Both trackers show one row per executed trade with deterministic (non-LLM)
// outcome context pulled straight from ai_learning_events — action badge,
// thesis/verify verdict, exit-timing quality, skill score, MAE/MFE path, and
// an expandable detail row for the rest (sector, regime, price levels,
// secondary factors, urgency, bull/bear case text).
const _DT_ACTION_STYLE = {
  SELL:   { bg: '#fee2e2', fg: '#dc2626' },
  TRIM:   { bg: '#fef3c7', fg: '#b45309' },
  BUY:    { bg: '#dcfce7', fg: '#15803d' },
  TOP_UP: { bg: '#dbeafe', fg: '#1d4ed8' },
};
function _dtActionBadge(action) {
  const s = _DT_ACTION_STYLE[action] || { bg: '#f3f4f6', fg: '#6b7280' };
  return `<span style="padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;background:${s.bg};color:${s.fg}">${escapeHTML(action || '—')}</span>`;
}

// thesis_verdict has 5 states (gotcha #59) — validated/partially_validated/invalidated/reversed/irrelevant.
const _DT_THESIS_STYLE = {
  validated:           { bg: '#dcfce7', fg: '#15803d', icon: '✓' },
  partially_validated: { bg: '#ecfccb', fg: '#4d7c0f', icon: '≈' },
  invalidated:         { bg: '#fee2e2', fg: '#dc2626', icon: '✗' },
  reversed:            { bg: '#fecaca', fg: '#991b1b', icon: '⇄' },
  irrelevant:          { bg: '#f3f4f6', fg: '#6b7280', icon: '—' },
};
function _dtThesisChip(verdict) {
  if (!verdict) return '<span class="text-xs text-muted">—</span>';
  const s = _DT_THESIS_STYLE[verdict] || _DT_THESIS_STYLE.irrelevant;
  return `<span style="padding:2px 6px;border-radius:3px;font-size:11px;font-weight:600;background:${s.bg};color:${s.fg}">${s.icon} ${escapeHTML(verdict.replace(/_/g, ' '))}</span>`;
}

// exit_quality_tag (gotcha #64) — deterministic exit-timing read from RSI/BB%b/MACD at exit.
const _DT_EXIT_Q_STYLE = {
  exit_into_strength:            { bg: '#fef3c7', fg: '#b45309', icon: '⚠', label: 'Cut winner early' },
  exit_after_reversal_confirmed: { bg: '#dcfce7', fg: '#15803d', icon: '✓', label: 'Reversal confirmed' },
  exit_into_weakness:            { bg: '#fee2e2', fg: '#dc2626', icon: '⚠', label: 'Panic-risk exit' },
  exit_neutral:                  { bg: '#f3f4f6', fg: '#6b7280', icon: '—', label: 'Neutral' },
};
function _dtExitQualityChip(tag) {
  if (!tag) return '<span class="text-xs text-muted">—</span>';
  const s = _DT_EXIT_Q_STYLE[tag] || _DT_EXIT_Q_STYLE.exit_neutral;
  return `<span title="${s.label}" style="padding:2px 6px;border-radius:3px;font-size:11px;font-weight:600;background:${s.bg};color:${s.fg}">${s.icon} ${s.label}</span>`;
}

function _dtSkillChip(score) {
  if (score == null) return '<span class="text-xs text-muted">—</span>';
  const v = Number(score);
  const color = v >= 7 ? '#15803d' : v >= 4 ? '#b45309' : '#dc2626';
  return `<span style="font-weight:700;color:${color}" title="Skill score (0-10, thesis_verdict × outcome quadrant)">${v.toFixed(1)}</span>`;
}

function _dtPnlCell(pct) {
  const pnl = pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` : '—';
  const color = pct > 0 ? '#16a34a' : pct < 0 ? '#dc2626' : 'var(--text-muted)';
  return `<span style="color:${color};font-weight:600">${pnl}</span>`;
}

// Expandable detail row content — whichever fields are present on the event.
function _dtDetailHTML(e) {
  const rows = [];
  const push = (label, val) => { if (val != null && val !== '') rows.push(
    `<div style="display:inline-flex;gap:4px;align-items:baseline;margin:2px 20px 2px 0"><span class="text-muted">${label}:</span><strong>${val}</strong></div>`); };
  push('Sector', e.sector ? escapeHTML(e.sector) : null);
  push('Regime (generated)', e.regime || null);
  push('Regime (executed)', e.regime_at_execution || null);
  push('Hold period', e.holding_period_days != null ? `${e.holding_period_days}d` : null);
  push('Entry price', e.actual_entry_price != null ? `$${fmt(e.actual_entry_price)}` : null);
  push('Exit price', e.actual_exit_price != null ? `$${fmt(e.actual_exit_price)}` : null);
  push('MAE / MFE', (e.mae_pct != null || e.mfe_pct != null)
    ? `${e.mae_pct != null ? e.mae_pct.toFixed(1) + '%' : '—'} / ${e.mfe_pct != null ? '+' + e.mfe_pct.toFixed(1) + '%' : '—'}` : null);
  push('Error tag', e.error_type && e.error_type !== 'none' ? escapeHTML(e.error_type.replace(/,/g, ', ')) : null);
  if (e.sell_secondary_factors) push('Secondary factors', escapeHTML(e.sell_secondary_factors.replace(/,/g, ', ')));
  if (e.sell_urgency) push('Urgency', escapeHTML(e.sell_urgency));
  if (e.bull_case) push('Bull case', escapeHTML(e.bull_case));
  if (e.bear_case) push('Bear case', escapeHTML(e.bear_case));
  if (!rows.length) return '<span class="text-xs text-muted">No further detail captured.</span>';
  return `<div style="display:flex;flex-wrap:wrap">${rows.join('')}</div>`;
}

function toggleDtRow(rowId) {
  const row = document.getElementById(rowId);
  const btn = document.getElementById(rowId + '-btn');
  if (!row) return;
  const open = row.style.display !== 'none';
  row.style.display = open ? 'none' : '';
  if (btn) btn.textContent = open ? '▸' : '▾';
}

function _dtFilterBar(prefix, current, options) {
  return options.map(([val, label]) =>
    `<button class="btn btn-sm ${current === val ? 'btn-primary' : ''}" onclick="setDtFilter('${prefix}','${val}')">${label}</button>`
  ).join(' ');
}

let _sellOutcomesFilter = 'all';
let _buyOutcomesFilter  = 'all';
function setDtFilter(prefix, val) {
  if (prefix === 'sell') { _sellOutcomesFilter = val; renderSellOutcomesCard().catch(() => {}); }
  else                   { _buyOutcomesFilter  = val; renderBuyOutcomesCard().catch(() => {}); }
}

// ── Sell Decision Tracker card (Gap 3 + Gap 7) ───────────────────────────────
// Shows executed SELL/TRIM events with sell_primary_driver set, and their
// 30-day price-based outcome verification once enough time has passed.
async function renderSellOutcomesCard() {
  const el = document.getElementById('ll-sell-outcomes-card');
  if (!el || !state.serverOk) return;

  let data;
  try {
    const qs = _sellOutcomesFilter !== 'all' ? `&action=${_sellOutcomesFilter}` : '';
    const r = await fetch(`${API}/api/learning/sell-outcomes?limit=25${qs}${_llWindowParam()}`);
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }

  const events = (data.events || []);
  // Hide only on a genuinely empty history (no filters). With an active date
  // window or action filter, stay visible and show the "no events" note so a
  // vanished card is never mistaken for missing data.
  if (!events.length && _sellOutcomesFilter === 'all' && _llWindowDays() <= 0) { el.style.display = 'none'; return; }
  el.style.display = '';

  const DRIVER_LABEL = {
    target_reached:      'Target Reached',
    thesis_broken:       'Thesis Broken',
    stop_triggered:      'Stop Triggered',
    better_opportunity:  'Better Opportunity',
    position_sizing:     'Position Sizing',
    risk_management:     'Risk Mgmt',
    portfolio_rebalance: 'Rebalance',
    time_stop:           'Time Stop',
    fundamental_change:  'Fundamental Change',
  };

  const VERDICT_STYLE = {
    validated:    { bg: '#dcfce7', fg: '#15803d', icon: '✓' },
    invalidated:  { bg: '#fee2e2', fg: '#dc2626', icon: '✗' },
    inconclusive: { bg: '#f3f4f6', fg: '#6b7280', icon: '—' },
  };

  const rows = events.map(e => {
    const driver = DRIVER_LABEL[e.sell_primary_driver] || e.sell_primary_driver || '—';
    const date   = (e.timestamp || '').slice(0, 10);
    const rowId  = `dt-sell-${e.id}`;

    let verifyCell;
    if (!e.sell_verify_date) {
      verifyCell = `<span style="font-size:11px;color:var(--text-muted)">Pending (≥25d)</span>`;
    } else {
      const vs = VERDICT_STYLE[e.sell_verify_verdict] || VERDICT_STYLE.inconclusive;
      const soldChg = e.sell_verify_sold_chg != null ? `${e.sell_verify_sold_chg > 0 ? '+' : ''}${e.sell_verify_sold_chg.toFixed(1)}%` : '';
      const altChg  = e.sell_verify_alt_chg  != null ? ` | alt ${e.sell_verify_alt_chg > 0 ? '+' : ''}${e.sell_verify_alt_chg.toFixed(1)}%` : '';
      const detail  = soldChg ? `<span style="font-size:10px;color:var(--text-muted);margin-left:4px">sold ${soldChg}${altChg}</span>` : '';
      verifyCell = `<span style="padding:2px 6px;border-radius:3px;font-size:11px;font-weight:600;background:${vs.bg};color:${vs.fg}">${vs.icon} ${e.sell_verify_verdict}</span>${detail}`;
    }

    const altBadge = e.alternative_ticker
      ? `<span style="font-size:10px;padding:1px 5px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:3px;color:#1d4ed8;margin-left:4px">→ ${escapeHTML(e.alternative_ticker)}</span>`
      : '';

    return `<tr style="border-bottom:1px solid var(--border-light);font-size:12px">
      <td style="padding:5px 8px;color:var(--text-muted)">${date}</td>
      <td style="padding:5px 8px;font-weight:600">${escapeHTML(e.ticker || '—')}</td>
      <td style="padding:5px 8px">${_dtActionBadge(e.recommendation)}</td>
      <td style="padding:5px 8px">${driver}${altBadge}</td>
      <td style="padding:5px 8px;white-space:nowrap">${e.holding_period_days != null ? e.holding_period_days + 'd' : '—'}</td>
      <td style="padding:5px 8px;font-size:11px;color:var(--text-muted)">${e.regime || '—'}</td>
      <td style="padding:5px 8px">${_dtPnlCell(e.realized_pnl_pct)}</td>
      <td style="padding:5px 8px">${_dtExitQualityChip(e.exit_quality_tag)}</td>
      <td style="padding:5px 8px">${verifyCell}</td>
      <td style="padding:5px 8px"><button class="btn btn-sm" id="${rowId}-btn" onclick="toggleDtRow('${rowId}')" title="Show more detail">▸</button></td>
    </tr>
    <tr id="${rowId}" style="display:none">
      <td colspan="10" style="background:var(--bg-inset);padding:8px 12px;font-size:12px">${_dtDetailHTML(e)}</td>
    </tr>`;
  }).join('');

  const pending  = events.filter(e => !e.sell_verify_date).length;
  const verified = events.length - pending;
  const nVal     = events.filter(e => e.sell_verify_verdict === 'validated').length;
  const nInval   = events.filter(e => e.sell_verify_verdict === 'invalidated').length;
  const nTrim    = events.filter(e => e.recommendation === 'TRIM').length;

  el.innerHTML = `
    <div class="flex-between" style="margin-bottom:8px">
      <div class="card-title" style="margin:0">📤 Sell Decision Tracker (${events.length})</div>
      <div style="display:flex;gap:4px;align-items:center">
        ${_dtFilterBar('sell', _sellOutcomesFilter, [['all','All'],['SELL','Sell'],['TRIM','Trim']])}
        <button class="btn btn-sm" onclick="refreshSellOutcomes()" title="Re-check outcomes now">↺ Check Now</button>
      </div>
    </div>
    <p class="text-xs text-muted" style="margin-bottom:8px">
      Validates executed SELL/TRIM drivers against price outcome ~30 days post-sell. Includes both full sells and trims (${nTrim} trim${nTrim !== 1 ? 's' : ''} in this view).
      ${verified > 0 ? `<strong>${nVal} validated · ${nInval} invalidated</strong> of ${verified} checked.` : ''}
      ${pending > 0  ? `${pending} pending (need ≥25 days).` : ''}
    </p>
    ${!events.length ? '<p class="text-xs text-muted">No events match this filter.</p>' : `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:2px solid var(--border);font-size:11px">
            <th style="text-align:left;padding:4px 8px">Date</th>
            <th style="text-align:left;padding:4px 8px">Ticker</th>
            <th style="text-align:left;padding:4px 8px">Action</th>
            <th style="text-align:left;padding:4px 8px">Driver</th>
            <th style="text-align:left;padding:4px 8px">Hold</th>
            <th style="text-align:left;padding:4px 8px">Regime</th>
            <th style="text-align:left;padding:4px 8px">P&amp;L</th>
            <th style="text-align:left;padding:4px 8px">Exit Quality</th>
            <th style="text-align:left;padding:4px 8px">30d Verdict</th>
            <th style="text-align:left;padding:4px 8px"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`}`;
}

async function refreshSellOutcomes() {
  const el = document.getElementById('ll-sell-outcomes-card');
  if (!el || !state.serverOk) return;
  try {
    const r = await fetch(`${API}/api/learning/sell-outcomes?limit=25&force=1${_llWindowParam()}`);
    if (!r.ok) return;
    await renderSellOutcomesCard();
    toast('Sell outcomes refreshed', 'success');
  } catch { toast('Error refreshing sell outcomes', 'error'); }
}

// ── One-time rule-warning backfill ────────────────────────────────────────────
// Rows logged before the failed-quant-rule capture shipped have NULL
// rule_warnings_json on their learning event even though the raw warnings survive
// in recHistory/recommendations (_ruleWarnings in extra_json). Reuse the SAME
// classifier the going-forward path uses (_classifyRuleWarnings, analysis.js — no
// duplicated enum, gotcha #92) and patch each event via /api/learning/outcome so
// the efficacy card lights up from existing history. One-shot per session; cheap
// because it only touches recs that actually carry warnings.
async function _backfillRuleWarningsOnce() {
  if (!state.serverOk || state._ruleWarnBackfillDone) return;
  state._ruleWarnBackfillDone = true;   // guard first — never re-run this session
  if (typeof _classifyRuleWarnings !== 'function') return;

  const seen = new Set();
  const candidates = [...(state.recommendations || []), ...(state.recHistory || [])]
    .filter(r => {
      const lid = r._learningId || r.learningId;
      if (!lid || seen.has(lid)) return false;
      if (!(Array.isArray(r._ruleWarnings) && r._ruleWarnings.length)) return false;
      seen.add(lid);
      return true;
    });
  if (!candidates.length) return;

  for (const r of candidates) {
    const rw = _classifyRuleWarnings(r);
    if (!rw.length) continue;
    try {
      await fetch(`${API}/api/learning/outcome`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: r._learningId || r.learningId, rule_warnings_json: JSON.stringify(rw) }),
      });
    } catch (_) { /* non-fatal — best-effort backfill */ }
  }
}

// ── Rule Override Efficacy card ───────────────────────────────────────────────
// Answers "when I overrode a failed quant rule, was I right?" For each rule code,
// the win-rate + REALIZED avg P&L of breached trades that CLOSED, vs the
// whole-book baseline, with a Wilson-CI-gated verdict (too_strict / validated /
// inconclusive) from GET /api/learning/rule-override-efficacy. Still-open
// BUY/TOP_UP overrides carry no realized P&L (only a sale realizes it) — they
// show in a separate "open" count and, in the drill-down, a LIVE mark-to-market
// since entry. Hidden entirely until at least one breached rec has been logged.
let _ruleEffExpanded = {};   // { code: bool } — drill-down open state (persists across re-renders)

// Live price for a ticker from the freshest client-side source (live signals →
// current holding). Returns null when unknown so the drill-down shows "—".
function _ruleEffLivePrice(ticker) {
  if (!ticker) return null;
  const t = ticker.replace(/\.AX$/i, '');
  const sig = state.liveSignals?.[t] || state.liveSignals?.[t + '.AX'];
  if (sig && typeof sig.current_price === 'number' && sig.current_price > 0) return sig.current_price;
  const h = (typeof getPortfolioHolding === 'function') ? getPortfolioHolding(t) : null;
  if (h && typeof h.currentPrice === 'number' && h.currentPrice > 0) return h.currentPrice;
  return null;
}

function toggleRuleEff(code) {
  _ruleEffExpanded[code] = !_ruleEffExpanded[code];
  const row = document.getElementById(`rule-ev-${code}`);
  const btn = document.getElementById(`rule-ev-btn-${code}`);
  if (row) row.style.display = _ruleEffExpanded[code] ? '' : 'none';
  if (btn) btn.textContent = _ruleEffExpanded[code] ? '▾' : '▸';
}

async function renderRuleEfficacyCard() {
  const el = document.getElementById('ll-rule-efficacy-card');
  if (!el || !state.serverOk) return;

  let data;
  try {
    const r = await fetch(`${API}/api/learning/rule-override-efficacy`);
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }

  const rules = (data && data.rules) || [];
  if (!rules.length) { el.style.display = 'none'; return; }
  el.style.display = '';

  const base = data.baseline || {};
  const VS = {
    too_strict:   { bg: '#fef3c7', fg: '#b45309', icon: '⚠', label: 'Too strict?' },
    validated:    { bg: '#dcfce7', fg: '#15803d', icon: '✓', label: 'Rule was right' },
    inconclusive: { bg: '#f3f4f6', fg: '#6b7280', icon: '—', label: 'Insufficient data' },
  };
  const _up = 'var(--up,#15803d)', _down = 'var(--down,#dc2626)';
  const _pnlSpan = (v, prefix = '$') => `<span style="color:${v >= 0 ? _up : _down}">${v >= 0 ? '+' : '-'}${prefix}${fmt(Math.abs(v))}</span>`;

  // Per-event drill-down row. Entry (BUY/TOP_UP) that is still open shows a LIVE
  // unrealized move since its own entry price (realized P&L intentionally blank —
  // only a sale realizes it). Closed rows show realized P&L. Skipped show "—".
  const _evRow = (e) => {
    const isEntry = e.action === 'BUY' || e.action === 'TOP_UP';
    let pnlCell = '<span style="color:var(--text-muted)">—</span>';
    let note = '';
    if (e.state === 'closed' && e.realized_pnl_aud != null) {
      pnlCell = _pnlSpan(e.realized_pnl_aud)
        + (e.realized_pnl_pct != null ? ` <span style="font-size:10px;color:var(--text-muted)">(${e.realized_pnl_pct >= 0 ? '+' : ''}${e.realized_pnl_pct.toFixed(1)}%)</span>` : '');
    } else if (e.state === 'open' && isEntry) {
      const px = _ruleEffLivePrice(e.ticker);
      if (px != null && e.entry_price) {
        const pct = (px / e.entry_price - 1) * 100;
        pnlCell = `<span style="color:var(--text-muted)">unrealized</span> `
          + `<span style="color:${pct >= 0 ? _up : _down};font-weight:600">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`
          + ` <span style="font-size:10px;color:var(--text-muted)">@ $${fmt(px)}</span>`;
      } else {
        pnlCell = '<span style="color:var(--text-muted)">open · live px n/a</span>';
      }
    }
    const stateBadge = {
      closed:  '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:#e0e7ff;color:#3730a3">closed</span>',
      open:    '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:#dcfce7;color:#15803d">open</span>',
      skipped: '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:#f3f4f6;color:#6b7280">skipped</span>',
    }[e.state] || '';
    return `<tr style="font-size:11.5px;border-bottom:1px solid var(--border-light)">
      <td style="padding:3px 8px;color:var(--text-muted)">${(e.timestamp || '').slice(0, 10)}</td>
      <td style="padding:3px 8px;font-weight:600">${escapeHTML(e.ticker || '—')}</td>
      <td style="padding:3px 8px">${typeof actionBadge === 'function' ? actionBadge(e.action) : escapeHTML(e.action || '')}</td>
      <td style="padding:3px 8px">${stateBadge}</td>
      <td style="padding:3px 8px;text-align:right">${e.entry_price != null ? '$' + fmt(e.entry_price) : '—'}</td>
      <td style="padding:3px 8px">${pnlCell}</td>
    </tr>`;
  };

  const rows = rules.map(r => {
    const vs = VS[r.verdict] || VS.inconclusive;
    const wr = r.win_rate != null ? `${r.win_rate.toFixed(0)}%` : '—';
    const ciTxt = Array.isArray(r.wilson_ci) ? ` <span style="font-size:10px;color:var(--text-muted)">CI ${r.wilson_ci[0].toFixed(0)}–${r.wilson_ci[1].toFixed(0)}</span>` : '';
    // Realized avg P&L — from CLOSED trades only. Blank while a rule has no closes.
    const pnl = r.avg_pnl_aud != null ? _pnlSpan(r.avg_pnl_aud) : '<span style="color:var(--text-muted)">—</span>';
    const open = _ruleEffExpanded[r.code];
    const evRows = (r.events || []).map(_evRow).join('');
    return `<tr style="border-bottom:1px solid var(--border-light);font-size:12px">
      <td style="padding:5px 8px"><button id="rule-ev-btn-${r.code}" class="btn btn-sm" style="padding:1px 6px;margin-right:4px" onclick="toggleRuleEff('${r.code}')" title="Show the individual trades in this rule group">${open ? '▾' : '▸'}</button><strong>${escapeHTML(r.label || r.code)}</strong></td>
      <td style="padding:5px 8px;text-align:right" title="Closed (realized) trades that fed the win-rate">${r.closed_n}<span style="font-size:10px;color:var(--text-muted)"> closed</span></td>
      <td style="padding:5px 8px;text-align:right" title="Executed but still open — no realized P&L yet">${r.open_n}<span style="font-size:10px;color:var(--text-muted)"> open</span></td>
      <td style="padding:5px 8px;text-align:right;color:var(--text-muted)">${r.skipped_n}<span style="font-size:10px"> skip</span></td>
      <td style="padding:5px 8px;text-align:right">${wr}${ciTxt}</td>
      <td style="padding:5px 8px;text-align:right">${pnl}</td>
      <td style="padding:5px 8px"><span style="padding:3px 9px;border-radius:4px;font-size:12.5px;font-weight:700;background:${vs.bg};color:${vs.fg};white-space:nowrap;box-shadow:0 0 0 1px ${vs.fg}33 inset">${vs.icon} ${vs.label}</span></td>
    </tr>
    <tr id="rule-ev-${r.code}" style="display:${open ? '' : 'none'}">
      <td colspan="7" style="background:var(--bg-inset);padding:6px 10px">
        <div class="text-xs text-muted" style="margin-bottom:4px">${r.closed_n} closed · ${r.open_n} open · ${r.skipped_n} skipped — realized P&amp;L shown for closed disposals; open entries show live move since entry.</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="color:var(--text-muted);font-size:10px;text-align:left">
            <th style="padding:2px 8px">Date</th><th style="padding:2px 8px">Ticker</th><th style="padding:2px 8px">Action</th><th style="padding:2px 8px">State</th><th style="padding:2px 8px;text-align:right">Entry</th><th style="padding:2px 8px">P&amp;L</th>
          </tr></thead>
          <tbody>${evRows || '<tr><td colspan="6" class="text-xs text-muted" style="padding:4px 8px">No events.</td></tr>'}</tbody>
        </table>
      </td>
    </tr>`;
  }).join('');

  const baseTxt = base.win_rate != null
    ? `Baseline (all closed trades): <strong>${base.win_rate.toFixed(0)}% WR</strong> over ${base.n} trades${base.avg_pnl_aud != null ? `, avg ${base.avg_pnl_aud >= 0 ? '+' : ''}$${fmt(Math.abs(base.avg_pnl_aud))}/trade` : ''}.`
    : 'Baseline win-rate not yet available (need closed executed trades).';

  // Headline strip — decisive verdicts (too_strict/validated) surfaced at a
  // glance, since scanning a table column for the one rule worth acting on
  // buries the signal this card exists to deliver.
  const _tooStrict = rules.filter(r => r.verdict === 'too_strict');
  const _validated  = rules.filter(r => r.verdict === 'validated');
  const _decisiveStrip = (_tooStrict.length || _validated.length) ? `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      ${_tooStrict.map(r => `<span style="padding:4px 10px;border-radius:5px;font-size:12.5px;font-weight:700;background:${VS.too_strict.bg};color:${VS.too_strict.fg};box-shadow:0 0 0 1px ${VS.too_strict.fg}44 inset">⚠ ${escapeHTML(r.label || r.code)} may be too strict</span>`).join('')}
      ${_validated.map(r => `<span style="padding:4px 10px;border-radius:5px;font-size:12.5px;font-weight:700;background:${VS.validated.bg};color:${VS.validated.fg};box-shadow:0 0 0 1px ${VS.validated.fg}44 inset">✓ ${escapeHTML(r.label || r.code)} confirmed right</span>`).join('')}
    </div>` : `<div class="text-xs text-muted" style="margin-bottom:10px">No decisive verdicts yet — every rule is below the ${data.min_n || 12}-closed-trade floor or its CI still spans the baseline.</div>`;

  el.innerHTML = `
    <div class="card">
      <div class="card-title" style="margin-bottom:6px">🧪 Rule Override Efficacy (${rules.length})</div>
      <p class="text-xs text-muted" style="margin-bottom:8px">
        When a deterministic quant/validation rule flagged a rec and you executed it anyway, did it pay off?
        <strong>Win-rate &amp; avg P&amp;L use only CLOSED trades</strong> — an open BUY/TOP_UP carries no realized P&amp;L until the parcel is sold (▸ expand for its live move since entry).
        <strong>Too strict?</strong> = breached trades beat baseline. <strong>Rule was right</strong> = they underperformed.
        Verdicts fire only past ${data.min_n || 12} closed trades with a statistically clear gap. ${baseTxt}
      </p>
      ${_decisiveStrip}
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="color:var(--text-muted);border-bottom:2px solid var(--border);font-size:11px">
              <th style="text-align:left;padding:4px 8px">Rule</th>
              <th style="text-align:right;padding:4px 8px">Closed</th>
              <th style="text-align:right;padding:4px 8px">Open</th>
              <th style="text-align:right;padding:4px 8px">Skipped</th>
              <th style="text-align:right;padding:4px 8px">Win rate</th>
              <th style="text-align:right;padding:4px 8px">Realized P&amp;L</th>
              <th style="text-align:left;padding:4px 8px">Verdict</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Buy/Top-Up Decision Tracker card ──────────────────────────────────────────
// Per-trade complement to the sell tracker for entry decisions. Existing
// BUY/TOP_UP analytics (Thesis Accuracy Matrix, factor-win-rates) are
// aggregate cross-tabs only — this is the first row-level view: entry driver,
// whether the entry thesis held up to exit, skill score, and MAE/MFE path.
async function renderBuyOutcomesCard() {
  const el = document.getElementById('ll-buy-outcomes-card');
  if (!el || !state.serverOk) return;

  let data;
  try {
    const qs = _buyOutcomesFilter !== 'all' ? `&action=${_buyOutcomesFilter}` : '';
    const r = await fetch(`${API}/api/learning/buy-outcomes?limit=25${qs}${_llWindowParam()}`);
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }

  const events = (data.events || []);
  // Stay visible under an active date window / action filter (see sell tracker).
  if (!events.length && _buyOutcomesFilter === 'all' && _llWindowDays() <= 0) { el.style.display = 'none'; return; }
  el.style.display = '';

  const ENTRY_DRIVER_LABEL = {
    mean_reversion:    'Mean Reversion',
    momentum_breakout: 'Momentum Breakout',
    trend_pullback:    'Trend Pullback',
    fundamental_value: 'Fundamental Value',
    macro_tailwind:    'Macro Tailwind',
  };

  const rows = events.map(e => {
    const driver = ENTRY_DRIVER_LABEL[e.primary_entry_driver] || e.primary_entry_driver || '—';
    const date   = (e.timestamp || '').slice(0, 10);
    const rowId  = `dt-buy-${e.id}`;
    const outcomeChip = e.outcome_status
      ? `<span style="font-size:10px;text-transform:capitalize;color:var(--text-muted)">${e.outcome_status}</span>`
      : '<span class="text-xs text-muted">open</span>';

    return `<tr style="border-bottom:1px solid var(--border-light);font-size:12px">
      <td style="padding:5px 8px;color:var(--text-muted)">${date}</td>
      <td style="padding:5px 8px;font-weight:600">${escapeHTML(e.ticker || '—')}</td>
      <td style="padding:5px 8px">${_dtActionBadge(e.recommendation)}</td>
      <td style="padding:5px 8px">${driver}</td>
      <td style="padding:5px 8px;white-space:nowrap">${e.holding_period_days != null ? e.holding_period_days + 'd' : '—'}</td>
      <td style="padding:5px 8px;font-size:11px;color:var(--text-muted)">${e.regime || '—'}</td>
      <td style="padding:5px 8px">${_dtPnlCell(e.realized_pnl_pct)} ${outcomeChip}</td>
      <td style="padding:5px 8px">${_dtThesisChip(e.thesis_verdict)}</td>
      <td style="padding:5px 8px">${_dtExitQualityChip(e.exit_quality_tag)}</td>
      <td style="padding:5px 8px">${_dtSkillChip(e.skill_score)}</td>
      <td style="padding:5px 8px"><button class="btn btn-sm" id="${rowId}-btn" onclick="toggleDtRow('${rowId}')" title="Show more detail">▸</button></td>
    </tr>
    <tr id="${rowId}" style="display:none">
      <td colspan="11" style="background:var(--bg-inset);padding:8px 12px;font-size:12px">${_dtDetailHTML(e)}</td>
    </tr>`;
  }).join('');

  const nTopUp = events.filter(e => e.recommendation === 'TOP_UP').length;
  const withThesis = events.filter(e => e.thesis_verdict).length;
  const nValidated  = events.filter(e => e.thesis_verdict === 'validated' || e.thesis_verdict === 'partially_validated').length;

  el.innerHTML = `
    <div class="flex-between" style="margin-bottom:8px">
      <div class="card-title" style="margin:0">📥 Buy / Top-Up Decision Tracker (${events.length})</div>
      <div style="display:flex;gap:4px;align-items:center">
        ${_dtFilterBar('buy', _buyOutcomesFilter, [['all','All'],['BUY','Buy'],['TOP_UP','Top-Up']])}
        <button class="btn btn-sm" onclick="refreshBuyOutcomes()" title="Re-check outcomes now">↺ Check Now</button>
      </div>
    </div>
    <p class="text-xs text-muted" style="margin-bottom:8px">
      Per-trade entry decisions with skill score, exit-timing quality, and thesis-held-up verdict once a position closes.
      ${nTopUp} top-up${nTopUp !== 1 ? 's' : ''} of ${events.length} shown.
      ${withThesis > 0 ? `Thesis held (fully/partially) on <strong>${nValidated}/${withThesis}</strong> closed trades.` : ''}
    </p>
    ${!events.length ? '<p class="text-xs text-muted">No events match this filter.</p>' : `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:2px solid var(--border);font-size:11px">
            <th style="text-align:left;padding:4px 8px">Date</th>
            <th style="text-align:left;padding:4px 8px">Ticker</th>
            <th style="text-align:left;padding:4px 8px">Action</th>
            <th style="text-align:left;padding:4px 8px">Entry Driver</th>
            <th style="text-align:left;padding:4px 8px">Hold</th>
            <th style="text-align:left;padding:4px 8px">Regime</th>
            <th style="text-align:left;padding:4px 8px">P&amp;L</th>
            <th style="text-align:left;padding:4px 8px">Thesis Held?</th>
            <th style="text-align:left;padding:4px 8px">Exit Quality</th>
            <th style="text-align:left;padding:4px 8px">Skill</th>
            <th style="text-align:left;padding:4px 8px"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`}`;
}

async function refreshBuyOutcomes() {
  const el = document.getElementById('ll-buy-outcomes-card');
  if (!el || !state.serverOk) return;
  try {
    const r = await fetch(`${API}/api/learning/buy-outcomes?limit=25&force=1${_llWindowParam()}`);
    if (!r.ok) return;
    await renderBuyOutcomesCard();
    toast('Buy/top-up outcomes refreshed', 'success');
  } catch { toast('Error refreshing buy outcomes', 'error'); }
}

// ── Toggle a single tag on/off within the multi-tag set ───────────────────────
// Called by each tag button with the full current tag string and the key to toggle.
async function toggleLearningTag(id, currentTagStr, key) {
  const activeTags = new Set(
    (currentTagStr || '').split(',').map(t => t.trim()).filter(Boolean)
  );
  if (activeTags.has(key)) {
    activeTags.delete(key);
  } else {
    activeTags.add(key);
  }
  const newTagStr = [...activeTags].sort().join(',') || null;
  await tagLearningEvent(id, newTagStr);
}

// ── Mark a stop_hit loss as a protective stop (excluded from calibration) ────
// Called from the 🛡? button on stop_hit loss/breakeven rows.
async function markProtectiveStop(id) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  try {
    const resp = await fetch(`${API}/api/learning/outcome`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id, exit_reason: 'protective_stop' }),
    });
    const result = await resp.json();
    if (result.ok) {
      toast('🛡 Marked as protective stop — excluded from confidence calibration', 'success');
      showPage('learning');
    } else {
      toast('Error: ' + (result.error || 'unknown'), 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// ── Tag a learning event with an error type (manual annotation) ───────────────
// errorType: comma-separated string or null (to clear all tags)
// e.g. 'overconfident', 'overconfident,regime_mismatch', null
async function tagLearningEvent(id, errorType) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  const et = errorType || null;  // empty string (toggle-off) → null (clear in DB)
  try {
    const resp = await fetch(`${API}/api/learning/outcome`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id, error_type: et }),
    });
    const result = await resp.json();
    if (result.ok) {
      // Targeted patch: update the cached event + just this row's tag cell,
      // instead of a full showPage('learning') re-render (which resets scroll,
      // collapses open <details>, and aborts in-flight async card loads).
      const ev = _learningEventsById[id];
      if (ev) {
        ev.error_type = et;
        // Manual edits from this UI are no longer an unreviewed auto-tag.
        if (ev.error_type_source === 'auto') ev.error_type_source = 'manual';
      }
      const cell = document.getElementById(`ll-tagcell-${id}`);
      if (cell && ev) {
        cell.innerHTML = _llTagCell(id, ev.error_type, ev.outcome_status, ev.error_type_source);
      }
    } else {
      toast('Tag error: ' + (result.error || 'unknown'), 'error');
    }
  } catch (e) {
    toast('Tag error: ' + e.message, 'error');
  }
}

// ── Gap 6: Tag Accuracy spot-check card ───────────────────────────────────────

async function renderTagAccuracyCard() {
  const el = document.getElementById('ll-tag-accuracy-card');
  if (!el) return;

  let d;
  try {
    const r = await fetch(`${API}/api/learning/tag-accuracy`);
    d = await r.json();
    if (!d.ok) throw new Error(d.error);
  } catch { return; }

  const rate   = d.agree_rate;
  const label  = d.label || 'unreviewed';
  const pct    = rate != null ? Math.round(rate * 100) : null;
  const colour = label === 'good'        ? '#16a34a'
               : label === 'acceptable'  ? '#d97706'
               : label === 'unreliable'  ? '#dc2626'
               : '#6b7280';
  const bg     = label === 'good'        ? '#f0fdf4'
               : label === 'acceptable'  ? '#fffbeb'
               : label === 'unreliable'  ? '#fef2f2'
               : 'var(--bg-secondary)';
  const border = label === 'good'        ? '#bbf7d0'
               : label === 'acceptable'  ? '#fde68a'
               : label === 'unreliable'  ? '#fecaca'
               : 'var(--border)';

  const rateStr = pct != null
    ? `${pct}% agreement (n=${d.n} reviewed)`
    : `No reviews yet (${d.pending_review} auto-tagged events pending)`;

  el.style.display = 'block';
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div class="card-title" style="margin:0">🏷 Auto-Tag Accuracy</div>
      ${rate != null ? `<span style="font-size:11px;color:${colour};background:${bg};border:1px solid ${border};padding:2px 8px;border-radius:4px">${label.charAt(0).toUpperCase()+label.slice(1)} · ${pct}%</span>` : ''}
    </div>
    <p style="font-size:12px;color:var(--text-secondary);margin:0 0 8px">
      ${rateStr}.
      ${label === 'unreliable' ? '<strong style="color:#dc2626"> ⚠ top_err calibration nudge suppressed until ≥60%.</strong>' : ''}
      ${label === 'unreviewed' ? 'Review a batch of 5 to start tracking accuracy.' : ''}
    </p>
    <div style="display:flex;gap:8px;align-items:center">
      <button onclick="loadTagReviewBatch()" id="tag-review-btn"
        style="font-size:11px;padding:4px 12px;border-radius:4px;background:#3b82f6;color:#fff;border:none;cursor:pointer">
        Review Batch (5)
      </button>
      ${d.pending_review > 0 ? `<span style="font-size:11px;color:var(--text-muted)">${d.pending_review} events awaiting review</span>` : '<span style="font-size:11px;color:#16a34a">All reviewed ✓</span>'}
    </div>
    <div id="tag-review-queue" style="margin-top:12px"></div>
  `;
}

async function loadTagReviewBatch() {
  const qel = document.getElementById('tag-review-queue');
  const btn = document.getElementById('tag-review-btn');
  if (!qel) return;
  if (btn) btn.disabled = true;

  let d;
  try {
    const r = await fetch(`${API}/api/learning/tag-reviews?limit=5`);
    d = await r.json();
  } catch (e) {
    if (qel) qel.innerHTML = `<p style="font-size:12px;color:#dc2626">Failed to load: ${e.message}</p>`;
    if (btn) btn.disabled = false;
    return;
  }

  if (!d.events || d.events.length === 0) {
    qel.innerHTML = `<p style="font-size:12px;color:#16a34a">No unreviewed auto-tagged events — all caught up! ✓</p>`;
    if (btn) btn.disabled = false;
    return;
  }

  const ERROR_TAGS = [
    'overconfident','missed_catalyst','regime_mismatch',
    'poor_entry','stop_too_tight','poor_rr','thesis_broken','external_shock','none',
  ];

  qel.innerHTML = d.events.map(ev => `
    <div id="tag-ev-${ev.id}" style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;font-size:12px">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px">
        <strong>${ev.ticker || '?'}</strong>
        <span class="text-muted">${(ev.timestamp || '').slice(0,10)}</span>
      </div>
      <div style="margin-bottom:4px">
        Outcome: <span style="color:${ev.outcome_status==='loss'?'#dc2626':'#d97706'}">${ev.outcome_status}</span>
        · P&L: ${ev.realized_pnl_pct!=null ? (ev.realized_pnl_pct>0?'+':'')+ev.realized_pnl_pct.toFixed(1)+'%' : '—'}
        · Conf: ${ev.ai_confidence!=null ? Math.round(ev.ai_confidence*100)+'%' : '—'}
      </div>
      <div style="margin-bottom:6px;color:var(--text-secondary)">
        🤖 Ollama tagged: <strong>${ev.error_type || '?'}</strong>
      </div>
      ${ev.rationale_summary ? `<div style="margin-bottom:8px;color:var(--text-muted);font-style:italic">"${escapeHTML(ev.rationale_summary.slice(0,120))}…"</div>` : ''}
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <button onclick="submitTagReview(${ev.id},'agree')"
          style="font-size:11px;padding:3px 10px;border-radius:4px;background:#16a34a;color:#fff;border:none;cursor:pointer">
          ✓ Agree
        </button>
        <select id="tag-correct-${ev.id}" style="font-size:11px;padding:2px 4px;border-radius:4px;border:1px solid var(--border);background:var(--bg-secondary)">
          ${ERROR_TAGS.map(t => `<option value="${t}"${t===ev.error_type?' selected':''}>${t}</option>`).join('')}
        </select>
        <button onclick="submitTagReview(${ev.id},'disagree')"
          style="font-size:11px;padding:3px 10px;border-radius:4px;background:#dc2626;color:#fff;border:none;cursor:pointer">
          ✗ Disagree
        </button>
      </div>
    </div>
  `).join('');

  if (btn) btn.disabled = false;
}

async function submitTagReview(eventId, verdict) {
  const correctedEl = document.getElementById(`tag-correct-${eventId}`);
  const corrected   = correctedEl ? correctedEl.value : '';
  if (verdict === 'disagree' && !corrected) {
    toast('Select a corrected tag before disagreeing', 'error');
    return;
  }
  try {
    const r = await fetch(`${API}/api/learning/tag-review`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ event_id: eventId, verdict, corrected_tag: corrected }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error);
    const card = document.getElementById(`tag-ev-${eventId}`);
    if (card) card.innerHTML = `<span style="color:#16a34a;font-size:12px">✓ Reviewed (${verdict}${verdict==='disagree'?' → '+corrected:''})</span>`;
    // Refresh accuracy card after last review in batch
    renderTagAccuracyCard().catch(() => {});
  } catch (e) {
    toast(`Review failed: ${e.message}`, 'error');
  }
}
