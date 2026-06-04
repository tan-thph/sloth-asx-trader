# ASX AI Trading App: Architectural Review & Recommendations

**Date:** June 03, 2026
**Status:** Production-Grade Architecture (Sprint 42)
**Reviewer:** Qwen3.7

## Executive Summary

The "Sloth ASX Trader" represents a sophisticated hybrid AI-deterministic trading engine. By treating the LLM (Claude Sonnet 4) as a **qualitative analyst** rather than a calculator, and wrapping it in robust deterministic layers for risk management, sizing, and feedback learning, the system avoids the most common pitfalls of AI trading bots (hallucination, arithmetic errors, and lack of adaptation).

The implementation of the **Learning Loop**—specifically the exponential time-decay calibration, adversarial debate, and virtual outcome resolution—is exceptional. However, specific architectural risks regarding local LLM limitations, data latency, and technical debt require immediate attention to maintain production reliability.

---

## 1. Major Strengths

### 🛡️ Hybrid Deterministic/Probabilistic Pipeline
*   **Separation of Concerns:** Signal generation (Python/Pandas), Qualitative Conviction (Claude), and Sizing/Risk (Quant Engine) are strictly separated. This prevents the LLM from hallucinating position sizes or ignoring hard risk limits.
*   **Regime-Aware Logic:** The system dynamically adjusts stop-loss multiples (`stopAtrMult`) and position sizing based on market regimes (e.g., `panic` vs. `riskOn`).

### 🧠 Sophisticated Learning Loop
*   **Adaptive Calibration:** The use of **exponential time-decay** with regime-adaptive half-lives (20d–60d) ensures that stale data from previous market regimes does not dilute current signals.
*   **Effective Sample Size (ESS):** Using Kish’s ESS formula instead of raw trade counts prevents false confidence when recent trades dominate the weightings.
*   **Virtual Outcomes:** Resolving unexecuted recommendations (`_resolve_virtual_outcomes`) prevents the "pessimism loop" where suppressed calibration leads to no new outcomes.

### ⚖️ Adversarial Debate & Adjudication
*   **Bias Reduction:** Using local Ollama models for Bull/Bear debate and a cloud model for adjudication reduces confirmation bias without incurring high API costs for every call.
*   **Blind Adjudication:** Randomly assigning aliases ("Analyst Alpha/Beta") to local models prevents halo-effect bias in cloud adjudicators.

### 💰 Prompt Engineering & Cost Optimization
*   **Cache Stability:** Keeping the `ANALYSIS_SYSTEM_PROMPT` static and injecting dynamic data only into the user message maximizes Anthropic’s prompt caching efficiency.
*   **Defensive Coding:** Features like `stooq_quote` fallback, `_drop_forming_bar`, and `_sanity_check` demonstrate a focus on production reliability over demo functionality.

---

## 2. Critical Architectural Risks & Gaps

### 🚨 A. Local LLM "Fast-Path" Limitation (Sprint 41)
**Risk:** The local Ollama path (`quick-analysis`) currently supports **BUY/HOLD/TOP_UP only**, excluding SELL/TRIM.
*   **Impact:** In a bear market or correction, the system will aggressively buy via the local path but may fail to recommend exits if the user relies on it, or force a switch back to Claude (cost/latency) for exits. This creates a dangerous asymmetry.
*   **Recommendation:** Prioritize enabling structured `SELL/TRIM` tagging for the local LLM path. Even if accuracy is lower, having a "risk-off" signal from the local model is better than silence. Consider using a larger local model (e.g., `qwen3.5:9b` or `llama-3.3-70b`) specifically for exit logic.

### 📉 B. Data Latency & "Stale" Signals
**Risk:** Reliance on `yfinance` (15-minute delay for ASX) means signals may not reflect price-sensitive announcements until 15 minutes after they occur.
*   **Impact:** Entry points may be missed, or stops may be triggered late during flash events.
*   **Recommendation:** Ensure `News Signals` and `ASX Announcements` are weighted heavily enough in the prompt to override technical signals when a price-sensitive announcement occurs. Consider adding a **"Volatility Spike"** flag if volume surges before the price update arrives.

### 🔒 C. SQLite Concurrency Under Load
**Risk:** While WAL mode and `PRAGMA optimize` are implemented, simultaneous background scans, postmortem debates, and live analysis can still cause locking issues.
*   **Recommendation:** Monitor `busy_timeout` (currently 30s). Consider implementing a **read-replica** pattern if the app grows: one connection for writes (learning loop, journal) and separate connections for reads (dashboard, analysis prompts).

