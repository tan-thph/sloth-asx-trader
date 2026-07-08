// ============================================================
// claude-client.js — Centralised Claude API wrapper (2.1 + 2.4)
//
// callClaude(agentType, userMessage, options)
//   agentType  — 'portfolio' | 'macro' | 'dayTrade' | 'universe' | 'analyst' | 'pm' | 'assistant'
//   userMessage — string (ignored if options.messages provided)
//   options.messages    — full messages array for multi-turn (assistant page)
//   options.maxTokens   — override default token budget
//   options.noCache     — skip prompt caching headers (use for one-shot queries)
//   options.systemPrompt — direct system prompt string (overrides agent lookup)
//   options.systemArray  — raw system array [{type,text,cache_control?}] for dynamic prompts
// ============================================================

const CLAUDE_MODEL = 'claude-sonnet-4-6';

const _AGENT_MAX_TOKENS = {
  // Raised over time (8000 → 10000 Sprint 68 → 12000): the 2026-06-11 15:35 run
  // reported out=8000 — the cap exactly — with 7 recs. Tool-schema input counts
  // against max_tokens; a larger portfolio would truncate the tool input and fail
  // the whole parse. 12000 leaves headroom for HOLD entries (Audit #8) too.
  portfolio: 12000,
  analyst:   5000,
  pm:        3000,
  dayTrade:  4000,
  universe:  4000,
  // 1800 → 3000 (2026-06-24): the 08:57 run hit output_tokens=1800 exactly —
  // the cap — mid-string in keyDrivers, truncating the JSON unparseably.
  // The what_changed/drivers/sector_impact schema (added the same day macro
  // went from 1000→1800) reliably needs more than 1800 for a full 5-driver,
  // 3-paragraph response. Once-daily call — the extra token ceiling has
  // negligible cost impact even though most days won't need it.
  macro:     3000,
  assistant: 2000,
};

const _AGENT_NO_CACHE = {
  macro:     true,
  assistant: true,
};

// ── §8.5: structured tool output for the portfolio agent ─────────────────────
// Forcing tool_choice onto a JSON-schema'd tool makes the API constrain the
// output shape — eliminating the malformed-JSON parse-failure class that the
// "Return ONLY valid JSON" prompt instruction could never guarantee. The local
// Ollama path already had this (format_schema); this brings the cloud path level.
//
// MUST STAY STATIC (no state interpolation): tools are part of the cached
// prompt prefix — a changing schema would bust the prompt cache on every call.
// Schema enforces TYPES; business rules (R:R ≥ 2, forbidden tag combos, stop
// direction) remain the validator's job in analysis.js — both layers stay.
// `required` is deliberately minimal so a missing optional field degrades to a
// validator fix/drop instead of an API refusal.
const _PORTFOLIO_TOOL = {
  name: 'emit_recommendations',
  description: 'Emit the final portfolio analysis result. Call exactly once with the '
    + 'complete set of recommendations, summary, and data gaps.',
  input_schema: {
    type: 'object',
    required: ['recs', 'summary', 'dataGaps'],
    properties: {
      recs: {
        type: 'array',
        items: {
          type: 'object',
          // Audit #8 (2026-07-08): 'HOLD' re-admitted so existing holdings the
          // model evaluates and chooses to keep are logged (the passivity signal
          // — _resolve_hold_outcomes / ⚠HOLD_TOO_PASSIVE were structurally dead on
          // the Claude path because the enum forbade HOLD). `required` narrowed to
          // the fields EVERY action needs: a HOLD legitimately omits
          // priceRange/target/stopLoss/qty (validator's requiredUnless:'HOLD'),
          // and a BUY/SELL missing one degrades to a validator fix/drop rather
          // than an API refusal — the documented intent of this minimal schema.
          required: ['ticker', 'action', 'confidence', 'reasoning'],
          properties: {
            ticker:                { type: 'string', pattern: '^[A-Z0-9]{2,5}(\\.AX)?$' },
            action:                { type: 'string', enum: ['BUY', 'SELL', 'TRIM', 'TOP_UP', 'HOLD'] },
            sector:                { type: 'string' },
            isWatchlist:           { type: 'boolean' },
            priceRange:            { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
            target:                { type: 'number' },
            stopLoss:              { type: 'number' },
            qty:                   { type: 'number' },
            tranches:              { type: 'number' },
            orderType:             { type: 'string', enum: ['LIMIT', 'MARKET', 'VWAP'] },
            limitPrice:            { type: 'number' },
            confidence:            { type: 'number', minimum: 0, maximum: 1 },
            scenarios:             { type: 'object' },
            expectedTimeToTarget:  { type: 'number' },
            factorsUsed:           { type: 'array', items: { type: 'string' } },
            reasoning:             { type: 'string' },
            risks:                 { type: 'string' },
            catalysts:             { type: 'string' },
            signals:               { type: 'array', items: { type: 'string' } },
            invalidationCondition: { type: 'string' },
            bearCase:              { type: 'string' },
            bullCase:              { type: 'string' },
            weightGuidance:        { type: 'string' },
            expectedProfit:        { type: 'number' },
            netProfit:             { type: 'number' },
            taxBenefitEstimate:    { type: ['number', 'null'] },
            grossedUpYield:        { type: ['number', 'null'] },
            // Audit #10 (2026-07-08): primary_entry_driver is the keystone of the
            // BUY/TOP_UP learning taxonomy (thesis matrix, driver playbook,
            // driver×regime cross-tabs, computeThesisDrift all key off it). It was
            // absent from the schema, so constrained decoding under-emitted it —
            // the likely cause of the null-driver rows that needed the
            // /backfill-entry-drivers endpoint. reallocationSuggestion was likewise
            // undeclared. Static addition → one-time cache bust, then stable.
            primary_entry_driver:  { type: ['string', 'null'],
                                     enum: ['mean_reversion', 'momentum_breakout', 'trend_pullback',
                                            'fundamental_value', 'macro_tailwind', null] },
            reallocationSuggestion:{ type: ['string', 'null'] },
            primary_driver:        { type: 'string' },
            secondary_factors:     { type: 'array', items: { type: 'string' } },
            urgency:               { type: 'string', enum: ['immediate', 'routine', 'monitor'] },
            alternativeTicker:     { type: ['string', 'null'] },
          },
        },
      },
      summary:  { type: 'string' },
      dataGaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: { ticker: { type: 'string' }, missingField: { type: 'string' } },
        },
      },
    },
  },
};

