#!/usr/bin/env bash
#
# Leyline node installer — curl-installable bootstrap script.
#
# Runs as root (systemd service) or as a regular user (user service / foreground).
#
# Usage:
#   # As root — installs systemd system service:
#   curl -fsSL https://raw.githubusercontent.com/MissyLabs/leyline/main/scripts/install.sh | sudo bash
#
#   # As regular user — installs to ~/leyline with a user systemd service:
#   curl -fsSL https://raw.githubusercontent.com/MissyLabs/leyline/main/scripts/install.sh | bash
#
#   # Seed node (either root or user):
#   curl ... | bash -s -- --seed
#
#   # Custom directory:
#   curl ... | LEYLINE_DIR=/srv/leyline bash
#
#   # Custom port:
#   curl ... | LEYLINE_PORT=9900 bash
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Config (override via environment)
# ---------------------------------------------------------------------------
IS_ROOT=$([ "$(id -u)" -eq 0 ] && echo true || echo false)

if [ "$IS_ROOT" = true ]; then
  LEYLINE_DIR="${LEYLINE_DIR:-/opt/leyline}"
  LEYLINE_USER="${LEYLINE_USER:-leyline}"
else
  LEYLINE_DIR="${LEYLINE_DIR:-$HOME/leyline}"
  LEYLINE_USER="$(whoami)"
fi

LEYLINE_PORT="${LEYLINE_PORT:-9876}"
LEYLINE_BRANCH="${LEYLINE_BRANCH:-main}"
LEYLINE_REPO="https://github.com/MissyLabs/leyline.git"
NODE_MIN_VERSION=20

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
# Pre-flight checks
# ---------------------------------------------------------------------------
info "Leyline node installer"
if [ "$IS_ROOT" = true ]; then
  info "Running as root — will install system-wide with a dedicated service user"
else
  info "Running as $LEYLINE_USER — will install to $LEYLINE_DIR with a user systemd service"
fi

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
    info "Node.js $(node -v) is too old (need >= $NODE_MIN_VERSION)"
  fi
  return 1
}

install_node_root() {
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
  if [ "$IS_ROOT" = true ]; then
    install_node_root
  else
    die "Node.js >= $NODE_MIN_VERSION not found. Install it first, or run this script as root to auto-install."
  fi
fi

need_cmd npm

# ---------------------------------------------------------------------------
# Create system user (root only)
# ---------------------------------------------------------------------------
if [ "$IS_ROOT" = true ]; then
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

if [ "$IS_ROOT" = true ]; then
  chown -R "$LEYLINE_USER:$LEYLINE_USER" "$LEYLINE_DIR"
fi

# ---------------------------------------------------------------------------
# Determine service name and args
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

  # Enable lingering so the service runs even when the user is not logged in
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$LEYLINE_USER" 2>/dev/null || true
  fi
}

if [ "$IS_ROOT" = true ]; then
  install_system_service
  CTL="systemctl"
else
  install_user_service
  CTL="systemctl --user"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
ok ""
ok "Leyline installed successfully!"
ok ""
ok "  Service:  $SERVICE_NAME"
ok "  Dir:      $LEYLINE_DIR"
ok "  Data:     $DATA_DIR"
ok "  Port:     $LEYLINE_PORT (TCP)"
ok "  Mode:     $([ "$IS_SEED" = true ] && echo "SEED NODE" || echo "regular node")"
ok "  User:     $LEYLINE_USER"
ok ""
ok "Commands:"
ok "  $CTL status $SERVICE_NAME    # check status"
ok "  journalctl $( [ "$IS_ROOT" = false ] && echo "--user " )-u $SERVICE_NAME -f    # tail logs"
ok "  $CTL restart $SERVICE_NAME   # restart"
ok "  $CTL stop $SERVICE_NAME      # stop"
ok ""
