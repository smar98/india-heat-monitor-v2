/*
 * ui.js — every view except the map and the trend chart: topbar timestamp +
 * stale warning, §1 the plans grid + CPR note, the workload control, §2 the
 * finding (headline, KPIs, by-workload bars), §4 the day strip + per-state
 * plan note, §3's district leaderboard, §6 the closing exhibit, the side-nav
 * scrollspy, the sticky city bar, and the shared tooltip. All numbers come
 * from data.js computations — the same functions the map uses, so the views
 * can never disagree.
 *
 * Shared state: the selected workload lives in data.js (setWorkload fires
 * "workloadchange"); the selected city lives here (selectCity fires
 * "citychange" — trend.js listens too).
 */

let UI = null;              // { cities, latest }
let _selectedCityId = null;
let _districtStats = null;  // { workers, daily } for the leaderboard
let _hap = null;

const $id = (id) => document.getElementById(id);

/** The city currently selected in §4's selector (trend.js reads this). */
function getSelectedCityId() { return _selectedCityId; }

/** 11 -> "11am", 17 -> "5pm", 0 -> "12am" (advisory-window style labels). */
function hour12(h) {
  const n = ((h + 11) % 12) + 1;
  return `${n}${h < 12 || h === 24 ? "am" : "pm"}`;
}

/* ------------------------------------------------------------------ */
/* Shared tooltip: one fixed div, driven by [data-tip] via delegation. */
/* Hover/focus on desktop; tap toggles on touch.                       */
/* ------------------------------------------------------------------ */
function initTip() {
  const tip = $id("tip");
  let anchor = null;
  function show(el) {
    anchor = el;
    tip.innerHTML = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 8);
    let y = r.top - th - 10;
    if (y < 8) y = r.bottom + 10;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }
  function hide() { anchor = null; tip.hidden = true; }
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el) show(el); else if (anchor) hide();
  });
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el) show(el); else if (anchor) hide();
  });
  document.addEventListener("touchstart", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el && el !== anchor) show(el); else hide();
  }, { passive: true });
  window.addEventListener("scroll", hide, { passive: true });
}

/* ------------------------------------------------------------------ */
/* Topbar timestamp + data-age warning (data is refreshed 3-hourly;    */
/* GitHub Actions schedules are best-effort, so the browser checks).   */
/* ------------------------------------------------------------------ */
function renderTimestamp(latest) {
  const generated = new Date(latest.generated_at_utc);
  const ist = new Date(generated.getTime() + (5 * 60 + 30) * 60 * 1000);
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  $id("data-updated").textContent =
    `${DAYS[ist.getUTCDay()]} ${pad(ist.getUTCDate())} ${MONS[ist.getUTCMonth()]}, ` +
    `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())} IST`;

  const ageHours = (Date.now() - generated.getTime()) / 3600000;
  if (ageHours > 9) {
    const warn = $id("stale-warning");
    warn.hidden = false;
    warn.textContent =
      `⚠ Data is ${Math.round(ageHours)} hours old (target refresh: every 3 hours). ` +
      `Automated updates can lag; figures may not reflect the latest forecast.`;
  }
}

/* ------------------------------------------------------------------ */
/* §1 The plans: audited state HAPs quoted verbatim + the CPR finding. */
/* Display-only — nothing here feeds a computed number.                */
/* ------------------------------------------------------------------ */
function renderPlansGrid() {
  const host = $id("plans-grid");
  if (!host || !_hap) return;
  host.innerHTML = Object.entries(_hap.plans).map(([state, p]) => `
    <div class="plan-card">
      <div class="plan-state"><b>${state}</b><span class="plan-window">${p.window_display}</span></div>
      <p class="plan-quote">&ldquo;${p.window_text}&rdquo;</p>
      <div class="plan-src"><a href="${p.source_url}" rel="noopener">${p.plan.replace(state + " \u2014 ", "")}</a>${p.source_page ? `, ${p.source_page}` : ""}${p.level_note ? ` · ${p.level_note.replace(" \u2014 ", ": ")}` : ""}</div>
    </div>`).join("");

  const cpr = $id("cpr-note");
  if (cpr) {
    cpr.innerHTML = `Do the plans have teeth? A 2023 Centre for Policy Research review of 37 Indian
      Heat Action Plans found that <em>none</em> identified the legal source of its authority, and
      only 11 discussed funding; eight of those asked departments to fund themselves.
      Source: <a href="${_hap.cpr.url}" rel="noopener">CPR 2023</a>${_hap.cpr.source_page ? ", " + _hap.cpr.source_page : ""}.
      A finding about India's plans overall rather than a grade of any one state.`;
  }
}

