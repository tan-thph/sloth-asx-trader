# Sloth ASX Trader — Improvements

Consolidated improvement plan covering bug fixes, prompt and API architecture, and higher-order system design.

The document is organised in three tiers:

- **Tier 1 — Bug Fixes:** specific issues in existing code
- **Tier 2 — Prompt & API Architecture:** how the app talks to Claude
- **Tier 3 — System Architecture:** the larger structural shifts that move this from an AI-assisted trading app toward a quant system with AI components

Each item is independent. Pick by pain point, not order.

---

# Tier 1 — Bug Fixes

Specific issues identified in `js/strategy.js` and `js/prompts.js`.

## 1.1 `strategy.js` — ADX Filter Logic Gap

**Severity:** Medium — causes false positives in the pre-filter

The regime filter requires all three conditions simultaneously:

```js
// Current — too permissive
if ((s.adx ?? 0) > DT_FILTER.maxAdx && s.trend_strength === 'strong' && (s.return_5d ?? 0) > 0) return false;
```

A stock with ADX of 40 and a flat or negative `return_5d` slips through even though it's in a strong trend.

**Fix:** Remove the `return_5d > 0` guard. ADX alone is sufficient:

```js
if ((s.adx ?? 0) > DT_FILTER.maxAdx && s.trend_strength === 'strong') return false;
```

Or, to preserve the intent of only filtering uptrends (allowing strong downtrend reversals through):

```js
if ((s.adx ?? 0) > DT_FILTER.maxAdx && s.trend_strength === 'strong' && s.di_plus > s.di_minus) return false;
```

---

## 1.2 `strategy.js` — SMA200 Fallback to SMA50 is Silently Asymmetric

**Severity:** Low — unintended leniency for newer/smaller stocks

```js
const ref = s.sma_200 ?? s.sma_50;
if (ref && s.current_price < ref * DT_FILTER.sma200Floor) return false;
```

When `sma_200` is unavailable, the code falls back to `sma_50`. SMA50 is much closer to current price, so `sma_50 × 0.985` is a far weaker floor.

**Fix:** Make the intent explicit, or reject stocks without SMA200 entirely:

```js
// Option A — document the leniency
// SMA50 fallback is intentionally lenient — newer listings won't have
// 200-day history but are still valid candidates.
const ref = s.sma_200 ?? s.sma_50;
if (ref && s.current_price < ref * DT_FILTER.sma200Floor) return false;

// Option B — hard requirement
if (!s.sma_200) return false;
if (s.current_price < s.sma_200 * DT_FILTER.sma200Floor) return false;
```

---

## 1.3 `strategy.js` — Misleading Config Object

**Severity:** Low — developer confusion risk

`DT_FILTER` mixes pre-filter thresholds with AI-phase parameters:

```js
const DT_FILTER = {
  maxBbPctB: 0.20,
  minAdvAud: 1_500_000,
  sma200Floor: 0.985,
  maxAdx: 35,
  minRrRatio: 2.0,        // ← not used by pre-filter
  minConfidence: 0.50,    // ← not used by pre-filter
  stopAtrMultiple: 2.5,   // ← not used by pre-filter
};
```

**Fix:** Split into two clearly named objects:

```js
const DT_FILTER = {
  maxBbPctB:   0.20,
  minAdvAud:   1_500_000,
  sma200Floor: 0.985,
  maxAdx:      35,
};

const DT_AI_PARAMS = {
  minRrRatio:      2.0,
  minConfidence:   0.50,
  stopAtrMultiple: 2.5,
};
```

---

## 1.4 `prompts.js` — Tax-Loss Harvest Window Rule Requires Date Injection

**Severity:** Medium — rule silently never fires if date not injected

`ANALYSIS_SYSTEM_PROMPT` contains `TAX-LOSS HARVESTING (May 1 – Jun 30 only)` but the AI has no access to the current date unless it's in the user message.

**Fix:** Inject the date and computed window flag in every user message:

