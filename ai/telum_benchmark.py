"""M2 on the Telum on-chip AI accelerator vs the CPU: same predictions? how fast?

    podman run --rm -v ~/control-room/ai:/app/ai -v ~/control-room/server:/app/server \
        -v ~/control-room/engine:/app/engine -v ~/control-room/data:/app/data \
        localhost/controlroom-ai python3 ai/telum_benchmark.py

Loads the trained M2 models twice with Snap ML: tree_format "compress_trees" (CPU) and "zdnn_tensors"
(Telum, through zDNN). Inputs are real M2 feature rows: every cut/restore option at every hour of
headless engine games. One "M2 call" is what the server does: the cold-hours model plus the
critical-building model. Single rows use 1 thread, batches use all cores (each backend's best setting).
Writes ai/telum_results.json.
"""
import json
import pickle
import platform
import time
import warnings
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

import numpy as np

warnings.simplefilter("ignore")
from app.engine import ENGINE_NAME, Game  # noqa: E402
from app.m2 import switch_vectors  # noqa: E402
from app.players import PLAYERS, play_out  # noqa: E402

MODELS = Path(__file__).resolve().parent / "models"
OUT = Path(__file__).resolve().parent / "telum_results.json"
SINGLE_CALLS = 2000


def feature_rows(games=12):
    """M2 inputs from real games: each hour, every circuit it could cut or restore."""
    rows = []
    for seed in range(games):
        game = Game(storm="generated" if seed else "uri2021", seed=seed)
        greedy = PLAYERS["greedy"]
        while game.state()["phase"] in ("prepare", "storm"):
            state = game.state()
            if state["phase"] == "storm" and not state["event"]:
                on = [c["id"] for c in state["circuits"] if c["on"] and not c["protected"]]
                dark = [c["id"] for c in state["circuits"] if not c["on"]]
                if on:
                    rows.append(switch_vectors(state, on, False))
                if dark:
                    rows.append(switch_vectors(state, dark, True))
            game, _ = play_out(game, greedy, max_steps=12)  # advance about an hour
    return np.concatenate(rows).astype(np.float32)


def load(tree_format):
    models = []
    for name in ("m2_cph.pkl", "m2_dark.pkl"):
        with open(MODELS / name, "rb") as f:
            model = pickle.load(f)
        model.optimize_trees(tree_format=tree_format)
        models.append(model)
    return models, models[0].booster_.optimized_tree_format_


def m2_call(models, X, n_jobs=None):
    cph, dark = models
    return cph.predict(X, n_jobs=n_jobs), dark.predict_proba(X, n_jobs=n_jobs)[:, 1]


def measure(models, rows, batch_10k):
    for _ in range(100):  # warm up
        m2_call(models, rows[:1], n_jobs=1)
    times = []
    for i in range(SINGLE_CALLS):  # one thread: the fastest setting for single rows on both backends
        x = rows[i % len(rows)][None, :]
        t = time.perf_counter_ns()
        m2_call(models, x, n_jobs=1)
        times.append((time.perf_counter_ns() - t) / 1e6)
    out = {"single_ms_median": round(float(np.median(times)), 3), "single_ms_p95": round(float(np.percentile(times, 95)), 3)}
    for n, X in ((1000, batch_10k[:1000]), (10000, batch_10k)):
        best = min(_timed(models, X) for _ in range(5))
        out[f"batch_{n}_ms"] = round(best * 1000, 2)
        out[f"batch_{n}_rows_per_sec"] = round(n / best)
    return out


def _timed(models, X):
    t = time.perf_counter()
    m2_call(models, X)
    return time.perf_counter() - t


def main():
    rows = feature_rows()
    batch_10k = rows[np.random.default_rng(0).integers(0, len(rows), 10000)]
    cpu, cpu_format = load("compress_trees")
    telum, telum_format = load("zdnn_tensors")

    cpu_cph, cpu_dark = m2_call(cpu, batch_10k)
    tel_cph, tel_dark = m2_call(telum, batch_10k)
    agree = {"max_abs_diff_cold_person_hours": round(float(np.abs(cpu_cph - tel_cph).max()), 3),
             "max_abs_diff_dark_probability": round(float(np.abs(cpu_dark - tel_dark).max()), 6),
             "same_best_move_pct": None}
    # The decision that matters: does each backend pick the same move from a set of options?
    groups = [batch_10k[i:i + 10] for i in range(0, 10000, 10)]
    same = [np.argmin(m2_call(cpu, g)[0]) == np.argmin(m2_call(telum, g)[0]) for g in groups]
    agree["same_best_move_pct"] = round(100 * float(np.mean(same)), 2)
    agree["match"] = bool(np.allclose(cpu_cph, tel_cph, rtol=1e-3, atol=1.0) and np.allclose(cpu_dark, tel_dark, atol=1e-3))

    results = {"when": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "machine": open("/proc/cpuinfo").read().split("machine = ")[1].split()[0],
               "arch": platform.machine(), "snapml": version("snapml"), "engine": ENGINE_NAME,
               "input_rows_from_games": int(len(rows)), "features": int(rows.shape[1]),
               "cpu": {"tree_format": cpu_format, **measure(cpu, rows, batch_10k)},
               "telum": {"tree_format": telum_format, **measure(telum, rows, batch_10k)},
               "agreement": agree}
    OUT.write_text(json.dumps(results, indent=2))

    c, t = results["cpu"], results["telum"]
    print(f"M2 (Snap ML {results['snapml']}) on IBM {results['machine']} ({results['arch']}): one call = cold-hours model + critical-building model")
    print(f"inputs: {len(rows):,} real M2 feature rows from engine games ({rows.shape[1]} features)\n")
    print(f"{'':28s}{'CPU (' + c['tree_format'] + ')':>26s}{'Telum (' + t['tree_format'] + ')':>26s}{'Telum vs CPU':>14s}")
    for key, label in (("single_ms_median", "1 prediction, median ms"), ("single_ms_p95", "1 prediction, p95 ms"),
                       ("batch_1000_ms", "1,000 rows, ms"), ("batch_10000_ms", "10,000 rows, ms")):
        print(f"{label:28s}{c[key]:>26}{t[key]:>26}{c[key] / t[key]:>13.2f}x")
    for n in (1000, 10000):
        print(f"{f'{n:,} rows, rows/s':28s}{c[f'batch_{n}_rows_per_sec']:>26,}{t[f'batch_{n}_rows_per_sec']:>26,}")
    print(f"\nsame predictions: {agree['match']} (max diff {agree['max_abs_diff_cold_person_hours']} cold person-hours, "
          f"{agree['max_abs_diff_dark_probability']} probability); same best move in {agree['same_best_move_pct']}% of 1,000 decisions")
    print(f"saved {OUT.name}")


if __name__ == "__main__":
    main()
