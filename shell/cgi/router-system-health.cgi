#!/bin/sh

json_escape() {
  printf '%s' "$1" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\r/\\r/g;s/\n/\\n/g'
}

num_or_zero() {
  value=$(printf '%s' "$1" | tr -cd '0-9.')
  if [ -n "$value" ]; then
    printf '%s' "$value"
  else
    printf '0'
  fi
}

cleanup() {
  rm -f "$TOP_FILE" "$MEM_FILE" 2>/dev/null
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
TOP_FILE="/opt/tmp/router-system-health-top-$$.txt"
MEM_FILE="/opt/tmp/router-system-health-mem-$$.txt"

mkdir -p /opt/tmp

top -bn1 > "$TOP_FILE" 2>/dev/null || true
grep -E 'MemTotal|MemAvailable' /proc/meminfo > "$MEM_FILE" 2>/dev/null || true

load_one=$(awk '{ print $1 }' /proc/loadavg 2>/dev/null)
load_five=$(awk '{ print $2 }' /proc/loadavg 2>/dev/null)
load_fifteen=$(awk '{ print $3 }' /proc/loadavg 2>/dev/null)
load_running=$(awk '{ print $4 }' /proc/loadavg 2>/dev/null)

cpu_line=$(grep '^CPU:' "$TOP_FILE" 2>/dev/null | head -n 1)
cpu_user=$(printf '%s\n' "$cpu_line" | awk '
  {
    for (i = 1; i <= NF; i++) {
      token = $i
      label = $(i + 1)
      gsub(/%/, "", token)
      if (label == "usr") { print token; exit }
    }
  }
')
cpu_system=$(printf '%s\n' "$cpu_line" | awk '
  {
    for (i = 1; i <= NF; i++) {
      token = $i
      label = $(i + 1)
      gsub(/%/, "", token)
      if (label == "sys") { print token; exit }
    }
  }
')
cpu_idle=$(printf '%s\n' "$cpu_line" | awk '
  {
    for (i = 1; i <= NF; i++) {
      token = $i
      label = $(i + 1)
      gsub(/%/, "", token)
      if (label == "idle") { print token; exit }
    }
  }
')
cpu_softirq=$(printf '%s\n' "$cpu_line" | awk '
  {
    for (i = 1; i <= NF; i++) {
      token = $i
      label = $(i + 1)
      gsub(/%/, "", token)
      if (label == "sirq") { print token; exit }
    }
  }
')

mem_total_kb=$(awk '/MemTotal:/ { print $2; exit }' "$MEM_FILE" 2>/dev/null)
mem_available_kb=$(awk '/MemAvailable:/ { print $2; exit }' "$MEM_FILE" 2>/dev/null)
mem_used_kb=$(awk -v total="${mem_total_kb:-0}" -v available="${mem_available_kb:-0}" 'BEGIN { print total - available }')
mem_used_percent=$(awk -v total="${mem_total_kb:-0}" -v used="${mem_used_kb:-0}" 'BEGIN { if (total > 0) printf "%.1f", (used * 100) / total; else printf "0" }')

ndm_cpu=$(awk '$0 ~ /(^|[[:space:]])ndm$/ { print $8; exit }' "$TOP_FILE" 2>/dev/null)
singbox_cpu=$(awk '$0 ~ /sing-box/ { print $8; exit }' "$TOP_FILE" 2>/dev/null)
xray_cpu=$(awk '$0 ~ /(^|[[:space:]])xray([[:space:]]|$)/ { print $8; exit }' "$TOP_FILE" 2>/dev/null)
proxy_cpu=$(awk '$0 ~ /hev-socks5-tunnel/ { sum += $8 } END { printf "%.1f", sum + 0 }' "$TOP_FILE" 2>/dev/null)

printf '{'
printf '"ok":true,'
printf '"sampledAt":"%s",' "$(json_escape "$(date '+%Y-%m-%d %H:%M:%S %z' 2>/dev/null)")"
printf '"load":{"one":%s,"five":%s,"fifteen":%s,"running":"%s"},' \
  "$(num_or_zero "$load_one")" \
  "$(num_or_zero "$load_five")" \
  "$(num_or_zero "$load_fifteen")" \
  "$(json_escape "$load_running")"
printf '"cpu":{"user":%s,"system":%s,"idle":%s,"softirq":%s},' \
  "$(num_or_zero "$cpu_user")" \
  "$(num_or_zero "$cpu_system")" \
  "$(num_or_zero "$cpu_idle")" \
  "$(num_or_zero "$cpu_softirq")"
printf '"memory":{"totalKb":%s,"availableKb":%s,"usedKb":%s,"usedPercent":%s},' \
  "$(num_or_zero "$mem_total_kb")" \
  "$(num_or_zero "$mem_available_kb")" \
  "$(num_or_zero "$mem_used_kb")" \
  "$(num_or_zero "$mem_used_percent")"
printf '"processes":{"ndmCpu":%s,"singboxCpu":%s,"xrayCpu":%s,"proxyCpu":%s}' \
  "$(num_or_zero "$ndm_cpu")" \
  "$(num_or_zero "$singbox_cpu")" \
  "$(num_or_zero "$xray_cpu")" \
  "$(num_or_zero "$proxy_cpu")"
printf '}'

cleanup
