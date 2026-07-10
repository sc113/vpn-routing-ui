#!/bin/sh

PATH=/opt/sbin:/opt/bin:/opt/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

query_param() {
  printf '%s' "$QUERY_STRING" | tr '&' '\n' | sed -n "s/^$1=//p" | head -n 1
}

bool_json() {
  if [ "$1" = "1" ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

now_epoch() {
  date +%s 2>/dev/null || echo 0
}

read_state() {
  UPDATE_STATUS="idle"
  UPDATE_STARTED="0"
  UPDATE_BACKUP=""
  UPDATE_MESSAGE="Обновление ещё не запускалось."
  if [ -s "$STATE_FILE" ]; then
    IFS='|' read -r UPDATE_STATUS UPDATE_STARTED UPDATE_BACKUP UPDATE_MESSAGE < "$STATE_FILE" || true
  fi
}

write_state() {
  status="$1"
  message="$2"
  tmp="$STATE_FILE.$$"
  printf '%s|%s||%s\n' "$status" "$(now_epoch)" "$message" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

print_state() {
  read_state
  running=0
  case "$UPDATE_STATUS" in
    queued|running) running=1 ;;
  esac
  started=$(printf '%s' "$UPDATE_STARTED" | tr -cd '0-9')
  [ -n "$started" ] || started=0
  printf '{'
  printf '"ok":true,'
  printf '"status":"%s",' "$(json_escape "$UPDATE_STATUS")"
  printf '"running":%s,' "$(bool_json "$running")"
  printf '"startedAt":%s,' "$started"
  printf '"backupPath":"%s",' "$(json_escape "$UPDATE_BACKUP")"
  printf '"message":"%s"' "$(json_escape "$UPDATE_MESSAGE")"
  printf '}'
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH_HELPER=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)/bin/ui-paths.sh
[ -r "$PATH_HELPER" ] && . "$PATH_HELPER"

STATE_DIR="${VPN_ROUTING_UI_STATE_DIR:-/opt/etc/vpn-routing-ui}"
STATE_FILE="$STATE_DIR/ui-update.state"
PID_FILE="$STATE_DIR/ui-update.pid"
LOCK_DIR="$STATE_DIR/ui-update.lock"
LOG_FILE="$STATE_DIR/ui-update.log"
UPDATE_HELPER="${VPN_ROUTING_UI_APP_DIR:-/opt/share/vpn-routing-ui}/bin/ui-update.sh"
ACTION=$(query_param action)

case "$ACTION" in
  ''|status)
    print_state
    exit 0
    ;;
  start)
    ;;
  *)
    printf '{"ok":false,"error":"Неизвестная команда обновления UI"}'
    exit 0
    ;;
esac

if [ "${REQUEST_METHOD:-GET}" != "POST" ]; then
  printf '{"ok":false,"error":"Запуск обновления требует POST-запрос"}'
  exit 0
fi

if [ -d "$LOCK_DIR" ]; then
  printf '{"ok":false,"error":"Обновление UI уже выполняется"}'
  exit 0
fi

if [ ! -x "$UPDATE_HELPER" ]; then
  printf '{"ok":false,"error":"Helper обновления UI не найден"}'
  exit 0
fi

if ! command -v start-stop-daemon >/dev/null 2>&1; then
  printf '{"ok":false,"error":"На роутере не найден start-stop-daemon"}'
  exit 0
fi

mkdir -p "$STATE_DIR"
rm -f "$PID_FILE"
write_state "queued" "Обновление поставлено в очередь."

if ! start-stop-daemon -S -b -m -p "$PID_FILE" -x "$UPDATE_HELPER" -O "$LOG_FILE"; then
  write_state "failed" "Не удалось запустить фоновое обновление."
  printf '{"ok":false,"error":"Не удалось запустить фоновое обновление"}'
  exit 0
fi

print_state
