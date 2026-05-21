// ============================================================
// ASX ANNOUNCEMENTS PAGE
// Pipeline: ASX Filings → LLM summarisation → SQLite
// ============================================================

// ── Type colour map ───────────────────────────────────────────
const ANN_TYPE_COLORS = {
  'Earnings':         '#7c3aed',
  'Dividend':         '#16a34a',
  'Capital Raise':    '#2563eb',
  'CEO Change':       '#dc2626',
  'Acquisition':      '#9333ea',
  'AGM':              '#64748b',
  'Trading Halt':     '#ef4444',
  'Asset Sale':       '#d97706',
  'Guidance Update':  '#0891b2',
  'Other':            '#6b7280',
};

const ANN_TYPES = [
  'All', 'Earnings', 'Dividend', 'Capital Raise', 'CEO Change',
  'Acquisition', 'AGM', 'Trading Halt', 'Asset Sale', 'Guidance Update', 'Other',
];

// ── Impact border colour ──────────────────────────────────────
function _annImpactBorder(score) {
  if (score >= 8) return '#ef4444';
  if (score >= 6) return '#f59e0b';
  if (score >= 4) return '#3b82f6';
  return 'var(--border-light)';
}

// ── Sentiment colours ─────────────────────────────────────────
function _annSentiStyle(s) {
  if (!s) return { bg: 'var(--bg-secondary)', color: 'var(--text-muted)' };
  const m = {
    positive: { bg: '#dcfce7', color: '#16a34a' },
    neutral:  { bg: '#fef9c3', color: '#92400e' },
    negative: { bg: '#fee2e2', color: '#dc2626' },
  };
  return m[s.toLowerCase()] || { bg: 'var(--bg-secondary)', color: 'var(--text-muted)' };
}

// ── Relative time ─────────────────────────────────────────────
function _annRelTime(iso) {
  if (!iso) return '';
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60)    return 'just now';
  if (secs < 3600)  return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

// ── Format date for display ───────────────────────────────────
function _annFmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

// ── Loading skeleton ──────────────────────────────────────────
function _annSkeletonHTML() {
  return `
    <div class="card" style="margin-bottom:12px">
      <div style="height:16px;width:55%;background:var(--border-light);border-radius:4px;margin-bottom:8px"></div>
      <div style="height:10px;width:35%;background:var(--border-light);border-radius:4px"></div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div style="height:10px;width:80%;background:var(--border-light);border-radius:4px;margin-bottom:6px"></div>
      <div style="height:10px;width:60%;background:var(--border-light);border-radius:4px"></div>
    </div>
    <div class="card"><div style="height:300px"></div></div>`;
}

// ── CSS animation (injected once) ────────────────────────────
(function _injectAnnStyles() {
  if (document.getElementById('ann-pulse-style')) return;
  const s = document.createElement('style');
  s.id = 'ann-pulse-style';
  s.textContent = `
    @keyframes annPulse {
      0%,100% { opacity:1; transform:scale(1); }
      50%      { opacity:0.4; transform:scale(1.35); }
    }`;
  document.head.appendChild(s);
})();

// ── Main render ───────────────────────────────────────────────
async function renderAnnouncementsPage(gen) {
  const el = document.getElementById('main-content');

  // Guard + default state
  if (!state.announcements) {
    state.announcements = {
      items: [],
      status: null,
      lastSync: null,
      settingsOpen: false,
      filter: { ticker: 'all', type: 'all', sentiment: 'all', search: '' },
      syncDays: 3,
      syncTicker: '',
      reclassifyDays: 30,
      reclassifyTicker: '',
    };
  }
  if (state.announcements.settingsOpen === undefined) state.announcements.settingsOpen = false;
  if (state.announcements.syncDays         === undefined) state.announcements.syncDays         = 3;
  if (state.announcements.syncTicker       === undefined) state.announcements.syncTicker       = '';
  if (state.announcements.reclassifyDays   === undefined) state.announcements.reclassifyDays   = 30;
  if (state.announcements.reclassifyTicker === undefined) state.announcements.reclassifyTicker = '';

  // Show skeleton immediately
  el.innerHTML = _annSkeletonHTML();

  if (!state.serverOk) {
    if (state._renderGen !== gen) return;
    el.innerHTML = `
      <div class="card">
        <div class="empty-state">
          <div class="empty-icon">◆</div>
          <p>Backend server not running.</p>
          <p class="sub">Start <code>asx_server.py</code> then refresh this page.</p>
          <button class="btn btn-primary" onclick="checkServer().then(renderPage)">Check Connection</button>
        </div>
      </div>`;
    return;
  }

  try {
    // Build query params from current filters (server-side pre-filter)
    const f = state.announcements.filter;
    const params = new URLSearchParams({ days: 7 });
    if (f.ticker     && f.ticker     !== 'all') params.set('ticker',    f.ticker);
    if (f.type       && f.type       !== 'all') params.set('type',      f.type);
    if (f.sentiment  && f.sentiment  !== 'all') params.set('sentiment', f.sentiment);

    const [statusResp, feedResp, reclassifyResp] = await Promise.all([
      fetch(`${API}/api/announcements/status`).then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`${API}/api/announcements?${params}`).then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] })),
      fetch(`${API}/api/announcements/reclassify-status`).then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]);

    if (state._renderGen !== gen) return; // stale render guard

    state.announcements.status           = statusResp;
    state.announcements.items            = feedResp.items || [];
    state.announcements.lastSync         = statusResp.last_sync || null;
    state.announcements.reclassifyStatus = reclassifyResp;

    // Always load settings from server so the form reflects what's actually saved
    if (!state.announcements._settingsLoaded) {
      try {
        const srv = await fetch(`${API}/api/announcements/settings`).then(r => r.ok ? r.json() : null);
        if (srv && typeof srv === 'object' && !srv.error) {
          state.announcements.settings = { ...state.announcements.settings, ...srv };
        }
      } catch { /* keep defaults */ }
      state.announcements._settingsLoaded = true;
    }

    el.innerHTML = _annPageHTML(statusResp);

  } catch (ex) {
    if (state._renderGen !== gen) return;
    el.innerHTML = `<div class="card"><p class="text-danger">Failed to load announcements: ${ex.message}</p></div>`;
  }
}

