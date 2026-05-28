"""
routes/debate.py — Internal debate engine (local Ollama).

Generates a structured bull/bear debate before Claude analyses a ticker, plus
postmortem analysis on closed trades and skill scoring. Degrades gracefully
when Ollama is not running.

Endpoints:
  /api/debate/status                 GET    — Ollama reachable + available models
  /api/debate                        POST   — bull+bear debate for one ticker
  /api/debate/postmortem             POST   — postmortem on a closed event
  /api/debate/postmortem-debate      POST   — adversarial 2-model postmortem
  /api/debate/adjudicate             POST   — cloud adjudicator (Gemini/Groq)
  /api/debate/adjudicator-status     GET    — is a cloud adjudicator configured?
  /api/debate/staleness              POST   — re-check pending recs for invalidation
  /api/debate/skill                  POST   — 0-10 quality score for an event
"""

import json
import re
import time
from datetime import datetime

import requests
from flask import Blueprint, current_app, jsonify, request

from core import OLLAMA_BASE as _OLLAMA_BASE, log
from db import get_db


bp = Blueprint("debate", __name__)


# ============================================================
# INTERNAL DEBATE ENGINE
# Uses a local Ollama model (e.g. qwen3:9b) to generate a
# structured bull/bear debate before Claude analyses a ticker.
# All endpoints degrade gracefully — if Ollama is not running,
# the frontend simply skips the debate step.
# ============================================================

# _OLLAMA_BASE imported from core.py


def _call_ollama(model: str, prompt: str, timeout: int = 45, retries: int = 1,
                 think: bool | None = None, num_predict: int = 200) -> dict:
    """
    Send a prompt to a local Ollama model via /api/generate.
    Returns {"ok": True, "text": "..."} or {"ok": False, "error": "..."}.

    Args:
        think:       None = let Ollama decide (default for debate/analysis calls).
                     False = disable extended thinking for JSON-output endpoints —
                     prevents thinking tokens from eating num_predict budget before
                     the model can emit JSON. Ignored by non-thinking models.
        num_predict: Max output tokens. Default 200 is sufficient for JSON responses;
                     use higher values for free-text debate output.

    Retry policy:
      - HTTP 503 (model still loading): retry up to `retries` times with backoff.
      - Timeout: NO retry — fail immediately. A timed-out prompt won't succeed
        faster on a second attempt; the caller should increase `timeout` or
        switch to a smaller model.
      - ConnectionError: NO retry — Ollama is not running.
    """
    for attempt in range(retries + 1):
        if attempt > 0:
            time.sleep(min(2 ** attempt, 8))   # 2 s, 4 s … for 503 retries only
        try:
            payload = {
                "model":      model,
                "prompt":     prompt,
                "stream":     False,
                "keep_alive": "10m",        # keep model in VRAM between calls
                "options": {
                    "num_predict": num_predict,
                    "temperature": 0.3,     # lower temp → more deterministic classification
                },
            }
            if think is not None:
                payload["think"] = think   # Ollama ≥0.6: disable/enable thinking tokens
            resp = requests.post(
                f"{_OLLAMA_BASE}/api/generate",
                json=payload,
                timeout=timeout,
            )
            if resp.ok:
                data = resp.json()
                return {"ok": True, "text": data.get("response", "").strip()}
            # 503 = Ollama still loading the model weights — worth retrying
            if resp.status_code == 503 and attempt < retries:
                continue
            if resp.status_code == 404:
                # Model not pulled — surface Ollama's own message if available
                try:
                    body = resp.json().get("error", "")
                except Exception:
                    body = resp.text[:120]
                return {"ok": False,
                        "error": f"Model not found — run: ollama pull <model>. Detail: {body}"}
            return {"ok": False, "error": f"Ollama HTTP {resp.status_code}"}
        except requests.exceptions.ConnectionError:
            return {"ok": False, "error": "Ollama not running — run: ollama serve"}
        except requests.exceptions.Timeout:
            # Fail immediately — retrying won't help a slow model/prompt
            return {"ok": False,
                    "error": f"Ollama timeout after {timeout}s — try a smaller model or increase timeout"}
        except Exception as ex:
            return {"ok": False, "error": str(ex)}
    return {"ok": False, "error": "Ollama did not respond after retries"}


def _strip_think_tags(text: str) -> str:
    """Remove <think>...</think> blocks emitted by reasoning models (e.g. qwen3/qwen3.5).

    Handles three cases:
    1. Complete block: <think>…</think> — stripped cleanly, remainder returned.
    2. Entire response inside block: stripping leaves nothing — return original
       so callers can still attempt regex extraction inside the think content.
    3. Unclosed block: model was cut off by num_predict before writing </think>
       and never emitted JSON. Detected and flagged so callers see empty string
       (all fallbacks will also fail — this is the correct signal to surface an
       error rather than return a garbage parse).

    NOTE: passing think=False to _call_ollama is the primary fix for case 3.
    This function is the safety net for models that ignore that flag.
    """
    # Case 1 & 2: complete think block(s)
    stripped = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    if stripped:
        return stripped
    # Case 2: everything was inside think tags — return original for regex fallback
    if "</think>" in text:
        return text
    # Case 3: unclosed think tag — model was truncated, no JSON was ever written
    if "<think>" in text:
        return ""   # signal to caller: nothing parseable here
    return text


@bp.route("/api/debate/status")
def debate_status():
    """
    Health check: is Ollama up and which models are pulled?
    Returns {"available": bool, "models": [...], "url": "..."}.
    """
    try:
        r = requests.get(f"{_OLLAMA_BASE}/api/tags", timeout=3)
        if r.ok:
            tags = r.json()
            models = [m["name"] for m in tags.get("models", [])]
            return jsonify({"available": True, "models": models, "url": _OLLAMA_BASE})
        return jsonify({"available": False, "models": [], "url": _OLLAMA_BASE,
                        "error": f"Ollama HTTP {r.status_code}"})
    except Exception as ex:
        return jsonify({"available": False, "models": [], "url": _OLLAMA_BASE,
                        "error": str(ex)})


