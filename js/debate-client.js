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
    pick(signals.return_5d, 1),   // D4: added to hash so cache invalidates when momentum shifts
    pick(signals.return_20d, 1),
    pick(signals.return_60d, 1),
    signals.obv_trend || 'x',
    pick(signals.adx_14, 1),
    pick(signals.atr_pct, 1),
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
    'qwen3.5:9b', 'qwen3.5:4b',                      // qwen3.5 family (explicit)
    'qwen3:9b', 'qwen3:8b', 'qwen3:4b', 'qwen3:0.6b',
    'gemma4',                                         // gemma4:e4b etc.
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
  // concurrency=1 keeps tickers sequential — Ollama already queues internally
  // and concurrent external requests double peak memory, causing crashes.
  if (ag === 'full')  return { maxTickers: 8, concurrency: 1 };
  return { maxTickers: 3, concurrency: 1 }; // 'light'
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
      body:    JSON.stringify({
        ticker, signals, model, timeout: opts.timeout || 45,
        action: opts.action || 'BUY',  // D7: pass direction for exit-biased prompts
      }),
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
      chunk.map(t => fetchDebate(t, state.liveSignals[t] || {}, {
        ...opts, model,
        action: opts.actions?.[t] || 'BUY',  // D7: per-ticker direction
      }))
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
  let synthLine = '';
  if (debate.synthesis?.winner) {
    const { winner, margin, key_pivot } = debate.synthesis;
    synthLine = `SYNTHESIS: ${winner.toUpperCase()} wins (${margin}) — ${key_pivot}\n`;
  }
  return (
    `\n--- Local Debate${modelTag}: ${ticker} ---\n` +
    `BULL: ${debate.bull}\n` +
    `BEAR: ${debate.bear}\n` +
    synthLine +
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
  const bullSnip = debate.bull.slice(0, 70).replace(/\s+$/, '');
  const bearSnip = debate.bear.slice(0, 70).replace(/\s+$/, '');
  // L5: include synthesis winner so the stored record is more useful for review
  const synth = debate.synthesis?.winner
    ? `[${debate.synthesis.winner.toUpperCase()}:${debate.synthesis.margin || '?'}]`
    : '';
  return synth ? `${synth} B:${bullSnip} / R:${bearSnip}` : `B:${bullSnip} / R:${bearSnip}`;
}

/**
 * Check if a pending recommendation is still valid given current signals.
 * Returns null if Ollama is offline, rec is < 2 days old, or request fails.
 *
 * @param {string} ticker
 * @param {object} signals     From state.liveSignals[ticker]
 * @param {string} action      BUY / SELL / TOP_UP / TRIM
 * @param {number} confidence  0–1 float
 * @param {number} daysAgo     Integer — days since rec was generated
 * @param {object} [opts]      { model, timeout }
 * @returns {Promise<{ok:boolean, verdict:'VALID'|'WEAKENED'|'INVALIDATED',
 *                    reason:string, model:string}|null>}
 */
async function fetchStaleness(ticker, signals, action, confidence, daysAgo, opts = {}) {
  if (!state.serverOk) return null;
  if (daysAgo < 2) return null;          // fresh recs don't need a check

  const status = await debateStatus();
  if (!status.available) return null;

  const model = opts.model || preferredDebateModel(status.models);
  try {
    const r = await fetch(`${API}/api/debate/staleness`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        ticker, signals, action, confidence,
        days_ago: daysAgo,
        model,
        timeout: opts.timeout || 40,
      }),
      signal: AbortSignal.timeout(70_000),
    });
    if (r.ok) return await r.json();
    return null;
  } catch {
    return null;
  }
}

/**
 * Score a closed trade's outcome quality (skill vs luck) and persist to DB.
 *
 * @param {number} eventId   ai_learning_events.id
 * @param {object} [opts]    { model, timeout }
 * @returns {Promise<{ok:boolean, skill_score:number, reason:string, model:string}|null>}
 */
async function fetchSkillScore(eventId, opts = {}) {
  if (!state.serverOk) return null;

  const status = await debateStatus();
  if (!status.available) return null;

  const model = opts.model || preferredDebateModel(status.models);
  try {
    const r = await fetch(`${API}/api/debate/skill`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: eventId, model, timeout: opts.timeout || 45 }),
      signal:  AbortSignal.timeout(80_000),
    });
    if (r.ok) return await r.json();
    return null;
  } catch {
    return null;
  }
}

/**
 * Run an adversarial two-model postmortem debate on a closed learning event.
 *
 * Phase 1 — both models classify independently.
 * Phase 2 — agreement check (CONSENSUS / PARTIAL / DIVERGED).
 * Phase 3 — on full divergence, Model A is shown Model B's position
 *            and asked to maintain or concede.
 *
 * @param {number} eventId   ai_learning_events.id
 * @param {string} modelA    Primary model (challenger in Phase 3)
 * @param {string} modelB    Opposition model
 * @param {object} [opts]    { timeout }
 * @returns {Promise<{ok:boolean, error_type:string, error_type_source:string,
 *                    verdict:string, reason:string, debate:object,
 *                    model_a:string, model_b:string, elapsed_ms:number}|null>}
 */
async function fetchPostmortemDebate(eventId, modelA, modelB, opts = {}) {
  if (!state.serverOk) return null;
  try {
    const r = await fetch(`${API}/api/debate/postmortem-debate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        id:      eventId,
        model_a: modelA,
        model_b: modelB,
        timeout: opts.timeout || 60,
      }),
      // 3× max server timeout: Phase 1 (A) + Phase 1 (B) + Phase 3 + margin
      signal: AbortSignal.timeout(400_000),
    });
    if (r.ok) return await r.json();
    return null;
  } catch {
    return null;
  }
}

// ── Cloud adjudicator (Gemini / Groq) ────────────────────────────────────────
// User-initiated 🧑‍⚖️ feature — sends a stored adversarial debate transcript
// to a cloud model that scores each local model 0-10 and picks a winner.

let _adjStatus    = null;
let _adjStatusTs  = 0;
const _ADJ_TTL    = 60_000;

/** Check if a cloud adjudicator (Gemini or Groq API key) is configured. 60s cache. */
async function adjudicatorStatus() {
  const now = Date.now();
  if (_adjStatus && (now - _adjStatusTs) < _ADJ_TTL) return _adjStatus;
  try {
    const r = await fetch(`${API}/api/debate/adjudicator-status`, {
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) {
      _adjStatus   = await r.json();
      _adjStatusTs = now;
      return _adjStatus;
    }
  } catch {}
  _adjStatus   = { available: false, provider: null, model: '' };
  _adjStatusTs = now;
  return _adjStatus;
}

function clearAdjudicatorStatusCache() {
  _adjStatus   = null;
  _adjStatusTs = 0;
}

/**
 * Send a stored debate to the cloud adjudicator.
 * @param {number} eventId
 * @param {string|null} provider  — 'gemini'|'groq'|'claude'|null (null = auto-detect)
 * @returns {Promise<{ok, provider, model, winner, score_a, score_b,
 *                    final_tags, reason, error_type, error_type_source,
 *                    elapsed_ms}|null>}
 */
async function fetchAdjudication(eventId, provider = null) {
  if (!state.serverOk) return null;
  try {
    const body = { id: eventId };
    if (provider) body.provider = provider;
    const r = await fetch(`${API}/api/debate/adjudicate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(60_000),
    });
    if (r.ok) return await r.json();
    try { return await r.json(); } catch { return null; }
  } catch {
    return null;
  }
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
