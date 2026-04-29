#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# matterbridge-ecovacs — installation helper
#
# Usage:
#   chmod +x install.sh
#   ./install.sh
#
# This script:
#   1. Clones (or updates) the plugin into ~/matterbridge-ecovacs
#   2. Installs npm dependencies
#   3. Builds the TypeScript source
#   4. Registers the plugin with your global Matterbridge install
#   5. Prints next steps
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PLUGIN_DIR="$HOME/matterbridge-ecovacs"
PLUGIN_NAME="matterbridge-ecovacs"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     matterbridge-ecovacs  installer          ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. Node.js version check ──────────────────────────────────────────────────
NODE_VER=$(node --version 2>/dev/null || echo "none")
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_VER" = "none" ] || [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌  Node.js ≥ 20 required. Found: $NODE_VER"
  echo "    Install: https://nodejs.org/en/download/"
  exit 1
fi
echo "✅  Node.js $NODE_VER"

# ── 2. Matterbridge check ─────────────────────────────────────────────────────
if ! command -v matterbridge &>/dev/null; then
  echo "❌  Matterbridge not found. Install it first:"
  echo "    npm install -g matterbridge"
  exit 1
fi
MB_VER=$(matterbridge --version 2>/dev/null || echo "unknown")
echo "✅  Matterbridge $MB_VER"

# ── 3. Plugin directory ───────────────────────────────────────────────────────
if [ -d "$PLUGIN_DIR" ]; then
  echo "📁  Updating existing plugin directory: $PLUGIN_DIR"
  cd "$PLUGIN_DIR"
  # If it's a git repo, pull; otherwise just re-build
  git pull 2>/dev/null && echo "   git pull OK" || echo "   (not a git repo, skipping pull)"
else
  echo "📁  Creating plugin directory: $PLUGIN_DIR"
  cp -r "$(dirname "$0")" "$PLUGIN_DIR" 2>/dev/null || {
    echo "⚠️  Could not copy files automatically."
    echo "   Please copy the plugin folder to $PLUGIN_DIR manually."
    exit 1
  }
  cd "$PLUGIN_DIR"
fi

# ── 4. Install dependencies ───────────────────────────────────────────────────
echo ""
echo "📦  Installing npm dependencies..."
npm install --omit=dev
echo "✅  Dependencies installed"

# ── 5. Build ──────────────────────────────────────────────────────────────────
echo ""
echo "🔨  Building TypeScript..."
npm run build
echo "✅  Build complete"

# ── 6. Register with Matterbridge ────────────────────────────────────────────
echo ""
echo "🔌  Registering plugin with Matterbridge..."
matterbridge --add "$PLUGIN_DIR" || {
  echo "⚠️  Could not register automatically."
  echo "   Run manually: matterbridge --add $PLUGIN_DIR"
}

# ── 7. Next steps ─────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ✅  Installation complete!                  ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo ""
echo "  1. Make sure Matterbridge is in CHILDBRIDGE mode:"
echo "     matterbridge --childbridge"
echo "     (or set it in the Matterbridge UI → Settings → Bridge Mode)"
echo ""
echo "  2. Open the Matterbridge UI (http://your-device-ip:8283)"
echo "     → Plugins → $PLUGIN_NAME → Configure"
echo ""
echo "  3. Enter your Ecovacs credentials:"
echo "     email       : your Ecovacs account email"
echo "     password    : your Ecovacs password"
echo "     countryCode : IT (or DE, FR, US, UK, …)"
echo ""
echo "  4. Restart Matterbridge"
echo ""
echo "  5. In Apple Home → tap + → Add Accessory"
echo "     → Scan the QR code shown in the Matterbridge UI"
echo "     → Accept 'Uncertified Accessory' → Done"
echo ""
echo "Your Deebot will appear in Apple Home as a vacuum you can"
echo "control with Siri, automations, and scenes. 🤖"
echo ""
