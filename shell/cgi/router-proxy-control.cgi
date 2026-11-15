#!/bin/sh

json_escape() {
  printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' |
    sed ':a;$!N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\t/\\t/g;s/\r/\\r/g;s/\n/\\n/g'
}

cleanup() {
  if [ "$ENABLE_PENDING" = "1" ]; then
    run_ndmc "interface $proxy_id down" || true
  fi
  rm -f /tmp/router-proxy-control.$$ /tmp/router-proxy-control-netstat.$$ /tmp/router-proxy-control-running.$$ "$SHOW_FILE" 2>/dev/null
  if [ "${LOCK_HELD:-0}" = "1" ]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null
  fi
}

fail() {
  printf '{"ok":false,"error":"%s","details":"%s"}' "$(json_escape "$1")" "$(json_escape "$2")"
  exit 0
}

run_ndmc() {
  ndmc -c "$1" </dev/null >/tmp/router-proxy-control.$$ 2>&1
  result=$?
  CMD_OUTPUT=$(cat /tmp/router-proxy-control.$$ 2>/dev/null)
  case "$CMD_OUTPUT" in
    *"error["*) return 1 ;;
  esac
  return "$result"
}

get_query_value() {
  key="$1"
  printf '%s' "$QUERY_STRING" | tr '&' '\n' | awk -F'=' -v wanted="$key" '$1 == wanted { print $2; exit }'
}

sanitize_stream() {
  tr -d '\033' | sed 's/\[[0-9;]*[A-Za-z]//g'
}

proxy_configured_up() {
  target_proxy="$1"
  ndmc -c 'show running-config' 2>/tmp/router-proxy-control-running.$$ | sanitize_stream | awk -v wanted="$target_proxy" '
    $1 == "interface" && $2 == wanted {
      in_block = 1
      next
    }
    in_block && $1 == "!" {
      exit(found ? 0 : 1)
    }
    in_block && $1 == "up" {
      found = 1
    }
    END {
      exit(found ? 0 : 1)
    }
  '
  code=$?
  rm -f /tmp/router-proxy-control-running.$$
  return $code
}

proxy_upstream_port() {
  target_proxy="$1"
  if [ -s "$MAP_FILE" ]; then
    awk -F'|' -v wanted="$target_proxy" '$2 == wanted { print $5; exit }' "$MAP_FILE"
    return 0
  fi
  ndmc -c 'show running-config' 2>/tmp/router-proxy-control-running.$$ | sanitize_stream | awk -v wanted="$target_proxy" '
    $1 == "interface" && $2 == wanted {
      in_block = 1
      next
    }
    in_block && $1 == "!" {
      exit
    }
    in_block && $1 == "proxy" && $2 == "upstream" {
      print $4
      exit
    }
  '
  rm -f /tmp/router-proxy-control-running.$$
}

loopback_connection_count() {
  wanted_port=$(printf '%s' "$1" | tr -cd '0-9')
  [ -n "$wanted_port" ] || {
    printf '0'
    return 0
  }
  netstat -an 2>/dev/null > /tmp/router-proxy-control-netstat.$$ || true
  awk -v port=":$wanted_port" '
    $1 ~ /^tcp/ && $5 ~ (port "$") && $4 ~ /127[.]0[.]0[.]1:/ && $6 != "LISTEN" {
      count++
    }
    END { print count + 0 }
  ' /tmp/router-proxy-control-netstat.$$
  rm -f /tmp/router-proxy-control-netstat.$$
}

hev_pid_for_proxy() {
  proxy_index=$(printf '%s' "$1" | sed 's/^Proxy//')
  ps | awk -v cfg="/var/run/proxy-cfg-t2s$proxy_index" '$0 ~ cfg && $0 ~ /hev-socks5-tunnel/ { print $1; exit }'
}

kill_hev_for_proxy() {
  proxy_id="$1"
  pid=$(hev_pid_for_proxy "$proxy_id")
  [ -n "$pid" ] || return 0
  kill "$pid" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
}

show_value() {
  file_path="$1"
  key_name="$2"
  awk -F: -v wanted="$key_name" '
    {
      key = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key == wanted) {
        value = substr($0, index($0, ":") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        print value
        exit
      }
    }
  ' "$file_path"
}

read_proxy_show() {
  proxy_id="$1"
  if ! ndmc -c "show interface $proxy_id" 2>/tmp/router-proxy-control-show.$$ | sanitize_stream > "$SHOW_FILE"; then
    cat /tmp/router-proxy-control-show.$$ 2>/dev/null | sanitize_stream > "$SHOW_FILE"
  fi
  rm -f /tmp/router-proxy-control-show.$$
}

