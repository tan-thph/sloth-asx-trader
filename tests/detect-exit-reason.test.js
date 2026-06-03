/**
 * tests/detect-exit-reason.test.js
 *
 * Tests for _detectExitReason() — direction-aware exit classifier.
 *
 * §3.8: The function now lives in a single canonical copy in utils.js.
 * Both recommendations.js and performance.js reference it via the shared global.
 * The "both copies" pattern has been retired — there is one source of truth.
 *
 * See CLAUDE.md gotcha #14 and test_detect_exit_reason_helper_present in test_app.py.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractFunction } from './setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load _detectExitReason from utils.js (single canonical source) ─────────────

const utilsSrc = extractFunction('js/utils.js', '_detectExitReason');
const _detectExitReason = new Function(`${utilsSrc}\nreturn _detectExitReason;`)();

// ── Sanity check: page files must NOT redefine the function ───────────────────

describe('_detectExitReason — single canonical copy in utils.js', () => {
  it('recommendations.js must not redefine _detectExitReason', () => {
    const src = readFileSync(join(ROOT, 'js/pages/recommendations.js'), 'utf8');
    expect(src).not.toContain('function _detectExitReason');
  });

  it('performance.js must not redefine _detectExitReason', () => {
    const src = readFileSync(join(ROOT, 'js/pages/performance.js'), 'utf8');
    expect(src).not.toContain('function _detectExitReason');
  });

  it('utils.js defines the function with correct logic', () => {
    const src = readFileSync(join(ROOT, 'js/utils.js'), 'utf8');
    expect(src).toContain('function _detectExitReason');
    expect(src).toContain('stop_hit');
    expect(src).toContain('target_hit');
  });
});

// ── BUY / TOP_UP — long frame ─────────────────────────────────────────────────
// For a long trade: stop is BELOW entry, target is ABOVE entry.
// stop_hit  when exit ≤ stopLoss × 1.005
// target_hit when exit ≥ target  × 0.995
// manual    otherwise

describe('_detectExitReason — BUY (long frame)', () => {
  const stop   = 9.00;
  const target = 12.00;

  it('stop_hit when exit at stopLoss', () => {
    expect(_detectExitReason(9.00, stop, target, 'BUY')).toBe('stop_hit');
  });

  it('stop_hit when exit slightly above stopLoss (within 0.5%)', () => {
    expect(_detectExitReason(9.04, stop, target, 'BUY')).toBe('stop_hit');   // 9.04 ≤ 9×1.005=9.045
  });

  it('target_hit when exit at target', () => {
    expect(_detectExitReason(12.00, stop, target, 'BUY')).toBe('target_hit');
  });

  it('target_hit when exit slightly below target (within 0.5%)', () => {
    expect(_detectExitReason(11.94, stop, target, 'BUY')).toBe('target_hit');  // 11.94 ≥ 12×0.995=11.94
  });

  it('manual when exit is between stop and target', () => {
    expect(_detectExitReason(10.50, stop, target, 'BUY')).toBe('manual');
  });

  it('TOP_UP action treated identically to BUY', () => {
    expect(_detectExitReason(9.00,  stop, target, 'TOP_UP')).toBe('stop_hit');
    expect(_detectExitReason(12.00, stop, target, 'TOP_UP')).toBe('target_hit');
    expect(_detectExitReason(10.50, stop, target, 'TOP_UP')).toBe('manual');
  });
});

// ── SELL / TRIM — short frame ─────────────────────────────────────────────────
// For a short/exit trade: stop is ABOVE entry, target is BELOW entry (inverse).
// stop_hit  when exit ≥ stopLoss × 0.995   (price moved up, hit the stop)
// target_hit when exit ≤ target   × 1.005  (price fell to target — profit)
// manual    otherwise

describe('_detectExitReason — SELL (short/exit frame)', () => {
  const stop   = 11.00;
  const target = 8.00;

  it('stop_hit when exit at stop (price rose through stop)', () => {
    expect(_detectExitReason(11.00, stop, target, 'SELL')).toBe('stop_hit');
  });

  it('stop_hit when exit slightly below stop (within 0.5%)', () => {
    expect(_detectExitReason(10.945, stop, target, 'SELL')).toBe('stop_hit');  // 10.945 ≥ 11×0.995=10.945
  });

  it('target_hit when exit at target (price fell to target — profit)', () => {
    expect(_detectExitReason(8.00, stop, target, 'SELL')).toBe('target_hit');
  });

  it('target_hit when exit slightly above target (within 0.5%)', () => {
    expect(_detectExitReason(8.04, stop, target, 'SELL')).toBe('target_hit');  // 8.04 ≤ 8×1.005=8.04
  });

  it('manual when exit is between target and stop', () => {
    expect(_detectExitReason(9.50, stop, target, 'SELL')).toBe('manual');
  });

  it('TRIM action treated identically to SELL', () => {
    expect(_detectExitReason(11.00, stop, target, 'TRIM')).toBe('stop_hit');
    expect(_detectExitReason(8.00,  stop, target, 'TRIM')).toBe('target_hit');
    expect(_detectExitReason(9.50,  stop, target, 'TRIM')).toBe('manual');
  });

  it('profitable TRIM not mislabelled as stop_hit (regression guard)', () => {
    // A profitable TRIM: entry $10, exited at $8 (profit for a SELL).
    // stop = $11, target = $8.  Exit $8.00 should be target_hit, NOT stop_hit.
    expect(_detectExitReason(8.00, 11.00, 8.00, 'TRIM')).toBe('target_hit');
  });
});

// ── Geometry fallback (no action provided) ────────────────────────────────────

describe('_detectExitReason — geometry fallback (action absent)', () => {
  it('infers short frame when stop > target', () => {
    expect(_detectExitReason(8.00, 11.00, 8.00, null)).toBe('target_hit');
    expect(_detectExitReason(11.00, 11.00, 8.00, null)).toBe('stop_hit');
  });

  it('infers long frame when stop < target', () => {
    expect(_detectExitReason(9.00, 9.00, 12.00, null)).toBe('stop_hit');
    expect(_detectExitReason(12.00, 9.00, 12.00, null)).toBe('target_hit');
  });

  it('returns manual when exit is between levels regardless of frame', () => {
    expect(_detectExitReason(10.00, 9.00, 12.00, null)).toBe('manual');  // long
    expect(_detectExitReason(10.00, 11.00, 8.00, null)).toBe('manual');  // short
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('_detectExitReason — edge cases', () => {
  it('returns manual when exitPrice is 0 or null', () => {
    expect(_detectExitReason(0,    9.00, 12.00, 'BUY')).toBe('manual');
    expect(_detectExitReason(null, 9.00, 12.00, 'BUY')).toBe('manual');
  });

  it('works when stopLoss is null (no stop set)', () => {
    const result = _detectExitReason(12.00, null, 12.00, 'BUY');
    expect(['target_hit', 'manual']).toContain(result);
  });

  it('works when target is null (no target set)', () => {
    const result = _detectExitReason(9.00, 9.00, null, 'BUY');
    expect(['stop_hit', 'manual']).toContain(result);
  });
});
