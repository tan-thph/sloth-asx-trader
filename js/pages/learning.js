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
// Each button toggles independently; auto-tagged buttons show 🤖 prefix + dashed border.
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
      >${isAuto && active ? '🤖 ' : ''}${short}</button>`;
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
      fetch(`${API}/api/learning/stats`),
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
  // Async: load sell decision tracker card (Gap 3 + Gap 7)
  renderSellOutcomesCard().catch(() => {});
  // Async: load thesis drift analytics card (Sprint 45)
  renderThesisDriftCard().catch(() => {});
  // Async: load thesis accuracy matrix card (Phase 2+3)
  renderThesisMatrixCard().catch(() => {});
  // Async: load execution alpha card (Sprint 63)
  renderExecutionAlphaCard().catch(() => {});
  // Async: load tag accuracy card (Gap 6)
  renderTagAccuracyCard().catch(() => {});
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
  const events          = d.recent_events     || [];
  const failed          = d.failed_tickers    || [];
  const failPats        = d.failure_patterns  || {};
  const successPats     = d.success_patterns  || {};
  const debateInsights  = d.debate_insights   || [];
  const insufficientData  = d.insufficient_data ?? (closed < 10);
  const promptRegression  = d.prompt_regression  || null;  // Gap 5
  const phase8            = d.phase8             || null;  // Gap 2
  const nVirtualResolved  = d.n_virtual_resolved ?? 0;     // virtual outcomes resolved via OHLC scan

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
    <div id="ll-calib-trend-card" style="display:none"></div>`;

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
  const WIN_TAG_META = {
    // Technical / timing drivers
    catalyst_capture:          { label: 'Catalyst Capture',       color: '#3b82f6', tip: 'Trade captured a planned earnings/news/dividend event' },
    regime_aligned:            { label: 'Regime Aligned',         color: '#8b5cf6', tip: 'Entry timing matched the active macro regime' },
    confluence_entry:          { label: 'Confluence Entry',       color: '#0891b2', tip: 'Multiple independent technical indicators aligned at entry' },
    disciplined_hold:          { label: 'Disciplined Hold',       color: '#059669', tip: 'Held through normal volatility; original thesis validated' },
    good_sizing:               { label: 'Good Sizing',            color: '#d97706', tip: 'Position size was well-calibrated for conviction and risk' },
    // Fundamental / macro drivers
    fundamental_value_entry:   { label: 'Value Entry',            color: '#16a34a', tip: 'Entered at cheap valuation — fwdPE/PB below sector; strong FCF yield' },
    earnings_revision_driven:  { label: 'Earnings Revision',      color: '#0369a1', tip: 'Win driven by beat/miss trend or analyst upgrade momentum' },
    macro_tailwind_aligned:    { label: 'Macro Tailwind',         color: '#7c3aed', tip: 'Commodity, rate, or AUD/USD move directly supported the sector thesis' },
    contrarian_mean_reversion: { label: 'Contrarian Reversion',   color: '#be185d', tip: 'Oversold quality stock recovered as expected — value + patience' },
  };
  const successTypes = Object.entries(successPats.by_success_type || {})
    .sort((a, b) => b[1] - a[1]);
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

  const recentCard = `
    <div class="card section-gap">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div class="card-title" style="margin:0">Recent Events (${events.length})</div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="text-xs text-muted">Tag failures on closed trades · ✕ removes outliers from calibration</span>
          <button class="btn btn-sm" id="classify-all-btn"
            onclick="classifyAllPostmortems()"
            title="Run postmortem on every untagged loss/breakeven event using the current local model"
            style="white-space:nowrap">🤖 Classify All Untagged</button>
        </div>
      </div>
      <div id="classify-all-progress" style="display:none;margin-bottom:8px;padding:8px 10px;background:var(--bg-secondary);border-radius:5px;font-size:12px"></div>
      ${events.length ? `
        <div style="overflow-x:auto">
          <table class="tbl-stack" style="width:100%;border-collapse:collapse;font-size:12px;min-width:620px">
            <thead>
              <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
                <th style="text-align:left;padding:4px 6px">Date</th>
                <th style="text-align:left;padding:4px 6px">Ticker</th>
                <th style="text-align:left;padding:4px 6px">Action</th>
                <th style="text-align:right;padding:4px 6px">Conf</th>
                <th style="text-align:left;padding:4px 6px">Regime</th>
                <th style="text-align:left;padding:4px 6px">Outcome</th>
                <th style="text-align:right;padding:4px 6px">P&amp;L%</th>
                <th style="text-align:left;padding:4px 6px" title="Loss/Breakeven only · OC=Overconfident · MC=Missed catalyst · RM=Regime mismatch · PE=Poor entry · ST=Stop too tight · PR=Poor R:R · ES=External shock · TB=Thesis broken · Multiple tags allowed — click to toggle, 🤖 = auto-tagged">Error tags ℹ</th>
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
                // 🏆 success tags — show chips for wins; show Tag Win button when untagged
                const successTags = (ev.success_tags || '').split(',').map(t=>t.trim()).filter(Boolean);
                const WIN_TAG_COLORS = {
                  catalyst_capture: '#3b82f6', regime_aligned: '#8b5cf6',
                  confluence_entry: '#0891b2', disciplined_hold: '#059669',
                  good_sizing: '#d97706', none: '#6b7280',
                };
                const successTagsEl = ev.outcome_status === 'win'
                  ? (successTags.length && successTags[0] !== 'none'
                      ? successTags.map(t => `<span title="${t}" style="font-size:9px;padding:1px 4px;border-radius:3px;font-weight:600;background:${(WIN_TAG_COLORS[t]||'#3b82f6')}22;color:${WIN_TAG_COLORS[t]||'#3b82f6'};margin-right:2px">${t.replace(/_/g,' ')}</span>`).join('')
                      : '')
                  : '';

                // 🤖 post-mortem — always show for loss/breakeven so re-runs are possible
                const showPm = TAG_STATUSES.has(ev.outcome_status);
                const pmTitle = ev.error_type
                  ? 'Re-run auto-tag (will overwrite existing tag)'
                  : 'Auto-tag with local model (Ollama)';
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
                const _virtEffectiveWt = ev.virtual_speed_weight
                  ? (0.75 * ev.virtual_speed_weight).toFixed(2) : '0.75';
                const virtualChip = (!ev.was_executed && ev.virtual_outcome && ev.virtual_outcome !== 'virtual_open')
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

                return `<tr id="ll-row-${ev.id}" style="border-bottom:1px solid var(--border);${isOpen ? 'opacity:0.6' : ''}">
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
                            ev.success_tags ? 'Re-tag winning trade' : 'Tag win: identify why this trade succeeded',
                            '&#127942;', 'Tag', ';color:var(--text-secondary)')
                        : (showPm
                            ? _iconBtn(`pm-btn-${ev.id}`, `triggerDebatePostmortem(${ev.id})`, pmTitle, '🤖', 'PM')
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
        <button class="btn btn-sm btn-primary" onclick="generatePostmortemDigest()"
          id="digest-btn">Generate Digest</button>
      </div>
      <p class="text-xs text-muted">
        Claude analyses your recent losses and failure patterns to extract actionable lessons.
        Each result is saved automatically.
      </p>
      <div id="digest-result" style="display:none;margin-top:10px"></div>
      ${digestHistoryHtml}
    </div>`;

  // ── Trading Lessons card (async — filled by renderLessonsCard()) ─────────────
  const lessonsPlaceholder = `<div id="ll-lessons-card" class="card section-gap" style="min-height:60px"></div>`;

  // ── Sell Decision Tracker card (async — filled by renderSellOutcomesCard()) ──
  const sellOutcomesPlaceholder = `<div id="ll-sell-outcomes-card" class="card section-gap" style="min-height:60px"></div>`;

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

  return introNote + summaryCards + regressionBanner + phase8Note + calibCard + calibQualityPlaceholder +
    `<div class="grid-2" style="margin-top:14px">${regimeCard}${versionsCard}</div>` +
    failureCard + successCard + recentCard + failedCard + debateInsightsCard +
    digestCard + lessonsPlaceholder + sellOutcomesPlaceholder + thesisDriftPlaceholder +
    thesisMatrixPlaceholder + execAlphaPlaceholder + debateCollapsible;
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

    const failures = d.recent_failures || [];
    const wr = d.overall_total > 0 ? Math.round(d.overall_wins / d.overall_total * 100) : null;
    const errorParts = (d.error_dist || []).map(e => `${e.error_type}: ${e.n}`).join(', ');
    const exitParts  = (d.exit_dist  || []).map(e => `${e.exit_reason}: ${e.n}`).join(', ');
    const regimeParts = (d.regime_stats || [])
      .map(r => `${r.regime} ${r.win_rate != null ? r.win_rate + '% win' : ''}/${r.total} trades`)
      .join('; ');

    const failureSummary = failures.slice(0, 10).map(f =>
      `- ${f.ticker} (${f.recommendation}, ${f.regime||'?'} regime, conf ${f.ai_confidence != null ? Math.round(f.ai_confidence*100)+'%' : '?'}): ` +
      `${f.outcome_status}, exit=${f.exit_reason||'?'}, PnL=${f.realized_pnl_pct != null ? f.realized_pnl_pct.toFixed(1)+'%' : '?'}` +
      (f.error_type ? `, tags=${f.error_type}` : '') +
      (f.trade_thesis ? `, thesis="${f.trade_thesis.slice(0, 60)}"` : '')
    ).join('\n');

    const prompt =