// ── Page HTML builder ─────────────────────────────────────────
function _annPageHTML(status) {
  const lastSync         = state.announcements.lastSync;
  const items            = _annFilterItems(state.announcements.items);
  const totalCount       = state.announcements.items.length;
  const isRunning        = status && status.running;

  // Ticker breakdown for the info row
  const _portfolioTickers = mergedPortfolio().map(h => h.ticker);
  const _extraTickers     = state.analysisConfig?.extraTickers || [];
  const _allSyncTickers   = [...new Set([..._portfolioTickers, ..._extraTickers])];

  // Sync status pill
  let syncPill;
  if (isRunning) {
    syncPill = `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:2px 10px;border-radius:99px;background:#dbeafe;color:#1d4ed8;font-weight:600">
      <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#3b82f6;animation:annPulse 1.2s ease-in-out infinite"></span> Scanning…
    </span>`;
  } else if (lastSync) {
    const minAgo = Math.floor((Date.now() - new Date(lastSync).getTime()) / 60000);
    syncPill = `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:2px 10px;border-radius:99px;background:#dcfce7;color:#16a34a;font-weight:600">
      ● Synced ${minAgo < 1 ? 'just now' : minAgo + ' min ago'}
    </span>`;
  } else {
    syncPill = `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:2px 10px;border-radius:99px;background:var(--bg-secondary);color:var(--text-muted)">
      ○ Never synced
    </span>`;
  }

  const countBadge = `<span class="badge" style="background:var(--bg-secondary);color:var(--text-secondary);font-size:11px">${items.length} of ${totalCount} announcement${totalCount !== 1 ? 's' : ''}</span>`;

  // DB total badge
  const dbTotal = status && status.total_in_db != null
    ? `<span style="font-size:11px;color:var(--text-muted)">${status.total_in_db} in DB</span>`
    : '';

  // Card list
  const cardList = items.length
    ? items.map(a => _renderAnnCard(a)).join('')
    : `<div class="empty-state" style="padding:50px 20px">
        <div class="empty-icon">◆</div>
        <p>${totalCount > 0 ? 'No announcements match the current filters.' : 'No announcements yet. Click <strong>Sync Now</strong> to fetch ASX filings.'}</p>
      </div>`;

  // Progress banner — shown when running (or just triggered)
  const bannerDisplay = isRunning ? 'block' : 'none';
  const bannerContent = isRunning ? (() => {
    const done  = status.tickers_done  || 0;
    const total = status.tickers_total || 1;
    const pct   = Math.round((done / total) * 100);
    const cur   = status.current_ticker || '…';
    const found = status.current_ticker_new || 0;
    return `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#1d4ed8">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3b82f6;animation:annPulse 1.2s ease-in-out infinite"></span>
        Scanning ASX announcements…
      </span>
      <span style="font-size:12px;color:var(--text-secondary)">
        Processing <strong>${cur}</strong> &nbsp;·&nbsp; ${done} of ${total} tickers
        ${found > 0 ? `&nbsp;·&nbsp; <span style="color:#16a34a;font-weight:600">+${found} new</span>` : ''}
      </span>
      <div style="flex:1;min-width:120px;max-width:240px;height:6px;background:var(--border-light);border-radius:99px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#3b82f6,#6366f1);border-radius:99px;transition:width 0.4s ease"></div>
      </div>
      <span style="font-size:11px;color:var(--text-muted)">${pct}%</span>
    </div>`;
  })() : '';

  // Kick off poller if sync is already running when page loads
  if (isRunning) {
    setTimeout(_startAnnSyncPoller, 100);
    setTimeout(() => _setAnnSyncBtn(true), 100);
  }
  // Restore re-classify progress bar if a job is running (survives page refresh)
  const rc = state.announcements.reclassifyStatus || {};
  if (rc.running) {
    setTimeout(() => {
      const progress = document.getElementById('ann-reclassify-progress');
      const btn      = document.getElementById('ann-reclassify-btn');
      if (progress) progress.style.display = 'block';
      if (btn)      { btn.disabled = true; btn.style.opacity = '0.6'; }
      _updateReclassifyBar(rc.done || 0, rc.total || 0, rc.updated || 0);
      _startAnnReclassifyPoller();
    }, 200);
  }

  return `
    <!-- Top bar -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-size:15px;font-weight:700;color:var(--text-primary)">ASX Announcements</span>
          ${syncPill}
          ${!isRunning && lastSync ? `<span style="font-size:11px;color:var(--text-muted)">Last: ${_annFmtDate(lastSync)}</span>` : ''}
          ${dbTotal}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${countBadge}
          <select id="ann-sync-days" onchange="state.announcements.syncDays=parseInt(this.value)"
            title="Lookback window for this sync"
            style="font-size:12px;padding:2px 6px;border-radius:var(--radius-md);border:1px solid var(--border-light);background:var(--bg-secondary);color:var(--text-primary)">
            ${[1,3,7,14,30].map(d => `<option value="${d}" ${d===(state.announcements.syncDays||3)?'selected':''}>${d}d</option>`).join('')}
          </select>
          <input type="text" id="ann-scan-ticker" value="${state.announcements.syncTicker||''}"
            placeholder="Ticker(s) or blank for all"
            oninput="state.announcements.syncTicker=this.value"
            title="Comma-separated ASX codes to scan, or leave blank to scan all portfolio/watchlist tickers"
            style="width:170px;font-size:12px;padding:2px 7px;border:1px solid var(--border-light);border-radius:var(--radius-md);background:var(--bg-secondary);color:var(--text-primary)">
          <span id="ann-sync-btns">
            <button class="btn btn-primary btn-sm" id="ann-sync-btn"
              onclick="syncAnnouncements()"
              ${isRunning ? 'disabled style="opacity:0.6;cursor:not-allowed"' : ''}>
              ⟳ ${isRunning ? 'Scanning…' : 'Sync Now'}
            </button>
            ${isRunning ? `<button class="btn btn-sm btn-danger" onclick="stopAnnSync()">■ Stop</button>` : ''}
          </span>
          <button class="btn btn-sm" onclick="renderPage()" title="Refresh view">↺</button>
        </div>
      </div>
      <!-- Ticker scope row -->
      ${_allSyncTickers.length ? `
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border-light);display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-size:11px;color:var(--text-muted)">Will scan:</span>
        ${_portfolioTickers.map(t =>
          `<span style="font-size:11px;padding:1px 7px;border-radius:99px;background:#dbeafe;color:#1d4ed8;font-weight:600">${t}</span>`
        ).join('')}
        ${_extraTickers.length ? `
          <span style="font-size:11px;color:var(--text-muted)">+</span>
          ${_extraTickers.map(t =>
            `<span style="font-size:11px;padding:1px 7px;border-radius:99px;background:#ede9fe;color:#6d28d9;font-weight:600" title="From watchlist">★ ${t}</span>`
          ).join('')}
        ` : ''}
        ${_extraTickers.length === 0 ? `<span style="font-size:11px;color:var(--text-muted)">&nbsp;·&nbsp; add watchlist tickers under <em>Recommendations → Run Analysis</em></span>` : ''}
      </div>` : `
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border-light)">
        <span style="font-size:11px;color:var(--text-muted)">No tickers yet — add holdings or watchlist tickers under <em>Recommendations → Run Analysis</em>.</span>
      </div>`}
    </div>

    <!-- LLM Settings panel — ABOVE filter/cards so user sees it first -->
    <details id="ann-settings-panel" style="margin-bottom:12px" ${state.announcements.settingsOpen ? 'open' : ''}
      ontoggle="state.announcements.settingsOpen=this.open; if(this.open) { _maybeLoadOllamaModels(); const _p=(state.announcements.settings||{}).ann_llm_provider||'ollama'; if(_p==='groq') _loadGroqModels('ann-groq-model',(state.announcements.settings||{}).ann_groq_model||'llama-3.1-8b-instant'); }">
      <summary class="card" style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:var(--radius-md);font-size:13px;font-weight:600;color:var(--text-primary);user-select:none">
        <span>⚙</span>
        <span>LLM Settings</span>
        <span style="font-size:11px;color:var(--text-muted);font-weight:400;margin-left:2px">— click to configure classification model</span>
        <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${state.announcements.settingsOpen ? '▲' : '▼'}</span>
      </summary>
      <div class="card" style="border-top:none;border-top-left-radius:0;border-top-right-radius:0;padding-top:14px">
        ${_annSettingsPanelHTML(status)}
      </div>
    </details>

    <!-- Live scan progress banner -->
    <div id="ann-sync-banner" class="card" style="display:${bannerDisplay};margin-bottom:12px;background:linear-gradient(135deg,#eff6ff 0%,#eef2ff 100%);border:1px solid #bfdbfe">
      ${bannerContent}
    </div>

    <!-- Filter bar -->
    <div class="card" style="margin-bottom:12px" id="ann-filter-bar">
      ${_renderAnnFilters(state.announcements.items)}
    </div>

    <!-- Announcement cards -->
    <div class="card" style="margin-bottom:12px">
      <div id="ann-card-list">${cardList}</div>
    </div>`;
}

