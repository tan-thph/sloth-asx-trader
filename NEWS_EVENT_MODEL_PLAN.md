# NEWS_EVENT_MODEL_PLAN.md — Event lifecycles (R3) + Historical playbooks (R7)

**Date:** 2026-07-15 · **Scope:** plan + ideas only, nothing implemented · **Status:** DRAFT — deferred by design, see *Verdict* first.

Source: `critics.md` R3 (Add Event Lifecycles) and R7 (Historical Event Playbooks). Companion to
`NEWS_CLASSIFICATION_FIXES.md` (C1-C6, shipped) which applied R5 and R4 from the same list.

## Verdict up front

Both are **architecturally sound and both are premature.** Neither is blocked on design — they're blocked
on data.

| | Blocker | Earliest sensible start |
|---|---|---|
| **R3** Event lifecycles | None material — buildable now, but the payoff is capped until the story spans more than the 3-day brief window. **Medium confidence it's worth the complexity.** | Any time; recommend after C4's retry lands and the 46% is re-measured |
| **R7** Historical playbooks | **Data-starved by ~2 orders of magnitude.** The critic's own example needs 82 capital raises; we have **15**, over **24 days** of history, and his "median recovery 48 days" exceeds our entire dataset. | ~6-12 months of accumulation, or a backfill (see R7-A) |

The recommendation is therefore: **build R7's collection layer now (cheap, and it's the thing that has to
accumulate), surface R7's statistics only behind the existing CI/min-n gates, and treat R3 as optional.**

---

## Measured baseline (2026-07-15)

Everything below is from the live DB, not estimated.

**Announcements — the natural unit for R7 playbooks:**

```
233 announcements · 47 distinct tickers · 2026-06-21 .. 2026-07-14  (24 days)

Other            n=163  tickers=45     <- 70% of the corpus is the catch-all
Dividend         n= 34  tickers=12
Capital Raise    n= 15  tickers=10
Guidance Update  n=  9  tickers= 8     <- below MIN_NUDGE_N (12)
CEO Change       n=  3
Acquisition      n=  3
Earnings         n=  2
AGM              n=  2
Trading Halt     n=  1
Asset Sale       n=  1
```

Two facts kill R7 today: only **Dividend (34) and Capital Raise (15)** clear the codebase's own
`_MIN_NUDGE_N` of 12, and **70% of the corpus is `Other`** — a playbook keyed on event type would mostly
be a playbook for "Other", which means nothing.

**News — the unit for R3 threading:**

```
["CBA"]  20 articles  2026-07-01 .. 2026-07-11
["BHP"]  16 articles  2026-07-01 .. 2026-07-14
["CSL"]  13 articles  2026-07-01 .. 2026-07-13
["WDS"]  10 articles  2026-07-01 .. 2026-07-06
```

Real multi-article clustering **does** exist — R3 has something to thread. But 20 CBA articles over 10
days are certainly several *different* stories plus generic chatter, so ticker-grouping alone is not a
story; text similarity within a ticker+window is required.

---

## R3 — Event lifecycles

### The idea

Treat a story as an object with a lifecycle, not N independent articles:

```
Guidance Warning → Analyst Downgrade → Price Collapse → CEO Resigns → Capital Raise
```

…is one evolving story with a rising severity, not five unrelated impact scores.

### Why it's worth more than it first looks

My initial objection was that the brief only reads a **3-day window**, so a story arc spanning weeks is
invisible anyway. That objection is wrong, and the reason is the whole point of the feature:

> **`story_id` decouples the story's history from the article window.** Only the *latest* article need
> fall inside the 3-day window; the story's arc is then injected from the `stories` table without
> widening the article window at all.

So the brief could carry
`FMG [story: guidance cut → downgrade → capital raise · 4 updates over 18d · severity 6→9 · unresolved]`
while still only selecting *one* in-window article. That is strictly more information for roughly the
same tokens, and it's the one thing that fixes story-spam (currently 4 articles about the same FMG
downgrade can occupy 4 of 10 direct slots).

### Building blocks that already exist

- `NewsPreprocessor.is_duplicate()` (`news_engine.py:526`) — TF-IDF + cosine over the last 200 titles,
  threshold **0.87**. That's *near-duplicate* (same article, different feed). Threading is the same
  machinery at a **lower threshold** over a **longer window**, scoped by ticker.
- `primary_tickers`, `category`, `published_date`, `impact_score` are all already captured per article.
- `HAS_SKLEARN` guard already exists — threading must degrade gracefully without sklearn, exactly as
  dedup does.

### Sketch

