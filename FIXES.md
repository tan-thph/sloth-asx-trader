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
