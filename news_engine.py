#!/usr/bin/env python3
"""
ASX News Scanner Engine
Pipeline: RSS/Filings → Preprocess → Ollama LLM → SQLite + optional FAISS

Required:   pip install feedparser beautifulsoup4 scikit-learn
Optional:   pip install faiss-cpu sentence-transformers   (vector search)
Ollama:     https://ollama.com/download  then  ollama pull gemma3:4b
"""

import hashlib
import json
import logging
import os
import re
import sqlite3
import subprocess
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

import requests

log = logging.getLogger("news_engine")

# ── GPU / CUDA detection ──────────────────────────────────────────────────────

_gpu_cache: dict | None = None

def detect_gpu() -> dict:
    """Probe whether CUDA/GPU acceleration is available for local inference.

    Works on x86 NVIDIA, Jetson Orin/Nano (Tegra CUDA), and returns False on
    CPU-only boards such as Raspberry Pi 5.  Result is cached after first call.
    """
    global _gpu_cache
    if _gpu_cache is not None:
        return _gpu_cache

    result: dict = {"cuda": False, "device": None, "driver": None, "source": None}

    # 1. nvidia-smi — covers x86 NVIDIA and Jetson (returns "Orin (nvgpu)" on Tegra)
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0 and r.stdout.strip() and "[N/A]" not in r.stdout:
            parts = r.stdout.strip().split("\n")[0].split(", ")
            name   = parts[0].strip()
            driver = parts[1].strip() if len(parts) > 1 else None
            _gpu_cache = {"cuda": True, "device": name, "driver": driver, "source": "nvidia-smi"}
            return _gpu_cache
        # Jetson reports name but memory as [N/A] — name still confirms CUDA
        if r.returncode == 0 and r.stdout.strip():
            name = r.stdout.strip().split("\n")[0].split(",")[0].strip()
            if name:
                _gpu_cache = {"cuda": True, "device": name, "driver": None, "source": "nvidia-smi"}
                return _gpu_cache
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # 2. Jetson-specific device nodes
    for dev in ("/dev/nvhost-gpu", "/dev/nvidia0"):
        if os.path.exists(dev):
            _gpu_cache = {"cuda": True, "device": "Jetson embedded GPU", "driver": None, "source": dev}
            return _gpu_cache

    # 3. CUDA shared library (ARM Jetson / embedded Linux)
    for lib in (
        "/usr/lib/aarch64-linux-gnu/libcuda.so",
        "/usr/lib/aarch64-linux-gnu/libcuda.so.1",
        "/usr/local/cuda",
    ):
        if os.path.exists(lib):
            _gpu_cache = {"cuda": True, "device": "CUDA (embedded)", "driver": None, "source": lib}
            return _gpu_cache

    _gpu_cache = result
    return _gpu_cache

def _safe_float(v, default: float = 0.0, max_val: float | None = None) -> float:
    """Convert LLM output to float, tolerating strings/lists/None."""
    if v is None:
        return default
    if isinstance(v, (int, float)):
        result = float(v)
    else:
        try:
            # Strip trailing words like "out of 10", units, etc.
            result = float(str(v).split()[0].rstrip(".,;:"))
        except (ValueError, TypeError):
            return default
    return min(result, max_val) if max_val is not None else result


def _norm_sentiment(v) -> str:
    """Normalise LLM sentiment to bullish/bearish/neutral."""
    s = str(v or "").lower().strip()
    if "bull" in s or "positive" in s or "optimist" in s:
        return "bullish"
    if "bear" in s or "negative" in s or "pessimist" in s:
        return "bearish"
    return "neutral"
logging.basicConfig(level=logging.DEBUG)

# ── Optional dependency guards ────────────────────────────────────────────────
try:
    import feedparser
    HAS_FEEDPARSER = True
except ImportError:
    HAS_FEEDPARSER = False
    log.warning("feedparser not installed — RSS will use fallback XML parser")

try:
    from bs4 import BeautifulSoup
    HAS_BS4 = True
except ImportError:
    HAS_BS4 = False

try:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity as sk_cosine
    import numpy as np
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False

try:
    import faiss
    from sentence_transformers import SentenceTransformer
    HAS_VECTOR = True
except ImportError:
    HAS_VECTOR = False


# ── RSS feed catalogue ────────────────────────────────────────────────────────
MARKET_FEEDS = [
    {
        "key":     "rba",
        "name":    "RBA Speeches",
        "url":     "https://www.rba.gov.au/rss/rss-cb-speech.xml",
        "type":    "macro",
        "enabled": True,
    },
    {
        "key":     "reuters_au",
        "name":    "Reuters Australia",
        "url":     "https://feeds.reuters.com/reuters/AustraliaNews",
        "type":    "news",
        "enabled": True,
    },
    {
        "key":     "asx_announcements",
        "name":    "ASX Market Announcements",
        "url":     "https://www.asx.com.au/asx/statistics/announcements.do?by=dateFiled&timeframe=D&format=rss",
        "type":    "filing",
        "enabled": True,
    },
    {
        "key":     "investing_au",
        "name":    "Investing.com AU",
        "url":     "https://au.investing.com/rss/news.rss",
        "type":    "news",
        "enabled": False,   # off by default — requires UA header
    },
]


def _ticker_google_rss(ticker: str) -> str:
    q = f"{ticker}+ASX+Australia+stock"
    return f"https://news.google.com/rss/search?q={q}&hl=en-AU&gl=AU&ceid=AU:en"


def _ticker_yahoo_rss(ticker: str) -> str:
    return f"https://finance.yahoo.com/rss/headline?s={ticker}.AX"


# ── Database helpers ──────────────────────────────────────────────────────────

