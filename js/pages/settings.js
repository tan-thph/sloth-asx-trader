// ============================================================
// SETTINGS
// ============================================================
function renderSettings() {
  const key=getApiKey();
  return `
    <div class="grid-2">
      <div class="card">
        <div class="card-title">API Keys</div>
        <div class="form-row">
          <div class="form-label">Anthropic API Key</div>
          <input type="password" id="api-key-input" value="${key}" placeholder="sk-ant-...">
          <div class="text-xs text-muted mt-1">Required for AI analysis. Stored in localStorage only (never sent to server).</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="saveApiKey()">Save Anthropic Key</button>

        <div style="margin-top:14px;padding-top:12px;border-top:0.5px solid var(--border-light)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <div class="form-label" style="margin:0">Groq API Key</div>
            ${state.news.settings.groq_api_key
              ? '<span style="font-size:10px;background:#dcfce7;color:#16a34a;padding:1px 7px;border-radius:9px">&#10003; Key saved</span>'
              : '<span style="font-size:10px;background:#fef9c3;color:#92400e;padding:1px 7px;border-radius:9px">No key set</span>'}
          </div>
          <div style="display:flex;gap:6px">
            <input type="password" id="settings-groq-key" value="${state.news.settings.groq_api_key || ''}" placeholder="gsk_…" style="flex:1">
            <button class="btn btn-sm btn-primary" onclick="settingsSaveGroqKey()">Save</button>
          </div>
          <div class="text-xs text-muted mt-1">Used by News Scanner and Learning Loop debate. Free tier at <strong>console.groq.com</strong></div>
        </div>

        <div style="margin-top:12px;padding-top:12px;border-top:0.5px solid var(--border-light)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <div class="form-label" style="margin:0">Google Gemini API Key</div>
            ${state.news.settings.google_api_key
              ? '<span style="font-size:10px;background:#dcfce7;color:#16a34a;padding:1px 7px;border-radius:9px">&#10003; Key saved</span>'
              : '<span style="font-size:10px;background:#fef9c3;color:#92400e;padding:1px 7px;border-radius:9px">No key set</span>'}
          </div>
          <div style="display:flex;gap:6px">
            <input type="password" id="settings-google-key" value="${state.news.settings.google_api_key || ''}" placeholder="AIza…" style="flex:1">
            <button class="btn btn-sm btn-primary" onclick="settingsSaveGoogleKey()">Save</button>
          </div>
          <div class="text-xs text-muted mt-1">Used by News Scanner and Learning Loop debate. Free at <strong>aistudio.google.com/apikey</strong></div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Trading Parameters</div>
        ${[['Brokerage per trade ($)','brokerage','number'],['Min trade size ($)','minTradeSize','number'],['Max trades per day','maxTradesPerDay','number'],['Max position size (%)','maxPositionPct','number'],['API cost per run ($)','apiCostPerRun','number']].map(([l,k,t])=>`
          <div class="form-row">
            <div class="form-label">${l}</div>
            <input type="${t}" value="${state.settings[k]}" onchange="updateSetting('${k}',this.value)">
          </div>`).join('')}
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-title">Backend Server (yfinance)</div>
        <div class="form-row">
          <div class="form-label">Server URL</div>
          <input type="text" value="${state.settings.serverUrl||'http://localhost:5000'}" onchange="updateSetting('serverUrl',this.value)">
        </div>
        <div class="flex-row mt-1">
          <button class="btn btn-sm" onclick="checkServer().then(renderPage)">Test Connection</button>
          <span class="text-xs ${state.serverOk?'text-success':'text-danger'}">${state.serverOk?'✓ Connected':'✗ Not connected'}</span>
        </div>
        <div class="flex-row mt-1">
          <button class="btn btn-sm btn-primary" onclick="saveStateToDb().then(()=>toast('Saved to database','success'))">💾 Save Now</button>
          <button class="btn btn-sm" onclick="loadStateFromDb().then(ok=>{if(ok){toast('Loaded from database','success');renderPage();}else toast('No saved data found','info');})">↩ Load from DB</button>
        </div>
        <div class="mt-2">
          <div class="card-title" style="margin-bottom:6px">Setup Instructions</div>
          <pre class="code-block">pip install yfinance flask flask-cors pandas numpy
python3 asx_server.py</pre>
          <div class="text-xs text-muted mt-1">Run in same folder as this HTML file. Requires internet access for yfinance.</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Capital Mode</div>
        <div class="form-row">
          <div class="form-label">Trading capital mode</div>
          <select onchange="updateSetting('capitalMode',this.value)">
            <option value="full" ${state.settings.capitalMode==='full'?'selected':''}>Trade full capital</option>
            <option value="partial" ${state.settings.capitalMode==='partial'?'selected':''}>Trade partial capital (risk-based)</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-label">Risk capital % per trade</div>
          <input type="number" value="${state.settings.riskCapitalPct}" onchange="updateSetting('riskCapitalPct',this.value)">
        </div>
        <div class="form-row">
          <div class="form-label">Cash balance ($)</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="number" value="${state.cash}" onchange="state.cash=Number(this.value);pushCashToDb(state.cash);scheduleSave()" style="flex:1">
            <button class="btn btn-sm" onclick="fetchCashFromDb().then(renderPage)" title="Sync cash from database">⟳ Sync</button>
          </div>
          <div class="text-xs text-muted mt-1">Updated automatically when trades are executed. Click ⟳ to sync from DB.</div>
        </div>
        <div class="form-row">
          <div class="form-label">RBA Cash Rate</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="number" value="${state.rbaRate}" step="0.01" onchange="state.rbaRate=Number(this.value)" style="flex:1">
            <button class="btn btn-sm" onclick="fetchRbaRate().then(renderPage)" title="Fetch live RBA rate">⟳ Live</button>
          </div>
          <div class="text-xs text-muted mt-1">
            ${state.rbaRateSource === 'live-rba' ? `<span class="text-success">✓ Live from RBA.gov.au</span>` : state.rbaRateSource === 'cached' ? `<span class="text-warn">Cached (${state.rbaRateDate||'?'})</span>` : `<span class="text-muted">Fallback default — click ⟳ Live to fetch</span>`}
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Telegram Alerts</div>
      <p class="text-xs text-muted mb-2">
        Receive price and stop/target alerts on your phone via Telegram.
        Create a bot at <strong>@BotFather</strong>, then run <code>/start</code> in the chat to get your Chat ID.
      </p>
      <div class="grid-2" style="gap:12px">
        <div class="form-row">
          <div class="form-label">Bot Token</div>
          <input type="password" id="tg-token-input" placeholder="1234567890:ABCdef..."
            value="${state.settings.tgToken || ''}">
        </div>
        <div class="form-row">
          <div class="form-label">Chat ID</div>
          <input type="text" id="tg-chat-input" placeholder="-100123456789 or @username"
            value="${state.settings.tgChatId || ''}">
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap">
        <button class="btn btn-sm btn-primary" onclick="saveTelegramConfig()">Save</button>
        <button class="btn btn-sm" onclick="testTelegramAlert()">Test Alert</button>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
          <input type="checkbox" ${state.settings.telegramEnabled ? 'checked' : ''}
            onchange="updateSetting('telegramEnabled', this.checked);scheduleSave()">
          Enable Telegram alerts
        </label>
        <span id="tg-status" class="text-xs text-muted"></span>
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:0.5px solid var(--border-light)">
        <div class="form-label" style="margin-bottom:6px">Stop proximity pre-warning (%)</div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="number" min="0" max="20" step="0.5"
            value="${state.settings.stopProximityPct ?? 3}"
            onchange="updateSetting('stopProximityPct', parseFloat(this.value))"
            style="width:80px;padding:5px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:13px">
          <span class="text-xs text-muted">% from stop · 0 = disabled</span>
        </div>
        <div class="text-xs text-muted mt-1">
          Fires an alert when a held position's price comes within this % of its stop loss —
          giving you time to act before the stop is breached. Direction-aware (BUY and SELL recs).
        </div>
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:0.5px solid var(--border-light)">
        <div class="form-label" style="margin-bottom:6px">Correlation block threshold (0–1, default 0.85)</div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="number" min="0.5" max="1.0" step="0.01"
            value="${state.settings.corrBlockThreshold ?? 0.85}"
            onchange="updateSetting('corrBlockThreshold', parseFloat(this.value)); scheduleSave()"
            style="width:80px;padding:5px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:13px">
          <span class="text-xs text-muted">|ρ| threshold · hard-blocks BUY recs above this</span>
        </div>
        <div class="text-xs text-muted mt-1">
          BUY recs with |ρ| above this vs any existing holding are hard-blocked (not sized down).
          Soft gate fires 10pp below (e.g. −30% size at 0.75 when threshold is 0.85).
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Auto-Analysis Scheduler</div>
      <div class="grid-2" style="gap:16px;margin-bottom:1rem">
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
            <div>
              <div class="form-label" style="margin-bottom:2px">Enable auto-scheduler</div>
              <div class="text-xs text-muted">Runs analysis automatically during ASX hours (Sydney time)</div>
            </div>
            <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0;cursor:pointer">
              <input type="checkbox" id="sched-toggle" ${state.settings.scheduleEnabled?'checked':''} onchange="toggleScheduler(this.checked)" style="opacity:0;width:100%;height:100%;position:absolute;top:0;left:0;cursor:pointer">
              <span id="sched-knob" style="position:absolute;inset:0;border-radius:12px;background:${state.settings.scheduleEnabled?'#16a34a':'var(--border-medium)'};transition:background 0.2s">
                <span id="sched-knob-ball" style="position:absolute;top:3px;left:${state.settings.scheduleEnabled?'23px':'3px'};width:18px;height:18px;border-radius:50%;background:#fff;transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.2)"></span>
              </span>
            </label>
          </div>

          <div class="form-row">
            <div class="form-label">Run interval</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
              ${[15,30,60,90,120].map(m=>`<button class="btn btn-sm ${state.settings.scheduleIntervalMins===m?'btn-primary':''}" onclick="updateSchedSetting('scheduleIntervalMins',${m});applyScheduler();renderPage()" title="Every ${m} minutes">${m<60?m+'m':(m/60)+'h'}</button>`).join('')}
              <span class="text-xs text-muted" style="padding:0 2px">or</span>
              <div style="display:flex;align-items:center;gap:4px">
                <input
                  type="number" min="1" max="480" step="1"
                  value="${![15,30,60,90,120].includes(state.settings.scheduleIntervalMins) ? state.settings.scheduleIntervalMins : ''}"
                  placeholder="custom"
                  title="Custom interval in minutes (1–480)"
                  oninput="setCustomInterval(this)"
                  style="width:72px;padding:4px 8px;border-radius:var(--radius-md);border:0.5px solid ${![15,30,60,90,120].includes(state.settings.scheduleIntervalMins)?'var(--accent)':'var(--border-medium)'};background:var(--bg-primary);color:var(--text-primary);font-size:12px;text-align:center">
                <span class="text-xs text-muted">min</span>
              </div>
            </div>
            <div class="text-xs text-muted" style="margin-top:4px">
              Currently: every <strong>${state.settings.scheduleIntervalMins} minute${state.settings.scheduleIntervalMins!==1?'s':''}</strong>
              ${![15,30,60,90,120].includes(state.settings.scheduleIntervalMins)?'<span style="margin-left:4px;padding:1px 6px;border-radius:8px;background:var(--accent);color:#fff;font-size:10px">custom</span>':''}
            </div>
          </div>

          <div class="grid-2" style="gap:10px">
            <div class="form-row">
              <div class="form-label">Window start (Sydney)</div>
              <input type="time" value="${state.settings.scheduleWindowStart}" onchange="updateSchedSetting('scheduleWindowStart',this.value);applyScheduler()">
            </div>
            <div class="form-row">
              <div class="form-label">Window end (Sydney)</div>
              <input type="time" value="${state.settings.scheduleWindowEnd}" onchange="updateSchedSetting('scheduleWindowEnd',this.value);applyScheduler()">
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:10px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
              <input type="checkbox" ${state.settings.scheduleWeekdaysOnly?'checked':''} onchange="updateSchedSetting('scheduleWeekdaysOnly',this.checked);applyScheduler()" style="width:14px;height:14px">
              Weekdays only (Mon–Fri)
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
              <input type="checkbox" ${state.settings.scheduleRunOnOpen?'checked':''} onchange="updateSchedSetting('scheduleRunOnOpen',this.checked)" style="width:14px;height:14px">
              Run immediately on app open (if in window)
            </label>
          </div>
        </div>

        <div>
          <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:14px;margin-bottom:12px">
            <div class="form-label" style="margin-bottom:8px">Scheduler status</div>
            <div id="sched-status" style="font-size:13px;margin-bottom:10px"></div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.7">
              ${(()=>{
                const s=state.settings;
                const start=s.scheduleWindowStart||'10:00', end=s.scheduleWindowEnd||'15:45';
                const intv=s.scheduleIntervalMins||60;
                const startMins=timeToMins(start), endMins=timeToMins(end);
                const slots=[];
                for(let t=startMins; t<endMins; t+=intv) slots.push(t);
                slots.push(endMins);
                const slotLabels=slots.map(m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`);
                return `Scheduled runs: <strong>${slotLabels.join(', ')}</strong><br>
                        <span style="color:#16a34a">✓ ${end} guaranteed as final run regardless of interval</span><br>
                        ${s.scheduleWeekdaysOnly?'Mon–Fri only':'Every day incl. weekends'} · clock-based (not timer-based)`;
              })()}
            </div>
          </div>
          <div class="form-label" style="margin-bottom:6px">Activity log</div>
          <div id="sched-log" style="border:0.5px solid var(--border-light);border-radius:var(--radius-md);padding:4px 8px"></div>
          <div class="text-xs text-muted" style="margin-top:4px">Records kept for 5 days maximum</div>
          <button class="btn btn-sm mt-1" onclick="schedulerTick()">▶ Run now (manual)</button>
        </div>
      </div>

      <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 14px">
        <div class="form-label" style="margin-bottom:6px">Recommended ASX schedule</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${[
            {label:'Open burst',  start:'10:00', end:'11:30', intv:30,  tip:'3-4 runs at open'},
            {label:'Midday scan', start:'11:00', end:'14:00', intv:60,  tip:'3 runs through lunch'},
            {label:'Full day',    start:'10:00', end:'15:45', intv:60,  tip:'6 runs (default)'},
            {label:'Pre-close',   start:'14:00', end:'15:45', intv:30,  tip:'3 runs before close'},
          ].map(p=>`<button class="btn btn-sm" title="${p.tip}" onclick="applySchedulePreset('${p.start}','${p.end}',${p.intv})">${p.label}</button>`).join('')}
        </div>
      </div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div class="card-title" style="margin:0">Recent AI Calls</div>
        <div style="display:flex;gap:6px;align-items:center">
          <select id="ai-log-filter" onchange="loadAICallLog()" style="font-size:11px;padding:2px 6px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary)">
            <option value="">All agents</option>
            <option value="portfolio">portfolio</option>
            <option value="analyst">analyst</option>
            <option value="pm">pm</option>
            <option value="dayTrade">dayTrade</option>
            <option value="universe">universe</option>
            <option value="macro">macro</option>
            <option value="assistant">assistant</option>
            <option value="briefing">briefing</option>
          </select>
          <button class="btn btn-sm" onclick="loadAICallLog()">&#8635; Refresh</button>
        </div>
      </div>
      <div class="text-xs text-muted" style="margin-bottom:8px">
        Every Claude call is logged here — system prompt, user message, response, tokens, and timing.
        Calls are stored in <code>ai_call_log</code> and written to <code>ai_responses/</code> files.
      </div>
      <div id="ai-spend-summary"></div>
      <div id="ai-call-log-container">
        <div class="text-xs text-muted" style="padding:10px 0">Loading…</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Display</div>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0">
        <div>
          <div style="font-size:13px;font-weight:600">Compact mode</div>
          <div class="text-xs text-muted">Reduces card padding and table row heights for more content on screen</div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" ${state.settings.compactMode ? 'checked' : ''}
            onchange="settingsToggleCompact(this.checked)">
          <span style="font-size:12px;color:${state.settings.compactMode ? 'var(--accent)' : 'var(--text-muted)'}">
            ${state.settings.compactMode ? 'On' : 'Off'}
          </span>
        </label>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-top:0.5px solid var(--border-light)">
        <div>
          <div style="font-size:13px;font-weight:600">Use local LLM for analysis <span style="font-size:10px;color:var(--text-muted);font-weight:400">(Ollama)</span></div>
          <div class="text-xs text-muted">Routes portfolio analysis through local Ollama instead of Claude API. BUY/HOLD only — free, offline, slower. Requires Ollama running with a model pulled.</div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="settings-local-llm" ${state.settings.useLocalLLM ? 'checked' : ''}
            onchange="settingsToggleLocalLLM(this.checked)">
          <span id="settings-local-llm-label" style="font-size:12px;color:${state.settings.useLocalLLM ? '#d97706' : 'var(--text-muted)'}">
            ${state.settings.useLocalLLM ? 'Local' : 'Off'}
          </span>
        </label>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-top:0.5px solid var(--border-light)">
        <div>
          <div style="font-size:13px;font-weight:600">Auto-brief time <span style="font-size:10px;color:var(--text-muted);font-weight:400">(AEST)</span></div>
          <div class="text-xs text-muted">Morning briefing fires once per day on first load at or after this time. Leave blank to disable.</div>
        </div>
        <input type="time" value="${state.settings.autoBriefTime || ''}"
          style="padding:4px 8px;border-radius:6px;border:1px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:13px"
          onchange="updateSetting('autoBriefTime', this.value); scheduleSave()">
      </div>
    </div>

    <div class="card">
      <div class="card-title">App Info</div>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:12px;align-items:baseline">
        <span class="text-muted">Prompt version</span>
        <span style="font-family:monospace;color:var(--accent)">${typeof PROMPT_VERSION !== 'undefined' ? PROMPT_VERSION : '—'}</span>
        <span class="text-muted">Claude model</span>
        <span style="font-family:monospace">${typeof CLAUDE_MODEL !== 'undefined' ? CLAUDE_MODEL : '—'}</span>
        <span class="text-muted">Server</span>
        <span id="settings-server-ver" class="text-muted">checking…</span>
        <span class="text-muted">DB backups</span>
        <span id="settings-backup-info" class="text-muted">checking…</span>
        <span class="text-muted">DB git</span>
        <span id="settings-db-git-status" class="text-muted">checking…</span>
        <span class="text-muted">Universe</span>
        <span id="settings-universe-info" style="font-size:12px">
          <span id="settings-universe-date" class="text-muted">loading…</span>
          <button onclick="checkUniverseHealth()" id="universe-check-btn"
            style="margin-left:8px;font-size:10px;padding:1px 8px;border-radius:3px;border:1px solid var(--border);background:var(--bg-secondary);cursor:pointer;color:var(--text-secondary)">
            Check Now
          </button>
          <span id="settings-universe-excluded-badge" style="margin-left:6px;font-size:10px;color:var(--text-muted)"></span>
        </span>
        <span class="text-muted" style="display:none"></span>
        <span id="settings-universe-health-results" style="font-size:12px;grid-column:2"></span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">What's New</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Release history — most recent first</div>

      <details open style="margin-bottom:8px">
        <summary style="cursor:pointer;font-size:12px;font-weight:600;padding:4px 0;list-style:none;display:flex;align-items:center;gap:6px">
          <span style="color:var(--accent)">▸</span> Sprint 13 — Polish &amp; UX (2026-05)
        </summary>
        <ul style="font-size:12px;color:var(--text-secondary);margin:6px 0 4px 16px;line-height:1.8">
          <li>Compact/density mode — Settings toggle reduces padding &amp; table rows</li>
          <li>In-app changelog — this panel</li>
          <li>Macro page loading state — spinner while fetching live data</li>
          <li>Corporate-actions split detection — portfolio warning on recent splits</li>
          <li>Liquidity-scaled slippage — ADV-tiered per-ticker slippage in backtest</li>
        </ul>
      </details>

      <details style="margin-bottom:8px">
        <summary style="cursor:pointer;font-size:12px;font-weight:600;padding:4px 0;list-style:none;display:flex;align-items:center;gap:6px">
          <span style="color:var(--accent)">▸</span> Sprint 12 — Look-ahead bias fix (2026-05)
        </summary>
        <ul style="font-size:12px;color:var(--text-secondary);margin:6px 0 4px 16px;line-height:1.8">
          <li>AI Replay switched to nominal prices (auto_adjust=False) — matches executed prices</li>
          <li>Strategy backtest: total-return basis disclosed in UI banner</li>
          <li>ATR-based stop floor for SELL/TRIM recs (prevents near-zero R:R)</li>
          <li>Intraday Extreme Mode — bypasses entry-window &amp; VWAP gates</li>
          <li>ASX Intraday Scanner rename + universe buttons fix</li>
        </ul>
      </details>

      <details style="margin-bottom:8px">
        <summary style="cursor:pointer;font-size:12px;font-weight:600;padding:4px 0;list-style:none;display:flex;align-items:center;gap:6px">
          <span style="color:var(--accent)">▸</span> Sprint 10–11 — Intraday &amp; universe (2026-04)
        </summary>
        <ul style="font-size:12px;color:var(--text-secondary);margin:6px 0 4px 16px;line-height:1.8">
          <li>⚡ Intraday Day-Trade tab — ASX20/50/100/200 universe selector, 5m scanner</li>
          <li>Forming-bar guard — drops incomplete intraday candle before 07:00 UTC</li>
          <li>Stooq fallback data provider — free alternative when yfinance returns empty</li>
          <li>Stop-proximity alerts — direction-aware, fires once per approach</li>
          <li>Scan timeout &amp; delisted-ticker fixes (IPL.AX removed)</li>
        </ul>
      </details>

      <details style="margin-bottom:8px">
        <summary style="cursor:pointer;font-size:12px;font-weight:600;padding:4px 0;list-style:none;display:flex;align-items:center;gap:6px">
          <span style="color:var(--accent)">▸</span> Sprint 9 — Logging &amp; compare (2026-03)
        </summary>
        <ul style="font-size:12px;color:var(--text-secondary);margin:6px 0 4px 16px;line-height:1.8">
          <li>Full prompt+response logging — every Claude call stored in ai_call_log</li>
          <li>Side-by-side ticker compare (Market Scanner → Compare tab)</li>
          <li>Prompt A/B delta — track which prompt version drove each rec</li>
        </ul>
      </details>
    </div>
  `;
}
function saveApiKey() {
  const val=document.getElementById('api-key-input').value.trim();
  if(!val){toast('Enter a valid API key','error');return;}
  state.settings.apiKey=val;
  localStorage.setItem('asx_api_key',val);
  toast('API key saved','success');
}

async function settingsSaveGroqKey() {
  const key = (document.getElementById('settings-groq-key')?.value || '').trim();
  state.news.settings.groq_api_key = key;
  await _saveNewsSettings();
  toast(key ? 'Groq API key saved' : 'Groq API key cleared', 'success');
  renderPage();
}

async function settingsSaveGoogleKey() {
  const key = (document.getElementById('settings-google-key')?.value || '').trim();
  state.news.settings.google_api_key = key;
  await _saveNewsSettings();
  toast(key ? 'Google API key saved' : 'Google API key cleared', 'success');
  renderPage();
}


function updateSetting(key,value) {
  state.settings[key]=isNaN(Number(value))?value:Number(value);
  scheduleSave();
  toast('Setting updated','success');
}
function settingsToggleCompact(val) {
  state.settings.compactMode = !!val;
  document.body.classList.toggle('compact', !!val);
  scheduleSave();
  renderPage();
}

function settingsToggleLocalLLM(val) {
  state.settings.useLocalLLM = !!val;
  scheduleSave();
  const label = document.getElementById('settings-local-llm-label');
  if (label) {
    label.textContent  = val ? 'Local' : 'Off';
    label.style.color  = val ? '#d97706' : 'var(--text-muted)';
  }
  if (val) toast('Local LLM enabled — portfolio analysis will use Ollama (BUY/HOLD only)', 'info');
  else      toast('Local LLM disabled — portfolio analysis will use Claude API', 'info');
}
function updateSchedSetting(key,value) {
  state.settings[key]=value;
  scheduleSave();
  applyScheduler();
  toast('Schedule setting updated','success');
  // Refresh dashboard schedule card live when on dashboard
  const dashEl = document.getElementById('dashboard-content') || document.getElementById('page-content');
  if (state.page === 'dashboard' && dashEl) {
    // Re-render just the schedule card without a full page reload
    renderPage();
  }
}
function applySchedulePreset(startTime, endTime, intervalMins) {
  state.settings.scheduleWindowStart = startTime;
  state.settings.scheduleWindowEnd = endTime;
  state.settings.scheduleIntervalMins = intervalMins;
  scheduleSave();
  if (state.page === 'dashboard') renderPage();
  applyScheduler();
  toast(`Applied ${startTime}–${endTime} schedule (${intervalMins}m intervals)`,'success');
}

async function saveTelegramConfig() {
  const token   = (document.getElementById('tg-token-input')?.value || '').trim();
  const chat_id = (document.getElementById('tg-chat-input')?.value  || '').trim();
  state.settings.tgToken  = token;
  state.settings.tgChatId = chat_id;
  scheduleSave();
  const statusEl = document.getElementById('tg-status');
  try {
    const r = await fetch(`${API}/api/alerts/telegram/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, chat_id }),
    });
    const d = await r.json();
    if (d.ok) {
      toast('Telegram credentials saved', 'success');
      if (statusEl) statusEl.textContent = '✓ Saved';
    } else {
      toast(`Save failed: ${d.error}`, 'error');
    }
  } catch (e) {
    toast('Could not reach backend', 'error');
  }
}

