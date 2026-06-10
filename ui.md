# UI Redesign Spec — "Quiet Terminal"

**Status:** design spec, ready to implement (2026-06-11)
**Target:** `asx_trading.css` (single stylesheet), `asx_trading.html` (head only), `js/charts.js` (palette helper), `js/pages/settings.js` + `js/init.js` (theme toggle, Phase D only).
**Audience:** implementing agent. Everything needed is in this file; exact values are normative.

---

## 1. Design direction

**Identity: a quiet, confident trading terminal.** Think Linear's restraint + a Bloomberg-grade
respect for numbers. The app is a dense, data-first decision tool used daily, often during market
hours, often in dark rooms. The design should disappear behind the data.

Principles (every decision below derives from these):

1. **Numbers are the heroes.** Tabular numerals everywhere data appears; prices/P&L visually
   distinct from prose; red/green reserved exclusively for direction (never decoration).
2. **Hierarchy from weight and space, not boxes.** Fewer visible borders; elevation via soft
   shadow in light mode and surface-lightness steps in dark mode.
3. **Dark mode is first-class**, not an afterthought — traders live in it. Cool-dark surfaces,
   desaturated accents, glare-free greens/reds.
4. **Motion is information.** 120–180 ms transitions on state change only; nothing animates idly.
   `prefers-reduced-motion` always respected.
