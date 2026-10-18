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
  // corporate-action types: short chart letter + Thai label + colour slot
  const CA = {
    "XD": { m: "D", label: "XD ปันผล", c: "--ca-xd" },
    "XD(ST)": { m: "S", label: "XD ปันผลเป็นหุ้น", c: "--ca-xb" },
    "XR": { m: "R", label: "XR สิทธิจองหุ้นเพิ่มทุน", c: "--ca-xr" },
    "XW": { m: "W", label: "XW ได้วอร์แรนต์", c: "--ca-xw" },
    "XB": { m: "B", label: "XB สิทธิอื่น", c: "--ca-xb" },
    "XT": { m: "T", label: "XT สิทธิ TSR", c: "--ca-xb" },
    "XM": { m: "M", label: "XM ประชุมผู้ถือหุ้น", c: "--ca-xm" },
  };
  const caInfo = (t) => CA[t] || { m: (t || "?").slice(1, 2), label: t, c: "--ca-xb" };

  const $ = (s) => document.querySelector(s);
  const state = { rows: [], q: "", trend: null, group: "all", sector: "", view: "table", sort: "score", asc: false, heatKey: "r1m", bySector: false };
  let summary = null, setInfo = null, baseRows = [];

  // ---------- private portfolio (browser-only; never sent anywhere) ----------
  const PORT_KEY = "trendboard-portfolio";
  let port = null; // {loaded, source, pos: {SYM: {shares, cost}}}
  try { port = JSON.parse(localStorage.getItem(PORT_KEY) || "null"); } catch (e) { port = null; }

  function parsePortfolio(j) {
    const pos = {};
    const add = (sym, shares, cost) => {
      if (!sym || !(shares > 0)) return;
      const p = pos[sym] || (pos[sym] = { shares: 0, amount: 0 });
      p.shares += shares;
      p.amount += shares * (cost || 0);
    };
    if (j && Array.isArray(j.rows)) {
      // data/portfolio_dividend.json — one row per underlying, NVDR already merged
      j.rows.forEach((r) => add(String(r.base || r.Symbol || "").trim().split(/\s/)[0], +r.Shares, +r.Cost));
    } else if (j && typeof j === "object") {
      // portfolio_data.json — {SYM | SYM-R: {volume, avg_cost}}
      Object.entries(j).forEach(([k, v]) => {
        if (!v || typeof v !== "object" || !("volume" in v)) return;
        add(k.replace(/-R$/, ""), +v.volume, +v.avg_cost);
      });
    }
    const out = {};
    Object.entries(pos).forEach(([k, p]) => { out[k] = { shares: p.shares, cost: p.amount / p.shares }; });
    return out;
  }

  function withPort(rows) {
    const pos = port && port.pos;
    const out = rows.map((r) => {
      const p = pos && pos[r.symbol];
      if (!p) return { ...r, p: null, p_cost: null, p_pl: null, p_value: null, p_weight: null, p_yoc: null, p_income: null };
      return {
        ...r, p,
        p_cost: p.cost || null,
        p_pl: p.cost ? (r.close / p.cost - 1) * 100 : null,
        p_value: r.close * p.shares,
        p_yoc: r.f_divlast && p.cost ? r.f_divlast / p.cost * 100 : null,
        p_income: r.f_divlast ? r.f_divlast * p.shares : null,
      };
    });
    const total = out.reduce((a, r) => a + (r.p_value || 0), 0);
    out.forEach((r) => { r.p_weight = r.p_value && total ? r.p_value / total * 100 : null; });
    return out;
  }

  function applyPort() {
    state.rows = withPort(baseRows);
    const on = !!(port && port.pos && Object.keys(port.pos).length);
    document.body.classList.toggle("has-port", on);
    $("#portBtnText").textContent = on ? `พอร์ตส่วนตัว (${Object.keys(port.pos).length})` : "พอร์ตส่วนตัว";
    document.querySelectorAll(".popt").forEach((o) => (o.disabled = !on));
    if (!on && state.heatKey.startsWith("p_")) { state.heatKey = "r1m"; $("#heatPeriod").value = "r1m"; }
    if (!on && state.sort.startsWith("p_")) { state.sort = "score"; state.asc = false; }
    const matched = on ? state.rows.filter((r) => r.p).length : 0;
    $("#portStatus").textContent = on
      ? `โหลดแล้ว ${Object.keys(port.pos).length} หุ้น จากไฟล์ ${port.source} (${port.loaded}) · ตรงกับหุ้นที่มีกราฟใน dashboard ${matched} ตัว`
      : "ยังไม่ได้โหลดข้อมูล";
  }

  $("#portBtn").onclick = () => { $("#portDlg").hidden = false; };
  $("#portDlg").addEventListener("click", (e) => { if (e.target.closest("[data-pclose]")) $("#portDlg").hidden = true; });
  $("#portFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const pos = parsePortfolio(JSON.parse(await file.text()));
      if (!Object.keys(pos).length) throw new Error("ไม่พบรายการหุ้นในไฟล์นี้");
      port = { pos, source: file.name, loaded: new Date().toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) };
      try { localStorage.setItem(PORT_KEY, JSON.stringify(port)); } catch (err) {}
      applyPort();
      render();
    } catch (err) {
      $("#portStatus").textContent = "อ่านไฟล์ไม่ได้: " + err.message;
    }
  });
  $("#portClear").onclick = () => {
    port = null;
    try { localStorage.removeItem(PORT_KEY); } catch (e) {}
    applyPort();
    render();
  };

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
  const priceFmt = (p) => p == null ? "–" : nf(p < 100 ? 2 : 1).format(p);
  const pctFmt = (v, d = 1) => v == null ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + nf(d).format(Math.abs(v)) + "%";
  const plainPct = (v, d = 1) => v == null ? "–" : nf(d).format(v) + "%";
  const num = (v, d = 2) => v == null ? "–" : nf(d).format(v);
  const divFmt = (v) => v == null ? "–" : nf(v < 0.1 ? 4 : v < 1 ? 3 : 2).format(v);
  const cls = (v) => v == null || v === 0 ? "muted" : v > 0 ? "pos" : "neg";
  const big = (v) => v == null ? "–" : Math.abs(v) >= 1e9 ? nf(2).format(v / 1e9) + " พันล." : Math.abs(v) >= 1e6 ? nf(1).format(v / 1e6) + " ล." : Math.abs(v) >= 1e3 ? nf(0).format(v / 1e3) + "K" : nf(0).format(v);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const thDate = (iso, opt = { day: "numeric", month: "short", year: "2-digit" }) =>
    iso ? new Date(iso + "T00:00:00").toLocaleDateString("th-TH", opt) : "–";

  // diverging fill for a % value: gray midpoint → green / red pole, clamped at ±lim
  function heatBg(v, lim) {
    if (v == null) return "var(--surface-2)";
    const t = Math.min(Math.abs(v) / lim, 1);
    const pole = v >= 0 ? "var(--up)" : "var(--dn)";
    return `color-mix(in oklab, ${pole} ${Math.round(t * 70)}%, var(--neutral))`;
  }
  // sequential fill (one hue) for non-negative magnitudes such as yield
  function seqBg(v, lim) {
    if (v == null) return "var(--surface-2)";
    return `color-mix(in oklab, var(--seq) ${Math.round(Math.min(v / lim, 1) * 75)}%, var(--neutral))`;
  }
  const HEAT_LIM = { p_pl: 50, chg: 5, r1w: 8, r1m: 15, r3m: 25, r6m: 35, ytd: 40, r1y: 50, vs_ma200: 25, f_yield: 8 };

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

  // mini bar chart of dividend per year (last 6 fiscal years); current year drawn lighter (incomplete)
  const THIS_YEAR = String(new Date().getFullYear());
  function divBars(divs, w = 104, h = 24) {
    const years = [];
    for (let y = +THIS_YEAR - 5; y <= +THIS_YEAR; y++) years.push(String(y));
    const vals = years.map((y) => (divs && divs[y]) || 0);
    const max = Math.max(...vals);
    if (!max) return `<span class="muted">ไม่จ่าย</span>`;
    const bw = w / years.length;
    const bars = years.map((y, i) => {
      const v = vals[i];
      if (!v) return `<rect x="${i * bw + 2}" y="${h - 1}" width="${bw - 4}" height="1" fill="var(--axis)"/>`;
      const bh = Math.max(2, (v / max) * (h - 2));
      return `<rect x="${i * bw + 2}" y="${h - bh}" width="${bw - 4}" height="${bh}" rx="1.5" fill="var(--seq)" fill-opacity="${y === THIS_YEAR ? 0.4 : 1}"><title>${y}: ${divFmt(v)} บาท${y === THIS_YEAR ? " (ยังไม่ครบปี)" : ""}</title></rect>`;
    }).join("");
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="ปันผลรายปี ${years.map((y, i) => `${y} ${divFmt(vals[i])}`).join(", ")}">${bars}</svg>`;
  }

  function trendBadge(r) {
    if (!r.trend) return "–";
    const dots = Array.from({ length: 6 }, (_, i) => `<i class="${i < r.score ? "f" : ""}"></i>`).join("");
    return `<span class="badge" style="--c:var(--t-${r.trend})" title="คะแนน ${r.score}/6"><span class="dots">${dots}</span>${TREND_LABEL[r.trend]}</span>`;
  }
  const caTag = (t, extra = "") => {
    const c = caInfo(t);
    return `<span class="ca" style="--c:var(${c.c})" title="${esc(c.label)}">${esc(t)}</span>${extra}`;
  };
  const idxTag = (f) => f && f.set50 ? `<span class="ix">SET50</span>` : f && f.set100 ? `<span class="ix">SET100</span>` : "";

  // ---------- load ----------
  Promise.all([
    fetch("data/summary.json", { cache: "no-cache" }).then((r) => r.json()),
    fetch("data/set_info.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]).then(([s, info]) => {
    summary = s;
    setInfo = info;
    baseRows = s.rows.map((r) => withFund(r, info && info.rows[r.symbol]));
    applyPort();
    const d = new Date(s.as_of + "T00:00:00");
    $("#asof").textContent = `ราคาปิด ${d.toLocaleDateString("th-TH", { dateStyle: "long" })} · ${s.rows.length} หุ้น · อัปเดตราคา ${s.generated.replace("T", " ")}` +
      (info ? ` · ข้อมูล SET ${info.generated.replace("T", " ")}` : "") +
      (s.missing.length ? ` · ไม่มีกราฟราคา: ${s.missing.join(", ")}` : "");
    buildTrendFilter();
    buildSectorFilter();
    render();
    const h = decodeURIComponent(location.hash.slice(1));
    if (h && state.rows.some((r) => r.symbol === h)) openDetail(h);
  }).catch((e) => { $("#asof").textContent = "โหลดข้อมูลไม่สำเร็จ: " + e; });

  // flatten SET info into sortable f_* fields
  function withFund(r, f) {
    if (!f) return { ...r, f: null };
    const lastFull = String(+THIS_YEAR - 1);
    const lastYearDiv = f.divs && (f.divs[lastFull] ?? null);
    return {
      ...r, f,
      f_yield: f.yield,
      f_divlast: lastYearDiv,
      f_divyield_calc: lastYearDiv && r.close ? lastYearDiv / r.close * 100 : null,
      f_streak: f.div_streak,
      f_payout: f.payout,
      f_pe: f.pe,
      f_pbv: f.pbv,
      f_roe: f.roe,
      f_growth: f.profit_growth,
      f_lastxd: f.last_xd ? f.last_xd.xdate : null,
      f_caps: f.caps_3y ? f.caps_3y.length : 0,
      f_mcap: f.mcap,
      f_sector: f.sector || "",
    };
  }

  function buildTrendFilter() {
    $("#trendFilter").innerHTML = `<button data-v="" class="on">ทุกแนวโน้ม</button>` +
      TRENDS.map((t) => `<button data-v="${t.k}"><span class="sw" style="--c:var(--t-${t.k})"></span>${t.label}</button>`).join("");
  }
  function buildSectorFilter() {
    const counts = {};
    state.rows.forEach((r) => { if (r.f_sector) counts[r.f_sector] = (counts[r.f_sector] || 0) + 1; });
    const sel = $("#sectorFilter");
    sel.hidden = !Object.keys(counts).length;
    sel.innerHTML = `<option value="">ทุกกลุ่มอุตสาหกรรม</option>` + Object.keys(counts).sort().map((k) =>
      `<option value="${esc(k)}">${esc(k)} (${counts[k]})</option>`).join("");
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
  segHandler("#viewToggle", (v) => {
    state.view = v;
    if (v === "fund" && !state.sort.startsWith("f_") && !["symbol", "close", "score"].includes(state.sort)) { state.sort = "f_yield"; state.asc = false; }
    if (v === "table" && state.sort.startsWith("f_")) { state.sort = "score"; state.asc = false; }
  });
  $("#sectorFilter").addEventListener("change", (e) => { state.sector = e.target.value; render(); });
  $("#q").addEventListener("input", (e) => { state.q = e.target.value.trim().toUpperCase(); render(); });
  $("#heatPeriod").addEventListener("change", (e) => { state.heatKey = e.target.value; render(); });
  $("#heatBySector").addEventListener("change", (e) => { state.bySector = e.target.checked; render(); });
  for (const id of ["#tbl", "#ftbl"]) {
    $(id + " thead").addEventListener("click", (e) => {
      const th = e.target.closest("th");
      if (!th || th.classList.contains("nosort")) return;
      const k = th.dataset.k;
      if (state.sort === k) state.asc = !state.asc;
      else { state.sort = k; state.asc = k === "symbol" || k === "f_sector" || k === "f_pe" || k === "f_pbv"; }
      render();
    });
  }
  function setTrend(k) {
    state.trend = state.trend === k ? null : k;
    $("#trendFilter").querySelectorAll("button").forEach((b) => b.classList.toggle("on", (b.dataset.v || null) === state.trend));
    render();
    $("#q").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function filtered() {
    return state.rows.filter((r) =>
      (!state.q || r.symbol.includes(state.q) || (r.name || "").toUpperCase().includes(state.q)) &&
      (!state.trend || r.trend === state.trend) &&
      (!state.sector || r.f_sector === state.sector) &&
      (state.group === "all" || r.group === state.group));
  }

  // ---------- render ----------
  function render() {
    if (!summary) return;
    renderOverview();
    renderSignals();
    renderCalendar();
    const rows = filtered();
    const k = state.sort, dir = state.asc ? 1 : -1;
    rows.sort((a, b) => {
      const x = a[k], y = b[k];
      if (x == null && y == null) return 0;
      if (x == null || x === "") return 1;
      if (y == null || y === "") return -1;
      if (k === "score" && x === y) return dir * ((a.vs_ma200 ?? -999) - (b.vs_ma200 ?? -999));
      return typeof x === "string" ? dir * x.localeCompare(y) : dir * (x - y);
    });
    $("#empty").hidden = rows.length > 0;
    $("#tableView").hidden = state.view !== "table";
    $("#fundView").hidden = state.view !== "fund";
    $("#heatView").hidden = state.view !== "heat";
    $("#heatPeriodWrap").hidden = state.view !== "heat";
    if (state.view === "table") renderTable(rows);
    else if (state.view === "fund") renderFund(rows);
    else renderHeat(rows);
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
    let vb = $("#breadthValue");
    if (!vb) {
      vb = document.createElement("div");
      vb.id = "breadthValue";
      $("#breadthLegend").after(vb);
    }
    const held = rows.filter((r) => r.p_value);
    if (!held.length) vb.innerHTML = "";
    else {
      const tot = held.reduce((a, r) => a + r.p_value, 0);
      const vals = Object.fromEntries(TRENDS.map((t) => [t.k, held.filter((r) => r.trend === t.k).reduce((a, r) => a + r.p_value, 0)]));
      vb.innerHTML = `<div class="card-h vb-h"><h2>ตามมูลค่าที่ถือ</h2><span class="hint">🔒 ${big(tot)} บาท</span></div>
        <div class="stack" role="img" aria-label="${TRENDS.map((t) => `${t.label} ${Math.round(vals[t.k] / tot * 100)}%`).join(", ")}">${TRENDS.filter((t) => vals[t.k]).map((t) =>
          `<div data-k="${t.k}" class="${t.k === "strong_up" || t.k === "strong_down" ? "dark-ink" : ""}" style="flex:${vals[t.k]};background:var(--t-${t.k})" title="${t.label}: ${big(vals[t.k])} บาท (${nf(1).format(vals[t.k] / tot * 100)}%)">${vals[t.k] / tot > 0.07 ? Math.round(vals[t.k] / tot * 100) + "%" : ""}</div>`).join("")}</div>`;
      vb.querySelector(".stack").onclick = (e) => { const d = e.target.closest("[data-k]"); if (d) setTrend(d.dataset.k); };
    }

    const above = (key) => {
      const have = rows.filter((r) => r[key] != null);
      return have.length ? Math.round(have.filter((r) => r.close > r[key]).length / have.length * 100) : null;
    };
    const med = (key) => {
      const v = rows.map((r) => r[key]).filter((x) => x != null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    };
    const b = summary.benchmark;
    const payers = rows.filter((r) => r.f_yield > 0);
    const tiles = [
      { k: "เหนือ MA50", v: above("ma50") + "%", s: "ของหุ้นทั้งหมด (ระยะกลาง)" },
      { k: "เหนือ MA200", v: above("ma200") + "%", s: "ของหุ้นทั้งหมด (ระยะยาว)" },
      { k: "ชนะตลาด 3M", v: rows.filter((r) => r.rs3m > 0).length + "", s: `ตลาด (TDEX) 3M ${pctFmt(b && b.r3m)}` },
      { k: "ค่ามัธยฐาน 1M", v: `<span class="${cls(med("r1m"))}">${pctFmt(med("r1m"))}</span>`, s: "ผลตอบแทนหุ้นกลางพอร์ต" },
      { k: "New high / low 52W", v: `<span class="pos">${rows.filter((r) => r.signals.includes("high52")).length}</span> / <span class="neg">${rows.filter((r) => r.signals.includes("low52")).length}</span>`, s: "จำนวนหุ้นวันล่าสุด" },
      { k: "ตลาด TDEX (SET50)", v: b ? priceFmt(b.close) : "–", s: b ? `${pctFmt(b.chg)} วันนี้ · ${TREND_LABEL[b.trend]}` : "" },
    ];
    if (setInfo) {
      const ys = payers.map((r) => r.f_yield).sort((a, b) => a - b);
      tiles.push(
        { k: "จ่ายปันผล (12 เดือน)", v: `${payers.length}`, s: `จาก ${rows.length} หุ้น · yield มัธยฐาน ${plainPct(ys[Math.floor(ys.length / 2)])}` },
        { k: "จ่ายต่อเนื่อง ≥ 5 ปี", v: `${rows.filter((r) => r.f_streak >= 5).length}`, s: "หุ้นปันผลสม่ำเสมอ" },
        { k: "เพิ่มทุนใน 3 ปี", v: `${rows.filter((r) => r.f && r.f.caps_3y.some((c) => c.type === "XR")).length}`, s: `XR · มีวอร์แรนต์ (XW) ${rows.filter((r) => r.f && r.f.caps_3y.some((c) => c.type === "XW")).length}` },
      );
    }
    if (held.length) {
      const tot = held.reduce((a, r) => a + r.p_value, 0);
      const costTot = held.reduce((a, r) => a + (r.p.cost || 0) * r.p.shares, 0);
      const pl = tot - costTot;
      const inc = held.reduce((a, r) => a + (r.p_income || 0), 0);
      const winners = held.filter((r) => r.p_pl > 0).length;
      tiles.unshift(
        { k: "🔒 มูลค่าตามราคาปิด", v: big(tot), s: `ทุนรวม ${big(costTot)} บาท` },
        { k: "🔒 กำไร/ขาดทุนยังไม่รับรู้", v: `<span class="${cls(pl)}">${pl >= 0 ? "+" : "−"}${big(Math.abs(pl))}</span>`, s: `${pctFmt(costTot ? pl / costTot * 100 : null)} · กำไร ${winners}/${held.length} ตัว` },
        { k: "🔒 ปันผลปีล่าสุด (ประมาณ)", v: big(inc), s: `${plainPct(tot ? inc / tot * 100 : null, 2)} ของมูลค่า · ${plainPct(costTot ? inc / costTot * 100 : null, 2)} ของทุน` },
      );
    }
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

  function eventDetail(e, close) {
    if (e.type === "XD") {
      const y = e.amount && close ? ` · ${plainPct(e.amount / close * 100, 2)} ของราคา` : "";
      return `${divFmt(e.amount)} บาท/หุ้น${y}${e.pay ? ` · จ่าย ${thDate(e.pay)}` : ""}`;
    }
    if (e.type === "XM") return `ประชุม ${thDate(e.meeting)}${e.mtype ? " (" + esc(e.mtype) + ")" : ""}`;
    const parts = [];
    if (e.ratio) parts.push(`<span title="หุ้นเดิม : สิทธิใหม่">อัตรา ${esc(e.ratio)}</span>`);
    if (e.price) parts.push(`ราคา ${priceFmt(e.price)} บาท`);
    if (e.rights) parts.push(esc(e.rights));
    return parts.join(" ") || "";
  }

  function renderCalendar() {
    const box = $("#calendar");
    const sec = box.closest("section");
    if (!setInfo) { sec.hidden = true; return; }
    sec.hidden = false;
    const today = new Date().toISOString().slice(0, 10);
    const items = setInfo.upcoming.filter((e) => e.xdate >= today && (state.group === "all" || (state.rows.find((r) => r.symbol === e.symbol) || {}).group === state.group));
    if (!items.length) { box.innerHTML = `<p class="none">ไม่มีเหตุการณ์ในช่วงนี้</p>`; return; }
    const byDate = {};
    items.forEach((e) => (byDate[e.xdate] = byDate[e.xdate] || []).push(e));
    box.innerHTML = Object.keys(byDate).sort().map((d) => {
      const days = Math.round((new Date(d + "T00:00:00") - new Date(today + "T00:00:00")) / 864e5);
      return `<div class="cal-day"><div class="cal-date"><b>${thDate(d, { day: "numeric", month: "short" })}</b><span>${days === 0 ? "วันนี้" : days === 1 ? "พรุ่งนี้" : `อีก ${days} วัน`}</span></div>
        <div class="cal-items">${byDate[d].map((e) => {
          const r = state.rows.find((x) => x.symbol === e.symbol);
          return `<button class="cal-item" data-sym="${esc(e.symbol)}">${caTag(e.type)}<b>${esc(e.symbol)}</b><span>${eventDetail(e, r && r.close)}</span></button>`;
        }).join("")}</div></div>`;
    }).join("");
  }
  $("#calendar").addEventListener("click", (e) => { const b = e.target.closest("[data-sym]"); if (b) openDetail(b.dataset.sym); });

  function sortMarks(id) {
    document.querySelectorAll(id + " th").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.k === state.sort && !th.classList.contains("nosort"));
      th.classList.toggle("asc", state.asc);
    });
  }

  function renderTable(rows) {
    sortMarks("#tbl");
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
      <td class="pcol">${r.p ? priceFmt(r.p_cost) : ""}</td>
      <td class="pcol ${cls(r.p_pl)}">${r.p ? pctFmt(r.p_pl) : ""}</td>
      <td class="pcol">${r.p_weight == null ? "" : plainPct(r.p_weight, 1)}</td>
    </tr>`).join("");
  }
  $("#tbl tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-sym]"); if (tr) openDetail(tr.dataset.sym); });

  function renderFund(rows) {
    sortMarks("#ftbl");
    $("#ftbl tbody").innerHTML = rows.map((r) => {
      const f = r.f || {};
      const caps = (f.caps_3y || []);
      const capTags = caps.length ? [...new Set(caps.map((c) => c.type))].map((t) => caTag(t, `<small>${caps.filter((c) => c.type === t).length > 1 ? "×" + caps.filter((c) => c.type === t).length : ""}</small>`)).join(" ") : `<span class="muted">–</span>`;
      return `<tr data-sym="${esc(r.symbol)}">
      <td class="sym l"><b>${esc(r.symbol)}</b>${idxTag(f)}${r.group === "watch" ? '<span class="w">watch</span>' : ""}</td>
      <td>${priceFmt(r.close)}</td>
      <td class="l">${trendBadge(r)}</td>
      <td class="ret" style="background:${seqBg(r.f_yield, 8)}">${plainPct(r.f_yield, 2)}</td>
      <td class="l">${r.f ? divBars(f.divs) : "–"}</td>
      <td class="${r.f_streak ? "" : "muted"}">${r.f ? (r.f_streak ? r.f_streak + " ปี" : "–") : "–"}</td>
      <td class="${r.f_payout > 100 ? "neg" : ""}">${r.f_payout == null ? "–" : nf(0).format(r.f_payout) + "%"}</td>
      <td>${num(r.f_pe, 1)}</td>
      <td>${num(r.f_pbv, 2)}</td>
      <td class="${cls(r.f_roe)}">${r.f_roe == null ? "–" : nf(1).format(r.f_roe) + "%"}</td>
      <td class="${cls(r.f_growth)}">${pctFmt(r.f_growth, 0)}</td>
      <td>${r.f_lastxd ? `${thDate(r.f_lastxd)}<small class="muted"> ${divFmt(f.last_xd.amount)}</small>` : "–"}</td>
      <td class="l">${r.f ? capTags : "–"}</td>
      <td>${big(r.f_mcap)}</td>
      <td class="l sector">${esc(r.f_sector || "–")}</td>
      <td class="pcol">${r.p ? plainPct(r.p_yoc, 2) : ""}</td>
      <td class="pcol">${r.p && r.p_income ? nf(0).format(r.p_income) : ""}</td>
    </tr>`;
    }).join("");
  }
  $("#ftbl tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-sym]"); if (tr) openDetail(tr.dataset.sym); });

  function renderHeat(rows) {
    const k = state.heatKey, lim = HEAT_LIM[k];
    const isSeq = k === "f_yield";
    const cell = (r) => `<div class="cell" data-sym="${esc(r.symbol)}" style="background:${isSeq ? seqBg(r[k], lim) : heatBg(r[k], lim)}" title="${esc(r.name)}"><b>${esc(r.symbol)}</b><span>${isSeq ? plainPct(r[k], 2) : pctFmt(r[k])}</span></div>`;
    if (k.startsWith("p_")) rows = rows.filter((r) => r.p);
    const sorted = [...rows].sort((a, b) => (b[k] ?? -1e9) - (a[k] ?? -1e9));
    if (!state.bySector) { $("#heatView").innerHTML = `<div class="heat-grid">${sorted.map(cell).join("")}</div>`; return; }
    const groups = {};
    sorted.forEach((r) => (groups[r.f_sector || "ไม่ทราบกลุ่ม"] = groups[r.f_sector || "ไม่ทราบกลุ่ม"] || []).push(r));
    const avg = (g) => { const v = g.map((r) => r[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    $("#heatView").innerHTML = Object.entries(groups).sort((a, b) => (avg(b[1]) ?? -1e9) - (avg(a[1]) ?? -1e9)).map(([name, g]) =>
      `<div class="heat-group"><h3>${esc(name)} <span class="hint">${g.length} หุ้น · เฉลี่ย ${isSeq ? plainPct(avg(g), 2) : pctFmt(avg(g))}</span></h3><div class="heat-grid">${g.map(cell).join("")}</div></div>`).join("");
  }
  $("#heatView").addEventListener("click", (e) => { const c = e.target.closest("[data-sym]"); if (c) openDetail(c.dataset.sym); });

  // ---------- detail ----------
  const chartState = { sym: null, chart: null, range: 252, bars: null, events: [] };
  const cache = {}, infoCache = {};

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
    $("#dTitle").innerHTML = `${esc(sym)} ${idxTag(r.f)}`;
    $("#dName").textContent = [r.name, r.f && r.f.sector, r.f && r.f.market].filter(Boolean).join(" · ");
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
    if (r.p) {
      const need = r.p.cost ? (r.p.cost / r.close - 1) * 100 : null;
      const plBaht = r.p_value - r.p.cost * r.p.shares;
      stats.unshift(
        ["🔒 ทุนเฉลี่ย", priceFmt(r.p.cost)], ["🔒 %P/L", pctFmt(r.p_pl), cls(r.p_pl)],
        ["🔒 จำนวนหุ้น", nf(0).format(r.p.shares)], ["🔒 มูลค่า / น้ำหนัก", `${big(r.p_value)} · ${plainPct(r.p_weight, 1)}`],
        ["🔒 กำไร/ขาดทุน (บาท)", `${plBaht >= 0 ? "+" : "−"}${big(Math.abs(plBaht))}`, cls(plBaht)],
        ["🔒 ต้องขึ้นอีกเพื่อถึงทุน", need > 0 ? pctFmt(need) : "ถึงทุนแล้ว"],
      );
    }
    $("#dStats").innerHTML = stats.map(([k, v, c]) => `<div><div class="k">${k}</div><div class="v ${c || ""}">${v}</div></div>`).join("");
    $("#dFund").innerHTML = "";
    if (!keepRange) {
      chartState.range = 252;
      $("#rangeSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === "252"));
    }
    const infoP = r.f && r.f.file
      ? (infoCache[sym] ? Promise.resolve(infoCache[sym]) : fetch("data/set_info/" + r.f.file, { cache: "no-cache" }).then((x) => x.json()).then((j) => (infoCache[sym] = j)).catch(() => null))
      : Promise.resolve(null);
    try {
      cache[sym] = cache[sym] || await fetch("data/prices/" + r.file, { cache: "no-cache" }).then((x) => x.json());
    } catch (e) {
      $("#ohlc").textContent = "โหลดกราฟไม่สำเร็จ";
      return;
    }
    const info = await infoP;
    if (chartState.sym !== sym) return;
    chartState.events = (info && info.events) || [];
    drawChart(cache[sym].bars);
    if (info) $("#dFund").innerHTML = fundDetail(r, info);
  }

  function fundDetail(r, info) {
    const f = r.f;
    const nvdr = f.nvdr_net;
    const val = [
      ["Dividend yield (12M)", plainPct(f.yield, 2)], ["Payout ratio", f.payout == null ? "–" : nf(0).format(f.payout) + "%"],
      ["จ่ายปันผลต่อเนื่อง", f.div_streak ? f.div_streak + " ปี" : "–"], ["จ่ายใน 5 ปีล่าสุด", `${f.div_years_5}/5 ปี`],
      ["P/E", num(f.pe, 1)], ["P/BV", num(f.pbv, 2)],
      ["ROE (ปีล่าสุด)", f.roe == null ? "–" : nf(1).format(f.roe) + "%", cls(f.roe)], ["Net margin", f.npm == null ? "–" : nf(1).format(f.npm) + "%", cls(f.npm)],
      ["D/E", num(f.de, 2)], ["กำไรสุทธิโต (ปีล่าสุด)", pctFmt(f.profit_growth, 0), cls(f.profit_growth)],
      ["Market cap", big(f.mcap) + " บาท"], ["Free float", plainPct(f.free_float)],
      ["Foreign room เหลือ", plainPct(f.foreign_room)],
      ["NVDR ซื้อสุทธิ (วันล่าสุด)", nvdr == null ? "–" : (nvdr > 0 ? "+" : "−") + big(Math.abs(nvdr)) + " บาท", cls(nvdr)],
    ];
    let html = `<h3 class="sec">ปันผล &amp; มูลค่า</h3><div class="stats">${val.map(([k, v, c]) => `<div><div class="k">${k}</div><div class="v ${c || ""}">${v}</div></div>`).join("")}</div>`;

    // dividend per fiscal year
    const years = Object.keys(f.divs || {});
    const allDivs = {};
    info.events.filter((e) => e.type === "XD" && e.amount).forEach((e) => {
      const y = ((e.period && e.period[1]) || e.xdate || "").slice(0, 4);
      if (y) allDivs[y] = (allDivs[y] || 0) + e.amount;
    });
    const ys = Object.keys(allDivs).sort().slice(-10);
    if (ys.length) {
      const max = Math.max(...ys.map((y) => allDivs[y]));
      html += `<h3 class="sec">เงินปันผลต่อหุ้น รายปีผลประกอบการ <span class="hint">บาท · % = เทียบราคาปัจจุบัน ${priceFmt(r.close)}</span></h3>
        <div class="divchart" role="img" aria-label="${ys.map((y) => `${y} ${divFmt(allDivs[y])} บาท`).join(", ")}">${ys.map((y) => {
          const v = allDivs[y], partial = y >= THIS_YEAR;
          return `<div class="dc-col${partial ? " partial" : ""}" title="${y}: ${divFmt(v)} บาท${partial ? " (ยังไม่ครบปี)" : ""}">
            <span class="dc-v">${divFmt(v)}</span><span class="dc-y">${plainPct(v / r.close * 100, 1)}</span>
            <div class="dc-bar" style="height:${Math.max(3, v / max * 100)}%"></div><span class="dc-x">${y}${partial ? "*" : ""}</span></div>`;
        }).join("")}</div>
        <p class="hint">* ปีที่ยังจ่ายไม่ครบ (มีแค่ปันผลระหว่างกาล) · ยอดต่อหุ้นตามที่ประกาศ ไม่ได้ปรับการแตกพาร์/เพิ่มทุน</p>`;
    } else if (!years.length) {
      html += `<h3 class="sec">เงินปันผล</h3><p class="hint">ไม่มีประวัติจ่ายปันผลเงินสด</p>`;
    }

    // financials
    if (info.financials && info.financials.length) {
      const F = info.financials;
      const mb = (v) => v == null ? "–" : nf(0).format(v / 1000);
      const rowsF = [
        ["รายได้รวม (ล้านบาท)", (x) => mb(x.totalRevenue)],
        ["กำไรสุทธิ (ล้านบาท)", (x) => `<span class="${cls(x.netProfit)}">${mb(x.netProfit)}</span>`],
        ["EPS (บาท)", (x) => num(x.eps, 2)],
        ["ROE %", (x) => num(x.roe, 1)],
        ["Net margin %", (x) => num(x.netProfitMargin, 1)],
        ["D/E (เท่า)", (x) => num(x.deRatio, 2)],
      ];
      html += `<h3 class="sec">งบการเงินย่อ</h3><div class="table-wrap"><table class="fin"><thead><tr><th class="l"></th>${F.map((x) => `<th>${esc(x.label)}</th>`).join("")}</tr></thead>
        <tbody>${rowsF.map(([k, fn]) => `<tr><td class="l">${k}</td>${F.map((x) => `<td>${fn(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
        <p class="hint">ตัวเลขงวดล่าสุดที่ไม่ใช่ทั้งปี (เช่น 6M, 9M) เป็นงบสะสมระหว่างปี</p>`;
    }

    // corporate actions history
    const evs = info.events.filter((e) => e.type !== "XM" || e.xdate >= new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10));
    if (evs.length) {
      const row = (e) => {
        let d = eventDetail(e, null);
        if (e.type === "XD" && e.period && e.period[0]) d += ` · งวด ${thDate(e.period[0])} – ${thDate(e.period[1])}`;
        if (e.sub && e.sub[0]) d += ` · จองซื้อ ${thDate(e.sub[0])} – ${thDate(e.sub[1])}`;
        if (e.type === "XD(ST)") d = `ปันผลเป็นหุ้น ${esc(e.ratio || "")}`;
        if (e.type === "XM" && e.agenda) d += ` · ${esc(e.agenda)}`;
        return `<tr class="${e.xdate > new Date().toISOString().slice(0, 10) ? "future" : ""}"><td class="l">${thDate(e.xdate)}</td><td class="l">${caTag(e.type)}</td><td class="l wrap">${d}</td></tr>`;
      };
      const caps = evs.filter((e) => !["XD", "XM"].includes(e.type)).length;
      html += `<h3 class="sec">ประวัติสิทธิประโยชน์ <span class="hint">${evs.filter((e) => e.type === "XD").length} ครั้ง XD · ${caps} ครั้ง XR/XW/อื่นๆ</span></h3>
        <div class="table-wrap"><table class="ev"><tbody>${evs.slice(0, 12).map(row).join("")}</tbody>
        ${evs.length > 12 ? `<tbody class="more" hidden>${evs.slice(12).map(row).join("")}</tbody>` : ""}</table></div>
        ${evs.length > 12 ? `<button class="linkbtn" data-more>แสดงทั้งหมด ${evs.length} รายการ</button>` : ""}`;
    }
    return html;
  }
  $("#dFund").addEventListener("click", (e) => {
    const b = e.target.closest("[data-more]");
    if (!b) return;
    $("#dFund .ev .more").hidden = false;
    b.remove();
  });

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
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      localization: { locale: "en-GB" },
    });
    chartState.chart = chart;
    const pr = state.rows.find((x) => x.symbol === chartState.sym);
    const cost = pr && pr.p && pr.p.cost;
    const candle = chart.addCandlestickSeries({
      upColor: up, downColor: dn, borderVisible: false, wickUpColor: up, wickDownColor: dn,
      priceLineVisible: false,
      // keep the private cost line in view even when it is far from the visible prices
      autoscaleInfoProvider: (orig) => {
        const res = orig();
        if (res && res.priceRange && cost) {
          res.priceRange.minValue = Math.min(res.priceRange.minValue, cost);
          res.priceRange.maxValue = Math.max(res.priceRange.maxValue, cost);
        }
        return res;
      },
    });
    candle.setData(bars.map((b) => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] })));
    for (const [n, v] of [[20, "--ma20"], [50, "--ma50"], [200, "--ma200"]]) {
      const s = chart.addLineSeries({ color: css(v), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(smaSeries(bars, n));
    }
    const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    vol.setData(bars.map((b, i) => ({ time: b[0], value: b[5], color: b[4] >= (i ? bars[i - 1][4] : b[1]) ? hexA(up, 0.45) : hexA(dn, 0.45) })));

    // XD / XR / XW markers, snapped to the first trading day on or after the X-date
    const first = bars[0][0], last = bars[bars.length - 1][0];
    const dates = bars.map((b) => b[0]);
    const byEvent = {};
    chartState.events.filter((e) => e.type !== "XM" && e.xdate >= first && e.xdate <= last).forEach((e) => {
      let i = dates.findIndex((d) => d >= e.xdate);
      if (i < 0) return;
      const t = dates[i];
      (byEvent[t] = byEvent[t] || []).push(e);
    });
    const markers = Object.keys(byEvent).sort().map((t) => {
      const evs = byEvent[t];
      const main = evs.find((e) => e.type !== "XD") || evs[0];
      return { time: t, position: "aboveBar", shape: "circle", color: css(caInfo(main.type).c), text: [...new Set(evs.map((e) => caInfo(e.type).m))].join("") };
    });
    candle.setMarkers(markers);
    if (cost) {
      candle.createPriceLine({ price: cost, color: css("--ink-2"), lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "ทุน" });
    }
    fitRange();

    const idx = Object.fromEntries(bars.map((b, i) => [b[0], i]));
    const legend = (t) => {
      const i = t != null && idx[t] != null ? idx[t] : bars.length - 1;
      const b = bars[i], prev = i ? bars[i - 1][4] : b[1];
      const ma = (n) => priceFmt(maAt(bars, i, n));
      const ev = (byEvent[b[0]] || []).map((e) => `${caTag(e.type)} ${eventDetail(e, null)}`).join(" ");
      $("#ohlc").innerHTML = `<span>${b[0]}</span><span>O <b>${priceFmt(b[1])}</b></span><span>H <b>${priceFmt(b[2])}</b></span><span>L <b>${priceFmt(b[3])}</b></span><span>C <b>${priceFmt(b[4])}</b> <span class="${cls(b[4] - prev)}">${pctFmt((b[4] / prev - 1) * 100, 2)}</span></span><span>Vol <b>${big(b[5])}</b></span><span>MA20 <b>${ma(20)}</b></span><span>MA50 <b>${ma(50)}</b></span><span>MA200 <b>${ma(200)}</b></span>${ev ? `<span>${ev}</span>` : ""}`;
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
