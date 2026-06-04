# Sprint 49 Spec

Work in /home/tanth/projects/sloth-asx-trader.
Primary files: `js/analysis.js`, `js/pages/recommendations.js`, `js/pages/settings.js`,
`js/config.js`, `routes/market.py`.
Read relevant files IN FULL before changing anything.
Run tests after each item.

---

## Item 1 — Correlation hard block at ρ > 0.85 (S, frontend)

**Files:** `js/analysis.js`, `js/config.js`, `js/pages/settings.js`

**Problem:** At `|ρ| > 0.85` the app currently halves position size. A position 0.90 correlated
with an existing holding provides almost no diversification — you're doubling the same factor
exposure at half size. This is worse than not trading: it consumes heat budget while adding
near-zero diversification benefit. The fix: hard-block at the configurable threshold instead of
size-halving.

### Implementation

**`js/config.js`** — add new setting:
```js
settings: {
  // ... existing fields ...
  corrBlockThreshold: 0.85,  // hard-block BUY when |ρ| with any holding exceeds this
}
```

**`js/analysis.js`** — find the correlation adjustment block (~line 890). Currently:
```js
if (maxCorr > 0.85) {
  // size halved
} else if (maxCorr > 0.7) {
  // size -30%
}
```

Change to:
```js
const _corrBlock = state.settings?.corrBlockThreshold ?? 0.85;
const _corrSoft  = Math.min(_corrBlock - 0.10, 0.75);  // soft gate 10pp below hard block

if (maxCorr >= _corrBlock) {
  // Hard block — treat like regime block: set _corrBlocked flag, exclude from recs
  return {
    ...r,
    qty: 0,
    _corrBlocked: true,
    _corrNote: `blocked: corr ${maxCorr.toFixed(2)} with ${maxCorrTicker} ≥ threshold ${_corrBlock} — no diversification benefit`,
  };
} else if (maxCorr > _corrSoft) {
  const mult = 0.7;
  return { ...r,
    qty: Math.max(1, Math.round(r.qty * mult)),
    riskAUD: r.riskAUD ? Math.round(r.riskAUD * mult) : r.riskAUD,
    _corrNote: `corr ${maxCorr.toFixed(2)} with ${maxCorrTicker} — size −30%` };
}
return r;
```

Then after the correlation loop, filter out hard-blocked recs and add them to dataGaps.
Find where `_regimeBlocked` recs are filtered (search for `_regimeBlocked` in analysis.js)
and add `_corrBlocked` to the same filter:

```js
// Already exists — add _corrBlocked to the condition:
const filteredRecs = adjustedRecs.filter(r => {
  if (r._regimeBlocked) { /* existing logic */ return false; }
  if (r._corrBlocked) {
    console.log(`[Corr] blocked ${r.ticker}: ${r._corrNote}`);
    return false;
  }
  return true;
});
```

The blocked rec should also be surfaced in the analysis summary so the user knows why it was
dropped. Find where the `summary` is stored after analysis and append a note:
e.g. `state.analysisLastSummary` or the summary field — check how `_regimeBlocked` recs are
reported and follow the same pattern.

**`js/pages/settings.js`** — add a "Correlation block threshold" input to the Risk/Trading
settings section (near other thresholds like `stopProximityPct`):

```html
<label>Correlation block threshold (0–1, default 0.85)
  <input type="number" min="0.5" max="1.0" step="0.01"
         value="${state.settings.corrBlockThreshold ?? 0.85}"
         oninput="state.settings.corrBlockThreshold=+this.value;scheduleSave()">
  <span class="hint">BUY recs with |ρ| above this vs any existing holding are hard-blocked.
  Soft gate fires 10pp below (e.g. −30% size at 0.75 when threshold is 0.85).</span>
</label>
```

### Tests
- Add a JS test (or Python test checking analysis.js contains `_corrBlocked`) verifying the
  hard-block path exists
- Verify `corrBlockThreshold` default is 0.85 in config.js

---

## Item 2 — DB last-committed display in Settings (S, backend + frontend)

