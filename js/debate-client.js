// ============================================================
// debate-client.js — Internal Debate Engine (local Ollama)
//
// Calls asx_server.py /api/debate endpoints to generate a
// structured bull/bear debate for each candidate ticker before
// injecting it into Claude's user message.
//
// All functions degrade gracefully: if Ollama is not running,
// or the server isn't available, they return null and the
// caller continues without debate context.
// ============================================================

// ── Status cache (60 s TTL) ───────────────────────────────────────────────────
let _debateStatus    = null;
let _debateStatusTs  = 0;
const _DEBATE_STATUS_TTL = 60_000;

/** Force a fresh check on next debateStatus() call. */
function clearDebateStatusCache() {
  _debateStatus   = null;
  _debateStatusTs = 0;
}

/**
 * Check if the Ollama debate engine is available.
 * Result is cached for 60 s to avoid hammering the server.
 * @returns {Promise<{available:boolean, models:string[], url:string}>}
 */
async function debateStatus() {
  const now = Date.now();
  if (_debateStatus && (now - _debateStatusTs) < _DEBATE_STATUS_TTL) {
    return _debateStatus;
  }
  try {
    const r = await fetch(`${API}/api/debate/status`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      _debateStatus   = await r.json();
      _debateStatusTs = now;
      return _debateStatus;
    }
  } catch {}
  _debateStatus   = { available: false, models: [], url: 'http://localhost:11434' };
  _debateStatusTs = now;
  return _debateStatus;
}

// ── Debate result cache (4-hour TTL, keyed by ticker + signal snapshot) ───────
const _debateResultCache = new Map();   // key → { result, ts }
const _DEBATE_CACHE_TTL  = 4 * 3600_000; // 4 hours

/**
 * Build a compact hash string from the key signal values so we can cache
 * per-ticker-per-state.  We only include the fields the debate prompt uses,
 * rounded to 2 dp — avoids cache misses from sub-cent price drift.
 */
function _signalHash(signals = {}) {
  const pick = (v, dp = 2) => v == null ? 'x' : Number(v).toFixed(dp);
  return [
    pick(signals.current_price),
    pick(signals.rsi_14, 1),
    pick(signals.bb_pct_b),
    pick(signals.volume_z_score, 1),
    pick(signals.return_60d, 1),
    signals.obv_trend || 'x',
    pick(signals.adx_14, 1),
  ].join('|');
}

function _debateCacheKey(ticker, signals) {
  return `${ticker}::${_signalHash(signals)}`;
}

function _getCachedDebate(ticker, signals) {
  const key  = _debateCacheKey(ticker, signals);
  const hit  = _debateResultCache.get(key);
  if (hit && (Date.now() - hit.ts) < _DEBATE_CACHE_TTL) return hit.result;
  return null;
}

function _setCachedDebate(ticker, signals, result) {
  const key = _debateCacheKey(ticker, signals);
  _debateResultCache.set(key, { result, ts: Date.now() });
  // Prune old entries (keep map from growing indefinitely)
  if (_debateResultCache.size > 200) {
    const oldest = [..._debateResultCache.entries()]
      .sort((a, b) => a[1].ts - b[1].ts)
      .slice(0, 50);
    oldest.forEach(([k]) => _debateResultCache.delete(k));
  }
}

/**
 * Preferred debate model — respects user preference in state.debate.model,
 * then falls back to the priority list of known-good small models.
 * @param {string[]} pulledModels  List returned by debateStatus().models
 * @returns {string}
 */
function preferredDebateModel(pulledModels = []) {
  // Honour explicit user choice if it is actually available
  const userPref = (typeof state !== 'undefined') ? (state.debate?.model || '') : '';
  if (userPref && pulledModels.includes(userPref)) return userPref;

  const PRIORITY = [
    'qwen3:9b', 'qwen3:8b', 'qwen3:4b', 'qwen3:0.6b',
    'gemma3:4b', 'gemma3:2b', 'llama3.2:3b', 'phi4-mini',
  ];
  for (const p of PRIORITY) {
    const match = pulledModels.find(m => m.startsWith(p.split(':')[0]));
    if (match) return match;
  }
  return pulledModels[0] || 'qwen3:9b';
}

/**
 * Aggression settings → { maxTickers, concurrency }
 * 'none'  — skip debate entirely
 * 'light' — up to 3 tickers, concurrency 2
 * 'full'  — up to 8 tickers, concurrency 3
 */
function _aggressionParams() {
  const ag = (typeof state !== 'undefined') ? (state.debate?.aggression || 'light') : 'light';
  if (ag === 'none')  return { maxTickers: 0, concurrency: 1 };
  if (ag === 'full')  return { maxTickers: 8, concurrency: 3 };
  return { maxTickers: 3, concurrency: 2 }; // 'light'
}

