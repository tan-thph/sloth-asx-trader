// ============================================================
// learning-loop.js — Calibration analytics (v2)
//
// PRIMARY source: SQLite via GET /api/learning/stats (cached in
//   state._learningCache after refreshLearningCache() is called).
// FALLBACK: state.recHistory (local, works offline).
//
// Public API:
//   refreshLearningCache()                → async, call before analysis
//   computeCalibrationStats(recHistory)   → per-confidence-band hit rates
//   computeRegimePerformance(recHistory)  → per-regime win rates
//   detectStrategyDecay(recHistory, days) → decay + volatility detection
//   computeAllTradesStats(journalHistory) → AI vs manual win-rate comparison
//   computeRRRealization(recHistory)      → suggested R:R vs actual outcome
//   buildCalibrationPromptBlock(recHistory) → string for AI user message
//
// Expected fields per record (recHistory entries):
//   id, confidence, ensemble_confidence, regime, actualProfit,
//   suggestedStop, suggestedTarget, executedPrice, outcome,
//   exitReason, promptVersion, holdingDays, date, action
// Backend event fields (state._learningCache.recent_events):
//   id, ticker, recommendation, ai_confidence, ensemble_confidence,
//   outcome_status, realized_pnl_pct, realized_pnl_aud, regime,
//   prompt_version, was_executed, suggested_stop, suggested_target,
//   rr_ratio, holding_period_days, exit_reason, rationale_summary
// ============================================================

// ── Cache management ──────────────────────────────────────────────────────────

/**
 * Fetch backend learning stats and store in state._learningCache.
 * Called at the top of runAnalysis() so buildCalibrationPromptBlock()
 * has fresh data before the AI call is made.
 * Fire-and-forget safe — never throws, silently falls back to recHistory.
 */
async function refreshLearningCache() {
  if (typeof state === 'undefined' || !state.serverOk) return;
  try {
    const resp = await fetch(`${API}/api/learning/stats`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.error) return;
    state._learningCache = { ...data, _fetchedAt: Date.now() };
  } catch (_) { /* never break analysis */ }
}

// ── computeCalibrationStats ───────────────────────────────────────────────────

/**
 * Per-confidence-band hit rates.
 * Prefers backend conf_bands when available (richer sample).
 * Returns { bands:{}, sampleSize, sufficient, source }
 */
function computeCalibrationStats(recHistory) {
  const cache = (typeof state !== 'undefined') ? state._learningCache : null;

  // ── Path A: backend data ──────────────────────────────────────────────────
  if (cache && Array.isArray(cache.conf_bands) && cache.closed >= 3) {
    const bands = {};
    const midpoints = { '60-70%': 0.645, '70-80%': 0.745, '80-90%': 0.845, '90-101%': 0.925 };
    for (const b of cache.conf_bands) {
      const mp = midpoints[b.band] ?? 0.725;
      const wr = b.win_rate != null ? b.win_rate / 100 : null;  // convert from 0-100 to 0-1
      bands[b.band] = {
        hits:  b.wins,
        total: b.total,
        totalPnl: null,                  // not in aggregate endpoint
        midpoint: mp,
        hitRate:  wr,
        avgPnl:   null,
        calibrationDelta: wr != null ? +(wr - mp).toFixed(3) : null,
        adjustment: wr == null ? 0 : wr < 0.60 ? -0.10 : wr > 0.80 ? 0.05 : 0,
      };
    }
    return {
      bands,
      sampleSize: cache.closed,
      sufficient: cache.closed >= 5,
      source: 'backend',
    };
  }

  // ── Path B: local recHistory fallback ─────────────────────────────────────
  const closed = (recHistory || []).filter(r => r.actualProfit != null);
  if (closed.length < 5) return { bands: {}, sampleSize: closed.length, sufficient: false, source: 'local' };

  const bands = {
    '90-101%': { hits: 0, total: 0, totalPnl: 0, midpoint: 0.925 },
    '80-90%':  { hits: 0, total: 0, totalPnl: 0, midpoint: 0.845 },
    '70-80%':  { hits: 0, total: 0, totalPnl: 0, midpoint: 0.745 },
    '60-70%':  { hits: 0, total: 0, totalPnl: 0, midpoint: 0.645 },
  };
  const bucket = c =>
    c >= 0.90 ? '90-101%' : c >= 0.80 ? '80-90%' : c >= 0.70 ? '70-80%' : '60-70%';

  for (const r of closed) {
    const b = bands[bucket(r.confidence || 0)];
    if (!b) continue;
    b.total++;
    b.totalPnl += r.actualProfit;
    if (r.actualProfit > 0) b.hits++;
  }
  for (const b of Object.values(bands)) {
    if (!b.total) continue;
    b.hitRate          = +(b.hits / b.total).toFixed(3);
    b.avgPnl           = +(b.totalPnl / b.total).toFixed(2);
    b.calibrationDelta = +(b.hitRate - b.midpoint).toFixed(3);
    b.adjustment       = b.hitRate < 0.60 ? -0.10 : b.hitRate > 0.80 ? 0.05 : 0;
  }
  return { bands, sampleSize: closed.length, sufficient: true, source: 'local' };
}