@bp.route("/api/debate", methods=["POST"])
def debate_bull_bear():
    """
    Generate a structured bull/bear debate for one ticker using a local model.

    Request body:
        {
          "ticker":  "BHP.AX",
          "signals": {
              "current_price": 42.50,
              "rsi_14":        28.3,
              "bb_pct_b":      0.08,
              "volume_z_score": 2.1,
              "return_60d":    -12.4,
              "obv_trend":     "rising",
              "sma_200":       38.10,
              "adx_14":        22.5,
              "atr_14":        1.20
          },
          "model":   "qwen3:9b",   // optional, default qwen3:9b
          "timeout": 45            // optional, seconds per side
        }

    Response:
        {
          "ok": true,
          "ticker": "BHP.AX",
          "model": "qwen3:9b",
          "bull": "...",
          "bear": "...",
          "elapsed_ms": 12400
        }
    """
    data      = request.get_json() or {}
    ticker    = (data.get("ticker") or "").upper()
    signals   = data.get("signals") or {}
    model     = data.get("model") or "qwen3:9b"
    tout      = min(int(data.get("timeout", 45)), 90)
    action    = (data.get("action") or "BUY").upper()   # D7: direction-aware framing
    is_exit   = action in ("SELL", "TRIM")

    if not ticker:
        return jsonify({"ok": False, "error": "ticker required"}), 400

    # ── Format key signals for the prompt (D4: added 5d/20d returns + ATR%) ───
    price   = signals.get("current_price", "?")
    rsi     = signals.get("rsi_14")
    bb_pct  = signals.get("bb_pct_b")
    vol_z   = signals.get("volume_z_score")
    ret5    = signals.get("return_5d")
    ret20   = signals.get("return_20d")
    ret60   = signals.get("return_60d")
    obv     = signals.get("obv_trend", "?")
    sma200  = signals.get("sma_200")
    adx     = signals.get("adx_14")
    atr_pct = signals.get("atr_pct")
    atr14   = signals.get("atr_14")

    sig_text = (
        f"Ticker: {ticker} | Price: {price}"
        + (f" | RSI(14)={rsi:.1f}" if rsi is not None else "")
        + (f" | BB%b={bb_pct:.2f}" if bb_pct is not None else "")
        + (f" | VolZ={vol_z:.1f}σ" if vol_z is not None else "")
        + (f" | 5d={ret5:.1f}%" if ret5 is not None else "")
        + (f" | 20d={ret20:.1f}%" if ret20 is not None else "")
        + (f" | 60d={ret60:.1f}%" if ret60 is not None else "")
        + (f" | OBV={obv}" if obv else "")
        + (f" | SMA200={sma200:.2f}" if sma200 is not None else "")
        + (f" | ADX={adx:.1f}" if adx is not None else "")
        + (f" | ATR%={atr_pct:.1f}%" if atr_pct is not None else (f" | ATR={atr14:.3f}" if atr14 is not None else ""))
    )

    # ── D7: Prompts — entry framing for BUY/TOP_UP, exit framing for SELL/TRIM ─
    if is_exit:
        bull_prompt = (
            f"You are a disciplined ASX swing trader. Given these signals:\n{sig_text}\n\n"
            "Write 2–3 concise sentences arguing AGAINST exiting this position now (hold case). "
            "Focus on recovery potential, continued thesis, and why the setup still holds. "
            "Be specific to the numbers. No waffle. No markdown."
        )
        bear_prompt = (
            f"You are a disciplined ASX swing trader. Given these signals:\n{sig_text}\n\n"
            "Write 2–3 concise sentences arguing FOR exiting this position now (exit case). "
            "Focus on deteriorating momentum, thesis breakdown, and why exiting reduces risk. "
            "Be specific to the numbers. No waffle. No markdown."
        )
    else:
        bull_prompt = (
            f"You are a disciplined ASX swing trader. Given these signals:\n{sig_text}\n\n"
            "Write 2–3 concise sentences arguing FOR a long entry (bull case). "
            "Focus on mean-reversion opportunity, oversold signals, and risk/reward. "
            "Be specific to the numbers. No waffle. No markdown."
        )
        bear_prompt = (
            f"You are a disciplined ASX swing trader. Given these signals:\n{sig_text}\n\n"
            "Write 2–3 concise sentences arguing AGAINST a long entry (bear case). "
            "Focus on downtrend risk, momentum, and what could go wrong. "
            "Be specific to the numbers. No waffle. No markdown."
        )

    t0 = time.time()

    # Run bull then bear SEQUENTIALLY — Ollama queues concurrent requests anyway
    # and running them in parallel doubles peak VRAM/RAM usage, causing crashes
    # on machines with limited memory (the primary cause of "Ollama stopped working").
    bull_result = _call_ollama(model, bull_prompt, timeout=tout, think=False, num_predict=350)
    bear_result = _call_ollama(model, bear_prompt, timeout=tout, think=False, num_predict=350)

    elapsed_ms = int((time.time() - t0) * 1000)

    if not bull_result.get("ok") or not bear_result.get("ok"):
        err = bull_result.get("error") or bear_result.get("error") or "unknown"
        current_app.logger.warning(f"[Debate] {ticker} FAILED via {model} ({elapsed_ms}ms): {err}")
        return jsonify({"ok": False, "ticker": ticker, "error": err,
                        "elapsed_ms": elapsed_ms})

    # ── Synthesizer: 3rd call — adjudicate (D1: num_predict 120→180) ──────────
    if is_exit:
        synth_prompt = (
            f"Hold case: {bull_result['text']}\n\n"
            f"Exit case: {bear_result['text']}\n\n"
            "Adjudicate. Reply with ONLY a JSON object, no prose:\n"
            '{"winner":"hold"|"exit"|"neutral","margin":"strong"|"moderate"|"thin",'
            '"key_pivot":"one short phrase — the single most decisive factor"}'
        )
    else:
        synth_prompt = (
            f"Bull case: {bull_result['text']}\n\n"
            f"Bear case: {bear_result['text']}\n\n"
            "Adjudicate. Reply with ONLY a JSON object, no prose:\n"
            '{"winner":"bull"|"bear"|"neutral","margin":"strong"|"moderate"|"thin",'
            '"key_pivot":"one short phrase — the single most decisive factor"}'
        )
    synth_result = _call_ollama(model, synth_prompt, timeout=min(tout, 30),
                                think=False, num_predict=180)

    # D2: try whole-response parse first; scan from end for last valid JSON object
    synthesis = None
    if synth_result.get("ok"):
        try:
            clean = _strip_think_tags(synth_result["text"])
            try:
                synthesis = json.loads(clean)
            except Exception:
                for m in reversed(list(re.finditer(r'\{[^{}]+\}', clean, re.DOTALL))):
                    try:
                        synthesis = json.loads(m.group())
                        break
                    except Exception:
                        continue
        except Exception:
            pass  # synthesis is optional — degrading gracefully

    current_app.logger.info(f"[Debate] {ticker} bull+bear+synth via {model} → {elapsed_ms}ms ✓")
    return jsonify({
        "ok":         True,
        "ticker":     ticker,
        "model":      model,
        "bull":       bull_result["text"],
        "bear":       bear_result["text"],
        "synthesis":  synthesis,
        "elapsed_ms": elapsed_ms,
    })


# ── Shared postmortem helpers ─────────────────────────────────────────────────
# Used by both /api/debate/postmortem (single model) and
# /api/debate/postmortem-debate (adversarial two-model).

VALID_PM_TYPES = {
    "overconfident", "missed_catalyst", "regime_mismatch",
    "poor_entry", "stop_too_tight",
    "poor_rr", "external_shock", "thesis_broken", "none",
}

def _pm_build_summary(row) -> str:
    """
    Compact trade summary for postmortem classification.
    recommendation must be first — without it models assume BUY direction
    and misinterpret entry prices for SELL/TRIM trades.
    Annotates stop/target with direction notes so models know when prices
    are on the 'wrong' side (e.g. stop below entry for a SELL).
    """
    status  = row["outcome_status"]
    action  = (row["recommendation"] or "BUY").upper()
    is_exit = action in ("SELL", "TRIM")
    entry   = row["actual_entry_price"]
    stop    = row["suggested_stop"]
    target  = row["suggested_target"]

    def _dir_note(price, entry, price_should_be_above: bool) -> str:
        """Return '(correct)' / '(STORED INCORRECTLY — wrong direction)' annotation."""
        if price is None or entry is None:
            return ""
        above = price > entry
        ok = above if price_should_be_above else not above
        return " [correct dir]" if ok else " [⚠ wrong dir — stored incorrectly?]"

    stop_note   = _dir_note(stop,   entry, price_should_be_above=is_exit)   # SELL stop above entry
    target_note = _dir_note(target, entry, price_should_be_above=not is_exit) # SELL target below entry

    return (
        f"{action} {row['ticker']} {status.upper()}"
        + (f" | PnL={row['realized_pnl_pct']:.1f}%"           if row["realized_pnl_pct"]    is not None else "")
        + (f" | hold={row['holding_period_days']}d"             if row["holding_period_days"] is not None else "")
        + (f" | AI_conf={row['ai_confidence']:.0%}"             if row["ai_confidence"]       is not None else "")
        + (f" | RR={row['rr_ratio']:.1f}"                       if row["rr_ratio"]            is not None else "")
        + (f" | entry={entry:.3f}"                              if entry                      is not None else "")
        + (f" | stop={stop:.3f}{stop_note}"                     if stop                       is not None else "")
        + (f" | target={target:.3f}{target_note}"               if target                     is not None else "")
        + (f" | exit={row['exit_reason']}"                      if row["exit_reason"]         else "")
        + (f" | regime={row['regime']}"                         if row["regime"]              else "")
        + (f" | sector={row['sector']}"                         if row["sector"]              else "")
    )


def _pm_exit_hint(exit_reason: str) -> str:
    """Factual exit context — no tag suggestions (causes model to pattern-match on method)."""
    return {
        "stop_hit":       "The pre-set stop loss price was triggered.",
        "time_exit":      "The position was closed after the expected holding period without reaching stop or target.",
        "manual":         "The position was closed manually before reaching stop or target.",
        "protective_stop":"The position was deliberately closed early to protect capital.",
    }.get(exit_reason, "")


