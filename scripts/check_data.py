"""Sanity-check the generated data before it is committed / deployed.

Exit 1 on problems that would break or mislead the page (CI stops before committing);
warnings are printed but do not fail.

    python scripts/check_data.py
"""
import datetime as dt
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
errors, warnings = [], []


def load(rel):
    p = ROOT / rel
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError as e:
        errors.append(f"{rel}: invalid JSON ({e})")
        return None


def finite(x):
    return x is None or (isinstance(x, (int, float)) and math.isfinite(x))


cfg = load("symbols.json") or {}
symbols = set(cfg.get("holdings", [])) | set(cfg.get("watchlist", []))
summary = load("data/summary.json")
if not summary:
    errors.append("data/summary.json missing")
else:
    rows = summary.get("rows", [])
    if len(rows) < 0.8 * len(symbols):
        errors.append(f"summary has only {len(rows)} of {len(symbols)} symbols")
    as_of = summary.get("as_of")
    if as_of and (dt.date.today() - dt.date.fromisoformat(as_of)).days > 7:
        warnings.append(f"latest price is {as_of} (older than 7 days)")
    for r in rows:
        bad = [k for k, v in r.items() if isinstance(v, float) and not finite(v)]
        if bad:
            errors.append(f"{r['symbol']}: non-finite values in {bad}")
        if not r.get("close") or r["close"] <= 0:
            errors.append(f"{r['symbol']}: bad close {r.get('close')}")
        if r.get("chg") is not None and abs(r["chg"]) > 60:
            warnings.append(f"{r['symbol']}: 1-day change {r['chg']}% (XR / split / bad tick?)")
        if not (ROOT / "data" / "prices" / r["file"]).exists():
            errors.append(f"{r['symbol']}: price file {r['file']} missing")
    stale = [r["symbol"] for r in rows if as_of and r["date"] < as_of and
             (dt.date.fromisoformat(as_of) - dt.date.fromisoformat(r["date"])).days > 10]
    if stale:
        warnings.append(f"no trades for >10 days (suspended?): {stale}")

info = load("data/set_info.json")
if info:
    for sym, r in info.get("rows", {}).items():
        if not (ROOT / "data" / "set_info" / r["file"]).exists():
            errors.append(f"set_info {sym}: detail file missing")
        if r.get("yield") is not None and not 0 <= r["yield"] < 50:
            warnings.append(f"set_info {sym}: yield {r['yield']}")

for w in warnings:
    print("WARN ", w)
for e in errors:
    print("ERROR", e)
print(f"check_data: {len(errors)} error(s), {len(warnings)} warning(s)")
sys.exit(1 if errors else 0)