// ── computeRegimePerformance ──────────────────────────────────────────────────

/**
 * Win rate and avg P&L per market regime.
 * Prefers backend regime_stats when available.
 * Returns { [regime]: { wins, total, winRate, avgPnl } }
 */
function computeRegimePerformance(recHistory) {
  const cache = (typeof state !== 'undefined') ? state._learningCache : null;

  if (cache && Array.isArray(cache.regime_stats) && cache.regime_stats.length) {
    const out = {};
    for (const r of cache.regime_stats) {
      out[r.regime] = {
        wins:    r.wins,
        total:   r.total,
        winRate: r.win_rate != null ? r.win_rate / 100 : null,
        avgPnl:  null,  // not in aggregate endpoint
      };
    }
    return out;
  }

  const closed = (recHistory || []).filter(r => r.actualProfit != null && r.regime);
  if (closed.length < 3) return {};

  const regimes = {};
  for (const r of closed) {
    const rg = r.regime || 'unknown';
    if (!regimes[rg]) regimes[rg] = { wins: 0, total: 0, totalPnl: 0 };
    regimes[rg].total++;
    regimes[rg].totalPnl += r.actualProfit;
    if (r.actualProfit > 0) regimes[rg].wins++;
  }
  for (const rg of Object.values(regimes)) {
    rg.winRate = +(rg.wins / rg.total).toFixed(3);
    rg.avgPnl  = +(rg.totalPnl / rg.total).toFixed(2);
  }
  return regimes;
}

// ── detectStrategyDecay ───────────────────────────────────────────────────────

/**
 * Compares recent window win rate vs all-time; also reports performance
 * volatility (std dev of recent returns) to flag choppy regimes.
 * Returns { decaying, volatile, recentWinRate, allTimeWinRate, delta,
 *           recentSample, recentVolatility, note }
 */
