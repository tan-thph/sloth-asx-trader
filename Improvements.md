# Improvements — Audit Findings (2026-06-23)

Source: full-app audit (quant/regime sizing, learning-loop calibration backend, indicators/backtest math, frontend trade-execution/journal/CGT consistency). Baseline at time of audit: `python test_app.py` (795 tests) and `npm run test:js` (154 tests) both green — none of the issues below are caught by the existing suite. Each item was independently verified against the actual source (not just inferred).

Each entry has a `Status` field. Flip to `Resolved` (with a one-line note + commit ref) once fixed.

**Update (2026-06-23, same day):** All 12 findings resolved. Final verification: `python test_app.py` (796 tests — 795 original + 1 new DST test) and `npm run test:js` (154 tests) both green.

---

## Critical

### 1. `minQty` floor nullifies sizing-constraint rejections
**File:** `js/quant-engine.js:159-163`
**Status:** Resolved — zero-reject check moved to `rawQty * volScalar <= 0`, evaluated before the `Math.max(minQty, ...)` floor runs.

```js
const qty = Math.max(QUANT_CONFIG.minQty, Math.floor(rawQty * volScalar));  // minQty=1
if (qty <= 0) return { ok: false, reason: 'sizing constraints reject trade (qty=0)' };  // dead code
```

