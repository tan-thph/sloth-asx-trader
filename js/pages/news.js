// ============================================================
// NEWS SCANNER PAGE
// Pipeline: RSS/Filings → Preprocess → Ollama LLM → SQLite
// ============================================================

// ── Hardware presets ──────────────────────────────────────────
const NEWS_LLM_PRESETS = [
  {
    label: 'Minimal',
    desc: '4–6 GB RAM',
    models: ['gemma3:1b', 'phi3:mini', 'qwen2:0.5b', 'llama3.2:1b'],
  },
  {
    label: 'Standard',
    desc: '8–12 GB RAM',
    models: ['gemma3:4b', 'phi3:3.8b', 'llama3.2:3b', 'mistral:7b-instruct-q4_0'],
  },
  {
    label: 'Performance',
    desc: '16–24 GB RAM',
    models: ['gemma3:12b', 'mistral:7b', 'llama3.1:8b', 'deepseek-r1:8b'],
  },
  {
    label: 'High-end',
    desc: '32 GB+ RAM',
    models: ['gemma3:27b', 'llama3.1:70b-instruct-q4_0', 'qwen2.5:32b'],
  },
];

// ── Category labels ────────────────────────────────────────────
const NEWS_CATS = {
  earnings: { label: 'Earnings', color: '#7c3aed' },
  regulatory: { label: 'Regulatory', color: '#dc2626' },
  macro: { label: 'Macro', color: '#2563eb' },
  sector: { label: 'Sector', color: '#0891b2' },
  dividend: { label: 'Dividend', color: '#16a34a' },
  analyst: { label: 'Analyst', color: '#d97706' },
  merger: { label: 'M&A', color: '#9333ea' },
  technical: { label: 'Technical', color: '#64748b' },
  other: { label: 'Other', color: '#6b7280' },
};

// ── Sentiment helpers ──────────────────────────────────────────
function _sentiColor(s) {
  return s === 'bullish' ? '#16a34a' : s === 'bearish' ? '#dc2626' : '#d97706';
}
function _sentiIcon(s) {
  return s === 'bullish' ? '▲' : s === 'bearish' ? '▼' : '●';
}
function _impactColor(v) {
  if (v >= 7.5) return '#dc2626';
  if (v >= 5.0) return '#d97706';
  if (v >= 2.5) return '#2563eb';
  return '#6b7280';
}
function _relativeTime(iso) {
  if (!iso) return '';
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60)   return 'just now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

// ── Main render ────────────────────────────────────────────────
async function renderNewsPage(gen) {
  const el = document.getElementById('main-content');

  // Show skeleton immediately
  el.innerHTML = _newsSkeletonHTML();

  if (!state.serverOk) {
    el.innerHTML = `<div class="card"><p class="text-muted">Backend server not running. Start <code>asx_server.py</code> first.</p></div>`;
    return;
  }

  // Fetch status + feed in parallel
  try {
    const [statusResp, feedResp, modelsResp, gpuResp] = await Promise.all([
      fetch(`${API}/api/news/status`).then(r => r.json()).catch(() => ({})),
      fetch(`${API}/api/news/feed?days=${state.news.settings.max_age_days || 7}&limit=100`)
        .then(r => r.json()).catch(() => ({ items: [], sentiment: {} })),
      fetch(`${API}/api/news/models`).then(r => r.json()).catch(() => ({ models: [], available: false })),
      fetch(`${API}/api/system/gpu`).then(r => r.json()).catch(() => ({ cuda: false })),
    ]);

    if (state._renderGen !== gen) return; // page changed mid-fetch

    state.news.status        = statusResp;
    state.news.items         = feedResp.items || [];
    state.news.models        = modelsResp.models || [];
    state.news.ollamaAvailable = modelsResp.available || false;
    state.news.gpuInfo       = gpuResp;
    state.news.lastFetch     = Date.now();

    // Merge settings from server
    if (statusResp.settings) {
      state.news.settings = { ...state.news.settings, ...statusResp.settings };
    }

    el.innerHTML = _newsPageHTML(statusResp, feedResp.sentiment || {});
    if (statusResp.running) _startNewsPoller(gen);
    // Restore reclassify poller if a job was already running before page render
    const rcStatus = await fetch(`${API}/api/news/reclassify/status`).then(r=>r.json()).catch(()=>({}));
    if (rcStatus.running) {
      const btn = document.getElementById('reclassify-btn');
      if (btn) { btn.disabled = true; btn.textContent = '⟳ Running…'; }
      _startNewsReclassifyPoller();
    } else if (rcStatus.done > 0) {
      _updateReclassifyProgress(rcStatus);
    }
  } catch (ex) {
    if (state._renderGen !== gen) return;
    el.innerHTML = `<div class="card"><p class="text-danger">Failed to load news scanner: ${ex.message}</p></div>`;
  }
}

function _newsSkeletonHTML() {
  return `
    <div class="card" style="margin-bottom:12px">
      <div style="height:16px;width:60%;background:var(--border-light);border-radius:4px;margin-bottom:8px"></div>
      <div style="height:10px;width:40%;background:var(--border-light);border-radius:4px"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div class="card" style="height:120px"></div>
      <div class="card" style="height:120px"></div>
    </div>
    <div class="card"><div style="height:200px"></div></div>`;
}

