"""Built-in players for the comparison, a headless runner, and replays for turning points."""

from . import config as C
from .game import Game


class Playbook2021:
    """Cuts by the real order, rotates in a fixed order, protects only the hospital."""

    name = "playbook_2021"

    def __init__(self):
        self.pointer = 0

    def plan(self):
        return [{"type": "buy", "item": "protect", "target": "hospital-1"}]

    def act(self, g):
        for c in g.circuits:
            if c.cut and c.dark_min >= C.PLAYBOOK_ROTATE_MIN:
                g.apply({"type": "restore", "circuit": c.id})
        order = g.order_now()
        tries = 0
        while g.cut_mw() < order * (1 - C.SHORT_WARN / 2) and tries < len(g.circuits):
            c = g.circuits[self.pointer % len(g.circuits)]
            self.pointer += 1
            tries += 1
            if g._cuttable(c):
                g.apply({"type": "cut", "circuit": c.id})
                if g.event:
                    return
        # Shed surplus cuts, longest dark first.
        for c in sorted((c for c in g.circuits if c.cut), key=lambda c: -c.dark_min):
            if g.cut_mw() - c.mw >= order:
                g.apply({"type": "restore", "circuit": c.id})

    def choose(self, g, ev):
        return {"critical_cut": "dark", "ice": "dark", "fuel": "dark", "order_rise": "manual",
                "short": "wait", "cold": "keep"}.get(ev["kind"], ev["default"])


class Greedy:
    """Each step, restores the coldest circuits and cuts the warmest unprotected ones."""

    name = "greedy"
    STICKY_F = 3.0          # a circuit already cut counts this much warmer, to stop flip-flopping

    def plan(self):
        return []

    def act(self, g):
        order = g.order_now() * (1 - C.SHORT_WARN / 2)
        ice_mw = sum(c.mw for c in g.circuits if not c.protected and g.k < c.ice_until)
        pool = [c for c in g.circuits if not c.protected and g.k >= c.ice_until]
        pool.sort(key=lambda c: (bool(g._exposed(c)), -(c.indoor_f + (self.STICKY_F if c.cut else 0))))
        keep, total = set(), ice_mw
        for c in pool:
            if total >= order:
                break
            keep.add(c.id)
            total += c.mw
        for c in pool:
            if c.cut and c.id not in keep:
                g.apply({"type": "restore", "circuit": c.id})
        for c in pool:
            if not c.cut and c.id in keep:
                g.apply({"type": "cut", "circuit": c.id})
                if g.event:
                    return

    def choose(self, g, ev):
        ids = [o["id"] for o in ev["options"]]
        for pick in ("other", "restore", "auto"):
            if pick in ids:
                return pick
        return ev["default"]


PLAYERS = {"playbook_2021": Playbook2021, "greedy": Greedy}


def play(player="greedy", storm="uri2021", seed=42, plan=None, ai_picker=None):
    """Play a full game headless and return the finished Game.

    plan replaces the player's own Get ready purchases (used by the stress test).
    """
    p = PLAYERS[player]() if isinstance(player, str) else player
    g = Game(storm=storm, seed=seed, ai_picker=ai_picker)
    for a in (p.plan() if plan is None else plan):
        g.apply(a)
    g.start_storm()
    while g.phase == "storm":
        for _ in range(50):
            if g.event:
                _choose(g, p.choose(g, g.event))
                continue
            p.act(g)
            if not g.event:
                break
        while g.event:
            _choose(g, g.event["default"])
        g.step()
    return g


def _choose(g, option):
    r = g.apply({"type": "choose", "event": g.event["id"], "option": option})
    if not r["ok"]:
        g.apply({"type": "choose", "event": g.event["id"], "option": g.event["default"]})


def replay(game, skip=None):
    """Replay a game's decisions on a fresh Game with the same storm and seed.

    skip is the index in game.history of one decision to leave out. Events that no recorded
    decision answers take their do-nothing default. Used for turning points.
    """
    g = Game(storm=game.storm, seed=game.seed, ai_picker=game.ai_picker)
    by_step = {}
    for i, h in enumerate(game.history):
        if i == skip:
            continue
        if h["phase"] == "prep":
            g.apply(h["action"])
        else:
            by_step.setdefault(h["step"], []).append(h)
    if g.phase == "prep":
        g.start_storm()
    while g.phase == "storm":
        for h in by_step.get(g.k, []):
            a = h["action"]
            if a["type"] == "choose":
                if g.event and g.event["kind"] == h["event_kind"]:
                    _choose(g, a["option"])
            elif a["type"] != "start_storm":
                g.apply(a)
        while g.event:
            _choose(g, g.event["default"])
        g.step()
    return g
