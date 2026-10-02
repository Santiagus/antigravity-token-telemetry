#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$HOME/.gemini/config/plugins/antigravity-token-telemetry"

echo "=========================================================="
echo "🚀 Antigravity Token Telemetry Installer"
echo "=========================================================="

# 1. Build VSIX
echo "📦 Building VS Code extension package (.vsix)..."
python3 "$REPO_DIR/scripts/build_vsix.py"

# 2. Install Antigravity Global Hook / Plugin
echo "⚙️  Installing Antigravity global plugin..."
mkdir -p "$PLUGIN_DIR"
cp "$REPO_DIR/hook/plugin.json" "$PLUGIN_DIR/plugin.json"
cp "$REPO_DIR/hook/hooks.json" "$PLUGIN_DIR/hooks.json"
cp "$REPO_DIR/hook/log_tokens.py" "$PLUGIN_DIR/log_tokens.py"
chmod +x "$PLUGIN_DIR/log_tokens.py"

# Initialize telemetry baseline
echo "{}" | python3 "$PLUGIN_DIR/log_tokens.py" 2>/dev/null || true
echo "✅ Global Antigravity lifecycle hook installed to: $PLUGIN_DIR"

# 3. Install VS Code extension
VSIX_FILE="$(ls -1t "$REPO_DIR"/dist/*.vsix 2>/dev/null | head -n 1)"
if command -v code &>/dev/null; then
    echo "🔌 Installing extension into VS Code..."
    code --install-extension "$VSIX_FILE" --force
    echo "✅ Extension installed successfully in VS Code!"
else
    echo "💡 Note: 'code' CLI not found in PATH."
    echo "   To install the extension manually in VS Code:"
    echo "   1. Press Ctrl+Shift+P (Cmd+Shift+P on Mac)"
    echo "   2. Run: 'Extensions: Install from VSIX...'"
    echo "   3. Select: $VSIX_FILE"
fi

echo "=========================================================="
echo "🎉 Setup complete! Restart VS Code or reload window to view live status."
echo "=========================================================="
