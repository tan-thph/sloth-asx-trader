# Doc Sync Spec — Post Sprint 43–46 + hotfixes

Work in /home/tanth/projects/sloth-asx-trader. This is a documentation-only task —
update four markdown files to reflect the current state of the codebase.
Do NOT edit any .py or .js files.

Read each target file IN FULL before editing it. Then read the code files listed
under each section to verify current implementation before writing.

## Changes to incorporate (all confirmed shipped)

### Sprint 43 (commit 3278c37)
- `_detectExitReason` hoisted from recommendations.js + performance.js → `js/utils.js`
- Stooq rate-limit semaphore: `_stooq_sem = threading.BoundedSemaphore(1)` in `core.py`;
  `indicators.py` imports and uses it in `_fetch_stooq_history()`
- `FACTOR_WEIGHTS` normalization guard: `warnings.warn` at import if sum != 100
- "Why this rec?" traceability panel on pending rec cards

### Sprint 44 (commit 549f885)
- DRP parcel tracking: "DRP" button per holding row → modal → `applyDrpEvent()` in portfolio.js;
  adds to `state.cgtParcels`, `state.tradeJournal`; indigo badge in cgt.js and journal.js
- `virtual_speed_weight REAL` column on `ai_learning_events` via `_LE_MIGRATIONS`;
  `_resolve_virtual_outcomes()` writes it; `_calib_compute()` applies as multiplier on virtual rows only
- Regime-flip calibration penalty: on flip, `fetchAndClassifyRegime()` writes
  `regime_flipped_at` + `regime_flipped_to` to localStorage; `fetchCalibrationBlock()` passes them
  as query params; backend halves HL for <10 trades in new regime; emits ⚠REGIME_FLIP token
- `breadth_scope TEXT` on `trading_lessons`; `GET /api/learning/lessons` accepts `adl` + `asx_vol`
  params and filters accordingly; create-lesson form has scope dropdown; `analysis.js` passes
  current ADL + asx_vol when fetching lessons

### Sprint 45 (commit 2352f25)
- Thesis drift detection: `_compute_thesis_drift(conn)` in learning.py; `GET /api/learning/thesis-drift`;
  `renderThesisDriftCard()` on Learning page; nudge token `⚠EARLY_EXIT_DRAG` injected into calibration
  block when manual exit avg P&L lags target-hit avg by >3pp (n≥5 each bucket)
- Stop-loss trailing: `trailStop(recId)` in recommendations.js; "📍 Trail" button on BUY/TOP_UP/SELL/TRIM
  pending recs; uses live ATR × regime stopAtrMult; only tightens, never loosens; `_stopTrailed: bool`,
  `_stopTrailedAt: ISO string` on rec; "📍 Trailed" badge shown
- Scheduled morning briefing: `state.settings.autoBriefTime` ('HH:MM' AEST, empty=disabled);
  `checkAutoBriefSchedule()` in scheduler.js; fires `generateMorningBrief()` once per day at/after
  configured time; `localStorage.autoBriefFiredDate` guard

### Sprint 46 (commit 6d1fc91)
- Broker CSV SELL import: `sells[]` array returned from `POST /api/import/csv` (was all skipped);
  frontend shows FIFO-match confirmation table with per-parcel cost basis, gain/loss, CGT discount
  flag; `applyImportedSell()` in portfolio.js; CGT-at-risk warning for parcels 320–365 days old
- Rebalancing suggestions panel: "📋 Suggest Rebalance" button on Risk page target-alloc drift card;
  `_buildRebalanceSuggestions()` — deterministic, no Claude call; shows BUY/TRIM shares to close
  drift gaps ≥1%; cash shortfall warning; CGT discount warning; renders in `<dialog>` modal
- ASX universe exclusion list: `POST /api/market/universe-exclude` + `DELETE /api/market/universe-exclude`;
  stores in `blob_store.universe_excluded`; scanner and intraday routes filter excluded tickers;
  Settings health card shows excluded count, per-stale-ticker "Exclude" button, re-include controls

### Hotfixes (commits a888eec, 9e6b265, 16bba99, f15a56f)
- `fetch_with_retry` in core.py: new `_http_status()` helper; 4xx errors (except 429) are NOT
  retried — breaks retry loop immediately; 429 gets min 5s sleep
