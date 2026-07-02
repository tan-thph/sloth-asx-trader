// ── CRITICAL PRICE-DECLINE ALERT ENGINE ──────────────────────────────────────
// Thresholds:
//   1. Single-day decline ≥15% (flash crash / trading halt risk)
//   2. Consecutive 3-day decline where each day closed lower AND cumulative drop ≥10%
// Data source: chart_data from liveSignals (close prices, last 90 days from backend)
// Called: after each signal refresh; result stored in state.criticalAlerts

function computeCriticalAlerts() {
  const newAlerts = {};
  const signals = state.liveSignals || {};
  const now = Date.now();

  for (const [ticker, s] of Object.entries(signals)) {
    if (s.error || !s.chart_data || s.chart_data.length < 2) continue;
    // Only alert for current portfolio holdings (not watchlist)
    const holding = getPortfolioHolding(ticker);
    if (!holding || holding.shares < _SHARE_EPSILON) continue;

    const closes = s.chart_data.map(d => d.close).filter(v => v > 0);
    if (closes.length < 2) continue;

    // ── Test 1: Single-day decline ≥15% ───────────────────────────────────────
    const prev = closes[closes.length - 2];
    const curr = closes[closes.length - 1];
    const dayPct = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
    if (dayPct <= -15) {
      newAlerts[ticker] = {
        type: 'single_day',
        pct: dayPct,
        days: 1,
        fromPrice: prev,
        toPrice: curr,
        triggeredAt: newAlerts[ticker]?.triggeredAt || now,
        severity: 'critical',
      };
      continue; // single-day is highest severity; no need to check 3-day
    }

    // ── Test 2: 3 consecutive down days with cumulative decline ≥10% ──────────
    if (closes.length >= 4) {
      const d1 = closes[closes.length - 4]; // open of window
      const d2 = closes[closes.length - 3];
      const d3 = closes[closes.length - 2];
      const d4 = closes[closes.length - 1]; // latest close
      const allDown = d2 < d1 && d3 < d2 && d4 < d3;
      const cumulPct = d1 > 0 ? ((d4 - d1) / d1) * 100 : 0;
      if (allDown && cumulPct <= -10) {
        newAlerts[ticker] = {
          type: 'consecutive',
          pct: cumulPct,
          days: 3,
          fromPrice: d1,
          toPrice: d4,
          triggeredAt: newAlerts[ticker]?.triggeredAt || now,
          severity: cumulPct <= -10 ? 'critical' : 'warning',
        };
      }
    }
  }

  // Merge: preserve triggeredAt for alerts that are continuing
  const merged = {};
  for (const [t, alert] of Object.entries(newAlerts)) {
    const prev = state.criticalAlerts?.[t];
    merged[t] = {
      ...alert,
      triggeredAt: prev?.triggeredAt || alert.triggeredAt,
      // Don't re-dismiss if the alert worsened
      dismissed: prev?.dismissed && prev.pct >= alert.pct,
    };
  }
  state.criticalAlerts = merged;
  return merged;
}

function dismissCriticalAlert(ticker) {
  if (state.criticalAlerts[ticker]) {
    state.criticalAlerts[ticker].dismissed = true;
  }
  if (!state.dismissedAlerts) state.dismissedAlerts = {};
  state.dismissedAlerts[ticker] = Date.now();
  scheduleSave();
  // Re-render whatever page is visible to remove the banner
  renderPage();
}

function renderCriticalAlertBanners() {
  // ── Critical price-decline alerts (auto-detected) ──────────────────────────
  const alerts = state.criticalAlerts || {};
  const active = Object.entries(alerts).filter(([,a]) => !a.dismissed);
  const declineBanners = active.map(([ticker, a]) => {
    const isSingleDay = a.type === 'single_day';
    const pctStr = a.pct.toFixed(1);
    const title = isSingleDay
      ? `⚡ ${ticker}: Flash crash — ${pctStr}% in one session`
      : `⚠ ${ticker}: Down ${pctStr}% over 3 consecutive days`;
    const desc = isSingleDay
      ? `${ticker} dropped ${Math.abs(pctStr)}% in a single session (from $${fmt(a.fromPrice)} → $${fmt(a.toPrice)}). This meets the flash-crash threshold. Consider selling to protect capital.`
      : `${ticker} has closed lower for 3 consecutive days, falling ${Math.abs(pctStr)}% cumulatively (from $${fmt(a.fromPrice)} → $${fmt(a.toPrice)}). Momentum is firmly negative.`;
    const holding = getPortfolioHolding(ticker);
    const posValue = holding ? fmt(holding.shares * holding.currentPrice) : '—';
    const unrealPnl = holding ? holding.gain : null;
    return `
    <div class="critical-alert-banner">
      <div class="alert-icon">${isSingleDay ? '⚡' : '📉'}</div>
      <div class="alert-body">
        <div class="alert-title">${title}</div>
        <div class="alert-desc">${desc}</div>
        <div class="alert-desc" style="margin-top:4px">
          Position value: <strong>$${posValue}</strong>
          ${unrealPnl != null ? ` · Unrealised P&L: <strong class="${unrealPnl >= 0 ? 'text-success' : 'text-danger'}">${unrealPnl >= 0 ? '+' : ''}$${fmt(Math.abs(unrealPnl))}</strong>` : ''}
          · ${isSingleDay ? '1-day' : '3-day'} decline: <strong style="color:#ef4444">${pctStr}%</strong>
        </div>
        <div class="alert-actions">
          <button class="btn btn-sm btn-danger" onclick="quickSellFromAlert('${ticker}')">🚨 Sell ${ticker} Now</button>
          <button class="btn btn-sm" onclick="showPage('signals');setTimeout(()=>expandSignal('${ticker}'),300)">View Signals</button>
          <button class="btn btn-sm" onclick="dismissCriticalAlert('${ticker}')" style="opacity:0.7">Dismiss</button>
        </div>
      </div>
    </div>`;
  });

  // ── User-defined price alerts (triggered) ──────────────────────────────────
  const triggeredAlerts = (state.priceAlerts || []).filter(a => a.triggeredAt && a.active);
  const alertBanners = triggeredAlerts.map(a => {
    const typeLabel = a.type === 'above' ? `↑ rose above $${fmt(a.value)}` : a.type === 'below' ? `↓ fell below $${fmt(a.value)}` : `↓ dropped ${a.value}% from $${fmt(a.referencePrice)}`;
    return `
    <div class="critical-alert-banner" style="border-left-color:#f59e0b;background:linear-gradient(135deg,#fef3c7 0%,#fffbeb 100%)">
      <div class="alert-icon">🔔</div>
      <div class="alert-body">
        <div class="alert-title" style="color:#92400e">Price Alert: ${a.ticker} ${typeLabel}</div>
        <div class="alert-desc">Triggered at $${a.lastPrice != null ? fmt(a.lastPrice) : '—'} · Set on ${a.createdAt ? a.createdAt.slice(0,10) : '—'}</div>
        <div class="alert-actions">
          <button class="btn btn-sm" onclick="showPage('portfolio')">Manage Alerts</button>
          <button class="btn btn-sm" onclick="rearmPriceAlert('${a.id}')">↺ Re-arm</button>
          <button class="btn btn-sm btn-danger" onclick="deletePriceAlert('${a.id}')" style="opacity:0.8">Dismiss</button>
        </div>
      </div>
    </div>`;
  });

  return [...declineBanners, ...alertBanners].join('');
}

