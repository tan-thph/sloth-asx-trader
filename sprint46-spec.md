# Sprint 46 Spec

Work in /home/tanth/projects/sloth-asx-trader. Run tests after each item.
Before implementing any item, READ the relevant files listed under that item.

---

## Item 1 — Broker CSV SELL import (M, frontend + backend)

Currently `routes/import_csv.py` returns SELL rows in `skipped` with reason
"SELL rows require manual entry via markExecuted". This forces manual data entry
for every CommSec/SelfWealth sale — the most common post-trade operation.

**Files to read first:**
- `routes/import_csv.py` — understand current parsing; find where SELL rows are skipped
- `js/pages/portfolio.js` — find `handleBrokerCSV()` to understand how BUY rows are applied;
  find `applySplitAdjustment()` as a pattern for parcel mutation
- `js/pages/cgt.js` — CRITICAL: find the actual state key name for open parcels
  (search `state.` near `costPerShare`, `remainingQty`, `openParcel`). Also find
  `state.cgtDisposals` or equivalent key for closed trades.
- `js/pages/performance.js` — find `syncClosedTradesToLearningLoop()` to understand
  how closed trades are handled
- `js/config.js` — confirm open-parcels and cgtDisposals key names in state defaults

### Backend change (`routes/import_csv.py`)

Stop skipping SELL rows — return them in a separate `sells` array alongside `rows` (BUYs):

```python
# Return shape change:
{
  "ok": true,
  "broker": "commsec",
  "rows": [...],          # BUY rows (unchanged)
  "sells": [{             # NEW — SELL rows for frontend FIFO matching
    "action": "SELL",
    "ticker": "BHP.AX",
    "shares": 50,
    "price": 45.20,
    "date": "2026-05-15",
    "brokerage": 19.95
  }, ...],
  "skipped": [...],       # other skipped rows (unchanged)
  "total": N
}
```

Remove SELL rows from `skipped` — they are no longer skipped, just returned separately.

### Frontend change (`js/pages/portfolio.js`)

After the existing BUY import flow, if `result.sells.length > 0`, show a **SELL confirmation panel**:

1. For each SELL row, compute FIFO match against open parcels:
   - Sort open parcels for that ticker by `date` ascending (oldest first)
   - Walk through parcels consuming `remainingQty` until `shares` is satisfied
   - For each parcel consumed: `gain = (sellPrice - parcel.costPerShare) * sharesConsumed`
   - Track `totalGain`, `totalCost`, whether any parcel qualifies for CGT discount (held > 365 days)

2. Render a confirmation table with columns:
   | Ticker | Shares | Price | Cost Basis | Gain/Loss | CGT Discount? | Brokerage |
   Include a CGT warning badge on parcels within 45 days of the 12-month mark.

3. "Apply SELL imports" button — on confirm, for each SELL row:

   ```js
   function applyImportedSell(ticker, shares, price, date, brokerage) {
     // a) FIFO parcel consumption — discover exact state key from cgt.js
     let remaining = shares;
     const disposals = [];
     for (const parcel of openParcels.filter(p => p.ticker === ticker)
                                      .sort((a,b) => a.date.localeCompare(b.date))) {
       if (remaining <= 0) break;
       const consumed = Math.min(remaining, parcel.remainingQty);
       const gain = (price - parcel.costPerShare) * consumed;
       const heldDays = Math.floor((new Date(date) - new Date(parcel.date)) / 86400000);
       disposals.push({
         id: Date.now() + Math.random(),
         ticker, date,
         qtySold: consumed,
         costPerShare: parcel.costPerShare,
         salePrice: price,
         gain: +gain.toFixed(2),
         cgtDiscount: heldDays >= 365,
         parcelDate: parcel.date,
         brokerage: consumed === shares ? brokerage : 0  // allocate brokerage to first lot
       });
       parcel.remainingQty -= consumed;
       remaining -= consumed;
     }

     // b) Remove fully consumed parcels
     // (update state open-parcels key)

     // c) Add to cgtDisposals (discover exact key from cgt.js)

     // d) Update portfolio holding
     const holding = state.portfolio.find(h => h.ticker === ticker);
     if (holding) {
       holding.shares -= shares;
       if (holding.shares <= 0) {
         state.portfolio = state.portfolio.filter(h => h.ticker !== ticker);
       }
     }

     // e) Add to tradeJournal
     state.tradeJournal.push({
       id: Date.now(),
       date, ticker,
       action: 'SELL',
       qty: shares,
       entryPrice: disposals[0]?.costPerShare || 0,
       exitPrice: price,
       fees: brokerage,
       pnl: +disposals.reduce((s, d) => s + d.gain, 0).toFixed(2),
       status: 'closed',
       recId: null,
       recExecuted: false,
       closeDate: date
     });
   }
   ```

4. After applying all SELLs, call `scheduleSave()` and re-render.

