"""CONTROL ROOM: URI game engine. Plain Python + NumPy, deterministic for a given seed."""

import copy
import math

import numpy as np

from . import config as C
from .storms import Storm, load_storm


class ActionError(ValueError):
    """An action that is malformed or not allowed right now."""


def _steps(minutes):
    return int(round(minutes / C.STEP_MIN))


class Circuit:
    def __init__(self, cid, area, people, mw, vuln, parent=None):
        self.id = cid
        self.area = area
        self.people = people
        self.mw = mw
        self.vuln = vuln
        self.parent = parent            # original circuit id once split by smart switches
        self.protected = False
        self.cut = False                # cut by the player
        self.ice_until = -1             # dark from an ice line break while step < ice_until
        self.indoor_f = C.WARM_F
        self.dark_min = 0               # minutes dark in the current outage
        self.cold_warned = False
        tau = C.TAU_OLD_H if vuln >= C.OLD_HOME_VULN else C.TAU_H
        self.decay = math.exp(-C.STEP_H / tau)
        self.tau = tau


class Building:
    def __init__(self, bid, btype, circuit):
        self.id = bid
        self.type = btype
        self.circuit = circuit
        self.critical = btype in C.CRITICAL_TYPES
        self.fuel = 0                   # generator fuel left, in steps
        self.dark_steps = 0             # steps without power in a row
        self.fuel_warned = False

    @property
    def name(self):
        return C.BUILDING_NAMES[self.type]


