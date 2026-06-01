# Learning Loop — Gap Analysis & Next Improvements

Review of the Sprint 29 architecture. The system is mature. This document
identifies genuine gaps rather than theoretical additions.

---

## What's Genuinely Strong in Sprint 29

Before the gaps: a few things worth naming because they're non-obvious and
correct.

**Blind adjudication with alias swap.** The `blind_map` + `alias_a`/`alias_b`
storage for audit is exactly right. Most people implement blind evaluation
without storing the proof that it was actually done.

**Phase 6 statistical hallucination guard.** Pre-computing Z-scores and
presenting `p_noise` as an immutable fact before the model runs is the right
architectural choice. Small models inventing causal narratives for noise is a
real failure mode and you've closed it.

**`recommendation` first in postmortem summary.** This is the kind of thing you
only learn from watching a model misinterpret SELL trades as BUY. The fix is
documented and justified.

**SELL/TRIM generation-time tagging rationale.** "Post-hoc LLM tagging creates
self-justification bias" is correct and the design decision is sound. Most
systems don't think about this.

**Combined skill + success-tag call (Sprint 28).** One Ollama round-trip for
two tasks — correct. The queue depth reduction is real.

---

## Gap 1 — Virtual Outcomes (Conservatism Counterbalance)

**Status in doc:** "deferred — requires scheduled background price-checking +
new DB columns + frontend visibility"

**Why this is the most important missing piece:**

The doc itself identifies the failure mode: *"When calibration suppresses
Claude's confidence in a regime and recs are skipped, no new outcomes enter
the loop — the pessimism can become self-reinforcing."*

This is not theoretical. It is a structural flaw in any calibration-only
feedback loop. The system learns to reject trades but has no mechanism to
learn that it's rejecting too many. Without this, the calibration signal is
one-sided — only outcomes from executed trades count. A system trained only on
executed trades will progressively tighten its own entry criteria until it
issues almost no recs at all, while calling this "improved calibration."

**What's needed:**

A `rejected_setups` table tracking tickers that passed pre-filter, appeared in
Claude's output with a confidence score, but were *not executed* — either
because confidence fell below `minConfidence`, or because the regime gate
blocked them, or because anti-churn rejected them.

After `hold_window_days` (typically 10), a nightly yfinance job evaluates what
would have happened: did the price hit the suggested target before hitting the
suggested stop? The `shadow_outcome` field stores the result.

When the rolling 45-day `would_have_won` rate on rejected setups exceeds ~35%,
inject a one-line conservatism warning into the calibration block:

```
CONSERVATISM(45d): 41% of low-conf rejections would have hit target (n=22).
Confidence threshold may be too restrictive.
```

This is the counterweight to the existing calibration evidence. Claude sees
both sides: "your confident calls hit at 52% not 75%" *and* "your rejected
calls would have hit at 41%". The model can weigh both.

**Implementation estimate:** New table + nightly job + one endpoint + one
calibration block line. Medium effort. High impact on long-term system health.

---

## Gap 2 — Skill Scorer Validation Gate for Phase 8

**Status in doc:** "Phase 8 fully realised once ~20+ scored events exist; the
formula is already live (Sprint 24)"

**The problem:**

Raw count is the wrong gate. With 20 events, you don't know if the *scorer
itself* is well-calibrated. If Ollama systematically rates stop-hits as
low-skill (because they "look like failures") regardless of whether the
original signal was correct, Phase 8 will amplify that bias directly into
calibration weights.

The formula `sf = max(0.2, min(1.8, skill_score / 5.0))` multiplies by up to
1.8 for high-skill trades. If those high-skill scores don't actually correlate
with better trade outcomes, you're amplifying noise.

**What's needed — three validation checks before Phase 8 activates:**

1. **Agreement rate ≥ 70%:** A sample of ~30 scored events reviewed manually.
   Ollama's score is within 1.5 points of your manual assessment at least 70%
   of the time.

