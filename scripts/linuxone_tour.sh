#!/usr/bin/env bash
# One screen that shows Lights Out running on IBM LinuxONE, for the demo video and the judges.
# Read-only, and it prints no secrets (it never reads .env; records show only their encrypted bytes).
# Run on the VM:  bash ~/control-room/scripts/linuxone_tour.sh
set -uo pipefail
C=$'\e[1;36m'; B=$'\e[1m'; D=$'\e[2m'; R=$'\e[0m'
API=http://localhost:8000
head() { printf '\n%s━━ %s %s\n' "$C" "$1" "$R"; }
row() { printf '  %-24s %s\n' "$1" "$2"; }
indent() { sed 's/^/  /'; }

head "1. THE MACHINE: IBM LinuxONE"
row "Architecture" "$(uname -m)"
row "Machine type" "$(lscpu | awk -F: '/^Machine type/ {gsub(/ /, "", $2); print $2}')  (IBM z17)"
row "Cores" "$(nproc)"
grep -qw nnpa /proc/cpuinfo && row "nnpa" "on-chip AI accelerator (Telum II)"
grep -qw msa /proc/cpuinfo && row "msa" "CPACF crypto in every core"

head "2. EVERYTHING RUNS IN PODMAN CONTAINERS"
podman ps --filter name=control-room --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" | grep -v _test | indent
echo
podman stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" | grep -v _test | indent

head "3. THREE AI MODELS, ALL ON THE Z"
curl -s "$API/api/ai" | python3 -c "$(cat <<'PY'
import json, sys
d = json.load(sys.stdin)
m1, m2, t, m3 = d['m1_forecast'], d['m2_what_if'], d['m2_telum_benchmark'], d['m3_analyst']
row = lambda k, v: print(f'  {k:24} {v}')
row('M1 demand forecast', f"XGBoost on {m1['train_hours']:,} hours of ERCOT demand, {m1['m1_dayahead_mape']}% day-ahead error")
row('M2 what-if (Snap ML)', f"runs on {m2['server_backend']}, {t['telum']['single_ms_median']} ms a prediction")
row('', f"same answers as the CPU (max difference {t['agreement']['max_abs_diff_cold_person_hours']}), "
        f"{m2['dark_accuracy']:.1%} accurate on critical buildings")
row('M3 analyst (Granite)', m3['model'])
row('', f"{m3['accepted']} of {m3['requests']} texts passed the number check, {m3['tokens_per_sec']} tokens/s on 3 cores")
PY
)"
podman logs control-room_server_1 2>&1 | grep -m1 "M2 backend" | sed "s/^/  ${D}log: /; s/\$/${R}/"

head "4. SECURITY"
sudo -n cryptsetup status controlroom-secure 2>/dev/null | awk -F: '/type|cipher|keysize/ {gsub(/^ +/, "", $1); gsub(/^ +/, "", $2); printf "  %-24s %s\n", "Encrypted disk " $1, $2}'
awk '/^driver/ {d = $3} /^priority/ {if (d == "xts-aes-s390") {printf "  %-24s %s\n", "Disk AES driver", "xts-aes-s390 (CPACF hardware, priority " $3 ")"; exit}}' /proc/crypto
DB="podman exec control-room_db_1 psql -U controlroom -d controlroom -At"
row "Customer records" "$($DB -c "select to_char(count(*), 'FM9,999,999') from customers") synthetic accounts in PostgreSQL"
echo "  ${D}medical-device flag per account, AES-encrypted with pgcrypto (no key on screen):${R}"
$DB -F ' | ' -c "select account_id, circuit_id, encode(substring(medical_device for 16), 'hex') || '…' from customers order by random() limit 3" | indent

head "5. THE LIVE GAME"
curl -s "$API/api/state" | python3 -c "$(cat <<'PY'
import json, sys
s = json.load(sys.stdin)
row = lambda k, v: print(f'  {k:24} {v}')
row('Phase', f"{s['phase']}, game time {s['time'][:16].replace('T', ' ')}")
row('Cut order', f"{s['order_mw']:,.0f} MW ordered, {s['cut_mw']:,.0f} MW cut")
row('People', f"{s['totals']['people_no_power']:,} without power, {s['totals']['people_cold']:,} in cold homes")
PY
)"
curl -s "$API/api/health" | python3 -c "$(cat <<'PY'
import json, sys
h = json.load(sys.stdin)
print(f"  {'Engine':24} {h['engine']} on {h['arch']}, {h['clients']} screens connected")
PY
)"
echo
