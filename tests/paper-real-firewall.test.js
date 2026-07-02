/**
 * paper-real-firewall.test.js — locks in the money-critical behaviors of the
 * Paper/Real trade firewall (CLAUDE.md gotcha #88, Stage 2 + Phase D).
 *
 * These all live in js/utils.js, which tests/setup.js already loads as globals.
 * The ONE invariant under test: a record is REAL only when mode==='real';
 * everything else (explicit 'paper', missing, null) is paper and is kept out of
 * real cash / real NAV. Cash routes to the right pool; the display view mode
 * filters holdings/cash without touching the real-only NAV basis.
 */
import { describe, it, expect, beforeEach } from 'vitest';

function resetState() {
  global.state.portfolio = [];
  global.state.cash = 1000;
  global.state.paperCash = 0;
  global.state._paperCashSeeded = false;
  global.state.portfolioViewMode = 'all';
  global.state.activeAccount = 'all';
  global.state.settings = { paperStartCash: 100000 };
}

describe('isRealTrade invariant', () => {
  it('is real ONLY for mode==="real"', () => {
    expect(isRealTrade('real')).toBe(true);
    expect(isRealTrade({ mode: 'real' })).toBe(true);
    // everything else fails safe → paper
    expect(isRealTrade('paper')).toBe(false);
    expect(isRealTrade({ mode: 'paper' })).toBe(false);
    expect(isRealTrade({})).toBe(false);        // missing
    expect(isRealTrade({ mode: null })).toBe(false);
    expect(isRealTrade(null)).toBe(false);
    expect(isRealTrade(undefined)).toBe(false);
    expect(isRealTrade('REAL')).toBe(false);     // case-sensitive on purpose
  });
});

describe('adjustCashForMode routing + paper-cash seeding', () => {
  beforeEach(resetState);

  it('real trades move real cash, never paperCash', () => {
    adjustCashForMode(-250, 'real');
    expect(state.cash).toBe(750);
    expect(state.paperCash).toBe(0);         // untouched, not seeded by a real trade
    expect(state._paperCashSeeded).toBe(false);
  });

  it('first paper trade seeds paperCash from paperStartCash, then applies delta', () => {
    adjustCashForMode(-5000, 'paper');       // buy $5000 of paper
    expect(state._paperCashSeeded).toBe(true);
    expect(state.paperCash).toBe(95000);     // 100000 seed − 5000
    expect(state.cash).toBe(1000);           // real cash untouched
  });

  it('missing/paper mode both route to the paper pool (fail-safe)', () => {
    adjustCashForMode(-1000, undefined);
    expect(state.paperCash).toBe(99000);
    expect(state.cash).toBe(1000);
  });

  it('does not re-seed after a genuine spend-down to zero', () => {
    ensurePaperCashSeeded();                 // seed → 100000
    state.paperCash = 0;                      // user spent it all
    ensurePaperCashSeeded();                  // must NOT re-seed (flag already set)
    expect(state.paperCash).toBe(0);
  });
});

describe('view-mode display filtering', () => {
  beforeEach(() => {
    resetState();
    state.portfolio = [
      { ticker: 'BHP', shares: 10, avgPrice: 40, currentPrice: 50, account: 'personal', mode: 'real' },
      { ticker: 'CBA', shares: 5,  avgPrice: 100, currentPrice: 120, account: 'personal', mode: 'paper' },
      { ticker: 'WOW', shares: 20, avgPrice: 30, currentPrice: 30, account: 'personal' }, // legacy, no mode ⇒ paper
    ];
    state.paperCash = 200;
  });

  it("'all' shows every holding and combines cash pools", () => {
    state.portfolioViewMode = 'all';
    expect(portfolioValue()).toBe(10*50 + 5*120 + 20*30); // 500+600+600 = 1700
    expect(viewCash()).toBe(1000 + 200);
    expect(totalNetWorth()).toBe(1700 + 1200);
  });

  it("'real' shows only real holdings and real cash", () => {
    state.portfolioViewMode = 'real';
    expect(portfolioValue()).toBe(10*50);    // BHP only
    expect(viewCash()).toBe(1000);
    expect(totalNetWorth()).toBe(500 + 1000);
  });

  it("'paper' shows paper + legacy-mode-less holdings and paper cash", () => {
    state.portfolioViewMode = 'paper';
    expect(portfolioValue()).toBe(5*120 + 20*30); // CBA + WOW(legacy)
    expect(viewCash()).toBe(200);
  });
});

describe('real-only NAV basis ignores the view toggle', () => {
  beforeEach(() => {
    resetState();
    state.portfolio = [
      { ticker: 'BHP', shares: 10, avgPrice: 40, currentPrice: 50, mode: 'real' },
      { ticker: 'CBA', shares: 5,  avgPrice: 100, currentPrice: 120, mode: 'paper' },
    ];
    state.paperCash = 99999;
  });

  it('realPortfolioValue / realNetWorth stay real-only in EVERY view mode', () => {
    for (const vm of ['all', 'real', 'paper']) {
      state.portfolioViewMode = vm;
      expect(realPortfolioValue()).toBe(500);       // BHP only, always
      expect(realNetWorth()).toBe(500 + 1000);      // + real cash only, never paperCash
    }
  });
});

describe('mergedPortfolio keys real and paper lots separately', () => {
  beforeEach(() => {
    resetState();
    state.portfolio = [
      { ticker: 'BHP', shares: 10, avgPrice: 40, currentPrice: 50, account: 'personal', mode: 'real' },
      { ticker: 'BHP', shares: 3,  avgPrice: 45, currentPrice: 50, account: 'personal', mode: 'paper' },
    ];
    state.portfolioViewMode = 'all';
  });

  it('same ticker+account but different mode → two rows, each tagged', () => {
    const rows = mergedPortfolio().filter(r => r.ticker === 'BHP');
    expect(rows).toHaveLength(2);
    const modes = rows.map(r => r.mode).sort();
    expect(modes).toEqual(['paper', 'real']);
  });

  it("'real' view collapses to just the real BHP lot", () => {
    state.portfolioViewMode = 'real';
    const rows = mergedPortfolio().filter(r => r.ticker === 'BHP');
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('real');
    expect(rows[0].shares).toBe(10);
  });
});
