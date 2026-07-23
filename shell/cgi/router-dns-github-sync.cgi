#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

query_value() {
  key="$1"
  printf '%s' "${QUERY_STRING:-}" | tr '&' '\n' | awk -F= -v key="$key" '$1 == key { print $2; exit }'
}

valid_group_id() {
  case "$1" in
    domain-list*)
      suffix=${1#domain-list}
      case "$suffix" in
        ""|*[!0-9]*) return 1 ;;
        *) return 0 ;;
      esac
      ;;
    *) return 1 ;;
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
    printf '%s' "$1" | base64 | tr -d '\r\n'
  else
    return 1
  fi
}

b64_decode() {
  if command -v base64 >/dev/null 2>&1; then
    printf '%s' "$1" | base64 -d 2>/dev/null
  else
    return 1
  fi
}

process_is_running() {
  case "$1" in
    ""|*[!0-9]*) return 1 ;;
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
  fail "Синхронизация DNS уже выполняется" "Дождись завершения операции. Активный PID: ${lock_pid:-unknown}."
}

cleanup() {
  rm -f "$LOCAL_FILE" "$REMOTE_FILE" "$CANON_FILE" "$CANON_RAW_FILE" "$META_FILE" "$COMMITS_FILE" \
    "$AUTH_FILE" "$REQUEST_FILE" "$RESPONSE_FILE" "$CHILD_FILE" "$CHILD_BODY_FILE" "$CONFIG_TMP_FILE" \
    "$STATE_TMP_FILE" "$CANON_GROUPS_FILE" "$CANON_INCLUDES_FILE"
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

require_post() {
  [ "${REQUEST_METHOD:-GET}" = "POST" ] || fail "Нужен POST-запрос" "Эта операция изменяет настройки или данные."
}

config_value() {
  key="$1"
  file="$2"
  awk -F'|' -v key="$key" '
  $1 == key {
    sub(/^[^|]*\|/, "")
    print
    exit
  }
  ' "$file" 2>/dev/null
}

load_config() {
  CONFIG_REPOSITORY=$(config_value repository "$CONFIG_FILE")
  CONFIG_BRANCH=$(config_value branch "$CONFIG_FILE")
  CONFIG_PATH=$(config_value path "$CONFIG_FILE")
  CONFIG_KEY=$(config_value key "$CONFIG_FILE")
  CONFIG_SECRET=$(config_value secret "$CONFIG_FILE")
  [ -n "$CONFIG_REPOSITORY" ] || CONFIG_REPOSITORY="sc113/vpn-rui-dns"
  [ -n "$CONFIG_BRANCH" ] || CONFIG_BRANCH="main"
  [ -n "$CONFIG_PATH" ] || CONFIG_PATH="vpn-routing-ui-dns-groups.txt"
  [ -n "$CONFIG_KEY" ] || CONFIG_KEY=${CONFIG_REPOSITORY%%/*}
  CONFIG_SOURCE="$CONFIG_REPOSITORY@$CONFIG_BRANCH:$CONFIG_PATH"
}

load_state() {
  STATE_SOURCE=$(config_value source "$STATE_FILE")
  LOCAL_HASH=$(config_value local_hash "$STATE_FILE")
  LOCAL_VERSION=$(config_value local_version "$STATE_FILE")
  REMOTE_BLOB=$(config_value remote_blob "$STATE_FILE")
  REMOTE_COMMIT=$(config_value remote_commit "$STATE_FILE")
  REMOTE_VERSION=$(config_value remote_version "$STATE_FILE")
  LAST_DIRECTION=$(config_value last_direction "$STATE_FILE")
  LAST_SYNC=$(config_value last_sync "$STATE_FILE")
  if [ -n "$STATE_SOURCE" ] && [ "$STATE_SOURCE" != "$CONFIG_SOURCE" ]; then
    REMOTE_BLOB=""
    REMOTE_COMMIT=""
    REMOTE_VERSION=""
    LAST_DIRECTION=""
    LAST_SYNC=""
  fi
}

save_state() {
  {
    printf 'source|%s\n' "$CONFIG_SOURCE"
    printf 'local_hash|%s\n' "$LOCAL_HASH"
    printf 'local_version|%s\n' "$LOCAL_VERSION"
    printf 'remote_blob|%s\n' "$REMOTE_BLOB"
    printf 'remote_commit|%s\n' "$REMOTE_COMMIT"
    printf 'remote_version|%s\n' "$REMOTE_VERSION"
    printf 'last_direction|%s\n' "$LAST_DIRECTION"
    printf 'last_sync|%s\n' "$LAST_SYNC"
  } > "$STATE_TMP_FILE" || fail "Не удалось записать состояние DNS sync" "$STATE_TMP_FILE"
  chmod 600 "$STATE_TMP_FILE"
  mv "$STATE_TMP_FILE" "$STATE_FILE" || fail "Не удалось сохранить состояние DNS sync" "$STATE_FILE"
}

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date
}

extract_cgi_body() {
  awk '
  body { sub(/\r$/, ""); print; next }
  /^[[:space:]]*\r?$/ { body = 1 }
  ' "$1" > "$2"
}

export_local_dns() {
  [ -x "$DNS_TEXT_CGI" ] || fail "Не найден DNS export CGI" "$DNS_TEXT_CGI"
  QUERY_STRING=action=export-raw REQUEST_METHOD=GET "$DNS_TEXT_CGI" > "$CHILD_FILE" 2>"$RESPONSE_FILE"
  extract_cgi_body "$CHILD_FILE" "$LOCAL_FILE"
  if ! grep -Eq '^# vpn-routing-ui dns-groups v[12]$' "$LOCAL_FILE"; then
    fail "Не удалось получить DNS-группы с роутера" "$(cat "$RESPONSE_FILE" "$LOCAL_FILE" 2>/dev/null | head -c 800)"
  fi
}

canonicalize_dns_file() {
  input_file="$1"
  output_file="$2"
  dns_format=1
  if grep -Fq '# vpn-routing-ui dns-groups v2' "$input_file"; then
    dns_format=2
  elif ! grep -Fq '# vpn-routing-ui dns-groups v1' "$input_file"; then
    CANON_ERROR="Неизвестный формат DNS-файла"
    return 1
  fi

  : > "$CANON_RAW_FILE"
  : > "$CANON_GROUPS_FILE"
  : > "$CANON_INCLUDES_FILE"
  line_no=0
  cr=$(printf '\r')
  while IFS= read -r line || [ -n "$line" ]; do
    line_no=$((line_no + 1))
    line=${line%"$cr"}
    case "$line" in
      ""|\#*) continue ;;
    esac

    record_type=${line%%|*}
    rest=${line#*|}
    case "$record_type" in
      G)
        group_id=${rest%%|*}
        rest=${rest#*|}
        if ! valid_group_id "$group_id"; then
          CANON_ERROR="Строка $line_no: некорректная группа $group_id"
          return 1
        fi
        if [ "$dns_format" = "2" ]; then
          description=$rest
        else
          raw_description=${rest%%|*}
          if ! description=$(b64_decode "$raw_description"); then
            CANON_ERROR="Строка $line_no: некорректное base64-описание"
            return 1
          fi
        fi
        encoded_description=$(b64_encode "$description") || {
          CANON_ERROR="На роутере не найдена команда base64"
          return 1
        }
        printf '%s\n' "$group_id" >> "$CANON_GROUPS_FILE"
        printf 'G|%s|%s\n' "$group_id" "$encoded_description" >> "$CANON_RAW_FILE"
        ;;
      I)
        group_id=${rest%%|*}
        include_value=${rest#*|}
        if ! valid_group_id "$group_id" || ! valid_include "$include_value"; then
          CANON_ERROR="Строка $line_no: некорректный include $group_id -> $include_value"
          return 1
        fi
        printf '%s\n' "$group_id" >> "$CANON_INCLUDES_FILE"
        printf 'I|%s|%s\n' "$group_id" "$include_value" >> "$CANON_RAW_FILE"
        ;;
      *)
        CANON_ERROR="Строка $line_no: неизвестная запись $record_type"
        return 1
        ;;
    esac
  done < "$input_file"

  [ -s "$CANON_GROUPS_FILE" ] || {
    CANON_ERROR="DNS-файл не содержит групп"
    return 1
  }
  missing_group=$(awk 'NR == FNR { groups[$1] = 1; next } !groups[$1] { print $1; exit }' \
    "$CANON_GROUPS_FILE" "$CANON_INCLUDES_FILE")
  if [ -n "$missing_group" ]; then
    CANON_ERROR="Include ссылается на отсутствующую группу $missing_group"
    return 1
  fi
  sort -u "$CANON_RAW_FILE" > "$output_file"
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1; exit }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{ print $NF; exit }'
  else
    return 1
  fi
}

hash_dns_file() {
  input_file="$1"
  if ! canonicalize_dns_file "$input_file" "$CANON_FILE"; then
    fail "Некорректный DNS-файл" "$CANON_ERROR"
  fi
  hash_file "$CANON_FILE" || fail "Не удалось посчитать SHA-256 DNS-файла" "Нужен sha256sum или openssl."
}

make_auth_file() {
  [ -n "$CONFIG_SECRET" ] || fail "Не задан секрет GitHub" "Открой настройки синхронизации и сохрани Personal access token."
  printf 'Authorization: Bearer %s\n' "$CONFIG_SECRET" > "$AUTH_FILE"
  chmod 600 "$AUTH_FILE"
}

github_curl() {
  curl -fsS --connect-timeout 15 --max-time 120 --retry 2 --retry-delay 2 \
    -H "@$AUTH_FILE" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "User-Agent: vpn-routing-ui-dns-sync" \
    "$@"
}

fetch_remote_version() {
  make_auth_file
  api_url="https://api.github.com/repos/$CONFIG_REPOSITORY/commits"
  if ! github_curl --get \
    --data-urlencode "path=$CONFIG_PATH" \
    --data-urlencode "sha=$CONFIG_BRANCH" \
    --data-urlencode "per_page=1" \
    "$api_url" > "$COMMITS_FILE" 2>"$RESPONSE_FILE"; then
    GITHUB_ERROR=$(cat "$RESPONSE_FILE" 2>/dev/null | head -c 600)
    return 1
  fi
  REMOTE_COMMIT=$(sed -n 's/^[[:space:]]*"sha":[[:space:]]*"\([0-9a-f][0-9a-f]*\)".*/\1/p' "$COMMITS_FILE" | head -n 1)
  REMOTE_VERSION=$(sed -n 's/^[[:space:]]*"date":[[:space:]]*"\([^"]*\)".*/\1/p' "$COMMITS_FILE" | head -n 1)
  if [ -z "$REMOTE_COMMIT" ] || [ -z "$REMOTE_VERSION" ]; then
    GITHUB_ERROR="GitHub не вернул коммит или дату DNS-файла."
    return 1
  fi
}

fetch_remote_file() {
  make_auth_file
  api_url="https://api.github.com/repos/$CONFIG_REPOSITORY/contents/$CONFIG_PATH"
  if ! github_curl --get --data-urlencode "ref=$CONFIG_BRANCH" "$api_url" > "$META_FILE" 2>"$RESPONSE_FILE"; then
    fail "Не удалось прочитать DNS-файл из GitHub" "$(cat "$RESPONSE_FILE" 2>/dev/null | head -c 600)"
  fi
  REMOTE_BLOB=$(sed -n 's/^[[:space:]]*"sha":[[:space:]]*"\([0-9a-f][0-9a-f]*\)".*/\1/p' "$META_FILE" | head -n 1)
  [ -n "$REMOTE_BLOB" ] || fail "GitHub не вернул SHA DNS-файла" "$CONFIG_REPOSITORY/$CONFIG_PATH"

  if ! curl -fsS --connect-timeout 15 --max-time 120 --retry 2 --retry-delay 2 \
    -H "@$AUTH_FILE" \
    -H "Accept: application/vnd.github.raw+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "User-Agent: vpn-routing-ui-dns-sync" \
    --get --data-urlencode "ref=$CONFIG_BRANCH" \
    "$api_url" > "$REMOTE_FILE" 2>"$RESPONSE_FILE"; then
    fail "Не удалось скачать DNS-файл из GitHub" "$(cat "$RESPONSE_FILE" 2>/dev/null | head -c 600)"
  fi
}

compare_versions() {
  awk -v left="$1" -v right="$2" 'BEGIN {
    if (left == right) print 0
    else if (left > right) print 1
    else print -1
  }'
}

apply_remote_file() {
  content_length=$(wc -c < "$REMOTE_FILE" | tr -d ' ')
  QUERY_STRING=action=apply \
    REQUEST_METHOD=POST \
    CONTENT_TYPE="text/plain; charset=utf-8" \
    CONTENT_LENGTH="$content_length" \
    "$DNS_TEXT_CGI" < "$REMOTE_FILE" > "$CHILD_FILE" 2>"$RESPONSE_FILE"
  extract_cgi_body "$CHILD_FILE" "$CHILD_BODY_FILE"
  if ! grep -q '"ok":true' "$CHILD_BODY_FILE"; then
    fail "Не удалось построить DNS-группы из GitHub-файла" "$(cat "$CHILD_BODY_FILE" "$RESPONSE_FILE" 2>/dev/null | head -c 900)"
  fi
}

push_local_file() {
  encoded_content=$(base64 < "$LOCAL_FILE" | tr -d '\r\n') ||
    fail "Не удалось кодировать DNS-файл для GitHub" "Команда base64 завершилась ошибкой."
  commit_message="Sync DNS groups from router ($LOCAL_VERSION)"
  {
    printf '{"message":"%s",' "$(json_escape "$commit_message")"
    printf '"content":"%s",' "$encoded_content"
    printf '"sha":"%s",' "$(json_escape "$REMOTE_BLOB")"
    printf '"branch":"%s"}' "$(json_escape "$CONFIG_BRANCH")"
  } > "$REQUEST_FILE"
  unset encoded_content

  api_url="https://api.github.com/repos/$CONFIG_REPOSITORY/contents/$CONFIG_PATH"
  if ! github_curl -X PUT -H "Content-Type: application/json" --data-binary "@$REQUEST_FILE" \
    "$api_url" > "$RESPONSE_FILE" 2>"$CHILD_FILE"; then
    fail "Не удалось отправить DNS-файл в GitHub" "$(cat "$CHILD_FILE" "$RESPONSE_FILE" 2>/dev/null | head -c 800)"
  fi
  new_blob=$(sed -n 's/^[[:space:]]*"sha":[[:space:]]*"\([0-9a-f][0-9a-f]*\)".*/\1/p' "$RESPONSE_FILE" | head -n 1)
  [ -n "$new_blob" ] && REMOTE_BLOB="$new_blob"
  if ! fetch_remote_version; then
    REMOTE_VERSION="$LOCAL_VERSION"
  fi
}

print_status_json() {
  current_hash="$1"
  remote_error="$2"
  local_known=false
  local_changed=false
  if [ -n "$LOCAL_VERSION" ] && [ "$LOCAL_HASH" = "$current_hash" ]; then
    local_known=true
  elif [ -n "$LOCAL_HASH" ] && [ "$LOCAL_HASH" != "$current_hash" ]; then
    local_changed=true
  fi
  secret_configured=false
  [ -n "$CONFIG_SECRET" ] && secret_configured=true
  printf '{"ok":true,'
  printf '"repository":"%s",' "$(json_escape "$CONFIG_REPOSITORY")"
  printf '"branch":"%s",' "$(json_escape "$CONFIG_BRANCH")"
  printf '"path":"%s",' "$(json_escape "$CONFIG_PATH")"
  printf '"key":"%s",' "$(json_escape "$CONFIG_KEY")"
  printf '"secretConfigured":%s,' "$secret_configured"
  printf '"localVersion":"%s",' "$(json_escape "$LOCAL_VERSION")"
  printf '"localVersionKnown":%s,' "$local_known"
  printf '"localChanged":%s,' "$local_changed"
  printf '"localHash":"%s",' "$(json_escape "$current_hash")"
  printf '"remoteVersion":"%s",' "$(json_escape "$REMOTE_VERSION")"
  printf '"remoteCommit":"%s",' "$(json_escape "$REMOTE_COMMIT")"
  printf '"remoteError":"%s",' "$(json_escape "$remote_error")"
  printf '"lastDirection":"%s",' "$(json_escape "$LAST_DIRECTION")"
  printf '"lastSync":"%s"' "$(json_escape "$LAST_SYNC")"
  printf '}'
}

read_setting() {
  key="$1"
  awk -F= -v key="$key" '
  $1 == key {
    sub(/^[^=]*=/, "")
    print
    exit
  }
  ' "$REQUEST_FILE"
}

save_settings() {
  require_post
  acquire_lock
  content_length=${CONTENT_LENGTH:-0}
  case "$content_length" in
    ""|*[!0-9]*) content_length=0 ;;
  esac
  [ "$content_length" -le 16384 ] 2>/dev/null || fail "Настройки слишком большие" "Максимум 16 КБ."
  cat > "$REQUEST_FILE"

  new_repository=$(read_setting repository)
  new_branch=$(read_setting branch)
  new_path=$(read_setting path)
  new_key=$(read_setting key)
  new_secret=$(read_setting secret)
  clear_secret=$(read_setting clearSecret)
  [ -n "$new_repository" ] || new_repository="$CONFIG_REPOSITORY"
  [ -n "$new_branch" ] || new_branch="$CONFIG_BRANCH"
  [ -n "$new_path" ] || new_path="$CONFIG_PATH"
  [ -n "$new_key" ] || new_key="$CONFIG_KEY"
  if [ "$clear_secret" = "1" ]; then
    new_secret=""
  elif [ -z "$new_secret" ]; then
    new_secret="$CONFIG_SECRET"
  fi

  case "$new_repository" in
    *[!A-Za-z0-9_.-]*/*|*/*[!A-Za-z0-9_.-]*|*/*/*|"")
      fail "Некорректный репозиторий" "Используй формат owner/repository."
      ;;
  esac
  case "$new_branch" in
    ""|*[!A-Za-z0-9._/-]*|*..*) fail "Некорректная ветка" "$new_branch" ;;
  esac
  case "$new_path" in
    ""|/*|*[!A-Za-z0-9._/-]*|*..*) fail "Некорректный путь DNS-файла" "$new_path" ;;
  esac
  case "$new_key" in
    ""|*[!A-Za-z0-9_.-]*) fail "Некорректный ключ / логин GitHub" "$new_key" ;;
  esac
  case "$new_secret" in
    *[!A-Za-z0-9_=.-]*) fail "Некорректный секрет GitHub" "Токен содержит неподдерживаемые символы." ;;
  esac

  {
    printf 'repository|%s\n' "$new_repository"
    printf 'branch|%s\n' "$new_branch"
    printf 'path|%s\n' "$new_path"
    printf 'key|%s\n' "$new_key"
    printf 'secret|%s\n' "$new_secret"
  } > "$CONFIG_TMP_FILE" || fail "Не удалось записать настройки GitHub" "$CONFIG_TMP_FILE"
  chmod 600 "$CONFIG_TMP_FILE"
  mv "$CONFIG_TMP_FILE" "$CONFIG_FILE" || fail "Не удалось сохранить настройки GitHub" "$CONFIG_FILE"

  load_config
  load_state
  STATE_SOURCE="$CONFIG_SOURCE"
  REMOTE_BLOB=""
  REMOTE_COMMIT=""
  REMOTE_VERSION=""
  LAST_DIRECTION=""
  LAST_SYNC=""
  save_state
  printf '{"ok":true,"message":"Настройки GitHub сохранены.","secretConfigured":%s}' \
    "$(if [ -n "$CONFIG_SECRET" ]; then printf true; else printf false; fi)"
  cleanup
}

mark_current_version() {
  require_post
  acquire_lock
  export_local_dns
  current_hash=$(hash_dns_file "$LOCAL_FILE")
  LOCAL_HASH="$current_hash"
  LOCAL_VERSION=$(now_iso)
  LAST_DIRECTION="capture"
  LAST_SYNC="$LOCAL_VERSION"
  save_state
  printf '{"ok":true,"message":"Текущая версия роутера зафиксирована.","localVersion":"%s","localHash":"%s"}' \
    "$(json_escape "$LOCAL_VERSION")" "$(json_escape "$LOCAL_HASH")"
  cleanup
}

sync_dns() {
  require_post
  acquire_lock
  export_local_dns
  current_hash=$(hash_dns_file "$LOCAL_FILE")
  if [ -n "$LOCAL_HASH" ] && [ "$LOCAL_HASH" != "$current_hash" ]; then
    fail "Текущие DNS-группы изменены вне учёта версий" "Нажми «Считать текущую версию», затем снова «Обновить»."
  fi

  fetch_remote_file
  if ! fetch_remote_version; then
    fail "Не удалось получить версию DNS-файла GitHub" "$GITHUB_ERROR"
  fi
  remote_hash=$(hash_dns_file "$REMOTE_FILE")

  if [ "$current_hash" = "$remote_hash" ]; then
    LOCAL_HASH="$current_hash"
    [ -n "$LOCAL_VERSION" ] || LOCAL_VERSION="$REMOTE_VERSION"
    LAST_DIRECTION="equal"
    LAST_SYNC=$(now_iso)
    save_state
    printf '{"ok":true,"direction":"equal","message":"DNS-группы на роутере и в GitHub уже совпадают.","localVersion":"%s","remoteVersion":"%s"}' \
      "$(json_escape "$LOCAL_VERSION")" "$(json_escape "$REMOTE_VERSION")"
    cleanup
    exit 0
  fi

  if [ -z "$LOCAL_VERSION" ]; then
    direction="download"
  else
    version_order=$(compare_versions "$LOCAL_VERSION" "$REMOTE_VERSION")
    case "$version_order" in
      1) direction="upload" ;;
      -1) direction="download" ;;
      *) fail "Одинаковая дата, но разное содержимое DNS" "Зафиксируй нужную локальную версию заново или измени файл в GitHub отдельным коммитом." ;;
    esac
  fi

  case "$direction" in
    upload)
      LOCAL_HASH="$current_hash"
      push_local_file
      message="Более новая версия роутера отправлена в GitHub."
      ;;
    download)
      apply_remote_file
      LOCAL_HASH="$remote_hash"
      LOCAL_VERSION="$REMOTE_VERSION"
      message="Более новая версия GitHub скачана; DNS-группы построены на роутере."
      ;;
  esac

  LAST_DIRECTION="$direction"
  LAST_SYNC=$(now_iso)
  save_state
  printf '{"ok":true,"direction":"%s","message":"%s","localVersion":"%s","remoteVersion":"%s"}' \
    "$direction" "$(json_escape "$message")" "$(json_escape "$LOCAL_VERSION")" "$(json_escape "$REMOTE_VERSION")"
  cleanup
}

printf 'Content-Type: application/json\n'
printf 'Cache-Control: no-store\n\n'

PATH=/opt/sbin:/opt/bin:/opt/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH_HELPER=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)/bin/ui-paths.sh
[ -n "$PATH_HELPER" ] && . "$PATH_HELPER"

PROFILE_DIR="${VPN_ROUTING_UI_STATE_DIR:-/opt/etc/vpn-routing-ui}"
CONFIG_FILE="$PROFILE_DIR/dns-github.conf"
STATE_FILE="$PROFILE_DIR/dns-github.state"
LOCK_DIR="$PROFILE_DIR/dns-github.lock"
DNS_TEXT_CGI="$SCRIPT_DIR/router-dns-text-sync.cgi"
LOCAL_FILE="/opt/tmp/router-dns-github-local-$$.txt"
REMOTE_FILE="/opt/tmp/router-dns-github-remote-$$.txt"
CANON_FILE="/opt/tmp/router-dns-github-canon-$$.txt"
CANON_RAW_FILE="/opt/tmp/router-dns-github-canon-raw-$$.txt"
CANON_GROUPS_FILE="/opt/tmp/router-dns-github-groups-$$.txt"
CANON_INCLUDES_FILE="/opt/tmp/router-dns-github-includes-$$.txt"
META_FILE="/opt/tmp/router-dns-github-meta-$$.json"
COMMITS_FILE="/opt/tmp/router-dns-github-commits-$$.json"
AUTH_FILE="/opt/tmp/router-dns-github-auth-$$.txt"
REQUEST_FILE="/opt/tmp/router-dns-github-request-$$.txt"
RESPONSE_FILE="/opt/tmp/router-dns-github-response-$$.txt"
CHILD_FILE="/opt/tmp/router-dns-github-child-$$.txt"
CHILD_BODY_FILE="/opt/tmp/router-dns-github-child-body-$$.txt"
CONFIG_TMP_FILE="$CONFIG_FILE.$$"
STATE_TMP_FILE="$STATE_FILE.$$"
LOCK_HELD=0
umask 077
mkdir -p "$PROFILE_DIR" /opt/tmp
chmod 700 "$PROFILE_DIR" 2>/dev/null || true

load_config
load_state
action=$(query_value action)

case "$action" in
  settings)
    save_settings
    ;;
  mark-current)
    mark_current_version
    ;;
  sync)
    sync_dns
    ;;
  ""|status)
    export_local_dns
    current_hash=$(hash_dns_file "$LOCAL_FILE")
    remote_error=""
    if [ -n "$CONFIG_SECRET" ]; then
      if ! fetch_remote_version; then
        remote_error="$GITHUB_ERROR"
      fi
    else
      remote_error="Секрет GitHub ещё не настроен."
    fi
    print_status_json "$current_hash" "$remote_error"
    cleanup
    ;;
  *)
    fail "Неизвестное действие DNS GitHub sync" "$action"
    ;;
esac
