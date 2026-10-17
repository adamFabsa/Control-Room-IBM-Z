"""Storms: outside temperature and the grid operator's cut order, one value per 5-minute step.

Real data is read from data/ when present. When it is missing, hand-made curves are used
and the storm's note says so, so the game can label it.
"""

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import numpy as np

from .config import STEP_H

CST = timezone(timedelta(hours=-6))
URI_START = datetime(2021, 2, 14, 18, 0, tzinfo=CST)   # Sun 14 Feb 18:00
URI_HOURS = 114                                         # to Fri 19 Feb 12:00
PREP_BEFORE = timedelta(days=2, hours=6)                # Get ready: Fri 12 Feb 12:00
ORDER_START_H = 7 + 20 / 60                             # first cut order Mon 01:20
TOTAL_MW = 6500
DALLAS_CUSTOMERS = 1_100_000                            # used if the outage file has no total

DATA_DIR = Path(os.environ.get("STORMGAME_DATA", Path(__file__).resolve().parents[2] / "data"))
OPENMETEO_FILE = "openmeteo_dallas.csv"
EAGLEI_FILE = "eaglei_dallas_feb2021.csv"

# Hand-made fallbacks, (hours after storm start, value). Shaped on the NWS DFW record for Feb 2021.
URI_TEMP_KEYS = [
    (0, 16), (6, 9), (12, 4), (18, 12), (21, 13), (30, 3), (36, -2), (42, 10), (45, 14),
    (54, 11), (60, 9), (66, 22), (69, 25), (78, 20), (84, 17), (90, 28), (93, 30),
    (102, 24), (108, 21), (114, 34),
]
URI_ORDER_KEYS = [
    (0, 0), (ORDER_START_H, 0), (ORDER_START_H + 1, 1100), (12, 1500), (18, 1800), (30, 2000),
    (40, 2000), (48, 1700), (60, 1300), (72, 1000), (84, 600), (96, 200), (98, 0), (114, 0),
]


@dataclass(frozen=True)
class Storm:
    name: str
    start: datetime
    outside_f: np.ndarray   # length n_steps + 1
    order_mw: np.ndarray    # base cut order, same length
    note: str = ""

    @property
    def n_steps(self):
        return len(self.outside_f) - 1

    @property
    def prep_time(self):
        return self.start - PREP_BEFORE

    def time_at(self, step):
        return self.start + timedelta(minutes=5 * step)


def load_storm(name="uri2021", seed=42):
    if name == "uri2021":
        return uri2021()
    if name == "generated":
        return generated(seed)
    if name == "test":
        return test_storm()
    raise ValueError(f"unknown storm {name!r}")


def _step_hours(hours):
    return np.arange(int(round(hours / STEP_H)) + 1) * STEP_H


def _curve(keys, hours):
    k = np.array(keys, dtype=float)
    return np.interp(hours, k[:, 0], k[:, 1])


def _hours_below(temps, f=20.0):
    return float((np.asarray(temps) < f).sum() * STEP_H)


def test_storm(hours=URI_HOURS):
    h = _step_hours(hours)
    return Storm("test", URI_START, np.full(len(h), 10.0), np.full(len(h), 1000.0),
                 "test storm: 10°F outside, 1,000 MW order")


# ---------- data files ----------

def _to_local_naive(index):
    import pandas as pd
    idx = pd.DatetimeIndex(index)
    if idx.tz is not None:
        idx = idx.tz_convert(CST).tz_localize(None)
    return idx


def _read_openmeteo(path):
    """Open-Meteo CSV export (metadata lines, then a 'time,temperature_2m (...)' table)."""
    import pandas as pd
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    head = next(i for i, line in enumerate(lines) if line.lower().startswith("time"))
    df = pd.read_csv(path, skiprows=head)
    tcol = next(c for c in df.columns if c.lower().startswith("temperature"))
    temp = df[tcol].astype(float).to_numpy()
    if "°c" in tcol.lower() or "(c)" in tcol.lower():
        temp = temp * 9 / 5 + 32
    s = pd.Series(temp, index=_to_local_naive(pd.to_datetime(df[df.columns[0]])))
    return s.sort_index().dropna()


def _read_eaglei(path):
    """EAGLE-I outage rows for Dallas County. Returns (customers_out series, total customers)."""
    import pandas as pd
    df = pd.read_csv(path)
    cols = {c.lower(): c for c in df.columns}
    if "county" in cols:
        df = df[df[cols["county"]].astype(str).str.contains("Dallas", case=False)]
    tcol = next(cols[c] for c in cols if "time" in c or c == "date")
    ocol = next(cols[c] for c in cols if c in ("customers_out", "sum", "customers"))
    total = float(df[cols["total_customers"]].max()) if "total_customers" in cols else DALLAS_CUSTOMERS
    s = pd.Series(df[ocol].astype(float).to_numpy(), index=_to_local_naive(pd.to_datetime(df[tcol])))
    s = s.groupby(level=0).sum().sort_index()
    return s, total


