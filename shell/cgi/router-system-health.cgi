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
  rm -f "$TOP_FILE" "$TOP_LAST_FILE" "$MEM_FILE" "$CACHE_TMP_FILE" 2>/dev/null
}

echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""

PATH=/opt/sbin:/opt/bin:/opt/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
TOP_FILE="/opt/tmp/router-system-health-top-$$.txt"
TOP_LAST_FILE="/opt/tmp/router-system-health-top-last-$$.txt"
MEM_FILE="/opt/tmp/router-system-health-mem-$$.txt"
CACHE_FILE="/opt/tmp/router-system-health-cache.json"
CACHE_TMP_FILE="/opt/tmp/router-system-health-cache-$$.json"
CACHE_TTL="${ROUTER_SYSTEM_HEALTH_CACHE_TTL:-20}"

mkdir -p /opt/tmp

now_ts=$(date +%s 2>/dev/null || printf '0')
cache_ts=$(date -r "$CACHE_FILE" +%s 2>/dev/null || printf '0')
cache_age=$((now_ts - cache_ts))
if [ -s "$CACHE_FILE" ] && [ "$cache_age" -ge 0 ] 2>/dev/null && [ "$cache_age" -lt "$CACHE_TTL" ] 2>/dev/null; then
  cat "$CACHE_FILE"
  exit 0
fi

read_cpu_stat() {
  awk '
  $1 == "cpu" {
    for (i = 2; i <= 11; i++) {
      printf "%s%s", ($i + 0), (i == 11 ? "\n" : " ")
    }
    exit
  }
  ' /proc/stat 2>/dev/null
}

CPU_STAT_BEFORE=$(read_cpu_stat)
if ! top -bn2 -d 1 > "$TOP_FILE" 2>/dev/null; then
  sleep 1
  top -bn1 > "$TOP_FILE" 2>/dev/null || true
fi
CPU_STAT_AFTER=$(read_cpu_stat)

awk '
/^Mem:/ {
  block = ""
}
{
  block = block $0 "\n"
}
END {
  printf "%s", block
}
' "$TOP_FILE" > "$TOP_LAST_FILE"

grep -E 'MemTotal|MemAvailable' /proc/meminfo > "$MEM_FILE" 2>/dev/null || true

load_one=$(awk '{ print $1 }' /proc/loadavg 2>/dev/null)
load_five=$(awk '{ print $2 }' /proc/loadavg 2>/dev/null)
load_fifteen=$(awk '{ print $3 }' /proc/loadavg 2>/dev/null)
load_running=$(awk '{ print $4 }' /proc/loadavg 2>/dev/null)
cpu_cores=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)
[ "${cpu_cores:-0}" -gt 0 ] 2>/dev/null || cpu_cores=1
load_one_percent=$(awk -v load="${load_one:-0}" -v cores="${cpu_cores:-1}" 'BEGIN { if (cores > 0) printf "%.1f", (load * 100) / cores; else printf "0" }')
load_five_percent=$(awk -v load="${load_five:-0}" -v cores="${cpu_cores:-1}" 'BEGIN { if (cores > 0) printf "%.1f", (load * 100) / cores; else printf "0" }')
load_fifteen_percent=$(awk -v load="${load_fifteen:-0}" -v cores="${cpu_cores:-1}" 'BEGIN { if (cores > 0) printf "%.1f", (load * 100) / cores; else printf "0" }')

cpu_metrics=$(awk -v before="$CPU_STAT_BEFORE" -v after="$CPU_STAT_AFTER" '
BEGIN {
  split(before, a, " ")
  split(after, b, " ")
  total = 0
  for (i = 1; i <= 10; i++) {
    delta[i] = b[i] - a[i]
    if (delta[i] < 0) {
      delta[i] = 0
    }
    total += delta[i]
  }
  if (total <= 0) {
    printf "0 0 100 0"
    exit
  }
  user = delta[1] + delta[2]
  system = delta[3]
  idle = delta[4] + delta[5]
  softirq = delta[6] + delta[7]
  printf "%.1f %.1f %.1f %.1f", (user * 100) / total, (system * 100) / total, (idle * 100) / total, (softirq * 100) / total
}
')
set -- $cpu_metrics
cpu_user="${1:-0}"
cpu_system="${2:-0}"
cpu_idle="${3:-100}"
cpu_softirq="${4:-0}"

mem_total_kb=$(awk '/MemTotal:/ { print $2; exit }' "$MEM_FILE" 2>/dev/null)
mem_available_kb=$(awk '/MemAvailable:/ { print $2; exit }' "$MEM_FILE" 2>/dev/null)
mem_used_kb=$(awk -v total="${mem_total_kb:-0}" -v available="${mem_available_kb:-0}" 'BEGIN { print total - available }')
mem_used_percent=$(awk -v total="${mem_total_kb:-0}" -v used="${mem_used_kb:-0}" 'BEGIN { if (total > 0) printf "%.1f", (used * 100) / total; else printf "0" }')

ndm_cpu=$(awk '
$1 == "PID" {
  cpu_col = 0
  for (i = 1; i <= NF; i++) {
    if ($i == "%CPU") {
      cpu_col = i
    }
  }
  next
}
cpu_col > 0 && $0 ~ /(^|[[:space:]])ndm$/ { print $cpu_col + 0; exit }
' "$TOP_LAST_FILE" 2>/dev/null)
singbox_cpu=$(awk '
$1 == "PID" {
  cpu_col = 0
  for (i = 1; i <= NF; i++) {
    if ($i == "%CPU") {
      cpu_col = i
    }
  }
  next
}
cpu_col > 0 && $0 ~ /sing-box/ { sum += $cpu_col }
END { printf "%.1f", sum + 0 }
' "$TOP_LAST_FILE" 2>/dev/null)
xray_cpu=$(awk '
$1 == "PID" {
  cpu_col = 0
  for (i = 1; i <= NF; i++) {
    if ($i == "%CPU") {
      cpu_col = i
    }
  }
  next
}
cpu_col > 0 && $0 ~ /(^|[[:space:]])xray([[:space:]]|$)/ { sum += $cpu_col }
END { printf "%.1f", sum + 0 }
' "$TOP_LAST_FILE" 2>/dev/null)
proxy_cpu=$(awk '
$1 == "PID" {
  cpu_col = 0
  for (i = 1; i <= NF; i++) {
    if ($i == "%CPU") {
      cpu_col = i
    }
  }
  next
}
cpu_col > 0 && $0 ~ /hev-socks5-tunnel/ { sum += $cpu_col }
END { printf "%.1f", sum + 0 }
' "$TOP_LAST_FILE" 2>/dev/null)

{
  printf '{'
  printf '"ok":true,'
  printf '"sampledAt":"%s",' "$(json_escape "$(date '+%Y-%m-%d %H:%M:%S %z' 2>/dev/null)")"
  printf '"load":{"one":%s,"five":%s,"fifteen":%s,"onePercent":%s,"fivePercent":%s,"fifteenPercent":%s,"cores":%s,"running":"%s"},' \
    "$(num_or_zero "$load_one")" \
    "$(num_or_zero "$load_five")" \
    "$(num_or_zero "$load_fifteen")" \
    "$(num_or_zero "$load_one_percent")" \
    "$(num_or_zero "$load_five_percent")" \
    "$(num_or_zero "$load_fifteen_percent")" \
    "$(num_or_zero "$cpu_cores")" \
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
} > "$CACHE_TMP_FILE"

cat "$CACHE_TMP_FILE"
mv "$CACHE_TMP_FILE" "$CACHE_FILE" 2>/dev/null || true

cleanup
