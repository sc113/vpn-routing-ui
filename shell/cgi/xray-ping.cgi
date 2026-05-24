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

HOST=$(query_param host)
PORT=$(query_param port)

case "$HOST" in
  ''|*[!A-Za-z0-9._:-]*)
    printf '{"ok":false,"error":"Некорректный адрес сервера"}'
    exit 0
    ;;
esac

case "$PORT" in
  ''|*[!0-9]*)
    PORT=""
    ;;
esac

PING_OUTPUT=$(/opt/bin/ping -c 3 -W 2 "$HOST" 2>&1)
PING_CODE=$?

IP=$(printf '%s\n' "$PING_OUTPUT" | sed -n '1s/.*(\([^)]*\)).*/\1/p' | head -n 1)
LOSS=$(printf '%s\n' "$PING_OUTPUT" | sed -n 's/.* \([0-9]\+%\) packet loss.*/\1/p' | head -n 1)
AVG_MS=$(printf '%s\n' "$PING_OUTPUT" | sed -n 's/.* = [0-9.]*\/\([0-9.]*\)\/[0-9.]*.*/\1/p' | head -n 1)
TCP_OK=0
TCP_MESSAGE=""
TCP_OUTPUT=""

if [ -n "$PORT" ] && [ -x /opt/bin/nc ]; then
  TCP_TMP="/opt/tmp/ping-nc-$$.log"
  /opt/bin/nc "$HOST" "$PORT" </dev/null >"$TCP_TMP" 2>&1 &
  TCP_PID=$!
  (
    sleep 4
    kill "$TCP_PID" >/dev/null 2>&1
  ) &
  WATCH_PID=$!
  wait "$TCP_PID"
  TCP_CODE=$?
  kill "$WATCH_PID" >/dev/null 2>&1
  wait "$WATCH_PID" 2>/dev/null
  TCP_OUTPUT=$(cat "$TCP_TMP" 2>/dev/null)
  rm -f "$TCP_TMP"

  if [ "$TCP_CODE" -eq 0 ]; then
    TCP_OK=1
    TCP_MESSAGE="TCP $PORT отвечает."
  elif [ "$TCP_CODE" -eq 143 ] || [ "$TCP_CODE" -eq 137 ]; then
    TCP_MESSAGE="TCP $PORT не ответил за отведённое время."
  elif [ -n "$TCP_OUTPUT" ]; then
    TCP_MESSAGE="$TCP_OUTPUT"
  else
    TCP_MESSAGE="TCP $PORT недоступен."
  fi
fi

if [ "$PING_CODE" -eq 0 ]; then
  printf '{'
  printf '"ok":true,'
  printf '"host":"%s",' "$(json_escape "$HOST")"
  printf '"port":"%s",' "$(json_escape "$PORT")"
  printf '"ip":"%s",' "$(json_escape "$IP")"
  printf '"loss":"%s",' "$(json_escape "$LOSS")"
  printf '"avgMs":"%s",' "$(json_escape "$AVG_MS")"
  printf '"tcpOk":%s,' "$([ "$TCP_OK" -eq 1 ] && printf true || printf false)"
  printf '"tcpMessage":"%s",' "$(json_escape "$TCP_MESSAGE")"
  printf '"message":"Пинг до сервера успешен."'
  printf '}'
  exit 0
fi

MESSAGE="Сервер не ответил на ICMP ping. Это не всегда означает, что сам прокси недоступен."
if printf '%s' "$PING_OUTPUT" | grep -qi 'bad address'; then
  MESSAGE="Не удалось разрешить имя сервера."
fi

if [ "$TCP_OK" -eq 1 ]; then
  MESSAGE="ICMP ping закрыт, но TCP-порт сервера доступен."
  printf '{'
  printf '"ok":true,'
  printf '"host":"%s",' "$(json_escape "$HOST")"
  printf '"port":"%s",' "$(json_escape "$PORT")"
  printf '"ip":"%s",' "$(json_escape "$IP")"
  printf '"loss":"%s",' "$(json_escape "$LOSS")"
  printf '"avgMs":"%s",' "$(json_escape "$AVG_MS")"
  printf '"tcpOk":true,'
  printf '"tcpMessage":"%s",' "$(json_escape "$TCP_MESSAGE")"
  printf '"message":"%s"' "$(json_escape "$MESSAGE")"
  printf '}'
  exit 0
fi

printf '{'
printf '"ok":false,'
printf '"host":"%s",' "$(json_escape "$HOST")"
printf '"port":"%s",' "$(json_escape "$PORT")"
printf '"ip":"%s",' "$(json_escape "$IP")"
printf '"loss":"%s",' "$(json_escape "$LOSS")"
printf '"avgMs":"%s",' "$(json_escape "$AVG_MS")"
printf '"tcpOk":false,'
printf '"tcpMessage":"%s",' "$(json_escape "$TCP_MESSAGE")"
printf '"message":"%s",' "$(json_escape "$MESSAGE")"
printf '"details":"%s"' "$(json_escape "$PING_OUTPUT")"
printf '}'
