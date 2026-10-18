"""Thai weekly summary of the last 5 trading days: what changed, upcoming XD/XR/XW, what to watch.

Reads data/summary.json, data/prices/*.json, data/set_info.json (no network) and writes
    data/weekly.json   (the page renders the "สรุปสัปดาห์" card from this)
    data/weekly.md     (same content as Markdown, readable on GitHub)

    python scripts/weekly_summary.py
"""
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_prices import BENCHMARK, ICT, UPTREND, DOWNTREND, price_path, sma  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DAYS = 5            # "this week" = last 5 trading days
EVENT_DAYS = 14     # upcoming corporate actions window
# One tick on a 0.03-baht stock is +33%: keep such names out of "movers" and price-move reasons
PENNY = 0.5         # baht
MIN_VALUE = 1_000_000  # 20-day average traded value, baht
TH = {"strong_up": "ขาขึ้นแรง", "up": "ขาขึ้น", "side": "ทรงตัว", "down": "ขาลง", "strong_down": "ขาลงแรง"}
ORDER = ["strong_up", "up", "side", "down", "strong_down"]
MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."]


def thd(iso):
    d = dt.date.fromisoformat(iso)
    return f"{d.day} {MONTHS[d.month - 1]}"


def pct(v, d=1):
    return "–" if v is None else f"{'+' if v > 0 else '−' if v < 0 else ''}{abs(v):.{d}f}%"


def week_facts(sym, bars, start):
    """What happened this week (bars dated on/after `start`).

    New 52-week high/low must be *strictly* beyond the previous 251 closes (flat penny stocks
    would otherwise "tie" every day). MA200 is compared at the week's start vs its end, so a
    stock that dips below and recovers within the week is not reported both ways.
    """
    closes = [b[4] for b in bars]
    vols = [b[5] for b in bars]
    n = len(closes)
    f = {"high52": False, "low52": False, "below200": False, "above200": False, "spikes": []}
    week = [i for i in range(max(1, n - DAYS), n) if bars[i][0] >= start]
    if not week:
        return f
    for i in week:
        prior = closes[max(0, i - 251): i]
        if i >= 120 and prior:
            if closes[i] > max(prior):
                f["high52"] = True
            if closes[i] < min(prior):
                f["low52"] = True
        avg = sma(vols[:i], 20) if i > 20 else None
        if avg and vols[i] >= 2 * avg:
            f["spikes"].append({"date": bars[i][0], "ratio": round(vols[i] / avg, 1),
                                "chg": round((closes[i] / closes[i - 1] - 1) * 100, 1) if closes[i - 1] else None})
    i0 = week[0] - 1
    m0, m1 = sma(closes[: i0 + 1], 200), sma(closes, 200)
    if None not in (m0, m1):
        f["below200"] = closes[i0] >= m0 and closes[-1] < m1
        f["above200"] = closes[i0] <= m0 and closes[-1] > m1
    return f


