"""Rebuild symbols.json from the PRIVATE stock repo — symbols only.

Shares, cost, P/L and account data are never copied: this repo is public.
NVDR (-R) positions are merged into their underlying (same price on Yahoo).

    python scripts/sync_symbols.py "D:/oneDrive/OneDrive - NSTDA/Projects/stock"
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main(private_repo):
    src = Path(private_repo) / "data"
    port = json.loads((src / "portfolio_dividend.json").read_text(encoding="utf-8"))
    holdings = sorted({r["base"].strip() for r in port["rows"] if r.get("base")})
    wl_path = src / "watchlist.json"
    watch = json.loads(wl_path.read_text(encoding="utf-8")) if wl_path.exists() else []
    watch = sorted({s.strip() for s in watch} - set(holdings))

    out = ROOT / "symbols.json"
    old = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    doc = {"holdings": holdings, "watchlist": watch}
    out.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    added = set(holdings + watch) - set(old.get("holdings", []) + old.get("watchlist", []))
    removed = set(old.get("holdings", []) + old.get("watchlist", [])) - set(holdings + watch)
    print(f"{len(holdings)} holdings, {len(watch)} watchlist  +{sorted(added)}  -{sorted(removed)}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ROOT.parent / "stock")