function _livePanelHTML(status) {
  if (!status || !status.running) return '';
  const phase = status.phase || status.progress || 'scraping';
  const phaseLabels = {
    scraping: '⬇ Scraping RSS feeds',
    storing: '◈ Storing & deduplicating',
    classifying: '◎ Classifying with LLM',
    done: '✓ Done',
  };
  const phaseLabel = phaseLabels[phase] || phase;

  if (phase !== 'classifying') {
    return `<div style="margin-top:8px;padding:7px 10px;background:var(--bg-secondary);border-radius:var(--radius-sm);font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:8px">
      <span>⟳</span> ${phaseLabel}…
    </div>`;
  }

  const total   = status.articles_to_classify || 0;
  const done    = status.articles_classified  || 0;
  const failed  = status.articles_failed      || 0;
  const pct     = total > 0 ? Math.round(done / total * 100) : 0;
  const tps     = status.tokens_per_sec || 0;
  const eta     = status.eta_secs != null ? status.eta_secs : null;
  const avg     = status.avg_secs_per_article || 0;
  const model   = status.llm_model || '';
  const article = status.current_article || '';
  const vram    = status.gpu_vram_mb;

  // Thinking models run an internal reasoning pass before streaming JSON —
  // the silent phase is normal, not a hang.
  const THINKING_MODELS = ['qwen3', 'qwq', 'deepseek-r1', 'deepseek-r2', 'marco-o1'];
  const isThinking = THINKING_MODELS.some(t => model.toLowerCase().includes(t));

  // current_article_start is an ISO string (UTC) — append Z if missing
  const artStart = status.current_article_start;
  const artStartMs = artStart ? new Date(artStart.includes('Z') || artStart.includes('+') ? artStart : artStart + 'Z').getTime() : null;
  const artAge   = artStartMs && !isNaN(artStartMs) ? Math.round((Date.now() - artStartMs) / 1000) : null;
  // Thinking models: allow up to 5 min silent (reasoning); non-thinking: 35 s
  const frozenThreshold = isThinking ? 300 : 35;
  const frozen   = artAge != null && artAge > frozenThreshold && tps < 0.5;

  const vramBadge = vram == null ? ''
    : vram === 0
      ? `<span style="font-size:10px;background:#fee2e2;color:#dc2626;padding:1px 5px;border-radius:3px" title="No GPU — inference may be very slow">CPU-only</span>`
      : `<span style="font-size:10px;background:#dcfce7;color:#16a34a;padding:1px 5px;border-radius:3px">GPU ${(vram/1024).toFixed(1)} GB VRAM</span>`;

  const etaStr = eta != null && eta > 5
    ? (eta < 60 ? `${eta}s` : `${Math.ceil(eta / 60)}m`)
    : '';

  // Token speed display — thinking models show "Reasoning…" during silent phase
  const tpsDisplay = tps > 0
    ? `<span style="font-size:11px;color:#3b82f6;font-weight:600">${tps} tok/s</span>`
    : isThinking && artAge != null && artAge > 5
      ? `<span style="font-size:11px;color:#7c3aed">◎ Reasoning… ${artAge}s</span>`
      : `<span style="font-size:11px;color:var(--text-muted)">waiting for tokens…</span>`;

  return `
    <div style="margin-top:8px;padding:8px 10px;background:var(--bg-secondary);border-radius:var(--radius-sm)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:5px">
        <span style="font-size:12px;font-weight:600">◎ Classifying</span>
        <span style="font-size:12px;color:var(--text-secondary)">${done} / ${total} articles</span>
        ${failed > 0 ? `<span style="font-size:10px;background:#fee2e2;color:#dc2626;padding:1px 5px;border-radius:3px" title="LLM returned invalid JSON — may recover; check model selection">${failed} failed</span>` : ''}
        ${model ? `<span style="font-size:11px;color:var(--text-muted)">${model}</span>` : ''}
        ${vramBadge}
        ${tpsDisplay}
        ${avg > 0 ? `<span style="font-size:11px;color:var(--text-muted)">${avg}s/article</span>` : ''}
        ${etaStr ? `<span style="font-size:11px;color:var(--text-muted)">ETA ${etaStr}</span>` : ''}
        ${frozen ? `<span style="font-size:11px;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:3px">⚠ Possible hang (${artAge}s)</span>` : ''}
      </div>
      <div style="height:5px;background:var(--border-light);border-radius:3px;overflow:hidden;margin-bottom:5px">
        <div style="width:${pct}%;height:100%;background:#3b82f6;border-radius:3px;transition:width 0.4s ease"></div>
      </div>
      ${article ? `<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${article.replace(/"/g,'&quot;')}">→ ${article}</div>` : ''}
    </div>`;
}

function _newsPageHTML(status, sentiment) {
  const available = status.available !== false;
  const running   = status.running;
  const lastScan  = status.last_scan;
  const nextScan  = status.next_scan;
  const totalArt  = status.total_articles || 0;
  const procArt   = status.processed_articles || 0;
  const ollamaOk  = state.news.ollamaAvailable;
  const cfg       = state.news.settings;
  const items     = _filteredNews();

  const progress  = status.progress || 'idle';
  const stages    = [
    { key: 'scraping',    label: 'Scraper',    icon: '⬇' },
    { key: 'classifying', label: 'LLM',        icon: '◎' },
    { key: 'idle',        label: 'Storage',    icon: '◈' },
  ];

  const pipelineBar = stages.map((s, i) => {
    const active = running && progress === s.key;
    const done   = (lastScan && !running) || (running && i < stages.findIndex(x => x.key === progress));
    const color  = active ? '#3b82f6' : done ? '#16a34a' : 'var(--text-tertiary)';
    return `
      <div style="display:flex;align-items:center;gap:4px">
        <span style="color:${color};font-size:15px">${active ? '⟳' : done ? '✓' : s.icon}</span>
        <span style="font-size:12px;color:${color};font-weight:${active?600:400}">${s.label}</span>
      </div>
      ${i < stages.length - 1 ? '<span style="color:var(--text-tertiary);font-size:10px">→</span>' : ''}`;
  }).join('');

  // Sentiment bar
  const bull = sentiment.bullish || 0;
  const bear = sentiment.bearish || 0;
  const neut = sentiment.neutral || 0;
  const total = bull + bear + neut || 1;
  const bullPct = Math.round(bull / total * 100);
  const bearPct = Math.round(bear / total * 100);
  const neutPct = 100 - bullPct - bearPct;
  const sentScore = (sentiment.avg_score || 0);
  const sentLabel = sentScore > 0.15 ? 'Risk-On' : sentScore < -0.15 ? 'Risk-Off' : 'Neutral';

  // Category breakdown
  const catMap = {};
  for (const item of state.news.items) {
    if (item.category) catMap[item.category] = (catMap[item.category] || 0) + 1;
  }
  const catBars = Object.entries(catMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([cat, cnt]) => {
      const info = NEWS_CATS[cat] || NEWS_CATS.other;
      const pct  = Math.round(cnt / state.news.items.length * 100);
      return `
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">
          <span style="font-size:11px;color:var(--text-secondary);width:70px">${info.label}</span>
          <div style="flex:1;height:7px;background:var(--border-light);border-radius:4px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${info.color};border-radius:4px"></div>
          </div>
          <span style="font-size:11px;color:var(--text-muted);width:26px;text-align:right">${cnt}</span>
        </div>`;
    }).join('');

  // Ollama status + model selector
  const modelOptions = state.news.models.length
    ? [
        ...(cfg.llm_model ? [] : [`<option value="" selected disabled>— select a model —</option>`]),
        ...state.news.models.map(m => `<option value="${m.name}" ${m.name === cfg.llm_model ? 'selected' : ''}>${m.name}${m.details?.parameter_size ? ' — ' + m.details.parameter_size : ''}</option>`),
      ].join('')
    : `<option value="${cfg.llm_model}" selected>${cfg.llm_model || '— select a model —'}</option>`;

  const presetButtons = NEWS_LLM_PRESETS.map(p => `
    <button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="newsSetPreset('${p.models[0]}')" title="${p.models.join(', ')}">${p.label}<br><span style="font-size:9px;color:var(--text-muted)">${p.desc}</span></button>`
  ).join('');

  // GPU / CPU badge
  const gpu = state.news.gpuInfo;
  const gpuBadge = gpu
    ? gpu.cuda
      ? `<span style="font-size:11px;background:#ede9fe;color:#6d28d9;padding:2px 7px;border-radius:4px;font-weight:600" title="CUDA detected — GPU acceleration active">◈ ${gpu.device || 'CUDA GPU'}</span>`
      : `<span style="font-size:11px;background:#f3f4f6;color:#6b7280;padding:2px 7px;border-radius:4px" title="No CUDA GPU detected — running on CPU">CPU only</span>`
    : '';

  const sbcHint = cfg.cpu_mode ? `
    <div style="font-size:11px;color:#92400e;background:#fef3c7;padding:5px 8px;border-radius:var(--radius-sm);margin-bottom:6px">
      ⚡ CPU mode${gpu && !gpu.cuda ? ' (no GPU detected)' : ''} — recommended models:
      <a href="#" onclick="newsSetPreset('gemma3:1b');return false" style="color:#92400e;font-weight:600">gemma3:1b</a> (Jetson / RPi 5),
      <a href="#" onclick="newsSetPreset('qwen2:0.5b');return false" style="color:#92400e;font-weight:600">qwen2:0.5b</a> (RPi 5 low-mem)
    </div>` : '';

  const ollamaStatusHtml = ollamaOk
    ? `<span class="badge" style="background:#dcfce7;color:#16a34a">✓ Ollama running</span>`
    : `<span class="badge" style="background:#fee2e2;color:#dc2626">✗ Ollama not found</span>
       <button class="btn btn-sm btn-primary" id="ollama-start-btn" onclick="newsStartOllama()" style="font-size:11px;padding:3px 10px">▶ Start Ollama</button>`;

  // Filter bar
  const cats = ['all', ...Object.keys(NEWS_CATS)];
  const f = state.news.filter;
  const catFilter = cats.map(c => `<option value="${c}" ${f.category === c ? 'selected' : ''}>${c === 'all' ? 'All categories' : (NEWS_CATS[c]?.label || c)}</option>`).join('');
  const portfolioTickers = [...new Set(state.portfolio.map(h => h.ticker))];
  const watchlistTickers = [...new Set((state.analysisConfig?.extraTickers || []).map(t => t.toUpperCase()))];
  const allTrackedTickers = [...new Set([...portfolioTickers, ...watchlistTickers])];
  const tickerFilter = ['all', ...allTrackedTickers].map(t => `<option value="${t}" ${f.ticker === t ? 'selected' : ''}>${t === 'all' ? 'All tickers' : t}</option>`).join('');
  const sentiFilter = [
    ['all', 'All sentiment'], ['bullish', '▲ Bullish'], ['bearish', '▼ Bearish'], ['neutral', '● Neutral'],
  ].map(([v, l]) => `<option value="${v}" ${f.sentiment === v ? 'selected' : ''}>${l}</option>`).join('');
  const sortFilter = [
    ['relevance', 'Sort: Relevance'],
    ['impact',    'Sort: Impact'],
    ['date',      'Sort: Newest'],
    ['sentiment_score', 'Sort: Sentiment'],
  ].map(([v, l]) => `<option value="${v}" ${f.sortBy === v ? 'selected' : ''}>${l}</option>`).join('');

  // News items
  const newsCards = items.length
    ? items.map(item => _newsCard(item, portfolioTickers, watchlistTickers)).join('')
    : `<div class="card" style="text-align:center;padding:40px;color:var(--text-muted)">
        ${state.news.items.length
          ? 'No articles match the current filters.'
          : `No articles yet. ${!available ? 'Install news scanner deps first.' : 'Click <strong>Scan Now</strong> to start.'}`}
       </div>`;

  return `
    <!-- Pipeline status bar -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${pipelineBar}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--text-muted)">${totalArt} articles · ${procArt} classified</span>
          <span style="font-size:11px;color:var(--text-muted)">Last: ${lastScan ? _relativeTime(lastScan) : 'never'}</span>
          ${nextScan && !running ? `<span style="font-size:11px;color:var(--text-muted)">Next: ${_relativeTime(nextScan).replace('ago','').trim() || 'soon'}</span>` : ''}
          ${running
            ? `<button class="btn btn-sm" disabled style="opacity:0.6">⟳ Scanning…</button>
               <button class="btn btn-sm btn-danger" onclick="newsScanStop()" title="Stop after current article">■ Stop</button>`
            : `<button class="btn btn-primary btn-sm" onclick="newsScanNow()">▶ Scan Now</button>`
          }
          <button class="btn btn-sm" onclick="newsRefreshPage()" title="Refresh page">⟳</button>
        </div>
      </div>
      ${!available ? `<div class="info-banner mt-2" style="margin-top:8px;font-size:12px">
        ⚠ News engine not available. Run: <code>pip install feedparser beautifulsoup4 scikit-learn</code>
      </div>` : ''}
      <div id="news-live-progress-wrap">${_livePanelHTML(status)}</div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <!-- Sentiment summary -->
      <div class="card">
        <div class="card-title">Market Sentiment <span class="text-xs text-muted">(last ${cfg.max_age_days || 7}d)</span></div>
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:8px">
          <span style="font-size:22px;font-weight:700;color:${sentScore > 0.1 ? '#16a34a' : sentScore < -0.1 ? '#dc2626' : '#d97706'}">${sentLabel}</span>
          <span style="font-size:12px;color:var(--text-muted)">${sentiment.total || 0} articles</span>
        </div>
        <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin-bottom:6px">
          <div style="width:${bullPct}%;background:#16a34a" title="Bullish: ${bull}"></div>
          <div style="width:${neutPct}%;background:#d97706" title="Neutral: ${neut}"></div>
          <div style="width:${bearPct}%;background:#dc2626" title="Bearish: ${bear}"></div>
        </div>
        <div style="display:flex;gap:12px;font-size:11px">
          <span style="color:#16a34a">▲ ${bull} bullish</span>
          <span style="color:#d97706">● ${neut} neutral</span>
          <span style="color:#dc2626">▼ ${bear} bearish</span>
        </div>
        ${catBars ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-light)">${catBars}</div>` : ''}
      </div>

      <!-- LLM configuration -->
      <div class="card">
        <div class="card-title">Local LLM <span class="text-xs text-muted">(via Ollama)</span></div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
          ${ollamaStatusHtml}
          ${gpuBadge}
          <span style="font-size:11px;color:var(--text-muted)">${cfg.ollama_url || 'http://localhost:11434'}</span>
        </div>
        ${ollamaOk ? `
          <div class="form-row" style="margin-bottom:8px">
            <div class="form-label">Model</div>
            <select onchange="newsSetModel(this.value)" style="width:100%">${modelOptions}</select>
          </div>
          ${sbcHint}
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">${presetButtons}</div>
        ` : `
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
            Install Ollama, then pull a model:
          </div>
          <pre class="code-block" style="font-size:11px;margin-bottom:6px"># Install: https://ollama.com/download
ollama pull gemma3:4b       # 8 GB RAM (recommended)
ollama pull gemma3:12b      # 16 GB RAM
ollama pull llama3.2:3b     # lightweight</pre>
        `}
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <div class="form-row" style="flex:1;margin:0">
            <div class="form-label" style="font-size:11px">Scan interval</div>
            <select onchange="newsSetInterval(this.value)" style="width:100%;font-size:12px">
              ${[3,6,12,24].map(h => `<option value="${h}" ${cfg.scan_interval_hours == h ? 'selected' : ''}>${h}h</option>`).join('')}
            </select>
          </div>
          <div class="form-row" style="flex:1;margin:0">
            <div class="form-label" style="font-size:11px">Keep articles</div>
            <select onchange="newsSetMaxAge(this.value)" style="width:100%;font-size:12px">
              ${[3,7,14,30].map(d => `<option value="${d}" ${cfg.max_age_days == d ? 'selected' : ''}>${d}d</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="margin-top:8px;display:flex;align-items:center;gap:8px">
          <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer">
            <input type="checkbox" ${cfg.enabled ? 'checked' : ''} onchange="newsToggleEnabled(this.checked)">
            Auto-scan enabled (${cfg.scan_interval_hours || 6}× per day)
          </label>
        </div>
        <div style="margin-top:6px;display:flex;align-items:center;gap:8px">
          <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer" title="Use CPU for inference — for Jetson Orin, Raspberry Pi 5, or machines without a GPU. Reduces context and batch size for manageable scan times.">
            <input type="checkbox" ${cfg.cpu_mode ? 'checked' : ''} onchange="newsToggleCpuMode(this.checked)">
            CPU mode <span style="color:var(--text-muted)">(SBC / no GPU)</span>
          </label>
          ${cfg.cpu_mode ? `<span style="font-size:10px;background:#fef9c3;color:#854d0e;padding:1px 6px;border-radius:3px">batch 20 · ctx 1024</span>` : ''}
        </div>

        <!-- Re-classify section -->
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-light)">
          <div style="font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Re-classify with different model</div>
          <p class="text-xs text-muted" style="margin-bottom:8px">Re-run LLM classification on all articles in the retention window. Useful for comparing model quality.</p>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <select id="reclassify-model" style="font-size:12px;padding:3px 6px;border-radius:var(--radius-sm);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary)">
              ${state.news.models.length
                ? state.news.models.map(m => `<option value="${m.name}">${m.name}${m.details?.parameter_size ? ' — '+m.details.parameter_size : ''}</option>`).join('')
                : `<option value="${cfg.llm_model}">${cfg.llm_model} (current)</option>`}
            </select>
            <select id="reclassify-days" style="font-size:12px;padding:3px 6px;border-radius:var(--radius-sm);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary)">
              ${[1,3,7,14].map(d => `<option value="${d}" ${d === (cfg.max_age_days||7) ? 'selected':''}>${d}d</option>`).join('')}
            </select>
            <button class="btn btn-sm btn-primary" id="reclassify-btn" onclick="newsReclassify()" style="font-size:11px">⟳ Re-classify</button>
          </div>
          <div id="reclassify-progress" style="margin-top:6px"></div>
        </div>
      </div>
    </div>

    <!-- News feed -->
    <div class="card">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <div class="card-title" style="margin:0">News Feed</div>
        <span style="font-size:11px;color:var(--text-muted)">${items.length} of ${state.news.items.length} articles</span>
        <div style="flex:1"></div>
        <input type="text" placeholder="Search…" value="${f.search || ''}"
          onchange="newsSetFilter('search',this.value)"
          style="width:130px;font-size:12px;padding:3px 7px;border:1px solid var(--border-light);border-radius:var(--radius-sm);background:var(--bg-secondary);color:var(--text-primary)">
        <select onchange="newsSetFilter('category',this.value)" style="font-size:12px">${catFilter}</select>
        <select onchange="newsSetFilter('ticker',this.value)" style="font-size:12px">${tickerFilter}</select>
        <select onchange="newsSetFilter('sentiment',this.value)" style="font-size:12px">${sentiFilter}</select>
        <select onchange="newsSetFilter('sortBy',this.value)" style="font-size:12px">${sortFilter}</select>
      </div>
      <div id="news-feed-list">${newsCards}</div>
    </div>`;
}

function _newsCard(item, portfolioTickers, watchlistTickers = []) {
  const processed   = item.processed === 1;
  const imp         = processed ? (item.impact_score || 0) : null;
  const senti       = processed ? (item.sentiment || 'neutral') : null;
  const catInfo     = NEWS_CATS[item.category] || NEWS_CATS.other;
  const primaryTickers  = item.primary_tickers || [];
  const allTickers      = item.tickers || [];
  // mentioned = tickers that are NOT primary (incidental references)
  const mentionedTickers = allTickers.filter(t => !primaryTickers.map(x=>x.toUpperCase()).includes(t.toUpperCase()));
  const tags             = item.tags || [];
  // Portfolio-relevant when a PRIMARY ticker is in portfolio; fall back to any ticker for old articles
  const isPortfolio = primaryTickers.length > 0
    ? primaryTickers.some(t => portfolioTickers.includes(t.toUpperCase()))
    : allTickers.some(t => portfolioTickers.includes(t.toUpperCase()));
  const isWatchlist = !isPortfolio && (
    primaryTickers.length > 0
      ? primaryTickers.some(t => watchlistTickers.includes(t.toUpperCase()))
      : allTickers.some(t => watchlistTickers.includes(t.toUpperCase()))
  );

  // Primary tickers: bold, coloured by portfolio membership
  const primaryBadges = primaryTickers.map(t => {
    const inPortfolio = portfolioTickers.includes(t.toUpperCase());
    return `<span title="Primary subject" style="font-size:10px;padding:1px 6px;border-radius:3px;font-weight:700;background:${inPortfolio ? '#dbeafe' : '#f0fdf4'};color:${inPortfolio ? '#1d4ed8' : '#15803d'};border:1px solid ${inPortfolio ? '#93c5fd' : '#86efac'}">${t}</span>`;
  }).join('');
  // Mentioned tickers: lighter, dimmer
  const mentionedBadges = mentionedTickers.map(t => {
    const inPortfolio = portfolioTickers.includes(t.toUpperCase());
    return `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:${inPortfolio ? '#eff6ff' : 'var(--bg-secondary)'};color:${inPortfolio ? '#3b82f6' : 'var(--text-muted)'}">${t}</span>`;
  }).join('');
  const tickerBadges = primaryBadges + mentionedBadges;

  const tagBadges = tags.slice(0, 4).map(tag =>
    `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:var(--bg-secondary);color:var(--text-muted)">#${tag}</span>`
  ).join('');

  const statusDot = processed
    ? `<span title="LLM classified (${item.llm_model || ''})" style="color:#16a34a;font-size:9px">●</span>`
    : `<span title="Pending classification" style="color:#d97706;font-size:9px">○</span>`;

  // Impact + sentiment column: only show real values for classified articles
  const impHtml = imp !== null
    ? `<div style="font-size:13px;font-weight:700;color:${_impactColor(imp)}">${imp.toFixed(1)}</div>
       <div style="font-size:13px;color:${_sentiColor(senti)}">${_sentiIcon(senti)}</div>`
    : `<div style="font-size:12px;color:var(--text-tertiary);line-height:2.2">—</div>`;

  const catBadge = processed
    ? `<span style="background:${catInfo.color}22;color:${catInfo.color};padding:1px 5px;border-radius:3px;font-size:10px">${catInfo.label}</span>`
    : '';
  const sentiBadge = senti
    ? `<span style="color:${_sentiColor(senti)}">${senti}</span>`
    : '';

  // Content preview: prefer LLM summary, else raw content snippet
  const contentHtml = item.summary
    ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:5px;line-height:1.4">${item.summary}</div>`
    : item.content
      ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:5px;line-height:1.4">${item.content.slice(0, 200)}${item.content.length > 200 ? '…' : ''}</div>`
      : '';

  return `
    <div style="border:1px solid var(--border-light);border-radius:var(--radius-md);padding:10px 12px;margin-bottom:8px;${isPortfolio ? 'border-left:3px solid #3b82f6' : isWatchlist ? 'border-left:3px solid #f59e0b' : ''}${!processed ? ';opacity:0.75' : ''}">
      <div style="display:flex;align-items:flex-start;gap:8px">
        <div style="text-align:center;min-width:38px">
          ${impHtml}
        </div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap">
            <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${item.title}</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-muted);flex-wrap:wrap;margin-bottom:5px">
            ${statusDot}
            <span>${item.source || '—'}</span>
            <span>·</span>
            <span>${_relativeTime(item.published_date)}</span>
            ${catBadge ? '<span>·</span>' + catBadge : ''}
            ${sentiBadge}
            ${isPortfolio ? '<span style="background:#dbeafe;color:#1d4ed8;padding:1px 5px;border-radius:3px;font-size:10px">★ Portfolio</span>' : ''}
            ${isWatchlist ? '<span style="background:#fef9c3;color:#92400e;padding:1px 5px;border-radius:3px;font-size:10px">◈ Watchlist</span>' : ''}
          </div>
          ${contentHtml}
          ${tickerBadges || tagBadges ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${tickerBadges}${tagBadges}</div>` : ''}
        </div>
        ${item.url ? `<a href="${item.url}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent);white-space:nowrap;flex-shrink:0" title="Open article">↗</a>` : ''}
      </div>
    </div>`;
}

// ── Filter + sort logic ────────────────────────────────────────
function _filteredNews() {
  const f = state.news.filter;
  let items = state.news.items.slice();

  if (f.category && f.category !== 'all') items = items.filter(i => i.category === f.category);
  if (f.sentiment && f.sentiment !== 'all') items = items.filter(i => i.sentiment === f.sentiment);
  if (f.ticker && f.ticker !== 'all') {
    const t = f.ticker.toUpperCase();
    items = items.filter(i =>
      (i.primary_tickers || []).map(x => x.toUpperCase()).includes(t) ||
      (i.tickers || []).map(x => x.toUpperCase()).includes(t)
    );
  }
  if (f.search) {
    const q = f.search.toLowerCase();
    items = items.filter(i =>
      (i.title || '').toLowerCase().includes(q) ||
      (i.summary || '').toLowerCase().includes(q) ||
      (i.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }

  if (f.sortBy === 'date') {
    items.sort((a, b) => (b.published_date || '').localeCompare(a.published_date || ''));
  } else if (f.sortBy === 'sentiment_score') {
    items.sort((a, b) => Math.abs(b.sentiment_score || 0) - Math.abs(a.sentiment_score || 0));
  } else if (f.sortBy === 'impact') {
    // Explicit impact sort: raw score only, highest first
    items.sort((a, b) => (b.impact_score || 0) - (a.impact_score || 0));
  } else {
    // 'relevance' default: impact weighted by recency decay
    items.sort((a, b) =>
      ((b.impact_score || 0) * (b.decay_weight || 0.5)) -
      ((a.impact_score || 0) * (a.decay_weight || 0.5))
    );
  }
  return items;
}

// ── Live polling during active scan ───────────────────────────
let _newsPollTimer = null;

function _startNewsPoller(gen) {
  if (_newsPollTimer) { clearInterval(_newsPollTimer); _newsPollTimer = null; }
  _newsPollTimer = setInterval(async () => {
    if (state._renderGen !== gen) {
      clearInterval(_newsPollTimer); _newsPollTimer = null;
      return;
    }
    try {
      const s = await fetch(`${API}/api/news/status`).then(r => r.json());
      _updateLiveProgress(s);
      if (!s.running) {
        clearInterval(_newsPollTimer); _newsPollTimer = null;
        setTimeout(() => { if (state._renderGen === gen) renderPage(); }, 1500);
      }
    } catch {}
  }, 2000);
}

function _updateLiveProgress(status) {
  const wrap = document.getElementById('news-live-progress-wrap');
  if (wrap) wrap.innerHTML = _livePanelHTML(status);
  const btn = document.querySelector('[onclick="newsScanNow()"]');
  if (btn) {
    btn.disabled = status.running;
    btn.textContent = status.running ? '⟳ Scanning…' : '▶ Scan Now';
  }
}

// ── Actions ────────────────────────────────────────────────────
function newsSetFilter(key, value) {
  state.news.filter[key] = value;
  const list = document.getElementById('news-feed-list');
  if (!list) return renderPage();
  const portfolioTickers = [...new Set(state.portfolio.map(h => h.ticker))];
  const watchlistTickers = [...new Set((state.analysisConfig?.extraTickers || []).map(t => t.toUpperCase()))];
  list.innerHTML = _filteredNews().map(i => _newsCard(i, portfolioTickers, watchlistTickers)).join('') ||
    `<div style="text-align:center;padding:30px;color:var(--text-muted)">No articles match the current filters.</div>`;
}

async function newsScanStop() {
  try {
    const r = await fetch(`${API}/api/news/scan/stop`, { method: 'POST' });
    const d = await r.json();
    toast(d.ok ? 'Stop signal sent — finishing current article…' : `Error: ${d.error}`, d.ok ? 'info' : 'error');
  } catch (e) { toast('Could not reach server', 'error'); }
}

async function newsReclassifyStop() {
  try {
    const r = await fetch(`${API}/api/news/reclassify/stop`, { method: 'POST' });
    const d = await r.json();
    toast(d.ok ? 'Stop signal sent — finishing current article…' : `Error: ${d.error}`, d.ok ? 'info' : 'error');
  } catch (e) { toast('Could not reach server', 'error'); }
}

async function newsScanNow() {
  if (!state.serverOk) { toast('Backend not running', 'error'); return; }
  toast('Starting news scan…', 'info');
  try {
    const tickers = [...new Set([
      ...state.portfolio.map(h => h.ticker),
      ...(state.analysisConfig?.extraTickers || []),
    ])];
    const r = await fetch(`${API}/api/news/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers }),
    });
    const d = await r.json();
    if (d.ok || d.message) {
      toast('Scan started — tracking live progress…', 'success');
      const btn = document.querySelector('[onclick="newsScanNow()"]');
      if (btn) { btn.disabled = true; btn.textContent = '⟳ Scanning…'; }
      _startNewsPoller(state._renderGen);
    } else {
      toast(d.error || 'Scan failed', 'error');
    }
  } catch (e) {
    toast('Scan request failed: ' + e.message, 'error');
  }
}

