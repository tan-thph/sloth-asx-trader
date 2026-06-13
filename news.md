# News Scanner & Announcements Scanner

A technical reference for how both pipelines collect, process, score, and surface information.

---

## 1. News Scanner

### Overview

The News Scanner collects articles from RSS feeds and per-ticker news sources, deduplicates them using TF-IDF cosine similarity, classifies each article with an LLM (Ollama, Groq, or Google Gemini), and stores results in `asx_trader.db`. A background scheduler runs the pipeline automatically four times per day.

---

### 1.1 Data Sources

**Market-wide RSS feeds** (fetched on every scan):

| Feed | Type | Notes |
|---|---|---|
| RBA Speeches | macro | `rba.gov.au` — interest rate speeches, board minutes |
| ASX Market Announcements | filing | Official ASX filing feed — price-sensitive and general filings |
| Investing.com AU | news | Off by default — requires browser UA header to avoid 403 |

**Per-ticker RSS** (Yahoo Finance + Google News, up to 30 portfolio/watchlist tickers):

Each ticker in your combined portfolio + watchlist gets two dedicated queries:
- Yahoo Finance: `https://finance.yahoo.com/rss/headline?s=TICKER.AX`
- Google News: `https://news.google.com/rss/search?q=TICKER+ASX+Australia+stock`

Both require a full browser `User-Agent` header — Yahoo and Google block the generic RSS scanner UA with a 403 or redirect to a login page.

**Note:** The scanner uses `feedparser` when installed, falling back to a raw XML parser. `pip install feedparser beautifulsoup4 scikit-learn` gives the best results.

---

### 1.2 Pipeline Stages

```
RSS Feeds ──► Scrape ──► Deduplicate ──► Store ──► LLM Classify ──► Decay Weight ──► Prune
```

**Stage 1 — Scrape**

`NewsScraper.fetch_rss()` fetches each feed and normalises articles into a common dict shape:

```python
{
  "id":             "<sha256 of url>",
  "url":            "...",
  "title":          "...",
  "source":         "News:BHP",
  "feed_type":      "news|macro|filing",
  "published_date": "2026-06-14T08:00:00",
  "content":        "<article body, may be truncated by feed>",
}
```

Articles older than `max_age_days` (default 7, configurable in Settings → News) are discarded at scrape time.

**Stage 2 — Deduplicate**

`NewsPreprocessor.store_batch()` deduplicates before inserting into `news_items`. Two strategies run in order:

1. **URL dedup** — exact URL match against existing rows; skipped immediately if seen before.
2. **TF-IDF cosine similarity** (requires `scikit-learn`) — title + first 200 chars of content are vectorised. Any new article with cosine similarity ≥ 0.85 against an article already stored in the last 7 days is treated as a duplicate and skipped. This catches the same story from Yahoo Finance and Google News for the same ticker.

If `scikit-learn` is not installed, only URL dedup runs (more duplicates will appear in the feed).

**Stage 3 — Store**

New (non-duplicate) articles are inserted into `news_items` with `processed=0`. Fields stored per article:

| Column | Description |
|---|---|
| `id` | SHA-256 of URL |
| `url` | Canonical article URL |
| `title` | Headline |
| `source` | Feed name or `News:TICKER` |
| `feed_type` | `news`, `macro`, or `filing` |
| `published_date` | ISO datetime from RSS |
| `fetched_at` | UTC time of this fetch |
| `content` | Article body (may be partial — RSS often truncates) |
| `summary` | LLM-generated (filled in Stage 4) |
| `category` | LLM category (filled in Stage 4) |
| `sentiment` | `bullish` / `bearish` / `neutral` |
| `sentiment_score` | Float −1.0 to +1.0 |
| `impact_score` | Float 0.0–10.0 |
| `tickers` | JSON list of all ASX tickers mentioned |
| `primary_tickers` | JSON list of tickers that are the primary subject |
| `tags` | JSON list of keyword tags |
| `llm_model` | Which model classified this article |
| `processed` | 0 = pending, 1 = classified, −1 = LLM failed |
| `decay_weight` | Exponential decay from `published_date` |

**Stage 4 — LLM Classification**

Up to 100 unprocessed articles (20 in CPU/SBC mode) are classified per scan, newest first.

Before sending to the LLM, article content goes through `_strip_urls()` to remove hyperlinks — raw URL path segments in RSS bodies are the leading cause of LLM repetition loops (e.g. the model echoes `/models/models/models/...`).

