"""
Trend statistics for the 1980-2024 overlooked-hours history --
heat/data/trend_stats.json.

Replaces the old "up ~X% since the 1980s" claim (a bare decade-mean
comparison with no significance test) with a defensible one: for every
city x workload x series (ovl, ovl_hi, ovl_lo), a Mann-Kendall trend test
(two-sided, normal approximation, tie-corrected) and a Theil-Sen slope
with a Gilbert (1987)/Sen (1968) 95% confidence interval. The decade means
the old display used are still reported, alongside the honest verdict, so
the frontend can show both.

Re-run whenever scripts/compute_trends.py regenerates heat/data/trends.json.
This script reads trends.json's own meta.generated_at_utc and stamps it
into trend_stats.json's meta, so a stale trend_stats.json is self-evident
(compare the two "generated" timestamps) without embedding a fresh
wall-clock time here.

    python3 scripts/trend_stats.py

Method reference: Gilbert, R.O. (1987), Statistical Methods for
Environmental Pollution Monitoring, ch. 16 (Mann-Kendall test, S variance
with tie correction, Sen's slope estimator and its confidence interval).
Cross-checked against scipy.stats.kendalltau (asymptotic, untied x) and
scipy.stats.theilslopes -- see tests/test_trend_stats.py.
"""

import calendar
import json
import math
import os
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
TRENDS_PATH = os.path.join(HERE, "..", "heat", "data", "trends.json")
OUTPUT_PATH = os.path.join(HERE, "..", "heat", "data", "trend_stats.json")

WORKLOADS = ["light", "moderate", "heavy", "very-high"]
BAND_SERIES = ["ovl_hi", "ovl_lo"]  # reported alongside the primary "ovl" series
MIN_COVERAGE = 0.95
DECADE_YEARS = 10
Z_975 = 1.959963985  # standard normal 97.5th percentile (95% two-sided CI)
ALPHA_SIG = 0.05


def expected_hours(year):
    return 8784 if calendar.isleap(year) else 8760


def normal_cdf(z):
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2)))


