"""
routes/claude.py — Claude API proxy (opt-in).

When the frontend sets `state.settings.useBackendProxy = true`, calls go to
/api/claude/proxy here instead of api.anthropic.com directly.

The key is read from a local file (claude-api.txt, at the repo root) in
preference to the SQLite settings table. The file is git-ignored and lives
only on disk — it survives DB resets/recovery and is never uploaded; delete
it before publishing the app. The settings-table path is kept as a fallback
for installs that saved a key before this file-based path existed.
"""

import json
import os

import requests
from flask import Blueprint, jsonify, request

from core import _HTTP_SESSION, log
from db import get_db


bp = Blueprint("claude", __name__)

CLAUDE_API_KEY_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "claude-api.txt"
)


def _read_key_file():
    try:
        with open(CLAUDE_API_KEY_FILE, "r", encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def _write_key_file(key):
    with open(CLAUDE_API_KEY_FILE, "w", encoding="utf-8") as f:
        f.write(key)


def _clear_key_file():
    try:
        os.remove(CLAUDE_API_KEY_FILE)
    except OSError:
        pass


def _resolve_proxy_key():
    """File takes precedence; falls back to the legacy settings-table key."""
    key = _read_key_file()
    if key:
        return key
    with get_db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key='claude_api_key'").fetchone()
    return json.loads(row["value"]) if row else None


@bp.route("/api/claude/settings", methods=["GET", "POST"])
def claude_proxy_settings():
    """GET → {has_key: bool}. POST {api_key: '...'} → saves key to claude-api.txt."""
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        key  = (data.get("api_key") or "").strip()
        if not key:
            _clear_key_file()
            with get_db() as conn:
                conn.execute("DELETE FROM settings WHERE key='claude_api_key'")
            return jsonify({"ok": True, "cleared": True})
        if not (key.startswith("sk-ant-") and len(key) > 20):
            return jsonify({"ok": False, "error": "Key format looks wrong"}), 400
        _write_key_file(key)
        return jsonify({"ok": True})
    # GET
    return jsonify({"has_key": _resolve_proxy_key() is not None})


@bp.route("/api/claude/proxy", methods=["POST"])
def claude_proxy():
    """Forward a Claude API request using the server-stored key.

    Body is forwarded verbatim to https://api.anthropic.com/v1/messages.
    Status and JSON body are passed through. The key is resolved via
    `_resolve_proxy_key()` (claude-api.txt, then the settings-table
    fallback) — no client-supplied key is honored on this endpoint.
    """
    api_key = _resolve_proxy_key()
    if not api_key:
        return jsonify({"error": {"type": "no_proxy_key",
                                  "message": "Backend proxy has no API key. POST one to /api/claude/settings or use direct-browser mode."}}), 400

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