```js
const now = new Date();
const month = now.getMonth() + 1;
const inHarvestWindow = month >= 5 && month <= 6;

// In user message header
`TODAY: ${now.toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' })}
TAX_LOSS_HARVEST_ACTIVE: ${inHarvestWindow}`
```

This pattern is generalised in Tier 2 (`buildUserMessageHeader()`).

---

## 1.5 `prompts.js` — Liquidity Check Comment Has Units Mismatch

**Severity:** Low — can cause the AI to compute the check incorrectly

Section 5 says:

```
qty × currentPrice must be ≤ 5% of the ticker's 20-day average daily dollar turnover
(volume_avg_20 × currentPrice)
```

The arithmetic simplifies correctly (the `currentPrice` cancels), but the parenthetical describes `volume_avg_20` as dollar turnover when it's actually share count from yfinance.

**Fix:** Rewrite the prompt text to be explicit:

```
LIQUIDITY: qty must be ≤ 5% of volume_avg_20 (20-day average daily share volume).
Equivalent dollar check: qty × entryPrice ≤ 5% of (volume_avg_20 × currentPrice).
If exceeded, reduce qty or split into tranches.
```

---

## 1.6 `prompts.js` — `confidence` Defined Inconsistently

**Severity:** Low — scores not comparable across day-trade prompts

`getDayTradeSystemPrompt()` says `confidence = signals_hit / 5`. `getDayTradeUniverseScanPrompt()` just says `number`.

**Fix:** Align the universe scan prompt's output format definition:

```js
"confidence": number (signals_hit / 5 — minimum 0.60 to output a rec)
```

---

# Tier 2 — Prompt & API Architecture

How the app structures, dispatches, and validates Claude API calls.

## 2.1 Centralised `callClaude()` Wrapper with Agent Routing

**Why:** API calls are likely duplicated across `analysis.js`, `day-trading-analysis.js`, and `assistant.js`. A single wrapper gives one point of control for model, beta headers, caching, retries, and error handling.

```js
// js/claude-client.js

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

const AGENT_PROMPTS = {
  portfolio: () => ANALYSIS_SYSTEM_PROMPT,
  macro:     () => MACRO_SYSTEM_PROMPT,
  dayTrade:  () => getDayTradeSystemPrompt(),
  universe:  () => getDayTradeUniverseScanPrompt(),
  analyst:   () => ANALYST_SYSTEM_PROMPT,  // see 3.1
  pm:        () => PM_SYSTEM_PROMPT,       // see 3.1
};

async function callClaude(agentType, userMessage, options = {}) {
  const systemPrompt = AGENT_PROMPTS[agentType]?.();
  if (!systemPrompt) throw new Error(`Unknown agent type: ${agentType}`);

  const apiKey = state.settings.claudeApiKey;
  if (!apiKey) throw new Error('No Claude API key configured');

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: options.maxTokens ?? 4096,
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
    ],
    messages: [{ role: 'user', content: userMessage }],
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Claude API ${response.status}: ${err?.error?.message ?? 'unknown'}`);
  }

  const data = await response.json();
  const text = data.content?.find(b => b.type === 'text')?.text ?? '';

  if (data.usage) {
    const { cache_creation_input_tokens: c, cache_read_input_tokens: r } = data.usage;
    if (c || r) console.debug(`[${agentType}] cache: created=${c ?? 0} read=${r ?? 0}`);
  }

  return { text, usage: data.usage };
}
```

Every call site becomes:

```js
const { text } = await callClaude('portfolio', userMessage);
```

---

## 2.2 Shared Signal Block — Deduplicate Day Trade Prompts

**Why:** `getDayTradeSystemPrompt()` and `getDayTradeUniverseScanPrompt()` repeat the entry signal definitions, position sizing rules, and output schema verbatim. They've already drifted (confidence definition), and any tweak to Fibonacci logic or R:R threshold requires editing two places.

**Fix:** Extract a shared block:

```js
// js/prompts.js

const _DT_SIGNALS_BLOCK = `
═══ ENTRY SIGNALS ═══
Signal #1 [PRIMARY — MANDATORY]: bb_pct_b <= 0.05.
Signal #2 [Confirmation]: rsi_14 < 40 AND return_5d > return_20d.
Signal #3 [Confirmation]: volume_z_score > 1.50.
Signal #4 [Confirmation]: return_60d between -20% and -5%.
Signal #5 [Bonus]: obv_trend = "rising" while return_5d < 0.

Minimum: Signal #1 + at least 2 of Signals #2–#5.

═══ POSITION SIZING ═══
Stop = entry − 2.5 × atr_14.
qty = floor(riskPerTrade / (2.5 × atr_14)).
Max position = 20% of allocatedCash.
R:R = (target − entry) / (entry − stop). Reject if R:R < 2.0.
Target = min(bb_upper, support_resistance.r1).
`;

