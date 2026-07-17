# Eval Harness — Layer 1 (deterministic)

Replays **frozen model outputs** through the real deterministic post-processing
(parser → validator → regime gate) and asserts pipeline **invariants**. Catches a
prompt/model regression (a mis-tagged driver, a panic-day BUY, a qty leak) in
seconds instead of via the 30-day outcome loop. See `EVAL_AND_MODEL_CALIBRATION_PLAN.md`
Part A.

- **Run:** `npm run eval` (or it runs as part of `npm run test:js` — auto-collected).
- **No API cost, no network.** Layer 2 (live-model behavioral checks) is separate and
  not built yet.

## Add a fixture

Drop a JSON file in `fixtures/`. The global-invariant block auto-discovers it.

```jsonc
{
  "name": "short-descriptive-name",
  "description": "what run this is + what it should exercise",
  "source": "ai_call_log id=NN",        // where it came from
  "regime": "sideways",
  "holdings": {                          // ground-truth ctx for validator secondary-tag checks
    "CBA": { "weightPct": 5.9, "sectorWeightPct": 11.0, "unrealisedPnl": 932.25, "daysHeld": 336 }
  },
  "rawResponse": "<the model's JSON output, as a string>",
  "expect": {
    "parses": true,
    "allRecsStructurallyUsable": true,
    "noDuplicateActionableTickers": true,
    "flaggedByValidator": ["CBA"]        // tickers validateRec must reject (valid:false)
  }
}
```

**Bootstrap from a real run** (`ai_call_log` stores every call's `response_text`):

```bash
python -c "import sqlite3,json,io; \
c=sqlite3.connect('asx_trader.db').cursor(); \
c.execute('SELECT response_text FROM ai_call_log WHERE id=NN'); \
raw=c.fetchone()[0]; \
json.dump({'name':'...','regime':'...','holdings':{},'expect':{'parses':True,'allRecsStructurallyUsable':True,'noDuplicateActionableTickers':True,'flaggedByValidator':[]},'rawResponse':raw}, \
io.open('tests/eval/fixtures/NAME.json','w',encoding='utf-8'), ensure_ascii=False, indent=2)"
```

Then hand-write the `expect` invariants for what that run *should* satisfy — invariants,
not golden-string matches (which break on every legitimate wording change).

## What's asserted

- **Global (every fixture):** parses to `{recs}`; every rec has a valid ticker + known
  action; no duplicate actionable tickers; each `flaggedByValidator` ticker fails
  `validateRec`; every HOLD passes the validator (never spuriously dropped).
- **Regime gate:** panic hard-blocks a BUY (`qty=0`, `_regimeBlocked`); non-panic never
  zero-blocks.
- **Sizing leak:** a `qty=0` actionable rec never validates clean.
