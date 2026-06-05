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

[ -x /opt/sbin/xray ] && XRAY_INSTALLED=1
pidof xray >/dev/null 2>&1 && XRAY_RUNNING=1
[ -x /opt/bin/sing-box ] && SINGBOX_INSTALLED=1
[ -x /opt/sbin/sing-box ] && SINGBOX_INSTALLED=1
[ -x /opt/bin/sing-box-go ] && SINGBOX_INSTALLED=1
[ -x /opt/sbin/sing-box-go ] && SINGBOX_INSTALLED=1
pidof sing-box >/dev/null 2>&1 && SINGBOX_RUNNING=1
pidof sing-box-go >/dev/null 2>&1 && SINGBOX_RUNNING=1
[ -x "$SINGBOX_INIT" ] && SINGBOX_SERVICE=1

XRAY_VERSION=""
if [ "$XRAY_INSTALLED" = "1" ]; then
  XRAY_VERSION=$(/opt/sbin/xray version 2>/dev/null | head -n 1)
fi

SINGBOX_VERSION=""
if [ -x /opt/bin/sing-box ]; then
  SINGBOX_VERSION=$(/opt/bin/sing-box version 2>/dev/null | head -n 1)
elif [ -x /opt/sbin/sing-box ]; then
  SINGBOX_VERSION=$(/opt/sbin/sing-box version 2>/dev/null | head -n 1)
elif [ -x /opt/bin/sing-box-go ]; then
  SINGBOX_VERSION=$(/opt/bin/sing-box-go version 2>/dev/null | head -n 1)
elif [ -x /opt/sbin/sing-box-go ]; then
  SINGBOX_VERSION=$(/opt/sbin/sing-box-go version 2>/dev/null | head -n 1)
fi
if [ -z "$SINGBOX_VERSION" ]; then
  SINGBOX_VERSION=$(installed_pkg_version "sing-box-go")
fi

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
printf '"xrayConfigPath":"%s",' "$(json_escape "$CONFIG_PATH")"
printf '"singboxConfigPath":"%s",' "$(json_escape "$SINGBOX_CONFIG_PATH")"
printf '"webServer":"%s"' "$(json_escape "$WEB_SERVER")"
printf '}'