def _pm_build_prompt(summary: str, rationale: str, exit_hint: str,
                     entry_signals_str: str = "", action: str = "BUY") -> str:
    """Full postmortem classification prompt. D5: entry_signals_str. D6: action for direction."""
    is_exit = action.upper() in ("SELL", "TRIM")

    # Direction preamble — prevents models from defaulting to BUY framing on SELL/TRIM trades.
    # Without this, models misread the stop/target position (e.g. call a correctly-set
    # SELL target "below entry — wrong" when that is exactly correct for a short thesis).
    direction_note = (
        "DIRECTION: This is a SELL/TRIM (exit/bearish) trade.\n"
        "  For SELL/TRIM → stop loss is set ABOVE entry (price rising = wrong direction, cut loss).\n"
        "  For SELL/TRIM → target is set BELOW entry (price falling = thesis confirmed, take profit).\n"
        "  If the summary shows stop BELOW entry for this SELL, the price was stored incorrectly —\n"
        "  do NOT tag 'stop_too_tight' or compute R:R based on that wrong-direction stop.\n"
        "  R:R for SELL = (entry − target) / (stop − entry) [both distances must be positive].\n\n"
    ) if is_exit else (
        "DIRECTION: This is a BUY/TOP_UP (long) trade.\n"
        "  Stop loss is BELOW entry; target is ABOVE entry.\n"
        "  R:R = (target − entry) / (entry − stop).\n\n"
    )

    return (
        direction_note
        + f"ASX closed trade (LOSS or BREAKEVEN): {summary}\n"
        + (f"Original AI reasoning at entry: {rationale}\n" if rationale else "No original rationale stored.\n")
        + (f"Exit context: {exit_hint}\n" if exit_hint else "")
        + (f"Entry signals at the time: {entry_signals_str}\n" if entry_signals_str else "")
        + "\n"
        "Classify the PRIMARY reason this trade failed. Use the P&L, holding period, "
        "confidence level, R:R ratio, entry/stop/target prices, and entry signals to reason — "
        "do NOT base the tag solely on the exit method.\n"
        "\n"
        "Select 1-2 error tags:\n"
        "  overconfident   - AI confidence was too high given the actual risk\n"
        "  missed_catalyst - key event (earnings/news/macro) was not accounted for\n"
        "  regime_mismatch - wrong strategy for the market regime at the time\n"
        "  poor_entry      - entry timing or price was suboptimal\n"
        "  stop_too_tight  - stop was hit by normal volatility before the move played out\n"
        "  poor_rr         - reward:risk ratio was too low from the start to justify the trade\n"
        "  external_shock  - outcome driven by unpredictable external event (policy change, black swan)\n"
        "  thesis_broken   - thesis was invalidated by new information that emerged after entry\n"
        "  none            - ONLY if the loss was genuinely unforeseeable with the available data\n"
        "\n"
        "Tag guidance — prefer the ROOT CAUSE, not its downstream consequence:\n"
        "  If stop_too_tight explains poor_rr (tight stop forced a bad R:R setup), "
        "use stop_too_tight only.\n"
        "  overconfident and poor_rr are independent — both can apply together.\n"
        "  Use none ONLY if no systematic error is identifiable; do not use it alongside other tags.\n"
        "\n"
        'Reply with JSON only: {"error_type":"TAG1,TAG2","reason":"one clear sentence citing specific numbers"}\n'
        "No markdown, no explanation outside JSON."
    )


# ── Cloud adjudicator helpers (Gemini / Groq) ─────────────────────────────────
# Used by the user-initiated 🧑‍⚖️ adjudicator. Reads API keys from the
# blob_store 'news_settings' entry (same place news + announcements use).

def _get_adjudicator_provider() -> dict:
    """
    Auto-detect which cloud provider to use, preferring Gemini.

    Returns a dict: {"provider": "gemini"|"groq"|None,
                     "api_key": "...", "model": "..."}
    The 'model' is the default for that provider; the endpoint may override.
    """
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM blob_store WHERE key='news_settings'"
            ).fetchone()
    except Exception:
        row = None
    settings = json.loads(row["value"]) if row else {}

    google_key = settings.get("google_api_key", "") or ""
    groq_key   = settings.get("groq_api_key", "") or ""

    if google_key:
        return {
            "provider": "gemini",
            "api_key":  google_key,
            "model":    settings.get("google_model") or "gemini-2.0-flash",
        }
    if groq_key:
        return {
            "provider": "groq",
            "api_key":  groq_key,
            "model":    settings.get("groq_model") or "llama-3.1-8b-instant",
        }
    return {"provider": None, "api_key": "", "model": ""}


def _call_gemini_json(api_key: str, model: str, prompt: str, timeout: int = 30) -> dict:
    """
    Call Gemini, return {"ok": True, "text": "..."} or {"ok": False, "error": "..."}.
    Mirrors _call_ollama return shape so the rest of the code is provider-agnostic.
    """
    try:
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            params={"key": api_key},
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.2, "maxOutputTokens": 500},
            },
            timeout=timeout,
        )
        if r.status_code != 200:
            return {"ok": False, "error": f"Gemini HTTP {r.status_code}: {r.text[:120]}"}
        text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
        return {"ok": True, "text": (text or "").strip()}
    except requests.exceptions.Timeout:
        return {"ok": False, "error": f"Gemini timeout after {timeout}s"}
    except Exception as ex:
        return {"ok": False, "error": str(ex)}


def _call_groq_json(api_key: str, model: str, prompt: str, timeout: int = 30) -> dict:
    """Call Groq; same shape as _call_gemini_json / _call_ollama."""
    try:
        r = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model":       model,
                "messages":    [{"role": "user", "content": prompt}],
                "temperature": 0.2,
                "max_tokens":  500,
            },
            timeout=timeout,
        )
        if r.status_code != 200:
            return {"ok": False, "error": f"Groq HTTP {r.status_code}: {r.text[:120]}"}
        text = r.json()["choices"][0]["message"]["content"]
        return {"ok": True, "text": (text or "").strip()}
    except requests.exceptions.Timeout:
        return {"ok": False, "error": f"Groq timeout after {timeout}s"}
    except Exception as ex:
        return {"ok": False, "error": str(ex)}


def _call_cloud_adjudicator(provider: str, api_key: str, model: str,
                            prompt: str, timeout: int = 30) -> dict:
    """Dispatch to gemini or groq. Returns {"ok", "text"} or {"ok", "error"}."""
    if provider == "gemini":
        return _call_gemini_json(api_key, model, prompt, timeout=timeout)
    if provider == "groq":
        return _call_groq_json(api_key, model, prompt, timeout=timeout)
    return {"ok": False, "error": f"Unknown adjudicator provider: {provider}"}


def _get_cloud_keys() -> dict:
    """
    Read Groq and Gemini keys from blob_store.news_settings.
    Returns {"groq_key": ..., "groq_model": ..., "gemini_key": ..., "gemini_model": ...}.
    """
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM blob_store WHERE key='news_settings'"
            ).fetchone()
    except Exception:
        row = None
    s = json.loads(row["value"]) if row else {}
    return {
        "groq_key":     s.get("groq_api_key", "") or "",
        "groq_model":   s.get("groq_model")   or "llama-3.3-70b-versatile",
        "gemini_key":   s.get("google_api_key", "") or "",
        "gemini_model": s.get("google_model") or "gemini-2.0-flash",
    }


def _call_model_any(model_name: str, prompt: str, timeout: int) -> dict:
    """
    Unified model dispatcher for postmortem debate phases.

    model_name prefixes:
      "groq:<model>"   → Groq API (reads key from news_settings blob)
      "gemini:<model>" → Gemini API (reads key from news_settings blob)
      anything else    → Ollama local
    """
    if model_name.startswith("groq:"):
        actual = model_name[5:].strip()
        keys   = _get_cloud_keys()
        if not keys["groq_key"]:
            return {"ok": False, "error": "Groq API key not configured (add it in News Scanner settings)"}
        return _call_groq_json(keys["groq_key"], actual or keys["groq_model"], prompt, timeout=timeout)

    if model_name.startswith("gemini:"):
        actual = model_name[7:].strip()
        keys   = _get_cloud_keys()
        if not keys["gemini_key"]:
            return {"ok": False, "error": "Google API key not configured (add it in News Scanner settings)"}
        return _call_gemini_json(keys["gemini_key"], actual or keys["gemini_model"], prompt, timeout=timeout)

    return _call_ollama(model_name, prompt, timeout=timeout, retries=0, think=False)


def _is_cloud_model(model_name: str) -> bool:
    return model_name.startswith("groq:") or model_name.startswith("gemini:")


