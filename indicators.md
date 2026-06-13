# Indicators Reference

A complete reference for every technical indicator and data field produced by `indicators.py`. Covers what each indicator is, what it means in practice, which values are actionable, and how to change its parameters or scoring logic.

---

## How indicators are used

Every time you click **Analyse** on a ticker, run the **Market Scanner**, or request a portfolio analysis, `analyse_ticker()` in `indicators.py` fetches up to 6 months of adjusted daily OHLCV from yfinance (falling back to Stooq if yfinance fails), then computes the full indicator stack. The result is a dict with ~60 fields. Claude receives a curated subset; the Signals page shows most of them; the quant engine reads `atr_14`, `atr_pct`, `pre_earnings_risk`, and `adv_20` to size positions.

**Price series used:** `auto_adjust=True` — historical bars are dividend- and split-adjusted for continuity. The current (last) bar is the live market price. RSI, MACD, and Bollinger signals are internally consistent across ex-dividend gaps because the series is continuous. The `high_60d` / `low_60d` fields are computed on the raw High/Low columns, not Close, so they capture the actual intraday extremes.

**Forming-bar guard:** Before any computation runs, `_drop_forming_bar()` removes today's bar before 07:00 UTC (i.e. before ASX data fully settles). This prevents a partial intraday candle from spiking RSI or distorting MACD during market hours.

**Sanity check:** `_sanity_check()` drops any bar with a >25% single-day close move (unadjusted split artefact or data error). Penny stocks (close < $0.50) are exempt.

---

## 1. Trend Indicators

### Simple Moving Averages (SMA)

| Field | Parameters | Formula |
|---|---|---|
| `sma_20` | 20 bars | Rolling mean of last 20 closes |
| `sma_50` | 50 bars | Rolling mean of last 50 closes |
| `sma_200` | 200 bars | Rolling mean of last 200 closes |

**What they mean:** SMAs smooth out daily noise to show the underlying price trend. Price above a moving average = bullish relative to that timeframe; below = bearish.

**How to read them:**

- `price > sma_20` → short-term uptrend intact
- `price > sma_50` → medium-term uptrend intact
- `price > sma_200` → long-term uptrend intact (the 200 SMA is the most widely watched institutional level)
- `sma_20 > sma_50` → **Golden cross** (bullish — short-term average outpacing medium-term)
- `sma_20 < sma_50` → **Death cross** (bearish)

**To change period:** edit `close.rolling(20)` etc. in `analyse_ticker()`. The scanner's `_score_ticker()` uses its own simpler SMA calculation — update both if you change a period.

---

### Exponential Moving Averages (EMA)

| Field | Parameters |
|---|---|
| `ema_12` | 12-bar EMA |
| `ema_26` | 26-bar EMA |
| `ema_50` | 50-bar EMA |

**What they mean:** EMAs weight recent prices more heavily than SMAs. They react faster to price changes but are more susceptible to whipsaws.

`ema_12` and `ema_26` feed into MACD. `ema_50` is used in the `above_ema50` trend signal.

---

### Trend Score and Direction

| Field | Values | Meaning |
|---|---|---|
| `trend_score` | −1.0 to +1.0 | Net bullish signal fraction from the 7 trend sub-signals |
| `trend_direction` | `bullish` / `bearish` / `neutral` | Derived from trend_score (> 0.1 = bullish, < −0.1 = bearish) |

**The 7 sub-signals** (`trend_signals` dict):

| Signal | What it checks |
|---|---|
| `above_sma20` | price > 20-day SMA |
| `above_sma50` | price > 50-day SMA |
| `above_ema50` | price > 50-day EMA |
| `sma20_above_sma50` | Golden cross / Death cross |
| `macd_bullish` | MACD line > signal line |
| `macd_hist_positive` | MACD histogram > 0 |
| `macd_hist_rising` | MACD histogram expanding (today > yesterday) |

`trend_score = (bullish_count − bearish_count) / 7`

A score of +1.0 means all 7 sub-signals are bullish; −1.0 means all 7 are bearish; 0 means split.

---

### ADX — Average Directional Index

| Field | Parameters | Values |
|---|---|---|
| `adx` | 14-bar | 0–100 |
| `adx_plus_di` | 14-bar | 0–100 |
| `adx_minus_di` | 14-bar | 0–100 |
| `trend_strength` | derived | `strong` (ADX > 25) or `weak` |

