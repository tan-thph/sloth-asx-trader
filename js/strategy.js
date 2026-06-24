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
  sma200Floor:  0.985,  // price must be ≥ SMA200 × this (within ~1.5% of long-term trend)
  sma50Floor:   0.970,  // fallback floor when SMA200 unavailable (stocks < 200 days old)
                        // 3% from SMA50 compensates for SMA50 being much closer to price
  maxAdx:        35,    // ADX ceiling — skip stocks already in a strong rip
  minAdr:        0.25,  // §2.7 market breadth gate — suppress ALL new swing BUYs when
                        // advance_decline_ratio < this (set 0 to disable)
  vovMult:       1.3,   // §2.8 VoV filter — skip when atr_14 > vovMult × atr_5d_mean
                        // (ATR expanding rapidly = stop distances already stale; 0 disables)
  timeOfWeekFilter: true, // §2.9 — block new entries Mon <11:00 / Fri ≥14:00 AEST (false disables)
};

// ── AI-phase parameters ────────────────────────────────────────────────────────
// Read by the prompt builder and downstream logic — not used in _dtPreFilter().
const DT_AI_PARAMS = {
  minRrRatio:      2.0,  // minimum reward:risk ratio
  minConfidence:   0.50, // minimum AI confidence to accept a rec
  stopAtrMultiple: 2.5,  // stop loss = entry − stopAtrMultiple × ATR14
};

// ── Rule enable/disable ────────────────────────────────────────────────────────
// Every individual pre-filter/signal rule can be toggled off independently
// (Day Trading -> Rules, table with a checkbox per row) rather than only
// loosened by threshold value. A disabled rule is skipped entirely — it never
// rejects a candidate, regardless of its configured threshold. Defaults to
// enabled (true) so existing saved params without an `enabled` map behave
// exactly as before this feature shipped.
function _ruleOn(paramsObj, key) {
  return !(paramsObj && paramsObj.enabled && paramsObj.enabled[key] === false);
}

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
    if (_ruleOn(fp, 'maxBbPctB') && (s.bb_pct_b ?? 1) > fp.maxBbPctB) return false;

    // Liquidity filter — ADV > threshold AUD
    if (_ruleOn(fp, 'minAdvAud') && (s.adv_20 ?? 0) < fp.minAdvAud) return false;

    // Trend floor — SMA200 preferred; SMA50 is the fallback for stocks < 200 days old.
    // Uses a tighter floor for SMA50 (0.970 vs 0.985) because SMA50 is naturally much
    // closer to the current price, so a 1.5% floor would be almost meaningless.
    const ref = s.sma_200 ?? s.sma_50;
    const usingSma200 = !!s.sma_200;
    const trendFloor = usingSma200 ? fp.sma200Floor : (fp.sma50Floor ?? 0.970);
    const trendRuleOn = usingSma200 ? _ruleOn(fp, 'sma200Floor') : _ruleOn(fp, 'sma50Floor');
    if (trendRuleOn && ref && s.current_price < ref * trendFloor) return false;

    // Regime filter — skip stocks already in a strong uptrend (DI+ > DI- confirms direction).
    if (_ruleOn(fp, 'maxAdx') && (s.adx ?? 0) > fp.maxAdx && s.trend_strength === 'strong' && s.di_plus > s.di_minus) return false;

    // §2.8 VoV filter — ATR expanding rapidly vs its recent baseline means the
    // noise-floor estimate behind the stop distance is already stale. Skip.
    if (_ruleOn(fp, 'vovMult') && (fp.vovMult ?? 0) > 0 && s.atr_14 != null && s.atr_5d_mean != null
        && s.atr_5d_mean > 0 && s.atr_14 > fp.vovMult * s.atr_5d_mean) return false;

    return true;
  });
}
