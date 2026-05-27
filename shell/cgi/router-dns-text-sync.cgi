#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

strip_quotes() {
  printf '%s' "$1" | sed 's/^"//; s/"$//'
}

query_value() {
  key="$1"
  printf '%s' "${QUERY_STRING:-}" | tr '&' '\n' | awk -F= -v key="$key" '$1 == key { print $2; exit }'
}

normalize_group_id() {
  case "$1" in
    domain-list[0-9]*) printf '%s' "$1" ;;
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

valid_include() {
  case "$1" in
    ""|*[!A-Za-z0-9._:/*-]*) return 1 ;;
    *) return 0 ;;
  esac
}

b64_encode() {
  if command -v base64 >/dev/null 2>&1; then
    printf '%s' "$1" | base64 | tr -d '\n'
  else
    printf '%s' "$1"
  fi
}

b64_decode() {
  if command -v base64 >/dev/null 2>&1; then
    printf '%s' "$1" | base64 -d 2>/dev/null || printf ''
  else
    printf '%s' "$1"
  fi
}

quote_ndmc_string() {
  printf '%s' "$1" | sed 's/\\/\\\\/g;s/"/\\"/g'
}

run_ndmc() {
  ndmc -c "$1" </dev/null > "$CMD_FILE" 2>&1
  code=$?
  CMD_OUTPUT=$(cat "$CMD_FILE" 2>/dev/null)
  : > "$CMD_FILE"
  return $code
}

route_lines_from_config() {
  awk '
  $1 == "route" && $2 == "object-group" && $3 ~ /^domain-list[0-9]+$/ && $4 ~ /^[A-Za-z0-9_.\/-]+$/ {
    print $3 "|" $4
  }
  ' "$1"
}

group_ids_from_config() {
  awk '
  $1 == "object-group" && $2 == "fqdn" && $3 ~ /^domain-list[0-9]+$/ {
    print $3
  }
  ' "$1"
}

sort_group_ids_file() {
  awk '
  function group_order(group_id, value) {
    value = group_id
    sub(/^domain-list/, "", value)
    return value + 0
  }
  NF { printf "%09d|%s\n", group_order($1), $1 }
  ' "$1" | sort -t'|' -k1,1n | cut -d'|' -f2- > "$1.tmp" &&
    mv "$1.tmp" "$1"
}

sort_routes_file() {
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
  fail "Операция DNS уже выполняется" "Дождись завершения другой DNS sync/reset операции и повтори снова. Активный PID: ${lock_pid:-unknown}."
}

cleanup() {
  rm -f "$RUNCFG_FILE" "$GROUPS_FILE" "$ROUTES_FILE" "$EXPORT_FILE" "$EXPORT_RAW_FILE" "$INPUT_FILE" \
    "$DESIRED_GROUPS_FILE" "$DESIRED_INCLUDES_FILE" "$DESIRED_ROUTES_FILE" "$DESIRED_DESCRIPTIONS_FILE" \
    "$STATE_TMP_FILE" "$CMD_FILE" "$DESIRED_GROUPS_FILE.tmp" "$DESIRED_ROUTES_FILE.tmp" "$DESIRED_DESCRIPTIONS_FILE.tmp" \
    "$STATE_TMP_FILE.tmp" "$GROUPS_FILE.tmp" "$ROUTES_FILE.tmp"
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

read_running_config() {
  if ! ndmc -c 'show running-config' > "$RUNCFG_FILE" 2>"$CMD_FILE"; then
    fail "Не удалось прочитать running-config Keenetic" "$(cat "$CMD_FILE" 2>/dev/null)"
  fi
  : > "$CMD_FILE"
}

export_dns_groups() {
  route_lines_from_config "$RUNCFG_FILE" > "$ROUTES_FILE"
  : > "$EXPORT_FILE"
  printf '# vpn-routing-ui dns-groups v1\n' >> "$EXPORT_FILE"
  printf '# G|domain-listN|base64(name/description)|route-target\n' >> "$EXPORT_FILE"
  printf '# I|domain-listN|include-value\n' >> "$EXPORT_FILE"
  printf '# generated %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)" >> "$EXPORT_FILE"

  awk '
  $1 == "object-group" && $2 == "fqdn" && $3 ~ /^domain-list[0-9]+$/ {
    if (group != "") {
      print "G|" group "|" desc
    }
    group = $3
    desc = ""
    next
  }
  group != "" && $1 == "description" {
    sub(/^[ \t]*description[ \t]*/, "")
    print "D|" group "|" $0
    next
  }
  group != "" && $1 == "include" {
    sub(/^[ \t]*include[ \t]*/, "")
    print "I|" group "|" $0
    next
  }
  group != "" && $1 == "!" {
    print "G|" group "|" desc
    group = ""
    desc = ""
    next
  }
  END {
    if (group != "") {
      print "G|" group "|" desc
    }
  }
  ' "$RUNCFG_FILE" | awk -F'|' '
  $1 == "D" {
    desc[$2] = $3
    next
  }
  $1 == "I" {
    includes[$2] = includes[$2] "\n" $3
    next
  }
  $1 == "G" {
    if (!seen[$2]++) {
      order[++count] = $2
    }
    next
  }
  END {
    for (i = 1; i <= count; i++) {
      print order[i] "|" desc[order[i]]
      item_count = split(includes[order[i]], item, "\n")
      for (j = 1; j <= item_count; j++) {
        if (item[j] != "") {
          print order[i] "|@include|" item[j]
        }
      }
    }
  }
  ' > "$EXPORT_RAW_FILE"

  while IFS='|' read -r group_id marker value || [ -n "$group_id$marker$value" ]; do
    [ -n "$group_id" ] || continue
    if [ "$marker" = "@include" ]; then
      printf 'I|%s|%s\n' "$group_id" "$value" >> "$EXPORT_FILE"
      continue
    fi
    route_target=$(awk -F'|' -v group_id="$group_id" '$1 == group_id { print $2; exit }' "$ROUTES_FILE")
    printf 'G|%s|%s|%s\n' "$group_id" "$(b64_encode "$(strip_quotes "$marker")")" "$route_target" >> "$EXPORT_FILE"
  done < "$EXPORT_RAW_FILE"
}

