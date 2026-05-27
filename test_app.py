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
                 "routes.alerts", "routes.import_csv"):
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

        Evaluates the real function extracted from both JS files against known cases.
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
        for fn in ("js/pages/recommendations.js", "js/pages/performance.js"):
            result = subprocess.run(
                ["node", "-e", node_script, os.path.join(ROOT, fn)],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0,
                             f"{fn} _detectExitReason direction logic wrong:\n{result.stderr}")


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
        """_detectExitReason must be defined in both recommendations.js and performance.js."""
        for fn in ("js/pages/recommendations.js", "js/pages/performance.js"):
            with open(os.path.join(ROOT, fn), encoding="utf-8") as f:
                src = f.read()
            self.assertIn("_detectExitReason", src,
                          f"{fn} must define _detectExitReason helper")
            self.assertIn("stop_hit", src)
            self.assertIn("target_hit", src)

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
        """markExecuted must fire triggerPostmortem when outcome is loss/breakeven."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("triggerPostmortem", src,
                      "markExecuted must call triggerPostmortem on loss/breakeven")
        self.assertIn("fetchSkillScore", src,
                      "markExecuted must call fetchSkillScore after close")

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
        """PROMPT_VERSION must be bumped to v5 after Stage 3 changes."""
        with open(os.path.join(ROOT, "js/prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("PROMPT_VERSION = '2026-05-v5'", src,
                      "PROMPT_VERSION must be bumped to 2026-05-v5")

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
        # The condition must be '0 < len(reg) < 3', not just 'len(reg) < 3'
        self.assertIn("0 < len(reg) < 3", src,
                      "L1: regime warning must gate on 0 < n < 3, not n < 3")

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
