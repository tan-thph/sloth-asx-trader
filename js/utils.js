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

const portfolioValue = () => state.portfolio.reduce((s,h)=>s+h.shares*h.currentPrice, 0);
const totalCost      = () => state.portfolio.reduce((s,h)=>s+h.shares*h.avgPrice, 0);
const totalGain      = () => portfolioValue() - totalCost();
const totalNetWorth  = () => portfolioValue() + state.cash;

// Deduplicates portfolio by ticker for display (weighted avg cost, summed shares)
function mergedPortfolio() {
  const acct = state.activeAccount || 'all';
  const holdings = acct === 'all'
    ? state.portfolio
    : state.portfolio.filter(h => (h.account || 'personal') === acct);
  const map = {};
  for (const h of holdings) {
    // Key by ticker+account so that e.g. WES held personally and WES bought as a
    // day-trade (account='trading') appear as two separate rows, not one combined row.
    const hAcct = h.account || 'personal';
    const key = h.ticker + '|' + hAcct;
    if (!map[key]) {
      map[key] = { ticker: h.ticker, shares: 0, _totalCost: 0, currentPrice: h.currentPrice, sector: h.sector || 'Other', account: hAcct };
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
function getPortfolioHolding(ticker, account) {
  const symbol = ticker.toUpperCase();
  if (account) {
    return state.portfolio.find(h => h.ticker === symbol && (h.account || 'personal') === account);
  }
  return state.portfolio.find(h => h.ticker === symbol);
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
