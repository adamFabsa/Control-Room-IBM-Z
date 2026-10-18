"""What the game screens read (web/src/contracts.ts) on top of the engine's state.

The engine follows the shared contract; the screens also read a few optional fields under their own names.
Values come from the engine's own Game object where it has them, so they match the game exactly.
"""
import re

CRITICAL = {"hospital", "dialysis", "water_plant", "gas_compressor"}
TARGET = re.compile(r"\b(C-\d\d[AB]?|hospital-1|dialysis-1|water-1|gas-1|school-1)\b")
STEP_MIN = 5
MAX_NOTICES = 8


def _target(*texts):
    for text in texts:
        m = TARGET.search(text or "")
        if m:
            return m.group(1)
    return None


def decorate(s, game, log, medical):
    """Adds prep, effects, broken, medical, fuel_h, at_risk and map targets to the state `s` in place."""
    bought = {e["action"]["item"] for e in log if e["action"]["type"] in ("buy", "emergency")}
    conservation_now = getattr(game, "conservation_frac", lambda: 0)() > 0
    s["prep"] = {"keep_gas": bool(getattr(game, "keep_gas", "keep_gas" in bought)),
                 "repair_crews": bool(getattr(game, "repair_crews", "repair_crews" in bought)),
                 "conservation": "conservation" in bought,
                 "warming_center": bool(s.get("warming_centers")) or "warming_center" in bought}
    s["effects"] = {"gas_multiplier": 1.15 if s.get("gas_short") else 1.0,
                    "boil_water_people": s.get("boil_water_people", 0),
                    "conservation": conservation_now}
    for c in s["circuits"]:
        c["broken"] = bool(c.get("ice"))
        c["medical"] = medical.get(c["id"][:4])
    fuel = {b.id: b.fuel for b in getattr(game, "buildings", []) if hasattr(b, "fuel")}
    circuits = {c["id"]: c for c in s["circuits"]}
    for b in s["buildings"]:
        if b["id"] in fuel:
            b["fuel_h"] = round(fuel[b["id"]] * STEP_MIN / 60, 1)
        line = circuits.get(b["circuit"])
        b["at_risk"] = b["type"] in CRITICAL and (not b["on"] or (line is not None and not line["on"]))
    if s.get("event"):
        s["event"]["target"] = _target(s["event"].get("title"), s["event"].get("text"))
    if s.get("copilot") and s["copilot"].get("tip"):
        s["copilot"]["target"] = _target(s["copilot"]["tip"])


class Notices:
    """Short non-blocking messages for the screens, from changes between one state and the next."""

    def __init__(self):
        self.items = []
        self.prev = None

    def update(self, s):
        if s["phase"] != "storm":
            self.prev = None
            return
        now = {"ice": {c["id"] for c in s["circuits"] if c.get("ice")},
               "cold": {c["id"] for c in s["circuits"] if not c["on"] and c["indoor_f"] < 50},
               "boil": s.get("boil_water_people", 0) > 0, "gas": bool(s.get("gas_short"))}
        p, area = self.prev, {c["id"]: c["area"] for c in s["circuits"]}
        self.prev = now
        if p is None:
            return
        for cid in sorted(now["ice"] - p["ice"]):
            self._add("ice", f"Ice brought down a line in {area[cid]}. {cid} is dark until crews fix it.", s, cid)
        for cid in sorted(p["ice"] - now["ice"]):
            self._add("repair", f"Crews fixed the iced line in {area.get(cid, cid)}.", s, cid)
        for cid in sorted(now["cold"] - p["cold"]):
            self._add("cold", f"Homes in {area[cid]} ({cid}) dropped below 50°F.", s, cid)
        if now["boil"] and not p["boil"]:
            self._add("water", f"Boil-water notice for {s['boil_water_people']:,} people: the water plant lost power.", s, "water-1")
        if p["boil"] and not now["boil"]:
            self._add("water", "The boil-water notice is lifted.", s, "water-1")
        if now["gas"] and not p["gas"]:
            self._add("gas", "The gas compressor lost power: every cut order is 15% bigger until it's back.", s, "gas-1")

    def advise(self, s, event):
        """A routine card that didn't stop the game, as a notice saying what the player can do about it."""
        kind = event.get("kind")
        target = _target(event.get("title"), event.get("text"))
        if kind == "cold":
            self._add("cold", f"{event['title']} {event['text']} Restore it, or open a warming center.", s, target or "cold")
        elif kind == "short":
            self._add("order", f"{event['title']} Cut more neighborhoods: 30% short for 30 minutes collapses the grid.", s, "short")
        else:
            self._add("order", f"{event['title']} Cut more neighborhoods to meet it.", s, "order")

    def hold(self, s, short):
        self._add("order", f"Clock stopped: you are {short:,} MW short of the order. Cut more neighborhoods to go on.",
                  s, "hold")

    def restored(self, s, circuit_id, area):
        self._add("restore", f"{area} ({circuit_id}) is back on, as you scheduled.", s, circuit_id)

    def _add(self, kind, text, s, target):
        notice = {"id": f"{kind}-{target}-{s.get('step', 0)}-{len(text)}", "kind": kind, "text": text, "time": s["time"]}
        if target and TARGET.fullmatch(target):  # the screens fly the camera to a notice's target
            notice["target"] = target
        self.items = (self.items + [notice])[-MAX_NOTICES:]

    def clear(self):
        self.items, self.prev = [], None
