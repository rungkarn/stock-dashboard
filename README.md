# Stock Trend Board

Dashboard แนวโน้มหุ้นที่ถือ (GitHub Pages) — ราคาปิด/ปริมาณรายวันจาก Yahoo Finance (`<SYM>.BK`)
อัปเดตเองทุก จ.–ศ. 18:15 น. (เวลาไทย) ด้วย GitHub Actions

> repo นี้ **public** — มีแค่ชื่อหุ้นกับราคาตลาด **ห้ามใส่** จำนวนหุ้น ต้นทุน กำไร/ขาดทุน หรือข้อมูลบัญชี
> (ของพวกนั้นอยู่ใน repo private `rungkarn/stock`)

## ส่วนประกอบ
| ไฟล์ | ทำอะไร |
|---|---|
| `symbols.json` | รายชื่อหุ้น (holdings + watchlist) |
| `scripts/sync_symbols.py` | สร้าง `symbols.json` จาก repo private (`data/portfolio_dividend.json`, `data/watchlist.json`) — ดึงแค่ชื่อหุ้น |
| `scripts/fetch_prices.py` | ดึง OHLCV → `data/prices/*.json` (เก็บ ~3 ปี) แล้วคำนวณ `data/summary.json` (MA20/50/200, คะแนนแนวโน้ม, ผลตอบแทน, 52W, RSI, volume ratio, สัญญาณ) |
| `.github/workflows/update.yml` | cron จ.–ศ. → fetch → commit data → deploy Pages |
| `index.html`, `assets/` | หน้า dashboard (static, ไม่มี build) |

## เมื่อพอร์ตเปลี่ยน (ซื้อตัวใหม่/ขายหมด)
```bash
python scripts/sync_symbols.py "D:/oneDrive/OneDrive - NSTDA/Projects/stock"
python scripts/fetch_prices.py
git add -A && git commit -m "update symbols" && git push
```
(หรือ push แค่ `symbols.json` แล้วกด **Actions → Update prices & deploy → Run workflow**)

## รันเอง / ดูในเครื่อง
```bash
pip install requests
python scripts/fetch_prices.py          # incremental
python scripts/fetch_prices.py --full   # ดึงใหม่ 2 ปี
python -m http.server 8765              # แล้วเปิด http://localhost:8765
```

## หมายเหตุ
- set.or.th บล็อก IP ของ cloud/GitHub เลยใช้ Yahoo; ตัวเทียบตลาดคือ **TDEX** (ETF อิง SET50) เพราะ Yahoo ไม่มีประวัติดัชนี SET
- หุ้นที่ Yahoo ไม่มีข้อมูล (warrant, ตัวที่ถูก SP) จะขึ้นใน "ไม่มีข้อมูล" บนหัวหน้า
- GitHub อาจเลื่อนเวลา cron ได้ 10–60 นาทีช่วงคนใช้เยอะ; วันหยุดตลาดไม่มีแท่งใหม่ก็จะไม่ commit
- ข้อมูลประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุน
