#!/usr/bin/env bash
# Copies this repo to the LinuxONE VM, then rebuilds and restarts the containers there.
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
ssh -i "$SSH_KEY" "$VM_USER@$VM_HOST" "cd $REMOTE_DIR \
  && { [ -f .env ] || echo POSTGRES_PASSWORD=\$(openssl rand -hex 16) > .env; } \
  && podman-compose up -d --build server db && podman ps"
