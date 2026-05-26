"""
routes/portfolio.py — Cash + bulk state save/load.

Endpoints:
  /api/cash             GET / POST
  /api/db/save          POST   — bulk save of frontend state
  /api/db/load          GET    — bulk restore
  /api/db/refresh-sectors POST — re-look-up sectors for all holdings
  /api/db/status        GET    — row counts
"""

import json
from datetime import datetime

from flask import Blueprint, jsonify, request

from db import DB_PATH, get_db
from indicators import get_sector_for_ticker


bp = Blueprint("portfolio", __name__)


# ── Cash ──────────────────────────────────────────────────────────────────────

@bp.route("/api/cash")
def get_cash():
    """Return current cash balance from DB."""
    with get_db() as conn:
        row = conn.execute("SELECT amount, updated_at FROM cash WHERE id=1").fetchone()
        if row:
            return jsonify({"cash": row["amount"], "updatedAt": row["updated_at"]})
        return jsonify({"cash": 15000, "updatedAt": None})


@bp.route("/api/cash", methods=["POST"])
def set_cash():
    """Update cash balance. Body: {"amount": 12345.67}"""
    data = request.get_json() or {}
    amount = data.get("amount")
    if amount is None:
        return jsonify({"error": "amount required"}), 400
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO cash (id, amount, updated_at) VALUES (1, ?, datetime('now','localtime'))",
            (float(amount),)
        )
    return jsonify({"ok": True, "cash": float(amount)})


# ── Bulk save / load ─────────────────────────────────────────────────────────

@bp.route("/api/db/save", methods=["POST"])
def db_save():
    """Save full frontend state to SQLite in one call."""
    data = request.get_json() or {}
    with get_db() as conn:
        # --- cash ---
        if "cash" in data:
            conn.execute(
                "INSERT OR REPLACE INTO cash (id, amount, updated_at) VALUES (1, ?, datetime('now','localtime'))",
                (data["cash"],)
            )

        # --- portfolio ---
        if "portfolio" in data:
            conn.execute("DELETE FROM portfolio")
            for h in data["portfolio"]:
                conn.execute(
                    "INSERT INTO portfolio (ticker, shares, avg_price, current_price, sector) VALUES (?,?,?,?,?)",
                    (h["ticker"], h["shares"], h["avgPrice"], h["currentPrice"], h.get("sector","Other"))
                )

        # --- trade journal ---
        if "tradeJournal" in data:
            conn.execute("DELETE FROM trade_journal")
            for t in data["tradeJournal"]:
                conn.execute("""
                    INSERT INTO trade_journal
                        (date, timestamp, ticker, action, qty, entry_price, exit_price, fees, pnl, status, rec_id, rec_executed, close_date)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    t.get("date"), t.get("timestamp"), t["ticker"], t["action"],
                    t["qty"], t["entryPrice"], t.get("exitPrice"),
                    t.get("fees", 10), t.get("pnl"), t.get("status","open"),
                    t.get("recId"), 1 if t.get("recExecuted") else 0,
                    t.get("closeDate"),
                ))

        # --- rec history ---
        if "recHistory" in data:
            conn.execute("DELETE FROM rec_history")
            for r in data["recHistory"]:
                pr = r.get("priceRange", [None, None])
                conn.execute("""
                    INSERT OR REPLACE INTO rec_history
                        (id, date, ticker, action, confidence, price_range_low, price_range_high,
                         target, stop_loss, expected_profit, net_profit, executed, executed_at,
                         outcome, actual_profit, reasoning, risks, signals, learning_id)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    r["id"], r["date"], r["ticker"], r["action"],
                    r.get("confidence"), pr[0] if pr else None, pr[1] if pr else None,
                    r.get("target"), r.get("stopLoss"), r.get("expectedProfit"), r.get("netProfit"),
                    1 if r.get("executed") else 0, r.get("executedAt"),
                    r.get("outcome"), r.get("actualProfit"),
                    r.get("reasoning"), r.get("risks"),
                    json.dumps(r.get("signals", [])),
                    r.get("learningId") or r.get("_learningId"),
                ))

        # --- settings ---
        if "settings" in data:
            for k, v in data["settings"].items():
                if k == "apiKey":
                    continue  # never persist API key to disk
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))",
                    (k, json.dumps(v))
                )

        # --- blob_store: persist arbitrary JSON state fields ---
        BLOB_KEYS = [
            'analysisConfig', 'macroData', 'macroDate', 'analysisLastSummary',
            'portfolioHistory', 'cgtParcels', 'cgtDisposals', 'cgtMethod', 'activityLog',
            'recommendations', 'priceAlerts', 'dayTrading',
        ]
        for key in BLOB_KEYS:
            if key in data:
                conn.execute(
                    "INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))",
                    (key, json.dumps(data[key]))
                )

    return jsonify({"ok": True, "saved_at": datetime.now().isoformat()})


