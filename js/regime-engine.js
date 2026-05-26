// ============================================================
// regime-engine.js — Deterministic market regime classifier (3.2)
//
// classifyRegime(macroData) → { regime, confidence, signals[] }
// isStrategyAllowed(strategy, regime) → boolean
// getRegimeModifiers(regime) → { confBoost, sizeMult, maxNewPositions, warning }
// applyRegimeModifiers(rec, regime) → adjusted rec copy
// fetchAndClassifyRegime() → async, updates state.currentRegime
// ============================================================

const REGIME_THRESHOLDS = {
  vixPanic:       30,   // VIX > this AND A/D < 0.3 → panic
  vixHighVol:     22,   // VIX > this → highVol
  asx200Trend5d:   2.0, // 5d |return| > this % → directional bias
  asx200Trend20d:  4.0, // 20d |return| > this % → confirmed trend
  adx200Trend:    25,   // ASX200 ADX > this → trending (not sideways)
  adrBullish:      0.6, // advance/decline ratio > → breadth OK
  adrBearish:      0.3, // advance/decline ratio < → breadth weak
  atrPctHighVol:   1.5, // ASX200 ATR% > this → intraday volatility elevated
  riskOffReturn5d: -2.0, // ASX200 5d return < this → risk-off
  riskOnReturn5d:   1.0, // ASX200 5d return > this (+ good A/D) → risk-on
};

// classifyRegime — reads extended macro fields added by the updated /api/macro endpoint.
// Falls back gracefully if fields are missing (returns 'unknown' with confidence 0).
function classifyRegime(macroData) {
  if (!macroData) return { regime: 'unknown', confidence: 0, signals: [] };

  const vix       = macroData.vix?.value;
  const ret5d     = macroData.asx200_5d_return;
  const ret20d    = macroData.asx200_20d_return;
  const atrPct    = macroData.asx200_atr_pct;
  const adx       = macroData.asx200_adx;
  const adr       = macroData.advance_decline_ratio;
  const audChg5d  = macroData.aud_usd_change_5d;
  const ironChg5d = macroData.iron_ore_change_5d;

  const signals = [];
  const votes = { riskOn: 0, riskOff: 0, panic: 0, highVol: 0, trend: 0, sideways: 0 };

  const vote = (regime, weight, signal) => {
    votes[regime] = (votes[regime] || 0) + weight;
    signals.push(signal);
  };

  // ── Panic check (hard override) ───────────────────────────────────────────
  if (vix != null && vix > REGIME_THRESHOLDS.vixPanic && adr != null && adr < REGIME_THRESHOLDS.adrBearish) {
    vote('panic', 5, `VIX ${vix.toFixed(1)} + A/D ${adr.toFixed(2)} → PANIC`);
  }

  // ── VIX ───────────────────────────────────────────────────────────────────
  if (vix != null) {
    if (vix > REGIME_THRESHOLDS.vixHighVol) {
      vote('highVol', 2, `VIX ${vix.toFixed(1)} > ${REGIME_THRESHOLDS.vixHighVol} → elevated volatility`);
    } else if (vix < 16) {
      vote('riskOn', 1, `VIX ${vix.toFixed(1)} < 16 → complacency / risk-on`);
    }
  }

  // ── ATR% ─────────────────────────────────────────────────────────────────
  if (atrPct != null && atrPct > REGIME_THRESHOLDS.atrPctHighVol) {
    vote('highVol', 1, `ASX200 ATR ${atrPct.toFixed(2)}% > ${REGIME_THRESHOLDS.atrPctHighVol} → intraday vol`);
  }

  // ── 5d return ────────────────────────────────────────────────────────────
  if (ret5d != null) {
    if (ret5d < REGIME_THRESHOLDS.riskOffReturn5d) {
      vote('riskOff', 2, `ASX200 5d: ${ret5d.toFixed(1)}% < ${REGIME_THRESHOLDS.riskOffReturn5d}% → risk-off`);
    } else if (ret5d > REGIME_THRESHOLDS.riskOnReturn5d) {
      vote('riskOn', 2, `ASX200 5d: ${ret5d.toFixed(1)}% > ${REGIME_THRESHOLDS.riskOnReturn5d}% → momentum`);
    } else {
      vote('sideways', 1, `ASX200 5d: ${ret5d.toFixed(1)}% → directionless`);
    }
  }

  // ── 20d return ───────────────────────────────────────────────────────────
  if (ret20d != null) {
    if (Math.abs(ret20d) > REGIME_THRESHOLDS.asx200Trend20d) {
      vote('trend', 2, `ASX200 20d: ${ret20d.toFixed(1)}% → confirmed ${ret20d > 0 ? 'up' : 'down'}trend`);
    }
    if (ret20d < -5) {
      vote('riskOff', 1, `ASX200 20d: ${ret20d.toFixed(1)}% → sustained weakness`);
    }
  }

  // ── ADX ──────────────────────────────────────────────────────────────────
  if (adx != null) {
    if (adx > REGIME_THRESHOLDS.adx200Trend) {
      vote('trend', 1, `ASX200 ADX ${adx.toFixed(1)} > ${REGIME_THRESHOLDS.adx200Trend} → trending`);
    } else {
      vote('sideways', 1, `ASX200 ADX ${adx.toFixed(1)} ≤ ${REGIME_THRESHOLDS.adx200Trend} → sideways`);
    }
  }

  // ── Advance / Decline ────────────────────────────────────────────────────
  if (adr != null) {
    if (adr > REGIME_THRESHOLDS.adrBullish) {
      vote('riskOn', 1, `A/D ratio ${adr.toFixed(2)} → breadth supportive`);
    } else if (adr < REGIME_THRESHOLDS.adrBearish) {
      vote('riskOff', 1, `A/D ratio ${adr.toFixed(2)} → breadth collapsing`);
    }
  }

  // ── Commodity / FX risk-off signals ─────────────────────────────────────
  if (ret5d != null && ret5d < REGIME_THRESHOLDS.riskOffReturn5d) {
    if (ironChg5d != null && ironChg5d < -3) {
      vote('riskOff', 1, `Iron ore ${ironChg5d.toFixed(1)}% 5d → commodity stress`);
    }
    if (audChg5d != null && audChg5d < -1) {
      vote('riskOff', 1, `AUD/USD ${audChg5d.toFixed(2)}% 5d → risk currency weakness`);
    }
  }

  // ── Panic hard override ───────────────────────────────────────────────────
  if (votes.panic >= 5) {
    return { regime: 'panic', confidence: 1.0, signals };
  }

  // ── Pick winner ───────────────────────────────────────────────────────────
  const total = Object.values(votes).reduce((s, v) => s + v, 0);
  if (total === 0) return { regime: 'unknown', confidence: 0, signals };

  const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const regime = sorted[0][0];
  const confidence = +(sorted[0][1] / total).toFixed(2);

  return { regime, confidence, signals };
}

