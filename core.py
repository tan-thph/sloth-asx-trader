"""
core.py — Shared infrastructure for asx_server and its route blueprints.

Anything that multiple route files need (TTL cache, HTTP session, logger,
data constants) lives here. Pure values + side-effect-free decorators only —
no Flask, no DB writes at import time.
"""

import logging
import re
import threading
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Callable

import requests


# ── Paths ──────────────────────────────────────────────────────────────────────

ROOT_DIR = Path(__file__).parent
LOG_DIR  = ROOT_DIR / "ai_responses"
LOG_DIR.mkdir(exist_ok=True)


# ── Logging ────────────────────────────────────────────────────────────────────
# Structured logger with daily rotation to ai_responses/server.log.

_LOG_FMT = "%(asctime)s %(levelname)-5s %(name)-12s %(message)s"
logging.basicConfig(level=logging.INFO, format=_LOG_FMT, datefmt="%H:%M:%S")

_file_handler = RotatingFileHandler(
    LOG_DIR / "server.log", maxBytes=2_000_000, backupCount=5, encoding="utf-8"
)
_file_handler.setFormatter(logging.Formatter(_LOG_FMT, datefmt="%Y-%m-%d %H:%M:%S"))
_file_handler.setLevel(logging.INFO)
# Only attach once — re-imports during testing should not duplicate handlers.
if not any(isinstance(h, RotatingFileHandler) for h in logging.getLogger().handlers):
    logging.getLogger().addHandler(_file_handler)

log = logging.getLogger("asx")
logging.getLogger("yfinance").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("werkzeug").setLevel(logging.WARNING)


def classify_llm_http_error(status_code, body_text):
    """Classify a non-200 LLM provider HTTP response as rate-limit / token-limit /
    other, from status code + response body alone (Groq/Gemini call sites use
    raw `requests` — no SDK exception types to distinguish these for us).
    Matches known error `type`/`status` fields first (Groq mirrors OpenAI's
    {"error":{"type":"rate_limit_exceeded"|...}}; Gemini returns
    {"error":{"status":"RESOURCE_EXHAUSTED"|...}}), falling back to substring
    matching on the raw text. Returns a short human-readable label for logging —
    never raises, since body_text may not be JSON.
    """
    text = (body_text or "")
    low = text.lower()
    if status_code == 429 or "rate_limit" in low or "resource_exhausted" in low or "rate limit" in low:
        return "RATE_LIMIT"
    if ("context_length" in low or "context window" in low or "token" in low and "limit" in low
            or "too many tokens" in low or "maximum context" in low):
        return "TOKEN_LIMIT"
    return f"HTTP_{status_code}"


# ── TTL cache decorator ───────────────────────────────────────────────────────
# Simple in-process memoiser. Thread-safe via a single lock.
# Key is (func.__name__, args, frozenset(kwargs.items())).

_cache_lock = threading.Lock()
_cache_store: dict = {}
_MAX_CACHE_SIZE = 2000   # Improvement A: cap to prevent unbounded growth on long-running server


def _evict_cache(now: float) -> None:
    """Remove expired entries and enforce the size cap (call inside _cache_lock)."""
    # 1. Remove entries that have already expired
    expired = [k for k, v in _cache_store.items() if v[1] <= now]
    for k in expired:
        del _cache_store[k]
    # 2. If still over the cap, evict oldest-expiring entries
    if len(_cache_store) > _MAX_CACHE_SIZE:
        oldest = sorted(_cache_store.items(), key=lambda x: x[1][1])
        for k, _ in oldest[:len(_cache_store) - _MAX_CACHE_SIZE]:
            del _cache_store[k]


def ttl_cache(seconds: int):
    """Memoise a function's return value for `seconds` seconds.

    Thread-safe via a single lock. Improvement A: proactively evicts expired
    entries and caps the store at _MAX_CACHE_SIZE to prevent unbounded growth
    during long-running gunicorn sessions scanning 200+ tickers.
    """
    def deco(fn):
        def wrapper(*args, **kwargs):
            key = (fn.__name__, args, tuple(sorted(kwargs.items())))
            now = time.time()
            with _cache_lock:
                _evict_cache(now)                  # Improvement A: proactive eviction
                entry = _cache_store.get(key)
                if entry and entry[1] > now:
                    return entry[0]
            value = fn(*args, **kwargs)
            with _cache_lock:
                _cache_store[key] = (value, now + seconds)
            return value
        wrapper.__name__ = fn.__name__
        wrapper.cache_clear = lambda: _cache_store.clear()
        return wrapper
    return deco


