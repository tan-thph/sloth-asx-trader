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

_LLM_PROMPT_TEMPLATE = (
    "Analyse this ASX announcement. Reply with valid JSON only, no markdown.\n\n"
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
    created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ann_ticker ON announcements(ticker);
CREATE INDEX IF NOT EXISTS idx_ann_date   ON announcements(date DESC);
CREATE INDEX IF NOT EXISTS idx_ann_ps     ON announcements(price_sensitive);
"""


def init_db(db_path: Optional[str | Path] = None) -> None:
    """Create the announcements table and indexes if they do not exist."""
    path = str(db_path or DB_PATH_DEFAULT)
    with sqlite3.connect(path) as conn:
        conn.executescript(_CREATE_TABLE_SQL)
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
    """Construct best-effort ASX PDF URL from Markit documentKey + date.

    documentKey format: "2924-{docId}-{markitXid}"  e.g. "2924-03088504-3A693022"
    The middle part (docId) maps to the file on announcements.asx.com.au.
    """
    if not doc_key or not date_str:
        return ""
    parts = doc_key.split("-")
    if len(parts) < 2:
        return ""
    doc_id = parts[1]  # e.g. "03088504"
    date_nodash = date_str.replace("-", "")  # "20260510"
    # www.asx.com.au redirects this to announcements.asx.com.au
    return f"https://announcements.asx.com.au/asxpdf/{date_nodash}/pdf/{doc_id}.pdf"


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

        # Construct best-effort PDF URL from documentKey
        pdf_url = _markit_pdf_url(doc_key, date_str)

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

def download_pdf(url: str) -> Optional[bytes]:
    """Download a PDF from `url` and return raw bytes, or None on failure."""
    try:
        resp = requests.get(
            url,
            headers=_BROWSER_HEADERS,
            timeout=30,
            allow_redirects=True,
        )
        if resp.status_code == 200 and resp.content:
            return resp.content
        logger.debug("download_pdf: non-200 status %s for %s", resp.status_code, url)
    except Exception as exc:
        logger.warning("download_pdf: failed for %s — %s", url, exc)
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

def _build_prompt(ticker: str, headline: str, pdf_text: str) -> str:
    content = (pdf_text or headline)[:1200].replace("\n", " ").strip()
    return _LLM_PROMPT_TEMPLATE.format(
        ticker=ticker,
        headline=headline,
        content=content,
    )


def _parse_llm_json(raw: str) -> Optional[Dict]:
    """Strip fences, find first {...}, validate fields."""
    if not raw:
        return None
    # Strip ```json fences
    cleaned = re.sub(r"```json\s*", "", raw)
    cleaned = re.sub(r"```\s*", "", cleaned)
    # Find first JSON object
    m = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group())
    except json.JSONDecodeError:
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


def _classify_keyword(ticker: str, headline: str, pdf_text: str) -> Dict:
    """Keyword-based fallback classification."""
    combined = (headline + " " + pdf_text[:500]).lower()

    ann_type = "Other"
    for keywords, kw_type in _KEYWORD_TYPE_MAP:
        if any(kw in combined for kw in keywords):
            ann_type = kw_type
            break

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


def _classify_ollama(prompt: str, settings: Dict) -> Optional[Dict]:
    ollama_url = settings.get("ollama_url", "http://localhost:11434").rstrip("/")
    model = settings.get("ann_llm_model", "qwen2.5:1.5b")
    try:
        resp = requests.post(
            f"{ollama_url}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "stream": False,
                "temperature": 0.1,
                "num_predict": 200,
                "options": {"temperature": 0.1, "num_predict": 200},
            },
            timeout=60,
        )
        if resp.status_code == 200:
            raw = resp.json().get("response", "")
            result = _parse_llm_json(raw)
            if result:
                result["llm_model"] = f"ollama/{model}"
                return result
    except Exception as exc:
        logger.debug("ollama classify failed: %s", exc)
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
) -> Dict:
    """Classify an announcement using configured LLM providers with fallback."""
    settings = settings or {}
    provider = settings.get("ann_llm_provider", "ollama").lower()
    prompt = _build_prompt(ticker, headline, pdf_text)

    # Ordered list based on configured provider
    provider_fns = {
        "ollama": _classify_ollama,
        "groq": _classify_groq,
        "gemini": _classify_gemini,
    }

    # Build ordered list: configured provider first, then others
    order = [provider] + [p for p in ("ollama", "groq", "gemini") if p != provider]

    for prov in order:
        fn = provider_fns.get(prov)
        if fn is None:
            continue
        result = fn(prompt, settings)
        if result:
            logger.debug("classify_announcement: %s classified by %s", ticker, result.get("llm_model"))
            return result

    # Keyword fallback
    return _classify_keyword(ticker, headline, pdf_text)


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
                (id, ticker, date, headline, pdf_url, pdf_text, type, sentiment, impact,
                 price_sensitive, summary, tags, llm_model, processed, fetched_at)
            VALUES
                (:id, :ticker, :date, :headline, :pdf_url, :pdf_text, :type, :sentiment, :impact,
                 :price_sensitive, :summary, :tags, :llm_model, :processed, :fetched_at)
            """,
            {
                "id": ann.get("id"),
                "ticker": ann.get("ticker"),
                "date": ann.get("date"),
                "headline": ann.get("headline"),
                "pdf_url": ann.get("pdf_url"),
                "pdf_text": ann.get("pdf_text"),
                "type": ann.get("type"),
                "sentiment": ann.get("sentiment"),
                "impact": ann.get("impact"),
                "price_sensitive": ann.get("price_sensitive", 1),
                "summary": ann.get("summary"),
                "tags": json.dumps(ann.get("tags", [])),
                "llm_model": ann.get("llm_model"),
                "processed": ann.get("processed", 0),
                "fetched_at": ann.get("fetched_at", datetime.utcnow().isoformat()),
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


def get_announcement_pdf_url(ann_id: str, db_path: Optional[str | Path] = None) -> Optional[str]:
    """Return pdf_url for the given announcement id, or None."""
    with get_db(db_path) as conn:
        row = conn.execute("SELECT pdf_url FROM announcements WHERE id=?", (ann_id,)).fetchone()
    return row["pdf_url"] if row else None


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

                # Extract private metadata keys before saving (not DB columns)
                markit_type_raw = ann.pop("_markit_type", "")
                ann.pop("_doc_key", None)

                # Download + extract PDF text (best-effort; may 404 for new ASX system)
                pdf_text = ""
                if ann.get("pdf_url"):
                    pdf_bytes = download_pdf(ann["pdf_url"])
                    if pdf_bytes:
                        try:
                            pdf_text = extract_text(pdf_bytes)
                        except Exception as exc:
                            logger.warning("run_sync: text extraction failed for %s — %s", ann["pdf_url"], exc)
                    else:
                        logger.debug("run_sync: PDF not available for %s (%s)", ann.get("headline","")[:40], ann["pdf_url"])

                ann["pdf_text"] = pdf_text

                # Pre-classify from Markit type if available (free, no LLM needed)
                pre_type = _markit_type(markit_type_raw) if markit_type_raw else None

                # LLM classify — passes headline + pdf_text (may be empty)
                try:
                    classification = classify_announcement(
                        ticker=ticker,
                        headline=ann.get("headline", ""),
                        pdf_text=pdf_text,
                        settings=settings,
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
                    ann.update(kw)
                    ann["processed"] = 0

                ann["fetched_at"] = datetime.utcnow().isoformat()

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
            last_run=datetime.utcnow().isoformat(),
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
                    _last_run_slot = slot
                    logger.info("ann-scheduler: firing slot %s", slot)
                    try:
                        tickers = get_tickers_fn() or []
                        settings = get_settings_fn() or {}
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
