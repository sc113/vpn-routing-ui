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

clean_output() {
  printf '%s' "$1" | tr -d '\033' | sed 's/\[[0-9;]*m//g'
}

http_get() {
  url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -H 'User-Agent: vpn-routing-ui' "$url"
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO- --header='User-Agent: vpn-routing-ui' "$url"
    return $?
  fi
  if command -v uclient-fetch >/dev/null 2>&1; then
    uclient-fetch -q -O - "$url"
    return $?
  fi
  return 1
}

upgradable_version() {
  opkg list-upgradable 2>/dev/null | awk -F ' - ' -v pkg="$1" '$1 == pkg { print $3; exit }'
}

installed_pkg_version() {
  opkg list-installed 2>/dev/null | awk -F ' - ' -v pkg="$1" '$1 == pkg { print $3; exit }'
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

fetch_latest_tag() {
  api_url="$1"
  payload=$(http_get "$api_url" 2>/dev/null | tr -d '\r\n')
  printf '%s' "$payload" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

runtime_version() {
  case "$1" in
    xray)
      if [ -x /opt/sbin/xray ]; then
        /opt/sbin/xray version 2>/dev/null | head -n 1
      fi
      ;;
    singbox)
      if [ -x /opt/bin/sing-box ]; then
        version=$(/opt/bin/sing-box version 2>/dev/null | head -n 1)
      elif [ -x /opt/sbin/sing-box ]; then
        version=$(/opt/sbin/sing-box version 2>/dev/null | head -n 1)
      elif [ -x /opt/bin/sing-box-go ]; then
        version=$(/opt/bin/sing-box-go version 2>/dev/null | head -n 1)
      elif [ -x /opt/sbin/sing-box-go ]; then
        version=$(/opt/sbin/sing-box-go version 2>/dev/null | head -n 1)
      fi
      if [ -n "$version" ]; then
        printf '%s' "$version"
      else
        installed_pkg_version "sing-box-go"
      fi
      ;;
  esac
}

print_engine_json() {
  key="$1"
  pkg="$2"
  releases_url="$3"
  latest_api="$4"

  installed=$(runtime_version "$key")
  upgradable=$(upgradable_version "$pkg")
  prerelease=0
  compat_blocked=0
  compat_reason=""
  if is_prerelease_version "$upgradable"; then
    prerelease=1
  fi
  if [ "$key" = "singbox" ] && [ -n "$upgradable" ] && is_mips_arch && version_ge_1_13 "$upgradable"; then
    compat_blocked=1
    compat_reason="На MIPS обновления sing-box 1.13+ отключены: эта ветка уже падала на роутере."
  fi
  upstream=$(fetch_latest_tag "$latest_api")

  printf '"%s":{' "$(json_escape "$key")"
  printf '"installedVersion":"%s",' "$(json_escape "$installed")"
  printf '"opkgVersion":"%s",' "$(json_escape "$upgradable")"
  printf '"opkgHasUpdate":%s,' "$(bool_json "$([ -n "$upgradable" ] && echo 1 || echo 0)")"
  printf '"opkgPrerelease":%s,' "$(bool_json "$prerelease")"
  printf '"safeOpkgUpdate":%s,' "$(bool_json "$([ -n "$upgradable" ] && [ "$prerelease" -eq 0 ] && [ "$compat_blocked" -eq 0 ] && echo 1 || echo 0)")"
  printf '"compatBlocked":%s,' "$(bool_json "$compat_blocked")"
  printf '"compatReason":"%s",' "$(json_escape "$compat_reason")"
  printf '"upstreamVersion":"%s",' "$(json_escape "$upstream")"
  printf '"releasesUrl":"%s"' "$(json_escape "$releases_url")"
  printf '}'
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

REFRESH=$(query_param refresh)
REFRESH_OK=1
REFRESH_OUTPUT=""

if [ "$REFRESH" = "1" ]; then
  REFRESH_OUTPUT=$(opkg update 2>&1)
  REFRESH_CODE=$?
  if [ "$REFRESH_CODE" -ne 0 ]; then
    REFRESH_OK=0
  fi
fi

printf '{'
printf '"ok":true,'
printf '"refreshed":%s,' "$(bool_json "$([ "$REFRESH" = "1" ] && echo 1 || echo 0)")"
printf '"refreshOk":%s,' "$(bool_json "$REFRESH_OK")"
printf '"refreshDetails":"%s",' "$(json_escape "$(clean_output "$REFRESH_OUTPUT")")"
print_engine_json "xray" "xray" "https://github.com/XTLS/Xray-core/releases" "https://api.github.com/repos/XTLS/Xray-core/releases/latest"
printf ','
print_engine_json "singbox" "sing-box-go" "https://github.com/SagerNet/sing-box/releases" "https://api.github.com/repos/SagerNet/sing-box/releases/latest"
printf '}'
