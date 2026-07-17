# ASX Equity Trading Strategy — Quantitative Confluence Framework

> **Scope:** Mean-reversion entries for ASX-listed equities — two distinct modes.
> **Swing:** 5–15 trading day holds using daily BB confluence.
> **Intraday:** Same-day VWAP-reversion entries, 3–4% target, closed by 15:00 AEST.
> **Philosophy:** Strict confluence of orthogonal (non-correlated) indicators. No subjective visual patterns — every rule is a computable formula. Cash is the default position when no setup qualifies.

---

## 1. Orthogonal Indicator Stack (Swing Trading)

Indicators are assigned to distinct mathematical dimensions to prevent multicollinearity (where multiple signals all reflect the same underlying price move, creating the illusion of independent confirmation).

| Dimension | Indicator | Params | Purpose |
|---|---|---|---|
| **1. Macro Trend** | SMA 200 | 200-day | Structural filter — long-term bias |
| **2. Micro Trend** | EMA 50 | 50-day | Medium-term dynamic support/resistance |
| **3. Location** | Bollinger Bands | (20, 2) | Volatility-adjusted price channel boundaries |
| **4. Momentum** | RSI | 14-period | Speed and change of price movement |
| **5. Volatility** | ATR | 14-period | Volatility metric for stops and position sizing |
| **6. Vol. Conviction** | Volume Z-Score | 20-period σ | Identifies statistically significant institutional participation |
| **7. Trend Strength** | ADX | 14-period | Regime filter — prevents mean-reversion in strong trends |
| **8. Accumulation** | OBV | — | Cumulative volume divergence — bonus confluence signal |

*Deprecated from earlier version: MACD, Stochastic RSI, Parabolic SAR — these are all price-momentum derivatives that add false confirmation, not independent data.*

---

## 2. Hard Pre-Trade Filters (Swing)

All filters must pass **before** any chart analysis begins. Fail = no trade.
The pre-filter runs client-side on live signals. After each scan the UI shows a colour-coded rejection breakdown (`BB −N · ADV −N · SMA −N · ADX −N`) so you can tune thresholds without trial-and-error.

### 2.1 Liquidity Filter
Prevents trading stocks where wide spreads and low float degrade technical execution.

- **ADV (20-day):** Average Daily Dollar Value > $1,500,000 AUD
  `ADV = mean(Close × Volume over last 20 days)`
- **Rationale:** Below this threshold, bid-ask spreads widen enough to eat expected profits on a 5–10 day swing.

### 2.2 Trend Filter
- **SMA 200:** `Close > SMA_200` OR price is within ±1.5% of SMA_200 and bouncing upward.
- **Rationale:** Bollinger Band mean-reversion in a structural downtrend generates low hit-rate losers.

### 2.3 Regime Filter
- **ADX:** `ADX < 35` — skip if `ADX ≥ 35 AND trend_strength = 'strong'`.
- **Rationale:** In strong trends (ADX rising, DI+ > DI−, `trend_strength='strong'`), BB lower-band touches are continuation setups dressed as reversals. The pre-filter uses both ADX ceiling and the `trend_strength` signal together — ADX alone above 35 is not a disqualifier if the trend strength is merely moderate.

### 2.4 Catalyst Filter
- **Hard exclusion:** No earnings announcements, RBA decisions, or major corporate actions within **5 trading days**.
- **Pre-earnings caution zone (5–14 days):** When `pre_earnings_risk = true` (earnings within 14 days), the setup is not skipped but the stop-loss ATR multiplier is raised by 1.3× (see §4.1). A `📅 Pre-earnings` badge appears on the rec card.
- **Rationale:** A gap-down on earnings wipes out the entire technical basis of the trade overnight. In the caution zone you can still enter, but only with a wider stop that accounts for elevated overnight risk.

### 2.5 Portfolio Correlation Filter
- The 20-day Pearson correlation ρ between the proposed trade and any open position must be **< 0.60**.
- **Qty reduction (automatic):** When executing, the quant engine reduces recommended share count by **30%** when |ρ| > 0.70 and by **50%** when |ρ| > 0.85 vs any existing holding. This is not a warning — it is a hard sizing constraint applied before the rec is displayed.
- **Rationale:** Buying ANZ when you already hold CBA gives you two positions in the same risk, not two independent bets. The sector 30% rule from the earlier version was a soft proxy for this — the correlation filter is the rigorous version.

### 2.6 Setup Staleness
- **Swing recs auto-expire after 3 days.** A `STALE Nd` badge is shown on setup cards older than 3 days (faded card, tooltip). Stale pending recs are auto-dismissed at the start of each new scan.
- **Rationale:** A BB reclaim setup from Monday is technically invalid by Friday — price has moved, BB bands have shifted, and the signal was contingent on that day's close.

### 2.7 Market Breadth Gate ✅ implemented Sprint 61
- **ADR (Advance/Decline Ratio):** Skip all new BUY setups when `advance_decline_ratio < 0.25` (fewer than 25% of ASX200 above their 20-day SMA).
- **Enforcement:** `_dtBuildRecs()` in `day-trading-analysis.js` — setups are still built but ALL are suppressed and shadow-logged (`shadow_reason: 'breadth_blocked'`); the scan summary shows an amber `⚠ BREADTH GATE` note. Tunable via Day Trading → Rules (`filterParams.minAdr`; 0 disables).
- The current ADR is shown on the Macro page and is computed after each scanner run. The regime engine also uses it to classify breadth-driven regimes.
- **Rationale:** When 75%+ of the market is in downtrend, individual mean-reversion setups have materially lower hit rates. Waiting for broad participation to recover (ADR > 0.35) before re-entering new positions preserves capital during distribution phases.

