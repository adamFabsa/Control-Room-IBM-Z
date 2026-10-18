"""GET /api/report: the player's result next to the 2021 playbook and the AI playing alone.

When a storm ends, ReportJob fills in turning points, the analyst summary and the stress test in the
background; the report shows whatever is ready.
"""
import asyncio
import logging
from functools import lru_cache

from . import analyst, jobs
from .engine import Game
from .m2 import effective_cph
from .players import ai_player_name, play_out, player, run_official, timeline_points

log = logging.getLogger("controlroom.report")

STEPS_PER_HOUR = 12
# Texas DSHS, "February 2021 Winter Storm-Related Deaths - Texas" (final report; data as of Oct 27, 2021):
# 22 confirmed storm-related deaths in Dallas County (246 statewide; 65% from extreme cold exposure).
DSHS_DALLAS_DEATHS = 22
DSHS_URL = "https://www.dshs.texas.gov/sites/default/files/news/updates/SMOC_FebWinterStorm_MortalitySurvReport_12-30-21.pdf"
_stress_baselines = {}  # playbook_2021 cold person-hours by generated-storm seed, shared by every stress test


def _hourly(history):
    return history[STEPS_PER_HOUR - 1::STEPS_PER_HOUR]


def hourly(game, history):
    """People in cold homes each hour of the storm, from the storm's start: the engine's own timeline when it
    keeps one (so every line on the chart is counted the same way), else the server's per-step history."""
    timeline = getattr(game, "timeline", None)
    return timeline_points(timeline) if timeline else _hourly(history)


@lru_cache(maxsize=16)
def baselines(storm, seed):
    """Scores and hourly cold-homes curves for the two built-in players; same for every player."""
    out = {}
    official = run_official("playbook_2021", storm, seed)
    if official:
        out["real_2021"] = {"score": official[0], "hourly": official[1]}
    else:
        game, history = play_out(Game(storm=storm, seed=seed), player("playbook_2021"))
        out["real_2021"] = {"score": game.score(), "hourly": hourly(game, history)}
    game, history = play_out(Game(storm=storm, seed=seed), player(ai_player_name()))
    out["ai_alone"] = {"score": game.score(), "hourly": hourly(game, history)}
    return out


async def prewarm_stress_baselines():
    """The 2021 playbook on every stress-test storm, once at startup, so each report only runs the player's plan."""
    try:
        await jobs.baselines_for(range(1, jobs.STRESS_STORMS + 1), _stress_baselines)
        log.info("stress-test baselines ready (%d storms)", len(_stress_baselines))
    except Exception:
        log.exception("stress-test baseline prewarm failed")


class ReportJob:
    def __init__(self):
        self.task = None
        self.turning_points = None
        self.turning_points_run = None
        self.summary = None
        self.summary_source = "pending"
        self.stress = {"status": "not_started"}

    def start(self, snapshot, quick=False):
        self.quick = quick
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
            # quick play: the engine-style greedy operator (about 35 s for 1,000 storms; M2 takes about 105 s)
            operator = "greedy" if getattr(self, "quick", False) else ai_player_name()
            await asyncio.gather(self._coach(), jobs.stress_test(plan, operator, self.stress, _stress_baselines))
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("report job failed")

    async def _coach(self):
        # Facts come from the template; Granite adds one coaching sentence (a 2B model flipped comparisons
        # when asked to write the facts itself).
        if self.turning_points:
            tip = await analyst.write(analyst.TIP_PROMPT, analyst.tip_facts(self.turning_points), 60,
                                      tries=3, forbidden=analyst.tip_forbidden(self.turning_points))
            if tip:
                self.summary, self.summary_source = f"{self.summary} {tip}", "granite"


def estimated_deaths(score, real):
    """DSHS's 22 Dallas County deaths, scaled by hours in cold homes against the 2021 playbook (2021's own count).
    None after a grid collapse: days of total blackout aren't something this scale covers."""
    if score.get("grid_collapsed") or not real["cold_person_hours"]:
        return None
    return round(DSHS_DALLAS_DEATHS * score["cold_person_hours"] / real["cold_person_hours"])


PLAN_NAMES = {"protect": "Protect {}", "generator": "A generator at {}", "warming_center": "A warming center at {}",
              "keep_gas": "Keep gas flowing at {}", "conservation": "A conservation alert", "repair_crews": "Repair crews ready",
              "smart_switch": "Smart switches on {}"}


