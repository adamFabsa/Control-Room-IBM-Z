"""Deep checks: random and malformed actions, invariants on every step, replay and clone."""

import json
import math
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from stormgame import ActionError, Game, play, replay  # noqa: E402
from stormgame import config as C  # noqa: E402

SEEDS = int(os.environ.get("FUZZ_SEEDS", "6"))
ITEMS = list(C.COSTS) + ["bogus", None]
IDS = [r[0] for r in C.CIRCUITS] + [b[0] for b in C.BUILDINGS] + ["C-03A", "C-03B", "nope", None, 7]


def random_action(g, rnd):
    kind = rnd.choice(["buy", "buy", "cut", "cut", "cut", "restore", "restore", "emergency", "choose",
                       "pause", "play", "speed", "start_storm", "garbage"])
    if kind == "buy" or kind == "emergency":
        return {"type": kind, "item": rnd.choice(ITEMS), "target": rnd.choice(IDS)}
    if kind in ("cut", "restore"):
        ids = [c.id for c in g.circuits] + [rnd.choice(IDS)]
        return {"type": kind, "circuit": rnd.choice(ids)}
    if kind == "choose":
        if g.event and rnd.random() < 0.9:
            return {"type": "choose", "event": g.event["id"],
                    "option": rnd.choice([o["id"] for o in g.event["options"]] + ["bad"])}
        return {"type": "choose", "event": "ev-999", "option": "x"}
    if kind == "speed":
        return {"type": "speed", "value": rnd.choice([1, 2, 3, 4, 5, 0, 9, "3", "abc", None])}
    if kind == "garbage":
        return rnd.choice([{}, {"type": None}, {"type": "cut"}, {"type": "buy"}, {"type": "launch"}])
    return {"type": kind}


class Checker:
    """Invariants that must hold after every action and every step."""

    def __init__(self, tc, g):
        self.tc, self.g = tc, g
        self.last = None

    def __call__(self):
        tc, g = self.tc, self.g
        s = g.state()
        text = json.dumps(s, allow_nan=False)          # serializable, no NaN/inf
        tc.assertIsInstance(json.loads(text), dict)
        tc.assertTrue(0 <= s["points"] <= C.START_POINTS)
        tc.assertIn(s["phase"], ("prepare", "storm", "over"))
        tc.assertIn(s["speed"], (1, 2, 3, 4, 5))

        off = [c for c in g.circuits if not g.is_on(c)]
        tc.assertEqual(s["cut_mw"], round(sum(c.mw for c in off if not c.protected)))
        tc.assertEqual(s["totals"]["people_no_power"], sum(c.people for c in off))
        tc.assertEqual(sum(c.people for c in g.circuits), 2_600_000)
        tc.assertAlmostEqual(sum(c.mw for c in g.circuits), 6500)
        for c in g.circuits:
            tc.assertFalse(c.protected and c.cut, f"{c.id} protected but cut")
            tc.assertTrue(math.isfinite(c.indoor_f))
            tc.assertLessEqual(c.indoor_f, C.WARM_F + 1e-6)
            tc.assertGreaterEqual(c.indoor_f, float(g.storm.outside_f.min()) - 1e-6)
            tc.assertIsInstance(c.mw, int)
        cold_cap = sum(c.people for c in g.circuits if c.indoor_f < C.COLD_F)
        tc.assertTrue(0 <= s["totals"]["people_cold"] <= cold_cap)
        warmed = sum(g._warmed().values())
        tc.assertLessEqual(warmed, C.WARMING_CENTER_PEOPLE * len(g.centers))

        for b, sb in zip(g.buildings, s["buildings"]):
            circuit_on = g.is_on(g._cmap[b.circuit])
            gas_kept = b.type == "gas_compressor" and g.keep_gas
            tc.assertEqual(sb["on"], circuit_on or b.fuel > 0 or gas_kept)
            tc.assertGreaterEqual(b.fuel, 0)
            tc.assertIn(b.circuit, g._cmap)

        if s["event"] is not None:
            tc.assertTrue(s["paused"])
            tc.assertTrue(2 <= len(s["event"]["options"]) <= 3, s["event"])
            tc.assertLessEqual(sum(o["ai_pick"] for o in s["event"]["options"]), 1)
            tc.assertEqual(s["phase"], "storm")
        else:
            tc.assertEqual(s["paused"], g.paused)

        sc = g.score()
        tc.assertTrue(0 <= sc["orders_met_pct"] <= 100)
        if self.last:
            for key in ("cold_person_hours", "critical_dark_min", "boil_water_person_hours",
                        "longest_outage_min", "water_plants_lost"):
                tc.assertGreaterEqual(sc[key], self.last[key], key)
        self.last = sc
        return s


