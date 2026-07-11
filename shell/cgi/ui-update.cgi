#!/bin/sh

PATH=/opt/sbin:/opt/bin:/opt/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

query_param() {
  printf '%s' "$QUERY_STRING" | tr '&' '\n' | sed -n "s/^$1=//p" | head -n 1
}

bool_json() {
  if [ "$1" = "1" ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

now_epoch() {
  date +%s 2>/dev/null || echo 0
}

read_state() {
  UPDATE_STATUS="idle"
  UPDATE_STARTED="0"
  UPDATE_BACKUP=""
  UPDATE_MESSAGE="Обновление ещё не запускалось."
  if [ -s "$STATE_FILE" ]; then
    IFS='|' read -r UPDATE_STATUS UPDATE_STARTED UPDATE_BACKUP UPDATE_MESSAGE < "$STATE_FILE" || true
  fi
}

write_state() {
  status="$1"
  message="$2"
  tmp="$STATE_FILE.$$"
  printf '%s|%s||%s\n' "$status" "$(now_epoch)" "$message" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

print_state() {
  read_state
  running=0
  case "$UPDATE_STATUS" in
    queued|running) running=1 ;;
  esac
  started=$(printf '%s' "$UPDATE_STARTED" | tr -cd '0-9')
  [ -n "$started" ] || started=0
  printf '{'
  printf '"ok":true,'
  printf '"status":"%s",' "$(json_escape "$UPDATE_STATUS")"
  printf '"running":%s,' "$(bool_json "$running")"
  printf '"startedAt":%s,' "$started"
  printf '"backupPath":"%s",' "$(json_escape "$UPDATE_BACKUP")"
  printf '"message":"%s"' "$(json_escape "$UPDATE_MESSAGE")"
  printf '}'
}

is_commit() {
  case "$1" in
    ''|*[!0-9A-Fa-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

installed_commit() {
  awk -F'|' '$1 == "ui" { print $4; exit }' "$VERSION_FILE" 2>/dev/null
}

is_busybox_wget() {
  command -v wget >/dev/null 2>&1 || return 1
  wget --help 2>&1 | grep -q 'BusyBox'
}

fetch_remote_commit() {
  api_url="https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/commits/$REPO_REF"
  response=""
  FETCHED_COMMIT=""
  FETCH_ERROR=""

  if command -v curl >/dev/null 2>&1; then
    if ! response=$(curl -fsSL --connect-timeout 6 --max-time 25 --retry 1 --retry-delay 1 --retry-connrefused "$api_url" 2>/dev/null); then
      FETCH_ERROR="curl не смог обратиться к GitHub. Проверьте интернет, DNS и пакет ca-bundle."
      return 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if is_busybox_wget; then
      FETCH_ERROR="Для проверки обновлений нужен curl или wget-ssl; BusyBox wget не подходит. Выполните: opkg update && opkg install ca-bundle curl"
      return 1
    fi
    if ! response=$(wget -qO- "$api_url" 2>/dev/null); then
      FETCH_ERROR="wget-ssl не смог обратиться к GitHub. Проверьте интернет, DNS и сертификаты."
      return 1
    fi
  else
    FETCH_ERROR="На роутере нет HTTPS-клиента для GitHub. Выполните: opkg update && opkg install ca-bundle curl"
    return 1
  fi

  candidate=$(printf '%s\n' "$response" | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9A-Fa-f]*\)".*/\1/p' | head -n 1)
  if is_commit "$candidate"; then
    FETCHED_COMMIT="$candidate"
    return 0
  fi

  FETCH_ERROR="GitHub ответил, но SHA версии UI не найден. Проверьте имя репозитория и ветку обновления."
  return 1
}

short_commit() {
  printf '%s' "$1" | cut -c1-7
}

print_version_check() {
  installed=$(installed_commit)
  fetch_remote_commit || true
  latest="$FETCHED_COMMIT"
  if ! is_commit "$latest"; then
    error_message="${FETCH_ERROR:-Не удалось получить версию UI из GitHub}"
    printf '{"ok":false,"error":"%s"}' "$(json_escape "$error_message")"
    return
  fi

  update_available=1
  message="Доступно обновление UI: $(short_commit "$latest")."
  if is_commit "$installed" && [ "$installed" = "$latest" ]; then
    update_available=0
    message="UI актуален: $(short_commit "$installed")."
  elif ! is_commit "$installed"; then
    message="У установленного UI нет SHA. Одно обновление привяжет его к версии GitHub."
  fi

  printf '{'
  printf '"ok":true,'
  printf '"installedRevision":"%s",' "$(json_escape "$installed")"
  printf '"latestRevision":"%s",' "$(json_escape "$latest")"
  printf '"updateAvailable":%s,' "$(bool_json "$update_available")"
  printf '"message":"%s"' "$(json_escape "$message")"
  printf '}'
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH_HELPER=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)/bin/ui-paths.sh
[ -r "$PATH_HELPER" ] && . "$PATH_HELPER"

STATE_DIR="${VPN_ROUTING_UI_STATE_DIR:-/opt/etc/vpn-routing-ui}"
STATE_FILE="$STATE_DIR/ui-update.state"
PID_FILE="$STATE_DIR/ui-update.pid"
LOCK_DIR="$STATE_DIR/ui-update.lock"
LOG_FILE="$STATE_DIR/ui-update.log"
UPDATE_HELPER="${VPN_ROUTING_UI_APP_DIR:-/opt/share/vpn-routing-ui}/bin/ui-update.sh"
VERSION_FILE="$STATE_DIR/versions.state"
REPO_OWNER="${VPN_ROUTING_UI_REPO_OWNER:-sc113}"
REPO_NAME="${VPN_ROUTING_UI_REPO_NAME:-vpn-routing-ui}"
REPO_REF="${VPN_ROUTING_UI_REF:-main}"
ACTION=$(query_param action)

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

case "$ACTION" in
  ''|status)
    print_state
    exit 0
    ;;
  check)
    print_version_check
    exit 0
    ;;
  start)
    ;;
  *)
    printf '{"ok":false,"error":"Неизвестная команда обновления UI"}'
    exit 0
    ;;
esac

if [ "${REQUEST_METHOD:-GET}" != "POST" ]; then
  printf '{"ok":false,"error":"Запуск обновления требует POST-запрос"}'
  exit 0
fi

if [ -d "$LOCK_DIR" ]; then
  printf '{"ok":false,"error":"Обновление UI уже выполняется"}'
  exit 0
fi

if [ ! -x "$UPDATE_HELPER" ]; then
  printf '{"ok":false,"error":"Helper обновления UI не найден"}'
  exit 0
fi

if ! command -v start-stop-daemon >/dev/null 2>&1; then
  printf '{"ok":false,"error":"На роутере не найден start-stop-daemon"}'
  exit 0
fi

mkdir -p "$STATE_DIR"
rm -f "$PID_FILE"
write_state "queued" "Обновление поставлено в очередь."

if ! start-stop-daemon -S -b -m -p "$PID_FILE" -x "$UPDATE_HELPER" -O "$LOG_FILE"; then
  write_state "failed" "Не удалось запустить фоновое обновление."
  printf '{"ok":false,"error":"Не удалось запустить фоновое обновление"}'
  exit 0
fi

print_state
