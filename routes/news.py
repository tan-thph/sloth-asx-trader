"""
routes/news.py — News scanner + LLM provider configuration + system status.

Bundles the news/LLM endpoints together because they share configuration
(news_settings_from_db) and helpers (gpu detection, sbc mode).

Endpoints:
  /api/news                   GET   — yfinance news (legacy, simple)
  /api/news/feed              GET   — processed items from news scanner DB
  /api/news/scan              POST  — trigger manual scan
  /api/news/scan/stop         POST  — stop in-progress scan
  /api/news/status            GET   — scheduler + queue state
  /api/news/brief             GET   — compact tiered brief for AI prompt
  /api/news/backfill-impact-clamp POST — one-time legacy impact_score clamp (R6)
  /api/news/settings          GET/POST — scanner config
  /api/news/models            GET   — Ollama installed models
  /api/news/ollama-ps         GET   — currently loaded Ollama model
  /api/news/reclassify        POST  — re-classify old items with newer model
  /api/news/reclassify/status GET
  /api/news/reclassify/stop   POST
  /api/groq/models            GET
  /api/google/models          GET
  /api/ann/gemini/models      GET
  /api/sbc-mode               POST  — toggle low-power mode
  /api/system/gpu             GET
  /api/ollama/start           POST  — best-effort start of local Ollama daemon
"""

import json
import os
import subprocess
import threading
import time
from datetime import datetime, timedelta

import requests
import yfinance as yf
from flask import Blueprint, jsonify, request

from db import DB_PATH, get_db
from indicators import asx


bp = Blueprint("news", __name__)


# News engine — optional dependency. Imported lazily so the blueprint loads
# even if feedparser/sklearn aren't installed.
try:
    import news_engine as _ne
    _NE_OK = True
except ImportError:
    _ne = None
    _NE_OK = False


@bp.route("/api/news")
def news():
    """Collect recent news for broad market and portfolio tickers."""
    from datetime import datetime, timedelta

    # Symbols to track: ASX200, sector ETFs, plus portfolio from query or DB
    # Use ^AX* prefix — the .AX suffix variants (XIJ.AX etc.) are no longer
    # available on yfinance; the canonical Yahoo Finance format is ^AXIJ etc.
    base_symbols = ["^AXJO", "^AXIJ", "^AXMJ", "^AXEJ", "^AXHJ", "^AXTJ"]
    try:
        portfolio_tickers = request.args.get("tickers", "")
        if portfolio_tickers:
            extra = [asx(t.strip()) for t in portfolio_tickers.split(",") if t.strip()]
            base_symbols.extend(extra)
    except Exception:
        pass

    all_news = []
    cutoff = datetime.now() - timedelta(days=30)  # keep 30 days of news

    for sym in base_symbols:
        try:
            tk = yf.Ticker(sym)
            items = tk.news  # list of dicts with 'title','link','publisher','providerPublishTime'
            for item in items:
                ts = item.get("providerPublishTime")
                if ts:
                    dt = datetime.fromtimestamp(ts)
                    if dt >= cutoff:
                        all_news.append({
                            "symbol": sym.replace(".AX",""),
                            "title": item.get("title", ""),
                            "publisher": item.get("publisher", ""),
                            "timestamp": dt.isoformat(),
                            "link": item.get("link", "")
                        })
        except Exception:
            continue

    # Sort newest first and deduplicate by title
    seen = set()
    unique = []
    for n in sorted(all_news, key=lambda x: x["timestamp"], reverse=True):
        if n["title"] not in seen:
            seen.add(n["title"])
            unique.append(n)
            if len(unique) >= 80:   # limit to prevent prompt bloat
                break

    return jsonify({"news": unique, "fetchedAt": datetime.now().isoformat()})


# ── News Scanner routes ───────────────────────────────────────────────────────

def _get_sbc_mode() -> bool:
    """Return True if SBC mode is currently active."""
    try:
        with get_db() as conn:
            row = conn.execute("SELECT value FROM blob_store WHERE key='sbc_mode'").fetchone()
            if row:
                return bool(json.loads(row["value"]).get("enabled", False))
    except Exception:
        pass
    return False


def _get_gpu_info() -> dict:
    """Return cached GPU detection result (calls news_engine.detect_gpu once)."""
    if _NE_OK:
        return _ne.detect_gpu()
    return {"cuda": False, "device": None, "driver": None, "source": None}


