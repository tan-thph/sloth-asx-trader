# Sloth ASX Trader — Bug Fixes

Specific issues identified in `js/strategy.js` and `js/prompts.js`, with proposed fixes. All issues are independent and can be applied in any order.

---

## 1. `strategy.js` — ADX Filter Logic Gap

**File:** `js/strategy.js`
**Function:** `_dtPreFilter()`
**Severity:** Medium — causes false positives in the pre-filter

### Problem

The regime filter requires all three conditions simultaneously:

```js
// Current — too permissive
if ((s.adx ?? 0) > DT_FILTER.maxAdx && s.trend_strength === 'strong' && (s.return_5d ?? 0) > 0) return false;
```

A stock with ADX of 40 and a flat or negative `return_5d` slips through even though it's in a strong trend. The intent is to skip stocks already in a strong rip, but the third condition weakens the filter significantly.

### Fix

Remove the `return_5d > 0` guard. ADX alone is sufficient — if it's above the ceiling, the stock is trending strongly regardless of recent 5-day direction:

```js
// Fixed — ADX ceiling is the gate; trend_strength adds specificity
if ((s.adx ?? 0) > DT_FILTER.maxAdx && s.trend_strength === 'strong') return false;
```

If you want to preserve the intent of only filtering uptrends (to avoid blocking a strong downtrend that's reversing), be explicit:

```js
// More precise — skip only strong uptrending stocks
if ((s.adx ?? 0) > DT_FILTER.maxAdx && s.trend_strength === 'strong' && s.di_plus > s.di_minus) return false;
```

---

## 2. `strategy.js` — SMA200 Fallback to SMA50 is Silently Asymmetric

**File:** `js/strategy.js`
**Function:** `_dtPreFilter()`
**Severity:** Low — unintended leniency for newer/smaller stocks

### Problem

```js
const ref = s.sma_200 ?? s.sma_50;
if (ref && s.current_price < ref * DT_FILTER.sma200Floor) return false;
```

When `sma_200` is unavailable (stock listed < 200 days), the code silently falls back to `sma_50`. SMA50 is much closer to the current price, so `sma_50 × 0.985` is a far weaker floor than `sma_200 × 0.985`. Stocks with no long-term trend history get an easier pass.

### Fix

**Option A — document the leniency** (if intentional):

```js
// SMA200 preferred; SMA50 used for stocks < 200 days old.
// Note: SMA50 fallback is intentionally more lenient — newer listings
// won't have a 200-day history but are still valid candidates.
const ref = s.sma_200 ?? s.sma_50;
if (ref && s.current_price < ref * DT_FILTER.sma200Floor) return false;
```

**Option B — hard requirement** (reject stocks without SMA200):

```js
// Hard requirement: SMA200 must exist; reject stocks with < 200 days history
if (!s.sma_200) return false;
if (s.current_price < s.sma_200 * DT_FILTER.sma200Floor) return false;
```

**Option C — calibrated SMA50 multiplier** (separate threshold for fallback):

```js
const ref = s.sma_200 ?? s.sma_50;
const floor = s.sma_200 ? DT_FILTER.sma200Floor : DT_FILTER.sma50Floor; // e.g. 0.95 for SMA50
if (ref && s.current_price < ref * floor) return false;
```

Pick based on whether you want to include newer listings (A or C) or exclude them (B).

---

## 3. `strategy.js` — Misleading Config Object: AI-Phase Params Mixed with Pre-Filter Params

**File:** `js/strategy.js`
**Severity:** Low — developer confusion risk

### Problem

`DT_FILTER` contains values not used by `_dtPreFilter()` at all:

```js
const DT_FILTER = {
  maxBbPctB:       0.20,
  minAdvAud:       1_500_000,
  sma200Floor:     0.985,
  maxAdx:          35,
  minRrRatio:      2.0,     // ← used by AI prompt, not pre-filter
  minConfidence:   0.50,    // ← used by AI prompt, not pre-filter
  stopAtrMultiple: 2.5,     // ← used by AI prompt, not pre-filter
};
```

Anyone reading `_dtPreFilter()` would expect all `DT_FILTER` keys to be used there. The mixing can cause a maintainer to incorrectly assume changing `minRrRatio` here affects filtering.

### Fix

Split into two clearly named config objects:

```js
// Pre-filter thresholds — applied client-side before the AI sees the tickers
const DT_FILTER = {
  maxBbPctB:   0.20,
  minAdvAud:   1_500_000,
  sma200Floor: 0.985,
  maxAdx:      35,
};

// AI-phase parameters — read by the prompt builder and downstream logic
const DT_AI_PARAMS = {
  minRrRatio:      2.0,
  minConfidence:   0.50,
  stopAtrMultiple: 2.5,
};
```

Update any references in `day-trading-analysis.js` accordingly (e.g. anywhere that reads `DT_FILTER.minRrRatio` becomes `DT_AI_PARAMS.minRrRatio`).

---

## 4. `prompts.js` — Tax-Loss Harvesting Date Logic Baked Into Static Prompt

**File:** `js/prompts.js`
**Section:** `ANALYSIS_SYSTEM_PROMPT` — Section 4
**Severity:** Medium — rule silently never fires if date not injected

### Problem

Section 4 of `ANALYSIS_SYSTEM_PROMPT` contains:

```
TAX-LOSS HARVESTING (May 1 – Jun 30 only):
Scan holdings for unrealised loss > $500...
```

The system prompt is static and the AI has no access to the current date unless it's injected in the user message. If `analysis.js` doesn't include today's date in the user message payload, the AI cannot evaluate whether it's in the harvest window — and will either ignore the rule or hallucinate a date.

### Fix

Ensure `analysis.js` injects the current date into every user message:

```js
// In analysis.js — buildUserMessage() or equivalent
const today = new Date().toLocaleDateString('en-AU', {
  day: '2-digit', month: 'long', year: 'numeric'
});

// Add to user message header
`TODAY: ${today}\n\n...rest of payload`
```

Better — compute the window client-side and inject the boolean explicitly so the AI doesn't have to infer it:

```js
const now = new Date();
const month = now.getMonth() + 1; // 1-indexed
const inHarvestWindow = month >= 5 && month <= 6;

// Inject into user message
`TODAY: ${now.toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' })}
TAX_LOSS_HARVEST_ACTIVE: ${inHarvestWindow}`
```

This removes ambiguity. The system prompt rule can then simply check `if TAX_LOSS_HARVEST_ACTIVE = true` instead of trying to parse a date.

---

## 5. `prompts.js` — Liquidity Check Comment Has Units Mismatch

**File:** `js/prompts.js`
**Section:** `ANALYSIS_SYSTEM_PROMPT` — Section 5
**Severity:** Low — can cause the AI to compute the check incorrectly

### Problem

```
LIQUIDITY: qty × currentPrice must be ≤ 5% of the ticker's 20-day average daily dollar turnover
(volume_avg_20 × currentPrice)
```

The comment says "average daily dollar turnover" which implies `volume_avg_20 × currentPrice`. But `volume_avg_20` from yfinance is a **share count**, not a dollar value. Multiplying by `currentPrice` to get dollar turnover is correct — but the check as written computes `qty × currentPrice ≤ 5% of (volume_avg_20 × currentPrice)`, which simplifies to `qty ≤ 5% of volume_avg_20`. The `currentPrice` terms cancel. The arithmetic is fine but the comment is wrong, which could cause the AI to attempt the wrong calculation.

### Fix

Rewrite the prompt text to be explicit about both forms:

```
LIQUIDITY: qty must be ≤ 5% of volume_avg_20 (20-day average daily share volume).
Equivalent dollar check: qty × entryPrice ≤ 5% of (volume_avg_20 × currentPrice).
If this is exceeded, reduce qty or split into tranches across multiple sessions.
```

This makes the units explicit and gives the AI a clear path to the correct calculation.

---

## 6. `prompts.js` — `confidence` Definition Inconsistent Across Day Trade Prompts

**File:** `js/prompts.js`
**Functions:** `getDayTradeSystemPrompt()` and `getDayTradeUniverseScanPrompt()`
**Severity:** Low — scores not comparable if displayed side by side

### Problem

`getDayTradeSystemPrompt()` defines confidence as:

```
"confidence": number (signals_hit out of 5, expressed as fraction: 3/5=0.60 min to output)
```

`getDayTradeUniverseScanPrompt()` defines it as just:

```
"confidence": number
```

If both prompts' results are ever merged or compared in the UI, the scores from the universe scan are undefined-scale while portfolio scan scores are signals-based.

### Fix

Align the universe scan prompt to use the same definition:

```js
// In getDayTradeUniverseScanPrompt output format definition:
"confidence": number (signals_hit / 5 — minimum 0.60 to output a rec)
```

This is also a strong argument for extracting a shared signal block constant (covered in the main IMPROVEMENTS.md doc, section 2.2) so the two prompts can't drift like this again.

---

## Summary

| # | File | Issue | Severity | Effort |
|---|------|-------|----------|--------|
| 1 | `strategy.js` | ADX filter too permissive — `return_5d` guard defeats the regime check | Medium | Low |
| 2 | `strategy.js` | SMA50 fallback is silently weaker than SMA200 — undocumented leniency | Low | Low |
| 3 | `strategy.js` | AI-phase params mixed into pre-filter config object | Low | Low |
| 4 | `prompts.js` | Tax-loss harvest window rule requires date injection that may be missing | Medium | Low |
| 5 | `prompts.js` | Liquidity check comment describes wrong units (dollar vs share volume) | Low | Low |
| 6 | `prompts.js` | `confidence` defined differently in two day-trade prompts | Low | Low |

All six fixes are small, targeted edits. They can all be applied in a single session with no architectural impact and no risk to the rest of the codebase. Recommended as a Phase 1 pass before tackling the broader improvements in IMPROVEMENTS.md.
