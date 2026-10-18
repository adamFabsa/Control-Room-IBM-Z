"""The one live game: storm clock, actions in, state out to every connected client."""
import asyncio
import logging
import os

from . import analyst, m2
from .engine import Game
from .forecast import Forecast
from .records import Records
from .report import ReportJob, hourly
from .screens import Notices, decorate

log = logging.getLogger("controlroom")

# Pacing: the storm (114 game hours) takes about 2 minutes at the starting speed, about 1 at speed 4.
SECONDS_PER_GAME_HOUR = {1: 5, 2: 2.5, 3: 1, 4: 0.5, 5: 0.25}
START_SPEED = 3
# Quick play (the default) keeps the player in charge without a card every game hour: the clock fast-forwards while
# there is no cut order and every neighborhood has power, and routine cards (order rose, a small shortfall, homes
# getting cold) don't stop the game. They take their do-nothing option, so nothing is done for the player, and
# become a notice saying what to do. Cards that stop the game: a cut that would darken a critical building, ice
# or fuel emergencies, and a shortfall deep enough to threaten a collapse. "quick": false shows every card.
QUICK_DEFAULT = os.environ.get("CONTROLROOM_QUICK", "1") == "1"
QUIET_SECONDS_PER_GAME_HOUR = 0.1
SEVERE_SHORTFALL = 0.2  # of the order; the grid collapses at 30% short for 30 minutes
STEPS_PER_GAME_HOUR = 12  # step() advances 5 game minutes
TICK_S = 0.1  # at most 10 state messages a second


