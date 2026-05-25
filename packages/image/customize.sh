#!/bin/bash
# customize.sh — runs inside the builder container; assumes root + privileged.
#
# Mounts the Pi OS image read-write via a loop device, drops in pantry-server
# + Tailscale, bakes in all system config (hostname, WiFi, timezone, keyboard,
# user account) offline, then unmounts. There's no first-boot script: the card
# boots once, fully configured. The host's build.sh bind-mounts everything
# under /work.
#
# Required env (set by build.sh):
#   IMAGE_PATH         — path to the writable .img inside the container
#   BINARY_PATH        — path to the cross-compiled pantry-server-armv6
#   TAILSCALE_DEB_PATH — path to a downloaded tailscale_*_armhf.deb
#   SERVER_DIR         — path to packages/server/ (for the systemd unit)
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
[ -n "${SERVER_DIR:-}" ]         || die "SERVER_DIR not set"
[ -d "$SERVER_DIR" ]             || die "server dir missing: $SERVER_DIR"

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
install -m 0644 "$SERVER_DIR/scripts/pantry-server.service" \
  "$MOUNT_ROOT/etc/systemd/system/pantry-server.service"
mkdir -p "$MOUNT_ROOT/etc/systemd/system/pantry-server.service.d"
cat > "$MOUNT_ROOT/etc/systemd/system/pantry-server.service.d/pi-image.conf" <<DROPIN
[Service]
# The base unit at packages/server/scripts/pantry-server.service hardcodes
# User=pi, WorkingDirectory=/home/pi/server, and ExecStart=/home/pi/server/
# pantry-server. When the .env.image picks a different USERNAME, every one
# of those paths needs to follow — otherwise systemd fails CHDIR (and
# can't even reach ExecStart) because /home/pi is jw-unreadable. The empty
# ExecStart= before the new one is systemd's required incantation to
# *replace* rather than append the command.
User=$USERNAME
WorkingDirectory=/home/$USERNAME/server
ExecStart=
ExecStart=/home/$USERNAME/server/pantry-server
Environment=SQLITE_DB_PATH=/home/$USERNAME/server/pantry.db

Environment=TAILSCALE_OPERATOR=$USERNAME
# Bind the server to the standard HTTP port so users hit http://pantry.local
# (no :4001 suffix) once the Pi is on the LAN. Granting
# CAP_NET_BIND_SERVICE lets pantry-server bind to privileged ports without
# running as root.
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

# Offline system config (hostname / timezone / keyboard / WiFi) -------------
# Everything here used to run on the device via firstrun.sh, gated behind a
# throwaway boot into kernel-command-line.target that existed only to run the
# script and then `reboot` into multi-user — two full boot cycles. But it's
# all static config known at build time, so we bake it straight into the
# rootfs now. The card boots ONCE, directly into multi-user, already
# configured: no first-boot pass, no reboot. (Services — ssh, pantry-server,
# tailscaled — are enabled offline via their wants-symlinks elsewhere here.)

# Hostname + the 127.0.1.1 line in /etc/hosts.
log "setting hostname to '$HOSTNAME'"
echo "$HOSTNAME" > "$MOUNT_ROOT/etc/hostname"
if grep -q '^127\.0\.1\.1' "$MOUNT_ROOT/etc/hosts" 2>/dev/null; then
  sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$HOSTNAME/" "$MOUNT_ROOT/etc/hosts"
else
  printf '127.0.1.1\t%s\n' "$HOSTNAME" >> "$MOUNT_ROOT/etc/hosts"
fi

# Timezone: the /etc/localtime symlink + /etc/timezone name. Read at boot; the
# zoneinfo db already lives in the rootfs, so no dpkg-reconfigure needed.
if [ -n "$TIMEZONE" ] && [ -e "$MOUNT_ROOT/usr/share/zoneinfo/$TIMEZONE" ]; then
  log "setting timezone to $TIMEZONE"
  ln -sf "/usr/share/zoneinfo/$TIMEZONE" "$MOUNT_ROOT/etc/localtime"
  echo "$TIMEZONE" > "$MOUNT_ROOT/etc/timezone"
fi

