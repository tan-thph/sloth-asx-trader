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

---

## 14. Statistical Learning System — Trade History and Predictive Model

### 14.1 Purpose

The rule-based filters in §2 and §3 define which setups are *structurally valid*. They do not distinguish between valid setups that have historically worked well for **you** and valid setups that have not. Two traders using identical entry rules on the same ticker on the same day will accumulate different outcome distributions because execution timing, position sizing decisions, and individual judgement at exit create different samples.

The learning system is a **personalised win-probability estimator**. It records your own trades — entry signals, market context, and final outcome — then trains a statistical model on that personal history. The model answers one question:

> *Given these 18 technical and contextual features at entry time, what fraction of my past trades with similar features ended as wins?*

This is distinct from the Claude AI analysis (qualitative conviction) and from the regime gate (structural macro filter). The learning model operates on your realised outcomes — the other two layers operate on forward-looking analysis. All three run in parallel.

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
    │  persists 18 features + metadata to day_trade_history.db
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
    ├── Load completed snapshots (outcome ≠ 'open')
    ├── Build 18-column feature matrix X  (NaN → column-mean imputation)
    ├── Binary label y: 1 = win (pnl_pct > 0.5%), 0 = loss/breakeven
    ├── Standardise X: z = (x − μ) / σ  (column-wise)
    ├── Compute IC: Spearman rank correlation per feature with y
    ├── Fit: gradient-descent logistic regression with L2 regularisation
    ├── Evaluate: accuracy, precision, recall, F1 on full training set
    └── Persist: model weights, bias, μ, σ → model_state table; IC → feature_importance table
    │
    ▼
GET /api/daytrading/model           ← loads on Day Trading page open
    │  returns feature_names, weights[], bias, means[], stds[]
    │  cached in window._dtModel (JavaScript)
    │
    ▼
dtPredictLocal(features, _dtModel)  ← client-side in dt-training.js
    │  no server round-trip per setup
    │
    ▼
📊 X% win badge on each pending setup card (Setups tab)
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

### 14.4 Feature Set — 18 Inputs

Every snapshot records these 18 features at trade entry time. Features are sourced from `state.liveSignals[ticker]` (populated by `GET /api/analyse/<ticker>`) and `state.macroData` (from `GET /api/macro`).

#### Technical indicators (13)

| Feature | Source field | Meaning |
|---|---|---|
| `rsi_14` | `signals.rsi_14` | RSI 14-period. Oversold entries cluster below 40. |
| `bb_pct_b` | `signals.bb_pct_b` | Bollinger Band %B — 0 = lower band, 1 = upper band. Core entry trigger. |
| `bb_bandwidth` | `signals.bb_bandwidth` | Band width normalised by mid-line. Measures current volatility regime. |
| `atr_pct` | `signals.atr_14 / price × 100` | ATR as % of price. Normalised so a $2 ATR on a $20 stock is comparable to a $5 ATR on a $100 stock. |
| `adx` | `signals.adx` | Trend strength 0–100. High ADX in a falling market → mean-reversion less reliable. |
| `volume_zscore` | `signals.volume_zscore` | Standard deviations above 20-day volume mean. Institutional participation signal. |
| `mfi_14` | `signals.mfi_14` | Money Flow Index — volume-weighted RSI. Independent of pure price momentum. |
| `stoch_k` | `signals.stoch_k` | Stochastic %K. Measures where price sits within its recent high/low range. |
| `williams_r` | `signals.williams_r` | Williams %R. Inverted Stochastic; negative values; close to 0 = overbought. |
| `cci_20` | `signals.cci_20` | Commodity Channel Index 20-period. Mean-reversion signal: extreme negative = oversold. |
| `setup_score` | `signals.score` | Composite 0–100 signal score computed by `_score_ticker()` in `indicators.py`. Reflects FACTOR_WEIGHTS. |
| `price_vs_sma20` | `(price / sma_20 − 1) × 100` | Price distance from 20-day SMA as %. Negative = below SMA (pullback). |
| `price_vs_sma50` | `(price / sma_50 − 1) × 100` | Price distance from 50-day SMA as %. |