parse_dns_group_file() {
  : > "$DESIRED_GROUPS_FILE"
  : > "$DESIRED_INCLUDES_FILE"
  : > "$DESIRED_ROUTES_FILE"
  : > "$DESIRED_DESCRIPTIONS_FILE"

  line_no=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_no=$((line_no + 1))
    line=$(printf '%s' "$line" | tr -d '\r')
    case "$line" in
      ""|\#*) continue ;;
    esac

    record_type=${line%%|*}
    rest=${line#*|}
    case "$record_type" in
      G)
        group_id=${rest%%|*}
        rest=${rest#*|}
        raw_desc=${rest%%|*}
        raw_route=
        if [ "$rest" != "$raw_desc" ]; then
          raw_route=${rest#*|}
        fi
        group_id=$(normalize_group_id "$group_id")
        [ -n "$group_id" ] || fail "Некорректная DNS-группа в файле" "Строка $line_no: $line"
        route_target=$(normalize_route_target "$raw_route")
        [ -z "$raw_route" ] || [ -n "$route_target" ] || fail "Некорректный DNS-маршрут в файле" "Строка $line_no: $line"
        description=$(b64_decode "$raw_desc")
        awk -F'|' -v group_id="$group_id" '$1 != group_id { print $0 }' "$DESIRED_GROUPS_FILE" > "$DESIRED_GROUPS_FILE.tmp"
        mv "$DESIRED_GROUPS_FILE.tmp" "$DESIRED_GROUPS_FILE"
        printf '%s\n' "$group_id" >> "$DESIRED_GROUPS_FILE"
        awk -F'|' -v group_id="$group_id" '$1 != group_id { print $0 }' "$DESIRED_ROUTES_FILE" > "$DESIRED_ROUTES_FILE.tmp"
        mv "$DESIRED_ROUTES_FILE.tmp" "$DESIRED_ROUTES_FILE"
        printf '%s|%s\n' "$group_id" "$route_target" >> "$DESIRED_ROUTES_FILE"
        awk -F'|' -v group_id="$group_id" '$1 != group_id { print $0 }' "$DESIRED_DESCRIPTIONS_FILE" > "$DESIRED_DESCRIPTIONS_FILE.tmp"
        mv "$DESIRED_DESCRIPTIONS_FILE.tmp" "$DESIRED_DESCRIPTIONS_FILE"
        printf '%s|%s\n' "$group_id" "$description" >> "$DESIRED_DESCRIPTIONS_FILE"
        ;;
      I)
        group_id=${rest%%|*}
        include_value=${rest#*|}
        group_id=$(normalize_group_id "$group_id")
        [ -n "$group_id" ] || fail "Некорректная DNS-группа у include в файле" "Строка $line_no: $line"
        valid_include "$include_value" || fail "Некорректный include в файле" "Строка $line_no: $include_value"
        printf '%s|%s\n' "$group_id" "$include_value" >> "$DESIRED_INCLUDES_FILE"
        ;;
      *)
        fail "Неизвестная строка в DNS-файле" "Строка $line_no: $line"
        ;;
    esac
  done < "$INPUT_FILE"

  [ -s "$DESIRED_GROUPS_FILE" ] || fail "В DNS-файле нет групп" "Ожидался формат vpn-routing-ui dns-groups v1."
  missing_include_group=$(awk -F'|' 'NR == FNR { groups[$1] = 1; next } !groups[$1] { print $1; exit }' "$DESIRED_GROUPS_FILE" "$DESIRED_INCLUDES_FILE")
  [ -z "$missing_include_group" ] || fail "Include ссылается на отсутствующую DNS-группу" "$missing_include_group"
  sort_group_ids_file "$DESIRED_GROUPS_FILE"
  sort_routes_file "$DESIRED_ROUTES_FILE"
}

remove_current_route() {
  group_id="$1"
  route_target="$2"
  [ -n "$group_id" ] && [ -n "$route_target" ] || return 0
  if ! run_ndmc "no dns-proxy route object-group $group_id $route_target"; then
    case "$CMD_OUTPUT" in
      *"unable to find a route to"*) return 0 ;;
    esac
    fail "Не удалось снять старый DNS-маршрут" "$group_id -> $route_target: $CMD_OUTPUT"
  fi
}

