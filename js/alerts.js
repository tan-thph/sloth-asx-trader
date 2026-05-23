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
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const opts = { body, tag, requireInteraction: false };
    if (iconUrl) opts.icon = iconUrl;
    const n = new Notification(title, opts);
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) {
    console.warn('[alerts] Notification failed:', e);
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

  openRecs.forEach(r => {
    const price = priceMap[r.ticker] ?? priceMap[r.ticker + '.AX'];
    if (price == null) return;

    if (r.stopLoss && price <= r.stopLoss) {
      fireAlert(
        `🛑 Stop hit: ${r.ticker}`,
        `Live price $${price.toFixed(2)} ≤ stop $${r.stopLoss.toFixed(2)}. Consider exiting.`,
        `sloth-stop-${r.ticker}`
      );
    } else if (r.target && price >= r.target) {
      fireAlert(
        `✅ Target hit: ${r.ticker}`,
        `Live price $${price.toFixed(2)} ≥ target $${r.target.toFixed(2)}. Consider taking profits.`,
        `sloth-target-${r.ticker}`
      );
    }
  });
}
