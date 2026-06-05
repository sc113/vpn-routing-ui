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

query_value() {
  key="$1"
  printf '%s' "${QUERY_STRING:-}" | tr '&' '\n' | awk -F= -v key="$key" '$1 == key { print $2; exit }'
}

normalize_proxy_id() {
  case "$1" in
    Proxy[0-9]*) printf '%s' "$1" ;;
    *) printf '' ;;
  esac
}

decode_name() {
  if [ -z "$1" ]; then
    printf ''
    return
  fi
  printf '%s' "$1" | /opt/bin/base64 -d 2>/dev/null
}

sanitize_name() {
  printf '%s' "$1" | tr '\r\n' '  ' | sed 's/"/ /g'
}

quote_ndmc_string() {
  printf '%s' "$1" | sed 's/\\/\\\\/g;s/"/\\"/g'
}

run_ndmc() {
  ndmc -c "$1" </dev/null >/tmp/router-proxy-sync-cmd.$$ 2>&1
  code=$?
  CMD_OUTPUT=$(cat /tmp/router-proxy-sync-cmd.$$ 2>/dev/null)
  rm -f /tmp/router-proxy-sync-cmd.$$
  return $code
}

proxy_exists() {
  grep -q "^$1|" "$EXISTING_FILE"
}

proxy_taken() {
  grep -Fxq "$1" "$ASSIGNED_FILE"
}

port_listening() {
  port=$(printf '%s' "$1" | tr -cd '0-9')
  [ -n "$port" ] || return 1

  if command -v ss >/dev/null 2>&1; then
    ss -lnt 2>/dev/null | awk -v port=":$port" 'index($4, port) { found = 1 } END { exit(found ? 0 : 1) }'
    return $?
  fi

  netstat -lnt 2>/dev/null | awk -v port=":$port" 'index($4, port) { found = 1 } END { exit(found ? 0 : 1) }'
}

port_listening_on_host() {
  host="$1"
  port=$(printf '%s' "$2" | tr -cd '0-9')
  [ -n "$host" ] || return 1
  [ -n "$port" ] || return 1

  if command -v ss >/dev/null 2>&1; then
    ss -lnt 2>/dev/null | awk -v endpoint="$host:$port" 'index($4, endpoint) { found = 1 } END { exit(found ? 0 : 1) }'
    return $?
  fi

  netstat -lnt 2>/dev/null | awk -v endpoint="$host:$port" 'index($4, endpoint) { found = 1 } END { exit(found ? 0 : 1) }'
}

