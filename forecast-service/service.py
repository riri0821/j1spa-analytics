"""Forecasting workspace service: pull an item's monthly demand history,
run the five-model comparison, and translate the winning forecast into a
30-day demand figure, a forward daily curve for the chart, and a
days-to-depletion / coverage-gap estimate (paper 3.5 / 3.10.3).

Adapted from app/forecast/service.py:
  - monthly_series() now calls the monthly_demand() Postgres function
    (sql/migrations/003_phase3_forecast_function.sql) instead of joining the old
    MySQL warehouse's fact_transactions/dim_date/dim_product star schema,
    which no longer exists in the Postgres migration.
  - _daily_curve() takes an already-computed multi-step forecast instead
    of fitting the model itself.
  - Added the fingerprint-keyed model cache below (ARIMA/Holt-Winters fits
    are the slow part of a run, and toggling the model-comparison pills or
    re-opening a SKU was refitting everything from scratch every time).

One full-series fit per model per request, total. evaluate_one() produces a
model's backtest metrics, its next-month figure *and* its multi-step path
from a single fit, out to models.MAX_PATH_MONTHS; everything downstream -
the chart's daily ramp, the monthly table, every horizon in the dropdown -
slices that path rather than refitting. Earlier versions fit ARIMA and
Holt-Winters on the identical series twice per request (once for "next",
once for the chart), and refit both whenever the horizon changed. Verified
byte-identical output across 3,528 scenarios (6 demand shapes x 12 history
lengths x 7 model subsets x 7 horizons) against the two-fit version."""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import pandas as pd

from config import config
from db import supabase
from evaluate import evaluate_one, candidate_names
from models import forecast_path, SHORT


def _fingerprint(y: pd.Series) -> tuple:
    """Hashable snapshot of a monthly series' actual content (period + value
    pairs), used as the cache key below. A cache hit is only possible when
    this exact sales history comes back unchanged, so the cache can never
    serve a stale result - it busts itself the moment new data lands, with
    no TTL or manual invalidation to get wrong. Values are kept at full
    float precision (not rounded) since the reconstructed series is what
    actually gets re-fit - rounding here would silently perturb the ARIMA/
    Holt-Winters optimizers' inputs."""
    return tuple((str(p), float(v)) for p, v in y.items())


def _series_from_fingerprint(fp: tuple) -> pd.Series:
    idx = pd.PeriodIndex([p for p, _ in fp], freq="M")
    return pd.Series([v for _, v in fp], index=idx)


@lru_cache(maxsize=1024)
def _evaluate_one_cached(fp: tuple, backtest_months: int, name: str) -> dict | None:
    return evaluate_one(_series_from_fingerprint(fp), name, backtest_months)


def _evaluate_all_cached(fp: tuple, backtest_months: int,
                         min_months_history: int, allowed_key: tuple | None) -> dict:
    """Same contract as evaluate.evaluate_all(), but cached per model rather
    than per model-combination: flipping a model-comparison pill reuses every
    already-fit model instead of redoing the whole comparison. Fit
    sequentially, not in threads - these are CPU-bound numpy/statsmodels fits
    held under the GIL, not I/O, so extra threads just add context-switching
    overhead on top of Render's single shared vCPU instead of any real
    parallelism."""
    y = _series_from_fingerprint(fp)
    allowed = set(allowed_key) if allowed_key else None
    names, insufficient = candidate_names(y, min_months_history, allowed)

    results, paths = {}, {}
    for name in names:
        m = _evaluate_one_cached(fp, backtest_months, name)
        if m is not None:
            # Copy before touching it: _evaluate_one_cached hands back the
            # *cached* dict, so popping in place would corrupt the cache
            # entry for every later request on this series.
            m = dict(m)
            paths[name] = m.pop("path")
            results[name] = m

    if not results:
        return {"insufficient_history": True, "models": {}, "chosen": None,
                "forecast_next_month": 0.0, "path": ()}

    chosen = min(results.items(), key=lambda kv: kv[1]["mse"])[0]
    return {
        "insufficient_history": insufficient,
        "models": results,
        "chosen": chosen,
        "forecast_next_month": results[chosen]["next"],
        "path": paths[chosen],
    }


@lru_cache(maxsize=256)
def _long_path_cached(fp: tuple, name: str, steps: int) -> tuple[float, ...]:
    """Only for a horizon past the UI's longest (90 days), which needs a path
    longer than MAX_PATH_MONTHS. The API takes an arbitrary ?horizon=, so this
    stays reachable; every request the app itself makes slices the fit the
    model comparison already paid for and never gets here."""
    return tuple(forecast_path(name, _series_from_fingerprint(fp), steps))


def monthly_series(sku: str) -> pd.Series:
    """Gap-free monthly unit-demand series for one SKU."""
    resp = supabase.rpc("monthly_demand", {"p_sku": sku}).execute()
    rows = resp.data or []
    if not rows:
        return pd.Series(dtype=float)
    idx = pd.PeriodIndex(
        [pd.Period(year=r["year"], month=r["month"], freq="M") for r in rows], freq="M")
    s = pd.Series([float(r["units"]) for r in rows], index=idx)
    full = pd.period_range(s.index.min(), s.index.max(), freq="M")
    return s.reindex(full, fill_value=0.0)


