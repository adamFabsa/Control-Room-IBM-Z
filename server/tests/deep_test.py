"""Deep game test: many full games, many strategies, invariants checked at every step.

    podman exec -w /app control-room_server_1 python3 server/tests/deep_test.py [games per strategy]

Prints every invariant that broke (with the game and step) and a summary. Exit code 1 if anything broke.
"""
import copy
import random
import sys
import time
from collections import Counter
from datetime import datetime, timedelta

from app.engine import Game
from app.m2 import effective_cph
from app.players import PLAYERS, play_out, player
from app.report import hourly

GAMES = int(sys.argv[1]) if len(sys.argv) > 1 else 20
BUYS = [("protect", "C-02"), ("generator", "water-1"), ("warming_center", "school-1"), ("keep_gas", "gas-1"),
        ("conservation", "county"), ("repair_crews", "county"), ("smart_switch", "C-03")]
problems = Counter()
examples = {}


def fail(rule, where):
    problems[rule] += 1
    examples.setdefault(rule, where)


def check_step(prev, s, where):
    people_dark = sum(c["people"] for c in s["circuits"] if not c["on"])
    if s["totals"]["people_no_power"] != people_dark:
        fail("people_no_power = people on dark circuits", where)
    # indoor_f is rounded in the state: 49 is surely cold (< 49.5), 50 may be (< 50.5)
    surely = sum(c["people"] for c in s["circuits"] if c["indoor_f"] <= 49)
    maybe = sum(c["people"] for c in s["circuits"] if c["indoor_f"] <= 50)
    if not surely - 20_000 * len(s.get("warming_centers", [])) - 1 <= s["totals"]["people_cold"] <= maybe:
        fail("people_cold = people in cold homes minus warming centers", where)
    if not 0 <= s["points"] <= 10:
        fail("points stay 0..10", where)
    for c in s["circuits"]:
        if c["indoor_f"] > 69:
            fail("homes never warmer than 68°F", where)
    for b in s["buildings"]:
        if b["generator"] and not b["on"]:
            fail("a building with a fueled generator stays on", where)
    if s["event"] and not 2 <= len(s["event"]["options"]) <= 3:
        fail("event cards have 2-3 options", where)
    if prev is None or prev["phase"] != "storm" or s["phase"] != "storm":
        return
    stepped = s.get("step") != prev.get("step")
    if stepped:
        if datetime.fromisoformat(s["time"]) - datetime.fromisoformat(prev["time"]) != timedelta(minutes=5):
            fail("the clock moves 5 minutes per step", where)
        if s["totals"]["cold_person_hours"] < prev["totals"]["cold_person_hours"]:
            fail("cold person-hours never go down", where)
        before = {c["id"]: c for c in prev["circuits"]}
        for c in s["circuits"]:
            p = before.get(c["id"])
            if p and not p["on"] and not c["on"] and not (
                    min(p["indoor_f"], s["outside_f"]) - 1 <= c["indoor_f"] <= max(p["indoor_f"], s["outside_f"]) + 1):
                fail("dark homes drift toward the outside temperature", where)
            if p and p["on"] and c["on"] and c["dark_min"] != 0:
                fail("dark_min stays 0 while power is on", where)
            if p and not p["on"] and not c["on"] and c["dark_min"] != p["dark_min"] + 5:
                fail("dark_min grows 5 per step while dark", where)


def answer(game, s, rng, how, log):
    options = s["event"]["options"]
    first = next((o["id"] for o in options if o["ai_pick"]), options[0]["id"]) if how == "ai" else rng.choice(options)["id"]
    for option in [first] + [o["id"] for o in options if o["id"] != first]:
        try:
            game.apply({"type": "choose", "event": s["event"]["id"], "option": option})
            log.append({"step": s.get("step", 0), "action": {"type": "choose", "event": s["event"]["id"], "option": option}})
            return True
        except ValueError:
            continue
    fail("some option on every card is accepted", s["event"]["kind"] if "kind" in s["event"] else "?")
    return False


def strategy_moves(name, s, rng, k):
    """The actions a test strategy takes at this step."""
    lit = [c for c in s["circuits"] if c["on"] and not c["protected"]]
    dark = [c for c in s["circuits"] if not c["on"]]
    if name == "nothing":
        return []
    if name == "cut_everything":
        return [{"type": "cut", "circuit": c["id"]} for c in lit]
    if name == "chaos":
        moves = []
        for _ in range(rng.randint(0, 3)):
            r = rng.random()
            if r < 0.4 and lit:
                moves.append({"type": "cut", "circuit": rng.choice(lit)["id"]})
            elif r < 0.75 and dark:
                moves.append({"type": "restore", "circuit": rng.choice(dark)["id"]})
            elif r < 0.85:
                moves.append({"type": "emergency", "item": rng.choice(["generator", "warming_center", "conservation"]),
                              "target": rng.choice(["water-1", "hospital-1", "gas-1", "school-1", "C-07"])})
            else:  # junk the engine must refuse cleanly
                moves.append(rng.choice([{"type": "cut", "circuit": "C-99"}, {"type": "fly"}, {"type": "buy", "item": "protect"},
                                         {"type": "restore"}, {"type": "speed", "value": 9}]))
        return moves
    if name == "order_follower" and k % 12 == 0:
        need, moves = s["order_mw"] - s["cut_mw"], []
        for c in sorted(lit, key=lambda c: -c["indoor_f"]):
            if need <= 0:
                break
            moves.append({"type": "cut", "circuit": c["id"]})
            need -= c["mw"]
        return moves
    return []


