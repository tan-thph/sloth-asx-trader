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
  try {
    const resp = await fetch(`${API}/api/learning/stats`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
    if (data.error) throw new Error(data.error);
  } catch (e) {
    if (state._renderGen !== gen) return;
    el.innerHTML = `<div class="card"><div class="text-muted text-sm" style="padding:12px">
      ⚠️ Could not load Learning Loop stats: ${e.message}<br>
      <span class="text-xs">Make sure the backend server is running and has processed at least one AI call.</span>
    </div></div>`;
    return;
  }
  if (state._renderGen !== gen) return;

  el.innerHTML = _renderLearningContent(data);

  // Async: load debate engine status without blocking the main render
  if (typeof debateStatus === 'function') {
    renderLearningDebateCard().catch(() => {});
  }
  // Async: load debate stats card (per-pairing agreement breakdown)
  renderDebateStatsCard().catch(() => {});
}

function _renderLearningContent(d) {
  // Backend fields (flat, win_rate already 0-100)
  const total        = d.total            ?? 0;
  const closed       = d.closed           ?? 0;
  const wins         = d.wins             ?? 0;
  const overallWR    = d.overall_win_rate;                // null or 0-100
  const confBands       = d.conf_bands        || [];
  const regimes         = d.regime_stats      || [];
  const versions        = d.version_stats     || [];
  const events          = d.recent_events     || [];
  const failed          = d.failed_tickers    || [];
  const failPats        = d.failure_patterns  || {};
  const debateInsights  = d.debate_insights   || [];
  const insufficientData = d.insufficient_data ?? (closed < 10);

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
    </div>`;

  // ── Calibration table ──────────────────────────────────────────────────────
  const calibCard = `
    <div class="card section-gap">
      <div class="card-title">Confidence Calibration</div>
      ${insufficientData ? `
      <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:5px;padding:8px 10px;font-size:12px;margin-bottom:8px;display:flex;gap:8px;align-items:flex-start">
        <span style="font-size:16px;line-height:1">⚠️</span>
        <div>
          <strong>Not enough data yet (${closed} closed trade${closed !== 1 ? 's' : ''})</strong> — calibration signals are unreliable below 10 closed trades.
          Keep running analyses and marking trade outcomes; patterns will emerge naturally.
        </div>
      </div>` : ''}
      <p class="text-xs text-muted mb-1">
        Predicted confidence vs actual win rate per band. ⚠ = fewer than 5 samples — treat cautiously.
        Calibration notes are injected into Claude when n≥3 and |delta|>5pp.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Confidence Band</th>
            <th style="text-align:right;padding:4px 8px">Trades</th>
            <th style="text-align:right;padding:4px 8px">Wins</th>
            <th style="text-align:right;padding:4px 8px">Win Rate</th>
            <th style="text-align:left;padding:4px 8px;width:120px">vs Expected</th>
          </tr>
        </thead>
        <tbody>
          ${confBands.length ? confBands.map(b => {
            const midpoint = parseFloat(b.band) + 5;  // e.g. "70-80%" → 75
            const delta = b.win_rate != null ? b.win_rate - midpoint : null;
            const deltaStr = delta != null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}pp` : '';
            const dimStyle = b.total < 5 ? 'opacity:0.65' : '';
            return `
            <tr style="border-bottom:1px solid var(--border);${dimStyle}">
              <td style="padding:5px 8px">${b.band}${sampleBadge(b.total)}</td>
              <td style="padding:5px 8px;text-align:right">${b.total}</td>
              <td style="padding:5px 8px;text-align:right">${b.wins}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(b.win_rate)}">${pct(b.win_rate)}</td>
              <td style="padding:5px 8px">
                <div style="display:flex;align-items:center;gap:6px">
                  <div style="background:var(--bg-secondary);border-radius:3px;height:8px;width:80px;flex-shrink:0">
                    <div style="background:${rateColor(b.win_rate)};border-radius:3px;height:8px;width:${b.win_rate != null ? Math.min(80, Math.round(b.win_rate * 0.8)) : 0}px"></div>
                  </div>
                  ${delta != null ? `<span style="font-size:10px;color:${delta < -5 ? '#dc2626' : delta > 5 ? '#16a34a' : 'var(--text-muted)'}">${deltaStr}</span>` : ''}
                </div>
              </td>
            </tr>`;
          }).join('') : '<tr><td colspan="5" style="padding:8px;color:var(--text-muted)">No closed events yet.</td></tr>'}
        </tbody>
      </table>
    </div>`;

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
          </tr>
        </thead>
        <tbody>
          ${regimes.length ? regimes.map(r => `
            <tr style="border-bottom:1px solid var(--border);${r.total < 5 ? 'opacity:0.65' : ''}">
              <td style="padding:5px 8px">${r.regime || 'unknown'}${sampleBadge(r.total)}</td>
              <td style="padding:5px 8px;text-align:right">${r.total}</td>
              <td style="padding:5px 8px;text-align:right">${r.wins}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(r.win_rate)}">${pct(r.win_rate)}</td>
            </tr>`).join('') : '<tr><td colspan="4" style="padding:8px;color:var(--text-muted)">No regime data yet.</td></tr>'}
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
          </tr>
        </thead>
        <tbody>
          ${versions.length ? versions.map(v => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 8px;font-family:monospace;font-size:11px">${v.version}</td>
              <td style="padding:5px 8px;text-align:right">${v.total_calls}</td>
              <td style="padding:5px 8px;text-align:right">${v.closed}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(v.win_rate)}">${v.closed < 3 ? '<span title="Limited data" style="color:#d97706">—</span>' : pct(v.win_rate)}</td>
            </tr>`).join('') : '<tr><td colspan="4" style="padding:8px;color:var(--text-muted)">No prompt version data yet.</td></tr>'}
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

  // ── Recent events ──────────────────────────────────────────────────────────
  const outcomeChip = o => {
    const map = { win:'#16a34a', loss:'#dc2626', breakeven:'#9ca3af', open:'#3b82f6', expired:'#6b7280', invalidated:'#d97706', skipped:'#6b7280' };
    const col = map[o] || '#9ca3af';
    return `<span style="background:${col}20;color:${col};border-radius:3px;padding:1px 6px;font-size:10px;font-weight:600">${o || 'open'}</span>`;
  };
  // Tag buttons — LOSS and BREAKEVEN only; wins don't get error tags (errors on wins = luck, not failure).
  // Multiple tags supported — stored as comma-separated string ("overconfident,regime_mismatch").
  // Each button toggles independently; auto-tagged buttons show 🤖 prefix + dashed border.
  const TAG_STATUSES    = new Set(['loss', 'breakeven']);
  const CLOSED_STATUSES = new Set(['win', 'loss', 'breakeven']); // kept for postmortem compat

  const tagButtons = (evId, currentTagStr, tagSource) => {
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
        const meta    = errorTypeLabels[key] || { color: '#6b7280' };
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
  };

  // tagCell: error tags only for loss/breakeven; open/win/expired get nothing
  const tagCell = (evId, currentTagStr, status, tagSource) => {
    if (!TAG_STATUSES.has(status)) return '';
    return tagButtons(evId, currentTagStr, tagSource);
  };

  const recentCard = `
    <div class="card section-gap">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div class="card-title" style="margin:0">Recent Events (${events.length})</div>
        <span class="text-xs text-muted">Tag failures on closed trades · ✕ removes outliers from calibration</span>
      </div>
      ${events.length ? `
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:620px">
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
                <th style="text-align:center;padding:4px 6px" title="Skill score (0–10): analysis quality vs luck. Sk = trigger Ollama scoring">🔬 Sk</th>
                <th style="padding:4px 6px;width:28px"></th>
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
                // 🤖 post-mortem — always show for loss/breakeven so re-runs are possible
                const showPm = TAG_STATUSES.has(ev.outcome_status);
                const pmTitle = ev.error_type
                  ? 'Re-run auto-tag (will overwrite existing tag)'
                  : 'Auto-tag with local model (Ollama)';
                // 🔬 skill score — badge (if scored) + button always shown for closed trades
                // Badge and button are separate elements so the button survives after scoring.
                const skillScore = ev.skill_score;
                const skillBadgeEl = skillScore != null
                  ? `<span id="skill-badge-${ev.id}"
                       title="Skill score: ${skillScore}/10 — how much outcome reflects analysis quality vs luck"
                       style="font-size:10px;padding:1px 5px;border-radius:3px;font-weight:600;
                              background:${skillScore>=7?'#dcfce7':skillScore>=4?'#fef3c7':'#fee2e2'};
                              color:${skillScore>=7?'#15803d':skillScore>=4?'#92400e':'#991b1b'}"
                     >${skillScore.toFixed(1)}</span>`
                  : `<span id="skill-badge-${ev.id}"></span>`;
                const skillBtnEl = isClosed
                  ? `<button id="skill-btn-${ev.id}"
                       onclick="triggerSkillScore(${ev.id})"
                       title="${skillScore != null ? 'Re-score outcome quality' : 'Score outcome quality (skill vs luck)'}"
                       style="background:none;border:none;cursor:pointer;font-size:11px;padding:2px 3px;border-radius:3px;line-height:1.2;color:var(--text-muted)"
                       onmouseover="this.style.background='var(--bg-secondary)'"
                       onmouseout="this.style.background='none'"
                     >🔬<span style="font-size:8px;display:block;line-height:1;text-align:center">Sk</span></button>`
                  : '';
                const skillBadge = skillBadgeEl + skillBtnEl;
                return `<tr id="ll-row-${ev.id}" style="border-bottom:1px solid var(--border);${isOpen ? 'opacity:0.6' : ''}">
                  <td style="padding:3px 6px;color:var(--text-muted);white-space:nowrap">${(ev.timestamp||'').slice(0,10)}</td>
                  <td style="padding:3px 6px;font-weight:600">${ev.ticker||'—'}</td>
                  <td style="padding:3px 6px">${ev.recommendation||'—'}</td>
                  <td style="padding:3px 6px;text-align:right">${ev.ai_confidence != null ? (ev.ai_confidence*100).toFixed(0)+'%' : '—'}</td>
                  <td style="padding:3px 6px;color:var(--text-muted);font-size:11px">${ev.regime||'—'}</td>
                  <td style="padding:3px 6px;white-space:nowrap">${outcomeChip(ev.outcome_status)}${protectiveEl}</td>
                  <td style="padding:3px 6px;text-align:right;color:${pnlColor}">${pnlStr}</td>
                  <td style="padding:3px 6px">${tagCell(ev.id, ev.error_type, ev.outcome_status, ev.error_type_source)}</td>
                  <td style="padding:3px 6px;text-align:center">${skillBadge}</td>
                  <td style="padding:3px 6px;text-align:center;white-space:nowrap">
                    ${showPm ? `<button id="pm-btn-${ev.id}"
                      onclick="triggerDebatePostmortem(${ev.id})"
                      title="${pmTitle}"
                      style="background:none;border:none;cursor:pointer;font-size:11px;padding:2px 3px;border-radius:3px;line-height:1.2"
                      onmouseover="this.style.background='var(--bg-secondary)'"
                      onmouseout="this.style.background='none'"
                    >🤖<span style="font-size:8px;display:block;line-height:1;text-align:center">PM</span></button>` : ''}
                    ${showPm ? `<button id="adv-btn-${ev.id}"
                      onclick="triggerAdversarialPostmortem(${ev.id})"
                      title="${ev.postmortem_debate ? 'Re-run adversarial debate (will overwrite stored transcript)' : 'Adversarial debate: two models classify independently, then argue to a conclusion'}"
                      style="background:none;border:none;cursor:pointer;font-size:11px;padding:2px 3px;border-radius:3px;line-height:1.2"
                      onmouseover="this.style.background='var(--bg-secondary)'"
                      onmouseout="this.style.background='none'"
                    >&#9876;<span style="font-size:8px;display:block;line-height:1;text-align:center">vs</span></button>` : ''}
                    ${ev.postmortem_debate ? `<button
                      onclick="viewStoredDebate(${ev.id})"
                      title="View stored debate transcript (no model call)"
                      style="background:none;border:none;cursor:pointer;font-size:11px;padding:2px 3px;border-radius:3px;line-height:1.2"
                      onmouseover="this.style.background='var(--bg-secondary)'"
                      onmouseout="this.style.background='none'"
                    >&#128220;<span style="font-size:8px;display:block;line-height:1;text-align:center">Tr</span></button>` : ''}
                    ${ev.postmortem_debate ? `<button id="adj-btn-${ev.id}"
                      onclick="triggerAdjudication(${ev.id})"
                      title="Cloud adjudicator — score both models 0-10 and pick a winner (uses configured Gemini/Groq key)"
                      style="background:none;border:none;cursor:pointer;font-size:11px;padding:2px 3px;border-radius:3px;line-height:1.2"
                      onmouseover="this.style.background='var(--bg-secondary)'"
                      onmouseout="this.style.background='none'"
                    >&#9878;<span style="font-size:8px;display:block;line-height:1;text-align:center">AI</span></button>` : ''}
                    <button
                      onclick="deleteLearningEvent(${ev.id})"
                      title="Remove event"
                      style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:12px;padding:2px;border-radius:3px;line-height:1"
                      onmouseover="this.style.color='#dc2626'"
                      onmouseout="this.style.color='var(--text-muted)'"
                    >✕</button>
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
    <div id="ll-debate-card" class="card section-gap" style="display:none"></div>`;

  // ── Debate Stats card (per-pairing agreement metrics) ──────────────────────────
  // Rendered async — see renderDebateStatsCard()
  const debateStatsPlaceholder = `
    <div id="ll-debate-stats-card" class="card section-gap" style="display:none"></div>`;

  return summaryCards + calibCard +
    `<div class="grid-2" style="margin-top:14px">${regimeCard}${versionsCard}</div>` +
    failureCard + recentCard + failedCard + debateInsightsCard +
    debateStatsPlaceholder + debateCardPlaceholder;
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

  // Model <select> options — "Auto" + all pulled models
  const modelOptions = ['', ...models].map(m => {
    const label = m === '' ? `Auto (${typeof preferredDebateModel === 'function' ? preferredDebateModel(models) : models[0] || '?'})` : m;
    return `<option value="${m}" ${currentModel === m ? 'selected' : ''}>${label}</option>`;
  }).join('');

  // Opposition model options — "Auto (pick different)" + all pulled models
  const oppModelOptions = ['', ...models].map(m => {
    const label = m === '' ? 'Auto (pick different model)' : m;
    return `<option value="${m}" ${currentOppModel === m ? 'selected' : ''}>${label}</option>`;
  }).join('');

  el.style.display = 'block';
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div class="card-title" style="margin:0">🤖 Local Debate Engine</div>
      <span style="font-size:11px;color:#16a34a;background:#f0fdf4;border:1px solid #bbf7d0;padding:2px 8px;border-radius:4px">● Online · ${models.length} model${models.length !== 1 ? 's' : ''} pulled</span>
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
        </p>
      </div>
    </div>

    ${pulledRec.length === 0 ? `
      <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:5px;padding:8px 10px;font-size:12px;margin-bottom:8px">
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

// ── Adversarial two-model postmortem debate ────────────────────────────────────
// Triggered only by the ⚔️ button — never runs automatically.
// Uses primary model (state.debate.model) vs opposition model (state.debate.oppositionModel).
async function triggerAdversarialPostmortem(eventId) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  const btn = document.getElementById(`adv-btn-${eventId}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; btn.title = 'Debate running…'; }

  try {
    const status = await debateStatus();
    if (!status.available) {
      toast('Ollama is not running — start it first', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '⚔️'; btn.title = 'Adversarial postmortem debate'; }
      return;
    }

    const models  = status.models || [];
    const modelA  = (typeof preferredDebateModel === 'function')
      ? preferredDebateModel(models) : (models[0] || 'qwen3:9b');

    // Opposition model — must differ from primary; fall back to second model in list
    let modelB = state.debate?.oppositionModel || '';
    if (!modelB || modelB === modelA) {
      modelB = models.find(m => m !== modelA) || '';
    }
    if (!modelB) {
      toast('⚔️ Debate needs at least 2 pulled models. Pull a second model (e.g. gemma3:4b).', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '⚔️'; btn.title = 'Adversarial postmortem debate'; }
      return;
    }

    toast(`⚔️ ${modelA} vs ${modelB} — classifying event #${eventId}… (up to 3 min)`, 'info');
    const t0 = Date.now();

    const result = await fetchPostmortemDebate(eventId, modelA, modelB, { timeout: 90 });
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
    'debated':           p3?.maintains
      ? `${result.model_a} held its ground in challenge round`
      : `${result.model_a} conceded to ${result.model_b}`,
    'adjudicated':       'Cloud adjudicator decided (see Phase 4 below)',
  }[result.error_type_source] || '';

  // Helper: format a number with sign + 1 decimal, or em-dash
  const _fnum = (v, dp = 2) => v == null ? '—' : Number(v).toFixed(dp);
  const _fpct = (v, dp = 1) => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(dp) + '%';

  // Fix #4: Trade context block — shows recommendation direction + prices
  // upfront so the user can immediately spot model misreads (e.g. SELL trade
  // tagged with "poor_entry" because model assumed BUY direction).
  // Gracefully omitted for older stored debates that pre-date the trade field.
  const trade = d.trade;
  let stopDistPct = null, targetDistPct = null;
  if (trade?.entry && trade?.stop)   stopDistPct   = ((trade.stop   - trade.entry) / trade.entry) * 100;
  if (trade?.entry && trade?.target) targetDistPct = ((trade.target - trade.entry) / trade.entry) * 100;

  const tradeBlock = trade ? `
    <div style="background:var(--bg-secondary);border:1px solid var(--border);
                border-radius:6px;padding:10px 14px">
      <div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.5px;margin-bottom:6px">
        TRADE CONTEXT
      </div>
      <div style="font-size:12px;color:var(--text-primary);display:grid;grid-template-columns:auto 1fr;gap:4px 14px">
        <span style="color:var(--text-muted)">Action</span>
        <span><strong>${trade.recommendation || '?'}</strong> ${trade.ticker || ''}${trade.hold_days != null ? ` · held ${trade.hold_days}d` : ''}${trade.regime ? ` · ${trade.regime}` : ''}</span>

        <span style="color:var(--text-muted)">Entry</span>
        <span>$${_fnum(trade.entry, 3)}</span>

        <span style="color:var(--text-muted)">Stop</span>
        <span>$${_fnum(trade.stop, 3)}${stopDistPct != null ? ` <span style="color:var(--text-muted)">(${_fpct(stopDistPct)})</span>` : ''}</span>

        <span style="color:var(--text-muted)">Target</span>
        <span>$${_fnum(trade.target, 3)}${targetDistPct != null ? ` <span style="color:var(--text-muted)">(${_fpct(targetDistPct)})</span>` : ''}</span>

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

  // Fix #3: show raw Phase 3 response so user can see whether the challenger
  // actually rebutted with numbers or just restated. Also flag auto-concede
  // (triggered when maintain=true but the rebuttal contains no digits).
  const phase3Html = p3 ? `
    <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
      <div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.5px;margin-bottom:6px">
        PHASE 3 — CHALLENGE ROUND (${result.model_a})
      </div>
      <div style="font-size:12px;line-height:1.5;color:var(--text-primary);margin-bottom:6px">
        ${p3.maintains
          ? `<span style="color:#16a34a;font-weight:600">Maintained</span> → final: <strong>${p3.final_tags || result.error_type}</strong>`
          : `<span style="color:#dc2626;font-weight:600">Conceded</span> to ${result.model_b} → final: <strong>${p3.final_tags || result.error_type}</strong>`
        }
        ${p3.auto_concede_reason ? `<span style="font-size:10px;margin-left:8px;color:#d97706;background:#fef3c7;border:1px solid #fde68a;padding:1px 6px;border-radius:3px" title="The maintain response contained no numeric rebuttal — auto-concede was applied">auto-concede: ${p3.auto_concede_reason}</span>` : ''}
      </div>
      ${p3.raw ? `
        <details style="margin-top:6px">
          <summary style="font-size:11px;color:var(--text-muted);cursor:pointer">Raw rebuttal text</summary>
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

// ── Cloud adjudicator (Gemini / Groq) — score both models + pick winner ───────
// Triggered by the AI judge button. Reads stored debate transcript, sends it
// to a configured cloud model, scores Phase 1 reasoning 0-10 per model and
// picks a winner. The result is appended as phase_4 in the transcript and
// (if winner is A or B) overwrites error_type with error_type_source='adjudicated'.
async function triggerAdjudication(eventId) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  const btn = document.getElementById(`adj-btn-${eventId}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '&#8987;'; btn.title = 'Adjudicating…'; }

  try {
    // Check provider availability first so we can give a useful error
    const status = await adjudicatorStatus();
    if (!status.available) {
      toast('No cloud adjudicator configured. Set a Gemini or Groq API key in News Scanner → Settings.', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = '&#9878;<span style="font-size:8px;display:block;line-height:1;text-align:center">AI</span>'; btn.title = 'Cloud adjudicator'; }
      return;
    }

    toast(`&#9878; ${status.provider}:${status.model} adjudicating event #${eventId}…`, 'info');
    const t0 = Date.now();
    const result = await fetchAdjudication(eventId);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (btn) { btn.disabled = false; btn.innerHTML = '&#9878;<span style="font-size:8px;display:block;line-height:1;text-align:center">AI</span>'; btn.title = 'Cloud adjudicator'; }

    if (!result?.ok) {
      toast(`Adjudicate failed (${elapsed}s): ${result?.error || 'no response'}`, 'error');
      return;
    }

    const w = result.winner === 'NEITHER' ? 'NEITHER' : `Model ${result.winner}`;
    toast(`Adjudicator: ${w} (A=${result.score_a ?? '—'}, B=${result.score_b ?? '—'}) in ${elapsed}s`, 'success');

    // Re-render the page so the cache (_learningEventsById) is refreshed with
    // the new transcript, THEN open the modal so it shows phase_4.
    showPage('learning');
    // Small delay to let render complete before opening modal
    setTimeout(() => viewStoredDebate(eventId), 100);
  } catch (e) {
    toast('Adjudicate error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '&#9878;<span style="font-size:8px;display:block;line-height:1;text-align:center">AI</span>'; btn.title = 'Cloud adjudicator'; }
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
      // Re-render learning page so button active state reflects new tag correctly
      showPage('learning');
    } else {
      toast('Tag error: ' + (result.error || 'unknown'), 'error');
    }
  } catch (e) {
    toast('Tag error: ' + e.message, 'error');
  }
}