For earnings/dividend articles, `_is_earnings_dividend_article()` gates a richer context block: if the article title and content contain 2+ keywords from the earnings/dividend keyword set (`_ED_KEYWORDS`), `_fetch_ticker_context()` fetches a fundamentals snapshot from yfinance for any portfolio tickers that are the primary subject. This gives the LLM actual numbers to compare the article against rather than just guessing from tone.

The context block includes:
- Net profit and revenue trend (last 3 financial years, YoY % change)
- EPS: trailing, current-year estimate, forward estimate, YoY/QoQ growth
- Dividend history (last 4 payments, YoY change, current yield, 5yr avg yield, payout ratio)
- Analyst consensus (BUY/HOLD/SELL), mean price target vs current price, implied upside
- Sector peer list (e.g. for CBA: ANZ, NAB, WBC, MQG)

Context is cached per ticker for 6 hours to avoid hammering yfinance during batch re-classify runs.

**LLM output validation:**

After classification, `_sanitize_summary()` scans the `summary` field for three degenerate patterns:
1. **Short repeating unit** (2–15 chars) repeated 3+ times: catches `de_de_de`, `_on_on_on`
2. **Long repeating unit** (16–160 chars) repeated 2+ times: catches schema-leak loops
3. **Prompt schema leakage**: catches `regulatory/macro`, `|bullish|`, etc. leaked from the prompt template

If `_is_degenerate_summary()` fires (>40% of text removed by sanitisation, or unique/total word ratio < 0.4), the entire LLM result is discarded and a clean headline-only fallback entry is stored instead. This prevents garbage output from low-quality quantised models (e.g. `gemma4:26b q4_K_M`) polluting the feed.

Articles that return `None` from the LLM (parse failure, timeout) are marked `processed=-1` and included in the next scan's unprocessed batch for retry.

**Thinking model support:** Models with `qwen3`, `qwq`, `deepseek-r1`, or `deepseek-r2` in their name are prepended with `/no_think` to suppress the chain-of-thought pass before JSON output. Without this, the thinking tokens consume most of `num_predict` before the model can emit the JSON answer.

**Stage 5 — Decay Refresh**

Every article's `decay_weight` is recalculated based on age:

```
decay_weight = 2^(−age_days / 3.0)   # half-life of 3 days, minimum 0.05
```

An article published 3 days ago has weight 0.5. At 7 days old the weight is ~0.10. At 14 days it's ~0.01. This is used to rank articles in the UI — recent articles appear prominently, old ones fade without being deleted.

**Stage 6 — Prune**

Articles older than `2 × max_age_days` (default 14 days) are hard-deleted from the database.

---

### 1.3 LLM Providers

| Provider | Config | Notes |
|---|---|---|
| **Ollama** (default) | Settings → News → LLM Model | Local inference. Supports GPU/CUDA auto-detection. Streaming mode gives live token-per-second stats in the scan progress bar. |
| **Groq** | Settings → News → Groq API Key | Cloud inference. Default model: `llama-3.1-8b-instant`. Fast (250 ms/article). Free tier limited to 6,000 tokens/min. |
| **Google Gemini** | Settings → News → Google API Key | Cloud inference. Default model: `gemini-3.5-flash`. Free tier: ~15 RPM; 429 responses auto-retry with 5s/10s/20s back-off. |

All three providers now receive the same earnings/dividend context enrichment for relevant articles.

---

### 1.4 Scheduled Scans

The scheduler fires 4 times per day at approximately 09:00, 12:00, 15:00, and 18:00 AEST (implementation is configurable via `next_scan` in the status response). Each scan:

1. Fetches all enabled market-wide feeds
2. Fetches per-ticker RSS for up to 30 portfolio/watchlist tickers
3. Deduplicates and stores new articles
4. Classifies unprocessed articles with the configured LLM
5. Updates decay weights
6. Prunes old articles

Manual scan: `POST /api/news/scan` — fires immediately, returns when complete.

---

### 1.5 News Score Card

Each article in the News feed shows a score card with these fields:

**Impact Score (0.0 – 10.0)**

This is the primary ranking signal. The LLM scores portfolio impact using a four-step rubric:

| Step | What it evaluates |
|---|---|
| Step 1 — Article type filter | Opinion, listicles, "should I buy X?" commentary → cap at 0.5–2.0 |
| Step 2 — Base score by event class | Trading halt / M&A bid / regulatory decision → 7–9 · Earnings / dividend change / capital raise / guidance → 6–8 · CEO/exec change / analyst PT revision → 4–6 · RBA/APRA/macro policy → 3–5 · Operational update → 2–4 · Broad sector commentary → 1–3 |
| Step 3 — Specificity bonus | +1.5 if a portfolio ticker is the PRIMARY subject · −2 if only mentioned in passing or in an index list |
| Step 4 — Magnitude bonus | +1 if specific large figures cited (earnings change >5%, deal >$500M, dividend cut >20%) |