#### Market context (3)

| Feature | Source | Meaning |
|---|---|---|
| `asx200_5d_ret` | `macroData.asx200_5d_ret` | ASX200 5-day return %. Negative = broad market selling. |
| `adl_ratio` | `macroData.advance_decline_ratio` | Fraction of ASX200 tickers above their 20-day SMA. Breadth indicator. |
| `rba_rate` | `macroData.rba_rate` | RBA cash rate %. Higher rates = tighter financial conditions. |

#### Intraday-specific (2, null for swing trades)

| Feature | Source | Meaning |
|---|---|---|
| `intraday_rsi` | `signals.intraday_rsi` | RSI on 5-minute bars at scan time. Oversold = ≤ 40. |
| `vwap_position` | `signals.vwap_pct` | `(price − VWAP) / price × 100`. Negative = trading below VWAP. |
| `volume_accel` | `signals.volume_acceleration` | Whether 5m volume is rising relative to session average. |

**Note:** Swing trade snapshots have `intraday_rsi`, `vwap_position`, and `volume_accel` set to NULL (→ imputed to column mean during training). The model handles mixed swing/intraday datasets without segregating them — if the sample is large enough to stratify by trade type, do so manually by deleting swing or intraday rows from the History tab before training.

---

### 14.5 Label Construction

```
outcome = 'win'        if  pnl_pct > +0.5%
outcome = 'breakeven'  if  -0.5% ≤ pnl_pct ≤ +0.5%
outcome = 'loss'       if  pnl_pct < -0.5%
```

Binary label for model training:
```
y = 1  if outcome == 'win'
y = 0  if outcome == 'loss' or 'breakeven'
```

The 0.5% threshold is deliberate: ASX brokerage round-trip (2× $10 on a $5,000 position = 0.4%) means any "win" below 0.5% is economically a breakeven or worse after slippage. Treating breakeven as a loss makes the model conservative — it only counts genuine positive outcomes.

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

### 14.6 Training Algorithm — Logistic Regression (Pure Numpy)

The training algorithm requires no external ML library. It runs entirely on `numpy`, which is already a transitive dependency of `yfinance`/`pandas`.

#### Step 1 — Data preparation

```python
# Load completed snapshots (outcome ≠ 'open')
rows = conn.execute("""
    SELECT * FROM trade_snapshots
    WHERE outcome IN ('win', 'loss', 'breakeven')
    ORDER BY entry_date DESC LIMIT 2000
""").fetchall()

# Build feature matrix (18 columns × N rows)
X_raw = [[row[f] or np.nan for f in FEATURES] for row in rows]

# Mean imputation: replace NaN with the column mean
# (prevents features missing for one trade type from distorting training)
col_means = np.nanmean(X_raw, axis=0)
X_raw[np.isnan(X_raw)] = col_means[np.where(np.isnan(X_raw))[1]]

# Z-score standardisation: z = (x − μ) / σ
# Saved to model_state for use at prediction time
means = X_raw.mean(axis=0)
stds  = X_raw.std(axis=0)
stds[stds < 1e-9] = 1.0        # prevent division by zero on constant columns
X = (X_raw - means) / stds
```

Standardisation is mandatory before logistic regression. Without it, features measured on different scales (RSI 0–100, volume_zscore −3 to +3, rba_rate 0.1–5.0) would have wildly different gradient magnitudes, making the optimizer unstable.

#### Step 2 — Information Coefficient (Spearman rank correlation)

Before fitting the model, each feature's raw predictive power is measured via the **Information Coefficient (IC)** — the Spearman rank correlation between the feature and the binary outcome:

```python
def _spearman(a, b):
    n = len(a)
    ra = np.argsort(np.argsort(a)).astype(float)  # rank a
    rb = np.argsort(np.argsort(b)).astype(float)  # rank b
    d = ra - rb
    return 1.0 - 6.0 * np.sum(d * d) / (n * (n**2 - 1))

ics = [_spearman(X_raw[:, i], y) for i in range(len(FEATURES))]
```

