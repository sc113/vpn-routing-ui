#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

normalize_proxy_id() {
  case "$1" in
    Proxy[0-9]*) printf '%s' "$1" ;;
    *) printf '' ;;
  esac
}

normalize_route_target() {
  case "$1" in
    "") printf '' ;;
    Proxy[0-9]*) printf '%s' "$1" ;;
    ISP|GigabitEthernet[0-9]*|UsbDsl[0-9]*|WifiMaster[0-9]*/WifiStation[0-9]*)
      printf '%s' "$1"
      ;;
    *) printf '' ;;
  esac
}

normalize_group_id() {
  case "$1" in
    domain-list[0-9]*) printf '%s' "$1" ;;
    *) printf '' ;;
  esac
}

run_ndmc() {
  ndmc -c "$1" </dev/null >/tmp/router-dns-routes-sync-cmd.$$ 2>&1
  code=$?
  CMD_OUTPUT=$(cat /tmp/router-dns-routes-sync-cmd.$$ 2>/dev/null)
  rm -f /tmp/router-dns-routes-sync-cmd.$$
  return $code
}

route_lines_from_config() {
  awk '
  $1 == "route" && $2 == "object-group" && $3 ~ /^domain-list[0-9]+$/ && $4 ~ /^[A-Za-z0-9_.\/-]+$/ {
    print $3 "|" $4
  }
  ' "$1"
}

sort_desired_routes() {
  awk -F'|' '
  function group_order(group_id, value) {
    value = group_id
    sub(/^domain-list/, "", value)
    return value + 0
  }
  NF >= 1 {
    target = $2
    priority = 2
    if (target ~ /^Proxy[0-9]+$/) {
      priority = 0
    } else if (target != "") {
      priority = 1
    }
    printf "%d|%09d|%s|%s\n", priority, group_order($1), $1, target
  }
  ' "$1" | sort -t'|' -k1,1n -k2,2n | awk -F'|' '{ print $3 "|" $4 }' > "$1.tmp" &&
    mv "$1.tmp" "$1"
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
  fail "Операция DNS уже выполняется" "Дождись завершения другой sync/reset операции и повтори снова. Активный PID: ${lock_pid:-unknown}."
}

refresh_verify_routes() {
  if ! ndmc -c 'show running-config' > "$VERIFY_FILE" 2>/tmp/router-dns-routes-sync-verify-show.$$; then
    details=$(cat /tmp/router-dns-routes-sync-verify-show.$$ 2>/dev/null)
    rm -f /tmp/router-dns-routes-sync-verify-show.$$
    fail "Не удалось перепроверить running-config Keenetic" "$details"
  fi
  rm -f /tmp/router-dns-routes-sync-verify-show.$$
  route_lines_from_config "$VERIFY_FILE" > "$VERIFY_FILE.routes"
}

remove_route_if_present() {
  if ! run_ndmc "no dns-proxy route object-group $1 $2"; then
    case "$CMD_OUTPUT" in
      *"unable to find a route to"*)
        return 0
        ;;
    esac
    fail "Не удалось снять старый DNS-маршрут" "$CMD_OUTPUT"
  fi
}

warm_fqdn_groups() {
  : > "$WARM_GROUPS_FILE"
  awk -F'|' 'NF >= 2 && $1 ~ /^domain-list[0-9]+$/ && $2 != "" { print $1 }' "$1" | sort -u > "$WARM_GROUPS_FILE"

  FQDN_WARM_COUNT=0
  while IFS= read -r group_id || [ -n "$group_id" ]; do
    [ -n "$group_id" ] || continue
    if ! run_ndmc "opkg object-group fqdn $group_id enable"; then
      fail "Не удалось поставить FQDN-группу в очередь резолва" "$group_id: $CMD_OUTPUT"
    fi
    FQDN_WARM_COUNT=$((FQDN_WARM_COUNT + 1))
  done < "$WARM_GROUPS_FILE"

  if [ "$FQDN_WARM_COUNT" -gt 0 ]; then
    sleep 6
  fi
}

cleanup() {
  rm -f "$TMP_INPUT" "$RUNCFG_FILE" "$GROUPS_FILE" "$ROUTES_FILE" "$DESIRED_FILE" "$EXPECTED_FILE" "$VERIFY_FILE" "$VERIFY_FILE.routes" "$WARM_GROUPS_FILE"
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

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH_HELPER=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)/bin/ui-paths.sh
[ -n "$PATH_HELPER" ] && . "$PATH_HELPER"

PROFILE_DIR="${VPN_ROUTING_UI_STATE_DIR:-/opt/etc/vpn-routing-ui}"
BACKUP_DIR="$PROFILE_DIR/backups"
ROUTE_STATE_FILE="$PROFILE_DIR/dns-routes.state"
LOCK_DIR="$PROFILE_DIR/dns-routes.lock"
TMP_INPUT="/opt/tmp/router-dns-routes-sync-$$.txt"
RUNCFG_FILE="/opt/tmp/router-dns-routes-sync-running-$$.txt"
GROUPS_FILE="/opt/tmp/router-dns-routes-sync-groups-$$.txt"
ROUTES_FILE="/opt/tmp/router-dns-routes-sync-routes-$$.txt"
DESIRED_FILE="/opt/tmp/router-dns-routes-sync-desired-$$.txt"
EXPECTED_FILE="/opt/tmp/router-dns-routes-sync-expected-$$.txt"
VERIFY_FILE="/opt/tmp/router-dns-routes-sync-verify-$$.txt"
WARM_GROUPS_FILE="/opt/tmp/router-dns-routes-sync-warm-groups-$$.txt"

mkdir -p "$PROFILE_DIR" "$BACKUP_DIR" /opt/tmp
cat > "$TMP_INPUT"
LOCK_HELD=0
acquire_lock

