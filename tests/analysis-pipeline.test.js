/**
 * tests/analysis-pipeline.test.js — §K behavioural tests for the
 * analysis.js pipeline helper functions.
 *
 * Tests _applyCorrSizing and _applyHeatBudget directly, verifying that
 * the actual logic (thresholds, multipliers, blocking, scaling) is correct
 * rather than just asserting the source contains certain strings.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadScript } from './setup.js';

const _ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

// ── _unheldHasActiveSetup (two-tier gate for NOT-HELD tickers) ────────────────
// Ownership-keyed tiering: holdings are always Tier 1 (asserted via _isCandidate's
// short-circuit, not this fn); a not-held watchlist ticker gets a full Tier-1 block
// ONLY when it shows an active setup, else a compressed Tier-2 one-liner.
describe('_unheldHasActiveSetup', () => {
  const quiet = { rsi_14: 50, bb_pct_b: 0.5, score: 45, volume_z_score: 0.5 };

  it('a quiet not-held ticker is Tier 2 (no full block)', () => {
    expect(_unheldHasActiveSetup(quiet)).toBe(false);
  });

  it('promotes on an oversold/overbought RSI extreme', () => {
    expect(_unheldHasActiveSetup({ ...quiet, rsi_14: 34 })).toBe(true);
    expect(_unheldHasActiveSetup({ ...quiet, rsi_14: 72 })).toBe(true);
  });

  it('promotes on a Bollinger band edge', () => {
    expect(_unheldHasActiveSetup({ ...quiet, bb_pct_b: 0.05 })).toBe(true);
    expect(_unheldHasActiveSetup({ ...quiet, bb_pct_b: 0.95 })).toBe(true);
  });

  it('promotes on a strong composite score (bull or bear)', () => {
    expect(_unheldHasActiveSetup({ ...quiet, score: 70 })).toBe(true);
    expect(_unheldHasActiveSetup({ ...quiet, score: 25 })).toBe(true);
  });

  it('promotes on pre-earnings risk or a volume spike', () => {
    expect(_unheldHasActiveSetup({ ...quiet, pre_earnings_risk: true })).toBe(true);
    expect(_unheldHasActiveSetup({ ...quiet, volume_z_score: 3.1 })).toBe(true);
  });

  it('a mid-range partial signal stays Tier 2, and null never crashes', () => {
    expect(_unheldHasActiveSetup({ score: 50 })).toBe(false); // rsi/bb default neutral
    expect(_unheldHasActiveSetup(null)).toBe(false);
  });
});

// ── _isCandidate ownership-keyed source guard ────────────────────────────────
// The tier axis must stay "do I own it?", not "is the signal loud?". Holdings must
// short-circuit to Tier 1; watchlist must NOT be auto-promoted (that was the old bug).
describe('_isCandidate tier axis (source guard)', () => {
  const src = readFileSync(join(_ROOT, 'js/analysis.js'), 'utf8');
  const body = src.slice(src.indexOf('const _isCandidate ='), src.indexOf('const _isCandidate =') + 400);

  it('holdings short-circuit to Tier 1', () => {
    expect(body).toMatch(/portfolioTickers\.includes\(t\)\)\s*return true/);
  });

  it('does not auto-promote watchlist (no isExtra in the gate)', () => {
    expect(body).not.toMatch(/\bisExtra\b/);
  });

  it('delegates the not-held case to the pure setup helper', () => {
    expect(body).toContain('_unheldHasActiveSetup(s)');
  });
});

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

// ── _classifyRuleWarnings: Critic-B codes (tier2_rec, factor_thin) ────────────

describe('_classifyRuleWarnings — Critic B codes', () => {
  it('maps the _tier2Rec flag to a tier2_rec code', () => {
    const codes = _classifyRuleWarnings({ _tier2Rec: true, _ruleWarnings: [] }).map(w => w.code);
    expect(codes).toContain('tier2_rec');
  });

  it('maps a Tier-2 warning string to tier2_rec (not validator_fail)', () => {
    const out = _classifyRuleWarnings({
      _ruleWarnings: ['Tier-2 data only: CSL was shown as a compressed one-line summary — fabrication risk.'],
    });
    const codes = out.map(w => w.code);
    expect(codes).toContain('tier2_rec');
    expect(codes).not.toContain('validator_fail');
  });

  it('maps the _factorThin flag to a factor_thin code', () => {
    const codes = _classifyRuleWarnings({ _factorThin: 1, _ruleWarnings: [] }).map(w => w.code);
    expect(codes).toContain('factor_thin');
  });

  it('maps a thin-basis warning string to factor_thin (not validator_fail)', () => {
    const out = _classifyRuleWarnings({
      _ruleWarnings: ['Thin non-technical basis: 1 [FUNDAMENTAL]/[MACRO] factor(s) (<3) — technicals are tie-breakers only (Rule 5).'],
    });
    const codes = out.map(w => w.code);
    expect(codes).toContain('factor_thin');
    expect(codes).not.toContain('validator_fail');
  });

  it('a clean rec produces no codes', () => {
    expect(_classifyRuleWarnings({ _ruleWarnings: [] })).toEqual([]);
  });
});
