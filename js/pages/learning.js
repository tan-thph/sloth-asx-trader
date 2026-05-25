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
}

function _renderLearningContent(d) {
  // Backend fields (flat, win_rate already 0-100)
  const total        = d.total            ?? 0;
  const closed       = d.closed           ?? 0;
  const wins         = d.wins             ?? 0;
  const overallWR    = d.overall_win_rate;                // null or 0-100
  const confBands    = d.conf_bands       || [];
  const regimes      = d.regime_stats     || [];
  const versions     = d.version_stats    || [];
  const events       = d.recent_events    || [];
  const failed       = d.failed_tickers   || [];
  const failPats     = d.failure_patterns || {};

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
  // Tag dropdown — only shown on closed events; empty cell for open/expired
  const CLOSED_STATUSES = new Set(['win', 'loss', 'breakeven']);
  const tagCell = (evId, currentTag, status) => {
    if (!CLOSED_STATUSES.has(status)) return '';  // open/expired — no tag UI
    const opts = [
      ['', '— tag —'],
      ['overconfident',   'Overconfident'],
      ['missed_catalyst', 'Missed catalyst'],
      ['regime_mismatch', 'Regime mismatch'],
      ['poor_entry',      'Poor entry'],
      ['stop_too_tight',  'Stop too tight'],
    ];
    const meta = currentTag ? (errorTypeLabels[currentTag] || { color: '#6b7280' }) : null;
    const borderColor = meta ? meta.color : 'var(--border)';
    return `<select
      data-ll-tag="${evId}"
      onchange="tagLearningEvent(${evId}, this.value || null)"
      style="font-size:10px;padding:2px 4px;border-radius:3px;border:1px solid ${borderColor};
             background:var(--bg-secondary);color:${meta ? meta.color : 'var(--text-muted)'};
             cursor:pointer;max-width:115px;font-weight:${meta ? '600' : '400'}"
    >${opts.map(([v, l]) => `<option value="${v}"${currentTag === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
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
                <th style="text-align:left;padding:4px 6px">Tag</th>
                <th style="padding:4px 6px;width:28px"></th>
              </tr>
            </thead>
            <tbody>
              ${events.map(ev => {
                const pnlPct  = ev.realized_pnl_pct;
                const pnlStr  = pnlPct != null ? (pnlPct >= 0 ? '+' : '') + Number(pnlPct).toFixed(1) + '%' : '—';
                const pnlColor = pnlPct > 0 ? '#16a34a' : pnlPct < 0 ? '#dc2626' : 'var(--text-secondary)';
                const isOpen   = !ev.outcome_status || ev.outcome_status === 'open';
                return `<tr id="ll-row-${ev.id}" style="border-bottom:1px solid var(--border);${isOpen ? 'opacity:0.6' : ''}">
                  <td style="padding:3px 6px;color:var(--text-muted);white-space:nowrap">${(ev.timestamp||'').slice(0,10)}</td>
                  <td style="padding:3px 6px;font-weight:600">${ev.ticker||'—'}</td>
                  <td style="padding:3px 6px">${ev.recommendation||'—'}</td>
                  <td style="padding:3px 6px;text-align:right">${ev.ai_confidence != null ? (ev.ai_confidence*100).toFixed(0)+'%' : '—'}</td>
                  <td style="padding:3px 6px;color:var(--text-muted);font-size:11px">${ev.regime||'—'}</td>
                  <td style="padding:3px 6px">${outcomeChip(ev.outcome_status)}</td>
                  <td style="padding:3px 6px;text-align:right;color:${pnlColor}">${pnlStr}</td>
                  <td style="padding:3px 6px">${tagCell(ev.id, ev.error_type, ev.outcome_status)}</td>
                  <td style="padding:3px 6px;text-align:center">
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

  return summaryCards + calibCard +
    `<div class="grid-2" style="margin-top:14px">${regimeCard}${versionsCard}</div>` +
    failureCard + recentCard + failedCard;
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

// ── Tag a learning event with an error type (manual annotation) ───────────────
// errorType: 'overconfident' | 'missed_catalyst' | 'regime_mismatch' |
//            'poor_entry' | 'stop_too_tight' | null (clear)
async function tagLearningEvent(id, errorType) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  try {
    const resp = await fetch(`${API}/api/learning/outcome`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id, error_type: errorType }),
    });
    const result = await resp.json();
    if (result.ok) {
      // Instant DOM update — change select border/text colour to match tag, no page reload
      const sel = document.querySelector(`select[data-ll-tag="${id}"]`);
      if (sel) {
        const _errorTypeColors = {
          overconfident: '#dc2626', missed_catalyst: '#d97706', regime_mismatch: '#7c3aed',
          poor_entry: '#ea580c', stop_too_tight: '#0891b2',
        };
        const col = errorType ? (_errorTypeColors[errorType] || '#6b7280') : 'var(--border)';
        sel.style.borderColor  = col;
        sel.style.color        = errorType ? col : 'var(--text-muted)';
        sel.style.fontWeight   = errorType ? '600' : '400';
        sel.value              = errorType || '';
      }
      toast(errorType ? `Tagged: ${errorType.replace(/_/g,' ')}` : 'Tag cleared', 'success');
    } else {
      toast('Tag error: ' + (result.error || 'unknown'), 'error');
    }
  } catch (e) {
    toast('Tag error: ' + e.message, 'error');
  }
}
