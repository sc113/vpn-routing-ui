#!/bin/sh

PATH=/opt/sbin:/opt/bin:/opt/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

query_param() {
  printf '%s' "$QUERY_STRING" | tr '&' '\n' | sed -n "s/^$1=//p" | head -n 1
}

clean_output() {
  printf '%s' "$1" | tr -d '\033' | sed 's/\[[0-9;]*m//g'
}

upgradable_version() {
  opkg list-upgradable 2>/dev/null | awk -F ' - ' -v pkg="$1" '$1 == pkg { print $3; exit }'
}

repo_version() {
  opkg info "$1" 2>/dev/null | awk '/^Version: / { print $2; exit }'
}

is_prerelease_version() {
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    *alpha*|*beta*|*rc*|*pre*)
      return 0
      ;;
  esac
  return 1
}

is_mips_arch() {
  opkg print-architecture 2>/dev/null | grep -qi 'mips'
}

version_ge_1_13() {
  pair=$(printf '%s' "$1" | sed 's/^[^0-9]*//' | awk -F'[.-]' '{ printf "%d %d", $1, $2 }')
  set -- $pair
  major="${1:-0}"
  minor="${2:-0}"
  if [ "$major" -gt 1 ]; then
    return 0
  fi
  if [ "$major" -eq 1 ] && [ "$minor" -ge 13 ]; then
    return 0
  fi
  return 1
}

backup_file() {
  src="$1"
  stamp="$2"
  if [ -f "$src" ]; then
    cp "$src" "$src.bak-$stamp" >/dev/null 2>&1 || true
  fi
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

ACTION=$(query_param action)
ENGINE=$(query_param engine)

case "$ACTION" in
  install|remove|update)
    ;;
  *)
    printf '{"ok":false,"error":"Неизвестная команда для пакета"}'
    exit 0
    ;;
esac

case "$ENGINE" in
  xray)
    PKG_NAME="xray"
    ENGINE_TITLE="Xray"
    CONFIG_PATH="/opt/etc/xray/config.json"
    INIT_PATH="/opt/etc/init.d/S24xray"
    INSTALL_CMD="opkg update && opkg install xray && if [ -f /opt/etc/init.d/S24xray ]; then sed -i 's|ARGS=\"run -confdir /opt/etc/xray\"|ARGS=\"run -config /opt/etc/xray/config.json\"|' /opt/etc/init.d/S24xray; fi"
    REMOVE_CMD="[ -x /opt/etc/init.d/S24xray ] && /opt/etc/init.d/S24xray stop >/dev/null 2>&1 || true; opkg remove xray >/dev/null 2>&1 || true; opkg remove xray-core >/dev/null 2>&1 || true"
    UPDATE_CMD="opkg install xray && if [ -f /opt/etc/init.d/S24xray ]; then sed -i 's|ARGS=\"run -confdir /opt/etc/xray\"|ARGS=\"run -config /opt/etc/xray/config.json\"|' /opt/etc/init.d/S24xray; fi"
    VALIDATE_CMD="/opt/sbin/xray run -test -config \"$CONFIG_PATH\""
    RESTART_CMD="[ -x \"$INIT_PATH\" ] && \"$INIT_PATH\" restart"
    INSTALLED_CHECK="[ -x /opt/sbin/xray ]"
    ;;
  singbox)
    PKG_NAME="sing-box-go"
    ENGINE_TITLE="sing-box"
    CONFIG_PATH="/opt/etc/sing-box/config.json"
    INIT_PATH="/opt/etc/init.d/S99sing-box"
    INSTALL_CMD="opkg update && opkg install sing-box-go"
    REMOVE_CMD="[ -x /opt/etc/init.d/S99sing-box ] && /opt/etc/init.d/S99sing-box stop >/dev/null 2>&1 || true; opkg remove sing-box-go >/dev/null 2>&1 || true"
    UPDATE_CMD="opkg install sing-box-go"
    if [ -x /opt/bin/sing-box ]; then
      VALIDATE_CMD="/opt/bin/sing-box check -c \"$CONFIG_PATH\""
    elif [ -x /opt/sbin/sing-box ]; then
      VALIDATE_CMD="/opt/sbin/sing-box check -c \"$CONFIG_PATH\""
    elif [ -x /opt/bin/sing-box-go ]; then
      VALIDATE_CMD="/opt/bin/sing-box-go check -c \"$CONFIG_PATH\""
    else
      VALIDATE_CMD="/opt/sbin/sing-box-go check -c \"$CONFIG_PATH\""
    fi
    RESTART_CMD="[ -x \"$INIT_PATH\" ] && \"$INIT_PATH\" restart"
    INSTALLED_CHECK="[ -x /opt/bin/sing-box ] || [ -x /opt/sbin/sing-box ] || [ -x /opt/bin/sing-box-go ] || [ -x /opt/sbin/sing-box-go ]"
    ;;
  *)
    printf '{"ok":false,"error":"Неизвестный движок"}'
    exit 0
    ;;
esac

OUTPUT=""
CODE=0

