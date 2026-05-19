"""
announcement_engine.py
======================
ASX announcement scraper + analyser engine for the Sloth.ai trading app.

Fetches ASX announcements from three sources in order:
  1. Markit Digital API (asx.api.markitdigital.com) — powers www2.asx.com.au;
     public, no auth, returns last ~5 announcements per company with
     isPriceSensitive flag. Reliable primary source.
  2. cloudscraper on marketindex.com.au (Cloudflare bypass, optional fallback)
  3. listcorp.com HTML scraping (no Cloudflare, last-resort fallback)
Extracts PDF text where available, classifies with an LLM (Ollama / Groq /
Gemini / keyword fallback), and persists results to the asx_trader.db SQLite
database.

Runs automatically twice daily (10:30 and 15:00 AEST) via a daemon thread.
No Flask dependency — pure engine module.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional

import requests

# ---------------------------------------------------------------------------
# Optional dependency guards
# ---------------------------------------------------------------------------
try:
    import pdfplumber  # type: ignore

    _HAS_PDFPLUMBER = True
except ImportError:
    _HAS_PDFPLUMBER = False

try:
    import fitz  # PyMuPDF  # type: ignore

    _HAS_FITZ = True
except ImportError:
    _HAS_FITZ = False

try:
    import pytesseract  # type: ignore
    from PIL import Image  # type: ignore
    import io as _io

    _HAS_OCR = True
except ImportError:
    _HAS_OCR = False

try:
    from bs4 import BeautifulSoup  # type: ignore

    _HAS_BS4 = True
except ImportError:
    _HAS_BS4 = False

try:
    import cloudscraper  # type: ignore  # pip install cloudscraper

    _HAS_CLOUDSCRAPER = True
except ImportError:
    _HAS_CLOUDSCRAPER = False

try:
    from zoneinfo import ZoneInfo  # stdlib ≥ 3.9

    _SYDNEY_TZ = ZoneInfo("Australia/Sydney")
except Exception:
    _SYDNEY_TZ = None  # type: ignore

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logger = logging.getLogger(__name__)

# pdfminer (used internally by pdfplumber) is extremely chatty at DEBUG level —
# it logs every PDF object it touches.  Clamp it to WARNING so it doesn't drown
# out our own debug output.
for _noisy_lib in ("pdfminer", "pdfminer.pdfpage", "pdfminer.pdfdocument",
                   "pdfminer.pdfinterp", "pdfminer.converter", "pdfminer.cmapdb"):
    logging.getLogger(_noisy_lib).setLevel(logging.WARNING)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DB_PATH_DEFAULT: Path = Path(__file__).parent / "asx_trader.db"

_BROWSER_HEADERS: Dict[str, str] = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;"
        "q=0.9,image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-AU,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

_API_HEADERS: Dict[str, str] = {
    "User-Agent": _BROWSER_HEADERS["User-Agent"],
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-AU,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
}

# Markit Digital API (powers www2.asx.com.au) — primary data source
_MARKIT_BASE = "https://asx.api.markitdigital.com/asx-research/1.0"
_MARKIT_HEADERS: Dict[str, str] = {
    "User-Agent": _BROWSER_HEADERS["User-Agent"],
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-AU,en;q=0.9",
    "Origin": "https://www2.asx.com.au",
    "Referer": "https://www2.asx.com.au/",
}

# Map from Markit announcementType strings → our internal type taxonomy
_MARKIT_TYPE_MAP: Dict[str, str] = {
    "PERIODIC REPORTS": "Earnings",
    "HALF YEARLY REPORT": "Earnings",
    "QUARTERLY REPORT": "Earnings",
    "FULL YEAR RESULTS": "Earnings",
    "ANNUAL REPORT": "Earnings",
    "DIVIDEND": "Dividend",
    "DISTRIBUTION": "Dividend",
    "CAPITAL RAISING": "Capital Raise",
    "CAPITAL MANAGEMENT": "Capital Raise",
    "ISSUED CAPITAL": "Capital Raise",
    "RIGHTS ISSUE": "Capital Raise",
    "PLACEMENT": "Capital Raise",
    "CHANGE OF DIRECTOR": "CEO Change",
    "DIRECTOR CHANGE": "CEO Change",
    "CEO": "CEO Change",
    "MD": "CEO Change",
    "MERGER": "Acquisition",
    "TAKEOVER": "Acquisition",
    "ACQUISITION": "Acquisition",
    "TRADING HALT": "Trading Halt",
    "VOLUNTARY SUSPENSION": "Trading Halt",
    "ASSET SALE": "Asset Sale",
    "DIVESTMENT": "Asset Sale",
    "GUIDANCE": "Guidance Update",
    "OUTLOOK": "Guidance Update",
    "AGM": "AGM",
    "ANNUAL GENERAL MEETING": "AGM",
    "SECURITY HOLDER DETAILS": "Other",
}

_ALLOWED_TYPES = {
    "Earnings",
    "Dividend",
    "Capital Raise",
    "CEO Change",
    "Acquisition",
    "AGM",
    "Trading Halt",
    "Asset Sale",
    "Guidance Update",
    "Other",
}
_ALLOWED_SENTIMENTS = {"positive", "neutral", "negative"}

_KEYWORD_TYPE_MAP: List[tuple] = [
    (["earnings", "profit", "revenue", "ebitda", "npat", "half year", "full year", "quarterly"], "Earnings"),
    (["dividend", "distribution", "dps", "franked"], "Dividend"),
    (["capital raise", "placement", "entitlement", "rights issue", "spp", "share purchase plan"], "Capital Raise"),
    (["ceo", "chief executive", "managing director", "md ", "appointment", "resign"], "CEO Change"),
    (["acquisition", "acquire", "merger", "takeover", "buy", "purchase"], "Acquisition"),
    (["agm", "annual general meeting", "shareholder meeting"], "AGM"),
    (["trading halt", "voluntary suspension", "asx query"], "Trading Halt"),
    (["asset sale", "divestment", "disposal", "sell assets"], "Asset Sale"),
    (["guidance", "outlook", "forecast", "upgrade", "downgrade"], "Guidance Update"),
]

_POSITIVE_WORDS = {
    "profit", "growth", "increase", "record", "strong", "positive", "upgrade",
    "beat", "exceed", "outperform", "dividend", "acquisition", "expand",
    "higher", "improved", "successful", "approved", "awarded",
}
_NEGATIVE_WORDS = {
    "loss", "decline", "decrease", "write-down", "impairment", "downgrade",
    "below", "miss", "underperform", "reduce", "cut", "suspension", "risk",
    "lower", "weak", "challenging", "concern", "deficit",
}

# Models that use chain-of-thought thinking blocks before JSON output.
# Substring match: "qwen3" matches "qwen3.5:9b", "qwen3:8b", etc.
_ANN_THINKING_MODELS = ("qwen3", "qwq", "deepseek-r1", "deepseek-r2", "marco-o1")

_LLM_PROMPT_TEMPLATE = (
    "Analyse this ASX announcement. Reply with valid JSON only, no markdown.\n"
    "Do NOT research or verify what the ticker symbol represents — "
    "classify based solely on the headline and content provided.\n\n"
    "Ticker: {ticker}\n"
    "Headline: {headline}\n"
    "Content: {content}\n\n"
    "Reply with ONLY this JSON (no other text):\n"
    '{{"type":"Earnings|Dividend|Capital Raise|CEO Change|Acquisition|AGM|'
    'Trading Halt|Asset Sale|Guidance Update|Other",'
    '"sentiment":"positive|neutral|negative",'
    '"impact":6,'
    '"summary":"One sentence max 120 chars.",'
    '"tags":["tag1","tag2"]}}'
)

# Richer prompt for PRICE-SENSITIVE announcements — asks for structured keyFigures so
# the UI can render a "Key Info" panel without the user having to read the full PDF.
# keyFigures is an open dict: include only metrics explicitly stated in the content.
# Earnings examples:  {"EPS": "18.4¢", "NPAT": "$120M", "Revenue": "$340M", "vs Prior": "+12%"}
# Dividend examples:  {"Amount": "15¢/share", "Franking": "100%", "Ex-Date": "2026-06-01", "Pay-Date": "2026-06-15"}
# Capital Raise:      {"Raise Amount": "$50M", "Issue Price": "$2.50", "Discount": "8%"}
# Acquisition:        {"Target": "Company X", "Deal Value": "$120M", "Premium": "25%"}
_LLM_PROMPT_TEMPLATE_PS = (
    "Analyse this PRICE-SENSITIVE ASX announcement carefully. "
    "Reply with valid JSON only, no markdown.\n"
    "Do NOT research or verify what the ticker symbol represents — "
    "classify based solely on the headline and content provided.\n\n"
    "Ticker: {ticker}\n"
    "Headline: {headline}\n"
    "Content: {content}\n\n"
    "Reply with ONLY this JSON. Extract keyFigures — only values EXPLICITLY stated in the content "
    "(e.g. EPS, NPAT, revenue, dividend amount, franking %, ex-date, pay-date, "
    "raise amount/price/discount, acquisition value/premium). "
    "Omit any key not mentioned. Use short human-readable keys and values.\n"
    '{{"type":"Earnings|Dividend|Capital Raise|CEO Change|Acquisition|AGM|'
    'Trading Halt|Asset Sale|Guidance Update|Other",'
    '"sentiment":"positive|neutral|negative",'
    '"impact":8,'
    '"summary":"Max 200 chars. Open with the single most important figure or outcome.",'
    '"tags":["tag1","tag2"],'
    '"keyFigures":{{"key":"value"}}}}'
)

# ---------------------------------------------------------------------------
# Sync state (module-level)
# ---------------------------------------------------------------------------
_sync_status: Dict[str, Any] = {
    "running": False,
    "last_run": None,
    "last_count": 0,
    "last_error": None,
    "last_tickers": [],
    # Live progress fields (reset on each run)
    "current_ticker": None,
    "tickers_done": 0,
    "tickers_total": 0,
    "current_ticker_new": 0,  # new announcements found for current ticker
}
_sync_lock = threading.Lock()

_scheduler_thread: Optional[threading.Thread] = None
_last_run_slot: Optional[str] = None  # "HH:MM" of last fired slot

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS announcements (
    id              TEXT PRIMARY KEY,
    ticker          TEXT NOT NULL,
    date            TEXT NOT NULL,
    headline        TEXT,
    pdf_url         TEXT,
    doc_key         TEXT,
    pdf_text        TEXT,
    type            TEXT,
    sentiment       TEXT,
    impact          REAL,
    price_sensitive INTEGER DEFAULT 1,
    summary         TEXT,
    tags            TEXT,
    llm_model       TEXT,
    processed       INTEGER DEFAULT 0,
    fetched_at      TEXT,
    details         TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ann_ticker ON announcements(ticker);
CREATE INDEX IF NOT EXISTS idx_ann_date   ON announcements(date DESC);
CREATE INDEX IF NOT EXISTS idx_ann_ps     ON announcements(price_sensitive);
"""


