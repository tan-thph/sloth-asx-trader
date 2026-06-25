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
  vixPanic:           30,   // VIX > this AND A/D < 0.3 → panic
  vixHighVol:         22,   // VIX > this → highVol
  asx200Trend5d:       2.0, // 5d |return| > this % → directional bias
  asx200Trend20d:      4.0, // 20d |return| > this % → confirmed trend
  adx200Trend:        25,   // ASX200 ADX > this → trending (not sideways)
  adrBullish:          0.6, // advance/decline ratio > → breadth OK
  adrBearish:          0.3, // advance/decline ratio < → breadth weak
  atrPctHighVol:       1.5, // ASX200 ATR% > this → intraday volatility elevated
  riskOffReturn5d:    -2.0, // ASX200 5d return < this → risk-off
  riskOnReturn5d:      1.0, // ASX200 5d return > this (+ good A/D) → risk-on
  spiFuturesRiskOff:  -1.5, // SPI200 futures vs spot < this % → expected weak open
  spiFuturesRiskOn:    1.0, // SPI200 futures vs spot > this % → expected strong open
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
  const asxVol20d = macroData.asx_vol_20d;
  const spiChg    = macroData.spi200_futures_chg;

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

  // ── A-VIX: ASX 20-day realized volatility ────────────────────────────────
  if (asxVol20d != null) {
    if (asxVol20d > 25) {
      vote('highVol', 2, `A-VIX ${asxVol20d.toFixed(1)}% > 25 → elevated ASX realised vol`);
    } else if (asxVol20d < 12) {
      vote('riskOn', 1, `A-VIX ${asxVol20d.toFixed(1)}% < 12 → low ASX vol / risk-on`);
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

  // ── SPI200 futures (lead indicator — moves overnight before ASX opens) ──────
  if (spiChg != null) {
    if (spiChg < REGIME_THRESHOLDS.spiFuturesRiskOff) {
      vote('riskOff', 2, `SPI200 futures ${spiChg.toFixed(1)}% vs spot → expected weak open`);
    } else if (spiChg > REGIME_THRESHOLDS.spiFuturesRiskOn) {
      vote('riskOn', 1, `SPI200 futures ${spiChg.toFixed(1)}% vs spot → expected strong open`);
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
    case 'riskOn':   return { confBoost: 0,    sizeMult: 1.0,  maxNewPositions: 5, stopAtrMult: 2.5, warning: null };
    case 'trend':    return { confBoost: 0,    sizeMult: 1.1,  maxNewPositions: 4, stopAtrMult: 2.5, warning: null };
    case 'sideways': return { confBoost: 0.05, sizeMult: 0.80, maxNewPositions: 3, stopAtrMult: 2.5, warning: 'Sideways — tighten confidence bar, reduce sizing' };
    case 'highVol':  return { confBoost: 0.08, sizeMult: 0.60, maxNewPositions: 2, stopAtrMult: 3.0, warning: 'High vol — smaller positions; expect wider stops' };
    case 'riskOff':  return { confBoost: 0.10, sizeMult: 0.50, maxNewPositions: 1, stopAtrMult: 3.5, warning: 'Risk-off — minimal new exposure; prefer cash' };
    case 'panic':    return { confBoost: 1.00, sizeMult: 0,    maxNewPositions: 0, stopAtrMult: 4.0, warning: 'PANIC — no new positions. Hold cash.' };
    default:         return { confBoost: 0.05, sizeMult: 0.90, maxNewPositions: 3, stopAtrMult: 2.5, warning: 'Regime unknown — conservative defaults applied' };
  }
}

// applyRegimeModifiers — adjusts a rec copy; returns the adjusted rec
function applyRegimeModifiers(rec, regime) {
  if (!rec) return rec;
  const mod = getRegimeModifiers(regime);
  const out = { ...rec };
  if (mod.sizeMult === 0) {
    // Panic: always an immediate hard-block, never blended
    out.qty = 0;
    out._regimeBlocked = regime;
    out._regimeAdjusted = true;
  } else {
    // Use blended sizeMult during a post-flip transition window, full mult otherwise
    const sizeMult = state.currentRegime?._blendedSizeMult ?? mod.sizeMult;
    if (sizeMult !== 1.0 && out.qty) {
      out.qty = Math.max(1, Math.floor(out.qty * sizeMult));
      out._regimeAdjusted = true;
      if (state.currentRegime?._blendedSizeMult != null) out._regimeBlending = true;
    }
  }
  if (mod.warning) {
    // `reasoning` must stay a plain string — every consumer (analysis.js's
    // summary builder, the rec-card renderer, escapeHTML, etc.) calls string
    // methods on it directly. Wrapping it in an array here used to break all
    // of them downstream with "(r.reasoning || '').replace is not a
    // function" the moment a regime warning fired. Coerce any pre-existing
    // array (e.g. from stale/legacy data) back to a string before appending.
    const base = Array.isArray(out.reasoning) ? out.reasoning.join(' ') : (out.reasoning || '');
    out.reasoning = `${base} [REGIME:${regime}] ${mod.warning}`.trim();
  }
  return out;
}

// fetchAndClassifyRegime — fetches macro data and updates state.currentRegime
const _BLEND_WINDOW_MS = 30 * 60 * 1000;  // 30-min linear blend after a non-panic regime flip
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
    const prevRegime = _regimeCache.regime;
    const now = Date.now();

    // Track regime transitions for size-multiplier blending.
    // Panic is always an immediate hard-block — never blended.
    if (prevRegime !== result.regime) {
      if (result.regime === 'panic') {
        _regimeCache._regimeFlippedAt = null;
        _regimeCache._prevSizeMult    = null;
      } else if (prevRegime !== 'unknown') {
        _regimeCache._regimeFlippedAt = now;
        // Audit fix #10: if a previous blend was still in progress when this
        // second flip arrived, seed the new blend from the ACTUAL currently-
        // blended value, not prevRegime's full (completed) multiplier — using
        // the full value discarded the in-progress interpolation and produced
        // a discontinuity (cliff-edge) rather than a smooth hand-off between
        // two fast successive flips. When no blend was in progress (the prior
        // regime had been stable ≥30min, or this is the very first flip),
        // _blendedSizeMult is null and the full multiplier is correct as-is.
        _regimeCache._prevSizeMult = _regimeCache._blendedSizeMult ?? getRegimeModifiers(prevRegime).sizeMult;
      }
    }

    Object.assign(_regimeCache, result, { fetchedAt: now });

    // Recompute blended sizeMult — advances on each 15-min fetch within the window
    if (_regimeCache._regimeFlippedAt != null && _regimeCache._prevSizeMult != null) {
      const elapsed = now - _regimeCache._regimeFlippedAt;
      if (elapsed < _BLEND_WINDOW_MS) {
        const t = elapsed / _BLEND_WINDOW_MS;
        const newMult = getRegimeModifiers(_regimeCache.regime).sizeMult;
        _regimeCache._blendedSizeMult = +(_regimeCache._prevSizeMult + (newMult - _regimeCache._prevSizeMult) * t).toFixed(3);
      } else {
        _regimeCache._regimeFlippedAt = null;
        _regimeCache._prevSizeMult    = null;
        _regimeCache._blendedSizeMult = null;
      }
    } else {
      _regimeCache._blendedSizeMult = null;
    }

    state.currentRegime = { ..._regimeCache };

    // When regime flips, write the flip timestamp + new regime to localStorage so
    // fetchCalibrationBlock() can pass them to the backend as query params.
    // The backend uses them to temporarily halve the calibration half-life for
    // the first <10 trades in the new regime (Sprint 44).
    if (prevRegime !== 'unknown' && prevRegime !== result.regime) {
      localStorage.setItem('regime_flipped_at', new Date().toISOString());
      localStorage.setItem('regime_flipped_to', result.regime);
    }

    // Alert when regime flips to panic or riskOff
    if (prevRegime !== 'unknown' && prevRegime !== result.regime) {
      if (result.regime === 'panic' || result.regime === 'riskOff') {
        const label = result.regime === 'panic' ? '🚨 PANIC' : '⚠ Risk-Off';
        if (typeof fireAlert === 'function') {
          fireAlert(
            `${label} Regime Detected`,
            `Market regime changed: ${prevRegime} → ${result.regime}. Consider reducing exposure.`,
            'sloth-regime'
          );
        }
      }
    }
  } catch (e) {
    console.warn('fetchAndClassifyRegime failed:', e.message);
  }
  return _regimeCache;
}
