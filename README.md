# CONTROL ROOM: URI

A winter-storm simulation game set in Dallas County. You get the county ready, decide which neighborhoods lose power when Winter Storm Uri hits, and AI running on IBM LinuxONE compares your choices with what really happened in February 2021.

A game takes about two minutes: the 114-hour storm plays in about a minute, an AI co-pilot handles routine calls, and the game stops only for the decisions that put a hospital, water plant or gas station at risk. The report is ready two seconds after the storm.

IBM Z Datathon 2026 · Track: Real-time AI for critical decisions

## Running on IBM LinuxONE

Everything that thinks runs on an IBM LinuxONE Community Cloud VM in Podman containers; the laptop only draws the screens and sends clicks.

| | |
|---|---|
| Hardware | IBM z17 (machine type 9175), s390x, 3 cores; on-chip AI accelerator (Telum II, `nnpa`) and CPACF crypto (`msa`) |
| Containers | `server` (FastAPI game server, game engine, M2), `db` (PostgreSQL 16), `llm` (llama.cpp with IBM Granite), `ai` (training jobs) |
| Live evidence | `GET /api/ai` on the game server returns the hardware and every AI part's measured numbers |

### The AI parts

| Part | What it does | Runs on | Measured on LinuxONE |
|---|---|---|---|
| M1 demand forecast | Hourly demand from temperature; shows Dallas County demand in the game and rebuilds Uri's lost load | XGBoost + linear heating baseline; IBM Granite TTM-R2 compared | Held-out winters: 3.84% error weather-only, 3.08% with recent demand, 5.70% Granite TTM-R2 zero-shot, 2.50% EIA's published forecast |
| M2 what-if predictor | Predicts what a move does to cold person-hours and critical buildings; makes the AI pick on event cards and plays "AI alone" | IBM Snap ML boosting, inference on Telum (`zdnn_tensors`) | 60,286 what-if samples from 1,500 engine games; right direction (helps vs hurts) 80.1% of the time; critical-building AUC 0.978. Playing Uri alone: 18.2 million cold person-hours vs 36.5 million for the 2021 playbook |
| M3 analyst | Rewrites event cards and adds a coaching tip to the debrief; any number not in its input is rejected | IBM Granite 3.3 2B Instruct (Q8_0, big-endian GGUF) on llama.cpp | About 5 tokens/s; a card in about 15 s, a tip in about 8 s |
| Turning points | Replays your game once without each decision to find the 3 that mattered most | Engine replays across all cores | 135 replays in 8.0 s |
| Stress test | Your winter plan on 1,000 generated storms against the 2021 playbook | Engine + M2 across all cores | 1,000 storms in 101.5 s |
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

**Data**
- EIA-930 Hourly Electric Grid Monitor (ERCOT demand): https://www.eia.gov/electricity/gridmonitor/
- Open-Meteo Historical Weather API (Dallas, Houston, San Antonio, Austin): https://open-meteo.com/en/docs/historical-weather-api
- EAGLE-I recorded electricity outages (ORNL): https://doi.org/10.6084/m9.figshare.24237376

Every customer record is synthetic.