# ── yfinance retry + stale-cache fallback ────────────────────────────────────
# Module-level store: last-good result per cache key (string → any).
# Populated by fetch_with_retry; returned on full failure so callers stay alive.
_last_good: dict[str, Any] = {}


def _http_status(exc: Exception) -> int | None:
    """Extract HTTP status code from requests or urllib exceptions, or None."""
    if isinstance(exc, requests.exceptions.HTTPError) and exc.response is not None:
        return exc.response.status_code
    if hasattr(exc, "code") and isinstance(exc.code, int):  # urllib.error.HTTPError
        return exc.code
    return None


def fetch_with_retry(
    fn: Callable,
    *args,
    cache_key: str = "",
    max_retries: int = 3,
    backoff: float = 2.0,
    **kwargs,
) -> Any:
    """Call fn(*args, **kwargs) with exponential-backoff retries.

    On complete failure, returns the last successful result stored under
    cache_key (or raises the last exception if no prior result exists).
    Always updates _last_good[cache_key] on success.

    4xx errors (except 429) are not retried — Yahoo returning 400 Bad Request
    means the request itself is malformed; retrying wastes time and never fixes it.
    429 and 5xx are retried with exponential backoff; 429 gets a minimum 5s sleep.
    """
    last_exc: Exception | None = None
    for attempt in range(max_retries):
        try:
            result = fn(*args, **kwargs)
            if cache_key:
                _last_good[cache_key] = result
            return result
        except Exception as exc:
            last_exc = exc
            status = _http_status(exc)
            # 4xx (except 429) = client error; retrying won't help
            if status is not None and 400 <= status < 500 and status != 429:
                log.warning("fetch_with_retry: HTTP %s for %s — skipping retries", status, cache_key or fn)
                break
            if attempt < max_retries - 1:
                sleep_time = backoff ** attempt
                if status == 429:
                    sleep_time = max(sleep_time, 5.0)  # back off harder on rate-limit
                time.sleep(sleep_time)

    # All retries exhausted (or short-circuited) — serve stale data if available
    if cache_key and cache_key in _last_good:
        log.warning("fetch_with_retry: all retries failed for %s — serving stale cache. err: %s", cache_key, last_exc)
        return _last_good[cache_key]
    raise last_exc  # type: ignore[misc]


# ── Shared HTTP session ───────────────────────────────────────────────────────
# Module-level requests.Session = HTTP keep-alive + connection pooling.
# yfinance and any other outbound HTTP picks this up via _HTTP_SESSION directly.

_HTTP_SESSION = requests.Session()
_HTTP_SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; SlothASXTrader/2.0)"
})
_adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=50, max_retries=2)
_HTTP_SESSION.mount("http://",  _adapter)
_HTTP_SESSION.mount("https://", _adapter)


# ── Ollama base URL (debate engine + local LLM news classifier) ──────────────

OLLAMA_BASE = "http://localhost:11434"


# ── Stooq price fallback ──────────────────────────────────────────────────────
# Free, no API key. Used when yfinance is completely down and _last_good is
# also empty (i.e. first-ever fetch on this server start).
# Rate limit: ~1 req/sec (undocumented). Safe at our TTL windows (45s quote,
# 5min macro) — never called concurrently under normal operation.

# Stooq has an undocumented ~1 req/sec rate limit. Concurrent batch requests
# return empty CSVs silently. This semaphore serialises all Stooq calls across
# both core.py (stooq_quote) and indicators.py (_fetch_stooq_history).
_stooq_sem = threading.BoundedSemaphore(1)

_STOOQ_MAP: dict[str, str] = {
    "^AXJO":    "^axjo",
    "^GSPC":    "^spx",
    "^IXIC":    "^ndq",
    "^DJI":     "^dji",
    "^VIX":     "^vix",
    # ^TNX (US 10Y yield) — Stooq's ^tnx URL returns a 404 page; removed.
    # yfinance period='1mo' is reliable for TNX so no fallback needed.
    "AUDUSD=X": "audusd",
    "GC=F":     "gc.f",
    "CL=F":     "cl.f",
    "HG=F":     "hg.f",
    # TIO=F (iron ore) is not available on Stooq.
    # ASX sector indices — ^AX* yfinance symbols map to ^ax* on Stooq.
    "^AXMJ":    "^axmj",   # Materials
    "^AXFJ":    "^axfj",   # Financials
    "^AXHJ":    "^axhj",   # Healthcare
    "^AXEJ":    "^axej",   # Energy
    "^AXRJ":    "^axrj",   # Real Estate
    "^AXIJ":    "^axij",   # Information Technology
    "^AXTJ":    "^axtj",   # Communication Services
}


