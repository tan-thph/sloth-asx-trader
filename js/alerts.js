// ============================================================
// alerts.js — Desktop Notification alerts for Sloth ASX Trader
//
// requestNotificationPermission() — call on first load
// fireAlert(title, body, tag)     — fires Notification if permitted
// alertScanComplete(results)      — fires when scan has score ≥ 75
// alertHighConviction(recs)       — fires when ensembleConfidence ≥ 0.80
// checkRecStopTargetAlerts()              — checks stop/target hits on live prices
// ============================================================

// Note: requestNotificationPermission() is defined in prices.js (already loaded).
// alerts.js extends the notification system with scan/conviction/stop-target alerts.

// ── Core fire function ────────────────────────────────────────────────────────

function fireAlert(title, body, tag = 'sloth-alert', iconUrl = null) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const opts = { body, tag, requireInteraction: false };
      if (iconUrl) opts.icon = iconUrl;
      const n = new Notification(title, opts);
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) {
      console.warn('[alerts] Notification failed:', e);
    }
  }
  // Mirror to Telegram if credentials are saved
  if (state.settings && state.settings.telegramEnabled) {
    fetch(`${API}/api/alerts/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `<b>${title}</b>\n${body}` }),
    }).catch(() => {});
  }
}

// ── Scan complete alert ───────────────────────────────────────────────────────
// Fires when a scan finishes and at least one ticker scored ≥ 75.

function alertScanComplete(results) {
  if (!results || !Array.isArray(results)) return;
  const hits = results.filter(r => (r.score ?? 0) >= 75);
  if (!hits.length) return;

  const topHit = hits.reduce((best, r) => (r.score > best.score ? r : best), hits[0]);
  const plural  = hits.length > 1 ? `and ${hits.length - 1} more` : '';
  fireAlert(
    `📈 Scanner: ${hits.length} high-score ticker${hits.length > 1 ? 's' : ''}`,
    `${topHit.ticker} scored ${topHit.score}/100${plural ? ' ' + plural : ''}. Click to review.`,
    'sloth-scan'
  );
}

// ── High-conviction rec alert ─────────────────────────────────────────────────
// Fires when validated recs contain ensembleConfidence ≥ 0.80.

function alertHighConviction(recs) {
  if (!recs || !Array.isArray(recs)) return;
  const highConv = recs.filter(r => (r.ensembleConfidence ?? r.confidence ?? 0) >= 0.80);
  if (!highConv.length) return;

  highConv.forEach(r => {
    const conf = ((r.ensembleConfidence ?? r.confidence) * 100).toFixed(0);
    fireAlert(
      `🎯 High-conviction: ${r.ticker} ${r.action}`,
      `Ensemble confidence ${conf}% · Price $${Array.isArray(r.priceRange) ? r.priceRange[0].toFixed(2) : '?'} → Target $${(r.target||0).toFixed(2)}`,
      `sloth-conv-${r.ticker}`
    );
  });
}

// ── Price alerts: stop / target hits on open AI recs ─────────────────────────
// Called after every live price refresh (prices.js → refreshPrices).
// Uses portfolio holding currentPrice as the live price source.

function checkRecStopTargetAlerts() {
  const recs = state.recHistory || [];

  // Build price map from portfolio holdings (updated by refreshPrices)
  const priceMap = {};
  for (const h of (state.portfolio || [])) {
    if (h.ticker && h.currentPrice) priceMap[h.ticker] = h.currentPrice;
  }

  // Find open executed recs that have a stop or target
  const openRecs = recs.filter(r => r.executed && (r.outcome === 'open' || !r.outcome));

  let anyFired = false;
  openRecs.forEach(r => {
    const price = priceMap[r.ticker] ?? priceMap[r.ticker + '.AX'];
    if (price == null) return;

    // Skip if we already alerted at this level — prevents firing on every refresh.
    // Re-arm only when price re-enters the safe band (>5% buffer past trigger).
    if (r.stopLoss && price <= r.stopLoss) {
      if (r._stopAlertedAt) return;
      fireAlert(
        `🛑 Stop hit: ${r.ticker}`,
        `Live price $${price.toFixed(2)} ≤ stop $${r.stopLoss.toFixed(2)}. Consider exiting.`,
        `sloth-stop-${r.ticker}`
      );
      r._stopAlertedAt = new Date().toISOString();
      anyFired = true;
    } else if (r.target && price >= r.target) {
      if (r._targetAlertedAt) return;
      fireAlert(
        `✅ Target hit: ${r.ticker}`,
        `Live price $${price.toFixed(2)} ≥ target $${r.target.toFixed(2)}. Consider taking profits.`,
        `sloth-target-${r.ticker}`
      );
      r._targetAlertedAt = new Date().toISOString();
      anyFired = true;
    } else {
      // Price retreated from trigger zone — re-arm so next breach alerts again.
      if (r._stopAlertedAt   && r.stopLoss && price > r.stopLoss * 1.02) r._stopAlertedAt   = null;
      if (r._targetAlertedAt && r.target   && price < r.target   * 0.98) r._targetAlertedAt = null;
    }
  });
  if (anyFired && typeof scheduleSave === 'function') scheduleSave();
}

// ── Stop-proximity pre-warning ────────────────────────────────────────────────
// Fires BEFORE a stop is breached — gives time to act.
// Threshold: state.settings.stopProximityPct (default 3 %, 0 = disabled).
// Direction-aware: BUY/TOP_UP stops are below price; SELL/TRIM stops above.
// One-shot per approach via r._proximityAlertedAt; re-arms after price retreats.

function checkStopProximityAlerts() {
  const pct = (state.settings && state.settings.stopProximityPct != null)
    ? Number(state.settings.stopProximityPct) : 3;
  if (!pct || pct <= 0) return;   // 0 = user disabled

  const priceMap = {};
  for (const h of (state.portfolio || [])) {
    if (h.ticker && h.currentPrice) priceMap[h.ticker] = h.currentPrice;
  }

  const openRecs = (state.recHistory || []).filter(r =>
    r.executed && r.stopLoss && (r.outcome === 'open' || !r.outcome)
  );

  let anyFired = false;
  openRecs.forEach(r => {
    const price = priceMap[r.ticker] ?? priceMap[r.ticker + '.AX'];
    if (price == null) return;
    if (r._stopAlertedAt) return;   // stop already breached — skip

    const isBuy = !r.action || r.action === 'BUY' || r.action === 'TOP_UP';
    let distPct;
    if (isBuy) {
      if (price <= r.stopLoss) return;   // already through stop — handled elsewhere
      distPct = (price - r.stopLoss) / price * 100;
    } else {
      // SELL/TRIM: stop is above current price; alert when price rises close to it
      if (price >= r.stopLoss) return;
      distPct = (r.stopLoss - price) / price * 100;
    }

    if (distPct <= pct) {
      if (r._proximityAlertedAt) return;  // already warned this approach
      const dir = isBuy ? '↓ approaching stop' : '↑ approaching stop';
      fireAlert(
        `⚠️ Stop proximity: ${r.ticker}`,
        `$${price.toFixed(2)} is ${distPct.toFixed(1)}% from stop $${r.stopLoss.toFixed(2)} — ${dir}. Consider action.`,
        `sloth-prox-${r.ticker}`
      );
      toast(`⚠️ ${r.ticker} ${distPct.toFixed(1)}% from stop`, 'warning');
      r._proximityAlertedAt = new Date().toISOString();
      anyFired = true;
    } else if (r._proximityAlertedAt && distPct > pct * 2) {
      // Price retreated well past threshold — re-arm for next approach
      r._proximityAlertedAt = null;
    }
  });
  if (anyFired && typeof scheduleSave === 'function') scheduleSave();
}

// ── Indicator alerts — RSI, Bollinger Bands, volume spike ─────────────────────
// Called after fetchSignals() so state.liveSignals is fresh.
// Alert types: 'rsi_below' | 'rsi_above' | 'bb_breakout' | 'bb_breakdown' | 'volume_spike'

function checkIndicatorAlerts() {
  if (!state.priceAlerts || !state.priceAlerts.length) return;
  if (!state.liveSignals || !Object.keys(state.liveSignals).length) return;

  const indicatorTypes = new Set(['rsi_below', 'rsi_above', 'bb_breakout', 'bb_breakdown', 'volume_spike']);
  let anyTriggered = false;

  for (const alert of state.priceAlerts) {
    if (!alert.active || alert.triggeredAt) continue;
    if (!indicatorTypes.has(alert.type)) continue;
    const sig = state.liveSignals[alert.ticker];
    if (!sig) continue;

    let fired = false;
    let msg = '';

    if (alert.type === 'rsi_below' && sig.rsi_14 != null && sig.rsi_14 <= alert.value) {
      fired = true;
      msg = `📉 ${alert.ticker} RSI ${sig.rsi_14.toFixed(0)} ≤ ${alert.value} (oversold)`;
    } else if (alert.type === 'rsi_above' && sig.rsi_14 != null && sig.rsi_14 >= alert.value) {
      fired = true;
      msg = `📈 ${alert.ticker} RSI ${sig.rsi_14.toFixed(0)} ≥ ${alert.value} (overbought)`;
    } else if (alert.type === 'bb_breakout' && sig.bb_upper != null && sig.current_price != null && sig.current_price >= sig.bb_upper) {
      fired = true;
      msg = `🔔 ${alert.ticker} broke above BB upper ($${fmt(sig.bb_upper)}) at $${fmt(sig.current_price)}`;
    } else if (alert.type === 'bb_breakdown' && sig.bb_lower != null && sig.current_price != null && sig.current_price <= sig.bb_lower) {
      fired = true;
      msg = `🔔 ${alert.ticker} broke below BB lower ($${fmt(sig.bb_lower)}) at $${fmt(sig.current_price)}`;
    } else if (alert.type === 'volume_spike' && sig.volume_avg_20 != null && sig.volume_today != null && sig.volume_today >= sig.volume_avg_20 * alert.value) {
      fired = true;
      const mult = (sig.volume_today / sig.volume_avg_20).toFixed(1);
      msg = `📊 ${alert.ticker} volume spike: ${mult}× avg (threshold: ${alert.value}×)`;
    }

    if (fired) {
      alert.triggeredAt = new Date().toISOString();
      alert.lastPrice   = sig.current_price;
      anyTriggered = true;
      toast(msg, 'warning');
      fireAlert('ASX Indicator Alert', msg, `sloth-ind-${alert.ticker}-${alert.type}`);
    }
  }
  if (anyTriggered && typeof scheduleSave === 'function') scheduleSave();
}

// ── Intraday 15:00 AEST hard time-stop ───────────────────────────────────────
// Called after every price refresh. Fires once per position at 15:00 AEST
// to remind the trader to close before end-of-session liquidity thins out.

const _intradayClosedAlertedAt = {};  // posId → ISO timestamp (session-scoped)

function checkIntradayCloseouts() {
  if (!state.intraday || !(state.intraday.openPositions || []).length) return;

  // Determine current AEST time in minutes since midnight (UTC+10 approx)
  const now  = new Date();
  const aest = new Date(now.getTime() + 10 * 3_600_000);
  const hhmm = aest.getUTCHours() * 60 + aest.getUTCMinutes();
  if (hhmm < 900) return;   // before 15:00 AEST — nothing to do yet

  for (const pos of state.intraday.openPositions) {
    if (_intradayClosedAlertedAt[pos.id]) continue;   // already alerted this position
    _intradayClosedAlertedAt[pos.id] = new Date().toISOString();
    fireAlert(
      `⏰ Intraday time-stop: ${pos.ticker}`,
      `15:00 AEST reached — close your intraday position before market gets illiquid. ` +
      `${pos.qty} shares @ entry $${pos.entryPrice.toFixed(3)}.`,
      `sloth-intraday-close-${pos.id}`
    );
    toast(`⏰ ${pos.ticker} intraday position must be closed now (15:00 AEST)`, 'warning');
  }
}