class GameSession:
    def __init__(self):
        self.clients = set()
        self.records = Records()
        self.notices = Notices()
        self.forecast = Forecast()
        self._tasks = set()
        self.new_game()

    def new_game(self, storm="uri2021", seed=42, quick=None):
        self.quick = QUICK_DEFAULT if quick is None else bool(quick)
        if getattr(self, "job", None):
            self.job.cancel()
        self.job = ReportJob()
        self.event_text = {}  # event id -> Granite's rewrite of the card
        self.event_pick = {}  # event id -> M2's pick and predictions
        self.temps = []  # hourly outside °F during the storm, for M1
        self.timed_cuts = {}  # circuit id -> engine step when the server restores it (cut with "minutes")
        self.notices.clear()
        self._demand = (None, None)  # (hour, M1 demand) cache
        self.storm, self.seed = storm, seed
        self.game = Game(storm=storm, seed=seed)
        self.paused = True
        self.speed = 2
        self.steps = 0
        self.log = []  # {"step", "action"} for every engine action, used to replay the game
        self.history = []  # per-step totals for the report chart

    def state(self):
        # The server owns pause and speed; the engine only knows whether an event card is open.
        s = self.game.state()
        s["paused"] = self.paused or s.get("event") is not None
        s["speed"] = self.speed
        self.records.add_totals(s)
        if s["phase"] == "prepare" and s.get("storm") == "uri2021" and self.forecast.available:
            measured = self.forecast.outside_f(s["time"])  # the engine shows the storm's first hour during Get ready
            if measured is not None:
                s["outside_f"] = measured
        if s["phase"] == "storm" and self.forecast.available:
            hour = s["time"][:13]
            if self._demand[0] != hour:  # M1 runs once per game hour
                self.temps.append(s["outside_f"])
                self._demand = (hour, round(self.forecast.dallas_mw(s, self.temps)))
            s["demand_mw"], s["demand_source"] = self._demand[1], "M1"
        step = s.get("step", self.steps)
        for c in s["circuits"]:
            due = self.timed_cuts.get(c["id"], self.timed_cuts.get(c.get("parent")))
            if due is not None and not c["on"]:
                c["restore_in_min"] = max(0, (due - step) * 5)
        event = s.get("event")
        if event and self.event_text.get(event["id"]):
            event["ai_text"] = self.event_text[event["id"]]
        if event and m2.get().available:
            if event["id"] not in self.event_pick:
                self.event_pick[event["id"]] = m2.get().pick_option(self.game, s)
            pick = self.event_pick[event["id"]]
            if pick:  # M2 replaces the engine's pick; each option carries M2's predictions
                for option in event["options"]:
                    option["ai_pick"] = option["id"] == pick["option"]
                    option["m2"] = pick["predictions"].get(option["id"])
        decorate(s, self.game, self.log, self.records.medical)
        self.notices.update(s)
        s["notices"] = list(self.notices.items)
        s["quick"] = self.quick
        s["fast_forward"] = self._quiet(s) and not self.paused
        if s["phase"] == "prepare":
            s["phase"] = "ready"  # the screens call Get ready "ready"
        return s

    def _sell(self, action):
        """Take back a Get-ready purchase: rebuild the game from the other purchases (same seed, same result)."""
        if self.game.state()["phase"] != "prepare":
            raise ValueError("items can only be taken back during Get ready")
        same = lambda a: (a["type"] == "buy" and a.get("item") == action.get("item")
                          and str(a.get("target", ""))[:4] == str(action.get("target", ""))[:4])
        match = next((i for i in range(len(self.log) - 1, -1, -1) if same(self.log[i]["action"])), None)
        if match is None:
            raise ValueError(f"no {action.get('item')} to take back there")
        keep = self.log[:match] + self.log[match + 1:]
        self.game = Game(storm=self.storm, seed=self.seed)
        self.log = []
        for entry in keep:
            self._engine_action(entry["action"])

    def snapshot(self):
        """A consistent copy of the finished (or current) game for the report."""
        return {"storm": self.storm, "seed": self.seed, "phase": self.game.state()["phase"],
                "score": self.game.score(), "history": list(self.history), "log": list(self.log),
                "hourly": hourly(self.game, self.history)}

    def finish(self):
        if self.game.state()["phase"] not in ("prepare", "storm"):
            self.job.start(self.snapshot(), quick=self.quick)

    async def handle(self, action):
        if not isinstance(action, dict) or "type" not in action:
            raise ValueError("an action is a JSON object with a type")
        kind = action["type"]
        if kind == "pause":
            self.paused = True
        elif kind == "play":
            self.paused = False
        elif kind == "speed":
            value = int(action["value"])
            if value not in SECONDS_PER_GAME_HOUR:
                raise ValueError("speed is 1 to 5")
            self.speed = value
        elif kind == "new_game":
            quick = action.get("quick")
            self.new_game(action.get("storm", "uri2021"), int(action.get("seed", 42)), None if quick is None else bool(quick))
        elif kind == "sell":
            self._sell(action)
        else:
            step = self._engine_action(action)
            if kind == "start_storm":
                self.paused = False
                self.speed = START_SPEED
            self._defer_routine()
            if kind == "cut" and action.get("minutes"):  # a timed cut: the server restores it later
                self.timed_cuts[action["circuit"]] = step + max(1, round(float(action["minutes"]) / 5))
            elif kind in ("cut", "restore"):
                self.timed_cuts.pop(action["circuit"], None)
        await self.broadcast()

    def _quiet(self, s):
        """Nothing to decide: no cut order and every neighborhood has power, so quick play fast-forwards."""
        return self.quick and s["phase"] == "storm" and s["order_mw"] == 0 and all(c["on"] for c in s["circuits"])

    def _stops(self, event, s):
        """Does this card stop the game for the player? In quick play only the decisions that matter do."""
        if not self.quick:
            return True
        kind = event.get("kind")
        if kind in ("critical_cut", "ice", "fuel"):  # a hospital, water plant or gas station at risk
            return True
        if kind == "short":
            return s["order_mw"] - s["cut_mw"] > SEVERE_SHORTFALL * s["order_mw"]
        return False

    def _defer_routine(self):
        """Quick play: routine cards take their do-nothing option (the last one; nothing is done for the player),
        logged like any choice, and become a notice. True if any were deferred."""
        deferred = False
        for _ in range(20):  # a cut can queue several cards
            s = self.state()
            event = s.get("event")
            if not event or self._stops(event, s):
                break
            try:
                self._engine_action({"type": "choose", "event": event["id"], "option": event["options"][-1]["id"]})
            except Exception:
                break
            self.notices.advise(s, event)
            deferred = True
        return deferred

    def _engine_action(self, action):
        """Apply an action to the engine and log it for replays; returns the engine step it happened at."""
        before = self.game.state()
        event = before.get("event") if action["type"] == "choose" else None
        self.game.apply(action)
        # the engine's own step counter when it has one, so replays line up exactly
        entry = {"step": before.get("step", self.steps), "action": action}
        if event:  # for turning-point labels
            entry["option_label"] = next((o["label"] for o in event["options"] if o["id"] == action.get("option")), None)
        self.log.append(entry)
        if action["type"] in ("cut", "restore"):
            self._spawn(self._recount(action["circuit"]))
        return entry["step"]

    def _restore_due(self, step):
        for circuit_id in [cid for cid, due in self.timed_cuts.items() if due <= step]:
            del self.timed_cuts[circuit_id]
            try:
                self._engine_action({"type": "restore", "circuit": circuit_id})
                s = self.game.state()
                area = next((c["area"] for c in s["circuits"] if c["id"] == circuit_id), circuit_id)
                self.notices.restored(s, circuit_id, area)
            except Exception:
                log.warning("timed restore of %s failed", circuit_id)

    def _spawn(self, coro):
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _recount(self, circuit_id):
        if await self.records.recount(circuit_id):
            await self.broadcast()

    async def _write_event(self, event):
        still_open = lambda: (self.game.state().get("event") or {}).get("id") == event["id"]
        text = await analyst.write(analyst.EVENT_PROMPT, analyst.event_facts(event), max_tokens=60,
                                   still_wanted=still_open)
        if text:
            self.event_text[event["id"]] = text
            await self.broadcast()

    async def run_clock(self):
        loop = asyncio.get_running_loop()
        owed = 0.0  # fractional steps carried between ticks
        last = loop.time()
        while True:
            await asyncio.sleep(TICK_S)
            now = loop.time()
            elapsed, last = now - last, now
            s = self.game.state()
            if s["phase"] != "storm" or self.paused or s.get("event"):
                owed = 0.0
                continue
            seconds = QUIET_SECONDS_PER_GAME_HOUR if self._quiet(s) else SECONDS_PER_GAME_HOUR[self.speed]
            owed += elapsed * STEPS_PER_GAME_HOUR / seconds
            stepped = False
            try:
                while owed >= 1:
                    owed -= 1
                    self.game.step()
                    self.steps += 1
                    stepped = True
                    s = self.game.state()
                    self.history.append({"time": s["time"], "people_cold": s["totals"]["people_cold"]})
                    self._restore_due(s.get("step", self.steps))
                    if s.get("event") and self._defer_routine():
                        s = self.game.state()
                    if s["phase"] != "storm" or s.get("event"):
                        owed = 0.0
                        self.finish()
                        break
            except Exception:
                log.exception("engine step failed; pausing")
                self.paused = True
                stepped = True
            if stepped:
                await self.broadcast()

    async def broadcast(self):
        s = self.state()
        for circuit_id in self.records.missing(s["circuits"]):  # circuits the engine cut on its own
            self._spawn(self._recount(circuit_id))
        if s.get("event") and s["event"]["id"] not in self.event_text:
            self.event_text[s["event"]["id"]] = None  # in progress
            self._spawn(self._write_event(s["event"]))
        if not self.clients:
            return
        for ws in list(self.clients):
            try:
                await ws.send_json(s)
            except Exception:
                self.clients.discard(ws)