**What it means:** ADX measures **trend strength**, not direction. It answers "how strongly is the market trending?" rather than "which way is it going?"

- **ADX < 20** — no real trend; range-bound. Momentum strategies underperform here.
- **ADX 20–25** — trend developing, borderline.
- **ADX > 25** → `trend_strength = "strong"` — confirmed trend. Momentum and breakout strategies are most reliable.
- **ADX > 40** — very strong trend. Pullback entries are riskier at this stage.

`+DI` vs `−DI` gives direction confirmation: `+DI > −DI` confirms the uptrend; `−DI > +DI` confirms the downtrend.

**To change period:** edit the `period=14` argument in `compute_adx(high, low, close)` in `analyse_ticker()`.

**To change the strong/weak threshold:** edit the `> 25` comparison in:
```python
trend_strength = "strong" if (adx_val or 0) > 25 else "weak"
```

---

## 2. Momentum Indicators

### RSI — Relative Strength Index

| Field | Parameters | Values |
|---|---|---|
| `rsi_14` | 14-bar Wilder EMA | 0–100 |
| `rsi_9` | 9-bar (faster) | 0–100 |

**What it means:** RSI measures the speed and change of recent price moves, scaled to 0–100. It is the most used indicator in the app — it gates scanner scoring, generates buy/sell signals, and influences the quant engine's stop distance via `pre_earnings_risk`.

**Classic interpretation:**

| RSI | Condition | Implication |
|---|---|---|
| < 30 | **Oversold** | Price fell fast; potential mean-reversion bounce |
| 30–40 | Low | Weak momentum, dip territory |
| 40–60 | **Neutral zone** | No strong signal |
| 35–55 | **Ideal pullback zone** | Scanner scores this highest for entry quality |
| 60–70 | High | Strong momentum, watch for extension |
| > 70 | **Overbought** | Price rose fast; potential mean-reversion pullback |

**Implementation:** uses Wilder's EWM (exponential weighted mean) with `com = period − 1`. This matches the standard Wilder smoothing method. The 9-period RSI reacts faster and is used as a secondary confirmation.

**In the scanner** (`_score_ticker`):
```
RSI 35–55  → rsi_score = 15  (ideal)
RSI 30–35  → rsi_score = 12
RSI 55–65  → rsi_score = 10
RSI < 30   → rsi_score = 5   (oversold panic — distress not setup)
RSI > 65   → rsi_score = 3   (overbought)
```

**To change the RSI period:** edit `period=14` in `compute_rsi(close, 14)` and `compute_rsi(close, 9)` in `analyse_ticker()`. Also update `_simple_rsi(closes, period=14)` in the scanner section if you want to change the scanner RSI.

**To change the overbought/oversold thresholds:** edit the `< 30`, `> 70` comparisons in the buy/sell signal list block, and the `35 <= rsi <= 55` breakpoints in `_score_ticker()`.

---

### MACD — Moving Average Convergence Divergence

| Field | Parameters | Values |
|---|---|---|
| `macd_line` | EMA(12) − EMA(26) | Can be any value |
| `macd_signal` | 9-bar EMA of macd_line | Can be any value |
| `macd_hist` | macd_line − macd_signal | Positive = bullish divergence |
| `macd_hist_prev` | Previous bar's histogram | Used for expansion/contraction detection |

**What it means:** MACD tracks the convergence and divergence of two EMAs.

- **MACD line > signal line** (`macd_bullish = true`) → bullish crossover
- **MACD line < signal line** → bearish crossover
- **Histogram positive and expanding** (today > yesterday) → momentum building up
- **Histogram positive and contracting** → momentum fading (potential trend exhaustion)
- **Histogram negative and expanding** → selling pressure increasing
- **Histogram negative and contracting** → selling pressure fading (possible base)

The histogram direction (`macd_hist_rising`) is often more useful than the crossover itself — it gives earlier warning.

**To change parameters:** edit `compute_macd(close, fast=12, slow=26, signal=9)`. Standard alternatives: (5, 35, 5) for weekly-equivalent signals; (8, 17, 9) for medium-term.

---

### Stochastic Oscillator

| Field | Parameters | Values |
|---|---|---|
| `stoch_k` | %K: 14-bar | 0–100 |
| `stoch_d` | %D: 3-bar SMA of %K | 0–100 |