// ── Filter bar HTML ───────────────────────────────────────────
function _renderAnnFilters(items) {
  const f    = state.announcements.filter;
  const tickers = ['all', ...new Set(items.map(a => a.ticker).filter(Boolean))];

  const tickerChips = tickers.map(t => {
    const active = f.ticker === t;
    return `<button class="btn btn-sm" onclick="setAnnFilter('ticker','${t}')"
      style="padding:2px 10px;font-size:11px;${active ? 'background:var(--accent,#3b82f6);color:#fff;' : 'background:var(--bg-secondary);color:var(--text-secondary);'}border-radius:99px">
      ${t === 'all' ? 'All' : t}
    </button>`;
  }).join('');

  const typeOpts = ANN_TYPES.map(tp => {
    const val = tp === 'All' ? 'all' : tp;
    return `<option value="${val}" ${f.type === val ? 'selected' : ''}>${tp}</option>`;
  }).join('');

  const sentiOpts = [
    ['all', 'All Sentiment'],
    ['positive', '▲ Positive'],
    ['neutral',  '● Neutral'],
    ['negative', '▼ Negative'],
  ].map(([v, l]) => `<option value="${v}" ${f.sentiment === v ? 'selected' : ''}>${l}</option>`).join('');

  return `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <div style="display:flex;gap:4px;flex-wrap:wrap;flex:1">${tickerChips}</div>
      <select onchange="setAnnFilter('type',this.value)" style="font-size:12px;padding:3px 6px;border-radius:var(--radius-md);border:1px solid var(--border-light);background:var(--bg-secondary);color:var(--text-primary)">${typeOpts}</select>
      <select onchange="setAnnFilter('sentiment',this.value)" style="font-size:12px;padding:3px 6px;border-radius:var(--radius-md);border:1px solid var(--border-light);background:var(--bg-secondary);color:var(--text-primary)">${sentiOpts}</select>
      <input type="text" placeholder="Search headlines…" value="${f.search || ''}"
        oninput="setAnnFilter('search',this.value)"
        style="width:160px;font-size:12px;padding:3px 8px;border:1px solid var(--border-light);border-radius:var(--radius-md);background:var(--bg-secondary);color:var(--text-primary)">
    </div>`;
}

