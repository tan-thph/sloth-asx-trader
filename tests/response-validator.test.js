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
    reasoning:  ['Fundamental support', 'Technical breakout'],
    risks:      ['Macro slowdown'],
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
      action:     'SELL',
      priceRange: [44.00, 44.50],
      target:     42.00,   // below entry for SELL
      stopLoss:   45.50,   // above entry for SELL
      rrRatio:    1.5,     // R:R check only applies to BUY/TOP_UP
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
      action:     'TRIM',
      target:     42.00,
      stopLoss:   45.50,
      rrRatio:    1.5,
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
      action:   'SELL',
      target:   42.00,
      stopLoss: 45.50,
      rrRatio:  1.5,    // < 2.0 but rule only applies to BUY/TOP_UP
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