/* ------------------------------------------------------------------ */
/* Workload segmented control (§2). Everything recomputes on change.  */
/* ------------------------------------------------------------------ */
function renderWorkloadSeg() {
  const host = $id("workload-seg");
  host.innerHTML = "";
  const current = getWorkload();
  for (const w of WORKLOAD_LEVELS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wbtn";
    btn.setAttribute("aria-pressed", String(w.key === current.key));
    btn.innerHTML = `<span>${w.label}</span><span class="rel">limit ${nioshRelC(w.watts).toFixed(1)}°C</span>`;
    btn.addEventListener("click", () => setWorkload(w.key));
    host.appendChild(btn);
  }
  const w = getWorkload();
  $id("workload-note").innerHTML =
    `<strong>${w.label}</strong> work ≈ ${w.watts}&thinsp;W of body heat (e.g. ${w.examples}); ` +
    `NIOSH acclimatized-worker limit <strong>${nioshRelC(w.watts).toFixed(1)}°C</strong>.`;
  renderContextBar();
}

/* ------------------------------------------------------------------ */
/* §2 The finding: headline count, KPIs, robustness band, workload bars */
/* ------------------------------------------------------------------ */
function renderFinding() {
  const rel = getRelThreshold();
  const w = getWorkload();
  const summary = computeOverlookedSummary(UI.cities, UI.latest, rel);

  if (summary.citiesTotal === 0) {
    $id("hl-count").textContent = "—";
    $id("hl-total").textContent = "—";
    $id("finding-foot").textContent = "No current data available: the forecast file has not loaded for today.";
    return;
  }

  // Sensitivity of the city count to a uniform ±1°C WBGT shift (a stress
  // test of the estimate, not a full error bar — see methods).
  const loose = computeOverlookedSummary(UI.cities, UI.latest, rel - 1);
  const tight = computeOverlookedSummary(UI.cities, UI.latest, rel + 1);
  const cityLo = Math.min(tight.citiesWithShoulder, summary.citiesWithShoulder, loose.citiesWithShoulder);
  const cityHi = Math.max(tight.citiesWithShoulder, summary.citiesWithShoulder, loose.citiesWithShoulder);

  $id("hl-count").textContent = summary.citiesWithShoulder;
  $id("hl-total").textContent = summary.citiesTotal;

  const deep = summary.perCity.filter((c) => c.shoulder >= 3).length;
  $id("kpi-cities").innerHTML = `${summary.citiesWithShoulder}<small> / ${summary.citiesTotal}</small>`;
  $id("kpi-cities-k").innerHTML =
    `Cities with at least one overlooked hour forecast today at ${w.label.toLowerCase()} work` +
    (deep > 0 ? `; <strong>${deep}</strong> of them for 3+ hours` : "");
  $id("kpi-hours").textContent = summary.totalShoulderHours;
  $id("kpi-hours-k").textContent = "Overlooked city-hours today, summed across the 50-city sample";
  const top0 = summary.perCity.find((c) => c.shoulder > 0);
  if (top0) {
    $id("kpi-top").textContent = top0.name;
    $id("kpi-top-k").innerHTML =
      `Most overlooked hours today: <strong>${top0.shoulder}&thinsp;hr</strong> at ${top0.shoulderHours.map((h) => h.istLabel).join(", ")} IST`;
  } else {
    $id("kpi-top").textContent = "—";
    $id("kpi-top-k").textContent = `No city crosses the ${w.label.toLowerCase()}-work limit outside the window today`;
  }
  $id("kpi-band").textContent = cityLo === cityHi ? String(cityLo) : `${cityLo}–${cityHi}`;

  $id("dark-note").textContent = summary.totalDarkHumid > 0
    ? `Separately, ${summary.totalDarkHumid} after-dark city-hours are over the limit on humidity alone; those stay out of the headline.`
    : "";

  renderSensBars();
  renderLeaderboard();
}

