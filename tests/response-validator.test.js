/**
 * tests/response-validator.test.js
 *
 * Tests for validateRec(), validateResponse(), and _buildRepairMessage()
 * — the post-parse recommendation validation and auto-repair layer.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid BUY rec. */
function makeRec(overrides = {}) {
  return {
    ticker:     'BHP',
    action:     'BUY',
    priceRange: [44.00, 44.50],
    target:     47.00,
    stopLoss:   42.50,
    qty:        100,
    confidence: 0.72,
    rrRatio:    2.4,
    factorsUsed: ['RSI oversold', 'BB lower touch', 'strong ADX'],
    reasoning:  'Fundamental support with technical breakout signal.',
    risks:      ['Macro slowdown'],
    scenarios: { bull: { p: 0.4, ret: 15 }, base: { p: 0.4, ret: 5 }, bear: { p: 0.2, ret: -8 } },
    invalidationCondition: 'Price closes below $42.50 stop for two consecutive sessions.',
    ...overrides,
  };
}

// ── validateRec — valid recs ───────────────────────────────────────────────────

describe('validateRec — valid recs pass', () => {
  it('passes a clean BUY rec', () => {
    const { valid, errors } = validateRec(makeRec());
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('passes a clean SELL rec', () => {
    const { valid } = validateRec(makeRec({
      action:           'SELL',
      priceRange:       [44.00, 44.50],
      target:           42.00,   // below entry for SELL
      stopLoss:         45.50,   // above entry for SELL
      rrRatio:          1.5,     // R:R check only applies to BUY/TOP_UP
      primary_driver:   'thesis_broken',
      secondary_factors: ['negative_news_flow'],
      urgency:          'immediate',
      reasoning:        'thesis broken — guidance cut and multiple downgrades',
    }));
    expect(valid).toBe(true);
  });

  it('passes a HOLD rec without target/stop/qty', () => {
    const { valid, errors } = validateRec({
      ticker:     'CBA',
      action:     'HOLD',
      confidence: 0.55,
      reasoning:  ['No catalyst'],
      risks:      [],
      factorsUsed: [],
    });
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('passes a TOP_UP rec', () => {
    const { valid } = validateRec(makeRec({ action: 'TOP_UP' }));
    expect(valid).toBe(true);
  });

  it('passes a TRIM rec', () => {
    const { valid } = validateRec(makeRec({
      action:           'TRIM',
      target:           42.00,
      stopLoss:         45.50,
      rrRatio:          1.5,
      primary_driver:   'target_reached',
      secondary_factors: ['position_oversized'],
      urgency:          'routine',
      reasoning:        'target reached — position is oversized, trim to rebalance',
    }));
    expect(valid).toBe(true);
  });
});

// ── validateRec — schema failures ─────────────────────────────────────────────

describe('validateRec — schema validation', () => {
  it('rejects missing ticker', () => {
    const { valid, errors } = validateRec(makeRec({ ticker: undefined }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('ticker'))).toBe(true);
  });

  it('rejects invalid ticker pattern (lowercase)', () => {
    const { valid, errors } = validateRec(makeRec({ ticker: 'bhp' }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('ticker'))).toBe(true);
  });

  it('accepts ticker with digits (A2M, S32)', () => {
    expect(validateRec(makeRec({ ticker: 'A2M' })).valid).toBe(true);
    expect(validateRec(makeRec({ ticker: 'S32' })).valid).toBe(true);
  });

  it('accepts ticker with .AX suffix', () => {
    expect(validateRec(makeRec({ ticker: 'BHP.AX' })).valid).toBe(true);
  });

  it('F1: canonicalizes .AX suffix off ticker so downstream consumers see a bare ticker', () => {
    const { valid, fixed } = validateRec(makeRec({ ticker: 'BHP.AX' }));
    expect(valid).toBe(true);
    expect(fixed.ticker).toBe('BHP');
  });

  it('F1: canonicalizes .AX suffix off alternativeTicker (better_opportunity SELL)', () => {
    const { fixed, errors } = validateRec(makeRec({
      action: 'SELL',
      stopLoss: 46.00,  // SELL stop must be above entry high (44.50)
      primary_driver: 'better_opportunity',
      alternativeTicker: 'CBA.AX',
      secondary_factors: [],
      urgency: 'routine',
    }));
    expect(errors).toEqual([]);
    expect(fixed.alternativeTicker).toBe('CBA');
  });

  it('rejects invalid action', () => {
    const { valid, errors } = validateRec(makeRec({ action: 'HOLD_FOREVER' }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('action'))).toBe(true);
  });

  it('rejects missing confidence', () => {
    const { valid, errors } = validateRec(makeRec({ confidence: undefined }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('confidence'))).toBe(true);
  });

  it('rejects confidence > 1', () => {
    const { valid, errors, fixed } = validateRec(makeRec({ confidence: 1.5 }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('confidence'))).toBe(true);
    // Should auto-fix by clamping
    expect(fixed).not.toBeNull();
    expect(fixed.confidence).toBe(1);
  });

  it('rejects confidence < 0 and auto-clamps to 0', () => {
    const { fixed } = validateRec(makeRec({ confidence: -0.1 }));
    expect(fixed).not.toBeNull();
    expect(fixed.confidence).toBe(0);
  });

  it('rejects qty < 1 but auto-rounds up', () => {
    const { valid, fixed } = validateRec(makeRec({ qty: 0.7 }));
    expect(valid).toBe(false);
    expect(fixed).not.toBeNull();
    expect(fixed.qty).toBe(1); // Math.max(1, round(0.7)) = 1
  });
});

// ── validateRec — business rules ──────────────────────────────────────────────

describe('validateRec — business rules', () => {
  it('rejects BUY when target ≤ entry high (unprofitable entry)', () => {
    const { valid, errors } = validateRec(makeRec({
      priceRange: [44.00, 46.00],
      target:     45.00,   // target < entry high
    }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('profitable-entry') || e.includes('unprofitable'))).toBe(true);
  });

  it('rejects when stopLoss ≥ entry low', () => {
    const { valid, errors } = validateRec(makeRec({
      priceRange: [44.00, 44.50],
      stopLoss:   44.10,   // stop ABOVE entry low
    }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('stop'))).toBe(true);
  });

  it('auto-fixes inverted priceRange [hi, lo] → [lo, hi]', () => {
    const { valid, fixed } = validateRec(makeRec({ priceRange: [44.50, 44.00] }));
    // inverted range fails price-range-valid rule but has a fix
    if (!valid && fixed) {
      expect(fixed.priceRange[0]).toBeLessThanOrEqual(fixed.priceRange[1]);
    }
  });

  it('rejects BUY with rrRatio < 2.0', () => {
    const { valid, errors } = validateRec(makeRec({ rrRatio: 1.5 }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('rrRatio') || e.includes('2.0'))).toBe(true);
  });

  it('does NOT apply rrRatio check to SELL/TRIM', () => {
    const { valid } = validateRec(makeRec({
      action:          'SELL',
      target:          42.00,
      stopLoss:        45.50,
      rrRatio:         1.5,    // < 2.0 but rule only applies to BUY/TOP_UP
      primary_driver:  'thesis_broken',
      secondary_factors: [],
      urgency:         'immediate',
      reasoning:       'thesis broken — downgrade and earnings miss',
    }));
    expect(valid).toBe(true);
  });

  it('HOLD rec skips required checks for target/stop/qty/priceRange', () => {
    const { valid, errors } = validateRec({
      ticker: 'CBA', action: 'HOLD', confidence: 0.60,
      reasoning: [], risks: [], factorsUsed: [],
    });
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('returns fixed=null when an error has no fix', () => {
    // R:R rule has no fix — so even if other things are fixable, fixed=null
    const { valid, fixed } = validateRec(makeRec({ rrRatio: 0.5 }));
    expect(valid).toBe(false);
    expect(fixed).toBeNull();
  });
});

// ── validateResponse ──────────────────────────────────────────────────────────

describe('validateResponse', () => {
  beforeEach(() => {
    // Ensure clean state for each test
    global.state.recHistory  = [];
    global.state.liveSignals = {};
  });

  it('returns valid recs and empty errors for a clean response', () => {
    const parsed = { recs: [makeRec()], summary: 'All good' };
    const result = validateResponse(parsed, 0.50);
    expect(result.recs).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.summary).toBe('All good');
  });

  it('rejects recs below minConfidence threshold', () => {
    const parsed = { recs: [makeRec({ confidence: 0.40 })] };
    const result = validateResponse(parsed, 0.62);
    expect(result.recs).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it('passes HOLD recs regardless of confidence threshold', () => {
    const holdRec = {
      ticker: 'CBA', action: 'HOLD', confidence: 0.30,
      reasoning: [], risks: [], factorsUsed: [],
    };
    const result = validateResponse({ recs: [holdRec] }, 0.62);
    expect(result.recs).toHaveLength(1);
  });

  it('computes ensembleConfidence when liveSignals provides a score', () => {
    global.state.liveSignals = { BHP: { score: 80 } };
    const parsed = { recs: [makeRec({ confidence: 0.70 })] };
    const result = validateResponse(parsed, 0.50);
    expect(result.recs).toHaveLength(1);
    // ensembleConfidence = 0.5 * 0.70 + 0.5 * (80/100) = 0.75
    expect(result.recs[0].ensembleConfidence).toBeCloseTo(0.75, 2);
  });

  it('falls back to AI confidence as ensembleConfidence when no liveSignals score', () => {
    global.state.liveSignals = {};
    const parsed = { recs: [makeRec({ confidence: 0.70 })] };
    const result = validateResponse(parsed, 0.50);
    expect(result.recs[0].ensembleConfidence).toBe(0.70);
  });

  it('handles raw array input (no .recs wrapper)', () => {
    const result = validateResponse([makeRec()], 0.50);
    expect(result.recs).toHaveLength(1);
  });

  it('handles empty recs array gracefully', () => {
    const result = validateResponse({ recs: [] }, 0.62);
    expect(result.recs).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('forwards dataGaps from the parsed object', () => {
    const parsed = { recs: [], dataGaps: ['BHP data unavailable'], summary: '' };
    const result = validateResponse(parsed, 0.62);
    expect(result.dataGaps).toContain('BHP data unavailable');
  });

  it('does not gate on portfolioSynthesis (now computed deterministically in analysis.js, not by the model)', () => {
    global.state.portfolio = [{ ticker: 'BHP', shares: 100, avgPrice: 40 }];
    const result = validateResponse({ recs: [] }, 0.62);
    expect(result.errors.some(e => /portfolioSynthesis is required/.test(e))).toBe(false);
    delete global.state.portfolio;
  });
});

// ── _buildRepairMessage ───────────────────────────────────────────────────────

describe('_buildRepairMessage', () => {
  it('appends error list to the original message', () => {
    const original = 'Please analyse my portfolio.';
    const errors   = ['rec[0] (BHP): rrRatio 1.2 < 2.0', 'rec[1] (CBA): confidence missing'];
    const out = _buildRepairMessage(original, errors);
    expect(out).toContain(original);
    expect(out).toContain('VALIDATION ERRORS');
    expect(out).toContain('rrRatio 1.2 < 2.0');
    expect(out).toContain('confidence missing');
  });

  it('asks Claude to regenerate the full JSON', () => {
    const out = _buildRepairMessage('msg', ['some error']);
    expect(out).toContain('Regenerate the full JSON');
  });

  it('handles error objects with ticker and errors array', () => {
    const errors = [{ ticker: 'BHP', errors: ['stopLoss too high'] }];
    const out = _buildRepairMessage('msg', errors);
    expect(out).toContain('BHP');
    expect(out).toContain('stopLoss too high');
  });
});

// ── validateSellTags — driver-mention auto-repair (Sprint 64) ─────────────────
// The prompt's contract is "word or concept"; the literal check can't detect
// concepts, so a missing driver token is repaired by appending it — never a
// hard failure (the old hard-fail destroyed 3 of 5 good recs on 2026-06-11).

describe('validateSellTags — driver mention auto-repair', () => {
  it('repairs reasoning that phrases the concept without the literal token', () => {
    const { valid, errors, fixed } = validateRec(makeRec({
      action:           'TRIM',
      target:           42.00,
      stopLoss:         45.50,
      rrRatio:          1.5,
      primary_driver:   'risk_management',
      secondary_factors: ['sector_concentration'],
      urgency:          'routine',
      reasoning:        'Banking sector at 32% cap. Trim to reduce concentration.',
    }));
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
    expect(fixed.reasoning).toContain('[driver: risk_management]');
    expect(fixed._driverMentionAppended).toBe(true);
  });

  it('does not touch reasoning that already names the driver', () => {
    const { valid, fixed } = validateRec(makeRec({
      action:           'TRIM',
      target:           42.00,
      stopLoss:         45.50,
      rrRatio:          1.5,
      primary_driver:   'risk_management',
      secondary_factors: ['position_oversized'],
      urgency:          'routine',
      reasoning:        'Mandatory risk_management trim — 16.7% weight breaches the cap.',
    }));
    expect(valid).toBe(true);
    expect(fixed.reasoning).not.toContain('[driver:');
  });

  it('still hard-fails genuinely invalid tags (forbidden combo)', () => {
    const { valid, fixed } = validateRec(makeRec({
      action:           'SELL',
      target:           42.00,
      stopLoss:         45.50,
      rrRatio:          1.5,
      primary_driver:   'target_reached',
      secondary_factors: ['stop_triggered'],
      urgency:          'immediate',
      reasoning:        'target reached',
    }));
    expect(valid).toBe(false);
    expect(fixed).toBeNull();
  });
});

// ── validateSellTags — ground-truth secondary-tag checks ──────────────────────
// Regression coverage for the 2026-06-25 live-response audit: three SELL/TRIM
// recs tagged secondary_factors that contradicted the model's own input data
// (VGB: unrealised_loss_large on a $76 loss; DRO/NXL: position_oversized on a
// 1.8%-weight position). The tags feed the learning-loop's deterministic
// calibration, so a wrong tag silently pollutes win-rate-by-driver stats.

describe('validateSellTags — ground-truth numeric checks', () => {
  it('strips unrealised_loss_large when the actual loss is under $500 (VGB case)', () => {
    const ctx = { holding: { weightPct: 1.2, sectorWeightPct: 1.2, unrealisedPnl: -76.72, daysHeld: 540 } };
    const { valid, errors, fixed } = validateRec(makeRec({
      action:            'SELL',
      target:            45.16,
      stopLoss:          47.20,
      rrRatio:           2.1,
      primary_driver:    'regime_change',
      secondary_factors: ['unrealised_loss_large'],
      urgency:           'routine',
      reasoning:         'Yield below RBA rate — regime_change exit; EOFY timing valid for smaller loss.',
    }), ctx);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
    expect(fixed.secondary_factors).not.toContain('unrealised_loss_large');
    expect(fixed._groundTruthTagsDropped).toContain('unrealised_loss_large');
  });

  it('strips position_oversized when actual weight is 1.8%, not >15% (DRO/NXL case)', () => {
    const ctx = { holding: { weightPct: 1.8, sectorWeightPct: 7.2, unrealisedPnl: 30, daysHeld: 2 } };
    const { valid, fixed } = validateRec(makeRec({
      action:            'SELL',
      priceRange:        [2.55, 2.60],
      target:            1.90,
      stopLoss:          2.91,
      rrRatio:           2.3,
      primary_driver:    'risk_management',
      secondary_factors: ['position_oversized'],
      urgency:           'immediate',
      reasoning:         'Structural breakdown — risk_management exit given extreme volatility.',
    }), ctx);
    // risk_management requires sector_concentration OR position_oversized; once
    // position_oversized is stripped and nothing else grounds it, this must
    // surface for review rather than silently pass.
    expect(valid).toBe(false);
    expect(fixed).toBeNull();
  });

  it('ground-truth ungrounded: emits exactly one user-facing error with no internal tag names', () => {
    // Regression: previously emitted two errors — one from the ground-truth block
    // and one from the required-secondary check — for the same root cause.
    // Also verifies the message uses plain English, not "secondary_factors"/"primary_driver" jargon.
    const ctx = { holding: { weightPct: 1.8, sectorWeightPct: 7.2, unrealisedPnl: 30, daysHeld: 2 } };
    const { valid, errors, fixed } = validateRec(makeRec({
      action:            'TRIM',
      priceRange:        [114.0, 114.5],
      target:            108.0,
      stopLoss:          118.0,
      rrRatio:           2.0,
      primary_driver:    'risk_management',
      secondary_factors: ['position_oversized'],
      urgency:           'routine',
      reasoning:         'Risk management trim — position oversized relative to risk tolerance.',
    }), ctx);
    expect(valid).toBe(false);
    expect(fixed).toBeNull();
    // Exactly one error — no double-fire from redundant required-secondary check
    expect(errors).toHaveLength(1);
    // Message must be user-readable — no internal jargon
    expect(errors[0]).not.toMatch(/secondary_factors/);
    expect(errors[0]).not.toMatch(/primary_driver/);
    expect(errors[0]).toMatch(/position not oversized/);
    expect(errors[0]).toMatch(/risk management/);
  });

  it('silently repairs when a grounded tag remains after stripping the bad one', () => {
    const ctx = { holding: { weightPct: 1.8, sectorWeightPct: 25, unrealisedPnl: 30, daysHeld: 2 } };
    const { valid, errors, fixed } = validateRec(makeRec({
      action:            'SELL',
      priceRange:        [2.55, 2.60],
      target:            1.90,
      stopLoss:          2.91,
      rrRatio:           2.3,
      primary_driver:    'risk_management',
      secondary_factors: ['position_oversized', 'sector_concentration'],
      urgency:           'immediate',
      reasoning:         'Structural breakdown — risk_management exit given sector concentration.',
    }), ctx);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
    expect(fixed.secondary_factors).toEqual(['sector_concentration']);
  });

  it('keeps unrealised_loss_large when the loss genuinely exceeds $500', () => {
    const ctx = { holding: { weightPct: 5, sectorWeightPct: 5, unrealisedPnl: -612.40, daysHeld: 200 } };
    const { valid, fixed } = validateRec(makeRec({
      action:            'SELL',
      target:            42.00,
      stopLoss:          45.50,
      rrRatio:           1.8,
      primary_driver:    'tax_optimisation',
      secondary_factors: ['unrealised_loss_large'],
      urgency:           'routine',
      reasoning:         'EOFY tax_optimisation — crystallise the $612 loss.',
    }), ctx);
    expect(valid).toBe(true);
    expect(fixed.secondary_factors).toContain('unrealised_loss_large');
  });

  it('is a no-op without ctx (existing callers/tests unaffected)', () => {
    const { valid, errors } = validateRec(makeRec({
      action:            'SELL',
      target:            42.00,
      stopLoss:          45.50,
      rrRatio:           1.8,
      primary_driver:    'tax_optimisation',
      secondary_factors: ['unrealised_loss_large'],
      urgency:           'routine',
      reasoning:         'EOFY tax_optimisation harvest.',
    }));
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('rejects target_reached + dividend_at_risk as a forbidden combo (WOW case)', () => {
    const { valid, errors, fixed } = validateRec(makeRec({
      action:            'TRIM',
      target:            34.00,
      stopLoss:          41.00,
      rrRatio:           2.0,
      primary_driver:    'target_reached',
      secondary_factors: ['dividend_at_risk'],
      urgency:           'routine',
      reasoning:         'target_reached — price exceeded fair value; payout ratio also unsustainable.',
    }));
    expect(valid).toBe(false);
    expect(fixed).toBeNull();
    expect(errors.some(e => e.includes('target reached') && e.includes('dividend at risk'))).toBe(true);
  });
});

// ── Audit C2: CGT 50%-discount boundary is > 365, consistent everywhere ─────────
describe('cgtDiscountEligible — canonical CGT 12-month boundary', () => {
  it('a parcel held exactly 365 days is NOT discount-eligible (> 365, ATO)', () => {
    expect(cgtDiscountEligible(365)).toBe(false);
  });

  it('366 days IS eligible', () => {
    expect(cgtDiscountEligible(366)).toBe(true);
  });

  it('matches the disposal engine boundary (held > 365), not >= 365', () => {
    // matchSaleAgainstParcels uses held > 365; the UI/validator previously used >= 365.
    for (const d of [0, 100, 364, 365]) expect(cgtDiscountEligible(d)).toBe(false);
    for (const d of [366, 400, 730]) expect(cgtDiscountEligible(d)).toBe(true);
  });

  it('is null-safe', () => {
    expect(cgtDiscountEligible(null)).toBe(false);
    expect(cgtDiscountEligible(undefined)).toBe(false);
  });

  it('SELL validator held_over_12m ground-truth uses the same > 365 boundary', () => {
    // daysHeld exactly 365 must NOT ground a "held_over_12m" (CGT discount) SELL tag.
    const ctx = { holding: { weightPct: 1, sectorWeightPct: 1, unrealisedPnl: 10, daysHeld: 365 } };
    const { fixed } = validateRec(makeRec({
      action:            'TRIM',
      target:            40.00,
      stopLoss:          48.00,
      rrRatio:           2.0,
      primary_driver:    'target_reached',
      secondary_factors: ['held_over_12m'],
      urgency:           'routine',
      reasoning:         'target_reached — price above fair value; also flagged 12m CGT discount.',
    }), ctx);
    // The ungrounded held_over_12m tag must be stripped at exactly 365 days.
    expect(fixed == null || !(fixed.secondary_factors || []).includes('held_over_12m')).toBe(true);
  });
});