def adv_slippage(adv_aud: float | None) -> float:
    """ADV-tiered one-way slippage rate. adv_aud = mean(close × volume) over 20d.

    Single source of truth shared by the backtester (liquidity slippage mode),
    `_resolve_virtual_outcomes()` and `_resolve_execution_alpha()` in
    routes/learning.py (§9.2 — virtual fills must not assume perfect execution).
    Unknown/missing ADV falls into the thin-name tier (conservative).
    """
    if adv_aud is None:
        return 0.0035
    try:
        adv_aud = float(adv_aud)
    except (TypeError, ValueError):
        return 0.0035
    if adv_aud >= 10_000_000:
        return 0.0005   # 0.05%
    if adv_aud >= 2_000_000:
        return 0.001    # 0.10%
    if adv_aud >= 500_000:
        return 0.002    # 0.20%
    return 0.0035       # 0.35%


def _to_stooq_sym(yf_symbol: str) -> str | None:
    """Convert a yfinance symbol to its Stooq equivalent, or None if unsupported."""
    if yf_symbol in _STOOQ_MAP:
        return _STOOQ_MAP[yf_symbol]
    if yf_symbol.endswith(".AX"):
        return yf_symbol[:-3].lower() + ".au"
    return None


def stooq_quote(yf_symbol: str) -> dict | None:
    """Fetch the latest price from Stooq as a last-resort fallback.

    Returns {'price': float, 'change_pct': float, '_source': 'stooq'} or None.
    CSV columns: Symbol,Date,Time,Open,High,Low,Close,Volume,Name
    """
    sym = _to_stooq_sym(yf_symbol)
    if sym is None:
        return None
    with _stooq_sem:
        try:
            url = f"https://stooq.com/q/l/?s={sym}&f=sd2t2ohlcvn&e=csv"
            resp = _HTTP_SESSION.get(url, timeout=10)
            resp.raise_for_status()
            lines = resp.text.strip().splitlines()
            if len(lines) < 2:
                return None
            fields = lines[1].split(",")
            if len(fields) < 7:
                return None
            close = float(fields[6])
            open_ = float(fields[3])
            if close <= 0:
                return None
            change_pct = round((close / open_ - 1) * 100, 2) if open_ > 0 else 0.0
            return {"price": round(close, 3), "change_pct": change_pct, "_source": "stooq"}
        except Exception:
            return None
        finally:
            time.sleep(1.0)


# ── Shared impact-score band table (SCORING_FIXES.md X1) ─────────────────────
# One canonical event-type -> impact-band table, referenced by both
# news_engine.py (S2) and announcement_engine.py (S1) so the same event type
# lands in the same 0-10 band regardless of which surface classified it —
# without this, "impact 0-10" meant two different, non-comparable scales.
#
# Small local LLMs do band SELECTION far more reliably than multi-step
# arithmetic. This replaces what used to be either an un-rubric'd anchor
# (announcements seeded a bare "impact":6/8 example with no scale definition)
# or a 4-step additive sum (news: base score + specificity nudge + magnitude
# nudge, summed) that weak quantised models frequently didn't actually follow.
IMPACT_BAND_TABLE: list[tuple[str, tuple[int, int]]] = [
    ("Trading Halt / Suspension",                                    (8, 9)),
    ("Acquisition / Takeover / Merger / Scheme of Arrangement",       (8, 9)),
    ("Capital Raise",                                                (6, 8)),
    ("Earnings / Guidance Update",                                   (6, 8)),
    ("Geopolitical Conflict / Sanctions / Major Trade-Policy Shift",  (5, 8)),
    ("Dividend Change",                                              (5, 7)),
    ("CEO / Board Change",                                           (4, 6)),
    ("RBA / APRA / Macro Policy",                                    (3, 5)),
    ("Asset Sale / Operational Update",                              (3, 5)),
    ("AGM / Admin / Broad Commentary / Other",                       (1, 3)),
]


def impact_band_rubric_text() -> str:
    """Render IMPACT_BAND_TABLE as prompt-ready text, one line per band. Both
    news_engine.py and announcement_engine.py embed this exact text so the two
    prompts can never silently drift onto different scales."""
    return "\n".join(f"{label} → {lo}-{hi}" for label, (lo, hi) in IMPACT_BAND_TABLE)


