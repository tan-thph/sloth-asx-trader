"""
routes/import_csv.py — Broker CSV parser (CommSec, SelfWealth, generic).

POST /api/import/csv
    Body: multipart form-data with field 'file' (the CSV).
    Optional form field 'broker' hint: 'commsec' | 'selfwealth' | 'auto'

    Returns:
    {
      "ok": true,
      "broker": "commsec",
      "rows": [
        {"action": "BUY", "ticker": "BHP", "shares": 50, "price": 42.00,
         "date": "15-03-2024", "brokerage": 9.95}
      ],
      "skipped": [{"row": 3, "reason": "SELL not supported"}]
    }
"""

import csv
import io
import re
from datetime import datetime

from flask import Blueprint, jsonify, request

bp = Blueprint("import_csv", __name__)

# ── Date normalisation ────────────────────────────────────────────────────────

def _parse_date(raw: str) -> str | None:
    """Try common date formats; return DD-MM-YYYY or None."""
    raw = raw.strip().strip('"')
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d %b %Y", "%d %B %Y",
                "%d/%m/%y", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw, fmt).strftime("%d-%m-%Y")
        except ValueError:
            pass
    return None


# ── Broker detectors ──────────────────────────────────────────────────────────

def _detect_broker(header: list[str]) -> str:
    joined = ",".join(h.lower().strip().strip('"') for h in header)
    if "reference" in joined and "contract" in joined:
        return "commsec"
    if "description" in joined and "market" not in joined and "units" in joined:
        return "selfwealth"
    return "generic"


# ── CommSec parser ─────────────────────────────────────────────────────────────
# CommSec trade history export columns (typical):
#   Date, Reference, Market, Code, Description, Price, Units, Amount,
#   Brokerage, GST, Contract, Order Date, Credit/Debit

def _parse_commsec(rows: list[dict]) -> tuple[list, list]:
    out, skipped = [], []
    for i, r in enumerate(rows, start=2):
        # Column key normalisation
        lower_r = {k.strip().strip('"').lower(): v.strip().strip('"') for k, v in r.items()}
        date   = _parse_date(lower_r.get("date", ""))
        ticker = (lower_r.get("code") or lower_r.get("market code") or "").upper()
        price_str = lower_r.get("price", "").replace("$", "").replace(",", "")
        units_str = lower_r.get("units", "").replace(",", "")
        brok_str  = lower_r.get("brokerage", "0").replace("$", "").replace(",", "")
        desc      = lower_r.get("description", "").upper()

        if not ticker or not date:
            skipped.append({"row": i, "reason": f"missing ticker or date ({ticker!r}, {lower_r.get('date')!r})"})
            continue

        try:
            price  = float(price_str)
            shares = float(units_str)
            brok   = float(brok_str or "0")
        except ValueError:
            skipped.append({"row": i, "reason": f"non-numeric price/units: {price_str!r}/{units_str!r}"})
            continue

        if price <= 0 or shares <= 0:
            skipped.append({"row": i, "reason": "zero price or shares"})
            continue

        action = "SELL" if "SELL" in desc else "BUY"
        out.append({
            "action":    action,
            "ticker":    ticker,
            "shares":    round(shares, 6),
            "price":     round(price, 4),
            "date":      date,
            "brokerage": round(brok, 2),
        })
    return out, skipped


# ── SelfWealth parser ─────────────────────────────────────────────────────────
# SelfWealth trade confirmation CSV columns (typical):
#   Trade Date, Settlement Date, Description, Quantity, Price, Brokerage,
#   GST on Brokerage, Total Amount, Portfolio

def _parse_selfwealth(rows: list[dict]) -> tuple[list, list]:
    out, skipped = [], []
    # Match "BUY 50 BHP.AX at 42.00" or "SELL 100 CBA"
    _desc_re = re.compile(
        r"^(BUY|SELL)\s+[\d.,]+\s+([A-Z0-9]+)(?:\.AX)?\b",
        re.IGNORECASE,
    )
    for i, r in enumerate(rows, start=2):
        lower_r = {k.strip().strip('"').lower(): v.strip().strip('"') for k, v in r.items()}
        date_raw = lower_r.get("trade date") or lower_r.get("date", "")
        date     = _parse_date(date_raw)
        desc     = lower_r.get("description", "")
        qty_str  = lower_r.get("quantity", "").replace(",", "")
        px_str   = lower_r.get("price", "").replace("$", "").replace(",", "")
        brok_str = lower_r.get("brokerage", "0").replace("$", "").replace(",", "")

        m = _desc_re.match(desc)
        if not m:
            skipped.append({"row": i, "reason": f"unrecognised description: {desc!r}"})
            continue
        action = m.group(1).upper()
        ticker = m.group(2).upper()

        if not date:
            skipped.append({"row": i, "reason": f"unparseable date: {date_raw!r}"})
            continue

        try:
            shares = float(qty_str)
            price  = float(px_str)
            brok   = float(brok_str or "0")
        except ValueError:
            skipped.append({"row": i, "reason": f"non-numeric qty/price: {qty_str!r}/{px_str!r}"})
            continue

        if price <= 0 or shares <= 0:
            skipped.append({"row": i, "reason": "zero price or shares"})
            continue

        out.append({
            "action":    action,
            "ticker":    ticker,
            "shares":    round(shares, 6),
            "price":     round(price, 4),
            "date":      date,
            "brokerage": round(brok, 2),
        })
    return out, skipped


