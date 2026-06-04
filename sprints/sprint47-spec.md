# Sprint 47 — Prompt & Data Pipeline Quality

Work in /home/tanth/projects/sloth-asx-trader.
Primary files: `js/analysis.js`, `js/prompts.js`.
No backend changes. No DB migrations. No new routes.
Run `python test_app.py` and `npm run test:js` and the JS syntax check after all changes.

Read `js/analysis.js`, `js/prompts.js`, `js/claude-client.js`, and `js/prompt-modules.js` IN FULL
before making any changes. Understand the existing structure before touching anything.

---

## Fix 1 — maxTokens override (1 line)

**File:** `js/analysis.js`

Find the `callClaude('portfolio', fullUserMessage, { ... })` call.
It passes `maxTokens: 6000` explicitly, overriding the global `_AGENT_MAX_TOKENS.portfolio = 8000`
set in claude-client.js. Change to `maxTokens: 8000`.

That's the entire fix — one number change.

---

## Fix 2 — Inject ACTIVE_REGIME at top of user message

**File:** `js/analysis.js`

**Problem:** `regimeCtx` is currently appended at the very end of `fullUserMessage` (after 7,000+
chars of indicator data). Claude encounters the regime gate last, after forming partial conviction
on trades.

**Fix:** Move the regime line to immediately after the date/account/RBA header in the user message
string — before Holdings.

Find the `userMessage` template literal. It currently starts like:
```
Date: ${todayStr()} | Time: ${nowSydney()} | TAX_LOSS_HARVEST_ACTIVE: ${inHarvestWindow}${_acctLabel}
Account settings: ...
LIVE PORTFOLIO STATE:
Holdings: ...
```

Change it so the regime is the THIRD line (inserted after account settings, before Holdings):
```
Date: ${todayStr()} | Time: ${nowSydney()} | TAX_LOSS_HARVEST_ACTIVE: ${inHarvestWindow}${_acctLabel}
Account settings: brokerage $... | max ... trades/day | min trade $...
ACTIVE_REGIME: __REGIME_PLACEHOLDER__ (confidence: __CONF_PLACEHOLDER__)
LIVE PORTFOLIO STATE:
Holdings: ...
```

Then in the `fullUserMessage` assembly (after `fetchAndClassifyRegime()`), replace the placeholders:
```js
const fullUserMessage = userMessage
  .replace('__REGIME_PLACEHOLDER__', _activeRegime || 'unknown')
  .replace('__CONF_PLACEHOLDER__', ((_regimeResult.confidence ?? 0) * 100).toFixed(0) + '%')
  .replace('__CALIBRATION_PLACEHOLDER__', _calibrationNote + _lessonsBlock)
  + _debatePreamble;
```

IMPORTANT: Remove `regimeCtx` from the end of `fullUserMessage`. The regime transition note
(`[TRANSITION: riskOn→riskOff Nd ago — ...]`) should be appended to the `__REGIME_PLACEHOLDER__`
replacement string, not at the end:
```js
const regimeLine = _activeRegime && _activeRegime !== 'unknown'
  ? `${_activeRegime}${_regimeTransitionNote}`
  : 'unknown';
```

The `_regimeTransitionNote` logic (built from `state.regimeChangedAt`) stays exactly as-is —
just inline it into the placeholder replacement instead of the end-append.

---

## Fix 3 — Align stop ATR in system prompt with regime engine

**File:** `js/prompts.js` and `js/analysis.js`

**Problem:** Rule 3 in `ANALYSIS_SYSTEM_PROMPT` says "Stop-loss at 1.5×ATR(14) below entry."
The quant engine uses `regimeMod.stopAtrMult` (2.5–4.0×). Claude's R:R calculation uses the
wrong stop distance, so its R:R gate is meaningless.