def _news_settings_from_db() -> dict:
    """Read news scanner settings from blob_store, injecting global SBC mode.

    The cpu_mode default is auto-detected from hardware: True (CPU-only) when
    no CUDA GPU is found (e.g. Raspberry Pi 5), False when CUDA is present
    (e.g. Jetson Orin, desktop NVIDIA).  A user-saved value always wins.
    """
    gpu = _get_gpu_info()
    defaults = {
        "llm_provider":        "ollama",
        "llm_model":           "",
        "ollama_url":          "http://localhost:11434",
        "groq_api_key":        "",
        "groq_model":          "llama-3.1-8b-instant",
        "google_api_key":      "",
        "google_model":        "gemini-2.0-flash",
        "scan_interval_hours": 6,
        "enabled":             True,
        "max_age_days":        7,
        "cpu_mode":            not gpu.get("cuda", False),
        "sbc_mode":            False,
        # NEWS_LLM_FIXES.md N3: retry a local-LLM None with a configured cloud
        # provider (Google -> Groq) before giving up. Off by default so it never
        # makes a surprise paid call — the user must opt in explicitly.
        "news_cloud_fallback": False,
    }
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM blob_store WHERE key='news_settings'"
            ).fetchone()
            saved = json.loads(row["value"]) if row else {}
            result = {**defaults, **saved}
            # Inject global SBC mode flag (overrides per-setting value)
            sbc_row = conn.execute("SELECT value FROM blob_store WHERE key='sbc_mode'").fetchone()
            if sbc_row:
                result["sbc_mode"] = bool(json.loads(sbc_row["value"]).get("enabled", False))
            return result
    except Exception:
        pass
    return defaults


def _portfolio_tickers_from_db() -> list[str]:
    try:
        with get_db() as conn:
            rows = conn.execute("SELECT ticker FROM portfolio").fetchall()
            return [r["ticker"] for r in rows]
    except Exception:
        return []


def _ensure_news_scheduler():
    """Start scheduler if news engine available and not already running."""
    if not _NE_OK:
        return
    cfg = _news_settings_from_db()
    if not cfg.get("enabled", True):
        return
    if cfg.get("sbc_mode", False):  # SBC mode: auto-scan disabled
        return
    if not _ne._sched_thread or not _ne._sched_thread.is_alive():
        _ne.start_scheduler(
            db_path=DB_PATH,
            interval_hours=cfg.get("scan_interval_hours", 6),
            get_tickers_fn=_portfolio_tickers_from_db,
            get_settings_fn=_news_settings_from_db,
        )


@bp.route("/api/news/feed")
def news_feed():
    """Return processed news items from the scanner database."""
    if not _NE_OK:
        return jsonify({"items": [], "error": "news_engine not available — check requirements.txt"})
    days    = int(request.args.get("days", 3))
    limit   = int(request.args.get("limit", 50))
    cat     = request.args.get("category", "")
    ticker  = request.args.get("ticker", "")
    senti   = request.args.get("sentiment", "")
    min_imp = float(request.args.get("min_impact", 0))

    try:
        from news_engine import news_db, init_news_tables
        cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
        with news_db(DB_PATH) as conn:
            init_news_tables(conn)
            rows = conn.execute("""
                SELECT id, url, title, source, feed_type, published_date, fetched_at,
                       content, summary, category, sentiment, sentiment_score,
                       impact_score, tickers, primary_tickers, tags, llm_model, processed, decay_weight
                FROM news_items
                WHERE published_date >= ?
                ORDER BY processed DESC,
                         (COALESCE(impact_score,0) * COALESCE(decay_weight,0.5)) DESC
                LIMIT 200
            """, (cutoff,)).fetchall()

        items = []
        for row in rows:
            r = dict(row)
            r["tickers"]         = json.loads(r.get("tickers")         or "[]")
            r["primary_tickers"] = json.loads(r.get("primary_tickers") or "[]")
            r["tags"]            = json.loads(r.get("tags")            or "[]")
            # apply filters
            if cat    and r.get("category") != cat:
                continue
            if senti  and r.get("sentiment") != senti:
                continue
            if ticker and ticker.upper() not in [t.upper() for t in r["tickers"]]:
                continue
            if (r.get("impact_score") or 0) < min_imp:
                continue
            items.append(r)

        sentiment = _ne.get_market_sentiment(DB_PATH, days=days)
        return jsonify({"items": items[:limit], "sentiment": sentiment, "total": len(items)})
    except Exception as ex:
        return jsonify({"items": [], "error": str(ex)}), 500


