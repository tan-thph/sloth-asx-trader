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
  `;
}
function saveApiKey() {
  const val=document.getElementById('api-key-input').value.trim();
  if(!val){toast('Enter a valid API key','error');return;}
  state.settings.apiKey=val;
  localStorage.setItem('asx_api_key',val);
  toast('API key saved','success');
}


function updateSetting(key,value) {
  state.settings[key]=isNaN(Number(value))?value:Number(value);
  scheduleSave();
  toast('Setting updated','success');
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
