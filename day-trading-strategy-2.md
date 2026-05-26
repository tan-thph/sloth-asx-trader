# ASX Equity Trading Strategy — Quantitative Technical Framework

> **Scope:** Mean-reversion and trend-following entries for ASX-listed equities.
> **Style:** Swing trading (holds of 5 to 15 trading days).
> **Philosophy:** Strict mathematical confluence of orthogonal (uncorrelated) indicators. Elimination of subjective visual patterns in favor of statistical rules.

---

## 1. Orthogonal Indicator Stack

To prevent multicollinearity (double-counting the same price movement), the indicator stack is strictly divided into non-correlated mathematical dimensions.

| Dimension | Indicator | Formula / Params | Purpose |
| :--- | :--- | :--- | :--- |
| **1. Macro Trend** | SMA 200 | 200-day Simple Moving Average | Structural filter (long-term bias) |
| **2. Micro Trend** | EMA 50 | 50-day Exponential Moving Average | Medium-term dynamic support/resistance |
| **3. Location** | Bollinger Bands | (20, 2) | Volatility-adjusted channel boundaries |
| **4. Momentum** | RSI | 14-period | Speed and change of price movements |
| **5. Volatility** | ATR | 14-period | Volatility metric for stops and sizing |
| **6. Vol. Conviction**| Volume Z-Score | 20-period standard deviation | Identifies institutional accumulation |

*Note: Redundant indicators (Stochastic RSI, MACD, and PSAR) have been deprecated to prevent curve-fitting and false confluence signals.*

---

## 2. Hard Liquidity & Portfolio Risk Filters

Before analyzing any chart, a stock must pass these quantitative filters. If any filter fails, **do not trade**.

### 2.1 ASX Liquidity Filter
Prevents trading illiquid mid/small-caps where wide bid-ask spreads and overnight gaps degrade technical execution.
1. **Average Daily Volume (ADV):** $\text{ADV}_{20} > \$1,500,000 \text{ AUD}$
2. **Slippage Constraint:** $\text{Average Spread \%} = \frac{\text{Ask} - \text{Bid}}{\text{Midpoint}} < 0.25\%$

### 2.2 Portfolio Covariance Filter
Prevents taking highly correlated risks (e.g., buying three banks simultaneously).
* **Correlation Limit:** The 50-day Pearson correlation coefficient ($\rho$) between any proposed trade ($X$) and currently open trades ($Y$) must be less than $0.60$.
$$\rho_{X,Y} = \frac{\text{Cov}(X,Y)}{\sigma_X \sigma_Y} < 0.60$$

---

## 3. Mathematical Buy Framework

### 3.1 Entry Conditions (Must meet the Primary Condition + at least 2 Confirmations)

#### A. Primary Condition: Bollinger Band Reclaim
* Price closes below the lower Bollinger Band, and subsequently **closes back inside** the lower band.
* Formula: $\text{Close}_{t-1} < \text{Lower BB}_{t-1}$ AND $\text{Close}_t > \text{Lower BB}_t$

#### B. Confirmation 1: RSI Recovery
* RSI (14) has dipped below 35 within the last 5 periods and is now rising.
* Formula: $\text{RSI}_t > \text{RSI}_{t-1}$ AND $\text{Min}(\text{RSI}_{[t-5 \dots t]}) < 35$

#### C. Confirmation 2: Volume Z-Score
* The entry candle displays statistically significant volume, confirming institutional support.
* Formula: $\text{Volume Z-Score} = \frac{\text{Volume}_t - \mu_{\text{Volume}, 20}}{\sigma_{\text{Volume}, 20}} > 1.50$
*(Volume is at least 1.5 standard deviations above its 20-period mean).*

#### D. Confirmation 3: Algorithmic Fibonacci Retracement Zone
* Entry occurs within a mathematical envelope of the $50\%$ to $61.8\%$ retracement of the dominant 100-day swing.
* Locate 100-day rolling High ($H$) and rolling Low ($L$).
* Formula: $\text{Price}_t \in [L + 0.48 \times (H - L), L + 0.63 \times (H - L)]$

### 3.2 Trend Filters (All must pass)
1. **Long-Term Trend:** $\text{Price}_t > \text{SMA 200}$ OR $\text{Price}_t$ is within $\pm 1.5\%$ of $\text{SMA 200}$ and bouncing.
2. **No Catalyst Risk:** No earnings results, RBA interest rate decisions, or known corporate actions within the next 48 hours.

