/**
 * tests/detect-exit-reason.test.js
 *
 * Tests for _detectExitReason() — direction-aware exit classifier.
 *
 * CRITICAL: the function is duplicated in recommendations.js (loaded first)
 * and performance.js (loaded second, wins at runtime).  We test both copies
 * independently to guard against the two getting out of sync.
 *
 * See CLAUDE.md gotcha #14 and test_detect_exit_reason_direction_aware in test_app.py.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractFunction } from './setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load both copies of _detectExitReason into separate functions ─────────────

// Extract the function source from each file and create renamed wrappers
// so both can coexist in the same test module.
const recSrc  = extractFunction('js/pages/recommendations.js', '_detectExitReason');
const perfSrc = extractFunction('js/pages/performance.js',     '_detectExitReason');

// Evaluate each into a locally scoped function
const _detectExitReason_recs = new Function(
  `${recSrc}\nreturn _detectExitReason;`
)();
const _detectExitReason_perf = new Function(
  `${perfSrc}\nreturn _detectExitReason;`
)();

// Helper: run the same test case against both copies and expect identical results
function bothCopies(label, fn) {
  it(`[recs copy] ${label}`, () => fn(_detectExitReason_recs));
  it(`[perf copy] ${label}`, () => fn(_detectExitReason_perf));
}

// ── BUY / TOP_UP — long frame ─────────────────────────────────────────────────
// For a long trade: stop is BELOW entry, target is ABOVE entry.
// stop_hit  when exit ≤ stopLoss × 1.005
// target_hit when exit ≥ target  × 0.995
// manual    otherwise

describe('_detectExitReason — BUY (long frame)', () => {
  // Entry ~$10, stop $9, target $12
  const stop   = 9.00;
  const target = 12.00;

  bothCopies('stop_hit when exit at stopLoss', fn => {
    expect(fn(9.00, stop, target, 'BUY')).toBe('stop_hit');
  });

  bothCopies('stop_hit when exit slightly above stopLoss (within 0.5%)', fn => {
    expect(fn(9.04, stop, target, 'BUY')).toBe('stop_hit');   // 9.04 ≤ 9×1.005=9.045
  });

  bothCopies('target_hit when exit at target', fn => {
    expect(fn(12.00, stop, target, 'BUY')).toBe('target_hit');
  });

  bothCopies('target_hit when exit slightly below target (within 0.5%)', fn => {
    expect(fn(11.94, stop, target, 'BUY')).toBe('target_hit');  // 11.94 ≥ 12×0.995=11.94
  });

  bothCopies('manual when exit is between stop and target', fn => {
    expect(fn(10.50, stop, target, 'BUY')).toBe('manual');
  });

  bothCopies('TOP_UP action treated identically to BUY', fn => {
    expect(fn(9.00,  stop, target, 'TOP_UP')).toBe('stop_hit');
    expect(fn(12.00, stop, target, 'TOP_UP')).toBe('target_hit');
    expect(fn(10.50, stop, target, 'TOP_UP')).toBe('manual');
  });
});

// ── SELL / TRIM — short frame ─────────────────────────────────────────────────
// For a short/exit trade: stop is ABOVE entry, target is BELOW entry (inverse).
// stop_hit  when exit ≥ stopLoss × 0.995   (price moved up, hit the stop)
// target_hit when exit ≤ target   × 1.005  (price fell to target — profit)
// manual    otherwise

describe('_detectExitReason — SELL (short/exit frame)', () => {
  // Entry ~$10, stop $11 (above), target $8 (below)
  const stop   = 11.00;
  const target = 8.00;

  bothCopies('stop_hit when exit at stop (price rose through stop)', fn => {
    expect(fn(11.00, stop, target, 'SELL')).toBe('stop_hit');
  });

  bothCopies('stop_hit when exit slightly below stop (within 0.5%)', fn => {
    expect(fn(10.945, stop, target, 'SELL')).toBe('stop_hit');  // 10.945 ≥ 11×0.995=10.945
  });

  bothCopies('target_hit when exit at target (price fell to target — profit)', fn => {
    expect(fn(8.00, stop, target, 'SELL')).toBe('target_hit');
  });

  bothCopies('target_hit when exit slightly above target (within 0.5%)', fn => {
    expect(fn(8.04, stop, target, 'SELL')).toBe('target_hit');  // 8.04 ≤ 8×1.005=8.04
  });

  bothCopies('manual when exit is between target and stop', fn => {
    expect(fn(9.50, stop, target, 'SELL')).toBe('manual');
  });

  bothCopies('TRIM action treated identically to SELL', fn => {
    expect(fn(11.00, stop, target, 'TRIM')).toBe('stop_hit');
    expect(fn(8.00,  stop, target, 'TRIM')).toBe('target_hit');
    expect(fn(9.50,  stop, target, 'TRIM')).toBe('manual');
  });

  bothCopies('profitable TRIM not mislabelled as stop_hit (regression guard)', fn => {
    // A profitable TRIM: entry $10, exited at $8 (profit for a SELL).
    // stop = $11, target = $8.  Exit $8.00 should be target_hit, NOT stop_hit.
    expect(fn(8.00, 11.00, 8.00, 'TRIM')).toBe('target_hit');
  });
});

// ── Geometry fallback (no action provided) ────────────────────────────────────

describe('_detectExitReason — geometry fallback (action absent)', () => {
  bothCopies('infers short frame when stop > target', fn => {
    // stop $11 > target $8 → short frame → target_hit when exit at $8
    expect(fn(8.00, 11.00, 8.00, null)).toBe('target_hit');
    expect(fn(11.00, 11.00, 8.00, null)).toBe('stop_hit');
  });

  bothCopies('infers long frame when stop < target', fn => {
    // stop $9 < target $12 → long frame → stop_hit when exit at $9
    expect(fn(9.00, 9.00, 12.00, null)).toBe('stop_hit');
    expect(fn(12.00, 9.00, 12.00, null)).toBe('target_hit');
  });

  bothCopies('returns manual when exit is between levels regardless of frame', fn => {
    expect(fn(10.00, 9.00, 12.00, null)).toBe('manual');  // long
    expect(fn(10.00, 11.00, 8.00, null)).toBe('manual');  // short
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('_detectExitReason — edge cases', () => {
  bothCopies('returns manual when exitPrice is 0 or null', fn => {
    expect(fn(0,    9.00, 12.00, 'BUY')).toBe('manual');
    expect(fn(null, 9.00, 12.00, 'BUY')).toBe('manual');
  });

  bothCopies('works when stopLoss is null (no stop set)', fn => {
    // No stop: can only be target_hit or manual
    const result = fn(12.00, null, 12.00, 'BUY');
    expect(['target_hit', 'manual']).toContain(result);
  });

  bothCopies('works when target is null (no target set)', fn => {
    const result = fn(9.00, 9.00, null, 'BUY');
    expect(['stop_hit', 'manual']).toContain(result);
  });
});

// ── Both copies must be byte-identical in logic ───────────────────────────────

describe('_detectExitReason — both copies agree on all test cases', () => {
  const cases = [
    [9.00,   9.00,  12.00, 'BUY'],
    [12.00,  9.00,  12.00, 'BUY'],
    [10.50,  9.00,  12.00, 'BUY'],
    [11.00, 11.00,   8.00, 'SELL'],
    [8.00,  11.00,   8.00, 'SELL'],
    [9.50,  11.00,   8.00, 'SELL'],
    [8.00,  11.00,   8.00, 'TRIM'],
    [9.00,   9.00,  12.00, 'TOP_UP'],
    [0,      9.00,  12.00, 'BUY'],
    [10.00, 11.00,   8.00, null],
  ];

  it('recs copy and perf copy return identical results for all cases', () => {
    for (const [exit, stop, target, action] of cases) {
      const r = _detectExitReason_recs(exit, stop, target, action);
      const p = _detectExitReason_perf(exit, stop, target, action);
      expect(r).toBe(p);
    }
  });
});
