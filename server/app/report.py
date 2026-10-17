"""GET /api/report: the player's result next to the 2021 playbook and the AI playing alone."""
from functools import lru_cache

from .engine import Game
from .players import PLAYERS, play_out

STEPS_PER_HOUR = 12
AI_ALONE_PLAYER = "greedy"  # replaced by the M2 what-if player once it is trained


def _hourly(history):
    return history[STEPS_PER_HOUR - 1::STEPS_PER_HOUR]


@lru_cache(maxsize=16)
def baselines(storm, seed):
    """Scores and hourly cold-homes curves for the two built-in players; same for every player."""
    out = {}
    for name, player in (("real_2021", "playbook_2021"), ("ai_alone", AI_ALONE_PLAYER)):
        game, history = play_out(Game(storm=storm, seed=seed), PLAYERS[player])
        out[name] = {"score": game.score(), "hourly": _hourly(history)}
    return out


def build_report(snapshot, base):
    you = _hourly(snapshot["history"])
    axis = base["real_2021"]["hourly"]
    return {
        "storm": snapshot["storm"],
        "seed": snapshot["seed"],
        "phase": snapshot["phase"],
        "scores": {
            "you": snapshot["score"],
            "real_2021": base["real_2021"]["score"],
            "ai_alone": base["ai_alone"]["score"],
        },
        "chart": {
            "time": [h["time"] for h in axis],
            "you": [h["people_cold"] for h in you],
            "real_2021": [h["people_cold"] for h in axis],
            "ai_alone": [h["people_cold"] for h in base["ai_alone"]["hourly"]],
        },
        "ai_alone_player": AI_ALONE_PLAYER,
        "winter_plan": [e["action"] for e in snapshot["log"] if e["action"]["type"] == "buy"],
        "turning_points": [],
        "summary": None,
        "stress_test": {"status": "not_started"},
    }