apply_text_groups() {
  LOCK_HELD=0
  acquire_lock
  read_running_config
  route_lines_from_config "$RUNCFG_FILE" > "$ROUTES_FILE"
  group_ids_from_config "$RUNCFG_FILE" > "$GROUPS_FILE"
  sort_group_ids_file "$GROUPS_FILE"

  STAMP=$(date +%Y%m%d-%H%M%S)
  BACKUP_PATH="$BACKUP_DIR/ndmc-running-dns-text-$STAMP.txt"
  cp "$RUNCFG_FILE" "$BACKUP_PATH" || fail "Не удалось сохранить backup running-config" "$BACKUP_PATH"

  removed=0
  updated=0
  includes_applied=0
  routes_applied=0

  while IFS= read -r group_id || [ -n "$group_id" ]; do
    [ -n "$group_id" ] || continue
    if ! grep -Fxq "$group_id" "$DESIRED_GROUPS_FILE"; then
      current_route=$(awk -F'|' -v group_id="$group_id" '$1 == group_id { print $2; exit }' "$ROUTES_FILE")
      remove_current_route "$group_id" "$current_route"
      run_ndmc "no object-group fqdn $group_id" >/dev/null 2>&1 || true
      removed=$((removed + 1))
    fi
  done < "$GROUPS_FILE"

  while IFS= read -r group_id || [ -n "$group_id" ]; do
    [ -n "$group_id" ] || continue
    current_route=$(awk -F'|' -v group_id="$group_id" '$1 == group_id { print $2; exit }' "$ROUTES_FILE")
    desired_route=$(awk -F'|' -v group_id="$group_id" '$1 == group_id { print $2; exit }' "$DESIRED_ROUTES_FILE")
    description=$(awk -F'|' -v group_id="$group_id" '$1 == group_id { sub(/^[^|]*\|/, ""); print; exit }' "$DESIRED_DESCRIPTIONS_FILE")

    remove_current_route "$group_id" "$current_route"
    run_ndmc "no object-group fqdn $group_id" >/dev/null 2>&1 || true
    if ! run_ndmc "object-group fqdn $group_id"; then
      fail "Не удалось создать DNS-группу" "$group_id: $CMD_OUTPUT"
    fi
    if [ -n "$description" ]; then
      if ! run_ndmc "object-group fqdn $group_id description \"$(quote_ndmc_string "$description")\""; then
        fail "Не удалось сохранить описание DNS-группы" "$group_id: $CMD_OUTPUT"
      fi
    fi

    while IFS='|' read -r include_group include_value || [ -n "$include_group$include_value" ]; do
      [ "$include_group" = "$group_id" ] || continue
      if ! run_ndmc "object-group fqdn $group_id include $include_value"; then
        fail "Не удалось добавить include в DNS-группу" "$group_id -> $include_value: $CMD_OUTPUT"
      fi
      includes_applied=$((includes_applied + 1))
    done < "$DESIRED_INCLUDES_FILE"

    if [ -n "$desired_route" ]; then
      if ! run_ndmc "dns-proxy route object-group $group_id $desired_route auto reject"; then
        fail "Не удалось создать DNS-маршрут" "$group_id -> $desired_route: $CMD_OUTPUT"
      fi
      routes_applied=$((routes_applied + 1))
    fi
    updated=$((updated + 1))
  done < "$DESIRED_GROUPS_FILE"

  cp "$DESIRED_ROUTES_FILE" "$STATE_TMP_FILE" || fail "Не удалось подготовить состояние DNS-маршрутов" "$DESIRED_ROUTES_FILE"
  sort_routes_file "$STATE_TMP_FILE"
  cp "$STATE_TMP_FILE" "$ROUTE_STATE_FILE" || fail "Не удалось сохранить состояние DNS-маршрутов" "$ROUTE_STATE_FILE"

  if ! ndmc -c 'system configuration save' > "$CMD_FILE" 2>&1; then
    fail "Не удалось сохранить running-config Keenetic" "$(cat "$CMD_FILE" 2>/dev/null)"
  fi
  : > "$CMD_FILE"

  if ! run_ndmc "no dns-proxy intercept enable"; then
    fail "Не удалось отключить dns-proxy intercept" "$CMD_OUTPUT"
  fi
  sleep 2
  if ! run_ndmc "dns-proxy intercept enable"; then
    fail "Не удалось включить dns-proxy intercept" "$CMD_OUTPUT"
  fi

  printf '{"ok":true,"message":"DNS-файл сохранён на роутер.","updatedGroups":%s,"removedGroups":%s,"includesApplied":%s,"routesApplied":%s,"backupPath":"%s","statePath":"%s"}' \
    "$updated" "$removed" "$includes_applied" "$routes_applied" "$(json_escape "$BACKUP_PATH")" "$(json_escape "$ROUTE_STATE_FILE")"
  cleanup
  exit 0
}