const _DT_OUTPUT_SCHEMA = `
Each rec:
{
  "ticker": string, "action": "BUY", "priceRange": [lo, hi],
  "target": number, "stopLoss": number, "qty": number,
  "confidence": number (signals_hit / 5 — minimum 0.60 to output),
  "holdDays": integer (5–15),
  "signalsHit": string[],
  "filtersPass": { "liquidityOk": boolean, "aboveSMA200": boolean, "adxOk": boolean, "noCatalyst": boolean },
  "reasoning": string (MAX 100 chars),
  "stopReason": string (MAX 80 chars),
  "riskAUD": number, "rewardAUD": number, "rrRatio": number
}
summary: MAX 150 chars. If none qualify: {"recs":[],"summary":"No valid setups."}
`;

function getDayTradeSystemPrompt() {
  return `You are a disciplined ASX swing-trader. Time horizon: 5–15 trading days.
Brokerage: $${state.settings.brokerage}/trade.

${_DT_SIGNALS_BLOCK}

═══ HARD FILTERS — ALL must pass ═══
F1 LIQUIDITY: adv_20 > 1,500,000 AUD.
F2 TREND: current_price >= sma_200 × 0.985.
F3 REGIME: adx < 30 OR trend_strength = "weak".
F4 CATALYST: no earnings within 5 trading days.

Return ONLY valid JSON.
${_DT_OUTPUT_SCHEMA}`;
}

function getDayTradeUniverseScanPrompt() {
  return `You are a disciplined ASX swing-trader scanning a pre-filtered universe.
These tickers already passed the client-side pre-filter (BB + ADV + SMA200 + ADX).
Confirm the full signal stack and output only high-conviction setups.
Brokerage: $${state.settings.brokerage}/trade.

${_DT_SIGNALS_BLOCK}

Return ONLY valid JSON.
${_DT_OUTPUT_SCHEMA}`;
}
```

---

## 2.3 Structured User Message Header

**Why:** Rules in the system prompt that depend on the current date (tax-loss window, CGT discount, reporting season) can't fire correctly without that data in the user message. Calibration adjustments and rec history need structured injection to be reliably parsed.

```js
// js/analysis.js

function buildUserMessageHeader(portfolioState) {
  const now = new Date();
  const month = now.getMonth() + 1;

  return `
=== CONTEXT ===
TODAY: ${now.toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' })}
TAX_LOSS_HARVEST_WINDOW: ${month >= 5 && month <= 6}
REPORTING_SEASON: ${[2, 8].includes(month)}
RBA_CASH_RATE: ${state.macroData?.rbaRate ?? 'unknown'}%
ACTIVE_REGIME: ${state.activeRegime ?? 'unknown'}
AVAILABLE_CASH: $${portfolioState.cash?.toFixed(2)}
PORTFOLIO_VALUE: $${portfolioState.totalValue?.toFixed(2)}
BROKERAGE: $${state.settings.brokerage}

=== CALIBRATION ===
${buildCalibrationBlock(portfolioState.hitRateByConfidence)}

=== RECENT RECOMMENDATION HISTORY ===
${buildRecHistoryBlock(portfolioState.recentRecs)}

=== PORTFOLIO RISK METRICS ===
${buildRiskBlock(portfolioState.riskMetrics)}
`.trim();
}
```

This guarantees every rule has the data it needs without ad-hoc injection scattered across the codebase.

---

## 2.4 Exponential Backoff Retry

**Why:** A single 429 (rate limit) or 529 (overloaded) silently fails an analysis run. The Python `announcement_engine.py` already does this for Gemini — match the behaviour for Claude.

```js
async function callClaude(agentType, userMessage, options = {}) {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', { /* ... */ });

      if (response.status === 429 || response.status === 529) {
        if (attempt === MAX_RETRIES) throw new Error(`Rate limited after ${MAX_RETRIES} retries`);
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[${agentType}] ${response.status} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`Claude API ${response.status}: ${err?.error?.message ?? 'unknown'}`);
      }
      return await response.json();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
    }
  }
}
```

---

## 2.5 Safe JSON Parser

**Why:** A direct `JSON.parse()` on AI output will throw on a stray markdown fence or trailing comma and break the UI.

```js
// js/utils.js

