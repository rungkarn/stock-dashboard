(() => {
  "use strict";

  const TRENDS = [
    { k: "strong_up", label: "ขาขึ้นแรง" },
    { k: "up", label: "ขาขึ้น" },
    { k: "side", label: "ทรงตัว" },
    { k: "down", label: "ขาลง" },
    { k: "strong_down", label: "ขาลงแรง" },
  ];
  const TREND_LABEL = Object.fromEntries(TRENDS.map((t) => [t.k, t.label]));
  const SIGNALS = [
    { k: "high52", label: "ทำจุดสูงสุดใหม่ 52 สัปดาห์", icon: "▲" },
    { k: "golden", label: "Golden cross (MA50 ตัดขึ้น MA200)", icon: "✕" },
    { k: "x_ma50_up", label: "ราคาตัดขึ้นเหนือ MA50 (3 วัน)", icon: "↗" },
    { k: "vol_spike", label: "Volume ≥ 2 เท่าของค่าเฉลี่ย", icon: "▮" },
    { k: "x_ma50_dn", label: "ราคาหลุด MA50 (3 วัน)", icon: "↘" },
    { k: "death", label: "Death cross (MA50 ตัดลง MA200)", icon: "✕" },
    { k: "low52", label: "ทำจุดต่ำสุดใหม่ 52 สัปดาห์", icon: "▼" },
  ];

  const $ = (s) => document.querySelector(s);
  const state = { rows: [], q: "", trend: null, group: "all", view: "table", sort: "score", asc: false, heatKey: "r1m" };
  let summary = null;

  // ---------- theme ----------
  const themeKey = "trendboard-theme";
  try {
    const t = localStorage.getItem(themeKey);
    if (t) document.documentElement.dataset.theme = t;
  } catch (e) {}
  $("#themeBtn").onclick = () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(themeKey, next); } catch (e) {}
    render();
    if (chartState.sym) openDetail(chartState.sym, true);
  };
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ---------- formatting ----------
  const nf = (d) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const priceFmt = (p) => p == null ? "–" : nf(p < 10 ? 2 : p < 100 ? 2 : 1).format(p);
  const pctFmt = (v, d = 1) => v == null ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + nf(d).format(Math.abs(v)) + "%";
  const cls = (v) => v == null || v === 0 ? "muted" : v > 0 ? "pos" : "neg";
  const big = (v) => v == null ? "–" : v >= 1e9 ? nf(2).format(v / 1e9) + " พันล." : v >= 1e6 ? nf(1).format(v / 1e6) + " ล." : v >= 1e3 ? nf(0).format(v / 1e3) + "K" : nf(0).format(v);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // diverging fill for a % value: gray midpoint → green / red pole, clamped at ±lim
  function heatBg(v, lim) {
    if (v == null) return "var(--surface-2)";
    const t = Math.min(Math.abs(v) / lim, 1);
    const pole = v >= 0 ? "var(--up)" : "var(--dn)";
    return `color-mix(in oklab, ${pole} ${Math.round(t * 70)}%, var(--neutral))`;
  }
  const HEAT_LIM = { chg: 5, r1w: 8, r1m: 15, r3m: 25, r6m: 35, ytd: 40, r1y: 50, vs_ma200: 25 };

  function spark(vals, w = 92, h = 26) {
    if (!vals || vals.length < 2) return "";
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 2 - ((v - lo) / span) * (h - 4)]);
    const last = pts[pts.length - 1];
    const up = vals[vals.length - 1] >= vals[0];
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polyline fill="none" stroke="var(--ink-2)" stroke-opacity=".55" stroke-width="1.5" stroke-linejoin="round" points="${pts.map((p) => p.map((x) => x.toFixed(1)).join(",")).join(" ")}"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="2.5" fill="${up ? "var(--up)" : "var(--dn)"}"/></svg>`;
  }

  function trendBadge(r) {
    const dots = Array.from({ length: 6 }, (_, i) => `<i class="${i < r.score ? "f" : ""}"></i>`).join("");
    return `<span class="badge" style="--c:var(--t-${r.trend})" title="คะแนน ${r.score}/6"><span class="dots">${dots}</span>${TREND_LABEL[r.trend]}</span>`;
  }

  // ---------- load ----------
  fetch("data/summary.json", { cache: "no-cache" })
    .then((r) => r.json())
    .then((s) => {
      summary = s;
      state.rows = s.rows;
      const d = new Date(s.as_of + "T00:00:00");
      $("#asof").textContent = `ราคาปิด ${d.toLocaleDateString("th-TH", { dateStyle: "long" })} · ${s.rows.length} หุ้น · อัปเดต ${s.generated.replace("T", " ")}` +
        (s.missing.length ? ` · ไม่มีข้อมูล: ${s.missing.join(", ")}` : "");
      buildTrendFilter();
      render();
      const h = decodeURIComponent(location.hash.slice(1));
      if (h && s.rows.some((r) => r.symbol === h)) openDetail(h);
    })
    .catch((e) => { $("#asof").textContent = "โหลดข้อมูลไม่สำเร็จ: " + e; });

  function buildTrendFilter() {
    $("#trendFilter").innerHTML = `<button data-v="" class="on">ทุกแนวโน้ม</button>` +
      TRENDS.map((t) => `<button data-v="${t.k}"><span class="sw" style="--c:var(--t-${t.k})"></span>${t.label}</button>`).join("");
  }

  // ---------- controls ----------
  function segHandler(id, fn) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      fn(b.dataset.v);
      render();
    });
  }
  segHandler("#trendFilter", (v) => (state.trend = v || null));
  segHandler("#groupFilter", (v) => (state.group = v));
  segHandler("#viewToggle", (v) => (state.view = v));
  $("#q").addEventListener("input", (e) => { state.q = e.target.value.trim().toUpperCase(); render(); });
  $("#heatPeriod").addEventListener("change", (e) => { state.heatKey = e.target.value; render(); });
  $("#tbl thead").addEventListener("click", (e) => {
    const th = e.target.closest("th");
    if (!th || th.classList.contains("nosort")) return;
    const k = th.dataset.k;
    if (state.sort === k) state.asc = !state.asc;
    else { state.sort = k; state.asc = k === "symbol"; }
    render();
  });
  function setTrend(k) {
    state.trend = state.trend === k ? null : k;
    $("#trendFilter").querySelectorAll("button").forEach((b) => b.classList.toggle("on", (b.dataset.v || null) === state.trend));
    render();
    $("#tbl").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function filtered() {
    return state.rows.filter((r) =>
      (!state.q || r.symbol.includes(state.q) || (r.name || "").toUpperCase().includes(state.q)) &&
      (!state.trend || r.trend === state.trend) &&
      (state.group === "all" || r.group === state.group));
  }

  // ---------- render ----------
  function render() {
    if (!summary) return;
    renderOverview();
    renderSignals();
    const rows = filtered();
    const k = state.sort, dir = state.asc ? 1 : -1;
    rows.sort((a, b) => {
      const x = a[k], y = b[k];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (k === "score" && x === y) return dir * ((a.vs_ma200 ?? -999) - (b.vs_ma200 ?? -999));
      return typeof x === "string" ? dir * x.localeCompare(y) : dir * (x - y);
    });
    $("#empty").hidden = rows.length > 0;
    $("#tableView").hidden = state.view !== "table";
    $("#heatView").hidden = state.view !== "heat";
    $("#heatPeriodWrap").hidden = state.view !== "heat";
    if (state.view === "table") renderTable(rows); else renderHeat(rows);
  }

  function renderOverview() {
    const rows = state.rows;
    const n = rows.length;
    const counts = Object.fromEntries(TRENDS.map((t) => [t.k, rows.filter((r) => r.trend === t.k).length]));
    $("#breadthCount").textContent = `${n} หุ้น`;
    $("#breadthBar").setAttribute("aria-label", TRENDS.map((t) => `${t.label} ${counts[t.k]}`).join(", "));
    $("#breadthBar").innerHTML = TRENDS.filter((t) => counts[t.k]).map((t) =>
      `<div data-k="${t.k}" class="${t.k === "strong_up" || t.k === "strong_down" ? "dark-ink" : ""}" style="flex:${counts[t.k]};background:var(--t-${t.k})" title="${t.label}: ${counts[t.k]} หุ้น">${counts[t.k] / n > 0.06 ? counts[t.k] : ""}</div>`).join("");
    $("#breadthBar").onclick = (e) => { const d = e.target.closest("[data-k]"); if (d) setTrend(d.dataset.k); };
    $("#breadthLegend").innerHTML = TRENDS.map((t) =>
      `<li><span class="sw" style="--c:var(--t-${t.k})"></span>${t.label} <b>${counts[t.k]}</b></li>`).join("");

    const above = (key) => {
      const have = rows.filter((r) => r[key] != null);
      return have.length ? Math.round(have.filter((r) => r.close > r[key]).length / have.length * 100) : null;
    };
    const med = (key) => {
      const v = rows.map((r) => r[key]).filter((x) => x != null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    };
    const b = summary.benchmark;
    const tiles = [
      { k: "เหนือ MA50", v: above("ma50") + "%", s: "ของหุ้นทั้งหมด (ระยะกลาง)" },
      { k: "เหนือ MA200", v: above("ma200") + "%", s: "ของหุ้นทั้งหมด (ระยะยาว)" },
      { k: "ชนะตลาด 3M", v: rows.filter((r) => r.rs3m > 0).length + "", s: `ตลาด (TDEX) 3M ${pctFmt(b && b.r3m)}` },
      { k: "ค่ามัธยฐาน 1M", v: `<span class="${cls(med("r1m"))}">${pctFmt(med("r1m"))}</span>`, s: "ผลตอบแทนหุ้นกลางพอร์ต" },
      { k: "New high / low 52W", v: `<span class="pos">${rows.filter((r) => r.signals.includes("high52")).length}</span> / <span class="neg">${rows.filter((r) => r.signals.includes("low52")).length}</span>`, s: "จำนวนหุ้นวันล่าสุด" },
      { k: "ตลาด TDEX (SET50)", v: b ? priceFmt(b.close) : "–", s: b ? `${pctFmt(b.chg)} วันนี้ · ${TREND_LABEL[b.trend]}` : "" },
    ];
    $("#tiles").innerHTML = tiles.map((t) => `<div class="tile"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="s">${t.s}</div></div>`).join("");
  }

  function renderSignals() {
    const rows = filtered();
    $("#signals").innerHTML = SIGNALS.map((s) => {
      const hits = rows.filter((r) => r.signals.includes(s.k))
        .sort((a, b) => s.k === "vol_spike" ? b.vol_ratio - a.vol_ratio : (b.chg ?? 0) - (a.chg ?? 0));
      const chips = hits.map((r) => {
        const extra = s.k === "vol_spike" ? `${nf(1).format(r.vol_ratio)}×` : pctFmt(r.chg);
        const c = s.k === "vol_spike" ? "" : cls(r.chg);
        return `<button class="chip" data-sym="${esc(r.symbol)}">${esc(r.symbol)}<small class="${c}">${extra}</small></button>`;
      }).join("");
      return `<div class="sig"><h3><span aria-hidden="true">${s.icon}</span>${s.label} <span class="hint">${hits.length}</span></h3>
        <div class="chips">${chips || `<span class="none">ไม่มี</span>`}</div></div>`;
    }).join("");
  }
  $("#signals").addEventListener("click", (e) => { const b = e.target.closest("[data-sym]"); if (b) openDetail(b.dataset.sym); });

  function renderTable(rows) {
    document.querySelectorAll("#tbl th").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.k === state.sort && !th.classList.contains("nosort"));
      th.classList.toggle("asc", state.asc);
    });
    const ret = (v, lim) => `<td class="ret" style="background:${heatBg(v, lim)}">${pctFmt(v)}</td>`;
    $("#tbl tbody").innerHTML = rows.map((r) => `<tr data-sym="${esc(r.symbol)}">
      <td class="sym l"><b>${esc(r.symbol)}</b>${r.group === "watch" ? '<span class="w">watch</span>' : ""}</td>
      <td>${spark(r.spark)}</td>
      <td>${priceFmt(r.close)}</td>
      <td class="${cls(r.chg)}">${pctFmt(r.chg)}</td>
      ${ret(r.r1w, 8)}${ret(r.r1m, 15)}${ret(r.r3m, 25)}${ret(r.r1y, 50)}
      <td class="l">${trendBadge(r)}</td>
      <td class="${cls(r.vs_ma200)}">${pctFmt(r.vs_ma200)}</td>
      <td class="l">${r.pos52 == null ? "–" : `<span class="r52"><span class="range52" title="ต่ำสุด ${priceFmt(r.lo52)} · สูงสุด ${priceFmt(r.hi52)}"><i style="left:${r.pos52}%"></i></span><small>${Math.round(r.pos52)}%</small></span>`}</td>
      <td class="${r.vol_ratio >= 2 ? "" : "muted"}">${r.vol_ratio == null ? "–" : (r.vol_ratio >= 2 ? "<b>" : "") + nf(1).format(r.vol_ratio) + "×" + (r.vol_ratio >= 2 ? "</b>" : "")}</td>
      <td class="${r.rsi >= 70 || r.rsi <= 30 ? "" : "muted"}">${r.rsi == null ? "–" : Math.round(r.rsi)}</td>
      <td class="${cls(r.rs3m)}">${pctFmt(r.rs3m)}</td>
    </tr>`).join("");
  }
  $("#tbl tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-sym]"); if (tr) openDetail(tr.dataset.sym); });

  function renderHeat(rows) {
    const k = state.heatKey, lim = HEAT_LIM[k];
    const sorted = [...rows].sort((a, b) => (b[k] ?? -1e9) - (a[k] ?? -1e9));
    $("#heatView").innerHTML = sorted.map((r) =>
      `<div class="cell" data-sym="${esc(r.symbol)}" style="background:${heatBg(r[k], lim)}" title="${esc(r.name)}"><b>${esc(r.symbol)}</b><span>${pctFmt(r[k])}</span></div>`).join("");
  }
  $("#heatView").addEventListener("click", (e) => { const c = e.target.closest("[data-sym]"); if (c) openDetail(c.dataset.sym); });

  // ---------- detail ----------
  const chartState = { sym: null, chart: null, range: 252, bars: null };
  const cache = {};

  function smaSeries(bars, n) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i][4];
      if (i >= n) sum -= bars[i - n][4];
      if (i >= n - 1) out.push({ time: bars[i][0], value: sum / n });
    }
    return out;
  }

  async function openDetail(sym, keepRange) {
    const r = state.rows.find((x) => x.symbol === sym);
    if (!r) return;
    chartState.sym = sym;
    history.replaceState(null, "", "#" + encodeURIComponent(sym));
    $("#drawer").hidden = false;
    document.body.style.overflow = "hidden";
    $("#dTitle").textContent = sym;
    $("#dName").textContent = r.name;
    $("#dPrice").innerHTML = `<span class="big">${priceFmt(r.close)}</span><span class="${cls(r.chg)}">${pctFmt(r.chg, 2)}</span>${trendBadge(r)}<span class="hint">${r.date}</span>`;
    const stats = [
      ["1 สัปดาห์", pctFmt(r.r1w), cls(r.r1w)], ["1 เดือน", pctFmt(r.r1m), cls(r.r1m)],
      ["3 เดือน", pctFmt(r.r3m), cls(r.r3m)], ["6 เดือน", pctFmt(r.r6m), cls(r.r6m)],
      ["YTD", pctFmt(r.ytd), cls(r.ytd)], ["1 ปี", pctFmt(r.r1y), cls(r.r1y)],
      ["MA20", priceFmt(r.ma20)], ["MA50", priceFmt(r.ma50)], ["MA200", priceFmt(r.ma200)],
      ["ห่าง MA200", pctFmt(r.vs_ma200), cls(r.vs_ma200)], ["ความชัน MA50 (10 วัน)", pctFmt(r.ma50_slope, 2), cls(r.ma50_slope)],
      ["52W ต่ำ – สูง", `${priceFmt(r.lo52)} – ${priceFmt(r.hi52)}`],
      ["RSI 14", r.rsi == null ? "–" : nf(0).format(r.rsi)], ["Vol วันล่าสุด", big(r.vol)],
      ["Vol / เฉลี่ย 20 วัน", r.vol_ratio == null ? "–" : nf(2).format(r.vol_ratio) + "×"],
      ["มูลค่าซื้อขายเฉลี่ย 20 วัน", big(r.value20) + " บาท"], ["เทียบตลาด 3M", pctFmt(r.rs3m), cls(r.rs3m)],
    ];
    $("#dStats").innerHTML = stats.map(([k, v, c]) => `<div><div class="k">${k}</div><div class="v ${c || ""}">${v}</div></div>`).join("");
    if (!keepRange) {
      chartState.range = 252;
      $("#rangeSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === "252"));
    }
    try {
      cache[sym] = cache[sym] || await fetch("data/prices/" + r.file, { cache: "no-cache" }).then((x) => x.json());
    } catch (e) {
      $("#ohlc").textContent = "โหลดกราฟไม่สำเร็จ";
      return;
    }
    if (chartState.sym !== sym) return;
    drawChart(cache[sym].bars);
  }

  function closeDetail() {
    $("#drawer").hidden = true;
    document.body.style.overflow = "";
    chartState.sym = null;
    history.replaceState(null, "", location.pathname + location.search);
  }
  $("#drawer").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDetail(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").hidden) closeDetail(); });
  $("#rangeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $("#rangeSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    chartState.range = +b.dataset.v;
    if (chartState.bars) fitRange();
  });

  function fitRange() {
    const bars = chartState.bars;
    const from = Math.max(0, bars.length - chartState.range);
    chartState.chart.timeScale().setVisibleRange({ from: bars[from][0], to: bars[bars.length - 1][0] });
  }

  function drawChart(bars) {
    const el = $("#chart");
    if (chartState.chart) { chartState.chart.remove(); chartState.chart = null; }
    el.innerHTML = "";
    chartState.bars = bars;
    const grid = css("--grid"), up = css("--up"), dn = css("--dn");
    const chart = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: css("--muted"), fontFamily: css("--font"), fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.26 } },
      timeScale: { borderVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      localization: { locale: "en-GB" },
    });
    chartState.chart = chart;
    const candle = chart.addCandlestickSeries({
      upColor: up, downColor: dn, borderVisible: false, wickUpColor: up, wickDownColor: dn,
      priceLineVisible: false,
    });
    candle.setData(bars.map((b) => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] })));
    for (const [n, v] of [[20, "--ma20"], [50, "--ma50"], [200, "--ma200"]]) {
      const s = chart.addLineSeries({ color: css(v), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(smaSeries(bars, n));
    }
    const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    vol.setData(bars.map((b, i) => ({ time: b[0], value: b[5], color: b[4] >= (i ? bars[i - 1][4] : b[1]) ? hexA(up, 0.45) : hexA(dn, 0.45) })));
    fitRange();

    const idx = Object.fromEntries(bars.map((b, i) => [b[0], i]));
    const legend = (t) => {
      const i = t != null && idx[t] != null ? idx[t] : bars.length - 1;
      const b = bars[i], prev = i ? bars[i - 1][4] : b[1];
      const ma = (n) => priceFmt(maAt(bars, i, n));
      $("#ohlc").innerHTML = `<span>${b[0]}</span><span>O <b>${priceFmt(b[1])}</b></span><span>H <b>${priceFmt(b[2])}</b></span><span>L <b>${priceFmt(b[3])}</b></span><span>C <b>${priceFmt(b[4])}</b> <span class="${cls(b[4] - prev)}">${pctFmt((b[4] / prev - 1) * 100, 2)}</span></span><span>Vol <b>${big(b[5])}</b></span><span>MA20 <b>${ma(20)}</b></span><span>MA50 <b>${ma(50)}</b></span><span>MA200 <b>${ma(200)}</b></span>`;
    };
    chart.subscribeCrosshairMove((p) => legend(p && p.time));
    legend(null);
  }

  function maAt(bars, i, n) {
    if (i < n - 1) return null;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += bars[j][4];
    return s / n;
  }

  function hexA(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
})();
