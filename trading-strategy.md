# Trading Strategy — Sloth ASX Trader

*A precise account of what the system does, why, and where the edges are real vs assumed.*

---

## 1. Philosophy

This is a **decision-support system**, not an automated trading system. Every trade requires a human to review and execute. The AI pipeline produces structured recommendations; a deterministic quant engine sizes them; the human decides whether to pull the trigger.

The core thesis is that edge comes from three sources, in this order:

1. **Risk management first.** A disciplined stop-loss and position-sizing framework, applied consistently, matters more than signal quality. Most retail losses come from holding losers too long and cutting winners too early — the system enforces the opposite.
2. **Regime awareness.** The same signal has different implications in different macro environments. A mean-reversion buy signal in a riskOn regime is a good trade; the same signal in a panic regime is catching a falling knife. The regime classifier gates which strategies fire and how aggressively.
3. **Calibrated AI conviction.** Claude provides qualitative conviction and structured reasoning, not arithmetic. The model is continuously calibrated against its own historical win rates per confidence band and regime — it knows where it has been right and wrong.

---

## 2. Market Universe

| Universe | Tickers | Use case |
|---|---|---|
| ASX200 (`asx200`) | ~200 | Full portfolio scan; background scanner |
| ASX100 (`asx100`) | ~100 | Intraday day-trade scan |
| ASX50 (`asx50`) | ~50 | Concentrated swing portfolio |
| ASX20 (`asx20`) | ~20 | Large-cap only; conservative mode |

Data source: `yfinance` (primary), `stooq.com` (fallback when yfinance returns empty), `_last_good` stale-cache (fallback when both fail). All prices are indicative — `yfinance` 5-minute intraday data lags approximately 5–15 minutes.

---

## 3. Macro Regime Classification

The regime gate is the first and most consequential filter in the pipeline. It runs every 15 minutes and classifies the market into one of six states using a weighted voting system across 9 macro signals.

### 3.1 Signals and Votes

| Signal | Condition | Votes cast |
|---|---|---|
| VIX + A/D | VIX > 30 AND A/D < 0.30 | panic +5 (hard override) |
| VIX | > 22 | highVol +2 |
| VIX | < 16 | riskOn +1 |
| A-VIX (ASX 20d realised vol) | > 25% | highVol +2 |
| A-VIX | < 12% | riskOn +1 |
| ASX200 5d return | < −2.0% | riskOff +2 |
| ASX200 5d return | > +1.0% | riskOn +2 |
| ASX200 5d return | −2.0% to +1.0% | sideways +1 |
| ASX200 20d return | \|return\| > 4.0% | trend +2 |
| ASX200 20d return | < −5.0% | riskOff +1 |
| ASX200 ADX | > 25 | trend +1 |
| ASX200 ADX | ≤ 25 | sideways +1 |
| Advance/Decline ratio | > 0.60 | riskOn +1 |
| Advance/Decline ratio | < 0.30 | riskOff +1 |
| ASX200 ATR% | > 1.5% | highVol +1 |
| Iron ore 5d change | < −3% (when riskOff 5d already) | riskOff +1 |
| AUD/USD 5d change | < −1% (when riskOff 5d already) | riskOff +1 |

Panic requires the hard override (VIX > 30 + breadth collapse). All other regimes are determined by the plurality of weighted votes.

### 3.2 Regime Modifiers

These multipliers are applied deterministically by the quant engine after Claude issues its recommendation.

| Regime | Size mult | Stop ATR mult | Max new positions | Confidence boost req'd |
|---|---|---|---|---|
| riskOn | 1.0× | 2.5× | 5 | 0 |
| trend | 1.1× | 2.5× | 4 | 0 |
| sideways | 0.8× | 2.5× | 3 | +0.05 |
| highVol | 0.6× | 3.0× | 2 | +0.08 |
| riskOff | 0.5× | 3.5× | 1 | +0.10 |
| panic | **0× (blocked)** | 4.0× | 0 | — |

**Regime flip blending:** When the regime changes (except to panic), the size multiplier transitions linearly from the old to the new value over 30 minutes. This prevents cliff-edge position sizing changes.

**Calibration flip penalty:** When a regime flip occurred within the last 30 days and fewer than 10 trades have been recorded in the new regime, the calibration system halves the decay half-life for that regime and emits a `⚠REGIME_FLIP` warning in the prompt.

### 3.3 Strategy Gates

Which strategies are permitted in each regime:

| Strategy | Allowed regimes |
|---|---|
| Mean-reversion swing | riskOn, sideways, highVol |
| Momentum breakout | riskOn, trend |
| Portfolio analysis (any action) | riskOn, riskOff, sideways, trend, highVol |
| Any new position | **All except panic** |

---

## 4. Swing Trading Strategy

### 4.1 Signal Generation (`indicators.py`)

Every ticker analysis produces the following signals from daily OHLCV history (via yfinance):

**Trend signals**
- SMA20, SMA50, SMA200 (price vs each)
- MACD (12/26/9 EMA): histogram, signal line, bullish/bearish crossover
- ADX-14: trend strength; DI+/DI− direction
- Trend direction: bullish / bearish / neutral from composite of above

