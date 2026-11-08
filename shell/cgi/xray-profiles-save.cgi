#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

fail() {
  printf '{"ok":false,"error":"%s"}' "$1"
  exit 0
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

umask 077
mkdir -p "$PROFILE_DIR" "$BACKUP_DIR" || fail "Не удалось подготовить каталог профилей"
[ ! -d "$PROFILE_FILE" ] || fail "На месте файла профилей находится каталог"
TMP=$(mktemp "$PROFILE_DIR/.profiles.XXXXXX") || fail "Не удалось создать временный файл профилей"
trap 'rm -f "$TMP"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$TMP" || fail "Не удалось записать временный файл профилей"

if [ ! -s "$TMP" ]; then
  fail "Пустое тело запроса"
fi

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_PATH=""
if [ -f "$PROFILE_FILE" ]; then
  BACKUP_PATH="$BACKUP_DIR/profiles-$STAMP-$$.json"
  if ! cp "$PROFILE_FILE" "$BACKUP_PATH"; then
    rm -f "$BACKUP_PATH"
    fail "Не удалось создать резервную копию профилей"
  fi
fi

mv -f "$TMP" "$PROFILE_FILE" || fail "Не удалось заменить файл профилей"

printf '{'
printf '"ok":true,'
printf '"message":"Профили сохранены.",'
printf '"profilePath":"%s",' "$(json_escape "$PROFILE_FILE")"
printf '"backupPath":"%s"' "$(json_escape "$BACKUP_PATH")"
printf '}'
