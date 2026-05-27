"""
db.py — SQLite connection, schema, migrations.

Extracted from asx_server.py so route modules can import a single source of
truth without dragging in Flask.

Use:
    from db import get_db, init_db, log_failed_ticker
    init_db()
    with get_db() as conn:
        conn.execute(...)
"""

import glob
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "asx_trader.db"


def get_db():
    """Return a tuned SQLite connection. WAL + 256 MB mmap + 64 MB cache."""
    # check_same_thread=False because Flask background threads (market scan,
    # news scheduler) need access. Connections are still short-lived.
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA mmap_size=268435456")
    conn.execute("PRAGMA cache_size=-65536")
    conn.execute("PRAGMA temp_store=MEMORY")
    return conn


_SCHEMA = """
    CREATE TABLE IF NOT EXISTS portfolio (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker        TEXT NOT NULL UNIQUE,
        shares        REAL NOT NULL,
        avg_price     REAL NOT NULL,
        current_price REAL NOT NULL,
        sector        TEXT DEFAULT 'Other',
        updated_at    TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS trade_journal (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        date         TEXT NOT NULL,
        timestamp    TEXT,
        ticker       TEXT NOT NULL,
        action       TEXT NOT NULL,
        qty          REAL NOT NULL,
        entry_price  REAL NOT NULL,
        exit_price   REAL,
        fees         REAL DEFAULT 10,
        pnl          REAL,
        status       TEXT DEFAULT 'open',
        rec_id       TEXT,
        rec_executed INTEGER DEFAULT 0,
        close_date   TEXT,
        created_at   TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS rec_history (
        id              TEXT PRIMARY KEY,
        date            TEXT NOT NULL,
        ticker          TEXT NOT NULL,
        action          TEXT NOT NULL,
        confidence      REAL,
        price_range_low  REAL,
        price_range_high REAL,
        target          REAL,
        stop_loss       REAL,
        expected_profit REAL,
        net_profit      REAL,
        executed        INTEGER DEFAULT 0,
        executed_at     TEXT,
        outcome         TEXT,
        actual_profit   REAL,
        reasoning       TEXT,
        risks           TEXT,
        signals         TEXT,
        learning_id     INTEGER,
        created_at      TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS cash (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        amount     REAL NOT NULL DEFAULT 15000,
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    INSERT OR IGNORE INTO cash (id, amount) VALUES (1, 15000);

    CREATE TABLE IF NOT EXISTS blob_store (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS dividend_cache (
        ticker     TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        source     TEXT DEFAULT 'asx',
        fetched_at TEXT DEFAULT (datetime('now','localtime')),
        expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ticker_metadata (
        ticker     TEXT PRIMARY KEY,
        sector     TEXT,
        industry   TEXT,
        short_name TEXT,
        fetched_at TEXT DEFAULT (datetime('now','localtime')),
        expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS failed_tickers (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT DEFAULT (datetime('now','localtime')),
        ticker    TEXT,
        error     TEXT,
        context   TEXT DEFAULT 'scan'
    );

    CREATE TABLE IF NOT EXISTS ai_learning_events (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        event_type          TEXT NOT NULL DEFAULT 'recommendation',
        ticker              TEXT,
        regime              TEXT,
        prompt_version      TEXT,
        agent_type          TEXT,
        ai_confidence       REAL,
        ensemble_confidence REAL,
        recommendation      TEXT,
        rationale_summary   TEXT,
        suggested_stop      REAL,
        suggested_target    REAL,
        rr_ratio            REAL,
        outcome_status      TEXT,
        realized_pnl_pct    REAL,
        realized_pnl_aud    REAL,
        holding_period_days INTEGER,
        exit_reason         TEXT,
        was_executed        INTEGER DEFAULT 0,
        actual_entry_price  REAL,
        actual_exit_price   REAL,
        sector              TEXT,
        follow_through_days INTEGER,
        market_context      TEXT,
        error_type          TEXT,
        notes               TEXT
    );

    CREATE TABLE IF NOT EXISTS prompt_versions (
        version            TEXT PRIMARY KEY,
        created_at         TEXT,
        description        TEXT,
        total_calls        INTEGER DEFAULT 0,
        win_rate           REAL DEFAULT 0,
        high_conf_win_rate REAL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_learning_ticker     ON ai_learning_events(ticker);
    CREATE INDEX IF NOT EXISTS idx_learning_ts         ON ai_learning_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_regime     ON ai_learning_events(regime);
    CREATE INDEX IF NOT EXISTS idx_learning_pv         ON ai_learning_events(prompt_version);
    CREATE INDEX IF NOT EXISTS idx_learning_conf       ON ai_learning_events(ai_confidence);
    CREATE INDEX IF NOT EXISTS idx_failed_ts           ON failed_tickers(timestamp DESC);

    CREATE TABLE IF NOT EXISTS ai_call_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        agent_type    TEXT,
        model         TEXT,
        system_prompt TEXT,
        user_message  TEXT,
        response_text TEXT,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        cache_read    INTEGER DEFAULT 0,
        cache_written INTEGER DEFAULT 0,
        duration_ms   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_call_log_ts ON ai_call_log(timestamp DESC);
"""


