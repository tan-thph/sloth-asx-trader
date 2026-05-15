"""
announcement_engine.py
======================
ASX announcement scraper + analyser engine for the Sloth.ai trading app.

Scrapes price-sensitive announcements from marketindex.com.au, extracts PDF
text, classifies with an LLM (Ollama / Groq / Gemini / keyword fallback),
and persists results to the asx_trader.db SQLite database.

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
    'Reply with ONLY this JSON:\n'
    '{"type":"Earnings|Dividend|Capital Raise|CEO Change|Acquisition|AGM|'
    'Trading Halt|Asset Sale|Guidance Update|Other",'
    '"sentiment":"positive|neutral|negative",'
    '"impact":6,'
    '"summary":"One sentence max 120 chars.",'
    '"tags":["tag1","tag2"]}'
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


def _get_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(_BROWSER_HEADERS)
    return s


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


def _normalise_pdf_url(url: str) -> str:
    if url.startswith("http"):
        return url
    if url.startswith("/"):
        return "https://www.marketindex.com.au" + url
    return "https://www.marketindex.com.au/" + url


# ---------------------------------------------------------------------------
# Strategy 1 — Next.js __NEXT_DATA__ JSON
# ---------------------------------------------------------------------------

def _strategy_next_data(session: requests.Session, ticker: str, days: int) -> List[Dict]:
    url = f"https://www.marketindex.com.au/asx/{ticker.lower()}"
    try:
        resp = session.get(url, timeout=20)
        if resp.status_code != 200:
            return []
        html = resp.text
        m = re.search(r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', html, re.DOTALL)
        if not m:
            return []
        data = json.loads(m.group(1))
    except Exception as exc:
        logger.debug("strategy1 failed for %s: %s", ticker, exc)
        return []

    # Walk pageProps looking for announcements list
    announcements_raw: List[Any] = []
    try:
        page_props = data.get("props", {}).get("pageProps", {})
        # Common keys to check
        for key in ("announcements", "priceAnnouncements", "companyAnnouncements", "announceData"):
            val = page_props.get(key)
            if isinstance(val, list) and val:
                announcements_raw = val
                break
        # Deeper nesting
        if not announcements_raw:
            for _k, _v in page_props.items():
                if isinstance(_v, dict):
                    for key2 in ("announcements", "priceAnnouncements"):
                        val2 = _v.get(key2)
                        if isinstance(val2, list) and val2:
                            announcements_raw = val2
                            break
                if announcements_raw:
                    break
    except Exception as exc:
        logger.debug("strategy1 parse failed for %s: %s", ticker, exc)
        return []

    return _normalise_raw_list(announcements_raw, ticker, days)


# ---------------------------------------------------------------------------
# Strategy 2 — Internal API endpoints
# ---------------------------------------------------------------------------

def _strategy_api(session: requests.Session, ticker: str, days: int) -> List[Dict]:
    endpoints = [
        f"https://www.marketindex.com.au/api/asx/{ticker.lower()}/announcements",
        f"https://www.marketindex.com.au/api/company/{ticker.lower()}/announcements",
        f"https://www.marketindex.com.au/asx/{ticker.lower()}/announcements.json",
    ]
    for url in endpoints:
        try:
            resp = session.get(url, headers=_API_HEADERS, timeout=15)
            if resp.status_code != 200:
                continue
            data = resp.json()
            raw: List[Any] = []
            if isinstance(data, list):
                raw = data
            elif isinstance(data, dict):
                for key in ("data", "announcements", "results", "items"):
                    if isinstance(data.get(key), list):
                        raw = data[key]
                        break
            if raw:
                return _normalise_raw_list(raw, ticker, days)
        except Exception as exc:
            logger.debug("strategy2 endpoint %s failed: %s", url, exc)
    return []


# ---------------------------------------------------------------------------
# Strategy 3 — HTML parse ticker page
# ---------------------------------------------------------------------------

def _strategy_html_ticker(session: requests.Session, ticker: str, days: int) -> List[Dict]:
    if not _HAS_BS4:
        return []
    url = f"https://www.marketindex.com.au/asx/{ticker.lower()}"
    try:
        resp = session.get(url, timeout=20)
        if resp.status_code != 200:
            return []
        soup = BeautifulSoup(resp.text, "html.parser")
    except Exception as exc:
        logger.debug("strategy3 fetch failed for %s: %s", ticker, exc)
        return []

    results: List[Dict] = []
    # Look for announcement containers
    ann_containers = soup.find_all(
        lambda tag: tag.name in ("div", "section", "article")
        and any(
            c in (tag.get("class") or [])
            for c in ("announcement", "announcements", "ann-row", "ann-item")
        )
    )
    if not ann_containers:
        # Try table rows
        tables = soup.find_all("table")
        for table in tables:
            rows = table.find_all("tr")
            for row in rows[1:]:  # skip header
                cells = row.find_all(["td", "th"])
                if len(cells) < 2:
                    continue
                ann = _parse_table_row(cells, ticker)
                if ann:
                    results.append(ann)
    else:
        for container in ann_containers:
            ann = _parse_ann_container(container, ticker)
            if ann:
                results.append(ann)

    filtered = [a for a in results if _is_recent(a.get("date", ""), days)]
    return filtered


def _parse_table_row(cells, ticker: str) -> Optional[Dict]:
    """Best-effort parse of a table row into an announcement dict."""
    text_cells = [c.get_text(strip=True) for c in cells]
    date_str = None
    headline = None
    pdf_url = None

    for cell_text in text_cells:
        parsed = _parse_date_str(cell_text)
        if parsed and not date_str:
            date_str = parsed
        elif len(cell_text) > 15 and not headline:
            headline = cell_text

    for cell in cells:
        link = cell.find("a", href=True)
        if link and ".pdf" in link["href"].lower():
            pdf_url = _normalise_pdf_url(link["href"])
            if not headline:
                headline = link.get_text(strip=True)

    if not date_str or not headline:
        return None

    ann_id = _make_ann_id(ticker, date_str, headline)
    return {
        "id": ann_id,
        "ticker": ticker.upper(),
        "date": date_str,
        "headline": headline,
        "pdf_url": pdf_url,
        "price_sensitive": 1,
    }


def _parse_ann_container(tag, ticker: str) -> Optional[Dict]:
    """Parse an announcement div/article container."""
    text = tag.get_text(" ", strip=True)
    date_str = None
    # Try to find date
    date_m = re.search(r"\d{1,2}[/ ]\w+[/ ]\d{4}|\d{4}-\d{2}-\d{2}", text)
    if date_m:
        date_str = _parse_date_str(date_m.group())
    headline_tag = tag.find(["h2", "h3", "h4", "a", "span"])
    headline = headline_tag.get_text(strip=True) if headline_tag else text[:120]
    link_tag = tag.find("a", href=re.compile(r"\.pdf", re.I))
    pdf_url = _normalise_pdf_url(link_tag["href"]) if link_tag else None

    if not date_str or not headline:
        return None

    ann_id = _make_ann_id(ticker, date_str, headline)
    return {
        "id": ann_id,
        "ticker": ticker.upper(),
        "date": date_str,
        "headline": headline,
        "pdf_url": pdf_url,
        "price_sensitive": 1,
    }


# ---------------------------------------------------------------------------
# Strategy 4 — Main announcements page, filter by ticker
# ---------------------------------------------------------------------------

def _strategy_html_main(session: requests.Session, ticker: str, days: int) -> List[Dict]:
    if not _HAS_BS4:
        return []
    url = "https://www.marketindex.com.au/asx/announcements"
    try:
        resp = session.get(url, timeout=20)
        if resp.status_code != 200:
            return []
        soup = BeautifulSoup(resp.text, "html.parser")
    except Exception as exc:
        logger.debug("strategy4 fetch failed: %s", exc)
        return []

    results: List[Dict] = []
    # Search for any text node containing the ticker
    for tag in soup.find_all(True):
        if tag.get_text(strip=True).upper() == ticker.upper():
            # Walk up to find the row
            parent = tag.parent
            for _ in range(4):
                if parent is None:
                    break
                cells = parent.find_all(["td", "th", "div"])
                if len(cells) >= 2:
                    ann = _parse_table_row(cells, ticker)
                    if ann:
                        results.append(ann)
                    break
                parent = parent.parent
    filtered = [a for a in results if _is_recent(a.get("date", ""), days)]
    return filtered


# ---------------------------------------------------------------------------
# Normalise raw JSON list from Next.js / API responses
# ---------------------------------------------------------------------------

def _normalise_raw_list(raw: List[Any], ticker: str, days: int) -> List[Dict]:
    results: List[Dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        # Date
        date_str = None
        for k in ("date", "announcementDate", "announcement_date", "released", "time", "releasedAt"):
            val = item.get(k, "")
            if val:
                date_str = _parse_date_str(str(val))
                if date_str:
                    break
        if not date_str or not _is_recent(date_str, days):
            continue

        # Price sensitive filter
        ps_val = item.get("price_sensitive") or item.get("priceSensitive") or item.get("sensitive")
        # Accept if True, "1", "Y", "yes", or field absent (assume sensitive)
        if ps_val is not None:
            if isinstance(ps_val, bool):
                if not ps_val:
                    continue
            elif isinstance(ps_val, int):
                if ps_val == 0:
                    continue
            elif isinstance(ps_val, str):
                if ps_val.lower() in ("false", "0", "no", "n"):
                    continue

        # Headline
        headline = None
        for k in ("headline", "header", "title", "announcementHeader", "subject", "description"):
            v = item.get(k, "")
            if v and isinstance(v, str):
                headline = v.strip()
                break
        if not headline:
            continue

        # PDF URL
        pdf_url = None
        for k in ("url", "pdfUrl", "pdf_url", "documentUrl", "document_url", "link", "href"):
            v = item.get(k, "")
            if v and isinstance(v, str) and (".pdf" in v.lower() or "document" in v.lower()):
                pdf_url = _normalise_pdf_url(v)
                break

        ann_id = _make_ann_id(ticker, date_str, headline)
        results.append(
            {
                "id": ann_id,
                "ticker": ticker.upper(),
                "date": date_str,
                "headline": headline,
                "pdf_url": pdf_url,
                "price_sensitive": 1,
            }
        )
    return results


# ---------------------------------------------------------------------------
# Main fetch function: try all strategies
# ---------------------------------------------------------------------------

def fetch_announcements(ticker: str, days: int = 3) -> List[Dict]:
    """Fetch price-sensitive announcements for a ticker using 4 strategies."""
    session = _get_session()
    session.headers["Referer"] = f"https://www.marketindex.com.au/asx/{ticker.lower()}"

    strategies = [
        ("next_data", _strategy_next_data),
        ("api", _strategy_api),
        ("html_ticker", _strategy_html_ticker),
        ("html_main", _strategy_html_main),
    ]

    for name, fn in strategies:
        try:
            results = fn(session, ticker, days)
            if results:
                logger.info("fetch_announcements: %s — strategy '%s' returned %d items", ticker, name, len(results))
                return results
        except Exception as exc:
            logger.warning("fetch_announcements: %s strategy '%s' raised: %s", ticker, name, exc)
        time.sleep(0.15)

    logger.info("fetch_announcements: %s — no announcements found (all strategies exhausted)", ticker)
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
    _update_status(running=True, last_error=None, last_tickers=list(tickers))
    logger.info("run_sync: starting for %d tickers (days=%d)", len(tickers), days)

    total_saved = 0

    try:
        init_db(db_path)

        for i, ticker in enumerate(tickers):
            if i > 0:
                time.sleep(0.8)

            ticker = ticker.upper().strip()
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

                # Download + extract PDF text
                pdf_text = ""
                if ann.get("pdf_url"):
                    pdf_bytes = download_pdf(ann["pdf_url"])
                    if pdf_bytes:
                        try:
                            pdf_text = extract_text(pdf_bytes)
                        except Exception as exc:
                            logger.warning("run_sync: text extraction failed for %s — %s", ann["pdf_url"], exc)

                ann["pdf_text"] = pdf_text

                # LLM classify
                try:
                    classification = classify_announcement(
                        ticker=ticker,
                        headline=ann.get("headline", ""),
                        pdf_text=pdf_text,
                        settings=settings,
                    )
                    ann.update(classification)
                    ann["processed"] = 1
                except Exception as exc:
                    logger.warning("run_sync: classify failed for %s ann — %s", ticker, exc)
                    ann["processed"] = 0

                ann["fetched_at"] = datetime.utcnow().isoformat()

                # Persist
                try:
                    if save_announcement(ann, db_path):
                        total_saved += 1
                except Exception as exc:
                    logger.error("run_sync: save failed for %s — %s", ann.get("id"), exc)

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
