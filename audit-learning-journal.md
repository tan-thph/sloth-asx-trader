# Audit — Learning Loop & Trade Journal / CGT Parcels (2026-06-30)

Read-only bug audit of two subsystems, run by three parallel auditors and consolidated here.
Findings cross-checked against CLAUDE.md gotchas and `fixes.md` so already-fixed/intentional
behavior is **not** re-reported. The headline items (FE-1, FE-2, JR-1) were spot-verified by
reading the live code — line refs below are confirmed, not speculative.

**No code was changed.** This document only describes the bugs and how to fix them.

Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Low

---

## Headline (act on these first)

| ID | Sev | One-liner | Root cause shared with |
|----|-----|-----------|------------------------|
| FE-1 | 🟠 High | "Sync Closed Trades" button overwrites parent-BUY learning events with NULLs | FE-4 |
| JR-1 | 🟠 High | `parcelOpenDate` never persisted → CGT-discount column blanks + hold-days zero after any reload | — |
| FE-2 | 🟡 Med | Parent-BUY reconciliation in `markExecuted()` is not account-scoped | — |
| BE-1 | 🟡 Med | Resolver ordering makes the empirical `stop_too_tight`/`early_exit` tagging dead code | BE-2 |
| BE-2 | 🟡 Med | `_resolve_deterministic_tags` starves its capped batch on untaggable wins | BE-1 |
| JR-2 | 🟡 Med | `rollbackTradeJournalEntry()` reverses against the wrong account | — |
| JR-3 | 🟡 Med | Rolling back a disposal slice never re-opens the parent BUY row's status | — |

---

## Learning Loop — backend (`routes/learning.py`)

### BE-1 🟡 Resolver ordering defeats Phase 2B empirical tagging
`_calib_compute()` runs `_resolve_deterministic_tags()` **before** `_resolve_mae_mfe()`
(deterministic tagging ~line 3226, MAE/MFE ~line 3233; `_resolve_execution_alpha()` is never
called in this path at all). A BUY/TOP_UP row becomes eligible for both the moment
`outcome_status` flips, so the tagger fires first and reads `mae_pct`/`mfe_pct`/`exec_mech_pnl_pct`
as still-NULL:
- `stop_too_tight` always falls back to the crude 1.5×ATR heuristic (the empirical MAE/MFE path
  the feature was built for never runs).
- `early_exit` needs `mfe_pct` (NULL) or `exec_mech_pnl_pct` (never resolved here) → **never fires.**