async function testTelegramAlert() {
  const token   = (document.getElementById('tg-token-input')?.value || '').trim();
  const chat_id = (document.getElementById('tg-chat-input')?.value  || '').trim();
  if (!token || !chat_id) { toast('Enter bot token and chat ID first', 'error'); return; }
  const statusEl = document.getElementById('tg-status');
  if (statusEl) statusEl.textContent = 'Sending…';
  try {
    const r = await fetch(`${API}/api/alerts/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '🦥 Sloth ASX Trader — Telegram alerts are working!', token, chat_id }),
    });
    const d = await r.json();
    if (d.ok) {
      toast('Test message sent — check Telegram', 'success');
      if (statusEl) statusEl.textContent = '✓ Test sent';
    } else {
      toast(`Send failed: ${d.error}`, 'error');
      if (statusEl) statusEl.textContent = `✗ ${d.error}`;
    }
  } catch (e) {
    toast('Could not reach backend', 'error');
    if (statusEl) statusEl.textContent = '✗ Backend unreachable';
  }
}

// ── AI Call Log + Spend Tracker ───────────────────────────────────────────────

async function loadAICallLog() {
  const container = document.getElementById('ai-call-log-container');
  if (!container) return;

  const filter = (document.getElementById('ai-log-filter')?.value || '');
  const url = `${API}/api/log/ai_calls?limit=15${filter ? '&agent_type=' + encodeURIComponent(filter) : ''}`;

  try {
    const [r, rc] = await Promise.all([fetch(url), fetch(`${API}/api/log/ai_cost`)]);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const dc = rc.ok ? await rc.json() : null;
    if (dc && dc.ok) {
      const costEl = document.getElementById('ai-spend-summary');
      if (costEl) costEl.innerHTML = _renderAISpendSummary(dc);
    }
    if (!d.ok || !d.entries || !d.entries.length) {
      container.innerHTML = '<div class="text-xs text-muted" style="padding:10px 0">No calls logged yet.</div>';
      return;
    }
    container.innerHTML = _renderAICallLogTable(d.entries, d.total);
  } catch (e) {
    container.innerHTML = `<div class="text-xs text-danger">Failed to load: ${e.message}</div>`;
  }
}

function _renderAISpendSummary(d) {
  const agentColors = {
    portfolio: '#6366f1', analyst: '#8b5cf6', pm: '#a78bfa',
    dayTrade: '#f59e0b',  universe: '#f97316', macro: '#0ea5e9',
    assistant: '#22c55e', briefing: '#14b8a6',
  };
  const byAgent = {};
  for (const row of d.breakdown) {
    const ag = row.agent_type || 'other';
    if (!byAgent[ag]) byAgent[ag] = { cost: 0, calls: 0 };
    byAgent[ag].cost  += row.cost_usd;
    byAgent[ag].calls += row.call_count;
  }
  const agentRows = Object.entries(byAgent)
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([ag, v]) => {
      const col = agentColors[ag] || 'var(--text-muted)';
      return `<span style="display:inline-flex;align-items:center;gap:5px;margin:2px 6px 2px 0;font-size:11px">
        <span style="background:${col};color:#fff;border-radius:8px;padding:1px 6px;font-size:10px">${escapeHTML(ag)}</span>
        <span style="color:var(--text-secondary)">$${v.cost.toFixed(4)}</span>
        <span style="color:var(--text-muted)">${v.calls}×</span>
      </span>`;
    }).join('');

  const costColor = d.total_cost_usd > 5 ? '#dc2626' : d.total_cost_usd > 1 ? '#d97706' : '#16a34a';
  return `
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 0 4px">
      <div style="font-size:13px;font-weight:600">
        30-day spend: <span style="color:${costColor}">$${d.total_cost_usd.toFixed(4)} USD</span>
        <span class="text-muted" style="font-size:11px;font-weight:400;margin-left:6px">${d.total_calls} calls · ${d.all_time_calls} all-time</span>
      </div>
      <div style="flex:1;min-width:200px">${agentRows}</div>
    </div>`;
}

function _renderAICallLogTable(entries, total) {
  const agentColors = {
    portfolio: '#6366f1', analyst: '#8b5cf6', pm: '#a78bfa',
    dayTrade: '#f59e0b',  universe: '#f97316', macro: '#0ea5e9',
    assistant: '#22c55e', briefing: '#14b8a6',
  };
  const rows = entries.map(e => {
    const col = agentColors[e.agent_type] || 'var(--text-muted)';
    const tokIn  = e.input_tokens  != null ? e.input_tokens.toLocaleString()  : '—';
    const tokOut = e.output_tokens != null ? e.output_tokens.toLocaleString() : '—';
    const cacheR = e.cache_read    > 0    ? `<span style="color:#22c55e"> +${e.cache_read.toLocaleString()}c</span>` : '';
    const dur    = e.duration_ms   != null ? `${(e.duration_ms/1000).toFixed(1)}s` : '—';
    const ts     = (e.timestamp || '').replace('T', ' ').slice(0, 16);
    const usr    = e.usr_snippet  ? escapeHTML(e.usr_snippet.slice(0, 100)) + '…' : '—';
    const resp   = e.resp_snippet ? escapeHTML(e.resp_snippet.slice(0, 80)) + '…' : '—';
    const costStr = e.cost_usd != null && e.cost_usd > 0
      ? `<span style="color:var(--text-muted);font-size:10px">$${e.cost_usd < 0.001 ? e.cost_usd.toFixed(5) : e.cost_usd.toFixed(4)}</span>`
      : '—';

    return `
      <tr style="cursor:pointer" onclick="viewAICall(${e.id})" title="Click to view full call">
        <td style="padding:5px 6px;white-space:nowrap;font-size:11px;color:var(--text-tertiary)">${ts}</td>
        <td style="padding:5px 6px">
          <span style="background:${col};color:#fff;border-radius:9px;padding:1px 7px;font-size:10px;white-space:nowrap">${escapeHTML(e.agent_type || '?')}</span>
        </td>
        <td style="padding:5px 6px;font-size:11px;white-space:nowrap">${tokIn}→${tokOut}${cacheR}</td>
        <td style="padding:5px 6px;font-size:11px;white-space:nowrap">${costStr}</td>
        <td style="padding:5px 6px;font-size:11px;color:var(--text-muted);white-space:nowrap">${dur}</td>
        <td style="padding:5px 6px;font-size:11px;color:var(--text-secondary);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${usr}</td>
        <td style="padding:5px 6px;font-size:11px;color:var(--text-muted);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${resp}</td>
      </tr>`;
  }).join('');

  const footer = total > entries.length
    ? `<div class="text-xs text-muted" style="margin-top:6px">Showing latest ${entries.length} of ${total} calls. Filter by agent to narrow.</div>`
    : `<div class="text-xs text-muted" style="margin-top:6px">${total} call${total !== 1 ? 's' : ''} logged total.</div>`;

  return `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="border-bottom:1px solid var(--border-light)">
            <th style="text-align:left;padding:4px 6px;font-size:11px;color:var(--text-muted);font-weight:500">Time</th>
            <th style="text-align:left;padding:4px 6px;font-size:11px;color:var(--text-muted);font-weight:500">Agent</th>
            <th style="text-align:left;padding:4px 6px;font-size:11px;color:var(--text-muted);font-weight:500">Tokens</th>
            <th style="text-align:left;padding:4px 6px;font-size:11px;color:var(--text-muted);font-weight:500">Cost</th>
            <th style="text-align:left;padding:4px 6px;font-size:11px;color:var(--text-muted);font-weight:500">Duration</th>
            <th style="text-align:left;padding:4px 6px;font-size:11px;color:var(--text-muted);font-weight:500">User message</th>
            <th style="text-align:left;padding:4px 6px;font-size:11px;color:var(--text-muted);font-weight:500">Response</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${footer}`;
}

async function viewAICall(id) {
  let d;
  try {
    const r = await fetch(`${API}/api/log/ai_call/${id}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    d = await r.json();
  } catch (e) {
    toast(`Could not load call #${id}: ${e.message}`, 'error');
    return;
  }

  const ts  = (d.timestamp || '').replace('T', ' ');
  const dur = d.duration_ms != null ? `${(d.duration_ms / 1000).toFixed(2)}s` : '—';
  const tok = `${d.input_tokens ?? '?'} in / ${d.output_tokens ?? '?'} out` +
              (d.cache_read > 0 ? ` / ${d.cache_read.toLocaleString()} cache-read` : '') +
              (d.cache_written > 0 ? ` / ${d.cache_written.toLocaleString()} cache-written` : '');

  const section = (label, content) => content
    ? `<div style="margin-bottom:14px">
         <div style="font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-bottom:4px">${label}</div>
         <pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;background:var(--bg-secondary);border-radius:6px;padding:10px;max-height:260px;overflow-y:auto;margin:0">${escapeHTML(content)}</pre>
       </div>`
    : '';

  const dlg = document.createElement('dialog');
  dlg.style.cssText = 'border-radius:10px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);padding:0;max-width:820px;width:96%;max-height:90vh';
  dlg.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--border-light)">
      <div>
        <strong style="font-size:14px">AI Call #${d.id}</strong>
        <span style="font-size:11px;color:var(--text-muted);margin-left:10px">${ts} &bull; ${escapeHTML(d.agent_type || '?')} &bull; ${escapeHTML(d.model || '?')}</span>
      </div>
      <button class="btn btn-sm" onclick="this.closest('dialog').close()">&#10005;</button>
    </div>
    <div style="padding:16px 18px;overflow-y:auto;max-height:calc(90vh - 120px)">
      <div style="display:flex;gap:20px;font-size:12px;color:var(--text-muted);margin-bottom:14px;flex-wrap:wrap">
        <span>&#128200; <strong>${tok}</strong></span>
        <span>&#9201; <strong>${dur}</strong></span>
      </div>
      ${section('System Prompt', d.system_prompt)}
      ${section('User Message',  d.user_message)}
      ${section('Response',      d.response_text)}
    </div>`;
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
}

// ── App Info helpers (called by navigation.js after settings render) ──────────

async function loadSettingsAppInfo() {
  // Server version + health
  try {
    const r = await fetch(`${API}/health`);
    const d = await r.json();
    const el = document.getElementById('settings-server-ver');
    if (el) el.textContent = d.status === 'ok'
      ? `✓ ${d.version || 'connected'} (${(d.uptime_s ?? 0 / 60).toFixed(0)}min up)`
      : '✗ not connected';
  } catch { /* silent */ }

  // Backup info
  try {
    const r = await fetch(`${API}/health`);
    const d = await r.json();
    const el = document.getElementById('settings-backup-info');
    if (el) el.textContent = d.last_backup || 'daily auto-backup enabled';
  } catch { /* silent */ }

  // DB git commit status
  try {
    const gr = await fetch(`${API}/api/db/git-status`);
    const gd = await gr.json();
    const gitEl = document.getElementById('settings-db-git-status');
    if (gitEl) {
      if (gd.ok) {
        const committed = gd.last_committed ? gd.last_committed.slice(0, 16) : 'never committed';
        const dirty = gd.has_uncommitted ? ' ⚠ uncommitted changes' : '';
        gitEl.textContent = committed + dirty;
        gitEl.style.color = gd.has_uncommitted ? '#d97706' : 'var(--text-secondary)';
      } else {
        gitEl.textContent = gd.error || 'unavailable';
      }
    }
  } catch { /* silent */ }

  // Universe health — load last-verified date and exclusion list from blob_store
  try {
    const r = await fetch(`${API}/api/db/load`);
    const d = await r.json();
    const verifiedAt = d?.universe_verified_at;
    const excluded   = Array.isArray(d?.universe_excluded) ? d.universe_excluded : [];
    const el  = document.getElementById('settings-universe-date');
    const exEl = document.getElementById('settings-universe-excluded-badge');
    if (el) {
      el.textContent = verifiedAt
        ? `last checked ${verifiedAt.slice(0, 10)}`
        : 'never checked';
    }
    if (exEl && excluded.length > 0) {
      exEl.textContent = `· ${excluded.length} excluded`;
    }
    _renderUniverseExclusionList(excluded);
  } catch { /* silent */ }
}

async function checkUniverseHealth() {
  const btn    = document.getElementById('universe-check-btn');
  const date   = document.getElementById('settings-universe-date');
  const exBadge = document.getElementById('settings-universe-excluded-badge');
  const results = document.getElementById('settings-universe-health-results');
  if (btn)  { btn.disabled = true; btn.textContent = 'Checking…'; }
  if (date) date.textContent = 'checking…';
  if (results) results.innerHTML = '';
  try {
    const r = await fetch(`${API}/api/market/universe-health`);
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'unknown error');
    const excluded = d.excluded || [];
    if (date) {
      const staleStr = d.stale.length > 0
        ? ` · ⚠ ${d.stale.length} stale`
        : ` · ✓ all ${d.ok_count} OK`;
      date.textContent = `${d.checked_at.slice(0, 10)}${staleStr}`;
      date.style.color = d.stale.length > 0 ? '#d97706' : '#16a34a';
    }
    if (exBadge) {
      exBadge.textContent = excluded.length > 0 ? `· ${excluded.length} excluded` : '';
    }
    if (results) {
      const staleHtml = d.stale.length > 0 ? `
        <div style="margin-top:6px">
          <div style="font-size:11px;font-weight:600;color:#d97706;margin-bottom:4px">⚠ Stale / delisted:</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">
            ${d.stale.map(t => `
              <span style="display:inline-flex;align-items:center;gap:4px;background:#fef3c7;border:1px solid #f59e0b;border-radius:4px;padding:1px 6px;font-size:11px;font-family:monospace">
                ${t}
                <button onclick="excludeFromUniverse('${t}')" title="Exclude ${t} from scans"
                  style="background:#f59e0b;color:#fff;border:none;border-radius:2px;padding:0 4px;cursor:pointer;font-size:10px;line-height:1.4">Exclude</button>
              </span>`).join('')}
          </div>
        </div>` : '';
      _renderUniverseExclusionList(excluded, results, staleHtml);
    }
    if (d.stale.length > 0) {
      toast(`⚠ ${d.stale.length} stale/delisted tickers found`, 'warning');
    } else {
      toast(`Universe OK — all ${d.ok_count} tickers valid`, 'success');
    }
  } catch (e) {
    if (date) { date.textContent = `check failed: ${e.message}`; date.style.color = '#dc2626'; }
    toast(`Universe health check failed: ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check Now'; }
  }
}