**Fix part A — prompts.js:**
Change Rule 3 from:
```
3. RISK/REWARD: Only recommend trades with R:R ≥ 2:1. Stop-loss at 1.5×ATR(14) below entry.
```
to:
```
3. RISK/REWARD: Only recommend trades with R:R ≥ 2:1. Stop-loss at stopAtrMultiple×ATR(14)
   below entry (BUY) or above entry (SELL/TRIM). The stopAtrMultiple is in ACTIVE RULE OVERRIDES
   in the user message — use that value, not a fixed 1.5×.
```

**Fix part B — analysis.js:**
The `rulesCtx` block already contains `Stop ATR: ${_r.stopAtrMultiple ?? def.stopAtrMultiple}×ATR14`
which defaults to 1.5 from user config. Update this to inject the REGIME-AWARE value instead:

Find the line that reads:
```js
`Min confidence: ${_r.minConfidence ?? def.minConfidence} | Min R:R: ${_r.minRrRatio ?? def.minRrRatio}:1 | Stop ATR: ${_r.stopAtrMultiple ?? def.stopAtrMultiple}×ATR14`,
```

Change to inject the regime-aware stop multiple. After `fetchAndClassifyRegime()` is called,
`state.currentRegime.regime` is set. Add a helper to read the regime modifier:
```js
// Get regime-aware stop multiple for R:R guidance
const _regimeStopMult = (() => {
  if (typeof getRegimeModifiers === 'function' && _activeRegime) {
    return getRegimeModifiers(_activeRegime).stopAtrMult ?? 2.5;
  }
  return _r.stopAtrMultiple ?? def.stopAtrMultiple;
})();
```

IMPORTANT: `rulesCtx` is built BEFORE `fetchAndClassifyRegime()` is called (it's built as part
of the static `userMessage` template). You need to either:
a) Build `rulesCtx` after `fetchAndClassifyRegime()`, OR
b) Use a placeholder in the static template and replace it after regime is known (like Fix 2).

Use approach (b): add `__STOP_MULT_PLACEHOLDER__` in the rulesCtx first line, then replace it
in the `fullUserMessage` assembly alongside the other placeholder replacements.

---

## Fix 4 — Tell Claude its qty will be overridden

**File:** `js/prompts.js`

**Problem:** Rule 4 asks Claude to compute position size. Section 7 pre-flight check (b) asks
Claude to verify cash coverage. The quant engine replaces Claude's qty entirely. Claude wastes
tokens on arithmetic that's discarded, and check (b) tests a value never used.

**Fix part A — Rule 4:**
Change from:
```
4. POSITION SIZING: qty = floor(min(cash × 0.15, portfolioValue × 0.15) / entryPrice).
   Never exceed 15% single-position weight.
```
to:
```
4. POSITION SIZING: Set qty = 0 in your output. Position sizing is computed deterministically
   by the quant engine after your response using Kelly + volatility scalar + multi-constraint
   (account-risk %, max-position %, liquidity). Never exceed 15% single-position weight —
   the engine enforces this hard. Your job is conviction (confidence ≥ 0.62), direction
   (priceRange, target, stopLoss), and SELL/TRIM tagging. Do not attempt to compute qty.
```

**Fix part B — Section 7 pre-flight check (b):**
Change from:
```
(b) Sum of (qty × entryPrice) for all BUY/TOP_UP recs ≤ available cash.
```
to:
```
(b) SKIP — qty is set to 0; cash feasibility is enforced by the quant engine post-response.
```

**Fix part C — Output schema:**
In Section 8 output schema, change the `qty` field description from `number` to:
```
"qty": 0,   // always 0 — quant engine sets final qty; your value is ignored
```

---

## Fix 5 — Indicator block tiering

**File:** `js/analysis.js`

**Problem:** Every ticker gets a ~300-char full indicator block. 25 tickers = ~7,500 chars.
Most holdings are "stable holds" with no trading setup — they waste tokens.

**Fix:** Split tickers into two tiers based on whether a setup exists.