// ── Single announcement card ──────────────────────────────────
function _renderAnnCard(ann) {
  const impact        = ann.impact_score != null ? Number(ann.impact_score) : null;
  const senti         = (ann.sentiment || '').toLowerCase();
  const annType       = ann.type || 'Other';
  const typeColor     = ANN_TYPE_COLORS[annType] || ANN_TYPE_COLORS['Other'];
  const sentiStyle    = _annSentiStyle(senti);
  const tags          = ann.tags || [];
  const ticker        = ann.ticker || '';
  const headline      = ann.headline || ann.title || '';
  const summary       = ann.summary || '';
  const date          = ann.date || ann.published_date || '';
  const priceSensitive = ann.price_sensitive || false;
  const llmModel      = ann.llm_model || '';
  const annId         = ann.id || '';

  // Parse key figures extracted by the PS LLM prompt
  let keyFigures = {};
  if (ann.details) {
    try { keyFigures = JSON.parse(ann.details); } catch { keyFigures = {}; }
  }
  const hasKeyFigures  = Object.keys(keyFigures).length > 0;
  const isLLMClassified = llmModel && llmModel !== 'keyword_fallback' && llmModel !== 'keyword';

  // PS cards: always red left-border; use impact colour for non-PS
  const borderColor = priceSensitive ? '#ef4444' : (impact != null ? _annImpactBorder(impact) : 'var(--border-light)');
  // No hardcoded background — rely on left-border + badge for PS distinction (dark-theme safe)
  const cardBg = '';

  // Ticker badge
  const tickerBadge = ticker
    ? `<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd">${ticker}</span>`
    : '';

  // Type pill
  const typePill = `<span style="font-size:10px;padding:1px 7px;border-radius:99px;background:${typeColor}22;color:${typeColor};font-weight:600">${annType}</span>`;

  // Sentiment pill
  const sentiPill = senti
    ? `<span style="font-size:10px;padding:1px 7px;border-radius:99px;background:${sentiStyle.bg};color:${sentiStyle.color};font-weight:600">${senti.charAt(0).toUpperCase() + senti.slice(1)}</span>`
    : '';

  // Impact score badge
  const impactBadge = impact != null
    ? `<span style="font-size:10px;padding:1px 7px;border-radius:99px;background:${borderColor}22;color:${borderColor};font-weight:700;border:1px solid ${borderColor}44" title="Impact score">⚡ ${impact}/10</span>`
    : '';

  // Price sensitive badge — more prominent than a plain dot
  const psDot = priceSensitive
    ? `<span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:99px;background:#fee2e2;color:#dc2626;border:1px solid #fca5a5" title="Price sensitive">⚡ Price Sensitive</span>`
    : '';

  // Tags
  const tagBadges = tags.slice(0, 4).map(tag =>
    `<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:var(--bg-secondary);color:var(--text-muted)">#${tag}</span>`
  ).join('');

  // LLM model attribution
  const isKeyword = !llmModel || llmModel === 'keyword_fallback' || llmModel === 'keyword';
  const llmDisplay = isKeyword
    ? { label: 'Keyword heuristic', color: '#f59e0b', title: 'LLM unavailable — classified by keyword matching' }
    : { label: llmModel, color: 'var(--text-muted)', title: 'Classified by LLM' };
  const llmBadge = `<span style="font-size:10px;color:${llmDisplay.color}" title="${llmDisplay.title}">
    ${isKeyword ? '⚠ ' : ''}LLM: ${llmDisplay.label}
  </span>`;

  // ── Key Figures panel (PS + LLM-classified only) ─────────────
  // Uses CSS variables throughout — safe on both light and dark themes.
  const keyFiguresHtml = (priceSensitive && isLLMClassified && hasKeyFigures)
    ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;padding:8px 10px;
                  background:var(--bg-secondary);border-radius:6px;
                  border:1px solid rgba(59,130,246,0.35)">
        <span style="font-size:10px;color:#3b82f6;font-weight:700;width:100%;margin-bottom:2px">
          📊 Key Figures
        </span>
        ${Object.entries(keyFigures).map(([k, v]) => `
          <span style="display:inline-flex;flex-direction:column;align-items:center;padding:4px 10px;
                       background:var(--bg-primary);border:1px solid rgba(59,130,246,0.25);
                       border-radius:6px;min-width:60px">
            <span style="font-size:9px;color:var(--text-muted);text-transform:uppercase;
                         letter-spacing:0.4px;white-space:nowrap">${k}</span>
            <span style="font-size:12px;font-weight:700;color:#3b82f6;white-space:nowrap">${v}</span>
          </span>`).join('')}
      </div>`
    : '';

  // ── PS + keyword warning (prompts user to configure LLM) ─────
  // Uses CSS variables — no hardcoded light colours.
  const psKeywordWarning = (priceSensitive && isKeyword)
    ? `<div style="font-size:11px;color:var(--text-secondary);
                  background:var(--bg-secondary);border:1px solid rgba(245,158,11,0.5);
                  border-radius:4px;padding:4px 8px;margin-bottom:6px">
        ⚠ Price-sensitive filing — configure an LLM in Settings for detailed analysis,
        or click <strong>Re-classify All</strong> if a model is already set.
      </div>`
    : '';

  // Summary text
  const summaryHtml = summary
    ? `<div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:6px">${summary}</div>`
    : '';

  // Search button
  const searchQuery = encodeURIComponent(`${ticker} ASX ${headline}`);
  const viewPdfBtn = headline
    ? `<a href="https://www.google.com/search?q=${searchQuery}" target="_blank" rel="noopener"
         class="btn btn-sm" style="font-size:11px;text-decoration:none">Search ↗</a>`
    : '';

  // Add to analysis button — escape for inline onclick
  const safeHeadline = headline.replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const safeSummary  = summary.replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const safeTicker   = ticker.replace(/'/g, "\\'");
  const safeDate     = date.replace(/'/g, "\\'");

  const addToAnalysisBtn = `<button class="btn btn-sm btn-primary" style="font-size:11px"
    onclick="addAnnToContext('${safeHeadline}','${safeSummary}','${safeTicker}','${safeDate}')">+ Add to Analysis</button>`;

  return `
    <div style="border:1px solid var(--border-light);border-left:3px solid ${borderColor};
                border-radius:var(--radius-md);padding:12px 14px;margin-bottom:10px;${cardBg}">
      <!-- Row 1: ticker, headline, date -->
      <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        ${tickerBadge}
        <span style="flex:1;font-size:13px;font-weight:600;color:var(--text-primary);line-height:1.4">${headline}</span>
        <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;flex-shrink:0">${_annFmtDate(date)}</span>
      </div>
      <!-- Row 2: type + sentiment + impact + PS badge -->
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px">
        ${typePill}
        ${sentiPill}
        ${impactBadge}
        ${psDot}
      </div>
      <!-- Row 3: PS keyword warning -->
      ${psKeywordWarning}
      <!-- Row 4: Key Figures grid (PS + LLM only) -->
      ${keyFiguresHtml}
      <!-- Row 5: summary -->
      ${summaryHtml}
      <!-- Row 6: tags -->
      ${tagBadges ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">${tagBadges}</div>` : ''}
      <!-- Row 7: actions + llm attribution -->
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:space-between">
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${viewPdfBtn}
          ${addToAnalysisBtn}
        </div>
        <div>${llmBadge}</div>
      </div>
    </div>`;
}

// ── LLM Settings panel HTML ───────────────────────────────────
function _annSettingsPanelHTML(status) {
  const cfg      = state.announcements.settings || {};
  const provider = cfg.ann_llm_provider || 'ollama';
  const model    = cfg.ann_llm_model    || 'qwen2.5:1.5b';
  const url      = cfg.ollama_url       || 'http://localhost:11434';
  const groqKey   = cfg.groq_api_key    || '';
  const groqModel = cfg.ann_groq_model  || 'llama-3.1-8b-instant';
  const gemKey    = cfg.gemini_api_key  || '';
  const gemModel  = cfg.gemini_model   || 'gemini-2.0-flash-lite';

  const inSt  = 'width:100%;box-sizing:border-box;font-size:13px;padding:5px 9px;border:1px solid var(--border-medium);border-radius:var(--radius-md);background:var(--bg-primary);color:var(--text-primary)';
  const lblSt = 'font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px';

  // Cached model list from the last fetch
  const cachedModels = state.announcements._ollamaModels || [];
  const modelIsCustom = cachedModels.length > 0 && !cachedModels.includes(model);

  // Build the model dropdown options
  let modelOpts = '';
  if (cachedModels.length) {
    modelOpts = cachedModels.map(m =>
      `<option value="${m}" ${m === model ? 'selected' : ''}>${m}</option>`
    ).join('');
    modelOpts += `<option value="__custom__" ${modelIsCustom ? 'selected' : ''}>Custom (type below)…</option>`;
  } else {
    // No models loaded yet — show current model as the only option + custom
    modelOpts  = `<option value="${model}" selected>${model}</option>`;
    modelOpts += `<option value="__custom__">Custom (type below)…</option>`;
  }

  const showCustomInput = modelIsCustom || cachedModels.length === 0;

  return `
    <div style="display:flex;flex-direction:column;gap:14px;max-width:560px">

      <!-- Provider row -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start">
        <div>
          <label style="${lblSt}">Provider</label>
          <select id="ann-provider" onchange="toggleAnnProviderFields()" style="${inSt}">
            <option value="ollama"  ${provider === 'ollama'  ? 'selected' : ''}>Ollama (local — free)</option>
            <option value="groq"    ${provider === 'groq'    ? 'selected' : ''}>Groq (cloud — free tier)</option>
            <option value="gemini"  ${provider === 'gemini'  ? 'selected' : ''}>Gemini (cloud — free tier)</option>
            <option value="keyword" ${provider === 'keyword' ? 'selected' : ''}>Keyword only (no LLM)</option>
          </select>
        </div>
        <div id="ann-ollama-url-wrap" style="display:${provider === 'ollama' ? 'block' : 'none'}">
          <label style="${lblSt}">Ollama server URL</label>
          <input type="text" id="ann-ollama-url" value="${url}" placeholder="http://localhost:11434"
            style="${inSt}" onchange="_maybeLoadOllamaModels(true)">
        </div>
      </div>

      <!-- Ollama model picker -->
      <div id="ann-ollama-fields" style="display:${provider === 'ollama' ? 'flex' : 'none'};flex-direction:column;gap:8px">
        <!-- Ollama status + start button -->
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap" id="ann-ollama-status-wrap">
          ${_annOllamaStatusHTML(state.announcements._ollamaAvailable || false)}
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <label style="font-size:12px;color:var(--text-secondary);margin:0">Model</label>
            <button class="btn btn-sm" onclick="_maybeLoadOllamaModels(true)"
              id="ann-refresh-models-btn"
              style="padding:1px 8px;font-size:11px" title="Reload model list from Ollama">
              ↺ Refresh
            </button>
            <span id="ann-ollama-models-status" style="font-size:11px;color:var(--text-muted)">
              ${cachedModels.length ? cachedModels.length + ' model' + (cachedModels.length > 1 ? 's' : '') + ' found' : 'click Refresh to detect'}
            </span>
          </div>
          <select id="ann-ollama-model-select" onchange="toggleAnnOllamaCustom()" style="${inSt}">
            ${modelOpts}
          </select>
        </div>
        <!-- Custom model text input, shown when "Custom" is selected or no models loaded -->
        <div id="ann-ollama-custom-wrap" style="display:${showCustomInput ? 'block' : 'none'}">
          <label style="${lblSt}">Custom model name <span style="color:var(--text-muted)">(e.g. qwen2.5:7b, llama3.2:3b)</span></label>
          <input type="text" id="ann-ollama-model-custom"
            value="${modelIsCustom ? model : (cachedModels.length ? '' : model)}"
            placeholder="model:tag" style="${inSt}">
        </div>
      </div>

      <!-- Groq fields -->
      <div id="ann-groq-fields" style="display:${provider === 'groq' ? 'flex' : 'none'};flex-direction:column;gap:8px">
        <div>
          <label style="${lblSt}">Groq API Key
            <a href="https://console.groq.com/keys" target="_blank" style="font-size:11px;color:var(--accent)">Get free key ↗</a>
          </label>
          <input type="password" id="ann-groq-key" value="${groqKey}" placeholder="gsk_…" style="${inSt}">
        </div>
        <div>
          <label style="${lblSt}">Groq Model</label>
          <select id="ann-groq-model" style="${inSt}" onchange="">
            <option value="">Loading…</option>
          </select>
        </div>
      </div>

      <!-- Gemini fields -->
      <div id="ann-gemini-fields" style="display:${provider === 'gemini' ? 'flex' : 'none'};flex-direction:column;gap:8px">
        <div>
          <label style="${lblSt}">Gemini API Key
            <a href="https://aistudio.google.com/apikey" target="_blank" style="font-size:11px;color:var(--accent)">Get free key ↗</a>
          </label>
          <input type="password" id="ann-gemini-key" value="${gemKey}" placeholder="AIza…" style="${inSt}">
        </div>
        <div>
          <label style="${lblSt}">Model <span style="font-size:10px;color:var(--text-muted)">(flash-lite has higher free-tier rate limits)</span></label>
          <select id="ann-gemini-model" style="${inSt}">
            ${[
              'gemini-2.0-flash-lite',
              'gemini-2.0-flash',
              'gemini-2.5-flash',
              'gemini-2.5-flash-lite',
              'gemini-3.1-flash-lite',
              'gemini-3.5-flash',
            ].map(m => `<option value="${m}" ${gemModel===m?'selected':''}>${m}</option>`).join('')}
          </select>
        </div>
      </div>

      <!-- Save row -->
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="saveAnnSettings()">💾 Save Settings</button>
        <span id="ann-settings-saved-msg" style="font-size:12px;color:#16a34a;display:none">✓ Saved</span>
      </div>

      <!-- Re-classify row -->
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--text-secondary);font-weight:600">Re-classify:</span>
        <select id="ann-reclassify-days-sel" onchange="state.announcements.reclassifyDays=parseInt(this.value)"
          title="Lookback window"
          style="font-size:12px;padding:2px 6px;border-radius:var(--radius-md);border:1px solid var(--border-light);background:var(--bg-secondary);color:var(--text-primary)">
          ${[1,7,14,30,90].map(d => `<option value="${d}" ${d===(state.announcements.reclassifyDays||30)?'selected':''}>${d}d</option>`).join('')}
        </select>
        <input type="text" id="ann-reclassify-ticker-inp"
          value="${state.announcements.reclassifyTicker||''}"
          placeholder="Ticker(s) or blank for all"
          oninput="state.announcements.reclassifyTicker=this.value"
          title="Comma-separated ASX codes to re-classify, or leave blank for all in the window"
          style="width:170px;font-size:12px;padding:2px 7px;border:1px solid var(--border-light);border-radius:var(--radius-md);background:var(--bg-secondary);color:var(--text-primary)">
        <button class="btn btn-sm" id="ann-reclassify-btn" onclick="reclassifyAnnouncements()"
          title="Re-run LLM classification on stored announcements using current settings">
          ↺ Re-classify
        </button>
      </div>

      <!-- Re-classify progress (hidden unless running) -->
      ${(() => {
        const rc  = state.announcements.reclassifyStatus || {};
        const vis = rc.running ? 'block' : 'none';
        const pct = rc.total > 0 ? Math.round((rc.done / rc.total) * 100) : 0;
        const lbl = rc.running
          ? `Re-classifying… ${rc.done || 0} of ${rc.total || 0} (${rc.updated || 0} updated)`
          : 'Re-classifying…';
        return `
      <div id="ann-reclassify-progress" style="display:${vis};margin-top:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span id="ann-reclassify-label" style="font-size:12px;color:var(--text-secondary)">${lbl}</span>
          <div style="display:flex;align-items:center;gap:8px">
            <span id="ann-reclassify-pct" style="font-size:11px;color:var(--text-muted)">${pct}%</span>
            <button id="ann-reclassify-stop-btn" onclick="stopReclassify()"
              class="btn btn-sm"
              style="font-size:11px;padding:1px 8px;color:#dc2626;border-color:#fca5a5"
              title="Stop after current announcement">⏹ Stop</button>
          </div>
        </div>
        <div style="height:6px;background:var(--border-light);border-radius:99px;overflow:hidden">
          <div id="ann-reclassify-bar"
               style="height:100%;width:${pct}%;background:linear-gradient(90deg,#6366f1,#3b82f6);
                      border-radius:99px;transition:width 0.4s ease"></div>
        </div>
      </div>`;
      })()}
    </div>`;
}

// ── Client-side filter ────────────────────────────────────────
function _annFilterItems(items) {
  const f = state.announcements.filter;
  let result = items.slice();

  if (f.ticker && f.ticker !== 'all') {
    result = result.filter(a => (a.ticker || '').toUpperCase() === f.ticker.toUpperCase());
  }
  if (f.type && f.type !== 'all') {
    result = result.filter(a => (a.type || '').toLowerCase() === f.type.toLowerCase());
  }
  if (f.sentiment && f.sentiment !== 'all') {
    result = result.filter(a => (a.sentiment || '').toLowerCase() === f.sentiment.toLowerCase());
  }
  if (f.search) {
    const q = f.search.toLowerCase();
    result = result.filter(a =>
      (a.headline || a.title || '').toLowerCase().includes(q) ||
      (a.summary || '').toLowerCase().includes(q) ||
      (a.ticker || '').toLowerCase().includes(q)
    );
  }

  return result;
}

// ── Update filter + re-render list only ──────────────────────
function setAnnFilter(key, value) {
  if (!state.announcements) return;
  state.announcements.filter[key] = value;

  // Re-render filter bar (ticker chips need updated active state)
  const filterBar = document.getElementById('ann-filter-bar');
  if (filterBar) filterBar.innerHTML = _renderAnnFilters(state.announcements.items);

  // Re-render card list only
  const list = document.getElementById('ann-card-list');
  if (!list) { renderPage(); return; }

  const items = _annFilterItems(state.announcements.items);
  list.innerHTML = items.length
    ? items.map(a => _renderAnnCard(a)).join('')
    : `<div class="empty-state" style="padding:50px 20px">
        <div class="empty-icon">◆</div>
        <p>No announcements match the current filters.</p>
      </div>`;
}

// ── Sync progress poller ──────────────────────────────────────
let _annSyncPoller = null;

function _startAnnSyncPoller() {
  if (_annSyncPoller) return; // already polling
  _annSyncPoller = setInterval(async () => {
    try {
      const s = await fetch(`${API}/api/announcements/status`).then(r => r.ok ? r.json() : null);
      if (!s) return;
      state.announcements.status = s;
      _updateAnnProgressBanner(s);
      if (!s.running) {
        _stopAnnSyncPoller();
        // Final refresh to show new data
        renderPage();
      }
    } catch { /* ignore transient errors */ }
  }, 2000);
}

function _stopAnnSyncPoller() {
  if (_annSyncPoller) { clearInterval(_annSyncPoller); _annSyncPoller = null; }
}

function _updateAnnProgressBanner(s) {
  const banner = document.getElementById('ann-sync-banner');
  if (!banner) return;
  if (!s.running) {
    banner.style.display = 'none';
    return;
  }
  const done  = s.tickers_done  || 0;
  const total = s.tickers_total || 1;
  const pct   = Math.round((done / total) * 100);
  const cur   = s.current_ticker || '…';
  const found = s.current_ticker_new || 0;

  banner.style.display = 'block';
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#1d4ed8">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3b82f6;animation:annPulse 1.2s ease-in-out infinite"></span>
        Scanning ASX announcements…
      </span>
      <span style="font-size:12px;color:var(--text-secondary)">
        Processing <strong>${cur}</strong> &nbsp;·&nbsp; ${done} of ${total} tickers
        ${found > 0 ? `&nbsp;·&nbsp; <span style="color:#16a34a;font-weight:600">+${found} new</span>` : ''}
      </span>
      <div style="flex:1;min-width:120px;max-width:240px;height:6px;background:var(--border-light);border-radius:99px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#3b82f6,#6366f1);border-radius:99px;transition:width 0.4s ease"></div>
      </div>
      <span style="font-size:11px;color:var(--text-muted)">${pct}%</span>
      <button class="btn btn-sm btn-danger" onclick="stopAnnSync()" style="margin-left:4px">■ Stop</button>
    </div>`;
}

