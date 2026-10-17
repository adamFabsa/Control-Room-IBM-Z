"""Downloads the data once: ERCOT hourly demand (EIA-930), Texas city temperatures (Open-Meteo), and
Dallas County outages during Uri (EAGLE-I).

    python3 ai/data/fetch_data.py            # on the LinuxONE VM, from ~/control-room
    python3 ai/data/fetch_data.py eaglei     # only the EAGLE-I step

Writes data/eia930_ercot_hourly.csv (UTC, hour ending), data/openmeteo_texas_hourly.csv (UTC) and
data/eaglei_dallas_feb2021.csv (15-minute customers out, explicit UTC offsets; read by the engine).
Standard library only. Uses EIA's bulk six-month files: the EIA API was timing out.
"""
import csv
import io
import json
import sys
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
# EAGLE-I recorded outages (ORNL), figshare article 24237376
EAGLEI_2021 = "https://ndownloader.figshare.com/files/42547891"
EAGLEI_MCC = "https://ndownloader.figshare.com/files/42547708"  # modeled customer counts per county
DALLAS_FIPS = "48113"
EAGLEI_WINDOW = ("2021-02-10", "2021-02-25")
EAGLEI_TZ = "+00:00"  # run_start_time is UTC: Dallas outages jump at 07:45 UTC = 01:45 CST, after the 01:20 order


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


def fetch_eaglei():
    """Dallas County rows of the 1.1 GB 2021 EAGLE-I file for Uri's window, streamed, plus its customer count."""
    def lines(url):
        request = urllib.request.Request(url, headers={"User-Agent": "controlroom-datathon/1.0"})
        return io.TextIOWrapper(urllib.request.urlopen(request, timeout=300), encoding="utf-8-sig")

    mcc = csv.DictReader(lines(EAGLEI_MCC))
    total = next((r for r in mcc if r[next(k for k in r if "fips" in k.lower())].zfill(5) == DALLAS_FIPS), None)
    total = total and int(float(next(v for k, v in total.items() if "customer" in k.lower())))
    rows = []
    reader = lines(EAGLEI_2021)
    header = next(csv.reader([next(reader)]))
    col = {name: i for i, name in enumerate(header)}
    for line in reader:
        if not line.startswith((DALLAS_FIPS + ",", '"' + DALLAS_FIPS)):
            continue
        f = next(csv.reader([line]))
        if EAGLEI_WINDOW[0] <= f[col["run_start_time"]] < EAGLEI_WINDOW[1]:
            rows.append((f[col["run_start_time"]].replace(" ", "T") + EAGLEI_TZ, f[col["county"]], int(float(f[col["customers_out"]]))))
    out = DATA / "eaglei_dallas_feb2021.csv"
    with out.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["run_start_time", "county", "customers_out", "total_customers"])
        w.writerows((t, county, n, total or "") for t, county, n in sorted(rows))
    print(f"wrote {out} ({len(rows)} rows; Dallas County customers {total})")


if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    if sys.argv[1:] == ["eaglei"]:
        fetch_eaglei()
    else:
        fetch_eia()
        fetch_weather()
        fetch_eaglei()
