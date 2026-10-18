# stormgame: the Lights Out game engine (Part 1A)

Plain Python 3.11 + NumPy + pandas. No screen, no server, no network calls. The same seed always gives the same game.

```bash
pip install -r requirements.txt
python run_cli.py                  # playbook_2021 vs greedy on Uri, with timing
python run_cli.py --interactive    # play from the terminal
python -m unittest discover tests      # FUZZ_SEEDS=20 for a longer random-play run
```

## API (Shared contract 1)

```python
from stormgame import Game, play, replay

g = Game(storm="uri2021", seed=42)      # or "generated", "test", or a Storm object
g.apply({"type": "buy", "item": "generator", "target": "water-1"})   # -> {"ok": True}; bad/illegal action raises ActionError (a ValueError)
g.try_apply(action)                     # same, but returns {"ok": False, "error": ...} instead of raising
g.start_storm()                         # phase: "prepare" -> "storm" -> "over" (same names as the server's stand-in)
g.step()            # 5 game minutes; does nothing while paused or while an event card is open
g.state()           # state JSON (Shared contract 2)
g.score()           # cold_person_hours, longest_outage_min, critical_dark_min, water_plants_lost, orders_met_pct, ...
g.clone()           # deep copy (storm data shared)
```

Additions beyond the contract. Each is a new key or function, and nothing in the contract changed:

| What | Why |
|---|---|
| `g.history`: every decision, with its step and phase | turning points: `replay(g, skip=i)` replays the game without decision `i` |
| `g.plan()`: the Get ready purchases | stress test: `play("greedy", storm="generated", seed=s, plan=g.plan())` |
| `g.timeline`: hourly totals | the cold-homes chart on the report screen |
| `Game(..., ai_picker=fn)`: `fn(game, event) -> option id` | lets M2 (Snap ML) set the AI pick on event cards; default is a simple rule |
| `play(player, storm, seed, plan=None)` | headless built-in players: `"playbook_2021"`, `"greedy"` |
| state: `kind` on events; `parent`, `ice` on circuits; `storm`, `storm_note`, `step`, `steps_total`, `end_reason`, `demand_mw`, `boil_water_people`, `gas_short`, `warming_centers` | screens can ignore them |
| score: `boil_water_person_hours`, `grid_collapsed` | the report lists boil-water people-hours. **A collapsed game ends early, so its cold-hours look low: treat `grid_collapsed` as a loss in comparisons.** |

## Decisions where the spec was open (game assumptions, all in `stormgame/config.py`)

- **Smart switches** replace `C-03` with `C-03A` (keeps the building) and `C-03B`. Cut/restore/protect `C-03` acts on both halves.
- **Building types:** `hospital`, `dialysis`, `water_plant`, `gas_compressor`, `school`. Critical = the first four.
- **Warming centers** can be placed on any circuit or building; they serve dark, cold circuits in the same area first, then neighboring areas (`ADJACENT` map).
- **Conservation during the storm** costs 1 point (leftover points) and gives −0.5% for 24 hours. It can also be bought with `buy` or `emergency`.
- **Leftover points** during the storm buy `generator`, `warming_center` or `conservation` (via `emergency` or `buy`).
- **Homes warm back** toward 68°F with a 2-hour time constant.
- **Ice line breaks** are seeded at game start (about one every 12 hours) and can hit any circuit, including protected ones.
- **Generators** burn fuel only while their circuit is dark; 48 hours of fuel. A new generator refuels.
- **Cutting a circuit with an unprotected critical building opens a card first** ("The water plant is about to lose power"). Options: send a generator (2 pts) / cut a different neighborhood / let it go dark.
- **Several critical cuts at once** (for example a player sending a whole step's cuts): while a card is open, a cut that would darken another critical building is queued (`{"ok": true, "queued": true}`) and its card opens as soon as the current one is answered.
- **Event cards** (each has a do-nothing default, the last option):

| kind | fires when | options |
|---|---|---|
| `critical_cut` | the player cuts a circuit with an exposed critical building | `gen`, `other`, `dark` (`cancel` = keep it on, when gen/other are unavailable) |
| `ice` | an ice break will darken an exposed critical building within 15 min | `gen`, `dark` |
| `fuel` | a generator runs dry within 15 min | `gen`, `restore`, `dark` |
| `order_rise` | order up more than 200 MW in an hour | `auto`, `conserve`, `manual` |
| `short` | more than 5% short for 15 min | `auto`, `conserve`, `wait` |
| `cold` | a dark circuit's homes cross 50°F within 60 min | `restore`, `warm`, `keep` |

  Options that cost points appear only when the player can afford them, and a card with only one possible answer is not shown, so every card has 2–3 options. `auto` cuts the warmest circuits that darken no critical building. Cooldowns: order_rise and short 60 min, cold 30 min.
- **Bad input** (unknown types, wrong field types, non-objects, moves not allowed now) raises `ActionError` with a readable message and leaves the game unchanged; nothing else ever raises from `apply`.
- **playbook_2021** protects the hospital, cuts in fixed order C-01→C-15, and rotates a circuit back on after 240 minutes dark.
- **greedy** spends no points; every step it keeps the warmest circuits cut and the coldest on.

## Data

Optional files in `data/` (or `$STORMGAME_DATA`): `openmeteo_dallas.csv` (Open-Meteo hourly export), or else `openmeteo_texas_hourly.csv` (from `ai/data/fetch_data.py`, column `dallas_f`, UTC), and `eaglei_dallas_feb2021.csv` (EAGLE-I outages). With the repo's Texas file, Uri uses real Dallas temperatures (low −1.9°F) and generated storms are drawn from the 14 real 2005–2026 Dallas cold spells, stretched 0.8–1.25× and shifted a few degrees. Loading takes about 2 s once per process; each game after that is about 0.1–0.2 s. When they are missing, the engine uses hand-made curves and says so in `state()["storm_note"]`. Generated storms come from real cold spells when the multi-year temperature file is present; otherwise they are synthetic.
