/**
 * tests/setup.js — Vitest global setup for browser-global engine files.
 *
 * These JS files are plain <script> tags in the browser — they declare functions
 * and constants in the global scope and reference other globals (state, API, etc.)
 * without imports.  We replicate that environment here using vm.runInThisContext,
 * which evaluates each file in the current Node.js context so their declarations
 * become available as globals throughout the test suite.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Minimal browser-global stubs ─────────────────────────────────────────────

global.state = {
  dayTrading:     { aiParams: {} },
  analysisConfig: { rules: { minConfidence: 0.62 } },
  recHistory:     [],
  liveSignals:    {},
  serverOk:       false,
  rbaRate:        4.35,
  macroData:      null,
  currentRegime:  null,
};

global.API           = 'http://localhost:5000';
global.callClaude    = async () => ({ text: '{}' });
global.fireAlert     = () => {};
global.fetch         = async () => ({ ok: false });
global.console       = console;

// ── Script loader ─────────────────────────────────────────────────────────────

/**
 * Load a repo-relative JS file into the current (global) vm context.
 * Mirrors what the browser does when it encounters a <script src="..."> tag.
 */
export function loadScript(relPath) {
  const code = readFileSync(join(ROOT, relPath), 'utf8');
  vm.runInThisContext(code, { filename: relPath, displayErrors: true });
}

/**
 * Extract a named function's source text from a JS file using brace-counting.
 * Returns the function declaration as a string, ready for eval.
 */
export function extractFunction(relPath, fnName) {
  const src = readFileSync(join(ROOT, relPath), 'utf8');
  const marker = `function ${fnName}`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`${fnName} not found in ${relPath}`);
  let depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i++;
  }
  throw new Error(`${fnName}: unclosed brace in ${relPath}`);
}

// ── Load pure engine files (no DOM, no external deps beyond stubs above) ──────

// parseClaudeJSON is in utils.js; validator needs it as a global
loadScript('js/utils.js');
loadScript('js/quant-engine.js');
loadScript('js/regime-engine.js');
loadScript('js/response-validator.js');
