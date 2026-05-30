# Learning Loop — Critics & Adjudicator Design

**Last Updated:** May 2026 (Sprint 27)

This document captures the design rationale for the adversarial critique system: the two-model postmortem debate, blind cloud adjudicator, and the quality safeguards added across Sprints 22–24.

---

## Why An Adversarial System?

A single Ollama model tagging a closed trade's error type will produce pattern-matched outputs — if the trade hit its stop, the model defaults to `stop_too_tight`, regardless of whether the stop was actually well-placed. Adding a second model with an opposing brief surfaces the cases where the single-model classification is weakly supported.

Three scenarios where critics add value:

1. **Consensus** — both models agree independently. High confidence in the tag.
2. **Partial overlap** — the agreed subset is stronger signal than either full output.
3. **Divergence** — the disagreement itself is informative. A neutral synthesis must resolve it.

The adjudicator adds a fourth check: a larger, more capable cloud model scores both local models' reasoning quality and can overrule both when neither engaged with the actual numbers.

---

## Three-Phase Protocol

### Phase 1 — Independent classification
Both models see the same `_pm_build_prompt()` output. Neither sees the other's response. Sequential (not parallel) to avoid VRAM contention.

### Phase 2 — Agreement check

| Outcome | Condition | `error_type_source` |
|---|---|---|
| SINGLETON | One model parsed, one failed | `debated-singleton` (use the one that parsed) |
| CONSENSUS | Both identical (or both "none") | `debated-consensus` |
| PARTIAL | Non-empty intersection | `debated-merged` (keep overlap only) |
| DIVERGED | No overlap | → Phase 3 |

### Phase 3 — Neutral synthesis (diverged only)
Both positions presented to Model A as a third-party adjudication. Model A produces the best reconciliation — it is **not defending its prior output**. Source becomes `debated-synthesis`.

---

## Cloud Adjudicator (Phase 4) — `POST /api/debate/adjudicate`

Scores each local model 0–10 on four criteria:
- Did it cite specific numbers (R:R, stop distance, P&L)?
- Is the reasoning internally consistent?
- Are the tags well-supported by the trade data?
- Did it interpret trade direction (BUY/SELL/TRIM) correctly?

Picks a winner (A / B / NEITHER). NEITHER = both missed; adjudicator proposes its own tags.

Provider auto-detect order: Gemini → Groq → Claude. Provider picker shown when multiple keys configured (Sprint 22).

### Blind Adjudication (Sprint 24)

Before building the adjudicator prompt, the server randomly assigns aliases:

```
blind_map = {"A": "B", "B": "A"}   # swapped
alias_a = "Analyst Beta"            # shown to cloud model for model_a
alias_b = "Analyst Alpha"           # shown to cloud model for model_b
```

Score fields returned as `score_alpha`/`score_beta` — un-swapped back to canonical `score_a`/`score_b` before storage. Winner alias translated via `blind_map` to `"A"`/`"B"`/`"NEITHER"`.

**Why:** Gemini Flash and Groq Llama-3.3-70B have been observed preferring `qwen3.5:9b` over `gemma3:4b` by model family name alone, independent of reasoning quality. Alias assignment removes this halo effect.

`blind_swap`, `alias_a`, and `alias_b` stored in `phase_4` transcript for audit.

---

## Sanity Checks (`_pm_sanity_check_tags`)

Applied after every classification path (single model, consensus, synthesis, adjudicator):

| Tag | Stripped when |
|---|---|
| `stop_too_tight` | `|entry − stop| / entry > 15%` |
| `poor_rr` | `rr_ratio >= 2.0` |

Catches self-contradictions (e.g. model labels a 43%-distance stop as `stop_too_tight` while citing the distance in its own reason). Direction-agnostic (absolute distance).

---

## JS Priority Queue (Sprint 24)

`_oqEnqueue(fn, priority)` in `debate-client.js` — single-concurrency drain.

| Priority | Calls |
|---|---|
| HIGH | User-initiated: `fetchDebate`, manual `fetchPostmortemDebate` button |
| LOW | Auto-triggered: `triggerPostmortem`, `fetchSkillScore`, `triggerCalibQualityIfStale` |

HIGH tasks splice before the first queued LOW task. A running call is never interrupted. Prevents a burst of auto-postmortems (fired on trade close) from blocking user's next manual debate for several minutes.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Neutral synthesis (Phase 3), not challenger framing | Challenger framing biases toward the opposition model regardless of quality. Equal input → more consistent results |
| PARTIAL: keep intersection only | Agreed subset is higher confidence than either full output |
| SINGLETON: skip Phase 3 | Asking the successful model to debate an empty "none" is meaningless and wastes Ollama time |
| Phase 4 user-initiated only | Costs real cloud API calls. Worth spending on disputed/surprising cases, not as a default |
| Blind aliases | Name-based halo effect observed empirically. Random alias assignment removes it |
| Same `_pm_sanity_check_tags` for cloud output | Even 70B+ models produce contradictory tags. Same pipeline = same guarantees |
| `think: false` + `format_schema` | Two independent suppression mechanisms for thinking models. Grammar-level JSON constraint eliminates regex fallback chains |