function newsRefreshPage() {
  renderPage();
}

let _reclassifyPollTimer = null;

async function newsReclassify() {
  // Prevent running while announcements reclassify is active
  if (typeof _reclassifyPoller !== 'undefined' && _reclassifyPoller) {
    toast('Announcements re-classify is running — wait for it to finish first', 'error'); return;
  }
  const modelEl = document.getElementById('reclassify-model');
  const daysEl  = document.getElementById('reclassify-days');
  const btn     = document.getElementById('reclassify-btn');
  const model   = modelEl?.value?.trim();
  const days    = parseInt(daysEl?.value || 7);
  if (!model) { toast('Select a model first', 'error'); return; }
  try {
    const r = await fetch(`${API}/api/news/reclassify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, days }),
    });
    if (r.status === 404) { toast('Restart asx_server.py — endpoint not loaded', 'error'); return; }
    const d = await r.json();
    if (!d.ok) { toast(`Error: ${d.error}`, 'error'); return; }
    toast(`${d.message}`, 'success');
    if (btn) { btn.disabled = true; btn.textContent = '⟳ Running…'; }
    _startNewsReclassifyPoller();
  } catch (e) {
    toast(`Failed: ${e.message}`, 'error');
  }
}

function _startNewsReclassifyPoller() {
  if (_reclassifyPollTimer) return; // already polling — don't spawn a second interval
  _reclassifyPollTimer = setInterval(async () => {
    try {
      const s = await fetch(`${API}/api/news/reclassify/status`).then(r => r.json());
      _updateReclassifyProgress(s);
      if (!s.running) {
        clearInterval(_reclassifyPollTimer);
        _reclassifyPollTimer = null;
        const btn = document.getElementById('reclassify-btn');
        if (btn) { btn.disabled = false; btn.textContent = '⟳ Re-classify'; }
        // Only re-render if still on the news page
        if (state.page === 'news') setTimeout(() => renderPage(), 1200);
      }
    } catch {}
  }, 2000);
}

function _updateReclassifyProgress(s) {
  const wrap = document.getElementById('reclassify-progress');
  if (!wrap) return;
  if (!s.running && !s.done) { wrap.innerHTML = ''; return; }
  const pct  = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
  const eta  = s.eta_secs > 5 ? (s.eta_secs < 60 ? `${s.eta_secs}s` : `${Math.ceil(s.eta_secs/60)}m`) : '';
  const col  = s.error ? '#dc2626' : s.running ? '#3b82f6' : '#16a34a';
  wrap.innerHTML = `
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span style="color:${col};font-weight:600">${s.running ? '◎ Classifying' : s.error ? '✗ Stopped' : '✓ Done'}</span>
      <span>${s.done} / ${s.total} articles</span>
      ${s.failed > 0 ? `<span style="color:#dc2626">${s.failed} failed</span>` : ''}
      ${s.tokens_per_sec > 0 ? `<span style="color:#3b82f6">${s.tokens_per_sec} tok/s</span>` : ''}
      ${eta ? `<span>ETA ${eta}</span>` : ''}
      ${s.model ? `<span class="text-muted">${s.model}</span>` : ''}
      ${s.running ? `<button class="btn btn-sm btn-danger" onclick="newsReclassifyStop()" style="font-size:10px;padding:2px 8px;margin-left:4px">■ Stop</button>` : ''}
    </div>
    <div style="height:4px;background:var(--border-light);border-radius:2px;overflow:hidden;margin-bottom:3px">
      <div style="width:${pct}%;height:100%;background:${col};border-radius:2px;transition:width 0.4s"></div>
    </div>
    ${s.current_article ? `<div style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">→ ${s.current_article}</div>` : ''}
    ${s.error ? `<div style="font-size:11px;color:#dc2626;margin-top:3px">${s.error}</div>` : ''}`;
}

async function newsStartOllama() {
  const btn = document.getElementById('ollama-start-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Starting…'; }
  try {
    const r = await fetch(`${API}/api/ollama/start`, { method: 'POST' });
    // If Flask returns 404 HTML (endpoint not yet registered — server needs restart)
    if (r.status === 404) {
      toast('Restart asx_server.py — new endpoint not yet loaded', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '▶ Start Ollama'; }
      return;
    }
    let d;
    try { d = await r.json(); } catch { d = { ok: false, error: `HTTP ${r.status}` }; }
    if (d.ok) {
      toast((d.message || 'Ollama starting') + ' — rechecking in 4s…', 'success');
      setTimeout(() => renderPage(), 4000);
    } else {
      toast(`Could not start Ollama: ${d.error}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '▶ Start Ollama'; }
    }
  } catch (e) {
    toast(`Flask server not reachable (${e.message})`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '▶ Start Ollama'; }
  }
}