`You are reviewing my ASX trading learning loop. Here is a summary of my recent performance:

Overall win rate: ${wr != null ? wr + '%' : 'unknown'} (${d.overall_total} closed trades)
Error type distribution: ${errorParts || 'none tagged'}
Exit reason distribution: ${exitParts || 'none recorded'}
Regime performance: ${regimeParts || 'no data'}

Recent losses/breakevens (up to 10):
${failureSummary || 'No recent failures to analyse.'}

Please write a concise postmortem digest (under 250 words) in plain text. Structure it as:
1. The 1-2 most recurring failure patterns you see
2. One or two specific adjustments I should make (rules, filters, or process changes)
3. The regime(s) where performance is weakest and what that suggests

Be direct, specific, and actionable. No generic advice.`;

    const text = await callClaude('assistant', prompt, { maxTokens: 600, noCache: true });
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
  } catch (e) {
    out.innerHTML = `<div class="text-sm text-danger" style="padding:8px">${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Digest';
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

// ── Auto-tag a closed learning event using local model post-mortem ─────────────
async function triggerDebatePostmortem(eventId) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  const btn = document.getElementById(`pm-btn-${eventId}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; btn.title = 'Asking local model…'; }

  try {
    const status = await debateStatus();
    if (!status.available) {
      toast('Ollama is not running — start it first', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🤖'; btn.title = 'Auto-tag with local model (Ollama)'; }
      return;
    }
    const model = typeof preferredDebateModel === 'function'
      ? preferredDebateModel(status.models) : 'qwen3:9b';

    toast(`🤖 Asking ${model} for post-mortem on event #${eventId}… (up to 60 s)`, 'info');
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
        toast(`🤖 Tagged as "${tag}" in ${elapsed}s — ${(result.reason || '').slice(0, 70)}`, 'success');
        showPage('learning');
      } else {
        toast(`🤖 No clear error found (${elapsed}s) — tag manually if needed`, 'info');
        if (btn) { btn.disabled = false; btn.textContent = '🤖'; btn.title = 'Auto-tag with local model (Ollama)'; }
      }
    } else {
      const isTimeout = (result.error || '').includes('timeout');
      const hint = isTimeout ? ' Try a smaller model (qwen3:0.6b).' : '';
      toast(`Post-mortem failed (${elapsed}s): ${result.error || 'unknown'}${hint}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🤖'; btn.title = 'Auto-tag with local model (Ollama)'; }
    }
  } catch (e) {
    toast('Post-mortem error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🤖'; btn.title = 'Auto-tag with local model (Ollama)'; }
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

  const WIN_TAG_COLORS = {
    catalyst_capture: '#3b82f6', regime_aligned: '#8b5cf6',
    confluence_entry: '#0891b2', disciplined_hold: '#059669',
    good_sizing: '#d97706',
  };
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

// ── Sell Decision Tracker card (Gap 3 + Gap 7) ───────────────────────────────
// Shows executed SELL/TRIM events with sell_primary_driver set, and their
// 30-day price-based outcome verification once enough time has passed.
async function renderSellOutcomesCard() {
  const el = document.getElementById('ll-sell-outcomes-card');
  if (!el || !state.serverOk) return;

  let data;
  try {
    const r = await fetch(`${API}/api/learning/sell-outcomes?limit=20`);
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }

  const events = (data.events || []);
  if (!events.length) { el.style.display = 'none'; return; }

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
    const pnl    = e.realized_pnl_pct != null ? `${e.realized_pnl_pct > 0 ? '+' : ''}${e.realized_pnl_pct.toFixed(1)}%` : '—';
    const pnlColor = e.realized_pnl_pct > 0 ? '#16a34a' : e.realized_pnl_pct < 0 ? '#dc2626' : 'var(--text-muted)';

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
      <td style="padding:5px 8px">${driver}${altBadge}</td>
      <td style="padding:5px 8px;color:${pnlColor};font-weight:600">${pnl}</td>
      <td style="padding:5px 8px">${verifyCell}</td>
    </tr>`;
  }).join('');

  const pending  = events.filter(e => !e.sell_verify_date).length;
  const verified = events.length - pending;
  const nVal     = events.filter(e => e.sell_verify_verdict === 'validated').length;
  const nInval   = events.filter(e => e.sell_verify_verdict === 'invalidated').length;

  el.innerHTML = `
    <div class="flex-between" style="margin-bottom:8px">
      <div class="card-title" style="margin:0">📤 Sell Decision Tracker (${events.length})</div>
      <button class="btn btn-sm" onclick="refreshSellOutcomes()" title="Re-check outcomes now">↺ Check Now</button>
    </div>
    <p class="text-xs text-muted" style="margin-bottom:8px">
      Validates executed SELL/TRIM drivers against price outcome ~30 days post-sell.
      ${verified > 0 ? `<strong>${nVal} validated · ${nInval} invalidated</strong> of ${verified} checked.` : ''}
      ${pending > 0  ? `${pending} pending (need ≥25 days).` : ''}
    </p>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:2px solid var(--border);font-size:11px">
            <th style="text-align:left;padding:4px 8px">Date</th>
            <th style="text-align:left;padding:4px 8px">Ticker</th>
            <th style="text-align:left;padding:4px 8px">Driver</th>
            <th style="text-align:left;padding:4px 8px">P&amp;L</th>
            <th style="text-align:left;padding:4px 8px">30d Verdict</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function refreshSellOutcomes() {
  const el = document.getElementById('ll-sell-outcomes-card');
  if (!el || !state.serverOk) return;
  try {
    const r = await fetch(`${API}/api/learning/sell-outcomes?limit=20&force=1`);
    if (!r.ok) return;
    await renderSellOutcomesCard();
    toast('Sell outcomes refreshed', 'success');
  } catch { toast('Error refreshing sell outcomes', 'error'); }
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
