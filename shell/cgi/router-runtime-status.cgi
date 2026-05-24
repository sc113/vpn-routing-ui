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

cleanup() {
  rm -f "$RUNCFG_FILE" "$PROXIES_FILE" "$PROCESS_FILE" "$SOCKETS_FILE" "$CONNECTIONS_FILE" "$SHOW_DIR"/proxy-*.txt 2>/dev/null
  rmdir "$SHOW_DIR" 2>/dev/null || true
}

fail() {
  cleanup
  printf '{"ok":false,"error":"%s","details":"%s"}' "$(json_escape "$1")" "$(json_escape "$2")"
  exit 0
}

sanitize_stream() {
  tr -d '\033' | sed 's/\[[0-9;]*[A-Za-z]//g'
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

show_ipv4_address() {
  file_path="$1"
  awk -F: '
    {
      key = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key == "address") {
        value = substr($0, index($0, ":") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        if (value ~ /^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$/) {
          print value
          exit
        }
      }
    }
  ' "$file_path"
}

is_ignored_ipv6_endpoint() {
  case "$1" in
    fe80:*|FE80:*|fd*:*|FD*:*) return 0 ;;
    *) return 1 ;;
  esac
}

summary_value() {
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

normalize_proxy_id() {
  case "$1" in
    Proxy[0-9]*) printf '%s' "$1" ;;
    *) printf '' ;;
  esac
}