/* By-workload bars: the same forecast read against all four limits. */
function renderSensBars() {
  const host = $id("sens-panel");
  const current = getWorkload();
  const counts = WORKLOAD_LEVELS.map((w) => {
    const rel = nioshRelC(w.watts);
    return { w, rel, count: computeOverlookedSummary(UI.cities, UI.latest, rel).citiesWithShoulder };
  });
  const maxCount = Math.max(1, ...counts.map((c) => c.count));
  host.innerHTML = counts.map(({ w, rel, count }) => `
    <div class="srow${w.key === current.key ? " on" : ""}">
      <div class="sh"><span>${w.label} · ${rel.toFixed(1)}°C</span><span class="cnt">${count} cities</span></div>
      <div class="track"><div class="fill" style="width:${Math.round((count / maxCount) * 100)}%"></div></div>
    </div>`).join("");
}

/* ------------------------------------------------------------------ */
/* §4 The day strip — the signature exhibit. One row per day (today +  */
/* tomorrow), 24 hour-cells, the advisory window drawn as a blue       */
/* bracket, overlooked hours ringed and notched in the flag crimson.   */
/* ------------------------------------------------------------------ */
const TIER_CLASS = {
  "below-rel": "t-ok",
  "stress-window": "t-window",
  "stress-shoulder": "t-ovl",
  "stress-dark": "t-dark",
  "unknown": "t-na",
};

function tierPhrase(h, w) {
  switch (h.clockTier) {
    case "below-rel": return "below the limit";
    case "stress-window": return "over the limit, inside the window the plans already cover";
    case "stress-shoulder": return "<b>over the limit in an hour the plans recommend: overlooked</b>";
    case "stress-dark": return "over the limit after dark (humidity-driven)";
    default: return "no estimate for this hour";
  }
}