function quickSellFromAlert(ticker) {
  // Navigate to pending recs filtered to this ticker, or open journal
  const holding = getPortfolioHolding(ticker);
  if (!holding) { toast(`No holding found for ${ticker}`, 'error'); return; }
  const confirmed = confirm(
    `🚨 CRITICAL SELL — ${ticker}\n\n` +
    `You hold ${holding.shares} shares @ avg $${fmt(holding.avgPrice)}.\n` +
    `Current price: $${fmt(holding.currentPrice)}\n` +
    `Estimated proceeds: $${fmt(holding.shares * holding.currentPrice)}\n\n` +
    `This will open the Trade Journal to log a manual SELL. Continue?`
  );
  if (!confirmed) return;
  showPage('journal');
  // Pre-fill the new trade form after the page renders
  setTimeout(() => {
    const dateEl = document.getElementById('tj-date');
    const tickerEl = document.getElementById('tj-ticker');
    const actionEl = document.getElementById('tj-action');
    const qtyEl = document.getElementById('tj-qty');
    const priceEl = document.getElementById('tj-price');
    if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
    if (tickerEl) tickerEl.value = ticker;
    if (actionEl) actionEl.value = 'SELL';
    if (qtyEl) qtyEl.value = holding.shares;
    if (priceEl) priceEl.value = holding.currentPrice.toFixed(3);
    toast(`Pre-filled SELL for ${ticker} — review and confirm in journal`, 'error');
  }, 350);
}

// ── PARCEL HELPERS ──────────────────────────────────────────
function nextParcelId() {
  // Derive from max existing id every time to survive page reloads safely
  const max = state.cgtParcels.reduce((m,p) => Math.max(m, p.id || 0), 0);
  return max + 1;
}

function _nextDisposalBaseId() {
  // Returns the next stable id for a batch of disposals.
  // Use _nextDisposalBaseId() + i for the i-th disposal in a batch.
  const max = (state.cgtDisposals || []).reduce((m,d) => Math.max(m, d.id || 0), 0);
  return max + 1;
}

function nextJournalId() {
  // Monotonic, delete-safe journal row id — max existing id + 1.
  // Replaces the old `state.tradeJournal.length + 1` pattern which collides
  // after any row deletion (length shrinks, next insert reuses an existing id).
  const max = (state.tradeJournal || []).reduce((m, j) => Math.max(m, j.id || 0), 0);
  return max + 1;
}

function addParcel(ticker, date, qty, costPerShare, fees, sector, account, mode) {
  state.cgtParcels.push({
    id: nextParcelId(),
    ticker: ticker.toUpperCase(),
    date,
    qty,
    remainingQty: qty,
    costPerShare,
    fees,          // buy brokerage for this lot
    sector: sector || 'Other',
    account: account || 'personal',   // track which account owns this parcel
    // Paper/real firewall (gotcha #88): a parcel is REAL only when mode==='real'.
    // Missing/undefined ⇒ paper, per the isRealTrade() invariant. Paper parcels
    // are excluded from CGT/EOFY and never matched by a real sell (and vice versa).
    mode: mode || 'paper',
  });
}

// Returns parcels for a ticker ordered by the chosen CGT method.
// account (optional): when provided, restricts to parcels from that account only.
// mode (optional): when provided ('real'|'paper'), restricts to parcels of that
//   trade mode (missing parcel.mode ⇒ 'paper', per gotcha #88). A real sell must
//   pass mode='real' so it never consumes paper parcels, and vice versa.
// Parcels created before this fix have no account field and default to 'personal'.
function getParcelsForTicker(ticker, method, account, mode) {
  const open = state.cgtParcels.filter(p => {
    if (p.ticker !== ticker.toUpperCase() || p.remainingQty <= 0) return false;
    if (account && (p.account || 'personal') !== account) return false;
    if (mode && (p.mode || 'paper') !== mode) return false;
    return true;
  });
  method = method || state.cgtMethod || 'fifo';
  if (method === 'fifo')     return open.sort((a,b) => parseDate(a.date) - parseDate(b.date));
  if (method === 'lifo')     return open.sort((a,b) => parseDate(b.date) - parseDate(a.date));
  if (method === 'minimise') return open.sort((a,b) => {
    // Minimise CGT: prefer discount-eligible (>12mo) lots first; within same group, sell highest-cost first
    const today = todayStr();
    const aDisc = daysBetween(a.date, today) > 365;
    const bDisc = daysBetween(b.date, today) > 365;
    if (aDisc !== bDisc) return aDisc ? -1 : 1;      // discount-eligible first
    return b.costPerShare - a.costPerShare;            // highest cost first (lowest taxable gain)
  });
  if (method === 'maximise') return open.sort((a,b) => b.costPerShare - a.costPerShare); // highest cost first = maximise realised loss (tax-loss harvesting)
  return open.sort((a,b) => parseDate(a.date) - parseDate(b.date));
}