2. **Spearman rank correlation ≥ 0.5:** The *ordering* of Ollama's scores
   broadly matches the ordering of yours. A model that gives 8s to bad trades
   and 4s to good ones fails this even if the mean is right.

3. **Outcome correlation:** Trades scored ≥7 by Ollama should have measurably
   better risk-adjusted P&L than trades scored ≤4. If high-skill scores don't
   predict better outcomes, the scorer isn't measuring what it claims.

A `skill_scorer_validation` table and a weekly "Skill Scorer Audit" UI card
(5 random unreviewed scored events per week, agree/disagree buttons) closes
this gap without much effort.

The Phase 8 gate in `_weight()` becomes:

```python
phase8_ready = (n_reviewed >= 30 and
                agreement_rate >= 0.70 and
                spearman_r >= 0.50 and
                high_skill_pnl > low_skill_pnl)
sf = max(0.2, min(1.8, skill_score / 5.0)) if (phase8_ready and skill_score) else 1.0
```

Until then, all scored events use `sf = 1.0` — the formula is live but the
weighting is neutral.

---

## Gap 3 — Sell Tag Outcome Tracking

**Status in doc:** Sprint 29 added SELL/TRIM tagging at generation time.
The tags are stored. The doc says they're rendered in the UI and logged to
the backend.

**What's missing:**

The tags exist but aren't yet *closing the loop*. The system records
`sell_primary_driver = 'thesis_broken'` but never answers: "when Claude tags
`thesis_broken`, does the price actually keep falling?"

**Three analytics queries that unlock real value:**

```sql
-- 1. Do primary drivers predict continued price movement?
SELECT sell_primary_driver,
       COUNT(*) as n,
       AVG(CASE WHEN price_30d_after_sell < sell_price THEN 1.0 ELSE 0.0 END)
           as kept_falling_rate,
       AVG((price_30d_after_sell - sell_price) / sell_price) as avg_30d_change
FROM rec_history
WHERE action IN ('SELL', 'TRIM')
  AND price_30d_after_sell IS NOT NULL
GROUP BY sell_primary_driver
HAVING n >= 3;

-- 2. Is time_stop cutting winners?
-- If kept_falling_rate < 35% for time_stop, Claude is exiting too early

-- 3. Is better_opportunity actually better?
-- Cross-check: did the alternative ticker outperform the sold name?
SELECT rh.sell_primary_driver,
       rh.alternative_ticker,
       COUNT(*) as n,
       AVG(alt.return_30d - sold.return_30d) as avg_alpha
FROM rec_history rh
JOIN price_data alt ON alt.ticker = rh.alternative_ticker
JOIN price_data sold ON sold.ticker = rh.ticker
WHERE rh.action = 'SELL'
  AND rh.sell_primary_driver = 'better_opportunity'
GROUP BY rh.sell_primary_driver;
```

**What to build:**

1. A nightly job that fetches `price_30d_after_sell` for closed SELL/TRIM recs
   (same yfinance pattern as the virtual outcomes job).

2. A "Sell Tag Validation" card on the Learning Loop page showing per-driver
   stats once n ≥ 3 per driver.

3. An injection into the calibration block when a driver is underperforming:
   ```
   SELL TAG: time_stop(n=11) kept_falling=36%→CUTTING WINNERS; review hold window.
   ```

This closes the sell-tag loop the same way calibration closes the confidence
loop. Without it, the tags are labelling data for later but providing no
feedback signal.

---

## Gap 4 — ATR-Based Debate Cache Invalidation

**Status in doc:** "4h signal-hash cache, keyed on 10 signal fields including
5d/20d returns and ATR%"

**The problem:**

The cache key is based on signal *values* at debate time, not signal *movement*
since debate time. A stock at BB lower band at 10am with ADX 22 will have the
same hash whether it's moved 0.2 ATRs or 1.8 ATRs by 1pm. The cache key
doesn't capture intraday movement.

A debate run at 10am arguing for a mean-reversion entry can be served at 1pm
after the stock has moved 1.5 ATRs away from the setup. The bull case is now
arguing for an entry that no longer exists.