@bp.route("/api/news/scan", methods=["POST"])
def news_scan():
    """Trigger a manual news scan."""
    if not _NE_OK:
        return jsonify({"ok": False, "error": "news_engine not available"}), 503
    data    = request.get_json() or {}
    tickers = data.get("tickers") or _portfolio_tickers_from_db()
    cfg     = _news_settings_from_db()
    result  = _ne.trigger_scan(DB_PATH, tickers, cfg)
    return jsonify(result)


@bp.route("/api/news/status")
def news_status():
    """Return news scanner pipeline status."""
    if not _NE_OK:
        return jsonify({
            "available": False,
            "error": "news_engine not available — run: pip install feedparser beautifulsoup4 scikit-learn",
        })
    status = _ne.get_status()
    cfg    = _news_settings_from_db()
    try:
        with _ne.news_db(DB_PATH) as conn:
            _ne.init_news_tables(conn)
            total = conn.execute("SELECT COUNT(*) FROM news_items").fetchone()[0]
            processed = conn.execute(
                "SELECT COUNT(*) FROM news_items WHERE processed=1"
            ).fetchone()[0]
            last_log = conn.execute(
                "SELECT * FROM news_scan_log ORDER BY scan_time DESC LIMIT 1"
            ).fetchone()
    except Exception:
        total = processed = 0
        last_log = None

    return jsonify({
        "available":  True,
        "running":    status["running"],
        "progress":   status["progress"],
        "phase":      status.get("phase", "idle"),
        "last_scan":  status["last_scan"],
        "next_scan":  status["next_scan"],
        "last_result":status["last_result"],
        "total_articles": total,
        "processed_articles": processed,
        "last_log": dict(last_log) if last_log else None,
        "settings": cfg,
        "ollama_available": _ne.OllamaLLM(
            model=cfg.get("llm_model") or "",
            base_url=cfg.get("ollama_url", "http://localhost:11434"),
        ).is_available(),
        "groq_available": bool(cfg.get("groq_api_key", "")),
        # Live progress fields (populated during active scans)
        "articles_to_classify":  status.get("articles_to_classify", 0),
        "articles_classified":   status.get("articles_classified", 0),
        "articles_failed":       status.get("articles_failed", 0),
        "current_article":       status.get("current_article", ""),
        "current_article_idx":   status.get("current_article_idx", 0),
        "tokens_generated":      status.get("tokens_generated", 0),
        "tokens_per_sec":        status.get("tokens_per_sec", 0.0),
        "avg_secs_per_article":  status.get("avg_secs_per_article", 0.0),
        "elapsed_secs":          status.get("elapsed_secs", 0.0),
        "eta_secs":              status.get("eta_secs"),
        "llm_model":             status.get("llm_model", ""),
        "gpu_vram_mb":           status.get("gpu_vram_mb"),
        "errors":                status.get("errors", []),
    })


_models_cache: dict = {"ts": 0.0, "payload": None}
_MODELS_TTL = 30  # seconds — avoids hammering Ollama on every Settings page load

@bp.route("/api/news/models")
def news_models():
    """Return available Ollama models (30 s TTL cache to reduce Ollama round-trips)."""
    import time as _time
    now = _time.monotonic()
    if _models_cache["payload"] is not None and now - _models_cache["ts"] < _MODELS_TTL:
        return jsonify(_models_cache["payload"])

    if not _NE_OK:
        return jsonify({"models": [], "available": False})

    cfg = _news_settings_from_db()
    llm = _ne.OllamaLLM(
        model=cfg.get("llm_model") or "",
        base_url=cfg.get("ollama_url", "http://localhost:11434"),
    )
    # Call list_models() once — it calls /api/tags (same endpoint as is_available).
    # Derive `available` from the result to avoid a second round-trip.
    models    = llm.list_models()      # [] when Ollama is down or cold
    available = bool(models) or llm.is_available()  # is_available() is a fast 3s-timeout check

    payload = {"models": models, "available": available}
    _models_cache["payload"] = payload
    _models_cache["ts"]      = now
    return jsonify(payload)


