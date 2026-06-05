// ============================================================
// quant-engine.js — Deterministic trade math (3.1)
//
// computeTradeParams(ticker, signals, portfolioCtx, analystOutput)
//   signals      — state.liveSignals[ticker]
//   portfolioCtx — { allocatedCash, portfolioValue, brokerage, rbaRate }
//   analystOutput — { winProb, expectedTimeToTarget, priceRange?, target? }
//
// Returns { ok:true, ...params } or { ok:false, reason }
// ============================================================

const QUANT_CONFIG = {
  stopAtrMultiple:  2.5,    // ATR multiplier for stop loss
  maxPositionPct:   0.20,   // max 20% of allocatedCash per position
  maxLiquidityPct:  0.05,   // max 5% of ADV20 (share count)
  kellyFraction:    0.25,   // quarter Kelly for safety
  accountRiskPct:   0.01,   // max 1% of capital at risk per trade
  minRrRatio:       2.0,
  minQty:           1,
};

function computeTradeParams(ticker, signals, portfolioCtx, analystOutput) {
  if (!signals || signals.error) return { ok: false, reason: 'no signals for ' + ticker };

  const {
    allocatedCash = 0,
    portfolioValue = 0,
    brokerage = 10,
    rbaRate = 4.35,
  } = portfolioCtx;

  const {
    winProb,
    expectedTimeToTarget = 10,
    priceRange,
    target: analystTarget,
  } = analystOutput;

  if (winProb == null || winProb <= 0) return { ok: false, reason: 'winProb missing' };

  const capital = allocatedCash + portfolioValue;
  const price = signals.current_price;
  const atr   = signals.atr_14;
  // adv_20 is dollar turnover (close × volume); volume_avg_20 is share count.
  // Track both so the liquidity cap below can convert correctly.
  const advAud   = signals.adv_20 ?? null;                    // AUD (dollars)
  const advShares = signals.volume_avg_20
                    ?? (advAud && signals.current_price ? advAud / signals.current_price : null);
  const bbUpper = signals.bb_upper;
  const sr = signals.support_resistance || {};

  if (!price || !atr || atr <= 0) return { ok: false, reason: 'price or ATR unavailable' };

  // ── Stop loss ──────────────────────────────────────────────────────────────
  // Merge state-tuned params over defaults
  const _ap = {
    ...QUANT_CONFIG,
    ...(state.dayTrading?.aiParams || {}),
    ...(state.analysisConfig?.rules || {}),
  };
  // Regime-aware stop multiplier: wider stops in high-vol/risk-off regimes.
  // Explicit user rule overrides regime; regime overrides global default.
  const userStopMult = state.dayTrading?.aiParams?.stopAtrMultiple
                    ?? state.analysisConfig?.rules?.stopAtrMultiple;
  const regimeMod = (state.currentRegime?.regime && typeof getRegimeModifiers === 'function')
    ? getRegimeModifiers(state.currentRegime.regime)
    : {};
  const earningsAdj = signals.pre_earnings_risk ? 1.3 : 1.0;
  const stopMultiple = userStopMult ?? regimeMod.stopAtrMult ?? QUANT_CONFIG.stopAtrMultiple;
  const stopDist = stopMultiple * earningsAdj * atr;
  const stopLoss = +(price - stopDist).toFixed(4);

  // ── Target ─────────────────────────────────────────────────────────────────
  const targetCandidates = [
    analystTarget,
    bbUpper,
    sr.r1,
  ].filter(v => v != null && v > price);

  if (targetCandidates.length === 0) return { ok: false, reason: 'no valid target above entry' };
  const target = Math.min(...targetCandidates);
  const rewardDist = target - price;

  // ── R:R gate ───────────────────────────────────────────────────────────────
  const rrRatio = stopDist > 0 ? +(rewardDist / stopDist).toFixed(2) : 0;
  const minRr = _ap.minRrRatio ?? QUANT_CONFIG.minRrRatio;
  if (rrRatio < minRr) {
    return { ok: false, reason: `R:R ${rrRatio} < minimum ${minRr}` };
  }

  // ── Sizing constraints ─────────────────────────────────────────────────────
  // Risk-based: max 1% of capital at risk
  const riskCapital = capital * (_ap.accountRiskPct ?? QUANT_CONFIG.accountRiskPct);
  const qtyByRisk = Math.floor(riskCapital / stopDist);

  // Position-size cap
  const maxPosPct = _ap.maxPositionPct ?? QUANT_CONFIG.maxPositionPct;
  const qtyByPosition = Math.floor((allocatedCash * maxPosPct) / price);

  // Liquidity cap (5% of 20-day average share volume — in SHARES, not dollars)
  // Fix #29: reject when ADV data is unavailable rather than treating as unconstrained.
  // Infinity liquidity cap allowed full-sized positions in illiquid/new tickers with no
  // volume data — a silent correctness failure. Conservative 1000-share fallback would
  // be too restrictive for watchlist scans; hard reject is safer for real trades.
  if (!advShares || advShares <= 0) {
    return { ok: false, reason: 'ADV data unavailable — liquidity constraint cannot be applied' };
  }
  const qtyByLiquidity = Math.floor(advShares * (_ap.maxLiquidityPct ?? QUANT_CONFIG.maxLiquidityPct));

  // ── Volatility normalisation ───────────────────────────────────────────────
  const atrPct = atr / price;
  const volScalar = Math.min(1, 0.02 / Math.max(atrPct, 0.001));

  // ── Fractional Kelly ──────────────────────────────────────────────────────
  // Kelly f* = (p·b − q) / b, where b = R:R, p = winProb
  const p = Math.min(1, Math.max(0, winProb));
  const q = 1 - p;
  const b = rrRatio;
  // Allow negative Kelly through so we can reject on negative EV before minQty applies.
  const kellyFull = b > 0 ? (p * b - q) / b : 0;
  const kellyFrac = kellyFull * (_ap.kellyFraction ?? QUANT_CONFIG.kellyFraction);
  if (kellyFrac <= 0) {
    return { ok: false, reason: `negative expected value (Kelly=${kellyFull.toFixed(3)}) — skip` };
  }
  const qtyByKelly = Math.floor((capital * kellyFrac) / price);

  // ── VaR1d risk-adjusted size modifier (Fix #38) ───────────────────────────
  // Mirrors the intent of Rule 16 (prompts.js) deterministically so Claude never
  // needs to do qty arithmetic. signals.var_1d is the per-ticker 1-day VaR (negative
  // = loss, e.g. -4.2 means a -4.2% 1-day VaR at 95% confidence level).
  // Only available when the full risk payload is fetched (portfolio analysis, not DT scans).
  const var1d   = signals?.var_1d ?? 0;   // null/undefined → no adjustment (guard below)
  const varMult = (signals?.var_1d != null)
    ? (var1d < -5.0 ? 0.50 : var1d < -3.5 ? 0.75 : 1.0)
    : 1.0;

  // ── Final qty ──────────────────────────────────────────────────────────────
  const rawQtyBase = Math.min(qtyByRisk, qtyByPosition, qtyByLiquidity, qtyByKelly);
  const rawQty = varMult < 1.0 ? Math.floor(rawQtyBase * varMult) : rawQtyBase;
  const qty = Math.max(QUANT_CONFIG.minQty, Math.floor(rawQty * volScalar));

  if (qty <= 0) return { ok: false, reason: 'sizing constraints reject trade (qty=0)' };

  // Which constraint is binding?
  const scaledByRisk     = Math.floor(qtyByRisk * volScalar);
  const scaledByPosition = Math.floor(qtyByPosition * volScalar);
  const scaledByKelly    = Math.floor(qtyByKelly * volScalar);
  const constraintBinding =
    qty <= scaledByRisk     && qty === scaledByRisk     ? 'accountRisk%' :
    qty <= scaledByPosition && qty === scaledByPosition ? 'maxPosition%' :
    qty <= scaledByKelly    && qty === scaledByKelly    ? 'kelly' :
    'liquidity';

  // ── EV calculation ─────────────────────────────────────────────────────────
  const riskAUD   = qty * stopDist;
  const rewardAUD = qty * rewardDist;
  const evGross   = p * rewardAUD - q * riskAUD;

  // Opportunity cost: cash tied up × RBA rate × hold period
  const holdDays = expectedTimeToTarget;
  const oppCost = qty * price * (rbaRate / 100) * (holdDays / 365);
  const roundTripBrok = brokerage * 2;
  const evNet = +(evGross - oppCost - roundTripBrok).toFixed(2);

  // ── Scenarios ──────────────────────────────────────────────────────────────
  const scenarios = [
    { label: 'Bull',  prob: +(p * 0.65).toFixed(2), priceTarget: +(target + atr).toFixed(3) },
    { label: 'Base',  prob: +(p * 0.35).toFixed(2), priceTarget: +target.toFixed(3) },
    { label: 'Bear',  prob: +(q * 0.80).toFixed(2), priceTarget: +stopLoss.toFixed(3) },
    { label: 'Panic', prob: +(q * 0.20).toFixed(2), priceTarget: +(stopLoss - 2 * atr).toFixed(3) },
  ];

  return {
    ok: true,
    ticker,
    entryPrice: +price.toFixed(4),
    priceRange: priceRange ?? [+(price - atr * 0.5).toFixed(3), +(price + atr * 0.5).toFixed(3)],
    stopLoss,
    target: +target.toFixed(4),
    qty,
    rrRatio,
    riskAUD: +riskAUD.toFixed(2),
    rewardAUD: +rewardAUD.toFixed(2),
    evNet,
    kellyFraction: +kellyFrac.toFixed(4),
    volScalar: +volScalar.toFixed(3),
    constraintBinding,
    scenarios,
    holdDays,
    winProb: p,
    ...(earningsAdj > 1 ? { _preEarningsAdj: true } : {}),
    ...(varMult < 1.0   ? { _varAdjusted: true, _varMult: varMult } : {}),
  };
}

// identifyBindingConstraint — helper used in error messages
function identifyBindingConstraint(qtys) {
  const min = Math.min(...Object.values(qtys).filter(v => v > 0));
  for (const [k, v] of Object.entries(qtys)) {
    if (v === min) return k;
  }
  return 'unknown';
}