**What it means:** Stochastic measures where the current close sits within its recent high-low range.

- **%K < 20** → oversold — price near the bottom of its recent range
- **%K > 80** → overbought — price near the top of its recent range
- **%K crosses above %D from below** → bullish signal
- **%K crosses below %D from above** → bearish signal

Most useful when combined with RSI. RSI oversold + Stochastic oversold = stronger mean-reversion signal.

**To change:** edit `k_period=14, d_period=3` in `compute_stochastic()`.

---

### Williams %R

| Field | Parameters | Values |
|---|---|---|
| `williams_r` | 14-bar | −100 to 0 |

**What it means:** The inverse of Stochastic, but expressed in a different scale. −80 to −100 = oversold; −20 to 0 = overbought. Not currently used in buy/sell signal logic but is available in the Signals page detail view.

---

### CCI — Commodity Channel Index

| Field | Parameters | Values |
|---|---|---|
| `cci` | 20-bar | Typically −200 to +200 |

**What it means:** CCI measures how far the price has moved from its statistical average (SMA of typical price), normalised by mean absolute deviation.

- **CCI < −100** → oversold; buy signal triggered
- **CCI > +100** → overbought; sell signal triggered
- **0** → price at its statistical average

**To change:** edit `period=20` in `compute_cci()`.

---

### MFI — Money Flow Index

| Field | Parameters | Values |
|---|---|---|
| `mfi` | 14-bar | 0–100 |

**What it means:** MFI is RSI with volume incorporated — it weights the momentum signal by the dollar flow into or out of the stock.

- **MFI < 20** → high-volume selling into oversold territory; potential accumulation
- **MFI > 80** → high-volume buying into overbought; potential distribution
- Divergence between MFI and price (price rising while MFI falls) signals weakening momentum backed by declining volume.

**To change:** edit `period=14` in `compute_mfi()`.

---

### ROC — Rate of Change

| Field | Parameters | Values |
|---|---|---|
| `roc_10` | 10-bar | % (positive = up) |
| `roc_21` | 21-bar | % (one-month return) |

**What it means:** Straight percentage return over N bars. `roc_10` ≈ 2-week momentum; `roc_21` ≈ 1-month momentum. Not used in buy/sell signal list directly, but available in the Signals page and injected into some Claude prompts as `return_5d` / `return_20d`.

---

## 3. Volatility Indicators

### Bollinger Bands

| Field | Parameters | Values |
|---|---|---|
| `bb_upper` | 20-bar SMA + 2σ | Price level |
| `bb_mid` | 20-bar SMA | Price level |
| `bb_lower` | 20-bar SMA − 2σ | Price level |
| `bb_pct_b` | derived | 0.0–1.0+ (can exceed 0/1) |
| `bb_bandwidth` | derived | % of mid-band |

**What they mean:** Bollinger Bands enclose ~95% of price movement when the market is ranging (assuming normality). They expand during high-volatility periods and contract during low-volatility consolidation.

**`bb_pct_b`** is the most useful derived field:

| `bb_pct_b` | Price location | Signal |
|---|---|---|
| > 1.0 | Above upper band | Overbought extension |
| 0.8–1.0 | Upper zone | Strong upside momentum |
| 0.5 | At midline | Neutral |
| 0.2–0.5 | Lower zone | Potential mean-reversion setup |
| < 0.2 | Near/below lower band | Oversold; bounce candidate |
| < 0 | Below lower band | Significant breakdown / high-vol |

`bb_pct_b = (close − lower) / (upper − lower)`

**`bb_bandwidth`** measures band width as % of the midline. Very low bandwidth (bands squeezing) often precedes a large directional move — a **volatility squeeze** setup.

**In buy/sell signals:**
- Price above midline and below upper → buy signal
- Price below midline and above lower → sell signal
- Price at/below lower band → buy signal (mean reversion)
- Price at/above upper band → sell signal

**To change:** edit `period=20, std_dev=2` in `compute_bollinger()`. Some traders use 2.5σ for wider bands on volatile ASX small-caps.

---

### ATR — Average True Range

| Field | Parameters | Values |
|---|---|---|
| `atr_14` | 14-bar Wilder EWM | Dollar amount |
| `atr_pct` | derived | `atr_14 / price × 100` (%) |
| `atr_5d_mean` | mean of bars −6 to −2 | Dollar amount |

