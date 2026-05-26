"""
routes/debate.py — Internal debate engine (local Ollama).

Generates a structured bull/bear debate before Claude analyses a ticker, plus
postmortem analysis on closed trades and skill scoring. Degrades gracefully
when Ollama is not running.

Endpoints:
  /api/debate/status              GET    — Ollama reachable + available models
  /api/debate                     POST   — bull+bear debate for one ticker
  /api/debate/postmortem          POST   — postmortem on a closed event
  /api/debate/postmortem-debate   POST   — adversarial 2-model postmortem
  /api/debate/staleness           POST   — re-check pending recs for invalidation
  /api/debate/skill                POST   — 0-10 quality score for an event
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
    """
    status = row["outcome_status"]
    return (
        f"{row['recommendation'] or '?'} {row['ticker']} {status.upper()}"
        + (f" | PnL={row['realized_pnl_pct']:.1f}%"           if row["realized_pnl_pct"]    is not None else "")
        + (f" | hold={row['holding_period_days']}d"             if row["holding_period_days"] is not None else "")
        + (f" | AI_conf={row['ai_confidence']:.0%}"             if row["ai_confidence"]       is not None else "")
        + (f" | RR={row['rr_ratio']:.1f}"                       if row["rr_ratio"]            is not None else "")
        + (f" | entry={row['actual_entry_price']:.3f}"          if row["actual_entry_price"]  is not None else "")
        + (f" | stop={row['suggested_stop']:.3f}"               if row["suggested_stop"]      is not None else "")
        + (f" | target={row['suggested_target']:.3f}"           if row["suggested_target"]    is not None else "")
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
                     entry_signals_str: str = "") -> str:
    """Full postmortem classification prompt. D5: accepts entry_signals_str."""
    return (
        f"ASX closed trade (LOSS or BREAKEVEN): {summary}\n"
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
        'Reply with JSON only: {"error_type":"TAG1,TAG2","reason":"one clear sentence citing specific numbers"}\n'
        "No markdown, no explanation outside JSON."
    )


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
    prompt = _pm_build_prompt(summary, rationale, exit_hint, entry_signals_str)

    # think=False: suppress thinking tokens so they don't eat num_predict budget
    # retries=0 — timeout means model is too slow; caller should switch to a smaller model
    result = _call_ollama(model, prompt, timeout=tout, retries=0, think=False)
    if not result["ok"]:
        return jsonify({"ok": False, "id": ev_id, "error": result["error"]})

    error_type, reason = _pm_parse(result["text"].strip(), ev_id, model)

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
    base_prompt = _pm_build_prompt(summary, rationale, exit_hint, entry_signals_str)

    # ── Phase 1: Independent classification ───────────────────────────────────
    t0    = time.time()
    current_app.logger.info(f"[PostMortemDebate] event#{ev_id} ({row['ticker']}) Phase 1A — {model_a}…")
    res_a = _call_ollama(model_a, base_prompt, timeout=tout, retries=0, think=False)
    current_app.logger.info(f"[PostMortemDebate] event#{ev_id} Phase 1A done ({int((time.time()-t0)*1000)}ms)")

    t1 = time.time()
    current_app.logger.info(f"[PostMortemDebate] event#{ev_id} ({row['ticker']}) Phase 1B — {model_b}…")
    res_b = _call_ollama(model_b, base_prompt, timeout=tout, retries=0, think=False)
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
        # ── Phase 3: Challenge round (full divergence only) ───────────────────
        verdict = "DIVERGED"
        t2 = time.time()
        current_app.logger.info(
            f"[PostMortemDebate] event#{ev_id} ({row['ticker']}) Phase 3 — "
            f"challenging {model_a}: {tags_a_str or 'none'} vs {model_b}: {tags_b_str or 'none'}"
        )
        challenge_prompt = (
            f"You previously classified this trade as: {tags_a_str or 'none'}\n"
            f"Your reason: {reason_a}\n\n"
            f"Another model ({model_b}) classified it as: {tags_b_str or 'none'}\n"
            f"Their reason: {reason_b}\n\n"
            "Trade summary for reference:\n"
            f"{summary}\n\n"
            "Do you maintain your classification, or concede to the other model?\n"
            'Respond with JSON only: {"maintain":true,"final_tags":"TAG1,TAG2","reason":"one sentence"}\n'
            'To concede: {"maintain":false,"final_tags":"TAG1,TAG2","reason":"one sentence"}\n'
            "No markdown, no explanation outside JSON."
        )
        res_ch = _call_ollama(model_a, challenge_prompt, timeout=tout, retries=0, think=False)
        current_app.logger.info(f"[PostMortemDebate] event#{ev_id} Phase 3 done ({int((time.time()-t2)*1000)}ms)")

        transcript["phase_3"] = {
            "challenger": model_a,
            "raw": (res_ch.get("text", "")[:300] if res_ch["ok"] else res_ch["error"]),
        }

        # Default if challenge call fails or parse fails — A keeps its tags
        final_tags   = tags_a_str
        final_reason = reason_a
        final_source = "debated"

        if res_ch["ok"]:
            ch_raw = res_ch["text"].strip()
            ch_raw = _strip_think_tags(ch_raw)
            ch_raw = re.sub(r"^```[a-z]*\n?", "", ch_raw)
            ch_raw = re.sub(r"\n?```$",       "", ch_raw)
            try:
                ch = json.loads(ch_raw)
                maintains = bool(ch.get("maintain", True))
                ch_tags   = ch.get("final_tags", "")
                ch_reason = ch.get("reason", "")
            except Exception:
                m_m       = re.search(r'"maintain"\s*:\s*(true|false)', ch_raw, re.I)
                maintains = (m_m.group(1).lower() == "true") if m_m else True
                m_t       = re.search(r'"final_tags"\s*:\s*"([^"]+)"', ch_raw)
                ch_tags   = m_t.group(1) if m_t else tags_a_str
                m_r       = re.search(r'"reason"\s*:\s*"([^"]+)"', ch_raw)
                ch_reason = m_r.group(1) if m_r else ""

            transcript["phase_3"]["maintains"]  = maintains
            transcript["phase_3"]["final_tags"] = ch_tags

            if maintains:
                # Validate A's possibly-refined final tags directly (no JSON roundtrip)
                clean_tags  = _pm_validate_tags(ch_tags or tags_a_str, ev_id, model_a, label="/challenge")
                final_tags   = clean_tags or tags_a_str
                final_reason = ch_reason or reason_a
            else:
                # A conceded — use B's tags
                final_tags   = tags_b_str
                final_reason = f"Conceded to {model_b}: {ch_reason or reason_b}"

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


