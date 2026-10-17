"""M2 what-if predictor: generate what-if samples from engine runs on LinuxONE, train Snap ML, time it.

    podman run --rm -v ~/control-room/ai:/app/ai localhost/controlroom-ai python3 ai/m2/train_m2.py

Each sample: a random but plausible game paused at a random moment, a proposed move, and two clones of the
game played 6 hours ahead (with and without the move, then holding still). Labels: the change in cold
person-hours (a grid collapse counts as a big loss), and whether the move left a critical building dark.
Writes ai/models/m2_cph.pkl, m2_dark.pkl, m2_meta.json.
"""
import json
import os
import pickle
import random
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from snapml import SnapBoostingMachineClassifier, SnapBoostingMachineRegressor
from sklearn.metrics import accuracy_score, mean_absolute_error, r2_score, roc_auc_score

from app.engine import ENGINE_NAME, Game
from app.m2 import BUILDINGS, HORIZON_STEPS, effective_cph, move_vector

GAMES = int(os.environ.get("M2_GAMES", 500))
SAMPLES_PER_GAME = 12
ITEMS = [("protect", None), ("generator", BUILDINGS), ("warming_center", ["school-1"]), ("keep_gas", ["gas-1"]),
         ("conservation", ["C-01"]), ("repair_crews", ["C-01"]), ("smart_switch", None)]
MODELS = Path(__file__).resolve().parents[1] / "models"


def choose(game, event, first=None):
    """Answer an event card with `first` (default: the engine's pick), falling back to any option the engine accepts."""
    ids = [o["id"] for o in event["options"]]
    first = first or next((o["id"] for o in event["options"] if o["ai_pick"]), ids[0])
    for option in [first] + [i for i in ids if i != first]:
        try:
            game.apply({"type": "choose", "event": event["id"], "option": option})
            return True
        except Exception:
            pass
    return False


def hold(game, steps):
    """Play `steps` steps changing nothing; event cards take the engine's pick."""
    for _ in range(steps * 2):
        state = game.state()
        if state["phase"] != "storm" or steps <= 0:
            break
        if state["event"]:
            if not choose(game, state["event"]):
                break
            continue
        game.step()
        steps -= 1
    return game.score()


def candidate_moves(state, rng):
    on = [c["id"] for c in state["circuits"] if c["on"] and not c["protected"]]
    dark = [c["id"] for c in state["circuits"] if not c["on"]]
    moves = [None]
    if on:
        moves.append({"type": "cut", "circuit": rng.choice(on)})
    if dark:
        moves.append({"type": "restore", "circuit": rng.choice(dark)})
    if state["points"] >= 2:
        moves.append({"type": "emergency", "item": "generator", "target": rng.choice(BUILDINGS)})
    if state["points"] >= 1:
        moves.append({"type": "emergency", "item": "warming_center", "target": "school-1"})
    return moves


def what_if(game, state, move):
    """(features, cold person-hours change, critical building newly dark) for one move, or None."""
    with_move, without = game.clone(), game.clone()
    try:
        if move:
            with_move.apply(move)
    except Exception:
        return None
    x = move_vector(state, with_move.state())
    a, b = hold(with_move, HORIZON_STEPS), hold(without, HORIZON_STEPS)
    return x, effective_cph(a) - effective_cph(b), int(a["critical_dark_min"] > b["critical_dark_min"])


def one_game(seed):
    """Samples from one random game; also returns the number of engine steps run."""
    rng = random.Random(seed)
    game = Game(storm="generated" if rng.random() < 0.7 else "uri2021", seed=seed)
    for _ in range(rng.randint(0, 5)):  # random Get-ready purchases
        item, targets = rng.choice(ITEMS)
        state = game.state()
        target = rng.choice(targets) if targets else rng.choice(state["circuits"])["id"]
        try:
            game.apply({"type": "buy", "item": item, "target": target})
        except Exception:
            pass
    game.apply({"type": "start_storm"})
    p_sample = SAMPLES_PER_GAME / 1368
    slack = rng.uniform(-0.3, 0.3)  # this game's operator over- or under-cuts the order
    samples, steps = [], 0
    while True:
        state = game.state()
        if state["phase"] != "storm":
            break
        if state["event"]:
            options = state["event"]["options"]
            if rng.random() < 0.5:  # learn event cards: each option is a move
                for o in options:
                    r = what_if(game, state, {"type": "choose", "event": state["event"]["id"], "option": o["id"]})
                    if r:
                        samples.append(r)
            if not choose(game, state["event"], rng.choice(options)["id"]):
                break
            continue
        if rng.random() < p_sample:
            r = what_if(game, state, rng.choice(candidate_moves(state, rng)))
            if r:
                samples.append(r)
        if steps % 6 == 0:  # a sloppy operator: chase the order with random circuits
            target = state["order_mw"] * (1 + slack)
            circuits = state["circuits"][:]
            rng.shuffle(circuits)
            cut = state["cut_mw"]
            for c in circuits:
                if cut < target and c["on"] and not c["protected"]:
                    game.apply({"type": "cut", "circuit": c["id"]})
                    cut += c["mw"]
                elif cut - c["mw"] >= target and not c["on"] and rng.random() < 0.5:
                    game.apply({"type": "restore", "circuit": c["id"]})
                    cut -= c["mw"]
        game.step()
        steps += 1
    return seed, samples, steps