1. **Schema:** `news_items.story_id TEXT` (nullable — legacy rows stay NULL, same discipline as C1's
   `transmission`). New `news_stories` table: `story_id, first_seen, last_seen, primary_ticker, category,
   article_count, severity_first, severity_latest, resolved INTEGER DEFAULT 0`.
2. **Assignment at classify time:** candidate set = processed articles from the last **14 days** sharing
   ≥1 `primary_ticker`. Cosine over title+summary; `sim > _STORY_THRESHOLD` (start ~0.45-0.55, i.e. well
   below the 0.87 dup bar) → inherit that article's `story_id`; else mint a new one. Ticker-scoping keeps
   the comparison set tiny, so cost is negligible.
3. **Severity:** `severity_latest` = the newest article's `impact_score`; `severity_first` = the oldest.
   The *delta* is the signal — a story escalating 6→9 is worth more than a flat 9.
4. **Resolution:** `resolved=1` when no new article for `2 × decay_half_life_for(category)` days. Reuses
   C5's map rather than inventing a second notion of staleness.
5. **Brief:** collapse same-story articles to one line carrying the arc; the story line replaces the
   article lines it subsumes, freeing slots.

### Risks / open questions

- **Wrong merges create false narratives.** Two unrelated CBA stories merged into one arc would tell
  Claude a fabricated escalation. This is the R2/C6 lesson again: a confident-but-wrong annotation is
  worse than none. Mitigation: start the threshold **high** (0.6+), accept under-merging (which degrades
  to today's behaviour), and only lower it against measured precision.
- **Threshold has no ground truth.** There's no labelled story set to tune against, and eyeballing 20 CBA
  articles is exactly the manual-review burden this codebase has avoided elsewhere. Honest answer: this
  ships on a hand-tuned constant and stays there.
- **Payoff is unproven.** The story-spam problem is real but I have not measured how often it actually
  costs a slot in practice. **Worth measuring before building** — one query over a week of briefs:
  *how many selected direct-tier articles share a ticker+category within 5 days?* If the answer is "one
  or two a week", R3 is not worth its complexity.

### Effort

M-L. Schema + assignment + story table maintenance + brief rendering + tests. The assignment step is
small; the story-table lifecycle and the brief collapse are where the work is.

---

## R7 — Historical event playbooks

### The idea

Instead of Claude reasoning from first principles about a capital raise, hand it the base rate:

```
Historically: 82 capital raises · average -7.4% · median recovery 48 days
```

### Why this is the right shape for this codebase

It is the **learning loop applied to news** — and this app already has that exact architecture for recs:
decay-weighted win rates, Wilson CIs, `_ESS_MIN=6.0`, `_MIN_NUDGE_N=12`, Mann-Whitney gating,
`_calib_compute()`'s TTL cache. R7 should reuse those norms verbatim, not invent parallel statistics.

It also shares its entire data-collection layer with **critics R6** (learn actual market impact):

> Both need *"event at T0 → realised price path at T+1/T+5/T+20"*. **Build that once, serve both.**
> R6 asks "was the classifier's impact score right?"; R7 asks "what does this event type usually do?".
> Same table, two queries. This is the strongest argument for doing R6 and R7 as one project.

### The blocker, stated plainly

- **15 capital raises vs the critic's 82.** At the current ~10/day announcement rate with `Capital Raise`
  at 6% of volume, 82 takes roughly **9-12 months**.
- **24 days of history vs a 48-day median recovery.** We cannot measure recovery time over a window
  shorter than the recovery.
- **70% `Other`.** Playbooks key on type; the type taxonomy is dominated by a catch-all.

### R7-A — Fix the taxonomy first (cheap, do this regardless)

- **Status:** Resolved (2026-07-15). The "largely" claim above was optimistic — measured against the
  live corpus, the original 10 `_ADMIN_ANN_PATTERNS` only matched **84/163 (51%)** of `Other` rows, not
  "largely". Two causes, both fixed: (1) a live bug — the pattern `"director interest notice"` silently
  missed every real headline, which reads `"Director's Interest Notice"` (apostrophe-s); `core.
  is_admin_announcement()` now normalises curly apostrophes to straight before matching, and the pattern
  itself was corrected. (2) Several genuinely-administrative categories (buy-back notices, DRP/
  distribution admin, ETF fund-flow notices, beneficial-ownership statements, CDI/units-on-issue
  disclosures, quotation-of-securities filings, cleansing notices, CEO interest notices, Appendix 4G)
  weren't in the deny-list at all. Coverage is now **142/163 (87%)**.
- **Type relabel wired into `classify_announcement()`** (`announcement_engine.py`), scoped to `type ==
  'Other'` only: **37 admin-pattern headlines in the live DB carry a real type** (Dividend/Capital
  Raise/Asset Sale/Guidance Update) because the classifier used PDF content the headline alone doesn't
  show — e.g. "Distribution Timetable Announcement" is sometimes typed Dividend. The impact cap (R2)
  still applies to those (the filing genuinely is routine regardless of type), but the type label is left
  alone so a real classification is never overwritten by a keyword match. `price_sensitive` rows are
  excluded from relabeling for the same reason the cap ordering excludes them.
- **Backfill extended**: `POST /api/announcements/backfill-admin-cap` now also retypes stored `Other`
  rows to `Admin` (dry-run by default), returning both `rows_capped` and `rows_retyped`.
- **UI**: `js/pages/announcements.js` — `ANN_TYPE_COLORS`/`ANN_TYPES` gained an `'Admin'` entry so the
  type filter and colour pill render it.
- Tests: 10 new (`TestPromptRelevanceFixes` — apostrophe matching, expanded pattern coverage, Appendix
  4C/4D/4E exclusion, type-relabel scoping, backfill retyping).

### R7-B — Collection layer (build now, surface later)

New table `event_outcomes`: `event_id, source ('announcement'|'news'), ticker, event_type, event_date,
px_t0, px_t1, px_t5, px_t20, ret_1d, ret_5d, ret_20d, resolved_at`.

- Populated by a **lazy resolver** in the same shape as `_resolve_mae_mfe` / `_resolve_hold_outcomes`
  (`routes/learning.py`): capped batch per call, `fetch_failed_at` sentinel so a permanently-failing row
  drops out of the queue, NULL until resolved. Those patterns are established — copy them, don't redesign.
- Price path via the existing `fetch_with_retry` + `indicators` stack. One history fetch per ticker over
  the widest window (the `backtest_ai_replay` `hist_cache` pattern), **not** one per event.
- Reuses the Sydney-date discipline from `announcement_engine._sydney_now()` — an announcement's T0 is a
  *trading* day, and UTC trails Sydney by ~10h.

### R7-C — Playbook surface (gated, later)

- `GET /api/learning/event-playbook?type=Capital%20Raise` → `{n, avg_ret_5d, median_ret_5d, wilson_lo,
  wilson_hi, median_recovery_days, verdict}`.
- **Must return "insufficient data" below `_MIN_NUDGE_N`**, exactly like every other nudge in this
  codebase. With today's data that means every type except Dividend returns insufficient — which is the
  correct, honest answer, and is why C is gated behind B accumulating.
- Injected into the prompt only for types that clear the gate, one line, next to the announcement it
  contextualises.

### Risks / open questions

- **Base rates are regime-dependent.** "Capital raises average -7.4%" pooled across a bull and a bear
  market is a statistic about neither. The rec learning loop already faced this and solved it with regime
  cross-tabs (`regime` captured at generation/execution/close). R7 should capture `regime` at event date
  from day one — cheap now, impossible retroactively.
- **Survivorship / selection.** The announcement sync covers 47 tickers, weighted to holdings +
  watchlist. A "capital raise" base rate from a book skewed to large caps will not describe a small-cap
  raise. Either scope the claim ("in names you follow") or widen the sync.
- **Is the base rate even actionable?** Knowing capital raises average -7.4% doesn't tell you what *this*
  raise does. Its real value is as a **prior for Claude's conviction**, which is precisely how the
  calibration block is already used — so the wiring is known-good.

### Effort

R7-A: S. R7-B: M (mostly copying established resolver patterns). R7-C: S, but gated behind months of B.

---

## Suggested order

1. **R7-A** — reclassify admin `Other` → `Admin`. Cheap, improves data that must accumulate, no
   dependency. **Done (2026-07-15).**
2. **R7-B + R6 together** — one collection layer, two consumers. This is the highest-value item on the
   whole `critics.md` list, and the one the critic himself ranked first. Start once C4's retry has been
   re-measured (calibrating a scorer that fails to emit a score half the time would just measure the
   parse failure).
3. **R3 measurement** — one query: how often does story-spam actually cost a brief slot? Build only if
   the answer justifies it.
4. **R7-C** — when `n` clears the gate. Not before.

## What this plan deliberately does not do

- **No knowledge graph (R8).** C1's `transmission` already captures the useful hop in one field.
- **No new classifier fields.** C4 measured the local model omitting `impact_score` 46% of the time;
  R3's `story_id` and R7's outcomes are computed **server-side from data we already have**, never asked
  of the model. That constraint is why these two are viable when R1/R2/R9/R10 were not.
