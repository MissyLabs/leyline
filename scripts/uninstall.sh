#!/usr/bin/env bash
#
# Leyline node uninstaller — removes the service and optionally all data.
#
# Usage:
#   sudo bash scripts/uninstall.sh           # root: keep data
#   sudo bash scripts/uninstall.sh --purge   # root: remove everything
#   bash scripts/uninstall.sh                # user: keep data
#   bash scripts/uninstall.sh --purge        # user: remove everything
#
set -euo pipefail

IS_ROOT=$([ "$(id -u)" -eq 0 ] && echo true || echo false)

if [ "$IS_ROOT" = true ]; then
  LEYLINE_DIR="${LEYLINE_DIR:-/opt/leyline}"
  LEYLINE_USER="${LEYLINE_USER:-leyline}"
else
  LEYLINE_DIR="${LEYLINE_DIR:-$HOME/leyline}"
  LEYLINE_USER="$(whoami)"
fi

PURGE=false
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=true ;;
  esac
done

info()  { echo -e "\033[1;34m[leyline]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[leyline]\033[0m $*"; }

# ---------------------------------------------------------------------------
# Stop and remove services
# ---------------------------------------------------------------------------
if [ "$IS_ROOT" = true ]; then
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
else
  UNIT_DIR="$HOME/.config/systemd/user"
  for svc in leyline leyline-seed; do
    if systemctl --user is-active --quiet "$svc" 2>/dev/null; then
      info "Stopping $svc..."
      systemctl --user stop "$svc"
    fi
    if [ -f "$UNIT_DIR/${svc}.service" ]; then
      info "Removing $svc user service..."
      systemctl --user disable "$svc" 2>/dev/null || true
      rm -f "$UNIT_DIR/${svc}.service"
    fi
  done
  systemctl --user daemon-reload
fi

# ---------------------------------------------------------------------------
# Remove files
# ---------------------------------------------------------------------------
if [ "$PURGE" = true ]; then
  info "Removing $LEYLINE_DIR (including data)..."
  rm -rf "$LEYLINE_DIR"
else
  if [ -d "$LEYLINE_DIR" ]; then
    info "Removing $LEYLINE_DIR (keeping data/)..."
    find "$LEYLINE_DIR" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
  fi
fi

# ---------------------------------------------------------------------------
# Remove system user (root only)
# ---------------------------------------------------------------------------
if [ "$IS_ROOT" = true ] && id "$LEYLINE_USER" >/dev/null 2>&1; then
  info "Removing system user: $LEYLINE_USER"
  userdel "$LEYLINE_USER" 2>/dev/null || true
fi

ok "Leyline uninstalled."
