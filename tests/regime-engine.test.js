/**
 * tests/regime-engine.test.js
 *
 * Tests for classifyRegime(), getRegimeModifiers(), and applyRegimeModifiers()
 * — the deterministic market regime classifier.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Full macro payload with all fields set to neutral/baseline values. */
function makeMacro(overrides = {}) {
  return {
    vix:                { value: 15 },
    asx200_5d_return:   0.5,
    asx200_20d_return:  1.0,
    asx200_atr_pct:     0.8,
    asx200_adx:         20,
    advance_decline_ratio: 0.65,
    aud_usd_change_5d:  0.1,
    iron_ore_change_5d: 0.5,
    asx_vol_20d:        11,    // below 12 → riskOn vote
    ...overrides,
  };
}

// ── classifyRegime ────────────────────────────────────────────────────────────

describe('classifyRegime — null / missing data', () => {
  it('returns unknown with confidence 0 when macroData is null', () => {
    const r = classifyRegime(null);
    expect(r.regime).toBe('unknown');
    expect(r.confidence).toBe(0);
  });

  it('returns unknown with confidence 0 when macroData is empty', () => {
    const r = classifyRegime({});
    expect(r.regime).toBe('unknown');
    expect(r.confidence).toBe(0);
  });

  it('always returns a signals array', () => {
    expect(Array.isArray(classifyRegime(null).signals)).toBe(true);
    expect(Array.isArray(classifyRegime({}).signals)).toBe(true);
  });
});

describe('classifyRegime — panic hard override', () => {
  it('returns panic when VIX > 30 AND A/D < 0.3', () => {
    const r = classifyRegime(makeMacro({
      vix: { value: 35 },
      advance_decline_ratio: 0.15,
    }));
    expect(r.regime).toBe('panic');
    expect(r.confidence).toBe(1.0);
  });

  it('does NOT return panic when VIX is high but A/D is OK', () => {
    const r = classifyRegime(makeMacro({
      vix: { value: 35 },
      advance_decline_ratio: 0.65,
    }));
    expect(r.regime).not.toBe('panic');
  });

  it('does NOT return panic when A/D is low but VIX is normal', () => {
    const r = classifyRegime(makeMacro({
      vix: { value: 18 },
      advance_decline_ratio: 0.15,
    }));
    expect(r.regime).not.toBe('panic');
  });
});

describe('classifyRegime — riskOff signals', () => {
  it('classifies as riskOff when ASX200 5d return < −2%', () => {
    const r = classifyRegime(makeMacro({
      asx200_5d_return: -3.0,
      asx_vol_20d: 20,             // neutral, no riskOn vote from A-VIX
      vix: { value: 18 },          // 16–22: no riskOn VIX vote
      advance_decline_ratio: 0.45, // between 0.3 and 0.6: no A/D vote
    }));
    expect(r.regime).toBe('riskOff');
  });

  it('includes regime signals in the returned array', () => {
    const r = classifyRegime(makeMacro({ asx200_5d_return: -3.0, asx_vol_20d: 20 }));
    expect(r.signals.some(s => s.includes('risk-off'))).toBe(true);
  });
});

describe('classifyRegime — riskOn signals', () => {
  it('classifies as riskOn when 5d return > 1% and breadth is good', () => {
    const r = classifyRegime(makeMacro({
      asx200_5d_return: 2.0,
      advance_decline_ratio: 0.70,
      vix: { value: 14 },         // below 16 → riskOn
      asx_vol_20d: 10,             // below 12 → riskOn
    }));
    expect(r.regime).toBe('riskOn');
  });
});

describe('classifyRegime — highVol signals', () => {
  it('classifies as highVol when VIX > 22 (without panic A/D)', () => {
    const r = classifyRegime(makeMacro({
      vix: { value: 25 },
      advance_decline_ratio: 0.50,
      asx200_5d_return: 0.3,      // directionless — sideways vote
      asx_vol_20d: 30,             // A-VIX > 25 → highVol
    }));
    expect(r.regime).toBe('highVol');
  });

  it('classifies as highVol when A-VIX > 25', () => {
    const r = classifyRegime(makeMacro({
      asx_vol_20d: 28,
      vix: { value: 16 },
      asx200_5d_return: 0.3,
    }));
    expect(r.regime).toBe('highVol');
  });
});

describe('classifyRegime — trend signals', () => {
  it('classifies as trend when 20d return > 4%', () => {
    const r = classifyRegime(makeMacro({
      asx200_20d_return: 5.0,
      asx200_adx: 30,              // ADX > 25 → trend +1
      asx200_5d_return: 0.5,       // directionless → sideways vote, not riskOn
      vix: { value: 17 },          // 16–22: no riskOn VIX vote
      asx_vol_20d: 15,             // ≥ 12: no riskOn A-VIX vote
      advance_decline_ratio: 0.50, // between 0.3 and 0.6: no A/D vote
    }));
    expect(r.regime).toBe('trend');
  });
});