### 📊 D. Over-Fitting to Recent Regimes
**Risk:** In a prolonged sideways market (60d half-life), the system may accumulate too much weight from a regime that is about to break.
*   **Recommendation:** Add a **"Regime Change Penalty"**. When `classifyRegime()` detects a flip (e.g., `riskOn` → `riskOff`), temporarily reset the ESS or apply a harsher decay factor for the first 5–10 trades in the new regime until stability is proven.

---

## 3. Specific Recommendations for Improvement

### 1. Enhance the "Lessons" System (Sprint 39)
*   **Add "Market Breadth" Scope:** Allow lessons to be triggered by `advance_decline_ratio` or `VIX` levels. *Example: "When ADL < 0.3, ignore bullish RSI divergences."*
*   **Auto-Generate Lessons:** Use the `calib-quality` debate output to automatically propose new lessons. If the LLM consistently identifies "chasing breakouts in low volume" as a failure mode, prompt the user: *"Create a new lesson: 'Avoid breakouts if Volume Z-Score < 1.0'?"*

### 2. Improve "Virtual Outcomes" Logic (Sprint 36)
*   **Time-Decay Penalty:** A virtual win that hit target in 2 days is stronger than one that drifted there over 29 days. Weight virtual outcomes by `1 / holding_period_days` in the calibration calculation.

### 3. Strengthen "Anti-Churn" Rules (Sprint 42)
*   **Thesis Drift Detection:** If Claude recommends a TRIM because "thesis broken," but the price hasn’t moved much, flag this as a potential **over-reaction**. Compare the `realized_pnl_pct` of early exits vs. held positions. If early exits underperform, tighten the anti-churn rule.

### 4. Frontend UX: "Why Did I Get This Rec?"
*   **Traceability Modal:** Add a modal for each recommendation showing:
    1.  Raw signals (RSI, MACD, etc.).
    2.  Regime state.
    3.  Calibration nudge applied (e.g., *"Confidence reduced by 8pp due to poor performance in high-vol regimes"*).
    4.  Debate summary (Bull vs. Bear).
    *   *Benefit:* Builds user trust and helps them understand when to override the AI.

### 5. Testing & Validation
*   **Walk-Forward Analysis:** Prioritize simulating the *learning loop* itself: run the bot, let it log trades, update its calibration, and see how the *next* batch of trades performs. Static backtesting is misleading for AI systems.
*   **Adversarial Testing:** Create a "Red Team" script that feeds the AI extreme market scenarios (e.g., flash crash, earnings gap up) and verifies that the **Quant Engine** (not just Claude) enforces risk limits.

---

## 4. Code-Specific Observations & Technical Debt

| Issue | Severity | Recommendation |
| :--- | :--- | :--- |
| **`_detectExitReason` Duplication** | 🔴 High | **Hoist to `utils.js` immediately.** Currently duplicated in `recommendations.js` and `performance.js`. This is a ticking technical debt bomb; if fixed in one place and not the other, learning data becomes corrupted. |
| **`FACTOR_WEIGHTS` Normalization** | 🟡 Medium | Add a client-side validator that prevents saving if `sum(weights) != 100`. |
| **`stooq_quote` Rate Limits** | 🟡 Medium | Implement a simple **token bucket** rate limiter in `core.py` for Stooq calls to avoid silent failures during bulk scans. |
| **`unrealised_loss_large` Enforcement** | 🟢 Low | Already fixed in Sprint 42, but ensure the `$500 AUD` threshold remains appropriate as portfolio size grows. |

---

## 5. Next Immediate Steps

1.  **Hoist `_detectExitReason`** to `utils.js` to eliminate duplication and prevent data corruption.
2.  **Enable SELL/TRIM** for the local LLM path (even if basic) to close the asymmetry gap.
3.  **Implement Walk-Forward Backtesting** to validate the learning loop’s actual edge in changing regimes.
4.  **Add "Regime Change Penalty"** to the calibration logic to prevent over-fitting to transitioning markets.

## Final Verdict

This is a **production-grade** application that addresses the core failures of AI trading (lack of feedback, poor risk management, hallucination) with specific, engineered solutions. With the recommended fixes, it has the potential to be a robust decision-support tool for serious ASX traders.

**Well done.**