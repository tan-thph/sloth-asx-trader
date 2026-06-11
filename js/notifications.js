// ============================================================
// notifications.js — Notification centre for Sloth ASX Trader
//
// Persists to notifications.db via backend API (separate from asx_trader.db).
// Displays 8 most recent in the panel; "Load more" fetches next page.
//
// Public API:
//   pushNotification(type, title, body, category) — add + save
//   toggleNotifPanel()                            — open/close dropdown
//   markAllNotifsRead()                           — clear badge
//   clearAllNotifs()                              — wipe DB
//   initNotificationCenter()                      — call once from init.js
// ============================================================

var _notifPanelOpen  = false;
var _notifItems      = [];    // currently loaded items (in panel)
var _notifHasMore    = false; // whether more pages exist in DB
var _notifOffset     = 0;     // current pagination offset
var _notifLoading    = false; // prevent concurrent fetches
var _NOTIF_PAGE      = 8;     // items per page

var _NOTIF_ICONS = {
  success: '✅', error: '⛔', warning: '⚠️', info: 'ℹ️',
};
var _CATEGORY_ICONS = {
  trade: '💼', price: '📈', scan: '🔍', system: '🔔', error: '💥',
  outcome: '📋', outcome_dt: '📋',
};

// Categories that deep-link to a page when the notification is clicked.
// Used by the outcome-proposal notifications (stop/target hit → record the close).
var _NOTIF_NAV = { outcome: 'recommendations', outcome_dt: 'day-trading' };

function _notifNavigate(category) {
  var page = _NOTIF_NAV[category];
  if (!page || typeof showPage !== 'function') return;
  if (typeof toggleNotifPanel === 'function' && _notifPanelOpen) toggleNotifPanel();
  showPage(page);
}

// ── Badge count cached in localStorage for instant display on startup ─────────
var _NOTIF_BADGE_KEY = 'sloth_notif_badge';

function _getBadgeCount() {
  try { return parseInt(localStorage.getItem(_NOTIF_BADGE_KEY) || '0', 10) || 0; } catch (_) { return 0; }
}
function _setBadgeCount(n) {
  try { localStorage.setItem(_NOTIF_BADGE_KEY, String(Math.max(0, n))); } catch (_) {}
}

// ── Core public function ───────────────────────────────────────────────────────

function pushNotification(type, title, body, category) {
  category = category || 'system';
  var payload = {
    type:      String(type  || 'info').slice(0, 20),
    title:     String(title || '').slice(0, 200),
    body:      String(body  || '').slice(0, 500),
    category:  String(category).slice(0, 40),
    timestamp: new Date().toISOString(),
  };

  // Persist to notifications.db (fire-and-forget — don't block the caller)
  if (typeof API !== 'undefined') {
    fetch(API + '/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(function() {});  // silent fail — never crash the caller
  }

  // Bump badge immediately (without waiting for server round-trip)
  _setBadgeCount(_getBadgeCount() + 1);
  _updateNotifBadge();

  // If panel is open, prepend the new item and re-render
  if (_notifPanelOpen) {
    _notifItems.unshift(Object.assign({ id: Date.now(), read: 0 }, payload));
    _renderNotifList();
  }
}

// ── Badge ──────────────────────────────────────────────────────────────────────

function _updateNotifBadge() {
  var badge = document.getElementById('notif-badge');
  if (!badge) return;
  var count = _getBadgeCount();
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.style.display = count > 0 ? 'flex' : 'none';
}

// ── Time formatting ────────────────────────────────────────────────────────────

function _fmtNotifTime(iso) {
  try {
    var d = new Date(iso);
    var diffMs = Date.now() - d.getTime();
    var diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return diffMin + 'm ago';
    var diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return diffH + 'h ago';
    var diffD = Math.floor(diffH / 24);
    if (diffD < 7) return diffD + 'd ago';
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: diffD > 365 ? 'numeric' : undefined });
  } catch (_) { return ''; }
}

// ── Panel open/close ───────────────────────────────────────────────────────────

function toggleNotifPanel() {
  var panel = document.getElementById('notif-panel');
  if (!panel) return;

  _notifPanelOpen = !_notifPanelOpen;
  if (_notifPanelOpen) {
    // Reset pagination and load first page
    _notifItems  = [];
    _notifOffset = 0;
    _notifHasMore = false;
    panel.style.display = 'flex';
    _renderNotifShell();   // show header + spinner immediately
    _fetchNotifPage(true); // load first page, mark all read after
  } else {
    panel.style.display = 'none';
  }
}

// ── Fetch a page from the backend ─────────────────────────────────────────────

function _fetchNotifPage(isFirst) {
  if (_notifLoading) return;
  _notifLoading = true;

  var url = API + '/api/notifications?limit=' + _NOTIF_PAGE + '&offset=' + _notifOffset;
  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _notifLoading = false;
      if (!data.ok) return;
      _notifItems   = _notifItems.concat(data.items || []);
      _notifHasMore = !!data.has_more;
      _notifOffset += (data.items || []).length;
      _renderNotifList();

      // On first open: mark all as read + clear badge
      if (isFirst) {
        _setBadgeCount(0);
        _updateNotifBadge();
        fetch(API + '/api/notifications/read-all', { method: 'POST' }).catch(function() {});
      }
    })
    .catch(function() {
      _notifLoading = false;
      _renderNotifList(); // show whatever we have (or empty state)
    });
}

