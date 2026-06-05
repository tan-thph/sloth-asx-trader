"""
routes/notifications.py — Notification centre API.

Endpoints:
  POST   /api/notifications            — save one notification
  GET    /api/notifications            — paginated list (limit/offset)
  GET    /api/notifications/unread-count — fast badge count
  POST   /api/notifications/read-all  — mark all as read
  DELETE /api/notifications            — clear all
"""

from datetime import datetime, timezone
from flask import Blueprint, request, jsonify
from notifications_db import get_notif_db

bp = Blueprint("notifications", __name__)

_PAGE_SIZE = 8   # items returned per page


# ── Save ─────────────────────────────────────────────────────────────────────

@bp.route("/api/notifications", methods=["POST"])
def notif_save():
    data = request.get_json(force=True, silent=True) or {}
    ts = data.get("timestamp") or datetime.now(timezone.utc).isoformat()
    with get_notif_db() as conn:
        conn.execute(
            "INSERT INTO notifications (type, title, body, category, timestamp) VALUES (?,?,?,?,?)",
            (
                str(data.get("type", "info"))[:20],
                str(data.get("title", ""))[:200],
                str(data.get("body", ""))[:500],
                str(data.get("category", "system"))[:40],
                ts,
            ),
        )
    return jsonify({"ok": True})


# ── List (paginated) ──────────────────────────────────────────────────────────

@bp.route("/api/notifications", methods=["GET"])
def notif_list():
    try:
        limit  = min(max(int(request.args.get("limit", _PAGE_SIZE)), 1), 100)
        offset = max(int(request.args.get("offset", 0)), 0)
    except ValueError:
        limit, offset = _PAGE_SIZE, 0

    with get_notif_db() as conn:
        # Fetch one extra to know if there are more pages
        rows = conn.execute(
            "SELECT * FROM notifications ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?",
            (limit + 1, offset),
        ).fetchall()

    has_more = len(rows) > limit
    items = [dict(r) for r in rows[:limit]]
    return jsonify({"ok": True, "items": items, "has_more": has_more})


# ── Unread count (fast, for badge) ───────────────────────────────────────────

@bp.route("/api/notifications/unread-count", methods=["GET"])
def notif_unread_count():
    with get_notif_db() as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM notifications WHERE read = 0"
        ).fetchone()[0]
    return jsonify({"ok": True, "count": count})


# ── Mark all read ─────────────────────────────────────────────────────────────

@bp.route("/api/notifications/read-all", methods=["POST"])
def notif_read_all():
    with get_notif_db() as conn:
        conn.execute("UPDATE notifications SET read = 1 WHERE read = 0")
    return jsonify({"ok": True})


# ── Clear all ─────────────────────────────────────────────────────────────────

@bp.route("/api/notifications", methods=["DELETE"])
def notif_clear():
    with get_notif_db() as conn:
        conn.execute("DELETE FROM notifications")
    return jsonify({"ok": True})
