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

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUNCFG_FILE="/opt/tmp/router-proxies-$$.txt"

if ! ndmc -c 'show running-config' > "$RUNCFG_FILE" 2>/tmp/router-proxies-show.$$; then
  details=$(cat /tmp/router-proxies-show.$$ 2>/dev/null)
  rm -f /tmp/router-proxies-show.$$ "$RUNCFG_FILE"
  printf '{"ok":false,"error":"%s"}' "$(json_escape "${details:-Не удалось прочитать running-config}")"
  exit 0
fi
rm -f /tmp/router-proxies-show.$$

PROXY_FILE="/opt/tmp/router-proxies-list-$$.txt"
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
' "$RUNCFG_FILE" > "$PROXY_FILE"

printf '{'
printf '"ok":true,"proxies":['

first=1
while IFS='|' read -r proxy_id proxy_name proxy_port proxy_state; do
  [ -n "$proxy_id" ] || continue
  if [ "$first" -eq 0 ]; then
    printf ','
  fi
  first=0

  enabled=0
  if [ "$proxy_state" = "up" ]; then
    enabled=1
  fi

  printf '{'
  printf '"proxyId":"%s",' "$(json_escape "$proxy_id")"
  printf '"name":"%s",' "$(json_escape "$proxy_name")"
  printf '"port":%s,' "$(printf '%s' "$proxy_port" | tr -cd '0-9')"
  printf '"enabled":%s' "$(bool_json "$enabled")"
  printf '}'
done < "$PROXY_FILE"

printf ']}'

rm -f "$RUNCFG_FILE" "$PROXY_FILE"