The tagger is one-shot (WHERE re-excludes rows with non-empty `error_type`), so the row is never
revisited once MAE/MFE land. A shipped feature (Sprint 71 Phase 2B, gotchas #44/#46) silently
degrades to its fallback permanently.

**Fix:** In `_calib_compute()`, call `_resolve_mae_mfe(conn)` (and `_resolve_execution_alpha(conn)`)
**before** `_resolve_deterministic_tags(conn)`. Both are capped/idempotent, so reordering is free.

### BE-2 🟡 `_resolve_deterministic_tags` starves its 50-row batch on untaggable wins
Losses with no error get the sentinel `error_type='none'` and drop out of the WHERE. Wins have no
equivalent: a win where `compute_skill_score_deterministic()` returns `None` (no `thesis_verdict` —
common for manual/legacy trades) **and** `_classify_success_tags_deterministic()` returns `''`
(common — a neutral-regime manual-exit win with skill<7 fires none of the 5 tags) produces zero
UPDATEs. It keeps matching `skill_score IS NULL OR (win AND success_tags empty)` on every call.
With `ORDER BY timestamp DESC LIMIT 50`, once ≥50 such rows accumulate they occupy the batch
forever and newer taggable rows below them never resolve. (Worsened by BE-1, since `clean_path`
can't fire either while MAE/MFE are NULL.)

**Fix:** When a win yields no success tags, write `success_tags='none'` (mirroring the
`error_type='none'` convention). Also write a resolution marker for verdict-less wins so
`skill_score IS NULL` doesn't re-select them indefinitely.

### BE-3 ⚪ Postmortem-digest `error_dist` doesn't split multi-tag `error_type` (gotcha #45)
~line 2104: `SELECT error_type, COUNT(*) ... GROUP BY error_type` groups the raw comma-joined
string, so `"thesis_broken,overconfident"` is a separate bucket from `"thesis_broken"`. Sibling
consumers (`failure_patterns.by_error_type`, `by_sector`) split on `,` correctly; this one doesn't,
so the digest under-counts tags and fragments the distribution.
**Fix:** aggregate in Python by splitting on `,` (and drop `none`/`external_shock`).

### BE-4 ⚪ `_resolve_hold_outcomes` re-fetches forever on `entry_close <= 0`
~line 2466: `if entry_close <= 0: continue` happens *after* the yfinance fetch and writes neither
`virtual_outcome` nor `fetch_failed_at`, so the row is re-fetched (real network call) on every
calibration pass. Rare but an uncapped repeating fetch.
**Fix:** mark `virtual_outcome='virtual_open'` (or `_mark_fetch_failed`) in that branch.

### BE-5 ⚪ Regime-flip penalty silently no-ops on offset-bearing timestamps
~line 3130: `.replace("Z","+00:00").replace("+00:00","")` only strips a UTC suffix. A `flipped_at`
with a real offset (e.g. `+10:00`) stays timezone-aware, `datetime.now() - aware` raises, and the
bare `except: pass` swallows it → the flip half-life penalty / `⚠REGIME_FLIP` token never applies.
Works today only because the frontend sends `Z`/naive ISO.
**Fix:** parse robustly to naive-UTC instead of string-stripping only the UTC suffix.

### BE-6 ⚪ (observation) `_resolve_sell_outcomes` ignores `actual_exit_price`
~line 2304: `exit_px` is read but used only as a null-guard; `sold_chg` is measured from the
sell-day *close*, not the real fill. Likely intentional ("price evolution since the sell date"),
but a fill far from that day's close is judged against the wrong reference. Flagged for a
yes/no, no fix proposed.

---

## Learning Loop — frontend matching

### FE-1 🟠 "Sync Closed Trades to Learning Loop" clobbers parent-BUY events with NULLs
`js/pages/performance.js:796-835` × `js/pages/recommendations.js:1958` × `routes/learning.py:1330-1331`.

`markExecuted()`'s parent reconciliation sets `rh.outcome = 'win'/'loss'` (recommendations.js:1958)
but **never sets `rh.actualProfit`** — it stays null. Later, the Performance-page **Sync** button:
- builds `jMatches` requiring `t.status==='closed' && t.pnl != null` (performance.js:764) — a parent
  BUY's own journal row has `pnl: null`, so it never matches and the reconciled copy gets no
  `_pnlPct/_entryPrice/_holdDays/_exitPrice/_sector`;
- still passes `toUpdate` (line 796: `_learningId && outcome && outcome not open/skipped`) because
  outcome is win/loss;
- POSTs **every** column unconditionally (lines 824-830) with `realized_pnl_aud:null`,
  `realized_pnl_pct:null`, `holding_period_days:null`, `actual_entry_price:null`,
  `actual_exit_price:null`, `sector:null`, `exit_reason:'manual'`.

The backend patches `if col in data` (key-present = overwrite, learning.py:1331), so the sync
**silently wipes** the per-entry realized P&L, prices, hold days, and real exit_reason that
`markExecuted` had correctly recorded — for exactly the position-building (BUY + top-up + later
SELL) trades the learning loop most wants. **Verified live.**

**Fix (either, prefer both):**
1. Set `rh.actualProfit = prPnlAud` at recommendations.js:1958 (also resolves FE-4); and
2. In the sync `toUpdate` POST, **omit any key whose value is null/undefined** so the partial-patch
   endpoint leaves the existing column intact — or restrict `toUpdate` to recs that actually came
   from a `jMatches` hit (`r._pnlPct !== undefined`).

### FE-2 🟡 Parent-BUY reconciliation is not account-scoped
`js/pages/recommendations.js:1915-1921`. `positionClosed` was correctly scoped via
`getPortfolioHolding(rec.ticker, sellAccount)` (gotcha #81), but the `parentRecs` filter right after
matches on ticker alone (recHistory entries carry no account). If the same ticker is held in two
accounts, a SELL that fully closes the `trading` position grades the `personal`-account BUY learning
events as closed too → false-positive grading of still-open positions, polluting calibration.
**Verified live.**

**Fix:** gate the parent block to run only when `_distinctAccts.length <= 1`, or link parents to the
parcels actually disposed by this sale (disposals + BUY journal rows + recHistory BUYs all carry
`parcelId`/`journalId`) and grade only those.

### FE-3 ⚪–🟡 ticker+date fallback can cross-contaminate same-ticker/same-day recs
`js/pages/performance.js:761-765` and `:921-924`. The `(t.ticker===r.ticker && t.date===r.date)`
fallback is correctly `recId != null`-guarded (gotcha #51 honored), but that guard makes it **dead
for its stated legacy-backfill purpose** (legacy rows have `recId == null`). What it *can* still
match is a journal row from a **different** AI rec sharing the ticker+date, so two same-ticker recs
closing the same day cross-aggregate each other's P&L. Rare.
**Fix:** drop the ticker+date OR-clause (leave `t.recId === r.id`); if legacy backfill is truly
needed, key it on `recId == null && journalId === r.journalId`.

### FE-4 ⚪ Graded parent BUYs missing from the local calibration fallback
Because the parent BUY's `actualProfit` is never written (only `outcome`), the offline path
`computeCalibrationStats` Path B (`js/learning-loop.js:83,95`, filters `actualProfit != null`)
silently drops these. Backend is primary so impact is limited; fixing FE-1's part (1) resolves this.

---

## Trade Journal / CGT Parcels

### JR-1 🟠 `parcelOpenDate` is never persisted → lost on every reload
Producer `js/portfolio-helpers.js:734`; no `parcel_open_date` column in `db.py` `trade_journal`
schema; `routes/portfolio.py` `db_save`/`db_load` don't read/write it. `grep` confirms the column
does not exist anywhere. Gotcha #66 calls it "a JS-state field; NOT a DB column" and assumes the
`parcelOpenDate || date` fallback preserves correctness — but after a reload that fallback resolves
to the **sale date** for *every* disposal row, not just legacy rows. **Verified live.** Consequences:
- **CGT CSV export** (`exportTradeJournalCSV`, performance.js:679): `openDate = t.date = closeDate`,
  so the `openDate !== closeDate` guard fails and the **12-month CGT-discount-eligible column blanks**
  for every disposal once the app is reloaded (the normal cross-session case).
- **Learning loop** (`syncClosedTradesToLearningLoop`, performance.js:779-785): `earliestOpen` falls
  back to the sale date → `holdDays = 0` for every closed AI rec synced after reload. This zeroes
  `capital_efficiency` (`avg_pnl_per_day` divides by ~0), suppresses the `disciplined_hold` tag
  (needs hold_d≥5), and corrupts hold-duration stats.

Mitigant: the authoritative EOFY pack (`/api/tax/eofy-pack`) reads the `cgtDisposals` blob, which
*does* persist `heldDays`/`eligible50` — so the primary tax document is safe; the journal CSV and
learning stats are not.

**Fix:** add a `parcel_open_date` column (migration), write `t.get("parcelOpenDate")` in db_save,
return it in db_load. (Or compute & store hold-days on the disposal row at write time.)

### JR-2 🟡 `rollbackTradeJournalEntry()` reverses against the wrong account
`js/portfolio-helpers.js:767` (BUY branch) and `:797` (closed-SELL branch) call
`getPortfolioHolding(t.ticker)` with no account arg, despite `t.account` being on the row — the same
class of bug the round-1 sweep (gotcha #81) fixed elsewhere but never threaded here. Deleting a
`trading`/`super` journal row credits/debits shares, avgPrice and cash against the *first/personal*
holding; the BUY branch then removes the correct parcel by id, leaving portfolio and parcels
disagreeing. (The SELL branch's `else`-push at :804 already uses `t.account`, so the two paths are
internally inconsistent.)
**Fix:** `getPortfolioHolding(t.ticker, t.account || 'personal')` at both sites; scope the
line-779 cleanup filter the same way.

### JR-3 🟡 Rolling back a disposal slice never re-opens the parent BUY row's status
`js/portfolio-helpers.js` SELL rollback branch (795-822) vs status patch in
`buildDisposalJournalEntries` (720). The rollback restores `parcel.remainingQty`, removes the
disposal, and credits shares back, but does **not** revert the parent BUY/TOP_UP/RECLASSIFY row's
`status` (`'closed'`/`'trimmed'`) or clear its `closeDate`. After removing a closed SELL slice the
parcel is open again while its BUY row still reads `status:'closed'` — the Journal "open positions"
filter hides a genuinely-open lot, and anything trusting `status` (gotcha #66) disagrees with
`remainingQty`.
**Fix:** after restoring `remainingQty`, reset the matching BUY row's status
(`remainingQty < qty ? 'trimmed' : 'open'`) and clear `closeDate` when fully reopened.

### JR-4 ⚪ Split-off BUY rows miscounted as prior disposal slices (cosmetic)
`js/portfolio-helpers.js:711-717` counts prior disposals via `e.parcelId === d.parcelId && e.parcel`
(truthy `parcel` as the "is a disposal" heuristic), but gotcha #79's split-off BUY row also carries
a truthy `parcel:'P#<id>'`. So selling a previously-split parcel cleanly labels the disposal
`P#<id>-2` instead of `P#<id>`. Label-only; CGT records and status patch unaffected.
**Fix:** count prior disposals by `e.action === 'SELL' || e.action === 'TRIM'` (or a dedicated
`isDisposal` flag), not `parcel` truthiness.

### JR-5 ⚪ `matchSaleAgainstParcels()` has two incompatible return shapes (edge crash)
`js/portfolio-helpers.js:520-523` returns an object `{disposals, remainder, ...}` on invalid qty but
a bare array on the normal path (:599). Both callers do `state.cgtDisposals.push(...result)`;
spreading the object throws `TypeError: not iterable`. `applySellToPortfolio` guards qty first, but
`_applyImportedSells` (portfolio.js:869) has no qty>0 guard, so a malformed CSV SELL row (0/blank
shares) crashes the import instead of skipping the row.
**Fix:** return a bare `[]` from the guard (consistent with the normal path), and add a `shares > 0`
guard in `_applyImportedSells`.

### JR-6 ⚪ DRP / reclassify / split inserts still use `Date.now()` instead of the monotonic helpers
`js/pages/portfolio.js:1211` (DRP parcel) & `:1219` (DRP journal); `js/portfolio-helpers.js:293`
(`_splitParcelJournalRow`) & `:428` (`_syncParcelJournalRow`). Round-2 R2-5 introduced
`nextJournalId()`/`nextParcelId()` but missed these four. Two DRPs (or a split+sync) in the same ms
collide; once a `Date.now()` (~1.7e12) id lands, `max+1` inflates all later ids to epoch scale.
**Fix:** use `nextParcelId()` / `nextJournalId()` at all four sites.

---

## Verified correct (not bugs)

- Calibration cache key includes `deep` (gotcha #47); `_calib_lock` guards only dict access.
- Multi-tag `error_type` split-on-`,` is honored in `_resolve_stop_tag_counterfactual`,
  `failure_patterns`, `by_sector`, `_is_shock`, `_is_good_loss` (BE-3 is the lone exception).
- Stop-first intrabar convention consistent across all OHLC walkers (gotcha #42).
- `_REGIME_STOP_ATR_MULT` matches the JS `stopAtrMult` values 2.5/3.0/3.5/4.0.
- numpy scalars cast to Python floats before DB/JSON writes (gotcha #21).
- Per-entry parent grading uses each parcel's own entry price; `recId != null` guards present;
  `_learningId` written back to originals; `.filter()`+sum aggregation; single canonical
  direction-aware `_detectExitReason` in `utils.js` (gotchas #13/#14/#22/#51/#66).
- Round-1 `fixes.md` (#1-#10) and round-2 (R2-1 CGT >365, R2-2 manual non-personal) confirmed fixed.

---

## Suggested order of work
1. **FE-1 + FE-4** (one root cause: set `rh.actualProfit` + make sync payload conditional) — stops
   active data destruction on a user-clicked button.
2. **JR-1** (persist `parcelOpenDate`) — restores CGT-discount export + hold-day stats after reload.
3. **FE-2, JR-2, JR-3** — multi-account / state-consistency correctness.
4. **BE-1 + BE-2** (one pass: reorder resolvers + add win sentinel) — revives Phase 2B tagging.
5. **BE-3..BE-5, JR-4..JR-6** — low-severity cleanups.
