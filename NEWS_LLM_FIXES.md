# NEWS_LLM_FIXES.md — "Some news can't be analysed by local LLM"

**Date:** 2026-07-14 · **Scope:** local-LLM (Ollama) news classification path · **Status:** N1/N2/N5/N6/N7 implemented + tested (18 new tests, `TestNewsLlmFixes` in `test_app.py`); N3/N4 still open.

## Symptom & root confirmation

The news feed renders **only** `processed = 1` rows (`news_engine.py:1862`, `:1960`). Any article the
local model can't classify is set to `processed = -1` (`:1590`) and disappears from the feed entirely —
it is never shown as "failed", it just silently vanishes. So "some news can't be analysed" = articles
that repeatedly return `None` from `OllamaLLM.classify()` (or collapse into degenerate output) and get
stuck at `-1` forever.

Seven causes, ordered by impact. N1+N2 are the main drivers; they compound (a stuck article is both
invisible AND re-consumes a scan slot every run).

---

## N1 — Persistent failures clog the retry batch and never clear (P0)

- **Status:** Resolved. `attempts` column added (`init_news_tables()` + `ALTER TABLE` migration).
  Batch select is now two-phase (fresh `processed=0` fills first, `processed=-1` only tops up
  remaining slots). On a `None` classify, `attempts` increments; at `_NEWS_CLASSIFY_ATTEMPT_CAP`
  (3) the article moves to terminal `processed=-2`, excluded from every future batch select.
- **Where:** `news_engine.py:1445-1449` (batch select `WHERE processed IN (0,-1) ORDER BY published_date DESC LIMIT ?`), `:1590` (mark `-1`)
- **Cause:** There is no attempt counter and no retry cap. An article that always returns `None`
  stays at `processed=-1`, and because the batch re-selects `(0,-1)` ordered by `published_date DESC`,
  the *same* recent failures re-occupy the top slots every scan. In CPU mode `batch_limit=20`
  (`:1443`), so a cluster of ~20 unclassifiable recent items **starves every other article** — new and
  older-retryable alike — and none of the stuck ones ever succeed.
- **Fix:**
  1. Add an `attempts` (INTEGER, default 0) column to `news_items` (migration in `db.py`/news schema).
     Increment on each `-1` write. At a cap (suggest 3), move to a terminal state (e.g. `processed=-2`)
     that the batch select **excludes**, so it stops retrying and stops occupying slots.
  2. Prioritise fresh articles over retries in the batch order so retries never starve new work:
     `ORDER BY (processed = 0) DESC, published_date DESC` (or a two-phase select: fill from `0` first,
     top up from `-1`).
- **Test:** Seed N always-failing + M classifiable rows; assert all M get `processed=1` in one scan,
  and the N stop being re-selected after `attempts` hits the cap.
- **Effort:** M (schema migration + select change).

---

## N2 — Empty/near-empty content articles hard-fail with no fallback (P0)

- **Status:** Resolved. Scan loop checks `len(_strip_urls(content).strip()) < _HEADLINE_FALLBACK_MIN_CONTENT`
  (40) before ever calling `llm.classify()` and stores `_headline_fallback_classification()` (title
  as summary, regex ticker extraction, `processed=1`) directly — shared with N6's fallback shape.
- **Where:** `news_engine.py:915` (`clean_content = _strip_urls((content or ""))[:content_limit]`), classify at `:1487`
- **Cause:** Many feeds carry title-only items — BBC World, the ASX-announcements RSS, some Google
  News entries. Asked to fill ALL JSON fields from a bare title, weaker quantised local models often
  emit invalid/empty JSON → `None` → `processed=-1` → invisible (and then stuck per N1). The degenerate
  branch (`:1506`) only catches repetition loops, not empty/blank content.
- **Fix:** Add a deterministic headline-only path: when `clean_content` is empty or below a small
  threshold (e.g. < 40 chars), skip the model and store a headline fallback record — title as summary,
  regex ticker extraction (reuse `_extract_article_tickers`), `category="other"`, `neutral`, low
  non-zero impact — with `processed=1`. Same shape as the existing degenerate fallback at `:1511`.
  Optionally also apply this on a `None` return for a title-only item, so it never lands at `-1`.
- **Test:** `classify`/scan with `content=''` → stored `processed=1` with title summary; ticker regex
  populates `primary_tickers` when the title names a holding.
- **Effort:** S.

---

## N3 — No cross-provider fallback when the local model can't classify (P1)

- **Status:** Open
- **Where:** `news_engine.py:1487` (single `llm.classify(...)`); `GoogleLLM` (`:1077`), `GroqLLM` (`:1192`) already implement the same `classify()` interface
- **Cause:** The scan loop only ever calls the one selected provider. "Some news can't be analysed by
  **local** LLM" is literally accurate — when Ollama returns `None` on a hard article, nothing else
  attempts it, even if a cloud key is configured.
- **Fix:** On `result is None` (and not a user-stop / timeout abort), retry that single article **once**
  with a configured cloud provider (Google → Groq) before writing `-1`. Gate behind an explicit setting
  (e.g. `news_cloud_fallback`) so it never makes surprise paid calls; default off.