find_preferred_listener_host() {
  port=$(printf '%s' "$1" | tr -cd '0-9')
  [ -n "$port" ] || return 1

  if port_listening_on_host "127.0.0.1" "$port"; then
    printf '127.0.0.1'
    return 0
  fi

  if command -v ss >/dev/null 2>&1; then
    host=$(ss -lnt 2>/dev/null | awk -v wanted_port="$port" '
      {
        split($4, parts, ":")
        host = parts[1]
        current_port = parts[length(parts)]
        if (current_port == wanted_port && host != "0.0.0.0" && host ~ /^[0-9.]+$/) {
          print host
          exit
        }
      }
    ')
  else
    host=$(netstat -lnt 2>/dev/null | awk -v wanted_port="$port" '
      {
        split($4, parts, ":")
        host = parts[1]
        current_port = parts[length(parts)]
        if (current_port == wanted_port && host != "0.0.0.0" && host ~ /^[0-9.]+$/) {
          print host
          exit
        }
      }
    ')
  fi

  if [ -n "$host" ]; then
    printf '%s' "$host"
    return 0
  fi

  return 1
}

old_proxy_for_id() {
  awk -F'|' -v profile_id="$1" '$1 == profile_id { print $2; exit }' "$OLD_MAP_FILE"
}

existing_proxy_by_port() {
  awk -F'|' -v wanted_port="$1" '$3 == wanted_port { print $1; exit }' "$EXISTING_FILE"
}

existing_proxy_by_name() {
  awk -F'|' -v wanted_name="$1" '$2 == wanted_name { print $1; exit }' "$EXISTING_FILE"
}

allocate_proxy() {
  index=0
  while [ "$index" -le 63 ]; do
    candidate="Proxy$index"
    if ! proxy_exists "$candidate" && ! proxy_taken "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
    index=$((index + 1))
  done

  index=0
  while [ "$index" -le 63 ]; do
    candidate="Proxy$index"
    if ! proxy_taken "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
    index=$((index + 1))
  done

  printf ''
}

cleanup() {
  rm -f \
    "$TMP_INPUT" \
    "$RUNCFG_FILE" \
    "$EXISTING_FILE" \
    "$OLD_MAP_FILE" \
    "$NEW_MAP_FILE" \
    "$ASSIGNED_FILE" \
    "$DESIRED_IDS_FILE" \
    "$REMOVED_FILE" \
    "$MAPPINGS_FILE" \
    "$ENABLED_PORTS_FILE" \
    "$NEW_MAP_FILE.tmp"
}

fail() {
  cleanup
  printf '{"ok":false,"error":"%s","details":"%s"}' "$(json_escape "$1")" "$(json_escape "$2")"
  exit 0
}

fail_missing_proxy_component() {
  fail \
    "На роутере не установлен компонент KeeneticOS Proxy client" \
    "Установи системный компонент Proxy client в настройках компонентов KeeneticOS, затем повтори сохранение. Без него Keenetic не принимает интерфейсы ProxyN."
}

sync_names_only() {
  cp "$OLD_MAP_FILE" "$NEW_MAP_FILE"
  : > "$MAPPINGS_FILE"
  updated=0
  skipped=0
  removed=0

  while IFS='|' read -r record_type profile_id name_b64 enabled local_port proxy_hint || [ -n "$record_type$profile_id$name_b64$enabled$local_port$proxy_hint" ]; do
    record_type=$(printf '%s' "$record_type" | tr -d '\r')
    [ "$record_type" = "P" ] || continue

    profile_id=$(printf '%s' "$profile_id" | tr -d '\r')
    enabled=$(printf '%s' "$enabled" | tr -d '\r')
    local_port=$(printf '%s' "$local_port" | tr -cd '0-9')
    raw_proxy_hint=$(printf '%s' "$proxy_hint" | tr -d '\r')
    proxy_hint=$(normalize_proxy_id "$raw_proxy_hint")
    profile_name=$(sanitize_name "$(decode_name "$name_b64")")

    [ -n "$profile_id" ] || continue
    [ -n "$profile_name" ] || profile_name="$profile_id"
    echo "$profile_id" >> "$DESIRED_IDS_FILE"

    candidate="$proxy_hint"
    [ -n "$candidate" ] || candidate=$(normalize_proxy_id "$(old_proxy_for_id "$profile_id")")
    [ -n "$candidate" ] || candidate=$(normalize_proxy_id "$(existing_proxy_by_port "$local_port")")
    [ -n "$candidate" ] || candidate=$(normalize_proxy_id "$(existing_proxy_by_name "$profile_name")")

    if [ -z "$candidate" ] || ! proxy_exists "$candidate"; then
      skipped=$((skipped + 1))
      continue
    fi

    if ! run_ndmc "interface $candidate description \"$(quote_ndmc_string "$profile_name")\""; then
      fail "Не удалось обновить название $candidate на роутере" "$CMD_OUTPUT"
    fi

    awk -F'|' -v profile_id="$profile_id" '$1 != profile_id { print $0 }' "$NEW_MAP_FILE" > "$NEW_MAP_FILE.tmp"
    mv "$NEW_MAP_FILE.tmp" "$NEW_MAP_FILE"
    echo "$profile_id|$candidate|$profile_name|$enabled|$local_port" >> "$NEW_MAP_FILE"
    echo "$profile_id|$candidate|$profile_name|$enabled|$local_port" >> "$MAPPINGS_FILE"
    echo "$candidate" >> "$ASSIGNED_FILE"
    updated=$((updated + 1))
  done < "$TMP_INPUT"

  if [ -s "$OLD_MAP_FILE" ]; then
    while IFS='|' read -r old_id old_proxy old_name old_enabled old_port; do
      old_proxy=$(normalize_proxy_id "$old_proxy")
      [ -n "$old_id" ] || continue
      [ -n "$old_proxy" ] || continue

      if grep -Fxq "$old_id" "$DESIRED_IDS_FILE"; then
        continue
      fi

      awk -F'|' -v profile_id="$old_id" '$1 != profile_id { print $0 }' "$NEW_MAP_FILE" > "$NEW_MAP_FILE.tmp"
      mv "$NEW_MAP_FILE.tmp" "$NEW_MAP_FILE"

      if proxy_taken "$old_proxy"; then
        continue
      fi

      run_ndmc "no interface $old_proxy" >/dev/null 2>&1 || true
      echo "$old_proxy" >> "$REMOVED_FILE"
      removed=$((removed + 1))
    done < "$OLD_MAP_FILE"
  fi

  if ! ndmc -c 'system configuration save' >/tmp/router-proxy-sync-save.$$ 2>&1; then
    details=$(cat /tmp/router-proxy-sync-save.$$ 2>/dev/null)
    rm -f /tmp/router-proxy-sync-save.$$
    fail "Не удалось сохранить конфигурацию Keenetic" "$details"
  fi
  rm -f /tmp/router-proxy-sync-save.$$

  cp "$NEW_MAP_FILE" "$MAP_FILE"

  printf '{'
  printf '"ok":true,'
  printf '"message":"Названия ProxyN синхронизированы с UI.",'
  printf '"mapPath":"%s",' "$(json_escape "$MAP_FILE")"
  printf '"backupPath":"%s",' "$(json_escape "$MAP_BACKUP_PATH")"
  printf '"runningConfigBackupPath":"%s",' "$(json_escape "$RUNCFG_BACKUP_PATH")"
  printf '"updated":%s,' "$updated"
  printf '"skipped":%s,' "$skipped"
  printf '"removed":%s,' "$removed"
  printf '"mappings":['

  first_mapping=1
  while IFS='|' read -r profile_id proxy_id profile_name enabled local_port; do
    [ -n "$profile_id" ] || continue
    if [ "$first_mapping" -eq 0 ]; then
      printf ','
    fi
    first_mapping=0
    printf '{'
    printf '"id":"%s",' "$(json_escape "$profile_id")"
    printf '"routerProxyId":"%s",' "$(json_escape "$proxy_id")"
    printf '"name":"%s",' "$(json_escape "$profile_name")"
    printf '"enabled":%s,' "$(bool_json "$enabled")"
    local_port_json=$(printf '%s' "$local_port" | tr -cd '0-9')
    [ -n "$local_port_json" ] || local_port_json=0
    printf '"localPort":%s' "$local_port_json"
    printf '}'
  done < "$MAPPINGS_FILE"

  printf ']}'
  cleanup
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
MAP_FILE="$PROFILE_DIR/router-proxies.map"
TMP_INPUT="/opt/tmp/router-proxy-sync-$$.txt"
RUNCFG_FILE="/opt/tmp/router-proxy-sync-running-$$.txt"
EXISTING_FILE="/opt/tmp/router-proxy-sync-existing-$$.txt"
OLD_MAP_FILE="/opt/tmp/router-proxy-sync-old-$$.txt"
NEW_MAP_FILE="/opt/tmp/router-proxy-sync-new-$$.txt"
ASSIGNED_FILE="/opt/tmp/router-proxy-sync-assigned-$$.txt"
DESIRED_IDS_FILE="/opt/tmp/router-proxy-sync-desired-$$.txt"
REMOVED_FILE="/opt/tmp/router-proxy-sync-removed-$$.txt"
MAPPINGS_FILE="/opt/tmp/router-proxy-sync-mappings-$$.txt"
ENABLED_PORTS_FILE="/opt/tmp/router-proxy-sync-enabled-$$.txt"

mkdir -p "$PROFILE_DIR" "$BACKUP_DIR" /opt/tmp
action=$(query_value action)
cat > "$TMP_INPUT"

if [ ! -s "$TMP_INPUT" ]; then
  fail "Пустое тело запроса" ""
fi

STAMP=$(date +%Y%m%d-%H%M%S)
MAP_BACKUP_PATH=""
RUNCFG_BACKUP_PATH="$BACKUP_DIR/ndmc-running-$STAMP.txt"

if [ -f "$MAP_FILE" ]; then
  MAP_BACKUP_PATH="$BACKUP_DIR/router-proxies-$STAMP.map"
  cp "$MAP_FILE" "$MAP_BACKUP_PATH"
fi

if ! ndmc -c 'show running-config' > "$RUNCFG_FILE" 2>/tmp/router-proxy-sync-show.$$; then
  details=$(cat /tmp/router-proxy-sync-show.$$ 2>/dev/null)
  rm -f /tmp/router-proxy-sync-show.$$
  fail "Не удалось прочитать running-config Keenetic" "$details"
fi
rm -f /tmp/router-proxy-sync-show.$$
cp "$RUNCFG_FILE" "$RUNCFG_BACKUP_PATH"

awk '
$1 == "interface" && $2 ~ /^Proxy[0-9]+$/ {
  if (iface != "") {
    print iface "|" desc "|" port "|" state
  }
  iface = $2
  desc = ""
  port = ""
  state = "down"
  next
}
iface != "" && $1 == "!" {
  print iface "|" desc "|" port "|" state
  iface = ""
  desc = ""
  port = ""
  state = "down"
  next
}
iface != "" && $1 == "description" {
  sub(/^[ \t]*description[ \t]*/, "")
  desc = $0
  next
}
iface != "" && $1 == "proxy" && $2 == "upstream" {
  port = $4
  next
}
iface != "" && $1 == "up" {
  state = "up"
  next
}
END {
  if (iface != "") {
    print iface "|" desc "|" port "|" state
  }
}
' "$RUNCFG_FILE" > "$EXISTING_FILE"

if [ -f "$MAP_FILE" ]; then
  cp "$MAP_FILE" "$OLD_MAP_FILE"
else
  : > "$OLD_MAP_FILE"
fi

: > "$NEW_MAP_FILE"
: > "$ASSIGNED_FILE"
: > "$DESIRED_IDS_FILE"
: > "$REMOVED_FILE"
: > "$MAPPINGS_FILE"
: > "$ENABLED_PORTS_FILE"

if [ "$action" = "names" ]; then
  sync_names_only
fi

while IFS='|' read -r record_type profile_id name_b64 enabled local_port proxy_hint || [ -n "$record_type$profile_id$name_b64$enabled$local_port$proxy_hint" ]; do
  record_type=$(printf '%s' "$record_type" | tr -d '\r')
  [ "$record_type" = "P" ] || continue

  profile_id=$(printf '%s' "$profile_id" | tr -d '\r')
  enabled=$(printf '%s' "$enabled" | tr -d '\r')
  local_port=$(printf '%s' "$local_port" | tr -cd '0-9')
  raw_proxy_hint=$(printf '%s' "$proxy_hint" | tr -d '\r')
  proxy_hint=$(normalize_proxy_id "$raw_proxy_hint")
  profile_name=$(decode_name "$name_b64")
  profile_name=$(sanitize_name "$profile_name")

  [ -n "$profile_id" ] || continue
  [ -n "$profile_name" ] || profile_name="$profile_id"

  if [ -n "$raw_proxy_hint" ] && [ -z "$proxy_hint" ]; then
    fail "Поле Proxy на роутере должно быть только в формате ProxyN" "$raw_proxy_hint"
  fi

  echo "$profile_id" >> "$DESIRED_IDS_FILE"

  if [ -z "$local_port" ]; then
    echo "$profile_id||$profile_name|$enabled|0" >> "$MAPPINGS_FILE"
    continue
  fi

  if [ "$enabled" = "1" ]; then
    existing_name=$(awk -F'|' -v wanted_port="$local_port" '$1 == wanted_port { print $2; exit }' "$ENABLED_PORTS_FILE")
    if [ -n "$existing_name" ]; then
      fail "Два активных профиля используют один и тот же локальный порт" "$existing_name и $profile_name :$local_port"
    fi
    echo "$local_port|$profile_name" >> "$ENABLED_PORTS_FILE"
  fi

  candidate="$proxy_hint"
  if [ -n "$candidate" ] && proxy_taken "$candidate"; then
    candidate=""
  fi

  if [ -z "$candidate" ]; then
    candidate=$(normalize_proxy_id "$(old_proxy_for_id "$profile_id")")
    if [ -n "$candidate" ] && proxy_taken "$candidate"; then
      candidate=""
    fi
  fi

  if [ -z "$candidate" ]; then
    candidate=$(normalize_proxy_id "$(existing_proxy_by_port "$local_port")")
    if [ -n "$candidate" ] && proxy_taken "$candidate"; then
      candidate=""
    fi
  fi

  if [ -z "$candidate" ]; then
    candidate=$(normalize_proxy_id "$(existing_proxy_by_name "$profile_name")")
    if [ -n "$candidate" ] && proxy_taken "$candidate"; then
      candidate=""
    fi
  fi

  if [ -z "$candidate" ]; then
    candidate=$(allocate_proxy)
  fi

  [ -n "$candidate" ] || fail "Не удалось подобрать ProxyN для профиля" "$profile_name"

  if ! proxy_exists "$candidate"; then
    if ! run_ndmc "interface $candidate"; then
      case "$CMD_OUTPUT" in
        *"unsupported interface type"*Proxy*|*"unsupported interface type: \"Proxy\""*)
          fail_missing_proxy_component
          ;;
      esac
      fail "Не удалось создать интерфейс $candidate" "$CMD_OUTPUT"
    fi
  fi

  if ! run_ndmc "interface $candidate description \"$(quote_ndmc_string "$profile_name")\""; then
    fail "Не удалось сохранить название профиля на роутере" "$CMD_OUTPUT"
  fi
  if ! run_ndmc "interface $candidate proxy protocol socks5"; then
    fail "Не удалось включить socks5 для $candidate" "$CMD_OUTPUT"
  fi
  if ! run_ndmc "interface $candidate proxy socks5-udp"; then
    fail "Не удалось включить UDP для $candidate" "$CMD_OUTPUT"
  fi
  if [ "$enabled" = "1" ]; then
    upstream_host=$(find_preferred_listener_host "$local_port")
    if [ -z "$upstream_host" ]; then
      fail "Не удалось определить рабочий локальный адрес socks-порта" "$profile_name :$local_port"
    fi
  else
    upstream_host="127.0.0.1"
  fi

  if ! run_ndmc "interface $candidate proxy upstream $upstream_host $local_port"; then
    fail "Не удалось назначить upstream для $candidate" "$CMD_OUTPUT"
  fi
  if ! run_ndmc "interface $candidate security-level public"; then
    fail "Не удалось выставить security-level для $candidate" "$CMD_OUTPUT"
  fi
  if ! run_ndmc "interface $candidate ip global 1"; then
    fail "Не удалось выставить ip global для $candidate" "$CMD_OUTPUT"
  fi

  if [ "$enabled" = "1" ]; then
    if ! port_listening "$local_port"; then
      fail "Локальный socks-порт не слушает на роутере" "$profile_name :$local_port"
    fi
    if ! port_listening_on_host "127.0.0.1" "$local_port"; then
      fail "Внутренний loopback socks-порт не слушает на 127.0.0.1" "$profile_name :$local_port"
    fi
    if ! run_ndmc "interface $candidate up"; then
      fail "Не удалось включить интерфейс $candidate" "$CMD_OUTPUT"
    fi
  else
    if ! run_ndmc "interface $candidate down"; then
      fail "Не удалось выключить интерфейс $candidate" "$CMD_OUTPUT"
    fi
  fi

  echo "$candidate" >> "$ASSIGNED_FILE"
  echo "$profile_id|$candidate|$profile_name|$enabled|$local_port" >> "$NEW_MAP_FILE"
  echo "$profile_id|$candidate|$profile_name|$enabled|$local_port" >> "$MAPPINGS_FILE"
done < "$TMP_INPUT"

if [ -s "$OLD_MAP_FILE" ]; then
  while IFS='|' read -r old_id old_proxy old_name old_enabled old_port; do
    old_proxy=$(normalize_proxy_id "$old_proxy")
    [ -n "$old_id" ] || continue
    [ -n "$old_proxy" ] || continue

    if grep -Fxq "$old_id" "$DESIRED_IDS_FILE"; then
      continue
    fi
    if proxy_taken "$old_proxy"; then
      continue
    fi

    run_ndmc "no interface $old_proxy" >/dev/null 2>&1 || true
    echo "$old_proxy" >> "$REMOVED_FILE"
  done < "$OLD_MAP_FILE"
fi

if ! ndmc -c 'system configuration save' >/tmp/router-proxy-sync-save.$$ 2>&1; then
  details=$(cat /tmp/router-proxy-sync-save.$$ 2>/dev/null)
  rm -f /tmp/router-proxy-sync-save.$$
  fail "Не удалось сохранить конфигурацию Keenetic" "$details"
fi
rm -f /tmp/router-proxy-sync-save.$$

cp "$NEW_MAP_FILE" "$MAP_FILE"

printf '{'
printf '"ok":true,'
printf '"message":"Прокси Keenetic синхронизированы.",'
printf '"mapPath":"%s",' "$(json_escape "$MAP_FILE")"
printf '"backupPath":"%s",' "$(json_escape "$MAP_BACKUP_PATH")"
printf '"runningConfigBackupPath":"%s",' "$(json_escape "$RUNCFG_BACKUP_PATH")"
printf '"runtime":"%s",' ""
printf '"mappings":['

first_mapping=1
while IFS='|' read -r profile_id proxy_id profile_name enabled local_port; do
  [ -n "$profile_id" ] || continue
  if [ "$first_mapping" -eq 0 ]; then
    printf ','
  fi
  first_mapping=0
  printf '{'
  printf '"id":"%s",' "$(json_escape "$profile_id")"
  printf '"routerProxyId":"%s",' "$(json_escape "$proxy_id")"
  printf '"name":"%s",' "$(json_escape "$profile_name")"
  printf '"enabled":%s,' "$(bool_json "$enabled")"
  printf '"localPort":%s' "$(printf '%s' "$local_port" | tr -cd '0-9')"
  printf '}'
done < "$MAPPINGS_FILE"

printf '],"removed":['
first_removed=1
while IFS= read -r proxy_id; do
  [ -n "$proxy_id" ] || continue
  if [ "$first_removed" -eq 0 ]; then
    printf ','
  fi
  first_removed=0
  printf '"%s"' "$(json_escape "$proxy_id")"
done < "$REMOVED_FILE"
printf ']'
printf '}'

cleanup
