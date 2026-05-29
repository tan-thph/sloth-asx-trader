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
- **ADX:** `ADX < 35` OR ADX > 35 but directional indicator DI+ is not dominant over DI−.
- **Rationale:** In strong trends (ADX rising, DI+ > DI−), BB lower-band touches are continuation setups dressed as reversals.

### 2.4 Catalyst Filter
- No earnings announcements, RBA decisions, or major corporate actions within **5 trading days**.
- **Rationale:** A gap-down on earnings wipes out the entire technical basis of the trade overnight.

### 2.5 Portfolio Correlation Filter
- The 20-day Pearson correlation ρ between the proposed trade and any open position must be **< 0.60**.
- **Rationale:** Buying ANZ when you already hold CBA gives you two positions in the same risk, not two independent bets. The sector 30% rule from the earlier version was a soft proxy for this — this is the rigorous version.
- **Runtime enforcement:** When executing a swing trade, the app fires a non-blocking toast warning if another executed DT rec shares the same sector.

### 2.6 Setup Staleness
- **Swing recs auto-expire after 3 days.** A `STALE Nd` badge is shown on setup cards older than 3 days (faded card, tooltip). Stale pending recs are auto-dismissed at the start of each new scan.
- **Rationale:** A BB reclaim setup from Monday is technically invalid by Friday — price has moved, BB bands have shifted, and the signal was contingent on that day's close.

---

## 3. Entry Signals (Swing)

**Requirement: PRIMARY signal must fire + at least 2 Confirmations.**

### Primary (Mandatory)

**BB Reclaim:**
- `Close_{t-1} < BB_Lower_{t-1}` AND `Close_t > BB_Lower_t`
- Price breached the lower Bollinger Band and closes back inside it.
- This is the single most reliable mean-reversion trigger on daily timeframes.

### Confirmation 1 — RSI Recovery

- `RSI_14 > RSI_{t-1}` AND `min(RSI over past 5 periods) < 35`
- RSI dipped below 35 recently and is now turning up.
- A 5-period lookback prevents missing the signal on a 1-day lag.

### Confirmation 2 — Volume Z-Score

- `Volume Z-Score = (Volume_t − μ_Volume_20) / σ_Volume_20 > 1.50`
- The entry candle has statistically significant volume — 1.5 standard deviations above the 20-day mean.

### Confirmation 3 — Fibonacci Retracement Zone

- Entry price falls within the **50%–61.8% retracement** of the dominant 100-day swing high/low.
- `Price_t ∈ [Low_100 + 0.48 × (High_100 − Low_100), Low_100 + 0.63 × (High_100 − Low_100)]`
- The "golden pocket" is where the highest concentration of institutional buy orders typically rests.

### Bonus Signal — OBV Bullish Divergence

- OBV is rising (or its 10-day average is rising) while price is still falling.
- Reveals hidden accumulation. Not required for a valid setup, but materially increases confidence when present.

---

## 4. Position Sizing and Stop-Loss Math (Swing)

### 4.1 Expected Noise Formula

```
Expected noise over N days ≈ ATR_14 × √N
Over 10 days: ≈ ATR_14 × 3.16
```

**Stop-loss distance = 2.5 × ATR_14**

This sits comfortably above the expected 10-day noise floor, reducing premature ejections.

### 4.2 Position Size Formula

```
Stop distance = 2.5 × ATR_14
Position size (shares) = Portfolio risk ($) ÷ Stop distance
Portfolio risk = Capital × Risk% (max 1–2%)
```

**Example:** $100,000 portfolio, 1% risk = $1,000. CBA ATR = $3.50.
Stop distance = 2.5 × $3.50 = $8.75. Stop price = entry − $8.75.
Shares = $1,000 ÷ $8.75 = 114 shares.

**Maximum single position size:** 20% of allocated capital.

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

Trigger when **either** condition is met:
1. `Close ≥ BB_Upper (20,2)` — price reached mean-reversion target
2. `RSI_14 ≥ 70` — overbought momentum

Take 50% off the table. Never let a winner turn into a loser on the full position.

### Step 2 — Chandelier Exit on Remaining 50%

```
Trailing stop = Highest daily close since entry − (3.0 × ATR_14)
```

Update daily. Exit the remaining 50% if the daily close falls below the trailing stop level. This is superior to Parabolic SAR because it anchors to the *actual peak of your trade* rather than a fixed formula.

### Step 3 — Hard Stop-Loss (100% immediate exit)

Exit the entire position if **any** of these trigger:
1. Intraday price hits `Entry − (2.5 × ATR_14)` — initial stop
2. Daily close below SMA_200 on above-average volume (Z-Score > 1.0) — structural breakdown
3. Unexpected material negative news — fundamentals override technicals

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

Alerts are checked on every `refreshPrices()` call via `checkDayTradeStopTargetAlerts()`.

---

## 8. Intraday Strategy

### 8.1 Overview

