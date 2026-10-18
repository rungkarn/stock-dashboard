"""Backtest: does the trend score (0-6, see README 2.1) predict the next 1-3 months, and which
simple holding rule would have worked best on these stocks?

* Returns are TOTAL returns (price + cash dividends reinvested on the XD date) by default;
  price-only results are kept too for comparison.
  Dividends: SET XD history (data/set_info/<SYM>.json), else Yahoo dividends in the price file.
* For every symbol and every 5th trading day with enough history: trend score that day and the
  forward return 21 / 63 trading days later (also minus TDEX over the same days).
  Summarised by trend group, plus the cross-sectional rank correlation (IC) per date.
* Rule comparison: every ~month (21 bars) hold an equal-weight basket of the liquid stocks that
  pass a rule; compound the baskets; compare with TDEX (total return).

Reads local files only -> data/backtest.json

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
SET_INFO = ROOT / "data" / "set_info.json"
HORIZONS = (21, 63)
STEP = 5                 # sample every 5th bar (≈ weekly) to limit overlap
REBAL = 21               # rule simulation: rebalance every 21 bars (≈ monthly), non-overlapping
WARMUP = 210             # MA200 + 10-bar MA50 slope
LIQUID_THB = 5_000_000   # "liquid" = 20-day average traded value ≥ 5 MTHB
MAX_DIV_FRACTION = 0.25  # ignore a "dividend" above 25% of the price (split/adjustment mismatch)
GROUPS = ["strong_up", "up", "side", "down", "strong_down"]

# rule id -> (Thai label, predicate(features))
RULES = {
    "all": ("ทุกตัว (ไม่กรอง)", lambda f: True),
    "score5": ("ขาขึ้นแรง (คะแนน 5–6)", lambda f: f["score"] >= 5),
    "score4": ("ขาขึ้นขึ้นไป (คะแนน ≥ 4)", lambda f: f["score"] >= 4),
    "not_down": ("ไม่อยู่ขาลง (คะแนน ≥ 2)", lambda f: f["score"] >= 2),
    "above200": ("ราคาเหนือ MA200", lambda f: f["above200"]),
    "yield4": ("Yield ย้อนหลัง 12 เดือน ≥ 4%", lambda f: f["yield"] >= 4),
    "yield4_above200": ("Yield ≥ 4% และเหนือ MA200", lambda f: f["yield"] >= 4 and f["above200"]),
    "yield4_not_down": ("Yield ≥ 4% และไม่อยู่ขาลง", lambda f: f["yield"] >= 4 and f["score"] >= 2),
    "down": ("ขาลง (คะแนน 0–1) — เทียบ", lambda f: f["score"] <= 1),
}


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


def dividends_on_bars(dates, closes, divs):
    """Cash dividend per bar: each XD amount is booked on the first bar dated ≥ its X-date."""
    per_bar = [0.0] * len(dates)
    j = 0
    for xd, amt in sorted(divs):
        while j < len(dates) and dates[j] < xd:
            j += 1
        if j >= len(dates) or j == 0:
            continue
        if amt <= closes[j - 1] * MAX_DIV_FRACTION:
            per_bar[j] += amt
    return per_bar


def total_return_index(closes, per_bar):
    """Price index with dividends reinvested at the previous close."""
    tr = [closes[0]]
    for i in range(1, len(closes)):
        prev = closes[i - 1]
        tr.append(tr[-1] * ((closes[i] + per_bar[i]) / prev) if prev else tr[-1])
    return tr


def trailing_yield(dates, closes, per_bar):
    """Dividends paid in the 365 days up to each bar ÷ that bar's close (%)."""
    out = [0.0] * len(dates)
    window = []      # (date, amount) inside the last 365 days
    total = 0.0
    lo = 0
    for i, d in enumerate(dates):
        if per_bar[i]:
            window.append((d, per_bar[i]))
            total += per_bar[i]
        cut = (dt.date.fromisoformat(d) - dt.timedelta(days=365)).isoformat()
        while lo < len(window) and window[lo][0] <= cut:
            total -= window[lo][1]
            lo += 1
        out[i] = total / closes[i] * 100 if closes[i] else 0.0
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