def init_news_tables(conn: sqlite3.Connection):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS news_items (
            id              TEXT PRIMARY KEY,
            url             TEXT UNIQUE NOT NULL,
            title           TEXT NOT NULL,
            source          TEXT,
            feed_type       TEXT,
            published_date  TEXT,
            fetched_at      TEXT,
            content         TEXT,
            summary         TEXT,
            category        TEXT,
            sentiment       TEXT,
            sentiment_score REAL,
            impact_score    REAL DEFAULT 0,
            tickers         TEXT DEFAULT '[]',
            primary_tickers TEXT DEFAULT '[]',
            tags            TEXT DEFAULT '[]',
            llm_model       TEXT,
            processed       INTEGER DEFAULT 0,
            decay_weight    REAL DEFAULT 1.0
        );
        CREATE INDEX IF NOT EXISTS idx_news_pub   ON news_items(published_date DESC);
        CREATE INDEX IF NOT EXISTS idx_news_proc  ON news_items(processed);
        CREATE INDEX IF NOT EXISTS idx_news_impact ON news_items(impact_score DESC);
    """)
    conn.executescript("""

        CREATE TABLE IF NOT EXISTS news_scan_log (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_time           TEXT NOT NULL,
            articles_fetched    INTEGER DEFAULT 0,
            articles_new        INTEGER DEFAULT 0,
            articles_processed  INTEGER DEFAULT 0,
            duration_seconds    REAL,
            llm_available       INTEGER DEFAULT 0,
            error               TEXT
        );
    """)
    # Migrate existing DBs that predate the primary_tickers column
    try:
        conn.execute("ALTER TABLE news_items ADD COLUMN primary_tickers TEXT DEFAULT '[]'")
    except Exception:
        pass  # column already exists
    conn.commit()


@contextmanager
def news_db(db_path: Path):
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ── Scraper ───────────────────────────────────────────────────────────────────

class NewsScraper:
    # Generic RSS headers — works for RBA, Reuters, ASX
    HEADERS = {
        "User-Agent": "ASXNewsScanner/1.0 (financial research; not for commercial use)",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
    }

    # Full browser headers required for Yahoo Finance and Google News RSS,
    # which block non-browser User-Agents with 403 or redirect to a login page.
    BROWSER_HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Referer": "https://www.google.com/",
    }

    def __init__(self, max_age_days: int = 7):
        self.max_age_days = max_age_days
        self._cutoff_dt = datetime.utcnow() - timedelta(days=max_age_days)

    @property
    def cutoff(self):
        self._cutoff_dt = datetime.utcnow() - timedelta(days=self.max_age_days)
        return self._cutoff_dt

    def fetch_rss(self, url: str, source: str, feed_type: str = "news",
                  browser_ua: bool = False) -> list[dict]:
        headers = self.BROWSER_HEADERS if browser_ua else self.HEADERS
        if HAS_FEEDPARSER:
            return self._feedparser_fetch(url, source, feed_type, headers)
        return self._raw_xml_fetch(url, source, feed_type, headers)

    def _feedparser_fetch(self, url: str, source: str, feed_type: str,
                          headers: dict) -> list[dict]:
        articles = []
        try:
            feed = feedparser.parse(url, request_headers=headers)
            for e in feed.entries[:30]:
                link = (e.get("link") or "").strip()
                if not link:
                    continue
                pub = self._parse_date(e.get("published") or e.get("updated") or "")
                if pub and pub < self.cutoff:
                    continue
                raw_content = (
                    e.get("summary") or
                    e.get("description") or
                    (e.get("content") or [{}])[0].get("value", "")
                )
                articles.append({
                    "id":             hashlib.sha256(link.encode()).hexdigest(),
                    "url":            link,
                    "title":          (e.get("title") or "").strip(),
                    "source":         source,
                    "feed_type":      feed_type,
                    "published_date": pub.isoformat() if pub else datetime.utcnow().isoformat(),
                    "fetched_at":     datetime.utcnow().isoformat(),
                    "content":        self._clean_html(raw_content)[:2500],
                })
        except Exception as ex:
            log.warning("feedparser RSS failed %s: %s", url, ex)
        return articles

    def _raw_xml_fetch(self, url: str, source: str, feed_type: str,
                       headers: dict) -> list[dict]:
        articles = []
        try:
            r = requests.get(url, headers=headers, timeout=10)
            r.raise_for_status()
            for item in re.findall(r"<item>(.*?)</item>", r.text, re.DOTALL)[:25]:
                def _tag(t):
                    m = re.search(rf"<{t}[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</{t}>", item, re.DOTALL)
                    return m.group(1).strip() if m else ""
                link = _tag("link") or _tag("guid")
                title = _tag("title")
                if not link or not title:
                    continue
                pub = self._parse_date(_tag("pubDate"))
                if pub and pub < self.cutoff:
                    continue
                articles.append({
                    "id":             hashlib.sha256(link.encode()).hexdigest(),
                    "url":            link,
                    "title":          re.sub(r"<[^>]+>", "", title).strip(),
                    "source":         source,
                    "feed_type":      feed_type,
                    "published_date": pub.isoformat() if pub else datetime.utcnow().isoformat(),
                    "fetched_at":     datetime.utcnow().isoformat(),
                    "content":        self._clean_html(_tag("description"))[:2500],
                })
        except Exception as ex:
            log.warning("Raw XML RSS failed %s: %s", url, ex)
        return articles

    def _clean_html(self, html: str) -> str:
        if not html:
            return ""
        if HAS_BS4:
            return BeautifulSoup(html, "lxml" if HAS_BS4 else "html.parser").get_text(" ", strip=True)
        return re.sub(r"<[^>]+>", " ", html).strip()

    _DATE_FMTS = [
        "%a, %d %b %Y %H:%M:%S %z",
        "%a, %d %b %Y %H:%M:%S GMT",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ]

    def _parse_date(self, s: str) -> datetime | None:
        if not s:
            return None
        s = s.strip()
        for fmt in self._DATE_FMTS:
            try:
                dt = datetime.strptime(s, fmt)
                return dt.replace(tzinfo=None)
            except ValueError:
                continue
        return None


# ── Preprocessor ─────────────────────────────────────────────────────────────

class NewsPreprocessor:
    def __init__(self, fuzzy_threshold: float = 0.87):
        self._recent_titles: list[str] = []
        self._threshold = fuzzy_threshold

    def is_duplicate(self, conn: sqlite3.Connection, article_id: str, title: str) -> bool:
        if conn.execute("SELECT 1 FROM news_items WHERE id=?", (article_id,)).fetchone():
            return True
        if HAS_SKLEARN and len(self._recent_titles) >= 2:
            try:
                corpus = self._recent_titles[-200:] + [title]
                mat = TfidfVectorizer(ngram_range=(1, 2)).fit_transform(corpus)
                sims = sk_cosine(mat[-1:], mat[:-1]).flatten()
                if sims.max() > self._threshold:
                    return True
            except Exception:
                pass
        return False

    def store_batch(self, conn: sqlite3.Connection, articles: list[dict]) -> int:
        new_count = 0
        for a in articles:
            if not a.get("title") or not a.get("url"):
                continue
            if self.is_duplicate(conn, a["id"], a["title"]):
                continue
            try:
                conn.execute("""
                    INSERT OR IGNORE INTO news_items
                        (id, url, title, source, feed_type, published_date,
                         fetched_at, content, processed)
                    VALUES
                        (:id,:url,:title,:source,:feed_type,:published_date,
                         :fetched_at,:content,0)
                """, a)
                self._recent_titles.append(a["title"])
                new_count += 1
            except sqlite3.IntegrityError:
                pass
        if len(self._recent_titles) > 1000:
            self._recent_titles = self._recent_titles[-500:]
        return new_count


# ── Robust JSON parser (handles truncated / trailing-comma LLM output) ────────

def _robust_json_parse(raw: str) -> dict | None:
    """Parse JSON from LLM output, repairing the most common failure modes.

    Stages:
      1. Direct json.loads (fast path).
      2. Strip trailing commas before } or ] — common when the model lists items.
      3. Close unclosed structures — handles token-limit truncation mid-output.
         Counts unescaped braces/brackets and appends the missing closers.
    Returns a dict on success, None on total failure.
    """
    if not raw:
        return None

    def _try(s: str) -> dict | None:
        try:
            result = json.loads(s)
            return result if isinstance(result, dict) else None
        except (json.JSONDecodeError, ValueError):
            return None

    # Stage 1 — direct
    r = _try(raw)
    if r is not None:
        return r

    # Stage 2 — trailing commas
    fixed = re.sub(r",(\s*[}\]])", r"\1", raw)
    r = _try(fixed)
    if r is not None:
        return r

    # Stage 3 — close unclosed structures (truncation repair)
    trimmed = fixed.rstrip().rstrip(",")
    # Close any dangling string literal (odd number of unescaped double-quotes)
    n_quotes = len(re.findall(r'(?<!\\)"', trimmed))
    if n_quotes % 2 == 1:
        trimmed += '"'
    # Count net-open braces and brackets (ignoring those inside strings is
    # impractical without a full parser, but for LLM-generated JSON with simple
    # string values the count approach is reliable enough)
    n_brace   = trimmed.count("{") - trimmed.count("}")
    n_bracket = trimmed.count("[") - trimmed.count("]")
    if n_brace > 0 or n_bracket > 0:
        trimmed += "]" * max(0, n_bracket) + "}" * max(0, n_brace)
        trimmed = re.sub(r",(\s*[}\]])", r"\1", trimmed)
        r = _try(trimmed)
        if r is not None:
            return r

    return None


# ── Earnings / Dividend Context Enrichment ───────────────────────────────────

# Sector peer groups for major ASX stocks — used to give the LLM comparison context
_TICKER_PEERS: dict[str, list[str]] = {
    # Big-4 banks + Macquarie
    'CBA': ['ANZ','NAB','WBC','MQG'], 'ANZ': ['CBA','NAB','WBC','MQG'],
    'NAB': ['CBA','ANZ','WBC','MQG'], 'WBC': ['CBA','ANZ','NAB','MQG'],
    'MQG': ['CBA','ANZ','NAB','WBC'], 'BEN': ['BOQ','ANZ'],
    'BOQ': ['BEN','ANZ'],
    # Insurers
    'SUN': ['IAG','QBE'], 'IAG': ['SUN','QBE'], 'QBE': ['IAG','SUN'],
    # Healthcare
    'CSL': ['RMD','COH','SHL'], 'RMD': ['CSL','COH','SHL'],
    'COH': ['CSL','RMD','SHL'], 'SHL': ['CSL','RMD','COH'],
    # Miners
    'BHP': ['RIO','FMG','MIN','S32'], 'RIO': ['BHP','FMG','S32'],
    'FMG': ['BHP','RIO','MIN'],       'MIN': ['BHP','FMG'],
    'S32': ['BHP','RIO'],             'NST': ['NCM','EVN'],
    # Energy
    'WDS': ['STO','BPT'], 'STO': ['WDS','BPT'],
    # Retailers / Consumer
    'WOW': ['COL','WES'],    'COL': ['WOW','WES'],    'WES': ['WOW','COL'],
    'JBH': ['HVN','MYR'],
    # REITs
    'GMG': ['SCG','GPT','SGP'], 'SCG': ['GMG','GPT','SGP'],
    'SGP': ['GMG','GPT','SCG'],
    # Tech
    'WTC': ['XRO','TYR'], 'XRO': ['WTC','TYR'],
    # Telcos
    'TLS': ['TPG'],
    # Utilities
    'AGL': ['ORG','APA'], 'ORG': ['AGL','APA'],
}

# In-memory cache: ticker -> (context_str, fetch_timestamp)
_ticker_ctx_cache: dict[str, tuple[str, float]] = {}
_CTX_CACHE_TTL = 6 * 3600  # 6 hours

_ED_KEYWORDS = frozenset([
    'earnings', 'profit', 'revenue', 'sales result', 'eps', 'npat',
    'net profit', 'net income', 'half year', 'full year', 'annual result',
    'quarterly result', 'dividend', 'dps', 'payout', 'distribution',
    'interim dividend', 'final dividend', 'guidance', 'outlook', 'forecast',
    'beat', 'miss', 'exceeded', 'below expectations', 'above expectations',
    'results season', 'operating result', 'half-year', 'full-year', 'results',
])


def _is_earnings_dividend_article(title: str, content: str) -> bool:
    """Quick keyword gate — true if article is likely about earnings or dividends."""
    text = (title + ' ' + (content or '')).lower()
    return sum(1 for kw in _ED_KEYWORDS if kw in text) >= 2


def _extract_article_tickers(title: str, content: str,
                              portfolio_tickers: list[str]) -> list[str]:
    """Return portfolio tickers that appear as the primary subject of the article."""
    title_u  = title.upper()
    early_u  = (content or '')[:400].upper()
    title_hits   = [t for t in portfolio_tickers if t.upper() in title_u]
    content_hits = [t for t in portfolio_tickers
                    if t.upper() in early_u and t not in title_hits]
    return (title_hits + content_hits)[:2]  # cap at 2 tickers to control prompt size


def _fmt_large(v: float) -> str:
    """Format a large dollar figure compactly."""
    if abs(v) >= 1e9:
        return f'${v/1e9:.2f}B'
    return f'${v/1e6:.0f}M'


def _fetch_ticker_context(ticker: str) -> str:
    """
    Build a compact fundamentals snapshot for a single ASX ticker.

    Pulls from yfinance: net profit / revenue trend (3 FY), EPS metrics,
    dividend history with YoY change, analyst consensus & price target, and
    sector peers.  Returns '' on any failure.  Results are cached for 6 hours
    to avoid hammering yfinance during a batch re-classify run.
    """
    now = time.time()
    cached = _ticker_ctx_cache.get(ticker)
    if cached and (now - cached[1]) < _CTX_CACHE_TTL:
        return cached[0]

    lines: list[str] = []
    try:
        import yfinance as yf
        t = yf.Ticker(f'{ticker}.AX')
        info = t.info or {}

        # ── Net profit & revenue trend (last 3 FY from annual income statement) ──
        try:
            fin = t.income_stmt
            if fin is not None and not fin.empty:
                ni_row = next(
                    (r for r in fin.index
                     if 'net income' in r.lower()
                     and 'discontinu' not in r.lower()
                     and 'minority' not in r.lower()),
                    None)
                rev_row = next(
                    (r for r in fin.index
                     if r.lower() in ('total revenue', 'operating revenue')),
                    None)
                # Use the 3 most recent columns that have a non-null net income value
                if ni_row:
                    valid_cols = [c for c in fin.columns
                                  if fin.loc[ni_row, c] is not None][:3]
                    if len(valid_cols) >= 2:
                        ni_vals = [fin.loc[ni_row, c] for c in valid_cols]
                        trend   = ' → '.join(_fmt_large(v) for v in reversed(ni_vals))
                        yoy     = (ni_vals[0] - ni_vals[1]) / abs(ni_vals[1]) * 100 \
                                  if ni_vals[1] else 0
                        lines.append(f'Net profit (FY): {trend} | YoY: {yoy:+.1f}%')
                if rev_row:
                    valid_cols = [c for c in fin.columns
                                  if fin.loc[rev_row, c] is not None][:3]
                    if len(valid_cols) >= 2:
                        rv_vals = [fin.loc[rev_row, c] for c in valid_cols]
                        rtend   = ' → '.join(_fmt_large(v) for v in reversed(rv_vals))
                        ryoy    = (rv_vals[0] - rv_vals[1]) / abs(rv_vals[1]) * 100 \
                                  if rv_vals[1] else 0
                        lines.append(f'Revenue (FY): {rtend} | YoY: {ryoy:+.1f}%')
        except Exception:
            pass

        # ── EPS snapshot ────────────────────────────────────────────────────────
        eps_parts: list[str] = []
        if info.get('trailingEps'):
            eps_parts.append(f'TTM ${info["trailingEps"]:.2f}')
        if info.get('epsCurrentYear'):
            eps_parts.append(f'CY est ${info["epsCurrentYear"]:.2f}')
        if info.get('forwardEps'):
            eps_parts.append(f'fwd ${info["forwardEps"]:.2f}')
        if info.get('earningsGrowth') is not None:
            eps_parts.append(f'YoY earnings {info["earningsGrowth"]*100:+.1f}%')
        if info.get('earningsQuarterlyGrowth') is not None:
            eps_parts.append(f'QoQ {info["earningsQuarterlyGrowth"]*100:+.1f}%')
        if eps_parts:
            lines.append('EPS: ' + ' | '.join(eps_parts))

        # ── Dividend history ─────────────────────────────────────────────────────
        try:
            divs = t.dividends
            if divs is not None and len(divs) >= 2:
                recent   = divs.tail(4)
                div_strs = [f'${v:.3f}' for v in recent]
                yoy_div  = None
                if len(recent) >= 4:
                    last = float(recent.iloc[-1]) + float(recent.iloc[-2])
                    prev = float(recent.iloc[-3]) + float(recent.iloc[-4])
                    yoy_div = (last - prev) / abs(prev) * 100 if prev else None
                line = f'Dividends (recent payments): {" → ".join(div_strs)}'
                if yoy_div is not None:
                    line += f' | YoY: {yoy_div:+.1f}%'
                dy = info.get('dividendYield') or 0
                # yfinance returns dividendYield as a percentage (e.g. 3.04)
                # on some versions and as a fraction (0.0304) on others —
                # normalise to percentage for display
                dy_pct = dy if dy > 1 else dy * 100
                if dy_pct:
                    line += f' | yield {dy_pct:.1f}%'
                    fya = info.get('fiveYearAvgDividendYield') or 0
                    if fya:
                        # same normalisation
                        fya_pct = fya if fya > 1 else fya * 100
                        line += f' (5yr avg {fya_pct:.1f}%)'
                if info.get('payoutRatio'):
                    line += f' | payout ratio {info["payoutRatio"]*100:.0f}%'
                lines.append(line)
        except Exception:
            if info.get('dividendRate'):
                line = f'Dividend: ${info["dividendRate"]:.2f}/yr'
                dy = info.get('dividendYield') or 0
                dy_pct = dy if dy > 1 else dy * 100
                if dy_pct:
                    line += f' ({dy_pct:.1f}% yield)'
                lines.append(line)

        # ── Analyst consensus & price target ─────────────────────────────────────
        rec = (info.get('recommendationKey') or '').upper()
        tgt = info.get('targetMeanPrice')
        cur = info.get('currentPrice') or info.get('regularMarketPrice')
        a_parts: list[str] = []
        if rec:
            a_parts.append(f'consensus {rec}')
        if tgt and cur:
            upside = (tgt - cur) / cur * 100
            a_parts.append(f'mean target ${tgt:.2f} vs current ${cur:.2f} ({upside:+.1f}%)')
        elif tgt:
            a_parts.append(f'mean target ${tgt:.2f}')
        if a_parts:
            lines.append('Analysts: ' + ' | '.join(a_parts))

        # ── Sector peers ──────────────────────────────────────────────────────────
        peers = _TICKER_PEERS.get(ticker.upper(), [])
        if peers:
            lines.append(f'Sector peers for comparison: {", ".join(peers)}')

    except Exception as ex:
        log.debug('_fetch_ticker_context failed for %s: %s', ticker, ex)

    result = '\n'.join(lines)
    _ticker_ctx_cache[ticker] = (result, time.time())
    return result


# ── Ollama LLM ────────────────────────────────────────────────────────────────

class OllamaLLM:
    CLASSIFY_PROMPT = """\