// Splits one OPEN parcel into two sibling parcels with arbitrary qtys, so each
// can be tracked/sold/account-reassigned independently. Rejects partially-sold
// parcels (remainingQty < qty) — representing the leftover as a fresh "split"
// lot would misrepresent shares that were actually already disposed of.
//
// Critical invariant: if this parcel is already linked to an open Intraday
// position or executed Swing rec (parcelId match), that position/rec is split
// proportionally too — see _splitLinkedPosition() below. Without this, the
// new sibling parcel has no position of its own, so a later setParcelAccount()
// move of just the sibling can't correctly attribute "this much of the
// position" to "this lot" — it either drags the WHOLE original position along
// or (worse) silently orphans it. This was a real bug: splitting a ticker that
// already had a trading-account day-trade position, then moving the split-off
// lot to another account, removed the entire original position instead of
// leaving the un-moved portion intact.
function splitParcel(parcelId, splitQty) {
  const p = state.cgtParcels.find(x => x.id === parcelId);
  if (!p) return false;
  if (p.remainingQty < p.qty) return false;       // partially sold — not splittable
  splitQty = Number(splitQty);
  if (!(splitQty > 0) || splitQty >= p.qty) return false;  // must leave both sides > 0
  const fracFees = (p.fees || 0) * (splitQty / p.qty);
  p.qty -= splitQty;
  p.remainingQty -= splitQty;
  p.fees = (p.fees || 0) - fracFees;
  // Inherit the parent's mode (gotcha #88) — splitting a LIVE parcel must never
  // produce a PAPER sibling (that would silently reclassify real shares out of
  // the tax records; missing mode would default to 'paper' in addParcel).
  addParcel(p.ticker, p.date, splitQty, p.costPerShare, fracFees, p.sector, p.account, p.mode || 'paper');
  const newParcel = state.cgtParcels[state.cgtParcels.length - 1];
  _splitLinkedPosition(p, newParcel, splitQty);
  _splitParcelJournalRow(p, newParcel, fracFees);
  scheduleSave();
  return true;
}

// Keeps the journal in 1:1 sync with parcels at split time. The PARENT
// parcel keeps its number but is now a smaller, divided lot — its existing
// journal row (if any) flips from 'BUY' to 'RECLASSIFY' immediately (not
// deferred to a later account change) and its qty is updated to the new
// reduced remainingQty. A brand-new 'BUY' row is created for the new parcel
// (same original purchase date/account/cost basis — this isn't a new
// transaction, just a new lot identity), so it has a row of its own that
// setParcelAccount() can update in place later.
//
// The new row INHERITS the parent row's provenance/technical data verbatim
// (recId, recExecuted, entrySignals, thesis, regime) rather than leaving them
// null. Without this, journal.js's _journalProvenanceBadge() and the detail
// drawer's `source` label both key off `recId` being non-null — a null recId
// reads as "✋ Manual"/"Manual entry" even though the split-off lot is really
// the SAME underlying trade, just divided. Multiple journal rows sharing one
// recId is already an established pattern (gotcha #66 — a SELL spanning
// several parcels produces one row per parcel, all sharing the SELL's recId),
// so this isn't a new kind of link, just applying it to splits too.
function _splitParcelJournalRow(parentParcel, newParcel, newParcelFees) {
  if (!state.tradeJournal) state.tradeJournal = [];
  const parentRow = _findParcelJournalRow(parentParcel.id);
  if (parentRow) {
    parentRow.action = 'RECLASSIFY';
    parentRow.qty = parentParcel.remainingQty;
  }
  state.tradeJournal.unshift({
    id: nextJournalId(), date: newParcel.date || todayStr(), timestamp: nowSydney(),
    ticker: newParcel.ticker, action: 'BUY',
    qty: newParcel.remainingQty, entryPrice: newParcel.costPerShare,
    exitPrice: null, fees: newParcelFees || 0, pnl: null, status: 'open',
    sector: newParcel.sector, account: newParcel.account,
    mode: newParcel.mode || 'paper',   // inherit parent's mode (gotcha #88)
    parcel: `P#${newParcel.id}`, parcelId: newParcel.id,
    recId: parentRow?.recId ?? null, recExecuted: parentRow?.recExecuted ?? false,
    entrySignals: parentRow?.entrySignals ?? null,
    thesis: parentRow?.thesis ?? null,
    regime: (parentRow && parentRow.regime) || (state.currentRegime && state.currentRegime.regime) || null,
    notes: `Split from P#${parentParcel.id}`,
  });
}

