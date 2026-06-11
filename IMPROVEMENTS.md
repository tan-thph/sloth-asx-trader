# Sloth ASX Trader — Improvement Roadmap (Personal Use)
**Last Updated:** 2026-06-11 (§9 external-review triage added; Sprints 61–65 shipped: §8 pipeline integrity, execution alpha, retrain nudge, flag-don't-drop, macro-brief persistence)

## 0. Post-Sprint-53 audit — ML evaluation gap (2026-06-09)

Surfaced by an architecture + bug audit after Sprints 50–53 landed (ML training engine,
quant enhancements, notifications). The headline item (I) is the only one rated high-value;
J and K are restatements of existing low-severity items scoped to the parts that matter.

| # | Area | Issue | Severity | Effort |
|---|---|---|---|---|
| ✓ **I** | `routes/day_trade_training.py` | **ML model reports in-sample R²/MAE** — **SHIPPED Sprint 54.** OOS R²/MAE now computed via walk-forward CV (n≥60) or chronological holdout (n<60). UI promotes OOS R² as primary stat. | ~~High~~ | ~~M~~ |
| J | `js/pages/cgt.js` | Float math for CGT disposal cost-base / gains (`cgt.js:378-383`). Negligible for personal scale, but it is the one path with an external consumer (ATO reporting). Sub-scope of roadmap item D. | Low | M |
| ✓ K | `test_app.py` | Frontend orchestration — **SHIPPED Sprint 57.** `_applyCorrSizing` and `_applyHeatBudget` extracted as pure helpers in `analysis.js`; 17 Vitest behavioural tests in `tests/analysis-pipeline.test.js` cover thresholds, scaling, blocking, and budget accumulation. | ~~Low~~ | ~~M~~ |

### Detail — I: ML engine reports in-sample fit (no out-of-sample evaluation)

**Where:** `routes/day_trade_training.py → _train_model_impl()`.

```python
weights, bias = _ridge_regression(X, y)          # trained on ALL rows
y_pred  = np.dot(X, weights) + bias              # scored on the SAME rows
r2_score = 1.0 - ss_res / ss_tot                 # → in-sample R²
```

Standardisation (`means`/`stds`) and NaN mean-imputation (`col_means`) are also fit on the
full matrix. The reported R²/MAE — and the R² shown in the Day-Trade Training UI
(`js/dt-training.js:281,477,511`) — therefore reflect fit, not forecast skill. With a
small sample (`MIN_TRAIN_SAMPLES = 30`) and a multi-feature ridge, in-sample R² can look
healthy while true out-of-sample R² is ~0 or negative.

This matters more than the usual "add a test" item because the model's output is meant to
*inform real trades*. The project already enforces this discipline elsewhere — look-ahead-bias
removal (§1.1) and the walk-forward backtester (§1.7, Sprint 20) — so the ML engine is the
one place the standard isn't yet applied.

#### Implementation plan — out-of-sample evaluation for the ML engine

**Goal:** report an honest out-of-sample (OOS) R²/MAE alongside the in-sample number, using a
*time-ordered* split (trades are sequential — random shuffling would leak future regimes into
past predictions). Deploy the full-data model as today; only the *reported metric* changes.

**Step 1 — Schema (`day_trade_db.py`)**
Add columns to `model_state` via the existing `ALTER TABLE` migration block (lines ~154-156):
`r2_oos REAL`, `mae_oos REAL`, `n_test INTEGER`, `cv_method TEXT` (`'walk_forward'` | `'holdout'` | `'insufficient'`).
Keep `r2_score`/`mae_score` as the in-sample values for backward compatibility.

**Step 2 — Evaluation in `_train_model_impl` (per scope, before the final fit)**
1. Re-sort `rows` **chronologically ascending** by `entry_date` (current query is `DESC`).
   The split must respect time order.
2. Choose method by sample size:
   - `n ≥ 60` → **expanding-window walk-forward**: 4–5 folds. Fold *k* trains on the first
     `start + k·step` rows, tests on the next `step` rows.
   - `30 ≤ n < 60` → **single chronological holdout**: train on first 70%, test on last 30%.
   - `n < 30` → already blocked by `MIN_TRAIN_SAMPLES`; set `cv_method='insufficient'`,
     leave OOS metrics `NULL`.
3. **Critical — fit transforms on train fold only** to avoid the leakage that a naïve split
   would introduce: compute `col_means` (imputation), `means`/`stds` (z-score), and
   `_ridge_regression` weights from the **train rows of that fold**, then apply them to the
   held-out rows. Do *not* reuse the full-data `means`/`stds` for scoring test rows.
4. Collect held-out predictions across folds → compute aggregate OOS R² and MAE.

**Step 3 — Final model unchanged**
After evaluation, refit on **all** rows for deployment (standard practice: evaluate OOS,
ship the full-data model). Persist in-sample R²/MAE *and* `r2_oos`/`mae_oos`/`n_test`/`cv_method`.

**Step 4 — UI (`js/dt-training.js`)**
Promote OOS R² to the primary stat card; relabel the existing R² as "Train fit (in-sample)"
and show it secondary/muted. Add a one-line caption: *"OOS = walk-forward held-out; train fit
overstates skill."* Show `cv_method` + `n_test` so the user knows how much it was validated on.

**Step 5 — Tests (`test_app.py`)**
- `r2_oos` present in the `/api/daytrading/train` response and persisted to `model_state`.
- Leakage guard: on a synthetic dataset, OOS R² computed with per-fold standardisation is
  **not greater than** in-sample R² (sanity: holdout ≤ train fit on noise).
- `cv_method` is `'insufficient'` and OOS metrics are `NULL` when `30 ≤ n < 60`… i.e. assert
  each branch sets the expected `cv_method`.
- Schema migration: `model_state` gains the four new columns (idempotent `ALTER TABLE`).

**Effort:** ~M (½ day). Self-contained in two files (`day_trade_training.py`, `day_trade_db.py`)
plus a UI label tweak and tests. No change to feature engineering, persistence shape (additive),
or the deployed model's weights.

**Acceptance:** training run returns and displays an OOS R² that is generally lower than the
in-sample R²; the UI no longer presents the optimistic number as the headline metric.

---

## 0. Shipped — Sprint 60 (2026-06-11)

| Fix / Feature | Area | Detail |
|---|---|---|
| **"Quiet Terminal" CSS redesign (Phases A+B)** | UX (M) | Full `asx_trading.css` rewrite. New design-token system: `--bg-base/surface/inset/hover`, `--text-primary/secondary/tertiary`, `--text-muted` alias (fixed 314 undefined usages), `--border` alias (fixed 91 undefined usages), `--shadow-card/pop/hover`, `--up/down/warn` + bg variants, `--chart-1..6`, `--chart-grid`. Dual dark-mode block: `@media (prefers-color-scheme:dark) :root:not([data-theme="light"])` + byte-identical `[data-theme="dark"]` attribute block. Tabular-nums on tables + metric values. Sticky topbar with `backdrop-filter: blur(12px)`. Active sidebar indicator bar (2.5px left). Cards with hover elevation. Token-driven badges (pill + dot). Button focus ring via `--accent-ring`. Skeleton shimmer utility. Dialog `::backdrop`. Motion guard. Scrollbar refinement. Deleted 3 redundant dark override blocks. Compact mode, mobile `@media`, `.tbl-stack`, safe-area all preserved unchanged. |
| **Chart theming (Phase C)** | UX (S) | `chartColor(token, fallback)` helper added to `js/charts.js` — reads CSS custom properties via `getComputedStyle(document.documentElement)` at draw time. All canvas hex colors in `drawHistoryChart`, `drawCandleChart`, `drawPriceChart` replaced: grids → `--chart-grid`, series → `--chart-1..6`, candle up/down → `--up`/`--down`, axes → `--text-tertiary`. Removed `isDark` matchMedia detection. |
| **Theme toggle (Phase D)** | UX (S) | `_applyTheme(theme)` in `js/utils.js` sets/clears `document.documentElement.dataset.theme` and updates `<meta name="theme-color">` for PWA chrome. `state.settings.theme: 'auto'` default added to `js/config.js`. Startup call in `js/init.js`. `settingsSetTheme()` + Auto / Light / Dark segmented control in Settings → Display card (`js/pages/settings.js`). |

---

## 0. Shipped — Sprint 59 (2026-06-10)

| Fix / Feature | Area | Detail |
|---|---|---|
| **§G — debate cache prune race** | Frontend (XS) | `_debatePruning` boolean flag in `js/debate-client.js` ensures only one concurrent caller runs the prune loop. Second concurrent caller skips the prune (entry was just added; it will be pruned on the next write after the flag clears). |
| **§H — `parseDate()` hardening** | Frontend (XS) | `detectStrategyDecay()` in `js/learning-loop.js` now uses a regex `^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$` to detect DD-MM-YYYY or DD/MM/YYYY; falls through to `new Date(s)` for ISO; NaN guard returns 0 instead of `NaN`. |
| **§2.7 — lessons from calib-quality** | Learning Loop (S) | `/api/debate/calib-quality` Ollama prompt now requests an optional `suggested_lesson` field (single actionable rule) when a `likely_systemic` band has ≥40% dominant tag. Learning page calib-quality card renders an amber banner with pre-filled text and a "+ Create lesson" button that POSTs to `/api/learning/lessons` with `source:'calib_quality'`. |
| **§K — mark shipped** | Docs (XS) | Marked §K (analysis pipeline Vitest tests) as shipped in IMPROVEMENTS.md (delivered Sprint 57). |

---

## 0. Shipped — Sprint 54 (2026-06-09)

| Fix / Feature | Area | Detail |
|---|---|---|
| **ML OOS evaluation (§0.I)** | Day Trade ML (M) | `routes/day_trade_training.py` `_train_model_impl()` now evaluates honest out-of-sample R²/MAE before the final all-data fit. Walk-forward CV (4 folds, n≥60) or single chronological 70/30 holdout (30≤n<60). `_fit_and_predict_fold()` helper fits imputation + z-score standardisation on train rows only — no leakage into test rows. OOS fields `r2_oos`, `mae_oos`, `n_test`, `cv_method` (`walk_forward`/`holdout`/`insufficient`) persisted to `model_state` and returned in the `/api/daytrading/train` response. |
| **UI: OOS R² as primary stat** | Day Trade UI (XS) | `renderDtModelTab()` in `js/dt-training.js` promotes OOS R² to the primary stat card (green ≥0.1, blue ≥0, red <0). In-sample R²/MAE shown in a secondary muted caption with the note "in-sample overstates skill". Train toast now reports "OOS R²=N.NNN" when available. |
| **History tab stuck-loading fix** | Day Trade UI (XS) | `_dtHistLoading` guard in `dt-training.js` prevents duplicate concurrent fetches when `_dtHistItems === null`. Fetch failure always resolves `_dtHistItems` to `[]` so the History tab shows empty state instead of an infinite spinner. `switchDtTab('history')` resets both `_dtHistItems` and `_dtHistLoading`. |
| **SQL whitelist constant (§0.E)** | Backend (XS) | `_ALLOWED_OUTCOME_COLS` named constant extracted from the inline `for col in (...)` tuple in `routes/learning.py → learning_outcome()`. Intention is now explicit; future column additions must go through the constant. |
| **Schema migrations** | DB (XS) | `day_trade_db.init_dt_db()` adds 4 new `model_state` columns via the existing safe `ALTER TABLE` migration block: `r2_oos REAL`, `mae_oos REAL`, `n_test INTEGER`, `cv_method TEXT`. |
| **Tests** | Testing | 8 new tests in `TestDayTradeTraining` (Sprint 54 block): schema migration presence, OOS fields in train response, OOS persisted to `model_state`, OOS R² ≤ in-sample R² leakage guard, `cv_method` branch coverage, UI source assertions for `r2_oos`/`R² (OOS)` labels, `_ALLOWED_OUTCOME_COLS` constant presence, inline tuple absence. Both test class setups updated with Sprint 54 migration columns. |

---

## 0. Post-Sprint-48 full-app audit — improvements identified (2026-06-05)

Items below were surfaced by a three-angle audit (backend Python, frontend JS, security/data
integrity). Critical and high-severity items are documented in `FIXES.md` items 27–33.
The following are medium-to-low severity improvements that do not warrant a fix entry.

| # | Area | Issue | Severity | Effort |
|---|---|---|---|---|
| ✓ A | `core.py` | `_cache_store` is unbounded — **ALREADY SHIPPED** (eviction + `_MAX_CACHE_SIZE` in `core.py`). | ~~Medium~~ | ~~S~~ |
| B | `core.py` | Thundering herd in `ttl_cache` — concurrent misses each compute the same expensive call | Low | S |
| ✓ C | `routes/backtest.py` | No input validation on tickers/period/strategy/capital — **ALREADY SHIPPED** (`ALLOWED_PERIODS`/`ALLOWED_STRATEGIES` guards in `routes/backtest.py`). | ~~Medium~~ | ~~S~~ |
| D | `routes/backtest.py` | Float arithmetic for money (P&L, cost, proceeds) — rounding errors accumulate across multi-trade backtests | Low | M |
| ✓ E | `routes/learning.py` | Dynamic SQL whitelist — **SHIPPED Sprint 54.** `_ALLOWED_OUTCOME_COLS` named constant extracted; `for col in _ALLOWED_OUTCOME_COLS` replaces inline tuple. | ~~Low~~ | ~~XS~~ |
| ✓ F | `js/utils.js` | Merged portfolio does not guard `shares <= 0` — **ALREADY SHIPPED** (`filter(h => h.shares > 0)` at `utils.js:44-48`). | ~~Medium~~ | ~~XS~~ |
| ✓ G | `js/debate-client.js` | Concurrent cache pruning race — **SHIPPED Sprint 59.** `_debatePruning` flag prevents two concurrent callers from independently sorting+deleting overlapping subsets. | ~~Low~~ | ~~S~~ |
| ✓ H | `js/learning-loop.js` | Date parsing (`parseDate()`) — **SHIPPED Sprint 59.** Replaced `parts[2].length === 4` heuristic with `String.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)` covering both `-` and `/` separators; NaN guard on fallback path. | ~~Low~~ | ~~S~~ |

### Detail — A: unbounded `_cache_store` in `core.py`

The `_cache_store` dict accumulates one entry per unique `(fn.__name__, args, kwargs)` tuple
and never evicts expired entries proactively — only on the next access after TTL. On a long-running
gunicorn server scanning 200 tickers across multiple functions, this grows to thousands of entries
and holds stale data in memory until accessed again. No maximum size guard exists.

**Recommended fix:** Add a proactive expired-entry sweep and a maximum size cap inside the lock:

```python
_MAX_CACHE_SIZE = 2000

def _evict_cache():
    now = time.time()
    expired = [k for k, v in _cache_store.items() if v[1] <= now]
    for k in expired:
        del _cache_store[k]
    if len(_cache_store) > _MAX_CACHE_SIZE:
        # Evict oldest-expiring entries
        oldest = sorted(_cache_store.items(), key=lambda x: x[1][1])
        for k, _ in oldest[:len(_cache_store) - _MAX_CACHE_SIZE]:
            del _cache_store[k]
```

Call `_evict_cache()` inside `ttl_cache`'s wrapper before the cache-miss check.

---

### Detail — B: thundering herd in `ttl_cache` (`core.py`)

Between the cache-miss check (inside the lock) and the actual function call (outside the lock),
multiple threads can simultaneously detect a miss and each invoke the expensive yfinance/Stooq
network call. On a 200-ticker scan with 8 threads, the same `analyse_ticker()` call can fire
8 times in parallel for the same ticker when the TTL expires mid-scan.

**Recommended fix:** Use a per-key `threading.Event` sentinel to park concurrent waiters while
the first thread computes the value:

```python
_cache_inflight: dict = {}  # key → threading.Event

# On cache miss:
with _cache_lock:
    if key in _cache_inflight:
        ev = _cache_inflight[key]
    else:
        ev = threading.Event()
        _cache_inflight[key] = ev

if ev is not None:
    ev.wait(timeout=seconds)  # park until first compute completes
    with _cache_lock:
        entry = _cache_store.get(key)
    if entry:
        return entry[0]
```

For this personal tool the current behaviour is acceptable (just wastes network calls) — flag for
a future engineering pass rather than an immediate fix.

---

### Detail — C: missing input validation on `/api/backtest` (`routes/backtest.py`)

The backtest endpoint accepts JSON without validating:
- `tickers` is a list (could be a string or dict) and is non-empty and within a safe length
- `period` is one of `{"3mo","6mo","1y","2y"}` — invalid value is passed to yfinance and returns empty data
- `strategy` is one of the supported names — unrecognised strategy falls through silently
- `capital` is numeric and within sane bounds (`float()` throws `ValueError` on non-numeric)

**Recommended fix (minimal):**

```python
ALLOWED_PERIODS   = {"3mo", "6mo", "1y", "2y"}
ALLOWED_STRATEGIES = {"rsi_trend", "macd", "bb_reversion", "momentum", "buy_hold", "sma_crossover"}

data = request.get_json() or {}
tickers = data.get("tickers", [])
if not isinstance(tickers, list) or not tickers or len(tickers) > 100:
    return jsonify({"error": "tickers must be a non-empty list of up to 100 items"}), 400

period = data.get("period", "1y")
if period not in ALLOWED_PERIODS:
    return jsonify({"error": f"period must be one of {sorted(ALLOWED_PERIODS)}"}), 400

strategy = data.get("strategy", "rsi_trend")
if strategy not in ALLOWED_STRATEGIES:
    return jsonify({"error": f"strategy must be one of {sorted(ALLOWED_STRATEGIES)}"}), 400

try:
    capital = float(data.get("capital", 50000))
    if capital <= 0 or capital > 10_000_000:
        raise ValueError
except (ValueError, TypeError):
    return jsonify({"error": "capital must be a number between 1 and 10,000,000"}), 400
```

---

### Detail — F: missing `shares <= 0` guard in merged portfolio (`js/utils.js`)

`mergedPortfolio()` (or its equivalent in `utils.js`) computes `avgPrice = h._totalCost / h.shares`
after merging multiple parcels of the same ticker. If `h.shares` ends up as 0 due to data
corruption (e.g. a zero-qty DRP entry, a reconcile bug, or a split applied twice), the result is
`Infinity`. This propagates into `unrealisedPnl`, `weight`, and all downstream portfolio metrics.

**Recommended fix:** Filter out zero-share entries after the merge step:

```js
return merged
  .filter(h => h.shares > 0)
  .map(h => ({
    ...h,
    avgPrice: h._totalCost / h.shares,
    currentPrice: h.currentPrice ?? h.avgPrice,
  }));
```

---

## 0. Shipped — Sprint 48 (2026-06-04)

| Fix | Area | Detail |
|---|---|---|
| **SELL/TRIM schema** | Local LLM | `_SCHEMA_QUICK_ANALYSIS` now includes SELL and TRIM in the action enum, plus `primary_driver` and `urgency` fields. Exit recs from local Ollama are fully supported for the first time. |
| **System prompt rewrite** | Local LLM | `_LOCAL_ANALYSIS_SYSTEM` rewritten with explicit EXIT RULES section: stop-above-entry direction rule, 5-driver taxonomy (`thesis_broken`, `stop_triggered`, `target_reached`, `time_stop`, `risk_management`), urgency levels, and SELL/TRIM vs BUY/TOP_UP field requirements. |
| **Truncation 4000→6000 chars** | Local LLM | Context window for local model raised to 6000 chars (Sprint 47 tiering reduced message size ~30–40%, giving headroom for exit context including unrealised P&L and stop levels). |
| **Post-processing validation** | Local LLM | `quick_analysis()` now validates each SELL/TRIM rec: adds `primary_driver="thesis_broken"` default if absent, adds `urgency="routine"` default if absent, corrects stop to `entry×1.03` if below entry (tags `_stopRepaired=True`). |
| **Badge title fix** | Frontend | `🔒 Local` badge tooltip updated from "BUY/HOLD only" to "simplified 5-driver taxonomy". SELL/TRIM `primary_driver`/`urgency` rendering was already generic — confirmed it works for local recs. |
| **CLAUDE.md gotcha #32** | Docs | Updated to reflect SELL/TRIM support, 5-driver taxonomy, and stop-direction correction. Endpoint table and state docs updated accordingly. |
| **Tests** | Testing | `TestQuickAnalysisSellTrim` (5 tests): schema enum, exit fields, system prompt content, stop repair logic, default driver insertion. |

---

## 0. Shipped — Sprint 47 (2026-06-04)

| Fix | Area | Detail |
|---|---|---|
| **Fix 1 — maxTokens 6000→8000** | AI Pipeline | `callClaude('portfolio')` in `analysis.js` now passes `maxTokens: 8000`, matching the `_AGENT_MAX_TOKENS.portfolio` default in `claude-client.js`. Removes token truncation on large portfolios. |
| **Fix 2 — ACTIVE_REGIME at top of message** | AI Pipeline | `ACTIVE_REGIME:` line moved to line 3 of the user message (after account settings, before Holdings). Previously appended at the very end after 7,000+ chars of indicator data. Uses `__REGIME_PLACEHOLDER__`/`__CONF_PLACEHOLDER__` in the static template, resolved after `fetchAndClassifyRegime()`. Regime transition note inlined into the regime line. |
| **Fix 3 — Stop ATR aligned to regime engine** | AI Pipeline | Rule 3 in `ANALYSIS_SYSTEM_PROMPT` now says "use stopAtrMultiple from ACTIVE RULE OVERRIDES" instead of hardcoded 1.5×. `rulesCtx` injects the regime-aware `_regimeStopMult` (from `getRegimeModifiers().stopAtrMult`: 2.5–4.0×) via `__STOP_MULT_PLACEHOLDER__`. Claude's R:R gate now uses the same stop distance the quant engine applies. |
| **Fix 4 — Tell Claude qty=0** | AI Pipeline | Rule 4 now instructs Claude to set qty=0. Section 7 check (b) updated to SKIP (quant engine handles cash feasibility). Output schema qty field annotated as "always 0 — quant engine sets final qty". Saves ~40-60 output tokens per rec. |
| **Fix 5 — Indicator block tiering** | Token efficiency | `_isCandidate(s, t)` helper splits tickers into Tier 1 (full 12-line block) and Tier 2 (1-line compact summary). Tier 2 fires for stable holds with no active setup. Conditions: watchlist (always Tier 1), RSI<38/>68, BB<0.12/>0.88, score>=65/<30, pre-earnings, volSpike (VZ>2.5), unrealised P&L <-8% or >25%. |
| **Fix 6 — Rules before indicators** | AI Pipeline | `${rulesCtx}` now precedes `${indicatorCtx}` in the user message template. Claude reads operative thresholds before processing 7,500+ chars of indicator data. |
| **Fix 7 — Lessons top 2 sectors** | AI Pipeline | Lessons fetch now weights sectors by portfolio value and sends the top 2 as a comma-separated `sector` param (was: first sector only). `routes/learning.py` `lessons_list()` endpoint updated to split comma-separated sector and use `sector IN (...)` SQL for multi-sector match. |
| **Fix 8 — Rec history days-ago** | AI Pipeline | `recentRecs` formatter now appends `(Nd ago)` after each date, e.g. `2026-06-01 (3d ago)`. Claude no longer needs to compute recency for the 7-day anti-churn check. |
| **Fix 9 — scenarios optional** | Token efficiency | `scenarios` field in output schema changed from required to optional. Validator: type constraint removed; p-sum check (`scenarios-p-sum` business rule) fires only when field is present. Saves ~40-60 output tokens/rec when Claude omits it. |
| **Bonus — ⚡VOLSPIKE flag** | AI Pipeline | Ticker header line now prefixed with ` ⚡VOLSPIKE` when `volume_z_score > 3`. Visible at both Tier 1 and Tier 2. Gives Claude an immediate visual signal before the indicator block. |

---

## 0. Hotfixes (2026-06-04)

| Fix | Area | Detail |
|---|---|---|
| **`fetch_with_retry` 4xx fix** | Reliability | `_http_status()` helper in `core.py` detects HTTP status from `requests.HTTPError`/`urllib.error.HTTPError`. 4xx errors (except 429) now break the retry loop immediately — Yahoo returning 400 Bad Request was being retried 3 times for no benefit. 429 gets a minimum 5s sleep before retry. |
| **Auto-debate triggers removed** | UX / Reliability | `triggerCalibQualityIfStale()` removed from `analysis.js`. `triggerPostmortem()` and `fetchSkillScore()` auto-calls removed from `markExecuted()` in `recommendations.js`. Calib-quality card loads with `cache_only=1` and shows "▶ Run debate" when no cached result. `routes/debate.py` accepts `?cache_only=1` to return cached result without calling Ollama. |
| **`currentPrice` fix in analysis prompt** | Accuracy | `portfolioJson` in `analysis.js` now uses `livePrice = state.liveSignals[ticker]?.current_price ?? h.currentPrice` consistently for ALL price-derived fields (currentPrice, value, unrealisedPnl, unrealisedPnlPct, weight). Fixes SELL/TRIM `priceRange` anchoring to stale portfolio cache price rather than the force-refreshed signal price. |
| **Phase 8 gate in `_calib_compute()`** | Accuracy | `_calib_compute()` calibration block now uses `_mann_whitney_z(wins, losses) > 1.28` to gate Phase 8 skill weighting — was using raw mean comparison, which could flip Phase 8 on/off based on a single high-skill outlier. Aligned with `_compute_phase8_meta()` (stats endpoint). |
| **`_HL_MAP` + `_REGIME_GROUPS` regime name alignment** | Accuracy | Phantom regime names (`bearVolatile`, `bearTrending`, `bullTrending`, `neutral`) removed from `_HL_MAP` and `_REGIME_GROUPS` in `_calib_compute()`. Now keyed on actual names from `classifyRegime()`: panic=20d, riskOff=30d, highVol=35d, trend=45d, riskOn=50d, sideways=60d. `_REGIME_GROUPS`: bearish={riskOff,panic}, bullish={riskOn,trend}, neutral={highVol,sideways}. |
| **DB pragma parity** | Reliability | `announcement_engine.py` and `news_engine.py` local context managers now set `synchronous=NORMAL`, `mmap_size=268435456`, `cache_size=-65536`, `temp_store=MEMORY` — matching the pragmas in `db.get_db()`. Prevents WAL contention and cache-size mismatches when these engines write concurrently with the main app. |
| **6 audit bugs** | Various | DRP multi-account fix (`applyDrpEvent()` now matches by ticker + activeAccount); `universe_excluded` / `universe_verified_at` returned by `GET /api/db/load`; auto-brief function name typo (`generateMorningBrief` → `generateMorningBriefing`); settings path fix; unrealisedPnlPct inconsistency in portfolioJson resolved by livePrice fix above. |

---

## 0. Shipped — Sprint 46 (2026-06-04)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Broker CSV SELL import** | Workflow (M) | `POST /api/import/csv` now returns SELL rows in a `sells` array instead of `skipped`. Frontend `handleBrokerCSV()` detects `result.sells`, shows a `<dialog>` confirmation table with FIFO-computed cost basis, gain/loss, CGT discount eligibility, and per-parcel CGT-at-risk warnings (⏰ badge for parcels 320–364 days old). "Apply SELL imports" button calls `_applyImportedSells()` which uses `matchSaleAgainstParcels()` (FIFO, respects `state.cgtMethod`), updates `state.cgtDisposals`, reduces `holding.shares`, and logs to `state.tradeJournal` with `imported:true`. Tickers with no open parcels are skipped with a warning toast. |
| **Rebalancing suggestions modal** | Risk page (M) | "📋 Suggest Rebalance" button added to Target Allocations & Drift card header (visible when targets are set). `showRebalanceSuggestions()` opens a `<dialog>` modal rendering `_buildRebalanceSuggestions()` — deterministic, no AI call. Computes drift for all tickers in portfolio + target map; filters out <1% drift and <1 share trades; sorts by largest drift; shows BUY/TRIM action, share count, estimated value, and CGT discount-at-risk warning (⚠ for parcels 320–364 days old). Cash shortfall alert shown when total BUY value exceeds `state.cash`. |
| **ASX universe exclusion list** | Scanner (S) | `POST /api/market/universe-exclude` and `DELETE /api/market/universe-exclude` persist an exclusion list to `blob_store` key `universe_excluded`. `market_scan_start()` in `routes/scanner.py` merges blob_store exclusions with any per-request exclude list before launching the scan thread. `intraday_scan()` in `routes/intraday.py` filters excluded tickers from the input list. `universe_health()` returns `excluded` list in response. Settings page: "Check Now" shows per-ticker "Exclude" buttons next to stale tickers; excluded list rendered with "Re-include" buttons; badge shows count next to Check Now. |

> **Scope:** This is a **private, single-user, local** decision-support tool. It is *not* a public
> product — so multi-user auth, tenant isolation, financial-services licensing, ToS/Privacy, and
> data-**redistribution** licensing are explicitly **out of scope**. Improvements here focus on
> three things that matter for your own trading: **signal accuracy**, **reliability/data quality**,
> and **useful features** that make day-to-day trading decisions faster and more disciplined.

Each item carries an effort (S/M/L/XL) and impact (★–★★★) rating for triage.

---

## 0. Shipped — Sprint 45 (2026-06-04)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Thesis drift detection** | Analytics (M) | `_compute_thesis_drift(conn)` in `routes/learning.py` compares avg `realized_pnl_pct` of manual early exits vs target hits (n≥5 each). Emits `⚠EARLY_EXIT_DRAG` calibration nudge when drag >3pp. `GET /api/learning/thesis-drift` endpoint exposes the raw stats. Learning page gains async `renderThesisDriftCard()` — two stat boxes (manual vs target avg P&L) with a green/amber summary line. Nudge is lowest-priority in calibration block (first dropped by budget truncation). |
| **Stop-loss trailing** | Workflow (S) | "📍 Trail" button added to every pending BUY/TOP_UP/SELL/TRIM rec card in `recommendations.js`. `trailStop(recId)` uses live price + ATR from `state.liveSignals` and `getRegimeModifiers().stopAtrMult` to compute a new stop. Only tightens (never loosens). Confirms via `confirm()` dialog. Marks `rec._stopTrailed = true`, `rec._stopTrailedAt = ISO string`. Re-renders page and calls `scheduleSave()`. `📍 Trailed` badge shown in rec card header when trailed. |
| **Scheduled morning briefing** | Workflow (S) | `state.settings.autoBriefTime` ('HH:MM' AEST, empty = disabled) added to `config.js`. Settings → Display section gains a time input. `checkAutoBriefSchedule()` defined in `scheduler.js` — checks `localStorage.autoBriefFiredDate` (YYYY-MM-DD) to fire at most once per day; compares current AEST time (UTC+10 fixed offset) against configured time; calls `generateMorningBriefing()` if not already fired today. Called from `autoRefreshPrices()` (every 10–20 min) and once at end of `initApp()`. |

---

## 0. Shipped — Sprint 44 (2026-06-04)

| Fix / Feature | Area | Detail |
|---|---|---|
| **§2.6 DRP parcel tracking** | Workflow (M) | Portfolio page gains a "DRP" button per holding row. Clicking opens a modal (shares, price/share, settlement date, optional dividend amount). `applyDrpEvent()` recalculates weighted `avgPrice`, adds a `state.cgtParcels` entry (`action:'DRP'`), and logs to `state.tradeJournal`. CGT page shows an indigo `DRP` badge on DRP parcels. `badge-drp` CSS added. `actionBadge()` in `utils.js` handles DRP. Journal filter includes DRP option. |
| **§1.12 Virtual-outcome speed weighting** | Calibration (S) | `virtual_speed_weight REAL` column added to `ai_learning_events` via `_LE_MIGRATIONS`. `_resolve_virtual_outcomes()` now writes `speed_weight = min(1.0, 7.0 / hold_days)` — trades that hit target in 7d get weight=1.0; 29d → ~0.24. `_weight()` in `_calib_compute()` multiplies the existing 0.75× virtual discount by `virtual_speed_weight`. |
| **§1.11 Regime-change calibration penalty** | Calibration (S) | On regime flip, `fetchAndClassifyRegime()` writes `regime_flipped_at` and `regime_flipped_to` to `localStorage`. `fetchCalibrationBlock()` passes them as query params. Backend `_calib_compute()` halves the half-life (`hl = max(10, hl // 2)`) for the first <10 trades in the new regime when flip was within 30d; emits `⚠REGIME_FLIP(Nd ago, N trades, hl=Nd)` token in the calibration block. |
| **§2.6 Lessons market-breadth scope** | Workflow (M) | `breadth_scope TEXT` column added to `trading_lessons` via `init_db()`. Valid values: `adl_below_0.3`, `adl_above_0.7`, `high_vol`, `low_vol`, `null` (always inject). `GET /api/learning/lessons` accepts `adl` and `asx_vol` params and filters scoped lessons accordingly. `POST /api/learning/lessons` accepts `breadth_scope`. Create Lesson form in `learning.js` gains a breadth-scope dropdown. `analysis.js` passes `adl` + `asx_vol` from `state.macroData` to the lessons fetch. |

---

## 0. Shipped — Sprint 43 (2026-06-03)

| Fix / Feature | Area | Detail |
|---|---|---|
| **§3.8 Hoist `_detectExitReason` to `utils.js`** | Tech debt | Single canonical copy now in `js/utils.js`. Removed duplicate definitions from `recommendations.js` and `performance.js`. `utils.js` loads first — both page files resolve the global at call time. Tests updated: `detect-exit-reason.test.js` extracts from `utils.js`; `test_detect_exit_reason_direction_aware` validates `utils.js` and asserts neither page file redefines it. |
| **§3.10 Stooq rate-limit semaphore** | Reliability | `_stooq_sem = threading.BoundedSemaphore(1)` in `core.py`. Both `stooq_quote()` and `_fetch_stooq_history()` in `indicators.py` acquire the semaphore; a 1-second sleep in the `finally` block paces requests to Stooq's undocumented ~1 req/sec limit. Prevents silent empty-CSV responses under parallel batch scans. |
| **§3.9 `FACTOR_WEIGHTS` normalization guard** | Safety | `indicators.py` emits `warnings.warn` at import time if `sum(FACTOR_WEIGHTS) != 100`. Catches misconfiguration before it silently corrupts scanner scores. |
| **§2.7 "Why this rec?" traceability panel** | UX ★★★ | `analysis.js` attaches `_genRegime`, `_genRegimeConf`, `_calibSnap` (≤350 chars of the calibration block), and `_signalsSnap` (9 signal fields) to every rec at generation time. Each pending rec card in `recommendations.js` now has a collapsed `<details>` section showing: regime + confidence badge, signal chips (RSI/ADX/BB%B/ATR/Score/OBV/MACD/Vol×/RS), calibration nudge monospace block, and cached Ollama debate synthesis if available. Arrow rotates on expand via `details[open] .trace-arrow` CSS. |

---

## 0. Shipped — Sprint 41 (2026-06-03)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Macro page optimistic stale rendering** | UX (§3.4) | `renderMacroPage(gen)` async wrapper added to `macro.js`. On navigation, renders cached `state.macroData` immediately; if data is >5 min stale, kicks a silent background `GET /api/macro` fetch (no disruptive spinner, no `renderPage()` at start) and shows a small "⟳ Refreshing…" badge in the header. `_macroRefreshing` guard prevents concurrent refreshes. `state.macroLastFetch` timestamp set on both user-initiated `fetchRealMacro()` and background auto-refresh. |
| **Earnings calendar auto-fetch on navigation** | UX (§3.4) | Macro page auto-calls `fetchEarningsCalendar()` if earnings are missing for portfolio tickers. Dashboard case in `navigation.js` also kicks `fetchEarningsCalendar()` if the Upcoming Catalysts card has no data. `fetchEarningsCalendar()` now sets `state.earningsLastFetch` timestamp and re-renders on `dashboard` (previously only `macro`). |

---

## 0. Shipped — Sprint 40 (2026-06-02)

| Fix / Feature | Area | Detail |
|---|---|---|
| **RBA rate 6h in-memory cache** | Performance (§3.4) | Extracted `_rba_rate_cached()` with `@ttl_cache(seconds=21600)` in `routes/market.py`. Previously the route always made a live HTTP scrape to `rba.gov.au` on every call (macro page refresh, Settings load, etc.) before falling back to the DB 7d cache. Now the successful result (live or DB) is held in memory for 6h, cutting the network call to at most once per 6h. `RuntimeError` on total failure is not cached by `ttl_cache` (exception propagates without storing), so the next call retries immediately. User-set rate override and 4.35 fallback remain unchanged in the route. |
| **Signals page optimistic rendering** | UX (§4) | `renderSignalsPage()` now renders stale `state.liveSignals` immediately on navigation; kicks a background `fetchSignals()` that re-renders when done (with a "⟳ Refreshing…" badge in the header). Full spinner shown only on first cold load (no cached data). Module-level `_sigRefreshing` guard prevents duplicate concurrent refreshes. |

---

## 0. Shipped — Sprint 39 (2026-06-02)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Polymarket fetch parallelization** | Performance (§3.4) | `/api/polymarket` now dispatches all 6 Manifold API queries in parallel via `ThreadPoolExecutor` instead of a serial list comprehension. Worst-case latency drops from 6×8s=48s to a single 8s timeout when all succeed. Typical latency improvement: 3–5s → ~1s on cache miss. |
| **Polymarket loading state** | UX (§3.4) | `fetchPolymarket()` sets `window._pmFetching=true` and calls `renderPage()` before the fetch, disabling the button and showing a spinner row inside the Prediction Markets card. `finally` block clears flag. |
| **Earnings-calendar 4h per-ticker cache** | Performance (§3.4) | Extracted `_get_ticker_earnings_cached(ticker)` with `@ttl_cache(seconds=14400)` in `routes/market.py`. Previously, every call made 3 yfinance HTTP round-trips per ticker (`info`, `calendar`, `earnings_history`) — repeated loads of the Dashboard economic calendar or Signals page incurred the full cost each time. ThreadPoolExecutor still provides parallel dispatch on cache misses. |
| **`_preEarningsAdj` forwarded through quant merge** | Bug fix | `computeTradeParams()` correctly set `_preEarningsAdj: true` when pre-earnings stop widening (1.3×) fired, but `analysis.js` only forwarded named fields from the quant result. The flag was silently dropped, so the `📅 Pre-earnings` badge never appeared on rec cards. Fixed by adding `_preEarningsAdj: qt._preEarningsAdj` to the merge. 3 new quant-engine tests + 2 new regime-engine tests for stopAtrMult monotonicity (127 JS tests total). |
| **Survivorship bias disclosures in backtest** | Accuracy (§1.5) | Added an amber warning panel to Technical backtest results (alongside the existing total-return disclosure) and a footer note to the Walk-Forward methodology box. Both explain that current ASX200 constituents are used — delisted/dropped stocks are excluded and returns may be overstated. Treat absolute figures as indicative; use Sharpe/win-rate for cross-strategy comparisons. |
| **Capital-returns-check endpoint** | Data quality (§1.9) | New `GET /api/portfolio/capital-returns-check?tickers=...` in `routes/portfolio.py`. Fetches `stk.dividends` for the last 90 days; flags any single payment ≥5% of current price as a potential special dividend / capital return. Portfolio page calls `checkCapitalReturns()` alongside `checkPortfolioSplits()` on load; shows an orange banner with date, amount, and per-share figure when flagged. `state._capitalReturnWarnings` mirrors `state._splitWarnings`. 5 new tests (3 endpoint, 2 frontend). |
| **Mobile / responsive layout (§4)** | UX | Added `@media (max-width: 768px)` block to `asx_trading.css`: sidebar slides in as an overlay (transforms from `translateX(-100%)` to `translateX(0)`) with a semi-transparent backdrop. Hamburger button (`☰`) appears in the topbar on mobile; hidden on desktop. `toggleMobileSidebar()` / `closeMobileSidebar()` added to `navigation.js`; `showPage()` auto-closes the sidebar on any navigation. Grid layouts collapse to single column at 768px. Tables and content padding already handled by `.table-wrap` and existing grid media queries. |
| **IMPROVEMENTS.md stale ✓ cleanup** | Docs | Marked 8 shipped items as ✓ in §2.1–2.7 tables: Target allocations, Cash/TD tracker, Franking 45-day, Economic calendar, A-VIX, Correlation-aware sizing (exact), Thesis review at exit, Prompt A/B tracking. Removed stale "Remaining:" notes from §5. Added Sprint 37–38 and open items to §5. |

---

## 0. Shipped — Sprint 38 (2026-06-02)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Sell tag calibration injection** | Learning Loop | `_calib_compute()` in `routes/learning.py` now queries `sell_verify_verdict` per `sell_primary_driver` (n≥3, verifiable drivers only). Adds part 9 to the calibration block: `⚠SELL_TAG:time_stop(n=11,val=27%)→CUTTING WINNERS:extend hold` when `inval_rate≥50%`; `✓SELL_TAG:thesis_brk(n=12,val=67%)→reliable` when `val_rate≥65%`. Excluded: `position_sizing`, `risk_management`, `tax_optimisation`, `regime_change` (unverifiable by price). Capped at 3 drivers; subject to Gap 8 token-budget truncation. |
| **Section 6 sell tag interpretation** | Prompts | `ANALYSIS_SYSTEM_PROMPT` Section 6 now tells Claude how to act on `⚠SELL_TAG` / `✓SELL_TAG` lines. `⚠` → require one additional confirming signal, prefer `urgency='monitor'`; CUTTING WINNERS means `time_stop` only valid at ≥3× expected hold with flat price; alt rarely better means `better_opportunity` requires a clearly superior entry. `✓` → standard evidence threshold applies. |
| **Calibration cache thread lock (Fix #8)** | Backend | `threading.Lock()` added to `routes/learning.py`. Guards `_calib_cache` reads and writes; expensive `_calib_compute()` runs outside the lock. Prevents partial cache-write corruption under concurrent gunicorn threads. |
| **Phase 8 Mann-Whitney gate (Fix #10)** | Learning Loop | `_mann_whitney_z(wins, losses)` replaces mean comparison in `_compute_phase8_meta()`. Uses U-statistic normalised to Z-score; `active = z > 1.28` (one-sided p<0.10). Single high-skill outlier no longer flips Phase 8 on/off. |

---

## 0. Shipped — Sprint 37 (2026-06-02)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Sell tag outcome tracking (Gap 3)** | Learning Loop | `_resolve_sell_outcomes(conn)` in `routes/learning.py` — lazy-evaluated inside `_calib_compute()`. Finds executed SELL/TRIM events with `sell_primary_driver` set, 25+ days old, and unverified. Fetches yfinance price at sell date and now; computes `sell_verify_sold_chg`. Verdicts: `validated`/`invalidated`/`inconclusive` per driver. `target_reached`: validated if sold ≤+5%; `thesis_broken`/`stop_triggered`: validated if < −5%; `position_sizing`/`risk_management`/`portfolio_rebalance`: always inconclusive. Capped at 5 resolutions per calibration call — shares the 5-min TTL. |
| **`better_opportunity` cross-check (Gap 7)** | Learning Loop | `alternative_ticker` column added to `ai_learning_events`. Logged at SELL/TRIM generation time from `analysis.js` (`r.alternativeTicker`). `_resolve_sell_outcomes()` fetches alt ticker price history from sell date → now; computes `sell_verify_alt_chg`. Validated if alt outperformed sold by >3pp, invalidated if < −3pp. |
| **Sell Decision Tracker UI card** | Learning Page | `renderSellOutcomesCard()` async card on Learning page. Shows ticker, driver, P&L, and 30d verdict per executed SELL. Colour-coded badges (🟢 validated / 🔴 invalidated / — inconclusive). "↺ Check Now" button triggers `?force=1` re-resolve. Pending events shown with "Pending (≥25d)" label. |
| **`GET /api/learning/sell-outcomes`** | Backend | New endpoint. Returns executed SELL/TRIM events with `sell_primary_driver IS NOT NULL`, ordered by timestamp DESC. `?force=1` param triggers an immediate resolve before returning. |

**Already shipped (confirmed in Sprint 37 audit):**
- Thesis review at exit — `_showThesisReview()` fires in `markExecuted()` on full position close
- ATR-based debate cache invalidation — `atr_pct` is in the signal hash; cache auto-invalidates on ATR spikes
- Economic calendar on Dashboard — `_buildEconomicCalendarCard()` live, shows RBA + ex-div + earnings in 45d window
- Exact correlation-aware sizing — `analysis.js` lines 819–857: fetches `/api/risk` correlation matrix post-analysis; reduces BUY qty by 30% (|corr|>0.7) or 50% (|corr|>0.85)

---

## 0. Shipped — 2026-05 sprints (through Sprint 27)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Ollama structured outputs (format_schema)** | AI Quality (Sprint 23) | All 6 JSON-producing Ollama endpoints now pass `format_schema` via Ollama's native `format` parameter. Engine constrains token generation at grammar level — valid JSON guaranteed without regex fallback. Schemas: `_SCHEMA_POSTMORTEM`, `_SCHEMA_WIN_TAG`, `_SCHEMA_SYNTHESIS`, `_SCHEMA_EXIT_SYNTHESIS`, `_SCHEMA_PM_SYNTHESIS`, `_SCHEMA_SKILL`. |
| **ESS calibration gates** | Accuracy (Sprint 23) | All `n≥3` raw count guards replaced with Kish ESS≥2.5. `_ess(subset) = (Σwi)²/Σwi²`. Low-ESS subsets emit warning tokens instead of confidence nudges. Prevents a 4-trade sample dominated by 3 stale 90-day-old entries from appearing statistically reliable. |
| **Signal flattening for postmortem/skill** | AI Quality (Sprint 23) | `_flatten_entry_signals()` helper — 12 key diagnostic fields in compact pipe-separated format. Reduces postmortem prompt overhead ~200 tokens vs raw JSON dump; improves small-model extraction accuracy. |
| **Cloud adjudicator provider picker** | UX (Sprint 22) | User can select Gemini, Groq, or Claude API explicitly for adjudication. Provider picker modal when multiple keys configured. Auto-detect still available (Gemini → Groq → Claude). |
| **Blind adjudication** | AI Quality (Sprint 24) | Random alias swap ("Analyst Alpha"/"Analyst Beta") before building cloud adjudicator prompt. Prevents halo-effect bias where cloud models prefer certain model families by name. `score_alpha`/`score_beta` fields; winner un-swapped via `blind_map`; `blind_swap`/`alias_a`/`alias_b` stored in `phase_4` for audit. |
| **JS Ollama priority queue** | Reliability (Sprint 24) | `_oqEnqueue(fn, priority)` in `debate-client.js`. HIGH lane for user-initiated calls; LOW lane for auto-triggers. Prevents background auto-postmortems from blocking user's next manual debate call for minutes. |
| **Skill-weight centering at 5** | Accuracy (Sprint 24) | `_weight()` formula: `max(0.2, min(1.8, sk/5.0))`. Old formula centered at 10 — a skill=8 trade was penalised vs unscored. Now unscored=1.0, neutral skill=1.0, high skill amplified up to 1.8×. |
| **Hierarchical regime fallbacks** | Accuracy (Sprint 24) | Calibration falls through: specific regime → macro group (bearish/bullish/neutral) → all trades when ESS<2.5. Prevents freshly-transitioned regimes from getting no calibration signal at all. |
| **Volatility-adaptive half-life** | Accuracy (Sprint 25) | `_HL_MAP` in `_calib_compute()`: panic=20d, riskOff=30d, highVol=35d, trend=45d, riskOn=50d, sideways=60d, default=45d. Non-default hl shown in calibration block header (`hl=Nd`). *(Phantom regime names removed in hotfix 16bba99)* |
| **SQLite startup maintenance** | Reliability (Sprint 25) | `PRAGMA optimize` + `PRAGMA wal_checkpoint(PASSIVE)` in `init_db()`. Non-blocking; prevents index-stat decay and WAL file growth under heavy JSON blob accumulation. |
| **Phase 6: Calibration quality debate card** | AI Quality (Sprint 26) | `GET /api/debate/calib-quality`. Backend pre-computes binomial SE + Z-scores (`_norm_cdf` via `math.erfc`, no scipy). Prompt presents statistical verdict as immutable fact — model constrained to qualitative failure-tag analysis only. Traffic-light badges (🟢/🟡/🔴) on Learning page. Auto-triggered once daily via `triggerCalibQualityIfStale()` (LOW priority queue). |
| **Success Patterns UI card** | Analytics (Sprint 27) | Learning page card showing dominant win tags with count, win rate bars, and calibration nudge explanation. Backed by step 6b in `_calib_compute()` and `success_patterns` field in `/api/learning/stats`. 5 supported tags: `confluence_entry`, `trend_aligned`, `catalyst_driven`, `tight_stop_well_placed`, `momentum_entry`. |
| **Success tag calibration nudge** | Accuracy (Sprint 27) | Step 6b in `_calib_compute()` mirrors L2 dominant error check for wins. Emits `✓tag(N/Mwins,ESS=X.X)→lean into this` when ≥33% of tagged wins share a tag and ESS≥2.5. |
| **Walk-forward backtesting engine** | Accuracy (Sprint 20) | Rolling train/test split + per-fold parameter grid-search. `POST /api/backtest/walk-forward`. Walk-Forward tab in Backtest page. Fold-by-fold table + stitched OOS equity curve + B&H benchmark. |
| **Factor stability / overfitting guard** | Accuracy (Sprint 21) | K-fold cross-validation of 8 `_score_ticker` signal factors. Information Coefficient (Spearman) in-sample vs OOS. `POST /api/scanner/factor-stability`. Factor Stability tab in Market Scanner. |
| **Security hygiene** | Reliability (Sprint 21) | gunicorn binds `127.0.0.1:5000` (was `0.0.0.0`). CORS restricted to localhost origins. Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` added to every response. |
| **Vitest JS test suite** | Reliability (Sprint 19) | 122 JS unit tests for pure engine files (`quant-engine`, `regime-engine`, `response-validator`, `_detectExitReason`). `npm run test:js`. |

---

## 0a. Shipped — 2026-05 sprints (through Sprint 18)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Monthly seasonality card** | Research (§2.4) | `GET /api/seasonality/<ticker>` (24 h TTL). Fetches 10yr monthly price history, computes avg/min/max return and win-rate per calendar month. Signals page detail view shows a 12-bar horizontal chart with current month highlighted and per-bar tooltips. `window._seasonalityCache` stores results for the session. |
| **Error recovery + retry buttons** | UX (§3.4) | `_retryBtn(label, onclick)` and `_emptyCard(icon, title, body, actions)` helpers added to `utils.js`. `risk.js` now shows an amber error banner + retry button when yfinance is rate-limited instead of silently showing blank metrics. `performance.js` equity curve section shows an error card + retry on `nav-history` failure instead of silently hiding the chart. `portfolio.js` no-holdings state upgraded to an actionable first-run card with "Import Broker CSV" and "Add Trade Manually" CTAs. |
| **Split CGT auto-adjust** | Workflow (§1.9) | When the existing split-warning banner appears on Portfolio page, each split now has an "Apply split" button. `applySplitAdjustment(ticker, ratio, date)` multiplies `holding.shares` and all open CGT parcel `qty`/`remainingQty` by the ratio, divides `avgPrice` and `costPerShare`, then dismisses the warning and saves state. One-confirm guard prevents accidental double application. |

---

## 0a. Shipped — 2026-05 sprints (through Sprint 14)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Direction-aware `_detectExitReason`** | Learning Loop | SELL/TRIM recs frame the stop *above* and target *below* entry (the inverse of BUY/TOP_UP). The classifier assumed a long frame for everything, mislabeling profitable trims as `stop_hit`. **51% (37/72) of closed events were contradictory.** Now flips comparisons on `action`; fixed in both `recommendations.js` and `performance.js`; covered by `test_detect_exit_reason_direction_aware`. |
| **Per-entry parent reconciliation** | Learning Loop | On a full-position close, each parent BUY/TOP_UP event is judged against *its own* entry and stop/target, not the closing SELL's blanket outcome. |
| **Removed invalid `^XJOA` macro fetch** | Data layer | Not a real Yahoo symbol → 404 every 5-min refresh, and `advance_decline_ratio` was permanently `null`, so the regime breadth vote never fired. Removed; documented as dormant until a real breadth source is wired. |
| **Historical data backfill** | Data | Recomputed `exit_reason` for 72 closed events with corrected logic (66 updated; contradictions 37 → 9). DB backed up first. |
| **Automated daily DB backups** | Reliability (§3.2) | `db.py::backup_db()` copies DB to timestamped file on startup and every 24 h; keeps last 7 copies. Background daemon thread in `asx_server.py`. |
| **HTML-escape external text** | Security (§3.6) | Added `escapeHTML()` to `utils.js`; applied to `item.title`, `item.summary`, `item.content` (news), `headline`, `summary` (announcements), `r.reasoning`, `r.risks` (recommendations). Prevents layout breakage from hostile RSS/AI text. |
| **Wilson 95% CI on Learning Loop stats** | Accuracy (§1.3) | `_wilson_ci()` in `routes/learning.py`; `ci_lo`/`ci_hi` now returned on all win-rate fields. Calibration engine gated at n<30 (returns `available:False`). Learning page shows CI columns and calibration status. |
| **Calibration sample-size gate** | Accuracy (§1.3) | `_calib_compute` returns early if fewer than 30 closed events — prevents calibration from chasing noise in early-stage data. |
| **CGT discount urgency banner** | Tax (§2.2) | CGT page shows a yellow banner listing any profitable parcel within 45 days of the 12-month mark. Recommendations page `_showPreTradeChecklist` includes a CGT warning when selling with days-to-discount < 45. |
| **Pre-trade checklist modal** | Workflow (§2.6) | Five-item discipline gate fires before `markExecuted`. Requires ≥ 4 ticks to enable "Execute", with override available. No DB change — ephemeral. |
| **Trade tags field** | Workflow (§2.6) | `tags` and `trade_thesis` columns added to `ai_learning_events` via `_LE_MIGRATIONS`; accepted by `/api/learning/log` and `/api/learning/outcome`; inline tags input added to each rec card. |
| **Portfolio heat gauge** | Risk (§2.5) | Risk page now shows total $ at risk to stop vs a user-configurable budget (default 5% of portfolio). Colour-coded bar: green < 60%, orange < 85%, red ≥ 85%. Budget editable inline. |
| **Slippage modelling in backtest** | Accuracy (§1.2) | `routes/backtest.py` now applies entry fill = `price × (1 + slippage_pct)` and exit fill = `price × (1 - slippage_pct)`. Equity curve updated. Response includes `slippagePct`, `totalBrokerageCost`, `totalSlippageCost`. UI: slippage % input + friction cost breakdown panel in `js/pages/backtest.js`. |
| **yfinance retry + stale-cache fallback** | Reliability (§3.1) | `fetch_with_retry()` in `core.py` with exponential backoff and `_last_good` stale-cache per key. Quote and macro endpoints now use it. |
| **Data-staleness badge** | UX (§1.10) | Quote endpoint stamps `fetched_at` (UTC ISO). `prices.js` stores timestamps per ticker in `state.priceTimestamps`. Portfolio table shows `⚠ stale` badge when data is >25 min old. |
| **Brier score + reliability diagram** | Accuracy (§1.4) | `GET /api/learning/calibration-stats` returns `brier_score` (MSE of confidence vs outcome) and per-band calibration bins. Learning page shows a Brier score metric card + CSS bar reliability diagram. |
| **Telegram off-device alerts** | Alerts (§2.3) | `routes/alerts.py` with `POST /api/alerts/telegram` (send), `POST /api/alerts/telegram/save` (persist creds), `GET /api/alerts/config`. Settings page has a Telegram section (bot token + chat ID + Test button). `fireAlert()` in `alerts.js` mirrors to Telegram when `state.settings.telegramEnabled`. |
| **Drawdown monitor** | Risk (§2.5) | `renderPerformance()` now computes current and max drawdown from `state.portfolioHistory`. Two new metric cards + a red alert banner when drawdown exceeds the configurable threshold (default 10%). Threshold editable inline. |
| **Broker CSV import (CommSec + SelfWealth)** | Workflow (§2.6) | `routes/import_csv.py` with `POST /api/import/csv` — detects CommSec/SelfWealth/generic format, normalises to `{action, ticker, shares, price, date, brokerage}`. Portfolio page has a "Broker CSV" upload button; `handleBrokerCSV()` applies returned rows to portfolio, CGT parcels, and journal. |
| **Watchlist page** | Features (§2.1) | `js/pages/watchlist.js` — separate from holdings. `state.watchlist = [{ticker, addedAt, notes}]`. Signal table (RSI, score, BB%B, trend), indicator-alert creation UI, scanner ⭐ button writes to both watchlist and `extraTickers`. Persisted in `blob_store`. |
| **Benchmark overlay (^AXJO)** | Analytics (§2.1) | `GET /api/benchmark?period=` in `routes/market.py`. `drawHistoryChart()` now async with cached `_benchmarkCache`. ^AXJO normalized to portfolio start value; grey dashed 4th series + legend entry. |
| **Custom indicator alerts** | Alerts (§2.3) | `checkIndicatorAlerts()` in `alerts.js`; types: `rsi_below`, `rsi_above`, `bb_breakout`, `bb_breakdown`, `volume_spike`; called after `fetchSignals()`. Watchlist page has an indicator-alert creation UI. |
| **Ex-div & earnings reminders** | Alerts (§2.3) | `checkExDivReminders()` / `checkEarningsReminders()` in `prices.js`; one-shot per event per day. 5-day ex-div window, 3-day earnings window. |
| **Macro / regime-change alert** | Alerts (§2.3) | `fetchAndClassifyRegime()` fires `fireAlert()` when regime flips to `panic` or `riskOff`. |
| **Tax-loss harvest planner** | Tax (§2.2) | Card on CGT page: ranks open parcels by unrealised loss, shows max harvestable, net CGT after harvest, EOFY countdown, wash-sale warning (same ticker bought in last 30 days). |
| **Scenario stress test** | Risk (§2.5) | Card on Risk page: -5/-10/-20/-30% shock presets + custom input. Per-holding impact = `value × beta × shock`. Shocked portfolio summary. `window._stressScenario` persists across renders. |
| **ATR trailing stops** | Risk (§2.5) | Card on Risk page below stress test: 2×ATR14 stop per holding; one-click "Set Alert" wires into price-alert system. |
| **Saved screener presets** | Research (§2.4) | `state.savedScreeners = [{name, savedAt, config}]`; ⊕ Save/Load/Delete in scanner config bar. Persisted in `blob_store`. |
| **Market breadth revival** | Accuracy (§1.8) | Scanner computes `breadth_ratio` (% universe > 20-day SMA) after each scan; `/api/macro` reads it via lazy import as `advance_decline_ratio`; regime breadth vote now fires. |
| **Postmortem digest** | AI (§2.7) | `GET /api/learning/digest-data` returns structured failure stats. "Generate Digest" button on Learning page calls `callClaude('assistant', …)` with failure patterns to produce actionable lessons. |
| **Morning briefing auto-generate** | AI (§2.6) | `MORNING_BRIEFING_SYSTEM_PROMPT` + `'briefing'` agent type (600 tokens, no-cache). Dashboard "Generate Brief" button chains macro + regime + holdings into a plain-text session note cached in `window._morningBrief`. |
| **EOFY tax pack** | Tax (§2.2) | `GET /api/tax/eofy-pack?year=N` returns ZIP: `cgt_disposals_FY{N}.csv` + `trade_fees_FY{N}.csv`. "↓ EOFY Pack" button on CGT page. |
| **Regime overlay on journal** | Analytics (§2.4) | `_journalRegimeBadge()` helper + `Regime` column per row in Trade Journal; matches via `state.recHistory.find(r => r.id === t.recId)?.regime`. |
| **Stale-position nudge** | Workflow (§2.3) | `_buildStaleNudgeCard()` on Dashboard: amber card listing holdings with no rec in 14+ days with day counts. |
| **Persistence bug fix (watchlist/savedScreeners)** | Reliability | `watchlist` and `savedScreeners` were in the save payload but missing from `BLOB_KEYS` in `routes/portfolio.py` and the `db_load` response — silently discarded on every restart. Fixed. |
| **Portfolio-aware Q&A** | AI (§2.7) | `sendChat()` in `assistant.js` now injects `state.currentRegime` (regime + confidence + signals) and `state.macroData` (ASX200, VIX, AUD/USD, sentiment, bullish%) into the system prompt's `MARKET REGIME` + `MACRO DATA` sections. |
| **Performance attribution** | Analytics (§2.4) | `_buildAttributionCard(closedTrades)` added to `performance.js`: two side-by-side tables — P&L by sector (from holding.sector) and P&L by regime at entry (matched via recId → recHistory.regime). |
| **Sector concentration warning** | Risk (§2.5) | `_sectorConcentrationWarning(rec)` in `recommendations.js`: amber/red badge on BUY rec cards when the rec's sector already > 70% of the sector concentration limit in the portfolio. Uses `state.portfolio[i].sector` — no backend call. |
| **Thesis capture** | Workflow (§2.6) | Thesis textarea added to each rec card; captured at `markExecuted` and stored as `rec._thesis`; passed to learning loop as `trade_thesis`; persisted in `histEntry._thesis`; shown as tooltip (📋) on journal "Rec: Yes" badge. |
| **Dividend income forecast + franking credits** | Tax / Analytics (§2.2) | `_buildDivForecastCard()` in `performance.js`: per-stock 12-month income, grossed-up income (100% franked at 30% corp tax), franking credits, frequency, yield on cost. Portfolio totals: cash income + grossed-up + franking credit estimate. |
| **Thesis review at exit** | Workflow (§2.6) | `_showThesisReview()` in `recommendations.js`: `<dialog>` modal fires when a position fully closes; shows the original entry thesis; three verdict buttons (Held / Partial / Broken) post to `/api/learning/outcome` with a `[THESIS: …]` notes tag for postmortem analysis. |
| **Prompt version P&L** | Analytics (§2.1) | `routes/learning.py` stats query now sums `realized_pnl_aud` per prompt version; Learning page Prompt Version History table gains a "Realised P&L" column (green/red). |
| **Target allocations + drift alerts** | Risk (§2.5) | `state.targetAllocations = {}` (ticker → target weight %); `_buildTargetAllocCard()` on Risk page shows Actual% vs Target% with inline edit inputs; amber when |drift| ≥5%, red when ≥10%. Persisted in `blob_store` via `targetAllocations` in `BLOB_KEYS`. |
| **Economic calendar** | Workflow (§2.6) | `_buildEconomicCalendarCard()` on Dashboard: 45-day forward window with hard-coded RBA meeting dates (2026–2027), ex-div dates from `state.dividendData`, and earnings dates from `state.earningsCalendar`. |
| **Franking 45-day rule** | Tax (§2.2) | `_buildFranking45DayCard()` on CGT page: iterates open parcels, checks each against its ex-div date; warns when the 45-day continuous-holding requirement around the ex-div date is at risk of not being met. |
| **A-VIX proxy** | Analytics (§2.4) | `asx_vol_20d` (20-day realized annualized vol of ^AXJO) added to `/api/macro` payload; displayed as "A-VIX (ASX 20d)" in the Macro page Market Risk card; feeds two new votes into `regime-engine.js` (>25% → highVol, <12% → riskOn). |
| **Cash & term-deposit tracker** | Workflow (§2.6) | `state.termDeposits = []` persisted in `blob_store`; `_buildCashTrackerCard()` on Dashboard shows idle cash + each TD with maturity countdown; computes "Deployable ≤30d" total; `addTD()` / `removeTD()` helpers. |
| **Exact correlation-aware sizing** | Risk (§2.5) | After Claude generates BUY recs, `analysis.js` fetches `/api/risk` with portfolio + rec tickers; reduces `qty`/`riskAUD` by 30% when |corr| > 0.7 or 50% when > 0.85 with any existing holding; annotates rec with `_corrNote`; shown as ⚡ Corr badge on rec cards. |
| **Macro endpoint perf** | Reliability (§3.4) | `_macro_payload()` refactored: `^AXJO` fetched once at `period="3mo"` in the parallel block (previously fetched separately at 5d + 3mo = 2 serial calls); `AUDUSD=X` and `TIO=F` fetched at `period="1mo"` so 5d-change is computed from cached history (eliminates 2 more serial calls). Net: 3 serial yfinance fetches removed. |
| **Keyboard shortcuts** | UX (§4) | `g`+letter page navigation added to `navigation.js` (IIFE); covers 14 pages. `?` toggles a `<dialog>` shortcut help panel. Shortcuts are suppressed when focus is in an input/textarea. |
| **Prompt + response logging** | Debug/Audit | `ai_call_log` DB table. Every `callClaude()` call auto-logs: agent_type, model, system_prompt (8k cap), user_message (30k cap), response, tokens (in/out/cache_read/written), duration_ms. File output enriched with prompt header. New `GET /api/log/ai_calls` + `GET /api/log/ai_call/<id>` browse endpoints. Settings page "Recent AI Calls" card with agent filter + modal viewer. |
| **Side-by-side ticker compare** | Research (§2.4) | New `js/pages/compare.js`. Up to 4 ASX tickers. Score bar chart + full indicator table (RSI, MACD, BB%B, ATR, Stoch, CCI, ADX, MFI, OBV, SMA20/50, 1w/1m/3m returns, buy/sell signals). Color-coded cells. Navigate: g+x, ↔ Compare nav button. Watchlist ↔ button pre-loads watchlist into compare inputs. |
| **Prompt version A/B delta** | AI (§2.7) | Learning Loop prompt version table now has Δ vs prev column: shows win-rate delta (pp) with ↑/↓/↔ arrow; greyed out when either version has <3 closed events. Current version highlighted with indigo "current" badge. |
| **ETF filter for earnings calendar** | Reliability | `_fetch_earnings` checks `quoteType` from yfinance info; returns `{skipped:'ETF'}` for ETF/MUTUALFUND/MONEYMARKET — eliminates 404 log noise without a fragile static ticker list. |
| **App Info card in Settings** | UX (§4) | Shows `PROMPT_VERSION`, `CLAUDE_MODEL`, server version/uptime, last DB backup date. `GET /health` now returns `version`, `uptime_s`, `last_backup`. |
| **Forming-bar guard** | Data quality (§1.1) | `_drop_forming_bar(hist)` in `indicators.py` drops the current-day daily candle before 07:00 UTC (ASX close + 45-min settlement). Prevents incomplete intraday bar from inflating RSI/MACD/vol during market hours. Called in `analyse_ticker()` after every yfinance/Stooq fetch. |
| **Stooq fallback data provider** | Reliability (§3.1) | `_fetch_stooq_history(ticker, period)` in `indicators.py`. When yfinance returns empty or < 30 bars, retries via `https://stooq.com/q/d/l/?s=bhp.au&i=d` (free, no key). Ticker conversion: `BHP.AX` → `bhp.au`. Returns same OHLCV schema. Uses `_HTTP_SESSION` from `core.py`. |
| **Stop-proximity pre-warning** | Alerts (§2.3) | `checkStopProximityAlerts()` in `alerts.js` fires a `fireAlert()` + `toast()` when price is within `state.settings.stopProximityPct` % (default 3 %) of a stop, BEFORE the stop is breached. Direction-aware: BUY checks `(price − stop) / price`; SELL/TRIM inverts. One-shot via `_proximityAlertedAt`; re-arms when price retreats to 2× threshold. Called from `prices.js` after every price refresh. Configurable in Settings (0 = disable). |
| **Position age + unrealised P&L enrichment** | AI accuracy | `_daysHeld(ticker)` helper in `analysis.js` queries `state.tradeJournal` for the earliest open BUY/TOP_UP. Both `daysHeld` and `unrealisedPnlPct` now included in `portfolioJson` sent to Claude — enabling time-aware recommendations ("held 60 days at −8%"). |
| **ASX100 intraday same-day strategy** | Features | New `routes/intraday.py` + `js/intraday-strategy.js`. Scans ASX100 5m intraday bars for VWAP-discounted, RSI-oversold setups; composite score 0–100; hard gate 10:45–15:00 AEST only. New ⚡ Intraday tab in Day Trading page with configurable target % (default 3.5%), stop % (1.5%), max 2 positions. Open positions tracker with live P&L. `checkIntradayCloseouts()` fires time-stop alert at 15:00 AEST. `POST /api/intraday/scan` (batch, 8 threads, 2-min TTL); `GET /api/intraday/<ticker>` (single). |
| **Intraday universe selector + scan hardening** | Features / Reliability | Intraday tab now has universe switcher buttons (ASX20 / ASX50 / ASX100 / ASX200) stored as `state.intraday.params.universeKey`. Removed delisted `IPL.AX` from all universe lists; replaced with `WGX.AX`. Scan switched from `pool.map` to `as_completed` with 8s per-ticker timeout and 15 workers — stale/slow tickers no longer block the entire batch. |
| **Compare tab moved into Market Scanner** | UX | ↔ Compare is now the third tab inside Market Scanner (alongside Opportunities and Screener) rather than a standalone sidebar page. `showPage('compare')` in `navigation.js` transparently redirects to the Scanner and sets `_scannerTab='compare'`; keyboard shortcut g+x unchanged. `compareFromOutside()` still works from Watchlist and other pages. |
| **Groq/Gemini API keys consolidated to Settings** | UX | Moved Groq and Google Gemini API key inputs from News Scanner LLM card and Announcements LLM Settings panel into Settings → API Keys section. News/Announcements show status badge + "Manage key in Settings" link. `_saveNewsSettings()` used cross-page (script load order safe). |
| **Debate Phase 3: neutral synthesis** | AI Quality | Replaced one-sided challenge round (Model A defending its own tags against Model B's critique) with a neutral synthesis pass: a single call presenting both models' tags and reasons equally, asking for the best reconciliation. `source` label changed to `debated-synthesis`. Root-cause tag guidance added to `_pm_build_prompt()`. Learning page Phase 3 display updated. |
| **TRIM/SELL ATR stop floor** | Accuracy | `analysis.js` post-processes SELL/TRIM recs after the quant engine: if `stopLoss − entry < 1.5 × ATR_14`, auto-repairs to `entry + 2.5 × ATR`. Prevents near-zero stop distances (e.g. +0.2% = 60:1 R:R) from the AI. Rec flagged with `_stopRepaired: true`. |
| **Intraday Extreme Mode** | Features | New toggle in ⚡ Intraday config card bypasses entry-window (10:45–15:00 AEST), VWAP and RSI gates for testing outside market hours. Only `minScore` threshold still applied (configurable). Stored as `state.intraday.params.extremeMode`. |
| **Intraday universe buttons + params render dynamically** | UX | `updateIntradayParam()` now calls `renderPage()` after saving, so clicking universe buttons (ASX20/50/100/200), changing config inputs, and toggling Auto-refresh visually update immediately without a full page reload. |
| **§1.1 Look-ahead bias: AI Replay fixed, backtest documented** | Accuracy (§1.1) | **AI Replay** (`/api/backtest/ai-replay`): switched from `auto_adjust=True` to `auto_adjust=False` — forward exit prices are now nominal (unadjusted), matching the basis of actual executed entry prices. Previously, dividend-adjusted exit prices vs nominal entry prices understated BUY returns by ~div_yield per period and overstated SELL/TRIM returns. **Strategy Backtest**: signal timing (RSI, MACD, BB, ADX) is NOT affected (all are scale-invariant); P&L reflects total return (capital gains + notional dividend reinvestment). Both endpoints now emit `priceBasis` + `priceBasisNote` metadata. Backtest UI shows a disclosure banner explaining total-return basis; trade log price columns labelled "(adj.)". `indicators.py` `analyse_ticker` and `_fetch_stooq_history` document why `auto_adjust=True` is correct for live signal generation. |
| **Compact/density mode** | UX | `.compact` CSS body class reduces card padding, table row heights, and button sizes. Toggle in Settings → Display. Applied on startup from `state.settings.compactMode`. |
| **In-app changelog** | UX | Settings → "What's New" panel shows collapsible sprint history (Sprints 9–13, most recent open by default) without leaving the app. |
| **Macro page loading state** | UX | `fetchRealMacro()` sets `window._macroFetching=true` and calls `renderPage()` before the fetch — button goes disabled + "fetching…" and a spinning skeleton card appears. `finally` block clears flag and re-renders. |
| **Corporate-actions split detection** | Data quality | New `GET /api/portfolio/splits-check?tickers=...` endpoint in `routes/portfolio.py` — uses `yf.Ticker.splits` to find any split in the last 90 days. Portfolio page shows an amber warning card listing affected tickers when splits are found. `checkPortfolioSplits()` fires once per page load (cached in `state._splitWarnings`). |
| **Liquidity-scaled slippage** | Accuracy (§1.2) | Backtest now supports `slippage_mode: 'liquidity'` in addition to `'flat'`. ADV-tiered rates: >$10M ADV→0.05%, $2–10M→0.10%, $0.5–2M→0.20%, <$0.5M→0.35%. Per-ticker `effectiveSlippagePct` returned in `ticker_results`. UI: radio buttons "Flat / Auto (ADV-tiered)"; hides flat slider when auto selected; per-ticker slip% column in results table. |
| **Signals page: full candlestick chart** | UX | Upgraded per-ticker sparkline → full OHLCV candlestick chart reusing `drawCandleChart` from `charts.js`. Candle/Line mode toggle + BB and SMA50 overlays, stored per-ticker in `_sigChartOpts`. Canvas height 180→280px for volume strip and labels. |
| **Journal: monthly P&L bar chart** | Analytics | `_buildMonthlyPnlCard()` draws a canvas bar chart of monthly realised P&L (last 18 months). Green/red bars on a zero baseline with Y-axis grid. Summary stats: winning/losing months, best/worst month. Shown above the filter bar when ≥2 months of data exist. |
| **Portfolio: sector sidebar** | Analytics | Replaced canvas donut with `_buildSectorSidebar()` — CSS grid (`1fr 220px`) places a sector + per-holding sidebar to the right of the Holdings table. Sector bars width-scaled to the largest sector; per-holding bars show weight %. Pure CSS, no canvas. |
| **Learning Loop table alignment** | UX | Fixed actions column misalignment: `_slot(w, html)` helper creates fixed-width `inline-flex` containers for every button position (skill badge 28px, skill btn 26px, PM/vs/Tr/AI each 26px, delete 20px). All rows identical width regardless of which buttons are conditionally absent. `🔬 Sk` header given phantom 28px spacer to align over button slot. `_iconBtn` sub-labels use `color:var(--text-secondary)` — were invisible (black) in dark theme. |

---

## 1. Accuracy & model quality

Make the signal itself trustworthy. These guard against the classic ways a backtest or a
self-tuning loop quietly flatters itself — which for a personal tool means *not fooling yourself*.

### ✓ 1.1 Eliminate look-ahead bias — `M` · ★★★ **SHIPPED**
AI Replay now uses `auto_adjust=False` (nominal prices, matching actual executed prices).
Strategy Backtest keeps `auto_adjust=True` (total-return basis; scale-invariant indicators unaffected)
with a UI disclosure banner and "(adj.)" column labels. `indicators.py` documents why
`auto_adjust=True` is correct for live analysis. See §0.

### ✓ 1.2 Transaction-cost & slippage modelling — `M` · ★★★ **SHIPPED**
Backtest supports `slippage_mode: 'liquidity'` with ADV-tiered rates (>$10M→0.05%, $2-10M→0.10%,
$0.5-2M→0.20%, <$0.5M→0.35%). Per-ticker `effectiveSlippagePct` in results. UI has Flat / Auto radio
buttons with conditional flat slider. See §0.

### ✓ 1.3 Statistical rigour on the Learning Loop — `M` · ★★★ **SHIPPED**
Wilson 95% CI now appears on all win-rate cells; calibration gated at n<30. See §0.

### ✓ 1.4 Confidence-calibration validation — `M` · ★★★ **SHIPPED**
Brier score + reliability diagram in `GET /api/learning/calibration-stats`. Learning page shows the
Brier score metric card and a CSS bar diagram (actual win rate vs predicted confidence, per bin). See §0.

### ✓ 1.5 Survivorship bias in the universe — `L` · ★★ **(disclosure shipped Sprint 39)**
`ASX_UNIVERSE` is *today's* constituents; backtests silently exclude delisted/relegated names.
Amber disclosure panel added to Technical backtest results and Walk-Forward methodology note (Sprint 39).
True point-in-time constituents require paid data or historical tracking — this remains an open data gap,
but the disclosure prevents the bias from misleading without warning.

### ✓ 1.6 Overfitting guard on `_score_ticker` weights — `L` · ★★ **SHIPPED Sprint 21**
K-fold cross-validation of the eight `_score_ticker` signal factors. Each factor's Information
Coefficient (Spearman rank correlation with N-bar forward return) is measured in-sample and
out-of-sample. Stability ratio = OOS IC / train IC — < 30% or sign-flip flagged as overfitted.
New `POST /api/scanner/factor-stability` endpoint; **Factor Stability** tab in Market Scanner.
Weighted OOS IC summary + per-factor verdict (stable/marginal/weak/overfitted/noise).

### ✓ 1.7 Walk-forward backtesting engine — `XL` · ★★★ **SHIPPED Sprint 20**
Rolling train/test split + per-fold parameter grid-search (Sharpe-optimised in-sample, applied
out-of-sample). New `POST /api/backtest/walk-forward` endpoint; new **Walk-Forward** tab in the
Backtest page. Supports rsi_trend, macd, bb_reversion, momentum strategies. Fold-by-fold table
(best params, train Sharpe, test return) + stitched OOS equity curve + B&H benchmark comparison.
`_run_strategy_slice` helper refactors strategy logic into a single parameterised function used by
both the grid-search and the final OOS evaluation.

### ✓ 1.8 Revive market-breadth signal — `M` · ★★ **SHIPPED**
Scanner computes `breadth_ratio` (% of universe above 20-day SMA) after each scan; `/api/macro` reads
it via lazy import as `advance_decline_ratio`; regime engine breadth vote now fires. See §0.

### ✓ 1.9 Corporate-actions correctness — `M` · ★★ **(split + large-dividend detection shipped)**
Splits: detection + one-click auto-adjust shipped (Sprints 13/17). Large special dividends / capital
returns: `GET /api/portfolio/capital-returns-check` (Sprint 39) flags payments ≥5% of current price
in the last 90 days; Portfolio page shows orange warning. Remaining open: mergers/takeovers (stock →
cash at premium) and capital returns affecting CGT cost base require manual entry; yfinance does not
tag these as distinct corporate-action types.

### ✓ 1.10 Data-staleness guards — `S` · ★★ **SHIPPED**
`fetched_at` stamped on quote responses. `⚠ stale` badge in portfolio table when >25 min. See §0.

### 1.11 Regime-change calibration penalty — `S` · ★★
When `classifyRegime()` detects a regime flip, the current calibration still heavily weights data from the outgoing regime (e.g. 60d half-life in sideways means old `riskOn` trades still dominate for weeks). Add a transient decay multiplier: on flip, divide the effective half-life by 2 for the first 5–10 trades in the new regime until ESS recovers above 2.5. Wire into `_calib_compute()` using a `regime_flipped_at` timestamp stored in `blob_store` by `fetchAndClassifyRegime()` whenever the regime changes.
*Source: critics.md §2D*

### 1.12 Virtual-outcome time-decay weighting — `S` · ★
`_resolve_virtual_outcomes()` currently marks all virtual outcomes equally regardless of how long the price took to reach target. A virtual win resolved in 2 days is a stronger signal than one that drifted there over 29 days. Add `virtual_speed_weight = min(1.0, 7.0 / max(1, hold_days))` computed at resolution time, stored as a new `virtual_speed_weight` column on `ai_learning_events`, and applied as an additional multiplier in `_calib_compute()` alongside the existing time-decay weight.
*Source: critics.md §3.2*

---

## 2. New features & usefulness  ← the main ask

Concrete, ASX-and-personal-trading-specific features. Grouped by theme. Most build on engines that
already exist (quant, regime, learning, dividends, CGT).

### 2.1 Portfolio management

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Watchlist** (separate from holdings) | S | ★★★ | **SHIPPED** — `js/pages/watchlist.js`, `state.watchlist`, scanner ⭐ integration. See §0. |
| ✓ **Target allocations + drift alerts** | M | ★★ | **SHIPPED** — `state.targetAllocations`, `_buildTargetAllocCard()` on Risk page; amber/red when |drift| ≥5%/10%. See §0. |
| ✓ **Multiple portfolios / accounts (account tagging)** | M | ★★ | **SHIPPED Sprint 42** — `account` field on holdings (`personal`\|`super`\|`trading`), `state.activeAccount` filter. Portfolio page: account filter tabs, account badge per row (click to cycle), account prompt in Add Holding dialog. `mergedPortfolio()` filters by `state.activeAccount`. Analysis prompt includes `Account: SUPER` header when not 'all'. Cash stays single for now (full per-account cash in a future pass). |
| ✓ **Cash & term-deposit tracker** | S | ★★ | **SHIPPED** — `state.termDeposits`, `_buildCashTrackerCard()` on Dashboard; idle cash + TD maturities + deployable ≤30d total. See §0. |
| ✓ **Performance attribution** | M | ★★ | **SHIPPED** — `_buildAttributionCard()` in `performance.js`: P&L by sector and by regime at entry. See §0. |
| ✓ **Benchmark comparison** | S | ★★ | **SHIPPED** — ^AXJO overlay on Value History canvas; normalized to portfolio start value. See §0. |

### 2.2 Tax & income (ASX-specific)

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **CGT-discount countdown** | S | ★★★ | **SHIPPED** — urgency banner in CGT page + sell warning in checklist. See §0. |
| ✓ **Tax-loss-harvest planner** | M | ★★★ | **SHIPPED** — card on CGT page; ranks losers by unrealised loss; EOFY countdown; wash-sale flag. See §0. |
| ✓ **Dividend income forecast + franking credits** | M | ★★ | **SHIPPED** — `_buildDivForecastCard()` in `performance.js`: per-stock income, grossed-up at 30% corp tax, franking credits, frequency, yield on cost. See §0. |
| ✓ **Franking-credit optimiser (45-day rule)** | M | ★★ | **SHIPPED** — `_buildFranking45DayCard()` on CGT page; iterates open parcels, warns when 45-day continuous-holding rule is at risk. See §0. |
| ✓ **EOFY tax pack** | S | ★★ | **SHIPPED** — `GET /api/tax/eofy-pack?year=N` ZIP download: CGT disposals CSV + trade fees CSV. See §0. |

### 2.3 Alerts & monitoring

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Custom indicator alerts** | M | ★★★ | **SHIPPED** — `checkIndicatorAlerts()` in `alerts.js`; RSI, BB, volume-spike types. Watchlist UI. See §0. |
| ✓ **Off-device alert channels (Telegram)** | M | ★★★ | **SHIPPED** — Telegram bot integration. `routes/alerts.py`, Settings UI, `fireAlert()` hook. See §0. |
| ✓ **Ex-dividend & earnings reminders** | S | ★★ | **SHIPPED** — `checkExDivReminders()` / `checkEarningsReminders()` in `prices.js`. See §0. |
| ✓ **Macro / regime-change alert** | S | ★★ | **SHIPPED** — `fireAlert()` when regime flips to `panic` or `riskOff`. See §0. |
| ✓ **Stale-position nudge** | S | ★ | **SHIPPED** — amber card on Dashboard listing holdings with no rec in 14+ days. See §0. |

### 2.4 Research & analysis

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Side-by-side ticker compare** | M | ★★ | **SHIPPED** — `js/pages/compare.js`, g+x shortcut, ↔ nav button, Watchlist ↔ button. See §0. |
| ✓ **Saved screeners** | S | ★★ | **SHIPPED** — `state.savedScreeners`, ⊕ Save/Load/Delete in scanner config bar. See §0. |
| ✓ **Economic calendar** | M | ★★ | **SHIPPED** — `_buildEconomicCalendarCard()` on Dashboard; 45-day window with RBA dates, ex-div, earnings. See §0. |
| ✓ **Seasonality view** | M | ★ | **SHIPPED** — `GET /api/seasonality/<ticker>` + 12-bar card on Signals detail view. See §0. |
| ✓ **A-VIX / volatility gauge** | S | ★★ | **SHIPPED** — `asx_vol_20d` (20d realized vol of ^AXJO) in `/api/macro`; "A-VIX (ASX 20d)" card on Macro page; feeds two regime votes. See §0. |
| ✓ **Regime overlay on trade history** | S | ★★ | **SHIPPED** — coloured regime badge per journal row. See §0. |

### 2.5 Risk management

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Scenario / stress test** | M | ★★★ | **SHIPPED** — card on Risk page; shock presets + custom; per-holding beta × shock table. See §0. |
| ✓ **Trailing & ATR-based stops** | M | ★★★ | **SHIPPED** — 2×ATR14 stops card on Risk page; one-click "Set Alert". See §0. |
| ✓ **Correlation-aware sizing (sector)** | S | ★★ | **SHIPPED** — `_sectorConcentrationWarning(rec)` shows amber/red badge on BUY recs when the rec's sector already exceeds threshold. See §0. |
| ✓ **Correlation-aware sizing (exact)** | M | ★★ | **SHIPPED** — `analysis.js` fetches `/api/risk` post-analysis; reduces BUY qty 30% (|corr|>0.7) or 50% (|corr|>0.85); ⚡ Corr badge on rec cards. See §0. |
| ✓ **Risk-budget dashboard** | S | ★★ | **SHIPPED** — heat gauge at top of Risk page, configurable % budget. See §0. |
| ✓ **Drawdown monitor + alert** | S | ★★ | **SHIPPED** — current + max drawdown from portfolio history; alert banner + configurable threshold. See §0. |

### 2.6 Workflow & discipline

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Pre-trade checklist** | S | ★★★ | **SHIPPED** — 6-item modal gate (Sprint 42 added profit-harvest/risk-management item), requires ≥4 ticks. See §0. |
| ✓ **Thesis capture** | M | ★★★ | **SHIPPED** — textarea on rec cards, captured at execution, passed to learning loop as `trade_thesis`, shown in journal tooltip. See §0. |
| ✓ **Thesis review at exit** | S | ★★★ | **SHIPPED** — `_showThesisReview()` in `recommendations.js` fires `<dialog>` on full position close; 3-verdict buttons post to `/api/learning/outcome`. See §0. |
| ✓ **Broker CSV import** | M | ★★★ | **SHIPPED** — CommSec/SelfWealth/generic detection; backend parses, normalises, returns rows. See §0. |
| ✓ **Trade tags & notes** | S | ★★ | **SHIPPED** — `tags`/`trade_thesis` DB columns + inline input on rec cards + stored in learning events. See §0. |
| ✓ **Morning briefing auto-generate** | M | ★★ | **SHIPPED** — `'briefing'` agent type; Dashboard "Generate Brief" button chains macro + regime + holdings. See §0. |
| ✓ **Lessons: market-breadth scope** | M | ★★ | **SHIPPED Sprint 44** — `breadth_scope TEXT` column added to `trading_lessons`. `GET /api/learning/lessons` accepts `adl` + `asx_vol` params and filters accordingly. Create Lesson form has a breadth-scope dropdown. `analysis.js` passes ADL + asx_vol when fetching lessons. |
| ✓ **Lessons: auto-generate from calib-quality** | M | ★ | **SHIPPED Sprint 59.** `_SCHEMA_CALIB_QUALITY` gains optional `suggested_lesson` field; prompt instructs Ollama to populate it only when a `likely_systemic` band has ≥40% dominant tag. Learning page calib-quality card shows an amber "Suggested lesson" banner with "+ Create lesson" button; one click POSTs to `/api/learning/lessons` with `source:'calib_quality'`. |

### 2.7 AI assistant enhancements

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Portfolio-aware Q&A** | M | ★★ | **SHIPPED** — `sendChat()` now injects regime + macro context (VIX, ASX200, sentiment, AUD/USD) into system prompt. See §0. |
| ✓ **Postmortem digest** | S | ★★ | **SHIPPED** — `GET /api/learning/digest-data` + "Generate Digest" on Learning page. See §0. |
| ✓ **Local-LLM fallback** | M | ★ | **SHIPPED Sprint 41** — `POST /api/debate/quick-analysis` in `routes/debate.py`; `_callLocalAnalysis()` in `claude-client.js`; toggled via Settings → "Use local LLM for analysis"; BUY/TOP_UP/HOLD only; `🔒 Local` badge on rec cards; now also writes to `ai_call_log` with `agent_type='portfolio:local'` (Sprint 42). |
| ✓ **Prompt A/B tracking** | M | ★★ | **SHIPPED** — Prompt Version History table on Learning page; Δ vs prev column (pp delta + ↑/↓/↔); "current" badge; realised P&L column. See §0. |
| ✓ **Local LLM SELL/TRIM support** | L | ★★★ | **SHIPPED Sprint 48** — `_SCHEMA_QUICK_ANALYSIS` extended with SELL/TRIM action enum, `primary_driver`, and `urgency` fields. `_LOCAL_ANALYSIS_SYSTEM` rewritten with EXIT RULES section and 5-driver taxonomy (`thesis_broken`, `stop_triggered`, `target_reached`, `time_stop`, `risk_management`). `quick_analysis()` validates each SELL/TRIM rec: adds `primary_driver="thesis_broken"` default if absent, corrects stop to `entry×1.03` if below entry (tags `_stopRepaired=True`). `🔒 Local` badge tooltip updated. See Sprint 48 changelog in IMPROVEMENTS.md §0 and CLAUDE.md gotcha #32. |
| ✓ **"Why this rec?" traceability panel** | M | ★★★ | **SHIPPED Sprint 43** — collapsed `<details>` on each pending rec card. Shows regime + conf at generation time, 9 signal chips (RSI/ADX/BB%B/ATR/Score/OBV/MACD/Vol×/RS), calibration nudge block (≤350 chars), and cached Ollama debate synthesis. Context attached to rec in `analysis.js` via `_genRegime`, `_calibSnap`, `_signalsSnap` fields. |

---

## 3. Reliability & engineering (personal-grade)

You don't need multi-user infra, but you *do* want it to not lose your data or break mid-session.

### ✓ 3.1 Data-source resilience — `M` · ★★★ **COMPLETE Sprint 42**
Three lines of defence: (1) `fetch_with_retry()` in `core.py` — exponential backoff (3×, 2s/4s/8s);
(2) `_last_good` stale-cache per key — serves the last successful result on full retry exhaustion;
(3) `stooq_quote()` in `core.py` — Stooq CSV price fallback when `_last_good` is also empty (fresh
server start with yfinance down). Wired into `_quote_cached()` and `_macro_payload._fetch_symbol()`.
OHLCV history fallback via `_fetch_stooq_history()` in `indicators.py` was already live.
Coverage: all ASX equities (`.AX` → `.au`), `^AXJO`, S&P500, NASDAQ, VIX, US10Y, AUD/USD, gold,
oil, copper, sector ETFs. Not covered: iron ore (`TIO=F`) and SPI200 futures (`YAP=F`) — not on Stooq.

### ✓ 3.2 Automated local backups — `S` · ★★★ **SHIPPED**
Daily backup on startup + daemon thread. Keeps last 7. See §0.

### ✓ 3.3 Real frontend tests — `M` · ★★ **SHIPPED Sprint 19**
122 Vitest unit tests for pure engine files (`quant-engine`, `regime-engine`, `response-validator`,
`_detectExitReason` in both `recommendations.js` and `performance.js`). `npm run test:js`. See §0.

### ✓ 3.4 Performance / responsiveness — `S` · ★★ **COMPLETE Sprint 41**
Macro endpoint fully parallelised (Sprint 8). Polymarket parallelised + loading state (Sprint 39).
Earnings calendar parallel with 4h per-ticker TTL (Sprint 39). RBA rate wrapped in `@ttl_cache(seconds=21600)` (Sprint 40). Signals page optimistic rendering (Sprint 40).
Macro page optimistic rendering: `renderMacroPage(gen)` renders cached state immediately; if `state.macroData` is >5 min stale, a silent background `GET /api/macro` fires and re-renders on completion with a "⟳ Refreshing…" badge (Sprint 41). Dashboard and Macro page auto-kick `fetchEarningsCalendar()` when the calendar is unpopulated (Sprint 41).

### ✓ 3.5 Light security hygiene (personal) — `S` · ★ **SHIPPED Sprint 21**
- gunicorn now binds `127.0.0.1:5000` (was `0.0.0.0`) — LAN devices can no longer reach the API
- CORS restricted to `null` (file://), localhost:5000/8080, 127.0.0.1:5000 origins
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy` headers added
  to every Flask response via `_req_end()`

### ✓ 3.6 Escape external text in the render layer — `S` · ★★ **SHIPPED**
`escapeHTML()` added to `utils.js`; applied to all external text injection points. See §0.

### 3.7 Type safety / ES-modules — `L` · ★★
TypeScript (or JSDoc + `tsc --checkJs`) on the core engines, and the ES-modules migration noted in
CLAUDE.md, would remove the fragile global load-order contract. Quality-of-life, not urgent.

### ✓ 3.8 Hoist `_detectExitReason` to `utils.js` — `S` · ★★★ **SHIPPED Sprint 43**
Single canonical copy now in `js/utils.js`. Both page files reference it via the shared global. Tests updated.

### ✓ 3.9 `FACTOR_WEIGHTS` normalization guard — `S` · ★ **SHIPPED Sprint 43**
`indicators.py` emits `warnings.warn` at import if `sum(FACTOR_WEIGHTS) != 100`.

### ✓ 3.10 Stooq rate-limit semaphore — `S` · ★★ **SHIPPED Sprint 43**
`_stooq_sem = threading.BoundedSemaphore(1)` in `core.py`; both `stooq_quote()` and `_fetch_stooq_history()` acquire it with a 1-second `finally` sleep.

### ✓ 3.11 `_cache_store` unbounded growth in `core.py` — **SHIPPED**
`_MAX_CACHE_SIZE = 2000` cap + `_evict_cache()` expired-entry sweep added to `core.py`. Sweep runs inside the lock on every cache miss. See §0 audit item A.

### 3.12 Thundering herd in `ttl_cache` under parallel scanner load — `S` · ★
Concurrent cache misses (e.g. 8 threads hitting the same ticker TTL simultaneously) each invoke
the expensive yfinance call before any result is stored. A per-key `threading.Event` sentinel
would park waiters until the first compute completes, eliminating redundant network calls under
load. See §0 audit item B. Not urgent for personal use; flag for a future engineering pass.

### ✓ 3.13 Backtest endpoint missing input validation — **SHIPPED**
`_ALLOWED_PERIODS` and `_ALLOWED_STRATEGIES` allowlist guards added to `routes/backtest.py`.
Tickers list type/length validated; capital bounds checked. See §0 audit item C.

### ✓ 3.14 `js/utils.js` merged portfolio missing `shares <= 0` guard — **SHIPPED**
`.filter(h => h.shares > 0)` added after the merge step in `mergedPortfolio()` (`utils.js:44-48`).
See §0 audit item F.

---

## 4. UX & quality of life

| Item | Effort | Impact | Notes |
|---|---|---|---|
| ✓ **Mobile responsive layout** | L | ★★ | **SHIPPED Sprint 39** — sidebar overlay + hamburger, grid single-column at 768px, auto-close on nav. |
| Onboarding & empty states | S | ★ | First-run setup (key, cash, import) and friendly empty cards. Portfolio first-run state shipped (Sprint 18); full wizard out of scope for personal tool. |
| ✓ **Keyboard shortcuts** | S | ★ | **SHIPPED** — `g`+letter page navigation + `?` shortcut help `<dialog>`. See §0. |
| ✓ **Dark/light + density toggle** | S | ★ | **SHIPPED** — compact mode (`.compact` body class, Settings → Display). See §0. |
| ✓ **In-app changelog / version banner** | S | ★ | **SHIPPED** — Settings → "What's New" collapsible sprint history + App Info card (version/uptime/last backup). See §0. |
| ✓ **Consistent loading/error states** | S | ★ | **SHIPPED Sprint 40** — signals page now renders stale data immediately + background refresh with "⟳ Refreshing…" badge; only shows spinner on first cold load. Risk page (Sprint 18) + performance page already had error+retry pattern. |

---

## 5. Suggested sequencing

1. ✓ **Trust the numbers first:** §1.3 Wilson CI, §1.4 Brier score, §1.2 slippage — **done**. Remaining: §1.1 look-ahead bias, §1.5 survivorship bias.
2. ✓ **Don't lose data:** §3.2 backups, §3.1 retry + stale-cache + Stooq fallback — **done Sprint 42**.
3. ✓ **Highest daily payoff:** pre-trade checklist, CGT countdown, trade tags, heat gauge, drawdown monitor, Telegram, broker CSV, indicator alerts, tax-loss planner, EOFY pack, watchlist, morning briefing, regime journal, stale nudge — **all done**.
4. ✓ **Deepen the edge:** §2.5 stress test / trailing stops / breadth signal — **done**. ✓ §1.7 walk-forward backtest — **done Sprint 20**. ✓ §2.5 correlation-aware sizing — **done Sprint 8**.
5. ✓ **Sprint 6 shipped:** §2.7 portfolio-aware Q&A, §2.1 performance attribution, §2.5 sector-concentration warning, §2.6 thesis capture, §2.2 dividend forecast + franking credits — **all done**.
6. ✓ **Sprint 7 shipped:** thesis review at exit, prompt-version P&L, target allocations + drift alerts, economic calendar (RBA dates + ex-div + earnings), franking 45-day rule warnings — **all done**.
7. ✓ **Sprint 8 shipped:** A-VIX (ASX realized vol), cash/TD tracker, exact correlation-aware sizing, macro endpoint perf (3 serial fetches eliminated), keyboard shortcuts (`g`+letter + `?`) — **all done**.
8. ✓ **Sprint 9 shipped:** Prompt+response logging (ai_call_log, full prompt in every call), side-by-side compare page, prompt version A/B delta, ETF earnings filter, App Info card — **all done**.
9. ✓ **Sprint 12 shipped:** §1.1 look-ahead bias (AI Replay fixed to nominal prices; strategy backtest disclosed as total-return), TRIM/SELL ATR stop floor, intraday Extreme Mode, intraday dynamic UI updates, Groq/Gemini key consolidation, neutral debate synthesis — **all done**.
10. ✓ **Sprint 13 shipped:** compact/density mode, in-app changelog, macro loading state, corporate-actions split detection, liquidity-scaled slippage — **all done**.
11. ✓ **Sprint 14 shipped:** signals page candlestick chart, journal monthly P&L bar chart, portfolio sector sidebar (replaced canvas donut), numpy.bool_ JSON serialization fix, Learning Loop table alignment + dark-theme button colors — **all done**.
12. ✓ **Sprint 17 shipped:** monthly seasonality card (Signals page detail), CGT split auto-adjust with one-click Apply button (Portfolio) — **all done**.
13. ✓ **Sprint 18 shipped:** `_retryBtn`/`_emptyCard` utils helpers, risk.js error banner + retry, performance.js equity-curve error card, portfolio first-run empty state — **all done**.
14. ✓ **Sprint 19 shipped:** Vitest JS test suite (122 tests, `npm run test:js`), `_detectExitReason` cross-file test coverage — **all done**.
15. ✓ **Sprint 20 shipped:** Walk-forward backtesting engine (`POST /api/backtest/walk-forward`, Walk-Forward tab, fold-by-fold table + OOS equity curve) — **all done**.
16. ✓ **Sprint 21 shipped:** Factor stability / overfitting guard (`POST /api/scanner/factor-stability`, Factor Stability tab), security hygiene (localhost bind, CORS, security headers) — **all done**.
17. ✓ **Sprint 22 shipped:** Cloud adjudicator provider picker (Gemini/Groq/Claude, picker modal) — **all done**.
18. ✓ **Sprint 23 shipped:** Ollama structured outputs (`format_schema`), ESS calibration gates, signal flattening, SQLite timeout 10→30s, Phase 3 docs corrected — **all done**.
19. ✓ **Sprint 24 shipped:** Blind adjudication, JS Ollama priority queue, skill-weight centering at 5, hierarchical regime fallbacks — **all done**.
20. ✓ **Sprint 25 shipped:** Volatility-adaptive half-life, SQLite startup maintenance, Phase 6 design spec — **all done**.
21. ✓ **Sprint 26 shipped:** Phase 6 calibration quality debate card (`GET /api/debate/calib-quality`, traffic-light UI, `triggerCalibQualityIfStale`) — **all done**.
22. ✓ **Sprint 27 shipped:** Success tag calibration nudge (step 6b in `_calib_compute`), `success_patterns` in stats, Success Patterns UI card — **all done**.
23. ✓ **Sprint 37–38 shipped:** Sell tag outcome tracking (Gap 3), `better_opportunity` cross-check (Gap 7), sell tag calibration injection (Part 9), Section 6 SELL_TAG prompt rules, calibration cache thread lock, Phase 8 Mann-Whitney gate, Kelly rejection, regime-aware stopAtrMult, 30-min blend on regime flip, SPI200 futures vote, `_sanity_check()` in indicators, `pre_earnings_risk` flag — **all done**.
24. ✓ **Sprint 39 shipped:** `_preEarningsAdj` badge fix, earnings-calendar 4h TTL cache, survivorship-bias disclosures (§1.5), capital-returns-check endpoint (§1.9 partial), mobile responsive layout (§4).
25. ✓ **Sprint 40 shipped:** RBA rate 6h in-memory `ttl_cache` wrapper (`_rba_rate_cached`); signals page optimistic stale rendering + background refresh; §4 table docs cleanup (keyboard shortcuts, density mode, in-app changelog marked ✓).
26. ✓ **Sprint 41 shipped:** Macro page optimistic stale rendering (`renderMacroPage(gen)`, silent background fetch, `_macroRefreshing` badge); earnings calendar auto-fetch on Dashboard + Macro navigation; `state.earningsLastFetch` + dashboard re-render in `fetchEarningsCalendar()`; §3.4 fully complete.
27. ✓ **Sprint 42 shipped:** `high_60d`/`low_60d` forwarded to Claude in `analysis.js` (`Range60d` line); `_dtBuildRecs()` Signal #4 updated to actual Fibonacci zone (with `return_60d` fallback); Stooq price fallback (`stooq_quote` in `core.py`) wired into `_quote_cached()` and `_macro_payload()` — third line of defence when yfinance fails and `_last_good` is empty; doc fixes in `learning_loop.md` and `prompts.md` (Phase 8 live, day-trade Claude prompts marked dormant, Phase 3 neutral synthesis terminology).
28. ✓ **Sprint 42 shipped:** `high_60d`/`low_60d` forwarded to Claude in `analysis.js` (`Range60d` line); `_dtBuildRecs()` Signal #4 updated to actual Fibonacci zone (with `return_60d` fallback); Stooq price fallback (`stooq_quote` in `core.py`) wired into `_quote_cached()` and `_macro_payload()` — third line of defence when yfinance fails and `_last_good` is empty; doc fixes in `learning_loop.md` and `prompts.md` (Phase 8 live, day-trade Claude prompts marked dormant, Phase 3 neutral synthesis terminology); pre-trade checklist 6th item (profit harvest / risk management); executed-rec button immediate feedback; `max_tokens` raised to 8,000; `unrealised_loss_large` enforcement line + SELL exit semantics in `ANALYSIS_SYSTEM_PROMPT`.
29. ✓ **Sprint 43 shipped:** §3.8 `_detectExitReason` hoisted to `utils.js`; §3.10 Stooq rate-limit semaphore; §3.9 `FACTOR_WEIGHTS` guard; §2.7 "Why this rec?" traceability panel.
30. ✓ **Sprint 44 shipped:** §1.11 regime-change calibration penalty; §1.12 virtual-outcome speed weighting; §2.6 lessons breadth scope; §2.6 DRP parcel tracking.
31. ✓ **Sprint 45 shipped:** Thesis drift detection (`_compute_thesis_drift`, `GET /api/learning/thesis-drift`, `renderThesisDriftCard`); stop-loss trailing ("📍 Trail" button, `trailStop()`, `_stopTrailed`/`_stopTrailedAt` flags); scheduled morning briefing (`state.settings.autoBriefTime`, `checkAutoBriefSchedule()` in `scheduler.js`).
32. ✓ **Sprint 46 shipped:** Broker CSV SELL import (`sells[]` array, FIFO confirmation table, CGT-at-risk warnings); rebalancing suggestions modal (`_buildRebalanceSuggestions()`, no AI call); ASX universe exclusion list (`POST|DELETE /api/market/universe-exclude`, scanner/intraday filtering).
33. ✓ **Hotfixes (2026-06-04):** `fetch_with_retry` 4xx fix (`_http_status()` helper, 429 min 5s sleep); auto-debate triggers removed (postmortem/skill/calib-quality manual-only); `currentPrice` fix in analysis prompt (`livePrice` for all portfolio fields); Phase 8 gate aligned in `_calib_compute()` (Mann-Whitney, was raw mean); `_HL_MAP`/`_REGIME_GROUPS` phantom regime names removed; DB pragma parity for announcement/news engines; 6 audit bugs (DRP multi-account, settings path, auto-brief name, etc.).
34. ✓ **Sprint 48 shipped:** §2.7 local LLM SELL/TRIM — `_SCHEMA_QUICK_ANALYSIS` extended with SELL/TRIM, `primary_driver`, `urgency`; `_LOCAL_ANALYSIS_SYSTEM` rewritten with EXIT RULES + 5-driver taxonomy; post-processing validates driver, corrects stop direction. See Sprint 48 changelog above.
35. **Open:** §1.9 mergers/takeover CGT (no yfinance corporate-action tag), §3.7 ES-modules (deferred — high risk, use Vite on feature branch).

---

## 6. Deployment — remote multi-device access via ngrok ✓ SHIPPED Sprint 55 (2026-06-09)

Goal: reach the app from phone / laptop / tablet for **personal use**, while keeping the
data private. The app has **no built-in authentication**, so the tunnel's edge auth is the
*only* line of defence for portfolio data and the Anthropic key — it is non-negotiable here.

### Design: one same-origin HTTPS tunnel
Serve the HTML + JS *from Flask* so a single ngrok tunnel covers UI and API on one origin.
Eliminates CORS, makes API calls origin-relative, and HTTPS unlocks the PWA "Add to Home
Screen" (`manifest.json`/`sw.js`, Sprint 41, require HTTPS — ngrok provides it). State lives
server-side in SQLite (`/api/db/save`/`load`), so every device shares one portfolio.

```
Phone / laptop / tablet
  └─ https://<you>.ngrok-free.app ──(ngrok edge: Google-OAuth gate)──► ngrok agent on Pi
                                                                        └─► gunicorn 127.0.0.1:5000
                                                                              └─► Flask: HTML+JS+API, SQLite
```

### Code changes (3, additive)
1. **`js/config.js`** — origin-relative API base (preserves `file://` local use):
   ```js
   const API = (location.protocol === 'file:') ? 'http://localhost:5000' : location.origin;
   ```
   Apply the same to `serverUrl` (line ~43).
2. **`asx_server.py`** — serve the app (add near the PWA static routes, ~line 201):
   ```python
   @app.route('/')
   def index():
       return send_from_directory('.', 'asx_trading.html')

   @app.route('/js/<path:f>')
   def serve_js(f):
       return send_from_directory('js', f)
   ```
   Add routes for any css/image dirs the HTML references (grep `asx_trading.html` for `src=`/`href=`).
3. **CORS** — no change once same-origin; keep the localhost entries for `file://` dev.

### Security gate (mandatory — the only auth)
ngrok edge **OAuth restricted to one Google account**. Each device logs in once; the edge
session cookie rides `fetch()` calls automatically. Direct Anthropic calls go to
`api.anthropic.com` (not through the tunnel), so OAuth doesn't interfere. Also switch to
**proxy mode** (`POST /api/claude/settings` once + `state.settings.useBackendProxy=true`) so
the Anthropic key lives once on the Pi, not in every device's localStorage.

```yaml
# ~/.config/ngrok/ngrok.yml   (OUTSIDE the repo — NEVER commit; holds the authtoken)
version: "3"
agent:
  authtoken: <agent-authtoken-from-dashboard>
endpoints:
  - name: sloth
    url: https://<your-reserved-domain>.ngrok-free.app
    upstream:
      url: 5000
    traffic_policy:
      on_http_request:
        - actions:
            - type: oauth
              config:
                provider: google
                allow_emails: [ tanthien.pt@gmail.com ]
```
Fallback if OAuth is fussy on a device: swap `oauth` for `basic-auth`.

### Stable URL + always-on
- Reserve the **one free static domain** (ngrok dashboard → Domains) so the URL survives
  restarts and the PWA install stays valid.
- Two systemd **user** services on the Pi:
  - `sloth-app.service` → `ExecStart=gunicorn -c gunicorn.conf.py asx_server:app`
  - `sloth-ngrok.service` → `ExecStart=ngrok start --all --config %h/.config/ngrok/ngrok.yml`
  - `systemctl --user enable --now sloth-app sloth-ngrok` + `loginctl enable-linger tanth`.

### Bring-up order
1. Make the 3 code changes; keep `python test_app.py` + `npm run test:js` green.
2. `ngrok config add-authtoken <token>` (writes to `~/.config/ngrok/`, keeps it out of the repo).
3. Reserve the static domain; write `ngrok.yml` with the OAuth gate.
4. Start gunicorn; confirm `curl -s localhost:5000/` returns the HTML.
5. `ngrok start sloth`; open the https URL on a phone → Google login → app loads.
6. Install as PWA; enable proxy mode; **rotate the authtoken** (it was shared in plaintext during planning).
7. Enable the systemd services + linger.

### Caveats
- **Free tier:** one static domain; OAuth gating included; bandwidth generous but not unlimited.
- **The gate is everything** — never disable OAuth/basic-auth "just to test"; the portfolio is
  world-readable for that window.
- **`/api/db/git-status` runs `git`/subprocess** — harmless read-only, but exposed; the auth gate
  is what keeps it safe.
- **Service worker caching** (`sw.js`) can serve stale assets after a deploy — bump its cache
  version or hard-refresh after updates.
- **Secret hygiene:** the authtoken belongs only in `~/.config/ngrok/ngrok.yml` (outside the repo),
  never in `config.js`, `IMPROVEMENTS.md`, or any committed file.

---

## 7. Mobile — make the UI great on phones/tablets (implemented 2026-06-10; device QA pending)

> **Status:** Phases 1–4 shipped 2026-06-10. Phase 1 CSS quick wins, Phase 2 stacked cards on the
> 6 primary tables (portfolio holdings, rec history, 3× CGT, learning events) via `.tbl-stack` +
> `data-label`, Phase 3 `_fitCanvas` DPR helper + width-change redraw listener in `charts.js`,
> Phase 4 touch polish (no hover-reveal controls existed — audit confirmed). `sw.js` does no
> caching, so no cache-version bump was needed. Phase 5 (real-device QA via the §6 ngrok URL)
> remains manual. Notes: `toggleLots()` now sets `display:''` so stacked CSS can restyle the lots
> row; secondary stats tables (learning conf-band/regime/version) intentionally stay tabular —
> they fit phones and stacking hurts comparability.

Goal: first-class experience on iPhone Safari + Android Chrome, portrait & landscape, and as an
installed PWA (standalone). Pairs with §6 (ngrok) — once the tunnel is up, real devices test the
live app over HTTPS. Supersedes the deferred "Mobile / responsive layout" item in CLAUDE.md.

### Current state — what already works (do NOT rebuild)
- Viewport + PWA meta — `asx_trading.html:5` (`width=device-width`), `:10-11` (apple standalone).
- Slide-in drawer sidebar + overlay + hamburger — JS `js/navigation.js:9-16`; CSS
  `@media (max-width:768px)` block `asx_trading.css:299-318` (transform drawer, overlay, grid collapse).
- Horizontal table scroll — `.table-wrap { overflow-x:auto }` (`css:78`).
- Compact-mode toggle — `state.settings.compactMode` → `.compact` body class.
- Some charts already DPR-aware — `js/charts.js:466-470`.

### Gaps found (audit 2026-06-09) — why it is not yet "great"
| Gap | Evidence | Impact |
|---|---|---|
| Inputs trigger iOS auto-zoom on focus | inputs `font-size:13px` (`css:192`) — Safari zooms when <16px | High |
| `height:100vh` breaks with mobile toolbar | `.app{height:100vh}` (`css:32`), `.chat-wrap` (`css:172`) | High |
| Touch targets <44px | `.nav-item` 7px pad (`css:41`), `.btn-sm` 4px·10px (`css:117`), table icon buttons | High |
| Wide tables only sideways-scroll | `.table-wrap` h-scroll is the only mobile treatment | High |
| No safe-area insets | standalone PWA, no `env(safe-area-inset-*)` | Med |
| Mixed canvas sizing, no redraw on rotate | fixed w/h `charts.js:230,745` vs DPR `:466`; no `orientationchange` handler | Med |
| Hover-only affordances | `tr:hover` (`css:83`), action reveals — invisible on touch | Med |

---

### Phase 1 — CSS-only quick wins (~1–2 h, ~60% of felt improvement)

All changes go inside the existing `@media (max-width:768px)` block (`css:299-318`) unless noted.
Additive, low regression risk.

**1a. Kill iOS input zoom** — anything <16px triggers Safari focus-zoom:
```css
@media (max-width: 768px) {
  input[type="text"], input[type="number"], input[type="password"],
  textarea, select { font-size: 16px; }
}
```

**1b. `100vh` → `100dvh`** (dynamic viewport, accounts for the collapsing browser toolbar).
Edit `css:32` and `:172`:
```css
.app { height: 100vh; height: 100dvh; }                 /* fallback then override */
.chat-wrap { height: calc(100vh - 200px); height: calc(100dvh - 200px); }
```

**1c. Touch targets ≥44px** (Apple HIG) inside the mobile block:
```css
@media (max-width: 768px) {
  .btn, .btn-sm, .nav-item { min-height: 44px; }
  td .btn, td button, .table-wrap button { min-height: 40px; min-width: 40px; }
}
```

**1d. Safe-area insets** for notched iPhones in standalone PWA (outside the media query, harmless on desktop):
```css
.topbar  { padding-top: max(0.875rem, env(safe-area-inset-top)); }
.sidebar { padding-bottom: env(safe-area-inset-bottom); }
.content { padding-bottom: max(1.5rem, env(safe-area-inset-bottom)); }
```
Add `viewport-fit=cover` to the viewport meta (`asx_trading.html:5`):
`content="width=device-width, initial-scale=1.0, viewport-fit=cover"`.

**1e. Topbar overflow** — hide secondary market pills under 768px (keep title + bell + hamburger):
```css
@media (max-width: 768px) { .topbar .market-pill:not(:first-of-type) { display: none; } }
```
(Verify the selector against the actual topbar markup before applying; may need a dedicated
`.market-pill-secondary` class added in the topbar builder.)

**1f. Auto-apply compact spacing on mobile** (reuse existing `.compact` rules) — optional density win:
```css
@media (max-width: 768px) { .content { padding: 0.75rem; } }
```

**Phase 1 acceptance:** no input zoom on focus; no content clipped under the toolbar/notch; all
buttons tappable; topbar fits without overflow. Bump `sw.js` cache version so the installed PWA
picks up the CSS.

---

### Phase 2 — Responsive data tables (largest "great" lever)

Horizontal scroll is acceptable for dense/secondary tables but poor for the **primary** ones the
user reads daily: portfolio, recommendations, CGT, learning. Convert those to a **stacked card
layout** under ~640px.

**Approach A — `data-label` stacked cards (use for the 4 primary tables).**
1. In the page render builders, add `data-label="<column header>"` to every `<td>`. Files:
   - `js/pages/portfolio.js` (holdings table)
   - `js/pages/recommendations.js` (recs table)
   - `js/pages/cgt.js` (disposals/parcels tables)
   - `js/pages/learning.js` (stats tables)
2. Add a shared CSS rule keyed by a `.tbl-stack` class on those tables:
```css
@media (max-width: 640px) {
  table.tbl-stack thead { display: none; }
  table.tbl-stack tr { display: block; margin-bottom: 10px; border: 0.5px solid var(--border-light);
                       border-radius: var(--radius-md); padding: 6px 10px; }
  table.tbl-stack td { display: flex; justify-content: space-between; gap: 12px;
                       padding: 6px 0; border: none; text-align: right; }
  table.tbl-stack td::before { content: attr(data-label); font-weight: 600;
                               color: var(--text-secondary); text-align: left; }
}
```
3. Add `class="tbl-stack"` to those four tables' `<table>` tags.

**Approach B — column-priority hiding (cheaper, for secondary tables: scanner, backtest, performance).**
Tag low-priority columns with `.col-optional` in both `<th>` and `<td>`, then:
```css
@media (max-width: 768px) { .col-optional { display: none; } }
```

**Sticky headers + momentum scroll** for any table that stays tabular:
```css
.table-wrap { -webkit-overflow-scrolling: touch; }
.table-wrap thead th { position: sticky; top: 0; background: var(--bg-primary); z-index: 1; }
```

**Phase 2 acceptance:** the four primary tables render as readable label:value cards on a phone
(no sideways scroll); secondary tables either stack or hide non-essential columns. Verify each page
renders without error after adding `data-label` (the builders are pure HTML-string functions — a
typo breaks the page; the `navigation.js` error boundary will surface it).

**Risk:** touches multiple `pages/*.js` render builders. Do table-by-table, verify each in the
browser. No automated visual test exists for these.

---

### Phase 3 — Responsive charts

Some canvas draws use fixed `w/h` (`charts.js:230`, `:745`), others are DPR-aware (`:466-470`).
Standardise on the DPR pattern and add a single resize/rotate redraw.

1. **Helper** in `js/charts.js` — size any canvas to its container at device pixel ratio:
```js
function _fitCanvas(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.clientWidth;
  const h = cssHeight;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
```
   Refit the fixed-size draws (`:230`, `:745`) to call `_fitCanvas` instead of hardcoding `canvas.width = w`.

2. **Redraw on rotate/resize** — one debounced global listener (add to `init.js` or `charts.js`):
```js
let _chartRedrawT;
function _onViewportChange() {
  clearTimeout(_chartRedrawT);
  _chartRedrawT = setTimeout(() => { if (typeof renderPage === 'function') renderPage(); }, 200);
}
window.addEventListener('resize', _onViewportChange);
window.addEventListener('orientationchange', _onViewportChange);
```
   (`renderPage()` already rebuilds the active page incl. its charts — reuse it rather than tracking
   individual chart instances.)

3. **Cap chart heights on mobile** — pass a smaller `cssHeight` (e.g. 160 vs 220) when
   `window.innerWidth < 640`.

**Phase 3 acceptance:** charts fill their card width crisply (no blur) and reflow on device rotation.

---

### Phase 4 — Touch & interaction polish

1. **No hover-only actions.** Audit `tr:hover` (`css:83`) and any "reveal on hover" row controls;
   make them always-visible (or tap-to-expand) on touch:
```css
@media (hover: none) { .row-actions { opacity: 1 !important; visibility: visible !important; } }
```
2. **Swipe-scroll tab bars** (scanner tabs, day-trading tabs):
```css
.tab-bar { display: flex; flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; }
```
3. **Scrollable modals** — the `navigation.js:118` dialog is 95%/420px; ensure tall modals
   (trade dialog, rebalance) scroll: `dialog { max-height: 90dvh; overflow: auto; }`.
4. **Optional — bottom tab bar** for one-thumb reach: a fixed bottom bar with the 5 most-used pages
   on mobile, replacing the hamburger for primary nav. Bigger lift (new component + safe-area-inset
   bottom padding); defer unless the drawer feels slow in use.

**Phase 4 acceptance:** every action reachable by touch; no element depends on hover; tab rows
swipe; modals never trap content off-screen.

---

### Phase 5 — Verification

Device matrix: **iPhone Safari + Android Chrome**, **portrait + landscape**, **PWA-installed
standalone**. Easiest via the §6 ngrok HTTPS URL on real hardware.

Checklist:
- [ ] No page-level horizontal scroll (only inside `.table-wrap`).
- [ ] No input zoom on focus (Phase 1a).
- [ ] No content under notch/home indicator in standalone PWA (Phase 1d).
- [ ] All buttons/nav items tappable without mis-hits (Phase 1c).
- [ ] Four primary tables render as cards; secondary tables stack/hide columns (Phase 2).
- [ ] Charts crisp (DPR) and reflow on rotation (Phase 3).
- [ ] Drawer + overlay open/close; tab bars swipe; modals scroll (Phase 4).
- [ ] After deploy: `sw.js` cache version bumped so installed PWAs get new CSS.

### Sequencing & effort
| Phase | Effort | Files | Risk |
|---|---|---|---|
| 1 — CSS quick wins | ~1–2 h | `asx_trading.css`, `asx_trading.html` (1 meta) | Low |
| 2 — Responsive tables | ~M (½–1 day) | `asx_trading.css` + 4–6 `pages/*.js` builders | Med (touches render builders) |
| 3 — Charts | ~S | `js/charts.js`, `js/init.js` | Low |
| 4 — Touch polish | ~S | `asx_trading.css` (+ optional new bottom-nav component) | Low (Med if bottom-nav) |
| 5 — Verification | ~S (manual) | — | — |

Do Phase 1 first (cheap, high impact, CSS-only, tests unaffected). Phase 2 is the biggest lever but
the largest change surface — table-by-table with browser verification. No automated visual test
exists, so mobile QA is manual on real devices.

---

## 8. Pipeline integrity & strategy enforcement — deep-dive audit (Sprint 61: mostly SHIPPED)

Source: code-level audit of the learning loop (`routes/learning.py`), the prompts
(`js/prompts.js`), and the day-trading strategy (`js/strategy.js`, `js/day-trading-analysis.js`,
`js/intraday-strategy.js`, `routes/day_trade_training.py`). The architecture is sound; these six
items close the gaps between what the docs/prompts *claim* and what the code *enforces*.

| # | Item | Status |
|---|---|---|
| 8.1 | Wire the response validator into the live path | ✅ **Shipped Sprint 61** — `validateRec()` local fix-or-drop after the sizing steps (no network repair loop); `_validatorFixed` audit tag; ensembleConfidence restored (was null in every learning event since the validator went dark); quant-rejected BUYs and unheld SELL/TRIM now dropped instead of surfacing with qty=0 |
| 8.2 | Fix the Section 7 qty/netProfit contradiction | ✅ **Shipped Sprint 61** — Section 7 cash test rewritten qty-free (min-trade-size notional); BUY net-EV gate recomputed engine-side at final qty (`_netProfitEngine`); `PROMPT_VERSION = 2026-06-v10` |
| 8.3 | Apply calibration adjustments deterministically | ✅ **Shipped Sprint 61** — calibration response carries `adjustments:{bands,tickers}`; `fetchCalibrationBlock()` stashes it on `window._calibAdjustments`; `analysis.js` applies it before Kelly sizing (clamped [0.05,0.98], `_calibApplied` audit tag); learning events log the ORIGINAL confidence so calibration never compounds; Section 6 now context-only |
| 8.4 | Implement the §2.7/2.8/2.9 swing filters | ✅ **Complete Sprint 61+62** — §2.7 ADR gate (Sprint 61); §2.8 VoV (`atr_5d_mean` from indicators.py, `vovMult` gate in both pre-filters, `VoV:N` rejection bucket); §2.9 time-of-week (`_dtTimeOfWeekBlocked()` on the Sydney wall-clock via Intl, Mon <11:00 / Fri ≥14:00, `timeOfWeekFilter` toggle, deliberately not shadow-logged) |
| 8.5 | Structured tool-schema output for Claude calls | ✅ **Shipped Sprint 62** — static `_PORTFOLIO_TOOL` (`emit_recommendations`) with forced `tool_choice` for the portfolio agent; closed enums for action/orderType/urgency; `tool_use.input` stringified back into `responseText` so `parseClaudeJSON()` + all post-processing unchanged; `options.noTool` escape hatch; proxy passes `tools` verbatim; schema static so the prompt cache survives |
| 8.6 | Shadow-log correlation / conf-floor rejections | ✅ **Shipped Sprint 61** — `conf_floor` (BUY/TOP_UP only) and `neg_ev` reasons in `analysis.js`, `breadth_blocked` in `day-trading-analysis.js`. Full-suppression sites only — correlation size *reductions* still execute and produce real outcomes, so they are deliberately NOT shadow-logged |

**Also shipped Sprint 61 (from the deep-dive feature recommendations):**
- **Outcome-proposal notifications** — stop/target hits on executed recs (portfolio + day-trade swing) push a persistent 📋 notification proposing the close be recorded; clicking deep-links via `_NOTIF_NAV` (`outcome` → Recommendations, `outcome_dt` → Day Trading). One-shot, riding the existing alert re-arm rules.
- **`regime_risk` ML feature** — ordinal 0–5 (riskOn=0 → panic=5) added to both training matrices (now 16 swing / 19 intraday). Derived at training time from the snapshot's stored `regime` string — no schema change, retroactive over all historical snapshots. JS prediction map in `dtBuildFeatures()` kept in sync (test-enforced).
- **prompts.md re-verified** — post-processing list now matches `analysis.js` exactly (15 steps); false validator/repair-loop claims corrected.

Remaining open: weekly Telegram learning digest (user deferred), DT_FILTER walk-forward threshold tuner. (§8.1–8.6 all shipped as of Sprint 62; execution-alpha tracker + ML retrain nudge shipped Sprint 63.)

---

### 8.1 Wire the response validator into the live path  ← data-integrity, do first

**Problem.** `validateRec()`, `getValidatedAnalysisWithRepair()`, and `validateSellTags()` in
`js/response-validator.js` are defined but **called from nowhere** (grep-verified: only
self-references + Vitest). Consequences:
- CLAUDE.md's 4-layer pipeline diagram (Regime → Claude → Quant → **Validator**) is aspirational —
  the validator layer never runs.
- The prompt's threats ("FORBIDDEN combinations (validation will reject)", "Invented tags fail
  validation") are unenforced. Invalid `sell_primary_driver` / forbidden tag combos flow into
  `ai_learning_events` and pollute the sell-tag verdict analytics (`_resolve_sell_outcomes`)
  that feed back into future prompts.
- `analysis.js` re-implements fragments inline (conf floor, neg-EV drop, ATR floor) — duplicated,
  partial coverage.

**Plan.**
1. In `analysis.js`, immediately after `parseClaudeJSON()` succeeds and before the quant-engine
   step, run each rec through `validateRec(r)`:
   - If a rule with a `fix` repairs it → use the fixed rec, tag `_validatorFixed: [ruleIds]`.
   - If a hard rule fails un-fixably → drop the rec, append a summary note
     `[Validator dropped N rec(s): <ruleIds>]`, and `console.warn` the full rec for diagnosis.
2. **Do not** enable the network repair loop (`getValidatedAnalysisWithRepair`) in this pass —
   it re-calls Claude and changes latency/cost characteristics. Local fix-or-drop only.
3. Resolve the schema conflict found earlier: `qty-positive-int` requires `qty ≥ 1` but Rule 4
   makes Claude emit 0 by design. Change the rule to validate qty **after** the quant-engine +
   SELL/TRIM sizing steps instead (move the validator call after sizing), or relax the rule to
   `qty ≥ 0` pre-sizing with a post-sizing `qty ≥ 1` assertion. **Decision: run the validator
   AFTER sizing** — it then checks what the user actually sees.
4. `validateSellTags()` is invoked by `validateRec()` for SELL/TRIM — confirm forbidden combos
   (target_reached+stop_triggered, time_stop+target_reached, SELL+monitor) strip/drop correctly.
5. Tests: source assertion that `analysis.js` calls `validateRec(`; unit case for a rec with a
   forbidden tag combo being cleaned; update CLAUDE.md pipeline note if behaviour differs.

**Acceptance:** a synthetic response containing an invented sell tag and a `qty: "fifty"` string
never reaches `state.recommendations` unrepaired; learning events log only closed-vocabulary tags.

---

### 8.2 Fix the Section 7 qty/netProfit contradiction  ← latent BUY-killer

**Problem.** Section 7 (`prompts.js`) requires every BUY/TOP_UP to pass a cash-comparison test
computing `netProfit = qty × entryPrice × expectedReturn − opportunityCost − brokerage`, with a
worked example using `qty = 21`. But Rule 4 mandates `qty: 0` in output. A literal-minded model
outputs `netProfit ≤ 0` — and `analysis.js` (cleanedRecs loop) **drops any BUY with
`aiNet ≤ 0`**. Claude currently papers over the contradiction by imagining a plausible qty; one
model-version change could silently filter every BUY.

**Plan.**
1. Rewrite Section 7's cash test to be **per-$1,000-notional** (no qty dependency):
   `returnPer1k = 1000 × expectedReturn`, `oppCostPer1k = 1000 × (RBA/100) × (days/365)`,
   require `returnPer1k − oppCostPer1k − roundTripBrokerage > 0` assuming the minimum trade size
   from account settings. Update the worked example to match.
2. Redefine the `netProfit` output field for BUY/TOP_UP as **per-minimum-trade-size estimate**
   (state it explicitly: "computed at min trade size; engine recomputes at final qty").
3. In `analysis.js`, recompute the BUY gate **after** quant sizing: replace the
   `aiNet ≤ 0 → drop` check with a deterministic
   `qty × (target − entryMid) − oppCost − 2×brokerage > 0` using the engine's final qty —
   the AI's value becomes display-only for BUYs exactly as it already is for SELL/TRIM.
4. Bump `PROMPT_VERSION` → `2026-06-v10` (+ test, CLAUDE.md, learning_loop.md refs).
5. Tests: assert prompts.js no longer contains a qty-dependent BUY example with nonzero qty;
   assert `analysis.js` recomputes the BUY net-EV gate post-sizing.

**Acceptance:** a model that obeys Rule 4 to the letter (qty=0, netProfit=0) still produces
surviving BUY recs; the neg-EV gate operates on engine-computed numbers.

---

### 8.3 Apply calibration adjustments deterministically  ← exact feedback loop

**Problem.** Section 6 instructs Claude: `new_conf = clamp(orig_conf + adj, 0, 0.98)` — the
system's most important feedback value is applied by **LLM arithmetic**, violating the "Claude
never does arithmetic" architecture. Unverifiable; errors propagate into Kelly sizing.

**Plan.**
1. `routes/learning.py` — extend the calibration response with a machine-readable mirror of the
   text block: `adjustments: { bands: {"60-70": -0.05, ...}, tickers: {"BHP.AX": -0.10}, regime_warn: bool }`.
   The human-readable `block` string stays unchanged (Claude still sees context).
2. `learning-loop.js` — `fetchCalibrationBlock()` returns `{ block, adjustments }`; cache both.
3. `analysis.js` — new post-response step (before the confidence floor): for each rec, apply
   `r.confidence = clamp(r.confidence + bandAdj + tickerAdj, 0.05, 0.98)`, tag
   `_calibApplied: {band, adj}`. Runs **before** `computeTradeParams` so Kelly sees the
   calibrated value.
4. `prompts.js` Section 6 — change the instruction from "apply the adjustment" to "treat the
   CALIBRATION block as context for your reasoning; numeric adjustments are applied by the
   engine after your response — do not pre-adjust confidence". (Same PROMPT_VERSION bump as 8.2
   if shipped together.)
5. Guard: skip engine-side application when the calibration payload is `{available:false}`.
   Double-application risk is the main hazard — the prompt change (step 4) and engine change
   (step 3) must ship in the same release.
6. Tests: unit test the adjustment parser (band edge cases: conf exactly on a band boundary);
   regression assertion that prompts.js no longer says "new_conf = clamp(orig_conf".

**Acceptance:** for a rec with conf 0.72 and band adj −0.08, the logged learning event records
`ai_confidence = 0.72` and the displayed/sized rec uses 0.64, with `_calibApplied` audit trail.

---

### 8.4 Implement the documented swing filters §2.7 / §2.8 / §2.9

**Problem.** Three filters documented as strategy rules in `day-trading-strategy.md` §2 are
**not implemented anywhere** (grep-verified):
- §2.7 ADR breadth gate — skip new swing BUYs when `advance_decline_ratio < 0.25`
- §2.8 Volatility-of-volatility — skip/escalate when `ATR_today > 1.3 × ATR_5d_mean`
- §2.9 Time-of-week — no new entries Mon before 11:00 or Fri after 14:00 AEST

**Plan.**
1. **ADR gate (highest value, data already available).** In `day-trading-analysis.js`
   `_dtBuildRecs()` (and the universe-scan path): read
   `state.macroData?.advance_decline_ratio`; when `< 0.25`, suppress all new BUY setups, surface
   an amber banner "Breadth gate: ADR X% < 25% — new entries paused", and shadow-log suppressed
   setups with `shadow_reason: 'breadth_blocked'` (extends the 8.6 taxonomy). Threshold lives in
   `DT_FILTER.minAdr = 0.25` (runtime-tunable via the existing Rules tab merge).
2. **VoV filter.** `indicators.py analyse_ticker()` — add `atr_5d_mean` (mean of the last 5
   daily ATR-14 values; `None` if <20 bars). `strategy.js _dtPreFilter()` — reject when
   `s.atr_14 > (fp.vovMult ?? 1.3) × s.atr_5d_mean`; add to the rejection-breakdown counts
   (`VoV −N`). Doc says "skip or escalate" — implement **skip** (simpler, deterministic);
   escalation can come later.
3. **Time-of-week filter.** Helper `_dtTimeOfWeekBlocked()` in `day-trading-analysis.js`
   using Sydney time (`Intl.DateTimeFormat` with `timeZone:'Australia/Sydney'`, NOT
   `getDay()` on local time — the Pi may not run in AEST): Monday < 11:00 or Friday ≥ 14:00 →
   block *new* swing entries only, banner + tunable `DT_FILTER.timeOfWeekFilter = true` toggle.
   Existing-position management unaffected.
4. Doc: flip §2.7/2.8/2.9 from prose to "implemented" with file refs; update the §12 scorecard
   note that these checks are now automatic.
5. Tests: `_dtPreFilter` VoV rejection case; ADR-gate suppression case; time-of-week boundary
   cases (Mon 10:59 blocked / 11:00 allowed; Fri 13:59 allowed / 14:00 blocked) with mocked
   Sydney clock.

**Acceptance:** with ADR 0.20 in macroData, a scan produces zero new BUY setups and N
breadth-blocked shadow records; the rejection breakdown shows a VoV bucket.

---

### 8.5 Structured tool-schema output for Claude calls

**Problem.** The local Ollama path enforces JSON at the grammar level (`format_schema`), but the
cloud Claude path relies on "Return ONLY valid JSON" plus defensive hacks (no `{}` in strings,
400-char summary cap, `parseClaudeJSON` salvage logic, truncation recovery). The parse-failure
class still exists exactly where the money is.

**Plan.**
1. `claude-client.js` — for `agentType: 'portfolio'` (first; others later), send a single tool
   `emit_recommendations` whose `input_schema` is the rec JSON schema (mirror
   `response-validator.js` field specs: enums for action/orderType/urgency/primary_driver,
   number ranges for confidence), with `tool_choice: {type:'tool', name:'emit_recommendations'}`.
2. Response handling: read `content[].type === 'tool_use'` input as the parsed object; keep
   `parseClaudeJSON` as fallback for non-tool responses (proxy mode, older logs).
3. Prompt cache check: tools are part of the cached prefix — adding the tool definition busts
   the cache **once**, then caches as before. Keep the tool schema static (no dynamic state) for
   the same reason as `ANALYSIS_SYSTEM_PROMPT`.
4. Prompt cleanup (after the schema is enforced): Section 8's "no `{}` in strings" rule and the
   JSON-shape example become redundant → trim in a later prompt-consolidation pass, not now.
5. `POST /api/claude/proxy` passes the body through unchanged — verify `tools`/`tool_choice`
   survive proxy mode.
6. Tests: mock a tool_use response shape through the parse path; assert direct + proxy modes both
   handle it; assert the validator (8.1) still runs on tool output (schema enforces *types*, not
   business rules like R:R ≥ 2 or forbidden tag combos — both layers stay).

**Acceptance:** a full analysis round-trip yields recs parsed from `tool_use.input` with zero
regex salvage; malformed-JSON error path becomes unreachable for the portfolio agent.

---

### 8.6 Shadow-log correlation and confidence-floor rejections

**Problem.** Shadow logging (ML bias correction) covers only `heat_blocked` and
`regime_blocked`. Recs halved by the correlation filter, dropped by the hard confidence floor,
or dropped by the neg-EV gate are invisible to training — the model still learns from a
partially pruned sample.

**Plan.**
1. `analysis.js` — at the three rejection sites, mirror the existing `dtSaveSnapshot(...,
   {record_type:'shadow', shadow_reason})` pattern:
   - confidence-floor drop → `shadow_reason: 'conf_floor'`
   - neg-EV BUY drop → `shadow_reason: 'neg_ev'`
   - correlation: only log when fully suppressing; a −30%/−50% *size reduction* still executes
     and produces a real outcome — do NOT double-log those.
2. `routes/day_trade_training.py` — no schema change needed (`shadow_reason` is free text);
   add the new reasons to the §14.8 doc table.
3. Sanity cap: skip shadow logging when the rec lacks stop/target (shadow resolution needs both).
4. Tests: source assertions for the three call sites + reason strings.

**Acceptance:** a scan day with 2 conf-floor drops produces 2 `shadow` rows resolvable by
`_resolve_shadow_outcomes()`; Kelly phase-gate counts include them.

---

### Out of scope (noted, deliberately deferred)

- **Prompt consolidation pass** (franking duplicated in Priority 4 + Section 4; R:R in Rule 3 +
  Section 7; ~660-line system prompt) — do after 8.2/8.3/8.5 settle, as one reviewed rewrite
  with a single PROMPT_VERSION bump, not piecemeal.
- **Auto-proposed outcomes from stop/target alerts** (alerts detect hits live; outcome writes
  are manual) — needs UX design for the confirm flow; highest-value learning-loop item after 8.3.
- **Per-account calibration scope** — blocked on data volume; revisit when one non-default
  account has ≥30 closed events.
- **Intraday confidence ←→ ML expected-R blending** — wait until a trained ridge model with
  `r2_oos > 0` exists on ≥60 intraday trades; blending an unvalidated model into sizing is
  premature.
- **Intraday Mode A (VWAP recapture)** — already tracked in `day-trading-strategy.md` §8.2.

---

## 9. External review triage (`critics.md`, assessed 2026-06-11)

An external review (critics.md) was assessed against the actual codebase. Verdict: roughly a
third of its items are **already shipped** (the review predates Sprints 43–65), one is
**architecturally misguided**, one rests on **wrong schema premises** — and four are genuinely
good and adopted below. Stale/wrong items are listed at the end so they aren't re-litigated.

| # | Item | Verdict | Priority |
|---|---|---|---|
| 9.1 | Dynamic regime stop widening for open positions | ✅ **Shipped Sprint 66** — `checkRegimeStopWidening()` in alerts.js, runs before stop-hit checks; widen-only, `_stopTrailed` precedence, one-shot per regime, alert+bell on every widen, ↔ Widened badge in History | High |
| 9.2 | Slippage penalty for virtual outcomes (+ execution-alpha sim) | ✅ **Shipped Sprint 66** — `core.adv_slippage` (hoisted from backtester) × regime mult; wins must clear target by the margin, mech fills degraded; `virtual_slippage_applied` audit column + chip tooltip | High |
| 9.3 | Per-ticker portfolio correlation in the prompt (context-only) | ✓ Adopt, modified | Med |
| 9.4 | "Why this rec?" traceability modal | ✓ Adopt | Med |
| 9.5 | Small batch: breadth-scope triggers, local-LLM size guard | ✓ Adopt | Low |

---

### 9.1 Dynamic regime stop widening for open positions  *(critics Phase 1.1)*

**Gap (real):** the hard stop is set once at entry using the entry-regime `stopAtrMult`; if the
regime degrades mid-hold (sideways → highVol/riskOff), the stop is now too tight for the new
noise floor — exactly the §4.1 rationale, unapplied to open positions. The Chandelier trail
(📍 Trail button) is manual and tightens only.

**Plan:**
1. New `checkRegimeStopWidening()` in `js/alerts.js` (or `prices.js`), called from
   `refreshPrices()` alongside the stop/target checkers:
   - For each EXECUTED open BUY/TOP_UP rec with a stop: compute
     `widenedStop = entryMid − getRegimeModifiers(currentRegime).stopAtrMult × ATR` (live
     `atr_14` from `state.liveSignals`).
   - **Widen only, never tighten** (`widenedStop < r.stopLoss`), and never widen a stop the
     user manually trailed (`r._stopTrailed` wins — trailing is a deliberate lock-in).
   - Apply with audit fields `_stopWidened: true`, `_stopWidenedAt`, `_stopWidenedFrom`,
     `_stopWidenedRegime`; one-shot per regime flip (re-arm when regime changes again).
2. Badge on the rec card (`↔ Stop widened (highVol)` amber) mirroring the `_stopTrailed` badge.
3. Notification via the bell (category `price`) so the change is never silent — widening the
   stop increases $-at-risk beyond the originally sized amount; the user must see it.
4. Tests: widen-only invariant, `_stopTrailed` precedence, one-shot re-arm.

**Design note:** this deliberately does NOT resize the position (risk grew). The alternative —
exit instead of widen — is already covered by §6 Step 4 (regime-flip → advance to trailing
stop). Widening keeps the §4.1 philosophy consistent across the position's life.

### 9.2 Slippage penalty for virtual outcomes  *(critics Phase 1.2)*

**Gap (real):** `_resolve_virtual_outcomes()` and `_resolve_execution_alpha()` assume perfect
fills at the touched level. Thin ASX names overstate virtual wins → calibration learns
optimism from fills that wouldn't have happened at that price.

**Plan:**
1. Reuse the backtester's existing ADV-tiered model: hoist `_adv_slippage(adv_aud)` from
   `routes/backtest.py` into a shared helper (`core.py` or a small `slippage.py`).
2. In both resolvers: read `adv_20` from the event's `entry_signals_json` snapshot (already
   stored per event); require the bar to clear the level *plus* slippage before counting the
   fill — for a long: win needs `High ≥ target × (1 + slip)`, loss triggers at
   `Low ≤ stop × (1 − slip)`… asymmetric in the unfavourable direction for both.
   Missing `adv_20` → conservative thin-name tier.
3. Regime multiplier (highVol/panic ×1.5) using the event's stored `regime`.
4. Store `virtual_slippage_applied REAL` (new `_LE_MIGRATIONS` column) for audit; surface in
   the `~W`/`~L` chip tooltip.
5. Tests: a barely-touched target that fails the slippage-adjusted threshold counts as
   `virtual_open`, not `virtual_win`.

### 9.3 Per-ticker portfolio correlation in the prompt — context-only  *(critics Phase 1.3, modified)*

**Adopted with one critical modification.** The critic suggests instructing Claude to "reduce
confidence 8–15pp when ρ > 0.70" — that re-introduces LLM-side arithmetic, which §8.3 just
removed deliberately. The numeric response to correlation already exists engine-side (qty
−30%/−50% at |ρ|>0.70/0.85). What's genuinely missing is Claude *seeing* the correlation when
forming the thesis.

**Plan:**
1. `analysis.js` Step 2b already fetches `/api/risk` (whose payload includes the correlation
   matrix) before the prompt is built — currently only `metrics` is read. Capture
   `correlation` too (zero extra calls).
2. Append to each ticker's indicator block:
   `CorrToHoldings: NAB:0.87 ANZ:0.81` (top 2–3 |ρ| ≥ 0.60 vs current holdings, bare tickers).
3. Prompt (Section 3 ADDITIONAL FACTORS → CORRELATION): "When CorrToHoldings shows ρ ≥ 0.70,
   treat the new position as concentration, not diversification — require the thesis to be
   explicitly orthogonal (different driver) and cite it in factorsUsed[]. Do NOT adjust
   confidence numerically — the engine reduces size deterministically." `PROMPT_VERSION` bump.
4. Log max |ρ| at rec time into learning events (`market_context` JSON) for later analysis.

### 9.4 "Why did I get this rec?" traceability modal  *(critics Phase 2.4)*

All inputs already live on the rec object — this is pure UI assembly. New ℹ️ button on the rec
card opening a modal with: regime + confidence at creation (`regime`, `_calibApplied.orig` →
adjusted), calibration nudge (`_calibApplied`), quant sizing trail (`_quantEngine`,
`_constraintBinding`, `_preEarningsAdj`, `_corrNote`, `_budgetNote`, `_varAdjusted`), validator
repairs/warnings (`_validatorFixed`, `_ruleWarnings`, `_stopRepaired`, `_exitSized`), debate
synthesis (`debate_synthesis_winner` via `_learningId`), local-model flag (`_source`), and the
factorsUsed list. Read-only, no new state. ~half day.

### 9.5 Small batch (low priority)

- **Extra `breadth_scope` lesson triggers** — add `high_vov` (ATR expansion active),
  `earnings_season` (Feb/Aug), `cgt_window` (May–Jun) to the lessons filter vocabulary.
  The plumbing exists (Sprint 44); this is vocabulary + filter conditions.
- **Local-LLM size guard** — when `useLocalLLM` is on and a SELL/TRIM touches a holding worth
  more than a threshold (e.g. >10% of portfolio), force the Claude path for that run (badge:
  "escalated to Claude — position size"). Cheap insurance until local tag quality is proven.
- **Monitor local-vs-Claude tag agreement** — blocked on data: needs enough paired decisions;
  revisit once local SELL/TRIM volume exists.

---

### Rejected / already-shipped items from critics.md (do not re-open)

| Critics item | Status |
|---|---|
| 1.4 Hoist `_detectExitReason` to utils.js | **Already shipped Sprint 43** — canonical copy in `utils.js`, Vitest-enforced (CLAUDE.md gotcha 14) |
| 2.1 Calibration text bucketing "for cache hit rate" | **Misguided** — the calibration block is injected into the *user message* precisely so the cached *system prompt* never changes. User-message content is uncached by design (it carries live prices/holdings that change every call); standardising calibration text cannot improve the cache hit rate. The machine-readable/text split it asks for shipped in v10 (§8.3) |
| 2.2 Lessons auto-suggest from calib-quality | **Already shipped Sprint 59** (suggested-lesson banner + Create button) |
| 2.3 "Thesis-broken TRIMs with minimal movement" | **Substantially covered** — `_resolve_sell_outcomes()` already price-verifies SELL/TRIM drivers post-hoc and emits `⚠SELL_TAG` nudges; thesis-drift covers early exits |
| 3.3 DB generated columns from JSON | **Wrong premises** — `prompt_version`, `error_type`, `sell_primary_driver`, `virtual_outcome` are already real, indexed columns on `ai_learning_events` (see Appendix B), not JSON extracts; `regime_risk` is derived at train time from the real `regime` column. No query-performance problem exists at this row count |
| 3.4 Intraday "indicative" labelling | **Already in the UI** (`day-trading.js`: "yfinance 5m data has ~5–15 min latency — prices are indicative"); Mode A already tracked as planned; real-time feed out of scope for personal use |
| §3 FACTOR_WEIGHTS validation | **Already shipped** — `warnings.warn` at import when sum ≠ 100 |
| §3 Stooq rate limiter | **Already shipped Sprint 43** — `_stooq_sem` BoundedSemaphore + 1 s pacing |
| §4 ADV-tiered slippage in backtester | **Already shipped** — `slippage_mode: 'liquidity'` via `_adv_slippage()` |
| 3.1 Look-ahead / survivorship (as-traded mode, point-in-time universe) | **Deferred, not rejected** — legitimate for rigorous backtesting but heavy (manual adjustment handling, universe snapshots); partial mitigations exist (`_sanity_check` drops unadjusted-split bars, splits-check endpoint, universe exclusion list). Revisit if backtest results start driving real capital decisions |
| 3.2 Corporate actions auto-adjust of parcels | **Deferred** — detection exists (splits-check + capital-return warnings); silently mutating CGT parcels is a data-integrity risk. If adopted, build as assisted apply (warning card → preview → confirm), never automatic |
| §4 learning-loop walk-forward / red-team scenarios | **Good ideas, large** — noted as future testing-framework work |

---

## Appendix A — Shipped (original build sprint)

The original roadmap's nine items have all landed and are retained for history:

1. **Relative Strength vs ^AXJO** — `rs_score` in `_score_ticker`; RS columns in scanner.
2. **Learning Loop system** — `ai_learning_events` + `prompt_versions` tables, `/api/learning/*`, Learning Loop page, calibration injection.
3. **Performance metrics** — Sortino, profit factor, win/loss streaks, avg hold.
4. **Prompt versioning & hardening** — `PROMPT_VERSION` (now v5), hard-rules delimiter, JSON schema example.
5. **Error resilience** — try/except around yfinance, `failed_tickers` table, graceful scan skips.
6. **Sector-map robustness + caching** — expanded map, `ticker_metadata` cache, fallback chain.
7. **Ensemble confidence** — `0.5·AI + 0.5·(score/100)`, used for the gate.
8. **Desktop alerts** — `js/alerts.js`, one-shot stop/target alerts.
9. **Trade journal + ATO CGT export** — CSV with CGT-discount eligibility.

Later passes added the **debate engine** (Ollama bull/bear + postmortem + skill scoring + cloud
adjudicator) and **Learning Loop Stages 1–4** (data capture → auto-classification → prompt
instructions → active feedback).

---

## Appendix B — Learning Loop DB schema

```sql
CREATE TABLE IF NOT EXISTS ai_learning_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    event_type TEXT NOT NULL,           -- 'recommendation', 'day_trade', 'macro'
    ticker TEXT,
    regime TEXT,                        -- from regime-engine.js
    prompt_version TEXT,
    agent_type TEXT,                    -- 'analyst', 'pm', 'portfolio', 'dayTrade'

    -- AI Output
    ai_confidence REAL,
    recommendation TEXT,                -- BUY / TOP_UP / SELL / TRIM / HOLD
    rationale_summary TEXT,
    suggested_stop REAL,
    suggested_target REAL,
    rr_ratio REAL,

    -- Outcome (updated later)
    outcome_status TEXT,                -- 'win', 'loss', 'breakeven', 'open', 'invalidated'
    realized_pnl_pct REAL,
    realized_pnl_aud REAL,
    holding_period_days INTEGER,
    exit_reason TEXT,                   -- 'target_hit', 'stop_hit', 'manual', 'time_exit', 'catalyst'

    was_executed BOOLEAN DEFAULT 0,
    follow_through_days INTEGER,
    market_context TEXT,                -- JSON string
    error_type TEXT,                    -- 'overconfident', 'regime_mismatch', 'poor_rr', etc.
    notes TEXT
);

CREATE TABLE IF NOT EXISTS prompt_versions (
    version TEXT PRIMARY KEY,
    created_at TEXT,
    description TEXT,
    total_calls INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0,
    high_conf_win_rate REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS failed_tickers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    ticker TEXT,
    error TEXT
);

CREATE INDEX idx_learning_ticker    ON ai_learning_events(ticker);
CREATE INDEX idx_learning_timestamp ON ai_learning_events(timestamp DESC);
CREATE INDEX idx_learning_regime    ON ai_learning_events(regime);
CREATE INDEX idx_learning_event_type ON ai_learning_events(event_type);
CREATE INDEX idx_learning_confidence ON ai_learning_events(ai_confidence);
```
