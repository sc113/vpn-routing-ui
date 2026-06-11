#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

MANAGED_POLICY_PREFIX="DeviceFull-"

normalize_proxy_id() {
  case "$1" in
    Proxy[0-9]*) printf '%s' "$1" ;;
    *) printf '' ;;
  esac
}

normalize_mac() {
  text=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '\r')
  case "$text" in
    [0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f])
      printf '%s' "$text"
      ;;
    *)
      printf ''
      ;;
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

run_ndmc() {
  ndmc -c "$1" </dev/null >/tmp/router-client-policies-cmd.$$ 2>&1
  code=$?
  CMD_OUTPUT=$(cat /tmp/router-client-policies-cmd.$$ 2>/dev/null)
  rm -f /tmp/router-client-policies-cmd.$$
  return $code
}

fetch_url() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$1"
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
    return $?
  fi
  return 1
}

build_fallback_hosts() {
  ip neigh show 2>/dev/null > "$NEIGH_FILE" || : > "$NEIGH_FILE"
  ndmc -c 'show ip dhcp binding' > "$DHCP_FILE" 2>/dev/null || : > "$DHCP_FILE"
  ndmc -c 'show associations' > "$ASSOC_FILE" 2>/dev/null || : > "$ASSOC_FILE"
  awk '
  function is_mac(value) {
    return value ~ /^([0-9a-f][0-9a-f]:){5}[0-9a-f][0-9a-f]$/
  }
  function is_lan_dev(value) {
    return value ~ /^(br[0-9]+|Bridge[0-9]+|Home|ra[0-9.]*|apcli[0-9.]*)$/
  }
  function json_string(value) {
    gsub(/\\/, "\\\\", value)
    gsub(/"/, "\\\"", value)
    gsub(/\r/, "", value)
    gsub(/\n/, " ", value)
    return value
  }
  function remember_host(mac_value, ip_value, hostname_value, name_value) {
    mac_value = tolower(mac_value)
    if (!is_mac(mac_value)) {
      return
    }
    seen[mac_value] = 1
    if (ip_value != "" && ip[mac_value] == "") {
      ip[mac_value] = ip_value
    }
    if (hostname_value != "" && hostname[mac_value] == "") {
      hostname[mac_value] = hostname_value
    }
    if (name_value != "" && name[mac_value] == "") {
      name[mac_value] = name_value
    }
  }
  function flush_lease() {
    remember_host(lease_mac, lease_ip, lease_hostname, lease_name)
    lease_ip = ""
    lease_mac = ""
    lease_hostname = ""
    lease_name = ""
  }
  function print_host(mac, ip, active, first) {
    if (!first) {
      printf ","
    }
    printf "{\"mac\":\"%s\",\"ip\":\"%s\",\"hostname\":\"%s\",\"name\":\"%s\",\"active\":%s,\"link\":\"%s\",\"interface\":{\"description\":\"%s\"}}",
      mac,
      json_string(ip),
      json_string(hostname[mac]),
      json_string(name[mac]),
      active ? "true" : "false",
      active ? "up" : "",
      active ? "Keenetic DHCP / Wi-Fi" : "Keenetic DHCP"
  }
  FILENAME == run_file {
    if ($1 == "ip" && $2 == "hotspot") {
      in_hotspot = 1
      next
    }
    if (in_hotspot && $1 == "!") {
      in_hotspot = 0
      next
    }
    if (in_hotspot && $1 == "host") {
      mac = tolower($2)
      if (is_mac(mac)) {
        seen[mac] = 1
      }
    }
    if ($1 == "ip" && $2 == "dhcp" && $3 == "host") {
      remember_host($4, $5, "", "")
      next
    }
    next
  }
  FILENAME == dhcp_file {
    if ($1 == "lease:") {
      flush_lease()
      next
    }
    if ($1 == "ip:") {
      lease_ip = $2
      next
    }
    if ($1 == "mac:" || $1 == "via:") {
      if (lease_mac == "") {
        lease_mac = tolower($2)
      }
      next
    }
    if ($1 == "hostname:") {
      sub(/^[ \t]*hostname:[ \t]*/, "")
      lease_hostname = $0
      next
    }
    if ($1 == "name:") {
      sub(/^[ \t]*name:[ \t]*/, "")
      lease_name = $0
      next
    }
    next
  }
  FILENAME == assoc_file {
    if ($1 == "mac:") {
      mac = tolower($2)
      if (is_mac(mac)) {
        seen[mac] = 1
        active[mac] = 1
      }
    }
    next
  }
  FILENAME == neigh_file {
    current_ip = $1
    current_mac = ""
    current_dev = ""
    current_state = $NF
    for (i = 1; i <= NF; i++) {
      if ($i == "lladdr" && (i + 1) <= NF) {
        current_mac = tolower($(i + 1))
      }
      if ($i == "dev" && (i + 1) <= NF) {
        current_dev = $(i + 1)
      }
    }
    if (current_ip ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && is_mac(current_mac) && is_lan_dev(current_dev)) {
      seen[current_mac] = 1
      if (ip[current_mac] == "") {
        ip[current_mac] = current_ip
      }
      if (current_state != "FAILED" && current_state != "INCOMPLETE") {
        active[current_mac] = 1
      }
    }
    next
  }
  END {
    flush_lease()
    first = 1
    printf "["
    for (mac in seen) {
      print_host(mac, ip[mac], active[mac], first)
      first = 0
    }
    printf "]"
  }
  ' \
    -v run_file="$RUNCFG_FILE" \
    -v neigh_file="$NEIGH_FILE" \
    -v dhcp_file="$DHCP_FILE" \
    -v assoc_file="$ASSOC_FILE" \
    "$RUNCFG_FILE" "$DHCP_FILE" "$ASSOC_FILE" "$NEIGH_FILE" > "$HOSTS_FILE"
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_HELD=1
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi
  fail "Операция с клиентскими policy уже выполняется" "Дождись завершения другой операции и попробуй ещё раз."
}

