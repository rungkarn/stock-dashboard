"""Backtest: does the trend score (0-6, see README 2.1) predict the next 1-3 months?

For every symbol in symbols.json and every 5th trading day with enough history, record the
score that day and the forward return 21 / 63 trading days later (also minus TDEX over the
same days). Then summarise by trend group, compute the cross-sectional rank correlation (IC)
per date, and simulate weekly-rebalanced equal-weight baskets.

Reads data/prices/*.json only (no network) -> data/backtest.json

    python scripts/backtest.py
"""
import datetime as dt
import json
import math
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_prices import BENCHMARK, ICT, SYMBOLS, TREND_LABELS, price_path  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "backtest.json"
HORIZONS = (21, 63)
STEP = 5                 # sample every 5th bar (≈ weekly) to limit overlap
REBAL = 21               # basket simulation: rebalance every 21 bars (≈ monthly), non-overlapping
WARMUP = 210             # MA200 + 10-bar MA50 slope
LIQUID_THB = 5_000_000   # "liquid" = 20-day average traded value ≥ 5 MTHB
GROUPS = ["strong_up", "up", "side", "down", "strong_down"]


def rolling_mean(xs, n):
    out = [None] * len(xs)
    s = 0.0
    for i, x in enumerate(xs):
        s += x
        if i >= n:
            s -= xs[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def score_series(closes):
    """Trend score for every bar; identical rules to fetch_prices.score_at."""
    m20, m50, m200 = rolling_mean(closes, 20), rolling_mean(closes, 50), rolling_mean(closes, 200)
    out = [None] * len(closes)
    for i, c in enumerate(closes):
        a, b, d = m20[i], m50[i], m200[i]
        prev50 = m50[i - 10] if i >= 10 else None
        checks = [
            a is not None and c > a,
            b is not None and c > b,
            d is not None and c > d,
            None not in (a, b) and a > b,
            None not in (b, d) and b > d,
            None not in (b, prev50) and b > prev50,
        ]
        out[i] = sum(bool(x) for x in checks)
    return out


def spearman(xs, ys):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(v):
            j = i
            while j + 1 < len(v) and v[order[j + 1]] == v[order[i]]:
                j += 1
            for k in range(i, j + 1):
                r[order[k]] = (i + j) / 2
            i = j + 1
        return r
    rx, ry = ranks(xs), ranks(ys)
    mx, my = statistics.fmean(rx), statistics.fmean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else None


def stats(rets, excess):
    if not rets:
        return {"n": 0}
    return {
        "n": len(rets),
        "mean": round(statistics.fmean(rets) * 100, 2),
        "median": round(statistics.median(rets) * 100, 2),
        "hit": round(sum(r > 0 for r in rets) / len(rets) * 100, 1),
        "ex_mean": round(statistics.fmean(excess) * 100, 2) if excess else None,
        "ex_hit": round(sum(e > 0 for e in excess) / len(excess) * 100, 1) if excess else None,
    }


def load(sym):
    p = price_path(sym)
    if not p.exists():
        return None
    bars = json.loads(p.read_text(encoding="utf-8"))["bars"]
    return [b[0] for b in bars], [b[4] for b in bars], [b[4] * b[5] for b in bars]


def run(symbols, bench):
    bdates, bcloses, _ = bench
    bidx = {d: i for i, d in enumerate(bdates)}

    def bench_ret(d0, d1):
        i, j = bidx.get(d0), bidx.get(d1)
        return None if i is None or j is None else bcloses[j] / bcloses[i] - 1

    obs = {h: [] for h in HORIZONS}            # (date, symbol, score, liquid, ret, excess)
    rebal_dates = set(bdates[WARMUP::REBAL])
    nxt = {bdates[i]: bdates[i + REBAL] for i in range(WARMUP, len(bdates) - REBAL, REBAL)}
    baskets = {}                                # rebalance date -> list of (score, fwd return, liquid)
    start = end = None
    for sym in symbols:
        data = load(sym)
        if not data:
            continue
        dates, closes, value = data
        if len(closes) < WARMUP + 25:
            continue
        sc = score_series(closes)
        val20 = rolling_mean(value, 20)
        di = {d: i for i, d in enumerate(dates)}
        for d0, d1 in nxt.items():
            i, j = di.get(d0), di.get(d1)
            if i is not None and j is not None and i >= WARMUP and closes[i] > 0:
                baskets.setdefault(d0, []).append((sc[i], closes[j] / closes[i] - 1, (val20[i] or 0) >= LIQUID_THB))
        for t in range(WARMUP, len(closes), STEP):
            if closes[t] <= 0:
                continue
            liquid = (val20[t] or 0) >= LIQUID_THB
            for h in HORIZONS:
                if t + h >= len(closes):
                    continue
                r = closes[t + h] / closes[t] - 1
                br = bench_ret(dates[t], dates[t + h])
                obs[h].append((dates[t], sym, sc[t], liquid, r, None if br is None else r - br))
                start = min(start or dates[t], dates[t])
                end = max(end or dates[t + h], dates[t + h])

    result = {"horizons": {}}
    for h, rows in obs.items():
        hres = {}
        for universe in ("all", "liquid"):
            rs = [o for o in rows if universe == "all" or o[3]]
            by_group = {g: stats([o[4] for o in rs if TREND_LABELS[o[2]] == g],
                                 [o[5] for o in rs if TREND_LABELS[o[2]] == g and o[5] is not None]) for g in GROUPS}
            by_score = {str(s): stats([o[4] for o in rs if o[2] == s], [o[5] for o in rs if o[2] == s and o[5] is not None])
                        for s in range(7)}
            # cross-sectional IC per date
            per_date = {}
            for o in rs:
                per_date.setdefault(o[0], []).append(o)
            ics = []
            for d, os_ in per_date.items():
                if len(os_) >= 10 and len({o[2] for o in os_}) > 1:
                    ic = spearman([o[2] for o in os_], [o[4] for o in os_])
                    if ic is not None:
                        ics.append(ic)
            hres[universe] = {
                "groups": by_group,
                "scores": by_score,
                "ic_mean": round(statistics.fmean(ics), 3) if ics else None,
                "ic_pos": round(sum(i > 0 for i in ics) / len(ics) * 100, 1) if ics else None,
                "ic_dates": len(ics),
                "n_symbols": len({o[1] for o in rs}),
            }
        result["horizons"][str(h)] = hres

    # monthly-rebalanced equal-weight baskets of LIQUID stocks (no costs, no dividends).
    # Penny stocks are excluded: one tick (0.01 -> 0.02) is +100% and swamps an equal-weight mean.
    curve = {"dates": [], "up": [], "all": [], "down": [], "bench": [], "n_up": [], "n_down": []}
    lv = {"up": 1.0, "all": 1.0, "down": 1.0, "bench": 1.0}
    for d in sorted(baskets):
        liq = [(s, r) for s, r, l in baskets[d] if l]
        if len(liq) < 10:
            continue
        up = [r for s, r in liq if s >= 5]
        dn = [r for s, r in liq if s <= 1]
        i = bidx[d]
        lv["up"] *= 1 + (statistics.fmean(up) if up else 0)
        lv["down"] *= 1 + (statistics.fmean(dn) if dn else 0)
        lv["all"] *= 1 + statistics.fmean(r for _, r in liq)
        lv["bench"] *= bcloses[i + REBAL] / bcloses[i]
        curve["dates"].append(bdates[i + REBAL])
        curve["n_up"].append(len(up))
        curve["n_down"].append(len(dn))
        for k in lv:
            curve[k].append(round((lv[k] - 1) * 100, 2))
    if curve["dates"]:
        first = sorted(baskets)[0]
        for k in ("up", "all", "down", "bench"):
            curve[k].insert(0, 0.0)
        curve["dates"].insert(0, first)
        curve["n_up"].insert(0, None)
        curve["n_down"].insert(0, None)
    result["curve"] = curve
    result["period"] = [start, end]
    return result


def main():
    cfg = json.loads(SYMBOLS.read_text(encoding="utf-8"))
    symbols = list(dict.fromkeys(cfg.get("holdings", []) + cfg.get("watchlist", [])))
    bench = load(BENCHMARK)
    if not bench:
        print("benchmark prices missing", file=sys.stderr)
        return 1
    res = run(symbols, bench)
    res.update(generated=dt.datetime.now(ICT).isoformat(timespec="minutes"), step=STEP, rebal=REBAL,
               liquid_thb=LIQUID_THB, benchmark=BENCHMARK)
    OUT.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    h = res["horizons"]["63"]["all"]
    print(f"backtest {res['period']}: 63d strong_up mean {h['groups']['strong_up'].get('mean')}% vs "
          f"strong_down {h['groups']['strong_down'].get('mean')}%, IC {h['ic_mean']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
