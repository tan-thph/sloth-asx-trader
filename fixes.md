# fixes.md — Trade Journal / Account-Type / Parcel Matching Audit

Audit date: 2026-06-25. Scope: Trade Journal matching, account type changes (personal/trading/super), and BUY/SELL/TRIM record matching. Findings are ordered by severity. File:line references are accurate as of this commit (`b0bf985`).

**Status: all 9 findings fixed and verified (isolated test per fix + full suite green) — see CLAUDE.md gotcha #81 for the consolidated summary.** Finding #10 confirmed as intentional dead code, no fix needed.

---

## 1. [CRITICAL] ✅ FIXED — `_findParcelJournalRow()` can match a disposal-slice row instead of the parcel's BUY row

**Files:** `js/portfolio-helpers.js` (`_findParcelJournalRow`, `_splitParcelJournalRow`, `_syncParcelJournalRow`, `buildDisposalJournalEntries`)

**Problem:** `_findParcelJournalRow(parcelId)` is supposed to find "the one journal row representing this parcel" via `.find(j => j.parcelId === parcelId)`. But two different kinds of rows can carry the same `parcelId`:
1. The original BUY/TOP_UP (or RECLASSIFY) row created when the parcel was opened.
2. Disposal-slice rows created by `buildDisposalJournalEntries()` for every SELL/TRIM that partially consumed that parcel (per gotcha #66 — these also carry `parcelId: d.parcelId`).

Both the original BUY row and any later disposal rows are inserted via `unshift()` (prepend), so a disposal row created **after** the BUY row ends up **earlier** in `state.tradeJournal`. `.find()` scans front-to-back and therefore returns the disposal row, not the original BUY row, once a parcel has been partially trimmed.

**Impact:** `setParcelAccount()` (account reassignment) and `splitParcel()` both call this lookup to mutate "the parcel's journal row" in place. On a parcel that has been partially trimmed:
- `setParcelAccount()` flips the **disposal/SELL row's** `account`/`action` to `RECLASSIFY` instead of the still-open BUY row's — corrupting a closed, already-realised SELL record's account/action fields, while the actual open lot's journal row keeps its stale account.
- `splitParcel()` would similarly mutate the wrong row's `qty`/`action`.

**Repro:**
1. Buy 100 CBA → parcel P#1, journal row A (`BUY`, `parcelId:1`, `status:'open'`).
2. Sell 40 CBA → `buildDisposalJournalEntries` creates row B (`SELL`, `parcelId:1`, `status:'closed'`), unshifted to the front of the array; row A's status is patched to `'trimmed'`.
3. Reassign the remaining 60 shares (still parcel P#1) to `trading` via the Portfolio lots UI → `setParcelAccount(1, 'trading')` → `_findParcelJournalRow(1)` returns row B (earlier in the array) and corrupts it to `account:'trading', action:'RECLASSIFY'`. Row A — the one that should have moved — is untouched.

**Fix:** Restrict `_findParcelJournalRow()` to rows that represent the *open lot itself*, i.e. add a filter excluding disposal actions: match on `parcelId` AND `action !== 'SELL' && action !== 'TRIM'` (equivalent to the `BUY|TOP_UP|RECLASSIFY` filter that `buildDisposalJournalEntries()`'s own internal `buyRow` lookup already correctly uses). Ideally extract one shared helper so the two lookups (the correct one and the buggy one) can't diverge again.

---

## 2. [HIGH] ✅ FIXED — `markExecuted()`'s parent-BUY reconciliation checks the wrong account's remaining shares

**File:** `js/pages/recommendations.js` (around line 1667)

```js
const remaining = getPortfolioHolding(rec.ticker);
const positionClosed = !remaining || (remaining.shares || 0) <= 0;
```

**Problem:** `getPortfolioHolding(ticker)` with no `account` argument returns the *first* `state.portfolio` row matching the ticker, regardless of account. If a ticker is held in two accounts (e.g. `personal` and `trading`), fully selling the position in **one** account can produce a false negative: the *other* account still holds shares, so `positionClosed` evaluates `false` even though the account actually being sold is fully closed.

**Impact:** The parent BUY/TOP_UP learning events for the now-closed position are never reconciled — `outcome` stays `'open'` forever, polluting calibration stats and the Learning page's win-rate/decay calculations indefinitely. This is a distinct bug from gotcha #67 in CLAUDE.md (which only fixed *which account a SELL/TRIM debits shares from* — it never touched this downstream "did this fully close the position" check).

**Repro:** Hold CBA in both `personal` (10 sh) and `trading` (5 sh). Fully sell the 5 `trading` shares via a SELL rec. `getPortfolioHolding('CBA')` returns the `personal` row (10 shares, non-zero) → `positionClosed=false` → the `trading` position's parent BUY/TOP_UP learning event never gets graded.

**Fix:** Pass the resolved `sellAccount` into the call: `getPortfolioHolding(rec.ticker, sellAccount)`.

---

## 3. [HIGH] ✅ FIXED — Broker-CSV SELL import bypasses the per-parcel journal model entirely

**File:** `js/pages/portfolio.js` (`_applyImportedSells`, lines ~849-899)

**Problem:** CLAUDE.md gotcha #66 documents that every SELL/TRIM must create one journal row per parcel matched (via `buildDisposalJournalEntries()`) and patch the original BUY/TOP_UP row's `status` to `closed`/`trimmed`. The broker-CSV "Apply SELL imports" handler does none of this:
- Calls `matchSaleAgainstParcels()` directly (mutates parcel `remainingQty`, pushes to `cgtDisposals`) but **never calls `buildDisposalJournalEntries()`**.
- Pushes exactly **one aggregate journal row** for the whole sale, using `disposals[0]?.parcelCostPerShare` as the row's `entryPrice` — when the sale spans multiple parcels bought at different prices, the displayed entry price reflects only the *first* parcel, even though `pnl` is (correctly) summed across all of them.
- Never sets `parcelId`/`parcel` on the new row and never patches the original BUY rows' `status`. Every parcel consumed by a CSV-imported SELL stays `status:'open'` forever, even though its `remainingQty` is now 0.

**Impact:** The Journal page's "Open positions" filter keeps showing fully-sold BUY rows as open indefinitely after a CSV-imported sale. The displayed entry price for multi-parcel CSV disposals is wrong/misleading. Any future code that trusts `status` to reflect whether a parcel is still open (rather than re-deriving from `remainingQty`) will disagree with reality for every CSV-imported sale.

**Repro:** Import a CommSec/SelfWealth CSV with a SELL row for a ticker that has 2 open parcels bought at different prices. Apply the SELL. Check the Journal page — the original 2 BUY rows still show `status:'open'`, and the new aggregate SELL row's Entry column shows only the first parcel's cost.

**Fix:** Route `_applyImportedSells()` through `buildDisposalJournalEntries()`, exactly as `markExecuted()` and `addManualTrade()` already do, instead of hand-rolling a single aggregate row.

---

## 4. [MEDIUM-HIGH] ✅ FIXED — `addHolding()` always creates the paired CGT parcel as `personal`, regardless of the chosen account

**File:** `js/pages/portfolio.js` (`addHolding`, lines ~939-955)

```js
const account = ['personal','super','trading'].includes(acctRaw) ? acctRaw : 'personal';
...
state.portfolio.push({ ticker: symbol, shares, avgPrice: avg, currentPrice: avg, sector, account });
...
addParcel(symbol, dateRaw, shares, avg, fees, sector);   // account argument omitted
```

**Problem:** The manual "Add Holding" flow correctly tags the new `state.portfolio` row with the user-chosen account, but the paired `addParcel()` call omits the `account` parameter — so the parcel itself always defaults to `personal`. The portfolio row and its own CGT parcel disagree about account from the moment of creation.

**Impact:** `getParcelsForTicker(ticker, method, 'trading')` (or `'super'`) will find zero parcels for a holding added under that account, since the underlying parcel is tagged `personal`. Selling the holding through the non-personal account flow either hits the "no open parcels" fallback (see Finding 6 below — wrong cost basis) or fails to find a matching open lot at all.

**Repro:** Add Holding → choose account `trading`. Portfolio row shows `account:'trading'`; `state.cgtParcels` shows the new parcel as `account:'personal'`.

**Fix:** Pass `account` through: `addParcel(symbol, dateRaw, shares, avg, fees, sector, account)`.

---

## 5. [MEDIUM-HIGH] ✅ FIXED — `reconcileJournalParcels()` drops the journal row's `account` when creating a missing parcel

**File:** `js/reconcile.js` (around line 26)

```js
addParcel(t.ticker, t.date || todayStr(), t.qty, t.entryPrice, t.fees || 0, t.sector || 'Other');
```

**Problem:** `addParcel`'s signature accepts a trailing `account` argument, but the "⟳ Reconcile" button's call site omits it — every parcel created during reconciliation defaults to `personal`, even when the journal row being reconciled says `account: 'trading'` or `'super'`. The "existing parcel" match a few lines above also doesn't check `account`, so it can silently re-link to a parcel that actually belongs to a *different* account but happens to share ticker/date/qty/cost (plausible when two accounts buy the same stock on the same day).

**Impact:** After reconciliation, a parcel's `account` field can permanently disagree with the journal row that "owns" it. Any later SELL against the correct (non-personal) account for that ticker may find "no open parcels" and fall through to a cost-basis fallback that's wrong (see Finding 6), or a `personal`-account sell could consume a parcel that should have been ring-fenced to `trading`/`super`.

**Fix:** Pass `t.account` through to `addParcel(...)`; add an `account` check to the existing-parcel match.

---

## 6. [LOW-MEDIUM] ✅ FIXED — `matchSaleAgainstParcels()`'s no-open-parcel fallback picks cost basis from the wrong account

**File:** `js/portfolio-helpers.js` (`matchSaleAgainstParcels`, around line 537-540)

```js
if (remaining > 0) {
  const holding = getPortfolioHolding(ticker);   // not scoped by account
  const costPerShare = holding ? holding.avgPrice : salePrice;
  ...
```

**Problem:** When a sale's quantity exceeds what the account-scoped open parcels can cover (the fallback path intended for legacy/pre-app positions with no parcel history), the cost basis defaults to `getPortfolioHolding(ticker)` — unscoped by account — even though `account` is already an available parameter in this function's signature.

**Impact:** If the same ticker is also held in a different account, this fallback can silently borrow that *other* account's average cost as the CGT cost basis, producing an incorrect `grossGain`/`netGain` for the disposal record. Compounds Findings 4 and 5, since both can leave a parcel tagged with the wrong account, making this fallback path more likely to trigger.

**Fix:** Thread `account` into this fallback's lookup: `getPortfolioHolding(ticker, account)`.

---

## 7. [MEDIUM] ✅ FIXED — `removeHolding()` orphans CGT parcels and journal rows, and the holding can silently resurrect

**File:** `js/pages/portfolio.js` (`removeHolding`, lines ~993-996)

```js
function removeHolding(i) {
  if(!confirm(`Remove ${state.portfolio[i].ticker}?`)) return;
  state.portfolio.splice(i,1); scheduleSave(); renderPage();
}
```

**Problem:** This only removes the `state.portfolio` row. It does not touch `state.cgtParcels` (open parcels for that ticker/account remain with `remainingQty > 0`) or `state.tradeJournal`. Any later call to `_recomputeHoldingFromParcels(ticker, account)` — triggered by `setParcelAccount()` for that ticker+account, including unrelated reassignments of other parcels of the same ticker — sums the still-open parcels and re-pushes a new `state.portfolio` row, resurrecting a holding the user explicitly removed.

**Impact:** Data inconsistency between the portfolio view and underlying parcel/journal data; a holding the user thought was deleted can reappear after an unrelated account-reassignment action.

**Repro:** Hold BHP with 2 open parcels. Click "✕ Remove" on the Portfolio page — the row disappears. Later, reassign one of BHP's parcels to another account and back — `_recomputeHoldingFromParcels` recreates the BHP row from the still-existing parcels.

**Fix:** Either block removal while open parcels exist (force the user to sell/transfer first), or explicitly clear the matching `cgtParcels` (and decide how to handle their journal rows) when a holding is force-removed.

---

## 8. [MEDIUM] ✅ FIXED — `removeJournalTrade()` deletes RECLASSIFY rows even though `rollbackTradeJournalEntry()` silently no-ops for them

**Files:** `js/portfolio-helpers.js` (`rollbackTradeJournalEntry`, lines ~710-772); `js/pages/journal.js` (`removeJournalTrade`, lines ~617-625)

**Problem:** `rollbackTradeJournalEntry(t)` only has branches for `action==='BUY'` and `action==='SELL'`. A row with `action:'RECLASSIFY'` (created by `splitParcel()`/`setParcelAccount()` per gotcha #79) matches neither branch and is a documented no-op for rollback purposes. But `removeJournalTrade()` calls `rollbackTradeJournalEntry(t)` and then unconditionally splices the row out of `state.tradeJournal` regardless of whether the rollback did anything.

**Impact:** Clicking "✕ Remove" on an `open`-status RECLASSIFY row (representing a still-held lot) deletes the only journal row for that parcel, without reversing any portfolio/parcel state and without warning the user that nothing was actually reversed. The underlying parcel becomes "journal-less" until the next account move recreates a row via `_syncParcelJournalRow`'s fallback insert path.

**Fix:** Give `rollbackTradeJournalEntry` an explicit `RECLASSIFY` branch (would need a stored "previous account" to revert to), or have `removeJournalTrade()` refuse/no-op with a clear toast for `RECLASSIFY` rows — the same way it already deliberately refuses for `'trimmed'` BUY rows.

---

## 9. [LOW] ✅ FIXED — Rec-card preview avg-cost/qty is unscoped by account (cosmetic only)

**File:** `js/pages/recommendations.js` (around line 363-365)

```js
const holding   = isReducing ? getPortfolioHolding(r.ticker) : null;
const avgCost   = holding ? holding.avgPrice : null;
const heldQty   = holding ? holding.shares : 0;
```

**Problem:** Purely a rendering concern for the pending-rec card's "avg cost"/"held qty" preview. When the ticker is held in 2+ accounts, the preview shows whichever account's row happens to be first in `state.portfolio`, which may not be the account the user is about to execute against. Not state-corrupting — the actual execution path in `markExecuted()` resolves the account correctly via the picker — but the preview numbers shown *before* execution can mislead.

**Fix:** If only one account holds the ticker, scope to it; if multiple, either show a clearly-labelled aggregate or defer the number until the account picker selection is known.

---

## 10. [Informational] Dead `status==='reclass'` code path confirms the documented model

**File:** `js/pages/journal.js` (around line 282)

The status badge ternary still checks for a `'reclass'` status value that, per CLAUDE.md gotchas #77/#79, no longer exists (status stays `open`/`trimmed`/`closed`; only `action` flips to `RECLASSIFY`). This is harmless dead code retained as a fallback for any pre-migration legacy rows — not a functional bug. Flagged only because this audit cross-checked code against CLAUDE.md's documented behavior, and this is a case where the documentation's claim is accurate.

---

## Summary table

| # | Title | File:line | Severity |
|---|---|---|---|
| 1 | `_findParcelJournalRow` can match a disposal row instead of the parcel's BUY row | `portfolio-helpers.js` (`_findParcelJournalRow`/`_splitParcelJournalRow`/`_syncParcelJournalRow`) | **Critical** |
| 2 | `markExecuted` parent-BUY reconciliation checks wrong account's remaining shares | `recommendations.js:~1667` | High |
| 3 | CSV SELL import bypasses the per-parcel journal model entirely | `portfolio.js` (`_applyImportedSells`, ~849-899) | High |
| 4 | `addHolding` parcel always defaults to `personal` regardless of chosen account | `portfolio.js:~955` | Medium-High |
| 5 | `reconcileJournalParcels` drops `account` when creating missing parcels | `reconcile.js:~26` | Medium-High |
| 6 | `matchSaleAgainstParcels` fallback cost-basis ignores account | `portfolio-helpers.js:~539` | Low-Medium |
| 7 | `removeHolding` orphans parcels/journal rows; holding can resurrect | `portfolio.js:~993-996` | Medium |
| 8 | `removeJournalTrade` deletes RECLASSIFY rows even though rollback no-ops | `portfolio-helpers.js` (`rollbackTradeJournalEntry`) + `journal.js:~617` | Medium |
| 9 | Rec-card preview avg cost/qty unscoped by account | `recommendations.js:~363` | Low (cosmetic) |
| 10 | Dead `status==='reclass'` code path | `journal.js:~282` | Informational |

**Common root cause across most findings:** account-scoping was added incrementally (gotchas #66–#80) to the *primary* execution paths (`markExecuted`, `setParcelAccount`, `splitParcel`), but several **secondary/legacy paths** — CSV import, manual Add Holding, the Reconcile button, and the no-parcel fallback inside `matchSaleAgainstParcels` — were never updated to thread `account` through, and one *primary* path (`_findParcelJournalRow`) has a latent ordering bug from the `unshift()` convention used elsewhere. Recommend a follow-up pass that (a) makes `account` a required, non-optional parameter everywhere parcels are created or queried so a missing argument is a loud error rather than a silent `personal` default, and (b) adds a single shared "find the open-lot journal row for this parcel" helper used by every reassignment/split code path.

No code was changed as part of this audit.
