/**
 * tests/day-trading.test.js — day-trading strategy helpers.
 *
 * Covers _dtImpliedWinProb: the inversion that turns the ridge model's predicted
 * expected-R into the Kelly win-probability that drives position sizing. This is
 * the maths at the centre of wiring the ML model back into swing sizing, so it is
 * tested directly rather than via the full _dtBuildRecs pipeline (which needs the
 * whole live-signals / model / quant-engine stack).
 */

import { describe, it, expect } from 'vitest';
import { extractFunction } from './setup.js';

// eslint-disable-next-line no-eval
const _dtImpliedWinProb = eval('(' + extractFunction('js/day-trading-analysis.js', '_dtImpliedWinProb') + ')');

describe('_dtImpliedWinProb', () => {
  it('inverts E[R] = p*(b+1) - 1 exactly for a mid-range case', () => {
    // b = 2, want p = 0.6  ⇒  E[R] = 0.6*3 - 1 = 0.8
    expect(_dtImpliedWinProb(0.8, 2)).toBeCloseTo(0.6, 6);
  });

  it('breakeven expected-R maps to the Kelly-neutral probability', () => {
    // E[R] = 0 with b = 2  ⇒  p = 1/3 (exactly the Kelly breakeven q/(1) point)
    expect(_dtImpliedWinProb(0, 2)).toBeCloseTo(1 / 3, 6);
  });

  it('floors a very negative expected-R to 0.02 (lets the engine reject on EV, not "winProb missing")', () => {
    expect(_dtImpliedWinProb(-5, 2)).toBe(0.02);
  });

  it('caps an over-optimistic expected-R at 0.95', () => {
    expect(_dtImpliedWinProb(10, 2)).toBe(0.95);
  });

  it('returns null for unusable inputs', () => {
    expect(_dtImpliedWinProb(null, 2)).toBeNull();
    expect(_dtImpliedWinProb(0.5, 0)).toBeNull();       // rrRatio must be > 0
    expect(_dtImpliedWinProb(Infinity, 2)).toBeNull();
    expect(_dtImpliedWinProb(0.5, -1)).toBeNull();
  });

  it('a higher expected-R implies a higher win-prob (monotonic) at fixed b', () => {
    const lo = _dtImpliedWinProb(0.2, 3);
    const hi = _dtImpliedWinProb(1.2, 3);
    expect(hi).toBeGreaterThan(lo);
  });
});