**What it means:** ATR is the single most important indicator for the quant engine. It measures the average day-to-day price range (including gap opens), capturing the true volatility of the stock.

**`atr_pct`** is the normalised version — it expresses ATR as a percentage of current price, making it comparable across stocks of different price levels.

- **ATR % < 1%** — very low volatility; suitable for larger positions (stop can be tight)
- **ATR % 1–2%** — normal for large-cap ASX names (BHP, CBA)
- **ATR % 2–4%** — elevated; mid-cap territory
- **ATR % > 4%** — high volatility; position sizes shrink accordingly

**How the quant engine uses ATR:**

`stop distance = stopAtrMult × earningsAdj × atr_14`

Where `stopAtrMult` comes from the current regime (2.5 in riskOn/trend/sideways, 3.0 in highVol, 3.5 in riskOff, 4.0 in panic). `earningsAdj = 1.3` when `pre_earnings_risk = true` (widens the stop to survive pre-earnings volatility).

**`atr_5d_mean`** is the mean of the 5 ATR values ending *yesterday* (bars −6 to −2, excluding today). It's used as a baseline to detect sudden ATR expansion — a rapid ATR spike above this baseline is a volatility-of-volatility (VoV) filter input for day trading.

**To change the ATR period:** edit `period=14` in `compute_atr()`. Note: changing this affects stop distances and position sizing across all AI recommendations.

---

### Keltner Channels

| Field | Parameters | Values |
|---|---|---|
| `keltner_upper` | EMA(20) + 2 × ATR(10) | Price level |
| `keltner_lower` | EMA(20) − 2 × ATR(10) | Price level |

**What they mean:** Keltner channels use ATR (not standard deviation) for their width, making them less sensitive to spike events than Bollinger Bands. When price breaks outside Bollinger Bands but stays inside Keltner channels, the move is likely driven by a one-off spike rather than sustained momentum. When price breaks both, the signal is stronger.

**To change:** edit `ema_period=20, atr_period=10, multiplier=2` in `compute_keltner()`.

---

### Donchian Channels

| Field | Parameters | Values |
|---|---|---|
| `donchian_upper` | 20-bar highest high | Price level |
| `donchian_lower` | 20-bar lowest low | Price level |

**What they mean:** The simple channel of the highest high and lowest low over the lookback period. Classic breakout signal: a close above `donchian_upper` is a new 20-bar high; a close below `donchian_lower` is a new 20-bar low. Used in trend-following and breakout strategies.

**To change:** edit `period=20` in `compute_donchian()`.

---

### Historical Volatility

| Field | Parameters | Values |
|---|---|---|
| `hist_vol_20` | 20-bar annualised | % (e.g. 25 = 25%/year) |
| `hist_vol_60` | 60-bar annualised | % |

**What they mean:** Historical volatility (HV) is the annualised standard deviation of daily returns.

`HV = daily_return_std × √252 × 100`

- **HV < 15%** — quiet, low-volatility stock
- **HV 15–25%** — normal active-equity range
- **HV > 35%** — high volatility; small-cap, speculative, or event-driven

`hist_vol_20` reacts quickly; `hist_vol_60` is the longer-term baseline. A sharp rise in `hist_vol_20` above `hist_vol_60` signals a regime change in the stock's own volatility.

---

### Overnight Gap Risk

| Field | Parameters | Values |
|---|---|---|
| `gap95_pct` | 126-bar (6-month) 95th percentile | % (e.g. 0.015 = 1.5%) |
| `gap99_pct` | 126-bar 99th percentile | % |

**What they mean:** Gap risk measures the overnight jump — `|Open_t − Close_{t−1}| / Close_{t−1}`. The 95th and 99th percentile gap over the last 6 months tells you the size of gap you should budget for on bad days.

A `gap95_pct` of 0.025 means 95% of overnight gaps are smaller than 2.5% — but once per 20 trading days you can expect a gap of at least that size. This is particularly important for illiquid stocks where a gap can skip your stop entirely.

---

## 4. Volume Indicators

### Volume Ratio and Z-Score

| Field | Parameters | Values |
|---|---|---|
| `volume_today` | raw | Share count |
| `volume_avg_20` | 20-bar SMA | Share count |
| `volume_ratio` | derived | `volume_today / volume_avg_20` |
| `volume_z_score` | derived | Std deviations from 20-bar mean |

