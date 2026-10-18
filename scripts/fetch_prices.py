"""Fetch daily OHLCV for every symbol in symbols.json from Yahoo Finance (SET = "<SYM>.BK")
and rebuild data/summary.json (trend metrics the dashboard table reads).

set.or.th blocks data-center IPs (GitHub Actions / cloud), Yahoo does not — so this runs
anywhere. Only `requests` is needed.

    python scripts/fetch_prices.py            # incremental (last 1 month merged into history)
    python scripts/fetch_prices.py --full     # re-download 2 years for every symbol
    python scripts/fetch_prices.py WHA DELTA  # only these symbols
"""
import argparse
import datetime as dt
import json
import math
import re
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
PRICES = ROOT / "data" / "prices"
SUMMARY = ROOT / "data" / "summary.json"
SYMBOLS = ROOT / "symbols.json"

BENCHMARK = "TDEX"  # ThaiDEX SET50 ETF; Yahoo has no history for the SET/SET50 index
FULL_RANGE = "2y"
INC_RANGE = "1mo"
KEEP_DAYS = 3 * 366
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"}
WIN_RESERVED = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$", re.I)
ICT = dt.timezone(dt.timedelta(hours=7))


def yahoo_ticker(sym):
    return sym if sym.startswith("^") else f"{sym}.BK"


def price_path(sym):
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", sym)
    if WIN_RESERVED.match(name):  # e.g. COM7 is a real SET stock
        name += "_"
    return PRICES / f"{name}.json"


def fetch_chart(sym, rng, session, tries=4):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_ticker(sym)}"
    for i in range(tries):
        try:
            r = session.get(url, params={"range": rng, "interval": "1d"}, headers=UA, timeout=30)
            if r.status_code == 404:
                return None
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(3 * (i + 1))
                continue
            r.raise_for_status()
            res = r.json()["chart"]["result"]
            return res[0] if res else None
        except (requests.RequestException, ValueError, KeyError) as e:
            print(f"  {sym}: retry {i + 1} ({e})", file=sys.stderr)
            time.sleep(2 * (i + 1))
    return None


def to_bars(res):
    meta = res.get("meta", {})
    off = meta.get("gmtoffset", 25200)
    q = (res.get("indicators", {}).get("quote") or [{}])[0]
    bars = {}
    for i, ts in enumerate(res.get("timestamp") or []):
        o, h, l, c, v = (q.get(k, [None])[i] for k in ("open", "high", "low", "close", "volume"))
        if c is None or o is None:
            continue
        day = dt.datetime.fromtimestamp(ts + off, dt.timezone.utc).date().isoformat()
        r4 = lambda x: round(x, 4)
        bars[day] = [day, r4(o), r4(h), r4(l), r4(c), int(v or 0)]
    return meta, bars


def update_symbol(sym, full, session):
    path = price_path(sym)
    old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    res = fetch_chart(sym, FULL_RANGE if (full or old is None) else INC_RANGE, session)
    if res is None:
        return old, False
    meta, new = to_bars(res)
    merged = {b[0]: b for b in (old or {}).get("bars", [])}
    merged.update(new)
    cutoff = (dt.date.today() - dt.timedelta(days=KEEP_DAYS)).isoformat()
    bars = [merged[d] for d in sorted(merged) if d >= cutoff]
    doc = {
        "symbol": sym,
        "name": meta.get("longName") or meta.get("shortName") or (old or {}).get("name") or sym,
        "currency": meta.get("currency", "THB"),
        "bars": bars,
    }
    path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    return doc, True


# ---------- metrics ----------

def sma(xs, n):
    return sum(xs[-n:]) / n if len(xs) >= n else None


def sma_at(xs, n, back):
    """SMA ending `back` bars before the last one."""
    return sma(xs[: len(xs) - back], n) if back else sma(xs, n)


def pct(a, b):
    return None if a is None or not b else round((a / b - 1) * 100, 2)


def rsi(closes, n=14):
    if len(closes) <= n:
        return None
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    ag, al = gains / n, losses / n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (n - 1) + max(d, 0)) / n
        al = (al * (n - 1) + max(-d, 0)) / n
    return 100.0 if al == 0 else round(100 - 100 / (1 + ag / al), 1)


def crossed(fast, slow, within):
    """+1 if fast crossed above slow in the last `within` bars, -1 if below, 0 otherwise."""
    for back in range(within):
        f1, s1 = fast(back), slow(back)
        f0, s0 = fast(back + 1), slow(back + 1)
        if None in (f1, s1, f0, s0):
            return 0
        if f0 <= s0 and f1 > s1:
            return 1
        if f0 >= s0 and f1 < s1:
            return -1
    return 0


TREND_LABELS = {6: "strong_up", 5: "strong_up", 4: "up", 3: "side", 2: "side", 1: "down", 0: "strong_down"}
UPTREND, DOWNTREND = {"strong_up", "up"}, {"down", "strong_down"}
TREND_LOOKBACK = 5      # "trend changed" signal compares with this many bars ago
SCORE_HISTORY = 120     # bars of daily trend score kept for the detail strip


def score_at(closes, back=0):
    """Trend score 0-6 as it was `back` bars before the last bar (see README 2.1)."""
    xs = closes[: len(closes) - back] if back else closes
    if not xs:
        return None
    c = xs[-1]
    ma20, ma50, ma200 = sma(xs, 20), sma(xs, 50), sma(xs, 200)
    ma50_prev = sma_at(xs, 50, 10)
    checks = [
        ma20 is not None and c > ma20,
        ma50 is not None and c > ma50,
        ma200 is not None and c > ma200,
        None not in (ma20, ma50) and ma20 > ma50,
        None not in (ma50, ma200) and ma50 > ma200,
        None not in (ma50, ma50_prev) and ma50 > ma50_prev,
    ]
    return sum(bool(x) for x in checks)


