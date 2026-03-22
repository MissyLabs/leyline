#!/usr/bin/env bash
#
# Leyline node installer — curl-installable bootstrap script.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/MissyLabs/leyline/main/scripts/install.sh | bash
#
#   # Seed node:
#   curl -fsSL https://raw.githubusercontent.com/MissyLabs/leyline/main/scripts/install.sh | bash -s -- --seed
#
#   # Skip prompts (CI / automation):
#   curl ... | LEYLINE_MODE=system bash          # force root/system install
#   curl ... | LEYLINE_MODE=user bash             # force user install
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Config (override via environment)
# ---------------------------------------------------------------------------
LEYLINE_PORT="${LEYLINE_PORT:-9876}"
LEYLINE_BRANCH="${LEYLINE_BRANCH:-main}"
LEYLINE_REPO="https://github.com/MissyLabs/leyline.git"
NODE_MIN_VERSION=22

IS_SEED=false
for arg in "$@"; do
  case "$arg" in
    --seed) IS_SEED=true ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { echo -e "\033[1;34m[leyline]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[leyline]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[leyline]\033[0m $*"; }
err()   { echo -e "\033[1;31m[leyline]\033[0m $*" >&2; }
die()   { err "$@"; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

# ---------------------------------------------------------------------------
# Determine install mode
# ---------------------------------------------------------------------------
# LEYLINE_MODE can be set to "system" or "user" to skip the prompt.
# If unset, we ask interactively (falling back to system if not a tty).

pick_mode() {
  # Already set by env — respect it
  if [ "${LEYLINE_MODE:-}" = "system" ] || [ "${LEYLINE_MODE:-}" = "user" ]; then
    return
  fi

  # Non-interactive (piped) — default to system
  if [ ! -t 0 ]; then
    LEYLINE_MODE="system"
    return
  fi

  echo ""
  info "How would you like to install Leyline?"
  echo ""
  echo "  1) System install  (recommended)"
  echo "     Runs as a dedicated 'leyline' user with a system-level systemd service."
  echo "     Requires root/sudo. Survives reboots automatically."
  echo "     Installs to /opt/leyline."
  echo ""
  echo "  2) User install"
  echo "     Runs under your current account ($USER) with a user-level systemd service."
  echo "     No root required — just needs Node.js >= $NODE_MIN_VERSION already installed."
  echo "     Installs to ~/leyline. Uses loginctl linger to persist after logout."
  echo ""

  while true; do
    read -rp "  Choose [1/2] (default: 1): " choice </dev/tty
    case "${choice:-1}" in
      1) LEYLINE_MODE="system"; return ;;
      2) LEYLINE_MODE="user"; return ;;
      *) echo "  Please enter 1 or 2." ;;
    esac
  done
}

pick_mode

if [ "$LEYLINE_MODE" = "system" ]; then
  LEYLINE_DIR="${LEYLINE_DIR:-/opt/leyline}"
  LEYLINE_USER="${LEYLINE_USER:-leyline}"

  if [ "$(id -u)" -ne 0 ]; then
    die "System install requires root. Run with sudo, or re-run and choose user install."
  fi
else
  LEYLINE_DIR="${LEYLINE_DIR:-$HOME/leyline}"
  LEYLINE_USER="$(whoami)"
fi

info "Install mode: $LEYLINE_MODE"
info "Install dir:  $LEYLINE_DIR"
info "Port:         $LEYLINE_PORT"

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
need_cmd git

# ---------------------------------------------------------------------------
# Ensure Node.js >= 20
# ---------------------------------------------------------------------------
check_node() {
  if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -ge "$NODE_MIN_VERSION" ]; then
      info "Node.js $(node -v) found"
      return 0
    fi
    warn "Node.js $(node -v) is too old (need >= $NODE_MIN_VERSION)"
  fi
  return 1
}

install_node() {
  need_cmd curl
  info "Installing Node.js 22.x via NodeSource..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    yum install -y nodejs
  else
    die "Cannot auto-install Node.js — please install Node.js >= $NODE_MIN_VERSION manually"
  fi
  info "Node.js $(node -v) installed"
}

if ! check_node; then
  if [ "$LEYLINE_MODE" = "system" ]; then
    install_node
  else
    die "Node.js >= $NODE_MIN_VERSION not found. Install it first, or re-run with sudo for system install (auto-installs Node)."
  fi
fi

need_cmd npm

