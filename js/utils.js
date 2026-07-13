// Apply theme: 'auto' clears data-theme (OS-native), 'light'/'dark' sets it.
// Also updates the <meta name="theme-color"> for PWA chrome.
function _applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    // Forven_UIUX_Adoption.md §1 bug fix: 'terminal' is a dark-styled theme
    // but wasn't covered by this check — PWA/mobile chrome stayed light
    // (#ffffff) under the new pure-black theme. Give it its own background.
    const isDark = theme === 'dark' ||
      (theme === 'auto' && window.matchMedia('(prefers-color-scheme:dark)').matches);
    meta.content = theme === 'terminal' ? '#000000' : (isDark ? '#17181c' : '#ffffff');
  }
}

// Normalize an AI-supplied ticker for matching against state.portfolio/
// liveSignals, which always store bare uppercase ASX codes (no .AX suffix).
// Claude's response-validator regex permits an optional ".AX" suffix
// (js/response-validator.js), so a rec's ticker can legitimately come back
// as "CBA.AX" — matching that against a bare "CBA" holding without
// normalizing first silently finds zero accounts and falls through to a
// wrong default everywhere ticker equality is checked (account resolution,
// journal dedup, Day Trading sync). Always normalize before comparing.
function _normTicker(t) {
  return String(t || '').toUpperCase().replace(/\.AX$/, '');
}

// ── Paper/real trade firewall ────────────────────────────────────────────────
// THE safety invariant for the paper-trading feature: a record is REAL only when
// its `mode === 'real'`. Everything else — an explicit 'paper', a legacy record
// with no mode, an undefined — is treated as PAPER and excluded from all tax
// (CGT/EOFY), real-performance, and real-cash math. Failing safe means a fake
// trade can NEVER leak into your tax records by omission. Accepts a record object
// ({mode}) or a bare mode string. Use everywhere tax/real-money math happens.
function isRealTrade(x) {
  const m = (x && typeof x === 'object') ? x.mode : x;
  return m === 'real';
}

// Blocking gatekeeper: ask REAL vs PAPER at lodge time, with NO default (the user
// must choose deliberately). Returns a Promise resolving to 'real' | 'paper', or
// null if cancelled (caller must abort the lodge on null). Rendered as a modal so
// it works from any lodge path (AI rec execute, manual, day-trade, DRP, CSV).
function askTradeMode(summary) {
  return new Promise((resolve) => {
    document.getElementById('trade-mode-dialog')?.remove();
    const dlg = document.createElement('div');
    dlg.id = 'trade-mode-dialog';
    dlg.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)';
    const done = (val) => { dlg.remove(); resolve(val); };
    dlg.innerHTML = `
      <div class="card" style="max-width:420px;width:92%;padding:20px" onclick="event.stopPropagation()">
        <div class="card-title" style="margin-bottom:6px">Log this trade as…</div>
        <p class="text-xs text-muted" style="margin-bottom:8px">
          ${summary ? escapeHTML(summary) + '<br>' : ''}
          <strong>Real</strong> trades record CGT, real cash &amp; performance.
          <strong>Paper</strong> trades stay in the journal (badged) and feed model calibration,
          but never touch tax, real cash, or real performance.
        </p>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button id="tm-real"  class="btn btn-success" style="flex:1">💰 Real trade</button>
          <button id="tm-paper" class="btn btn-primary" style="flex:1">📝 Paper trade</button>
        </div>
        <button id="tm-cancel" class="btn btn-sm" style="width:100%;margin-top:10px">Cancel</button>
      </div>`;
    dlg.addEventListener('click', () => done(null));  // click backdrop = cancel
    document.body.appendChild(dlg);
    document.getElementById('tm-real').onclick   = () => done('real');
    document.getElementById('tm-paper').onclick  = () => done('paper');
    document.getElementById('tm-cancel').onclick = () => done(null);
  });
}

