"""The one live game: storm clock, actions in, state out to every connected client."""
import asyncio
import logging

from . import analyst, m2
from .engine import Game
from .records import Records
from .report import ReportJob

log = logging.getLogger("controlroom")

SECONDS_PER_GAME_HOUR = {1: 20, 2: 10, 3: 5, 4: 2, 5: 0.5}
STEPS_PER_GAME_HOUR = 12  # step() advances 5 game minutes
TICK_S = 0.1  # at most 10 state messages a second


class GameSession:
    def __init__(self):
        self.clients = set()
        self.records = Records()
        self._tasks = set()
        self.new_game()

    def new_game(self, storm="uri2021", seed=42):
        if getattr(self, "job", None):
            self.job.cancel()
        self.job = ReportJob()
        self.event_text = {}  # event id -> Granite's rewrite of the card
        self.event_pick = {}  # event id -> M2's pick and predictions
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
        return s

    def snapshot(self):
        """A consistent copy of the finished (or current) game for the report."""
        return {"storm": self.storm, "seed": self.seed, "phase": self.game.state()["phase"],
                "score": self.game.score(), "history": list(self.history), "log": list(self.log)}

    def finish(self):
        if self.game.state()["phase"] not in ("prepare", "storm"):
            self.job.start(self.snapshot())

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
            self.new_game(action.get("storm", "uri2021"), int(action.get("seed", 42)))
        else:
            event = self.game.state().get("event") if kind == "choose" else None
            self.game.apply(action)
            entry = {"step": self.steps, "action": action}
            if event:  # for turning-point labels
                entry["option_label"] = next((o["label"] for o in event["options"] if o["id"] == action.get("option")), None)
            self.log.append(entry)
            if kind == "start_storm":
                self.paused = False
            if kind in ("cut", "restore"):
                self._spawn(self._recount(action["circuit"]))
        await self.broadcast()

    def _spawn(self, coro):
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _recount(self, circuit_id):
        if await self.records.recount(circuit_id):
            await self.broadcast()

    async def _write_event(self, event):
        text = await analyst.write(analyst.EVENT_PROMPT, analyst.event_facts(event), max_tokens=60)
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
            owed += elapsed * STEPS_PER_GAME_HOUR / SECONDS_PER_GAME_HOUR[self.speed]
            stepped = False
            try:
                while owed >= 1:
                    owed -= 1
                    self.game.step()
                    self.steps += 1
                    stepped = True
                    s = self.game.state()
                    self.history.append({"time": s["time"], "people_cold": s["totals"]["people_cold"]})
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
