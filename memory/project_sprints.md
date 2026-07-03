---
name: project-sprints
description: Sprint history for Sloth ASX Trader — what has shipped and what's next
metadata:
  type: project
---

Through Sprint 17 (2026-05-29). Sprints 1-16 shipped extensive features (see IMPROVEMENTS.md §0).

**Sprint 17 shipped:**
- `GET /api/seasonality/<ticker>` endpoint in routes/market.py (24h TTL cache)
- Monthly seasonality card on Signals page detail view — 12-bar chart, current month highlighted, hover tooltips
- `applySplitAdjustment(ticker, ratio, date)` in portfolio.js — one-click button in split warning banner to auto-adjust shares/avgPrice/CGT parcels
- 15 new tests (253 total)

**Why:** Seasonality gives calendar context for entry/exit timing. Split auto-adjust removes manual error risk when a corporate action changes share count and cost base.

**How to apply:** Next sprint candidates from IMPROVEMENTS.md: §3.3 Vitest tests, §3.4 perf polish, mobile/PWA, or walk-forward backtest (§1.7).
