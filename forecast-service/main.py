"""FastAPI entrypoint. Kept as a standalone Python service (not ported to
Node) because the forecasting math (ARIMA, Holt-Winters, scikit-learn
linear regression) has no equivalent JS library with the same fidelity -
see the PERN migration plan. Only the Next.js backend calls this (with
FORECAST_SERVICE_KEY, never exposed to the browser), so it doesn't
duplicate the app's own login - it trusts whoever holds that key."""
import os
import secrets
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Query

from service import forecast_product

INTERNAL_KEY = os.environ["FORECAST_SERVICE_KEY"]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Fit each slow model once on throwaway data before serving traffic.

    Importing statsmodels/sklearn is handled by models.py's module-scope
    imports, but the *first* ARIMA and Holt-Winters fit in a process pays
    another ~1s initialising scipy's optimiser paths. Doing it here means
    the boot absorbs that instead of whoever first presses "Run comparison".
    Uses a synthetic series and throws the result away - it never touches
    the model cache or any real SKU, so it cannot affect a forecast.
    """
    try:
        import pandas as pd
        from models import arima_forecast, holt_winters_forecast

        # 24 points so Holt-Winters takes its seasonal branch - the slowest
        # path, and the one worth warming.
        warm = pd.Series(
            [10.0 + i % 5 for i in range(24)],
            index=pd.period_range("2000-01", periods=24, freq="M"),
        )
        arima_forecast(warm)
        holt_winters_forecast(warm)
    except Exception as exc:  # never block startup on a warm-up failure
        print(f"forecast warm-up skipped: {exc!r}")
    yield


app = FastAPI(title="J1SPA Forecasting Service", lifespan=lifespan)


def require_internal_key(x_internal_key: str = Header(default="")):
    # compare_digest, not !=: a plain string comparison returns as soon as
    # two bytes differ, which leaks the length of the matching prefix
    # through response timing. This key guards a service holding the
    # Supabase service-role key, so it is worth the constant time.
    if not secrets.compare_digest(x_internal_key, INTERNAL_KEY):
        raise HTTPException(status_code=401, detail="Invalid or missing X-Internal-Key.")


@app.get("/health")
def health():
    return {"ok": True}


SHORT_TO_FULL = {
    "MA": "Simple Moving Average", "WMA": "Weighted Moving Average",
    "Linear Regression": "Linear Regression", "ARIMA": "ARIMA",
    "Holt-Winters": "Holt-Winters",
}


@app.get("/forecast/{sku}", dependencies=[Depends(require_internal_key)])
def forecast(sku: str, horizon: int | None = Query(default=None), models: str | None = Query(default=None)):
    allowed = (
        {SHORT_TO_FULL[m] for m in models.split(",") if m in SHORT_TO_FULL}
        if models else None
    )
    result = forecast_product(sku, horizon=horizon, allowed=allowed)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result