| Attribute | Value |
|---|---|
| **Timeframe** | 5-minute bars (yfinance, ~5–15 min latency — indicative only) |
| **Entry window** | 10:45–15:00 AEST |
| **Target** | +3.5% from entry (configurable 1–10%) |
| **Stop** | −1.5% from entry (configurable 0.5–5%) |
| **R:R** | Computed from actual price levels — typically ~2.3:1 at defaults |
| **Max positions** | 2 concurrent (configurable) |
| **Universe** | ASX20 / 50 / 100 / 200 (selectable; ASX100 default) |
| **Capital** | Separate allocation — 20% of cash by default |

### 8.2 Intraday Entry Signals

| Signal | Condition |
|---|---|
| **VWAP discount** | `price < VWAP × (1 − 0.003)` — at least 0.3% below VWAP |
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

| Regime | How to Identify | Action |
|---|---|---|
| **Ranging / Choppy** | ADX < 20, price oscillating between support/resistance | BB mean-reversion ideal — buy lower band, target upper band |
| **Trending Up** | Price > EMA21 > EMA50 > SMA200, ADX rising > 25 | Enter on pullbacks to EMA50; BB lower-band touches are high-quality setups |
| **Trending Down** | Price < EMA21 < EMA50 < SMA200 | Avoid longs entirely. Sidelines or reduce position sizes |
| **Breakout** | Price breaks SMA200 on high volume, ADX starting to rise | Wait for breakout retest — don't chase. Enter on first pullback |
| **Macro Risk-Off** | XJO (ASX 200) selling broadly, elevated index volatility | Reduce all position sizes by 50%, widen stops, increase cash |
| **High Volatility** | `regime = highVol` in regime engine | Min confidence raised to 0.75; size reduced 30%; no breakout chases |

**ASX-specific rule:** Always check the XJO trend. A valid individual setup has a significantly lower hit rate when the broad market is in a downtrend.

---

## 10. Trade Management Rules

| Rule | Detail |
|---|---|
| Max risk per trade | 1–2% of total portfolio capital |
| Max open swing positions | 5 concurrent (to limit correlated exposure) |
| Max open intraday positions | 2 concurrent (configurable up to 5) |
| Sector concentration | Soft warning when same-sector swing trade already executed |
| Swing hold period | 5–15 trading days (time-based exit if no signal) |
| Intraday hold period | Same session only — hard time-stop at 15:00 AEST |
| Averaging down | Never. Only add to winners. |
| Re-entry | Wait for a complete new setup to form after a stop-out. No revenge trading. |
| Review cadence | Check daily. Update Chandelier stop levels each evening. |

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

PART 1: HARD FILTERS (all must pass)
[ ] ADV (20-day) > $1.5M AUD?                       YES / NO
[ ] Price > SMA 200? (or bouncing off it)            YES / NO
[ ] ADX < 35 and/or DI+ not dominant?               YES / NO
[ ] No earnings / catalyst within 5 days?           YES / NO
[ ] Correlation to open trades < 0.60?              YES / NO
[ ] Setup date < 3 days old?                        YES / NO

PART 2: ENTRY SIGNALS (Primary + ≥2 Confirmations)
[ ] PRIMARY: Close crossed back inside lower BB?    YES / NO  ← MANDATORY
[ ] CONFIRM 1: RSI < 35 in past 5 periods, rising? YES / NO
[ ] CONFIRM 2: Volume Z-Score > 1.50?               YES / NO
[ ] CONFIRM 3: Price in 50%–61.8% Fib zone?         YES / NO
[ ] BONUS: OBV bullish divergence?                  YES / NO

PART 3: POSITION SIZING
Portfolio equity:         $__________
Risk % (max 2%):          $__________  (A)
ATR (14):                 $__________
Stop distance (2.5×ATR):  $__________  (B)

Entry price target:       $__________
Stop-loss price:          $__________  (Entry − B)
Shares to buy:            __________   (A ÷ B)
Target:                   $__________  (BB upper or R1)
R:R ratio:                __________   (must be ≥ 2.0)
===================================================================
```

---

## 13. What Was Removed and Why

| Removed | Reason |
|---|---|
| MACD histogram signal | Redundant with RSI — both are price-momentum derivatives. Creates false confluence (2 signals, 1 dimension). |
| Stochastic RSI | Same dimension as RSI — oscillator derivative of the same input. |
| Parabolic SAR | Replaced by Chandelier Exit which anchors to actual trade peak rather than a fixed formula. |
| Fixed 30% sector limit | Replaced by portfolio correlation filter (ρ < 0.60) which catches cross-sector correlations. |
| 1.5× ATR stop | Too tight for 5–15 day holds. Expected 10-day noise ≈ 3.16× ATR. 2.5× ATR sits above noise floor. |
| Fixed R:R ratio display | Was `targetPct / stopPct` — a constant, not the real ratio. Now computed from actual price levels. |
| Silent brokerage assumption | All executions now show a price + brokerage dialog; default pre-filled from settings. |
| Persistent todayPnl across days | todayPnl now resets automatically on the first page load of a new trading day. |

---

*Not financial advice. For personal research and strategy development only.*
*Always conduct your own due diligence. Past technical patterns do not guarantee future results.*