def _pm_sanity_check_tags(final_tags: str, row, ev_id: int, label: str = "") -> str:
    """
    Post-classification logical-consistency check.

    Strips tags that contradict the actual trade numbers:
      - 'stop_too_tight' is invalid when stop distance from entry > 15% of price.
        A 43%-from-entry stop is wide, not tight, regardless of what the model said.
      - 'poor_rr' is invalid when actual R:R ratio >= 2.0. The trade was set up
        with adequate reward potential; it failed for another reason.

    This catches model self-contradictions (e.g. qwen3.5 calling a 43%-distance
    stop "too tight" while simultaneously noting the 43% distance in its reason).

    Direction-aware: uses absolute stop distance so SELL/BUY both work.
    Silently no-op when fields are missing.
    """
    if not final_tags:
        return final_tags
    tags  = set(t.strip() for t in final_tags.split(",") if t.strip())
    entry = row["actual_entry_price"]
    stop  = row["suggested_stop"]
    rr    = row["rr_ratio"]

    stripped = []

    if "stop_too_tight" in tags and entry and stop:
        stop_dist_pct = abs(entry - stop) / entry
        if stop_dist_pct > 0.15:
            tags.discard("stop_too_tight")
            stripped.append(
                f"stop_too_tight (stop is {stop_dist_pct:.0%} from entry — wide, not tight)"
            )

    if "poor_rr" in tags and rr is not None and rr >= 2.0:
        tags.discard("poor_rr")
        stripped.append(f"poor_rr (R:R={rr:.1f} is healthy, not poor)")

    if stripped:
        current_app.logger.info(
            f"[PostMortem{label}] event#{ev_id} sanity-check stripped: {stripped}"
        )

    return ",".join(sorted(tags)) if tags else ""


def _pm_validate_tags(error_type: str, ev_id: int, model: str, label: str = "") -> str:
    """
    Validate a comma-separated tag string against VALID_PM_TYPES.

    - Splits on comma, validates each individually (multi-tag responses
      like 'poor_rr,stop_too_tight' must be checked per-tag, not as a whole).
    - Logs and strips invalid tags.
    - Strips 'none' if mixed with real tags ('none' is mutually exclusive).
    - Returns clean string or '' if nothing valid remains.
    """
    if not error_type:
        return ""
    tags         = [t.strip() for t in error_type.split(",") if t.strip()]
    valid_tags   = [t for t in tags if t in VALID_PM_TYPES]
    invalid_tags = [t for t in tags if t not in VALID_PM_TYPES]
    if invalid_tags:
        current_app.logger.info(
            f"[PostMortem{label}] event#{ev_id} — stripped invalid tags "
            f"{invalid_tags} from '{error_type}' via {model}"
        )
    # 'none' is mutually exclusive with real tags — strip it when others are present
    real_tags = [t for t in valid_tags if t != "none"]
    if real_tags and len(real_tags) < len(valid_tags):
        current_app.logger.info(
            f"[PostMortem{label}] event#{ev_id} — stripped 'none' from mixed tag "
            f"set '{','.join(valid_tags)}' via {model}"
        )
        valid_tags = real_tags
    return ",".join(valid_tags) if valid_tags else ""


def _pm_parse(raw: str, ev_id: int, model: str, label: str = ""):
    """
    Parse postmortem model output → (error_type, reason).
    Strips think tags, handles JSON + regex fallback, validates each tag.
    Returns ('', '') on complete failure.
    """
    raw = _strip_think_tags(raw)
    raw = re.sub(r"^```[a-z]*\n?", "", raw)
    raw = re.sub(r"\n?```$",       "", raw)
    current_app.logger.debug(f"[PostMortem{label}] raw output for event#{ev_id}: {raw[:200]}")
    try:
        parsed     = json.loads(raw)
        error_type = parsed.get("error_type", "")
        reason     = parsed.get("reason", "")
    except Exception:
        m          = re.search(r'"error_type"\s*:\s*"([^"]+)"', raw)
        error_type = m.group(1) if m else ""
        m2         = re.search(r'"reason"\s*:\s*"([^"]+)"', raw)
        reason     = m2.group(1) if m2 else raw[:120]

    error_type = _pm_validate_tags(error_type, ev_id, model, label)
    return error_type, reason


# ── Win-tagging endpoint (Phase 1B) ──────────────────────────────────────────

VALID_WIN_TAGS = frozenset({
    "catalyst_capture",   # trade captured a planned earnings/news event
    "regime_aligned",     # entry timing was perfectly matched to macro regime
    "confluence_entry",   # multiple indicators aligned at entry (high-quality setup)
    "disciplined_hold",   # held through normal drawdown; thesis validated by outcome
    "good_sizing",        # position size was appropriate for the conviction and risk
    "none",               # win was luck-driven / unforeseeable upside
})


def _win_build_prompt(summary: str, rationale: str) -> str:
    """Prompt that asks the model to identify *why* a trade succeeded."""
    return (
        f"Analyse this closed ASX win and identify the PRIMARY reason it succeeded.\n\n"
        f"TRADE: {summary}\n"
        + (f"Original AI reasoning at entry: {rationale}\n" if rationale else "")
        + "\n"
        "Select 1-2 success tags that best describe what went right:\n"
        "  catalyst_capture  - trade captured a planned earnings/news/dividend event\n"
        "  regime_aligned    - entry timing was well-matched to the active macro regime\n"
        "  confluence_entry  - multiple independent indicators aligned cleanly at entry\n"
        "  disciplined_hold  - held through normal volatility; original thesis validated\n"
        "  good_sizing       - position size was appropriate for conviction and risk level\n"
        "  none              - ONLY if the win appears primarily luck-driven or unforeseeable\n"
        "\n"
        'Reply with JSON only: {"success_tags":"TAG1,TAG2","reason":"one clear sentence"}\n'
        "No markdown, no explanation outside JSON."
    )


def _win_parse(raw: str, ev_id: int, model: str):
    """Parse win-tag model output → (success_tags, reason). Returns ('','') on failure."""
    raw = _strip_think_tags(raw)
    raw = re.sub(r"^```[a-z]*\n?", "", raw)
    raw = re.sub(r"\n?```$",       "", raw)
    try:
        parsed = json.loads(raw)
        tags_raw = parsed.get("success_tags", "")
        reason   = parsed.get("reason", "")
    except Exception:
        m = re.search(r'"success_tags"\s*:\s*"([^"]+)"', raw)
        tags_raw = m.group(1) if m else ""
        m2 = re.search(r'"reason"\s*:\s*"([^"]+)"', raw)
        reason = m2.group(1) if m2 else raw[:120]

    # Validate tags
    tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
    valid = [t for t in tags if t in VALID_WIN_TAGS]
    # none is mutually exclusive with real tags
    real = [t for t in valid if t != "none"]
    final = ",".join(real if real else (["none"] if "none" in valid else []))
    return final, reason


@bp.route("/api/debate/tag-win", methods=["POST"])
def debate_tag_win():
    """
    Auto-tag a closed WIN with success tags using a local or cloud model.

    Request body:  { "id": 123, "model": "qwen3:9b", "timeout": 45 }
    Response:      { "ok": true, "id": 123, "success_tags": "regime_aligned,confluence_entry", "reason": "..." }
    """
    data  = request.get_json() or {}
    ev_id = data.get("id")
    model = data.get("model") or "qwen3:9b"
    tout  = min(int(data.get("timeout", 60)), 120)

    if not ev_id:
        return jsonify({"ok": False, "error": "id required"}), 400

    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT * FROM ai_learning_events WHERE id=?", (ev_id,)
            ).fetchone()
    except Exception as ex:
        return jsonify({"ok": False, "error": str(ex)}), 500

    if not row:
        return jsonify({"ok": False, "error": "event not found"}), 404
    if row["outcome_status"] != "win":
        return jsonify({"ok": False, "error": f"tag-win only runs on wins, got '{row['outcome_status']}'"}), 400

    summary   = _pm_build_summary(row)
    rationale = (row["rationale_summary"] or "").strip()[:250]
    prompt    = _win_build_prompt(summary, rationale)

    result = _call_model_any(model, prompt, timeout=tout)
    if not result["ok"]:
        return jsonify({"ok": False, "id": ev_id, "error": result["error"]})

    success_tags, reason = _win_parse(result["text"].strip(), ev_id, model)

    if success_tags:
        try:
            with get_db() as conn:
                conn.execute(
                    "UPDATE ai_learning_events SET success_tags=? WHERE id=?",
                    (success_tags, ev_id)
                )
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500
        current_app.logger.info(
            f"[TagWin] event#{ev_id} ({row['ticker']}) → {success_tags} via {model}"
        )

    return jsonify({
        "ok":          True,
        "id":          ev_id,
        "success_tags": success_tags or "none",
        "reason":      reason,
        "model":       model,
    })


# ── Single-model postmortem endpoint ──────────────────────────────────────────

