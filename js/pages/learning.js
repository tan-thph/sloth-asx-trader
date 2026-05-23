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
  const total        = d.total           ?? 0;
  const closed       = d.closed          ?? 0;
  const wins         = d.wins            ?? 0;
  const overallWR    = d.overall_win_rate;               // null or 0-100
  const confBands    = d.conf_bands      || [];
  const regimes      = d.regime_stats    || [];
  const versions     = d.version_stats   || [];
  const events       = d.recent_events   || [];
  const failed       = d.failed_tickers  || [];

  // Helpers
  const fmt = (v, dp = 1) => v == null ? '—' : Number(v).toFixed(dp);
  // win_rate from backend is 0-100; display as "x%"
  const pct = (v) => v == null ? '—' : Number(v).toFixed(0) + '%';
  // Colour thresholds are also 0-100
  const rateColor = r => r == null ? 'var(--text-secondary)' : r >= 60 ? '#16a34a' : r >= 45 ? '#d97706' : '#dc2626';

  // Derive a few summary stats from conf_bands for high-conf win rate
  const hcBands = confBands.filter(b => {
    const lo = parseFloat(b.band); // e.g. "70-80%" → 70
    return !isNaN(lo) && lo >= 70;
  });
  const hcTotal = hcBands.reduce((s, b) => s + (b.total || 0), 0);
  const hcWins  = hcBands.reduce((s, b) => s + (b.wins  || 0), 0);
  const hcWR    = hcTotal > 0 ? (hcWins / hcTotal * 100) : null;

  // Current active prompt version
  const latestVer = versions.length ? versions[0].version : null;
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
        <div class="metric-sub">Confidence ≥ 70% · ${hcTotal} trades</div>
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
      <p class="text-xs text-muted mb-1">Predicted confidence vs actual win rate by band. Ideal: each band's win rate ≈ its confidence level.</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Confidence Band</th>
            <th style="text-align:right;padding:4px 8px">Trades</th>
            <th style="text-align:right;padding:4px 8px">Wins</th>
            <th style="text-align:right;padding:4px 8px">Win Rate</th>
            <th style="text-align:left;padding:4px 8px;width:120px">Bar</th>
          </tr>
        </thead>
        <tbody>
          ${confBands.length ? confBands.map(b => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 8px">${b.band}</td>
              <td style="padding:5px 8px;text-align:right">${b.total}</td>
              <td style="padding:5px 8px;text-align:right">${b.wins}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(b.win_rate)}">${pct(b.win_rate)}</td>
              <td style="padding:5px 8px">
                <div style="background:var(--bg-secondary);border-radius:3px;height:8px;width:100px">
                  <div style="background:${rateColor(b.win_rate)};border-radius:3px;height:8px;width:${b.win_rate != null ? Math.min(100, Math.round(b.win_rate)) : 0}px"></div>
                </div>
              </td>
            </tr>`).join('') : '<tr><td colspan="5" style="padding:8px;color:var(--text-muted)">No closed events yet.</td></tr>'}
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
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 8px">${r.regime || 'unknown'}</td>
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
              <td style="padding:5px 8px;font-family:monospace">${v.version}</td>
              <td style="padding:5px 8px;text-align:right">${v.total_calls}</td>
              <td style="padding:5px 8px;text-align:right">${v.closed}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(v.win_rate)}">${pct(v.win_rate)}</td>
            </tr>`).join('') : '<tr><td colspan="4" style="padding:8px;color:var(--text-muted)">No prompt version data yet.</td></tr>'}
        </tbody>
      </table>
    </div>`;

  // ── Recent events ──────────────────────────────────────────────────────────
  const outcomeChip = o => {
    const map = { win:'#16a34a', loss:'#dc2626', breakeven:'#9ca3af', open:'#3b82f6', invalidated:'#d97706', skipped:'#6b7280' };
    const col = map[o] || '#9ca3af';
    return `<span style="background:${col}20;color:${col};border-radius:3px;padding:1px 6px;font-size:10px;font-weight:600">${o || 'open'}</span>`;
  };
  const recentCard = `
    <div class="card section-gap">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div class="card-title" style="margin:0">Recent Events</div>
        <span class="text-xs text-muted">Click ✕ to remove events that shouldn't influence calibration</span>
      </div>
      ${events.length ? `
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:640px">
            <thead>
              <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
                <th style="text-align:left;padding:4px 8px">Date</th>
                <th style="text-align:left;padding:4px 8px">Ticker</th>
                <th style="text-align:left;padding:4px 8px">Action</th>
                <th style="text-align:right;padding:4px 8px">Confidence</th>
                <th style="text-align:left;padding:4px 8px">Regime</th>
                <th style="text-align:left;padding:4px 8px">Outcome</th>
                <th style="text-align:right;padding:4px 8px">P&amp;L %</th>
                <th style="text-align:center;padding:4px 8px;width:32px"></th>
              </tr>
            </thead>
            <tbody>
              ${events.slice(0, 20).map(ev => {
                // realized_pnl_pct is stored as a percentage value (e.g. 5.2 = 5.2%)
                const pnlPct = ev.realized_pnl_pct;
                const pnlStr = pnlPct != null
                  ? (pnlPct >= 0 ? '+' : '') + Number(pnlPct).toFixed(1) + '%'
                  : '—';
                const pnlColor = pnlPct > 0 ? '#16a34a' : pnlPct < 0 ? '#dc2626' : 'var(--text-secondary)';
                return `<tr id="ll-row-${ev.id}" style="border-bottom:1px solid var(--border)">
                  <td style="padding:4px 8px;color:var(--text-muted)">${(ev.timestamp||'').slice(0,10)}</td>
                  <td style="padding:4px 8px;font-weight:600">${ev.ticker||'—'}</td>
                  <td style="padding:4px 8px">${ev.recommendation||'—'}</td>
                  <td style="padding:4px 8px;text-align:right">${ev.ai_confidence != null ? (ev.ai_confidence*100).toFixed(0)+'%' : '—'}</td>
                  <td style="padding:4px 8px;color:var(--text-muted)">${ev.regime||'—'}</td>
                  <td style="padding:4px 8px">${outcomeChip(ev.outcome_status)}</td>
                  <td style="padding:4px 8px;text-align:right;color:${pnlColor}">${pnlStr}</td>
                  <td style="padding:4px 8px;text-align:center">
                    <button
                      onclick="deleteLearningEvent(${ev.id})"
                      title="Remove this event from the Learning Loop"
                      style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:13px;padding:2px 4px;border-radius:3px;line-height:1"
                      onmouseover="this.style.color='#dc2626';this.style.background='#dc262620'"
                      onmouseout="this.style.color='var(--text-muted)';this.style.background='none'"
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
    recentCard + failedCard;
}

// ── Delete a single learning event (optimise calibration dataset) ─────────────
async function deleteLearningEvent(id) {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  try {
    const resp = await fetch(`${API}/api/learning/event/${id}`, { method: 'DELETE' });
    const result = await resp.json();
    if (result.ok) {
      // Instant DOM removal — no full page reload needed
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