apply_single_group() {
  LOCK_HELD=0
  acquire_lock
  read_running_config
  route_lines_from_config "$RUNCFG_FILE" > "$ROUTES_FILE"

  group_count=$(wc -l < "$DESIRED_GROUPS_FILE" | tr -d ' ')
  [ "$group_count" = "1" ] || fail "Для быстрого сохранения нужна ровно одна DNS-группа" "Получено групп: $group_count"

  group_id=$(cat "$DESIRED_GROUPS_FILE" | head -n 1)
  [ -n "$group_id" ] || fail "В DNS-файле нет группы" ""

  STAMP=$(date +%Y%m%d-%H%M%S)
  BACKUP_PATH="$BACKUP_DIR/ndmc-running-dns-group-$group_id-$STAMP.txt"
  cp "$RUNCFG_FILE" "$BACKUP_PATH" || fail "Не удалось сохранить backup running-config" "$BACKUP_PATH"

  current_route=$(awk -F'|' -v group_id="$group_id" '$1 == group_id { print $2; exit }' "$ROUTES_FILE")
  desired_route=$(awk -F'|' -v group_id="$group_id" '$1 == group_id { print $2; exit }' "$DESIRED_ROUTES_FILE")
  description=$(awk -F'|' -v group_id="$group_id" '$1 == group_id { sub(/^[^|]*\|/, ""); print; exit }' "$DESIRED_DESCRIPTIONS_FILE")
  desired_include_count=$(awk -F'|' -v group_id="$group_id" '$1 == group_id { count++ } END { print count + 0 }' "$DESIRED_INCLUDES_FILE")
  current_include_count=$(awk -v group_id="$group_id" '
  $1 == "object-group" && $2 == "fqdn" && $3 == group_id {
    inside = 1
    next
  }
  inside && $1 == "!" {
    inside = 0
    next
  }
  inside && $1 == "include" {
    count++
  }
  END {
    print count + 0
  }
  ' "$RUNCFG_FILE")
  allow_shrink=$(query_value "allowShrink")
  if [ "$current_include_count" -gt 0 ] 2>/dev/null &&
    [ "$desired_include_count" -lt "$current_include_count" ] 2>/dev/null &&
    [ "$allow_shrink" != "1" ]; then
    fail "Сохранение остановлено: DNS-группа стала меньше" "$group_id: сейчас $current_include_count хостов, в запросе $desired_include_count. Если это намеренное удаление, подтверди уменьшение ещё раз."
  fi

  remove_current_route "$group_id" "$current_route"
  run_ndmc "no object-group fqdn $group_id" >/dev/null 2>&1 || true
  if ! run_ndmc "object-group fqdn $group_id"; then
    fail "Не удалось создать DNS-группу" "$group_id: $CMD_OUTPUT"
  fi
  if [ -n "$description" ]; then
    if ! run_ndmc "object-group fqdn $group_id description \"$(quote_ndmc_string "$description")\""; then
      fail "Не удалось сохранить описание DNS-группы" "$group_id: $CMD_OUTPUT"
    fi
  fi

  includes_applied=0
  while IFS='|' read -r include_group include_value || [ -n "$include_group$include_value" ]; do
    [ "$include_group" = "$group_id" ] || continue
    if ! run_ndmc "object-group fqdn $group_id include $include_value"; then
      fail "Не удалось добавить хост в DNS-группу" "$group_id -> $include_value: $CMD_OUTPUT"
    fi
    includes_applied=$((includes_applied + 1))
  done < "$DESIRED_INCLUDES_FILE"

  routes_applied=0
  if [ -n "$desired_route" ]; then
    if ! run_ndmc "dns-proxy route object-group $group_id $desired_route auto reject"; then
      fail "Не удалось создать DNS-маршрут" "$group_id -> $desired_route: $CMD_OUTPUT"
    fi
    routes_applied=1
  fi

  awk -F'|' -v group_id="$group_id" '$1 != group_id { print $0 }' "$ROUTES_FILE" > "$STATE_TMP_FILE"
  if [ -n "$desired_route" ]; then
    printf '%s|%s\n' "$group_id" "$desired_route" >> "$STATE_TMP_FILE"
  fi
  sort_routes_file "$STATE_TMP_FILE"
  cp "$STATE_TMP_FILE" "$ROUTE_STATE_FILE" || fail "Не удалось сохранить состояние DNS-маршрутов" "$ROUTE_STATE_FILE"

  if ! ndmc -c 'system configuration save' > "$CMD_FILE" 2>&1; then
    fail "Не удалось сохранить running-config Keenetic" "$(cat "$CMD_FILE" 2>/dev/null)"
  fi
  : > "$CMD_FILE"

  if ! run_ndmc "no dns-proxy intercept enable"; then
    fail "Не удалось отключить dns-proxy intercept" "$CMD_OUTPUT"
  fi
  sleep 1
  if ! run_ndmc "dns-proxy intercept enable"; then
    fail "Не удалось включить dns-proxy intercept" "$CMD_OUTPUT"
  fi

  printf '{"ok":true,"message":"DNS-группа сохранена на роутер.","updatedGroups":1,"removedGroups":0,"includesApplied":%s,"routesApplied":%s,"groupId":"%s","backupPath":"%s","statePath":"%s"}' \
    "$includes_applied" "$routes_applied" "$(json_escape "$group_id")" "$(json_escape "$BACKUP_PATH")" "$(json_escape "$ROUTE_STATE_FILE")"
  cleanup
  exit 0
}

print_status_json() {
  export_text=$(cat "$EXPORT_FILE" 2>/dev/null)
  group_count=$(awk -F'|' '$1 == "G" { count++ } END { print count + 0 }' "$EXPORT_FILE")
  include_count=$(awk -F'|' '$1 == "I" { count++ } END { print count + 0 }' "$EXPORT_FILE")
  route_count=$(awk -F'|' '$1 == "G" && $4 != "" { count++ } END { print count + 0 }' "$EXPORT_FILE")
  printf '{"ok":true,"groupCount":%s,"includeCount":%s,"routeCount":%s,"exportText":"%s"}' \
    "$group_count" "$include_count" "$route_count" "$(json_escape "$export_text")"
}

print_parsed_json() {
  group_count=$(wc -l < "$DESIRED_GROUPS_FILE" | tr -d ' ')
  include_count=$(wc -l < "$DESIRED_INCLUDES_FILE" | tr -d ' ')
  route_count=$(awk -F'|' '$2 != "" { count++ } END { print count + 0 }' "$DESIRED_ROUTES_FILE")
  printf '{"ok":true,"message":"DNS-файл корректен.","groupCount":%s,"includeCount":%s,"routeCount":%s}' \
    "$group_count" "$include_count" "$route_count"
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
RUNCFG_FILE="/opt/tmp/router-dns-text-running-$$.txt"
GROUPS_FILE="/opt/tmp/router-dns-text-groups-$$.txt"
ROUTES_FILE="/opt/tmp/router-dns-text-routes-$$.txt"
EXPORT_FILE="/opt/tmp/router-dns-text-export-$$.txt"
EXPORT_RAW_FILE="/opt/tmp/router-dns-text-export-raw-$$.txt"
INPUT_FILE="/opt/tmp/router-dns-text-input-$$.txt"
DESIRED_GROUPS_FILE="/opt/tmp/router-dns-text-desired-groups-$$.txt"
DESIRED_INCLUDES_FILE="/opt/tmp/router-dns-text-desired-includes-$$.txt"
DESIRED_ROUTES_FILE="/opt/tmp/router-dns-text-desired-routes-$$.txt"
DESIRED_DESCRIPTIONS_FILE="/opt/tmp/router-dns-text-desired-descriptions-$$.txt"
STATE_TMP_FILE="/opt/tmp/router-dns-text-state-$$.txt"
CMD_FILE="/opt/tmp/router-dns-text-cmd-$$.txt"
LOCK_HELD=0

mkdir -p "$PROFILE_DIR" "$BACKUP_DIR" /opt/tmp

action=$(query_value action)

case "$action" in
  validate)
    cat > "$INPUT_FILE"
    parse_dns_group_file
    print_parsed_json
    cleanup
    ;;
  apply)
    cat > "$INPUT_FILE"
    parse_dns_group_file
    apply_text_groups
    ;;
  apply-group)
    cat > "$INPUT_FILE"
    parse_dns_group_file
    apply_single_group
    ;;
  *)
    read_running_config
    export_dns_groups
    print_status_json
    cleanup
    ;;
esac