def init_db(db_path: Optional[str | Path] = None) -> None:
    """Create the announcements table and indexes if they do not exist.

    Also runs a safe ALTER TABLE migration to add the `doc_key` column to
    databases created before this column was introduced.
    """
    path = str(db_path or DB_PATH_DEFAULT)
    with sqlite3.connect(path) as conn:
        conn.executescript(_CREATE_TABLE_SQL)
        # Safe migrations — no-op if column already exists
        for col_def, label in [
            ("ALTER TABLE announcements ADD COLUMN doc_key      TEXT", "doc_key"),
            ("ALTER TABLE announcements ADD COLUMN details      TEXT", "details"),
        ]:
            try:
                conn.execute(col_def)
                conn.commit()
                logger.info("announcement_engine: migrated — added %s column", label)
            except sqlite3.OperationalError:
                pass  # Column already exists
        conn.commit()
    logger.info("announcement_engine: DB initialised at %s", path)


@contextmanager
def get_db(db_path: Optional[str | Path] = None) -> Generator[sqlite3.Connection, None, None]:
    """Context manager: yields a WAL-mode sqlite3 connection with row_factory.

    Commits on success, rolls back on exception, always closes.
    """
    path = str(db_path or DB_PATH_DEFAULT)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Scraping helpers
# ---------------------------------------------------------------------------

def _sydney_now() -> datetime:
    """Return current datetime in Sydney timezone."""
    if _SYDNEY_TZ is not None:
        return datetime.now(_SYDNEY_TZ)
    # Fallback: UTC+10 naive (AEST, ignoring DST)
    return datetime.utcnow() + timedelta(hours=10)


def _make_ann_id(ticker: str, date: str, headline: str) -> str:
    raw = f"{ticker}:{date}:{headline}"
    return hashlib.md5(raw.encode()).hexdigest()





def _parse_date_str(raw: str) -> Optional[str]:
    """Try to parse a date string into YYYY-MM-DD format."""
    raw = raw.strip()
    for fmt in (
        "%Y-%m-%d",
        "%d/%m/%Y",
        "%d %b %Y",
        "%d %B %Y",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%d-%m-%Y",
    ):
        try:
            return datetime.strptime(raw[:len(fmt) + 2], fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # Try ISO prefix
    m = re.match(r"(\d{4}-\d{2}-\d{2})", raw)
    if m:
        return m.group(1)
    return None


def _is_recent(date_str: str, days: int) -> bool:
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        cutoff = datetime.utcnow().date() - timedelta(days=days)
        return dt.date() >= cutoff
    except Exception:
        return False


def _normalise_pdf_url(url: str, base: str = "https://www.asx.com.au") -> str:
    if not url:
        return ""
    if url.startswith("http"):
        return url
    if url.startswith("/"):
        return base.rstrip("/") + url
    return base + "/" + url


# ---------------------------------------------------------------------------
# Strategy 1 — Markit Digital API (primary — powers www2.asx.com.au)
# ---------------------------------------------------------------------------

def _markit_pdf_url(doc_key: str, date_str: str) -> str:
    """Construct a direct ASX PDF URL from a Markit documentKey.

    documentKey format: "2924-{idsId}-{markitXid}"  e.g. "2924-03088504-3A693022"
    The middle part is the ASX numeric idsId which doubles as the filename for
    the majority of announcements on the announcements.asx.com.au CDN.

    NOTE: A small subset of announcements (ASX new MAP system) use an opaque hex
    filename (e.g. "06zp2v2khtz6kr") that cannot be derived from the idsId.
    Those announcements will still fail to download via this URL; they need the
    Markit url field (currently always empty) or another source.
    """
    if not doc_key:
        return ""
    parts = doc_key.split("-")
    if len(parts) < 2:
        return ""
    ids_id = parts[1]  # e.g. "03088504"
    # Use the direct CDN URL — works within ~2 days of publication.
    # date_str is "YYYY-MM-DD"; CDN path uses "YYYYMMDD".
    date_compact = date_str.replace("-", "") if date_str else ""
    if date_compact:
        return f"https://announcements.asx.com.au/asxpdf/{date_compact}/pdf/{ids_id}.pdf"
    # No date → fall back to the displayAnnouncement.do redirect chain
    return f"https://www.asx.com.au/asx/statistics/displayAnnouncement.do?display=pdf&idsId={ids_id}"


# Cache for todayAnns.do HTML — reused within the same sync run to avoid
# re-fetching the 681KB page once per announcement.
_todayanns_cache: Dict[str, Any] = {"text": None, "fetched_at": 0.0}
_TODAYANNS_CACHE_TTL = 300  # seconds (5 min — announcements page refreshes slowly)


def _fetch_todayanns_pdf_url(ticker: str, headline: str = "", date: str = "") -> str:
    """Find the real PDF URL for a TODAY announcement via ASX's v2 endpoints.

    Two-step process (no browser required — both URLs return plain HTML via requests):

    Step 1 — ``todayAnns.do``
        Fetches https://www.asx.com.au/asx/v2/statistics/todayAnns.do, which
        returns a 600KB+ HTML page listing all of today's announcements.  We
        parse the table rows to find the one whose ticker + headline matches
        and extract the numeric ``idsId`` from the ``displayAnnouncement.do``
        link embedded in the row.  The response is cached for 5 minutes so a
        full sync run with many tickers only pays for one HTTP request.

    Step 2 — ``displayAnnouncement.do`` (v2)
        Fetches https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do
        ?display=pdf&idsId={idsId}, which returns another small HTML page
        containing the real ``announcements.asx.com.au/asxpdf/…pdf`` URL
        (including hex-filename MAP-system PDFs that cannot be inferred from
        the idsId alone).

    Returns the real PDF URL, or an empty string on any failure.
    """
    if not ticker:
        return ""

    _HDRS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Referer": "https://www.asx.com.au/",
    }

    # ------------------------------------------------------------------ Step 1
    try:
        now = time.time()
        if (
            _todayanns_cache["text"] is None
            or (now - _todayanns_cache["fetched_at"]) > _TODAYANNS_CACHE_TTL
        ):
            resp = requests.get(
                "https://www.asx.com.au/asx/v2/statistics/todayAnns.do",
                headers=_HDRS,
                timeout=(10, 30),
            )
            if resp.status_code != 200:
                logger.debug("_fetch_todayanns_pdf_url: todayAnns.do HTTP %s", resp.status_code)
                return ""
            _todayanns_cache["text"] = resp.text
            _todayanns_cache["fetched_at"] = now
            logger.debug(
                "_fetch_todayanns_pdf_url: fetched todayAnns.do (%d bytes)",
                len(resp.content),
            )
        else:
            logger.debug("_fetch_todayanns_pdf_url: using cached todayAnns.do")

        html_text = _todayanns_cache["text"]

        # Parse with BeautifulSoup if available; otherwise use regex
        ids_id = ""
        if _HAS_BS4:
            from bs4 import BeautifulSoup as _BS4
            soup = _BS4(html_text, "html.parser")
            # Each row contains the ticker code in one cell and a link to
            # displayAnnouncement.do?…&idsId=XXXXXXXX in another.
            ticker_upper = ticker.upper()
            headline_lc = headline.lower().strip()
            for row in soup.find_all("tr"):
                cells = row.find_all("td")
                if not cells:
                    continue
                row_text = row.get_text(" ", strip=True)
                # Quick pre-filter: ticker must appear in the row
                if ticker_upper not in row_text.upper():
                    continue
                # Headline match (case-insensitive, allow partial for truncated cells)
                if headline_lc and headline_lc[:40] not in row_text.lower():
                    continue
                # Find displayAnnouncement link in this row
                for a in row.find_all("a", href=True):
                    href = a["href"]
                    m = re.search(r"idsId=(\d+)", href)
                    if m:
                        ids_id = m.group(1)
                        logger.debug(
                            "_fetch_todayanns_pdf_url: found idsId=%s for %s / %s",
                            ids_id, ticker, headline[:60],
                        )
                        break
                if ids_id:
                    break
        else:
            # Regex fallback — look for the ticker near a displayAnnouncement link
            ticker_upper = ticker.upper()
            # Find all displayAnnouncement.do links and their surrounding context
            for m in re.finditer(
                r"displayAnnouncement\.do[^\"']*idsId=(\d+)", html_text
            ):
                start = max(0, m.start() - 500)
                ctx = html_text[start : m.end()]
                if ticker_upper in ctx.upper():
                    if not headline or headline[:30].lower() in ctx.lower():
                        ids_id = m.group(1)
                        logger.debug(
                            "_fetch_todayanns_pdf_url: regex found idsId=%s for %s",
                            ids_id, ticker,
                        )
                        break

        if not ids_id:
            logger.debug(
                "_fetch_todayanns_pdf_url: no idsId found for %s / %s",
                ticker, headline[:60],
            )
            return ""

    except Exception as exc:
        logger.debug("_fetch_todayanns_pdf_url [step1] failed: %s", exc)
        return ""

    # ------------------------------------------------------------------ Step 2
    try:
        viewer_url = (
            f"https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do"
            f"?display=pdf&idsId={ids_id}"
        )
        resp2 = requests.get(viewer_url, headers=_HDRS, timeout=(10, 20))
        if resp2.status_code != 200:
            logger.debug(
                "_fetch_todayanns_pdf_url [step2]: HTTP %s for idsId=%s",
                resp2.status_code, ids_id,
            )
            return ""

        # Extract all asxpdf URLs from the HTML
        pdf_urls = re.findall(
            r"https?://announcements\.asx\.com\.au/asxpdf/[^\s\"'<>]+\.pdf",
            resp2.text,
        )
        if pdf_urls:
            pdf_url = pdf_urls[0]
            logger.debug(
                "_fetch_todayanns_pdf_url: resolved %s / %s → %s",
                ticker, headline[:60], pdf_url,
            )
            return pdf_url

        logger.debug(
            "_fetch_todayanns_pdf_url [step2]: no asxpdf URL found for idsId=%s (response %d bytes)",
            ids_id, len(resp2.content),
        )
    except Exception as exc:
        logger.debug("_fetch_todayanns_pdf_url [step2] failed: %s", exc)

    return ""