def main():
    MODELS.mkdir(exist_ok=True)
    start = time.perf_counter()
    with Pool(os.cpu_count()) as pool:
        results = pool.map(one_game, range(GAMES), chunksize=4)
    gen_s = time.perf_counter() - start
    seeds = np.array([seed for seed, samples, _ in results for _ in samples])
    X = np.stack([x for _, samples, _ in results for x, _, _ in samples])
    y_cph = np.array([y for _, samples, _ in results for _, y, _ in samples], dtype=np.float32)
    y_dark = np.array([d for _, samples, _ in results for _, _, d in samples], dtype=np.float32)
    print(f"{len(X)} what-if samples from {GAMES} games in {gen_s:.0f}s on {os.cpu_count()} cores "
          f"(engine: {ENGINE_NAME}); {y_dark.mean():.1%} leave a critical building dark")

    test = seeds % 5 == 0  # hold out whole games
    reg = SnapBoostingMachineRegressor(num_round=300, max_depth=6, learning_rate=0.1, n_jobs=os.cpu_count())
    clf = SnapBoostingMachineClassifier(num_round=200, max_depth=6, learning_rate=0.1, n_jobs=os.cpu_count())
    t = time.perf_counter()
    reg.fit(X[~test], y_cph[~test])
    clf.fit(X[~test], y_dark[~test])
    train_s = time.perf_counter() - t

    pred = reg.predict(X[test])
    helps = y_cph[test] != 0
    metrics = {"samples": int(len(X)), "games": GAMES, "engine": ENGINE_NAME,
               "generate_seconds": round(gen_s, 1), "train_seconds": round(train_s, 1),
               "cph_r2": round(float(r2_score(y_cph[test], pred)), 3),
               "cph_mae": round(float(mean_absolute_error(y_cph[test], pred))),
               "helps_or_hurts_accuracy": round(float((np.sign(pred[helps]) == np.sign(y_cph[test][helps])).mean()), 3)}
    if y_dark[test].min() != y_dark[test].max():
        prob = clf.predict_proba(X[test])[:, 1]
        metrics["dark_accuracy"] = round(float(accuracy_score(y_dark[test], prob > 0.5)), 3)
        metrics["dark_auc"] = round(float(roc_auc_score(y_dark[test], prob)), 3)

    one, batch = X[test][:1], X[test][:15]
    for name, model in (("cpu", reg),):
        t = time.perf_counter()
        for _ in range(500):
            model.predict(one)
        metrics[f"ms_per_prediction_{name}"] = round((time.perf_counter() - t) / 500 * 1000, 3)
        t = time.perf_counter()
        for _ in range(200):
            model.predict(batch)
        metrics[f"ms_per_15_moves_{name}"] = round((time.perf_counter() - t) / 200 * 1000, 3)
    try:  # tree inference on the IBM Z on-chip AI accelerator (NNPA) through zDNN
        nnpa = pickle.loads(pickle.dumps(reg))
        nnpa.optimize_trees(tree_format="zdnn_tensors")
        nnpa.predict(one)
        t = time.perf_counter()
        for _ in range(500):
            nnpa.predict(one)
        metrics["ms_per_prediction_nnpa"] = round((time.perf_counter() - t) / 500 * 1000, 3)
        t = time.perf_counter()
        for _ in range(200):
            nnpa.predict(batch)
        metrics["ms_per_15_moves_nnpa"] = round((time.perf_counter() - t) / 200 * 1000, 3)
        metrics["nnpa_matches_cpu"] = bool(np.allclose(nnpa.predict(batch), reg.predict(batch), rtol=1e-3, atol=1))
    except Exception as e:
        metrics["nnpa"] = f"unavailable: {e}"
    print(json.dumps(metrics, indent=2))

    with open(MODELS / "m2_cph.pkl", "wb") as f:
        pickle.dump(reg, f)
    with open(MODELS / "m2_dark.pkl", "wb") as f:
        pickle.dump(clf, f)
    (MODELS / "m2_meta.json").write_text(json.dumps({"features": int(X.shape[1]), "horizon_steps": HORIZON_STEPS,
                                                     "metrics": metrics}, indent=2))


if __name__ == "__main__":
    main()
