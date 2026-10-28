"""Does the model separate stocks that go on to underperform (exits) from ones that don't (HOLDs)?

  edge = mean(excess | HOLD) - mean(excess | SELL/TRIM)   (positive = sold stocks then did worse)

Ticker-clustered bootstrap, so a ticker that was TRIMmed 8 times counts once.
  python3 exit_edge.py [db] [--metric peer|market]
peer   = return minus the mean return of the other holdings reviewed the same week (default
         when >=30 rows have it; removes market AND sector noise -> tighter interval)
market = return minus beta(1.0) x ^AXJO return
"""
import sqlite3, random, statistics, sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
db = args[0] if args else "asx_trader.db"
metric = sys.argv[sys.argv.index("--metric") + 1] if "--metric" in sys.argv else None
c = sqlite3.connect(db)
cols = {r[1] for r in c.execute("PRAGMA table_info(ai_learning_events)")}
n_peer = (c.execute("SELECT COUNT(*) FROM ai_learning_events WHERE exit_cf_peer_excess_pct IS NOT NULL").fetchone()[0]
          if "exit_cf_peer_excess_pct" in cols else 0)
if metric is None:
    metric = "peer" if n_peer >= 30 else "market"
col = "exit_cf_peer_excess_pct" if metric == "peer" else "exit_cf_excess_pct"
rows = c.execute(f"""SELECT ticker, recommendation, {col} FROM ai_learning_events
                     WHERE decision_outcome IS NOT NULL AND {col} IS NOT NULL""").fetchall()
by = {}
for t, rec, ex in rows:
    by.setdefault(t, {"H": [], "X": []})["H" if rec == "HOLD" else "X"].append(ex)

def edge(tickers):
    h = [x for t in tickers for x in by[t]["H"]]
    e = [x for t in tickers for x in by[t]["X"]]
    return (statistics.mean(h) - statistics.mean(e)) if h and e else None

tk = list(by)
point = edge(tk)
if point is None:
    sys.exit("Not enough scored HOLD and SELL/TRIM rows yet.")
random.seed(1)
boots = sorted(b for b in (edge([random.choice(tk) for _ in tk]) for _ in range(4000)) if b is not None)
lo, hi = boots[int(0.025 * len(boots))], boots[int(0.975 * len(boots))]
n_h = sum(len(v["H"]) for v in by.values()); n_x = sum(len(v["X"]) for v in by.values())
print(f"metric={metric}  tickers={len(tk)}  HOLD n={n_h}  EXIT n={n_x}")
print(f"edge = {point:+.2f} pp   95% CI [{lo:+.2f}, {hi:+.2f}]  ->",
      "exits discriminate" if lo > 0 else ("exits hurt" if hi < 0 else "no detectable edge"))