cleanup() {
  rm -f \
    "$TMP_INPUT" \
    "$RUNCFG_FILE" \
    "$HOSTS_FILE" \
    "$NEIGH_FILE" \
    "$DHCP_FILE" \
    "$ASSOC_FILE" \
    "$POLICIES_FILE" \
    "$ASSIGNMENTS_FILE" \
    /tmp/router-client-policies-show.$$ \
    /tmp/router-client-policies-save.$$
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

emit_state() {
  if ! ndmc -c 'show running-config' > "$RUNCFG_FILE" 2>/tmp/router-client-policies-show.$$; then
    details=$(cat /tmp/router-client-policies-show.$$ 2>/dev/null)
    rm -f /tmp/router-client-policies-show.$$
    fail "Не удалось прочитать running-config Keenetic" "$details"
  fi
  rm -f /tmp/router-client-policies-show.$$

  if ! fetch_url "http://127.0.0.1:79/rci/show/ip/hotspot/host" > "$HOSTS_FILE" 2>/dev/null; then
    : > "$HOSTS_FILE"
  fi
  if [ ! -s "$HOSTS_FILE" ] || ! grep -q '^[[:space:]]*\[' "$HOSTS_FILE" || ! grep -q '"mac"' "$HOSTS_FILE"; then
    build_fallback_hosts
  fi

  awk '
  $1 == "ip" && $2 == "policy" {
    if (policy != "") {
      print policy "|" desc "|" proxy
    }
    policy = $3
    desc = ""
    proxy = ""
    next
  }
  policy != "" && $1 == "description" {
    sub(/^[ \t]*description[ \t]*/, "")
    desc = $0
    next
  }
  policy != "" && $1 == "permit" && $2 == "global" && $3 ~ /^Proxy[0-9]+$/ {
    proxy = $3
    next
  }
  policy != "" && $1 == "!" {
    print policy "|" desc "|" proxy
    policy = ""
    desc = ""
    proxy = ""
    next
  }
  END {
    if (policy != "") {
      print policy "|" desc "|" proxy
    }
  }
  ' "$RUNCFG_FILE" > "$POLICIES_FILE"

  awk '
  $1 == "ip" && $2 == "hotspot" {
    in_hotspot = 1
    next
  }
  in_hotspot && $1 == "!" {
    in_hotspot = 0
    next
  }
  in_hotspot && $1 == "host" && $2 ~ /^([0-9a-f][0-9a-f]:){5}[0-9a-f][0-9a-f]$/ && $3 == "policy" {
    print $2 "|" $4
  }
  ' "$RUNCFG_FILE" > "$ASSIGNMENTS_FILE"

  printf '{'
  printf '"ok":true,'
  printf '"hosts":'
  cat "$HOSTS_FILE"
  printf ',"policies":['

  first_policy=1
  while IFS='|' read -r policy_id policy_desc proxy_id; do
    [ -n "$policy_id" ] || continue
    if [ "$first_policy" -eq 0 ]; then
      printf ','
    fi
    first_policy=0
    printf '{'
    printf '"id":"%s",' "$(json_escape "$policy_id")"
    printf '"description":"%s",' "$(json_escape "$policy_desc")"
    printf '"proxyId":"%s",' "$(json_escape "$proxy_id")"
    case "$policy_id" in
      [[:alnum:]]*Full-Proxy[0-9]*)
        printf '"managed":true'
        ;;
      *)
        printf '"managed":false'
        ;;
    esac
    printf '}'
  done < "$POLICIES_FILE"

  printf '],"assignments":['
  first_assignment=1
  while IFS='|' read -r mac policy_id; do
    [ -n "$mac" ] || continue
    [ -n "$policy_id" ] || continue
    if [ "$first_assignment" -eq 0 ]; then
      printf ','
    fi
    first_assignment=0
    printf '{'
    printf '"mac":"%s",' "$(json_escape "$mac")"
    printf '"policyId":"%s"' "$(json_escape "$policy_id")"
    printf '}'
  done < "$ASSIGNMENTS_FILE"
  printf ']}'
}

