"""
routes/dividends.py — ASX dividend schedule + history.

Two-tier strategy:
  1. yfinance for amounts, dates, yield metadata (primary).
  2. ASX scrape for franking %, payable date (enrichment).
  Cached for 12 h in `dividend_cache` table.

Endpoints:
  /api/dividends/<ticker>      GET    — single ticker
  /api/dividends/batch         POST   — parallel batch
  /api/dividends/cache/clear   POST   — force expire
"""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import requests
import yfinance as yf
from flask import Blueprint, jsonify, request

from db import get_db
from indicators import asx, safe_float


bp = Blueprint("dividends", __name__)


# ── Constants ────────────────────────────────────────────────────────────────

_ASX_DIV_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-AU,en;q=0.9",
    "Referer": "https://www.asx.com.au/markets/trade-our-cash-market/dividend-search",
}
_DIV_CACHE_TTL_HOURS = 12

# Hardcoded franking % fallback when ASX scrape unavailable.
_FRANKING_MAP: dict[str, float] = {
    # Banks
    "CBA": 100.0, "NAB": 100.0, "WBC": 100.0, "ANZ": 100.0, "MQG": 45.0,
    "BOQ": 100.0, "BEN": 100.0, "SUN": 100.0, "IAG": 100.0, "QBE": 0.0,
    # Big miners
    "BHP": 100.0, "RIO": 0.0, "FMG": 100.0, "MIN": 100.0, "S32": 0.0,
    "WDS": 0.0, "STO": 0.0, "WHC": 100.0, "NHC": 100.0,
    # Industrials / consumer
    "WES": 100.0, "WOW": 100.0, "COL": 100.0, "JBH": 100.0, "HVN": 100.0,
    "NCK": 100.0, "SUL": 100.0, "LOV": 100.0, "DMP": 100.0,
    # Healthcare
    "CSL": 15.0, "RHC": 100.0, "SHL": 100.0, "ANN": 0.0, "COH": 100.0,
    # REITs / Infrastructure (0% — pass-through)
    "GMG": 0.0, "SCG": 0.0, "GPT": 0.0, "VCX": 0.0, "CHC": 0.0,
    "DXS": 0.0, "CQR": 0.0, "HMC": 0.0, "MGR": 0.0, "BWP": 0.0,
    "NSR": 0.0, "CLW": 0.0, "GDF": 0.0, "URW": 0.0,
    # Infrastructure / Utilities
    "TCL": 0.0, "APA": 0.0, "SKI": 0.0, "ALX": 0.0,
    "AGL": 100.0, "ORG": 100.0, "ALD": 100.0,
    # Tech
    "WTC": 0.0, "XRO": 0.0, "CPU": 30.0, "NXT": 0.0, "TYR": 0.0,
    # Telcos
    "TLS": 100.0, "TPG": 0.0, "SPK": 0.0,
    # ETFs (0% — pass-through)
    "VAS": 0.0, "VHY": 0.0, "VLC": 0.0, "VGS": 0.0, "VDHG": 0.0,
    "NDQ": 0.0, "IVV": 0.0, "STW": 0.0, "IOZ": 0.0, "A200": 0.0,
    # Other
    "ALL": 100.0, "REH": 0.0, "RWC": 0.0, "BXB": 0.0, "AMC": 0.0,
    "ALQ": 100.0, "GWA": 100.0, "IPH": 100.0, "IEL": 100.0, "EML": 0.0,
}


# ── Cache layer ──────────────────────────────────────────────────────────────

def _get_cached_dividends(ticker: str) -> dict | None:
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT data, expires_at FROM dividend_cache WHERE ticker=?",
                (ticker.upper(),)
            ).fetchone()
            if row and row["expires_at"] > datetime.now().isoformat():
                return json.loads(row["data"])
    except Exception:
        pass
    return None


