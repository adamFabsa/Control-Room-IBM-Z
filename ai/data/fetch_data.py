"""Downloads the M1 forecast data once: ERCOT hourly demand (EIA-930) and Texas city temperatures (Open-Meteo).

    EIA_API_KEY=... python3 ai/data/fetch_data.py

Writes data/eia930_ercot_hourly.csv and data/openmeteo_texas_hourly.csv (both UTC).
Standard library only. Run on a laptop: the EIA gateway times out from the LinuxONE VM,
so copy data/ to the VM afterwards.
"""
import csv
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "data"
EIA_URL = "https://api.eia.gov/v2/electricity/rto/region-data/data/"
EIA_START = "2015-07-01T00"  # EIA-930 begins July 2015
PAGE = 5000
# ERCOT's big load centres; the forecast weights them by population.
CITIES = {"dallas": (32.78, -96.80), "houston": (29.76, -95.37),
          "san_antonio": (29.42, -98.49), "austin": (30.27, -97.74)}
WEATHER_START = "2005-01-01"


def get_json(url, tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return json.load(r)
        except Exception as e:
            if attempt == tries - 1:
                raise
            print(f"  retry after {e}")
            time.sleep(5 * (attempt + 1))


def fetch_eia(key):
    rows = {}
    offset = 0
    while True:
        params = [("api_key", key), ("frequency", "hourly"), ("data[0]", "value"),
                  ("facets[respondent][]", "ERCO"), ("facets[type][]", "D"), ("facets[type][]", "DF"),
                  ("start", EIA_START), ("sort[0][column]", "period"), ("sort[0][direction]", "asc"),
                  ("offset", offset), ("length", PAGE)]
        resp = get_json(EIA_URL + "?" + urllib.parse.urlencode(params))["response"]
        batch = resp["data"]
        for d in batch:
            if d["value"] is not None:
                rows.setdefault(d["period"], {})[d["type"]] = d["value"]
        offset += len(batch)
        print(f"  EIA {offset}/{resp['total']}")
        if not batch or offset >= int(resp["total"]):
            break
    out = DATA / "eia930_ercot_hourly.csv"
    with out.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time_utc", "demand_mw", "dayahead_forecast_mw"])
        for period in sorted(rows):
            w.writerow([period + ":00", rows[period].get("D", ""), rows[period].get("DF", "")])
    print(f"wrote {out} ({len(rows)} hours)")


def fetch_weather():
    end = date.today().isoformat()
    columns = {}
    for name, (lat, lon) in CITIES.items():
        params = {"latitude": lat, "longitude": lon, "start_date": WEATHER_START, "end_date": end,
                  "hourly": "temperature_2m", "temperature_unit": "fahrenheit", "timezone": "UTC"}
        hourly = get_json("https://archive-api.open-meteo.com/v1/archive?" + urllib.parse.urlencode(params))["hourly"]
        columns["time_utc"] = hourly["time"]
        columns[f"{name}_f"] = hourly["temperature_2m"]
        print(f"  Open-Meteo {name}: {len(hourly['time'])} hours")
    out = DATA / "openmeteo_texas_hourly.csv"
    with out.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(columns)
        w.writerows(zip(*columns.values()))
    print(f"wrote {out}")


if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    fetch_eia(os.environ["EIA_API_KEY"])
    fetch_weather()
