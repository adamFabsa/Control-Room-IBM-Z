"""The one live game: storm clock, actions in, state out to every connected client."""
import asyncio
import logging

from .engine import Game

log = logging.getLogger("controlroom")

SECONDS_PER_GAME_HOUR = {1: 20, 2: 10, 3: 5, 4: 2, 5: 0.5}
STEPS_PER_GAME_HOUR = 12  # step() advances 5 game minutes
TICK_S = 0.1  # at most 10 state messages a second


class GameSession:
    def __init__(self):
        self.clients = set()
        self.new_game()

    def new_game(self, storm="uri2021", seed=42):
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
        return s

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
            self.game.apply(action)
            self.log.append({"step": self.steps, "action": action})
            if kind == "start_storm":
                self.paused = False
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
                        break
            except Exception:
                log.exception("engine step failed; pausing")
                self.paused = True
                stepped = True
            if stepped:
                await self.broadcast()

    async def broadcast(self):
        if not self.clients:
            return
        s = self.state()
        for ws in list(self.clients):
            try:
                await ws.send_json(s)
            except Exception:
                self.clients.discard(ws)
