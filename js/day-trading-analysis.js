// ============================================================
// DAY TRADING ANALYSIS ENGINE
// Quantitative confluence strategy: 5–15 day swing trades.
// Primary: BB reclaim. Confirms: RSI<35, Vol Z-Score, Fib zone, OBV div.
// Stop: regime-aware stopAtrMult×ATR (2.5–4.0×, via quant engine).
// Hard filters: ADV, SMA200, ADX, no catalyst.
// NOTE: Fully quantitative — no Claude call. getDayTradeSystemPrompt /
//       getDayTradeUniverseScanPrompt exist for potential future use but
//       are not invoked by runDayTradeAnalysis() (_runPortfolioWatchlistScan/_runUniverseScan).
// ============================================================

// ── _dtPreFilterWithStats ─────────────────────────────────────────────────────
// Same logic as _dtPreFilter() but returns rejection counts per filter so the UI
// can display a breakdown of why tickers were rejected.
function _dtPreFilterWithStats(tickers) {
  const fp = { ...DT_FILTER, ...(state.dayTrading.filterParams || {}) };
  const stats = { bb: 0, adv: 0, sma: 0, adx: 0, vov: 0, noData: 0 };
  const passing = [];

  for (const t of tickers) {
    const s = state.liveSignals[t];
    if (!s || s.error) { stats.noData++; continue; }
    if (_ruleOn(fp, 'maxBbPctB') && (s.bb_pct_b  ?? 1) > fp.maxBbPctB)                                      { stats.bb++;  continue; }
    if (_ruleOn(fp, 'minAdvAud') && (s.adv_20    ?? 0) < fp.minAdvAud)                                      { stats.adv++; continue; }
    const ref = s.sma_200 ?? s.sma_50;
    const trendRuleOn = s.sma_200 ? _ruleOn(fp, 'sma200Floor') : _ruleOn(fp, 'sma50Floor');
    const trendFloor  = s.sma_200 ? fp.sma200Floor : (fp.sma50Floor ?? 0.970);
    if (trendRuleOn && ref && s.current_price < ref * trendFloor)                                          { stats.sma++; continue; }
    if (_ruleOn(fp, 'maxAdx') && (s.adx ?? 0) > fp.maxAdx && s.trend_strength === 'strong' && s.di_plus > s.di_minus) { stats.adx++; continue; }
    // §2.8 VoV — keep in sync with _dtPreFilter() in strategy.js
    if (_ruleOn(fp, 'vovMult') && (fp.vovMult ?? 0) > 0 && s.atr_14 != null && s.atr_5d_mean != null
        && s.atr_5d_mean > 0 && s.atr_14 > fp.vovMult * s.atr_5d_mean)                                     { stats.vov++; continue; }
    passing.push(t);
  }
  return { passing, stats };
}

// ── _dtDismissStaleRecs ───────────────────────────────────────────────────────
// Auto-dismisses pending swing recs older than maxAgeDays (default 3).
// Called at the start of each scan run so stale cards don't accumulate.
function _dtDismissStaleRecs(maxAgeDays = 3) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  let dismissed = 0;
  for (const r of (state.dayTrading.recommendations || [])) {
    if (r.status === 'pending' && r.generatedAtMs && r.generatedAtMs < cutoff) {
      r.status = 'dismissed';
      dismissed++;
    }
  }
  if (dismissed) console.log(`[DT] Auto-dismissed ${dismissed} stale pending rec(s) (>${maxAgeDays}d old)`);
}

// Single entry point for the "Run Day Trade Scan" button. Dispatches on
// state.dayTrading.universeKey: 'portfolio_watchlist' (default) runs the
// lightweight portfolio+watchlist-only scan; any real index key (asx20/50/
// 100/200) runs the batched universe scan. Kept as two internal functions
// (rather than one merged body) because their fetch strategies genuinely
// differ — single-batch vs paginated-with-progress/cancel — merging them
// would just be a big if/else inside one function with no benefit.
async function runDayTradeAnalysis() {
  const universeKey = state.dayTrading.universeKey || 'portfolio_watchlist';
  if (universeKey === 'portfolio_watchlist') return _runPortfolioWatchlistScan();
  return _runUniverseScan();
}

