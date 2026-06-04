# Sprint 48 — Local LLM SELL/TRIM Support

Work in /home/tanth/projects/sloth-asx-trader.
Primary files: `routes/debate.py`, `js/claude-client.js`, `js/pages/recommendations.js`.
Read all three IN FULL before making any changes.

## Background

`useLocalLLM=true` routes portfolio analysis to `/api/debate/quick-analysis` (Ollama).
Currently `_SCHEMA_QUICK_ANALYSIS` only allows BUY/TOP_UP/HOLD. In a falling market
the local path produces NO exit signals — the user must disable the toggle to get
SELL/TRIM. This is a dangerous asymmetry (critics.md §A).

The fix: extend the endpoint to support SELL/TRIM with a simplified tag set.
The full Claude path uses 9 primary drivers + 12 secondary factors + urgency.
For local LLM we use a **simplified 5-driver set** and skip secondary_factors —
small models handle a narrow taxonomy more reliably.

---

## Item 1 — Extend `_SCHEMA_QUICK_ANALYSIS` (routes/debate.py)

Add SELL and TRIM to the action enum. Add the exit-specific required fields.

```python
_SCHEMA_QUICK_ANALYSIS = {
    "type": "object",
    "properties": {
        "recs": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "ticker":         {"type": "string"},
                    "action":         {"type": "string",
                                       "enum": ["BUY", "TOP_UP", "HOLD", "SELL", "TRIM"]},
                    "confidence":     {"type": "number"},
                    "priceRange":     {"type": "array", "items": {"type": "number"}},
                    "target":         {"type": "number"},
                    "stopLoss":       {"type": "number"},
                    "reasoning":      {"type": "string"},
                    "risks":          {"type": "string"},
                    # Exit fields — required only when action is SELL or TRIM
                    "primary_driver": {"type": "string",
                                       "enum": ["thesis_broken", "stop_triggered",
                                                "target_reached", "time_stop",
                                                "risk_management"]},
                    "urgency":        {"type": "string",
                                       "enum": ["immediate", "routine", "monitor"]},
                },
                "required": ["ticker", "action", "confidence", "reasoning", "risks"],
            },
        },
        "summary": {"type": "string"},
    },
    "required": ["recs"],
}
```

---

## Item 2 — Rewrite `_LOCAL_ANALYSIS_SYSTEM` (routes/debate.py)

Replace the existing system prompt with one that:
1. Instructs the model on SELL/TRIM criteria
2. Defines the simplified 5-driver taxonomy
3. Gives clear price-direction rules for exits (stop ABOVE entry for SELL/TRIM)
4. Keeps entry (BUY/TOP_UP) instructions unchanged

```python
_LOCAL_ANALYSIS_SYSTEM = """\
You are a conservative ASX equity analyst. Analyse the portfolio context and output
structured trading recommendations as JSON.

=== ACTIONS ===
BUY      — new position (watchlist entry or entirely new holding)
TOP_UP   — add to an EXISTING holding that is underweight with a strong thesis
HOLD     — keep existing holding, no change needed (use confidence=0)
SELL     — close a FULL existing position (multi-factor deterioration)
TRIM     — reduce an existing holding by 25–50% (overweight or thesis weakening)

=== ENTRY RULES (BUY / TOP_UP) ===
- priceRange: [lo, hi] — limit entry range
- target: ABOVE priceRange[1] — where thesis is proven
- stopLoss: BELOW priceRange[0] — where thesis is wrong
- confidence: 0.62 minimum. 0.70 = moderate conviction, 0.80 = strong.
- Only recommend when ≥ 2 independent factors align (earnings, macro, valuation, technicals).

=== EXIT RULES (SELL / TRIM) ===
- priceRange: [lo, hi] — limit sell range near current price
- target: BELOW priceRange[0] — price that confirms the exit was correct (further decline)
- stopLoss: ABOVE priceRange[1] — price that would INVALIDATE the exit thesis (stock recovers)
- stopLoss MUST be ABOVE priceRange[1] for SELL/TRIM. Never set stop below entry on an exit.
- primary_driver (required — pick ONE):
    thesis_broken   — fundamental case has failed (earnings miss, sector headwind confirmed)
    stop_triggered  — price has reached or is very close to the stop-loss level
    target_reached  — price has hit the original profit target; exit to lock in gains
    time_stop       — held ≥ 2× expected duration with < 5% gain; no upcoming catalyst
    risk_management — position > 15% of portfolio OR sector > 30%; size reduction only
- urgency (required):
    immediate — execute today; meaningful further risk if delayed
    routine   — within 1–3 sessions; no acute pressure
    monitor   — TRIM only; conditions forming but thesis not yet confirmed
- confidence: 0.62 minimum for SELL/TRIM. Use 0 for HOLD.

=== OUTPUT RULES ===
- Output 1–4 recommendations maximum. Prefer HOLD when uncertain.
- qty is NOT required — the quant engine calculates it after your response.
- For SELL/TRIM: primary_driver and urgency are REQUIRED fields.
- For BUY/TOP_UP: primary_driver and urgency are NOT included.
- Output only the JSON object. No preamble, no markdown fences.
"""
```