Final score = min(10.0, sum of applicable steps).

**Sentiment (bullish / bearish / neutral)**

**Sentiment Score (−1.0 to +1.0)**

A float within the sentiment direction — allows sorting from most bearish (−1.0) to most bullish (+1.0) within the same sentiment bucket.

**Decay Weight (0.05 – 1.0)**

Age-adjusted weight. Articles published today have weight near 1.0. At 3 days old the weight halves. Used to sort the feed toward recency.

**Portfolio Relevance**

`is_portfolio_relevant = true` only when one of the `primary_tickers` matches a ticker in your portfolio list. Articles where a portfolio name is only mentioned in passing are marked as NOT portfolio-relevant.

**Category**

One of: `earnings`, `regulatory`, `macro`, `sector`, `dividend`, `analyst`, `merger`, `technical`, `other`.

**Primary Tickers vs Mentioned Tickers**

- `primary_tickers`: ASX codes that are the MAIN SUBJECT of the article (e.g. `["CBA"]` for a CBA earnings article)
- `mentioned_tickers`: all other ASX codes referenced in passing
- `tickers` column (in DB): union of both, primary first, for backward compatibility

---

## 2. Announcements Scanner

### Overview

The Announcements Scanner fetches ASX company announcements directly from the exchange infrastructure, downloads and parses PDF documents where available, classifies each announcement with an LLM, and stores results in `asx_trader.db`. It runs automatically twice per trading day (10:30 and 15:00 AEST).

---

### 2.1 Data Sources (in priority order)

**Source 1 — Markit Digital API** (primary)