# ── Generic parser ────────────────────────────────────────────────────────────
# Accepts any CSV with recognisable column names for ticker, shares, price, date.

def _parse_generic(rows: list[dict]) -> tuple[list, list]:
    out, skipped = [], []
    if not rows:
        return out, skipped

    # Normalise keys
    def _norm(key: str) -> str:
        return key.strip().strip('"').lower().replace(" ", "_")

    norm_rows = [{_norm(k): v.strip().strip('"') for k, v in r.items()} for r in rows]
    header = list(norm_rows[0].keys())

    def _pick(*candidates) -> str | None:
        for c in candidates:
            for h in header:
                if c in h:
                    return h
        return None

    col_ticker = _pick("ticker", "symbol", "code", "stock")
    col_shares = _pick("shares", "qty", "quantity", "units")
    col_price  = _pick("price", "avg", "cost_per")
    col_date   = _pick("date")
    col_brok   = _pick("fee", "brokerage", "commission")
    col_action = _pick("action", "type", "side", "transaction")

    if not (col_ticker and col_shares and col_price):
        return out, [{"row": 0, "reason": "could not identify ticker/shares/price columns"}]

    for i, r in enumerate(norm_rows, start=2):
        ticker    = (r.get(col_ticker) or "").upper().strip()
        shares_s  = (r.get(col_shares) or "").replace(",", "")
        price_s   = (r.get(col_price)  or "").replace("$", "").replace(",", "")
        date_raw  = r.get(col_date, "")
        brok_s    = (r.get(col_brok,  "0") or "0").replace("$", "").replace(",", "")
        action    = (r.get(col_action, "BUY") or "BUY").upper()

        if not ticker:
            continue

        date = _parse_date(date_raw) if date_raw else None
        if not date:
            skipped.append({"row": i, "reason": f"missing/unparseable date: {date_raw!r}"})
            continue

        try:
            shares = float(shares_s)
            price  = float(price_s)
            brok   = float(brok_s or "0")
        except ValueError:
            skipped.append({"row": i, "reason": f"non-numeric values: shares={shares_s!r} price={price_s!r}"})
            continue

        if price <= 0 or shares <= 0:
            skipped.append({"row": i, "reason": "zero price or shares"})
            continue

        out.append({
            "action":    "SELL" if "SELL" in action else "BUY",
            "ticker":    ticker,
            "shares":    round(shares, 6),
            "price":     round(price, 4),
            "date":      date,
            "brokerage": round(brok, 2),
        })
    return out, skipped


# ── Route ─────────────────────────────────────────────────────────────────────

@bp.route("/api/import/csv", methods=["POST"])
def import_csv():
    """Parse a broker trade-history CSV and return normalised rows.

    Multipart: field 'file' = CSV file; optional field 'broker' = 'commsec' | 'selfwealth' | 'auto'
    """
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "No file uploaded"}), 400

    uploaded = request.files["file"]
    broker_hint = (request.form.get("broker") or "auto").lower().strip()

    try:
        raw_text = uploaded.stream.read().decode("utf-8-sig", errors="replace")
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not read file: {e}"}), 400

    # Parse CSV into list-of-dicts
    try:
        reader = csv.DictReader(io.StringIO(raw_text))
        all_rows = list(reader)
        header   = reader.fieldnames or []
    except Exception as e:
        return jsonify({"ok": False, "error": f"CSV parse error: {e}"}), 400

    if not all_rows:
        return jsonify({"ok": False, "error": "CSV is empty"}), 400

    # Detect broker
    if broker_hint == "commsec":
        detected = "commsec"
    elif broker_hint == "selfwealth":
        detected = "selfwealth"
    else:
        detected = _detect_broker(header)

    if detected == "commsec":
        rows, skipped = _parse_commsec(all_rows)
    elif detected == "selfwealth":
        rows, skipped = _parse_selfwealth(all_rows)
    else:
        rows, skipped = _parse_generic(all_rows)

    # Split into BUY and SELL rows — SELLs returned separately for frontend FIFO matching
    sells = [r for r in rows if r["action"] == "SELL"]
    buys  = [r for r in rows if r["action"] == "BUY"]

    # Sort chronologically
    buys.sort(key=lambda r: r["date"])
    sells.sort(key=lambda r: r["date"])

    return jsonify({
        "ok":      True,
        "broker":  detected,
        "rows":    buys,
        "sells":   sells,
        "skipped": skipped,
        "total":   len(all_rows),
    })
