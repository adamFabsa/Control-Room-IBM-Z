"""Downloads the M1 forecast data once: ERCOT hourly demand (EIA-930) and Texas city temperatures (Open-Meteo).

    python3 ai/data/fetch_data.py      # on the LinuxONE VM, from ~/control-room

Writes data/eia930_ercot_hourly.csv (UTC, hour ending) and data/openmeteo_texas_hourly.csv (UTC).
Standard library only. Uses EIA's bulk six-month files: the EIA API was timing out.
"""
import csv
import io
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "data"
EIA_FILE = "https://www.eia.gov/electricity/gridmonitor/sixMonthFiles/EIA930_BALANCE_{year}_{half}.csv"
EIA_FIRST_YEAR = 2019
# ERCOT's big load centres; the forecast weights them by population.
CITIES = {"dallas": (32.78, -96.80), "houston": (29.76, -95.37),
          "san_antonio": (29.42, -98.49), "austin": (30.27, -97.74)}
WEATHER_START = "2005-01-01"


def get_json(url, tries=4):
    request = urllib.request.Request(url, headers={"User-Agent": "controlroom-datathon/1.0"})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(request, timeout=120) as r:
                return json.load(r)
        except Exception as e:
            if attempt == tries - 1:
                raise
            print(f"  retry after {e}")
            time.sleep(5 * (attempt + 1))


def _mw(text):
    return float(text.replace(",", "")) if text.strip() else None


def fetch_eia():
    """ERCOT rows from every six-month EIA-930 balance file since 2019 (each file holds all grid operators)."""
    rows = {}
    today = date.today()
    for year in range(EIA_FIRST_YEAR, today.year + 1):
        for half in ("Jan_Jun", "Jul_Dec"):
            if year == today.year and half == "Jul_Dec" and today.month < 7:
                continue
            url = EIA_FILE.format(year=year, half=half)
            request = urllib.request.Request(url, headers={"User-Agent": "controlroom-datathon/1.0"})
            try:
                with urllib.request.urlopen(request, timeout=300) as r:
                    lines = io.TextIOWrapper(r, encoding="utf-8-sig")
                    header = next(csv.reader([next(lines)]))
                    col = {name: i for i, name in enumerate(header)}
                    demand_col = col.get("Demand (MW) (Adjusted)", col["Demand (MW)"])
                    n = 0
                    for line in lines:
                        if not line.startswith(("ERCO,", '"ERCO"')):
                            continue
                        f = next(csv.reader([line]))
                        end = datetime.strptime(f[col["UTC Time at End of Hour"]], "%m/%d/%Y %I:%M:%S %p")
                        rows[end] = (_mw(f[demand_col]), _mw(f[col["Demand Forecast (MW)"]]))
                        n += 1
            except urllib.error.HTTPError as e:
                print(f"  {year} {half}: skipped ({e.code})")
                continue
            print(f"  {year} {half}: {n} ERCOT hours")
    out = DATA / "eia930_ercot_hourly.csv"
    with out.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time_utc", "demand_mw", "dayahead_forecast_mw"])
        for end in sorted(rows):
            demand, forecast = rows[end]
            w.writerow([end.strftime("%Y-%m-%dT%H:%M"), "" if demand is None else demand,
                        "" if forecast is None else forecast])
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
    fetch_eia()
    fetch_weather()
