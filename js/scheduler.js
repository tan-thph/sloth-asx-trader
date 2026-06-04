// Clock
setInterval(()=>{ const e=document.getElementById('market-time'); if(e) e.textContent='ASX: '+nowSydney()+' AEDT'; },5000);

// ============================================================
// SERVER CHECK
// ============================================================
async function checkServer() {
  const dot=document.getElementById('srv-dot');
  const lbl=document.getElementById('srv-label');
  const dbl=document.getElementById('db-label');
  try {
    const r = await fetch(`${API}/health`, {signal: AbortSignal.timeout(3000)});
    if(r.ok) {
      state.serverOk=true;
      dot.className='server-dot ok';
      lbl.textContent='Server connected';
      // Update DB row counts
      try {
        const dr = await fetch(`${API}/api/db/status`);
        if(dr.ok) {
          const d = await dr.json();
          if(dbl) dbl.textContent=`💾 ${d.portfolio_rows}p · ${d.journal_rows}t · ${d.rec_rows}r`;
        }
      } catch {}
    } else throw new Error();
  } catch {
    state.serverOk=false;
    dot.className='server-dot err';
    lbl.textContent='Server offline';
    if(dbl) dbl.textContent='💾 DB: offline';
  }
}
setInterval(checkServer, 30000);
checkServer();

// ============================================================
// AUTO-SCHEDULER
// ============================================================
let _schedulerInterval = null;
let _priceRefreshInterval = null; // Auto price refresh every 10 minutes
let _schedulerLog = []; // {time, type, msg}

function schedulerLog(type, msg) {
  const entry = {time: nowSydney(), date: todayStr(), type, msg};
  _schedulerLog.unshift(entry);
  // No in-memory limit - database handles 5-day retention
  // Update live log if settings page is open
  const logEl = document.getElementById('sched-log');
  if(logEl) renderSchedulerLog();
}

function renderSchedulerLog() {
  const logEl = document.getElementById('sched-log');
  if(!logEl) return;
  // _schedulerLog is newest-first (unshift). Show the most recent 20.
  const recent = _schedulerLog.slice(0, 20);
  if (recent.length === 0) {
    logEl.innerHTML = '<div class="text-xs text-muted" style="padding:8px">No activity yet.</div>';
    return;
  }
  const rows = recent.map(e=>`
    <div style="display:flex;gap:8px;padding:5px 0;border-bottom:0.5px solid var(--border-light);font-size:12px">
      <span style="color:var(--text-tertiary);white-space:nowrap">${e.date} ${e.time}</span>
      <span style="color:${e.type==='run'?'#16a34a':e.type==='skip'?'#d97706':'#6b6b6b'}">${e.type==='run'?'▶':e.type==='skip'?'—':'ℹ'}</span>
      <span style="color:var(--text-secondary)">${e.msg}</span>
    </div>`).join('');
  const footer = _schedulerLog.length > 20
    ? `<div class="text-xs text-muted" style="padding:6px 0 2px">Showing latest 20 of ${_schedulerLog.length} entries.</div>`
    : '';
  logEl.innerHTML = rows + footer;
}

function isWeekday() {
  // Sydney time weekday check
  const day = new Date().toLocaleDateString('en-AU',{timeZone:'Australia/Sydney',weekday:'long'});
  return !['Saturday','Sunday'].includes(day);
}

function sydneyHHMM() {
  // Returns current Sydney time as "HH:MM" string
  return new Date().toLocaleTimeString('en-AU',{timeZone:'Australia/Sydney',hour:'2-digit',minute:'2-digit',hour12:false});
}

function timeToMins(hhmm) {
  const [h,m] = hhmm.split(':').map(Number);
  return h*60 + m;
}

function isInWindow() {
  const s = state.settings;
  const now = timeToMins(sydneyHHMM());
  const start = timeToMins(s.scheduleWindowStart || '10:00');
  const end   = timeToMins(s.scheduleWindowEnd   || '15:45');
  return now >= start && now <= end;
}

async function schedulerTick() {
  const s = state.settings;
  if(!s.scheduleEnabled) return;
  if(!getApiKey()) return;
  if(s.scheduleWeekdaysOnly && !isWeekday()) return;
  if(!isInWindow()) return;
  if(state.analysisRunning) { schedulerLog('skip','Skipped — analysis already running'); return; }

  const nowMins = timeToMins(sydneyHHMM());
  const startMins = timeToMins(s.scheduleWindowStart || '10:00');
  const endMins   = timeToMins(s.scheduleWindowEnd   || '15:45');
  const intervalMins = s.scheduleIntervalMins || 60;

  // Build the set of scheduled run times within the window.
  // Always include the exact end time as the final run.
  const slots = [];
  for (let t = startMins; t < endMins; t += intervalMins) slots.push(t);
  slots.push(endMins); // guaranteed end-of-day run at e.g. 15:45

  // Fire if the current minute matches any slot (within a 1-minute tolerance)
  const shouldRun = slots.some(slot => nowMins === slot);
  if (!shouldRun) return;

  // Deduplicate: skip if we already ran within this same minute
  const runKey = `asx_ran_${todayStr()}_${sydneyHHMM()}`;
  if (sessionStorage.getItem(runKey)) return;
  sessionStorage.setItem(runKey, '1');

  schedulerLog('run', `Scheduled run at ${sydneyHHMM()} (every ${intervalMins}m, window ${s.scheduleWindowStart}–${s.scheduleWindowEnd})`);
  state.settings._lastScheduledRunAt = sydneyHHMM(); // track for dashboard display
  scheduleSave();
  toast('⏱ Scheduled analysis running...', 'info');
  await runAnalysis();
}

