"""M2 what-if predictor: Snap ML models that score a proposed move from the current state.

Input: the state JSON and the state right after the move (so a move is described by what it does, which
also covers event-card options). Output: the change in cold person-hours over the next 6 game hours, and
the chance the move leaves a critical building dark. Powers event-card AI picks and the AI-alone player.
Training: ai/m2/train_m2.py.
"""
import copy
import json
import logging
import pickle
from datetime import datetime
from pathlib import Path

import numpy as np

log = logging.getLogger("controlroom.m2")

CIRCUITS = [f"C-{i:02d}" for i in range(1, 16)]
BUILDINGS = ["hospital-1", "dialysis-1", "water-1", "gas-1", "school-1"]
HORIZON_STEPS = 72  # 6 game hours
CRITICAL_PENALTY = 2_000_000  # cold person-hours we'd trade to keep a critical building powered
AI_PREP = [("protect", "hospital-1"), ("generator", "water-1"), ("keep_gas", "gas-1"),
           ("warming_center", "school-1"), ("warming_center", "school-1")]  # 7 of 10 points; 3 left for emergencies
MODELS = Path(__file__).resolve().parents[2] / "ai" / "models"
# state_vector layout: 4 per circuit, 2 per building, then globals (cut_mw is the third global)
BUILDINGS_AT = 4 * len(CIRCUITS)
CUT_AT = BUILDINGS_AT + 2 * len(BUILDINGS) + 2


def state_vector(state):
    by_circuit = {}
    for c in state["circuits"]:
        by_circuit.setdefault(c["id"][:4], []).append(c)  # smart-switch halves fold into their circuit
    v = []
    for cid in CIRCUITS:
        cs = by_circuit.get(cid, [])
        v += [np.mean([c["on"] for c in cs]) if cs else 1.0,
              np.mean([c["indoor_f"] for c in cs]) if cs else 68.0,
              max((c["dark_min"] for c in cs), default=0) / 60,
              float(any(c["protected"] for c in cs))]
    buildings = {b["id"]: b for b in state["buildings"]}
    for bid in BUILDINGS:
        b = buildings.get(bid, {})
        v += [float(b.get("on", True)), float(b.get("generator", False))]
    hour = datetime.fromisoformat(state["time"]).hour
    v += [state["outside_f"], state["order_mw"] / 1000, state["cut_mw"] / 1000, state["points"],
          state["totals"]["people_cold"] / 100_000, np.sin(hour / 24 * 2 * np.pi), np.cos(hour / 24 * 2 * np.pi)]
    return np.asarray(v, dtype=np.float32)


def move_vector(before, after):
    b = state_vector(before)
    return np.concatenate([b, state_vector(after) - b])


def after_switch(state, circuit_id, on):
    """The state right after cutting (on=False) or restoring a circuit, without touching the engine."""
    after = copy.deepcopy(state)
    for c in after["circuits"]:
        if c["id"] == circuit_id and c["on"] != on:
            c["on"] = on
            after["cut_mw"] += -c["mw"] if on else c["mw"]
    for b in after["buildings"]:
        if b["circuit"] == circuit_id and not b["generator"]:
            b["on"] = on
    return after


def switch_vectors(state, circuit_ids, on):
    """move_vector(state, after_switch(state, cid, on)) for each circuit, editing only what a switch changes."""
    base = state_vector(state)
    circuits = {c["id"]: c for c in state["circuits"]}
    rows = []
    for cid in circuit_ids:
        c, after = circuits[cid], base.copy()
        if c["on"] != on:
            halves = [x for x in state["circuits"] if x["id"][:4] == cid[:4]]
            after[4 * CIRCUITS.index(cid[:4])] = np.mean([(x["on"] if x["id"] != cid else on) for x in halves])
            after[CUT_AT] += (-c["mw"] if on else c["mw"]) / 1000
        for j, bid in enumerate(BUILDINGS):
            b = next((b for b in state["buildings"] if b["id"] == bid), None)
            if b and b["circuit"] == cid and not b["generator"]:
                after[BUILDINGS_AT + 2 * j] = float(on)
        rows.append(np.concatenate([base, after - base]))
    return np.stack(rows)


