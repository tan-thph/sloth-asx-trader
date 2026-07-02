"""
routes/auth.py — optional shared-password gate for internet-facing access
(e.g. Tailscale Funnel).

The app has no login by default — that's fine when it's only reachable on
your LAN/tailnet. If you expose it publicly (Tailscale Funnel, port
forwarding, etc.), set a password here first: a global `before_request`
hook in asx_server.py checks every request against it via HTTP Basic Auth.

The password is read from a local file (webapp-auth.txt, at the repo root),
same pattern as claude-api.txt (routes/claude.py) — git-ignored, file-based
so it survives DB resets, never uploaded. No file / empty file = auth
disabled (default local trust model, unchanged).
"""

import hmac
import os

from flask import Blueprint, jsonify, request


bp = Blueprint("auth", __name__)

WEBAPP_AUTH_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "webapp-auth.txt"
)


def _read_password_file():
    try:
        with open(WEBAPP_AUTH_FILE, "r", encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def _write_password_file(password):
    with open(WEBAPP_AUTH_FILE, "w", encoding="utf-8") as f:
        f.write(password)


def _clear_password_file():
    try:
        os.remove(WEBAPP_AUTH_FILE)
    except OSError:
        pass


def resolve_webapp_password():
    """None means the auth gate is disabled (no password configured)."""
    return _read_password_file()


def check_basic_auth(auth, stored_password):
    """Username is not checked — this is a single shared-secret gate."""
    if not auth or not stored_password:
        return False
    return hmac.compare_digest(auth.password or "", stored_password)


@bp.route("/api/auth/status", methods=["GET"])
def auth_status():
    return jsonify({"enabled": resolve_webapp_password() is not None})


@bp.route("/api/auth/password", methods=["POST"])
def set_password():
    """POST {password: '...'} to set/change, {password: ''} to clear.

    Reaching this endpoint at all already means the caller passed the
    before_request gate (or no password was set yet), so no separate
    old-password check is needed here.
    """
    data = request.get_json(silent=True) or {}
    password = (data.get("password") or "").strip()
    if not password:
        _clear_password_file()
        return jsonify({"ok": True, "cleared": True})
    if len(password) < 8:
        return jsonify({"ok": False, "error": "Use at least 8 characters"}), 400
    _write_password_file(password)
    return jsonify({"ok": True})
