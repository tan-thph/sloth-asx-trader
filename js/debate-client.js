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

// ── Cached status so we don't ping on every analysis ─────────────────────────
let _debateStatus = null;          // { available, models, url } or null
let _debateStatusTs = 0;           // epoch ms of last check
const _DEBATE_STATUS_TTL = 60_000; // re-check after 60 s

/** Force a fresh check on next debateStatus() call. */
function clearDebateStatusCache() {
  _debateStatus = null;
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
      _debateStatus = await r.json();
      _debateStatusTs = now;
      return _debateStatus;
    }
  } catch {}
  _debateStatus = { available: false, models: [], url: 'http://localhost:11434' };
  _debateStatusTs = now;
  return _debateStatus;
}

/**
 * Preferred debate model — picks the first pulled model from a priority list.
 * Falls back to 'qwen3:9b' as the default name (Ollama will error if not pulled).
 * @param {string[]} pulledModels  List returned by debateStatus().models
 * @returns {string}
 */
function preferredDebateModel(pulledModels = []) {
  const PRIORITY = [
    'qwen3:9b', 'qwen3:8b', 'qwen3:4b', 'qwen3:0.6b',
    'gemma3:4b', 'gemma3:2b', 'llama3.2:3b', 'phi4-mini',
  ];
  for (const p of PRIORITY) {
    if (pulledModels.some(m => m.startsWith(p.split(':')[0]))) return p;
  }
  // Return whatever is pulled, or the default
  return pulledModels[0] || 'qwen3:9b';
}

/**
 * Run a bull/bear debate for one ticker.
 *
 * @param {string} ticker   e.g. 'BHP.AX'
 * @param {object} signals  From state.liveSignals[ticker]
 * @param {object} [opts]
 * @param {string} [opts.model]    Override model name
 * @param {number} [opts.timeout]  Per-side timeout seconds (default 45)
 * @returns {Promise<{ok:boolean, bull?:string, bear?:string, model?:string, elapsed_ms?:number, error?:string}|null>}
 *   null if server not reachable or debate disabled
 */
async function fetchDebate(ticker, signals, opts = {}) {
  if (!state.serverOk) return null;

  const status = await debateStatus();
  if (!status.available) return null;

  const model = opts.model || preferredDebateModel(status.models);

  try {
    const r = await fetch(`${API}/api/debate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, signals, model, timeout: opts.timeout || 45 }),
      signal: AbortSignal.timeout(100_000), // 100 s hard cap (2× model timeout)
    });
    if (r.ok) return await r.json();
    return null;
  } catch {
    return null;
  }
}

/**
 * Run bull/bear debates for multiple tickers concurrently (max N parallel).
 *
 * @param {string[]} tickers  List of ticker strings
 * @param {number}   [concurrency=3]  Max simultaneous Ollama calls
 * @param {object}   [opts]  Passed through to fetchDebate
 * @returns {Promise<Record<string, {ok:boolean, bull?:string, bear?:string}>>}
 *   Map of ticker → debate result (missing = skipped / failed)
 */
async function fetchDebateBatch(tickers, concurrency = 3, opts = {}) {
  const results = {};
  // Check status once up-front
  const status = await debateStatus();
  if (!status.available || !tickers.length) return results;

  const model = opts.model || preferredDebateModel(status.models);

  // Run in chunks of `concurrency`
  for (let i = 0; i < tickers.length; i += concurrency) {
    const chunk = tickers.slice(i, i + concurrency);
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
 * Format a debate result as a compact text block suitable for injection
 * into the Claude user message.
 *
 * @param {string} ticker
 * @param {{bull:string, bear:string, model:string}} debate
 * @returns {string}
 */
function formatDebateBlock(ticker, debate) {
  if (!debate?.bull || !debate?.bear) return '';
  const model = debate.model ? ` [${debate.model}]` : '';
  return (
    `\n--- Local Debate${model}: ${ticker} ---\n` +
    `BULL: ${debate.bull}\n` +
    `BEAR: ${debate.bear}\n` +
    `--- End Debate ---\n`
  );
}

/**
 * Build a combined debate preamble for multiple tickers.
 * This is the string that gets prepended to Claude's user message.
 *
 * @param {Record<string, object>} debates  Map of ticker → debate result
 * @returns {string}  Empty string if no debates available
 */
function buildDebatePreamble(debates) {
  const blocks = Object.entries(debates)
    .filter(([, d]) => d?.ok && d.bull && d.bear)
    .map(([t, d]) => formatDebateBlock(t, d))
    .join('');
  return blocks;
}

/**
 * Trigger a post-mortem auto-tag for a closed learning event.
 * Fires-and-forgets — caller doesn't need to await.
 *
 * @param {number} eventId  ai_learning_events.id
 * @param {string} [model]  Override model; defaults to preferred
 */
async function triggerPostmortem(eventId, model) {
  if (!state.serverOk) return;
  const status = await debateStatus();
  if (!status.available) return;

  const useModel = model || preferredDebateModel(status.models);
  try {
    await fetch(`${API}/api/debate/postmortem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: eventId, model: useModel }),
    });
    // Result is ignored — this is a background enhancement
  } catch {}
}
