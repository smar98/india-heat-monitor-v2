/*
 * trend.js — §5 the long view: overlooked hours per year, 1980–2024 (ERA5),
 * for the selected city and workload. Hand-rolled inline SVG.
 *
 * Statistics come precomputed from heat/data/trend_stats.json (built by
 * scripts/trend_stats.py: tie-corrected Mann-Kendall + Theil–Sen slope with
 * a Sen 1968 95% CI, cross-validated against scipy). "Increasing" is only
 * claimed when MK rejects no-trend at p < 0.05; otherwise the chip says
 * "no detectable trend" — no eyeballed percentages anywhere.
 *
 * Honesty notes rendered with the chart: reanalysis and the live forecast
 * are different data products, never mixed; the 11–5 window is TODAY'S
 * audited union applied to all 45 years; the shaded band is the ±1°C
 * sensitivity, matching §2's.
 */

let _trends = null;
let _trendStats = null;
let _trendLoading = null;

function loadTrendData() {
  if (!_trendLoading) {
    _trendLoading = Promise.all([
      fetch("data/trends.json").then((r) => { if (!r.ok) throw new Error(`trends.json HTTP ${r.status}`); return r.json(); }),
      fetch("data/trend_stats.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([trends, stats]) => { _trends = trends; _trendStats = stats; });
  }
  return _trendLoading;
}

function fmtP(p) { return p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(2)}`; }

function renderTrendAggregate() {
  const el = document.getElementById("trend-agg");
  if (!el || !_trendStats) return;
  const w = getWorkload();
  const agg = _trendStats.aggregate[w.key];
  if (!agg) { el.textContent = ""; return; }
  const noDecrease = agg.n_decreasing === 0
    ? "No city shows a statistically significant decrease."
    : `${agg.n_decreasing} show a significant decrease.`;
  el.innerHTML =
    `At <strong>${w.label.toLowerCase()}</strong> work, the yearly count of overlooked hours shows a
     statistically significant upward trend in <strong class="hot">${agg.n_increasing} of
     ${agg.n_cities} cities</strong>, with a median rise of <strong>+${Math.round(agg.median_slope_per_decade)}
     hours per decade</strong>. ${noDecrease}`;
}

function renderTrend() {
  const host = document.getElementById("trend-chart");
  if (!host || !_trends) return;
  const cityId = typeof getSelectedCityId === "function" ? getSelectedCityId() : null;
  if (cityId == null) return;
  const city = _trends.cities[String(cityId)];
  const w = getWorkload();
  const cityMeta = UI ? UI.cities.find((c) => c.id === cityId) : null;
  const cityName = cityMeta ? cityMeta.name : `city ${cityId}`;

  renderTrendAggregate();
  const nameEl = document.getElementById("trend-cityname");
  if (nameEl) nameEl.textContent = `${cityName} · ${w.label.toLowerCase()} work · ERA5 1980–2024`;

  if (!city || !city[w.key]) {
    host.innerHTML = '<p class="empty">No history available for this city.</p>';
    return;
  }

  const years = _trends.years;
  const ovl = city[w.key].ovl;
  const hi = city[w.key].ovl_hi;   // stricter limit (REL+1): fewer hours
  const lo = city[w.key].ovl_lo;   // looser limit (REL-1): more hours
  const days = city[w.key].days;
  const stats = _trendStats && _trendStats.cities[String(cityId)] && _trendStats.cities[String(cityId)][w.key];

  // ---- verdict chip ----
  const chip = document.getElementById("trend-verdict");
  if (chip) {
    if (!stats) {
      chip.textContent = "";
      chip.className = "verdict-chip";
      chip.hidden = true;
    } else if (stats.verdict === "increasing") {
      chip.hidden = false;
      chip.className = "verdict-chip up";
      chip.textContent = `▲ increasing · +${stats.sen_slope_per_decade.toFixed(0)} h/decade ` +
        `(95% CI ${stats.sen_ci_low_per_decade.toFixed(0)}–${stats.sen_ci_high_per_decade.toFixed(0)}) · ${fmtP(stats.mk_p)}`;
    } else if (stats.verdict === "decreasing") {
      chip.hidden = false;
      chip.className = "verdict-chip flat";
      chip.textContent = `▼ decreasing · ${stats.sen_slope_per_decade.toFixed(0)} h/decade · ${fmtP(stats.mk_p)}`;
    } else {
      chip.hidden = false;
      chip.className = "verdict-chip flat";
      chip.textContent = `no detectable trend (${fmtP(stats.mk_p)})`;
    }
  }

  // ---- geometry ----
  const W = 720, H = 260, padL = 46, padR = 14, padT = 14, padB = 30;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const yMax = Math.max(10, ...lo);
  const x = (i) => padL + (i / (years.length - 1)) * innerW;
  const y = (v) => padT + innerH - (Math.max(0, v) / yMax) * innerH;
  const pathOf = (vals) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  const band = lo.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")
    + " " + hi.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join(" ");

  const step = Math.max(50, Math.ceil(yMax / 4 / 50) * 50);
  let grid = "";
  for (let v = step; v <= yMax; v += step) {
    grid += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="#E7E3D8" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end" class="trend-tick">${v}</text>`;
  }
  let xticks = "";
  years.forEach((yr, i) => {
    if (yr % 10 === 0) {
      xticks += `<line x1="${x(i)}" y1="${padT + innerH}" x2="${x(i)}" y2="${padT + innerH + 4}" stroke="#CFC9BA"/>`
        + `<text x="${x(i)}" y="${padT + innerH + 15}" text-anchor="middle" class="trend-tick">${yr}</text>`;
    }
  });

  // Theil–Sen line: slope from the stats file; intercept = median residual
  // (the standard Theil–Sen intercept), computed here from the same series.
  let senPath = "";
  if (stats) {
    const slopeYr = stats.sen_slope_per_decade / 10;
    const resid = ovl.map((v, i) => v - slopeYr * i).sort((a, b) => a - b);
    const b0 = resid.length % 2 ? resid[(resid.length - 1) / 2]
      : (resid[resid.length / 2 - 1] + resid[resid.length / 2]) / 2;
    senPath = `<line x1="${x(0)}" y1="${y(b0)}" x2="${x(years.length - 1)}" y2="${y(b0 + slopeYr * (years.length - 1))}"
      stroke="#1C1A17" stroke-width="1.6" stroke-dasharray="6 5"/>`;
  }

  const dots = years.map((yr, i) =>
    `<circle cx="${x(i)}" cy="${y(ovl[i])}" r="6" fill="transparent">` +
    `<title>${yr}: ${ovl[i]} overlooked hours (${hi[i]}–${lo[i]} across the ±1°C band), ` +
    `${days[i]} days with ≥1 such hour</title></circle>`
  ).join("");

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img"
         aria-label="Overlooked hours per year in ${cityName}, 1980 to 2024">
      <text x="${padL - 6}" y="${padT - 3}" text-anchor="end" class="trend-tick">hrs/yr</text>
      ${grid}${xticks}
      <polygon points="${band}" fill="rgba(222,146,69,.22)"/>
      <path d="${pathOf(ovl)}" fill="none" stroke="#C2611F" stroke-width="1.8"/>
      ${senPath}
      ${dots}
    </svg>`;

  // ---- the so-what, in human units ----
  const lastIdx = years.length - 1;
  const mean = (arr, a, b) => arr.slice(a, b + 1).reduce((s, v) => s + v, 0) / (b - a + 1);
  const lateHours = stats ? stats.late_mean : mean(ovl, lastIdx - 9, lastIdx);
  const lateDays = Math.round(mean(days, lastIdx - 9, lastIdx));
  const workdays = Math.round(lateHours / 8);

  const takeawayEl = document.getElementById("trend-takeaway");
  if (takeawayEl) {
    if (lateHours < 15) {
      takeawayEl.innerHTML =
        `For ${w.label.toLowerCase()} work this is rare in <strong>${cityName}</strong>: morning and
         evening hours crossed the limit only ≈${Math.round(lateHours)} hours a year over the last decade.`;
    } else {
      takeawayEl.innerHTML =
        `Over the last decade in <strong>${cityName}</strong>, morning and evening hours crossed the
         ${w.label.toLowerCase()}-work limit on <strong class="hot">≈${lateDays} days a year</strong>.
         That is ≈${Math.round(lateHours).toLocaleString("en-IN")} hours annually, the equivalent of
         <strong>${workdays} eight-hour workdays</strong> over the limit inside the hours the
         plans recommend.`;
    }
  }

  const noteEl = document.getElementById("trend-note");
  if (noteEl && stats) {
    const robust = stats.robust_to_band
      ? "The verdict is unchanged if the WBGT estimate runs a full 1°C hot or cold."
      : "Caution: this verdict changes within the ±1°C estimation band, so read it as suggestive rather than settled.";
    noteEl.textContent = robust;
  } else if (noteEl) {
    noteEl.textContent = "";
  }
}

function initTrend() {
  const panel = document.getElementById("sec-trend");
  if (!panel) return;
  let started = false;
  function start() {
    if (started) return;
    started = true;
    loadTrendData()
      .then(() => renderTrend())
      .catch((err) => {
        console.error(err);
        const host = document.getElementById("trend-chart");
        if (host) host.innerHTML =
          '<p class="empty">The 1980–2024 history could not be loaded (' + err.message + ").</p>";
      });
  }
  // Lazy-load when the panel approaches the viewport; timed fallback for
  // contexts where IntersectionObserver never fires.
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
    }, { rootMargin: "400px" });
    io.observe(panel);
    setTimeout(start, 3000);
  } else {
    start();
  }
  document.addEventListener("citychange", () => { if (_trends) renderTrend(); });
  document.addEventListener("workloadchange", () => { if (_trends) renderTrend(); });
}

initTrend();
