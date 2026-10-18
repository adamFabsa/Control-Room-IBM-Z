# Lights Out: datasets

Every number in the game comes from public data, except the customer records, which are synthetic. The four data files below are in this repo under [`data/`](../data); `python3 ai/data/fetch_data.py` rebuilds the first three from their sources.

## Data files in the repo

| File | Source | Rows | Coverage | Columns | Used for |
|---|---|---|---|---|---|
| [`eia930_ercot_hourly.csv`](../data/eia930_ercot_hourly.csv) | EIA-930 Hourly Electric Grid Monitor, ERCOT | 68,327 hourly | Jan 2019 to Oct 2026 (UTC) | `time_utc`, `demand_mw`, `dayahead_forecast_mw` | Training M1 (47,232 hours) and rebuilding the load Uri shed |
| [`openmeteo_texas_hourly.csv`](../data/openmeteo_texas_hourly.csv) | Open-Meteo Historical Weather API | 191,040 hourly | Jan 2005 to Oct 2026 (UTC) | `time_utc`, `dallas_f`, `houston_f`, `san_antonio_f`, `austin_f` (°F) | M1's temperature features; the storm's real Dallas temperatures |
| [`eaglei_dallas_feb2021.csv`](../data/eaglei_dallas_feb2021.csv) | EAGLE-I recorded outages (Oak Ridge National Laboratory, US DOE) | 1,438 at 15 minutes | Feb 10 to 24, 2021 | `run_start_time`, `county`, `customers_out`, `total_customers` (948,355) | The grid operator's cut order in the game engine |
| [`m1_uri2021_demand.csv`](../data/m1_uri2021_demand.csv) | Derived: our M1 model on the two files above | 115 hourly | Feb 14 18:00 to Feb 19 12:00, 2021 | `time_local`, `dallas_f`, `ercot_forecast_mw`, `ercot_measured_mw`, `estimated_shed_mw`, `dallas_county_demand_mw` | Dallas County demand shown during the storm |

## Other public sources

| Source | What it gives the game | Where it lives |
|---|---|---|
| US Census TIGER/Line 2024 | 645 census tracts (2.6 million people) grouped into 15 circuits; roads, water, landmarks | Prepared into the 3D map (`web/src/map/dallas.gen.json`, `web/tools/`) |
| CDC/ATSDR Social Vulnerability Index 2022 | Vulnerability of each neighborhood (population-weighted over its tracts) | Same map file |
| Texas DSHS, February 2021 Winter Storm-Related Deaths (final report) | 246 deaths in Texas, 22 in Dallas County: the basis of the estimated-deaths model | `server/app/report.py` |
| OpenStreetMap (ODbL) and Microsoft Global ML Building Footprints | Every building on the 3D map | Prepared by `web/tools/` |

Source links: [EIA-930](https://www.eia.gov/electricity/gridmonitor/) · [Open-Meteo](https://open-meteo.com/en/docs/historical-weather-api) · [EAGLE-I](https://doi.org/10.6084/m9.figshare.24237376) · [Census TIGER/Line](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html) · [CDC SVI](https://www.atsdr.cdc.gov/place-health/php/svi/) · [Texas DSHS report](https://www.dshs.texas.gov/sites/default/files/news/updates/SMOC_FebWinterStorm_MortalitySurvReport_12-30-21.pdf) · [OpenStreetMap](https://www.openstreetmap.org/copyright) · [Microsoft footprints](https://github.com/microsoft/GlobalMLBuildingFootprints)

## Generated data

| Data | How it is made | Size |
|---|---|---|
| Customer records | `ai/records/generate_customers.py`, synthetic, into PostgreSQL on the LinuxONE VM; each medical-device flag encrypted with pgcrypto | 1,000,000 accounts |
| M2 training data | `ai/m2/train_m2.py`: what-if rollouts of the real game engine | 60,286 samples from 1,500 games |
| Stress-test storms | The engine's generated storms, seeds 1 to 1,000 | 1,000 storms per test |
