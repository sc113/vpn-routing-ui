#!/bin/sh

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

CONFIG="/opt/etc/xray/config.json"
if [ -s "$CONFIG" ]; then
  cat "$CONFIG"
else
  printf '{}'
fi
