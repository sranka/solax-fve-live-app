#!/bin/bash
# Install or update Solax FVE Monitor on Raspberry Pi.
# Run as root: sudo bash scripts/service/rpi-install.sh
set -euo pipefail

APP_DIR=/opt/solax-fve
SERVICE_NAME=solax-fve
SERVICE_USER=solax
ENV_FILE=/etc/default/solax-fve

# --- Helpers ---

info() { echo ">>> $*"; }
error() { echo "ERROR: $*" >&2; exit 1; }

# --- Checks ---

[ "$(id -u)" -eq 0 ] || error "This script must be run as root (use sudo)."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

[ -f "$SRC_DIR/scripts/dev-server.js" ] || error "Cannot find source files. Run from the project root or check paths."

# --- System user ---

if ! id "$SERVICE_USER" &>/dev/null; then
  info "Creating system user: $SERVICE_USER"
  adduser --system --group --no-create-home --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# --- Application files ---

info "Copying application files to $APP_DIR"
mkdir -p "$APP_DIR/scripts" "$APP_DIR/web"

cp "$SRC_DIR/scripts/dev-server.js"  "$APP_DIR/scripts/"
cp "$SRC_DIR/scripts/stamp-build.sh" "$APP_DIR/scripts/"
cp "$SRC_DIR/package.json"           "$APP_DIR/"

# Copy web directory (exclude build-info.js, it is generated at startup)
rsync -a --exclude='build-info.js' "$SRC_DIR/web/" "$APP_DIR/web/"

chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# --- Environment file ---

if [ ! -f "$ENV_FILE" ]; then
  info "Creating default environment file: $ENV_FILE"
  cat > "$ENV_FILE" <<'EOF'
# Solax FVE Monitor configuration
# Edit this file and restart the service: sudo systemctl restart solax-fve

PORT=8080

# Inverter connection — set at least one of PROXY_TARGET or MODBUS_TARGET
PROXY_TARGET=http://192.168.199.192
# MODBUS_TARGET=192.168.199.192:502

# Set MODBUS=1 to use Modbus TCP as the default protocol for POST /
MODBUS=1
EOF
  info "IMPORTANT: Edit $ENV_FILE to match your inverter IP address."
else
  info "Environment file $ENV_FILE already exists — preserving existing configuration."
fi

# --- systemd service ---

info "Installing systemd service"
cp "$SCRIPT_DIR/solax-fve.service" "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

info "Service installed and started."
echo ""
systemctl status "$SERVICE_NAME" --no-pager || true
echo ""
info "View logs: journalctl -u $SERVICE_NAME -f"
