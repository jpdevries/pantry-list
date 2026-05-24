# Image-customization container. Runs as `--privileged` on the host so it
# can losetup the .img and mount its ext4 rootfs. binfmt + qemu-user-static
# let us chroot into the armhf rootfs to run Tailscale's postinst script
# during dpkg install, even though the host is amd64/arm64.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xz-utils \
    fdisk \
    parted \
    e2fsprogs \
    dosfstools \
    util-linux \
    mount \
    qemu-user-static \
    binfmt-support \
    openssl \
    python3 \
    ca-certificates \
    file \
 && rm -rf /var/lib/apt/lists/*

COPY customize.sh /usr/local/bin/customize.sh
RUN chmod +x /usr/local/bin/customize.sh

ENTRYPOINT ["/usr/local/bin/customize.sh"]
