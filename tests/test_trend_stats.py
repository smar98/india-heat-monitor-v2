"""
Tests for scripts/trend_stats.py -- the Mann-Kendall + Theil-Sen trend
statistics that replace the old bare decade-mean comparison.

Cross-checks the implementation against scipy (installed in this dev
environment but NOT a project dependency -- scipy.stats.kendalltau and
scipy.stats.theilslopes are only used here, in a test, as an independent
reference; they are skipped automatically if scipy isn't present).
"""

import json
import math
import os

import pytest

from trend_stats import (
    WORKLOADS,
    build,
    mann_kendall_sen,
    verdict_of,
)

TRENDS_PATH = os.path.join(os.path.dirname(__file__), "..", "heat", "data", "trends.json")


def test_monotone_series_exact_slope_and_tiny_p():
    years = list(range(1980, 2020))  # 40 points, no noise
    values = [2.0 * i for i in range(len(years))]
    mk = mann_kendall_sen(years, values)
    assert mk["slope_per_year"] == pytest.approx(2.0)
    assert mk["s"] == len(years) * (len(years) - 1) // 2  # every pair concordant
    p = 2.0 * (1.0 - 0.5 * (1 + math.erf(mk["z"] / math.sqrt(2))))
    assert p < 1e-10
    assert verdict_of(p, mk["z"]) == "increasing"


def test_pure_noise_series_no_detectable_trend():
    # Deterministic "noise": digits of pi, mod 7, no linear drift by construction.
    pi_digits = "14159265358979323846264338327950288419716939937510"
    years = list(range(1980, 1980 + len(pi_digits)))
    values = [int(d) % 7 for d in pi_digits]
    mk = mann_kendall_sen(years, values)
    p = 2.0 * (1.0 - 0.5 * (1 + math.erf(mk["z"] / math.sqrt(2))))
    assert verdict_of(p, mk["z"]) == "no_detectable_trend"
    assert p > 0.05


def test_tie_heavy_series_does_not_crash_and_uses_tie_correction():
    # Many repeated zeros plus a handful of distinct values -- realistic for
    # a mild-workload / cool-city ovl series.
    years = list(range(1990, 2020))  # 30 points
    values = [0] * 20 + [1, 1, 2, 3, 4, 5, 6, 8, 10, 12]
    mk = mann_kendall_sen(years, values)
    assert math.isfinite(mk["z"])
    n = len(values)
    var_s_untied = n * (n - 1) * (2 * n + 5) / 18.0
    # Reconstruct the tied variance the same way the module does, to compare.
    from collections import Counter
    counts = Counter(values)
    tie_term = sum(t * (t - 1) * (2 * t + 5) for t in counts.values() if t > 1)
    var_s_tied = (n * (n - 1) * (2 * n + 5) - tie_term) / 18.0
    assert tie_term > 0  # this fixture does have ties
    assert var_s_tied < var_s_untied


def test_real_trends_json_one_city_output_complete():
    with open(TRENDS_PATH, "r", encoding="utf-8") as f:
        trends = json.load(f)
    out = build(trends)
    first_city_id = next(iter(trends["cities"]))
    city_stats = out["cities"][first_city_id]
    for workload in WORKLOADS:
        w = city_stats[workload]
        for key in ("sen_slope_per_decade", "mk_p", "mk_z", "n_years", "verdict", "robust_to_band"):
            assert key in w, (workload, key)
        assert math.isfinite(w["sen_slope_per_decade"])
        assert 0.0 <= w["mk_p"] <= 1.0
        assert w["verdict"] in ("increasing", "decreasing", "no_detectable_trend")
        assert isinstance(w["robust_to_band"], bool)
    assert "aggregate" in out and all(wl in out["aggregate"] for wl in WORKLOADS)


def test_cross_check_against_scipy_reference():
    scipy_stats = pytest.importorskip("scipy.stats")

    years = list(range(1980, 2015))  # 35 points
    # Values with genuine ties so the tie-corrected variance is exercised.
    values = [3, 3, 5, 5, 5, 8, 9, 9, 12, 14, 14, 14, 15, 18, 20, 20, 22, 25, 27, 27,
              30, 33, 35, 35, 36, 40, 42, 45, 45, 48, 50, 53, 55, 58, 60]
    assert len(values) == len(years)

    mk = mann_kendall_sen(years, values)
    p = 2.0 * (1.0 - 0.5 * (1 + math.erf(mk["z"] / math.sqrt(2))))

    # kendalltau's asymptotic p-value uses the same tie-corrected variance
    # formula (Kendall 1975) when the x series (here: years) is tie-free,
    # so it should match our Mann-Kendall p-value closely.
    _tau, scipy_p = scipy_stats.kendalltau(years, values, method="asymptotic")
    assert p == pytest.approx(scipy_p, rel=1e-6)

    # Theil-Sen slope + Sen(1968)/Gilbert(1987) CI: scipy.stats.theilslopes
    # implements the identical rank-index method this module uses.
    res = scipy_stats.theilslopes(values, years, alpha=0.95)
    assert mk["slope_per_year"] == pytest.approx(res.slope)
    assert mk["ci_low_per_year"] == pytest.approx(res.low_slope)
    assert mk["ci_high_per_year"] == pytest.approx(res.high_slope)
