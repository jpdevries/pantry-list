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
   inject `pantry-server` + a generated `firstrun.sh` + Tailscale (via
   `chroot` + `qemu-user-static`), then unmount. Finally it shrinks the
   rootfs to its minimum (plus a ~200 MB margin), so the shipped `.img` is
   ~1.4 GB instead of ~2.4 GB. `firstrun.sh` grows it back to fill the card
   on first boot. Pass `--no-shrink` to keep the full-size image.
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

Plug the card in, power on. The Pi will:

1. Expand the root filesystem to fill the SD card. The image ships with a
   shrunk rootfs (the build trims it to keep the `.img`/`.xz` small), so
   `firstrun.sh` calls `raspi-config nonint do_expand_rootfs` to grow it
   back on first boot.
2. Run `firstrun.sh` once, which configures hostname, user, WiFi,
   timezone, keyboard, SSH, and enables `pantry-server.service` +
   `tailscaled.service`.
3. Reboot into the normal multi-user target. `pantry-server` listens on
   port `80` (standard HTTP) and serves both the GraphQL API and the
   embedded Rex SPA. The image grants the binary `CAP_NET_BIND_SERVICE`
   via the systemd drop-in (`pantry-server.service.d/pi-image.conf`) so
   it doesn't need to run as root.

It usually takes ~60–90 seconds from power-on to the device appearing on
the network. Then:

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
/boot/firmware/firstrun.sh                    (removed after first boot)
```

Everything else is stock Raspberry Pi OS Lite (Bookworm, 32-bit armhf).

## Troubleshooting

- **First-boot log:** `/var/log/firstrun.log` on the Pi captures the
  configuration script's output. Useful if WiFi doesn't come up.
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
