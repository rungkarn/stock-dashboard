"""Fetch dividends, rights/warrant events (XD/XR/XW/XB/XM), valuation and 5-year financial
highlights from set.or.th, for every symbol in symbols.json.

**Run on a PC in Thailand** — set.or.th (Incapsula) blocks data-center IPs, so this does NOT
work on GitHub Actions / cloud. scripts/set_refresh.bat runs it and pushes the result.

    python scripts/fetch_set_info.py             # all symbols
    python scripts/fetch_set_info.py WHA DELTA   # only these (others keep their old data)

Writes
    data/set_info.json          one row per symbol (table columns) + upcoming events calendar
    data/set_info/<SYM>.json    full event history + yearly financials (detail panel)
"""
import datetime as dt
import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "set_info.json"
DETAIL = ROOT / "data" / "set_info"
SYMBOLS = ROOT / "symbols.json"
SET = "https://www.set.or.th"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
WIN_RESERVED = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$", re.I)
ICT = dt.timezone(dt.timedelta(hours=7))
TODAY = dt.datetime.now(ICT).date().isoformat()
UPCOMING_DAYS = 60


def detail_path(sym):
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", sym)
    if WIN_RESERVED.match(name):
        name += "_"
    return DETAIL / f"{name}.json"


def session():
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    s.get(f"{SET}/en/home", timeout=20)  # prime Incapsula cookies
    s.headers.update({"Accept": "application/json, text/plain, */*",
                      "Referer": f"{SET}/en/market/get-quote/stock"})
    return s


def get(s, path):
    for attempt in range(3):
        try:
            r = s.get(SET + path, timeout=25)
            if r.status_code == 200 and "json" in r.headers.get("content-type", ""):
                return r.json()
            if r.status_code in (403, 429):
                time.sleep(3 * (attempt + 1))
                s.get(f"{SET}/en/home", timeout=20)
                continue
            return None
        except (requests.RequestException, ValueError):
            time.sleep(2)
    return None


d10 = lambda x: (x or "")[:10] or None


def rnd(x, n=2):
    return None if x is None else round(x, n)


def events(ca):
    """Normalise corporate actions into compact dicts (newest first)."""
    out = []
    for a in ca or []:
        t = a.get("caType") or a.get("type")
        e = {"type": t, "xdate": d10(a.get("xdate"))}
        if t == "XD":
            e.update(amount=a.get("dividend"), pay=d10(a.get("paymentDate")),
                     period=[d10(a.get("beginOperation")), d10(a.get("endOperation"))],
                     source=a.get("sourceOfDividend"), kind=a.get("dividendType"))
        elif t == "XD(ST)":
            e.update(ratio=a.get("ratio") or a.get("dividendPayment"), pay=d10(a.get("paymentDate")),
                     kind=a.get("dividendType"))
        elif t in ("XR", "XW", "XB", "XT", "XE", "XS"):
            e.update(ratio=a.get("ratio"), price=a.get("price"), rights=a.get("rightsFor") or a.get("securityType"),
                     sub=[d10(a.get("beginSubscription")), d10(a.get("endSubscription"))],
                     allot=a.get("allotShare"), cond=a.get("condition") or None)
        elif t == "XM":
            e.update(meeting=d10(a.get("meetingDate")), mtype=a.get("meetingType"), agenda=a.get("agenda"))
        else:
            e["raw"] = {k: v for k, v in a.items() if v not in (None, "") and k not in ("symbol", "name")}
        out.append({k: v for k, v in e.items() if v not in (None, "", [None, None])})
    return sorted(out, key=lambda e: e.get("xdate") or "", reverse=True)


def div_by_year(evs):
    """Cash dividend per fiscal year (year of the operating period's end; XD year if missing)."""
    by = defaultdict(float)
    for e in evs:
        if e["type"] == "XD" and e.get("amount"):
            per = e.get("period") or [None, None]
            yr = (per[1] or e["xdate"] or "")[:4]
            if yr:
                by[yr] += e["amount"]
    return {y: round(v, 4) for y, v in sorted(by.items())}


def financials(fin):
    keep = ("totalRevenue", "netProfit", "eps", "roe", "roa", "netProfitMargin", "deRatio", "totalAsset", "equity")
    rows = []
    for f in fin or []:
        label = str(f.get("year")) + ("" if f.get("quarter") == "Q9" else f" {f.get('quarter')}")
        rows.append({"label": label, "annual": f.get("quarter") == "Q9",
                     **{k: rnd(f.get(k)) for k in keep}})
    return rows