5. **No framework, no build step.** Vanilla CSS in the existing single file. No CDN fonts (app
   must work offline / over file://). System font stack, upgraded.

### Hard constraints (do not violate)

- **Do not rename any class or ID.** All HTML is built as JS strings across 27 page files; the
  redesign restyles existing selectors only.
- **Do not touch** the mobile block (`@media (max-width:768px)`), `.tbl-stack` stacked-card CSS,
  safe-area insets, or `.compact` density mode — they shipped recently (IMPROVEMENTS.md §7).
  New styles must compose with them.
- Page builders contain thousands of inline `style=""` attributes referencing CSS variables.
  The redesign works **through tokens**: change the variables, and 700+ inline usages follow.
- Keep `0.5px` hairline borders where borders remain — they render as true hairlines on the
  retina/mobile targets this app now supports.

---

## 2. Found bug the redesign must fix first

Inline styles reference two tokens that are **never defined** (they silently resolve to
inherit/initial today):

| Undefined token | Usages in `js/pages/*.js` | Define as |
|---|--:|---|
| `var(--text-muted)` | 314 | alias of `--text-secondary` |
| `var(--border)` | 91 | alias of `--border-light` |

Adding these two aliases instantly snaps ~400 inline styles into the design system — the single
highest-leverage line of the whole redesign. Do this in Phase A, first.

---

## 3. Design tokens (normative)

Replace the current `:root` and dark-mode blocks (`asx_trading.css:1-29`) with the following.
Structure: light tokens on `:root`, dark on `@media (prefers-color-scheme: dark)` scoped to
`:root:not([data-theme="light"])`, plus an explicit `:root[data-theme="dark"]` copy — this keeps
auto-detection AND enables the Phase D manual toggle without re-declaring anything else.

```css
:root {
  /* ── Surfaces (light) — warm paper, kept from current identity ── */
  --bg-base:      #f4f3f0;   /* app background (was --bg-tertiary #f1f0ec) */
  --bg-surface:   #ffffff;   /* cards, sidebar, topbar (was --bg-primary) */
  --bg-inset:     #f8f8f6;   /* wells inside cards: inputs, metric tiles (was --bg-secondary) */
  --bg-hover:     #f1f0ed;   /* row/button hover */

  /* ── Legacy aliases — KEEP: inline styles depend on these names ── */
  --bg-primary:   var(--bg-surface);
  --bg-secondary: var(--bg-inset);
  --bg-tertiary:  var(--bg-base);

  /* ── Text ── */
  --text-primary:   #1b1b1f;
  --text-secondary: #5f5f66;
  --text-tertiary:  #97979e;
  --text-muted:     var(--text-secondary);   /* ← fixes 314 undefined usages */

  /* ── Hairlines & borders ── */
  --border-light:  rgba(20, 20, 25, 0.08);
  --border-medium: rgba(20, 20, 25, 0.16);
  --border:        var(--border-light);      /* ← fixes 91 undefined usages */

  /* ── Accent (deeper, more confident blue) ── */
  --accent-primary: #2563eb;
  --accent-primary-bg: rgba(37, 99, 235, 0.08);
  --accent-ring: rgba(37, 99, 235, 0.35);    /* focus rings */

  /* ── Semantics — direction colors (match the hexes hardcoded in page builders) ── */
  --up:        #16a34a;      /* gains  — same family as the 164 hardcoded #16a34a */
  --down:      #dc2626;      /* losses — same family as the 138 hardcoded #dc2626 */
  --warn:      #d97706;
  --up-bg:     rgba(22, 163, 74, 0.10);
  --down-bg:   rgba(220, 38, 38, 0.10);
  --warn-bg:   rgba(217, 119, 6, 0.12);

  /* ── Elevation (light mode = shadow; dark mode zeroes these) ── */
  --shadow-card:  0 1px 2px rgba(20,20,25,.04), 0 2px 8px rgba(20,20,25,.04);
  --shadow-pop:   0 4px 12px rgba(20,20,25,.08), 0 12px 32px rgba(20,20,25,.10);
  --shadow-hover: 0 2px 6px rgba(20,20,25,.07), 0 6px 16px rgba(20,20,25,.06);

  /* ── Shape & type ── */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --font: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI Variable",
          "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono",
               Menlo, Consolas, monospace;

  /* ── Charts (read by JS via getComputedStyle — see §8) ── */
  --chart-1: #2563eb;  /* primary series  */
  --chart-2: #d97706;  /* secondary / SMA */
  --chart-3: #16a34a;  /* positive series */
  --chart-4: #dc2626;  /* negative series */
  --chart-5: #7c3aed;  /* benchmark / alt */
  --chart-6: #64748b;  /* neutral / cash  */
  --chart-grid: rgba(20, 20, 25, 0.07);
}

/* Dark theme — cool graphite, desaturated signals (glare-free) */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg-base:      #101114;
    --bg-surface:   #17181c;
    --bg-inset:     #1e2026;
    --bg-hover:     #22242b;

    --text-primary:   #e7e7ea;
    --text-secondary: #9b9ba3;
    --text-tertiary:  #5e5e66;

    --border-light:  rgba(255, 255, 255, 0.07);
    --border-medium: rgba(255, 255, 255, 0.14);

    --accent-primary: #6ea0ff;
    --accent-primary-bg: rgba(110, 160, 255, 0.10);
    --accent-ring: rgba(110, 160, 255, 0.35);

    --up:      #34c373;
    --down:    #f0564f;
    --warn:    #e8a13c;
    --up-bg:   rgba(52, 195, 115, 0.12);
    --down-bg: rgba(240, 86, 79, 0.12);
    --warn-bg: rgba(232, 161, 60, 0.13);

    /* Dark mode: elevation by surface lightness, not shadow */
    --shadow-card:  0 0 0 0.5px var(--border-light);
    --shadow-pop:   0 0 0 0.5px var(--border-medium), 0 16px 40px rgba(0,0,0,.45);
    --shadow-hover: 0 0 0 0.5px var(--border-medium);

    --chart-1: #6ea0ff;
    --chart-2: #e8a13c;
    --chart-3: #34c373;
    --chart-4: #f0564f;
    --chart-5: #a78bfa;
    --chart-6: #8a8f9c;
    --chart-grid: rgba(255, 255, 255, 0.06);
  }
}
/* Phase D manual override — identical token set, attribute-scoped */
:root[data-theme="dark"] { /* duplicate the dark block above verbatim */ }
```

**Note for the implementer:** the dark block must exist twice (media-scoped and
attribute-scoped). Keep them byte-identical; add a comment in each pointing at the other.

### Hardcoded-hex reconciliation (deliberate, not an oversight)

Page builders hardcode `#16a34a` (164×), `#dc2626` (138×), `#d97706` (93×), `#3b82f6` (55×) etc.
in inline styles. The light-theme tokens above are **chosen to match those exact hexes**, so no
mass find-replace is required for the redesign to look coherent. In dark mode the hardcoded
values are slightly more saturated than the tokens — acceptable. An optional later cleanup pass
can replace them with `var(--up)` / `var(--down)` / `var(--warn)` / `var(--accent-primary)`;
do NOT attempt it as part of this redesign (300+ call sites, high regression surface).

---

## 4. Typography & numerals

```css
body {
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
  background: var(--bg-base);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* THE single most impactful rule in this spec: data reads like a terminal. */
table, .metric-value, .metric-sub, .ind-val, .sr-level, .conf-bar + span,
.schedule-pill, .notif-time, code, .badge {
  font-variant-numeric: tabular-nums;
}
```

Type scale (use these sizes; do not invent intermediates):

| Role | Size / weight | Notes |
|---|---|---|
| Page title (`.topbar h2`) | 15px / 650 | `letter-spacing:-0.2px` |
| Card title (`.card-title`) | 11px / 600 | uppercase, `letter-spacing:0.7px`, `--text-tertiary` (demoted from secondary — titles should whisper) |
| Metric value (`.metric-value`) | 24px / 650 | `letter-spacing:-0.5px`, tabular-nums |
| Metric label | 11px / 500 | `--text-secondary` |
| Body / table cells | 13px / 400 | |
| Small / meta (`.text-xs`) | 11px / 400 | `--text-tertiary` for timestamps, `--text-secondary` for labels |

P&L deltas get a dedicated utility (additive — page builders already emit `.up`/`.down`):

```css
.up   { color: var(--up); }
.down { color: var(--down); }
.delta-chip {            /* optional utility for future use */
  display: inline-flex; align-items: center; gap: 3px;
  padding: 1px 7px; border-radius: 99px;
  font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.delta-chip.up   { background: var(--up-bg);   color: var(--up); }
.delta-chip.down { background: var(--down-bg); color: var(--down); }
```

---

## 5. App shell

### Sidebar (`asx_trading.css:35-49`)

Current: flat white column, hover = gray pill. New: rail with an **active indicator bar** and
quieter resting state.

```css
.sidebar { width: 228px; background: var(--bg-surface);
           border-right: 0.5px solid var(--border-light); }
.sidebar-logo h1 { font-size: 14px; font-weight: 700; letter-spacing: -0.2px; }
.sidebar-logo h1::before { content: "◳ "; color: var(--accent-primary); } /* tiny brand mark */
.sidebar-logo p { color: var(--text-tertiary); }

.nav-label { color: var(--text-tertiary); font-size: 10px; letter-spacing: 1px; }

.nav-item {
  position: relative;
  padding: 7px 10px 7px 14px;
  color: var(--text-secondary);
  border-radius: var(--radius-md);
  transition: background .12s ease, color .12s ease;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.nav-item.active {
  background: var(--accent-primary-bg);
  color: var(--accent-primary);
  font-weight: 600;
}
.nav-item.active::before {       /* the indicator bar */
  content: ""; position: absolute; left: 0; top: 20%; bottom: 20%;
  width: 2.5px; border-radius: 2px; background: var(--accent-primary);
}
.nav-icon { opacity: 0.75; }
.nav-item.active .nav-icon { opacity: 1; }
```

### Topbar (`asx_trading.css:53`)

Make it sticky with a translucent blur — the one tasteful "glass" moment in the app:

```css
.topbar {
  position: sticky; top: 0; z-index: 50;
  background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  border-bottom: 0.5px solid var(--border-light);
}
@supports not (backdrop-filter: blur(12px)) {
  .topbar { background: var(--bg-surface); }
}
```

(The `.main` container scrolls, so sticky works within it. Keep the existing safe-area
`padding-top` rule — it composes.) `.market-pill` gets `background: var(--bg-inset)` and loses
its border; the live dot stays.

---

## 6. Components

### Cards (`asx_trading.css:61`)

Borders → elevation. This transforms the entire app since everything lives in `.card`:

```css
.card {
  background: var(--bg-surface);
  border: 0.5px solid var(--border-light);
  border-radius: var(--radius-lg);
  padding: 1.25rem;
  box-shadow: var(--shadow-card);
}
.metric-card { background: var(--bg-inset); border-radius: var(--radius-md); }
.metric-card .metric-value.up   { color: var(--up); }
.metric-card .metric-value.down { color: var(--down); }
```

`.rec-card` gets the same shadow treatment plus a smooth hover lift:

```css
.rec-card { box-shadow: var(--shadow-card); transition: box-shadow .15s ease, border-color .15s ease; }
.rec-card:hover { box-shadow: var(--shadow-hover); border-color: var(--border-medium); }
/* keep the existing executed/skipped left-border accents — they're good information design */
```

### Tables (`asx_trading.css:78-83`)

```css
th {
  font-size: 10.5px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.6px; color: var(--text-tertiary);
  padding: 8px 12px;
}
td { padding: 9px 12px; font-size: 13px; }
tr { transition: background .1s ease; }
tr:hover td { background: var(--bg-hover); }   /* token swap; hover:none guard already exists */
```

Keep the existing sticky-header and `.tbl-stack` rules untouched. **No zebra striping** — row
hover + hairlines is the terminal look; zebra fights the badge tints.

### Badges (`asx_trading.css:86-109`)

Modernise to **tint + dot** style and collapse the duplicated dark-mode override block
(`css:99-109`) by building badges from semantic tokens:

```css
.badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 99px;       /* pill, not 4px rect */
  font-size: 11px; font-weight: 600; letter-spacing: 0.2px;
}
.badge::before { content: ""; width: 5px; height: 5px; border-radius: 50%;
                 background: currentColor; opacity: .8; }
.badge-buy,  .badge-topup            { background: var(--up-bg);    color: var(--up); }
.badge-sell                          { background: var(--down-bg);  color: var(--down); }
.badge-trim, .badge-hold, .badge-pending { background: var(--warn-bg); color: var(--warn); }
.badge-executed, .badge-open         { background: var(--accent-primary-bg); color: var(--accent-primary); }
.badge-drp                           { background: rgba(124,58,237,.10); color: #7c3aed; }
.badge-skipped, .badge-closed, .badge-neutral
  { background: var(--bg-inset); color: var(--text-secondary); }
.badge-skipped::before, .badge-neutral::before { opacity: .5; }
```

Then **delete** the `@media (prefers-color-scheme: dark)` badge override block at `css:99-109`
and the chip overrides at `css:140-143` — the tokens now carry the theme. (Verify each deleted
class is covered above; `.chip-buy/.chip-sell` should be rebuilt the same way.)

### Buttons (`asx_trading.css:112-121`)

Primary action becomes accent-colored (currently inverted-black — reads as disabled in dark mode):

```css
.btn {
  border: 0.5px solid var(--border-medium);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  font-weight: 500;
  transition: background .12s ease, border-color .12s ease,
              box-shadow .12s ease, transform .05s ease;
}
.btn:hover { background: var(--bg-hover); border-color: var(--border-medium); }
.btn:active { transform: scale(0.98); }
.btn-primary {
  background: var(--accent-primary); border-color: var(--accent-primary);
  color: #fff; box-shadow: 0 1px 2px rgba(37,99,235,.25);
}
.btn-primary:hover { filter: brightness(1.08); background: var(--accent-primary); opacity: 1; }
.btn-danger  { border-color: transparent; background: var(--down-bg); color: var(--down); }
.btn-danger:hover  { background: var(--down-bg); filter: brightness(.96); }
.btn-success { border-color: transparent; background: var(--up-bg); color: var(--up); }
```

(Dark-mode `#fff` text on `--accent-primary #6ea0ff` fails contrast — in the dark token block
add `.btn-primary { color: #0d1220; }` or define `--accent-contrast` per theme. Implementer:
define `--accent-contrast: #ffffff` light / `#0d1220` dark and use it.)

### Inputs (`asx_trading.css:190-196`)

```css
input[type="text"], input[type="number"], input[type="password"], textarea, select {
  background: var(--bg-inset);
  border: 0.5px solid var(--border-light);
  border-radius: var(--radius-md);
  transition: border-color .12s ease, box-shadow .12s ease;
}
input:focus, textarea:focus, select:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
```

The focus ring is also the **global keyboard-focus treatment**:

```css
:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); border-radius: var(--radius-sm); }
```

### Tabs (`asx_trading.css:199-202`)

Keep the underline pattern (it's correct for content tabs) but soften: remove the full-width
`border-bottom: 2px` on `.tabs` (replace with 0.5px hairline), active underline 2px accent,
hover = text color change only. Active tab keeps `--accent-primary-bg` wash.

### Toasts (`asx_trading.css:212-214`)

```css
.toast {
  background: var(--bg-surface);
  border: 0.5px solid var(--border-light);
  border-left-width: 3px;            /* existing JS sets borderLeft color — keep working */
  box-shadow: var(--shadow-pop);
  border-radius: var(--radius-md);
  animation: slideIn .18s cubic-bezier(.2,.8,.3,1);
}
```

(`js/utils.js toast()` sets `el.style.borderLeft = '3px solid <color>'` inline — the rule above
must not fight it; only restyle the box.)

### Modals (`navigation.js:118` dialog)

The dialog's inline cssText references `var(--border)` and `var(--bg-primary)` — both resolve
correctly after Phase A. Add CSS for the native backdrop:

```css
dialog::backdrop { background: rgba(10, 10, 14, 0.45); -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px); }
dialog { box-shadow: var(--shadow-pop); border-radius: var(--radius-lg) !important; }
```

### Empty states & loading

`.empty-state` icons: `opacity .25`, add `filter: grayscale(1)`. Add a skeleton shimmer utility
(JS opt-in later; ship the CSS now):

```css
.skeleton {
  background: linear-gradient(90deg, var(--bg-inset) 25%, var(--bg-hover) 50%, var(--bg-inset) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
  border-radius: var(--radius-sm);
  color: transparent !important;
}
@keyframes shimmer { to { background-position: -200% 0; } }
```

### Scrollbars (`asx_trading.css:246-248`)

```css
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--border-medium); border-radius: 99px;
                            border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: var(--text-tertiary); }
* { scrollbar-width: thin; scrollbar-color: var(--border-medium) transparent; }
```

---

## 7. Motion

One global rule set; no per-component improvisation:

```css
/* State changes only. Durations: 120ms (hover), 180ms (enter), 240ms (overlay). */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
```

Allowed animations: toast slide-in, skeleton shimmer, sidebar drawer (exists), pulse on
`.live-dot`/`.server-dot` (exists), button active scale. **Nothing else.** Specifically: no
card entrance animations, no animated numbers, no chart draw-in.

---

## 8. Charts (js/charts.js)

Charts currently hardcode hex colors (`#3b82f6` ×5, `#f59e0b` ×4, `#94a3b8` ×4, `#4ade80`,
`#f87171`, …) that won't follow the theme. Add one helper at the top of `charts.js`:

```js
// Resolve a CSS custom property at draw time so canvases follow the active theme.
function chartColor(token, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return v || fallback;
}
```

Replacement map (keep fallbacks = current values so nothing breaks if a token is missing):

| Current hardcoded | Replace with |
|---|---|
| `#3b82f6` (price/primary lines) | `chartColor('--chart-1', '#3b82f6')` |
| `#f59e0b` (SMA20/secondary) | `chartColor('--chart-2', '#f59e0b')` |
| `#4ade80` / `#22c55e` / `#16a34a` (positive) | `chartColor('--chart-3', '#16a34a')` |
| `#f87171` / `#dc2626` / `#fca5a5` (negative) | `chartColor('--chart-4', '#dc2626')` |
| `#a78bfa` (benchmark) | `chartColor('--chart-5', '#a78bfa')` |
| `#94a3b8` / `#cbd5e1` (axes, grid, neutral) | `chartColor('--chart-grid', '#94a3b8')` for grid lines, `chartColor('--chart-6', '#94a3b8')` for neutral series |

Gradient fills (sparkline already does `color+'44'` alpha-suffix): this only works with hex —
`chartColor` returns hex from the tokens above, so the pattern survives. Verify each
`+'44'`/`+'00'` suffix site still receives a 6-digit hex.

Axis label color: use `chartColor('--text-tertiary', '#9b9b9b')` where `#666`/`#9b9b9b` appear.
Do the same pass in the page-level draws (`pages/backtest.js`, `pages/journal.js`,
`pages/signals.js`, `pages/performance.js`, `pages/risk.js`) **only for color**, not sizing.

---

## 9. Theme toggle (Phase D)

- `state.settings.theme: 'auto' | 'light' | 'dark'` (default `'auto'`; persists via existing
  settings save path — it's inside `state.settings`, no backend change needed).
- `js/init.js` startup + Settings → Display segmented control:
  `document.documentElement.dataset.theme = (theme === 'auto' ? '' : theme)` — empty removes the
  attribute so the `prefers-color-scheme` block applies.
- Update `<meta name="theme-color">` dynamically: `#f4f3f0` light / `#101114` dark (PWA chrome).
- The `:root[data-theme="dark"]` token block from §3 makes this pure attribute-driven — no other
  CSS work.

---

## 10. Implementation phases

| Phase | Scope | Files | Risk |
|---|---|---|---|
| **A — Tokens** | New `:root` + dark blocks; `--text-muted`/`--border` aliases; body typography + tabular-nums; scrollbars; motion guard | `asx_trading.css` only | Low — pure token swap, inline styles follow automatically |
| **B — Components** | Sidebar, topbar, cards, tables, badges (incl. deleting the dark override block), buttons (+`--accent-contrast`), inputs, focus ring, tabs, toasts, dialog backdrop, empty/skeleton | `asx_trading.css` only | Low-Med — verify badge classes one by one |
| **C — Charts** | `chartColor()` helper + hex replacement map (§8) | `js/charts.js`, 5 page files (color only) | Low — fallbacks preserve current look |
| **D — Theme toggle** | settings field + segmented control + `data-theme` + theme-color meta | `settings.js`, `init.js`, `config.js`, `asx_trading.css` (attr block) | Low |

Each phase ships independently. A+B is ~90% of the visual change.

### Verification (after each phase)

1. `python test_app.py` (JS syntax checks cover every modified file) + `npm run test:js`.
2. `node --check` on any touched JS.
3. Browser smoke in BOTH themes: Dashboard, Portfolio (expand lots), Recommendations (rec cards
   + history table), Learning (events table + badges), Scanner (tabs + candle chart), Settings.
4. Mobile spot-check at 390px: drawer, stacked tables, topbar scroll — must look identical to
   pre-redesign behaviour (only colors/shadows change).
5. Compact mode toggle still densifies correctly.
6. Contrast: `--text-secondary` on `--bg-surface` ≥ 4.5:1 in both themes; `.btn-primary` text vs
   fill ≥ 4.5:1 (this is why `--accent-contrast` exists).

### Don't-break list (final check)

- [ ] No class/ID renamed; no HTML structure edits outside `<head>`.
- [ ] `.compact`, mobile `@media` block, `.tbl-stack`, safe-area rules untouched.
- [ ] `toast()`'s inline `borderLeft` still visible (border-left-width 3px preserved).
- [ ] Notification panel (`.notif-*`) restyled with tokens only — its `z-index:9999` and
      positioning untouched.
- [ ] Badge dark-mode block deleted ONLY after every `.badge-*` class is token-driven.
- [ ] Charts render identically when tokens are missing (fallback args verified).
- [ ] `PROMPT_VERSION`/backend untouched — this is a pure presentation change.