if [ "$ACTION" = "update" ]; then
  if ! sh -c "$INSTALLED_CHECK" >/dev/null 2>&1; then
    printf '{"ok":false,"error":"Сначала установи %s, потом уже обновляй его."}' "$(json_escape "$ENGINE_TITLE")"
    exit 0
  fi

  REFRESH_OUTPUT=$(opkg update 2>&1)
  REFRESH_CODE=$?
  TARGET_VERSION=$(upgradable_version "$PKG_NAME")
  if [ -z "$TARGET_VERSION" ]; then
    printf '{'
    printf '"ok":true,'
    printf '"action":"update",'
    printf '"engine":"%s",' "$(json_escape "$ENGINE")"
    printf '"message":"Для %s через opkg сейчас нет безопасного обновления.",' "$(json_escape "$ENGINE_TITLE")"
    printf '"details":"%s"' "$(json_escape "$(clean_output "$REFRESH_OUTPUT")")"
    printf '}'
    exit 0
  fi

  if is_prerelease_version "$TARGET_VERSION"; then
    printf '{'
    printf '"ok":false,'
    printf '"error":"Entware предлагает для %s prerelease %s. Безопасное обновление через opkg отключено.",' "$(json_escape "$ENGINE_TITLE")" "$(json_escape "$TARGET_VERSION")"
    printf '"details":""'
    printf '}'
    exit 0
  fi

  if [ "$ENGINE" = "singbox" ] && is_mips_arch && version_ge_1_13 "$TARGET_VERSION"; then
    printf '{'
    printf '"ok":false,'
    printf '"error":"Для sing-box на MIPS обновления 1.13+ через opkg отключены: эта ветка уже падала на роутере.",'
    printf '"details":"%s"' "$(json_escape "$TARGET_VERSION")"
    printf '}'
    exit 0
  fi

  STAMP=$(date +%Y%m%d-%H%M%S)
  backup_file "$CONFIG_PATH" "$STAMP"
  backup_file "$INIT_PATH" "$STAMP"

  OUTPUT=$(sh -c "$UPDATE_CMD" 2>&1)
  CODE=$?
  OUTPUT=$(printf '%s\n%s' "$REFRESH_OUTPUT" "$OUTPUT")

  if [ "$CODE" -eq 0 ] && [ -f "$CONFIG_PATH" ]; then
    VALIDATE_OUTPUT=$(sh -c "$VALIDATE_CMD" 2>&1)
    CODE=$?
    if [ "$CODE" -ne 0 ]; then
      printf '{'
      printf '"ok":false,'
      printf '"error":"Пакет обновился, но новый бинарь не принял текущий конфиг %s.",' "$(json_escape "$CONFIG_PATH")"
      printf '"details":"%s"' "$(json_escape "$(clean_output "$VALIDATE_OUTPUT")")"
      printf '}'
      exit 0
    fi
    RESTART_OUTPUT=$(sh -c "$RESTART_CMD" 2>&1)
    CODE=$?
    OUTPUT=$(printf '%s\n%s' "$OUTPUT" "$RESTART_OUTPUT")
  fi
elif [ "$ACTION" = "install" ]; then
  if [ "$ENGINE" = "singbox" ]; then
    REFRESH_OUTPUT=$(opkg update 2>&1)
    TARGET_VERSION=$(repo_version "$PKG_NAME")
    if [ -n "$TARGET_VERSION" ] && is_mips_arch && version_ge_1_13 "$TARGET_VERSION"; then
      printf '{'
      printf '"ok":false,'
      printf '"error":"Для sing-box на MIPS установка ветки 1.13+ через opkg отключена: она уже падала на роутере.",'
      printf '"details":"%s"' "$(json_escape "$(clean_output "$REFRESH_OUTPUT")")"
      printf '}'
      exit 0
    fi
  fi
  OUTPUT=$(sh -c "$INSTALL_CMD" 2>&1)
  CODE=$?
else
  OUTPUT=$(sh -c "$REMOVE_CMD" 2>&1)
  CODE=$?
fi

if [ "$CODE" -ne 0 ]; then
  printf '{'
  printf '"ok":false,'
  printf '"error":"Не удалось выполнить %s для %s",' "$(json_escape "$ACTION")" "$(json_escape "$ENGINE_TITLE")"
  printf '"details":"%s"' "$(json_escape "$(clean_output "$OUTPUT")")"
  printf '}'
  exit 0
fi

MESSAGE=""
if [ "$ACTION" = "install" ]; then
  MESSAGE="$ENGINE_TITLE установлен."
elif [ "$ACTION" = "update" ]; then
  MESSAGE="$ENGINE_TITLE обновлён через opkg."
else
  MESSAGE="$ENGINE_TITLE удалён."
fi

printf '{'
printf '"ok":true,'
printf '"action":"%s",' "$(json_escape "$ACTION")"
printf '"engine":"%s",' "$(json_escape "$ENGINE")"
printf '"message":"%s",' "$(json_escape "$MESSAGE")"
printf '"details":"%s"' "$(json_escape "$(clean_output "$OUTPUT")")"
printf '}'