The IC is computed on **raw (unstandardised) features** because rank correlation is scale-invariant. It serves two purposes:

1. **Feature importance display** — the horizontal bar chart on the 🧠 Model tab shows `abs(IC)` per feature, sorted descending. Features with IC ≈ 0 carry no predictive signal in your sample.
2. **Model diagnostics** — if the top-IC feature has `|IC| < 0.05`, the sample is too small or the rules are already optimal (no further signal to extract).

Spearman is preferred over Pearson because the relationship between a technical indicator and outcome is rarely linear — it is monotone (RSI below 30 is good, RSI above 70 is bad) but the exact functional form is unknown.

#### Step 3 — Gradient descent logistic regression with L2 regularisation

```python
def _logistic_regression(X, y, lr=0.05, epochs=1000, l2=0.01):
    n, p = X.shape
    w = np.zeros(p)     # weight vector (one per feature)
    b = 0.0             # bias term

    for _ in range(epochs):
        # Forward pass: sigmoid(Xw + b)
        logits = np.clip(np.dot(X, w) + b, -20, 20)
        pred   = 1.0 / (1.0 + np.exp(-logits))

        # Gradients of binary cross-entropy loss + L2 penalty
        err = pred - y
        dw  = np.dot(X.T, err) / n + l2 * w   # L2 penalty on weights, not bias
        db  = np.mean(err)

        # Gradient descent step
        w -= lr * dw
        b -= lr * db

    return w, b
```

**Hyperparameter rationale:**

| Parameter | Value | Reason |
|---|---|---|
| `lr` (learning rate) | 0.05 | Conservative for small datasets (n=15–200). Avoids overshooting the minimum. |
| `epochs` | 1,000 | Sufficient to converge for n<500 with lr=0.05. Runtime <100ms on any modern CPU. |
| `l2` (regularisation) | 0.01 | Prevents overfitting on small samples. Forces the model toward the prior (uniform win probability) when the signal is weak. |

L2 regularisation is critical for small datasets. Without it, the model will overfit — assigning extreme weights to features that happened to correlate with outcome in 20–30 trades by chance, then performing poorly on the next 20.

The logit is clipped to [−20, +20] before applying the sigmoid to prevent `exp(-logit)` overflow for extreme feature values.

#### Step 4 — Model persistence

After fitting, the following are serialised as JSON and stored in `model_state`:

```
feature_names  → ordered list of feature keys (defines column→index mapping)
weights        → fitted w vector (length 18)
bias           → fitted b scalar
feature_means  → μ from standardisation (length 18)
feature_stds   → σ from standardisation (length 18)
```

Each training run appends a new row to `model_state`. The prediction endpoints always use `ORDER BY trained_at DESC LIMIT 1` — old model runs are retained for audit but never used.

---

### 14.7 Prediction — Client-Side Inference

After `GET /api/daytrading/model` loads the model into `window._dtModel`, all predictions run entirely in the browser with no server round-trip:

```javascript
function dtPredictLocal(features, model) {
    var fn   = model.feature_names;  // ordered list of 18 names
    var w    = model.weights;
    var mu   = model.feature_means;
    var sig  = model.feature_stds;
    var bias = model.bias;

    // Apply the same standardisation the training used
    var logit = bias;
    for (var i = 0; i < fn.length; i++) {
        var raw = features[fn[i]] ?? 0;    // null/undefined → 0
        var z   = (raw - mu[i]) / sig[i];  // z-score
        logit  += z * w[i];
    }

    // Clamp and apply sigmoid
    logit = Math.max(-20, Math.min(20, logit));
    return 1 / (1 + Math.exp(-logit));     // P(win) ∈ (0, 1)
}
```

The returned value is the model's estimated **P(win)** for the setup given its entry features. This is displayed as the **📊 X% win** badge on each pending Setups card.