def impact_floor_for_keywords(text: str) -> float | None:
    """Deterministic, provider-agnostic backstop (SCORING_FIXES.md S2): if
    `text` matches keywords for one of the two highest-severity, most
    reliably keyword-detectable bands (halt/suspension, acquisition/
    takeover), return that band's floor so a weak model's under-scored
    output can't produce an absurdly low impact for a clearly high-severity
    event. Returns None when nothing matches (no opinion on the score)."""
    t = text.lower()
    if any(kw in t for kw in (
        "trading halt", "halt in trading", "suspended from quotation",
        "suspension from trading", "trading suspension",
    )):
        return float(IMPACT_BAND_TABLE[0][1][0])  # Trading Halt / Suspension floor
    if any(kw in t for kw in (
        "takeover", "scheme of arrangement", "to acquire", "acquisition of",
        "merger with", "bid for", "proposed merger",
    )):
        return float(IMPACT_BAND_TABLE[1][1][0])  # Acquisition / Takeover floor
    return None


# ── Market-transmission channels (NEWS_CLASSIFICATION_FIXES.md C1) ───────────
# The channels by which a macro/geopolitical event can actually move a price an
# ASX investor pays or receives. The old rubric told the model to score
# macro/geopolitics on "the magnitude test alone", but every magnitude anchor it
# offered was financial (earnings >5%, deal >$500M, index >2%) and none of those
# fit a conflict story — so the model substituted the only magnitude such an
# article carries: the casualty count. That inverted the scale against market
# impact (a bar fire scored 10.0; the closure of the Strait of Hormuz scored
# 7.0, while the book holds WDS). Requiring a NAMED channel replaces "how big is
# this event" with "how does this reach a price".
TRANSMISSION_CHANNELS: tuple[str, ...] = (
    "oil_gas",       # crude/LNG supply, OPEC, shipping lanes → WDS, STO
    "iron_ore_coal", # China steel demand, supply disruption → BHP, RIO, FMG
    "gold",          # safe-haven bid, central-bank buying → NST, EVN
    "base_metals",   # copper/nickel/lithium demand + supply
    "agriculture",   # grain/livestock export flows
    "aud_fx",        # AUD/USD moves — translates every offshore earner
    "rates_inflation",  # RBA/Fed policy, CPI → banks, REITs, growth multiples
    "trade_policy",  # tariffs/sanctions/quotas touching AU export or import flows
    "shipping_supply_chain",  # freight rates, port/canal/strait closures
    "none",          # no plausible channel — NOT market news
)

TRANSMISSION_NO_CHANNEL = "none"

# Impact ceiling for a macro/geopolitics article with no transmission channel.
# Matches the "AGM / Admin / Broad Commentary / Other" band ceiling — a world
# event that cannot reach a price is, to this book, broad commentary.
NO_TRANSMISSION_IMPACT_CAP = 2.0


# ── Per-category decay half-lives (NEWS_CLASSIFICATION_FIXES.md C5 / critics R5) ──
# Different events stay relevant for different lengths of time: a factory fire is
# stale in days, a rate cycle matters for months. compute_decay() has taken a
# `half_life_days` parameter since it was written, but BOTH call sites used the
# 3.0 default — so a war and a TA puff piece decayed identically, and the
# impact×decay ranking that picks the market_wide tier treated them the same.
#
# WINDOW CAVEAT: get_news_brief reads a 2-3 day window, where decay spans
# 1.0 → ~0.5 (3d half-life) vs 1.0 → ~0.98 (90d). Anything past ~30 days is
# therefore functionally "does not decay in-window" and the exact value is
# cosmetic — 90 vs 180 is 0.977 vs 0.989 at 3 days old. The values below express
# intent (and survive a wider window later); what actually bites is the ORDER:
# technical/analyst < operational/sector/dividend < earnings/merger < macro/geopolitics.
DECAY_HALF_LIFE_DAYS: dict[str, float] = {
    "technical":   2.0,    # "52-week high!" — stale on arrival
    "analyst":     3.0,    # opinion/ratings churn
    "other":       3.0,    # catch-all; matches the previous flat default
    "operational": 7.0,
    "sector":     14.0,
    "dividend":   14.0,
    "earnings":   30.0,
    "merger":     30.0,
    "regulatory": 45.0,
    "geopolitics": 90.0,   # a war is still the story three months on
    "macro":     180.0,    # a rate cycle sets the regime for half a year
}

DECAY_HALF_LIFE_DEFAULT = 3.0  # unchanged from the old flat behaviour


def decay_half_life_for(category: str | None) -> float:
    """Half-life in days for a news category. Unknown/missing category keeps the
    historical flat 3.0, so this can never make an unrecognised row decay slower
    than it does today."""
    return DECAY_HALF_LIFE_DAYS.get((category or "").strip().lower(),
                                    DECAY_HALF_LIFE_DEFAULT)


