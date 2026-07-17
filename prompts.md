# Sloth ASX Trader — Prompt Architecture Reference

**Last updated:** 2026-07-17. **Live `PROMPT_VERSION` is `2026-07-v24`** (`js/prompts.js:18`) — thirteen versions ahead of this doc's last full pass (v11); several structural claims below (rule count, section labels, output schema) were refreshed against the current code on this date, but treat any unverified `vNN`-specific detail as suspect and check `js/prompts.js` directly.
**Model:** `claude-sonnet-4-6` · all calls via `callClaude()` in `js/claude-client.js`

This document is the authoritative reference for every Claude API call in the application:
what triggers it, what data it receives, what it must return, and how the response is used.

---

## Architecture Overview

```
User action / scheduler
        │
        ▼
callClaude(agentType, userMessage, options)    ← js/claude-client.js
        │
        ├── Resolves system prompt from agentType (_resolveSystemPrompt)
        ├── Applies prompt-caching headers (ephemeral) unless noCache=true
        ├── Retries on 429/529 with exponential backoff (0s → 1s → 2s → 4s)
        ├── Logs full call (system + user + response) to /api/log/ai_response
        │
        ▼
  Anthropic API → response text
        │
        ├── Portfolio: JSON → parseClaudeJSON → quant engine → validator → regime gate → UI
        ├── Macro:     JSON → state.macroData → injected into next portfolio call
        ├── DayTrade:  JSON → validator → quant engine → state.dayTrading.recommendations
        ├── Assistant: plain text → rendered directly in chat / digest card
        └── Briefing:  plain text → window._morningBrief → Dashboard card
```

### Caching strategy

These are the only five agent types `_resolveSystemPrompt()` (`js/claude-client.js`) actually knows about. Older docs referencing `analyst`, `pm`, or `briefing` agent types describe a design that was removed — those identifiers don't exist anywhere in the current code.

| Agent | Cached | Max tokens | Rationale |
|---|---|---|---|
| `portfolio` | ✅ yes (`ephemeral`) | 12,000 | Same static system prompt all day; dynamic content in user message only |
| `dayTrade` | ✅ yes | 4,000 | System prompt embeds only brokerage (rarely changes) |
| `universe` | ✅ yes | 4,000 | Same as dayTrade |
| `macro` | ❌ no (`noCache`) | 3,000 | Short, cheap, varies with live data |
| `assistant` | ❌ no | 2,000 | Multi-turn; context varies every call |

**Structured output (Sprint 62, §8.5):** the `portfolio` agent forces tool use on a static
`emit_recommendations` tool (`_PORTFOLIO_TOOL` in `claude-client.js`) — the API constrains the
output to the JSON schema at generation time, eliminating the malformed-JSON parse-failure class.
The `tool_use` block's input is stringified back into `responseText` so `parseClaudeJSON()` and
all downstream post-processing are unchanged. The schema enforces TYPES and closed enums
(action, orderType, urgency); business rules remain the validator's job. The tool definition is
static (part of the cached prompt prefix — interpolating state would bust the cache every call).
Escape hatch: `options.noTool`. Proxy mode forwards `tools`/`tool_choice` verbatim.

The `portfolio` system prompt is the only one worth optimising for cache stability — it's the most expensive (~8,700 tokens, confirmed via `cache_creation_input_tokens` in call logs) and called multiple times per trading day. All dynamic state lives in the user message; the system prompt contains zero interpolations.

### Auto-trigger removal (hotfix a888eec)

The following Ollama calls are **manual-only** — they are no longer triggered automatically from `runAnalysis()` or `markExecuted()`:
- **Postmortem / skill-score**: `triggerPostmortem()` and `fetchSkillScore()` were removed from `markExecuted()`. Trigger via 🤖 / 🔬 buttons on the Learning page.
- **Calibration quality debate**: `triggerCalibQualityIfStale()` was removed from `runAnalysis()`. The calib-quality card loads with `?cache_only=1` and shows a "▶ Run debate" button when no cached result exists.

This prevents unintended Ollama calls during market hours and avoids priority-queue saturation.

---

## 1. Portfolio Analysis — `'portfolio'`

**File:** `js/analysis.js → runAnalysis()`
**Trigger:** "Run Analysis" button · max tokens is a **budget tier**, not a flat number: `ANALYSIS_BUDGET_TIERS` (`js/config.js`) — lean 8,000 / **standard 12,000 (default)** / deep 20,000 / custom user-set (floored, no cap). `state.settings.analysisTokenBudget` selects the tier; it also deterministically rations watchlist tickers so holdings are always fully analysed first.
**System prompt:** `ANALYSIS_SYSTEM_PROMPT` (static, cached) + optional regime/date modules from `buildSystemArray()` (uncached second block)

### System prompt structure