def _product_ctx(sku: str) -> dict | None:
    resp = (
        supabase.table("products")
        .select("product_id, sku, name, stock_on_hand, reorder_point, unit_cost, unit_price")
        .eq("sku", sku)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return None
    r = rows[0]
    return {"product_id": r["product_id"], "sku": r["sku"], "name": r["name"],
            "stock_on_hand": r["stock_on_hand"], "reorder_point": r["reorder_point"],
            "unit_cost": float(r["unit_cost"]), "unit_price": float(r["unit_price"])}


def _fetch_inputs(sku: str) -> tuple[dict | None, pd.Series]:
    """The product row and the demand history, fetched concurrently.

    Unlike the model fits, these two are *I/O*: two independent Supabase
    round trips of a few hundred ms each, and nothing in either depends on
    the other. A thread apiece genuinely overlaps them, because both sit in
    httpx with the GIL released. This is not a contradiction of
    _evaluate_all_cached's note on keeping the fits sequential - that applies
    to CPU-bound numpy/statsmodels work, which threads cannot speed up.
    """
    with ThreadPoolExecutor(max_workers=2) as pool:
        ctx_future = pool.submit(_product_ctx, sku)
        series_future = pool.submit(monthly_series, sku)
        return ctx_future.result(), series_future.result()


def _daily_curve(y: pd.Series, path_months: list[float], horizon: int) -> tuple[list[float], float]:
    """A smooth day-by-day demand path for the chart's forecast segment.
    Ramps from the last observed daily rate toward the model's next-month
    rate, extended with the second month if the horizon needs it.
    `path_months` must already cover enough months (see forecast_product)."""
    last_month_units = float(y.iloc[-1]) if len(y) else path_months[0]
    start_rate = last_month_units / 30.0
    curve = []
    for d in range(1, horizon + 1):
        mo = (d - 1) // 30
        target_rate = path_months[min(mo, len(path_months) - 1)] / 30.0
        frac = ((d - 1) % 30 + 1) / 30.0
        base = (path_months[mo - 1] / 30.0) if mo > 0 else start_rate
        curve.append(round(base + (target_rate - base) * frac, 4))
    total = round(sum(curve), 2)
    return curve, total


def forecast_product(sku: str, horizon: int | None = None,
                     allowed: set | None = None) -> dict:
    horizon = int(horizon or config.FORECAST_HORIZON_DAYS)
    ctx, y = _fetch_inputs(sku)
    if ctx is None:
        return {"error": f"Unknown SKU {sku}"}

    hist = [{"period": str(p), "label": p.strftime("%b %Y"), "units": float(v)}
            for p, v in y.items()]

    if y.empty or y.sum() == 0:
        return {**ctx, "horizon": horizon, "months_history": int(len(y)),
                "insufficient_history": True,
                "reason": "no confirmed sales history yet",
                "models": {}, "chosen": None, "best_fit_short": None,
                "forecast_30d": 0.0, "forecast_curve": [0.0] * horizon,
                "forecast_monthly": [],
                "days_to_depletion": None, "coverage_gap": None,
                "stockout_risk": False, "history": hist}

    fp = _fingerprint(y)
    allowed_key = tuple(sorted(allowed)) if allowed else None
    ev = _evaluate_all_cached(fp, config.BACKTEST_MONTHS, config.MIN_MONTHS_HISTORY, allowed_key)
    best = ev["chosen"]

    # No fit here at all. The model comparison above already produced the
    # chosen model's multi-step path off the same fit it used for the
    # next-month figure, out to MAX_PATH_MONTHS - so the chart's daily ramp
    # (which needs one extra month to interpolate across a month boundary)
    # and the monthly table below are both just slices of it. Switching the
    # horizon dropdown or a model pill therefore refits nothing: it reuses
    # the per-model cache entries and re-slices.
    n_months = max(1, -(-horizon // 30))  # ceil(horizon / 30)
    needed = n_months + 1
    path = ev["path"]
    if len(path) < needed:                # horizon beyond the UI's 90 days
        path = _long_path_cached(fp, best, needed)
    path_months = list(path[:needed])

    curve, forecast_total = _daily_curve(y, path_months, horizon)
    forecast_30d = round(forecast_total * (30.0 / horizon), 2) if horizon != 30 else forecast_total

    future_idx = pd.period_range(y.index[-1] + 1, periods=n_months, freq="M")
    forecast_monthly = [{"period": str(p), "label": p.strftime("%b %Y"), "units": round(v, 2)}
                        for p, v in zip(future_idx, path_months[:n_months])]
    per_day = forecast_total / horizon if forecast_total > 0 else 0.0
    dtd = round(ctx["stock_on_hand"] / per_day, 1) if per_day > 0 else None
    coverage_gap = ctx["stock_on_hand"] - round(forecast_30d)
    stockout_risk = (dtd is not None and dtd <= horizon) or coverage_gap < 0

    models = {}
    for name, m in ev["models"].items():
        models[name] = {**m, "short": SHORT.get(name, name),
                        "chosen": name == best}

    return {
        **ctx,
        "horizon": horizon,
        "months_history": int(len(y)),
        "observations_used": int((y > 0).sum()),
        "insufficient_history": ev["insufficient_history"],
        "models": models,
        "chosen": best,
        "best_fit_short": SHORT.get(best, best),
        "forecast_next_month": ev["forecast_next_month"],
        "forecast_30d": forecast_30d,
        "forecast_total_horizon": forecast_total,
        "forecast_curve": curve,
        "forecast_monthly": forecast_monthly,
        "days_to_depletion": dtd,
        "coverage_gap": coverage_gap,
        "stockout_risk": bool(stockout_risk),
        "history": hist,
        "as_of": pd.Timestamp.today().strftime("%b %d, %Y"),
    }