---

## Item 3 — Extend context truncation limit (routes/debate.py)

The current truncation is 4000 chars. With Sprint 47's indicator tiering, the user message
is now ~30–40% smaller for most portfolios. Raise to 6000 chars to give the model more context
for exit decisions (holdings state, unrealised P&L, stop levels are critical for SELL/TRIM).

Find:
```python
user_ctx = raw_msg[:4000]
if len(raw_msg) > 4000:
    user_ctx += "\n[...context truncated for local model...]"
```
Change to:
```python
user_ctx = raw_msg[:6000]
if len(raw_msg) > 6000:
    user_ctx += "\n[...context truncated for local model...]"
```

---

## Item 4 — Post-processing: validate SELL/TRIM from local model (routes/debate.py)

In the `quick_analysis()` function, after parsing the Ollama JSON response, add validation
for SELL/TRIM recs to ensure required fields are present and price directions are correct.
If a SELL/TRIM rec is missing `primary_driver` or `urgency`, add defaults rather than dropping it:
- Missing `primary_driver` → default to `"thesis_broken"`
- Missing `urgency` → default to `"routine"`
- SELL/TRIM stop below entry → correct to `entry * 1.03` (3% above entry as a safe default)
- Tag each rec with `_source: "local"` (already done for all recs)

Find the rec-processing loop that sets `r["_source"] = "local"` and add:
```python
for r in parsed.get("recs", []):
    r["_source"] = "local"
    action = (r.get("action") or "BUY").upper()
    if action in ("SELL", "TRIM"):
        # Ensure required exit fields
        if not r.get("primary_driver"):
            r["primary_driver"] = "thesis_broken"
        if not r.get("urgency"):
            r["urgency"] = "routine"
        # Validate stop direction: SELL/TRIM stop must be ABOVE entry
        entry = (r.get("priceRange") or [None])[0]
        stop  = r.get("stopLoss")
        if entry and stop and stop < entry:
            r["stopLoss"] = round(entry * 1.03, 4)
            r["_stopRepaired"] = True
```

---

## Item 5 — Badge for local SELL/TRIM (js/pages/recommendations.js)

The `🔒 Local` badge already shows for all recs with `_source: 'local'`. No change needed for
the badge itself.

However, find where the rec card renders `primary_driver` / `urgency` for SELL/TRIM from Claude
(search for `primary_driver` in recommendations.js). Ensure this code renders correctly for
local-model SELL/TRIM recs too — the fields are now present, just with simpler values.
If the rendering is already done generically (not conditional on `_source`), no change needed.
Just verify it.

---

## Item 6 — Update CLAUDE.md Gotcha #32 (js/CLAUDE.md)

Gotcha #32 currently says:
> `useLocalLLM` fast-path excludes SELL/TRIM. `_callLocalAnalysis()` in `claude-client.js`
> POSTs to `/api/debate/quick-analysis` which only outputs BUY/TOP_UP/HOLD.