**Fix:**

When checking the cache for freshness, compare current price against
`price_at_debate` (stored when the debate is cached):

```python
debate_cache[key] = {
    'bull': ..., 'bear': ..., 'synthesis': ...,
    'cached_at': now,
    'price_at_debate': signal_data['current_price'],
    'atr_at_debate': signal_data['atr_14'],
}

# On cache hit:
price_move = abs(current_price - cached['price_at_debate'])
move_in_atrs = price_move / cached['atr_at_debate']
if move_in_atrs > 1.0:
    invalidate_cache(key)  # stale
```

Threshold of 1.0 ATR is a starting point. Track cache hit/miss rate — healthy
range is ~50–70% hits. Below 50% → loosen to 1.5 ATR. Above 80% → tighten to
0.7 ATR.

**Effort:** Small change to `debate-client.js` (or the debate route). High
relevance during volatile sessions.

---

## Gap 5 — Prompt Version Regression Detection

**Status in doc:** `prompt_version` and `prompt_hash` stored on every event.
Version history shown in the UI with Δ vs prev column.

**What's missing:**

The Δ column is manually read. There's no automated alert when a prompt change
is associated with a hit-rate regression. If version v6 drops 13pp vs v5, you'd
only notice if you happened to look at the table at the right time with enough
closed events in both versions.

**Fix:**

In `GET /api/learning/stats`, add a `prompt_regression` field computed nightly:

```python
def _check_prompt_regression(conn, min_n=10, days=30):
    rows = get_version_stats(conn, days)
    if len(rows) < 2: return None

    current = rows[0]  # newest version
    prior   = rows[1]

    if current['n_closed'] < min_n or prior['n_closed'] < min_n:
        return None

    import math
    se = math.sqrt(0.25 / current['n_closed'])  # binomial SE under 50/50
    hit_rate_drop = prior['hit_rate'] - current['hit_rate']

    if hit_rate_drop > se:  # 1 SE threshold — early warning
        return {
            'current_version': current['version'],
            'prior_version': prior['version'],
            'hit_rate_drop': round(hit_rate_drop, 3),
            'se': round(se, 3),
            'significant': hit_rate_drop > 2 * se,  # 2 SE = ~95% confidence
        }
    return None
```

Surface as a banner on the Learning Loop page when triggered. Show both the
drop *and* the SE — a 13pp drop with SE=14pp is borderline; a 13pp drop with
SE=5pp is significant. The user makes the call.

Set 1 SE (not 2) as the alert threshold — you want early warnings, not
post-damage confirmations. The SE display prevents false alarms from being acted
on.

---

## Gap 6 — Ollama Tag Spot-Check Accuracy

**Status in doc:** `error_type_source` distinguishes auto/manual/debated tags.
The adversarial debate catches disagreements between two models. But the bulk
of auto-tagged events (🤖) go uninspected.

**The hidden coupling:**

Claude's calibration feedback (error pattern nudges: "dominant error:
`overconfident` in 5/12 losses") is partially built on Ollama's auto-tags.
If Ollama systematically mis-tags `poor_entry` as `overconfident`, Claude's
view of what's failing is distorted — and the calibration block becomes subtly
wrong.

The adversarial debate catches some of this, but only on trades you choose to
challenge with ⚔️. The mass of auto-tagged events goes un-audited.

**Fix:**

A `tag_reviews` table and a weekly spot-check queue (5 random unreviewed
auto-tagged events per week, show Ollama's tag + reason, agree/disagree/retag
buttons).

Track agreement rate over time:

- ≥75% close agreement: scorer reliable, light cadence sufficient
- 60–75%: acceptable, watch for drift
- <60%: unreliable — exclude `error_type_source='auto'` events from error
  pattern learning section of the calibration block until the postmortem prompt
  is fixed

Surface as a small "Tag Accuracy" line in the Debate Engine card:
```
🏷 Auto-tag accuracy (n=28 reviewed): 79% — Good
```

**Effort:** Low. A new table, two endpoints, and a small UI component.

