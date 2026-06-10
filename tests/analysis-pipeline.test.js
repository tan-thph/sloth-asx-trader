/**
 * tests/analysis-pipeline.test.js — §K behavioural tests for the
 * analysis.js pipeline helper functions.
 *
 * Tests _applyCorrSizing and _applyHeatBudget directly, verifying that
 * the actual logic (thresholds, multipliers, blocking, scaling) is correct
 * rather than just asserting the source contains certain strings.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadScript } from './setup.js';

beforeAll(() => {
  // Minimal stubs analysis.js needs at parse time
  global.totalNetWorth   = () => 100000;
  global.getApiKey       = () => 'key';
  global.toast           = () => {};
  global.showPage        = () => {};
  global.scheduleSave    = () => {};
  global.dtSaveSnapshot  = () => {};
  global.logRecsToLearningLoop = () => {};
  global.localStorage    = { getItem: () => null, setItem: () => {} };
  global.document        = { getElementById: () => null };
  loadScript('js/analysis.js');
});

// ── helpers ──────────────────────────────────────────────────────────────────

function buyRec(overrides) {
  return Object.assign({ action: 'BUY', ticker: 'NEW', qty: 100, riskAUD: 500 }, overrides);
}

// ── _applyCorrSizing ─────────────────────────────────────────────────────────

describe('_applyCorrSizing', () => {
  it('passes through HOLD recs unchanged', () => {
    const rec = { action: 'HOLD', ticker: 'XYZ', qty: 50 };
    const result = _applyCorrSizing([rec], { XYZ: { CBA: 0.95 } }, ['CBA']);
    expect(result[0]).toEqual(rec);
    expect(result[0]._corrNote).toBeUndefined();
  });

  it('passes through SELL recs unchanged', () => {
    const rec = { action: 'SELL', ticker: 'XYZ', qty: 50, riskAUD: 200 };
    const result = _applyCorrSizing([rec], { XYZ: { CBA: 0.95 } }, ['CBA']);
    expect(result[0].qty).toBe(50);
    expect(result[0]._corrNote).toBeUndefined();
  });

  it('leaves BUY unchanged when correlation <= 0.7', () => {
    const rec = buyRec({ ticker: 'WBC', qty: 100, riskAUD: 500 });
    const corrMatrix = { WBC: { CBA: 0.65 } };
    const result = _applyCorrSizing([rec], corrMatrix, ['CBA']);
    expect(result[0].qty).toBe(100);
    expect(result[0].riskAUD).toBe(500);
    expect(result[0]._corrNote).toBeUndefined();
  });

  it('reduces BUY qty by 30% when 0.7 < correlation <= 0.85', () => {
    const rec = buyRec({ ticker: 'WBC', qty: 100, riskAUD: 1000 });
    const corrMatrix = { WBC: { CBA: 0.75 } };
    const result = _applyCorrSizing([rec], corrMatrix, ['CBA']);
    expect(result[0].qty).toBe(70);           // Math.round(100 * 0.7)
    expect(result[0].riskAUD).toBe(700);      // Math.round(1000 * 0.7)
    expect(result[0]._corrNote).toMatch(/−30%/);
    expect(result[0]._corrNote).toMatch(/CBA/);
  });

  it('halves BUY qty when correlation > 0.85', () => {
    const rec = buyRec({ ticker: 'WBC', qty: 100, riskAUD: 1000 });
    const corrMatrix = { WBC: { CBA: 0.92 } };
    const result = _applyCorrSizing([rec], corrMatrix, ['CBA']);
    expect(result[0].qty).toBe(50);
    expect(result[0].riskAUD).toBe(500);
    expect(result[0]._corrNote).toMatch(/halved/);
  });

  it('uses the highest correlated holding when multiple exist', () => {
    const rec = buyRec({ ticker: 'ANZ', qty: 100, riskAUD: 1000 });
    // CBA at 0.65 (below threshold), WBC at 0.88 (above 0.85)
    const corrMatrix = { ANZ: { CBA: 0.65, WBC: 0.88 } };
    const result = _applyCorrSizing([rec], corrMatrix, ['CBA', 'WBC']);
    expect(result[0].qty).toBe(50);   // halved because of WBC at 0.88
    expect(result[0]._corrNote).toMatch(/WBC/);
  });

  it('skips self-correlation (ticker === holding)', () => {
    // If a ticker is both in portfolio and a rec, its own corr row would
    // contain itself — should be skipped
    const rec = buyRec({ ticker: 'BHP', qty: 100, riskAUD: 1000 });
    const corrMatrix = { BHP: { BHP: 1.0, CBA: 0.50 } };
    const result = _applyCorrSizing([rec], corrMatrix, ['BHP', 'CBA']);
    expect(result[0].qty).toBe(100);   // self excluded, CBA at 0.5 below threshold
    expect(result[0]._corrNote).toBeUndefined();
  });

  it('enforces minimum qty of 1 even after halving', () => {
    const rec = buyRec({ ticker: 'XYZ', qty: 1, riskAUD: 50 });
    const corrMatrix = { XYZ: { CBA: 0.90 } };
    const result = _applyCorrSizing([rec], corrMatrix, ['CBA']);
    expect(result[0].qty).toBe(1);    // Math.max(1, Math.round(1 * 0.5)) = 1
  });

  it('TOP_UP is treated the same as BUY', () => {
    const rec = buyRec({ action: 'TOP_UP', ticker: 'WBC', qty: 50, riskAUD: 500 });
    const corrMatrix = { WBC: { CBA: 0.88 } };
    const result = _applyCorrSizing([rec], corrMatrix, ['CBA']);
    expect(result[0].qty).toBe(25);
    expect(result[0]._corrNote).toMatch(/halved/);
  });
});

// ── _applyHeatBudget ─────────────────────────────────────────────────────────

describe('_applyHeatBudget', () => {
  it('passes rec through unchanged when it fits within budget', () => {
    const rec = buyRec({ qty: 10, riskAUD: 400 });
    const { recs, scaled, blocked } = _applyHeatBudget([rec], 1000, 0, 'user');
    expect(recs[0].qty).toBe(10);
    expect(recs[0]._budgetBlocked).toBeUndefined();
    expect(recs[0]._budgetScaled).toBeUndefined();
    expect(scaled).toBe(0);
    expect(blocked).toBe(0);
  });

  it('blocks rec when budget is already exhausted (consumed >= budgetAUD)', () => {
    const rec = buyRec({ qty: 10, riskAUD: 100 });
    const { recs, blocked } = _applyHeatBudget([rec], 500, 500, 'user');
    expect(recs[0].qty).toBe(0);
    expect(recs[0]._budgetBlocked).toBe(true);
    expect(blocked).toBe(1);
  });

  it('blocks rec when remaining budget < cost of 1 share', () => {
    // $30 remaining, $50/share risk → can't fit even 1 share
    const rec = buyRec({ qty: 10, riskAUD: 500 });  // $50/share
    const { recs, blocked } = _applyHeatBudget([rec], 500, 470, 'user');
    expect(recs[0].qty).toBe(0);
    expect(recs[0]._budgetBlocked).toBe(true);
    expect(blocked).toBe(1);
  });

  it('scales down qty when rec partially fits', () => {
    // budget=1000, consumed=600, remaining=400; rec costs $500 total ($50/share × 10)
    const rec = buyRec({ qty: 10, riskAUD: 500 });
    const { recs, scaled } = _applyHeatBudget([rec], 1000, 600, 'user');
    // $400 remaining / $50 per share = 8 shares
    expect(recs[0].qty).toBe(8);
    expect(recs[0].riskAUD).toBeCloseTo(400, 1);
    expect(recs[0]._budgetScaled).toBe(true);
    expect(scaled).toBe(1);
  });

  it('passes HOLD/SELL through regardless of budget', () => {
    const hold = { action: 'HOLD', ticker: 'XYZ', qty: 0 };
    const sell = { action: 'SELL', ticker: 'XYZ', qty: 50, riskAUD: 200 };
    const { recs, blocked } = _applyHeatBudget([hold, sell], 0, 0, 'user');
    expect(recs[0].qty).toBe(0);
    expect(recs[0]._budgetBlocked).toBeUndefined();
    expect(recs[1].qty).toBe(50);
    expect(blocked).toBe(0);
  });

  it('accounts for consumed budget across multiple recs in same batch', () => {
    // budget=650, consumed=0; r1=$600 fits (remaining→$50); r2=$600 @$60/share
    // → scaledQty=floor(50/60)=0 → blocked
    const r1 = buyRec({ ticker: 'BHP', qty: 10, riskAUD: 600 });
    const r2 = buyRec({ ticker: 'RIO', qty: 10, riskAUD: 600 });
    const { recs, blocked } = _applyHeatBudget([r1, r2], 650, 0, 'user');
    expect(recs[0]._budgetBlocked).toBeUndefined();   // first fits
    expect(recs[1]._budgetBlocked).toBe(true);        // $50 remaining < $60/share
    expect(blocked).toBe(1);
  });

  it('includes source label in _budgetNote', () => {
    const rec = buyRec({ qty: 10, riskAUD: 900 });
    const { recs } = _applyHeatBudget([rec], 500, 0, 'regime:panic');
    expect(recs[0]._budgetNote).toMatch(/regime:panic/);
  });

  it('rec with riskAUD=0 is skipped by heat gate', () => {
    const rec = buyRec({ qty: 10, riskAUD: 0 });
    const { recs, blocked } = _applyHeatBudget([rec], 0, 0, 'user');
    expect(recs[0]._budgetBlocked).toBeUndefined();
    expect(blocked).toBe(0);
  });
});
