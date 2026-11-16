#!/bin/sh

PATH=/opt/sbin:/opt/bin:/opt/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

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

installed_pkg_version() {
  opkg list-installed 2>/dev/null | awk -F ' - ' -v pkg="$1" '$1 == pkg { print $3; exit }'
}

installed_pkg_time() {
  opkg status "$1" 2>/dev/null | awk '
    /^Installed-Time:[[:space:]]*/ {
      value = $2
      if (value ~ /^[0-9]+$/) {
        print value
      }
      exit
    }
  '
}

engine_updated_at() {
  package_time=$(json_number "$(installed_pkg_time "$1")")
  binary_time=0
  if [ -n "$2" ]; then
    binary_time=$(json_number "$(date -r "$2" +%s 2>/dev/null)")
  fi
  if [ "$binary_time" -gt "$package_time" ]; then
    printf '%s' "$binary_time"
  else
    printf '%s' "$package_time"
  fi
}

version_state_epoch() {
  awk -F'|' -v key="$1" '$1 == key && $2 ~ /^[0-9]+$/ { print $2; exit }' /opt/etc/vpn-routing-ui/versions.state 2>/dev/null
}

json_number() {
  case "$1" in
    ''|*[!0-9]*) printf '0' ;;
    *) printf '%s' "$1" ;;
  esac
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

XRAY_INSTALLED=0
XRAY_RUNNING=0
SINGBOX_INSTALLED=0
SINGBOX_RUNNING=0
SINGBOX_SERVICE=0
XRAY_INIT="/opt/etc/init.d/S24xray"
SINGBOX_INIT="/opt/etc/init.d/S99sing-box"
XRAY_BIN=""
SINGBOX_BIN=""

if [ -x /opt/sbin/xray ]; then
  XRAY_INSTALLED=1
  XRAY_BIN=/opt/sbin/xray
fi
pidof xray >/dev/null 2>&1 && XRAY_RUNNING=1
for binary in /opt/bin/sing-box /opt/sbin/sing-box /opt/bin/sing-box-go /opt/sbin/sing-box-go; do
  if [ -x "$binary" ]; then
    SINGBOX_INSTALLED=1
    SINGBOX_BIN=$binary
    break
  fi
done
pidof sing-box >/dev/null 2>&1 && SINGBOX_RUNNING=1
pidof sing-box-go >/dev/null 2>&1 && SINGBOX_RUNNING=1
[ -x "$SINGBOX_INIT" ] && SINGBOX_SERVICE=1

XRAY_VERSION=""
if [ -n "$XRAY_BIN" ]; then
  XRAY_VERSION=$("$XRAY_BIN" version 2>/dev/null | head -n 1)
fi

SINGBOX_VERSION=""
if [ -n "$SINGBOX_BIN" ]; then
  SINGBOX_VERSION=$("$SINGBOX_BIN" version 2>/dev/null | head -n 1)
fi
if [ -z "$SINGBOX_VERSION" ]; then
  SINGBOX_VERSION=$(installed_pkg_version "sing-box-go")
fi

UI_UPDATED_AT=$(version_state_epoch "ui")
XRAY_UPDATED_AT=$(engine_updated_at "xray" "$XRAY_BIN")
SINGBOX_UPDATED_AT=$(engine_updated_at "sing-box-go" "$SINGBOX_BIN")

CONFIG_PATH="/opt/etc/xray/config.json"
if [ -f "$XRAY_INIT" ]; then
  ARGS_LINE=$(grep '^ARGS=' "$XRAY_INIT" | head -n 1 | cut -d'"' -f2 | sed 's|\$PROCS|xray|g')
  case " $ARGS_LINE " in
    *" -config "*)
      CONFIG_PATH=$(printf '%s\n' "$ARGS_LINE" | sed 's/.* -config \([^ ]*\).*/\1/')
      ;;
    *" -confdir "*)
      CONFIG_PATH=$(printf '%s\n' "$ARGS_LINE" | sed 's/.* -confdir \([^ ]*\).*/\1/')
      ;;
  esac
fi

SINGBOX_CONFIG_PATH="/opt/etc/sing-box/config.json"
if [ -f "$SINGBOX_INIT" ]; then
  SINGBOX_ARGS=$(grep '^ARGS=' "$SINGBOX_INIT" | head -n 1 | cut -d'"' -f2 | sed 's|\$PROCS|sing-box|g')
  case " $SINGBOX_ARGS " in
    *" -c "*)
      SINGBOX_CONFIG_PATH=$(printf '%s\n' "$SINGBOX_ARGS" | sed 's/.* -c \([^ ]*\).*/\1/')
      ;;
    *" -C "*)
      SINGBOX_CONFIG_DIR=$(printf '%s\n' "$SINGBOX_ARGS" | sed 's/.* -C \([^ ]*\).*/\1/')
      if [ -n "$SINGBOX_CONFIG_DIR" ]; then
        SINGBOX_CONFIG_PATH="$SINGBOX_CONFIG_DIR/config.json"
      fi
      ;;
  esac
fi

WEB_SERVER="unknown"
if pidof uhttpd >/dev/null 2>&1; then
  WEB_SERVER="uhttpd"
elif [ -s /opt/var/run/vpn-routing-ui-lighttpd.pid ] && kill -0 "$(cat /opt/var/run/vpn-routing-ui-lighttpd.pid 2>/dev/null | tr -cd '0-9')" 2>/dev/null; then
  WEB_SERVER="lighttpd"
elif [ -x /opt/sbin/lighttpd ]; then
  WEB_SERVER="lighttpd"
elif [ -x /opt/sbin/uhttpd ]; then
  WEB_SERVER="uhttpd"
fi

printf '{'
printf '"xrayInstalled":%s,' "$(bool_json "$XRAY_INSTALLED")"
printf '"xrayRunning":%s,' "$(bool_json "$XRAY_RUNNING")"
printf '"singboxInstalled":%s,' "$(bool_json "$SINGBOX_INSTALLED")"
printf '"singboxRunning":%s,' "$(bool_json "$SINGBOX_RUNNING")"
printf '"singboxService":%s,' "$(bool_json "$SINGBOX_SERVICE")"
printf '"xrayVersion":"%s",' "$(json_escape "$XRAY_VERSION")"
printf '"singboxVersion":"%s",' "$(json_escape "$SINGBOX_VERSION")"
printf '"uiUpdatedAt":%s,' "$(json_number "$UI_UPDATED_AT")"
printf '"xrayUpdatedAt":%s,' "$(json_number "$XRAY_UPDATED_AT")"
printf '"singboxUpdatedAt":%s,' "$(json_number "$SINGBOX_UPDATED_AT")"
printf '"xrayConfigPath":"%s",' "$(json_escape "$CONFIG_PATH")"
printf '"singboxConfigPath":"%s",' "$(json_escape "$SINGBOX_CONFIG_PATH")"
printf '"webServer":"%s"' "$(json_escape "$WEB_SERVER")"
printf '}'