function applyScheduler() {
  clearInterval(_schedulerInterval);
  _schedulerInterval = null;
  const s = state.settings;
  if(!s.scheduleEnabled) {
    schedulerLog('info','Scheduler disabled');
    updateSchedulerStatus();
    return;
  }

  // 1-minute heartbeat — checks clock each minute, fires when time matches a slot
  _schedulerInterval = setInterval(schedulerTick, 60 * 1000);
  // Keep the status display (next run time) fresh every minute
  if (!window._schedStatusInterval) {
    window._schedStatusInterval = setInterval(updateSchedulerStatus, 60 * 1000);
  }
  schedulerLog('info', `Scheduler started — every ${s.scheduleIntervalMins}m, ${s.scheduleWindowStart}–${s.scheduleWindowEnd} Sydney (last run guaranteed at ${s.scheduleWindowEnd})`);
  updateSchedulerStatus();

  // Run immediately on open if in window — once per session per day
  const sessionKey = 'asx_scheduler_ran_' + todayStr();
  const alreadyRanThisSession = sessionStorage.getItem(sessionKey);
  if(s.scheduleRunOnOpen && isInWindow() && (s.scheduleWeekdaysOnly ? isWeekday() : true) && !alreadyRanThisSession) {
    sessionStorage.setItem(sessionKey, '1');
    setTimeout(()=>{ schedulerLog('run','Run-on-open triggered'); runAnalysis(); }, 2000);
  }
}