wait_proxy_ready() {
  proxy_id="$1"
  attempts=0
  ready_seen=0
  while [ "$attempts" -lt 20 ]; do
    attempts=$((attempts + 1))
    sleep 1
    read_proxy_show "$proxy_id"
    link_state=$(show_value "$SHOW_FILE" "link")
    connected_state=$(show_value "$SHOW_FILE" "connected")
    ctrl_state=$(show_value "$SHOW_FILE" "ctrl")
    if [ "$link_state" = "up" ] && [ "$connected_state" = "yes" ] && [ "$ctrl_state" = "running" ] && [ -n "$(hev_pid_for_proxy "$proxy_id")" ]; then
      ready_seen=$((ready_seen + 1))
      if [ "$attempts" -ge 5 ] && [ "$ready_seen" -ge 2 ]; then
        return 0
      fi
    else
      ready_seen=0
    fi
  done
  return 1
}

process_is_running() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac

  ps | awk -v pid="$1" '$1 == pid { found = 1 } END { exit(found ? 0 : 1) }'
}

cpu_sample() {
  awk '$1 == "cpu" { printf "%.0f %.0f\n", $2+$3+$4+$5+$6+$7+$8+$9, $5+$6; exit }' /proc/stat
}

cpu_percent() {
  awk -v before="$1" -v after="$2" 'BEGIN {
    split(before, b, " "); split(after, a, " ")
    total = a[1] - b[1]
    printf "%d\n", total > 0 ? 100 * (total - (a[2] - b[2])) / total : 0
  }'
}

watch_enabled_proxy() {
  sample=$(cpu_sample)
  intervals=0
  busy_intervals=0
  while [ "$intervals" -lt 10 ]; do
    sleep 2
    next_sample=$(cpu_sample)
    usage=$(cpu_percent "$sample" "$next_sample")
    sample="$next_sample"
    loopback_after=$(loopback_connection_count "$upstream_port")
    if [ "$usage" -ge 90 ]; then
      busy_intervals=$((busy_intervals + 1))
    else
      busy_intervals=0
    fi
    if [ "$busy_intervals" -ge 2 ] || [ "$loopback_after" -ge 200 ]; then
      enable_failure="Высокая нагрузка ($usage% CPU, $loopback_after локальных SOCKS-соединений)."
      return 1
    fi
    intervals=$((intervals + 1))
  done
  read_proxy_show "$proxy_id"
  if [ "$(show_value "$SHOW_FILE" link)" = "up" ] &&
     [ "$(show_value "$SHOW_FILE" connected)" = "yes" ] &&
     [ "$(show_value "$SHOW_FILE" ctrl)" = "running" ]; then
    return 0
  fi
  enable_failure="Keenetic не подтвердил подключение за 20 секунд."
  return 1
}

enable_proxy() {
  [ "$REQUEST_METHOD" = "POST" ] || fail "Для включения интерфейса требуется POST" ""
  awk -F'|' -v wanted="$proxy_id" '$2 == wanted && $4 == "1" { found=1 } END { exit !found }' "$MAP_FILE" ||
    fail "Для этого интерфейса нет включённого профиля" "Включите профиль в списке ключей."
  read_proxy_show "$proxy_id"
  [ "$(show_value "$SHOW_FILE" state)" = "down" ] ||
    fail "Интерфейс уже включён или его состояние неизвестно" "Обновите состояние ProxyN."
  upstream_port=$(proxy_upstream_port "$proxy_id" | tr -cd '0-9')
  [ -n "$upstream_port" ] && curl -fsS --connect-timeout 3 --max-time 5 \
    --socks5-hostname "127.0.0.1:$upstream_port" -o /dev/null https://api.ipify.org 2>/dev/null ||
    fail "HTTPS через ключ не прошёл" "Проверьте профиль или выберите другой для DNS-маршрутов."
  sample=$(cpu_sample)
  sleep 2
  usage=$(cpu_percent "$sample" "$(cpu_sample)")
  [ "$usage" -lt 90 ] || fail "Роутер уже перегружен" "Повторите включение после снижения нагрузки."

  ENABLE_PENDING=1
  run_ndmc "interface $proxy_id up" || fail "Не удалось включить $proxy_id" "$CMD_OUTPUT"
  if ! watch_enabled_proxy; then
    if run_ndmc "interface $proxy_id down"; then
      ENABLE_PENDING=0
      fail "$proxy_id снова выключен" "$enable_failure Выберите другой проверенный профиль для DNS-маршрутов."
    fi
    fail "Не удалось подтвердить выключение $proxy_id" "$enable_failure $CMD_OUTPUT"
  fi
  run_ndmc 'system configuration save' || fail "Не удалось сохранить включение $proxy_id" "$CMD_OUTPUT"
  ENABLE_PENDING=0
  printf '{"ok":true,"message":"%s подключён и сохранён в Keenetic."}' "$proxy_id"
  exit 0
}