`Math.max(1, ...)` guarantees `qty ≥ 1` always, so the very next zero-check can never fire. Any trade that should be hard-rejected — `qtyByLiquidity=0` (too small relative to ADV), `qtyByPosition=0`, `qtyByRisk=0` (stop too tight for the risk budget) — instead silently executes a forced 1-share order. The documented invariant (gotcha #25: "Kelly guard must come before minQty floor") only protects the *negative-EV* Kelly rejection, which is correctly ordered. It does nothing for liquidity/position/risk-based rejections, which this floor defeats entirely.

**Suggested fix:** Check `rawQty * volScalar <= 0` (pre-floor) for the reject condition, not the post-floor `qty`.

---

### 2. Heat budget gate ignores existing open-position risk
**File:** `js/analysis.js:1244-1264`
**Status:** Resolved — `consumed` now also sums `qty × |entryPrice − stopLoss|` across open executed BUY/TOP_UP recHistory entries for currently-held tickers.

`consumed` is summed only from `state.recommendations` with `status==='pending'`. It never includes $-at-risk on already-executed/held positions. Once a rec clears from "pending" after execution, its risk vanishes from the budget calculation entirely — a portfolio already at or beyond the configured `maxRiskBudgetPct` cap will see `consumed=0` and fully size a brand-new BUY. The gate only throttles same-batch new recs against each other, never against the live book.

**Suggested fix:** Also sum `shares × |entry − stop|` across current `state.portfolio` holdings (where a stop is tracked, e.g. via `state.recHistory`) into `consumed` before sizing new recs.

---

### 3. Cross-account corruption via ticker-only lookups
**File:** `js/pages/portfolio.js`
**Status:** Resolved — CSV import, broker CSV import, `_applyImportedSells`/`_computeSellPreview` now scope every lookup by an `importAccount` (derived from `state.activeAccount`); `applySplitAdjustment` adjusts every matching holding across accounts (was only the first); `applyDrpEvent`'s new CGT parcel + journal entry now carry the holding's `account`.

Several mutating paths look up/update `state.portfolio` by ticker alone, unlike `applyBuyToPortfolio`/`applySellToPortfolio` (which correctly scope by `(h.account || 'personal')`):

- CSV import (`:587`) and broker CSV import (`:678`) — `state.portfolio.find(h => h.ticker === ticker)`, no account filter.
- `_applyImportedSells` (`:831`) — same unscoped find; `matchSaleAgainstParcels` is called without an account scope, so it can consume a different account's parcels.
- `applySplitAdjustment` (`:1011-1020`) — adjusts only the first ticker match's holding, but adjusts **every** CGT parcel for that ticker across **all** accounts.
- `applyDrpEvent` (`:1130`) — correctly scopes the *holding* lookup by account (`:1115-1118`), but the new CGT parcel it pushes has **no `account` field at all** — it silently defaults to `'personal'` everywhere parcels are later read, even if the original position is in `trading`/`super`.

**Scenario:** a ticker held in both `personal` (100 sh @ $30) and `trading` (50 sh @ $40) accounts; a CSV import of 20 more `trading` shares at $42 updates whichever holding object happens to be first in the array — if that's `personal`, personal's avgPrice/share-count is corrupted while trading's position is silently unaffected.

**Suggested fix:** Thread `account` (default `state.activeAccount` / `'personal'`) through every lookup/filter in these functions, mirroring the pattern already used in `applyBuyToPortfolio` and the DRP holding lookup. Add `account` to the parcel object pushed by `applyDrpEvent`.

---

## Medium

### 4. Wrong field name breaks AI exit hold-duration tracking
**File:** `js/pages/recommendations.js:1425`
**Status:** Resolved — `p.shares` → `p.remainingQty`.

```js
const liveParcels = (state.cgtParcels || []).filter(p => p.ticker === rec.ticker && (p.shares || 0) > 0);
```

CGT parcels never have a `.shares` field — they use `.remainingQty`, which is correctly used 350 lines earlier in the *same file* (`:1071-1072`). This filter is therefore always empty, `openDate` always falls back to today's date, and every AI-driven SELL/TRIM journal entry gets a wrong open-date, corrupting hold-duration math downstream in `performance.js`.

**Suggested fix:** Change `p.shares` to `p.remainingQty`.

---

### 5. Lazy OHLC resolvers starve on permanently-failing tickers
**File:** `routes/learning.py` — `_resolve_virtual_outcomes`, `_resolve_sell_outcomes`, `_resolve_mae_mfe`, `_resolve_stop_tag_counterfactual`
**Status:** Resolved — new shared `fetch_failed_at` column (db.py migration) + `_mark_fetch_failed()` helper; all 4 resolvers' SELECTs now exclude rows with a failure inside a 7-day retry window, and the bare-exception (and, for the latter two, empty-`hist`) paths stamp it instead of silently `continue`-ing forever.

Each does `SELECT ... ORDER BY timestamp DESC LIMIT cap` then `except: continue` on yfinance fetch failure, with no "attempted" marker written to the DB. A delisted/suspended/renamed ticker (common on ASX after takeovers) permanently occupies a slot in the capped batch (e.g. `cap=5`) on **every** calibration cache-miss call, forever — the backlog behind it never drains. This contradicts the "idempotent" framing in the docstrings: idempotency (no double-processing) holds, but liveness (eventual progress) does not.

Note: the `hist.empty` branches in `_resolve_virtual_outcomes`/`_resolve_sell_outcomes` DO write a sentinel (`virtual_open` / `inconclusive`) correctly — only the bare-exception paths are missing one.

**Suggested fix:** On exception, write a sentinel/timestamp (e.g. a `_resolve_failed_at` column, or reuse the existing "open"/"inconclusive" pattern) so a failing row drops out of the `WHERE ... IS NULL` selection after one attempt, with an optional retry window (e.g. re-attempt after N days).

---

### 6. Blended avgPrice stored as journal entryPrice on multi-parcel exits
**File:** `js/pages/recommendations.js`, `js/pages/performance.js`
**Status:** Resolved — journal entry's `entryPrice` is now the qty-weighted cost of the specific `disposals` matched against the sale (`Σ saleQty×parcelCostPerShare / Σ saleQty`), not `holding.avgPrice`. `performance.js` only ever reads this field, so it benefits automatically — no separate change needed there.

Realized $ P&L is correct (computed per-parcel via `disposalsToPnl` against true cost bases). But the journal entry's `entryPrice` field stores `holding.avgPrice` — the blended weighted average across all parcels — not the actually-matched parcel's own cost. This skews `pnlPct`, R:R backfill, and any downstream analytics keyed off `entryPrice` whenever a position was built from parcels bought at different prices.

**Suggested fix:** Either store a parcel-weighted effective entry price for the specific shares sold, or have analytics consumers recompute from `disposals` instead of `entryPrice` when available.

---

### 7. Scanner RSI and primary RSI disagree
**File:** `indicators.py` — `_simple_rsi` vs `compute_rsi`
**Status:** Resolved — `_simple_rsi` now delegates to `compute_rsi` (wraps the input in a `pd.Series`, returns the last value); verified byte-identical output against `compute_rsi` directly.

`compute_rsi()` (used for the main `rsi_14` in `analyse_ticker()`) correctly uses Wilder smoothing (`ewm(com=period-1)`). `_simple_rsi()` (used inside `_score_ticker()`, i.e. the scanner/score engine) is a flat, non-recursive average recomputed from scratch each call. The two RSI values can disagree materially for the same ticker/date, producing inconsistent buy/sell framing between the scanner and the detailed analysis view.

**Suggested fix:** Make `_simple_rsi` delegate to `compute_rsi` (or apply the same Wilder smoothing) so both code paths agree.

---

### 8. Forming-bar cutoff doesn't account for daylight saving
**File:** `indicators.py` — `_drop_forming_bar`
**Status:** Resolved — cutoff is now checked in `Australia/Sydney` local time via `zoneinfo` (17:00 local, ~48min post-close buffer) instead of a flat `07:00 UTC`; DST is handled by the tz database rather than a manual offset. 3 existing tests + 1 new test updated/added.

The function uses a flat `07:00 UTC` cutoff to decide whether to drop today's incomplete daily candle. ASX closes at ~06:12 UTC in AEST (Apr–Oct) but ~05:12 UTC in AEDT (Oct–Apr, daylight saving). The constant cutoff is either overly conservative (AEDT months) or leaves a thin (<1hr) margin against data-provider settlement delay (AEST months).

**Suggested fix:** Compute the UTC cutoff from a DST-aware AEST/AEDT offset rather than a hardcoded `07:00`.

---

## Low

### 9. Degenerate R:R passes the gate when stop ≥ entry
**File:** `js/intraday-strategy.js:74`
**Status:** Resolved — explicit `if (stop >= entry) continue;` before the R:R calc; the denominator no longer needs the `Math.max(...,0.0001)` floor.

`Math.max(entry - stop, 0.0001)` floors the stop-distance denominator instead of rejecting outright when `stop >= entry` (e.g. if `atr_5m` is anomalously 0/negative upstream). This can produce a thousands-to-one R:R that passes `minRrRatio` with a degenerate position.

**Suggested fix:** Explicitly reject (return no-setup) when `stop >= entry` for a long, rather than flooring the denominator.

---

### 10. Regime flip mid-blend discards in-progress blend state
**File:** `js/regime-engine.js`
**Status:** Resolved — on a new flip, `_prevSizeMult` now seeds from `_blendedSizeMult` (the actual in-progress value) when one exists, falling back to the full multiplier only when no blend was active.

If a second regime flip occurs while a previous 30-minute blend is still in progress, `_prevSizeMult` is reset to the just-completed regime's full `sizeMult` rather than the actual current blended value — producing a discontinuity (cliff-edge) rather than smooth interpolation under fast successive flips.

**Suggested fix:** When a new flip occurs mid-blend, seed `_prevSizeMult` from the currently-blended value, not the target regime's full multiplier.

---

### 11. No epsilon tolerance on share-count zero checks
**File:** `js/pages/portfolio.js` (e.g. `applySellToPortfolio`'s `holding.shares -= qty`), `js/pages/portfolio-helpers.js`
**Status:** Resolved — new shared `_SHARE_EPSILON = 1e-6` (portfolio-helpers.js); `applySellToPortfolio`, `rollbackTradeJournalEntry`, `_applyImportedSells`, and `computeCriticalAlerts`'s read-side filter all round to 4dp and use `Math.abs(shares) < _SHARE_EPSILON` instead of exact `<= 0`.

Exact `<= 0` comparisons risk a phantom near-zero holding surviving after many partial fills due to floating-point drift. Some paths (DRP, split adjustment) already round to 4dp; the sell path does not.

**Suggested fix:** Use an epsilon comparison (e.g. `Math.abs(holding.shares) < 1e-6`) consistently, and extend the existing 4dp-rounding convention to the sell path.

---

### 12. Penny-stock sanity-check exemption uses post-move price only
**File:** `indicators.py` — `_sanity_check`
**Status:** Resolved — exemption now requires BOTH the pre- and post-move close under $0.50 (`prev_close.shift(1)`); a boundary-crossing move is evaluated by the >25% filter symmetrically in both directions. Verified with a $0.60→$0.30 and $0.30→$0.60 test pair.

The >25% single-day move filter exempts a bar when `hist["Close"] < 0.50` — checking only the *current* (post-move) close. A move crossing the $0.50 boundary (e.g. $0.60 → $0.30, a genuine -50% move) is inconsistently exempted/flagged depending on direction, since the exemption logic only looks at one side of the move.

**Suggested fix:** Check both the pre-move and post-move close (or reference the previous close) against the threshold, not just the current bar's close.

---

## Verified clean (no action needed — do not re-audit)

- Wilson confidence interval (`_ci_excludes`) and Mann-Whitney U/z-score gate (`_mann_whitney_z`) — mathematically correct in `routes/learning.py`.
- Brier score computation — correctly excludes breakeven trades (binary win/loss only).
- Multi-tag `error_type` comma-splitting — correct at every call site checked: `_is_good_loss`, `_is_shock`, `failure_patterns.by_error_type`, `by_sector` dominant tag, calibration `top_err` nudge, stop-tag counterfactual SQL (`LIKE '%,stop_too_tight,%'`, correctly comma-padded).
- `classify_error_type_deterministic` / `compute_skill_score_deterministic` — all 5 `thesis_verdict` states (validated/partially_validated/invalidated/reversed/irrelevant) handled explicitly, no silent fallthrough to a wrong default.
- `_calib_cache` thread-safety — `deep` is part of the cache key (deep/light don't pollute each other); the lock only guards dict read/write; expensive DB work happens outside the lock.
- No SQL injection anywhere in `routes/learning.py` — all dynamic SQL (including `IN (...)` clauses) is parameterized.
- ATR (True Range) and Bollinger Band math — correct in `indicators.py`.
- `FACTOR_WEIGHTS` normalization — each component capped at its weight; total capped at 100 via `min(total, 100)`.
- `pre_earnings_risk` boundary (`0 <= days_to_earnings <= 14`) — correct, inclusive as documented.
- `earnings_history` API usage — confirmed using the non-deprecated yfinance API (not `quarterly_earnings`).
- `routes/backtest.py` slippage tiers (`_adv_slippage`) — monotonic, applied correctly to both sides.
- `routes/backtest.py` walk-forward parameter selection and AI-replay scoring — no lookahead/future-leak bias found.
- CGT FIFO/LIFO partial-parcel splitting — correctly splits parcels, decrements `remainingQty` in place.
- CGT 365-day discount eligibility boundary and date parsing — correct (uses local `Date(y,m,d)` construction, avoiding the classic UTC-shift bug).
- DRP weighted-average price formula — matches `(old_shares*old_avgPrice + new_shares*drp_price) / (old+new)`.
- `_detectExitReason` direction-awareness (BUY/TOP_UP vs SELL/TRIM stop/target framing) — confirmed correct in the current `js/utils.js` implementation.
- Regime `stopAtrMult` values (2.5 riskOn/trend/sideways, 3.0 highVol, 3.5 riskOff, 4.0 panic) and panic hard-block (`sizeMult=0` → `_regimeBlocked`) — correctly implemented.
- `earningsAdj = 1.3` pre-earnings stop multiplier — applied once, to ATR stop distance only, not double-applied.