def play_checked(storm, seed, name, rng, buys):
    game = Game(storm=storm, seed=seed)
    log = []
    for item, target in buys:
        try:
            game.apply({"type": "buy", "item": item, "target": target})
            log.append({"step": 0, "action": {"type": "buy", "item": item, "target": target}})
        except ValueError:
            pass
    game.apply({"type": "start_storm"})
    log.append({"step": 0, "action": {"type": "start_storm"}})  # logged in order, as the server does
    prev, k = None, 0
    decide = player(name) if name in ("greedy", "playbook_2021", "m2") else None
    for guard in range(20_000):
        s = game.state()
        where = f"{name} {storm}#{seed} step {s.get('step')}"
        check_step(prev, s, where)
        prev = copy.deepcopy(s)
        if s["phase"] != "storm":
            break
        if s["event"]:
            if not answer(game, s, rng, "random" if name == "chaos" else "ai", log):
                break
            continue
        moves = decide(s) if decide else strategy_moves(name, s, rng, k)
        for a in moves:
            try:
                game.apply(a)
                if a["type"] in ("cut", "restore", "emergency"):
                    log.append({"step": s.get("step", k), "action": a})
            except ValueError:
                pass
            if game.state()["event"]:
                break
        if game.state()["event"]:
            continue
        game.step()
        k += 1
    else:
        fail("every game ends", f"{name} {storm}#{seed}")
    score = game.score()
    if not 0 <= score["orders_met_pct"] <= 100:
        fail("orders_met_pct is a percentage", f"{name} {storm}#{seed}")
    if game.state()["phase"] != "over":
        fail("games end in phase over", f"{name} {storm}#{seed}")
    # chart data: one point per storm hour from the start, the same count the engine's timeline keeps
    series = hourly(game, [])
    if game.state().get("end_reason") == "storm_over" and len(series) != game.state()["steps_total"] // 12 + 1:
        fail("the chart has one point per storm hour", f"{name} {storm}#{seed}: {len(series)} points")
    # cold person-hours vs the chart: hourly cold people x (1 + vulnerability, 0.3..0.85) should bracket it
    people_hours = sum(p["people_cold"] for p in series)
    # weights are 1 + vulnerability (1.3-1.85); hourly samples miss short spikes, so this is a wide sanity band
    if people_hours and not 0.8 * people_hours <= score["cold_person_hours"] <= 2.5 * people_hours:
        fail("the cold-homes chart agrees with cold person-hours", f"{name} {storm}#{seed}: {people_hours} vs {score['cold_person_hours']}")
    return game, score, log


def main():
    rng = random.Random(7)
    start = time.time()
    storms = [("uri2021", 42), ("test", 1)] + [("generated", s) for s in range(GAMES)]
    results = Counter()
    collapses = Counter()
    for name in ("nothing", "order_follower", "greedy", "playbook_2021", "m2", "chaos", "cut_everything"):
        for i, (storm, seed) in enumerate(storms[:GAMES]):
            buys = rng.sample(BUYS, rng.randint(0, 4)) if name in ("chaos", "order_follower") else []
            if name == "order_follower" and i == 0:
                buys = BUYS  # try to buy everything (points run out)
            game, score, log = play_checked(storm, seed, name, rng, buys)
            results[name] += 1
            collapses[name] += bool(score.get("grid_collapsed"))
            if name in ("order_follower", "chaos"):  # same seed + same logged actions = same game
                from app.jobs import replay
                if replay(storm, seed, log)["cold_person_hours"] != score["cold_person_hours"]:
                    fail("replaying a game's actions gives the same score", f"{name} {storm}#{seed}")
    # the report's 2021 line is the engine's own playbook
    from stormgame import play
    a, b = play("playbook_2021", storm="uri2021", seed=42), play("playbook_2021", storm="uri2021", seed=42)
    if a.score() != b.score() or a.timeline != b.timeline:
        fail("the 2021 playbook is deterministic", "uri2021#42")
    print(f"{sum(results.values())} games in {time.time() - start:.0f}s: {dict(results)}")
    print(f"grid collapses by strategy: {dict(collapses)}")
    if not problems:
        print("all invariants held")
        return 0
    for rule, n in problems.most_common():
        print(f"BROKEN {n:5d}x  {rule}   e.g. {examples[rule]}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