function detectStrategyDecay(recHistory, windowDays = 30) {
  const closed = (recHistory || []).filter(r => r.actualProfit != null);
  if (closed.length < 10) return { decaying: false, volatile: false, insufficient: true };

  const cutoff = Date.now() - windowDays * 86400000;
  const parseDate = r => {
    if (!r.date) return 0;
    const parts = r.date.split('-');
    if (parts.length === 3 && parts[2].length === 4)
      return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime();
    return new Date(r.date).getTime();
  };

  const recent  = closed.filter(r => parseDate(r) > cutoff);
  const allTime = closed;

  const winRate = arr => arr.length > 0
    ? arr.filter(r => r.actualProfit > 0).length / arr.length : 0;

  // Volatility: std dev of profit values in recent window (normalised by abs mean)
  let recentVolatility = null;
  if (recent.length >= 4) {
    const profits = recent.map(r => r.actualProfit);
    const mean    = profits.reduce((s, v) => s + v, 0) / profits.length;
    const variance = profits.reduce((s, v) => s + (v - mean) ** 2, 0) / profits.length;
    const stdDev  = Math.sqrt(variance);
    // Coefficient of variation — capped; high means very erratic returns
    recentVolatility = mean !== 0 ? +(Math.abs(stdDev / mean)).toFixed(2) : null;
  }

  const recentWR  = winRate(recent);
  const allTimeWR = winRate(allTime);
  const delta = recentWR - allTimeWR;
  const decaying  = delta < -0.15 && recent.length >= 5;
  const volatile  = recentVolatility != null && recentVolatility > 2.0;

  let note = '';
  if (decaying && volatile) note = 'High volatility + win-rate decline — consider halving position sizes';
  else if (decaying)        note = 'Win-rate declining — tighten entry criteria';
  else if (volatile)        note = 'High return volatility — reduce position sizing until stable';

  return {
    decaying,
    volatile,
    recentWinRate:    +recentWR.toFixed(3),
    allTimeWinRate:   +allTimeWR.toFixed(3),
    delta:            +delta.toFixed(3),
    recentSample:     recent.length,
    recentVolatility,
    note,
  };
}

// ── computeAllTradesStats ─────────────────────────────────────────────────────

/**
 * Compare AI-recommended vs manually-entered trades.
 * Uses state.tradeJournal directly (has both sources).
 * Returns { aiWinRate, manualWinRate, combinedWinRate, aiTotal, manualTotal,
 *           aiAvgPnl, manualAvgPnl }
 */
function computeAllTradesStats(journalHistory) {
  const trades = (journalHistory || (typeof state !== 'undefined' ? state.tradeJournal : []) || []);
  const closed  = trades.filter(t => t.pnl != null);
  if (!closed.length) return null;

  const aiTrades     = closed.filter(t => t.recId != null && t.recExecuted);
  const manualTrades = closed.filter(t => !t.recId || !t.recExecuted);

  const stats = arr => {
    if (!arr.length) return null;
    const wins  = arr.filter(t => t.pnl > 0).length;
    const total = arr.length;
    const avgPnl = +(arr.reduce((s, t) => s + Number(t.pnl), 0) / total).toFixed(2);
    return { wins, total, winRate: +(wins / total).toFixed(3), avgPnl };
  };

  const ai     = stats(aiTrades);
  const manual = stats(manualTrades);
  const all    = stats(closed);

  return {
    aiWinRate:      ai?.winRate     ?? null,
    aiTotal:        ai?.total       ?? 0,
    aiAvgPnl:       ai?.avgPnl      ?? null,
    manualWinRate:  manual?.winRate ?? null,
    manualTotal:    manual?.total   ?? 0,
    manualAvgPnl:   manual?.avgPnl  ?? null,
    combinedWinRate: all?.winRate   ?? null,
    combinedTotal:  all?.total      ?? 0,
  };
}

// ── computeRRRealization ──────────────────────────────────────────────────────

/**
 * Compare suggested R:R vs actual outcome.
 * Uses backend rr_stats when available, else approximates from recHistory.
 * Returns { avgSuggestedRR, hiRRWinRate, hiRRSample, meetsRRThreshold,
 *           note, source }
 */
