"""M1 demand forecast: linear heating baseline + XGBoost, compared with Granite TTM-R2 and EIA.

Runs in the ai container on LinuxONE:
    podman run --rm -v ~/control-room/data:/app/data -v ~/control-room/ai/models:/app/ai/models \
        -v ~/models:/models localhost/controlroom-ai python3 ai/forecast/train_forecast.py

- Trains on ERCOT hourly demand 2019 to Nov 2024, leaving out Winter Storm Uri (demand was cut by
  blackouts, so it is not real demand).
- Tests on the held-out winters Dec-Feb 2024-25 and 2025-26, next-day forecasts issued at midnight.
- Rebuilds what ERCOT demand would have been during Uri; the gap to measured demand is load shed.
  Trees can't extrapolate past the coldest training hour, so a linear heating baseline carries the
  trend into Uri's cold and XGBoost learns the rest.
- Two variants: "weather" (temperature + calendar, used by the game, which has no demand history)
  and "dayahead" (adds yesterday's and last week's demand, for a fair comparison with EIA).
- Writes ai/models/m1_xgb.json, ai/models/m1_meta.json and data/m1_uri2021_demand.csv.
"""
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.linear_model import LinearRegression

ROOT = Path(__file__).resolve().parents[2]
DATA, MODELS = ROOT / "data", ROOT / "ai" / "models"
TZ = "America/Chicago"
URI = ("2021-02-10", "2021-02-22")  # local dates left out of training
TEST_START = "2024-12-01"
GAME_PEAK_MW = 6500  # Dallas County at storm peak (spec Game numbers)
FEATURES = ["temp", "temp_lag3", "temp_lag6", "temp_mean24", "temp_mean72", "temp_min24",
            "hdd", "hdd72", "cdd", "hour", "dow", "month", "weekend"]
DAYAHEAD_FEATURES = FEATURES + ["demand_lag24", "demand_lag168"]
LINEAR = ["hdd", "hdd72", "cdd"]


def load():
    demand = pd.read_csv(DATA / "eia930_ercot_hourly.csv", parse_dates=["time_utc"])
    temps = pd.read_csv(DATA / "openmeteo_texas_hourly.csv", parse_dates=["time_utc"])
    df = temps.merge(demand, on="time_utc", how="left")
    df["time"] = df["time_utc"].dt.tz_localize("UTC").dt.tz_convert(TZ)
    return df.set_index("time").sort_index()


def add_features(df):
    t = df["dallas_f"]
    out = pd.DataFrame(index=df.index)
    out["temp"] = t
    out["temp_lag3"] = t.shift(3)
    out["temp_lag6"] = t.shift(6)
    out["temp_mean24"] = t.rolling(24, min_periods=1).mean()
    out["temp_mean72"] = t.rolling(72, min_periods=1).mean()  # cold soak: homes and buildings stay cold
    out["temp_min24"] = t.rolling(24, min_periods=1).min()
    out["hdd"] = (60 - t).clip(lower=0)
    out["hdd72"] = (60 - out["temp_mean72"]).clip(lower=0)
    out["cdd"] = (t - 70).clip(lower=0)
    out["hour"] = df.index.hour
    out["dow"] = df.index.dayofweek
    out["month"] = df.index.month
    out["weekend"] = (out["dow"] >= 5).astype(int)
    # Load grows every year; model demand relative to the past year's average, known a day ahead.
    level = df["demand_mw"].rolling(24 * 365, min_periods=24 * 180).mean().shift(24)
    out["demand_lag24"] = df["demand_mw"].shift(24) / level  # known when a next-day forecast is issued
    out["demand_lag168"] = df["demand_mw"].shift(168) / level
    return out, level


def fit_hybrid(X, y, features):
    linear = LinearRegression().fit(X[LINEAR], y)
    trees = xgb.XGBRegressor(n_estimators=600, max_depth=6, learning_rate=0.05, subsample=0.8,
                             colsample_bytree=0.8, n_jobs=3)
    trees.fit(X[features], y - linear.predict(X[LINEAR]))
    return linear, trees


def predict_hybrid(model, X, features):
    linear, trees = model
    return linear.predict(X[LINEAR]) + trees.predict(X[features])


def mape(actual, pred):
    ok = actual.notna() & pred.notna()
    return float((np.abs(actual[ok] - pred[ok]) / actual[ok]).mean() * 100)


