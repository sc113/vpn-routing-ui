#!/bin/sh

set -eu

REPO_OWNER="${VPN_ROUTING_UI_REPO_OWNER:-sc113}"
REPO_NAME="${VPN_ROUTING_UI_REPO_NAME:-vpn-routing-ui}"
REPO_REF="${VPN_ROUTING_UI_REF:-main}"
RAW_BASE="https://raw.githubusercontent.com/$REPO_OWNER/$REPO_NAME/$REPO_REF"
SOURCE_COMMIT="${VPN_ROUTING_UI_COMMIT:-}"

TARGET_ROOT="/opt/share/vpn-routing-ui"
TARGET_CGI="$TARGET_ROOT/cgi-bin"
TARGET_BIN="$TARGET_ROOT/bin"
TARGET_STATE="/opt/etc/vpn-routing-ui"
TARGET_RUNTIME="/opt/etc/vpn-routing-ui-runtime"
TARGET_INIT="/opt/etc/init.d"
VERSION_STATE="$TARGET_STATE/versions.state"

WORK_DIR=""

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'Ошибка: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT INT TERM

download_to_file() {
  url="$1"
  dst="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fL "$url" -o "$dst"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -O "$dst" "$url"
    return
  fi

  fail "нужен curl или wget. Установи, например: opkg update && opkg install wget-ssl ca-bundle"
}