---

## 4. Position Sizing & Stop-Loss Math

To survive random market noise over a 5 to 15-day hold period, the stop-loss must be wider than random price fluctuations. 

### 4.1 Expected Noise Formula
$$\text{Expected Noise over 10 days} \approx \text{ATR}_{14} \times \sqrt{10} \approx 3.16 \times \text{ATR}_{14}$$
To avoid getting stopped out by random market noise, the initial stop-loss is set to **$2.5 \times \text{ATR}_{14}$**.

### 4.2 Position Sizing Formula
$$\text{Position Size (Shares)} = \frac{\text{Portfolio Capital} \times \text{Risk \%}}{\text{Stop Loss Distance}}$$
$$\text{Stop Loss Distance} = 2.5 \times \text{ATR}_{14}$$

#### Example Calculation:
* Portfolio Capital = \$100,000 AUD
* Risk per trade = $1.0\%$ (\$1,000 AUD)
* CBA Entry Price = \$162.00 AUD
* CBA $\text{ATR}_{14}$ = \$3.50 AUD
* Stop Loss Distance = $2.5 \times \$3.50 = \$8.75$ (Stop price = \$153.25)
* Position Size = $\frac{\$1,000}{\$8.75} \approx 114 \text{ Shares}$ (Total Trade Value = \$18,468)

---

## 5. Sell & Exit Framework

### 5.1 Step 1: Partial Profit Taking (50% of Position)
Take $50\%$ of the position off the table when **either** of these mathematical thresholds are met:
1. **Upper Bollinger Band Reach:** $\text{Close}_t \ge \text{Upper BB (20,2)}$
2. **Overbought Momentum:** $\text{RSI (14)} \ge 70$

### 5.2 Step 2: Trailing Stop on Remaining 50% (Chandelier Exit)
To lock in profits on the remaining position without being shaken out by overnight index gaps, implement a Chandelier Exit trailing stop.
* Formula: $\text{Trailing Stop Level} = \text{Highest Close in Trade} - (3.0 \times \text{ATR}_{14})$
* Exit the remaining $50\%$ immediately if the daily close falls below the Trailing Stop Level.

### 5.3 Step 3: Hard Stop-Loss (Immediate 100% Exit)
Exit the entire position immediately without discretion if:
1. **Initial Stop Triggered:** Price hits $\text{Entry Price} - (2.5 \times \text{ATR}_{14})$ intraday.
2. **Structural Breakdown:** Daily close is below the $\text{SMA 200}$ on above-average volume ($\text{Volume Z-Score} > 1.0$).

---

## 6. Pre-Trade Quantitative Scorecard

Run this scorecard before executing any order. 

```text
===================================================================
QUANTITATIVE SWING SYSTEM SCORECARD
===================================================================
Stock Ticker: _________    Date: __________    Price: $___________

PART 1: HARD FILTERS (All must be "YES" to proceed)
[ ] 1. ADV (20-day) > $1.5M AUD?                   [ ] YES  [ ] NO
[ ] 2. Average Bid-Ask Spread < 0.25%?             [ ] YES  [ ] NO
[ ] 3. Correlation to current open trades < 0.60?  [ ] YES  [ ] NO
[ ] 4. Price > SMA 200? (or bouncing off it)       [ ] YES  [ ] NO
[ ] 5. No structural catalyst within 48 hours?     [ ] YES  [ ] NO

PART 2: CONFLUENCE SCORE (Must have Primary + at least 2 Confirmations)
[ ] PRIMARY: Close crossed back inside lower BB?   [ ] YES  [ ] NO
[ ] CONFIRM 1: RSI (14) < 35 in past 5 periods?    [ ] YES  [ ] NO
[ ] CONFIRM 2: Volume Z-Score > 1.50?              [ ] YES  [ ] NO
[ ] CONFIRM 3: Price in 50%-61.8% Fib Zone?        [ ] YES  [ ] NO

PART 3: RISK & POSITION SIZING CALCULATIONS
- Portfolio Equity:      $__________________
- Trade Risk (1%-2% max): $__________________ (A)
- Current ATR (14):      $__________________
- Stop Distance (2.5*ATR):$__________________ (B)

* Entry Price Target:    $__________________
* Stop Loss Price:       $__________________ (Entry - B)
* Total Shares to Buy:   __________________ (A / B)
===================================================================