# Columns added to ai_learning_events across releases. ALTER TABLE is idempotent
# via the column-presence check below.
_LE_MIGRATIONS = [
    ("actual_entry_price",   "REAL"),
    ("actual_exit_price",    "REAL"),
    ("sector",               "TEXT"),
    ("follow_through_days",  "INTEGER"),
    ("market_context",       "TEXT"),
    ("error_type",           "TEXT"),
    ("notes",                "TEXT"),
    # v3 additions
    ("skill_score",          "REAL"),
    ("debate_summary",       "TEXT"),
    ("prompt_hash",          "TEXT"),
    ("error_type_source",    "TEXT"),
    ("postmortem_debate",    "TEXT"),
    # v4: per-rec signal snapshot at log time for postmortem quality analysis
    ("entry_signals_json",      "TEXT"),
    # v5: synthesizer prediction from bull/bear debate ('bull'/'bear'/'neutral')
    ("debate_synthesis_winner", "TEXT"),
    # sprint-3C: trade tags (comma-separated) and thesis for Learning Loop context
    ("tags",         "TEXT"),
    ("trade_thesis", "TEXT"),
]


def init_db():
    """Create tables on first run, then apply column-add migrations."""
    with get_db() as conn:
        conn.executescript(_SCHEMA)

        # rec_history: learning_id column added later
        rh_cols = {r[1] for r in conn.execute("PRAGMA table_info(rec_history)").fetchall()}
        if "learning_id" not in rh_cols:
            conn.execute("ALTER TABLE rec_history ADD COLUMN learning_id INTEGER")

        # ai_learning_events: add new columns
        le_cols = {r[1] for r in conn.execute("PRAGMA table_info(ai_learning_events)").fetchall()}
        for col, defn in _LE_MIGRATIONS:
            if col not in le_cols:
                conn.execute(f"ALTER TABLE ai_learning_events ADD COLUMN {col} {defn}")

        # trade_journal: close_date column
        tj_cols = {r[1] for r in conn.execute("PRAGMA table_info(trade_journal)").fetchall()}
        if "close_date" not in tj_cols:
            conn.execute("ALTER TABLE trade_journal ADD COLUMN close_date TEXT")


def backup_db(keep: int = 7) -> str | None:
    """Copy DB to a dated backup file; prune oldest if > keep copies exist.

    Returns the backup path on success, None if the DB doesn't exist yet.
    Safe to call while the server is running (WAL mode allows concurrent reads).
    """
    if not DB_PATH.exists():
        return None
    ts = datetime.now().strftime("%Y%m%d")
    dst = DB_PATH.parent / f"{DB_PATH.name}.bak-{ts}"
    if not dst.exists():
        shutil.copy2(DB_PATH, dst)
    # prune oldest dated backups, keep the most recent `keep` copies
    pattern = str(DB_PATH.parent / f"{DB_PATH.name}.bak-2*")
    backups = sorted(glob.glob(pattern))
    for old in backups[:-keep]:
        try:
            Path(old).unlink()
        except OSError:
            pass
    return str(dst)


def log_failed_ticker(ticker: str, error: str, context: str = 'scan') -> None:
    """Persist a failed yfinance fetch to failed_tickers table (best-effort)."""
    try:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO failed_tickers (ticker, error, context) VALUES (?, ?, ?)",
                (ticker, str(error)[:500], context)
            )
    except Exception:
        pass
