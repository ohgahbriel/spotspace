#!/usr/bin/env bash
# Sets up SpotSpace as a systemd service on a fresh Oracle Cloud "Always Free" VM.
#
# Assumes:
#   - The SpotSpace code is already at /opt/spotspace on this machine
#     (git clone or scp/rsync it there first).
#   - You're running this as root (or via sudo) on the VM itself.
#   - You've already opened the port in Oracle's cloud-level firewall
#     (Security List / Network Security Group) — this script only handles
#     the OS-level firewall, which is the *other* half of Oracle's two-layer
#     networking. Both need to allow the port or nothing will connect.
#
# Usage: sudo bash setup-oracle-vm.sh [port]
set -euo pipefail

PORT="${1:-5075}"
APP_DIR="/opt/spotspace"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (sudo bash setup-oracle-vm.sh)" >&2
  exit 1
fi
if [ ! -f "$APP_DIR/server.js" ]; then
  echo "Expected the SpotSpace code at $APP_DIR/server.js — copy it there first." >&2
  exit 1
fi

echo "== Installing Node.js (if missing) =="
if ! command -v node >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
  else
    echo "Unrecognized package manager — install Node.js 20+ manually, then re-run this script." >&2
    exit 1
  fi
else
  echo "Node.js already installed: $(node --version)"
fi

echo "== Creating dedicated 'spotspace' system user =="
if ! id spotspace >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin spotspace
fi
mkdir -p "$APP_DIR/library"
chown -R spotspace:spotspace "$APP_DIR"

echo "== Opening port $PORT in the OS firewall =="
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${PORT}/tcp"
  firewall-cmd --reload
elif command -v ufw >/dev/null 2>&1; then
  ufw allow "${PORT}/tcp"
else
  echo "No firewalld/ufw found — if you're using raw iptables, allow TCP $PORT manually:"
  echo "  iptables -I INPUT -p tcp --dport $PORT -j ACCEPT"
fi

echo "== Installing systemd service =="
sed "s/PORT=5075/PORT=${PORT}/" "$APP_DIR/deploy/spotspace.service" > /etc/systemd/system/spotspace.service
systemctl daemon-reload
systemctl enable spotspace
systemctl restart spotspace

sleep 1
echo "== Status =="
systemctl --no-pager status spotspace || true
echo
echo "If 'active (running)' above, and Oracle's Security List / Network Security"
echo "Group also allows TCP $PORT from 0.0.0.0/0, SpotSpace should now be reachable at:"
echo "  http://<this-VM's-public-IP>:${PORT}"
echo
echo "Logs:    journalctl -u spotspace -f"
echo "Restart: systemctl restart spotspace"
