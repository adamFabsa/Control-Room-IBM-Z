#!/usr/bin/env bash
# Like deploy.sh, but only rebuilds and restarts the test server (VM localhost:8001), leaving the live game alone.
# Reach it with: ssh -i $SSH_KEY -N -L 8001:127.0.0.1:8001 linux1@<vm>
set -euo pipefail
VM_HOST=${VM_HOST:-148.100.98.237}
VM_USER=${VM_USER:-linux1}
SSH_KEY=${SSH_KEY:-$HOME/Downloads/datathon.pem}
REMOTE_DIR=control-room

cd "$(dirname "$0")/.."
rsync -az --delete -e "ssh -i $SSH_KEY" \
  --exclude .git --exclude .env --exclude '*.docx' --exclude data/ \
  --exclude 'node_modules/' --exclude '__pycache__/' \
  ./ "$VM_USER@$VM_HOST:$REMOTE_DIR/"
ssh -i "$SSH_KEY" "$VM_USER@$VM_HOST" 'cd control-room && set -a && . ./.env && set +a \
  && podman build -q -t localhost/control-room_server:test -f server/Containerfile . >/dev/null \
  && podman rm -f control-room_test >/dev/null 2>&1; podman run -d --name control-room_test --network control-room_default \
       -p 127.0.0.1:8001:8000 -e DATABASE_URL="postgresql://controlroom:${POSTGRES_PASSWORD}@db:5432/controlroom" \
       -e PGCRYPTO_KEY="$PGCRYPTO_KEY" -e LLM_URL=http://llm:8080 localhost/control-room_server:test >/dev/null \
  && sleep 6 && podman ps --format "{{.Names}} {{.Status}}" | grep test'