class Game:
    """See the Shared contracts in the project spec for the API and the state JSON."""

    def __init__(self, storm="uri2021", seed=42, ai_picker=None):
        self.seed = seed
        self.storm = storm if isinstance(storm, Storm) else load_storm(storm, seed)
        self.rng = np.random.default_rng(seed)
        self.ai_picker = ai_picker      # optional fn(game, event) -> option id (Adam's M2)

        self.circuits = [Circuit(*row) for row in C.CIRCUITS]
        self.buildings = [Building(*row) for row in C.BUILDINGS]
        self._index()

        self.phase = "prepare"
        self.k = 0
        self.paused = False
        self.speed = 1
        self.points = C.START_POINTS
        self.event = None
        self._event_n = 0
        self._queued_cuts = []          # critical cuts asked for while another card was open
        self._next_ok = {}

        self.keep_gas = False
        self.repair_crews = False
        self.conservation = []          # [start_step, end_step, fraction]
        self.centers = []               # areas with a warming center (one entry per center)
        self.ice = []                   # [step, circuit_id, warned]
        self.gas_until = -1
        self.boil = {}                  # water building id -> step the notice ends (None = ongoing)

        self.history = []
        self.timeline = []
        self.order_log = []

        self.cph = 0.0
        self.boil_ph = 0.0
        self.longest = 0
        self.crit_dark_min = 0
        self.water_lost = set()
        self.order_steps = 0
        self.met_steps = 0
        self.short_steps = 0
        self.collapse_steps = 0
        self.end_reason = None

    # ---------- lookups ----------

    def _index(self):
        self._cmap = {c.id: c for c in self.circuits}
        self._bmap = {b.id: b for b in self.buildings}

    def _targets(self, target):
        """Circuits named by a circuit id, a split circuit's original id, or a building id."""
        if not isinstance(target, str):
            raise ValueError(f"unknown circuit or building {target!r}")
        if target in self._cmap:
            return [self._cmap[target]]
        if target in self._bmap:
            return [self._cmap[self._bmap[target].circuit]]
        halves = [c for c in self.circuits if c.parent == target]
        if halves:
            return halves
        raise ValueError(f"unknown circuit or building {target!r}")

    def _buildings_on(self, c):
        return [b for b in self.buildings if b.circuit == c.id]

    def is_on(self, c):
        return not c.cut and self.k >= c.ice_until

    def _backed_up(self, b):
        return b.fuel > 0 or (b.type == "gas_compressor" and self.keep_gas)

    def building_on(self, b):
        return self.is_on(self._cmap[b.circuit]) or self._backed_up(b)

    def _exposed(self, c):
        """Critical buildings on c that would go dark if c lost power."""
        return [b for b in self._buildings_on(c) if b.critical and not self._backed_up(b)]

    def _cuttable(self, c):
        return self.is_on(c) and not c.protected

    # ---------- grid numbers ----------

    def conservation_frac(self, k=None):
        k = self.k if k is None else k
        return sum(f for a, b, f in self.conservation if a <= k < b)

    def order_now(self):
        if self.phase == "prepare":
            return 0.0
        mult = C.GAS_MULT if self.k <= self.gas_until else 1.0
        return float(self.storm.order_mw[self.k]) * mult * (1 - self.conservation_frac())

    def cut_mw(self):
        return sum(c.mw for c in self.circuits if not c.protected and not self.is_on(c))

    def outside_f(self):
        return float(self.storm.outside_f[self.k])

    def _warmed(self):
        """People counted as warm in warming centers, per circuit."""
        remaining = {c.id: c.people for c in self.circuits
                     if not self.is_on(c) and c.indoor_f < C.COLD_F}
        warmed = {}
        for area in self.centers:
            cap = C.WARMING_CENTER_PEOPLE
            near = C.ADJACENT.get(area, set())
            pool = [c for c in self.circuits if remaining.get(c.id) and (c.area == area or c.area in near)]
            for c in sorted(pool, key=lambda c: (c.area != area, -c.vuln)):
                take = min(cap, remaining[c.id])
                remaining[c.id] -= take
                warmed[c.id] = warmed.get(c.id, 0) + take
                cap -= take
                if cap <= 0:
                    break
        return warmed

    def _cold_people(self, warmed=None):
        warmed = self._warmed() if warmed is None else warmed
        return {c.id: c.people - warmed.get(c.id, 0) for c in self.circuits if c.indoor_f < C.COLD_F}

    # ---------- actions ----------

    def apply(self, action):
        """Apply one action JSON. Returns {"ok": True, ...}; raises ActionError (a ValueError)
        for an action that is malformed or not allowed now, leaving the game unchanged."""
        if not isinstance(action, dict):
            raise ActionError("an action must be a JSON object")
        kind = action.get("type")
        if not isinstance(kind, str):
            raise ActionError("an action needs a type")
        k, phase = self.k, self.phase
        event_kind = self.event["kind"] if self.event else None
        handler = getattr(self, f"_act_{kind}", None)
        if handler is None:
            raise ActionError(f"unknown action type {kind!r}")
        try:
            result = handler(action) or {}
        except ValueError as e:
            raise ActionError(str(e)) from None
        if kind not in ("pause", "play", "speed"):
            entry = {"step": k, "phase": phase, "action": dict(action)}
            if kind == "choose":
                entry["event_kind"] = event_kind
            self.history.append(entry)
        return {"ok": True, **result}

    def try_apply(self, action):
        """Like apply, but returns {"ok": False, "error": ...} instead of raising."""
        try:
            return self.apply(action)
        except ActionError as e:
            return {"ok": False, "error": str(e)}

    def start_storm(self):
        return self.try_apply({"type": "start_storm"})

    def _act_pause(self, a):
        self.paused = True

    def _act_play(self, a):
        self.paused = False

    def _act_speed(self, a):
        value = a.get("value", 1)
        if isinstance(value, str) and value.isdigit():
            value = int(value)
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 5:
            raise ValueError("speed must be 1-5")
        self.speed = value

    def _act_start_storm(self, a):
        if self.phase != "prepare":
            raise ValueError("the storm has already started")
        self._plan_ice()
        self.phase = "storm"
        self.k = 0
        self.paused = False
        self.order_log = [self.order_now()]
        self._log_timeline()

    def _plan_ice(self):
        """Seeded ice line breaks, about one every 12 hours, each darkening one circuit."""
        t = 0.0
        ids = [c.id for c in self.circuits]
        while True:
            t += self.rng.exponential(C.ICE_BREAK_EVERY_H)
            step = _steps(t * 60)
            if step >= self.storm.n_steps:
                break
            self.ice.append([step, ids[int(self.rng.integers(len(ids)))], False])

    def _spend(self, item):
        cost = C.COSTS[item]
        if cost > self.points:
            raise ValueError(f"{item} costs {cost} points; {self.points} left")
        self.points -= cost

    def _act_buy(self, a):
        item = a.get("item")
        if not isinstance(item, str) or item not in C.COSTS:
            raise ValueError(f"unknown item {item!r}")
        if self.phase == "storm":
            if item not in C.STORM_ITEMS:
                raise ValueError(f"{item} can only be bought in Get ready")
            return self._act_emergency(a)
        if self.phase != "prepare":
            raise ValueError("the game is over")
        self._buy(item, a.get("target"))

    def _act_emergency(self, a):
        item = a.get("item")
        if self.phase != "storm":
            raise ValueError("emergency moves are for the storm")
        if not isinstance(item, str) or item not in C.STORM_ITEMS:
            raise ValueError(f"{item} is not an emergency item")
        self._buy(item, a.get("target"))

    def _buy(self, item, target):
        storm = self.phase == "storm"
        if item == "protect":
            circuits = self._targets(target)
            if all(c.protected for c in circuits):
                raise ValueError(f"{target} is already protected")
            self._spend(item)
            for c in circuits:
                c.protected = True
        elif item == "generator":
            b = self._bmap.get(target) if isinstance(target, str) else None
            if b is None:
                raise ValueError("a generator goes on a building")
            self._give_generator(b)
        elif item == "warming_center":
            area = self._targets(target)[0].area
            self._spend(item)
            self.centers.append(area)
        elif item == "keep_gas":
            if self.keep_gas:
                raise ValueError("gas is already kept flowing")
            self._spend(item)
            self.keep_gas = True
        elif item == "conservation":
            if not storm and self.conservation:
                raise ValueError("the conservation alert is already set")
            self._spend(item)
            frac = C.CONSERVATION_STORM if storm else C.CONSERVATION_PREP
            start = self.k if storm else 0
            self.conservation.append([start, start + _steps(C.CONSERVATION_H * 60), frac])
        elif item == "repair_crews":
            if self.repair_crews:
                raise ValueError("repair crews are already placed")
            self._spend(item)
            self.repair_crews = True
        elif item == "smart_switch":
            self._split(target)

    def _give_generator(self, b):
        full = _steps(C.GENERATOR_FUEL_H * 60)
        if b.fuel >= full:
            raise ValueError(f"{b.id} already has a full generator")
        self._spend("generator")
        b.fuel = full
        b.fuel_warned = False

    def _split(self, target):
        c = self._cmap.get(target) if isinstance(target, str) else None
        if c is None or c.parent is not None:
            raise ValueError(f"{target!r} is not a circuit that can be split")
        self._spend("smart_switch")
        half_people, half_mw = c.people // 2, c.mw // 2
        a = Circuit(f"{c.id}A", c.area, c.people - half_people, c.mw - half_mw, c.vuln, parent=c.id)
        b = Circuit(f"{c.id}B", c.area, half_people, half_mw, c.vuln, parent=c.id)
        a.protected = b.protected = c.protected
        i = self.circuits.index(c)
        self.circuits[i:i + 1] = [a, b]
        for bld in self.buildings:
            if bld.circuit == c.id:
                bld.circuit = a.id
        self._index()

    def _act_cut(self, a):
        if self.phase != "storm":
            raise ValueError("cuts happen during the storm")
        circuits = [c for c in self._targets(a.get("circuit")) if not c.cut]
        if any(c.protected for c in circuits):
            raise ValueError(f"{a.get('circuit')} is protected")
        if any(self._exposed(c) for c in circuits if self.is_on(c)):
            if self.event is not None:
                # Another card is open: this one waits and opens as soon as that one is answered.
                self._queued_cuts.append([c.id for c in circuits])
                return {"queued": True}
            return self._cut_or_ask([c.id for c in circuits])
        for c in circuits:
            c.cut = True

    def _cut_or_ask(self, ids):
        """Cut these circuits, or open a card first if that darkens a critical building."""
        circuits = [self._cmap[i] for i in ids if i in self._cmap and not self._cmap[i].cut]
        exposed = [b for c in circuits if self.is_on(c) for b in self._exposed(c)]
        if exposed:
            self._open_critical_cut(circuits, exposed[0])
            return {"event": self.event["id"]}
        for c in circuits:
            c.cut = True
        return {}

    def _act_restore(self, a):
        if self.phase != "storm":
            raise ValueError("restores happen during the storm")
        for c in self._targets(a.get("circuit")):
            c.cut = False

    def _act_choose(self, a):
        ev = self.event
        if ev is None or a.get("event") != ev["id"]:
            raise ValueError("no such open event")
        option = a.get("option")
        if not isinstance(option, str) or option not in [o["id"] for o in ev["options"]]:
            raise ValueError(f"no option {option!r}")
        self._resolve(ev, option)
        if self.event is ev:
            self.event = None
        while self.event is None and self._queued_cuts:
            self._cut_or_ask(self._queued_cuts.pop(0))

    # ---------- the clock ----------

    def step(self):
        """Advance 5 game minutes. Does nothing while paused, while an event is open, or outside the storm."""
        if self.phase != "storm" or self.event is not None or self.paused:
            return
        self.k += 1
        k, dt = self.k, C.STEP_H
        out = self.outside_f()

        fix = _steps(60 * (C.ICE_FIX_CREWS_H if self.repair_crews else C.ICE_FIX_H))
        for step, cid, _ in self.ice:
            if step == k and cid in self._cmap:
                self._cmap[cid].ice_until = k + fix

        warm_decay = math.exp(-dt / C.TAU_WARM_H)
        for c in self.circuits:
            if self.is_on(c):
                c.indoor_f = C.WARM_F + (c.indoor_f - C.WARM_F) * warm_decay
                c.dark_min = 0
                c.cold_warned = False
            else:
                c.indoor_f = out + (c.indoor_f - out) * c.decay
                c.dark_min += C.STEP_MIN
                self.longest = max(self.longest, c.dark_min)

        for b in self.buildings:
            circuit_on = self.is_on(self._cmap[b.circuit])
            on = circuit_on or self._backed_up(b)
            if not circuit_on and b.fuel > 0 and not (b.type == "gas_compressor" and self.keep_gas):
                b.fuel -= 1
            b.dark_steps = 0 if on else b.dark_steps + 1
            if b.critical and not on:
                self.crit_dark_min += C.STEP_MIN
            if b.type == "gas_compressor" and not on:
                self.gas_until = k + _steps(C.GAS_RECOVER_H * 60)
            if b.type == "water_plant":
                self._water(b, on)
        self.boil_ph += C.WATER_PEOPLE * dt * len(self.boil)

        warmed = self._warmed()
        cvuln = {c.id: c.vuln for c in self.circuits}
        self.cph += sum(n * (1 + cvuln[cid]) for cid, n in self._cold_people(warmed).items()) * dt

        order, cut = self.order_now(), self.cut_mw()
        self.order_log.append(order)
        if order > 0.5:
            self.order_steps += 1
            short = order - cut
            if short <= C.SHORT_WARN * order:
                self.met_steps += 1
                self.short_steps = 0
            else:
                self.short_steps += 1
            self.collapse_steps = self.collapse_steps + 1 if short > C.SHORT_COLLAPSE * order else 0
        else:
            self.short_steps = self.collapse_steps = 0

        if k % 12 == 0:
            self._log_timeline()
        if self.collapse_steps >= _steps(C.SHORT_COLLAPSE_MIN):
            return self._end("grid_collapse")
        if k >= self.storm.n_steps:
            return self._end("storm_over")
        self._check_events()

    def _water(self, b, on):
        k = self.k
        if not on:
            if b.id in self.boil:
                self.boil[b.id] = None
            elif b.dark_steps >= _steps(C.WATER_DARK_H * 60):
                self.boil[b.id] = None
                self.water_lost.add(b.id)
        elif b.id in self.boil:
            if self.boil[b.id] is None:
                self.boil[b.id] = k + _steps(C.BOIL_END_H * 60)
            elif k >= self.boil[b.id]:
                del self.boil[b.id]

    def _end(self, reason):
        self.phase = "over"
        self.end_reason = reason
        self.event = None
        self._queued_cuts = []
        self._log_timeline()

    def _log_timeline(self):
        cold = sum(self._cold_people().values())
        self.timeline.append({
            "time": self.storm.time_at(self.k).isoformat(),
            "outside_f": round(self.outside_f(), 1),
            "order_mw": round(self.order_now()),
            "cut_mw": round(self.cut_mw()),
            "people_cold": cold,
            "people_no_power": sum(c.people for c in self.circuits if not self.is_on(c)),
            "cold_person_hours": round(self.cph),
        })

    # ---------- event cards ----------

    def _cooling_minutes(self, c, out=None):
        """Minutes until a dark circuit's homes cross 50°F, or None."""
        out = self.outside_f() if out is None else out
        if c.indoor_f < C.COLD_F or out >= C.COLD_F:
            return None
        return c.tau * math.log((c.indoor_f - out) / (C.COLD_F - out)) * 60

    def _ready(self, kind):
        return self.k >= self._next_ok.get(kind, 0)

    def _check_events(self):
        k = self.k
        for e in self.ice:
            step, cid, warned = e
            if not warned and k < step <= k + _steps(C.WARN_CRITICAL_MIN) and cid in self._cmap:
                e[2] = True
                c = self._cmap[cid]
                exposed = self._exposed(c) if self.is_on(c) else []
                if exposed:
                    return self._open_ice(c, exposed[0], (step - k) * C.STEP_MIN)

        for b in self.buildings:
            c = self._cmap[b.circuit]
            if (b.critical and 0 < b.fuel <= _steps(C.WARN_CRITICAL_MIN) and not self.is_on(c)
                    and not b.fuel_warned and not (b.type == "gas_compressor" and self.keep_gas)):
                b.fuel_warned = True
                return self._open_fuel(b, c)

        log = self.order_log
        if self._ready("order_rise") and len(log) > 12 and log[-1] - log[-13] > C.ORDER_RISE_MW:
            return self._open_order("order_rise")

        if self._ready("short") and self.short_steps >= _steps(C.SHORT_WARN_MIN):
            return self._open_order("short")

        if self._ready("cold"):
            for c in self.circuits:
                if self.is_on(c) or c.cold_warned:
                    continue
                mins = self._cooling_minutes(c)
                if mins is not None and mins <= C.WARN_COLD_MIN:
                    c.cold_warned = True
                    return self._open_cold(c, mins)

    def _open(self, kind, title, text, options, data):
        """options: list of (id, label) pairs. The last one is the do-nothing default.
        A card with nothing to decide (one option) is not opened."""
        if len(options) < 2:
            return
        self._event_n += 1
        ev = {
            "id": f"ev-{self._event_n}",
            "kind": kind,
            "title": title,
            "text": text,
            "options": [{"id": oid, "label": label, "ai_pick": False} for oid, label in options],
            "default": options[-1][0],
            "data": data,
        }
        pick = self.ai_picker(self, ev) if self.ai_picker else self._heuristic_pick(ev)
        for o in ev["options"]:
            o["ai_pick"] = o["id"] == pick
        if kind in C.EVENT_COOLDOWN_MIN:
            self._next_ok[kind] = self.k + _steps(C.EVENT_COOLDOWN_MIN[kind])
        self.event = ev

    _PICK_ORDER = {
        "critical_cut": ["gen", "other", "cancel", "dark"],
        "ice": ["gen", "dark"],
        "fuel": ["gen", "restore", "dark"],
        "order_rise": ["auto"],
        "short": ["auto"],
        "cold": ["warm", "restore", "keep"],
    }

    def _heuristic_pick(self, ev):
        ids = [o["id"] for o in ev["options"]]
        return next((o for o in self._PICK_ORDER[ev["kind"]] if o in ids), ev["default"])

    def _gen_option(self, label="Send a backup generator"):
        cost = C.COSTS["generator"]
        return [("gen", f"{label} ({cost} pts)")] if self.points >= cost else []

    def _open_critical_cut(self, circuits, b):
        c = self._cmap[b.circuit]
        alt = self._warmest_safe(exclude={x.id for x in circuits})
        if b.type == "water_plant":
            text = (f"Cutting {c.id} darkens {b.id}. Without it, about {C.WATER_PEOPLE:,} people "
                    f"lose water pressure in {C.WATER_DARK_H} hours.")
        elif b.type == "gas_compressor":
            text = (f"Cutting {c.id} darkens {b.id}. Without it, fuel to power plants drops and "
                    f"every cut order grows {round((C.GAS_MULT - 1) * 100)}%.")
        elif b.type == "dialysis":
            text = f"{b.id} shares {c.id} with {c.people:,} people. Cutting the homes cuts the dialysis center too."
        else:
            text = f"Cutting {c.id} darkens {b.id}, which has no backup power."
        options = self._gen_option()
        if alt is not None:
            options.append(("other", "Cut a different neighborhood"))
        if len(options) < 2:
            options.append(("cancel", f"Keep {c.id} on"))
        options.append(("dark", f"Let the {b.name} go dark"))
        self._open("critical_cut", f"The {b.name} is about to lose power.", text, options,
                   {"targets": [x.id for x in circuits], "building": b.id, "alternative": alt and alt.id})

    def _open_ice(self, c, b, mins):
        self._open("ice", f"Ice is building on the lines into {c.id}.",
                   f"{b.id}, the {b.name}, loses power in about {mins} minutes unless it has backup power.",
                   self._gen_option() + [("dark", "Let it go dark")],
                   {"circuit": c.id, "building": b.id})

    def _open_fuel(self, b, c):
        mins = b.fuel * C.STEP_MIN
        options = self._gen_option("Send a fresh generator")
        if c.cut and self.k >= c.ice_until:
            options.append(("restore", f"Restore {c.id} and cut the warmest neighborhood"))
        options.append(("dark", "Let it go dark"))
        self._open("fuel", f"The generator at {b.id} is almost out of fuel.",
                   f"It has about {mins} minutes left and {c.id} is still dark.", options,
                   {"circuit": c.id, "building": b.id})

    def _open_order(self, kind):
        order, cut = round(self.order_now()), round(self.cut_mw())
        options = [("auto", "Cut the warmest neighborhoods to meet it")]
        if self.points >= C.COSTS["conservation"]:
            options.append(("conserve", f"Send a conservation alert ({C.COSTS['conservation']} pt)"))
        if kind == "order_rise":
            rise = round(self.order_log[-1] - self.order_log[-13])
            options.append(("manual", "I'll choose the cuts myself"))
            self._open(kind, f"The cut order rose to {order:,} MW.",
                       f"It went up {rise:,} MW in the last hour. You are cutting {cut:,} MW.",
                       options, {"order_mw": order, "cut_mw": cut})
        else:
            options.append(("wait", "Hold for now"))
            self._open(kind, f"You are {order - cut:,} MW short of the order.",
                       f"The order is {order:,} MW and you are cutting {cut:,} MW. If the cut stays more "
                       f"than {round(C.SHORT_COLLAPSE * 100)}% short for {C.SHORT_COLLAPSE_MIN} minutes, "
                       f"the grid collapses.", options, {"order_mw": order, "cut_mw": cut})

    def _open_cold(self, c, mins):
        mins = max(5, int(round(mins / 5)) * 5)
        options = []
        if c.cut and self.k >= c.ice_until:
            options.append(("restore", f"Restore {c.id} and cut the warmest neighborhood"))
        if self.points >= C.COSTS["warming_center"]:
            options.append(("warm", f"Open a warming center in {c.area} ({C.COSTS['warming_center']} pt)"))
        options.append(("keep", "Keep it dark"))
        self._open("cold", f"{c.area} ({c.id}) is getting cold.",
                   f"Homes on {c.id} drop below 50°F in about {mins} minutes. {c.people:,} people live there.",
                   options, {"circuit": c.id})

    def _warmest_safe(self, exclude=()):
        """The warmest cuttable circuit whose cut darkens no critical building."""
        pool = [c for c in self.circuits
                if self._cuttable(c) and c.id not in exclude and not self._exposed(c)]
        return max(pool, key=lambda c: (c.indoor_f, -c.vuln), default=None)

    def _auto_cover(self, exclude=()):
        while self.cut_mw() < self.order_now() * (1 - C.SHORT_WARN / 2):
            c = self._warmest_safe(exclude)
            if c is None:
                return
            c.cut = True

    def _resolve(self, ev, option):
        d, kind = ev["data"], ev["kind"]
        b = self._bmap.get(d.get("building"))
        if option == "gen":
            self._give_generator(b)
        if kind == "critical_cut":
            if option in ("gen", "dark"):
                for cid in d["targets"]:
                    if cid in self._cmap:
                        self._cmap[cid].cut = True
            elif option == "other" and d["alternative"] in self._cmap:
                self._cmap[d["alternative"]].cut = True
        elif option == "restore":
            self._cmap[d["circuit"]].cut = False
            self._auto_cover(exclude={d["circuit"]})
        elif option == "auto":
            self._auto_cover()
        elif option == "conserve":
            self._buy("conservation", None)
        elif option == "warm":
            self._buy("warming_center", d["circuit"])

    # ---------- outputs ----------

    def _tip(self):
        if self.phase == "prepare":
            return self._prep_tip()
        if self.phase == "over":
            return "The storm is over." if self.end_reason == "storm_over" else "The grid collapsed."
        soon = [(m, c) for c in self.circuits if not self.is_on(c)
                for m in [self._cooling_minutes(c)] if m is not None]
        if soon:
            m, c = min(soon, key=lambda x: x[0])
            return f"{c.id} crosses 50°F inside in about {max(5, int(round(m / 5)) * 5)} minutes."
        short = round(self.order_now() - self.cut_mw())
        if short > C.SHORT_WARN * self.order_now():
            return f"The cut is {short:,} MW short of the order."
        dark = [c for c in self.circuits if not self.is_on(c)]
        if dark:
            c = max(dark, key=lambda c: c.dark_min)
            return f"{c.id} has been dark for {c.dark_min} minutes; {c.people:,} people live there."
        return "No cut order right now."

    def _prep_tip(self):
        water, gas, hosp = self._bmap["water-1"], self._bmap["gas-1"], self._bmap["hospital-1"]
        if not self._backed_up(water) and not self._cmap[water.circuit].protected:
            return (f"water-1 has no backup power. If {water.circuit} is dark for {C.WATER_DARK_H} hours, "
                    f"{C.WATER_PEOPLE:,} people get a boil-water notice.")
        if not self._backed_up(gas) and not self._cmap[gas.circuit].protected:
            return (f"gas-1 on {gas.circuit} has no backup. If it loses power, every cut order grows "
                    f"{round((C.GAS_MULT - 1) * 100)}%.")
        if not self._backed_up(hosp) and not self._cmap[hosp.circuit].protected:
            return f"hospital-1 on {hosp.circuit} has no backup power."
        dial = self._bmap["dialysis-1"]
        dc = self._cmap[dial.circuit]
        if dc.parent is None and not self._backed_up(dial) and not dc.protected:
            return (f"dialysis-1 shares {dc.id} with {dc.people:,} people. Smart switches let you cut "
                    f"the homes without the dialysis center.")
        coldest = float(self.storm.outside_f.min())
        if coldest < C.COLD_F:
            hours = C.TAU_OLD_H * math.log((C.WARM_F - coldest) / (C.COLD_F - coldest))
            return (f"At {round(coldest)}°F, older homes go cold about {hours:.1f} hours after losing "
                    f"power. Pleasant Grove is the most vulnerable area.")
        return f"You have {self.points} points left to spend."

    def state(self):
        warmed = self._warmed()
        cold = self._cold_people(warmed)
        time = self.storm.prep_time if self.phase == "prepare" else self.storm.time_at(self.k)
        ev = None
        if self.event:
            ev = {key: self.event[key] for key in ("id", "kind", "title", "text")}
            ev["options"] = [dict(o) for o in self.event["options"]]
        return {
            "time": time.isoformat(),
            "phase": self.phase,
            "paused": self.paused or self.event is not None,
            "speed": self.speed,
            "outside_f": round(self.outside_f()),
            "order_mw": round(self.order_now()),
            "cut_mw": round(self.cut_mw()),
            "points": self.points,
            "circuits": [{
                "id": c.id, "area": c.area, "on": self.is_on(c), "protected": c.protected,
                "dark_min": c.dark_min, "indoor_f": round(c.indoor_f), "people": c.people,
                "mw": c.mw, "split": c.parent is not None, "parent": c.parent,
                "ice": self.k < c.ice_until,
            } for c in self.circuits],
            "buildings": [{
                "id": b.id, "type": b.type, "circuit": b.circuit, "on": self.building_on(b),
                "generator": b.fuel > 0,
                "protected": self._cmap[b.circuit].protected or (b.type == "gas_compressor" and self.keep_gas),
            } for b in self.buildings],
            "totals": {
                "people_no_power": sum(c.people for c in self.circuits if not self.is_on(c)),
                "people_cold": sum(cold.values()),
                "cold_person_hours": round(self.cph),
            },
            "event": ev,
            "copilot": {"tip": self._tip()},
            # Extra fields beyond the shared contract (safe to ignore):
            "storm": self.storm.name,
            "storm_note": self.storm.note,
            "step": self.k,
            "steps_total": self.storm.n_steps,
            "end_reason": self.end_reason,
            "demand_mw": round(C.demand_mw(self.outside_f()) * (1 - self.conservation_frac())),
            "boil_water_people": C.WATER_PEOPLE * len(self.boil),
            "gas_short": self.phase == "storm" and self.k <= self.gas_until,
            "warming_centers": list(self.centers),
        }

    def score(self):
        return {
            "cold_person_hours": round(self.cph),
            "longest_outage_min": self.longest,
            "critical_dark_min": self.crit_dark_min,
            "water_plants_lost": len(self.water_lost),
            "orders_met_pct": round(100 * self.met_steps / self.order_steps, 1) if self.order_steps else 100.0,
            "boil_water_person_hours": round(self.boil_ph),
            "grid_collapsed": self.end_reason == "grid_collapse",
        }

    def plan(self):
        """The Get ready purchases: the player's winter plan, reusable on other storms."""
        return [h["action"] for h in self.history if h["phase"] == "prepare" and h["action"]["type"] == "buy"]

    def clone(self):
        """Deep copy for replays and the stress test. The storm data is shared, not copied."""
        storm, picker = self.storm, self.ai_picker
        self.storm = self.ai_picker = None
        try:
            g = copy.deepcopy(self)
        finally:
            self.storm, self.ai_picker = storm, picker
        g.storm, g.ai_picker = storm, picker
        return g
