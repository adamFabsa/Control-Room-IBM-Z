#!/usr/bin/env bash
# Run once on the LinuxONE VM: a LUKS2-encrypted volume for PostgreSQL's data.
# AES-XTS runs on the CPACF crypto unit of the IBM Z processor (kernel driver xts-aes-s390).
# The VM has no spare disk, so the volume is a file. Safe to re-run.
set -euo pipefail
IMG=/var/lib/controlroom/secure.img
SIZE=${SIZE:-8G}
KEY=/etc/controlroom/luks.key
NAME=controlroom-secure
MNT=/srv/secure

sudo mkdir -p /var/lib/controlroom "$MNT"
sudo install -d -m 700 /etc/controlroom
sudo test -f "$KEY" || sudo sh -c "umask 077; head -c 64 /dev/urandom > $KEY"
if ! sudo test -f "$IMG"; then
  sudo fallocate -l "$SIZE" "$IMG"
  sudo cryptsetup luksFormat --batch-mode --type luks2 --cipher aes-xts-plain64 --key-size 512 \
    --key-file "$KEY" "$IMG"
fi
sudo cryptsetup status "$NAME" >/dev/null 2>&1 || sudo cryptsetup open --key-file "$KEY" "$IMG" "$NAME"
sudo blkid "/dev/mapper/$NAME" >/dev/null 2>&1 || sudo mkfs.ext4 -q "/dev/mapper/$NAME"
mountpoint -q "$MNT" || sudo mount "/dev/mapper/$NAME" "$MNT"
sudo install -d -o "$USER" -g "$USER" "$MNT/pgdata"

# Unlock and mount again at boot.
grep -q "^$NAME " /etc/crypttab || echo "$NAME $IMG $KEY luks" | sudo tee -a /etc/crypttab >/dev/null
grep -q " $MNT " /etc/fstab || echo "/dev/mapper/$NAME $MNT ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab >/dev/null

echo "== volume"
sudo cryptsetup status "$NAME" | grep -E "type|cipher|keysize|device:"
df -h "$MNT" | tail -1
echo "== kernel AES-XTS drivers: the highest priority one is used (xts-aes-s390 = CPACF)"
awk '/^name/{n=$3} /^driver/{d=$3} /^priority/{p=$3} /^$/{if (n == "xts(aes)") print d, "priority=" p}' /proc/crypto
echo "== benchmark"
sudo cryptsetup benchmark --cipher aes-xts-plain64 --key-size 512 2>/dev/null | tail -2