def build(s, sym, set50, set100):
    prof = get(s, f"/api/set/stock/{sym}/profile?lang=en") or {}
    hl = get(s, f"/api/set/stock/{sym}/highlight-data?lang=en") or {}
    ca = get(s, f"/api/set/stock/{sym}/corporate-action?lang=en")
    fin = get(s, f"/api/set/stock/{sym}/company-highlight/financial-data?lang=en")
    ts = get(s, f"/api/set/stock/{sym}/company-highlight/trading-stat?lang=en")
    if not prof and not hl and ca is None:
        return None, None

    evs = events(ca)
    divs = div_by_year(evs)
    cash = [e for e in evs if e["type"] == "XD" and e.get("amount")]
    past = [e for e in cash if (e.get("xdate") or "") <= TODAY]
    nxt = sorted((e for e in evs if e["type"] != "XM" and (e.get("xdate") or "") > TODAY), key=lambda e: e["xdate"])
    caps = [e for e in evs if e["type"] in ("XR", "XW", "XB", "XT", "XD(ST)", "XS")]
    cutoff3y = (dt.date.fromisoformat(TODAY) - dt.timedelta(days=3 * 365)).isoformat()
    streak = 0
    for y in range(int(TODAY[:4]) - 1, 1990, -1):
        if str(y) in divs:
            streak += 1
        else:
            break
    ts_last = (ts or [{}])[-1] if ts else {}
    fin_rows = financials(fin)
    annual = [f for f in fin_rows if f["annual"]]

    row = {
        "sector": prof.get("sectorName") or prof.get("industryName"),
        "industry": prof.get("industryName"),
        "market": prof.get("market"),
        "set50": sym in set50,
        "set100": sym in set100,
        "pe": hl.get("peRatio"),
        "pbv": hl.get("pbRatio"),
        "yield": rnd(hl.get("dividendYield12M") or hl.get("dividendYield")),
        "payout": rnd(ts_last.get("dividendPayoutRatio") * 100 if ts_last.get("dividendPayoutRatio") is not None else None, 0),
        "mcap": hl.get("marketCap"),
        "free_float": rnd(hl.get("percentFreeFloat"), 1),
        "foreign_room": rnd(prof.get("percentForeignRoom"), 1),
        "nvdr_net": hl.get("nvdrNetValue"),
        "divs": {y: divs[y] for y in list(divs)[-6:]},
        "div_streak": streak,
        "div_years_5": sum(1 for y in range(int(TODAY[:4]) - 5, int(TODAY[:4])) if str(y) in divs),
        "last_xd": {k: past[0].get(k) for k in ("xdate", "amount", "pay")} if past else None,
        "next": {k: nxt[0].get(k) for k in ("type", "xdate", "amount", "ratio", "price", "pay")} if nxt else None,
        "caps_3y": [{k: e.get(k) for k in ("type", "xdate", "ratio", "price", "rights")}
                    for e in caps if (e.get("xdate") or "") >= cutoff3y],
        "roe": annual[-1]["roe"] if annual else None,
        "npm": annual[-1]["netProfitMargin"] if annual else None,
        "de": annual[-1]["deRatio"] if annual else None,
        "profit_growth": (None if len(annual) < 2 or not annual[-2]["netProfit"] or annual[-2]["netProfit"] <= 0
                          else rnd((annual[-1]["netProfit"] / annual[-2]["netProfit"] - 1) * 100, 1)),
    }
    detail = {
        "symbol": sym,
        "name": prof.get("name"),
        "listed": d10(prof.get("listedDate")),
        "events": evs,
        "financials": fin_rows,
        "trading": [{"period": t.get("period"), "close": t.get("close"), "pe": rnd(t.get("pe")), "pbv": rnd(t.get("pbv")),
                     "yield": rnd(t.get("dividendYield")), "payout": rnd(t.get("dividendPayoutRatio"))}
                    for t in ts or []],
    }
    return row, detail


def index_members(s, ix):
    data = get(s, f"/api/set/index/{ix}/composition?lang=en") or {}
    comp = data.get("composition") or {}
    syms = {x.get("symbol") for x in comp.get("stockInfos") or []}
    for sub in comp.get("subIndices") or []:
        syms |= {x.get("symbol") for x in sub.get("stockInfos") or []}
    return syms


def main(only):
    cfg = json.loads(SYMBOLS.read_text(encoding="utf-8"))
    syms = list(dict.fromkeys(cfg.get("holdings", []) + cfg.get("watchlist", [])))
    todo = only or syms
    s = session()
    set50, set100 = index_members(s, "SET50"), index_members(s, "SET100")
    if not set50:
        print("set.or.th not reachable (blocked IP?) — aborting, nothing written", file=sys.stderr)
        return 2

    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"rows": {}}
    rows = {k: v for k, v in old.get("rows", {}).items() if k in syms}
    DETAIL.mkdir(parents=True, exist_ok=True)
    failed = []
    for i, sym in enumerate(todo, 1):
        row, det = build(s, sym, set50, set100)
        if row is None:
            failed.append(sym)
            print(f"[{i}/{len(todo)}] {sym}: FAILED")
            continue
        rows[sym] = {**row, "file": detail_path(sym).name}
        detail_path(sym).write_text(json.dumps(det, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"[{i}/{len(todo)}] {sym}: ok  divs={row['divs']}  caps3y={len(row['caps_3y'])}")
        time.sleep(0.2)

    # upcoming calendar (from detail files, so symbols not re-fetched this run still count)
    horizon = (dt.date.fromisoformat(TODAY) + dt.timedelta(days=UPCOMING_DAYS)).isoformat()
    upcoming = []
    for sym, r in rows.items():
        p = DETAIL / r["file"]
        if not p.exists():
            continue
        for e in json.loads(p.read_text(encoding="utf-8"))["events"]:
            when = e.get("xdate") or ""
            if TODAY <= when <= horizon:
                upcoming.append({"symbol": sym, **{k: e.get(k) for k in ("type", "xdate", "amount", "ratio", "price", "pay", "meeting", "rights")}})
    upcoming.sort(key=lambda e: (e["xdate"], e["symbol"]))

    OUT.write_text(json.dumps({
        "generated": dt.datetime.now(ICT).isoformat(timespec="minutes"),
        "rows": rows,
        "upcoming": [{k: v for k, v in e.items() if v is not None} for e in upcoming],
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"set_info: {len(rows)} symbols, {len(upcoming)} upcoming events; failed: {failed or '-'}")
    return 1 if len(failed) > len(todo) * 0.5 else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
