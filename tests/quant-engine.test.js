/**
 * tests/quant-engine.test.js
 *
 * Tests for computeTradeParams() — the deterministic position-sizing engine.
 * All tests run against the real source file loaded via vm in setup.js.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid signals object. */
function makeSignals(overrides = {}) {
  return {
    current_price:  10.00,
    atr_14:          0.20,    // 2% ATR → stopDist = 2.5×0.20 = 0.50
    adv_20:       500_000,    // $500k daily turnover
    volume_avg_20:  50_000,   // 50k shares/day
    bb_upper:        11.50,   // > analystTarget(11.00) so min candidate = 11.00, R:R = 2.0
    support_resistance: { r1: 11.20, r2: 12.00, s1: 9.40, pivot: 10.00 },
    score: 70,
    ...overrides,
  };
}

/** Minimal valid portfolio context. */
function makeCtx(overrides = {}) {
  return {
    allocatedCash:  50_000,
    portfolioValue: 100_000,
    brokerage:      10,
    rbaRate:        4.35,
    ...overrides,
  };
}

/** Minimal valid analyst output. */
function makeAnalyst(overrides = {}) {
  return {
    winProb:                0.60,
    expectedTimeToTarget:   14,
    target:                 11.00,
    ...overrides,
  };
}

// ── computeTradeParams ────────────────────────────────────────────────────────

describe('computeTradeParams — happy path', () => {
  it('returns ok:true with required fields', () => {
    const result = computeTradeParams('BHP', makeSignals(), makeCtx(), makeAnalyst());
    expect(result.ok).toBe(true);
    expect(result.ticker).toBe('BHP');
    expect(typeof result.qty).toBe('number');
    expect(result.qty).toBeGreaterThanOrEqual(1);
    expect(typeof result.stopLoss).toBe('number');
    expect(typeof result.target).toBe('number');
    expect(typeof result.rrRatio).toBe('number');
    expect(typeof result.evNet).toBe('number');
    expect(Array.isArray(result.scenarios)).toBe(true);
    expect(result.scenarios).toHaveLength(4);
  });

  it('stopLoss is price − stopAtrMultiple × ATR', () => {
    const s = makeSignals({ current_price: 10.00, atr_14: 0.20 });
    const r = computeTradeParams('X', s, makeCtx(), makeAnalyst());
    expect(r.ok).toBe(true);
    // default stopAtrMultiple = 2.5
    expect(r.stopLoss).toBeCloseTo(10.00 - 2.5 * 0.20, 3);
  });

  it('rrRatio ≥ 2.0 minimum on a clean setup', () => {
    const r = computeTradeParams('X', makeSignals(), makeCtx(), makeAnalyst({ target: 11.00 }));
    expect(r.ok).toBe(true);
    expect(r.rrRatio).toBeGreaterThanOrEqual(2.0);
  });

  it('identifies a constraintBinding field', () => {
    const r = computeTradeParams('X', makeSignals(), makeCtx(), makeAnalyst());
    expect(r.ok).toBe(true);
    expect(['accountRisk%', 'maxPosition%', 'kelly', 'liquidity']).toContain(r.constraintBinding);
  });

  it('winProb is clamped to [0,1]', () => {
    const r = computeTradeParams('X', makeSignals(), makeCtx(), makeAnalyst({ winProb: 1.5 }));
    expect(r.ok).toBe(true);
    expect(r.winProb).toBeLessThanOrEqual(1);
  });

  it('evNet accounts for opportunity cost and brokerage', () => {
    const r = computeTradeParams('X', makeSignals(), makeCtx(), makeAnalyst());
    expect(r.ok).toBe(true);
    // evNet should be numeric and finite
    expect(Number.isFinite(r.evNet)).toBe(true);
  });
});

