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

SERVICE="/opt/etc/init.d/S99sing-box"
ACTION=$(query_param action)
case "$ACTION" in
  start|stop|restart|status)
    ;;
  *)
    printf '{"ok":false,"error":"Неизвестная команда для sing-box"}'
    exit 0
    ;;
esac

if [ ! -x "$SERVICE" ]; then
  printf '{"ok":false,"error":"Сервисный скрипт sing-box не найден"}'
  exit 0
fi

OUTPUT=""
CODE=0
if [ "$ACTION" != "status" ]; then
  OUTPUT=$("$SERVICE" "$ACTION" 2>&1)
  CODE=$?
fi

SINGBOX_RUNNING=0
pidof sing-box >/dev/null 2>&1 && SINGBOX_RUNNING=1
pidof sing-box-go >/dev/null 2>&1 && SINGBOX_RUNNING=1

SINGBOX_VERSION=""
if [ -x /opt/bin/sing-box ]; then
  SINGBOX_VERSION=$(/opt/bin/sing-box version 2>/dev/null | head -n 1)
elif [ -x /opt/sbin/sing-box ]; then
  SINGBOX_VERSION=$(/opt/sbin/sing-box version 2>/dev/null | head -n 1)
elif [ -x /opt/bin/sing-box-go ]; then
  SINGBOX_VERSION=$(/opt/bin/sing-box-go version 2>/dev/null | head -n 1)
elif [ -x /opt/sbin/sing-box-go ]; then
  SINGBOX_VERSION=$(/opt/sbin/sing-box-go version 2>/dev/null | head -n 1)
fi

if [ "$CODE" -ne 0 ]; then
  printf '{'
  printf '"ok":false,'
  printf '"running":%s,' "$(bool_json "$SINGBOX_RUNNING")"
  printf '"error":"Команда %s завершилась с ошибкой",' "$(json_escape "$ACTION")"
  printf '"details":"%s"' "$(json_escape "$(clean_output "$OUTPUT")")"
  printf '}'
  exit 0
fi

MESSAGE="Статус sing-box обновлён."
case "$ACTION" in
  start)
    MESSAGE="sing-box запущен."
    ;;
  stop)
    MESSAGE="sing-box остановлен."
    ;;
  restart)
    MESSAGE="sing-box перезапущен."
    ;;
  status)
    if [ "$SINGBOX_RUNNING" = "1" ]; then
      MESSAGE="sing-box сейчас запущен."
    else
      MESSAGE="sing-box сейчас остановлен."
    fi
    ;;
esac

printf '{'
printf '"ok":true,'
printf '"action":"%s",' "$(json_escape "$ACTION")"
printf '"running":%s,' "$(bool_json "$SINGBOX_RUNNING")"
printf '"message":"%s",' "$(json_escape "$MESSAGE")"
printf '"version":"%s",' "$(json_escape "$SINGBOX_VERSION")"
printf '"details":"%s"' "$(json_escape "$(clean_output "$OUTPUT")")"
printf '}'
