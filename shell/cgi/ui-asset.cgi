#!/bin/sh

printf 'Cache-Control: no-store, no-cache, must-revalidate, max-age=0\n'
printf 'Pragma: no-cache\n'
printf 'Expires: 0\n'
printf 'X-Content-Type-Options: nosniff\n'

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WEB_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ASSET=${PATH_INFO#/}

case "$ASSET" in
  app.css|dns-sync-page.css)
    CONTENT_TYPE='text/css; charset=utf-8'
    ;;
  root.js|profiles.js|dns-sync.js|system-health-widget.js)
    CONTENT_TYPE='application/javascript; charset=utf-8'
    ;;
  *)
    printf 'Status: 404 Not Found\n'
    printf 'Content-Type: text/plain; charset=utf-8\n\n'
    printf 'Asset not found\n'
    exit 0
    ;;
esac

ASSET_PATH="$WEB_ROOT/$ASSET"
if [ ! -f "$ASSET_PATH" ]; then
  printf 'Status: 404 Not Found\n'
  printf 'Content-Type: text/plain; charset=utf-8\n\n'
  printf 'Asset not found\n'
  exit 0
fi

printf 'Content-Type: %s\n\n' "$CONTENT_TYPE"
cat "$ASSET_PATH"