You are a financial news analyst for Australian stocks (ASX).
Analyse the article below and respond with ONLY valid JSON — no markdown fences, no extra text.

Title: {title}
Content: {content}
Portfolio tickers: {tickers}
{context}
Required JSON (fill ALL fields):
{{"summary":"2-3 sentence factual summary",\
"category":"earnings|regulatory|macro|sector|dividend|analyst|merger|technical|other",\
"sentiment":"bullish|bearish|neutral",\
"sentiment_score":<float -1.0 to 1.0>,\
"impact_score":<float 0.0-10.0; score the REAL PORTFOLIO IMPACT using this rubric — \
STEP 1 — article type: if this is commentary/opinion/question with NO new company data (e.g. 'should I buy X?', 'top stocks for 2025', listicles), set score to 0.5-2.0 and stop; \
STEP 2 — base score by event class: trading-halt/M&A-bid/regulatory-decision=7-9, earnings-result/dividend-change/capital-raise/guidance-update=6-8, CEO-exec-change/analyst-PT-revision=4-6, RBA-APRA-macro-policy=3-5, operational-company-update=2-4, broad-sector-commentary=1-3; \
STEP 3 — specificity: add +1.5 if a portfolio ticker is the PRIMARY subject of this article; subtract 2 if it is only mentioned in passing or as part of an index list; \
STEP 4 — magnitude: add +1 if specific large figures are cited (earnings change >5%, deal >$500M, dividend cut >20%); \
final = min(10.0, sum of applicable steps)>,\
"primary_tickers":<ASX codes that are the MAIN SUBJECT — e.g. ["CBA"] for a CBA earnings article; [] for broad-market articles>,\
"mentioned_tickers":<ALL other ASX codes referenced in passing>,\
"tags":<list of 2-5 keyword tags>,\
"is_portfolio_relevant":<true only if a primary_tickers code appears in the portfolio list above>}}"""

    def __init__(self, model: str = "", base_url: str = "http://localhost:11434"):
        self.model = model
        self.base_url = base_url.rstrip("/")

    def is_available(self) -> bool:
        try:
            r = requests.get(f"{self.base_url}/api/tags", timeout=3)
            return r.ok
        except Exception:
            return False

    def list_models(self) -> list[dict]:
        try:
            r = requests.get(f"{self.base_url}/api/tags", timeout=5)
            if r.ok:
                return r.json().get("models", [])
        except Exception:
            pass
        return []

    def get_ps(self) -> dict | None:
        """Return /api/ps payload — running models with VRAM usage."""
        try:
            r = requests.get(f"{self.base_url}/api/ps", timeout=5)
            if r.ok:
                return r.json()
        except Exception:
            pass
        return None

    # Models known to use chain-of-thought / thinking blocks before JSON output.
    # For these we prepend /no_think and increase num_predict to avoid token starvation.
    _THINKING_MODELS = ("qwen3", "qwq", "deepseek-r1", "deepseek-r2", "marco-o1")

    def _is_thinking_model(self) -> bool:
        name = self.model.lower()
        return any(m in name for m in self._THINKING_MODELS)

    def classify(
        self,
        title: str,
        content: str,
        portfolio_tickers: list[str],
        status_ref: dict | None = None,
        cpu_mode: bool = False,
        stop_event=None,
    ) -> dict | None:
        """Classify via streaming Ollama — status_ref gets live token counts."""
        ticker_str = ", ".join(portfolio_tickers[:20]) if portfolio_tickers else "none"
        # Trim inputs more aggressively on CPU/SBC to reduce inference time
        content_limit = 400 if cpu_mode else 700

        # ── Earnings/dividend context enrichment ─────────────────────────────
        # Fetch historical fundamentals for portfolio tickers that are the
        # primary subject of this article so the model can compare reported
        # figures against trend rather than guessing from article tone alone.
        context_block = ""
        if _is_earnings_dividend_article(title, content):
            tickers_to_enrich = _extract_article_tickers(
                title, content, portfolio_tickers)
            if tickers_to_enrich:
                ctx_parts: list[str] = []
                for tk in tickers_to_enrich:
                    ctx = _fetch_ticker_context(tk)
                    if ctx:
                        ctx_parts.append(
                            f'--- Historical data for {tk} ---\n{ctx}')
                if ctx_parts:
                    context_block = (
                        '\n'.join(ctx_parts)
                        + '\n\nSentiment calibration rules (apply when historical data above is present):\n'
                        '- Earnings / profit: reported > prior FY or > forward EPS estimate → bullish; '
                        'reported < prior FY or significant miss → bearish; in-line → neutral\n'
                        '- Revenue: acceleration in YoY growth → bullish lean; deceleration or decline → bearish lean\n'
                        '- Dividends: increase vs recent history → bullish; cut or suspension → bearish; '
                        'maintained / in-line → neutral\n'
                        '- Analyst consensus BUY + price well below mean target → bullish supporting signal\n'
                        '- Override article tone if the hard data contradicts it (e.g. article is cautious '
                        'but earnings clearly beat trend → still bullish)\n'
                    )
        # Strip any stray curly braces from context to avoid breaking .format()
        context_block = context_block.replace('{', '(').replace('}', ')')

        thinking = self._is_thinking_model()
        base_prompt = self.CLASSIFY_PROMPT.format(
            title=title[:200],
            content=(content or "")[:content_limit],
            tickers=ticker_str,
            context=context_block,
        )
        prompt = base_prompt

        # format:"json" (GBNF grammar) forces the model to output pure JSON.
        # For thinking models on this Ollama version, JSON is routed to the
        # chunk["thinking"] field instead of chunk["response"] — the streaming
        # loop reads both, so this works correctly and uses only ~36–50 tokens
        # instead of the 2048-token thinking pass that think:False triggered.
        num_predict = 250 if cpu_mode else 400
        num_ctx     = 1024 if cpu_mode else 2048

        options: dict = {
            "temperature": 0.1,
            "num_predict": num_predict,
            "num_ctx":     num_ctx,
        }
        if cpu_mode:
            options["num_gpu"] = 0  # force CPU-only; omit entirely otherwise so Ollama auto-selects

        payload = {
            "model":   self.model,
            "prompt":  prompt,
            "stream":  True,
            "format":  "json",
            "options": options,
        }
        raw_parts: list[str] = []
        token_count = 0
        t_start = time.monotonic()

        try:
            # connect timeout 30s; read timeout scales with model type:
            # thinking models on GPU get 10 min — they run the reasoning pass
            # internally before streaming JSON, so the "silent" phase can be long.
            # 300 s floor for all GPU modes — Jetson cold model load alone ~60 s.
            read_timeout = 300 if cpu_mode else (600 if thinking else 300)
            with requests.post(
                f"{self.base_url}/api/generate",
                json=payload,
                stream=True,
                timeout=(30, read_timeout),
            ) as resp:
                if not resp.ok:
                    log.debug("Ollama HTTP %s: %s", resp.status_code, resp.text[:200])
                    return None

                for line in resp.iter_lines():
                    # Abort mid-stream if user requested stop
                    if stop_event is not None and stop_event.is_set():
                        log.info("Classify aborted mid-stream by stop_event")
                        break
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    # Ollama routes JSON to "thinking" for thinking models even with
                    # format:"json" — read both fields so we work across versions.
                    token = chunk.get("response", "") or chunk.get("thinking", "")
                    if token:
                        raw_parts.append(token)
                        token_count += 1
                        if status_ref is not None:
                            elapsed = max(time.monotonic() - t_start, 0.01)
                            status_ref["tokens_generated"] = token_count
                            status_ref["tokens_per_sec"] = round(token_count / elapsed, 1)

                    if chunk.get("done"):
                        # Use Ollama's authoritative eval_count + eval_duration for
                        # accurate tps — important for thinking models where the
                        # reasoning phase isn't streamed (shows as 0 tps otherwise).
                        if status_ref is not None:
                            eval_count = chunk.get("eval_count", token_count)
                            eval_ns    = chunk.get("eval_duration", 0)
                            if eval_ns > 0:
                                status_ref["tokens_generated"] = eval_count
                                status_ref["tokens_per_sec"]   = round(eval_count / (eval_ns / 1e9), 1)
                        break

        except requests.exceptions.Timeout:
            log.debug("Ollama classify timed out after %s tokens", token_count)
            if not raw_parts:
                return None
        except Exception as ex:
            log.debug("LLM classify failed: %s", ex)
            return None

        raw = "".join(raw_parts).strip()
        if not raw:
            return None

        # ── Post-processing pipeline ──────────────────────────────────────────
        # 1. Strip thinking blocks.  Two patterns cover:
        #    a) complete block  <think>...</think>
        #    b) truncated block <think>... (model hit num_predict mid-reasoning,
        #       no closing tag) — without this, JSON inside the block is mistakenly
        #       extracted instead of the post-think response.
        raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL)
        raw = re.sub(r"<think>.*",          "", raw, flags=re.DOTALL).strip()
        # 2. Strip markdown code fences (``` json ... ```)
        raw = re.sub(r"```(?:json)?\s*", "", raw)
        raw = re.sub(r"```", "", raw).strip()
        # 3. Isolate the first JSON object.  Use a non-greedy match first so
        #    that a short, well-formed object is preferred over one that greedily
        #    swallows trailing free-text.
        m = re.search(r"\{.*?\}", raw, re.DOTALL)
        if not m:
            m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            raw = m.group(0)

        if not raw:
            log.debug("LLM returned no JSON after stripping (thinking model?)")
            return None

        # 4. Robust parse — handles trailing commas and truncation
        result = _robust_json_parse(raw)
        if result is None:
            log.debug("LLM JSON parse failed after repair | raw=%s", raw[:300])
        return result


class GoogleLLM:
    """Google Gemini cloud LLM — implements the same classify() interface as OllamaLLM."""

    GOOGLE_MODEL = "gemini-2.0-flash"
    _BASE_URL    = "https://generativelanguage.googleapis.com/v1beta"

    CLASSIFY_PROMPT = OllamaLLM.CLASSIFY_PROMPT

    def __init__(self, api_key: str = "", model: str = ""):
        self.api_key = api_key
        self.model   = model or self.GOOGLE_MODEL

    def is_available(self) -> bool:
        return bool(self.api_key)

    def list_models(self) -> list[dict]:
        """Return available Gemini models that support generateContent."""
        if not self.api_key:
            return []
        try:
            r = requests.get(
                f"{self._BASE_URL}/models",
                params={"key": self.api_key},
                timeout=10,
            )
            if not r.ok:
                return []
            models = r.json().get("models", [])
            return [
                {"name": m["name"].removeprefix("models/"), "displayName": m.get("displayName", "")}
                for m in models
                if "generateContent" in m.get("supportedGenerationMethods", [])
                and "gemini" in m.get("name", "").lower()
            ]
        except Exception as ex:
            log.debug("GoogleLLM.list_models failed: %s", ex)
            return []

    def classify(
        self,
        title: str,
        content: str,
        portfolio_tickers: list[str],
        status_ref: dict | None = None,
        cpu_mode: bool = False,
        stop_event=None,
    ) -> dict | None:
        if not self.api_key:
            return None
        ticker_str = ", ".join(portfolio_tickers[:20]) if portfolio_tickers else "none"
        prompt = self.CLASSIFY_PROMPT.format(
            title=title[:200],
            content=(content or "")[:700],
            tickers=ticker_str,
            context="",
        )
        try:
            resp = requests.post(
                f"{self._BASE_URL}/models/{self.model}:generateContent",
                params={"key": self.api_key},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "temperature":     0.1,
                        "maxOutputTokens": 400,
                    },
                },
                timeout=30,
            )
            if resp.status_code != 200:
                log.debug("GoogleLLM HTTP %s: %s", resp.status_code, resp.text[:200])
                return None
            raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            raw = re.sub(r"```(?:json)?\s*", "", raw)
            raw = re.sub(r"```", "", raw).strip()
            m = re.search(r"\{.*?\}", raw, re.DOTALL) or re.search(r"\{.*\}", raw, re.DOTALL)
            if m:
                raw = m.group(0)
            return _robust_json_parse(raw)
        except Exception as exc:
            log.debug("GoogleLLM classify failed: %s", exc)
            return None


class GroqLLM:
    """Groq cloud LLM — implements the same classify() interface as OllamaLLM."""

    GROQ_MODEL = "llama-3.1-8b-instant"

    # Reuse the same prompt as OllamaLLM
    CLASSIFY_PROMPT = OllamaLLM.CLASSIFY_PROMPT

    def __init__(self, api_key: str = "", model: str = ""):
        self.api_key    = api_key
        _model          = model or self.GROQ_MODEL
        self.model      = f"groq/{_model}"
        self._api_model = _model   # bare model name for API calls

    def is_available(self) -> bool:
        return bool(self.api_key)

    def classify(
        self,
        title: str,
        content: str,
        portfolio_tickers: list[str],
        status_ref: dict | None = None,
        cpu_mode: bool = False,
        stop_event=None,
    ) -> dict | None:
        if not self.api_key:
            return None
        ticker_str = ", ".join(portfolio_tickers[:20]) if portfolio_tickers else "none"
        prompt = self.CLASSIFY_PROMPT.format(
            title=title[:200],
            content=(content or "")[:700],
            tickers=ticker_str,
            context="",
        )
        try:
            resp = requests.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model":       self._api_model,
                    "messages":    [{"role": "user", "content": prompt}],
                    "temperature": 0.1,
                    "max_tokens":  400,
                },
                timeout=30,
            )
            if resp.status_code != 200:
                log.debug("GroqLLM HTTP %s: %s", resp.status_code, resp.text[:200])
                return None
            raw = resp.json()["choices"][0]["message"]["content"]
            # Strip markdown fences and isolate first JSON object
            raw = re.sub(r"```(?:json)?\s*", "", raw)
            raw = re.sub(r"```", "", raw).strip()
            m = re.search(r"\{.*?\}", raw, re.DOTALL) or re.search(r"\{.*\}", raw, re.DOTALL)
            if m:
                raw = m.group(0)
            return _robust_json_parse(raw)
        except Exception as exc:
            log.debug("GroqLLM classify failed: %s", exc)
            return None


# ── Decay weighting ───────────────────────────────────────────────────────────

def compute_decay(published_iso: str, half_life_days: float = 3.0) -> float:
    """Exponential decay — article at half_life_days age has weight 0.5."""
    try:
        pub = datetime.fromisoformat(published_iso)
        age = max(0.0, (datetime.utcnow() - pub).total_seconds() / 86400.0)
        return max(0.05, 2.0 ** (-age / half_life_days))
    except Exception:
        return 0.5


# ── Vector store (optional FAISS) ────────────────────────────────────────────

class VectorStore:
    def __init__(self, data_dir: Path, model_name: str = "all-MiniLM-L6-v2"):
        self._index = None
        self._ids: list[str] = []
        self._model = None
        self._index_path = data_dir / "news_faiss.index"
        self._ids_path   = data_dir / "news_faiss_ids.json"
        if HAS_VECTOR:
            self._init(model_name)

    def _init(self, model_name: str):
        try:
            self._model = SentenceTransformer(model_name)
            if self._index_path.exists() and self._ids_path.exists():
                self._index = faiss.read_index(str(self._index_path))
                self._ids   = json.loads(self._ids_path.read_text())
            else:
                dim = self._model.get_sentence_embedding_dimension()
                self._index = faiss.IndexFlatIP(dim)
        except Exception as ex:
            log.warning("VectorStore init failed (non-fatal): %s", ex)

    def add(self, article_id: str, text: str):
        if not HAS_VECTOR or self._model is None or self._index is None:
            return
        try:
            emb = self._model.encode([text], normalize_embeddings=True)
            self._index.add(emb)
            self._ids.append(article_id)
            faiss.write_index(self._index, str(self._index_path))
            self._ids_path.write_text(json.dumps(self._ids))
        except Exception as ex:
            log.debug("VectorStore.add error: %s", ex)

    def search(self, query: str, k: int = 10) -> list[str]:
        if not HAS_VECTOR or self._model is None or self._index is None:
            return []
        if self._index.ntotal == 0:
            return []
        try:
            emb = self._model.encode([query], normalize_embeddings=True)
            _, I = self._index.search(emb, min(k, self._index.ntotal))
            return [self._ids[i] for i in I[0] if 0 <= i < len(self._ids)]
        except Exception:
            return []


# ── Main pipeline ─────────────────────────────────────────────────────────────

class NewsPipeline:
    def __init__(self, db_path: Path):
        self.db_path      = db_path
        self.scraper      = NewsScraper()
        self.preprocessor = NewsPreprocessor()
        self.llm: OllamaLLM | None = None
        self.vector       = VectorStore(db_path.parent)
        with news_db(db_path) as conn:
            init_news_tables(conn)

    def _get_llm(self, settings: dict) -> OllamaLLM | GroqLLM | GoogleLLM:
        provider = settings.get("llm_provider", "ollama").lower()
        if provider == "groq":
            api_key    = settings.get("groq_api_key", "")
            groq_model = settings.get("groq_model", "")
            if (not isinstance(self.llm, GroqLLM)
                    or self.llm.api_key != api_key
                    or self.llm._api_model != (groq_model or GroqLLM.GROQ_MODEL)):
                self.llm = GroqLLM(api_key=api_key, model=groq_model)
            return self.llm
        if provider == "google":
            api_key      = settings.get("google_api_key", "")
            google_model = settings.get("google_model", "")
            if (not isinstance(self.llm, GoogleLLM)
                    or self.llm.api_key != api_key
                    or self.llm.model != (google_model or GoogleLLM.GOOGLE_MODEL)):
                self.llm = GoogleLLM(api_key=api_key, model=google_model)
            return self.llm
        # default: Ollama
        model = settings.get("llm_model") or ""
        url   = settings.get("ollama_url", "http://localhost:11434")
        if not isinstance(self.llm, OllamaLLM) or self.llm.model != model or self.llm.base_url != url:
            self.llm = OllamaLLM(model=model, base_url=url)
        return self.llm

    def run(
        self,
        portfolio_tickers: list[str],
        watchlist_tickers: list[str] | None = None,
        settings: dict | None = None,
        stop_event=None,          # threading.Event — set externally to abort mid-scan
    ) -> dict:
        cfg = settings or {}
        self.scraper.max_age_days = int(cfg.get("max_age_days", 7))
        cpu_mode = bool(cfg.get("cpu_mode", False))
        llm = self._get_llm(cfg)
        # Skip LLM classification if no model has been selected by the user
        llm_ok = bool(llm.model) and llm.is_available()
        all_tickers = list({*portfolio_tickers, *(watchlist_tickers or [])})

        t0 = time.time()
        fetched = new_count = processed = 0
        error_msg = None

        # ── 1. Scrape market-wide feeds ──────────────────────────────────────
        all_articles: list[dict] = []
        for feed in MARKET_FEEDS:
            if not feed.get("enabled", True):
                continue
            arts = self.scraper.fetch_rss(feed["url"], feed["name"], feed["type"])
            all_articles.extend(arts)
            fetched += len(arts)
            time.sleep(0.2)

        # ── 2. Scrape per-ticker feeds (capped to avoid hammering) ───────────
        # Yahoo Finance and Google News require a real browser User-Agent;
        # the generic scanner UA gets 403 / login-page redirects.
        for ticker in all_tickers[:12]:
            for fn, delay, use_browser in [
                (_ticker_yahoo_rss,  0.15, True),
                (_ticker_google_rss, 0.25, True),
            ]:
                arts = self.scraper.fetch_rss(
                    fn(ticker), f"News:{ticker}", "news", browser_ua=use_browser
                )
                all_articles.extend(arts)
                fetched += len(arts)
                time.sleep(delay)

        # ── 3. Dedup + store ─────────────────────────────────────────────────
        _scan_status["phase"] = "storing"
        try:
            with news_db(self.db_path) as conn:
                new_count = self.preprocessor.store_batch(conn, all_articles)
        except Exception as ex:
            error_msg = str(ex)
            log.error("Preprocessor store failed: %s", ex)

        # ── 4. LLM classification of unprocessed articles ────────────────────
        if llm_ok:
            try:
                # CPU/SBC mode caps batch to 20 to keep scan time reasonable
                batch_limit = 20 if cpu_mode else 100
                with news_db(self.db_path) as conn:
                    unprocessed = conn.execute(
                        "SELECT id, title, content, published_date "
                        "FROM news_items WHERE processed IN (0,-1) ORDER BY published_date DESC LIMIT ?",
                        (batch_limit,),
                    ).fetchall()

                total = len(unprocessed)
                _scan_status["articles_to_classify"] = total
                _scan_status["articles_classified"]  = 0
                _scan_status["articles_failed"]       = 0
                _scan_status["llm_model"]             = llm.model
                _scan_status["phase"]                 = "classifying"

                def _probe_gpu():
                    if not isinstance(llm, OllamaLLM):
                        return
                    ps = llm.get_ps()
                    if ps is not None:
                        models_running = ps.get("models") or []
                        vram_total = sum(
                            int(m.get("size_vram", 0)) for m in models_running
                        )
                        _scan_status["gpu_vram_mb"] = round(vram_total / 1024 / 1024) if vram_total else 0

                art_times: list[float] = []
                for idx, row in enumerate(unprocessed):
                    # Check for user-requested stop before each article
                    if stop_event is not None and stop_event.is_set():
                        log.info("Scan stopped by user after %d/%d articles", idx, total)
                        _scan_status["phase"] = "stopped"
                        break

                    short_title = (row["title"] or "")[:80]
                    _scan_status["current_article"]       = short_title
                    _scan_status["current_article_idx"]   = idx + 1
                    # ISO string so JS can parse it with new Date()
                    _scan_status["current_article_start"] = datetime.utcnow().isoformat()
                    _scan_status["tokens_generated"]      = 0
                    _scan_status["tokens_per_sec"]        = 0.0

                    art_t0 = time.monotonic()

                    result = llm.classify(
                        row["title"], row["content"] or "", all_tickers,
                        status_ref=_scan_status,
                        cpu_mode=cpu_mode,
                        stop_event=stop_event,
                    )
                    art_elapsed = time.monotonic() - art_t0
                    art_times.append(art_elapsed)

                    # Probe GPU after first article so model is fully loaded into VRAM
                    if idx == 0:
                        _probe_gpu()
                    # Re-probe every 10 articles to catch delayed GPU loading
                    elif idx % 10 == 0:
                        _probe_gpu()

                    _scan_status["articles_classified"] = idx + 1
                    if art_times:
                        avg = sum(art_times) / len(art_times)
                        _scan_status["avg_secs_per_article"] = round(avg, 1)
                        remaining = total - (idx + 1)
                        _scan_status["eta_secs"] = round(avg * remaining)
                    _scan_status["elapsed_secs"] = round(time.time() - t0, 1)

                    dw = compute_decay(row["published_date"] or "")
                    try:
                        if result:
                            with news_db(self.db_path) as conn:
                                # primary_tickers = main article subject(s)
                                primary = [
                                    t.upper() for t in (result.get("primary_tickers") or [])
                                    if isinstance(t, str)
                                ][:5]
                                # mentioned_tickers = all incidental refs
                                mentioned = [
                                    t.upper() for t in (result.get("mentioned_tickers") or result.get("tickers_mentioned") or [])
                                    if isinstance(t, str)
                                ][:15]
                                # tickers col = union of both (primary first) for backward compat
                                ann_tickers = list(dict.fromkeys(primary + [t for t in mentioned if t not in primary]))

                                conn.execute("""
                                    UPDATE news_items SET
                                        summary         = :summary,
                                        category        = :category,
                                        sentiment       = :sentiment,
                                        sentiment_score = :score,
                                        impact_score    = :impact,
                                        tickers         = :tickers,
                                        primary_tickers = :primary_tickers,
                                        tags            = :tags,
                                        llm_model       = :model,
                                        decay_weight    = :decay,
                                        processed       = 1
                                    WHERE id = :id
                                """, {
                                    "summary":         str(result.get("summary") or "")[:500],
                                    "category":        str(result.get("category") or "other").lower()[:30],
                                    "sentiment":       _norm_sentiment(result.get("sentiment")),
                                    "score":           _safe_float(result.get("sentiment_score"), max_val=1.0),
                                    "impact":          _safe_float(result.get("impact_score"), max_val=10.0),
                                    "tickers":         json.dumps(ann_tickers),
                                    "primary_tickers": json.dumps(primary),
                                    "tags":            json.dumps(
                                        [str(t) for t in (result.get("tags") or []) if t][:8]
                                    ),
                                    "model":           llm.model,
                                    "decay":           dw,
                                    "id":              row["id"],
                                })
                            self.vector.add(row["id"], f"{row['title']} {row['content'] or ''}"[:1000])
                            processed += 1
                        else:
                            _scan_status["articles_failed"] = _scan_status.get("articles_failed", 0) + 1
                            log.debug("LLM returned None for article %s — marking processed=-1", row["id"][:8])
                            with news_db(self.db_path) as conn:
                                conn.execute(
                                    "UPDATE news_items SET processed=-1, decay_weight=? WHERE id=?",
                                    (dw, row["id"]),
                                )
                    except Exception as ex:
                        log.warning("DB update failed for article %s: %s", row["id"][:8], ex)
                        _scan_status["errors"].append(f"DB update: {ex}")

            except Exception as ex:
                log.error("LLM classification step failed: %s", ex)
                _scan_status["errors"].append(str(ex))

        # ── 5. Refresh decay weights on existing processed items ─────────────
        try:
            with news_db(self.db_path) as conn:
                rows = conn.execute(
                    "SELECT id, published_date FROM news_items WHERE processed=1"
                ).fetchall()
                for row in rows:
                    dw = compute_decay(row["published_date"] or "")
                    conn.execute(
                        "UPDATE news_items SET decay_weight=? WHERE id=?", (dw, row["id"])
                    )
        except Exception:
            pass

        # ── 6. Prune stale articles ───────────────────────────────────────────
        try:
            max_age = int(cfg.get("max_age_days", 7)) * 2
            cutoff = (datetime.utcnow() - timedelta(days=max_age)).isoformat()
            with news_db(self.db_path) as conn:
                conn.execute("DELETE FROM news_items WHERE published_date < ?", (cutoff,))
        except Exception:
            pass

        # ── 7. Log scan ───────────────────────────────────────────────────────
        duration = round(time.time() - t0, 1)
        try:
            with news_db(self.db_path) as conn:
                conn.execute("""
                    INSERT INTO news_scan_log
                        (scan_time, articles_fetched, articles_new, articles_processed,
                         duration_seconds, llm_available, error)
                    VALUES (?,?,?,?,?,?,?)
                """, (
                    datetime.utcnow().isoformat(),
                    fetched, new_count, processed,
                    duration, int(llm_ok), error_msg,
                ))
        except Exception:
            pass

        return {
            "fetched": fetched,
            "new": new_count,
            "processed": processed,
            "llm_available": llm_ok,
            "duration": duration,
            "error": error_msg,
        }


# ── Scheduler ─────────────────────────────────────────────────────────────────

_pipeline:     NewsPipeline | None     = None
_sched_thread: threading.Thread | None = None
_sched_stop    = threading.Event()
_scan_lock     = threading.Lock()
_scan_stop_event = threading.Event()   # set to request mid-scan abort

_scan_status: dict = {
    "running":              False,
    "last_scan":            None,
    "next_scan":            None,
    "last_result":          None,
    "progress":             "idle",
    # ── Live progress ────────────────────────────────────────────────────
    "phase":                "idle",           # scraping|storing|classifying|done
    "articles_to_classify": 0,
    "articles_classified":  0,
    "articles_failed":      0,
    "current_article":      "",
    "current_article_idx":  0,
    "current_article_start":None,
    "tokens_generated":     0,
    "tokens_per_sec":       0.0,
    "avg_secs_per_article": 0.0,
    "elapsed_secs":         0.0,
    "eta_secs":             None,
    "llm_model":            "",
    "gpu_vram_mb":          None,             # None = unknown, 0 = CPU-only
    "errors":               [],
}


def get_pipeline(db_path: Path) -> NewsPipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = NewsPipeline(db_path)
    return _pipeline


def _scheduler_loop(
    db_path: Path,
    interval_hours: float,
    get_tickers_fn,
    get_settings_fn,
):
    # Initial delay — first run at server start after a short wait
    for _ in range(30):
        if _sched_stop.is_set():
            return
        time.sleep(1)

    while not _sched_stop.is_set():
        try:
            _execute_scan(db_path, get_tickers_fn(), get_settings_fn())
        except Exception as ex:
            log.error("Scheduled news scan error: %s", ex)
        # Sleep in 60-s chunks to stay responsive to stop signal
        for _ in range(int(interval_hours * 60)):
            if _sched_stop.is_set():
                return
            time.sleep(60)


def start_scheduler(
    db_path: Path,
    interval_hours: float,
    get_tickers_fn,
    get_settings_fn,
):
    global _sched_thread, _sched_stop
    stop_scheduler()
    _sched_stop = threading.Event()
    _sched_thread = threading.Thread(
        target=_scheduler_loop,
        args=(db_path, interval_hours, get_tickers_fn, get_settings_fn),
        daemon=True,
        name="NewsScheduler",
    )
    _sched_thread.start()
    # Set next_scan time
    _scan_status["next_scan"] = (
        datetime.utcnow() + timedelta(hours=interval_hours)
    ).isoformat()
    log.info("News scheduler started (every %.1f h)", interval_hours)


def stop_scheduler():
    global _sched_thread
    _sched_stop.set()
    if _sched_thread and _sched_thread.is_alive():
        _sched_thread.join(timeout=5)
    _sched_thread = None


def _execute_scan(
    db_path: Path,
    portfolio_tickers: list[str],
    settings: dict,
) -> dict:
    with _scan_lock:
        if _scan_status["running"]:
            return {"error": "scan already running"}
        _scan_status.update({
            "running":               True,
            "progress":              "scraping",
            "phase":                 "scraping",
            "last_scan":             datetime.utcnow().isoformat(),
            "articles_to_classify":  0,
            "articles_classified":   0,
            "articles_failed":       0,
            "current_article":       "",
            "current_article_idx":   0,
            "current_article_start": None,
            "tokens_generated":      0,
            "tokens_per_sec":        0.0,
            "avg_secs_per_article":  0.0,
            "elapsed_secs":          0.0,
            "eta_secs":              None,
            "errors":                [],
        })

    _scan_stop_event.clear()   # reset any previous stop request
    try:
        pipeline = get_pipeline(db_path)
        result = pipeline.run(
            portfolio_tickers=portfolio_tickers,
            settings=settings,
            stop_event=_scan_stop_event,
        )
        _scan_status["last_result"] = result
        return result
    finally:
        _scan_status["running"]  = False
        _scan_status["progress"] = "idle"
        if _scan_status.get("phase") != "stopped":
            _scan_status["phase"] = "done"
        _scan_status["current_article"] = ""
        _scan_status["eta_secs"] = 0
        interval_h = (settings or {}).get("scan_interval_hours", 6)
        _scan_status["next_scan"] = (
            datetime.utcnow() + timedelta(hours=interval_h)
        ).isoformat()


def trigger_scan(
    db_path: Path,
    portfolio_tickers: list[str],
    settings: dict,
) -> dict:
    """Non-blocking manual scan trigger."""
    if _scan_status["running"]:
        return {"ok": False, "error": "Scan already running"}
    t = threading.Thread(
        target=_execute_scan,
        args=(db_path, portfolio_tickers, settings),
        daemon=True,
        name="NewsScanManual",
    )
    t.start()
    return {"ok": True, "message": "Scan started"}


def stop_scan() -> dict:
    """Signal the running scan to stop after the current article completes."""
    if not _scan_status.get("running"):
        return {"ok": False, "error": "No scan running"}
    _scan_stop_event.set()
    return {"ok": True, "message": "Stop signal sent — finishing current article"}


def get_status() -> dict:
    return {**_scan_status}


# ── Portfolio news brief (used by analysis engine) ────────────────────────────

def get_news_brief(
    db_path: Path,
    portfolio_tickers: list[str],
    days: int = 3,
    max_direct: int = 6,
    max_wide: int = 3,
) -> list[dict]:
    """Return news relevant to portfolio, balancing recency AND impact.

    Selection strategy:
      • Guaranteed recency slots — always include the most recent articles (last 6h)
        per tier regardless of impact score. Breaking news at impact 4.5 matters more
        than a 2-day-old article at impact 8.0 that the market has already absorbed.
      • Impact slots — fill remaining slots with highest impact×decay not already chosen.

    Tier 1 — portfolio_direct: primary_tickers intersects portfolio (article IS about a holding).
    Tier 2 — market_wide: no portfolio primary match; includes recent articles (any impact)
              AND older high-impact articles (≥5.0).

    Each article carries a compact 'signal' string pre-built for token-efficient prompt injection.
    """
    cutoff          = (datetime.utcnow() - timedelta(days=days)).isoformat()
    recency_cutoff  = (datetime.utcnow() - timedelta(hours=6)).isoformat()
    ticker_set      = {t.upper() for t in portfolio_tickers}
    fetch_limit     = max(80, (max_direct + max_wide) * 10)

    try:
        with news_db(db_path) as conn:
            # Fetch sorted by published_date DESC so the recency loop just takes the first N
            rows = conn.execute("""
                SELECT title, source, published_date, summary, category,
                       sentiment, sentiment_score, impact_score,
                       tickers, primary_tickers, tags, decay_weight
                FROM news_items
                WHERE published_date >= ? AND processed = 1
                ORDER BY published_date DESC
                LIMIT ?
            """, (cutoff, fetch_limit)).fetchall()
    except Exception:
        return []

    portfolio_direct: list[dict] = []
    market_wide:      list[dict] = []

    for row in rows:
        primary   = set(json.loads(row["primary_tickers"] or "[]"))
        all_t     = set(json.loads(row["tickers"]         or "[]"))
        is_direct = bool(primary & ticker_set)
        imp       = row["impact_score"] or 0
        decay     = row["decay_weight"] or 0.5
        published = row["published_date"] or ""
        is_recent = published >= recency_cutoff   # within last 6h

        # Compact signal string: ~15-20 tokens in the prompt
        signal = (
            f"{'|'.join(sorted(primary & ticker_set)) or '—'} "
            f"[{row['category'] or 'other'}|{row['sentiment'] or 'neutral'}|{imp:.1f}] "
            f"{(row['title'] or '')[:80]} ({published[:10]})"
        )

        item = {
            "title":             row["title"],
            "source":            row["source"],
            "date":              published[:10],
            "published_at":      published,          # full ISO timestamp for recency comparison
            "summary":           (row["summary"] or "")[:100],
            "category":          row["category"],
            "sentiment":         row["sentiment"],
            "sentiment_score":   row["sentiment_score"],
            "impact_score":      imp,
            "tickers":           list(all_t),
            "primary_tickers":   list(primary),
            "portfolio_direct":  is_direct,
            "portfolio_relevant": is_direct or bool(all_t & ticker_set),
            "decay_weight":      decay,
            "is_recent":         is_recent,
            "signal":            signal,
        }

        if is_direct:
            portfolio_direct.append(item)
        elif imp >= 5.0 or is_recent:
            # Include market-wide article if: high-enough impact OR it's fresh (any impact)
            market_wide.append(item)

    def _select(pool: list, max_count: int, recency_slots: int = 2) -> list:
        """Pick up to max_count items:
        - Fill recency_slots with the newest articles (pool already sorted by date DESC)
        - Fill remaining slots with highest impact×decay not already selected
        """
        if not pool:
            return []
        seen:   set  = set()
        result: list = []

        # Recency pass — pool is date-DESC so just take the first N unique titles
        for item in pool:
            if len(result) >= recency_slots:
                break
            key = item["title"]
            if key not in seen:
                result.append(item)
                seen.add(key)

        # Impact pass — fill remaining slots
        remaining = max_count - len(result)
        if remaining > 0:
            impact_sorted = sorted(
                [it for it in pool if it["title"] not in seen],
                key=lambda it: it["impact_score"] * it["decay_weight"],
                reverse=True
            )
            for item in impact_sorted[:remaining]:
                result.append(item)

        return result

    direct_result = _select(portfolio_direct, max_direct, recency_slots=2)
    wide_result   = _select(market_wide,      max_wide,   recency_slots=1)

    return direct_result + wide_result


def get_market_sentiment(db_path: Path, days: int = 2) -> dict:
    """Aggregate sentiment across recent processed news."""
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
    try:
        with news_db(db_path) as conn:
            rows = conn.execute("""
                SELECT sentiment, COUNT(*) as cnt, AVG(sentiment_score) as avg_score,
                       AVG(impact_score) as avg_impact
                FROM news_items
                WHERE published_date >= ? AND processed=1
                GROUP BY sentiment
            """, (cutoff,)).fetchall()
    except Exception:
        return {"bullish": 0, "bearish": 0, "neutral": 0, "avg_score": 0}

    totals = {"bullish": 0, "bearish": 0, "neutral": 0, "avg_score": 0.0}
    total_weighted = 0.0
    total_count = 0
    for row in rows:
        s = (row["sentiment"] or "neutral").lower()
        if s in totals:
            totals[s] = row["cnt"]
        total_count += row["cnt"]
        total_weighted += (row["avg_score"] or 0) * row["cnt"]

    if total_count > 0:
        totals["avg_score"] = round(total_weighted / total_count, 3)
    totals["total"] = total_count
    return totals
