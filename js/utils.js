// Escape untrusted text before inserting into innerHTML — guards against
// malformed RSS headlines, AI output, or external API strings breaking layout.
function escapeHTML(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
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
    if (!map[h.ticker]) {
      map[h.ticker] = { ticker: h.ticker, shares: 0, _totalCost: 0, currentPrice: h.currentPrice, sector: h.sector || 'Other', account: h.account || 'personal' };
    }
    map[h.ticker]._totalCost += h.shares * h.avgPrice;
    map[h.ticker].shares += h.shares;
    // Always take the latest currentPrice (last write wins — refreshPrices sets it uniformly)
    map[h.ticker].currentPrice = h.currentPrice;
    // Prefer any sector that isn't 'Other' or blank
    const incoming = h.sector && h.sector !== 'Other' ? h.sector : null;
    if (incoming && (!map[h.ticker].sector || map[h.ticker].sector === 'Other')) {
      map[h.ticker].sector = incoming;
    }
  }
  return Object.values(map).map(h => ({ ...h, avgPrice: h._totalCost / h.shares }));
}
const sign           = n  => n >= 0 ? '+' : '-';
const confColor      = c  => c >= 0.70 ? '#16a34a' : c >= 0.55 ? '#d97706' : '#dc2626';
const nowSydney      = () => new Date().toLocaleTimeString('en-AU',{timeZone:'Australia/Sydney',hour:'2-digit',minute:'2-digit'});
const todayStr       = () => { const d=new Date(); return d.toLocaleDateString('en-AU',{timeZone:'Australia/Sydney'}).split('/').map((p,i)=>i===2?p:(p.length===1?'0'+p:p)).join('-'); };
const getApiKey      = () => state.settings.apiKey || localStorage.getItem('asx_api_key') || '';

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
  const map = { BUY:'badge-buy', SELL:'badge-sell', HOLD:'badge-hold', TRIM:'badge-trim', TOP_UP:'badge-topup', DRP:'badge-drp' };
  const cls = map[a] || 'badge-hold';
  const label = a === 'TOP_UP' ? 'TOP UP' : a;
  return `<span class="badge ${cls}">${label}</span>`;
}
function statusBadge(s) {
  if(s==='executed') return '<span class="badge badge-executed">Executed</span>';
  if(s==='skipped')  return '<span class="badge badge-skipped">Skipped</span>';
  if(s==='pending')  return '<span class="badge badge-pending">Pending</span>';
  return '';
}
function getPortfolioHolding(ticker) {
  return state.portfolio.find(h => h.ticker === ticker.toUpperCase());
}

function toast(msg, type='info') {
  const c=document.getElementById('toast-container');
  const el=document.createElement('div');
  el.className='toast';
  el.style.borderLeft=`3px solid ${type==='success'?'#22c55e':type==='error'?'#ef4444':'#3b82f6'}`;
  el.textContent=msg;
  c.appendChild(el);
  setTimeout(()=>el.remove(), 3500);
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