function updateSchedulerStatus() {
  const el = document.getElementById('sched-status');
  if(!el) return;
  const s = state.settings;
  if(!s.scheduleEnabled) {
    el.innerHTML = '<span style="color:var(--text-tertiary)">○ Scheduler off</span>';
    return;
  }
  const inWin  = isInWindow();
  const wkday  = !s.scheduleWeekdaysOnly || isWeekday();
  const active = inWin && wkday;

  // Compute all scheduled slots and find the next one
  const startMins   = timeToMins(s.scheduleWindowStart || '10:00');
  const endMins     = timeToMins(s.scheduleWindowEnd   || '15:45');
  const intervalMins = s.scheduleIntervalMins || 60;
  const slots = [];
  for (let t = startMins; t < endMins; t += intervalMins) slots.push(t);
  slots.push(endMins);
  const slotLabels = slots.map(m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`);

  const nowMins = timeToMins(sydneyHHMM());
  const nextSlot = slots.find(t => t > nowMins);
  const nextLabel = nextSlot != null
    ? `${String(Math.floor(nextSlot/60)).padStart(2,'0')}:${String(nextSlot%60).padStart(2,'0')}`
    : 'none today';

  el.innerHTML = `
    <span style="color:${active?'#16a34a':'#d97706'}">${active?'● Active':'◌ Waiting'}</span>
    <span style="color:var(--text-tertiary);font-size:11px">
      · every ${intervalMins}m · ${s.scheduleWindowStart}–${s.scheduleWindowEnd}
      ${active ? `· <strong>next run: ${nextLabel}</strong>` : ''}
    </span>
    <div style="font-size:10px;color:var(--text-tertiary);margin-top:2px">
      Scheduled slots: ${slotLabels.join(', ')}
    </div>`;
}

function toggleScheduler(enabled) {
  state.settings.scheduleEnabled = !!enabled;
  const knob = document.getElementById('sched-knob');
  const knobBall = document.getElementById('sched-knob-ball');
  if(knob) knob.style.background = state.settings.scheduleEnabled ? '#16a34a' : 'var(--border-medium)';
  if(knobBall) knobBall.style.left = state.settings.scheduleEnabled ? '23px' : '3px';
  scheduleSave();
  applyScheduler();
  // Update dashboard schedule widget immediately to reflect enabled/disabled state
  if (state.page === 'dashboard') renderPage();
}

// Refresh dashboard schedule display every minute so pill states (past/current) stay in sync
setInterval(() => {
  if (state.page === 'dashboard') {
    // Only re-render the schedule section, not the whole page, to avoid disrupting interactions
    const el = document.getElementById('schedule-card');
    if (el) {
      const pv=portfolioValue(), nw=totalNetWorth(), gain=totalGain();
      // Just fully re-render the dashboard — it's cheap and correct
      renderPage();
    }
  }
}, 60000);

// Refresh status every minute
setInterval(updateSchedulerStatus, 60000);

// ============================================================
// AUTO PRICE REFRESH (10 min PC / 20 min SBC)
// ============================================================

const PRICE_REFRESH_MS     = 10 * 60 * 1000; // 10 minutes — PC mode
const SBC_PRICE_REFRESH_MS = 20 * 60 * 1000; // 20 minutes — SBC mode

function _priceRefreshInterval_ms() {
  return state.settings.sbcMode ? SBC_PRICE_REFRESH_MS : PRICE_REFRESH_MS;
}

async function autoRefreshPrices(reason) {
  if (!state.serverOk || state.portfolio.length === 0) return;
  console.log(`Auto-refreshing prices (${reason})...`);
  await refreshPrices({silent: true});
  checkAutoBriefSchedule();
}

function checkAutoBriefSchedule() {
  const t = state.settings?.autoBriefTime;
  if (!t) return;

  const todayKey = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  const firedKey = 'autoBriefFiredDate';
  if (localStorage.getItem(firedKey) === todayKey) return;

  // Check if current AEST time >= configured time.
  // AEST = UTC+10 (conservative; AEDT = UTC+11 gives 1h extra grace).
  const nowUtc = new Date();
  const aestOffset = 10 * 60; // minutes
  const aestNow = new Date(nowUtc.getTime() + aestOffset * 60 * 1000);
  const aestHHMM = aestNow.toISOString().slice(11, 16); // 'HH:MM'

  if (aestHHMM < t) return;

  // Brief already generated today?
  if (window._morningBrief?.date === todayKey) {
    localStorage.setItem(firedKey, todayKey);
    return;
  }

  localStorage.setItem(firedKey, todayKey);
  if (typeof generateMorningBriefing === 'function') {
    generateMorningBriefing();
  }
}

function startPriceRefresh() {
  stopPriceRefresh();
  const ms = _priceRefreshInterval_ms();
  const label = state.settings.sbcMode ? '20-min tick (SBC)' : '10-min tick';
  _priceRefreshInterval = setInterval(() => autoRefreshPrices(label), ms);
  console.log(`Price auto-refresh started (every ${ms/60000} minutes${state.settings.sbcMode ? ' – SBC mode' : ''})`);
}

function stopPriceRefresh() {
  if (_priceRefreshInterval) {
    clearInterval(_priceRefreshInterval);
    _priceRefreshInterval = null;
    console.log('Price auto-refresh stopped');
  }
}

// setInterval pauses while the laptop is asleep / tab is hidden — when the tab
// becomes visible again, refresh immediately if prices are stale.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const last = state.lastPriceRefresh || 0;
  if (Date.now() - last >= _priceRefreshInterval_ms()) autoRefreshPrices('tab-visible/stale');
});

// ============================================================
// SBC MODE TOGGLE
// ============================================================

async function toggleSbcMode() {
  const enabled = !state.settings.sbcMode;
  state.settings.sbcMode = enabled;
  updateSbcModeButton();
  startPriceRefresh(); // restart with new interval
  scheduleSave();

  if (!state.serverOk) {
    toast(enabled ? 'SBC mode on — 20 min refresh' : 'PC mode on — 10 min refresh', 'info');
    return;
  }

  // Notify server to pause/resume background schedulers
  fetch(`${API}/api/sbc-mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).catch(() => {});

  // Auto-configure cpu_mode based on GPU detection
  try {
    const gpu = await fetch(`${API}/api/system/gpu`).then(r => r.json());
    const hasCuda = gpu?.cuda ?? false;
    const device  = gpu?.device || (hasCuda ? 'GPU' : 'CPU');

    if (enabled) {
      // SBC mode on: cpu_mode = true only when no CUDA (e.g. RPi 5)
      const newCpuMode = !hasCuda;
      await fetch(`${API}/api/news/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...state.news.settings, cpu_mode: newCpuMode }),
      });
      state.news.settings.cpu_mode = newCpuMode;
      const hwLabel = hasCuda ? `CUDA (${device})` : `CPU-only (${device || 'no GPU'})`;
      toast(`SBC mode on — 20 min refresh · ${hwLabel} · auto-scan paused`, 'info');
    } else {
      // PC mode on: always use GPU (cpu_mode = false)
      await fetch(`${API}/api/news/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...state.news.settings, cpu_mode: false }),
      });
      state.news.settings.cpu_mode = false;
      toast(`PC mode on — 10 min refresh · ${hasCuda ? device : 'GPU'} · auto-scan enabled`, 'info');
    }
  } catch {
    toast(enabled ? 'SBC mode on — 20 min refresh, auto-scan paused' : 'PC mode on — 10 min refresh', 'info');
  }
}

function updateSbcModeButton() {
  const btn = document.getElementById('sbc-mode-btn');
  if (!btn) return;
  const sbc = state.settings.sbcMode;
  btn.textContent = sbc ? '◈ SBC' : '⬡ PC';
  btn.style.background    = sbc ? '#7c3aed' : '';
  btn.style.color         = sbc ? '#ffffff' : '';
  btn.style.borderColor   = sbc ? '#7c3aed' : '';
  btn.title = sbc
    ? 'SBC mode active — click to switch to PC mode'
    : 'PC mode — click to switch to SBC mode (20 min refresh, no auto-scan)';
}
