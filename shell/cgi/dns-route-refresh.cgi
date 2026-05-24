#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

cleanup() {
  rm -f "$RUNCFG_FILE" "$ROUTES_FILE" "$DESIRED_FILE" "$EXPECTED_FILE" "$VERIFY_FILE" "$VERIFY_FILE.routes" "$WARM_GROUPS_FILE" /tmp/dns-route-refresh.$$
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

run_ndmc() {
  ndmc -c "$1" </dev/null >/tmp/dns-route-refresh.$$ 2>&1
  code=$?
  CMD_OUTPUT=$(cat /tmp/dns-route-refresh.$$ 2>/dev/null)
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
  if ! ndmc -c 'show running-config' > "$VERIFY_FILE" 2>/tmp/dns-route-refresh-verify-show.$$; then
    details=$(cat /tmp/dns-route-refresh-verify-show.$$ 2>/dev/null)
    rm -f /tmp/dns-route-refresh-verify-show.$$
    fail "Не удалось перепроверить running-config Keenetic" "$details"
  fi
  rm -f /tmp/dns-route-refresh-verify-show.$$
  route_lines_from_config "$VERIFY_FILE" > "$VERIFY_FILE.routes"
}

remove_route_if_present() {
  if ! run_ndmc "no dns-proxy route object-group $1 $2"; then
    case "$CMD_OUTPUT" in
      *"unable to find a route to"*)
        return 0
        ;;
    esac
    fail "Не удалось временно снять DNS-маршрут" "$CMD_OUTPUT"
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
RUNCFG_FILE="/opt/tmp/dns-route-refresh-running-$$.txt"
ROUTES_FILE="/opt/tmp/dns-route-refresh-routes-$$.txt"
DESIRED_FILE="/opt/tmp/dns-route-refresh-desired-$$.txt"
EXPECTED_FILE="/opt/tmp/dns-route-refresh-expected-$$.txt"
VERIFY_FILE="/opt/tmp/dns-route-refresh-verify-$$.txt"
WARM_GROUPS_FILE="/opt/tmp/dns-route-refresh-warm-groups-$$.txt"

mkdir -p "$PROFILE_DIR" "$BACKUP_DIR" /opt/tmp
LOCK_HELD=0
acquire_lock

if ! ndmc -c 'show running-config' > "$RUNCFG_FILE" 2>/tmp/dns-route-refresh-show.$$; then
  details=$(cat /tmp/dns-route-refresh-show.$$ 2>/dev/null)
  rm -f /tmp/dns-route-refresh-show.$$
  fail "Не удалось прочитать running-config Keenetic" "$details"
fi
rm -f /tmp/dns-route-refresh-show.$$

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_PATH="$BACKUP_DIR/ndmc-running-config-$STAMP-before-dns-route-refresh.txt"
cp "$RUNCFG_FILE" "$BACKUP_PATH" || fail "Не удалось сохранить backup running-config" "$BACKUP_PATH"

route_lines_from_config "$RUNCFG_FILE" > "$ROUTES_FILE"

if [ -s "$ROUTE_STATE_FILE" ]; then
  cp "$ROUTE_STATE_FILE" "$DESIRED_FILE" || fail "Не удалось прочитать сохранённое состояние DNS-маршрутов" "$ROUTE_STATE_FILE"
  ROUTE_SOURCE="saved-state"
else
  cp "$ROUTES_FILE" "$DESIRED_FILE" || fail "Не удалось подготовить список текущих DNS-маршрутов" "$ROUTES_FILE"
  ROUTE_SOURCE="running-config"
fi

sort_desired_routes "$DESIRED_FILE"

awk -F'|' 'NF >= 2 && $2 != "" { print $1 "|" $2 }' "$DESIRED_FILE" > "$EXPECTED_FILE"

applied=0
RESET_STRATEGY="warm-full-rebuild"
FQDN_WARM_COUNT=0
warm_fqdn_groups "$EXPECTED_FILE"

while IFS='|' read -r group_id current_target || [ -n "$group_id$current_target" ]; do
  [ -n "$group_id" ] || continue
  [ -n "$current_target" ] || continue

  remove_route_if_present "$group_id" "$current_target"
  applied=$((applied + 1))
done < "$ROUTES_FILE"

while IFS='|' read -r group_id desired_target || [ -n "$group_id$desired_target" ]; do
  [ -n "$group_id" ] || continue
  [ -n "$desired_target" ] || continue

  if ! run_ndmc "dns-proxy route object-group $group_id $desired_target auto reject"; then
    fail "Не удалось создать DNS-маршрут при пересборке" "$CMD_OUTPUT"
  fi
  applied=$((applied + 1))
done < "$DESIRED_FILE"

refresh_verify_routes

if ! cmp -s "$EXPECTED_FILE" "$VERIFY_FILE.routes"; then
  fail "Итоговые DNS-маршруты не совпали с сохранённым состоянием" "$(cat "$VERIFY_FILE.routes" 2>/dev/null)"
fi

if ! run_ndmc "no dns-proxy intercept enable"; then
  fail "Не удалось отключить dns-proxy intercept" "$CMD_OUTPUT"
fi
sleep 2
if ! run_ndmc "dns-proxy intercept enable"; then
  fail "Не удалось включить dns-proxy intercept" "$CMD_OUTPUT"
fi

if ! ndmc -c 'system configuration save' >/tmp/dns-route-refresh-save.$$ 2>&1; then
  details=$(cat /tmp/dns-route-refresh-save.$$ 2>/dev/null)
  rm -f /tmp/dns-route-refresh-save.$$
  fail "Не удалось сохранить running-config Keenetic" "$details"
fi
rm -f /tmp/dns-route-refresh-save.$$

printf '{'
printf '"ok":true,'
printf '"message":"DNS-маршруты, intercept и FQDN-cache пересобраны.",'
printf '"appliedCount":%s,' "$applied"
printf '"backupPath":"%s",' "$(json_escape "$BACKUP_PATH")"
printf '"source":"%s",' "$(json_escape "$ROUTE_SOURCE")"
printf '"strategy":"%s",' "$(json_escape "$RESET_STRATEGY")"
printf '"fqdnWarmCount":%s,' "$FQDN_WARM_COUNT"
printf '"fqdnWarmDelaySec":6,'
printf '"verifiedCount":%s' "$(wc -l < "$EXPECTED_FILE" | tr -d ' ')"
printf '}'

cleanup
