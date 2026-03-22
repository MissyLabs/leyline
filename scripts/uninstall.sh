#!/usr/bin/env bash
#
# Leyline node uninstaller — removes the service, user, and optionally data.
#
# Usage:
#   sudo bash scripts/uninstall.sh           # keep data
#   sudo bash scripts/uninstall.sh --purge   # remove everything including data
#
set -euo pipefail

LEYLINE_DIR="${LEYLINE_DIR:-/opt/leyline}"
LEYLINE_USER="${LEYLINE_USER:-leyline}"
PURGE=false

for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=true ;;
  esac
done

info()  { echo -e "\033[1;34m[leyline]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[leyline]\033[0m $*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (or with sudo)" >&2
  exit 1
fi

for svc in leyline leyline-seed; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    info "Stopping $svc..."
    systemctl stop "$svc"
  fi
  if [ -f "/etc/systemd/system/${svc}.service" ]; then
    info "Removing $svc service..."
    systemctl disable "$svc" 2>/dev/null || true
    rm -f "/etc/systemd/system/${svc}.service"
  fi
done
systemctl daemon-reload

if [ "$PURGE" = true ]; then
  info "Removing $LEYLINE_DIR (including data)..."
  rm -rf "$LEYLINE_DIR"
else
  info "Removing $LEYLINE_DIR (keeping data/)..."
  # Remove everything except the data directory
  find "$LEYLINE_DIR" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
fi

if id "$LEYLINE_USER" >/dev/null 2>&1; then
  info "Removing system user: $LEYLINE_USER"
  userdel "$LEYLINE_USER" 2>/dev/null || true
fi

ok "Leyline uninstalled."