cleanup_unused_managed_policies() {
  if ! ndmc -c 'show running-config' > "$RUNCFG_FILE" 2>/tmp/router-client-policies-show.$$; then
    details=$(cat /tmp/router-client-policies-show.$$ 2>/dev/null)
    rm -f /tmp/router-client-policies-show.$$
    fail "Не удалось перепроверить running-config Keenetic" "$details"
  fi
  rm -f /tmp/router-client-policies-show.$$

  awk '
  $1 == "ip" && $2 == "policy" {
    current = $3
    next
  }
  current != "" && $1 == "!" {
    if (current ~ /^[[:alnum:]]+Full-Proxy[0-9]+$/) {
      print current
    }
    current = ""
    next
  }
  END {
    if (current ~ /^[[:alnum:]]+Full-Proxy[0-9]+$/) {
      print current
    }
  }
  ' "$RUNCFG_FILE" | while IFS= read -r policy_id; do
    [ -n "$policy_id" ] || continue
    if ! grep -q "host .* policy $policy_id\$" "$RUNCFG_FILE"; then
      run_ndmc "no ip policy $policy_id" >/dev/null 2>&1 || true
    fi
  done
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
LOCK_DIR="$PROFILE_DIR/client-policies.lock"
TMP_INPUT="/opt/tmp/router-client-policies-$$.txt"
RUNCFG_FILE="/opt/tmp/router-client-policies-running-$$.txt"
HOSTS_FILE="/opt/tmp/router-client-policies-hosts-$$.json"
NEIGH_FILE="/opt/tmp/router-client-policies-neigh-$$.txt"
DHCP_FILE="/opt/tmp/router-client-policies-dhcp-$$.txt"
ASSOC_FILE="/opt/tmp/router-client-policies-assoc-$$.txt"
POLICIES_FILE="/opt/tmp/router-client-policies-policies-$$.txt"
ASSIGNMENTS_FILE="/opt/tmp/router-client-policies-assignments-$$.txt"

mkdir -p "$PROFILE_DIR" "$BACKUP_DIR" /opt/tmp
LOCK_HELD=0
trap cleanup EXIT INT TERM HUP

if [ "$REQUEST_METHOD" = "POST" ]; then
  acquire_lock
fi

if [ "$REQUEST_METHOD" = "POST" ]; then
  cat > "$TMP_INPUT"
  if [ ! -s "$TMP_INPUT" ]; then
    fail "Пустое тело запроса" ""
  fi

  if ! ndmc -c 'show running-config' > "$RUNCFG_FILE" 2>/tmp/router-client-policies-show.$$; then
    details=$(cat /tmp/router-client-policies-show.$$ 2>/dev/null)
    rm -f /tmp/router-client-policies-show.$$
    fail "Не удалось прочитать running-config Keenetic" "$details"
  fi
  rm -f /tmp/router-client-policies-show.$$

  STAMP=$(date +%Y%m%d-%H%M%S)
  BACKUP_PATH="$BACKUP_DIR/ndmc-running-config-$STAMP-before-client-policy-sync.txt"
  cp "$RUNCFG_FILE" "$BACKUP_PATH" || fail "Не удалось сохранить backup running-config" "$BACKUP_PATH"

  IFS='|' read -r record_type raw_mac raw_proxy name_b64 < "$TMP_INPUT"
  record_type=$(printf '%s' "$record_type" | tr -d '\r')
  raw_mac=$(printf '%s' "$raw_mac" | tr -d '\r')
  raw_proxy=$(printf '%s' "$raw_proxy" | tr -d '\r')
  name_b64=$(printf '%s' "$name_b64" | tr -d '\r')

  [ "$record_type" = "H" ] || fail "Неверный формат запроса для client policy" "$record_type"

  mac=$(normalize_mac "$raw_mac")
  [ -n "$mac" ] || fail "Неверный MAC-адрес клиента" "$raw_mac"

  proxy_id=$(normalize_proxy_id "$raw_proxy")
  if [ -n "$raw_proxy" ] && [ -z "$proxy_id" ]; then
    fail "Полный маршрут можно назначить только на ProxyN" "$raw_proxy"
  fi

  profile_name=$(sanitize_name "$(decode_name "$name_b64")")
  [ -n "$profile_name" ] || profile_name="$proxy_id"

  if [ -n "$proxy_id" ]; then
    grep -q "^interface $proxy_id\$" "$RUNCFG_FILE" || fail "Указанный ProxyN не существует на роутере" "$proxy_id"

    policy_id="${MANAGED_POLICY_PREFIX}${proxy_id}"
    policy_desc="Полный маршрут через $profile_name"

    if ! run_ndmc "ip policy $policy_id"; then
      fail "Не удалось создать или открыть policy $policy_id" "$CMD_OUTPUT"
    fi
    if ! run_ndmc "ip policy $policy_id description $policy_desc"; then
      fail "Не удалось сохранить описание policy $policy_id" "$CMD_OUTPUT"
    fi
    if ! run_ndmc "ip policy $policy_id permit global $proxy_id"; then
      fail "Не удалось направить policy $policy_id в $proxy_id" "$CMD_OUTPUT"
    fi
    if ! run_ndmc "ip hotspot host $mac policy $policy_id"; then
      fail "Не удалось назначить политику клиенту" "$CMD_OUTPUT"
    fi
    MESSAGE="Для клиента $mac включён полный маршрут через $profile_name."
  else
    if ! run_ndmc "no ip hotspot host $mac policy"; then
      fail "Не удалось снять полную маршрутизацию с клиента" "$CMD_OUTPUT"
    fi
    MESSAGE="Для клиента $mac включён обычный режим по DNS-правилам."
  fi

  cleanup_unused_managed_policies

  if ! ndmc -c 'system configuration save' >/tmp/router-client-policies-save.$$ 2>&1; then
    details=$(cat /tmp/router-client-policies-save.$$ 2>/dev/null)
    rm -f /tmp/router-client-policies-save.$$
    fail "Не удалось сохранить running-config Keenetic" "$details"
  fi
  rm -f /tmp/router-client-policies-save.$$

  printf '{'
  printf '"ok":true,'
  printf '"message":"%s",' "$(json_escape "$MESSAGE")"
  printf '"backupPath":"%s"' "$(json_escape "$BACKUP_PATH")"
  printf '}'
  cleanup
  exit 0
fi

emit_state
cleanup
