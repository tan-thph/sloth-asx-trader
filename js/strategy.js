// ============================================================
// strategy.js — Client-side day trading strategy filters
//
// Edit the threshold values here to tune the pre-filter
// without touching the orchestration logic in day-trading-analysis.js.
// ============================================================

// ── Day trading pre-filter thresholds ─────────────────────────────────────────
// Tickers that fail any of these checks are dropped before the AI sees them.
const DT_FILTER = {
  maxBbPctB:    0.20,   // BB %B must be ≤ this (price near or below lower band)
  minAdvAud: 1_500_000, // minimum 20-day average daily value (AUD)
  sma200Floor:  0.985,  // price must be ≥ SMA200 × this (or SMA50 if SMA200 unavailable)
  maxAdx:        35,    // ADX ceiling — skip stocks already in a strong rip
};

// ── AI-phase parameters ────────────────────────────────────────────────────────
// Read by the prompt builder and downstream logic — not used in _dtPreFilter().
const DT_AI_PARAMS = {
  minRrRatio:      2.0,  // minimum reward:risk ratio
  minConfidence:   0.50, // minimum AI confidence to accept a rec
  stopAtrMultiple: 2.5,  // stop loss = entry − stopAtrMultiple × ATR14
};

// ── Pre-filter function ────────────────────────────────────────────────────────
// Returns the subset of tickers whose live signals pass all hard filters.
// Called by runUniverseScan() in day-trading-analysis.js.
function _dtPreFilter(tickers) {
  // Merge defaults with any user-tuned values from state
  const fp = { ...DT_FILTER, ...(state.dayTrading.filterParams || {}) };
  return tickers.filter(t => {
    const s = state.liveSignals[t];
    if (!s || s.error) return false;

    // Signal #1 — price at/near lower Bollinger Band
    if ((s.bb_pct_b ?? 1) > fp.maxBbPctB) return false;

    // Liquidity filter — ADV > threshold AUD
    if ((s.adv_20 ?? 0) < fp.minAdvAud) return false;

    // Trend floor — SMA200 preferred; SMA50 used for stocks < 200 days old (intentionally more lenient for newer listings).
    const ref = s.sma_200 ?? s.sma_50;
    if (ref && s.current_price < ref * fp.sma200Floor) return false;

    // Regime filter — skip stocks already in a strong uptrend (DI+ > DI- confirms direction).
    if ((s.adx ?? 0) > fp.maxAdx && s.trend_strength === 'strong' && s.di_plus > s.di_minus) return false;

    return true;
  });
}
