"""Stand-in for Person 1's stormgame engine.

Same interface as the shared contract (Game, apply, start_storm, step, state,
score, clone) with simplified rules and a hand-made Uri storm, so the server
and screens can run before the real engine lands. Not used once
engine/stormgame is importable.
"""
import copy
import math
import random
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=-6))
PREP_TIME = datetime(2021, 2, 12, 12, 0, tzinfo=CST)
STORM_START = datetime(2021, 2, 14, 18, 0, tzinfo=CST)
STORM_END = datetime(2021, 2, 19, 12, 0, tzinfo=CST)
STEP_MIN = 5

# id, area, people, MW, vulnerability (Game numbers in the spec)
CIRCUITS = [
    ("C-01", "Downtown", 100_000, 250, 0.30),
    ("C-02", "Medical District", 120_000, 300, 0.55),
    ("C-03", "Southwest Dallas", 160_000, 400, 0.70),
    ("C-04", "East Dallas", 160_000, 400, 0.60),
    ("C-05", "West Dallas", 140_000, 350, 0.70),
    ("C-06", "South Dallas", 180_000, 450, 0.75),
    *[(f"C-{i:02d}", "Oak Cliff", 200_000, 500, 0.75) for i in (7, 8, 9)],
    *[(f"C-{i:02d}", "Lake Highlands", 180_000, 450, 0.45) for i in (10, 11, 12)],
    *[(f"C-{i:02d}", "Pleasant Grove", 200_000, 500, 0.85) for i in (13, 14, 15)],
]
BUILDINGS = [
    ("hospital-1", "hospital", "C-02"),
    ("dialysis-1", "dialysis", "C-03"),
    ("water-1", "water_plant", "C-04"),
    ("gas-1", "gas_compressor", "C-05"),
    ("school-1", "warming_center_site", "C-06"),
]
CRITICAL = {"hospital", "dialysis", "water_plant", "gas_compressor"}
COST = {"protect": 1, "generator": 2, "warming_center": 1, "keep_gas": 2,
        "conservation": 1, "repair_crews": 1, "smart_switch": 2}

# (hours after storm start, value), linearly interpolated. Hand-made fallback
# curves: the cut order rises Mon 01:20 and ends Thu evening.
OUTSIDE_F = [(0, 20), (12, 4), (24, 10), (37, -2), (45, 14), (60, 12),
             (69, 25), (85, 20), (93, 33), (114, 45)]
ORDER_MW = [(0, 0), (7.3, 0), (7.4, 300), (14, 1200), (37, 1500), (60, 600),
            (98, 0), (114, 0)]


def _interp(keys, h):
    for (h0, v0), (h1, v1) in zip(keys, keys[1:]):
        if h <= h1:
            return v0 + (v1 - v0) * max(0.0, h - h0) / (h1 - h0)
    return keys[-1][1]


