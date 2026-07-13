// ============================================================
// learning-loop.js — Calibration analytics (v2)
//
// PRIMARY source: SQLite via GET /api/learning/stats (cached in
//   state._learningCache after refreshLearningCache() is called).
// FALLBACK: state.recHistory (local, works offline).
//
// Public API:
//   refreshLearningCache()                → async, call before analysis
//   computeCalibrationStats(recHistory)   → per-confidence-band hit rates
//   computeRegimePerformance(recHistory)  → per-regime win rates
//   detectStrategyDecay(recHistory, days) → decay + volatility detection
//   computeAllTradesStats(journalHistory) → AI vs manual win-rate comparison
//   computeRRRealization(recHistory)      → suggested R:R vs actual outcome
//   buildCalibrationPromptBlock(recHistory) → string for AI user message
//
// Expected fields per record (recHistory entries):
//   id, confidence, ensemble_confidence, regime, actualProfit,
//   suggestedStop, suggestedTarget, executedPrice, outcome,
//   exitReason, promptVersion, holdingDays, date, action
// Backend event fields (state._learningCache.recent_events):
//   id, ticker, recommendation, ai_confidence, ensemble_confidence,
//   outcome_status, realized_pnl_pct, realized_pnl_aud, regime,
//   prompt_version, was_executed, suggested_stop, suggested_target,
//   rr_ratio, holding_period_days, exit_reason, rationale_summary
// ============================================================

// ── Cache management ──────────────────────────────────────────────────────────

/**
 * Fetch backend learning stats and store in state._learningCache.
 * Used by the Learning Loop page (renderLearningPage). Not needed for
 * prompt injection — use fetchCalibrationBlock() for that instead.
 */
async function refreshLearningCache() {
  if (typeof state === 'undefined' || !state.serverOk) return;
  try {
    const resp = await fetch(`${API}/api/learning/stats`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.error) return;
    state._learningCache = { ...data, _fetchedAt: Date.now() };
  } catch (_) { /* never break analysis */ }
}

// ── computeCalibrationStats ───────────────────────────────────────────────────

/**
 * Per-confidence-band hit rates.
 * Prefers backend conf_bands when available (richer sample).
 * Returns { bands:{}, sampleSize, sufficient, source }
 */
function computeCalibrationStats(recHistory) {
  const cache = (typeof state !== 'undefined') ? state._learningCache : null;

  // ── Path A: backend data ──────────────────────────────────────────────────
  if (cache && Array.isArray(cache.conf_bands) && cache.closed >= 3) {
    const bands = {};
    const midpoints = { '60-70%': 0.645, '70-80%': 0.745, '80-90%': 0.845, '90-101%': 0.925 };
    for (const b of cache.conf_bands) {
      const mp = midpoints[b.band] ?? 0.725;
      const wr = b.win_rate != null ? b.win_rate / 100 : null;  // convert from 0-100 to 0-1
      bands[b.band] = {
        hits:  b.wins,
        total: b.total,
        totalPnl: null,                  // not in aggregate endpoint
        midpoint: mp,
        hitRate:  wr,
        avgPnl:   null,
        calibrationDelta: wr != null ? +(wr - mp).toFixed(3) : null,
        adjustment: wr == null ? 0 : wr < 0.60 ? -0.10 : wr > 0.80 ? 0.05 : 0,
      };
    }
    return {
      bands,
      sampleSize: cache.closed,
      sufficient: cache.closed >= 5,
      source: 'backend',
    };
  }

  // ── Path B: local recHistory fallback ─────────────────────────────────────
  const closed = (recHistory || []).filter(r => r.actualProfit != null);
  if (closed.length < 5) return { bands: {}, sampleSize: closed.length, sufficient: false, source: 'local' };

  const bands = {
    '90-101%': { hits: 0, total: 0, totalPnl: 0, midpoint: 0.925 },
    '80-90%':  { hits: 0, total: 0, totalPnl: 0, midpoint: 0.845 },
    '70-80%':  { hits: 0, total: 0, totalPnl: 0, midpoint: 0.745 },
    '60-70%':  { hits: 0, total: 0, totalPnl: 0, midpoint: 0.645 },
  };
  const bucket = c =>
    c >= 0.90 ? '90-101%' : c >= 0.80 ? '80-90%' : c >= 0.70 ? '70-80%' : '60-70%';

  for (const r of closed) {
    const b = bands[bucket(r.confidence || 0)];
    if (!b) continue;
    b.total++;
    b.totalPnl += r.actualProfit;
    if (r.actualProfit > 0) b.hits++;
  }
  for (const b of Object.values(bands)) {
    if (!b.total) continue;
    b.hitRate          = +(b.hits / b.total).toFixed(3);
    b.avgPnl           = +(b.totalPnl / b.total).toFixed(2);
    b.calibrationDelta = +(b.hitRate - b.midpoint).toFixed(3);
    b.adjustment       = b.hitRate < 0.60 ? -0.10 : b.hitRate > 0.80 ? 0.05 : 0;
  }
  return { bands, sampleSize: closed.length, sufficient: true, source: 'local' };
}

// ── computeRegimePerformance ──────────────────────────────────────────────────

/**
 * Win rate and avg P&L per market regime.
 * Prefers backend regime_stats when available.
 * Returns { [regime]: { wins, total, winRate, avgPnl } }
 */
function computeRegimePerformance(recHistory) {
  const cache = (typeof state !== 'undefined') ? state._learningCache : null;

  if (cache && Array.isArray(cache.regime_stats) && cache.regime_stats.length) {
    const out = {};
    for (const r of cache.regime_stats) {
      out[r.regime] = {
        wins:    r.wins,
        total:   r.total,
        winRate: r.win_rate != null ? r.win_rate / 100 : null,
        avgPnl:  null,  // not in aggregate endpoint
      };
    }
    return out;
  }

  const closed = (recHistory || []).filter(r => r.actualProfit != null && r.regime);
  if (closed.length < 3) return {};

  const regimes = {};
  for (const r of closed) {
    const rg = r.regime || 'unknown';
    if (!regimes[rg]) regimes[rg] = { wins: 0, total: 0, totalPnl: 0 };
    regimes[rg].total++;
    regimes[rg].totalPnl += r.actualProfit;
    if (r.actualProfit > 0) regimes[rg].wins++;
  }
  for (const rg of Object.values(regimes)) {
    rg.winRate = +(rg.wins / rg.total).toFixed(3);
    rg.avgPnl  = +(rg.totalPnl / rg.total).toFixed(2);
  }
  return regimes;
}

// ── detectStrategyDecay ───────────────────────────────────────────────────────

/**
 * Compares recent window win rate vs all-time; also reports performance
 * volatility (std dev of recent returns) to flag choppy regimes.
 * Returns { decaying, volatile, recentWinRate, allTimeWinRate, delta,
 *           recentSample, recentVolatility, note }
 */