// Returns the system prompt string for a given agent type.
// Prompt functions (getDayTradeSystemPrompt etc.) are called lazily
// so they can reference state at call time.
function _resolveSystemPrompt(agentType) {
  switch (agentType) {
    case 'portfolio': return typeof ANALYSIS_SYSTEM_PROMPT  !== 'undefined' ? ANALYSIS_SYSTEM_PROMPT  : '';
    case 'analyst':   return typeof ANALYST_SYSTEM_PROMPT   !== 'undefined' ? ANALYST_SYSTEM_PROMPT   : '';
    case 'pm':        return typeof PM_SYSTEM_PROMPT        !== 'undefined' ? PM_SYSTEM_PROMPT        : '';
    case 'macro':     return typeof MACRO_SYSTEM_PROMPT     !== 'undefined' ? MACRO_SYSTEM_PROMPT     : '';
    case 'dayTrade':  return typeof getDayTradeSystemPrompt  === 'function'  ? getDayTradeSystemPrompt()  : '';
    case 'universe':  return typeof getDayTradeUniverseScanPrompt === 'function' ? getDayTradeUniverseScanPrompt() : '';
    case 'assistant': return typeof ASSISTANT_SYSTEM_PROMPT !== 'undefined' ? ASSISTANT_SYSTEM_PROMPT : '';
    default:          return '';
  }
}

