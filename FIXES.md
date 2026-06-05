# Sloth ASX Trader — Bug Fixes

Specific issues identified in `js/strategy.js` and `js/prompts.js`, with proposed fixes. All issues are independent and can be applied in any order.

---

## 1. `strategy.js` — ADX Filter Logic Gap ✅ FIXED

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

## 2. `strategy.js` — SMA200 Fallback to SMA50 is Silently Asymmetric ✅ FIXED

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

## 3. `strategy.js` — Misleading Config Object: AI-Phase Params Mixed with Pre-Filter Params ✅ FIXED

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

## 4. `prompts.js` — Tax-Loss Harvesting Date Logic Baked Into Static Prompt ✅ FIXED

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

## 5. `prompts.js` — Liquidity Check Comment Has Units Mismatch ✅ FIXED

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

## 6. `prompts.js` — `confidence` Definition Inconsistent Across Day Trade Prompts ✅ FIXED

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

---

## App Auditor findings — Sprint 38 (2026-06-02)

Issues identified by a deep architectural audit covering the quant engine, regime classifier,
learning loop statistics, and data pipeline. Grouped by severity.

---

### Critical — silent correctness failures

## 7. `quant-engine.js` — `minQty` floor overrides a Kelly rejection ✅ FIXED (Sprint 38)

**File:** `js/quant-engine.js`
**Function:** `computeTradeParams()`
**Severity:** High — recommends trades that Kelly says to skip

### Problem

```js
const kellyFull = b > 0 ? Math.max(0, (p * b - q) / b) : 0;
const kellyFrac = kellyFull * (_ap.kellyFraction ?? QUANT_CONFIG.kellyFraction);
const qtyByKelly = Math.floor((capital * kellyFrac) / price);

const rawQty = Math.min(qtyByRisk, qtyByPosition, qtyByLiquidity, qtyByKelly);
const qty = Math.max(QUANT_CONFIG.minQty, Math.floor(rawQty * volScalar));

if (qty <= 0) return { ok: false, reason: 'sizing constraints reject trade (qty=0)' };
```

When `kellyFull ≤ 0` (the trade has negative expected value), `qtyByKelly = 0`, `rawQty = 0`,
`rawQty * volScalar = 0`, then `Math.max(1, 0) = 1`. The `if (qty <= 0)` guard never fires.
You receive a 1-share recommendation on a trade the Kelly criterion says to decline entirely.

### Fix

Reject on `kellyFrac ≤ 0` *before* applying `minQty`, and gate the `minQty` floor to
positive-Kelly trades only:

```js
const kellyFull = b > 0 ? (p * b - q) / b : 0;  // allow negative values through
const kellyFrac = kellyFull * (_ap.kellyFraction ?? QUANT_CONFIG.kellyFraction);

if (kellyFrac <= 0) {
  return { ok: false, reason: `negative expected value (Kelly=${kellyFull.toFixed(3)}) — skip trade` };
}

const qtyByKelly = Math.floor((capital * kellyFrac) / price);
const rawQty = Math.min(qtyByRisk, qtyByPosition, qtyByLiquidity, qtyByKelly);
const qty = Math.max(QUANT_CONFIG.minQty, Math.floor(rawQty * volScalar));  // floor only for rounding
```

---

## 8. `routes/learning.py` — calibration cache has no thread lock ✅ FIXED

**File:** `routes/learning.py:24`
**Severity:** High — can corrupt calibration data injected into every Claude prompt

### Problem

```python
_calib_cache: dict = {}
_CALIB_TTL = 300
```

gunicorn runs 2 workers × 8 threads. A complex dict write is not atomic in CPython at the
value level across threads sharing a module. Two threads computing calibration simultaneously
can interleave their writes, producing a partially-assembled cache entry. That corrupted entry
is then returned and injected into the next N Claude prompts until the TTL expires. Calibration
nudges are subtle (a few tokens of confidence adjustment) so this fails silently.

### Fix

Add a module-level lock and wrap all cache reads/writes:

```python
import threading
_calib_cache: dict = {}
_CALIB_TTL = 300
_calib_lock = threading.Lock()

# In _calib_compute():
cache_key = (regime, sectors_str, tickers_str, days)
with _calib_lock:
    entry = _calib_cache.get(cache_key)
    if entry and time.time() - entry["ts"] < _CALIB_TTL:
        return entry["data"]

result = _compute_calibration(...)   # expensive work outside the lock

with _calib_lock:
    _calib_cache[cache_key] = {"ts": time.time(), "data": result}
return result
```

Compute outside the lock to avoid holding it during slow DB queries. Only the read and the
final write need to be locked.

---

### High — accuracy / model quality

## 9. `indicators.py` — Factor IC values computed but not fed back as weights in `_score_ticker` ✅ FIXED (Sprint 38)

**File:** `indicators.py`, `routes/scanner.py` (factor-stability endpoint)
**Severity:** High — Factor Stability tab is diagnostic-only; the scanner still uses equal weights

### Problem

Sprint 21 shipped per-factor Information Coefficient (IC) measurement via
`POST /api/scanner/factor-stability`. Each factor's OOS IC is computed and displayed. However
`_score_ticker` still uses hardcoded equal weights:

```python
# Current — fixed weights regardless of empirical predictive power
total = trend + pullback + vol_score + mom_score + rs_score
#        30      30         20          10          10
```

The factor stability data is available but ignored in the scoring function itself.

### Fix

Store IC weights in a tunable config dict and apply them proportionally. After each factor
stability run, update the weights manually (or add a `/api/scanner/apply-factor-weights`
endpoint to do it automatically):

```python
# In indicators.py
FACTOR_WEIGHTS = {
    "trend":    30,   # update these after each factor stability run
    "pullback": 30,
    "volume":   20,
    "momentum": 10,
    "rs":       10,
}
_WEIGHT_TOTAL = sum(FACTOR_WEIGHTS.values())

# In _score_ticker():
w = FACTOR_WEIGHTS
total = (trend   * w["trend"]    / 30 +
         pullback * w["pullback"] / 30 +
         vol_score * w["volume"]  / 20 +
         mom_score * w["momentum"] / 10 +
         rs_score  * w["rs"]       / 10)
total = round(min(total, 100), 1)
```

The factor-stability endpoint should return IC values in a format ready to paste into
`FACTOR_WEIGHTS`, and display a "suggested weights" row in the Factor Stability UI table.

---

## 10. `routes/learning.py` — Phase 8 gate uses raw means; one outlier can flip it ✅ FIXED

**File:** `routes/learning.py:75–80`
**Function:** `_compute_phase8_meta()`
**Severity:** Medium — skill-weighting can be toggled on/off by a single atypical trade

### Problem

```python
mean_win  = round(sum(win_skills)  / len(win_skills),  2)
mean_loss = round(sum(loss_skills) / len(loss_skills), 2)
active = mean_win > mean_loss
```

With n=10 minimum, a single Ollama score of 9.8 on a loss (e.g., a well-executed trade that
hit an external shock) can push `mean_loss` above `mean_win` and disable Phase 8 entirely,
even when the scores are genuinely predictive across the other 9 trades.

### Fix

Replace the mean comparison with a Mann-Whitney U test (no normality assumption, correct for
small samples with ordinal 0–10 scores):

```python
from scipy.stats import mannwhitneyu  # or implement directly — see below

# If scipy unavailable, use a simple U statistic:
def _mann_whitney_p(wins, losses):
    u = sum(1 for w in wins for l in losses if w > l) + \
        0.5 * sum(1 for w in wins for l in losses if w == l)
    n1, n2 = len(wins), len(losses)
    mu = n1 * n2 / 2
    sigma = math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12)
    z = (u - mu) / sigma if sigma > 0 else 0
    return z  # positive z → wins > losses

z = _mann_whitney_p(win_skills, loss_skills)
active = z > 1.28  # one-sided p < 0.10 threshold
```

No scipy dependency needed — the U statistic is a straightforward double loop. Return `z` and
the threshold in the stats response so the Learning page can display it.

---

## 11. `routes/learning.py` — unexecuted recs silently omitted from calibration ✅ FIXED (Sprint 36 — `_resolve_virtual_outcomes`)

**File:** `routes/learning.py`, `js/analysis.js`
**Severity:** Medium — calibration dataset is censored; win rates are biased upward

### Problem

When a rec is generated but never executed (`was_executed = 0`), it never receives an outcome
and is excluded from all calibration calculations. If Claude generates a BUY at $5.00 that
subsequently hits the target — and you didn't trade it — that's a real signal the model got
right. Excluding non-executed recs means the calibration set contains only recs the user chose
to act on, which introduces selection bias (users tend to execute higher-conviction recs).