function detectStrategyDecay(recHistory, windowDays = 30) {
  const closed = (recHistory || []).filter(r => r.actualProfit != null);
  if (closed.length < 10) return { decaying: false, volatile: false, insufficient: true };

  const cutoff = Date.now() - windowDays * 86400000;
  const parseDate = r => {
    if (!r.date) return 0;
    const s = String(r.date).trim();
    // DD-MM-YYYY or DD/MM/YYYY — year in position [2], length 4
    const dm = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dm) return new Date(`${dm[3]}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`).getTime();
    // ISO / any Date-parseable format
    const t = new Date(s).getTime();
    return isNaN(t) ? 0 : t;
  };

  const recent  = closed.filter(r => parseDate(r) > cutoff);
  const allTime = closed;

  const winRate = arr => arr.length > 0
    ? arr.filter(r => r.actualProfit > 0).length / arr.length : 0;

  // Volatility: std dev of profit values in recent window (normalised by abs mean)
  let recentVolatility = null;
  if (recent.length >= 4) {
    const profits = recent.map(r => r.actualProfit);
    const mean    = profits.reduce((s, v) => s + v, 0) / profits.length;
    const variance = profits.reduce((s, v) => s + (v - mean) ** 2, 0) / profits.length;
    const stdDev  = Math.sqrt(variance);
    // Coefficient of variation — capped; high means very erratic returns
    recentVolatility = mean !== 0 ? +(Math.abs(stdDev / mean)).toFixed(2) : null;
  }

  const recentWR  = winRate(recent);
  const allTimeWR = winRate(allTime);
  const delta = recentWR - allTimeWR;
  const decaying  = delta < -0.15 && recent.length >= 5;
  const volatile  = recentVolatility != null && recentVolatility > 2.0;

  let note = '';
  if (decaying && volatile) note = 'High volatility + win-rate decline — consider halving position sizes';
  else if (decaying)        note = 'Win-rate declining — tighten entry criteria';
  else if (volatile)        note = 'High return volatility — reduce position sizing until stable';

  return {
    decaying,
    volatile,
    recentWinRate:    +recentWR.toFixed(3),
    allTimeWinRate:   +allTimeWR.toFixed(3),
    delta:            +delta.toFixed(3),
    recentSample:     recent.length,
    recentVolatility,
    note,
  };
}

// ── computeAllTradesStats ─────────────────────────────────────────────────────

/**
 * Compare AI-recommended vs manually-entered trades.
 * Uses state.tradeJournal directly (has both sources).
 * Returns { aiWinRate, manualWinRate, combinedWinRate, aiTotal, manualTotal,
 *           aiAvgPnl, manualAvgPnl }
 */
function computeAllTradesStats(journalHistory) {
  const trades = (journalHistory || (typeof state !== 'undefined' ? state.tradeJournal : []) || []);
  const closed  = trades.filter(t => t.pnl != null);
  if (!closed.length) return null;

  const aiTrades     = closed.filter(t => t.recId != null && t.recExecuted);
  const manualTrades = closed.filter(t => !t.recId || !t.recExecuted);

  const stats = arr => {
    if (!arr.length) return null;
    const wins  = arr.filter(t => t.pnl > 0).length;
    const total = arr.length;
    const avgPnl = +(arr.reduce((s, t) => s + Number(t.pnl), 0) / total).toFixed(2);
    return { wins, total, winRate: +(wins / total).toFixed(3), avgPnl };
  };

  const ai     = stats(aiTrades);
  const manual = stats(manualTrades);
  const all    = stats(closed);

  return {
    aiWinRate:      ai?.winRate     ?? null,
    aiTotal:        ai?.total       ?? 0,
    aiAvgPnl:       ai?.avgPnl      ?? null,
    manualWinRate:  manual?.winRate ?? null,
    manualTotal:    manual?.total   ?? 0,
    manualAvgPnl:   manual?.avgPnl  ?? null,
    combinedWinRate: all?.winRate   ?? null,
    combinedTotal:  all?.total      ?? 0,
  };
}

// ── computeRRRealization ──────────────────────────────────────────────────────

/**
 * Compare suggested R:R vs actual outcome.
 * Uses backend rr_stats when available, else approximates from recHistory.
 * Returns { avgSuggestedRR, hiRRWinRate, hiRRSample, meetsRRThreshold,
 *           note, source }
 */