// ── Local LLM fast-path (opt-in: state.settings.useLocalLLM) ─────────────────
// Called instead of Claude API when agentType === 'portfolio' and useLocalLLM is on.
// POSTs the assembled user message to /api/debate/quick-analysis (Ollama backend).
// Returns the same { text, usage } shape as callClaude() so analysis.js is unaware.
async function _callLocalAnalysis(userMessage) {
  const prefModel = (typeof preferredDebateModel === 'function')
    ? preferredDebateModel()
    : (state.debate?.model || 'qwen3:9b');
  const resp = await fetch(`${API}/api/debate/quick-analysis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userMessage, model: prefModel }),
  });
  const d = await resp.json();
  if (!d.ok) throw new Error(d.error || 'Local LLM analysis failed');
  return { text: d.text, usage: { local: true, model: d.model, elapsed_ms: d.elapsed_ms } };
}

// §9.5: local SELL/TRIM on a LARGE position escalates to Claude. Small local
// models produce exit tags inconsistently — cheap insurance until their tag
// quality is proven. Returns {ticker, weight} of the largest offending exit,
// or null when the local result is fine to use.
const _LOCAL_ESCALATE_WEIGHT_PCT = 10;
function _localExitOnLargePosition(text) {
  try {
    const parsed = JSON.parse(text);
    const recs = Array.isArray(parsed) ? parsed : (parsed?.recs || []);
    const pv = typeof portfolioValue === 'function' ? portfolioValue() : 0;
    if (!pv) return null;
    let worst = null;
    for (const r of recs) {
      const action = (r.action || '').toUpperCase();
      if (action !== 'SELL' && action !== 'TRIM') continue;
      const h = (typeof mergedPortfolio === 'function' ? mergedPortfolio() : [])
        .find(x => x.ticker === r.ticker);
      if (!h) continue;
      const weight = (h.shares * h.currentPrice) / pv * 100;
      if (weight > _LOCAL_ESCALATE_WEIGHT_PCT && (!worst || weight > worst.weight)) {
        worst = { ticker: r.ticker, weight: +weight.toFixed(1) };
      }
    }
    return worst;
  } catch (_) { return null; }   // unparseable — let the normal pipeline handle it
}

async function callClaude(agentType, userMessage, options = {}) {
  // Local LLM fast-path: portfolio analysis only, opt-in via Settings.
  // SELL/TRIM tagging and calibration injection are Claude-only features;
  // the local path produces BUY/TOP_UP/HOLD recs through the same validator/quant stack.
  if (agentType === 'portfolio' && state.settings?.useLocalLLM) {
    console.log('[callClaude] routing portfolio → local Ollama (useLocalLLM=true)');
    const local = await _callLocalAnalysis(userMessage);
    const big = _localExitOnLargePosition(local.text);
    const canEscalate = (typeof getApiKey === 'function' && getApiKey())
      || state.settings?.useBackendProxy;
    if (!big) return local;
    if (!canEscalate) {
      // Local-only install (no Claude key): keep the local result but warn loudly
      if (typeof toast === 'function') {
        toast(`⚠ Local model proposes exit on ${big.ticker} (${big.weight}% of portfolio) — no Claude key to escalate; review carefully`, 'error');
      }
      return local;
    }
    // §9.5 escalation: discard the local result and fall through to Claude
    console.warn(`[callClaude] local SELL/TRIM touches ${big.ticker} (${big.weight}% of portfolio) — escalating to Claude`);
    if (typeof toast === 'function') {
      toast(`Local model proposed exit on ${big.ticker} (${big.weight}% of portfolio) — escalated to Claude for the full taxonomy`, 'info');
    }
  }

  // Two modes:
  //   • Direct (default): browser → api.anthropic.com using key from localStorage
  //   • Proxy (opt-in via state.settings.useBackendProxy): browser → /api/claude/proxy
  //     → api.anthropic.com using key stored in SQLite settings table
  const _callStart = Date.now();   // wall-clock start for duration_ms logging
  const useProxy = !!(state.settings && state.settings.useBackendProxy);
  const key = useProxy ? null : getApiKey();
  if (!useProxy && !key) throw new Error('No API key — add one in Settings (or enable backend proxy)');

  const maxTokens = options.maxTokens ?? _AGENT_MAX_TOKENS[agentType] ?? 12000;
  const noCache   = options.noCache   ?? _AGENT_NO_CACHE[agentType]   ?? false;

  // ── Build messages array ────────────────────────────────────────────────────
  const messages = options.messages ?? [{ role: 'user', content: userMessage }];

  // ── Build system field ──────────────────────────────────────────────────────
  let system;
  if (options.systemArray) {
    // Caller provides a fully assembled [{type,text,cache_control?}] array
    system = options.systemArray;
  } else {
    const promptText = options.systemPrompt ?? _resolveSystemPrompt(agentType);
    if (promptText) {
      system = noCache
        ? promptText
        : [{ type: 'text', text: promptText, cache_control: { type: 'ephemeral' } }];
    }
  }

  const model = (options.model && options.model.trim()) ? options.model.trim() : CLAUDE_MODEL;
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;

  // §8.5: portfolio agent gets grammar-level JSON enforcement via forced tool use.
  // options.noTool opts out (escape hatch for diagnostics). The proxy endpoint
  // forwards the body verbatim, so tools work identically in both modes.
  const useTool = agentType === 'portfolio' && !options.noTool;
  if (useTool) {
    body.tools = [_PORTFOLIO_TOOL];
    body.tool_choice = { type: 'tool', name: 'emit_recommendations' };
  }

  // ── Headers ─────────────────────────────────────────────────────────────────
  const headers = useProxy ? {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  } : {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (!noCache) headers['anthropic-beta'] = 'prompt-caching-2024-07-31';

  const endpoint = useProxy
    ? `${API}/api/claude/proxy`
    : 'https://api.anthropic.com/v1/messages';

  // ── Pre-send diagnostic ────────────────────────────────────────────────────
  const _sysLen = Array.isArray(system)
    ? system.reduce((sum, b) => sum + (b.text?.length || 0), 0)
    : (typeof system === 'string' ? system.length : 0);
  const _msgLen = messages.reduce((sum, m) =>
    sum + (typeof m.content === 'string' ? m.content.length
      : JSON.stringify(m.content).length), 0);
  console.log(
    `[callClaude] ▶ ${agentType} | sys=${(_sysLen / 1024).toFixed(1)}KB ` +
    `msg=${(_msgLen / 1024).toFixed(1)}KB | maxTokens=${maxTokens} | ` +
    `${useProxy ? 'proxy' : 'direct'} | ${new Date().toLocaleTimeString('en-AU')}`
  );

  // ── Exponential backoff: 4 attempts (0s, 1s, 2s, 4s) ──────────────────────
  const RETRY_DELAYS = [0, 1000, 2000, 4000];
  let lastErr;

  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));

    let resp;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      lastErr = networkErr;
      console.warn(`[callClaude:${agentType}] Network error (attempt ${attempt + 1}):`, networkErr.message);
      continue;
    }

    if (resp.status === 429 || resp.status === 529) {
      lastErr = new Error(`Claude overloaded (HTTP ${resp.status})`);
      console.warn(`[callClaude:${agentType}] ${resp.status} — retrying in ${RETRY_DELAYS[attempt + 1] ?? 0}ms`);
      continue;
    }

    // Audit #14 (2026-07-08): guard the body parse. A proxy-side 5xx (waitress or
    // an intermediary returning an HTML error page) makes resp.json() throw a
    // SyntaxError that would escape the retry loop entirely — the exact failure
    // class the backoff exists for. Treat a non-JSON body as a retryable error.
    let data;
    try {
      data = await resp.json();
    } catch (parseErr) {
      lastErr = new Error(`Claude API returned a non-JSON body (HTTP ${resp.status})`);
      console.warn(`[callClaude:${agentType}] non-JSON response (HTTP ${resp.status}) — retrying in ${RETRY_DELAYS[attempt + 1] ?? 0}ms`);
      continue;
    }

    if (data.error) {
      const errType = data.error.type || '';
      // Auth / validation errors won't self-heal — fail immediately
      if (errType === 'authentication_error' || errType === 'invalid_request_error') {
        throw new Error(`Claude API error: ${data.error.message}`);
      }
      lastErr = new Error(data.error.message);
      continue;
    }

    const usage = data.usage || {};
    // §8.5: with forced tool use the result arrives as a tool_use block —
    // serialise its input so downstream parseClaudeJSON() consumes it exactly
    // like text output (zero changes in analysis.js). Falls back to the first
    // text block for non-tool agents or truncated responses.
    const _toolBlock = Array.isArray(data.content)
      ? data.content.find(b => b && b.type === 'tool_use') : null;
    const responseText = _toolBlock
      ? JSON.stringify(_toolBlock.input)
      : (data.content?.[0]?.text ?? '');

    console.log(
      `[callClaude] ✓ ${agentType} | sent OK → response received | ` +
      `in=${usage.input_tokens ?? '?'} out=${usage.output_tokens ?? '?'} ` +
      `cache_hit=${usage.cache_read_input_tokens ?? 0} cache_written=${usage.cache_creation_input_tokens ?? 0} | ` +
      `${Date.now() - _callStart}ms | response: ${responseText.length} chars`
    );

    // ── Fire-and-forget: log full call (prompt + response) to backend ──────────
    // Skipped when options.noLog = true (e.g. API key test calls from Settings —
    // these should not appear in ai_call_log so they don't pollute real call history).
    if (options.noLog) return { text: responseText, usage };

    try {
      // Extract system prompt text from whatever form it was passed in
      let _sysText = '';
      if (options.systemArray && Array.isArray(options.systemArray)) {
        _sysText = options.systemArray.map(b => b.text || '').join('\n---\n');
      } else if (system) {
        _sysText = typeof system === 'string' ? system : (system[0]?.text || '');
      }
      // Reconstruct user message for multi-turn (assistant page)
      let _userText = userMessage || '';
      if (options.messages && Array.isArray(options.messages)) {
        _userText = options.messages
          .map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
          .join('\n');
      }
      fetch(`${API}/api/log/ai_response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text:          responseText,
          system_prompt: _sysText.slice(0, 50000),
          user_message:  _userText.slice(0, 50000),
          agent_type:    agentType,
          model:         model,   // the model actually sent (options.model override or default) — NOT hardcoded
          usage,
          duration_ms:   Date.now() - _callStart,
        }),
      }).then(r => {
        if (r.ok) console.log(`[callClaude] 💾 ${agentType} call saved to ai_call_log (sys=${(_sysText.length/1024).toFixed(1)}KB user=${(_userText.length/1024).toFixed(1)}KB resp=${(responseText.length/1024).toFixed(1)}KB)`);
      }).catch(() => {});  // never let logging break the caller
    } catch (_logErr) { /* swallow */ }

    return { text: responseText, usage };
  }

  throw lastErr ?? new Error(`callClaude(${agentType}) failed after ${RETRY_DELAYS.length} attempts`);
}