def fuzz_game(tc, storm, seed, actions_per_step=3, steps=None):
    rnd = random.Random(f"{storm}-{seed}")
    g = Game(storm=storm, seed=seed)
    check = Checker(tc, g)
    for _ in range(rnd.randint(0, 12)):
        r = g.try_apply(random_action(g, rnd))
        tc.assertIn("ok", r)
        check()
    g.try_apply({"type": "start_storm"})
    tc.assertEqual(g.phase, "storm")
    n = 0
    prev_time = None
    while g.phase == "storm" and (steps is None or n < steps):
        for _ in range(rnd.randint(0, actions_per_step)):
            r = g.try_apply(random_action(g, rnd))
            tc.assertIn("ok", r)
            check()
        if g.event and rnd.random() < 0.7:
            g.try_apply({"type": "choose", "event": g.event["id"], "option": g.event["default"]})
        if g.paused and rnd.random() < 0.5:
            g.try_apply({"type": "play"})
        k = g.k
        g.step()
        if g.event is None and not g.paused and k == g.k and g.phase == "storm":
            tc.fail("step did not advance")
        s = check()
        if g.k != k:
            tc.assertEqual(g.k, k + 1)
            if prev_time:
                tc.assertGreater(s["time"], prev_time)
            prev_time = s["time"]
        n += 1
    return g