function computeRRRealization(recHistory) {
  const cache = (typeof state !== 'undefined') ? state._learningCache : null;

  // ── Path A: backend rr_stats ──────────────────────────────────────────────
  if (cache && cache.rr_stats && cache.rr_stats.sample > 0) {
    const rr = cache.rr_stats;
    const meetsThreshold = rr.hi_rr_win_rate != null && rr.hi_rr_win_rate >= 55;
    const note = rr.hi_rr_sample < 3
      ? 'Insufficient R:R data'
      : meetsThreshold
        ? `High-R:R trades (≥2.0) are working — ${rr.hi_rr_win_rate}% win rate`
        : `High-R:R trades underperforming (${rr.hi_rr_win_rate ?? 'n/a'}%) — review stop placement`;
    return {
      avgSuggestedRR:  rr.avg_suggested_rr,
      hiRRWinRate:     rr.hi_rr_win_rate,
      hiRRSample:      rr.hi_rr_sample,
      meetsRRThreshold: meetsThreshold,
      note,
      source: 'backend',
    };
  }

  // ── Path B: local recHistory approximation ────────────────────────────────
  const withRR = (recHistory || []).filter(r =>
    r.target && r.stopLoss && r.priceRange?.[0] && r.actualProfit != null
  );
  if (withRR.length < 3) return { avgSuggestedRR: null, hiRRWinRate: null, hiRRSample: 0,
    meetsRRThreshold: null, note: 'Insufficient local R:R data', source: 'local' };

  const calcRR = r => {
    const entry = r.priceRange[0];
    const risk  = Math.abs(entry - r.stopLoss);
    return risk > 0 ? Math.abs(r.target - entry) / risk : null;
  };

  const rrs = withRR.map(r => ({ ...r, _rr: calcRR(r) })).filter(r => r._rr != null);
  const avgRR = rrs.length ? +(rrs.reduce((s, r) => s + r._rr, 0) / rrs.length).toFixed(2) : null;
  const hiRR  = rrs.filter(r => r._rr >= 2.0);
  const hiWins = hiRR.filter(r => r.actualProfit > 0).length;
  const hiWinRate = hiRR.length ? +(hiWins / hiRR.length * 100).toFixed(1) : null;

  return {
    avgSuggestedRR:   avgRR,
    hiRRWinRate:      hiWinRate,
    hiRRSample:       hiRR.length,
    meetsRRThreshold: hiWinRate != null && hiWinRate >= 55,
    note: hiRR.length < 3 ? 'Insufficient R:R data' :
          hiWinRate >= 55 ? `High-R:R trades working — ${hiWinRate}% win rate` :
          `High-R:R trades underperforming (${hiWinRate}%) — review stop placement`,
    source: 'local',
  };
}

// ── fetchCalibrationBlock ─────────────────────────────────────────────────────

/**
 * Fetches a compact, context-aware calibration string from the backend and
 * returns it ready for injection into the AI user message.
 *
 * The backend filters to: recent window (60d), current regime, relevant
 * sectors. It only emits findings where n≥3 AND the signal is statistically
 * meaningful (|delta|>5pp for bands, clear decay, R:R underperformance).
 * Target output: ~30-60 tokens. Returns '' when insufficient data.
 *
 * @param {string} regime   - Current market regime (e.g. 'riskOn')
 * @param {string[]} sectors - Sectors present in the current analysis
 * @param {string[]} tickers - Portfolio tickers for per-ticker / playbook scoping
 * @param {{deep?: boolean}} [opts] - Sprint 71 Phase 3D: deep mode requests the
 *        token-heavy exemplar/playbook/cross-tab blocks (full portfolio
 *        analysis). Light (default) is stats-only for high-frequency intraday
 *        refreshes. Exemplars (when present) are stashed on
 *        window._calibExemplars for analysis.js to render as an EXEMPLARS: block.
 */