def _fetch_markit_doc_key(ticker: str, headline: str = "", date: str = "") -> tuple:
    """Query Markit API to recover the documentKey (and direct PDF URL) for an announcement.

    Used as a fallback at PDF-serve time when doc_key was not stored (records
    synced before the doc_key column was introduced), or when the stored URL is stale.

    Returns (doc_key, pdf_url) tuple — either or both may be empty strings.
    """
    if not ticker:
        return ("", "")
    session = requests.Session()
    session.headers.update(_MARKIT_HEADERS)
    try:
        url = f"{_MARKIT_BASE}/companies/{ticker.upper()}/announcements"
        resp = session.get(url, timeout=15)
        if resp.status_code != 200:
            return ("", "")
        items = resp.json().get("data", {}).get("items", [])
        for item in items:
            dk = str(item.get("documentKey", "")).strip()
            if not dk:
                continue
            item_headline = str(item.get("headline", "")).strip()
            item_date = _parse_date_str(str(item.get("date", ""))) or ""
            matched = False
            # Exact headline match
            if item_headline == headline:
                logger.debug("_fetch_markit_doc_key: matched by headline for %s → %s", ticker, dk)
                matched = True
            # Fuzzy: same date + headline prefix (first 40 chars)
            elif date and item_date == date and item_headline[:40] == headline[:40]:
                logger.debug("_fetch_markit_doc_key: matched by date+prefix for %s → %s", ticker, dk)
                matched = True
            if matched:
                # Log the raw url value so we can see exactly what Markit returns
                raw_url_val = item.get("url")
                logger.debug(
                    "_fetch_markit_doc_key: item keys=%s | url=%r",
                    list(item.keys()), raw_url_val,
                )
                # Also capture direct PDF URL if Markit returns one
                direct_url = (
                    item.get("url") or item.get("pdfUrl") or
                    item.get("downloadUrl") or item.get("documentUrl") or ""
                )
                if direct_url:
                    logger.debug("_fetch_markit_doc_key: direct URL for %s → %s", ticker, direct_url)
                return (dk, str(direct_url).strip())
    except Exception as exc:
        logger.debug("_fetch_markit_doc_key failed for %s: %s", ticker, exc)
    return ("", "")


def _markit_type(raw_type: str) -> str:
    """Convert a Markit announcementType string to our internal type taxonomy."""
    upper = raw_type.upper()
    for key, val in _MARKIT_TYPE_MAP.items():
        if key in upper:
            return val
    return "Other"