### Fix

Add virtual outcome tracking for non-executed recs older than N days:

**Backend** — new function `_resolve_virtual_outcomes(conn)` called inside `_calib_compute()`:

```python
def _resolve_virtual_outcomes(conn, lookback_days=30):
    """
    For recs with was_executed=0, older than lookback_days, fetch current price
    and check whether target / stop was hit in the intervening period.
    Write outcome_status='virtual_win'/'virtual_loss' and a notes tag.
    """
    rows = conn.execute("""
        SELECT id, ticker, ai_confidence, suggested_target, suggested_stop,
               timestamp
        FROM ai_learning_events
        WHERE was_executed = 0
          AND outcome_status IS NULL
          AND timestamp < datetime('now', ?)
          AND suggested_target IS NOT NULL
          AND suggested_stop IS NOT NULL
    """, (f"-{lookback_days} days",)).fetchall()
    # For each row: fetch price history from timestamp → now via yfinance;
    # check whether high >= target (virtual_win) or low <= stop (virtual_loss).
    # Use 'virtual_win' / 'virtual_loss' so they can be excluded or down-weighted
    # separately from real executed outcomes in the calibration stats UI.
```

**Frontend** — Learning page should show a "Virtual Outcomes" count badge so the user knows
how many non-executed recs contributed to calibration.

---

### Medium — data quality

## 12. `indicators.py` — no price sanity check on fetched OHLCV data ✅ FIXED (Sprint 38)

**File:** `indicators.py`
**Function:** `analyse_ticker()`
**Severity:** Medium — a single bad bar corrupts RSI/ATR/BB for the session (until TTL expires)

### Problem

yfinance occasionally returns a bar with a price adjusted for a split that hasn't been applied
to surrounding bars yet (or a data error producing a 40–60% single-day move). This flows
directly into RSI, ATR, and Bollinger Band calculations, generating false signals. The 5-min
TTL cache then serves the corrupted data to all callers.

### Fix

Add a `_sanity_check(hist, ticker)` function called after `_drop_forming_bar`:

```python
def _sanity_check(hist: pd.DataFrame, ticker: str = "") -> pd.DataFrame:
    """Drop bars where single-day close move exceeds 25% (likely data error or unadjusted split).
    Exception: penny stocks (close < $0.50) are excluded from this check.
    """
    if len(hist) < 2:
        return hist
    pct_chg = hist["Close"].pct_change().abs()
    # Keep rows where the change is ≤ 25%, or where the closing price is a penny stock
    mask = (pct_chg <= 0.25) | (hist["Close"] < 0.50) | pct_chg.isna()
    n_dropped = (~mask).sum()
    if n_dropped > 0:
        from core import log
        log.warning(f"[sanity_check] {ticker}: dropped {n_dropped} bars with >25% single-day move")
    return hist[mask]

# In analyse_ticker(), after _drop_forming_bar():
hist = _sanity_check(hist, ticker)
if len(hist) < 30:
    return {"error": f"Insufficient clean data for {ticker}", "ticker": ticker.upper()}
```

---

## 13. `core.py` — `ASX_UNIVERSE` is static and grows stale ✅ FIXED (Sprint 39 — medium-term path)

**File:** `core.py` (ASX_UNIVERSE definition)
**Severity:** Medium — delisted tickers generate spurious scanner signals

### Problem

`ASX_UNIVERSE` is a hardcoded list. ASX200 constituents change quarterly (additions, deletions,
delistings, mergers). A delisted stock (`IPL.AX` was already caught once) returns empty
yfinance data, triggers the Stooq fallback, and if Stooq also fails, gets logged as a
`failed_ticker` — this is handled gracefully. But a *merged* stock (e.g., company absorbed
into another at a premium) may still return stale yfinance data with old prices, generating
false scanner hits.

### Fix

1. **Short term:** Add a quarterly review reminder to the Settings → App Info card, showing
   "Universe last verified: YYYY-MM-DD" from a `universe_verified_at` key in `blob_store`.

2. **Medium term:** Add a `GET /api/market/universe-health` endpoint that:
   - Fetches all tickers in `ASX_UNIVERSE` with a single batch yfinance call
   - Flags any ticker returning `quoteType = 'NONE'` or empty history
   - Returns `{stale: [ticker, ...], ok_count: N}` for display in Settings

3. **Longer term:** Pull the ASX200 constituent CSV from ASX's website (available at
   `https://www.asx.com.au/data/trendliner/S&P_ASX_200_Index.zip`) on a weekly schedule
   and diff against `ASX_UNIVERSE` to surface additions/removals.

---

### Medium — regime classification

## 14. `regime-engine.js` — regime transitions are hard-cut, not smoothed ✅ FIXED (Sprint 38)

**File:** `js/regime-engine.js`
**Function:** `fetchAndClassifyRegime()`, `applyRegimeModifiers()`
**Severity:** Medium — recs generated at regime boundary get wildly different sizing

### Problem

When regime flips from `riskOn` (sizeMult=1.0) to `riskOff` (sizeMult=0.5), the sizing change
is instantaneous. A portfolio analysis run 5 minutes before the flip gets full allocation; the
next run gets half. Near a noisy boundary (regime flipping back and forth), this creates
erratic position sizing with no connection to the underlying risk level.

### Fix

Store `_lastRegime` and `_lastRegimeAt` alongside `_regimeCache`. Apply a blend:

```js
// In fetchAndClassifyRegime(), after classifying:
const prevMult = getRegimeModifiers(_regimeCache.regime).sizeMult;
const newMult  = getRegimeModifiers(result.regime).sizeMult;
const elapsed  = _regimeCache.fetchedAt ? (Date.now() - _regimeCache.fetchedAt) / 1000 : 9999;
const blendWindow = 30 * 60;  // 30-min linear blend after a flip
const blendFraction = Math.min(1, elapsed / blendWindow);
result._blendedSizeMult = prevMult + (newMult - prevMult) * blendFraction;
```

`applyRegimeModifiers` then uses `rec._blendedSizeMult ?? mod.sizeMult` when available. After
30 minutes the blend resolves to the new regime's multiplier fully.

---

## 15. `regime-engine.js` — SPI200 futures not used as a lead indicator ✅ FIXED (Sprint 38)

**File:** `js/regime-engine.js`, `routes/market.py`
**Severity:** Low-Medium — regime classification is always backward-looking

### Problem

All regime signals (ASX200 5d/20d return, VIX, ADX, A/D ratio) are derived from yesterday's
closed data. The SPI200 futures price (`YAP=F` on Yahoo Finance) reflects what institutional
participants expect the ASX200 to open at — it moves in real time overnight when US markets
are open, giving a ~12h lead on the next ASX session.

### Fix

Add `spi200_futures` to `_macro_payload()` in `routes/market.py`:

```python
# In the parallel yfinance fetch block:
spi = yf.Ticker("YAP=F")
spi_hist = spi.history(period="5d")
spi_price = safe_float(spi_hist["Close"].iloc[-1]) if not spi_hist.empty else None
spi_vs_asx200 = round((spi_price / asx200_price - 1) * 100, 2) if spi_price and asx200_price else None
# Add to payload: "spi200_futures_chg": spi_vs_asx200
```

In `regime-engine.js`, add a vote:

```js
const spiChg = macroData.spi200_futures_chg;
if (spiChg != null) {
  if (spiChg < -1.5) vote('riskOff', 2, `SPI futures ${spiChg.toFixed(1)}% → expected weak open`);
  else if (spiChg > 1.0) vote('riskOn', 1, `SPI futures ${spiChg.toFixed(1)}% → expected strong open`);
}
```

---

### Low — risk management improvements

## 16. `quant-engine.js` — stop distance is regime-blind ✅ FIXED (Sprint 38)

**File:** `js/quant-engine.js`, `js/regime-engine.js`
**Severity:** Low — stops too tight in high-vol regimes, too wide in low-vol

### Problem

```js
const stopDist = stopMultiple * atr;
const stopLoss = +(price - stopDist).toFixed(4);
```

`stopAtrMultiple` is a single config value (default 2.5×) applied regardless of regime. In
`highVol` regime, ATR is already elevated, so the stop is wider in dollar terms — but
the *multiplier* doesn't account for elevated tail-risk beyond what ATR captures. In `riskOn`
with VIX=12, ATR undershoots sudden catalysts.

### Fix

Apply a regime-conditional ATR multiplier in `getRegimeModifiers()` and use it in
`computeTradeParams()`:

```js
// In regime-engine.js getRegimeModifiers():
case 'riskOn':   return { ..., stopAtrMult: 2.5 };
case 'highVol':  return { ..., stopAtrMult: 3.0 };
case 'riskOff':  return { ..., stopAtrMult: 3.5 };
case 'panic':    return { ..., stopAtrMult: 4.0 };
default:         return { ..., stopAtrMult: 2.5 };

// In quant-engine.js computeTradeParams():
const regimeMod = state.currentRegime ? getRegimeModifiers(state.currentRegime.regime) : {};
const stopMultiple = regimeMod.stopAtrMult ?? _ap.stopAtrMultiple ?? QUANT_CONFIG.stopAtrMultiple;
```

---

## 17. `js/analysis.js` — no portfolio-level drawdown budget gate on new BUY recs ✅ FIXED (Sprint 38)

**File:** `js/analysis.js`, `js/pages/recommendations.js`
**Severity:** Low — heat gauge is diagnostic; it doesn't block oversized new recs

### Problem

The Risk page heat gauge shows total $ at risk to stops vs a configured budget. However when
`analysis.js` generates new BUY recs, it does not check whether adding the new position's risk
would breach the drawdown budget. A user can already be at 90% of their heat budget and still
receive a normally-sized BUY rec.

### Fix

In `analysis.js`, after the quant engine produces a rec and before returning it, add a
drawdown budget check:

```js
function _checkDrawdownBudget(newRec) {
  const budget = state.settings.heatBudgetPct ?? 5;  // % of portfolio
  const portfolioValue = (state.cash || 0) + state.portfolio.reduce((s, h) =>
    s + h.shares * (h.currentPrice || h.avgPrice), 0);
  const budgetAUD = portfolioValue * budget / 100;

  // Sum risk of all open recs with stops
  const openRisk = state.recommendations
    .filter(r => r.action === 'BUY' || r.action === 'TOP_UP')
    .reduce((s, r) => s + (r.riskAUD || 0), 0);

  const remaining = budgetAUD - openRisk;
  if (newRec.riskAUD > remaining) {
    // Scale qty down to fit remaining budget
    const scaledQty = Math.floor(remaining / (newRec.riskAUD / newRec.qty));
    if (scaledQty < 1) return { ...newRec, qty: 0, _budgetBlocked: true };
    return { ...newRec, qty: scaledQty, _budgetScaled: true,
             _budgetNote: `Scaled to fit remaining heat budget ($${remaining.toFixed(0)})` };
  }
  return newRec;
}
```

Display a `⚠ Budget` badge on any rec where `_budgetScaled = true`.

---

## 18. `indicators.py` / `js/quant-engine.js` — earnings-season stop tightening not applied prospectively ✅ FIXED (Sprint 38)

**File:** `indicators.py`, `js/quant-engine.js`
**Severity:** Low — ATR spikes retrospectively; stops are set too tight pre-earnings

### Problem

During ASX reporting season (Feb and Aug), per-stock volatility is ~40% higher than average.
The regime engine sees this *after* a surprise moves ATR. Stops generated from pre-earnings ATR
are undersized relative to the actual move risk, leading to stop-outs on noise.

### Fix

In `analyse_ticker()`, check proximity to the ticker's next earnings date and flag it:

```python
# In analyse_ticker() result dict:
days_to_earnings = None
try:
    cal = stk.calendar
    if cal is not None and "Earnings Date" in cal.columns:
        earn_date = pd.Timestamp(cal["Earnings Date"].iloc[0])
        days_to_earnings = (earn_date - pd.Timestamp.now()).days
except Exception:
    pass

result["days_to_earnings"] = days_to_earnings
result["pre_earnings_risk"] = (days_to_earnings is not None and 0 <= days_to_earnings <= 14)
```

In `quant-engine.js`, when `signals.pre_earnings_risk` is true, scale the stop multiplier up:

```js
const earningsAdjust = signals.pre_earnings_risk ? 1.3 : 1.0;
const stopMultiple = (regimeMod.stopAtrMult ?? _ap.stopAtrMultiple ?? QUANT_CONFIG.stopAtrMultiple)
                    * earningsAdjust;
```

Display a `📅 Pre-earnings` badge on the rec card when this adjustment fires.

---

## Summary — Sprint 38 fixes

| # | File(s) | Issue | Severity | Effort |
|---|---|---|---|---|
| 7 ✅ | `quant-engine.js` | `minQty` floor overrides Kelly=0 rejection → recommends negative-EV trades | **High** | S |
| 8 ✅ | `routes/learning.py` | Calibration cache has no thread lock → corrupted data under concurrent requests | **High** | S |
| 9 ✅ | `indicators.py` | Factor IC computed but not fed back as `_score_ticker` weights — `FACTOR_WEIGHTS` dict added | High | M |
| 10 ✅ | `routes/learning.py` | Phase 8 gate uses means; one outlier can disable skill-weighting | Medium | S |
| 11 ✅ | `routes/learning.py` / `js/analysis.js` | Non-executed recs omitted from calibration → upward-biased win rates | Medium | M |
| 12 ✅ | `indicators.py` | No price sanity check — a single bad bar corrupts RSI/ATR for the TTL window | Medium | S |
| 13 ✅ | `core.py` | `ASX_UNIVERSE` is static; delisted/merged tickers produce spurious signals | Medium | S–M |
| 14 ✅ | `js/regime-engine.js` | Hard-cut regime transitions → 30-min linear blend on non-panic flips | Medium | S |
| 15 ✅ | `js/regime-engine.js` / `routes/market.py` | SPI200 futures absent — YAP=F added; riskOff +2 / riskOn +1 votes | Low–Med | S |
| 16 ✅ | `js/quant-engine.js` / `js/regime-engine.js` | Stop ATR multiplier is regime-blind | Low | S |
| 17 ✅ | `js/analysis.js` | Heat budget gate is diagnostic only; new recs ignore remaining budget | Low | M |
| 18 ✅ | `indicators.py` / `js/quant-engine.js` | Pre-earnings stop tightening not applied prospectively | Low | S |

**Sprint 38 status:** #7, #9, #12, #14, #15, #16, #17, #18 fixed (2026-06-02). All 18 items closed.

**Sprint 39 status (2026-06-02):** Fixed `_preEarningsAdj` dropped from quant merge (analysis.js); added 4h per-ticker TTL cache to earnings-calendar endpoint (routes/market.py); closed #13 summary table.

---

## Sprint 41 — Planned Fixes and Improvements (2026-06-02)

Issues identified in the Sprint 40 post-ship audit. Grouped by severity and effort.

---

### Bug Fixes

## 19. `db.py` / `routes/learning.py` — `tag_reviews` lacked UNIQUE constraint; INSERT OR REPLACE always inserted ✅ FIXED (Sprint 41)

**Files:** `db.py`, `routes/learning.py`
**Function:** `submit_tag_review()`
**Severity:** Medium — agree-rate count could double if the same event was submitted twice

### Problem

`tag_reviews` was defined with `INTEGER PRIMARY KEY AUTOINCREMENT` and no `UNIQUE(event_id)`.
`INSERT OR REPLACE` in SQLite replaces rows only on primary-key or unique-constraint conflicts.
With an autoincrement PK and no unique constraint on `event_id`, the replace condition never
fires — every call creates a new row. The queue endpoint's `NOT IN (SELECT event_id FROM tag_reviews)`
filter prevented re-reviews through the normal UI, but a rapid double-submit or a parallel
gunicorn request could produce duplicate rows, skewing `COUNT(*) / SUM(agree)` in `tag_accuracy()`.

### Fix