def _sample(series, start, hours):
    """Interpolate a time series onto the storm's steps; None if it does not cover the storm."""
    t0 = np.datetime64(start.replace(tzinfo=None))
    x = (series.index.to_numpy().astype("datetime64[s]") - t0).astype(float) / 3600
    if len(x) < 2 or x[0] > hours[0] + 1 or x[-1] < hours[-1] - 1:
        return None
    return np.interp(hours, x, series.to_numpy(dtype=float))


@lru_cache(maxsize=1)
def _temperature_series():
    path = DATA_DIR / OPENMETEO_FILE
    if not path.exists():
        return None
    try:
        return _read_openmeteo(path)
    except Exception:
        return None


# ---------- the real storm ----------

@lru_cache(maxsize=1)
def uri2021():
    hours = _step_hours(URI_HOURS)
    notes = []

    temps = None
    series = _temperature_series()
    if series is not None:
        temps = _sample(series, URI_START, hours)
    if temps is None:
        temps = _curve(URI_TEMP_KEYS, hours)
        notes.append("approximate hand-made temperature curve (Open-Meteo data not loaded)")

    order = None
    try:
        out, total = _read_eaglei(DATA_DIR / EAGLEI_FILE) if (DATA_DIR / EAGLEI_FILE).exists() else (None, 0)
        raw = None if out is None else _sample(out, URI_START, hours)
        if raw is not None:
            order = raw / total * TOTAL_MW
            order = np.convolve(order, np.ones(12) / 12, mode="full")[: len(order)]  # 1-hour smoothing
            order[hours < ORDER_START_H] = 0.0
    except Exception:
        order = None
    if order is None:
        order = _curve(URI_ORDER_KEYS, hours)
        notes.append("hand-made order curve (EAGLE-I data not loaded)")

    return Storm("uri2021", URI_START, temps, order, "; ".join(notes))


# ---------- generated storms ----------

@lru_cache(maxsize=1)
def _cold_spells():
    """Hourly temperature runs from the 2005-2026 Dallas record: at or below freezing for
    24+ hours with at least one hour under 20°F, padded by 6 hours either side."""
    s = _temperature_series()
    if s is None or len(s) < 24 * 365:
        return ()
    s = s.resample("1h").mean().interpolate()
    v = s.to_numpy()
    freezing = v <= 32
    spells, i = [], 0
    while i < len(v):
        if not freezing[i]:
            i += 1
            continue
        j = i
        while j < len(v) and freezing[j]:
            j += 1
        if j - i >= 24 and v[i:j].min() < 20:
            a, b = max(0, i - 6), min(len(v), j + 6)
            spells.append(tuple(v[a:b][:160]))
        i = j
    return tuple(spells)


def _synthetic_hourly(rng):
    length = int(rng.uniform(48, 130))
    low = rng.uniform(-4, 22)
    amp = rng.uniform(4, 9)
    h = np.arange(length + 1, dtype=float)
    envelope = np.sin(np.pi * h / length) ** 0.6
    diurnal = -amp * np.cos(2 * np.pi * (h - 12) / 24)        # coldest around 06:00
    noise = np.convolve(rng.normal(0, 2, len(h)), np.ones(5) / 5, mode="same")
    return 34 - (34 - low) * envelope + diurnal * envelope + noise


def generated(seed):
    rng = np.random.default_rng([seed, 2026])
    spells = _cold_spells()
    if spells:
        base = np.array(spells[rng.integers(len(spells))]) + rng.normal(0, 2)
        note = "generated from a real Dallas cold spell (2005-2026)"
    else:
        base = _synthetic_hourly(rng)
        note = "generated synthetic cold spell (Dallas temperature data not loaded)"
    length_h = len(base) - 1
    hours = _step_hours(length_h)
    temps = np.interp(hours, np.arange(len(base)), base)

    uri = uri2021()
    uri_hours = _step_hours(URI_HOURS)
    severity = _hours_below(temps) / max(_hours_below(uri.outside_f), 1.0)
    severity = float(np.clip(severity, 0.15, 1.6))
    order = np.interp(hours / hours[-1] * URI_HOURS, uri_hours, uri.order_mw) * severity
    return Storm(f"generated-{seed}", URI_START, temps, order,
                 f"{note}; order = Uri curve x {severity:.2f}")