@bp.route("/api/debate/postmortem", methods=["POST"])
def debate_postmortem():
    """
    Auto-tag a closed learning event with an error_type using a local model.

    Request body:
        { "id": 123, "model": "qwen3:9b", "timeout": 30 }

    Response:
        {"ok": true, "id": 123, "error_type": "overconfident", "reason": "..."}
    """
    data  = request.get_json() or {}
    ev_id = data.get("id")
    model = data.get("model") or "qwen3:9b"
    tout  = min(int(data.get("timeout", 60)), 120)

    if not ev_id:
        return jsonify({"ok": False, "error": "id required"}), 400

    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT * FROM ai_learning_events WHERE id=?", (ev_id,)
            ).fetchone()
    except Exception as ex:
        return jsonify({"ok": False, "error": str(ex)}), 500

    if not row:
        return jsonify({"ok": False, "error": "event not found"}), 404

    status = row["outcome_status"]
    if status not in ("win", "loss", "breakeven"):
        return jsonify({"ok": False, "error": f"event is '{status}', not closed"}), 400

    # Wins don't need error classification
    if status == "win":
        return jsonify({
            "ok": False,
            "error": "Wins don't get error tags — error tags are for losses and breakevens only.",
        }), 400

    summary   = _pm_build_summary(row)
    rationale = (row["rationale_summary"] or "").strip()[:250]
    exit_hint = _pm_exit_hint(row["exit_reason"] or "")
    # D5: include entry signals in the prompt when available
    entry_signals_str = ""
    try:
        esj = row["entry_signals_json"]
        if esj:
            sigs = json.loads(esj)
            entry_signals_str = ", ".join(
                f"{k}={v}" for k, v in sigs.items() if v is not None
            )
    except Exception:
        pass
    action = (row["recommendation"] or "BUY").upper()
    prompt = _pm_build_prompt(summary, rationale, exit_hint, entry_signals_str, action=action)

    result = _call_model_any(model, prompt, timeout=tout)
    if not result["ok"]:
        return jsonify({"ok": False, "id": ev_id, "error": result["error"]})

    error_type, reason = _pm_parse(result["text"].strip(), ev_id, model)
    # Logical-consistency check — strip tags that contradict the trade numbers
    error_type = _pm_sanity_check_tags(error_type, row, ev_id)

    if error_type and error_type != "none":
        try:
            with get_db() as conn:
                conn.execute(
                    "UPDATE ai_learning_events SET error_type=?, error_type_source='auto' WHERE id=?",
                    (error_type, ev_id)
                )
            current_app.logger.info(
                f"[PostMortem] event#{ev_id} ({row['ticker']}) → {error_type} via {model}"
                f" | {reason[:60] if reason else 'no reason'}"
            )
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500
    elif error_type == "none":
        current_app.logger.info(
            f"[PostMortem] event#{ev_id} ({row['ticker']}) → none (model found no systematic error) via {model}"
            f" | {reason[:80] if reason else ''}"
        )
    else:
        current_app.logger.info(
            f"[PostMortem] event#{ev_id} ({row['ticker']}) → parse failure via {model}"
            f" | raw: {result['text'][:120]}"
        )

    return jsonify({
        "ok":         True,
        "id":         ev_id,
        "error_type": error_type or "none",
        "reason":     reason,
        "model":      model,
    })


# ── Adversarial two-model postmortem debate endpoint ──────────────────────────