### 2.8 Volatility-of-Volatility (VoV) Filter ✅ implemented Sprint 62
- **Skip** when `ATR_today > 1.3 × ATR_5d_mean` — ATR is expanding rapidly (skip chosen over escalate: simpler, deterministic).
- **Enforcement:** `indicators.py` emits `atr_5d_mean` (mean of the 5 ATR values ending *yesterday*, so today's expansion is measured against the recent baseline rather than diluted by itself); both pre-filters (`_dtPreFilter` in `strategy.js`, `_dtPreFilterWithStats` in `day-trading-analysis.js`) reject on `atr_14 > vovMult × atr_5d_mean`; rejection breakdown shows a `VoV:N` bucket. Tunable via `filterParams.vovMult` (default 1.3; 0 disables).
- If VoV triggers, either skip the setup entirely or treat the current regime as one level more defensive (e.g., apply `riskOff` stop multiplier even in a `sideways` regime classification).
- **Rationale:** When ATR itself is accelerating, the noise floor estimate used to set the stop is already stale. Stop distances computed from last session's ATR understates current risk. The regime engine detects macro-level transitions but intra-regime ATR expansion goes undetected without this check.

### 2.9 Time-of-Week Filter (Swing) ✅ implemented Sprint 62
- **Enforcement:** `_dtTimeOfWeekBlocked()` in `day-trading-analysis.js`, evaluated on the Sydney wall-clock via `Intl.DateTimeFormat` (NOT the host clock — the server may not run in AEST). When blocked, `_dtBuildRecs()` suppresses all new setups with a `⏰ TIME-OF-WEEK` summary note. Deliberately NOT shadow-logged — the window is hours long and a post-window re-scan of the same setup would double-count in the ML. Toggle: `filterParams.timeOfWeekFilter` (default true).
- **Avoid initiating new swing positions:**
  - **Monday before 11:00 AEST** — weekend news gaps are unresolved; opening auction prints are unreliable until the market stabilises.
  - **Friday after 14:00 AEST** — position squaring into the close increases gap risk over the weekend before the stop can be adjusted.
- Existing positions are managed normally on these days; the filter applies to *new entries only*.
- **Rationale:** ASX stocks gap on overnight US moves. Monday morning entries and Friday afternoon entries statistically underperform mid-week entries on mean-reversion setups due to asymmetric gap risk.

---

## 3. Entry Signals (Swing)

**Actual mechanism (`_dtBuildRecs()` / `_sigDefs` in `js/day-trading-analysis.js`): every ticked confirmation must fire — AND-of-ticked-rules, not "primary + at least 2 of N."** Each of the four signals below is independently toggled via `DT_AI_PARAMS.enabled.*` (`js/strategy.js`); a signal that's off is simply skipped, not counted against the setup. There is no separate mandatory "primary" signal distinct from these four — BB Reclaim is one of the toggleable confirmations, same as the others, not a hard gate that always fires first.

**BB Reclaim:**
- `Close_{t-1} < BB_Lower_{t-1}` AND `Close_t > BB_Lower_t`
- Price breached the lower Bollinger Band and closes back inside it.
- This is the single most reliable mean-reversion trigger on daily timeframes.

### RSI Recovery

- `RSI_14 > RSI_{t-1}` AND `min(RSI over lookback) < threshold`
- RSI dipped below the oversold threshold recently and is now turning up.
- **Threshold is static, not regime-adaptive:** `ap.rsiThreshold ?? 35` (`day-trading-analysis.js`). A regime-scaled threshold table (tighter in riskOff/panic, shorter lookback in riskOn) is a documented idea, not implemented code — don't rely on it firing differently by regime.

### Volume Z-Score

- `Volume Z-Score = (Volume_t − μ_Volume_20) / σ_Volume_20 > threshold`
- The entry candle has statistically significant volume above the 20-day mean.
- **Threshold is static, not regime-adaptive:** `ap.volZScore ?? 1.5` (`day-trading-analysis.js`). As with RSI above, a regime-scaled table is aspirational, not wired into the code.

### Fibonacci Retracement Zone

- Entry price falls within the **50%–61.8% retracement** of the dominant 100-day swing high/low.
- `Price_t ∈ [Low_100 + 0.48 × (High_100 − Low_100), Low_100 + 0.63 × (High_100 − Low_100)]`
- The "golden pocket" is where the highest concentration of institutional buy orders typically rests.

### OBV Rising

- OBV is rising (or its 10-day average is rising) while price is still falling.
- Reveals hidden accumulation. **Off by default** (`DT_AI_PARAMS.enabled.obvRising: false` in `js/strategy.js`) — when a user turns it on, it becomes a required confirmation like any other ticked signal, not a bonus/optional overlay.

**Note — Sector ETF Relative Strength is NOT an entry gate.** `sector_rs_5d` (ticker 5-day return minus its sector ETF's 5-day return) is computed and surfaced for display/ML features (Journal, Recommendations, Signals pages) but is never checked in the swing entry-signal path. There is no sector-ETF confirmation signal in the code.

---

## 4. Position Sizing and Stop-Loss Math (Swing)

### 4.1 Stop-Loss Distance — Regime-Aware

The stop-loss ATR multiplier is regime-scaled at the engine level (`quant-engine.js` resolves `stopMultiple = userStopMult ?? regimeMod.stopAtrMult ?? default`), but in practice **the user-set value wins by default** at initial position sizing: `state.dayTrading.aiParams.stopAtrMultiple` boots hardcoded to `2.5` (`js/config.js`) and is never null, so the regime table below only takes effect once you clear that override. Regime-awareness is enforced by default through a separate, real-time mechanism instead: `checkRegimeStopWidening()` (`js/alerts.js`) watches for a regime flip on an *open* position and widens its stop post-hoc — see §6 Step 4.

| Regime | Stop ATR multiplier |
|---|---|
| `riskOn` / `trend` / `sideways` | **2.5 ×** ATR_14 |
| `highVol` | **3.0 ×** ATR_14 |
| `riskOff` | **3.5 ×** ATR_14 |
| `panic` | **4.0 ×** ATR_14 |

**Pre-earnings adjustment:** When `pre_earnings_risk = true` (earnings within 14 days), multiply the regime stop by an additional **1.3×** regardless of regime. The rec card shows a `📅 Pre-earnings` badge when this fires.

**Structural stop placement:** After computing the raw ATR-based stop, check whether it falls within **0.5% of a round number** ($10.00, $5.00, $2.50, $1.00) or the 200-day SMA. If so, place the stop just below that level. Round numbers and the 200-day SMA carry disproportionate sell-order density — stops placed above them are frequently hunted.

#### 4.x Overnight Gap Risk Floor

ASX positions are exposed to overnight gap risk from US market moves, commodity shocks, and corporate announcements. A stock can open below the stop before the market opens.

**Enhanced risk-per-share formula:**

```
RiskPerShare = max(ATR-based stop distance, Gap95 distance)

where Gap95 distance = current price × 95th-percentile overnight gap %
      computed from rolling 252 trading days of Open/Close data
```

**Example:**
- ATR stop distance: $0.50
- Gap95 (2.5% of $20.00): $0.50 → no change
- Gap99 (4.2% of $20.00): $0.84 → activates when gap99 > ATR stop

When Gap95 > ATR stop, position sizing uses Gap95 automatically (`_gapRiskActive: true` flag on rec).
Tickers with `gap95_pct` unavailable fall back to ATR-only sizing.

**Expected noise formula (reference):**
```
Expected noise over N days ≈ ATR_14 × √N
Over 10 days: ≈ ATR_14 × 3.16
```
Even the 2.5× riskOn stop sits comfortably above the expected 10-day noise floor.

### 4.2 Position Size Formula — Four-Constraint Sizing

The quant engine applies four constraints and takes the minimum:

```
1. Risk-based:    Portfolio risk ($) ÷ Stop distance
                  Portfolio risk = Capital × Risk% (max 1–2%)

2. Position cap:  Max 20% of allocated capital in one position

3. Liquidity cap: Max 5% of ADV_20 (20-day average daily share volume)
                  Prevents moving the market on entry/exit

4. Kelly cap:     (winProb × b − lossProb) / b × Capital × 0.25
                  Quarter-Kelly applied to the estimated win probability
                  and R:R ratio. Returns 0 (skip trade) when Kelly ≤ 0.
```

**Final qty = min(risk-based, position-cap, liquidity-cap, kelly-cap)**

The Kelly constraint can produce a lower qty than the ATR-risk formula when estimated win probability is marginal. If Kelly ≤ 0 (negative expected value), the rec is rejected entirely regardless of signal confluence.

**Example:** $100,000 portfolio, 1% risk = $1,000. CBA ATR = $3.50, `riskOn` regime.
Stop distance = 2.5 × $3.50 = $8.75. Risk-based shares = $1,000 ÷ $8.75 = 114 shares.
Kelly may further reduce this if confidence is below 60%.

---

## 5. Target and R:R Requirement (Swing)

- **Target:** `min(BB_Upper, nearest resistance level R1)` — whichever is closer.
- **Minimum R:R:** 2:1 (`(Target − Entry) / (Entry − Stop) ≥ 2.0`). Reject the setup if R:R < 2.
- **Typical R:R for strong setups:** 2.5–3.5:1 when entry is at lower BB and target is upper BB.
- R:R is computed from actual price levels (`(target − entry) / (entry − stop)`), not from parameter ratios, so the displayed figure reflects any price movement between scan and execution.
- **Estimated hold:** 8 trading days (shown on each setup card).

---

## 6. Exit Framework (Swing)

### Step 1 — Partial Profit (50% of position)

Trigger when **any** condition is met:
1. `Close ≥ BB_Upper (20,2)` — price reached mean-reversion target
2. `RSI_14 ≥ 70` — overbought momentum
3. `Close ≥ Entry + 0.618 × (BB_Upper − Entry)` — price has retraced 61.8% of the BB breach move, capturing the majority of the expected snap-back even if BB Upper is still days away

Take 50% off the table. Never let a winner turn into a loser on the full position.

### Step 2 — Chandelier Trailing Stop on Remaining 50%

```
Trailing stop = Highest daily close since entry − (regime_stopAtrMult × ATR_14)
```

Update daily. Exit the remaining 50% if the daily close falls below the trailing stop level. This anchors to the *actual peak of the trade* rather than a fixed formula, and automatically widens in volatile regimes.

**Practical tool:** Use the **📍 Trail** button on the rec card. It reads the current live price, fetches ATR from `state.liveSignals`, and applies the regime-appropriate multiplier. Only tightens (never loosens the stop). Confirm via the dialog to update the rec's stop level.

### Step 3 — Hard Stop-Loss (100% immediate exit)

Exit the entire position if **any** of these trigger:
1. Intraday price hits `Entry − (regime_stopAtrMult × ATR_14)` — initial stop
2. Daily close below SMA_200 on above-average volume (Z-Score > 1.0) — structural breakdown
3. Unexpected material negative news — fundamentals override technicals

### Step 4 — Qualitative Exit: Regime Flip

- If the **regime flips to `riskOff` or `panic`** while holding an open swing position, immediately advance to Step 2 (Chandelier trailing stop) on the full position — do not wait for a mechanical trigger.
- **Rationale:** The mean-reversion thesis was entered in a neutral or bullish regime. A regime flip invalidates the macro context that underpinned the trade. Holding the full position through a regime transition is a thesis mismatch, not a discipline failure to hold.
- The regime-change alert fires automatically (`fireAlert()`) when a flip to `panic` or `riskOff` is detected — use this as the trigger to review all open swing positions.
- **Automatic hard-stop widening (Sprint 66):** on every price refresh, `checkRegimeStopWidening()` recomputes the §4.1 regime stop for open executed BUY/TOP_UP positions and **widens** the hard stop when the current regime's `stopAtrMult` puts it below the stored stop (never tightens; a 📍-trailed stop always wins; one-shot per regime). Every widen fires an alert — risk per share has increased; exit per this Step 4 if you'd rather not carry the wider stop.

### Time-Based Exit (Dynamic)

Mean reversion is time-sensitive. If a setup fails to deliver, holding longer destroys the trade's edge.

**Regime-aware hold limits (trading days):**

| Regime | Max Hold |
|--------|----------|
| riskOn | 15 days |
| trend | 15 days |
| sideways | 12 days |
| highVol | 10 days |
| riskOff | 8 days |

**Rules:**
1. Hold limit uses the **current regime** at check time (not entry regime).
2. A 80% threshold triggers an amber ⏱ warning badge on the rec card.
3. A 100% threshold triggers a red ⏰ TIME STOP badge — close position by EOD.
4. Time stop only fires when **both** are true: partial profit not taken AND trailing stop not triggered.

The rationale: in highVol/riskOff environments, mean reversion must happen immediately (within 8–10 days) or the trade is likely to fail. In riskOn/trend markets, slow grinders need 15 days before being force-closed.

### Recording the Exit

From the Day Trading → Setups tab, click **📋 Record Close** on any executed swing card. The same price + brokerage dialog appears. The journal entry is updated and cash is credited automatically.

---

## 7. Alerts — Swing Trades

| Alert | Trigger | Behaviour |
|---|---|---|
| **Stop hit** | Live price ≤ `stopLoss` | Desktop + Telegram notification, error toast. One-shot; re-arms when price retreats >2%. |
| **Target hit** | Live price ≥ `target` | Desktop + Telegram notification, success toast. One-shot; re-arms when price falls >2%. |
| **Stale setup** | Pending rec >3 days old | `STALE Nd` badge on card; auto-dismissed at next scan. |
| **Sector concentration** | Execute with same-sector executed rec | Non-blocking warning toast before trade is committed. |
| **Regime flip** | Regime changes to `riskOff` or `panic` | `fireAlert()` fires — review all open swing positions and advance to Step 2 exits. |

Alerts are checked on every `refreshPrices()` call via `checkDayTradeStopTargetAlerts()`.

---

## 8. Intraday Strategy

### 8.1 Overview

| Attribute | Value |
|---|---|
| **Timeframe** | 5-minute bars (yfinance, ~5–15 min latency — indicative only) |
| **Entry window** | 10:45–15:00 AEST |
| **Target / Stop** | **ATR-based by default:** `stop = entry − 1.5×atr_5m`, `target = vwap + 2.0×atr_5m` (`js/intraday-strategy.js`, `routes/intraday.py`). Falls back to fixed **+3.5%/−1.5%** from entry only when `atr_5m` is unavailable. |
| **R:R gate** | Uses the honest **reversion R:R** (reward-to-VWAP ÷ risk), not the extended to-target R:R — the latter is inflated by the ATR-overshoot term. `minRrRatio` default is **1.0** (lower than swing's 2.0, since it's a conservative reversion basis). `rrExtended` (to-target) is shown for display only. |
| **Max positions** | 2 concurrent (configurable) |
| **Universe** | ASX20 / 50 / 100 / 200 (selectable; ASX100 default) |
| **Capital** | Separate allocation — 20% of cash by default |

### 8.2 Intraday Entry Signals

Two entry modes — **recapture** (preferred) and **discount** (fallback):

> **Implementation status:** only **Mode B is implemented** in `/api/intraday/scan` today
> (`routes/intraday.py`). Mode A below is the documented design for the preferred entry and
> is planned, not live — do not write tests expecting the scanner to emit recapture setups.
> This is also why the SPI defensive overlay (§8.8) currently blocks *all* passes: with only
> Mode B implemented, disabling Mode B leaves nothing.

**Mode A — VWAP Recapture (preferred — planned)**
- Price was below VWAP within the last 3 bars AND the most recent bar closes *above* VWAP
- `previous_low < VWAP AND current_close > VWAP`
- Analogous to the swing BB Reclaim — a confirmed crossback, not just a cheap price
- Wait for the bar to close before entering; do not chase mid-bar

**Mode B — VWAP Discount (fallback when no recapture yet)**
- `price < VWAP × (1 − 0.003)` — at least 0.3% below VWAP
- Use only when combined with all three additional confirmations below

**Additional confirmations (all required for Mode B; any 2 for Mode A):**

| Signal | Condition |
|---|---|
| **Intraday RSI oversold** | `intraday_rsi ≤ 40` on 5m bars |
| **Volume acceleration** | `vol_rising = true` from backend (current 5m bar volume > recent average) |
| **Above open** | `current_price > day_open` — short-term trend is up despite intraday dip |

The backend's `/api/intraday/scan` computes a composite `score` (0–100) incorporating VWAP distance, RSI, volume, and session timing. Recs are generated only for tickers meeting the `minScore` threshold (default 40).

### 8.3 Setup Staleness

- Intraday setup cards older than 90 minutes show a `⚠ STALE Nmin` badge (faded card) and are disabled for execution. VWAP, RSI, and volume ratios change too quickly for a 90-minute-old signal to be valid.
- Run a fresh scan before executing any stale setup.

### 8.4 Execution Flow

1. Click **⚡ Execute** — a dialog appears with pre-filled entry price (live) and default brokerage fee.
2. Confirm → position added to Open Positions; cash debited including brokerage.
3. Entry brokerage stored on the position (`entryFees`) for accurate round-trip P&L at close.

### 8.5 Close Flow

1. Click **Close @ $X.XXX** — dialog appears with live close price pre-filled and brokerage field.
2. Confirm → net P&L = `(closePrice − entryPrice) × qty − sellFee − entryFees`.
3. Trade journal entry created with actual round-trip fees; Today P&L updated.

### 8.6 Intraday Alerts

| Alert | Trigger | Behaviour |
|---|---|---|
| **Stop hit** | Live price ≤ position stop | Desktop notification + error toast; one-shot, re-arms on 2% retreat |
| **Target hit** | Live price ≥ position target | Desktop notification + success toast; one-shot, re-arms on 2% retreat |
| **Time-stop** | 15:00 AEST reached | Alert fires once per position; close before market liquidity thins |
| **Stale setup** | Pending rec > 90 minutes | `⚠ STALE Nmin` badge; non-clickable for execution |

Intraday stop/target alerts are checked via `checkIntradayStopTarget()` on every `refreshPrices()` call, independent of the 15:00 time-stop.

### 8.7 Today P&L

- `state.intraday.todayPnl` accumulates net P&L from all same-day closes.
- **Resets automatically on the next page load after midnight** — `pnlDate` is compared to `todayStr()` on DB restore; stale values are zeroed.

---

## 9. Market Regime Awareness

Identify the regime before scanning for setups. Not all environments suit mean-reversion.
The regime engine classifies the market into six named states using macro data, breadth, and volatility signals. Each maps to a different behaviour:

| Regime | Characteristics | Swing action | Stop multiplier |
|---|---|---|---|
| **`riskOn`** | Broad advance, ADR > 0.65, low VIX | Full size; BB mean-reversion ideal | 2.5× ATR |
| **`trend`** | Strong directional move, ADX rising | Enter only on pullbacks to EMA50; BB lower-band touches are high quality | 2.5× ATR |
| **`sideways`** | Low ADX, oscillating in range | BB mean-reversion ideal — buy lower band, target upper band | 2.5× ATR |
| **`highVol`** | Elevated ATR/VIX, whippy price action | Min confidence raised to 0.75; size reduced 30%; no breakout chases | 3.0× ATR |
| **`riskOff`** | Broad selling, ADR < 0.35, VIX rising | Avoid new longs. Manage existing: advance to Step 2 exits | 3.5× ATR |
| **`panic`** | Circuit-breaker territory; ADR < 0.15 | All recs blocked (qty=0, `_regimeBlocked='panic'`). Cash only. | 4.0× ATR (moot) |

**ASX-specific rule:** Always check the XJO trend on the Macro page before running a scan. A valid individual setup has a significantly lower hit rate when the broad market is in a downtrend.

#### Regime-Aware Heat Budget

The portfolio heat budget (total $ at risk across open positions as % of net worth) is dynamically capped by market regime:

| Regime | Max Heat |
|--------|----------|
| riskOn | 6% |
| trend | 5% |
| sideways | 5% |
| highVol | 3% |
| riskOff | 2% |
| panic | 0% (all BUY/TOP_UP blocked) |

The **effective limit** = min(user setting, regime ceiling). During riskOff, new positions are rare. During panic, no new longs are permitted regardless of user setting.

---

## 10. Trade Management Rules

| Rule | Detail |
|---|---|
| Max risk per trade | 1–2% of total portfolio capital |
| Max open swing positions | 5 concurrent (to limit correlated exposure) |
| Max open intraday positions | 2 concurrent (configurable up to 5) |
| Sector concentration | Automatic qty reduction when same-sector swing trade already executed |
| Swing hold period | 5–15 trading days (time-based exit if no signal) |
| Intraday hold period | Same session only — hard time-stop at 15:00 AEST |
| Averaging down | Never. Only add to winners. |
| Re-entry | Wait for a complete new setup to form after a stop-out. No revenge trading. |
| Review cadence | Check daily. Update Chandelier stop levels each evening via the 📍 Trail button. |

---

## 11. Execution Dialog (Both Modes)

All executions (swing BUY, intraday BUY, intraday CLOSE, swing CLOSE) go through a `_showTradeDialog` modal that collects:
- **Actual execution price** — pre-filled from the rec, user edits to fill price.
- **Brokerage fee** — pre-filled from `Settings → Default brokerage`; editable per trade.
- **Live cost/proceeds preview** — `N shares × $price ± $fee = $total` updates as you type.

This ensures the journal and portfolio ledger always reflect actual fill prices, not indicative recommendations.

---

## 12. Pre-Trade Scorecard (Swing)

```
===================================================================
QUANTITATIVE SWING SCORECARD
===================================================================
Ticker: ________    Date: __________    Price: $__________
Regime: __________  (riskOn / trend / sideways / highVol / riskOff)

PART 1: HARD FILTERS (all must pass)
[ ] ADV (20-day) > $1.5M AUD?                                YES / NO
[ ] Price > SMA 200? (or bouncing off it)                    YES / NO
[ ] ADX < 35 AND trend_strength not 'strong'?                YES / NO
[ ] No earnings/catalyst within 5 days? (5–14d: widen stop) YES / NO
[ ] Correlation to open trades < 0.60?                       YES / NO
[ ] Setup date < 3 days old?                                 YES / NO
[ ] ADR (advance/decline ratio) > 0.25?                      YES / NO
[ ] ATR today ≤ 1.3 × ATR_5d_mean? (VoV filter)             YES / NO
[ ] Not Monday pre-11:00 or Friday post-14:00?               YES / NO

PART 2: ENTRY SIGNALS (Primary + ≥2 Confirmations)
[ ] PRIMARY: Close crossed back inside lower BB?             YES / NO  ← MANDATORY
[ ] CONFIRM 1: RSI below regime threshold, now rising?       YES / NO
[ ] CONFIRM 2: Volume Z-Score above regime threshold?        YES / NO
[ ] CONFIRM 3: Price in 50%–61.8% Fib zone?                  YES / NO
[ ] CONFIRM 4: Sector ETF 5d return ≥ −2%?                   YES / NO
[ ] BONUS: OBV bullish divergence?                           YES / NO

PART 3: POSITION SIZING
Portfolio equity:              $__________
Risk % (max 2%):               $__________   (A)
ATR (14):                      $__________
Regime stop multiplier:        __________×   (2.5 / 3.0 / 3.5 / 4.0)
Pre-earnings adj (if applies): 1.0× / 1.3×
Stop distance:                 $__________   (B = ATR × mult × earnings_adj)
Structural level nearby?       YES / NO — if YES, stop just below it

Entry price target:            $__________
Stop-loss price:               $__________   (Entry − B)
Shares (risk-based):           __________    (A ÷ B)
Kelly constraint:              __________    (may reduce shares further)
Target:                        $__________   (BB upper or R1)
R:R ratio:                     __________    (must be ≥ 2.0)
===================================================================
```

---

## 13. What Was Removed and Why

| Removed | Reason |
|---|---|
| MACD histogram signal | Redundant with RSI — both are price-momentum derivatives. Creates false confluence (2 signals, 1 dimension). |
| Stochastic RSI | Same dimension as RSI — oscillator derivative of the same input. |
| Parabolic SAR | Replaced by Chandelier Exit which anchors to actual trade peak rather than a fixed formula. |
| Fixed 30% sector limit | Replaced by portfolio correlation filter (ρ < 0.60) with automatic qty reduction (30%/50%). |
| 1.5× ATR stop | Too tight for 5–15 day holds. Expected 10-day noise ≈ 3.16× ATR. Even the riskOn multiplier of 2.5× sits above this floor. |
| Fixed 2.5× ATR stop for all regimes | Stop multiplier now regime-aware (2.5–4.0×) to account for elevated tail risk in volatile and bearish conditions. |
| Fixed R:R ratio display | Was `targetPct / stopPct` — a constant, not the real ratio. Now computed from actual price levels. |
| Silent brokerage assumption | All executions now show a price + brokerage dialog; default pre-filled from settings. |
| Persistent todayPnl across days | todayPnl now resets automatically on the first page load of a new trading day. |
| Static RSI/Volume thresholds | Both are now regime-adaptive — tighter in panic/riskOff where signals lose discriminatory power; standard in calm regimes. |
| Manual Chandelier stop calculation | Replaced by the 📍 Trail button which computes and applies the regime-aware trailing stop automatically. |

---

---

## 14. Statistical Learning System — Trade History and Predictive Model

### 14.1 Purpose

The rule-based filters in §2 and §3 define which setups are *structurally valid*. They do not distinguish between valid setups that have historically worked well for **you** and valid setups that have not. Two traders using identical entry rules on the same ticker on the same day will accumulate different outcome distributions because execution timing, position sizing decisions, and individual judgement at exit create different samples.

The learning system is a **personalised expected-return estimator**. It records your own trades — entry signals, market context, and final outcome — then trains a statistical model on that personal history. The model answers one question:

> *Given these entry-time features (16 for swing, 19 for intraday), what R-multiple did my past trades with similar features actually achieve?*

This is distinct from the portfolio Claude analysis (qualitative conviction) and from the regime gate (structural macro filter) used elsewhere in the app. **The day-trading swing/intraday scan itself is fully quantitative — it never calls Claude.** `getDayTradeSystemPrompt`/`getDayTradeUniverseScanPrompt` exist in the codebase as dormant scaffolds but are not invoked by `runDayTradeAnalysis()`. The learning model operates on your realised outcomes; the regime gate operates on forward-looking macro structure; neither runs an LLM call as part of day-trading rec generation.

**No external API is called. All computation is deterministic Python/numpy running on your local machine.**

---

### 14.2 Architecture and Data Flow

```
Trade Execution
    │
    ▼
dtSaveSnapshot()                    ← js/dt-training.js
    │  fires immediately after execute; fire-and-forget (never blocks the trade)
    │
    ▼
POST /api/daytrading/snapshot       ← routes/day_trade_training.py
    │  persists FEATURES_SWING (16) or FEATURES_INTRADAY (19) + metadata to day_trade_history.db
    │
    │  (trade runs…)
    │
Trade Close
    │
    ▼
dtCloseSnapshot()                   ← js/dt-training.js
    │  called from _closeDayTrade() and closeIntradayPosition()
    │
    ▼
PATCH /api/daytrading/snapshot/<id>/close
    │  writes exit_price, pnl_pct, outcome ('win'|'loss'|'breakeven'), exit_reason
    │
    ▼
day_trade_history.db                ← day_trade_db.py (SQLite, WAL, separate from asx_trader.db)
    │
    │  [when you click Train Model]
    │
    ▼
POST /api/daytrading/train
    │
    ├── Load completed snapshots (outcome ≠ 'open'), sorted chronologically
    ├── Build per-scope feature matrices X  (swing: 16 cols, intraday: 19 cols)
    ├── Derive regime_risk (0–5 ordinal) from each snapshot's stored regime string
    ├── Continuous label y = R-multiple: (exit − entry) / (entry − stop)
    ├── OOS evaluation first (no leakage — impute/standardise/fit on train fold only):
    │     n ≥ 60 → 4-fold expanding-window walk-forward
    │     30 ≤ n < 60 → single chronological 70/30 holdout
    │     → r2_oos, mae_oos, n_test, cv_method
    ├── Refit final deployment model on ALL rows (impute → z-score → ridge)
    ├── Compute IC: Spearman rank correlation per feature with y
    └── Persist: weights, bias, μ, σ, r2_score/mae_score (in-sample),
        r2_oos/mae_oos/n_test/cv_method → model_state; IC → feature_importance
    │
    ▼
GET /api/daytrading/model           ← loads on Day Trading page open
    │  returns feature_names, weights[], bias, means[], stds[], model_type
    │  cached in window._dtModel (JavaScript; per-scope: .swing / .intraday)
    │
    ▼
dtPredictLocal(features, _dtModel)  ← client-side in dt-training.js
    │  no server round-trip per setup
    │
    ▼
📊 +X.XXR expected-R badge on each pending setup card (Setups tab)
```

The model is **not retrained automatically**. You control when to retrain via the 🧠 Model tab → **Train Model** button. Retrain after every 10–20 new completed trades.

---

### 14.3 Separate Database

The learning data lives in `day_trade_history.db` — a dedicated SQLite database, physically separate from the main `asx_trader.db`. This isolation is deliberate:

- Training data is append-only and never needs transactional consistency with portfolio or recommendation state.
- The main DB can be backed up / restored independently without touching historical trade snapshots.
- The WAL mode and `synchronous=NORMAL` settings are identical to the main DB.

Schema (key tables):

| Table | Purpose |
|---|---|
| `trade_snapshots` | One row per trade. Entry fields populated on execute; exit fields patched on close. |
| `model_state` | One row per training run. Stores serialised weights, bias, μ, σ as JSON. Only the latest row is used for predictions. |
| `feature_importance` | Per-feature IC and LR coefficient for each training run. Used by the Model tab bar chart. |

---

### 14.4 Feature Sets — Decoupled Swing (16) and Intraday (19)

Every snapshot records features at trade entry time. Features are sourced from `state.liveSignals[ticker]` (populated by `GET /api/analyse/<ticker>`) and `state.macroData` (from `GET /api/macro`).

Two separate training matrices are used — one per trade type. This eliminates the need for arbitrary imputation of missing intraday features on swing records.

#### Swing Trade Features (16)

| Feature | Description |
|---------|-------------|
| `rsi_14`, `bb_pct_b`, `bb_bandwidth`, `atr_pct`, `adx` | Momentum / volatility |
| `volume_zscore`, `mfi_14`, `stoch_k`, `williams_r`, `cci_20` | Volume / oscillators |
| `setup_score`, `price_vs_sma20`, `price_vs_sma50` | Trend position |
| `asx200_5d_ret`, `adl_ratio` | Market context |
| `regime_risk` | Ordinal regime risk 0–5 (riskOn=0 → panic=5) — derived at train time from the snapshot's stored `regime` string, so it applies retroactively to all historical snapshots *(Sprint 61)* |

#### Intraday Trade Features (19)
All 16 swing features plus:
- `intraday_rsi` — RSI on 5-minute bars
- `vwap_position` — % from VWAP
- `volume_accel` — recent volume vs 20-bar mean

These three are always `null` for swing trades. Separating the feature matrices eliminates the need for arbitrary imputation.

---

### 14.5 Kelly Phase Gate

The system applies a phased Kelly fraction based on the number of completed trades in `day_trade_history.db`:

| Phase | Trades | Kelly Fraction |
|-------|--------|---------------|
| 1 | < 200 | 0.10 (10%) |
| 2 | ≥ 200 | 0.25 (25%) |

Phase 1 uses a conservative 0.10 Kelly because win-rate and R:R estimates are noisy on small samples. Phase 2 unlocks the standard 0.25 Kelly once statistics stabilise across sufficient out-of-sample trades.

The `_kellyPhase` and `nCompletedTrades` fields are returned by `computeTradeParams()` and shown in the Day Trading Model tab.

### 14.6 Outcome Classification and Exit Reasons

```
outcome = 'win'        if  pnl_pct > +0.5%
outcome = 'breakeven'  if  -0.5% ≤ pnl_pct ≤ +0.5%
outcome = 'loss'       if  pnl_pct < -0.5%
```

The `outcome` classification drives the History tab stats and the Kelly phase gate (§14.5).
**It is no longer the model's training target** — since the Sprint 53 ridge upgrade the model
trains on the continuous R-multiple (§14.7); `outcome` remains as a human-readable label.

The 0.5% threshold is deliberate: ASX brokerage round-trip (2× $10 on a $5,000 position = 0.4%) means any "win" below 0.5% is economically a breakeven or worse after slippage. Treating breakeven as a loss makes the classification conservative — it only counts genuine positive outcomes.

`pnl_pct` is computed at close:
```
pnl_pct = (exit_price − entry_price) / entry_price × 100
```

For closed trades patched via `dtCloseSnapshot()`, this is computed from actual fill prices, not indicative values.

**Exit reason** is inferred from price geometry at close:

| Exit reason | Condition |
|---|---|
| `target` | `closePrice ≥ target × 0.99` |
| `stop` | `closePrice ≤ stopLoss × 1.01` |
| `time_stop` | Intraday 15:00 AEST auto-close |
| `manual` | Everything else |

---

### 14.7 Training Algorithm — Ridge Regression (Pure Numpy)

The training algorithm requires no external ML library. It runs entirely on `numpy`, which is already a transitive dependency of `yfinance`/`pandas`.

#### Label: Continuous R-Multiple (not binary win/loss)

```
y_R = (exit_price - entry_price) / (entry_price - stop_loss)
```

A +3.5R trade is treated differently from a +0.05R squeaker.
Negative values = losses. Threshold for win: y_R > 0.

#### Algorithm: L2-Regularised Ridge Regression (pure numpy)
- Loss: MSE + λ‖w‖² (λ = 0.05)
- Learning rate: 0.01, epochs: 2000
- Metrics: R² score, MAE in R-multiples
- Minimum samples: 30 (regression needs more data than classification)

Two independent models trained per run: Swing (16 features) and Intraday (19 features).

#### Step 1 — Data preparation

```python
# Build feature matrix (15 or 18 columns × N rows)
X_raw = [[row[f] or np.nan for f in feat_list] for row in rows]

# Mean imputation for NaN cells (uses training mean, not 0)
col_means = np.nanmean(X_raw, axis=0)
# ...

# Z-score standardisation
means = X_raw.mean(axis=0)
stds  = X_raw.std(axis=0)
stds[stds < 1e-9] = 1.0
X = (X_raw - means) / stds
```

**Imputation guard:** Missing features are imputed to the training column mean before z-scoring. This gives Z=0 (neutral) for missing values, not an artificially negative Z (e.g., RSI has a mean of ~50; imputing 0 would give Z≈−4, which is severely biased).

#### Step 2 — Information Coefficient (Spearman rank correlation)

Same as before — each feature's IC with the R-multiple target is computed. Features with IC ≈ 0 carry no signal.

#### Step 3 — Out-of-sample evaluation (Sprint 54)

Before the deployment model is fitted, the trainer measures honest predictive skill on
held-out rows. Rows are sorted chronologically and split by sample size:

| n (completed trades) | `cv_method` | Scheme |
|---|---|---|
| ≥ 60 | `walk_forward` | 4-fold expanding window — each fold trains on all earlier rows, predicts the next block |
| 30–59 | `holdout` | Train on the first 70%, predict the last 30% |
| held-out rows < 2 | `insufficient` | OOS metrics are `None` |

**Leakage guard:** inside each fold, NaN imputation means, z-score μ/σ, and the ridge
weights are all fitted on the **train rows only**, then applied to the test rows
(`_fit_and_predict_fold()`). Fitting any transform on the full matrix would leak test
information into training and overstate skill.

OOS metrics computed on the pooled held-out predictions:
```
r2_oos  = 1 − SS_res / SS_tot      (on held-out rows)
mae_oos = mean |y_test − y_pred|   (in R-multiples)
n_test  = number of held-out rows
```

`r2_oos` is the number to trust. The in-sample `r2_score` (Step 5) is retained for
overfitting diagnosis: high `r2_score` with negative `r2_oos` = the model memorised noise.

#### Step 4 — Ridge regression (final deployment model)

```python
def _ridge_regression(X, y, lr=0.01, epochs=2000, l2=0.05):
    n, p = X.shape
    w = np.zeros(p)
    b = 0.0
    for _ in range(epochs):
        predictions = np.dot(X, w) + b
        error       = predictions - y
        dw = np.dot(X.T, error) / n + l2 * w
        db = np.mean(error)
        w -= lr * dw
        b -= lr * db
    return w, b
```

**Hyperparameter rationale:**

| Parameter | Value | Reason |
|---|---|---|
| `lr` (learning rate) | 0.01 | More conservative than logistic — MSE gradients are larger. |
| `epochs` | 2,000 | More iterations than logistic to compensate for slower convergence. |
| `l2` (regularisation) | 0.05 | Higher than logistic — R-multiple targets have more noise. |

#### Step 5 — Model persistence

The deployment model is refit on **all** rows (the folds in Step 3 are evaluation-only),
then the following are serialised as JSON and stored in `model_state`:

```
feature_names     → ordered list of feature keys (16 or 19)
weights           → fitted w vector
bias              → fitted b scalar
feature_means     → μ from standardisation
feature_stds      → σ from standardisation
trade_type_scope  → 'swing' | 'intraday'
model_type        → 'ridge'
r2_score          → R² on training set (in-sample — diagnosis only)
mae_score         → MAE in R-multiples (in-sample)
r2_oos            → R² on held-out rows (the headline metric)
mae_oos           → MAE on held-out rows
n_test            → held-out row count
cv_method         → 'walk_forward' | 'holdout' | 'insufficient'
```

Each training run appends a new row to `model_state`. The prediction endpoints always use `ORDER BY trained_at DESC LIMIT 1` — old model runs are retained for audit but never used.

---

### 14.8 Shadow Signal Logging

**Problem:** If the ML only trains on trades you actually executed, the model learns a biased sample — it never sees valid setups that were blocked by heat limits, regime gates, or correlation filters.

**Solution:** When a technically valid rec is rejected by the execution engine, it is logged as a *shadow* record in `trade_snapshots` with `record_type = 'shadow'` and a `shadow_reason` tag.

| `shadow_reason` | Cause |
|-----------------|-------|
| `heat_blocked` | Rec would push portfolio heat over regime ceiling |
| `regime_blocked` | Panic regime blocked all new longs |
| `breadth_blocked` | §2.7 ADR breadth gate suppressed all new setups *(Sprint 61)* |
| `conf_floor` | BUY/TOP_UP dropped by the hard confidence floor *(Sprint 61)* |
| `neg_ev` | BUY/TOP_UP dropped by the engine-computed net-EV gate *(Sprint 61)* |

Shadow records are resolved lazily at training time via `_resolve_shadow_outcomes()`, which simulates the trade forward using yfinance price history (same target/stop/time-stop logic as live trade management). The resulting `r_multiple` is stored and the shadow record participates in training alongside executed records.

This gives the model the full unpruned distribution of valid setups — not just the ones that happened to fit within capital constraints that day.

**Note:** Shadow records count toward the Kelly phase gate threshold (200 trades). An unbiased sample of 200 is more meaningful than 200 hand-picked executions.

---

### 14.9 Prediction — Client-Side Inference

After `GET /api/daytrading/model` loads the per-scope models into `window._dtModel`
(`.swing` / `.intraday`), all predictions run entirely in the browser with no server round-trip:

```javascript
function dtPredictLocal(features, model) {
    var fn   = model.feature_names;  // ordered list of 16 or 19 names
    var w    = model.weights;
    var mu   = model.feature_means;
    var sig  = model.feature_stds;
    var bias = model.bias || 0;

    // Apply the same standardisation the training used
    var logit = bias;
    for (var i = 0; i < fn.length; i++) {
        // Imputation guard: missing values use the training mean → z = 0 (neutral)
        var raw = (features[fn[i]] != null) ? parseFloat(features[fn[i]]) : (mu[i] || 0);
        var z   = (raw - mu[i]) / sig[i];  // z-score
        logit  += z * w[i];
    }

    // Ridge models return the raw value: the expected R-multiple
    if (model.model_type === 'ridge') return logit;

    // Legacy logistic models (pre-Sprint-53): sigmoid → P(win)
    logit = Math.max(-20, Math.min(20, logit));
    return 1 / (1 + Math.exp(-logit));
}
```

For the current ridge models the returned value is the **expected R-multiple** for the setup
given its entry features. `dtExpectedRLabel(rec)` renders it as the **📊 +X.XXR** badge on each
pending Setups card (`dtWinProbLabel` survives as a backward-compat alias).

**Colour coding of the badge:**

| Expected R | Badge colour | Interpretation |
|---|---|---|
| ≥ +0.60R | Green | Historically profitable feature combination |
| +0.15R to +0.59R | Amber | Mixed signal; no strong historical edge |
| < +0.15R | Red | Historically weak feature combination — consider passing |

The badge is informational, not a gate. A red badge means your personal history with similar setups has been poor — it does not block execution.

---

### 14.10 Using the System in Practice

#### Building a usable dataset

Minimum **30 completed trades per trade type** (`MIN_TRAIN_SAMPLES = 30` — raised from 15
when the binary classifier became a regression; continuous targets need more data) are
required before that scope's model trains. Realistically, 50+ trades are needed before the
IC estimates stabilise. Shadow records (§14.8) count toward this threshold.

**Do not cherry-pick.** Let all completed trades flow into the DB automatically — including losses. A model trained only on winners has a 100% win rate on training data and no predictive power.

#### Retraining cadence

Retrain after every **10–20 new completed trades** or after a **regime transition** (the historical distribution of entry conditions shifts). The 🧠 Model tab shows the training timestamp and sample count — if it is more than 3 months old or has fewer than 20 samples, retrain before relying on the badge scores.

#### Interpreting feature importances

The bar chart sorts features by `|IC|` (absolute Spearman correlation with the R-multiple target). The sign matters:

| IC sign | Meaning |
|---|---|
| Positive | Higher feature value → higher historical win rate |
| Negative | Lower feature value → higher historical win rate |

**Example interpretations:**

- `bb_pct_b IC = −0.18` → setups where %B is lower (deeper in the lower band) have historically won more often. Your entries are better when they are more oversold.
- `adx IC = −0.12` → lower ADX at entry correlates with wins. Mean-reversion works better in ranging markets for you — consistent with the §2.3 regime filter.
- `asx200_5d_ret IC = +0.09` → setups entered after a rising market outperform those entered during market drawdowns. The broad market context matters.
- `rsi_14 IC ≈ 0` → RSI at entry has no discriminatory power in your sample. Either your RSI threshold is already well-calibrated, or RSI adds no information beyond `bb_pct_b` for your particular trade timing.

If `|IC| < 0.03` for all features after 50+ trades, your entry rules are already near-optimal for the signals you are tracking — the model cannot find additional edge. This is a valid and useful finding.

#### Separate swing and intraday models (automatic since Sprint 53)

Each **Train Model** run fits two independent models — swing (16 features) and intraday
(19 features) — on their own snapshot subsets. No manual record juggling is needed. Each
scope requires its own 30 completed trades; a scope below threshold simply reports
"insufficient data" while the other trains normally. `dtExpectedRLabel()` picks the model
matching the setup's `tradeType` at prediction time.

---

### 14.11 Model Reliability Boundaries

The model is a **low-sample pattern detector**, not a calibrated return estimator. Treat it accordingly.

| Condition (per trade type) | Reliability |
|---|---|
| n < 30 completed trades | No model for that scope. Rule-based filters only. |
| n = 30–59 | Model trains; OOS via a single 70/30 holdout — one split, so `r2_oos` is itself noisy. Treat badge as directional. |
| n ≥ 60 | Walk-forward OOS (4 folds) — `r2_oos` becomes meaningful. Top 3–4 features likely stable. |
| n ≥ 100 | Good reliability. `r2_oos` consistently above 0 across retrains indicates a real edge. |

**Regime is now a feature (Sprint 61)** — `regime_risk` lets ridge learn regime interaction directly. Still: If you built most of your dataset in a `riskOn` regime and are now trading in `riskOff`, the feature distributions differ and the model is stale. Add `regime` as a hard filter (only trade when regime matches the majority of training data) or retrain after the regime settles.

**OOS R² near zero is normal and expected.** Trade outcomes on a 5–15 day horizon are
inherently noisy; even `r2_oos` of 0.05–0.15 is genuinely useful for ranking setups. Judge
the model by `r2_oos`/`mae_oos`, never by the in-sample `r2_score`: a high in-sample R²
paired with a negative `r2_oos` means the model memorised noise (overfitting) — the Model
tab surfaces both so the comparison is one glance.

---

### 14.12 What the System Does Not Do

| Capability | Available? | Notes |
|---|---|---|
| Auto-adjust entry thresholds | No | FACTOR_WEIGHTS in `indicators.py` are static. The model augments, not replaces, the signal score. |
| Output a calibrated win probability | No | The ridge model predicts an expected R-multiple (magnitude), not P(win). Only legacy pre-Sprint-53 logistic models returned probabilities. |
| Call any external API | No | Pure numpy, local DB, no network calls. |
| Learn from other traders' data | No | Model is trained exclusively on your own trade history. |
| Optimise the entry rules in §2–§3 | No | Rule optimisation requires a different approach (e.g., the walk-forward backtest in §Performance). |
| Retrain automatically | No | Manual trigger only — protects against training on mid-regime noise. |

---

*Not financial advice. For personal research and strategy development only.*
*Always conduct your own due diligence. Past technical patterns do not guarantee future results.*
