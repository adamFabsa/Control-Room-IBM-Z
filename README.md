# Lights Out

A winter-storm simulation game set in Dallas County. You get the county ready, decide which neighborhoods lose power when Winter Storm Uri hits, and AI running on IBM LinuxONE compares your choices with what really happened in February 2021.

IBM Z Datathon 2026 · Track: Real-time AI for critical decisions · Play it: http://148.100.98.237:8000/

**Demo video:** https://youtu.be/iWgThJWVLyY

## How it plays

1. **Get ready** (time stopped, Fri 12 Feb 2021, 32°F). Spend 10 points on protections, generators, a warming center, gas, conservation, repair crews or smart switches. "Your preparations" lists everything placed and where.
2. **The storm** (Sun 18:00 to Fri 12:00, real Dallas temperatures, the cut order rebuilt from real EAGLE-I outage data). You meet the grid operator's cut order by cutting and restoring neighborhoods yourself, while homes cool by the hour. The AI advises and never plays for you: an AI pick on every decision card (M2), a co-pilot tip on the map, and Granite's alert text. The game stops for the decisions that matter (a cut that would darken a hospital, water plant or gas station, ice and fuel emergencies, the order rising, falling behind it, homes getting cold); repeats in quick succession arrive as notices with a sound. If the cut falls more than 20% short of the order, the clock stops until you cut enough, so the grid never collapses before you can react. About 1.5 minutes and around 10 decisions at the starting speed (a game day takes 12 seconds); speeds 4 and 5 make it shorter.
3. **How you did.** Estimated deaths in Dallas County next to the 22 the state confirmed in 2021; hours in cold homes for you, the 2021 playbook and the AI playing alone; your 3 turning points; the AI analyst's debrief; a data explorer (7 measures, together or separate, hover readout, CSV); and your winter plan tested on 1,000 generated storms.

## Architecture and solution flow

All three diagrams on one page: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

**System architecture on IBM LinuxONE**

![System architecture on IBM LinuxONE](docs/diagrams/architecture.png)

**Solution flow: one game, start to finish**

![Solution flow](docs/diagrams/solution-flow.png)

**From public data to real-time AI**

![From public data to real-time AI](docs/diagrams/data-ai-pipeline.png)

## How this meets the judging criteria

| Criterion | What we built | Evidence |
|---|---|---|
| Value to the community + theme | Real-time power-cut decisions in a real disaster that killed 246 Texans (22 in Dallas County): operators and planners practise the next storm and leave with a plan tested on 1,000 storms. Real data throughout: EIA-930, EAGLE-I outages, Open-Meteo temperatures, Census, CDC vulnerability, DSHS deaths | This page; the report screen |
| Novelty and originality | A playable model of a real county where power, gas, water and heat are linked; turning points found by replaying your own game without each decision; estimated deaths from your decisions; all built during the event | Git history (from Oct 17, 2026) |
| Technical design on LinuxONE + AI/ML | Everything runs in Podman containers on an IBM z17. Three AI models on LinuxONE: M1 forecast (with IBM Granite TTM-R2), M2 on the **Telum** on-chip AI accelerator through IBM Snap ML and zDNN, M3 IBM Granite 3.3 on llama.cpp (big-endian). **Security:** LUKS2 storage on the CPACF crypto unit, per-record pgcrypto encryption, synthetic data, secrets outside git, fuzz-tested API. **Scale:** turning points and the 1,000-storm test spread across all cores | [docs/EVIDENCE.md](docs/EVIDENCE.md), `GET /api/ai` |
| Execution and pitch | A finished, tested game: 280-game invariant test, API fuzzing, browser playtests at three screen sizes | [docs/EVIDENCE.md](docs/EVIDENCE.md) §7 |
| AI Innovation Excellence | M2 learns what a move does from 60,286 what-if rollouts and advises every critical decision in real time on Telum; Granite's text is number-checked and direction-checked so it can't mislead; the turning-point analyst explains a player's own storm | §5 of the evidence |

**Rules:** code written during the event (repo history starts Oct 17, 2026) · every open-source library, model and dataset listed below with links · every customer record synthetic · no political content. For the team to confirm on Hack2Skill: the video (at most 3 minutes: problem, supporting data, solution, how it uses IBM Z), the project title with the team name, the GitHub link, and the two IBM AI/ML labs if the organizers require them.

## Running on IBM LinuxONE

Everything that thinks runs on an IBM LinuxONE Community Cloud VM in Podman containers; the laptop only draws the screens and sends clicks.

