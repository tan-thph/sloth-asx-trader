"""
routes/claude.py — Claude API proxy (opt-in).

When the frontend sets `state.settings.useBackendProxy = true`, calls go to
/api/claude/proxy here instead of api.anthropic.com directly. The key lives
in SQLite, never in localStorage.
"""

import json

import requests
from flask import Blueprint, jsonify, request

from core import _HTTP_SESSION, log
from db import get_db


bp = Blueprint("claude", __name__)


@bp.route("/api/claude/settings", methods=["GET", "POST"])
def claude_proxy_settings():
    """GET → {has_key: bool}. POST {api_key: '...'} → stores key in settings table."""
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        key  = (data.get("api_key") or "").strip()
        if not key:
            with get_db() as conn:
                conn.execute("DELETE FROM settings WHERE key='claude_api_key'")
            return jsonify({"ok": True, "cleared": True})
        if not (key.startswith("sk-ant-") and len(key) > 20):
            return jsonify({"ok": False, "error": "Key format looks wrong"}), 400
        with get_db() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) "
                "VALUES (?, ?, datetime('now','localtime'))",
                ("claude_api_key", json.dumps(key))
            )
        return jsonify({"ok": True})
    # GET
    with get_db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key='claude_api_key'").fetchone()
    return jsonify({"has_key": row is not None})


@bp.route("/api/claude/proxy", methods=["POST"])
def claude_proxy():
    """Forward a Claude API request using the server-stored key.

    Body is forwarded verbatim to https://api.anthropic.com/v1/messages.
    Status and JSON body are passed through. The key is read from the
    settings table — no client-supplied key is honored on this endpoint.
    """
    with get_db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key='claude_api_key'").fetchone()
    if not row:
        return jsonify({"error": {"type": "no_proxy_key",
                                  "message": "Backend proxy has no API key. POST one to /api/claude/settings or use direct-browser mode."}}), 400
    api_key = json.loads(row["value"])

    payload = request.get_json(silent=True)
    if not payload:
        return jsonify({"error": {"type": "invalid_request", "message": "JSON body required"}}), 400

    fwd_headers = {
        "Content-Type":      "application/json",
        "x-api-key":         api_key,
        "anthropic-version": request.headers.get("anthropic-version", "2023-06-01"),
    }
    if request.headers.get("anthropic-beta"):
        fwd_headers["anthropic-beta"] = request.headers["anthropic-beta"]

    try:
        upstream = _HTTP_SESSION.post(
            "https://api.anthropic.com/v1/messages",
            json=payload, headers=fwd_headers, timeout=120,
        )
    except requests.RequestException as e:
        log.warning("Claude proxy upstream failed: %s", e)
        return jsonify({"error": {"type": "upstream_error", "message": str(e)}}), 502

    try:
        return jsonify(upstream.json()), upstream.status_code
    except ValueError:
        return upstream.text, upstream.status_code