# ── Channel → portfolio exposure (critics R4, annotation form) ────────────────
# "Who owns this risk?" — name the holdings a transmission channel actually
# reaches, so a macro/geopolitics line reads "Hormuz closed … [exposed: WDS]".
#
# Deliberately an ANNOTATION, not a filter. A 26-ticker book spanning Materials,
# Energy, Financials, Healthcare and REITs matches almost every channel, so
# filtering on exposure would discriminate almost nothing — but telling the
# reader WHICH holdings a channel reaches is real context.
#
# TWO resolutions, because sector is the wrong grain for a commodity:
#
#   Commodity channels (oil_gas/iron_ore_coal/gold/base_metals) use the EXPLICIT
#   per-ticker map below. Sector-level mapping was tried first and produced
#   confident falsehoods — "gold" → Materials → FMG (pure iron ore, zero gold),
#   "oil_gas" → Energy → SMR (met coal, not oil). An annotation that asserts a
#   position is exposed when it isn't is worse than no annotation, because the
#   reader has no way to audit it.
#
#   Broad channels (rates_inflation/agriculture/trade_policy/shipping) use
#   SECTOR_MAP, where sector genuinely IS the transmission grain — a rate move
#   reaches Financials and REITs as sectors, not via any one company's assets.
#
# aud_fx maps to NOTHING on purpose: it touches every offshore earner and every
# USD-revenue miner, so "exposed: <the whole book>" is noise pretending to be
# signal. Better to say nothing than to say everything.

# ASX resource names → the commodity channels they actually carry. Bounded and
# slow-moving; a ticker absent here simply gets no commodity annotation, which
# is the correct failure direction (silence, not a false claim).
TICKER_COMMODITY_EXPOSURE: dict[str, frozenset[str]] = {
    # Diversified majors
    "BHP": frozenset({"iron_ore_coal", "base_metals"}),
    "RIO": frozenset({"iron_ore_coal", "base_metals"}),
    "S32": frozenset({"base_metals", "iron_ore_coal"}),
    "MIN": frozenset({"iron_ore_coal", "base_metals"}),
    # Iron ore pure-plays
    "FMG": frozenset({"iron_ore_coal"}),
    "MGX": frozenset({"iron_ore_coal"}),
    # Coal
    "SMR": frozenset({"iron_ore_coal"}),
    "WHC": frozenset({"iron_ore_coal"}),
    "NHC": frozenset({"iron_ore_coal"}),
    "YAL": frozenset({"iron_ore_coal"}),
    "CRN": frozenset({"iron_ore_coal"}),
    # Steel / scrap — levered to steel demand, i.e. the iron-ore complex
    "SGM": frozenset({"iron_ore_coal"}),
    "BSL": frozenset({"iron_ore_coal"}),
    # Oil & gas
    "WDS": frozenset({"oil_gas"}),
    "STO": frozenset({"oil_gas"}),
    "BPT": frozenset({"oil_gas"}),
    "KAR": frozenset({"oil_gas"}),
    "ORG": frozenset({"oil_gas"}),
    # Gold
    "NST": frozenset({"gold"}),
    "EVN": frozenset({"gold"}),
    "CMM": frozenset({"gold"}),
    "RRL": frozenset({"gold"}),
    "PRU": frozenset({"gold"}),
    "GOR": frozenset({"gold"}),
    "RMS": frozenset({"gold"}),
    # Base metals / lithium
    "IGO": frozenset({"base_metals"}),
    "PLS": frozenset({"base_metals"}),
    "SFR": frozenset({"base_metals"}),
    "OZL": frozenset({"base_metals"}),
    "LYC": frozenset({"base_metals"}),
    "AKE": frozenset({"base_metals"}),
}

_COMMODITY_CHANNELS = frozenset({"oil_gas", "iron_ore_coal", "gold", "base_metals"})

# Broad channels only — where a SECTOR is the honest unit of transmission.
CHANNEL_EXPOSURE_SECTORS: dict[str, frozenset[str]] = {
    "agriculture":           frozenset({"Consumer Staples"}),
    "rates_inflation":       frozenset({"Financials", "REITs"}),
    "trade_policy":          frozenset({"Materials", "Energy"}),  # AU export flows
    "shipping_supply_chain": frozenset({"Materials", "Energy", "Consumer Discretionary"}),
    "aud_fx":                frozenset(),   # too broad to be useful — see note above
    "none":                  frozenset(),
}


