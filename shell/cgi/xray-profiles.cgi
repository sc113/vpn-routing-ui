#!/bin/sh

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH_HELPER=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)/bin/ui-paths.sh
[ -n "$PATH_HELPER" ] && . "$PATH_HELPER"

PROFILE_DIR="${VPN_ROUTING_UI_STATE_DIR:-/opt/etc/vpn-routing-ui}"
PROFILE_FILE="$PROFILE_DIR/profiles.json"

mkdir -p "$PROFILE_DIR"

if [ -s "$PROFILE_FILE" ]; then
  cat "$PROFILE_FILE"
else
  printf '{"version":1,"profiles":[]}'
fi
