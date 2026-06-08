// ============================================================
// DAY TRADING ANALYSIS ENGINE
// Quantitative confluence strategy: 5–15 day swing trades.
// Primary: BB reclaim. Confirms: RSI<35, Vol Z-Score, Fib zone, OBV div.
// Stop: regime-aware stopAtrMult×ATR (2.5–4.0×, via quant engine).
// Hard filters: ADV, SMA200, ADX, no catalyst.
// NOTE: Fully quantitative — no Claude call. getDayTradeSystemPrompt /
//       getDayTradeUniverseScanPrompt exist for potential future use but
//       are not invoked by runDayTradeAnalysis() or runUniverseScan().
// ============================================================

// ── _dtPreFilterWithStats ─────────────────────────────────────────────────────
// Same logic as _dtPreFilter() but returns rejection counts per filter so the UI
// can display a breakdown of why tickers were rejected.
function _dtPreFilterWithStats(tickers) {
  const fp = { ...DT_FILTER, ...(state.dayTrading.filterParams || {}) };
  const stats = { bb: 0, adv: 0, sma: 0, adx: 0, noData: 0 };
  const passing = [];

  for (const t of tickers) {
    const s = state.liveSignals[t];
    if (!s || s.error) { stats.noData++; continue; }
    if ((s.bb_pct_b  ?? 1) > fp.maxBbPctB)                                                                 { stats.bb++;  continue; }
    if ((s.adv_20    ?? 0) < fp.minAdvAud)                                                                  { stats.adv++; continue; }
    const ref = s.sma_200 ?? s.sma_50;
    if (ref && s.current_price < ref * fp.sma200Floor)                                                      { stats.sma++; continue; }
    if ((s.adx ?? 0) > fp.maxAdx && s.trend_strength === 'strong' && s.di_plus > s.di_minus)               { stats.adx++; continue; }
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

async function runDayTradeAnalysis() {
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

  state.dayTrading.recommendations = newRecs;
  const _rejLine = `BB:${filterStats.bb} ADV:${filterStats.adv} SMA:${filterStats.sma} ADX:${filterStats.adx}${filterStats.noData ? ` NoData:${filterStats.noData}` : ''}`;
  state.dayTrading.lastSummary = {
    text: `Quant scan: ${newRecs.length} setup(s) · ${candidates.length}/${allTickers.length} passed · Rejected — ${_rejLine}`,
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

// ── _dtBuildRecs ──────────────────────────────────────────────────────────────
// Scores pre-filtered tickers against the DT signal stack and returns recs.
// Called by both runDayTradeAnalysis() and runUniverseScan().
function _dtBuildRecs(candidates, ap, portCtx, regime) {
  const _minConf = ap.minConfidence ?? DT_AI_PARAMS.minConfidence;
  const _minRR   = ap.minRrRatio   ?? DT_AI_PARAMS.minRrRatio;
  const recs = [];

  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    const s = state.liveSignals[t];
    if (!s || s.error) continue;

    // Signal #1: BB reclaim — confirmed by _dtPreFilter (bb_pct_b ≤ threshold)
    const signals = ['BB reclaim'];

    // Signal #2: RSI oversold
    if (s.rsi_14 != null && s.rsi_14 < (ap.rsiThreshold ?? 35))
      signals.push(`RSI ${s.rsi_14.toFixed(1)}`);

    // Signal #3: Volume surge
    if (s.volume_z_score != null && s.volume_z_score >= (ap.volZScore ?? 1.5))
      signals.push(`VolZ ${s.volume_z_score.toFixed(2)}σ`);

    // Signal #4: Fib zone — 50%–61.8% retracement of 60-day range
    // Uses high_60d/low_60d when available; falls back to return_60d range
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
    if (_fibOk) signals.push(`Fib zone`);

    // Signal #5: OBV rising (bonus)
    if (s.obv_trend === 'rising') signals.push('OBV rising');

    // Strategy rule: Signal #1 + ≥2 confirms
    const confirms = signals.length - 1;
    if (confirms < 2) continue;

    const confidence = Math.min(0.50 + confirms * 0.08, 0.90);
    if (confidence < _minConf) continue;

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

    if (!rec.rrRatio || rec.rrRatio < _minRR) continue;

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
  }, (entryPrice, brokerage, actualQty) => {
    // Use user-entered qty; fall back to AI qty if dialog didn't return one
    const qty  = (actualQty && actualQty > 0) ? actualQty : rec.qty;
    const cost = qty * entryPrice + brokerage;
    if (cost > state.cash) { toast('Insufficient cash', 'error'); return; }

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
      notes:       `SwingTrade | Target:$${rec.target} | Stop:$${rec.stopLoss} | R:R ${rec.rrRatio?.toFixed(1)}x | Hold:${rec.holdDays}d`,
    };
    state.tradeJournal.unshift(entry);
    state.cash -= cost;   // applyBuyToPortfolio does not update cash; deduct manually
    rec.status    = 'executed';
    rec._execQty  = qty;         // remember actual qty for close dialog and display
    scheduleSave();
    pushCashToDb(state.cash);
    const qtyNote = (qty !== rec.qty) ? ` (AI suggested ${rec.qty})` : '';
    toast(`Executed ${rec.ticker} swing trade — ${qty} shares @ $${entryPrice.toFixed(3)} (fee $${brokerage})${qtyNote}`, 'success');

    // Record ML training snapshot (fire-and-forget — failure never blocks execution)
    if (typeof dtSaveSnapshot === 'function') {
      const signals = (state.liveSignals && state.liveSignals[rec.ticker]) || {};
      dtSaveSnapshot(rec, 'swing', signals, state.macroData || {}, entryPrice, qty)
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

async function runUniverseScan() {
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
  const _rejLine = `BB:${filterStats.bb} ADV:${filterStats.adv} SMA:${filterStats.sma} ADX:${filterStats.adx}${filterStats.noData ? ` NoData:${filterStats.noData}` : ''}`;

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

  const kept = (state.dayTrading.recommendations || []).filter(r => r.status !== 'pending' || r.source !== 'universe');
  state.dayTrading.recommendations = [...kept, ...newRecs];

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  state.dayTrading.lastSummary = {
    text: `${meta.label}: ${candidates.length}/${universeTickers.length} passed · ${newRecs.length} setup(s) · Rejected — ${_rejLine} (${elapsed}s)`,
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
