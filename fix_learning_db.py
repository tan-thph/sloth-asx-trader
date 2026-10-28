#!/usr/bin/env python3
"""fix_learning_db.py - ONE command to finish the learning-score backfill.

  python3 fix_learning_db.py [--db asx_trader.db] [--url http://localhost:5000]

1. backs up the database (consistent SQLite online backup),
2. adds any missing scoring columns (safe to re-run),
3. calls the backfill endpoint in a loop until nothing more can be scored,
4. prints a summary and, if present, runs exit_edge.py.
The app must be running the new routes/learning.py (restart it after copying the file).
"""
import argparse, datetime, json, os, sqlite3, subprocess, sys, time
import urllib.error, urllib.request

COLUMNS = [
    ("decision_outcome", "TEXT"), ("exit_cf_ret_pct", "REAL"), ("exit_cf_excess_pct", "REAL"),
    ("exit_cf_z", "REAL"), ("exit_cf_attrib", "TEXT"),
    ("exit_cf_peer_excess_pct", "REAL"), ("exit_cf_peer_n", "INTEGER"),
]


def backup(db):
    dst = f"{db}.bak-{datetime.datetime.now():%Y%m%d-%H%M%S}"
    src = sqlite3.connect(db, timeout=60)
    out = sqlite3.connect(dst)
    src.backup(out)
    out.close(); src.close()
    print(f"[1/4] backup written: {dst}")


def add_columns(db):
    con = sqlite3.connect(db, timeout=60)
    have = {r[1] for r in con.execute("PRAGMA table_info(ai_learning_events)")}
    added = []
    for name, typ in COLUMNS:
        if name not in have:
            con.execute(f"ALTER TABLE ai_learning_events ADD COLUMN {name} {typ}")
            added.append(name)
    con.commit(); con.close()
    print(f"[2/4] columns added: {', '.join(added) if added else 'none (already present)'}")


def call(url, cap):
    req = urllib.request.Request(f"{url}/api/learning/backfill-exit-decisions?cap={cap}&rescore_holds=1",
                                 method="POST")
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="asx_trader.db")
    ap.add_argument("--url", default="http://localhost:5000")
    ap.add_argument("--cap", type=int, default=40)
    ap.add_argument("--max-calls", type=int, default=40)
    ap.add_argument("--no-backup", action="store_true")
    a = ap.parse_args()
    if not os.path.exists(a.db):
        sys.exit(f"database not found: {a.db}")

    if not a.no_backup:
        backup(a.db)
    add_columns(a.db)

    print("[3/4] running backfill (each call scores up to "
          f"{a.cap} exits, HOLDs and peer values)...")
    idle = 0
    for i in range(1, a.max_calls + 1):
        try:
            r = call(a.url, a.cap)
        except urllib.error.URLError as e:
            sys.exit(f"cannot reach the app at {a.url} ({e}). Is it running? Restart it first.")
        if not r.get("ok"):
            sys.exit(f"backfill error: {r.get('error')}")
        if "peer_pending" not in r:
            sys.exit("the app is still running the OLD learning.py - copy the new file in and restart it.")
        scored = r["exits_scored"] + r["holds_scored"] + r["peer_scored"]
        print(f"  call {i:2d}: scored exits={r['exits_scored']:>3} holds={r['holds_scored']:>3} "
              f"peers={r['peer_scored']:>3} | pending exits={r['exits_pending']} "
              f"holds={r['holds_pending']} peers={r['peer_pending']}")
        idle = idle + 1 if scored == 0 else 0
        if idle >= 2:
            break
        time.sleep(1)
    else:
        print("  stopped at --max-calls; run again to continue.")

    con = sqlite3.connect(a.db, timeout=60)
    print("\n[4/4] summary")
    for rec, dec, n in con.execute("""SELECT recommendation, COALESCE(decision_outcome,'(unscored)'), COUNT(*)
            FROM ai_learning_events WHERE recommendation IN ('HOLD','SELL','TRIM')
            GROUP BY 1,2 ORDER BY 1,2"""):
        print(f"  {rec:5s} {dec:12s} {n}")
    n_peer = con.execute("SELECT COUNT(*) FROM ai_learning_events WHERE exit_cf_peer_excess_pct IS NOT NULL").fetchone()[0]
    print(f"  rows with peer-relative excess: {n_peer}")
    con.close()
    here = os.path.dirname(os.path.abspath(__file__))
    edge = os.path.join(here, "exit_edge.py")
    if os.path.exists(edge):
        print()
        subprocess.run([sys.executable, edge, a.db])
    print("\nRows still pending are either younger than ~33 days or have no price data; they "
          "are retried automatically (next try after 7 days).")


if __name__ == "__main__":
    main()