| Section | Content |
|---|---|
| **1 — Hard Rules** (Rules 1–19) | Non-negotiable constraints: profitable entry, real-data-only, R:R ≥ 2:1, position sizing, conviction threshold, SELL/TRIM validity, watchlist handling, cash-as-position, sector concentration cap, ex-div protection, tax-aware trimming, macro override, CGT window, mandatory SELL escalation, risk-adjusted sizing, Sharpe context, ... through Rule 19 (fundamentals over technicals for established positions) |
| **1C — Entry Driver Tagging** | `primary_entry_driver` required on every BUY/TOP_UP — a closed taxonomy tagging what actually drove the entry decision, feeds the Learning Loop's driver-matrix analytics |
| **2 — SELL/TRIM Decision Tagging** | Closed taxonomy for `primary_driver` (9 values), `secondary_factors` (12 values, 0–3), `urgency` (3 values). Forbidden combos, required-secondary rules, `alternativeTicker` requirement |
| **2B — Thesis Validation at Exit and on Hold** | Uses the engine-computed `HOLDING_CONTEXT` Delta (entry-vs-now signal drift, computed by `computeThesisDrift()` in `analysis.js` — Claude cites it, doesn't re-derive it) |
| **2C — Anti-Churn** | 7-day BUY→SELL block; catastrophe override definition; minimum hold 1 day; churn threshold ($100 or 2%) |
| **3 — Multi-Factor Framework** | Priority 1: Earnings/revisions → Priority 2: Macro regime → Priority 3: Sector flows → Priority 4: Relative valuation → Priority 5: Technicals (confirming only, one indicator per independent category) |
| **4 — Income & Tax** | Franking credit grossed-up yield formula; tax-loss harvest activation window; reporting season cluster risk |
| **5 — Execution** | Liquidity cap (≤5% of volume_avg_20); sizing guidance; order types |
| **6 — Learning from History** | Calibration algorithm; debate block interpretation; rec history review |
| **7 — Pre-flight Checks** | Cash comparison test with worked arithmetic examples; **8** validation checks (a)–(h) — adds (g) scenarios-object-sums-to-1.0 and (h) bullCase/bearCase requirement |
| **8 — Output Format** | Full JSON schema with worked example, `qty: 0` always (Rule 4), `bullCase`/`primary_entry_driver` required on BUY/TOP_UP |

### Optional modules (injected as second uncached system block)

These are assembled by `buildSystemArray()` in `prompt-modules.js` based on date and portfolio state:

| Module | Activation condition |
|---|---|
| `TAX_LOSS_HARVEST` | Month = May or June |
| `CGT_DISCOUNT_WINDOW` | Any holding has `daysHeld` between 330–365 |
| `REPORTING_SEASON` | Month = February or August |
| `MINING_SECTOR` | Sector = Materials/Mining/Resources, detected across three sources (portfolio, `state.liveSignals`, `context.sectors`) — NOT a fixed ticker list (BHP/RIO/FMG/MIN). |
| `REIT_SECTOR` | Same sector-string detection, sector = Real Estate. Not ticker-based. |
| `FINANCIALS_SECTOR` | Sector = Financials/Financial Services/Banks — bank NIM-specific rules |
| `HIGH_VOL_REGIME` | Active regime = `highVol` only (`bearVolatile` is not a checked value) |
| `RISK_OFF_REGIME` | Active regime = `riskOff` |

### User message — all injected by `analysis.js`

```
Date: {YYYY-MM-DD} | Time: {HH:MM AEST} | TAX_LOSS_HARVEST_ACTIVE: {bool}[ | Account: {PERSONAL|SUPER|TRADING}]
Account settings: brokerage ${n}/trade (round-trip ${2n}) | max {n} trades/day | min trade ${n}

LIVE PORTFOLIO STATE:
Holdings: [{ticker, sector, shares, avgPrice, currentPrice, value, unrealisedPnl,
            unrealisedPnlPct, daysHeld, weight}]
            ← currentPrice is the live signal price from state.liveSignals (force-refreshed via GET /api/analyse at Step 2 of runAnalysis), not the stale portfolio cache price
Cash available: ${n} | Total invested: ${n} | Net worth: ${n}
RBA Cash Rate: {n}% ({source}, {date})

RECENT RECOMMENDATION HISTORY (last 5 + key outcomes):
{date} {action} {ticker} @ ${price} → target ${t} | conf={n}% | outcome={o} | actualPnL={p}

{__CALIBRATION_PLACEHOLDER__}        ← replaced with GET /api/learning/calibration result
{LESSONS_BLOCK}                       ← replaced with GET /api/learning/lessons result

TODAY'S MACRO BRIEF ({date}):
Sentiment: {s} | Bullish: {n}/100 | Conf: {n}%
Key drivers: {text ≤200 chars}
Commodities/Rates: IronOre=${n}({pct}) | Oil=${n}({pct}) | Copper=${n}({pct}) | US10Y={n}%
ASX Sectors(1D/5D): Materials:{pct}(5d{pct}) | Financials:{pct}... [5 SPDR ETFs]

NEWS SIGNALS (LLM-classified, last 3d):
Holdings directly covered: • {signal line per article}
Market-wide signals: • {signal line per high-impact article}

ASX ANNOUNCEMENT FILINGS (last 3d):
⚡ Price-sensitive: • {TICKER [Type|sentiment|impact|⚡PS] Headline (date)}
Routine filings: • {same format}

INVESTOR MARKET VIEW & INSTRUCTIONS (when set):
{free text from state.analysisConfig.marketView}

ADDITIONAL WATCHLIST TICKERS: {comma list}

DIVIDEND SCHEDULE & HISTORY:
  {TICKER}: yield={n}% | annual=${n}/yr | nextEst=${n} | exDiv={date} |
            freq={s} | payoutRatio={n}% | recent=[{date}:${amt}, ...]

EARNINGS CALENDAR:
  {TICKER}: nextEarnings={date} ({n}d){⚡IMMINENT?} | fwdEPS=${n} | epsGrowth={n}% |
            revGrowth={n}% | analyst={rec} target=${n} | EPSvEst(4Q):[+0.05,-0.02,...]

PORTFOLIO RISK METRICS (90-day):
Composite risk score: {n}/100 ({label}) | Weighted: Vol={n}%ann | Beta={n} |
                       VaR1d={n}% | AvgMaxDD={n}% | Sharpe={n}
Per-ticker:
  {TICKER}: Vol={n}%ann | Beta={n} | Sharpe={n} | VaR1d={n}%{⚠?} |
            CVaR={n}% | MaxDD90d={n}%{⚠?}

PORTFOLIO SECTOR ALLOCATION: {Sector}={n}%, ...

LIVE TECHNICAL DATA (yfinance, real-time):

[{TICKER}]{★WATCHLIST★?}
  Price=${n} | Signal={BUY/SELL/HOLD} ({n}% conf) | Trend={dir}({n}/{n}signals) | ADX={n} ({strength})
  Momentum: RSI14={n}, RSI9={n}, MACDhist={n}{↑expanding/↓contracting},
            ROC10={n}% ROC21={n}%, Stoch%K={n}/%D={n}, CCI={n}, MFI={n}, WillR={n}
  Trend: SMA20=${n}, SMA50=${n}, SMA200=${n}, EMA12=${n}, EMA26=${n}
  Bollinger: Upper=${n}, Mid=${n}, Lower=${n}, %B={n}%, Width={n}%, DonchPos={n}%
  Volatility: ATR=${n} ({n}%), HistVol20d={n}%ann 60d:{n}% regime:{ELEVATED/COMPRESSED/NORMAL},
              Keltner={n}-{n}
  Volume: Today={n}, Avg20={n}, Ratio={n}x, VZ={n}σ, OBV={rising/falling},
          VWAP20=${n} (price {above/below})
  S/R Pivots: R2=${n}, R1=${n}, Pivot=${n}, S1=${n}, S2=${n}
  Returns: 1D={n}%, 5D={n}%, 20D={n}%, 60D={n}%, 90D={n}%
           vs.ASX200:{±n}pp vs.Sector:{±n}pp
           | Range60d: hi=${n} lo=${n}   ← for Fibonacci zone calc (when available)
  Fundamentals: PE={n}, FwdPE={n}, PB={n}, DivYield={n}%, Beta={n}, ROE={n}%,
                OpMgn={n}%, D/E={n}, RevGrowth={n}%, FCFYield={n}%, Short={n}%float
  52W: High=${n}, Low=${n}, FromHigh={n}%, AnalystUpside:{±n}%, Analyst={rec} (target ${n})
  BuySignals: {list} | SellSignals: {list}
  CorrToHoldings: NAB:0.87 ANZ:0.81        ← §9.3, top |ρ| ≥ 0.60 vs current holdings (when available)
  WeeklyCls(10wk,old→new): ${n} ${n}↑ ${n}↓ ... | VolTrend5w:{±n}%

ACTIVE RULE OVERRIDES: {all configurable thresholds from state.analysisConfig.rules}

ACTIVE_REGIME: {regime} (confidence: {n}%)

--- Local Debate [{model}]: {TICKER} ---    ← Ollama bull/bear pre-debate (if enabled)
BULL: {text}
BEAR: {text}
SYNTHESIS: {winner} | {key_pivot}
---
```

### Expected output

```json
{
  "recs": [{
    "ticker":                "BHP",
    "action":                "BUY" | "SELL" | "TRIM" | "TOP_UP",
    "sector":                "Materials",
    "isWatchlist":           false,
    "priceRange":            [44.20, 44.80],
    "target":                49.50,
    "stopLoss":              42.10,
    "qty":                   0,     // ALWAYS 0 (Rule 4) — quant engine sets the real qty, Claude's value is ignored
    "tranches":              1,
    "orderType":             "LIMIT",
    "limitPrice":            44.50,
    "confidence":            0.74,
    "scenarios":             {"bull":{"p":0.30,"ret":0.12},"base":{"p":0.50,"ret":0.07},"bear":{"p":0.20,"ret":-0.04}},
    "expectedTimeToTarget":  45,
    "factorsUsed":           ["[FUNDAMENTAL] EPS revision: +3.1% over 30d", "[MACRO] weak AUD", "[FUNDAMENTAL] Valuation: fwdPE 10.2 vs sector 13.5x"],
    "reasoning":             "≤150 chars: top 2–3 factors; no RSI/MACD as primary",
    "risks":                 "≤100 chars: #1 macro or fundamental risk",
    "catalysts":             "≤120 chars: specific events e.g. RBA cut Jun25",
    "signals":               ["RSI14: 44 rising", "OBV: uptrend"],
    "invalidationCondition": "≤80 chars: must contain a measurable value",
    "bullCase":              "≤100 chars: required for BUY/TOP_UP — steelman of why this goes right",
    "bearCase":              "≤100 chars: required SELL/TRIM, and BUY/TOP_UP with conf ≥ 0.70",
    "weightGuidance":        "Accumulate (+1-2%)",
    "expectedProfit":        367.50,
    "netProfit":             329.30,
    "taxBenefitEstimate":    null,
    "grossedUpYield":        null,
    "primary_entry_driver":  "fundamental_value", // BUY/TOP_UP only — required; one of: mean_reversion, momentum_breakout, trend_pullback, fundamental_value, macro_tailwind
    "primary_driver":        "thesis_broken",   // SELL/TRIM only
    "secondary_factors":     ["negative_news_flow"],  // SELL/TRIM only
    "urgency":               "immediate",        // SELL/TRIM only
    "alternativeTicker":     null               // required when primary_driver=better_opportunity
  }],
  "summary":  "≤400 chars plain text — recs, macro, cash stance",
  "dataGaps": [{"ticker": "XYZ", "missingField": "signals absent"}]
}
```

### Post-processing pipeline (client-side, after response)

Order matches the section markers in `analysis.js` (verified Sprint 61):

1. **JSON parse** — `parseClaudeJSON()` with brace-depth recovery on truncation
2. **Quant engine** — `computeTradeParams()` replaces AI-computed `qty / stopLoss / rrRatio / riskAUD / rewardAUD` for BUY/TOP_UP with deterministic Kelly + volatility-scalar + multi-constraint sizing. When the engine DECLINES (`ok:false` — e.g. R:R below 2 at the regime-widened stop), the rec gets min-trade-size fallback qty (capped by cash) + a single `_ruleWarnings` entry stating the engine's reason, so the card stays executable on user judgment *(Sprint 68 — fixes the WDS qty=0 triple-warning incident)*
3. **SELL/TRIM sizing** — Rule 4 forces Claude to emit `qty: 0`; SELL = full held position, TRIM = midpoint of the `weightGuidance` "Reduce (-X-Y%)" range (default 35%), clamped to `[1, shares held]`. Tagged `_exitSized`. *(Sprint 58)*
4. **ATR floor** — SELL/TRIM stop loss floored at `entry + stopMult×ATR` where `stopMult = regimeMod.stopAtrMult ?? 2.5` (regime-conditional: 2.5 riskOn/trend/sideways · 3.0 highVol · 3.5 riskOff · 4.0 panic). Rec flagged `_stopRepaired: true` + `_stopRepairedMult: N` when repair fires.
5. **Validator** — `validateRec()` (schema + business rules + `validateSellTags()`), **local fix-or-flag — there is NO network repair loop in the live path**. Runs after sizing so the `qty ≥ 1` and stop-direction checks validate final values. Repaired recs carry `_validatorFixed: [errors]` (incl. the Sprint 64 driver-mention auto-repair: missing literal driver token in reasoning → `[driver: X]` appended, `_driverMentionAppended`). **Unfixable recs are KEPT and flagged** (`_ruleWarnings: [errors]`) — rendered with a red review panel + Skip/Execute buttons so the user decides (2026-06-11 decision). Only structurally unusable recs (invalid ticker/action) are dropped. `getValidatedAnalysisWithRepair()` exists in `response-validator.js` but is **not called** from `runAnalysis()`. *(Wired Sprint 61; flag-don't-drop Sprint 64)*
6. **Ensemble confidence** — `0.5 × AI conf + 0.5 × (indicator score/100)` stamped on each rec; feeds `ensemble_confidence` in learning events. *(Restored Sprint 61 — was only computed in the unwired `validateResponse()`)*
7. **Regime modifiers** — `applyRegimeModifiers()` applies size multipliers; `panic` blocks all recs (blocked recs shadow-logged)
8. **P&L recompute** — SELL/TRIM `netProfit` recalculated from actual `holding.avgPrice`; BUYs with non-positive engine-computed net-EV are **flagged** (`_ruleWarnings`) and shadow-logged, not dropped *(Sprint 64)*
9. **Confidence floor** — recs below `minConfidence` (default 0.62) are **flagged**, not dropped; BUY-side fails shadow-logged *(Sprint 64)*
10. **Correlation adjustment** — correlation matrix from `/api/risk`; BUY qty −30% if `|corr|>0.70` with existing holding, −50% if `>0.85`
11. **Heat budget gate** — total $-at-risk capped at `min(maxRiskBudgetPct, regime ceiling)`; over-budget recs scaled or `_budgetBlocked`
12. **Same-day conflict guard** — drops SELL if BUY already logged today for same ticker (and vice versa)
13. **Daily dedup** — suppresses duplicate TRIM/TOP_UP for same ticker on same day
14. **Daily cap** — trims to `maxTradesPerDay` by descending confidence; flagged (advisory) recs neither compete for slots nor get cut *(Sprint 64)*
15. **Learning loop** — `logRecsToLearningLoop()` fires asynchronously

> **Note on `portfolioJson` and live prices (hotfix a888eec):** Before building the user message, `analysis.js` constructs `portfolioJson` using `livePrice = state.liveSignals[ticker]?.current_price ?? h.currentPrice` for **all** price-derived fields: `currentPrice`, `value`, `unrealisedPnl`, `unrealisedPnlPct`, and `weight`. This ensures SELL/TRIM recs anchor `priceRange` to the fresh signal price (force-fetched at Step 2 of `runAnalysis()`), not the potentially stale `state.portfolio[].currentPrice` cached from the last portfolio save.

### Known Issues / Improvement Notes

Issues identified from call log audit (2026-06-03). Issues 1–3 fixed in Sprint 42; issue 4 fixed in hotfix a888eec.

#### ✅ 1. `max_tokens` too low — responses truncate (FIXED Sprint 42)
**Fix:** `_AGENT_MAX_TOKENS.portfolio` raised from `6000` to `8000` in `js/claude-client.js`.
With 24+ holdings + full dividend/earnings/risk/technicals blocks, the 6,000-token ceiling was regularly hit — truncated JSON caused unnecessary validator repair-loop retries. The 2026-06-03_14-57-37 audit call confirmed `out=6000` with `dataGaps` cut mid-entry.

#### ✅ 2. `unrealised_loss_large` applied below its own threshold (FIXED Sprint 42)
**Fix:** Added enforcement text immediately after the `unrealised_loss_large` definition in `ANALYSIS_SYSTEM_PROMPT` Section 2:
> `ENFORCEMENT: Do NOT assign unrealised_loss_large if the actual unrealised loss is < $500 AUD. Check Holdings block: unrealisedPnl for this ticker must be more negative than −$500.`
Previously observed on BXB (~$357), SHL (~$344), SGP (~$37) — all below the $500 threshold.

#### ✅ 3. priceRange / target / stopLoss identical on full SELL exits (FIXED Sprint 42)
**Fix:** Added SELL-specific semantics to ACTION DEFINITIONS in `ANALYSIS_SYSTEM_PROMPT`:
- `target` = price confirming the exit was correct (further decline, 5–15% below sell price)
- `stopLoss` = price invalidating the exit thesis (stock recovers past here — 3–5% ABOVE sell price; must be above `priceRange[1]`)
- Explicit instruction: "Do NOT set priceRange, target, and stopLoss to the same value."
Previously, full SELL recs (e.g. CSL SELL) set all three to the sell price (e.g. `[92.56,92.56]`, target=92.56, stopLoss=92.56), triggering the `stop-below-entry` validator rule (SELL stop must be above entry) and producing a zero-distance ATR floor calculation.

#### ✅ 4. Stale `currentPrice` in `portfolioJson` (FIXED hotfix a888eec)
**Fix:** `portfolioJson` in `analysis.js` now uses `livePrice = state.liveSignals[ticker]?.current_price ?? h.currentPrice` for all price-derived fields (`currentPrice`, `value`, `unrealisedPnl`, `unrealisedPnlPct`, `weight`). Previously `h.currentPrice` came directly from the portfolio state cache, which could lag the live signal price by minutes — causing SELL/TRIM `priceRange` to be anchored to a stale price. The force-refresh of live signals at Step 2 of `runAnalysis()` now meaningfully feeds into the prompt.

---

## 2. Macro Brief — `'macro'`

Two call sites with different system prompts and inputs.

### 2a. Auto daily brief (`analysis.js`)

**Trigger:** Once per trading day inside `runAnalysis()`, runs in parallel with signal fetch
**System prompt:** `MACRO_SYSTEM_PROMPT` (static, 1 sentence)
**Max tokens:** 3,000 (`_AGENT_MAX_TOKENS.macro`, raised from 1,000 after a truncation incident) · `noCache: true`

**System prompt:**
```
You are a macro analyst for Australian equity markets. Return ONLY valid JSON, no markdown.
Format: {"sentiment":"risk-on"|"risk-off","sentimentConf":0-1,"bullish":0-100,
         "analysis":"3 paragraph macro analysis covering overnight US/global moves,
                     key commodities, and ASX outlook",
         "keyDrivers":"2-3 sentence summary of key market drivers today"}
```
(The `analysis` paragraphs render on the Macro page; only `keyDrivers` + sentiment/bullish
are injected into the portfolio prompt.)

**User message:**
```
Provide current macro analysis for ASX morning brief. Today: {YYYY-MM-DD}.
Live market data: S&P500:{n}({pct}) | ASX200:{n}({pct}) | Gold:{n}({pct}) |
                  AUD/USD:{n} ({pct}) | VIX:{n} | Iron ore:{n}({pct}) |
                  Oil:{n}({pct}) | US10Y:{n}% | Copper:{n}({pct})
Return only JSON.
```

**Expected output:**
```json
{
  "sentiment":    "risk-on" | "risk-off" | "bullish" | "bearish",
  "sentimentConf": 0.82,
  "bullish":      68,
  "keyDrivers":   "RBA easing cycle intact..."
}
```

**Usage:** Merged into `state.macroData` and injected as `TODAY'S MACRO BRIEF` in the portfolio analysis user message (same run).

---

### 2b. Manual Macro page refresh (`pages/macro.js`)

**Trigger:** "Run AI Analysis" button on the Macro page
**System prompt:** Inline string (not cached; includes `analysis` + `keyDrivers` fields)
**Max tokens:** 3,000 (`_AGENT_MAX_TOKENS.macro`, raised from 1,000 after a truncation incident) · `noCache: true`

**Additional inputs vs 2a:**
- Polymarket prediction market probabilities (if `state.includePolymarket` enabled): appended as `| Prediction market probabilities (Manifold Markets): {label}:{n}%...`

**Expected output:**
```json
{
  "sentiment":    "risk-on" | "risk-off",
  "sentimentConf": 0.75,
  "bullish":      62,
  "analysis":     "Three paragraph written analysis...",
  "keyDrivers":   "Short summary of key drivers"
}
```

**Usage:** Displayed on the Macro page; `analysis` field rendered as prose. `bullish` and `sentiment` feed into regime classification.

---

## 3. Day Trade Portfolio Scan — `'dayTrade'`

> **⚠ Dormant prompt.** `runDayTradeAnalysis()` is **quantitative-only** — it calls `_dtBuildRecs()` which scores the 5-signal confluence stack deterministically. `callClaude('dayTrade', …)` and `buildDtSystemArray()` are defined and registered but never called. The system prompt below is the reference spec if the Claude AI phase is ever re-activated. Signal #4 in the live quant path (`_dtBuildRecs()`) uses the actual Fibonacci zone computation (Sprint 42).

**File:** `js/day-trading-analysis.js → runDayTradeAnalysis()`
**Trigger:** "Run Swing Scan" button on Day Trading page · max 4,000 output tokens

### Pre-filter (client-side, before the API call)

`_dtPreFilterWithStats()` applies four hard gates and discards tickers that fail:
- `F1 LIQUIDITY`: `adv_20 > minAdvAud` (default $1.5M)
- `F2 TREND`: `current_price ≥ sma_200` (or within 1.5% + `return_5d > 0`)
- `F3 REGIME`: `adx < maxAdx` (default 35) — mean-reversion fails in strong trends
- `F4 CATALYST`: no earnings within 5 trading days

Only passing tickers are sent to Claude.

### System prompt: `getDayTradeSystemPrompt()`

Returned by a function (not a constant) so it can embed `state.settings.brokerage` at call time.

**Strategy:** Orthogonal 5-signal confluence (each measures a different dimension):
- Signal #1 BB Reclaim (**MANDATORY**): `bb_pct_b ≤ 0.05`
- Signal #2 RSI Recovery: `rsi_14 < 40 AND return_5d > return_20d`
- Signal #3 Volume Z-Score: `volume_z_score > 1.50`
- Signal #4 Fibonacci Zone: `fib_50 ≤ current_price ≤ fib_618` where `fib_50 = low_60d + 0.50×(high_60d − low_60d)` and `fib_618 = low_60d + 0.618×(high_60d − low_60d)`. Fallback when `high_60d`/`low_60d` absent: `return_60d` between −20% and −5% *(Sprint 41)*
- Signal #5 OBV Divergence (bonus): `obv_trend = "rising"` while `return_5d < 0`

Minimum: Signal #1 + ≥2 of Signals #2–#5.

**Sizing:** `stop = entry − 2.5×ATR` (prompt instruction; quant engine recalculates with regime-aware `stopAtrMult×ATR`: 2.5× riskOn/trend/sideways · 3.0× highVol · 3.5× riskOff · 4.0× panic) · `qty = floor(riskPerTrade / stop_distance)` · max 20% of allocatedCash · R:R ≥ 2.0

**User message (per ticker, after pre-filter):**
```
Swing allocation: ${allocatedCash} | riskPerTrade: ${riskPerTrade}
Open positions: [{ticker, qty, entryPrice, currentPnl}]
Pending recs: [{ticker, action, priceRange, status}]
Signals for passing tickers:
  {TICKER}: {full indicator block — same fields as portfolio analysis}
```

**Expected output:**
```json
{
  "recs": [{
    "ticker":     "BHP",
    "action":     "BUY",
    "priceRange": [44.20, 44.80],
    "target":     49.50,
    "stopLoss":   42.10,
    "qty":        50,
    "confidence": 0.60,
    "holdDays":   10,
    "signalsHit": ["BB Primary", "RSI Recovery", "Vol Z-Score"],
    "filtersPass":{"liquidityOk":true,"aboveSMA200":true,"adxOk":true,"noCatalyst":true},
    "reasoning":  "≤100 chars",
    "stopReason": "≤80 chars",
    "riskAUD":    150,
    "rewardAUD":  340,
    "rrRatio":    2.27
  }],
  "summary": "≤150 chars"
}
```

**Post-processing:** Quant engine recalculates sizing; `applyRegimeModifiers()` applies modifiers.

---

## 4. Day Trade Universe Scan — `'universe'`

> **⚠ Dormant prompt.** Same as §3 — `runUniverseScan()` is quantitative-only. `callClaude('universe', …)` is registered in `claude-client.js` but never called.

**File:** `js/day-trading-analysis.js → runUniverseScan()`
**Trigger:** "Scan Universe" button · max 4,000 output tokens
**System prompt:** `getDayTradeUniverseScanPrompt()` — leaner variant of the day trade prompt for bulk scanning

**Difference from `'dayTrade'`:** The universe scan processes up to 200 ASX tickers (asx20/50/100/200 universe, selectable) in batches through the client-side pre-filter, then sends only passing tickers to Claude. The system prompt is simplified — no open-position context, focused purely on signal-stack confirmation.

**Output schema:** Same as `'dayTrade'` with identical fields. Post-processed identically.

---

## 5–6. Analyst / Portfolio Manager — REMOVED

The 3-phase Analyst → Quant Engine → PM pipeline that older versions of this doc described as "dormant but ready to activate" no longer exists in the codebase at all — this isn't a currently-dormant feature, it was cut. `ANALYST_SYSTEM_PROMPT`, `PM_SYSTEM_PROMPT`, and the `'analyst'`/`'pm'` agent types do not appear anywhere in `js/`. `_resolveSystemPrompt()` (`js/claude-client.js`) only resolves `portfolio`, `macro`, `dayTrade`, `universe`, `assistant`. `callClaude('analyst', ...)` or `callClaude('pm', ...)` will silently fall through to an empty system prompt. If a multi-phase analyst/PM split is wanted again, it needs to be designed and built fresh — nothing here is salvageable scaffolding.

---

## 7. Assistant — `'assistant'`

Two distinct call sites with different system prompts, both `noCache: true`.

### 7a. Chat interface (`pages/assistant.js`)

**Trigger:** User sends a message in the Assistant chat tab
**Max tokens:** 1,200 · multi-turn (full `messages` array passed)

**System prompt (dynamic, built per call):**
```
You are an expert ASX quantitative analyst and trading coach...

PORTFOLIO CONTEXT ({date in AEST}):
Portfolio value: ${n} | Net worth: ${n} | Unrealised P&L: {±${n}} ({±n}%)
Cash: ${n} | RBA: {n}% | Brokerage: ${n}/trade | Max trades/day: {n}

Holdings:
  {TICKER}: {shares}sh @ avg${n} → now ${n} | {±n}% | Sector: {s}

{LIVE INDICATORS (subset per ticker)} — rsi_14, bb_pct_b, adx, atr_14, sma_200,
  return_5d, return_20d, obv_trend, volume_ratio, current_price

{ANNOUNCEMENTS (last 3d per holding)}
{PENDING RECS}
{RECENT NEWS}
{REGIME}

RESPONSE FRAMEWORK:
• Indicators: interpret in context, cross-reference ≥3
• Trade setups: entry range, target, stop (ATR-based), position size, R:R ≥ 2:1
• Portfolio: sector concentration, correlation, cash deployment
• Dividends: income, yield-on-cost, ex-div timing
• Risk: quantify downside in dollars
• Always cite actual indicator values; never invent numbers
```

**Expected output:** Free-form plain text response (no JSON). Multi-turn conversation history maintained in `state.chatHistory`.

### 7b. Learning postmortem digest (`pages/learning.js`)

**Trigger:** "Generate Digest" button on the Learning page
**Max tokens:** 600 · single-turn · `noCache: true`

**System prompt:** None (uses `ASSISTANT_SYSTEM_PROMPT` resolved by `_resolveSystemPrompt`)

**User message:**
```
You are reviewing my ASX trading learning loop. Here is a summary of my recent performance:

Overall win rate: {n}% ({total} closed trades)
Error type distribution: {tag: count, ...}
Exit reason distribution: {reason: count, ...}
Regime performance: {regime: {wins/total/wr}, ...}

Recent losses/breakevens (up to 10):
  {date} {action} {ticker} conf={n}% outcome={o} pnl=${n} error={tags} [{rationale}]

Please write a concise postmortem digest (under 250 words) in plain text:
1. The 1-2 most recurring failure patterns you see
2. One or two specific adjustments I should make
3. The regime(s) where performance is weakest and what that suggests
```

**Expected output:** Plain text digest under 250 words. Stored in `state.digestHistory`.

---

## 8. Morning Briefing — REMOVED

`generateMorningBrief()`, `MORNING_BRIEFING_SYSTEM_PROMPT`, and the `'briefing'` agent type described here in older versions of this doc do not exist anywhere in the current codebase (verified by grep across `js/`) — same status as §5–6. If it's wanted back, it needs rebuilding, not "re-enabling."

---

## 9. Local LLM — `'portfolio'` via Ollama fast-path *(Sprint 41)*

**File:** `js/claude-client.js → _callLocalAnalysis()` · `routes/debate.py → quick_analysis()`
**Trigger:** Same "Run Analysis" button; fast-path activates when `state.settings.useLocalLLM = true`
**Toggled by:** Settings → Display → "Use local LLM for analysis" checkbox

### How it works

`callClaude()` checks `agentType === 'portfolio' && state.settings.useLocalLLM` **before** any API key resolution. If true, it calls `_callLocalAnalysis(userMessage)` which POSTs to `POST /api/debate/quick-analysis` instead of the Anthropic API.

The backend (`routes/debate.py`) prepends `_LOCAL_ANALYSIS_SYSTEM` (a stripped-down rule set) to the first 4000 chars of the assembled user message, calls `_call_ollama()` with `_SCHEMA_QUICK_ANALYSIS` structured output, tags each rec with `_source: 'local'`, and returns `{ ok, text: JSON_string, model, elapsed_ms }`.

`_callLocalAnalysis()` returns `{ text, usage: { local: true, model, elapsed_ms } }` — the same shape as `callClaude()` — so `analysis.js` is transparent to the routing.

### Key constraints

**SELL/TRIM is supported** (this was a documented future-enhancement in older versions of this doc — it has since shipped) with a simplified 5-driver taxonomy, not the full Claude-path taxonomy:

| Constraint | Reason |
|---|---|
| Actions: BUY / TOP_UP / HOLD / SELL / TRIM, 1–4 recs max | SELL/TRIM use a **5-driver** taxonomy — `thesis_broken`, `stop_triggered`, `target_reached`, `time_stop`, `risk_management` — a deliberately narrower set than the Claude path's 9-value `primary_driver` enum, since small models produce the wider tagging inconsistently. `primary_driver` + `urgency` (`immediate`/`routine`/`monitor`) are required on SELL/TRIM, omitted on BUY/TOP_UP. |
| Stop direction validated post-response | For SELL/TRIM, `stopLoss` must be ABOVE `priceRange[1]` (exit-invalidation frame); if the model returns it below entry, the backend corrects it to `entry × 1.03` rather than trusting the raw value. |
| §9.5 size escalation | A local SELL/TRIM touching a holding > 10% of portfolio value discards the local result and re-routes the run to Claude (`_localExitOnLargePosition` in `claude-client.js`); a keyless local-only install keeps the local result with a loud warning toast instead. |
| Context truncated to **6000 chars** (not 4000) | Raised alongside indicator tiering (~30–40% smaller messages) to give headroom for exit-decision context — holdings state, unrealised P&L, stop levels — that SELL/TRIM support needs. Truncation keeps the most critical context (date, regime, holdings, top signals) first. |
| No calibration injection | Calibration nudges assume Claude-level instruction following; small models may ignore or invert them. |
| `🔒 Local` badge on rec cards | `_source === 'local'` triggers amber badge in `recommendations.js` so the user sees which recs came from Ollama. |
| Validator + quant engine still run | Ollama output flows through the same `analysis.js` post-processing as the Claude path: `validateRec()` local fix-or-drop + `computeTradeParams()`. No network repair loop in either path. |
| `ai_call_log` written by backend | `routes/debate.py` writes to `ai_call_log` with `agent_type='portfolio:local'` after each Ollama response. `callClaude()` client-side logging block is still bypassed (fast-path returns before it). Browsable via `GET /api/log/ai_calls?agent_type=portfolio:local` |

### System prompt (`_LOCAL_ANALYSIS_SYSTEM`, `routes/debate.py`)

```
You are a conservative ASX equity analyst. Analyse the portfolio context and output
structured trading recommendations as JSON.

=== ACTIONS ===
BUY      — new position (watchlist entry or entirely new holding)
TOP_UP   — add to an EXISTING holding that is underweight with a strong thesis
HOLD     — keep existing holding, no change needed (use confidence=0)
SELL     — close a FULL existing position (multi-factor deterioration)
TRIM     — reduce an existing holding by 25–50% (overweight or thesis weakening)

=== ENTRY RULES (BUY / TOP_UP) ===
- priceRange: [lo, hi] — limit entry range
- target: ABOVE priceRange[1] — where thesis is proven
- stopLoss: BELOW priceRange[0] — where thesis is wrong
- confidence: 0.62 minimum. 0.70 = moderate conviction, 0.80 = strong.
- Only recommend when ≥ 2 independent factors align (earnings, macro, valuation, technicals).

=== EXIT RULES (SELL / TRIM) ===
- priceRange: [lo, hi] — limit sell range near current price
- target: BELOW priceRange[0] — price that confirms the exit was correct (further decline)
- stopLoss: ABOVE priceRange[1] — price that would INVALIDATE the exit thesis (stock recovers)
- primary_driver (required — one of): thesis_broken, stop_triggered, target_reached,
  time_stop, risk_management
- urgency (required): immediate | routine | monitor
- confidence: 0.62 minimum for SELL/TRIM. Use 0 for HOLD.

=== OUTPUT RULES ===
- Output 1–4 recommendations maximum. Prefer HOLD when uncertain.
- qty is NOT required — the quant engine calculates it after your response.
- Output only the JSON object. No preamble, no markdown fences.
```

---

## Data Fields Reference

### What `analysis.js` guarantees to provide per run

| Category | Fields | Source |
|---|---|---|
| **Account** | brokerage, maxTradesPerDay, minTradeSize, rbaRate, cash, portfolioValue | `state.settings`, `state.cash` |
| **Context flags** | TAX_LOSS_HARVEST_ACTIVE, date/time | Computed from date |
| **Macro** | sentiment, bullish, keyDrivers, iron_ore, oil, copper, us10y, asx200_5d_return, sectors{} | `/api/macro` |
| **Holdings** | ticker, sector, shares, avgPrice, currentPrice, value, unrealisedPnl, daysHeld, weight | `mergedPortfolio()` |
| **Rec history** | Last 5 + 3 with P&L + 2 with feedback | `state.recHistory` |
| **Calibration** | Compact calibration block (≤400 chars, budget-gated) | `/api/learning/calibration` |
| **Lessons** | Scoped trading lessons (≤4, ~15–25 tokens each) | `/api/learning/lessons` |
| **News** | LLM-classified articles, last 3 days | `/api/news/brief` |
| **Announcements** | ASX filings, last 3 days | `/api/announcements/brief` |
| **Dividends** | Yield, ex-div date, payout ratio, history | `/api/dividends` |
| **Earnings** | Next date + EPS beat/miss history (4Q) | `/api/earnings-calendar` |
| **Risk metrics** | Per-ticker VaR/CVaR/MaxDD/Beta/Sharpe + portfolio composite | `/api/risk` |
| **Signals** | Full indicator pack per ticker (Sprint 32: 30+ fields) | `/api/analyse/batch` |
| **Sector allocation** | Portfolio sector weights (%) | Computed from holdings |
| **Debate** | Ollama bull/bear synthesis (if Ollama enabled) | `/api/debate` |
| **Regime** | Active regime + confidence | `fetchAndClassifyRegime()` |

### Fields the system prompt references that require verification

| Field referenced in prompt | Provided? | Notes |
|---|---|---|
| `nextEarningsDate` | ✅ when available | Via `/api/earnings-calendar`; yfinance coverage varies |
| `frankingPct` | ⚠️ partial | In `dividendData`; default 0% when absent (conservative) |
| `volume_avg_20` | ✅ | In signals payload |
| `Sharpe (90d)` | ✅ | In risk metrics block from `/api/risk` |
| `MaxDD90d` | ✅ | In risk metrics block |
| `composite risk score` | ✅ | Computed in `analysis.js` from risk metrics |
| `rs_5d_alpha` | ✅ (Sprint 32) | Derived: `return_5d − asx200_5d_return` |
| `eps_revision_30d` | ❌ | Not in yfinance; referenced in Priority 1 but must be inferred from beat/miss history |
| `bid-ask spread` | ❌ | Not provided; spread rule only fires from live data during market hours |
| `high_60d / low_60d` | ✅ *(Sprint 41)* | Emitted by `indicators.py` `analyse_ticker()`; 60-bar max/min of OHLCV `high`/`low` Series. `None` when < 60 bars. Used by Signal #4 for exact Fibonacci levels; `return_60d` remains the fallback when absent |

### Fields not sent despite being available

These exist in `state.liveSignals[t]` but are not currently included in any prompt context:

| Field | Reason not sent |
|---|---|
| `roa` | Low incremental value vs ROE already sent |
| `current_ratio` | Sector-specific relevance; noise for general analysis |
| `macd_line / macd_signal` | Histogram + direction already sent; line/signal redundant |
| `ema_50` | SMA50 already sent; EMA50 adds marginal information |
| `donchian_upper / lower` (raw) | Replaced by derived `DonchPos` percentage |
| `pct_from_52w_low` | 52W high and FromHigh already sent; low adds marginal context |

---

## Prompt Versioning

`PROMPT_VERSION` is currently `'2026-07-v24'` in `js/prompts.js` — check the constant directly, this doc's version-history table below has not been kept current (it stops at v11; thirteen versions of changes since then are undocumented here).

Increment this constant whenever `ANALYSIS_SYSTEM_PROMPT` changes materially. The version is:
- Stored on every `ai_learning_events` row at log time
- Shown in the Learning page Prompt Versions table with Δ vs prior version hit rate
- Monitored by `_check_prompt_regression()` in `routes/learning.py` for automated regression detection

**Version history (stale beyond v11 — see note above):**
| Version | Key changes |
|---|---|
| `2026-06-v11` | Sprint 67 (§9.3): CorrToHoldings line in each ticker's indicator block (top |ρ| ≥ 0.60 vs holdings, incl. watchlist candidates); Section 3 CORRELATION rule — ρ ≥ 0.70 = concentration, thesis must be explicitly orthogonal and cited in factorsUsed[]; explicit ban on numeric confidence/qty adjustment for correlation (engine sizes deterministically) |
| `2026-06-v10` | Sprint 61 (§8.2 + §8.3): Section 7 cash test rewritten qty-free (min-trade-size notional — Rule 4 zeroes qty, so qty-based formulas were incoherent); SELL/TRIM netProfit derives sharesToExit from the Holdings block; Section 6 calibration is now CONTEXT-ONLY — the engine applies band/per-ticker adjustments deterministically post-response (`window._calibAdjustments` → analysis.js, before Kelly sizing); learning events log the original (pre-adjustment) confidence |
| `2026-06-v9` | Sprint 58: ACTION DEFINITIONS aligned with Rule 4 (TOP_UP/SELL/TRIM all state qty stays 0); TRIM definition documents that the quant engine trims by the weightGuidance Reduce-range midpoint — weightGuidance is now load-bearing for TRIM sizing |
| `2026-06-v8` | Sprint 47: Rule 3 stop ATR changed from hardcoded 1.5× to regime-aware stopAtrMultiple from ACTIVE RULE OVERRIDES; Rule 4 instructs Claude to set qty=0 (quant engine sizes); scenarios field made optional; ACTIVE_REGIME moved to top of user message (line 3); rulesCtx moved before indicatorCtx |
| `2026-06-v7` | Sprint 42: `unrealised_loss_large` enforcement line (≥$500 AUD check against Holdings `unrealisedPnl`); SELL/TRIM exit stop/target semantics (stop = invalidation level above sell price; target = confirmation level below sell price; explicit ban on all-three-same-value) |
| `2026-06-v6` | Rule 17 renumbered (was duplicate Rule 16); SELL_TAG calibration injection rules (Section 6); sell tag urgency/monitor enforcement. Sprint 42 user-message additions: `Range60d: hi=${n} lo=${n}` in Returns line; optional `Account: {PERSONAL\|SUPER\|TRADING}` in date header |
| `2026-05-v5` | Calibration algorithm in prompt; debate-block usage rule; Stage 3–4 |
| `2026-05-v4` | Sprint 23: ESS gates; Ollama structured outputs |
| `2026-05-v3` | Sprint 22: adversarial debate + cloud adjudicator |
| `2026-05-v2` | Stage 1–2: entry_signals_json; direction-aware postmortem |
| `2026-05-v1` | Initial system prompt with hard rules + output schema |

---

## Known Gaps (prompt references data that may be absent)

1. ~~**`eps_revision_30d`**~~ ✅ **Fixed (already in place)** — Priority 1 already explicitly states "This is a PROXY for revision direction, not true 30-day analyst consensus revision data (which is unavailable from yfinance)". No code change needed. See Plan C in `learning_loop.md`.

2. **`bid-ask spread`** — Rule 5 execution says "if bid-ask spread > 0.5%, flag wide spread". Spread is not in the signals payload (yfinance doesn't reliably provide it for ASX). Rule effectively never fires from data; Claude must infer from liquidity signals. **No fix available** without a real-time market data feed.

3. ~~**`high_60d / low_60d`**~~ ✅ **Fixed Sprint 41** — `indicators.py` now emits `high_60d`/`low_60d` (60-bar max/min). Signal #4 in both day-trade prompts updated to use actual Fib retracement levels; `return_60d` kept as fallback. See Plan B in `learning_loop.md`.

4. ~~**Duplicate Rule 16**~~ ✅ **Fixed** — Rule 17 (`RISK-REWARD CONTEXT`) correctly renumbered in `ANALYSIS_SYSTEM_PROMPT`. Version bumped to v6.

5. ~~**`monitor` urgency for SELL**~~ ✅ **Fixed** — `validateSellTags()` in `response-validator.js` line 89 rejects `SELL + urgency:monitor` with an explicit error. The forbidden combination is also listed in `ANALYSIS_SYSTEM_PROMPT` Section 2. No further action needed.

6. ~~**Stale `currentPrice` in `portfolioJson`**~~ ✅ **Fixed hotfix a888eec** — `portfolioJson` in `analysis.js` now uses `livePrice = state.liveSignals[ticker]?.current_price ?? h.currentPrice` for all price-derived fields. Fixes SELL/TRIM `priceRange` anchoring to a stale cached price instead of the just-refreshed signal price. See Known Issue #4 in Section 1.

---

## Implementation Plans — All Shipped Sprint 41

### ✅ Plan A: Regime-aware SELL/TRIM stop floor
`analysis.js` Step 3 reads `regimeMod.stopAtrMult ?? 2.5` from `getRegimeModifiers()`. Rec flagged `_stopRepaired: true` + `_stopRepairedMult: N`. *(Sprint 41)*

### ✅ Plan B: `high_60d` / `low_60d` for Fibonacci
`indicators.py` emits both fields. Signal #4 in both day-trade prompts uses `fib_50`/`fib_618` = `low_60d + 0.50/0.618×(high_60d − low_60d)`, with `return_60d` fallback when absent. *(Sprint 41)*

### ✅ Plan C: Formalise `eps_revision_30d` proxy in Priority 1
Already in place — Priority 1 text explicitly documents EPSvEst(4Q) as the proxy and states the 30d revision field is unavailable from yfinance. No code change needed. *(Pre-Sprint 41)*