function parseClaudeJSON(rawText) {
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return { ok: true, data: JSON.parse(cleaned) };
  } catch (err) {
    console.error('Failed to parse Claude response:', err.message);
    console.error('Raw output (first 500 chars):', rawText.slice(0, 500));
    return { ok: false, error: err.message, raw: rawText };
  }
}
```

Usage:

```js
const { text } = await callClaude('portfolio', userMessage);
const { ok, data, error } = parseClaudeJSON(text);
if (!ok) {
  showToast(`Analysis failed: ${error}`, 'error');
  return;
}
```

---

# Tier 3 — System Architecture

The structural changes that move the system from "AI-assisted trading app" to "quant system with AI components". This is the most impactful section.

## 3.1 Deterministic Quant Engine Layer

**Why:** Even with an analyst → PM split, the LLM is doing arithmetic it shouldn't — position sizing, stop calculation, target derivation, EV math, Kelly fractions. LLMs are non-deterministic at arithmetic. The same input produces slightly different stops and qty values across runs. For a quant system, sizing and stops *must* be reproducible, auditable, and identical every time.

**The architectural shift:**

```
Signals → Analyst Agent → Quant Engine → PM Agent → Validator → Execution
            (LLM)         (pure code)    (LLM)      (code)
```

Responsibilities split:

| Layer | Computes | Decides |
|-------|----------|---------|
| **Analyst** (LLM) | Per-ticker conviction, factors, win probability estimate | Nothing — assessment only |
| **Quant Engine** (deterministic) | Stop, target, qty, EV, Kelly, R:R, liquidity-adjusted size, vol-normalised size | Nothing — pure math |
| **PM** (LLM) | Nothing numeric | Approve / reject / rank / explain |
| **Validator** (code) | Schema and business-rule checks | Pass / fail / repair |

### Quant Engine Implementation

```js
// js/quant-engine.js — zero LLM dependency

const QUANT_CONFIG = {
  stopAtrMultiple:  2.5,
  maxPositionPct:   0.20,   // 20% of allocated cash
  maxLiquidityPct:  0.05,   // 5% of ADV
  kellyFraction:    0.25,   // fractional Kelly (1/4)
  minRrRatio:       2.0,
  accountRiskPct:   0.01,   // 1% per trade
};

function computeTradeParams(ticker, signals, portfolio, analystOutput) {
  const { current_price, atr_14, bb_upper, support_resistance, adv_20 } = signals;
  const { winProb, expectedTimeToTarget } = analystOutput;

  // Stop loss
  const stopDistance = QUANT_CONFIG.stopAtrMultiple * atr_14;
  const stopLoss = current_price - stopDistance;

  // Target
  const target = Math.min(bb_upper ?? Infinity, support_resistance?.r1 ?? Infinity);
  if (!isFinite(target)) return { ok: false, reason: 'no valid target' };

  // R:R gate
  const rrRatio = (target - current_price) / stopDistance;
  if (rrRatio < QUANT_CONFIG.minRrRatio) {
    return { ok: false, reason: `R:R ${rrRatio.toFixed(2)} below ${QUANT_CONFIG.minRrRatio}` };
  }

  // Sizing constraints — take the minimum
  const riskPerTrade = portfolio.allocatedCash * QUANT_CONFIG.accountRiskPct;
  const qtyByRisk      = Math.floor(riskPerTrade / stopDistance);
  const qtyByPosition  = Math.floor((portfolio.allocatedCash * QUANT_CONFIG.maxPositionPct) / current_price);
  const qtyByLiquidity = Math.floor(adv_20 * QUANT_CONFIG.maxLiquidityPct);

  // Volatility normalisation — reduce size for high-vol names
  const volScalar = Math.min(1, 0.02 / (atr_14 / current_price));

  // Fractional Kelly
  const rewardDistance = target - current_price;
  const edge = (winProb * rewardDistance) - ((1 - winProb) * stopDistance);
  const kellyFull = edge / Math.pow(stopDistance, 2);
  const kellyAdjusted = Math.max(0, Math.min(1, kellyFull * QUANT_CONFIG.kellyFraction));
  const qtyByKelly = Math.floor((portfolio.allocatedCash * kellyAdjusted) / current_price);

  // Final qty
  const qty = Math.floor(
    Math.min(qtyByRisk, qtyByPosition, qtyByLiquidity, qtyByKelly) * volScalar
  );
  if (qty <= 0) return { ok: false, reason: 'sizing constraints reject trade' };

  // EV — accounting for opportunity cost and brokerage
  const riskAUD = qty * stopDistance;
  const rewardAUD = qty * rewardDistance;
  const evGross = (winProb * rewardAUD) - ((1 - winProb) * riskAUD);

  const days = expectedTimeToTarget ?? 10;
  const opportunityCost = qty * current_price * (portfolio.rbaRate / 100) * (days / 365);
  const evNet = evGross - opportunityCost - (2 * portfolio.brokerage);

  return {
    ok: true,
    ticker, qty, entryPrice: current_price,
    stopLoss, target, rrRatio,
    riskAUD, rewardAUD, evGross, evNet,
    kellyAdjusted, volScalar,
    constraintBinding: identifyBindingConstraint({ qtyByRisk, qtyByPosition, qtyByLiquidity, qtyByKelly }),
  };
}
```

### Analyst and PM Prompts Shrink Dramatically

The Analyst prompt focuses only on multi-factor assessment:

```
You produce per-ticker assessments. No trade construction, no sizing.
Output: { ticker, conviction (0-1), winProb (0-1), expectedTimeToTarget (days),
          keyFactors[], risks[], macroFit, valuation, technicalConfirmation }