class M2:
    """Loaded Snap ML models; None-safe: `available` is False when they haven't been trained yet."""

    def __init__(self, models=MODELS):
        self.available = False
        try:
            with open(models / "m2_cph.pkl", "rb") as f:
                self.cph = pickle.load(f)
            with open(models / "m2_dark.pkl", "rb") as f:
                self.dark = pickle.load(f)
            self.meta = json.loads((models / "m2_meta.json").read_text())
            self.available = True
        except Exception as e:
            log.info("M2 not loaded (%s); AI picks fall back to the engine's", e)
            return
        self.accelerator = "cpu"
        try:  # run tree inference on the IBM Z on-chip AI accelerator (NNPA) through zDNN
            self.cph.optimize_trees(tree_format="zdnn_tensors")
            self.dark.optimize_trees(tree_format="zdnn_tensors")
            self.accelerator = "nnpa"
        except Exception as e:
            log.info("M2 on CPU: %s", e)

    def score(self, before, afters):
        """Predicted (cold person-hours change, chance a critical building goes dark, ranking cost) per move."""
        return self._predict(np.stack([move_vector(before, a) for a in afters]))

    def score_switches(self, state, circuit_ids, on):
        return self._predict(switch_vectors(state, circuit_ids, on))[2]

    def _predict(self, X):
        cph = self.cph.predict(X)
        dark = self.dark.predict_proba(X)[:, 1]
        return cph, dark, cph + dark * CRITICAL_PENALTY

    def pick_option(self, game, state):
        """Best option on the open event card, by simulating each option's immediate effect."""
        afters = []
        for option in state["event"]["options"]:
            trial = game.clone()
            try:
                trial.apply({"type": "choose", "event": state["event"]["id"], "option": option["id"]})
                afters.append(trial.state())
            except Exception:
                afters.append(None)
        valid = [i for i, a in enumerate(afters) if a is not None]
        if not valid:
            return None
        cph, dark, cost = self.score(state, [afters[i] for i in valid])
        best = valid[int(np.argmin(cost))]
        return {"option": state["event"]["options"][best]["id"],
                "predictions": {state["event"]["options"][i]["id"]: {"cold_person_hours_change": round(float(cph[k])),
                                                                      "critical_dark_chance": round(float(dark[k]), 2)}
                                for k, i in enumerate(valid)}}

    def player(self):
        """decide(state) -> actions: meet the cut order choosing circuits by M2, and rotate hourly when it helps."""
        def decide(state):
            if state["phase"] == "prepare":
                return [{"type": "buy", "item": i, "target": t} for i, t in AI_PREP] + [{"type": "start_storm"}]
            dark = [c for c in state["circuits"] if not c["on"]]
            spare = state["cut_mw"] - state["order_mw"]
            on_the_hour = datetime.fromisoformat(state["time"]).minute == 0
            if spare >= 0 and not any(c["mw"] <= spare for c in dark) and not (on_the_hour and dark):
                return []  # nothing to decide this step
            actions, state = [], copy.deepcopy(state)
            while state["order_mw"] > state["cut_mw"]:  # cut the move M2 expects to hurt least
                options = [c["id"] for c in state["circuits"] if c["on"] and not c["protected"]]
                if not options:
                    break
                cid = options[int(np.argmin(self.score_switches(state, options, False)))]
                actions.append({"type": "cut", "circuit": cid})
                state = after_switch(state, cid, False)
            spare = state["cut_mw"] - state["order_mw"]
            for c in sorted((c for c in state["circuits"] if not c["on"]), key=lambda c: c["mw"]):
                if c["mw"] <= spare:  # give back power the order no longer needs
                    actions.append({"type": "restore", "circuit": c["id"]})
                    state = after_switch(state, c["id"], True)
                    spare -= c["mw"]
            still_dark = [c["id"] for c in state["circuits"] if not c["on"]]
            on = [c["id"] for c in state["circuits"] if c["on"] and not c["protected"]]
            if on_the_hour and still_dark and on:  # hourly: swap a dark circuit for a lit one if M2 sees a gain
                restore_cost = self.score_switches(state, still_dark, True)
                back = still_dark[int(np.argmin(restore_cost))]
                swapped = after_switch(state, back, True)
                cut_cost = self.score_switches(swapped, on, False)
                out = on[int(np.argmin(cut_cost))]
                if out != back and restore_cost.min() + cut_cost.min() < 0:
                    actions += [{"type": "restore", "circuit": back}, {"type": "cut", "circuit": out}]
            return actions
        return decide


_shared = None


def get():
    """One loaded M2 per process (the server and each stress-test worker)."""
    global _shared
    if _shared is None:
        _shared = M2()
    return _shared