@bp.route("/api/debate/postmortem-debate", methods=["POST"])
def debate_postmortem_debate():
    """
    Three-phase adversarial postmortem: two models classify independently,
    then Model A is challenged to maintain or concede on full divergence.

    Phase 1 — Both models classify the trade independently.
    Phase 2 — Compare tag sets:
               identical  → CONSENSUS  (debated-consensus)
               overlap    → PARTIAL    (debated-merged, keep intersection)
               no overlap → DIVERGED   → Phase 3
    Phase 3 — Model A sees its own result plus Model B's position and must
               respond {maintain, final_tags, reason}.  If it concedes,
               Model B's tags are used.

    Request body:
        { "id": 123, "model_a": "qwen3.5:9b", "model_b": "gemma3:4b", "timeout": 60 }

    Response:
        {
          "ok": true, "id": 123,
          "error_type": "stop_too_tight",
          "error_type_source": "debated-consensus",
          "reason": "...", "verdict": "CONSENSUS",
          "model_a": "...", "model_b": "...",
          "debate": { ... full transcript ... },
          "elapsed_ms": 8200
        }
    """
    data    = request.get_json() or {}
    ev_id   = data.get("id")
    model_a = data.get("model_a") or "qwen3:9b"
    model_b = data.get("model_b") or "gemma3:4b"
    tout    = min(int(data.get("timeout", 60)), 120)

    if not ev_id:
        return jsonify({"ok": False, "error": "id required"}), 400

    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT * FROM ai_learning_events WHERE id=?", (ev_id,)
            ).fetchone()
    except Exception as ex:
        return jsonify({"ok": False, "error": str(ex)}), 500

    if not row:
        return jsonify({"ok": False, "error": "event not found"}), 404

    status = row["outcome_status"]
    if status not in ("loss", "breakeven"):
        return jsonify({"ok": False, "error": f"Debate only runs on losses/breakevens, got '{status}'"}), 400

    summary     = _pm_build_summary(row)
    rationale   = (row["rationale_summary"] or "").strip()[:250]
    exit_hint   = _pm_exit_hint(row["exit_reason"] or "")
    # D5: include entry signals in the prompt when available
    entry_signals_str = ""
    try:
        esj = row["entry_signals_json"]
        if esj:
            sigs = json.loads(esj)
            entry_signals_str = ", ".join(
                f"{k}={v}" for k, v in sigs.items() if v is not None
            )
    except Exception:
        pass
    action      = (row["recommendation"] or "BUY").upper()
    base_prompt = _pm_build_prompt(summary, rationale, exit_hint, entry_signals_str, action=action)

    # ── Phase 1: Independent classification ───────────────────────────────────
    t0    = time.time()
    current_app.logger.info(f"[PostMortemDebate] event#{ev_id} ({row['ticker']}) Phase 1A — {model_a}…")
    res_a = _call_model_any(model_a, base_prompt, timeout=tout)
    current_app.logger.info(f"[PostMortemDebate] event#{ev_id} Phase 1A done ({int((time.time()-t0)*1000)}ms)")

    t1 = time.time()
    current_app.logger.info(f"[PostMortemDebate] event#{ev_id} ({row['ticker']}) Phase 1B — {model_b}…")
    res_b = _call_model_any(model_b, base_prompt, timeout=tout)
    current_app.logger.info(f"[PostMortemDebate] event#{ev_id} Phase 1B done ({int((time.time()-t1)*1000)}ms)")

    if not res_a["ok"]:
        return jsonify({"ok": False, "error": f"Model A ({model_a}) failed: {res_a['error']}"})
    if not res_b["ok"]:
        return jsonify({"ok": False, "error": f"Model B ({model_b}) failed: {res_b['error']}"})

    tags_a_str, reason_a = _pm_parse(res_a["text"].strip(), ev_id, model_a, label=f"/{model_a}")
    tags_b_str, reason_b = _pm_parse(res_b["text"].strip(), ev_id, model_b, label=f"/{model_b}")

    # Tag sets — exclude "none" from overlap logic (treat as empty)
    set_a       = set(t for t in tags_a_str.split(",") if t) if tags_a_str else set()
    set_b       = set(t for t in tags_b_str.split(",") if t) if tags_b_str else set()
    set_a_logic = set_a - {"none"}
    set_b_logic = set_b - {"none"}

    # Did each model actually produce *parseable* output? Empty tags + empty reason
    # means parse failure (vs an intentional "none" verdict which has a reason).
    a_parsed_ok = bool(tags_a_str) or bool(reason_a.strip())
    b_parsed_ok = bool(tags_b_str) or bool(reason_b.strip())

    transcript = {
        # Trade context — surfaces direction (BUY/SELL/TRIM) + key prices so
        # the modal can show whether the models even interpreted direction
        # correctly. Helps spot cases where a SELL trade gets labelled
        # "poor_entry" because the model assumed BUY direction.
        "trade": {
            "recommendation": row["recommendation"],
            "ticker":         row["ticker"],
            "entry":          row["actual_entry_price"],
            "stop":           row["suggested_stop"],
            "target":         row["suggested_target"],
            "pnl_pct":        row["realized_pnl_pct"],
            "exit_reason":    row["exit_reason"],
            "regime":         row["regime"],
            "rr_ratio":       row["rr_ratio"],
            "hold_days":      row["holding_period_days"],
            "ai_confidence":  row["ai_confidence"],
        },
        "phase_1": {
            "model_a":  model_a, "tags_a":  tags_a_str, "reason_a": reason_a,
            "model_b":  model_b, "tags_b":  tags_b_str, "reason_b": reason_b,
        }
    }

    # ── Phase 2: Agreement check ──────────────────────────────────────────────
    # First handle parse failures — running a debate on garbage wastes a Phase 3 call.
    if not a_parsed_ok and not b_parsed_ok:
        # Both failed — return error, persist nothing
        return jsonify({
            "ok": False,
            "id": ev_id,
            "error": f"Both models failed to produce parseable output. "
                     f"A raw: {res_a['text'][:80]} | B raw: {res_b['text'][:80]}",
        })

    if a_parsed_ok and not b_parsed_ok:
        # Only A produced usable output — accept it as singleton
        verdict      = "SINGLETON_A"
        final_tags   = tags_a_str
        final_reason = reason_a
        final_source = "debated-singleton"

    elif b_parsed_ok and not a_parsed_ok:
        # Only B produced usable output — accept it as singleton
        verdict      = "SINGLETON_B"
        final_tags   = tags_b_str
        final_reason = reason_b
        final_source = "debated-singleton"

    elif set_a == set_b or (not set_a_logic and not set_b_logic):
        # Both produced output AND agree (including both saying "none")
        verdict      = "CONSENSUS"
        final_tags   = tags_a_str or tags_b_str
        final_reason = reason_a or reason_b
        final_source = "debated-consensus"

    elif set_a_logic & set_b_logic:
        # Partial overlap — keep only agreed tags
        verdict      = "PARTIAL"
        merged       = sorted(set_a_logic & set_b_logic)
        final_tags   = ",".join(merged)
        final_reason = f"A: {reason_a[:80]} | B: {reason_b[:80]}"
        final_source = "debated-merged"

    else:
        # ── Phase 3: Neutral synthesis (full divergence only) ─────────────────
        # Both models disagreed entirely. Rather than having one model defend
        # its position (which biases toward whichever model is the "challenger"),
        # we run a neutral reconciliation pass: present both positions and ask
        # for the single best classification, explaining why it was chosen over
        # the alternative.
        verdict = "DIVERGED"
        t2 = time.time()
        current_app.logger.info(
            f"[PostMortemDebate] event#{ev_id} ({row['ticker']}) Phase 3 synthesis — "
            f"{model_a}: {tags_a_str or 'none'} vs {model_b}: {tags_b_str or 'none'}"
        )

        valid_tags_list = ", ".join(sorted(VALID_PM_TYPES - {"none"}))
        synthesis_prompt = (
            f"Two models independently classified a closed ASX trade and disagreed.\n\n"
            f"TRADE: {summary}\n\n"
            f"--- {model_a} ---\n"
            f"Tags: {tags_a_str or 'none'}\n"
            f"Reason: {reason_a}\n\n"
            f"--- {model_b} ---\n"
            f"Tags: {tags_b_str or 'none'}\n"
            f"Reason: {reason_b}\n\n"
            f"Your task: produce the SINGLE BEST error classification by reconciling "
            f"both assessments. Consider each model's reasoning on its merits — do not "
            f"default to either model's answer without justification.\n\n"
            f"Valid tags: {valid_tags_list}\n"
            "Root-cause rule: if stop_too_tight explains poor_rr, use stop_too_tight only.\n"
            "\n"
            'Reply with JSON only: {"error_type":"TAG1,TAG2","reason":"why you chose these tags over the alternative, citing specific numbers"}\n'
            "No markdown, no explanation outside JSON."
        )

        res_synth = _call_model_any(model_a, synthesis_prompt, timeout=tout)
        current_app.logger.info(
            f"[PostMortemDebate] event#{ev_id} Phase 3 done ({int((time.time()-t2)*1000)}ms)"
        )

        transcript["phase_3"] = {
            "synthesis_model": model_a,
            "raw": (res_synth.get("text", "")[:600] if res_synth["ok"] else res_synth.get("error", "")),
        }

        # Default fallback — use whichever Phase 1 result is non-empty
        final_tags   = tags_a_str or tags_b_str
        final_reason = reason_a or reason_b
        final_source = "debated"

        if res_synth["ok"]:
            synth_raw = res_synth["text"].strip()
            synth_raw = _strip_think_tags(synth_raw)
            synth_raw = re.sub(r"^```[a-z]*\n?", "", synth_raw)
            synth_raw = re.sub(r"\n?```$",       "", synth_raw)
            synth_tags, synth_reason = _pm_parse(synth_raw, ev_id, model_a, label="/synthesis")
            if synth_tags:
                final_tags   = synth_tags
                final_reason = synth_reason
                final_source = "debated-synthesis"

            transcript["phase_3"]["final_tags"] = final_tags
            transcript["phase_3"]["reason"]     = final_reason

    # Logical-consistency check — strip tags that contradict trade numbers
    # (e.g. 'stop_too_tight' on a 43%-distance stop). Applied AFTER all phases
    # so it catches contradictions whether they came from Phase 1, merged, or
    # the Phase 3 challenge round.
    final_tags = _pm_sanity_check_tags(final_tags, row, ev_id, label="Debate")

    transcript["verdict"]    = verdict
    transcript["final_tags"] = final_tags

    elapsed_ms = int((time.time() - t0) * 1000)
    current_app.logger.info(
        f"[PostMortemDebate] event#{ev_id} ({row['ticker']}) → {verdict} "
        f"| final={final_tags or 'none'} in {elapsed_ms}ms"
    )

    # Persist results — only store if we have an actual tag (not 'none' or empty)
    if final_tags and final_tags != "none":
        try:
            with get_db() as conn:
                conn.execute(
                    """UPDATE ai_learning_events
                          SET error_type=?, error_type_source=?, postmortem_debate=?
                        WHERE id=?""",
                    (final_tags, final_source, json.dumps(transcript), ev_id)
                )
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    return jsonify({
        "ok":                True,
        "id":                ev_id,
        "error_type":        final_tags or "none",
        "error_type_source": final_source,
        "reason":            final_reason,
        "verdict":           verdict,
        "model_a":           model_a,
        "model_b":           model_b,
        "debate":            transcript,
        "elapsed_ms":        elapsed_ms,
    })


