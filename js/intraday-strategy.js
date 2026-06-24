// ============================================================
// INTRADAY STRATEGY — ASX100 same-day 3-4% day-trade strategy
// ============================================================
// Buys technically discounted stocks (below VWAP, RSI oversold)
// and exits at a configurable +3–4% target the same session.
// Entry window: 10:45–15:00 AEST only. Max 2 concurrent positions.
//
// Globals used from other modules (loaded earlier):
//   API, state, toast, renderPage, fmt, todayStr, nowSydney
//   getUniverseTickers, computeTradeParams, scheduleSave

const INTRADAY_DEFAULTS = {
  targetPct:       3.5,   // exit target % (fallback when ATR unavailable)
  stopPct:         1.5,   // stop loss % (fallback when ATR unavailable)
  maxPositions:    2,     // max concurrent intraday trades
  minScore:        40,    // minimum setup score (0–100) — always enforced, not part of the signal count
  allocPct:        20,    // % of state.cash allocated to intraday
  // Replaces the old binary "Extreme Mode" (which bypassed window/VWAP/RSI/
  // vol/R:R all at once with no granularity). A ticker needs at least this
  // many of the 4 confirmation signals below (VWAP, RSI, Vol rising, Above
  // open) to qualify — lower it during testing instead of an all-or-nothing
  // bypass. Entry-window timing is a separate concern (see ignoreEntryWindow
  // below), not one of the 4 counted signals.
  minConfirms:     2,
  ignoreEntryWindow: false, // testing-only: skip the 10:45–15:00 AEST entry-window gate
  // ── Technical indicator thresholds (each is one of the 4 counted signals) ──
  vwapThreshold:   -0.3,  // price must be ≤ VWAP + this % (e.g. -0.3 = 0.3% below VWAP)
  rsiThreshold:    40,    // intraday RSI must be ≤ this value to qualify
  stopAtrMult:     1.5,   // stop = entry − N × ATR5m (when ATR available)
  targetAtrMult:   2.0,   // target = VWAP + N × ATR5m (overrides fixed % when ATR available)
  minRrRatio:      1.5,   // reject setups with R:R below this after computing stop/target — always enforced
};

// ── Build recs from scan results ──────────────────────────────────────────────

function _buildIntradayRecs(scanData) {
  const id = state.intraday || {};
  const ip = { ...INTRADAY_DEFAULTS, ...(id.params || {}) };
  const allocated = id.allocatedCash != null
    ? id.allocatedCash
    : Math.round(state.cash * ip.allocPct / 100);
  const openCount = (id.openPositions || []).length;
  const recs = [];

  // Sort entries by score descending so best setups come first
  const entries = Object.entries(scanData || {});
  entries.sort((a, b) => (b[1].score || 0) - (a[1].score || 0));

  for (const [ticker, d] of entries) {
    if (d.error) continue;
    if (d.score < ip.minScore) continue;
    if (openCount + recs.length >= ip.maxPositions) break;

    // Entry-window timing is a hard market-structure constraint, not a
    // confirmation signal — kept separate from the minConfirms count below.
    // ignoreEntryWindow exists purely for testing outside 10:45–15:00 AEST.
    if (!ip.ignoreEntryWindow && !d.in_entry_window) continue;

    // Client-side effective-pass gate (uses raw backend metrics, ignores
    // backend's hardcoded thresholds): count how many of the 4 confirmation
    // signals fire, and require at least ip.minConfirms of them. Replaces
    // the old binary "Extreme Mode" (which bypassed all of these at once
    // with no granularity) — lower minConfirms during testing instead.
    const signals = [];
    if (d.pct_from_vwap != null && d.pct_from_vwap <= ip.vwapThreshold)
      signals.push(`VWAP −${Math.abs(d.pct_from_vwap).toFixed(1)}%`);
    if (d.intraday_rsi != null && d.intraday_rsi <= ip.rsiThreshold)
      signals.push(`RSI ${d.intraday_rsi}`);
    if (d.vol_rising)
      signals.push('Volume↑');
    if (d.current_price != null && d.day_open != null && d.current_price > d.day_open)
      signals.push('Above open');
    if (signals.length < ip.minConfirms) continue;

    const entry = d.current_price;
    // Use 5m ATR when available with user-configured multipliers; fall back to fixed-pct
    let stopLoss, target;
    if (d.atr_5m && d.atr_5m > 0) {
      stopLoss = Math.round((entry - ip.stopAtrMult * d.atr_5m) * 1000) / 1000;
      // Use user-configured target multiplier off VWAP; fall back to backend target or fixed-pct
      if (d.vwap && d.vwap > 0) {
        target = Math.round((d.vwap + ip.targetAtrMult * d.atr_5m) * 1000) / 1000;
      } else {
        target = d.intraday_target || Math.round(entry * (1 + ip.targetPct / 100) * 1000) / 1000;
      }
    } else {
      stopLoss = Math.round(entry * (1 - ip.stopPct  / 100) * 1000) / 1000;
      target   = Math.round(entry * (1 + ip.targetPct / 100) * 1000) / 1000;
    }
    const stop = stopLoss;

    // Audit fix #9: reject outright when the stop isn't actually below entry for
    // a long (e.g. atr_5m anomalously 0/negative upstream) instead of flooring
    // the R:R denominator — Math.max(entry-stop, 0.0001) let a degenerate setup
    // (stop >= entry) produce a thousands-to-one R:R that trivially passed minRrRatio.
    if (stop >= entry) continue;

    // R:R gate — reject before sizing (always enforced; loosen ip.minRrRatio
    // itself for testing rather than bypassing this check entirely)
    const rrRatio = +((target - entry) / (entry - stop)).toFixed(1);
    if (rrRatio < ip.minRrRatio) continue;

    // Try quant engine sizing first (requires daily signals for this ticker)
    let qty = null;
    const dailySig = state.liveSignals && state.liveSignals[ticker];
    if (dailySig && typeof computeTradeParams === 'function') {
      try {
        const qt = computeTradeParams(
          ticker, dailySig,
          { allocatedCash: allocated, portfolioValue: 0,
            brokerage: (state.settings && state.settings.brokerage) || 10,
            rbaRate: state.rbaRate || 4.35 },
          { winProb: Math.min(0.85, d.score / 100 * 0.85),
            expectedTimeToTarget: 1,
            priceRange: [entry, +(entry * 1.002).toFixed(3)],
            target }
        );
        if (qt && qt.ok && qt.qty > 0) qty = qt.qty;
      } catch (_) {}
    }
    // Fallback: risk 2% of allocated capital divided by the per-share stop distance
    if (!qty) {
      const riskPerTrade = allocated * 0.02;
      const stopDist = entry - stop;
      qty = stopDist > 0 ? Math.max(1, Math.floor(riskPerTrade / stopDist)) : 1;
    }

    recs.push({
      id:            `IDT-${Date.now()}-${ticker}`,
      ticker,
      action:        'BUY',
      status:        'pending',
      date:          todayStr(),
      generatedAt:   nowSydney(),
      generatedAtMs: Date.now(),       // epoch ms for staleness detection
      priceRange:    [entry, +(entry * 1.002).toFixed(3)],
      target,
      stopLoss:      stop,
      rrRatio,
      confidence:    +(Math.min(0.85, d.score / 100 * 0.85)).toFixed(2),
      intradayScore: d.score,
      qty,
      vwap:          d.vwap,
      pctFromVwap:   d.pct_from_vwap,
      intradayRsi:   d.intraday_rsi,
      dayOpen:       d.day_open,
      dayHigh:       d.day_high,
      dayLow:        d.day_low,
      barsToday:     d.bars_today,
      signals,
      _isIntraday:   true,
      // Mirrors the swing-trade builder (_dtBuildRecs in day-trading-analysis.js,
      // `regime: regime || 'unknown'`) — without this, dtSaveSnapshot()'s
      // rec.regime fallback always misses and trade_snapshots.regime stays NULL
      // for every intraday trade.
      regime:        state.currentRegime?.regime || 'unknown',
    });
  }

  return recs;
}