/**
 * Run a bull/bear debate for one ticker, with 4-hour cache.
 *
 * @param {string} ticker   e.g. 'BHP.AX'
 * @param {object} signals  From state.liveSignals[ticker]
 * @param {object} [opts]
 * @param {string}  [opts.model]      Override model name
 * @param {number}  [opts.timeout]    Per-side timeout seconds (default 45)
 * @param {boolean} [opts.skipCache]  Bypass 4h cache (e.g. for test button)
 * @returns {Promise<{ok:boolean, bull?:string, bear?:string, model?:string,
 *                    elapsed_ms?:number, _fromCache?:boolean}|null>}
 */
async function fetchDebate(ticker, signals, opts = {}) {
  if (!state.serverOk) return null;

  // Cache check (skip if opts.skipCache=true)
  if (!opts.skipCache) {
    const cached = _getCachedDebate(ticker, signals);
    if (cached) return { ...cached, _fromCache: true };
  }

  const status = await debateStatus();
  if (!status.available) return null;

  const model = opts.model || preferredDebateModel(status.models);

  try {
    const r = await fetch(`${API}/api/debate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ticker, signals, model, timeout: opts.timeout || 45 }),
      signal:  AbortSignal.timeout(100_000), // 100 s hard cap
    });
    if (r.ok) {
      const result = await r.json();
      if (result.ok) {
        _setCachedDebate(ticker, signals, result);
        return { ...result, _fromCache: false };
      }
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run bull/bear debates for multiple tickers with aggression control and cache.
 *
 * @param {string[]} tickers     Full ticker list (will be sliced by aggression)
 * @param {number}   [concurrency]  Overrides aggression default if provided
 * @param {object}   [opts]      Passed through to fetchDebate
 * @returns {Promise<Record<string, {ok:boolean, bull?:string, bear?:string}>>}
 */
async function fetchDebateBatch(tickers, concurrency, opts = {}) {
  const { maxTickers, concurrency: defConcurrency } = _aggressionParams();
  if (maxTickers === 0) return {};

  const status = await debateStatus();
  if (!status.available || !tickers.length) return {};

  const model     = opts.model || preferredDebateModel(status.models);
  const cap       = maxTickers;
  const workers   = concurrency ?? defConcurrency;
  const limited   = tickers.slice(0, cap);
  const results   = {};

  for (let i = 0; i < limited.length; i += workers) {
    const chunk = limited.slice(i, i + workers);
    const settled = await Promise.allSettled(
      chunk.map(t => fetchDebate(t, state.liveSignals[t] || {}, { ...opts, model }))
    );
    chunk.forEach((t, idx) => {
      const s = settled[idx];
      if (s.status === 'fulfilled' && s.value?.ok) results[t] = s.value;
    });
  }
  return results;
}

/**
 * Format a debate result as a compact text block for Claude's user message.
 */
function formatDebateBlock(ticker, debate) {
  if (!debate?.bull || !debate?.bear) return '';
  const modelTag = debate.model ? ` [${debate.model}]` : '';
  return (
    `\n--- Local Debate${modelTag}: ${ticker} ---\n` +
    `BULL: ${debate.bull}\n` +
    `BEAR: ${debate.bear}\n` +
    `--- End Debate ---\n`
  );
}

/**
 * Build a combined debate preamble for multiple tickers (prepended to Claude's user message).
 * @param {Record<string, object>} debates  Map of ticker → debate result
 * @returns {string}  Empty string if no debates
 */
function buildDebatePreamble(debates) {
  return Object.entries(debates)
    .filter(([, d]) => d?.ok && d.bull && d.bear)
    .map(([t, d]) => formatDebateBlock(t, d))
    .join('');
}

/**
 * Build a condensed debate_summary string for DB storage (≤ 200 chars).
 * Stored in ai_learning_events.debate_summary for later review.
 */
function buildDebateSummary(debate) {
  if (!debate?.bull || !debate?.bear) return null;
  const bullSnip = debate.bull.slice(0, 80).replace(/\s+$/, '');
  const bearSnip = debate.bear.slice(0, 80).replace(/\s+$/, '');
  return `B:${bullSnip} / R:${bearSnip}`;
}

/**
 * Trigger a post-mortem auto-tag for a closed learning event (fire-and-forget).
 * @param {number} eventId
 * @param {string} [model]
 */
async function triggerPostmortem(eventId, model) {
  if (!state.serverOk) return;
  const status = await debateStatus();
  if (!status.available) return;
  const useModel = model || preferredDebateModel(status.models);
  try {
    await fetch(`${API}/api/debate/postmortem`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: eventId, model: useModel }),
    });
  } catch {}
}