def exposed_holdings(channel: str | None, portfolio_tickers) -> list[str]:
    """Holdings reached by `channel`, sorted for stable output.

    Commodity channels resolve via TICKER_COMMODITY_EXPOSURE (precise); broad
    channels via SECTOR_MAP. Returns [] for unknown/none/aud_fx, or when nothing
    in the book is exposed. Tickers in neither map yield no annotation — correct
    for the diversified ETFs (VAP/VDHG/VHY/VLC/VVLU/HBRD), which have no single
    sector or commodity.
    """
    ch = (channel or "").strip().lower()
    tickers = [str(t).upper().replace(".AX", "") for t in (portfolio_tickers or [])]

    if ch in _COMMODITY_CHANNELS:
        return sorted(t for t in tickers
                      if ch in TICKER_COMMODITY_EXPOSURE.get(t, frozenset()))

    sectors = CHANNEL_EXPOSURE_SECTORS.get(ch)
    if not sectors:
        return []
    return sorted(t for t in tickers if SECTOR_MAP.get(t) in sectors)


def transmission_rubric_text() -> str:
    """Render TRANSMISSION_CHANNELS as prompt-ready text. Embedded in
    news_engine's CLASSIFY_PROMPT so the vocabulary the model may emit and the
    vocabulary the backstop validates against can never drift apart."""
    return " | ".join(TRANSMISSION_CHANNELS)


def normalize_transmission(raw: str | None) -> str:
    """Reduce a model's transmission answer to ONE canonical channel, or
    TRANSMISSION_NO_CHANNEL when nothing valid is named.

    Lenient by necessity: the vocabulary is shown to the model pipe-delimited,
    which reliably teaches it to answer in kind — qwen3.5:9b returns
    "oil_gas|shipping_supply_chain" for a strike on shipping, which is a
    genuinely CORRECT multi-channel read. A strict `in TRANSMISSION_CHANNELS`
    membership test scored that as unrecognised → "no channel" → capped the
    single best signal in the set down to 2.0. Splitting and taking the first
    recognised channel keeps that article. Unknown/absent → no channel.
    """
    if not raw:
        return TRANSMISSION_NO_CHANNEL
    for part in re.split(r"[|,/;+&]| and ", str(raw).lower()):
        part = part.strip().strip("\"' ")
        if part in TRANSMISSION_CHANNELS and part != TRANSMISSION_NO_CHANNEL:
            return part
    return TRANSMISSION_NO_CHANNEL


def impact_cap_no_transmission(category: str, transmission: str | None) -> float | None:
    """Deterministic backstop (NEWS_CLASSIFICATION_FIXES.md C2) mirroring
    impact_cap_for_admin: a macro/geopolitics article whose own declared
    transmission channel is "none" (or absent, or unrecognised) cannot reach an
    ASX price, so cap it to NO_TRANSMISSION_IMPACT_CAP regardless of the score
    the model emitted. Returns None (no opinion) for every other category — a
    stock-specific article's relevance is already established by its
    primary_tickers, not by a macro channel.

    Note this backstops the model's own STRUCTURED output rather than
    keyword-matching the text: "Iran says Strait of Hormuz closed" contains no
    commodity word at all, so pattern-matching the headline would drop exactly
    the article that matters most.
    """
    if (category or "").lower() not in ("macro", "geopolitics"):
        return None
    if normalize_transmission(transmission) != TRANSMISSION_NO_CHANNEL:
        return None
    return NO_TRANSMISSION_IMPACT_CAP


# ── Admin/registry filing patterns (PROMPT_RELEVANCE_FIXES.md R1/R2) ─────────
# ASX-mandated administrative notices with no trading implication. Shared
# between announcement_engine.py (R1: brief-time admission gate) and
# core.impact_cap_for_admin (R2: score ceiling) so there is exactly one
# deny-list, not two that can drift apart.
_ADMIN_ANN_PATTERNS: tuple[str, ...] = (
    "cessation of securities",
    "substantial holder",
    "substantial holding",
    "unquoted securities",
    "proposed sale of securities",
    "notice of annual general meeting",
    "change of address",
    "director interest notice",
    "director's interest notice",
    "appendix 3",
    "appendix 2a",
    # NEWS_EVENT_MODEL_PLAN.md R7-A additions (2026-07-15) — the original 10
    # patterns above only caught 84/163 (51%) of the live corpus's "Other"
    # rows, well short of the plan's "largely" claim. Each addition below was
    # checked against every non-Other-typed row in the live DB before
    # inclusion: several DO also appear under a real type (e.g. "Distribution
    # Timetable Announcement" sometimes lands as Dividend, "Application for
    # quotation of securities" sometimes as Capital Raise) because the
    # classifier keys off PDF content the headline alone doesn't show — but
    # the underlying filing is routine/administrative regardless of which
    # type it got sorted into, so the impact cap below is still correct to
    # apply. The TYPE relabel in classify_announcement() is deliberately
    # scoped to type=='Other' only, so it never overwrites one of those real
    # classifications — see the comment there.
    "notification of buy-back",
    "distribution reinvestment plan",
    "distribution tax estimate",
    "estimated distribution",
    "distribution component",       # catches "...Component Information" the plain
                                     # "estimated distribution" substring misses
                                     # when "annual" is inserted between the words
    "distribution timetable",
    "fund flows announcement",
    "statement of changes in beneficial ownership",
    "units on issue disclosure",
    "statement of cdis on issue",
    "quotation of securities",
    "cleansing notice",
    "ceo's interest notice",        # same ASX Listing Rule 3.19A family as the
                                     # director's-interest-notice patterns above
    "appendix 4g",                  # Corporate Governance Compliance Statement —
                                     # administrative. NOT a bare "appendix 4": 4C/
                                     # 4D/4E are substantive financial disclosures
                                     # and must never be caught by this list.
)