```

The PM prompt only needs to approve, reject, rank, and explain:

```
You receive pre-sized trades from the quant engine. Decide:
- approve / reject (with reason)
- rank by overall portfolio fit
- write a user-facing explanation for each

Apply portfolio-level rules (sector concentration, anti-churn, CGT window).
Do NOT recompute sizing, stops, or EV — those are provided.
```

The PM system prompt drops from ~280 lines to ~50. Cache hit reliability improves. API costs drop. Reasoning quality improves because the model has fewer competing constraints.

---

## 3.2 Deterministic Regime Detection Engine

**Why:** The day trading strategy is fundamentally a mean-reversion + volatility-compression + liquidity-driven approach. These strategies fail catastrophically during:

- Trend acceleration (BB lower band reclaim keeps failing as price grinds lower)
- Panic regimes (correlations spike to 1, all stops trigger simultaneously)
- Commodity collapses (sector-specific cascades)
- Earnings shock clusters

Without explicit regime classification, the system can't know when to step aside — which is the single most important property of any quant strategy.

### Implementation

```js
// js/regime-engine.js

const REGIMES = ['riskOn', 'riskOff', 'panic', 'highVol', 'trend', 'sideways'];

function classifyRegime(macro, indices) {
  const {
    asx200_return_5d, asx200_return_20d,
    asx200_atr_pct, asx200_adx,
    vix_au,
    advance_decline_ratio,
    aud_usd_change_5d,
    iron_ore_change_5d,
  } = macro;

  if (vix_au > 30 && advance_decline_ratio < 0.3) return 'panic';
  if (asx200_atr_pct > 1.5 || vix_au > 22) return 'highVol';
  if (asx200_adx > 25 && Math.abs(asx200_return_20d) > 4) return 'trend';
  if (asx200_return_5d < -2 && (iron_ore_change_5d < -3 || aud_usd_change_5d < -1)) return 'riskOff';
  if (asx200_return_5d > 1 && advance_decline_ratio > 0.6) return 'riskOn';
  return 'sideways';
}
```

### Regime Gates Strategy Availability

```js
const STRATEGY_REGIMES = {
  meanReversionSwing: ['riskOn', 'sideways', 'highVol'],
  trendFollowing:     ['trend', 'riskOn'],     // future
  cashOnly:           ['panic'],
};

function isStrategyAllowed(strategy, regime) {
  return STRATEGY_REGIMES[strategy].includes(regime);
}
```

### Regime Flows Through the Pipeline

```js
const regime = classifyRegime(state.macroData, state.indices);
state.activeRegime = regime;

if (!isStrategyAllowed('meanReversionSwing', regime)) {
  showToast(`Regime: ${regime} — swing strategy disabled.`, 'info');
  return { recs: [], summary: `Regime ${regime} unsuitable for mean-reversion.` };
}

// AI calls receive regime in user message header (see 2.3)
```

### Regime Tightens AI Parameters

System prompts include regime-specific guards:

```
If activeRegime = "highVol":
- Require minConfidence ≥ 0.75 (not 0.60)
- Reduce qty by 30%
- Mandatory stop at 2.0×ATR (tighter than 2.5×)

If activeRegime = "panic" or "trend":
- No new positions. Cash only.
```

---

## 3.3 Trade Outcome Learning Loop

**Why:** The current system improves through prompt edits, not through trade evidence. Without a feedback loop, the AI can't adapt to:

- Confidence calibration drift (0.75-confidence trades winning at 50%)
- Strategy decay (a setup that worked Q1 may not work Q3)
- Regime-specific performance differences
- Drawdown patterns signalling regime shift

### Deterministic Analytics Layer

```js
// js/learning-loop.js

