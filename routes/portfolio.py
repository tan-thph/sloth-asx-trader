"""
routes/portfolio.py — Cash + bulk state save/load.

Endpoints:
  /api/cash             GET / POST
  /api/db/save          POST   — bulk save of frontend state
  /api/db/load          GET    — bulk restore
  /api/db/refresh-sectors POST — re-look-up sectors for all holdings
  /api/db/status        GET    — row counts
"""

import csv
import io
import json
import zipfile
from datetime import datetime

from flask import Blueprint, Response, jsonify, request

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
    """Save full frontend state to SQLite in one call.

    Optimistic-concurrency guard: the client sends `baseVersion` — the
    `_state_version` it last loaded/saved. If the stored version has moved on
    since (another tab/device saved in between), this save is stale and would
    silently clobber newer data, so we reject with 409 and echo the current
    version. The client then reloads instead of overwriting (the 2026-07-03
    disappearing-macro incident: a stale tab auto-saved yesterday's snapshot
    over today's fresh macro + recs). `baseVersion` omitted → legacy client,
    guard skipped. `forceSave:true` → intentional override (post-reload retry).
    """
    data = request.get_json() or {}
    with get_db() as conn:
        # --- optimistic concurrency guard (runs before any write) ---
        _sv_row = conn.execute(
            "SELECT value FROM blob_store WHERE key='_state_version'"
        ).fetchone()
        cur_ver = 0
        if _sv_row:
            try:
                cur_ver = int(json.loads(_sv_row["value"]))
            except Exception:
                cur_ver = 0
        base_ver = data.get("baseVersion", None)
        if (base_ver is not None and not data.get("forceSave")
                and int(base_ver) < cur_ver):
            return jsonify({
                "ok": False, "conflict": True,
                "stateVersion": cur_ver,
                "error": "stale_state",
            }), 409
        new_ver = cur_ver + 1

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
                    "INSERT INTO portfolio (ticker, shares, avg_price, current_price, sector, account, mode) VALUES (?,?,?,?,?,?,?)",
                    (h["ticker"], h["shares"], h["avgPrice"], h["currentPrice"],
                     h.get("sector", "Other"), h.get("account", "personal"),
                     # Paper/real firewall — default 'paper' so a mode-less holding is
                     # never persisted as real (isRealTrade() invariant, gotcha #88).
                     h.get("mode") or "paper")
                )

        # --- trade journal ---
        # The `id` MUST be passed explicitly. trade_journal.id is INTEGER PRIMARY
        # KEY AUTOINCREMENT; omitting it here used to let SQLite assign a brand-new
        # id to every row on every single save (this DELETE+INSERT runs on every
        # scheduleSave()), silently invalidating any reference to a journal entry's
        # id held elsewhere in client state — e.g. state.intraday.openPositions[]
        # ._journalId, used by closeIntradayPosition() to patch the paired BUY leg
        # on exit. When that lookup failed, the close fell through to a fallback
        # path that created an orphaned new SELL row with no recId (mislabeled
        # "Manual" in the Journal) while the original BUY row stayed status='open'
        # forever (2026-06-23 PAR incident). Also previously dropped account,
        # sector, parcelId, disposalIds, notes, thesis, entrySignals, exitSignals —
        # none were in the column list, so every save↔reload cycle erased them.
        if "tradeJournal" in data:
            conn.execute("DELETE FROM trade_journal")
            for t in data["tradeJournal"]:
                conn.execute("""
                    INSERT INTO trade_journal
                        (id, date, timestamp, ticker, action, qty, entry_price, exit_price, fees, pnl, status,
                         rec_id, rec_executed, close_date, account, sector, parcel_id, disposal_ids, notes, thesis,
                         entry_signals_json, exit_signals_json, regime, parcel, parcel_open_date, mode,
                         rule_warnings_json)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    t.get("id"),
                    t.get("date"), t.get("timestamp"), t["ticker"], t["action"],
                    t["qty"], t["entryPrice"], t.get("exitPrice"),
                    t.get("fees", 10), t.get("pnl"), t.get("status","open"),
                    t.get("recId"), 1 if t.get("recExecuted") else 0,
                    t.get("closeDate"),
                    t.get("account", "personal"), t.get("sector"), t.get("parcelId"),
                    json.dumps(t["disposalIds"]) if t.get("disposalIds") is not None else None,
                    t.get("notes"), t.get("thesis"),
                    json.dumps(t["entrySignals"]) if t.get("entrySignals") is not None else None,
                    json.dumps(t["exitSignals"])  if t.get("exitSignals")  is not None else None,
                    t.get("regime"), t.get("parcel"), t.get("parcelOpenDate"),
                    # Paper/real firewall — default 'paper' so a mode-less row can
                    # never be persisted as real (isRealTrade() invariant).
                    t.get("mode") or "paper",
                    # Failed-quant-rule override marker (Phase 4). Accept a list or a
                    # pre-serialized string; NULL when the trade was clean.
                    (t.get("ruleWarnings")
                     if isinstance(t.get("ruleWarnings"), (str, type(None)))
                     else json.dumps(t.get("ruleWarnings"))),
                ))

        # --- rec history ---
        if "recHistory" in data:
            conn.execute("DELETE FROM rec_history")
            for r in data["recHistory"]:
                pr = r.get("priceRange", [None, None])
                # extra_json carries the FULL rec object (scenarios, bullCase/bearCase,
                # qty, primary_driver, _thesisCheck, invalidationCondition, factorsUsed,
                # traceability snapshots, etc.) so nothing is lost on save/reload — the
                # explicit columns below remain the canonical source for the fields they
                # cover (and are what db_load() overlays on top of extra_json).
                conn.execute("""
                    INSERT OR REPLACE INTO rec_history
                        (id, date, ticker, action, confidence, price_range_low, price_range_high,
                         target, stop_loss, expected_profit, net_profit, executed, executed_at,
                         outcome, actual_profit, reasoning, risks, signals, learning_id, extra_json)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    r["id"], r["date"], r["ticker"], r["action"],
                    r.get("confidence"), pr[0] if pr else None, pr[1] if pr else None,
                    r.get("target"), r.get("stopLoss"), r.get("expectedProfit"), r.get("netProfit"),
                    1 if r.get("executed") else 0, r.get("executedAt"),
                    r.get("outcome"), r.get("actualProfit"),
                    r.get("reasoning"), r.get("risks"),
                    json.dumps(r.get("signals", [])),
                    r.get("learningId") or r.get("_learningId"),
                    json.dumps(r),
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
            'recommendations', 'priceAlerts', 'dayTrading', 'intraday',
            'watchlist', 'savedScreeners', 'targetAllocations', 'digestHistory', 'termDeposits',
            'paperCash',  # separate simulated cash pool for paper trades (real `cash` stays in the cash table)
        ]
        for key in BLOB_KEYS:
            if key in data:
                conn.execute(
                    "INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))",
                    (key, json.dumps(data[key]))
                )

        # --- bump the monotonic state version (last, so a rejected save above
        #     never advances it) ---
        conn.execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES ('_state_version', ?, datetime('now','localtime'))",
            (json.dumps(new_ver),)
        )

    return jsonify({"ok": True, "saved_at": datetime.now().isoformat(),
                    "stateVersion": new_ver})


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
                "account": row["account"] if "account" in row.keys() else "personal",
                # Paper/real firewall — default 'paper' for any legacy/mode-less row
                # so it's never treated as real by the isRealTrade() invariant.
                "mode": (row["mode"] if "mode" in row.keys() else None) or "paper",
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
                "account": row["account"] or "personal",
                "sector": row["sector"],
                "parcelId": row["parcel_id"],
                "disposalIds": json.loads(row["disposal_ids"]) if row["disposal_ids"] else None,
                "notes": row["notes"],
                "thesis": row["thesis"],
                "entrySignals": json.loads(row["entry_signals_json"]) if row["entry_signals_json"] else None,
                "exitSignals":  json.loads(row["exit_signals_json"])  if row["exit_signals_json"]  else None,
                "regime": row["regime"] if "regime" in row.keys() else None,
                "parcel":         row["parcel"]          if "parcel"          in row.keys() else None,
                "parcelOpenDate": row["parcel_open_date"] if "parcel_open_date" in row.keys() else None,
                # Paper/real firewall — default 'paper' for any legacy/mode-less row
                # so it's never treated as real by the isRealTrade() invariant.
                "mode": (row["mode"] if "mode" in row.keys() else None) or "paper",
                # Failed-quant-rule override marker (Phase 4). Reconstruct the list +
                # the overrodeRules convenience flag the frontend renders from.
                **((lambda _rw: {"ruleWarnings": _rw, "overrodeRules": True}
                   if _rw else {})(
                    json.loads(row["rule_warnings_json"])
                    if ("rule_warnings_json" in row.keys() and row["rule_warnings_json"]) else None)),
            })

        rec_history = []
        for row in conn.execute("SELECT * FROM rec_history ORDER BY date DESC").fetchall():
            # extra_json (when present) carries the full rec object as it was saved —
            # scenarios, bullCase/bearCase, qty, primary_driver, _thesisCheck,
            # invalidationCondition, factorsUsed, traceability snapshots, etc. Used as
            # the base; the explicit columns below are overlaid on top since they're
            # the canonical source for the fields they cover. Rows saved before this
            # column existed have extra_json = NULL and fall back to the explicit
            # columns only (the pre-existing, narrower behaviour).
            extra = {}
            if row["extra_json"] if "extra_json" in row.keys() else None:
                try:
                    extra = json.loads(row["extra_json"])
                except Exception:
                    extra = {}
            rec_history.append({
                **extra,
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

        # Monotonic version for the optimistic-concurrency guard (see db_save).
        # Stored in blob_store under a leading-underscore key so it is not part
        # of any frontend state field.
        try:
            state_version = int(blobs.get("_state_version") or 0)
        except (TypeError, ValueError):
            state_version = 0

    return jsonify({
        "hasData": has_data,
        "stateVersion": state_version,
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
        "watchlist":            blobs.get("watchlist"),
        "savedScreeners":       blobs.get("savedScreeners"),
        "targetAllocations":    blobs.get("targetAllocations"),
        "digestHistory":        blobs.get("digestHistory"),
        "termDeposits":         blobs.get("termDeposits"),
        "paperCash":            blobs.get("paperCash"),
        "intraday":             blobs.get("intraday"),
        "universe_excluded":    blobs.get("universe_excluded") or [],
        "universe_verified_at": blobs.get("universe_verified_at"),
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


@bp.route("/api/tax/eofy-pack")
def eofy_tax_pack():
    """Download EOFY tax pack as a ZIP containing two CSVs.

    Query param: ?year=2025  (FY ending June 2025 = 2024-07-01 to 2025-06-30).
    Defaults to the current financial year.
    """
    now = datetime.now()
    default_year = now.year if now.month >= 7 else now.year - 1
    try:
        year = int(request.args.get("year", default_year))
    except (TypeError, ValueError):
        year = default_year

    fy_start = f"{year}-07-01"
    fy_end   = f"{year + 1}-06-30"

    with get_db() as conn:
        # CGT disposals from blob_store
        cgt_blob = conn.execute(
            "SELECT value FROM blob_store WHERE key='cgtDisposals'"
        ).fetchone()
        disposals = json.loads(cgt_blob["value"]) if cgt_blob else []

        # Trade journal fees for the FY
        fee_rows = conn.execute("""
            SELECT date, ticker, action, qty, entry_price, exit_price, fees, pnl, status, mode
            FROM trade_journal
            ORDER BY date ASC
        """).fetchall()

    # Paper/real firewall: the tax pack is REAL-ONLY. Paper trades never produce a
    # CGT event, so they must never appear in an ATO-facing export. A disposal or
    # journal row is real only when mode=='real' (missing/None ⇒ paper), matching
    # the isRealTrade() invariant in js/utils.js.
    def _is_real(x):
        try:
            return (x.get("mode") if isinstance(x, dict) else x["mode"]) == "real"
        except Exception:
            return False

    # Filter disposals by FY sale date AND real-only
    fy_disposals = [
        d for d in disposals
        if isinstance(d, dict) and _is_real(d)
        and fy_start <= (d.get("saleDate") or "") <= fy_end
    ]

    # Filter trades by FY date (DD-MM-YYYY → compare as YYYY-MM-DD)
    def _dd_mm_to_iso(d):
        parts = (d or "").split("-")
        if len(parts) == 3 and len(parts[2]) == 4:
            return f"{parts[2]}-{parts[1]}-{parts[0]}"
        return d or ""

    fy_trades = [
        r for r in fee_rows
        if _is_real(r) and fy_start <= _dd_mm_to_iso(r["date"]) <= fy_end
    ]

    # ── CGT disposals CSV ──────────────────────────────────────────────────────
    cgt_buf = io.StringIO()
    w = csv.writer(cgt_buf)
    w.writerow([
        "SaleDate", "Ticker", "SalePrice", "SaleQty", "Proceeds",
        "ParcelDate", "CostPerShare", "CostBase", "SaleFee",
        "GrossGain", "CGTDiscount", "NetGain", "HeldDays", "50pct_Eligible"
    ])
    gross_gain_total = 0.0
    for d in fy_disposals:
        w.writerow([
            d.get("saleDate", ""),
            d.get("ticker", ""),
            round(d.get("salePrice", 0), 4),
            d.get("saleQty", 0),
            round(d.get("proceeds", 0), 2),
            d.get("parcelDate", ""),
            round(d.get("parcelCostPerShare", 0), 4),
            round(d.get("costBase", 0), 2),
            round(d.get("saleFee", 0), 2),
            round(d.get("grossGain", 0), 2),
            round(d.get("discount", 0), 2),
            round(d.get("netGain", 0), 2),
            d.get("heldDays", ""),
            "Yes" if d.get("eligible50") else "No",
        ])
        gross_gain_total += float(d.get("grossGain", 0) or 0)
    w.writerow([])
    w.writerow(["", "", "", "", "", "", "", "", "Total gross gain:", round(gross_gain_total, 2)])

    # ── Trade fees CSV ─────────────────────────────────────────────────────────
    fees_buf = io.StringIO()
    w2 = csv.writer(fees_buf)
    w2.writerow(["Date", "Ticker", "Action", "Qty", "EntryPrice", "ExitPrice", "Fee", "PnL", "Status"])
    total_fees = 0.0
    total_pnl  = 0.0
    for r in fy_trades:
        w2.writerow([
            r["date"], r["ticker"], r["action"],
            r["qty"], r["entry_price"], r["exit_price"] or "",
            round(float(r["fees"] or 0), 2),
            round(float(r["pnl"] or 0), 2) if r["pnl"] is not None else "",
            r["status"],
        ])
        total_fees += float(r["fees"] or 0)
        if r["pnl"] is not None:
            total_pnl += float(r["pnl"])
    w2.writerow([])
    w2.writerow(["", "", "", "", "", "Total fees:", round(total_fees, 2)])
    w2.writerow(["", "", "", "", "", "Total realised P&L:", round(total_pnl, 2)])

    # ── Bundle into ZIP ────────────────────────────────────────────────────────
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"cgt_disposals_FY{year}-{year+1}.csv", cgt_buf.getvalue())
        zf.writestr(f"trade_fees_FY{year}-{year+1}.csv",    fees_buf.getvalue())

    zip_buf.seek(0)
    return Response(
        zip_buf.read(),
        mimetype="application/zip",
        headers={"Content-Disposition": f"attachment; filename=eofy_tax_pack_FY{year}-{year+1}.zip"},
    )


@bp.route("/api/portfolio/backfill-modes", methods=["POST"])
def backfill_modes():
    """One-time legacy→real mode migration (FIXES.md #3).

    The paper/real firewall shipped with "missing mode ⇒ paper", the correct
    fail-safe for NEW records — but it left the user's entire pre-firewall book
    invisible to every real-only surface (EOFY tax pack, CGT liability, NAV
    history, Performance real view). Worse, the server default rewrote legacy
    journal rows to 'paper' on the first post-feature save, so legacy-real and
    deliberate-paper can no longer be told apart from the data alone.

    Strategy (user-confirmed): mark EVERYTHING real EXCEPT the CGT parcels already
    explicitly flagged mode='paper', plus any journal rows / disposals linked to
    those parcels by id. This is genuinely one-time — going forward askTradeMode()
    keeps modes explicit.

    Body: {"dry_run": true|false}. Dry-run (default) returns the counts that WOULD
    change without writing. Applying bumps _state_version so any stale client is
    forced to reload (version guard) rather than clobbering the migration back to
    paper on its next save.
    """
    data = request.get_json() or {}
    dry_run = data.get("dry_run", True)

    def _parcel_num(s):
        # journal `parcel` field is like "P#<id>"; extract the id.
        if isinstance(s, str) and s.startswith("P#"):
            return s[2:]
        return None

    with get_db() as conn:
        # --- identify the preserve set: parcels explicitly flagged paper ---
        pblob = conn.execute("SELECT value FROM blob_store WHERE key='cgtParcels'").fetchone()
        parcels = json.loads(pblob["value"]) if pblob else []
        preserve_ids = {str(p.get("id")) for p in parcels if (p.get("mode") == "paper")}

        # --- portfolio: all → real ---
        port_n = conn.execute(
            "SELECT COUNT(*) FROM portfolio WHERE mode != 'real'"
        ).fetchone()[0]

        # --- trade_journal: all → real EXCEPT rows linked to a preserved parcel ---
        jrows = conn.execute(
            "SELECT id, parcel_id, parcel, mode FROM trade_journal"
        ).fetchall()
        journal_to_real = []
        for r in jrows:
            linked = (str(r["parcel_id"]) in preserve_ids) or (_parcel_num(r["parcel"]) in preserve_ids)
            if not linked and r["mode"] != "real":
                journal_to_real.append(r["id"])

        # --- cgtParcels blob: paper stays paper, everything else → real ---
        parcels_to_real = sum(1 for p in parcels if p.get("mode") != "paper" and p.get("mode") != "real")

        # --- cgtDisposals blob: paper-parcel-linked stay paper, else → real ---
        dblob = conn.execute("SELECT value FROM blob_store WHERE key='cgtDisposals'").fetchone()
        disposals = json.loads(dblob["value"]) if dblob else []
        disp_to_real = sum(
            1 for d in disposals
            if str(d.get("parcelId")) not in preserve_ids and d.get("mode") != "paper" and d.get("mode") != "real"
        )

        # --- rec_history: mode lives in extra_json; mark real ---
        rrows = conn.execute("SELECT id, extra_json FROM rec_history").fetchall()
        rec_to_real = 0
        rec_updates = []
        for r in rrows:
            try:
                extra = json.loads(r["extra_json"]) if r["extra_json"] else {}
            except Exception:
                extra = {}
            if extra.get("mode") != "real":
                extra["mode"] = "real"
                rec_updates.append((json.dumps(extra), r["id"]))
                rec_to_real += 1

        # --- ai_learning_events: all → real ---
        learn_n = conn.execute(
            "SELECT COUNT(*) FROM ai_learning_events WHERE trade_mode IS NOT 'real'"
        ).fetchone()[0]

        summary = {
            "portfolio": port_n,
            "journal": len(journal_to_real),
            "parcels": parcels_to_real,
            "disposals": disp_to_real,
            "rec_history": rec_to_real,
            "learning_events": learn_n,
            "preserved_paper_parcels": len(preserve_ids),
        }

        if dry_run:
            return jsonify({"ok": True, "dry_run": True, "would_change": summary})

        # --- APPLY ---
        conn.execute("UPDATE portfolio SET mode='real' WHERE mode != 'real'")

        if journal_to_real:
            qmarks = ",".join("?" * len(journal_to_real))
            conn.execute(f"UPDATE trade_journal SET mode='real' WHERE id IN ({qmarks})", journal_to_real)

        for p in parcels:
            if p.get("mode") != "paper":
                p["mode"] = "real"
        conn.execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES ('cgtParcels', ?, datetime('now','localtime'))",
            (json.dumps(parcels),)
        )

        for d in disposals:
            if str(d.get("parcelId")) not in preserve_ids and d.get("mode") != "paper":
                d["mode"] = "real"
        conn.execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES ('cgtDisposals', ?, datetime('now','localtime'))",
            (json.dumps(disposals),)
        )

        for payload, rid in rec_updates:
            conn.execute("UPDATE rec_history SET extra_json=? WHERE id=?", (payload, rid))

        conn.execute("UPDATE ai_learning_events SET trade_mode='real' WHERE trade_mode IS NOT 'real'")

        # Bump the state version LAST so a stale client's next save 409s and it
        # reloads the migrated data instead of clobbering it back to paper.
        sv = conn.execute("SELECT value FROM blob_store WHERE key='_state_version'").fetchone()
        try:
            cur = int(json.loads(sv["value"])) if sv else 0
        except Exception:
            cur = 0
        conn.execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES ('_state_version', ?, datetime('now','localtime'))",
            (json.dumps(cur + 1),)
        )

    return jsonify({"ok": True, "dry_run": False, "changed": summary,
                    "reloadRequired": True, "stateVersion": cur + 1})


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


