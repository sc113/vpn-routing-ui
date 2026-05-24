#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

query_param() {
  printf '%s' "$QUERY_STRING" | tr '&' '\n' | sed -n "s/^$1=//p" | head -n 1
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

PORT=$(query_param port)
case "$PORT" in
  ''|*[!0-9]*)
    printf '{"ok":false,"error":"Некорректный порт"}'
    exit 0
    ;;
esac

IP=$(/opt/bin/curl -s --max-time 12 --socks5-hostname "127.0.0.1:$PORT" https://api.ipify.org 2>/dev/null)
if [ -n "$IP" ]; then
  printf '{"ok":true,"ip":"%s"}' "$(json_escape "$IP")"
else
  printf '{"ok":false,"error":"Не удалось получить внешний IP через socks-порт %s"}' "$(json_escape "$PORT")"
fi
