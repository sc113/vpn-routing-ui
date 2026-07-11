#!/bin/sh

set -u

PATH=/opt/sbin:/opt/bin:/opt/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH_HELPER="$SCRIPT_DIR/ui-paths.sh"
[ -r "$PATH_HELPER" ] && . "$PATH_HELPER"

APP_DIR="${VPN_ROUTING_UI_APP_DIR:-/opt/share/vpn-routing-ui}"
STATE_DIR="${VPN_ROUTING_UI_STATE_DIR:-/opt/etc/vpn-routing-ui}"
BACKUP_DIR="${VPN_ROUTING_UI_BACKUP_DIR:-$STATE_DIR/backups}"
STATE_FILE="$STATE_DIR/ui-update.state"
PID_FILE="$STATE_DIR/ui-update.pid"
LOCK_DIR="$STATE_DIR/ui-update.lock"
LOG_FILE="$STATE_DIR/ui-update.log"

REPO_OWNER="${VPN_ROUTING_UI_REPO_OWNER:-sc113}"
REPO_NAME="${VPN_ROUTING_UI_REPO_NAME:-vpn-routing-ui}"
REPO_REF="${VPN_ROUTING_UI_REF:-main}"
VERSION_FILE="$STATE_DIR/versions.state"

now_epoch() {
  date +%s 2>/dev/null || echo 0
}

write_state() {
  status="$1"
  message="$2"
  backup_path="$3"
  tmp="$STATE_FILE.$$"
  printf '%s|%s|%s|%s\n' "$status" "$(now_epoch)" "$backup_path" "$message" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

cleanup() {
  rm -rf "$LOCK_DIR" "$PID_FILE" "$WORK_DIR"
}

is_busybox_wget() {
  command -v wget >/dev/null 2>&1 || return 1
  wget --help 2>&1 | grep -q 'BusyBox'
}

download_to_file() {
  url="$1"
  destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 90 "$url" -o "$destination"
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    is_busybox_wget && return 1
    wget -qO "$destination" "$url"
    return $?
  fi
  return 1
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

fetch_remote_commit() {
  api_url="https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/commits/$REPO_REF"
  response=""
  FETCHED_COMMIT=""
  FETCH_ERROR=""

  if command -v curl >/dev/null 2>&1; then
    if ! response=$(curl -fsSL --connect-timeout 6 --max-time 20 "$api_url" 2>/dev/null); then
      FETCH_ERROR="curl не смог обратиться к GitHub. Проверьте интернет, DNS и пакет ca-bundle."
      return 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if is_busybox_wget; then
      FETCH_ERROR="Для автообновления нужен curl или wget-ssl; BusyBox wget не подходит. Выполните: opkg update && opkg install ca-bundle curl"
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

mkdir -p "$STATE_DIR" "$BACKUP_DIR" /opt/tmp
chmod 700 "$STATE_DIR" "$BACKUP_DIR" 2>/dev/null || true

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi

if command -v mktemp >/dev/null 2>&1; then
  WORK_DIR=$(umask 077; mktemp -d /opt/tmp/vpn-routing-ui-update.XXXXXX)
else
  WORK_DIR="/opt/tmp/vpn-routing-ui-update-$$"
  (umask 077; mkdir "$WORK_DIR") || WORK_DIR=""
fi
if [ -z "$WORK_DIR" ] || [ ! -d "$WORK_DIR" ]; then
  write_state "failed" "Не удалось создать защищённый временный каталог." ""
  rm -rf "$LOCK_DIR" "$PID_FILE"
  exit 1
fi
INSTALL_FILE="$WORK_DIR/install.sh"
STAMP=$(date +%Y%m%d-%H%M%S 2>/dev/null || now_epoch)
BACKUP_PATH="$BACKUP_DIR/ui-$STAMP"

trap cleanup EXIT INT TERM

write_state "running" "Проверяем версию UI на GitHub." ""
printf '\n[%s] UI update started\n' "$(date 2>/dev/null || now_epoch)" >> "$LOG_FILE"

fetch_remote_commit || true
REMOTE_COMMIT="$FETCHED_COMMIT"
if ! is_commit "$REMOTE_COMMIT"; then
  write_state "failed" "${FETCH_ERROR:-Не удалось получить SHA версии из GitHub.}" ""
  exit 1
fi

CURRENT_COMMIT=$(installed_commit)
if is_commit "$CURRENT_COMMIT" && [ "$CURRENT_COMMIT" = "$REMOTE_COMMIT" ]; then
  write_state "success" "UI уже актуален: $(short_commit "$REMOTE_COMMIT")." ""
  exit 0
fi

if cp -R "$APP_DIR" "$BACKUP_PATH" >> "$LOG_FILE" 2>&1; then
  :
else
  BACKUP_PATH=""
fi

INSTALL_URL="https://raw.githubusercontent.com/$REPO_OWNER/$REPO_NAME/$REMOTE_COMMIT/install.sh"
write_state "running" "Скачиваем UI $(short_commit "$REMOTE_COMMIT") из GitHub." "$BACKUP_PATH"
if ! download_to_file "$INSTALL_URL" "$INSTALL_FILE" >> "$LOG_FILE" 2>&1; then
  write_state "failed" "Не удалось скачать installer из GitHub." "$BACKUP_PATH"
  exit 1
fi

if ! grep -q 'VPN_ROUTING_UI_REPO_OWNER' "$INSTALL_FILE"; then
  write_state "failed" "GitHub вернул некорректный installer." "$BACKUP_PATH"
  exit 1
fi

write_state "running" "Применяем UI $(short_commit "$REMOTE_COMMIT") и перезапускаем интерфейс." "$BACKUP_PATH"
if VPN_ROUTING_UI_REF="$REMOTE_COMMIT" VPN_ROUTING_UI_COMMIT="$REMOTE_COMMIT" sh "$INSTALL_FILE" >> "$LOG_FILE" 2>&1; then
  write_state "success" "UI обновлён до $(short_commit "$REMOTE_COMMIT")." "$BACKUP_PATH"
  exit 0
fi

write_state "failed" "Installer завершился с ошибкой. Подробности сохранены в ui-update.log." "$BACKUP_PATH"
exit 1
