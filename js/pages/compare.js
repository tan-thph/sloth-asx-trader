// ============================================================
// pages/compare.js — Side-by-side ticker comparison
// Up to 4 ASX tickers. Uses /api/analyse/batch for signals.
// Navigation: Market Scanner → ↔ Compare tab, or keyboard g+x
// compareFromOutside(tickerList) pre-loads tickers from other pages.
// ============================================================

// ── Module state ──────────────────────────────────────────────────────────────
let _compareTickers = ['', '', '', ''];
let _compareData    = {};    // { TICKER: signals }
let _compareLoading = false;

function renderComparePage(gen) {
  const el = document.getElementById('main-content');
  el.innerHTML = _buildCompareShell();
  // Pre-fill if tickers were carried in from watchlist/scanner
  _compareTickers.forEach((t, i) => {
    const inp = document.getElementById(`cmp-tick-${i}`);
    if (inp && t) inp.value = t;
  });
  if (_compareTickers.some(t => t)) {
    runComparison();
  }
}

function _buildCompareShell() {
  return `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px">
        <div class="card-title" style="margin:0">Side-by-Side Compare</div>
        <div style="font-size:11px;color:var(--text-muted)">
          Compare up to 4 ASX tickers &bull; signals from <code>/api/analyse/batch</code>
        </div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        ${[0,1,2,3].map(i => `
          <div style="display:flex;flex-direction:column;gap:3px">
            <label style="font-size:10px;color:var(--text-muted);font-weight:500">TICKER ${i+1}</label>
            <input id="cmp-tick-${i}"
                   type="text" maxlength="6"
                   placeholder="${i === 0 ? 'e.g. BHP' : i === 1 ? 'CBA' : i === 2 ? 'WBC' : 'NAB'}"
                   style="width:88px;text-transform:uppercase;padding:5px 8px;border-radius:var(--radius-md);border:0.5px solid var(--border-medium);background:var(--bg-primary);color:var(--text-primary);font-size:13px;font-weight:600;letter-spacing:.05em"
                   oninput="this.value=this.value.toUpperCase()"
                   onkeydown="if(event.key==='Enter')runComparison()">
          </div>`).join('')}
        <button class="btn btn-primary" onclick="runComparison()" style="height:32px;padding:0 16px;align-self:flex-end">
          Compare &#8594;
        </button>
        <button class="btn btn-sm" onclick="clearComparison()" style="height:32px;align-self:flex-end;color:var(--text-muted)">
          Clear
        </button>
      </div>
    </div>

    <div id="compare-results"></div>
  `;
}