def _stress_for_screen(stress):
    """The screen's shape {storms, works, worst: text}, once the test is done; None while it runs."""
    if stress.get("status") != "done":
        return None
    w = stress["worst"]
    worst = (f"Hardest storm (#{w['seed']}): the grid collapsed with your plan" if w.get("collapsed") else
             f"Hardest storm (#{w['seed']}): {w['raw_cold_person_hours']:,} cold person-hours with your plan, "
             f"{w['raw_playbook_cold_person_hours']:,} with the 2021 playbook")
    return {**stress, "works": stress["wins"], "worst": worst, "worst_storm": w}


def explorer_series(axis, lines, forecast=None):
    """Every hourly series the report's data explorer can chart: per game (2021, AI alone, you) or shared."""
    def per_game(key):
        return {who: [p.get(key) for p in points] for who, points in lines.items()}
    player, real = lines["player"], lines["playbook_2021"]
    gap = {who: [None if p.get("cut_mw") is None or p.get("order_mw") is None else p["cut_mw"] - p["order_mw"] for p in points]
           for who, points in lines.items()}
    metrics = [
        {"id": "people_cold", "label": "People in cold homes", "unit": "people", "by": per_game("people_cold")},
        {"id": "people_no_power", "label": "People without power", "unit": "people", "by": per_game("people_no_power")},
        {"id": "cut_mw", "label": "Power cut vs the order", "unit": "MW", "by": per_game("cut_mw"),
         "reference": {"label": "Your cut order", "values": [p.get("order_mw") for p in player]}},
        {"id": "order_gap", "label": "Over (+) or short (−) of the order", "unit": "MW", "by": gap},
        {"id": "cold_person_hours", "label": "Cold person-hours so far", "unit": "person-hours", "by": per_game("cold_person_hours")},
        {"id": "outside_f", "label": "Outside temperature in Dallas", "unit": "°F", "shared": [p.get("outside_f") for p in real]},
    ]
    if forecast is not None and getattr(forecast, "available", False):
        demand = [forecast.uri.get(t[:13]) for t in axis]
        if any(v is not None for v in demand):
            metrics.append({"id": "demand_mw", "label": "Dallas County demand (M1 forecast)", "unit": "MW", "shared": demand})
    return {"t": axis, "games": {"playbook_2021": "2021 playbook", "ai_alone": "AI alone", "player": "You"}, "metrics": metrics}


def build_report(snapshot, base, job, forecast=None):
    you = snapshot["hourly"]
    axis_2021 = base["real_2021"]["hourly"]
    axis = max((axis_2021, base["ai_alone"]["hourly"], you), key=len)
    report = {
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
        "stress_test_progress": job.stress,
    }
    # The screens' names for the same data (web/src/contracts.ts Report).
    you_score, real_score = snapshot["score"], base["real_2021"]["score"]
    report["scores"].update({"player": you_score, "playbook_2021": real_score})
    report["beat_playbook"] = effective_cph(you_score) < effective_cph(real_score)
    report["cold_people_by_hour"] = {"t": report["chart"]["time"], "playbook_2021": report["chart"]["real_2021"],
                                     "ai_alone": report["chart"]["ai_alone"], "player": report["chart"]["you"]}
    report["no_power_by_hour"] = {"t": report["chart"]["time"],
                                  "playbook_2021": [h.get("people_no_power", 0) for h in axis_2021],
                                  "ai_alone": [h.get("people_no_power", 0) for h in base["ai_alone"]["hourly"]],
                                  "player": [h.get("people_no_power", 0) for h in you]}
    ai_score = base["ai_alone"]["score"]
    report["estimated_deaths"] = {
        "player": estimated_deaths(you_score, real_score), "playbook_2021": DSHS_DALLAS_DEATHS,
        "ai_alone": estimated_deaths(ai_score, real_score),
        "method": f"The {DSHS_DALLAS_DEATHS} storm deaths Texas DSHS confirmed in Dallas County in 2021, scaled by the "
                  "hours people spent in cold homes in each game against the 2021 playbook. An estimate, not a forecast.",
        "source": "Texas DSHS, February 2021 Winter Storm-Related Deaths (final report)", "source_url": DSHS_URL}
    report["plan"] = [PLAN_NAMES.get(a["item"], a["item"]).format(a.get("target") or "") for a in report["winter_plan"]]
    for tp in report["turning_points"]:
        steps = snapshot["history"]
        tp["time"] = steps[tp["step"] - 1]["time"] if 0 < tp["step"] <= len(steps) else None
        tp["delta_cold_person_hours"] = -tp["cold_person_hours_change"]  # what the decision did; < 0 saved hours
    report["series"] = explorer_series(report["chart"]["time"],
                                       {"playbook_2021": axis_2021, "ai_alone": base["ai_alone"]["hourly"], "player": you}, forecast)
    stress = _stress_for_screen(job.stress)
    if stress:
        report["stress_test"] = stress
    return report