**What they mean:**

- `volume_ratio > 1.5` → today's volume is 50% above normal (significant activity)
- `volume_ratio > 2.0` → very high volume (institutional activity, news-driven, or breakout)
- `volume_z_score > 2` → 2 standard deviations above the mean — statistically unusual

High volume on an up day is bullish confirmation (accumulation). High volume on a down day is bearish (distribution). Low volume on a price move is unconfirmed — treat it with caution.

**In buy/sell signals:**
- `volume_ratio > 1.5` + price up → "High volume bullish day" signal
- `volume_ratio > 1.5` + price down → "High volume bearish day" signal

---

### ADV — Average Daily Value

| Field | Parameters | Values |
|---|---|---|
| `adv_20` | 20-bar rolling | AUD dollar turnover |

**What it means:** `adv_20 = mean(close × volume)` over 20 days — the average dollar value traded per day. This is the **liquidity metric** used by the quant engine.

- **ADV > $5M** — liquid; institutional-grade
- **ADV $1M–$5M** — moderately liquid; some position-size constraint
- **ADV < $1M** — illiquid; the quant engine will cap position size heavily

The quant engine's liquidity constraint limits your position to a fraction of ADV so you don't become a significant share of a day's trading yourself. A large position in a thin stock amplifies both your impact (moving the price against yourself) and your slippage on exit.

**Important:** `adv_20` is AUD dollar turnover, not share count. `volume_avg_20` is share count. Do not confuse the two.

---

### OBV — On-Balance Volume

| Field | Values |
|---|---|
| `obv_trend` | `rising` or `falling` |

**What it means:** OBV is a running cumulative volume sum: add the day's volume when price closes up, subtract when it closes down. The trend of OBV relative to its 10-bar average gives the signal.

- **OBV rising with uptrend** → volume confirms the trend (strong signal)
- **OBV falling with uptrend** → divergence — volume not backing the move (warning)
- **OBV falling with downtrend** → volume confirms the selling (continuation)
- **OBV rising with downtrend** → potential accumulation under bearish price action (reversal watch)

---

### VWAP — Volume-Weighted Average Price

| Field | Parameters | Values |
|---|---|---|
| `vwap_20d` | 20-day rolling VWAP | Price level |
| `price_vs_vwap` | derived | `above` or `below` |

**What it means:** VWAP is the average price weighted by volume — it represents the average cost paid by all participants over the period. Institutional traders often benchmark against VWAP, making it a key level.

- **Price above VWAP** → buyers in control on average
- **Price below VWAP** → sellers in control; stock has traded above average cost

Used as a trend confirmation signal. The Signals page uses `price_vs_vwap` to colour the VWAP row.

---

## 5. Support and Resistance

### Pivot-Based S/R Levels

| Field | Values |
|---|---|
| `support_resistance.pivot` | Central pivot |
| `support_resistance.r1` | Resistance 1 |
| `support_resistance.r2` | Resistance 2 |
| `support_resistance.s1` | Support 1 |
| `support_resistance.s2` | Support 2 |

**How they're calculated** (classic floor trader pivots):

```
pivot = (50-day high + 50-day low + last close) / 3
R1 = 2 × pivot − 50-day low
R2 = pivot + (50-day high − 50-day low)
S1 = 2 × pivot − 50-day high
S2 = pivot − (50-day high − 50-day low)
```

**What they mean:** These are price levels where the market has historically paused or reversed, derived from the recent 50-day trading range. They are used in two places in the app:

1. The stop-loss suggestion in `analyse_ticker()` uses `sr["s1"]` as a floor — stops are placed at `max(cp − 1.5×ATR, S1)` so they respect a known structural level rather than being purely mechanical.
2. The Signals page displays them as reference levels on the price chart.

**To change the lookback:** edit `lookback=50` in `compute_support_resistance()`.

---

## 6. Returns and Price Location

| Field | Values | Meaning |
|---|---|---|
| `return_1d` | % | Yesterday's close vs today |
| `return_5d` | % | 5-day return (≈ 1 week) |
| `return_20d` | % | 20-day return (≈ 1 month) |
| `return_60d` | % | 60-day return (≈ 3 months) |
| `return_90d` | % | 90-day return |
| `high_60d` | $ | Highest high over last 60 bars |
| `low_60d` | $ | Lowest low over last 60 bars |
| `pct_from_52w_high` | % (negative) | Distance below 52-week high |
| `pct_from_52w_low` | % (positive) | Distance above 52-week low |

