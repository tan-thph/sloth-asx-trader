"""
notifications_db.py — Standalone SQLite store for the notification centre.

Kept separate from asx_trader.db so the notification history can be
cleared, backed up, or inspected independently of trading data.

Database file: notifications.db (same directory as asx_server.py)
"""

import contextlib
import os
import sqlite3

NOTIF_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "notifications.db")

_SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS notifications (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT    NOT NULL DEFAULT 'info',
    title     TEXT    NOT NULL DEFAULT '',
    body      TEXT    NOT NULL DEFAULT '',
    category  TEXT    NOT NULL DEFAULT 'system',
    timestamp TEXT    NOT NULL,
    read      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notif_ts ON notifications(timestamp DESC);
"""


@contextlib.contextmanager
def get_notif_db():
    """Context-manager that yields a WAL-mode sqlite3 connection to notifications.db."""
    conn = sqlite3.connect(NOTIF_DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_notif_db():
    """Create schema if not present. Safe to call on every startup."""
    with get_notif_db() as conn:
        conn.executescript(_SCHEMA)
