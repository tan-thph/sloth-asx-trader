# Forven UI/UX + Feature Adoption Plan (2026-06-23)

Source repo reviewed: [`judder659/Forven`](https://github.com/judder659/Forven) — an open-source, self-hosted autonomous **crypto** trading research/ops workspace (Python/FastAPI backend, SvelteKit 2 + Svelte 5 + Tailwind frontend, paper trading on Hyperliquid testnet).

This is a planning document only — no code has been changed. It's written for a separate worker to execute. Each item has a `Status: Not started` field to track progress.

**Update (2026-06-24):** Implemented. Scope: Section 1 (terminal theme) + §2.1/§2.3/§2.4/§2.5 + the §3 coverage-matrix restyle. §2.2 confirmed unnecessary and skipped (every Settings field already auto-saves — no "dirty" state exists to track). §2.6/§2.7 and the Gauntlet-style backtest additions deferred per explicit user decision, not part of this pass. Final verification: `python test_app.py` (796/796) and `npm run test:js` (154/154) both green; `node --check` clean on every touched file; no CDN/external-URL dependency introduced anywhere in the diff.

**Update (2026-06-24, same day) — §1 VALUES CORRECTION, action required:** The implemented `terminal` theme (§1, marked Done above) was built from the GitHub repo's `app.css` only, which uses approximate/inferred colors and shipped with **no real font file** (falls back to system-mono). The actual production site (`https://forven.app/`) was inspected directly (page HTML + served CSS, not just the repo) and gives exact, verified source-of-truth values that differ from what was guessed. **§1.5 below replaces the color/font specifics in the "Proposed implementation" section — re-open this item and reconcile the shipped CSS against these verified values.** Status reverted to **Needs follow-up** for the color/font specifics only; the mechanism (new `data-theme="terminal"` value, `_applyTheme()` wiring, radius-token override) stays as already implemented.

### 1.5 Verified values from the live site (supersedes the repo-only guesses above)

Pulled directly from `https://forven.app/`'s served HTML and CSS (not the GitHub source, which doesn't include the marketing site):

**Font — confirmed exact, and it's legitimately self-hostable:**
- It really is **JetBrains Mono** (variable weight 100–800), shipped as `@font-face` with `font-display:swap`, split into per-unicode-range woff2 subsets (Latin/Cyrillic/Greek/Vietnamese/etc. as separate files — only the Latin subset is needed here).
- JetBrains Mono is **SIL Open Font License** — free to redistribute and self-host, no attribution-in-UI requirement. Download from JetBrains' own GitHub releases (`JetBrains/JetBrainsMono`) or Google Fonts; do not hotlink Google Fonts CDN (violates the no-CDN constraint already noted below).
- They also define a **metric-matched fallback** — `font-face { font-family: "JetBrains Mono Fallback"; src: local(Arial); ascent-override:75.79%; descent-override:22.29%; line-gap-override:0%; size-adjust:134.59% }` — so that if the real font hasn't loaded yet, the fallback (Arial, metric-adjusted) occupies the same line-height/width and text doesn't reflow when the webfont swaps in. **Adopt this technique**, not just the font name — it's the difference between a clean swap and a layout jump.

**Color palette — replaces the repo-inferred values in §1's "Proposed implementation":**
| Token (live site) | Hex | Suggested mapping to our existing token names |
|---|---|---|
| Page background | `#0a0b0d` | `--bg-base` (was guessed as `#000` — actual is a hair warmer) |
| Panel/surface | `#101214` | `--bg-surface` |
| Inset/recessed | `#0d0f11` | `--bg-inset` |
| Elevated surface | `#1c1e20` | `--bg-hover` |
| Primary text | `#fff` / `#fafafa` | `--text-primary` |
| Secondary text | `#9a9793` | `--text-secondary` |
| Tertiary/muted text | `#737373` / `#54585c` | `--text-tertiary` |
| Borders | `#171717` (and `#1717171a`/`#0000001a` alpha hairlines) | `--border-light`/`--border-medium` |
| **Brand accent (orange)** | `#ff6b1a` (base), `#ff8a3d` (hover/lighter) | new — this is the *actual* brand color, matching the small orange square in the GitHub sidebar logo; not currently represented in our theme. Use sparingly (active nav indicator, sidebar logo dot, primary CTA) — Forven itself uses it sparingly against the black/white field, it is not a background color. |
| Success | `#46d08a` | `--up` |
| Danger | `#f5736f` (soft) / `#fb2c36` (saturated, likely error-state emphasis) | `--down` |

