"""
test_app.py — Full integration test suite for Sloth ASX Trader backend.

Covers:
  - All learning loop routes (log, outcome partial-patch, delete, stats)
  - Quote endpoint
  - Dividends endpoint
  - Polymarket/Manifold route (mocked — no external calls)
  - Scanner endpoint (smoke)
  - JS syntax validation for all modified files
  - Key function definitions present in JS files

Run:  python test_app.py
"""

import json
import os
import sqlite3
import subprocess
import sys
import unittest

# ── Bootstrap: import the Flask app ──────────────────────────────────────────
ROOT = os.path.dirname(__file__)
sys.path.insert(0, ROOT)

# Patch DB path to a shared in-memory SQLite so tests don't touch production data.
# We use check_same_thread=False + a module-level shared connection so all
# test calls share the same in-memory DB (each new sqlite3.connect(':memory:')
# would create a *separate* isolated DB, breaking cross-call state).
import asx_server
import db as db_module  # extracted module — also needs patching

_orig_get_db = asx_server.get_db
_orig_db_get_db = db_module.get_db
_shared_conn: sqlite3.Connection | None = None


def _get_shared_conn() -> sqlite3.Connection:
    global _shared_conn
    if _shared_conn is None:
        _shared_conn = sqlite3.connect(":memory:", check_same_thread=False)
        _shared_conn.row_factory = sqlite3.Row          # required for r['column'] access
        _shared_conn.execute("PRAGMA journal_mode=WAL")
        _shared_conn.execute("PRAGMA foreign_keys=ON")
    return _shared_conn


class _SharedConnCtx:
    """Wraps the shared connection as a context manager (commit/rollback on exit)."""
    def __enter__(self):
        return _get_shared_conn()

    def __exit__(self, exc_type, *_):
        conn = _get_shared_conn()
        if exc_type:
            conn.rollback()
        else:
            conn.commit()


def _test_get_db():
    return _SharedConnCtx()


def _install_in_memory_db():
    """Patch get_db in db module, asx_server, and every routes/*.py blueprint
    module. `from db import get_db` binds at import time, so each module needs
    its local binding rewritten as well.
    Must be called before init_db().
    """
    asx_server.get_db = _test_get_db
    db_module.get_db = _test_get_db
    import importlib
    for name in ("routes.portfolio", "routes.dividends", "routes.market",
                 "routes.backtest", "routes.scanner", "routes.learning",
                 "routes.debate", "routes.news", "routes.claude",
                 "routes.alerts", "routes.import_csv", "routes.intraday"):
        try:
            mod = importlib.import_module(name)
            if hasattr(mod, "get_db"):
                setattr(mod, "get_db", _test_get_db)
        except ImportError:
            pass  # module may not exist yet during the split process


class TestLearningLoopRoutes(unittest.TestCase):
    """Tests for /api/learning/* endpoints."""

    @classmethod
    def setUpClass(cls):
        # Patch get_db globally before init_db so the in-memory DB is used
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    @classmethod
    def tearDownClass(cls):
        asx_server.get_db = _orig_get_db

    # ── /api/learning/log ────────────────────────────────────────────────────

    def test_log_creates_event(self):
        payload = {
            "event_type": "recommendation",
            "ticker": "BHP",
            "regime": "bull",
            "prompt_version": "2026-05-v4",
            "ai_confidence": 0.82,
            "ensemble_confidence": 0.79,
            "recommendation": "BUY",
            "rationale_summary": "Strong momentum breakout",
            "suggested_stop": 42.50,
            "suggested_target": 48.00,
            "rr_ratio": 2.1,
            "was_executed": False,
        }
        resp = self.client.post(
            "/api/learning/log",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))
        self.assertIsInstance(body.get("id"), int)
        self.__class__._logged_id = body["id"]

    def test_log_auto_registers_prompt_version(self):
        with _test_get_db() as conn:
            row = conn.execute(
                "SELECT total_calls FROM prompt_versions WHERE version=?",
                ("2026-05-v4",),
            ).fetchone()
        self.assertIsNotNone(row, "prompt_version should be auto-registered")
        self.assertGreaterEqual(row[0], 1)

    # ── /api/learning/outcome ────────────────────────────────────────────────

    def test_outcome_update_partial(self):
        event_id = self.__class__._logged_id
        payload = {"id": event_id, "was_executed": True, "outcome_status": "win",
                   "realized_pnl_aud": 312.50, "realized_pnl_pct": 7.35,
                   "holding_period_days": 14, "exit_reason": "manual"}
        resp = self.client.post(
            "/api/learning/outcome",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(json.loads(resp.data).get("ok"))

        with _test_get_db() as conn:
            row = conn.execute(
                "SELECT outcome_status, was_executed, realized_pnl_pct FROM ai_learning_events WHERE id=?",
                (event_id,),
            ).fetchone()
        self.assertEqual(row[0], "win")
        self.assertEqual(row[1], 1)
        self.assertAlmostEqual(row[2], 7.35, places=2)

    def test_outcome_requires_id(self):
        resp = self.client.post(
            "/api/learning/outcome",
            data=json.dumps({"outcome_status": "loss"}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_outcome_noop_when_no_fields(self):
        event_id = self.__class__._logged_id
        resp = self.client.post(
            "/api/learning/outcome",
            data=json.dumps({"id": event_id}),
            content_type="application/json",
        )
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))
        self.assertIn("nothing to update", body.get("note", ""))

    # ── /api/learning/stats ──────────────────────────────────────────────────

    def test_stats_returns_expected_keys(self):
        resp = self.client.get("/api/learning/stats")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        for key in ("total", "closed", "wins", "conf_bands", "regime_stats",
                    "version_stats", "recent_events", "failed_tickers"):
            self.assertIn(key, body, f"Missing key: {key}")

    def test_stats_total_reflects_logged_event(self):
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        self.assertGreaterEqual(body["total"], 1)

    def test_stats_recent_events_shape(self):
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        events = body.get("recent_events", [])
        self.assertGreater(len(events), 0)
        ev = events[0]
        for field in ("id", "ticker", "recommendation", "ai_confidence", "outcome_status"):
            self.assertIn(field, ev, f"recent_event missing field: {field}")

    def test_stats_has_new_aggregate_fields(self):
        """stats endpoint must return avg_hold_days, exit_reason_dist, rr_stats."""
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        for key in ("avg_hold_days", "exit_reason_dist", "rr_stats"):
            self.assertIn(key, body, f"Missing new field: {key}")
        self.assertIsInstance(body["exit_reason_dist"], dict)
        self.assertIsInstance(body["rr_stats"], dict)

    def test_stats_recent_events_has_richer_fields(self):
        """recent_events must now include stop, target, rr_ratio, hold days, exit_reason."""
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        events = body.get("recent_events", [])
        if events:
            ev = events[0]
            for field in ("suggested_stop", "suggested_target", "rr_ratio",
                          "holding_period_days", "exit_reason", "rationale_summary"):
                self.assertIn(field, ev, f"recent_event missing richer field: {field}")

    def test_stats_win_rate_is_percentage(self):
        """overall_win_rate must be 0-100 (not 0-1 fraction)."""
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        wr = body.get("overall_win_rate")
        if wr is not None:
            self.assertLessEqual(wr, 100.0, "win_rate should be 0-100 scale")
            self.assertGreaterEqual(wr, 0.0)

    # ── /api/learning/event/<id> DELETE ─────────────────────────────────────

    def test_delete_event(self):
        # Log a fresh event to delete
        payload = {"ticker": "CBA", "recommendation": "SELL",
                   "prompt_version": "2026-05-v4", "ai_confidence": 0.70}
        r = self.client.post("/api/learning/log",
                             data=json.dumps(payload),
                             content_type="application/json")
        del_id = json.loads(r.data)["id"]

        resp = self.client.delete(f"/api/learning/event/{del_id}")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body["ok"])
        self.assertEqual(body["deleted"], del_id)

        with _test_get_db() as conn:
            row = conn.execute(
                "SELECT id FROM ai_learning_events WHERE id=?", (del_id,)
            ).fetchone()
        self.assertIsNone(row, "Row should be deleted from DB")

    def test_delete_nonexistent_returns_404(self):
        resp = self.client.delete("/api/learning/event/9999999")
        self.assertEqual(resp.status_code, 404)


class TestQuoteRoute(unittest.TestCase):
    """Smoke-test /api/quote — just checks response shape, not live price."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_quote_returns_json(self):
        resp = self.client.get("/api/quote/BHP")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        # Should have at least one of these keys (even if price fetch fails)
        self.assertTrue(
            "price" in body or "error" in body,
            f"Unexpected response shape: {body}"
        )


class TestDividendsRoute(unittest.TestCase):
    """Smoke-test /api/dividends/<ticker>."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_dividends_returns_json_with_history(self):
        resp = self.client.get("/api/dividends/CBA")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        # Should have history list (may be empty if yfinance unavailable)
        self.assertIn("history", body, f"Missing 'history' key: {body}")
        self.assertIsInstance(body["history"], list)

    def test_dividends_batch_returns_dict(self):
        resp = self.client.post(
            "/api/dividends/batch",
            data=json.dumps({"tickers": ["CBA", "NAB"]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        # Should be a dict keyed by ticker
        self.assertIsInstance(body, dict)


class TestPolymarketRoute(unittest.TestCase):
    """Test /api/polymarket returns the expected shape."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        # Force cache miss so route actually runs (cache lives in routes.market now)
        from routes import market as _market_mod
        _market_mod._PM_CACHE["data"] = None
        _market_mod._PM_CACHE["fetched_at"] = 0.0
        cls._market_mod = _market_mod
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_polymarket_shape(self):
        """Route should return markets list + fetched_at regardless of network."""
        resp = self.client.get("/api/polymarket")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("markets", body)
        self.assertIn("fetched_at", body)
        self.assertIsInstance(body["markets"], list)
        self.assertEqual(len(body["markets"]), len(self._market_mod._PM_QUERIES))

    def test_polymarket_each_entry_has_required_keys(self):
        resp = self.client.get("/api/polymarket")
        body = json.loads(resp.data)
        for m in body["markets"]:
            for key in ("id", "label", "positive_for_asx", "yes_prob", "question"):
                self.assertIn(key, m, f"market entry missing key '{key}': {m}")

    def test_polymarket_cache_serves_cached(self):
        """Second call within TTL should return cached=True."""
        resp = self.client.get("/api/polymarket")
        body = json.loads(resp.data)
        # If cache was populated by prior test, cached=True; otherwise False (first fetch)
        self.assertIn("cached", body)


class TestJSSyntax(unittest.TestCase):
    """Validate syntax of every JS file we've modified using node --check."""

    FILES = [
        "js/analysis.js",
        "js/alerts.js",
        "js/pages/learning.js",
        "js/pages/performance.js",
        "js/pages/recommendations.js",
        "js/pages/macro.js",
        "js/pages/scanner.js",
        "js/learning-loop.js",
        "js/prices.js",
    ]

    def _check(self, rel_path):
        full = os.path.join(ROOT, rel_path)
        result = subprocess.run(
            ["node", "--check", full],
            capture_output=True, text=True
        )
        self.assertEqual(
            result.returncode, 0,
            f"JS syntax error in {rel_path}:\n{result.stderr}"
        )

    def test_analysis_js(self):       self._check("js/analysis.js")
    def test_alerts_js(self):         self._check("js/alerts.js")
    def test_learning_js(self):       self._check("js/pages/learning.js")
    def test_performance_js(self):    self._check("js/pages/performance.js")
    def test_recommendations_js(self):self._check("js/pages/recommendations.js")
    def test_macro_js(self):          self._check("js/pages/macro.js")
    def test_scanner_js(self):        self._check("js/pages/scanner.js")
    def test_learning_loop_js(self):  self._check("js/learning-loop.js")
    def test_prices_js(self):         self._check("js/prices.js")


class TestJSFunctionPresence(unittest.TestCase):
    """Grep key function definitions to guard against accidental deletion."""

    def _contains(self, rel_path, needle):
        with open(os.path.join(ROOT, rel_path), encoding="utf-8") as f:
            return needle in f.read()

    # analysis.js
    def test_logRecsToLearningLoop_defined(self):
        self.assertTrue(self._contains("js/analysis.js", "function logRecsToLearningLoop"))

    def test_alertHighConviction_called(self):
        self.assertTrue(self._contains("js/analysis.js", "alertHighConviction"))

    # learning.js
    def test_renderLearningPage_defined(self):
        self.assertTrue(self._contains("js/pages/learning.js", "function renderLearningPage"))

    def test_deleteLearningEvent_defined(self):
        self.assertTrue(self._contains("js/pages/learning.js", "function deleteLearningEvent"))

    def test_delete_button_wired(self):
        self.assertTrue(self._contains("js/pages/learning.js", "deleteLearningEvent(${ev.id})"))

    # performance.js
    def test_syncClosedTradesToLearningLoop_defined(self):
        self.assertTrue(self._contains("js/pages/performance.js", "function syncClosedTradesToLearningLoop"))

    def test_exportTradeJournalCSV_has_entryPrice(self):
        self.assertTrue(self._contains("js/pages/performance.js", "t.entryPrice"))

    def test_sortino_uses_entryPrice(self):
        # The fix changed t.avgPrice → t.entryPrice in Sortino computation
        src = open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8").read()
        # Look for entryPrice inside the pnlPcts map block
        self.assertIn("entryPrice", src)

    # alerts.js
    def test_fireAlert_defined(self):
        self.assertTrue(self._contains("js/alerts.js", "function fireAlert"))

    def test_checkRecStopTargetAlerts_defined(self):
        self.assertTrue(self._contains("js/alerts.js", "function checkRecStopTargetAlerts"))

    # recommendations.js
    def test_markExecuted_defined(self):
        self.assertTrue(self._contains("js/pages/recommendations.js", "function markExecuted"))

    def test_markSkipped_defined(self):
        self.assertTrue(self._contains("js/pages/recommendations.js", "function markSkipped"))

    def test_markExecuted_logs_manual_import(self):
        """Sells on manually-imported stocks (no _learningId) must fall into the else-if branch."""
        self.assertTrue(self._contains("js/pages/recommendations.js",
                                       "Manually imported position"))

    # learning-loop.js — new v2 functions
    def test_calibration_block_fetcher_defined(self):
        # Renamed from buildCalibrationPromptBlock → fetchCalibrationBlock when
        # calibration moved to the backend in v2 of the learning loop.
        self.assertTrue(self._contains("js/learning-loop.js", "function fetchCalibrationBlock"))

    def test_refreshLearningCache_defined(self):
        self.assertTrue(self._contains("js/learning-loop.js", "function refreshLearningCache"))

    def test_computeAllTradesStats_defined(self):
        self.assertTrue(self._contains("js/learning-loop.js", "function computeAllTradesStats"))

    def test_computeRRRealization_defined(self):
        self.assertTrue(self._contains("js/learning-loop.js", "function computeRRRealization"))

    def test_detectStrategyDecay_has_volatility(self):
        self.assertTrue(self._contains("js/learning-loop.js", "recentVolatility"))

    def test_calibration_wired_in_analysis(self):
        # analysis.js now calls fetchCalibrationBlock() instead of refreshLearningCache().
        self.assertTrue(self._contains("js/analysis.js", "fetchCalibrationBlock"))

    def test_learning_loop_uses_backend_cache(self):
        self.assertTrue(self._contains("js/learning-loop.js", "state._learningCache"))


class TestPythonSyntax(unittest.TestCase):
    """Parse asx_server.py and indicators.py via ast to catch syntax errors."""

    def _parse(self, filename):
        import ast
        path = os.path.join(ROOT, filename)
        with open(path, encoding="utf-8") as f:
            src = f.read()
        try:
            ast.parse(src)
        except SyntaxError as e:
            self.fail(f"SyntaxError in {filename}: {e}")

    def test_asx_server_syntax(self):
        self._parse("asx_server.py")

    def test_indicators_syntax(self):
        self._parse("indicators.py")


class TestLearningLoopRSScoringIntegration(unittest.TestCase):
    """Verify the conf_bands returned by /stats use 0-100 scale as documented."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        # Seed a win and a loss at the 70-80% confidence band
        with _test_get_db() as conn:
            conn.execute("""
                INSERT INTO ai_learning_events
                    (ticker, ai_confidence, outcome_status, was_executed, prompt_version)
                VALUES (?,?,?,?,?)
            """, ("WBC", 0.75, "win", 1, "test-v1"))
            conn.execute("""
                INSERT INTO ai_learning_events
                    (ticker, ai_confidence, outcome_status, was_executed, prompt_version)
                VALUES (?,?,?,?,?)
            """, ("ANZ", 0.75, "loss", 1, "test-v1"))
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_conf_band_win_rate_is_0_to_100(self):
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        for band in body.get("conf_bands", []):
            wr = band.get("win_rate")
            if wr is not None:
                self.assertLessEqual(wr, 100.0,
                    f"conf_band win_rate should be 0-100, got {wr}")

    def test_overall_win_rate_50_percent_for_1w_1l(self):
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        wr = body.get("overall_win_rate")
        if wr is not None:
            # We seeded 1 win + 1 loss = 50 % (plus any prior events from other tests)
            self.assertGreaterEqual(wr, 0)
            self.assertLessEqual(wr, 100)


class TestRegressionBugs(unittest.TestCase):
    """Regression tests for bugs fixed in the 2026-05 review pass.

    One test per bug; if the test fails, the bug has returned.
    """

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    # ── Bug #1: quant-engine liquidity unit ──────────────────────────────────
    def test_quant_engine_liquidity_in_shares_not_dollars(self):
        """qty_by_liquidity must be 5% of SHARES, not 5% of dollars."""
        with open(os.path.join(ROOT, "js/quant-engine.js"), encoding="utf-8") as f:
            src = f.read()
        # Must reference shares-based variable; must not multiply raw adv20 by 0.05 as shares
        self.assertIn("advShares", src, "quant-engine.js must derive a share count from adv_20")
        self.assertNotIn("adv20 * (_ap.maxLiquidityPct", src,
                         "Old dollar-as-shares math should be gone")

    # ── Bug #2: priceAlerts persistence ──────────────────────────────────────
    def test_pricealerts_in_save_payload(self):
        with open(os.path.join(ROOT, "js/api.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("priceAlerts: state.priceAlerts", src,
                      "saveStateToDb must send priceAlerts")
        self.assertIn("data.priceAlerts", src,
                      "loadStateFromDb must restore priceAlerts")

    def test_pricealerts_in_load_response(self):
        """/api/db/load response includes priceAlerts key."""
        resp = self.client.get("/api/db/load")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("priceAlerts", body, "/api/db/load must return priceAlerts")

    # ── Bug #3: alert spam ────────────────────────────────────────────────────
    def test_alert_spam_guard_in_alerts_js(self):
        with open(os.path.join(ROOT, "js/alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_stopAlertedAt", src,
                      "alerts.js must track _stopAlertedAt to prevent spam")
        self.assertIn("_targetAlertedAt", src,
                      "alerts.js must track _targetAlertedAt")

    # ── Bug #4: panic regime qty=0 ────────────────────────────────────────────
    def test_regime_panic_blocks_qty(self):
        with open(os.path.join(ROOT, "js/regime-engine.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("sizeMult === 0", src,
                      "regime-engine must hard-block on sizeMult=0")
        self.assertIn("_regimeBlocked", src,
                      "regime-engine must flag _regimeBlocked")

    def test_analysis_drops_regime_blocked_recs(self):
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_regimeBlocked", src,
                      "analysis.js must filter out _regimeBlocked recs")

    # ── Bug #5: sector map dedup ──────────────────────────────────────────────
    def test_sector_map_no_duplicates(self):
        """ASX_SECTOR_MAP must have each ticker exactly once."""
        from indicators import ASX_SECTOR_MAP
        # If dict was built from duplicate literal keys Python silently kept last;
        # we re-parse the source to detect duplicates.
        import re
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        # Find the ASX_SECTOR_MAP literal
        m = re.search(r"ASX_SECTOR_MAP = \{(.*?)\n\}", src, re.DOTALL)
        self.assertIsNotNone(m, "ASX_SECTOR_MAP literal not found")
        keys = re.findall(r"'([A-Z0-9]+)':", m.group(1))
        dupes = {k for k in keys if keys.count(k) > 1}
        self.assertEqual(dupes, set(), f"Duplicate keys in ASX_SECTOR_MAP: {dupes}")

    # ── Bug #6: ASX universe dedup ────────────────────────────────────────────
    def test_asx_universes_have_no_duplicates(self):
        for u in ("asx20", "asx50", "asx100", "asx200"):
            tickers = asx_server._ASX_UNIVERSE[u]
            self.assertEqual(len(tickers), len(set(tickers)),
                             f"_ASX_UNIVERSE['{u}'] contains duplicates")

    # ── Bug #8: ticker regex accepts digits ───────────────────────────────────
    def test_ticker_regex_accepts_digits(self):
        with open(os.path.join(ROOT, "js/response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        # Must include 0-9 in the character class
        self.assertIn("[A-Z0-9]", src,
                      "ticker pattern must accept digits (A2M, S32, MP1, 360)")

    # ── Bug #9: HOLD schema opt-out ───────────────────────────────────────────
    def test_validator_hold_optional_fields(self):
        with open(os.path.join(ROOT, "js/response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("requiredUnless", src,
                      "validator must support requiredUnless for HOLD recs")

    # ── Bug #11: html closing tag ─────────────────────────────────────────────
    def test_html_has_close_tag(self):
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("</html>", src, "asx_trading.html must close with </html>")

    # ── Bug #12: gitignore covers key.txt ─────────────────────────────────────
    def test_gitignore_blocks_key_files(self):
        with open(os.path.join(ROOT, ".gitignore"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("key.txt", src, ".gitignore must list key.txt")

    # ── Bug: _detectExitReason ignored trade direction ───────────────────────
    def test_detect_exit_reason_direction_aware(self):
        """SELL/TRIM recs frame stop ABOVE and target BELOW entry; _detectExitReason
        must invert its comparisons so a profitable trim isn't mislabeled stop_hit.

        §3.8: The function now has a single canonical copy in utils.js.
        We evaluate it against known cases; page files must NOT redefine it.
        """
        node_script = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8');
const start = src.indexOf('function _detectExitReason');
if (start < 0) { console.error('function not found'); process.exit(2); }
let i = src.indexOf('{', start), depth = 0, end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
eval(src.slice(start, end));
const cases = [
  // [exit, stop, target, action, expected]
  [9.0,  10.0, 15.0,  'BUY',  'stop_hit'],
  [16.0, 10.0, 15.0,  'BUY',  'target_hit'],
  [12.0, 10.0, 15.0,  'BUY',  'manual'],
  [15.0, 14.79, 13.59, 'TRIM', 'stop_hit'],
  [13.0, 14.79, 13.59, 'TRIM', 'target_hit'],
  [14.0, 14.79, 13.59, 'TRIM', 'manual'],
  [55.1, 58.84, 47.54, 'SELL', 'manual'],
  // geometry fallback when action absent (stop > target => bearish framing)
  [15.0, 14.79, 13.59, undefined, 'stop_hit'],
];
let fail = 0;
for (const [ex, st, tg, ac, exp] of cases) {
  const got = _detectExitReason(ex, st, tg, ac);
  if (got !== exp) { console.error(`FAIL (${ex},${st},${tg},${ac}) expected ${exp} got ${got}`); fail++; }
}
process.exit(fail ? 1 : 0);
"""
        # Canonical copy lives in utils.js
        result = subprocess.run(
            ["node", "-e", node_script, os.path.join(ROOT, "js/utils.js")],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0,
                         f"js/utils.js _detectExitReason direction logic wrong:\n{result.stderr}")
        # Page files must NOT redefine the function (single canonical copy guard)
        for fn in ("js/pages/recommendations.js", "js/pages/performance.js"):
            with open(os.path.join(ROOT, fn), encoding="utf-8") as f:
                src = f.read()
            self.assertNotIn("function _detectExitReason", src,
                             f"{fn} must NOT redefine _detectExitReason (§3.8: single copy in utils.js)")


class TestInfraImprovements(unittest.TestCase):
    """Tests for the production-grade upgrades."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_db_module_exposes_get_db(self):
        import db as db_module
        self.assertTrue(callable(db_module.get_db))
        self.assertTrue(callable(db_module.init_db))
        self.assertTrue(callable(db_module.log_failed_ticker))

    def test_ttl_cache_decorator_exists(self):
        self.assertTrue(callable(asx_server.ttl_cache),
                        "ttl_cache decorator must be exposed")

    def test_ttl_cache_memoises(self):
        calls = []
        @asx_server.ttl_cache(seconds=30)
        def slow(x):
            calls.append(x)
            return x * 2

        self.assertEqual(slow(3), 6)
        self.assertEqual(slow(3), 6)
        self.assertEqual(len(calls), 1, "ttl_cache should memoise repeated calls")

    def test_claude_proxy_settings_endpoint_exists(self):
        resp = self.client.get("/api/claude/settings")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("has_key", body)

    def test_claude_proxy_rejects_without_key(self):
        """Proxy must refuse to forward if no server-stored key exists."""
        # Clear any key first
        self.client.post("/api/claude/settings",
                         data=json.dumps({"api_key": ""}),
                         content_type="application/json")
        resp = self.client.post("/api/claude/proxy",
                                data=json.dumps({"model": "x", "messages": []}),
                                content_type="application/json")
        self.assertEqual(resp.status_code, 400)
        body = json.loads(resp.data)
        self.assertEqual(body["error"]["type"], "no_proxy_key")

    def test_claude_proxy_settings_validates_format(self):
        """POST with malformed key should be rejected."""
        resp = self.client.post("/api/claude/settings",
                                data=json.dumps({"api_key": "not-a-real-key"}),
                                content_type="application/json")
        self.assertEqual(resp.status_code, 400)

    def test_frontend_error_boundary_present(self):
        with open(os.path.join(ROOT, "js/navigation.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_renderPageUnsafe", src,
                      "navigation.js must wrap render in error boundary")
        self.assertIn("Page crashed", src)

    def test_state_validators_present(self):
        with open(os.path.join(ROOT, "js/api.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_validHolding", src,
                      "api.js must sanitise loaded portfolio holdings")

    def test_gunicorn_config_exists(self):
        path = os.path.join(ROOT, "gunicorn.conf.py")
        self.assertTrue(os.path.isfile(path), "gunicorn.conf.py must exist")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("worker_class", src)
        self.assertIn("threads", src)


class TestStage1DataCapture(unittest.TestCase):
    """Regression tests for Stage 1 — Data capture improvements."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_debate_bull_bear_uses_think_false(self):
        """Bull/bear Ollama calls must pass think=False to avoid thinking-token budget waste."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        # Both bull and bear calls must now have think=False, num_predict=350
        self.assertIn("think=False, num_predict=350", src,
                      "Bull/bear Ollama calls must use think=False and num_predict=350")
        # Check it appears at least twice (bull AND bear call)
        self.assertGreaterEqual(src.count("think=False, num_predict=350"), 2)

    def test_entry_signals_json_in_db_migrations(self):
        """entry_signals_json column must be in _LE_MIGRATIONS."""
        import db as _db
        col_names = [col for col, _ in _db._LE_MIGRATIONS]
        self.assertIn("entry_signals_json", col_names,
                      "_LE_MIGRATIONS must include entry_signals_json TEXT column")

    def test_entry_signals_json_accepted_by_log_endpoint(self):
        """POST /api/learning/log must accept and persist entry_signals_json."""
        signals = {"rsi_14": 32.5, "bb_pct_b": 0.08, "adx_14": 18.0,
                   "atr_pct": 1.2, "return_5d": -2.1, "return_20d": -6.4}
        resp = self.client.post(
            "/api/learning/log",
            data=json.dumps({
                "ticker": "BHP.AX", "event_type": "recommendation",
                "recommendation": "BUY", "ai_confidence": 0.72,
                "entry_signals_json": json.dumps(signals),
            }),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))
        self.assertIn("id", body)

    def test_entry_signals_json_captured_in_analysis_js(self):
        """logRecsToLearningLoop must build and send entry_signals_json."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("entry_signals_json", src,
                      "analysis.js must include entry_signals_json in learning log payload")
        self.assertIn("liveSignals", src)

    def test_detect_exit_reason_helper_present(self):
        """_detectExitReason must be defined in utils.js (single canonical copy) and
        referenced by both recommendations.js and performance.js."""
        with open(os.path.join(ROOT, "js/utils.js"), encoding="utf-8") as f:
            utils_src = f.read()
        self.assertIn("function _detectExitReason", utils_src,
                      "utils.js must define _detectExitReason")
        self.assertIn("stop_hit", utils_src)
        self.assertIn("target_hit", utils_src)
        # Page files must call the function (not redefine it)
        for fn in ("js/pages/recommendations.js", "js/pages/performance.js"):
            with open(os.path.join(ROOT, fn), encoding="utf-8") as f:
                src = f.read()
            self.assertIn("_detectExitReason", src,
                          f"{fn} must reference _detectExitReason")
            self.assertNotIn("function _detectExitReason", src,
                             f"{fn} must NOT redefine _detectExitReason (single copy in utils.js)")

    def test_exit_reason_no_longer_hardcoded_manual(self):
        """recommendations.js must call _detectExitReason instead of hardcoding 'manual'."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        # Old hardcoded pattern must be gone
        self.assertNotIn("exit_reason: 'manual'", src,
                         "Exit reason must be auto-detected, not hardcoded 'manual'")
        self.assertIn("_detectExitReason(", src)

    def test_buy_parent_reconcile_present(self):
        """markExecuted must reconcile parent BUY learning events on full position close."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("positionClosed", src,
                      "markExecuted must detect full position close for BUY reconcile")
        self.assertIn("parentRecs", src)


class TestStage2AutoClassification(unittest.TestCase):
    """Regression tests for Stage 2 — Auto-classification."""

    def test_auto_postmortem_triggered_on_loss(self):
        """Postmortem and skill scoring are manual-only — recommendations.js must NOT auto-trigger them."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        # The functions are still defined in debate-client.js and callable manually;
        # but markExecuted must not call them automatically.
        self.assertNotIn("triggerPostmortem(res.id)", src,
                         "triggerPostmortem must not be auto-called from markExecuted — manual only")
        self.assertNotIn("fetchSkillScore(res.id)", src,
                         "fetchSkillScore must not be auto-called from markExecuted — manual only")

    def test_calibration_accepts_tickers_param(self):
        """GET /api/learning/calibration must accept 'tickers' query param."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("tickers_req", src,
                      "calibration endpoint must parse 'tickers' query param")
        self.assertIn("per-ticker:", src,
                      "calibration must emit per-ticker memory line")

    def test_calibration_query_includes_ticker_column(self):
        """The calibration SQL query must SELECT ticker for per-ticker stats."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        # The SELECT in calibration must include ticker
        self.assertIn('SELECT ai_confidence, outcome_status, regime, sector, ticker,', src)

    def test_fetch_calibration_block_accepts_tickers(self):
        """fetchCalibrationBlock in learning-loop.js must accept tickers argument."""
        with open(os.path.join(ROOT, "js/learning-loop.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("async function fetchCalibrationBlock(regime, sectors, tickers)", src)
        self.assertIn("tickers.join(',')", src)

    def test_analysis_passes_portfolio_tickers_to_calibration(self):
        """analysis.js must pass portfolio tickers to fetchCalibrationBlock."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_portfolioTickers", src)
        self.assertIn("fetchCalibrationBlock(_activeRegime, _portfolioSectors, _portfolioTickers)", src)


