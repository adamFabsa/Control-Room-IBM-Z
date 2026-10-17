import math
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np  # noqa: E402

from stormgame import Game, Storm, load_storm, play, replay  # noqa: E402
from stormgame.storms import URI_START  # noqa: E402


def unit_storm(order_mw=0.0, hours=114):
    n = hours * 12 + 1
    return Storm("unit", URI_START, np.full(n, 10.0), np.full(n, float(order_mw)))


def run(g, steps):
    """Step forward, answering any event card with its do-nothing default."""
    for _ in range(steps):
        while g.event:
            g.apply({"type": "choose", "event": g.event["id"], "option": g.event["default"]})
        g.step()


def storm_game(*buys, order_mw=0.0):
    g = Game(storm=unit_storm(order_mw), seed=1)
    for item, target in buys:
        assert g.apply({"type": "buy", "item": item, "target": target})["ok"]
    g.start_storm()
    g.ice = []                                  # no random line breaks in unit tests
    return g


def cut(g, cid, option="dark"):
    g.apply({"type": "cut", "circuit": cid})
    if g.event and g.event["kind"] == "critical_cut":
        g.apply({"type": "choose", "event": g.event["id"], "option": option})


class TestCooling(unittest.TestCase):
    def test_dark_home_cools_exponentially(self):
        g = storm_game()
        cut(g, "C-01")                         # vulnerability 0.30 -> tau 10 h
        run(g, 12)
        expected = 10 + (68 - 10) * math.exp(-1 / 10)
        self.assertAlmostEqual(g._cmap["C-01"].indoor_f, expected, places=6)

    def test_older_homes_cool_faster(self):
        g = storm_game()
        cut(g, "C-13")                         # vulnerability 0.85 -> tau 7 h
        run(g, 12)
        self.assertAlmostEqual(g._cmap["C-13"].indoor_f, 10 + 58 * math.exp(-1 / 7), places=6)

    def test_restored_home_warms_and_cold_hours_count(self):
        g = storm_game()
        cut(g, "C-13")
        run(g, 12 * 5)
        self.assertLess(g._cmap["C-13"].indoor_f, 50)
        self.assertGreater(g.score()["cold_person_hours"], 0)
        g.apply({"type": "restore", "circuit": "C-13"})
        run(g, 12 * 6)
        self.assertGreater(g._cmap["C-13"].indoor_f, 60)


class TestProtect(unittest.TestCase):
    def test_protected_circuit_cannot_be_cut(self):
        g = storm_game(("protect", "C-01"))
        r = g.apply({"type": "cut", "circuit": "C-01"})
        self.assertFalse(r["ok"])
        self.assertTrue(g.is_on(g._cmap["C-01"]))
        self.assertEqual(g.points, 9)

    def test_protecting_a_building_protects_its_circuit(self):
        g = storm_game(("protect", "hospital-1"))
        self.assertTrue(g._cmap["C-02"].protected)
        self.assertTrue(next(b for b in g.state()["buildings"] if b["id"] == "hospital-1")["protected"])


class TestGenerator(unittest.TestCase):
    def test_building_stays_on_and_burns_fuel(self):
        g = storm_game(("generator", "water-1"))
        cut(g, "C-04")
        self.assertIsNone(g.event)             # backed-up building raises no card
        run(g, 12 * 3)
        water = g._bmap["water-1"]
        self.assertTrue(g.building_on(water))
        self.assertEqual(g.score()["water_plants_lost"], 0)
        self.assertEqual(water.fuel, 48 * 12 - 36)

    def test_generator_runs_out_after_48_hours(self):
        g = storm_game(("generator", "hospital-1"))
        cut(g, "C-02")
        run(g, 48 * 12)
        self.assertFalse(g.building_on(g._bmap["hospital-1"]))

    def test_cutting_an_exposed_building_opens_a_card(self):
        g = storm_game()
        g.apply({"type": "cut", "circuit": "C-04"})
        self.assertEqual(g.event["kind"], "critical_cut")
        self.assertTrue(g.state()["paused"])
        self.assertTrue(g.is_on(g._cmap["C-04"]))  # nothing cut until decided
        g.apply({"type": "choose", "event": g.event["id"], "option": "gen"})
        self.assertFalse(g.is_on(g._cmap["C-04"]))
        self.assertTrue(g.building_on(g._bmap["water-1"]))
        self.assertEqual(g.points, 8)


class TestGas(unittest.TestCase):
    def test_gas_loss_multiplies_orders_until_two_hours_after(self):
        g = storm_game(order_mw=1000)
        for cid in ("C-10", "C-11", "C-12"):   # 1,350 MW covers the order even at x1.15
            cut(g, cid)
        self.assertEqual(round(g.order_now()), 1000)
        cut(g, "C-05")
        run(g, 1)
        self.assertAlmostEqual(g.order_now(), 1150)
        g.apply({"type": "restore", "circuit": "C-05"})
        run(g, 24)
        self.assertAlmostEqual(g.order_now(), 1150)
        run(g, 1)
        self.assertAlmostEqual(g.order_now(), 1000)

    def test_keep_gas_flowing(self):
        g = storm_game(("keep_gas", None), order_mw=1000)
        for cid in ("C-10", "C-11", "C-12"):
            cut(g, cid)
        cut(g, "C-05")
        self.assertIsNone(g.event)
        run(g, 6)
        self.assertAlmostEqual(g.order_now(), 1000)


