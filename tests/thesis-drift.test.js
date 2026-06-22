/**
 * tests/thesis-drift.test.js
 *
 * Tests for computeThesisDrift() — deterministic thesis-verdict engine
 * added in Thesis Tracking Phase 2+3.
 *
 * The function lives in js/learning-loop.js, loaded via extractFunction()
 * so it runs in isolation without needing all the other browser globals.
 */

import { describe, it, expect } from 'vitest';
import { extractFunction } from './setup.js';

// ── Load the function under test ──────────────────────────────────────────────

// extractFunction() uses brace-counting from the `function` keyword so it works
// for top-level function declarations like computeThesisDrift.
const fnSrc = extractFunction('js/learning-loop.js', 'computeThesisDrift');
const computeThesisDrift = new Function(`${fnSrc}\nreturn computeThesisDrift;`)();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build an entry-signals snapshot with defaults */
function entrySnap(overrides) {
  return Object.assign(
    { rsi_14: null, bb_pct_b: null, adx_14: null, atr_pct: null, return_5d: null, return_20d: null },
    overrides
  );
}

/** Build a live snapshot (same shape as entrySnap) */
const liveSnap = entrySnap;

// ── Null / missing inputs → null ─────────────────────────────────────────────

describe('computeThesisDrift — null inputs', () => {
  it('returns null when entryDriver is null', () => {
    expect(computeThesisDrift(null, entrySnap({ rsi_14: 30 }), liveSnap({ rsi_14: 50 }))).toBeNull();
  });

  it('returns null when entrySignals is null', () => {
    expect(computeThesisDrift('mean_reversion', null, liveSnap({ rsi_14: 50 }))).toBeNull();
  });

  it('returns null when liveSnapshot is null', () => {
    expect(computeThesisDrift('mean_reversion', entrySnap({ rsi_14: 28 }), null)).toBeNull();
  });

  it('returns null when all three are null', () => {
    expect(computeThesisDrift(null, null, null)).toBeNull();
  });

  it('returns null for an unknown driver', () => {
    // Unknown drivers fall through to the final else → null
    expect(computeThesisDrift('unknown_driver', entrySnap(), liveSnap())).toBeNull();
  });
});

// ── mean_reversion ────────────────────────────────────────────────────────────

describe('computeThesisDrift — mean_reversion', () => {
  it('validated: RSI reverted from below-35 to above-45', () => {
    const result = computeThesisDrift(
      'mean_reversion',
      entrySnap({ rsi_14: 28, bb_pct_b: 0.10 }),
      liveSnap({ rsi_14: 55, bb_pct_b: 0.60 })
    );
    expect(result).not.toBeNull();
    expect(result.verdict).toBe('validated');
    expect(result.deltas.rsi_14).toEqual({ entry: 28, now: 55 });
    expect(result.deltas.bb_pct_b).toEqual({ entry: 0.10, now: 0.60 });
  });

  it('validated: only bb_pct_b condition met (eBB<0.25, nBB>0.45)', () => {
    const result = computeThesisDrift(
      'mean_reversion',
      entrySnap({ bb_pct_b: 0.20 }),
      liveSnap({ bb_pct_b: 0.50 })
    );
    expect(result.verdict).toBe('validated');
  });

  it('invalidated: RSI worsened (nRsi < eRsi - 3)', () => {
    const result = computeThesisDrift(
      'mean_reversion',
      entrySnap({ rsi_14: 28 }),
      liveSnap({ rsi_14: 24 })
    );
    expect(result).not.toBeNull();
    expect(result.verdict).toBe('invalidated');
  });

  it('invalidated: bb_pct_b declined by more than 0.05', () => {
    const result = computeThesisDrift(
      'mean_reversion',
      entrySnap({ bb_pct_b: 0.30 }),
      liveSnap({ bb_pct_b: 0.20 }) // 0.20 < 0.30 - 0.05 = 0.25
    );
    expect(result.verdict).toBe('invalidated');
  });

  it('invalidated: small move — entry conditions not met, signals not holding', () => {
    // eRsi=40 not <35 and eBB=0.40 not <0.25 — entry conditions not met.
    // nRsi=42 not >45 → no hold; nBB=0.41 not >0.45 → no hold; n_hold=0 → invalidated.
    const result = computeThesisDrift(
      'mean_reversion',
      entrySnap({ rsi_14: 40, bb_pct_b: 0.40 }),
      liveSnap({ rsi_14: 42, bb_pct_b: 0.41 })
    );
    expect(result.verdict).toBe('invalidated');
  });

  it('still returns a result when only RSI is available (bb_pct_b missing)', () => {
    const result = computeThesisDrift(
      'mean_reversion',
      entrySnap({ rsi_14: 30 }),
      liveSnap({ rsi_14: 50 })
    );
    // eRsi<35 && nRsi>45 → validated
    expect(result.verdict).toBe('validated');
  });
});

// ── momentum_breakout ─────────────────────────────────────────────────────────

