#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

bool_json() {
  if [ "$1" = "1" ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

query_param() {
  printf '%s' "$QUERY_STRING" | tr '&' '\n' | sed -n "s/^$1=//p" | head -n 1
}

clean_output() {
  printf '%s' "$1" | tr -d '\033' | sed 's/\[[0-9;]*m//g'
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

ACTION=$(query_param action)
case "$ACTION" in
  start|stop|restart|status)
    ;;
  *)
    printf '{"ok":false,"error":"Неизвестная команда для Xray"}'
    exit 0
    ;;
esac

OUTPUT=""
CODE=0
if [ "$ACTION" != "status" ]; then
  XRAY_SERVICE="/opt/etc/init.d/S24xray"
  if [ ! -f "$XRAY_SERVICE" ]; then
    printf '{"ok":false,"error":"Сервис Xray не найден","details":"/opt/etc/init.d/S24xray"}'
    exit 0
  fi
  if [ "$ACTION" = "start" ] || [ "$ACTION" = "restart" ]; then
    chmod 755 "$XRAY_SERVICE" >/dev/null 2>&1 || true
  fi
  if [ -x "$XRAY_SERVICE" ]; then
    OUTPUT=$("$XRAY_SERVICE" "$ACTION" 2>&1)
  else
    OUTPUT=$(sh "$XRAY_SERVICE" "$ACTION" 2>&1)
  fi
  CODE=$?
  if [ "$ACTION" = "stop" ]; then
    chmod 644 "$XRAY_SERVICE" >/dev/null 2>&1 || true
  fi
fi

XRAY_RUNNING=0
pidof xray >/dev/null 2>&1 && XRAY_RUNNING=1

XRAY_VERSION=""
if [ -x /opt/sbin/xray ]; then
  XRAY_VERSION=$(/opt/sbin/xray version 2>/dev/null | head -n 1)
fi

if [ "$CODE" -ne 0 ]; then
  printf '{'
  printf '"ok":false,'
  printf '"running":%s,' "$(bool_json "$XRAY_RUNNING")"
  printf '"error":"Команда %s завершилась с ошибкой",' "$(json_escape "$ACTION")"
  printf '"details":"%s"' "$(json_escape "$(clean_output "$OUTPUT")")"
  printf '}'
  exit 0
fi

MESSAGE="Статус Xray обновлён."
case "$ACTION" in
  start)
    MESSAGE="Xray запущен."
    ;;
  stop)
    MESSAGE="Xray остановлен."
    ;;
  restart)
    MESSAGE="Xray перезапущен."
    ;;
  status)
    if [ "$XRAY_RUNNING" = "1" ]; then
      MESSAGE="Xray сейчас запущен."
    else
      MESSAGE="Xray сейчас остановлен."
    fi
    ;;
esac

printf '{'
printf '"ok":true,'
printf '"action":"%s",' "$(json_escape "$ACTION")"
printf '"running":%s,' "$(bool_json "$XRAY_RUNNING")"
printf '"message":"%s",' "$(json_escape "$MESSAGE")"
printf '"version":"%s",' "$(json_escape "$XRAY_VERSION")"
printf '"details":"%s"' "$(json_escape "$(clean_output "$OUTPUT")")"
printf '}'
