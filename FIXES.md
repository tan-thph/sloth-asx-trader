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

**Status:** VOID — do NOT run the backfill. The user confirmed (2026-07-06) that **every trade currently in the app is genuinely paper** — there is no pre-firewall *real* history to recover. The all-`paper` tagging is therefore correct, not a data-loss bug, and the 03-07 NAV snapshot showing real PV=$0 (finding #1/#6) is the *right* answer (no real holdings exist → real NAV is just cash). Running `POST /api/portfolio/backfill-modes` here would be actively harmful: it would fabricate real disposals in the EOFY/CGT tax surfaces and inject a fictitious real book into the NAV series. The tool remains available (Settings → Data maintenance) for the eventual real→live transition, but must stay unrun while the book is all-paper. The mode-persistence *code* fix (finding #1, gotcha #91) is still correct and necessary — it's what will keep real and paper separate once live trading begins.
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

**Status:** Resolved — `runPortfolioAnalysis()` now concatenates the stripped HOLDs back into the `logRecsToLearningLoop([...cappedDedupedRecs, ..._holdRecs], …)` call (`js/analysis.js`), so HOLDs reach `ai_learning_events` as `was_executed=0`. The logger already tolerates their missing target/stop/qty. **Follow-up (2026-07-06):** server-side dedupe added to `POST /api/learning/log` — HOLDs re-fire for every holding on every analysis run, so without a guard a daily-analysed 15-stock book logs ~450 HOLD events/month (each needing a yfinance fetch in `_resolve_hold_outcomes`, capped 5/call). Now at most one HOLD event per ticker per `_HOLD_DEDUP_DAYS` (7d); the duplicate returns the existing id with `deduped: true`. Tests in `TestHoldOutcomeTracking`.
**Files:** `js/analysis.js` (:1412 HOLD filter, :1663 `logRecsToLearningLoop(cappedDedupedRecs, …)`), `routes/learning.py` (`_resolve_hold_outcomes` :2726)

**Problem:** `runPortfolioAnalysis()` strips HOLD recs at line 1412 (`filteredRecs = recs.filter(r => … !== 'HOLD')`) and every downstream set (`conflictFreeRecs` → `cappedDedupedRecs`) derives from it — including the one passed to `logRecsToLearningLoop()`. So no HOLD event has ever reached `ai_learning_events` (confirmed live: recommendation distribution is BUY 3 / TOP_UP 6 / SELL 13 / TRIM 19 — zero HOLD). Meanwhile `_resolve_hold_outcomes()` selects `WHERE recommendation = 'HOLD'` — permanently zero rows. The `hold_outcomes` stats block, the `virtual_hold_miss/virtual_hold_correct` resolution, and the `⚠HOLD_TOO_PASSIVE` calibration nudge (CLAUDE.md gotcha #85, documented as shipped) can never fire. The model is never graded on its passivity.

**Fix:** In `runPortfolioAnalysis()`, pass the *pre-HOLD-filter* rec list (or `filteredRecs` plus the dropped HOLDs) to `logRecsToLearningLoop()`, logging HOLDs as `was_executed=0` events. Keep the UI/pending-recs filtering exactly as is. One wrinkle: the same-day-conflict and dedup logic runs after the HOLD filter — simplest correct form is `logRecsToLearningLoop([...cappedDedupedRecs, ...recs.filter(r => r.action?.toUpperCase() === 'HOLD')], …)`.

---

## 5. [MEDIUM] Multi-account tickers never reconcile parent BUY/TOP_UP learning events

**Status:** Resolved (2026-07-06) — the `_distinctAccts.length <= 1` gate is removed; parents are resolved per-account via `_parentInSellAccount()`: a parent BUY/TOP_UP is reconciled iff a journal row with its `recId` sits in `sellAccount` (+ same mode; includes `RECLASSIFY` per gotcha #79). A parent with no matching journal row stays open (conservative — it may belong to the other, still-open account). Source-guard test in `TestFixes5And7MultiAccountAndAlerts`.
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

**Status:** Resolved (2026-07-06) — new `_holdingsForTicker()` helper returns every account/mode row (skipping zero-share rows). `computeCriticalAlerts()` alerts if ANY book holds shares (the old first-match lookup could hit a zero-share row and suppress the alert); banner value/P&L aggregate across all books; `quickSellFromAlert()` shows a per-book breakdown and pre-fills the LARGEST book's qty (pre-filling the aggregate would guarantee a failed mode-scoped sell match) — the journal's `askTradeMode()` + account field still confirm the exact book. Vitest coverage in `paper-real-firewall.test.js`; source guard in `TestFixes5And7MultiAccountAndAlerts`.
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

---

# Audit 2026-07-08 — Claude API prompts + Learning Loop (planning/audit only, no code changed)

Scope: (1) the Claude API call pipeline — `js/prompts.js`, `js/claude-client.js`, `js/prompt-modules.js`, prompt assembly + post-response processing in `js/analysis.js`; (2) the Learning Loop — `js/learning-loop.js`, `logRecsToLearningLoop()`, `routes/learning.py _calib_compute()`. Findings verified by reading source and cross-grepping writers/readers (no runtime verification this pass). Numbering continues from the 2026-07-03 audit.

## 8. [HIGH] HOLD outcome tracking is dead again on the Claude path — the forced tool schema and Rule 5 both forbid HOLD

**Status:** Open
**Files:** `js/claude-client.js` (`_PORTFOLIO_TOOL` action enum ~:68), `js/prompts.js` (Rule 5 ~:76), `js/analysis.js` (`_holdRecs` ~:1750)

**Problem:** FIXES #4 (2026-07-03) wired `_holdRecs` so HOLD recs reach `POST /api/learning/log`. But on the cloud path a HOLD can never exist to be logged:
- `_PORTFOLIO_TOOL.input_schema` constrains `action` to `enum: ['BUY','SELL','TRIM','TOP_UP']` — with forced tool use (`tool_choice`), the API grammar-level blocks `HOLD`.
- Rule 5 in `ANALYSIS_SYSTEM_PROMPT` explicitly instructs: "omit that ticker from recs[] entirely — do NOT add a HOLD entry. recs[] must contain only actionable trades".

So `recs.filter(action === 'HOLD')` is always empty when `useLocalLLM` is off; `_resolve_hold_outcomes()`, the `hold_outcomes` stat, and the `⚠HOLD_TOO_PASSIVE` nudge only accumulate data from the local Ollama path (whose 5-action enum does include HOLD — `routes/debate.py:2831`). The FIXES #4 remediation is structurally inert for the primary (Claude) pipeline.

**Fix (pick one, deliberately):**
1. Re-admit HOLD: add `'HOLD'` to the tool enum and amend Rule 5 to distinguish "omit un-analysable watchlist tickers" from "emit an explicit HOLD (no target/stop/qty — `requiredUnless:'HOLD'` already handles this) for each *holding* you evaluated and chose to keep". The UI filter already strips HOLDs before rendering, and `POST /api/learning/log` already dedupes to one HOLD per ticker per 7d, so the blast radius is prompt+schema only. **Recommended** — it is the only way the passivity feedback loop gets data.
2. Or accept HOLD-learning as local-only and remove/annotate the `⚠HOLD_TOO_PASSIVE` machinery + gotcha #85 so the next audit does not rediscover this.

## 9. [HIGH] The VaR1d size reduction promised to Claude never runs — `signals.var_1d` has no writer

**Status:** Open
**Files:** `js/quant-engine.js` (~:148-160), `js/analysis.js` (quant post-processing ~:981-991, `_riskMetrics` ~:222-251), `js/prompts.js` (Rule 16), rules block (`analysis.js` ~:670 "VaR1d thresholds: <-3.5% → qty−25%; <-5.0% → qty−50%")

**Problem:** `computeTradeParams()` implements the VaR modifier (`varMult` 0.75/0.50) off `signals.var_1d` — but a repo-wide grep shows **nothing ever writes `var_1d`** into `state.liveSignals` or the signals object passed in. The per-ticker VaR lives in `_riskMetrics[t].var_95` (fetched from `GET /api/risk` at the top of `runAnalysis()`) and is only used to build the prompt's risk table. Meanwhile the system prompt (Rule 16: "the quant engine will reduce position size") and the ACTIVE RULE OVERRIDES block explicitly promise the reductions. Net effect: high-VaR positions are sized as if VaR were normal, and Claude has been told not to compensate.

**Fix:** in the quant post-processing loop in `analysis.js`, pass the fetched metric through:

```js
const qt = computeTradeParams(r.ticker,
  { ...signals, var_1d: _riskMetrics[r.ticker]?.var_95 ?? null },
  _portfolioCtx, {...});
```

(`_riskMetrics` is already in scope.) Add a Vitest asserting `varMult` fires at var_1d = −4 and −6.

## 10. [MEDIUM] `primary_entry_driver` is missing from the forced tool schema — the keystone field of the entry-driver taxonomy is emitted only by luck

**Status:** Open
**Files:** `js/claude-client.js` (`_PORTFOLIO_TOOL.properties` ~:67-98)

**Problem:** The schema declares `primary_driver`, `secondary_factors`, `urgency`, `alternativeTicker` (SELL-side tags) but **not** `primary_entry_driver` (BUY/TOP_UP side) and not `reallocationSuggestion`. `additionalProperties` defaults to true so the field *can* still arrive, but constrained decoding biases generation toward declared properties — this is the most likely cause of the historical null-driver rows that required `POST /api/learning/backfill-entry-drivers`. Everything downstream (thesis matrix, driver playbook, driver×regime cross-tabs, `computeThesisDrift`) keys off this field.

**Fix:** add to the schema (static — one-time cache bust, then stable):

```js
primary_entry_driver:   { type: 'string', enum: ['mean_reversion','momentum_breakout','trend_pullback','fundamental_value','macro_tailwind'] },
reallocationSuggestion: { type: ['string','null'] },
```

## 11. [MEDIUM] `ensembleConfidence` is direction-blind — a bullish indicator score *raises* the ensemble confidence of a SELL/TRIM

**Status:** Open
**Files:** `js/analysis.js` (~:1266-1273)

**Problem:** `ensembleConfidence = 0.5×confidence + 0.5×(score/100)` for every rec. `score` is the bullish setup score (0–100). For SELL/TRIM, a strongly bullish score should *contradict* the exit, not reinforce it. As written, a SELL on a ticker scoring 85 gets a higher ensemble confidence than one scoring 30 — inverted. This pollutes `ensemble_confidence` in `ai_learning_events` and the `ensemble_divergence` stat for all exit recs.

**Fix:** for SELL/TRIM blend with `(100 − indScore)/100`; leave BUY/TOP_UP as-is; leave HOLD unblended.

## 12. [MEDIUM] `HIGH_VOL_REGIME` module contradicts the regime engine's stop policy and Rule 4

**Status:** Open
**Files:** `js/prompt-modules.js` (~:87-100), `js/regime-engine.js` (`stopAtrMult` map), `js/analysis.js` (ATR floor ~:1092-1114)

**Problem:** In a highVol regime the model receives three mutually contradictory stop instructions in one request: the module says "Stop distance: use 2.0×ATR (tighter than 2.5×)", the ACTIVE RULE OVERRIDES line says `Stop ATR: 3×ATR14` (`getRegimeModifiers('highVol').stopAtrMult` = 3.0), and the post-response ATR floor then silently enforces 3.0× anyway. The module also says "Reduce qty by 30%" although Rule 4 mandates qty=0 (the engine sizes; any qty arithmetic is discarded). `MINING_SECTOR` similarly says "Recommend HOLD or TRIM only" although HOLD is banned/schema-blocked (finding #8). Conflicting instructions measurably degrade rule compliance across the board, not just on the conflicting rules.

**Fix:** strip all stop/qty arithmetic from the regime/sector modules — keep only behavioural guidance (confidence floors, setup preferences, factors to cite). Stops and sizes are engine-owned; the modules should say so, not compete.

## 13. [LOW] The JSON example in `ANALYSIS_SYSTEM_PROMPT` contradicts Rule 4 (`"qty": 50`) and contains a `//` comment inside JSON

**Status:** Open
**Files:** `js/prompts.js` (schema example ~:587-621)

**Problem:** Rule 4 (and the field spec: `"qty": 0 // always 0`) mandates qty=0, but the worked example emits `"qty": 50`. Models imitate examples over rules when they conflict. The example also carries an inline `//` comment on the scenarios line — harmless under forced tool use, but it models invalid JSON for the no-tool escape hatch (`options.noTool`).

**Fix:** set the example qty to 0 and move both comments outside the example block. Bump `PROMPT_VERSION`.

## 14. [LOW] `callClaude()` retry loop is bypassed by non-JSON error bodies

**Status:** Open
**Files:** `js/claude-client.js` (~:296)

**Problem:** `const data = await resp.json();` is unguarded. A proxy-side 502/504 (HTML body from waitress or an intermediary) throws a SyntaxError that escapes the retry loop entirely — the one failure class the backoff was built for. Network errors and 429/529 are handled; malformed bodies are not.

**Fix:** wrap in try/catch; on parse failure set `lastErr = new Error('HTTP ' + resp.status + ' — non-JSON response')` and `continue`.

## 15. [LOW] `netProfit`/EV gate computed at a qty that later shrinks — correlation sizing and heat budget run after the §8.2 recompute

**Status:** Open
**Files:** `js/analysis.js` (order: EV recompute ~:1324-1357 → `_applyCorrSizing` ~:1398-1411 → `_applyHeatBudget` ~:1417-1484)

**Problem:** The engine-side net-EV gate and the displayed `netProfit`/`expectedProfit` are computed from the quant qty, but `_applyCorrSizing` (−30 %/−50 %) and the heat budget (`_budgetScaled`) can halve qty afterwards without recomputing. The rec card then shows a P&L inconsistent with its own qty, and a rec that would fail the EV gate at its *final* (post-correlation) qty passes it at the pre-correlation qty (brokerage is fixed, so smaller qty ⇒ worse net EV).

**Fix:** extract the EV recompute into a helper and re-run it once after the last sizing mutation (post-heat-budget), or reorder so EV is the final step.

## 16. [LOW] Whipsaw check runs a full calibration compute per rec ticker

**Status:** Open
**Files:** `js/analysis.js` (~:1209-1221), `routes/learning.py` (`learning_calibration` cache key ~:4635)

**Problem:** For every unique rec ticker the whipsaw block fetches `GET /api/learning/calibration?tickers=<tk>&days=180` just to regex one per-ticker line out of the text block. Each cache miss runs `_calib_compute()` — including all eight lazy resolvers (yfinance-backed) — and inserts a per-ticker cache key (cache capped at 50, evicting the useful keys). With 6–8 recs this adds seconds of backend work per analysis for ~15 tokens of context, and only *flipped* tickers ever use the result.

**Fix:** fetch the historical context only for recs that actually flipped direction (move the fetch below the flip check), or add a lightweight per-ticker WR endpoint instead of reusing the full calibration pipeline.

---

## Resolution log — 2026-07-08 (implemented + re-verified same day)

All nine defects from the 2026-07-08 audit (#8–#16) were implemented and **re-verified after later agents bumped the prompt v17→v20**. Every fix survived that work intact. Suites green: **917 Python + 216 JS tests pass** (source-guard tests updated: enum now includes HOLD, PROMPT_VERSION guard → v20, ensemble guard asserts the direction-aware `100 - indScore` inversion).

| # | Change | Files |
|---|---|---|
| 8 | `HOLD` re-admitted to `_PORTFOLIO_TOOL` action enum + `required` narrowed to `[ticker,action,confidence,reasoning]`; Rule 5 reworded to emit HOLD for evaluated-and-kept holdings (not watchlist); confidence-floor pass skips HOLD | `js/claude-client.js`, `js/prompts.js`, `js/analysis.js` |
| 9 | `_riskMetrics[t].var_95` passed as `signals.var_1d` into `computeTradeParams()` so the Rule-16 VaR size reduction fires | `js/analysis.js` |
| 10 | `primary_entry_driver` (enum) + `reallocationSuggestion` added to the tool schema | `js/claude-client.js` |
| 11 | `ensembleConfidence` inverts the bullish setup score (`100 - indScore`) for SELL/TRIM | `js/analysis.js` |
| 12 | Stripped 2.0×ATR stop + qty−30% arithmetic from `HIGH_VOL_REGIME`; `MINING_SECTOR` no longer says "HOLD or TRIM only" | `js/prompt-modules.js` |
| 13 | Example `qty` set to 0; inline `//` comment removed | `js/prompts.js` |
| 14 | `resp.json()` wrapped in try/catch inside the retry loop | `js/claude-client.js` |
| 15 | `_recomputeBuyEv()` helper + final refresh pass so netProfit reflects post-correlation/heat-budget qty | `js/analysis.js` |
| 16 | Whipsaw check fetches historical calibration only for tickers that flipped direction within 10d | `js/analysis.js` |

IMPROVEMENTS I-6 also done: stale comments (portfolio maxTokens, ESS 2.5→6.0, `dir()` idiom, news 2d→3d).

---

## 17. [MEDIUM] `portfolioSynthesis` repeats the #10 gap — prompt-required + validator-enforced, but absent from the forced tool schema

**Status:** Resolved (2026-07-08) — chose the lean option (2): the LLM `portfolioSynthesis` + Section 3B prompt block + validator gate were removed; the book snapshot is now computed **deterministically** in `analysis.js` (top-sector/top-name concentration + cash % + a compact changes-since-last-review tail) and rendered as "📊 Book snapshot". PROMPT_VERSION → v21. Suites green (213 JS + 917 PY).
**Files:** `js/claude-client.js` (`_PORTFOLIO_TOOL` top-level `properties`/`required` ~:59-128), `js/prompts.js` (Section 3B / OUTPUT), `js/response-validator.js` (~:563), `js/analysis.js` (`[auto]` fallback ~:1834-1845)

**Problem:** `portfolioSynthesis` is marked REQUIRED in the prompt, enforced by the validator (error when holdings exist), rendered on the Recommendations page, and has a deterministic `[auto]` backfill in analysis.js. But it is **not** declared in `_PORTFOLIO_TOOL.properties` and **not** in the top-level `required: ['recs','summary','dataGaps']`. Under forced tool use the model outputs only the tool input — an undeclared, non-required field is under-emitted (the exact #10 pattern). Result: the `[auto]` "Model omitted synthesis — factual context only." fallback likely fires most runs, so the elaborate qualitative PM view rarely reaches the user; the machinery mostly renders deterministic concentration/cash facts you already had.

**Fix (pick one — the second is the lean choice):**
1. Wire it: add `portfolioSynthesis: { type: 'string' }` and `deferrals` to the schema, add `portfolioSynthesis` to top-level `required`. 2-line change; makes the feature actually fire.
2. If the qualitative synthesis isn't earning its complexity (validator + fallback + UI + prompt section), keep only the deterministic `[auto]` concentration/cash line and drop the model-generated version + its Section 3B prompt block. Simpler, and it's what the user usually sees anyway.

## 18. [LOW] `deferrals[]` is dead output — the model is told to produce it but nothing consumes it

**Status:** Resolved (2026-07-08) — `deferrals[]` removed entirely from the prompt (Shape + spec) and the validator; anti-churn/timing holdbacks fold back into `dataGaps[]` with a note. No consumer existed, so nothing downstream changed.
**Files:** `js/prompts.js` (~:350, 540, 555, 557), `js/response-validator.js` (~:573)

**Problem:** The prompt instructs the model to emit `deferrals: [{ticker, reason}]` (anti-churn/timing holdbacks split out of `dataGaps`). The validator passes it through, but **no code in `js/` reads or renders it** (grep: only prompts.js + the validator's pass-through). It is neither shown to the user nor logged to the learning loop — pure output-token spend with no consumer.

**Fix (lean):** either drop `deferrals[]` from the prompt/output entirely (fold anti-churn holdbacks back into a summary note), or render it on the Recommendations page / log it as a deferral event if the intent was to track them. Do not leave it as an unconsumed required output.