**Mean-reversion signals**
- RSI-14 (Wilder's EMA method)
- Bollinger Bands (20-period, 2σ): %B (0=lower band, 1=upper band), upper/lower band prices
- Distance from 52-week high

**Volatility**
- ATR-14: average true range in dollars
- ATR%: ATR as % of price
- 95th-percentile overnight gap (`gap95_pct`) from 252-day history: overnight gap floor for stop distance

**Volume**
- ADV-20: 20-day average dollar turnover (`close × volume`)
- volume_avg_20: 20-day average share count
- Volume ratio (5d avg / 20d avg): accumulation signal

**Earnings proximity**
- `days_to_earnings`: integer or None
- `pre_earnings_risk`: True when ≤ 14 days to earnings (→ earningsAdj = 1.3 on stop width)

**Fibonacci / range**
- `high_60d`, `low_60d`: 60-bar high and low; None when < 60 bars of history
- Used to calculate Fibonacci 50–61.8% retracement zones for day-trade signal #4

**Composite setup score (0–100)**

Computed by `_score_ticker()` with these factor weights:

| Factor | Weight | Max raw | Represents |
|---|---|---|---|
| Trend | 30 | 30 | Price vs SMA20, SMA50, SMA slope |
| Pullback | 30 | 30 | RSI zone (35–55 = best) + position from 90d high |
| Volume | 20 | 20 | 5d avg vs 20d avg volume ratio |
| Momentum | 10 | 10 | 5d return |
| Relative strength | 10 | 10 | 5d alpha vs ASX200 (neutral 5 when index unavailable) |

Ideal pullback setup: RSI 35–55 (mean-reversion zone), price 5–20% below 90-day high, volume rising, positive 5d momentum, outperforming the index.

**Data quality guards**
- `_drop_forming_bar()`: drops the current-day candle before 07:00 UTC (ASX pre-market) to avoid incomplete bars distorting signals
- `_sanity_check()`: drops bars with > 25% single-day close move (data errors / unadjusted splits). Penny stocks (< $0.50) are exempt.

### 4.2 AI Analysis (Claude Sonnet 4.6)

Claude receives a structured user message containing:

1. **ACTIVE_REGIME**: current regime, sizeMult, stopAtrMult, max positions
2. **Holdings block**: each position with live price, weight, unrealised P&L, entry driver, thesis status
3. **INDICATOR block** (tiered):
   - Tier 1 (full 12-line block): tickers with active setups
   - Tier 2 (1-line compact): stable holds
4. **ACTIVE RULE OVERRIDES**: stop multiplier, confidence floor, any user-configured rules
5. **Calibration block**: decay-weighted win rates per confidence band, top error pattern nudge, recent exemplars
6. **Lessons block**: up to 4 relevant historical trading lessons (filtered by sector, regime, ticker)
7. **Context**: date, time, RBA rate, TAX_LOSS_HARVEST_ACTIVE flag, current portfolio value

**What Claude is instructed to produce:**

For each recommendation:
- `action`: BUY / SELL / TRIM / TOP_UP / HOLD
- `ticker`, `confidence` (0–1), `priceRange` [low, high]
- `target` (price), `stopLoss` (price)
- `qty` = 0 (quant engine sizes the trade; Claude never does arithmetic)
- `reasoning` (max 150 chars; cite top 2–3 factors; RSI/MACD cannot be the primary driver for established holdings)
- `scenarios`: `{bull, base, bear}` each with `{p, ret}` — probability and expected 12m return. Required for all non-HOLD recs.
- `bullCase` (max 100 chars): steelman of the opposing view. Required on all BUY/TOP_UP.
- `bearCase` (max 100 chars): one-sentence steelman of how this trade loses. Required on SELL/TRIM and BUY/TOP_UP with confidence ≥ 0.70.
- `invalidationCondition` (max 80 chars): measurable trigger that breaks the thesis — must contain a price level, %, timeframe, or named event (e.g. "iron ore < $95/t for 5 sessions", "RBA hikes 25bp"). Vague conditions like "if sentiment shifts" are invalid.
- `reallocationSuggestion` (max 120 chars; SELL/TRIM only): where freed capital should go.
- `primary_entry_driver` (BUY/TOP_UP only): one of `mean_reversion`, `momentum_breakout`, `trend_pullback`, `fundamental_value`, `macro_tailwind`
- `factorsUsed` (≥ 3 entries; each must cite a specific data point)

**Key prompt rules:**
- Rule 18: Analyst targets are weak evidence — lag price, never the sole reason for a SELL/TRIM or BUY
- Rule 19: Sharpe ratio is backward-looking context only — never a standalone SELL/TRIM trigger
- Rule 20: For holdings > 60 days or large-cap (ADV > $10M), fundamentals outweigh short-term technicals. RSI/BB/MACD are confirming signals only — one confirmed fundamental deterioration is required alongside any technical SELL/TRIM signal. Exception: stop-loss breach or thesis_broken driver always overrides.

**Optional context modules** (injected per-call, not cached):
- `TAX_LOSS_HARVEST`: active May–June — scan for unrealised losses > $500
- `CGT_DISCOUNT_WINDOW`: any holding in 11–12 month holding window
- `REPORTING_SEASON`: Feb and Aug — cluster risk, TOP_UP blackout within 5 days of earnings
- `MINING_SECTOR`: iron ore thresholds, AUD/USD export-revenue heuristics (fires when portfolio has Mining/Materials tickers)
- `REIT_SECTOR`: franking, LVR, yield requirements (fires for REITs/Real Estate)
- `FINANCIALS_SECTOR`: NIM, CET1, RBA path, loan growth, credit quality, dividend sustainability (fires for Financials/Banks)
- `HIGH_VOL_REGIME`: raises min confidence to 0.75, reduces qty by 30% (fires in highVol)
- `RISK_OFF_REGIME`: confidence ≥ 0.80 for new BUY; max 1 new position (fires in riskOff)

### 4.3 Position Sizing (Quant Engine)

The quant engine computes position size deterministically from Claude's output. Claude never sees the final quantity — it outputs `qty: 0` as a placeholder.

**Stop distance:**
```
stopDist = max(stopAtrMult × earningsAdj × ATR14, gap95_pct × price)
stopLoss = entryPrice − stopDist
```

Where:
- `stopAtrMult`: from current regime (2.5 riskOn/trend/sideways, 3.0 highVol, 3.5 riskOff, 4.0 panic)
- `earningsAdj`: 1.3 when `pre_earnings_risk = true`, else 1.0
- `gap95_pct`: 95th-percentile overnight gap from 252-day history (floor protection)

**Sizing constraints (five-way minimum):**

| Constraint | Formula | Purpose |
|---|---|---|
| Account risk | `(capital × 1%) / stopDist` | Max 1% of net worth at risk per trade |
| Max position | `(capital × 20%) / price` | Max 20% of net worth in one position |
| Liquidity | `volume_avg_20 × 5%` | Max 5% of ADV20 in shares |
| Fractional Kelly | `capital × kellyFrac / price` | Kelly-scaled bet size |
| Vol scalar | `min(1, 2% / ATR%)` | Reduce size when ATR% > 2% |

Final quantity: `max(1, floor(min(byRisk, byPosition, byLiquidity, byKelly) × volScalar × varMult))`

**Kelly phase gate:**
- Phase 1 (< 200 completed trades): Kelly capped at 0.10 (10% of full Kelly)
- Phase 2 (≥ 200 trades): Kelly capped at 0.25

**VaR modifier:**
- `var_1d < −5%`: size × 0.50
- `var_1d < −3.5%`: size × 0.75
- Otherwise: no adjustment

**Rejection gates** (trade not issued):
- `kellyFrac ≤ 0`: negative expected value — skip
- `R:R ratio < 2.0`: reward-to-risk below minimum
- ADV data unavailable: liquidity constraint cannot be applied
- No valid target above current price
- Qty = 0 after all constraints

### 4.4 Validation and Auto-Repair

The validator (`response-validator.js`) checks every rec against `REC_SCHEMA`:

Required fields for all non-HOLD recs: `ticker`, `action`, `confidence`, `priceRange`, `target`, `stopLoss`, `qty`, `scenarios`, `invalidationCondition`

Up to **2 repair retries** are attempted automatically when Claude's output fails validation. If repair fails, the rec is dropped and a warning is shown.

### 4.5 Confidence Floor

Minimum confidence: **0.62** (adjustable in Settings/Rules).

When Claude issues a rec below the floor, the system stamps `_confidenceHeld: true` and shows an ⛔ HELD badge on the rec card. The rec is **not dropped** — the action and ticker are preserved, but:
- A `_ruleWarnings` entry is added explaining the breach
- The pre-trade checklist adds a mandatory acknowledgment checkbox that must be ticked before execution is enabled

### 4.6 Pre-Filter for Universe Scans

Before the AI sees any ticker, the swing-trading pre-filter applies:

| Filter | Default | Logic |
|---|---|---|
| BB %B | ≤ 0.20 | Price near or below lower Bollinger Band |
| ADV (AUD) | ≥ $1.5M | Minimum liquidity |
| Trend floor | ≥ SMA200 × 0.985 | Not in a structural downtrend (or SMA50 × 0.970 fallback) |
| ADX ceiling | ≤ 35 | Skip stocks already in a strong rip (when DI+ > DI−) |
| A/D ratio | ≥ 0.25 | Market breadth gate — suppress BUYs when breadth is collapsing |
| VoV filter | ATR14 ≤ 1.3 × ATR5d mean | Skip when stop distance is already stale from volatility expansion |
| Time of week | Block Mon < 11:00, Fri ≥ 14:00 AEST | Avoid thin liquidity windows |

All thresholds are user-editable at runtime via Day Trading → Rules (swing thresholds) and Settings.

---

## 5. Intraday Day-Trading Strategy

### 5.1 Overview

A same-session mean-reversion strategy targeting +3.5% gains on ASX100 names that are technically discounted below VWAP during the core trading window.

- **Universe:** ASX100 (configurable: ASX20/50/100/200)
- **Data:** 5-minute bars, 2-day history via yfinance (~5–15 min latency)
- **Entry window:** 10:45–15:00 AEST only
- **Time stop:** 15:00 AEST forced close-out alert
- **Max concurrent positions:** 2
- **Capital allocation:** 20% of available cash

### 5.2 Entry Criteria (Backend: `routes/intraday.py`)

A setup passes when **all** of the following are true:

| Gate | Condition |
|---|---|
| Entry window | Current AEST time is 10:45–15:00 |
| VWAP discount | Price ≤ VWAP × (1 − 0.003), i.e. ≥ 0.3% below VWAP |
| Intraday RSI | RSI(14) on 5m bars ≤ 40 |
| Setup score | ≥ 50 |

### 5.3 Scoring (`_score_setup()`)

Each ticker receives a setup score 0–100 from these components:

| Signal | Max points | Condition |
|---|---|---|
| VWAP discount | 30 | Scaled: 30 pts at −1.5%, 15 pts at −0.3%, interpolated |
| Intraday RSI | 25 | Scaled: 25 pts at RSI 20, 0 pts at RSI 40, interpolated |
| Volume acceleration | 20 | `last_3_bar_avg / 20-bar avg > 1.0` → 10–20 pts |
| Fibonacci zone | 15 | Price within 50–61.8% retracement of `high_60d − low_60d` |
| Price above open | 10 | Current price > day open (intraday upward bias) |

Score is capped at 100. Confidence is derived as `min(0.85, score / 100 × 0.85)`, capping at 0.82 for a perfect-score setup.

### 5.4 Target and Stop

```
target  = entry × 1.035    (+3.5%)
stopLoss = entry × 0.985   (−1.5%)
```

R:R ratio = 3.5 / 1.5 = **2.33** (above the 2.0 minimum).

If daily signals are available for the ticker, the quant engine is attempted first. When the quant engine produces a quantity, it overrides the fallback. The fallback risks 2% of allocated cash divided by the per-share stop distance.

### 5.5 Signals Displayed on the Rec Card

- `VWAP −X.X%` — how far below VWAP
- `RSI XX` — intraday RSI value
- `Volume↑` — volume rising vs 20-bar average
- `Above open` — price is above the day open

---

## 6. Risk Management Framework

### 6.1 Position-Level Rules

| Rule | Value | Where enforced |
|---|---|---|
| Max capital at risk per trade | 1% of net worth | Quant engine: `accountRiskPct` |
| Max single position weight | 20% of net worth | Quant engine: `maxPositionPct` |
| Max trade size vs daily volume | 5% of ADV (shares) | Quant engine: `maxLiquidityPct` |
| Minimum R:R ratio | 2.0 | Quant engine; validator will reject below-minimum recs |
| Earnings stop widening | 1.3× ATR multiple | `earningsAdj` in quant engine |
| VaR modifier (high-VaR tickers) | 0.75× or 0.50× | Applied when `var_1d < −3.5%` or `< −5%` |

### 6.2 Portfolio-Level Rules

| Rule | Value | Where enforced |
|---|---|---|
| Max single sector weight | 30% of portfolio | Rule 10 in system prompt (Claude enforces) |
| Max correlated new positions | Context-aware | Rule 9 (correlation check in factorsUsed) |
| Heat budget | User-set (default 5% of portfolio at risk to stops) | `state.settings.maxRiskBudgetPct` in `analysis.js` |
| New positions in riskOff | Max 1 | Regime modifier |
| New positions in panic | 0 (hard block) | Regime modifier `sizeMult = 0` |

### 6.3 Stop Types

**Standard stop:** `entry − stopAtrMult × earningsAdj × ATR14`

**Regime stop widening (automatic):** When the regime degrades while holding an open position (e.g., riskOn → highVol), `checkRegimeStopWidening()` widens the stop to the new regime's ATR multiple — widen-only, never tightens. Records `_stopWidened`, `_stopWidenedFrom`, `_stopWidenedRegime` on the rec.

**Trailing stop:** When a position reaches target, `_stopTrailed` is set. The system alerts (desktop + optional Telegram) but does not auto-execute — all execution is manual.

**Time stop (intraday only):** Alert fires at 15:00 AEST for any open intraday position. No auto-close.

### 6.4 Pre-Trade Checklist

Before executing any recommendation, a modal checklist requires:
- Acknowledgment of risk level (stop distance, max loss)
- Sector concentration warning (if applicable)
- Earnings proximity warning (if `pre_earnings_risk = true`)
- **Mandatory forced-ack** when confidence is below the floor (`_confidenceHeld = true`): "I understand this recommendation's confidence is below the system floor and am executing on my own judgment." The Execute button does not enable until this is ticked.

---

## 7. Learning Loop and Calibration

This is the feedback mechanism that makes the system improve over time.

### 7.1 Trade Lifecycle

```
1. Recommendation issued → POST /api/learning/log (was_executed=0)
2. User executes → POST /api/learning/outcome (was_executed=1)
3. Position closes → outcome patched (win/loss/breakeven, realized_pnl_pct)
4. Deterministic tagging fires → error_type, skill_score written
5. MAE/MFE resolved → worst drawdown + best unrealised gain from OHLC
6. Calibration aggregates → win rates by confidence band, regime, sector, driver
7. Next Claude call receives calibration block → adjusts conviction accordingly
```

### 7.2 Outcome Resolution

**Executed trades:** Outcome determined by `realized_pnl_pct` from actual entry and exit prices.

**Unexecuted recs (virtual outcomes):** For recs ≥ 30 days old with no execution, `_resolve_virtual_outcomes()` fetches the current price and classifies as `virtual_win` / `virtual_loss` / `virtual_open`. Weighted at `0.75×` vs executed outcomes (lower trust). Prevents calibration from being censored to execution-only data.

**Per-entry outcome, not blanket:** When a position built from multiple BUY/TOP_UP parcels is closed by one SELL, each parcel is judged against its own entry price independently.

### 7.3 Deterministic Error Tagging

`classify_error_type_deterministic()` derives error tags from real data (no LLM). Returns a comma-separated set of ALL applicable tags (most → least specific):

| Tag | Trigger |
|---|---|
| `thesis_broken` | `thesis_verdict == 'invalidated'` |
| `stop_too_tight` | MAE pierced stop yet MFE recovered ≥ 50% toward target; falls back to stop < 1.5×ATR heuristic when MAE/MFE unavailable |
| `missed_catalyst` | Entry `days_to_earnings` inside `holding_period_days` (earnings surprise within the hold) |
| `early_exit` | Manual non-win exit where MFE reached target OR `exec_mech_pnl_pct` beats `realized_pnl_pct` by ≥ 2pp |
| `oversized` / `undersized` | Sizing token in `checklist_bypasses` only |
| `overconfident` | Confidence high; outcome loss |
| `poor_rr` | Low R:R ratio on entry |
| `poor_entry` | Entry timing issue |
| `regime_mismatch` | Regime at entry contradicts recommended strategy gates |

`external_shock` is never emitted deterministically — requires manual LLM review.

Deterministic tags carry `error_type_source = 'deterministic'` and are NOT subject to the auto-tag reliability gate.

### 7.4 Skill Scoring

`compute_skill_score_deterministic()` rates trade process quality 0–10 based on `thesis_verdict × outcome`:

| Verdict | Win | Loss |
|---|---|---|
| Validated | 8 | 6 (bad luck, good process) |
| Invalidated | 3 (good luck, bad thesis) | 2 |

Modifiers:
- `+0.5`: shallow MAE, high MFE (clean path quality)
- `−0.5`: deep MAE, thin MFE (got lucky; adversarial path)
- `+1.0` discipline modifier: exit followed the plan
- `−1.0` calibration modifier: confidence was materially miscalibrated

Returns `None` for legacy rows with no `thesis_verdict` — neutral weight in calibration.

### 7.5 Calibration Feed

`GET /api/learning/calibration` returns a compact block injected into every Claude user message.

**Decay half-lives by regime** (older trades weighted less):

| Regime | Half-life |
|---|---|
| panic | 20 days |
| riskOff | 30 days |
| highVol | 35 days |
| trend | 45 days |
| riskOn | 50 days |
| sideways | 60 days |

**Content (priority-ordered; low-priority drops first under token budget):**

1. Header: overall n, win rate, calibration active (n ≥ 30)
2. Per-confidence-band win rates with Wilson 95% CI
3. Regime warning (current regime stats, flip penalty if applicable)
4. Top error pattern nudge (when ESS ≥ 6.0, n ≥ 12, CI-gated)
5. Skill insight (skill scores by driver)
6. Conservatism warning (when virtual outcomes show would_have_won rate is high)
7. SELL tag verdicts
8. Per-ticker stats
9. Thesis drift nudge (`⚠EARLY_EXIT_DRAG` when manual exits lag target hits by > 3pp)
10. (deep mode) Per-driver playbook, driver × regime cross-tabs, SELL negative confirmation

**Deep mode** (`?deep=1`): requested by the full portfolio analysis path. Adds exemplars (2–3 recent closed losses + 1–2 best wins) and the driver × regime / setup-score cross-tabs. Raises token budget from 400/600 chars to 900/1100.

**Statistical gates:** Calibration nudges only fire when:
- ESS (effective sample size) ≥ 6.0
- Minimum n ≥ 12 for any nudge
- Wilson 95% CI excludes the midpoint of the confidence band (prevents noise nudges on small samples)

### 7.6 Thesis Tracking

**At entry (BUY/TOP_UP):** `primary_entry_driver` is captured in the prompt output and stored in `ai_learning_events.primary_entry_driver`. Wide entry signals (24 fields including RSI, BB%B, price vs SMAs, MACD, volume) are stored in `entry_signals_json`.

**During hold:** On each portfolio analysis, `HOLDING_CONTEXT` blocks are injected for each open position, showing the original entry driver and entry signals. Claude must narrate whether the original thesis still holds.

**At exit (SELL/TRIM):** `computeThesisDrift()` computes a deterministic verdict comparing entry signals vs current signals:
- `validated`: key entry conditions still improving or holding
- `invalidated`: key entry conditions have deteriorated
- `irrelevant`: not enough data or driver doesn't apply

The verdict is stored as `thesis_verdict` on the rec and patched back to the parent BUY event in `ai_learning_events`.

**Thesis matrix:** `GET /api/learning/thesis-matrix` shows a cross-tab of `entry_driver × thesis_verdict` with win rate and average P&L per cell.

### 7.7 Sector Performance Tracking

Calibration includes sector-relative performance expressed as **signed delta vs whole-market baseline**:

```
SECTOR: NN% WR vs mkt MM% (±Xpp, n=…)  ✓strong / ⚠underperform
```

A sector line fires only when ESS ≥ 6.0 AND the sector's Wilson 95% CI excludes the market win rate.

---

## 8. Day-Trading ML Layer (Optional)

A parallel training pipeline collects feature snapshots at trade entry and learns from outcomes via logistic regression (pure numpy, no external ML library).

**Feature set (19 features for intraday; 16 for swing):**

Swing features: RSI-14, BB%B, ADX-14, ATR%, SMA20/50/200 distance, trend direction, volume ratio, return 5d/20d, setup score, RS score, regime risk (ordinal), ADV bucket

Intraday extras: intraday RSI, VWAP %, volume acceleration

**Training:** Walk-forward cross-validation or 70/30 holdout (auto-selected by sample size). Minimum 30 samples required. Reports OOS R² and MAE.

**Usage:** Model predictions are an additional signal available in the day-trading panel — not integrated into the main swing recommendation pipeline. Opt-in only.

---

## 9. Debate Engine (Local Ollama)

An optional pre-analysis layer that runs before or after Claude:

- **Bull/bear debate:** Local Ollama generates two independent arguments for and against a trade. Cached 4 hours per ticker per signal hash.
- **Adversarial postmortem (⚔️):** Two models independently analyse a closed loss; an automated adjudicator scores them and produces a synthesis.
- **Skill scoring (🔬):** Manual-only; rates process quality for closed trades.
- **Calibration quality (Phase 6):** Statistical per-band analysis using binomial standard error and Z-scores.

All debate/postmortem functions are **manual-trigger only** (via button). Auto-triggering was removed to prevent blocking the main analysis pipeline.

---

## 10. Prompt Caching

System prompt caching via Anthropic's `cache_control: {type: 'ephemeral'}`:

- **Block 1 (cached):** `ANALYSIS_SYSTEM_PROMPT` — the large static core rules. Cache hit rate is high since this rarely changes between calls within a 5-minute window.
- **Block 2 (uncached):** Optional modules (tax-loss, reporting season, sector modules, regime modules) — varies per call so it's never cached.

Prompt cache hits show in console as `[agentType] cache read=X written=Y`. The cached block saves significant input token cost on intraday portfolio refreshes.

---

## 11. Known Limitations and Open Gaps

### Critical

| Gap | Impact |
|---|---|
| **Intraday targets/stops use daily ATR** | Daily ATR is 10–20× intraday noise. Intraday positions should use σ(5m bars) for stops and `day_high − 0.5×(day_high − VWAP)` for targets. Current setup causes near-universal timeouts or whipsaws. |
| **SPI defensive overlay blocks all setups; Mode A unimplemented** | On gap-down days (SPI ≤ −1.5%), scanner generates zero setups. Mode A (VWAP recapture on rally days) is referenced in comments but not implemented. The days with the most gap-down mean-reversion opportunity produce zero recs. |
| **Min confidence is static at 0.62** | Calibration shows per-band win rates, but the floor never adjusts. If the 65–75% confidence band has a 35% historical win rate, the next rec at conf = 0.67 still fires unchanged. |
| **Calibration lacks per-driver × regime cross-tabs** | "SELL on thesis_broken in sideways regime" is unknown. Losing patterns repeat because Claude cannot see the context-specific failure: which driver fails in which regime. |

### Significant

| Gap | Impact |
|---|---|
| `earningsAdj = 1.3` is a flat constant | Should scale with options-implied move. A 30% IV stock needs 2–3× wider stops than a 8% IV stock. |
| Breakout stops lack a structural floor | ATR formula can place a stop above or well below the actual breakout level (the broken resistance). Breakout whipsaws are common. |
| RS score is 5-day alpha only | No multi-timeframe confirmation (20d/60d). A 5-day winner can be mid-sector-rotation reversal. |
| Cyclical basket exposure not tracked | 30% Mining + 25% Energy + 15% Utilities = 70% rate/commodity-sensitive despite sector caps being "respected." |
| Virtual outcomes have 30-day lag | An "incorrect" SELL that the stock rallies 20% after doesn't feed back for a month. |
| VWAP discount is regime-invariant | −0.3% is every other bar in panic; genuinely rare in low-vol. Should scale with daily ATR%. |
| No mid-position profit scaling (intraday) | No trailing stop, no partial close at +1%. Most intraday recs miss the full target and close on the time-stop near breakeven. |

### Cosmetic / Low Priority

| Gap | Impact |
|---|---|
| Kelly phase cliff-edge at 200 trades | Position sizes jump 2.5× abruptly at trade #200. A linear ramp from 150–250 would be more sensible. |
| ADV hard-rejects on missing data | Small-cap tickers with no ADV history get no recs at all, even when the thesis is strong. A sliding-scale fallback would be better. |
| Intraday score caps at 100, confidence at 0.82 | A perfect-signal setup looks identical to a marginal-signal setup in the sizing output. |
| DT sector concentration warning is non-blocking | A toast notification that can be ignored. |

---

## 12. Parameter Quick Reference

### Quant Engine (`js/quant-engine.js` → `QUANT_CONFIG`)

| Parameter | Default | Edit location |
|---|---|---|
| `stopAtrMultiple` | 2.5 (regime-overridden) | Settings / Rules tab |
| `maxPositionPct` | 0.20 (20%) | `QUANT_CONFIG` |
| `maxLiquidityPct` | 0.05 (5% of ADV) | `QUANT_CONFIG` |
| `kellyFraction` | 0.25 (¼ Kelly) | `QUANT_CONFIG` |
| `accountRiskPct` | 0.01 (1%) | `QUANT_CONFIG` |
| `minRrRatio` | 2.0 | Day Trading → Rules |

### Regime Thresholds (`js/regime-engine.js` → `REGIME_THRESHOLDS`)

| Threshold | Value |
|---|---|
| Panic: VIX | > 30 (with A/D < 0.30) |
| High vol: VIX | > 22 |
| High vol: ASX ATR% | > 1.5% |
| Risk-off: ASX200 5d return | < −2.0% |
| Risk-on: ASX200 5d return | > +1.0% |
| Trending: ASX200 ADX | > 25 |
| Trending: ASX200 20d return | > ±4.0% |

### Day-Trade Pre-Filter (`js/strategy.js` → `DT_FILTER`)

| Filter | Default | Edit location |
|---|---|---|
| `maxBbPctB` | 0.20 | Day Trading → Rules |
| `minAdvAud` | $1.5M | Day Trading → Rules |
| `sma200Floor` | 0.985 | Day Trading → Rules |
| `maxAdx` | 35 | Day Trading → Rules |
| `minAdr` | 0.25 | Day Trading → Rules |

### Intraday Defaults (`js/intraday-strategy.js` → `INTRADAY_DEFAULTS`)

| Parameter | Default | Edit location |
|---|---|---|
| `targetPct` | 3.5% | Intraday tab settings |
| `stopPct` | 1.5% | Intraday tab settings |
| `maxPositions` | 2 | Intraday tab settings |
| `minScore` | 40 | Intraday tab settings |
| `allocPct` | 20% of cash | Intraday tab settings |

### Scanner Factor Weights (`indicators.py` → `FACTOR_WEIGHTS`)

| Factor | Default weight | Tune with |
|---|---|---|
| Trend | 30 | `POST /api/scanner/factor-stability` |
| Pullback | 30 | (use suggested_weights row in Factor Stability tab) |
| Volume | 20 | |
| Momentum | 10 | |
| Relative Strength | 10 | |

---

## 13. How Historical Trade Data Improves Model Decisions

This section explains the full feedback loop — from a closed trade back into Claude's next prompt. The system is designed to get measurably better with every trade logged.

### 13.1 The Flywheel

```
Trade closes → outcome + signals captured → deterministic tagging →
calibration aggregated → calibration block injected into next Claude prompt →
Claude adjusts conviction → better-calibrated recs → more accurate trades →
more data → tighter calibration
```

The system has no "memory" in the traditional AI sense. Instead, it builds a statistical model of its own past accuracy and injects that model as structured text into every prompt. Claude reads its own performance record and adjusts.

### 13.2 What Data Is Captured Per Trade

**At rec generation (automatic):**
- 24-field entry signal snapshot (`entry_signals_json`): RSI, BB%B, price vs SMA20/50/200, MACD histogram, volume, ATR, setup score, sector RS, earnings proximity, ADV
- `primary_entry_driver`: one of `mean_reversion | momentum_breakout | trend_pullback | fundamental_value | macro_tailwind`
- `regime` at entry time
- `confidence` and `priceRange`
- Scenarios (bull/base/bear probabilities and expected returns)

**At execution (manual trigger by user):**
- Actual entry price (vs Claude's priceRange — reveals systematic entry timing errors)
- Position size (vs quant engine suggestion — reveals sizing overrides)

**At close:**
- `realized_pnl_pct` from actual entry and exit prices per parcel
- `exit_reason`: `stop_hit | target_hit | manual` (direction-aware)
- `thesis_verdict`: determined by `computeThesisDrift()` comparing entry signals vs current signals at close time. Five states: `validated | partially_validated | invalidated | reversed | irrelevant`
- `holding_period_days`

**Lazily (background, within 24–48h):**
- `mae_pct`: worst intrabar adverse excursion from entry to exit (≤ 0)
- `mfe_pct`: best intrabar unrealised gain from entry to exit (≥ 0)
- These are computed from daily OHLC walking entry→exit; stop-first convention on straddle bars
- `stop_cf_saved`: 1/0 — would a wider (regime ATR multiple) stop have reached target instead?

### 13.3 The Calibration Feed — What Claude Reads

Every portfolio analysis call includes a calibration block (from `GET /api/learning/calibration`) injected into the user message. This is the primary mechanism by which historical data improves decisions.

**What the calibration block tells Claude:**

| Section | Content | Effect |
|---|---|---|
| Confidence bands | Win rate at 60–70%, 70–80%, 80%+ with Wilson 95% CI | Claude raises/lowers confidence on future recs to match actual hit rates |
| Top error pattern | The most common tag among recent losses (e.g. `stop_too_tight`, `early_exit`, `thesis_broken`) | Nudges Claude to account for its specific systematic error |
| Regime warning | Win rate in the current regime; `⚠REGIME_FLIP` if recent flip with < 10 trades | Claude applies extra caution in data-thin regimes |
| Per-ticker stats | Recent outcomes for tickers currently in the portfolio | Ticker-specific conviction adjustments |
| Thesis drift nudge | `⚠EARLY_EXIT_DRAG` when manual exits lag target-hit exits by > 3pp | Nudges Claude to hold longer |
| Skill insights | Skill scores by entry driver (are `momentum_breakout` trades well-executed?) | Adjusts how aggressively Claude uses weaker drivers |
| Conservatism warning | When virtual outcomes show high `would_have_won` rate | Tells Claude it's been too conservative; some passed-on trades would have worked |

**Deep mode** (full portfolio analysis only): Adds:
- `EXEMPLARS:` block — 2–3 recent closed losses and 1–2 best wins formatted as `ACTION TICKER @ RSI:XX BB%B:0.XX SMA200:+X% → +/-X.X% in Nd, error_tags`. These are few-shot examples showing what worked and what didn't in the same sector and regime.
- Per-driver playbook: `mean_reversion: 61% WR when RSI<30 vs 38% WR when RSI>45` — shows Claude when its own drivers fire most reliably
- Driver × regime cross-tabs: which drivers work in which regimes
- Setup score bucket analysis: whether high-score setups actually outperform

**Statistical gates — why nudges don't fire too early:**
- ESS (effective sample size) ≥ 6.0 required before any nudge
- Minimum n ≥ 12 for behaviour-changing nudges
- Wilson 95% CI must exclude the band midpoint — prevents noise nudges from 3–5 trades

### 13.4 Thesis Tracking — The Entry Driver Feedback Loop

The thesis tracking system answers: "Does my stated reason for entering a trade actually predict outcomes?"

**How it works:**

1. Claude records `primary_entry_driver` on every BUY/TOP_UP rec
2. Entry signals are snapshotted (24 fields) at log time
3. When a SELL/TRIM fires, `computeThesisDrift()` compares entry signals vs current signals
4. Result is `thesis_verdict` (5 states), patched to the original BUY event in `ai_learning_events`
5. `GET /api/learning/thesis-matrix` shows a cross-tab: `driver × verdict` with win rate per cell

**What this reveals:**

If `mean_reversion + validated = 71% WR` but `mean_reversion + invalidated = 28% WR`, the system learns that when the mean-reversion thesis breaks (RSI rises back above 50 without the stock following), cutting the loss fast is correct. This gets injected into the calibration block as a `THESIS: mean_reversion` nudge.

If `momentum_breakout + validated = 60% WR` vs `trend_pullback + validated = 78% WR`, Claude learns to favour pullback setups over breakouts in the current portfolio composition.

**Practical action:** Review the Thesis Matrix monthly. Drivers with < 50% validated-win rate are being used on the wrong setups. Update Rules to require tighter entry conditions for those drivers.

### 13.5 Error Tag Patterns — What to Do With Them

Error tags are computed deterministically from real trade data. They tell you which category of mistake is repeating.

**Reading the error distribution:**

| Pattern | Likely cause | Corrective action |
|---|---|---|
| `stop_too_tight` dominant | ATR multiple too low for current volatility; or entries happening at inflection points | Increase `stopAtrMultiple` in the Rules tab; or wait for RSI < 30 before entering mean-reversion setups |
| `early_exit` dominant | Manual exits before target; thesis drift verdicts are biased toward `invalidated` | Hold longer; check if `computeThesisDrift()` is flagging stale signals as "invalidated" when they're just noisy |
| `thesis_broken` dominant | Entering when macro / sector momentum is against the stock | Add regime-specific filters; require macro alignment (sector ETF trending up) before entering `trend_pullback` setups |
| `missed_catalyst` dominant | Entering too close to earnings dates | Already handled by `pre_earnings_risk` gate; review whether 14-day threshold is wide enough |
| `overconfident` dominant | Claude is issuing 80%+ confidence on stocks with poor calibration | The confidence band win rates should auto-correct this; check if deep calibration mode is enabled |
| `regime_mismatch` dominant | Strategy fired in the wrong macro environment | Review regime thresholds; consider tightening sideways → riskOff transition |

**The self-suppression mechanism:** When `stop_too_tight` precision < 50% (meaning wider stops wouldn't have saved those trades), the calibration nudge is automatically suppressed and `⚠STOP_TAG_UNRELIABLE` is emitted instead. This prevents the system from giving bad advice based on unreliable tag data.

### 13.6 MAE/MFE Path Quality — What It Reveals

`mae_pct` (maximum adverse excursion) and `mfe_pct` (maximum favourable excursion) per trade reveal path quality that P&L alone cannot show.

**Key ratios:**

| Scenario | Interpretation | Action |
|---|---|---|
| Deep MAE, high MFE, win | Got lucky — the stock recovered after testing the stop | Stop was too tight; or entry was at the wrong point in the cycle |
| Shallow MAE, high MFE, win | Clean path — thesis was right from the start | Note the entry conditions; replicate |
| Shallow MAE, thin MFE, loss | Market didn't move at all — low-conviction setup | Review setup score thresholds; avoid setups with score < 60 |
| Deep MAE, thin MFE, loss | Caught a falling knife; stock never recovered | Strengthen regime gate; avoid mean-reversion in riskOff |

These are displayed in the Learning page detail drawer and flow into `compute_skill_score_deterministic()` as +0.5 / −0.5 path modifiers. Over time, the skill score distribution tells you whether wins are being earned or lucky.

### 13.7 The Driver × Regime × Sector Matrix

`GET /api/learning/driver-matrix` returns a 3D performance table (n ≥ 3 cells only):
```
{driver: "mean_reversion", regime: "riskOn", sector: "Financials", n: 8, win_rate: 0.75, avg_pnl_pct: 4.2}
```

This answers: "Does mean-reversion work in Financials stocks when the macro regime is riskOn?"

**How to use it:**
1. Check the matrix before entering a new position in a new sector
2. Cells with < 45% WR are underperforming for that strategy × context combination
3. High-performance cells (> 65% WR, n ≥ 5) are your proven edge areas — size these trades up (within quant constraints)
4. In the calibration deep feed, the cross-tab appears as `mean_reversion: 61%WR(riskOn) vs 38%WR(highVol)` — Claude can see which regimes favour its strategies

**Updating the system with learnings:** When the matrix shows consistent underperformance in a cell (e.g., `momentum_breakout` in `sideways` regime), add an explicit rule via Settings → Rules: "Require confidence ≥ 0.80 for momentum_breakout setups in sideways regime." The custom rule is injected into the next prompt's ACTIVE RULE OVERRIDES section.

### 13.8 Virtual Outcomes — Filling the Execution Gap

Many recommendations are issued but not executed (too many recs, cash deployed elsewhere, user skips). Without tracking these, calibration only sees outcomes for trades the user chose to take — a self-selection bias that overstates performance.

`_resolve_virtual_outcomes()` resolves unexecuted recs ≥ 30 days old:
- Fetches current price vs rec's entry `priceRange` midpoint
- Classifies as `virtual_win | virtual_loss | virtual_open`
- Weights at 0.75× in calibration (lower confidence than executed trades)
- Emits "conservatism warning" when `would_have_won` rate is high — telling Claude it's being too selective

This also answers the question: "Are the recs I'm skipping actually good?" If virtual outcomes show 70% win rate on skipped recs in the current regime, the filtering criteria need to change.

### 13.9 Lessons — Human-Curated Pattern Library

Beyond statistical patterns, the Learning page allows adding explicit lessons (`POST /api/learning/lessons`):

```
"In high-vol regimes, RSI can stay below 30 for weeks — avoid mean-reversion buys until RSI turns up"
"CBA always gaps down on ex-dividend — plan entries 3 days after the ex date"
```

Lessons are injected (up to 4 per call) into the Claude user message, filtered by ticker, sector, regime, and market breadth context. They have a different quality from statistical calibration — they encode edge cases that require context a model can't derive from win/loss percentages alone.

**Breadth filtering:** Lessons tagged `adl_below_0.3` (breadth collapse) or `adl_above_0.7` (strong breadth) only inject when the current A/D ratio matches. This prevents bearish lessons from firing in bull markets.

### 13.10 Putting It Together — Quarterly Review Workflow

To systematically improve decisions using the historical data:

1. **Check calibration stats** (`GET /api/learning/stats`) — Which confidence bands are miscalibrated? If 70–80% conf has < 55% WR, tighten the minimum confidence floor.

2. **Review error distribution** — What's the #1 error tag this month? Match it to an actionable rule change (see Section 13.5).

3. **Check the thesis matrix** — Which entry drivers have the weakest `validated + win` rate? Add constraints or reduce their use.

4. **Review the driver × regime matrix** — Are there regime × driver cells you should avoid? Add regime-specific confidence floors for weak cells.

5. **Review skill scores** — Trades with skill score < 4 had bad process regardless of outcome. What pattern do they share? Add that pattern as a lesson.

6. **Check MAE/MFE distribution** — Are wins clean (shallow MAE) or lucky (deep MAE)? High lucky-win proportion means the system is getting away with poor entries — tighten setup score thresholds.

7. **Review virtual outcomes** — Are skipped recs outperforming executed ones? If so, the filtering logic (confidence floor, sector concentration) is too aggressive.

8. **Update `FACTOR_WEIGHTS`** — Run `POST /api/scanner/factor-stability` to get empirical IC values. Update `indicators.py → FACTOR_WEIGHTS` with factors that have positive, stable IC values.

The feedback cycle completes when rule changes from step 2–8 affect the next month's error distribution. A healthy system should see its dominant error type shift over time — meaning it learns and stops repeating the same mistakes.

---

## 14. Prompt Version History

| Version | Date | Key changes |
|---|---|---|
| `2026-06-v15` | Jun 2026 | Rule 20 (fundamentals > technicals), `reallocationSuggestion`, `FINANCIALS_SECTOR` module, `bullCase` required on BUY/TOP_UP, `invalidationCondition` validated, `_confidenceHeld` badge |
| `2026-06-v14` | Jun 2026 | Pre-earnings badge, scenarios required, bearCase threshold |
| Earlier | — | See git log |