@bp.route("/api/debate/adjudicate", methods=["POST"])
def debate_adjudicate():
    """
    Cloud-model adjudicator for a stored adversarial debate transcript.

    User-initiated only — fires when the user clicks 🧑‍⚖️ on a debate row.
    Reads the stored postmortem_debate JSON, asks a cloud model (Gemini or
    Groq, auto-detected from configured API keys) to score each local model's
    reasoning 0-10 and pick a winner. Result is persisted as a new `phase_4`
    block in the transcript, and error_type is updated if the adjudicator
    picks a winner with new tags.

    Request:  {"id": 123}
    Response: {
      "ok": true, "id": 123,
      "provider": "gemini", "model": "gemini-2.0-flash",
      "winner": "A" | "B" | "neither",
      "score_a": 7, "score_b": 4,
      "final_tags": "stop_too_tight,poor_rr",
      "reason": "Model A engaged with the R:R numbers; B was generic.",
      "error_type": "stop_too_tight,poor_rr",
      "error_type_source": "adjudicated"
    }
    """
    data  = request.get_json() or {}
    ev_id = data.get("id")
    if not ev_id:
        return jsonify({"ok": False, "error": "id required"}), 400

    # Auto-detect provider from stored API keys
    cfg = _get_adjudicator_provider()
    if not cfg["provider"]:
        return jsonify({
            "ok": False,
            "error": "No cloud adjudicator configured. Set a Gemini or Groq API key "
                     "in News Scanner → Settings.",
        }), 400

    # Load the event + its stored debate transcript
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT * FROM ai_learning_events WHERE id=?", (ev_id,)
            ).fetchone()
    except Exception as ex:
        return jsonify({"ok": False, "error": str(ex)}), 500

    if not row:
        return jsonify({"ok": False, "error": "event not found"}), 404
    if not row["postmortem_debate"]:
        return jsonify({"ok": False, "error": "no stored debate to adjudicate"}), 400

    try:
        transcript = json.loads(row["postmortem_debate"])
    except Exception as ex:
        return jsonify({"ok": False, "error": f"could not parse stored debate: {ex}"}), 500

    p1      = transcript.get("phase_1") or {}
    model_a = p1.get("model_a", "Model A")
    model_b = p1.get("model_b", "Model B")
    tags_a  = p1.get("tags_a", "(none)")
    tags_b  = p1.get("tags_b", "(none)")
    reason_a = p1.get("reason_a", "")
    reason_b = p1.get("reason_b", "")

    # Build trade summary from row (don't trust transcript.trade — old debates
    # may not have it; row is the source of truth either way)
    summary = _pm_build_summary(row)

    # Adjudicator prompt — asks for scores + winner + final tags
    valid_tags_list = ", ".join(sorted(VALID_PM_TYPES - {"none"}))
    prompt = (
        f"You are an expert trading-postmortem adjudicator. Two local models classified "
        f"a closed trade and disagreed. Judge their reasoning quality and pick a winner.\n\n"
        f"TRADE: {summary}\n\n"
        f"--- MODEL A ({model_a}) ---\n"
        f"Tags: {tags_a}\n"
        f"Reason: {reason_a}\n\n"
        f"--- MODEL B ({model_b}) ---\n"
        f"Tags: {tags_b}\n"
        f"Reason: {reason_b}\n\n"
        f"Scoring criteria (0-10 each):\n"
        f"  - Did the model cite specific numbers (R:R, stop distance, P&L)?\n"
        f"  - Is the reasoning internally consistent (e.g. don't call a 40% stop 'tight')?\n"
        f"  - Are the tags well-supported by the trade data?\n"
        f"  - Did the model interpret trade direction (BUY/SELL/TRIM) correctly?\n\n"
        f"Valid tags: {valid_tags_list}\n\n"
        f"Reply with JSON only:\n"
        f'{{"winner":"A"|"B"|"neither","score_a":0-10,"score_b":0-10,'
        f'"final_tags":"TAG1,TAG2","reason":"one or two sentences explaining the judgment"}}\n'
        f"\"neither\" winner means both models missed the real issue — set final_tags to "
        f"what the right tags should be. No markdown, no text outside JSON."
    )

    t0 = time.time()
    current_app.logger.info(
        f"[Adjudicate] event#{ev_id} ({row['ticker']}) via {cfg['provider']}:{cfg['model']}"
    )
    res = _call_cloud_adjudicator(
        cfg["provider"], cfg["api_key"], cfg["model"], prompt, timeout=40
    )
    elapsed_ms = int((time.time() - t0) * 1000)

    if not res["ok"]:
        return jsonify({"ok": False, "error": res["error"]})

    # Parse output (strip markdown fences, allow regex fallback)
    raw = res["text"]
    raw = re.sub(r"^```[a-z]*\n?", "", raw)
    raw = re.sub(r"\n?```$",       "", raw)
    current_app.logger.debug(f"[Adjudicate] raw output for event#{ev_id}: {raw[:300]}")

    winner = ""; score_a = None; score_b = None
    final_tags_raw = ""; reason = ""
    try:
        parsed = json.loads(raw)
        winner         = (parsed.get("winner") or "").upper()
        score_a        = parsed.get("score_a")
        score_b        = parsed.get("score_b")
        final_tags_raw = parsed.get("final_tags", "") or ""
        reason         = parsed.get("reason", "") or ""
    except Exception:
        # Regex fallback
        m_w = re.search(r'"winner"\s*:\s*"([^"]+)"', raw)
        m_a = re.search(r'"score_a"\s*:\s*([0-9.]+)', raw)
        m_b = re.search(r'"score_b"\s*:\s*([0-9.]+)', raw)
        m_t = re.search(r'"final_tags"\s*:\s*"([^"]+)"', raw)
        m_r = re.search(r'"reason"\s*:\s*"([^"]+)"', raw)
        winner         = (m_w.group(1) if m_w else "").upper()
        score_a        = float(m_a.group(1)) if m_a else None
        score_b        = float(m_b.group(1)) if m_b else None
        final_tags_raw = m_t.group(1) if m_t else ""
        reason         = m_r.group(1) if m_r else raw[:200]

    # Validate + sanity-check final tags
    final_tags = _pm_validate_tags(final_tags_raw, ev_id, cfg["model"], label="/adjudicate")
    final_tags = _pm_sanity_check_tags(final_tags, row, ev_id, label="Adjudicate")

    # Clamp scores
    def _clamp(v):
        if v is None: return None
        try: return max(0.0, min(10.0, float(v)))
        except Exception: return None
    score_a = _clamp(score_a)
    score_b = _clamp(score_b)

    # Normalise winner
    if winner not in ("A", "B", "NEITHER"):
        winner = "NEITHER"

    # Append phase_4 to transcript
    transcript["phase_4"] = {
        "provider":   cfg["provider"],
        "model":      cfg["model"],
        "winner":     winner,
        "score_a":    score_a,
        "score_b":    score_b,
        "final_tags": final_tags,
        "reason":     reason,
        "elapsed_ms": elapsed_ms,
    }

    # Persist updated transcript + (if winner) updated error_type
    update_error_type = bool(final_tags) and winner in ("A", "B", "NEITHER")
    try:
        with get_db() as conn:
            if update_error_type:
                conn.execute(
                    """UPDATE ai_learning_events
                          SET error_type=?, error_type_source='adjudicated',
                              postmortem_debate=?
                        WHERE id=?""",
                    (final_tags, json.dumps(transcript), ev_id)
                )
            else:
                conn.execute(
                    """UPDATE ai_learning_events
                          SET postmortem_debate=?
                        WHERE id=?""",
                    (json.dumps(transcript), ev_id)
                )
    except Exception as ex:
        return jsonify({"ok": False, "error": str(ex)}), 500

    current_app.logger.info(
        f"[Adjudicate] event#{ev_id} ({row['ticker']}) → winner={winner} "
        f"A={score_a} B={score_b} tags={final_tags or 'none'} in {elapsed_ms}ms"
    )

    # ── Auto-generate a 1-sentence lesson and store in trading_lessons ───────────
    lesson_text = None
    if final_tags and final_tags != "none" and reason:
        lesson_prompt = (
            f"A trade was closed with the following outcome and analysis:\n"
            f"Trade: {_pm_build_summary(row)}\n"
            f"Root-cause tags: {final_tags}\n"
            f"Analysis: {reason}\n\n"
            "Write ONE concise, actionable trading lesson (max 25 words) that captures the "
            "key learning from this trade. Start with an imperative verb (Avoid, Check, Require, etc.).\n"
            "Reply with the lesson sentence only — no JSON, no markdown, no preamble."
        )
        lesson_res = _call_cloud_adjudicator(
            cfg["provider"], cfg["api_key"], cfg["model"], lesson_prompt, timeout=20
        )
        if lesson_res["ok"]:
            raw_lesson = (lesson_res.get("text") or "").strip()
            raw_lesson = re.sub(r"^```[a-z]*\n?", "", raw_lesson)
            raw_lesson = re.sub(r"\n?```$",       "", raw_lesson).strip()
            # Limit to 200 chars; discard if it looks like JSON
            if raw_lesson and not raw_lesson.startswith("{") and len(raw_lesson) <= 200:
                lesson_text = raw_lesson
                try:
                    with get_db() as conn:
                        conn.execute(
                            """INSERT INTO trading_lessons
                                   (learning_event_id, ticker, sector, regime, lesson_text, source)
                               VALUES (?,?,?,?,?,?)""",
                            (ev_id, row["ticker"], row["sector"], row["regime"],
                             lesson_text, "adjudicated")
                        )
                    current_app.logger.info(
                        f"[Adjudicate] auto-lesson saved for event#{ev_id}: {lesson_text[:60]}"
                    )
                except Exception as ex:
                    current_app.logger.warning(f"[Adjudicate] lesson insert failed: {ex}")

    return jsonify({
        "ok":                True,
        "id":                ev_id,
        "provider":          cfg["provider"],
        "model":             cfg["model"],
        "winner":            winner,
        "score_a":           score_a,
        "score_b":           score_b,
        "final_tags":        final_tags,
        "reason":            reason,
        "lesson":            lesson_text,
        "error_type":        final_tags or "none",
        "error_type_source": "adjudicated" if update_error_type else (row["error_type_source"] or "debated"),
        "elapsed_ms":        elapsed_ms,
    })


@bp.route("/api/debate/adjudicator-status")
def debate_adjudicator_status():
    """Quick check: is a cloud adjudicator available? Used by UI to enable/disable the 🧑‍⚖️ button."""
    cfg = _get_adjudicator_provider()
    return jsonify({
        "available": bool(cfg["provider"]),
        "provider":  cfg["provider"],
        "model":     cfg["model"],
    })