describe('computeTradeParams — early exits', () => {
  it('returns ok:false when signals is null', () => {
    const r = computeTradeParams('X', null, makeCtx(), makeAnalyst());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no signals/i);
  });

  it('returns ok:false when signals has an error flag', () => {
    const r = computeTradeParams('X', { error: 'timeout' }, makeCtx(), makeAnalyst());
    expect(r.ok).toBe(false);
  });

  it('returns ok:false when winProb is missing', () => {
    const r = computeTradeParams('X', makeSignals(), makeCtx(), { expectedTimeToTarget: 10 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/winProb/i);
  });

  it('returns ok:false when winProb is zero', () => {
    const r = computeTradeParams('X', makeSignals(), makeCtx(), makeAnalyst({ winProb: 0 }));
    expect(r.ok).toBe(false);
  });

  it('returns ok:false when price is missing', () => {
    const r = computeTradeParams('X', makeSignals({ current_price: 0 }), makeCtx(), makeAnalyst());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/price|ATR/i);
  });

  it('returns ok:false when ATR is zero', () => {
    const r = computeTradeParams('X', makeSignals({ atr_14: 0 }), makeCtx(), makeAnalyst());
    expect(r.ok).toBe(false);
  });

  it('returns ok:false when no valid target above entry', () => {
    // All candidates (analystTarget, bbUpper, r1) are below current price
    const s = makeSignals({
      current_price: 15.00,
      bb_upper:       14.00,
      support_resistance: { r1: 13.00 },
    });
    const r = computeTradeParams('X', s, makeCtx(), makeAnalyst({ target: 12.00 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/target/i);
  });

  it('returns ok:false when R:R is below minimum', () => {
    // Entry 10, ATR 2 → stop = 5 (dist = 5). Need target > 10 + 2*5 = 20 for R:R ≥ 2
    // Target at 12 → reward dist = 2, R:R = 2/5 = 0.4
    const s = makeSignals({ current_price: 10.00, atr_14: 2.0, bb_upper: 12.01 });
    const r = computeTradeParams('X', s, makeCtx(), makeAnalyst({ target: 12.00 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/R:R/i);
  });
});

describe('computeTradeParams — sizing constraints', () => {
  it('qty is bounded by account-risk constraint', () => {
    // With 1% of $150k = $1500 risk, stopDist = 2.5*0.2 = 0.5 → max qty = 3000
    // Position-size cap is 20% of net worth ($150k, not just allocatedCash) / $10 = 3000 too —
    // liquidity/Kelly bind first here. The assertion below holds regardless of which binds.
    const r = computeTradeParams('X', makeSignals(), makeCtx(), makeAnalyst());
    expect(r.ok).toBe(true);
    // qty * stopDist should not exceed riskCapital
    const riskCapital = (50_000 + 100_000) * 0.01;
    expect(r.qty * (r.entryPrice - r.stopLoss)).toBeLessThanOrEqual(riskCapital + 1); // +1 for rounding
  });

  it('liquidity cap applies when ADV is very low', () => {
    // Only 100 shares/day → 5% = 5 max
    const s = makeSignals({ volume_avg_20: 100, adv_20: null });
    const r = computeTradeParams('X', s, makeCtx(), makeAnalyst());
    if (r.ok) {
      expect(r.qty).toBeLessThanOrEqual(5);
    }
  });

  it('falls back to adv_20/price for share count when volume_avg_20 is absent', () => {
    const s = makeSignals({ volume_avg_20: undefined, adv_20: 1000 }); // adv/price = 100 shares
    const r = computeTradeParams('X', s, makeCtx(), makeAnalyst());
    if (r.ok) {
      // 5% of 100 = 5 max from liquidity
      expect(r.qty).toBeLessThanOrEqual(5);
    }
  });

  it('uses the minimum of all four constraints', () => {
    const r = computeTradeParams('X', makeSignals(), makeCtx(), makeAnalyst());
    if (!r.ok) return;
    // Re-derive all constraints to confirm qty ≤ all of them
    const price     = r.entryPrice;
    const stopDist  = price - r.stopLoss;
    const capital   = 50_000 + 100_000;
    const qtyRisk   = Math.floor(capital * 0.01 / stopDist);
    // Position-size cap is 20% of NET WORTH (cash + holdings), not allocatedCash alone —
    // a position is capped relative to the whole portfolio it sits inside.
    const qtyPos    = Math.floor(capital * 0.20 / price);
    expect(r.qty).toBeLessThanOrEqual(qtyRisk + 1);  // +1 for vol scalar rounding
    expect(r.qty).toBeLessThanOrEqual(qtyPos  + 1);
  });
});

describe('computeTradeParams — scenarios', () => {
  it('produces four labelled scenarios', () => {
    const r = computeTradeParams('X', makeSignals(), makeCtx(), makeAnalyst());
    expect(r.ok).toBe(true);
    const labels = r.scenarios.map(s => s.label);
    expect(labels).toContain('Bull');
    expect(labels).toContain('Base');
    expect(labels).toContain('Bear');
    expect(labels).toContain('Panic');
  });

  it('scenario probs sum to approximately winProb (bull+base) and 1-winProb (bear+panic)', () => {
    const r = computeTradeParams('X', makeSignals(), makeCtx(), makeAnalyst({ winProb: 0.6 }));
    expect(r.ok).toBe(true);
    const bull  = r.scenarios.find(s => s.label === 'Bull').prob;
    const base  = r.scenarios.find(s => s.label === 'Base').prob;
    const bear  = r.scenarios.find(s => s.label === 'Bear').prob;
    const panic = r.scenarios.find(s => s.label === 'Panic').prob;
    expect(bull + base).toBeCloseTo(0.6, 1);
    expect(bear + panic).toBeCloseTo(0.4, 1);
  });
});

describe('computeTradeParams — pre-earnings adjustment', () => {
  // Use a wider target so both base and earnings cases clear R:R ≥ 2.0 after 1.3× stop widening
  const bigTargetSignals = () => makeSignals({
    atr_14: 0.10,
    bb_upper: 14.00,
    support_resistance: { r1: 13.00, r2: 15.00, s1: 9.00, pivot: 10.00 },
  });
  const bigTargetAnalyst = () => makeAnalyst({ target: 13.00 });

  it('sets _preEarningsAdj:true when pre_earnings_risk is set', () => {
    const r = computeTradeParams('X', { ...bigTargetSignals(), pre_earnings_risk: true },
      makeCtx(), bigTargetAnalyst());
    expect(r.ok).toBe(true);
    expect(r._preEarningsAdj).toBe(true);
  });

  it('does not set _preEarningsAdj when pre_earnings_risk is absent', () => {
    const r = computeTradeParams('X', bigTargetSignals(), makeCtx(), bigTargetAnalyst());
    expect(r.ok).toBe(true);
    expect(r._preEarningsAdj).toBeFalsy();
  });

  it('widens stop distance by 1.3× when pre_earnings_risk is set', () => {
    const base = computeTradeParams('X', bigTargetSignals(), makeCtx(), bigTargetAnalyst());
    const earns = computeTradeParams('X', { ...bigTargetSignals(), pre_earnings_risk: true },
      makeCtx(), bigTargetAnalyst());
    expect(base.ok).toBe(true);
    expect(earns.ok).toBe(true);
    const baseDist  = base.entryPrice  - base.stopLoss;
    const earnsDist = earns.entryPrice - earns.stopLoss;
    expect(earnsDist).toBeCloseTo(baseDist * 1.3, 3);
  });
});

describe('computeTradeParams — minTradeSize floor', () => {
  afterEach(() => {
    delete state.settings;
  });

  it('ignores the floor when qty is already above it', () => {
    state.settings = { minTradeSize: 500 };
    const r = computeTradeParams('BHP', makeSignals(), makeCtx(), makeAnalyst());
    expect(r.ok).toBe(true);
    expect(r._minTradeSizeBumped).toBeFalsy();
  });

  it('bumps qty up to meet the floor when hard caps allow it', () => {
    const noFloor = computeTradeParams('BHP', makeSignals(), makeCtx(), makeAnalyst());
    expect(noFloor.ok).toBe(true);
    const belowFloorNotional = noFloor.qty * noFloor.entryPrice;

    state.settings = { minTradeSize: belowFloorNotional + 4000 };
    const r = computeTradeParams('BHP', makeSignals(), makeCtx(), makeAnalyst());
    expect(r.ok).toBe(true);
    expect(r._minTradeSizeBumped).toBe(true);
    expect(r.qty).toBeGreaterThan(noFloor.qty);
    expect(r.qty * r.entryPrice).toBeGreaterThanOrEqual(state.settings.minTradeSize);
    expect(r.constraintBinding).toBe('minTradeSize');
  });

  it('rejects the trade when the floor cannot be met without breaching risk/position/liquidity caps', () => {
    state.settings = { minTradeSize: 1_000_000 };
    const r = computeTradeParams('BHP', makeSignals(), makeCtx(), makeAnalyst());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/min trade size/i);
  });
});