- Auto-debate triggers removed: `triggerCalibQualityIfStale()` call removed from analysis.js;
  `triggerPostmortem()` and `fetchSkillScore()` auto-calls removed from markExecuted() in
  recommendations.js; calib-quality card on Learning page now loads with `cache_only=1` and
  shows "▶ Run debate" button when no cached result; `routes/debate.py` accepts `cache_only=1`
- currentPrice fix: `portfolioJson` in analysis.js now uses `livePrice = state.liveSignals[ticker].current_price ?? h.currentPrice` consistently for ALL price-derived fields (currentPrice, value, unrealisedPnl, unrealisedPnlPct, weight)
- Phase 8 gate in `_calib_compute()`: was using raw mean comparison; now uses `_mann_whitney_z() > 1.28`
- `_HL_MAP` in `_calib_compute()`: phantom regime names removed; now keyed on actual regime names
  from classifyRegime(): panic=20, riskOff=30, highVol=35, trend=45, riskOn=50, sideways=60
- `_REGIME_GROUPS` in `_calib_compute()`: bearish={riskOff,panic}, bullish={riskOn,trend},
  neutral={highVol,sideways}
- DB pragma parity: `announcement_engine.py` and `news_engine.py` local context managers now
  set `synchronous=NORMAL`, `mmap_size=268435456`, `cache_size=-65536`, `temp_store=MEMORY`
  to match `db.get_db()`
- DRP multi-account fix: `applyDrpEvent()` now matches by ticker + activeAccount
- Settings: `universe_excluded` and `universe_verified_at` now returned by `GET /api/db/load`
- 6 audit bugs fixed (Phase 8 gate, HL_MAP, auto-brief function name, settings path, DRP
  multi-account, unrealisedPnlPct inconsistency)

---

## Files to update

### 1. CLAUDE.md

Read the full file first. Then make these targeted updates:

**`core.py` row in backend table:**
- Add `_http_status()` helper (detects status from requests.HTTPError and urllib.error.HTTPError)
- Note `fetch_with_retry` skips retries on 4xx (except 429); 429 gets min 5s sleep

**`indicators.py` row:**
- Note `_STOOQ_SEM` imported from `core` and used in `_fetch_stooq_history()`

