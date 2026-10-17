# server/ — game server on LinuxONE (Part 2)

FastAPI + WebSocket server that runs the storm clock and wraps the `stormgame` engine.
Runs in Podman containers on the IBM LinuxONE VM (s390x) next to PostgreSQL.

Live at **http://148.100.98.237:8000**

## Endpoints

| | |
|---|---|
| `ws://148.100.98.237:8000/ws` | Sends the state JSON on connect and after every change; send action JSON in |
| `GET /api/state` | Current state JSON |
| `POST /api/action` | Body is one action JSON; returns the new state, or 400 with the reason |
| `GET /api/report` | How-you-did data (shape below) |
| `GET /api/health` | Engine in use (`stub` or `stormgame`), CPU arch, cores |

A bad action sent over the WebSocket gets `{"error": "..."}` back to that client only; it has no `time` field, so skip it when reading state.

## Additions to the shared contract

- **The server owns `paused` and `speed`.** `pause`, `play` and `speed` actions are handled by the server and never reach the engine. `paused` in the state is true when the player paused or an event card is open. `start_storm` starts the clock.
- **`{"type": "new_game", "storm": "uri2021", "seed": 42}`** resets the game (server only).
- Speeds: 1 = 20 s, 2 = 10 s, 3 = 5 s, 4 = 2 s, 5 = 0.5 s per game hour.
- Phases the server expects from the engine: `prepare`, `storm`, then anything else (e.g. `over`) when the storm ends.
- **Players** for the report are `decide(state) -> [actions]`, called once per step (`app/players.py`). They only read the state JSON, so they work with any engine that follows the contract.

## Report JSON

```json
{
  "storm": "uri2021", "seed": 42, "phase": "over",
  "scores": {"you": {...score()...}, "real_2021": {...}, "ai_alone": {...}},
  "chart": {"time": ["2021-02-14T18:55:00-06:00", "..."], "you": [0, 38900], "real_2021": [...], "ai_alone": [...]},
  "ai_alone_player": "greedy",
  "winter_plan": [{"type": "buy", "item": "generator", "target": "water-1"}],
  "turning_points": [],
  "summary": null,
  "stress_test": {"status": "not_started"}
}
```

`chart` is hourly people in cold homes. `turning_points`, `summary` and `stress_test` fill in as the AI parts land.

## Engine

`app/engine.py` imports `stormgame` from `engine/` when it exists and falls back to `app/stub_engine.py`, a stand-in with the contract's interface and a hand-made Uri storm. Set `ENGINE=stub` to force the stand-in.

## Deploy

```bash
./scripts/deploy.sh   # rsync to the VM, then podman-compose up -d --build
```

Needs the VM's SSH key (`SSH_KEY`, default `~/Downloads/datathon.pem`).
