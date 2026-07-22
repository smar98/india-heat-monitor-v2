/*
 * map.js — the India map (§3). Light "paper" theme, no raster tiles: the
 * vendored DataMeet state shapes are the landmass. Three layers:
 *   - districts (DEFAULT): Census-2011 outdoor workers × today's overlooked
 *     hours (sequential heat ramp choropleth, darker = more) — the workers
 *     are the point of the page, so they open the map;
 *   - eshram: e-Shram registry registrations (agriculture + construction,
 *     2021–present) as a recency cross-check on the census workforce map;
 *   - cities: today's overlooked hours per city (dot size + heat ramp fill;
 *     nonzero dots ringed in the flag crimson, matching the day strip).
 */

const MAP_THEME = {
  land: "#F0EDE4",
  border: "#CFC9BA",
  ramp: ["#F5E7CB", "#ECBF7A", "#DE9245", "#C2611F", "#8C3213"],
  flag: "#B3242C",
  zeroDot: "#B8B2A4",
  zeroFill: "#E8E5DC",
  noData: "#F7F5EF",
};

/* Continuous ramp for city dots: interpolate across the 5 stops. */
function _hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function heatRamp(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = MAP_THEME.ramp;
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = _hexToRgb(stops[i]), b = _hexToRgb(stops[i + 1]);
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
}

/* Quantile bins for a right-skewed positive series; deduped so the legend
   stays strictly increasing even when quantiles collide. */
function quantileBins(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  const q = (p) => v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0;
  return [...new Set([q(0.4), q(0.7), q(0.9), q(0.98)])].sort((a, b) => a - b);
}
function binColor(value, bins) {
  if (value <= 0) return MAP_THEME.zeroFill;
  for (let i = 0; i < bins.length; i++) {
    if (value <= bins[i]) return MAP_THEME.ramp[i];
  }
  return MAP_THEME.ramp[Math.min(bins.length, MAP_THEME.ramp.length - 1)];
}