// Proportionally splits whichever open Intraday position or executed Swing
// rec is linked to the PARENT parcel (by parcelId) — see splitParcel() above.
// No-ops silently when there's no linked position (the common case: most
// parcels were never day-traded). Position qty is assumed to always equal its
// parcel's remainingQty 1:1 (true for every creation path in this codebase —
// there is no partial-close mechanism for either Intraday or Swing positions
// today), so the same splitQty applies to both without re-deriving a ratio.
function _splitLinkedPosition(parentParcel, newParcel, splitQty) {
  if (state.intraday && Array.isArray(state.intraday.openPositions)) {
    const pos = state.intraday.openPositions.find(x => x.parcelId === parentParcel.id);
    if (pos) {
      pos.qty -= splitQty;
      state.intraday.openPositions.push({
        ...pos, id: `${pos.id}-split-${newParcel.id}`, parcelId: newParcel.id,
        qty: splitQty, _journalId: null,
      });
    }
  }
  if (state.dayTrading && Array.isArray(state.dayTrading.recommendations)) {
    const rec = state.dayTrading.recommendations.find(r => r.status === 'executed' && r.parcelId === parentParcel.id);
    if (rec) {
      rec.qty -= splitQty;
      if (rec._execQty != null) rec._execQty -= splitQty;
      state.dayTrading.recommendations.push({
        ...rec, id: `${rec.id}-split-${newParcel.id}`, parcelId: newParcel.id,
        qty: splitQty, _execQty: splitQty, _snapshotId: null,
      });
    }
  }
}

// Rebuilds the single state.portfolio row for (ticker, account) from the sum
// of that account's currently-open parcels — qty = sum(remainingQty), avgPrice
// = parcel-weighted average cost. Removes the row entirely when no open
// parcels remain (epsilon-safe, mirrors applySellToPortfolio's _SHARE_EPSILON
// cleanup). Called after any parcel mutation that can change a (ticker,
// account) holding's true qty/cost — currently just setParcelAccount, since
// splitParcel/addParcel/applyBuyToPortfolio keep totals unchanged or already
// maintain state.portfolio directly.
function _recomputeHoldingFromParcels(ticker, account) {
  const symbol = ticker.toUpperCase();
  const acct = account || 'personal';
  // Paper/real firewall (gotcha #88): rebuild ONE row per mode, never a blended
  // real+paper row. A mode-blind recompute here used to merge paper parcels into
  // the real holding's qty/avgPrice whenever a ticker was held in both modes.
  for (const md of ['real', 'paper']) {
    const openParcels = state.cgtParcels.filter(p =>
      p.ticker === symbol && (p.account || 'personal') === acct &&
      (p.mode || 'paper') === md && p.remainingQty > 0
    );
    const existingIdx = state.portfolio.findIndex(h =>
      h.ticker === symbol && (h.account || 'personal') === acct && (h.mode || 'paper') === md);
    const totalQty = openParcels.reduce((s, p) => s + p.remainingQty, 0);
    if (Math.abs(totalQty) < _SHARE_EPSILON) {
      if (existingIdx !== -1) state.portfolio.splice(existingIdx, 1);
      continue;
    }
    const avgPrice = openParcels.reduce((s, p) => s + p.remainingQty * p.costPerShare, 0) / totalQty;
    if (existingIdx !== -1) {
      const existing = state.portfolio[existingIdx];
      existing.shares = totalQty;
      existing.avgPrice = avgPrice;
      if (!existing.currentPrice) existing.currentPrice = avgPrice;
    } else {
      state.portfolio.push({
        ticker: symbol, shares: totalQty, avgPrice, currentPrice: avgPrice,
        sector: openParcels[0].sector || 'Other', account: acct, mode: md,
      });
    }
  }
}

// Removes the Intraday open position tied to this parcel (matched by
// parcelId; falls back to a ticker-only match for legacy positions created
// before parcelId was tracked on every position — see day-trading.js).
// Returns true iff a position was actually found+removed — setParcelAccount()
// uses this to remember which system (Intraday vs Swing) this lot belongs to,
// so re-entering 'trading' later reopens the SAME system instead of guessing.
function _removeIntradayPositionForParcel(parcel) {
  if (!state.intraday || !Array.isArray(state.intraday.openPositions)) return false;
  const byId = state.intraday.openPositions.findIndex(pos => pos.parcelId === parcel.id);
  if (byId !== -1) { state.intraday.openPositions.splice(byId, 1); return true; }
  const byTicker = state.intraday.openPositions.findIndex(pos => pos.ticker === parcel.ticker && pos.parcelId == null);
  if (byTicker !== -1) { state.intraday.openPositions.splice(byTicker, 1); return true; }
  return false;
}

// Finds the ONE Trade Journal row that represents a given parcel, matched by
// `parcelId` — every parcel should have exactly one journal row (its original
// BUY, or a BUY row created for it by splitParcel()). Used by both
// splitParcel() and setParcelAccount() so account changes UPDATE that row in
// place instead of inserting a new one each time (the old `logParcelReclassification`
// design did exactly that and was reverted — every click created a fresh
// permanent row, cluttering the journal with what was really just one lot's
// current state). Returns undefined if no row exists yet (legacy parcels
// predating parcelId tracking) — callers fall back to creating one.
//
// MUST exclude SELL/TRIM disposal-slice rows — buildDisposalJournalEntries()
// also stamps `parcelId: d.parcelId` on every disposal row it creates for a
// partially-trimmed parcel (gotcha #66), and those rows are unshift()ed (so
// a disposal created AFTER the original BUY ends up EARLIER in the array).
// An unfiltered .find() would return the disposal row instead of the open
// lot's own row once a parcel has been partially sold — corrupting a closed,
// already-realised SELL record's account/action instead of the still-open
// lot's. Mirrors the action filter buildDisposalJournalEntries() already
// uses for its own internal `buyRow` lookup.
function _findParcelJournalRow(parcelId) {
  return (state.tradeJournal || []).find(j =>
    j.parcelId === parcelId && (j.action === 'BUY' || j.action === 'TOP_UP' || j.action === 'RECLASSIFY')
  );
}