@bp.route("/api/groq/models")
def groq_models():
    """Return available Groq models using the saved API key (news or announcements)."""
    # Try news settings first, then announcements settings
    news_cfg = _news_settings_from_db()
    api_key  = news_cfg.get("groq_api_key", "")
    if not api_key:
        try:
            with get_db() as conn:
                row = conn.execute("SELECT value FROM blob_store WHERE key='ann_settings'").fetchone()
            if row:
                api_key = json.loads(row["value"]).get("groq_api_key", "")
        except Exception:
            pass
    if not api_key:
        return jsonify({"models": [], "available": False, "error": "No Groq API key saved"})
    try:
        resp = requests.get(
            "https://api.groq.com/openai/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10,
        )
        if not resp.ok:
            return jsonify({"models": [], "available": False, "error": f"Groq API error {resp.status_code}"})
        _exclude = ("whisper", "guard", "safeguard", "orpheus")
        models = [
            m["id"] for m in resp.json().get("data", [])
            if not any(x in m["id"].lower() for x in _exclude)
        ]
        models.sort()
        return jsonify({"models": models, "available": True})
    except Exception as exc:
        return jsonify({"models": [], "available": False, "error": str(exc)})


@bp.route("/api/google/models")
def google_models():
    """Return available Gemini models using the saved Google API key."""
    if not _NE_OK:
        return jsonify({"models": [], "available": False, "error": "news_engine not available"})
    api_key = _news_settings_from_db().get("google_api_key", "")
    if not api_key:
        return jsonify({"models": [], "available": False, "error": "No Google API key saved"})
    llm = _ne.GoogleLLM(api_key=api_key)
    models = llm.list_models()
    if not models:
        return jsonify({"models": [], "available": False, "error": "Could not fetch models — check API key"})
    return jsonify({"models": [m["name"] for m in models], "available": True})


@bp.route("/api/ann/gemini/models")
def ann_gemini_models():
    """Return available Gemini models using the announcements gemini_api_key."""
    try:
        with get_db() as conn:
            row = conn.execute("SELECT value FROM blob_store WHERE key='ann_settings'").fetchone()
            api_key = json.loads(row["value"]).get("gemini_api_key", "") if row else ""
    except Exception:
        api_key = ""
    if not api_key:
        return jsonify({"models": [], "available": False, "error": "No Gemini API key saved"})
    if _NE_OK:
        llm = _ne.GoogleLLM(api_key=api_key)
        models = llm.list_models()
    else:
        # Fallback: fetch directly without news_engine
        try:
            resp = requests.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": api_key}, timeout=10,
            )
            models = [
                {"name": m["name"].replace("models/", "")}
                for m in (resp.json().get("models", []) if resp.ok else [])
                if "generateContent" in m.get("supportedGenerationMethods", [])
                and "gemini" in m["name"].lower()
            ]
        except Exception:
            models = []
    if not models:
        return jsonify({"models": [], "available": False, "error": "Could not fetch models — check API key"})
    names = [m["name"].replace("models/", "") if isinstance(m, dict) else m.replace("models/", "") for m in models]
    return jsonify({"models": names, "available": True})


@bp.route("/api/news/settings", methods=["GET", "POST"])
def news_settings_route():
    """GET or update news scanner settings."""
    if request.method == "GET":
        return jsonify(_news_settings_from_db())

    data = request.get_json() or {}
    current = _news_settings_from_db()
    updated = {**current, **data}

    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) "
            "VALUES ('news_settings', ?, datetime('now','localtime'))",
            (json.dumps(updated),)
        )

    # Invalidate the models cache if the Ollama URL changed — otherwise
    # /api/news/models keeps serving the previous server's model list for
    # up to _MODELS_TTL seconds after the user points at a new Colab/ngrok URL.
    if current.get("ollama_url") != updated.get("ollama_url"):
        _models_cache["payload"] = None

    # Restart scheduler if interval or enabled changed (only if not in SBC mode)
    if _NE_OK:
        _ne.stop_scheduler()
        if updated.get("enabled", True) and not _get_sbc_mode():
            _ne.start_scheduler(
                db_path=DB_PATH,
                interval_hours=updated.get("scan_interval_hours", 6),
                get_tickers_fn=_portfolio_tickers_from_db,
                get_settings_fn=_news_settings_from_db,
            )
    return jsonify({"ok": True, "settings": updated})


