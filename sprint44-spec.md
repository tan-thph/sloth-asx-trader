# Sprint 44 Spec

Work in /home/tanth/projects/sloth-asx-trader. Run tests after each item.

## Item 1 — DRP parcel tracking (M, frontend)

DRP = Dividend Reinvestment Plan. Shares issued via DRP have their own CGT cost base.
No new backend route needed — purely frontend state + UI.

Before implementing, READ these files:
- `js/pages/portfolio.js` — find the holding row action buttons (look for "Apply split" button as a pattern to follow)
- `js/pages/cgt.js` — find the open-parcels state key name (search for `openParcels` or similar)
- `js/pages/journal.js` — find the action badge switch/if-else for BUY/SELL/etc.
- `js/api.js` — find the save payload blob keys
- `js/config.js` — find state defaults
- `routes/portfolio.py` — find BLOB_KEYS list

### Implementation

1. **`js/pages/portfolio.js`** — Add "DRP" button per holding row (next to existing action buttons).
   Clicking opens a modal with:
   - DRP Shares (number input, required)
   - DRP Price per Share (number input, pre-fill with holding.currentPrice)
   - Settlement Date (date input, pre-fill today YYYY-MM-DD)
   - Dividend Amount (number input, optional, for reference only)

   On submit, `applyDrpEvent(ticker, drpShares, drpPrice, date)`:
   - Recalculate weighted avgPrice: `(oldShares*oldAvg + drpShares*drpPrice)/(oldShares+drpShares)`
   - Update holding.shares and holding.avgPrice in `state.portfolio`
   - Add CGT parcel to the open-parcels state key (discover exact key name by reading cgt.js):
     `{id:Date.now(), ticker, action:'DRP', qty:drpShares, costPerShare:drpPrice, date, remainingQty:drpShares, notes:'DRP — dividend reinvestment'}`
   - Add to `state.tradeJournal`:
     `{id:Date.now(), date, ticker, action:'DRP', qty:drpShares, entryPrice:drpPrice, exitPrice:null, fees:0, pnl:0, status:'open', recId:null, recExecuted:false, closeDate:null}`
   - Call `scheduleSave()` then re-render the portfolio page

2. **`js/pages/cgt.js`** — Add 'DRP' badge (indigo/purple colour) in the action badge colour logic.

3. **`js/pages/journal.js`** — Add 'DRP' case to the action badge switch (indigo/purple).

4. **`js/config.js`** — Ensure the open-parcels state key is initialised to `[]` in defaults if not already.

5. **`js/api.js` + `routes/portfolio.py`** — Ensure the open-parcels key is in the save payload and BLOB_KEYS if not already.

6. **CLAUDE.md** — Add 'Record a DRP event' to Common tasks section. Add DRP to Key data shapes (tradeJournal action types).

Run: `python test_app.py` and `npm run test:js` and frontend syntax check.

---

## Item 2 — Virtual-outcome speed weighting (S, backend)

**File:** `routes/learning.py` → `_resolve_virtual_outcomes(conn)`

When a rec hits its target in 2 days, that's a stronger signal than one that drifted there over 29 days.
Add a speed weight stored on the DB row and applied in `_calib_compute()`.

### Implementation

1. **`db.py`** — Add `virtual_speed_weight REAL` column to `ai_learning_events` via `_LE_MIGRATIONS`:
   ```python
   ("virtual_speed_weight", "ALTER TABLE ai_learning_events ADD COLUMN virtual_speed_weight REAL")
   ```

2. **`routes/learning.py` → `_resolve_virtual_outcomes()`** — After computing outcome, add:
   ```python
   hold_days = max(1, (pd.Timestamp.now() - pd.Timestamp(row["timestamp"])).days)
   speed_weight = min(1.0, 7.0 / hold_days)
   conn.execute("UPDATE ai_learning_events SET virtual_speed_weight=? WHERE id=?",
                (round(speed_weight, 3), row["id"]))
   ```

3. **`routes/learning.py` → `_calib_compute()`** — In the decay-weighted calibration query,
   multiply the existing time-decay weight by `COALESCE(virtual_speed_weight, 1.0)` for rows
   where `outcome_status IN ('virtual_win','virtual_loss')`. Real executed outcomes keep weight=1.0.
   Keep the change minimal — only virtual rows get the multiplier.

4. **IMPROVEMENTS.md** — Mark §1.12 as shipped in the Sprint 44 section.

Run: `python test_app.py`.

---

## Item 3 — Regime-change calibration penalty (S, backend)

**Files:** `js/regime-engine.js`, `routes/learning.py`

When the regime flips (e.g. riskOn → riskOff), the calibration still heavily weights
old-regime trades (60d half-life in sideways means stale data dominates for weeks).
On flip, temporarily halve the half-life for the first 5–10 trades in the new regime.

### Implementation