---

## Gap 7 — `better_opportunity` Alternative Ticker Cross-Check

**Status in doc:** Sprint 29 requires `alternativeTicker` in the rationale
when `better_opportunity` is the primary driver. The ticker is stored.

**What's missing:**

The cross-check itself. Requiring the ticker is the right foundation, but
without comparing subsequent performance there's no feedback signal. Claude can
name `CBA.AX` as the better opportunity every time without any accountability
mechanism.

**What to build:**

The nightly price-fetch job (from Gap 3) should also fetch `return_30d` for
the `alternative_ticker` alongside the sold ticker. Then:

```sql
SELECT
  rh.ticker as sold,
  rh.alternative_ticker,
  AVG(alt_ret - sold_ret) as avg_alpha_of_switch,
  COUNT(*) as n,
  SUM(CASE WHEN alt_ret > sold_ret THEN 1 ELSE 0 END) as times_actually_better
FROM ...
WHERE sell_primary_driver = 'better_opportunity'
GROUP BY ...
```

If `times_actually_better / n < 50%`, the `better_opportunity` tag is
functioning as a rationalisation rather than a prediction. Surface in the
Sell Tag Validation card (Gap 3) and optionally inject a calibration note:

```
SELL TAG: better_opportunity(n=8) — alternative outperformed only 38% of the time.
Tag reliability: low.
```

This is the most important outcome tracking for the sell taxonomy because
`better_opportunity` is the tag most likely to be used as a cover for
arbitrary exits.

---

## Gap 8 — Calibration Block Token Budget Management

**Status in doc:** "Target size: 30–60 tokens"

**The emerging problem:**

Sprint 27 added success tag nudges. Sprint 28 added regime-specific decay
interpretation. Sprint 29 added conservatism warning (in Gap 1 above when
implemented). Phase 8 skill commentary is coming. The block will regularly
exceed 60 tokens without a priority-ordered truncation system.

When the block is silently truncated mid-sentence by hitting the token ceiling,
it produces malformed instructions. The model acts on partial information while
having no indication anything was cut.

**Fix:**

Priority-ordered assembly with explicit truncation logging:

```python
CEILING_TOKENS = 100  # hard ceiling

# Assemble in priority order — drop from bottom when over budget
parts = [
    p1_header,          # always: date, regime, n, excl
    p2_conf_bands,      # if signal (|delta| > 5pp, ESS ≥ 2.5)
    p3_regime_warning,  # if ESS < 2.5 in target regime
    p4_skill_insight,   # Phase 8 only, when active
    p5_conservatism,    # Gap 1, when over-rejection detected
    p6_sell_tag,        # Gap 3, when driver underperforming
    p7_success_nudge,   # Sprint 27
    p8_per_ticker,      # Stage 2, >15pp delta tickers
]

assembled = ' '.join(p for p in parts if p)
while _count_tokens(assembled) > CEILING_TOKENS and len(parts) > 1:
    dropped = parts.pop()
    assembled = ' '.join(p for p in parts if p)
    logger.debug(f"[Calibration] dropped p{len(parts)+1} to fit token budget")

assert _count_tokens(assembled) <= 150, "Calibration block exceeded hard ceiling"
```

The 150-token hard ceiling is the safety net. The 100-token target is the
operating budget. Drop from lowest priority upward; never silently truncate
mid-string.

---

## Gap 9 — Lessons Database

**Status in doc:** "deferred — Needs proper design: what is a 'lesson'? How
injected? Until defined, premature to implement."

This is the one item I'd push back on deferring. The infrastructure is
already there: you have `adj udicated` tags, per-ticker calibration, regime
performance, and sell tag outcomes. A lesson is just a persistent text rule
with a scope.

**Minimal viable design:**

