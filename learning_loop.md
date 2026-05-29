# Learning Loop — Architecture & Data Flow

**Last Updated:** May 2026 (Sprint 23 hardening)
**Status:** Phases 1–5, 7 Complete · Stages 1–4 + D1–D7 + L1–L6 + Sprint 23 improvements applied · Phase 6 & 8 Planned

The Learning Loop closes the feedback cycle between Claude's recommendations and real-world outcomes. It systematically records every AI-generated trade recommendation, links it to execution and closure data, analyses performance, and feeds compact, statistically meaningful insights back into future Claude calls.

---

## Purpose

- Provide objective measurement of Claude's (and the overall system's) edge.
- Detect prompt decay, regime mismatches, and recurring failure patterns.
- Deliver high-signal, regime-aware, time-decayed calibration feedback without breaking prompt caching.
- Distinguish between bad analysis and good-discipline losses (capital protection).
- Support continuous improvement through structured post-mortem analysis and local-model debate.

---

## Data Storage

All learning data lives in `asx_trader.db` (SQLite, WAL mode).

### `ai_learning_events` table (primary)

| Column                | Type       | Description |
|-----------------------|------------|-------------|
| `id`                  | INTEGER PK | Auto-incremented event ID |
| `ticker`              | TEXT       | ASX ticker |
| `recommendation`      | TEXT       | BUY / SELL / TRIM / TOP_UP / HOLD |
| `ai_confidence`       | REAL       | Claude's stated confidence (0–1) |
| `ensemble_confidence` | REAL       | Quant engine confidence (0–1) |
| `outcome_status`      | TEXT       | win / loss / breakeven / open / skipped |
| `realized_pnl_pct`    | REAL       | Exit P&L as % of cost basis |
| `realized_pnl_aud`    | REAL       | Exit P&L in AUD |
| `regime`              | TEXT       | Market regime at time of rec |
| `prompt_version`      | TEXT       | System prompt version |
| `was_executed`        | INTEGER    | 0/1 |
| `suggested_stop`      | REAL       | Claude's stop-loss price |
| `suggested_target`    | REAL       | Claude's target price |
| `rr_ratio`            | REAL       | Reward:risk ratio |
| `holding_period_days` | INTEGER    | Days held |
| `exit_reason`         | TEXT       | `stop_hit` / `target_hit` / `manual` / `protective_stop` / `time_exit` |
| `rationale_summary`   | TEXT       | First 400 chars of Claude's reasoning |
| `actual_entry_price`  | REAL       | Actual fill price |
| `actual_exit_price`   | REAL       | Actual exit price |
| `sector`              | TEXT       | GICS sector |
| `error_type`          | TEXT       | Comma-separated tags (loss/breakeven only) |
| `error_type_source`   | TEXT       | `'manual'` / `'auto'` / `'debated-consensus'` / `'debated-merged'` / `'debated-singleton'` / `'debated'` |
| `skill_score`              | REAL       | 0–10 analysis quality vs luck (Ollama scored) |
| `debate_summary`           | TEXT       | ≤200-char bull/bear summary stored at analysis time |
| `prompt_hash`              | TEXT       | 12-char djb2 fingerprint of prompt version + regime + date |
| `postmortem_debate`        | TEXT       | JSON blob of full adversarial debate transcript (Phase 3) |
| `entry_signals_json`       | TEXT       | JSON snapshot of live signals at rec generation time — used by postmortem and skill-score prompts (Stage 1 / D5 / D6) |
| `debate_synthesis_winner`  | TEXT       | Synthesizer verdict at analysis time: `'bull'`/`'bear'`/`'neutral'` for BUY recs, `'hold'`/`'exit'`/`'neutral'` for SELL/TRIM (Stage 4 / L6) |

> **Note on `loss_quality`:** This is a *computed property*, not a stored column. It is derived at calibration time from existing fields:
> - `exit_reason = 'protective_stop'` → **good** loss (deliberate capital defence, excluded from confidence calibration)
> - `error_type` contains `external_shock` → **good** loss (market accident, excluded from confidence calibration)
> - `error_type` contains `overconfident` or `poor_entry` → **bad** loss (model error, full weight)
> - Otherwise → **neutral**
>
> Storing it separately would require a separate Ollama call and a new column that duplicates information already in `error_type` and `exit_reason`. Deriving it is simpler, more consistent, and zero-cost.

### Supporting Tables
- `rec_history` — Every Claude recommendation + `learning_id` link to `ai_learning_events`.
- `trade_journal` — All trades (AI + manual) with `close_date`.

---

## Event Lifecycle

1. **Recommendation Generated** (`analysis.js` → `logRecsToLearningLoop()`)
   - `POST /api/learning/log` — creates partial record, returns `id`
   - Stores `rec._learningId`, persists `debate_summary`, `prompt_hash`, `entry_signals_json` (signal snapshot), `debate_synthesis_winner`

2. **Trade Executed** (`recommendations.js` → `markExecuted()`)
   - `POST /api/learning/outcome` — updates entry price, outcome fields
   - `exit_reason` auto-detected via `_detectExitReason(exitPrice, stopLoss, target)` — sets `stop_hit`/`target_hit` (±0.5% tolerance) or falls back to `manual` (Stage 1)
   - Auto-triggers `triggerPostmortem()` (fire-and-forget) for loss/breakeven outcomes (Stage 2)
   - Auto-reconciles parent BUY/TOP_UP learning events when a SELL/TRIM fully closes the position (Stage 1)

