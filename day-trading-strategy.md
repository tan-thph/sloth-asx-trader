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

### 2.7 Market Breadth Gate
- **ADR (Advance/Decline Ratio):** Skip all new BUY setups when `advance_decline_ratio < 0.25` (fewer than 25% of ASX200 above their 20-day SMA).
- The current ADR is shown on the Macro page and is computed after each scanner run. The regime engine also uses it to classify breadth-driven regimes.
- **Rationale:** When 75%+ of the market is in downtrend, individual mean-reversion setups have materially lower hit rates. Waiting for broad participation to recover (ADR > 0.35) before re-entering new positions preserves capital during distribution phases.

### 2.8 Volatility-of-Volatility (VoV) Filter
- **Skip or escalate** when `ATR_today > 1.3 × ATR_5d_mean` — ATR is expanding rapidly.
- If VoV triggers, either skip the setup entirely or treat the current regime as one level more defensive (e.g., apply `riskOff` stop multiplier even in a `sideways` regime classification).
- **Rationale:** When ATR itself is accelerating, the noise floor estimate used to set the stop is already stale. Stop distances computed from last session's ATR understates current risk. The regime engine detects macro-level transitions but intra-regime ATR expansion goes undetected without this check.

### 2.9 Time-of-Week Filter (Swing)
- **Avoid initiating new swing positions:**
  - **Monday before 11:00 AEST** — weekend news gaps are unresolved; opening auction prints are unreliable until the market stabilises.
  - **Friday after 14:00 AEST** — position squaring into the close increases gap risk over the weekend before the stop can be adjusted.
- Existing positions are managed normally on these days; the filter applies to *new entries only*.
- **Rationale:** ASX stocks gap on overnight US moves. Monday morning entries and Friday afternoon entries statistically underperform mid-week entries on mean-reversion setups due to asymmetric gap risk.

---

## 3. Entry Signals (Swing)

**Requirement: PRIMARY signal must fire + at least 2 Confirmations.**

### Primary (Mandatory)

**BB Reclaim:**
- `Close_{t-1} < BB_Lower_{t-1}` AND `Close_t > BB_Lower_t`
- Price breached the lower Bollinger Band and closes back inside it.
- This is the single most reliable mean-reversion trigger on daily timeframes.

### Confirmation 1 — RSI Recovery

- `RSI_14 > RSI_{t-1}` AND `min(RSI over lookback) < threshold`
- RSI dipped below the oversold threshold recently and is now turning up.

**Regime-adaptive thresholds:**

| Regime | Oversold threshold | Lookback |
|---|---|---|
| `riskOn` / `trend` | < 35 | 3 bars |
| `sideways` / `highVol` | < 35 | 5 bars |
| `riskOff` | < 30 | 5 bars |
| `panic` | < 28 | 7 bars |

*In riskOff/panic regimes, RSI can stay below 35 for weeks and loses discriminatory power — tighten the threshold so only genuinely extreme readings qualify. In riskOn, oversold readings are rarer and carry higher mean-reversion probability — shorten the lookback to avoid lag.*

### Confirmation 2 — Volume Z-Score

- `Volume Z-Score = (Volume_t − μ_Volume_20) / σ_Volume_20 > threshold`
- The entry candle has statistically significant volume above the 20-day mean.

**Regime-adaptive thresholds:**

| Regime | Z-Score threshold |
|---|---|
| `riskOn` / `trend` / `sideways` | > 1.50 |
| `highVol` | > 2.00 |
| `riskOff` / `panic` | > 1.50 |

*In highVol regimes, 1.5σ volume spikes are frequent noise. Raising the bar to 2.0σ ensures only genuine institutional participation qualifies as confirmation.*

### Confirmation 3 — Fibonacci Retracement Zone

- Entry price falls within the **50%–61.8% retracement** of the dominant 100-day swing high/low.
- `Price_t ∈ [Low_100 + 0.48 × (High_100 − Low_100), Low_100 + 0.63 × (High_100 − Low_100)]`
- The "golden pocket" is where the highest concentration of institutional buy orders typically rests.

### Confirmation 4 — Sector ETF Relative Strength

- The target stock's sector ETF (XMJ/XFJ/XHJ/XEJ/XRJ) must have a **5-day return ≥ −2%**.
- Sector ETF performance is shown on the Macro page (Sprint 30 addition to the macro payload).
- **Rationale:** Entering a beaten-up Materials name when XMJ itself is down 4% on the week dramatically lowers the probability of a BB reclaim holding — the selling pressure is sector-wide, not stock-specific. At minimum, the sector must not be in active distribution.

### Bonus Signal — OBV Bullish Divergence

- OBV is rising (or its 10-day average is rising) while price is still falling.
- Reveals hidden accumulation. Not required for a valid setup, but materially increases confidence when present.

---

## 4. Position Sizing and Stop-Loss Math (Swing)

### 4.1 Stop-Loss Distance — Regime-Aware

The stop-loss ATR multiplier is not fixed — it scales with the current market regime to account for elevated tail risk in volatile conditions:

| Regime | Stop ATR multiplier |
|---|---|
| `riskOn` / `trend` / `sideways` | **2.5 ×** ATR_14 |
| `highVol` | **3.0 ×** ATR_14 |
| `riskOff` | **3.5 ×** ATR_14 |
| `panic` | **4.0 ×** ATR_14 |

**Pre-earnings adjustment:** When `pre_earnings_risk = true` (earnings within 14 days), multiply the regime stop by an additional **1.3×** regardless of regime. The rec card shows a `📅 Pre-earnings` badge when this fires.

**Structural stop placement:** After computing the raw ATR-based stop, check whether it falls within **0.5% of a round number** ($10.00, $5.00, $2.50, $1.00) or the 200-day SMA. If so, place the stop just below that level. Round numbers and the 200-day SMA carry disproportionate sell-order density — stops placed above them are frequently hunted.

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
| **Target** | +3.5% from entry (configurable 1–10%) |
| **Stop** | −1.5% from entry (configurable 0.5–5%) |
| **R:R** | Computed from actual price levels — typically ~2.3:1 at defaults |
| **Max positions** | 2 concurrent (configurable) |
| **Universe** | ASX20 / 50 / 100 / 200 (selectable; ASX100 default) |
| **Capital** | Separate allocation — 20% of cash by default |

### 8.2 Intraday Entry Signals

Two entry modes — **recapture** (preferred) and **discount** (fallback):

**Mode A — VWAP Recapture (preferred)**
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

**SPI200 futures lead indicator:** The SPI200 futures price (`spi200_futures_chg` on the Macro page) reflects what institutional participants expect the ASX200 to open at — it votes in the regime classifier as a same-session lead indicator. A futures drop of −1.5%+ adds a `riskOff` vote even before the ASX opens.

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

*Not financial advice. For personal research and strategy development only.*
*Always conduct your own due diligence. Past technical patterns do not guarantee future results.*
