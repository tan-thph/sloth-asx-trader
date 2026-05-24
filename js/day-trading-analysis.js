// ============================================================
// DAY TRADING ANALYSIS ENGINE
// Quantitative confluence strategy: 5–15 day swing trades.
// Primary: BB reclaim. Confirms: RSI<35, Vol Z-Score, Fib zone, OBV div.
// Stop: 2.5×ATR. Hard filters: ADV, SMA200, ADX, no catalyst.
// ============================================================

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

  // ── Quantitative setup detection (no Claude) ─────────────────────────────────
  const candidates = _dtPreFilter(allTickers);
  const newRecs = _dtBuildRecs(candidates, _ap, _dtPortCtx, _dtRegime);

  state.dayTrading.recommendations = newRecs;
  state.dayTrading.lastSummary = {
    text: `Quant scan: ${newRecs.length} setup(s) · ${candidates.length}/${allTickers.length} tickers passed pre-filter`,
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

    // Signal #4: Fib zone (60d return in pullback range)
    if (s.return_60d != null
        && s.return_60d >= (ap.fibReturnMin ?? -20)
        && s.return_60d <= (ap.fibReturnMax ?? -5))
      signals.push(`Fib ${s.return_60d.toFixed(1)}%`);

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
      id: `DT-${Date.now()}-${i}`,
      status: 'pending',
      date: todayStr(),
      generatedAt: nowSydney(),
    });
  }

  // Sort: most signals first, then lowest BB %B (closest to lower band)
  return recs.sort((a, b) => {
    const sa = a.signals?.length || 0, sb = b.signals?.length || 0;
    if (sb !== sa) return sb - sa;
    return (state.liveSignals[a.ticker]?.bb_pct_b ?? 1) - (state.liveSignals[b.ticker]?.bb_pct_b ?? 1);
  });
}

// Execute a day trade rec — adds to journal and marks executed
function executeDayTrade(recId) {
  const rec = state.dayTrading.recommendations.find(r => r.id === recId);
  if (!rec) return;
  const entryPrice = rec.priceRange ? ((rec.priceRange[0] + rec.priceRange[1]) / 2) : rec.target;
  const cost = rec.qty * entryPrice + (state.settings.brokerage || 10);
  if (cost > state.cash) { toast('Insufficient cash', 'error'); return; }

  const entry = {
    id: Date.now(),
    date: todayStr(),
    timestamp: nowSydney(),
    ticker: rec.ticker,
    action: 'BUY',
    qty: rec.qty,
    entryPrice: parseFloat(entryPrice.toFixed(3)),
    exitPrice: null,
    fees: state.settings.brokerage || 10,
    pnl: null,
    status: 'open',
    recId: rec.id,
    recExecuted: true,
    notes: `SwingTrade | Target:$${rec.target} | Stop:$${rec.stopLoss} | R:R ${rec.rrRatio?.toFixed(1)}x | Hold:${rec.holdDays}d`,
  };
  state.tradeJournal.unshift(entry);
  state.cash -= cost;
  rec.status = 'executed';
  scheduleSave();
  pushCashToDb(state.cash);
  toast(`Executed ${rec.ticker} swing trade — ${rec.qty} shares @ $${entryPrice.toFixed(3)}`, 'success');
  renderPage();
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
  const candidates = _dtPreFilter(universeTickers);
  const elapsedFetch = ((Date.now() - t0) / 1000).toFixed(0);

  if (candidates.length === 0) {
    state.dayTrading.analysisRunning = false;
    state.dayTrading.scanProgress = null;
    state.dayTrading.lastSummary = {
      text: `${meta.label} universe scan: 0 candidates passed pre-filter (BB + ADV + SMA200 + ADX). No setups today. Fetch took ${elapsedFetch}s.`,
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
    text: `${meta.label}: ${candidates.length}/${universeTickers.length} passed pre-filter → ${newRecs.length} setup(s) (${elapsed}s)`,
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