clear_stale_lock() {
  lock_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null | tr -cd '0-9')
  if [ -n "$lock_pid" ] && process_is_running "$lock_pid"; then
    return 1
  fi

  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_HELD=1
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  if clear_stale_lock && mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_HELD=1
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  lock_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null | tr -cd '0-9')
  fail "Операция с ProxyN уже выполняется" "Дождись завершения другой операции и попробуй ещё раз. Активный PID: ${lock_pid:-unknown}."
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH_HELPER=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)/bin/ui-paths.sh
[ -n "$PATH_HELPER" ] && . "$PATH_HELPER"

PROFILE_DIR="${VPN_ROUTING_UI_STATE_DIR:-/opt/etc/vpn-routing-ui}"
LOCK_DIR="$PROFILE_DIR/proxy-control.lock"
MAP_FILE="$PROFILE_DIR/router-proxies.map"
SHOW_FILE="/opt/tmp/router-proxy-control-show-$$.txt"
LOCK_HELD=0
ENABLE_PENDING=0

mkdir -p "$PROFILE_DIR" /opt/tmp
trap cleanup EXIT
trap 'exit 1' INT TERM HUP
acquire_lock

action=$(get_query_value "action")
proxy_id=$(get_query_value "proxy")

case "$proxy_id" in
  Proxy*) ;;
  *) fail "Неверный ProxyN" "$proxy_id" ;;
esac
case "${proxy_id#Proxy}" in
  ''|*[!0-9]*) fail "Неверный ProxyN" "$proxy_id" ;;
esac

case "$action" in
  enable) enable_proxy ;;
  restart|storm-reset|"") ;;
  *) fail "Неверное действие" "$action" ;;
esac

if ! proxy_configured_up "$proxy_id"; then
  fail "Этот ProxyN сейчас не активен" "Переподнимать можно только активные ProxyN, которые уже включены в конфигурации роутера."
fi

upstream_port=$(proxy_upstream_port "$proxy_id" | tr -cd '0-9')
loopback_before=$(loopback_connection_count "$upstream_port")

if ! run_ndmc "interface $proxy_id down"; then
  fail "Не удалось временно выключить $proxy_id" "$CMD_OUTPUT"
fi
sleep 1
if [ "$action" = "storm-reset" ]; then
  kill_hev_for_proxy "$proxy_id"
  sleep 1
fi
if ! run_ndmc "interface $proxy_id up"; then
  fail "Не удалось включить $proxy_id" "$CMD_OUTPUT"
fi
wait_proxy_ready "$proxy_id" || true
loopback_after=$(loopback_connection_count "$upstream_port")

read_proxy_show "$proxy_id"

printf '{'
printf '"ok":true,'
if [ "$action" = "storm-reset" ]; then
  printf '"message":"%s: локальный SOCKS-шторм сброшен, loopback %s → %s.",' "$(json_escape "$proxy_id")" "$(json_escape "$loopback_before")" "$(json_escape "$loopback_after")"
else
  printf '"message":"%s переподнят.",' "$(json_escape "$proxy_id")"
fi
printf '"proxyId":"%s",' "$(json_escape "$proxy_id")"
printf '"loopbackBefore":%s,' "$(printf '%s' "$loopback_before" | tr -cd '0-9')"
printf '"loopbackAfter":%s,' "$(printf '%s' "$loopback_after" | tr -cd '0-9')"
printf '"link":"%s",' "$(json_escape "$(show_value "$SHOW_FILE" "link")")"
printf '"connected":"%s",' "$(json_escape "$(show_value "$SHOW_FILE" "connected")")"
printf '"state":"%s",' "$(json_escape "$(show_value "$SHOW_FILE" "state")")"
printf '"ctrl":"%s"' "$(json_escape "$(show_value "$SHOW_FILE" "ctrl")")"
printf '}'