# ---------------------------------------------------------------------------
# Create system user (system mode only)
# ---------------------------------------------------------------------------
if [ "$LEYLINE_MODE" = "system" ]; then
  if ! id "$LEYLINE_USER" >/dev/null 2>&1; then
    info "Creating system user: $LEYLINE_USER"
    useradd --system --home-dir "$LEYLINE_DIR" --shell /usr/sbin/nologin "$LEYLINE_USER"
  fi
fi

# ---------------------------------------------------------------------------
# Clone / update repository
# ---------------------------------------------------------------------------
if [ -d "$LEYLINE_DIR/.git" ]; then
  info "Updating existing installation at $LEYLINE_DIR"
  # Ensure git trusts this directory (owned by service user, script runs as root)
  git config --global --add safe.directory "$LEYLINE_DIR" 2>/dev/null || true
  cd "$LEYLINE_DIR"
  git fetch origin
  git reset --hard "origin/$LEYLINE_BRANCH"
else
  info "Cloning leyline to $LEYLINE_DIR"
  git clone --branch "$LEYLINE_BRANCH" --depth 1 "$LEYLINE_REPO" "$LEYLINE_DIR"
  cd "$LEYLINE_DIR"
fi

# ---------------------------------------------------------------------------
# Install dependencies and build
# ---------------------------------------------------------------------------
info "Installing dependencies..."
npm ci --production=false 2>&1 | tail -1

info "Building..."
npm run build 2>&1 | tail -1

# ---------------------------------------------------------------------------
# Create data directory
# ---------------------------------------------------------------------------
DATA_DIR="$LEYLINE_DIR/data"
mkdir -p "$DATA_DIR"

if [ "$LEYLINE_MODE" = "system" ]; then
  chown -R "$LEYLINE_USER:$LEYLINE_USER" "$LEYLINE_DIR"
fi

# ---------------------------------------------------------------------------
# Service name and args
# ---------------------------------------------------------------------------
if [ "$IS_SEED" = true ]; then
  SERVICE_NAME="leyline-seed"
  EXEC_ARGS="--seed --port $LEYLINE_PORT"
  DESCRIPTION="Leyline P2P seed node"
else
  SERVICE_NAME="leyline"
  EXEC_ARGS="--port $LEYLINE_PORT"
  DESCRIPTION="Leyline P2P node"
fi

NODE_BIN="$(command -v node)"

# ---------------------------------------------------------------------------
# Install systemd service
# ---------------------------------------------------------------------------
install_system_service() {
  info "Installing systemd system service: $SERVICE_NAME"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=$DESCRIPTION
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$LEYLINE_USER
Group=$LEYLINE_USER
WorkingDirectory=$LEYLINE_DIR
ExecStart=$NODE_BIN dist/cli.js $EXEC_ARGS
Restart=always
RestartSec=5
LimitNOFILE=65536

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$LEYLINE_DIR
PrivateTmp=true

# Environment
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
}

install_user_service() {
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"

  info "Installing systemd user service: $SERVICE_NAME"
  cat > "$UNIT_DIR/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=$DESCRIPTION
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$LEYLINE_DIR
ExecStart=$NODE_BIN dist/cli.js $EXEC_ARGS
Restart=always
RestartSec=5
LimitNOFILE=65536
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user restart "$SERVICE_NAME"

  # Enable lingering so the service stays running after logout
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$LEYLINE_USER" 2>/dev/null || warn "Could not enable linger — service may stop when you log out"
  fi
}

if [ "$LEYLINE_MODE" = "system" ]; then
  install_system_service
  CTL="systemctl"
  JOURNAL="journalctl"
else
  install_user_service
  CTL="systemctl --user"
  JOURNAL="journalctl --user"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
ok "======================================"
ok "  Leyline installed successfully!"
ok "======================================"
echo ""
ok "  Service:  $SERVICE_NAME"
ok "  Dir:      $LEYLINE_DIR"
ok "  Data:     $DATA_DIR"
ok "  Port:     $LEYLINE_PORT/tcp"
ok "  Mode:     $([ "$IS_SEED" = true ] && echo "SEED NODE" || echo "regular node")"
ok "  User:     $LEYLINE_USER"
ok "  Install:  $LEYLINE_MODE"
echo ""
ok "  $CTL status $SERVICE_NAME    # check status"
ok "  $JOURNAL -u $SERVICE_NAME -f    # tail logs"
ok "  $CTL restart $SERVICE_NAME   # restart"
ok "  $CTL stop $SERVICE_NAME      # stop"
echo ""