async function fetchCalibrationBlock(regime, sectors, tickers, opts = {}) {
  window._calibAdjustments = null;   // §8.3: reset so a failed fetch never reuses stale nudges
  window._calibExemplars   = null;   // Phase 3A: reset so a failed fetch never reuses stale exemplars
  if (typeof state === 'undefined' || !state.serverOk) return '';
  try {
    const params = new URLSearchParams();
    if (regime) params.set('regime', regime);
    if (sectors && sectors.length) params.set('sectors', sectors.join(','));
    if (tickers && tickers.length) params.set('tickers', tickers.join(','));
    // Sprint 44: regime-change penalty — tell backend when the regime last flipped
    const flippedAt = localStorage.getItem('regime_flipped_at');
    const flippedTo = localStorage.getItem('regime_flipped_to');
    if (flippedAt) params.set('flipped_at', flippedAt);
    if (flippedTo) params.set('flipped_to', flippedTo);
    if (opts && opts.deep) params.set('deep', '1');   // Phase 3D: deep feed mode
    const resp = await fetch(`${API}/api/learning/calibration?${params}`);
    if (!resp.ok) return '';
    const data = await resp.json();
    // §8.3: machine-readable nudges, applied deterministically by analysis.js
    // post-response (the text block is context only — Claude no longer does
    // the arithmetic). Stored on window so the same fetch serves both uses.
    if (data.available && data.adjustments) window._calibAdjustments = data.adjustments;
    // Phase 3A: stash few-shot exemplars (deep mode only) for the EXEMPLARS: block.
    if (Array.isArray(data.exemplars) && data.exemplars.length) {
      window._calibExemplars = data.exemplars;
    }
    return (data.available && data.block) ? '\n\n' + data.block : '';
  } catch (_) { return ''; }
}

/**
 * Build the EXEMPLARS: block injected into the AI user message (Sprint 71 Phase 3A).
 * Concrete few-shot examples from the user's own closed trades — the highest-impact
 * behavioural lever. Returns '' when no exemplars are available.
 *
 * @param {string[]} exemplars - compact one-line strings from the backend
 */
function buildExemplarsBlock(exemplars) {
  if (!Array.isArray(exemplars) || !exemplars.length) return '';
  return '\n\nEXEMPLARS (your own recent closed trades — learn from these):\n'
       + exemplars.map(e => '* ' + e).join('\n');
}

// ── Thesis Tracking Phase 2+3 ────────────────────────────────────────────────

/**
 * Deterministically compute whether the entry thesis held up at exit.
 * Both entrySignals and liveSnapshot use the entry_signals_json shape:
 *   { rsi_14, bb_pct_b, adx_14, atr_pct, return_5d, return_20d }
 *
 * @param {string} entryDriver   - primary_entry_driver value from learning event
 * @param {object} entrySignals  - signal snapshot at entry time (may be {})
 * @param {object} liveSnapshot  - current signals in the same shape
 * @returns {{ verdict: string, reason: string, deltas: object } | null}
 */
