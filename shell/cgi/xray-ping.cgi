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

json_number_or_null() {
  case "$1" in
    ''|*[!0-9]*) printf 'null' ;;
    *) printf '%s' "$1" ;;
  esac
}

query_param() {
  printf '%s' "$QUERY_STRING" | tr '&' '\n' | sed -n "s/^$1=//p" | head -n 1
}

monotonic_millis() {
  if [ -r /proc/uptime ]; then
    awk '{ printf "%.0f", $1 * 1000 }' /proc/uptime
  else
    date +%s000
  fi
}

looks_like_ip() {
  case "$1" in
    ''|*[!0-9A-Fa-f.:]*) return 1 ;;
    *) return 0 ;;
  esac
}

emit_result() {
  RESULT_OK="$1"
  RESULT_MESSAGE="$2"
  RESULT_DETAILS="$3"

  printf '{'
  printf '"ok":%s,' "$(bool_json "$RESULT_OK")"
  printf '"host":"%s",' "$(json_escape "$HOST")"
  printf '"port":"%s",' "$(json_escape "$PORT")"
  printf '"socksPort":"%s",' "$(json_escape "$SOCKS_PORT")"
  printf '"ip":"%s",' "$(json_escape "$IP")"
  printf '"loss":"%s",' "$(json_escape "$LOSS")"
  printf '"avgMs":"%s",' "$(json_escape "$AVG_MS")"
  printf '"icmpOk":%s,' "$(bool_json "$ICMP_OK")"
  printf '"tcpOk":%s,' "$(bool_json "$TCP_OK")"
  printf '"tcpMs":%s,' "$(json_number_or_null "$TCP_MS")"
  printf '"tcpMessage":"%s",' "$(json_escape "$TCP_MESSAGE")"
  printf '"proxyAttempted":%s,' "$(bool_json "$PROXY_ATTEMPTED")"
  printf '"proxyOk":%s,' "$(bool_json "$PROXY_OK")"
  printf '"proxyMs":%s,' "$(json_number_or_null "$PROXY_MS")"
  printf '"egressIp":"%s",' "$(json_escape "$EGRESS_IP")"
  printf '"proxyMessage":"%s",' "$(json_escape "$PROXY_MESSAGE")"
  printf '"message":"%s",' "$(json_escape "$RESULT_MESSAGE")"
  printf '"details":"%s"' "$(json_escape "$RESULT_DETAILS")"
  printf '}'
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

HOST=$(query_param host)
PORT=$(query_param port)
SOCKS_PORT=$(query_param socksPort)

case "$HOST" in
  ''|*[!A-Za-z0-9._:-]*)
    printf '{"ok":false,"error":"Некорректный адрес сервера"}'
    exit 0
    ;;
esac

case "$PORT" in
  ''|*[!0-9]*) PORT="" ;;
esac

case "$SOCKS_PORT" in
  '') ;;
  *[!0-9]*|0)
    printf '{"ok":false,"error":"Некорректный локальный SOCKS-порт"}'
    exit 0
    ;;
esac

if [ -n "$SOCKS_PORT" ] && [ "$SOCKS_PORT" -gt 65535 ]; then
  printf '{"ok":false,"error":"Некорректный локальный SOCKS-порт"}'
  exit 0
fi

PING_OUTPUT=$(/opt/bin/ping -c 3 -W 2 "$HOST" 2>&1)
PING_CODE=$?
ICMP_OK=0
[ "$PING_CODE" -eq 0 ] && ICMP_OK=1

IP=$(printf '%s\n' "$PING_OUTPUT" | sed -n '1s/.*(\([^)]*\)).*/\1/p' | head -n 1)
LOSS=$(printf '%s\n' "$PING_OUTPUT" | sed -n 's/.* \([0-9]\+%\) packet loss.*/\1/p' | head -n 1)
AVG_MS=$(printf '%s\n' "$PING_OUTPUT" | sed -n 's/.* = [0-9.]*\/\([0-9.]*\)\/[0-9.]*.*/\1/p' | head -n 1)

TCP_OK=0
TCP_MESSAGE=""
TCP_MS=""
if [ -n "$PORT" ] && [ -x /opt/bin/nc ]; then
  TCP_TMP="/opt/tmp/ping-nc-$$.log"
  TCP_STARTED=$(monotonic_millis)
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
  TCP_FINISHED=$(monotonic_millis)
  case "$TCP_STARTED:$TCP_FINISHED" in
    *[!0-9:]*|:) ;;
    *) TCP_MS=$((TCP_FINISHED - TCP_STARTED)) ;;
  esac

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

PROXY_ATTEMPTED=0
PROXY_OK=0
PROXY_MS=""
PROXY_MESSAGE=""
EGRESS_IP=""

if [ -n "$SOCKS_PORT" ]; then
  PROXY_ATTEMPTED=1
  if [ -x /opt/bin/curl ]; then
    PROXY_TMP="/opt/tmp/xray-probe-curl-$$.log"
    PROXY_STARTED=$(monotonic_millis)
    EGRESS_IP=$(/opt/bin/curl -sS --max-time 12 --connect-timeout 5 --socks5-hostname "127.0.0.1:$SOCKS_PORT" https://api.ipify.org 2>"$PROXY_TMP")
    PROXY_CODE=$?
    PROXY_FINISHED=$(monotonic_millis)
    case "$PROXY_STARTED:$PROXY_FINISHED" in
      *[!0-9:]*|:) ;;
      *) PROXY_MS=$((PROXY_FINISHED - PROXY_STARTED)) ;;
    esac
    EGRESS_IP=$(printf '%s' "$EGRESS_IP" | tr -d '\r\n')
    PROXY_ERROR=$(tr '\r\n' ' ' <"$PROXY_TMP" 2>/dev/null | head -c 240)
    rm -f "$PROXY_TMP"

    if [ "$PROXY_CODE" -eq 0 ] && looks_like_ip "$EGRESS_IP"; then
      PROXY_OK=1
      PROXY_MESSAGE="SOCKS :$SOCKS_PORT вывел трафик."
    elif [ "$PROXY_CODE" -eq 28 ]; then
      PROXY_MESSAGE="SOCKS :$SOCKS_PORT не ответил за 12 секунд."
    elif [ -n "$PROXY_ERROR" ]; then
      PROXY_MESSAGE="$PROXY_ERROR"
    else
      PROXY_MESSAGE="Не удалось вывести трафик через SOCKS :$SOCKS_PORT."
    fi
  else
    PROXY_MESSAGE="На роутере не найден /opt/bin/curl для проверки SOCKS."
  fi

  if [ "$PROXY_OK" -eq 1 ]; then
    emit_result 1 "Профиль вывел трафик через локальный SOCKS." ""
  else
    emit_result 0 "Профиль не вывел трафик через локальный SOCKS." "$PING_OUTPUT"
  fi
  exit 0
fi

if [ "$PING_CODE" -eq 0 ]; then
  emit_result 1 "ICMP ping до сервера успешен." ""
  exit 0
fi

MESSAGE="Сервер не ответил на ICMP ping. Это не всегда означает, что сам прокси недоступен."
if printf '%s' "$PING_OUTPUT" | grep -qi 'bad address'; then
  MESSAGE="Не удалось разрешить имя сервера."
fi

if [ "$TCP_OK" -eq 1 ]; then
  emit_result 1 "ICMP ping закрыт, но TCP-порт сервера доступен." ""
  exit 0
fi

emit_result 0 "$MESSAGE" "$PING_OUTPUT"