find_listener_host() {
  wanted_port=$(printf '%s' "$1" | tr -cd '0-9')
  [ -n "$wanted_port" ] || return 1
  [ -f "$SOCKETS_FILE" ] || return 1

  host=$(awk -v wanted_port="$wanted_port" '
    {
      split($4, parts, ":")
      endpoint_host = parts[1]
      endpoint_port = parts[length(parts)]
      if (endpoint_port == wanted_port) {
        if (endpoint_host == "192.168.1.1") {
          found = 1
          print endpoint_host
          exit
        }
        if (fallback == "" && endpoint_host == "127.0.0.1") {
          fallback = endpoint_host
        } else if (fallback == "" && endpoint_host != "0.0.0.0") {
          fallback = endpoint_host
        }
      }
    }
    END {
      if (!found && fallback != "") {
        print fallback
      }
    }
  ' "$SOCKETS_FILE")

  [ -n "$host" ] || return 1
  printf '%s' "$host"
}

loopback_connection_count() {
  wanted_port=$(printf '%s' "$1" | tr -cd '0-9')
  [ -n "$wanted_port" ] || {
    printf '0'
    return 0
  }
  [ -f "$CONNECTIONS_FILE" ] || {
    printf '0'
    return 0
  }

  awk -v port=":$wanted_port" '
    $5 ~ port && ($4 ~ /127[.]0[.]0[.]1/ || $4 ~ /::ffff:127[.]0[.]0[.]1/) && $6 != "LISTEN" {
      count++
    }
    END { print count + 0 }
  ' "$CONNECTIONS_FILE"
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH_HELPER=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)/bin/ui-paths.sh
if [ -f "$PATH_HELPER" ]; then
  . "$PATH_HELPER"
fi
PROFILE_DIR="${VPN_ROUTING_UI_STATE_DIR:-/opt/etc/vpn-routing-ui}"
MAP_FILE="$PROFILE_DIR/router-proxies.map"
RUNCFG_FILE="/opt/tmp/router-runtime-running-$$.txt"
PROXIES_FILE="/opt/tmp/router-runtime-proxies-$$.txt"
PROCESS_FILE="/opt/tmp/router-runtime-processes-$$.txt"
SOCKETS_FILE="/opt/tmp/router-runtime-sockets-$$.txt"
CONNECTIONS_FILE="/opt/tmp/router-runtime-connections-$$.txt"
SHOW_DIR="/opt/tmp/router-runtime-show-$$"

mkdir -p /opt/tmp "$SHOW_DIR"

if [ -s "$MAP_FILE" ]; then
  awk -F'|' '
    {
      proxy = $2
      name = $3
      enabled = $4
      port = $5
      if (proxy ~ /^Proxy[0-9]+$/ && !(proxy in seen)) {
        seen[proxy] = 1
        print proxy "|" name "|" port "|" enabled
      }
    }
  ' "$MAP_FILE" > "$PROXIES_FILE"
else
  if ! ndmc -c 'show running-config' > "$RUNCFG_FILE" 2>/tmp/router-runtime-show.$$; then
    details=$(cat /tmp/router-runtime-show.$$ 2>/dev/null)
    rm -f /tmp/router-runtime-show.$$
    fail "Не удалось прочитать running-config Keenetic" "$details"
  fi
  rm -f /tmp/router-runtime-show.$$

  awk '
  $1 == "interface" && $2 ~ /^Proxy[0-9]+$/ {
    if (iface != "") {
      print iface "|" desc "|" port "|" configured_up
    }
    iface = $2
    desc = ""
    port = ""
    configured_up = 0
    next
  }
  iface != "" && $1 == "!" {
    print iface "|" desc "|" port "|" configured_up
    iface = ""
    desc = ""
    port = ""
    configured_up = 0
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
    configured_up = 1
    next
  }
  END {
    if (iface != "") {
      print iface "|" desc "|" port "|" configured_up
    }
  }
  ' "$RUNCFG_FILE" > "$PROXIES_FILE"
fi

ps | grep '[h]ev-socks5-tunnel' | grep 'proxy-cfg-t2s' > "$PROCESS_FILE" 2>/dev/null || true
if command -v ss >/dev/null 2>&1; then
  ss -lnt 2>/dev/null > "$SOCKETS_FILE" || true
else
  netstat -lnt 2>/dev/null > "$SOCKETS_FILE" || true
fi
netstat -anp 2>/dev/null > "$CONNECTIONS_FILE" || true

printf '{"ok":true,"proxies":['
first_proxy=1
while IFS='|' read -r proxy_id proxy_name upstream_port configured_up || [ -n "$proxy_id$proxy_name$upstream_port$configured_up" ]; do
  [ -n "$proxy_id" ] || continue
  proxy_id=$(normalize_proxy_id "$proxy_id")
  [ -n "$proxy_id" ] || continue
  proxy_name=$(printf '%s' "$proxy_name" | sed 's/^"//; s/"$//')
  proxy_index=$(printf '%s' "$proxy_id" | sed 's/^Proxy//')
  show_file="$SHOW_DIR/proxy-$proxy_id.txt"
  if ndmc -c "show interface $proxy_id" 2>/tmp/router-runtime-iface.$$ | sanitize_stream > "$show_file"; then
    :
  else
    cat /tmp/router-runtime-iface.$$ 2>/dev/null | sanitize_stream > "$show_file"
  fi
  rm -f /tmp/router-runtime-iface.$$

  link_state=$(show_value "$show_file" "link")
  connected_state=$(show_value "$show_file" "connected")
  iface_state=$(show_value "$show_file" "state")
  iface_address=$(show_ipv4_address "$show_file")
  iface_uptime=$(show_value "$show_file" "uptime")
  local_endpoint=$(show_value "$show_file" "local-endpoint-address")
  remote_endpoint=$(show_value "$show_file" "remote-endpoint-address")
  ctrl_state=$(summary_value "$show_file" "ctrl")
  upstream_host=$(find_listener_host "$upstream_port")
  if [ -n "$remote_endpoint" ] && [ "$remote_endpoint" != "0.0.0.0" ] && ! is_ignored_ipv6_endpoint "$remote_endpoint"; then
    upstream_host="$remote_endpoint"
  fi
  has_process=0
  process_pid=$(awk -v cfg="/var/run/proxy-cfg-t2s$proxy_index" '$0 ~ cfg { print $1; exit }' "$PROCESS_FILE")
  if [ -n "$process_pid" ]; then
    has_process=1
  fi
  loopback_count=$(loopback_connection_count "$upstream_port")

  healthy=0
  if [ "$configured_up" = "1" ] && [ "$link_state" = "up" ] && [ "$connected_state" = "yes" ] && [ "$ctrl_state" = "running" ] && [ "$has_process" = "1" ]; then
    healthy=1
  fi

  if [ "$first_proxy" -eq 0 ]; then
    printf ','
  fi
  first_proxy=0

  printf '{'
  printf '"proxyId":"%s",' "$(json_escape "$proxy_id")"
  printf '"name":"%s",' "$(json_escape "$proxy_name")"
  printf '"upstreamHost":"%s",' "$(json_escape "$upstream_host")"
  printf '"upstreamPort":%s,' "$(printf '%s' "$upstream_port" | tr -cd '0-9')"
  printf '"configuredUp":%s,' "$(bool_json "$configured_up")"
  printf '"link":"%s",' "$(json_escape "$link_state")"
  printf '"connected":"%s",' "$(json_escape "$connected_state")"
  printf '"state":"%s",' "$(json_escape "$iface_state")"
  printf '"ctrl":"%s",' "$(json_escape "$ctrl_state")"
  printf '"address":"%s",' "$(json_escape "$iface_address")"
  printf '"uptime":"%s",' "$(json_escape "$iface_uptime")"
  printf '"localEndpoint":"%s",' "$(json_escape "$local_endpoint")"
  printf '"remoteEndpoint":"%s",' "$(json_escape "$remote_endpoint")"
  printf '"pid":"%s",' "$(json_escape "$process_pid")"
  printf '"loopbackConnections":%s,' "$(printf '%s' "$loopback_count" | tr -cd '0-9')"
  printf '"hasProcess":%s,' "$(bool_json "$has_process")"
  printf '"healthy":%s' "$(bool_json "$healthy")"
  printf '}'
done < "$PROXIES_FILE"
printf ']}'

cleanup
