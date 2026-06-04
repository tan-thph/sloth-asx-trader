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
  portfolio: 8000,
  analyst:   3000,
  pm:        3000,
  dayTrade:  4000,
  universe:  4000,
  macro:     1000,
  assistant: 2000,
  briefing:  600,
};

const _AGENT_NO_CACHE = {
  macro:     true,
  assistant: true,
  briefing:  true,
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
    case 'briefing':  return typeof MORNING_BRIEFING_SYSTEM_PROMPT !== 'undefined' ? MORNING_BRIEFING_SYSTEM_PROMPT : '';
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

async function callClaude(agentType, userMessage, options = {}) {
  // Local LLM fast-path: portfolio analysis only, opt-in via Settings.
  // SELL/TRIM tagging and calibration injection are Claude-only features;
  // the local path produces BUY/TOP_UP/HOLD recs through the same validator/quant stack.
  if (agentType === 'portfolio' && state.settings?.useLocalLLM) {
    console.log('[callClaude] routing portfolio → local Ollama (useLocalLLM=true)');
    return _callLocalAnalysis(userMessage);
  }

  // Two modes:
  //   • Direct (default): browser → api.anthropic.com using key from localStorage
  //   • Proxy (opt-in via state.settings.useBackendProxy): browser → /api/claude/proxy
  //     → api.anthropic.com using key stored in SQLite settings table
  const _callStart = Date.now();   // wall-clock start for duration_ms logging
  const useProxy = !!(state.settings && state.settings.useBackendProxy);
  const key = useProxy ? null : getApiKey();
  if (!useProxy && !key) throw new Error('No API key — add one in Settings (or enable backend proxy)');

  const maxTokens = options.maxTokens ?? _AGENT_MAX_TOKENS[agentType] ?? 3000;
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

  const body = { model: CLAUDE_MODEL, max_tokens: maxTokens, messages };
  if (system) body.system = system;

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

    const data = await resp.json();

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
    const responseText = data.content?.[0]?.text ?? '';

    console.log(
      `[callClaude] ✓ ${agentType} | sent OK → response received | ` +
      `in=${usage.input_tokens ?? '?'} out=${usage.output_tokens ?? '?'} ` +
      `cache_hit=${usage.cache_read_input_tokens ?? 0} cache_written=${usage.cache_creation_input_tokens ?? 0} | ` +
      `${Date.now() - _callStart}ms | response: ${responseText.length} chars`
    );

    // ── Fire-and-forget: log full call (prompt + response) to backend ──────────
    // Runs after every successful callClaude — covers all agent types automatically.
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
          system_prompt: _sysText.slice(0, 20000),
          user_message:  _userText.slice(0, 30000),
          agent_type:    agentType,
          model:         CLAUDE_MODEL,
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