# Keyboard layout. keyboard-setup.service reads /etc/default/keyboard at boot.
if [ -n "$KEYBOARD_LAYOUT" ] && [ -f "$MOUNT_ROOT/etc/default/keyboard" ]; then
  log "setting keyboard layout to $KEYBOARD_LAYOUT"
  sed -i "s/^XKBLAYOUT=.*/XKBLAYOUT=\"$KEYBOARD_LAYOUT\"/" \
    "$MOUNT_ROOT/etc/default/keyboard"
fi

# WiFi: a NetworkManager connection profile, byte-aligned with the keyfile Pi
# OS Imager writes (imager_custom's set_wlan) — uuid, hidden flag, [proxy]
# section, security appended only when a PSK is set. NM scans
# /etc/NetworkManager/system-connections/ at startup and connects autoconnect
# profiles (the default when unspecified). The file MUST be 0600 + root-owned
# or NM refuses to load it (its credentials-leak guard).
if [ -n "$WIFI_SSID" ]; then
  log "baking WiFi profile for SSID '$WIFI_SSID'"
  install -d -m 700 "$MOUNT_ROOT/etc/NetworkManager/system-connections"
  WIFI_UUID="$(cat /proc/sys/kernel/random/uuid)"
  CONNFILE="$MOUNT_ROOT/etc/NetworkManager/system-connections/preconfigured.nmconnection"
  cat > "$CONNFILE" <<NMCONN
[connection]
id=preconfigured
uuid=$WIFI_UUID
type=wifi
[wifi]
mode=infrastructure
ssid=$WIFI_SSID
hidden=false
[ipv4]
method=auto
[ipv6]
addr-gen-mode=default
method=auto
[proxy]
NMCONN
  if [ -n "$WIFI_PSK" ]; then
    cat >> "$CONNFILE" <<NMSEC
[wifi-security]
key-mgmt=wpa-psk
psk=$WIFI_PSK
NMSEC
  fi
  chmod 600 "$CONNFILE"
fi

# WiFi regulatory domain. firstrun.sh used to run `raspi-config nonint
# do_wifi_country` on the device; instead we set it at the cfg80211 layer via
# a kernel cmdline param, so the legal 2.4 GHz channels + tx power are in
# force before wlan0 ever comes up — no runtime step required. (Baked WiFi is
# a build-time dev convenience; the shipping flow gathers it via captive
# portal, at which point this whole block goes away.)
CMDLINE="$MOUNT_ROOT/boot/firmware/cmdline.txt"
if [ -f "$CMDLINE" ] && [ -n "$WIFI_COUNTRY" ]; then
  if ! grep -q "cfg80211.ieee80211_regdom=" "$CMDLINE"; then
    log "setting WiFi regulatory domain to $WIFI_COUNTRY via cmdline.txt"
    # cmdline.txt is one long line; append to it, preserve it.
    sed -i "1 s|\$| cfg80211.ieee80211_regdom=$WIFI_COUNTRY|" "$CMDLINE"
  fi
elif [ ! -f "$CMDLINE" ]; then
  warn "$CMDLINE not found — WiFi regulatory domain not set"
fi

# Enable WiFi in NetworkManager. Stock Pi OS Lite ships
# /var/lib/NetworkManager/NetworkManager.state with WirelessEnabled=false —
# the radio is software-disabled at the NM level until something flips it on.
# Normally `raspi-config nonint do_wifi_country` does that (via `nmcli radio
# wifi on`, or — when NM isn't running, e.g. offline like here — by editing
# this flag directly). NM owns the rfkill soft-block and re-asserts it from
# WirelessEnabled at every startup, so this flag is the whole fix: NM unblocks
# the radio itself once WiFi is enabled. (An external `rfkill unblock` is
# pointless — NM clobbers it back to blocked while WirelessEnabled=false.)
NM_STATE="$MOUNT_ROOT/var/lib/NetworkManager/NetworkManager.state"
if [ -f "$NM_STATE" ]; then
  log "enabling WiFi in NetworkManager (WirelessEnabled=true)"
  sed -i 's/^WirelessEnabled=.*/WirelessEnabled=true/' "$NM_STATE"
