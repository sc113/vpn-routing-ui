#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

strip_quotes() {
  printf '%s' "$1" | sed 's/^"//; s/"$//'
}

sort_rules_file() {
  awk -F'|' '
  function group_order(group_id, value) {
    value = group_id
    sub(/^domain-list/, "", value)
    return value + 0
  }
  {
    target = $3
    priority = 2
    if (target ~ /^Proxy[0-9]+$/) {
      priority = 0
    } else if (target != "") {
      priority = 1
    }
    printf "%d|%09d|%s\n", priority, group_order($1), $0
  }
  ' "$1" | sort -t'|' -k1,1n -k2,2n | cut -d'|' -f3- > "$1.tmp" &&
    mv "$1.tmp" "$1"
}

cleanup() {
  rm -f "$RUNCFG_FILE" "$GROUPS_FILE" "$ROUTES_FILE" "$PROXIES_FILE" "$INCLUDES_FILE" "$COUNTS_FILE" "$RULES_FILE" "$RULES_JOIN_FILE"
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
RUNCFG_FILE="/opt/tmp/router-dns-routes-running-$$.txt"
GROUPS_FILE="/opt/tmp/router-dns-routes-groups-$$.txt"
ROUTES_FILE="/opt/tmp/router-dns-routes-current-$$.txt"
PROXIES_FILE="/opt/tmp/router-dns-routes-proxies-$$.txt"
INCLUDES_FILE="/opt/tmp/router-dns-routes-includes-$$.txt"
COUNTS_FILE="/opt/tmp/router-dns-routes-counts-$$.txt"
RULES_FILE="/opt/tmp/router-dns-routes-rules-$$.txt"
RULES_JOIN_FILE="/opt/tmp/router-dns-routes-rules-join-$$.txt"

mkdir -p /opt/tmp

if ! ndmc -c 'show running-config' > "$RUNCFG_FILE" 2>/tmp/router-dns-routes-show.$$; then
  details=$(cat /tmp/router-dns-routes-show.$$ 2>/dev/null)
  rm -f /tmp/router-dns-routes-show.$$
  fail "Не удалось прочитать running-config Keenetic" "$details"
fi
rm -f /tmp/router-dns-routes-show.$$

awk '
$1 == "object-group" && $2 == "fqdn" && $3 ~ /^domain-list[0-9]+$/ {
  if (group != "") {
    print group "|" desc
  }
  group = $3
  desc = ""
  next
}
group != "" && $1 == "description" {
  sub(/^[ \t]*description[ \t]*/, "")
  desc = $0
  next
}
group != "" && $1 == "!" {
  print group "|" desc
  group = ""
  desc = ""
  next
}
END {
  if (group != "") {
    print group "|" desc
  }
}
' "$RUNCFG_FILE" > "$GROUPS_FILE"

awk '
$1 == "object-group" && $2 == "fqdn" && $3 ~ /^domain-list[0-9]+$/ {
  group = $3
  next
}
group != "" && $1 == "include" {
  sub(/^[ \t]*include[ \t]*/, "")
  print group "|" $0
  next
}
group != "" && $1 == "!" {
  group = ""
  next
}
' "$RUNCFG_FILE" > "$INCLUDES_FILE"

awk -F'|' '
{
  counts[$1]++
}
END {
  for (group in counts) {
    print group "|" counts[group]
  }
}
' "$INCLUDES_FILE" > "$COUNTS_FILE"

awk '
$1 == "route" && $2 == "object-group" && $3 ~ /^domain-list[0-9]+$/ && $4 ~ /^[A-Za-z0-9_.\/-]+$/ {
  print $3 "|" $4
}
' "$RUNCFG_FILE" > "$ROUTES_FILE"

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
' "$RUNCFG_FILE" > "$PROXIES_FILE"

awk -F'|' -v routes_file="$ROUTES_FILE" '
FILENAME == routes_file {
  route[$1] = $2
  next
}
{
  print $1 "|" $2 "|" route[$1]
}
' "$ROUTES_FILE" "$GROUPS_FILE" > "$RULES_JOIN_FILE"

awk -F'|' -v counts_file="$COUNTS_FILE" '
FILENAME == counts_file {
  counts[$1] = $2
  next
}
{
  print $1 "|" $2 "|" $3 "|" (counts[$1] + 0)
}
' "$COUNTS_FILE" "$RULES_JOIN_FILE" > "$RULES_FILE"

sort_rules_file "$RULES_FILE"

printf '{"ok":true,"rules":['
first=1
while IFS='|' read -r group_id description current_proxy include_count || [ -n "$group_id$description" ]; do
  [ -n "$group_id" ] || continue
  description=$(strip_quotes "$description")
  include_count=$(printf '%s' "$include_count" | tr -cd '0-9')
  [ -n "$include_count" ] || include_count=0

  if [ "$first" -eq 0 ]; then
    printf ','
  fi
  first=0

  printf '{'
  printf '"groupId":"%s",' "$(json_escape "$group_id")"
  printf '"description":"%s",' "$(json_escape "$description")"
  printf '"proxyId":"%s",' "$(json_escape "$current_proxy")"
  printf '"includeCount":%s,' "$include_count"
  printf '"includes":['
  include_first=1
  include_shown=0
  while IFS='|' read -r include_group include_domain || [ -n "$include_group$include_domain" ]; do
    [ "$include_group" = "$group_id" ] || continue
    [ "$include_shown" -lt 8 ] || continue
    if [ "$include_first" -eq 0 ]; then
      printf ','
    fi
    include_first=0
    include_shown=$((include_shown + 1))
    printf '"%s"' "$(json_escape "$include_domain")"
  done < "$INCLUDES_FILE"
  printf ']'
  printf '}'
done < "$RULES_FILE"
printf '],"proxies":['
first=1
while IFS='|' read -r proxy_id proxy_name proxy_port proxy_state || [ -n "$proxy_id$proxy_name$proxy_port$proxy_state" ]; do
  [ -n "$proxy_id" ] || continue
  proxy_name=$(strip_quotes "$proxy_name")
  proxy_port=$(printf '%s' "$proxy_port" | tr -cd '0-9')
  [ -n "$proxy_port" ] || proxy_port=0
  enabled=false
  if [ "$proxy_state" = "up" ]; then
    enabled=true
  fi

  if [ "$first" -eq 0 ]; then
    printf ','
  fi
  first=0

  printf '{'
  printf '"proxyId":"%s",' "$(json_escape "$proxy_id")"
  printf '"name":"%s",' "$(json_escape "$proxy_name")"
  printf '"port":%s,' "$proxy_port"
  printf '"enabled":%s' "$enabled"
  printf '}'
done < "$PROXIES_FILE"
printf ']}'

cleanup