`asx.api.markitdigital.com` is the same backend that powers `www2.asx.com.au`. It returns structured JSON including:
- `headline`, `date`, `announcementType` (Markit's own type taxonomy)
- `isPriceSensitive` flag (authoritative — set by the company when filing)
- PDF URL (`pdf_url`) and document key (`doc_key`) for PDF download

Limitation: returns only the ~5 most recent announcements per company per request, with no pagination. Busy companies (BHP, CBA) filing 5+ announcements in a day may have earlier ones missed within the `days` window.

**Source 2 — cloudscraper on marketindex.com.au** (fallback)

Uses `cloudscraper` to bypass Cloudflare protection on marketindex.com.au. Parses the Next.js `__NEXT_DATA__` JSON blob embedded in the HTML page. Returns only price-sensitive announcements (`priceSensitive: true`). Falls back to HTML table parsing if the JSON extraction fails.

Requires `pip install cloudscraper`.

**Source 3 — listcorp.com** (last resort)

Scrapes `listcorp.com/asx/{ticker}/news` — no Cloudflare, publicly accessible. Returns all announcements as HTML containers or table rows. Lower reliability for PDF URL extraction.

---

### 2.2 PDF Text Extraction

When a PDF URL is available, `download_pdf()` tries six strategies in order:

1. **Direct URL fetch** — HTTP GET on the `pdf_url` field from Markit
2. **Markit `doc_key` URL** — `https://announcements.asx.com.au/.../{doc_key}.pdf`
3. **ASX announcements CDN** — alternative path pattern on the ASX CDN
4. **cloudscraper on the PDF URL** — Cloudflare bypass in case the PDF endpoint is protected
5. **todayAnns URL resolver** — for today's announcements, attempts a secondary Markit query to get the current PDF URL (the URL may change between filing and public availability)
6. **listcorp PDF search** — search listcorp for a matching announcement and extract its PDF link

Once PDF bytes are downloaded, text extraction uses (in preference order):
1. `pdfplumber` — accurate layout-preserving extraction
2. `PyMuPDF` (`fitz`) — faster, good for simple PDFs
3. `pytesseract` + Pillow — OCR fallback for image-based PDFs (scanned documents)

All three are optional. If none are installed, the `pdf_text` field is left blank and classification runs on the headline alone.

---

### 2.3 Pipeline Stages

```
Fetch (Markit → cloudscraper → listcorp) ──► PDF Download ──► LLM Classify ──► Persist
```

**Per-ticker fetch** runs sequentially through the three sources until one returns results, then stops. The Markit API is tried first for every ticker.

**LLM Classification** runs immediately after PDF text extraction. Two different prompts are used:

- **Standard prompt** (`_LLM_PROMPT_TEMPLATE`): for non-price-sensitive announcements. Asks for `type`, `sentiment`, `impact`, `summary` (max 120 chars), `tags`.
- **Price-sensitive prompt** (`_LLM_PROMPT_TEMPLATE_PS`): richer prompt for flagged announcements. Also asks for `keyFigures` — structured extraction of metrics explicitly stated in the PDF (EPS, NPAT, revenue, dividend amount, franking %, ex-date, raise amount, acquisition premium, etc.). These are stored in the `details` field as JSON and rendered as a "Key Info" panel in the UI.

Price-sensitive announcements get a **retry** if the first LLM call fails (JSON parse failure or timeout) — they are considered high-value enough to warrant one extra attempt.

If both LLM attempts fail (or the configured provider is unavailable), the **keyword fallback** (`_classify_keyword`) runs deterministically:
- Type classification: keyword list matching against the combined headline + PDF text
- Dividends: dedicated `_classify_dividend_keyword` that extracts amount, franking %, and direction (increase/cut/maintained) from text patterns
- Sentiment: count of positive words vs negative words from a hardcoded word set
- Impact: `5.0 + (positive_count − negative_count) × 0.5`, clamped to 1.0–10.0

Keyword fallback results are tagged with `llm_model: "keyword_fallback"` so you can identify them in the UI.

**Persistence:**

`save_announcement()` checks whether an announcement with the same ID already exists before inserting. The ID is deterministic: `MD5(ticker:date:headline)`. If the row exists but `pdf_text` is empty (a prior PDF download failure), and the current sync now has `pdf_text`, the row is patched with the new content. Otherwise, existing rows are not modified — use the Re-classify button to re-run LLM on already-stored announcements.

---

### 2.4 LLM Providers

The Announcements Scanner has its own provider setting (separate from the News Scanner):

| Provider | Config | Notes |
|---|---|---|
| **Ollama** (default) | Settings → Announcements → LLM Model | Default model: `qwen2.5:1.5b`. Thinking models (qwen3, qwq, deepseek-r1) auto-detected and prepended with `/no_think`. |
| **Groq** | Settings → Announcements → Groq API Key | Default model: `llama-3.1-8b-instant` |
| **Gemini** | Settings → Announcements → Gemini API Key | Model configured via `gemini_model` setting. Free tier: ~15 RPM with auto-retry on 429. |
| **Keyword only** | Set provider to `keyword` | Skips LLM entirely. Useful on slow hardware. |

**Thinking model parameters** (Ollama only): temperature 0.4, top_p 0.9, top_k 40, min_p 0.05, repeat_penalty 1.3. These are tuned to avoid the near-greedy decoding (temperature 0.1) that causes `analysis_analysis_analysis...` repetition loops in quantised models.

---

### 2.5 Scheduled Scans

The announcements scheduler fires at **10:30 and 15:00 AEST**, weekdays only. The check uses a 2-minute window (10:30–10:31, 15:00–15:01) so a busy server thread that misses the exact minute still fires within the same check cycle.

The scheduler sleeps for 60 seconds between checks. `_last_run_slot` prevents double-firing within the same slot. The slot counter resets at midnight so the next day's slots can fire.

Manual trigger: `POST /api/announcements/sync` — fires a background sync for the given tickers.

---

### 2.6 Announcement Type Taxonomy

| Type | Markit keywords that map to it |
|---|---|
| **Earnings** | PERIODIC REPORTS, HALF YEARLY REPORT, QUARTERLY REPORT, FULL YEAR RESULTS, ANNUAL REPORT |
| **Dividend** | DIVIDEND, DISTRIBUTION |
| **Capital Raise** | CAPITAL RAISING, CAPITAL MANAGEMENT, ISSUED CAPITAL, RIGHTS ISSUE, PLACEMENT |
| **CEO Change** | CHANGE OF DIRECTOR, DIRECTOR CHANGE, CEO, MD |
| **Acquisition** | MERGER, TAKEOVER, ACQUISITION |
| **AGM** | AGM, ANNUAL GENERAL MEETING |
| **Trading Halt** | TRADING HALT, VOLUNTARY SUSPENSION |
| **Asset Sale** | ASSET SALE, DIVESTMENT |
| **Guidance Update** | GUIDANCE, OUTLOOK |
| **Other** | SECURITY HOLDER DETAILS, and anything that doesn't match above |

When the LLM is used, it can override the Markit-derived type. When the LLM falls back to keyword, and Markit already provided a type that isn't "Other", the Markit type is preserved over the keyword heuristic.

---

### 2.7 Announcement Score Card

Each announcement card in the UI shows:

**Impact Score (1.0 – 10.0)**

Scored by the LLM on a scale where:

| Score range | Typical announcement |
|---|---|
| 8–10 | Major earnings result with large EPS beat/miss, acquisition, capital raise, trading halt |
| 6–8 | Quarterly result, dividend change, guidance update with figures |
| 4–6 | Director appointment, analyst rating change, AGM notice |
| 1–4 | Routine administrative filings, security holder notices |

The standard prompt uses a default hint of `impact: 6`. The price-sensitive prompt hints `impact: 8` because price-sensitive announcements are higher-value by definition. The LLM adjusts from these defaults based on the actual content.

Keyword fallback impact: `5.0 + (positive_keyword_count − negative_keyword_count) × 0.5`, clamped to 1.0–10.0.

**Sentiment (positive / neutral / negative)**

Normalised to these three values. The LLM assigns based on the PDF content; keyword fallback counts positive words (profit, growth, increase, record, upgrade, beat, dividend, acquire…) vs negative words (loss, decline, write-down, downgrade, miss, suspension, weak…).

**Price Sensitive Flag (⚡ PS badge)**

Comes directly from the Markit `isPriceSensitive` field — set by the company at filing time. Price-sensitive announcements are shown first in the UI (sorted by `price_sensitive DESC, impact DESC, date DESC`). They use the richer LLM prompt with `keyFigures` extraction and get a retry on LLM failure.

**Type**

One of the 10 types in the taxonomy above. Displayed as a coloured badge.

**Key Figures panel** (price-sensitive only)

For price-sensitive announcements, the LLM extracts structured data explicitly stated in the PDF — only values actually present in the text, never inferred. Examples:

| Announcement type | Key Figures extracted |
|---|---|
| Earnings | EPS, NPAT, Revenue, vs Prior year % |
| Dividend | Amount per share, Franking %, Ex-Date, Pay-Date |
| Capital Raise | Raise Amount, Issue Price, Discount % |
| Acquisition | Target company, Deal Value, Premium % |

**Tags**

2–5 free-text keyword tags assigned by the LLM summarising the key themes (e.g. `["earnings_beat", "dividend_increase", "record_revenue"]`).

**Summary**

- Standard announcements: max 120 characters. One sentence.
- Price-sensitive announcements: max 200 characters. Must open with the single most important figure or outcome.

**LLM Model badge**

Shows which model classified the announcement. `keyword_fallback` means the LLM was unavailable or failed.

---

## 3. Re-classify Button

Both scanners support re-classification of stored items:

**News Scanner** — Re-classify button on the News page runs the LLM against all unprocessed articles (`processed IN (0, -1)`) in the current batch. Also available on individual articles via the 🔄 button.

**Announcement Scanner** — Re-classify button on the Announcements page runs `reclassify_all()` against all announcements stored within the last 30 days (configurable). This re-runs the current LLM on stored headline + PDF text without fetching new data from ASX. Useful after:
- Switching the LLM provider (e.g. from keyword_fallback to Gemini)
- Installing a better local Ollama model
- Changing prompt settings

Progress is polled at 1-second intervals. A Stop button sends a mid-run abort signal.

---

## 4. Database Tables

**`news_items`** — one row per unique article URL

**`news_scan_log`** — one row per completed scan: timestamp, articles fetched/new/processed, duration, LLM available flag, error if any

**`announcements`** — one row per announcement (keyed on `MD5(ticker:date:headline)`)

Both tables are in `asx_trader.db` (WAL mode, `synchronous=NORMAL`).

---

## 5. Optional Dependencies

| Package | Used by | Effect if missing |
|---|---|---|
| `feedparser` | News Scanner | Falls back to raw XML parser — less robust with malformed RSS |
| `beautifulsoup4` | Both | Required for HTML scraping (cloudscraper fallback, listcorp) |
| `scikit-learn` | News Scanner | TF-IDF dedup disabled — only URL dedup runs |
| `cloudscraper` | Announcements Scanner | marketindex.com.au fallback unavailable |
| `pdfplumber` | Announcements Scanner | Falls through to PyMuPDF or OCR |
| `PyMuPDF` (`fitz`) | Announcements Scanner | Falls through to OCR |
| `pytesseract` + `Pillow` | Announcements Scanner | No OCR — scanned PDFs have no text extracted |
| `faiss-cpu` + `sentence-transformers` | News Scanner | Optional vector search index not built |

Install everything: `pip install feedparser beautifulsoup4 scikit-learn cloudscraper pdfplumber PyMuPDF pytesseract Pillow`
