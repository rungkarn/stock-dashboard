"""Unit tests for the data scripts (stdlib unittest, no network).

    python -m unittest discover -s tests -v
"""
import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import fetch_prices as fp  # noqa: E402
import fetch_set_info as fs  # noqa: E402


def doc_from_closes(closes, start="2024-01-01", vol=1000):
    d0 = dt.date.fromisoformat(start)
    bars = [[(d0 + dt.timedelta(days=i)).isoformat(), c, c, c, c, vol] for i, c in enumerate(closes)]
    return {"symbol": "TEST", "name": "Test", "bars": bars}


class TestIndicators(unittest.TestCase):
    def test_sma(self):
        self.assertEqual(fp.sma([1, 2, 3, 4], 2), 3.5)
        self.assertIsNone(fp.sma([1], 2))
        self.assertEqual(fp.sma_at([1, 2, 3, 4], 2, 1), 2.5)

    def test_rsi_extremes(self):
        self.assertEqual(fp.rsi(list(range(1, 40))), 100.0)
        self.assertLess(fp.rsi(list(range(40, 1, -1))), 1)
        self.assertIsNone(fp.rsi([1, 2, 3]))

    def test_score_trend(self):
        up = [10 * 1.003 ** i for i in range(260)]
        down = [10 * 0.997 ** i for i in range(260)]
        self.assertEqual(fp.score_at(up), 6)
        self.assertEqual(fp.score_at(down), 0)
        self.assertEqual(fp.TREND_LABELS[fp.score_at(up)], "strong_up")

    def test_crossed(self):
        fast = [1, 1, 1, 3]
        slow = [2, 2, 2, 2]
        f = lambda k: fast[-1 - k]
        s = lambda k: slow[-1 - k]
        self.assertEqual(fp.crossed(f, s, 3), 1)
        self.assertEqual(fp.crossed(s, f, 3), -1)


class TestMetrics(unittest.TestCase):
    def test_uptrend_metrics(self):
        m = fp.metrics(doc_from_closes([10 * 1.003 ** i for i in range(300)]), bench_ret3m=0.0)
        self.assertEqual(m["trend"], "strong_up")
        self.assertGreater(m["r3m"], 0)
        self.assertEqual(m["rs3m"], m["r3m"])
        self.assertIn("high52", m["signals"])
        self.assertEqual(len(m["score_hist"]), fp.SCORE_HISTORY)
        self.assertAlmostEqual(m["pos52"], 100.0)

    def test_enter_uptrend_signal(self):
        # long decline then a sharp rally: trend label should flip into an uptrend recently
        closes = [20 * 0.996 ** i for i in range(250)] + [7.3 * 1.03 ** i for i in range(12)]
        m = fp.metrics(doc_from_closes(closes))
        self.assertIn(m["trend"], fp.UPTREND | {"side"})
        if m["trend"] in fp.UPTREND and m["trend_prev"] not in fp.UPTREND:
            self.assertIn("enter_up", m["signals"])

    def test_volume_spike(self):
        d = doc_from_closes([10.0] * 60)
        d["bars"][-1][5] = 5000
        self.assertIn("vol_spike", fp.metrics(d)["signals"])

    def test_short_history(self):
        m = fp.metrics(doc_from_closes([5.0, 5.5]))
        self.assertEqual(m["chg"], 10.0)
        self.assertIsNone(m["ma200"])
        self.assertIsNone(fp.metrics(doc_from_closes([5.0])))


class TestHelpers(unittest.TestCase):
    def test_reserved_windows_names(self):
        self.assertEqual(fp.price_path("COM7").name, "COM7_.json")
        self.assertEqual(fp.price_path("^SET50.BK").name, "_SET50.BK.json")
        self.assertEqual(fs.detail_path("CON").name, "CON_.json")

    def test_yahoo_ticker(self):
        self.assertEqual(fp.yahoo_ticker("WHA"), "WHA.BK")
        self.assertEqual(fp.yahoo_ticker("^SET50.BK"), "^SET50.BK")

    def test_to_bars_skips_nulls(self):
        res = {"meta": {"gmtoffset": 25200}, "timestamp": [1760000000, 1760086400],
               "indicators": {"quote": [{"open": [1, None], "high": [1, 2], "low": [1, 2], "close": [1, None], "volume": [5, 6]}]}}
        _, bars = fp.to_bars(res)
        self.assertEqual(len(bars), 1)


class TestDividends(unittest.TestCase):
    EVS = [
        {"type": "XD", "xdate": "2026-05-11", "amount": 0.14, "pay": "2026-05-28", "period": ["2025-01-01", "2025-12-31"]},
        {"type": "XD", "xdate": "2025-11-27", "amount": 0.07, "pay": "2025-12-12", "period": ["2025-01-01", "2025-09-30"]},
        {"type": "XD", "xdate": "2025-05-07", "amount": 0.12, "period": ["2024-01-01", "2024-12-31"]},
        {"type": "XR", "xdate": "2024-03-01", "ratio": "3 : 1", "price": 1.0},
    ]

    def test_div_by_year_uses_period_end(self):
        self.assertEqual(fs.div_by_year(self.EVS), {"2024": 0.12, "2025": 0.21})

    def test_projection_repeats_last_year(self):
        proj = fs.project_dividends(self.EVS, "2026-10-18")
        self.assertEqual([(e["xdate"], e["amount"], e["est"]) for e in proj],
                         [("2026-11-27", 0.07, True), ("2027-05-11", 0.14, True)])
        self.assertEqual(proj[0]["pay"], "2026-12-12")

    def test_projection_prefers_announced(self):
        evs = self.EVS + [{"type": "XD", "xdate": "2026-11-20", "amount": 0.09, "pay": "2026-12-05"}]
        proj = fs.project_dividends(evs, "2026-10-18")
        self.assertEqual([(e["xdate"], e["est"]) for e in proj], [("2026-11-20", False), ("2027-05-11", True)])

    def test_events_normalise(self):
        raw = [{"caType": "XR", "xdate": "2024-11-15T00:00:00+07:00", "ratio": "3 : 1", "price": 0.6,
                "rightsFor": "Common Stocks", "beginSubscription": "2024-12-09T00:00:00+07:00", "endSubscription": None}]
        e = fs.events(raw)[0]
        self.assertEqual(e["type"], "XR")
        self.assertEqual(e["xdate"], "2024-11-15")
        self.assertEqual(e["sub"], ["2024-12-09", None])


if __name__ == "__main__":
    unittest.main()