```sql
CREATE TABLE trading_lessons (
    id          INTEGER PRIMARY KEY,
    lesson_text TEXT NOT NULL,
    scope_ticker  TEXT,    -- e.g. 'CBA.AX' (null = any ticker)
    scope_sector  TEXT,    -- e.g. 'Financials' (null = any sector)
    scope_regime  TEXT,    -- e.g. 'riskOff' (null = any regime)
    source      TEXT,      -- 'adjudicated' | 'manual' | 'sell_tag'
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

A lesson is injected into the Claude user message when scope matches:

```
=== LESSONS FOR THIS ANALYSIS ===
[CBA.AX] Stop too tight on large-cap banks during earnings season — widen to 2.5×ATR minimum.
[riskOff] mean_reversion entries in riskOff regime have 47% hit rate — require confidence ≥0.75.
```

**How lessons are created:**

1. **Auto (from adjudicator):** After Phase 4 completes, the adjudicator
   already writes a `reason` string. Pass it to a trivial extraction call:
   "distil this reasoning into a one-sentence rule for future trades." Store
   with `source='adjudicated'`, scoped to the ticker and regime of the event.

2. **Auto (from sell tag outcomes):** When a sell driver shows consistently
   poor prediction (e.g. `time_stop` kept_falling < 35%), auto-generate:
   "time_stop exits have low predictive validity — consider extending hold
   window by 3–5 days before triggering."

3. **Manual:** The existing "Add Lesson" UI on the Learning Loop page (which
   you already have from the learning page rendered content).

**Injection:** `GET /api/learning/lessons?ticker=X&sector=Y&regime=Z` returns
matching lessons sorted by recency. Injected into the user message alongside
the calibration block. Each lesson is ~15–25 tokens. Cap at 3–4 injected
lessons to avoid crowding the calibration block.

This is the highest-value deferred item because it converts individual postmortem
findings into reusable forward-looking rules — which is exactly what a human
trader would do after reviewing their journal.

---

## Not Worth Building Right Now

Worth being explicit about what's *not* on this list:

**More debate phases/agents.** The three-phase protocol (independent → agreement
check → neutral synthesis) + cloud adjudicator covers the space well. Adding
a fourth local phase or a second adjudicator adds cost with diminishing returns.

**Per-ticker calibration bands.** Sample sizes will never support reliable
per-ticker confidence calibration. The per-ticker *delta* metric (Stage 2) is
the right granularity.

**Replacing Ollama with Claude for postmortems.** Local postmortems on closed
trades are the right use of Ollama. The cost of running them through Claude
would be significant, and the latency on close events would be noticeable.

**Changing the exponential decay formula.** The volatility-adaptive half-life
(Sprint 25) already handles the valid objection to a fixed formula. No further
changes needed.

**Adding more error tags.** 8 tags is the right density. More tags fragment
the sample into sub-groups too small for ESS gating.

---

## Priority Order

| # | Gap | Impact | Effort | When |
|---|-----|--------|--------|------|
| 1 | Virtual outcomes (conservatism counterbalance) | Very High | Medium | Sprint 30 |
| 9 | Lessons database (minimal design above) | High | Low–Medium | Sprint 30 |
| 3 | Sell tag outcome tracking (30d follow-up) | High | Medium | Sprint 30 |
| 2 | Skill scorer validation gate | Medium | Low | Sprint 30 |
| 5 | Prompt version regression detector | Medium | Low | Sprint 31 |
| 4 | ATR-based debate cache invalidation | Medium | Low | Sprint 31 |
| 7 | `better_opportunity` cross-check | Medium | Low | Sprint 31 |
| 6 | Ollama tag spot-check accuracy | Low–Medium | Low | Sprint 32 |
| 8 | Calibration block token budget | Low (now) | Low | Before Phase 8 |

**Gap 1 first** — the conservatism loop is a structural flaw that compounds
over time. Every month without it, the calibration tightens a little more.

**Gap 9 second** — the lessons database is deferred but the infrastructure is
ready. The "what is a lesson?" question has a clear answer now: a one-sentence
rule scoped to ticker/sector/regime, created by the adjudicator or manually.

**Gap 3 alongside Gap 1** — the nightly price-fetch job supports both virtual
outcomes and sell tag outcome tracking. Build once, serve both.