// ── Main scan function (called from UI) ───────────────────────────────────────

async function runIntradayScan() {
  // Ensure state.intraday is initialised (guard for first load before config is written)
  if (!state.intraday) {
    state.intraday = {
      recommendations: [], openPositions: [], todayPnl: 0,
      lastScan: null, scanRunning: false, autoRefresh: false,
      allocatedCash: null, params: { ...INTRADAY_DEFAULTS },
    };
  }
  if (state.intraday.scanRunning) return;
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }

  const universeKey = (state.intraday.params && state.intraday.params.universeKey) || 'asx100';
  const universeMeta = (typeof ASX_UNIVERSE_META !== 'undefined' && ASX_UNIVERSE_META[universeKey])
    || { label: universeKey.toUpperCase() };

  state.intraday.scanRunning = true;
  renderPage();
  toast(`Scanning ${universeMeta.label} for intraday setups…`, 'info');

  // Strip .AX suffix — backend's asx() helper re-appends it
  const tickers = getUniverseTickers(universeKey).map(t => t.replace('.AX', ''));

  try {
    const r = await fetch(`${API}/api/intraday/scan`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        tickers,
        spi_chg: (state.macroData && typeof state.macroData.spi200_futures_chg === 'number')
          ? state.macroData.spi200_futures_chg : 0,
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    // Preserve already-executed recs so open positions remain visible;
    // replace only pending ones with fresh scan results.
    const newPending = _buildIntradayRecs(data);
    const prevExecuted = (state.intraday.recommendations || []).filter(r => r.status === 'executed');
    state.intraday.recommendations = [...prevExecuted, ...newPending];
    const passed = Object.values(data).filter(d => d.passes).length;
    state.intraday.lastScan = {
      date:        todayStr(),
      time:        nowSydney(),
      universeKey,
      universeLabel: universeMeta.label,
      total:       tickers.length,
      passed,
      count:       state.intraday.recommendations.length,
    };
    const count = state.intraday.recommendations.length;
    toast(
      `Intraday scan: ${count} setup${count !== 1 ? 's' : ''} found (${passed} passed filters)`,
      count > 0 ? 'success' : 'info'
    );
  } catch (e) {
    toast(`Intraday scan failed: ${e.message}`, 'error');
  } finally {
    state.intraday.scanRunning = false;
    renderPage();
  }
}
