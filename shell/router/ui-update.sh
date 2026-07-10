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
INSTALL_URL="https://raw.githubusercontent.com/$REPO_OWNER/$REPO_NAME/$REPO_REF/install.sh"

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

download_to_file() {
  url="$1"
  destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 90 "$url" -o "$destination"
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$destination" "$url"
    return $?
  fi
  return 1
}

mkdir -p "$STATE_DIR" "$BACKUP_DIR" /opt/tmp

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi

WORK_DIR="/opt/tmp/vpn-routing-ui-update-$$"
INSTALL_FILE="$WORK_DIR/install.sh"
STAMP=$(date +%Y%m%d-%H%M%S 2>/dev/null || now_epoch)
BACKUP_PATH="$BACKUP_DIR/ui-$STAMP"

trap cleanup EXIT INT TERM

write_state "running" "Скачиваем обновление из GitHub." ""
printf '\n[%s] UI update started\n' "$(date 2>/dev/null || now_epoch)" >> "$LOG_FILE"

if cp -R "$APP_DIR" "$BACKUP_PATH" >> "$LOG_FILE" 2>&1; then
  :
else
  BACKUP_PATH=""
fi

mkdir -p "$WORK_DIR"
if ! download_to_file "$INSTALL_URL" "$INSTALL_FILE" >> "$LOG_FILE" 2>&1; then
  write_state "failed" "Не удалось скачать installer из GitHub." "$BACKUP_PATH"
  exit 1
fi

if ! grep -q 'VPN_ROUTING_UI_REPO_OWNER' "$INSTALL_FILE"; then
  write_state "failed" "GitHub вернул некорректный installer." "$BACKUP_PATH"
  exit 1
fi

write_state "running" "Применяем обновление и перезапускаем UI." "$BACKUP_PATH"
if sh "$INSTALL_FILE" >> "$LOG_FILE" 2>&1; then
  write_state "success" "UI обновлён из GitHub." "$BACKUP_PATH"
  exit 0
fi

write_state "failed" "Installer завершился с ошибкой. Подробности сохранены в ui-update.log." "$BACKUP_PATH"
exit 1