// Updates parcel's journal row in place for an account move: sets `account`
// and flips `action` to 'RECLASSIFY' (sticky — once a parcel has ever been
// reclassified, its row stays labelled RECLASSIFY, since it no longer
// represents a single clean "bought and held" transaction). No new row is
// ever created here for a parcel that already has one — only the very first
// time a legacy parcel (with no existing row) is reclassified does this fall
// back to creating one.
function _syncParcelJournalRow(parcel, newAccount) {
  if (!state.tradeJournal) state.tradeJournal = [];
  const row = _findParcelJournalRow(parcel.id);
  if (row) {
    row.account = newAccount;
    row.action = 'RECLASSIFY';
    return;
  }
  state.tradeJournal.unshift({
    id: nextJournalId(), date: parcel.date || todayStr(), timestamp: nowSydney(),
    ticker: parcel.ticker, action: 'RECLASSIFY',
    qty: parcel.remainingQty, entryPrice: parcel.costPerShare,
    exitPrice: null, fees: parcel.fees || 0, pnl: null, status: 'open',
    sector: parcel.sector, account: newAccount,
    parcel: `P#${parcel.id}`, parcelId: parcel.id,
    recId: null, recExecuted: false,
    regime: (state.currentRegime && state.currentRegime.regime) || null,
    notes: `Reclassified to ${newAccount}`,
  });
}

// Reassigns ONE parcel (lot) to a different account — the per-lot equivalent
// of the old whole-holding _cycleHoldingAccount. Recomputes both the source
// and destination (ticker, account) portfolio rows from parcels (rather than
// patching shares/avgPrice by hand) so repeated partial moves never drift.
//
// Journal: updates the parcel's EXISTING journal row in place (account +
// action:'RECLASSIFY') via _syncParcelJournalRow() — never inserts a new row
// per move. (Hotfix: the original design inserted a fresh 'RECLASSIFY' row
// on every single account change, so toggling a lot back and forth created a
// permanent row per click — exactly the clutter being fixed here.)
//
// Also syncs Intraday AND Swing day-trading — but a lot belongs to AT MOST
// ONE of the two systems, never both, so this must never blindly fire both.
// (Hotfix: an earlier version called BOTH _open*PositionFromParcel functions
// whenever a lot entered 'trading', creating a phantom Swing "Active Setup"
// for tickers that were only ever Intraday trades — confirmed live with
// ticker NXL, which picked up a ghost Swing rec purely from being reclassified
// into 'trading', despite never having been swing-traded.) The fix: on the way
// OUT of 'trading', whichever remove function actually finds+removes
// something is remembered on the parcel itself (`p._dtLastSystem`), since
// removal already tells us unambiguously which system this lot was in. On
// the way back IN, only that one system is reopened — defaulting to
// 'intraday' for a lot with no recorded system (a brand-new entry into
// 'trading', or a legacy parcel from before this field existed), matching the
// original feature request (which was Intraday-specific).
function setParcelAccount(parcelId, newAccount) {
  const p = state.cgtParcels.find(x => x.id === parcelId);
  if (!p) return false;
  const oldAccount = p.account || 'personal';
  if (oldAccount === newAccount) return false;
  p.account = newAccount;

  _recomputeHoldingFromParcels(p.ticker, oldAccount);
  _recomputeHoldingFromParcels(p.ticker, newAccount);

  if (oldAccount === 'trading' && newAccount !== 'trading') {
    const wasIntraday = _removeIntradayPositionForParcel(p);
    const wasSwing = (typeof _removeSwingPositionForParcel === 'function') && _removeSwingPositionForParcel(p);
    if (wasIntraday) p._dtLastSystem = 'intraday';
    else if (wasSwing) p._dtLastSystem = 'swing';
  } else if (oldAccount !== 'trading' && newAccount === 'trading') {
    if ((p._dtLastSystem || 'intraday') === 'swing') {
      if (typeof _openSwingPositionFromParcel === 'function') {
        _openSwingPositionFromParcel(p);      // async — saves/renders itself on completion
      }
    } else if (typeof _openIntradayPositionFromParcel === 'function') {
      _openIntradayPositionFromParcel(p);     // async — saves/renders itself on completion
    }
  }

  _syncParcelJournalRow(p, newAccount);

  scheduleSave();
  renderPage();
  return true;
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  // Handle DD-MM-YYYY format
  if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) {
    const [day, month, year] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  // Fallback to other formats
  return new Date(dateStr);
}

function daysBetween(dateStr1, dateStr2) {
  const date1 = parseDate(dateStr1);
  const date2 = parseDate(dateStr2);
  return Math.floor((date2 - date1) / 86400000);
}