// ── Sync button state helpers ─────────────────────────────────
function _setAnnSyncBtn(running) {
  const wrap = document.getElementById('ann-sync-btns');
  if (!wrap) return;
  if (running) {
    wrap.innerHTML = `<button class="btn btn-primary btn-sm" id="ann-sync-btn" disabled style="opacity:0.6;cursor:not-allowed">⟳ Scanning…</button>
      <button class="btn btn-sm btn-danger" onclick="stopAnnSync()">■ Stop</button>`;
  } else {
    wrap.innerHTML = `<button class="btn btn-primary btn-sm" id="ann-sync-btn" onclick="syncAnnouncements()">⟳ Sync Now</button>`;
  }
}

async function stopAnnSync() {
  try {
    const r = await fetch(`${API}/api/announcements/sync/stop`, { method: 'POST' });
    const d = await r.json();
    toast(d.ok ? 'Stop signal sent — finishing current ticker…' : `Error: ${d.error}`, d.ok ? 'info' : 'error');
  } catch (e) { toast('Could not reach server', 'error'); }
}

// ── Sync announcements from ASX ───────────────────────────────
async function syncAnnouncements() {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }

  // Check if already running
  const status = state.announcements.status || {};
  if (status.running) {
    toast('Sync already in progress', 'info');
    return;
  }

  const syncDays = parseInt(document.getElementById('ann-sync-days')?.value) || state.announcements.syncDays || 3;
  const syncTickerRaw = (document.getElementById('ann-scan-ticker')?.value ?? state.announcements.syncTicker ?? '').trim();
  let allTickers;
  if (syncTickerRaw) {
    allTickers = syncTickerRaw.split(/[\s,]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
  } else {
    const portfolioTickers = mergedPortfolio().map(h => h.ticker);
    const extraTickers     = state.analysisConfig?.extraTickers || [];
    allTickers = [...new Set([...portfolioTickers, ...extraTickers])];
  }

  if (!allTickers.length) {
    toast('No tickers specified — enter ticker codes or add holdings to portfolio', 'info');
    return;
  }

  try {
    const r = await fetch(`${API}/api/announcements/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tickers:  allTickers,
        settings: state.announcements.settings || {},
        days:     syncDays,
      }),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      toast(`Sync failed: ${err.error || r.statusText}`, 'error');
      return;
    }

    // Sync started on the backend — show progress UI immediately
    _setAnnSyncBtn(true);
    const banner = document.getElementById('ann-sync-banner');
    if (banner) {
      banner.style.display = 'block';
      banner.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#1d4ed8">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3b82f6;animation:annPulse 1.2s ease-in-out infinite"></span>
            Starting scan…
          </span>
          <span style="font-size:12px;color:var(--text-secondary)">
            <span style="color:#1d4ed8;font-weight:600">${allTickers.join(', ')}</span>
            &nbsp;·&nbsp; <strong>${allTickers.length} ticker${allTickers.length !== 1 ? 's' : ''}</strong>
            &nbsp;·&nbsp; <span style="color:#1d4ed8;font-weight:600">${syncDays}d</span> lookback
          </span>
        </div>`;
    }

    // Begin polling for progress
    _startAnnSyncPoller();

  } catch (e) {
    toast(`Sync request failed: ${e.message}`, 'error');
  }
}