STAMP=$(date +%Y%m%d-%H%M%S)
RUNCFG_BACKUP_PATH="$BACKUP_DIR/ndmc-running-dns-$STAMP.txt"

if ! ndmc -c 'show running-config' > "$RUNCFG_FILE" 2>/tmp/router-dns-routes-sync-show.$$; then
  details=$(cat /tmp/router-dns-routes-sync-show.$$ 2>/dev/null)
  rm -f /tmp/router-dns-routes-sync-show.$$
  fail "Не удалось прочитать running-config Keenetic" "$details"
fi
rm -f /tmp/router-dns-routes-sync-show.$$
cp "$RUNCFG_FILE" "$RUNCFG_BACKUP_PATH"

awk '
$1 == "object-group" && $2 == "fqdn" && $3 ~ /^domain-list[0-9]+$/ {
  print $3
}
' "$RUNCFG_FILE" > "$GROUPS_FILE"

route_lines_from_config "$RUNCFG_FILE" > "$ROUTES_FILE"

: > "$DESIRED_FILE"

while IFS='|' read -r record_type raw_group raw_proxy || [ -n "$record_type$raw_group$raw_proxy" ]; do
  record_type=$(printf '%s' "$record_type" | tr -d '\r')
  [ "$record_type" = "R" ] || continue

  raw_group=$(printf '%s' "$raw_group" | tr -d '\r')
  raw_proxy=$(printf '%s' "$raw_proxy" | tr -d '\r')
  group_id=$(normalize_group_id "$raw_group")
  route_target=$(normalize_route_target "$raw_proxy")

  if [ -z "$group_id" ]; then
    fail "Правило DNS должно быть в формате domain-listN" "$raw_group"
  fi

  if ! grep -Fxq "$group_id" "$GROUPS_FILE"; then
    fail "Такого списка domain-list нет в running-config Keenetic" "$group_id"
  fi

  if [ -n "$raw_proxy" ] && [ -z "$route_target" ]; then
    fail "Маршрут DNS должен быть ProxyN или системным интерфейсом Keenetic" "$raw_proxy"
  fi

  proxy_id=$(normalize_proxy_id "$route_target")
  if [ -n "$proxy_id" ] && ! grep -q "^interface $proxy_id$" "$RUNCFG_FILE"; then
    fail "Указанный ProxyN не существует на роутере" "$proxy_id"
  fi

  awk -F'|' -v group_id="$group_id" '$1 != group_id { print $0 }' "$DESIRED_FILE" > "$DESIRED_FILE.tmp"
  mv "$DESIRED_FILE.tmp" "$DESIRED_FILE"
  printf '%s|%s\n' "$group_id" "$route_target" >> "$DESIRED_FILE"
done < "$TMP_INPUT"

sort_desired_routes "$DESIRED_FILE"

awk -F'|' 'NF >= 2 && $2 != "" { print $1 "|" $2 }' "$DESIRED_FILE" > "$EXPECTED_FILE"

applied=0
FQDN_WARM_COUNT=0
warm_fqdn_groups "$EXPECTED_FILE"

while IFS='|' read -r group_id desired_proxy || [ -n "$group_id$desired_proxy" ]; do
  [ -n "$group_id" ] || continue
  current_proxy=$(awk -F'|' -v group_id="$group_id" '$1 == group_id { print $2; exit }' "$ROUTES_FILE")

  # Recreate every managed route in payload order. Keenetic evaluates DNS routes
  # in order, so the UI sends VPN routes before direct/ISP exceptions. Shared
  # CDN IPs (Cloudflare, Google, etc.) can otherwise be stolen by a direct list.
  if [ -n "$current_proxy" ]; then
    remove_route_if_present "$group_id" "$current_proxy"
    applied=$((applied + 1))
  fi

  if [ -n "$desired_proxy" ]; then
    if ! run_ndmc "dns-proxy route object-group $group_id $desired_proxy auto reject"; then
      fail "Не удалось создать DNS-маршрут" "$CMD_OUTPUT"
    fi
    applied=$((applied + 1))
  fi
done < "$DESIRED_FILE"

refresh_verify_routes
if ! cmp -s "$EXPECTED_FILE" "$VERIFY_FILE.routes"; then
  fail "Итоговые DNS-маршруты не совпали с ожидаемым состоянием" "$(cat "$VERIFY_FILE.routes" 2>/dev/null)"
fi

if ! ndmc -c 'system configuration save' >/tmp/router-dns-routes-sync-save.$$ 2>&1; then
  details=$(cat /tmp/router-dns-routes-sync-save.$$ 2>/dev/null)
  rm -f /tmp/router-dns-routes-sync-save.$$
  fail "Не удалось сохранить running-config Keenetic" "$details"
fi
rm -f /tmp/router-dns-routes-sync-save.$$

cp "$DESIRED_FILE" "$ROUTE_STATE_FILE" || fail "Не удалось сохранить состояние DNS-маршрутов" "$ROUTE_STATE_FILE"

printf '{'
printf '"ok":true,'
printf '"message":"DNS-маршруты применены, FQDN-cache поставлен в очередь обновления.",'
printf '"appliedCount":%s,' "$applied"
printf '"backupPath":"%s",' "$(json_escape "$RUNCFG_BACKUP_PATH")"
printf '"statePath":"%s",' "$(json_escape "$ROUTE_STATE_FILE")"
printf '"fqdnWarmCount":%s,' "$FQDN_WARM_COUNT"
printf '"fqdnWarmDelaySec":6,'
printf '"verifiedCount":%s' "$(wc -l < "$EXPECTED_FILE" | tr -d ' ')"
printf '}'

cleanup
