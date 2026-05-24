#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

run_cmd() {
  sh -c "$1" >/tmp/vpn-route-refresh.$$ 2>&1
  CMD_OUTPUT=$(cat /tmp/vpn-route-refresh.$$ 2>/dev/null)
  rm -f /tmp/vpn-route-refresh.$$
  return $?
}

cleanup() {
  rm -f /tmp/vpn-route-refresh.$$ /tmp/vpn-route-refresh-save.$$ /tmp/vpn-route-refresh-show.$$
  if [ "${LOCK_HELD:-0}" = "1" ]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null
  fi
}

fail() {
  cleanup
  printf '{"ok":false,"error":"%s","details":"%s"}' "$(json_escape "$1")" "$(json_escape "$2")"
  exit 0
}

process_is_running() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac

  ps | awk -v pid="$1" '$1 == pid { found = 1 } END { exit(found ? 0 : 1) }'
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
  fail "Операция VPN reset уже выполняется" "Подожди завершения текущей операции и попробуй ещё раз. Активный PID: ${lock_pid:-unknown}."
}

get_query_value() {
  key="$1"
  printf '%s' "$QUERY_STRING" | tr '&' '\n' | awk -F'=' -v wanted="$key" '$1 == wanted { print $2; exit }'
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH_HELPER=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)/bin/ui-paths.sh
[ -n "$PATH_HELPER" ] && . "$PATH_HELPER"

PROFILE_DIR="${VPN_ROUTING_UI_STATE_DIR:-/opt/etc/vpn-routing-ui}"
BACKUP_DIR="$PROFILE_DIR/backups"
LOCK_DIR="$PROFILE_DIR/vpn-route-refresh.lock"
RUNCFG_FILE="/opt/tmp/vpn-route-refresh-running-$$.txt"
LOCK_HELD=0

mkdir -p "$PROFILE_DIR" "$BACKUP_DIR" /opt/tmp
trap cleanup EXIT INT TERM HUP
acquire_lock

restart_xray=$(get_query_value "xray")
restart_singbox=$(get_query_value "singbox")

if ! ndmc -c 'show running-config' > "$RUNCFG_FILE" 2>/tmp/vpn-route-refresh-show.$$; then
  details=$(cat /tmp/vpn-route-refresh-show.$$ 2>/dev/null)
  rm -f /tmp/vpn-route-refresh-show.$$
  fail "Не удалось прочитать running-config Keenetic" "$details"
fi
rm -f /tmp/vpn-route-refresh-show.$$

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_PATH="$BACKUP_DIR/ndmc-running-config-$STAMP-before-vpn-route-refresh.txt"
cp "$RUNCFG_FILE" "$BACKUP_PATH" || fail "Не удалось сохранить backup running-config" "$BACKUP_PATH"

messages=""

if [ "$restart_xray" = "1" ] && [ -x /opt/etc/init.d/S24xray ]; then
  if ! run_cmd "/opt/etc/init.d/S24xray restart"; then
    fail "Не удалось перезапустить Xray" "$CMD_OUTPUT"
  fi
  messages="Xray перезапущен."
fi

if [ "$restart_singbox" = "1" ] && [ -x /opt/etc/init.d/S99sing-box ]; then
  if ! run_cmd "/opt/etc/init.d/S99sing-box restart"; then
    fail "Не удалось перезапустить sing-box" "$CMD_OUTPUT"
  fi
  if [ -n "$messages" ]; then
    messages="$messages "
  fi
  messages="${messages}sing-box перезапущен."
fi

if ! ndmc -c 'system configuration save' >/tmp/vpn-route-refresh-save.$$ 2>&1; then
  details=$(cat /tmp/vpn-route-refresh-save.$$ 2>/dev/null)
  rm -f /tmp/vpn-route-refresh-save.$$
  fail "Не удалось сохранить running-config Keenetic" "$details"
fi
rm -f /tmp/vpn-route-refresh-save.$$

if [ -z "$messages" ]; then
  messages="Активные движки не потребовали перезапуска."
fi

printf '{'
printf '"ok":true,'
printf '"message":"%s",' "$(json_escape "$messages")"
printf '"runtime":"%s",' ""
printf '"backupPath":"%s"' "$(json_escape "$BACKUP_PATH")"
printf '}'
