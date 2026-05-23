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
// ============================================================

async function renderLearningPage(gen) {
  const el = document.getElementById('main-content');
  if (state._renderGen !== gen) return;

  // Skeleton while fetching
  el.innerHTML = `
    <div class="card" style="padding:18px">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <span class="text-xs text-muted" style="margin-left:8px">Loading Learning Loop data…</span>
    </div>`;

  let data = null;
  try {
    const resp = await fetch(`${API}/api/learning/stats`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
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
  const s = d.summary || {};
  const confBands  = d.confidence_bands  || [];
  const regimes    = d.regimes           || [];
  const versions   = d.prompt_versions   || [];
  const events     = d.recent_events     || [];
  const failed     = d.failed_tickers    || [];

  const fmt = (v, dp=1) => v == null ? '—' : Number(v).toFixed(dp);
  const pct = (v) => v == null ? '—' : (v * 100).toFixed(0) + '%';
  const rateColor = r => r == null ? 'var(--text-secondary)' : r >= 0.6 ? '#16a34a' : r >= 0.45 ? '#d97706' : '#dc2626';

  // ── Summary cards ─────────────────────────────────────────────────────────
  const summaryCards = `
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Total AI Events</div>
        <div class="metric-value">${s.total_events ?? 0}</div>
        <div class="metric-sub">${s.open_count ?? 0} open · ${s.executed_count ?? 0} executed</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Overall Win Rate</div>
        <div class="metric-value ${s.win_rate >= 0.5 ? 'up' : 'down'}">${pct(s.win_rate)}</div>
        <div class="metric-sub">${s.wins ?? 0}W / ${s.losses ?? 0}L (${s.closed_count ?? 0} closed)</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">High-Conf Win Rate</div>
        <div class="metric-value ${s.high_conf_win_rate >= 0.6 ? 'up' : 'down'}">${pct(s.high_conf_win_rate)}</div>
        <div class="metric-sub">Confidence ≥ 0.70</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Active Prompt Version</div>
        <div class="metric-value" style="font-size:13px">${s.current_prompt_version || '—'}</div>
        <div class="metric-sub">${s.version_calls ?? 0} calls this version</div>
      </div>
    </div>`;

  // ── Calibration summary card ───────────────────────────────────────────────
  const calibCard = `
    <div class="card section-gap">
      <div class="card-title">Confidence Calibration (30-day)</div>
      <p class="text-xs text-muted mb-1">Predicted confidence vs actual win rate by band. Ideal: each band's win rate ≈ its confidence level.</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Confidence Band</th>
            <th style="text-align:right;padding:4px 8px">Calls</th>
            <th style="text-align:right;padding:4px 8px">Wins</th>
            <th style="text-align:right;padding:4px 8px">Win Rate</th>
            <th style="text-align:left;padding:4px 8px;width:120px">Bar</th>
          </tr>
        </thead>
        <tbody>
          ${confBands.length ? confBands.map(b => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 8px">${b.band}</td>
              <td style="padding:5px 8px;text-align:right">${b.calls}</td>
              <td style="padding:5px 8px;text-align:right">${b.wins}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(b.win_rate)}">${pct(b.win_rate)}</td>
              <td style="padding:5px 8px">
                <div style="background:var(--bg-secondary);border-radius:3px;height:8px;width:100px">
                  <div style="background:${rateColor(b.win_rate)};border-radius:3px;height:8px;width:${b.win_rate != null ? Math.round(b.win_rate*100) : 0}px"></div>
                </div>
              </td>
            </tr>`).join('') : '<tr><td colspan="5" style="padding:8px;color:var(--text-muted)">No closed events yet.</td></tr>'}
        </tbody>
      </table>
    </div>`;

  // ── Regime performance ─────────────────────────────────────────────────────
  const regimeCard = `
    <div class="card section-gap">
      <div class="card-title">Performance by Regime</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Regime</th>
            <th style="text-align:right;padding:4px 8px">Calls</th>
            <th style="text-align:right;padding:4px 8px">Win Rate</th>
            <th style="text-align:right;padding:4px 8px">Avg Confidence</th>
          </tr>
        </thead>
        <tbody>
          ${regimes.length ? regimes.map(r => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 8px">${r.regime || 'unknown'}</td>
              <td style="padding:5px 8px;text-align:right">${r.calls}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(r.win_rate)}">${pct(r.win_rate)}</td>
              <td style="padding:5px 8px;text-align:right">${fmt(r.avg_confidence != null ? r.avg_confidence * 100 : null, 0)}%</td>
            </tr>`).join('') : '<tr><td colspan="4" style="padding:8px;color:var(--text-muted)">No regime data yet.</td></tr>'}
        </tbody>
      </table>
    </div>`;

  // ── Prompt version history ─────────────────────────────────────────────────
  const versionsCard = `
    <div class="card section-gap">
      <div class="card-title">Prompt Version History</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px">Version</th>
            <th style="text-align:right;padding:4px 8px">Calls</th>
            <th style="text-align:right;padding:4px 8px">Win Rate</th>
            <th style="text-align:right;padding:4px 8px">High-Conf Win Rate</th>
            <th style="text-align:left;padding:4px 8px">Created</th>
          </tr>
        </thead>
        <tbody>
          ${versions.length ? versions.map(v => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 8px;font-family:monospace">${v.version}</td>
              <td style="padding:5px 8px;text-align:right">${v.total_calls}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(v.win_rate)}">${pct(v.win_rate)}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;color:${rateColor(v.high_conf_win_rate)}">${pct(v.high_conf_win_rate)}</td>
              <td style="padding:5px 8px;color:var(--text-muted)">${(v.created_at||'').slice(0,10)}</td>
            </tr>`).join('') : '<tr><td colspan="5" style="padding:8px;color:var(--text-muted)">No prompt version data yet.</td></tr>'}
        </tbody>
      </table>
    </div>`;

  // ── Recent events ──────────────────────────────────────────────────────────
  const outcomeChip = o => {
    const map = { win:'#16a34a', loss:'#dc2626', breakeven:'#9ca3af', open:'#3b82f6', invalidated:'#d97706' };
    const col  = map[o] || '#9ca3af';
    return `<span style="background:${col}20;color:${col};border-radius:3px;padding:1px 6px;font-size:10px;font-weight:600">${o||'open'}</span>`;
  };
  const recentCard = `
    <div class="card section-gap">
      <div class="card-title">Recent Events</div>
      ${events.length ? `
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="color:var(--text-muted);border-bottom:1px solid var(--border)">
              <th style="text-align:left;padding:4px 8px">Date</th>
              <th style="text-align:left;padding:4px 8px">Ticker</th>
              <th style="text-align:left;padding:4px 8px">Action</th>
              <th style="text-align:right;padding:4px 8px">Confidence</th>
              <th style="text-align:left;padding:4px 8px">Regime</th>
              <th style="text-align:left;padding:4px 8px">Outcome</th>
              <th style="text-align:right;padding:4px 8px">P&amp;L %</th>
            </tr>
          </thead>
          <tbody>
            ${events.slice(0, 20).map(ev => `
              <tr style="border-bottom:1px solid var(--border)">
                <td style="padding:4px 8px;color:var(--text-muted)">${(ev.timestamp||'').slice(0,10)}</td>
                <td style="padding:4px 8px;font-weight:600">${ev.ticker||'—'}</td>
                <td style="padding:4px 8px">${ev.recommendation||ev.event_type||'—'}</td>
                <td style="padding:4px 8px;text-align:right">${ev.ai_confidence != null ? (ev.ai_confidence*100).toFixed(0)+'%' : '—'}</td>
                <td style="padding:4px 8px;color:var(--text-muted)">${ev.regime||'—'}</td>
                <td style="padding:4px 8px">${outcomeChip(ev.outcome_status)}</td>
                <td style="padding:4px 8px;text-align:right;color:${ev.realized_pnl_pct>0?'#16a34a':ev.realized_pnl_pct<0?'#dc2626':'var(--text-secondary)'}">${ev.realized_pnl_pct != null ? (ev.realized_pnl_pct>=0?'+':'')+(ev.realized_pnl_pct*100).toFixed(1)+'%' : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<p class="text-xs text-muted" style="padding:4px 8px">No AI events logged yet. Run an analysis to start building the audit trail.</p>'}
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
          ${failed.slice(0,10).map(f => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:4px 8px;color:var(--text-muted)">${(f.timestamp||'').slice(0,16).replace('T',' ')}</td>
              <td style="padding:4px 8px;font-weight:600">${f.ticker}</td>
              <td style="padding:4px 8px;color:#dc2626">${f.error||''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  return summaryCards + calibCard + `<div class="grid-2">${regimeCard}${versionsCard}</div>` + recentCard + failedCard;
}