function renderDayStrip() {
  const cityId = _selectedCityId;
  const host = $id("day-strip");
  host.innerHTML = "";
  const rel = getRelThreshold();
  const w = getWorkload();
  const hourly = buildHourlySeriesForCity(cityId, UI.latest, rel);
  if (hourly.length === 0) {
    host.innerHTML = '<p class="empty">No hourly data for this city.</p>';
    return;
  }
  const city = UI.cities.find((c) => c.id === cityId);
  const todayKey = nowInIst().dateKey;
  const dateKeys = [...new Set(hourly.map((h) => h.istDateKey))].sort().slice(0, 2);

  dateKeys.forEach((key, rowIdx) => {
    const row = hourly.filter((h) => h.istDateKey === key);
    const byHour = new Map(row.map((h) => [h.istHour, h]));
    const dayEl = document.createElement("div");
    dayEl.className = "day-strip-day";

    const dayNum = (k) => Math.round(Date.parse(k + "T00:00Z") / 86400000);
    const diff = dayNum(key) - dayNum(todayKey);
    const rowName = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : formatIstDateLong(key);
    const label = document.createElement("div");
    label.className = "day-strip-label";
    label.innerHTML = `<b>${rowName}</b> · ${formatIstDateLong(key)} · ${city.name}`;
    dayEl.appendChild(label);

    const outer = document.createElement("div");
    outer.className = "strip-outer";
    const cells = document.createElement("div");
    cells.className = "strip-cells";

    for (let hr = 0; hr < 24; hr++) {
      const h = byHour.get(hr);
      const cell = document.createElement("div");
      cell.className = "hr-cell " + (h ? TIER_CLASS[h.clockTier] : "t-na");
      if (h && h.clockTier === "below-rel" && !h.sunUp) cell.classList.add("night");
      if (h) {
        const wbgtText = h.wbgt_status === 0 && h.wbgt_c != null
          ? `est. WBGT ${h.wbgt_c.toFixed(1)}°C · limit ${rel.toFixed(1)}°C (${w.label.toLowerCase()})`
          : "no estimate";
        cell.dataset.tip = `<b>${h.istLabel} IST</b> · ${wbgtText}.<br>${tierPhrase(h, w)}`;
        cell.setAttribute("tabindex", "0");
        cell.setAttribute("role", "img");
        cell.setAttribute("aria-label", `${h.istLabel} IST: ${wbgtText}, ${cell.className.includes("t-ovl") ? "overlooked hour" : h.clockTier.replace("-", " ")}`);
      }
      if (hr % 3 === 0) {
        const tick = document.createElement("div");
        tick.className = "hr-tick";
        tick.textContent = String(hr).padStart(2, "0");
        cell.appendChild(tick);
      }
      cells.appendChild(cell);
    }

    // The advisory bracket, positioned in hour fractions over the 24 cells.
    const band = document.createElement("div");
    band.className = "strip-band";
    band.style.left = `${(HAP_WINDOW_START / 24) * 100}%`;
    band.style.width = `${((HAP_WINDOW_END - HAP_WINDOW_START) / 24) * 100}%`;
    if (rowIdx === 0) {
      const bl = document.createElement("div");
      bl.className = "strip-band-label";
      bl.textContent = `ADVISORY: AVOID ${hour12(HAP_WINDOW_START).toUpperCase()}–${hour12(HAP_WINDOW_END).toUpperCase()}`;
      band.appendChild(bl);
    }
    cells.appendChild(band);

    outer.appendChild(cells);
    dayEl.appendChild(outer);
    host.appendChild(dayEl);
  });

  // One-line takeaway for the selected city today.
  const ws = computeCityWorkStress(cityId, UI.latest, rel, todayKey);
  const note = $id("day-note");
  if (ws) {
    note.innerHTML = ws.shoulder > 0
      ? `Today in <strong>${city.name}</strong>, ${ws.insideWindow} over-limit
         hour${ws.insideWindow === 1 ? "" : "s"} fall${ws.insideWindow === 1 ? "s" : ""} inside the
         advisory window, and <strong class="hot">${ws.shoulder} more
         fall${ws.shoulder === 1 ? "s" : ""} in the morning and evening hours the plans
         recommend</strong> (${w.label.toLowerCase()} work)${ws.darkHumid > 0 ? `, plus ${ws.darkHumid} after dark` : ""}.`
      : `Today in <strong>${city.name}</strong>, no ${w.label.toLowerCase()}-work hour crosses the limit
         outside the advisory window. On a day like this, the advice holds.`;
  } else {
    note.textContent = "";
  }
}

/* The selected city's own state plan, as a footnote under the strip. */
function renderDayHap() {
  const host = $id("day-hap");
  if (!host || !_hap || _selectedCityId == null) return;
  const city = UI.cities.find((c) => c.id === _selectedCityId);
  if (!city) { host.textContent = ""; return; }
  const plan = _hap.plans[city.state];
  host.innerHTML = plan
    ? `The plan tested for <strong>${city.state}</strong> is in §&nbsp;1: ${plan.plan.replace(/—/g, "·")}
       (&ldquo;${plan.window_text}&rdquo;). The strips shade 11am–5pm, the widest audited window, so every
       flagged hour also falls outside ${city.state}'s own narrower window.`
    : `No primary-sourced work-hour window for <strong>${city.state}</strong> is audited on this page
       (see §&nbsp;1); a plan may still exist. The national advisory applies, and the 11am–5pm test
       keeps ${city.state}'s count a conservative lower bound too.`;
}