async function _runPortfolioWatchlistScan() {
  if (state.dayTrading.analysisRunning) { toast('Day trade analysis already running', 'info'); return; }

  state.dayTrading.analysisRunning = true;
  renderPage();
  toast('Running day trade scan…', 'info');

  // ── Refresh prices first ─────────────────────────────────────────────────────
  if (state.serverOk && state.portfolio.length) {
    try { await refreshPrices({ silent: true }); } catch {}
  }

  // ── Fetch 1y signals for portfolio + DT extra tickers (SMA200 needs 200 days) ─
  const portfolioTickers = mergedPortfolio().map(h => h.ticker);
  const dtExtra = (state.dayTrading.extraTickers || []).filter(t => !portfolioTickers.includes(t));
  const allTickers = [...portfolioTickers, ...dtExtra];

  if (state.serverOk && allTickers.length) {
    try {
      const r = await fetch(`${API}/api/analyse/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers: allTickers, period: '1y' }),
      });
      if (r.ok) {
        const data = await r.json();
        const now = Date.now();
        allTickers.forEach(t => {
          state.liveSignals[t] = data[t];
          state.lastSignalFetch[t] = now;
        });
      }
    } catch {}
  }

  // ── Cash and sizing ──────────────────────────────────────────────────────────
  const allocated = state.dayTrading.allocatedCash != null
    ? state.dayTrading.allocatedCash
    : Math.round(state.cash * 0.20);
  const riskPct = state.dayTrading.riskPct || 1.5;
  const _ap = { ...DT_AI_PARAMS, ...(state.dayTrading.aiParams || {}) };
  const _dtPortCtx = {
    allocatedCash: allocated,
    portfolioValue: portfolioValue(),
    brokerage: state.settings.brokerage,
    rbaRate: state.rbaRate || 4.35,
    riskPct,
  };
  const _dtRegime = state.currentRegime?.regime;

  // ── Auto-dismiss stale pending recs before replacing ─────────────────────────
  _dtDismissStaleRecs(3);

  // ── Quantitative setup detection (no Claude) ─────────────────────────────────
  const { passing: candidates, stats: filterStats } = _dtPreFilterWithStats(allTickers);
  const newRecs = _dtBuildRecs(candidates, _ap, _dtPortCtx, _dtRegime);
  const newRecTickers = new Set(newRecs.map(r => r.ticker));

  // Mirrors the merge-by-ticker protection in _runUniverseScan(): never wholesale-
  // overwrite state.dayTrading.recommendations. Executed/closed/dismissed (or
  // manually-added) recs must survive a rescan regardless of whether they
  // reappear in this scan's candidate set — overwriting them would silently
  // desync the Active Setups UI from positions that are actually still open
  // (or already closed) in state.intraday.openPositions / the trade journal.
  const kept = (state.dayTrading.recommendations || []).filter(r => r.status !== 'pending');

  // Previously-pending recs that did NOT reappear in this scan's results must
  // not be silently dropped either — keep them flagged _stale and age them out
  // after a few consecutive missed scans (same cutoff as _runUniverseScan()).
  const MAX_STALE_SCANS = 3;
  const stalePrevPending = (state.dayTrading.recommendations || [])
    .filter(r => r.status === 'pending' && !newRecTickers.has(r.ticker))
    .map(r => ({ ...r, _stale: true, _staleScans: (r._staleScans || 0) + 1 }))
    .filter(r => r._staleScans <= MAX_STALE_SCANS);

  state.dayTrading.recommendations = [...kept, ...stalePrevPending, ...newRecs];
  const _rejLine = `BB:${filterStats.bb} ADV:${filterStats.adv} SMA:${filterStats.sma} ADX:${filterStats.adx}${filterStats.vov ? ` VoV:${filterStats.vov}` : ''}${filterStats.noData ? ` NoData:${filterStats.noData}` : ''}`;
  const _bb = state.dayTrading._breadthBlocked;
  const _bbNote = _bb
    ? `⚠ BREADTH GATE: ADR ${(100 * _bb.adr).toFixed(0)}% < ${(100 * _bb.threshold).toFixed(0)}% — ${_bb.suppressed} setup(s) suppressed (shadow-logged). `
    : '';
  const _tw = state.dayTrading._towBlocked;
  const _twNote = _tw
    ? `⏰ TIME-OF-WEEK: ${_tw.rule} — ${_tw.suppressed} setup(s) deferred (re-scan after the window). `
    : '';
  state.dayTrading.lastSummary = {
    text: `${_bbNote}${_twNote}Quant scan: ${newRecs.length} setup(s) · ${candidates.length}/${allTickers.length} passed · Rejected — ${_rejLine}`,
    filterStats,
    date: todayStr(),
    time: nowSydney(),
    recCount: newRecs.length,
  };
  state.dayTrading.analysisRunning = false;
  scheduleSave();
  toast(`Day trade scan: ${newRecs.length} setup(s) found`, newRecs.length > 0 ? 'success' : 'info');
  renderPage();
}

// ── _dtTimeOfWeekBlocked ──────────────────────────────────────────────────────
// §2.9 time-of-week filter: no NEW swing entries Monday before 11:00 (weekend
// gaps unresolved) or Friday from 14:00 (weekend gap risk before the stop can
// be adjusted). Sydney wall-clock via Intl — NOT the local clock; the host may
// not run in AEST. Existing positions are managed normally. Returns a
// { rule } object when blocked, else null. `now` injectable for tests.
function _dtTimeOfWeekBlocked(now) {
  const fp = { ...DT_FILTER, ...(state.dayTrading?.filterParams || {}) };
  if (!fp.timeOfWeekFilter) return null;
  let wd, hh;
  try {
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now || new Date());
    const get = t => (parts.find(p => p.type === t) || {}).value || '';
    wd = get('weekday');
    hh = parseInt(get('hour'), 10);
  } catch (_) { return null; }   // Intl unavailable — fail open
  if (Number.isNaN(hh)) return null;
  if (wd.startsWith('Mon') && hh < 11)  return { rule: 'Monday before 11:00 AEST' };
  if (wd.startsWith('Fri') && hh >= 14) return { rule: 'Friday from 14:00 AEST' };
  return null;
}

// ── _dtBuildRecs ──────────────────────────────────────────────────────────────
// Scores pre-filtered tickers against the DT signal stack and returns recs.
// Called by both _runPortfolioWatchlistScan() and _runUniverseScan().
function _dtBuildRecs(candidates, ap, portCtx, regime) {
  const _minConf = ap.minConfidence ?? DT_AI_PARAMS.minConfidence;
  const _minRR   = ap.minRrRatio   ?? DT_AI_PARAMS.minRrRatio;
  const recs = [];

  // §2.7 market breadth gate — when fewer than minAdr of the ASX200 sit above
  // their 20-day SMA, mean-reversion hit rates collapse. Setups are still built
  // (so they can be shadow-logged for the ML at full stop/target fidelity) but
  // NONE are surfaced. Tunable via Day Trading → Rules (filterParams.minAdr) —
  // tick off the "Market breadth floor" row to disable instead of zeroing the value.
  const _adr    = state.macroData?.advance_decline_ratio;
  const _minAdr = (state.dayTrading?.filterParams?.minAdr ?? DT_FILTER.minAdr ?? 0.25);
  const _minAdrOn = _ruleOn(state.dayTrading?.filterParams || {}, 'minAdr');
  const _breadthBlocked = _minAdrOn && _adr != null && _minAdr > 0 && _adr < _minAdr;

  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    const s = state.liveSignals[t];
    if (!s || s.error) continue;

    // Signal #1: BB reclaim — confirmed by _dtPreFilter (bb_pct_b ≤ threshold).
    // Always present — it's structurally guaranteed by the pre-filter, so it
    // isn't one of the togglable rows in the Rules table.
    const signals = ['BB reclaim'];

    // Fib zone — 50%–61.8% retracement of 60-day range. Uses high_60d/low_60d
    // when available; falls back to return_60d range.
    const _fibOk = (() => {
      const px = s.current_price;
      if (s.high_60d != null && s.low_60d != null && s.high_60d > s.low_60d) {
        const range = s.high_60d - s.low_60d;
        const fib50  = s.low_60d + 0.50  * range;
        const fib618 = s.low_60d + 0.618 * range;
        return px >= fib50 && px <= fib618;
      }
      return s.return_60d != null
        && s.return_60d >= (ap.fibReturnMin ?? -20)
        && s.return_60d <= (ap.fibReturnMax ?? -5);
    })();

    // Signals #2–#5: each independently togglable in Day Trading → Rules →
    // Entry Signal Thresholds. A ticked signal MUST fire (AND logic across
    // every ticked signal) — replaces the old hardcoded "Signal #1 + ≥2 of 4"
    // combination rule with explicit per-signal selection: tick 1 signal and
    // only that one is required, tick all 4 and all 4 are required.
    const _sigDefs = [
      { key: 'rsiThreshold', fired: s.rsi_14 != null && s.rsi_14 < (ap.rsiThreshold ?? 35),
        label: () => `RSI ${s.rsi_14.toFixed(1)}` },
      { key: 'volZScore', fired: s.volume_z_score != null && s.volume_z_score >= (ap.volZScore ?? 1.5),
        label: () => `VolZ ${s.volume_z_score.toFixed(2)}σ` },
      { key: 'fibZone', fired: _fibOk, label: () => 'Fib zone' },
      { key: 'obvRising', fired: s.obv_trend === 'rising', label: () => 'OBV rising' },
    ];
    let _allTickedFired = true;
    for (const sig of _sigDefs) {
      if (!_ruleOn(ap, sig.key)) continue;   // unticked — excluded entirely, not required, not shown
      if (sig.fired) signals.push(sig.label());
      else _allTickedFired = false;
    }
    if (!_allTickedFired) continue;

    // Confidence scales with how many of the ticked signals actually fired —
    // signals.length always includes the automatic "BB reclaim" entry, so
    // subtract 1 to get the count of additional confirmations.
    const confirms = signals.length - 1;
    const confidence = Math.min(0.50 + confirms * 0.08, 0.90);
    if (_ruleOn(ap, 'minConfidence') && confidence < _minConf) continue;

    const entry = s.current_price;
    let rec = {
      ticker: t, action: 'BUY', confidence,
      priceRange: [entry, +(entry * 1.01).toFixed(3)],
      signals,
      reasoning: `Quant signals: ${signals.join(' · ')}`,
      regime: regime || 'unknown',
    };

    if (typeof computeTradeParams === 'function') {
      const qt = computeTradeParams(t, s, portCtx, {
        winProb: confidence,
        expectedTimeToTarget: 8,
        priceRange: rec.priceRange,
      });
      if (!qt.ok) continue;
      rec = { ...rec, qty: qt.qty, stopLoss: qt.stopLoss, target: qt.target,
              rrRatio: qt.rrRatio, riskAUD: qt.riskAUD, rewardAUD: qt.rewardAUD, _quantEngine: true };
    }

    if (!rec.rrRatio) continue;   // missing R:R is a data problem, not a togglable rule
    if (_ruleOn(ap, 'minRrRatio') && rec.rrRatio < _minRR) continue;

    if (typeof applyRegimeModifiers === 'function' && regime) {
      rec = applyRegimeModifiers(rec, regime);
    }

    recs.push({
      ...rec,
      id:            `DT-${Date.now()}-${i}`,
      status:        'pending',
      date:          todayStr(),
      generatedAt:   nowSydney(),
      generatedAtMs: Date.now(),       // epoch ms — used for staleness detection
      holdDays:      8,                // estimated hold period in trading days
    });
  }

  // §2.7 breadth gate: suppress everything, shadow-log what would have fired
  if (_breadthBlocked) {
    if (typeof dtSaveSnapshot === 'function') {
      recs.forEach(r => {
        if (!r.stopLoss || !r.target) return;  // shadow resolution needs both
        dtSaveSnapshot(r, 'swing', state.liveSignals[r.ticker] || {}, state.macroData || {},
          Array.isArray(r.priceRange) ? r.priceRange[0] : 0, 0,
          { record_type: 'shadow', shadow_reason: 'breadth_blocked' });
      });
    }
    state.dayTrading._breadthBlocked = {
      adr: _adr, threshold: _minAdr, suppressed: recs.length,
      at: new Date().toISOString(),
    };
    return [];
  }
  state.dayTrading._breadthBlocked = null;

  // §2.9 time-of-week gate: suppress new entries during asymmetric gap-risk
  // windows. NOT shadow-logged — these windows are hours long and the same
  // setup re-scanned after the window would double-count in the ML.
  const _tow = _dtTimeOfWeekBlocked();
  if (_tow && recs.length > 0) {
    state.dayTrading._towBlocked = {
      rule: _tow.rule, suppressed: recs.length, at: new Date().toISOString(),
    };
    return [];
  }
  state.dayTrading._towBlocked = null;

  // Sort: most signals first, then lowest BB %B (closest to lower band)
  return recs.sort((a, b) => {
    const sa = a.signals?.length || 0, sb = b.signals?.length || 0;
    if (sb !== sa) return sb - sa;
    return (state.liveSignals[a.ticker]?.bb_pct_b ?? 1) - (state.liveSignals[b.ticker]?.bb_pct_b ?? 1);
  });
}

// Execute a day trade rec — shows price+brokerage dialog, then adds to journal
function executeDayTrade(recId) {
  const rec = state.dayTrading.recommendations.find(r => r.id === recId);
  if (!rec) return;

  const defaultPrice = rec.priceRange
    ? ((rec.priceRange[0] + rec.priceRange[1]) / 2)
    : (rec.target || 0);

  // _showTradeDialog is defined in pages/day-trading.js (loads after this file).
  // onConfirm receives (price, fee, actualQty) — user can override the AI-suggested qty.
  _showTradeDialog({
    ticker: rec.ticker,
    action: 'BUY',
    qty:    rec.qty,
    defaultPrice,
  }, async (entryPrice, brokerage, actualQty) => {
    // Use user-entered qty; fall back to AI qty if dialog didn't return one
    const qty  = (actualQty && actualQty > 0) ? actualQty : rec.qty;
    const cost = qty * entryPrice + brokerage;
    if (cost > state.cash) { toast('Insufficient cash', 'error'); return; }

    // Ensure live signals are available — fetch fresh if the scan cache is stale
    // or this ticker wasn't in the last scan. This is the main gap: without a
    // fallback fetch, entrySignals would be all nulls for tickers not in liveSignals.
    if (!state.liveSignals?.[rec.ticker]?.rsi_14) {
      try {
        const _r = await fetch(`${API}/api/analyse/${encodeURIComponent(rec.ticker)}`);
        if (_r.ok) {
          const _d = await _r.json();
          if (!state.liveSignals) state.liveSignals = {};
          state.liveSignals[rec.ticker] = { ...(_d || {}), ...state.liveSignals[rec.ticker] };
        }
      } catch { /* offline — proceed without signals */ }
    }

    // Sector concentration warning — fire a toast if another executed DT rec
    // shares the same sector. Non-blocking; trader decides to proceed or not.
    const thisSector = (state.liveSignals[rec.ticker] || {}).sector || '';
    if (thisSector) {
      const sectorCount = (state.dayTrading.recommendations || [])
        .filter(r => r.status === 'executed' && ((state.liveSignals[r.ticker] || {}).sector || '') === thisSector)
        .length;
      if (sectorCount >= 1) {
        toast(`⚠️ Sector concentration: ${sectorCount} other executed ${thisSector} swing trade(s)`, 'warning');
      }
    }

    const sector = (state.liveSignals?.[rec.ticker] || {}).sector || 'Other';

    // Create portfolio holding and CGT parcel — tagged 'trading' account so it
    // is kept separate from long-term personal/super holdings on the Portfolio page.
    applyBuyToPortfolio(rec.ticker, qty, parseFloat(entryPrice.toFixed(3)), todayStr(), brokerage, sector, 'trading');
    const newParcel = (state.cgtParcels || []).length
      ? state.cgtParcels[state.cgtParcels.length - 1]
      : null;
    // Links this rec to its own parcel so setParcelAccount() (portfolio-helpers.js)
    // and splitParcel()'s position-splitting can find and adjust it precisely if
    // this lot is later split or moved out of 'trading'.
    rec.parcelId = newParcel ? newParcel.id : null;

    const _swingSig = (state.liveSignals && state.liveSignals[rec.ticker]) || {};
    const entry = {
      id:          Date.now(),
      date:        todayStr(),
      timestamp:   nowSydney(),
      ticker:      rec.ticker,
      action:      'BUY',
      qty,                        // actual user-entered qty, not AI-suggested
      entryPrice:  parseFloat(entryPrice.toFixed(3)),
      exitPrice:   null,
      fees:        brokerage,
      pnl:         null,
      status:      'open',
      sector,
      account:     'trading',
      parcelId:    newParcel ? newParcel.id : null,
      recId:       rec.id,
      recExecuted: true,
      regime:      (state.currentRegime && state.currentRegime.regime) || null,
      notes:       `SwingTrade | Target:$${rec.target} | Stop:$${rec.stopLoss} | R:R ${rec.rrRatio?.toFixed(1)}x | Hold:${rec.holdDays}d`,
      entrySignals: _swingSig.rsi_14 != null ? {
        rsi_14:      _swingSig.rsi_14     ?? null,
        bb_pct_b:    _swingSig.bb_pct_b   ?? null,
        adx_14:      _swingSig.adx        ?? _swingSig.adx_14 ?? null,
        atr_pct:     _swingSig.atr_pct    ?? null,
        return_5d:   _swingSig.return_5d  ?? null,
        return_20d:  _swingSig.return_20d ?? null,
        return_60d:  _swingSig.return_60d ?? null,
        macd_hist:   _swingSig.macd_hist  ?? null,
        setup_score: _swingSig.score      ?? null,
        sector_rs_5d:_swingSig.sector_rs_5d ?? null,
        adv_20:      _swingSig.adv_20     ?? null,
        price:       parseFloat(entryPrice.toFixed(3)),
      } : null,
    };
    state.tradeJournal.unshift(entry);
    state.cash -= cost;   // applyBuyToPortfolio does not update cash; deduct manually
    rec.status    = 'executed';
    rec._execQty  = qty;         // remember actual qty for close dialog and display
    scheduleSave();
    pushCashToDb(state.cash);
    const qtyNote = (qty !== rec.qty) ? ` (AI suggested ${rec.qty})` : '';
    toast(`Executed ${rec.ticker} swing trade — ${qty} shares @ $${entryPrice.toFixed(3)} (fee $${brokerage})${qtyNote}`, 'success');

    // Record ML training snapshot — signals are now guaranteed fresh from the fetch above
    if (typeof dtSaveSnapshot === 'function') {
      dtSaveSnapshot(rec, 'swing', _swingSig, state.macroData || {}, entryPrice, qty)
        .then(function(snapId) { if (snapId) rec._snapshotId = snapId; scheduleSave(); });
    }

    renderPage();
  });
}

function dismissDayTradeRec(recId) {
  const rec = state.dayTrading.recommendations.find(r => r.id === recId);
  if (rec) rec.status = 'dismissed';
  scheduleSave();
  renderPage();
}

// ── Swing parcel sync (mirrors the Intraday _openIntradayPositionFromParcel /
// _removeIntradayPositionForParcel pair in js/pages/day-trading.js) ──────────
// Called from setParcelAccount() (portfolio-helpers.js) whenever a lot moves
// into/out of the 'trading' account, keyed strictly by parcelId.

// Creates an executed swing rec from a parcel reassigned INTO 'trading'. Not a
// new transaction — entryPrice is the lot's own cost basis, qty is fixed by
// the lot's share count (not AI-sized), and there's no paired journal BUY row
// (setParcelAccount's logParcelReclassification call covers the audit trail).
async function _openSwingPositionFromParcel(parcel) {
  const ticker = parcel.ticker;
  const entryPrice = parcel.costPerShare;

  if (!state.liveSignals?.[ticker]?.atr_14) {
    try {
      const r = await fetch(`${API}/api/analyse/${encodeURIComponent(ticker)}`);
      if (r.ok) {
        const d = await r.json();
        if (!state.liveSignals) state.liveSignals = {};
        state.liveSignals[ticker] = { ...(d || {}), ...state.liveSignals[ticker] };
      }
    } catch (_) { /* best-effort — fall back to fixed R:R below if signals stay empty */ }
  }
  const signals = state.liveSignals?.[ticker] || {};
  const regime = state.currentRegime?.regime;

  let stopLoss = null, target = null, rrRatio = null;
  if (typeof computeTradeParams === 'function' && signals.atr_14 != null) {
    const allocated = state.dayTrading.allocatedCash != null ? state.dayTrading.allocatedCash : Math.round(state.cash * 0.20);
    const portCtx = {
      allocatedCash: allocated, portfolioValue: portfolioValue(),
      brokerage: state.settings.brokerage, rbaRate: state.rbaRate || 4.35,
      riskPct: state.dayTrading.riskPct || 1.5,
    };
    try {
      const qt = computeTradeParams(ticker, signals, portCtx, {
        winProb: 0.6, expectedTimeToTarget: 8, priceRange: [entryPrice, +(entryPrice * 1.01).toFixed(3)],
      });
      if (qt && qt.ok) { stopLoss = qt.stopLoss; target = qt.target; rrRatio = qt.rrRatio; }
    } catch (_) {}
  }
  if (stopLoss == null) {
    // Fallback when quant sizing rejects or ATR is unavailable — direct
    // regime-aware calc, same stopAtrMult convention used everywhere else.
    const stopAtrMult = (typeof getRegimeModifiers === 'function' && regime)
      ? (getRegimeModifiers(regime).stopAtrMult ?? 2.5) : 2.5;
    const atr = signals.atr_14 || entryPrice * 0.02; // crude fallback: 2% of price
    stopLoss = +(entryPrice - stopAtrMult * atr).toFixed(3);
    target   = +(entryPrice + (entryPrice - stopLoss) * 2.0).toFixed(3);
    rrRatio  = 2.0;
  }

  if (!state.dayTrading.recommendations) state.dayTrading.recommendations = [];
  state.dayTrading.recommendations.push({
    id:            `LOT-${Date.now()}-${ticker}`,
    parcelId:      parcel.id,
    ticker,
    action:        'BUY',
    status:        'executed',
    qty:           parcel.remainingQty,
    _execQty:      parcel.remainingQty,
    entryPrice,
    stopLoss, target, rrRatio,
    date:          todayStr(),
    generatedAt:   nowSydney(),
    generatedAtMs: Date.now(),
    holdDays:      8,
    regime:        regime || 'unknown',
    signals:       ['Reclassified into trading'],
    reasoning:     'Lot reassigned from another account — not a new AI signal.',
  });
  scheduleSave();
  renderPage();
}

// Removes (dismisses) the swing rec tied to a parcel moving OUT of 'trading'.
// Uses 'dismissed' rather than 'closed' — dismissDayTradeRec() confirms that
// status is a pure flip with no journal/cash/P&L side effect, whereas
// 'closed' (_closeDayTrade) always implies a real disposal. No sale happened
// here, so faking one would corrupt P&L/learning-loop stats.
function _removeSwingPositionForParcel(parcel) {
  const recs = state.dayTrading.recommendations || [];
  const byId = recs.find(r => r.status === 'executed' && r.parcelId === parcel.id);
  if (byId) { byId.status = 'dismissed'; return; }
  const byTicker = recs.find(r => r.status === 'executed' && r.ticker === parcel.ticker && r.parcelId == null);
  if (byTicker) byTicker.status = 'dismissed';
}

// ============================================================
// UNIVERSE SCANNER
// Pre-filters the selected ASX index (20/50/100/200) for BB
// setups before sending candidates to Claude.
// ============================================================

let _dtUniverseCancelled = false;

function cancelUniverseScan() {
  _dtUniverseCancelled = true;
  toast('Cancelling universe scan…', 'info');
}

// _dtPreFilter is defined in js/strategy.js — edit thresholds there.

function _updateUniverseProgress(msg) {
  const el = document.getElementById('dt-universe-progress');
  if (el) el.innerHTML = msg;
}

async function _runUniverseScan() {
  if (state.dayTrading.analysisRunning) {
    toast('A portfolio scan is already running. Please wait.', 'info');
    return;
  }
  const universeKey = state.dayTrading.universeKey || 'asx200';
  const universeTickers = getUniverseTickers(universeKey);
  if (!universeTickers.length) { toast('Unknown universe key', 'error'); return; }

  const meta = ASX_UNIVERSE_META[universeKey] || { label: universeKey };
  _dtUniverseCancelled = false;
  state.dayTrading.analysisRunning = true;
  state.dayTrading.scanProgress = { phase: 'fetching', current: 0, total: universeTickers.length, candidates: 0 };
  renderPage();

  const BATCH = 15;
  const t0 = Date.now();

  // ── Phase 1: Fetch data in batches ──────────────────────────────────────────
  for (let i = 0; i < universeTickers.length; i += BATCH) {
    if (_dtUniverseCancelled) {
      state.dayTrading.analysisRunning = false;
      state.dayTrading.scanProgress = null;
      toast('Universe scan cancelled.', 'info');
      renderPage();
      return;
    }
    const batch = universeTickers.slice(i, i + BATCH);
    try {
      const r = await fetch(`${API}/api/analyse/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers: batch, period: '1y' }),
      });
      if (r.ok) {
        const data = await r.json();
        const now = Date.now();
        batch.forEach(t => {
          state.liveSignals[t] = data[t] || { error: 'no data' };
          state.lastSignalFetch[t] = now;
        });
      }
    } catch {}

    state.dayTrading.scanProgress = {
      phase: 'fetching',
      current: Math.min(i + BATCH, universeTickers.length),
      total: universeTickers.length,
      candidates: 0,
    };
    _updateUniverseProgress(_renderUniverseProgressHtml());
  }

  if (_dtUniverseCancelled) {
    state.dayTrading.analysisRunning = false;
    state.dayTrading.scanProgress = null;
    toast('Universe scan cancelled.', 'info');
    renderPage();
    return;
  }

  // ── Phase 2: Pre-filter ──────────────────────────────────────────────────────
  _dtDismissStaleRecs(3);
  const { passing: candidates, stats: filterStats } = _dtPreFilterWithStats(universeTickers);
  const elapsedFetch = ((Date.now() - t0) / 1000).toFixed(0);
  const _rejLine = `BB:${filterStats.bb} ADV:${filterStats.adv} SMA:${filterStats.sma} ADX:${filterStats.adx}${filterStats.vov ? ` VoV:${filterStats.vov}` : ''}${filterStats.noData ? ` NoData:${filterStats.noData}` : ''}`;

  if (candidates.length === 0) {
    state.dayTrading.analysisRunning = false;
    state.dayTrading.scanProgress = null;
    state.dayTrading.lastSummary = {
      text: `${meta.label} universe scan: 0 candidates passed pre-filter. Rejected — ${_rejLine}. Fetch took ${elapsedFetch}s.`,
      filterStats,
      date: todayStr(),
      time: nowSydney(),
      recCount: 0,
      source: 'universe',
      universeKey,
    };
    scheduleSave();
    toast(`${meta.label} scan: no candidates passed pre-filter`, 'info');
    renderPage();
    return;
  }

  // ── Phase 3: Quantitative rec generation ────────────────────────────────────
  const _uAp = { ...DT_AI_PARAMS, ...(state.dayTrading.aiParams || {}) };
  const allocated = state.dayTrading.allocatedCash != null ? state.dayTrading.allocatedCash : Math.round(state.cash * 0.20);
  const riskPct = state.dayTrading.riskPct || 1.5;
  const _uPortCtx = {
    allocatedCash: allocated,
    portfolioValue: portfolioValue(),
    brokerage: state.settings.brokerage,
    rbaRate: state.rbaRate || 4.35,
    riskPct,
  };
  const _uRegime = state.currentRegime?.regime;

  const newRecs = _dtBuildRecs(candidates, _uAp, _uPortCtx, _uRegime)
    .map(r => ({ ...r, source: 'universe', universeKey }));
  const newRecTickers = new Set(newRecs.map(r => r.ticker));

  // Non-pending-universe recs (executed/closed/dismissed, or manually-added) are
  // untouched by this merge — same as before.
  const kept = (state.dayTrading.recommendations || []).filter(r => r.status !== 'pending' || r.source !== 'universe');

  // Previously-pending universe recs that did NOT reappear in this scan's results
  // (filtered out by thresholds, crowded out by a per-scan cap, etc.) must not be
  // silently dropped — the ticker may still be a setup the user is tracking. Keep
  // them, flagged _stale, and age them out after a few consecutive missed scans
  // so Active Setups doesn't accumulate dead entries forever.
  // TODO: 3 consecutive missed scans is a judgement call (mirrors the existing
  // _dtDismissStaleRecs 3-day age cutoff above) — revisit if it proves too eager/lax.
  const MAX_STALE_SCANS = 3;
  const stalePrevPending = (state.dayTrading.recommendations || [])
    .filter(r => r.status === 'pending' && r.source === 'universe' && !newRecTickers.has(r.ticker))
    .map(r => ({ ...r, _stale: true, _staleScans: (r._staleScans || 0) + 1 }))
    .filter(r => r._staleScans <= MAX_STALE_SCANS);

  state.dayTrading.recommendations = [...kept, ...stalePrevPending, ...newRecs];

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  const _ubb = state.dayTrading._breadthBlocked;
  const _ubbNote = _ubb
    ? `⚠ BREADTH GATE: ADR ${(100 * _ubb.adr).toFixed(0)}% < ${(100 * _ubb.threshold).toFixed(0)}% — ${_ubb.suppressed} setup(s) suppressed (shadow-logged). `
    : '';
  const _utw = state.dayTrading._towBlocked;
  const _utwNote = _utw
    ? `⏰ TIME-OF-WEEK: ${_utw.rule} — ${_utw.suppressed} setup(s) deferred (re-scan after the window). `
    : '';
  state.dayTrading.lastSummary = {
    text: `${_ubbNote}${_utwNote}${meta.label}: ${candidates.length}/${universeTickers.length} passed · ${newRecs.length} setup(s) · Rejected — ${_rejLine} (${elapsed}s)`,
    filterStats,
    date: todayStr(),
    time: nowSydney(),
    recCount: newRecs.length,
    source: 'universe',
    universeKey,
  };
  state.dayTrading.analysisRunning = false;
  state.dayTrading.scanProgress = null;
  scheduleSave();
  toast(`${meta.label} scan: ${newRecs.length} setup(s) from ${candidates.length} candidates`, newRecs.length > 0 ? 'success' : 'info');
  renderPage();
}

function _renderUniverseProgressHtml() {
  const p = state.dayTrading.scanProgress;
  if (!p) return '';
  const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
  const barColor = p.phase === 'analysing' ? '#6366f1' : '#f59e0b';
  const label = p.phase === 'fetching'
    ? `Fetching data… ${p.current}/${p.total} tickers`
    : `AI analysing ${p.total} candidate${p.total !== 1 ? 's' : ''}…`;
  return `
    <div style="margin-top:10px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:4px">
        <span>${label}</span>
        <span>${pct}%</span>
      </div>
      <div style="height:5px;background:var(--bg-secondary);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px;transition:width .3s"></div>
      </div>
    </div>`;
}
