# `packages/image` — flashable Pantry Host SD-card image

Builds a Raspberry Pi OS Lite image with `pantry-server`, Tailscale, and
auto-WiFi baked in. `dd` the result onto a microSD card, plug it into a Pi
Zero W, and power on.

> **First-cut scope:** original Pi Zero W (ARMv6, 512 MB). Pi Zero 2 W /
> Pi 3 / Pi 4 will follow once the binary is built for those targets and
> `build.sh` learns a `--target` flag.
>
> **Captive portal:** WiFi credentials currently come from `.env.image`
> (gitignored). Replacing that with a captive-portal first-boot flow is a
> follow-up — track in the project's roadmap.

## Prereqs

- Docker (Desktop on macOS, or Engine on Linux). `--privileged` containers
  must be allowed.
- `curl`, `xz`, `shasum` on the host.
- About 8 GB free disk. The Pi OS Lite image expands to ~3 GB and we keep a
  staging copy + a compressed output.

## One-time setup

```bash
cp packages/image/.env.image.example packages/image/.env.image
$EDITOR packages/image/.env.image
```

The fields you have to fill in:

| Var                  | Why                                            |
|----------------------|------------------------------------------------|
| `WIFI_SSID`          | Network the Pi joins on first boot             |
| `WIFI_PSK`           | WPA2 password for that network                 |
| `WIFI_COUNTRY`       | 2-letter regulatory domain (e.g. `US`, `GB`)   |
| `USER_PASSWORD`      | Initial user password (gets hashed at build)   |
| `SSH_AUTHORIZED_KEYS`| Optional — set instead of (or with) a password |

Everything else has a sensible default. `HOSTNAME` defaults to `pantry`
(reachable at `pantry.local` over mDNS); `USERNAME` defaults to `pi`
because the bundled systemd unit is pinned to that user.

## Build

```bash
cd packages/image
./build.sh
```

The first run will:

1. Cross-compile `pantry-server` for `arm-unknown-linux-gnueabihf` via the
   existing `packages/server/scripts/build-pi.sh armv6` pipeline. This is
   slow the first time (~5 minutes on an M-series Mac), nearly instant
   thereafter.
2. Download Raspberry Pi OS Lite (32-bit, armhf, Bookworm) into
   `work/cache/`. Cached across runs.
3. Download the latest stable Tailscale `armhf` `.deb` from
   `pkgs.tailscale.com`. Cached across runs.
4. Spin up a privileged Linux container, loop-mount the Pi OS image,
   inject `pantry-server` + Tailscale (via `chroot` + `qemu-user-static`),
   and bake in all system config (hostname, WiFi, timezone, keyboard, user
   account) offline, then unmount.
5. Compress and checksum the result into
   `dist/pantry-host-pi-zero-w-YYYYMMDD-HHMMSS.img.xz`.

Re-runs reuse the cached Pi OS image and `pantry-server` binary unless you
pass `--skip-binary` / `--skip-pi-os` to flip the caches off explicitly.

### Flags

```
--skip-binary    Reuse packages/server/dist/pi/pantry-server-armv6 if present.
--skip-pi-os     Reuse the cached Pi OS image instead of re-downloading.
--no-compress    Leave the raw .img next to .img.xz (faster dd, larger file).
--no-shrink      Skip the rootfs shrink; ship the full ~2.4 GB image.
```

## Flash

The companion `flash.sh` does the whole dance for you — it lists each
candidate disk with its size and free space (so you can pick out the SD
card), verifies the image checksum, unmounts the disk, and `dd`s the image
onto it (raw device on macOS for speed):

```bash
cd packages/image
./flash.sh                 # newest dist/*.img(.xz), then choose a disk
./flash.sh path/to.img.xz  # flash a specific image
./flash.sh --all           # also list internal/fixed disks (careful)
```

It defaults to external/removable disks only and makes you type the chosen
disk identifier (e.g. `disk6`) to confirm before erasing it. Handles both
`.img` and `.img.xz` inputs. Run `./flash.sh --help` for all flags.

If you'd rather flash by hand, `build.sh` also prints the exact `dd`
invocation when it finishes. The generic form on macOS:

```bash
diskutil list                                # find your SD card (e.g. /dev/disk6)
diskutil unmountDisk /dev/disk6
xzcat dist/pantry-host-pi-zero-w-*.img.xz \
  | sudo dd of=/dev/rdisk6 bs=4M status=progress conv=fsync
sync && diskutil eject /dev/disk6
```

> Use `/dev/rdiskN` (raw device) on macOS — `/dev/diskN` is 10–20× slower.
> Be **certain** of the device number; `dd` will happily overwrite your
> internal drive.