5. **Warning:** if a SELL ticker has no open parcels, show an amber row "No parcels found for {TICKER} — skipped. Add holdings first."

### Tests
- Add backend test: CSV with SELL rows now returns `sells` array (not in `skipped`)
- Add backend test: SELL rows correctly parsed for CommSec and SelfWealth formats

---

## Item 2 — Rebalancing suggestions panel (M, frontend only)

**Files to read first:**
- `js/pages/risk.js` — find `_buildTargetAllocCard()` and how `state.targetAllocations` is used.
  Find where the drift table is rendered. This is where the button will be added.
- `js/quant-engine.js` — understand `QUANT_CONFIG` (minQty, etc.)
- `js/config.js` — confirm `state.targetAllocations` shape: `{ TICKER: targetWeightPct }`

### Implementation (`js/pages/risk.js`)

Add a "📋 Suggest Rebalance" button to the target allocation drift card header.
This is **deterministic** — no Claude call. Pure math from current state.

On click, call `_buildRebalanceSuggestions()` and render a modal or inline panel:

```js
function _buildRebalanceSuggestions() {
  const totalValue = (state.cash || 0) + state.portfolio.reduce(
    (s, h) => s + h.shares * (h.currentPrice || h.avgPrice), 0);
  if (!totalValue) return '<p>No portfolio data.</p>';

  const rows = [];
  const allTickers = new Set([
    ...state.portfolio.map(h => h.ticker),
    ...Object.keys(state.targetAllocations || {})
  ]);

  for (const ticker of allTickers) {
    const holding = state.portfolio.find(h => h.ticker === ticker);
    const targetPct = state.targetAllocations?.[ticker] || 0;
    const currentValue = holding ? holding.shares * (holding.currentPrice || holding.avgPrice) : 0;
    const currentPct = totalValue > 0 ? (currentValue / totalValue) * 100 : 0;
    const targetValue = totalValue * targetPct / 100;
    const delta = targetValue - currentValue;  // positive = need to BUY, negative = need to SELL/TRIM
    const price = holding?.currentPrice || holding?.avgPrice || 0;
    const shares = price > 0 ? Math.floor(Math.abs(delta) / price) : 0;

    if (Math.abs(currentPct - targetPct) < 1.0) continue;  // within 1% — skip
    if (shares < 1) continue;

    // CGT discount check: warn if selling within 45 days of 12-month mark
    let cgtWarning = null;
    if (delta < 0 && holding) {
      const openParcels = /* discover key */ [];
      // check if any parcel is between 320–365 days old
      const atRisk = openParcels.filter(p => p.ticker === ticker).some(p => {
        const held = Math.floor((Date.now() - new Date(p.date)) / 86400000);
        return held >= 320 && held < 365;
      });
      if (atRisk) cgtWarning = '⚠ CGT discount at risk';
    }

    rows.push({
      ticker,
      action: delta > 0 ? 'BUY' : (holding ? 'TRIM' : null),
      currentPct: +currentPct.toFixed(1),
      targetPct: +targetPct.toFixed(1),
      driftPct: +(currentPct - targetPct).toFixed(1),
      shares,
      estimatedValue: +(shares * price).toFixed(0),
      cgtWarning
    });
  }

  // Sort: largest drift first
  rows.sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct));

  // Cash check: total BUY value vs available cash
  const totalBuyValue = rows.filter(r => r.action === 'BUY')
                            .reduce((s, r) => s + r.estimatedValue, 0);
  const cashShortfall = totalBuyValue > (state.cash || 0)
    ? totalBuyValue - (state.cash || 0) : 0;

  // Render table
  return `
    <div class="rebalance-panel">
      <h4>Rebalance Suggestions</h4>
      <p class="text-secondary">Deterministic — no AI call. Review and execute each trade manually via markExecuted.</p>
      ${cashShortfall > 0 ? `<div class="alert amber">⚠ BUY suggestions total $${totalBuyValue.toLocaleString()} — exceeds available cash by $${cashShortfall.toLocaleString()}. Prioritise largest drifts first.</div>` : ''}
      <table>
        <thead><tr><th>Ticker</th><th>Action</th><th>Current</th><th>Target</th><th>Drift</th><th>Shares</th><th>Est. Value</th><th>Notes</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><strong>${r.ticker}</strong></td>
              <td class="${r.action === 'BUY' ? 'text-green' : 'text-orange'}">${r.action}</td>
              <td>${r.currentPct}%</td>
              <td>${r.targetPct}%</td>
              <td class="${Math.abs(r.driftPct) >= 5 ? 'text-red' : 'text-orange'}">${r.driftPct > 0 ? '+' : ''}${r.driftPct}%</td>
              <td>${r.shares}</td>
              <td>$${r.estimatedValue.toLocaleString()}</td>
              <td>${r.cgtWarning || ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${rows.length === 0 ? '<p class="text-secondary">Portfolio is within 1% of all targets — no rebalancing needed.</p>' : ''}
    </div>`;
}
```

Render in a `<dialog>` modal (use the existing `dialog` pattern in the codebase — search for `showModal()` or `<dialog` to find the pattern).

### Tests
- `npm run test:js` passes (no engine changes)
- Frontend syntax check passes

---

## Item 3 — ASX universe exclusion list (S, backend + frontend)

**Problem:** `ASX_UNIVERSE` in `core.py` is a hardcoded dict. When `universe-health` finds
stale/delisted tickers, there's no way to exclude them from scans without editing the source file.

**Files to read first:**
- `routes/market.py` — find `universe_health()` endpoint and `GET /api/market/universe-health`
- `routes/scanner.py` — find how `ASX_UNIVERSE` is imported and used in scan routes
- `routes/portfolio.py` — find `BLOB_KEYS` to understand blob_store patterns
- `js/pages/settings.js` — find the "Universe Health" / "Check Now" section (App Info card)

### Backend

1. **`routes/market.py` → `universe_health()`** — Accept optional `?exclude=BHP.AX,XYZ.AX`
   query param. Save any exclusions passed via `POST /api/market/universe-exclude`:

   ```python
   @bp.route("/api/market/universe-exclude", methods=["POST"])
   def universe_exclude():
       """Add tickers to the scan exclusion list stored in blob_store."""
       data = request.get_json() or {}
       tickers = [t.strip().upper() for t in data.get("tickers", []) if t.strip()]
       conn = get_db()
       # Read existing exclusions
       row = conn.execute("SELECT value FROM blob_store WHERE key='universe_excluded'").fetchone()
       existing = json.loads(row["value"]) if row else []
       merged = list(set(existing + tickers))
       conn.execute(
           "INSERT OR REPLACE INTO blob_store (key, value) VALUES ('universe_excluded', ?)",
           (json.dumps(merged),)
       )
       conn.commit()
       return jsonify({"ok": True, "excluded": merged})
   
   @bp.route("/api/market/universe-exclude", methods=["DELETE"])
   def universe_unexclude():
       """Remove tickers from the exclusion list."""
       data = request.get_json() or {}
       tickers = [t.strip().upper() for t in data.get("tickers", []) if t.strip()]
       conn = get_db()
       row = conn.execute("SELECT value FROM blob_store WHERE key='universe_excluded'").fetchone()
       existing = json.loads(row["value"]) if row else []
       merged = [t for t in existing if t not in tickers]
       conn.execute(
           "INSERT OR REPLACE INTO blob_store (key, value) VALUES ('universe_excluded', ?)",
           (json.dumps(merged),)
       )
       conn.commit()
       return jsonify({"ok": True, "excluded": merged})
   ```

2. **`routes/scanner.py`** — On scan start, fetch `universe_excluded` from `blob_store` and
   filter those tickers out of the universe list before scanning. Lazy-load once per scan:
   ```python
   row = conn.execute("SELECT value FROM blob_store WHERE key='universe_excluded'").fetchone()
   excluded = set(json.loads(row["value"])) if row else set()
   tickers = [t for t in universe_tickers if t not in excluded]
   ```

3. **`routes/intraday.py`** — Same exclusion filter applied when building the scan list.

4. **`routes/market.py` → `universe_health()`** — Return `excluded` list in response:
   ```python
   return jsonify({"stale": stale, "ok_count": ok_count, "checked_at": ..., "excluded": excluded_list})
   ```

### Frontend (`js/pages/settings.js`)

In the App Info / Universe Health card:

1. Show "Excluded from scans: N tickers" badge next to "Check Now" button.
2. In the health check results, next to each stale ticker shown, add an "Exclude" button.
3. Show the full excluded list with "Re-include" button per ticker.
4. On "Exclude" click: `POST /api/market/universe-exclude {tickers: [ticker]}` and re-render the card.
5. On "Re-include" click: `DELETE /api/market/universe-exclude {tickers: [ticker]}`.

### Tests
- Add test for `POST /api/market/universe-exclude` — adds to blob_store
- Add test for `DELETE /api/market/universe-exclude` — removes from blob_store
- Add test verifying excluded tickers are absent from scan universe

---

## Completion checklist

1. `python test_app.py` — all tests pass (including new import/exclude tests)
2. `npm run test:js` — all tests pass
3. `for f in js/*.js js/pages/*.js; do node --check "$f" || echo "FAIL: $f"; done`
4. Update IMPROVEMENTS.md: add Sprint 46 shipped section at top
5. Update CLAUDE.md:
   - Add `POST /api/market/universe-exclude` and `DELETE /api/market/universe-exclude` to backend endpoint reference
   - Update import_csv section: note SELL rows now returned in `sells` array
   - Add `universe_excluded` to blob_store key description
6. Create a PR against main