function computeRRRealization(recHistory) {
  const cache = (typeof state !== 'undefined') ? state._learningCache : null;

  // ── Path A: backend rr_stats ──────────────────────────────────────────────
  if (cache && cache.rr_stats && cache.rr_stats.sample > 0) {
    const rr = cache.rr_stats;
    const meetsThreshold = rr.hi_rr_win_rate != null && rr.hi_rr_win_rate >= 55;
    const note = rr.hi_rr_sample < 3
      ? 'Insufficient R:R data'
      : meetsThreshold
        ? `High-R:R trades (≥2.0) are working — ${rr.hi_rr_win_rate}% win rate`
        : `High-R:R trades underperforming (${rr.hi_rr_win_rate ?? 'n/a'}%) — review stop placement`;
    return {
      avgSuggestedRR:  rr.avg_suggested_rr,
      hiRRWinRate:     rr.hi_rr_win_rate,
      hiRRSample:      rr.hi_rr_sample,
      meetsRRThreshold: meetsThreshold,
      note,
      source: 'backend',
    };
  }

  // ── Path B: local recHistory approximation ────────────────────────────────
  const withRR = (recHistory || []).filter(r =>
    r.target && r.stopLoss && r.priceRange?.[0] && r.actualProfit != null
  );
  if (withRR.length < 3) return { avgSuggestedRR: null, hiRRWinRate: null, hiRRSample: 0,
    meetsRRThreshold: null, note: 'Insufficient local R:R data', source: 'local' };

  const calcRR = r => {
    const entry = r.priceRange[0];
    const risk  = Math.abs(entry - r.stopLoss);
    return risk > 0 ? Math.abs(r.target - entry) / risk : null;
  };

  const rrs = withRR.map(r => ({ ...r, _rr: calcRR(r) })).filter(r => r._rr != null);
  const avgRR = rrs.length ? +(rrs.reduce((s, r) => s + r._rr, 0) / rrs.length).toFixed(2) : null;
  const hiRR  = rrs.filter(r => r._rr >= 2.0);
  const hiWins = hiRR.filter(r => r.actualProfit > 0).length;
  const hiWinRate = hiRR.length ? +(hiWins / hiRR.length * 100).toFixed(1) : null;

  return {
    avgSuggestedRR:   avgRR,
    hiRRWinRate:      hiWinRate,
    hiRRSample:       hiRR.length,
    meetsRRThreshold: hiWinRate != null && hiWinRate >= 55,
    note: hiRR.length < 3 ? 'Insufficient R:R data' :
          hiWinRate >= 55 ? `High-R:R trades working — ${hiWinRate}% win rate` :
          `High-R:R trades underperforming (${hiWinRate}%) — review stop placement`,
    source: 'local',
  };
}

// ── buildCalibrationPromptBlock ───────────────────────────────────────────────

/**
 * Builds a multi-section calibration string ready to inject into the AI
 * user message. Combines: confidence calibration, regime performance, strategy
 * decay + volatility, R:R realization, hold duration, and exit reason analysis.
 * Returns '' when insufficient data so nothing is injected.
 */