@bp.route("/api/portfolio/splits-check")
def splits_check():
    """Check for corporate-action stock splits in the last 90 days.

    Query param: tickers (comma-separated, e.g. CBA.AX,BHP.AX)
    Returns: {TICKER: [{date, ratio}]} — empty list when no recent splits.
    """
    import yfinance as yf
    from datetime import timedelta

    raw = request.args.get("tickers", "")
    tickers = [t.strip().upper() for t in raw.split(",") if t.strip()]
    if not tickers:
        return jsonify({"error": "tickers required"}), 400

    cutoff = datetime.utcnow() - timedelta(days=90)
    result = {}
    for ticker in tickers[:50]:  # cap to avoid abuse
        try:
            sym = ticker if ticker.endswith(".AX") else ticker + ".AX"
            splits = yf.Ticker(sym).splits
            if splits is None or splits.empty:
                result[ticker] = []
                continue
            recent = [
                {"date": str(idx.date()), "ratio": float(val)}
                for idx, val in splits.items()
                if idx.to_pydatetime().replace(tzinfo=None) >= cutoff and float(val) != 1.0
            ]
            result[ticker] = recent
        except Exception:
            result[ticker] = []
    return jsonify(result)


@bp.route("/api/portfolio/capital-returns-check")
def capital_returns_check():
    """Flag large single-payment dividends that may represent special dividends or capital returns.

    A payment exceeding THRESHOLD_PCT (5%) of the current price in a single ex-date within the
    last 90 days is flagged — regular quarterly/semi-annual dividends are typically 0.5–2.5%
    per payment, so a 5%+ single payment is a strong signal of a capital return or special div.

    Query param: tickers (comma-separated, e.g. CBA.AX,BHP.AX)
    Returns: {TICKER: [{date, amount, amount_pct, label}]} — empty list when nothing flagged.
    """
    import yfinance as yf
    from datetime import timedelta

    THRESHOLD_PCT = 5.0  # % of current price — below this it's likely a normal dividend

    raw = request.args.get("tickers", "")
    tickers = [t.strip().upper() for t in raw.split(",") if t.strip()]
    if not tickers:
        return jsonify({"error": "tickers required"}), 400

    cutoff = datetime.utcnow() - timedelta(days=90)
    result = {}
    for ticker in tickers[:50]:
        try:
            sym = ticker if ticker.endswith(".AX") else ticker + ".AX"
            stk = yf.Ticker(sym)
            divs = stk.dividends
            if divs is None or divs.empty:
                result[ticker] = []
                continue

            # Current price for % calculation — use last close from 2-day history
            try:
                hist = stk.history(period="2d")
                current_price = float(hist["Close"].iloc[-1]) if not hist.empty else None
            except Exception:
                current_price = None

            flagged = []
            for idx, amount in divs.items():
                ts = idx.to_pydatetime().replace(tzinfo=None)
                if ts < cutoff:
                    continue
                amt = float(amount)
                if amt <= 0:
                    continue
                pct = (amt / current_price * 100) if current_price else None
                if pct is not None and pct >= THRESHOLD_PCT:
                    flagged.append({
                        "date":       str(idx.date()),
                        "amount":     round(amt, 4),
                        "amount_pct": round(pct, 2),
                        "label":      "special dividend / capital return",
                    })
            result[ticker] = flagged
        except Exception:
            result[ticker] = []
    return jsonify(result)
