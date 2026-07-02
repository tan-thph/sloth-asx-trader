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
import { loadScript } from './setup.js';

// portfolio-helpers.js holds the parcel/split/rollback layer under test below.
// Pure function declarations (no DOM at load time), so it loads cleanly into
// the same global context utils.js already lives in.
loadScript('js/portfolio-helpers.js');
// Browser-global stubs used by the helpers' side-effect paths.
global.scheduleSave = () => {};
global.toast = () => {};

function resetState() {
  global.state.portfolio = [];
  global.state.cash = 1000;
  global.state.paperCash = 0;
  global.state._paperCashSeeded = false;
  global.state.portfolioViewMode = 'all';
  global.state.activeAccount = 'all';
  global.state.settings = { paperStartCash: 100000, brokerage: 10 };
  global.state.cgtParcels = [];
  global.state.cgtDisposals = [];
  global.state.tradeJournal = [];
  global.state.cgtMethod = 'fifo';
  global.state.intraday = { openPositions: [], recommendations: [] };
  global.state.dayTrading = { ...global.state.dayTrading, recommendations: [] };
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

// ── Audit fixes (2026-07-02): mode integrity in the parcel/rollback layer ─────

describe('splitParcel inherits the parent mode', () => {
  beforeEach(resetState);

  it('splitting a REAL parcel produces a REAL sibling (never paper)', () => {
    addParcel('BHP', '01-06-2026', 10, 40, 10, 'Mining', 'personal', 'real');
    const parent = state.cgtParcels[0];
    expect(splitParcel(parent.id, 4)).toBe(true);
    const sibling = state.cgtParcels[state.cgtParcels.length - 1];
    expect(sibling.mode).toBe('real');
    expect(isRealTrade(sibling)).toBe(true);
    // the split-off lot's new journal row must carry the mode too
    const newRow = state.tradeJournal.find(j => j.parcelId === sibling.id);
    expect(newRow.mode).toBe('real');
  });

  it('splitting a legacy (mode-less) parcel stays paper', () => {
    addParcel('CBA', '01-06-2026', 10, 100, 10, 'Banking', 'personal');  // no mode
    const parent = state.cgtParcels[0];
    delete parent.mode;   // simulate a true pre-feature parcel
    expect(splitParcel(parent.id, 3)).toBe(true);
    const sibling = state.cgtParcels[state.cgtParcels.length - 1];
    expect(isRealTrade(sibling)).toBe(false);
  });
});

describe('mode-scoped sell matching (paper sell never consumes real parcels)', () => {
  beforeEach(resetState);

  it('a paper sell fails when only a real holding exists', () => {
    applyBuyToPortfolio('BHP', 10, 40, '01-06-2026', 10, 'Mining', 'personal', 'real');
    const res = applySellToPortfolio('BHP', 5, 50, 10, '02-07-2026', 'fifo', 'personal', 'paper');
    expect(res.ok).toBe(false);
    // real holding untouched
    expect(getPortfolioHolding('BHP', 'personal', 'real').shares).toBe(10);
  });

  it('a real sell consumes only the real parcel and credits real cash', () => {
    applyBuyToPortfolio('BHP', 10, 40, '01-06-2026', 0, 'Mining', 'personal', 'real');
    applyBuyToPortfolio('BHP', 10, 40, '01-06-2026', 0, 'Mining', 'personal', 'paper');
    const cashBefore = state.cash, paperBefore = state.paperCash;
    const res = applySellToPortfolio('BHP', 10, 50, 0, '02-07-2026', 'fifo', 'personal', 'real');
    expect(res.ok).toBe(true);
    expect(state.cash).toBe(cashBefore + 500);
    expect(state.paperCash).toBe(paperBefore);           // untouched
    // paper parcel untouched, real parcel consumed
    const paperParcel = state.cgtParcels.find(p => (p.mode||'paper') === 'paper');
    const realParcel  = state.cgtParcels.find(p => p.mode === 'real');
    expect(paperParcel.remainingQty).toBe(10);
    expect(realParcel.remainingQty).toBe(0);
    // disposal carries the mode for the CGT firewall
    expect(res.disposals.every(d => d.mode === 'real')).toBe(true);
  });
});

describe('_recomputeHoldingFromParcels keeps real and paper rows separate', () => {
  beforeEach(resetState);

  it('rebuilds one row per mode, never a blended real+paper row', () => {
    addParcel('WES', '01-06-2026', 10, 60, 0, 'Retail', 'personal', 'real');
    addParcel('WES', '01-06-2026', 4, 65, 0, 'Retail', 'personal', 'paper');
    _recomputeHoldingFromParcels('WES', 'personal');
    const rows = state.portfolio.filter(h => h.ticker === 'WES');
    expect(rows).toHaveLength(2);
    const real  = rows.find(h => h.mode === 'real');
    const paper = rows.find(h => h.mode === 'paper');
    expect(real.shares).toBe(10);
    expect(real.avgPrice).toBe(60);
    expect(paper.shares).toBe(4);
    expect(paper.avgPrice).toBe(65);
  });
});

describe('rollbackTradeJournalEntry routes cash by the row mode', () => {
  beforeEach(resetState);

  it('rolling back a PAPER buy refunds paperCash, never real cash', () => {
    applyBuyToPortfolio('NAB', 10, 30, '01-07-2026', 10, 'Banking', 'personal', 'paper');
    const parcel = state.cgtParcels[0];
    const row = { action: 'BUY', status: 'open', ticker: 'NAB', qty: 10,
                  entryPrice: 30, fees: 10, account: 'personal', mode: 'paper', parcelId: parcel.id };
    const cashBefore = state.cash;
    ensurePaperCashSeeded();
    const paperBefore = state.paperCash;
    expect(rollbackTradeJournalEntry(row)).toBe(true);
    expect(state.cash).toBe(cashBefore);                       // real cash untouched
    expect(state.paperCash).toBe(paperBefore + 10 * 30 + 10);  // refund landed in paper pool
  });

  it('rolling back a REAL closed sell debits real cash only', () => {
    // a real holding exists post-sale reversal target
    const row = { action: 'SELL', status: 'closed', ticker: 'ANZ', qty: 5,
                  entryPrice: 20, exitPrice: 25, fees: 0, account: 'personal', mode: 'real' };
    const cashBefore = state.cash, paperBefore = state.paperCash;
    expect(rollbackTradeJournalEntry(row)).toBe(true);
    expect(state.cash).toBe(cashBefore - 5 * 25);   // sale proceeds clawed back from real cash
    expect(state.paperCash).toBe(paperBefore);
    // restored holding carries the mode
    const h = state.portfolio.find(x => x.ticker === 'ANZ');
    expect(h.mode).toBe('real');
  });
});
