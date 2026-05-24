#!/bin/bash
# customize.sh — runs inside the builder container; assumes root + privileged.
#
# Mounts the Pi OS image read-write via a loop device, drops in pantry-server
# + Tailscale + a generated firstrun.sh, then unmounts. The host's build.sh
# bind-mounts everything under /work.
#
# Required env (set by build.sh):
#   IMAGE_PATH         — path to the writable .img inside the container
#   BINARY_PATH        — path to the cross-compiled pantry-server-armv6
#   TAILSCALE_DEB_PATH — path to a downloaded tailscale_*_armhf.deb
#   OVERLAY_DIR        — path to packages/image/overlay/
#   WIFI_SSID, WIFI_PSK, WIFI_COUNTRY, HOSTNAME, USERNAME, USER_PASSWORD,
#   SSH_AUTHORIZED_KEYS, TIMEZONE, KEYBOARD_LAYOUT
#
# Cleanup is signal-safe: a trap unmounts and detaches the loop device on
# any exit so a partially-failed run leaves the host in a clean state.

set -euo pipefail

log()  { echo "[customize] $*"; }
warn() { echo "[customize] warning: $*" >&2; }
die()  { echo "[customize] error: $*" >&2; exit 1; }

[ -n "${IMAGE_PATH:-}" ]         || die "IMAGE_PATH not set"
[ -f "$IMAGE_PATH" ]             || die "IMAGE_PATH does not exist: $IMAGE_PATH"
[ -n "${BINARY_PATH:-}" ]        || die "BINARY_PATH not set"
[ -f "$BINARY_PATH" ]            || die "binary missing: $BINARY_PATH"
[ -n "${TAILSCALE_DEB_PATH:-}" ] || die "TAILSCALE_DEB_PATH not set"
[ -f "$TAILSCALE_DEB_PATH" ]     || die "tailscale .deb missing: $TAILSCALE_DEB_PATH"
[ -n "${OVERLAY_DIR:-}" ]        || die "OVERLAY_DIR not set"
[ -d "$OVERLAY_DIR" ]            || die "overlay dir missing: $OVERLAY_DIR"

: "${HOSTNAME:=pantry}"
: "${USERNAME:=pi}"
: "${WIFI_COUNTRY:=US}"
: "${TIMEZONE:=Etc/UTC}"
: "${KEYBOARD_LAYOUT:=us}"
: "${USER_PASSWORD:=}"
: "${SSH_AUTHORIZED_KEYS:=}"
: "${WIFI_SSID:=}"
: "${WIFI_PSK:=}"

if [ -z "$USER_PASSWORD" ] && [ -z "$SSH_AUTHORIZED_KEYS" ]; then
  die "set USER_PASSWORD or SSH_AUTHORIZED_KEYS in .env.image — otherwise the Pi has no way in"
fi

# Hash the password on the host so the boot partition never sees plaintext.
# crypt() $6$ → SHA-512.
USER_PASSWORD_HASH=""
if [ -n "$USER_PASSWORD" ]; then
  USER_PASSWORD_HASH="$(openssl passwd -6 "$USER_PASSWORD")"
fi

MOUNT_ROOT="$(mktemp -d /tmp/pantry-mount.XXXXXX)"