@bp.route("/api/db/load")
def db_load():
    """Load full state from SQLite."""
    with get_db() as conn:
        cash_row = conn.execute("SELECT amount FROM cash WHERE id=1").fetchone()
        cash = cash_row["amount"] if cash_row else 15000

        portfolio = []
        for row in conn.execute("SELECT * FROM portfolio ORDER BY id").fetchall():
            portfolio.append({
                "ticker": row["ticker"],
                "shares": row["shares"],
                "avgPrice": row["avg_price"],
                "currentPrice": row["current_price"],
                "sector": row["sector"],
            })

        trade_journal = []
        for row in conn.execute("SELECT * FROM trade_journal ORDER BY date DESC, id DESC").fetchall():
            trade_journal.append({
                "id": row["id"],
                "date": row["date"],
                "timestamp": row["timestamp"],
                "ticker": row["ticker"],
                "action": row["action"],
                "qty": row["qty"],
                "entryPrice": row["entry_price"],
                "exitPrice": row["exit_price"],
                "fees": row["fees"],
                "pnl": row["pnl"],
                "status": row["status"],
                "recId": row["rec_id"],
                "recExecuted": bool(row["rec_executed"]),
                "closeDate": row["close_date"],
            })

        rec_history = []
        for row in conn.execute("SELECT * FROM rec_history ORDER BY date DESC").fetchall():
            rec_history.append({
                "id": row["id"],
                "date": row["date"],
                "ticker": row["ticker"],
                "action": row["action"],
                "confidence": row["confidence"],
                "priceRange": [row["price_range_low"], row["price_range_high"]],
                "target": row["target"],
                "stopLoss": row["stop_loss"],
                "expectedProfit": row["expected_profit"],
                "netProfit": row["net_profit"],
                "executed": bool(row["executed"]),
                "executedAt": row["executed_at"],
                "outcome": row["outcome"],
                "actualProfit": row["actual_profit"],
                "reasoning": row["reasoning"],
                "risks": row["risks"],
                "signals": json.loads(row["signals"]) if row["signals"] else [],
                "_learningId": row["learning_id"],
            })

        settings = {}
        for row in conn.execute("SELECT key, value FROM settings").fetchall():
            try:
                settings[row["key"]] = json.loads(row["value"])
            except Exception:
                settings[row["key"]] = row["value"]

        has_data = bool(portfolio or trade_journal or rec_history or settings)

        blobs = {}
        for row in conn.execute("SELECT key, value FROM blob_store").fetchall():
            try:
                blobs[row["key"]] = json.loads(row["value"])
            except Exception:
                blobs[row["key"]] = row["value"]

    return jsonify({
        "hasData": has_data,
        "cash": cash,
        "portfolio": portfolio,
        "tradeJournal": trade_journal,
        "recHistory": rec_history,
        "settings": settings,
        "loadedAt": datetime.now().isoformat(),
        "analysisConfig":       blobs.get("analysisConfig"),
        "macroData":            blobs.get("macroData"),
        "macroDate":            blobs.get("macroDate"),
        "analysisLastSummary":  blobs.get("analysisLastSummary"),
        "portfolioHistory":     blobs.get("portfolioHistory"),
        "cgtParcels":           blobs.get("cgtParcels"),
        "cgtDisposals":         blobs.get("cgtDisposals"),
        "cgtMethod":            blobs.get("cgtMethod"),
        "activityLog":          blobs.get("activityLog"),
        "recommendations":      blobs.get("recommendations"),
        "dayTrading":           blobs.get("dayTrading"),
        "priceAlerts":          blobs.get("priceAlerts"),
    })


@bp.route("/api/db/refresh-sectors", methods=["POST"])
def refresh_portfolio_sectors():
    """Refresh sector information for all holdings in the portfolio."""
    with get_db() as conn:
        portfolio = conn.execute("SELECT ticker FROM portfolio").fetchall()
        updated_count = 0
        for row in portfolio:
            ticker = row["ticker"]
            sector = get_sector_for_ticker(ticker)
            conn.execute(
                "UPDATE portfolio SET sector = ? WHERE ticker = ?",
                (sector, ticker)
            )
            updated_count += 1
    return jsonify({
        "ok": True,
        "updated": updated_count,
        "message": f"Updated sectors for {updated_count} holdings"
    })


@bp.route("/api/db/status")
def db_status():
    """Quick check — returns row counts."""
    with get_db() as conn:
        return jsonify({
            "db": str(DB_PATH),
            "portfolio_rows": conn.execute("SELECT COUNT(*) FROM portfolio").fetchone()[0],
            "journal_rows":   conn.execute("SELECT COUNT(*) FROM trade_journal").fetchone()[0],
            "rec_rows":       conn.execute("SELECT COUNT(*) FROM rec_history").fetchone()[0],
        })