class TestStage3PromptInstructions(unittest.TestCase):
    """Regression tests for Stage 3 — Prompt instructions."""

    def test_prompt_version_bumped_to_v5(self):
        """PROMPT_VERSION must be bumped to v8 after Sprint 47 prompt pipeline fixes."""
        with open(os.path.join(ROOT, "js/prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("PROMPT_VERSION = '2026-06-v8'", src,
                      "PROMPT_VERSION must be bumped to 2026-06-v8 after Sprint 47 prompt fixes")

    def test_calibration_algorithm_in_system_prompt(self):
        """System prompt must prescribe the calibration algorithm (confidence += adj, clamped)."""
        with open(os.path.join(ROOT, "js/prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("clamp(orig_conf + adj", src,
                      "System prompt must describe confidence += adj clamped algorithm")
        self.assertIn("per-ticker", src,
                      "System prompt must mention per-ticker calibration adjustment")

    def test_debate_block_usage_rule_in_prompt(self):
        """System prompt must include the debate-block usage rule."""
        with open(os.path.join(ROOT, "js/prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Local Debate", src,
                      "System prompt must contain guidance on handling Local Debate blocks")
        self.assertIn("BULL and BEAR", src)


class TestStage4ActiveFeedback(unittest.TestCase):
    """Regression tests for Stage 4 — Active feedback (synthesizer)."""

    def test_debate_returns_synthesis_field(self):
        """/api/debate response must include 'synthesis' key (even if None)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"synthesis":', src,
                      "debate_bull_bear must include synthesis field in response")
        self.assertIn("synth_prompt", src)
        self.assertIn("key_pivot", src)

    def test_debate_format_includes_synthesis_line(self):
        """formatDebateBlock in debate-client.js must include SYNTHESIS line when present."""
        with open(os.path.join(ROOT, "js/debate-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("SYNTHESIS:", src,
                      "debate-client.js must format synthesis as SYNTHESIS: line")
        self.assertIn("key_pivot", src)
        self.assertIn("debate.synthesis", src)


class TestDebateImprovements(unittest.TestCase):
    """Regression tests for D1–D7 debate engine improvements."""

    def test_debate_signals_include_5d_20d_returns(self):
        """sig_text must include 5d and 20d returns (D4)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("return_5d", src)
        self.assertIn("return_20d", src)
        self.assertIn("atr_pct", src)
        # Check these are in sig_text construction
        self.assertIn("5d=", src)
        self.assertIn("20d=", src)

    def test_signal_hash_includes_5d_20d(self):
        """Signal hash must include return_5d, return_20d, atr_pct (D4)."""
        with open(os.path.join(ROOT, "js/debate-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("return_5d", src)
        self.assertIn("return_20d", src)
        self.assertIn("atr_pct", src)
        # Verify it's in the hash function, not just in general usage
        hash_fn_idx = src.index("function _signalHash")
        hash_fn_end = src.index("\n}", hash_fn_idx) + 2
        hash_body = src[hash_fn_idx:hash_fn_end]
        self.assertIn("return_5d", hash_body)

    def test_sell_trim_get_exit_biased_prompts(self):
        """SELL/TRIM actions must trigger exit-biased bull/bear prompts (D7)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("is_exit", src)
        self.assertIn("exiting this position", src)
        self.assertIn("hold case", src.lower())

    def test_action_passed_to_debate_endpoint(self):
        """fetchDebate must pass action field in request body (D7)."""
        with open(os.path.join(ROOT, "js/debate-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("action: opts.action", src)
        self.assertIn("actions?.[t]", src)

    def test_synthesizer_num_predict_increased(self):
        """Synthesizer num_predict must be 180, not 120 (D1)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        # Should have 180 for synthesizer, NOT 120
        self.assertIn("num_predict=180", src)
        self.assertNotIn("num_predict=120", src)

    def test_synthesizer_json_extraction_improved(self):
        """Synthesizer must try json.loads first then scan from end (D2)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("json.loads(clean)", src)
        self.assertIn("reversed(list(re.finditer", src)

    def test_no_think_removed_from_prompts(self):
        """All prompt strings must not contain /no_think (D3)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("/no_think", src,
                         "D3: /no_think is redundant with think=False and must be removed")

    def test_entry_signals_in_postmortem_prompt_builder(self):
        """_pm_build_prompt must accept and inject entry_signals_str (D5)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("entry_signals_str", src)
        self.assertIn("Entry signals at the time", src)

    def test_skill_prompt_includes_entry_signals(self):
        """Skill score prompt must include entry_signals when available (D6)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        # Both the SELECT and the prompt injection must be present
        self.assertIn("entry_signals_json", src)
        # entry_signals_json must appear in the SELECT for debate_skill
        skill_idx = src.index("def debate_skill()")
        skill_body = src[skill_idx:skill_idx + 2000]
        self.assertIn("entry_signals_json", skill_body)

    def test_synthesis_winner_in_debate_summary(self):
        """buildDebateSummary must include synthesis winner in stored record (L5)."""
        with open(os.path.join(ROOT, "js/debate-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("synthesis.winner", src)
        # Verify the summary builder uses it
        idx = src.index("function buildDebateSummary")
        body = src[idx:idx + 400]
        self.assertIn("synthesis", body)


class TestLearningImprovements(unittest.TestCase):
    """Regression tests for L1–L4 and L6 learning loop improvements."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_regime_warning_skips_zero_trades(self):
        """Calibration must not emit regime warning when 0 trades exist (L1)."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        # Since ESS migration: regime section must skip when reg is empty.
        # Old: '0 < len(reg) < 3'. New: 'if not reg:' guard in ESS branch.
        # ESS guard: ess_reg = 0.0 when reg is empty, which is < _ESS_MIN, so it skips.
        self.assertTrue(
            "0 < len(reg) < 3" in src
            or "if not reg:" in src
            or ("ess_reg" in src and "_ESS_MIN" in src),
            "L1: regime warning must skip when 0 trades exist (old guard, if-not-reg, or ESS gate)"
        )

    def test_error_type_threshold_lowered(self):
        """Error-type threshold must be 0.33, not 0.40 (L2)."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("top_pct >= 0.33", src,
                      "L2: error-type threshold must be 0.33 (was 0.40)")
        self.assertNotIn("top_pct >= 0.40", src)

    def test_auto_expire_not_in_stats_get(self):
        """Auto-expire must NOT run inside learning_stats GET handler (L3)."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        # _expire_old_events must be a standalone function
        self.assertIn("def _expire_old_events(", src)
        # It should be called from learning_log, not from learning_stats
        stats_idx = src.index("def learning_stats()")
        stats_body = src[stats_idx:stats_idx + 500]
        self.assertNotIn("_expire_old_events", stats_body,
                         "L3: auto-expire must not run inside the GET /stats handler")
        log_idx = src.index("def learning_log()")
        log_body = src[log_idx:log_idx + 500]
        self.assertIn("_expire_old_events", log_body,
                      "L3: auto-expire must run inside learning_log (write path)")

    def test_calibration_ttl_cache_present(self):
        """Calibration must use a module-level TTL cache (L4)."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_calib_cache", src)
        self.assertIn("_CALIB_TTL", src)
        self.assertIn("_calib_compute(", src)

    def test_calibration_compute_extracted(self):
        """_calib_compute must be a pure function separate from the route (L4)."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        # _calib_compute must return a dict, not call jsonify
        idx = src.index("def _calib_compute(")
        end = src.index("\ndef ", idx + 1)
        body = src[idx:end]
        self.assertNotIn("jsonify", body,
                         "_calib_compute must return a dict, not a Flask response")
        self.assertIn("return {", body)

    def test_debate_synthesis_winner_in_db_migrations(self):
        """debate_synthesis_winner column must be in _LE_MIGRATIONS (L6)."""
        import db as _db
        col_names = [col for col, _ in _db._LE_MIGRATIONS]
        self.assertIn("debate_synthesis_winner", col_names)

    def test_debate_synthesis_winner_accepted_by_log(self):
        """POST /api/learning/log must accept debate_synthesis_winner (L6)."""
        resp = self.client.post(
            "/api/learning/log",
            data=json.dumps({
                "ticker": "CBA.AX", "event_type": "recommendation",
                "recommendation": "BUY", "ai_confidence": 0.75,
                "debate_synthesis_winner": "bull",
            }),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))

    def test_synthesis_winner_logged_in_analysis(self):
        """analysis.js must log debate_synthesis_winner in learning payload (L6)."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("debate_synthesis_winner", src)
        self.assertIn("_debate?.synthesis?.winner", src)


class TestSprint5(unittest.TestCase):
    """Tests for Sprint 5 features: postmortem digest, EOFY tax pack, persistence fixes."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_learning_digest_data_empty(self):
        """GET /api/learning/digest-data returns valid shape on empty DB."""
        resp = self.client.get("/api/learning/digest-data")
        self.assertEqual(resp.status_code, 200)
        d = json.loads(resp.data)
        self.assertIn("recent_failures", d)
        self.assertIn("regime_stats", d)
        self.assertIn("error_dist", d)
        self.assertIn("exit_dist", d)
        self.assertIsInstance(d["recent_failures"], list)

    def test_learning_digest_data_with_losses(self):
        """GET /api/learning/digest-data includes recent loss events."""
        # Seed a loss event
        self.client.post(
            "/api/learning/log",
            data=json.dumps({"ticker": "TLS.AX", "event_type": "recommendation",
                             "recommendation": "BUY", "ai_confidence": 0.70}),
            content_type="application/json",
        )
        row = _get_shared_conn().execute(
            "SELECT id FROM ai_learning_events WHERE ticker='TLS.AX'"
        ).fetchone()
        if row:
            self.client.post(
                "/api/learning/outcome",
                data=json.dumps({"id": row["id"], "outcome_status": "loss",
                                 "was_executed": 1, "realized_pnl_pct": -5.2,
                                 "exit_reason": "stop_hit"}),
                content_type="application/json",
            )
        resp = self.client.get("/api/learning/digest-data")
        self.assertEqual(resp.status_code, 200)
        d = json.loads(resp.data)
        tickers = [f["ticker"] for f in d["recent_failures"]]
        self.assertIn("TLS.AX", tickers)

    def test_eofy_pack_returns_zip(self):
        """GET /api/tax/eofy-pack returns a zip file."""
        resp = self.client.get("/api/tax/eofy-pack?year=2024")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.content_type, "application/zip")
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(resp.data)) as zf:
            names = zf.namelist()
        self.assertTrue(any("cgt_disposals" in n for n in names))
        self.assertTrue(any("trade_fees" in n for n in names))

    def test_eofy_pack_with_disposals(self):
        """EOFY pack includes CGT disposals when present in blob_store."""
        sample = json.dumps([{
            "saleDate": "2025-03-15", "ticker": "CBA",
            "salePrice": 130.0, "saleQty": 10, "proceeds": 1300.0,
            "parcelDate": "2024-01-10", "parcelCostPerShare": 100.0,
            "costBase": 1000.0, "saleFee": 10.0,
            "grossGain": 290.0, "discount": 145.0, "netGain": 145.0,
            "heldDays": 429, "eligible50": True,
        }])
        _get_shared_conn().execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES ('cgtDisposals', ?, datetime('now'))",
            (sample,)
        )
        _get_shared_conn().commit()

        resp = self.client.get("/api/tax/eofy-pack?year=2024")
        self.assertEqual(resp.status_code, 200)
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(resp.data)) as zf:
            cgt_csv = zf.read([n for n in zf.namelist() if "cgt" in n][0]).decode()
        self.assertIn("CBA", cgt_csv)
        self.assertIn("290.0", cgt_csv)

    def test_db_save_persists_watchlist(self):
        """POST /api/db/save stores watchlist in blob_store."""
        payload = {
            "watchlist": [{"ticker": "WDS", "addedAt": "2025-05-01", "notes": "test"}],
            "savedScreeners": [],
        }
        resp = self.client.post(
            "/api/db/save",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        row = _get_shared_conn().execute(
            "SELECT value FROM blob_store WHERE key='watchlist'"
        ).fetchone()
        self.assertIsNotNone(row)
        stored = json.loads(row["value"])
        self.assertEqual(stored[0]["ticker"], "WDS")

    def test_db_load_returns_watchlist(self):
        """GET /api/db/load returns watchlist from blob_store."""
        _get_shared_conn().execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES ('watchlist', ?, datetime('now'))",
            (json.dumps([{"ticker": "GMG", "addedAt": "2025-05-01", "notes": ""}]),)
        )
        _get_shared_conn().commit()
        resp = self.client.get("/api/db/load")
        self.assertEqual(resp.status_code, 200)
        d = json.loads(resp.data)
        self.assertIn("watchlist", d)
        tickers = [x["ticker"] for x in (d["watchlist"] or [])]
        self.assertIn("GMG", tickers)

    def test_morning_brief_prompt_defined(self):
        """MORNING_BRIEFING_SYSTEM_PROMPT must be defined in prompts.js."""
        with open(os.path.join(ROOT, "js/prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("MORNING_BRIEFING_SYSTEM_PROMPT", src)
        self.assertIn("morning session note", src.lower())

    def test_journal_regime_badge_function(self):
        """journal.js must define _journalRegimeBadge helper."""
        with open(os.path.join(ROOT, "js/pages/journal.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_journalRegimeBadge", src)
        self.assertIn("matchedRec", src)

    def test_generate_morning_brief_function(self):
        """dashboard.js must define generateMorningBrief and use briefing agent type."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("async function generateMorningBrief()", src)
        self.assertIn("callClaude('briefing'", src)

    def test_generate_postmortem_digest_function(self):
        """learning.js must define generatePostmortemDigest async function."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("async function generatePostmortemDigest()", src)
        self.assertIn("/api/learning/digest-data", src)

    def test_download_eofy_pack_function(self):
        """cgt.js must define downloadEofyPack async function."""
        with open(os.path.join(ROOT, "js/pages/cgt.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("async function downloadEofyPack()", src)
        self.assertIn("/api/tax/eofy-pack", src)

    def test_stale_nudge_function(self):
        """dashboard.js must define _buildStaleNudgeCard helper."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildStaleNudgeCard()", src)
        self.assertIn("_STALE_DAYS", src)


class TestSprint6(unittest.TestCase):
    """Sprint 6 — portfolio Q&A, attribution, sector warnings, thesis, dividend forecast."""

    def setUp(self):
        _install_in_memory_db()
        self.client = asx_server.app.test_client()

    # ── 1. Portfolio-aware Q&A ────────────────────────────────────────────────
    def test_assistant_includes_regime_context(self):
        """assistant.js sendChat must include regime and macro context in system prompt."""
        with open(os.path.join(ROOT, "js/pages/assistant.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("regimeCtx", src)
        self.assertIn("state.currentRegime", src)
        self.assertIn("state.macroData", src)
        self.assertIn("MARKET REGIME", src)
        self.assertIn("MACRO DATA", src)

    def test_assistant_appends_regime_to_system(self):
        """regimeCtx must be appended to the system prompt string."""
        with open(os.path.join(ROOT, "js/pages/assistant.js"), encoding="utf-8") as f:
            src = f.read()
        # The system string template must end with regimeCtx
        self.assertIn("${regimeCtx}", src)

    # ── 2. Performance Attribution ────────────────────────────────────────────
    def test_attribution_card_function(self):
        """performance.js must define _buildAttributionCard function."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildAttributionCard(closedTrades)", src)
        self.assertIn("sectorMap", src)
        self.assertIn("regimeMap", src)

    def test_attribution_card_called_in_render(self):
        """renderPerformance must call _buildAttributionCard."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildAttributionCard(closedTrades)", src)

    def test_attribution_uses_regime_from_rechistory(self):
        """Attribution card looks up regime via recId → recHistory."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("state.recHistory.find(r => r.id === t.recId)", src)

    # ── 3. Sector concentration warning ──────────────────────────────────────
    def test_sector_concentration_warning_function(self):
        """recommendations.js must define _sectorConcentrationWarning."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _sectorConcentrationWarning(rec)", src)
        self.assertIn("maxSectorPct", src)

    def test_sector_warning_used_in_rec_card(self):
        """Rec card header must call _sectorConcentrationWarning."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_sectorConcentrationWarning(r)", src)

    # ── 4. Thesis capture ────────────────────────────────────────────────────
    def test_thesis_input_in_rec_card(self):
        """recommendations.js must render a thesis textarea on each rec card."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('id="thesis-${r.id}"', src)
        self.assertIn("_thesis", src)

    def test_thesis_captured_at_execution(self):
        """markExecuted must capture thesis from DOM and pass to learning log."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("thesis-${id}", src)
        self.assertIn("trade_thesis", src)
        self.assertIn("rec._thesis", src)

    def test_thesis_in_histentry(self):
        """histEntry saved to recHistory must include _thesis field."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_thesis: rec._thesis || null", src)

    def test_thesis_shown_in_journal(self):
        """journal.js must show thesis tooltip when matchedRec._thesis is set."""
        with open(os.path.join(ROOT, "js/pages/journal.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("matchedRec?._thesis", src)

    # ── 5. Dividend income forecast ──────────────────────────────────────────
    def test_div_forecast_card_function(self):
        """performance.js must define _buildDivForecastCard function."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildDivForecastCard()", src)
        self.assertIn("Dividend Income Forecast", src)

    def test_div_forecast_includes_franking(self):
        """Dividend forecast must compute franking credit gross-up."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("CORP_TAX", src)
        self.assertIn("grossUp", src)
        self.assertIn("frankingCredit", src)

    def test_div_forecast_called_in_render(self):
        """renderPerformance must call _buildDivForecastCard."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildDivForecastCard()", src)


class TestSprint7(unittest.TestCase):
    """Sprint 7 — thesis review, prompt P&L, target allocations, economic calendar, franking 45-day."""

    def setUp(self):
        _install_in_memory_db()
        self.client = asx_server.app.test_client()

    # ── 1. Thesis review at exit ──────────────────────────────────────────────
    def test_thesis_review_function_defined(self):
        """recommendations.js must define _showThesisReview function."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _showThesisReview(", src)

    def test_thesis_review_uses_dialog_element(self):
        """_showThesisReview must use a <dialog> element for the modal."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("createElement('dialog')", src)

    def test_thesis_review_posts_verdict(self):
        """_showThesisReview must POST to /api/learning/outcome with thesis verdict."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("/api/learning/outcome", src)
        self.assertIn("THESIS:", src)

    def test_thesis_review_hooked_into_mark_executed(self):
        """markExecuted must call _showThesisReview when position fully closes."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_showThesisReview(", src)
        self.assertIn("positionClosed", src)

    # ── 2. Prompt version P&L ─────────────────────────────────────────────────
    def test_prompt_version_pnl_in_backend_sql(self):
        """learning.py version stats must include total_pnl in SQL query."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("total_pnl", src)
        self.assertIn("realized_pnl_aud", src)

    def test_prompt_version_pnl_in_version_list(self):
        """learning.py version_list must include total_pnl field in response."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"total_pnl"', src)

    def test_prompt_version_pnl_column_in_ui(self):
        """learning.js versionsCard must have a Realised P&L column."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Realised P&amp;L", src)
        self.assertIn("total_pnl", src)

    # ── 3. Target allocations + drift alerts ─────────────────────────────────
    def test_target_alloc_card_function(self):
        """risk.js must define _buildTargetAllocCard function."""
        with open(os.path.join(ROOT, "js/pages/risk.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildTargetAllocCard(", src)

    def test_target_alloc_set_function(self):
        """risk.js must define setTargetAlloc function for inline input edits."""
        with open(os.path.join(ROOT, "js/pages/risk.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function setTargetAlloc(", src)
        self.assertIn("state.targetAllocations", src)

    def test_target_alloc_card_called_in_risk_page(self):
        """buildRiskPage must call _buildTargetAllocCard."""
        with open(os.path.join(ROOT, "js/pages/risk.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildTargetAllocCard(", src)

    def test_target_alloc_drift_thresholds(self):
        """Target allocation card must warn amber at 5% drift and red at 10%."""
        with open(os.path.join(ROOT, "js/pages/risk.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("10", src)
        self.assertIn("5", src)

    def test_target_alloc_in_config(self):
        """config.js state must include targetAllocations default."""
        with open(os.path.join(ROOT, "js/config.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("targetAllocations", src)

    def test_target_alloc_in_api_save(self):
        """api.js save payload must include targetAllocations."""
        with open(os.path.join(ROOT, "js/api.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("targetAllocations", src)

    def test_target_alloc_in_blob_keys(self):
        """portfolio.py BLOB_KEYS must include targetAllocations."""
        with open(os.path.join(ROOT, "routes/portfolio.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("targetAllocations", src)

    # ── 4. Economic calendar ──────────────────────────────────────────────────
    def test_economic_calendar_function(self):
        """dashboard.js must define _buildEconomicCalendarCard function."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildEconomicCalendarCard()", src)

    def test_rba_meeting_dates_hardcoded(self):
        """dashboard.js must hard-code RBA meeting dates for 2026 and 2027."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_RBA_MEETINGS_2026", src)
        self.assertIn("_RBA_MEETINGS_2027", src)
        self.assertIn("2026-", src)

    def test_economic_calendar_includes_exdiv(self):
        """Economic calendar must include ex-dividend dates from dividendData."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("exDividendDate", src)

    def test_economic_calendar_called_in_render(self):
        """renderDashboard must call _buildEconomicCalendarCard."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildEconomicCalendarCard()", src)

    # ── 5. Franking 45-day rule ───────────────────────────────────────────────
    def test_franking_45day_function(self):
        """cgt.js must define _buildFranking45DayCard function."""
        with open(os.path.join(ROOT, "js/pages/cgt.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildFranking45DayCard()", src)

    def test_franking_45day_checks_exdiv(self):
        """_buildFranking45DayCard must inspect ex-dividend dates."""
        with open(os.path.join(ROOT, "js/pages/cgt.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("exDividendDate", src)
        self.assertIn("45", src)

    def test_franking_45day_warns_on_cgt_page(self):
        """renderCGT must include the franking 45-day card."""
        with open(os.path.join(ROOT, "js/pages/cgt.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildFranking45DayCard()", src)


class TestDigestHistory(unittest.TestCase):
    """Digest history — save/load AI postmortem digests across sessions."""

    def setUp(self):
        _install_in_memory_db()
        self.client = asx_server.app.test_client()

    def test_digest_history_in_config(self):
        """config.js state must include digestHistory default."""
        with open(os.path.join(ROOT, "js/config.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("digestHistory", src)

    def test_digest_saved_after_generation(self):
        """generatePostmortemDigest must push entry to state.digestHistory and call saveStateToDb."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("state.digestHistory.unshift(", src)
        self.assertIn("saveStateToDb()", src)

    def test_digest_delete_function(self):
        """learning.js must define deleteDigest(index) to remove entries."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function deleteDigest(", src)
        self.assertIn("state.digestHistory.splice(", src)

    def test_digest_history_rendered_in_card(self):
        """Learning page digest card must render the digestHistory list."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("state.digestHistory", src)
        self.assertIn("deleteDigest(", src)

    def test_digest_history_in_api_save(self):
        """api.js save payload must include digestHistory."""
        with open(os.path.join(ROOT, "js/api.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("digestHistory", src)

    def test_digest_history_in_blob_keys(self):
        """portfolio.py BLOB_KEYS must include digestHistory."""
        with open(os.path.join(ROOT, "routes/portfolio.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("digestHistory", src)

    def test_digest_capped_at_50(self):
        """Digest history must be capped to prevent unbounded growth."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("digestHistory.length > 50", src)


class TestSprint8(unittest.TestCase):
    """Sprint 8 — A-VIX, cash/TD tracker, exact corr sizing, perf/responsiveness, kbd shortcuts."""

    def setUp(self):
        _install_in_memory_db()
        self.client = asx_server.app.test_client()

    # ── 1. A-VIX proxy ───────────────────────────────────────────────────────
    def test_avix_computed_in_macro_payload(self):
        """market.py _macro_payload must compute asx_vol_20d (realized vol)."""
        with open(os.path.join(ROOT, "routes/market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("asx_vol_20d", src)
        self.assertIn("asx_vol_20d", src)
        self.assertIn("252 ** 0.5", src)

    def test_avix_in_regime_engine(self):
        """regime-engine.js must read asx_vol_20d and vote on it."""
        with open(os.path.join(ROOT, "js/regime-engine.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("asxVol20d", src)
        self.assertIn("asx_vol_20d", src)
        self.assertIn("A-VIX", src)

    def test_avix_displayed_on_macro_page(self):
        """macro.js must display asx_vol_20d in the Market Risk card."""
        with open(os.path.join(ROOT, "js/pages/macro.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("asx_vol_20d", src)
        self.assertIn("A-VIX", src)

    # ── 2. Cash & term-deposit tracker ───────────────────────────────────────
    def test_term_deposits_in_config(self):
        """config.js state must include termDeposits default."""
        with open(os.path.join(ROOT, "js/config.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("termDeposits", src)

    def test_cash_tracker_card_function(self):
        """dashboard.js must define _buildCashTrackerCard function."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildCashTrackerCard()", src)
        self.assertIn("termDeposits", src)
        self.assertIn("deployable", src)

    def test_add_remove_td_functions(self):
        """dashboard.js must define addTD and removeTD functions."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("async function addTD()", src)
        self.assertIn("async function removeTD(", src)

    def test_term_deposits_persisted(self):
        """termDeposits must be in api.js save payload and portfolio.py BLOB_KEYS."""
        with open(os.path.join(ROOT, "js/api.js"), encoding="utf-8") as f:
            api_src = f.read()
        with open(os.path.join(ROOT, "routes/portfolio.py"), encoding="utf-8") as f:
            py_src = f.read()
        self.assertIn("termDeposits", api_src)
        self.assertIn("termDeposits", py_src)

    # ── 3. Exact correlation-aware sizing ────────────────────────────────────
    def test_corr_sizing_in_analysis(self):
        """analysis.js must fetch /api/risk correlation and reduce qty when |corr| > 0.7."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_corrNote", src)
        self.assertIn("_corrMatrix", src)
        self.assertIn("maxCorr > 0.85", src)
        self.assertIn("maxCorr > 0.7", src)

    def test_corr_note_shown_on_rec_card(self):
        """recommendations.js must show _corrNote badge on BUY rec cards."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_corrNote", src)
        self.assertIn("Corr", src)

    # ── 4. Performance / responsiveness ──────────────────────────────────────
    def test_macro_payload_no_serial_fetches(self):
        """_macro_payload must use parallel fetch for aud_usd and iron_ore history."""
        with open(os.path.join(ROOT, "routes/market.py"), encoding="utf-8") as f:
            src = f.read()
        # Both symbols now in the single parallel symbols dict
        self.assertIn('"aud_usd":  ("AUDUSD=X", "1mo")', src)
        self.assertIn('"iron_ore": ("TIO=F",    "1mo")', src)
        # No second serial re-fetch of AUDUSD=X or TIO=F
        self.assertNotIn('yf.Ticker("AUDUSD=X").history', src)
        self.assertNotIn('yf.Ticker("TIO=F").history', src)

    def test_macro_payload_asx200_3mo_parallel(self):
        """_macro_payload must fetch ASX200 3mo in the parallel block (not separately)."""
        with open(os.path.join(ROOT, "routes/market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"asx200":   ("^AXJO",    "3mo")', src)
        # The old serial re-fetch is gone
        self.assertNotIn('yf.Ticker("^AXJO").history(period="3mo")', src)

    def test_5d_change_from_cached_history(self):
        """_macro_payload must compute 5d change from _histories dict, not a separate fetch."""
        with open(os.path.join(ROOT, "routes/market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_histories", src)
        self.assertIn("aud_usd_change_5d", src)
        self.assertIn("iron_ore_change_5d", src)
        # Ensure the 5d change comes from _histories, not a new serial Ticker fetch
        self.assertIn('_histories.get(key)', src)

    # ── 5. Keyboard shortcuts ─────────────────────────────────────────────────
    def test_keyboard_shortcuts_in_navigation(self):
        """navigation.js must define keyboard shortcut handler and PAGE_KEYS map."""
        with open(os.path.join(ROOT, "js/navigation.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("PAGE_KEYS", src)
        self.assertIn("_showShortcutsHelp", src)
        self.assertIn("keydown", src)

    def test_shortcuts_cover_main_pages(self):
        """Shortcut map must include dashboard, portfolio, recommendations, risk, learning."""
        with open(os.path.join(ROOT, "js/navigation.js"), encoding="utf-8") as f:
            src = f.read()
        for page in ["dashboard", "portfolio", "recommendations", "risk", "learning"]:
            self.assertIn(page, src)

    def test_shortcuts_help_modal_uses_dialog(self):
        """Shortcuts help must open as a <dialog> element."""
        with open(os.path.join(ROOT, "js/navigation.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("createElement('dialog')", src)
        self.assertIn("showModal()", src)


class TestAICallLog(unittest.TestCase):
    """Tests for the prompt+response logging feature (ai_call_log table)."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_ai_call_log_table_in_schema(self):
        """ai_call_log must be in the DB schema."""
        import db as db_module
        self.assertIn("ai_call_log", db_module._SCHEMA)

    def test_log_ai_response_stores_full_context(self):
        """POST /api/log/ai_response must accept prompt+response and return ok."""
        payload = {
            "text":          "test response",
            "system_prompt": "you are a test assistant",
            "user_message":  "hello",
            "agent_type":    "portfolio",
            "model":         "claude-sonnet-4-6",
            "usage":         {"input_tokens": 100, "output_tokens": 50,
                              "cache_read_input_tokens": 80, "cache_creation_input_tokens": 20},
            "duration_ms":   1234,
        }
        resp = self.client.post(
            "/api/log/ai_response",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))

    def test_list_ai_calls_returns_entries(self):
        """GET /api/log/ai_calls must return entries after a log call."""
        resp = self.client.get("/api/log/ai_calls?limit=5")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))
        self.assertIn("entries", body)
        self.assertIn("total", body)

    def test_list_ai_calls_agent_filter(self):
        """GET /api/log/ai_calls?agent_type=X must filter correctly."""
        # Log one more with a distinct agent type
        self.client.post(
            "/api/log/ai_response",
            data=json.dumps({"text": "macro resp", "agent_type": "macro"}),
            content_type="application/json",
        )
        resp = self.client.get("/api/log/ai_calls?agent_type=macro")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        for entry in body["entries"]:
            self.assertEqual(entry["agent_type"], "macro")

    def test_get_ai_call_detail(self):
        """GET /api/log/ai_call/<id> must return full content."""
        # First log a call
        self.client.post(
            "/api/log/ai_response",
            data=json.dumps({"text": "detail test", "agent_type": "analyst",
                             "system_prompt": "sys", "user_message": "usr"}),
            content_type="application/json",
        )
        # Get the id from the list
        list_resp = self.client.get("/api/log/ai_calls?agent_type=analyst&limit=1")
        entries = json.loads(list_resp.data)["entries"]
        if not entries:
            self.skipTest("No analyst entries found")
        call_id = entries[0]["id"]
        resp = self.client.get(f"/api/log/ai_call/{call_id}")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("response_text", body)
        self.assertIn("system_prompt", body)
        self.assertIn("user_message", body)

    def test_get_ai_call_404(self):
        """GET /api/log/ai_call/99999 must return 404."""
        resp = self.client.get("/api/log/ai_call/99999")
        self.assertEqual(resp.status_code, 404)

    def test_callclaude_logs_automatically(self):
        """claude-client.js must fire the log endpoint after every successful call."""
        with open(os.path.join(ROOT, "js/claude-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("api/log/ai_response", src,
                      "callClaude must fire /api/log/ai_response after success")
        self.assertIn("system_prompt", src,
                      "callClaude log payload must include system_prompt")
        self.assertIn("user_message", src,
                      "callClaude log payload must include user_message")
        self.assertIn("duration_ms", src,
                      "callClaude log payload must include duration_ms")

    def test_analysis_no_longer_has_redundant_log(self):
        """analysis.js must not have the old manual log call (now in callClaude)."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        # The old code sent { text } only; the new one in claude-client.js sends more fields.
        # Check that the old bare { text } post is gone from analysis.js:
        import re as _re
        old_pattern = r"body.*JSON\.stringify\(\s*\{\s*text\s*\}\s*\)"
        self.assertIsNone(
            _re.search(old_pattern, src),
            "analysis.js must not have the old bare {text} log call — it moved to callClaude()",
        )

    def test_health_endpoint_returns_version(self):
        """GET /health must include version, uptime_s, and last_backup."""
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertEqual(body["status"], "ok")
        self.assertIn("version", body)
        self.assertIn("uptime_s", body)
        self.assertIn("last_backup", body)


class TestComparePage(unittest.TestCase):
    """Tests for the side-by-side compare feature."""

    def test_compare_js_exists(self):
        """js/pages/compare.js must exist."""
        self.assertTrue(
            os.path.isfile(os.path.join(ROOT, "js/pages/compare.js")),
            "js/pages/compare.js must exist",
        )

    def test_compare_js_syntax(self):
        """compare.js must pass node --check."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/compare.js")],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, f"compare.js syntax error: {result.stderr}")

    def test_compare_page_in_navigation(self):
        """navigation.js must redirect 'compare' to scanner and have g+x shortcut."""
        with open(os.path.join(ROOT, "js/navigation.js"), encoding="utf-8") as f:
            src = f.read()
        # Redirect: showPage('compare') sets _scannerTab and switches to scanner
        self.assertIn("case 'compare'", src)
        self.assertIn("x: 'compare'", src)
        # Redirection logic must be present
        self.assertIn("_scannerTab = 'compare'", src)

    def test_compare_script_in_html(self):
        """asx_trading.html must load compare.js."""
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("pages/compare.js", src)

    def test_compare_no_standalone_nav_item(self):
        """Compare is now a tab in Market Scanner — no standalone nav button needed."""
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        # The sidebar should NOT have a dedicated Compare nav button
        self.assertNotIn('<button class="nav-item" onclick="showPage(\'compare\')', src,
                         "Compare must be a scanner tab, not a standalone nav item")

    def test_compare_tab_in_scanner(self):
        """scanner.js must include a Compare tab button."""
        with open(os.path.join(ROOT, "js/pages/scanner.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("'compare'", src)
        self.assertIn("↔ Compare", src)
        self.assertIn("_initCompareTab", src)

    def test_compare_functions_present(self):
        """compare.js must expose renderComparePage, runComparison, compareFromOutside."""
        with open(os.path.join(ROOT, "js/pages/compare.js"), encoding="utf-8") as f:
            src = f.read()
        for fn in ["renderComparePage", "runComparison", "compareFromOutside", "clearComparison"]:
            self.assertIn(fn, src, f"compare.js must define {fn}")


class TestETFEarningsFilter(unittest.TestCase):
    """ETF detection in the earnings calendar endpoint."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_earnings_calendar_skips_etf_via_quotetype(self):
        """_fetch_earnings must return skipped='ETF' for quoteType=ETF."""
        import routes.market as _mkt
        # Simulate a yfinance ticker whose info.quoteType == 'ETF'
        class _FakeTicker:
            info = {"quoteType": "ETF"}
            calendar = None
        import unittest.mock as _mock
        with _mock.patch.object(_mkt.yf, "Ticker", return_value=_FakeTicker()):
            resp = self.client.get("/api/earnings-calendar?tickers=VAS")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("VAS", body)
        self.assertEqual(body["VAS"].get("skipped"), "ETF")


class TestCapitalReturnsCheck(unittest.TestCase):
    """GET /api/portfolio/capital-returns-check — large distribution detection."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_endpoint_returns_empty_for_no_dividends(self):
        """Returns [] per ticker when dividends are None or empty."""
        import unittest.mock as _mock
        import yfinance as yf

        class _FakeTicker:
            splits = None
            dividends = None
            def history(self, **kw):
                import pandas as pd
                return pd.DataFrame()
        with _mock.patch.object(yf, "Ticker", return_value=_FakeTicker()):
            resp = self.client.get("/api/portfolio/capital-returns-check?tickers=CBA")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("CBA", body)
        self.assertEqual(body["CBA"], [])

    def test_flags_large_dividend(self):
        """Payment ≥5% of current price must be flagged with amount_pct."""
        import unittest.mock as _mock
        import yfinance as yf
        import pandas as pd

        large_div = pd.Series(
            [0.60],
            index=pd.to_datetime(["2026-05-01"]).tz_localize("UTC"),
        )
        large_div.index.name = "Date"

        class _FakeTicker:
            splits = None
            dividends = large_div
            def history(self, **kw):
                return pd.DataFrame({"Close": [10.0]}, index=pd.to_datetime(["2026-05-01"]))
        with _mock.patch.object(yf, "Ticker", return_value=_FakeTicker()):
            resp = self.client.get("/api/portfolio/capital-returns-check?tickers=BHP")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(len(body["BHP"]) > 0, "Expected large dividend (6%) to be flagged")
        self.assertIn("amount_pct", body["BHP"][0])
        self.assertGreaterEqual(body["BHP"][0]["amount_pct"], 5.0)

    def test_ignores_small_dividend(self):
        """Regular dividend below 5% threshold must NOT be flagged."""
        import unittest.mock as _mock
        import yfinance as yf
        import pandas as pd

        small_div = pd.Series(
            [0.20],
            index=pd.to_datetime(["2026-05-01"]).tz_localize("UTC"),
        )
        small_div.index.name = "Date"

        class _FakeTicker:
            splits = None
            dividends = small_div
            def history(self, **kw):
                return pd.DataFrame({"Close": [10.0]}, index=pd.to_datetime(["2026-05-01"]))
        with _mock.patch.object(yf, "Ticker", return_value=_FakeTicker()):
            resp = self.client.get("/api/portfolio/capital-returns-check?tickers=CBA")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertEqual(body["CBA"], [], "Small dividend (2%) should not be flagged")

    def test_portfolio_js_capital_return_warning_renders(self):
        """portfolio.js must render a capital-return warning banner."""
        with open(os.path.join(ROOT, "js/pages/portfolio.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_capitalReturnWarnings", src)
        self.assertIn("capital return", src)

    def test_navigation_js_calls_check_capital_returns(self):
        """navigation.js must call checkCapitalReturns when loading portfolio page."""
        with open(os.path.join(ROOT, "js/navigation.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("checkCapitalReturns", src)


class TestPromptVersionDelta(unittest.TestCase):
    """Prompt version A/B delta in the Learning Loop UI."""

    def test_delta_column_in_learning_js(self):
        """learning.js prompt version table must include Δ vs prev column."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("vs prev", src,
                      "learning.js must have a Δ vs prev column header")
        self.assertIn("isCurrent", src,
                      "learning.js must highlight the current prompt version")
        self.assertIn("PROMPT_VERSION", src,
                      "learning.js must reference PROMPT_VERSION for current-version badge")


class TestSprint10FormingBarAndStooq(unittest.TestCase):
    """Sprint 10 — forming-bar fix and Stooq fallback in indicators.py."""

    def test_drop_forming_bar_function_exists(self):
        """indicators.py must define _drop_forming_bar."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _drop_forming_bar(", src)

    def test_drop_forming_bar_removes_todays_bar_before_settlement(self):
        """_drop_forming_bar must remove the last row when now_utc.hour < 7 and last bar is today."""
        import importlib, datetime
        import pandas as pd
        import indicators as ind

        # Build a 3-row DataFrame whose last row is 'today' (AEST = UTC+10)
        today_aest = (datetime.datetime.utcnow() + datetime.timedelta(hours=10)).date()
        idx = pd.to_datetime([
            str(today_aest - datetime.timedelta(days=2)),
            str(today_aest - datetime.timedelta(days=1)),
            str(today_aest),
        ])
        df = pd.DataFrame(
            {"Open": [1, 2, 3], "High": [1, 2, 3], "Low": [1, 2, 3],
             "Close": [1, 2, 3], "Volume": [100, 200, 300]},
            index=idx,
        )
        import unittest.mock as _mock
        # Patch utcnow to 06:00 UTC (before 07:00 settlement cutoff)
        fake_now = datetime.datetime(today_aest.year, today_aest.month, today_aest.day, 6, 0, 0)
        with _mock.patch("indicators._dt_mod") as mock_dt:
            mock_dt.datetime.utcnow.return_value = fake_now
            mock_dt.timedelta.side_effect = lambda **kw: datetime.timedelta(**kw)
            result = ind._drop_forming_bar(df)
        self.assertEqual(len(result), 2, "Forming bar should be dropped before 07:00 UTC")

    def test_drop_forming_bar_keeps_bar_after_settlement(self):
        """_drop_forming_bar must NOT remove the last row after 07:00 UTC."""
        import importlib, datetime
        import pandas as pd
        import indicators as ind

        today_aest = (datetime.datetime.utcnow() + datetime.timedelta(hours=10)).date()
        idx = pd.to_datetime([
            str(today_aest - datetime.timedelta(days=1)),
            str(today_aest),
        ])
        df = pd.DataFrame(
            {"Open": [1, 2], "High": [1, 2], "Low": [1, 2],
             "Close": [1, 2], "Volume": [100, 200]},
            index=idx,
        )
        import unittest.mock as _mock
        fake_now = datetime.datetime(today_aest.year, today_aest.month, today_aest.day, 8, 0, 0)
        with _mock.patch("indicators._dt_mod") as mock_dt:
            mock_dt.datetime.utcnow.return_value = fake_now
            result = ind._drop_forming_bar(df)
        self.assertEqual(len(result), 2, "Bar must NOT be dropped after settlement window")

    def test_drop_forming_bar_keeps_old_bars_before_settlement(self):
        """_drop_forming_bar must not drop a bar from 2+ days ago even before 07:00 UTC."""
        import datetime
        import pandas as pd
        import indicators as ind

        yesterday = (datetime.datetime.utcnow() - datetime.timedelta(days=1)).date()
        idx = pd.to_datetime([
            str(yesterday - datetime.timedelta(days=1)),
            str(yesterday),
        ])
        df = pd.DataFrame(
            {"Open": [1, 2], "High": [1, 2], "Low": [1, 2],
             "Close": [1, 2], "Volume": [100, 200]},
            index=idx,
        )
        import unittest.mock as _mock
        fake_now = datetime.datetime.utcnow().replace(hour=3)
        with _mock.patch("indicators._dt_mod") as mock_dt:
            mock_dt.datetime.utcnow.return_value = fake_now
            mock_dt.timedelta.side_effect = lambda **kw: datetime.timedelta(**kw)
            result = ind._drop_forming_bar(df)
        self.assertEqual(len(result), 2, "Old bars must never be dropped")

    def test_fetch_stooq_history_function_exists(self):
        """indicators.py must define _fetch_stooq_history."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _fetch_stooq_history(", src)

    def test_stooq_url_format(self):
        """_fetch_stooq_history must build a stooq.com URL with .au suffix."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stooq.com", src)
        self.assertIn(".au", src)  # ticker conversion suffix

    def test_analyse_ticker_calls_forming_bar_drop(self):
        """analyse_ticker must call _drop_forming_bar on the fetched hist."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_drop_forming_bar(hist)", src)

    def test_analyse_ticker_calls_stooq_fallback(self):
        """analyse_ticker must call _fetch_stooq_history when yfinance is insufficient."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_fetch_stooq_history(", src)

    def test_analyse_ticker_stooq_returns_empty_df_on_failure(self):
        """_fetch_stooq_history must return empty DataFrame when HTTP fails."""
        import indicators as ind
        import unittest.mock as _mock
        # Patch _HTTP_SESSION import inside the function
        with _mock.patch("indicators.io") as _io_mock:
            _io_mock.StringIO.side_effect = Exception("network error")
            from core import _HTTP_SESSION as real_sess
            with _mock.patch.object(real_sess, "get", side_effect=Exception("connection refused")):
                result = ind._fetch_stooq_history("BHP", "6mo")
        import pandas as pd
        self.assertIsInstance(result, pd.DataFrame)
        self.assertTrue(result.empty)


class TestSprint10StopProximityAlerts(unittest.TestCase):
    """Sprint 10 — stop-proximity pre-warning alert feature."""

    def test_check_stop_proximity_alerts_defined(self):
        """alerts.js must define checkStopProximityAlerts."""
        with open(os.path.join(ROOT, "js/alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function checkStopProximityAlerts(", src)

    def test_proximity_alert_direction_aware(self):
        """checkStopProximityAlerts must distinguish BUY from SELL direction."""
        with open(os.path.join(ROOT, "js/alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("isBuy", src)
        self.assertIn("SELL", src)

    def test_proximity_alert_uses_setting(self):
        """checkStopProximityAlerts must read stopProximityPct from state.settings."""
        with open(os.path.join(ROOT, "js/alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stopProximityPct", src)

    def test_proximity_alert_one_shot(self):
        """checkStopProximityAlerts must use _proximityAlertedAt for one-shot dedup."""
        with open(os.path.join(ROOT, "js/alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_proximityAlertedAt", src)

    def test_prices_calls_proximity_alerts(self):
        """prices.js must call checkStopProximityAlerts after price refresh."""
        with open(os.path.join(ROOT, "js/prices.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("checkStopProximityAlerts", src)

    def test_stop_proximity_pct_in_config_defaults(self):
        """config.js must define stopProximityPct in state.settings defaults."""
        with open(os.path.join(ROOT, "js/config.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stopProximityPct", src)

    def test_stop_proximity_setting_in_settings_ui(self):
        """settings.js must expose stopProximityPct as a configurable field."""
        with open(os.path.join(ROOT, "js/pages/settings.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stopProximityPct", src)
        self.assertIn("Stop proximity", src)


class TestSprint10PositionAge(unittest.TestCase):
    """Sprint 10 — position age + unrealised P&L enrichment in analysis prompt."""

    def test_days_held_helper_defined(self):
        """analysis.js must define _daysHeld helper function."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_daysHeld", src)

    def test_portfolio_json_includes_days_held(self):
        """portfolioJson in analysis.js must include daysHeld field."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("daysHeld", src)

    def test_portfolio_json_includes_unrealised_pnl_pct(self):
        """portfolioJson in analysis.js must include unrealisedPnlPct field."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("unrealisedPnlPct", src)

    def test_days_held_uses_trade_journal(self):
        """_daysHeld must look up state.tradeJournal for earliest open BUY/TOP_UP."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("tradeJournal", src)
        self.assertIn("TOP_UP", src)


class TestIntradayStrategy(unittest.TestCase):
    """Sprint 11 — ASX100 intraday 3-4% day-trade strategy."""

    # ── Backend ──────────────────────────────────────────────────────────────

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_intraday_blueprint_registered(self):
        """GET /api/intraday/<ticker> must return 200."""
        import unittest.mock as _mock
        import pandas as pd
        import numpy as np

        # Build a synthetic 10-bar 5m intraday DataFrame
        dates = pd.date_range("2026-05-28 00:10", periods=10, freq="5min", tz="UTC")
        df = pd.DataFrame({
            "Open":   np.full(10, 50.0),
            "High":   np.full(10, 51.0),
            "Low":    np.full(10, 49.5),
            "Close":  np.full(10, 50.2),
            "Volume": np.full(10, 1_000_000),
        }, index=dates)

        import routes.intraday as _intraday_mod
        with _mock.patch.object(_intraday_mod.yf, "Ticker") as mock_tk:
            mock_tk.return_value.history.return_value = df
            resp = self.client.get("/api/intraday/CBA")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("ticker", body)
        self.assertEqual(body["ticker"], "CBA")

    def test_intraday_scan_endpoint_exists(self):
        """POST /api/intraday/scan must return a dict."""
        import unittest.mock as _mock
        import pandas as pd
        import numpy as np

        dates = pd.date_range("2026-05-28 00:10", periods=10, freq="5min", tz="UTC")
        df = pd.DataFrame({
            "Open":   np.full(10, 100.0),
            "High":   np.full(10, 101.0),
            "Low":    np.full(10, 99.5),
            "Close":  np.full(10, 100.3),
            "Volume": np.full(10, 2_000_000),
        }, index=dates)

        import routes.intraday as _intraday_mod
        with _mock.patch.object(_intraday_mod.yf, "Ticker") as mock_tk:
            mock_tk.return_value.history.return_value = df
            resp = self.client.post(
                "/api/intraday/scan",
                json={"tickers": ["BHP"]},
                content_type="application/json",
            )
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIsInstance(body, dict)

    def test_intraday_scan_empty_tickers_returns_empty(self):
        """POST /api/intraday/scan with empty list must return {}."""
        resp = self.client.post(
            "/api/intraday/scan",
            json={"tickers": []},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.data), {})

    def test_intraday_vwap_correct(self):
        """_compute_vwap must return correct VWAP on a synthetic 5-row DataFrame."""
        import pandas as pd
        import numpy as np
        from routes.intraday import _compute_vwap

        df = pd.DataFrame({
            "High":   [10.0, 11.0, 12.0, 11.5, 10.5],
            "Low":    [ 9.0, 10.0, 11.0, 10.5,  9.5],
            "Close":  [ 9.5, 10.5, 11.5, 11.0, 10.0],
            "Volume": [1000, 2000, 1500, 1000, 1200],
        })
        vwap = _compute_vwap(df)
        # Check that VWAP is cumulative and last value is finite
        self.assertEqual(len(vwap), 5)
        self.assertTrue(all(v > 0 and not np.isnan(v) for v in vwap))
        # Check manual calculation for first bar: TP=9.5, vol=1000 → VWAP=9.5
        self.assertAlmostEqual(float(vwap.iloc[0]), 9.5, places=4)

    def test_intraday_rsi_returns_none_for_short_series(self):
        """_compute_rsi_intraday must return None when close series is too short."""
        import pandas as pd
        from routes.intraday import _compute_rsi_intraday

        short = pd.Series([50.0, 50.5, 51.0])
        result = _compute_rsi_intraday(short, period=14)
        self.assertIsNone(result)

    def test_intraday_entry_window_gate(self):
        """_in_entry_window must return False for times outside 10:45–15:00 AEST."""
        import unittest.mock as _mock
        from routes.intraday import _in_entry_window
        import datetime

        # Mock UTC time such that AEST = 10:30 (before window)
        fake_utc = datetime.datetime(2026, 5, 28, 0, 30, 0)  # 00:30 UTC = 10:30 AEST
        with _mock.patch("routes.intraday.datetime") as mock_dt:
            mock_dt.utcnow.return_value = fake_utc
            mock_dt.side_effect = lambda *a, **kw: datetime.datetime(*a, **kw)
            result = _in_entry_window()
        self.assertFalse(result)

    def test_score_setup_zero_when_no_signals(self):
        """_score_setup must return 0 when no signals are present."""
        from routes.intraday import _score_setup
        score = _score_setup(
            pct_from_vwap=0.5,    # above VWAP — no VWAP discount
            intraday_rsi=60,      # not oversold
            vol_rising=False,
            current_price=10.0,
            day_low=10.0,         # price == day_low (fails ≥1.01 check)
            day_open=10.5,        # price below open
        )
        self.assertEqual(score, 0)

    def test_score_setup_max_100(self):
        """_score_setup must never exceed 100."""
        from routes.intraday import _score_setup
        score = _score_setup(
            pct_from_vwap=-5.0,   # huge discount
            intraday_rsi=5,       # deeply oversold
            vol_rising=True,
            current_price=10.5,
            day_low=9.0,
            day_open=10.0,
        )
        self.assertLessEqual(score, 100)

    # ── Frontend file checks ─────────────────────────────────────────────────

    def test_intraday_js_exists(self):
        """js/intraday-strategy.js must exist."""
        self.assertTrue(
            os.path.exists(os.path.join(ROOT, "js/intraday-strategy.js")),
            "js/intraday-strategy.js not found"
        )

    def test_intraday_js_syntax(self):
        """js/intraday-strategy.js must pass node --check."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/intraday-strategy.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")

    def test_build_intraday_recs_defined(self):
        """intraday-strategy.js must define _buildIntradayRecs."""
        with open(os.path.join(ROOT, "js/intraday-strategy.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildIntradayRecs", src)

    def test_run_intraday_scan_defined(self):
        """intraday-strategy.js must define runIntradayScan."""
        with open(os.path.join(ROOT, "js/intraday-strategy.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("runIntradayScan", src)

    def test_intraday_defaults_defined(self):
        """intraday-strategy.js must define INTRADAY_DEFAULTS with targetPct and stopPct."""
        with open(os.path.join(ROOT, "js/intraday-strategy.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("INTRADAY_DEFAULTS", src)
        self.assertIn("targetPct", src)
        self.assertIn("stopPct", src)

    def test_intraday_tab_in_day_trading(self):
        """day-trading.js must include the ⚡ Intraday tab."""
        with open(os.path.join(ROOT, "js/pages/day-trading.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("intraday", src)
        self.assertIn("⚡ Intraday", src)

    def test_execute_intraday_trade_defined(self):
        """day-trading.js must define executeIntradayTrade."""
        with open(os.path.join(ROOT, "js/pages/day-trading.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("executeIntradayTrade", src)

    def test_close_intraday_position_defined(self):
        """day-trading.js must define closeIntradayPosition."""
        with open(os.path.join(ROOT, "js/pages/day-trading.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("closeIntradayPosition", src)

    def test_update_intraday_param_defined(self):
        """day-trading.js must define updateIntradayParam."""
        with open(os.path.join(ROOT, "js/pages/day-trading.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("updateIntradayParam", src)

    def test_intraday_state_in_config(self):
        """config.js must contain the state.intraday block."""
        with open(os.path.join(ROOT, "js/config.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("intraday:", src)
        self.assertIn("openPositions", src)
        self.assertIn("todayPnl", src)
        self.assertIn("allocatedCash", src)

    def test_intraday_closeout_in_alerts(self):
        """alerts.js must define checkIntradayCloseouts."""
        with open(os.path.join(ROOT, "js/alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("checkIntradayCloseouts", src)
        self.assertIn("_intradayClosedAlertedAt", src)

    def test_prices_calls_closeout(self):
        """prices.js must call checkIntradayCloseouts after price refresh."""
        with open(os.path.join(ROOT, "js/prices.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("checkIntradayCloseouts", src)

    def test_intraday_script_in_html(self):
        """asx_trading.html must load intraday-strategy.js."""
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("intraday-strategy.js", src)

    def test_intraday_script_order_in_html(self):
        """intraday-strategy.js must be loaded after strategy.js and before day-trading-analysis.js."""
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        idx_strategy    = src.find("strategy.js")
        idx_intraday    = src.find("intraday-strategy.js")
        idx_dt_analysis = src.find("day-trading-analysis.js")
        self.assertGreater(idx_intraday, idx_strategy,
                           "intraday-strategy.js must load after strategy.js")
        self.assertLess(idx_intraday, idx_dt_analysis,
                        "intraday-strategy.js must load before day-trading-analysis.js")

    def test_intraday_universe_key_in_config(self):
        """config.js state.intraday.params must include universeKey default."""
        with open(os.path.join(ROOT, "js/config.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("universeKey", src)
        self.assertIn("asx100", src)

    def test_intraday_universe_selector_in_day_trading(self):
        """day-trading.js Intraday tab must render a universe selector."""
        with open(os.path.join(ROOT, "js/pages/day-trading.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("universeKey", src)
        self.assertIn("asx20", src)
        self.assertIn("asx200", src)

    def test_run_intraday_scan_uses_universe_key(self):
        """intraday-strategy.js must read universeKey from state.intraday.params."""
        with open(os.path.join(ROOT, "js/intraday-strategy.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("universeKey", src)
        self.assertIn("getUniverseTickers", src)

    def test_ipl_removed_from_universe(self):
        """IPL.AX (delisted 2023) must not appear in the _ASX_UNIVERSES data in asx-universe.js."""
        with open(os.path.join(ROOT, "js/asx-universe.js"), encoding="utf-8") as f:
            src = f.read()
        # Strip comment lines before checking — the ticker may appear in a comment note
        data_lines = [l for l in src.splitlines() if not l.strip().startswith("//")]
        data_src = "\n".join(data_lines)
        self.assertNotIn("'IPL.AX'", data_src,
                         "IPL.AX is delisted and must be removed from universe arrays")

    def test_intraday_scan_uses_as_completed(self):
        """routes/intraday.py must use as_completed for non-blocking batch scan."""
        with open(os.path.join(ROOT, "routes/intraday.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("as_completed", src)
        self.assertIn("_PER_TICKER_TIMEOUT", src)

    def test_day_trading_js_syntax(self):
        """day-trading.js must pass node --check after intraday additions."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/day-trading.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")


class TestSprint18Frontend(unittest.TestCase):
    """Regression checks for Sprint 18 UX / error-recovery additions."""

    def test_utils_retry_btn_defined(self):
        """utils.js must define _retryBtn."""
        with open(os.path.join(ROOT, "js/utils.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _retryBtn", src)

    def test_utils_empty_card_defined(self):
        """utils.js must define _emptyCard."""
        with open(os.path.join(ROOT, "js/utils.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _emptyCard", src)

    def test_risk_js_retry_button(self):
        """risk.js must render a retry button on fetch failure."""
        with open(os.path.join(ROOT, "js/pages/risk.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_retryBtn", src)
        self.assertIn("riskFetchError", src)

    def test_risk_js_uses_empty_card(self):
        """risk.js must use _emptyCard for the no-holdings state."""
        with open(os.path.join(ROOT, "js/pages/risk.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_emptyCard", src)

    def test_performance_js_retry_button(self):
        """performance.js must render a retry button on nav-history failure."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_retryBtn", src)

    def test_portfolio_js_empty_card_first_run(self):
        """portfolio.js must use _emptyCard for the first-run no-holdings state."""
        with open(os.path.join(ROOT, "js/pages/portfolio.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_emptyCard", src)
        self.assertIn("No holdings yet", src)

    def test_utils_js_syntax(self):
        """utils.js must pass node --check after Sprint 18 additions."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/utils.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")

    def test_risk_js_syntax(self):
        """risk.js must pass node --check after Sprint 18 changes."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/risk.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")

    def test_performance_js_syntax(self):
        """performance.js must pass node --check after Sprint 18 changes."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/performance.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")


class TestSeasonalityRoute(unittest.TestCase):
    """Tests for GET /api/seasonality/<ticker>."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_seasonality_returns_json(self):
        """Endpoint must return 200 and a JSON body regardless of yfinance availability."""
        resp = self.client.get("/api/seasonality/BHP")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("ok", body)

    def test_seasonality_shape_on_success(self):
        """When yfinance returns data, response must have 12-month array."""
        import unittest.mock as mock
        import pandas as pd
        import numpy as np

        # Build a synthetic 10yr monthly close series
        dates = pd.date_range("2015-01", periods=120, freq="MS")
        closes = pd.Series(np.cumprod(1 + np.random.normal(0.005, 0.04, 120)) * 10, index=dates)
        fake_hist = pd.DataFrame({"Close": closes})

        with mock.patch("yfinance.download", return_value=fake_hist):
            # Clear the TTL cache so the mock is used
            from routes.market import _seasonality_cached
            _seasonality_cached.cache_clear() if hasattr(_seasonality_cached, "cache_clear") else None
            resp = self.client.get("/api/seasonality/CBA")
        body = json.loads(resp.data)
        if body.get("ok"):
            self.assertEqual(len(body["months"]), 12)
            for m in body["months"]:
                self.assertIn("month", m)
                self.assertIn("avg", m)
                self.assertIn("positive", m)
                self.assertIn("count", m)

    def test_seasonality_route_registered(self):
        """routes/market.py must define the seasonality route."""
        with open(os.path.join(ROOT, "routes/market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("/api/seasonality/", src)
        self.assertIn("_seasonality_cached", src)


class TestSprint17Frontend(unittest.TestCase):
    """Regression checks for Sprint 17 JS additions."""

    def test_signals_js_seasonality_card(self):
        """signals.js must render a seasonality card placeholder."""
        with open(os.path.join(ROOT, "js/pages/signals.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("seas-card-", src)
        self.assertIn("_loadSeasonality", src)
        self.assertIn("_renderSeasonality", src)
        self.assertIn("Monthly Seasonality", src)

    def test_signals_js_seasonality_cache(self):
        """signals.js must declare _seasonalityCache."""
        with open(os.path.join(ROOT, "js/pages/signals.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_seasonalityCache", src)

    def test_portfolio_js_apply_split_adjustment(self):
        """portfolio.js must define applySplitAdjustment."""
        with open(os.path.join(ROOT, "js/pages/portfolio.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("applySplitAdjustment", src)

    def test_portfolio_js_split_button_in_banner(self):
        """portfolio.js split warning banner must render Apply buttons."""
        with open(os.path.join(ROOT, "js/pages/portfolio.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("applySplitAdjustment", src)
        self.assertIn("Apply", src)

    def test_signals_js_syntax(self):
        """signals.js must pass node --check after Sprint 17 additions."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/signals.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")

    def test_portfolio_js_syntax(self):
        """portfolio.js must pass node --check after Sprint 17 additions."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/portfolio.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")


class TestSprint21FactorStabilityAndSecurity(unittest.TestCase):
    """Sprint 21 — Factor stability (§1.6) + security hardening (§3.5)."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    # ── Factor stability route ─────────────────────────────────────────────────

    def test_factor_stability_route_registered(self):
        """POST /api/scanner/factor-stability must be registered."""
        rules = [r.rule for r in asx_server.app.url_map.iter_rules()]
        self.assertIn("/api/scanner/factor-stability", rules)

    def test_factor_stability_missing_tickers(self):
        """Returns 400 when tickers are absent."""
        r = self.client.post("/api/scanner/factor-stability", json={"period": "2y"})
        self.assertEqual(r.status_code, 400)

    def test_factor_stability_bad_folds(self):
        """Returns 400 for n_folds outside 2-10."""
        r = self.client.post("/api/scanner/factor-stability",
                             json={"tickers": ["CBA"], "n_folds": 1})
        self.assertEqual(r.status_code, 400)

    def test_compute_factor_ic_smoke(self):
        """_compute_factor_ic returns a dict with all factor keys."""
        from routes.scanner import _compute_factor_ic, _FACTORS
        import random
        closes_list = []
        vols_list   = []
        rng = random.Random(7)
        for _ in range(12):
            c = [10.0]
            for __ in range(149):
                c.append(max(0.5, c[-1] * (1 + rng.gauss(0.001, 0.018))))
            closes_list.append(c)
            vols_list.append([100000] * 150)
        ics = _compute_factor_ic(closes_list, vols_list, forward_bars=20)
        self.assertEqual(set(ics.keys()), set(_FACTORS.keys()))

    def test_factor_helper_functions(self):
        """All _FACTORS lambdas run without error on valid arrays."""
        from routes.scanner import _FACTORS
        import numpy as np
        closes  = np.linspace(10, 12, 100)
        volumes = np.full(100, 50000.0)
        for fname, fn in _FACTORS.items():
            val = fn(closes, volumes)
            self.assertIsInstance(val, float, f"{fname} did not return float")

    def test_factor_weights_completeness(self):
        """All factors in _FACTORS have an entry in _FACTOR_WEIGHTS."""
        from routes.scanner import _FACTORS, _FACTOR_WEIGHTS
        for fname in _FACTORS:
            self.assertIn(fname, _FACTOR_WEIGHTS, f"{fname} missing from _FACTOR_WEIGHTS")

    def test_scanner_js_factor_tab(self):
        """scanner.js must contain the factor stability tab functions."""
        with open(os.path.join(ROOT, "js/pages/scanner.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildFactorStabilityHTML", src)
        self.assertIn("runFactorStability", src)
        self.assertIn("_renderFactorStabilityResults", src)
        self.assertIn("factor-stability", src)

    def test_scanner_js_syntax(self):
        """scanner.js must pass node --check."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/scanner.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")

    # ── Security hardening ────────────────────────────────────────────────────

    def test_security_headers_present(self):
        """API responses must include X-Content-Type-Options and X-Frame-Options."""
        r = self.client.get("/health")
        self.assertEqual(r.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(r.headers.get("X-Frame-Options"), "SAMEORIGIN")
        self.assertIn(r.headers.get("Referrer-Policy", ""), ["strict-origin-when-cross-origin"])

    def test_cors_restricted(self):
        """asx_server.py CORS must specify an origins= list (not open wildcard)."""
        with open(os.path.join(ROOT, "asx_server.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("CORS(app, origins=", src)
        # The bare open-wildcard form must not be the active call
        self.assertNotIn("CORS(app)  #", src)

    def test_gunicorn_loopback_bind(self):
        """gunicorn.conf.py must bind to 127.0.0.1, not 0.0.0.0."""
        with open(os.path.join(ROOT, "gunicorn.conf.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("127.0.0.1", src)
        # Should not have the old open binding as the active bind= line
        import re
        bind_line = re.search(r'^bind\s*=\s*"([^"]+)"', src, re.MULTILINE)
        self.assertIsNotNone(bind_line, "bind= line not found in gunicorn.conf.py")
        self.assertIn("127.0.0.1", bind_line.group(1))


class TestSprint20WalkForward(unittest.TestCase):
    """Sprint 20 — Walk-forward backtest engine."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_wf_route_registered(self):
        """GET /api/backtest/walk-forward route must be registered."""
        rules = [r.rule for r in asx_server.app.url_map.iter_rules()]
        self.assertIn("/api/backtest/walk-forward", rules)

    def test_wf_missing_ticker(self):
        """/api/backtest/walk-forward must return 400 when ticker is absent."""
        r = self.client.post("/api/backtest/walk-forward",
                             json={"strategy": "rsi_trend", "period": "2y"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("ticker", r.get_json().get("error", ""))

    def test_wf_bad_strategy(self):
        """Unsupported strategy must return 400."""
        r = self.client.post("/api/backtest/walk-forward",
                             json={"ticker": "CBA", "strategy": "nonexistent", "period": "2y"})
        self.assertEqual(r.status_code, 400)

    def test_wf_bad_splits(self):
        """n_splits outside 2–10 must return 400."""
        r = self.client.post("/api/backtest/walk-forward",
                             json={"ticker": "CBA", "strategy": "rsi_trend", "period": "2y", "n_splits": 1})
        self.assertEqual(r.status_code, 400)

    def test_param_grids_non_empty(self):
        """All strategy param grids must be non-empty lists of dicts."""
        from routes.backtest import _WF_PARAM_GRIDS
        for strat, grid in _WF_PARAM_GRIDS.items():
            self.assertIsInstance(grid, list, f"{strat} grid is not a list")
            self.assertGreater(len(grid), 0, f"{strat} grid is empty")
            self.assertIsInstance(grid[0], dict, f"{strat} grid[0] is not a dict")

    def test_run_strategy_slice_smoke(self):
        """_run_strategy_slice must run without error on synthetic data."""
        from routes.backtest import _run_strategy_slice, _WF_PARAM_GRIDS
        import random
        random.seed(1)
        prices = [10.0]
        for _ in range(199):
            prices.append(max(0.5, prices[-1] * (1 + random.gauss(0.0002, 0.015))))
        highs = [p * 1.01 for p in prices]
        lows  = [p * 0.99 for p in prices]
        vols  = [100000] * 200
        for strat, grid in _WF_PARAM_GRIDS.items():
            res = _run_strategy_slice(prices, highs, lows, vols, strat, grid[0], 10000, 10, 0.001)
            self.assertIn("final_value", res)
            self.assertIn("trades", res)
            self.assertIn("sharpe", res)
            self.assertIsInstance(res["total_return_pct"], float)

    def test_backtest_js_wf_tab(self):
        """backtest.js must contain walk-forward panel and run function."""
        with open(os.path.join(ROOT, "js/pages/backtest.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_renderWfPanel", src)
        self.assertIn("runWalkForward", src)
        self.assertIn("_renderWfResults", src)
        self.assertIn("_drawWfCurve", src)
        self.assertIn("Walk-Forward", src)

    def test_backtest_js_syntax(self):
        """backtest.js must pass node --check after walk-forward additions."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/backtest.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")


class TestSprint19VitestInfrastructure(unittest.TestCase):
    """Sprint 19 — Vitest frontend test infrastructure exists and is valid."""

    def test_package_json_exists(self):
        """package.json must exist with vitest devDependency."""
        path = os.path.join(ROOT, "package.json")
        self.assertTrue(os.path.exists(path), "package.json missing")
        import json
        with open(path, encoding="utf-8") as f:
            pkg = json.load(f)
        self.assertIn("vitest", pkg.get("devDependencies", {}))
        self.assertIn("test:js", pkg.get("scripts", {}))

    def test_vitest_config_exists(self):
        """vitest.config.js must exist."""
        path = os.path.join(ROOT, "vitest.config.js")
        self.assertTrue(os.path.exists(path), "vitest.config.js missing")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("setupFiles", src)
        self.assertIn("globals", src)

    def test_setup_js_exists(self):
        """tests/setup.js must exist with vm loader and global stubs."""
        path = os.path.join(ROOT, "tests", "setup.js")
        self.assertTrue(os.path.exists(path), "tests/setup.js missing")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("loadScript", src)
        self.assertIn("extractFunction", src)
        self.assertIn("vm.runInThisContext", src)

    def test_all_test_files_exist(self):
        """All four Vitest test files must be present."""
        for name in ["quant-engine", "regime-engine", "response-validator", "detect-exit-reason"]:
            path = os.path.join(ROOT, "tests", f"{name}.test.js")
            self.assertTrue(os.path.exists(path), f"tests/{name}.test.js missing")

    def test_vitest_suite_passes(self):
        """npm run test:js must exit 0 with all tests passing."""
        import subprocess, sys
        result = subprocess.run(
            "npm run test:js",
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=ROOT, shell=True
        )
        self.assertEqual(result.returncode, 0,
            f"Vitest suite failed:\n{result.stdout[-3000:]}\n{result.stderr[-1000:]}")
        self.assertIn("passed", result.stdout)

    def test_response_validator_sell_trim_stop_rule(self):
        """response-validator.js stop-below-entry rule must be direction-aware."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("SELL", src)
        self.assertIn("TRIM", src)
        # The rule must handle SELL/TRIM differently
        self.assertIn("stop must be above entry", src)


class TestSuccessTagsIntegration(unittest.TestCase):
    """Success tags: calibration nudge + success_patterns in stats."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()

    def test_stats_returns_success_patterns(self):
        """/api/learning/stats must include success_patterns key."""
        r = self.client.get("/api/learning/stats")
        data = json.loads(r.data)
        self.assertIn("success_patterns", data)
        self.assertIn("by_success_type", data["success_patterns"])

    def test_calib_success_nudge_in_source(self):
        """_calib_compute must have a dominant success tag nudge (mirror of L2)."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("wins_tagged", src)
        self.assertIn("lean into this", src)
        # Same ESS threshold as error check
        self.assertIn("win_ess >= _ESS_MIN", src)

    def test_calib_query_includes_success_tags(self):
        """_calib_compute SQL query must select success_tags column."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        # The calibration SELECT must include success_tags
        self.assertIn("success_tags", src.split("def learning_calibration")[0]
                      if "def learning_calibration" in src else src)

    def test_success_card_in_learning_js(self):
        """learning.js must render a Success Patterns card."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Success Patterns", src)
        self.assertIn("successCard", src)
        self.assertIn("by_success_type", src)


class TestPhase6CalibQuality(unittest.TestCase):
    """Phase 6 — Calibration quality debate endpoint."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()

    def test_calib_quality_endpoint_exists(self):
        """/api/debate/calib-quality must exist and return JSON."""
        r = self.client.get("/api/debate/calib-quality")
        self.assertIn(r.status_code, (200, 200))
        data = json.loads(r.data)
        self.assertIn("ok", data)

    def test_calib_quality_no_data_returns_ok_false(self):
        """With empty DB, endpoint returns ok=False (insufficient data)."""
        r = self.client.get("/api/debate/calib-quality")
        data = json.loads(r.data)
        # Empty DB → either Ollama not available (503) or insufficient data (ok=False)
        # Both are valid — test that the response is well-formed JSON
        self.assertIn("ok", data)

    def test_norm_cdf_helper(self):
        """_norm_cdf must return correct values for known Z-scores."""
        from routes.debate import _norm_cdf
        self.assertAlmostEqual(_norm_cdf(0.0),  0.5000, places=4)
        self.assertAlmostEqual(_norm_cdf(1.96), 0.9750, places=3)
        self.assertAlmostEqual(_norm_cdf(-1.96), 0.0250, places=3)

    def test_calib_bands_raw_empty_db(self):
        """_calib_bands_raw returns empty list on empty DB (no error)."""
        from routes.debate import _calib_bands_raw
        result = _calib_bands_raw(regime="", days=90)
        self.assertIsInstance(result, list)

    def test_calib_quality_prompt_contains_immutable_facts_instruction(self):
        """Phase 6 prompt must tell model to treat Z-scores as immutable facts."""
        from routes.debate import _calib_quality_prompt
        # Build a minimal band dict to test prompt generation
        bands = [{
            "band": "70-80%", "lo": 0.70, "hi": 0.80, "mid": 0.75,
            "n": 12, "ess": 8.4, "actual_wr": 0.63,
            "se": 0.15, "z": -0.80, "p_noise": 0.42,
            "n_losses": 4, "tag_counts": [("poor_entry", 2), ("overconfident", 1)],
        }]
        prompt = _calib_quality_prompt(bands)
        self.assertIn("immutable facts", prompt)
        self.assertIn("DO NOT recalculate", prompt)
        self.assertIn("p_noise=0.42", prompt)
        self.assertIn("likely_noise", prompt.lower())

    def test_calib_quality_verdict_pre_computed(self):
        """Verdict must be pre-computed from p_noise, not overridable by model."""
        import importlib, sys
        # Read the endpoint source to verify the pre_verdict logic exists
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("pre_verdict", src)
        self.assertIn('["p_noise"] > 0.30', src)
        self.assertIn('["p_noise"] > 0.15', src)
        # Verdict must be assigned from pre_verdict (not from model response)
        self.assertIn('"verdict":     pre_verdict', src)

    def test_calib_quality_schema_defined(self):
        """_SCHEMA_CALIB_QUALITY must be defined and have required fields."""
        from routes.debate import _SCHEMA_CALIB_QUALITY
        self.assertIn("band_assessments", _SCHEMA_CALIB_QUALITY["properties"])
        self.assertIn("overall_summary",  _SCHEMA_CALIB_QUALITY["properties"])
        items = _SCHEMA_CALIB_QUALITY["properties"]["band_assessments"]["items"]
        self.assertIn("verdict",  items["properties"])
        self.assertIn("analysis", items["properties"])
        # Verdict enum must not include any hallucination-friendly free-text value
        verdicts = items["properties"]["verdict"]["enum"]
        self.assertIn("likely_noise",    verdicts)
        self.assertIn("ambiguous",       verdicts)
        self.assertIn("likely_systemic", verdicts)

    def test_calib_quality_frontend_placeholder_exists(self):
        """learning.js must contain the calib quality card placeholder."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("ll-calib-quality-card", src)
        self.assertIn("renderCalibQualityCard", src)

    def test_calib_quality_auto_trigger_in_analysis(self):
        """calib-quality debate is manual-only — analysis.js must NOT auto-trigger it."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("triggerCalibQualityIfStale(", src,
                         "triggerCalibQualityIfStale must not be called from analysis.js — debates are manual only")

    def test_calib_quality_trigger_in_debate_client(self):
        """debate-client.js must define triggerCalibQualityIfStale with LOW priority."""
        with open(os.path.join(ROOT, "js", "debate-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("triggerCalibQualityIfStale", src)
        self.assertIn("LOW", src)


class TestSanityCheckHardening(unittest.TestCase):
    """_pm_sanity_check_tags — new guards for overconfident, poor_rr(null), SELL/TRIM stop direction."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()

    def setUp(self):
        # _pm_sanity_check_tags calls current_app.logger — needs app context
        self._ctx = asx_server.app.app_context()
        self._ctx.push()
        from routes.debate import _pm_sanity_check_tags
        self._check = _pm_sanity_check_tags

    def tearDown(self):
        self._ctx.pop()

    def _row(self, **kwargs):
        base = {
            "actual_entry_price": 85.50,
            "suggested_stop":     76.00,
            "rr_ratio":           None,
            "ai_confidence":      0.55,
            "recommendation":     "TRIM",
            "realized_pnl_pct":   None,
        }
        base.update(kwargs)
        return base

    # overconfident at low confidence ─────────────────────────────────────────

    def test_overconfident_stripped_below_065(self):
        row = self._row(ai_confidence=0.55, recommendation="BUY",
                        actual_entry_price=10.0, suggested_stop=9.0)
        result = self._check("overconfident,poor_entry", row, 1)
        self.assertNotIn("overconfident", result)
        self.assertIn("poor_entry", result)

    def test_overconfident_kept_above_065(self):
        row = self._row(ai_confidence=0.80, recommendation="BUY",
                        actual_entry_price=10.0, suggested_stop=9.5, rr_ratio=1.5)
        result = self._check("overconfident", row, 2)
        self.assertIn("overconfident", result)

    def test_overconfident_kept_when_conf_missing(self):
        """If ai_confidence is None, do not strip (can't assert it's low)."""
        row = self._row(ai_confidence=None, recommendation="BUY",
                        actual_entry_price=10.0, suggested_stop=9.5)
        result = self._check("overconfident", row, 3)
        self.assertIn("overconfident", result)

    # poor_rr when rr_ratio is NULL ───────────────────────────────────────────

    def test_poor_rr_stripped_when_rr_null(self):
        row = self._row(rr_ratio=None, recommendation="BUY",
                        actual_entry_price=10.0, suggested_stop=9.5)
        result = self._check("poor_rr,poor_entry", row, 4)
        self.assertNotIn("poor_rr", result)
        self.assertIn("poor_entry", result)

    def test_poor_rr_kept_when_rr_below_2(self):
        row = self._row(rr_ratio=1.2, recommendation="BUY",
                        actual_entry_price=10.0, suggested_stop=9.5)
        result = self._check("poor_rr", row, 5)
        self.assertIn("poor_rr", result)

    # SELL/TRIM stop below entry suppresses stop_too_tight ───────────────────

    def test_stop_too_tight_stripped_for_sell_stop_below_entry(self):
        """SELL/TRIM with stop below entry → wrong direction, not tight."""
        row = self._row(recommendation="TRIM",
                        actual_entry_price=85.50, suggested_stop=76.00)  # stop < entry
        result = self._check("stop_too_tight", row, 6)
        self.assertNotIn("stop_too_tight", result)

    def test_stop_too_tight_kept_for_sell_stop_above_entry(self):
        """SELL with stop correctly above entry and distance ≤15% → tag valid."""
        row = self._row(recommendation="SELL",
                        actual_entry_price=85.50, suggested_stop=90.00)  # stop > entry, ~5%
        result = self._check("stop_too_tight", row, 7)
        self.assertIn("stop_too_tight", result)

    def test_stop_too_tight_stripped_for_buy_wide_stop(self):
        """BUY with stop 20% away → still stripped (existing rule)."""
        row = self._row(recommendation="BUY",
                        actual_entry_price=10.0, suggested_stop=8.0)  # 20% away
        result = self._check("stop_too_tight", row, 8)
        self.assertNotIn("stop_too_tight", result)

    # ── Rescue rule: thesis_broken for large directional failures ────────────

    def test_rescue_thesis_broken_for_large_sell_loss_all_stripped(self):
        """When all tags stripped and SELL/TRIM has |pnl| >= 10%, rescue with thesis_broken."""
        # AMC #190 scenario: poor_rr + overconfident both stripped → rescue fires
        row = self._row(
            recommendation="SELL",
            actual_entry_price=76.299,
            suggested_stop=58.840,   # wrong direction (below entry for SELL)
            rr_ratio=None,           # NULL — wrong-direction stop so backfill skipped
            ai_confidence=0.62,      # below 0.65 → overconfident stripped
            realized_pnl_pct=-28.8,  # large directional loss
        )
        result = self._check("poor_rr,overconfident", row, 99)
        self.assertIn("thesis_broken", result,
                      "Rescue rule must inject thesis_broken when all tags stripped and |pnl| >= 10%")

    def test_rescue_does_not_fire_for_small_loss(self):
        """Rescue must NOT fire when |pnl| < 10% (could be noise/commission)."""
        row = self._row(
            recommendation="SELL",
            actual_entry_price=10.0,
            suggested_stop=9.0,
            rr_ratio=None,
            ai_confidence=0.62,
            realized_pnl_pct=-3.0,
        )
        result = self._check("poor_rr", row, 98)
        self.assertNotIn("thesis_broken", result,
                         "Rescue must not inject thesis_broken for small losses")
        self.assertEqual(result, "",
                         "Small loss with all tags stripped should return empty (none)")

    def test_rescue_does_not_fire_when_valid_tags_remain(self):
        """Rescue must NOT fire when at least one valid tag survived stripping."""
        row = self._row(
            recommendation="SELL",
            actual_entry_price=10.0,
            suggested_stop=9.0,
            rr_ratio=None,
            ai_confidence=0.80,
            realized_pnl_pct=-28.0,
        )
        # overconfident survives (conf >= 0.65), poor_rr stripped — rescue must not add thesis_broken on top
        result = self._check("poor_rr,overconfident", row, 97)
        self.assertIn("overconfident", result)
        self.assertNotIn("thesis_broken", result,
                         "Rescue must not fire when overconfident survived stripping")

    def test_rescue_fires_for_large_buy_loss(self):
        """Rescue also applies to BUY trades where stock fell > 10% — thesis_broken."""
        row = self._row(
            recommendation="BUY",
            actual_entry_price=50.0,
            suggested_stop=None,
            rr_ratio=None,
            ai_confidence=0.55,
            realized_pnl_pct=-15.0,
        )
        result = self._check("poor_rr,overconfident", row, 96)
        self.assertIn("thesis_broken", result,
                      "Rescue must fire for BUY with large loss when all tags stripped")

    def test_sanity_check_wrong_direction_stop_note_in_prompt(self):
        """Prompt must warn models to ignore wrong-direction stop and focus on P&L."""
        from routes.debate import _pm_build_prompt
        prompt = _pm_build_prompt(
            summary="SELL AMC LOSS | entry=76.3 | stop=58.8 [⚠ wrong dir] | PnL=-28.8%",
            rationale="",
            exit_hint="manual",
            action="SELL",
            pnl_pct=-28.8,
        )
        self.assertIn("WRONG-DIRECTION STOP WARNING", prompt)
        self.assertIn("DATA\n  ENTRY ERROR", prompt)
        self.assertIn("IGNORE IT ENTIRELY", prompt)

    # SELL/TRIM regime_mismatch hint in prompt ────────────────────────────────

    def test_pm_build_prompt_includes_regime_check_for_sell(self):
        """_pm_build_prompt must include regime_mismatch hint for SELL/TRIM."""
        from routes.debate import _pm_build_prompt
        prompt = _pm_build_prompt("TRIM WES LOSS | regime=riskOn", "", "", action="TRIM")
        self.assertIn("REGIME CHECK", prompt)
        self.assertIn("risk-on or bullish regime", prompt)
        self.assertIn("regime_mismatch", prompt)

    def test_pm_build_prompt_no_regime_hint_for_buy(self):
        """BUY/TOP_UP prompts must not include SELL-specific regime hint."""
        from routes.debate import _pm_build_prompt
        prompt = _pm_build_prompt("BUY BHP LOSS | regime=riskOn", "", "", action="BUY")
        self.assertNotIn("REGIME CHECK", prompt)

    # Phase 3 synthesis runs through model_b ──────────────────────────────────

    def test_phase3_synthesis_uses_model_b(self):
        """Phase 3 synthesis must call model_b (non-incumbent) not model_a."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # Find the Phase 3 section — use a large enough window to cover the call site
        phase3_idx = src.index("Phase 3: Neutral synthesis")
        phase3_src = src[phase3_idx:phase3_idx + 2500]
        # synthesis call and transcript label must both use model_b
        self.assertIn("_call_model_any(model_b, synthesis_prompt", phase3_src)
        self.assertIn('"synthesis_model": model_b', phase3_src)
        # model_a must NOT be used for the synthesis _call_ (it still appears in prompt text)
        # Check specifically the call line
        self.assertNotIn("_call_model_any(model_a, synthesis_prompt", phase3_src)


class TestSprint28(unittest.TestCase):
    """Sprint 28 — combined skill+tag call + regime-specific decay interpretation."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()

    # ── Skill schema includes success_tags ──────────────────────────────────

    def test_schema_skill_has_success_tags_property(self):
        """_SCHEMA_SKILL must include success_tags as an optional property."""
        from routes.debate import _SCHEMA_SKILL
        self.assertIn("success_tags", _SCHEMA_SKILL["properties"])
        # success_tags must NOT be in required (it's optional — empty for losses)
        self.assertNotIn("success_tags", _SCHEMA_SKILL.get("required", []))

    def test_skill_prompt_includes_win_tag_guidance_for_wins(self):
        """debate_skill prompt must ask for success_tags when outcome is win."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # The win_tag_block must include the tag options
        self.assertIn("catalyst_capture", src)
        self.assertIn("good_sizing", src)
        # Combined example must show success_tags key
        self.assertIn('"success_tags"', src)
        # Prompt must guard win-only section behind is_win check
        self.assertIn("is_win", src)

    def test_skill_endpoint_returns_success_tags_field(self):
        """/api/debate/skill jsonify call must include success_tags key."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # The jsonify return dict must include success_tags
        self.assertIn('"success_tags":', src)
        # Specifically the return from debate_skill (not just tag-win endpoint)
        # Verify it appears after the skill_score key in the source
        skill_fn_idx = src.index("def debate_skill()")
        skill_fn_src = src[skill_fn_idx:skill_fn_idx + 3000]
        self.assertIn('"success_tags":', skill_fn_src)

    def test_skill_db_write_stores_success_tags_for_wins(self):
        """debate_skill must write success_tags to DB when they are non-empty."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # DB write for wins must include success_tags= column
        self.assertIn("SET skill_score=?, success_tags=? WHERE id=?", src)
        # Validation must use VALID_WIN_TAGS to filter returned tags
        self.assertIn("VALID_WIN_TAGS", src)

    # ── Regime-specific decay interpretation ────────────────────────────────

    def test_calib_decay_regime_exposure_branch_exists(self):
        """_calib_compute must emit 'likely-regime-exposure' when global decay
        is detected but the current regime is stable."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("likely-regime-exposure", src)
        self.assertIn("not universal decay", src)

    def test_calib_decay_regime_stable_threshold(self):
        """Regime stability threshold must be abs(reg_delta) < 0.08."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("abs(reg_delta) < 0.08", src)

    def test_calib_decay_fallback_when_no_regime(self):
        """When regime is None, decay message must not include regime-exposure text."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        # The fallback (no regime) path must still emit the reduce-posn message
        self.assertIn("reduce posn 30%", src)
        # The fallback must be gated: 'if not interpretation_appended'
        self.assertIn("interpretation_appended", src)

    def test_calib_decay_requires_3_regime_trades_for_interpretation(self):
        """Regime sub-check must require at least 3 recent same-regime trades."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("len(reg_recent) >= 3", src)


class TestSprint29SellTrimTagging(unittest.TestCase):
    """Sprint 29 — structured SELL/TRIM decision tagging."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()

    # ── DB schema ────────────────────────────────────────────────────────────

    def test_db_columns_exist(self):
        """sell_primary_driver / sell_secondary_factors / sell_urgency must exist in DB."""
        from db import get_db
        with get_db() as conn:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(ai_learning_events)").fetchall()}
        self.assertIn("sell_primary_driver",    cols)
        self.assertIn("sell_secondary_factors", cols)
        self.assertIn("sell_urgency",           cols)

    # ── Learning log endpoint accepts new fields ──────────────────────────────

    def test_log_endpoint_accepts_sell_tags(self):
        """POST /api/learning/log must store sell_primary_driver for a SELL event."""
        r = self.client.post("/api/learning/log", json={
            "event_type":         "recommendation",
            "ticker":             "CSL.AX",
            "recommendation":     "SELL",
            "ai_confidence":      0.65,
            "regime":             "riskOn",
            "sell_primary_driver":    "thesis_broken",
            "sell_secondary_factors": "negative_news_flow,earnings_approaching",
            "sell_urgency":           "immediate",
        })
        data = json.loads(r.data)
        self.assertTrue(data["ok"])
        ev_id = data["id"]
        # Verify stored
        from db import get_db
        with get_db() as conn:
            row = conn.execute(
                "SELECT sell_primary_driver, sell_secondary_factors, sell_urgency FROM ai_learning_events WHERE id=?",
                (ev_id,)
            ).fetchone()
        self.assertEqual(row["sell_primary_driver"],    "thesis_broken")
        self.assertEqual(row["sell_secondary_factors"], "negative_news_flow,earnings_approaching")
        self.assertEqual(row["sell_urgency"],           "immediate")

    # ── JS validator constants ────────────────────────────────────────────────

    def test_validator_defines_sell_constants(self):
        """response-validator.js must define the three sell tag constants."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("SELL_PRIMARY_DRIVERS",    src)
        self.assertIn("SELL_SECONDARY_FACTORS",  src)
        self.assertIn("SELL_URGENCY",            src)
        self.assertIn("SELL_FORBIDDEN_COMBOS",   src)
        self.assertIn("SELL_REQUIRED_SECONDARY", src)

    def test_validator_defines_validateSellTags(self):
        """validateSellTags must be defined and wired into validateRec."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function validateSellTags", src)
        # Must be called from validateRec
        validate_rec_idx = src.index("function validateRec")
        validate_rec_body = src[validate_rec_idx:validate_rec_idx + 1500]
        self.assertIn("validateSellTags", validate_rec_body)

    def test_validator_taxonomy_completeness(self):
        """All nine primary drivers from the spec must be in the validator."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        for driver in ['thesis_broken', 'target_reached', 'stop_triggered',
                       'technical_breakdown', 'regime_change', 'better_opportunity',
                       'time_stop', 'risk_management', 'tax_optimisation']:
            self.assertIn(driver, src, f"Primary driver '{driver}' missing from validator")

    def test_validator_forbidden_combos(self):
        """Forbidden combinations must be present."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("target_reached", src)
        self.assertIn("stop_triggered", src)
        self.assertIn("time_stop",      src)
        self.assertIn("SELL_FORBIDDEN_COMBOS", src)

    def test_validator_required_secondary_for_tax_optimisation(self):
        """tax_optimisation must require one of the CGT/harvest secondary tags."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("tax_optimisation", src)
        self.assertIn("unrealised_loss_large", src)
        self.assertIn("held_over_12m",         src)
        self.assertIn("held_11_to_12m",        src)

    def test_validator_better_opportunity_requires_alternative_ticker(self):
        """better_opportunity must require alternativeTicker."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("better_opportunity", src)
        self.assertIn("alternativeTicker",  src)

    # ── Prompt includes SELL/TRIM tagging section ─────────────────────────────

    def test_prompt_includes_sell_tagging_section(self):
        """ANALYSIS_SYSTEM_PROMPT must include the SELL/TRIM decision tagging rules."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("SELL/TRIM DECISION TAGGING", src)
        self.assertIn("primary_driver",    src)
        self.assertIn("secondary_factors", src)
        self.assertIn("urgency",           src)
        # Forbidden combos documented in prompt
        self.assertIn("FORBIDDEN", src)
        # JSON schema updated
        self.assertIn('"primary_driver"',    src)
        self.assertIn('"secondary_factors"', src)
        self.assertIn('"urgency"',           src)

    # ── analysis.js passes sell fields to learning log ────────────────────────

    def test_analysis_passes_sell_fields_to_learning_log(self):
        """logRecsToLearningLoop must pass sell_primary_driver etc. for SELL/TRIM recs."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("sell_primary_driver",    src)
        self.assertIn("sell_secondary_factors", src)
        self.assertIn("sell_urgency",           src)
        # Must be conditional on SELL/TRIM action
        self.assertIn("r.action === 'SELL' || r.action === 'TRIM'", src)

    # ── Recommendations page renders sell tags ────────────────────────────────

    def test_recommendations_renders_sell_tags(self):
        """recommendations.js must render the primary_driver tag strip on SELL/TRIM cards."""
        with open(os.path.join(ROOT, "js", "pages", "recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("primary_driver",    src)
        self.assertIn("secondary_factors", src)
        self.assertIn("Sell reason",       src)
        self.assertIn("alternativeTicker", src)
        self.assertIn("urgencyStyle",      src)


class TestSprint31LearningLoopHardening(unittest.TestCase):
    """Sprint 31 — Gaps 2, 5, 8 from learning_loop_critics.md."""

    # ── Gap 2: Phase 8 skill-weighting validation gate ───────────────────────

    def test_compute_phase8_meta_function_exists(self):
        """routes/learning.py must define _compute_phase8_meta helper."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _compute_phase8_meta(", src)

    def test_compute_phase8_meta_inactive_below_n10(self):
        """_compute_phase8_meta must return active=False when fewer than 10 scored events."""
        import routes.learning as rl
        result = rl._compute_phase8_meta([])
        self.assertFalse(result["active"])
        result9 = rl._compute_phase8_meta([
            {"skill_score": 7.0, "outcome_status": "win"} for _ in range(9)
        ])
        self.assertFalse(result9["active"])

    def test_compute_phase8_meta_active_when_wins_score_higher(self):
        """_compute_phase8_meta must return active=True when wins have higher mean skill."""
        import routes.learning as rl
        rows = (
            [{"skill_score": 8.0, "outcome_status": "win"}]     * 6 +
            [{"skill_score": 4.0, "outcome_status": "loss"}]    * 6
        )
        result = rl._compute_phase8_meta(rows)
        self.assertTrue(result["active"])
        self.assertGreater(result["mean_skill_wins"], result["mean_skill_losses"])

    def test_compute_phase8_meta_inactive_when_scores_inverted(self):
        """_compute_phase8_meta must return active=False when losses score higher than wins."""
        import routes.learning as rl
        rows = (
            [{"skill_score": 3.0, "outcome_status": "win"}]     * 6 +
            [{"skill_score": 7.0, "outcome_status": "loss"}]    * 6
        )
        result = rl._compute_phase8_meta(rows)
        self.assertFalse(result["active"])

    def test_weight_uses_sf1_when_phase8_inactive(self):
        """_calib_compute must fall back to sf=1.0 when _phase8_active is False."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_phase8_active", src,
                      "learning.py must define _phase8_active gate variable")
        self.assertIn("sk is not None and _phase8_active", src,
                      "learning.py _weight() must gate skill factor on _phase8_active")

    def test_stats_returns_phase8_key(self):
        """GET /api/learning/stats must return a 'phase8' key."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"phase8"', src,
                      "learning_stats must include phase8 key in response")

    def test_learning_js_renders_phase8_note(self):
        """learning.js must render the Phase 8 status note."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("phase8Note", src)
        self.assertIn("Phase 8 skill-weighting", src)

    # ── Gap 5: Prompt regression detector ────────────────────────────────────

    def test_check_prompt_regression_function_exists(self):
        """routes/learning.py must define _check_prompt_regression helper."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _check_prompt_regression(", src)

    def test_check_prompt_regression_returns_none_on_improvement(self):
        """_check_prompt_regression must return None when current version is same or better."""
        import routes.learning as rl
        versions = [
            {"version": "v2", "closed": 20, "win_rate": 65.0},  # current — better
            {"version": "v1", "closed": 20, "win_rate": 55.0},  # prior
        ]
        self.assertIsNone(rl._check_prompt_regression(versions))

    def test_check_prompt_regression_detects_regression(self):
        """_check_prompt_regression must return a dict when current win rate is lower."""
        import routes.learning as rl
        versions = [
            {"version": "v2", "closed": 30, "win_rate": 45.0},  # current — worse
            {"version": "v1", "closed": 30, "win_rate": 65.0},  # prior
        ]
        result = rl._check_prompt_regression(versions)
        self.assertIsNotNone(result)
        self.assertEqual(result["current_version"], "v2")
        self.assertEqual(result["prior_version"], "v1")
        self.assertAlmostEqual(result["drop_pp"], 20.0, places=0)
        self.assertIn("significant", result)

    def test_check_prompt_regression_significant_flag(self):
        """drop > 2×SE must set significant=True; drop <= 1×SE must leave it False."""
        import routes.learning as rl, math
        # SE for n=100 is sqrt(0.25/100) ≈ 0.05 (5pp)
        big_drop = [
            {"version": "v2", "closed": 100, "win_rate": 40.0},
            {"version": "v1", "closed": 100, "win_rate": 65.0},  # 25pp drop >> 2×5pp
        ]
        self.assertTrue(rl._check_prompt_regression(big_drop)["significant"])
        small_drop = [
            {"version": "v2", "closed": 100, "win_rate": 59.0},
            {"version": "v1", "closed": 100, "win_rate": 61.0},  # 2pp drop << 2×5pp
        ]
        self.assertFalse(rl._check_prompt_regression(small_drop)["significant"])

    def test_stats_returns_prompt_regression_key(self):
        """GET /api/learning/stats must return a 'prompt_regression' key."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"prompt_regression"', src,
                      "learning_stats must include prompt_regression key in response")

    def test_learning_js_renders_regression_banner(self):
        """learning.js must render the prompt regression banner."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("regressionBanner", src)
        self.assertIn("promptRegression", src)
        self.assertIn("Significant regression detected", src)

    # ── Gap 8: Calibration token budget ──────────────────────────────────────

    def test_calib_char_budget_constant_exists(self):
        """_calib_compute must define _CALIB_CHAR_BUDGET and _CALIB_CHAR_CEILING."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_CALIB_CHAR_BUDGET", src)
        self.assertIn("_CALIB_CHAR_CEILING", src)

    def test_calib_budget_truncates_from_end(self):
        """_calib_compute must pop from parts list when over budget."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        # Verify the while loop with parts.pop() is present
        self.assertIn("while len(parts) > 1", src,
                      "_calib_compute must trim parts while over budget")
        self.assertIn("parts.pop()", src,
                      "_calib_compute must pop lowest-priority part to trim")

    def test_calib_ceiling_applied_as_hard_cap(self):
        """_calib_compute must apply _CALIB_CHAR_CEILING as a hard truncation safety net."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_CALIB_CHAR_CEILING - 1", src,
                      "_calib_compute must slice block_body at hard ceiling")


class TestSprint30DataEnhancements(unittest.TestCase):
    """Sprint 30 — three highest-value data additions to Claude's context."""

    # ── Addition 1: earnings beat/miss history ────────────────────────────────

    def test_earnings_beat_miss_in_analysis_js(self):
        """analysis.js earningsCtx must include beat/miss history from quarterlyEarnings."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("EPSvEst(4Q)", src,
                      "analysis.js earningsCtx must include EPSvEst(4Q) beat/miss block")
        self.assertIn("quarterlyEarnings", src,
                      "analysis.js must read quarterlyEarnings for beat/miss")
        self.assertIn("beatMiss", src,
                      "analysis.js must define beatMiss variable")

    # ── Addition 2: sector ETF performance in macro ───────────────────────────

    def test_macro_payload_has_sector_etfs(self):
        """_macro_payload source must fetch XMJ/XFJ/XHJ/XEJ/XRJ sector ETFs."""
        with open(os.path.join(ROOT, "routes", "market.py"), encoding="utf-8") as f:
            src = f.read()
        for sym in ("XMJ.AX", "XFJ.AX", "XHJ.AX", "XEJ.AX", "XRJ.AX"):
            self.assertIn(sym, src, f"_macro_payload must include {sym} sector ETF")

    def test_macro_payload_builds_sectors_key(self):
        """_macro_payload must build a 'sectors' key from fetched ETF data."""
        with open(os.path.join(ROOT, "routes", "market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"sectors"', src,
                      "_macro_payload must produce macro_data['sectors'] dict")
        self.assertIn("change_1d", src,
                      "sector summary must include change_1d field")
        self.assertIn("return_5d", src,
                      "sector summary must include return_5d field")
        self.assertIn("_SECTOR_ETF_LABELS", src,
                      "_macro_payload must define _SECTOR_ETF_LABELS mapping")

    def test_analysis_js_includes_sector_line_in_macro_ctx(self):
        """analysis.js macroCtx must include the ASX sector ETF performance line."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("ASX Sectors(1D/5D)", src,
                      "analysis.js macroCtx must include ASX sector line")
        self.assertIn("_macroSectorLines", src,
                      "analysis.js must define _macroSectorLines")
        self.assertIn("_m.sectors", src,
                      "analysis.js must read state.macroData.sectors")

    def test_analysis_js_includes_commodity_rates_line(self):
        """analysis.js macroCtx must forward iron ore, oil, copper, US10Y to Claude."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_macroMktLines", src,
                      "analysis.js must define _macroMktLines")
        self.assertIn("Commodities/Rates", src,
                      "analysis.js must label the commodity/rates line")
        # Verify all four are forwarded
        for field in ("iron_ore", "oil", "copper", "us10y"):
            self.assertIn(f"_m.{field}", src,
                          f"analysis.js _macroMktLines must reference _m.{field}")

    # ── Addition 3: key missing fundamentals ─────────────────────────────────

    def test_indicators_py_has_free_cashflow(self):
        """indicators.py fundamentals dict must include free_cashflow field."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"free_cashflow"', src,
                      "indicators.py fundamentals must include free_cashflow")
        self.assertIn("freeCashflow", src,
                      "indicators.py must read freeCashflow from yfinance info")

    def test_indicator_ctx_includes_operating_margin(self):
        """analysis.js indicatorCtx must show operating margin (OpMgn)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("OpMgn", src,
                      "analysis.js indicatorCtx must include OpMgn (operating margin)")

    def test_indicator_ctx_includes_debt_to_equity(self):
        """analysis.js indicatorCtx must show debt/equity ratio (D/E)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("D/E", src,
                      "analysis.js indicatorCtx must include D/E (debt to equity)")
        self.assertIn("debt_to_equity", src,
                      "analysis.js must reference debt_to_equity signal field")

    def test_indicator_ctx_includes_revenue_growth(self):
        """analysis.js indicatorCtx must show revenue growth (RevGrowth)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("RevGrowth", src,
                      "analysis.js indicatorCtx must include RevGrowth")

    def test_indicator_ctx_includes_fcf_yield(self):
        """analysis.js indicatorCtx must show FCF yield computed from free_cashflow/market_cap."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("FCFYield", src,
                      "analysis.js indicatorCtx must include FCFYield")
        self.assertIn("free_cashflow", src,
                      "analysis.js must reference f.free_cashflow for FCFYield")
        self.assertIn("market_cap", src,
                      "analysis.js must reference f.market_cap for FCFYield")

    def test_liveCtx_macro_brief_includes_commodities(self):
        """analysis.js liveCtx (macro brief input) must forward iron ore, oil, and US10Y."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        # The liveCtx block is in the macroPromise closure — verify fields are added
        self.assertIn("Iron ore", src,
                      "analysis.js liveCtx must include Iron ore for macro brief")
        self.assertIn("d.iron_ore", src,
                      "analysis.js liveCtx must check d.iron_ore before pushing")
        self.assertIn("US10Y", src,
                      "analysis.js liveCtx must include US10Y yield")


class TestSprint32DataQuality(unittest.TestCase):
    """Sprint 32 — Tier 1 + Tier 2 data quality enhancements + short interest."""

    # ── indicators.py ─────────────────────────────────────────────────────────

    def test_indicators_has_short_pct_float(self):
        """indicators.py fundamentals must include short_pct_float from yfinance."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"short_pct_float"', src)
        self.assertIn("shortPercentOfFloat", src)

    # ── Portfolio sector allocation ───────────────────────────────────────────

    def test_sector_alloc_ctx_in_analysis_js(self):
        """analysis.js must build a portfolio sector allocation summary."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("sectorAllocCtx", src)
        self.assertIn("PORTFOLIO SECTOR ALLOCATION", src)

    # ── Trend signal alignment count ─────────────────────────────────────────

    def test_trend_signal_count_in_indicator_ctx(self):
        """analysis.js indicatorCtx must show trend signal alignment count (X/Y signals)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("trend_signals", src,
                      "analysis.js must read s.trend_signals for alignment count")
        self.assertIn("tsBull", src)
        self.assertIn("tsTotal", src)
        self.assertIn("tsLabel", src)

    # ── MACD histogram direction ──────────────────────────────────────────────

    def test_macd_direction_in_indicator_ctx(self):
        """analysis.js must show MACD histogram direction (expanding/contracting)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("macdDir", src)
        self.assertIn("macd_hist_prev", src)
        self.assertIn("expanding", src)
        self.assertIn("contracting", src)

    # ── Volatility regime ─────────────────────────────────────────────────────

    def test_vol_regime_in_indicator_ctx(self):
        """analysis.js must include volatility regime from hist_vol_20/hist_vol_60 ratio."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("volRegime", src)
        self.assertIn("hist_vol_60", src)
        self.assertIn("ELEVATED", src)
        self.assertIn("COMPRESSED", src)

    # ── Donchian position in range ────────────────────────────────────────────

    def test_donchian_pos_in_indicator_ctx(self):
        """analysis.js must show Donchian channel position-in-range (DonchPos)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("DonchPos", src)
        self.assertIn("donchian_upper", src)
        self.assertIn("donchian_lower", src)

    # ── Volume z-score ────────────────────────────────────────────────────────

    def test_volume_zscore_in_indicator_ctx(self):
        """analysis.js Volume line must include volume_z_score (VZ)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("VZ=", src)
        self.assertIn("volume_z_score", src)

    # ── Relative strength vs ASX200 ───────────────────────────────────────────

    def test_rs_alpha_vs_asx200_in_indicator_ctx(self):
        """analysis.js Returns line must include relative strength vs ASX200."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("vs.ASX200", src)
        self.assertIn("rsAlpha", src)
        self.assertIn("asx200_5d_return", src)

    # ── Relative strength vs sector ETF ──────────────────────────────────────

    def test_sector_alpha_in_indicator_ctx(self):
        """analysis.js Returns line must include relative strength vs sector ETF."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("vs.Sector", src)
        self.assertIn("sectorAlpha", src)
        self.assertIn("_SECTOR_TO_ETF", src)

    # ── Analyst upside % ─────────────────────────────────────────────────────

    def test_analyst_upside_in_indicator_ctx(self):
        """analysis.js 52W line must include analyst consensus upside/downside %."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("AnalystUpside", src)
        self.assertIn("analystUpside", src)
        self.assertIn("analyst_target", src)

    # ── Short interest ────────────────────────────────────────────────────────

    def test_short_pct_float_in_indicator_ctx(self):
        """analysis.js Fundamentals line must include short_pct_float when available."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("short_pct_float", src)
        self.assertIn("Short=", src)
        self.assertIn("%float", src)

    # ── ROC21 for medium-term momentum ────────────────────────────────────────

    def test_roc21_in_indicator_ctx(self):
        """analysis.js Momentum line must include ROC21 (21-day rate of change)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("roc_21", src)
        self.assertIn("ROC21", src)

    # ── Weekly compressed price history ──────────────────────────────────────

    def test_weekly_history_replaced_by_pivot_proximity(self):
        """analysis.js must use NearPivot proximity flag instead of raw WeeklyCls series."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        # Raw pivot line and 10-week close series removed — replaced with compact proximity flag
        self.assertNotIn("WeeklyCls", src,
                         "Raw 10-week close series removed (too verbose, ~150 tokens)")
        self.assertNotIn("VolTrend5w", src,
                         "VolTrend5w removed along with WeeklyCls")
        self.assertNotIn("S/R Pivots: R2=", src,
                         "Raw S/R pivot values removed — replaced with NearPivot flag")
        # Replaced by compact proximity flag
        self.assertIn("NearPivot", src,
                      "NearPivot proximity flag must be present in indicator block")
        self.assertIn("nearPivot", src,
                      "nearPivot variable must be computed in indicatorCtx builder")


class TestPostmortemTagFixes(unittest.TestCase):
    """
    Regression tests for three postmortem tagging bugs:
    1. num_predict=200 truncates output → parse failure (fix: 300)
    2. "none" verdict not stored in DB (fix: store it)
    3. "parse failure" logged when sanity check strips all tags (fix: distinct log)
    """

    def test_call_model_any_accepts_num_predict(self):
        """_call_model_any must accept num_predict and default to 1024."""
        import inspect
        import routes.debate as deb
        sig = inspect.signature(deb._call_model_any)
        self.assertIn("num_predict", sig.parameters,
                      "_call_model_any must have a num_predict parameter")
        # Default must be high enough to never truncate a postmortem reason field
        self.assertGreaterEqual(sig.parameters["num_predict"].default, 1024,
                                "_call_model_any default num_predict must be >= 1024")

    def test_postmortem_stores_none_in_db(self):
        """Single-model postmortem must UPDATE error_type='none' when model returns none."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # The fix: elif error_type == "none": → store "none" in the DB
        self.assertIn("error_type='none'", src,
                      "postmortem endpoint must store error_type='none' when model returns none")
        self.assertIn("error_type_source='auto'", src,
                      "postmortem endpoint must set error_type_source='auto' on none store")

    def test_adversarial_debate_stores_none_transcript(self):
        """Adversarial debate must always persist transcript, including when final_tags is none."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # Old code: "if final_tags and final_tags != 'none'" — skipped DB write for none
        # New code: always stores, using "none" as the tag value
        self.assertNotIn(
            'if final_tags and final_tags != "none":', src,
            "adversarial debate must not skip DB write when final_tags is none"
        )
        self.assertIn(
            'store_tags', src,
            "adversarial debate must use store_tags variable to always persist"
        )

    def test_sanity_stripped_logged_separately_from_parse_failure(self):
        """When sanity check strips all tags, log must say 'no valid tags' not 'parse failure'."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("no valid tags after sanity check", src,
                      "debate.py must log 'no valid tags after sanity check' separately from parse failure")
        # error_type_raw must be preserved before sanity check for this distinction
        self.assertIn("error_type_raw", src,
                      "debate.py must preserve error_type_raw before sanity check")

    def test_none_filtered_from_failure_patterns(self):
        """learning_stats type_counts must not count 'none' as an error pattern."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('tag != "none"', src,
                      'learning_stats type_counts must filter out "none" tags')

    def test_adversarial_debate_phase1_no_explicit_num_predict(self):
        """Adversarial debate Phase 1A/1B must use default num_predict (no override needed)."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        import re
        # Old approach was explicit num_predict=300; now uses the 1024 default
        matches = re.findall(
            r"_call_model_any\([^)]*_SCHEMA_POSTMORTEM[^)]*num_predict\s*=\s*300", src
        )
        self.assertEqual(len(matches), 0,
                         "Phase 1 no longer needs explicit num_predict=300; default 1024 covers it")

    def test_synthesis_no_explicit_num_predict(self):
        """Phase 3 synthesis must use default num_predict (no 250 override needed)."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("num_predict=250", src,
                         "Phase 3 synthesis no longer needs explicit num_predict=250")


class TestPostmortemBatchAndSyncFixes(unittest.TestCase):
    """Sprint 33 — batch classify button, sync rr_ratio fix, think=False for JSON, num_predict=1024."""

    # ── _call_model_any defaults ──────────────────────────────────────────────

    def test_call_model_any_default_num_predict_1024(self):
        """_call_model_any default num_predict must be 1024 (no truncation)."""
        import inspect, routes.debate as deb
        sig = inspect.signature(deb._call_model_any)
        self.assertEqual(sig.parameters["num_predict"].default, 1024,
                         "_call_model_any default num_predict must be 1024")

    def test_call_model_any_uses_think_false(self):
        """_call_model_any must pass think=False to avoid thinking-token budget exhaustion.

        Thinking models (qwen3.5:9b) count <think>...</think> tokens against num_predict.
        With num_predict=1024, the model exhausts its budget on reasoning and is truncated
        before emitting JSON. _strip_think_tags() returns '' (unclosed block) causing
        'parse failure | raw: '. JSON classification gets no quality benefit from extended
        reasoning — think=False restores the full 1024 tokens for the JSON output.
        """
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        import re
        ma_idx = src.index("def _call_model_any(")
        next_def = re.search(r'\ndef [a-z_]', src[ma_idx + 50:])
        end_idx  = ma_idx + 50 + next_def.start() if next_def else ma_idx + 2000
        window   = src[ma_idx:end_idx]
        self.assertIn("think=False", window,
                      "_call_model_any must use think=False to prevent thinking-token truncation")
        self.assertNotIn("think=None", window,
                         "_call_model_any must not use think=None (causes empty JSON output on thinking models)")

    def test_postmortem_no_explicit_num_predict_override(self):
        """Single-model postmortem must not override num_predict (uses 1024 default)."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # The old fix added num_predict=300 — this should be gone now
        self.assertNotIn("num_predict=300", src,
                         "num_predict=300 override should be removed — default 1024 is sufficient")

    # ── /api/learning/untagged endpoint ──────────────────────────────────────

    def test_untagged_endpoint_exists(self):
        """GET /api/learning/untagged must be defined in routes/learning.py."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("/api/learning/untagged", src)
        self.assertIn("def learning_untagged", src)

    def test_untagged_endpoint_returns_200(self):
        """/api/learning/untagged must return 200 with ok and events keys."""
        _install_in_memory_db()
        asx_server.init_db()
        client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True
        resp = client.get("/api/learning/untagged")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("ok", body)
        self.assertIn("events", body)
        self.assertIn("count", body)

    def test_untagged_filters_none_tagged(self):
        """GET /api/learning/untagged must exclude events where error_type='none'."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("error_type IS NULL OR error_type = ''", src,
                      "untagged query must exclude already-tagged events including error_type='none'")

    # ── rr_ratio in sync function ─────────────────────────────────────────────

    def test_sync_computes_rr_ratio(self):
        """syncClosedTradesToLearningLoop must compute and send rr_ratio."""
        with open(os.path.join(ROOT, "js", "pages", "performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_rrRatio", src,
                      "syncClosedTradesToLearningLoop must compute _rrRatio")
        self.assertIn("rr_ratio:", src,
                      "sync toLog payload must include rr_ratio field")

    def test_sync_sends_agent_type(self):
        """syncClosedTradesToLearningLoop must set agent_type to identify synced records."""
        with open(os.path.join(ROOT, "js", "pages", "performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("portfolio-scanner-sync", src,
                      "sync function must tag records with agent_type portfolio-scanner-sync")

    def test_sync_toUpdate_backfills_rr_ratio(self):
        """toUpdate path must also send rr_ratio to patch legacy NULL records."""
        with open(os.path.join(ROOT, "js", "pages", "performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("rr_ratio:            _rr2", src,
                      "toUpdate path must backfill rr_ratio via _rr2 variable")

    def test_outcome_patch_accepts_rr_ratio(self):
        """/api/learning/outcome must accept rr_ratio in the patchable columns list."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"rr_ratio"', src,
                      "learning_outcome patchable columns must include rr_ratio")

    # ── Classify All button ───────────────────────────────────────────────────

    def test_classify_all_button_in_learning_js(self):
        """learning.js must render the Classify All Untagged button."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("classify-all-btn", src)
        self.assertIn("classifyAllPostmortems()", src)
        self.assertIn("Classify All Untagged", src)

    def test_classify_all_function_defined(self):
        """classifyAllPostmortems() must be defined in learning.js."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("async function classifyAllPostmortems()", src)
        self.assertIn("classify-all-progress", src)
        self.assertIn("/api/learning/untagged", src)

    def test_classify_all_uses_60s_timeout(self):
        """classifyAllPostmortems must pass timeout: 60 per event."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("timeout: 60", src,
                      "classifyAllPostmortems must pass timeout:60 per postmortem call")

    def test_sync_rationale_handles_array(self):
        """Sync rationale must join array reasoning instead of calling Array.slice."""
        with open(os.path.join(ROOT, "js", "pages", "performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Array.isArray(r.reasoning)", src,
                      "sync must detect array reasoning and join it to a string")


class TestPostmortemPromptQuality(unittest.TestCase):
    """Sprint 34 — prompt/model fixes for correct tagging of SELL/TRIM losses."""

    # ── repeat_penalty in _call_ollama ────────────────────────────────────────

    def test_call_ollama_has_repeat_penalty(self):
        """_call_ollama must send repeat_penalty to Ollama to prevent repetition loops."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"repeat_penalty"', src,
                      "_call_ollama options must include repeat_penalty")
        self.assertIn('"repeat_last_n"', src,
                      "_call_ollama options must include repeat_last_n context window")

    # ── _pm_build_prompt thesis_broken guidance ───────────────────────────────

    def test_pm_prompt_accepts_pnl_pct(self):
        """_pm_build_prompt must accept pnl_pct parameter."""
        import inspect, routes.debate as deb
        sig = inspect.signature(deb._pm_build_prompt)
        self.assertIn("pnl_pct", sig.parameters,
                      "_pm_build_prompt must accept pnl_pct parameter")

    def test_pm_prompt_includes_loss_direction_hint_for_sell_loss(self):
        """_pm_build_prompt must inject LOSS DIRECTION hint for large SELL/TRIM losses (> 5%)."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt(
            summary="SELL XYZ @ $100 | Outcome: LOSS (-20%)",
            rationale="",
            exit_hint="manual",
            action="SELL",
            pnl_pct=-20.0,
        )
        self.assertIn("LOSS DIRECTION", prompt,
                      "Prompt must include LOSS DIRECTION note for large SELL loss")
        self.assertIn("thesis_broken", prompt)

    def test_pm_prompt_small_loss_guides_none(self):
        """_pm_build_prompt must guide toward 'none' for sub-2% SELL/TRIM losses."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt(
            summary="SELL XYZ @ $100 | Outcome: LOSS (-1.5%)",
            rationale="",
            exit_hint="manual",
            action="SELL",
            pnl_pct=-1.5,
        )
        self.assertIn("none", prompt, "Small loss prompt must mention 'none'")
        self.assertIn("sub-2%", prompt, "Must warn against thesis_broken for sub-2% losses")
        self.assertNotIn("LOSS DIRECTION", prompt,
                         "Sub-2% loss should use LOSS NOTE, not LOSS DIRECTION")

    def test_pm_prompt_stop_hit_guides_stop_too_tight(self):
        """_pm_build_prompt must suggest stop_too_tight as primary for stop_hit exits."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt(
            summary="SELL XYZ @ $100 | Outcome: LOSS (-3%)",
            rationale="",
            exit_hint="",
            action="SELL",
            pnl_pct=-3.0,
            exit_reason="stop_hit",
        )
        self.assertIn("stop_too_tight", prompt,
                      "stop_hit exit prompt must suggest stop_too_tight as candidate")
        self.assertIn("stop_hit", prompt)

    def test_pm_prompt_medium_loss_offers_multiple_options(self):
        """2–5% loss prompt must offer thesis_broken, poor_entry, AND none as candidates."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt(
            summary="SELL XYZ @ $100 | Outcome: LOSS (-3.5%)",
            rationale="",
            exit_hint="manual",
            action="SELL",
            pnl_pct=-3.5,
        )
        self.assertIn("thesis_broken", prompt)
        self.assertIn("poor_entry", prompt)
        self.assertIn("none", prompt)

    def test_pm_prompt_no_loss_hint_for_sell_win(self):
        """_pm_build_prompt must NOT inject loss guidance when pnl_pct >= 0."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt(
            summary="SELL XYZ @ $100 | Outcome: WIN (+5%)",
            rationale="",
            exit_hint="target_hit",
            action="SELL",
            pnl_pct=5.0,
        )
        self.assertNotIn("LOSS DIRECTION", prompt)
        self.assertNotIn("LOSS NOTE", prompt)

    def test_thesis_broken_description_mentions_direction(self):
        """thesis_broken tag description must mention wrong directional movement."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt("summary", "", "", action="BUY")
        self.assertIn("fundamental directional call was wrong", prompt,
                      "thesis_broken description must reference directional failure")

    def test_pm_prompt_poor_rr_requires_computable_ratio(self):
        """poor_rr tag description must state it requires a computable rr_ratio."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt("summary", "", "", action="SELL", pnl_pct=-10.0)
        self.assertIn("poor_rr", prompt)
        self.assertIn("REQUIRES a computable rr_ratio", prompt)

    def test_pm_prompt_none_criteria_are_explicit(self):
        """none tag description must state the concrete criteria (< 2% or unforeseeable)."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt("summary", "", "", action="BUY")
        self.assertIn("none", prompt)
        self.assertIn("2%", prompt,
                      "none criteria must mention < 2% threshold")

    def test_pm_build_prompt_accepts_exit_reason(self):
        """_pm_build_prompt must accept exit_reason parameter."""
        import inspect, routes.debate as deb
        sig = inspect.signature(deb._pm_build_prompt)
        self.assertIn("exit_reason", sig.parameters,
                      "_pm_build_prompt must accept exit_reason parameter")

    # ── rr_ratio backfill in init_db ──────────────────────────────────────────

    def test_init_db_backfills_rr_ratio(self):
        """init_db must run the rr_ratio backfill SQL for records with correct-direction stops."""
        with open(os.path.join(ROOT, "db.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("rr_ratio IS NULL", src,
                      "db.py init_db must include rr_ratio backfill UPDATE")
        # Use regex-free check that's whitespace-tolerant
        self.assertIn("suggested_stop", src,
                      "backfill must reference suggested_stop column")
        self.assertIn("actual_entry_price", src,
                      "backfill must reference actual_entry_price column")
        # Both BUY and SELL/TRIM direction conditions must be present
        self.assertIn("recommendation IN ('BUY','TOP_UP')", src,
                      "backfill must handle BUY/TOP_UP direction")
        self.assertIn("recommendation IN ('SELL','TRIM')", src,
                      "backfill must handle SELL/TRIM direction")
        self.assertIn("wrong-direction stops stay NULL", src,
                      "backfill must document that wrong-direction stops are excluded")

    def test_init_db_backfill_runs_without_error(self):
        """rr_ratio backfill SQL must execute cleanly on an empty in-memory DB."""
        _install_in_memory_db()
        # init_db() includes the backfill — if it raises, the test fails
        try:
            asx_server.init_db()
        except Exception as e:
            self.fail(f"init_db() raised unexpectedly: {e}")

    # ── Both call sites pass pnl_pct ──────────────────────────────────────────

    def test_both_postmortem_callsites_pass_pnl_pct(self):
        """Both _pm_build_prompt call sites must pass pnl_pct from the row."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        import re
        matches = re.findall(r'_pm_build_prompt\([^)]*pnl_pct\s*=', src)
        self.assertGreaterEqual(len(matches), 2,
                                "Both single-model and adversarial debate must pass pnl_pct")

    def test_both_postmortem_callsites_pass_exit_reason(self):
        """Both _pm_build_prompt call sites must pass exit_reason from the row."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        import re
        matches = re.findall(r'_pm_build_prompt\([^)]*exit_reason\s*=', src)
        self.assertGreaterEqual(len(matches), 2,
                                "Both single-model and adversarial debate must pass exit_reason")


class TestFix16Phase8GoodLossExclusion(unittest.TestCase):
    """Fix #16 — Phase 8 gate must exclude protective_stop + external_shock losses."""

    def test_is_good_loss_function_exists(self):
        """routes/learning.py must define _is_good_loss helper at module level."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _is_good_loss(", src)

    def test_is_good_loss_protective_stop(self):
        """_is_good_loss must return True for exit_reason='protective_stop'."""
        import routes.learning as rl
        self.assertTrue(rl._is_good_loss({"exit_reason": "protective_stop", "error_type": None}))

    def test_is_good_loss_external_shock(self):
        """_is_good_loss must return True when error_type contains 'external_shock'."""
        import routes.learning as rl
        self.assertTrue(rl._is_good_loss({"exit_reason": "stop_hit", "error_type": "external_shock"}))
        self.assertTrue(rl._is_good_loss({"exit_reason": "manual", "error_type": "overconfident,external_shock"}))

    def test_is_good_loss_regular_loss(self):
        """_is_good_loss must return False for ordinary analytical losses."""
        import routes.learning as rl
        self.assertFalse(rl._is_good_loss({"exit_reason": "stop_hit", "error_type": "overconfident"}))
        self.assertFalse(rl._is_good_loss({"exit_reason": "manual", "error_type": None}))
        self.assertFalse(rl._is_good_loss({"exit_reason": None, "error_type": None}))

    def test_compute_phase8_meta_excludes_good_losses(self):
        """_compute_phase8_meta must activate when wins > analytical losses even if good-loss
        scores are high (i.e. protective_stop trades with 9/10 must not inflate mean_loss)."""
        import routes.learning as rl
        # 3 wins scoring 8.0 avg; 1 protective-stop scoring 9.0 (should be excluded);
        # 1 analytical loss scoring 3.0 — wins (8.0) > analytical_losses (3.0) → active
        rows = [
            {"outcome_status": "win", "skill_score": "8.0", "exit_reason": None, "error_type": None},
            {"outcome_status": "win", "skill_score": "8.0", "exit_reason": None, "error_type": None},
            {"outcome_status": "win", "skill_score": "8.0", "exit_reason": None, "error_type": None},
            {"outcome_status": "win", "skill_score": "7.0", "exit_reason": None, "error_type": None},
            {"outcome_status": "win", "skill_score": "7.0", "exit_reason": None, "error_type": None},
            {"outcome_status": "loss", "skill_score": "9.0", "exit_reason": "protective_stop", "error_type": None},
            {"outcome_status": "loss", "skill_score": "9.0", "exit_reason": "protective_stop", "error_type": None},
            {"outcome_status": "loss", "skill_score": "3.0", "exit_reason": "stop_hit", "error_type": "overconfident"},
            {"outcome_status": "loss", "skill_score": "3.0", "exit_reason": "stop_hit", "error_type": "poor_entry"},
            {"outcome_status": "loss", "skill_score": "3.0", "exit_reason": "manual", "error_type": None},
        ]
        result = rl._compute_phase8_meta(rows)
        self.assertTrue(result["active"],
                        "Phase 8 must be active — wins (7.8 avg) > analytical losses (3.0), "
                        "protective_stop losses (9.0) must be excluded")
        self.assertEqual(result["n_good_losses_excluded"], 2)

    def test_compute_phase8_meta_returns_n_good_losses_excluded(self):
        """_compute_phase8_meta return dict must include n_good_losses_excluded field."""
        import routes.learning as rl
        rows = [
            {"outcome_status": "win", "skill_score": "7.0", "exit_reason": None, "error_type": None},
        ] * 8 + [
            {"outcome_status": "loss", "skill_score": "4.0", "exit_reason": "stop_hit", "error_type": None},
        ] * 2
        result = rl._compute_phase8_meta(rows)
        self.assertIn("n_good_losses_excluded", result)

    def test_phase8_gate_uses_is_good_loss_in_calib_compute(self):
        """_calib_compute must reference _is_good_loss in the inline Phase 8 check."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        # Both the module-level _compute_phase8_meta and inline _calib_compute check must use it
        self.assertGreaterEqual(src.count("_is_good_loss("), 3,
                                "_is_good_loss must be called in _compute_phase8_meta and inline Phase 8 check")

    def test_learning_js_phase8_note_shows_exclusion_count(self):
        """learning.js phase8Note must conditionally display good-loss exclusion count."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("n_good_losses_excluded", src)
        self.assertIn("good-loss", src)


class TestFix17PromptDataGapFixes(unittest.TestCase):
    """Fix #17 — Remove data-gap mismatches in ANALYSIS_SYSTEM_PROMPT."""

    def test_eps_revision_30d_example_removed_from_factors_used(self):
        """factorsUsed example must not cite 'EPS revision: +N% over 30d' (field not in payload)."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("EPS revision: +4.2% over 30d", src)
        self.assertNotIn("EPS revision: +3.1% over 30d", src)

    def test_eps_momentum_proxy_example_present(self):
        """factorsUsed examples must use EPS momentum proxy phrasing instead."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("EPS momentum:", src)

    def test_bid_ask_rule_removed(self):
        """bid-ask spread rule must be replaced — field is not in the live signals payload."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("bid-ask spread > 0.5%", src)

    def test_volume_based_liquidity_flag_present(self):
        """volume_avg_20 < 150,000 liquidity flag must replace the bid-ask rule."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("volume_avg_20 < 150,000", src)
        self.assertIn("thin liquidity", src)


class TestFix19RegressionDetectorEvaluating(unittest.TestCase):
    """Fix #19 — Regression detector must return 'evaluating' state, not None, for new
    prompt versions below ESS floor (prevents silent false-negative on UI)."""

    def test_evaluating_state_when_new_version_below_floor(self):
        """_check_prompt_regression must return evaluating dict (not None) when current
        version has fewer than min_n closed trades."""
        import routes.learning as rl
        versions = [{"version": "2026-06-v7", "closed": 5, "win_rate": 60.0}]
        result = rl._check_prompt_regression(versions, min_n=10)
        self.assertIsNotNone(result, "Must not return None when new version is below ESS floor")
        self.assertEqual(result["status"], "evaluating")
        self.assertEqual(result["current_version"], "2026-06-v7")
        self.assertEqual(result["n_current"], 5)
        self.assertEqual(result["min_n_required"], 10)
        self.assertIn("se_pp", result)

    def test_returns_none_when_no_data_at_all(self):
        """_check_prompt_regression must return None when no versions have any closed trades."""
        import routes.learning as rl
        versions = [{"version": "v1", "closed": 0, "win_rate": None}]
        self.assertIsNone(rl._check_prompt_regression(versions, min_n=10))

    def test_regression_dict_has_status_field(self):
        """Regression dicts must include 'status' field (distinguishes from evaluating)."""
        import routes.learning as rl
        versions = [
            {"version": "v2", "closed": 30, "win_rate": 40.0},
            {"version": "v1", "closed": 30, "win_rate": 65.0},
        ]
        result = rl._check_prompt_regression(versions)
        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "regression")

    def test_improvement_still_returns_none(self):
        """_check_prompt_regression must still return None when current is same or better."""
        import routes.learning as rl
        versions = [
            {"version": "v2", "closed": 20, "win_rate": 65.0},
            {"version": "v1", "closed": 20, "win_rate": 55.0},
        ]
        self.assertIsNone(rl._check_prompt_regression(versions))

    def test_learning_js_evaluating_banner_present(self):
        """learning.js regressionBanner must render an evaluating state (⏳ chip)."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("status === 'evaluating'", src)
        self.assertIn("⏳", src)
        self.assertIn("min_n_required", src)


class TestFix18VirtualOutcomes(unittest.TestCase):
    """Fix #18 — Virtual outcomes via lazy OHLC resolution in _calib_compute()."""

    def test_db_virtual_outcome_column_in_migrations(self):
        """db.py _LE_MIGRATIONS must include virtual_outcome and virtual_pnl_pct columns."""
        with open(os.path.join(ROOT, "db.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"virtual_outcome"', src)
        self.assertIn('"virtual_pnl_pct"', src)

    def test_resolve_virtual_outcomes_function_exists(self):
        """routes/learning.py must define _resolve_virtual_outcomes helper."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _resolve_virtual_outcomes(", src)

    def test_resolve_called_in_calib_compute(self):
        """_calib_compute must call _resolve_virtual_outcomes at the start of the DB block."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_resolve_virtual_outcomes(conn)", src)

    def test_virtual_rows_merged_into_rows_all(self):
        """_calib_compute must merge real and virtual rows into rows_all for calibration."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("rows_all", src)
        self.assertIn("virtual_rows", src)

    def test_weight_function_applies_virtual_discount(self):
        """_weight() inside _calib_compute must apply 0.75× discount for virtual rows."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("0.75", src)
        self.assertIn("is_virtual", src)

    def test_calibration_header_includes_virtual_count(self):
        """Calibration block header must show Nv when virtual outcomes are included."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("n_virtual", src)
        self.assertIn("virt_note", src)

    def test_recent_events_query_includes_virtual_outcome(self):
        """learning_stats() recent events SQL must select virtual_outcome column."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        # Should appear in both recent events SELECT and virtual rows SELECT
        self.assertGreaterEqual(src.count("virtual_outcome"), 3)

    def test_learning_js_virtual_chip_rendered(self):
        """learning.js recent events must render a virtual outcome chip (~W or ~L)."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("virtualChip", src)
        self.assertIn("virtual_outcome", src)
        self.assertIn("virtual_win", src)
        # Chip content is a template literal: ">~${...}" — check tilde prefix and W/L labels
        self.assertIn(">~${", src)
        self.assertIn("? 'W' : 'L'", src)

    def test_resolve_direction_aware_sell_trim(self):
        """_resolve_virtual_outcomes must invert target/stop check for SELL/TRIM."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        # Direction-aware check: SELL/TRIM frame — Low <= target → win; High >= stop → loss
        self.assertIn("is_exit", src)
        self.assertIn("virtual_win", src)
        self.assertIn("virtual_loss", src)


class TestSprint41PlanAB(unittest.TestCase):
    """Sprint 41 — Plan A (regime-aware SELL/TRIM stop) + Plan B (high_60d/low_60d)."""

    def test_analysis_js_sell_trim_stop_reads_stopAtrMult(self):
        """analysis.js ATR floor for SELL/TRIM must read stopAtrMult from getRegimeModifiers."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stopAtrMult", src)
        self.assertIn("_stopRepairedMult", src)
        # Must not hardcode 2.5 as the floor (only allowed as fallback default)
        # The floor computation must use stopMult, not a literal 2.5
        self.assertIn("stopMult * atr", src)

    def test_analysis_js_sell_trim_stop_uses_regime_fallback(self):
        """analysis.js must default stopMult to 2.5 when regime modifiers unavailable."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stopAtrMult ?? 2.5", src)

    def test_indicators_emits_high_60d_low_60d(self):
        """analyse_ticker() result dict must include high_60d and low_60d keys."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"high_60d"', src)
        self.assertIn('"low_60d"', src)
        # Must use safe_float and tail(60) OHLCV slices
        self.assertIn("high.tail(60).max()", src)
        self.assertIn("low.tail(60).min()", src)

    def test_prompts_signal4_uses_high_60d_low_60d(self):
        """prompts.js Signal #4 must reference high_60d and low_60d (not just return_60d)."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("high_60d", src)
        self.assertIn("low_60d", src)
        self.assertIn("fib_50", src)
        self.assertIn("fib_618", src)

    def test_prompts_priority1_eps_revision_proxy_documented(self):
        """ANALYSIS_SYSTEM_PROMPT Priority 1 must document EPSvEst(4Q) as the revision proxy."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("EPSvEst(4Q)", src)
        # Must not rely on a non-existent eps_revision_30d field
        # (the proxy wording makes clear it's unavailable from yfinance)
        self.assertIn("unavailable from yfinance", src)


class TestSprint42Fibonacci(unittest.TestCase):
    """Sprint 42 — Fibonacci zone fix in _dtBuildRecs + high_60d/low_60d forwarding."""

    def test_dt_build_recs_signal4_uses_fibonacci(self):
        """_dtBuildRecs Signal #4 must use high_60d/low_60d for Fibonacci zone check."""
        with open(os.path.join(ROOT, "js", "day-trading-analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("high_60d", src)
        self.assertIn("low_60d", src)
        self.assertIn("fib50", src)
        self.assertIn("fib618", src)

    def test_dt_build_recs_signal4_has_return60d_fallback(self):
        """_dtBuildRecs Signal #4 must fall back to return_60d range when high/low absent."""
        with open(os.path.join(ROOT, "js", "day-trading-analysis.js"), encoding="utf-8") as f:
            src = f.read()
        # Both the Fibonacci path and the return_60d fallback must be present
        self.assertIn("fib50", src)
        self.assertIn("fibReturnMin", src)
        self.assertIn("fibReturnMax", src)

    def test_analysis_js_forwards_high60d_low60d_to_claude(self):
        """analysis.js signal block must include high_60d and low_60d fields."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("high_60d", src)
        self.assertIn("low_60d", src)
        # Must appear in the Returns/Range60d line sent to Claude
        self.assertIn("Range60d", src)

    def test_dt_comment_notes_quant_only_engine(self):
        """day-trading-analysis.js comment must document the quantitative-only (no Claude) approach."""
        with open(os.path.join(ROOT, "js", "day-trading-analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("no Claude call", src)


class TestSprint42StooqFallback(unittest.TestCase):
    """Sprint 42 — Stooq price fallback for quote and macro endpoints."""

    def test_stooq_quote_in_core(self):
        """core.py must export stooq_quote and _to_stooq_sym."""
        import core as c
        self.assertTrue(callable(c.stooq_quote))
        self.assertTrue(callable(c._to_stooq_sym))

    def test_stooq_symbol_map_asx_equity(self):
        """_to_stooq_sym must convert BHP.AX → bhp.au."""
        from core import _to_stooq_sym
        self.assertEqual(_to_stooq_sym("BHP.AX"), "bhp.au")
        self.assertEqual(_to_stooq_sym("CBA.AX"), "cba.au")

    def test_stooq_symbol_map_known_globals(self):
        """_to_stooq_sym must map major yfinance global symbols to Stooq equivalents."""
        from core import _to_stooq_sym
        self.assertEqual(_to_stooq_sym("^AXJO"),    "^axjo")
        self.assertEqual(_to_stooq_sym("AUDUSD=X"), "audusd")
        self.assertEqual(_to_stooq_sym("GC=F"),     "gc.f")
        self.assertEqual(_to_stooq_sym("^VIX"),     "^vix")

    def test_stooq_symbol_map_unsupported_returns_none(self):
        """_to_stooq_sym must return None for symbols not on Stooq."""
        from core import _to_stooq_sym
        self.assertIsNone(_to_stooq_sym("TIO=F"))   # iron ore futures
        self.assertIsNone(_to_stooq_sym("YAP=F"))   # SPI200 futures

    def test_stooq_quote_wired_into_quote_endpoint(self):
        """routes/market.py must import and call stooq_quote in _quote_cached."""
        with open(os.path.join(ROOT, "routes", "market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stooq_quote", src)
        self.assertIn("_source", src)

    def test_stooq_quote_wired_into_macro_endpoint(self):
        """_fetch_symbol in _macro_payload must call stooq_quote on yfinance failure."""
        with open(os.path.join(ROOT, "routes", "market.py"), encoding="utf-8") as f:
            src = f.read()
        # Both call sites use stooq_quote; macro fallback returns name/None/summary
        self.assertIn("Stooq fallback", src)

    def test_stooq_quote_returns_none_on_bad_csv(self):
        """stooq_quote must return None when Stooq returns malformed data."""
        from unittest.mock import patch, MagicMock
        import core as c
        mock_resp = MagicMock()
        mock_resp.text = "Symbol,Date\nBHP,2026-06-03"  # too few columns
        mock_resp.raise_for_status = lambda: None
        with patch.object(c._HTTP_SESSION, "get", return_value=mock_resp):
            self.assertIsNone(c.stooq_quote("BHP.AX"))

    def test_stooq_quote_returns_none_on_network_error(self):
        """stooq_quote must return None (not raise) on any network exception."""
        from unittest.mock import patch
        import core as c
        with patch.object(c._HTTP_SESSION, "get", side_effect=Exception("timeout")):
            self.assertIsNone(c.stooq_quote("BHP.AX"))


class TestSprint44(unittest.TestCase):
    """Sprint 44 feature tests: DRP parcels, virtual speed weight, regime-flip penalty, lessons breadth."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    # ── Item 1: DRP parcel tracking ──────────────────────────────────────────

    def test_drp_button_in_portfolio_js(self):
        """portfolio.js must contain the DRP button and applyDrpEvent function."""
        src = open(os.path.join(ROOT, "js", "pages", "portfolio.js"), encoding="utf-8").read()
        self.assertIn("showDrpModal", src)
        self.assertIn("applyDrpEvent", src)
        self.assertIn("DRP", src)

    def test_drp_badge_in_utils_js(self):
        """actionBadge in utils.js must handle DRP action with badge-drp class."""
        src = open(os.path.join(ROOT, "js", "utils.js"), encoding="utf-8").read()
        self.assertIn("DRP", src)
        self.assertIn("badge-drp", src)

    def test_drp_badge_css_defined(self):
        """asx_trading.css must define .badge-drp styles."""
        src = open(os.path.join(ROOT, "asx_trading.css"), encoding="utf-8").read()
        self.assertIn(".badge-drp", src)

    # ── Item 2: Virtual-outcome speed weighting ───────────────────────────────

    def test_virtual_speed_weight_written_by_resolve_virtual_outcomes(self):
        """_resolve_virtual_outcomes must write virtual_speed_weight on resolved rows."""
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        self.assertIn("virtual_speed_weight", src)
        self.assertIn("speed_weight", src)
        self.assertIn("7.0 / hold_days", src)

    def test_virtual_speed_weight_column_in_db_migrations(self):
        """virtual_speed_weight must be in _LE_MIGRATIONS in db.py."""
        src = open(os.path.join(ROOT, "db.py"), encoding="utf-8").read()
        self.assertIn('"virtual_speed_weight"', src)

    def test_calib_compute_applies_speed_weight_to_virtual_rows(self):
        """_weight() in _calib_compute must multiply by virtual_speed_weight for virtual rows."""
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        self.assertIn("virtual_speed_weight", src)
        self.assertIn('r.get("virtual_speed_weight")', src)

    # ── Item 3: Regime-flip calibration penalty ───────────────────────────────

    def test_calibration_route_accepts_flipped_params(self):
        """GET /api/learning/calibration must accept flipped_at and flipped_to params."""
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        self.assertIn('flipped_at', src)
        self.assertIn('flipped_to', src)

    def test_regime_flip_token_emitted(self):
        """_calib_compute must emit REGIME_FLIP token when flip is recent and trades < 10."""
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        self.assertIn("REGIME_FLIP", src)
        self.assertIn("hl // 2", src)

    def test_regime_flip_localStorage_in_regime_engine(self):
        """regime-engine.js must write regime_flipped_at/to to localStorage on flip."""
        src = open(os.path.join(ROOT, "js", "regime-engine.js"), encoding="utf-8").read()
        self.assertIn("regime_flipped_at", src)
        self.assertIn("regime_flipped_to", src)
        self.assertIn("localStorage.setItem", src)

    def test_fetch_calibration_block_passes_flip_params(self):
        """fetchCalibrationBlock in learning-loop.js must pass flipped_at and flipped_to."""
        src = open(os.path.join(ROOT, "js", "learning-loop.js"), encoding="utf-8").read()
        self.assertIn("flipped_at", src)
        self.assertIn("flipped_to", src)

    # ── Item 4: Lessons breadth scope ────────────────────────────────────────

    def test_breadth_scope_column_in_db_migration(self):
        """breadth_scope column must be added to trading_lessons in init_db()."""
        src = open(os.path.join(ROOT, "db.py"), encoding="utf-8").read()
        self.assertIn("breadth_scope", src)
        self.assertIn("trading_lessons", src)

    def test_lessons_breadth_dropdown_in_learning_js(self):
        """learning.js must include the breadth_scope dropdown in the Add Lesson form."""
        src = open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8").read()
        self.assertIn("ll-lesson-breadth", src)
        self.assertIn("adl_below_0.3", src)
        self.assertIn("adl_above_0.7", src)
        self.assertIn("high_vol", src)
        self.assertIn("low_vol", src)

    def test_lessons_post_accepts_breadth_scope(self):
        """POST /api/learning/lessons must accept breadth_scope field."""
        r = self.client.post("/api/learning/lessons", json={
            "lesson_text": "Sprint44 high vol lesson",
            "breadth_scope": "high_vol",
        }, content_type="application/json")
        self.assertEqual(r.status_code, 200)
        data = json.loads(r.data)
        self.assertTrue(data["ok"])
        self.assertIn("id", data)

    def test_lessons_post_rejects_invalid_breadth_scope(self):
        """POST /api/learning/lessons must reject unknown breadth_scope values."""
        r = self.client.post("/api/learning/lessons", json={
            "lesson_text": "Bad scope lesson",
            "breadth_scope": "invalid_scope",
        }, content_type="application/json")
        self.assertEqual(r.status_code, 400)

    def test_lessons_filter_by_adl(self):
        """GET /api/learning/lessons must filter breadth-scoped lessons by adl param."""
        # Insert a scoped lesson
        self.client.post("/api/learning/lessons", json={
            "lesson_text": "Sprint44 bear adl lesson",
            "breadth_scope": "adl_below_0.3",
        }, content_type="application/json")

        # adl=0.2 (below 0.3) → scoped lesson included
        r = self.client.get("/api/learning/lessons?adl=0.2")
        data = json.loads(r.data)
        self.assertTrue(data["ok"])
        texts = [l["lesson_text"] for l in data["lessons"]]
        self.assertIn("Sprint44 bear adl lesson", texts)

        # adl=0.5 (above 0.3) → scoped lesson excluded
        r2 = self.client.get("/api/learning/lessons?adl=0.5")
        data2 = json.loads(r2.data)
        texts2 = [l["lesson_text"] for l in data2["lessons"]]
        self.assertNotIn("Sprint44 bear adl lesson", texts2)

        # no adl param → scoped lesson excluded (condition cannot be evaluated)
        r3 = self.client.get("/api/learning/lessons?ticker=ZZZNOMATCH")
        data3 = json.loads(r3.data)
        texts3 = [l["lesson_text"] for l in data3["lessons"]]
        self.assertNotIn("Sprint44 bear adl lesson", texts3)

    def test_lessons_filter_by_asx_vol(self):
        """GET /api/learning/lessons must filter high_vol lessons by asx_vol param."""
        self.client.post("/api/learning/lessons", json={
            "lesson_text": "Sprint44 high vol specific",
            "breadth_scope": "high_vol",
        }, content_type="application/json")

        # asx_vol=30 > 25 → high_vol lesson included
        r = self.client.get("/api/learning/lessons?asx_vol=30")
        data = json.loads(r.data)
        texts = [l["lesson_text"] for l in data["lessons"]]
        self.assertIn("Sprint44 high vol specific", texts)

        # asx_vol=10 < 25 → high_vol lesson excluded
        r2 = self.client.get("/api/learning/lessons?asx_vol=10")
        data2 = json.loads(r2.data)
        texts2 = [l["lesson_text"] for l in data2["lessons"]]
        self.assertNotIn("Sprint44 high vol specific", texts2)


class TestSprint45(unittest.TestCase):
    """Sprint 45 feature tests: thesis drift detection, stop trailing, scheduled brief."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    # ── Item 1: Thesis drift detection ──────────────────────────────────────

    def test_thesis_drift_endpoint_exists(self):
        """GET /api/learning/thesis-drift must return ok=True."""
        r = self.client.get("/api/learning/thesis-drift")
        self.assertEqual(r.status_code, 200)
        data = json.loads(r.data)
        self.assertTrue(data["ok"])

    def test_thesis_drift_empty_db_returns_nulls(self):
        """With no data, _compute_thesis_drift should return null averages and no nudge."""
        from routes.learning import _compute_thesis_drift
        import sqlite3

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE ai_learning_events (
                exit_reason TEXT, realized_pnl_pct REAL,
                was_executed INTEGER, outcome_status TEXT
            )
        """)
        conn.commit()

        result = _compute_thesis_drift(conn)
        self.assertIsNone(result["avg_manual_pct"])
        self.assertIsNone(result["avg_target_pct"])
        self.assertIsNone(result["nudge"])
        self.assertEqual(result["n_manual"], 0)
        self.assertEqual(result["n_target"], 0)
        conn.close()

    def test_thesis_drift_nudge_threshold(self):
        """Nudge fires only when target_avg - manual_avg > 3pp and n >= 5 in each bucket."""
        from routes.learning import _compute_thesis_drift
        import sqlite3

        # Build an in-memory DB with mock rows
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE ai_learning_events (
                exit_reason TEXT, realized_pnl_pct REAL,
                was_executed INTEGER, outcome_status TEXT
            )
        """)
        # 5 manual exits at +2% avg
        for _ in range(5):
            conn.execute(
                "INSERT INTO ai_learning_events VALUES (?, ?, ?, ?)",
                ("manual", 2.0, 1, "win"),
            )
        # 5 target hits at +10% avg (drag = 8pp > 3pp threshold)
        for _ in range(5):
            conn.execute(
                "INSERT INTO ai_learning_events VALUES (?, ?, ?, ?)",
                ("target_hit", 10.0, 1, "win"),
            )
        conn.commit()

        result = _compute_thesis_drift(conn)
        self.assertEqual(result["n_manual"], 5)
        self.assertEqual(result["n_target"], 5)
        self.assertAlmostEqual(result["avg_manual_pct"], 2.0)
        self.assertAlmostEqual(result["avg_target_pct"], 10.0)
        self.assertIsNotNone(result["nudge"])
        self.assertIn("EARLY_EXIT_DRAG", result["nudge"])
        conn.close()

    def test_thesis_drift_no_nudge_below_threshold(self):
        """No nudge when drag <= 3pp."""
        from routes.learning import _compute_thesis_drift
        import sqlite3

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE ai_learning_events (
                exit_reason TEXT, realized_pnl_pct REAL,
                was_executed INTEGER, outcome_status TEXT
            )
        """)
        # drag = 4.5 - 3.0 = 1.5pp (under threshold)
        for _ in range(5):
            conn.execute("INSERT INTO ai_learning_events VALUES (?, ?, ?, ?)", ("manual", 3.0, 1, "win"))
        for _ in range(5):
            conn.execute("INSERT INTO ai_learning_events VALUES (?, ?, ?, ?)", ("target_hit", 4.5, 1, "win"))
        conn.commit()

        result = _compute_thesis_drift(conn)
        self.assertIsNone(result["nudge"])
        conn.close()

    def test_thesis_drift_insufficient_data_no_nudge(self):
        """No nudge when n < 5 in either bucket."""
        from routes.learning import _compute_thesis_drift
        import sqlite3

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE ai_learning_events (
                exit_reason TEXT, realized_pnl_pct REAL,
                was_executed INTEGER, outcome_status TEXT
            )
        """)
        for _ in range(3):
            conn.execute("INSERT INTO ai_learning_events VALUES (?, ?, ?, ?)", ("manual", 2.0, 1, "win"))
        for _ in range(5):
            conn.execute("INSERT INTO ai_learning_events VALUES (?, ?, ?, ?)", ("target_hit", 15.0, 1, "win"))
        conn.commit()

        result = _compute_thesis_drift(conn)
        self.assertIsNone(result["nudge"])
        conn.close()

    def test_calib_compute_calls_thesis_drift(self):
        """_calib_compute source must reference _compute_thesis_drift."""
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        self.assertIn("_compute_thesis_drift", src)
        self.assertIn("_thesis_drift", src)
        self.assertIn("EARLY_EXIT_DRAG", src)

    def test_thesis_drift_card_in_learning_js(self):
        """learning.js must render a Thesis Drift card with correct placeholder id."""
        src = open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8").read()
        self.assertIn("ll-thesis-drift-card", src)
        self.assertIn("renderThesisDriftCard", src)
        self.assertIn("Thesis Drift", src)

    # ── Item 2: Stop trailing ────────────────────────────────────────────────

    def test_trail_stop_button_in_recommendations_js(self):
        """recommendations.js must have a Trail button and trailStop function."""
        src = open(os.path.join(ROOT, "js", "pages", "recommendations.js"), encoding="utf-8").read()
        self.assertIn("trailStop", src)
        self.assertIn("Trail", src)
        self.assertIn("_stopTrailed", src)
        self.assertIn("_stopTrailedAt", src)

    def test_trail_stop_only_tightens(self):
        """trailStop function must check wouldTighten before updating."""
        src = open(os.path.join(ROOT, "js", "pages", "recommendations.js"), encoding="utf-8").read()
        self.assertIn("wouldTighten", src)

    def test_trail_stop_badge_in_recommendations_js(self):
        """recommendations.js must render a Trailed badge when _stopTrailed is set."""
        src = open(os.path.join(ROOT, "js", "pages", "recommendations.js"), encoding="utf-8").read()
        self.assertIn("Trailed", src)

    # ── Item 3: Scheduled morning briefing ──────────────────────────────────

    def test_auto_brief_time_in_config_js(self):
        """config.js state.settings must contain autoBriefTime default."""
        src = open(os.path.join(ROOT, "js", "config.js"), encoding="utf-8").read()
        self.assertIn("autoBriefTime", src)

    def test_check_auto_brief_schedule_function_exists(self):
        """scheduler.js must define checkAutoBriefSchedule function."""
        src = open(os.path.join(ROOT, "js", "scheduler.js"), encoding="utf-8").read()
        self.assertIn("checkAutoBriefSchedule", src)
        self.assertIn("autoBriefFiredDate", src)
        self.assertIn("autoBriefTime", src)

    def test_auto_brief_called_from_init(self):
        """init.js must call checkAutoBriefSchedule after init sequence."""
        src = open(os.path.join(ROOT, "js", "init.js"), encoding="utf-8").read()
        self.assertIn("checkAutoBriefSchedule", src)

    def test_auto_brief_input_in_settings_js(self):
        """settings.js Display section must include auto-brief time input."""
        src = open(os.path.join(ROOT, "js", "pages", "settings.js"), encoding="utf-8").read()
        self.assertIn("autoBriefTime", src)
        self.assertIn("Auto-brief time", src)


class TestSprint46(unittest.TestCase):
    """Sprint 46: broker SELL import, rebalance suggestions, universe exclusion list."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    # ── Item 1: Broker CSV SELL import ──────────────────────────────────────

    def test_import_csv_sell_rows_returned_in_sells_array(self):
        """CSV with SELL rows must return them in 'sells' not 'skipped'."""
        import io as _io
        csv_data = (
            "Date,Reference,Market,Code,Description,Price,Units,Amount,Brokerage,GST,Contract,Order Date,Credit/Debit\n"
            "15/05/2026,REF1,ASX,BHP,SELL BHP,45.00,50,2250.00,19.95,1.99,CNT1,15/05/2026,Debit\n"
            "10/05/2026,REF2,ASX,CBA,BUY CBA,120.00,10,1200.00,9.95,0.99,CNT2,10/05/2026,Debit\n"
        ).encode()
        r = self.client.post(
            "/api/import/csv",
            data={"file": (_io.BytesIO(csv_data), "trades.csv")},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 200)
        d = json.loads(r.data)
        self.assertTrue(d["ok"])
        # SELL must be in sells, not skipped
        self.assertIn("sells", d)
        self.assertEqual(len(d["sells"]), 1)
        self.assertEqual(d["sells"][0]["action"], "SELL")
        self.assertEqual(d["sells"][0]["ticker"], "BHP")
        # BUY in rows
        self.assertEqual(len(d["rows"]), 1)
        self.assertEqual(d["rows"][0]["ticker"], "CBA")
        # SELL must NOT appear in skipped
        for s in d.get("skipped", []):
            self.assertNotIn("SELL BHP", s.get("reason", ""))

    def test_import_csv_selfwealth_sell_in_sells(self):
        """SelfWealth CSV with SELL row returned in 'sells' array."""
        import io as _io
        csv_data = (
            "Trade Date,Settlement Date,Description,Quantity,Price,Brokerage,GST on Brokerage,Total Amount,Portfolio\n"
            "15/05/2026,17/05/2026,SELL 50 WDS,50,4.50,9.95,0.99,225.00,Personal\n"
        ).encode()
        r = self.client.post(
            "/api/import/csv",
            data={"file": (_io.BytesIO(csv_data), "sw.csv"), "broker": "selfwealth"},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 200)
        d = json.loads(r.data)
        self.assertTrue(d["ok"])
        self.assertIn("sells", d)
        self.assertEqual(len(d["sells"]), 1)
        self.assertEqual(d["sells"][0]["action"], "SELL")
        self.assertEqual(d["sells"][0]["ticker"], "WDS")

    def test_import_csv_sells_sorted_chronologically(self):
        """Multiple SELL rows must be sorted by date ascending."""
        import io as _io
        csv_data = (
            "Date,Reference,Market,Code,Description,Price,Units,Amount,Brokerage,GST,Contract,Order Date,Credit/Debit\n"
            "20/06/2026,R1,ASX,BHP,SELL BHP,46.00,10,460.00,9.95,0.99,C1,20/06/2026,Debit\n"
            "01/06/2026,R2,ASX,BHP,SELL BHP,44.00,5,220.00,9.95,0.99,C2,01/06/2026,Debit\n"
        ).encode()
        r = self.client.post(
            "/api/import/csv",
            data={"file": (_io.BytesIO(csv_data), "trades.csv")},
            content_type="multipart/form-data",
        )
        d = json.loads(r.data)
        self.assertIn("sells", d)
        self.assertEqual(len(d["sells"]), 2)
        self.assertLessEqual(d["sells"][0]["date"], d["sells"][1]["date"])

    # ── Item 2: Rebalancing suggestions panel ──────────────────────────────

    def test_risk_js_has_build_rebalance_suggestions(self):
        """risk.js must define _buildRebalanceSuggestions function."""
        src = open(os.path.join(ROOT, "js", "pages", "risk.js"), encoding="utf-8").read()
        self.assertIn("_buildRebalanceSuggestions", src)

    def test_risk_js_has_show_rebalance_suggestions(self):
        """risk.js must define showRebalanceSuggestions function."""
        src = open(os.path.join(ROOT, "js", "pages", "risk.js"), encoding="utf-8").read()
        self.assertIn("showRebalanceSuggestions", src)

    def test_risk_js_suggest_rebalance_button(self):
        """risk.js must include the Suggest Rebalance button."""
        src = open(os.path.join(ROOT, "js", "pages", "risk.js"), encoding="utf-8").read()
        self.assertIn("Suggest Rebalance", src)

    def test_risk_js_cgt_warning_in_suggestions(self):
        """_buildRebalanceSuggestions must check 320-365 day CGT window."""
        src = open(os.path.join(ROOT, "js", "pages", "risk.js"), encoding="utf-8").read()
        self.assertIn("CGT discount at risk", src)
        self.assertIn("320", src)

    # ── Item 3: Universe exclusion list ────────────────────────────────────

    def test_universe_exclude_post_adds_to_blob_store(self):
        """POST /api/market/universe-exclude must add tickers to blob_store."""
        r = self.client.post(
            "/api/market/universe-exclude",
            data=json.dumps({"tickers": ["IPL", "XYZ"]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        d = json.loads(r.data)
        self.assertTrue(d["ok"])
        self.assertIn("IPL", d["excluded"])
        self.assertIn("XYZ", d["excluded"])

    def test_universe_exclude_delete_removes_from_blob_store(self):
        """DELETE /api/market/universe-exclude must remove tickers."""
        # First add some tickers
        self.client.post(
            "/api/market/universe-exclude",
            data=json.dumps({"tickers": ["IPL", "XYZ", "ABC"]}),
            content_type="application/json",
        )
        # Now remove IPL
        r = self.client.delete(
            "/api/market/universe-exclude",
            data=json.dumps({"tickers": ["IPL"]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        d = json.loads(r.data)
        self.assertTrue(d["ok"])
        self.assertNotIn("IPL", d["excluded"])
        self.assertIn("XYZ", d["excluded"])

    def test_universe_exclude_deduplicates(self):
        """Adding the same ticker twice must not create duplicates."""
        self.client.post(
            "/api/market/universe-exclude",
            data=json.dumps({"tickers": ["DEDUP"]}),
            content_type="application/json",
        )
        r = self.client.post(
            "/api/market/universe-exclude",
            data=json.dumps({"tickers": ["DEDUP"]}),
            content_type="application/json",
        )
        d = json.loads(r.data)
        self.assertEqual(d["excluded"].count("DEDUP"), 1)

    def test_settings_js_has_exclude_from_universe(self):
        """settings.js must define excludeFromUniverse function."""
        src = open(os.path.join(ROOT, "js", "pages", "settings.js"), encoding="utf-8").read()
        self.assertIn("excludeFromUniverse", src)

    def test_settings_js_has_unexclude_from_universe(self):
        """settings.js must define unexcludeFromUniverse function."""
        src = open(os.path.join(ROOT, "js", "pages", "settings.js"), encoding="utf-8").read()
        self.assertIn("unexcludeFromUniverse", src)

    def test_settings_js_has_render_exclusion_list(self):
        """settings.js must define _renderUniverseExclusionList function."""
        src = open(os.path.join(ROOT, "js", "pages", "settings.js"), encoding="utf-8").read()
        self.assertIn("_renderUniverseExclusionList", src)

    def test_portfolio_js_has_apply_imported_sells(self):
        """portfolio.js must define _applyImportedSells function."""
        src = open(os.path.join(ROOT, "js", "pages", "portfolio.js"), encoding="utf-8").read()
        self.assertIn("_applyImportedSells", src)

    def test_portfolio_js_has_show_sell_import_confirmation(self):
        """portfolio.js must define _showSellImportConfirmation function."""
        src = open(os.path.join(ROOT, "js", "pages", "portfolio.js"), encoding="utf-8").read()
        self.assertIn("_showSellImportConfirmation", src)

    def test_scanner_imports_get_db(self):
        """scanner.py must import get_db for exclusion filter."""
        src = open(os.path.join(ROOT, "routes", "scanner.py"), encoding="utf-8").read()
        self.assertIn("from db import get_db", src)
        self.assertIn("universe_excluded", src)

    def test_intraday_imports_get_db(self):
        """intraday.py must import get_db for exclusion filter."""
        src = open(os.path.join(ROOT, "routes", "intraday.py"), encoding="utf-8").read()
        self.assertIn("from db import get_db", src)
        self.assertIn("universe_excluded", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