// ── Add to analysis context ───────────────────────────────────
function addAnnToContext(headline, summary, ticker, date) {
  if (!state.analysisConfig) state.analysisConfig = { extraTickers: [], marketView: '', savedViews: [] };
  const snippet = `\n\n[${ticker} announcement ${date}] ${headline}: ${summary}`.trim();
  state.analysisConfig.marketView = (state.analysisConfig.marketView || '') + '\n\n' + snippet;
  scheduleSave();
  toast('Added to analysis context', 'success');
}

// ── Save LLM settings ─────────────────────────────────────────
async function saveAnnSettings() {
  // Read form values
  const provider     = document.getElementById('ann-provider')?.value || 'ollama';
  const modelSelect  = document.getElementById('ann-ollama-model-select');
  const customInput  = document.getElementById('ann-ollama-model-custom');
  const ollamaModel  = (modelSelect?.value === '__custom__' || !modelSelect?.value)
    ? (customInput?.value?.trim() || 'qwen2.5:1.5b')
    : (modelSelect?.value || 'qwen2.5:1.5b');
  const ollamaUrl   = document.getElementById('ann-ollama-url')?.value?.trim()   || 'http://localhost:11434';
  const groqKey     = document.getElementById('ann-groq-key')?.value?.trim()     || '';
  const groqModel   = document.getElementById('ann-groq-model')?.value?.trim()   || 'llama-3.1-8b-instant';
  const geminiKey   = document.getElementById('ann-gemini-key')?.value?.trim()   || '';
  const geminiModel = document.getElementById('ann-gemini-model')?.value?.trim() || 'gemini-2.0-flash-lite';

  // Use the SAME key names as state.announcements.settings and the backend DEFAULT_SETTINGS
  const payload = {
    ann_llm_provider: provider,
    ann_llm_model:    ollamaModel,
    ollama_url:       ollamaUrl,
    groq_api_key:     groqKey,
    ann_groq_model:   groqModel,
    gemini_api_key:   geminiKey,
    gemini_model:     geminiModel,
  };

  // Update in-memory state immediately so next sync picks it up
  state.announcements.settings = { ...state.announcements.settings, ...payload };

  // Show inline "Saved" confirmation
  const showSaved = () => {
    const msg = document.getElementById('ann-settings-saved-msg');
    if (msg) { msg.style.display = 'inline'; setTimeout(() => { msg.style.display = 'none'; }, 2500); }
  };

  if (!state.serverOk) {
    showSaved();
    toast('Settings saved locally (server offline)', 'info');
    return;
  }

  try {
    const r = await fetch(`${API}/api/announcements/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      toast(`Failed to save: ${err.error || r.statusText}`, 'error');
      return;
    }
    showSaved();
  } catch (e) {
    toast(`Could not save settings: ${e.message}`, 'error');
  }
}

// ── Re-classify stored announcements with current model ───────
let _reclassifyPoller = null;

async function reclassifyAnnouncements() {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  // Prevent running while news reclassify is active
  if (typeof _reclassifyPollTimer !== 'undefined' && _reclassifyPollTimer) {
    toast('News re-classify is running — wait for it to finish first', 'error'); return;
  }

  const btn      = document.getElementById('ann-reclassify-btn');
  const progress = document.getElementById('ann-reclassify-progress');

  const rcDays = parseInt(document.getElementById('ann-reclassify-days-sel')?.value) || state.announcements.reclassifyDays || 30;
  const rcTickerRaw = (document.getElementById('ann-reclassify-ticker-inp')?.value ?? state.announcements.reclassifyTicker ?? '').trim();
  const rcTickers = rcTickerRaw
    ? rcTickerRaw.split(/[\s,]+/).map(t => t.trim().toUpperCase()).filter(Boolean)
    : [];

  // First save current settings so the backend uses the latest model
  await saveAnnSettings();

  try {
    const r = await fetch(`${API}/api/announcements/reclassify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: state.announcements.settings || {},
        days:     rcDays,
        tickers:  rcTickers,
      }),
    });
    const data = await r.json().catch(() => ({}));

    if (r.status === 409) {
      toast('Re-classify already running', 'info');
      _startAnnReclassifyPoller(); // attach to already-running job
      return;
    }
    if (!r.ok) {
      toast(`Re-classify failed: ${data.error || r.statusText}`, 'error');
      return;
    }

    // Show progress UI and start polling
    const scopeLabel = rcTickers.length
      ? `${rcTickers.join(', ')} — ${rcDays}d`
      : `all tickers — ${rcDays}d`;
    toast(`Re-classify started (${scopeLabel})`, 'success');
    if (btn)      { btn.disabled = true; btn.style.opacity = '0.6'; }
    if (progress) { progress.style.display = 'block'; }
    _updateReclassifyBar(0, 0, 0);
    _startAnnReclassifyPoller();

  } catch (e) {
    toast(`Re-classify error: ${e.message}`, 'error');
  }
}