function computeCalibrationBlock(closedTrades) {
  const bands = { '0.60-0.69': [], '0.70-0.79': [], '0.80-0.89': [], '0.90+': [] };

  closedTrades.forEach(t => {
    const band = bucketConfidence(t.confidenceAtEntry);
    bands[band].push({ won: t.pnl > 0, pnlPct: t.pnlPct });
  });

  return Object.entries(bands).map(([band, trades]) => {
    const hitRate = trades.filter(t => t.won).length / trades.length || 0;
    const avgPnl = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length || 0;
    return {
      band, n: trades.length, hitRate, avgPnlPct: avgPnl,
      calibrationDelta: hitRate - bandMidpoint(band),  // negative = overconfident
    };
  });
}

function computeRegimePerformance(closedTrades) {
  const byRegime = {};
  closedTrades.forEach(t => {
    byRegime[t.regimeAtEntry] = byRegime[t.regimeAtEntry] || { wins: 0, total: 0, pnl: 0 };
    byRegime[t.regimeAtEntry].total++;
    if (t.pnl > 0) byRegime[t.regimeAtEntry].wins++;
    byRegime[t.regimeAtEntry].pnl += t.pnl;
  });
  return byRegime;
}

function detectStrategyDecay(closedTrades, windowDays = 30) {
  const recent     = closedTrades.filter(t => daysSince(t.closeDate) <= windowDays);
  const historical = closedTrades.filter(t => daysSince(t.closeDate) > windowDays);

  const recentHR     = recent.filter(t => t.pnl > 0).length / recent.length;
  const historicalHR = historical.filter(t => t.pnl > 0).length / historical.length;

  return {
    recentHitRate: recentHR,
    historicalHitRate: historicalHR,
    decayDetected: recentHR < historicalHR - 0.15,
  };
}
```

### Injected as Empirical Evidence

```
=== CALIBRATION (last 90 days, n=47 closed trades) ===
Confidence 0.60-0.69 (n=12): actual hit rate 50%, expected ~65%. Delta: -0.15 (OVERCONFIDENT).
Confidence 0.70-0.79 (n=20): actual hit rate 70%, expected ~75%. Delta: -0.05.
Confidence 0.80+   (n=15): actual hit rate 87%, expected ~85%. Delta: +0.02 (well calibrated).
INSTRUCTION: Apply -0.15 adjustment to confidence scores in the 0.60-0.69 band.

=== REGIME PERFORMANCE ===
sideways: 24 trades, hit rate 71%, avg P&L +1.8%
highVol:  15 trades, hit rate 47%, avg P&L -0.3%
INSTRUCTION: highVol shows poor hit rate. Tighten confidence threshold to 0.75 in this regime.

=== STRATEGY DECAY ===
Last 30 days hit rate: 55%. Prior 60 days: 68%.
DECAY DETECTED. Reduce position sizing by 25% pending review.
```

### Persistence

Add to SQLite alongside the trade journal. Recompute nightly (or after every closed trade). Surface on the Performance page so drift is visible in real time.

---

## 3.4 Dynamic Prompt Assembly — Conditional Rule Modules

**Why:** `ANALYSIS_SYSTEM_PROMPT` is ~280 lines containing every rule for every scenario — all loaded for every call. This causes token bloat, instruction conflicts (the model weighs many simultaneous constraints), and growing hallucination risk.

### Composable Rule Modules

```js
// js/prompt-modules.js

const RULE_MODULES = {
  CORE_HARD_RULES: `...sections 1-3, always loaded, stable for caching...`,

  TAX_LOSS_HARVEST: `
=== TAX-LOSS HARVESTING (active) ===
Scan holdings for unrealised loss > $500. Suggest SELL to crystallise.
Include taxBenefitEstimate (loss × marginal rate).
Flag wash sale risk if re-entry within 30 days.
  `,

  CGT_DISCOUNT_WINDOW: `
=== CGT DISCOUNT WINDOW ===
Never recommend SELL/TRIM on positions held 11-12 months without flagging the discount.
Suggest waiting for the 12-month mark unless thesis permanently broken.
  `,

  REPORTING_SEASON: `
=== REPORTING SEASON ACTIVE ===
If ≥3 holdings have earnings within 7 days, flag the cluster.
Recommend de-risking the most expensive or most-shorted name.
  `,

  MINING_SECTOR: `
=== MINING SECTOR RULES ===
Iron ore < $90/t: reject TOP_UP on BHP/RIO/FMG.
AUD/USD < 0.65: bias toward unhedged exporters.
  `,

  REIT_SECTOR: `
=== REIT-SPECIFIC RULES ===
Franking: REITs are pass-through trusts. Use 0% franking unless stated.
Watch debt coverage ratios when rates rising.
  `,

  HIGH_VOL_REGIME: `
=== HIGH VOLATILITY REGIME ===
Minimum confidence: 0.75 (raised from 0.62).
Reduce qty by 30% on all BUY/TOP_UP.
Stop distance: 2.0×ATR.
  `,
};