class TestWater(unittest.TestCase):
    def test_boil_water_after_two_hours_dark(self):
        g = storm_game()
        cut(g, "C-04")
        run(g, 23)
        self.assertEqual(g.state()["boil_water_people"], 0)
        run(g, 1)
        self.assertEqual(g.state()["boil_water_people"], 180_000)
        self.assertEqual(g.score()["water_plants_lost"], 1)

    def test_boil_water_ends_24_hours_after_power_returns(self):
        g = storm_game()
        cut(g, "C-04")
        run(g, 30)
        g.apply({"type": "restore", "circuit": "C-04"})
        run(g, 24 * 12 - 1)
        self.assertEqual(g.state()["boil_water_people"], 180_000)
        run(g, 2)
        self.assertEqual(g.state()["boil_water_people"], 0)
        self.assertGreater(g.score()["boil_water_person_hours"], 180_000 * 24)


class TestOtherButtons(unittest.TestCase):
    def test_smart_switch_splits_circuit(self):
        g = storm_game(("smart_switch", "C-03"))
        ids = [c["id"] for c in g.state()["circuits"]]
        self.assertIn("C-03A", ids)
        self.assertIn("C-03B", ids)
        self.assertEqual(g._bmap["dialysis-1"].circuit, "C-03A")
        cut(g, "C-03B")
        self.assertIsNone(g.event)
        self.assertTrue(g.building_on(g._bmap["dialysis-1"]))
        self.assertEqual(g.cut_mw(), 200)

    def test_warming_center_reduces_cold_people(self):
        g = storm_game(("warming_center", "school-1"))
        cut(g, "C-06")
        run(g, 12 * 6)
        self.assertEqual(g.state()["totals"]["people_cold"], 180_000 - 20_000)

    def test_conservation_cuts_order_3_percent(self):
        g = storm_game(("conservation", None), order_mw=1000)
        self.assertAlmostEqual(g.order_now(), 970)

    def test_not_enough_points(self):
        g = Game(storm=unit_storm())
        for b in ("hospital-1", "dialysis-1", "water-1", "gas-1", "school-1"):
            self.assertTrue(g.apply({"type": "buy", "item": "generator", "target": b})["ok"])
        self.assertFalse(g.apply({"type": "buy", "item": "protect", "target": "C-01"})["ok"])
        self.assertEqual(g.points, 0)

    def test_ice_break_darkens_circuit_and_crews_shorten_it(self):
        for crews, hours in ((False, 6), (True, 2)):
            g = storm_game(*([("repair_crews", None)] if crews else []))
            g.ice = [[1, "C-10", False]]
            run(g, 1)
            self.assertFalse(g.is_on(g._cmap["C-10"]))
            run(g, hours * 12 - 1)
            self.assertFalse(g.is_on(g._cmap["C-10"]))
            run(g, 1)
            self.assertTrue(g.is_on(g._cmap["C-10"]))

    def test_short_order_opens_card_and_collapses(self):
        g = storm_game(order_mw=1000)
        run(g, 3)
        self.assertEqual(g.event["kind"], "short")
        run(g, 3)
        self.assertEqual(g.phase, "done")
        self.assertTrue(g.score()["grid_collapsed"])


class TestWholeGame(unittest.TestCase):
    def test_full_uri_game_is_fast_and_deterministic(self):
        load_storm("uri2021")                   # one-time data load is not part of a game
        for player in ("playbook_2021", "greedy"):
            t0 = time.perf_counter()
            a = play(player, storm="uri2021", seed=42)
            self.assertLess(time.perf_counter() - t0, 2.0)
            self.assertEqual(a.phase, "done")
            self.assertEqual(a.end_reason, "storm_over")
            b = play(player, storm="uri2021", seed=42)
            self.assertEqual(a.score(), b.score())

    def test_generated_storm_is_seeded(self):
        a = play("greedy", storm="generated", seed=7).score()
        b = play("greedy", storm="generated", seed=7).score()
        self.assertEqual(a, b)

    def test_clone_is_independent(self):
        g = storm_game()
        c = g.clone()
        cut(c, "C-01")
        run(c, 12)
        self.assertTrue(g.is_on(g._cmap["C-01"]))
        self.assertEqual(g.k, 0)
        self.assertIs(c.storm, g.storm)

    def test_replay_reproduces_score(self):
        g = play("greedy", storm="uri2021", seed=3)
        self.assertEqual(replay(g).score(), g.score())

    def test_state_matches_contract(self):
        s = play("greedy", storm="uri2021", seed=1).state()
        for key in ("time", "phase", "paused", "speed", "outside_f", "order_mw", "cut_mw", "points",
                    "circuits", "buildings", "totals", "event", "copilot"):
            self.assertIn(key, s)
        for key in ("id", "area", "on", "protected", "dark_min", "indoor_f", "people", "mw", "split"):
            self.assertIn(key, s["circuits"][0])
        for key in ("id", "type", "circuit", "on", "generator", "protected"):
            self.assertIn(key, s["buildings"][0])
        for key in ("people_no_power", "people_cold", "cold_person_hours"):
            self.assertIn(key, s["totals"])
        score = play("greedy", storm="test", seed=1).score()
        for key in ("cold_person_hours", "longest_outage_min", "critical_dark_min",
                    "water_plants_lost", "orders_met_pct"):
            self.assertIn(key, score)


if __name__ == "__main__":
    unittest.main()