def is_admin_announcement(text: str) -> bool:
    """True when `text` matches one of the routine-registry-filing patterns in
    _ADMIN_ANN_PATTERNS.

    Pass the HEADLINE ONLY — never headline + summary. The summary is
    LLM-generated, so matching against it widens the deny-list onto a moving
    target: a takeover summary that happens to mention "…is becoming a
    substantial holder" would cap and drop the real announcement. Measured on
    the live corpus both forms select the identical 180 rows (and the identical
    142/163 = 87% of the Other bucket), so the summary contributes nothing but
    risk. Callers narrowed 2026-07-15.

    Normalises a curly apostrophe (common in PDF-extracted text) to a straight
    one first so "Director's Interest Notice" matches regardless of which one
    the source used — a straight-quote-only pattern silently missed 7
    director-notice rows in the live corpus before this normalisation.
    """
    t = text.lower().replace("’", "'")
    return any(kw in t for kw in _ADMIN_ANN_PATTERNS)


def impact_cap_for_admin(text: str) -> float | None:
    """Mirror of impact_floor_for_keywords (PROMPT_RELEVANCE_FIXES.md R2): if
    `text` matches an admin/registry filing pattern, return the "AGM / Admin /
    Broad Commentary / Other" band's ceiling (3.0) so a model that ignores the
    rubric upward can't turn a routine filing into a fabricated high-impact
    signal. Returns None when nothing matches (no opinion on the score)."""
    if is_admin_announcement(text):
        return float(IMPACT_BAND_TABLE[-1][1][1])  # AGM/Admin/Other ceiling
    return None


# ── Sector map (used by market scanner) ──────────────────────────────────────
# Curated lookup for ASX200-ish tickers. Each ticker appears exactly once.
# Falls back to "Other" if a scanned ticker isn't here.