**JS load order section:**
- Confirm utils.js loads before recommendations.js and performance.js (it's the first in the list — correct)

**Infrastructure modules table — `js/analysis.js` row:**
- Add note: `portfolioJson` uses `livePrice = state.liveSignals[ticker].current_price ?? h.currentPrice`
  for all price-derived fields — ensures SELL/TRIM anchors to fresh signal price, not stale portfolio cache

**Infrastructure modules table — `js/regime-engine.js` row:**
- Add: on regime flip, `fetchAndClassifyRegime()` writes `regime_flipped_at` and `regime_flipped_to`
  to localStorage for calibration penalty

**Key data shapes section:**
- `state.recHistory` / `state.recommendations`: add `_stopTrailed?: bool`, `_stopTrailedAt?: ISO string`
- `state.tradeJournal`: note DRP is a valid `action` value alongside BUY/SELL/TRIM/TOP_UP
- `state.settings`: add `autoBriefTime: string` ('HH:MM' AEST, empty = disabled)
- `state.settings`: confirm `useLocalLLM`, `maxRiskBudgetPct` are documented (Sprint 42 added them)

**Learning Loop internals — `_calib_compute()` row:**
- Update Phase 8 gate: now uses `_mann_whitney_z() > 1.28` (was raw mean comparison — bug fixed)
- Add: `virtual_speed_weight` multiplier on virtual rows only (`min(1.0, 7.0/hold_days)`)
- Add: regime-flip penalty (halves HL for <10 trades when flip was within 30d)
- Add: `⚠EARLY_EXIT_DRAG` nudge token from `_compute_thesis_drift(conn)` (lowest priority, >3pp drag, n≥5)
- Update `_HL_MAP` entries: actual regime names (panic=20, riskOff=30, highVol=35, trend=45,
  riskOn=50, sideways=60; default=45). Remove phantom names.
- Note: `_REGIME_GROUPS` uses actual regime names too

**Learning Loop internals — key functions table:**
- Add `_compute_thesis_drift(conn)` row: compares avg pnl of manual exits vs target hits; emits nudge

**Gotcha #14:**
- Change from "two scripts redefine `_detectExitReason`" to: function is in `utils.js`; neither
  `recommendations.js` nor `performance.js` redefine it. Keep the warning about not accidentally
  re-introducing duplicates.

**Gotcha #34 (if it exists):** Add new gotcha about DRP parcels using `state.cgtParcels` (same key as regular parcels — just `action:'DRP'`).

**Backend endpoint reference:**

Under Learning loop:
- Add `GET /api/learning/thesis-drift` — returns `{n_manual, n_target, avg_manual_pct, avg_target_pct, nudge}`;
  requires n≥5 in each bucket to compute

Under Market data:
- Note `GET /api/learning/lessons` now accepts `adl=<float>` and `asx_vol=<float>` params for
  breadth-scope filtering

Under Scanner (or a new Universe section):
- Add `POST /api/market/universe-exclude {tickers:[...]}` — adds to blob_store.universe_excluded
- Add `DELETE /api/market/universe-exclude {tickers:[...]}` — removes from exclusion list
- Note scanner and intraday routes filter excluded tickers on each scan

Under Portfolio + persistence:
- Update `POST /api/import/csv`: now returns `sells:[...]` array for SELL rows (previously skipped
  into `skipped[]`); frontend shows FIFO-match confirmation table

**Common tasks section:**
- Add "Record a DRP event": Portfolio page → DRP button per holding row → fill shares/price/date → Apply
- Add "Rebalance holdings to target allocations": Risk page → target alloc drift card → 📋 Suggest Rebalance
  → deterministic BUY/TRIM suggestions modal; no Claude call

**Deferred work table:**
- Remove "Hoist `_detectExitReason` into `utils.js`" — shipped Sprint 43
- Remove "Stooq rate-limiting" — shipped Sprint 43
- Remove "DRP parcel tracking" — shipped Sprint 44
- Keep remaining items: ES-modules migration, FastAPI migration (both still deferred)

---

### 2. learning_loop.md

Read the full file first. Then update:

- Phase 8 gate: now uses `_mann_whitney_z() > 1.28` in BOTH `_compute_phase8_meta()` (stats endpoint)
  AND `_calib_compute()` (calibration block). Previously only the stats endpoint used MW; the
  calibration block used raw mean comparison. Bug fixed in hotfix commit 16bba99.

- Virtual outcomes: add `virtual_speed_weight = min(1.0, 7.0/hold_days)` stored at resolution time;
  applied as additional multiplier in `_calib_compute()` alongside 0.75× virtual discount.
  Fast-resolving virtual wins (7d) get full weight; slow ones (29d) get ~0.24×.

- Regime-flip calibration penalty: new mechanism. When `fetchAndClassifyRegime()` detects a flip,
  writes `regime_flipped_at` + `regime_flipped_to` to localStorage. `fetchCalibrationBlock()`
  passes these as query params. `_calib_compute()` halves the effective HL for the first <10 trades
  in the new regime, then restores normal HL. Emits `⚠REGIME_FLIP(Nd ago, N trades, hl=Nd)` token.

- `_HL_MAP` update: document the corrected regime names (panic=20, riskOff=30, highVol=35,
  trend=45, riskOn=50, sideways=60). Remove phantom names (bearVolatile, bearTrending, etc.).

- Breadth-scope lessons: `trading_lessons` table has `breadth_scope TEXT` column (values:
  `adl_below_0.3`, `adl_above_0.7`, `high_vol`, `low_vol`, null=always). Lessons injection in
  `analysis.js` passes current `adl` + `asx_vol` from `state.macroData` to filter context-relevant
  lessons only.

- Thesis drift detection: `_compute_thesis_drift(conn)` — new function. Compares avg
  `realized_pnl_pct` for `exit_reason='manual'` vs `exit_reason='target_hit'` (both was_executed=1).
  n≥5 required in each bucket. Emits `⚠EARLY_EXIT_DRAG` nudge to calibration block when drag >3pp.
  Also exposes `GET /api/learning/thesis-drift` for the Learning page card.

- Auto-triggers removed: `triggerPostmortem()` and `fetchSkillScore()` no longer fire automatically
  when a trade is closed. Must be triggered manually from the Debate Engine on the Learning page.
  `triggerCalibQualityIfStale()` no longer called from `analysis.js`. Calib-quality card on
  Learning page is cache-only on load (shows "▶ Run debate" when no cached result).

---

### 3. prompts.md

Read the full file first. Then update:

**Section 1 (Portfolio Analysis) — Post-processing pipeline:**
- Step 2 (Quant engine): after the step list, add a note that `portfolioJson` in the user message
  now uses `livePrice = state.liveSignals[ticker]?.current_price ?? h.currentPrice` for all
  price-derived fields. This ensures SELL/TRIM `priceRange` is anchored to the fresh signal price
  rather than potentially stale `state.portfolio[].currentPrice`. Fix shipped in hotfix a888eec.

**Section 1 — User message format:**
- `Date` line: confirm `Account: {PERSONAL|SUPER|TRADING}` is documented (Sprint 42, already there)
- `Holdings`: note `currentPrice` is the live signal price (from `GET /api/analyse`, force-refreshed
  at Step 2 of runAnalysis), not the portfolio cache price

**Calibration / debate auto-triggers:**
- Add a note in Section 6 or in the architecture overview: calib-quality debates are manual-only.
  `triggerCalibQualityIfStale()` is no longer called from `runAnalysis()`. Postmortem and skill
  scoring are also manual-only from the Learning page Debate Engine.

**Known Issues section (end of Section 1):**
- All three issues (#1 max_tokens, #2 unrealised_loss_large, #3 SELL semantics) are already marked ✅
- Add new entry: ✅ 4. Stale currentPrice in portfolioJson (FIXED hotfix a888eec) — portfolioJson
  now uses livePrice from state.liveSignals for all price fields; fixes SELL/TRIM priceRange lag

**Prompt versioning:**
- Confirm PROMPT_VERSION = '2026-06-v7' is documented with correct change description

---

### 4. IMPROVEMENTS.md

Read the FULL file first (it's long). Then:

**Sprint 46 section (check if worker already added it — if so, verify accuracy):**
If not present, add at the top after Sprint 45:
```
## 0. Shipped — Sprint 46 (2026-06-04)
| Broker CSV SELL import | Workflow (M) | ... |
| Rebalancing suggestions panel | Risk (M) | ... |
| ASX universe exclusion list | Reliability (S) | ... |
```

**Hotfixes section (add after Sprint 46 if not present):**
Add a new section:
```
## 0. Hotfixes (2026-06-04)
| fetch_with_retry 400 fix | ... |
| Auto-debate triggers removed | ... |
| currentPrice fix in analysis prompt | ... |
| Phase 8 gate fix in _calib_compute | ... |
| _HL_MAP + _REGIME_GROUPS regime name alignment | ... |
| DB pragma parity in announcement/news engines | ... |
| 6 audit bugs (scheduler name, settings path, DRP multi-account, etc.) | ... |
```

**Section 5 — Suggested sequencing:**
Add new entry:
`✓ **Sprint 46 shipped:** Broker CSV SELL import; rebalancing suggestions modal; ASX universe exclusion list.`
`✓ **Hotfixes:** fetch_with_retry 400 fix; auto-debate triggers removed; currentPrice in analysis prompt; Phase 8 gate in _calib_compute; _HL_MAP alignment; DB pragma parity; 6 audit bugs.`

**Open items (last numbered item in §5):**
Update to reflect what's still open after all hotfixes:
- §2.7 Local LLM SELL/TRIM (L, ★★★) — still open
- §1.9 Mergers/takeover CGT — still open (no yfinance tag)
- §3.7 ES-modules — still deferred

---

## Completion checklist

1. All four files saved with correct content
2. No code files modified
3. git add the four .md files
4. git commit with message: "docs: sync CLAUDE.md, learning_loop.md, prompts.md, IMPROVEMENTS.md post Sprint 43-46"
5. git push