describe('classifyRegime — tie-break goes to the more defensive regime', () => {
  it('a riskOff/riskOn vote tie classifies as riskOff, not riskOn', () => {
    // Construct an exact 2–2 tie: 5d return < −2% → riskOff +2;
    // VIX < 16 → riskOn +1; A/D > 0.6 → riskOn +1. Everything else neutral.
    const r = classifyRegime(makeMacro({
      asx200_5d_return: -3.0,       // riskOff +2
      vix: { value: 14 },           // riskOn +1
      advance_decline_ratio: 0.70,  // riskOn +1
      asx_vol_20d: 20,              // neutral — no A-VIX vote
      asx200_20d_return: 1.0,       // no trend/riskOff vote
      asx200_adx: null,             // no ADX vote (would add sideways)
      asx200_atr_pct: 0.8,          // no highVol vote
      iron_ore_change_5d: 0.5,      // no commodity riskOff vote
      aud_usd_change_5d: 0.1,       // no FX riskOff vote
    }));
    // Sanity: it must be one of the two tied regimes, and the defensive one wins.
    expect(['riskOff', 'riskOn']).toContain(r.regime);
    expect(r.regime).toBe('riskOff');
  });
});

describe('classifyRegime — confidence is a value in (0, 1]', () => {
  it('confidence is within (0, 1] when regime is determined', () => {
    const r = classifyRegime(makeMacro({ asx200_5d_return: -3.0, asx_vol_20d: 20 }));
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });
});

// isStrategyAllowed / _STRATEGY_GATES were deleted as dead code (Audit B3, 2026-07-13)
// — no production call site; day-trade gating is via DT_FILTER, panic gating via
// applyRegimeModifiers. Tests removed alongside the implementation.

// ── getRegimeModifiers ────────────────────────────────────────────────────────

describe('getRegimeModifiers', () => {
  it('returns sizeMult=0 for panic', () => {
    const m = getRegimeModifiers('panic');
    expect(m.sizeMult).toBe(0);
    expect(m.maxNewPositions).toBe(0);
  });

  it('returns sizeMult=1.0 for riskOn (no adjustment needed)', () => {
    expect(getRegimeModifiers('riskOn').sizeMult).toBe(1.0);
  });

  it('returns sizeMult=1.1 for trend (slight boost)', () => {
    expect(getRegimeModifiers('trend').sizeMult).toBe(1.1);
  });

  it('returns sizeMult < 1 for riskOff and highVol', () => {
    expect(getRegimeModifiers('riskOff').sizeMult).toBeLessThan(1);
    expect(getRegimeModifiers('highVol').sizeMult).toBeLessThan(1);
  });

  it('returns a warning string for all risk-reducing regimes', () => {
    for (const r of ['sideways', 'highVol', 'riskOff', 'panic']) {
      expect(typeof getRegimeModifiers(r).warning).toBe('string');
    }
  });

  it('returns null warning for riskOn and trend', () => {
    expect(getRegimeModifiers('riskOn').warning).toBeNull();
    expect(getRegimeModifiers('trend').warning).toBeNull();
  });

  it('returns sensible defaults for unknown regime', () => {
    const m = getRegimeModifiers('blorp');
    expect(m.sizeMult).toBeGreaterThan(0);
    expect(m.sizeMult).toBeLessThanOrEqual(1);
  });

  it('returns stopAtrMult for every regime', () => {
    for (const r of ['riskOn', 'trend', 'sideways', 'highVol', 'riskOff', 'panic']) {
      expect(typeof getRegimeModifiers(r).stopAtrMult).toBe('number');
      expect(getRegimeModifiers(r).stopAtrMult).toBeGreaterThan(0);
    }
  });

  it('stopAtrMult escalates as risk increases: riskOn < highVol < riskOff < panic', () => {
    expect(getRegimeModifiers('riskOn').stopAtrMult)
      .toBeLessThan(getRegimeModifiers('highVol').stopAtrMult);
    expect(getRegimeModifiers('highVol').stopAtrMult)
      .toBeLessThan(getRegimeModifiers('riskOff').stopAtrMult);
    expect(getRegimeModifiers('riskOff').stopAtrMult)
      .toBeLessThan(getRegimeModifiers('panic').stopAtrMult);
  });
});

// ── applyRegimeModifiers ──────────────────────────────────────────────────────