In `analysis.js`, find where `indicatorCtx` is built (the `loaded.map(t => { ... })` block).

Add a `_isCandidate(s, t)` helper BEFORE the map:
```js
function _isCandidate(s, t) {
  // Tier 1: full block — ticker has a potential setup
  if (!s) return false;
  const inPortfolio = portfolioTickers.includes(t);
  const rsi = s.rsi_14 ?? 50;
  const bbPctB = s.bb_pct_b ?? 0.5;
  const score = s.score ?? 0;
  const unrealisedPnlPct = (() => {
    const h = mergedPortfolio().find(h => h.ticker === t);
    if (!h || !h.avgPrice) return 0;
    const livePrice = state.liveSignals?.[t]?.current_price ?? h.currentPrice;
    return ((livePrice / h.avgPrice) - 1) * 100;
  })();
  const preEarnings = s.pre_earnings_risk === true;
  const volSpike = (s.volume_z_score ?? 0) > 2.5;
  const extraTicker = extraTickers.includes(t);  // watchlist — always candidate

  return extraTicker           // watchlist ticker — always analyse
    || rsi < 38                // oversold
    || rsi > 68                // overbought
    || bbPctB < 0.12           // near lower band
    || bbPctB > 0.88           // near upper band
    || score >= 65             // high composite score
    || score <= 30             // low score (possible SELL)
    || preEarnings             // earnings within 14 days
    || volSpike                // unusual volume
    || unrealisedPnlPct < -8   // significant loss — tax harvest / stop candidate
    || unrealisedPnlPct > 25;  // significant gain — trim candidate
}
```

Then in the map, check the tier:
```js
indicatorCtx = sectorAllocCtx + '\n\nLIVE TECHNICAL DATA (yfinance, real-time):\n' + loaded.map(t => {
  const s = state.liveSignals[t];
  // ...existing code to build the full block for this ticker...

  if (!_isCandidate(s, t)) {
    // Tier 2: compressed 1-line summary for stable holds
    const trend = s.trend_direction || 'neutral';
    const livePrice = s.current_price ?? '?';
    const rsi = s.rsi_14?.toFixed(0) ?? '?';
    const sc = s.score?.toFixed(0) ?? '?';
    return `[${t}] $${livePrice} | RSI=${rsi} | score=${sc} | trend=${trend} | no active setup`;
  }

  // Tier 1: full existing block (unchanged)
  // ... rest of existing code ...
}).join('\n');
```

The full block code is unchanged for Tier 1 — just wrap it in the `_isCandidate` check.

---

## Fix 6 — Move rule overrides before indicator data

**File:** `js/analysis.js`

**Problem:** In the `userMessage` template literal, `${rulesCtx}` comes AFTER `${indicatorCtx}`.
Claude processes ~7,500 chars of indicator data before seeing the operative thresholds.

**Fix:** In the template literal, move `${rulesCtx}` to come BEFORE `${indicatorCtx}`.

Current order (end of the big template string):
```
...${riskCtx}${indicatorCtx}${rulesCtx}
```
Change to:
```
...${riskCtx}${rulesCtx}${indicatorCtx}
```

That's a 2-word swap.

---

## Fix 7 — Lessons fetch top 2 sectors

**File:** `js/analysis.js`

**Problem:** Line `_lParams.set('sector', _portfolioSectors[0])` sends only the first sector.
A Materials + Financials portfolio gets Materials lessons only.

**Fix:** Pass the two most-represented sectors by portfolio weight.

Replace:
```js
if (_portfolioSectors.length) _lParams.set('sector', _portfolioSectors[0]);
```
with:
```js
if (_portfolioSectors.length) {
  // Weight sectors by portfolio value, send top 2
  const sectorWeights = {};
  for (const h of mergedPortfolio()) {
    const s = h.sector || 'Other';
    const livePrice = state.liveSignals?.[h.ticker]?.current_price ?? h.currentPrice;
    sectorWeights[s] = (sectorWeights[s] || 0) + h.shares * livePrice;
  }
  const topSectors = Object.entries(sectorWeights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([s]) => s);
  _lParams.set('sector', topSectors[0]);
  if (topSectors[1]) _lParams.set('sector2', topSectors[1]);
}
```