is_commit() {
  case "$1" in
    ''|*[!0-9A-Fa-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

resolve_remote_commit() {
  api_url="https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/commits/$REPO_REF"
  response=""

  if command -v curl >/dev/null 2>&1; then
    response=$(curl -fsSL --connect-timeout 6 --max-time 20 "$api_url" 2>/dev/null || true)
  elif command -v wget >/dev/null 2>&1; then
    response=$(wget -qO- "$api_url" 2>/dev/null || true)
  fi

  candidate=$(printf '%s\n' "$response" | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9A-Fa-f]*\)".*/\1/p' | head -n 1)
  if is_commit "$candidate"; then
    printf '%s' "$candidate"
  fi
}

ensure_web_server() {
  if [ -x /opt/sbin/uhttpd ]; then
    return
  fi

  if [ "${VPN_ROUTING_UI_INSTALL_DEPS:-1}" = "0" ]; then
    fail "web-server не найден. Установи uhttpd или lighttpd+CGI в /opt"
  fi

  if command -v opkg >/dev/null 2>&1; then
    log "uhttpd не найден, пробуем поставить через opkg ..."
    opkg update
    opkg install uhttpd || true
  fi

  if [ -x /opt/sbin/uhttpd ]; then
    return
  fi

  if command -v opkg >/dev/null 2>&1; then
    log "uhttpd недоступен в opkg, ставим лёгкий lighttpd fallback ..."
    opkg install lighttpd lighttpd-mod-cgi lighttpd-mod-setenv
  fi

  [ -x /opt/sbin/lighttpd ] || fail "web-server не найден. Установи uhttpd или lighttpd+CGI в /opt"
}

script_dir() {
  case "$0" in
    */*) CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd ;;
    *) pwd ;;
  esac
}

prepare_remote_source() {
  tmp_base="/opt/tmp"
  [ -d "$tmp_base" ] || tmp_base="/tmp"
  if command -v mktemp >/dev/null 2>&1; then
    WORK_DIR=$(umask 077; mktemp -d "$tmp_base/vpn-routing-ui-install.XXXXXX") || fail "не удалось создать временный каталог"
  else
    WORK_DIR="$tmp_base/vpn-routing-ui-install-$$"
    (umask 077; mkdir "$WORK_DIR") || fail "не удалось создать временный каталог"
  fi
  archive="$WORK_DIR/source.tar.gz"
  archive_ref="$REPO_REF"

  if ! is_commit "$SOURCE_COMMIT"; then
    if is_commit "$REPO_REF"; then
      SOURCE_COMMIT="$REPO_REF"
    else
      SOURCE_COMMIT=$(resolve_remote_commit)
    fi
  fi
  if is_commit "$SOURCE_COMMIT"; then
    archive_ref="$SOURCE_COMMIT"
  fi

  log "Скачиваем $REPO_OWNER/$REPO_NAME@$archive_ref ..."
  download_to_file "https://github.com/$REPO_OWNER/$REPO_NAME/archive/$archive_ref.tar.gz" "$archive"

  log "Распаковываем архив ..."
  tar -xzf "$archive" -C "$WORK_DIR"
  SRC_ROOT=""
  for candidate in "$WORK_DIR"/*; do
    if [ -d "$candidate/shell/www" ]; then
      SRC_ROOT="$candidate"
      break
    fi
  done
  [ -n "$SRC_ROOT" ] || fail "в архиве не найдена папка shell/www"
}

detect_source() {
  LOCAL_DIR=$(script_dir)

  if [ -d "$LOCAL_DIR/shell/www" ] && [ -d "$LOCAL_DIR/shell/cgi" ] && [ -d "$LOCAL_DIR/shell/router" ]; then
    SRC_ROOT="$LOCAL_DIR"
    SRC_MODE="repo"
    return
  fi

  if [ -d "$LOCAL_DIR/web" ] && [ -d "$LOCAL_DIR/cgi-bin" ] && [ -d "$LOCAL_DIR/init.d" ]; then
    SRC_ROOT="$LOCAL_DIR"
    SRC_MODE="share"
    return
  fi

  prepare_remote_source
  SRC_MODE="repo"
}

copy_payload() {
  if [ "$SRC_MODE" = "share" ]; then
    WEB_SRC="$SRC_ROOT/web"
    CGI_SRC="$SRC_ROOT/cgi-bin"
    BIN_SRC="$SRC_ROOT/bin"
    INIT_SRC="$SRC_ROOT/init.d"
  else
    WEB_SRC="$SRC_ROOT/shell/www"
    CGI_SRC="$SRC_ROOT/shell/cgi"
    BIN_SRC="$SRC_ROOT/shell/router"
    INIT_SRC="$SRC_ROOT/shell/router"
  fi

  [ -d "$WEB_SRC" ] || fail "не найдена папка web: $WEB_SRC"
  [ -d "$CGI_SRC" ] || fail "не найдена папка cgi: $CGI_SRC"
  [ -d "$BIN_SRC" ] || fail "не найдена папка bin/router: $BIN_SRC"
  [ -d "$INIT_SRC" ] || fail "не найдена папка init/router: $INIT_SRC"

  cp -f "$WEB_SRC"/* "$TARGET_ROOT"/
  cp -f "$CGI_SRC"/* "$TARGET_CGI"/
  rm -f "$TARGET_ROOT/xray.js" "$TARGET_ROOT/xray.html"

  if [ "$SRC_MODE" = "share" ]; then
    cp -f "$BIN_SRC"/* "$TARGET_BIN"/
  else
    cp -f "$BIN_SRC/ui-paths.sh" "$BIN_SRC/ui-update.sh" "$TARGET_BIN"/
  fi

  cp -f "$INIT_SRC/S66vpn-routing-tune" "$TARGET_INIT/S66vpn-routing-tune"
  cp -f "$INIT_SRC/S67vpn-routing-engine-guard" "$TARGET_INIT/S67vpn-routing-engine-guard"
  cp -f "$INIT_SRC/S68vpn-routing-ui" "$TARGET_INIT/S68vpn-routing-ui"
}

mark_ui_updated() {
  now_epoch=$(date +%s 2>/dev/null || echo 0)
  now_iso=$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || date 2>/dev/null || echo "")
  tmp="$VERSION_STATE.$$"
  if [ -f "$VERSION_STATE" ]; then
    awk -F'|' '$1 != "ui" { print $0 }' "$VERSION_STATE" > "$tmp" 2>/dev/null || : > "$tmp"
  else
    : > "$tmp"
  fi
  ui_commit=""
  if is_commit "$SOURCE_COMMIT"; then
    ui_commit="$SOURCE_COMMIT"
  fi
  printf 'ui|%s|%s|%s\n' "$now_epoch" "$now_iso" "$ui_commit" >> "$tmp"
  mv "$tmp" "$VERSION_STATE"
}

if [ "$(id -u 2>/dev/null || echo 1)" != "0" ]; then
  fail "запусти установку от root"
fi

log "[1/7] Проверяем Entware ..."
[ -d /opt ] || fail "Entware не найдено: каталог /opt отсутствует"
detect_source
ensure_web_server

log "[2/7] Останавливаем web-init ..."
"$TARGET_INIT"/S68vpn-routing-ui stop >/dev/null 2>&1 || true

log "[3/7] Создаём каталоги ..."
mkdir -p "$TARGET_ROOT" "$TARGET_CGI" "$TARGET_BIN" "$TARGET_STATE" "$TARGET_RUNTIME" "$TARGET_INIT"
chmod 700 "$TARGET_STATE" "$TARGET_RUNTIME"

log "[4/7] Готовим чистую структуру VPN Routing UI ..."

log "[5/7] Копируем web/CGI/helper/init.d ..."
copy_payload
mark_ui_updated
chmod 755 "$TARGET_CGI"/* "$TARGET_BIN"/* \
  "$TARGET_INIT"/S66vpn-routing-tune \
  "$TARGET_INIT"/S67vpn-routing-engine-guard \
  "$TARGET_INIT"/S68vpn-routing-ui
rm -f "$TARGET_INIT"/S67proxy-runtime-fix

log "[6/7] Запускаем сервисы ..."
"$TARGET_INIT"/S66vpn-routing-tune start >/dev/null 2>&1 || true
"$TARGET_INIT"/S67vpn-routing-engine-guard start >/dev/null 2>&1 || true
"$TARGET_INIT"/S68vpn-routing-ui start >/dev/null 2>&1 || true

log "[7/7] Готово."
log ""
log "VPN Routing UI установлен."
log "Открой: http://ROUTER_IP:92/"
log "Обычно для Keenetic: http://192.168.1.1:92/"
log ""
log "Быстрая переустановка/обновление:"
log "  wget -qO- $RAW_BASE/install.sh | sh"
