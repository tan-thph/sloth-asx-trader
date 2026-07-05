# fixes.md — Paper/Real Firewall + Learning Loop Audit

Audit date: 2026-07-03. Scope: (1) Live/Paper trade separation (gotcha #88 firewall), (2) Learning Loop pipeline. Findings verified against source AND the live `asx_trader.db` (read-only queries), not just inferred. Baseline at audit time: `python test_app.py` 865 tests green, `npm run test:js` 183 tests green — **none of the issues below are caught by the existing suites.**

Prior audit (2026-06-25, Trade Journal/account-type/parcel matching — all 9 findings fixed) is preserved in git history at `c81ebe9`.

Each entry has a `Status` field. Flip to `Resolved` (with a one-line note + commit ref) once fixed.

---

## 1. [CRITICAL] Holding `mode` is not persisted — the real book demotes to paper on every reload

**Status:** Resolved — `portfolio.mode` column + `UNIQUE(ticker,account,mode)` migration (`db.py`), `db_save`/`db_load` plumbing (`routes/portfolio.py`), `_validHolding` preserves mode (`js/api.js`). Round-trip tests both sides.
**Files:** `routes/portfolio.py` (`db_save` ~:101-106, `db_load` ~:219-228), `db.py` (portfolio schema, ~:39 + migration ~:400-425), `js/api.js` (`_validHolding()` :194-207)

**Problem:** The paper/real firewall keys everything off `holding.mode`, but the `portfolio` table has no `mode` column:

- `db_save()` INSERT lists `(ticker, shares, avg_price, current_price, sector, account)` — `mode` is silently dropped on every save.
- `db_load()` never returns a `mode` field.
- Even if it did, the client-side sanitiser `_validHolding()` (api.js) rebuilds each holding from an explicit field list that **omits `mode`** — so mode is stripped a second time on load.
- Nothing at init time rebuilds holding modes from parcels (init.js only runs `reconcileJournalParcels()`, which is journal→parcels, not parcels→portfolio).

Per the `isRealTrade()` invariant, missing mode ⇒ paper. So **every save→reload cycle reclassifies every real holding as paper.**

**Observed impact (live DB, confirmed):** The persisted NAV series collapsed today:

```
02-07-2026  netWorth=56,062  portfolioValue=47,197  cash=8,865
03-07-2026  netWorth= 8,865  portfolioValue=     0  cash=8,865   ← real PV read as $0
```

`recordPortfolioSnapshot()` uses `realPortfolioValue()` (filters `isRealTrade(h)`), found zero "real" holdings, and recorded net worth = cash only. This is almost certainly what prompted today's DB restore (`asx_trader.db.pre-restore-20260703-154303`). The restore does not fix anything — the next save/reload reproduces it.

**Secondary impact:** real SELL/TRIM execution breaks. `markExecuted()` resolves the holding via `getPortfolioHolding(ticker, acct, 'real')`; with all holdings demoted to paper the lookup fails → `_executionFailed` → "no position found — trade not executed".

**Fix:**
1. `db.py`: idempotent migration adding `mode TEXT NOT NULL DEFAULT 'paper'` to `portfolio`, and recreate the table with `UNIQUE(ticker, account, mode)` (see finding #2). Backfill policy for existing rows is finding #3.
2. `routes/portfolio.py db_save()`: add `mode` to the INSERT (`h.get("mode") or "paper"`).
3. `routes/portfolio.py db_load()`: return `"mode": (row["mode"] if "mode" in row.keys() else None) or "paper"` (same pattern as trade_journal).
4. `js/api.js _validHolding()`: preserve `mode: h.mode === 'real' ? 'real' : 'paper'`.
5. Add a round-trip regression test on both sides (test_app.py save→load keeps mode; vitest `_validHolding` keeps mode).

⚠️ Note the backfill interaction: the DEFAULT must be `'paper'` for *inserts*, but blindly stamping existing rows `'paper'` cements finding #3. Do the migration and the backfill (finding #3) in the same release.

---

## 2. [HIGH] `db_save` portfolio INSERT violates `UNIQUE(ticker, account)` once a ticker is held in both modes → every subsequent save silently fails

**Status:** Resolved — `UNIQUE(ticker, account, mode)` (folded into #1's table rebuild) lets a real+paper lot coexist; `saveStateToDb()` now surfaces persistent (≥2 consecutive) non-409 save failures via toast (`js/api.js`, IMPROVEMENTS #5).
**Files:** `db.py` (portfolio migration `UNIQUE(ticker, account)` :416), `routes/portfolio.py` (`db_save`), `js/api.js` (`saveStateToDb` catch-all)

**Problem:** The client deliberately keeps a real and a paper lot of the same ticker+account as **two separate `state.portfolio` rows** (`applyBuyToPortfolio` keys by ticker+account+mode; `mergedPortfolio` keys the same way). But the table's `UNIQUE(ticker, account)` constraint only allows one. `db_save()` does DELETE+INSERT inside one transaction; the second row raises `IntegrityError` → the whole save 500s → the transaction rolls back → **and `saveStateToDb()`'s `catch(e) { /* silent */ }` swallows it.** From the moment a user paper-trades a ticker they also hold for real, *no state persists at all* — every trade/journal/settings change since is lost on next reload, with zero user-visible signal.

**Repro:** Hold CBA (real). Execute any paper BUY of CBA in the same account. Watch the next `POST /api/db/save` return 500; close the tab; reload — the paper trade (and everything else changed since) is gone.

**Fix:** Fold into finding #1's table recreation: `UNIQUE(ticker, account, mode)`. Separately, `saveStateToDb()` should surface non-409 failures (one-shot toast "Save failed — changes are not being persisted") instead of unconditionally swallowing; silent persistent save failure is the worst failure mode this app can have.

---

## 3. [CRITICAL — data, not code] No migration for pre-firewall records — the user's entire real history is now invisible to every real-only surface

**Status:** Resolved (tool shipped; user must run it once) — `POST /api/portfolio/backfill-modes` (dry-run first) marks all holdings/journal/parcels/disposals/recs/learning-events real, preserving the 2 explicitly-paper parcels + anything linked to them. UI: Settings → Data maintenance → "Reclassify legacy records as real…". Bumps `_state_version` + reloads state so the migration can't be clobbered back to paper.
**Files:** data in `asx_trader.db`; migration touchpoints in `db.py`, plus a one-time UI/endpoint

**Problem:** The firewall ships with "missing mode ⇒ paper", which is the correct fail-safe **for new records**, but nothing migrated the existing book. Live DB today:

- `portfolio`: 21 holdings, all mode-less ⇒ all paper (BHP, CBA, WOW, MQG… — plainly the user's real positions).
- `trade_journal`: all 71 rows now literally stamped `mode='paper'` — the server default (`t.get("mode") or "paper"`) **rewrote** legacy rows on the first post-feature save, so "legacy real" and "deliberately paper" are no longer distinguishable from the data alone.
- `cgtParcels` blob: 49 of 51 parcels mode-less ⇒ paper.
- `ai_learning_events.trade_mode`: all 41 = 'paper'.

**Impact:** Every real-only surface is empty or wrong: **EOFY tax pack (FY25-26 just closed — it would export zero disposals)**, CGT liability summary, NAV history (finding #1's collapse), Performance real view, `real_vs_paper` learning stats (n_real=0). The firewall's stated guarantee ("paper can never leak into tax records") is upheld, but the inverse — real records leaking *out* of tax records — happened wholesale.

**Fix:** One-time guided migration, user-confirmed (cannot be inferred from data since journal modes were overwritten):
1. Backend endpoint or script: `mark all portfolio holdings / parcels / journal rows / disposals / rec_history / learning events created before <cutoff date> as real`, with a dry-run listing.
2. Sensible default cutoff: the date the paper feature shipped (first row with an explicit deliberate 'paper' choice — the 2 paper parcels give the boundary).
3. Re-record today's NAV snapshot after migration (see finding #6).
4. Going forward the `askTradeMode()` gatekeeper keeps modes explicit, so this is genuinely one-time.

---

## 4. [MEDIUM] HOLD recommendations are never logged — the entire HOLD-outcome feature is structurally dead

**Status:** Resolved — `runPortfolioAnalysis()` now concatenates the stripped HOLDs back into the `logRecsToLearningLoop([...cappedDedupedRecs, ..._holdRecs], …)` call (`js/analysis.js`), so HOLDs reach `ai_learning_events` as `was_executed=0`. The logger already tolerates their missing target/stop/qty.
**Files:** `js/analysis.js` (:1412 HOLD filter, :1663 `logRecsToLearningLoop(cappedDedupedRecs, …)`), `routes/learning.py` (`_resolve_hold_outcomes` :2726)

**Problem:** `runPortfolioAnalysis()` strips HOLD recs at line 1412 (`filteredRecs = recs.filter(r => … !== 'HOLD')`) and every downstream set (`conflictFreeRecs` → `cappedDedupedRecs`) derives from it — including the one passed to `logRecsToLearningLoop()`. So no HOLD event has ever reached `ai_learning_events` (confirmed live: recommendation distribution is BUY 3 / TOP_UP 6 / SELL 13 / TRIM 19 — zero HOLD). Meanwhile `_resolve_hold_outcomes()` selects `WHERE recommendation = 'HOLD'` — permanently zero rows. The `hold_outcomes` stats block, the `virtual_hold_miss/virtual_hold_correct` resolution, and the `⚠HOLD_TOO_PASSIVE` calibration nudge (CLAUDE.md gotcha #85, documented as shipped) can never fire. The model is never graded on its passivity.

**Fix:** In `runPortfolioAnalysis()`, pass the *pre-HOLD-filter* rec list (or `filteredRecs` plus the dropped HOLDs) to `logRecsToLearningLoop()`, logging HOLDs as `was_executed=0` events. Keep the UI/pending-recs filtering exactly as is. One wrinkle: the same-day-conflict and dedup logic runs after the HOLD filter — simplest correct form is `logRecsToLearningLoop([...cappedDedupedRecs, ...recs.filter(r => r.action?.toUpperCase() === 'HOLD')], …)`.

---

## 5. [MEDIUM] Multi-account tickers never reconcile parent BUY/TOP_UP learning events

**Status:** Open
**File:** `js/pages/recommendations.js` (`markExecuted`, `if (positionClosed && _distinctAccts.length <= 1)` ~:1992)

**Problem:** The parent-event reconciliation block (grades all open BUY/TOP_UP learning events when a position fully closes) is gated on `_distinctAccts.length <= 1`. For any ticker held in two accounts, fully closing one account's position skips reconciliation entirely — the parent events stay `outcome='open'` forever, exactly the calibration-pollution failure the 2026-06-25 audit's finding #2 fixed for the account-scoping half. The `<= 1` gate was presumably added as a conservative guard because recHistory parents carry no account marker, but the result is a permanent blind spot instead of an occasional misattribution.

**Repro:** Hold WDS in `trading` and `personal`. Fully SELL the `trading` position via a rec. The original `trading` BUY's learning event is never graded.

**Fix:** Journal rows *do* carry `account` — resolve parents via their `journalId`/executed journal rows scoped to `sellAccount` instead of gating the whole block off. Interim cheaper fix: keep the gate but log a visible warning + surface these in `/api/learning/untagged`-style hygiene so they aren't silently open forever.

---

## 6. [LOW] Corrupt 03-07-2026 NAV snapshot needs repair; snapshots have no plausibility guard

**Status:** Resolved (guard) — `recordPortfolioSnapshot()` now skips + `console.warn`s when `realPortfolioValue()===0` while open real parcels exist (`js/prices.js`). The poisoned 03-07 point self-heals via same-day overwrite once the user runs the #3 migration + refreshes prices (still same date).
**Files:** data (`blob_store.portfolioHistory`), `js/prices.js` (`recordPortfolioSnapshot` :214)

**Problem:** Finding #1 already wrote a poisoned snapshot (`03-07-2026 nw=8,865 pv=0`) into the persisted 37-point NAV series. Same-day overwrite will *not* heal it after the mode fix unless a snapshot is re-recorded on the same date string; any drawdown-alert or performance math spanning that date sees a fake −84%/+540% swing. There is also no guard against recording a snapshot whose real PV is $0 while open real parcels exist.

**Fix:** (a) After findings #1/#3 land, force-re-record today's snapshot (the function already overwrites same-day). If the fix lands after date rollover, patch the bad point directly. (b) Add a cheap guard in `recordPortfolioSnapshot()`: if `realPortfolioValue() === 0` while `state.cgtParcels` contains open real parcels, skip the snapshot and `console.warn` — a $0 real book with real lots open is always an upstream data bug, never a market outcome.

---

## 7. [LOW] `quickSellFromAlert()` / critical-alert P&L use mode- and account-blind holding lookups

**Status:** Open
**File:** `js/portfolio-helpers.js` (`computeCriticalAlerts` :16, `renderCriticalAlertBanners` :100, `quickSellFromAlert` :147)

**Problem:** All three call `getPortfolioHolding(ticker)` bare — first array match wins regardless of account/mode. With a ticker held both real and paper (or in two accounts), the alert banner's "Position value / Unrealised P&L" and the pre-filled SELL qty can reflect the *wrong* book (e.g. pre-filling a real SELL with the paper lot's share count). Alerting on paper holdings at all is also debatable.

**Fix:** Aggregate across matching holdings for display; for the pre-fill, either sum per-mode and let the journal's `askTradeMode()` + mode-scoped sell matching catch mismatches (it will — sell will fail if qty exceeds the chosen book), or prompt for book first. Low urgency because the sell path itself is firewalled.

---

## Remediation plan (suggested order)

| Step | Findings | Why this order |
|---|---|---|
| 1 | #1 + #2 in one migration (mode column + UNIQUE(ticker,account,mode) + save/load/validator plumbing + tests) | Everything else is moot while mode can't round-trip; #2 shares the table rebuild |
| 2 | #3 legacy backfill (user-confirmed, dry-run first) | Needs #1's column to exist; unblocks EOFY/CGT/NAV/real-perf immediately — time-sensitive (FY25-26 tax pack) |
| 3 | #6 snapshot repair + guard | One-liner once #1/#3 restore real PV |
| 4 | #4 HOLD logging | Independent; starts accumulating HOLD data (30-day resolution lag means the sooner it lands the sooner the nudge can ever fire) |
| 5 | #5, #7 | Correctness hardening, lower blast radius |

Also add to the suites: a Python round-trip test asserting `portfolio` save→load preserves `mode` for a dual-mode ticker (would have caught #1 and #2), and a vitest asserting `_validHolding` preserves `mode`.
