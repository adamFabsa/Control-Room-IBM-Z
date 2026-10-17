"""GET /api/report: the player's result next to the 2021 playbook and the AI playing alone.

When a storm ends, ReportJob fills in turning points, the analyst summary and the stress test in the
background; the report shows whatever is ready.
"""
import asyncio
import logging
from functools import lru_cache

from . import analyst, jobs
from .engine import Game
from .players import ai_player_name, play_out, player, run_official

log = logging.getLogger("controlroom.report")

STEPS_PER_HOUR = 12
_stress_baselines = {}  # playbook_2021 cold person-hours by generated-storm seed, shared by every stress test


def _hourly(history):
    return history[STEPS_PER_HOUR - 1::STEPS_PER_HOUR]


@lru_cache(maxsize=16)
def baselines(storm, seed):
    """Scores and hourly cold-homes curves for the two built-in players; same for every player."""
    out = {}
    official = run_official("playbook_2021", storm, seed)
    if official:
        out["real_2021"] = {"score": official[0], "hourly": official[1]}
    else:
        game, history = play_out(Game(storm=storm, seed=seed), player("playbook_2021"))
        out["real_2021"] = {"score": game.score(), "hourly": _hourly(history)}
    game, history = play_out(Game(storm=storm, seed=seed), player(ai_player_name()))
    out["ai_alone"] = {"score": game.score(), "hourly": _hourly(history)}
    return out


class ReportJob:
    def __init__(self):
        self.task = None
        self.turning_points = None
        self.turning_points_run = None
        self.summary = None
        self.summary_source = "pending"
        self.stress = {"status": "not_started"}

    def start(self, snapshot):
        if self.task is None:
            self.task = asyncio.create_task(self._run(snapshot))

    def cancel(self):
        if self.task:
            self.task.cancel()

    async def _run(self, snap):
        try:
            base = await asyncio.to_thread(baselines, snap["storm"], snap["seed"])
            scores = {"you": snap["score"], "real_2021": base["real_2021"]["score"], "ai_alone": base["ai_alone"]["score"]}
            self.turning_points, self.turning_points_run = await jobs.turning_points(
                snap["storm"], snap["seed"], snap["log"], snap["score"], snap["history"])
            self.summary, self.summary_source = analyst.template_summary(scores, self.turning_points), "template"
            plan = [e["action"] for e in snap["log"] if e["action"]["type"] == "buy"]
            await asyncio.gather(self._coach(), jobs.stress_test(plan, ai_player_name(), self.stress, _stress_baselines))
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("report job failed")

    async def _coach(self):
        # Facts come from the template; Granite adds one coaching sentence (a 2B model flipped comparisons
        # when asked to write the facts itself).
        if self.turning_points:
            tip = await analyst.write(analyst.TIP_PROMPT, analyst.tip_facts(self.turning_points), 60)
            if tip:
                self.summary, self.summary_source = f"{self.summary} {tip}", "granite"


def build_report(snapshot, base, job):
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
        "ai_alone_player": ai_player_name(),
        "winter_plan": [e["action"] for e in snapshot["log"] if e["action"]["type"] == "buy"],
        "turning_points": job.turning_points or [],
        "turning_points_run": job.turning_points_run,
        "summary": job.summary,
        "summary_source": job.summary_source,
        "stress_test": job.stress,
    }
