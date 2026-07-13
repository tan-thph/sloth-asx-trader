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
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
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
        ticker        TEXT NOT NULL,
        shares        REAL NOT NULL,
        avg_price     REAL NOT NULL,
        current_price REAL NOT NULL,
        sector        TEXT DEFAULT 'Other',
        account       TEXT NOT NULL DEFAULT 'personal',
        mode          TEXT NOT NULL DEFAULT 'paper',
        updated_at    TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(ticker, account, mode)
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

    CREATE TABLE IF NOT EXISTS trading_lessons (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        learning_event_id INTEGER,
        ticker            TEXT,
        sector            TEXT,
        regime            TEXT,
        setup_type        TEXT,
        lesson_text       TEXT NOT NULL,
        source            TEXT DEFAULT 'manual',
        created_at        TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (learning_event_id) REFERENCES ai_learning_events(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_ticker  ON trading_lessons(ticker);
    CREATE INDEX IF NOT EXISTS idx_lessons_sector  ON trading_lessons(sector);
    CREATE INDEX IF NOT EXISTS idx_lessons_regime  ON trading_lessons(regime);

    CREATE TABLE IF NOT EXISTS tag_reviews (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id      INTEGER NOT NULL UNIQUE REFERENCES ai_learning_events(id) ON DELETE CASCADE,
        reviewed_at   TEXT DEFAULT (datetime('now','localtime')),
        verdict       TEXT NOT NULL,        -- 'agree' | 'disagree'
        corrected_tag TEXT,                 -- NULL when agree; user-corrected tag when disagree
        original_tag  TEXT                  -- snapshot of error_type at review time
    );
    CREATE INDEX IF NOT EXISTS idx_tag_reviews_event ON tag_reviews(event_id);

    -- Learning Loop improvement E: one row per calendar day, written lazily by
    -- GET /api/learning/calibration-stats (not a scheduler thread) so calibration
    -- quality (Brier score) can be plotted over time instead of only ever showing
    -- the latest snapshot. UNIQUE(snapshot_date) makes the write idempotent —
    -- multiple calls on the same day update, never duplicate.
    CREATE TABLE IF NOT EXISTS calibration_snapshots (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_date TEXT NOT NULL UNIQUE,
        brier_score   REAL,
        n             INTEGER,
        prompt_version TEXT
    );

    CREATE TABLE IF NOT EXISTS macro_snapshots (
        snapshot_date         TEXT PRIMARY KEY,
        asx200_chg            REAL,
        aud_usd_chg           REAL,
        gold_chg              REAL,
        oil_chg               REAL,
        iron_ore_chg          REAL,
        spi200_futures_chg    REAL,
        asx_vol_20d           REAL,
        advance_decline_ratio REAL,
        vix_level             REAL,
        sp500_chg             REAL,
        copper_chg            REAL,
        us10y_level           REAL,
        created_at            TEXT DEFAULT (datetime('now','localtime'))
    );

    -- Audit F4 (critics.md #4): thesis-evolution snapshots. For each open
    -- BUY/TOP_UP holding, a lightweight periodic capture (~30/60/90-day marks) of
    -- computeThesisDrift()'s {verdict, reason, deltas} vs entry. Pure data accrual —
    -- no stats/nudges yet — so exit-timing analysis (when does thesis deterioration
    -- begin?) becomes possible once the corpus grows. Cannot be backfilled, hence
    -- built now. One row per (learning_id, milestone_day).
    CREATE TABLE IF NOT EXISTS thesis_snapshots (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        learning_id   INTEGER NOT NULL,
        ticker        TEXT NOT NULL,
        milestone_day INTEGER NOT NULL,     -- 30 | 60 | 90 (nominal age bucket)
        days_held     INTEGER,              -- actual holding age at capture
        verdict       TEXT,                 -- validated | partially_validated | invalidated | reversed | irrelevant
        reason        TEXT,                 -- compact "RSI 42→68" style delta string
        deltas_json   TEXT,                 -- full {field: [entry, now]} payload
        captured_at   TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(learning_id, milestone_day)
    );
    CREATE INDEX IF NOT EXISTS idx_thesis_snap_lid ON thesis_snapshots(learning_id);
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
    ("tags",               "TEXT"),
    ("trade_thesis",       "TEXT"),
    # Sprint 15: Learning Loop Intelligence
    ("success_tags",       "TEXT"),   # comma-sep win tags: catalyst_capture,regime_aligned,confluence_entry,disciplined_hold
    ("checklist_bypasses", "TEXT"),   # comma-sep pre-trade checklist items bypassed at execution
    # Sprint 29: Structured SELL/TRIM decision tagging (set by Claude at generation time)
    ("sell_primary_driver",    "TEXT"),  # exactly one: thesis_broken|target_reached|stop_triggered|...
    ("sell_secondary_factors", "TEXT"),  # 0-3 comma-sep: earnings_approaching|sector_rotation|...
    ("sell_urgency",           "TEXT"),  # immediate|routine|monitor
    # Sprint 36: Virtual outcomes for skipped/unexecuted recs (Fix #18)
    # Lazy-resolved in _calib_compute() by scanning OHLC for target/stop hits.
    # virtual_win | virtual_loss | virtual_open (neither hit yet) | NULL (unresolved)
    ("virtual_outcome",        "TEXT"),  # virtual_win|virtual_loss|virtual_open|NULL
    ("virtual_pnl_pct",        "REAL"),  # reserved — NULL until entry price is known
    # Sprint 37: Sell tag outcome tracking (Gap 3 + Gap 7)
    # Lazy-resolved in _calib_compute() ~25 days after the sell event.
    ("alternative_ticker",   "TEXT"),  # for better_opportunity cross-check (set at generation time)
    ("sell_verify_date",     "TEXT"),  # date when 30d verify check ran
    ("sell_verify_verdict",  "TEXT"),  # validated|invalidated|inconclusive
    ("sell_verify_sold_chg", "REAL"),  # % price change of sold ticker since sell date
    ("sell_verify_alt_chg",  "REAL"),  # % price change of alternative ticker since sell date
    # Sprint 44: speed weight = min(1.0, 7 / bars_to_resolution)
    # Fast hits (≤7 bars) → 1.0; slow drift (30 bars) → ~0.23. High weight = high conviction.
    ("virtual_speed_weight", "REAL"),  # 1.0 = fast hit (≤7 bars); ~0.23 = slow drift (30 bars)
    # Sprint 63: execution-alpha tracker — the MECHANICAL exit (stop/target/15-bar
    # time-stop) simulated for executed closed BUY/TOP_UP trades, lazily resolved by
    # _resolve_execution_alpha(). Compared against realized_pnl_pct to measure
    # whether manual exit decisions add value over the rules.
    ("exec_mech_pnl_pct", "REAL"),  # simulated mechanical exit P&L %
    ("exec_mech_exit",    "TEXT"),  # 'stop' | 'target' | 'time'
    # §9.2 (Sprint 66): one-way slippage rate applied when resolving the virtual
    # outcome — ADV tier (core.adv_slippage) × regime multiplier. Audit field.
    ("virtual_slippage_applied", "REAL"),
    # Sprint 67 (Thesis Tracking Phase 1): structured entry driver set by Claude at
    # BUY/TOP_UP generation time — one of: mean_reversion | momentum_breakout |
    # trend_pullback | fundamental_value | macro_tailwind. Enables the entry-driver ×
    # exit-verdict thesis-accuracy matrix. entry_signals_json (the technical snapshot)
    # and trade_thesis (free-text thesis) already exist and are reused as-is.
    ("primary_entry_driver", "TEXT"),
    # Sprint 68 (Thesis Tracking Phase 2/3): exit verdict — did the original entry
    # driver play out? validated | invalidated | irrelevant. Computed client-side by
    # computeThesisDrift() at SELL/TRIM time, patched onto the parent BUY/TOP_UP event
    # at position close. Joined with primary_entry_driver for the thesis-accuracy matrix.
    ("thesis_verdict", "TEXT"),
    # Sprint 71 (Learning Loop Deepening Phase 1B): MAE/MFE path capture for executed,
    # closed BUY/TOP_UP trades. Lazily resolved by _resolve_mae_mfe() in _calib_compute()
    # by scanning entry→exit daily OHLC (stop-first intrabar convention). mae_pct is the
    # worst drawdown (≤0 for longs); mfe_pct is the best unrealised gain (≥0). Used by
    # Phase 2 tag intelligence (empirical stop_too_tight / early_exit) and skill scoring.
    ("mae_pct",             "REAL"),  # max adverse excursion: (min(low)−entry)/entry×100
    ("mfe_pct",             "REAL"),  # max favourable excursion: (max(high)−entry)/entry×100
    ("mae_mfe_resolved_at", "TEXT"),  # ISO timestamp when MAE/MFE were computed (idempotency)
    # Sprint 71 Phase 2D: stop_too_tight counterfactual result. 1 = a wider (regime
    # stopAtrMult × ATR) stop would have let the trade reach target; 0 = it would have
    # stopped out anyway (tag was a false positive — entry/thesis was the real problem).
    # NULL = not yet resolved / inconclusive. Feeds the tag-precision self-suppression
    # gate in _calib_compute() (⚠STOP_TAG_UNRELIABLE).
    ("stop_cf_saved",       "INTEGER"),
    # Exit-signals capture: mirrors entry_signals_json but snapshotted at SELL/TRIM
    # fill time (markExecuted() in recommendations.js), not at rec generation time.
    # Same shape (rsi_14, bb_pct_b, adx_14, atr_pct, return_5d, return_20d,
    # setup_score, macd_hist, sector_rs_5d, price). Propagated onto the parent
    # BUY/TOP_UP event when a SELL fully closes a position (alongside thesis_verdict)
    # so a closed trade's learning event carries both sides of the trade.
    ("exit_signals_json",   "TEXT"),
    # Deterministic exit-timing classification computed from exit_signals_json by
    # classify_exit_quality_deterministic() — exit_into_strength | exit_after_
    # reversal_confirmed | exit_into_weakness | exit_neutral | NULL (no data).
    # Lazily resolved by _resolve_exit_quality_tags() inside _calib_compute().
    ("exit_quality_tag",    "TEXT"),
    # Improvements.md #5: shared failed-fetch sentinel for the lazy OHLC resolvers
    # (_resolve_virtual_outcomes, _resolve_sell_outcomes, _resolve_mae_mfe,
    # _resolve_stop_tag_counterfactual). Each previously did `except: continue` on
    # a yfinance fetch failure with NO marker written — a delisted/suspended/
    # renamed ticker permanently occupied a slot in the capped batch on every
    # calibration cache-miss, forever, starving the rest of the backlog. ISO
    # timestamp of the last failed fetch attempt; each resolver's WHERE clause
    # excludes rows with a recent failure (retry window, not a permanent block).
    ("fetch_failed_at",     "TEXT"),
    # Regime captured at execution time (markExecuted()), distinct from the
    # write-once `regime` column above (which is stamped at generation time and
    # never updated). A rec sitting "pending" for days could be executed under a
    # different regime than the one it was generated in — this column lets
    # calibration/analysis tell the two apart instead of only ever seeing the
    # generation-time snapshot. Patchable via /api/learning/outcome.
    ("regime_at_execution", "TEXT"),
    # Reasoning-text exemplars: Claude's own bullCase/bearCase steelman text
    # (already required by the prompt schema, js/prompts.js) at rec generation
    # time. Distinct from trade_thesis (free-text rationale) — these are the
    # specific opposing-view arguments used by _compute_exemplars() to show
    # Claude its own past words next to the actual outcome, not just a numeric
    # entry signature. Sent from logRecsToLearningLoop() (js/analysis.js).
    ("bull_case", "TEXT"),
    ("bear_case", "TEXT"),
    # Local-LLM scrutiny: a 24B Ollama model's independent critique of this rec,
    # manually triggered from the rec card (routes/debate.py POST /api/debate/scrutinize).
    # JSON: {verdict: agree|disagree|uncertain, concerns, confidence_adj, model,
    # elapsed_ms, scrutinized_at}. Patchable via /api/learning/outcome. Aggregated by
    # _compute_scrutiny_stats() (routes/learning.py) for the AI Lesson Generator feed.
    ("local_scrutiny_json", "TEXT"),
    # Paper/real firewall: 'real' | 'paper'. Set from the lodge-time gatekeeper.
    # Paper events still feed calibration but at a discounted weight (0.5×) in
    # _calib_compute() so real outcomes dominate. NULL treated as paper by the
    # isRealTrade() invariant. Backfilled to 'paper' once for pre-feature rows.
    ("trade_mode", "TEXT"),
    # Calibration efficacy scoreboard: the POST-nudge confidence actually shown/used
    # for sizing, after the deterministic calibration adjustments (analysis.js §8.3)
    # were applied. `ai_confidence` deliberately stores the ORIGINAL (pre-nudge) value
    # so calibration stats never compound on already-adjusted numbers; this column
    # stores the adjusted value alongside it. With both persisted, the Brier
    # orig-vs-adjusted comparison (GET /api/learning/calibration-efficacy) can measure
    # whether the calibration layer actually improves prediction, rather than just
    # assuming it does. NULL when no nudge was applied (adjusted == original).
    ("calibrated_confidence", "REAL"),
    # Failed-quant-rule capture: the deterministic rule warnings that fired on this
    # rec at generation time (js/analysis.js logRecsToLearningLoop). JSON array of
    # {code, detail, severity} — code is a stable enum (quant_declined | neg_ev |
    # confidence_floor | whipsaw | self_contradiction | heat_budget | validator_fail |
    # fallback_sized). NULL/[] when the rec was clean. Fed into the scrutinize prompt
    # (routes/debate.py) so the local critic sees which rules were breached, and
    # aggregated by _resolve_rule_override_efficacy() (routes/learning.py) which
    # cross-tabs breached-AND-executed recs' outcomes vs baseline to judge whether a
    # rule is `too_strict` (breached-and-won) or `validated` (breached-and-lost).
    ("rule_warnings_json", "TEXT"),
]


def init_db():
    """Create tables on first run, then apply column-add migrations."""
    with get_db() as conn:
        conn.executescript(_SCHEMA)

        # portfolio: add `account` column and replace UNIQUE(ticker) with UNIQUE(ticker, account).
        # SQLite cannot drop constraints via ALTER TABLE, so we recreate the table.
        # Existing rows are migrated with account='personal'. Idempotent — only runs when
        # the account column is absent.
        port_cols = {r[1] for r in conn.execute("PRAGMA table_info(portfolio)").fetchall()}
        if "account" not in port_cols:
            conn.executescript("""
                CREATE TABLE portfolio_new (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    ticker        TEXT NOT NULL,
                    shares        REAL NOT NULL,
                    avg_price     REAL NOT NULL,
                    current_price REAL NOT NULL,
                    sector        TEXT DEFAULT 'Other',
                    account       TEXT NOT NULL DEFAULT 'personal',
                    updated_at    TEXT DEFAULT (datetime('now','localtime')),
                    UNIQUE(ticker, account)
                );
                INSERT INTO portfolio_new
                    (id, ticker, shares, avg_price, current_price, sector, account, updated_at)
                    SELECT id, ticker, shares, avg_price, current_price,
                           COALESCE(sector,'Other'), 'personal', updated_at
                    FROM portfolio;
                DROP TABLE portfolio;
                ALTER TABLE portfolio_new RENAME TO portfolio;
            """)

        # portfolio: add `mode` column and widen UNIQUE(ticker, account) →
        # UNIQUE(ticker, account, mode) so a ticker can be held real AND paper in
        # the same account as two distinct rows (paper/real firewall, gotcha #88).
        # Without the mode column every save dropped it, silently demoting the real
        # book to paper on reload; without the wider UNIQUE, the second (paper) lot
        # of an already-held ticker raised IntegrityError → the whole db_save 500'd
        # and was swallowed, so nothing persisted at all. Re-read cols (the account
        # migration above may have just recreated the table). Existing rows keep the
        # 'paper' default here — the legacy-real backfill is a separate user-confirmed
        # step (/api/portfolio/backfill-modes), since journal modes were already
        # overwritten to 'paper' and can't be inferred from the data alone.
        port_cols = {r[1] for r in conn.execute("PRAGMA table_info(portfolio)").fetchall()}
        if "mode" not in port_cols:
            conn.executescript("""
                CREATE TABLE portfolio_new (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    ticker        TEXT NOT NULL,
                    shares        REAL NOT NULL,
                    avg_price     REAL NOT NULL,
                    current_price REAL NOT NULL,
                    sector        TEXT DEFAULT 'Other',
                    account       TEXT NOT NULL DEFAULT 'personal',
                    mode          TEXT NOT NULL DEFAULT 'paper',
                    updated_at    TEXT DEFAULT (datetime('now','localtime')),
                    UNIQUE(ticker, account, mode)
                );
                INSERT INTO portfolio_new
                    (id, ticker, shares, avg_price, current_price, sector, account, mode, updated_at)
                    SELECT id, ticker, shares, avg_price, current_price,
                           COALESCE(sector,'Other'), account, 'paper', updated_at
                    FROM portfolio;
                DROP TABLE portfolio;
                ALTER TABLE portfolio_new RENAME TO portfolio;
            """)

        # rec_history: learning_id column added later
        rh_cols = {r[1] for r in conn.execute("PRAGMA table_info(rec_history)").fetchall()}
        if "learning_id" not in rh_cols:
            conn.execute("ALTER TABLE rec_history ADD COLUMN learning_id INTEGER")
        # rec_history: extra_json carries every rich field the explicit columns don't
        # cover (scenarios, bullCase/bearCase, qty, primary_driver, _thesisCheck,
        # invalidationCondition, factorsUsed, traceability snapshots, etc.) — db_save()
        # previously only wrote the ~19 explicit columns, silently dropping everything
        # else on every save/reload round trip even though the in-memory rec had it.
        if "extra_json" not in rh_cols:
            conn.execute("ALTER TABLE rec_history ADD COLUMN extra_json TEXT")

        # ai_learning_events: add new columns
        le_cols = {r[1] for r in conn.execute("PRAGMA table_info(ai_learning_events)").fetchall()}
        for col, defn in _LE_MIGRATIONS:
            if col not in le_cols:
                conn.execute(f"ALTER TABLE ai_learning_events ADD COLUMN {col} {defn}")

        # trade_journal: close_date column
        tj_cols = {r[1] for r in conn.execute("PRAGMA table_info(trade_journal)").fetchall()}
        if "close_date" not in tj_cols:
            conn.execute("ALTER TABLE trade_journal ADD COLUMN close_date TEXT")

        # trade_journal: previously-missing columns. db_save() does a full
        # DELETE+INSERT of trade_journal on every save and the INSERT never
        # listed these — so account/sector/parcelId/disposalIds/notes/thesis/
        # entrySignals/exitSignals were silently dropped on every save↔reload
        # round trip (only the columns below survived). Fixed alongside the
        # id-preservation fix in routes/portfolio.py db_save() (explicit id=?
        # instead of relying on AUTOINCREMENT, which reassigned a new id to
        # every row on every save and broke any _journalId-style reference
        # held elsewhere in state, e.g. state.intraday.openPositions[]._journalId).
        for col, defn in (
            ("account",            "TEXT DEFAULT 'personal'"),
            ("sector",             "TEXT"),
            ("parcel_id",          "INTEGER"),
            ("disposal_ids",       "TEXT"),   # JSON array
            ("notes",              "TEXT"),
            ("thesis",             "TEXT"),
            ("entry_signals_json", "TEXT"),
            ("exit_signals_json",  "TEXT"),
            # Regime live at the moment this transaction was recorded (BUY/SELL/
            # TOP_UP/TRIM/DRP/manual). NULL for historical CSV imports — backdating
            # today's regime onto a trade that happened on an arbitrary past date
            # would be actively wrong, not just incomplete.
            ("regime",             "TEXT"),
            # Originating-parcel label for a SELL/TRIM disposal-slice row, e.g.
            # "P#12" (single clean disposal that fully closed that parcel) or
            # "P#12-1" (a partial disposal — suffix increments per prior
            # partial disposal already recorded against that parcel). NULL on
            # BUY/TOP_UP rows and on disposal rows with no resolvable parcel
            # (pre-app/legacy positions). Set by buildDisposalJournalEntries()
            # in js/portfolio-helpers.js — also doubles as the marker that
            # identifies a disposal-slice row (vs a legacy aggregate SELL row).
            ("parcel",             "TEXT"),
            ("parcel_open_date",   "TEXT"),
            # Paper/real firewall: 'real' | 'paper'. Only 'real' rows carry CGT,
            # real cash, and real-performance treatment (isRealTrade() invariant,
            # js/utils.js). A NULL/missing value is treated as paper by every
            # consumer, so no fake trade can ever leak into tax by omission.
            ("mode",               "TEXT"),
            # Failed-quant-rule override marker (Phase 4): JSON array of the human
            # warning strings that fired on the rec when the user executed it
            # anyway. NULL on clean trades. Purely for the Journal drawer's
            # "executed despite: …" note — the structured learning signal lives on
            # ai_learning_events.rule_warnings_json. Set on BUY/TOP_UP rows by
            # markExecuted() (js/pages/recommendations.js).
            ("rule_warnings_json", "TEXT"),
        ):
            if col not in tj_cols:
                conn.execute(f"ALTER TABLE trade_journal ADD COLUMN {col} {defn}")

        # One-time paper-trading backfill: every trade_journal / learning-event
        # row that predates the paper/real feature is stamped 'paper' (the user
        # confirmed all lodged trades so far were fake; real holdings get
        # re-confirmed via the gatekeeper going forward). Guarded by a blob_store
        # flag so it runs exactly once and never re-touches genuinely-real rows
        # logged after the feature shipped. Idempotent + safe: even without this,
        # the isRealTrade() invariant already treats NULL mode as paper.
        _bf = conn.execute(
            "SELECT value FROM blob_store WHERE key='paper_backfill_done'"
        ).fetchone()
        if not _bf:
            conn.execute("UPDATE trade_journal SET mode='paper' WHERE mode IS NULL")
            conn.execute("UPDATE ai_learning_events SET trade_mode='paper' WHERE trade_mode IS NULL")
            conn.execute(
                "INSERT OR REPLACE INTO blob_store (key, value, updated_at) "
                "VALUES ('paper_backfill_done', '1', datetime('now','localtime'))"
            )
            # Commit the backfill writes NOW: the PRAGMA wal_checkpoint(PASSIVE)
            # a few lines below cannot run while a write transaction is open on
            # this connection (SQLITE_LOCKED). get_db() uses deferred isolation,
            # so these DML statements keep the txn open until an explicit commit.
            conn.commit()

        # trading_lessons: breadth_scope column (Sprint 44)
        # Valid: adl_below_0.3 | adl_above_0.7 | high_vol | low_vol | NULL (always inject)
        tl_cols = {r[1] for r in conn.execute("PRAGMA table_info(trading_lessons)").fetchall()}
        if "breadth_scope" not in tl_cols:
            conn.execute("ALTER TABLE trading_lessons ADD COLUMN breadth_scope TEXT")

        # macro_snapshots: F3 (AUDIT_2026-07-13) — grade the morning macro brief.
        # The table previously only carried objective market data written by
        # /api/macro's lazy INSERT OR IGNORE; the AI brief's own sentiment/bullish
        # call (js/pages/macro.js, POST /api/macro/sentiment) was never persisted
        # anywhere queryable, so nothing could grade it against what actually
        # happened next. These columns are nullable and filled in two passes:
        # sentiment/sentiment_conf/bullish_score/prompt_version at brief-generation
        # time (client POST, upserted by snapshot_date); realized_next_day_chg/
        # direction_correct/graded_at lazily by _resolve_macro_calibration()
        # (routes/learning.py) once the next trading day's ASX200 close exists.
        for col, defn in (
            ("sentiment",              "TEXT"),
            ("sentiment_conf",         "REAL"),
            ("bullish_score",          "REAL"),
            ("prompt_version",         "TEXT"),
            ("realized_next_day_chg",  "REAL"),
            ("direction_correct",      "INTEGER"),
            ("graded_at",              "TEXT"),
        ):
            ms_cols = {r[1] for r in conn.execute("PRAGMA table_info(macro_snapshots)").fetchall()}
            if col not in ms_cols:
                conn.execute(f"ALTER TABLE macro_snapshots ADD COLUMN {col} {defn}")

        # Passive maintenance on every startup:
        # - optimize: updates index statistics so the query planner stays accurate
        #   as rows accumulate in ai_learning_events / ai_call_log (large JSON blobs).
        # - wal_checkpoint(PASSIVE): moves WAL pages back to the main DB file without
        #   blocking any concurrent readers. Prevents the WAL file from growing
        #   unboundedly under heavy write workloads (debate transcripts, call logs).
        conn.execute("PRAGMA optimize")
        conn.execute("PRAGMA wal_checkpoint(PASSIVE)")

        # ── One-time backfill: compute rr_ratio for records where it is NULL
        # but entry/stop/target are all present with correct directional setup.
        # Only fills records where stop is on the correct side of entry so the
        # computed R:R is meaningful (wrong-direction stops stay NULL — R:R would
        # be undefined or negative and would mislead the sanity check).
        #   BUY/TOP_UP: stop below entry, target above entry
        #   SELL/TRIM:  stop above entry, target below entry
        conn.execute("""
            UPDATE ai_learning_events
            SET rr_ratio = ROUND(
                ABS(
                    (CAST(suggested_target    AS REAL) - CAST(actual_entry_price AS REAL)) /
                    (CAST(actual_entry_price  AS REAL) - CAST(suggested_stop     AS REAL))
                ), 2)
            WHERE rr_ratio IS NULL
              AND actual_entry_price IS NOT NULL
              AND suggested_stop     IS NOT NULL
              AND suggested_target   IS NOT NULL
              AND actual_entry_price != suggested_stop
              AND (
                  (recommendation IN ('BUY','TOP_UP')
                   AND suggested_stop   < actual_entry_price
                   AND suggested_target > actual_entry_price)
                  OR
                  (recommendation IN ('SELL','TRIM')
                   AND suggested_stop   > actual_entry_price
                   AND suggested_target < actual_entry_price)
              )
        """)


def quick_integrity_check() -> str:
    """Run PRAGMA quick_check (fast structural sanity check, not a full
    integrity_check) once at startup. Returns 'ok' on success, or a
    semicolon-joined string of the reported problems otherwise.

    This is intentionally non-blocking — callers should log loudly but
    never crash/refuse to start on a non-'ok' result, since a false
    positive (or a check that's merely slow) would itself be an incident.
    """
    try:
        with get_db() as conn:
            rows = conn.execute("PRAGMA quick_check").fetchall()
        if len(rows) == 1 and str(rows[0][0]).strip().lower() == "ok":
            return "ok"
        return "; ".join(str(r[0]) for r in rows)
    except Exception as exc:
        return f"quick_check failed to run: {exc}"


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