async function runComparison() {
  if (_compareLoading) return;

  // Read inputs
  _compareTickers = [0,1,2,3].map(i => {
    const v = (document.getElementById(`cmp-tick-${i}`)?.value || '').trim().toUpperCase();
    return v.replace(/\.AX$/i, '');
  });

  const tickers = _compareTickers.filter(t => t && /^[A-Z0-9]{2,6}$/.test(t));
  if (tickers.length < 2) {
    document.getElementById('compare-results').innerHTML =
      '<div class="card text-muted text-sm" style="padding:16px">Enter at least 2 valid ASX ticker codes to compare.</div>';
    return;
  }

  const el = document.getElementById('compare-results');
  el.innerHTML = `<div class="card" style="padding:20px;text-align:center">
    <div class="spinner" style="margin:0 auto 8px"></div>
    <div class="text-sm text-muted">Fetching signals for ${tickers.join(', ')}…</div>
  </div>`;
  _compareLoading = true;

  try {
    const r = await fetch(`${API}/api/analyse/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: tickers.map(t => t + '.AX') }),
    });
    const batch = await r.json();
    // batch is { 'BHP.AX': {...}, 'CBA.AX': {...} }
    _compareData = {};
    for (const [k, v] of Object.entries(batch)) {
      const bare = k.replace(/\.AX$/, '');
      _compareData[bare] = v;
    }
    el.innerHTML = _renderCompareTable(tickers);
  } catch (e) {
    el.innerHTML = `<div class="card text-danger text-sm" style="padding:16px">Failed: ${escapeHTML(e.message)}</div>`;
  } finally {
    _compareLoading = false;
  }
}

function clearComparison() {
  _compareTickers = ['','','',''];
  _compareData    = {};
  [0,1,2,3].forEach(i => {
    const inp = document.getElementById(`cmp-tick-${i}`);
    if (inp) inp.value = '';
  });
  document.getElementById('compare-results').innerHTML = '';
}

// Pre-load tickers from another page and navigate to the Compare tab in Market Scanner
function compareFromOutside(tickerList) {
  _compareTickers = tickerList.slice(0, 4).concat(['','','','']).slice(0, 4);
  showPage('compare');   // showPage redirects 'compare' → scanner with compare tab selected
}

// ── Table rendering ───────────────────────────────────────────────────────────

function _renderCompareTable(tickers) {
  const rows = _compareRows(tickers);
  const headers = tickers.map(t => {
    const d = _compareData[t] || {};
    const price = d.current_price != null ? `$${d.current_price.toFixed(2)}` : '—';
    const sector = d.sector || '';
    return `<th style="text-align:center;padding:8px 12px;min-width:110px">
      <div style="font-size:15px;font-weight:700;color:var(--text-primary)">${escapeHTML(t)}</div>
      <div style="font-size:12px;color:var(--accent);font-weight:600">${price}</div>
      ${sector ? `<div style="font-size:10px;color:var(--text-muted)">${escapeHTML(sector)}</div>` : ''}
    </th>`;
  }).join('');

  const tableRows = rows.map(row => {
    const cells = tickers.map(t => {
      const d = _compareData[t] || {};
      return `<td style="text-align:center;padding:5px 10px">${_formatCell(row.key, d, row.fmt)}</td>`;
    }).join('');
    return `<tr style="border-bottom:0.5px solid var(--border-light)">
      <td style="padding:5px 10px;font-size:12px;color:var(--text-muted);white-space:nowrap;font-weight:500">${row.label}</td>
      ${cells}
    </tr>`;
  }).join('');

  // Best/worst highlights
  const scoreLine = tickers.map(t => {
    const s = (_compareData[t]?.score ?? 0);
    return { t, s };
  });
  const bestScore = Math.max(...scoreLine.map(x => x.s));
  const scoreCards = scoreLine.map(({ t, s }) => {
    const pct  = bestScore > 0 ? (s / bestScore) * 100 : 0;
    const col  = s >= 60 ? '#22c55e' : s >= 40 ? '#f59e0b' : '#ef4444';
    return `<div style="flex:1;min-width:80px;text-align:center">
      <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">${escapeHTML(t)}</div>
      <div style="height:60px;display:flex;align-items:flex-end;justify-content:center;margin-bottom:4px">
        <div style="width:36px;background:${col};border-radius:4px 4px 0 0;height:${Math.max(8,pct)}%;transition:height .4s"></div>
      </div>
      <div style="font-size:16px;font-weight:700;color:${col}">${s != null ? Math.round(s) : '—'}</div>
      <div style="font-size:10px;color:var(--text-muted)">Score</div>
    </div>`;
  }).join('');

  return `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;gap:16px;justify-content:center;padding:8px 0 16px">
        ${scoreCards}
      </div>
    </div>
    <div class="card" style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead style="border-bottom:1px solid var(--border)">
          <tr>
            <th style="text-align:left;padding:8px 10px;font-size:11px;color:var(--text-muted);font-weight:500;white-space:nowrap">Indicator</th>
            ${headers}
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div class="text-xs text-muted" style="margin-top:8px">
      Signals from <code>GET /api/analyse/batch</code> (5-min cache). Color: &#128994; bullish / &#128992; neutral / &#128308; bearish.
    </div>`;
}

// Row definitions: { label, key, fmt }
function _compareRows(tickers) {
  return [
    // ── Price & volume ──────────────────────────────────────────────────
    { label: 'Price',          key: 'current_price',    fmt: 'price'  },
    { label: '20d Avg Volume', key: 'adv_20',           fmt: 'adv'    },
    { label: 'ADV/20d ($M)',   key: 'adv_20',           fmt: 'adv_m'  },
    // ── Trend ───────────────────────────────────────────────────────────
    { label: 'RSI (14)',       key: 'rsi_14',           fmt: 'rsi'    },
    { label: 'MACD Signal',    key: null,               fmt: 'macd'   },
    { label: 'SMA20',          key: 'sma_20',           fmt: 'sma20'  },
    { label: 'SMA50',          key: 'sma_50',           fmt: 'sma50'  },
    { label: '% above SMA20',  key: null,               fmt: 'vsma20' },
    // ── Momentum / volatility ────────────────────────────────────────────
    { label: 'BB %B',          key: null,               fmt: 'bbpb'   },
    { label: 'ATR14 (%)',      key: null,               fmt: 'atr'    },
    { label: 'Stoch %K',       key: 'stoch_k',          fmt: 'stoch'  },
    { label: 'CCI',            key: 'cci',              fmt: 'cci'    },
    // ── Strength ────────────────────────────────────────────────────────
    { label: 'ADX',            key: 'adx',              fmt: 'adx'    },
    { label: 'MFI',            key: 'mfi',              fmt: 'mfi'    },
    { label: 'OBV Trend',      key: null,               fmt: 'obv'    },
    // ── Returns ──────────────────────────────────────────────────────────
    { label: '1-week return',  key: 'return_5d',        fmt: 'ret1w'  },
    { label: '1-month return', key: 'return_20d',       fmt: 'ret1m'  },
    { label: '3-month return', key: 'return_60d',       fmt: 'ret3m'  },
    // ── Score ────────────────────────────────────────────────────────────
    { label: 'Composite Score',key: 'score',            fmt: 'score'  },
    { label: 'Buy signals',    key: null,               fmt: 'bsig'   },
    { label: 'Sell signals',   key: null,               fmt: 'ssig'   },
  ];
}

function _formatCell(key, d, fmt) {
  const pct    = (v, dec=1) => v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(dec)}%` : '—';
  const num    = (v, dec=2) => v != null ? v.toFixed(dec) : '—';
  const pill   = (txt, col) =>
    `<span style="background:${col};color:#fff;border-radius:9px;padding:1px 8px;font-size:10px;font-weight:600">${txt}</span>`;

  const bullPill = t => pill(t, '#166534');
  const bearPill = t => pill(t, '#7f1d1d');
  const neutPill = t => pill(t, '#78716c');
  const dot = (bullish, neutral=false) => neutral ? '&#9898;'
    : bullish ? '<span style="color:#22c55e">&#9679;</span>'
               : '<span style="color:#ef4444">&#9679;</span>';

  switch (fmt) {
    case 'price': {
      const v = d.current_price;
      return v != null ? `<strong>$${v.toFixed(2)}</strong>` : '—';
    }
    case 'adv': {
      const v = d.volume_avg_20;
      if (v == null) return '—';
      return v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : `${(v/1e3).toFixed(0)}K`;
    }
    case 'adv_m': {
      const v = d.adv_20;
      if (v == null) return '—';
      const m = v / 1e6;
      const col = m >= 5 ? '#22c55e' : m >= 1 ? '#f59e0b' : '#ef4444';
      return `<span style="color:${col};font-weight:600">$${m.toFixed(1)}M</span>`;
    }
    case 'rsi': {
      const v = d.rsi_14;
      if (v == null) return '—';
      const col = v > 70 ? '#ef4444' : v < 30 ? '#22c55e' : v > 60 ? '#f59e0b' : '#6b7280';
      const label = v > 70 ? 'overbought' : v < 30 ? 'oversold' : '';
      return `<span style="color:${col};font-weight:600">${v.toFixed(1)}</span>`
           + (label ? `<br><span style="font-size:9px;color:${col}">${label}</span>` : '');
    }
    case 'macd': {
      const bullish = (d.trend_signals != null) ? d.trend_signals.macd_bullish
                    : (d.macd_line != null && d.macd_signal != null) ? d.macd_line > d.macd_signal : null;
      const rising  = (d.trend_signals != null) ? d.trend_signals.macd_hist_positive
                    : (d.macd_hist != null) ? d.macd_hist > 0 : null;
      if (bullish == null) return '—';
      return dot(bullish) + ' '
           + (bullish ? bullPill('bullish') : bearPill('bearish'))
           + (rising != null ? ` ${dot(rising)} hist ${rising ? '+' : '−'}` : '');
    }
    case 'sma20': {
      const v = d.sma_20; const p = d.current_price;
      if (v == null || p == null) return '—';
      const above = p > v;
      return `<span style="color:var(--text-muted)">${v.toFixed(2)}</span> `
           + dot(above);
    }
    case 'sma50': {
      const v = d.sma_50; const p = d.current_price;
      if (v == null || p == null) return '—';
      const above = p > v;
      return `<span style="color:var(--text-muted)">${v.toFixed(2)}</span> `
           + dot(above);
    }
    case 'vsma20': {
      const v = d.sma_20; const p = d.current_price;
      if (v == null || p == null) return '—';
      const delta = ((p - v) / v) * 100;
      const col = delta > 5 ? '#22c55e' : delta < -5 ? '#ef4444' : '#f59e0b';
      return `<span style="color:${col};font-weight:600">${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%</span>`;
    }
    case 'bbpb': {
      // BB %B = (price - lower) / (upper - lower)
      const lo = d.bb_lower; const hi = d.bb_upper; const p = d.current_price;
      if (lo == null || hi == null || p == null || hi === lo) return '—';
      const pbVal = (p - lo) / (hi - lo);
      const col = pbVal > 1 ? '#ef4444' : pbVal < 0 ? '#22c55e' : pbVal > 0.8 ? '#f59e0b' : '#6b7280';
      return `<span style="color:${col};font-weight:600">${(pbVal * 100).toFixed(0)}%</span>`;
    }
    case 'atr': {
      const v = d.atr_14; const p = d.current_price;
      if (v == null || p == null) return '—';
      const atrPct = (v / p) * 100;
      const col = atrPct > 3 ? '#ef4444' : atrPct > 1.5 ? '#f59e0b' : '#22c55e';
      return `<span style="color:${col}">${atrPct.toFixed(1)}%</span>`;
    }
    case 'stoch': {
      const v = d.stoch_k;
      if (v == null) return '—';
      const col = v > 80 ? '#ef4444' : v < 20 ? '#22c55e' : '#6b7280';
      return `<span style="color:${col}">${v.toFixed(0)}</span>`;
    }
    case 'cci': {
      const v = d.cci != null ? d.cci : d.cci_14;
      if (v == null) return '—';
      const col = v > 100 ? '#ef4444' : v < -100 ? '#22c55e' : '#6b7280';
      return `<span style="color:${col}">${v.toFixed(0)}</span>`;
    }
    case 'adx': {
      const v = d.adx;
      if (v == null) return '—';
      const label = v > 40 ? 'strong' : v > 25 ? 'trending' : 'weak';
      const col   = v > 25 ? '#6366f1' : '#6b7280';
      return `<span style="color:${col};font-weight:600">${v.toFixed(0)}</span>`
           + ` <span style="font-size:9px;color:${col}">${label}</span>`;
    }
    case 'mfi': {
      const v = d.mfi != null ? d.mfi : d.mfi_14;
      if (v == null) return '—';
      const col = v > 80 ? '#ef4444' : v < 20 ? '#22c55e' : '#6b7280';
      return `<span style="color:${col}">${v.toFixed(0)}</span>`;
    }
    case 'obv': {
      const v = d.obv_trend ?? d.obv_signal;
      if (v == null) return '—';
      return v === 'rising' ? bullPill('&#8593; rising') : bearPill('&#8595; falling');
    }
    case 'ret1w': {
      const v = d.return_5d ?? d.return_1w;
      if (v == null) return '—';
      const col = v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#6b7280';
      return `<span style="color:${col};font-weight:600">${pct(v)}</span>`;
    }
    case 'ret1m': {
      const v = d.return_20d ?? d.return_1m;
      if (v == null) return '—';
      const col = v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#6b7280';
      return `<span style="color:${col};font-weight:600">${pct(v)}</span>`;
    }
    case 'ret3m': {
      const v = d.return_60d ?? d.return_3m;
      if (v == null) return '—';
      const col = v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#6b7280';
      return `<span style="color:${col};font-weight:600">${pct(v)}</span>`;
    }
    case 'score': {
      const v = d.score;
      if (v == null) return '—';
      const col = v >= 60 ? '#22c55e' : v >= 40 ? '#f59e0b' : '#ef4444';
      return `<strong style="color:${col};font-size:14px">${Math.round(v)}</strong><span style="font-size:10px;color:var(--text-muted)">/100</span>`;
    }
    case 'bsig': {
      const v = d.buy_signals;
      if (!Array.isArray(v) || !v.length) return '<span style="color:var(--text-muted)">none</span>';
      return `<span style="color:#22c55e;font-size:10px">${escapeHTML(v.slice(0,2).join(', '))}${v.length > 2 ? ` +${v.length-2}` : ''}</span>`;
    }
    case 'ssig': {
      const v = d.sell_signals;
      if (!Array.isArray(v) || !v.length) return '<span style="color:var(--text-muted)">none</span>';
      return `<span style="color:#ef4444;font-size:10px">${escapeHTML(v.slice(0,2).join(', '))}${v.length > 2 ? ` +${v.length-2}` : ''}</span>`;
    }
    default: {
      const v = key ? d[key] : null;
      return v != null ? String(v) : '—';
    }
  }
}
