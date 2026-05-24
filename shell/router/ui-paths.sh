#!/bin/sh

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VPN_ROUTING_UI_APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
APP_BASENAME=$(basename "$VPN_ROUTING_UI_APP_DIR")

if [ -d "/opt/etc/vpn-routing-ui" ]; then
  VPN_ROUTING_UI_STATE_DIR="/opt/etc/vpn-routing-ui"
elif [ -d "/opt/etc/$APP_BASENAME" ]; then
  VPN_ROUTING_UI_STATE_DIR="/opt/etc/$APP_BASENAME"
else
  VPN_ROUTING_UI_STATE_DIR="/opt/etc/vpn-routing-ui"
fi

if [ -d "/opt/etc/vpn-routing-ui-runtime" ]; then
  VPN_ROUTING_UI_RUNTIME_DIR="/opt/etc/vpn-routing-ui-runtime"
elif [ -d "/opt/etc/router-ui" ]; then
  VPN_ROUTING_UI_RUNTIME_DIR="/opt/etc/router-ui"
else
  VPN_ROUTING_UI_RUNTIME_DIR="/opt/etc/vpn-routing-ui-runtime"
fi

VPN_ROUTING_UI_BACKUP_DIR="$VPN_ROUTING_UI_STATE_DIR/backups"
VPN_ROUTING_UI_SERVICE_NAME="vpn-routing-ui"

export VPN_ROUTING_UI_APP_DIR
export VPN_ROUTING_UI_STATE_DIR
export VPN_ROUTING_UI_RUNTIME_DIR
export VPN_ROUTING_UI_BACKUP_DIR
export VPN_ROUTING_UI_SERVICE_NAME