@bp.route("/api/debate/staleness", methods=["POST"])
def debate_staleness():
    """
    Check if a pending recommendation is still valid given current signals.
    Only called for recs that are ≥ 2 days old.

    Request: { ticker, signals, action, confidence, days_ago, model, timeout }
    Response: { ok, verdict:"VALID"|"WEAKENED"|"INVALIDATED", reason, model }
    """
    data    = request.get_json() or {}
    ticker  = data.get("ticker", "?")
    signals = data.get("signals", {})
    action  = data.get("action", "BUY")
    conf    = data.get("confidence")          # 0-1 float or None
    days    = int(data.get("days_ago", 0))
    model   = data.get("model", "qwen3:9b")
    tout    = min(int(data.get("timeout", 40)), 90)

    def _sig(key, dp=2):
        v = signals.get(key)
        return f"{v:.{dp}f}" if v is not None else "?"

    summary = (
        f"{ticker}: Price=${_sig('current_price')}, "
        f"BB%B={_sig('bb_pct_b')}, RSI={_sig('rsi_14',1)}, "
        f"ADX={_sig('adx_14',1)}, VolZ={_sig('volume_z_score',1)}, "
        f"OBV={signals.get('obv_trend','?')}, "
        f"5D={_sig('return_5d',1)}%"
    )
    conf_str = f"{conf:.0%}" if conf is not None else "?"

    prompt = (
        f"Pending ASX recommendation: {action} {ticker}, "
        f"AI confidence {conf_str}, generated {days} day(s) ago.\n"
        f"Current signals: {summary}\n\n"
        "Is this setup still valid today?\n"
        "  VALID       - signals still support the original thesis\n"
        "  WEAKENED    - setup has partially deteriorated, proceed with caution\n"
        "  INVALIDATED - original thesis is no longer supported by current signals\n"
        "\n"
        'Reply with JSON only: {"verdict":"VALID|WEAKENED|INVALIDATED","reason":"one sentence"}\n'
        "No markdown, no explanation outside JSON."
    )

    result = _call_ollama(model, prompt, timeout=tout, retries=0, think=False)
    if not result["ok"]:
        return jsonify({"ok": False, "error": result["error"]})

    raw = result["text"].strip()
    raw = _strip_think_tags(raw)
    raw = re.sub(r"^```[a-z]*\n?", "", raw)
    raw = re.sub(r"\n?```$",       "", raw)
    try:
        parsed  = json.loads(raw)
        verdict = parsed.get("verdict", "").upper()
        reason  = parsed.get("reason", "")
    except Exception:
        m       = re.search(r'"verdict"\s*:\s*"([^"]+)"', raw, re.IGNORECASE)
        verdict = m.group(1).upper() if m else ""
        m2      = re.search(r'"reason"\s*:\s*"([^"]+)"', raw)
        reason  = m2.group(1) if m2 else raw[:100]

    VALID_VERDICTS = {"VALID", "WEAKENED", "INVALIDATED"}
    if verdict not in VALID_VERDICTS:
        verdict = "WEAKENED"   # conservative default for unexpected output

    current_app.logger.info(f"[Staleness] {action} {ticker} ({days}d old) → {verdict} via {model}")
    return jsonify({"ok": True, "verdict": verdict, "reason": reason, "model": model})


@bp.route("/api/debate/skill", methods=["POST"])
def debate_skill():
    """
    Score a closed trade's outcome quality (skill vs luck) using local model.
    Stores result in skill_score column (0-10).

    Request: { id, model, timeout }
    Response: { ok, id, skill_score, reason, model }
    """
    data  = request.get_json() or {}
    ev_id = data.get("id")
    if not ev_id:
        return jsonify({"ok": False, "error": "id required"}), 400

    model = data.get("model", "qwen3:9b")
    tout  = min(int(data.get("timeout", 45)), 90)

    with get_db() as conn:
        row = conn.execute(
            """SELECT ticker, recommendation, ai_confidence, ensemble_confidence,
                      outcome_status, realized_pnl_pct, exit_reason, regime,
                      holding_period_days, rationale_summary, entry_signals_json
               FROM ai_learning_events WHERE id=?""",
            (ev_id,)
        ).fetchone()

    if not row:
        return jsonify({"ok": False, "error": "Event not found"}), 404

    outcome = row["outcome_status"]
    CLOSED  = {"win", "loss", "breakeven"}
    if outcome not in CLOSED:
        return jsonify({"ok": False, "error": f"Event is '{outcome}' — skill score only for closed trades"}), 400

    # Build compact trade summary
    conf_str = f"{row['ai_confidence']:.0%}" if row["ai_confidence"] is not None else "?"
    pnl_str  = f"{row['realized_pnl_pct']:+.1f}%" if row["realized_pnl_pct"] is not None else "?"
    summary  = (
        f"{row['recommendation']} {row['ticker']}, confidence {conf_str}, "
        f"regime {row['regime'] or '?'}, held {row['holding_period_days'] or '?'}d, "
        f"exit {row['exit_reason'] or '?'}, outcome: {outcome}, P&L: {pnl_str}"
    )
    rationale = (row["rationale_summary"] or "").strip()[:200]

    # D6: extract entry signals for skill scoring context
    entry_signals_str = ""
    try:
        esj = row["entry_signals_json"]
        if esj:
            sigs = json.loads(esj)
            entry_signals_str = ", ".join(
                f"{k}={v}" for k, v in sigs.items() if v is not None
            )
    except Exception:
        pass

    prompt = (
        f"ASX closed trade: {summary}\n"
        + (f"Original AI reasoning: {rationale}\n" if rationale else "")
        + (f"Entry signals at the time: {entry_signals_str}\n" if entry_signals_str else "")
        + "\n"
        "Rate 0–10: how much does this outcome reflect the QUALITY of the analysis "
        "(vs random market luck)?\n"
        "  0 = pure luck / random market movement\n"
        "  5 = mixed — analysis was reasonable but luck played a role\n"
        " 10 = outcome fully explained by the signals and thesis\n"
        "\n"
        'Reply with JSON only: {"skill_score":7,"reason":"one sentence"}\n'
        "No markdown."
    )

    # think=False: suppress thinking tokens; num_predict=350 gives headroom for
    # the JSON wrapper + a full reason sentence without truncation
    result = _call_ollama(model, prompt, timeout=tout, retries=0, think=False, num_predict=350)
    if not result["ok"]:
        return jsonify({"ok": False, "error": result["error"]})

    raw = result["text"].strip()
    raw = _strip_think_tags(raw)          # safety net: strip any residual think tags
    current_app.logger.debug(f"[Skill] raw output for event#{ev_id}: {repr(raw[:200])}")
    raw = re.sub(r"^```[a-z]*\n?", "", raw)
    raw = re.sub(r"\n?```$",       "", raw)
    try:
        parsed     = json.loads(raw)
        skill_raw  = parsed.get("skill_score")
        reason     = parsed.get("reason", "")
    except Exception:
        # Fallback 1: JSON field anywhere in text
        m         = re.search(r'"skill_score"\s*:\s*([0-9.]+)', raw)
        skill_raw = float(m.group(1)) if m else None
        m2        = re.search(r'"reason"\s*:\s*"([^"]+)"', raw)
        reason    = m2.group(1) if m2 else ""
        # Fallback 2: prose forms — "7/10", "7 out of 10", "score: 7"
        if skill_raw is None:
            m3 = re.search(r'\b(\d+(?:\.\d+)?)\s*/\s*10\b', raw)
            if not m3:
                m3 = re.search(r'\b(\d+(?:\.\d+)?)\s+out\s+of\s+10\b', raw, re.IGNORECASE)
            if not m3:
                m3 = re.search(r'\bscore[:\s]+(\d+(?:\.\d+)?)\b', raw, re.IGNORECASE)
            skill_raw = float(m3.group(1)) if m3 else None

    try:
        skill_score = max(0.0, min(10.0, float(skill_raw)))
    except (TypeError, ValueError):
        current_app.logger.warning(
            f"[Skill] parse failure for event#{ev_id} via {model} — raw: {repr(raw[:200])}"
        )
        return jsonify({"ok": False,
                        "error": f"Could not parse skill_score from model output: {raw[:120]!r}"})

    try:
        with get_db() as conn:
            conn.execute(
                "UPDATE ai_learning_events SET skill_score=? WHERE id=?",
                (round(skill_score, 1), ev_id)
            )
        current_app.logger.info(
            f"[Skill] event#{ev_id} ({row['ticker']}) → {skill_score:.1f}/10 via {model}"
            + (f" | {reason[:60]}" if reason else "")
        )
    except Exception as ex:
        return jsonify({"ok": False, "error": str(ex)}), 500

    return jsonify({
        "ok":          True,
        "id":          ev_id,
        "skill_score": round(skill_score, 1),
        "reason":      reason,
        "model":       model,
    })


# ── Claude API proxy lives in routes/claude.py (registered below) ─────────────