def _set_cached_dividends(ticker: str, data: dict, source: str):
    expires = (datetime.now() + timedelta(hours=_DIV_CACHE_TTL_HOURS)).isoformat()
    try:
        with get_db() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO dividend_cache (ticker, data, source, fetched_at, expires_at)
                   VALUES (?, ?, ?, datetime('now','localtime'), ?)""",
                (ticker.upper(), json.dumps(data), source, expires)
            )
    except Exception:
        pass


# ── ASX scraper ──────────────────────────────────────────────────────────────

def scrape_asx_dividends(ticker: str) -> list[dict]:
    """Scrape ASX dividend-search iframe. Fast timeout — yfinance is primary."""
    from bs4 import BeautifulSoup

    code = ticker.upper().replace(".AX", "")
    resp = requests.get(
        "https://www.asx.com.au/asx/v2/markets/dividends.do",
        params={"by": "asxCodes", "asxCodes": code, "view": "all"},
        headers=_ASX_DIV_HEADERS,
        timeout=4,
    )
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    table = soup.find("table")
    if not table:
        return []

    results = []
    for row in table.find_all("tr")[1:]:
        cells = [td.get_text(strip=True) for td in row.find_all(["th", "td"])]
        if len(cells) < 8:
            continue
        row_code, _, amount_raw, ex_raw, record_raw, payable_raw, franking_raw, div_type = cells[:8]
        comments = cells[8] if len(cells) > 8 else ""

        if row_code.upper().rstrip("*") != code:
            continue

        # Amount: "260c" → 2.60, "91.9273c" → 0.919273
        amount = None
        amount_str = amount_raw.lower().replace(",", "").strip()
        try:
            if amount_str.endswith("c"):
                amount = round(float(amount_str[:-1]) / 100, 4)
            else:
                amount = round(float(amount_str), 4)
        except ValueError:
            pass

        def _parse_date(s: str) -> str | None:
            s = s.strip()
            if not s:
                return None
            try:
                return datetime.strptime(s, "%d/%m/%Y").strftime("%Y-%m-%d")
            except ValueError:
                return None

        ex_date      = _parse_date(ex_raw)
        record_date  = _parse_date(record_raw)
        payable_date = _parse_date(payable_raw)
        if not ex_date:
            continue

        franking = 0.0
        try:
            franking = round(float(franking_raw.replace("%", "").strip()), 1)
        except ValueError:
            pass

        currency = "AUD"
        comments_upper = comments.upper()
        if "USD" in comments_upper:
            currency = "USD"
        elif "GBP" in comments_upper:
            currency = "GBP"

        results.append({
            "ex_date":       ex_date,
            "payable_date":  payable_date,
            "record_date":   record_date,
            "amount":        amount,
            "franking_pct":  franking,
            "dividend_type": div_type.strip() or "Ordinary",
            "currency":      currency,
            "comments":      comments.strip(),
        })

    results.sort(key=lambda x: x["ex_date"], reverse=True)
    return results


# ── Frequency inference + response builder ──────────────────────────────────

def _infer_frequency(history: list[dict]) -> tuple[int | None, str]:
    """Infer payment frequency from ex_date gaps."""
    if len(history) < 2:
        return None, "Unknown"
    dates = sorted([h["ex_date"] for h in history if h.get("ex_date")])
    gaps = []
    for i in range(1, min(len(dates), 6)):
        try:
            d1 = datetime.strptime(dates[-i], "%Y-%m-%d")
            d2 = datetime.strptime(dates[-i-1], "%Y-%m-%d")
            gaps.append((d1 - d2).days)
        except ValueError:
            pass
    if not gaps:
        return None, "Unknown"
    avg = sum(gaps) / len(gaps)
    if avg < 50:    return 12, "Monthly"
    if avg < 110:   return 4,  "Quarterly"
    if avg < 200:   return 2,  "Semi-annual"
    return 1, "Annual"


def _build_dividend_response(ticker: str, asx_history: list[dict], yf_info: dict) -> dict:
    """Merge ASX history (primary) with yfinance metadata (secondary)."""
    code = ticker.upper().replace(".AX", "")
    frequency, freq_label = _infer_frequency(asx_history)

    ordinary = [h for h in asx_history if "special" not in h.get("dividend_type", "").lower()]
    next_est = None
    if ordinary:
        last_2_amounts = [h["amount"] for h in ordinary[:2] if h.get("amount") is not None]
        if last_2_amounts:
            next_est = round(sum(last_2_amounts) / len(last_2_amounts), 4)

    annual_div = yf_info.get("dividendRate")
    if not annual_div and next_est and frequency:
        annual_div = round(next_est * frequency, 4)
    if not annual_div and ordinary:
        one_year_ago = (datetime.now() - timedelta(days=370)).strftime("%Y-%m-%d")
        ttm = [h["amount"] for h in ordinary if h["ex_date"] >= one_year_ago and h.get("amount")]
        if ttm:
            annual_div = round(sum(ttm), 4)

    recent_franking = [h["franking_pct"] for h in asx_history[:6] if h.get("franking_pct") is not None]
    avg_franking = round(sum(recent_franking) / len(recent_franking), 1) if recent_franking else 0.0

    today_str = datetime.now().strftime("%Y-%m-%d")
    upcoming = next(
        (h for h in sorted(asx_history, key=lambda x: x["ex_date"])
         if h["ex_date"] >= today_str),
        None
    )
    ex_date_str  = upcoming["ex_date"]     if upcoming else (asx_history[0]["ex_date"] if asx_history else None)
    pay_date_str = upcoming["payable_date"] if upcoming else None

    history = [
        {
            "date":          h["ex_date"],
            "amount":        h["amount"],
            "franking_pct":  h["franking_pct"],
            "dividend_type": h["dividend_type"],
            "payable_date":  h["payable_date"],
        }
        for h in asx_history[:12]
        if h.get("amount") is not None
    ]

    def _norm_yield(v: float | None) -> float | None:
        if v is None:
            return None
        return round(v / 100.0, 6) if v > 1.0 else round(v, 6)

    div_yield    = _norm_yield(safe_float(yf_info.get("dividendYield")))
    payout_ratio = safe_float(yf_info.get("payoutRatio"))
    five_yr      = _norm_yield(safe_float(yf_info.get("fiveYearAvgDividendYield")))

    return {
        "ticker":            code,
        "dividendYield":     div_yield,
        "dividendRate":      safe_float(yf_info.get("dividendRate")),
        "annualDivPerShare": annual_div,
        "payoutRatio":       payout_ratio,
        "fiveYearAvgYield":  five_yr,
        "exDividendDate":    ex_date_str,
        "paymentDate":       pay_date_str,
        "frequency":         frequency,
        "frequencyLabel":    freq_label,
        "nextEstAmount":     next_est,
        "frankingPct":       avg_franking,
        "history":           history,
        "source":            "asx+yfinance",
    }


def _yf_info_safe(ticker: str) -> dict:
    try:
        return yf.Ticker(asx(ticker)).info or {}
    except Exception:
        return {}


def _fetch_dividends_for_ticker(code: str) -> dict:
    """yfinance primary → ASX scrape enrichment → _FRANKING_MAP fallback. Never raises."""
    yf_info = _yf_info_safe(code)

    history: list[dict] = []
    try:
        stk  = yf.Ticker(asx(code))
        divs = stk.dividends
        if not divs.empty:
            cutoff = datetime.now() - timedelta(days=3 * 365)
            for dt_raw, amt in divs.items():
                dt = dt_raw.to_pydatetime().replace(tzinfo=None)
                if dt < cutoff:
                    continue
                history.append({
                    "ex_date":       dt.strftime("%Y-%m-%d"),
                    "amount":        round(float(amt), 4),
                    "franking_pct":  _FRANKING_MAP.get(code, 0.0),
                    "dividend_type": "Ordinary",
                    "payable_date":  None,
                    "record_date":   None,
                    "currency":      "AUD",
                    "comments":      "",
                })
            history.sort(key=lambda x: x["ex_date"], reverse=True)
    except Exception:
        pass

    try:
        asx_history = scrape_asx_dividends(code)
        if asx_history:
            result = _build_dividend_response(code, asx_history, yf_info)
            result["source"] = "asx+yfinance"
            return result
    except Exception:
        pass

    if not history and not yf_info:
        return {"error": "no dividend data available", "ticker": code}

    result = _build_dividend_response(code, history, yf_info)
    result["source"] = "yfinance"
    return result


# ── Routes ───────────────────────────────────────────────────────────────────

@bp.route("/api/dividends/<ticker>")
def dividend_info(ticker):
    code = ticker.upper().replace(".AX", "")
    cached = _get_cached_dividends(code)
    if cached:
        return jsonify(cached)
    result = _fetch_dividends_for_ticker(code)
    if "error" not in result:
        _set_cached_dividends(code, result, result.get("source", "yfinance"))
    return jsonify(result)


@bp.route("/api/dividends/batch", methods=["POST"])
def dividend_batch():
    """Body: {"tickers": [...], "force": false}"""
    body    = request.get_json() or {}
    tickers = body.get("tickers", [])
    force   = bool(body.get("force", False))

    def _fetch_one(t: str) -> tuple[str, dict]:
        code = t.upper().replace(".AX", "")
        if not force:
            cached = _get_cached_dividends(code)
            if cached:
                return code, cached
        result = _fetch_dividends_for_ticker(code)
        if "error" not in result:
            _set_cached_dividends(code, result, result.get("source", "yfinance"))
        return code, result

    if not tickers:
        return jsonify({})

    results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=min(len(tickers), 6)) as pool:
        for code, result in pool.map(_fetch_one, tickers):
            results[code] = result
    return jsonify(results)


@bp.route("/api/dividends/cache/clear", methods=["POST"])
def dividend_cache_clear():
    """Force-expire the dividend cache for given tickers (or all if none specified)."""
    body    = request.get_json() or {}
    tickers = [t.upper().replace(".AX", "") for t in body.get("tickers", [])]
    try:
        with get_db() as conn:
            if tickers:
                placeholders = ",".join("?" * len(tickers))
                conn.execute(
                    f"DELETE FROM dividend_cache WHERE ticker IN ({placeholders})", tickers
                )
            else:
                conn.execute("DELETE FROM dividend_cache")
        return jsonify({"ok": True})
    except Exception as ex:
        return jsonify({"ok": False, "error": str(ex)}), 500
