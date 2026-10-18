# Evidence: CONTROL ROOM: URI on IBM LinuxONE

For the video, `bash ~/control-room/scripts/linuxone_tour.sh` on the VM prints the machine, containers, the three AI models, the encryption and the live game on one screen (read-only, no secrets). The sections below are the same facts command by command.

Captured from the team's IBM LinuxONE Community Cloud VM on Sun Oct 18 09:03:20 AM UTC 2026. Every block shows the command that produced it, so it can be re-run and screenshotted. The live game: http://148.100.98.237:8000/ · the same numbers, live: `curl http://148.100.98.237:8000/api/ai`.

## 1. The machine: IBM z17, on-chip AI accelerator (Telum II, `nnpa`), CPACF crypto (`msa`)

```
$ uname -m; nproc; grep -m1 "machine = " /proc/cpuinfo; grep -o -w -E "nnpa|msa" /proc/cpuinfo | sort -u
s390x
3
processor 0: version = FF,  identification = 0ADFD8,  machine = 9175
msa
nnpa
```

Machine type 9175 is an IBM z17.

## 2. Everything runs in Podman containers

```
$ podman ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
NAMES                  IMAGE                                 STATUS             PORTS
control-room_llm_1     localhost/controlroom-llm:latest      Up 16 hours        127.0.0.1:8080->8080/tcp
control-room_db_1      docker.io/library/postgres:16         Up About a minute  
control-room_server_1  localhost/control-room_server:latest  Up About a minute  0.0.0.0:8000->8000/tcp
```

`server`: FastAPI game server with the game engine, M1 and M2 · `db`: PostgreSQL 16 on the encrypted volume · `llm`: llama.cpp serving IBM Granite (localhost only) · the `ai` image runs the training jobs.

## 3. M2 runs on the Telum accelerator

```
$ podman logs control-room_server_1 2>&1 | grep -E "M2 backend|baselines ready"
INFO:controlroom:M2 backend: zdnn_tensors (Telum)
INFO:controlroom.report:stress-test baselines ready (1000 storms)
```

`ai/telum_benchmark.py` loads the trained M2 models twice with IBM Snap ML 1.17.2: tree format `compress_trees` (CPU) and `zdnn_tensors` (Telum, through IBM zDNN), and feeds both 15,375 real feature rows from engine games (154 features). Results in `ai/telum_results.json`:

| One M2 call (both models) | CPU `compress_trees` | Telum `zdnn_tensors` |
|---|---|---|
| 1 prediction, median | 0.034 ms | 0.059 ms |
| 1 prediction, p95 | 0.035 ms | 0.062 ms |
| 1,000 rows | 2.0 ms (499,258 rows/s) | 8.64 ms (115,744 rows/s) |
| 10,000 rows | 19.94 ms (501,621 rows/s) | 108.89 ms (91,838 rows/s) |

Same predictions on both: max difference 0.0 cold person-hours, same best move in 100.0% of 1,000 decisions. For a model this size on this shared VM the compressed CPU trees are faster; the server uses Telum by default with an automatic CPU fallback (`M2_BACKEND=cpu` switches).

## 4. Security: encrypted storage on CPACF, encrypted columns, synthetic data

```
$ sudo cryptsetup status controlroom-secure | grep -E "type|cipher|keysize"
  type:    LUKS2
  cipher:  aes-xts-plain64
  keysize: 512 bits
$ awk ... /proc/crypto   # XTS-AES drivers; the highest priority is used
xts(ecb(aes-generic)) priority=100
xts-aes-s390 priority=402
$ sudo cryptsetup benchmark --cipher aes-xts-plain64 --key-size 512
# Algorithm |       Key |      Encryption |      Decryption
    aes-xts        512b      5320.3 MiB/s      5323.4 MiB/s
```

The kernel uses `xts-aes-s390` (the CPACF crypto unit), at about 5.3 GB/s. On top of the encrypted volume, each of the 1,000,000 synthetic customer records has its `medical_device` field encrypted again with pgcrypto (AES-256-CBC, random IV per row); counting affected customers on every cut decrypts about 290,000 records/s. Secrets (database password, column key) live only in the VM's `.env`, never in git; the server answers hostile input with 400s (fuzzed with 3,000 random and malformed actions plus 4 WebSocket clients: no 5xx).

## 5. The three AI models, live

```
$ curl -s http://148.100.98.237:8000/api/ai   (trimmed)
{
 "platform": {
  "arch": "s390x",
  "machine_type": "9175",
  "model": "IBM z17",
  "cores": 3,
  "nnpa_ai_accelerator": true,
  "cpacf_crypto": true
 },
 "m1_forecast": {
  "m1_weather_mape": 3.84,
  "m1_dayahead_mape": 3.08,
  "eia_dayahead_mape": 2.5,
  "ttm_r2_zero_shot_mape": 5.7,
  "in_game": true
 },
 "m2_what_if": {
  "samples": 60286,
  "games": 1500,
  "engine": "stormgame",
  "helps_or_hurts_accuracy": 0.801,
  "dark_auc": 0.978,
  "server_backend": "zdnn_tensors (Telum)"
 },
 "m3_analyst": {
  "model": "IBM Granite 3.3 2B Instruct, Q8_0, big-endian GGUF on llama.cpp"
 }
}
```

- **M1** demand forecast (XGBoost + linear heating baseline, IBM Granite TTM-R2 compared): error on held-out winters 3.84% (weather only, used in the game), 3.08% (with recent demand), 5.70% (Granite TTM-R2 zero-shot, 158 forecasts in 0.11 s), 2.50% (EIA's published forecast).
- **M2** what-if predictor (IBM Snap ML on Telum): 60,286 what-if samples from 1,500 engine games; picks the right direction (helps or hurts) 80.1% of the time; critical-building AUC 0.978. It makes the AI pick on every decision card and plays "AI alone", which beats the 2021 playbook (18.2 million vs 36.5 million cold person-hours).
- **M3** analyst (IBM Granite 3.3 2B Instruct, big-endian GGUF on llama.cpp): rewrites decision cards and coaches the player; any output with a number not in its input, or advice pointing the wrong way, is rejected.

## 6. Scale and compute on the VM's cores

- Turning points: the player's storm replayed once without each decision, 64 to 135 replays in 1.6 to 8 s on 3 cores (replays reproduce the real game exactly).
- Stress test: the player's winter plan on 1,000 generated storms in about 45 s on 3 cores; the 2021 playbook's 1,000 results are computed at server start in about 20 s.
- M2 training data: 1,500 full engine games with what-if rollouts in 262 s on 3 cores.

## 7. Testing

- `server/tests/deep_test.py`: 280 full games across 7 strategies and 42 storms, invariants checked at every step (totals, temperatures, clock, outage timers, cold person-hours never decreasing, card options), plus exact replays: all hold.
- The engine's own 36 tests (24 unit, 12 randomized) pass on the z17 (big-endian).
- API fuzzing: 3,000 random/malformed actions and raw junk bodies plus 4 concurrent WebSocket clients: only 200s and 400s, the server stays healthy.
- Browser playtests (headless Chromium, real buttons and keys) at 1280x720, 1440x900 and 1920x1080: no page errors; the report's tiles and chart match the server's numbers.