Update to:
> `useLocalLLM` fast-path now supports SELL/TRIM with a simplified 5-driver taxonomy
> (`thesis_broken`, `stop_triggered`, `target_reached`, `time_stop`, `risk_management`).
> Secondary factors and the full 9-driver set require the Claude path. Recs show `🔒 Local` badge.
> Exit stop direction is validated post-response: SELL/TRIM stop is corrected to entry×1.03
> if the model outputs it below entry.

---

## Item 7 — Test coverage (test_app.py)

Add these tests:

```python
class TestQuickAnalysisSellTrim(unittest.TestCase):

    def test_schema_allows_sell_trim(self):
        """_SCHEMA_QUICK_ANALYSIS must include SELL and TRIM in action enum."""
        from routes.debate import _SCHEMA_QUICK_ANALYSIS
        enum = _SCHEMA_QUICK_ANALYSIS["properties"]["recs"]["items"]["properties"]["action"]["enum"]
        self.assertIn("SELL", enum)
        self.assertIn("TRIM", enum)

    def test_schema_has_exit_fields(self):
        """Schema must include primary_driver and urgency fields."""
        from routes.debate import _SCHEMA_QUICK_ANALYSIS
        props = _SCHEMA_QUICK_ANALYSIS["properties"]["recs"]["items"]["properties"]
        self.assertIn("primary_driver", props)
        self.assertIn("urgency", props)

    def test_local_system_prompt_mentions_sell_trim(self):
        """_LOCAL_ANALYSIS_SYSTEM must document SELL and TRIM actions."""
        from routes.debate import _LOCAL_ANALYSIS_SYSTEM
        self.assertIn("SELL", _LOCAL_ANALYSIS_SYSTEM)
        self.assertIn("TRIM", _LOCAL_ANALYSIS_SYSTEM)
        self.assertIn("primary_driver", _LOCAL_ANALYSIS_SYSTEM)
        self.assertIn("thesis_broken", _LOCAL_ANALYSIS_SYSTEM)

    def test_exit_stop_repair(self):
        """SELL rec with stop below entry must be repaired to entry * 1.03."""
        # Simulate the post-processing logic directly
        rec = {"action": "SELL", "priceRange": [50.0, 50.5], "stopLoss": 48.0,
               "reasoning": "test", "risks": "test", "confidence": 0.65, "ticker": "BHP"}
        entry = (rec.get("priceRange") or [None])[0]
        stop  = rec.get("stopLoss")
        if entry and stop and stop < entry:
            rec["stopLoss"] = round(entry * 1.03, 4)
            rec["_stopRepaired"] = True
        self.assertEqual(rec["stopLoss"], round(50.0 * 1.03, 4))
        self.assertTrue(rec["_stopRepaired"])

    def test_exit_default_driver_added(self):
        """SELL rec missing primary_driver must get thesis_broken default."""
        rec = {"action": "SELL", "confidence": 0.65, "ticker": "BHP",
               "reasoning": "test", "risks": "test"}
        if (rec.get("action") or "").upper() in ("SELL", "TRIM"):
            if not rec.get("primary_driver"):
                rec["primary_driver"] = "thesis_broken"
            if not rec.get("urgency"):
                rec["urgency"] = "routine"
        self.assertEqual(rec["primary_driver"], "thesis_broken")
        self.assertEqual(rec["urgency"], "routine")
```

---

## Completion checklist

1. `python test_app.py` — all tests pass including new SELL/TRIM tests
2. `npm run test:js` — all tests pass
3. `for f in js/*.js js/pages/*.js; do node --check "$f" || echo "FAIL: $f"; done`
4. Update `IMPROVEMENTS.md`: add Sprint 48 shipped section
5. Update `CLAUDE.md`: update Gotcha #32; update `routes/debate.py` endpoint table for
   `/api/debate/quick-analysis` to note SELL/TRIM support
6. Create a PR against main
