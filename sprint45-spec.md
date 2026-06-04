# Sprint 45 Spec

Work in /home/tanth/projects/sloth-asx-trader. Run tests after each item.
Before implementing any item, READ the relevant files listed under that item.

---

## Item 1 — Thesis drift detection (M, backend + frontend)

**Problem:** No way to know whether early exits (manual closes before target) are systematically underperforming vs. positions held to target. If they are, the anti-churn rules should be stronger.

**Files to read first:**
- `routes/learning.py` — understand `_calib_compute()` structure, calibration block assembly, and the `ai_learning_events` schema (columns: `exit_reason`, `realized_pnl_pct`, `was_executed`, `outcome_status`, `holding_period_days`, `sell_primary_driver`)
- `js/pages/learning.js` — understand how existing analytics cards (sell outcomes, success patterns) are rendered
- `js/prompts.js` — find `ANALYSIS_SYSTEM_PROMPT` Section 2B (Anti-Churn) to know where to inject the nudge

### Backend

1. **`routes/learning.py`** — Add new function `_compute_thesis_drift(conn)`:

```python
def _compute_thesis_drift(conn):
    """
    Compare avg realized_pnl_pct of manual early exits vs target hits.
    Returns dict with counts, averages, and a nudge token string (or None).
    Minimum 5 events in each bucket before computing.
    """
    rows = conn.execute("""
        SELECT exit_reason, realized_pnl_pct
        FROM ai_learning_events
        WHERE was_executed = 1
          AND outcome_status IN ('win', 'loss', 'breakeven')
          AND realized_pnl_pct IS NOT NULL
          AND exit_reason IN ('manual', 'target_hit')
    """).fetchall()
    
    manual = [r["realized_pnl_pct"] for r in rows if r["exit_reason"] == "manual"]
    target = [r["realized_pnl_pct"] for r in rows if r["exit_reason"] == "target_hit"]
    
    result = {
        "n_manual": len(manual),
        "n_target": len(target),
        "avg_manual_pct": round(sum(manual)/len(manual), 2) if manual else None,
        "avg_target_pct": round(sum(target)/len(target), 2) if target else None,
        "nudge": None
    }
    
    if len(manual) >= 5 and len(target) >= 5:
        drag = result["avg_target_pct"] - result["avg_manual_pct"]
        if drag > 3.0:  # early exits underperform target hits by >3pp
            result["nudge"] = (
                f"⚠EARLY_EXIT_DRAG: manual_avg={result['avg_manual_pct']:+.1f}% "
                f"vs target_hit_avg={result['avg_target_pct']:+.1f}% "
                f"(n_manual={len(manual)},n_target={len(target)}) "
                f"→ hold longer before manual exits"
            )
    return result
```

2. **`routes/learning.py`** — Add `GET /api/learning/thesis-drift` endpoint:

```python
@bp.route("/api/learning/thesis-drift")
def thesis_drift():
    conn = get_db()
    result = _compute_thesis_drift(conn)
    return jsonify({**result, "ok": True})
```

3. **`routes/learning.py` → `_calib_compute()`** — After the existing calibration block assembly, call `_compute_thesis_drift(conn)` and if `result["nudge"]` is not None, append it as an additional token to the calibration block string (after the last existing section, subject to the existing token-budget truncation logic). Do NOT call this if n_manual < 5 or n_target < 5.

### Frontend

4. **`js/pages/learning.js`** — Add `renderThesisDriftCard()` async function. Calls `GET /api/learning/thesis-drift`. Render a card with:
   - Two stat boxes: "Early Exits (manual)" avg P&L (n=X) and "Target Hits" avg P&L (n=X)
   - A coloured summary line: if `drag > 3pp` → amber warning "Early exits underperforming by Xpp — consider holding longer"; if drag ≤ 3pp → green "Early exit performance healthy"
   - If insufficient data (n<5 in either bucket): "Not enough closed trades yet (need ≥5 in each category)"
   - Call this from the main `renderLearningPage()` alongside the other async cards

### Tests
- Add test for `GET /api/learning/thesis-drift` (empty DB → ok with nulls; with mock data → correct averages and nudge threshold)

---

## Item 2 — Stop-loss trailing (S, frontend)

**Problem:** Pending rec cards show a fixed stop set at analysis time. As a trade moves in your favour, there's no way to trail the stop up (for BUY) or down (for SELL) without re-running full analysis.

**Files to read first:**
- `js/pages/recommendations.js` — find where pending rec cards are rendered and action buttons are placed (look for "markExecuted", "remove rec" button as patterns)
- `js/regime-engine.js` — find `getRegimeModifiers()` to get `stopAtrMult`
- `js/config.js` — find `state.currentRegime` shape

### Implementation