// Match qty against parcels (FIFO/LIFO/etc), record disposals, return {disposals, totalCostBase, totalGrossGain}
// account (optional): when provided, only consumes parcels from that account —
// prevents a trading-account sell from consuming personal-account parcels.
function matchSaleAgainstParcels(ticker, saleQty, salePrice, saleDate, saleFees, method, account, mode) {
  // Fix #31: guard against saleQty=0 which would produce feePerShare=Infinity and corrupt
  // all downstream CGT disposal records (grossGain/netGain become Infinity or NaN).
  // Fix #31: guard against saleQty=0 — "Invalid sale qty" returns [] (not an error object)
  // so both callers can safely spread/iterate the result. Returns empty array on invalid qty.
  if (!saleQty || saleQty <= 0) {
    return [];
  }
  const parcels = getParcelsForTicker(ticker, method, account, mode);
  let remaining = saleQty;
  const disposals = [];
  // Split fees proportionally across parcels by qty
  const feePerShare = saleFees / saleQty;

  // Compute stable id base BEFORE the loop so ids don't shift if an earlier
  // disposal in this batch is counted by a re-entrant call (not expected, but safe).
  const _disposalIdBase = _nextDisposalBaseId();

  for (const parcel of parcels) {
    if (remaining <= 0) break;
    const matched = Math.min(parcel.remainingQty, remaining);
    const held = daysBetween(parcel.date, saleDate);
    const eligible50 = held > 365; // ATO: held MORE than 12mo (acquisition day excluded, disposal day included)
    const proceeds = matched * salePrice;
    const costBase = matched * parcel.costPerShare + (parcel.fees * matched / parcel.qty); // pro-rata buy fee
    const allocatedSaleFee = feePerShare * matched;
    const grossGain = proceeds - costBase - allocatedSaleFee;
    const discount = eligible50 && grossGain > 0 ? grossGain * 0.5 : 0;
    const netGain = grossGain - discount;

    disposals.push({
      id: _disposalIdBase + disposals.length, // stable id — survives out-of-order deletes (R2-4)
      saleDate,
      ticker: ticker.toUpperCase(),
      salePrice,
      saleQty: matched,
      parcelId: parcel.id,
      parcelDate: parcel.date,
      parcelCostPerShare: parcel.costPerShare,
      heldDays: held,
      eligible50,
      proceeds,
      costBase,
      saleFee: allocatedSaleFee,
      grossGain,
      discount,
      netGain,
      // Paper/real firewall (gotcha #88): a disposal inherits the parcel's mode.
      // CGT/EOFY exports are real-only — a paper disposal must never surface there.
      mode: (parcel.mode || 'paper'),
    });

    parcel.remainingQty -= matched;
    remaining -= matched;
  }

  // If no parcels exist (e.g. pre-app position) fall back to avgPrice.
  // Scoped by `account` — unscoped, this could silently borrow a DIFFERENT
  // account's avgPrice as the cost basis when the same ticker is held in
  // more than one account, producing a wrong grossGain/netGain.
  if (remaining > 0) {
    const holding = getPortfolioHolding(ticker, account, mode);
    const costPerShare = holding ? holding.avgPrice : salePrice;
    const proceeds = remaining * salePrice;
    const costBase = remaining * costPerShare;
    const grossGain = proceeds - costBase - (feePerShare * remaining);
    disposals.push({
      saleDate,
      ticker: ticker.toUpperCase(),
      salePrice,
      saleQty: remaining,
      parcelId: null,
      parcelDate: null,
      parcelCostPerShare: costPerShare,
      heldDays: null,
      eligible50: false,
      proceeds,
      costBase,
      saleFee: feePerShare * remaining,
      grossGain,
      discount: 0,
      netGain: grossGain,
      note: 'No parcel — used avg cost basis',
      mode: mode || 'paper',
    });
  }

  return disposals;
}

// account param (optional) — 'personal'|'super'|'trading'. Defaults to 'personal'.
// mode param (optional) — 'real'|'paper' (gotcha #88). Defaults to 'paper' so a
//   mode-less call can never fabricate a real holding. A real buy and a paper buy
//   of the same ticker+account produce SEPARATE holding rows (keyed by mode), so
//   simulated positions never merge into the real book.
// All callers that don't pass account/mode continue to work unchanged.
function applyBuyToPortfolio(ticker, qty, price, date, fees, sector, account, mode) {
  const symbol = ticker.toUpperCase();
  const acct   = account || 'personal';
  const md     = mode || 'paper';
  // Find an existing holding for this ticker in the same account AND mode only
  const existing = state.portfolio.find(h =>
    h.ticker === symbol && (h.account || 'personal') === acct && (h.mode || 'paper') === md);
  if(existing) {
    const totalCostVal = existing.shares * existing.avgPrice + qty * price;
    existing.shares += qty;
    existing.avgPrice = totalCostVal / existing.shares;
    if(!existing.currentPrice) existing.currentPrice = price;
  } else {
    state.portfolio.push({
      ticker: symbol, shares: qty, avgPrice: price, currentPrice: price,
      sector: sector || 'Other', account: acct, mode: md,
    });
  }
  // Always record a parcel — store the account+mode so lots/CGT can separate them
  addParcel(symbol, date || todayStr(), qty, price, fees || 0, sector, acct, md);
}

// Audit fix #11: epsilon for share-count zero checks. Exact `<= 0` comparisons
// risk a phantom near-zero holding surviving after many partial fills due to
// floating-point drift (e.g. 0.00000000000003 left over instead of exactly 0).
// DRP/split adjustment already round to 4dp; this extends that convention to
// the sell path and applies a symmetric epsilon to read-side filters too.
const _SHARE_EPSILON = 1e-6;

// account param (optional) — must match the account used at BUY time.
// mode param (optional) — 'real'|'paper' (gotcha #88). Must match the mode used at
//   BUY time: a paper sell only consumes paper parcels/holdings and credits
//   state.paperCash; a real sell consumes real parcels and credits state.cash.
function applySellToPortfolio(ticker, qty, sellPrice, fees, date, method, account, mode) {
  const symbol = ticker.toUpperCase();
  const acct   = account || 'personal';
  const md     = mode || 'paper';
  const holding = state.portfolio.find(h =>
    h.ticker === symbol && (h.account || 'personal') === acct && (h.mode || 'paper') === md);
  if(!holding || holding.shares < qty) return { ok: false, disposals: [] };
  holding.currentPrice = sellPrice;
  holding.shares = Math.round((holding.shares - qty) * 10000) / 10000;
  if(Math.abs(holding.shares) < _SHARE_EPSILON) {
    // Remove only the matching account+mode holding, not all holdings for this ticker
    state.portfolio = state.portfolio.filter(
      h => !(h.ticker === symbol && (h.account || 'personal') === acct && (h.mode || 'paper') === md)
    );
  }
  // Paper sells credit the simulated pool, not real cash (gotcha #88).
  adjustCashForMode(qty * sellPrice - Number(fees || 0), md);

  // Match against parcels and record disposals — scoped to this account+mode so a
  // trading-account sell never consumes personal-account parcels, and a paper sell
  // never consumes real parcels (and vice versa).
  const disposals = matchSaleAgainstParcels(symbol, qty, sellPrice, date || todayStr(), fees || 0, method, acct, md);
  state.cgtDisposals.push(...disposals);
  return { ok: true, disposals };
}