**`high_60d` and `low_60d`** require at least 60 bars of history. They are used to calculate the **Fibonacci day-trade signal** (Signal #4 in the day-trade strategy): a stock trading 5–20% below its 60-day high in a pull-back zone is the primary setup. When either field is `None` (new listing or insufficient history), the day-trade signal falls back to using `return_60d` in the −20% to −5% range instead.

**`pct_from_52w_high`** is computed from fundamentals (`info["fiftyTwoWeekHigh"]`), not price history, so it reflects the true 52-week range regardless of the analysis period.

---

## 7. Earnings Proximity

| Field | Values | Meaning |
|---|---|---|
| `days_to_earnings` | integer or `None` | Calendar days to next earnings date |
| `pre_earnings_risk` | boolean | True when `0 ≤ days_to_earnings ≤ 14` |

**What it means:** Earnings announcements cause rapid, unpredictable price moves. Being long through an earnings event is a binary risk that technical analysis cannot price. When `pre_earnings_risk = true`:

1. The quant engine multiplies ATR-based stops by `earningsAdj = 1.3` — a 30% wider stop to budget for the earnings gap.
2. The rec card shows a 📅 Pre-earnings badge.
3. The error tagger can flag `missed_catalyst` if you enter within this window and lose.

**The 14-day threshold is hardcoded.** To change it:
```python
# indicators.py line ~725
pre_earnings_risk = bool(days_to_earnings is not None and 0 <= days_to_earnings <= 14)
```
Change `14` to your preferred days-out threshold. The quant engine's `earningsAdj = 1.3` multiplier is in `js/quant-engine.js` — update both if you want to change the stop-widening behaviour.

---

## 8. Composite Signal

The composite signal is generated at the end of `analyse_ticker()` by tallying all the buy and sell signals detected above.

```python
signal_score = (buy_count − sell_count) / (buy_count + sell_count)
composite = "BUY" if signal_score > 0.3 else "SELL" if signal_score < -0.3 else "HOLD"
confidence = min(0.95, abs(signal_score) × 0.7 + (adx / 100) × 0.3)
```

**Important:** This composite signal is a **mechanical heuristic** — it is shown on the Signals page as a quick reference but is **not** used to determine Claude's recommendations. Claude receives the full indicator stack (RSI, MACD, ATR, trend signals, etc.) and forms its own qualitative assessment. The composite signal is used only in `analyse_ticker()`'s built-in price target and stop-loss suggestions (which Claude also ignores in favour of the quant engine's ATR-based sizing).

**To change the BUY/SELL threshold:** edit `> 0.3` and `< -0.3` in the signal_score comparisons. Raising the threshold to ±0.5 would require a stronger consensus before switching from HOLD.

---

## 9. Scanner Score (0–100)

The scanner score is computed by `_score_ticker()` — a lightweight, numpy-only function used during batch market scans. It produces a single 0–100 number from five weighted components.

### Score formula

```
score = (trend × w["trend"]/30) + (pullback × w["pullback"]/30)
      + (vol_score × w["volume"]/20) + (mom_score × w["momentum"]/10)
      + (rs_score × w["rs"]/10)
```

### Components

**Trend (0–30)**

Three binary checks, each worth 10 points:
- Price above 20-day SMA → +10
- Price above 50-day SMA → +10
- 20-day SMA currently rising (today vs 5 days ago) → +10

**Pullback quality (0–30)**

RSI zone sub-score (0–15) + position-from-high sub-score (0–15):

| RSI range | Sub-score |
|---|---|
| 35–55 | 15 (ideal pullback RSI) |
| 30–35 | 12 |
| 55–65 | 10 |
| < 30 | 5 (panic territory) |
| > 65 | 3 (overbought) |

| Distance from 90-day high | Sub-score |
|---|---|
| −20% to −5% | 15 (ideal pullback window) |
| −5% to 0% | 9 (near high — momentum mode) |
| −30% to −20% | 10 (deeper dip, more risk) |
| < −30% | 4 (potential distress) |

**Volume (0–20)** — 5-day average vs 20-day average:

| 5d/20d ratio | Score |
|---|---|
| > 1.5× | 20 |
| > 1.1× | 15 |
| > 0.8× | 10 |
| ≤ 0.8× | 5 |

**Momentum (0–10)** — 5-day return:

| 5-day return | Score |
|---|---|
| > +3% | 10 |
| 0% to +3% | 8 |
| −2% to 0% | 5 |
| < −2% | 2 |

**Relative Strength vs ASX200 (0–10)** — 5-day alpha vs ^AXJO:

| Alpha (stock − index 5d) | Score |
|---|---|
| > +4pp | 10 |
| +2 to +4pp | 8 |
| 0 to +2pp | 6 |
| −2 to 0pp | 4 |
| < −2pp | 1 |
| Index unavailable | 5 (neutral default) |

### Score interpretation

| Score | What it means |
|---|---|
| 70–100 | Strong setup: uptrend intact, healthy pullback, volume confirming, positive momentum |
| 55–70 | Decent setup; some conditions met but not all |
| 40–55 | Mixed signals; wait for clearer conditions |
| < 40 | Weak or broken setup; avoid new entries |

---

## 10. Fundamentals

`fundamentals` is a sub-dict populated from `yf.Ticker.info`. All fields are `None` when yfinance cannot retrieve them (ETFs, delisted stocks, data gaps).

| Field | Source | What it means |
|---|---|---|
| `pe_ratio` | `trailingPE` | Trailing 12-month P/E |
| `forward_pe` | `forwardPE` | Consensus forward P/E |
| `pb_ratio` | `priceToBook` | Price-to-book ratio |
| `eps` | `trailingEps` | Trailing 12-month EPS in AUD |
| `dividend_yield` | `dividendYield` | Annual yield (normalised to decimal) |
| `payout_ratio` | `payoutRatio` | Dividends / earnings |
| `roe` | `returnOnEquity` | Net income / equity |
| `roa` | `returnOnAssets` | Net income / total assets |
| `debt_to_equity` | `debtToEquity` | Total debt / equity |
| `current_ratio` | `currentRatio` | Current assets / current liabilities |
| `revenue_growth` | `revenueGrowth` | YoY revenue growth rate |
| `earnings_growth` | `earningsGrowth` | YoY earnings growth rate |
| `free_cashflow` | `freeCashflow` | FCF in AUD |
| `short_pct_float` | `shortPercentOfFloat` | Short interest as % of float |
| `gross_margin` | `grossMargins` | Gross profit / revenue |
| `operating_margin` | `operatingMargins` | EBIT / revenue |
| `net_margin` | `profitMargins` | Net income / revenue |
| `beta` | `beta` | 52-week beta vs market |
| `analyst_target` | `targetMeanPrice` | Consensus price target |
| `analyst_recommendation` | `recommendationKey` | `buy` / `hold` / `sell` |

Fundamentals are not used in the scanner score or quant engine sizing. They appear in the Signals page detail card and are optionally included in Claude's prompt context when you run analysis on a holding.

---

## 11. Sector Classification

`get_sector_for_ticker(ticker)` returns the sector in this order:

1. **`ASX_SECTOR_MAP` lookup** (hardcoded in `indicators.py`) — ~180 tickers covering the ASX 200. Returns immediately without a network call.
2. **yfinance `info["sector"]`** — for unlisted or newer tickers not in the map.
3. **Fallback: `"Other"`**

The sector appears in `fundamentals["sector"]` and is used by the Learning Loop's sector performance analytics and the calibration feed's sector delta comparisons.

**To add a new ticker:** find the correct sector block in `ASX_SECTOR_MAP` and add it:
```python
ASX_SECTOR_MAP = {
    # Healthcare
    'CSL': 'Healthcare', 'COH': 'Healthcare', ...,
    'NEW': 'Healthcare',  # ← add here
}
```

Each ticker should appear **exactly once** across all sector blocks.

---

## 12. How to update indicators manually

### Change a period parameter

Every indicator function is called with keyword arguments. Edit the call in `analyse_ticker()`:

```python
# Current — change 14 to your preferred period
rsi = compute_rsi(close, 14)
atr = compute_atr(high, low, close)        # period defaults to 14 in compute_atr()
bb_upper, bb_mid, bb_lower = compute_bollinger(close, period=20, std_dev=2)
```

No server restart needed for changes to `indicators.py` — Flask reloads the module on the next request in dev mode. With waitress/gunicorn, restart the server after editing.

### Change the scanner scoring thresholds

The score breakpoints are in `_score_ticker()` (around line 387). Example — to make the pullback zone wider (accept −25% instead of −20%):

```python
# Change this:
if   -20 <= pct_high <= -5:  pos_score = 15
# To this:
if   -25 <= pct_high <= -5:  pos_score = 15
```

### Change the scanner factor weights

`FACTOR_WEIGHTS` (line ~361) controls the five high-level component weights. They must sum to **exactly 100**:

```python
FACTOR_WEIGHTS = {
    "trend":    30,   # ← edit these
    "pullback": 30,
    "volume":   20,
    "momentum": 10,
    "rs":       10,
}
```

Run **Factor Stability** (Market Scanner → Factor Stability tab) quarterly to get empirically-derived suggested weights based on your tickers' out-of-sample ICs. See [`risks-management.md`](risks-management.md) Part 4 for full instructions.

### Change the composite signal thresholds

In `analyse_ticker()`, the `> 0.3` and `< -0.3` thresholds determine how much consensus is needed before the signal tips to BUY or SELL:

```python
if signal_score > 0.3:    composite = "BUY"
elif signal_score < -0.3: composite = "SELL"
else:                     composite = "HOLD"
```

Increase to `±0.5` for a stricter filter that stays on HOLD unless there's a strong consensus.

### Add a new indicator

1. Add a `compute_*` function at the top of `indicators.py` (matches the pattern of the existing ones).
2. Call it in `analyse_ticker()` in the appropriate section (Trend / Momentum / Volatility / Volume).
3. Add the result to the return dict at the bottom of `analyse_ticker()`.
4. If you want it in buy/sell signals, add a comparison in the signal list block (~line 606).
5. If you want it in the scanner score, add it to `_score_ticker()`.

Do not import Flask anywhere in `indicators.py` — it is a pure compute module with no routing logic.

### Change the pre-earnings window

```python
# indicators.py line ~725
pre_earnings_risk = bool(days_to_earnings is not None and 0 <= days_to_earnings <= 14)
```

Change `14` to your preferred lead time. Also update the `earningsAdj` multiplier in `js/quant-engine.js` if you want to adjust the stop-widening factor.

### Change ATR stop multipliers

The regime-specific stop multipliers (`stopAtrMult`) live in `js/regime-engine.js`:

```javascript
// getRegimeModifiers() — current values:
// riskOn/trend/sideways → 2.5×ATR
// highVol              → 3.0×ATR
// riskOff              → 3.5×ATR
// panic                → 4.0×ATR
```

The mirror constant `_REGIME_STOP_ATR_MULT` in `routes/learning.py` must be kept in sync — it's used by the `stop_too_tight` counterfactual analysis.

---

## Quick field reference

| Field | Group | Key use |
|---|---|---|
| `rsi_14` | Momentum | Scanner gate, buy/sell signals, entry quality scoring |
| `macd_hist` | Momentum | Trend momentum direction and expansion |
| `bb_pct_b` | Volatility | Mean-reversion entry zone, injected into Claude prompts |
| `atr_14` | Volatility | **Stop-loss calculation, position sizing** |
| `atr_pct` | Volatility | Normalised volatility — regime classification input |
| `adv_20` | Volume | **Liquidity cap for position sizing** (AUD, not shares) |
| `volume_ratio` | Volume | Accumulation/distribution confirmation |
| `adx` | Trend | Trend strength gate — above 25 = confirmed trend |
| `score` | Scanner | 0–100 composite setup quality |
| `pre_earnings_risk` | Earnings | Triggers 1.3× ATR stop widening |
| `days_to_earnings` | Earnings | Days to next reported earnings date |
| `hist_vol_20` | Volatility | Annualised 20-day realised volatility |
| `gap95_pct` | Volatility | 95th percentile overnight gap — position risk budget |
| `high_60d` / `low_60d` | Returns | Fibonacci day-trade setup zone |
| `rs_5d_alpha` | Momentum | Stock return vs ASX200 over 5 days |
| `trend_strength` | Trend | `strong` (ADX > 25) or `weak` |
| `obv_trend` | Volume | Volume trend confirmation |
| `support_resistance` | S/R | Pivot levels used in stop placement |