class Game:
    def __init__(self, storm="uri2021", seed=42):
        self.storm, self.seed = storm, seed
        # Generated storms: Uri's shape, shifted warmer or colder and with a milder or harsher cut order.
        rng = random.Random(seed)
        self.temp_shift = rng.uniform(-4, 14) if storm == "generated" else 0.0
        self.order_scale = rng.uniform(0.3, 1.2) if storm == "generated" else 1.0
        self.time = PREP_TIME
        self.phase = "prepare"
        self.points = 10
        self.circuits = [
            {"id": cid, "area": area, "on": True, "protected": False, "dark_min": 0,
             "indoor_f": 68.0, "people": people, "mw": mw, "split": False}
            for cid, area, people, mw, _ in CIRCUITS
        ]
        self.vuln = {cid: v for cid, *_, v in CIRCUITS}
        self.buildings = [
            {"id": bid, "type": kind, "circuit": cid, "on": True,
             "generator": False, "protected": False}
            for bid, kind, cid in BUILDINGS
        ]
        self.warming_centers = 0
        self.keep_gas = False
        self.conservation = False
        self.event = None
        self._event_kind = None
        self._events_seen = set()
        self._event_count = 0
        self._water_dark_min = 0
        self.cold_person_hours = 0.0
        self.longest_outage_min = 0
        self.critical_dark_min = 0
        self.water_plants_lost = 0
        self.order_min = 0
        self.met_min = 0

    # --- lookups -----------------------------------------------------------
    def _circuit(self, cid):
        for c in self.circuits:
            if c["id"] == cid:
                return c
        raise ValueError(f"unknown circuit {cid}")

    def _building(self, bid):
        for b in self.buildings:
            if b["id"] == bid:
                return b
        raise ValueError(f"unknown building {bid}")

    def _hours_in(self):
        return (self.time - STORM_START).total_seconds() / 3600

    def outside_f(self):
        return 28.0 if self.phase == "prepare" else _interp(OUTSIDE_F, self._hours_in()) + self.temp_shift

    def order_mw(self):
        if self.phase == "prepare":
            return 0.0
        order = _interp(ORDER_MW, self._hours_in()) * self.order_scale
        if not self._building("gas-1")["on"]:
            order *= 1.15
        if self.conservation and self._hours_in() < 24:
            order *= 0.97
        return order

    # --- actions -----------------------------------------------------------
    def apply(self, action):
        kind = action.get("type")
        if kind == "buy":
            if self.phase != "prepare":
                raise ValueError("buy only during Get ready")
            self._buy(action["item"], action["target"])
        elif kind == "start_storm":
            self.start_storm()
        elif kind == "cut":
            c = self._circuit(action["circuit"])
            if c["protected"]:
                raise ValueError(f"{c['id']} is protected")
            c["on"] = False
        elif kind == "restore":
            self._circuit(action["circuit"])["on"] = True
        elif kind == "emergency":
            if action["item"] not in ("generator", "warming_center"):
                raise ValueError("emergency item must be generator or warming_center")
            self._buy(action["item"], action["target"])
        elif kind == "choose":
            self._choose(action["option"])
        else:
            raise ValueError(f"unknown action type {kind!r}")
        self._update_buildings()

    def _buy(self, item, target):
        if item not in COST:
            raise ValueError(f"unknown item {item!r}")
        if self.points < COST[item]:
            raise ValueError("not enough points")
        if item == "protect":
            cid = target if target.startswith("C-") else self._building(target)["circuit"]
            self._circuit(cid)["protected"] = True
            for b in self.buildings:
                if b["circuit"] == cid:
                    b["protected"] = True
        elif item == "generator":
            self._building(target)["generator"] = True
        elif item == "warming_center":
            self.warming_centers += 1
        elif item == "keep_gas":
            self.keep_gas = True
        elif item == "conservation":
            self.conservation = True
        # repair_crews and smart_switch have no effect in the stand-in
        self.points -= COST[item]

    def _choose(self, option):
        if not self.event:
            raise ValueError("no event is open")
        if self._event_kind == "water":
            if option == "gen":
                self._buy("generator", "water-1")
            elif option == "other":
                self._circuit("C-04")["on"] = True
        elif self._event_kind == "gas" and option == "restore":
            self._circuit("C-05")["on"] = True
        self.event = None
        self._event_kind = None

    def start_storm(self):
        if self.phase == "prepare":
            self.phase = "storm"
            self.time = STORM_START

    # --- clock -------------------------------------------------------------
    def step(self):
        if self.phase != "storm" or self.event:
            return
        self.time += timedelta(minutes=STEP_MIN)
        dt_h = STEP_MIN / 60
        out = self.outside_f()
        for c in self.circuits:
            if c["on"]:
                c["indoor_f"] += (68 - c["indoor_f"]) * (1 - math.exp(-dt_h / 2))
                c["dark_min"] = 0
            else:
                tau = 7 if self.vuln[c["id"]] >= 0.7 else 10
                c["indoor_f"] = out + (c["indoor_f"] - out) * math.exp(-dt_h / tau)
                c["dark_min"] += STEP_MIN
                self.longest_outage_min = max(self.longest_outage_min, c["dark_min"])
        self._update_buildings()

        for b in self.buildings:
            if b["type"] in CRITICAL and not b["on"]:
                self.critical_dark_min += STEP_MIN
        self._water_dark_min = 0 if self._building("water-1")["on"] else self._water_dark_min + STEP_MIN
        if self._water_dark_min >= 120:
            self.water_plants_lost = 1

        weighted = sum(c["people"] * (1 + self.vuln[c["id"]])
                       for c in self.circuits if c["indoor_f"] < 50)
        self.cold_person_hours += max(0.0, weighted - self._warm_people() * 1.5) * dt_h

        order = self.order_mw()
        if order > 0:
            self.order_min += STEP_MIN
            if self._cut_mw() >= 0.95 * order:
                self.met_min += STEP_MIN

        self._check_events()
        if self.time >= STORM_END:
            self.phase = "over"

    def _update_buildings(self):
        for b in self.buildings:
            powered = self._circuit(b["circuit"])["on"]
            b["on"] = powered or b["generator"] or (b["id"] == "gas-1" and self.keep_gas)

    def _cut_mw(self):
        return sum(c["mw"] for c in self.circuits if not c["on"])

    def _people_cold(self):
        return sum(c["people"] for c in self.circuits if c["indoor_f"] < 50)

    def _warm_people(self):
        return min(self.warming_centers * 20_000, self._people_cold())

    def _check_events(self):
        if self.event:
            return
        if not self._building("water-1")["on"] and "water" not in self._events_seen:
            can_gen = self.points >= 2
            self._open_event("water", "The water plant is about to lose power.",
                             "Without it, about 180,000 people lose water pressure in 2 hours.",
                             [("gen", "Send a backup generator (2 pts)", can_gen),
                              ("other", "Cut a different neighborhood", not can_gen),
                              ("dark", "Let the plant go dark", False)])
        elif not self._building("gas-1")["on"] and "gas" not in self._events_seen:
            self._open_event("gas", "The gas compressor station lost power.",
                             "Power plants lose fuel and every cut order grows by 15%.",
                             [("restore", "Restore West Dallas now", True),
                              ("dark", "Leave it off", False)])

    def _open_event(self, kind, title, text, options):
        self._event_count += 1
        self._events_seen.add(kind)
        self._event_kind = kind
        self.event = {"id": f"ev-{self._event_count}", "title": title, "text": text,
                      "options": [{"id": i, "label": label, "ai_pick": pick}
                                  for i, label, pick in options]}

    def _copilot_tip(self):
        if self.phase == "prepare":
            if not self._building("water-1")["generator"]:
                return "The water plant (East Dallas) has no backup generator."
            return None
        out = self.outside_f()
        soonest = None
        for c in self.circuits:
            if not c["on"] and out < 50 < c["indoor_f"]:
                tau = 7 if self.vuln[c["id"]] >= 0.7 else 10
                hours = tau * math.log((c["indoor_f"] - out) / (50 - out))
                if soonest is None or hours < soonest[1]:
                    soonest = (c["id"], hours)
        if soonest:
            return f"{soonest[0]} crosses 50°F inside in about {round(soonest[1] * 60)} minutes."
        return None

    # --- read-outs ---------------------------------------------------------
    def state(self):
        people_cold = self._people_cold()
        return {
            "time": self.time.isoformat(),
            "phase": self.phase,
            "paused": self.event is not None,
            "speed": 1,
            "outside_f": round(self.outside_f()),
            "order_mw": round(self.order_mw()),
            "cut_mw": self._cut_mw(),
            "points": self.points,
            "circuits": [dict(c, indoor_f=round(c["indoor_f"])) for c in self.circuits],
            "buildings": [dict(b) for b in self.buildings],
            "totals": {
                "people_no_power": sum(c["people"] for c in self.circuits if not c["on"]),
                "people_cold": people_cold - self._warm_people(),
                "cold_person_hours": round(self.cold_person_hours),
            },
            "event": copy.deepcopy(self.event),
            "copilot": {"tip": self._copilot_tip()},
        }

    def score(self):
        return {
            "cold_person_hours": round(self.cold_person_hours),
            "longest_outage_min": self.longest_outage_min,
            "critical_dark_min": self.critical_dark_min,
            "water_plants_lost": self.water_plants_lost,
            "orders_met_pct": round(100 * self.met_min / self.order_min, 1) if self.order_min else 100.0,
        }

    def clone(self):
        return copy.deepcopy(self)
