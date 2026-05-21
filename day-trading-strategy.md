# ASX Equity Trading Strategy — Quantitative Confluence Framework

> **Scope:** Mean-reversion entries for ASX-listed equities.
> **Style:** Swing trading (holds of 5–15 trading days).
> **Philosophy:** Strict confluence of orthogonal (non-correlated) indicators. No subjective visual patterns — every rule is a computable formula. Cash is the default position when no setup qualifies.

---

## 1. Orthogonal Indicator Stack

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

## 2. Hard Pre-Trade Filters

All filters must pass **before** any chart analysis begins. Fail = no trade.

### 2.1 Liquidity Filter
Prevents trading stocks where wide spreads and low float degrade technical execution.

- **ADV (20-day):** Average Daily Dollar Value > $1,500,000 AUD
  `ADV = mean(Close × Volume over last 20 days)`
- **Rationale:** Below this threshold, bid-ask spreads widen enough to eat expected profits on a 5–10 day swing.

### 2.2 Trend Filter
- **SMA 200:** `Close > SMA_200` OR price is within ±1.5% of SMA_200 and bouncing upward.
- **Rationale:** Bollinger Band mean-reversion in a structural downtrend generates low hit-rate losers.

### 2.3 Regime Filter (re-introduced)
- **ADX:** `ADX < 30` OR `ADX > 30 and clearly declining` (trend weakening).
- **Rationale:** In strong trends (ADX > 30 rising), prices can stay far from the mean for weeks. BB lower-band touches in this regime are continuation setups dressed as reversals.

### 2.4 Catalyst Filter
- No earnings announcements, RBA decisions, or major corporate actions within **5 trading days**.
- **Rationale:** A gap-down on earnings wipes out the entire technical basis of the trade overnight.

### 2.5 Portfolio Correlation Filter
- The 20-day Pearson correlation ρ between the proposed trade and any open position must be **< 0.60**.
- **Rationale:** Buying ANZ when you already hold CBA gives you two positions in the same risk, not two independent bets. The sector 30% rule from the earlier version was a soft proxy for this — this is the rigorous version.

---

## 3. Entry Signals

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
- This is a more rigorous replacement for "above-average volume."

### Confirmation 3 — Fibonacci Retracement Zone

- Entry price falls within the **50%–61.8% retracement** of the dominant 100-day swing high/low.
- `Price_t ∈ [Low_100 + 0.48 × (High_100 − Low_100), Low_100 + 0.63 × (High_100 − Low_100)]`
- The "golden pocket" is where the highest concentration of institutional buy orders typically rests.

### Bonus Signal — OBV Bullish Divergence

- OBV is rising (or its 10-day average is rising) while price is still falling.
- Reveals hidden accumulation — institutional money absorbing supply while retail sells.
- Not required for a valid setup, but materially increases confidence when present.

---

## 4. Position Sizing and Stop-Loss Math

The stop must be wider than normal daily noise to avoid premature stops on valid setups.

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

## 5. Target and R:R Requirement

- **Target:** `min(BB_Upper, nearest resistance level R1)` — whichever is closer.
- **Minimum R:R:** 2:1 (`(Target − Entry) / (Entry − Stop) ≥ 2.0`). Reject the setup if R:R < 2.
- **Typical R:R for strong setups:** 2.5–3.5:1 when entry is at lower BB and target is upper BB.

---

## 6. Exit Framework

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

---

## 7. Market Regime Awareness

Identify the regime before scanning for setups. Not all environments suit mean-reversion.

| Regime | How to Identify | Action |
|---|---|---|
| **Ranging / Choppy** | ADX < 20, price oscillating between support/resistance | BB mean-reversion ideal — buy lower band, target upper band |
| **Trending Up** | Price > EMA21 > EMA50 > SMA200, ADX rising > 25 | Enter on pullbacks to EMA50; BB lower-band touches are high-quality setups |
| **Trending Down** | Price < EMA21 < EMA50 < SMA200 | Avoid longs entirely. Sidelines or reduce position sizes |
| **Breakout** | Price breaks SMA200 on high volume, ADX starting to rise | Wait for breakout retest — don't chase. Enter on first pullback |
| **Macro Risk-Off** | XJO (ASX 200) selling broadly, elevated index volatility | Reduce all position sizes by 50%, widen stops, increase cash |

**ASX-specific rule:** Always check the XJO trend. A valid individual setup has a significantly lower hit rate when the broad market is in a downtrend. Trade with the macro tide.

---

## 8. Trade Management Rules

| Rule | Detail |
|---|---|
| Max risk per trade | 1–2% of total portfolio capital |
| Max open positions | 5 concurrent (to limit correlated exposure) |
| Max single sector | Implicit via correlation filter (ρ < 0.60) |
| Hold period | 5–15 trading days (time-based exit if no signal) |
| Averaging down | Never. Only add to winners. |
| Re-entry | Wait for a complete new setup to form after a stop-out. No revenge trading. |
| Review cadence | Check daily. Update Chandelier stop levels each evening. |

---

## 9. Pre-Trade Scorecard

```
===================================================================
QUANTITATIVE SWING SCORECARD
===================================================================
Ticker: ________    Date: __________    Price: $__________

PART 1: HARD FILTERS (all must pass)
[ ] ADV (20-day) > $1.5M AUD?                       YES / NO
[ ] Price > SMA 200? (or bouncing off it)            YES / NO
[ ] ADX < 30 or clearly declining?                  YES / NO
[ ] No earnings / catalyst within 5 days?           YES / NO
[ ] Correlation to open trades < 0.60?              YES / NO

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

## 10. What Was Removed and Why

| Removed | Reason |
|---|---|
| MACD histogram signal | Redundant with RSI — both are price-momentum derivatives. Creates false confluence (2 signals, 1 dimension). |
| Stochastic RSI | Same dimension as RSI — oscillator derivative of the same input. |
| Parabolic SAR | Replaced by Chandelier Exit which anchors to actual trade peak rather than a fixed formula. |
| Fixed 30% sector limit | Replaced by portfolio correlation filter (ρ < 0.60) which catches cross-sector correlations. |
| 1.5× ATR stop | Too tight for 5–15 day holds. Expected 10-day noise ≈ 3.16× ATR. 2.5× ATR sits above noise floor. |

---

*Not financial advice. For personal research and strategy development only.*
*Always conduct your own due diligence. Past technical patterns do not guarantee future results.*