function _updateReclassifyBar(done, total, updated) {
  const pct      = total > 0 ? Math.round((done / total) * 100) : 0;
  const bar      = document.getElementById('ann-reclassify-bar');
  const pctEl    = document.getElementById('ann-reclassify-pct');
  const labelEl  = document.getElementById('ann-reclassify-label');
  if (bar)     bar.style.width     = pct + '%';
  if (pctEl)   pctEl.textContent   = pct + '%';
  if (labelEl) labelEl.textContent = total > 0
    ? `Re-classifying… ${done} of ${total} (${updated} updated)`
    : 'Re-classifying…';
}

function _startAnnReclassifyPoller() {
  if (_reclassifyPoller) return;
  _reclassifyPoller = setInterval(async () => {
    try {
      const s = await fetch(`${API}/api/announcements/reclassify-status`).then(r => r.ok ? r.json() : null);
      if (!s) return;

      _updateReclassifyBar(s.done || 0, s.total || 0, s.updated || 0);

      if (!s.running) {
        _stopAnnReclassifyPoller();
        const btn      = document.getElementById('ann-reclassify-btn');
        const progress = document.getElementById('ann-reclassify-progress');
        const labelEl  = document.getElementById('ann-reclassify-label');
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }

        const wasStopped = s.stopped;
        const finalPct   = (s.total > 0 && !wasStopped) ? s.total : (s.done || 0);
        _updateReclassifyBar(finalPct, s.total || finalPct, s.last_count || 0);
        if (labelEl) labelEl.textContent = wasStopped
          ? `Stopped at ${s.done || 0} of ${s.total || 0} (${s.last_count || 0} updated)`
          : `Complete — ${s.last_count || 0} of ${s.total || 0} updated`;

        setTimeout(() => {
          if (progress) progress.style.display = 'none';
        }, 2500);

        const msg = wasStopped
          ? `Stopped — ${s.last_count || 0} announcement${s.last_count !== 1 ? 's' : ''} updated before stop`
          : `Re-classify complete — ${s.last_count || 0} announcement${s.last_count !== 1 ? 's' : ''} updated`;
        toast(msg, wasStopped ? 'info' : 'success');
        // Only re-render if still on the announcements page to avoid triggering
        // stale poller restarts on other pages
        if (state.page === 'announcements') setTimeout(() => renderPage(), 500);
      }
    } catch { /* ignore transient errors */ }
  }, 1500);
}