On Linux:

```bash
lsblk                                        # find your SD card
sudo umount /dev/sdX*                        # if anything auto-mounted
xzcat dist/pantry-host-pi-zero-w-*.img.xz \
  | sudo dd of=/dev/sdX bs=4M status=progress conv=fsync
sync
```

## First boot

Plug the card in, power on. There's **no first-boot configuration pass and
no reboot** — hostname, WiFi, timezone, keyboard, and the user account are
all baked into the image at build time, so the Pi boots **once**, straight
into the normal multi-user target:

1. NetworkManager auto-connects to the baked WiFi profile
   (`/etc/NetworkManager/system-connections/preconfigured.nmconnection`).
   The regulatory domain is set via the `cfg80211.ieee80211_regdom` kernel
   param appended to `cmdline.txt`.
2. `pantry-server.service` and `tailscaled.service` start — both enabled
   offline via their `multi-user.target.wants` symlinks. `pantry-server`
   listens on port `80` (standard HTTP) and serves both the GraphQL API and
   the embedded Rex SPA; the systemd drop-in
   (`pantry-server.service.d/pi-image.conf`) grants `CAP_NET_BIND_SERVICE`
   so it binds port 80 without running as root.
3. SSH comes up (the `/boot/firmware/ssh` marker plus an explicit
   `ssh.service` wants-symlink). Only a single **ed25519** host key is
   generated: `customize.sh` rewrites Pi OS's shared
   `regenerate_ssh_host_keys` script (used by both the initramfs `firstboot`
   and the regen service) to emit ed25519 only, dropping the RSA-3072 keygen
   that otherwise spends ~30s behind the blue "Generating SSH keys" screen.

It usually takes ~30–45 seconds from power-on to the device appearing on
the network — roughly one boot cycle faster than the old
configure-then-reboot flow. Then:

```bash
# Find the Pi
ping pantry.local                            # or check your router's DHCP table
ssh pi@pantry.local                          # password from .env.image

# In a browser
open http://pantry.local
```

The first time you load the SPA, the in-app installer flow steps through
Tailscale auth and any other one-time configuration. The server invokes
`tailscale up --operator=$USERNAME`, so once that completes the user can
run `tailscale status`, `tailscale logout`, etc. without `sudo`.

## What's baked into the image

```
/home/pi/server/pantry-server                 (3 MB Rust binary)
/usr/local/bin/pantry-server                  (symlink to above)
/etc/systemd/system/pantry-server.service     (from packages/server/scripts/)
/etc/systemd/system/pantry-server.service.d/pi-image.conf
                                              (GRAPHQL_PORT=80, CAP_NET_BIND_SERVICE,
                                               TAILSCALE_OPERATOR=$USERNAME)
/usr/sbin/tailscaled, /usr/bin/tailscale      (apt-installed Tailscale)
/etc/hostname, /etc/hosts                     (hostname)
/etc/NetworkManager/system-connections/preconfigured.nmconnection  (WiFi)
/etc/localtime, /etc/timezone, /etc/default/keyboard  (locale)
/boot/firmware/cmdline.txt                    (+ cfg80211.ieee80211_regdom=<country>)
```

Everything else is stock Raspberry Pi OS Lite (Bookworm, 32-bit armhf).

## Troubleshooting

- **WiFi doesn't come up:** check the baked NM profile with
  `nmcli connection show preconfigured` and the regulatory domain with
  `iw reg get` (should match `WIFI_COUNTRY`). The profile must be `0600` +
  root-owned or NetworkManager ignores it.
- **pantry-server log:** `journalctl -u pantry-server` (or `-f` to tail).
- **`docker run` returns "operation not permitted":** Docker Desktop on
  macOS needs the *Allow privileged containers* setting (Settings →
  Advanced) toggled on. Linux engines need to run `build.sh` as a user in
  the `docker` group.
- **`losetup: cannot find free loop device`:** rare on macOS; restarting
  Docker Desktop usually clears it.
- **Build takes forever inside the container:** the Tailscale dpkg install
  runs through QEMU emulation (host arch ≠ armhf). It's a one-time cost
  per image build and typically wraps in 2–3 minutes.

## Why ARMv6 and not Pi Zero 2 W?

The Pi Zero W (BCM2835, ARMv6 + VFPv2) is the floor. If we can run on it,
every newer Pi runs on it. Pi Zero 2 W / Pi 3 / Pi 4 will get their own
build variants once we extend `build.sh` with a `--target` flag — the
cross-compile infrastructure in `packages/server/scripts/build-pi.sh`
already produces `armv7` and `arm64` binaries.