This is a **warmer, slightly-blue-black** palette (`#0a0b0d`/`#101214`), not a pure `#000`/`#0a0a0a` true-black like the repo's `app.css` suggested — close enough that it's a values tweak, not a rework, but worth correcting since "I really like their theme" implies the user is reacting to what they saw on the live site/screenshots, which uses these exact values.

**Corners — refines the "sharp corners everywhere" claim in §1:** the live site is *not* uniformly `rounded-none`. Observed radii: `2px` (most common — buttons/inputs), `3px`/`5px` (cards), `9999px` (fully-rounded pill badges/tags only), plus a few CSS-variable radii (`--radius-md/lg/xl/2xl`) on larger containers. **Recommendation:** keep the already-implemented `rounded-none` (0px) for the in-app terminal theme — that matches the GitHub app screenshots and the Bloomberg-terminal feel the user is after — but if pixel-fidelity to the marketing site specifically is wanted, switch to `2px` instead of `0px` and keep status-badges/pills fully rounded (`9999px`) rather than square. **This needs a user decision, not an assumption** — ask before changing what's already shipped.

**Typography details to fold in:**
- Uppercase micro-labels use tight positive letter-spacing: `.12em`–`.18em` (we likely already have something close via the existing `tracking-wide` style used in `.nav-label`/section headers — verify and align, don't introduce a third spacing scale).
- Large headline text uses *negative* tracking (`-.03em` to `-.05em`) — not relevant to this app's dense data-table UI, skip; we don't have marketing-style headlines.

---

## 0. Framework reality check (read this before implementing anything)

Forven and this app (`sloth-asx-trader`) are **not** the same stack, and the gap matters more than it looks:

| | Forven | sloth-asx-trader |
|---|---|---|
| Frontend | SvelteKit 2, Svelte 5, **Tailwind CSS**, Vite build | Vanilla JS, no bundler, `<script>` tags loaded in a fixed order (see CLAUDE.md "Frontend (JS) — load order matters") |
| Components | `.svelte` files, reactive stores | Plain JS render functions returning HTML strings (`renderX()`) |
| Charts | Custom SVG components (`Sparkline.svelte`, `CandlestickChart.svelte`, etc.) | `<canvas>` only — **CLAUDE.md explicitly says "no chart libraries"** |
| Styling | Tailwind utility classes + `app.css` custom properties | Hand-rolled `asx_trading.css` with its own CSS-variable token system (`--bg-base/surface/inset`, `--text-primary/secondary/tertiary`, `--up/down/warn`, `--chart-1..6`, light/dark via `data-theme` attribute) |
| Must work over `file://` | No (dev server / build) | **Yes** — `js/config.js` falls back to `localhost:5000` only when opened as `file://`; no build step exists today |

**Conclusion: we cannot import Forven's code.** Nothing here should be "ported" — every item below is a **re-implementation of a visual/UX pattern or a feature concept**, built with the existing vanilla-JS render-function pattern and the existing CSS token system. Anything that would require Tailwind, Svelte, or a bundler is explicitly out of scope and flagged as a conflict below.

Good news: the gap is smaller than it first looks. This app **already has** the same skeleton Forven uses — a fixed left sidebar with grouped nav sections (`asx_trading.html:20-65`, `.sidebar`/`.nav-item`/`.nav-section` in `asx_trading.css`), a toast system (`toast()` in `js/utils.js:146`), a notification centre, a server-health indicator, and a light/dark theme token system (Sprint 60). So most of this plan is **restyling and extending what exists**, not building from scratch.

---

## 1. Visual theme adoption (the "I like their look" part)

Forven's look is a **Bloomberg-terminal-style, high-density, monochrome dark theme**:
- Pure black backgrounds (`#000`/`#0a0a0a`/`#111`), white text, a single accent color used sparingly (orange dot + wordmark in the sidebar logo).
- Monospace font everywhere (`JetBrains Mono` / `Geist Mono` / `Fira Code` fallback chain), 14px base, tight line-height (1.4).
- **Sharp corners everywhere** (`rounded-none` on every button/input/card) — deliberately anti-rounded, anti-"SaaS dashboard."
- Uppercase, letter-spaced labels on buttons and section headers (`tracking-wide uppercase font-bold`).
- Hover-inverts buttons (`terminal-button`: transparent border → white bg / black text on hover) rather than color-tinting.
- Thin 1px hairline borders (`#222`/`#333`) as the primary structural device instead of shadows/elevation.
- Minimal scrollbars (6px, square, no rounding).

**Status: Done.** `:root[data-theme="terminal"]` block added to `asx_trading.css` (additive, light/dark untouched); sharp corners via overriding `--radius-sm/md/lg` tokens to `0px` (flows through every existing consumer automatically); self-hosted `@font-face` for JetBrains Mono added but **no font file was fetched/fabricated** — falls back to the existing system-mono stack until someone drops `static/fonts/JetBrainsMono-{Regular,Bold}.woff2` in place; sidebar logo restyled in place. `'terminal'` added to the Settings → Display theme toggle. Bug found and fixed beyond the original plan: `_applyTheme()`'s `<meta name="theme-color">` logic only checked `theme==='dark'` — added a `'terminal'` branch so PWA/mobile chrome goes black under this theme too.

### Proposed implementation
Add this as a **new selectable theme value**, not a replacement for the existing light/dark themes (gotcha #40: theme is applied via `document.documentElement.dataset.theme`, never a body class — keep using this mechanism).

1. In `asx_trading.css`, add a third theme block: `:root[data-theme="terminal"] { ... }` defining the existing token names (`--bg-base/surface/inset`, `--text-primary/secondary/tertiary`, `--border-light/medium`, `--up/down/warn`, `--chart-1..6`, `--chart-grid`, `--shadow-card/pop/hover`) with terminal-theme values:
   - `--bg-base:#000; --bg-surface:#0a0a0a; --bg-inset:#111;`
   - `--text-primary:#fff; --text-secondary:#888; --text-tertiary:#555;`
   - `--border-light:#222; --border-medium:#333;`
   - Keep `--up`/`--down`/`--warn` close to Forven's `#22c55e`/`#ef4444`/`#eab308` but verify contrast against pure black (their values already target a black bg, should be fine).
   - `--chart-1..6` and `--chart-grid`: pick from the existing accessible palette, just darkened/desaturated to suit black backgrounds. `chartColor()` in `charts.js` already reads these at draw time — **no canvas code changes needed**, this is the main reason a CSS-token-only theme is low risk.
   - Set near-zero border-radius on cards/buttons/inputs *only within this theme* via a `[data-theme="terminal"]` attribute selector (don't touch the default radius tokens used by light/dark, to avoid regressing those themes).
2. Extend the Settings → Display segmented control (`state.settings.theme: 'auto'|'light'|'dark'`) to a third option `'terminal'`. `_applyTheme()` in `utils.js` already just sets/clears the attribute — add `'terminal'` to its accepted values (it currently treats anything non-`'auto'` as a direct `data-theme` set, so this should be a small, additive change — verify by reading the function body before editing, don't assume).
3. Font: add `JetBrains Mono` as the lead font **only inside `[data-theme="terminal"]`** via `@font-face` self-hosted in `static/fonts/` (do not pull from Google Fonts CDN — this is a local-only, possibly offline app; CLAUDE.md doesn't mention any existing CDN dependency and we shouldn't add one). Fall back to the existing system-monospace stack (`Consolas`/`SF Mono`/etc.) if the font file is missing, so a partial install doesn't break rendering.
4. Sidebar logo treatment: small accent-colored square + lowercase wordmark, mirroring `sidebar-logo` (`asx_trading.css:190-193`) — just restyle the existing element, don't restructure the DOM.

### Conflicts / risks to avoid
- **Do not hardcode hex colors in `charts.js`.** Gotcha #39 is explicit: every canvas draw must go through `chartColor(token, fallback)`. If the new theme is wired through CSS variables only (as above), this is automatically satisfied — but a worker eager to "match the exact terminal look" might be tempted to special-case canvas colors. Flag this explicitly.
- **Do not touch `.tbl-stack` mobile breakpoints or 44px touch targets** (Sprint 56 mobile work, gotcha #37) when restyling buttons/inputs for the sharp-corner look — verify at ≤640px after the change.
- **Self-hosted font file must be small and subset** (Latin only) — this is a local app, not a CDN-backed SaaS; don't add multi-hundred-KB font files that slow down `file://` loads.
- A pure-black extreme theme can clash with the existing `--shadow-card/pop/hover` tokens, which currently rely on light shadows for depth in light mode and `0 0 0 0.5px var(--border)` hairlines in dark mode (already close to what's needed) — reuse the dark-mode shadow approach rather than inventing a third shadow system.

---

## 2. Layout / UX patterns to adopt

These are structural patterns observed in Forven's SvelteKit components, re-described here as **vanilla-JS implementation targets** using the existing render-function + CSS-class pattern.

### 2.1 Page header: title + one-line description
**Source:** Forven's `+layout.svelte` resolves a per-route `TITLE_OVERRIDES`/`DESCRIPTION_OVERRIDES` map and renders it as a header above the page body.
**Status: Done.** `PAGE_META` (20 page IDs) added to `js/navigation.js`, rendered into a new `#page-header-block` DOM node — a sibling created before `#main-content`, not inside it — so it's structurally unreachable from a page-body crash, not just incidentally untouched. CSS appended to `asx_trading.css` (themes automatically via existing tokens).
**Fit:** Very easy. Add a `PAGE_META` lookup (ticker→{title, description}) keyed by the existing `showPage(page)` page-id strings already used in `navigation.js`/`asx_trading.html`'s `onclick="showPage('...')"` calls. Render a small header block at the top of `renderPage()`'s wrapper (in `navigation.js`) before delegating to the page's own `renderX()` — this keeps every page file untouched and centralizes the header in one place.
**Conflict check:** `navigation.js`'s error boundary (gotcha #11) wraps the actual page render in try/catch — make sure the new header renders *outside* that try/catch (or in its own try/catch) so a page crash doesn't also blank the header/page title.

### 2.2 Settings "unsaved changes" save bar
**Source:** Forven's `SettingsSaveBar.svelte` + `dirtyFields`/`originalValues`/`pendingValues` stores — a sticky bottom bar appears only when settings have unsaved edits, with Save/Discard actions.
**Status: Skipped — confirmed unnecessary.** Read `js/pages/settings.js` as instructed: `updateSetting()` calls `scheduleSave()` immediately on every field change (debounced 500ms, not a manual-save flow). There is no "unsaved" state to track, so a dirty-bar would be misleading UX exactly as this section warned. Cut from scope rather than built.
**Fit:** Good — `pages/settings.js` likely already writes directly to `state.settings` and persists via the DB save path; introducing a dirty-tracking pattern is a behavior change, not just styling. Treat this as a **UX improvement worth doing**, scoped narrowly: track a `_settingsDirty` flag set on input change, cleared on save, render a sticky bar (`position:sticky; bottom:0`) only on the Settings page when dirty.
**Conflict check:** Confirm how `pages/settings.js` currently saves (immediately per-field vs. batch) before designing this — if every input already auto-saves on change, a dirty-bar is misleading UX and shouldn't be added; if it does, this is a genuine win. **A worker must read `js/pages/settings.js` first and report back which save model is in use before implementing.**

### 2.3 Critical alerts banner (always-visible, dismissible only when resolved)
**Source:** Forven's `CriticalAlertsBanner.svelte` + `RiskDisclaimerBanner.svelte` — persistent banners above the main content area for risk/connection-critical states.
**Status: Done.** Implemented in `js/navigation.js` as `_renderSystemCriticalBanner()` — a FOURTH alert tier, deliberately named/classed `.system-critical-banner` (not `.critical-alert-banner`) to avoid colliding with the existing portfolio-specific banner of that name already in `portfolio-helpers.js` (price-decline alerts). Renders into its own `#system-banner-block` DOM node, same crash-isolation pattern as the page header (2.1), positioned above it. Triggers exactly the doc's suggested 4: backend unreachable, panic regime, heat budget breached (reuses the live-book risk calc from Improvements.md #2), stop pierced without exit. Refreshes on the existing 30s `checkServer()` heartbeat (no second poller) in addition to page navigation. Off by default — renders nothing when no condition is active.
**Fit:** This app already has the building blocks: a drawdown alert threshold (`state.settings.drawdownAlertPct`), a stop-proximity alert system, and a notification centre. What's missing is a **persistent, non-dismissible-while-active banner** (distinct from the toast/notification-drawer pattern, which is transient/historical). Add a `renderCriticalBanner()` helper called from the dashboard (and optionally globally in `navigation.js`'s page wrapper) that surfaces: panic regime active (`_regimeBlocked`), heat budget breached, any open position's stop pierced without exit, backend unreachable (`srv-dot` going red).
**Conflict check:** Don't duplicate the existing `server-indicator` dot in the sidebar (`asx_trading.html` bottom of sidebar) — this banner should escalate, not replace, that signal. Keep it OFF by default (no banner) when nothing critical is happening — don't introduce a permanently-visible empty bar that eats vertical space.

### 2.4 "Ops header strip" — always-on system status line
**Source:** Forven's `OpsHeaderStrip.svelte` — one line answering "is everything OK right now?": health dot, mode badge (paper/live), autopilot state, clock with staleness age of last successful poll.
**Status: Done.** `_buildOpsStrip()`/`_refreshOpsStrip()`/`_updateOpsStripClock()` added to `js/pages/dashboard.js`, rendered at the top of `renderDashboard()`. Reuses `GET /health` (now stashed on `state._health` by the existing `checkServer()`) and the existing 30s heartbeat + 5s clock tick in `js/scheduler.js` — no second poller. Renders `[● connected] [regime: X] [DB ok] [backup Nd ago] [HH:MM]`.
**Fit:** Strong conceptual fit for the Dashboard page specifically (not global — avoid sidebar duplication, see 2.3). This app already has analogous signals scattered: `srv-dot`/`srv-label` (server reachability), `db-label` (DB status), current regime badge, last-backup timestamp (via `/health`). Consolidate these into one compact strip at the top of the Dashboard page: `[● connected] [regime: riskOn] [DB ok] [backup 2h ago] [14:32:05]`.
**Conflict check:** `GET /health` already returns `{status, time, version, uptime_s, last_backup}` (CLAUDE.md backend reference) — reuse this endpoint, don't add a new one. Poll on the same cadence as the existing `srv-dot` heartbeat check (find and reuse that interval in `init.js`/`api.js` rather than adding a second poller).

### 2.5 Sparkline mini-charts in tables/rows
**Source:** Forven's `Sparkline.svelte`/`ConfidenceSparkline.svelte` — tiny inline trend lines (SVG) in table rows and cards.
**Status: Done — Watchlist only** (per explicit scope decision; Dashboard/Scanner deferred). `_drawSparkline(canvas, values)` added to `js/charts.js` (canvas-only, all colors via `chartColor()`, handles empty/single-value/flat-series edge cases). Wired into a new "30d" column in `js/pages/watchlist.js`, reusing `state.liveSignals[ticker].chart_data` already fetched for the page — zero new network calls.
**Fit:** Good, but **must be implemented in `<canvas>`, not inline SVG**, to stay consistent with the existing "no chart libraries, canvas only" rule and the existing `chartColor()` theming helper. Add a small `_drawSparkline(canvas, values)` helper to `charts.js` (tiny canvas, no axes, single line, color via `chartColor('up'/'down', fallback)` based on first-vs-last value direction — mirrors Forven's `getColor()` logic exactly, just retargeted to canvas). Use it on the Watchlist page (price trend per ticker) and the Dashboard (portfolio holdings rows).
**Conflict check:** Many small canvases on one page = many `_fitCanvas()` calls (devicePixelRatio scaling, gotcha-adjacent perf concern). Cap usage to pages with bounded row counts (Watchlist, not the full ASX200 scanner table) to avoid perf regressions; benchmark before shipping if used on the Scanner page.

### 2.6 Diagnostics / system health page
**Source:** Forven's `/diagnostics` route — health checks, cost rollups, resumable tasks.
**Status: Deferred — explicit user decision (not in this pass).** Correction for whoever scopes this later: `ai_call_log` (and `GET /api/log/ai_calls`) already captures per-call token usage, so a cost rollup is an aggregation query away — more feasible than this section assumed, though that doesn't change its priority.
**Fit:** Partial. This app doesn't have "agents" or "cost rollups" (no per-call LLM cost tracking visible in the current architecture — would need to check if `usage` from `callClaude()` responses is summed anywhere). A scoped version: a small admin view (could live in Settings → App Info, which already shows universe-health) listing: background thread status (scanner, db-backup daemon — both mentioned in CLAUDE.md), last N AI call log entries (already have `GET /api/log/ai_calls`), DB integrity check result, lock file status. This is **net-new functionality**, not pure restyling — flag for explicit user confirmation before scoping further.

### 2.7 Setup wizard modal (first-run onboarding)
**Source:** Forven's `SetupWizardModal.svelte` — guided first-run config (API keys, exchange selection, etc.).
**Status: Deferred — explicit user decision (not in this pass).**
**Fit:** This app already documents two API-key setup paths (direct/localStorage vs proxy/file-based) in CLAUDE.md "Run instructions," but there's no in-app guided flow — users currently configure via the Settings page tabs unguided. A lightweight first-run modal (shown once via a localStorage/blob_store flag) that walks through: paste Anthropic key OR enable proxy mode, optionally configure Ollama for local LLM, optionally set up Telegram alerts — would lower the setup-friction bar. **Net-new, optional, low priority relative to the visual theme work.**

---

## 3. Functional/feature concepts worth adopting (beyond pure UI)

Forven is a crypto *autonomous agent* trading platform; this app is a *decision-support* tool with a human in the loop (per CLAUDE.md: "Claude — Qualitative conviction only," human executes). Several Forven concepts map cleanly to existing equivalents here and are **enhancement opportunities**, not gaps:

| Forven concept | Existing equivalent here | Suggested enhancement |
|---|---|---|
| The Gauntlet (walk-forward, Monte Carlo, parameter-jitter, cost-stress robustness battery) | Walk-forward backtest already shipped (Sprint 20, `POST /api/backtest/walk-forward`) | Add Monte-Carlo resampling and a parameter-jitter sensitivity pass to `routes/backtest.py` as a follow-up — **flag as a separate, larger scope item, not part of this UI/UX pass.** |
| Data quality / coverage matrix (`CoverageMatrix.svelte`, `QualityLeaderboard.svelte`) | `GET /api/market/universe-health` (Settings → App Info) | **Done.** Replaced the old flex-wrap chip lists with a 3-tile OK/Stale/Excluded stat strip + sorted tables in `js/pages/settings.js`. Same response shape, no new endpoint. A real bug was caught mid-implementation: the single-action exclude/unexclude re-render only ever gets `{excluded}` back (no `ok_count`/`stale`), so the stat strip is gated off in that path rather than showing a misleading "0 OK / 0 Stale". |
| Brain decisions / lessons / memory tabs | Learning page (calibration, lessons, tag-reviews) | Already a strong conceptual match — Forven's "Brain" UI is a good visual reference for restyling the existing Learning page's cards under the new terminal theme; no new functionality needed. |
| Risk page (kill-switch, drawdown, liquidation distance) | Risk page (drawdown monitor, target allocations, heat budget) | Visual layout reference only — **UI restyle, no functional gap.** |
| Approval workflow (approve/deny/revise agent proposals) | Pre-trade checklist (manual execution confirmation) | Conceptually adjacent but this app's human-in-the-loop model doesn't need an "approve an autonomous agent's action" flow — **do not adopt**, it doesn't fit the architecture (no autonomous execution exists here, by design). |
| Update banner (new version available) | None | Skip — no auto-update/versioning mechanism exists; would need real infrastructure (version-check endpoint) to not be vestigial UI. |

**Recommendation:** Scope this pass to **visual theme + layout patterns (Sections 1 and 2)** plus the **coverage-matrix restyle** from Section 3. Treat the Gauntlet-style backtest robustness additions and the onboarding wizard as separate, explicitly-approved follow-up work — they're real scope, not "UI polish."

---

## 4. Explicit conflict/risk checklist (re-confirm before merging anything)

1. **No Tailwind, no Svelte, no bundler.** Every visual change must be hand-written CSS added to `asx_trading.css` and plain JS in the existing files — verify no `npm install` of a frontend framework slipped in.
2. **No chart libraries, canvas only** (CLAUDE.md, explicit). Sparklines (2.5) must be canvas-drawn, not inline SVG.
3. **Theme must go through `data-theme` attribute + `_applyTheme()`**, never a body class (gotcha #40) — re-verify the function's current signature before extending it to accept `'terminal'`.
4. **All canvas colors through `chartColor()`** (gotcha #39) — no hardcoded hex in `charts.js`, including new sparkline code.
5. **Mobile breakpoints (`.tbl-stack`, 44px touch targets, safe-area insets — Sprint 56)** must be re-tested after any button/input restyle for the terminal theme.
6. **Script load order is fragile** (CLAUDE.md: "Don't reorder these without checking dependencies") — any new helper (e.g. `_drawSparkline`) must be added to an already-loaded file (`charts.js`) rather than a new script tag, to avoid touching the load-order list at all.
7. **`file://` compatibility** — no remote font/asset CDN calls; self-host anything new (gotcha #38 precedent: `API`/`serverUrl` are already origin-relative for this reason).
8. **Render functions must stay pure** (gotcha #10) — the new page-header (2.1) and critical-banner (2.3) helpers must not mutate `state` during render; compute derived values first, render second, same pattern as `reconcileRecOutcomes()` before `renderPerformancePage()`.
9. **Don't duplicate existing systems** — toast() (`utils.js:146`) and the notification centre (`js/notifications.js`) already exist; the critical-alerts banner (2.3) is a *third*, *persistent* tier, not a replacement — make sure a future worker doesn't collapse these into a confusing fourth notification mechanism.

---

## 5. Suggested execution order (for the worker)

1. Theme tokens (`Section 1`) — lowest risk, highest visual impact, fully additive (new `data-theme="terminal"` value).
2. Page header pattern (`2.1`) — small, centralizes in `navigation.js`.
3. Ops header strip on Dashboard (`2.4`) — reuses existing `/health` data.
4. Sparklines on Watchlist (`2.5`) — canvas helper + one page integration, benchmark before extending further.
5. Critical alerts banner (`2.3`) — needs a short design check-in (what counts as "critical"?) before building.
6. Settings save-bar (`2.2`) — **requires reading `pages/settings.js`'s current save model first**; may turn out to be unnecessary if every field already auto-saves.
7. Coverage-matrix restyle (`3`) — cosmetic upgrade to existing universe-health UI.
8. Everything else (diagnostics page, setup wizard, Gauntlet-style backtest additions) — explicitly out of scope for this pass; revisit only if requested separately.

## Verification
This is a UI/UX-focused, additive change set. After implementation:
- `for f in js/*.js js/pages/*.js; do node --check "$f" || break; done` (per CLAUDE.md smoke test)
- `npm run test:js` and `python test_app.py` — confirm no regressions
- Manually toggle Settings → Display → new "Terminal" theme option and click through every page at both desktop and ≤640px widths
- Confirm `file://`-opened version still loads (no CDN font/script dependency introduced)