SECTOR_MAP: dict[str, str] = {
    # Financials (insurance, asset managers, exchanges, fintech, banks)
    **{t: "Financials" for t in [
        "CBA","WBC","ANZ","NAB","MQG","QBE","SUN","IAG","AMP","CGF",
        "HUB","PPT","PTM","MFG","CIN","EQT","ASX","IFL","AUB","GQG",
        "NWL","APE","JHG","PDL","SFG","AFG","CCP","OFX","MRM","WGB",
        "SDF",   # Steadfast — insurance broker (was unmapped; held)
    ]},
    # Materials / Mining
    **{t: "Materials" for t in [
        "BHP","RIO","FMG","S32","MIN","IGO","LYC","NST","EVN","SFR",
        "AWC","BSL","JHX","BLD","CSR","RWC","ILU","PLS","WHC","NHC",
        "YAL","CMM","RRL","PRU","SAR","OZL","MGX","SBM","WAF","RED",
        "DEG","GOR","AKE","CRN","TBN","CHN","RSG","MML","IPX","DDH",
        "SGM",   # Sims — metal recycling (was unmapped; held)
    ]},
    # Energy
    **{t: "Energy" for t in [
        "WDS","STO","ORG","BPT","KAR","IPL","ORI","CEG","BOE","NHC",
        "WHC","YAL","CRN",
        "SMR",   # Stanmore — met coal; Energy to match CRN/WHC/YAL (was unmapped; held)
    ]},
    # Healthcare
    **{t: "Healthcare" for t in [
        "CSL","RMD","COH","SHL","PME","MSB","HCA","EHE","HLS","IDX",
        "PNV","NAN","IMB","SDR","CU6","RAH","ACL","TLX","MX1","GEN",
    ]},
    # Consumer Discretionary
    **{t: "Consumer Discretionary" for t in [
        "WES","MYR","HVN","JBH","SUL","BRG","PMV","DMP","CKF","ARB",
        "TPW","KMD","CCX","RFG","FLT","WEB","CTD","HLO","SWM","NEC",
        "SKT","VOC","CAT","ELD",
    ]},
    # Consumer Staples
    **{t: "Consumer Staples" for t in [
        "WOW","COL","TWE","A2M","CCL","GNC","UNI","BKL","AHY","SSG",
    ]},
    # REITs
    **{t: "REITs" for t in [
        "GMG","SCG","VCX","MGR","DXS","CHC","ARF","CIP","NSR","ABP",
        "BWP","HDN","CLW","GDI","HPI","360","LIC","WPR","RGN","AEF",
        "SGP",   # Stockland — diversified property (was unmapped; held)
    ]},
    # Industrials / Infrastructure
    **{t: "Industrials" for t in [
        "TCL","AZJ","QAN","ALQ","MND","CIM","DOW","SSM","NWH","GWA",
        "LLC","LNW","PTB","ICT","SEK","REA","CAR","IEL","DGL","MMS",
        "SIQ","SRV","CLX","NWS",
    ]},
    # Technology
    **{t: "Technology" for t in [
        "WTC","XRO","APX","CPU","ALU","MP1","TNE","DTL","DUB","ADA",
        "NEA","BVS","LNW","PPS","NXT","FPH","SPZ","AI1","FCL","MFT",
    ]},
    # Communication
    **{t: "Communication" for t in [
        "TLS","TPG","REH","SXL","HTA","NWS","SKT","QMS",
    ]},
    # Utilities
    **{t: "Utilities" for t in [
        "AGL","APA","SKI","MEZ","RGY","AGR",
    ]},
}


# ── ASX universes — ordered roughly by market cap ────────────────────────────

ASX_UNIVERSE: dict[str, list] = {
    "asx20": [
        "CBA","BHP","WBC","ANZ","NAB","WES","CSL","RIO","WTC","MQG",
        "FMG","GMG","WOW","TLS","REA","RMD","COH","QBE","WDS","TCL",
    ],
}
ASX_UNIVERSE["asx50"] = ASX_UNIVERSE["asx20"] + [
    "SUN","IAG","NST","EVN","ALL","SGP","CPU","SCG","FPH","ALQ",
    "STO","COL","TWE","NXT","LLC","MIN","HVN","ILU","JHX","ORG",
    "APA","MND","ALU","VCX","AZJ","DXS","APX","S32","MGR","CHC",
]
ASX_UNIVERSE["asx100"] = ASX_UNIVERSE["asx50"] + [
    "IGO","LYC","XRO","SHL","BLD","CSR","RWC","SFR","AMP","CGF",
    "HUB","PPT","PTM","IFL","EQT","AUB","GQG","NWL","JBH","SUL",
    "ARB","PMV","DMP","CKF","FLT","WEB","CTD","A2M","GNC","CCL",
    "ARF","CIP","NSR","BWP","ABP","HDN","CLW","QAN","SSM","MMS",
    "SEK","CAR","IEL","DTL","TNE","NWH","GWA","MP1","SWM","NEC",
]
ASX_UNIVERSE["asx200"] = ASX_UNIVERSE["asx100"] + [
    "CMM","RRL","PRU","SAR","WAF","RED","WHC","NHC","YAL","PLS",
    "AKE","CRN","TBN","OZL","MGX","SBM","DEG","GOR","AWC","BSL",
    "BPT","KAR","IPL","ORI","PME","MSB","HCA","EHE","HLS","IDX",
    "PNV","NAN","IMB","SDR","MYR","BRG","TPW","KMD","CCX","RFG",
    "HLO","SXL","HTA","TPG","REH","AGL","SKI","LNW","ICT","PTB",
    "ALU","DUB","ADA","NEA","BVS","MFG","CIN","JHG","PDL","AFG",
    "CCP","ASX","MQG","GDI","HPI","360","LLC","DGL","SIQ","NWS",
    "UNI","BKL","GNC","AUB","WGB","OFX","MRM","ELD","CAT","SFG",
]

# Dedupe every universe — preserves order, removes any accidental duplicates.
for _u in list(ASX_UNIVERSE.keys()):
    ASX_UNIVERSE[_u] = list(dict.fromkeys(ASX_UNIVERSE[_u]))
