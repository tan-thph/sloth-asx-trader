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
  const atrStopDist = stopMultiple * earningsAdj * atr;
  // ── Overnight gap risk floor ───────────────────────────────────────────────
  // gap95_pct is the 95th-percentile overnight gap from 252-day history (decimal,
  // e.g. 0.025 = 2.5%). RiskPerShare = max(ATR stop, gap95 floor).
  const gap95Pct  = (signals && signals.gap95_pct) ? signals.gap95_pct : 0;
  const gap95Dist = gap95Pct * price;
  const gapRiskActive = gap95Dist > atrStopDist && gap95Dist > 0;
  const stopDist  = Math.max(atrStopDist, gap95Dist);
  const stopLoss  = +(price - stopDist).toFixed(4);

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
  // Hard max position weight is a % of NET WORTH (cash + total holdings value),
  // not allocatedCash alone — a position can only be "15% of the portfolio" if
  // the portfolio includes the cash sitting alongside it. `capital` above is
  // already allocatedCash + portfolioValue, i.e. net worth.
  const maxPosPct = _ap.maxPositionPct ?? QUANT_CONFIG.maxPositionPct;
  const qtyByPosition = Math.floor((capital * maxPosPct) / price);

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
  // ── Kelly phase gate ──────────────────────────────────────────────────────
  // Phase 1 (<200 completed trades): cap Kelly at 0.10. High uncertainty —
  // win-rate and R:R estimates are noisy on small samples.
  // Phase 2 (≥200 trades): unlock up to 0.25 Kelly when statistics stabilise.
  // _dtStats is loaded by dt-training.js; safe to read at call time (post-load).
  var _nCompleted = (typeof _dtStats !== 'undefined' && _dtStats && typeof _dtStats.completed === 'number')
    ? _dtStats.completed : 0;
  var _kellyPhaseFrac = _nCompleted >= 200 ? 0.25 : 0.10;
  var _kellyPhase = _nCompleted >= 200 ? 2 : 1;
  const configuredFrac = _ap.kellyFraction != null ? _ap.kellyFraction : QUANT_CONFIG.kellyFraction;
  const kellyFrac = kellyFull * Math.min(configuredFrac, _kellyPhaseFrac);
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

  // Audit fix #1: the zero-reject check MUST run on the pre-floor value. Any of
  // qtyByRisk/qtyByPosition/qtyByLiquidity/qtyByKelly legitimately computing to 0
  // (stop too tight for the risk budget, position too small relative to ADV, etc.)
  // is a hard reject — Math.max(minQty, ...) below would otherwise silently force
  // a 1-share trade through a constraint that was supposed to block it entirely.
  // volScalar is always > 0 (Math.min(1, 0.02/Math.max(atrPct,0.001))), so it can
  // only shrink a positive rawQty toward zero by rounding, never flip a genuine
  // zero/negative rawQty into a false positive.
  if (rawQty * volScalar <= 0) return { ok: false, reason: 'sizing constraints reject trade (qty=0)' };
  let qty = Math.max(QUANT_CONFIG.minQty, Math.floor(rawQty * volScalar));

  // ── Minimum trade size floor ────────────────────────────────────────────
  // state.settings.minTradeSize is a user-configured floor on trade notional
  // (Settings → "Min trade size ($)"). Kelly/vol-scalar sizing above can
  // legitimately land on a qty worth far less than that (e.g. 1 share of a
  // $180 stock) — nothing upstream ever consulted this setting on the normal
  // success path (it was only used as a decline-path fallback in analysis.js).
  // Bump qty up to meet the floor, but never past the hard risk/position/
  // liquidity caps — those are safety constraints, not preferences, and must
  // never be overridden by a sizing convenience setting (same principle as
  // gotcha #25: a floor must never silently defeat a harder constraint).
  const minTradeSize = Number(state.settings?.minTradeSize) || 0;
  let _minTradeSizeBumped = false;
  if (minTradeSize > 0 && qty * price < minTradeSize) {
    const hardCapBase = Math.min(qtyByRisk, qtyByPosition, qtyByLiquidity);
    const hardCapAfterVar = varMult < 1.0 ? Math.floor(hardCapBase * varMult) : hardCapBase;
    const hardCapScaled = Math.floor(hardCapAfterVar * volScalar);
    const minQtyForNotional = Math.ceil(minTradeSize / price);
    if (minQtyForNotional > hardCapScaled) {
      return {
        ok: false,
        reason: `min trade size $${minTradeSize} needs ${minQtyForNotional} sh @ $${price.toFixed(2)} but risk/position/liquidity caps allow only ${hardCapScaled} sh`,
      };
    }
    qty = minQtyForNotional;
    _minTradeSizeBumped = true;
  }

  // Which constraint is binding?
  const scaledByRisk     = Math.floor(qtyByRisk * volScalar);
  const scaledByPosition = Math.floor(qtyByPosition * volScalar);
  const scaledByKelly    = Math.floor(qtyByKelly * volScalar);
  const constraintBinding = _minTradeSizeBumped ? 'minTradeSize' :
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
    ...(_minTradeSizeBumped ? { _minTradeSizeBumped: true } : {}),
    _gapRiskActive:      gapRiskActive,
    gap95Pct:            +gap95Pct.toFixed(5),
    _kellyPhase:         _kellyPhase,
    _kellyPhaseFrac:     _kellyPhaseFrac,
    nCompletedTrades:    _nCompleted,
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