Then check if `routes/learning.py` GET /api/learning/lessons handles a `sector2` param —
if not, just send a comma-separated value in `sector` param:
```js
_lParams.set('sector', topSectors.join(','));
```
And update `routes/learning.py` lessons endpoint to handle comma-separated sector values
(split on comma, match any).

---

## Fix 8 — Add "N days ago" to rec history

**File:** `js/analysis.js`

**Problem:** Rec history lines show bare dates (e.g., `2026-06-01`). Claude must compute
recency for the 7-day anti-churn check. Simple fix.

Find the `recentRecs.map(r => ...)` line that formats rec history. Add a `daysAgo` calculation:
```js
const daysAgo = Math.floor((Date.now() - new Date(r.date)) / 86400000);
```
Then append `(${daysAgo}d ago)` to the formatted line after the date:
```
2026-06-01 (3d ago) BUY BHP @ $45.20 → target $49.50 | ...
```

---

## Fix 9 — Remove `scenarios` from required output

**File:** `js/prompts.js`, `js/response-validator.js`

**Problem:** The `scenarios` field (bull/base/bear with probabilities summing to 1.0) is
display-only — not consumed by the quant engine, validator logic, or learning loop. Claude
frequently produces probabilities that don't sum to 1.0, triggering validator noise. Removing
it saves ~40–60 output tokens per rec.

**Fix part A — prompts.js:**
In the output schema (Section 8), change `scenarios` from required to optional:
```
"scenarios":  (optional) { "bull": {"p": number, "ret": number}, ... }
              Omit entirely if you have low confidence in probability estimates.
              If included, p values must sum to exactly 1.0.
```

**Fix part B — response-validator.js:**
Find where `scenarios` is validated. Change from a required field check to optional:
- If `scenarios` is present, validate it (p sums to ~1.0 within 0.01 tolerance)
- If `scenarios` is absent, do not flag as an error

**Fix part C — JSON schema example:**
Keep `scenarios` in the example output (it's still a supported field) but add a comment
that it's optional.

**Do NOT remove `scenarios` from the UI rendering code** — if it's present in a rec,
the card should still display it.

---

## Bonus fix — Volatility spike annotation (from critics.md §B)

**File:** `js/analysis.js`

Simple S-effort item from critics.md. In the Tier 1 indicator block header for each ticker
(the `[TICKER]` line), prepend `⚡VOLSPIKE` when `s.volume_z_score > 3`:

```js
const volSpikeFlag = (s.volume_z_score ?? 0) > 3 ? ' ⚡VOLSPIKE' : '';
return `[${t}]${volSpikeFlag}${watchlistFlag}`;
```

This gives Claude a clear visual signal that something unusual is happening with volume
on that ticker, even before reading the full indicator block.

---

## Completion checklist

1. `python test_app.py` — all tests pass
2. `npm run test:js` — all tests pass
3. `for f in js/*.js js/pages/*.js; do node --check "$f" || echo "FAIL: $f"; done`
4. Check `js/response-validator.js` scenarios validation is updated (Fix 9)
5. Check `routes/learning.py` lessons endpoint handles comma-separated sector param (Fix 7)
6. Update `prompts.md` Known Issues section: add Fix 1–9 as shipped
7. Update `IMPROVEMENTS.md`: add Sprint 47 section
8. Update `CLAUDE.md`: update prompts.js description (mention tiered indicators, regime at top)
9. Bump `PROMPT_VERSION` in `js/prompts.js` from `'2026-06-v7'` to `'2026-06-v8'`
   (Rules 3 and 4 changed materially — stop ATR reference changed, qty = 0)
10. Create a PR against main