@bp.route("/api/sbc-mode", methods=["POST"])
def sbc_mode_route():
    """Toggle SBC mode — pauses background auto-schedulers, sets 20-min price refresh hint."""
    data    = request.get_json() or {}
    enabled = bool(data.get("enabled", False))

    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) "
            "VALUES ('sbc_mode', ?, datetime('now','localtime'))",
            (json.dumps({"enabled": enabled}),)
        )

    # Pause or resume the news scanner background scheduler
    if _NE_OK:
        if enabled:
            _ne.stop_scheduler()
        else:
            cfg = _news_settings_from_db()
            if cfg.get("enabled", True):
                _ne.start_scheduler(
                    db_path=DB_PATH,
                    interval_hours=cfg.get("scan_interval_hours", 6),
                    get_tickers_fn=_portfolio_tickers_from_db,
                    get_settings_fn=_news_settings_from_db,
                )

    return jsonify({"ok": True, "sbc_mode": enabled})


@bp.route("/api/system/gpu")
def system_gpu():
    """Return cached GPU/CUDA detection result for this host."""
    return jsonify(_get_gpu_info())


@bp.route("/api/system/health-digest")
def system_health_digest():
    """On-demand system-health digest (health_digest.py).

    Plain GET returns the check results as JSON. `?notify=1` additionally
    delivers it through the notification centre + Telegram-on-warn, bypassing
    the once-per-day guard the daily scheduler uses.
    """
    try:
        import health_digest as _hd
        if request.args.get("notify"):
            return jsonify(_hd.send_digest(force=True))
        return jsonify(_hd.collect_health())
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@bp.route("/api/ollama/start", methods=["POST"])
def ollama_start():
    """Try to launch `ollama serve` if it is not already running."""
    import subprocess, sys
    ollama_url = "http://localhost:11434"
    # Check if already up
    try:
        r = requests.get(f"{ollama_url}/api/tags", timeout=2)
        if r.ok:
            return jsonify({"ok": True, "message": "Ollama is already running"})
    except Exception:
        pass
    # Attempt to start it
    try:
        if sys.platform == "win32":
            subprocess.Popen(
                ["ollama", "serve"],
                # DETACHED_PROCESS + CREATE_NO_WINDOW: no console for `ollama serve`
                # itself AND none inherited by the model-runner children it spawns
                # (the "many blank terminals" flashing during local-LLM use).
                creationflags=(subprocess.DETACHED_PROCESS
                               | subprocess.CREATE_NEW_PROCESS_GROUP
                               | subprocess.CREATE_NO_WINDOW),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            subprocess.Popen(
                ["ollama", "serve"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        return jsonify({"ok": True, "message": "Ollama start command sent — wait a few seconds"})
    except FileNotFoundError:
        return jsonify({"ok": False, "error": "ollama not found in PATH — install from https://ollama.com/download"}), 404
    except Exception as ex:
        return jsonify({"ok": False, "error": str(ex)}), 500


@bp.route("/api/news/ollama-ps")
def news_ollama_ps():
    """Return Ollama /api/ps — running models + VRAM usage."""
    if not _NE_OK:
        return jsonify({"models": [], "available": False})
    cfg = _news_settings_from_db()
    llm = _ne.OllamaLLM(
        model=cfg.get("llm_model") or "",
        base_url=cfg.get("ollama_url", "http://localhost:11434"),
    )
    ps = llm.get_ps()
    if ps is None:
        return jsonify({"models": [], "available": False})
    return jsonify({**ps, "available": True})


# ── Re-classify existing articles with a chosen model ────────────────────────
_reclassify_status: dict = {
    "running": False, "model": "", "total": 0, "done": 0, "failed": 0,
    "tokens_per_sec": 0.0, "current_article": "",
    "eta_secs": None, "elapsed_secs": 0.0, "avg_secs": 0.0, "error": None,
}
_reclassify_stop_event = threading.Event()

def _run_reclassify(model: str, days: int):
    global _reclassify_status
    _reclassify_status.update({
        "running": True, "model": model, "done": 0, "failed": 0,
        "total": 0, "error": None, "tokens_per_sec": 0.0,
        "current_article": "", "eta_secs": None, "elapsed_secs": 0.0, "avg_secs": 0.0,
    })
    try:
        cfg      = _news_settings_from_db()
        provider = cfg.get("llm_provider", "ollama").lower()
        if provider == "groq":
            llm = _ne.GroqLLM(api_key=cfg.get("groq_api_key", ""), model=cfg.get("groq_model", ""))
        elif provider == "google":
            llm = _ne.GoogleLLM(api_key=cfg.get("google_api_key", ""), model=cfg.get("google_model", ""))
        else:
            llm = _ne.OllamaLLM(model=model, base_url=cfg.get("ollama_url", "http://localhost:11434"))
        all_tick = _portfolio_tickers_from_db()
        cutoff   = (datetime.utcnow() - timedelta(days=days)).isoformat()

        with _ne.news_db(DB_PATH) as conn:
            rows = conn.execute(
                "SELECT id, title, content, published_date FROM news_items "
                "WHERE published_date >= ? ORDER BY published_date DESC",
                (cutoff,),
            ).fetchall()

        total = len(rows)
        _reclassify_status["total"] = total
        art_times: list[float] = []
        t0 = time.time()
        _reclassify_stop_event.clear()   # reset before starting

        for idx, row in enumerate(rows):
            if _reclassify_stop_event.is_set():
                _reclassify_status["error"] = f"Stopped by user after {idx}/{total} articles"
                break

            _reclassify_status["current_article"] = (row["title"] or "")[:80]
            art_t0 = time.monotonic()
            result = llm.classify(row["title"], row["content"] or "", all_tick,
                                  status_ref=_reclassify_status,
                                  stop_event=_reclassify_stop_event)
            # Stop may have been set during the cloud API call
            if _reclassify_stop_event.is_set():
                _reclassify_status["error"] = f"Stopped by user after {idx + 1}/{total} articles"
                break
            art_elapsed = time.monotonic() - art_t0
            art_times.append(art_elapsed)
            avg = sum(art_times) / len(art_times)
            remaining = total - (idx + 1)
            _reclassify_status.update({
                "done": idx + 1,
                "avg_secs": round(avg, 1),
                "eta_secs": round(avg * remaining),
                "elapsed_secs": round(time.time() - t0, 1),
            })

            if result:
                from news_engine import _norm_sentiment, _safe_float, compute_decay
                primary  = [t.upper() for t in (result.get("primary_tickers") or []) if isinstance(t, str)][:5]
                mentioned = [t.upper() for t in (result.get("mentioned_tickers") or result.get("tickers_mentioned") or []) if isinstance(t, str)][:15]
                all_t    = list(dict.fromkeys(primary + [t for t in mentioned if t not in primary]))
                dw       = compute_decay(row["published_date"] or "")
                with _ne.news_db(DB_PATH) as conn:
                    conn.execute("""
                        UPDATE news_items SET
                            summary=:summary, category=:category, sentiment=:sentiment,
                            sentiment_score=:score, impact_score=:impact,
                            tickers=:tickers, primary_tickers=:primary_tickers,
                            tags=:tags, llm_model=:model, decay_weight=:decay, processed=1
                        WHERE id=:id
                    """, {
                        "summary":         str(result.get("summary") or "")[:500],
                        "category":        str(result.get("category") or "other").lower()[:30],
                        "sentiment":       _norm_sentiment(result.get("sentiment")),
                        "score":           _safe_float(result.get("sentiment_score"), max_val=1.0),
                        "impact":          _safe_float(result.get("impact_score"), max_val=10.0),
                        "tickers":         json.dumps(all_t),
                        "primary_tickers": json.dumps(primary),
                        "tags":            json.dumps([str(t) for t in (result.get("tags") or []) if t][:8]),
                        "model":           model,
                        "decay":           dw,
                        "id":              row["id"],
                    })
            else:
                _reclassify_status["failed"] += 1
    except Exception as ex:
        _reclassify_status["error"] = str(ex)
    finally:
        _reclassify_status["running"]         = False
        _reclassify_status["current_article"] = ""
        _reclassify_status["eta_secs"]        = 0


@bp.route("/api/news/reclassify", methods=["POST"])
def news_reclassify():
    """Re-run LLM classification on all articles in the retention window using a chosen model."""
    if not _NE_OK:
        return jsonify({"ok": False, "error": "news_engine not available"}), 503
    data     = request.get_json() or {}
    days     = int(data.get("days", 7))
    cfg      = _news_settings_from_db()
    provider = cfg.get("llm_provider", "ollama").lower()
    if provider == "groq":
        if not cfg.get("groq_api_key"):
            return jsonify({"ok": False, "error": "Groq API key not set in News Scanner settings"}), 400
        model = f"groq/{_ne.GroqLLM.GROQ_MODEL}"
    elif provider == "google":
        if not cfg.get("google_api_key"):
            return jsonify({"ok": False, "error": "Google API key not set in News Scanner settings"}), 400
        model = f"google/{cfg.get('google_model', _ne.GoogleLLM.GOOGLE_MODEL)}"
    else:
        model = data.get("model", "").strip()
        if not model:
            return jsonify({"ok": False, "error": "model is required"}), 400
    if _reclassify_status["running"]:
        return jsonify({"ok": False, "error": "Reclassification already running"}), 409
    threading.Thread(target=_run_reclassify, args=(model, days), daemon=True, name="Reclassify").start()
    return jsonify({"ok": True, "message": f"Re-classifying with {model} over last {days}d"})


@bp.route("/api/news/reclassify/status")
def news_reclassify_status():
    return jsonify({**_reclassify_status})


@bp.route("/api/news/reclassify/stop", methods=["POST"])
def news_reclassify_stop():
    if not _reclassify_status.get("running"):
        return jsonify({"ok": False, "error": "No reclassify job running"})
    _reclassify_stop_event.set()
    return jsonify({"ok": True, "message": "Stop signal sent — finishing current article"})


@bp.route("/api/news/scan/stop", methods=["POST"])
def news_scan_stop():
    if not _NE_OK:
        return jsonify({"ok": False, "error": "news_engine not available"}), 503
    return jsonify(_ne.stop_scan())


@bp.route("/api/news/brief")
def news_brief():
    """Return top-impact recent news for the AI analysis prompt."""
    if not _NE_OK:
        return jsonify({"items": []})
    tickers = request.args.get("tickers", "").split(",")
    tickers = [t.strip().upper() for t in tickers if t.strip()]
    if not tickers:
        tickers = _portfolio_tickers_from_db()
    days       = int(request.args.get("days", 2))
    limit      = int(request.args.get("limit", 15))
    max_direct = max(1, limit * 2 // 3)   # ~2/3 of limit for portfolio-direct
    max_wide   = max(1, limit - max_direct)
    items = _ne.get_news_brief(DB_PATH, tickers, days=days, max_direct=max_direct, max_wide=max_wide)
    return jsonify({"items": items})


@bp.route("/api/news/backfill-impact-clamp", methods=["POST"])
def news_backfill_impact_clamp():
    """One-time cleanup for 41 legacy rows with impossible impact scores
    (PROMPT_RELEVANCE_FIXES.md R6) — all predate the N7 _safe_float clamp
    (NEWS_LLM_FIXES.md) landing in news_engine.py's LLM write path, so this
    is residue, not an active leak. They poison get_market_sentiment's
    AVG(impact_score) aggregate until clamped.

    Body: {"dry_run": true|false}. Dry-run (default) returns the count that
    WOULD change without writing.
    """
    if not _NE_OK:
        return jsonify({"ok": False, "error": "news_engine not available"}), 503

    data = request.get_json(silent=True) or {}
    dry_run = data.get("dry_run", True)

    with _ne.news_db(DB_PATH) as conn:
        _ne.init_news_tables(conn)
        n = conn.execute(
            "SELECT COUNT(*) FROM news_items WHERE impact_score < 0 OR impact_score > 10"
        ).fetchone()[0]
        if not dry_run and n:
            conn.execute(
                "UPDATE news_items SET impact_score = MAX(0.0, MIN(10.0, impact_score)) "
                "WHERE impact_score < 0 OR impact_score > 10"
            )

    return jsonify({"ok": True, "dry_run": dry_run, "rows_clamped": n})