function computeSellPnl(costBasis, sellPrice, qty, fees = 0) {
  return (sellPrice - costBasis) * qty - Number(fees || 0);
}

// Compute total pnl from disposals for a sell trade
function disposalsToPnl(disposals) {
  return disposals.reduce((s,d) => s + d.grossGain, 0);
}

// Splits a multi-parcel SELL/TRIM disposal into one Trade Journal row per
// parcel slice consumed (the `disposals` array from matchSaleAgainstParcels/
// applySellToPortfolio already has one entry per matched parcel) — instead of
// one aggregate row covering the whole sale, which made it impossible to
// tell which original lot(s) a trim actually came from once a position had
// been built from multiple BUY/TOP_UP parcels.
//
// Label: "P#<parcelId>" when this is a single, clean disposal that fully
// closes that parcel in one shot; "P#<parcelId>-<n>" for any partial
// disposal (n = 1 + count of prior disposal-slice rows already recorded
// against that parcel) — including the eventual slice that finally exhausts
// a parcel which already had earlier partial trims against it, since by then
// it's no longer a single clean closure.
//
// Also patches each matched parcel's original BUY/TOP_UP journal row's
// `status`: 'closed' when the parcel's remainingQty is now 0, 'trimmed' when
// shares remain — so the original lot's row visibly reflects what's left.
//
// Each entry is unshifted into state.tradeJournal as it's built (so the
// per-parcel "prior disposal rows" count sees earlier slices in the same
// batch) — callers must NOT also push/unshift the returned entries again.
function buildDisposalJournalEntries(opts) {
  const {
    ticker, account, disposals, tradePrice, action,
    recId, recExecuted, timestamp, date, regime, exitSignals,
    // mode: paper/real firewall (gotcha #88) — stamped on every disposal row so
    // a paper SELL never produces a journal row that reads as real. Falls back to
    // the matched parcel's own mode (below) when the caller omits it.
    mode,
    // disposalIdBase is deprecated (was positional); kept in destructure for
    // backwards-compat with old call sites that still pass it, but ignored.
    // Stable ids now come from disposal.id assigned in matchSaleAgainstParcels.
  } = opts;

  const entries = [];
  (disposals || []).forEach((d, i) => {
    const parcel = (state.cgtParcels || []).find(p => p.id === d.parcelId);
    const remainingAfter = parcel ? (parcel.remainingQty || 0) : 0;
    // 'RECLASSIFY' is included alongside 'BUY'/'TOP_UP' — a parcel that was
    // ever split or moved between accounts has its journal row's action
    // flipped to 'RECLASSIFY' (gotcha #79), but it's still THE row
    // representing that open parcel and must get the same closed/trimmed
    // status patch when sold. Excluding it left every reclassified parcel's
    // row permanently stuck on status:'open' even after a full disposal.
    const buyRow = d.parcelId != null
      ? (state.tradeJournal || []).find(e => e.parcelId === d.parcelId
          && (e.action === 'BUY' || e.action === 'TOP_UP' || e.action === 'RECLASSIFY'))
      : null;
    // Identify prior disposal-slice rows by `e.parcel` being set, rather than a
    // separate internal-only flag — `parcel` is persisted (round-trips through
    // save/reload), so a flag that only lived in memory would undercount
    // historical slices after a reload and mislabel future suffixes.
    const priorDisposalRows = d.parcelId != null
      ? (state.tradeJournal || []).filter(e => e.parcelId === d.parcelId && (e.action === 'SELL' || e.action === 'TRIM')).length
      : 0;
    const isCleanFullClose = priorDisposalRows === 0 && remainingAfter <= 0;
    const parcelLabel = d.parcelId == null
      ? null
      : (isCleanFullClose ? `P#${d.parcelId}` : `P#${d.parcelId}-${priorDisposalRows + 1}`);

    if (buyRow) {
      buyRow.status = remainingAfter > 0 ? 'trimmed' : 'closed';
      if (remainingAfter <= 0) buyRow.closeDate = date;
    }

    // `date` is the transaction/sale date so the Journal shows the SELL row
    // under the date the trade actually happened. The parcel open date is
    // preserved in `parcelOpenDate` for the ATO CGT discount-eligibility
    // check (>365 days between parcelOpenDate and date) and for hold-duration
    // calculations in performance.js. Legacy rows (pre-fix) had date=openDate
    // and relied on the ATO CSV using (date, closeDate) — exportTradeJournalCSV
    // now reads parcelOpenDate || date so backwards-compat is maintained.
    const entry = {
      id: nextJournalId(),
      date,   // sale date (today) — what the Journal page shows
      parcelOpenDate: d.parcelDate || buyRow?.date || null,   // for ATO CGT / hold duration
      ticker, action, qty: d.saleQty,
      entryPrice: d.parcelCostPerShare, exitPrice: tradePrice, fees: d.saleFee || 0,
      status: 'closed', pnl: d.grossGain, closeDate: date,
      disposalIds: d.id != null ? [d.id] : undefined,
      parcelId: d.parcelId, parcel: parcelLabel,
      recId, recExecuted, timestamp, account,
      exitSignals, regime,
      // Row mode: caller-provided, else the matched parcel's mode, else the
      // disposal's own mode, else paper (isRealTrade invariant).
      mode: mode || d.mode || (parcel && parcel.mode) || 'paper',
    };
    state.tradeJournal.unshift(entry);   // push immediately so the next iteration's priorDisposalRows count sees it
    entries.push(entry);
  });
  return entries;
}