| | |
|---|---|
| Hardware | IBM z17 (machine type 9175), s390x, 3 cores; on-chip AI accelerator (Telum II, `nnpa`) and CPACF crypto (`msa`) |
| Containers | `server` (FastAPI game server, game engine, M1, M2), `db` (PostgreSQL 16), `llm` (llama.cpp with IBM Granite), `ai` (training jobs) |
| Live evidence | `GET /api/ai` on the game server returns the hardware and every AI part's measured numbers; captured outputs in [docs/EVIDENCE.md](docs/EVIDENCE.md) |
| Diagrams | System architecture, solution flow and data-to-AI pipeline: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Screenshots | The VM, its containers, the AI models, security and the live game: [docs/EVIDENCE.md#screenshots](docs/EVIDENCE.md#screenshots) |
| Datasets | Every data file, its source, rows and use: [docs/DATASET.md](docs/DATASET.md) |

### The AI parts

| Part | What it does | Runs on | Measured on LinuxONE |
|---|---|---|---|
| M1 demand forecast | Hourly demand from temperature; shows Dallas County demand in the game and rebuilds Uri's lost load | XGBoost + linear heating baseline; IBM Granite TTM-R2 compared | Held-out winters: 3.84% error weather-only, 3.08% with recent demand, 5.70% Granite TTM-R2 zero-shot, 2.50% EIA's published forecast |
| M2 what-if predictor | Predicts what a move does to cold person-hours and critical buildings; makes the AI pick (advice) on decision cards and plays "AI alone" for the report | IBM Snap ML boosting, inference on Telum (`zdnn_tensors`) | 60,286 what-if samples from 1,500 engine games; right direction (helps vs hurts) 80.1% of the time; critical-building AUC 0.978. Playing Uri alone: 18.2 million cold person-hours vs 36.5 million for the 2021 playbook |
| M3 analyst | Rewrites decision cards and adds a coaching tip to the debrief; any number not in its input, or advice pointing the wrong way, is rejected | IBM Granite 3.3 2B Instruct (Q8_0, big-endian GGUF) on llama.cpp | About 5 tokens/s; a card in about 15 s, a tip in about 8 s |
| Turning points | Replays your game once without each decision to find the 3 that mattered most | Engine replays across all cores | 64-135 replays in 1.6-8 s |
| Stress test | Your winter plan on 1,000 generated storms against the 2021 playbook | Engine across all cores; the 2021 results computed at startup | 1,000 storms in about 45 s (about 105 s with M2 as the operator, `"quick": false`) |
| Estimated deaths | The 22 storm deaths Texas DSHS confirmed in Dallas County, scaled by each game's hours in cold homes against the 2021 playbook (an estimate, with its source on screen) | Server | Instant |
| Customer records | 1,000,000 synthetic accounts; every cut counts affected and medical-device customers | PostgreSQL + pgcrypto (AES-256) on a LUKS2 AES-XTS volume, CPACF | Volume ~5.3 GB/s; live counting ~290,000 encrypted records/s |

### M2 on the Telum accelerator vs the CPU

`ai/telum_benchmark.py` loads the same trained M2 models twice with Snap ML, as `compress_trees` (CPU) and `zdnn_tensors` (Telum), and feeds both 15,375 real feature rows from engine games. Results: `ai/telum_results.json`.

| One M2 call (both models) | CPU `compress_trees` | Telum `zdnn_tensors` |
|---|---|---|
| 1 prediction, median | 0.034 ms | 0.059 ms |
| 1,000 rows | 2.0 ms | 8.6 ms |
| 10,000 rows | 19.9 ms | 108.9 ms |

Both give identical predictions and pick the same best move in 100% of 1,000 decisions. For a model this size on this shared VM, Snap ML's compressed CPU trees are faster; the server runs M2 on Telum by default (`M2 backend: zdnn_tensors (Telum)` at startup) with an automatic CPU fallback, and `M2_BACKEND=cpu` switches to the CPU path.

### Reproduce on the VM

```bash
./scripts/setup_secure_volume.sh          # LUKS2 volume for PostgreSQL (once)
./ai/llm/prepare_model.sh                 # Granite 3.3 2B as a big-endian GGUF (once)
python3 ai/data/fetch_data.py             # EIA-930, Open-Meteo, EAGLE-I (once)
./scripts/deploy.sh                       # from a laptop: sync and start server + db
podman-compose up -d llm                  # Granite analyst
```

Training jobs run in the `ai` container (`ai/forecast/train_forecast.py`, `ai/m2/train_m2.py`, `ai/telum_benchmark.py`, `ai/records/generate_customers.py`); the commands are at the top of each file. The server's API is in `server/README.md`, the engine's in `engine/README.md`.

## Open-source libraries, models, containers and data

**Platform and containers**
- Ubuntu 24.04 container image: https://hub.docker.com/_/ubuntu
- PostgreSQL 16 container image: https://hub.docker.com/_/postgres
- Podman: https://podman.io
- podman-compose: https://github.com/containers/podman-compose
- CNI dnsname plugin: https://github.com/containers/dnsname
- cryptsetup (LUKS2): https://gitlab.com/cryptsetup/cryptsetup

**Game screens (web/)**
- React and React DOM: https://github.com/facebook/react
- three.js (the 3D county): https://github.com/mrdoob/three.js
- Vite: https://github.com/vitejs/vite · @vitejs/plugin-react: https://github.com/vitejs/vite-plugin-react
- TypeScript: https://github.com/microsoft/TypeScript
- zustand: https://github.com/pmndrs/zustand
- Lucide icons (lucide-react): https://github.com/lucide-icons/lucide
- IBM Plex Sans and Mono (@fontsource): https://github.com/IBM/plex · https://github.com/fontsource/font-files
- Vitest: https://github.com/vitest-dev/vitest · shapefile (data prep): https://github.com/mbostock/shapefile
- Kenney 3D asset kits (CC0: City Kit Suburban, cars, industrial): https://kenney.nl/assets

**Hardware (hardware/)**
- MicroPython (Raspberry Pi Pico 2): https://github.com/micropython/micropython
- pySerial: https://github.com/pyserial/pyserial
- websockets (bridge client): https://github.com/python-websockets/websockets

**Game server**
- FastAPI: https://github.com/fastapi/fastapi
- Uvicorn: https://github.com/encode/uvicorn
- websockets: https://github.com/python-websockets/websockets
- psycopg 3: https://github.com/psycopg/psycopg
- pgcrypto: https://www.postgresql.org/docs/16/pgcrypto.html

**AI and data science**
- NumPy: https://github.com/numpy/numpy
- pandas: https://github.com/pandas-dev/pandas
- scikit-learn: https://github.com/scikit-learn/scikit-learn
- SciPy: https://github.com/scipy/scipy
- XGBoost: https://github.com/dmlc/xgboost
- IBM Snap ML: https://www.zurich.ibm.com/snapml/ (https://pypi.org/project/snapml/)
- IBM zDNN: https://github.com/IBM/zDNN
- PyTorch: https://github.com/pytorch/pytorch
- Hugging Face Transformers: https://github.com/huggingface/transformers
- Hugging Face Hub client: https://github.com/huggingface/huggingface_hub
- IBM granite-tsfm: https://github.com/ibm-granite/granite-tsfm
- einops: https://github.com/arogozhnikov/einops
- llama.cpp (release b11267): https://github.com/ggml-org/llama.cpp

**Models**
- IBM Granite TimeSeries TTM-R2: https://huggingface.co/ibm-granite/granite-timeseries-ttm-r2
- IBM Granite 3.3 2B Instruct (GGUF): https://huggingface.co/ibm-granite/granite-3.3-2b-instruct-GGUF

**Tools and services**
- Mermaid (architecture and flow diagrams): https://github.com/mermaid-js/mermaid
- Playwright (browser playtests): https://github.com/microsoft/playwright
- ElevenLabs text-to-speech API (the optional voice guide; a commercial service, not open source): https://elevenlabs.io/docs

**Data**
- EIA-930 Hourly Electric Grid Monitor (ERCOT demand): https://www.eia.gov/electricity/gridmonitor/
- Open-Meteo Historical Weather API (Dallas, Houston, San Antonio, Austin): https://open-meteo.com/en/docs/historical-weather-api
- EAGLE-I recorded electricity outages (ORNL): https://doi.org/10.6084/m9.figshare.24237376
- Texas DSHS, February 2021 Winter Storm-Related Deaths (final report): https://www.dshs.texas.gov/sites/default/files/news/updates/SMOC_FebWinterStorm_MortalitySurvReport_12-30-21.pdf
- US Census TIGER/Line 2024 (tracts, roads, water, landmarks): https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html
- CDC/ATSDR Social Vulnerability Index 2022: https://www.atsdr.cdc.gov/place-health/php/svi/
- OpenStreetMap building outlines (© OpenStreetMap contributors, ODbL), via the Overpass API: https://www.openstreetmap.org/copyright
- Microsoft Global ML Building Footprints: https://github.com/microsoft/GlobalMLBuildingFootprints

Every customer record is synthetic.