def mann_kendall_sen(years, values):
    """Tie-corrected Mann-Kendall test + Theil-Sen slope/CI on (years, values).

    years: strictly increasing (gaps allowed -- coverage exclusion can make
    the series non-contiguous). values: same length.

    Returns a dict with s, z, p, slope_per_year, ci_low_per_year,
    ci_high_per_year (CI keys None if not computable, e.g. constant series).
    """
    n = len(values)
    s = 0
    slopes = []
    for i in range(n - 1):
        yi, ti = values[i], years[i]
        for j in range(i + 1, n):
            dy = values[j] - yi
            dt = years[j] - ti
            if dy > 0:
                s += 1
            elif dy < 0:
                s -= 1
            slopes.append(dy / dt)
    slopes.sort()
    nt = len(slopes)
    slope = slopes[nt // 2] if nt % 2 else (slopes[nt // 2 - 1] + slopes[nt // 2]) / 2.0

    counts = Counter(values)
    tie_term = sum(t * (t - 1) * (2 * t + 5) for t in counts.values() if t > 1)
    var_s = (n * (n - 1) * (2 * n + 5) - tie_term) / 18.0

    if var_s <= 0:
        z = 0.0
    elif s > 0:
        z = (s - 1) / math.sqrt(var_s)
    elif s < 0:
        z = (s + 1) / math.sqrt(var_s)
    else:
        z = 0.0
    p = 2.0 * (1.0 - normal_cdf(abs(z)))

    ci_low = ci_high = None
    if var_s > 0 and nt > 0:
        sigma = math.sqrt(var_s)
        # Sen (1968) eq. 2.6 / Gilbert (1987) p.218 rank indices, 0-based.
        ru = min(round((nt + Z_975 * sigma) / 2.0), nt - 1)
        rl = max(round((nt - Z_975 * sigma) / 2.0) - 1, 0)
        ci_low, ci_high = slopes[int(rl)], slopes[int(ru)]

    return {
        "s": s, "z": z, "p": p,
        "slope_per_year": slope,
        "ci_low_per_year": ci_low,
        "ci_high_per_year": ci_high,
    }


def verdict_of(p, z):
    if p < ALPHA_SIG:
        return "increasing" if z > 0 else "decreasing"
    return "no_detectable_trend"


def decade_mean(years, values, start, end):
    picked = [v for yr, v in zip(years, values) if start <= yr <= end]
    return sum(picked) / len(picked) if picked else None


def round_or_none(x, nd):
    return None if x is None else round(x, nd)


def stats_for_series(years, values):
    mk = mann_kendall_sen(years, values)
    verdict = verdict_of(mk["p"], mk["z"])
    return {
        "verdict": verdict,
        "mk_s": mk["s"],
        "mk_z": round(mk["z"], 3),
        "mk_p": round(mk["p"], 4),
        "sen_slope_per_decade": round(mk["slope_per_year"] * DECADE_YEARS, 2),
        "sen_ci_low_per_decade": round_or_none(
            mk["ci_low_per_year"] and mk["ci_low_per_year"] * DECADE_YEARS, 2),
        "sen_ci_high_per_decade": round_or_none(
            mk["ci_high_per_year"] and mk["ci_high_per_year"] * DECADE_YEARS, 2),
    }


def build_city_workload(years, city, workload):
    """years: full 1980-2024 list. city: one city's dict from trends.json."""
    valid = city["valid"]
    included_years = [yr for i, yr in enumerate(years) if valid[i] >= MIN_COVERAGE * expected_hours(yr)]
    excluded_years = [yr for yr in years if yr not in included_years]
    idx_by_year = {yr: i for i, yr in enumerate(years)}

    out = {"n_years": len(included_years)}
    series = city[workload]

    primary = None
    for key in ["ovl"] + BAND_SERIES:
        vals = [series[key][idx_by_year[yr]] for yr in included_years]
        s = stats_for_series(included_years, vals)
        early = decade_mean(included_years, vals, years[0], years[0] + DECADE_YEARS - 1)
        late = decade_mean(included_years, vals, years[-1] - DECADE_YEARS + 1, years[-1])
        s["early_mean"] = round_or_none(early, 1)
        s["late_mean"] = round_or_none(late, 1)
        if key == "ovl":
            primary = s
            out.update(primary)
        else:
            out.setdefault("band", {})[key] = s

    hi_verdict = out["band"]["ovl_hi"]["verdict"]
    lo_verdict = out["band"]["ovl_lo"]["verdict"]
    out["robust_to_band"] = (hi_verdict == primary["verdict"] == lo_verdict)

    if excluded_years:
        out["excluded_years"] = excluded_years
    return out


def build_aggregate(cities_out):
    agg = {}
    for workload in WORKLOADS:
        slopes = [c[workload]["sen_slope_per_decade"] for c in cities_out.values() if workload in c]
        verdicts = [c[workload]["verdict"] for c in cities_out.values() if workload in c]
        slopes_sorted = sorted(slopes)
        n = len(slopes_sorted)
        median_slope = (slopes_sorted[n // 2] if n % 2
                         else (slopes_sorted[n // 2 - 1] + slopes_sorted[n // 2]) / 2.0)
        agg[workload] = {
            "n_cities": n,
            "median_slope_per_decade": round(median_slope, 2),
            "n_increasing": verdicts.count("increasing"),
            "n_decreasing": verdicts.count("decreasing"),
            "n_no_detectable_trend": verdicts.count("no_detectable_trend"),
        }
    return agg


def build(trends):
    year_list = trends["years"]  # already the full 1980..2024 list, not a [start, end] pair
    cities_out = {}
    cities_with_exclusions = []
    for cid, city in trends["cities"].items():
        city_out = {}
        for workload in WORKLOADS:
            city_out[workload] = build_city_workload(year_list, city, workload)
        if any("excluded_years" in city_out[w] for w in WORKLOADS):
            cities_with_exclusions.append(cid)
        cities_out[cid] = city_out

    return {
        "meta": {
            "method": (
                "Mann-Kendall trend test (two-sided, normal approximation, "
                "tie-corrected variance per Gilbert 1987 ch.16) on each city's "
                "annual overlooked-hours series (ovl), plus its REL+/-1C "
                "sensitivity band (ovl_hi, ovl_lo). Theil-Sen slope (median of "
                "all pairwise slopes) with a 95% CI via the Sen (1968)/Gilbert "
                "(1987) rank method. verdict is increasing/decreasing only if "
                "mk_p < 0.05; robust_to_band is true if ovl, ovl_hi and ovl_lo "
                "all agree on the verdict. Years with valid hours < 95% of the "
                "calendar total are excluded per-city (see excluded_years)."
            ),
            "generated_note": (
                "Derived from heat/data/trends.json; re-run this script "
                "whenever that file is regenerated."
            ),
            "trends_generated_at_utc": trends["meta"]["generated_at_utc"],
            "years": [year_list[0], year_list[-1]],
            "min_coverage_fraction": MIN_COVERAGE,
            "alpha": ALPHA_SIG,
            "cities_with_excluded_years": cities_with_exclusions,
        },
        "aggregate": build_aggregate(cities_out),
        "cities": cities_out,
    }


def main():
    with open(TRENDS_PATH, "r", encoding="utf-8") as f:
        trends = json.load(f)
    output = build(trends)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=1)
    size_kb = os.path.getsize(OUTPUT_PATH) / 1024
    print(f"Wrote {OUTPUT_PATH} ({size_kb:.0f} KB, {len(output['cities'])} cities)")


if __name__ == "__main__":
    main()