**Files:** `routes/market.py` (or a new small route in `routes/portfolio.py`), `js/pages/settings.js`

**Problem:** `asx_trader.db` is now tracked in git. The user needs to know when it was last
committed (i.e., last backup) so they know how much data would be lost if the machine died.
The `GET /health` endpoint already shows `last_backup` (file copy via `backup_db()`), but that's
a local file copy, not a git commit. We need a separate "last git commit of the DB" indicator.

### Backend

Add to `routes/portfolio.py` (or `routes/market.py` — check which is cleaner):

```python
@bp.route("/api/db/git-status")
def db_git_status():
    """Return the last git commit date for asx_trader.db."""
    import subprocess, shutil
    if not shutil.which("git"):
        return jsonify({"ok": False, "error": "git not available"}), 200
    try:
        result = subprocess.run(
            ["git", "log", "-1", "--format=%ci", "--", "asx_trader.db"],
            capture_output=True, text=True, timeout=5,
            cwd=str(Path(__file__).parent.parent)
        )
        last_commit = result.stdout.strip() or None
        result2 = subprocess.run(
            ["git", "status", "--porcelain", "asx_trader.db"],
            capture_output=True, text=True, timeout=5,
            cwd=str(Path(__file__).parent.parent)
        )
        is_dirty = bool(result2.stdout.strip())
        return jsonify({"ok": True, "last_committed": last_commit, "has_uncommitted": is_dirty})
    except Exception as ex:
        return jsonify({"ok": False, "error": str(ex)}), 200
```

Register the route in the appropriate blueprint.

### Frontend

In `js/pages/settings.js`, in the App Info card (near the `last_backup` display), add:

```js
// After existing backup display:
try {
  const gr = await fetch(`${API}/api/db/git-status`);
  const gd = await gr.json();
  if (gd.ok) {
    const gitEl = document.getElementById('settings-db-git-status');
    if (gitEl) {
      const committed = gd.last_committed ? gd.last_committed.slice(0, 16) : 'never committed';
      const dirty = gd.has_uncommitted ? ' ⚠ uncommitted changes' : '';
      gitEl.textContent = `DB last committed: ${committed}${dirty}`;
    }
  }
} catch {}
```

Add `<span id="settings-db-git-status" class="text-xs text-muted"></span>` to the App Info
card HTML in settings.js (near the `last_backup` span).

### Tests
- Add test: `GET /api/db/git-status` returns `ok: true` with expected fields
- Test handles missing git gracefully (returns `ok: false` not a 500)

---

## Item 3 — Surface `_corrBlocked` in dataGaps for transparency (S, frontend)

**Files:** `js/analysis.js`

When a BUY rec is hard-blocked by correlation, the user currently has no visibility — the rec
just doesn't appear. Add it to the `dataGaps` array that's already displayed in the
recommendations summary:

```js
// After filtering _corrBlocked recs, collect them:
const corrBlockedRecs = adjustedRecs.filter(r => r._corrBlocked);
// Append to dataGaps in the parsed response:
if (corrBlockedRecs.length && _parsed?.data?.dataGaps) {
  corrBlockedRecs.forEach(r => {
    _parsed.data.dataGaps.push({
      ticker: r.ticker,
      missingField: r._corrNote,
    });
  });
}
```

This is a 5-line addition. The dataGaps already render as amber "Data gaps" cards under the
recommendations. The user will see e.g. "BHP: blocked: corr 0.91 with RIO ≥ threshold 0.85".

---

## Completion checklist

1. `python test_app.py` — all tests pass
2. `npm run test:js` — all tests pass
3. `for f in js/*.js js/pages/*.js; do node --check "$f" || echo "FAIL: $f"; done`
4. Update `IMPROVEMENTS.md`: add Sprint 49 shipped section
5. Update `CLAUDE.md`:
   - Add `state.settings.corrBlockThreshold` to Key data shapes settings
   - Add `GET /api/db/git-status` to backend endpoint reference
   - Update correlation note in analysis.js infrastructure description
6. Create a PR against main
