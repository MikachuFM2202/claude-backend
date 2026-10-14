#!/bin/sh
# Keep the office server running on this Mac (starts at login, restarts if it stops).
# Remove with: scripts/install-agent.sh --remove
set -eu
LABEL=dev.clawd-mifflin
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--remove" ]; then rm -f "$PLIST"; echo "removed $LABEL"; exit 0; fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/clawd-mifflin.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/clawd-mifflin.log</string>
</dict></plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL: http://127.0.0.1:4717 (log: ~/Library/Logs/clawd-mifflin.log)"