def build():
    summary = json.loads((DATA / "summary.json").read_text(encoding="utf-8"))
    info_p = DATA / "set_info.json"
    info = json.loads(info_p.read_text(encoding="utf-8")) if info_p.exists() else None
    rows = summary["rows"]
    bench_bars = json.loads(price_path(BENCHMARK).read_text(encoding="utf-8"))["bars"]
    start = bench_bars[-DAYS][0]

    now, prev = {k: 0 for k in ORDER}, {k: 0 for k in ORDER}
    above_now = above_prev = have = 0
    trend_up, trend_dn, watch, strong = [], [], {}, {}
    highs, lows, spikes = [], [], []
    for r in rows:
        bars = json.loads(price_path(r["symbol"]).read_text(encoding="utf-8"))["bars"]
        closes = [b[4] for b in bars]
        tradable = r["close"] >= PENNY and (r.get("value20") or 0) >= MIN_VALUE
        now[r["trend"]] += 1
        if r.get("trend_prev"):
            prev[r["trend_prev"]] += 1
        if len(closes) > DAYS + 50:
            m_now, m_prev = sma(closes, 50), sma(closes[:-DAYS], 50)
            have += 1
            above_now += closes[-1] > m_now
            above_prev += closes[-1 - DAYS] > m_prev
        sym, tp, tn = r["symbol"], r.get("trend_prev"), r["trend"]
        if tp and tn in UPTREND and tp not in UPTREND:
            trend_up.append({"symbol": sym, "from": tp, "to": tn})
            strong.setdefault(sym, []).append(f"เข้าสู่{TH[tn]} (จาก{TH[tp]})")
        if tp and tn in DOWNTREND and tp not in DOWNTREND:
            trend_dn.append({"symbol": sym, "from": tp, "to": tn})
            watch.setdefault(sym, []).append(f"เข้าสู่{TH[tn]} (จาก{TH[tp]})")
        f = week_facts(sym, bars, start)
        if f["high52"]:
            highs.append(sym)
            strong.setdefault(sym, []).append("ทำจุดสูงสุดใหม่ 52 สัปดาห์")
        if f["low52"]:
            lows.append(sym)
            watch.setdefault(sym, []).append("ทำจุดต่ำสุดใหม่ 52 สัปดาห์")
        if f["below200"]:
            watch.setdefault(sym, []).append("ราคาหลุดเส้น MA200")
        if f["above200"]:
            strong.setdefault(sym, []).append("ราคาขึ้นเหนือเส้น MA200")
        if "death" in r["signals"]:
            watch.setdefault(sym, []).append("Death cross (MA50 ตัดลง MA200)")
        if "golden" in r["signals"]:
            strong.setdefault(sym, []).append("Golden cross (MA50 ตัดขึ้น MA200)")
        for s in f["spikes"]:
            spikes.append({"symbol": sym, **s})
            if not tradable:
                continue
            if s["chg"] is not None and s["chg"] <= -5:
                watch.setdefault(sym, []).append(f"วอลุ่ม {s['ratio']}× พร้อมราคาลง {pct(s['chg'])} ({thd(s['date'])})")
            if s["chg"] is not None and s["chg"] >= 5:
                strong.setdefault(sym, []).append(f"วอลุ่ม {s['ratio']}× พร้อมราคาขึ้น {pct(s['chg'])} ({thd(s['date'])})")

    by_sym = {r["symbol"]: r for r in rows}
    allw = [r for r in rows if r.get("r1w") is not None]
    movers = sorted((r for r in allw if r["close"] >= PENNY and (r.get("value20") or 0) >= MIN_VALUE), key=lambda r: r["r1w"])
    med = sorted(r["r1w"] for r in allw)
    as_of = summary["as_of"]
    events = []
    if info:
        horizon = (dt.date.fromisoformat(as_of) + dt.timedelta(days=EVENT_DAYS + 3)).isoformat()
        for e in info.get("upcoming", []):
            if as_of < e["xdate"] <= horizon:
                events.append(e)
                if e["type"] == "XR":
                    watch.setdefault(e["symbol"], []).append(f"XR เพิ่มทุน {thd(e['xdate'])} อัตรา {e.get('ratio', '')} — ระวังราคาต่อหุ้นถูก dilute")

    def ranked(d):
        return sorted(({"symbol": k, "reasons": v, "r1w": by_sym.get(k, {}).get("r1w"), "trend": by_sym.get(k, {}).get("trend")}
                       for k, v in d.items()), key=lambda x: (-len(x["reasons"]), x["r1w"] if x["r1w"] is not None else 0))

    b = summary.get("benchmark") or {}
    return {
        "generated": dt.datetime.now(ICT).isoformat(timespec="minutes"),
        "week": [start, as_of],
        "n": len(rows),
        "breadth": {"now": now, "prev": prev},
        "above50": {"now": round(above_now / have * 100) if have else None, "prev": round(above_prev / have * 100) if have else None},
        "bench": {"symbol": b.get("symbol"), "r1w": b.get("r1w"), "trend": b.get("trend")},
        "median_r1w": med[len(med) // 2] if med else None,
        "up_count": sum(1 for r in allw if r["r1w"] > 0),
        "down_count": sum(1 for r in allw if r["r1w"] < 0),
        "movers_n": len(movers),
        "top": [{"symbol": r["symbol"], "r1w": r["r1w"]} for r in movers[::-1][:5]],
        "bottom": [{"symbol": r["symbol"], "r1w": r["r1w"]} for r in movers[:5]],
        "trend_up": trend_up, "trend_dn": trend_dn,
        "highs": highs, "lows": lows,
        "spikes": sorted(spikes, key=lambda s: -s["ratio"])[:15],
        "events": events,
        "watch": ranked(watch),
        "strong": ranked(strong),
    }


def markdown(w):
    L = [f"# สรุปสัปดาห์ {thd(w['week'][0])} – {thd(w['week'][1])} {int(w['week'][1][:4]) + 543}", "",
         f"_สร้างอัตโนมัติ {w['generated'].replace('T', ' ')} · {w['n']} หุ้น · ข้อมูลประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุน_", "",
         "## ภาพรวม", ""]
    bn, bp = w["breadth"]["now"], w["breadth"]["prev"]
    L.append("| แนวโน้ม | ตอนนี้ | 5 วันก่อน | เปลี่ยน |")
    L.append("|---|---:|---:|---:|")
    for k in ORDER:
        L.append(f"| {TH[k]} | {bn[k]} | {bp[k]} | {bn[k] - bp[k]:+d} |")
    a = w["above50"]
    L += ["", f"- หุ้นเหนือ MA50: **{a['now']}%** (สัปดาห์ก่อน {a['prev']}%)",
          f"- ขึ้น {w['up_count']} · ลง {w['down_count']} จาก {w['n']} ตัว · ค่ามัธยฐาน 1 สัปดาห์ {pct(w['median_r1w'])} · TDEX {pct(w['bench']['r1w'])}",
          f"- (บวก/ลบมากสุด นับเฉพาะ {w['movers_n']} ตัวที่ราคา ≥ {PENNY:g} บาท และซื้อขายเฉลี่ย ≥ {MIN_VALUE / 1e6:g} ล้านบาท/วัน)",
          "- บวกมากสุด: " + ", ".join(f"{x['symbol']} {pct(x['r1w'])}" for x in w["top"]),
          "- ลบมากสุด: " + ", ".join(f"{x['symbol']} {pct(x['r1w'])}" for x in w["bottom"]), ""]
    L += ["## ⚠️ ตัวที่ต้องระวัง", ""]
    L += [f"- **{x['symbol']}** ({TH.get(x['trend'], '–')}, 1W {pct(x['r1w'])}): " + " · ".join(x["reasons"]) for x in w["watch"]] or ["- ไม่มี"]
    L += ["", "## 💪 ตัวที่แข็งขึ้น", ""]
    L += [f"- **{x['symbol']}** ({TH.get(x['trend'], '–')}, 1W {pct(x['r1w'])}): " + " · ".join(x["reasons"]) for x in w["strong"]] or ["- ไม่มี"]
    L += ["", f"## 📅 สิทธิประโยชน์ {EVENT_DAYS} วันข้างหน้า", ""]
    if w["events"]:
        for e in w["events"]:
            d = (f"{e['amount']:g} บาท/หุ้น" if e.get("amount") else "") + (f" อัตรา {e['ratio']}" if e.get("ratio") else "") + \
                (f" ราคา {e['price']:g}" if e.get("price") else "") + (f" ประชุม {thd(e['meeting'])}" if e.get("meeting") else "")
            L.append(f"- {thd(e['xdate'])} **{e['symbol']}** {e['type']}{' (คาดจากปีก่อน)' if e.get('est') else ''} {d}".rstrip())
    else:
        L.append("- ไม่มี")
    L.append("")
    return "\n".join(L)


def main():
    w = build()
    (DATA / "weekly.json").write_text(json.dumps(w, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (DATA / "weekly.md").write_text(markdown(w), encoding="utf-8")
    print(f"weekly {w['week']}: watch {len(w['watch'])}, strong {len(w['strong'])}, events {len(w['events'])}")


if __name__ == "__main__":
    main()
