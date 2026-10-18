"""Batch jobs spread over LinuxONE's cores: turning-point replays and the 1,000-storm stress test.

Cold person-hours here count a grid collapse as a loss (m2.effective_cph): a collapsed game ends early.
"""
import asyncio
import multiprocessing
import os
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime

from .engine import Game
from .m2 import effective_cph
from .players import PLAYERS, play_out, player, run_official

DECISIONS = {"buy", "cut", "restore", "emergency", "choose"}
MAX_REPLAYS = 150
STRESS_STORMS = 1000
ITEM_NAMES = {"protect": "protecting", "generator": "a generator at", "warming_center": "a warming center at",
              "keep_gas": "keeping gas flowing at", "conservation": "a conservation alert",
              "repair_crews": "repair crews at", "smart_switch": "smart switches on"}

_pool = None


def pool():
    global _pool
    if _pool is None:
        # spawn, not fork: the server process has threads (database, analyst)
        _pool = ProcessPoolExecutor(max_workers=os.cpu_count(), mp_context=multiprocessing.get_context("spawn"))
    return _pool


def _ai_pick(event):
    return next((o for o in event["options"] if o["ai_pick"]), event["options"][0])["id"]


def replay(storm, seed, log, skip=None, max_steps=20_000):
    """Score of a logged game, optionally without log entry `skip`.

    Actions are applied at their logged steps; ones that no longer make sense are skipped, and event
    cards the player never saw take the AI pick.
    """
    game = Game(storm=storm, seed=seed)
    entries = [e for i, e in enumerate(log) if i != skip]
    j = step = 0
    for _ in range(max_steps):
        while j < len(entries) and entries[j]["step"] <= step:
            action = dict(entries[j]["action"])
            j += 1
            if action["type"] == "choose":
                event = game.state()["event"]
                if not event:
                    continue
                action["event"] = event["id"]
            try:
                game.apply(action)
            except Exception:
                pass
        state = game.state()
        if state["phase"] == "prepare":
            game.apply({"type": "start_storm"})
        elif state["phase"] != "storm":
            break
        elif state["event"]:
            try:
                game.apply({"type": "choose", "event": state["event"]["id"], "option": _ai_pick(state["event"])})
            except Exception:
                break
        else:
            game.step()
            step += 1
    return game.score()


def _when(entry, history):
    if entry["step"] == 0 or entry["step"] > len(history):
        return "Get ready"
    return datetime.fromisoformat(history[entry["step"] - 1]["time"]).strftime("%a %H:%M")


def label(entry, history):
    a = entry["action"]
    when = _when(entry, history)
    if a["type"] == "buy":
        return f"{ITEM_NAMES.get(a['item'], a['item'])} {a.get('target') or ''}".strip() + " in Get ready"
    if a["type"] in ("cut", "restore"):
        return f"{'cutting' if a['type'] == 'cut' else 'restoring'} {a['circuit']} on {when}"
    if a["type"] == "emergency":
        return f"an emergency {a['item'].replace('_', ' ')} at {a['target']} on {when}"
    return f"choosing \"{entry.get('option_label', a['option'])}\" on {when}"


async def turning_points(storm, seed, log, score, history, top=3):
    """The `top` decisions whose removal changes cold person-hours the most."""
    candidates = [i for i, e in enumerate(log) if e["action"]["type"] in DECISIONS]
    if len(candidates) > MAX_REPLAYS:  # keep every buy and choice, thin out cuts and restores evenly
        firm = [i for i in candidates if log[i]["action"]["type"] not in ("cut", "restore")]
        rest = [i for i in candidates if i not in firm]
        stride = len(rest) / max(1, MAX_REPLAYS - len(firm))
        candidates = sorted(firm + [rest[int(k * stride)] for k in range(MAX_REPLAYS - len(firm))])
    loop = asyncio.get_running_loop()
    start = time.perf_counter()
    scores = await asyncio.gather(*(loop.run_in_executor(pool(), replay, storm, seed, log, i) for i in candidates))
    seconds = time.perf_counter() - start
    actual = score["cold_person_hours"]
    ranked = sorted(zip(candidates, scores), key=lambda p: -abs(effective_cph(p[1]) - effective_cph(score)))
    points = [{"rank": rank + 1, "step": log[i]["step"], "action": log[i]["action"], "label": label(log[i], history),
               "cold_person_hours_without": s["cold_person_hours"],
               "cold_person_hours_change": s["cold_person_hours"] - actual,
               "grid_collapsed_without": bool(s.get("grid_collapsed")),
               "grid_collapsed": bool(score.get("grid_collapsed"))}
              for rank, (i, s) in enumerate(ranked[:top])]
    return points, {"replays": len(candidates), "seconds": round(seconds, 2), "cores": os.cpu_count()}


def run_storm(seed, plan, operator, with_baseline):
    """One generated storm: the winter plan with `operator` deciding during the storm, and optionally playbook_2021."""
    game = Game(storm="generated", seed=seed)
    for action in plan:
        try:
            game.apply(action)
        except Exception:
            pass
    decide = player(operator)
    game, _ = play_out(game, lambda s: [] if s["phase"] == "prepare" else decide(s))
    baseline = None
    if with_baseline:
        official = run_official("playbook_2021", "generated", seed)
        played = official[0] if official else play_out(Game(storm="generated", seed=seed), PLAYERS["playbook_2021"])[0].score()
        baseline = (effective_cph(played), played["cold_person_hours"])
    score = game.score()
    return seed, effective_cph(score), baseline, bool(score.get("grid_collapsed")), score["cold_person_hours"]


def baseline_storm(seed):
    official = run_official("playbook_2021", "generated", seed)
    played = official[0] if official else play_out(Game(storm="generated", seed=seed), PLAYERS["playbook_2021"])[0].score()
    return seed, (effective_cph(played), played["cold_person_hours"])


async def baselines_for(seeds, baselines):
    loop = asyncio.get_running_loop()
    for seed, value in await asyncio.gather(*(loop.run_in_executor(pool(), baseline_storm, s) for s in seeds if s not in baselines)):
        baselines[seed] = value


async def stress_test(plan, operator, status, baselines):
    """Fills `status` as storms finish; `baselines` caches playbook_2021 scores by seed across tests."""
    loop = asyncio.get_running_loop()
    status.update({"status": "running", "storms": STRESS_STORMS, "done": 0, "operator": operator,
                   "cores": os.cpu_count()})
    start = time.perf_counter()
    futures = [loop.run_in_executor(pool(), run_storm, seed, plan, operator, seed not in baselines)
               for seed in range(1, STRESS_STORMS + 1)]
    wins, collapses, worst = 0, 0, None
    for future in asyncio.as_completed(futures):
        seed, cph, baseline, collapsed, raw = await future
        collapses += collapsed
        if baseline is not None:
            baselines[seed] = baseline
        baseline, raw_baseline = baselines[seed]
        wins += cph < baseline
        if worst is None or cph > worst["cold_person_hours"]:
            worst = {"seed": seed, "cold_person_hours": cph, "playbook_cold_person_hours": baseline, "collapsed": collapsed,
                     "raw_cold_person_hours": raw, "raw_playbook_cold_person_hours": raw_baseline}
        status["done"] += 1
        status["wins"] = wins
        status["collapses"] = collapses
    status.update({"status": "done", "win_pct": round(100 * wins / STRESS_STORMS, 1), "worst": worst,
                   "seconds": round(time.perf_counter() - start, 1)})