def _strategy_markit(ticker: str, days: int) -> List[Dict]:
    """Primary strategy: Markit Digital API — the data backbone of www2.asx.com.au.

    Public endpoint, no auth required. Returns the ~5 most recent announcements
    for the company with isPriceSensitive, announcementType, date, documentKey.
    """
    session = requests.Session()
    session.headers.update(_MARKIT_HEADERS)

    url = f"{_MARKIT_BASE}/companies/{ticker.upper()}/announcements"
    try:
        resp = session.get(url, timeout=15)
        logger.debug("Markit API %s → HTTP %s", ticker, resp.status_code)
        if resp.status_code != 200:
            return []
        data = resp.json()
    except Exception as exc:
        logger.debug("_strategy_markit failed for %s: %s", ticker, exc)
        return []

    items = data.get("data", {}).get("items", [])
    if not isinstance(items, list):
        return []

    results: List[Dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue

        # Date — ISO 8601 from API e.g. "2026-05-10T22:15:14.000Z"
        date_raw = item.get("date", "")
        date_str = _parse_date_str(str(date_raw)) if date_raw else None
        if not date_str or not _is_recent(date_str, days):
            continue

        headline = str(item.get("headline", "")).strip()
        if not headline:
            continue

        is_price_sensitive = bool(item.get("isPriceSensitive", False))
        raw_ann_type = str(item.get("announcementType", "")).strip()
        doc_key = str(item.get("documentKey", "")).strip()

        # Prefer a direct URL from the API response — covers cases where
        # displayAnnouncement.do no longer redirects to the real PDF.
        # Fall back to constructing from documentKey if no direct URL present.
        direct_url = (
            item.get("url") or item.get("pdfUrl") or
            item.get("downloadUrl") or item.get("documentUrl") or ""
        )
        pdf_url = str(direct_url).strip() if direct_url else _markit_pdf_url(doc_key, date_str)
        if direct_url:
            logger.debug("_strategy_markit: using direct URL for %s: %s", ticker, pdf_url)
        else:
            # Log the url field value so we know if/when Markit starts returning it
            logger.debug(
                "_strategy_markit: no direct URL for %s (url=%r, keys=%s)",
                ticker, item.get("url"), list(item.keys()),
            )

        results.append({
            "id": _make_ann_id(ticker, date_str, headline),
            "ticker": ticker.upper(),
            "date": date_str,
            "headline": headline,
            "pdf_url": pdf_url,
            "price_sensitive": 1 if is_price_sensitive else 0,
            "_markit_type": raw_ann_type,   # used by run_sync for pre-classification
            "_doc_key": doc_key,
        })

    logger.debug("_strategy_markit %s: %d items (%d days)", ticker, len(results), days)
    return results


# ---------------------------------------------------------------------------
# Strategy 2 — cloudscraper on marketindex.com.au (bypasses Cloudflare)
# ---------------------------------------------------------------------------

def _strategy_cloudscraper(ticker: str, days: int) -> List[Dict]:
    """Use the cloudscraper library to bypass Cloudflare on marketindex.com.au.
    Requires:  pip install cloudscraper"""
    if not _HAS_CLOUDSCRAPER or not _HAS_BS4:
        return []

    try:
        cs = cloudscraper.create_scraper(
            browser={"browser": "chrome", "platform": "windows", "mobile": False}
        )
    except Exception as exc:
        logger.debug("cloudscraper init failed: %s", exc)
        return []

    results: List[Dict] = []

    # Try the Next.js embedded JSON first
    url = f"https://www.marketindex.com.au/asx/{ticker.lower()}"
    try:
        resp = cs.get(url, timeout=30)
        if resp.status_code == 200:
            m = re.search(
                r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
                resp.text, re.DOTALL,
            )
            if m:
                page_data = json.loads(m.group(1))
                page_props = page_data.get("props", {}).get("pageProps", {})
                for key in ("announcements", "priceAnnouncements", "companyAnnouncements"):
                    val = page_props.get(key)
                    if isinstance(val, list) and val:
                        return _normalise_raw_list(val, ticker, days, base="https://www.marketindex.com.au")
                # Deeper nesting
                for _v in page_props.values():
                    if isinstance(_v, dict):
                        for key2 in ("announcements", "priceAnnouncements"):
                            val2 = _v.get(key2)
                            if isinstance(val2, list) and val2:
                                return _normalise_raw_list(val2, ticker, days, base="https://www.marketindex.com.au")
    except Exception as exc:
        logger.debug("cloudscraper strategy failed for %s: %s", ticker, exc)

    return results


# ---------------------------------------------------------------------------
# Strategy 3 — listcorp.com (no Cloudflare, aggregates ASX data)
# ---------------------------------------------------------------------------

def _strategy_listcorp(ticker: str, days: int) -> List[Dict]:
    """Scrape listcorp.com/asx/{ticker}/news — generally accessible."""
    if not _HAS_BS4:
        return []

    session = requests.Session()
    session.headers.update(_BROWSER_HEADERS)

    url = f"https://www.listcorp.com/asx/{ticker.lower()}/news"
    try:
        resp = session.get(url, timeout=20)
        if resp.status_code != 200:
            logger.debug("listcorp returned %s for %s", resp.status_code, ticker)
            return []
    except Exception as exc:
        logger.debug("listcorp fetch failed for %s: %s", ticker, exc)
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    results: List[Dict] = []

    # Listcorp renders announcements as article/li elements or a table
    for container in soup.find_all(
        lambda tag: tag.name in ("article", "li", "tr", "div")
        and re.search(r"news|announce|release", " ".join(tag.get("class") or []), re.I)
    ):
        ann = _parse_generic_container(container, ticker, base="https://www.listcorp.com")
        if ann and _is_recent(ann["date"], days):
            results.append(ann)

    # Also try any plain table rows (some listcorp pages use a table layout)
    if not results:
        for table in soup.find_all("table"):
            for row in table.find_all("tr")[1:]:
                cells = row.find_all(["td", "th"])
                if len(cells) < 2:
                    continue
                ann = _parse_table_row(cells, ticker, base="https://www.listcorp.com")
                if ann and _is_recent(ann["date"], days):
                    results.append(ann)

    return results


# ---------------------------------------------------------------------------
# HTML parsing helpers (used by listcorp + cloudscraper HTML fallback)
# ---------------------------------------------------------------------------

def _parse_table_row(cells, ticker: str, base: str = "https://www.asx.com.au") -> Optional[Dict]:
    """Best-effort parse of a table row into an announcement dict."""
    text_cells = [c.get_text(strip=True) for c in cells]
    date_str: Optional[str] = None
    headline: Optional[str] = None
    pdf_url: Optional[str] = None

    for cell_text in text_cells:
        parsed = _parse_date_str(cell_text)
        if parsed and not date_str:
            date_str = parsed
        elif len(cell_text) > 15 and not headline:
            headline = cell_text

    for cell in cells:
        link = cell.find("a", href=True)
        if link and ".pdf" in link["href"].lower():
            pdf_url = _normalise_pdf_url(link["href"], base)
            if not headline:
                headline = link.get_text(strip=True)

    if not date_str or not headline:
        return None

    return {
        "id": _make_ann_id(ticker, date_str, headline),
        "ticker": ticker.upper(),
        "date": date_str,
        "headline": headline,
        "pdf_url": pdf_url,
        "price_sensitive": 1,
    }


def _parse_generic_container(tag, ticker: str, base: str = "https://www.asx.com.au") -> Optional[Dict]:
    """Parse an announcement div/article container."""
    text = tag.get_text(" ", strip=True)
    date_m = re.search(r"\d{1,2}[/ ]\w+[/ ]\d{4}|\d{4}-\d{2}-\d{2}|\d{2}/\d{2}/\d{4}", text)
    date_str = _parse_date_str(date_m.group()) if date_m else None
    headline_tag = tag.find(["h2", "h3", "h4", "a"])
    headline = headline_tag.get_text(strip=True) if headline_tag else text[:120]
    link_tag = tag.find("a", href=re.compile(r"\.pdf", re.I))
    pdf_url = _normalise_pdf_url(link_tag["href"], base) if link_tag else None

    if not date_str or not headline:
        return None

    return {
        "id": _make_ann_id(ticker, date_str, headline),
        "ticker": ticker.upper(),
        "date": date_str,
        "headline": headline,
        "pdf_url": pdf_url,
        "price_sensitive": 1,
    }


# ---------------------------------------------------------------------------
# Normalise raw JSON list (used by cloudscraper Next.js parsing)
# ---------------------------------------------------------------------------

def _normalise_raw_list(raw: List[Any], ticker: str, days: int,
                        base: str = "https://www.asx.com.au") -> List[Dict]:
    results: List[Dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        date_str = None
        for k in ("date", "announcementDate", "announcement_date", "released", "releasedAt", "time"):
            val = item.get(k, "")
            if val:
                date_str = _parse_date_str(str(val))
                if date_str:
                    break
        if not date_str or not _is_recent(date_str, days):
            continue

        # Price sensitive filter
        ps_val = (
            item.get("price_sensitive")
            or item.get("priceSensitive")
            or item.get("market_sensitive")
            or item.get("sensitive")
        )
        if ps_val is not None:
            if isinstance(ps_val, bool) and not ps_val:
                continue
            if isinstance(ps_val, int) and ps_val == 0:
                continue
            if isinstance(ps_val, str) and ps_val.lower() in ("false", "0", "no", "n"):
                continue

        headline = None
        for k in ("headline", "header", "title", "subject", "description"):
            v = item.get(k, "")
            if v and isinstance(v, str):
                headline = v.strip()
                break
        if not headline:
            continue

        pdf_url = None
        for k in ("url", "pdfUrl", "pdf_url", "documentUrl", "document_url", "link"):
            v = item.get(k, "")
            if v and isinstance(v, str):
                pdf_url = _normalise_pdf_url(v, base)
                break

        results.append({
            "id": _make_ann_id(ticker, date_str, headline),
            "ticker": ticker.upper(),
            "date": date_str,
            "headline": headline,
            "pdf_url": pdf_url,
            "price_sensitive": 1,
        })
    return results


# ---------------------------------------------------------------------------
# Main fetch function — try strategies in order, return first hit
# ---------------------------------------------------------------------------

def fetch_announcements(ticker: str, days: int = 3) -> List[Dict]:
    """Fetch announcements for *ticker* using 3 strategies in order:
    1. Markit Digital API (asx.api.markitdigital.com) — primary, public, no CF
    2. cloudscraper on marketindex.com.au  (if cloudscraper installed)
    3. listcorp.com  (plain HTML, last-resort fallback)

    Returns all announcements regardless of isPriceSensitive; the caller decides
    what to store. Each item contains 'price_sensitive' (0/1) from source.
    """
    strategies = [
        ("markit",        lambda t, d: _strategy_markit(t, d)),
        ("cloudscraper",  lambda t, d: _strategy_cloudscraper(t, d)),
        ("listcorp",      lambda t, d: _strategy_listcorp(t, d)),
    ]

    for name, fn in strategies:
        try:
            results = fn(ticker, days)
            if results:
                logger.info(
                    "fetch_announcements: %s — strategy '%s' returned %d items",
                    ticker, name, len(results),
                )
                return results
        except Exception as exc:
            logger.warning(
                "fetch_announcements: %s strategy '%s' raised: %s", ticker, name, exc
            )
        time.sleep(0.3)

    logger.info("fetch_announcements: %s — no announcements found", ticker)
    return []


# ---------------------------------------------------------------------------
# PDF download + text extraction
# ---------------------------------------------------------------------------

def _is_real_pdf(data: bytes) -> bool:
    """Return True if data starts with the PDF magic bytes (%PDF-)."""
    return data[:5] == b"%PDF-"


def _extract_pdf_link_from_html(html: bytes) -> Optional[str]:
    """Try to find a direct PDF/csf URL embedded in an HTML redirect page."""
    if not _HAS_BS4:
        # Fallback: crude regex scan
        text = html.decode("utf-8", errors="replace")
        m = re.search(r'https://csf\.asx\.com\.au/[^\s"\'<>]+\.pdf[^\s"\'<>]*', text)
        if m:
            return m.group(0)
        m = re.search(r'https://[^\s"\'<>]+\.pdf[^\s"\'<>]*', text)
        return m.group(0) if m else None

    soup = BeautifulSoup(html, "html.parser")
    # 1. meta refresh: <meta http-equiv="refresh" content="0; url=...">
    for tag in soup.find_all("meta", attrs={"http-equiv": re.compile("refresh", re.I)}):
        content = tag.get("content", "")
        m = re.search(r"url=(.+)", content, re.I)
        if m:
            return m.group(1).strip().strip("'\"")
    # 2. Direct <a href="...pdf...">
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if ".pdf" in href.lower():
            return href
    # 3. iframe/embed src
    for tag in soup.find_all(["iframe", "embed"], src=True):
        if ".pdf" in tag["src"].lower():
            return tag["src"]
    return None


def download_pdf(
    url: str,
    doc_key: str = "",
    ticker: str = "",
    headline: str = "",
    date: str = "",
) -> Optional[bytes]:
    """Download a PDF from `url` and return raw bytes, or None on failure.

    Strategy (all responses validated with %PDF- magic bytes):
      0.  If doc_key is empty but ticker is known, re-query Markit API to recover it.
      0b. Markit document metadata endpoint (/documents/{doc_key}) — may return a url field.
      1.  Markit documents API: /asx-research/1.0/documents/{doc_key}/download
      2.  Stored pdf_url (direct CDN link or displayAnnouncement.do) with allow_redirects.
          If response is HTML, parse it for an announcements.asx.com.au CDN link and retry.
      2b. Construct direct CDN URL from doc_key idsId + date (covers old displayAnnouncement
          records and numeric-filename PDFs within ~2 days of publication).
      3.  Reconstruct displayAnnouncement.do from doc_key idsId (old system, last resort).
      4.  Scrape ASX company announcements HTML page for asxpdf links matching the idsId.
      5.  todayAnns.do + v2 displayAnnouncement viewer — resolves hex MAP-system filenames
          that cannot be inferred from the idsId.  Works for today's announcements only.
    """
    _PDF_HEADERS = {
        **_BROWSER_HEADERS,
        "Accept": "application/pdf,application/octet-stream,*/*",
        "Referer": "https://www.asx.com.au/",
    }

    def _fetch(target_url: str, label: str) -> Optional[bytes]:
        try:
            resp = requests.get(
                target_url,
                headers=_PDF_HEADERS,
                timeout=(15, 30),
                allow_redirects=True,
            )
            if resp.status_code == 200 and resp.content:
                if _is_real_pdf(resp.content):
                    logger.debug("download_pdf [%s]: real PDF (%d bytes)", label, len(resp.content))
                    return resp.content
                # Got HTML — try to extract a direct CDN link
                cdn_url = _extract_pdf_link_from_html(resp.content)
                if cdn_url:
                    logger.debug("download_pdf [%s]: HTML redirect → CDN %s", label, cdn_url)
                    try:
                        r2 = requests.get(cdn_url, headers=_PDF_HEADERS, timeout=(15, 30), allow_redirects=True)
                        if r2.status_code == 200 and r2.content and _is_real_pdf(r2.content):
                            logger.debug("download_pdf [%s→CDN]: real PDF (%d bytes)", label, len(r2.content))
                            return r2.content
                    except Exception as exc2:
                        logger.debug("download_pdf CDN retry failed: %s", exc2)
                logger.debug("download_pdf [%s]: HTML page, not a PDF (content-type: %s)",
                             label, resp.headers.get("content-type", "?"))
            else:
                logger.debug("download_pdf [%s]: HTTP %s for %s", label, resp.status_code, target_url)
        except Exception as exc:
            logger.warning("download_pdf [%s]: %s — %s", label, target_url, exc)
        return None

    # Strategy 0: if doc_key is empty, try to recover it live from Markit API.
    # Also capture any direct PDF URL the API returns — the displayAnnouncement.do
    # redirect chain no longer works; the Markit response may include the real URL.
    markit_direct_url = ""
    if not doc_key and ticker:
        logger.debug("download_pdf: doc_key missing, querying Markit for %s", ticker)
        doc_key, markit_direct_url = _fetch_markit_doc_key(ticker, headline=headline, date=date)
        if doc_key:
            logger.debug("download_pdf: recovered doc_key=%s for %s", doc_key, ticker)
        if markit_direct_url:
            result = _fetch(markit_direct_url, "markit-direct-url")
            if result:
                return result

    # Strategy 0b: Markit document metadata endpoint (no /download suffix).
    # May return JSON with a url/downloadUrl field pointing to the real PDF.
    if doc_key:
        meta_url = (
            f"https://asx.api.markitdigital.com/asx-research/1.0/documents/{doc_key}"
        )
        try:
            r_meta = requests.get(
                meta_url,
                headers=_MARKIT_HEADERS,
                timeout=(10, 20),
                allow_redirects=True,
            )
            logger.debug("download_pdf [markit-meta]: HTTP %s for %s", r_meta.status_code, meta_url)
            if r_meta.status_code == 200 and r_meta.content:
                try:
                    meta_body = r_meta.json()
                    # Navigate common response shapes
                    meta_data = meta_body.get("data") or meta_body
                    if isinstance(meta_data, dict):
                        cdn_url = (
                            meta_data.get("url") or meta_data.get("downloadUrl") or
                            meta_data.get("pdfUrl") or meta_data.get("documentUrl") or ""
                        )
                        if cdn_url:
                            logger.debug("download_pdf [markit-meta]: got URL → %s", cdn_url)
                            result = _fetch(cdn_url, "markit-meta-url")
                            if result:
                                return result
                except Exception:
                    pass
        except Exception as exc:
            logger.debug("download_pdf [markit-meta] failed: %s", exc)

    # Strategy 1: Markit documents API — do NOT follow redirects; capture the
    # csf.asx.com.au CDN URL from the Location header and fetch that separately.
    # Following the redirect with our headers causes csf to reject the request.
    if doc_key:
        markit_dl_url = (
            f"https://asx.api.markitdigital.com/asx-research/1.0/documents"
            f"/{doc_key}/download"
        )
        try:
            r0 = requests.get(
                markit_dl_url,
                headers=_MARKIT_HEADERS,
                timeout=(15, 30),
                allow_redirects=False,
            )
            logger.debug("download_pdf [markit-api]: HTTP %s for %s", r0.status_code, markit_dl_url)
            if r0.status_code == 200 and r0.content and _is_real_pdf(r0.content):
                # Unlikely but handle direct PDF response
                logger.debug("download_pdf [markit-api]: direct PDF (%d bytes)", len(r0.content))
                return r0.content
            elif r0.status_code in (301, 302, 303, 307, 308):
                cdn_url = r0.headers.get("Location", "")
                logger.debug("download_pdf [markit-api]: redirect → %s", cdn_url)
                if cdn_url:
                    result = _fetch(cdn_url, "markit-cdn")
                    if result:
                        return result
            elif r0.status_code == 200 and r0.content:
                # JSON response? Try to extract a URL field
                try:
                    body = r0.json()
                    cdn_url = (
                        body.get("url") or body.get("downloadUrl")
                        or body.get("data", {}).get("url", "")
                    )
                    if cdn_url:
                        result = _fetch(cdn_url, "markit-json-url")
                        if result:
                            return result
                except Exception:
                    pass
                # Treat response body as potential HTML page with embedded link
                cdn_url = _extract_pdf_link_from_html(r0.content)
                if cdn_url:
                    result = _fetch(cdn_url, "markit-html-cdn")
                    if result:
                        return result
        except Exception as exc:
            logger.warning("download_pdf [markit-api]: %s — %s", markit_dl_url, exc)

    # Strategy 2: stored pdf_url (direct CDN link or displayAnnouncement.do)
    if url:
        result = _fetch(url, "stored-url")
        if result:
            return result

    # Strategy 2b: try direct CDN URL constructed from doc_key + date when the
    # stored URL is the dead displayAnnouncement.do format.
    # New syncs will already store the CDN URL; this covers old records.
    if doc_key and date and "displayAnnouncement" in url:
        parts = doc_key.split("-")
        if len(parts) >= 2:
            ids_id = parts[1]
            date_compact = date.replace("-", "")
            cdn_direct = (
                f"https://announcements.asx.com.au/asxpdf/{date_compact}/pdf/{ids_id}.pdf"
            )
            if cdn_direct != url:
                result = _fetch(cdn_direct, "cdn-direct")
                if result:
                    return result

    # Strategy 3: reconstruct displayAnnouncement.do from doc_key idsId
    # (kept as last resort — ASX may still serve some older docs this way)
    if doc_key:
        parts = doc_key.split("-")
        if len(parts) >= 2:
            ids_id = parts[1]
            alt_url = (
                f"https://www.asx.com.au/asx/statistics/"
                f"displayAnnouncement.do?display=pdf&idsId={ids_id}"
            )
            result = _fetch(alt_url, "display-ann-alt")
            if result:
                return result

    # Strategy 4: scrape the ASX company announcements HTML page to find the real
    # announcements.asx.com.au/asxpdf/ URL.  The displayAnnouncement.do redirect
    # no longer works; the hex PDF filename is only visible in the HTML page.
    # Uses idsId extracted from doc_key to match the announcement row.
    if ticker and doc_key:
        ids_id = doc_key.split("-")[1] if "-" in doc_key else ""
        if ids_id:
            try:
                asx_page = f"https://www.asx.com.au/asx/statistics/announcements.do?ASXCode={ticker.upper()}"
                resp_html = requests.get(
                    asx_page,
                    headers=_BROWSER_HEADERS,
                    timeout=(10, 20),
                    allow_redirects=True,
                )
                if resp_html.status_code == 200:
                    from bs4 import BeautifulSoup
                    soup = BeautifulSoup(resp_html.content, "html.parser")
                    for a in soup.find_all("a", href=True):
                        href = a["href"]
                        # Match any asxpdf link that contains the idsId OR the hex name
                        if "asxpdf" in href and ".pdf" in href:
                            # Normalise to absolute URL
                            if href.startswith("/"):
                                href = "https://www.asx.com.au" + href
                            elif href.startswith("//"):
                                href = "https:" + href
                            # Prefer links whose path contains the numeric idsId
                            if ids_id in href:
                                logger.debug("download_pdf [asx-scrape]: idsId match → %s", href)
                                result = _fetch(href, "asx-scrape")
                                if result:
                                    return result
                    # No idsId match — try every asxpdf link (headline match via date)
                    if date:
                        date_compact = date.replace("-", "")  # "20260518"
                        for a in soup.find_all("a", href=True):
                            href = a["href"]
                            if "asxpdf" in href and date_compact in href and ".pdf" in href:
                                if href.startswith("/"):
                                    href = "https://www.asx.com.au" + href
                                logger.debug("download_pdf [asx-scrape-date]: date match → %s", href)
                                result = _fetch(href, "asx-scrape-date")
                                if result:
                                    return result
            except Exception as exc:
                logger.debug("download_pdf [asx-scrape] failed: %s", exc)

    # Strategy 5: todayAnns.do + v2 displayAnnouncement viewer.
    # Handles MAP-system hex PDF filenames that cannot be derived from the idsId.
    # Works for today's announcements (todayAnns.do only lists today's items).
    if ticker:
        try:
            todayanns_url = _fetch_todayanns_pdf_url(ticker, headline=headline, date=date)
            if todayanns_url:
                result = _fetch(todayanns_url, "todayanns-v2")
                if result:
                    return result
        except Exception as exc:
            logger.debug("download_pdf [todayanns-v2] failed: %s", exc)

    logger.info("download_pdf: all strategies exhausted for url=%s doc_key=%s ticker=%s",
                url, doc_key, ticker)
    return None


def extract_text(pdf_bytes: bytes) -> str:
    """Extract text from PDF bytes using pdfplumber → pymupdf → OCR fallback."""
    text = ""

    # --- Strategy A: pdfplumber ---
    if _HAS_PDFPLUMBER:
        try:
            import io

            with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
                parts = [page.extract_text() or "" for page in pdf.pages]
            candidate = "\n".join(parts).strip()
            if len(candidate) > 100:
                return candidate
            text = candidate  # keep for later comparison
        except Exception as exc:
            logger.debug("extract_text pdfplumber failed: %s", exc)

    # --- Strategy B: PyMuPDF (fitz) ---
    if _HAS_FITZ:
        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            parts = [page.get_text() for page in doc]
            doc.close()
            candidate = "\n".join(parts).strip()
            if len(candidate) > 100:
                return candidate
            if len(candidate) > len(text):
                text = candidate

            # --- Strategy C: OCR fallback (text < 50 chars/page avg) ---
            if _HAS_OCR:
                num_pages = len(parts)
                avg_chars = len(candidate) / max(num_pages, 1)
                if avg_chars < 50:
                    ocr_parts: List[str] = []
                    doc2 = fitz.open(stream=pdf_bytes, filetype="pdf")
                    for page in doc2:
                        pix = page.get_pixmap(dpi=200)
                        img_bytes = pix.tobytes("png")
                        img = Image.open(_io.BytesIO(img_bytes))
                        ocr_parts.append(pytesseract.image_to_string(img))
                    doc2.close()
                    ocr_text = "\n".join(ocr_parts).strip()
                    if len(ocr_text) > 100:
                        return ocr_text
        except Exception as exc:
            logger.debug("extract_text fitz/OCR failed: %s", exc)

    return text


# ---------------------------------------------------------------------------
# LLM classification
# ---------------------------------------------------------------------------

def _build_prompt(ticker: str, headline: str, pdf_text: str,
                  price_sensitive: bool = False) -> str:
    # PS announcements get more context for key figure extraction; non-PS still
    # gets enough to capture full trading-update / guidance bodies (cover letter
    # is ~500 chars; substantive content another 1000+).
    max_chars = 2000 if price_sensitive else 1800
    content = (pdf_text or headline)[:max_chars].replace("\n", " ").strip()
    template = _LLM_PROMPT_TEMPLATE_PS if price_sensitive else _LLM_PROMPT_TEMPLATE
    return template.format(ticker=ticker, headline=headline, content=content)


def _robust_json_parse(raw: str) -> Optional[Dict]:
    """Parse JSON from LLM output, repairing the most common failure modes.

    Stages:
      1. Direct json.loads.
      2. Fix trailing commas before } or ].
      3. Close unclosed structures (token-limit truncation repair).
    """
    if not raw:
        return None

    def _try(s: str) -> Optional[Dict]:
        try:
            result = json.loads(s)
            return result if isinstance(result, dict) else None
        except (json.JSONDecodeError, ValueError):
            return None

    # Stage 1
    r = _try(raw)
    if r is not None:
        return r

    # Stage 2 — trailing commas
    fixed = re.sub(r",(\s*[}\]])", r"\1", raw)
    r = _try(fixed)
    if r is not None:
        return r

    # Stage 3 — close unclosed structures
    trimmed = fixed.rstrip().rstrip(",")
    n_quotes = len(re.findall(r'(?<!\\)"', trimmed))
    if n_quotes % 2 == 1:
        trimmed += '"'
    n_brace   = trimmed.count("{") - trimmed.count("}")
    n_bracket = trimmed.count("[") - trimmed.count("]")
    if n_brace > 0 or n_bracket > 0:
        trimmed += "]" * max(0, n_bracket) + "}" * max(0, n_brace)
        trimmed = re.sub(r",(\s*[}\]])", r"\1", trimmed)
        r = _try(trimmed)
        if r is not None:
            return r

    return None


def _parse_llm_json(raw: str) -> Optional[Dict]:
    """Strip think blocks + fences, extract first JSON object, validate fields."""
    if not raw:
        return None
    logger.debug("_parse_llm_json: raw=%s", raw[:300])
    # Strip thinking blocks (Qwen3, DeepSeek-R1 etc.) — even with think:false some
    # server versions still emit them
    cleaned = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
    # Strip ```json fences
    cleaned = re.sub(r"```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"```", "", cleaned).strip()
    # Use greedy match to find the OUTERMOST {...} (captures the full JSON object,
    # not a nested one that the non-greedy form might stop at prematurely)
    m = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if not m:
        logger.debug("_parse_llm_json: no JSON object found | cleaned=%s", cleaned[:200])
        return None

    data = _robust_json_parse(m.group())
    if data is None:
        # Greedy failed — try non-greedy (picks up smallest/first {...} in free text)
        m2 = re.search(r"\{.*?\}", cleaned, re.DOTALL)
        if m2 and m2.group() != m.group():
            data = _robust_json_parse(m2.group())
    if data is None:
        logger.debug("_parse_llm_json: repair failed | raw=%s", raw[:300])
        return None

    # Validate / coerce
    if data.get("type") not in _ALLOWED_TYPES:
        data["type"] = "Other"
    if data.get("sentiment") not in _ALLOWED_SENTIMENTS:
        data["sentiment"] = "neutral"
    try:
        impact = float(data.get("impact", 5))
        data["impact"] = max(1.0, min(10.0, impact))
    except (TypeError, ValueError):
        data["impact"] = 5.0
    summary = data.get("summary", "")
    if isinstance(summary, str):
        data["summary"] = summary[:200]
    tags = data.get("tags", [])
    if not isinstance(tags, list):
        data["tags"] = []
    return data


def _classify_dividend_keyword(headline: str, pdf_text: str) -> Dict:
    """Specialised keyword analysis for Dividend/Distribution announcements.

    Detects whether the dividend was increased, decreased, maintained, or is a
    special/inaugural payment.  Extracts per-share amounts where present.
    Returns a classification dict with accurate sentiment, impact, and a
    descriptive summary.
    """
    combined = (headline + " " + pdf_text[:1000]).lower()

    # ── Direction detection ─────────────────────────────────────────────────
    # Patterns are tested in priority order; first match wins.
    _INCREASE_RE = re.compile(
        r"increas|ris(?:e|ing|es)|higher|up(?:lift)?|grow(?:th)?|"
        r"record.{0,15}dividend|special.{0,15}dividend|inaugural|"
        r"introduc(?:e|ing|tion).{0,20}dividend",
        re.IGNORECASE,
    )
    _DECREASE_RE = re.compile(
        r"decreas|cut|reduc|lower|slash|suspend|"
        r"no.{0,6}dividend|no.{0,6}distribution|"
        r"omit|defer|cancel(?:l(?:ed|ing))?",
        re.IGNORECASE,
    )
    _MAINTAIN_RE = re.compile(
        r"maintain|unchanged|same|consistent|in.?line|stable|flat|"
        r"declared.{0,30}(?:interim|final|quarterly|half.year)",
        re.IGNORECASE,
    )

    direction: str
    if _DECREASE_RE.search(combined):
        direction = "decrease"
    elif _INCREASE_RE.search(combined):
        direction = "increase"
    elif _MAINTAIN_RE.search(combined):
        direction = "maintain"
    else:
        direction = "unknown"

    # ── Amount extraction ───────────────────────────────────────────────────
    # Matches patterns like "12.5 cents per share", "$0.125 per share",
    # "AUD 12.5c per share", "12.5 cps"
    amount_str = ""
    # Pattern A: "X.X cents per share" or "Xc per share" or "X cps"
    m = re.search(
        r"(\d+(?:\.\d+)?)\s*(?:cents?|c)\s*(?:per\s+share|ps|p\.s\.?|cps)",
        combined, re.IGNORECASE,
    )
    if m:
        amount_str = f"{m.group(1)}¢/share"
    else:
        # Pattern B: "$X.XX per share" or "AUD X.XX per share"
        m = re.search(
            r"(?:\$|aud\s*)(\d+(?:\.\d+)?)\s*(?:per\s+share|ps|p\.s\.?)",
            combined, re.IGNORECASE,
        )
        if m:
            amount_str = f"${m.group(1)}/share"

    # ── Franking ────────────────────────────────────────────────────────────
    franking = ""
    fm = re.search(r"(\d+)%\s*frank(?:ed|ing)?", combined, re.IGNORECASE)
    if fm:
        franking = f", {fm.group(1)}% franked"
    elif re.search(r"fully\s+frank", combined, re.IGNORECASE):
        franking = ", fully franked"
    elif re.search(r"unfrank|no\s+frank", combined, re.IGNORECASE):
        franking = ", unfranked"

    # ── Dividend sub-type ───────────────────────────────────────────────────
    div_type = "dividend"
    if re.search(r"distribut", combined, re.IGNORECASE):
        div_type = "distribution"
    elif re.search(r"special", combined, re.IGNORECASE):
        div_type = "special dividend"
    elif re.search(r"final", combined, re.IGNORECASE):
        div_type = "final dividend"
    elif re.search(r"interim", combined, re.IGNORECASE):
        div_type = "interim dividend"

    # ── Build summary ───────────────────────────────────────────────────────
    if direction == "increase":
        verb = "increases"
        sentiment = "positive"
        impact = 7.0
    elif direction == "decrease":
        verb = "cuts/reduces"
        sentiment = "negative"
        impact = 7.5
    elif direction == "maintain":
        verb = "maintains"
        sentiment = "positive"
        impact = 5.0
    else:
        verb = "declares"
        sentiment = "positive"
        impact = 5.5

    amount_part = f" of {amount_str}" if amount_str else ""
    summary = f"Company {verb} {div_type}{amount_part}{franking}. {headline}"
    summary = summary[:200]

    tags = ["Dividend"]
    if direction != "unknown":
        tags.append(f"div_{direction}")
    if amount_str:
        tags.append(amount_str)
    tags.append(sentiment)

    return {
        "type":      "Dividend",
        "sentiment": sentiment,
        "impact":    impact,
        "summary":   summary,
        "tags":      tags[:5],
        "llm_model": "keyword_fallback",
    }


def _classify_keyword(ticker: str, headline: str, pdf_text: str) -> Dict:
    """Keyword-based fallback classification."""
    combined = (headline + " " + pdf_text[:500]).lower()

    ann_type = "Other"
    for keywords, kw_type in _KEYWORD_TYPE_MAP:
        if any(kw in combined for kw in keywords):
            ann_type = kw_type
            break

    # Delegate dividend analysis to the richer dividend classifier
    if ann_type == "Dividend":
        return _classify_dividend_keyword(headline, pdf_text)

    pos_score = sum(1 for w in _POSITIVE_WORDS if w in combined)
    neg_score = sum(1 for w in _NEGATIVE_WORDS if w in combined)
    if pos_score > neg_score:
        sentiment = "positive"
    elif neg_score > pos_score:
        sentiment = "negative"
    else:
        sentiment = "neutral"

    impact = min(10.0, max(1.0, 5.0 + (pos_score - neg_score) * 0.5))

    tags: List[str] = []
    if ann_type != "Other":
        tags.append(ann_type)
    tags.append(sentiment)

    return {
        "type": ann_type,
        "sentiment": sentiment,
        "impact": round(impact, 1),
        "summary": headline[:120],
        "tags": tags[:5],
        "llm_model": "keyword_fallback",
    }


def _is_ann_thinking_model(model_name: str) -> bool:
    """Return True if the model uses chain-of-thought thinking blocks."""
    name = model_name.lower()
    return any(m in name for m in _ANN_THINKING_MODELS)


def _classify_ollama(prompt: str, settings: Dict) -> Optional[Dict]:
    ollama_url = settings.get("ollama_url", "http://localhost:11434").rstrip("/")
    model = settings.get("ann_llm_model", "qwen2.5:1.5b")
    cpu_mode = bool(settings.get("cpu_mode", False))
    thinking = _is_ann_thinking_model(model)

    # format:"json" (GBNF grammar) forces pure JSON output for all models.
    # For thinking models on this Ollama version, JSON is routed to the
    # "thinking" response field instead of "response" — Fallback A reads it.
    # This uses ~50 tokens instead of a full 2048-token thinking pass.
    num_predict = 250 if cpu_mode else 400
    num_ctx     = 1024 if cpu_mode else 2048

    options: Dict = {
        "temperature": 0.1,
        "num_predict": num_predict,
        "num_ctx":     num_ctx,
    }
    if cpu_mode:
        options["num_gpu"] = 0  # force CPU-only; omit entirely otherwise so Ollama auto-selects

    payload: Dict = {
        "model":   model,
        "prompt":  prompt,
        "stream":  False,
        "format":  "json",
        "options": options,
    }

    # 300 s covers model cold-load (~60 s on Jetson) + inference in all modes
    read_timeout = 300

    try:
        resp = requests.post(
            f"{ollama_url}/api/generate",
            json=payload,
            timeout=(30, read_timeout),
        )
        if resp.status_code == 200:
            resp_json = resp.json()
            raw = resp_json.get("response", "").strip()
            logger.debug("_classify_ollama [%s] raw response: %s", model, raw[:300])

            # ── Fallback A: check 'thinking' field when 'response' is empty ──
            # Ollama routes JSON to 'thinking' for thinking models with format:"json".
            if not raw:
                thinking_raw = resp_json.get("thinking", "").strip()
                if thinking_raw:
                    logger.debug(
                        "_classify_ollama [%s]: response empty — using thinking field (%d chars)",
                        model, len(thinking_raw),
                    )
                    raw = thinking_raw

            # Try parsing whatever we have so far
            result = _parse_llm_json(raw) if raw else None

            # ── Fallback B: retry with explicit no-stream request ─────────────
            # Safety net: if result is still None, retry once more (rare).
            if result is None and raw:
                logger.warning("_classify_ollama [%s]: JSON parse failed, retrying", model)
                retry_opts: Dict = {"temperature": 0.1, "num_predict": num_predict, "num_ctx": num_ctx}
                if cpu_mode:
                    retry_opts["num_gpu"] = 0
                retry_payload = {
                    "model":   model,
                    "prompt":  prompt,
                    "stream":  False,
                    "format":  "json",
                    "options": retry_opts,
                }
                try:
                    r2 = requests.post(
                        f"{ollama_url}/api/generate",
                        json=retry_payload,
                        timeout=(30, read_timeout),
                    )
                    if r2.status_code == 200:
                        r2_json = r2.json()
                        raw = r2_json.get("response", "").strip()
                        # qwen3.5:9b STILL routes to thinking field even on retry
                        # with format:json — check that field too
                        if not raw:
                            raw = r2_json.get("thinking", "").strip()
                            if raw:
                                logger.debug(
                                    "_classify_ollama [%s]: retry response also empty — "
                                    "using thinking field (%d chars)", model, len(raw),
                                )
                        logger.debug("_classify_ollama [%s] retry raw: %s", model, raw[:300])
                        result = _parse_llm_json(raw)
                except Exception as exc2:
                    logger.debug("_classify_ollama think-retry failed: %s", exc2)

            if result:
                result["llm_model"] = f"ollama/{model}"
                return result
            logger.warning("_classify_ollama [%s]: JSON parse failed | raw=%s", model, raw[:200])
    except Exception as exc:
        logger.warning("_classify_ollama failed: %s", exc)
    return None


def _classify_groq(prompt: str, settings: Dict) -> Optional[Dict]:
    api_key = settings.get("groq_api_key", "")
    if not api_key:
        return None
    model = "llama-3.1-8b-instant"
    try:
        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
                "max_tokens": 250,
            },
            timeout=30,
        )
        if resp.status_code == 200:
            raw = resp.json()["choices"][0]["message"]["content"]
            result = _parse_llm_json(raw)
            if result:
                result["llm_model"] = f"groq/{model}"
                return result
    except Exception as exc:
        logger.debug("groq classify failed: %s", exc)
    return None


def _classify_gemini(prompt: str, settings: Dict) -> Optional[Dict]:
    api_key = settings.get("gemini_api_key", "")
    if not api_key:
        return None
    model = "gemini-1.5-flash"
    try:
        resp = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            params={"key": api_key},
            headers={"Content-Type": "application/json"},
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.1, "maxOutputTokens": 250},
            },
            timeout=30,
        )
        if resp.status_code == 200:
            candidates = resp.json().get("candidates", [])
            if candidates:
                raw = candidates[0]["content"]["parts"][0]["text"]
                result = _parse_llm_json(raw)
                if result:
                    result["llm_model"] = f"gemini/{model}"
                    return result
    except Exception as exc:
        logger.debug("gemini classify failed: %s", exc)
    return None


def classify_announcement(
    ticker: str,
    headline: str,
    pdf_text: str,
    settings: Optional[Dict] = None,
    price_sensitive: bool = False,
) -> Dict:
    """Classify an announcement using the configured LLM with keyword fallback.

    For price-sensitive announcements (price_sensitive=True):
      - Uses a richer prompt that asks for structured keyFigures extraction.
      - Retries once if the first LLM call fails (transient error / JSON parse failure).
      - keyFigures are serialised to JSON and stored in result["details"].
    """
    settings = settings or {}
    provider = settings.get("ann_llm_provider", "ollama").lower()

    result: Optional[Dict] = None

    if provider == "keyword":
        # User explicitly wants heuristic only — skip LLM
        result = _classify_keyword(ticker, headline, pdf_text)
    else:
        prompt = _build_prompt(ticker, headline, pdf_text, price_sensitive=price_sensitive)
        provider_fns = {
            "ollama":  _classify_ollama,
            "groq":    _classify_groq,
            "gemini":  _classify_gemini,
        }
        fn = provider_fns.get(provider)
        if fn:
            result = fn(prompt, settings)
            # Price-sensitive announcements are high-value — retry once on failure
            if result is None and price_sensitive:
                logger.info(
                    "classify_announcement: PS retry for %s — first attempt failed", ticker
                )
                time.sleep(1.5)
                result = fn(prompt, settings)

            if result:
                logger.debug(
                    "classify_announcement: %s classified by %s",
                    ticker, result.get("llm_model"),
                )
                # Encode keyFigures (returned by PS prompt) into the details field
                kf = result.pop("keyFigures", None)
                if isinstance(kf, dict) and kf:
                    result["details"] = json.dumps(kf)
                else:
                    result.setdefault("details", "")
            else:
                logger.warning(
                    "classify_announcement: %s — provider '%s' failed%s, falling back to keyword",
                    ticker, provider,
                    " after PS retry" if price_sensitive else "",
                )

        if not result:
            result = _classify_keyword(ticker, headline, pdf_text)
            result.setdefault("details", "")

    return result


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def _ann_exists(conn: sqlite3.Connection, ann_id: str) -> bool:
    row = conn.execute("SELECT 1 FROM announcements WHERE id=?", (ann_id,)).fetchone()
    return row is not None


def save_announcement(ann: Dict, db_path: Optional[str | Path] = None) -> bool:
    """Insert or replace an announcement record. Returns True if inserted."""
    with get_db(db_path) as conn:
        if _ann_exists(conn, ann["id"]):
            return False
        conn.execute(
            """
            INSERT INTO announcements
                (id, ticker, date, headline, pdf_url, doc_key, pdf_text, type, sentiment, impact,
                 price_sensitive, summary, tags, llm_model, details, processed, fetched_at)
            VALUES
                (:id, :ticker, :date, :headline, :pdf_url, :doc_key, :pdf_text, :type, :sentiment, :impact,
                 :price_sensitive, :summary, :tags, :llm_model, :details, :processed, :fetched_at)
            """,
            {
                "id": ann.get("id"),
                "ticker": ann.get("ticker"),
                "date": ann.get("date"),
                "headline": ann.get("headline"),
                "pdf_url": ann.get("pdf_url"),
                "doc_key": ann.get("doc_key", ""),
                "pdf_text": ann.get("pdf_text"),
                "type": ann.get("type"),
                "sentiment": ann.get("sentiment"),
                "impact": ann.get("impact"),
                "price_sensitive": ann.get("price_sensitive", 1),
                "summary": ann.get("summary"),
                "tags": json.dumps(ann.get("tags", [])),
                "llm_model": ann.get("llm_model"),
                "details": ann.get("details", ""),
                "processed": ann.get("processed", 0),
                # Always store UTC with Z so JS new Date() parses it correctly as UTC
                "fetched_at": ann.get("fetched_at", datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")),
            },
        )
    return True


def purge_old_announcements(keep_days: int = 30, db_path: Optional[str | Path] = None) -> int:
    """Delete announcements older than keep_days. Returns number deleted."""
    cutoff = (datetime.utcnow() - timedelta(days=keep_days)).strftime("%Y-%m-%d")
    with get_db(db_path) as conn:
        cur = conn.execute("DELETE FROM announcements WHERE date < ?", (cutoff,))
        return cur.rowcount


# ---------------------------------------------------------------------------
# Query API
# ---------------------------------------------------------------------------

def get_announcements(
    db_path: Optional[str | Path] = None,
    tickers: Optional[List[str]] = None,
    days: int = 7,
    type_filter: Optional[str] = None,
    sentiment_filter: Optional[str] = None,
    limit: int = 100,
) -> List[Dict]:
    """Return a list of announcement dicts matching filters."""
    cutoff = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d")
    params: List[Any] = [cutoff]
    where_clauses = ["date >= ?"]

    if tickers:
        placeholders = ",".join("?" * len(tickers))
        where_clauses.append(f"ticker IN ({placeholders})")
        params.extend([t.upper() for t in tickers])

    if type_filter:
        where_clauses.append("type = ?")
        params.append(type_filter)

    if sentiment_filter:
        where_clauses.append("sentiment = ?")
        params.append(sentiment_filter)

    sql = (
        "SELECT * FROM announcements WHERE "
        + " AND ".join(where_clauses)
        + " ORDER BY date DESC, fetched_at DESC LIMIT ?"
    )
    params.append(limit)

    with get_db(db_path) as conn:
        rows = conn.execute(sql, params).fetchall()

    results = []
    for row in rows:
        d = dict(row)
        # Deserialise tags JSON
        try:
            d["tags"] = json.loads(d.get("tags") or "[]")
        except Exception:
            d["tags"] = []
        results.append(d)
    return results


def get_ann_brief(
    db_path: Optional[str | Path] = None,
    tickers: Optional[List[str]] = None,
    days: int = 3,
    max_items: int = 8,
) -> List[Dict]:
    """Return recent announcements for portfolio tickers, formatted for prompt injection.

    Prioritises:
      1. Price-sensitive announcements (always included first)
      2. High-impact announcements (impact_score DESC)
      3. Recency (date DESC as tiebreak)

    Each item includes a compact `signal` string (~15 tokens) ready for the
    Claude analysis userMessage, plus full fields for the frontend brief panel.
    """
    if not tickers:
        return []

    cutoff = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d")
    ticker_upper = [t.upper() for t in tickers]
    placeholders = ",".join("?" * len(ticker_upper))

    try:
        with get_db(db_path) as conn:
            rows = conn.execute(
                f"""SELECT ticker, date, headline, type, sentiment, impact,
                           price_sensitive, summary
                    FROM announcements
                    WHERE date >= ? AND ticker IN ({placeholders})
                    ORDER BY price_sensitive DESC, impact DESC, date DESC
                    LIMIT ?""",
                [cutoff, *ticker_upper, max_items],
            ).fetchall()
    except Exception as exc:
        logger.warning("get_ann_brief: DB query failed — %s", exc)
        return []

    results = []
    for row in rows:
        impact = row["impact"] or 0
        ps     = bool(row["price_sensitive"])
        signal = (
            f"{row['ticker']} [{row['type'] or 'Other'}|"
            f"{row['sentiment'] or 'neutral'}|{impact:.1f}"
            f"{'|⚡PS' if ps else ''}] "
            f"{(row['headline'] or '')[:80]} ({row['date']})"
        )
        results.append({
            "ticker":          row["ticker"],
            "date":            row["date"],
            "headline":        row["headline"],
            "type":            row["type"],
            "sentiment":       row["sentiment"],
            "impact":          impact,
            "price_sensitive": ps,
            "summary":         (row["summary"] or "")[:120],
            "signal":          signal,
        })

    return results


def get_announcement_pdf_url(ann_id: str, db_path: Optional[str | Path] = None) -> Optional[tuple]:
    """Return (pdf_url, doc_key, ticker, headline, date) for the given announcement id, or None."""
    with get_db(db_path) as conn:
        row = conn.execute(
            "SELECT pdf_url, doc_key, ticker, headline, date FROM announcements WHERE id=?",
            (ann_id,),
        ).fetchone()
    if row is None:
        return None
    return (
        row["pdf_url"] or "",
        row["doc_key"] or "",
        row["ticker"] or "",
        row["headline"] or "",
        row["date"] or "",
    )


# ---------------------------------------------------------------------------
# Sync status
# ---------------------------------------------------------------------------

def get_sync_status() -> Dict:
    with _sync_lock:
        return dict(_sync_status)


def _update_status(**kwargs: Any) -> None:
    with _sync_lock:
        _sync_status.update(kwargs)


# ---------------------------------------------------------------------------
# Re-classify status (separate from sync so both can run independently)
# ---------------------------------------------------------------------------

_reclassify_status: Dict[str, Any] = {
    "running":    False,
    "total":      0,
    "done":       0,
    "updated":    0,
    "stopped":    False,
    "last_run":   None,
    "last_count": 0,
    "last_error": None,
}
_reclassify_lock = threading.Lock()
_reclassify_stop_flag = False   # set True to request early exit


def get_reclassify_status() -> Dict:
    with _reclassify_lock:
        return dict(_reclassify_status)


def _update_reclassify_status(**kwargs: Any) -> None:
    with _reclassify_lock:
        _reclassify_status.update(kwargs)


def request_reclassify_stop() -> None:
    """Signal the running reclassify_all() loop to exit after the current item."""
    global _reclassify_stop_flag
    with _reclassify_lock:
        _reclassify_stop_flag = True
    logger.info("reclassify_all: stop requested")


# ---------------------------------------------------------------------------
# Re-classify existing announcements
# ---------------------------------------------------------------------------

def reclassify_all(
    settings: Optional[Dict] = None,
    days: int = 30,
    db_path: Optional[str | Path] = None,
) -> int:
    """Re-run LLM classification on stored announcements and update DB.

    Only touches announcements within `days` (default 30).  Returns the
    number of records updated.

    Progress is tracked in _reclassify_status so the frontend can poll it.
    Price-sensitive announcements use the richer PS prompt + retry logic.
    """
    settings = settings or {}
    cutoff = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d")

    global _reclassify_stop_flag
    with _reclassify_lock:
        _reclassify_stop_flag = False   # clear any previous stop request

    _update_reclassify_status(
        running=True, done=0, updated=0, total=0, stopped=False, last_error=None,
    )

    with get_db(db_path) as conn:
        rows = conn.execute(
            "SELECT id, ticker, headline, pdf_url, doc_key, pdf_text, price_sensitive "
            "FROM announcements WHERE date >= ?",
            (cutoff,),
        ).fetchall()

    if not rows:
        _update_reclassify_status(
            running=False,
            last_run=datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            last_count=0,
        )
        return 0

    _update_reclassify_status(total=len(rows))
    updated = 0

    for i, row in enumerate(rows):
        # Check stop flag before each item (set via request_reclassify_stop())
        with _reclassify_lock:
            if _reclassify_stop_flag:
                logger.info("reclassify_all: stopped by user at %d/%d", i, len(rows))
                _update_reclassify_status(stopped=True)
                break

        ann_id   = row["id"]
        ticker   = row["ticker"]
        headline = row["headline"] or ""
        pdf_text = row["pdf_text"] or ""
        is_ps    = bool(row["price_sensitive"])

        _update_reclassify_status(done=i)

        # If pdf_text is missing, try to fetch it now so the LLM gets real content
        fetched_pdf_text = False
        if not pdf_text:
            pdf_url = row["pdf_url"] or ""
            doc_key = row["doc_key"] or ""
            if pdf_url or doc_key:
                try:
                    pdf_bytes = download_pdf(
                        pdf_url, doc_key=doc_key,
                        ticker=ticker, headline=headline,
                        date="",
                    )
                    if pdf_bytes:
                        pdf_text = extract_text(pdf_bytes)
                        fetched_pdf_text = bool(pdf_text)
                        if fetched_pdf_text:
                            logger.debug(
                                "reclassify_all: fetched PDF text for %s (%d chars)",
                                ann_id, len(pdf_text),
                            )
                except Exception as exc:
                    logger.debug("reclassify_all: PDF re-fetch failed for %s — %s", ann_id, exc)

        try:
            result = classify_announcement(
                ticker, headline, pdf_text, settings,
                price_sensitive=is_ps,
            )
        except Exception as exc:
            logger.warning("reclassify_all: failed for %s — %s", ann_id, exc)
            continue

        try:
            with get_db(db_path) as conn:
                if fetched_pdf_text:
                    # Persist newly-fetched PDF text so future reclassify runs
                    # don't need to re-download
                    conn.execute(
                        """UPDATE announcements
                           SET type=?, sentiment=?, impact=?, summary=?, tags=?,
                               llm_model=?, details=?, pdf_text=?, processed=1
                           WHERE id=?""",
                        (
                            result.get("type"),
                            result.get("sentiment"),
                            result.get("impact"),
                            result.get("summary"),
                            json.dumps(result.get("tags", [])),
                            result.get("llm_model"),
                            result.get("details", ""),
                            pdf_text,
                            ann_id,
                        ),
                    )
                else:
                    conn.execute(
                        """UPDATE announcements
                           SET type=?, sentiment=?, impact=?, summary=?, tags=?,
                               llm_model=?, details=?, processed=1
                           WHERE id=?""",
                        (
                            result.get("type"),
                            result.get("sentiment"),
                            result.get("impact"),
                            result.get("summary"),
                            json.dumps(result.get("tags", [])),
                            result.get("llm_model"),
                            result.get("details", ""),
                            ann_id,
                        ),
                    )
            updated += 1
            _update_reclassify_status(updated=updated)
        except Exception as exc:
            logger.warning("reclassify_all: DB update failed for %s — %s", ann_id, exc)

        time.sleep(0.1)  # avoid hammering the LLM

    with _reclassify_lock:
        was_stopped = _reclassify_stop_flag
    _update_reclassify_status(
        running=False,
        done=len(rows),
        stopped=was_stopped,
        last_run=datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        last_count=updated,
    )
    logger.info("reclassify_all: updated %d / %d announcements%s",
                updated, len(rows), " (stopped early)" if was_stopped else "")
    return updated


# ---------------------------------------------------------------------------
# Main sync pipeline
# ---------------------------------------------------------------------------

def run_sync(
    tickers: List[str],
    settings: Optional[Dict] = None,
    days: int = 3,
    db_path: Optional[str | Path] = None,
) -> int:
    """Fetch, enrich, classify, and persist announcements for all tickers.

    Returns the number of new announcements saved.
    """
    settings = settings or {}
    _update_status(
        running=True,
        last_error=None,
        last_tickers=list(tickers),
        current_ticker=None,
        tickers_done=0,
        tickers_total=len(tickers),
        current_ticker_new=0,
    )
    logger.info("run_sync: starting for %d tickers (days=%d)", len(tickers), days)

    total_saved = 0

    try:
        init_db(db_path)

        for i, ticker in enumerate(tickers):
            if i > 0:
                time.sleep(0.8)

            ticker = ticker.upper().strip()
            _update_status(current_ticker=ticker, tickers_done=i, current_ticker_new=0)
            logger.info("run_sync: processing %s", ticker)

            try:
                raw_anns = fetch_announcements(ticker, days=days)
            except Exception as exc:
                logger.error("run_sync: fetch failed for %s — %s", ticker, exc)
                continue

            # Filter already-in-DB
            new_anns: List[Dict] = []
            with get_db(db_path) as conn:
                for ann in raw_anns:
                    if not _ann_exists(conn, ann["id"]):
                        new_anns.append(ann)

            logger.info("run_sync: %s — %d new of %d fetched", ticker, len(new_anns), len(raw_anns))

            for j, ann in enumerate(new_anns):
                if j > 0:
                    time.sleep(0.3)

                # Extract private metadata keys before saving
                markit_type_raw = ann.pop("_markit_type", "")
                # Preserve doc_key as a real DB column (was previously discarded)
                ann["doc_key"] = ann.pop("_doc_key", "")

                # Download + extract PDF text (best-effort; may 404 for new ASX system)
                pdf_text = ""
                if ann.get("pdf_url") or ann.get("doc_key"):
                    ann_date = ann.get("date", "")
                    today_str = datetime.utcnow().strftime("%Y-%m-%d")

                    # For today's announcements whose stored URL is the Markit-derived
                    # numeric CDN URL, proactively resolve the real URL via todayAnns.do.
                    # MAP-system (hex) PDFs have a filename that cannot be inferred from
                    # the numeric idsId; todayAnns.do → v2 viewer is the only way to get it.
                    current_pdf_url = ann.get("pdf_url", "")
                    if ann_date == today_str and current_pdf_url:
                        resolved = _fetch_todayanns_pdf_url(
                            ann.get("ticker", ""),
                            headline=ann.get("headline", ""),
                            date=ann_date,
                        )
                        if resolved and resolved != current_pdf_url:
                            logger.debug(
                                "run_sync: todayAnns resolved URL for %s: %s → %s",
                                ann.get("ticker"), current_pdf_url, resolved,
                            )
                            ann["pdf_url"] = resolved

                    pdf_bytes = download_pdf(
                        ann.get("pdf_url", ""),
                        doc_key=ann.get("doc_key", ""),
                        ticker=ann.get("ticker", ""),
                        headline=ann.get("headline", ""),
                        date=ann.get("date", ""),
                    )
                    if pdf_bytes:
                        try:
                            pdf_text = extract_text(pdf_bytes)
                        except Exception as exc:
                            logger.warning("run_sync: text extraction failed for %s — %s", ann["pdf_url"], exc)
                    else:
                        logger.debug("run_sync: PDF not available for %s (%s)", ann.get("headline","")[:40], ann.get("pdf_url",""))

                ann["pdf_text"] = pdf_text

                # Pre-classify from Markit type if available (free, no LLM needed)
                pre_type = _markit_type(markit_type_raw) if markit_type_raw else None

                # LLM classify — passes headline + pdf_text (may be empty)
                is_ps = bool(ann.get("price_sensitive", 0))
                try:
                    classification = classify_announcement(
                        ticker=ticker,
                        headline=ann.get("headline", ""),
                        pdf_text=pdf_text,
                        settings=settings,
                        price_sensitive=is_ps,
                    )
                    # Prefer Markit-derived type over keyword heuristic when LLM
                    # falls back to keyword_fallback and we have a Markit type
                    if (pre_type and pre_type != "Other"
                            and classification.get("llm_model") == "keyword_fallback"):
                        classification["type"] = pre_type
                    ann.update(classification)
                    ann["processed"] = 1
                except Exception as exc:
                    logger.warning("run_sync: classify failed for %s ann — %s", ticker, exc)
                    # Use keyword fallback with Markit type hint
                    kw = _classify_keyword(ticker, ann.get("headline", ""), pdf_text)
                    if pre_type and pre_type != "Other":
                        kw["type"] = pre_type
                    kw.setdefault("details", "")
                    ann.update(kw)
                    ann["processed"] = 0

                # Always store UTC with Z suffix so JS new Date() parses it correctly
                ann["fetched_at"] = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

                # Persist
                try:
                    if save_announcement(ann, db_path):
                        total_saved += 1
                        with _sync_lock:
                            _sync_status["current_ticker_new"] += 1
                except Exception as exc:
                    logger.error("run_sync: save failed for %s — %s", ann.get("id"), exc)

            # Mark this ticker done
            _update_status(tickers_done=i + 1)

        # Purge old
        try:
            deleted = purge_old_announcements(keep_days=30, db_path=db_path)
            if deleted:
                logger.info("run_sync: purged %d old announcements", deleted)
        except Exception as exc:
            logger.warning("run_sync: purge failed — %s", exc)

        _update_status(
            running=False,
            # Store with Z suffix so JS new Date() parses it correctly as UTC.
            # Without Z, browsers in UTC+10 interpret a naive UTC string as local
            # time, making the "X min ago" display 600 min (10 h) ahead.
            last_run=datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            last_count=total_saved,
            current_ticker=None,
            tickers_done=len(tickers),
        )
        logger.info("run_sync: complete — %d new announcements saved", total_saved)

    except Exception as exc:
        logger.exception("run_sync: unexpected error — %s", exc)
        _update_status(running=False, last_error=str(exc))

    return total_saved


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

_RUN_SLOTS = ("10:30", "15:00")  # Sydney time


def _should_run(now_sydney: datetime, last_slot: Optional[str]) -> Optional[str]:
    """Return the slot string if we should fire now, else None."""
    if now_sydney.weekday() >= 5:  # Sat=5, Sun=6
        return None
    current_hm = now_sydney.strftime("%H:%M")
    for slot in _RUN_SLOTS:
        if current_hm == slot and last_slot != slot:
            return slot
    return None


def start_scheduler(
    get_tickers_fn,
    get_settings_fn,
    db_path: Optional[str | Path] = None,
) -> threading.Thread:
    """Start the background scheduler daemon thread.

    Parameters
    ----------
    get_tickers_fn:
        Callable with no arguments returning a list of ticker strings.
    get_settings_fn:
        Callable with no arguments returning the settings dict.
    db_path:
        Path to the SQLite database file (defaults to DB_PATH_DEFAULT).

    Returns
    -------
    The daemon Thread object (already started).
    """
    global _scheduler_thread, _last_run_slot

    if _scheduler_thread is not None and _scheduler_thread.is_alive():
        logger.warning("start_scheduler: scheduler already running")
        return _scheduler_thread

    def _loop() -> None:
        global _last_run_slot
        logger.info("ann-scheduler: started; will fire at %s Sydney time on weekdays", _RUN_SLOTS)
        while True:
            try:
                now = _sydney_now()
                slot = _should_run(now, _last_run_slot)
                if slot:
                    try:
                        tickers  = get_tickers_fn() or []
                        settings = get_settings_fn() or {}
                        if settings.get("sbc_mode", False):
                            # Don't mark slot as run — allow re-fire if SBC mode is disabled
                            logger.info("ann-scheduler: SBC mode active — skipping slot %s", slot)
                        else:
                            _last_run_slot = slot  # Only mark run when we actually run
                            logger.info("ann-scheduler: firing slot %s", slot)
                            run_sync(tickers=tickers, settings=settings, db_path=db_path)
                    except Exception as exc:
                        logger.error("ann-scheduler: run_sync raised — %s", exc)
                # Reset last_slot when minute has passed (allow re-fire next occurrence)
                elif _last_run_slot and now.strftime("%H:%M") != _last_run_slot:
                    pass  # keep it; we only reset when a new day starts or we miss the slot
                # Reset at midnight so tomorrow's slots can fire
                if now.hour == 0 and now.minute == 0:
                    _last_run_slot = None
            except Exception as exc:
                logger.error("ann-scheduler: loop error — %s", exc)
            time.sleep(60)

    _scheduler_thread = threading.Thread(target=_loop, daemon=True, name="ann-scheduler")
    _scheduler_thread.start()
    return _scheduler_thread