1. **`js/pages/recommendations.js`** — Add a "Trail" button on each pending BUY/TOP_UP/SELL/TRIM rec card (not HOLD). Place it next to the existing action buttons.

   On click, call `trailStop(recId)`:
   ```js
   function trailStop(recId) {
     const rec = state.recommendations.find(r => r.id === recId);
     if (!rec) return;
     
     const signals = state.liveSignals?.[rec.ticker];
     const price = signals?.current_price || rec.priceRange?.[0];
     const atr = signals?.atr_14;
     
     if (!price || !atr) {
       toast(`No live price/ATR for ${rec.ticker} — refresh signals first`);
       return;
     }
     
     const regime = state.currentRegime?.regime || 'sideways';
     const mod = getRegimeModifiers(regime);
     const mult = mod.stopAtrMult ?? 2.5;
     
     const isBuy = rec.action === 'BUY' || rec.action === 'TOP_UP';
     const newStop = isBuy
       ? +(price - mult * atr).toFixed(4)
       : +(price + mult * atr).toFixed(4);
     
     // Only tighten — never loosen
     const wouldTighten = isBuy
       ? newStop > rec.stopLoss       // BUY: higher stop = tighter
       : newStop < rec.stopLoss;      // SELL: lower stop = tighter
     
     if (!wouldTighten) {
       toast(`Stop already tighter than ${mult}×ATR trail (current $${rec.stopLoss.toFixed(3)} vs trail $${newStop.toFixed(3)})`);
       return;
     }
     
     const confirmed = confirm(
       `Trail stop for ${rec.ticker} ${rec.action}:\n` +
       `  Current stop: $${rec.stopLoss.toFixed(3)}\n` +
       `  New stop:     $${newStop.toFixed(3)} (${mult}×ATR @ $${price.toFixed(3)})\n\n` +
       `Proceed?`
     );
     if (!confirmed) return;
     
     rec.stopLoss = newStop;
     // Recompute R:R if target exists
     if (rec.target) {
       const stopDist = Math.abs(price - newStop);
       const targetDist = Math.abs(rec.target - price);
       rec.rrRatio = stopDist > 0 ? +(targetDist / stopDist).toFixed(2) : null;
     }
     rec._stopTrailed = true;
     rec._stopTrailedAt = new Date().toISOString();
     
     scheduleSave();
     renderPage(); // re-render recommendations
     toast(`Stop trailed to $${newStop.toFixed(3)} for ${rec.ticker}`);
   }
   ```

2. On rec cards where `rec._stopTrailed` is true, add a small badge "📍 Trailed" next to the stop display.

3. **CLAUDE.md** — Add note to Key data shapes for `recHistory/recommendations`: `_stopTrailed: bool`, `_stopTrailedAt: ISO string`.

### Tests
- `npm run test:js` must still pass (no changes to quant-engine / regime-engine logic, so existing tests unaffected)
- Run frontend syntax check

---

## Item 3 — Scheduled morning briefing (S, frontend)

**Problem:** The morning briefing must be manually triggered via Dashboard button. Useful to have it auto-fire at a configured time (e.g. 9:30 AM AEST) on first page load after that time.

**Files to read first:**
- `js/pages/dashboard.js` — find `generateMorningBriefing()` function (the button handler)
- `js/pages/settings.js` — find how other settings toggles/inputs are rendered and saved (e.g. `stopProximityPct`, `compactMode`)
- `js/config.js` — find the `state.settings` defaults block
- `js/init.js` — find where startup initialisation fires

### Implementation

1. **`js/config.js`** — Add to `state.settings`:
   ```js
   autoBriefTime: '',   // 'HH:MM' in AEST, empty = disabled
   ```

2. **`js/pages/settings.js`** — Add "Auto-brief time (AEST)" time input in the Display/Workflow settings section (near other UX toggles). On change, update `state.settings.autoBriefTime` and call `scheduleSave()`. Show hint: "Leave blank to disable. Brief fires once per day on first load at or after this time."

3. **`js/init.js`** — Add `checkAutoBriefSchedule()` call at the end of the init sequence (after state is loaded). Also call it from `prices.js` after each price refresh (or from `scheduler.js` if there's an existing periodic hook — check first).

   ```js
   function checkAutoBriefSchedule() {
     const t = state.settings?.autoBriefTime;
     if (!t) return;
     
     // Check if already fired today
     const todayKey = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
     const firedKey = 'autoBriefFiredDate';
     if (localStorage.getItem(firedKey) === todayKey) return;
     
     // Check if current AEST time >= configured time
     // AEST = UTC+10, AEDT = UTC+11. Use a fixed +10 offset (conservative; AEDT gives 1h extra)
     const nowUtc = new Date();
     const aestOffset = 10 * 60; // minutes
     const aestNow = new Date(nowUtc.getTime() + aestOffset * 60 * 1000);
     const aestHHMM = aestNow.toISOString().slice(11, 16); // 'HH:MM'
     
     if (aestHHMM < t) return; // not yet time
     
     // Check brief not already generated today
     if (window._morningBrief?.date === todayKey) {
       localStorage.setItem(firedKey, todayKey); // already done, mark fired
       return;
     }
     
     // Fire
     localStorage.setItem(firedKey, todayKey);
     if (typeof generateMorningBriefing === 'function') {
       generateMorningBriefing();
     }
   }
   ```

4. In `scheduler.js` (if it has a periodic tick) OR in `prices.js` after price refresh — call `checkAutoBriefSchedule()`. Check `scheduler.js` first; if it has a regular interval function, add it there. Otherwise add to `prices.js → refreshPrices()`.

5. **CLAUDE.md** — Add `state.settings.autoBriefTime` to the Key data shapes settings list.

### Tests
- `npm run test:js` must pass (no engine changes)
- Run frontend syntax check

---

## Completion checklist

1. `python test_app.py` — all tests pass (including new thesis-drift tests)
2. `npm run test:js` — all tests pass
3. `for f in js/*.js js/pages/*.js; do node --check "$f" || echo "FAIL: $f"; done`
4. Update IMPROVEMENTS.md: add Sprint 45 shipped section at top (above Sprint 44)
5. Update CLAUDE.md: add `_stopTrailed/_stopTrailedAt` to Key data shapes; add `autoBriefTime` to settings; add thesis-drift to Learning Loop internals reference
6. Create a PR against main