class TestFuzz(unittest.TestCase):
    def test_random_games_keep_invariants(self):
        for storm in ("uri2021", "generated", "test"):
            for seed in range(SEEDS):
                with self.subTest(storm=storm, seed=seed):
                    g = fuzz_game(self, storm, seed)
                    if g.phase == "over":
                        self.assertIn(g.end_reason, ("storm_over", "grid_collapse"))

    def test_random_games_replay_exactly(self):
        for seed in range(SEEDS):
            with self.subTest(seed=seed):
                g = fuzz_game(self, "uri2021", seed)
                while g.phase == "storm":         # finish games that stopped on a pause
                    g.try_apply({"type": "play"})
                    while g.event:
                        g.try_apply({"type": "choose", "event": g.event["id"], "option": g.event["default"]})
                    g.step()
                self.assertEqual(replay(g).score(), g.score())

    def test_replay_without_each_decision_runs(self):
        g = play("playbook_2021", storm="uri2021", seed=5)
        base = g.score()["cold_person_hours"]
        diffs = []
        for i in range(0, len(g.history), max(1, len(g.history) // 25)):
            r = replay(g, skip=i)
            self.assertEqual(r.phase, "over")
            diffs.append(r.score()["cold_person_hours"] - base)
        self.assertTrue(any(d != 0 for d in diffs))

    def test_clone_mid_game_matches_original_continuation(self):
        for seed in range(3):
            g = fuzz_game(self, "generated", seed, steps=300)
            c = g.clone()
            for game in (g, c):
                while game.phase == "storm":
                    game.try_apply({"type": "play"})
                    while game.event:
                        game.try_apply({"type": "choose", "event": game.event["id"], "option": game.event["default"]})
                    game.step()
            self.assertEqual(g.score(), c.score())
            self.assertEqual(g.state(), c.state())

    def test_malformed_actions_never_raise(self):
        g = Game(storm="test")
        bad = [{}, {"type": 5}, {"type": "buy", "item": "protect", "target": ["C-01"]},
               {"type": "speed", "value": {"x": 1}}, {"type": "cut", "circuit": {"a": 1}},
               {"type": "choose"}, {"type": "emergency", "item": "generator"}]
        for phase in ("prepare", "storm"):
            if phase == "storm":
                g.start_storm()
            for a in bad:
                r = g.try_apply(a)
                self.assertFalse(r["ok"], a)
        for a in ("not a dict", None, 42):
            self.assertFalse(g.try_apply(a)["ok"])

    def test_apply_raises_and_leaves_game_unchanged(self):
        g = Game(storm="test")
        g.start_storm()
        g.try_apply({"type": "buy", "item": "protect", "target": "C-01"})
        before = (json.dumps(g.state()), len(g.history), g.points)
        for a in ({"type": "cut", "circuit": "C-99"}, {"type": "launch"}, "x",
                  {"type": "emergency", "item": "generator", "target": "C-01"},
                  {"type": "buy", "item": "smart_switch", "target": "C-02"},
                  {"type": "choose", "event": "ev-1", "option": "gen"}):
            with self.assertRaises(ValueError):
                g.apply(a)
            with self.assertRaises(ActionError):
                g.apply(a)
        self.assertEqual((json.dumps(g.state()), len(g.history), g.points), before)
        self.assertTrue(g.start_storm() is not None)       # starting twice does not raise

    def test_actions_after_game_over(self):
        g = play("greedy", storm="test", seed=0)
        self.assertEqual(g.phase, "over")
        before = g.score()
        for a in ({"type": "cut", "circuit": "C-01"}, {"type": "start_storm"},
                  {"type": "buy", "item": "protect", "target": "C-01"},
                  {"type": "emergency", "item": "generator", "target": "water-1"}):
            self.assertFalse(g.try_apply(a)["ok"], a)
        g.step()
        self.assertEqual(g.score(), before)

    def test_every_event_option_resolves(self):
        """Open every kind of card and pick every option it offers."""
        seen = set()
        for seed in range(SEEDS * 3):
            rnd = random.Random(seed)
            g = Game(storm=rnd.choice(["uri2021", "generated"]), seed=seed)
            g.start_storm()
            while g.phase == "storm":
                if g.event:
                    opt = rnd.choice(g.event["options"])["id"]
                    seen.add((g.event["kind"], opt))
                    r = g.try_apply({"type": "choose", "event": g.event["id"], "option": opt})
                    self.assertTrue(r["ok"], (g.event, opt, r))
                    continue
                if rnd.random() < 0.08:
                    g.try_apply({"type": "cut", "circuit": rnd.choice([c.id for c in g.circuits])})
                elif rnd.random() < 0.05:
                    g.try_apply({"type": "restore", "circuit": rnd.choice([c.id for c in g.circuits])})
                g.step()
        kinds = {k for k, _ in seen}
        for kind in ("critical_cut", "order_rise", "short", "cold"):
            self.assertIn(kind, kinds)

    def test_plan_reuse_on_generated_storms(self):
        g = Game(storm="uri2021", seed=1)
        for a in ({"type": "buy", "item": "generator", "target": "water-1"},
                  {"type": "buy", "item": "keep_gas"},
                  {"type": "buy", "item": "smart_switch", "target": "C-03"},
                  {"type": "buy", "item": "protect", "target": "hospital-1"},
                  {"type": "buy", "item": "conservation"},
                  {"type": "buy", "item": "repair_crews"}):
            self.assertTrue(g.try_apply(a)["ok"], a)
        self.assertEqual(g.points, 1)
        plan = g.plan()
        self.assertEqual(len(plan), 6)
        for seed in range(5):
            r = play("greedy", storm="generated", seed=seed, plan=plan)
            self.assertEqual(r.points, 1)
            self.assertEqual(r.score()["water_plants_lost"], 0)

    def test_prep_tips_and_state_in_prep(self):
        g = Game()
        s = g.state()
        self.assertEqual(s["phase"], "prepare")
        self.assertEqual(s["time"], "2021-02-12T12:00:00-06:00")
        self.assertEqual(s["order_mw"], 0)
        self.assertIsNone(s["event"])
        self.assertTrue(all(c["on"] for c in s["circuits"]))
        self.assertTrue(s["copilot"]["tip"])
        self.assertFalse(g.try_apply({"type": "cut", "circuit": "C-01"})["ok"])
        self.assertFalse(g.try_apply({"type": "emergency", "item": "generator", "target": "water-1"})["ok"])
        g.step()
        self.assertEqual(g.k, 0)

    def test_storm_timeline_and_time(self):
        g = play("greedy", storm="uri2021", seed=0)
        self.assertEqual(g.state()["time"], "2021-02-19T12:00:00-06:00")
        self.assertEqual(len(g.timeline), 114 + 2)     # start, each hour, and the end
        self.assertEqual(g.timeline[0]["time"], "2021-02-14T18:00:00-06:00")

    def test_storm_curves(self):
        from stormgame.storms import load_storm
        uri = load_storm("uri2021")
        self.assertEqual(uri.n_steps, 114 * 12)
        hours = [i / 12 for i in range(len(uri.order_mw))]
        self.assertTrue(all(o == 0 for o, h in zip(uri.order_mw, hours) if h < 7 + 20 / 60))
        self.assertGreater(uri.order_mw.max(), 1000)
        self.assertLess(uri.outside_f.min(), 0)            # DFW hit -2°F
        for seed in range(500):
            s = load_storm("generated", seed)
            self.assertGreaterEqual(s.n_steps, 36 * 12)
            self.assertTrue((s.order_mw >= 0).all())
            self.assertTrue(math.isfinite(s.outside_f.sum()))
        import numpy as np
        self.assertFalse(np.array_equal(load_storm("generated", 1).outside_f, load_storm("generated", 2).outside_f))
        self.assertTrue(np.array_equal(load_storm("generated", 3).outside_f, load_storm("generated", 3).outside_f))


if __name__ == "__main__":
    unittest.main()
