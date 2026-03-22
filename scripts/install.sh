#!/usr/bin/env bash
#
# Leyline node installer — curl-installable bootstrap script.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/MissyLabs/leyline/main/scripts/install.sh | bash
#
#   # Install as a seed node:
#   curl -fsSL https://raw.githubusercontent.com/MissyLabs/leyline/main/scripts/install.sh | bash -s -- --seed
#
#   # Install to a custom directory:
#   curl -fsSL https://raw.githubusercontent.com/MissyLabs/leyline/main/scripts/install.sh | LEYLINE_DIR=/opt/leyline bash
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Config (override via environment)
# ---------------------------------------------------------------------------
LEYLINE_DIR="${LEYLINE_DIR:-/opt/leyline}"
LEYLINE_USER="${LEYLINE_USER:-leyline}"
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
err()   { echo -e "\033[1;31m[leyline]\033[0m $*" >&2; }
die()   { err "$@"; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
info "Leyline node installer"

# Must be root for systemd service install
if [ "$(id -u)" -ne 0 ]; then
  die "Please run as root (or with sudo)"
fi

need_cmd git
need_cmd curl

# ---------------------------------------------------------------------------
# Ensure Node.js >= 20
# ---------------------------------------------------------------------------
install_node() {
  if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -ge "$NODE_MIN_VERSION" ]; then
      info "Node.js $(node -v) found"
      return 0
    fi
    info "Node.js $(node -v) is too old (need >= $NODE_MIN_VERSION)"
  fi

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

install_node

# ---------------------------------------------------------------------------
# Create system user
# ---------------------------------------------------------------------------
if ! id "$LEYLINE_USER" >/dev/null 2>&1; then
  info "Creating system user: $LEYLINE_USER"
  useradd --system --home-dir "$LEYLINE_DIR" --shell /usr/sbin/nologin "$LEYLINE_USER"
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
npm ci --production=false

info "Building..."
npm run build

# ---------------------------------------------------------------------------
# Create data directory
# ---------------------------------------------------------------------------
DATA_DIR="$LEYLINE_DIR/data"
mkdir -p "$DATA_DIR"
chown -R "$LEYLINE_USER:$LEYLINE_USER" "$LEYLINE_DIR"

# ---------------------------------------------------------------------------
# Write systemd unit
# ---------------------------------------------------------------------------
if [ "$IS_SEED" = true ]; then
  SERVICE_NAME="leyline-seed"
  EXEC_ARGS="--seed"
  DESCRIPTION="Leyline P2P seed node"
else
  SERVICE_NAME="leyline"
  EXEC_ARGS=""
  DESCRIPTION="Leyline P2P node"
fi

info "Installing systemd service: $SERVICE_NAME"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=$DESCRIPTION
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$LEYLINE_USER
Group=$LEYLINE_USER
WorkingDirectory=$LEYLINE_DIR
ExecStart=$(command -v node) dist/cli.js $EXEC_ARGS
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
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
ok ""
ok "Leyline installed successfully!"
ok ""
ok "  Service:  $SERVICE_NAME"
ok "  Dir:      $LEYLINE_DIR"
ok "  Data:     $DATA_DIR"
ok "  Mode:     $([ "$IS_SEED" = true ] && echo "SEED NODE" || echo "regular node")"
ok ""
ok "Commands:"
ok "  systemctl status $SERVICE_NAME    # check status"
ok "  journalctl -u $SERVICE_NAME -f    # tail logs"
ok "  systemctl restart $SERVICE_NAME   # restart"
ok "  systemctl stop $SERVICE_NAME      # stop"
ok ""
