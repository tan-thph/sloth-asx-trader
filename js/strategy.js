// ============================================================
// strategy.js — Client-side day trading strategy filters
//
// Edit the threshold values here to tune the pre-filter
// without touching the orchestration logic in day-trading-analysis.js.
// ============================================================

// ── Day trading pre-filter thresholds ─────────────────────────────────────────
// Tickers that fail any of these checks are dropped before the AI sees them.
const DT_FILTER = {
  maxBbPctB:        0.20,   // BB %B must be ≤ this (price near or below lower band)
  minAdvAud:    1_500_000,  // minimum 20-day average daily value (AUD)
  sma200Floor:      0.985,  // price must be ≥ SMA200 × this (or SMA50 if SMA200 unavailable)
  maxAdx:            35,    // ADX ceiling — skip stocks already in a strong rip
  minRrRatio:       2.0,    // minimum reward:risk ratio (used in AI prompt, not pre-filter)
  minConfidence:    0.50,   // minimum AI confidence to accept a rec
  stopAtrMultiple:  2.5,    // stop loss = entry − stopAtrMultiple × ATR14
};

// ── Pre-filter function ────────────────────────────────────────────────────────
// Returns the subset of tickers whose live signals pass all hard filters.
// Called by runUniverseScan() in day-trading-analysis.js.
function _dtPreFilter(tickers) {
  return tickers.filter(t => {
    const s = state.liveSignals[t];
    if (!s || s.error) return false;

    // Signal #1 — price at/near lower Bollinger Band
    if ((s.bb_pct_b ?? 1) > DT_FILTER.maxBbPctB) return false;

    // Liquidity filter — ADV > $1.5M AUD
    if ((s.adv_20 ?? 0) < DT_FILTER.minAdvAud) return false;

    // Trend floor — price must be near or above SMA200 (uses SMA50 if SMA200 unavailable)
    const ref = s.sma_200 ?? s.sma_50;
    if (ref && s.current_price < ref * DT_FILTER.sma200Floor) return false;

    // Regime filter — skip stocks already in a strong rising trend
    if ((s.adx ?? 0) > DT_FILTER.maxAdx && s.trend_strength === 'strong' && (s.return_5d ?? 0) > 0) return false;

    return true;
  });
}