// Strategy gate — which regimes allow which strategies
const _STRATEGY_GATES = {
  meanReversionSwing: ['riskOn', 'sideways', 'highVol'],
  momentumBreakout:   ['riskOn', 'trend'],
  portfolioAnalysis:  ['riskOn', 'riskOff', 'sideways', 'trend', 'highVol'],
};

function isStrategyAllowed(strategy, regime) {
  if (regime === 'panic') return false;
  const allowed = _STRATEGY_GATES[strategy] || [];
  return allowed.includes(regime);
}

// getRegimeModifiers — scaling factors and warnings per regime
function getRegimeModifiers(regime) {
  switch (regime) {
    case 'riskOn':   return { confBoost: 0,    sizeMult: 1.0,  maxNewPositions: 5, warning: null };
    case 'trend':    return { confBoost: 0,    sizeMult: 1.1,  maxNewPositions: 4, warning: null };
    case 'sideways': return { confBoost: 0.05, sizeMult: 0.80, maxNewPositions: 3, warning: 'Sideways — tighten confidence bar, reduce sizing' };
    case 'highVol':  return { confBoost: 0.08, sizeMult: 0.60, maxNewPositions: 2, warning: 'High vol — smaller positions; expect wider stops' };
    case 'riskOff':  return { confBoost: 0.10, sizeMult: 0.50, maxNewPositions: 1, warning: 'Risk-off — minimal new exposure; prefer cash' };
    case 'panic':    return { confBoost: 1.00, sizeMult: 0,    maxNewPositions: 0, warning: 'PANIC — no new positions. Hold cash.' };
    default:         return { confBoost: 0.05, sizeMult: 0.90, maxNewPositions: 3, warning: 'Regime unknown — conservative defaults applied' };
  }
}

// applyRegimeModifiers — adjusts a rec copy; returns the adjusted rec
function applyRegimeModifiers(rec, regime) {
  if (!rec) return rec;
  const mod = getRegimeModifiers(regime);
  const out = { ...rec };
  if (mod.sizeMult === 0) {
    // Hard block — panic regime / zero allocation. Surface as a rejected rec
    // so callers can omit it cleanly instead of seeing a forced qty=1.
    out.qty = 0;
    out._regimeBlocked = regime;
    out._regimeAdjusted = true;
  } else if (mod.sizeMult !== 1.0 && out.qty) {
    out.qty = Math.max(1, Math.floor(out.qty * mod.sizeMult));
    out._regimeAdjusted = true;
  }
  if (mod.warning) {
    out.reasoning = [...(Array.isArray(out.reasoning) ? out.reasoning : [out.reasoning || '']), `[REGIME:${regime}] ${mod.warning}`];
  }
  return out;
}

// fetchAndClassifyRegime — fetches macro data and updates state.currentRegime
const _regimeCache = { regime: 'unknown', confidence: 0, signals: [], fetchedAt: null };

async function fetchAndClassifyRegime() {
  if (!state.serverOk) return _regimeCache;
  // Skip if fetched within last 15 minutes
  if (_regimeCache.fetchedAt && Date.now() - _regimeCache.fetchedAt < 15 * 60 * 1000) {
    return _regimeCache;
  }
  try {
    const r = await fetch(`${API}/api/macro`);
    if (!r.ok) return _regimeCache;
    const d = await r.json();
    state.macroData = { ...(state.macroData || {}), ...d };
    const result = classifyRegime(d);
    Object.assign(_regimeCache, result, { fetchedAt: Date.now() });
    state.currentRegime = { ..._regimeCache };
  } catch (e) {
    console.warn('fetchAndClassifyRegime failed:', e.message);
  }
  return _regimeCache;
}