3. **Trade Closed** (`performance.js` → `syncClosedTradesToLearningLoop()`)
   - Reconciles journal against `rec_history` and patches outcome for closed trades
   - `exit_reason` also auto-detected here via `_detectExitReason()` (Stage 1)

4. **Manual Trades** — Supported via Branch B (full record creation on SELL/TRIM)

---

## Handling Market Non-Stationarity & Good Losses

**Core philosophy:** Markets change regimes. A loss from 6 months ago in a risk-off bear market should not carry the same weight as a loss from last week in the same conditions. And a disciplined stop-out that protected capital from a larger drawdown is *not* a model error — penalising it would train Claude to hold losers.

### How the system addresses this (implemented)

**1. Exponential time-decay weighting** ✅
All confidence-band, regime, sector, and decay calculations use decay-weighted win rates:
```python
weight = exp(-ln(2) × days_since_close / 45)
# Today = 1.0 · 45 days ago = 0.5 · 90 days ago = 0.25 · 6 months ago ≈ 0.1
```
Old data fades gracefully — it still contributes when sample sizes are small, but cannot dominate when fresh data exists. The default window is 90 days (extended from 60d) with a 180-day hard cap.

**2. Protective stop & external shock exclusion** ✅
Exclusion rules differ by calibration check — they are not a blanket filter:

| Where excluded | `protective_stop` | `external_shock` |
|---|---|---|
| Confidence-band calibration | ❌ Excluded | ❌ Excluded |
| Error pattern learning | ✅ If has error tags | ❌ Excluded |
| Regime / Sector / Decay / R:R | ✅ Included | ✅ Included |

Protective stops are excluded from confidence calibration regardless of tags, but contribute to error pattern learning if they carry analytical error tags (e.g. `regime_mismatch`, `poor_entry`).

- **Confidence bands**: both excluded — neither reflects model quality. One is deliberate capital protection, the other a market accident.
- **Error pattern learning**: `external_shock` excluded (nothing learnable from a black swan). `protective_stop` losses are included if tagged — a `regime_mismatch` tag on a protective stop is still a learnable signal that the trade was entered in the wrong conditions.
- **Regime/sector/strategy stats**: both included — they happened, Claude should see the full outcome picture. Excluding them would inflate the win rate and make Claude overconfident.

The count of confidence-band exclusions is shown in the block prefix as `Nexcl` so Claude knows they were filtered.

**3. Effective Sample Size (ESS) gating** ✅ *(Sprint 23)*
Raw trade count is a poor gate for stale samples. If 4 trades exist but 3 are 90 days old (weight ≈ 0.1 each) and 1 is fresh (weight = 1.0), the sample reads as 4 but is dominated entirely by the single recent trade.

All calibration sections now use Kish's ESS formula:
```
ESS = (Σwi)² / Σwi²
```
Threshold is **ESS ≥ 2.5**. Below this, the system emits a warning token rather than a confidence nudge:
```
conf 70-80%:⚠low ESS=1.6(n=4)—data too stale for reliable calibration
```
Equal-weight samples behave the same as before (4 trades, equal weights → ESS = 4.0). Stale samples are correctly gated regardless of raw count.

**3b. Regime freshness gate** ✅ (L1, now ESS-integrated)
The regime section checks ESS first. Low ESS emits:
```
⚠bullTrending:ESS=1.4(n=3)—regime data too stale for calibration
```
0 trades = silently omitted. ESS ≥ 2.5 = full decay-weighted win rate shown. This prevents a freshly-transitioned regime from inheriting the previous regime's failure patterns.

**4. Date range in calibration block** ✅
Every calibration block includes the date range and regime so Claude can contextualise the data:
```
CALIBRATION(12cls,2026-02→2026-05,bullTrending,2excl): conf 70-80%:61%WR(…)
```

**5. Regime-conditional filtering** ✅ (partial)
Calibration fetches the current regime from the request and compares same-regime historical trades. The `regime` column on each event stores the regime active at the time of the recommendation.

### Still to implement

**Skill-weighted calibration (Phase 8) — partially live**
The `_weight()` function in `_calib_compute()` already applies skill weighting:
```python
weight = time_decay × max(0.2, skill_score / 10)   # skill_score ∈ [0, 10]
```
This is live code. However, skill_score is `NULL` for events not yet scored — those fall back to weight = time_decay × 1.0 (neutral). Phase 8 is fully realised once ~20+ scored events exist and all recent events have a score; at that point the weighting has enough coverage to meaningfully differentiate luck wins from skill wins.

**Virtual outcomes / paper-trade skipped recs (deferred)**
When calibration suppresses Claude's confidence in a regime and recs are skipped, no new outcomes enter the loop — the pessimism can become self-reinforcing. The fix: track hypothetical P&L on `was_executed=0` events at their suggested entry/stop/target prices, feed those back into calibration at a discount (weight × 0.75). Deferred — requires scheduled background price-checking + new DB columns + frontend visibility.

---

## Calibration Injection

