"""
finbert_engine.py
=================
FinBERT financial sentiment scoring — ProsusAI/finbert (110M params, ~440 MB).

Backends (tried in order):
  1. ONNX Runtime via optimum  — fastest CPU inference, small memory footprint
                                  (~20-50 ms/article vs ~60-120 ms PyTorch)
  2. PyTorch via transformers  — standard fallback

The model is downloaded once to ~/.cache/huggingface/hub/ on first call
and kept in memory for the lifetime of the process (zero reload overhead).

Install (preferred — ONNX):
    pip install transformers optimum[onnxruntime] onnxruntime

Install (fallback — PyTorch):
    pip install transformers torch

Usage:
    import finbert_engine as fb

    result = fb.score("CBA reports record NPAT of $5.1B, up 12% on pcp")
    # {"label": "positive", "score": 0.974,
    #  "positive": 0.974, "negative": 0.012, "neutral": 0.014}

    results = fb.score_batch(["CBA profit up 12%", "WBC faces probe"])
    # [{"label": "positive", ...}, {"label": "negative", ...}]

    fb.is_available()  # True / False — depends on installed deps
    fb.backend()       # "onnx" | "pytorch" | None
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

log = logging.getLogger(__name__)

_MODEL_NAME = "ProsusAI/finbert"

# Input truncation: FinBERT has a 512-token limit (~512 chars ≈ 100-130 tokens).
# We feed title + first ~300 chars of content, so 512 chars is generous.
_MAX_CHARS = 512

# ── Module-level state (populated lazily on first call) ───────────────────────
_pipeline  = None          # loaded HuggingFace pipeline object
_backend   = None          # "onnx" | "pytorch" | None
_load_lock = threading.Lock()
_available: Optional[bool] = None   # None = not yet probed

# ── Dependency detection ──────────────────────────────────────────────────────

_HAS_TRANSFORMERS = False
_HAS_ONNX         = False
_HAS_TORCH        = False

try:
    import transformers  # noqa: F401
    _HAS_TRANSFORMERS = True
except ImportError:
    pass

if _HAS_TRANSFORMERS:
    try:
        from optimum.onnxruntime import ORTModelForSequenceClassification  # noqa: F401
        import onnxruntime  # noqa: F401
        _HAS_ONNX = True
    except ImportError:
        pass

    if not _HAS_ONNX:
        try:
            import torch  # noqa: F401
            _HAS_TORCH = True
        except ImportError:
            pass


# ── Public helpers ────────────────────────────────────────────────────────────

def is_available() -> bool:
    """Return True if FinBERT can be loaded (correct deps installed)."""
    return _HAS_TRANSFORMERS and (_HAS_ONNX or _HAS_TORCH)


def backend() -> Optional[str]:
    """Return the active inference backend name once loaded."""
    return _backend


def install_hint() -> str:
    """Return a pip install hint appropriate for the current environment."""
    if _HAS_ONNX:
        return ""  # already installed
    if _HAS_TORCH:
        return ""
    return "pip install transformers optimum[onnxruntime] onnxruntime"


# ── Internal: lazy model loader ───────────────────────────────────────────────

def _load() -> bool:
    """Load FinBERT into memory (thread-safe). Returns True on success."""
    global _pipeline, _backend, _available

    if _pipeline is not None:
        return True

    with _load_lock:
        if _pipeline is not None:  # double-checked locking
            return True

        if not _HAS_TRANSFORMERS:
            log.warning(
                "finbert_engine: transformers not installed. "
                "Run: pip install transformers optimum[onnxruntime] onnxruntime"
            )
            _available = False
            return False

        # ── Attempt 1: ONNX Runtime via optimum ──────────────────────────────
        if _HAS_ONNX:
            try:
                log.info("finbert_engine: loading %s via ONNX Runtime…", _MODEL_NAME)
                from optimum.onnxruntime import ORTModelForSequenceClassification
                from transformers import AutoTokenizer
                from transformers import pipeline as hf_pipeline

                # export=True auto-converts to ONNX on first call and caches
                model     = ORTModelForSequenceClassification.from_pretrained(
                    _MODEL_NAME, export=True
                )
                tokenizer = AutoTokenizer.from_pretrained(_MODEL_NAME)
                _pipeline = hf_pipeline(
                    "text-classification",
                    model=model,
                    tokenizer=tokenizer,
                    top_k=None,   # return scores for all labels
                    device=-1,    # CPU
                )
                _backend   = "onnx"
                _available = True
                log.info("finbert_engine: ready (ONNX Runtime backend)")
                return True
            except Exception as exc:
                log.warning(
                    "finbert_engine: ONNX load failed (%s) — trying PyTorch…", exc
                )

        # ── Attempt 2: PyTorch fallback ───────────────────────────────────────
        if _HAS_TORCH:
            try:
                log.info("finbert_engine: loading %s via PyTorch…", _MODEL_NAME)
                from transformers import pipeline as hf_pipeline
                _pipeline = hf_pipeline(
                    "text-classification",
                    model=_MODEL_NAME,
                    top_k=None,   # return scores for all labels
                    device=-1,    # CPU
                )
                _backend   = "pytorch"
                _available = True
                log.info("finbert_engine: ready (PyTorch backend)")
                return True
            except Exception as exc:
                log.warning("finbert_engine: PyTorch load failed: %s", exc)

        _available = False
        return False


def _parse(scores: list[dict]) -> dict:
    """Convert HF top_k output list → normalised result dict.

    Args:
        scores: list of {"label": str, "score": float} — one per class.

    Returns:
        {"label": str, "score": float,
         "positive": float, "negative": float, "neutral": float}
    """
    label_map: dict[str, float] = {}
    for item in scores:
        label_map[item["label"].lower()] = round(float(item["score"]), 4)

    positive = label_map.get("positive", 0.0)
    negative = label_map.get("negative", 0.0)
    neutral  = label_map.get("neutral",  0.0)

    best_label = max(label_map, key=label_map.get)
    best_score = label_map[best_label]

    return {
        "label":    best_label,       # "positive" | "negative" | "neutral"
        "score":    best_score,       # confidence of the best label (0-1)
        "positive": positive,
        "negative": negative,
        "neutral":  neutral,
    }


# ── Public scoring API ────────────────────────────────────────────────────────

def score(text: str) -> Optional[dict]:
    """Score a single text with FinBERT.

    Returns a result dict on success, or None if FinBERT is unavailable.

    Result keys:
        label    — "positive" | "negative" | "neutral"
        score    — confidence of best label, 0.0–1.0
        positive — raw positive probability
        negative — raw negative probability
        neutral  — raw neutral probability
    """
    if not _load():
        return None
    try:
        # top_k=None → list[list[dict]] even for single input
        raw = _pipeline(text[:_MAX_CHARS])
        return _parse(raw[0])
    except Exception as exc:
        log.debug("finbert_engine.score error: %s", exc)
        return None


def score_batch(texts: list[str]) -> list[Optional[dict]]:
    """Score a list of texts. Returns one result per input (None on error).

    Uses the HF pipeline's batched mode — significantly faster than
    calling score() in a loop for large batches.
    """
    if not texts:
        return []
    if not _load():
        return [None] * len(texts)
    try:
        truncated  = [t[:_MAX_CHARS] for t in texts]
        raw_batch  = _pipeline(truncated)   # list[list[dict]] with top_k=None
        return [_parse(raw) for raw in raw_batch]
    except Exception as exc:
        log.debug("finbert_engine.score_batch error: %s", exc)
        return [None] * len(texts)


def sentiment_to_score(result: Optional[dict]) -> Optional[float]:
    """Convert FinBERT result → signed score in [-1.0, +1.0].

    Useful for storing in sentiment_score columns that expect a signed float.
        positive → +score  (e.g. +0.97)
        negative → -score  (e.g. -0.88)
        neutral  →  0.0
    """
    if result is None:
        return None
    label = result.get("label", "")
    raw   = result.get("score", 0.0)
    if label == "positive":
        return +raw
    if label == "negative":
        return -raw
    return 0.0