function _renderUniverseExclusionList(excluded, container, prefixHtml) {
  const el = container || document.getElementById('settings-universe-health-results');
  if (!el) return;
  const exHtml = excluded.length > 0 ? `
    <div style="margin-top:6px">
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Excluded from scans:</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${excluded.map(t => `
          <span style="display:inline-flex;align-items:center;gap:4px;background:#f1f5f9;border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:11px;font-family:monospace">
            ${t}
            <button onclick="unexcludeFromUniverse('${t}')" title="Re-include ${t} in scans"
              style="background:#64748b;color:#fff;border:none;border-radius:2px;padding:0 4px;cursor:pointer;font-size:10px;line-height:1.4">Re-include</button>
          </span>`).join('')}
      </div>
    </div>` : '';
  el.innerHTML = (prefixHtml || '') + exHtml;
}

async function excludeFromUniverse(ticker) {
  try {
    const r = await fetch(`${API}/api/market/universe-exclude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: [ticker] }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error('server error');
    const exBadge = document.getElementById('settings-universe-excluded-badge');
    if (exBadge) exBadge.textContent = `· ${d.excluded.length} excluded`;
    _renderUniverseExclusionList(d.excluded);
    toast(`${ticker} excluded from scans`, 'success');
  } catch (e) {
    toast(`Exclude failed: ${e.message}`, 'error');
  }
}

async function unexcludeFromUniverse(ticker) {
  try {
    const r = await fetch(`${API}/api/market/universe-exclude`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: [ticker] }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error('server error');
    const exBadge = document.getElementById('settings-universe-excluded-badge');
    if (exBadge) exBadge.textContent = d.excluded.length > 0 ? `· ${d.excluded.length} excluded` : '';
    _renderUniverseExclusionList(d.excluded);
    toast(`${ticker} re-included in scans`, 'success');
  } catch (e) {
    toast(`Re-include failed: ${e.message}`, 'error');
  }
}

let _customIntervalTimer = null;
function setCustomInterval(input) {
  const raw = parseInt(input.value, 10);
  if (isNaN(raw) || raw < 1) return;
  const mins = Math.min(Math.max(raw, 1), 480);
  if (mins === state.settings.scheduleIntervalMins) return;
  state.settings.scheduleIntervalMins = mins;
  scheduleSave();
  applyScheduler();
  // Debounce renderPage so the input element isn't destroyed mid-typing
  clearTimeout(_customIntervalTimer);
  _customIntervalTimer = setTimeout(() => renderPage(), 800);
}
