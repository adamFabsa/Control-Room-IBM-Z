"""M1 in the game: Dallas County demand from the forecast model (ai/forecast/train_forecast.py).

The engine's demand_mw is a placeholder formula, so the server replaces it with M1's forecast for the
current game hour. Uri uses the series M1 rebuilt from real 2021 temperatures (data/m1_uri2021_demand.csv);
other storms run the model on the storm's own hourly temperatures.
"""
import csv
import json
import logging
from datetime import datetime
from pathlib import Path

import numpy as np

log = logging.getLogger("controlroom.forecast")
ROOT = Path(__file__).resolve().parents[2]


class Forecast:
    def __init__(self):
        self.available = False
        try:
            import xgboost as xgb
            self.xgb = xgb
            self.meta = json.loads((ROOT / "ai" / "models" / "m1_meta.json").read_text())
            self.booster = xgb.Booster()
            self.booster.load_model(str(ROOT / "ai" / "models" / "m1_xgb.json"))
            with open(ROOT / "data" / "m1_uri2021_demand.csv") as f:
                self.uri = {r["time_local"][:13]: float(r["dallas_county_demand_mw"]) for r in csv.DictReader(f)}
            self.available = True
        except Exception as e:
            log.info("M1 not loaded (%s); demand stays the engine's formula", e)

    def dallas_mw(self, state, temps):
        """M1's Dallas County demand for the state's hour; temps are the game's hourly outside °F so far."""
        if state.get("storm") == "uri2021" and state["time"][:13] in self.uri:
            return self.uri[state["time"][:13]]
        temps = temps or [state["outside_f"]]
        t = temps[-1]
        mean72 = float(np.mean(temps[-72:]))
        when = datetime.fromisoformat(state["time"])
        row = {"temp": t, "temp_lag3": temps[max(0, len(temps) - 4)], "temp_lag6": temps[max(0, len(temps) - 7)],
               "temp_mean24": float(np.mean(temps[-24:])), "temp_mean72": mean72, "temp_min24": min(temps[-24:]),
               "hdd": max(0.0, 60 - t), "hdd72": max(0.0, 60 - mean72), "cdd": max(0.0, t - 70),
               "hour": when.hour, "dow": when.weekday(), "month": when.month, "weekend": int(when.weekday() >= 5)}
        linear = self.meta["linear"]
        y = linear["intercept"] + sum(c * row[f] for c, f in zip(linear["coef"], self.meta["linear_features"]))
        X = self.xgb.DMatrix(np.array([[row[f] for f in self.meta["features"]]]), feature_names=self.meta["features"])
        y += float(self.booster.predict(X)[0])
        return y * self.meta["level_mw_2021"] * self.meta["dallas_county_share"]