function assemblePrompt(context) {
  const modules = [RULE_MODULES.CORE_HARD_RULES];

  const month = new Date().getMonth() + 1;
  if (month >= 5 && month <= 6) modules.push(RULE_MODULES.TAX_LOSS_HARVEST);
  if ([2, 8].includes(month))   modules.push(RULE_MODULES.REPORTING_SEASON);

  if (context.portfolio.some(p => holdingMonths(p) >= 11 && holdingMonths(p) < 12)) {
    modules.push(RULE_MODULES.CGT_DISCOUNT_WINDOW);
  }

  const sectors = new Set(context.tickers.map(t => getSector(t)));
  if (sectors.has('Mining')) modules.push(RULE_MODULES.MINING_SECTOR);
  if (sectors.has('REIT'))   modules.push(RULE_MODULES.REIT_SECTOR);

  if (context.regime === 'highVol') modules.push(RULE_MODULES.HIGH_VOL_REGIME);

  return modules.join('\n\n');
}
```

### Cache Strategy

The core block stays first and stable; optional modules are appended after:

```js
system: [
  { type: 'text', text: RULE_MODULES.CORE_HARD_RULES, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: assembledOptionalModules },  // not cached — varies per call
]
```

The core (largest and most stable) keeps hitting cache. Optional modules are small and sent fresh.

**Expected impact:** typical call drops from ~3000 to ~1500 tokens of system prompt. Faster TTFT, cleaner reasoning, lower cost.

---

## 3.5 Schema Validation + Auto-Repair Loop

**Why:** A safe JSON parser (2.5) only handles syntax. The AI can return well-formed JSON that's semantically broken — missing `stopLoss`, `confidence` outside 0-1, `qty` of NaN, `target` ≤ `priceRange[1]`. These cascade into UI bugs or bad trade execution.

### Schema and Business Rule Validation

```js
// js/response-validator.js

const REC_SCHEMA = {
  ticker:     { type: 'string', required: true, pattern: /^[A-Z]{3,4}(\.AX)?$/ },
  action:     { type: 'string', required: true, enum: ['BUY', 'SELL', 'TRIM', 'TOP_UP'] },
  priceRange: { type: 'array', required: true, length: 2, items: { type: 'number', min: 0 } },
  target:     { type: 'number', required: true, min: 0 },
  stopLoss:   { type: 'number', required: true, min: 0 },
  qty:        { type: 'number', required: true, min: 1, integer: true },
  confidence: { type: 'number', required: true, min: 0, max: 1 },
  rrRatio:    { type: 'number', required: false, min: 0 },
};

const REC_BUSINESS_RULES = [
  rec => rec.action === 'BUY' || rec.action === 'TOP_UP'
    ? { ok: rec.target > rec.priceRange[1], reason: 'target must exceed entry high for BUY/TOP_UP' }
    : { ok: true },
  rec => ({ ok: rec.stopLoss < rec.priceRange[0], reason: 'stop must be below entry low' }),
  rec => ({ ok: !isNaN(rec.qty) && rec.qty > 0, reason: 'qty must be positive integer' }),
  rec => rec.rrRatio !== undefined
    ? { ok: rec.rrRatio >= 2.0, reason: `R:R ${rec.rrRatio} below minimum 2.0` }
    : { ok: true },
];

function validateRec(rec) {
  const errors = [];
  for (const [field, schema] of Object.entries(REC_SCHEMA)) {
    const err = validateField(rec[field], schema, field);
    if (err) errors.push(err);
  }
  for (const rule of REC_BUSINESS_RULES) {
    const { ok, reason } = rule(rec);
    if (!ok) errors.push(reason);
  }
  return { ok: errors.length === 0, errors };
}