// CGT 50% discount eligibility — the ONE canonical boundary (Audit C2).
// ATO rule: the CGT asset must be held for MORE than 12 months (acquisition day
// excluded, disposal day included) ⇒ strictly > 365 days. A parcel held exactly
// 365 days is NOT eligible. Defined once here (utils.js loads before everything) so
// the open-lots table, the pre-trade sell estimate, and the SELL validator can never
// disagree with the disposal engine (matchSaleAgainstParcels in portfolio-helpers.js),
// which used `> 365` while the UI/validator used `>= 365`.
function cgtDiscountEligible(heldDays) {
  return typeof heldDays === 'number' && heldDays > 365;
}

// Escape untrusted text before inserting into innerHTML — guards against
// malformed RSS headlines, AI output, or external API strings breaking layout.
function escapeHTML(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

// Defensive coercion for rec.reasoning — should always be a plain string per
// the Claude response schema, but applyRegimeModifiers() previously wrapped
// it in an array when a regime warning fired (fixed in regime-engine.js),
// and any future producer could reintroduce the same shape. Callers that
// invoke string methods (.replace/.slice/etc.) directly on rec.reasoning
// should go through this instead of assuming the type.
function reasoningText(r) {
  if (Array.isArray(r)) return r.join(' ');
  return r || '';
}

// Ports routes/learning.py's _entry_signature(sig) verbatim (same fields, same
// format) so the whipsaw/contradiction check in analysis.js can build a
// comparable signature client-side without duplicating the field list.
// Deliberately omits rs_score/rs_5d_alpha — neutral placeholders today (see
// CLAUDE.md gotcha #43), surfacing them would imply real relative-strength
// data that doesn't exist. Returns "" when no usable field is present.
function entrySignature(sig) {
  if (!sig) return '';
  const parts = [];
  const rsi = sig.rsi_14;
  if (typeof rsi === 'number' && !isNaN(rsi)) parts.push(`RSI${Math.round(rsi)}`);
  const bb = sig.bb_pct_b;
  if (typeof bb === 'number' && !isNaN(bb)) parts.push(`%b${bb.toFixed(2)}`);
  const px200 = sig.px_vs_sma200;
  if (typeof px200 === 'number' && !isNaN(px200)) parts.push(`vs200${px200 >= 0 ? '+' : ''}${Math.round(px200)}%`);
  const ss = sig.setup_score;
  if (typeof ss === 'number' && !isNaN(ss)) parts.push(`setup${Math.round(ss)}`);
  const mh = sig.macd_hist;
  if (typeof mh === 'number' && !isNaN(mh)) parts.push(mh > 0 ? 'MACD+' : 'MACD-');
  return parts.join(' ');
}

const fmt = (n, d=2) => (n==null||isNaN(n)) ? '—' : Number(n).toLocaleString('en-AU',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtp = (n, d=2) => (n==null||isNaN(n)) ? '—' : (n>=0?'+':'') + fmt(Math.abs(n),d) + '%';

// ── Paper/real view mode (gotcha #88, Phase D) ───────────────────────────────
// The DISPLAY view mode: 'all' (default — real + paper together, distinguished by
// badges), 'real', or 'paper'. Narrows which holdings the on-screen aggregations
// and holdings table show. NAV history + tax stay real-only regardless (see the
// real* variants below) so the play-money paper book never pollutes them.
function _viewModeHoldings() {
  const vm = state.portfolioViewMode || 'all';
  if (vm === 'all') return state.portfolio;
  return state.portfolio.filter(h => (h.mode || 'paper') === vm);
}
// Cash matching the active view. Paper trading has NO funds/available-cash
// concept — the simulated paperCash pool is a fiction that only confuses "money
// available" (a paper trade is never gated on funds), so it is never shown or
// summed here. Paper view reports $0; 'all' and 'real' report REAL cash only.
function viewCash() {
  const vm = state.portfolioViewMode || 'all';
  if (vm === 'paper') return 0;
  return Number(state.cash) || 0;
}
const portfolioValue = () => _viewModeHoldings().reduce((s,h)=>s+h.shares*h.currentPrice, 0);
const totalCost      = () => _viewModeHoldings().reduce((s,h)=>s+h.shares*h.avgPrice, 0);
const totalGain      = () => portfolioValue() - totalCost();
const totalNetWorth  = () => portfolioValue() + viewCash();

// Real-only variants — NEVER follow the view toggle. Used for the persisted NAV
// history snapshot and anywhere real net worth must be tracked independently of
// what the user is currently looking at.
const realPortfolioValue = () => state.portfolio
  .filter(h => isRealTrade(h)).reduce((s,h)=>s+h.shares*h.currentPrice, 0);
const realNetWorth       = () => realPortfolioValue() + (Number(state.cash) || 0);
// Paper book market value — paper holdings only, NO cash (paper has no funds
// concept, gotcha #88). Paper "net worth" == paper portfolio value. Used by the
// Value History snapshot + chart's Paper view.
const paperPortfolioValue = () => state.portfolio
  .filter(h => !isRealTrade(h)).reduce((s,h)=>s+h.shares*h.currentPrice, 0);

// Seed the simulated paper-cash pool from settings.paperStartCash the first time
// paper mode is used (guarded by a one-shot flag so a genuine spend-down to 0
// never re-seeds). Without this, paperCash starts at 0 and every paper buy fails
// its cash-sufficiency check. Called by adjustCashForMode + the day-trade checks.
function ensurePaperCashSeeded() {
  if (!state._paperCashSeeded && (state.paperCash == null || state.paperCash === 0)) {
    state.paperCash = Number(state.settings?.paperStartCash) || 100000;
  }
  state._paperCashSeeded = true;
}

// Deduplicates portfolio by ticker for display (weighted avg cost, summed shares)
function mergedPortfolio() {
  const acct = state.activeAccount || 'all';
  // Start from the view-mode-filtered set (gotcha #88 Phase D) so real/paper/all
  // toggling narrows the holdings table, then apply the account filter on top.
  const base = _viewModeHoldings();
  const holdings = acct === 'all'
    ? base
    : base.filter(h => (h.account || 'personal') === acct);
  const map = {};
  for (const h of holdings) {
    // Key by ticker+account+mode so a real and a paper lot of the same ticker in
    // the same account stay separate rows (and each carries its own LIVE/PAPER
    // badge) — mirrors the account split already keyed here.
    const hAcct = h.account || 'personal';
    const hMode = (h.mode || 'paper');
    const key = h.ticker + '|' + hAcct + '|' + hMode;
    if (!map[key]) {
      map[key] = { ticker: h.ticker, shares: 0, _totalCost: 0, currentPrice: h.currentPrice, sector: h.sector || 'Other', account: hAcct, mode: hMode };
    }
    map[key]._totalCost += h.shares * h.avgPrice;
    map[key].shares += h.shares;
    // Always take the latest currentPrice (last write wins — refreshPrices sets it uniformly)
    map[key].currentPrice = h.currentPrice;
    // Prefer any sector that isn't 'Other' or blank
    const incoming = h.sector && h.sector !== 'Other' ? h.sector : null;
    if (incoming && (!map[key].sector || map[key].sector === 'Other')) {
      map[key].sector = incoming;
    }
  }
  // Improvement F: filter out zero/negative share totals before computing avgPrice.
  // h.shares = 0 after data corruption (zero-qty DRP, reconcile bug, split applied twice)
  // would produce avgPrice = Infinity which propagates into unrealisedPnl, weight, etc.
  return Object.values(map)
    .filter(h => h.shares > 0)
    .map(h => ({ ...h, avgPrice: h._totalCost / h.shares }));
}
const sign           = n  => n >= 0 ? '+' : '-';
const confColor      = c  => c >= 0.70 ? '#16a34a' : c >= 0.55 ? '#d97706' : '#dc2626';
const nowSydney      = () => new Date().toLocaleTimeString('en-AU',{timeZone:'Australia/Sydney',hour:'2-digit',minute:'2-digit'});
const todayStr       = () => { const d=new Date(); return d.toLocaleDateString('en-AU',{timeZone:'Australia/Sydney'}).split('/').map((p,i)=>i===2?p:(p.length===1?'0'+p:p)).join('-'); };
const getApiKey      = () => state.settings.apiKey || localStorage.getItem('asx_api_key') || '';

// Truncate at the last word boundary before maxLen and append an ellipsis,
// instead of a blunt slice(0, n) mid-word/mid-sentence cut. Returns the
// original string unchanged if it already fits.
function smartTruncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || '';
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

// Single canonical copy — previously duplicated in recommendations.js and performance.js.
// SELL/TRIM recs frame stop ABOVE and target BELOW entry (inverse of BUY/TOP_UP),
// so a profitable trim must not read as 'stop_hit'. Prefer the action; fall back
// to stop-vs-target geometry when action is unavailable.
function _detectExitReason(exitPrice, stopLoss, target, action) {
  if (!exitPrice || exitPrice <= 0) return 'manual';
  const isShort = (action === 'SELL' || action === 'TRIM') ||
                  (!action && stopLoss && target && stopLoss > target);
  if (isShort) {
    if (stopLoss && exitPrice >= stopLoss * 0.995) return 'stop_hit';
    if (target   && exitPrice <= target   * 1.005) return 'target_hit';
    return 'manual';
  }
  if (stopLoss && exitPrice <= stopLoss * 1.005) return 'stop_hit';
  if (target   && exitPrice >= target   * 0.995) return 'target_hit';
  return 'manual';
}

function actionBadge(a) {
  const map = { BUY:'badge-buy', SELL:'badge-sell', HOLD:'badge-hold', TRIM:'badge-trim', TOP_UP:'badge-topup', DRP:'badge-drp', RECLASSIFY:'badge-drp' };
  const cls = map[a] || 'badge-hold';
  const label = a === 'TOP_UP' ? 'TOP UP' : a === 'RECLASSIFY' ? 'RECLASSIFY' : a;
  return `<span class="badge ${cls}">${label}</span>`;
}
function statusBadge(s) {
  if(s==='executed') return '<span class="badge badge-executed">Executed</span>';
  if(s==='skipped')  return '<span class="badge badge-skipped">Skipped</span>';
  if(s==='pending')  return '<span class="badge badge-pending">Pending</span>';
  return '';
}
// account param (optional) — when provided, only matches the holding in that
// account. When omitted, behavior is unchanged: first ticker match wins
// regardless of account (existing callers continue to work as before).
// mode param (optional) — 'real'|'paper' (gotcha #88); when provided, also scopes
// to that trade mode (missing holding.mode ⇒ 'paper'). A real sell must pass
// mode='real' so it never resolves a paper holding as its cost basis.
function getPortfolioHolding(ticker, account, mode) {
  const symbol = ticker.toUpperCase();
  return state.portfolio.find(h => {
    if (h.ticker !== symbol) return false;
    if (account && (h.account || 'personal') !== account) return false;
    if (mode && (h.mode || 'paper') !== mode) return false;
    return true;
  });
}

// ── Cash routing (paper/real firewall, gotcha #88) ───────────────────────────
// Credit (positive delta) or debit (negative) the correct cash pool for a trade
// mode. Real trades move real `state.cash`; paper trades move the separate
// simulated `state.paperCash` pool so the real cash figure stays accurate even
// while paper-trading. Missing mode ⇒ paper (isRealTrade invariant).
function adjustCashForMode(delta, mode) {
  const d = Number(delta) || 0;
  if (isRealTrade(mode)) {
    state.cash = (Number(state.cash) || 0) + d;
  } else {
    ensurePaperCashSeeded();
    state.paperCash = (Number(state.paperCash) || 0) + d;
  }
}

// ── resetPaperBook (IMPROVEMENTS #7) ─────────────────────────────────────────
// Wipe the paper sandbox — paper holdings, parcels, journal rows, disposals,
// recs and linked day-trade positions — and restore paperCash to paperStartCash,
// WITHOUT touching a single real record.
//
// Safety: this is a DELETE, so the fail-safe direction is INVERTED from
// isRealTrade(). isRealTrade treats a missing mode as paper (keep it out of
// tax); for deletion we must do the opposite — only an EXPLICIT `mode==='paper'`
// is removed. A missing/undefined mode is ambiguous (it may be un-backfilled
// real history from before the firewall shipped, gotcha #91) and is PRESERVED.
// So the invariant is provable: no row with isRealTrade(x)===true, and no row
// with an absent mode, is ever deleted. Run the legacy→real backfill first if
// you want untagged history excluded from the sandbox.
//
// Returns a summary of how many rows were removed from each surface.
function _isExplicitPaper(x) {
  return !!x && x.mode === 'paper';
}

function resetPaperBook() {
  const summary = { portfolio: 0, parcels: 0, journal: 0, disposals: 0,
                    recHistory: 0, positions: 0 };

  // Collect the ids of paper parcels being removed so we can also drop any
  // day-trade / intraday position linked to them (positions carry parcelId
  // from creation, gotcha #75). Do this BEFORE mutating cgtParcels.
  const _removedParcelIds = new Set(
    (state.cgtParcels || []).filter(_isExplicitPaper).map(p => p.id)
  );

  const _filter = (key) => {
    const arr = state[key];
    if (!Array.isArray(arr)) return;
    const before = arr.length;
    state[key] = arr.filter(x => !_isExplicitPaper(x));
    summary[key] = before - state[key].length;
  };
  _filter('portfolio');
  _filter('cgtParcels');   // note: summary key handled below
  _filter('tradeJournal');
  _filter('cgtDisposals');
  _filter('recHistory');
  // _filter wrote counts under the state keys; normalise to the summary shape.
  summary.parcels    = summary.cgtParcels   || 0;
  summary.journal    = summary.tradeJournal || 0;
  summary.disposals  = summary.cgtDisposals || 0;
  delete summary.cgtParcels; delete summary.tradeJournal; delete summary.cgtDisposals;

  // Day-trade + intraday positions: remove any whose own mode is explicit paper
  // OR whose parcelId points at a parcel we just removed (a paper position that
  // predates per-position mode tagging still links to a paper parcel).
  const _dropPos = (arr) => {
    if (!Array.isArray(arr)) return arr;
    const before = arr.length;
    const kept = arr.filter(p =>
      !_isExplicitPaper(p) && !(p && _removedParcelIds.has(p.parcelId)));
    summary.positions += before - kept.length;
    return kept;
  };
  if (state.intraday)   state.intraday.openPositions       = _dropPos(state.intraday.openPositions);
  if (state.dayTrading) state.dayTrading.recommendations   = _dropPos(state.dayTrading.recommendations);

  // Clear the paper equity curve without touching the real NAV series: paperValue
  // is a separate per-snapshot field (gotcha #88), so nulling it leaves
  // netWorth/portfolioValue/cash — the real basis — intact.
  if (Array.isArray(state.portfolioHistory)) {
    for (const snap of state.portfolioHistory) {
      if (snap && 'paperValue' in snap) delete snap.paperValue;
    }
  }

  // Restore the sandbox cash pool to its configured starting balance.
  state.paperCash = Number(state.settings?.paperStartCash) || 100000;
  state._paperCashSeeded = true;

  return summary;
}

// ── Realistic paper fills (IMPROVEMENTS #10) ─────────────────────────────────
// Model the bid-ask spread + market impact a live order would cross, so the
// paper book's P&L isn't systematically optimistic vs what live trading would
// achieve. Single source of truth mirrors the backend exactly: the ADV-tier
// one-way rate (core.adv_slippage) × the regime multiplier (_SLIP_REGIME_MULT
// in routes/learning.py). Keep the tiers and multipliers in sync with both.
//
// PAPER ONLY: real trades book at the price the user actually got (which already
// includes whatever fill they achieved), so they are never slipped. The caller
// (markExecuted) gates on isRealTrade(mode) + the paperRealisticFills setting.
const _SLIP_REGIME_MULT = { highVol: 1.5, riskOff: 1.25, panic: 2.0 };

function _advSlippageRate(advAud) {
  const a = Number(advAud);
  if (!isFinite(a) || a <= 0) return 0.0035;   // thin-name / unknown tier (conservative)
  if (a >= 10000000) return 0.0005;   // 0.05%
  if (a >= 2000000)  return 0.0010;   // 0.10%
  if (a >= 500000)   return 0.0020;   // 0.20%
  return 0.0035;                      // 0.35%
}

// Adverse fill: a BUY/TOP_UP pays UP (crosses the ask), a SELL/TRIM receives
// DOWN (crosses the bid). Returns the slipped price (rounded to 4dp) or the
// original price unchanged when inputs are invalid.
function paperFillPrice(price, action, advAud, regime) {
  const p = Number(price);
  if (!isFinite(p) || p <= 0) return price;
  const rate = _advSlippageRate(advAud) * (_SLIP_REGIME_MULT[regime] || 1);
  const buyish = action === 'BUY' || action === 'TOP_UP';
  return +(p * (buyish ? (1 + rate) : (1 - rate))).toFixed(4);
}

// ── mergeLiveMacro ────────────────────────────────────────────────────────────
// Merge fresh live market numbers into state.macroData WITHOUT wiping the AI
// brief fields — those are only replaced by a successful new AI run.
// Bug fixed 2026-06-11: four call sites did `state.macroData = {...live}`
// wholesale, so any live-data refresh (incl. the silent one on every Macro page
// visit after 5 min) destroyed the day's AI brief, and the next save persisted
// the gutted object. The brief must survive until the next AI run replaces it.
function mergeLiveMacro(liveData) {
  const AI_FIELDS = ['sentiment', 'sentimentConf', 'bullish', 'analysis', 'keyDrivers'];
  const prev = state.macroData || {};
  const live = liveData || {};
  const merged = { ...prev, ...live };
  // The live /api/macro payload never carries AI fields, but guard anyway
  for (const f of AI_FIELDS) {
    if (live[f] == null && prev[f] != null) merged[f] = prev[f];
  }
  // _source gates the Sentiment row on the Macro page — keep 'ai' while a brief exists
  merged._source = (merged.analysis || merged.keyDrivers) ? 'ai' : 'live';
  state.macroData = merged;
  return merged;
}

function toast(msg, type='info') {
  const c=document.getElementById('toast-container');
  const el=document.createElement('div');
  el.className='toast';
  el.style.borderLeft=`3px solid ${type==='success'?'#22c55e':type==='error'?'#ef4444':'#3b82f6'}`;
  el.textContent=msg;
  c.appendChild(el);
  setTimeout(()=>el.remove(), 3500);
  // Push to notification center (if loaded)
  if (typeof pushNotification === 'function') {
    const titles = { success: 'Success', error: 'Error', warning: 'Warning', info: 'Info' };
    pushNotification(type, titles[type] || 'Info', msg, type === 'error' ? 'error' : 'system');
  }
}

// _retryBtn — standardised amber retry button for error/failure cards.
// label: button text; onclick: JS expression string or function reference name.
function _retryBtn(label, onclick) {
  return `<button class="btn btn-sm" style="background:#f59e0b;color:#fff;border-color:#d97706;margin-top:10px" onclick="${escapeHTML(onclick)}">${label}</button>`;
}

// _emptyCard — consistent empty-state card with optional action buttons.
// icon: emoji/char; title: bold heading; body: HTML paragraph(s); actions: HTML button string.
function _emptyCard(icon, title, body, actions='') {
  return `<div class="card"><div class="empty-state" style="padding:2rem;text-align:center">
    <div class="empty-icon" style="font-size:2rem;margin-bottom:0.5rem">${icon}</div>
    <div style="font-weight:600;font-size:15px;margin-bottom:6px">${title}</div>
    <div style="color:var(--text-secondary);font-size:13px;max-width:480px;margin:0 auto;line-height:1.6">${body}</div>
    ${actions ? `<div style="margin-top:14px">${actions}</div>` : ''}
  </div></div>`;
}

// parseClaudeJSON — safe JSON parser for Claude API responses (2.5)
// Strips markdown fences and trailing commas before parsing.
// Returns { ok:true, data } or { ok:false, error, raw }
function parseClaudeJSON(rawText) {
  const cleaned = (rawText || '')
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im, '')
    .replace(/```\s*$/im, '')
    .trim();

  try {
    return { ok: true, data: JSON.parse(cleaned) };
  } catch (firstErr) {
    // Try to recover: remove trailing commas before ] or }
    const repaired = cleaned.replace(/,(\s*[}\]])/g, '$1');
    try {
      return { ok: true, data: JSON.parse(repaired) };
    } catch {
      console.error('[parseClaudeJSON] failed — first 500 chars:', rawText?.slice(0, 500));
      return { ok: false, error: firstErr.message, raw: rawText };
    }
  }
}