`fetchCalibrationBlock(regime, sectors, tickers)` in `analysis.js` calls `GET /api/learning/calibration?regime=X&sectors=A,B&tickers=BHP.AX,CBA.AX` after regime detection. The backend:
1. Fetches last 90 days of closed events (max 180d) — pure `_calib_compute()` function, TTL-cached 5 min (L4)
2. Applies exponential + skill-weighted decay (`weight = time_decay × max(0.2, skill_score/10)`, half-life 45d)
3. Excludes `external_shock` / `protective_stop` from confidence band calculations only
4. Only emits findings where **ESS ≥ 2.5** (Kish's formula) — replaces raw n≥3 guard (Sprint 23)
5. Low-ESS subsets emit a warning token rather than a calibration nudge (Sprint 23)
6. Warns on low-ESS same-regime data rather than silently omitting (L1 + Sprint 23)
7. Dominant error type threshold: 33% of losses, min 3 losses (L2, lowered from 40%/4)
8. Per-ticker stats: emits `per-ticker:BHP.AX:62%(Δ+14pp,ESS=3.2)✓strong` for portfolio tickers with >15pp delta vs overall WR (Stage 2 + Sprint 23)
9. Returns a block labelled with date range + regime for Claude context
10. Auto-expire (events >120 days old → `expired`) runs on write path only, not on this GET (L3)

Injected into **user message** via `__CALIBRATION_PLACEHOLDER__` — never the system prompt (preserves Anthropic's server-side prompt cache).
Target size: 30–60 tokens.

The system prompt (`js/prompts.js`, `PROMPT_VERSION='2026-05-v5'`) now includes an explicit calibration algorithm: `confidence += adj_value, clamped [0.50, 0.95]` (Stage 3). It also includes a debate-block usage rule: treat Local Debate as a second opinion, weight synthesis winner, don't anchor to it over fundamentals (Stage 3).

---

## Backend Endpoints

| Endpoint                           | Method | Description |
|------------------------------------|--------|-------------|
| `POST /api/learning/log`           | Write  | Create new event |
| `POST /api/learning/outcome`       | Write  | Update outcome, tags, exit_reason |
| `DELETE /api/learning/event/<id>`  | Write  | Hard delete |
| `GET /api/learning/stats`          | Read   | Aggregates for Learning Loop UI |
| `GET /api/learning/calibration`    | Read   | Decay-weighted, shock-excluded calibration block |
| `GET /api/learning/debate-stats`   | Read   | Per-pairing adversarial-debate breakdown (consensus/partial/diverged + concede rate) |
| `GET /api/debate/status`           | Read   | Ollama health check (60s TTL in JS) |
| `POST /api/debate`                 | Write  | Bull/Bear debate (sequential, 4h signal-hash cache) |
| `POST /api/debate/postmortem`         | Write  | Auto-tag error_type for loss/breakeven events (single model) |
| `POST /api/debate/postmortem-debate`  | Write  | Adversarial two-model debate → CONSENSUS / PARTIAL / DIVERGED |
| `POST /api/debate/adjudicate`         | Write  | Cloud adjudicator (Gemini/Groq auto-pick) scores both local models + picks winner |
| `GET  /api/debate/adjudicator-status` | Read   | Is a cloud adjudicator configured? Used by UI to enable/disable 🧑‍⚖️ button |
| `POST /api/debate/staleness`          | Write  | Freshness check for pending recs ≥ 2 days old |
| `POST /api/debate/skill`              | Write  | Score closed trade outcome quality 0–10 |

---

## Learning Loop Display Page

**Key Sections:**
- Summary cards (overall win rate, high-confidence WR, prompt version)
- Calibration accuracy table (per confidence band, decay-weighted, n<5 warnings)
- Regime performance table
- Prompt version history
- Failure Patterns (exit reason distribution + error tag counts, shock excluded)
- Recent Events table (30 most recent) — features:
  - `outcomeChip` + 🛡 badge if `protective_stop`, 🛡? button if `stop_hit` loss
  - Error tag buttons (8 tags, multi-select, auto=dashed/manual=solid border)
  - 🤖 postmortem button (loss/breakeven, re-runnable — overwrites existing tag)
  - ⚔️ adversarial debate button (loss/breakeven, user-initiated only)
  - 📜 stored-debate viewer (only shown on rows where `postmortem_debate` is non-null — opens transcript modal with no model call)
  - ⚖️ cloud adjudicator (only shown on rows with stored debate; user-initiated; scores both local models 0-10 and picks a winner via Gemini/Groq)
  - 🔬 skill score button (all closed events, re-runnable); badge when scored (green/amber/red)
  - ✕ delete button
- Debate Summaries (last 5 with stored debate_summary)
- **Debate Stats card** (per-pairing breakdown of all stored adversarial debates — total, consensus, partial, diverged, singleton, agreement %, A→B concede rate)
- Debate Engine card (primary model, opposition model, aggression, Test Debate button)

### Error Tag Reference

| Tag | Short | When to use | Calibration? |
|-----|-------|-------------|--------------|
| `overconfident` | OC | AI confidence too high for actual risk | ✅ Yes |
| `missed_catalyst` | MC | Key event not accounted for | ✅ Yes |
| `regime_mismatch` | RM | Wrong strategy for regime | ✅ Yes |
| `poor_entry` | PE | Timing/price suboptimal | ✅ Yes |
| `stop_too_tight` | ST | Normal volatility triggered stop | ✅ Yes |
| `poor_rr` | PR | R:R ratio too low from start | ✅ Yes |
| `thesis_broken` | TB | New info invalidated thesis post-entry | ✅ Yes |
| `external_shock` | ES | Black swan / unpredictable market event | ❌ Excluded |

`protective_stop` exit_reason is excluded from confidence-band calibration — it classifies how the trade was exited (deliberate capital protection), not why the thesis failed. Protective stops are excluded from confidence calibration regardless of tags, but contribute to error pattern learning if they carry analytical error tags.

---

## Internal Debate System (Ollama)

**Status:** Phases 1–5, 7 implemented. D1–D7 improvements applied May 2026.

### Implemented
- Bull/Bear pre-analysis injected into Claude user message (4h signal-hash cache, keyed on 10 signal fields including 5d/20d returns and ATR%)
- Direction-aware prompts (D7): BUY recs → bull/bear/neutral framing; SELL/TRIM recs → hold/exit/neutral framing
- Synthesizer round returns `{winner, margin, key_pivot}` — `winner` stored as `debate_synthesis_winner` in DB; included in `formatDebateBlock()` SYNTHESIS line (Stage 4 / L5 / L6)
- Extended signal set in debate prompt: `return_5d`, `return_20d`, `atr_pct`, `atr_14` added alongside existing RSI, BB%b, volume_z, OBV, ADX, SMA200 (D4)
- `entry_signals_json` injected into postmortem prompts (D5) and skill-score prompts (D6)
- Improved synthesizer JSON extraction: try full parse first, then reverse-scan for last valid `{...}` object (D2)
- Single-model post-mortem auto-tagging (`/api/debate/postmortem`) — losses/breakevens only; **auto-triggered on close** (Stage 2)
- **Adversarial two-model postmortem debate** (`/api/debate/postmortem-debate`) — user-initiated via ⚔️ button
- Entry staleness check (`/api/debate/staleness`) — banner on recs ≥ 2 days old
- Skill score (`/api/debate/skill`) — 🔬 button on all closed events
- Debate Engine UI card (primary model, **opposition model**, aggression=none/light/full, Test Debate)

### Future
- Phase 6: Calibration quality debate — local model interprets calibration band deltas ("Is this underperformance signal or noise?")
- Phase 8: Skill-weighted calibration (needs ~20+ scored events to validate weights)

### Ollama stability rules
- Bull and bear calls are **sequential** (not concurrent) to avoid VRAM spikes
- `keep_alive: "10m"` keeps model in VRAM between calls
- `num_predict` is per-endpoint: **180** for synthesizer (D1, increased from 120), **200** for postmortem/staleness (short JSON), **350** for skill score (longer reason string)
- `think: false` passed to Ollama for all JSON-output endpoints — suppresses thinking tokens that would consume the token budget before any JSON is written
- **`format_schema` (Sprint 23):** All JSON-producing Ollama calls now pass a JSON Schema via Ollama's native `format` parameter. The inference engine constrains token selection at the grammar level — valid JSON is guaranteed without relying on regex fallback parsers. Schemas: `_SCHEMA_POSTMORTEM`, `_SCHEMA_WIN_TAG`, `_SCHEMA_SYNTHESIS`, `_SCHEMA_EXIT_SYNTHESIS`, `_SCHEMA_PM_SYNTHESIS`, `_SCHEMA_SKILL`. Cloud callers (Groq/Gemini/Claude) are not affected — they receive schema guidance via prompt text.
- No retry on timeout — fail immediately, caller switches to smaller model
- Batch concurrency always 1 — Ollama queues internally; external concurrency wastes VRAM

### Model priority (Auto selection)
`preferredDebateModel()` selects from pulled models in this order:
```
qwen3.5:9b → qwen3.5:4b → qwen3:9b → qwen3:8b → qwen3:4b → qwen3:0.6b
→ gemma4 → gemma3:4b → gemma3:2b → llama3.2:3b → phi4-mini
```
Explicit user preference (saved in `state.debate.model`) overrides Auto if the model is still pulled. If the saved preference is no longer pulled, Auto silently falls back to the priority list — no error.

### Thinking model compatibility
Reasoning models (qwen3.5, qwen3, some gemma4 variants) emit `<think>…</think>` blocks before output. Two mitigations in order of priority:

1. **`think: false` API flag** (primary) — Ollama suppresses thinking tokens entirely before generation. The model outputs JSON directly. Passed on every JSON-output call. Ignored by non-thinking models.
2. **`_strip_think_tags()`** (safety net) — strips complete `<think>…</think>` blocks post-generation. Also detects unclosed `<think>` tags (model truncated mid-thought) and returns `""` so callers surface a clean error rather than attempting to parse incomplete output.

> **`/no_think` prompt suffix removed (D3):** Previously added as a text instruction at the end of every prompt. The API flag is the correct suppression mechanism — the text suffix is fragile (model may ignore it, or it may be truncated). Removed from all postmortem, staleness, skill, and challenge prompts.

If all three fail and `skill_raw` is still unparseable, the error response now includes the first 120 chars of raw output (`WARNING` logged) to assist diagnosis.

---

## Postmortem Classification — Prompt Design

### Trade summary fields sent to model
```
{recommendation} {ticker} {outcome_status}
| PnL={realized_pnl_pct}%
| hold={holding_period_days}d
| AI_conf={ai_confidence}
| RR={rr_ratio}
| entry={actual_entry_price}
| stop={suggested_stop}
| target={suggested_target}
| exit={exit_reason}
| regime={regime}
| sector={sector}
```

Plus (when available): `entry_signals_json` serialised via `_flatten_entry_signals()` (D5/D6, Sprint 23). This produces a compact flat string of the 12 most diagnostic fields:
```
[Signals] rsi=42.1 | macd_hist=-0.12 | bb%b=0.31 | vol_z=1.4σ | atr_pct=2.1% | ret5d=-1.8% | ret20d=+3.2% | adx=22.4 | score=61 | sma200=28.45 | px=31.20 | rr=2.10
```
Raw nested JSON blobs and `None`/NaN values are dropped. This reduces context window overhead and improves extraction accuracy for smaller local models (Qwen 4B, Gemma 2B). Contrast with the earlier approach of dumping all `key=value` pairs including raw arrays and metadata — which wasted ~200 tokens and confused small models.

`recommendation` (BUY/SELL/TRIM) is listed first so the model knows trade direction. Without it, the model assumes BUY for all trades and misinterprets entry prices for SELL/TRIM (e.g. calling a high entry "suboptimal" on a short where a higher entry is better).

### Exit context hints
Exit reason is translated to a factual description only — no tag suggestions:

| `exit_reason` | Hint sent to model |
|---|---|
| `stop_hit` | "The pre-set stop loss price was triggered." |
| `time_exit` | "The position was closed after the expected holding period without reaching stop or target." |
| `manual` | "The position was closed manually before reaching stop or target." |
| `protective_stop` | "The position was deliberately closed early to protect capital." |

**Why no tag suggestions?** Early versions included hints like "consider stop_too_tight or overconfident" for `stop_hit`. This caused the model to pattern-match on exit reason rather than analyse the trade, producing identical templated reasons for all manual closes, all stop_hits, etc.

---

## Adversarial Two-Model Postmortem Debate

**Endpoint:** `POST /api/debate/postmortem-debate`  
**Trigger:** ⚔️ button per row — **never automatic**. Normal 🤖 runs single-model only.  
**UI control:** Opposition model selector in Debate Engine card (`state.debate.oppositionModel`).

### Three-Phase Protocol

**Phase 1 — Independent classification**  
Model A and Model B each receive the same base prompt (same `_pm_build_prompt()` output) and classify independently. Neither sees the other's response. Runs sequentially to avoid VRAM spikes (two concurrent calls on a 16 GB machine can OOM).

**Phase 2 — Agreement check**

| Outcome | Condition | `error_type_source` | Next |
|---|---|---|---|
| SINGLETON_A | A parsed, B failed | `debated-singleton` | Done (use A) |
| SINGLETON_B | B parsed, A failed | `debated-singleton` | Done (use B) |
| CONSENSUS | Both parsed, sets identical (or both "none") | `debated-consensus` | Done |
| PARTIAL | Both parsed, non-empty intersection | `debated-merged` | Done (keep overlap) |
| DIVERGED | Both parsed, no overlap | — | Phase 3 |

If both models fail to produce parseable output, the endpoint returns an error rather than running Phase 3 on garbage.

For PARTIAL, only the *agreed* tags are kept. This is conservative — an agreed subset is higher-confidence than either model's full output.

The SINGLETON case prevents a wasteful Phase 3 debate when one model parses successfully and the other doesn't. Without this guard, the challenge round would ask the successful model to defend its real classification against an empty "none" reason from the failed model — meaningless and slow.

**Phase 3 — Neutral synthesis** *(only on full divergence)*  
Rather than asking one model to defend its position against the other (which biases toward whichever model is the "challenger"), Phase 3 runs a neutral reconciliation: both positions are presented to Model A as a third-party adjudication task.

Model A sees:
- Model A's Phase 1 tags + reason
- Model B's Phase 1 tags + reason
- The original trade summary (for reference)

The prompt asks: *produce the single best error classification by reconciling both assessments*. The model must choose which position is better-supported and explain why — it is **not** defending its own prior output.

Model A responds: `{"error_type": "TAG1,TAG2", "reason": "why this classification over the alternative, citing specific numbers"}`

`error_type_source` is `debated-synthesis` if the synthesis parsed successfully, `debated` otherwise (fallback to whichever Phase 1 result was non-empty).

> **Note:** An earlier design used a "Model A maintains or concedes" protocol with a digit-check heuristic. This was replaced with neutral synthesis because the challenger framing introduced a structural bias toward Model B's position regardless of analytical quality. The neutral synthesis gives equal weight to both positions and produces more consistent results.

### Post-classification sanity check (`_pm_sanity_check_tags`)
After all phases (and also after the single-model 🤖 path), tags are validated against the actual trade numbers and stripped if logically inconsistent:

| Tag | Stripped when |
|---|---|
| `stop_too_tight` | `\|entry − stop\| / entry > 15%` (a wide stop cannot be "tight") |
| `poor_rr`        | `rr_ratio >= 2.0` (the trade was set up with adequate reward) |

This catches model self-contradictions (e.g. a model calling a 43%-distance stop "too tight" while citing the 43% distance in its own reason). Direction-agnostic (absolute distance), so works for both BUY and SELL. Logged at INFO with the specific contradiction.

### Storage
Results are stored in:
- `error_type` — final resolved tags (post sanity-check)
- `error_type_source` — one of: `debated-consensus`, `debated-merged`, `debated-singleton`, `debated`
- `postmortem_debate` — full JSON transcript of all phases for later inspection

The transcript contains:
- `trade` — recommendation, entry/stop/target, P&L, R:R, regime, hold days, AI confidence — surfaced in the modal so users can spot direction misreads (e.g. SELL trade tagged as `poor_entry` by a model that assumed BUY)
- `phase_1` — both models' tags and reasons
- `phase_3` (optional) — `synthesis_model`, full raw response (600 chars), `final_tags`, `reason`
- `verdict`, `final_tags`

The modal is shown immediately after the debate completes and is re-openable later via the 📜 button on rows with stored transcripts.

### Model Selection
- **Primary model**: `state.debate.model` (or Auto via `preferredDebateModel()`)
- **Opposition model**: `state.debate.oppositionModel` (or auto-picks a different pulled model)
- If only one model is pulled, the ⚔️ button shows an error toast rather than starting a debate with itself

### Why user-initiated only
The divergence pattern between models is valuable but computationally expensive: up to 3 Ollama calls × model timeout. Running this automatically on every loss would block the UI for 3–5 minutes per event and keep Ollama occupied. The 🤖 button already provides fast single-model tagging; ⚔️ is for when you want a second opinion on a disputed or surprising classification.

---

## Cloud Adjudicator (Phase 4)

**Endpoint:** `POST /api/debate/adjudicate`  
**Trigger:** ⚖️ button per row — **never automatic**. Only visible on rows with stored `postmortem_debate`.  
**Provider:** User-selectable (Sprint 22). Auto-detect order: Gemini → Groq → Claude. Keys: Gemini/Groq read from `blob_store.news_settings` (same as News Scanner); Claude API key read from `settings.claude_api_key`. The ⚖️ button shows a provider picker when multiple keys are configured; fires immediately if only one is available.  
**Status check:** `GET /api/debate/adjudicator-status` returns `{available, provider, model, providers:[...]}` — `providers` lists all three with availability flags for the picker UI.

### Purpose
The local debate (Phase 1–3) can deadlock with a stubborn incumbent or both models missing the actual issue (e.g. both flagging `poor_entry` when the real problem was `overconfident` position sizing). The adjudicator brings in a larger, capable cloud model to:

1. **Score each local model's reasoning 0-10** on four criteria:
   - Did it cite specific numbers (R:R, stop distance, P&L)?
   - Is the reasoning internally consistent?
   - Are the tags well-supported by the trade data?
   - Did it interpret trade direction (BUY/SELL/TRIM) correctly?
2. **Pick a winner** (A, B, or NEITHER) and final tags.

`NEITHER` means both models missed the real issue — the adjudicator proposes its own tags.

### Storage
- `error_type` is overwritten with the adjudicator's `final_tags` (unless empty/invalid)
- `error_type_source` becomes `'adjudicated'`
- `postmortem_debate.phase_4` is appended:
  ```json
  {
    "provider":   "gemini",
    "model":      "gemini-2.0-flash",
    "winner":     "A" | "B" | "NEITHER",
    "score_a":    7.5,
    "score_b":    4.0,
    "final_tags": "stop_too_tight,poor_rr",
    "reason":     "Model A engaged with the R:R numbers; B was generic.",
    "elapsed_ms": 2840
  }
  ```

### Output validation
The adjudicator's `final_tags` go through the same `_pm_validate_tags` + `_pm_sanity_check_tags` pipeline as the local models — even a cloud model can't claim `stop_too_tight` on a 43%-wide stop.

### Why cloud and not stronger local
A 70B+ local model would need 40 GB+ VRAM and run for minutes per call. Cloud providers like Gemini Flash and Groq Llama-3.3-70B answer in 1-3 seconds per call for a few thousandths of a cent. The adjudicator is the right place to spend cloud cost — it runs on demand, on already-disputed cases.

### Classification instructions
The model is explicitly told:
- Classify the **primary reason** the trade failed
- Do **not** base the tag solely on the exit method
- Reason from P&L, holding period, confidence, R:R, entry/stop/target prices
- Cite specific numbers in the reason string
- `none` is only valid if the loss was genuinely unforeseeable with available data

### Logging
```
DEBUG  [PostMortem] raw output for event#N: <first 200 chars of model output>
INFO   [PostMortem] event#N (TICKER) → <tag> via <model> | <reason[:60]>
INFO   [PostMortem] event#N (TICKER) → none (model found no systematic error) via <model>
INFO   [PostMortem] event#N (TICKER) → INVALID tag '<tag>' via <model> — rejected. Raw: ...
INFO   [PostMortem] event#N (TICKER) → parse failure via <model> | raw: ...
```
`none` (deliberate model decision) and parse failure are now logged separately — previously both appeared as "no clear error".

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| User message for calibration + debate | Preserves Anthropic system-prompt cache |
| Exponential decay vs hard cutoff | Smooth fade; no artificial cliffs at day 60/90 |
| Derived `loss_quality` not stored | Avoids duplicate column; derived from `error_type` + `exit_reason` |
| `external_shock` excluded from confidence calibration only | Market accidents don't reflect model quality, but they happened and should show in regime stats |
| `protective_stop` excluded from confidence calibration, included in error synergy if tagged | Capital protection is not a model error; but if the trade also had a learnable tag (e.g. `regime_mismatch`), that signal should count |
| Regime freshness gate (warn, don't omit) | Thin data is itself useful context for Claude |
| Factual exit hints, no tag suggestions | Prescriptive hints cause pattern-matching on exit method, not trade analysis |
| `recommendation` first in postmortem summary | Model assumes BUY direction without it; SELL/TRIM entry analysis is inverted |
| `think: false` API flag, not just text stripping | Text stripping requires a closing `</think>` tag; truncated output has none. API-level suppression prevents thinking tokens from consuming the token budget entirely |
| `/no_think` text suffix removed | API flag is the correct suppression path; text suffix is fragile and can be overridden or ignored. Removed from all prompts (D3) |
| `num_predict=180` for synthesizer (vs 120) | Short synthesizer JSON ran into token limit at 120 when `key_pivot` was verbose; 180 prevents truncation (D1) |
| `num_predict=350` for skill (vs 200 for others) | Skill reason strings run 30–50 tokens longer than postmortem/staleness JSON; 200 caused truncation |
| Direction-aware debate prompts (D7) | SELL/TRIM recs ask "hold vs exit" not "bull vs bear" — framing matters; wrong framing produces off-target synthesis |
| `entry_signals_json` in postmortem/skill prompts (D5/D6) | Model can reason from actual signal values rather than inferring conditions from price/stop/target alone |
| Calibration TTL cache 5 min (L4) | Calibration query is CPU-heavy (Python loops over 300 rows); caching avoids re-computation on every Claude call |
| Auto-postmortem on close (Stage 2) | Removes manual ⚡ step; loss/breakeven events now classified as soon as they close, building the error pattern database faster |
| Auto-detect exit reason (Stage 1) | Eliminates `exit_reason='manual'` blanket; stop_hit/target_hit now correctly detected ±0.5% so calibration has accurate exit stats |
| Adversarial debate: user-initiated only | 3 sequential Ollama calls × up to 120s each; auto-running on every loss would block UI for minutes. 🤖 fast-path handles the common case; ⚔️ is for disputes |
| PARTIAL verdict: keep intersection only | Higher confidence than either model's full output. A tag both agreed on is stronger signal than either individual response |
| Phase 3 challenges Model A (not arbitrary) | Model A runs first and is the "incumbent"; Model B is the challenger. Incumbent defends first — this mirrors how human debates work and produces more decisive outcomes |
| Phase 3 neutral synthesis replaces challenger model | Earlier design: Model A defends vs Model B (challenger bias toward B regardless of quality). Current: both positions presented as equal inputs to a neutral reconciliation pass. More balanced and produces more consistent results |
| Sanity check after final tags determined | Catches model self-contradictions like `stop_too_tight` on a 43%-distance stop. Cheaper and more reliable than asking the model to verify its own output |
| ESS instead of raw trade count for calibration gates | Raw count misrepresents statistical power when most weights are near zero. Kish ESS = (Σwi)²/Σwi² correctly reflects a sample dominated by one fresh trade vs N equally-weighted trades. Threshold 2.5 — below this a warning token replaces a calibration nudge |
| `format_schema` for Ollama JSON calls | Engine-level constraint eliminates the regex fallback parser chain. When the schema is provided, Ollama guarantees the output is valid JSON matching the schema — `_strip_think_tags`, reverse-scanning, and field regexes are still present as defensive safety nets but will rarely trigger |
| `_flatten_entry_signals()` for prompt injection | Raw `entry_signals_json` contains ~40+ fields including NaN values, arrays, and metadata. Injecting it verbatim wastes ~200 tokens and confuses smaller models. Flattening to 12 key fields in a single line reduces overhead and improves signal extraction accuracy |
| SQLite `timeout=30` (up from 10) | Concurrent postmortem + debate + price-refresh writes can all arrive within seconds during market close. 30s gives queued writers enough time to succeed without aborting |
| Trade context block at top of debate modal | Surfaces recommendation (BUY/SELL/TRIM) and prices upfront so users can spot direction misreads. The model can still hallucinate direction in its reason, but the user sees the actual numbers |
| Phase 3 raw response shown via collapsible `<details>` | Lets users see exactly what the challenger wrote without dominating the modal. Critical for diagnosing whether the model engaged with B's points or just rubber-stamped |
| Adjudicator is user-initiated, not auto | Costs real money per call. Worth spending on disputed cases (the user explicitly clicks ⚖️) but wasteful as a default on every postmortem |
| Adjudicator output validated by same `_pm_sanity_check_tags` | Even a 70B+ cloud model can produce contradictory tags. Same validation pipeline = same guarantees |
| Provider auto-pick (Gemini > Groq) | Gemini Flash has a generous free tier and you're already using it for ASX announcements — zero extra cost in common case. Groq is the fallback because it's also free up to per-day limits |
| `risk_management_score` dropped | Redundant — `skill_score` + error tags already cover this |
| Lessons Database deferred | Needs proper design: what is a "lesson"? How injected? Until defined, premature to implement. |

---

## Implementation Notes

- **Stage 1–4 improvements (May 2026):**
  - Stage 1: `entry_signals_json` + `debate_synthesis_winner` columns; `_detectExitReason()` auto-detects stop/target hits; parent BUY reconcile on full position close
  - Stage 2: auto-postmortem on loss/breakeven close; per-ticker calibration stats via `tickers` param
  - Stage 3: explicit calibration algorithm + debate-block usage rule in system prompt; `PROMPT_VERSION='2026-05-v5'`
  - Stage 4: synthesizer returns `{winner, margin, key_pivot}`; stored in DB and shown in SYNTHESIS line
- **D1–D7 debate improvements (May 2026):** synthesizer `num_predict` 120→180 (D1); reversed JSON scan (D2); `/no_think` suffix removed (D3); 5d/20d/ATR signals in debate + hash (D4); `entry_signals_json` in postmortem/skill prompts (D5/D6); direction-aware prompts for SELL/TRIM (D7)
- **L1–L6 learning improvements (May 2026):** regime warning skips 0 trades (L1); error-type threshold 40%→33%, min losses 4→3 (L2); auto-expire moved to write path only (L3); `_calib_compute()` pure function + 5-min TTL cache (L4); synthesis winner in `buildDebateSummary` (L5); `debate_synthesis_winner` logged from JS (L6)
- **Sprint 23 hardening (May 2026):**
  - **Ollama structured outputs:** `format_schema` param added to `_call_ollama`; all 6 JSON-producing Ollama endpoints now pass a schema object; Ollama constrains token generation at grammar level
  - **ESS calibration gates:** `_ess(subset)` helper added to `_calib_compute()`; all `n≥3` raw count guards replaced with `ESS≥2.5`; low-ESS subsets emit warning tokens instead of confidence nudges; ESS values shown in calibration block output
  - **SQLite timeout:** `sqlite3.connect(timeout=10)` → `timeout=30` in `db.py`
  - **Signal flattening:** `_flatten_entry_signals(json_str)` helper; 12 key diagnostic fields; compact pipe-separated format; replaces all raw `", ".join(k=v)` patterns in postmortem, postmortem-debate, and skill endpoints
  - **Phase 3 corrected in docs:** was documenting old "maintains/concedes + digit check" protocol; current code is neutral synthesis since the challenger-bias redesign; doc now accurately reflects the implementation
  - **Cloud adjudicator provider picker (Sprint 22):** user can select Gemini, Groq, or Claude API explicitly; auto-detect still available; provider picker modal shown when multiple keys are configured
- **Tag button HTML fix (May 2026):** `JSON.stringify()` double-quotes broke `onclick` attribute parsing. Fixed with `.replace(/"/g, '&quot;')`.
- **Calibration default window:** 90d default, 180d hard cap — more data for decay weighting to work with.
- **Protective stop UX:** 🛡? button only shows on `stop_hit` loss/breakeven rows. Clicking sets `exit_reason = 'protective_stop'` via `POST /api/learning/outcome`. Green 🛡 badge confirms exclusion from confidence calibration.
- **Calibration block format:** `CALIBRATION(Ncls,YYYY-MM→YYYY-MM,regime,Nexcl): …` — `Nexcl` is omitted when zero.
- **Staleness banner:** renders with spinner immediately on page load for old recs; Ollama fills it async without page reload.
- **Skill score badge colours:** green ≥7 · amber 4–6.9 · red <4.
- **Ollama 404 error:** now surfaces `"Model not found — run: ollama pull <model>"` with Ollama's own error body, instead of the opaque `"Ollama HTTP 404"`.
- **`qwen3.5:9b` is a valid Ollama model** (confirmed). It is a thinking/reasoning model — `think: false` and `/no_think` both apply. Works for all JSON endpoints after the thinking-model fixes.
- **Shared postmortem helpers** (`_pm_build_summary`, `_pm_exit_hint`, `_pm_build_prompt`, `_pm_validate_tags`, `_pm_parse`): extracted before both postmortem endpoints so single-model and adversarial debate use identical trade summaries and prompts. This ensures Phase 1 of the adversarial debate is a fair comparison — both models see exactly what 🤖 would have seen.
- **`_pm_validate_tags()`**: stand-alone validator (no JSON roundtrip). Splits comma-separated tags, validates each against `VALID_PM_TYPES`, and strips `none` when mixed with real tags (mutually exclusive).
- **`error_type_source` values for adversarial debate**: `debated-consensus` (sets identical), `debated-merged` (overlap kept), `debated-singleton` (only one model parsed), `debated` (Phase 3 — one model maintained or conceded). These are distinct from `'auto'` (single 🤖 run) and `'manual'` (user button clicks).
- **Debate transcript modal**: shown immediately after ⚔️ completes, before the page re-renders. The transcript persists in `postmortem_debate` column for later inspection. The modal shows Phase 1 tags+reason per model, Phase 3 maintain/concede decision, final tag, and timing.
- **Per-phase logging**: each phase logs separate INFO lines with timing — `Phase 1A — qwen3.5:9b…` / `Phase 1A done (4231ms)`. Lets you tail `asx_server.log` to watch a debate progress without polling.
- **Stored-debate viewer (📜)**: rows where `postmortem_debate IS NOT NULL` get a 📜 button next to ⚔️. Click opens the same modal used after a fresh run, with a `STORED` badge in the header. The data comes from an in-memory cache (`_learningEventsById`) populated by `_renderLearningContent` — no extra HTTP round-trip. ⚔️ still triggers a fresh debate that overwrites the stored transcript.
- **Modal ESC-to-close**: keydown listener attached on modal mount, removed via MutationObserver when the modal element is detached (handles all three close paths: ✕ button, click-outside, ESC).
- **Debate Stats card** (`GET /api/learning/debate-stats`): aggregates all stored `postmortem_debate` JSON blobs by `(model_a, model_b)` pair. Counts verdicts and computes `concede_rate = concedes_in_phase_3 / total_diverged`. High Agree% with low A→B = healthy pair; low Agree% with high A→B = primary model is weaker than opposition (consider swapping).

---

## Next Milestones

1. Accumulate ~20+ `skill_score` values — skill-weighted calibration formula is already live; full coverage needed for it to differentiate meaningfully (Phase 8)
2. Phase 6: Calibration quality debate card (local model interprets calibration band deltas)
3. Virtual outcomes for skipped recs — paper-trade `was_executed=0` events to break potential pessimism loops (deferred Sprint)
4. Structured Trade Checklist UI form (currently documented as reference only)