function computeThesisDrift(entryDriver, entrySignals, liveSnapshot) {
  if (!entryDriver || !entrySignals || !liveSnapshot) return null;

  // Defensive number coercion — treat missing/NaN as null
  const _n = (obj, key) => {
    const v = Number(obj[key]);
    return (obj[key] == null || !isFinite(v)) ? null : v;
  };

  const eRsi  = _n(entrySignals, 'rsi_14');
  const eBB   = _n(entrySignals, 'bb_pct_b');
  const eAdx  = _n(entrySignals, 'adx_14');
  const eRet5 = _n(entrySignals, 'return_5d');

  const nRsi  = _n(liveSnapshot, 'rsi_14');
  const nBB   = _n(liveSnapshot, 'bb_pct_b');
  const nAdx  = _n(liveSnapshot, 'adx_14');
  const nRet5 = _n(liveSnapshot, 'return_5d');

  let verdict = 'irrelevant';
  let reason  = '';
  let deltas  = {};

  // ── Shared verdict helper ───────────────────────────────────────────────────
  // Computes a verdict from hold/invert/total signal counts.
  // n_inverted >= 2           → 'reversed'    (signals clearly flipped)
  // n_hold == n_total         → 'validated'   (all signals still intact)
  // n_hold == 0               → 'invalidated' (no signals intact)
  // n_hold / n_total >= 0.33  → 'partially_validated' (some intact, some not)
  // else                      → 'invalidated'
  function _resolveVerdict(n_hold, n_inverted, n_total) {
    if (n_total === 0) return 'irrelevant';
    if (n_inverted >= 2) return 'reversed';
    if (n_hold === n_total) return 'validated';
    if (n_hold === 0) return 'invalidated';
    if (n_hold / n_total >= 0.33) return 'partially_validated';
    return 'invalidated';
  }

  if (entryDriver === 'mean_reversion') {
    deltas = {};
    if (eRsi != null && nRsi != null) deltas.rsi_14    = { entry: eRsi, now: nRsi };
    if (eBB  != null && nBB  != null) deltas.bb_pct_b  = { entry: eBB,  now: nBB  };

    // mean_reversion: entry signal = RSI oversold (<35) or BB at lower band (<0.25)
    // validated: reverted toward mid (RSI >45, BB >0.45)
    // inverted:  RSI was <35, now >65; or BB was <0.15, now >0.85
    let n_hold = 0, n_inverted = 0, n_total = 0;

    if (eRsi != null && nRsi != null) {
      n_total++;
      const entryOversold = eRsi < 35;
      const nowReverted   = nRsi > 45;
      const nowInverted   = entryOversold && nRsi > 65;   // oversold → overbought
      if (nowInverted)        n_inverted++;
      else if (nowReverted)   n_hold++;
    }
    if (eBB != null && nBB != null) {
      n_total++;
      const entryLow    = eBB < 0.25;
      const nowReverted = nBB > 0.45;
      const nowInverted = entryLow && nBB > 0.85;         // lower band → upper band
      if (nowInverted)        n_inverted++;
      else if (nowReverted)   n_hold++;
    }

    verdict = (n_total > 0) ? _resolveVerdict(n_hold, n_inverted, n_total) : 'irrelevant';
    const rsiStr = (eRsi != null && nRsi != null) ? `RSI ${eRsi}→${nRsi}` : '';
    const bbStr  = (eBB  != null && nBB  != null) ? `%b ${eBB.toFixed(2)}→${nBB.toFixed(2)}` : '';
    reason = [rsiStr, bbStr].filter(Boolean).join(', ');

  } else if (entryDriver === 'momentum_breakout') {
    deltas = {};
    if (nRet5 != null) deltas.return_5d = { entry: eRet5, now: nRet5 };
    if (nBB   != null) deltas.bb_pct_b  = { entry: eBB,   now: nBB   };

    // momentum_breakout: entry signal = positive return_5d and high BB%B (>0.55)
    // validated: momentum sustained (ret5d >0, bb >0.55)
    // inverted:  both signals flipped (ret5d <0 AND bb <0.45)
    let n_hold = 0, n_inverted = 0, n_total = 0;

    if (nRet5 != null) {
      n_total++;
      if (nRet5 > 0)  n_hold++;
      if (nRet5 < 0)  n_inverted++;
    }
    if (nBB != null) {
      n_total++;
      if (nBB > 0.55) n_hold++;
      if (nBB < 0.45) n_inverted++;
    }

    verdict = (n_total > 0) ? _resolveVerdict(n_hold, n_inverted, n_total) : 'irrelevant';
    const ret5Str = nRet5 != null ? `return_5d=${nRet5.toFixed(1)}%` : '';
    const bbStr2  = nBB   != null ? `%b=${nBB.toFixed(2)}` : '';
    reason = [ret5Str, bbStr2].filter(Boolean).join(', ');

  } else if (entryDriver === 'trend_pullback') {
    deltas = {};
    if (nRet5 != null) deltas.return_5d = { entry: eRet5, now: nRet5 };
    if (nAdx  != null) deltas.adx_14    = { entry: eAdx,  now: nAdx  };

    // trend_pullback: entry signal = positive return_20d + ADX >25; buying a dip
    // validated: trend resumed (ret5d >0, ADX still strong)
    // inverted:  trend reversed (ret5d <-3, ADX collapsed <15)
    let n_hold = 0, n_inverted = 0, n_total = 0;

    if (nRet5 != null) {
      n_total++;
      if (nRet5 > 0)   n_hold++;
      if (nRet5 < -3)  n_inverted++;
    }
    if (nAdx != null) {
      n_total++;
      if (nAdx > 20)  n_hold++;
      if (nAdx < 15)  n_inverted++;   // ADX collapsed — trend gone
    }

    verdict = (n_total > 0) ? _resolveVerdict(n_hold, n_inverted, n_total) : 'irrelevant';
    const ret5Str2 = nRet5 != null ? `return_5d=${nRet5.toFixed(1)}%` : '';
    const adxStr   = nAdx  != null ? `ADX=${nAdx.toFixed(0)}` : '';
    reason = [ret5Str2, adxStr].filter(Boolean).join(', ');

  } else if (entryDriver === 'fundamental_value' || entryDriver === 'macro_tailwind') {
    verdict = 'irrelevant';
    reason  = 'fundamental/macro thesis — not technically verifiable';
    deltas  = {};

  } else {
    // Unknown driver — cannot evaluate
    return null;
  }

  return { verdict, reason, deltas };
}