function validateResponse(parsed) {
  if (!parsed.recs || !Array.isArray(parsed.recs)) {
    return { ok: false, errors: ['response missing recs[] array'] };
  }

  const allErrors = [];
  const validRecs = [];

  for (const [i, rec] of parsed.recs.entries()) {
    const { ok, errors } = validateRec(rec);
    if (ok) validRecs.push(rec);
    else allErrors.push({ index: i, ticker: rec.ticker, errors });
  }

  return { ok: allErrors.length === 0, validRecs, errors: allErrors };
}
```

### Auto-Repair Loop

```js
async function getValidatedAnalysis(userMessage, maxAttempts = 2) {
  let lastErrors = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const finalMessage = lastErrors ? buildRepairMessage(userMessage, lastErrors) : userMessage;

    const { text } = await callClaude('portfolio', finalMessage);
    const { ok: parseOk, data } = parseClaudeJSON(text);

    if (!parseOk) {
      lastErrors = [{ type: 'parse', message: 'Output was not valid JSON' }];
      continue;
    }

    const { ok, validRecs, errors } = validateResponse(data);
    if (ok) return { ok: true, data };

    // Partial success — keep valid recs on final attempt
    if (validRecs.length > 0 && attempt === maxAttempts) {
      console.warn(`${validRecs.length} valid recs returned; ${errors.length} rejected`);
      return { ok: true, data: { ...data, recs: validRecs }, partial: true };
    }

    lastErrors = errors;
  }

  return { ok: false, errors: lastErrors };
}

function buildRepairMessage(originalMessage, errors) {
  const summary = errors.map(e =>
    `- rec[${e.index}] (${e.ticker}): ${e.errors.join('; ')}`
  ).join('\n');

  return `${originalMessage}

=== PREVIOUS RESPONSE HAD VALIDATION ERRORS ===
${summary}

Regenerate with these errors corrected. Maintain the same JSON schema.
If a rec cannot be fixed without violating hard rules, omit it from recs[]
and add it to dataGaps[] with the reason.`;
}
```

---

# Summary

| # | Area | Improvement | Severity / Impact | Effort |
|---|------|-------------|-------------------|--------|
| 1.1 | strategy.js | ADX filter logic gap | Medium | Low |
| 1.2 | strategy.js | SMA50 fallback asymmetry | Low | Low |
| 1.3 | strategy.js | Config object mixes pre-filter and AI params | Low | Low |
| 1.4 | prompts.js | Tax-loss harvest needs date injection | Medium | Low |
| 1.5 | prompts.js | Liquidity check units mismatch | Low | Low |
| 1.6 | prompts.js | Inconsistent confidence definition | Low | Low |
| 2.1 | API | Centralised callClaude() wrapper | High | Low |
| 2.2 | Prompts | Shared signal block | Medium | Low |
| 2.3 | API | Structured user message header | High | Low |
| 2.4 | API | Exponential backoff retry | Medium | Low |
| 2.5 | API | Safe JSON parser | Medium | Low |
| 3.1 | Architecture | Deterministic quant engine layer | Very High | High |
| 3.2 | Architecture | Regime detection engine | Very High | Medium |
| 3.3 | Architecture | Trade outcome learning loop | High | Medium |
| 3.4 | Architecture | Dynamic prompt assembly | High | Medium |
| 3.5 | Architecture | Schema validation + auto-repair | Medium | Low |

## Recommended Implementation Order

**Phase 1 — Quick wins** (1-2 days, low risk):

1. Tier 1 fixes (1.1–1.6) — all small targeted edits
2. Centralised `callClaude()` wrapper (2.1)
3. Safe JSON parser (2.5)
4. Exponential backoff (2.4)

**Phase 2 — Architecture foundations** (1 week):

5. Schema validation + auto-repair (3.5) — immediate reliability gain, no architectural change
6. Structured user message header (2.3) — unblocks date-dependent rules
7. Shared day trade signal block (2.2) — small cleanup
8. Regime detection engine (3.2) — biggest tail-risk reduction

**Phase 3 — Structural shift** (2-3 weeks):

9. Deterministic quant engine (3.1) — the largest single improvement; refactors analysis pipeline
10. Trade outcome learning loop (3.3) — depends on quant engine being in place for clean trade provenance
11. Dynamic prompt assembly (3.4) — highest payoff after the rest is stable; needs careful cache tuning

Each phase delivers compound value: by the time you reach Phase 3, the system is auditable, regime-aware, self-correcting, and significantly cheaper to operate.