1. **`db.py`** — added `UNIQUE` to the `event_id` column definition so fresh installs get the constraint:
   ```sql
   event_id INTEGER NOT NULL UNIQUE REFERENCES ai_learning_events(id) ON DELETE CASCADE,
   ```
   (`CREATE TABLE IF NOT EXISTS` won't recreate the table on existing DBs — see migration note below.)

2. **`routes/learning.py`** — replaced `INSERT OR REPLACE` with an explicit check-then-upsert
   that is safe on both new and old schemas:
   ```python
   existing = conn.execute("SELECT id FROM tag_reviews WHERE event_id=?", (event_id,)).fetchone()
   if existing:
       conn.execute(
           "UPDATE tag_reviews SET verdict=?, corrected_tag=?, reviewed_at=datetime('now','localtime') WHERE event_id=?",
           (verdict, corrected if verdict == "disagree" else None, event_id)
       )
   else:
       conn.execute(
           "INSERT INTO tag_reviews (event_id, verdict, corrected_tag, original_tag) VALUES (?, ?, ?, ?)",
           (event_id, verdict, corrected if verdict == "disagree" else None, row["error_type"])
       )
   ```

### Migration note for existing DBs

SQLite cannot add a UNIQUE constraint to an existing column via `ALTER TABLE`. If the app was
running before this fix and duplicate rows were created, run this once in the SQLite shell:

```sql
-- Keep only the first review row per event; delete duplicates
DELETE FROM tag_reviews
WHERE id NOT IN (
    SELECT MIN(id) FROM tag_reviews GROUP BY event_id
);
-- Then recreate with UNIQUE — requires table rebuild since ALTER TABLE can't add constraints
```

In practice: because `tag_reviews` is a brand-new table (shipped Sprint 39) with no users having
data yet, no migration script is needed. The code-level upsert is the correct long-term guard.

---

## 20. `routes/market.py` — `universe_health` has no per-ticker timeout; a hung yfinance call blocks the endpoint

**File:** `routes/market.py`
**Function:** `universe_health()`
**Severity:** Low — user-triggered endpoint; yfinance has its own connection timeout as backstop
**Effort:** S

### Problem

`pool.map(_check, all_tickers)` with 200 tickers and 20 workers has no per-task timeout.
yfinance normally fails fast on network errors, but a connection that hangs without raising
(e.g., a firewall silently dropping packets) can stall individual workers indefinitely.
Because `pool.map` propagates the first unhandled exception and waits for all futures, one
hung ticker can delay the entire response by minutes.

### Fix

Switch from `pool.map` to `as_completed` with a per-future timeout, matching the pattern
already used in `routes/intraday.py`:

```python
stale = []
with _cf.ThreadPoolExecutor(max_workers=20) as pool:
    futures = {pool.submit(_check, t): t for t in all_tickers}
    for fut in _cf.as_completed(futures, timeout=30):  # 30s total wall-clock limit
        try:
            result = fut.result(timeout=8)  # 8s per ticker
            if result:
                stale.append(result)
        except (_cf.TimeoutError, Exception):
            stale.append(futures[fut])  # treat timeout as stale
```

Add a `timeout` query param so the caller can tune for slow networks:
`timeout = int(request.args.get("timeout", 8))`

---

### New Features

## 21. Local LLM fallback for portfolio analysis via Ollama

**Files:** `js/claude-client.js`, `js/analysis.js`, `routes/debate.py` (or new `routes/ollama_analysis.py`)
**Severity:** Enhancement — avoids API spend on routine scans
**Effort:** M · Impact ★★

### Problem / Motivation

Every portfolio analysis call goes to Claude API (Sonnet 4.6), costing ~$0.01–0.05 per run.
The Ollama infrastructure is already running for the debate engine (bull/bear, postmortem,
skill scoring). On quiet days — same regime, no new catalysts, no earnings — a fast local
model can produce a useful "hold / monitor" read without spending tokens. Claude is reserved
for high-conviction situations (regime change, earnings approaching, thesis-breaking news).

### Implementation Plan

**Step 1 — Backend endpoint** (`routes/debate.py` or new file):

```python
@bp.route("/api/debate/quick-analysis", methods=["POST"])
def quick_analysis():
    """Lightweight portfolio analysis via local Ollama — used when user opts into LLM fallback.
    
    Body: { tickers: [...], regime: str, signals: {...}, portfolio_summary: str }
    Returns: { ok, recommendations: [{ticker, action, rationale, confidence}] }
    """
```

Prompt design:
- System: stripped-down version of `ANALYSIS_SYSTEM_PROMPT` (regime rules + Kelly reject + stop
  rules only; omit calibration injection — Ollama can't use it reliably)
- Use `format_schema` (Ollama structured outputs, already used in debate engine) to guarantee JSON
- Model: `qwen2.5:14b` (or whichever is configured) — capable of basic BUY/SELL/HOLD with rationale

**Step 2 — Frontend toggle** (`js/claude-client.js`):

```js
// In callClaude(), add a fast-path:
if (state.settings.useLocalLLM && agentType === 'portfolio') {
    return _callOllamaAnalysis(userMsg, opts);
}
```

Add `useLocalLLM` toggle in Settings → AI Model section. Default `false`.

**Step 3 — Validator passthrough:**
Ollama output goes through the existing `getValidatedAnalysisWithRepair()` validator — no new
validation code. The quant engine runs identically on top of it.

**Step 4 — Rec card badge:**
Recs generated by Ollama get a `_source: 'local'` flag → shows `🔒 Local` badge on the card so
the user knows it wasn't Claude.

### Key constraints / gotchas

- Ollama structured output must match the existing rec JSON schema exactly — test with
  `response-validator.js` before shipping
- Calibration injection (`fetchCalibrationBlock()`) should be skipped for local calls — the
  nudge tokens assume Claude-level instruction following
- This is NOT a drop-in replacement; it is opt-in for "quick scan / offline" use only
- Phase 8 skill scoring and postmortem continue to use Ollama as they already do

---

## 22. Multiple portfolios (super / personal / trading accounts)

**Files:** `db.py`, `routes/portfolio.py`, `js/config.js`, `js/api.js`, `js/pages/portfolio.js`, `js/pages/cgt.js`, `js/pages/risk.js`, `js/pages/performance.js`
**Severity:** Enhancement — single-user multi-account support
**Effort:** L · Impact ★★

### Problem / Motivation

All holdings, CGT parcels, and trade journal entries share a single implicit portfolio.
A user with both a super fund and a personal brokerage account must track them manually,
losing the ability to see combined P&L, per-account CGT, or per-account heat gauges.

### Implementation Plan

**Step 1 — DB schema** (`db.py`):

```sql
CREATE TABLE IF NOT EXISTS portfolios (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,   -- 'Personal', 'Super', 'Trading'
    created_at TEXT DEFAULT (datetime('now','localtime')),
    notes      TEXT
);
-- Seed a default row on init_db() to avoid breaking existing data:
INSERT OR IGNORE INTO portfolios (id, name) VALUES (1, 'Default');
```

Add `portfolio_id INTEGER NOT NULL DEFAULT 1 REFERENCES portfolios(id)` to:
- `blob_store` — for watchlist, savedScreeners, targetAllocations per account
- `trade_journal`
- CGT parcels (currently in `blob_store` as JSON — migration is simpler here)

For `blob_store` keys that are account-scoped, prefix with `portfolio_{id}_`:
`portfolio_1_watchlist`, `portfolio_1_savedScreeners`, etc.

**Step 2 — State** (`js/config.js`):

```js
// Add to global state:
state.activePortfolioId = 1;   // integer — which portfolio is currently active
state.portfolios = [];          // [{id, name, notes}] — from GET /api/portfolios
```

**Step 3 — Backend** (`routes/portfolio.py`):

```
GET  /api/portfolios              — list all portfolios
POST /api/portfolios              — create new
PATCH /api/portfolios/<id>        — rename / update notes
DELETE /api/portfolios/<id>       — delete (only if no holdings/trades)
GET  /api/portfolios/<id>/summary — combined nav, cash, P&L for one account
```

All existing save/load endpoints get an optional `portfolio_id` query param (default 1) so
existing clients continue to work without changes.

**Step 4 — Account switcher UI** (`js/navigation.js` or `js/pages/settings.js`):

A dropdown in the sidebar or topbar that sets `state.activePortfolioId` and reloads state.
Combined view (sum across all accounts) available as a special portfolio_id=0 read-only mode.

**Step 5 — CGT isolation:**

Each CGT parcel in `blob_store.cgtDisposals` and `blob_store.openParcels` is already a JSON
array. Migrate to separate keys per portfolio: `portfolio_1_openParcels`, etc. No DB column
needed — the `blob_store` key prefix is sufficient.

### Key constraints / gotchas

- This is the largest change in the codebase — touches every page that reads `state.portfolio`
- Recommendation learning events are NOT portfolio-scoped (they're a global signal quality
  record) — `ai_learning_events` stays as-is
- Correlation-aware sizing and regime engine are portfolio-scoped by definition — they read
  `state.portfolio` directly, so they automatically reflect the active portfolio
- The CGT discount countdown and tax-loss planner must operate per-portfolio (CGT is calculated
  per taxpayer identity, which maps 1:1 to an account here)
- Suggest implementing as a feature branch; don't attempt mid-session without full smoke testing

---

## 23. PWA installability (manifest + service worker stub)

**Files:** `asx_trading.html`, new `manifest.json`, new `sw.js`
**Severity:** Enhancement — cosmetic but useful for quick mobile access
**Effort:** S · Impact ★

### Problem / Motivation

The app is accessed via `file://` (or `localhost:5000`). On mobile, there is no home-screen
icon; the full browser chrome takes up screen real estate. A minimal PWA manifest allows
"Add to Home Screen" on Chrome/Safari, giving a standalone window without address bar.

### Implementation Plan

**`manifest.json`** (in project root, served statically):

```json
{
  "name": "Sloth ASX Trader",
  "short_name": "SlothASX",
  "start_url": "/asx_trading.html",
  "display": "standalone",
  "background_color": "#1a1a2e",
  "theme_color": "#3b82f6",
  "icons": [
    { "src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**`sw.js`** (minimal service worker — no caching strategy, just registers):

```js
// Intentionally empty — PWA requires a registered SW; no offline caching needed
// since the Flask backend must be running anyway.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
```

**`asx_trading.html`** — add in `<head>`:

```html
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#3b82f6">
<meta name="apple-mobile-web-app-capable" content="yes">
<script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
</script>
```

**Flask** (`asx_server.py`) — serve both files as static routes:

```python
@app.route('/manifest.json')
def serve_manifest():
    return send_from_directory('.', 'manifest.json', mimetype='application/manifest+json')

@app.route('/sw.js')
def serve_sw():
    return send_from_directory('.', 'sw.js', mimetype='application/javascript')
```

### Key constraints

- PWA installability requires HTTPS or `localhost` — works on `localhost:5000` but not
  `file://`. Users running via gunicorn on localhost are covered; `file://` users are not
- No offline capability is planned — the service worker is a registration stub only
- Icons (192px + 512px PNG) need to be created and placed in `static/`

---

## Summary — Sprint 41 plan

| # | File(s) | Issue / Feature | Severity | Effort | Status |
|---|---|---|---|---|---|
| 19 ✅ | `db.py`, `routes/learning.py` | `tag_reviews` upsert always inserted (no UNIQUE on event_id) | Medium | S | Fixed |
| 20 ✅ | `routes/market.py` | `universe_health` no per-ticker timeout — hung worker stalls endpoint | Low | S | Fixed |
| 21 ✅ | `routes/debate.py`, `js/claude-client.js`, `js/pages/settings.js` | Local LLM fallback (Ollama) for portfolio analysis | Enhancement | M | Fixed |
| 22 | — | Multiple portfolios (super / personal / trading accounts) | Enhancement | L | Skipped |
| 23 ✅ | `asx_trading.html`, `manifest.json`, `sw.js`, `asx_server.py` | PWA installability — home-screen icon, standalone window | Enhancement | S | Fixed |

**Sprint 41 status (2026-06-02):** #19–21 and #23 shipped. #22 (multiple portfolios) deferred by user request.

---

## Sprint 42 — Audit findings (2026-06-03)

Issues identified during the Sprint 41 post-ship deep audit. Grouped by severity and effort.

---

### Minor — correctness / UX polish

## 24. `js/claude-client.js` — Local LLM fast-path ignores user's preferred model ✅ FIXED

**File:** `js/claude-client.js`
**Function:** `_callLocalAnalysis()`
**Severity:** Low — always uses `qwen3:9b` default regardless of `state.debate.model`

### Problem

```js
async function _callLocalAnalysis(userMessage) {
  const resp = await fetch(`${API}/api/debate/quick-analysis`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ userMessage }),   // ← no 'model' field
  });
```

The backend `/api/debate/quick-analysis` defaults to `qwen3:9b` when no model is specified. A user who has configured `qwen3.5:9b` (faster, better) as their preferred debate model in Settings → Debate Engine does not get to use it for quick analysis. Inconsistent with all other Ollama calls which honour `state.debate.model` via `preferredDebateModel()`.

### Fix

Pass the preferred model in the request body:

```js
async function _callLocalAnalysis(userMessage) {
  const prefModel = (typeof preferredDebateModel === 'function')
    ? preferredDebateModel()
    : (state.debate?.model || 'qwen3:9b');
  const resp = await fetch(`${API}/api/debate/quick-analysis`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ userMessage, model: prefModel }),
  });
```

`preferredDebateModel()` is defined in `debate-client.js` which loads before `claude-client.js` — safe to call. Falls back to `state.debate.model` string or `qwen3:9b` if the function is unavailable.

---

## 25. `routes/debate.py` — `quick_analysis` logger uses `'parsed' in dir()` anti-pattern ✅ FIXED

**File:** `routes/debate.py`
**Function:** `quick_analysis()`
**Severity:** Low — cosmetic / code smell. Works correctly.

### Problem

```python
current_app.logger.info(
    f"[QuickAnalysis] {model} → {len(parsed.get('recs', []) if 'parsed' in dir() else [])} recs ..."
)
```

`'parsed' in dir()` is a non-idiomatic way to check if a variable exists. `dir()` works here because Python doesn't have block scoping (the `try` block's `parsed` survives into the outer scope), but it's fragile and confusing to readers.

### Fix

Initialize `rec_count` before the try block:

```python
rec_count = 0
try:
    parsed = json.loads(raw)
    for r in parsed.get("recs", []):
        r["_source"] = "local"
    rec_count = len(parsed.get("recs", []))
    text_out = json.dumps(parsed)
except Exception:
    text_out = raw

current_app.logger.info(f"[QuickAnalysis] {model} → {rec_count} recs in {elapsed_ms}ms")
```

---

## 26. `js/config.js` — `useLocalLLM` and `maxRiskBudgetPct` not initialized in state defaults ✅ FIXED

**File:** `js/config.js`
**Severity:** Low — no runtime bug (both fields use `??` / `||` defaults in callers), but inconsistent with all other settings fields

### Problem

`state.settings.useLocalLLM` and `state.settings.maxRiskBudgetPct` are not in the initial `state.settings` object in `config.js`. They are dynamically added at runtime:
- `useLocalLLM` — added by `settingsToggleLocalLLM()` in `settings.js` and loaded from DB
- `maxRiskBudgetPct` — added by the Risk page budget input and loaded from DB

Both callers use safe defaults (`state.settings?.useLocalLLM` → falsy, `state.settings.maxRiskBudgetPct || 5` → 5). But the missing initialization means `Object.keys(state.settings)` is non-deterministic and a fresh install shows no budget input pre-populated.

### Fix

Add defaults to `js/config.js`:

```js
settings: {
  // ... existing fields ...
  compactMode: false,
  useLocalLLM: false,       // opt-in local Ollama analysis (Sprint 41)
  maxRiskBudgetPct: 5,      // heat budget gate: max total risk % of portfolio (Sprint 38)
},
```

---

## Summary — Sprint 42 ✅ COMPLETE

| # | File(s) | Issue / Feature | Severity | Effort | Status |
|---|---|---|---|---|---|
| 24 | `js/claude-client.js` | Local LLM fast-path ignores user's preferred model (`qwen3:9b` hardcoded) | Low | S | ✅ FIXED |
| 25 | `routes/debate.py` | `quick_analysis` logger uses `'parsed' in dir()` anti-pattern | Low | XS | ✅ FIXED |
| 26 | `js/config.js` | `useLocalLLM` and `maxRiskBudgetPct` not initialized in state defaults | Low | XS | ✅ FIXED |

---

## Day Trading transaction recording — Post-Sprint-48 (2026-06-05)

Issues identified by tracing the full data flow from Day Trading execute → Trade Journal, Performance, CGT, Portfolio, and Dashboard. Four gaps fixed in a single pass.

---

### Critical — data never written (silently missing from CGT, portfolio, performance attribution)

## 34. `js/day-trading-analysis.js` — swing BUY creates no portfolio holding or CGT parcel ✅ FIXED

**File:** `js/day-trading-analysis.js` → `executeDayTrade()`
**Severity:** High — open swing positions invisible to CGT page; Portfolio page; drawdown monitor; NAV history

### Problem

`executeDayTrade()` wrote a journal entry and debited cash, but never called `applyBuyToPortfolio()`. Result:
- No entry in `state.portfolio` → position invisible to Portfolio page, correlation filter, and NAV/drawdown monitor while the trade is open
- No `cgtParcels` entry → CGT page has zero record of the trade
- No `parcelId` on the journal entry → `rollbackTradeJournalEntry` cannot undo the parcel if the user deletes the entry

### Fix

Call `applyBuyToPortfolio(ticker, qty, price, date, fees, sector)` before writing the journal entry. Store `newParcel.id` as `parcelId` on the journal entry. Add `sector` field (sourced from `state.liveSignals`). Cash deduction unchanged — `applyBuyToPortfolio` does not touch cash.

---

## 35. `js/pages/day-trading.js` — swing SELL creates no CGT disposal and misses portfolio removal ✅ FIXED

**File:** `js/pages/day-trading.js` → `_closeDayTrade()`
**Severity:** High — CGT disposal record missing; portfolio holding not removed on close; `disposalIds` absent from journal entry

### Problem

`_closeDayTrade()` manually computed P&L (`(closePrice − entryPrice) × qty − fees`) and credited cash, but never called `applySellToPortfolio()`. Result:
- No `cgtDisposals` entry → CGT page shows no disposal, no cost-basis calculation, no discount eligibility
- Portfolio holding from the BUY (now written correctly after fix #34) would not be removed on close
- Journal entry had no `disposalIds` link

### Fix

Call `applySellToPortfolio(ticker, qty, price, fee, date, method)` which: removes the portfolio holding, calls `matchSaleAgainstParcels()` (FIFO/LIFO), pushes to `state.cgtDisposals`, and credits cash. Use `disposalsToPnl(disposals)` for the net P&L. Store `disposalIds` on the journal entry. Cash is no longer manually credited (it's inside `applySellToPortfolio`). Fallback to manual arithmetic + manual cash credit when the holding is absent (recs executed before this fix).

---

## 36. `js/pages/day-trading.js` — intraday BUY never written to trade journal ✅ FIXED

**File:** `js/pages/day-trading.js` → `executeIntradayTrade()`
**Severity:** Medium — journal shows only the SELL/close leg; BUY leg is invisible while position is open

### Problem

`executeIntradayTrade()` only wrote to `state.intraday.openPositions`. The journal showed nothing until the position was closed — at which point only a SELL entry appeared. Any navigation to the Trade Journal page while a position was open showed no record of it.

### Fix

Write a `{action:'BUY', status:'open'}` journal entry immediately on execute. Store `_journalId` on the position object so `closeIntradayPosition` can patch the same entry rather than creating a duplicate SELL entry. Sector is sourced from `state.liveSignals`.

---

## 37. `js/pages/day-trading.js` — intraday close creates duplicate SELL entry instead of patching the BUY ✅ FIXED

**File:** `js/pages/day-trading.js` → `closeIntradayPosition()`
**Severity:** Medium — journal shows duplicate entries (one open BUY + one closed SELL); P&L on the BUY entry never updated

### Problem

`closeIntradayPosition()` always created a brand-new SELL entry. If an intraday BUY had been journaled at entry, you'd get two records for the same trade — one perpetually `status:'open'` and one `status:'closed'`. The BUY entry would show up in performance stats as an unclosed trade.

### Fix

On close, look up the open BUY entry by `pos._journalId`. If found, patch it in-place (`exitPrice`, `fees`, `pnl`, `status:'closed'`, `closeDate`, `sector`). If not found (position opened before the fix), create a fallback combined entry as before.

---

### Summary — Day Trading data flow fixes

| # | File(s) | Issue | Severity | Effort | Status |
|---|---|---|---|---|---|
| 34 | `js/day-trading-analysis.js` | Swing BUY creates no portfolio holding or CGT parcel | High | S | ✅ FIXED |
| 35 | `js/pages/day-trading.js` | Swing SELL creates no CGT disposal; portfolio holding not removed | High | S | ✅ FIXED |
| 36 | `js/pages/day-trading.js` | Intraday BUY not written to trade journal | Medium | S | ✅ FIXED |
| 37 | `js/pages/day-trading.js` | Intraday close creates duplicate SELL instead of patching BUY entry | Medium | S | ✅ FIXED |

### Remaining gaps (not fixed — see notes)

| Gap | Why deferred |
|---|---|
| Intraday today P&L not folded into `portfolioHistory` snapshots | Requires NAV calculation logic change; low risk in isolation but could skew drawdown monitor |
| Sector missing on pre-fix swing entries in existing `tradeJournal` | One-time migration needed; no automatic backfill |
| `recId` link on intraday close entries for learning loop | Intraday recs are separate from `state.recommendations`; requires learning loop wiring |

---

## App Auditor findings — Post-Sprint-48 (2026-06-05)

Full-app audit covering all blueprints, JS engine files, security, and data integrity. Grouped by severity.

---

### Critical — will crash or produce wrong results at runtime

## 27. `routes/market.py` — `log` missing from core import; NameError fires on every Stooq fallback

**File:** `routes/market.py:34`
**Severity:** Critical — silently breaks yfinance fallback path for both `/api/quote` and `/api/macro`

### Problem

```python
from core import LOG_DIR, ttl_cache, fetch_with_retry, stooq_quote
```

`log` is absent from the import. Lines 179 and 257 call `log.warning(...)` inside the Stooq fallback branches:

```python
# Line 179 — inside _quote_cached() Stooq branch
log.warning("quote: yfinance failed for %s — serving Stooq fallback", ticker)

# Line 257 — inside _macro_payload()._fetch_symbol() Stooq branch
log.warning("macro: yfinance failed for %s (%s) — Stooq fallback", name, sym)
```

Both call sites throw `NameError: name 'log' is not defined` the moment yfinance fails and the
Stooq fallback fires. The fallback logic itself (price fetch, `_source: 'stooq'` tagging) never
executes — the exception propagates to the caller. This defeats the entire third line of defence
added in Sprint 42.

### Fix

Add `log` to the import:

```python
from core import LOG_DIR, ttl_cache, fetch_with_retry, stooq_quote, log
```

---

## 28. `js/pages/assistant.js` — XSS on both user input and AI response (innerHTML with raw strings)

**File:** `js/pages/assistant.js:29, 159`
**Severity:** Critical — executes arbitrary JS from user-typed input or a compromised AI response

### Problem

Line 29 — user message injected raw:
```js
msgs.innerHTML += `<div class="msg msg-user">${msg}</div>`;
```

Line 159 — Claude API response injected raw:
```js
document.getElementById('typing').outerHTML =
  `<div class="msg msg-ai" style="white-space:pre-wrap">${reply}</div>`;
```

`escapeHTML()` exists in `utils.js` (loads before `assistant.js`) but is not called here.
A user who types `<img src=x onerror=alert(1)>` triggers JS execution in their own session.
More practically, a response from a compromised or injected AI output could auto-execute code.

### Fix

Wrap both with `escapeHTML()`:

```js
// Line 29
msgs.innerHTML += `<div class="msg msg-user">${escapeHTML(msg)}</div>`;

// Line 159
document.getElementById('typing').outerHTML =
  `<div class="msg msg-ai" style="white-space:pre-wrap">${escapeHTML(reply)}</div>`;
```

`escapeHTML` uses `textContent` round-trip so it is safe for multi-line text with newlines.

---

### High — silently wrong results

## 29. `js/quant-engine.js` — `Infinity` liquidity cap silently removed when ADV data is missing

**File:** `js/quant-engine.js:101–103`
**Severity:** High — allows a full-sized position in an illiquid stock when ADV data is absent

### Problem

```js
const qtyByLiquidity = advShares > 0
  ? Math.floor(advShares * (_ap.maxLiquidityPct ?? QUANT_CONFIG.maxLiquidityPct))
  : Infinity;
```

When `advShares` is 0 or missing (no ADV data returned by the backend), `qtyByLiquidity` is
set to `Infinity`. `Math.min(qtyByRisk, qtyByPosition, Infinity, qtyByKelly)` ignores the
`Infinity` constraint, meaning liquidity is completely unconstrained. The quant engine silently
sizes the position as though the stock has unlimited liquidity.

This can happen on fresh tickers, Stooq-fallback data that returns no volume field, or any
`analyse_ticker()` cache miss that returns partial signal data.

### Fix

Return a hard rejection when ADV is unavailable rather than treating it as unconstrained:

```js
const advShares = signals.volume_avg_20
  ?? (signals.adv_20 && price > 0 ? signals.adv_20 / price : null);

if (!advShares || advShares <= 0) {
  return { ok: false, reason: 'ADV data unavailable — liquidity constraint cannot be applied' };
}

const qtyByLiquidity = Math.floor(
  advShares * (_ap.maxLiquidityPct ?? QUANT_CONFIG.maxLiquidityPct)
);
```

If a hard rejection is too conservative (e.g. watchlist scans where ADV is optional), use a
conservative 1,000-share fallback cap instead of `Infinity`.

---

## 30. `indicators.py` — timezone mismatch in `days_to_earnings` calculation

**File:** `indicators.py:715, 719`
**Severity:** High — can throw `TypeError` at runtime or produce silently wrong `days_to_earnings`

### Problem

```python
# Line 715
days_to_earnings = (pd.Timestamp(first) - pd.Timestamp.now()).days

# Line 719
days_to_earnings = (pd.Timestamp(earn_ts.iloc[0]) - pd.Timestamp.now()).days
```

`pd.Timestamp.now()` returns a tz-naive timestamp. yfinance earnings dates (`stk.calendar`,
`stk.earnings_history`) are tz-aware (UTC). When both are present, pandas raises:

```
TypeError: Cannot compare tz-naive and tz-aware Timestamps
```

This exception is caught by the outer `except Exception: pass` block, leaving
`days_to_earnings = None`, which means `pre_earnings_risk` is always `False` — the 1.3×
ATR earnings adjustment never fires even when earnings are imminent.

### Fix

Strip timezone from the yfinance timestamp before subtraction:

```python
days_to_earnings = (pd.Timestamp(first).tz_localize(None) - pd.Timestamp.now()).days
# and
days_to_earnings = (pd.Timestamp(earn_ts.iloc[0]).tz_localize(None) - pd.Timestamp.now()).days
```

Or use tz-aware `.now()`:

```python
now_utc = pd.Timestamp.utcnow()
days_to_earnings = (pd.Timestamp(first).tz_convert('UTC') - now_utc).days
```

---

### Medium — data corruption or incorrect behaviour on edge inputs

## 31. `js/portfolio-helpers.js` — division by zero in CGT fee allocation when `saleQty = 0`

**File:** `js/portfolio-helpers.js:235`
**Severity:** Medium — produces `Infinity` fee-per-share that corrupts all CGT disposal records

### Problem

```js
const feePerShare = saleFees / saleQty;  // line 235
```

If `saleQty` arrives as 0 (malformed broker CSV row, manual data-entry error, or rounding in
FIFO allocation), `feePerShare = Infinity`. Every downstream calculation (`allocatedSaleFee`,
`grossGain`, `netGain`) silently becomes `Infinity` or `NaN`. These values flow into
`state.cgtDisposals` and persist to the DB via `saveStateToDb`.

### Fix

Add an early guard before the fee calculation:

```js
function matchSaleAgainstParcels(ticker, saleQty, salePrice, saleDate, saleFees, method) {
  if (!saleQty || saleQty <= 0) {
    return { disposals: [], remainder: 0, error: `Invalid sale qty: ${saleQty}` };
  }
  // ... rest of function
  const feePerShare = saleFees / saleQty;
```

---

## 32. `js/response-validator.js` — anti-churn 7-day guard bypassed for recs without timestamps

**File:** `js/response-validator.js:273`
**Severity:** Medium — anti-flip rule silently disabled for legacy or manually-entered recs

### Problem

The anti-churn rule checks whether a holding was recommended a different direction within the
last 7 days:

```js
const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
// ...
const recentFlip = history.some(h =>
  new Date(h.timestamp).getTime() > sevenDaysAgo && ...
);
```

When `h.timestamp` is `undefined` or `null` (recs imported via CSV, or older `recHistory`
entries before the timestamp field was added), `new Date(undefined).getTime()` returns `NaN`.
`NaN > sevenDaysAgo` is always `false`, so the anti-churn check silently passes and the flip
protection is disabled for those recs.

### Fix

Add a guard in the `history.some()` callback:

```js
const recentFlip = history.some(h => {
  if (!h.timestamp) return false;  // no timestamp = can't determine recency, skip
  return new Date(h.timestamp).getTime() > sevenDaysAgo && ...;
});
```

---

## 33. `js/response-validator.js` — `NaN` propagates into `ensembleConfidence` when `sig.score` is `NaN`

**File:** `js/response-validator.js:359–361`
**Severity:** Medium — `ensembleConfidence` becomes `NaN`; confidence gate at line 365 always fails

### Problem

```js
const indScore = sig?.score ?? null;          // line 359
r.ensembleConfidence = indScore != null
  ? Math.round((0.5 * r.confidence + 0.5 * (indScore / 100)) * 100) / 100
  : r.confidence;
```

`?? null` guards against `undefined` and `null`, but not `NaN`. If `sig.score` is explicitly
`NaN` (returned from a partial or errored `analyse_ticker()` response), `indScore` passes the
`!= null` check and `NaN / 100 = NaN` propagates into `ensembleConfidence`. Then:

```js
if ((r.ensembleConfidence ?? 0) < minConf && r.action !== 'HOLD') {
  rejected.push(...);  // NaN < minConf is always false → never rejected
}
```

A rec with bad signal data is not rejected — it passes the confidence gate unconditionally.

### Fix

Extend the null guard to cover `NaN`:

```js
const indScore = sig?.score;
const hasValidScore = indScore != null && !Number.isNaN(indScore);
r.ensembleConfidence = hasValidScore
  ? Math.round((0.5 * r.confidence + 0.5 * (indScore / 100)) * 100) / 100
  : r.confidence;
```

---

## Summary — Post-Sprint-48 audit

| # | File(s) | Issue | Severity | Effort |
|---|---|---|---|---|
| 27 | `routes/market.py` | `log` missing from core import → NameError on every Stooq fallback | **Critical** | XS |
| 28 | `js/pages/assistant.js` | XSS — user input and AI response injected raw into innerHTML | **Critical** | XS |
| 29 | `js/quant-engine.js` | `Infinity` liquidity cap when ADV missing → unconstrained position sizing | **High** | S |
| 30 | `indicators.py` | Timezone mismatch in `days_to_earnings` → TypeError or silent `None` | **High** | S |
| 31 | `js/portfolio-helpers.js` | Division by zero in `feePerShare` when `saleQty = 0` | Medium | XS |
| 32 | `js/response-validator.js` | Anti-churn guard bypassed for recs with undefined timestamp | Medium | XS |
| 33 | `js/response-validator.js` | `NaN` sig.score bypasses `ensembleConfidence` null guard → gate always passes | Medium | XS |

---

## Sprint 50 — Critics.md Review (2026-06-05)

Six actionable items from a full architecture review of `prompts.js`, `quant-engine.js`, and the learning loop. Two are prompt-only edits; three are code changes; one is a documentation fix.

---

### Critical — architecture violation

## 38. `js/prompts.js` Rule 16 — LLM told to do qty arithmetic; conflicts with quant engine architecture

**Files:** `js/prompts.js` (Rule 16), `js/quant-engine.js`
**Severity:** High — violates the "Claude never does arithmetic" design contract; LLM arithmetic is unreliable
**Effort:** M

### Problem

Rule 16 in `ANALYSIS_SYSTEM_PROMPT` instructs Claude to apply VaR1d-based sizing modifiers directly:

```
16. RISK-ADJUSTED SIZING: When PORTFOLIO RISK METRICS are present, apply these sizing
    modifiers to every BUY/TOP_UP before finalising qty:
    - Ticker VaR1d < -3.5% (flagged ⚠HIGH-VAR): reduce qty by 25%.
    - Ticker VaR1d < -5.0%: reduce qty by 50%.
```

This directly contradicts the architecture documented in `CLAUDE.md`:
> "Claude: Qualitative conviction only — what to buy/sell and why. **Never does arithmetic.**"
> "Quant engine: Deterministic sizing…"

In practice, `analysis.js` Step 3 overrides Claude's `qty` output entirely (Rule 4 sets qty=0 and the quant engine recalculates). So Rule 16 is **both architecturally wrong and functionally dead weight** — Claude's VaR-adjusted qty is immediately discarded anyway. The VaR1d value exists in `signals` and is available to the quant engine at sizing time.

### Fix

**Step 1 — `js/prompts.js`:** Replace Rule 16's arithmetic instruction with a qualitative flag output:

```
16. RISK-ADJUSTED SIZING: When PORTFOLIO RISK METRICS show elevated VaR1d for a ticker,
    note this risk in factorsUsed[] using one of these tags:
    - "HIGH_VAR: VaR1d < -3.5% — position size should be reduced"
    - "EXTREME_VAR: VaR1d < -5.0% — significant size reduction required"
    Do NOT compute an adjusted qty — the quant engine applies the size modifier deterministically.
```

**Step 2 — `js/quant-engine.js`:** Add VaR1d multiplier in `computeTradeParams()`, after the Kelly calculation and before the `Math.min` constraints:

```js
// VaR1d risk-adjusted size modifier — mirrors Rule 16 intent deterministically.
// signals.var_1d is the portfolio-level 1-day VaR (negative = loss, e.g. -4.2 = -4.2%)
const var1d = signals?.var_1d ?? 0;
const varMult = var1d < -5.0 ? 0.5
              : var1d < -3.5 ? 0.75
              : 1.0;
// Apply after Kelly but before the multi-constraint Math.min
rawQty = Math.floor(rawQty * varMult);
if (varMult < 1.0) rec._varAdjusted = true;  // badge on rec card
```

**Step 3 — `js/analysis.js`:** Add `_varAdjusted` badge rendering on rec cards (similar to `_preEarningsAdj` badge already in place).

### Key constraint

`signals.var_1d` comes from `GET /api/risk` which is only fetched for full portfolio analysis, not day-trade scans. Guard: `if (signals?.var_1d == null) varMult = 1.0`.

---

### Medium — UI transparency

## 39. `js/pages/learning.js` — Phase 8 z-score not shown in Learning Loop UI

**File:** `js/pages/learning.js`
**Severity:** Low — data already returned by API; just not displayed
**Effort:** XS

### Problem

`GET /api/learning/stats` already returns `phase8_meta.mann_whitney_z` and `mann_whitney_threshold` (1.28). The Learning page shows a binary "Phase 8 Active / Inactive" indicator but not the actual z-score. Users can't see how close calibration is to activating skill-weighting, which makes the system feel like a black box.

### Fix

In the Phase 8 status card in `renderLearning()`, expand the display:

```js
// Current — binary
const p8 = stats.phase8_meta;
const p8Label = p8?.active ? '✓ Active' : '✗ Inactive';

// Proposed — show z-score progress
const z      = p8?.mann_whitney_z?.toFixed(2) ?? '—';
const thresh = p8?.mann_whitney_threshold ?? 1.28;
const pct    = p8?.mann_whitney_z ? Math.min(100, Math.round((p8.mann_whitney_z / thresh) * 100)) : 0;

// HTML addition in the Phase 8 card:
`<div class="text-xs text-muted" style="margin-top:4px">
  z = ${z} of ${thresh} threshold (${pct}% of activation)
  ${p8?.active ? '' : `· ${(thresh - (p8?.mann_whitney_z ?? 0)).toFixed(2)} more needed`}
</div>`
```

This mirrors how Brier score and reliability bins are already shown below the calibration header.

---

### Easy — data quality gate

## 40. `js/analysis.js` / `js/response-validator.js` — `better_opportunity` rec renders without `alternativeTicker`

**File:** `js/response-validator.js` (validator schema) or `js/analysis.js` (post-processing)
**Severity:** Medium — bad learning event written to DB; `sell_verify_verdict` resolver always returns `inconclusive` for this rec because there's no ticker to compare against
**Effort:** XS

### Problem

When Claude outputs `sell_primary_driver: 'better_opportunity'` and the rec also includes `alternativeTicker: null` (or omits it entirely), the rec passes validation and enters the learning loop. But `_resolve_sell_outcomes()` in `routes/learning.py` checks `alternative_ticker` to validate the call — without it, the verdict is always `inconclusive`, polluting the sell-tag accuracy stats.

### Fix

In `response-validator.js`, add a `requiredWith` check for `better_opportunity` in the SELL/TRIM schema:

```js
// In the per-rec validation block, after the standard field checks:
if ((rec.sell_primary_driver === 'better_opportunity') &&
    (!rec.alternativeTicker || rec.alternativeTicker.trim() === '')) {
  // Auto-repair: demote to 'risk_management' so the rec still renders
  rec.sell_primary_driver = 'risk_management';
  rec._driverRepaired = true;
  repairLog.push(`${rec.ticker}: better_opportunity without alternativeTicker → demoted to risk_management`);
}
```

Alternatively, block validation entirely (return `{ok: false}`) and let the auto-repair loop re-prompt Claude. The auto-repair approach is more conservative and matches how other schema violations are handled.

---

### Prompt engineering — Rule 15

## 41. `js/prompts.js` Rule 15 — CGT arithmetic example missing; LLMs struggle with multi-step algebraic formulas in text

**File:** `js/prompts.js` (Rule 15, CGT discount window section)
**Severity:** Low — LLM may misapply the formula; a worked example dramatically improves reliability
**Effort:** XS

### Problem

Rule 15 (lines 74–76 of `prompts.js`) contains:

```
compare estimated tax saving vs bear-case expected further loss
(bear_prob × qty × entry × bear_ret)
```

LLMs reliably struggle with multi-step algebraic formulas embedded in prose. Without a concrete worked example, Claude is expected to substitute four numbers into the right formula while also writing JSON — error-prone.

### Fix

Append a filled-in worked example immediately after the formula in Rule 15:

```
Example: if tax saving = $400, and bear-case expected loss =
0.25 (bear_prob) × 100 (qty) × $50 (entry) × 0.20 (bear_ret) = $250,
then $400 > $250 → recommend WAIT for CGT discount.
If instead bear-case loss = $600 > $400 tax saving → recommend SELL now.
Show this arithmetic in factorsUsed[].
```

No code change required — `prompts.js` only.

---

### Prompt engineering — anti-churn rule

## 42. `js/prompts.js` Rule 22 — brokerage cost not listed as valid anti-churn override

**File:** `js/prompts.js` (Rule 22, CATASTROPHE definition, lines 228–239)
**Severity:** Low — edge case where round-trip brokerage exceeds remaining upside forces holding a position that should be exited
**Effort:** XS

### Problem

Rule 22's `CATASTROPHE` list that overrides the 7-day anti-churn block is:
- Trading halt / suspension
- Regulatory action / ASIC intervention
- Material news contradicting thesis (profit warning, CEO resignation)
- Force-majeure event

It does not include the case where round-trip brokerage exceeds the remaining expected gain. A trader who buys into a bad trade (entry error, news not available pre-trade) must hold for 7 days even when the quant engine shows `expectedProfit < fees × 2`. This is not churn prevention — it is forced loss-maximisation.

### Fix

Add one bullet to the CATASTROPHE list in `prompts.js`:

```
- Round-trip brokerage exceeds remaining expected gain
  (i.e. |expectedProfit| < brokerage_in + brokerage_out). Use sell_primary_driver:
  'risk_management', note in reasoning[]: "Brokerage override: exit cost justified".
```

No code change required — `prompts.js` only.

---

### Documentation fix

## 43. `IMPROVEMENTS.md` — Local LLM SELL/TRIM listed as "Open" but shipped Sprint 48

**File:** `IMPROVEMENTS.md`
**Severity:** Low — stale documentation confuses future planning
**Effort:** XS

### Problem

`IMPROVEMENTS.md` lists "Local LLM SELL/TRIM support" as an open item. `CLAUDE.md` documents it as shipped in Sprint 48 (extended from Sprint 41). `routes/debate.py → quick_analysis` handles BUY/TOP_UP/HOLD/SELL/TRIM with the 5-driver taxonomy. The "Open" status is stale.

### Fix

Update the relevant entry in `IMPROVEMENTS.md` open items section to:
- Change status from "Open" to "✅ Shipped Sprint 48"
- Add note: "5-driver taxonomy: thesis_broken, stop_triggered, target_reached, time_stop, risk_management. Recs show 🔒 Local badge. Exit stop direction validated post-response."

---

## Summary — Sprint 50 Critics Review

| # | File(s) | Issue | Severity | Effort | Status |
|---|---|---|---|---|---|
| 38 ✅ | `js/prompts.js`, `js/quant-engine.js`, `js/pages/recommendations.js` | Rule 16: LLM told to do qty arithmetic → moved VaR1d sizing to quant engine; Rule 16 now emits qualitative flag only | High | M | ✅ FIXED |
| 39 ✅ | `js/pages/learning.js` | Phase 8 z-score not displayed → added progress bar with z/threshold and % to activation | Low | XS | ✅ FIXED |
| 40 ✅ | `js/response-validator.js` | `better_opportunity` renders without `alternativeTicker` → auto-repaired to `risk_management` + `_driverRepaired` flag | Medium | XS | ✅ FIXED |
| 41 ✅ | `js/prompts.js` | Rule 15: no concrete CGT arithmetic example → worked example appended (bear_prob × qty × entry × bear_ret) | Low | XS | ✅ FIXED |
| 42 ✅ | `js/prompts.js` | Rule 22: brokerage cost not a valid anti-churn override → added as item (e) in CATASTROPHE list | Low | XS | ✅ FIXED |
| 43 ✅ | `IMPROVEMENTS.md` | Local LLM SELL/TRIM still listed as "Open" → updated to "✅ SHIPPED Sprint 48" with full description | Low | XS | ✅ FIXED |
