#!/bin/sh
# Runs INSIDE the linux/arm64 build container. Installs node_modules at the
# target architecture and emits the .deb into /build/dist.
set -eu

STAGE=/build/stage
DEB_OUT=/build/dist/package.deb

echo "[container] installing node_modules for linux/arm64..."
cd "$STAGE/opt/doorphone-bridge"
npm install --omit=dev --no-audit --no-fund --loglevel=error

echo "[container] normalising permissions..."
cd "$STAGE"
# Skip chmod on the bind-mount root itself (host-owned, EPERM for container).
find . -mindepth 1 -type d -exec chmod 0755 {} +
find . -mindepth 1 -type f -exec chmod 0644 {} +
chmod 0755 DEBIAN/postinst DEBIAN/prerm DEBIAN/postrm \
           usr/bin/doorphone-bridge \
           opt/doorphone-bridge/bin/doorphone-bridge
chmod 0640 etc/doorphone-bridge/config.json

echo "[container] dpkg-deb --build ..."
dpkg-deb --root-owner-group --build "$STAGE" "$DEB_OUT"
chmod 0644 "$DEB_OUT"
ls -la "$DEB_OUT"
