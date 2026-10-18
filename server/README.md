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
| `GET /api/records` | Encrypted customer-record counting stats (records counted, records/s) |
| `GET /api/ai` | Evidence for the video: CPU (IBM z17, NNPA, CPACF), M1 errors, Granite speed, records/s, last report's replay and stress-test times |

A bad action sent over the WebSocket gets `{"error": "..."}` back to that client only; it has no `time` field, so skip it when reading state.

## Additions to the shared contract

- **The server owns `paused` and `speed`.** `pause`, `play` and `speed` actions are handled by the server and never reach the engine. `paused` in the state is true when the player paused or an event card is open. `start_storm` starts the clock.
- **`{"type": "new_game", "storm": "uri2021", "seed": 42, "quick": true}`** resets the game (server only; the report's Play again sends it).
- **Pacing:** speeds 1 = 5 s, 2 = 2.5 s, 3 = 1 s, 4 = 0.5 s, 5 = 0.25 s per game hour; the storm starts at 3 (about 2 minutes).
- **Quick play (the default; `"quick": false` turns it off):** the player plays; the AI only advises. The clock fast-forwards (0.1 s per game hour, `fast_forward: true`) while there is no cut order and every neighborhood has power. Routine cards (order rose, a small shortfall, homes getting cold) don't stop the game: they take their do-nothing option (the last one, so nothing is done for the player), logged like any choice, and arrive as a notice saying what to do. Cards that stop the game: a cut that would darken a critical building, ice or fuel emergencies, and a shortfall over 20% of the order. The stress test uses the greedy operator (about 45 s for 1,000 storms; M2 takes about 105 s), with the 2021 playbook's results computed at startup.
- Phases: the server sends `ready` during Get ready (the engine calls it `prepare`), then `storm`, then `over`.
- **Timed cuts:** `{"type": "cut", "circuit": "C-13", "minutes": 60}` cuts now and the server restores it when the time runs out; while it runs the circuit has `restore_in_min`.
- **`demand_mw`** during the storm is M1's Dallas County forecast for that hour (`demand_source: "M1"`), replacing the engine's placeholder formula.
- **`totals.accounts_no_power` and `totals.medical_no_power`**: customer accounts (and those with a medical device) on cut circuits, counted from the 1 million encrypted customer records. They update a moment after each cut or restore; absent if the database is down.
- **Players** for the report are `decide(state) -> [actions]`, called once per step (`app/players.py`). They only read the state JSON, so they work with any engine that follows the contract.

## Report JSON

```json
{
  "storm": "uri2021", "seed": 42, "phase": "over",
  "scores": {"you": {...score()...}, "real_2021": {...}, "ai_alone": {...}},
  "chart": {"time": ["2021-02-14T18:55:00-06:00", "..."], "you": [0, 38900], "real_2021": [...], "ai_alone": [...]},
  "ai_alone_player": "m2",
  "winter_plan": [{"type": "buy", "item": "generator", "target": "water-1"}],
  "turning_points": [],
  "summary": null,
  "stress_test": {"status": "not_started"}
}
```

`chart` is hourly people in cold homes. Just after the storm, the first request waits a few seconds for `turning_points` (the 3 decisions whose removal changes cold person-hours most; `cold_person_hours_change` > 0 means the decision saved that many) and `summary` (computed facts, then Granite's coaching tip once it passes the number check; `summary_source` is `pending`, `template` or `granite`). The stress test runs for about 2 minutes: `stress_test_progress` shows `done`/`storms`, and `stress_test` appears when it finishes. Re-fetch until `stress_test` is present. The report also has `estimated_deaths` (DSHS's 22 Dallas County deaths scaled by hours in cold homes; `null` after a grid collapse), `no_power_by_hour`, and `series` for the data explorer (7 hourly measures per game or shared).

The report also carries the screens' names for the same data (`web/src/contracts.ts`): `scores.player`, `scores.playbook_2021`, `cold_people_by_hour`, `beat_playbook`, `plan` (plain sentences), `turning_points[].time` and `delta_cold_person_hours` (< 0 means the decision saved hours), and `stress_test` as `{storms, works, worst}` with `worst` as a sentence.

On an open event card, M2 (the Snap ML what-if model) sets `ai_pick` and adds `m2: {cold_person_hours_change, critical_dark_chance}` to each option. While an event card is open, `event.ai_text` appears once Granite has rewritten the card (about 15 s); show the engine's `text` until then.

## Engine

`app/engine.py` imports `stormgame` from `engine/` when it exists and falls back to `app/stub_engine.py`, a stand-in with the contract's interface and a hand-made Uri storm. Set `ENGINE=stub` to force the stand-in.

## Deploy

```bash
./scripts/deploy.sh   # rsync to the VM, then podman-compose up -d --build
```

Needs the VM's SSH key (`SSH_KEY`, default `~/Downloads/datathon.pem`).
