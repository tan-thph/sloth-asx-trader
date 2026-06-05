// ============================================================
// notifications.js — Notification center for Sloth ASX Trader
// Captures toasts, fireAlert calls, and page crash errors.
// ============================================================

var _NOTIF_MAX = 200;
var _NOTIF_KEY = 'sloth_notif_v1';

// Notification shape: { id, type, title, body, category, timestamp, read }
// type:     'success' | 'error' | 'warning' | 'info'
// category: 'trade' | 'price' | 'scan' | 'system' | 'error'

var _notifList = [];
var _notifPanelOpen = false;

var _NOTIF_ICONS = {
  success: '✅', error: '⛔', warning: '⚠️', info: 'ℹ️',
};
var _CATEGORY_ICONS = {
  trade: '💼', price: '📈', scan: '🔍', system: '🔔', error: '💥',
};

function pushNotification(type, title, body, category) {
  category = category || 'system';
  var n = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    type: type || 'info',
    title: String(title || '').slice(0, 120),
    body: String(body || '').slice(0, 400),
    category: category,
    timestamp: new Date().toISOString(),
    read: false,
  };
  _notifList.unshift(n);
  if (_notifList.length > _NOTIF_MAX) _notifList.length = _NOTIF_MAX;
  _saveNotifications();
  _updateNotifBadge();
  if (_notifPanelOpen) _renderNotifPanel();
}

function _loadNotifications() {
  try {
    var raw = localStorage.getItem(_NOTIF_KEY);
    if (raw) _notifList = JSON.parse(raw);
  } catch (_) { _notifList = []; }
}

function _saveNotifications() {
  try { localStorage.setItem(_NOTIF_KEY, JSON.stringify(_notifList)); } catch (_) {}
}

function _updateNotifBadge() {
  var badge = document.getElementById('notif-badge');
  if (!badge) return;
  var unread = _notifList.filter(function(n) { return !n.read; }).length;
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.style.display = unread > 0 ? 'flex' : 'none';
}

function _fmtNotifTime(iso) {
  try {
    var d = new Date(iso);
    var now = new Date();
    var diffMs = now - d;
    var diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return diffMin + 'm ago';
    var diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return diffH + 'h ago';
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  } catch (_) { return ''; }
}

function _renderNotifPanel() {
  var panel = document.getElementById('notif-panel');
  if (!panel) return;

  var unread = _notifList.filter(function(n) { return !n.read; }).length;

  var items = _notifList.length === 0
    ? '<div class="notif-empty">🔔<div style="margin-top:8px">No notifications yet</div></div>'
    : _notifList.map(function(n) {
        var icon = _CATEGORY_ICONS[n.category] || _NOTIF_ICONS[n.type] || '🔔';
        var borderColor = n.type === 'error' ? '#ef4444'
          : n.type === 'success' ? '#22c55e'
          : n.type === 'warning' ? '#f59e0b'
          : '#3b82f6';
        return '<div class="notif-item' + (n.read ? '' : ' unread') + '" style="border-left:3px solid ' + borderColor + '" onclick="_markNotifRead(\'' + n.id + '\')">' +
          '<div class="notif-icon">' + icon + '</div>' +
          '<div class="notif-content">' +
            '<div class="notif-title">' + escapeHTML(n.title) + '</div>' +
            (n.body ? '<div class="notif-body">' + escapeHTML(n.body) + '</div>' : '') +
            '<div class="notif-time">' + _fmtNotifTime(n.timestamp) + '</div>' +
          '</div>' +
        '</div>';
      }).join('');

  panel.innerHTML =
    '<div class="notif-panel-header">' +
      '<span>🔔 Notifications' + (unread > 0 ? ' <span class="notif-header-badge">' + unread + ' new</span>' : '') + '</span>' +
      '<div style="display:flex;gap:6px">' +
        (unread > 0 ? '<button class="btn btn-xs" onclick="markAllNotifsRead()" title="Mark all read">✓ All read</button>' : '') +
        (_notifList.length > 0 ? '<button class="btn btn-xs" onclick="clearAllNotifs()" title="Clear all" style="color:var(--text-secondary)">🗑</button>' : '') +
      '</div>' +
    '</div>' +
    '<div class="notif-list">' + items + '</div>';
}

function _markNotifRead(id) {
  var n = _notifList.find(function(x) { return x.id === id; });
  if (n) { n.read = true; _saveNotifications(); _updateNotifBadge(); _renderNotifPanel(); }
}

function markAllNotifsRead() {
  _notifList.forEach(function(n) { n.read = true; });
  _saveNotifications();
  _updateNotifBadge();
  _renderNotifPanel();
}

function clearAllNotifs() {
  if (!confirm('Clear all notifications?')) return;
  _notifList = [];
  _saveNotifications();
  _updateNotifBadge();
  _renderNotifPanel();
}

function toggleNotifPanel() {
  var panel = document.getElementById('notif-panel');
  if (!panel) return;
  _notifPanelOpen = !_notifPanelOpen;
  if (_notifPanelOpen) {
    _renderNotifPanel();
    panel.style.display = 'flex';
    // Mark all as read when opening
    markAllNotifsRead();
  } else {
    panel.style.display = 'none';
  }
}

function initNotificationCenter() {
  _loadNotifications();
  _updateNotifBadge();
  // Close panel on outside click
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