def max_drawdown(levels):
    peak, mdd = levels[0], 0.0
    for v in levels:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1)
    return mdd


def load(sym, set_divs):
    p = price_path(sym)
    if not p.exists():
        return None
    doc = json.loads(p.read_text(encoding="utf-8"))
    bars = doc["bars"]
    dates, closes = [b[0] for b in bars], [b[4] for b in bars]
    divs = set_divs.get(sym)
    if divs is None:
        divs = [tuple(x) for x in doc.get("divs", [])]
    per_bar = dividends_on_bars(dates, closes, divs)
    return {
        "dates": dates, "closes": closes, "value": [b[4] * b[5] for b in bars],
        "tr": total_return_index(closes, per_bar),
        "yield": trailing_yield(dates, closes, per_bar),
        "n_divs": sum(1 for x in per_bar if x),
    }


def load_set_divs():
    """SET XD history per symbol: {SYM: [(xdate, amount), ...]} (only symbols that have SET info)."""
    out = {}
    if not SET_INFO.exists():
        return out
    rows = json.loads(SET_INFO.read_text(encoding="utf-8")).get("rows", {})
    for sym, r in rows.items():
        p = ROOT / "data" / "set_info" / r["file"]
        if p.exists():
            ev = json.loads(p.read_text(encoding="utf-8"))["events"]
            out[sym] = [(e["xdate"], e["amount"]) for e in ev if e["type"] == "XD" and e.get("amount") and e.get("xdate")]
    return out


def group_stats(rows, idx_ret, idx_ex):
    by_group = {g: stats([o[idx_ret] for o in rows if TREND_LABELS[o[2]] == g],
                         [o[idx_ex] for o in rows if TREND_LABELS[o[2]] == g and o[idx_ex] is not None]) for g in GROUPS}
    per_date = {}
    for o in rows:
        per_date.setdefault(o[0], []).append(o)
    ics = []
    for os_ in per_date.values():
        if len(os_) >= 10 and len({o[2] for o in os_}) > 1:
            ic = spearman([o[2] for o in os_], [o[idx_ret] for o in os_])
            if ic is not None:
                ics.append(ic)
    return {
        "groups": by_group,
        "ic_mean": round(statistics.fmean(ics), 3) if ics else None,
        "ic_pos": round(sum(i > 0 for i in ics) / len(ics) * 100, 1) if ics else None,
        "ic_dates": len(ics),
        "n_symbols": len({o[1] for o in rows}),
    }