1. **`js/regime-engine.js` → `fetchAndClassifyRegime()`** — When a regime flip is detected
   (new regime ≠ `_regimeCache.regime`), POST to `POST /api/db/save` with a new blob key
   `regime_flipped_at` = ISO timestamp and `regime_flipped_to` = new regime string.
   Do this AFTER updating `_regimeCache`. Use the existing `saveStateToDb()` pattern or
   a direct `fetch('/api/db/save')` call — check how `blob_store` writes work in the codebase.

   Actually: use a simpler approach — add a `regime_flipped_at` field to `state.currentRegime`
   and include it in the existing `saveStateToDb()` payload. Read it back in `loadStateFromDb()`.

   Simpler still: store `regime_flipped_at` directly in `localStorage` (key: `regime_flipped_at`)
   alongside `regime_flipped_to` (key: `regime_flipped_to`). The backend reads these from the
   `GET /api/learning/calibration` query params. Update `fetchCalibrationBlock()` in
   `learning-loop.js` to pass `&flipped_at=...&flipped_to=...` from localStorage.

2. **`routes/learning.py` → `_calib_compute()`** — Accept optional `flipped_at` and `flipped_to`
   params. If `flipped_at` is within the last 30 days AND the current regime matches `flipped_to`:
   - Count trades in the new regime since `flipped_at`
   - If that count < 10: use `hl = max(10, current_hl / 2)` for the decay calculation
   - If count ≥ 10: normal half-life applies (ESS has recovered)
   - Add a token to the calibration block: `⚠REGIME_FLIP(Nd ago, N trades in new regime, hl=Nd)`

3. **`GET /api/learning/calibration`** — Accept `flipped_at` and `flipped_to` query params and
   pass them to `_calib_compute()`.

4. **`js/learning-loop.js` → `fetchCalibrationBlock()`** — Read `regime_flipped_at` and
   `regime_flipped_to` from `localStorage` and append as query params.

5. **`js/regime-engine.js`** — In `fetchAndClassifyRegime()`, when regime changes, write:
   ```js
   localStorage.setItem('regime_flipped_at', new Date().toISOString());
   localStorage.setItem('regime_flipped_to', result.regime);
   ```

6. **IMPROVEMENTS.md** — Mark §1.11 as shipped in the Sprint 44 section.

Run: `python test_app.py` and `npm run test:js`.

---

## Item 4 — Lessons: market-breadth scope (M, backend + frontend)

**Files:** `db.py`, `routes/learning.py`, `js/pages/learning.js`, `js/learning-loop.js`, `js/analysis.js`

Allow lessons to be tagged with market-breadth conditions so they only inject when ADL/VIX matches.

### Implementation

1. **`db.py`** — Add `breadth_scope TEXT` column to `ai_learning_lessons` via `_LESSON_MIGRATIONS`
   (or equivalent migration list — check how lessons migrations work):
   ```python
   ("breadth_scope", "ALTER TABLE ai_learning_lessons ADD COLUMN breadth_scope TEXT")
   ```
   Valid values: `'adl_below_0.3'` | `'adl_above_0.7'` | `'high_vol'` (asx_vol_20d > 25%) |
   `'low_vol'` (asx_vol_20d < 12%) | `null` (always inject, current behaviour).

2. **`routes/learning.py` → `GET /api/learning/lessons`** — Accept additional query params:
   `adl=<float>` and `asx_vol=<float>`. Filter `breadth_scope IS NULL OR`:
   - `adl_below_0.3` → include when `adl < 0.3`
   - `adl_above_0.7` → include when `adl > 0.7`
   - `high_vol` → include when `asx_vol > 25`
   - `low_vol` → include when `asx_vol < 12`

3. **`routes/learning.py` → `POST /api/learning/lessons`** — Accept optional `breadth_scope` in body.

4. **`js/learning-loop.js` → `fetchCalibrationBlock()`** — This calls lessons. Actually lessons are
   fetched in `analysis.js`. Find where `GET /api/learning/lessons` is called and append
   `&adl=<state.macroData.advance_decline_ratio>&asx_vol=<state.macroData.asx_vol_20d>` to the URL.

5. **`js/pages/learning.js`** — In the "Create Lesson" modal/form, add a `breadth_scope` dropdown:
   - (none — always show)
   - ADL below 0.3 (broad market weak)
   - ADL above 0.7 (broad market strong)
   - High volatility (A-VIX > 25%)
   - Low volatility (A-VIX < 12%)

6. **IMPROVEMENTS.md** — Mark §2.6 lessons breadth scope as shipped.

Run: `python test_app.py`.

---

## Completion checklist

1. `python test_app.py` — all tests pass
2. `npm run test:js` — all tests pass
3. `for f in js/*.js js/pages/*.js; do node --check "$f" || echo "FAIL: $f"; done`
4. Add Python tests for: (a) `virtual_speed_weight` written by `_resolve_virtual_outcomes`, (b) `GET /api/learning/lessons` filters by ADL/asx_vol when params provided
5. Update IMPROVEMENTS.md: add Sprint 44 shipped section at top (above Sprint 43)
6. Update FIXES.md: add Sprint 44 section if any bugs fixed
7. Update CLAUDE.md: add DRP to Common tasks + Key data shapes; update §1.11 + §1.12 + §2.6 from "open" to shipped
8. Create a PR against main
