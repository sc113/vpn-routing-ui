#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

TMP="/opt/tmp/singbox-ui-save-$$.json"
CONFIG="/opt/etc/sing-box/config.json"
BACKUP_DIR="/opt/etc/sing-box/backups"
SERVICE="/opt/etc/init.d/S99sing-box"
SINGBOX_BIN=""

if [ -x /opt/bin/sing-box ]; then
  SINGBOX_BIN="/opt/bin/sing-box"
elif [ -x /opt/sbin/sing-box ]; then
  SINGBOX_BIN="/opt/sbin/sing-box"
fi

if [ -z "$SINGBOX_BIN" ]; then
  printf '{"ok":false,"error":"sing-box не найден в системе"}'
  exit 0
fi

if [ ! -x "$SERVICE" ]; then
  printf '{"ok":false,"error":"Сервисный скрипт sing-box не найден"}'
  exit 0
fi

mkdir -p /opt/tmp "$BACKUP_DIR"
cat > "$TMP"

singbox_running() {
  pidof sing-box >/dev/null 2>&1 || pidof sing-box-go >/dev/null 2>&1
}

restart_or_start_singbox() {
  output=$("$SERVICE" restart 2>&1)
  code=$?
  if [ "$code" -ne 0 ] || ! singbox_running; then
    output=$(printf '%s\n%s' "$output" "$("$SERVICE" start 2>&1)")
    code=$?
  fi
  RESTART_OUTPUT="$output"
  RESTART_CODE=$code
}

if [ ! -s "$TMP" ]; then
  rm -f "$TMP"
  printf '{"ok":false,"error":"Пустое тело запроса"}'
  exit 0
fi

VALIDATE_OUTPUT=$("$SINGBOX_BIN" check -c "$TMP" 2>&1)
VALIDATE_CODE=$?
if [ "$VALIDATE_CODE" -ne 0 ]; then
  rm -f "$TMP"
  printf '{"ok":false,"error":"Проверка конфига sing-box не прошла","details":"%s"}' "$(json_escape "$VALIDATE_OUTPUT")"
  exit 0
fi

if [ -f "$CONFIG" ] && cmp -s "$TMP" "$CONFIG"; then
  rm -f "$TMP"
  MESSAGE="Конфиг sing-box не изменился, перезапуск не нужен."
  if ! singbox_running; then
    restart_or_start_singbox
    if [ "$RESTART_CODE" -ne 0 ] || ! singbox_running; then
      printf '{"ok":false,"error":"Конфиг sing-box не изменился, но сервис не удалось запустить","details":"%s"}' "$(json_escape "$RESTART_OUTPUT")"
      exit 0
    fi
    MESSAGE="Конфиг sing-box не изменился, но сервис был остановлен и запущен заново."
  fi
  printf '{'
  printf '"ok":true,'
  printf '"unchanged":true,'
  printf '"message":"%s",' "$(json_escape "$MESSAGE")"
  printf '"backupPath":"",'
  printf '"details":"%s"' "$(json_escape "$VALIDATE_OUTPUT")"
  printf '}'
  exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_PATH=""
if [ -f "$CONFIG" ]; then
  BACKUP_PATH="$BACKUP_DIR/config-$STAMP.json"
  cp "$CONFIG" "$BACKUP_PATH"
fi

cp "$TMP" "$CONFIG"
rm -f "$TMP"

restart_or_start_singbox
if [ "$RESTART_CODE" -ne 0 ]; then
  if [ -n "$BACKUP_PATH" ] && [ -f "$BACKUP_PATH" ]; then
    cp "$BACKUP_PATH" "$CONFIG"
    "$SERVICE" restart >/dev/null 2>&1
  fi
  printf '{"ok":false,"error":"Не удалось перезапустить sing-box","details":"%s"}' "$(json_escape "$RESTART_OUTPUT")"
  exit 0
fi

printf '{'
printf '"ok":true,'
printf '"message":"Конфиг sing-box сохранён, проверен и сервис перезапущен.",'
printf '"backupPath":"%s",' "$(json_escape "$BACKUP_PATH")"
printf '"details":"%s"' "$(json_escape "$VALIDATE_OUTPUT")"
printf '}'