def run(symbols, bench, set_divs):
    bdates, btr = bench["dates"], bench["tr"]
    bidx = {d: i for i, d in enumerate(bdates)}

    def bench_ret(d0, d1, key="tr"):
        i, j = bidx.get(d0), bidx.get(d1)
        s = bench[key]
        return None if i is None or j is None else s[j] / s[i] - 1

    # observation: (date, sym, score, liquid, tr_ret, tr_excess, px_ret, px_excess)
    obs = {h: [] for h in HORIZONS}
    nxt = {bdates[i]: bdates[i + REBAL] for i in range(WARMUP, len(bdates) - REBAL, REBAL)}
    baskets = {}                                # rebalance date -> list of (features, tr_ret)
    start = end = None
    div_cover = 0
    for sym in symbols:
        data = load(sym, set_divs)
        if not data:
            continue
        dates, closes, tr = data["dates"], data["closes"], data["tr"]
        div_cover += data["n_divs"] > 0
        if len(closes) < WARMUP + 25:
            continue
        sc = score_series(closes)
        m200 = rolling_mean(closes, 200)
        val20 = rolling_mean(data["value"], 20)
        di = {d: i for i, d in enumerate(dates)}
        for d0, d1 in nxt.items():
            i, j = di.get(d0), di.get(d1)
            if i is None or j is None or i < WARMUP or closes[i] <= 0:
                continue
            f = {"score": sc[i], "above200": m200[i] is not None and closes[i] > m200[i],
                 "yield": data["yield"][i], "liquid": (val20[i] or 0) >= LIQUID_THB}
            baskets.setdefault(d0, []).append((f, tr[j] / tr[i] - 1))
        for t in range(WARMUP, len(closes), STEP):
            if closes[t] <= 0:
                continue
            liquid = (val20[t] or 0) >= LIQUID_THB
            for h in HORIZONS:
                if t + h >= len(closes):
                    continue
                r_tr = tr[t + h] / tr[t] - 1
                r_px = closes[t + h] / closes[t] - 1
                b_tr = bench_ret(dates[t], dates[t + h], "tr")
                b_px = bench_ret(dates[t], dates[t + h], "closes")
                obs[h].append((dates[t], sym, sc[t], liquid, r_tr, None if b_tr is None else r_tr - b_tr,
                               r_px, None if b_px is None else r_px - b_px))
                start = min(start or dates[t], dates[t])
                end = max(end or dates[t + h], dates[t + h])

    result = {"horizons": {}, "horizons_price": {}}
    for h, rows in obs.items():
        result["horizons"][str(h)] = {u: group_stats([o for o in rows if u == "all" or o[3]], 4, 5) for u in ("all", "liquid")}
        result["horizons_price"][str(h)] = {u: group_stats([o for o in rows if u == "all" or o[3]], 6, 7) for u in ("all", "liquid")}

    # rule baskets (liquid stocks only, total return, equal weight, monthly)
    dates_out = []
    levels = {k: [1.0] for k in RULES}
    levels["bench"] = [1.0]
    counts = {k: [] for k in RULES}
    beat = {k: 0 for k in RULES}
    for d in sorted(baskets):
        liq = [(f, r) for f, r in baskets[d] if f["liquid"]]
        if len(liq) < 10:
            continue
        i = bidx[d]
        br = btr[i + REBAL] / btr[i] - 1
        for k, (_, rule) in RULES.items():
            picks = [r for f, r in liq if rule(f)]
            ret = statistics.fmean(picks) if picks else 0.0   # nothing passes -> hold cash
            levels[k].append(levels[k][-1] * (1 + ret))
            counts[k].append(len(picks))
            beat[k] += ret > br
        levels["bench"].append(levels["bench"][-1] * (1 + br))
        dates_out.append(bdates[i + REBAL])
    months = len(dates_out)
    years = months * REBAL / 252 if months else 0
    rules_out = {}
    for k, (label, _) in list(RULES.items()) + [("bench", ("TDEX (SET50) รวมปันผล", None))]:
        lv = levels[k]
        tot = lv[-1] - 1
        rules_out[k] = {
            "label": label,
            "total": round(tot * 100, 1),
            "cagr": round(((lv[-1]) ** (1 / years) - 1) * 100, 1) if years and lv[-1] > 0 else None,
            "mdd": round(max_drawdown(lv) * 100, 1),
            "avg_n": round(statistics.fmean(counts[k]), 1) if k in counts and counts[k] else None,
            "beat_bench": round(beat[k] / months * 100) if k in beat and months else None,
            "curve": [round((v - 1) * 100, 2) for v in lv],
        }
    first = sorted(baskets)[0] if baskets else None
    result["rules"] = {"dates": ([first] if first else []) + dates_out, "months": months, "items": rules_out}
    result["period"] = [start, end]
    result["div_coverage"] = div_cover
    return result


def main():
    cfg = json.loads(SYMBOLS.read_text(encoding="utf-8"))
    symbols = list(dict.fromkeys(cfg.get("holdings", []) + cfg.get("watchlist", [])))
    set_divs = load_set_divs()
    bench = load(BENCHMARK, {})
    if not bench:
        print("benchmark prices missing", file=sys.stderr)
        return 1
    res = run(symbols, bench, set_divs)
    res.update(generated=dt.datetime.now(ICT).isoformat(timespec="minutes"), step=STEP, rebal=REBAL,
               liquid_thb=LIQUID_THB, benchmark=BENCHMARK)
    OUT.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    h = res["horizons"]["63"]["liquid"]
    best_k, best = max(((k, v) for k, v in res["rules"]["items"].items() if k != "bench"), key=lambda kv: kv[1]["total"])
    print(f"backtest {res['period']} (total return): 63d liquid strong_up {h['groups']['strong_up'].get('mean')}% vs "
          f"strong_down {h['groups']['strong_down'].get('mean')}%, IC {h['ic_mean']}; best rule: {best_k} "
          f"{best['total']}% vs TDEX {res['rules']['items']['bench']['total']}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