describe('applyRegimeModifiers', () => {
  it('returns null when rec is null', () => {
    expect(applyRegimeModifiers(null, 'riskOn')).toBeNull();
  });

  it('sets qty=0 and _regimeBlocked in panic regime', () => {
    const rec = { ticker: 'BHP', action: 'BUY', qty: 100, reasoning: ['looks good'] };
    const out  = applyRegimeModifiers(rec, 'panic');
    expect(out.qty).toBe(0);
    expect(out._regimeBlocked).toBe('panic');
    expect(out._regimeAdjusted).toBe(true);
  });

  it('does not mutate the original rec (returns a copy)', () => {
    const rec = { ticker: 'BHP', action: 'BUY', qty: 100, reasoning: ['ok'] };
    applyRegimeModifiers(rec, 'panic');
    expect(rec.qty).toBe(100);           // original unchanged
    expect(rec._regimeBlocked).toBeUndefined();
  });

  it('scales qty by sizeMult for highVol', () => {
    const rec = { ticker: 'BHP', action: 'BUY', qty: 100, reasoning: [] };
    const out  = applyRegimeModifiers(rec, 'highVol');
    const sizeMult = getRegimeModifiers('highVol').sizeMult; // 0.60
    expect(out.qty).toBe(Math.max(1, Math.floor(100 * sizeMult)));
    expect(out._regimeAdjusted).toBe(true);
  });

  it('does not adjust qty for riskOn (sizeMult=1.0)', () => {
    const rec = { ticker: 'BHP', action: 'BUY', qty: 100, reasoning: [] };
    const out  = applyRegimeModifiers(rec, 'riskOn');
    expect(out.qty).toBe(100);
    expect(out._regimeAdjusted).toBeUndefined();
  });

  it('appends a regime warning to reasoning as a string', () => {
    // reasoning MUST stay a string — every consumer (analysis.js, the rec
    // card, escapeHTML) calls string methods on it directly. Wrapping it in
    // an array here was a real bug: "(r.reasoning || '').replace is not a
    // function" the moment a regime warning fired on a portfolio rec.
    const rec = { ticker: 'BHP', action: 'BUY', qty: 50, reasoning: 'base reason' };
    const out  = applyRegimeModifiers(rec, 'highVol');
    expect(typeof out.reasoning).toBe('string');
    expect(out.reasoning).toContain('[REGIME:highVol]');
    expect(out.reasoning).toContain('base reason');
  });

  it('coerces a legacy array reasoning back to a string before appending', () => {
    const rec = { ticker: 'BHP', action: 'BUY', qty: 50, reasoning: ['legacy', 'array', 'reasoning'] };
    const out  = applyRegimeModifiers(rec, 'highVol');
    expect(typeof out.reasoning).toBe('string');
    expect(out.reasoning).toContain('legacy array reasoning');
    expect(out.reasoning).toContain('[REGIME:highVol]');
  });

  // ── Audit B2: risk/reward $ fields must scale with qty ──────────────────────
  it('scales riskAUD AND rewardAUD down with qty in riskOff (0.5×)', () => {
    const rec = { ticker: 'BHP', action: 'BUY', qty: 100, riskAUD: 200, rewardAUD: 400, reasoning: '' };
    const out = applyRegimeModifiers(rec, 'riskOff');   // sizeMult 0.5
    expect(out.qty).toBe(50);
    expect(out.riskAUD).toBe(100);      // was left stale at 200 before the fix
    expect(out.rewardAUD).toBe(200);
  });

  it('scales riskAUD up with qty in trend (1.1×) so the heat budget sees true risk', () => {
    const rec = { ticker: 'BHP', action: 'BUY', qty: 100, riskAUD: 200, rewardAUD: 400, reasoning: '' };
    const out = applyRegimeModifiers(rec, 'trend');     // sizeMult 1.1
    expect(out.qty).toBe(110);
    // riskAUD scaled by the ACTUAL floored ratio (110/100), not left at 200
    expect(out.riskAUD).toBe(Math.round(200 * (out.qty / 100)));
    expect(out.riskAUD).toBeGreaterThan(200);
  });

  it('scales risk fields by the exact floored ratio, not the raw sizeMult', () => {
    // qty 7 × 0.6 (highVol) = 4.2 → floor 4; ratio 4/7, not 0.6
    const rec = { ticker: 'XYZ', action: 'BUY', qty: 7, riskAUD: 70, rewardAUD: 140, reasoning: '' };
    const out = applyRegimeModifiers(rec, 'highVol');
    expect(out.qty).toBe(4);
    expect(out.riskAUD).toBe(Math.round(70 * (4 / 7)));   // 40, not 42
  });

  it('leaves risk fields untouched when they are absent', () => {
    const rec = { ticker: 'BHP', action: 'BUY', qty: 100, reasoning: '' };
    const out = applyRegimeModifiers(rec, 'riskOff');
    expect(out.qty).toBe(50);
    expect(out.riskAUD).toBeUndefined();
    expect(out.rewardAUD).toBeUndefined();
  });
});