function buildCalibrationPromptBlock(recHistory) {
  const cache = (typeof state !== 'undefined') ? state._learningCache : null;

  // ── Calibration bands ─────────────────────────────────────────────────────
  const stats = computeCalibrationStats(recHistory);
  if (!stats.sufficient) return '';

  const bandLines = Object.entries(stats.bands)
    .filter(([, b]) => b.total >= 3)
    .map(([band, b]) => {
      if (b.hitRate == null) return null;
      const hr  = (b.hitRate * 100).toFixed(0);
      const adj = b.adjustment !== 0
        ? ` → apply ${b.adjustment > 0 ? '+' : ''}${(b.adjustment * 100).toFixed(0)}% to confidence`
        : ' → no adjustment needed';
      const pnl = b.avgPnl != null ? `, avg P&L $${b.avgPnl}` : '';
      const cal = b.calibrationDelta != null
        ? ` (delta ${b.calibrationDelta > 0 ? '+' : ''}${b.calibrationDelta})`
        : '';
      return `  ${band}: ${b.hits}/${b.total} = ${hr}% hit rate${pnl}${cal}${adj}`;
    })
    .filter(Boolean);

  if (!bandLines.length) return '';

  const src = stats.source === 'backend' ? `DB, ${stats.sampleSize} closed` : `local, ${stats.sampleSize}`;

  // ── Regime performance ────────────────────────────────────────────────────
  const regimes = computeRegimePerformance(recHistory);
  const regimeLines = Object.entries(regimes)
    .filter(([, r]) => r.total >= 3)
    .map(([rg, r]) => {
      const wr = r.winRate != null ? (r.winRate * 100).toFixed(0) + '%' : 'n/a';
      const pnl = r.avgPnl != null ? `, avg P&L $${r.avgPnl}` : '';
      const warn = r.winRate != null && r.winRate < 0.50 ? ' ⚠ POOR — avoid new entries' : '';
      return `  ${rg}: ${r.total} trades, ${wr} win${pnl}${warn}`;
    });
  const regimeBlock = regimeLines.length
    ? `\nREGIME PERFORMANCE:\n${regimeLines.join('\n')}` : '';

  // ── Decay + volatility ────────────────────────────────────────────────────
  const decay = detectStrategyDecay(recHistory);
  let decayBlock = '';
  if (!decay.insufficient) {
    if (decay.decaying || decay.volatile) {
      decayBlock = `\nSTRATEGY HEALTH: ${decay.note}. Recent ${(decay.recentWinRate * 100).toFixed(0)}% vs all-time ${(decay.allTimeWinRate * 100).toFixed(0)}% win rate (n=${decay.recentSample})${decay.recentVolatility != null ? `, return volatility CoV=${decay.recentVolatility}` : ''}.`;
    }
  }

  // ── R:R realization ───────────────────────────────────────────────────────
  const rr = computeRRRealization(recHistory);
  let rrBlock = '';
  if (rr.avgSuggestedRR != null) {
    rrBlock = `\nR:R ACCURACY: avg suggested R:R ${rr.avgSuggestedRR}`;
    if (rr.hiRRSample >= 3 && rr.hiRRWinRate != null) {
      rrBlock += `, high-R:R trades (≥2.0) win rate ${rr.hiRRWinRate}% (n=${rr.hiRRSample}).`;
      if (!rr.meetsRRThreshold) rrBlock += ' ⚠ Below 55% — stops may be too wide or targets too ambitious.';
    } else {
      rrBlock += '.';
    }
  }

  // ── Avg hold duration ─────────────────────────────────────────────────────
  let holdBlock = '';
  const avgHold = cache?.avg_hold_days;
  if (avgHold != null) {
    holdBlock = `\nAVG HOLD: ${avgHold} days (closed trades).`;
  }

  // ── Exit reason distribution ──────────────────────────────────────────────
  let exitBlock = '';
  const exitDist = cache?.exit_reason_dist;
  if (exitDist && Object.keys(exitDist).length) {
    const sorted = Object.entries(exitDist).sort(([, a], [, b]) => b - a);
    exitBlock = `\nEXIT REASONS: ${sorted.map(([r, n]) => `${r}×${n}`).join(', ')}.`;
  }

  // ── AI vs manual comparison ───────────────────────────────────────────────
  let aiVsManualBlock = '';
  const tradeStats = computeAllTradesStats();
  if (tradeStats && tradeStats.aiTotal >= 3 && tradeStats.manualTotal >= 3) {
    const aiPct     = (tradeStats.aiWinRate * 100).toFixed(0);
    const manualPct = (tradeStats.manualWinRate * 100).toFixed(0);
    const delta = tradeStats.aiWinRate - tradeStats.manualWinRate;
    const note  = Math.abs(delta) < 0.05 ? '' :
                  delta > 0 ? ' ✓ AI recommendations outperforming manual trades' :
                              ' ⚠ Manual trades outperforming AI — review AI criteria';
    aiVsManualBlock = `\nAI vs MANUAL: AI ${aiPct}% win (n=${tradeStats.aiTotal}) | Manual ${manualPct}% win (n=${tradeStats.manualTotal}).${note}`;
  }

  // ── Assemble final block ──────────────────────────────────────────────────
  return [
    `\n\nCALIBRATION (${src} — apply adjustments before setting confidence):`,
    bandLines.join('\n'),
    regimeBlock,
    decayBlock,
    rrBlock,
    holdBlock,
    exitBlock,
    aiVsManualBlock,
  ].filter(Boolean).join('');
}