describe('computeThesisDrift — momentum_breakout', () => {
  it('validated: nRet5>0 and nBB>0.55', () => {
    const result = computeThesisDrift(
      'momentum_breakout',
      entrySnap({ return_5d: 1.5, bb_pct_b: 0.60 }),
      liveSnap({ return_5d: 2.0, bb_pct_b: 0.70 })
    );
    expect(result.verdict).toBe('validated');
    expect(result.deltas.return_5d).toEqual({ entry: 1.5, now: 2.0 });
  });

  it('validated: nRet5>0 and nBB is null (bb not required)', () => {
    const result = computeThesisDrift(
      'momentum_breakout',
      entrySnap({ return_5d: 1.0 }),
      liveSnap({ return_5d: 2.0 }) // nBB == null → condition: null == null → ok
    );
    // nRet5>0 && (nBB==null || nBB>0.55) → true
    expect(result.verdict).toBe('validated');
  });

  it('invalidated: nRet5<0', () => {
    const result = computeThesisDrift(
      'momentum_breakout',
      entrySnap({ return_5d: 3.0 }),
      liveSnap({ return_5d: -1.5 })
    );
    expect(result.verdict).toBe('invalidated');
  });

  it('partially_validated: ret5d still positive but nBB<0.45 (momentum faded)', () => {
    const result = computeThesisDrift(
      'momentum_breakout',
      entrySnap({ return_5d: 2.0, bb_pct_b: 0.65 }),
      liveSnap({ return_5d: 0.5, bb_pct_b: 0.40 })
    );
    // nRet5=0.5>0 → n_hold=1; nBB=0.40<0.45 → n_inverted=1; n_total=2
    // n_hold/n_total=0.5 ≥ 0.33 → partially_validated (one signal intact, one inverted)
    expect(result.verdict).toBe('partially_validated');
  });
});

// ── trend_pullback ────────────────────────────────────────────────────────────

describe('computeThesisDrift — trend_pullback', () => {
  it('validated: nRet5>0 and nAdx>20 (trend resumed)', () => {
    const result = computeThesisDrift(
      'trend_pullback',
      entrySnap({ return_5d: -1.0, adx_14: 25 }),
      liveSnap({ return_5d: 1.5, adx_14: 28 })
    );
    expect(result.verdict).toBe('validated');
    expect(result.deltas.adx_14).toEqual({ entry: 25, now: 28 });
  });

  it('validated: nRet5>0 and nAdx is null', () => {
    const result = computeThesisDrift(
      'trend_pullback',
      entrySnap({ return_5d: -0.5 }),
      liveSnap({ return_5d: 1.0 })
    );
    // nAdx == null → condition (nAdx == null || nAdx > 20) → true
    expect(result.verdict).toBe('validated');
  });

  it('invalidated: nAdx<20 (trend broke)', () => {
    const result = computeThesisDrift(
      'trend_pullback',
      entrySnap({ adx_14: 25, return_5d: 0 }),
      liveSnap({ adx_14: 15, return_5d: 0 })
    );
    expect(result.verdict).toBe('invalidated');
  });

  it('invalidated: nRet5 < -3 (sharp reversal)', () => {
    const result = computeThesisDrift(
      'trend_pullback',
      entrySnap({ return_5d: 0 }),
      liveSnap({ return_5d: -4.0 })
    );
    expect(result.verdict).toBe('invalidated');
  });

  it('partially_validated: nRet5=0 neutral but nAdx=22>20 still holding', () => {
    const result = computeThesisDrift(
      'trend_pullback',
      entrySnap({ return_5d: 0, adx_14: 22 }),
      liveSnap({ return_5d: 0, adx_14: 22 })
    );
    // nRet5=0 not >0 → no hold; not <-3 → no invert. nAdx=22>20 → n_hold=1; not <15 → no invert.
    // n_total=2, n_hold=1, n_inverted=0 → n_hold/n_total=0.5≥0.33 → partially_validated
    expect(result.verdict).toBe('partially_validated');
  });
});

// ── fundamental_value & macro_tailwind → always irrelevant ───────────────────

describe('computeThesisDrift — non-technical drivers', () => {
  it('fundamental_value → irrelevant (not technically verifiable)', () => {
    const result = computeThesisDrift(
      'fundamental_value',
      entrySnap({ rsi_14: 40 }),
      liveSnap({ rsi_14: 60 })
    );
    expect(result).not.toBeNull();
    expect(result.verdict).toBe('irrelevant');
    expect(result.reason).toContain('fundamental');
    expect(result.deltas).toEqual({});
  });

  it('macro_tailwind → irrelevant (not technically verifiable)', () => {
    const result = computeThesisDrift(
      'macro_tailwind',
      entrySnap({ adx_14: 15 }),
      liveSnap({ adx_14: 30 })
    );
    expect(result).not.toBeNull();
    expect(result.verdict).toBe('irrelevant');
    expect(result.reason).toContain('macro');
  });
});

// ── Result shape invariants ───────────────────────────────────────────────────

describe('computeThesisDrift — result shape', () => {
  it('always returns {verdict, reason, deltas} for known drivers', () => {
    const drivers = ['mean_reversion', 'momentum_breakout', 'trend_pullback',
                     'fundamental_value', 'macro_tailwind'];
    for (const driver of drivers) {
      const result = computeThesisDrift(
        driver,
        entrySnap({ rsi_14: 30, bb_pct_b: 0.2, adx_14: 20, return_5d: 0 }),
        liveSnap({ rsi_14: 50, bb_pct_b: 0.5, adx_14: 25, return_5d: 1 })
      );
      expect(result).not.toBeNull();
      expect(['validated','partially_validated','invalidated','reversed','irrelevant']).toContain(result.verdict);
      expect(typeof result.reason).toBe('string');
      expect(typeof result.deltas).toBe('object');
    }
  });

  it('verdict is one of the three allowed values', () => {
    const result = computeThesisDrift(
      'mean_reversion',
      entrySnap({ rsi_14: 28 }),
      liveSnap({ rsi_14: 50 })
    );
    expect(['validated','partially_validated','invalidated','reversed','irrelevant']).toContain(result.verdict);
  });
});
