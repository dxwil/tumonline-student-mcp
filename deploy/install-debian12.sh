#!/bin/bash
# Install the HTTP listener on a Debian 12 LXC. Run as root from a checkout:
#   sudo ./deploy/install-debian12.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root." >&2
  exit 1
fi

if [ ! -r /etc/os-release ]; then
  echo "This installer supports Debian." >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "debian" ]; then
  echo "This installer supports Debian." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="tumonline-mcp"
APP_DIR="/opt/tumonline-student-mcp"
STATE_DIR="/var/lib/tumonline-student-mcp"
ENV_FILE="/etc/tumonline-student-mcp.env"
UNIT_NAME="tumonline-student-mcp.service"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils tar

need_node() {
  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi
  local major
  major="$(node -p "Number(process.versions.node.split('.')[0])")"
  [ "$major" -lt 22 ]
}

install_node() {
  local arch node_arch tmp tarball
  arch="$(uname -m)"
  case "$arch" in
    x86_64) node_arch="linux-x64" ;;
    aarch64) node_arch="linux-arm64" ;;
    *)
      echo "Unsupported architecture: $arch" >&2
      exit 1
      ;;
  esac
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  tarball="$(grep -E "^[0-9a-f]{64}  node-v22[.][0-9]+[.][0-9]+-${node_arch}[.]tar[.]xz$" "$tmp/SHASUMS256.txt" | awk '{ print $2; exit }')"
  if [ -z "$tarball" ]; then
    echo "Could not find a Node.js 22 tarball for ${node_arch}." >&2
    exit 1
  fi
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/${tarball}" -o "$tmp/${tarball}"
  (
    cd "$tmp"
    grep -F "  ${tarball}" SHASUMS256.txt | sha256sum -c -
  )
  tar -C /usr/local --strip-components=1 -xJf "$tmp/${tarball}"
  rm -rf "$tmp"
  hash -r
  node --version
}

if need_node; then
  install_node
fi

if ! getent passwd "$APP_USER" >/dev/null; then
  useradd --system --user-group --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$STATE_DIR"

stage="$(mktemp -d)"
tar -C "$ROOT" \
  --exclude .git \
  --exclude node_modules \
  --exclude coverage \
  -cf - . | tar -C "$stage" -xf -

if systemctl is-active --quiet "$UNIT_NAME"; then
  systemctl stop "$UNIT_NAME"
fi
rm -rf "${APP_DIR}.new"
mkdir -p "${APP_DIR}.new"
tar -C "$stage" -cf - . | tar -C "${APP_DIR}.new" -xf -
rm -rf "$stage"
rm -rf "$APP_DIR"
mv "${APP_DIR}.new" "$APP_DIR"
chown -R root:root "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 755 {} +
find "$APP_DIR" -type f -exec chmod 644 {} +
chmod 755 "$APP_DIR/bin/tumonline-student-mcp"

install -m 644 "$ROOT/deploy/tumonline-student-mcp.service" "/etc/systemd/system/${UNIT_NAME}"
if [ ! -f "$ENV_FILE" ]; then
  install -m 640 -o root -g "$APP_USER" "$ROOT/deploy/tumonline-student-mcp.env.example" "$ENV_FILE"
fi

systemctl daemon-reload
systemctl enable "$UNIT_NAME"
systemctl restart "$UNIT_NAME"

echo "Service ${UNIT_NAME} is installed."
echo "Edit ${ENV_FILE}: set TUMONLINE_MCP_PUBLIC_URL, then restart the service."
echo "Give each person https://<your-domain>/mcp. They connect a Campus token from the MCP client. See docs/self-hosting.md."
