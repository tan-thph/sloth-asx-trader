/**
 * tests/eval/eval.test.js — Eval Harness, Layer 1 (deterministic, no API cost).
 *
 * Replays FROZEN model outputs (real portfolio runs bootstrapped from ai_call_log,
 * plus targeted micro-scenarios) through the actual deterministic post-processing
 * stages — parser, validator, regime gate — and asserts pipeline INVARIANTS.
 *
 * Why this exists (EVAL_AND_MODEL_CALIBRATION_PLAN.md, Part A):
 *   The quant engine, validator, and regime gate are each unit-tested in isolation,
 *   but never on realistic WHOLE-BOOK model outputs. A prompt or model change that
 *   produces a subtly-wrong response (a mis-tagged driver, a panic-day BUY, a qty
 *   leak) is otherwise only caught by the 30-day outcome loop. This turns that into
 *   a red test in seconds. Assertions are hand-written invariants, NOT golden-string
 *   matches (which would break on every legitimate wording change).
 *
 * setup.js (vitest setupFile) already loads utils.js (parseClaudeJSON),
 * response-validator.js (validateRec), and regime-engine.js (applyRegimeModifiers)
 * as globals, so this file calls them directly on the frozen fixtures.
 *
 * To add a fixture: drop a JSON file in tests/eval/fixtures/ — the global-invariant
 * block below auto-discovers and runs it. Shape:
 *   { name, regime, holdings: {TICKER:{weightPct,sectorWeightPct,unrealisedPnl,daysHeld}},
 *     rawResponse: "<model JSON string>",
 *     expect: { parses, flaggedByValidator:[...], noDuplicateActionableTickers, allRecsStructurallyUsable } }
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const _DIR = dirname(fileURLToPath(import.meta.url));
const _FIX_DIR = join(_DIR, 'fixtures');

const _TICKER_RE = /^[A-Z0-9]{2,5}(\.AX)?$/;
const _ACTIONS = ['BUY', 'SELL', 'TRIM', 'TOP_UP', 'HOLD'];

function _loadFixtures() {
  return readdirSync(_FIX_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ file: f, data: JSON.parse(readFileSync(join(_FIX_DIR, f), 'utf8')) }));
}

// ── Global invariants — run against EVERY fixture ────────────────────────────
describe('eval harness — global pipeline invariants (all fixtures)', () => {
  const fixtures = _loadFixtures();

  it('has at least one fixture to run', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { file, data } of fixtures) {
    describe(`fixture: ${data.name || file}`, () => {
      const parsed = parseClaudeJSON(data.rawResponse);
      const exp = data.expect || {};

      it('parses to a {recs,...} shape', () => {
        expect(parsed.ok).toBe(true);
        expect(Array.isArray(parsed.data?.recs)).toBe(true);
        expect(parsed.data.recs.length).toBeGreaterThan(0);
      });

      if (exp.allRecsStructurallyUsable) {
        it('every rec has a valid ticker and a known action', () => {
          for (const r of parsed.data.recs) {
            expect(_TICKER_RE.test(r.ticker || ''), `bad ticker: ${r.ticker}`).toBe(true);
            expect(_ACTIONS.includes((r.action || '').toUpperCase()), `bad action: ${r.action}`).toBe(true);
          }
        });
      }

      if (exp.noDuplicateActionableTickers) {
        it('no ticker appears twice among actionable (non-HOLD) recs', () => {
          const seen = new Set();
          for (const r of parsed.data.recs) {
            if ((r.action || '').toUpperCase() === 'HOLD') continue;
            expect(seen.has(r.ticker), `duplicate actionable rec for ${r.ticker}`).toBe(false);
            seen.add(r.ticker);
          }
        });
      }

      // Validator must FLAG (valid:false) the recs the fixture says are mis-formed —
      // e.g. a risk_management SELL/TRIM without its required sector_concentration/
      // position_oversized secondary. This is the exact condition analysis.js keys off
      // to stamp _ruleWarnings (flag-don't-drop), so a regression that stopped catching
      // it would silently let bad tags into the learning loop.
      for (const tk of (exp.flaggedByValidator || [])) {
        it(`validator flags ${tk} (fails validateRec)`, () => {
          const rec = parsed.data.recs.find(r => r.ticker === tk);
          expect(rec, `fixture has no rec for ${tk}`).toBeTruthy();
          const ctx = data.holdings?.[tk] ? { holding: data.holdings[tk] } : undefined;
          const { valid } = validateRec(rec, ctx);
          expect(valid).toBe(false);
        });
      }

      // HOLD recs must never be spuriously dropped by the validator — they carry no
      // trade fields to fail on, and dropping them would erase the passivity signal
      // the HOLD-outcome learning path depends on.
      it('every HOLD rec passes the validator (valid or auto-fixed)', () => {
        for (const r of parsed.data.recs) {
          if ((r.action || '').toUpperCase() !== 'HOLD') continue;
          const { valid, fixed } = validateRec(r);
          expect(valid || fixed != null, `HOLD ${r.ticker} was dropped`).toBe(true);
        }
      });
    });
  }
});

// ── Regime-gate invariants — universal properties, inline micro-scenarios ────
describe('eval harness — regime gate invariants', () => {
  const buy = () => ({ action: 'BUY', ticker: 'BHP', qty: 100, riskAUD: 500, rewardAUD: 1200 });

  it('panic regime hard-blocks a BUY (qty=0, _regimeBlocked)', () => {
    const out = applyRegimeModifiers(buy(), 'panic');
    expect(out.qty).toBe(0);
    expect(out._regimeBlocked).toBe('panic');
  });

  it('non-panic regime never zero-blocks a BUY', () => {
    for (const rg of ['riskOn', 'trend', 'sideways', 'highVol', 'riskOff']) {
      const out = applyRegimeModifiers(buy(), rg);
      expect(out._regimeBlocked, `${rg} should not hard-block`).toBeUndefined();
      expect(out.qty, `${rg} zeroed qty`).toBeGreaterThan(0);
    }
  });
});

// ── Sizing-leak invariant — a qty=0 actionable rec must never validate ────────
// Rule 4 makes Claude emit qty:0; the quant engine sizes it. If sizing is skipped or
// rejects (Kelly ≤ 0, unheld SELL), qty stays 0 — which previously slipped through as
// an un-executable rec. The validator's qty≥1 schema is the backstop; lock it in.
describe('eval harness — no qty=0 actionable rec survives the validator', () => {
  it('rejects a BUY left at qty=0', () => {
    const rec = {
      action: 'BUY', ticker: 'BHP', qty: 0,
      priceRange: [44, 44.8], target: 49.5, stopLoss: 42.1,
      confidence: 0.7, scenarios: { bull: { p: 0.3, ret: 0.1 }, base: { p: 0.5, ret: 0.05 }, bear: { p: 0.2, ret: -0.04 } },
      invalidationCondition: 'close below $42.10',
    };
    const { valid, fixed } = validateRec(rec);
    // qty=0 fails the schema (min 1); the rec must not come back clean-valid.
    expect(valid).toBe(false);
    expect(fixed).toBeNull();
  });
});
