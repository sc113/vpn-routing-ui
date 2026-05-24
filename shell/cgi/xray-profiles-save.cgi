#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH_HELPER=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)/bin/ui-paths.sh
[ -n "$PATH_HELPER" ] && . "$PATH_HELPER"

PROFILE_DIR="${VPN_ROUTING_UI_STATE_DIR:-/opt/etc/vpn-routing-ui}"
PROFILE_FILE="$PROFILE_DIR/profiles.json"
BACKUP_DIR="$PROFILE_DIR/backups"
TMP="/opt/tmp/vpn-routing-ui-profiles-$$.json"

mkdir -p "$PROFILE_DIR" "$BACKUP_DIR" /opt/tmp
cat > "$TMP"

if [ ! -s "$TMP" ]; then
  rm -f "$TMP"
  printf '{"ok":false,"error":"Пустое тело запроса"}'
  exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_PATH=""
if [ -f "$PROFILE_FILE" ]; then
  BACKUP_PATH="$BACKUP_DIR/profiles-$STAMP.json"
  cp "$PROFILE_FILE" "$BACKUP_PATH"
fi

cp "$TMP" "$PROFILE_FILE"
rm -f "$TMP"

printf '{'
printf '"ok":true,'
printf '"message":"Профили сохранены.",'
printf '"profilePath":"%s",' "$(json_escape "$PROFILE_FILE")"
printf '"backupPath":"%s"' "$(json_escape "$BACKUP_PATH")"
printf '}'