cleanup() {
  set +e
  log "cleaning up mounts"
  # Order matters: inner mount first, then the parent rootfs.
  for m in proc sys dev/pts dev boot/firmware ""; do
    if mountpoint -q "$MOUNT_ROOT/$m" 2>/dev/null; then
      umount "$MOUNT_ROOT/$m" 2>/dev/null || umount -l "$MOUNT_ROOT/$m" 2>/dev/null
    fi
  done
  rmdir "$MOUNT_ROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Read partition layout + mount at byte offsets -----------------------------
# We deliberately avoid `losetup -P`: it relies on udev to create per-
# partition nodes (loop0p1, loop0p2), and udev isn't running inside this
# container. `mount -o loop,offset=…,sizelimit=…` lets the kernel allocate
# a fresh loop device per filesystem without needing partition device nodes
# to appear in /dev.
log "reading partition layout"
PART_INFO="$(parted -m -s "$IMAGE_PATH" unit B print)"
printf '%s\n' "$PART_INFO" | sed 's/^/  /'
BOOT_START="$(printf '%s\n' "$PART_INFO" | awk -F: '/^1:/{gsub(/B/,"",$2); print $2; exit}')"
BOOT_SIZE="$( printf '%s\n' "$PART_INFO" | awk -F: '/^1:/{gsub(/B/,"",$4); print $4; exit}')"
ROOT_START="$(printf '%s\n' "$PART_INFO" | awk -F: '/^2:/{gsub(/B/,"",$2); print $2; exit}')"
ROOT_SIZE="$( printf '%s\n' "$PART_INFO" | awk -F: '/^2:/{gsub(/B/,"",$4); print $4; exit}')"
[ -n "$BOOT_START" ] && [ -n "$BOOT_SIZE" ] && \
[ -n "$ROOT_START" ] && [ -n "$ROOT_SIZE" ] || die "could not parse partition table"
log "boot: start=$BOOT_START size=$BOOT_SIZE"
log "root: start=$ROOT_START size=$ROOT_SIZE"

log "mounting rootfs"
mount -o "loop,offset=$ROOT_START,sizelimit=$ROOT_SIZE" "$IMAGE_PATH" "$MOUNT_ROOT"
mkdir -p "$MOUNT_ROOT/boot/firmware"
log "mounting boot at /boot/firmware"
mount -o "loop,offset=$BOOT_START,sizelimit=$BOOT_SIZE" "$IMAGE_PATH" "$MOUNT_ROOT/boot/firmware"

# Drop the pantry-server binary into place ----------------------------------
# The systemd unit (packages/server/scripts/pantry-server.service) expects
# the binary at /home/pi/server/pantry-server with WorkingDirectory there
# too — pantry.db gets created beside it.
log "installing pantry-server binary"
mkdir -p "$MOUNT_ROOT/home/$USERNAME/server"
install -m 0755 "$BINARY_PATH" "$MOUNT_ROOT/home/$USERNAME/server/pantry-server"
# Also drop a symlink in /usr/local/bin/ so the binary is on PATH for SSH
# debugging sessions.
ln -sf "/home/$USERNAME/server/pantry-server" "$MOUNT_ROOT/usr/local/bin/pantry-server"

# Systemd unit ---------------------------------------------------------------
# Reuse the existing unit from packages/server/scripts/, dropping a tiny
# override so TAILSCALE_OPERATOR matches whichever USERNAME the user picked
# in .env.image (defaults to `pi`, matching the unit's User= field).
log "installing pantry-server.service"
install -m 0644 "$OVERLAY_DIR/../../server/scripts/pantry-server.service" \
  "$MOUNT_ROOT/etc/systemd/system/pantry-server.service"
mkdir -p "$MOUNT_ROOT/etc/systemd/system/pantry-server.service.d"
cat > "$MOUNT_ROOT/etc/systemd/system/pantry-server.service.d/pi-image.conf" <<DROPIN
[Service]
Environment=TAILSCALE_OPERATOR=$USERNAME
# Bind the server to the standard HTTP port so users hit http://pantry.local
# (no :4001 suffix) once the Pi is on the LAN. Granting
# CAP_NET_BIND_SERVICE lets pantry-server (which runs as User=pi) bind to
# privileged ports without running as root.
Environment=GRAPHQL_PORT=80
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
DROPIN
# Enable at next boot. We can't run `systemctl enable` against the offline
# rootfs without a working dbus; create the wants-symlink by hand instead.
mkdir -p "$MOUNT_ROOT/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/pantry-server.service \
  "$MOUNT_ROOT/etc/systemd/system/multi-user.target.wants/pantry-server.service"

# Tailscale ------------------------------------------------------------------
# dpkg-deb -x just extracts data.tar.* into the rootfs. We then run the
# postinst manually through qemu+chroot to register systemd units, create
# the tailscale user, etc.
log "installing tailscale via chroot+qemu"
# qemu-user-static is already registered via binfmt at the host level
# (the host runs `tonistiigi/binfmt --install all` before invoking us).
cp /usr/bin/qemu-arm-static "$MOUNT_ROOT/usr/bin/qemu-arm-static"

mount -t proc proc "$MOUNT_ROOT/proc"
mount -t sysfs sys "$MOUNT_ROOT/sys"
mount --bind /dev "$MOUNT_ROOT/dev"
mount --bind /dev/pts "$MOUNT_ROOT/dev/pts"

cp "$TAILSCALE_DEB_PATH" "$MOUNT_ROOT/tmp/tailscale.deb"
# DEBIAN_FRONTEND=noninteractive keeps postinst from prompting. The dpkg
# install runs against the in-rootfs binary set via qemu emulation.
chroot "$MOUNT_ROOT" /bin/bash -c "DEBIAN_FRONTEND=noninteractive dpkg -i /tmp/tailscale.deb || (apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -fy && dpkg -i /tmp/tailscale.deb)"
rm -f "$MOUNT_ROOT/tmp/tailscale.deb"
chroot "$MOUNT_ROOT" /bin/bash -c "systemctl enable tailscaled.service" || \
  ln -sf /lib/systemd/system/tailscaled.service \
    "$MOUNT_ROOT/etc/systemd/system/multi-user.target.wants/tailscaled.service"

# User account (prebaked) ----------------------------------------------------
# Bookworm Lite ships a UID-1000 `pi` user but parks it in a "needs first-boot
# setup" state that triggers the interactive username/password dialog
# (userconfig.service — disabled further below). We finish the account here,
# offline, so the image boots fully configured with no console prompt: set the
# password hash, group memberships, passwordless sudo (the installer-ui's
# `tailscale up` needs it), and any SSH keys. Runs in the chroot so the writes
# land in the image's own user/group databases. `set -euo pipefail` aborts the
# build if any of this fails, so a broken account never ships.
log "configuring user '$USERNAME' offline (prebaked)"
chroot "$MOUNT_ROOT" /usr/bin/env \
  PH_USER="$USERNAME" PH_HASH="$USER_PASSWORD_HASH" PH_KEYS="$SSH_AUTHORIZED_KEYS" \
  /bin/bash -euc '
    if ! id "$PH_USER" >/dev/null 2>&1; then
      useradd -m -s /bin/bash "$PH_USER"
    fi
    for g in adm dialout cdrom sudo audio video plugdev games users input render netdev gpio i2c spi; do
      usermod -aG "$g" "$PH_USER" 2>/dev/null || true
    done
    if [ -n "$PH_HASH" ]; then
      printf "%s:%s\n" "$PH_USER" "$PH_HASH" | chpasswd -e
    fi
    printf "%s ALL=(ALL) NOPASSWD: ALL\n" "$PH_USER" > "/etc/sudoers.d/010_${PH_USER}-nopasswd"
    chmod 0440 "/etc/sudoers.d/010_${PH_USER}-nopasswd"
    if [ -n "$PH_KEYS" ]; then
      install -d -m 700 -o "$PH_USER" -g "$PH_USER" "/home/$PH_USER/.ssh"
      printf "%s\n" "$PH_KEYS" > "/home/$PH_USER/.ssh/authorized_keys"
      chown "$PH_USER":"$PH_USER" "/home/$PH_USER/.ssh/authorized_keys"
      chmod 600 "/home/$PH_USER/.ssh/authorized_keys"
    fi
  '

# Trim apt state the tailscale install touched. The dpkg -i fallback path
# runs `apt-get update`, repopulating /var/lib/apt/lists with tens of MB of
# package indexes that have no business shipping in the image; the install
# may also cache .debs. Clearing both shrinks the compressed output.
log "cleaning apt caches"
chroot "$MOUNT_ROOT" /bin/bash -c "apt-get clean" 2>/dev/null || true
rm -rf "$MOUNT_ROOT/var/lib/apt/lists/"* 2>/dev/null || true

# Done with chroot mounts.
umount "$MOUNT_ROOT/dev/pts"
umount "$MOUNT_ROOT/dev"
umount "$MOUNT_ROOT/sys"
umount "$MOUNT_ROOT/proc"
rm -f "$MOUNT_ROOT/usr/bin/qemu-arm-static"

# First-boot user wizard + log console --------------------------------------
# Two display-facing fixes so a freshly-flashed card boots straight into the
# server with no interactive setup:
#
#  1. Disable userconfig.service. On a stock Bookworm image this oneshot runs
#     the "enter a new username / set a password" dialog on the console at
#     first boot — even though a `pi` user already exists. The account is
#     prebaked above, so we drop its enablement symlink and mask the unit.
#
#  2. Replace the tty1 login prompt with a live server-log view. getty@tty1
#     (and autovt@tty1) are masked, and pantry-console.service tails the
#     pantry-server journal onto /dev/tty1 — a monitor plugged into the Pi
#     shows the server logs, never a `login:` prompt. (Alt+F2…F6 still give a
#     normal login on the other VTs for hands-on debugging.)
#
# These touch only the mounted rootfs and run before the shrink below, so the
# new files end up inside the trimmed filesystem.
log "disabling first-boot user wizard (userconfig.service)"
rm -f "$MOUNT_ROOT/etc/systemd/system/multi-user.target.wants/userconfig.service"
ln -sf /dev/null "$MOUNT_ROOT/etc/systemd/system/userconfig.service"

log "installing pantry-console.service (server logs on tty1)"
# Mask the primary-VT login so nothing claims tty1 out from under us.
ln -sf /dev/null "$MOUNT_ROOT/etc/systemd/system/getty@tty1.service"
ln -sf /dev/null "$MOUNT_ROOT/etc/systemd/system/autovt@tty1.service"
cat > "$MOUNT_ROOT/etc/systemd/system/pantry-console.service" <<'CONSOLE'
[Unit]
Description=Pantry Host server logs on the primary display (tty1)
After=pantry-server.service systemd-user-sessions.service
Wants=pantry-server.service
Conflicts=getty@tty1.service

[Service]
Type=simple
# Show recent history then follow. -o cat drops the syslog prefixes so the
# screen reads like the server's own stdout. Restart keeps the view alive if
# journald or the tty hiccups.
ExecStart=/usr/bin/journalctl --boot --follow --lines=200 --output=cat --unit=pantry-server
StandardInput=tty
StandardOutput=tty
StandardError=tty
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
CONSOLE
ln -sf /etc/systemd/system/pantry-console.service \
  "$MOUNT_ROOT/etc/systemd/system/multi-user.target.wants/pantry-console.service"

# firstrun.sh ----------------------------------------------------------------
# Substitute placeholders in the .tmpl with our env values via Python
# string.Template — safe for arbitrary characters including those that
# would break sed/envsubst (WiFi passwords with /, $, \, etc.).
log "generating firstrun.sh"
FIRSTRUN_TMPL="$OVERLAY_DIR/boot/firmware/firstrun.sh.tmpl"
[ -f "$FIRSTRUN_TMPL" ] || die "missing firstrun template at $FIRSTRUN_TMPL"
python3 <<PY > "$MOUNT_ROOT/boot/firmware/firstrun.sh"
import os
import re

src = open("$FIRSTRUN_TMPL").read()
values = {
    "WIFI_SSID":           os.environ.get("WIFI_SSID", ""),
    "WIFI_PSK":            os.environ.get("WIFI_PSK", ""),
    "WIFI_COUNTRY":        os.environ.get("WIFI_COUNTRY", "US"),
    "HOSTNAME":            os.environ.get("HOSTNAME", "pantry"),
    "USERNAME":            os.environ.get("USERNAME", "pi"),
    "USER_PASSWORD_HASH":  os.environ.get("USER_PASSWORD_HASH", ""),
    "SSH_AUTHORIZED_KEYS": os.environ.get("SSH_AUTHORIZED_KEYS", ""),
    "TIMEZONE":            os.environ.get("TIMEZONE", "Etc/UTC"),
    "KEYBOARD_LAYOUT":     os.environ.get("KEYBOARD_LAYOUT", "us"),
}
# Escape single quotes inside values so the surrounding single-quoted shell
# strings in the template stay intact. ('foo' → 'foo'"'"'bar' style.)
def sh_escape(v):
    return v.replace("'", "'\"'\"'")
def repl(m):
    key = m.group(1)
    if key not in values:
        raise SystemExit(f"unknown placeholder: {{ {key} }}")
    return sh_escape(values[key])
out = re.sub(r"\{\{([A-Z_]+)\}\}", repl, src)
print(out)
PY
chmod 0755 "$MOUNT_ROOT/boot/firmware/firstrun.sh"

# Wire firstrun.sh into cmdline.txt so it actually runs on first boot. Pi
# OS Imager does this same surgery — we append `systemd.run=…` to the
# kernel command line, firstrun.sh removes its own entries before rebooting.
CMDLINE="$MOUNT_ROOT/boot/firmware/cmdline.txt"
if [ -f "$CMDLINE" ]; then
  if ! grep -q "systemd.run=/boot/firmware/firstrun.sh" "$CMDLINE"; then
    log "appending firstrun bootstrap to cmdline.txt"
    # cmdline.txt is one long line; preserve it.
    sed -i '1 s|$| systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target|' "$CMDLINE"
  fi
else
  log "warning: $CMDLINE not found — firstrun.sh will not auto-execute"
fi

# Enable SSH unconditionally — the user may not have set keys, but we still
# want to be able to reach the device if WiFi works. Touch /boot/firmware/ssh
# is Pi OS's canonical "turn SSH on" marker, supplemented by firstrun.sh
# explicitly enabling ssh.service.
touch "$MOUNT_ROOT/boot/firmware/ssh"

# Make sure the prebaked user owns its home + server dir. The account was
# created/finished in the chroot above (UID/GID 1000 — the Bookworm default
# for the first regular user, `pi`), but the binary and server dir were
# dropped in as root, so chown the tree to match.
chown -R 1000:1000 "$MOUNT_ROOT/home/$USERNAME"

# Final sync + unmount happen in cleanup() via the EXIT trap.
sync
log "customization complete"
