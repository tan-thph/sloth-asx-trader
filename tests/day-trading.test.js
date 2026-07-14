/**
 * tests/day-trading.test.js — day-trading strategy helpers.
 *
 * Covers _dtImpliedWinProb: the inversion that turns the ridge model's predicted
 * expected-R into the Kelly win-probability that drives position sizing. This is
 * the maths at the centre of wiring the ML model back into swing sizing, so it is
 * tested directly rather than via the full _dtBuildRecs pipeline (which needs the
 * whole live-signals / model / quant-engine stack).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractFunction } from './setup.js';

const _ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const _read = (p) => readFileSync(join(_ROOT, p), 'utf8');

// eslint-disable-next-line no-eval
const _dtImpliedWinProb = eval('(' + extractFunction('js/day-trading-analysis.js', '_dtImpliedWinProb') + ')');
// eslint-disable-next-line no-eval
const _intradayReversionRR = eval('(' + extractFunction('js/intraday-strategy.js', '_intradayReversionRR') + ')');
// parseDate must be in module scope BEFORE _dtTradingDaysElapsed is eval'd, so the
// extracted function (which references `parseDate` by name) resolves it via closure.
// eslint-disable-next-line no-eval
const parseDate = eval('(' + extractFunction('js/portfolio-helpers.js', 'parseDate') + ')');
// eslint-disable-next-line no-eval
const _dtTradingDaysElapsed = eval('(' + extractFunction('js/pages/day-trading.js', '_dtTradingDaysElapsed') + ')');

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

describe('_intradayReversionRR', () => {
  // entry 99, stop 98 (risk 1), vwap 100.5 (reward to VWAP 1.5), target 102 (extended reward 3)
  it('measures reward to VWAP, not to the extended take-profit', () => {
    expect(_intradayReversionRR(99, 98, 100.5, 102)).toBeCloseTo(1.5, 2);   // NOT 3.0
  });

  it('is much stricter than the old to-target R:R (the whole point of the fix)', () => {
    const rev = _intradayReversionRR(99, 98, 100.5, 102);      // 1.5
    const ext = +((102 - 99) / (99 - 98)).toFixed(2);           // 3.0 — old inflated gate
    expect(rev).toBeLessThan(ext);
  });

  it('falls back to reward-to-target when VWAP is not above entry', () => {
    // vwap 98.5 ≤ entry 99 → no reversion edge; use (target−entry)/(entry−stop) = 3/1
    expect(_intradayReversionRR(99, 98, 98.5, 102)).toBeCloseTo(3, 2);
  });

  it('returns null for a non-positive risk (stop at/above entry)', () => {
    expect(_intradayReversionRR(99, 99, 100.5, 102)).toBeNull();
    expect(_intradayReversionRR(99, 100, 100.5, 102)).toBeNull();
  });

  it('returns null when both reversion and target rewards are non-positive', () => {
    expect(_intradayReversionRR(99, 98, 98.5, 98)).toBeNull();   // vwap<entry, target<entry
  });
});

// ── Swing Time Stop date-parse regression ──────────────────────────────────────
// r.date is DD-MM-YYYY (todayStr()/en-AU). _dtTradingDaysElapsed MUST parse it via
// parseDate(), not `new Date()` — the latter reads "05-07-2026" as MM-DD-YYYY
// (7 May, not 5 Jul), inflating elapsed days and firing spurious Time Stop alerts
// (the FMG/WDS symptom). Fixed "now" via fake timers makes these exact.
describe('_dtTradingDaysElapsed (swing Time Stop date parse)', () => {
  afterEach(() => vi.useRealTimers());

  it('parses DD-MM-YYYY correctly — 9 calendar days → 6 trading days, NOT the month-swapped 48', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 14)); // 14 Jul 2026, local midnight
    // "05-07-2026" = 5 Jul 2026 → 9 calendar days → floor(9*5/7)=6.
    // A raw new Date('05-07-2026') would read 7 May → 68 days → 48 (spurious Time Stop).
    expect(_dtTradingDaysElapsed('05-07-2026')).toBe(6);
  });

  it('a same-day entry is 0 days elapsed (no premature alert)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 14));
    expect(_dtTradingDaysElapsed('14-07-2026')).toBe(0);
  });

  it('a day-of-month > 12 no longer parses to Invalid Date (badge suppression bug)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 28)); // 28 Jul 2026
    // "14-07-2026" would be Invalid Date under new Date() → NaN → 0 (real time-stop hidden).
    // Correct: 14 Jul → 14 calendar days → floor(14*5/7)=10.
    expect(_dtTradingDaysElapsed('14-07-2026')).toBe(10);
  });

  it('a future-dated entry clamps to 0', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 14));
    expect(_dtTradingDaysElapsed('20-07-2026')).toBe(0);
  });

  it('empty/missing date is 0', () => {
    expect(_dtTradingDaysElapsed('')).toBe(0);
    expect(_dtTradingDaysElapsed(null)).toBe(0);
  });
});

// ── Audit B1: panic/regime-blocked day-trade recs must never be executable ─────
// Gotcha #3 — a rec that comes back qty=0/_regimeBlocked from applyRegimeModifiers
// must be dropped at build time AND hard-refused at execute time (belt-and-braces).
describe('regime-blocked day-trade recs (Audit B1)', () => {
  it('_dtBuildRecs drops _regimeBlocked recs before pushing them', () => {
    const src = _read('js/day-trading-analysis.js');
    // The guard sits right after applyRegimeModifiers and continues the loop.
    const afterMod = src.slice(src.indexOf('applyRegimeModifiers(rec, regime)'));
    expect(afterMod).toMatch(/if\s*\(\s*rec\._regimeBlocked\s*\)/);
    expect(afterMod.slice(0, 800)).toContain('continue');
  });

  it('executeDayTrade (swing) hard-refuses a _regimeBlocked rec', () => {
    const body = extractFunction('js/day-trading-analysis.js', 'executeDayTrade');
    expect(body).toMatch(/rec\._regimeBlocked/);
    expect(body).toMatch(/return/);
  });

  it('executeIntradayTrade hard-refuses a _regimeBlocked rec', () => {
    const body = extractFunction('js/pages/day-trading.js', 'executeIntradayTrade');
    expect(body).toMatch(/rec\._regimeBlocked/);
  });

  it('_renderDtRec renders a disabled regime-blocked state instead of Execute', () => {
    const body = extractFunction('js/pages/day-trading.js', '_renderDtRec');
    // The Execute button must be gated behind !r._regimeBlocked.
    expect(body).toMatch(/isPending\s*&&\s*!r\._regimeBlocked/);
    expect(body).toMatch(/isPending\s*&&\s*r\._regimeBlocked/);
  });
});
