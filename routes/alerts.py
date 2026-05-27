"""
routes/alerts.py — Off-device alert delivery (Telegram).

Endpoints:
  POST /api/alerts/telegram   — send a message via Telegram bot API
  GET  /api/alerts/config     — check whether Telegram credentials are stored
"""

from flask import Blueprint, jsonify, request

from core import _HTTP_SESSION, log
from db import get_db

bp = Blueprint("alerts", __name__)

_TG_API = "https://api.telegram.org/bot{token}/sendMessage"


def _get_tg_creds(conn):
    """Return (token, chat_id) from the settings table, or (None, None)."""
    rows = conn.execute(
        "SELECT key, value FROM settings WHERE key IN ('tg_token','tg_chat_id')"
    ).fetchall()
    cfg = {r["key"]: r["value"] for r in rows}
    return cfg.get("tg_token"), cfg.get("tg_chat_id")


@bp.route("/api/alerts/config")
def alerts_config():
    """Return whether Telegram credentials are configured."""
    try:
        with get_db() as conn:
            token, chat_id = _get_tg_creds(conn)
        return jsonify({"has_telegram": bool(token and chat_id)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/alerts/telegram", methods=["POST"])
def alerts_telegram():
    """Send a Telegram message.

    Body (JSON):
        { "message": "text", "token": "...", "chat_id": "..." }   # explicit creds
        OR
        { "message": "text" }   # use stored creds from settings table

    Returns: { "ok": true } or { "ok": false, "error": "..." }
    """
    data = request.get_json() or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"ok": False, "error": "message is required"}), 400

    # Prefer explicit creds from the request body (used by the Test button)
    token   = (data.get("token") or "").strip() or None
    chat_id = (data.get("chat_id") or "").strip() or None

    if not (token and chat_id):
        try:
            with get_db() as conn:
                token, chat_id = _get_tg_creds(conn)
        except Exception as e:
            return jsonify({"ok": False, "error": f"DB error: {e}"}), 500

    if not token:
        return jsonify({"ok": False, "error": "Telegram bot token not configured"}), 400
    if not chat_id:
        return jsonify({"ok": False, "error": "Telegram chat ID not configured"}), 400

    try:
        resp = _HTTP_SESSION.post(
            _TG_API.format(token=token),
            json={"chat_id": chat_id, "text": message, "parse_mode": "HTML"},
            timeout=10,
        )
        if resp.status_code == 200:
            log.info("Telegram alert sent: %s", message[:80])
            return jsonify({"ok": True})
        err = resp.json().get("description", f"HTTP {resp.status_code}")
        log.warning("Telegram send failed: %s", err)
        return jsonify({"ok": False, "error": err}), 502
    except Exception as e:
        log.error("Telegram send exception: %s", e)
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/alerts/telegram/save", methods=["POST"])
def alerts_telegram_save():
    """Persist Telegram credentials to the settings table.

    Body: { "token": "...", "chat_id": "..." }
    Pass empty strings to clear.
    """
    data = request.get_json() or {}
    token   = (data.get("token")   or "").strip()
    chat_id = (data.get("chat_id") or "").strip()
    try:
        with get_db() as conn:
            for key, val in [("tg_token", token), ("tg_chat_id", chat_id)]:
                if val:
                    conn.execute(
                        "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
                        (key, val),
                    )
                else:
                    conn.execute("DELETE FROM settings WHERE key=?", (key,))
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
