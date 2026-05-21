// ============================================================
// learning-loop.js — Calibration analytics from closed trades (3.3)
//
// computeCalibrationStats(recHistory)  → per-confidence-band hit rates
// computeRegimePerformance(recHistory) → per-regime win rates
// detectStrategyDecay(recHistory, windowDays) → decay detection
// buildCalibrationPromptBlock(recHistory) → string ready for user message injection
// ============================================================

// computeCalibrationStats — hit rate by confidence band
// Returns { bands:{}, sampleSize, sufficient }
function computeCalibrationStats(recHistory) {
  const closed = (recHistory || []).filter(r => r.actualProfit != null);
  if (closed.length < 5) return { bands: {}, sampleSize: closed.length, sufficient: false };

  const bands = {
    '0.90+':    { hits: 0, total: 0, totalPnl: 0, midpoint: 0.925 },
    '0.80-0.89':{ hits: 0, total: 0, totalPnl: 0, midpoint: 0.845 },
    '0.70-0.79':{ hits: 0, total: 0, totalPnl: 0, midpoint: 0.745 },
    '0.60-0.69':{ hits: 0, total: 0, totalPnl: 0, midpoint: 0.645 },
  };

  const bucket = conf =>
    conf >= 0.90 ? '0.90+' :
    conf >= 0.80 ? '0.80-0.89' :
    conf >= 0.70 ? '0.70-0.79' : '0.60-0.69';

  for (const r of closed) {
    const b = bucket(r.confidence || 0);
    if (!bands[b]) continue;
    bands[b].total++;
    bands[b].totalPnl += r.actualProfit;
    if (r.actualProfit > 0) bands[b].hits++;
  }

  for (const [, b] of Object.entries(bands)) {
    if (b.total === 0) continue;
    b.hitRate        = +(b.hits / b.total).toFixed(3);
    b.avgPnl         = +(b.totalPnl / b.total).toFixed(2);
    // calibration delta: negative means overconfident
    b.calibrationDelta = +(b.hitRate - b.midpoint).toFixed(3);
    // suggested adjustment: apply -10% if hit rate < 60%, or none otherwise
    b.adjustment     = b.hitRate < 0.60 ? -0.10 : b.hitRate > 0.80 ? 0.05 : 0;
  }

  return { bands, sampleSize: closed.length, sufficient: true };
}

// computeRegimePerformance — win rate and avg P&L per market regime
// Records must have .regime field (added when the rec is saved post 3.2)
function computeRegimePerformance(recHistory) {
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
    rg.winRate = +(rg.wins  / rg.total).toFixed(3);
    rg.avgPnl  = +(rg.totalPnl / rg.total).toFixed(2);
  }

  return regimes;
}

// detectStrategyDecay — compares recent window vs all-time win rate
// Returns { decaying, recentWinRate, allTimeWinRate, delta, recentSample }
function detectStrategyDecay(recHistory, windowDays = 30) {
  const closed = (recHistory || []).filter(r => r.actualProfit != null);
  if (closed.length < 10) return { decaying: false, insufficient: true };

  const cutoff = Date.now() - windowDays * 86400000;
  const parseDate = r => {
    if (!r.date) return 0;
    // Support DD-MM-YYYY and ISO 8601
    const parts = r.date.split('-');
    if (parts.length === 3 && parts[2].length === 4) {
      return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime();
    }
    return new Date(r.date).getTime();
  };

  const recent  = closed.filter(r => parseDate(r) > cutoff);
  const allTime = closed;

  const winRate = arr => arr.length > 0
    ? arr.filter(r => r.actualProfit > 0).length / arr.length
    : 0;

  const recentWR  = winRate(recent);
  const allTimeWR = winRate(allTime);
  const delta = recentWR - allTimeWR;

  return {
    decaying:       delta < -0.15 && recent.length >= 5,
    recentWinRate:  +recentWR.toFixed(3),
    allTimeWinRate: +allTimeWR.toFixed(3),
    delta:          +delta.toFixed(3),
    recentSample:   recent.length,
  };
}

// buildCalibrationPromptBlock — string ready to inject into user message
function buildCalibrationPromptBlock(recHistory) {
  const stats = computeCalibrationStats(recHistory);
  if (!stats.sufficient) return '';

  const lines = Object.entries(stats.bands)
    .filter(([, b]) => b.total >= 3)
    .map(([band, b]) => {
      const hr = (b.hitRate * 100).toFixed(0);
      const adj = b.adjustment !== 0
        ? ` → apply ${b.adjustment > 0 ? '+' : ''}${(b.adjustment * 100).toFixed(0)}% to confidence in this band`
        : ' → no adjustment needed';
      return `  ${band}: ${b.hits}/${b.total} = ${hr}% hit rate (avg P&L $${b.avgPnl}, delta ${b.calibrationDelta > 0 ? '+' : ''}${b.calibrationDelta})${adj}`;
    });

  if (!lines.length) return '';

  const decay = detectStrategyDecay(recHistory);
  let decayBlock = '';
  if (decay.decaying) {
    decayBlock = `\nSTRATEGY DECAY DETECTED: recent ${(decay.recentWinRate * 100).toFixed(0)}% vs all-time ${(decay.allTimeWinRate * 100).toFixed(0)}% win rate (n=${decay.recentSample}). Reduce position sizing 25% pending review.`;
  }

  const regimes = computeRegimePerformance(recHistory);
  const regimeLines = Object.entries(regimes)
    .filter(([, r]) => r.total >= 3)
    .map(([rg, r]) => `  ${rg}: ${r.total} trades, ${(r.winRate * 100).toFixed(0)}% win, avg P&L $${r.avgPnl}${r.winRate < 0.50 ? ' ⚠ POOR — tighten threshold' : ''}`);

  const regimeBlock = regimeLines.length
    ? `\nREGIME PERFORMANCE:\n${regimeLines.join('\n')}`
    : '';

  return `\n\nCALIBRATION (pre-computed, n=${stats.sampleSize} closed trades — apply adjustments before setting confidence):\n${lines.join('\n')}${decayBlock}${regimeBlock}`;
}
