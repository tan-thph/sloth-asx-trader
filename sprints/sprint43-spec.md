# Sprint 43 Spec

Work in /home/tanth/projects/sloth-asx-trader. Run tests after each change.

## Item 1 — Stooq rate-limiting (S, backend)

Files: `core.py` (`stooq_quote`) and `indicators.py` (`_fetch_stooq_history`)

Problem: Stooq.com rate-limits ~1 req/sec. Parallel batch requests may 429 silently (returns empty CSV).

Fix: Add shared `_STOOQ_SEM = threading.Semaphore(1)` in `core.py`. In `stooq_quote()`, wrap the HTTP GET with `with _STOOQ_SEM:` and add `time.sleep(0.5)` inside after the request. In `indicators.py`, import `_STOOQ_SEM` from `core` and apply the same pattern to `_fetch_stooq_history()`.

The 0.5s sleep goes INSIDE the semaphore block so the gap is enforced between releases (~2 req/sec max).

## Item 2 — Hoist `_detectExitReason` into `utils.js` (S, frontend)

Problem: `_detectExitReason(exitPrice, stopLoss, target, action)` is duplicated in `js/pages/recommendations.js` AND `js/pages/performance.js`. The performance.js copy wins at runtime (loaded second). Divergence = silent bugs.

Fix:
1. Copy the full function to `js/utils.js` (near bottom, after existing helpers).
2. Delete the local definition from BOTH `recommendations.js` AND `performance.js`.
3. No import/export needed — plain script tags share one global scope; utils.js loads first per CLAUDE.md load order.
4. Run `npm run test:js` — `test_detect_exit_reason_direction_aware` will still pass (now both files resolve to the same global).
5. Update CLAUDE.md gotcha #14: say function is in utils.js now (not duplicated). Remove 'Hoist _detectExitReason' from the Deferred work table.

## Item 3 — DRP parcel tracking (M, frontend + minimal backend)

Problem: No way to record Dividend Reinvestment Plan parcels with their own CGT cost base.

Before implementing, READ these files carefully:
- `js/pages/portfolio.js` — holding display and action buttons
- `js/pages/cgt.js` — how open parcels are stored/rendered (find the actual state key name)
- `js/pages/journal.js` — how action badges are rendered
- `js/api.js` — what keys are in the save payload
- `js/config.js` — state defaults
- `routes/portfolio.py` — BLOB_KEYS list

Implementation (frontend-only, no new backend route needed):

1. **`js/pages/portfolio.js`**: Add "DRP" button per holding row. Clicking opens a modal with:
   - DRP Shares (number, required)
   - DRP Price per Share (number, pre-fill with holding.currentPrice)
   - Settlement Date (date, pre-fill today YYYY-MM-DD)
   - Dividend Amount (number, optional, for reference)

   On submit, `applyDrpEvent(ticker, drpShares, drpPrice, date)`:
   - Recalculate weighted avgPrice: `(oldShares*oldAvg + drpShares*drpPrice)/(oldShares+drpShares)`
   - Update holding.shares and holding.avgPrice
   - Add CGT parcel to the correct open-parcels state key:
     `{id:Date.now(), ticker, action:'DRP', qty:drpShares, costPerShare:drpPrice, date, remainingQty:drpShares, notes:'DRP — dividend reinvestment'}`
   - Add to `state.tradeJournal`:
     `{id:Date.now(), date, ticker, action:'DRP', qty:drpShares, entryPrice:drpPrice, exitPrice:null, fees:0, pnl:0, status:'open', recId:null, recExecuted:false, closeDate:null}`
   - Call `scheduleSave()` and re-render

2. **`js/pages/cgt.js`**: Add 'DRP' badge (purple/indigo) in the action badge color logic.

3. **`js/pages/journal.js`**: Add 'DRP' case to the action badge switch (indigo/purple).

4. **`js/config.js`**: Ensure the open-parcels state key is initialised to `[]` in defaults if not already.

5. **`js/api.js` + `routes/portfolio.py`**: Ensure the open-parcels key is in the save payload and BLOB_KEYS.

6. **CLAUDE.md**: Add DRP to Key data shapes and a 'Record a DRP event' entry under Common tasks.

## Completion checklist
1. `python test_app.py` — all tests pass
2. `npm run test:js` — all 127 tests pass
3. `for f in js/*.js js/pages/*.js; do node --check "$f" || echo "FAIL: $f"; done`
4. Add a Python test checking `_STOOQ_SEM` exists and is `threading.Semaphore` in core module
5. Update IMPROVEMENTS.md: add Sprint 43 shipped section at top
6. Update FIXES.md: add Sprint 43 section with summary table
7. Update CLAUDE.md as described per item
8. Create a PR against main