async function initMap() {
  const { cities, latest } = await loadAllData();
  const records = buildCityRecords(cities, latest);

  let workStressById = new Map();
  function recomputeWorkStress() {
    const rel = getRelThreshold();
    const todayKey = nowInIst().dateKey;
    workStressById = new Map();
    for (const r of records) {
      const ws = computeCityWorkStress(r.id, latest, rel, todayKey);
      if (ws) workStressById.set(r.id, ws);
    }
  }
  recomputeWorkStress();

  const INDIA_BOUNDS = [[8, 68], [37, 97]];
  const map = L.map("map", {
    scrollWheelZoom: false, // page scroll must not fight the map; zoom buttons + drag still work
    minZoom: 4,
    maxZoom: 9,
    maxBounds: [[2, 55], [42, 110]],
    attributionControl: true,
    zoomControl: false,
  }).fitBounds(INDIA_BOUNDS, { padding: [8, 8] });
  L.control.zoom({ position: "topright" }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution(
    'Boundaries: <a href="https://github.com/datameet/maps">DataMeet</a> (MIT)');
  map.on("focus click", () => map.scrollWheelZoom.enable());
  map.on("blur", () => map.scrollWheelZoom.disable());

  const markers = [];
  let labelMarkers = [];
  let currentLayer = "districts"; // the workers open the map

  fetch("data/india_states.geojson")
    .then((r) => r.json())
    .then((geo) => {
      L.geoJSON(geo, {
        style: { color: MAP_THEME.border, weight: 0.8, opacity: 1, fillColor: MAP_THEME.land, fillOpacity: 1 },
        interactive: false,
      }).addTo(map);
      for (const { marker } of markers) marker.bringToFront();
      if (districtLayer) districtLayer.bringToFront();
    });

  function styleFor(record) {
    const ws = workStressById.get(record.id);
    const count = ws ? ws.shoulder : 0;
    const maxCount = Math.max(1, ...[...workStressById.values()].map((v) => v.shoulder));
    return {
      radius: count <= 0 ? 3.5 : 5 + Math.min(11, count * 1.6),
      fill: count <= 0 ? MAP_THEME.zeroDot : heatRamp(count / maxCount),
      stroke: count <= 0 ? "#FFFFFF" : MAP_THEME.flag, // the crimson ring = the overlooked flag
      weight: count <= 0 ? 1 : 2,
      opacity: count <= 0 ? 0.7 : 0.95,
    };
  }

  function popupHtml(record) {
    const ws = workStressById.get(record.id);
    const w = getWorkload();
    const flagLine = ws && ws.shoulder > 0
      ? `<div class="popup-flag">${ws.shoulder} overlooked hour${ws.shoulder === 1 ? "" : "s"} today
         for ${w.label.toLowerCase()} work${ws.shoulderHours.length ? ` (${ws.shoulderHours.map((h) => h.istLabel).join(", ")} IST)` : ""}</div>`
      : `<div class="popup-meta">No overlooked hours today at ${w.label.toLowerCase()} workload.</div>`;
    return `
      <div class="popup-city">${record.name}</div>
      <div class="popup-state">${record.state}</div>
      ${ws ? `<div class="popup-row"><span class="label">Over limit, inside 11–5 window</span><span class="value">${ws.insideWindow}&thinsp;hr</span></div>` : ""}
      ${ws ? `<div class="popup-row"><span class="label">Over limit after dark</span><span class="value">${ws.darkHumid}&thinsp;hr</span></div>` : ""}
      ${flagLine}`;
  }

  for (const record of records) {
    const s = styleFor(record);
    const marker = L.circleMarker([record.lat, record.lon], {
      radius: s.radius, fillColor: s.fill, color: s.stroke, weight: s.weight, fillOpacity: s.opacity,
    });
    marker.bindPopup(() => popupHtml(record));
    markers.push({ record, marker });
  }

  /* Name labels for the top-5 overlooked cities (cities layer only). */
  function renderLabels() {
    for (const lm of labelMarkers) map.removeLayer(lm);
    labelMarkers = [];
    if (currentLayer !== "overlooked") return;
    const top = [...workStressById.entries()]
      .map(([id, ws]) => ({ id, shoulder: ws.shoulder }))
      .filter((x) => x.shoulder > 0)
      .sort((a, b) => b.shoulder - a.shoulder)
      .slice(0, 5);
    for (const { id } of top) {
      const record = records.find((r) => r.id === id);
      if (!record) continue;
      labelMarkers.push(L.marker([record.lat, record.lon], {
        icon: L.divIcon({ className: "city-lbl", html: record.name, iconAnchor: [-10, 7] }),
        interactive: false, keyboard: false,
      }).addTo(map));
    }
  }

  // ---------------- district layers (workers × hours, and e-Shram) ----------------
  let districtBundle = null;
  let districtLoadPromise = null;
  let districtLayer = null;
  let workerBins = [];
  let eshramBins = [];

  function loadDistrictBundle() {
    if (!districtLoadPromise) {
      districtLoadPromise = Promise.all([
        fetch("data/india_districts_2011.geojson").then((r) => r.json()),
        fetch("data/district_workers.json").then((r) => r.json()),
        fetch("data/districts_daily.json").then((r) => r.json()),
        fetch("data/district_eshram.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]).then(([geo, workers, daily, eshram]) => {
        districtBundle = { geo, workers, daily, eshram };
        return districtBundle;
      });
    }
    return districtLoadPromise;
  }

  function districtInfo(code) {
    const w = districtBundle.workers.districts[String(code)];
    const d = districtBundle.daily.districts[String(code)];
    if (!w || !d) return null;
    const hours = d.o[getWorkload().key] || 0;
    return { workers: w, hours, maxWbgt: d.max_wbgt, exposure: w.outdoor_workers * hours };
  }

  function eshramInfo(code) {
    const e = districtBundle.eshram && districtBundle.eshram.districts[String(code)];
    if (!e) return null;
    return { agri: e.agri, constr: e.constr, total: e.agri + e.constr };
  }

  function computeDistrictBins() {
    const expo = [], regs = [];
    for (const feat of districtBundle.geo.features) {
      const info = districtInfo(feat.properties.censuscode);
      if (info) expo.push(info.exposure);
      const e = eshramInfo(feat.properties.censuscode);
      if (e) regs.push(e.total);
    }
    workerBins = quantileBins(expo);
    eshramBins = quantileBins(regs);
  }

  function districtStyle(feature) {
    const code = feature.properties.censuscode;
    let fill = MAP_THEME.noData;
    if (currentLayer === "eshram") {
      const e = eshramInfo(code);
      if (e) fill = binColor(e.total, eshramBins);
    } else {
      const info = districtInfo(code);
      if (info) fill = binColor(info.exposure, workerBins);
    }
    return { fillColor: fill, fillOpacity: 1, color: "#FFFFFF", weight: 0.6, opacity: 1 };
  }

  function districtPopupHtml(feature) {
    const p = feature.properties;
    if (currentLayer === "eshram") {
      const e = eshramInfo(p.censuscode);
      if (!e) {
        return `<div class="popup-city">${p.DISTRICT}</div>
          <div class="popup-state">${p.ST_NM}</div>
          <div class="popup-meta">No e-Shram registrations matched to this 2011 district.</div>`;
      }
      const telangana = p.ST_NM === "Andhra Pradesh"
        ? `<div class="popup-meta">2011 census frame: registrations from Telangana districts carved out
           after 2011 are counted under their undivided Andhra Pradesh parents.</div>` : "";
      return `
        <div class="popup-city">${p.DISTRICT}</div>
        <div class="popup-state">${p.ST_NM}</div>
        <div class="popup-row"><span class="label">Agriculture registrations</span><span class="value">${formatWorkerCount(e.agri)}</span></div>
        <div class="popup-row"><span class="label">Construction registrations</span><span class="value">${formatWorkerCount(e.constr)}</span></div>
        <div class="popup-meta">Registrations on the e-Shram unorganised-worker registry since 2021.
          A cross-check on the census workforce map; it feeds no computed number.</div>
        ${telangana}`;
    }
    const info = districtInfo(p.censuscode);
    if (!info) {
      return `<div class="popup-city">${p.DISTRICT}</div>
        <div class="popup-state">${p.ST_NM}</div>
        <div class="popup-meta">No Census-2011 data for this area.</div>`;
    }
    const w = getWorkload();
    const story = info.hours > 0
      ? `<div class="popup-flag">≈${formatWorkerCount(info.exposure)} worker-hours in the blind spot here
         today (${w.label.toLowerCase()} work): a ranking index rather than measured exposure.</div>`
      : `<div class="popup-meta">No overlooked hours forecast today at ${w.label.toLowerCase()} workload.</div>`;
    return `
      <div class="popup-city">${p.DISTRICT}</div>
      <div class="popup-state">${p.ST_NM}</div>
      <div class="popup-row"><span class="label">Outdoor workers (Census 2011)</span><span class="value">${formatWorkerCount(info.workers.outdoor_workers)}</span></div>
      <div class="popup-row"><span class="label">Overlooked hours today</span><span class="value">${info.hours}&thinsp;hr</span></div>
      <div class="popup-row"><span class="label">Peak est. WBGT today</span><span class="value">${info.maxWbgt != null ? info.maxWbgt.toFixed(1) + "°C" : "n/a"}</span></div>
      ${story}`;
  }

  function renderDistrictLayer() {
    computeDistrictBins();
    if (!districtLayer) {
      districtLayer = L.geoJSON(districtBundle.geo, { style: districtStyle });
      districtLayer.eachLayer((lyr) => {
        lyr.bindPopup(() => districtPopupHtml(lyr.feature));
        const p = lyr.feature.properties;
        lyr.bindTooltip(`${p.DISTRICT} · ${p.ST_NM}`, {
          sticky: true, direction: "top", className: "district-tip", opacity: 1,
        });
      });
    } else {
      districtLayer.setStyle(districtStyle);
    }
    districtLayer.addTo(map);
  }

  function renderLegend() {
    const host = document.getElementById("map-legend");
    if (currentLayer === "districts" || currentLayer === "eshram") {
      if (!districtBundle) { host.innerHTML = ""; return; }
      const bins = currentLayer === "eshram" ? eshramBins : workerBins;
      if (!bins.length) { host.innerHTML = ""; return; }
      const last = bins[bins.length - 1];
      const items = [{ label: "0", color: MAP_THEME.zeroFill }].concat(
        bins.map((b, i) => ({ label: `≤${formatWorkerCount(b)}`, color: MAP_THEME.ramp[i] })),
        [{ label: `>${formatWorkerCount(last)}`, color: MAP_THEME.ramp[Math.min(bins.length, MAP_THEME.ramp.length - 1)] }]
      );
      const title = currentLayer === "eshram"
        ? "e-Shram registrations, agriculture + construction (darker = more):"
        : "Worker-hours in the blind spot today (darker = more):";
      host.innerHTML = `<span>${title}</span>` +
        items.map((s) => `<span class="legend-item"><span class="legend-sq" style="background:${s.color};"></span>${s.label}</span>`).join("");
      return;
    }
    const maxCount = Math.max(1, ...[...workStressById.values()].map((v) => v.shoulder));
    const vals = [...new Set([0, Math.max(1, Math.round(maxCount / 2)), maxCount])];
    host.innerHTML = `<span>Overlooked hours today (darker = more; ring = has overlooked hours):</span>` +
      vals.map((v) => {
        const r = v <= 0 ? 3.5 : 5 + Math.min(11, v * 1.6);
        const fill = v <= 0 ? MAP_THEME.zeroDot : heatRamp(v / maxCount);
        const ring = v <= 0 ? "rgba(28,26,23,.2)" : MAP_THEME.flag;
        return `<span class="legend-item"><span class="legend-dot" style="width:${r * 2}px;height:${r * 2}px;background:${fill};border:2px solid ${ring};"></span>${v}&thinsp;hr</span>`;
      }).join("") + `<span>dot size = hours</span>`;
  }

  function captionFor(layer) {
    if (layer === "districts") {
      return "Each district is shaded by its outdoor workforce (farm, construction and mining " +
        "main workers, Census 2011) × today's overlooked hours: where the blind spot lands on the " +
        "most people. Post-2011 districts appear within their 2011 parent boundaries. One forecast " +
        "point per district.";
    }
    if (layer === "eshram") {
      const corr = districtBundle && districtBundle.eshram && districtBundle.eshram.meta
        ? districtBundle.eshram.meta.spearman_vs_census_outdoor : null;
      return "Recency cross-check: registrations of unorganised agriculture and construction workers " +
        "on e-Shram (Ministry of Labour registry, 2021–present), folded into 2011 district boundaries. " +
        "Registrations are incentive-driven, vary in completeness by state, and exclude the formal " +
        "workforce, so read this layer by rank." +
        (corr != null ? ` District-for-district it agrees with the census workforce map at a rank correlation of ≈${corr.toFixed(2)}.` : "");
    }
    return "Each dot is one of the 50 cities; size and color show how many of today's " +
      "recommended morning/evening hours are forecast over the heat-stress limit at the selected " +
      "workload. Click a dot for the hour-by-hour breakdown.";
  }

  function redraw() {
    document.querySelectorAll(".layer-btn").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.layer === currentLayer));
    });
    const captionEl = document.getElementById("layer-caption");

    if (currentLayer === "districts" || currentLayer === "eshram") {
      for (const { marker } of markers) map.removeLayer(marker);
      renderLabels();
      if (!districtBundle) {
        captionEl.textContent = "Loading district boundaries, workforce and today's forecast…";
        loadDistrictBundle().then(() => {
          if (currentLayer !== "overlooked") redraw();
        }).catch((err) => {
          console.error(err);
          captionEl.textContent = "Could not load district data: " + err.message;
        });
        renderLegend();
        return;
      }
      if (currentLayer === "eshram" && !districtBundle.eshram) {
        captionEl.textContent = "The e-Shram registry file could not be loaded.";
        renderLegend();
        return;
      }
      renderDistrictLayer();
      let caption = captionFor(currentLayer);
      const todayKey = nowInIst().dateKey;
      if (currentLayer === "districts" && districtBundle.daily.ist_date !== todayKey) {
        caption = `⚠ District heat shown is for ${districtBundle.daily.ist_date} (IST); today's refresh hasn't landed yet. ` + caption;
      }
      captionEl.textContent = caption;
      renderLegend();
      return;
    }

    if (districtLayer) map.removeLayer(districtLayer);
    for (const { record, marker } of markers) {
      if (!map.hasLayer(marker)) marker.addTo(map);
      const s = styleFor(record);
      marker.setStyle({ radius: s.radius, fillColor: s.fill, color: s.stroke, weight: s.weight, fillOpacity: s.opacity });
    }
    renderLabels();
    renderLegend();
    captionEl.textContent = captionFor("overlooked");
  }

  document.querySelectorAll(".layer-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentLayer = btn.dataset.layer;
      redraw();
    });
  });

  document.addEventListener("workloadchange", () => {
    recomputeWorkStress();
    redraw();
  });

  redraw();
}

initMap().catch((err) => {
  console.error(err);
  document.getElementById("map").innerHTML =
    '<p style="padding:1rem;color:#B3242C;">Could not load map data: ' + err.message + "</p>";
});