// ── Render helpers ─────────────────────────────────────────────────────────────

// Render the fixed shell (header + empty list area) — called once on open
function _renderNotifShell() {
  var panel = document.getElementById('notif-panel');
  if (!panel) return;
  panel.innerHTML =
    '<div class="notif-panel-header" id="notif-panel-hdr">' +
      '<span>🔔 Notifications</span>' +
      '<div style="display:flex;gap:6px" id="notif-panel-actions"></div>' +
    '</div>' +
    '<div class="notif-list" id="notif-list-body">' +
      '<div class="notif-empty">⏳ Loading…</div>' +
    '</div>';
}

// Render/update only the list body (preserves header)
function _renderNotifList() {
  var listEl = document.getElementById('notif-list-body');
  var hdrEl  = document.getElementById('notif-panel-hdr');
  var actEl  = document.getElementById('notif-panel-actions');
  if (!listEl) { _renderNotifShell(); listEl = document.getElementById('notif-list-body'); actEl = document.getElementById('notif-panel-actions'); }

  // Update header action buttons
  if (actEl) {
    actEl.innerHTML =
      (_notifItems.length > 0 ? '<button class="btn btn-xs" onclick="clearAllNotifs()" title="Clear all" style="color:var(--text-secondary)">🗑 Clear</button>' : '');
  }

  if (_notifItems.length === 0 && !_notifLoading) {
    listEl.innerHTML = '<div class="notif-empty">🔔<div style="margin-top:8px">No notifications yet.<br><span style="font-size:11px">Toasts, alerts, and errors appear here.</span></div></div>';
    return;
  }

  var rows = _notifItems.map(function(n) {
    var icon = _CATEGORY_ICONS[n.category] || _NOTIF_ICONS[n.type] || '🔔';
    var borderColor = n.type === 'error' ? '#ef4444'
      : n.type === 'success' ? '#22c55e'
      : n.type === 'warning' ? '#f59e0b'
      : '#3b82f6';
    var navAttr = _NOTIF_NAV[n.category]
      ? ' onclick="_notifNavigate(\'' + n.category + '\')" title="Open ' + _NOTIF_NAV[n.category] + ' page"'
      : '';
    return '<div class="notif-item" style="border-left:3px solid ' + borderColor + '"' + navAttr + '>' +
      '<div class="notif-icon">' + icon + '</div>' +
      '<div class="notif-content">' +
        '<div class="notif-title">' + escapeHTML(String(n.title || '')) + '</div>' +
        (n.body ? '<div class="notif-body">' + escapeHTML(String(n.body)) + '</div>' : '') +
        '<div class="notif-time">' + _fmtNotifTime(n.timestamp) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  var loadMore = _notifHasMore
    ? '<div style="text-align:center;padding:10px">' +
        '<button class="btn btn-sm" onclick="_loadMoreNotifs()" style="font-size:12px">' +
          (_notifLoading ? '⏳ Loading…' : '↓ Load more') +
        '</button>' +
      '</div>'
    : (_notifItems.length >= _NOTIF_PAGE
        ? '<div style="text-align:center;padding:8px;font-size:11px;color:var(--text-secondary)">— end of history —</div>'
        : '');

  listEl.innerHTML = rows + loadMore;
}

// ── "Load more" pagination ─────────────────────────────────────────────────────

function _loadMoreNotifs() {
  if (_notifLoading || !_notifHasMore) return;
  _fetchNotifPage(false);
}

// ── markAllNotifsRead (public — wired to "✓ All read" button) ─────────────────

function markAllNotifsRead() {
  _setBadgeCount(0);
  _updateNotifBadge();
  fetch(API + '/api/notifications/read-all', { method: 'POST' }).catch(function() {});
  _renderNotifList();
}

// ── clearAllNotifs (public — wired to 🗑 button) ───────────────────────────────

function clearAllNotifs() {
  if (!confirm('Clear all notifications? This cannot be undone.')) return;
  fetch(API + '/api/notifications', { method: 'DELETE' })
    .then(function() {
      _notifItems  = [];
      _notifOffset = 0;
      _notifHasMore = false;
      _setBadgeCount(0);
      _updateNotifBadge();
      _renderNotifList();
    })
    .catch(function() {});
}

// ── Init ───────────────────────────────────────────────────────────────────────

function initNotificationCenter() {
  // Restore badge from localStorage cache (instant display before API call)
  _updateNotifBadge();

  // Fetch real unread count from DB to sync badge after any cross-session activity
  if (typeof API !== 'undefined') {
    fetch(API + '/api/notifications/unread-count')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d && typeof d.count === 'number') {
          _setBadgeCount(d.count);
          _updateNotifBadge();
        }
      })
      .catch(function() {});
  }

  // Close panel on click outside the bell wrap
  document.addEventListener('click', function(e) {
    if (!_notifPanelOpen) return;
    var wrap = document.getElementById('notif-bell-wrap');
    if (wrap && !wrap.contains(e.target)) {
      _notifPanelOpen = false;
      var panel = document.getElementById('notif-panel');
      if (panel) panel.style.display = 'none';
    }
  }, true);
}