async function newsSetModel(model) {
  state.news.settings.llm_model = model;
  await _saveNewsSettings();
  toast(`LLM model set to ${model}`, 'success');
}

async function newsSetPreset(model) {
  state.news.settings.llm_model = model;
  await _saveNewsSettings();
  toast(`Preset applied: ${model}`, 'success');
  renderPage();
}

async function newsSetInterval(hours) {
  state.news.settings.scan_interval_hours = Number(hours);
  await _saveNewsSettings();
  toast(`Scan interval set to ${hours}h`, 'success');
}

async function newsSetMaxAge(days) {
  state.news.settings.max_age_days = Number(days);
  await _saveNewsSettings();
  toast(`Article retention set to ${days} days`, 'success');
}

async function newsToggleEnabled(enabled) {
  state.news.settings.enabled = enabled;
  await _saveNewsSettings();
  toast(`News scanner ${enabled ? 'enabled' : 'disabled'}`, 'success');
}

async function newsToggleCpuMode(enabled) {
  state.news.settings.cpu_mode = enabled;
  await _saveNewsSettings();
  toast(enabled ? 'CPU mode on — batch 20, ctx 1024 (SBC-friendly)' : 'GPU mode on — batch 100, ctx 2048', 'success');
  renderPage();
}

async function _saveNewsSettings() {
  if (!state.serverOk) return;
  try {
    await fetch(`${API}/api/news/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.news.settings),
    });
  } catch {}
}