/* ------------------------------------------------------------------ */
/* City selection: shared by §4, §5, §6 and the sticky bar.            */
/* ------------------------------------------------------------------ */
function selectCity(cityId) {
  const changed = _selectedCityId !== cityId;
  _selectedCityId = cityId;
  for (const selId of ["city-select", "city-select-sticky"]) {
    const sel = $id(selId);
    if (sel && String(sel.value) !== String(cityId)) sel.value = String(cityId);
  }
  renderDayStrip();
  renderDayHap();
  renderClosing();
  renderContextBar();
  if (changed) document.dispatchEvent(new CustomEvent("citychange", { detail: { cityId } }));
}

function initCityControls() {
  const summary = computeOverlookedSummary(UI.cities, UI.latest, getRelThreshold());
  const worst = summary.perCity.length ? summary.perCity[0] : null;
  const defaultCityId = worst ? worst.id : UI.cities[0].id;

  const sorted = [...UI.cities].sort((a, b) => a.name.localeCompare(b.name));
  for (const selId of ["city-select", "city-select-sticky"]) {
    const sel = $id(selId);
    if (!sel) continue;
    for (const c of sorted) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.name} (${c.state})`;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => selectCity(Number(sel.value)));
  }

  // Quick chips: the day's sharpest example, plus Chennai as a fixed anchor.
  const chips = $id("city-chips");
  const chipDefs = [];
  if (worst) chipDefs.push({ label: `Worst today: ${worst.name}`, id: worst.id });
  const chennai = UI.cities.find((c) => c.name === "Chennai");
  if (chennai && (!worst || worst.id !== chennai.id)) chipDefs.push({ label: "Chennai", id: chennai.id });
  for (const cd of chipDefs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = cd.label;
    b.addEventListener("click", () => selectCity(cd.id));
    chips.appendChild(b);
  }

  selectCity(defaultCityId);
}

/* ------------------------------------------------------------------ */
/* Sticky city bar: sections 4-6 all follow the selected city, so once */
/* the reader is inside them the selection stays visible (and     */
/* changeable) at the top of the screen.                               */
/* ------------------------------------------------------------------ */
function renderContextBar() {
  const workEl = $id("cc-work");
  if (!workEl) return;
  const w = getWorkload();
  workEl.innerHTML = `at <b>${w.label.toLowerCase()}</b> work (limit ${getRelThreshold().toFixed(1)}°C)`;
}

function initContextBar() {
  const bar = $id("city-context");
  const topbar = document.querySelector(".topbar");
  if (!bar || !topbar) return;
  const place = () => { bar.style.top = `${topbar.offsetHeight}px`; };
  place();
  window.addEventListener("resize", place);

  const first = $id("sec-day"), last = $id("sec-change");
  let ticking = false;
  function update() {
    ticking = false;
    // Visible while the §4 city selector is above the viewport top and §6
    // hasn't fully scrolled past — i.e. exactly the city-driven stretch.
    const selRow = $id("city-select");
    const start = selRow.getBoundingClientRect().bottom < topbar.offsetHeight;
    const end = last.getBoundingClientRect().bottom > 140;
    bar.hidden = !(start && end);
  }
  window.addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  update();
}

/* ------------------------------------------------------------------ */
/* Side-nav scrollspy: highlight the section covering the viewport.    */
/* ------------------------------------------------------------------ */
function initScrollSpy() {
  const links = [...document.querySelectorAll("#sidenav a[data-sec]")];
  if (!links.length) return;
  const secs = links.map((a) => $id(a.dataset.sec)).filter(Boolean);
  let ticking = false;
  function update() {
    ticking = false;
    let current = null;
    for (const sec of secs) {
      if (sec.getBoundingClientRect().top <= window.innerHeight * 0.35) current = sec.id;
    }
    for (const a of links) a.classList.toggle("on", a.dataset.sec === current);
  }
  window.addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  update();
}

/* ------------------------------------------------------------------ */
/* §3 leaderboard: districts ranked by outdoor workers × today's       */
/* overlooked hours (an index for ranking, not measured exposure).     */
/* ------------------------------------------------------------------ */
function renderLeaderboard() {
  const host = $id("overlooked-list");
  if (!host) return;
  if (!_districtStats) {
    host.innerHTML = '<p class="empty">Loading district workforce data…</p>';
    return;
  }
  const w = getWorkload();
  const todayKey = nowInIst().dateKey;
  // Staleness guard: the district file refreshes on its own schedule. If its
  // date isn't today, the figures are still shown but labeled with their date.
  const staleLine = _districtStats.daily.ist_date !== todayKey
    ? `<p class="empty">⚠ District figures below are for ${formatIstDateLong(_districtStats.daily.ist_date)}; today's refresh hasn't landed yet.</p>`
    : "";
  const rows = [];
  for (const [code, wk] of Object.entries(_districtStats.workers.districts)) {
    const d = _districtStats.daily.districts[code];
    if (!d) continue;
    const hours = d.o[w.key] || 0;
    if (hours > 0) rows.push({ wk, hours, exposure: wk.outdoor_workers * hours });
  }
  rows.sort((a, b) => b.exposure - a.exposure);
  const top = rows.slice(0, 6);
  if (top.length === 0) {
    host.innerHTML = staleLine +
      `<p class="empty">No district has overlooked hours forecast at ${w.label.toLowerCase()} workload.</p>`;
    return;
  }
  host.innerHTML = staleLine + top.map(({ wk, hours, exposure }) => `
    <div class="crow">
      <div>
        <div class="nm">${wk.name}</div>
        <div class="st">${wk.state || ""}</div>
        <div class="rs">≈${formatWorkerCount(wk.outdoor_workers)} outdoor workers × ${hours}&thinsp;hr overlooked</div>
      </div>
      <div class="dl">${formatWorkerCount(exposure)}<small>WORKER-HRS</small></div>
    </div>`).join("");
}

/* ------------------------------------------------------------------ */
/* §6 Closing exhibit: the advisory's model of today vs what the       */
/* forecast actually supports, for the selected city.                  */
/* ------------------------------------------------------------------ */
function renderClosing() {
  const host = $id("closing-exhibit");
  if (!host || _selectedCityId == null) return;
  const rel = getRelThreshold();
  const w = getWorkload();
  const todayKey = nowInIst().dateKey;
  const city = UI.cities.find((c) => c.id === _selectedCityId);
  const hourly = buildHourlySeriesForCity(_selectedCityId, UI.latest, rel)
    .filter((h) => h.istDateKey === todayKey);
  const workable = computeWorkableRanges(_selectedCityId, UI.latest, rel, todayKey);
  if (hourly.length === 0 || !workable) { host.innerHTML = '<p class="empty">No forecast for today.</p>'; return; }

  const byHour = new Map(hourly.map((h) => [h.istHour, h]));
  const ticks = [0, 6, 12, 18].map((hr) =>
    `<div class="mini-tick" style="left:${(hr / 24) * 100}%">${String(hr).padStart(2, "0")}</div>`).join("");

  // Row 1 — the advisory's model of the day: a fixed afternoon to avoid,
  // everything else implicitly workable.
  const row1 = Array.from({ length: 24 }, (_, hr) => {
    const h = byHour.get(hr);
    const cls = isInsideHapWindow(hr) ? "m-avoid" : (h && !h.sunUp ? "m-night" : "m-ok");
    return `<div class="mini-cell ${cls}"></div>`;
  }).join("");

  // Row 2 — the forecast's model: sun-up hours below the limit are workable;
  // sun-up hours over it are not, wherever the clock says they are.
  const row2 = Array.from({ length: 24 }, (_, hr) => {
    const h = byHour.get(hr);
    let cls = "m-night";
    if (h && h.sunUp) cls = (h.wbgt_status === 0 && h.wbgt_c != null && h.wbgt_c < rel) ? "m-work" : "m-hot";
    return `<div class="mini-cell ${cls}"></div>`;
  }).join("");

  const fmtRange = (r) => `${hour12(r.startHour)}–${hour12(r.endHour)}`;
  const say2 = workable.ranges.length > 0
    ? `Lower-risk daylight work: ${workable.ranges.map(fmtRange).join(" and ")}`
    : `No daylight hour is under the ${w.label.toLowerCase()}-work limit today`;
  const verdict = workable.ranges.length > 0
    ? `In ${city.name} today, only <strong>${workable.sunUpBelow} of ${workable.sunUpHours}</strong> daylight
       hours are below the ${w.label.toLowerCase()}-work limit, and the forecast can name which ones.
       A fixed clock window has no way to.`
    : `In ${city.name} today, <strong>no daylight hour</strong> is below the ${w.label.toLowerCase()}-work
       limit. No fixed clock window can make this day workable; only a forecast-based advisory
       could say so.`;

  host.innerHTML = `
    <div class="closing-grid">
      <div class="closing-row">
        <div class="closing-row-h">
          <span class="closing-kind">The advisory's day · ${city.name}, today</span>
          <span class="closing-say rule">"Avoid ${hour12(HAP_WINDOW_START)}–${hour12(HAP_WINDOW_END)}"</span>
        </div>
        <div class="mini-cells">${row1}${ticks}</div>
      </div>
      <div class="closing-row">
        <div class="closing-row-h">
          <span class="closing-kind">The forecast's day · same city, same hours</span>
          <span class="closing-say">${say2}</span>
        </div>
        <div class="mini-cells">${row2}${ticks}</div>
      </div>
    </div>
    <div class="strip-legend">
      <span><span class="sw sw-avoid"></span>Advisory says avoid</span>
      <span><span class="sw sw-work"></span>Daylight, below the limit</span>
      <span><span class="sw sw-over"></span>Daylight, over the limit</span>
      <span><span class="sw sw-ok"></span>Night</span>
    </div>
    <p class="closing-verdict">${verdict} Below the limit means lower-risk under estimated-WBGT
      assumptions.</p>`;
}

/* ------------------------------------------------------------------ */
async function initUi() {
  initTip();
  UI = await loadAllData();
  renderTimestamp(UI.latest);
  renderWorkloadSeg();
  renderFinding();
  initCityControls();
  initContextBar();
  initScrollSpy();

  document.addEventListener("workloadchange", () => {
    renderWorkloadSeg();
    renderFinding();
    renderDayStrip();
    renderClosing();
  });

  // Lazy secondary files: leaderboard inputs and the HAP quotes.
  Promise.all([
    fetch("data/district_workers.json").then((r) => r.json()),
    fetch("data/districts_daily.json").then((r) => r.json()),
  ]).then(([workers, daily]) => {
    _districtStats = { workers, daily };
    renderLeaderboard();
  }).catch((err) => {
    console.error(err);
    const el = $id("overlooked-list");
    if (el) el.innerHTML = '<p class="empty">Could not load district workforce data.</p>';
  });

  fetch("data/hap.json")
    .then((r) => { if (!r.ok) throw new Error(`hap.json ${r.status}`); return r.json(); })
    .then((hap) => { _hap = hap; renderPlansGrid(); renderDayHap(); })
    .catch(() => {
      const grid = $id("plans-grid");
      if (grid) grid.innerHTML = '<p class="empty">Could not load the plan quotes.</p>';
    });
}

initUi().catch((err) => {
  console.error(err);
  $id("hl-count").textContent = "—";
  $id("finding-foot").textContent = "Could not load data: " + err.message;
});