/**
 * Fetch entry contexts for a list of tickers from the backend.
 * Returns the `contexts` map { TICKER: { entry_date, primary_entry_driver,
 * entry_signals, trade_thesis } } or {} on failure.
 * Caps tickers to 50.
 *
 * @param {string[]} tickers
 * @returns {Promise<object>}
 */
async function fetchEntryContexts(tickers) {
  if (!tickers || !tickers.length) return {};
  if (typeof state !== 'undefined' && !state.serverOk) return {};
  try {
    const capped = tickers.slice(0, 50);
    const params = new URLSearchParams({ tickers: capped.join(',') });
    const resp = await fetch(`${API}/api/learning/entry-context?${params}`);
    if (!resp.ok) return {};
    const data = await resp.json();
    return (data.ok && data.contexts) ? data.contexts : {};
  } catch (_) { return {}; }
}

// Audit F4 (critics.md #4): capture thesis-evolution snapshots for open holdings.
// For each open portfolio ticker, compares its entry signals against the current
// live snapshot via computeThesisDrift() and persists the {verdict, reason, deltas}
// at the ~30/60/90-day marks. The server dedupes on (learning_id, milestone_day),
// so this can run blindly every day — the first daily pass after a mark is crossed
// records it, later passes are no-ops. Pure data accrual (no nudges consume it yet);
// the point is that mid-hold thesis drift CANNOT be reconstructed after the fact.
async function captureThesisSnapshots() {
  try {
    if (typeof state === 'undefined' || !state.serverOk) return 0;
    const holdings = (state.portfolio || []);
    const tickers = [...new Set(holdings.map(h => h && h.ticker).filter(Boolean))];
    if (!tickers.length) return 0;
    const contexts = await fetchEntryContexts(tickers);
    const now = Date.now();
    let posted = 0;
    for (const tk of tickers) {
      const ctx = contexts[tk];
      if (!ctx || !ctx.learning_id || !ctx.primary_entry_driver ||
          !ctx.entry_signals || !ctx.entry_date) continue;
      const entryMs = new Date(String(ctx.entry_date).replace(' ', 'T')).getTime();
      if (!isFinite(entryMs)) continue;
      const daysHeld = Math.floor((now - entryMs) / 86400000);
      if (daysHeld < 30) continue;   // no mark crossed yet
      const live = (state.liveSignals || {})[tk];
      if (!live) continue;
      const drift = computeThesisDrift(ctx.primary_entry_driver, ctx.entry_signals, live);
      if (!drift) continue;
      for (const M of [30, 60, 90]) {
        if (daysHeld < M) continue;
        try {
          await fetch(`${API}/api/learning/thesis-snapshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              learning_id:   ctx.learning_id,
              ticker:        tk,
              milestone_day: M,
              days_held:     daysHeld,
              verdict:       drift.verdict,
              reason:        drift.reason,
              deltas:        drift.deltas,
            }),
          });
          posted++;
        } catch (_) { /* best-effort; retried next pass */ }
      }
    }
    return posted;
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('captureThesisSnapshots failed', e);
    return 0;
  }
}