**Colour coding of the badge:**

| P(win) | Badge colour | Interpretation |
|---|---|---|
| ≥ 60% | Green | Historically profitable feature combination |
| 45–59% | Amber | Mixed signal; no strong historical edge |
| < 45% | Red | Historically weak feature combination — consider passing |

The badge is informational, not a gate. A red badge means your personal history with similar setups has been poor — it does not block execution.

---

### 14.8 Using the System in Practice

#### Building a usable dataset

Minimum 15 completed trades are required before training is enabled. Realistically, 30–50 trades are needed before the IC estimates stabilise. Below 30 trades, the model will overfit and the ICs will be noisy.

**Do not cherry-pick.** Let all completed trades flow into the DB automatically — including losses. A model trained only on winners has a 100% win rate on training data and no predictive power.

#### Retraining cadence

Retrain after every **10–20 new completed trades** or after a **regime transition** (the historical distribution of entry conditions shifts). The 🧠 Model tab shows the training timestamp and sample count — if it is more than 3 months old or has fewer than 20 samples, retrain before relying on the badge scores.

#### Interpreting feature importances

The bar chart sorts features by `|IC|` (absolute Spearman correlation with outcome). The sign matters:

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

#### Separating swing and intraday models

The current implementation trains a single model on both trade types. If you want separate models:

1. Go to 📋 History tab.
2. Delete all swing (or all intraday) records using the ✕ buttons or the Clear All button.
3. Train the model on the remaining type.
4. Export the weights mentally (note which features matter) and restore the full history.

A future enhancement could expose a `trade_type` filter on the train endpoint. For now, if your intraday and swing volumes are both ≥15 completed trades, the mixed-model approach is adequate — the `intraday_rsi` and `vwap_position` features will naturally receive low or zero IC for swing-dominated samples, and the model self-adjusts.

---

### 14.9 Model Reliability Boundaries

The model is a **low-sample pattern detector**, not a calibrated probability estimator. Treat it accordingly.

| Condition | Reliability |
|---|---|
| n < 15 completed trades | No model available. Rule-based filters only. |
| n = 15–29 | Model trains but ICs and weights are unreliable. Treat badge as directional, not quantitative. |
| n = 30–49 | Moderate reliability. Top 3–4 features are likely stable; tail features are noise. |
| n ≥ 50 | Reasonable reliability. Retrain every 10–20 new trades to stay current. |
| n ≥ 100 | Good reliability. Accuracy should meaningfully exceed 50% if a real edge exists. |

**The model cannot account for regime shifts.** If you built most of your dataset in a `riskOn` regime and are now trading in `riskOff`, the feature distributions differ and the model is stale. Add `regime` as a hard filter (only trade when regime matches the majority of training data) or retrain after the regime settles.

**Accuracy around 50% is normal and expected.** Day trading mean-reversion on a 5–15 day horizon has an inherently noisy outcome distribution. A model that achieves 55–60% accuracy on hold-out data is genuinely useful. An apparent accuracy of 80%+ on a small sample (< 30 trades) is almost certainly overfitting.

---

### 14.10 What the System Does Not Do

| Capability | Available? | Notes |
|---|---|---|
| Auto-adjust entry thresholds | No | FACTOR_WEIGHTS in `indicators.py` are static. The model augments, not replaces, the signal score. |
| Predict magnitude of profit | No | Binary win/loss only. Expected P&L is a separate calculation. |
| Call any external API | No | Pure numpy, local DB, no network calls. |
| Learn from other traders' data | No | Model is trained exclusively on your own trade history. |
| Optimise the entry rules in §2–§3 | No | Rule optimisation requires a different approach (e.g., the walk-forward backtest in §Performance). |
| Retrain automatically | No | Manual trigger only — protects against training on mid-regime noise. |

---

*Not financial advice. For personal research and strategy development only.*
*Always conduct your own due diligence. Past technical patterns do not guarantee future results.*