def metrics(doc, bench_ret3m=None):
    bars = doc["bars"]
    if len(bars) < 2:
        return None
    closes = [b[4] for b in bars]
    vols = [b[5] for b in bars]
    c = closes[-1]
    ma20, ma50, ma200 = sma(closes, 20), sma(closes, 50), sma(closes, 200)
    ma50_prev = sma_at(closes, 50, 10)
    score = score_at(closes)
    hist = [score_at(closes, k) for k in range(min(SCORE_HISTORY, len(closes)) - 1, -1, -1)]
    prev = score_at(closes, TREND_LOOKBACK) if len(closes) > TREND_LOOKBACK + 50 else None
    trend, trend_prev = TREND_LABELS[score], (None if prev is None else TREND_LABELS[prev])

    def ret(n):
        return pct(c, closes[-1 - n]) if len(closes) > n else None

    year = bars[-1][0][:4]
    prev_year = [b[4] for b in bars if b[0][:4] < year]
    w52 = closes[-252:]
    hi, lo = max(b[2] for b in bars[-252:]), min(b[3] for b in bars[-252:])
    avg20v = sma(vols[:-1], 20) if len(vols) > 20 else None
    val20 = sum(b[4] * b[5] for b in bars[-20:]) / min(20, len(bars))

    sig = []
    if len(bars) >= 120 and c >= max(w52):
        sig.append("high52")
    if len(bars) >= 120 and c <= min(w52):
        sig.append("low52")
    x = crossed(lambda k: sma_at(closes, 50, k), lambda k: sma_at(closes, 200, k), 10)
    if x:
        sig.append("golden" if x > 0 else "death")
    x = crossed(lambda k: closes[-1 - k], lambda k: sma_at(closes, 50, k), 3)
    if x:
        sig.append("x_ma50_up" if x > 0 else "x_ma50_dn")
    vr = round(vols[-1] / avg20v, 2) if avg20v else None
    if vr and vr >= 2:
        sig.append("vol_spike")
    if trend_prev and trend in UPTREND and trend_prev not in UPTREND:
        sig.append("enter_up")
    if trend_prev and trend in DOWNTREND and trend_prev not in DOWNTREND:
        sig.append("enter_dn")

    r3m = ret(63)
    return {
        "symbol": doc["symbol"],
        "name": doc["name"],
        "date": bars[-1][0],
        "close": c,
        "chg": ret(1),
        "r1w": ret(5),
        "r1m": ret(21),
        "r3m": r3m,
        "r6m": ret(126),
        "r1y": ret(252),
        "ytd": pct(c, prev_year[-1]) if prev_year else None,
        "ma20": ma20 and round(ma20, 4),
        "ma50": ma50 and round(ma50, 4),
        "ma200": ma200 and round(ma200, 4),
        "vs_ma50": pct(c, ma50),
        "vs_ma200": pct(c, ma200),
        "ma50_slope": pct(ma50, ma50_prev),
        "score": score,
        "trend": trend,
        "score_prev": prev,
        "trend_prev": trend_prev,
        "score_hist": hist,
        "hi52": hi,
        "lo52": lo,
        "pos52": round((c - lo) / (hi - lo) * 100, 1) if hi > lo else None,
        "rsi": rsi(closes[-120:]),
        "vol": vols[-1],
        "vol_ratio": vr,
        "value20": round(val20),
        "rs3m": None if r3m is None or bench_ret3m is None else round(r3m - bench_ret3m, 2),
        "signals": sig,
        "spark": [round(x, 4) for x in closes[-63:]],
        "bars": len(bars),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("symbols", nargs="*")
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--no-fetch", action="store_true", help="only rebuild summary.json")
    a = ap.parse_args()

    cfg = json.loads(SYMBOLS.read_text(encoding="utf-8"))
    groups = {s: "holding" for s in cfg.get("holdings", [])}
    for s in cfg.get("watchlist", []):
        groups.setdefault(s, "watch")
    todo = a.symbols or [BENCHMARK, *groups]
    PRICES.mkdir(parents=True, exist_ok=True)

    failed = []
    if not a.no_fetch:
        s = requests.Session()
        for i, sym in enumerate(todo, 1):
            _, ok = update_symbol(sym, a.full, s)
            print(f"[{i}/{len(todo)}] {sym}: {'ok' if ok else 'FAILED'}")
            if not ok:
                failed.append(sym)
            time.sleep(0.35)

    def load(sym):
        p = price_path(sym)
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    bdoc = load(BENCHMARK)
    bench = metrics(bdoc) if bdoc else None
    rows = []
    for sym, grp in groups.items():
        doc = load(sym)
        m = doc and metrics(doc, bench and bench["r3m"])
        if m:
            m["group"] = grp
            m["file"] = price_path(sym).name
            rows.append(m)
    missing = [s for s in groups if s not in {r["symbol"] for r in rows}]
    out = {
        "generated": dt.datetime.now(ICT).isoformat(timespec="minutes"),
        "as_of": max((r["date"] for r in rows), default=None),
        "benchmark": bench and {**bench, "file": price_path(BENCHMARK).name},
        "missing": missing,
        "rows": rows,
    }
    SUMMARY.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"summary: {len(rows)} symbols, as of {out['as_of']}; missing: {missing or '-'}")
    if failed:
        print(f"fetch failed: {failed}", file=sys.stderr)
    # fail the CI run only if almost everything failed (Yahoo down / blocked)
    return 1 if todo and len(failed) > len(todo) * 0.5 else 0


if __name__ == "__main__":
    sys.exit(main())