- **Test:** Mock local `classify → None`, Google `classify → dict`; assert the article is stored
  `processed=1` via the fallback and `llm_model` reflects the cloud model.
- **Effort:** M.

---

## N4 — Earnings-context enrichment can overflow `num_ctx` → silent truncation → None (P1)

- **Status:** Open
- **Where:** `news_engine.py:884-909` (multi-ticker `context_block` build), `:935` (`num_ctx = 1024` CPU / `2048` GPU)
- **Cause:** For earnings/dividend articles on portfolio tickers, the prompt gets the article **plus**
  per-ticker historical context **plus** peer comparisons **plus** the calibration-rules block. That can
  exceed `num_ctx` — especially CPU `1024`. Ollama truncates the prompt, frequently dropping the
  JSON-schema/format instruction, so the model emits non-JSON → `None`. This selectively breaks exactly
  the highest-value articles (holdings' earnings).
- **Fix:** Budget the enriched prompt against `num_ctx`: cap enriched tickers to 1, hard-limit
  `context_block` length, and/or raise `num_ctx` when a `context_block` is present (e.g. 4096) — sized
  from an estimate of the assembled prompt. Prefer measuring the final prompt length and picking
  `num_ctx` to fit.
- **Test:** Build a long multi-ticker `context_block`; assert the assembled prompt length stays within
  the chosen `num_ctx` budget (char/token estimate).
- **Effort:** S–M.

---

## N5 — Non-greedy JSON isolation truncates on a `}` inside a string value (P2)

- **Status:** Resolved. Replaced the non-greedy/greedy regex pair with `_extract_json_object()` —
  a string-aware balanced-brace walk (skips `{`/`}` inside quoted values, respects `\"` escapes).
  Applied at all three isolation sites (OllamaLLM, GoogleLLM, GroqLLM classify()).
- **Where:** `news_engine.py:1060` (`m = re.search(r"\{.*?\}", raw, re.DOTALL)`)
- **Cause:** Non-greedy captures first `{` → first `}`. If a `summary`/`tags` value contains a `}`
  (article about code, math, an emoji sequence, etc.), the capture ends early, yielding truncated JSON.
  `_robust_json_parse` sometimes repairs it, but can still fail → `None`.
- **Fix:** Use a balanced-brace walk (scan to the matching close), or try greedy `\{.*\}` first and fall
  back to non-greedy — the schema is flat (no nested objects), so greedy is normally correct here.
- **Test:** Raw JSON whose `summary` contains `}` parses to the full object.
- **Effort:** S.

---

## N6 — Degenerate fallback zeroes tickers/category even for holding-relevant articles (P2)

- **Status:** Resolved. Degenerate branch now calls the shared `_headline_fallback_classification()`
  (`_extract_article_tickers` over title+content) instead of hardcoding empty tickers/`impact=0.0`;
  a modest non-zero impact (3.0) is set when a portfolio/watchlist ticker matches.
- **Where:** `news_engine.py:1506-1520`
- **Cause:** When repetition collapse is detected, the fallback record drops **all** ticker/category
  signal (`impact 0.0`, `primary_tickers []`). It's stored `processed=1`, so it won't retry — but with
  zeroed fields and no tickers it's invisible to every portfolio/impact filter. A genuinely relevant
  article (e.g. a CBA result the model looped on) is effectively "not analysed".
- **Fix:** In the fallback, run cheap regex ticker extraction over title+content
  (`_extract_article_tickers`), populate `primary_tickers`/`mentioned_tickers`, and set a modest
  non-zero `impact_score` when a portfolio ticker matches — so it still surfaces.
- **Test:** Degenerate output on a title naming a holding → fallback still tags that ticker.
- **Effort:** S.

---

## N7 — `_safe_float` has no lower-bound clamp (P3, data quality)

- **Status:** Resolved. Added optional `min_val` param; call sites now clamp `sentiment_score` to
  `[-1, 1]` and `impact_score` to `[0, 10]`.
- **Where:** `news_engine.py:91-103` (`min(result, max_val)` clamps only the top)
- **Cause:** A model emitting `sentiment_score = -5.0` or a negative `impact` is stored as-is (only the
  upper bound is enforced). Not a hard failure, but out-of-range values skew downstream sentiment/impact
  aggregation.
- **Fix:** Add an optional `min_val`; clamp `sentiment_score` to `[-1, 1]` and `impact_score` to
  `[0, 10]` at the call sites (`:1572-1573`).
- **Test:** `_safe_float(-5, max_val=1.0, min_val=-1.0) == -1.0`.
- **Effort:** XS.

---

## Suggested sequencing

| Phase | Items | Rationale |
|---|---|---|
| 1 (P0) | N1, N2 | Stops the invisible-forever + slot-starvation loop — the actual "can't be analysed" you see. |
| 2 (P1) | N3, N4 | Recovers the hard/high-value articles (cloud fallback; earnings-context overflow). |
| 3 (P2–P3) | N5, N6, N7 | Parser robustness + fallback signal-retention + range hygiene. |

**Cross-cutting:** N1 needs a schema migration (`attempts` column + terminal `-2` state) — wire it into
`test_app.py`'s in-memory DB setup. Every fix needs a regression test; the existing suites cover none of
this path.