function _stopAnnReclassifyPoller() {
  if (_reclassifyPoller) { clearInterval(_reclassifyPoller); _reclassifyPoller = null; }
}

async function stopReclassify() {
  const stopBtn = document.getElementById('ann-reclassify-stop-btn');
  if (stopBtn) { stopBtn.disabled = true; stopBtn.textContent = '⏹ Stopping…'; }
  try {
    await fetch(`${API}/api/announcements/reclassify-stop`, { method: 'POST' });
  } catch (e) {
    toast(`Stop request failed: ${e.message}`, 'error');
    if (stopBtn) { stopBtn.disabled = false; stopBtn.textContent = '⏹ Stop'; }
  }
}

// ── Toggle provider-specific form fields ──────────────────────
function toggleAnnProviderFields() {
  const provider  = document.getElementById('ann-provider')?.value || 'ollama';
  const ollamaEl  = document.getElementById('ann-ollama-fields');
  const urlWrapEl = document.getElementById('ann-ollama-url-wrap');
  const groqEl    = document.getElementById('ann-groq-fields');
  const geminiEl  = document.getElementById('ann-gemini-fields');
  if (ollamaEl)  ollamaEl.style.display  = provider === 'ollama' ? 'flex'  : 'none';
  if (urlWrapEl) urlWrapEl.style.display = provider === 'ollama' ? 'block' : 'none';
  if (groqEl)    groqEl.style.display    = provider === 'groq'   ? 'flex'  : 'none';
  if (geminiEl)  geminiEl.style.display  = provider === 'gemini' ? 'flex'  : 'none';
  if (provider === 'groq') {
    const savedModel = (state.announcements.settings || {}).ann_groq_model || 'llama-3.1-8b-instant';
    _loadGroqModels('ann-groq-model', savedModel);
  }
}

// ── Load Groq models from backend ────────────────────────────
async function _loadGroqModels(selectId, savedModel) {
  const el = document.getElementById(selectId);
  if (!el) return;
  try {
    const d = await fetch(`${API}/api/groq/models`).then(r => r.json());
    if (d.models && d.models.length) {
      el.innerHTML = d.models.map(m =>
        `<option value="${m}" ${m === savedModel ? 'selected' : ''}>${m}</option>`
      ).join('');
    } else {
      el.innerHTML = `<option value="${savedModel || 'llama-3.1-8b-instant'}" selected>${savedModel || 'llama-3.1-8b-instant'}</option>`;
    }
  } catch {
    el.innerHTML = `<option value="${savedModel || 'llama-3.1-8b-instant'}" selected>${savedModel || 'llama-3.1-8b-instant'}</option>`;
  }
}

// ── Show/hide custom model input ──────────────────────────────
function toggleAnnOllamaCustom() {
  const selectEl = document.getElementById('ann-ollama-model-select');
  const wrapEl   = document.getElementById('ann-ollama-custom-wrap');
  if (!selectEl || !wrapEl) return;
  wrapEl.style.display = selectEl.value === '__custom__' ? 'block' : 'none';
}

// ── Load Ollama models from backend proxy ─────────────────────
async function _maybeLoadOllamaModels(force = false) {
  if (!state.serverOk) return;
  if (!force && (state.announcements._ollamaModels || []).length > 0) return;

  const statusEl = document.getElementById('ann-ollama-models-status');
  const selectEl = document.getElementById('ann-ollama-model-select');
  if (statusEl) statusEl.textContent = 'Loading…';

  const ollamaUrl = document.getElementById('ann-ollama-url')?.value?.trim() || '';
  const params    = ollamaUrl ? `?url=${encodeURIComponent(ollamaUrl)}` : '';

  try {
    const d      = await fetch(`${API}/api/announcements/ollama-models${params}`).then(r => r.json());
    const models = d.models || [];
    state.announcements._ollamaModels   = models;
    state.announcements._ollamaAvailable = models.length > 0;

    // Update Ollama status badge if it's already in the DOM
    _updateAnnOllamaStatus(models.length > 0);

    if (statusEl) {
      statusEl.textContent = models.length
        ? `${models.length} model${models.length > 1 ? 's' : ''} found`
        : (d.error ? `Error: ${d.error}` : 'No models found — is Ollama running?');
    }

    // Repopulate the dropdown
    if (selectEl) {
      const currentModel  = state.announcements.settings?.ann_llm_model || 'qwen2.5:1.5b';
      const modelIsCustom = models.length > 0 && !models.includes(currentModel);
      let opts = models.map(m =>
        `<option value="${m}" ${m === currentModel ? 'selected' : ''}>${m}</option>`
      ).join('');
      opts += `<option value="__custom__" ${modelIsCustom ? 'selected' : ''}>Custom (type below)…</option>`;
      selectEl.innerHTML = opts;

      // Populate custom input if model isn't in the list
      const customInput = document.getElementById('ann-ollama-model-custom');
      if (customInput && modelIsCustom) customInput.value = currentModel;

      toggleAnnOllamaCustom();
    }
  } catch (e) {
    state.announcements._ollamaAvailable = false;
    _updateAnnOllamaStatus(false);
    if (statusEl) statusEl.textContent = 'Could not reach Ollama';
  }
}

// ── Update Ollama status badge in-place (avoids full re-render) ──
function _updateAnnOllamaStatus(available) {
  const wrap = document.getElementById('ann-ollama-status-wrap');
  if (!wrap) return;
  wrap.innerHTML = _annOllamaStatusHTML(available);
}

// ── Ollama status badge + start button HTML ───────────────────
function _annOllamaStatusHTML(available) {
  if (available) {
    return `<span class="badge" style="background:#dcfce7;color:#16a34a">✓ Ollama running</span>`;
  }
  return `
    <span class="badge" style="background:#fee2e2;color:#dc2626">✗ Ollama not found</span>
    <button class="btn btn-sm btn-primary" id="ann-ollama-start-btn"
      onclick="annStartOllama()" style="font-size:11px;padding:3px 10px">▶ Start Ollama</button>`;
}

// ── Start Ollama from Announcements tab ───────────────────────
async function annStartOllama() {
  const btn = document.getElementById('ann-ollama-start-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Starting…'; }
  try {
    const r = await fetch(`${API}/api/ollama/start`, { method: 'POST' });
    if (r.status === 404) {
      toast('Restart asx_server.py — new endpoint not yet loaded', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '▶ Start Ollama'; }
      return;
    }
    let d;
    try { d = await r.json(); } catch { d = { ok: false, error: `HTTP ${r.status}` }; }
    if (d.ok) {
      toast((d.message || 'Ollama starting') + ' — rechecking in 4s…', 'success');
      // Re-check after a short delay, then update the status badge + model list
      setTimeout(() => _maybeLoadOllamaModels(true), 4000);
    } else {
      toast(`Could not start Ollama: ${d.error}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '▶ Start Ollama'; }
    }
  } catch (e) {
    toast(`Flask server not reachable (${e.message})`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '▶ Start Ollama'; }
  }
}