def ttm_zero_shot(df, test_days):
    """Granite TTM-R2 (512 hours of context -> 96 ahead), demand history only. None if unavailable."""
    try:
        import torch
        from tsfm_public import TinyTimeMixerForPrediction
    except Exception as e:
        print(f"TTM unavailable: {e}")
        return None, None
    model = TinyTimeMixerForPrediction.from_pretrained("ibm-granite/granite-timeseries-ttm-r2", revision="main")
    model.eval()
    demand = df["demand_mw"]
    contexts, targets = [], []
    for day in test_days:
        past = demand[:day - pd.Timedelta(hours=1)].iloc[-512:]
        if len(past) == 512 and past.notna().all():
            contexts.append(past.to_numpy(dtype=np.float32))
            targets.append(day)
    start = time.perf_counter()
    with torch.no_grad():
        out = model(past_values=torch.tensor(np.stack(contexts))[:, :, None]).prediction_outputs
    seconds = time.perf_counter() - start
    pred = pd.Series(dtype=float)
    for day, values in zip(targets, out[:, :24, 0].numpy()):
        pred = pd.concat([pred, pd.Series(values, index=pd.date_range(day, periods=24, freq="h"))])
    return pred, {"forecasts": len(targets), "seconds": round(seconds, 2)}


def main():
    MODELS.mkdir(parents=True, exist_ok=True)
    df = load()
    X, level = add_features(df)
    y = df["demand_mw"] / level

    in_uri = (df.index >= pd.Timestamp(URI[0], tz=TZ)) & (df.index < pd.Timestamp(URI[1], tz=TZ))
    train = (df.index < pd.Timestamp(TEST_START, tz=TZ)) & ~in_uri & y.notna()
    winter = df.index.month.isin([12, 1, 2])
    test = (df.index >= pd.Timestamp(TEST_START, tz=TZ)) & winter & y.notna()

    start = time.perf_counter()
    weather = fit_hybrid(X[train], y[train], FEATURES)
    train_s = time.perf_counter() - start
    pred = pd.Series(predict_hybrid(weather, X, FEATURES) * level, index=df.index)
    dayahead_train = train & X["demand_lag168"].notna()
    dayahead = fit_hybrid(X[dayahead_train], y[dayahead_train], DAYAHEAD_FEATURES)
    pred_dayahead = pd.Series(predict_hybrid(dayahead, X, DAYAHEAD_FEATURES) * level, index=df.index)

    actual = df["demand_mw"][test]
    test_days = sorted({d for d in actual.index.normalize()})
    ttm_pred, ttm_info = ttm_zero_shot(df, test_days)
    metrics = {
        "test": f"winter days (Dec-Feb) from {TEST_START}, {len(test_days)} days, {int(test.sum())} hours",
        "note": "M1 uses observed temperatures in place of a weather forecast; TTM sees only the "
                "past 512 hours of demand; EIA is the published day-ahead forecast",
        "m1_weather_mape": round(mape(actual, pred[test]), 2),
        "m1_dayahead_mape": round(mape(actual, pred_dayahead[test]), 2),
        "eia_dayahead_mape": round(mape(actual, df["dayahead_forecast_mw"][test]), 2),
        "m1_weather_train_seconds": round(train_s, 1),
        "train_hours": int(train.sum()),
    }
    if ttm_pred is not None:
        metrics["ttm_r2_zero_shot_mape"] = round(mape(actual, ttm_pred.reindex(actual.index)), 2)
        metrics["ttm_inference"] = ttm_info
    print(json.dumps(metrics, indent=2))

    # Uri: what demand would have been, versus what was measured while blackouts ran.
    storm = (df.index >= pd.Timestamp("2021-02-14 18:00", tz=TZ)) & (df.index <= pd.Timestamp("2021-02-19 12:00", tz=TZ))
    uri = pd.DataFrame({"time_local": df.index[storm].strftime("%Y-%m-%dT%H:%M%z"),
                        "dallas_f": df["dallas_f"][storm].round(1),
                        "ercot_forecast_mw": pred[storm].round(),
                        "ercot_measured_mw": df["demand_mw"][storm]})
    uri["estimated_shed_mw"] = (uri["ercot_forecast_mw"] - uri["ercot_measured_mw"]).clip(lower=0).round()
    share = GAME_PEAK_MW / uri["ercot_forecast_mw"].max()
    uri["dallas_county_demand_mw"] = (uri["ercot_forecast_mw"] * share).round()
    uri.to_csv(DATA / "m1_uri2021_demand.csv", index=False)
    print(f"Uri: forecast peak {uri['ercot_forecast_mw'].max():,.0f} MW, measured peak "
          f"{uri['ercot_measured_mw'].max():,.0f} MW, largest gap {uri['estimated_shed_mw'].max():,.0f} MW; "
          f"Dallas County share {share:.4f}")

    linear, trees = weather
    trees.get_booster().save_model(MODELS / "m1_xgb.json")
    meta = {"features": FEATURES, "linear_features": LINEAR,
            "linear": {"intercept": float(linear.intercept_), "coef": linear.coef_.tolist()},
            "target": "demand / trailing 365-day mean demand = linear(linear_features) + xgb(features)",
            "dallas_county_share": share, "level_mw_2021": float(level[storm].mean()), "metrics": metrics}
    (MODELS / "m1_meta.json").write_text(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