// Returns true iff a rollback was actually performed, false otherwise (e.g.
// a trimmed/closed BUY row, or a RECLASSIFY row — neither has a rollback
// branch below). removeJournalTrade() (journal.js) uses this to refuse
// deleting a row when nothing was actually reversed, rather than silently
// splicing it out of state.tradeJournal while leaving portfolio/parcel state
// untouched and inconsistent.
function rollbackTradeJournalEntry(t) {
  if(!t || !t.action || !t.ticker || !t.qty) return false;
  // Treat TOP_UP like BUY and TRIM like SELL for rollback purposes.
  let action = t.action.toUpperCase();
  if(action === 'TOP_UP') action = 'BUY';
  if(action === 'TRIM')   action = 'SELL';
  // Deliberately does NOT handle status==='trimmed' — a lot that's been
  // partially sold can't be cleanly "un-bought" without also reversing the
  // disposal-slice row(s) that consumed shares from it (a separate, more
  // involved operation). Falls through to a safe no-op for trimmed/closed
  // BUY rows rather than attempting a partial/incorrect rollback.
  // Paper/real firewall (gotcha #88): every reversal below must stay inside the
  // row's own mode — a paper rollback must refund paperCash (never real cash)
  // and only ever touch the paper holding, and vice versa.
  const tMode = t.mode || 'paper';
  if(action === 'BUY' && t.status === 'open') {
    const holding = getPortfolioHolding(t.ticker, t.account || 'personal', tMode);
    if(!holding || holding.shares < t.qty) return false;
    // Back-calculate avgPrice before this buy/top-up was applied.
    // totalCost_before = totalCost_after - (qty × entryPrice)
    const totalCostAfter  = holding.shares * holding.avgPrice;
    const topupCost       = t.qty * t.entryPrice;
    const sharesAfter     = Math.round((holding.shares - t.qty) * 10000) / 10000;
    holding.shares        = sharesAfter;
    if (sharesAfter > _SHARE_EPSILON) {
      holding.avgPrice = (totalCostAfter - topupCost) / sharesAfter;
    }
    adjustCashForMode(t.qty * t.entryPrice + Number(t.fees || 0), tMode);
    if(Math.abs(holding.shares) < _SHARE_EPSILON) state.portfolio = state.portfolio.filter(h => !(h.ticker === holding.ticker && (h.account || 'personal') === (holding.account || 'personal') && (h.mode || 'paper') === tMode));
    // Remove matching parcel (last added for this ticker matching qty+price)
    if(t.parcelId) {
      state.cgtParcels = state.cgtParcels.filter(p => p.id !== t.parcelId);
    } else {
      const idx = [...state.cgtParcels].reverse().findIndex(p => p.ticker === t.ticker && p.qty === t.qty && Math.abs(p.costPerShare - t.entryPrice) < 0.001);
      if(idx !== -1) state.cgtParcels.splice(state.cgtParcels.length - 1 - idx, 1);
    }
    return true;
  }
  // Failed-execution SELL/TRIM: status='open', exitPrice=null, pnl=null.
  // Nothing was applied to portfolio/parcels/CGT, so there's nothing to
  // reverse — just allow the splice to proceed.
  if(action === 'SELL' && t.status === 'open' && t.exitPrice == null && t.pnl == null) {
    return true;
  }
  if(action === 'SELL' && t.status === 'closed' && t.exitPrice != null) {
    const costBasis = t.entryPrice;
    const holding = getPortfolioHolding(t.ticker, t.account || 'personal', tMode);
    if(holding) {
      const totalCostVal = holding.shares * holding.avgPrice + t.qty * costBasis;
      holding.shares += t.qty;
      holding.avgPrice = totalCostVal / holding.shares;
      holding.currentPrice = t.exitPrice;
    } else {
      state.portfolio.push({ ticker: t.ticker.toUpperCase(), shares: t.qty, avgPrice: costBasis, currentPrice: t.exitPrice, sector: t.sector || 'Other', account: t.account || 'personal', mode: tMode });
    }
    adjustCashForMode(-(t.qty * t.exitPrice - Number(t.fees || 0)), tMode);
    // Restore parcel remainingQty from disposals that belong to this trade.
    // disposalIds now holds stable disposal.id values (not positional indices),
    // so find by id — safe regardless of what other disposals have been deleted.
    if(t.disposalIds && t.disposalIds.length) {
      const idSet = new Set(t.disposalIds);
      state.cgtDisposals.forEach(d => {
        if(!idSet.has(d.id)) return;
        if(d.parcelId) {
          const parcel = state.cgtParcels.find(p => p.id === d.parcelId);
          if(parcel) parcel.remainingQty += d.saleQty;
        }
      });
      state.cgtDisposals = state.cgtDisposals.filter(d => !idSet.has(d.id));
      // Reset the parent BUY/TOP_UP/RECLASSIFY row's status now that this disposal is reversed.
      const parcel = t.parcelId != null
        ? (state.cgtParcels || []).find(p => p.id === t.parcelId)
        : null;
      const parentBuyRow = state.tradeJournal.find(e =>
        e.parcelId === t.parcelId &&
        (e.action === 'BUY' || e.action === 'TOP_UP' || e.action === 'RECLASSIFY')
      );
      if (parentBuyRow && parcel) {
        parentBuyRow.status = parcel.remainingQty < parcel.qty ? 'trimmed' : 'open';
        if (parentBuyRow.status === 'open') parentBuyRow.closeDate = null;
      }
    }
    return true;
  }
  return false;
}