else
  log "creating NetworkManager.state with WiFi enabled"
  install -d -m 755 "$MOUNT_ROOT/var/lib/NetworkManager"
  printf '[main]\nWirelessEnabled=true\n' > "$NM_STATE"
fi

# Enable SSH unconditionally — the user may not have set keys, but we still
# want to be able to reach the device if WiFi works. The /boot/firmware/ssh
# marker is Pi OS's canonical "turn SSH on" switch; we also drop the
# wants-symlink directly so ssh.service comes up on the first (and only) boot
# even if the marker mechanism shifts upstream.
touch "$MOUNT_ROOT/boot/firmware/ssh"
ln -sf /lib/systemd/system/ssh.service \
  "$MOUNT_ROOT/etc/systemd/system/multi-user.target.wants/ssh.service" 2>/dev/null || true

# SSH host keys: ed25519 only ------------------------------------------------
# Pi OS regenerates host keys on first boot — that's the ~30s blue "Generating
# SSH keys..." screen. The work runs `ssh-keygen -A` (RSA + ECDSA + ED25519),
# and the RSA-3072 keygen alone is what burns the time on a single-core ARMv6
# Pi. Every ssh client this decade speaks ed25519 and its keygen is instant,
# so we only want that one key type.
#
# Two paths share ONE script, /usr/lib/raspberrypi-sys-mods/regenerate_ssh_host_keys:
#   1. the initramfs `firstboot` (cmdline `init=…/firstboot`) calls it directly
#      behind the blue screen, then reboots;
#   2. regenerate_ssh_host_keys.service runs it again on the next boot, then
#      `systemctl disable`s itself.
# Patching this single script covers both. (Masking the .service does nothing
# for path 1 — firstboot invokes the script directly, not via systemd.) The
# key is still generated per-device on first boot, not baked into the image.
log "patching SSH host-key regen to ed25519-only"
REGEN_SCRIPT="$MOUNT_ROOT/usr/lib/raspberrypi-sys-mods/regenerate_ssh_host_keys"
if [ -f "$REGEN_SCRIPT" ]; then
  # Same shape as the stock script (rm stale keys, generate, self-disable) —
  # only the keygen line changes from `ssh-keygen -A` to ed25519-only.
  cat > "$REGEN_SCRIPT" <<'REGEN'
#!/bin/sh -e

rm -f /etc/ssh/ssh_host_*_key*
ssh-keygen -q -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N "" >/dev/null
systemctl -q disable regenerate_ssh_host_keys
REGEN
  chmod 0755 "$REGEN_SCRIPT"
else
  warn "regenerate_ssh_host_keys script not found — SSH keygen left at Pi OS default"
fi

# Make sure the prebaked user owns its home + server dir. The binary and
# server dir were dropped in as root before the user was created (we needed
# the path before useradd ran), so the tree is root-owned and the chown
# can't go through the chroot anymore (qemu + /proc + /dev are unmounted
# at this point). Look up whatever UID/GID `useradd` actually assigned by
# reading the image's /etc/passwd, then chown by number from the host.
#
# Bookworm Lite ships `pi` already at UID 1000; when USERNAME != "pi" the
# new account lands at 1001+. A hardcoded `1000:1000` here would give the
# home (and .ssh) to `pi` instead, and sshd's StrictModes check would
# refuse publickey auth for the actual user.
USER_UID="$(awk -F: -v u="$USERNAME" '$1==u{print $3; exit}' "$MOUNT_ROOT/etc/passwd")"
USER_GID="$(awk -F: -v u="$USERNAME" '$1==u{print $4; exit}' "$MOUNT_ROOT/etc/passwd")"
[ -n "$USER_UID" ] && [ -n "$USER_GID" ] \
  || die "couldn't find UID/GID for '$USERNAME' in $MOUNT_ROOT/etc/passwd"
log "chowning /home/$USERNAME to $USER_UID:$USER_GID"
chown -R "$USER_UID:$USER_GID" "$MOUNT_ROOT/home/$USERNAME"

# Final sync + unmount happen in cleanup() via the EXIT trap.
sync
log "customization complete"
